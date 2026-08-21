import {
  HumanClientError,
  HumanSessionCoordinator,
  SecretCustodyError,
  humanAuthenticationSchema,
  humanAuthenticationSnapshotSchema,
  profileFromHumanAuthentication,
  loginWithDesktopPairing,
  type DesktopPairingVerification,
  type FetchLike,
  type HumanAuthenticationSnapshot,
  type HumanAuthentication,
  type HumanAuthenticationStore,
  type HumanProfile,
  type HumanRefreshDriver,
  type SecretCustodyRecoveryToken,
} from "@hraness/hra-human-client";
import {
  organizationIdSchema,
  organizationViewSchema,
  workspaceIdSchema,
  workspaceViewSchema,
  type CreateOrganizationResponse,
  type IdempotencyKey,
  type OrganizationView,
  type WorkspaceView,
} from "@hraness/agent-tasks-protocol";

import {
  cloudAttachmentAvailability,
  type CloudAttachmentAvailability,
  type HRACloudConfiguration,
} from "./config";
import {
  CloudWorkspaceClient,
  HRAHumanHttpTransport,
  type HumanOrganizationPage,
  type HumanWorkspacePage,
  type HRACloudFailure,
  type HRACloudSessionResult,
} from "./http-client";
import {
  HumanCredentialCustody,
  LegacyHumanAccountMetadataError,
  isHumanCredentialRecoveryPending,
  markHumanCredentialRecoveryPending,
  reconcileHumanAccountMetadata,
  type HumanCredentialClearAuthority,
  type HumanCredentialRecoveryCandidateInspection,
  type HumanScopeSelectionCustodyAuthority,
  type HumanAccountMetadataPort,
} from "./keychain-custody";

const MAX_SELECTION_PAGES = 1_000;

class RejectedPendingCredentialError extends Error {
  readonly token: SecretCustodyRecoveryToken;

  constructor(token: SecretCustodyRecoveryToken) {
    super("The pending human credential requires explicit recovery.");
    this.name = "RejectedPendingCredentialError";
    this.token = token;
  }
}

class HumanCredentialConfigurationError extends Error {
  readonly authentication: HumanAuthentication;

  constructor(authentication: HumanAuthentication) {
    super("The human credential belongs to another cloud configuration.");
    this.name = "HumanCredentialConfigurationError";
    this.authentication = authentication;
  }
}

function sameHumanAuthenticationSnapshot(
  left: HumanAuthenticationSnapshot,
  right: HumanAuthenticationSnapshot,
): boolean {
  return left.generation === right.generation
    && JSON.stringify(left.authentication) ===
      JSON.stringify(right.authentication);
}

export interface SafeDesktopPairingVerification {
  readonly comparisonCode: string;
  readonly verificationUri: string;
  readonly expiresAt: number;
}

export type HumanAccountSafeErrorCode =
  | "AUTHENTICATION_FAILED"
  | "AUTH_REFRESH_INDETERMINATE"
  | "CONFIGURATION_UNAVAILABLE"
  | "CREDENTIAL_RECOVERY_REQUIRED"
  | "NOT_FOUND"
  | "PROVISIONING_FAILED"
  | "PROVISIONING_IN_PROGRESS"
  | "SERVICE_UNAVAILABLE"
  | "SIGNED_OUT"
  | "VALIDATION_ERROR";

export interface HumanAccountSafeError {
  readonly code: HumanAccountSafeErrorCode;
  readonly message: string;
  readonly retryable: boolean;
}

interface SnapshotBase {
  readonly revision: number;
}

export type HumanAccountSnapshot =
  | (SnapshotBase & { readonly state: "initializing" })
  | (SnapshotBase & { readonly state: "signed_out" })
  | (SnapshotBase & {
      readonly state: "recovery_required";
      readonly reason: "credential_reconnect_required";
    })
  | (SnapshotBase & {
      readonly state: "signing_in";
      readonly verification?: SafeDesktopPairingVerification;
    })
  | (SnapshotBase & {
      readonly state: "signed_in";
      readonly profile: HumanProfile;
      readonly credentialGeneration: number;
    })
  | (SnapshotBase & {
      readonly state: "error";
      readonly error: HumanAccountSafeError;
      readonly profile?: HumanProfile;
    });

export type HumanAccountResult<Value> =
  | { readonly ok: true; readonly data: Value }
  | { readonly ok: false; readonly error: HumanAccountSafeError };

export type HumanCredentialReconnectResult =
  | {
      readonly ok: true;
      readonly snapshot: HumanAccountSnapshot;
    }
  | {
      readonly ok: false;
      readonly kind: "invalid_state";
      readonly currentRevision: number;
    }
  | {
      readonly ok: false;
      readonly kind: "revision_conflict";
      readonly currentRevision: number;
    }
  | {
      readonly ok: false;
      readonly kind: "failed";
      readonly error: HumanAccountSafeError;
    };

export type HumanCredentialRecoveryRetryResult =
  | {
      readonly ok: true;
      readonly snapshot: HumanAccountSnapshot;
    }
  | {
      readonly ok: false;
      readonly kind: "invalid_state" | "revision_conflict";
      readonly currentRevision: number;
    };

export interface HumanAccountServiceOptions {
  readonly configuration: HRACloudConfiguration;
  readonly metadata: HumanAccountMetadataPort;
  readonly credentials?: HumanCredentialCustody;
  readonly emit?: (snapshot: HumanAccountSnapshot) => void;
  readonly fetch?: FetchLike;
  readonly now?: () => number;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly openBrowser?: (url: string) => Promise<void>;
  readonly transport?: HRAHumanHttpTransport;
  readonly acceptAuthentication?: (
    authentication: HumanAuthentication,
  ) => void | Promise<void>;
  readonly withAuthenticationCommit?: <Value>(
    authentication: HumanAuthentication,
    commit: () => Promise<Value>,
  ) => Promise<Value>;
  readonly withAuthenticationAuthority?: <Value>(
    authority: Readonly<{
      apiUrl: string;
      userId: string;
      organizationId?: string;
    }>,
    operation: () => Promise<Value>,
  ) => Promise<Value>;
  readonly withSignOutCommit?: <Value>(
    authority: HumanCredentialClearAuthority,
    commit: () => Promise<Value>,
  ) => Promise<Value>;
}

function safeError(
  code: HumanAccountSafeErrorCode,
): HumanAccountSafeError {
  const definitions = {
    AUTHENTICATION_FAILED: [
      "Human authentication failed. Sign in again.",
      false,
    ],
    AUTH_REFRESH_INDETERMINATE: [
      "The sign-in refresh outcome is unknown. Sign in again.",
      false,
    ],
    CONFIGURATION_UNAVAILABLE: [
      "Cloud attachment is not configured on this installation.",
      false,
    ],
    CREDENTIAL_RECOVERY_REQUIRED: [
      "Human credential recovery is required before signing in.",
      false,
    ],
    NOT_FOUND: ["The requested cloud resource was not found.", false],
    PROVISIONING_FAILED: [
      "The organization could not be provisioned.",
      false,
    ],
    PROVISIONING_IN_PROGRESS: [
      "The organization is still being provisioned.",
      true,
    ],
    SERVICE_UNAVAILABLE: [
      "The cloud account service is temporarily unavailable.",
      true,
    ],
    SIGNED_OUT: ["No human account is signed in.", false],
    VALIDATION_ERROR: ["The cloud account request is invalid.", false],
  } as const satisfies Record<
    HumanAccountSafeErrorCode,
    readonly [string, boolean]
  >;
  const [message, retryable] = definitions[code];
  return { code, message, retryable };
}

function mapCloudFailure(
  failure: HRACloudFailure,
): HumanAccountSafeError {
  if (failure.code === "AUTHENTICATION_FAILED") {
    return safeError("AUTHENTICATION_FAILED");
  }
  if (failure.code === "AUTH_REFRESH_INDETERMINATE") {
    return safeError("AUTH_REFRESH_INDETERMINATE");
  }
  if (failure.code === "NOT_FOUND") return safeError("NOT_FOUND");
  if (failure.code === "PROVISIONING_FAILED") {
    return safeError("PROVISIONING_FAILED");
  }
  if (failure.code === "PROVISIONING_IN_PROGRESS") {
    return safeError("PROVISIONING_IN_PROGRESS");
  }
  if (failure.code === "VALIDATION_ERROR") {
    return safeError("VALIDATION_ERROR");
  }
  return safeError("SERVICE_UNAVAILABLE");
}

function mapSessionResult<Value>(
  result: HRACloudSessionResult<Value>,
): HumanAccountResult<Value> {
  if (result.ok) return result;
  if (result.kind === "operation") {
    return { ok: false, error: mapCloudFailure(result.error) };
  }
  const code = result.error.code === "SIGNED_OUT"
    ? "SIGNED_OUT"
    : result.error.code === "AUTHENTICATION_FAILED"
      ? "AUTHENTICATION_FAILED"
      : result.error.code === "AUTH_REFRESH_INDETERMINATE"
        ? "AUTH_REFRESH_INDETERMINATE"
        : "SERVICE_UNAVAILABLE";
  return { ok: false, error: safeError(code) };
}

function abortableSleep(
  sleep: (milliseconds: number) => Promise<void>,
  signal: AbortSignal,
): (milliseconds: number) => Promise<void> {
  return async (milliseconds) => {
    if (signal.aborted) throw new DOMException("The operation was aborted", "AbortError");
    await new Promise<void>((resolve, reject) => {
      const abort = (): void => {
        reject(new DOMException("The operation was aborted", "AbortError"));
      };
      signal.addEventListener("abort", abort, { once: true });
      void sleep(milliseconds).then(
        () => {
          signal.removeEventListener("abort", abort);
          resolve();
        },
        (error: unknown) => {
          signal.removeEventListener("abort", abort);
          reject(error instanceof Error ? error : new Error("Sleep failed."));
        },
      );
    });
  };
}

function abortableFetch(fetch: FetchLike, signal: AbortSignal): FetchLike {
  return async (input, init) => {
    if (signal.aborted) throw new DOMException("The operation was aborted", "AbortError");
    const requestSignal = init?.signal;
    return await fetch(input, {
      ...init,
      signal: requestSignal === undefined || requestSignal === null
        ? signal
        : AbortSignal.any([requestSignal, signal]),
    });
  };
}

class OriginBoundAuthenticationStore implements HumanAuthenticationStore {
  readonly #credentials: HumanCredentialCustody;
  readonly #onChanged: (
    snapshot: HumanAuthenticationSnapshot | null,
  ) => Promise<void>;
  readonly #onRecoveryRequired: (
    containmentConfirmed: boolean,
  ) => Promise<void>;
  readonly #origin: string;

  constructor(options: {
    readonly credentials: HumanCredentialCustody;
    readonly onChanged: (
      snapshot: HumanAuthenticationSnapshot | null,
    ) => Promise<void>;
    readonly onRecoveryRequired: (
      containmentConfirmed: boolean,
    ) => Promise<void>;
    readonly origin: string;
  }) {
    this.#credentials = options.credentials;
    this.#onChanged = options.onChanged;
    this.#onRecoveryRequired = options.onRecoveryRequired;
    this.#origin = options.origin;
  }

  async read(): Promise<HumanAuthenticationSnapshot | null> {
    const snapshot = await this.#credentials.read();
    if (
      snapshot !== null &&
      snapshot.authentication.apiUrl !== this.#origin
    ) {
      throw new Error("Human authentication belongs to another API origin.");
    }
    return snapshot;
  }

  async compareAndSwap(input: {
    readonly expectedGeneration: number;
    readonly next: HumanAuthenticationSnapshot;
  }): Promise<HumanAuthenticationSnapshot | null> {
    if (input.next.authentication.apiUrl !== this.#origin) return null;
    const replaced = await this.#credentials.compareAndSwap(input);
    if (replaced === null) return null;
    await this.#onChanged(replaced);
    return replaced;
  }

  async clear(input: { readonly expectedGeneration: number }): Promise<boolean> {
    return await this.#credentials.clear({
      ...input,
      onJournaled: async () => await this.#onChanged(null),
    });
  }

  async preserveForRecovery(input: {
    readonly expectedGeneration: number;
  }): Promise<boolean> {
    let preserved: boolean;
    try {
      preserved = await this.#credentials.preserveForRecovery(input);
    } catch (error: unknown) {
      const winner = await this.#newerWinner(input.expectedGeneration);
      if (winner) return false;
      await this.#onRecoveryRequired(false);
      throw error;
    }
    if (!preserved) {
      if (await this.#newerWinner(input.expectedGeneration)) return false;
      await this.#onRecoveryRequired(false);
      return false;
    }
    await this.#onRecoveryRequired(true);
    return true;
  }

  async #newerWinner(expectedGeneration: number): Promise<boolean> {
    try {
      const current = await this.#credentials.read();
      return current !== null && current.generation > expectedGeneration;
    } catch {
      return false;
    }
  }
}

/**
 * Optional human account attachment state machine. `startSignIn` returns
 * immediately; progress and completion are emitted as token-free snapshots.
 */
export class HumanAccountService {
  readonly #availability: CloudAttachmentAvailability;
  readonly #credentials: HumanCredentialCustody;
  readonly #emit: (snapshot: HumanAccountSnapshot) => void;
  readonly #fetch: FetchLike;
  readonly #metadata: HumanAccountMetadataPort;
  readonly #now: () => number;
  readonly #openBrowser: ((url: string) => Promise<void>) | undefined;
  readonly #session: HumanSessionCoordinator | null;
  readonly #sleep: (milliseconds: number) => Promise<void>;
  readonly #transport: HRAHumanHttpTransport | null;
  readonly #workspaceClient: CloudWorkspaceClient | null;
  readonly #acceptAuthentication:
    ((authentication: HumanAuthentication) => void | Promise<void>) | undefined;
  readonly #withAuthenticationCommit:
    HumanAccountServiceOptions["withAuthenticationCommit"];
  readonly #withAuthenticationAuthority:
    HumanAccountServiceOptions["withAuthenticationAuthority"];
  readonly #withSignOutCommit: HumanAccountServiceOptions["withSignOutCommit"];
  #loginAbort: AbortController | null = null;
  #loginGeneration = 0;
  #loginTask: Promise<void> | null = null;
  #mutationTail: Promise<void> = Promise.resolve();
  #refreshTail: Promise<void> = Promise.resolve();
  #activeMutations = 0;
  #activeRefreshes = 0;
  #admissionClosed = false;
  #credentialProjectionFence = 0;
  #recoveryGenerationFloor = -1;
  #sessionAdmissionContained = false;
  #snapshot: HumanAccountSnapshot = { state: "initializing", revision: 0 };

  constructor(options: HumanAccountServiceOptions) {
    this.#availability = cloudAttachmentAvailability(options.configuration);
    this.#acceptAuthentication = options.acceptAuthentication;
    this.#withAuthenticationAuthority = options.withAuthenticationAuthority;
    this.#withAuthenticationCommit = options.withAuthenticationCommit;
    this.#withSignOutCommit = options.withSignOutCommit;
    this.#credentials = options.credentials ??
      new HumanCredentialCustody({ metadata: options.metadata });
    this.#emit = options.emit ?? (() => undefined);
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#metadata = options.metadata;
    this.#now = options.now ?? Date.now;
    this.#openBrowser = options.openBrowser;
    this.#sleep = options.sleep ??
      (async (milliseconds) =>
        await new Promise((resolve) => setTimeout(resolve, milliseconds)));
    if (this.#availability.state === "enabled") {
      this.#transport = options.transport ??
        new HRAHumanHttpTransport({
          apiUrl: this.#availability.apiOrigin,
          fetch: this.#fetch,
        });
      const store = new OriginBoundAuthenticationStore({
        credentials: this.#credentials,
        origin: this.#availability.apiOrigin,
        onChanged: async (snapshot) =>
          await this.#sessionCredentialChanged(snapshot),
        onRecoveryRequired: async (containmentConfirmed) =>
          await this.#sessionCredentialRecoveryRequired(containmentConfirmed),
      });
      this.#session = new HumanSessionCoordinator({
        store,
        refresh: {
          refresh: async (input) => await this.#refreshForSession(input),
        },
      });
      this.#workspaceClient = new CloudWorkspaceClient({
        session: this.#session,
        transport: this.#transport,
      });
    } else {
      this.#transport = null;
      this.#session = null;
      this.#workspaceClient = null;
    }
  }

  snapshot(): HumanAccountSnapshot {
    return this.#snapshot;
  }

  hasActiveOperation(): boolean {
    return this.#loginTask !== null ||
      this.#activeMutations > 0 ||
      this.#activeRefreshes > 0;
  }

  /** Closes new sign-in, mutation, and refresh admission without cancelling work. */
  closeAdmission(): void {
    this.#admissionClosed = true;
    this.#session?.closeAdmission();
  }

  /** Joins every operation admitted before `closeAdmission()`. */
  async settled(): Promise<void> {
    for (;;) {
      const login = this.#loginTask;
      const mutations = this.#mutationTail;
      const refreshes = this.#refreshTail;
      await Promise.allSettled([
        login ?? Promise.resolve(),
        mutations,
        refreshes,
      ]);
      if (
        login === this.#loginTask
        && mutations === this.#mutationTail
        && refreshes === this.#refreshTail
        && !this.hasActiveOperation()
      ) {
        await this.#session?.settled();
        return;
      }
    }
  }

  availability(): CloudAttachmentAvailability {
    return this.#availability;
  }

  cloudWorkspaceClient(): CloudWorkspaceClient | null {
    return this.#workspaceClient;
  }

  /**
   * Gateway-internal bearer coordinator for compiled cloud transports. This
   * object is never part of a renderer snapshot or portable bridge contract.
   */
  gatewaySessionCoordinator(): HumanSessionCoordinator | null {
    return this.#session;
  }

  async initialize(): Promise<HumanAccountSnapshot> {
    return await this.#serialized(async () => await this.#reinspectCredentials());
  }

  async #reinspectCredentials(): Promise<HumanAccountSnapshot> {
    try {
      if (await isHumanCredentialRecoveryPending(this.#metadata)) {
        return this.#update({
          state: "recovery_required",
          reason: "credential_reconnect_required",
        });
      }
      const reconnect = await this.#credentials.inspectLegacyIdentityReconnect();
      if (reconnect.state === "required") {
        return this.#update({
          state: "recovery_required",
          reason: "credential_reconnect_required",
        });
      }
      try {
        return await this.#withRecoveryCandidateAuthority(
          async (candidate) => {
          await this.#credentials.recover({
            abandonMissingPending: false,
            ...(candidate === null ? {} : { candidate: candidate.token }),
          });
          const snapshot = await this.#credentials.read();
          if (
            snapshot !== null &&
            (
              this.#availability.state === "disabled" ||
              snapshot.authentication.apiUrl !== this.#availability.apiOrigin
            )
          ) {
            const profile = profileFromHumanAuthentication(
              snapshot.authentication,
              "keychain",
            );
            return this.#update({
              state: "error",
              error: safeError("CONFIGURATION_UNAVAILABLE"),
              profile,
            });
          }
          if (snapshot === null) {
            await reconcileHumanAccountMetadata(this.#metadata, null);
            return this.#update({ state: "signed_out" });
          }
          if (
            candidate !== null &&
            !sameHumanAuthenticationSnapshot(candidate.snapshot, snapshot)
          ) {
            throw new SecretCustodyError("concurrent_update");
          }
          const commit = async (): Promise<HumanAccountSnapshot> => {
            await reconcileHumanAccountMetadata(this.#metadata, snapshot);
            return this.#signedIn(snapshot);
          };
          return candidate === null
            ? await this.#commitAcceptedAuthentication(
              snapshot.authentication,
              commit,
            )
            : await commit();
          },
        );
      } catch (error: unknown) {
        if (error instanceof RejectedPendingCredentialError) {
          return this.#update({
            state: "recovery_required",
            reason: "credential_reconnect_required",
          });
        }
        if (error instanceof LegacyHumanAccountMetadataError) {
          return this.#update({
            state: "recovery_required",
            reason: "credential_reconnect_required",
          });
        }
        if (error instanceof HumanCredentialConfigurationError) {
          return this.#update({
            state: "error",
            error: safeError("CONFIGURATION_UNAVAILABLE"),
            profile: profileFromHumanAuthentication(
              error.authentication,
              "keychain",
            ),
          });
        }
        if (error instanceof SecretCustodyError) throw error;
        await reconcileHumanAccountMetadata(this.#metadata, null).catch(
          () => undefined,
        );
        return this.#update({
          state: "error",
          error: safeError("AUTHENTICATION_FAILED"),
        });
      }
    } catch (error: unknown) {
      if (
        error instanceof SecretCustodyError &&
        (error.reason === "pending_secret_missing" ||
          error.reason === "stale_generation")
      ) {
        return this.#update({
          state: "recovery_required",
          reason: "credential_reconnect_required",
        });
      }
      return this.#update({
        state: "error",
        error: safeError("CREDENTIAL_RECOVERY_REQUIRED"),
      });
    }
  }

  async requireLegacyCredentialReconnect(): Promise<HumanAccountSnapshot> {
    await this.cancelSignIn();
    return await this.#serialized(() =>
      this.#snapshot.state === "recovery_required"
        ? this.#snapshot
        : this.#update({
            state: "recovery_required",
            reason: "credential_reconnect_required",
          })
    );
  }

  async retryCredentialRecovery(
    expectedRevision: number,
  ): Promise<HumanCredentialRecoveryRetryResult> {
    await this.cancelSignIn();
    return await this.#serialized(async () => {
      if (this.#snapshot.revision !== expectedRevision) {
        return {
          ok: false,
          kind: "revision_conflict",
          currentRevision: this.#snapshot.revision,
        };
      }
      if (
        this.#snapshot.state !== "error" ||
        (
          this.#snapshot.error.code !== "CREDENTIAL_RECOVERY_REQUIRED" &&
          !this.#snapshot.error.retryable
        )
      ) {
        return {
          ok: false,
          kind: "invalid_state",
          currentRevision: this.#snapshot.revision,
        };
      }
      return { ok: true, snapshot: await this.#reinspectCredentials() };
    });
  }

  startSignIn(): HumanAccountSnapshot {
    if (this.#admissionClosed) return this.#snapshot;
    if (this.#snapshot.state === "initializing") return this.#snapshot;
    if (this.#availability.state === "disabled") {
      return this.#update({
        state: "error",
        error: safeError("CONFIGURATION_UNAVAILABLE"),
      });
    }
    if (this.#loginTask !== null) return this.#snapshot;
    if (this.#snapshot.state === "recovery_required") return this.#snapshot;
    if (this.#snapshot.state === "signed_in") {
      return this.#snapshot;
    }

    const generation = this.#loginGeneration + 1;
    this.#loginGeneration = generation;
    const controller = new AbortController();
    this.#loginAbort = controller;
    this.#update({ state: "signing_in" });
    const task = this.#performSignIn(generation, controller.signal);
    this.#loginTask = task;
    void task.finally(() => {
      if (this.#loginTask === task) this.#loginTask = null;
      if (this.#loginAbort === controller) this.#loginAbort = null;
    });
    return this.#snapshot;
  }

  async signInCompletion(): Promise<HumanAccountSnapshot> {
    await this.#loginTask;
    return this.#snapshot;
  }

  async cancelSignIn(): Promise<HumanAccountSnapshot> {
    const task = this.#loginTask;
    if (task === null) return this.#snapshot;
    this.#loginGeneration += 1;
    this.#loginAbort?.abort();
    await task.catch(() => undefined);
    if (
      this.#snapshot.state === "signed_in" ||
      this.#snapshot.state === "recovery_required"
    ) {
      return this.#snapshot;
    }
    return this.#update({ state: "signed_out" });
  }

  async signOut(): Promise<HumanAccountSnapshot> {
    await this.cancelSignIn();
    return await this.#serialized(async () => {
      let clearAuthority: HumanCredentialClearAuthority;
      try {
        clearAuthority = await this.#credentials.inspectClearAuthority();
      } catch {
        return this.#update({
          state: "error",
          error: safeError("SERVICE_UNAVAILABLE"),
        });
      }
      return await this.#commitSignOut(clearAuthority, async () => {
      try {
        // Sign-out removes interrupted pending state without ever installing it.
        if (!(await this.#credentials.clearAllIfSourceRevision(
          clearAuthority.sourceRevision,
        ))) {
          return this.#update({
            state: "error",
            error: safeError("SERVICE_UNAVAILABLE"),
          });
        }
        await reconcileHumanAccountMetadata(this.#metadata, null);
        return this.#update({ state: "signed_out" });
      } catch {
        return this.#update({
          state: "error",
          error: safeError("SERVICE_UNAVAILABLE"),
        });
      }
      });
    });
  }

  async confirmLegacyCredentialReconnect(
    expectedRevision: number,
    beforeQuarantine: () => Promise<void> = () => Promise.resolve(),
  ): Promise<HumanCredentialReconnectResult> {
    await this.cancelSignIn();
    return await this.#serialized(async () => {
      if (this.#snapshot.revision !== expectedRevision) {
        return {
          ok: false,
          kind: "revision_conflict",
          currentRevision: this.#snapshot.revision,
        };
      }
      if (this.#snapshot.state !== "recovery_required") {
        return {
          ok: false,
          kind: "invalid_state",
          currentRevision: this.#snapshot.revision,
        };
      }
      try {
        if (await isHumanCredentialRecoveryPending(this.#metadata)) {
          await beforeQuarantine();
          await this.#credentials.preserveMarkedCredentialForRecovery(
            this.#availability.state === "enabled"
              ? this.#availability.apiOrigin
              : undefined,
          );
          await reconcileHumanAccountMetadata(this.#metadata, null);
          return {
            ok: true,
            snapshot: this.#update({ state: "signed_out" }),
          };
        }
      } catch {
        return {
          ok: false,
          kind: "failed",
          error: safeError("SERVICE_UNAVAILABLE"),
        };
      }
      try {
        return await this.#withRecoveryCandidateAuthority(
          async (candidate) => {
            await beforeQuarantine();
            if (candidate !== null) {
              await this.#credentials.recover({
                abandonMissingPending: false,
                candidate: candidate.token,
                deferDeletingCleanup: true,
              });
            }
            await this.#credentials.quarantineLegacyIdentityPointers();
            const retained = await this.#credentials.read();
            if (retained === null) {
              await reconcileHumanAccountMetadata(this.#metadata, null, {
                replaceLegacyProfile: true,
              });
              return {
                ok: true as const,
                snapshot: this.#update({ state: "signed_out" }),
              };
            }
            if (
              candidate !== null &&
              !sameHumanAuthenticationSnapshot(candidate.snapshot, retained)
            ) {
              throw new SecretCustodyError("concurrent_update");
            }
            const commit = async (): Promise<HumanCredentialReconnectResult> => {
            await reconcileHumanAccountMetadata(this.#metadata, retained, {
              replaceLegacyProfile: true,
            });
            return {
              ok: true as const,
              snapshot: this.#signedIn(retained),
            };
            };
            return candidate === null
              ? await this.#commitAcceptedAuthentication(
                retained.authentication,
                commit,
              )
              : await commit();
          },
        );
      } catch (error: unknown) {
        if (error instanceof RejectedPendingCredentialError) {
          try {
            await beforeQuarantine();
            await this.#credentials.preserveRejectedPendingCandidate(
              error.token,
            );
            await this.#credentials.quarantineLegacyIdentityPointers();
            const retained = await this.#credentials.read();
            if (retained === null) {
              await reconcileHumanAccountMetadata(this.#metadata, null, {
                replaceLegacyProfile: true,
              });
              return {
                ok: true,
                snapshot: this.#update({ state: "signed_out" }),
              };
            }
            return await this.#commitAcceptedAuthentication(
              retained.authentication,
              async () => {
                await reconcileHumanAccountMetadata(this.#metadata, retained, {
                  replaceLegacyProfile: true,
                });
                return {
                  ok: true,
                  snapshot: this.#signedIn(retained),
                };
              },
            );
          } catch {
            // The exact pending pointer remains recoverable on the next retry.
          }
        }
        return {
          ok: false,
          kind: "failed",
          error: safeError("SERVICE_UNAVAILABLE"),
        };
      }
    });
  }

  async listOrganizations(
    input: { readonly cursor?: string; readonly limit?: number } = {},
  ): Promise<HumanAccountResult<HumanOrganizationPage>> {
    if (this.#session === null || this.#transport === null) {
      return {
        ok: false,
        error: safeError("CONFIGURATION_UNAVAILABLE"),
      };
    }
    const revision = this.#snapshot.revision;
    const result = await this.#session.execute(
      async (token) => await this.#transport!.listOrganizations(token, input),
    );
    this.#projectSessionCustodyFailure(result, revision);
    return mapSessionResult(result);
  }

  async createOrganization(input: {
    readonly name: string;
    readonly idempotencyKey: IdempotencyKey;
  }): Promise<HumanAccountResult<CreateOrganizationResponse>> {
    if (this.#session === null || this.#transport === null) {
      return {
        ok: false,
        error: safeError("CONFIGURATION_UNAVAILABLE"),
      };
    }
    const revision = this.#snapshot.revision;
    const result = await this.#session.execute(
      async (token) => await this.#transport!.createOrganization(token, input),
    );
    this.#projectSessionCustodyFailure(result, revision);
    return mapSessionResult(result);
  }

  async selectOrganization(
    organizationIdValue: string,
  ): Promise<HumanAccountResult<HumanProfile>> {
    const parsed = organizationIdSchema.safeParse(organizationIdValue);
    if (!parsed.success) {
      return { ok: false, error: safeError("VALIDATION_ERROR") };
    }
    const found = await this.#findOrganization(parsed.data);
    if (!found.ok) return found;
    return await this.#bindOrganization(found.data);
  }

  async listWorkspaces(
    input: { readonly cursor?: string; readonly limit?: number } = {},
  ): Promise<HumanAccountResult<HumanWorkspacePage>> {
    if (this.#session === null || this.#transport === null) {
      return {
        ok: false,
        error: safeError("CONFIGURATION_UNAVAILABLE"),
      };
    }
    const revision = this.#snapshot.revision;
    const result = await this.#session.execute(
      async (token) =>
        await this.#transport!.listAdministrativeWorkspaces(token, input),
    );
    this.#projectSessionCustodyFailure(result, revision);
    return mapSessionResult(result);
  }

  async selectWorkspace(
    workspaceIdValue: string,
  ): Promise<HumanAccountResult<HumanProfile>> {
    const parsed = workspaceIdSchema.safeParse(workspaceIdValue);
    if (!parsed.success) {
      return { ok: false, error: safeError("VALIDATION_ERROR") };
    }
    const found = await this.#findWorkspace(parsed.data);
    if (!found.ok) return found;
    return await this.#bindWorkspace(found.data);
  }

  async #performSignIn(
    generation: number,
    signal: AbortSignal,
  ): Promise<void> {
    if (this.#availability.state === "disabled") return;
    let pairingCommitPending = false;
    try {
      const authenticated = await loginWithDesktopPairing({
        apiUrl: this.#availability.apiOrigin,
        expectedWebOrigin: this.#availability.webOrigin,
        fetch: abortableFetch(this.#fetch, signal),
        now: this.#now,
        sleep: abortableSleep(this.#sleep, signal),
        onVerification: (verification) => {
          this.#verification(generation, signal, verification);
        },
        ...(this.#openBrowser === undefined
          ? {}
          : { openBrowser: this.#openBrowser }),
      });
      if (signal.aborted || generation !== this.#loginGeneration) return;
      const authentication = humanAuthenticationSchema.parse({
        version: 2,
        apiUrl: this.#availability.apiOrigin,
        ...authenticated,
      });
      await this.#commitAcceptedAuthentication(authentication, async () => {
        if (signal.aborted || generation !== this.#loginGeneration) return;
        await markHumanCredentialRecoveryPending(this.#metadata);
        pairingCommitPending = true;
        if (signal.aborted || generation !== this.#loginGeneration) {
          pairingCommitPending = !(await this.#containCancelledPairing(null));
          return;
        }
        const snapshot = await this.#credentials.write(authentication);
        if (signal.aborted || generation !== this.#loginGeneration) {
          pairingCommitPending = !(await this.#containCancelledPairing(snapshot));
          return;
        }
        await this.#reopenContainedSessionForFreshPairing(snapshot);
        await reconcileHumanAccountMetadata(this.#metadata, snapshot);
        pairingCommitPending = false;
        this.#signedIn(snapshot);
      });
    } catch (error) {
      if (pairingCommitPending) {
        this.#projectRecoveryRequired();
        return;
      }
      if (signal.aborted || generation !== this.#loginGeneration) return;
      const code = error instanceof HumanClientError &&
          error.code === "AUTHENTICATION_FAILED"
        ? "AUTHENTICATION_FAILED"
        : error instanceof HumanClientError && error.code === "VALIDATION_ERROR"
          ? "VALIDATION_ERROR"
          : "SERVICE_UNAVAILABLE";
      this.#update({ state: "error", error: safeError(code) });
    }
  }

  #projectSessionCustodyFailure(
    result: HRACloudSessionResult<unknown>,
    expectedRevision: number,
  ): void {
    if (
      result.ok || result.kind !== "session" ||
      result.error.code !== "SERVICE_UNAVAILABLE" ||
      this.#snapshot.revision !== expectedRevision ||
      this.#snapshot.state !== "signed_in"
    ) {
      return;
    }
    this.#update({
      state: "error",
      error: safeError("SERVICE_UNAVAILABLE"),
      profile: this.#snapshot.profile,
    });
  }

  async #containCancelledPairing(
    snapshot: HumanAuthenticationSnapshot | null,
  ): Promise<boolean> {
    try {
      if (
        snapshot !== null &&
        !(await this.#credentials.preserveForRecovery({
          expectedGeneration: snapshot.generation,
        }))
      ) {
        this.#projectRecoveryRequired();
        return false;
      }
      await reconcileHumanAccountMetadata(this.#metadata, null);
      return true;
    } catch {
      this.#projectRecoveryRequired();
      return false;
    }
  }

  async #reopenContainedSessionForFreshPairing(
    snapshot: HumanAuthenticationSnapshot,
  ): Promise<void> {
    if (!this.#sessionAdmissionContained) return;
    const session = this.#session;
    if (session === null) {
      throw new Error("Human session admission is unavailable.");
    }
    // Recovery can be projected from inside the old execute callback. Wait
    // outside account mutation locks for that operation to unwind, then prove
    // the fresh pairing is still the exact live credential before reopening.
    await session.settled();
    const current = await this.#credentials.read();
    if (
      this.#admissionClosed || current === null ||
      !sameHumanAuthenticationSnapshot(current, snapshot) ||
      !session.reopenAdmission()
    ) {
      throw new Error("Human session admission could not reopen safely.");
    }
    this.#sessionAdmissionContained = false;
  }

  #projectRecoveryRequired(): HumanAccountSnapshot {
    this.#sessionAdmissionContained = true;
    this.#session?.closeAdmission();
    return this.#snapshot.state === "recovery_required"
      ? this.#snapshot
      : this.#update({
          state: "recovery_required",
          reason: "credential_reconnect_required",
        });
  }

  #verification(
    generation: number,
    signal: AbortSignal,
    verification: DesktopPairingVerification,
  ): void {
    if (signal.aborted || generation !== this.#loginGeneration) return;
    this.#update({
      state: "signing_in",
      verification: {
        comparisonCode: verification.comparisonCode,
        verificationUri: verification.verificationUri,
        expiresAt: verification.expiresAt,
      },
    });
  }

  async #findOrganization(
    organizationId: string,
  ): Promise<HumanAccountResult<OrganizationView>> {
    let cursor: string | undefined;
    const seen = new Set<string>();
    for (let page = 0; page < MAX_SELECTION_PAGES; page += 1) {
      const result = await this.listOrganizations({
        ...(cursor === undefined ? {} : { cursor }),
        limit: 100,
      });
      if (!result.ok) return result;
      const found = result.data.organizations.find(
        (organization) => organization.id === organizationId,
      );
      if (found !== undefined) {
        return { ok: true, data: organizationViewSchema.parse(found) };
      }
      if (result.data.cursor === null) {
        return { ok: false, error: safeError("NOT_FOUND") };
      }
      if (seen.has(result.data.cursor)) {
        return { ok: false, error: safeError("SERVICE_UNAVAILABLE") };
      }
      seen.add(result.data.cursor);
      cursor = result.data.cursor;
    }
    return { ok: false, error: safeError("SERVICE_UNAVAILABLE") };
  }

  async #findWorkspace(
    workspaceId: string,
  ): Promise<HumanAccountResult<WorkspaceView>> {
    let cursor: string | undefined;
    const seen = new Set<string>();
    for (let page = 0; page < MAX_SELECTION_PAGES; page += 1) {
      const result = await this.listWorkspaces({
        ...(cursor === undefined ? {} : { cursor }),
        limit: 100,
      });
      if (!result.ok) return result;
      const found = result.data.workspaces.find(
        (workspace) => workspace.id === workspaceId,
      );
      if (found !== undefined) {
        return { ok: true, data: workspaceViewSchema.parse(found) };
      }
      if (result.data.cursor === null) {
        return { ok: false, error: safeError("NOT_FOUND") };
      }
      if (seen.has(result.data.cursor)) {
        return { ok: false, error: safeError("SERVICE_UNAVAILABLE") };
      }
      seen.add(result.data.cursor);
      cursor = result.data.cursor;
    }
    return { ok: false, error: safeError("SERVICE_UNAVAILABLE") };
  }

  async #bindOrganization(
    organization: OrganizationView,
  ): Promise<HumanAccountResult<HumanProfile>> {
    return await this.#selectScope(organization);
  }

  async #bindWorkspace(
    workspace: WorkspaceView,
  ): Promise<HumanAccountResult<HumanProfile>> {
    let current: HumanAuthenticationSnapshot | null;
    try {
      current = await this.#credentials.read();
    } catch {
      return { ok: false, error: safeError("SERVICE_UNAVAILABLE") };
    }
    if (current === null) {
      return { ok: false, error: safeError("SIGNED_OUT") };
    }
    if (workspace.organizationId !== current.authentication.organization.id) {
      return { ok: false, error: safeError("NOT_FOUND") };
    }
    return await this.#selectScope(current.authentication.organization, workspace);
  }

  async #selectScope(
    organization: OrganizationView,
    workspace?: WorkspaceView,
  ): Promise<HumanAccountResult<HumanProfile>> {
    if (this.#transport === null || this.#session === null) {
      return {
        ok: false,
        error: safeError("CONFIGURATION_UNAVAILABLE"),
      };
    }
    try {
      return await this.#serialized(async () => {
        let initialAuthority: HumanAuthenticationSnapshot | null;
        try {
          initialAuthority = await this.#credentials.read();
        } catch {
          return { ok: false, error: safeError("SERVICE_UNAVAILABLE") };
        }
        if (initialAuthority === null) {
          return { ok: false, error: safeError("SIGNED_OUT") };
        }
        let executionAuthority: HumanAuthenticationSnapshot | null = null;
        let custodyAuthority: HumanScopeSelectionCustodyAuthority | null = null;
        let serverMayHaveRotated = false;
        let selectionCandidate: HumanAuthenticationSnapshot | undefined;
        const containExactTransition = async (): Promise<void> => {
          if (executionAuthority === null || custodyAuthority === null) {
            this.#projectRecoveryRequired();
            return;
          }
          await this.#containIndeterminateScopeSelection(
            executionAuthority,
            custodyAuthority,
            selectionCandidate,
          );
        };
        try {
          return await this.#withAcceptedAuthenticationAuthority(
            {
              apiUrl: initialAuthority.authentication.apiUrl,
              userId: initialAuthority.authentication.user.id,
              organizationId: organization.id,
            },
            async () => {
              const transition = await this.#session!
                .withExclusiveTransition<HumanAccountResult<HumanProfile>>(
                async (transitionSession) => {
                  const selected = await transitionSession.execute(
                    async (token, attemptAuthority) => {
                      if (
                        token !== attemptAuthority.authentication.accessToken
                      ) {
                        throw new Error("Selection bearer authority mismatch.");
                      }
                      const inspected = await this.#credentials
                        .inspectScopeSelectionAuthority(attemptAuthority);
                      await markHumanCredentialRecoveryPending(this.#metadata);
                      // Refresh can replace A with B before a replay. Bind the
                      // recovery evidence to the exact bearer snapshot used by
                      // each POST, and only then allow the server to rotate it.
                      executionAuthority = attemptAuthority;
                      custodyAuthority = inspected;
                      selectionCandidate = undefined;
                      serverMayHaveRotated = true;
                      return await this.#transport!.selectHumanScope(token, {
                        organizationId: organization.id,
                        ...(workspace === undefined
                          ? {}
                          : { workspaceId: workspace.id }),
                      });
                    },
                  );
                  if (!selected.ok) {
                    if (!serverMayHaveRotated) return mapSessionResult(selected);
                    if (
                      selected.error.code === "SERVICE_UNAVAILABLE" ||
                      selected.error.code === "AUTH_REFRESH_INDETERMINATE"
                    ) {
                      await containExactTransition();
                    } else if (
                      executionAuthority === null ||
                      !(await this.#clearDefinitiveScopeSelectionIntent(
                        executionAuthority,
                        selected.kind === "session",
                      ))
                    ) {
                      await containExactTransition();
                    }
                    return mapSessionResult(selected);
                  }
                  if (executionAuthority === null) {
                    this.#projectRecoveryRequired();
                    return {
                      ok: false,
                      error: safeError("SERVICE_UNAVAILABLE"),
                    };
                  }
                  const nextAuthentication = humanAuthenticationSchema.safeParse({
                    version: 2,
                    apiUrl: executionAuthority.authentication.apiUrl,
                    ...selected.data,
                  });
                  if (
                    !nextAuthentication.success ||
                    nextAuthentication.data.user.id !==
                      executionAuthority.authentication.user.id ||
                    nextAuthentication.data.organization.id !== organization.id ||
                    (workspace === undefined
                      ? nextAuthentication.data.workspace !== undefined
                      : nextAuthentication.data.workspace?.id !== workspace.id ||
                        nextAuthentication.data.workspace.organizationId !==
                          organization.id)
                  ) {
                    await containExactTransition();
                    return {
                      ok: false,
                      error: safeError("AUTHENTICATION_FAILED"),
                    };
                  }
                  selectionCandidate = humanAuthenticationSnapshotSchema.parse({
                    generation: executionAuthority.generation + 1,
                    authentication: nextAuthentication.data,
                  });
                  let current: HumanAuthenticationSnapshot | null;
                  try {
                    current = await this.#credentials.read();
                  } catch {
                    await containExactTransition();
                    return {
                      ok: false,
                      error: safeError("SERVICE_UNAVAILABLE"),
                    };
                  }
                  if (
                    current === null ||
                    !sameHumanAuthenticationSnapshot(
                      current,
                      executionAuthority,
                    )
                  ) {
                    await containExactTransition();
                    return {
                      ok: false,
                      error: safeError("AUTHENTICATION_FAILED"),
                    };
                  }
                  const next = selectionCandidate;
                  try {
                    return await this.#commitAcceptedAuthentication(
                      next.authentication,
                      async () => {
                        const replaced = await this.#credentials.compareAndSwap({
                          expectedGeneration: executionAuthority!.generation,
                          next,
                        });
                        if (replaced === null) {
                          await containExactTransition();
                          return {
                            ok: false,
                            error: safeError("SERVICE_UNAVAILABLE"),
                          };
                        }
                        try {
                          await reconcileHumanAccountMetadata(
                            this.#metadata,
                            replaced,
                          );
                        } catch {
                          selectionCandidate = replaced;
                          await containExactTransition();
                          return {
                            ok: false,
                            error: safeError("SERVICE_UNAVAILABLE"),
                          };
                        }
                        this.#signedIn(replaced);
                        return {
                          ok: true,
                          data: profileFromHumanAuthentication(
                            replaced.authentication,
                            "keychain",
                          ),
                        };
                      },
                      true,
                    );
                  } catch {
                    await containExactTransition();
                    return {
                      ok: false,
                      error: safeError("SERVICE_UNAVAILABLE"),
                    };
                  }
                },
              );
              return transition.ok
                ? transition.data
                : { ok: false, error: safeError(transition.error.code) };
            },
          );
        } catch {
          if (serverMayHaveRotated) {
            await containExactTransition();
          }
          return { ok: false, error: safeError("SERVICE_UNAVAILABLE") };
        }
      });
    } catch {
      return { ok: false, error: safeError("SERVICE_UNAVAILABLE") };
    }
  }

  /**
   * Scope selection rotates and revokes the exact server session used for the
   * request. Preserve that transition's values as immutable evidence. A newer
   * writer is left byte-for-byte live but never adopted, and bearer admission
   * remains closed until explicit recovery establishes its authority.
   */
  async #containIndeterminateScopeSelection(
    authority: HumanAuthenticationSnapshot,
    custodyAuthority: HumanScopeSelectionCustodyAuthority,
    candidate?: HumanAuthenticationSnapshot,
  ): Promise<void> {
    try {
      if (
        custodyAuthority.generation !== authority.generation ||
        custodyAuthority.apiUrl !== authority.authentication.apiUrl ||
        custodyAuthority.userId !== authority.authentication.user.id
      ) {
        throw new SecretCustodyError("concurrent_update");
      }
      const contained = await this.#credentials.preserveIndeterminateScopeSession({
        authority: custodyAuthority,
        ...(candidate === undefined ? {} : { candidate }),
      });
      if (contained.state === "newer_winner") {
        // Another writer owns a newer live generation, so this transition may
        // neither quarantine it nor infer that it survived the server-side
        // revocation. Keep its bytes/pointer intact but close bearer admission
        // until explicit recovery can establish its authority.
        await markHumanCredentialRecoveryPending(this.#metadata);
        this.#projectRecoveryRequired();
        return;
      }
      await reconcileHumanAccountMetadata(this.#metadata, null);
      this.#update({ state: "signed_out" });
      return;
    } catch {
      // If exact preservation cannot be proven, close bearer admission and
      // require explicit recovery/restart. Never delete or reinterpret values.
    }
    await markHumanCredentialRecoveryPending(this.#metadata).catch(
      () => undefined,
    );
    this.#projectRecoveryRequired();
  }

  async #clearDefinitiveScopeSelectionIntent(
    authority: HumanAuthenticationSnapshot,
    sessionEnded: boolean,
  ): Promise<boolean> {
    try {
      const current = await this.#credentials.read();
      if (sessionEnded) {
        if (current !== null) return false;
        await reconcileHumanAccountMetadata(this.#metadata, null);
        return true;
      }
      if (
        current === null ||
        !sameHumanAuthenticationSnapshot(current, authority)
      ) {
        return false;
      }
      await reconcileHumanAccountMetadata(this.#metadata, current);
      return true;
    } catch {
      return false;
    }
  }

  async #refreshForSession(
    input: Parameters<HumanRefreshDriver["refresh"]>[0],
  ): ReturnType<HumanRefreshDriver["refresh"]> {
    return await this.#serializedRefresh(async () => {
      if (this.#transport === null) {
        return { ok: false, outcome: "indeterminate" };
      }
      let current: HumanAuthenticationSnapshot | null;
      try {
        current = await this.#credentials.read();
      } catch {
        return { ok: false, outcome: "indeterminate" };
      }
      if (current === null) {
        return { ok: false, outcome: "authentication_failed" };
      }
      if (current.authentication.refreshToken !== input.refreshToken) {
        return {
          ok: true,
          data: {
            accessToken: current.authentication.accessToken,
            refreshToken: current.authentication.refreshToken,
            user: current.authentication.user,
            organization: current.authentication.organization,
            workspace: current.authentication.workspace,
          },
        };
      }
      return await this.#transport.refresh(input.refreshToken);
    });
  }

  async #sessionCredentialChanged(
    snapshot: HumanAuthenticationSnapshot | null,
  ): Promise<void> {
    if (this.#snapshot.state === "recovery_required") return;
    const fence = this.#credentialProjectionFence;
    if (
      snapshot !== null &&
      this.#snapshot.state !== "signed_in" &&
      snapshot.generation <= this.#recoveryGenerationFloor
    ) {
      return;
    }
    if (snapshot === null) {
      await reconcileHumanAccountMetadata(this.#metadata, null).catch(
        () => undefined,
      );
      if (
        fence !== this.#credentialProjectionFence ||
        this.snapshot().state === "recovery_required"
      ) return;
      this.#update({ state: "signed_out" });
    } else {
      try {
        // Session coordinator refreshes can arrive while a session-sync cloud
        // request already owns its exclusive transition. They preserve the
        // authenticated principal, so validate synchronously without trying
        // to reacquire the authority-transition lease.
        await this.#acceptAuthentication?.(snapshot.authentication);
        await reconcileHumanAccountMetadata(this.#metadata, snapshot).catch(
          () => undefined,
        );
        if (
          fence !== this.#credentialProjectionFence ||
          this.snapshot().state === "recovery_required"
        ) {
          if (this.#snapshot.state === "signed_out") {
            await reconcileHumanAccountMetadata(this.#metadata, null).catch(
              () => undefined,
            );
          }
          return;
        }
        this.#signedIn(snapshot);
      } catch {
        await reconcileHumanAccountMetadata(this.#metadata, null).catch(
          () => undefined,
        );
        this.#update({
          state: "error",
          error: safeError("AUTHENTICATION_FAILED"),
        });
        return;
      }
    }
  }

  async #sessionCredentialRecoveryRequired(
    containmentConfirmed: boolean,
  ): Promise<void> {
    if (containmentConfirmed) {
      await reconcileHumanAccountMetadata(this.#metadata, null).catch(
        () => undefined,
      );
    } else {
      await markHumanCredentialRecoveryPending(this.#metadata).catch(
        () => undefined,
      );
    }
    this.#projectRecoveryRequired();
  }

  #signedIn(snapshot: HumanAuthenticationSnapshot): HumanAccountSnapshot {
    return this.#update({
      state: "signed_in",
      profile: profileFromHumanAuthentication(
        snapshot.authentication,
        "keychain",
      ),
      credentialGeneration: snapshot.generation,
    });
  }

  #update(
    next:
      | Omit<Extract<HumanAccountSnapshot, { state: "signed_out" }>, "revision">
      | Omit<Extract<HumanAccountSnapshot, { state: "initializing" }>, "revision">
      | Omit<Extract<HumanAccountSnapshot, { state: "recovery_required" }>, "revision">
      | Omit<Extract<HumanAccountSnapshot, { state: "signing_in" }>, "revision">
      | Omit<Extract<HumanAccountSnapshot, { state: "signed_in" }>, "revision">
      | Omit<Extract<HumanAccountSnapshot, { state: "error" }>, "revision">,
  ): HumanAccountSnapshot {
    if (
      next.state === "recovery_required" &&
      this.#snapshot.state !== "recovery_required"
    ) {
      if (this.#snapshot.state === "signed_in") {
        this.#recoveryGenerationFloor = Math.max(
          this.#recoveryGenerationFloor,
          this.#snapshot.credentialGeneration,
        );
      }
    }
    this.#credentialProjectionFence += 1;
    this.#snapshot = {
      ...next,
      revision: this.#snapshot.revision + 1,
    };
    this.#emit(this.#snapshot);
    return this.#snapshot;
  }

  async #commitAcceptedAuthentication<Value>(
    authentication: HumanAuthentication,
    commit: () => Promise<Value>,
    authorityAlreadyHeld = false,
  ): Promise<Value> {
    await this.#acceptAuthentication?.(authentication);
    if (authorityAlreadyHeld) return await commit();
    const withCommit = this.#withAuthenticationCommit;
    return withCommit === undefined
      ? await commit()
      : await withCommit(authentication, commit);
  }

  async #withRecoveryCandidateAuthority<Value>(
    operation: (
      candidate: Extract<
        HumanCredentialRecoveryCandidateInspection,
        { state: "valid" }
      > | null,
    ) => Promise<Value>,
  ): Promise<Value> {
    const candidate = await this.#credentials
      .inspectRecoveryAuthenticationCandidate();
    if (candidate.state === "product_invalid") {
      if (candidate.role === "pending") {
        throw new RejectedPendingCredentialError(candidate.token);
      }
      return await operation(null);
    }
    if (candidate.state !== "valid") return await operation(null);
    const authentication = candidate.snapshot.authentication;
    if (this.#availability.state === "disabled") {
      throw new HumanCredentialConfigurationError(authentication);
    }
    if (authentication.apiUrl !== this.#availability.apiOrigin) {
      if (candidate.role === "pending") {
        throw new RejectedPendingCredentialError(candidate.token);
      }
      throw new HumanCredentialConfigurationError(authentication);
    }
    let operationStarted = false;
    try {
      return await this.#commitAcceptedAuthentication(
        authentication,
        async () => {
          operationStarted = true;
          return await operation(candidate);
        },
      );
    } catch (error: unknown) {
      if (!operationStarted && candidate.role === "pending") {
        throw new RejectedPendingCredentialError(candidate.token);
      }
      throw error;
    }
  }

  async #withAcceptedAuthenticationAuthority<Value>(
    authority: Readonly<{
      apiUrl: string;
      userId: string;
      organizationId?: string;
    }>,
    operation: () => Promise<Value>,
  ): Promise<Value> {
    const withAuthority = this.#withAuthenticationAuthority;
    return withAuthority === undefined
      ? await operation()
      : await withAuthority(authority, operation);
  }

  async #commitSignOut<Value>(
    authority: HumanCredentialClearAuthority,
    commit: () => Promise<Value>,
  ): Promise<Value> {
    const withCommit = this.#withSignOutCommit;
    return withCommit === undefined
      ? await commit()
      : await withCommit(authority, commit);
  }

  async #serialized<Value>(operation: () => Promise<Value> | Value): Promise<Value> {
    if (this.#admissionClosed) {
      throw new Error("Human account admission is closed.");
    }
    this.#activeMutations += 1;
    let release = (): void => undefined;
    const previous = this.#mutationTail;
    this.#mutationTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
      this.#activeMutations -= 1;
    }
  }

  async #serializedRefresh<Value>(
    operation: () => Promise<Value>,
  ): Promise<Value> {
    if (this.#admissionClosed) {
      throw new Error("Human account refresh admission is closed.");
    }
    this.#activeRefreshes += 1;
    let release = (): void => undefined;
    const previous = this.#refreshTail;
    this.#refreshTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
      this.#activeRefreshes -= 1;
    }
  }
}

/**
 * Root integration factory. The returned client is null when configuration is
 * absent or invalid, and constructing the disabled service performs no network.
 */
export function createHumanAccountRuntime(
  options: HumanAccountServiceOptions,
): Readonly<{
  account: HumanAccountService;
  availability: CloudAttachmentAvailability;
  cloud: CloudWorkspaceClient | null;
  session: HumanSessionCoordinator | null;
}> {
  const account = new HumanAccountService(options);
  return {
    account,
    availability: account.availability(),
    cloud: account.cloudWorkspaceClient(),
    session: account.gatewaySessionCoordinator(),
  };
}
