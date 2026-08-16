import {
  createRunInteractionRequestDigest,
  openRunInteractionResponse,
  runInteractionRequestSchema,
  validateRunInteractionResponse,
  type RunInteractionReplyKeyPair,
  type RunInteractionRequest,
  type RunInteractionResponse,
} from "@hraness/agent-tasks-protocol";

import type {
  SessionInteractionExpired,
  SessionInteractionRequest,
  SessionInteractionResolution,
  SessionTurnActivity,
} from "../sessions/session-service";
import type {
  DispatchInteractionStore,
} from "../state/dispatch-interaction-store";
import type { DispatchStore } from "../state/dispatch-store";
import type { DispatchActivityAdapter } from "./activity-adapter";
import type { HRADispatchHttpClient } from "./cloud-client";
import type { DispatchFenceGuard } from "./coordinator";

export type DispatchInteractionSyncStatus =
  | "ok"
  | "retry"
  | "aborted"
  | "fence_rejected"
  | "halted"
  | Readonly<{
    readonly kind: "run_terminal";
    readonly runId: string;
    readonly reason:
      | "interaction_limit"
      | "interaction_resolution_ambiguous"
      | "invalid_interaction_response";
  }>;

export interface DispatchInteractionSessionPort {
  resolveInteraction(
    interactionId: string,
    response: RunInteractionResponse,
    authority?: () => Promise<boolean>,
  ): Promise<SessionInteractionResolution>;
  expireInteraction(
    interactionId: string,
    reason: "local_deadline" | "provider_expired",
    authority?: () => Promise<boolean>,
  ): Promise<boolean>;
}

export class DispatchInteractionAdapter {
  readonly #activity: DispatchActivityAdapter;
  readonly #bindings: Pick<DispatchStore, "read" | "readByTurn">;
  readonly #cloud: Pick<HRADispatchHttpClient, "syncInteractions">;
  readonly #fence: DispatchFenceGuard;
  readonly #identity: Readonly<{
    runnerId: string;
    bootId: string;
    bootGeneration: number;
  }>;
  readonly #interactions: DispatchInteractionStore;
  readonly #replyKey: RunInteractionReplyKeyPair;
  readonly #sessions: DispatchInteractionSessionPort;
  readonly #activitiesByInteractionId = new Map<string, SessionTurnActivity>();
  #syncTail: Promise<void> = Promise.resolve();

  constructor(options: {
    readonly activity: DispatchActivityAdapter;
    readonly bindings: Pick<DispatchStore, "read" | "readByTurn">;
    readonly cloud: Pick<HRADispatchHttpClient, "syncInteractions">;
    readonly fence: DispatchFenceGuard;
    readonly identity: Readonly<{
      runnerId: string;
      bootId: string;
      bootGeneration: number;
    }>;
    readonly interactions: DispatchInteractionStore;
    readonly replyKey: RunInteractionReplyKeyPair;
    readonly sessions: DispatchInteractionSessionPort;
  }) {
    this.#activity = options.activity;
    this.#bindings = options.bindings;
    this.#cloud = options.cloud;
    this.#fence = options.fence;
    this.#identity = options.identity;
    this.#interactions = options.interactions;
    this.#replyKey = options.replyKey;
    this.#sessions = options.sessions;
  }

  async observeRequest(event: SessionInteractionRequest): Promise<RunInteractionRequest | null> {
    let binding = this.#bindings.readByTurn(event);
    if (binding === null || (binding.stage !== "waiting" && binding.stage !== "running")) return null;
    if (!(await this.#isCurrent(binding))) return null;
    binding = this.#bindings.readByTurn(event);
    if (binding === null || binding.stage !== "waiting") return null;
    const requestDigest = await createRunInteractionRequestDigest(event.request);
    const request = runInteractionRequestSchema.parse({
      ...event.request,
      reply: {
        version: 1,
        algorithm: "P256-HKDF-SHA256-A256GCM",
        keyId: this.#replyKey.keyId,
        publicKey: this.#replyKey.publicKey,
        runnerId: this.#identity.runnerId,
        bootId: this.#identity.bootId,
        bootGeneration: this.#identity.bootGeneration,
        claimId: binding.claimId,
        claimFence: binding.claimFence,
        requestDigest,
      },
    });
    this.#interactions.upsert(binding.runId, request);
    this.#activitiesByInteractionId.set(event.request.id, {
      accountProfileId: event.accountProfileId,
      threadId: event.threadId,
      turnId: event.turnId,
      kind: "running",
    });
    return request;
  }

  observeExpired(event: SessionInteractionExpired): void {
    const pending = this.#interactions.pending(event.interactionId);
    if (pending === null) return;
    this.#interactions.settle(event.interactionId, undefined, "expired", event.reason);
    this.#activitiesByInteractionId.delete(event.interactionId);
  }

  async syncOnce(
    currentRunIds: readonly string[],
    signal?: AbortSignal,
  ): Promise<DispatchInteractionSyncStatus> {
    const task = this.#syncTail.then(async () => await this.#syncOnce(currentRunIds, signal));
    this.#syncTail = task.then(() => undefined, () => undefined);
    return await task;
  }

  async #syncOnce(
    currentRunIds: readonly string[],
    signal?: AbortSignal,
  ): Promise<DispatchInteractionSyncStatus> {
    if (signal?.aborted === true) return "aborted";
    const current = new Set(currentRunIds);
    const runId = this.#interactions.nextRunId([...current]);
    if (runId === undefined) return "ok";
    const binding = this.#bindings.read(runId);
    if (
      binding === null ||
      binding.runtimePublicId !== this.#identity.runnerId ||
      binding.runtimeBootId !== this.#identity.bootId
    ) {
      return "halted";
    }
    if (!(await this.#isCurrent(binding))) return "fence_rejected";
    const batch = this.#interactions.syncBatch(runId);
    const result = await this.#cloud.syncInteractions(runId, {
      runnerId: this.#identity.runnerId,
      bootId: this.#identity.bootId,
      bootGeneration: this.#identity.bootGeneration,
      claimId: binding.claimId,
      claimFence: binding.claimFence,
      upserts: [...batch.upserts],
      settlements: [...batch.settlements],
    }, signal);
    if (!result.ok) return syncFailure(result.error, runId);
    if (!(await this.#isCurrent(binding))) return "fence_rejected";

    const refreshed = this.#bindings.read(runId);
    if (
      refreshed === null ||
      refreshed.claimId !== binding.claimId ||
      refreshed.claimFence !== binding.claimFence ||
      (result.data.responses.length > 0 && refreshed.stage !== "waiting")
    ) {
      return "fence_rejected";
    }

    const upsertIds = new Set(batch.upserts.map(({ id }) => id));
    if (result.data.acceptedInteractionIds.some((id) => !upsertIds.has(id))) return "halted";
    this.#interactions.markPublished(result.data.acceptedInteractionIds);
    const settlementById = new Map(batch.settlements.map((settlement) => [
      settlement.interactionId,
      settlement,
    ] as const));
    if (result.data.acceptedSettlementIds.some((id) => !settlementById.has(id))) return "halted";

    for (const expired of result.data.expiredInteractions) {
      const pending = this.#interactions.pending(expired.interactionId);
      if (pending === null) continue;
      if (pending.runId !== runId) return "halted";
      let cleanupCompleted: boolean;
      try {
        cleanupCompleted = await this.#sessions.expireInteraction(
          expired.interactionId,
          "local_deadline",
          async () => await this.#isExactCurrent(binding, true),
        );
      } catch {
        return interactionResolutionAmbiguous(runId);
      }
      const stage = await this.#exactCurrentInteractionStage(binding);
      if (stage === null) return "fence_rejected";
      // Settling deletes the last durable interaction. It is safe only when
      // provider cleanup was proved and synchronously resumed this exact turn;
      // otherwise a renewable waiting run would have no remaining resume path.
      if (!cleanupCompleted || stage !== "running") {
        return interactionResolutionAmbiguous(runId);
      }
      if (this.#interactions.pending(expired.interactionId) !== null) {
        this.#interactions.settle(
          expired.interactionId,
          expired.responseRevision,
          "expired",
          "cloud_expired",
        );
      }
      this.#activitiesByInteractionId.delete(expired.interactionId);
    }

    for (const response of result.data.responses) {
      const pending = this.#interactions.pending(response.interactionId);
      if (pending === null) {
        const settlement = settlementById.get(response.interactionId);
        if (settlement?.responseRevision === response.responseRevision) continue;
        const currentSettlement = this.#interactions.settlement(response.interactionId);
        if (
          currentSettlement?.outcome === "expired" ||
          (currentSettlement?.outcome === "applied" &&
            currentSettlement.responseRevision === response.responseRevision)
        ) continue;
        return "halted";
      }
      if (pending.runId !== runId) return "halted";
      let opened: RunInteractionResponse;
      try {
        opened = await openRunInteractionResponse(
          pending.request,
          { workspaceId: response.sealedResponse.workspaceId, runId },
          response.sealedResponse,
          this.#replyKey.privateKey,
        );
      } catch {
        return {
          kind: "run_terminal",
          runId,
          reason: "invalid_interaction_response",
        };
      }
      const checked = validateRunInteractionResponse(pending.request, opened);
      if (!checked.success) {
        return {
          kind: "run_terminal",
          runId,
          reason: "invalid_interaction_response",
        };
      }
      if (!(await this.#isExactCurrent(binding, true))) return "fence_rejected";
      const resolution = await this.#sessions.resolveInteraction(
        response.interactionId,
        checked.data,
        async () => await this.#isExactCurrent(binding, true),
      );
      if (resolution.kind === "rejected") {
        return await this.#isExactCurrent(binding, true) ? "retry" : "fence_rejected";
      }
      if (resolution.kind === "expired") {
        return interactionResolutionAmbiguous(runId);
      }
      this.#interactions.settle(
        response.interactionId,
        response.responseRevision,
        "applied",
      );
      const activity = this.#activitiesByInteractionId.get(response.interactionId);
      this.#activitiesByInteractionId.delete(response.interactionId);
      if (activity !== undefined) await this.#activity.observe(activity);
    }
    this.#interactions.acknowledgeSettlements(
      result.data.acceptedSettlementIds.filter((id) => settlementById.has(id)),
    );
    return "ok";
  }

  #isCurrent(binding: NonNullable<ReturnType<DispatchStore["read"]>>): Promise<boolean> {
    return this.#fence.assertCurrent({
      claimFence: binding.claimFence,
      claimId: binding.claimId,
      runId: binding.runId,
      runtimeBootId: binding.runtimeBootId,
      runtimePublicId: binding.runtimePublicId,
    });
  }

  async #isExactCurrent(
    expected: NonNullable<ReturnType<DispatchStore["read"]>>,
    requireWaiting: boolean,
  ): Promise<boolean> {
    const current = this.#bindings.read(expected.runId);
    if (
      current === null ||
      current.claimId !== expected.claimId ||
      current.claimFence !== expected.claimFence ||
      current.runtimePublicId !== expected.runtimePublicId ||
      current.runtimeBootId !== expected.runtimeBootId ||
      (requireWaiting && current.stage !== "waiting")
    ) return false;
    return await this.#isCurrent(current);
  }

  async #exactCurrentInteractionStage(
    expected: NonNullable<ReturnType<DispatchStore["read"]>>,
  ): Promise<"running" | "waiting" | null> {
    const current = this.#bindings.read(expected.runId);
    if (
      current === null ||
      current.claimId !== expected.claimId ||
      current.claimFence !== expected.claimFence ||
      current.runtimePublicId !== expected.runtimePublicId ||
      current.runtimeBootId !== expected.runtimeBootId ||
      (current.stage !== "waiting" && current.stage !== "running")
    ) return null;
    return await this.#isCurrent(current) ? current.stage : null;
  }
}

function interactionResolutionAmbiguous(
  runId: string,
): Extract<DispatchInteractionSyncStatus, { readonly kind: "run_terminal" }> {
  return { kind: "run_terminal", runId, reason: "interaction_resolution_ambiguous" };
}

function syncFailure(
  failure: Awaited<ReturnType<HRADispatchHttpClient["syncInteractions"]>> extends infer Result
    ? Result extends { readonly ok: false; readonly error: infer Error }
      ? Error
      : never
    : never,
  runId: string,
): DispatchInteractionSyncStatus {
  if (failure.kind === "aborted") return "aborted";
  if (failure.kind === "remote") {
    if (failure.code === "RUN_INTERACTION_LIMIT") {
      return { kind: "run_terminal", runId, reason: "interaction_limit" };
    }
    if (
      failure.code === "CLAIM_STALE" ||
      failure.code === "CLAIM_NOT_OWNED" ||
      failure.code === "LEASE_NOT_RENEWABLE" ||
      failure.code === "TASK_STATE_CONFLICT"
    ) return "fence_rejected";
    if (
      failure.code === "AUTHENTICATION_FAILED" ||
      failure.code === "SESSION_REQUIRED" ||
      failure.code === "SESSION_INVALID" ||
      failure.code === "AUTHORIZATION_DENIED" ||
      failure.code === "SCOPE_REQUIRED" ||
      failure.code === "VALIDATION_ERROR" ||
      failure.code === "ORGANIZATION_MISMATCH" ||
      failure.code === "MEMBERSHIP_INACTIVE"
    ) return "halted";
  }
  return "retry";
}
