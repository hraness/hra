import type { Preset } from "../domain/presets";
import type { EffectiveRuntimeProfile } from "../domain/runtime-profile";
import type { AccountRateLimitResetOutcome } from "../domain/usage-metrics";
import type { CodexTurnStatus } from "../codex/protocol";
import type { CodexPluginCatalog } from "../codex/protocol";
import type {
  InteractionKind,
  InteractionResolution,
  LiveInteractionApprovalAuthority,
  ProviderInteractionAuthority,
} from "../domain/interactions";
import type { ProfileId, ProjectId, SessionId } from "../domain/values";

export type ProfileAuthority = {
  id: ProfileId;
  generation: number;
  codexHome: string;
  desktopUserData: string;
};

export type RuntimeStartReview = {
  readonly reviewId: string;
  readonly kind: "session_start" | "turn_start";
  readonly effectiveRuntimeProfile: EffectiveRuntimeProfile;
};

export type CodexAccountProjection = {
  signedIn: boolean;
  email?: string;
  plan?: string;
};

export type CodexLoginOutcome =
  | {
      status: "pending";
      loginId: string;
      verificationUrl?: string;
      userCode?: string;
    }
  | {
      status: "signed_in";
      account: CodexAccountProjection & { signedIn: true };
    };

export type ProjectionTextOmission = {
  originalUtf8Bytes: number;
  returnedUtf8Bytes: number;
  omittedUtf8Bytes: number;
};

export type CodexProjectedMessage = {
  role: "user" | "assistant";
  text: string;
  turnId?: string;
  clientId?: string;
  omission?: ProjectionTextOmission;
};

export type CodexTurnSummary = {
  id: string;
  status: "completed" | "interrupted" | "failed" | "inProgress";
  startedAt?: number;
  completedAt?: number;
  runtimeMs?: number;
  files: readonly string[];
  actions: readonly string[];
  omittedFiles: number;
  omittedActions: number;
};

export type CodexProjectionOmission = {
  hasMoreOlderTurns: boolean;
  returnedTurns: number;
  turnLimit: number;
  omittedMessages: number;
  truncatedMessages: number;
  /** Sorted unique recent-turn ids with unread provider items after bounded hydration. */
  unreadItemTurnIds: readonly string[];
  /** Sorted unique completed-turn ids missing exact first-user or final-assistant proof. */
  incompleteTurnIds: readonly string[];
};

export type CodexSessionProjection = {
  providerThreadId: string;
  title: string;
  status: "active" | "idle" | "terminal";
  projectRoot?: string;
  providerUpdatedAt?: number;
  activeTurnId?: string;
  messages?: readonly CodexProjectedMessage[];
  turnSummaries?: readonly CodexTurnSummary[];
  omission?: CodexProjectionOmission;
  turns?: readonly unknown[];
};

export type CodexSessionObservation = {
  readonly connectionId: string;
  readonly projection: CodexSessionProjection;
  /** False only when this exact client created the thread and is already subscribed. */
  readonly resumed: boolean;
};

export class CodexSessionObservationError extends Error {
  readonly reason: "resume_unavailable" | "thread_mismatch";

  constructor(reason: CodexSessionObservationError["reason"], options?: ErrorOptions) {
    super(
      reason === "thread_mismatch"
        ? "Codex resumed a different provider thread."
        : "Codex session observation is temporarily unavailable.",
      options,
    );
    this.name = "CodexSessionObservationError";
    this.reason = reason;
  }
}

export type CodexSessionPage = {
  readonly sessions: readonly CodexSessionProjection[];
  readonly nextCursor: string | null;
};

export interface CodexRuntimePort {
  login(input: { authority: ProfileAuthority; method: "browser" | "device_code"; signal: AbortSignal }): Promise<CodexLoginOutcome>;
  cancelLogin(input: { authority: ProfileAuthority; loginId: string; signal: AbortSignal }): Promise<{ status: "canceled" | "not_found" }>;
  logout(input: { authority: ProfileAuthority; signal: AbortSignal }): Promise<void>;
  readAccount(input: { authority: ProfileAuthority; signal: AbortSignal }): Promise<CodexAccountProjection>;
  readUsage(input: { authority: ProfileAuthority; signal: AbortSignal }): Promise<{ revision: number; observedAt: number; payload: unknown }>;
  consumeRateLimitReset(input: {
    authority: ProfileAuthority;
    idempotencyKey: string;
    signal: AbortSignal;
  }): Promise<AccountRateLimitResetOutcome>;
  listPlugins(input: { authority: ProfileAuthority; projectRoot?: string; forceRefetch: boolean; signal: AbortSignal }): Promise<CodexPluginCatalog>;
  listSessions(input: {
    authority: ProfileAuthority;
    limit: number;
    cursor?: string;
    signal: AbortSignal;
  }): Promise<CodexSessionPage>;
  reviewSessionStart(input: { authority: ProfileAuthority; projectRoot?: string; preset: Preset; fast: boolean; signal: AbortSignal }): Promise<RuntimeStartReview>;
  startSession(input: { authority: ProfileAuthority; projectRoot?: string; review: RuntimeStartReview; signal: AbortSignal }): Promise<CodexSessionProjection & { effectiveRuntimeProfile: EffectiveRuntimeProfile }>;
  observeSession(input: { authority: ProfileAuthority; providerThreadId: string; signal: AbortSignal }): Promise<CodexSessionObservation>;
  readSession(input: { authority: ProfileAuthority; providerThreadId: string; detail: boolean; signal: AbortSignal }): Promise<CodexSessionProjection>;
  reviewTurnStart(input: { authority: ProfileAuthority; providerThreadId: string; projectRoot?: string; preset: Preset; fast: boolean; signal: AbortSignal }): Promise<RuntimeStartReview>;
  startTurn(input: { authority: ProfileAuthority; providerThreadId: string; projectRoot?: string; review: RuntimeStartReview; message: string; clientMessageId: string; signal: AbortSignal }): Promise<{ turnId: string; status: CodexTurnStatus; effectiveRuntimeProfile: EffectiveRuntimeProfile }>;
  steer(input: { authority: ProfileAuthority; providerThreadId: string; activeTurnId: string; message: string; clientMessageId: string; signal: AbortSignal }): Promise<void>;
  interrupt(input: { authority: ProfileAuthority; providerThreadId: string; activeTurnId: string; signal: AbortSignal }): Promise<void>;
  rename(input: { authority: ProfileAuthority; providerThreadId: string; name: string; signal: AbortSignal }): Promise<void>;
  inspectTurn(input: { authority: ProfileAuthority; providerThreadId: string; turnId: string; signal: AbortSignal }): Promise<unknown>;
  inspectInteractionAuthority(input: {
    authority: ProfileAuthority;
    provider: ProviderInteractionAuthority;
    kind: InteractionKind;
    signal: AbortSignal;
  }): Promise<LiveInteractionApprovalAuthority>;
  validateInteractionResolution(input: {
    authority: ProfileAuthority;
    provider: ProviderInteractionAuthority;
    kind: InteractionKind;
    resolution: InteractionResolution;
    signal: AbortSignal;
  }): Promise<{ responseDigest: string }>;
  resolveInteraction(input: {
    authority: ProfileAuthority;
    provider: ProviderInteractionAuthority;
    kind: InteractionKind;
    resolution: InteractionResolution;
    deadlineAt: number;
    signal: AbortSignal;
  }): Promise<{ responseWritten: true }>;
  validateInteractionTimeout(input: {
    authority: ProfileAuthority;
    provider: ProviderInteractionAuthority;
    signal: AbortSignal;
  }): Promise<{ responseDigest: string }>;
  timeoutInteraction(input: {
    authority: ProfileAuthority;
    provider: ProviderInteractionAuthority;
    signal: AbortSignal;
  }): Promise<{ responseWritten: true }>;
  close(): Promise<void>;
}

export interface DesktopSwitchPort {
  switchAccount(input: { source?: ProfileAuthority; target: ProfileAuthority; idempotencyKey: string; signal: AbortSignal }): Promise<{ status: "applied" | "recovery_required"; activeAccount?: CodexAccountProjection; diagnostic?: string; idempotencyKey: string }>;
  recoverSwitch(input: { signal: AbortSignal }): Promise<unknown>;
  currentRecovery(): unknown;
}

export interface CloudControlPort {
  status(signal: AbortSignal): Promise<unknown>;
  sync(signal: AbortSignal): Promise<unknown>;
  isCompactProjectionRecoveryUnsettledForProfile(profileId: ProfileId): Promise<boolean>;
  isCompactProjectionRecoveryUnsettled(sessionPublicId: SessionId): Promise<boolean>;
  supersedeCompactProjectionRecoveryForProviderDeletion(sessionPublicId: SessionId): Promise<{ superseded: boolean }>;
  supersedeTerminalCompactProjectionRecoveries(): Promise<{ superseded: number }>;
  readCompactProjectionRecoveryReceipt?(input: {
    sessionPublicId: SessionId;
    idempotencyKey: string;
    signal: AbortSignal;
  }): Promise<
    | Readonly<{ status: "absent" | "conflict" }>
    | Readonly<{ status: "found"; result: unknown }>
  >;
  recoverCompactProjection(input: { sessionPublicId: SessionId; idempotencyKey: string; acknowledgeGap: true; signal: AbortSignal }): Promise<unknown>;
  auth(input: { email: string; code?: string; invite?: string; signal: AbortSignal }): Promise<unknown>;
  logout(signal: AbortSignal): Promise<void>;
  deleteAccount(input: { acknowledgeErasure: boolean; signal: AbortSignal }): Promise<unknown>;
  listDevices(signal: AbortSignal): Promise<unknown>;
  pairDevice(signal: AbortSignal): Promise<unknown>;
  acknowledgeNoAccountKeyHolders(signal: AbortSignal): Promise<unknown>;
  approveDevice(device: string, idempotencyKey: string, signal: AbortSignal): Promise<unknown>;
  revokeDevice(device: string, idempotencyKey: string, signal: AbortSignal): Promise<unknown>;
}

export type CompactProjectionRecoveryBlocker = Pick<
  CloudControlPort,
  | "isCompactProjectionRecoveryUnsettled"
  | "isCompactProjectionRecoveryUnsettledForProfile"
  | "supersedeCompactProjectionRecoveryForProviderDeletion"
  | "supersedeTerminalCompactProjectionRecoveries"
> & Pick<CloudControlPort, "readCompactProjectionRecoveryReceipt">;

export class UnavailableCodexRuntime implements CodexRuntimePort {
  #unavailable(): never { throw new Error("The Codex runtime is unavailable on this machine."); }
  login(): Promise<never> { return Promise.reject(this.#unavailable()); }
  cancelLogin(): Promise<never> { return Promise.reject(this.#unavailable()); }
  logout(): Promise<never> { return Promise.reject(this.#unavailable()); }
  readAccount(): Promise<never> { return Promise.reject(this.#unavailable()); }
  readUsage(): Promise<never> { return Promise.reject(this.#unavailable()); }
  consumeRateLimitReset(): Promise<never> { return Promise.reject(this.#unavailable()); }
  listPlugins(): Promise<never> { return Promise.reject(this.#unavailable()); }
  listSessions(): Promise<never> { return Promise.reject(this.#unavailable()); }
  reviewSessionStart(): Promise<never> { return Promise.reject(this.#unavailable()); }
  startSession(): Promise<never> { return Promise.reject(this.#unavailable()); }
  observeSession(): Promise<never> { return Promise.reject(this.#unavailable()); }
  readSession(): Promise<never> { return Promise.reject(this.#unavailable()); }
  reviewTurnStart(): Promise<never> { return Promise.reject(this.#unavailable()); }
  startTurn(): Promise<never> { return Promise.reject(this.#unavailable()); }
  steer(): Promise<never> { return Promise.reject(this.#unavailable()); }
  interrupt(): Promise<never> { return Promise.reject(this.#unavailable()); }
  rename(): Promise<never> { return Promise.reject(this.#unavailable()); }
  inspectTurn(): Promise<never> { return Promise.reject(this.#unavailable()); }
  inspectInteractionAuthority(): Promise<never> { return Promise.reject(this.#unavailable()); }
  validateInteractionResolution(): Promise<never> { return Promise.reject(this.#unavailable()); }
  resolveInteraction(): Promise<never> { return Promise.reject(this.#unavailable()); }
  validateInteractionTimeout(): Promise<never> { return Promise.reject(this.#unavailable()); }
  timeoutInteraction(): Promise<never> { return Promise.reject(this.#unavailable()); }
  async close(): Promise<void> {}
}

export class UnavailableCloudControl implements CloudControlPort {
  readonly #projectionRecoveryBlocker: CompactProjectionRecoveryBlocker;

  constructor(projectionRecoveryBlocker: CompactProjectionRecoveryBlocker) {
    this.#projectionRecoveryBlocker = projectionRecoveryBlocker;
  }

  #unavailable(): never { throw new Error("Cloud sync is not configured. Run `hra auth login` first."); }
  status(): Promise<unknown> { return Promise.resolve({ configured: false, signedIn: false }); }
  sync(): Promise<never> { return Promise.reject(this.#unavailable()); }
  isCompactProjectionRecoveryUnsettledForProfile(profileId: ProfileId): Promise<boolean> {
    return this.#projectionRecoveryBlocker.isCompactProjectionRecoveryUnsettledForProfile(profileId);
  }
  isCompactProjectionRecoveryUnsettled(sessionPublicId: SessionId): Promise<boolean> {
    return this.#projectionRecoveryBlocker.isCompactProjectionRecoveryUnsettled(sessionPublicId);
  }
  supersedeCompactProjectionRecoveryForProviderDeletion(
    sessionPublicId: SessionId,
  ): Promise<{ superseded: boolean }> {
    return this.#projectionRecoveryBlocker
      .supersedeCompactProjectionRecoveryForProviderDeletion(sessionPublicId);
  }
  supersedeTerminalCompactProjectionRecoveries(): Promise<{ superseded: number }> {
    return this.#projectionRecoveryBlocker.supersedeTerminalCompactProjectionRecoveries();
  }
  readCompactProjectionRecoveryReceipt(
    input: Parameters<NonNullable<CloudControlPort["readCompactProjectionRecoveryReceipt"]>>[0],
  ): ReturnType<NonNullable<CloudControlPort["readCompactProjectionRecoveryReceipt"]>> {
    return this.#projectionRecoveryBlocker.readCompactProjectionRecoveryReceipt?.(input)
      ?? Promise.resolve({ status: "absent" });
  }
  recoverCompactProjection(): Promise<never> { return Promise.reject(this.#unavailable()); }
  auth(): Promise<never> { return Promise.reject(this.#unavailable()); }
  logout(): Promise<never> { return Promise.reject(this.#unavailable()); }
  deleteAccount(): Promise<never> { return Promise.reject(this.#unavailable()); }
  listDevices(): Promise<never> { return Promise.reject(this.#unavailable()); }
  pairDevice(): Promise<never> { return Promise.reject(this.#unavailable()); }
  acknowledgeNoAccountKeyHolders(): Promise<never> {
    return Promise.reject(this.#unavailable());
  }
  approveDevice(device: string, idempotencyKey: string, signal: AbortSignal): Promise<never> {
    void device;
    void idempotencyKey;
    void signal;
    return Promise.reject(this.#unavailable());
  }
  revokeDevice(device: string, idempotencyKey: string, signal: AbortSignal): Promise<never> {
    void device;
    void idempotencyKey;
    void signal;
    return Promise.reject(this.#unavailable());
  }
}

export type SessionProjectUpdate = { sessionId: SessionId; projectId: ProjectId | null };
