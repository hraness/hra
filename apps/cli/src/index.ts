#!/usr/bin/env bun

import {
  createBearerSecret,
  createLocator,
  createOpaqueId,
  createUuidV7,
  credentialTokenSchema,
  enrollmentTokenSchema,
  formatEnrollmentToken,
  sessionIdSchema,
  type CreateAgentEnrollmentResponse,
  type CreateAgentResponse,
  type CreateOrganizationResponse,
  type ContextResponse,
  type CredentialToken,
  type EnrollmentToken,
  type IdempotencyKey,
  type GetAgentResponse,
  type ListAgentCredentialsResponse,
  type ListAgentSessionsResponse,
  type ListAgentsResponse,
  type ListOrganizationsResponse,
  type ListWorkspacesResponse,
  type OrganizationView,
  type RequestId,
  type TaskKey,
  type WorkspaceView,
} from "@hraness/agent-tasks-protocol";
import { refreshedHumanAuthentication } from "@hraness/hra-human-client";

import { parseArgs, USAGE, type CliCommand } from "./args";
import {
  executeClaimBoundCommand,
  type AutomaticClaimRenewal,
  type OwnedClaimContext,
} from "./claim-preflight";
import {
  TaskctlClient,
  type AgentAuthorization,
  type ClientFailure,
  type ClientResult,
  type FetchLike,
} from "./client";
import {
  TaskctlConfigError,
  activeCredentialRecord,
  bunAgentSecretStore,
  clearStoredAuthentication,
  clearStoredSessionAttempt,
  generateCredentialToken,
  migrateLegacyStoredCredential,
  pendingCredentialRecord,
  readProfile,
  readStoredCredential,
  readStoredCredentialSource,
  readStoredSessionAttempt,
  resolveAgentSessionSeed,
  resolveApiUrl,
  resolveStoragePaths,
  sessionAttemptRecord,
  webCryptoRandomBytes,
  writeProfile,
  writeStoredCredential,
  writeStoredSessionAttempt,
  type RandomSource,
  type AgentSecretStore,
  type AgentSecretStoreKind,
  type StoredCredential,
  type StoragePaths,
  type TaskctlEnvironment,
  type TaskctlProfile,
} from "./config";
import {
  bunHumanSecretStore,
  clearHumanAuthentication,
  humanAuthenticationSchema,
  humanProfileOutput,
  readEnrollmentFile,
  readHumanAuthentication,
  readHumanProfile,
  resolveHumanStoragePaths,
  updateHumanAuthentication,
  writeHumanAuthentication,
  writeNewEnrollmentFile,
  type HumanAuthentication,
  type HumanProfile,
  type HumanSecretStore,
  type HumanStoragePaths,
} from "./human-config";
import {
  processIo,
  writeData,
  writeFailure,
  writeUsage,
  type CliIo,
} from "./output";
import {
  loginWithWorkosDevice,
  openVerificationUrl,
  type DeviceVerification,
} from "./workos-device";

export interface RunCliOptions {
  readonly environment?: TaskctlEnvironment;
  readonly fetch?: FetchLike;
  readonly io?: CliIo;
  readonly now?: () => number;
  readonly random?: RandomSource;
  readonly storagePaths?: StoragePaths;
  readonly agentSecretStore?: AgentSecretStore;
  readonly humanSecretStore?: HumanSecretStore;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly openBrowser?: (url: string) => Promise<void>;
}

interface Runtime {
  readonly environment: TaskctlEnvironment;
  readonly fetch?: FetchLike;
  readonly io: CliIo;
  readonly now: () => number;
  readonly random: RandomSource;
  readonly paths: StoragePaths;
  readonly humanPaths: HumanStoragePaths;
  readonly agentSecretStore: AgentSecretStore;
  readonly humanSecretStore: HumanSecretStore;
  readonly sleep: (milliseconds: number) => Promise<void>;
  readonly openBrowser: (url: string) => Promise<void>;
  readonly issuedIdempotencyKeys: Set<IdempotencyKey>;
}

function localRequestId(runtime: Runtime): RequestId {
  return createOpaqueId("req", runtime.random(26));
}

function idempotencyKey(
  runtime: Runtime,
  configured?: IdempotencyKey,
  avoid?: IdempotencyKey,
): IdempotencyKey {
  if (configured !== undefined) {
    runtime.issuedIdempotencyKeys.add(configured);
    return configured;
  }
  const bytes = runtime.random(10);
  const last = bytes[bytes.length - 1];
  if (last === undefined) throw new Error("idempotency random-byte invariant failed");
  for (let offset = 0; offset < 256; offset += 1) {
    bytes[bytes.length - 1] = (last + offset) & 0xff;
    const generated = createUuidV7(runtime.now(), bytes);
    if (generated !== avoid && !runtime.issuedIdempotencyKeys.has(generated)) {
      runtime.issuedIdempotencyKeys.add(generated);
      return generated;
    }
  }
  throw new Error("could not generate a unique idempotency key");
}

function clientFailure(
  runtime: Runtime,
  error: ClientFailure,
  json: boolean,
  idempotencyKey?: IdempotencyKey,
): number {
  return writeFailure(
    runtime.io,
    {
      code: error.code,
      message: error.message,
      details:
        idempotencyKey === undefined
          ? error.details
          : { ...error.details, idempotencyKey },
      requestId: error.requestId ?? localRequestId(runtime),
    },
    json,
  );
}

async function enrollmentFromInput(runtime: Runtime, json: boolean): Promise<EnrollmentToken | null> {
  void json;
  const configured = runtime.environment["TASKCTL_ENROLLMENT_TOKEN"];
  let candidate: string;
  if (configured !== undefined) {
    candidate = configured.trim();
  } else {
    if (runtime.io.stdinIsTTY) return null;
    const input = await runtime.io.readStdin();
    if (new TextEncoder().encode(input).length > 1_024) return null;
    candidate = input.trim();
  }
  const parsed = enrollmentTokenSchema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}

function profileOutput(profile: TaskctlProfile | null): unknown {
  if (profile === null) return null;
  return {
    apiUrl: profile.apiUrl,
    agentId: profile.agentId,
    scopes: profile.scopes,
    ...(profile.credentialId === undefined ? {} : { credentialId: profile.credentialId }),
    ...(profile.credentialExpiresAt === undefined
      ? {}
      : { credentialExpiresAt: profile.credentialExpiresAt }),
  };
}

type PendingCredential = Extract<StoredCredential, { readonly state: "pending_enrollment" }>;
type ActiveCredential = Extract<StoredCredential, { readonly state: "active" }>;

interface StartedSession {
  readonly authorization: AgentAuthorization;
  readonly expiresAt: number;
  readonly idempotencyKey: IdempotencyKey;
  readonly requestId: RequestId;
}

type SessionAttempt =
  | { readonly ok: true; readonly session: StartedSession }
  | { readonly ok: false; readonly error: ClientFailure; readonly idempotencyKey: IdempotencyKey };

function configurationFailure(
  runtime: Runtime,
  error: TaskctlConfigError,
  json: boolean,
  idempotencyKey?: IdempotencyKey,
): number {
  return writeFailure(
    runtime.io,
    {
      code: error.code,
      message: error.message,
      requestId: localRequestId(runtime),
      details: idempotencyKey === undefined ? {} : { idempotencyKey },
    },
    json,
  );
}

async function startSessionAttempt(
  runtime: Runtime,
  client: TaskctlClient,
  apiUrl: string,
  credential: CredentialToken,
  avoid?: IdempotencyKey,
): Promise<SessionAttempt> {
  const storedAttempt = await readStoredSessionAttempt(runtime.paths);
  let key: IdempotencyKey;
  if (storedAttempt === null) {
    key = idempotencyKey(runtime, undefined, avoid);
    await writeStoredSessionAttempt(
      runtime.paths,
      sessionAttemptRecord(credential, apiUrl, key),
      runtime.random,
    );
  } else {
    const expected = sessionAttemptRecord(credential, apiUrl, storedAttempt.idempotencyKey);
    if (
      storedAttempt.apiUrl !== expected.apiUrl ||
      storedAttempt.credentialLocator !== expected.credentialLocator ||
      storedAttempt.idempotencyKey === avoid
    ) {
      throw new TaskctlConfigError(
        "VALIDATION_ERROR",
        "an ambiguous session attempt belongs to a different credential or API origin; run auth logout before retrying",
      );
    }
    key = storedAttempt.idempotencyKey;
    runtime.issuedIdempotencyKeys.add(key);
  }
  const result = await client.startSession(credential, key);
  if (result.ok || result.error.requestId !== undefined) {
    await clearStoredSessionAttempt(runtime.paths);
  }
  if (!result.ok) return { ok: false, error: result.error, idempotencyKey: key };
  return {
    ok: true,
    session: {
      authorization: { credential, sessionId: result.data.sessionId },
      expiresAt: result.data.expiresAt,
      idempotencyKey: key,
      requestId: result.requestId,
    },
  };
}

function profileFromContext(apiUrl: string, context: ContextResponse): TaskctlProfile {
  return {
    version: 1,
    apiUrl,
    agentId: context.principal.agentId,
    scopes: context.principal.scopes,
  };
}

type PendingRecovery =
  | { readonly kind: "not_redeemed" }
  | { readonly kind: "failure"; readonly exitCode: number }
  | {
      readonly kind: "recovered";
      readonly profile: TaskctlProfile;
      readonly active: ActiveCredential;
      readonly session: StartedSession;
      readonly contextRequestId?: RequestId;
    };

async function recoverPendingSession(
  runtime: Runtime,
  client: TaskctlClient,
  apiUrl: string,
  pending: PendingCredential,
  profile: TaskctlProfile | null,
  json: boolean,
): Promise<PendingRecovery> {
  const attempt = await startSessionAttempt(
    runtime,
    client,
    apiUrl,
    pending.credential,
    pending.redeemIdempotencyKey,
  );
  if (!attempt.ok) {
    if (attempt.error.code === "AUTHENTICATION_FAILED") return { kind: "not_redeemed" };
    return {
      kind: "failure",
      exitCode: clientFailure(runtime, attempt.error, json, attempt.idempotencyKey),
    };
  }

  let recoveredProfile = profile;
  let contextRequestId: RequestId | undefined;
  if (recoveredProfile === null) {
    const context = await client.context(attempt.session.authorization);
    if (!context.ok) {
      return {
        kind: "failure",
        exitCode: clientFailure(runtime, context.error, json, attempt.session.idempotencyKey),
      };
    }
    contextRequestId = context.requestId;
    recoveredProfile = profileFromContext(apiUrl, context.data);
  }

  const active = activeCredentialRecord(
    pending.credential,
    attempt.session.authorization.sessionId,
    attempt.session.expiresAt,
  );
  try {
    await writeProfile(runtime.paths, recoveredProfile, runtime.random);
    await writeStoredCredential(runtime.paths, active, runtime.random, runtime.agentSecretStore);
  } catch (error) {
    if (error instanceof TaskctlConfigError) {
      return {
        kind: "failure",
        exitCode: configurationFailure(
          runtime,
          error,
          json,
          attempt.session.idempotencyKey,
        ),
      };
    }
    throw error;
  }

  return {
    kind: "recovered",
    profile: recoveredProfile,
    active,
    session: attempt.session,
    ...(contextRequestId === undefined ? {} : { contextRequestId }),
  };
}

type ProfileRepair =
  | { readonly ok: false; readonly exitCode: number }
  | {
      readonly ok: true;
      readonly profile: TaskctlProfile;
      readonly active: ActiveCredential;
      readonly session?: StartedSession;
      readonly contextRequestId: RequestId;
    };

async function repairActiveProfile(
  runtime: Runtime,
  client: TaskctlClient,
  apiUrl: string,
  active: ActiveCredential,
  json: boolean,
): Promise<ProfileRepair> {
  let authorization: AgentAuthorization | undefined =
    active.sessionExpiresAt > runtime.now()
      ? { credential: active.credential, sessionId: active.sessionId }
      : undefined;
  let started: StartedSession | undefined;
  let context: ClientResult<ContextResponse> | undefined;
  if (authorization !== undefined) context = await client.context(authorization);

  if (
    authorization === undefined ||
    (context !== undefined && !context.ok && context.error.code === "SESSION_INVALID")
  ) {
    const attempt = await startSessionAttempt(runtime, client, apiUrl, active.credential);
    if (!attempt.ok) {
      return {
        ok: false,
        exitCode: clientFailure(runtime, attempt.error, json, attempt.idempotencyKey),
      };
    }
    started = attempt.session;
    authorization = started.authorization;
    context = await client.context(authorization);
  }

  if (context === undefined) throw new Error("profile repair context invariant failed");
  if (!context.ok) {
    return {
      ok: false,
      exitCode: clientFailure(runtime, context.error, json, started?.idempotencyKey),
    };
  }

  const profile = profileFromContext(apiUrl, context.data);
  const nextActive =
    started === undefined
      ? active
      : activeCredentialRecord(
          active.credential,
          started.authorization.sessionId,
          started.expiresAt,
        );
  try {
    await writeProfile(runtime.paths, profile, runtime.random);
    if (started !== undefined) {
      await writeStoredCredential(
        runtime.paths,
        nextActive,
        runtime.random,
        runtime.agentSecretStore,
      );
    }
  } catch (error) {
    if (error instanceof TaskctlConfigError) {
      return {
        ok: false,
        exitCode: configurationFailure(runtime, error, json, started?.idempotencyKey),
      };
    }
    throw error;
  }
  return {
    ok: true,
    profile,
    active: nextActive,
    contextRequestId: context.requestId,
    ...(started === undefined ? {} : { session: started }),
  };
}

function writeEnrollmentRecovery(
  runtime: Runtime,
  recovery: Extract<PendingRecovery, { readonly kind: "recovered" }>,
  json: boolean,
): number {
  writeData(
    runtime.io,
    {
      authenticated: true,
      recovered: true,
      profile: profileOutput(recovery.profile),
      sessionExpiresAt: recovery.active.sessionExpiresAt,
      idempotencyKeys: { session: recovery.session.idempotencyKey },
      requestIds: {
        session: recovery.session.requestId,
        ...(recovery.contextRequestId === undefined
          ? {}
          : { context: recovery.contextRequestId }),
      },
    },
    json,
  );
  return 0;
}

async function authEnroll(
  runtime: Runtime,
  command: Extract<CliCommand, { kind: "auth_enroll" }>,
): Promise<number> {
  const profile = await readProfile(runtime.paths);
  const stored = await readStoredCredential(runtime.paths, runtime.agentSecretStore);
  const apiUrl =
    stored?.state === "pending_enrollment"
      ? stored.apiUrl
      : resolveApiUrl(runtime.environment, profile);
  const client = new TaskctlClient({
    apiUrl,
    ...(runtime.fetch === undefined ? {} : { fetch: runtime.fetch }),
  });
  if (stored?.state === "active") {
    if (profile !== null) {
      return writeFailure(
        runtime.io,
        {
          code: "VALIDATION_ERROR",
          message: "an agent credential is already configured; run auth logout before enrolling again",
          requestId: localRequestId(runtime),
          details: {},
        },
        command.json,
      );
    }
    const repaired = await repairActiveProfile(runtime, client, apiUrl, stored, command.json);
    if (!repaired.ok) return repaired.exitCode;
    writeData(
      runtime.io,
      {
        authenticated: true,
        recovered: true,
        profile: profileOutput(repaired.profile),
        sessionExpiresAt: repaired.active.sessionExpiresAt,
        ...(repaired.session === undefined
          ? {}
          : { idempotencyKeys: { session: repaired.session.idempotencyKey } }),
        requestIds: {
          context: repaired.contextRequestId,
          ...(repaired.session === undefined ? {} : { session: repaired.session.requestId }),
        },
      },
      command.json,
    );
    return 0;
  }

  let pending: PendingCredential | undefined;
  if (stored?.state === "pending_enrollment") {
    const redeemKey =
      stored.redeemIdempotencyKey ?? idempotencyKey(runtime, command.idempotencyKey);
    pending = pendingCredentialRecord(stored.credential, stored.apiUrl, redeemKey);
    if (stored.redeemIdempotencyKey === undefined) {
      await writeStoredCredential(runtime.paths, pending, runtime.random, runtime.agentSecretStore);
    }
    const recovered = await recoverPendingSession(
      runtime,
      client,
      apiUrl,
      pending,
      profile,
      command.json,
    );
    if (recovered.kind === "failure") return recovered.exitCode;
    if (recovered.kind === "recovered") {
      return writeEnrollmentRecovery(runtime, recovered, command.json);
    }
  }

  const enrollment = await enrollmentFromInput(runtime, command.json);
  if (enrollment === null) {
    return writeFailure(
      runtime.io,
      {
        code: "VALIDATION_ERROR",
        message: "provide a valid enrollment token through stdin or TASKCTL_ENROLLMENT_TOKEN",
        requestId: localRequestId(runtime),
        details: {},
      },
      command.json,
    );
  }

  if (pending === undefined) {
    const credential = generateCredentialToken(runtime.random);
    const redeemKey = idempotencyKey(runtime, command.idempotencyKey);
    pending = pendingCredentialRecord(credential, apiUrl, redeemKey);
    await writeStoredCredential(
      runtime.paths,
      pending,
      runtime.random,
      runtime.agentSecretStore,
      command.secretStore,
    );
  }
  const redeemKey = pending.redeemIdempotencyKey;
  if (redeemKey === undefined) throw new Error("pending enrollment idempotency invariant failed");
  const redeemed = await client.redeemEnrollment(
    enrollment,
    pending.credential,
    redeemKey,
  );
  if (!redeemed.ok) {
    return clientFailure(runtime, redeemed.error, command.json, redeemKey);
  }

  const nextProfile: TaskctlProfile = {
    version: 1,
    apiUrl,
    agentId: redeemed.data.agentId,
    credentialId: redeemed.data.credentialId,
    credentialExpiresAt: redeemed.data.credentialExpiresAt,
    scopes: redeemed.data.scopes,
  };
  try {
    await writeProfile(runtime.paths, nextProfile, runtime.random);
  } catch (error) {
    if (error instanceof TaskctlConfigError) {
      return configurationFailure(runtime, error, command.json, redeemKey);
    }
    throw error;
  }

  const sessionAttempt = await startSessionAttempt(
    runtime,
    client,
    apiUrl,
    pending.credential,
    redeemKey,
  );
  if (!sessionAttempt.ok) {
    return clientFailure(
      runtime,
      sessionAttempt.error,
      command.json,
      sessionAttempt.idempotencyKey,
    );
  }
  try {
    await writeStoredCredential(
      runtime.paths,
      activeCredentialRecord(
        pending.credential,
        sessionAttempt.session.authorization.sessionId,
        sessionAttempt.session.expiresAt,
      ),
      runtime.random,
      runtime.agentSecretStore,
    );
  } catch (error) {
    if (error instanceof TaskctlConfigError) {
      return configurationFailure(
        runtime,
        error,
        command.json,
        sessionAttempt.session.idempotencyKey,
      );
    }
    throw error;
  }

  writeData(
    runtime.io,
    {
      authenticated: true,
      recovered: false,
      profile: profileOutput(nextProfile),
      sessionExpiresAt: sessionAttempt.session.expiresAt,
      idempotencyKeys: {
        enrollment: redeemKey,
        session: sessionAttempt.session.idempotencyKey,
      },
      requestIds: {
        enrollment: redeemed.requestId,
        session: sessionAttempt.session.requestId,
      },
    },
    command.json,
  );
  return 0;
}

async function authStatus(
  runtime: Runtime,
  command: Extract<CliCommand, { kind: "auth_status" }>,
): Promise<number> {
  let stored = await readStoredCredential(runtime.paths, runtime.agentSecretStore);
  let profile = await readProfile(runtime.paths);
  const environmentCredential = runtime.environment["TASKCTL_TOKEN"];
  const environmentSession = runtime.environment["TASKCTL_SESSION_ID"];
  const environmentCredentialValid =
    environmentCredential !== undefined && credentialTokenSchema.safeParse(environmentCredential).success;
  const environmentSessionValid =
    environmentSession !== undefined && sessionIdSchema.safeParse(environmentSession).success;
  const usingEnvironment = environmentCredential !== undefined;
  const storedSource = stored === null ? null : await readStoredCredentialSource(runtime.paths);
  let recoverySession: StartedSession | undefined;

  if (!usingEnvironment && stored !== null) {
    const apiUrl =
      stored.state === "pending_enrollment"
        ? stored.apiUrl
        : resolveApiUrl(runtime.environment, profile);
    const client = new TaskctlClient({
      apiUrl,
      ...(runtime.fetch === undefined ? {} : { fetch: runtime.fetch }),
    });
    if (stored.state === "pending_enrollment") {
      const redeemKey = stored.redeemIdempotencyKey ?? idempotencyKey(runtime);
      const pending = pendingCredentialRecord(stored.credential, stored.apiUrl, redeemKey);
      if (stored.redeemIdempotencyKey === undefined) {
        await writeStoredCredential(
          runtime.paths,
          pending,
          runtime.random,
          runtime.agentSecretStore,
        );
      }
      const recovered = await recoverPendingSession(
        runtime,
        client,
        apiUrl,
        pending,
        profile,
        command.json,
      );
      if (recovered.kind === "failure") return recovered.exitCode;
      if (recovered.kind === "recovered") {
        stored = recovered.active;
        profile = recovered.profile;
        recoverySession = recovered.session;
      }
    } else if (profile === null) {
      const repaired = await repairActiveProfile(runtime, client, apiUrl, stored, command.json);
      if (!repaired.ok) return repaired.exitCode;
      stored = repaired.active;
      profile = repaired.profile;
      recoverySession = repaired.session;
    } else if (stored.sessionExpiresAt <= runtime.now()) {
      const attempt = await startSessionAttempt(runtime, client, apiUrl, stored.credential);
      if (!attempt.ok) {
        return clientFailure(runtime, attempt.error, command.json, attempt.idempotencyKey);
      }
      stored = activeCredentialRecord(
        stored.credential,
        attempt.session.authorization.sessionId,
        attempt.session.expiresAt,
      );
      try {
        await writeStoredCredential(runtime.paths, stored, runtime.random, runtime.agentSecretStore);
      } catch (error) {
        if (error instanceof TaskctlConfigError) {
          return configurationFailure(
            runtime,
            error,
            command.json,
            attempt.session.idempotencyKey,
          );
        }
        throw error;
      }
      recoverySession = attempt.session;
    }
  }

  const authenticated = usingEnvironment
    ? environmentCredentialValid && environmentSessionValid
    : stored?.state === "active";
  const humanStored = await readHumanAuthentication(
    runtime.humanPaths,
    runtime.humanSecretStore,
  );
  writeData(
    runtime.io,
    {
      authenticated,
      source: usingEnvironment ? "environment" : (storedSource ?? "none"),
      pendingEnrollment: !usingEnvironment && stored?.state === "pending_enrollment",
      credentialConfigured: usingEnvironment ? environmentCredentialValid : stored !== null,
      sessionConfigured: usingEnvironment ? environmentSessionValid : stored?.state === "active",
      ...(stored?.state === "active" ? { sessionExpiresAt: stored.sessionExpiresAt } : {}),
      profile: profileOutput(profile),
      human: humanProfileOutput(humanStored?.profile ?? null),
      ...(recoverySession === undefined
        ? {}
        : {
            recovered: true,
            sessionIdempotencyKey: recoverySession.idempotencyKey,
            sessionRequestId: recoverySession.requestId,
          }),
    },
    command.json,
  );
  return 0;
}

type PreparedAuthentication =
  | { readonly ok: false; readonly exitCode: number }
  | {
      readonly ok: true;
      readonly client: TaskctlClient;
      readonly apiUrl: string;
      readonly authorization: AgentAuthorization;
      readonly source: "environment" | AgentSecretStoreKind;
      readonly sessionIdempotencyKeys: readonly IdempotencyKey[];
    };

async function prepareAuthentication(
  runtime: Runtime,
  json: boolean,
): Promise<PreparedAuthentication> {
  const profile = await readProfile(runtime.paths);
  const apiUrl = resolveApiUrl(runtime.environment, profile);
  const seed = await resolveAgentSessionSeed(
    runtime.environment,
    runtime.paths,
    runtime.now(),
    runtime.agentSecretStore,
  );
  const client = new TaskctlClient({
    apiUrl,
    ...(runtime.fetch === undefined ? {} : { fetch: runtime.fetch }),
  });
  if (seed.sessionId !== undefined) {
    return {
      ok: true,
      client,
      apiUrl,
      authorization: { credential: seed.credential, sessionId: seed.sessionId },
      source: seed.source,
      sessionIdempotencyKeys: [],
    };
  }

  const attempt = await startSessionAttempt(runtime, client, apiUrl, seed.credential);
  if (!attempt.ok) {
    return {
      ok: false,
      exitCode: clientFailure(runtime, attempt.error, json, attempt.idempotencyKey),
    };
  }
  if (seed.source !== "environment") {
    try {
      await writeStoredCredential(
        runtime.paths,
        activeCredentialRecord(
          seed.credential,
          attempt.session.authorization.sessionId,
          attempt.session.expiresAt,
        ),
        runtime.random,
        runtime.agentSecretStore,
      );
    } catch (error) {
      if (error instanceof TaskctlConfigError) {
        return {
          ok: false,
          exitCode: configurationFailure(
            runtime,
            error,
            json,
            attempt.session.idempotencyKey,
          ),
        };
      }
      throw error;
    }
  }
  return {
    ok: true,
    client,
    apiUrl,
    authorization: attempt.session.authorization,
    source: seed.source,
    sessionIdempotencyKeys: [attempt.session.idempotencyKey],
  };
}

type AuthenticatedCall<Value> =
  | { readonly ok: false; readonly exitCode: number }
  | {
      readonly ok: true;
      readonly result: ClientResult<Value>;
      readonly sessionIdempotencyKeys: readonly IdempotencyKey[];
      readonly automaticClaimRenewal?: AutomaticClaimRenewal;
      readonly failureIdempotencyKey?: IdempotencyKey;
    };

interface AuthenticatedOperationResult<Value> {
  readonly result: ClientResult<Value>;
  readonly automaticClaimRenewal?: AutomaticClaimRenewal;
  readonly failureIdempotencyKey?: IdempotencyKey;
}

function normalizeAuthenticatedOperation<Value>(
  operation: ClientResult<Value> | AuthenticatedOperationResult<Value>,
): AuthenticatedOperationResult<Value> {
  return "result" in operation ? operation : { result: operation };
}

async function authenticatedCall<Value>(
  runtime: Runtime,
  json: boolean,
  operation: (
    client: TaskctlClient,
    authorization: AgentAuthorization,
  ) => Promise<ClientResult<Value> | AuthenticatedOperationResult<Value>>,
): Promise<AuthenticatedCall<Value>> {
  const prepared = await prepareAuthentication(runtime, json);
  if (!prepared.ok) return prepared;
  let attempted = normalizeAuthenticatedOperation(
    await operation(prepared.client, prepared.authorization),
  );
  let result = attempted.result;
  let automaticClaimRenewal = attempted.automaticClaimRenewal;
  let failureIdempotencyKey = attempted.failureIdempotencyKey;
  const sessionKeys = [...prepared.sessionIdempotencyKeys];
  if (!result.ok && result.error.code === "SESSION_INVALID") {
    const attempt = await startSessionAttempt(
      runtime,
      prepared.client,
      prepared.apiUrl,
      prepared.authorization.credential,
    );
    if (!attempt.ok) {
      return {
        ok: false,
        exitCode: clientFailure(runtime, attempt.error, json, attempt.idempotencyKey),
      };
    }
    if (prepared.source !== "environment") {
      try {
        await writeStoredCredential(
          runtime.paths,
          activeCredentialRecord(
            prepared.authorization.credential,
            attempt.session.authorization.sessionId,
            attempt.session.expiresAt,
          ),
          runtime.random,
          runtime.agentSecretStore,
        );
      } catch (error) {
        if (error instanceof TaskctlConfigError) {
          return {
            ok: false,
            exitCode: configurationFailure(
              runtime,
              error,
              json,
              attempt.session.idempotencyKey,
            ),
          };
        }
        throw error;
      }
    }
    sessionKeys.push(attempt.session.idempotencyKey);
    attempted = normalizeAuthenticatedOperation(
      await operation(prepared.client, attempt.session.authorization),
    );
    result = attempted.result;
    automaticClaimRenewal =
      attempted.automaticClaimRenewal ?? automaticClaimRenewal;
    failureIdempotencyKey = attempted.failureIdempotencyKey;
  }
  return {
    ok: true,
    result,
    sessionIdempotencyKeys: sessionKeys,
    ...(automaticClaimRenewal === undefined ? {} : { automaticClaimRenewal }),
    ...(failureIdempotencyKey === undefined ? {} : { failureIdempotencyKey }),
  };
}

async function claimBoundAuthenticatedCall<Value>(
  runtime: Runtime,
  json: boolean,
  taskKey: TaskKey,
  mutationIdempotencyKey: IdempotencyKey,
  target: (
    client: TaskctlClient,
    authorization: AgentAuthorization,
    context: OwnedClaimContext | null,
  ) => Promise<ClientResult<Value>>,
): Promise<AuthenticatedCall<Value>> {
  let renewalIdempotencyKey: IdempotencyKey | undefined;
  return await authenticatedCall(runtime, json, async (client, authorization) =>
    await executeClaimBoundCommand({
      client,
      authorization,
      key: taskKey,
      renewalIdempotencyKey: () => {
        renewalIdempotencyKey ??= idempotencyKey(
          runtime,
          undefined,
          mutationIdempotencyKey,
        );
        return renewalIdempotencyKey;
      },
      target: async (context) => await target(client, authorization, context),
    }),
  );
}

function sessionIdempotencyOutput(
  keys: readonly IdempotencyKey[],
): { readonly sessionIdempotencyKeys?: readonly IdempotencyKey[] } {
  return keys.length === 0 ? {} : { sessionIdempotencyKeys: keys };
}

function automaticClaimRenewalOutput(
  renewal: AutomaticClaimRenewal | undefined,
): { readonly automaticClaimRenewal?: AutomaticClaimRenewal } {
  return renewal === undefined ? {} : { automaticClaimRenewal: renewal };
}

function outputAuthenticatedCall<Value>(
  runtime: Runtime,
  call: AuthenticatedCall<Value>,
  json: boolean,
  shape: (
    value: Value,
    requestId: RequestId,
    sessionIdempotencyKeys: readonly IdempotencyKey[],
    automaticClaimRenewal?: AutomaticClaimRenewal,
  ) => unknown,
  mutationIdempotencyKey?: IdempotencyKey,
): number {
  if (!call.ok) return call.exitCode;
  if (!call.result.ok) {
    const sessionKey = call.sessionIdempotencyKeys[call.sessionIdempotencyKeys.length - 1];
    return clientFailure(
      runtime,
      call.result.error,
      json,
      call.failureIdempotencyKey ?? mutationIdempotencyKey ?? sessionKey,
    );
  }
  writeData(
    runtime.io,
    shape(
      call.result.data,
      call.result.requestId,
      call.sessionIdempotencyKeys,
      call.automaticClaimRenewal,
    ),
    json,
  );
  return 0;
}

type HumanRequirement = "account" | "organization" | "workspace";

interface PreparedHumanAuthentication {
  readonly client: TaskctlClient;
  readonly authentication: HumanAuthentication;
  readonly profile: HumanProfile;
}

type HumanRefresh =
  | { readonly ok: false; readonly exitCode: number }
  | {
      readonly ok: true;
      readonly prepared: PreparedHumanAuthentication;
      readonly requestId: RequestId;
    };

type HumanCall<Value> =
  | { readonly ok: false; readonly exitCode: number }
  | {
      readonly ok: true;
      readonly result: ClientResult<Value>;
    };

async function prepareHumanAuthentication(
  runtime: Runtime,
  requirement: HumanRequirement,
): Promise<PreparedHumanAuthentication> {
  const stored = await readHumanAuthentication(runtime.humanPaths, runtime.humanSecretStore);
  if (stored === null) {
    throw new TaskctlConfigError(
      "AUTHENTICATION_FAILED",
      "no human authentication is configured; run auth login",
    );
  }
  const { authentication, profile } = stored;
  if (requirement !== "account") {
    const organization = authentication.organization;
    if (organization === undefined || authentication.workosOrganizationId === undefined) {
      throw new TaskctlConfigError(
        "ORGANIZATION_REQUIRED",
        "select an organization with organization use",
      );
    }
    if (organization.status === "provisioning") {
      throw new TaskctlConfigError(
        "PROVISIONING_IN_PROGRESS",
        "the selected organization is still provisioning",
      );
    }
    if (organization.status === "failed") {
      throw new TaskctlConfigError(
        "PROVISIONING_FAILED",
        "the selected organization could not be provisioned",
      );
    }
  }
  if (requirement === "workspace" && authentication.workspace === undefined) {
    throw new TaskctlConfigError(
      "VALIDATION_ERROR",
      "select a workspace with workspace use",
    );
  }
  return {
    authentication,
    profile,
    client: new TaskctlClient({
      apiUrl: authentication.apiUrl,
      ...(runtime.fetch === undefined ? {} : { fetch: runtime.fetch }),
    }),
  };
}

async function clearAfterRefreshFailure(runtime: Runtime): Promise<void> {
  await clearHumanAuthentication(runtime.humanPaths, runtime.humanSecretStore);
}

async function refreshHumanAuthentication(
  runtime: Runtime,
  prepared: PreparedHumanAuthentication,
  json: boolean,
  targetOrganization?: OrganizationView,
): Promise<HumanRefresh> {
  const workosOrganizationId =
    targetOrganization?.workosOrganizationId ?? prepared.authentication.workosOrganizationId;
  const result = await prepared.client.refreshHumanAuthentication(
    prepared.authentication.refreshToken,
    workosOrganizationId === undefined ? {} : { workosOrganizationId },
  );
  if (!result.ok) {
    if (
      result.error.code === "SERVICE_UNAVAILABLE" ||
      result.error.code === "AUTH_REFRESH_INDETERMINATE"
    ) {
      await clearAfterRefreshFailure(runtime);
      return {
        ok: false,
        exitCode: writeFailure(
          runtime.io,
          {
            code: "AUTH_REFRESH_INDETERMINATE",
            message:
              "the refresh outcome is unknown; local human authentication was cleared, so run auth login",
            requestId: result.error.requestId ?? localRequestId(runtime),
            details: {},
          },
          json,
        ),
      };
    }
    if (result.error.code === "AUTHENTICATION_FAILED") {
      await clearAfterRefreshFailure(runtime);
    }
    return { ok: false, exitCode: clientFailure(runtime, result.error, json) };
  }

  const refreshed = refreshedHumanAuthentication(
    prepared.authentication,
    result.data,
    targetOrganization,
  );
  if (!refreshed.ok) {
    await clearAfterRefreshFailure(runtime);
    return {
      ok: false,
      exitCode: writeFailure(
        runtime.io,
        {
          code: "AUTHENTICATION_FAILED",
          message: "the refreshed token did not match the selected identity; run auth login",
          requestId: result.requestId,
          details: {},
        },
        json,
      ),
    };
  }

  const nextAuthentication = refreshed.authentication;
  await updateHumanAuthentication(
    runtime.humanPaths,
    prepared.profile,
    nextAuthentication,
    runtime.random,
    runtime.humanSecretStore,
  );
  return {
    ok: true,
    requestId: result.requestId,
    prepared: {
      authentication: nextAuthentication,
      profile: (await readHumanProfile(runtime.humanPaths)) ?? prepared.profile,
      client: prepared.client,
    },
  };
}

async function humanCall<Value>(
  runtime: Runtime,
  json: boolean,
  requirement: HumanRequirement,
  operation: (prepared: PreparedHumanAuthentication) => Promise<ClientResult<Value>>,
): Promise<HumanCall<Value>> {
  let prepared = await prepareHumanAuthentication(runtime, requirement);
  let result = await operation(prepared);
  if (!result.ok && result.error.code === "AUTHENTICATION_FAILED") {
    const refreshed = await refreshHumanAuthentication(runtime, prepared, json);
    if (!refreshed.ok) return refreshed;
    prepared = refreshed.prepared;
    result = await operation(prepared);
  }
  return { ok: true, result };
}

function outputHumanCall<Value>(
  runtime: Runtime,
  call: HumanCall<Value>,
  json: boolean,
  shape: (value: Value, requestId: RequestId) => unknown,
  mutationIdempotencyKey?: IdempotencyKey,
): number {
  if (!call.ok) return call.exitCode;
  if (!call.result.ok) {
    return clientFailure(runtime, call.result.error, json, mutationIdempotencyKey);
  }
  writeData(runtime.io, shape(call.result.data, call.result.requestId), json);
  return 0;
}

function writeDeviceVerification(
  runtime: Runtime,
  verification: DeviceVerification,
  json: boolean,
): void {
  if (json) {
    runtime.io.stderr(
      `${JSON.stringify({
        deviceAuthorization: {
          userCode: verification.userCode,
          verificationUri: verification.verificationUri,
          expiresAt: verification.expiresAt,
        },
      })}\n`,
    );
    return;
  }
  runtime.io.stderr(
    `Open ${verification.verificationUri} and enter code ${verification.userCode}.\n`,
  );
}

async function authLogin(
  runtime: Runtime,
  command: Extract<CliCommand, { kind: "auth_login" }>,
): Promise<number> {
  const clientId =
    runtime.environment["TASKCTL_WORKOS_CLIENT_ID"] ?? runtime.environment["WORKOS_CLIENT_ID"];
  if (clientId === undefined) {
    throw new TaskctlConfigError(
      "VALIDATION_ERROR",
      "TASKCTL_WORKOS_CLIENT_ID is required for human login",
    );
  }
  const agentProfile = await readProfile(runtime.paths);
  const apiUrl = resolveApiUrl(runtime.environment, agentProfile);
  const authenticated = await loginWithWorkosDevice({
    clientId,
    fetch: runtime.fetch ?? globalThis.fetch,
    now: runtime.now,
    sleep: runtime.sleep,
    onVerification: (verification) => writeDeviceVerification(runtime, verification, command.json),
    ...(command.openBrowser ? { openBrowser: runtime.openBrowser } : {}),
  });
  const authentication = humanAuthenticationSchema.parse({
    version: 1,
    apiUrl,
    accessToken: authenticated.accessToken,
    refreshToken: authenticated.refreshToken,
    user: authenticated.user,
    ...(authenticated.workosOrganizationId === undefined
      ? {}
      : { workosOrganizationId: authenticated.workosOrganizationId }),
  });
  await writeHumanAuthentication(
    runtime.humanPaths,
    authentication,
    command.secretStore,
    runtime.random,
    runtime.humanSecretStore,
  );
  const profile = await readHumanProfile(runtime.humanPaths);
  writeData(runtime.io, humanProfileOutput(profile), command.json);
  return 0;
}

async function findOrganization(
  runtime: Runtime,
  organizationId: string,
  json: boolean,
): Promise<{ readonly ok: false; readonly exitCode: number } | { readonly ok: true; readonly organization: OrganizationView }> {
  let cursor: string | undefined;
  const seen = new Set<string>();
  while (true) {
    const call = await humanCall(runtime, json, "account", async (prepared) =>
      await prepared.client.listOrganizations(prepared.authentication.accessToken, {
        limit: 100,
        ...(cursor === undefined ? {} : { cursor }),
      }),
    );
    if (!call.ok) return call;
    if (!call.result.ok) {
      return { ok: false, exitCode: clientFailure(runtime, call.result.error, json) };
    }
    const found = call.result.data.organizations.find((organization) => organization.id === organizationId);
    if (found !== undefined) return { ok: true, organization: found };
    const nextCursor = call.result.data.cursor;
    if (nextCursor === null) break;
    if (seen.has(nextCursor)) {
      throw new TaskctlConfigError("SERVICE_UNAVAILABLE", "organization pagination did not advance");
    }
    if (seen.size >= 1_000) {
      throw new TaskctlConfigError("SERVICE_UNAVAILABLE", "organization pagination exceeded its limit");
    }
    seen.add(nextCursor);
    cursor = nextCursor;
  }
  throw new TaskctlConfigError("NOT_FOUND", "the organization was not found");
}

async function findWorkspace(
  runtime: Runtime,
  workspaceId: string,
  json: boolean,
): Promise<{ readonly ok: false; readonly exitCode: number } | { readonly ok: true; readonly workspace: WorkspaceView }> {
  let cursor: string | undefined;
  const seen = new Set<string>();
  while (true) {
    const call = await humanCall(runtime, json, "organization", async (prepared) =>
      await prepared.client.listWorkspaces(prepared.authentication.accessToken, {
        limit: 100,
        ...(cursor === undefined ? {} : { cursor }),
      }),
    );
    if (!call.ok) return call;
    if (!call.result.ok) {
      return { ok: false, exitCode: clientFailure(runtime, call.result.error, json) };
    }
    const found = call.result.data.workspaces.find((workspace) => workspace.id === workspaceId);
    if (found !== undefined) return { ok: true, workspace: found };
    const nextCursor = call.result.data.cursor;
    if (nextCursor === null) break;
    if (seen.has(nextCursor)) {
      throw new TaskctlConfigError("SERVICE_UNAVAILABLE", "workspace pagination did not advance");
    }
    if (seen.size >= 1_000) {
      throw new TaskctlConfigError("SERVICE_UNAVAILABLE", "workspace pagination exceeded its limit");
    }
    seen.add(nextCursor);
    cursor = nextCursor;
  }
  throw new TaskctlConfigError("NOT_FOUND", "the workspace was not found");
}

function generateEnrollmentToken(runtime: Runtime): EnrollmentToken {
  return formatEnrollmentToken(
    createLocator(runtime.random(26)),
    createBearerSecret(runtime.random(32)),
  );
}

async function enrollmentForOutput(
  runtime: Runtime,
  enrollmentOut: string,
  hasExplicitIdempotencyKey: boolean,
): Promise<EnrollmentToken> {
  const existingEnrollment = await readEnrollmentFile(enrollmentOut);
  if (existingEnrollment !== null) {
    if (!hasExplicitIdempotencyKey) {
      throw new TaskctlConfigError(
        "VALIDATION_ERROR",
        "enrollment output already exists; pass the original idempotency key to recover or choose a new path",
      );
    }
    return existingEnrollment;
  }
  const enrollment = generateEnrollmentToken(runtime);
  await writeNewEnrollmentFile(enrollmentOut, enrollment);
  return enrollment;
}

function selectedWorkspace(prepared: PreparedHumanAuthentication): WorkspaceView {
  const workspace = prepared.authentication.workspace;
  if (workspace === undefined) throw new Error("workspace selection invariant failed");
  return workspace;
}

async function execute(runtime: Runtime, command: CliCommand): Promise<number> {
  switch (command.kind) {
    case "help":
      writeUsage(runtime.io, USAGE, command.json);
      return 0;
    case "auth_enroll":
      return await authEnroll(runtime, command);
    case "auth_migrate_agent_credential": {
      const migrated = await migrateLegacyStoredCredential(
        runtime.paths,
        command.secretStore,
        runtime.random,
        runtime.agentSecretStore,
      );
      writeData(
        runtime.io,
        { migrated: true, source: command.secretStore, state: migrated.state },
        command.json,
      );
      return 0;
    }
    case "auth_login":
      return await authLogin(runtime, command);
    case "auth_status":
      return await authStatus(runtime, command);
    case "auth_logout": {
      await Promise.all([
        clearStoredAuthentication(runtime.paths, runtime.agentSecretStore),
        clearHumanAuthentication(runtime.humanPaths, runtime.humanSecretStore),
      ]);
      writeData(
        runtime.io,
        {
          loggedOut: true,
          humanLoggedOut: true,
          environmentOverridesActive:
            runtime.environment["TASKCTL_TOKEN"] !== undefined ||
            runtime.environment["TASKCTL_SESSION_ID"] !== undefined,
        },
        command.json,
      );
      return 0;
    }
    case "organization_list": {
      const call = await humanCall(runtime, command.json, "account", async (prepared) =>
        await prepared.client.listOrganizations(prepared.authentication.accessToken, {
          limit: command.limit,
          ...(command.cursor === undefined ? {} : { cursor: command.cursor }),
        }),
      );
      return outputHumanCall(
        runtime,
        call,
        command.json,
        (data: ListOrganizationsResponse, requestId) => ({ ...data, requestId }),
      );
    }
    case "organization_create": {
      const key = idempotencyKey(runtime, command.idempotencyKey);
      const call = await humanCall(runtime, command.json, "account", async (prepared) =>
        await prepared.client.createOrganization(
          prepared.authentication.accessToken,
          { name: command.name },
          key,
        ),
      );
      return outputHumanCall(
        runtime,
        call,
        command.json,
        (data: CreateOrganizationResponse, requestId) => ({
          ...data,
          requestId,
          idempotencyKey: key,
        }),
        key,
      );
    }
    case "organization_use": {
      const found = await findOrganization(runtime, command.organizationId, command.json);
      if (!found.ok) return found.exitCode;
      if (found.organization.status === "provisioning" || found.organization.workosOrganizationId === undefined) {
        throw new TaskctlConfigError(
          "PROVISIONING_IN_PROGRESS",
          "the organization is not ready to select",
        );
      }
      if (found.organization.status === "failed") {
        throw new TaskctlConfigError(
          "PROVISIONING_FAILED",
          "the organization could not be provisioned",
        );
      }
      const prepared = await prepareHumanAuthentication(runtime, "account");
      const refreshed = await refreshHumanAuthentication(
        runtime,
        prepared,
        command.json,
        found.organization,
      );
      if (!refreshed.ok) return refreshed.exitCode;
      writeData(
        runtime.io,
        {
          organization: found.organization,
          workspace: null,
          requestId: refreshed.requestId,
        },
        command.json,
      );
      return 0;
    }
    case "workspace_list": {
      const call = await humanCall(runtime, command.json, "organization", async (prepared) =>
        await prepared.client.listWorkspaces(prepared.authentication.accessToken, {
          limit: command.limit,
          ...(command.cursor === undefined ? {} : { cursor: command.cursor }),
        }),
      );
      return outputHumanCall(
        runtime,
        call,
        command.json,
        (data: ListWorkspacesResponse, requestId) => ({ ...data, requestId }),
      );
    }
    case "workspace_create": {
      const key = idempotencyKey(runtime, command.idempotencyKey);
      const call = await humanCall(runtime, command.json, "organization", async (prepared) =>
        await prepared.client.createWorkspace(
          prepared.authentication.accessToken,
          {
            name: command.name,
            slug: command.slug,
            taskKeyPrefix: command.taskKeyPrefix,
          },
          key,
        ),
      );
      return outputHumanCall(
        runtime,
        call,
        command.json,
        (data, requestId) => ({ ...data, requestId, idempotencyKey: key }),
        key,
      );
    }
    case "workspace_use": {
      const found = await findWorkspace(runtime, command.workspaceId, command.json);
      if (!found.ok) return found.exitCode;
      const prepared = await prepareHumanAuthentication(runtime, "organization");
      const organization = prepared.authentication.organization;
      if (organization === undefined || found.workspace.organizationId !== organization.id) {
        throw new TaskctlConfigError("NOT_FOUND", "the workspace was not found");
      }
      const nextAuthentication = humanAuthenticationSchema.parse({
        ...prepared.authentication,
        workspace: found.workspace,
      });
      await updateHumanAuthentication(
        runtime.humanPaths,
        prepared.profile,
        nextAuthentication,
        runtime.random,
        runtime.humanSecretStore,
      );
      writeData(
        runtime.io,
        { organization, workspace: found.workspace },
        command.json,
      );
      return 0;
    }
    case "agent_create": {
      const key = idempotencyKey(runtime, command.idempotencyKey);
      const prepared = await prepareHumanAuthentication(runtime, "workspace");
      selectedWorkspace(prepared);
      let enrollment: EnrollmentToken;
      try {
        enrollment = await enrollmentForOutput(
          runtime,
          command.enrollmentOut,
          command.idempotencyKey !== undefined,
        );
      } catch (error) {
        if (error instanceof TaskctlConfigError) {
          return configurationFailure(runtime, error, command.json, key);
        }
        throw error;
      }
      const call = await humanCall(runtime, command.json, "workspace", async (current) =>
        await current.client.createAgent(
          current.authentication.accessToken,
          {
            workspaceId: selectedWorkspace(current).id,
            name: command.name,
            preset: command.preset,
            enrollment,
            ...(command.scopes === undefined ? {} : { scopes: [...command.scopes] }),
            ...(command.credentialLifetimeMs === undefined
              ? {}
              : { credentialLifetimeMs: command.credentialLifetimeMs }),
          },
          key,
        ),
      );
      return outputHumanCall(
        runtime,
        call,
        command.json,
        (data: CreateAgentResponse, requestId) => ({
          ...data,
          enrollmentOut: command.enrollmentOut,
          requestId,
          idempotencyKey: key,
        }),
        key,
      );
    }
    case "agent_list": {
      const call = await humanCall(runtime, command.json, "workspace", async (prepared) =>
        await prepared.client.listAgents(prepared.authentication.accessToken, {
          workspaceId: selectedWorkspace(prepared).id,
          limit: command.limit,
          ...(command.cursor === undefined ? {} : { cursor: command.cursor }),
        }),
      );
      return outputHumanCall(
        runtime,
        call,
        command.json,
        (data: ListAgentsResponse, requestId) => ({ ...data, requestId }),
      );
    }
    case "agent_show": {
      const call = await humanCall(runtime, command.json, "workspace", async (prepared) =>
        await prepared.client.getAgent(
          prepared.authentication.accessToken,
          command.agentId,
          selectedWorkspace(prepared).id,
        ),
      );
      return outputHumanCall(
        runtime,
        call,
        command.json,
        (data: GetAgentResponse, requestId) => ({ ...data, requestId }),
      );
    }
    case "agent_enrollment_create": {
      const key = idempotencyKey(runtime, command.idempotencyKey);
      const prepared = await prepareHumanAuthentication(runtime, "workspace");
      selectedWorkspace(prepared);
      let enrollment: EnrollmentToken;
      try {
        enrollment = await enrollmentForOutput(
          runtime,
          command.enrollmentOut,
          command.idempotencyKey !== undefined,
        );
      } catch (error) {
        if (error instanceof TaskctlConfigError) {
          return configurationFailure(runtime, error, command.json, key);
        }
        throw error;
      }
      const call = await humanCall(runtime, command.json, "workspace", async (current) =>
        await current.client.createAgentEnrollment(
          current.authentication.accessToken,
          command.agentId,
          {
            workspaceId: selectedWorkspace(current).id,
            enrollment,
            ...(command.scopes === undefined ? {} : { scopes: [...command.scopes] }),
            ...(command.credentialLifetimeMs === undefined
              ? {}
              : { credentialLifetimeMs: command.credentialLifetimeMs }),
          },
          key,
        ),
      );
      return outputHumanCall(
        runtime,
        call,
        command.json,
        (data: CreateAgentEnrollmentResponse, requestId) => ({
          ...data,
          enrollmentOut: command.enrollmentOut,
          requestId,
          idempotencyKey: key,
        }),
        key,
      );
    }
    case "agent_credential_list": {
      const call = await humanCall(runtime, command.json, "workspace", async (prepared) =>
        await prepared.client.listAgentCredentials(
          prepared.authentication.accessToken,
          command.agentId,
          {
            workspaceId: selectedWorkspace(prepared).id,
            limit: command.limit,
            ...(command.cursor === undefined ? {} : { cursor: command.cursor }),
          },
        ),
      );
      return outputHumanCall(
        runtime,
        call,
        command.json,
        (data: ListAgentCredentialsResponse, requestId) => ({ ...data, requestId }),
      );
    }
    case "agent_credential_revoke": {
      const key = idempotencyKey(runtime, command.idempotencyKey);
      const call = await humanCall(runtime, command.json, "workspace", async (prepared) =>
        await prepared.client.revokeAgentCredential(
          prepared.authentication.accessToken,
          command.agentId,
          command.credentialId,
          { workspaceId: selectedWorkspace(prepared).id },
          key,
        ),
      );
      return outputHumanCall(
        runtime,
        call,
        command.json,
        (data, requestId) => ({ ...data, requestId, idempotencyKey: key }),
        key,
      );
    }
    case "agent_session_list": {
      const call = await humanCall(runtime, command.json, "workspace", async (prepared) =>
        await prepared.client.listAgentSessions(
          prepared.authentication.accessToken,
          command.agentId,
          {
            workspaceId: selectedWorkspace(prepared).id,
            limit: command.limit,
            ...(command.cursor === undefined ? {} : { cursor: command.cursor }),
          },
        ),
      );
      return outputHumanCall(
        runtime,
        call,
        command.json,
        (data: ListAgentSessionsResponse, requestId) => ({ ...data, requestId }),
      );
    }
    case "agent_disable": {
      const key = idempotencyKey(runtime, command.idempotencyKey);
      const call = await humanCall(runtime, command.json, "workspace", async (prepared) =>
        await prepared.client.disableAgent(
          prepared.authentication.accessToken,
          command.agentId,
          { workspaceId: selectedWorkspace(prepared).id },
          key,
        ),
      );
      return outputHumanCall(
        runtime,
        call,
        command.json,
        (data, requestId) => ({ ...data, requestId, idempotencyKey: key }),
        key,
      );
    }
    case "workspace_repo_list": {
      const call = await humanCall(runtime, command.json, "workspace", async (prepared) =>
        await prepared.client.listWorkspaceRepositories(prepared.authentication.accessToken, {
          workspaceId: selectedWorkspace(prepared).id,
          limit: command.limit,
          ...(command.cursor === undefined ? {} : { cursor: command.cursor }),
        }),
      );
      return outputHumanCall(runtime, call, command.json, (data, requestId) => ({ ...data, requestId }));
    }
    case "workspace_repo_add": {
      const key = idempotencyKey(runtime, command.idempotencyKey);
      const call = await humanCall(runtime, command.json, "workspace", async (prepared) =>
        await prepared.client.createWorkspaceRepository(
          prepared.authentication.accessToken,
          {
            workspaceId: selectedWorkspace(prepared).id,
            name: command.name,
            provider: command.provider,
            url: command.url,
          },
          key,
        ),
      );
      return outputHumanCall(runtime, call, command.json, (data, requestId) => ({
        ...data,
        requestId,
        idempotencyKey: key,
      }), key);
    }
    case "workspace_repo_remove": {
      const key = idempotencyKey(runtime, command.idempotencyKey);
      const call = await humanCall(runtime, command.json, "workspace", async (prepared) =>
        await prepared.client.removeWorkspaceRepository(
          prepared.authentication.accessToken,
          command.repositoryId,
          selectedWorkspace(prepared).id,
          key,
        ),
      );
      return outputHumanCall(runtime, call, command.json, (data, requestId) => ({
        ...data,
        requestId,
        idempotencyKey: key,
      }), key);
    }
    case "context": {
      const call = await authenticatedCall(runtime, command.json, async (client, authorization) =>
        await client.context(authorization),
      );
      return outputAuthenticatedCall(runtime, call, command.json, (data, requestId, sessionKeys) => {
        const { sessionId: _sessionId, ...principal } = data.principal;
        void _sessionId;
        return {
          ...data,
          principal,
          requestId,
          ...sessionIdempotencyOutput(sessionKeys),
        };
      });
    }
    case "task_create": {
      const key = idempotencyKey(runtime, command.idempotencyKey);
      const call = await authenticatedCall(
        runtime,
        command.json,
        async (client, authorization) =>
          await client.createTask(
            authorization,
            {
              title: command.title,
              ...(command.description === undefined ? {} : { description: command.description }),
              type: command.type,
              priority: command.priority,
              ...(command.availableAt === undefined
                ? {}
                : { availableAt: command.availableAt }),
              ...(command.parentKey === undefined ? {} : { parentKey: command.parentKey }),
              ...(command.labels === undefined ? {} : { labels: [...command.labels] }),
            },
            key,
          ),
      );
      return outputAuthenticatedCall(
        runtime,
        call,
        command.json,
        (data, requestId, sessionKeys) => ({
          ...data,
          requestId,
          idempotencyKey: key,
          ...sessionIdempotencyOutput(sessionKeys),
        }),
        key,
      );
    }
    case "task_show": {
      const call = await authenticatedCall(runtime, command.json, async (client, authorization) =>
        await client.getTask(authorization, command.key),
      );
      return outputAuthenticatedCall(runtime, call, command.json, (data, requestId, sessionKeys) => ({
        ...data,
        requestId,
        ...sessionIdempotencyOutput(sessionKeys),
      }));
    }
    case "task_list": {
      const call = await authenticatedCall(runtime, command.json, async (client, authorization) =>
        await client.listTasks(authorization, {
          limit: command.limit,
          ...(command.cursor === undefined ? {} : { cursor: command.cursor }),
          ...(command.status === undefined ? {} : { status: command.status }),
          ...(command.type === undefined ? {} : { type: command.type }),
          ...(command.priority === undefined ? {} : { priority: command.priority }),
          ...(command.assigneeAgentId === undefined ? {} : { assigneeAgentId: command.assigneeAgentId }),
          ...(command.label === undefined ? {} : { label: command.label }),
          ...(command.parentKey === undefined ? {} : { parentKey: command.parentKey }),
          ...(command.updatedAfter === undefined ? {} : { updatedAfter: command.updatedAfter }),
        }),
      );
      return outputAuthenticatedCall(runtime, call, command.json, (data, requestId, sessionKeys) => ({
        ...data,
        requestId,
        ...sessionIdempotencyOutput(sessionKeys),
      }));
    }
    case "task_ready": {
      const call = await authenticatedCall(runtime, command.json, async (client, authorization) =>
        await client.readyTasks(authorization, {
          limit: command.limit,
          ...(command.cursor === undefined ? {} : { cursor: command.cursor }),
        }),
      );
      return outputAuthenticatedCall(
        runtime,
        call,
        command.json,
        (data, requestId, sessionKeys) => ({
          ...data,
          requestId,
          ...sessionIdempotencyOutput(sessionKeys),
        }),
      );
    }
    case "task_blocked": {
      const call = await authenticatedCall(runtime, command.json, async (client, authorization) =>
        await client.blockedTasks(authorization, {
          limit: command.limit,
          attentionOnly: command.attentionOnly,
          ...(command.cursor === undefined ? {} : { cursor: command.cursor }),
        }),
      );
      return outputAuthenticatedCall(runtime, call, command.json, (data, requestId, sessionKeys) => ({
        ...data,
        requestId,
        ...sessionIdempotencyOutput(sessionKeys),
      }));
    }
    case "task_update": {
      const key = idempotencyKey(runtime, command.idempotencyKey);
      const call = await claimBoundAuthenticatedCall(
        runtime,
        command.json,
        command.key,
        key,
        async (client, authorization, claim) => {
          const fence = claim?.fence ?? command.fence;
          return await client.updateTask(
            authorization,
            command.key,
            {
              revision: claim?.revision ?? command.revision,
              ...(fence === undefined ? {} : { fence }),
              ...(command.title === undefined ? {} : { title: command.title }),
              ...(command.description === undefined ? {} : { description: command.description }),
              ...(command.type === undefined ? {} : { type: command.type }),
              ...(command.priority === undefined ? {} : { priority: command.priority }),
            },
            key,
          );
        },
      );
      return outputAuthenticatedCall(runtime, call, command.json, (data, requestId, sessionKeys, renewal) => ({
        ...data,
        requestId,
        idempotencyKey: key,
        ...sessionIdempotencyOutput(sessionKeys),
        ...automaticClaimRenewalOutput(renewal),
      }), key);
    }
    case "task_cancel": {
      const key = idempotencyKey(runtime, command.idempotencyKey);
      const call = await humanCall(runtime, command.json, "workspace", async (prepared) =>
        await prepared.client.cancelTask(
          prepared.authentication.accessToken,
          command.key,
          { workspaceId: selectedWorkspace(prepared).id, revision: command.revision, reason: command.reason },
          key,
        ),
      );
      return outputHumanCall(runtime, call, command.json, (data, requestId) => ({ ...data, requestId, idempotencyKey: key }), key);
    }
    case "task_reopen": {
      const key = idempotencyKey(runtime, command.idempotencyKey);
      const call = await humanCall(runtime, command.json, "workspace", async (prepared) =>
        await prepared.client.reopenTask(
          prepared.authentication.accessToken,
          command.key,
          { workspaceId: selectedWorkspace(prepared).id, revision: command.revision },
          key,
        ),
      );
      return outputHumanCall(runtime, call, command.json, (data, requestId) => ({ ...data, requestId, idempotencyKey: key }), key);
    }
    case "task_assign": {
      const key = idempotencyKey(runtime, command.idempotencyKey);
      const call = await claimBoundAuthenticatedCall(runtime, command.json, command.key, key, async (client, authorization, claim) => {
        const fence = claim?.fence ?? command.fence;
        return await client.assignTask(authorization, command.key, {
          revision: claim?.revision ?? command.revision,
          assigneeAgentId: command.assigneeAgentId,
          ...(fence === undefined ? {} : { fence }),
        }, key);
      });
      return outputAuthenticatedCall(runtime, call, command.json, (data, requestId, sessionKeys, renewal) => ({ ...data, requestId, idempotencyKey: key, ...sessionIdempotencyOutput(sessionKeys), ...automaticClaimRenewalOutput(renewal) }), key);
    }
    case "task_defer": {
      const key = idempotencyKey(runtime, command.idempotencyKey);
      const call = await claimBoundAuthenticatedCall(runtime, command.json, command.key, key, async (client, authorization, claim) => {
        const fence = claim?.fence ?? command.fence;
        return await client.deferTask(authorization, command.key, { revision: claim?.revision ?? command.revision, availableAt: command.availableAt, ...(fence === undefined ? {} : { fence }) }, key);
      },
      );
      return outputAuthenticatedCall(runtime, call, command.json, (data, requestId, sessionKeys, renewal) => ({ ...data, requestId, idempotencyKey: key, ...sessionIdempotencyOutput(sessionKeys), ...automaticClaimRenewalOutput(renewal) }), key);
    }
    case "task_label_list": {
      const call = await authenticatedCall(runtime, command.json, async (client, authorization) =>
        await client.listTaskLabels(authorization, command.key),
      );
      return outputAuthenticatedCall(runtime, call, command.json, (data, requestId, sessionKeys) => ({ ...data, requestId, ...sessionIdempotencyOutput(sessionKeys) }));
    }
    case "task_label_add":
    case "task_label_remove": {
      const key = idempotencyKey(runtime, command.idempotencyKey);
      const call = await claimBoundAuthenticatedCall(runtime, command.json, command.key, key, async (client, authorization, claim) => {
        const fence = claim?.fence ?? command.fence;
        return await client.mutateTaskLabel(
          authorization,
          command.key,
          command.kind === "task_label_add" ? "add" : "remove",
          { revision: claim?.revision ?? command.revision, label: command.label, ...(fence === undefined ? {} : { fence }) },
          key,
        );
      },
      );
      return outputAuthenticatedCall(runtime, call, command.json, (data, requestId, sessionKeys, renewal) => ({ ...data, requestId, idempotencyKey: key, ...sessionIdempotencyOutput(sessionKeys), ...automaticClaimRenewalOutput(renewal) }), key);
    }
    case "task_comment_add": {
      const key = idempotencyKey(runtime, command.idempotencyKey);
      const call = await authenticatedCall(runtime, command.json, async (client, authorization) =>
        await client.addTaskComment(authorization, command.key, { body: command.body }, key),
      );
      return outputAuthenticatedCall(runtime, call, command.json, (data, requestId, sessionKeys) => ({ ...data, requestId, idempotencyKey: key, ...sessionIdempotencyOutput(sessionKeys) }), key);
    }
    case "task_comment_list": {
      const call = await authenticatedCall(runtime, command.json, async (client, authorization) =>
        await client.listTaskComments(authorization, command.key, { limit: command.limit, ...(command.cursor === undefined ? {} : { cursor: command.cursor }) }),
      );
      return outputAuthenticatedCall(runtime, call, command.json, (data, requestId, sessionKeys) => ({ ...data, requestId, ...sessionIdempotencyOutput(sessionKeys) }));
    }
    case "task_events": {
      const call = await authenticatedCall(runtime, command.json, async (client, authorization) =>
        await client.listTaskEvents(authorization, command.key, { limit: command.limit, ...(command.cursor === undefined ? {} : { cursor: command.cursor }) }),
      );
      return outputAuthenticatedCall(runtime, call, command.json, (data, requestId, sessionKeys) => ({ ...data, requestId, ...sessionIdempotencyOutput(sessionKeys) }));
    }
    case "task_graph": {
      const call = await authenticatedCall(runtime, command.json, async (client, authorization) =>
        await client.taskGraph(authorization, command.key, { depth: command.depth, limit: command.limit }),
      );
      return outputAuthenticatedCall(runtime, call, command.json, (data, requestId, sessionKeys) => ({ ...data, requestId, ...sessionIdempotencyOutput(sessionKeys) }));
    }
    case "task_dep_list": {
      const call = await authenticatedCall(runtime, command.json, async (client, authorization) =>
        await client.listTaskDependencies(authorization, command.key, {
          direction: command.direction,
          limit: command.limit,
          ...(command.cursor === undefined ? {} : { cursor: command.cursor }),
        }),
      );
      return outputAuthenticatedCall(runtime, call, command.json, (data, requestId, sessionKeys) => ({ ...data, requestId, ...sessionIdempotencyOutput(sessionKeys) }));
    }
    case "task_dep_add":
    case "task_dep_remove": {
      const key = idempotencyKey(runtime, command.idempotencyKey);
      const call = await claimBoundAuthenticatedCall(runtime, command.json, command.key, key, async (client, authorization, claim) => {
        const fence = claim?.fence ?? command.fence;
        return await client.mutateTaskDependency(
          authorization,
          command.key,
          command.kind === "task_dep_add" ? "add" : "remove",
          { revision: claim?.revision ?? command.revision, blockerKey: command.blockerKey, ...(fence === undefined ? {} : { fence }) },
          key,
        );
      },
      );
      return outputAuthenticatedCall(runtime, call, command.json, (data, requestId, sessionKeys, renewal) => ({ ...data, requestId, idempotencyKey: key, ...sessionIdempotencyOutput(sessionKeys), ...automaticClaimRenewalOutput(renewal) }), key);
    }
    case "task_parent_set": {
      const key = idempotencyKey(runtime, command.idempotencyKey);
      const call = await claimBoundAuthenticatedCall(runtime, command.json, command.key, key, async (client, authorization, claim) => {
        const fence = claim?.fence ?? command.fence;
        return await client.setTaskParent(authorization, command.key, { revision: claim?.revision ?? command.revision, parentKey: command.parentKey, ...(fence === undefined ? {} : { fence }) }, key);
      },
      );
      return outputAuthenticatedCall(runtime, call, command.json, (data, requestId, sessionKeys, renewal) => ({ ...data, requestId, idempotencyKey: key, ...sessionIdempotencyOutput(sessionKeys), ...automaticClaimRenewalOutput(renewal) }), key);
    }
    case "task_parent_clear": {
      const key = idempotencyKey(runtime, command.idempotencyKey);
      const call = await claimBoundAuthenticatedCall(runtime, command.json, command.key, key, async (client, authorization, claim) => {
        const fence = claim?.fence ?? command.fence;
        return await client.clearTaskParent(authorization, command.key, { revision: claim?.revision ?? command.revision, ...(fence === undefined ? {} : { fence }) }, key);
      },
      );
      return outputAuthenticatedCall(runtime, call, command.json, (data, requestId, sessionKeys, renewal) => ({ ...data, requestId, idempotencyKey: key, ...sessionIdempotencyOutput(sessionKeys), ...automaticClaimRenewalOutput(renewal) }), key);
    }
    case "task_ref_list": {
      const call = await authenticatedCall(runtime, command.json, async (client, authorization) =>
        await client.listTaskReferences(authorization, command.key, { limit: command.limit, ...(command.cursor === undefined ? {} : { cursor: command.cursor }) }),
      );
      return outputAuthenticatedCall(runtime, call, command.json, (data, requestId, sessionKeys) => ({ ...data, requestId, ...sessionIdempotencyOutput(sessionKeys) }));
    }
    case "task_ref_add": {
      const key = idempotencyKey(runtime, command.idempotencyKey);
      const call = await claimBoundAuthenticatedCall(runtime, command.json, command.key, key, async (client, authorization, claim) => {
        const fence = claim?.fence ?? command.fence;
        return await client.addTaskReference(authorization, command.key, { revision: claim?.revision ?? command.revision, reference: command.reference, ...(fence === undefined ? {} : { fence }) }, key);
      },
      );
      return outputAuthenticatedCall(runtime, call, command.json, (data, requestId, sessionKeys, renewal) => ({ ...data, requestId, idempotencyKey: key, ...sessionIdempotencyOutput(sessionKeys), ...automaticClaimRenewalOutput(renewal) }), key);
    }
    case "task_ref_remove": {
      const key = idempotencyKey(runtime, command.idempotencyKey);
      const call = await claimBoundAuthenticatedCall(runtime, command.json, command.key, key, async (client, authorization, claim) => {
        const fence = claim?.fence ?? command.fence;
        return await client.removeTaskReference(authorization, command.key, command.referenceId, { revision: claim?.revision ?? command.revision, ...(fence === undefined ? {} : { fence }) }, key);
      },
      );
      return outputAuthenticatedCall(runtime, call, command.json, (data, requestId, sessionKeys, renewal) => ({ ...data, requestId, idempotencyKey: key, ...sessionIdempotencyOutput(sessionKeys), ...automaticClaimRenewalOutput(renewal) }), key);
    }
    case "task_claim": {
      const key = idempotencyKey(runtime, command.idempotencyKey);
      const call = await authenticatedCall(runtime, command.json, async (client, authorization) =>
        await client.claimTask(authorization, command.key, key),
      );
      return outputAuthenticatedCall(
        runtime,
        call,
        command.json,
        (data, requestId, sessionKeys) => ({
          ...data,
          requestId,
          idempotencyKey: key,
          ...sessionIdempotencyOutput(sessionKeys),
        }),
        key,
      );
    }
    case "task_claim_renew": {
      const key = idempotencyKey(runtime, command.idempotencyKey);
      const call = await authenticatedCall(
        runtime,
        command.json,
        async (client, authorization) =>
          await client.renewClaim(
            authorization,
            command.key,
            { fence: command.fence },
            key,
          ),
      );
      return outputAuthenticatedCall(
        runtime,
        call,
        command.json,
        (data, requestId, sessionKeys) => ({
          ...data,
          requestId,
          idempotencyKey: key,
          ...sessionIdempotencyOutput(sessionKeys),
        }),
        key,
      );
    }
    case "task_release": {
      const key = idempotencyKey(runtime, command.idempotencyKey);
      const call = await claimBoundAuthenticatedCall(
        runtime,
        command.json,
        command.key,
        key,
        async (client, authorization, claim) =>
          await client.releaseClaim(
            authorization,
            command.key,
            { fence: claim?.fence ?? command.fence },
            key,
          ),
      );
      return outputAuthenticatedCall(
        runtime,
        call,
        command.json,
        (data, requestId, sessionKeys, renewal) => ({
          ...data,
          requestId,
          idempotencyKey: key,
          ...sessionIdempotencyOutput(sessionKeys),
          ...automaticClaimRenewalOutput(renewal),
        }),
        key,
      );
    }
    case "task_submit": {
      const key = idempotencyKey(runtime, command.idempotencyKey);
      const call = await claimBoundAuthenticatedCall(runtime, command.json, command.key, key, async (client, authorization, claim) =>
        await client.submitTask(
          authorization,
          command.key,
          { fence: claim?.fence ?? command.fence, summary: command.summary, evidence: [...command.evidence] },
          key,
        ),
      );
      return outputAuthenticatedCall(runtime, call, command.json, (data, requestId, sessionKeys, renewal) => ({ ...data, requestId, idempotencyKey: key, ...sessionIdempotencyOutput(sessionKeys), ...automaticClaimRenewalOutput(renewal) }), key);
    }
    case "review_queue": {
      const call = await authenticatedCall(runtime, command.json, async (client, authorization) =>
        await client.reviewQueue(authorization, { limit: command.limit, ...(command.cursor === undefined ? {} : { cursor: command.cursor }) }),
      );
      return outputAuthenticatedCall(runtime, call, command.json, (data, requestId, sessionKeys) => ({ ...data, requestId, ...sessionIdempotencyOutput(sessionKeys) }));
    }
    case "task_accept": {
      const key = idempotencyKey(runtime, command.idempotencyKey);
      const call = await authenticatedCall(runtime, command.json, async (client, authorization) =>
        await client.acceptTask(
          authorization,
          command.key,
          { submissionId: command.submissionId, reviewRevision: command.reviewRevision },
          key,
        ),
      );
      return outputAuthenticatedCall(runtime, call, command.json, (data, requestId, sessionKeys) => ({ ...data, requestId, idempotencyKey: key, ...sessionIdempotencyOutput(sessionKeys) }), key);
    }
    case "task_reject": {
      const key = idempotencyKey(runtime, command.idempotencyKey);
      if (command.reason === undefined) throw new Error("task reject reason invariant failed");
      const call = await authenticatedCall(runtime, command.json, async (client, authorization) =>
        await client.rejectTask(
          authorization,
          command.key,
          {
            submissionId: command.submissionId,
            reviewRevision: command.reviewRevision,
            reason: command.reason as string,
          },
          key,
        ),
      );
      return outputAuthenticatedCall(runtime, call, command.json, (data, requestId, sessionKeys) => ({ ...data, requestId, idempotencyKey: key, ...sessionIdempotencyOutput(sessionKeys) }), key);
    }
  }
}

export async function runCli(argv: readonly string[], options: RunCliOptions = {}): Promise<number> {
  const environment = options.environment ?? process.env;
  const io = options.io ?? processIo;
  const random = options.random ?? webCryptoRandomBytes;
  const paths = options.storagePaths ?? resolveStoragePaths(environment);
  const humanPaths = resolveHumanStoragePaths(environment, paths);
  const runtime: Runtime = {
    environment,
    io,
    now: options.now ?? Date.now,
    random,
    paths,
    humanPaths,
    agentSecretStore: options.agentSecretStore ?? bunAgentSecretStore,
    humanSecretStore: options.humanSecretStore ?? bunHumanSecretStore,
    sleep:
      options.sleep ??
      (async (milliseconds) =>
        await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, milliseconds))),
    openBrowser: options.openBrowser ?? openVerificationUrl,
    issuedIdempotencyKeys: new Set<IdempotencyKey>(),
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
  };

  const parsed = parseArgs(argv);
  if (!parsed.ok) {
    return writeFailure(
      io,
      {
        code: "VALIDATION_ERROR",
        message: parsed.message,
        requestId: localRequestId(runtime),
        details: {},
      },
      parsed.json,
    );
  }

  try {
    return await execute(runtime, parsed.command);
  } catch (error) {
    if (error instanceof TaskctlConfigError) {
      return writeFailure(
        io,
        { code: error.code, message: error.message, requestId: localRequestId(runtime), details: {} },
        parsed.command.json,
      );
    }
    return writeFailure(
      io,
      {
        code: "INTERNAL_ERROR",
        message: "taskctl could not complete the command",
        requestId: localRequestId(runtime),
        details: {},
      },
      parsed.command.json,
    );
  }
}

if (import.meta.main) {
  process.exitCode = await runCli(Bun.argv.slice(2));
}
