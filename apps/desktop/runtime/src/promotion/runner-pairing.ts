import {
  agentIdSchema,
  agentPresetScopes,
  agentScopeSchema,
  createBearerSecret,
  createLocator,
  createUuidV7,
  credentialTokenSchema,
  enrollmentTokenSchema,
  epochMsSchema,
  formatCredentialToken,
  formatEnrollmentToken,
  parseCredentialToken,
  parseEnrollmentToken,
  promotionIdSchema,
  sessionIdSchema,
  uuidV7Schema,
  workspacePublicIdSchema,
  type CreateAgentEnrollmentResponse,
  type CredentialToken,
  type EnrollmentToken,
  type IdempotencyKey,
  type RedeemEnrollmentResponse,
  type SessionId,
  type StartSessionResponse,
} from "@hraness/agent-tasks-protocol";
import {
  GenerationalSecretCustody,
  HRA_RUNNER_KEYCHAIN_SERVICE,
  SecretCustodyError,
  humanApiOriginSchema,
  type SecretCustodyMetadataStore,
  type SecretStore,
} from "@hraness/hra-human-client";
import { z } from "@hra-internal/schema";
import { createHmac, randomBytes } from "node:crypto";

import type {
  HRACloudOperation,
  HRACloudSessionResult,
} from "../cloud/http-client";
import { bunHumanKeychain } from "../cloud/keychain-custody";

const MINIMUM_AUTHORIZATION_VALIDITY_MS = 60_000;
const MAX_CUSTODY_RECONCILIATION_ATTEMPTS = 8;
const RUNNER_NAME_KEY_MINIMUM_BYTES = 32;

export const hraRunnerPairingInputSchema = z
  .object({
    promotionId: promotionIdSchema,
    destinationWorkspaceId: workspacePublicIdSchema,
    importedAgentId: agentIdSchema,
  })
  .strict()
  .superRefine((input, context) => {
    if (
      input.importedAgentId !==
        `imported_local_codex_${input.promotionId}`
    ) {
      context.addIssue({
        code: "custom",
        message: "imported agent is not bound to the promotion",
        path: ["importedAgentId"],
      });
    }
  });

export type HRARunnerPairingInput = z.infer<
  typeof hraRunnerPairingInputSchema
>;

const pairingBindingShape = {
  version: z.literal(1),
  apiOrigin: humanApiOriginSchema,
  promotionId: promotionIdSchema,
  destinationWorkspaceId: workspacePublicIdSchema,
  importedAgentId: agentIdSchema,
};

const preparedRunnerSecretSchema = z
  .object({
    ...pairingBindingShape,
    state: z.literal("prepared"),
    preparedAt: epochMsSchema,
    enrollment: enrollmentTokenSchema,
    credential: credentialTokenSchema,
    idempotency: z
      .object({
        createEnrollment: uuidV7Schema,
        redeemEnrollment: uuidV7Schema,
        startSession: uuidV7Schema,
      })
      .strict(),
  })
  .strict();

const pairedRunnerSecretSchema = z
  .object({
    ...pairingBindingShape,
    state: z.literal("paired"),
    credential: credentialTokenSchema,
    credentialExpiresAt: epochMsSchema,
    scopes: z.array(agentScopeSchema).min(1),
    sessionId: sessionIdSchema,
    sessionExpiresAt: epochMsSchema,
    sessionAttempt: z
      .object({
        idempotencyKey: uuidV7Schema,
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((secret, context) => {
    if (new Set(secret.scopes).size !== secret.scopes.length) {
      context.addIssue({
        code: "custom",
        message: "runner scopes must be unique",
        path: ["scopes"],
      });
    }
    for (const scope of agentPresetScopes.dispatcher) {
      if (!secret.scopes.includes(scope)) {
        context.addIssue({
          code: "custom",
          message: "runner is missing dispatcher authority",
          path: ["scopes"],
        });
      }
    }
  });

const runnerSecretSchema = z.discriminatedUnion("state", [
  preparedRunnerSecretSchema,
  pairedRunnerSecretSchema,
]);

type PreparedRunnerSecret = z.infer<typeof preparedRunnerSecretSchema>;
type PairedRunnerSecret = z.infer<typeof pairedRunnerSecretSchema>;
type RunnerSecret = z.infer<typeof runnerSecretSchema>;

export const hraRunnerPairingFailureCodeValues = [
  "invalid_binding",
  "not_paired",
  "pairing_incomplete",
  "custody_recovery_required",
  "custody_unavailable",
  "custody_invalid",
  "state_conflict",
  "human_session_required",
  "cloud_unavailable",
  "cloud_rejected",
  "cloud_response_invalid",
  "dispatcher_scope_missing",
  "credential_unavailable",
  "session_unavailable",
  "local_state_unavailable",
] as const;

export const hraRunnerPairingFailureCodeSchema = z.enum(
  hraRunnerPairingFailureCodeValues,
);
export type HRARunnerPairingFailureCode = z.infer<
  typeof hraRunnerPairingFailureCodeSchema
>;

const credentialRecoveryFailureCodes = new Set<
  HRARunnerPairingFailureCode
>([
  "custody_recovery_required",
  "custody_unavailable",
  "custody_invalid",
  "invalid_binding",
]);

export function runnerPairingFailureMayRequireCredentialRecovery(
  code: HRARunnerPairingFailureCode,
): boolean {
  return credentialRecoveryFailureCodes.has(code);
}

interface RunnerPairingInspectionIdentity {
  readonly attemptCount: number;
  readonly cloudWorkspaceId: string;
  readonly promotionId: string;
  readonly state: string;
}

/** Process-local optimization only; every recovery confirmation reinspects. */
export class HRARunnerPairingInspectionCache {
  readonly #fingerprints = new Map<string, string>();

  get size(): number {
    return this.#fingerprints.size;
  }

  hasCurrent(pairing: RunnerPairingInspectionIdentity): boolean {
    return this.#fingerprints.get(this.#identity(pairing)) ===
      this.#fingerprint(pairing);
  }

  record(pairing: RunnerPairingInspectionIdentity): void {
    this.#fingerprints.set(
      this.#identity(pairing),
      this.#fingerprint(pairing),
    );
  }

  evict(pairing: RunnerPairingInspectionIdentity): void {
    this.#fingerprints.delete(this.#identity(pairing));
  }

  clear(): void {
    this.#fingerprints.clear();
  }

  #identity(pairing: RunnerPairingInspectionIdentity): string {
    return `${pairing.cloudWorkspaceId}\u0000${pairing.promotionId}`;
  }

  #fingerprint(pairing: RunnerPairingInspectionIdentity): string {
    // updatedAt deliberately is not part of the fingerprint: a healthy runner
    // heartbeat refreshes that timestamp without changing custody authority.
    return `${pairing.state}\u0000${String(pairing.attemptCount)}`;
  }
}

const failureMessages = {
  invalid_binding: "The imported runner does not match this promotion.",
  not_paired: "This cloud workspace has no local runner authorization.",
  pairing_incomplete: "Runner pairing has not completed yet.",
  custody_recovery_required:
    "Runner credential recovery must finish before pairing can continue.",
  custody_unavailable: "Runner credential custody is unavailable.",
  custody_invalid: "Runner credential custody is invalid.",
  state_conflict: "Runner pairing changed concurrently.",
  human_session_required: "Sign in again to finish pairing the local runner.",
  cloud_unavailable: "Runner pairing is waiting for the cloud service.",
  cloud_rejected: "The cloud service rejected runner pairing.",
  cloud_response_invalid: "The cloud service returned an invalid pairing response.",
  dispatcher_scope_missing:
    "The imported runner is missing dispatcher authority.",
  credential_unavailable: "The runner credential is unavailable.",
  session_unavailable: "The runner session is unavailable.",
  local_state_unavailable: "Local runner pairing state is unavailable.",
} as const satisfies Record<HRARunnerPairingFailureCode, string>;

const retryableFailureCodes = new Set<HRARunnerPairingFailureCode>([
  "pairing_incomplete",
  "custody_recovery_required",
  "custody_unavailable",
  "state_conflict",
  "human_session_required",
  "cloud_unavailable",
  "session_unavailable",
  "local_state_unavailable",
]);

export interface HRARunnerPairingFailure {
  readonly code: HRARunnerPairingFailureCode;
  readonly message: string;
  readonly retryable: boolean;
}

export class HRARunnerPairingError extends Error {
  readonly code: HRARunnerPairingFailureCode;
  readonly retryable: boolean;

  constructor(code: HRARunnerPairingFailureCode) {
    super(failureMessages[code]);
    this.name = "HRARunnerPairingError";
    this.code = code;
    this.retryable = retryableFailureCodes.has(code);
  }

  toJSON(): HRARunnerPairingFailure {
    return {
      code: this.code,
      message: this.message,
      retryable: this.retryable,
    };
  }
}

export interface HRARunnerPairingCloudPort {
  createAgentEnrollment(
    agentId: string,
    input: {
      readonly workspaceId: string;
      readonly enrollment: EnrollmentToken;
      readonly idempotencyKey: IdempotencyKey;
    },
  ): Promise<HRACloudSessionResult<CreateAgentEnrollmentResponse>>;
  redeemRunnerEnrollment(
    enrollment: EnrollmentToken,
    input: {
      readonly agentId: string;
      readonly credential: CredentialToken;
      readonly idempotencyKey: IdempotencyKey;
    },
  ): Promise<HRACloudOperation<RedeemEnrollmentResponse>>;
  startRunnerSession(
    credential: CredentialToken,
    idempotencyKey: IdempotencyKey,
  ): Promise<HRACloudOperation<StartSessionResponse>>;
}

export interface HRARunnerPairingStatusPort {
  markPairingState(input: {
    readonly cloudWorkspaceId: string;
    readonly promotionId: string;
    readonly state: "pairing" | "paired" | "blocked";
    readonly faultCode: string | null;
    readonly now: number;
  }): void | Promise<void>;
}

export interface HRARunnerPairingRandom {
  bytes(length: number): Uint8Array;
}

export interface HRARunnerAuthorization {
  readonly apiOrigin: string;
  readonly credential: CredentialToken;
  readonly sessionId: SessionId;
}

export interface HRARunnerPairingView {
  readonly promotionId: string;
  readonly destinationWorkspaceId: string;
  readonly importedAgentId: string;
  readonly credentialExpiresAt: number;
  readonly sessionExpiresAt: number;
}

export type HRARunnerPairingResult =
  | {
      readonly ok: true;
      readonly pairing: HRARunnerPairingView;
    }
  | {
      readonly ok: false;
      readonly error: HRARunnerPairingFailure;
    };

export type HRARunnerLegacyReconnectResult =
  | {
      readonly ok: true;
      readonly state: "not_required" | "quarantined";
    }
  | {
      readonly ok: false;
      readonly error: HRARunnerPairingFailure;
    };

export type HRARunnerLegacyReconnectInspectionResult =
  | {
      readonly ok: true;
      readonly state: "not_required" | "required";
    }
  | {
      readonly ok: false;
      readonly error: HRARunnerPairingFailure;
    };

/**
 * Gateway-internal only. The successful branch contains bearer material and
 * must never cross the native bridge or be serialized into diagnostics.
 */
export type HRARunnerAuthorizationResult =
  | {
      readonly ok: true;
      readonly authorization: HRARunnerAuthorization;
      readonly credentialExpiresAt: number;
      readonly sessionExpiresAt: number;
    }
  | {
      readonly ok: false;
      readonly error: HRARunnerPairingFailure;
    };

interface LoadedSecret {
  readonly generation: number;
  readonly secret: RunnerSecret;
}

const systemRandom: HRARunnerPairingRandom = {
  bytes(length) {
    return randomBytes(length);
  },
};

function failure(
  code: HRARunnerPairingFailureCode,
): HRARunnerPairingFailure {
  return new HRARunnerPairingError(code).toJSON();
}

function failed(
  code: HRARunnerPairingFailureCode,
): HRARunnerPairingResult & { readonly ok: false } {
  return { ok: false, error: failure(code) };
}

function authorizationFailed(
  code: HRARunnerPairingFailureCode,
): HRARunnerAuthorizationResult & { readonly ok: false } {
  return { ok: false, error: failure(code) };
}

function sameBinding(
  secret: RunnerSecret,
  input: HRARunnerPairingInput,
  apiOrigin: string,
): boolean {
  return (
    secret.apiOrigin === apiOrigin &&
    secret.promotionId === input.promotionId &&
    secret.destinationWorkspaceId === input.destinationWorkspaceId &&
    secret.importedAgentId === input.importedAgentId
  );
}

function pairedView(secret: PairedRunnerSecret): HRARunnerPairingView {
  return {
    promotionId: secret.promotionId,
    destinationWorkspaceId: secret.destinationWorkspaceId,
    importedAgentId: secret.importedAgentId,
    credentialExpiresAt: secret.credentialExpiresAt,
    sessionExpiresAt: secret.sessionExpiresAt,
  };
}

function authorization(
  secret: PairedRunnerSecret,
): HRARunnerAuthorizationResult & { readonly ok: true } {
  return {
    ok: true,
    authorization: {
      apiOrigin: secret.apiOrigin,
      credential: secret.credential,
      sessionId: secret.sessionId,
    },
    credentialExpiresAt: secret.credentialExpiresAt,
    sessionExpiresAt: secret.sessionExpiresAt,
  };
}

function cloudFailureCode(
  result:
    | Exclude<
        HRACloudOperation<unknown>,
        { readonly ok: true }
      >
    | Exclude<
        HRACloudSessionResult<unknown>,
        { readonly ok: true }
      >,
  phase: "human" | "runner",
): HRARunnerPairingFailureCode {
  if (
    result.error.code === "SERVICE_UNAVAILABLE" ||
    result.error.code === "RATE_LIMITED"
  ) {
    return "cloud_unavailable";
  }
  if (
    phase === "human" &&
    (
      result.error.code === "SIGNED_OUT" ||
      result.error.code === "AUTHENTICATION_FAILED" ||
      result.error.code === "AUTH_REFRESH_INDETERMINATE"
    )
  ) {
    return "human_session_required";
  }
  return "cloud_rejected";
}

function custodyFailureCode(error: unknown): HRARunnerPairingFailureCode {
  if (error instanceof SecretCustodyError) {
    if (error.reason === "pending_secret_missing") {
      return "custody_recovery_required";
    }
    if (
      error.reason === "invalid_metadata" ||
      error.reason === "stale_generation"
    ) {
      return "custody_invalid";
    }
    if (error.reason === "concurrent_update") return "state_conflict";
  }
  return "custody_unavailable";
}

function parseInput(
  value: HRARunnerPairingInput,
): HRARunnerPairingInput | null {
  const parsed = hraRunnerPairingInputSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function serializeSecret(secret: RunnerSecret): string {
  return JSON.stringify(runnerSecretSchema.parse(secret));
}

function parseRunnerSecret(value: string): RunnerSecret | null {
  let source: unknown;
  try {
    source = JSON.parse(value) as unknown;
  } catch {
    return null;
  }
  const parsed = runnerSecretSchema.safeParse(source);
  return parsed.success ? parsed.data : null;
}

export function hraRunnerKeychainName(
  nameKey: Uint8Array,
  apiOriginValue: string,
  workspaceIdValue: string,
): string {
  if (nameKey.byteLength < RUNNER_NAME_KEY_MINIMUM_BYTES) {
    throw new TypeError("runner keychain name key must contain at least 32 bytes");
  }
  const apiOrigin = humanApiOriginSchema.parse(apiOriginValue);
  const workspaceId = workspacePublicIdSchema.parse(workspaceIdValue);
  const digest = createHmac("sha256", nameKey)
    .update("kitchen-runner-custody-name-v1\0", "utf8")
    .update(apiOrigin, "utf8")
    .update("\0", "utf8")
    .update(workspaceId, "utf8")
    .digest("base64url");
  return `workspace_${digest}`;
}

export function createOpaqueRunnerSecretSlot(): string {
  return `runner_${randomBytes(24).toString("base64url")}`;
}

export class HRARunnerPairingCoordinator {
  readonly #apiOrigin: string;
  readonly #cloud: HRARunnerPairingCloudPort;
  readonly #custodies = new Map<string, GenerationalSecretCustody>();
  readonly #metadata: SecretCustodyMetadataStore;
  readonly #nameKey: Uint8Array;
  readonly #nextSlot: () => string;
  readonly #now: () => number;
  readonly #random: HRARunnerPairingRandom;
  readonly #secrets: SecretStore;
  readonly #status: HRARunnerPairingStatusPort;

  constructor(options: {
    readonly apiOrigin: string;
    readonly cloud: HRARunnerPairingCloudPort;
    readonly metadata: SecretCustodyMetadataStore;
    readonly nameKey: Uint8Array;
    readonly secrets?: SecretStore;
    readonly status: HRARunnerPairingStatusPort;
    readonly nextSlot?: () => string;
    readonly now?: () => number;
    readonly random?: HRARunnerPairingRandom;
  }) {
    this.#apiOrigin = humanApiOriginSchema.parse(options.apiOrigin);
    this.#cloud = options.cloud;
    this.#metadata = options.metadata;
    if (options.nameKey.byteLength < RUNNER_NAME_KEY_MINIMUM_BYTES) {
      throw new TypeError(
        "runner keychain name key must contain at least 32 bytes",
      );
    }
    this.#nameKey = Uint8Array.from(options.nameKey);
    this.#nextSlot = options.nextSlot ?? createOpaqueRunnerSecretSlot;
    this.#now = options.now ?? Date.now;
    this.#random = options.random ?? systemRandom;
    this.#secrets = options.secrets ?? bunHumanKeychain;
    this.#status = options.status;
  }

  #custody(workspaceId: string): GenerationalSecretCustody {
    const name = hraRunnerKeychainName(
      this.#nameKey,
      this.#apiOrigin,
      workspaceId,
    );
    const existing = this.#custodies.get(name);
    if (existing !== undefined) return existing;
    const custody = new GenerationalSecretCustody({
      descriptor: {
        service: HRA_RUNNER_KEYCHAIN_SERVICE,
        name,
      },
      metadata: this.#metadata,
      secrets: this.#secrets,
      nextSlot: this.#nextSlot,
    });
    this.#custodies.set(name, custody);
    return custody;
  }

  #prepare(input: HRARunnerPairingInput): PreparedRunnerSecret {
    const now = epochMsSchema.parse(this.#now());
    const enrollment = formatEnrollmentToken(
      createLocator(this.#random.bytes(26)),
      createBearerSecret(this.#random.bytes(32)),
    );
    const credential = formatCredentialToken(
      createLocator(this.#random.bytes(26)),
      createBearerSecret(this.#random.bytes(32)),
    );
    return preparedRunnerSecretSchema.parse({
      version: 1,
      state: "prepared",
      apiOrigin: this.#apiOrigin,
      promotionId: input.promotionId,
      destinationWorkspaceId: input.destinationWorkspaceId,
      importedAgentId: input.importedAgentId,
      preparedAt: now,
      enrollment,
      credential,
      idempotency: {
        createEnrollment: createUuidV7(now, this.#random.bytes(10)),
        redeemEnrollment: createUuidV7(now, this.#random.bytes(10)),
        startSession: createUuidV7(now, this.#random.bytes(10)),
      },
    });
  }

  async #read(
    custody: GenerationalSecretCustody,
  ): Promise<LoadedSecret | null> {
    const stored = await custody.read();
    if (stored === null) return null;
    const parsed = parseRunnerSecret(stored.value);
    if (parsed === null) {
      throw new HRARunnerPairingError("custody_invalid");
    }
    return { generation: stored.generation, secret: parsed };
  }

  async #mark(
    input: HRARunnerPairingInput,
    state: "pairing" | "paired" | "blocked",
    faultCode: HRARunnerPairingFailureCode | null,
  ): Promise<boolean> {
    try {
      await this.#status.markPairingState({
        cloudWorkspaceId: input.destinationWorkspaceId,
        promotionId: input.promotionId,
        state,
        faultCode,
        now: epochMsSchema.parse(this.#now()),
      });
      return true;
    } catch {
      return false;
    }
  }

  async #blocked(
    input: HRARunnerPairingInput,
    code: HRARunnerPairingFailureCode,
  ): Promise<HRARunnerPairingResult> {
    await this.#mark(input, "blocked", code);
    return failed(code);
  }

  async #replacePrepared(
    custody: GenerationalSecretCustody,
    input: HRARunnerPairingInput,
    expectedGeneration: number | null,
  ): Promise<LoadedSecret> {
    const prepared = this.#prepare(input);
    const pointer = await custody.compareAndSwap(
      expectedGeneration,
      serializeSecret(prepared),
    );
    if (pointer !== null) {
      return { generation: pointer.generation, secret: prepared };
    }
    const winner = await this.#read(custody);
    if (
      winner === null ||
      !sameBinding(winner.secret, input, this.#apiOrigin)
    ) {
      throw new HRARunnerPairingError("state_conflict");
    }
    return winner;
  }

  async #loadOrPrepare(
    custody: GenerationalSecretCustody,
    input: HRARunnerPairingInput,
  ): Promise<LoadedSecret> {
    const loaded = await this.#read(custody);
    if (loaded === null) {
      return await this.#replacePrepared(custody, input, null);
    }
    if (!sameBinding(loaded.secret, input, this.#apiOrigin)) {
      throw new HRARunnerPairingError("invalid_binding");
    }
    if (
      loaded.secret.state === "paired" &&
      loaded.secret.credentialExpiresAt <=
        this.#now() + MINIMUM_AUTHORIZATION_VALIDITY_MS
    ) {
      return await this.#replacePrepared(
        custody,
        input,
        loaded.generation,
      );
    }
    return loaded;
  }

  async #callCloud<Value>(
    operation: () => Promise<
      | HRACloudOperation<Value>
      | HRACloudSessionResult<Value>
    >,
    phase: "human" | "runner",
  ): Promise<
    | { readonly ok: true; readonly data: Value }
    | {
        readonly ok: false;
        readonly code: HRARunnerPairingFailureCode;
      }
  > {
    try {
      const result = await operation();
      return result.ok
        ? { ok: true, data: result.data }
        : { ok: false, code: cloudFailureCode(result, phase) };
    } catch {
      return { ok: false, code: "cloud_unavailable" };
    }
  }

  async #finishPrepared(
    custody: GenerationalSecretCustody,
    input: HRARunnerPairingInput,
    loaded: LoadedSecret & { readonly secret: PreparedRunnerSecret },
  ): Promise<HRARunnerPairingResult> {
    const enrollmentToken = parseEnrollmentToken(loaded.secret.enrollment);
    const credentialToken = parseCredentialToken(loaded.secret.credential);
    if (enrollmentToken === null || credentialToken === null) {
      return await this.#blocked(input, "custody_invalid");
    }

    const created = await this.#callCloud(
      async () =>
        await this.#cloud.createAgentEnrollment(
          input.importedAgentId,
          {
            workspaceId: input.destinationWorkspaceId,
            enrollment: loaded.secret.enrollment,
            idempotencyKey:
              loaded.secret.idempotency.createEnrollment,
          },
        ),
      "human",
    );
    if (!created.ok) return await this.#blocked(input, created.code);
    if (
      created.data.enrollment.locator !== enrollmentToken.locator ||
      created.data.enrollment.expiresAt <= this.#now()
    ) {
      return await this.#blocked(input, "cloud_response_invalid");
    }

    const redeemed = await this.#callCloud(
      async () =>
        await this.#cloud.redeemRunnerEnrollment(
          loaded.secret.enrollment,
          {
            agentId: input.importedAgentId,
            credential: loaded.secret.credential,
            idempotencyKey:
              loaded.secret.idempotency.redeemEnrollment,
          },
        ),
      "runner",
    );
    if (!redeemed.ok) return await this.#blocked(input, redeemed.code);
    if (
      redeemed.data.agentId !== input.importedAgentId ||
      redeemed.data.credentialId !== credentialToken.locator
    ) {
      return await this.#blocked(input, "cloud_response_invalid");
    }
    if (
      !agentPresetScopes.dispatcher.every((scope) =>
        redeemed.data.scopes.includes(scope)
      )
    ) {
      return await this.#blocked(input, "dispatcher_scope_missing");
    }
    if (
      redeemed.data.credentialExpiresAt <=
        this.#now() + MINIMUM_AUTHORIZATION_VALIDITY_MS
    ) {
      return await this.#blocked(input, "credential_unavailable");
    }

    const session = await this.#callCloud(
      async () =>
        await this.#cloud.startRunnerSession(
          loaded.secret.credential,
          loaded.secret.idempotency.startSession,
        ),
      "runner",
    );
    if (!session.ok) return await this.#blocked(input, session.code);
    if (
      session.data.expiresAt <=
        this.#now() + MINIMUM_AUTHORIZATION_VALIDITY_MS ||
      session.data.expiresAt > redeemed.data.credentialExpiresAt
    ) {
      return await this.#blocked(input, "session_unavailable");
    }

    const paired = pairedRunnerSecretSchema.parse({
      version: 1,
      state: "paired",
      apiOrigin: this.#apiOrigin,
      promotionId: input.promotionId,
      destinationWorkspaceId: input.destinationWorkspaceId,
      importedAgentId: input.importedAgentId,
      credential: loaded.secret.credential,
      credentialExpiresAt: redeemed.data.credentialExpiresAt,
      scopes: redeemed.data.scopes,
      sessionId: session.data.sessionId,
      sessionExpiresAt: session.data.expiresAt,
    });
    let pointer;
    try {
      pointer = await custody.compareAndSwap(
        loaded.generation,
        serializeSecret(paired),
      );
    } catch (error: unknown) {
      return await this.#blocked(input, custodyFailureCode(error));
    }
    if (pointer === null) {
      let winner: LoadedSecret | null;
      try {
        winner = await this.#read(custody);
      } catch (error: unknown) {
        return await this.#blocked(input, custodyFailureCode(error));
      }
      if (
        winner === null ||
        winner.secret.state !== "paired" ||
        !sameBinding(winner.secret, input, this.#apiOrigin) ||
        winner.secret.credential !== paired.credential
      ) {
        return await this.#blocked(input, "state_conflict");
      }
      return await this.#finishAuthorizationCustody(input, winner.secret);
    }
    return await this.#finishAuthorizationCustody(input, paired);
  }

  async #finishAuthorizationCustody(
    input: HRARunnerPairingInput,
    secret: PairedRunnerSecret,
  ): Promise<HRARunnerPairingResult> {
    // Credential/session custody proves authorization, not that the local
    // dispatch loop can actually heartbeat. Root advances this row to `paired`
    // only from HRADispatchRunner.onHeartbeatAccepted.
    if (!(await this.#mark(input, "pairing", null))) {
      return failed("local_state_unavailable");
    }
    return { ok: true, pairing: pairedView(secret) };
  }

  async pair(
    inputValue: HRARunnerPairingInput,
  ): Promise<HRARunnerPairingResult> {
    const input = parseInput(inputValue);
    if (input === null) return failed("invalid_binding");
    const custody = this.#custody(input.destinationWorkspaceId);
    try {
      if ((await custody.inspectLegacyIdentityReconnect()).state === "required") {
        return await this.#blocked(input, "custody_recovery_required");
      }
    } catch (error: unknown) {
      return await this.#blocked(input, custodyFailureCode(error));
    }
    let loaded: LoadedSecret;
    try {
      loaded = await this.#loadOrPrepare(custody, input);
    } catch (error: unknown) {
      const code = error instanceof HRARunnerPairingError
        ? error.code
        : custodyFailureCode(error);
      return await this.#blocked(input, code);
    }
    if (loaded.secret.state === "paired") {
      return await this.#finishAuthorizationCustody(input, loaded.secret);
    }
    if (!(await this.#mark(input, "pairing", null))) {
      return failed("local_state_unavailable");
    }
    return await this.#finishPrepared(custody, input, {
      ...loaded,
      secret: loaded.secret,
    });
  }

  /**
   * User-confirmed first-stable-identity recovery. It retires only exact
   * inaccessible journal pointers; the opaque Keychain items are preserved.
   */
  async confirmLegacyCredentialReconnect(
    inputValue: HRARunnerPairingInput,
  ): Promise<HRARunnerLegacyReconnectResult> {
    const input = parseInput(inputValue);
    if (input === null) {
      return { ok: false, error: failure("invalid_binding") };
    }
    try {
      const custody = this.#custody(input.destinationWorkspaceId);
      let recovered = await custody.quarantineLegacyIdentityPointers();
      if (recovered.state === "not_required") {
        recovered = await custody.preservePointerAnomalies();
      }
      if (recovered.state === "not_required") {
        const committed = await custody.inspectCommittedForRecovery();
        if (
          committed.state === "missing" || committed.state === "invalid" ||
          (committed.state === "valid" && (() => {
            const secret = parseRunnerSecret(committed.value);
            return secret === null || !sameBinding(secret, input, this.#apiOrigin);
          })())
        ) {
          recovered = await custody.preserveCommittedForRecovery(
            committed,
            committed.state === "missing"
              ? "missing_pointer_abandoned"
              : "invalid_pointer_preserved",
          );
        }
      }
      if (!(await this.#mark(input, "pairing", null))) {
        return {
          ok: false,
          error: failure("local_state_unavailable"),
        };
      }
      return { ok: true, state: recovered.state };
    } catch (error: unknown) {
      const code = error instanceof HRARunnerPairingError
        ? error.code
        : custodyFailureCode(error);
      await this.#mark(input, "blocked", code);
      return { ok: false, error: failure(code) };
    }
  }

  async inspectLegacyCredentialReconnect(
    inputValue: HRARunnerPairingInput,
  ): Promise<HRARunnerLegacyReconnectInspectionResult> {
    return await this.#inspectCredentialReconnect(inputValue, false);
  }

  /** Reinspection after an operation fault includes every durable role. */
  async inspectCredentialReconnect(
    inputValue: HRARunnerPairingInput,
  ): Promise<HRARunnerLegacyReconnectInspectionResult> {
    return await this.#inspectCredentialReconnect(inputValue, true);
  }

  async #inspectCredentialReconnect(
    inputValue: HRARunnerPairingInput,
    includePointerAnomalies: boolean,
  ): Promise<HRARunnerLegacyReconnectInspectionResult> {
    const input = parseInput(inputValue);
    if (input === null) {
      return { ok: false, error: failure("invalid_binding") };
    }
    try {
      const custody = this.#custody(input.destinationWorkspaceId);
      const inspected = await custody.inspectLegacyIdentityReconnect();
      if (inspected.state === "required") {
        return { ok: true, state: "required" };
      }
      if (includePointerAnomalies) {
        const anomalies = await custody.inspectPointerAnomalies();
        if (anomalies.state === "required") {
          return { ok: true, state: "required" };
        }
      }
      const committed = await custody.inspectCommittedForRecovery();
      return {
        ok: true,
        state: committed.state === "missing" || committed.state === "invalid" ||
            (committed.state === "valid" && (() => {
              const secret = parseRunnerSecret(committed.value);
              return secret === null ||
                !sameBinding(secret, input, this.#apiOrigin);
            })())
          ? "required"
          : "not_required",
      };
    } catch (error: unknown) {
      const code = error instanceof HRARunnerPairingError
        ? error.code
        : custodyFailureCode(error);
      return { ok: false, error: failure(code) };
    }
  }

  async readAuthorization(
    inputValue: HRARunnerPairingInput,
  ): Promise<HRARunnerAuthorizationResult> {
    const input = parseInput(inputValue);
    if (input === null) return authorizationFailed("invalid_binding");
    const custody = this.#custody(input.destinationWorkspaceId);
    try {
      if ((await custody.inspectLegacyIdentityReconnect()).state === "required") {
        return authorizationFailed("custody_recovery_required");
      }
    } catch (error: unknown) {
      return authorizationFailed(custodyFailureCode(error));
    }
    let loaded: LoadedSecret | null;
    try {
      loaded = await this.#read(custody);
    } catch (error: unknown) {
      const code = error instanceof HRARunnerPairingError
        ? error.code
        : custodyFailureCode(error);
      return authorizationFailed(code);
    }
    if (loaded === null) return authorizationFailed("not_paired");
    if (!sameBinding(loaded.secret, input, this.#apiOrigin)) {
      return authorizationFailed("invalid_binding");
    }
    if (loaded.secret.state === "prepared") {
      return authorizationFailed("pairing_incomplete");
    }
    if (
      loaded.secret.credentialExpiresAt <= this.#now()
    ) {
      return authorizationFailed("credential_unavailable");
    }
    if (loaded.secret.sessionExpiresAt <= this.#now()) {
      return authorizationFailed("session_unavailable");
    }
    return authorization(loaded.secret);
  }

  async #refreshSession(
    custody: GenerationalSecretCustody,
    input: HRARunnerPairingInput,
    initial: LoadedSecret & { readonly secret: PairedRunnerSecret },
  ): Promise<HRARunnerAuthorizationResult> {
    let loaded = initial;
    for (
      let attempt = 0;
      attempt < MAX_CUSTODY_RECONCILIATION_ATTEMPTS;
      attempt += 1
    ) {
      if (
        loaded.secret.sessionExpiresAt >
          this.#now() + MINIMUM_AUTHORIZATION_VALIDITY_MS &&
        loaded.secret.sessionAttempt === undefined
      ) {
        return authorization(loaded.secret);
      }
      if (loaded.secret.sessionAttempt === undefined) {
        const next = pairedRunnerSecretSchema.parse({
          ...loaded.secret,
          sessionAttempt: {
            idempotencyKey: createUuidV7(
              epochMsSchema.parse(this.#now()),
              this.#random.bytes(10),
            ),
          },
        });
        let pointer;
        try {
          pointer = await custody.compareAndSwap(
            loaded.generation,
            serializeSecret(next),
          );
        } catch (error: unknown) {
          return authorizationFailed(custodyFailureCode(error));
        }
        if (pointer === null) {
          try {
            const winner = await this.#read(custody);
            if (
              winner === null ||
              winner.secret.state !== "paired" ||
              !sameBinding(winner.secret, input, this.#apiOrigin)
            ) {
              return authorizationFailed("state_conflict");
            }
            loaded = { ...winner, secret: winner.secret };
            continue;
          } catch (error: unknown) {
            return authorizationFailed(custodyFailureCode(error));
          }
        }
        loaded = { generation: pointer.generation, secret: next };
      }

      const sessionIdempotencyKey =
        loaded.secret.sessionAttempt?.idempotencyKey;
      if (sessionIdempotencyKey === undefined) {
        return authorizationFailed("state_conflict");
      }
      const session = await this.#callCloud(
        async () =>
          await this.#cloud.startRunnerSession(
            loaded.secret.credential,
            sessionIdempotencyKey,
          ),
        "runner",
      );
      if (!session.ok) {
        await this.#mark(input, "blocked", session.code);
        return authorizationFailed(session.code);
      }
      if (
        session.data.expiresAt <=
          this.#now() + MINIMUM_AUTHORIZATION_VALIDITY_MS ||
        session.data.expiresAt > loaded.secret.credentialExpiresAt
      ) {
        await this.#mark(input, "blocked", "session_unavailable");
        return authorizationFailed("session_unavailable");
      }
      const refreshed = pairedRunnerSecretSchema.parse({
        ...loaded.secret,
        sessionId: session.data.sessionId,
        sessionExpiresAt: session.data.expiresAt,
        sessionAttempt: undefined,
      });
      let pointer;
      try {
        pointer = await custody.compareAndSwap(
          loaded.generation,
          serializeSecret(refreshed),
        );
      } catch (error: unknown) {
        return authorizationFailed(custodyFailureCode(error));
      }
      if (pointer !== null) {
        return authorization(refreshed);
      }
      try {
        const winner = await this.#read(custody);
        if (
          winner === null ||
          winner.secret.state !== "paired" ||
          !sameBinding(winner.secret, input, this.#apiOrigin)
        ) {
          return authorizationFailed("state_conflict");
        }
        loaded = { ...winner, secret: winner.secret };
      } catch (error: unknown) {
        return authorizationFailed(custodyFailureCode(error));
      }
    }
    return authorizationFailed("state_conflict");
  }

  async recoverAuthorization(
    inputValue: HRARunnerPairingInput,
    options: {
      /**
       * Set only during exclusive startup recovery. A missing pending slot
       * proves that no bearer was durably written and therefore no cloud call
       * could have started from that preparation.
       */
      readonly abandonMissingPending: boolean;
    },
  ): Promise<HRARunnerAuthorizationResult> {
    const input = parseInput(inputValue);
    if (input === null) return authorizationFailed("invalid_binding");
    const custody = this.#custody(input.destinationWorkspaceId);
    try {
      if ((await custody.inspectLegacyIdentityReconnect()).state === "required") {
        return authorizationFailed("custody_recovery_required");
      }
      await custody.recover({
        abandonMissingPending: options.abandonMissingPending,
      });
    } catch (error: unknown) {
      return authorizationFailed(custodyFailureCode(error));
    }

    let loaded: LoadedSecret | null;
    try {
      loaded = await this.#read(custody);
    } catch (error: unknown) {
      const code = error instanceof HRARunnerPairingError
        ? error.code
        : custodyFailureCode(error);
      return authorizationFailed(code);
    }
    if (loaded === null) return authorizationFailed("not_paired");
    if (!sameBinding(loaded.secret, input, this.#apiOrigin)) {
      return authorizationFailed("invalid_binding");
    }
    if (
      loaded.secret.state === "prepared" ||
      loaded.secret.credentialExpiresAt <=
        this.#now() + MINIMUM_AUTHORIZATION_VALIDITY_MS
    ) {
      const paired = await this.pair(input);
      if (!paired.ok) return { ok: false, error: paired.error };
      try {
        loaded = await this.#read(custody);
      } catch (error: unknown) {
        return authorizationFailed(custodyFailureCode(error));
      }
      if (
        loaded === null ||
        loaded.secret.state !== "paired" ||
        !sameBinding(loaded.secret, input, this.#apiOrigin)
      ) {
        return authorizationFailed("state_conflict");
      }
    }
    const recovered = await this.#refreshSession(custody, input, {
      ...loaded,
      secret: loaded.secret,
    });
    if (
      recovered.ok &&
      !(await this.#mark(input, "pairing", null))
    ) {
      return authorizationFailed("local_state_unavailable");
    }
    return recovered;
  }
}
