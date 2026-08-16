import {
  interactionRequestPayload,
  runInteractionRequestPayloadSchema,
  runInteractionRequestSchema,
  validateRunInteractionResponse,
  type RunInteractionRequest,
  type RunInteractionRequestPayload,
  type RunInteractionResponse,
} from "@hraness/agent-tasks-protocol";

import type {
  CodexExpiredServerRequestFault,
  CodexFact,
  CodexServerRequest,
  CodexServerResponse,
  CodexStreamPosition,
} from "../codex";
import {
  codexServerRequestResolutionKey,
  createCodexFactsAtPosition,
} from "../codex";

export interface SessionInteractionExpired {
  readonly interactionId: string;
  readonly reason: "local_deadline" | "provider_expired";
}

export type SessionInteractionResolution =
  | Readonly<{ readonly kind: "applied" }>
  | Readonly<{
      readonly kind: "expired";
      readonly reason: "local_deadline" | "provider_expired";
    }>
  | Readonly<{ readonly kind: "rejected" }>;

export interface SessionInteractionDeadline {
  cancel(): void;
}

export interface SessionInteractionDeadlineScheduler {
  after(milliseconds: number, callback: () => void): SessionInteractionDeadline;
}

export interface SessionInteractionCoordinatorOptions {
  readonly consumeFacts: (facts: readonly CodexFact[]) => void;
  readonly deadlines?: SessionInteractionDeadlineScheduler;
  readonly now: () => number;
  readonly onExpired: (
    event: SessionInteractionExpired,
  ) => void | Promise<void>;
  readonly respond: (
    accountProfileId: string,
    request: CodexServerRequest,
    response: CodexServerResponse,
  ) => Promise<CodexStreamPosition | void>;
}

export interface SessionInteractionRegistration {
  readonly accountProfileId: string;
  readonly providerRequest: CodexServerRequest;
  readonly providerResponse: (response: RunInteractionResponse) => unknown;
  readonly projectedRequest: RunInteractionRequestPayload;
  readonly publicRequest: RunInteractionRequest;
  readonly threadId: string;
  readonly turnId: string;
}

interface PendingSessionInteraction {
  readonly accountProfileId: string;
  readonly expiresAt: number;
  readonly generation: number;
  readonly interactionId: string;
  readonly providerKey: string;
  readonly providerRequest: CodexServerRequest;
  readonly providerResponse: (response: RunInteractionResponse) => unknown;
  readonly publicRequest: RunInteractionRequest;
  readonly resolutionKey: string;
  deadline: SessionInteractionDeadline | null;
}

interface ProviderResolvedInteraction {
  readonly accountProfileId: string;
  readonly generation: number;
  readonly interactionId: string;
}

const MAX_RETAINED_PROVIDER_RESOLUTIONS = 1_024;
const MAX_RETAINED_INTERACTION_IDENTITIES = 8_192;

const defaultDeadlines: SessionInteractionDeadlineScheduler = {
  after(milliseconds, callback) {
    const timer = setTimeout(callback, milliseconds);
    return { cancel: () => clearTimeout(timer) };
  },
};

/** Owns every volatile resource associated with provider interaction requests. */
export class SessionInteractionCoordinator {
  readonly #consumeFacts: SessionInteractionCoordinatorOptions["consumeFacts"];
  readonly #deadlines: SessionInteractionDeadlineScheduler;
  readonly #now: SessionInteractionCoordinatorOptions["now"];
  readonly #onExpired: SessionInteractionCoordinatorOptions["onExpired"];
  readonly #pendingById = new Map<string, PendingSessionInteraction>();
  readonly #pendingIdByProviderKey = new Map<string, string>();
  readonly #pendingIdByResolutionKey = new Map<string, string>();
  readonly #providerResolvedByKey = new Map<string, ProviderResolvedInteraction>();
  readonly #respond: SessionInteractionCoordinatorOptions["respond"];
  readonly #resolving = new Set<string>();
  readonly #seenInteractionIds = new Set<string>();

  constructor(options: SessionInteractionCoordinatorOptions) {
    this.#consumeFacts = options.consumeFacts;
    this.#deadlines = options.deadlines ?? defaultDeadlines;
    this.#now = options.now;
    this.#onExpired = options.onExpired;
    this.#respond = options.respond;
  }

  interactionId(accountProfileId: string, request: CodexServerRequest): string {
    return stableInteractionId(accountProfileId, request);
  }

  register(input: SessionInteractionRegistration): void {
    const interactionId = stableInteractionId(
      input.accountProfileId,
      input.providerRequest,
    );
    const providerKey = providerRequestKey(
      input.accountProfileId,
      input.providerRequest.generation,
      input.providerRequest.id,
    );
    const resolutionKey = codexServerRequestResolutionKey(
      input.accountProfileId,
      input.providerRequest.generation,
      input.providerRequest.id,
    );
    const parsedPublicRequest = runInteractionRequestSchema.safeParse(
      input.publicRequest,
    );
    const parsedProjectedRequest = runInteractionRequestPayloadSchema.safeParse(
      input.projectedRequest,
    );
    if (
      !parsedPublicRequest.success ||
      !parsedProjectedRequest.success ||
      parsedPublicRequest.data.id !== interactionId ||
      JSON.stringify(interactionRequestPayload(parsedPublicRequest.data)) !==
        JSON.stringify(parsedProjectedRequest.data) ||
      this.#seenInteractionIds.has(interactionId) ||
      this.#pendingById.has(interactionId) ||
      this.#pendingIdByProviderKey.has(providerKey) ||
      this.#pendingIdByResolutionKey.has(resolutionKey)
    ) {
      throw new Error("The provider interaction identity is not available");
    }
    const pending: PendingSessionInteraction = {
      accountProfileId: input.accountProfileId,
      expiresAt: parsedPublicRequest.data.expiresAt,
      generation: input.providerRequest.generation,
      interactionId,
      providerKey,
      providerRequest: input.providerRequest,
      providerResponse: input.providerResponse,
      publicRequest: parsedPublicRequest.data,
      resolutionKey,
      deadline: null,
    };
    this.#rememberInteractionIdentity(interactionId);
    this.#pendingById.set(interactionId, pending);
    this.#pendingIdByProviderKey.set(providerKey, interactionId);
    this.#pendingIdByResolutionKey.set(resolutionKey, interactionId);
    let registrationCommitted = false;
    let deadlineFiredDuringRegistration = false;
    try {
      pending.deadline = this.#deadlines.after(
        Math.max(0, pending.expiresAt - this.#now()),
        () => {
          if (!registrationCommitted) {
            deadlineFiredDuringRegistration = true;
            return;
          }
          void this.#expirePending(interactionId, "local_deadline", true);
        },
      );
      this.#consumeFacts(createCodexFactsAtPosition({
        accountProfileId: input.accountProfileId,
        generation: input.providerRequest.generation,
        origin: "live",
        streamPosition: input.providerRequest.streamPosition,
      }, [{
        type: "interaction.requested",
        expiresAt: pending.expiresAt,
        interactionId,
        kind: pending.publicRequest.kind === "user_input" ? "user_input" : "approval",
        threadId: input.threadId,
        turnId: input.turnId,
      }]));
      registrationCommitted = true;
      if (deadlineFiredDuringRegistration) {
        void this.#expirePending(interactionId, "local_deadline", true);
      }
    } catch (error) {
      this.#release(interactionId);
      throw error;
    }
  }

  async resolve(
    interactionId: string,
    response: RunInteractionResponse,
    authority?: () => Promise<boolean>,
  ): Promise<SessionInteractionResolution> {
    const pending = this.#pendingById.get(interactionId);
    if (pending === undefined) return { kind: "expired", reason: "provider_expired" };
    if (this.#resolving.has(interactionId)) return { kind: "rejected" };
    const checked = validateRunInteractionResponse(pending.publicRequest, response);
    if (!checked.success) return { kind: "rejected" };
    this.#resolving.add(interactionId);
    try {
      if (authority !== undefined && !(await authority())) {
        if (this.#pendingById.get(interactionId) !== pending) {
          await this.#notifyExpired(interactionId, "provider_expired");
        }
        return { kind: "rejected" };
      }
      if (this.#pendingById.get(interactionId) !== pending) {
        await this.#notifyExpired(interactionId, "provider_expired");
        return { kind: "expired", reason: "provider_expired" };
      }
      pending.deadline?.cancel();
      pending.deadline = null;
      if (this.#now() >= pending.expiresAt) {
        this.#release(interactionId);
        try {
          const position = await this.#respond(
            pending.accountProfileId,
            pending.providerRequest,
            interactionExpiredResponse(),
          );
          this.#settle(pending, "expired", position);
        } catch {
          // The provider may already have expired this exact request.
        }
        return { kind: "expired", reason: "local_deadline" };
      }
      const result = pending.providerResponse(checked.data);
      const position = await this.#respond(
        pending.accountProfileId,
        pending.providerRequest,
        { type: "result", result },
      );
      this.#settle(pending, "answered", position);
      this.#release(interactionId);
      return { kind: "applied" };
    } catch {
      this.#release(interactionId);
      return { kind: "expired", reason: "provider_expired" };
    } finally {
      this.#resolving.delete(interactionId);
    }
  }

  async expire(
    interactionId: string,
    reason: SessionInteractionExpired["reason"] = "provider_expired",
    authority?: () => Promise<boolean>,
  ): Promise<boolean> {
    return await this.#expirePending(interactionId, reason, false, authority);
  }

  async handleProviderExpired(
    accountProfileId: string,
    fault: CodexExpiredServerRequestFault,
  ): Promise<void> {
    if (fault.requestId === undefined) return;
    const providerKey = providerRequestKey(
      accountProfileId,
      fault.generation,
      fault.requestId,
    );
    const interactionId = this.#pendingIdByProviderKey.get(providerKey);
    if (interactionId === undefined) return;
    const pending = this.#pendingById.get(interactionId);
    const callerOwnsSettlement = this.#resolving.has(interactionId);
    if (fault.reason === "resolved_elsewhere" && pending !== undefined) {
      this.#providerResolvedByKey.set(pending.resolutionKey, {
        accountProfileId,
        generation: fault.generation,
        interactionId,
      });
      this.#trimProviderResolutions();
    }
    this.#release(interactionId);
    if (!callerOwnsSettlement) {
      await this.#notifyExpired(interactionId, "provider_expired");
    }
  }

  handleProviderResolutionFact(
    fact: Extract<CodexFact, { type: "server_request.resolved" }>,
  ): boolean {
    const resolved = this.#providerResolvedByKey.get(fact.requestKey);
    const pendingId = this.#pendingIdByResolutionKey.get(fact.requestKey);
    const interactionId = resolved?.interactionId ?? pendingId;
    if (interactionId === undefined) return false;
    if (
      resolved !== undefined &&
      (resolved.accountProfileId !== fact.accountProfileId ||
        resolved.generation !== fact.generation)
    ) {
      return false;
    }
    this.#providerResolvedByKey.delete(fact.requestKey);
    this.#release(interactionId);
    this.#consumeFacts(createCodexFactsAtPosition({
      accountProfileId: fact.accountProfileId,
      generation: fact.generation,
      origin: "live",
      streamPosition: fact.streamPosition,
    }, [{
      type: "interaction.settled",
      interactionId,
      outcome: "provider_resolved",
    }], fact.factIndex + 1));
    return true;
  }

  /** Releases every pending interaction outside the replacement generation. */
  retainGeneration(accountProfileId: string, generation: number): void {
    for (const pending of [...this.#pendingById.values()]) {
      if (
        pending.accountProfileId === accountProfileId &&
        pending.generation !== generation
      ) {
        this.#releaseForGenerationEnd(pending);
      }
    }
    for (const [key, resolved] of this.#providerResolvedByKey) {
      if (
        resolved.accountProfileId === accountProfileId &&
        resolved.generation !== generation
      ) {
        this.#providerResolvedByKey.delete(key);
      }
    }
  }

  /** Releases every pending resource owned by one ended generation. */
  endGeneration(accountProfileId: string, generation: number): void {
    for (const pending of [...this.#pendingById.values()]) {
      if (
        pending.accountProfileId === accountProfileId &&
        pending.generation === generation
      ) {
        this.#releaseForGenerationEnd(pending);
      }
    }
    for (const [key, resolved] of this.#providerResolvedByKey) {
      if (
        resolved.accountProfileId === accountProfileId &&
        resolved.generation === generation
      ) {
        this.#providerResolvedByKey.delete(key);
      }
    }
  }

  /** Releases every volatile interaction resource for an authorized account removal. */
  purgeAccount(accountProfileId: string): void {
    for (const pending of [...this.#pendingById.values()]) {
      if (pending.accountProfileId === accountProfileId) {
        this.#releaseForGenerationEnd(pending);
      }
    }
    for (const [key, resolved] of this.#providerResolvedByKey) {
      if (resolved.accountProfileId === accountProfileId) {
        this.#providerResolvedByKey.delete(key);
      }
    }
  }

  #releaseForGenerationEnd(pending: PendingSessionInteraction): void {
    const callerOwnsSettlement = this.#resolving.has(pending.interactionId);
    this.#release(pending.interactionId);
    if (!callerOwnsSettlement) {
      void this.#notifyExpired(pending.interactionId, "provider_expired");
    }
  }

  async #expirePending(
    interactionId: string,
    reason: SessionInteractionExpired["reason"],
    notify: boolean,
    authority?: () => Promise<boolean>,
  ): Promise<boolean> {
    const pending = this.#pendingById.get(interactionId);
    if (pending === undefined || this.#resolving.has(interactionId)) return false;
    this.#resolving.add(interactionId);
    try {
      if (authority !== undefined && !(await authority())) {
        if (this.#pendingById.get(interactionId) !== pending) {
          await this.#notifyExpired(interactionId, "provider_expired");
        }
        return false;
      }
      if (this.#pendingById.get(interactionId) !== pending) {
        await this.#notifyExpired(interactionId, "provider_expired");
        return true;
      }
      try {
        const position = await this.#respond(
          pending.accountProfileId,
          pending.providerRequest,
          interactionExpiredResponse(),
        );
        this.#settle(pending, "expired", position);
      } catch {
        // The app-server may have independently expired this exact request.
      }
      this.#release(interactionId);
      if (notify) await this.#notifyExpired(interactionId, reason);
      return true;
    } finally {
      this.#resolving.delete(interactionId);
    }
  }

  #settle(
    pending: PendingSessionInteraction,
    outcome: Extract<CodexFact, { type: "interaction.settled" }>["outcome"],
    streamPosition: CodexStreamPosition | void,
  ): void {
    if (typeof streamPosition !== "number") return;
    this.#consumeFacts(createCodexFactsAtPosition({
      accountProfileId: pending.accountProfileId,
      generation: pending.generation,
      origin: "live",
      streamPosition,
    }, [{
      type: "interaction.settled",
      interactionId: pending.interactionId,
      outcome,
    }]));
  }

  #release(interactionId: string): void {
    const pending = this.#pendingById.get(interactionId);
    if (pending === undefined) return;
    pending.deadline?.cancel();
    pending.deadline = null;
    this.#pendingById.delete(interactionId);
    this.#pendingIdByProviderKey.delete(pending.providerKey);
    this.#pendingIdByResolutionKey.delete(pending.resolutionKey);
    this.#resolving.delete(interactionId);
  }

  async #notifyExpired(
    interactionId: string,
    reason: SessionInteractionExpired["reason"],
  ): Promise<void> {
    try {
      await this.#onExpired({ interactionId, reason });
    } catch {
      // Expiry observation is auxiliary to already committed local release.
    }
  }

  #rememberInteractionIdentity(interactionId: string): void {
    this.#seenInteractionIds.add(interactionId);
    while (this.#seenInteractionIds.size > MAX_RETAINED_INTERACTION_IDENTITIES) {
      const oldest = this.#seenInteractionIds.values().next().value;
      if (oldest === undefined) return;
      this.#seenInteractionIds.delete(oldest);
    }
  }

  #trimProviderResolutions(): void {
    while (this.#providerResolvedByKey.size > MAX_RETAINED_PROVIDER_RESOLUTIONS) {
      const oldest = this.#providerResolvedByKey.keys().next().value;
      if (oldest === undefined) return;
      this.#providerResolvedByKey.delete(oldest);
    }
  }
}

function stableInteractionId(
  accountProfileId: string,
  request: CodexServerRequest,
): string {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update([
    "oprte-interaction-v2",
    accountProfileId,
    String(request.generation),
    String(request.requestInstanceId),
  ].join("\u0000"));
  return `interaction_${hasher.digest("hex").slice(0, 48)}`;
}

function providerRequestKey(
  accountProfileId: string,
  generation: number,
  requestId: string | number,
): string {
  return `${accountProfileId}\u0000${String(generation)}\u0000${typeof requestId}\u0000${String(requestId)}`;
}

function interactionExpiredResponse(): CodexServerResponse {
  return {
    type: "error",
    code: -32_000,
    message: "Interaction expired",
  };
}
