import {
  HumanClientError,
  HumanSessionCoordinator,
  SecretCustodyError,
  humanAuthenticationSchema,
  humanAuthenticationSnapshotSchema,
  profileFromHumanAuthentication,
  refreshedHumanAuthentication,
  loginWithWorkosDevice,
  type DeviceVerification,
  type FetchLike,
  type HumanAuthenticationSnapshot,
  type HumanAuthenticationStore,
  type HumanProfile,
  type HumanRefreshDriver,
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
  reconcileHumanAccountMetadata,
  type HumanAccountMetadataPort,
} from "./keychain-custody";

const MAX_SELECTION_PAGES = 1_000;

export interface SafeDeviceVerification {
  readonly userCode: string;
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
      readonly verification?: SafeDeviceVerification;
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
  readonly #origin: string;

  constructor(options: {
    readonly credentials: HumanCredentialCustody;
    readonly onChanged: (
      snapshot: HumanAuthenticationSnapshot | null,
    ) => Promise<void>;
    readonly origin: string;
  }) {
    this.#credentials = options.credentials;
    this.#onChanged = options.onChanged;
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
  #snapshot: HumanAccountSnapshot = { state: "initializing", revision: 0 };

  constructor(options: HumanAccountServiceOptions) {
    this.#availability = cloudAttachmentAvailability(options.configuration);
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
      const reconnect = await this.#credentials.inspectLegacyIdentityReconnect();
      if (reconnect.state === "required") {
        return this.#update({
          state: "recovery_required",
          reason: "credential_reconnect_required",
        });
      }
      await this.#credentials.recover({ abandonMissingPending: false });
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
      await reconcileHumanAccountMetadata(this.#metadata, snapshot);
      return snapshot === null
        ? this.#update({ state: "signed_out" })
        : this.#signedIn(snapshot);
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
    if (this.#snapshot.state === "signed_in") return this.#snapshot;
    return this.#update({ state: "signed_out" });
  }

  async signOut(): Promise<HumanAccountSnapshot> {
    await this.cancelSignIn();
    return await this.#serialized(async () => {
      try {
        // User-authorized sign-out is also the explicit recovery authority for
        // a crash after the pending journal CAS but before Keychain persistence.
        const recovered = await this.#credentials.recover({
          abandonMissingPending: true,
        });
        if (recovered.generation !== undefined) {
          const cleared = await this.#credentials.clear({
            expectedGeneration: recovered.generation,
          });
          if (!cleared) {
            return this.#update({
              state: "error",
              error: safeError("SERVICE_UNAVAILABLE"),
            });
          }
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
        await beforeQuarantine();
        await this.#credentials.quarantineLegacyIdentityPointers();
        const retained = await this.#credentials.read();
        await reconcileHumanAccountMetadata(this.#metadata, retained);
        return {
          ok: true,
          snapshot: retained === null
            ? this.#update({ state: "signed_out" })
            : this.#signedIn(retained),
        };
      } catch {
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
    return await this.#serialized(async () => {
      const found = await this.#findOrganization(parsed.data);
      if (!found.ok) return found;
      if (found.data.status === "provisioning") {
        return {
          ok: false,
          error: safeError("PROVISIONING_IN_PROGRESS"),
        };
      }
      if (found.data.status === "failed") {
        return { ok: false, error: safeError("PROVISIONING_FAILED") };
      }
      return await this.#bindOrganization(found.data);
    });
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
    return await this.#serialized(async () => {
      const found = await this.#findWorkspace(parsed.data);
      if (!found.ok) return found;
      let current: HumanAuthenticationSnapshot | null;
      try {
        current = await this.#credentials.read();
      } catch {
        return { ok: false, error: safeError("SERVICE_UNAVAILABLE") };
      }
      if (current === null || current.authentication.organization === undefined) {
        return { ok: false, error: safeError("SIGNED_OUT") };
      }
      if (
        found.data.organizationId !== current.authentication.organization.id
      ) {
        return { ok: false, error: safeError("NOT_FOUND") };
      }
      const nextAuthentication = humanAuthenticationSchema.safeParse({
        ...current.authentication,
        workspace: found.data,
      });
      if (!nextAuthentication.success) {
        return { ok: false, error: safeError("VALIDATION_ERROR") };
      }
      const next = humanAuthenticationSnapshotSchema.parse({
        generation: current.generation + 1,
        authentication: nextAuthentication.data,
      });
      try {
        const replaced = await this.#credentials.compareAndSwap({
          expectedGeneration: current.generation,
          next,
        });
        if (replaced === null) {
          return { ok: false, error: safeError("SERVICE_UNAVAILABLE") };
        }
        await reconcileHumanAccountMetadata(this.#metadata, replaced);
        this.#signedIn(replaced);
        return {
          ok: true,
          data: profileFromHumanAuthentication(
            replaced.authentication,
            "keychain",
          ),
        };
      } catch {
        return { ok: false, error: safeError("SERVICE_UNAVAILABLE") };
      }
    });
  }

  async #performSignIn(
    generation: number,
    signal: AbortSignal,
  ): Promise<void> {
    if (this.#availability.state === "disabled") return;
    try {
      const authenticated = await loginWithWorkosDevice({
        clientId: this.#availability.workosClientId,
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
        version: 1,
        apiUrl: this.#availability.apiOrigin,
        accessToken: authenticated.accessToken,
        refreshToken: authenticated.refreshToken,
        user: authenticated.user,
        ...(authenticated.workosOrganizationId === undefined
          ? {}
          : {
              workosOrganizationId: authenticated.workosOrganizationId,
            }),
      });
      const snapshot = await this.#credentials.write(authentication);
      if (signal.aborted || generation !== this.#loginGeneration) {
        await this.#credentials
          .clear({ expectedGeneration: snapshot.generation })
          .catch(() => false);
        return;
      }
      await reconcileHumanAccountMetadata(this.#metadata, snapshot);
      this.#signedIn(snapshot);
    } catch (error) {
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

  #verification(
    generation: number,
    signal: AbortSignal,
    verification: DeviceVerification,
  ): void {
    if (signal.aborted || generation !== this.#loginGeneration) return;
    this.#update({
      state: "signing_in",
      verification: {
        userCode: verification.userCode,
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
    organization: OrganizationView & {
      readonly status: "active";
      readonly workosOrganizationId: string;
    },
  ): Promise<HumanAccountResult<HumanProfile>> {
    return await this.#serializedRefresh(async () => {
      if (this.#transport === null) {
        return {
          ok: false,
          error: safeError("CONFIGURATION_UNAVAILABLE"),
        };
      }
      let current: HumanAuthenticationSnapshot | null;
      try {
        current = await this.#credentials.read();
      } catch {
        return { ok: false, error: safeError("SERVICE_UNAVAILABLE") };
      }
      if (current === null) {
        return { ok: false, error: safeError("SIGNED_OUT") };
      }
      const refreshed = await this.#transport.refresh(
        current.authentication.refreshToken,
        organization.workosOrganizationId,
      );
      if (!refreshed.ok) {
        await this.#credentials
          .clear({ expectedGeneration: current.generation })
          .catch(() => false);
        await reconcileHumanAccountMetadata(this.#metadata, null).catch(
          () => undefined,
        );
        const code = refreshed.outcome === "authentication_failed"
          ? "AUTHENTICATION_FAILED"
          : "AUTH_REFRESH_INDETERMINATE";
        this.#update({ state: "error", error: safeError(code) });
        return { ok: false, error: safeError(code) };
      }
      const nextAuthentication = refreshedHumanAuthentication(
        current.authentication,
        refreshed.data,
        organization,
      );
      if (!nextAuthentication.ok) {
        await this.#credentials
          .clear({ expectedGeneration: current.generation })
          .catch(() => false);
        await reconcileHumanAccountMetadata(this.#metadata, null).catch(
          () => undefined,
        );
        const error = safeError("AUTHENTICATION_FAILED");
        this.#update({ state: "error", error });
        return { ok: false, error };
      }
      const next = humanAuthenticationSnapshotSchema.parse({
        generation: current.generation + 1,
        authentication: nextAuthentication.authentication,
      });
      try {
        const replaced = await this.#credentials.compareAndSwap({
          expectedGeneration: current.generation,
          next,
        });
        if (replaced === null) {
          return { ok: false, error: safeError("SERVICE_UNAVAILABLE") };
        }
        await reconcileHumanAccountMetadata(this.#metadata, replaced);
        this.#signedIn(replaced);
        return {
          ok: true,
          data: profileFromHumanAuthentication(
            replaced.authentication,
            "keychain",
          ),
        };
      } catch {
        return { ok: false, error: safeError("SERVICE_UNAVAILABLE") };
      }
    });
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
            ...(current.authentication.workosOrganizationId === undefined
              ? {}
              : {
                  workosOrganizationId:
                    current.authentication.workosOrganizationId,
                }),
          },
        };
      }
      return await this.#transport.refresh(
        input.refreshToken,
        input.workosOrganizationId,
      );
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
    if (snapshot === null) {
      this.#update({ state: "signed_out" });
    } else {
      this.#signedIn(snapshot);
    }
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
