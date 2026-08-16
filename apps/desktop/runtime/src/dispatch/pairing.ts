import {
  agentIdSchema,
  agentPresetScopes,
  agentScopeSchema,
  createUuidV7,
  credentialTokenSchema,
  epochMsSchema,
  locatorSchema,
  parseCredentialToken,
  redactSecretsInText,
  repositoryIdSchema,
  sessionIdSchema,
  uuidV7Schema,
  type CredentialToken,
  type IdempotencyKey,
  type SessionId,
  type StartSessionResponse,
} from "@hraness/agent-tasks-protocol";
import { z } from "@hra-internal/schema";
import { optionalRenamedEnvironmentValue } from "../security/renamed-environment";
import { constants } from "node:fs";
import { chmod, mkdir, open, rename, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";

import {
  normalizeDispatchApiOrigin,
  HRADispatchSessionClient,
  type DispatchCloudResult,
} from "./cloud-client";

const MAX_CONFIGURATION_BYTES = 1_024 * 1_024;
const MINIMUM_STARTUP_SESSION_VALIDITY_MS = 60_000;
const TASKCTL_KEYCHAIN_SERVICE = "com.jungle.taskctl";

const profileSchema = z.object({
  version: z.literal(1),
  apiUrl: z.string(),
  agentId: agentIdSchema,
  credentialId: z.string().min(1).max(128).optional(),
  credentialExpiresAt: epochMsSchema.optional(),
  scopes: z.array(agentScopeSchema),
}).strict();

const credentialMetadataSchema = z.object({
  version: z.literal(1),
  state: z.literal("active"),
  secretStore: z.literal("keychain"),
  credentialLocator: locatorSchema,
  sessionId: sessionIdSchema,
  sessionExpiresAt: epochMsSchema,
}).strict();

const sessionAttemptSchema = z.object({
  version: z.literal(1),
  apiUrl: z.string(),
  credentialLocator: locatorSchema,
  idempotencyKey: uuidV7Schema,
}).strict();

const repositoryMappingSchema = z.object({
  repositoryId: repositoryIdSchema,
  repositoryPath: z.string().min(1).max(4_096),
}).strict();

export interface DispatchSecretStore {
  get(input: { readonly service: string; readonly name: string }): Promise<string | null>;
}

export interface DispatchPairingRandom {
  bytes(length: number): Uint8Array;
}

export interface DispatchPairingSessionStarter {
  startSession(input: {
    readonly apiOrigin: string;
    readonly credential: CredentialToken;
    readonly idempotencyKey: IdempotencyKey;
  }): Promise<DispatchCloudResult<StartSessionResponse>>;
}

export interface PairedDispatchAuthorization {
  readonly apiOrigin: string;
  readonly credential: CredentialToken;
  readonly sessionId: SessionId;
}

export interface DispatchRepositoryMapping {
  readonly repositoryId: string;
  readonly repositoryPath: string;
}

export type DispatchPairingEnvironment = Readonly<Record<string, string | undefined>>;

export class DispatchPairingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DispatchPairingError";
  }
}

interface StoredDispatchPairing {
  readonly authorization: PairedDispatchAuthorization;
  readonly credentialLocator: string;
  readonly credentialMetadataFile: string;
  readonly sessionAttemptFile: string;
  readonly sessionExpiresAt: number;
}

const systemRandom: DispatchPairingRandom = {
  bytes(length) {
    const value = new Uint8Array(length);
    crypto.getRandomValues(value);
    return value;
  },
};

const defaultSessionStarter: DispatchPairingSessionStarter = {
  async startSession(input) {
    return await new HRADispatchSessionClient({
      apiOrigin: input.apiOrigin,
      credential: input.credential,
    }).startSession(input.idempotencyKey);
  },
};

export interface DispatchPairingOptions {
  readonly environment?: DispatchPairingEnvironment;
  readonly now?: number;
  readonly random?: DispatchPairingRandom;
  readonly secrets?: DispatchSecretStore;
  readonly sessionStarter?: DispatchPairingSessionStarter;
}

export async function loadPairedDispatchAuthorization(
  options: Omit<DispatchPairingOptions, "random" | "sessionStarter"> = {},
): Promise<PairedDispatchAuthorization | null> {
  const loaded = await loadPairedDispatchPairing(options);
  if (loaded === null) return null;
  if (!("sessionExpiresAt" in loaded)) return loaded;
  if (loaded.sessionExpiresAt <= (options.now ?? Date.now())) {
    throw new DispatchPairingError("The local taskctl runner session is unavailable.");
  }
  return loaded.authorization;
}

/**
 * Resolve startup authorization and mint a replacement short-lived session
 * when taskctl's local session metadata has expired. The long-lived credential
 * remains in the OS keychain; only non-secret session metadata is rewritten.
 */
export async function recoverPairedDispatchAuthorization(
  options: DispatchPairingOptions = {},
): Promise<PairedDispatchAuthorization | null> {
  const now = options.now ?? Date.now();
  const loaded = await loadPairedDispatchPairing(options);
  if (loaded === null) return null;
  if (!("sessionExpiresAt" in loaded)) return loaded;
  if (loaded.sessionExpiresAt > now + MINIMUM_STARTUP_SESSION_VALIDITY_MS) {
    return loaded.authorization;
  }

  const random = options.random ?? systemRandom;
  const starter = options.sessionStarter ?? defaultSessionStarter;
  const rawAttempt = await readOwnedJson(loaded.sessionAttemptFile);
  const parsedAttempt = rawAttempt === null ? null : sessionAttemptSchema.safeParse(rawAttempt);
  if (parsedAttempt !== null && !parsedAttempt.success) {
    throw new DispatchPairingError("The local taskctl session recovery state is invalid.");
  }
  const attempt = parsedAttempt?.data ?? {
    version: 1 as const,
    apiUrl: loaded.authorization.apiOrigin,
    credentialLocator: loaded.credentialLocator,
    idempotencyKey: createUuidV7(now, random.bytes(10)),
  };
  if (
    attempt.apiUrl !== loaded.authorization.apiOrigin ||
    attempt.credentialLocator !== loaded.credentialLocator
  ) {
    throw new DispatchPairingError("The local taskctl session recovery state does not match the runner.");
  }
  if (parsedAttempt === null) {
    await writeOwnedJson(loaded.sessionAttemptFile, sessionAttemptSchema.parse(attempt), random);
  }

  const started = await starter.startSession({
    apiOrigin: loaded.authorization.apiOrigin,
    credential: loaded.authorization.credential,
    idempotencyKey: attempt.idempotencyKey,
  });
  if (!started.ok) {
    if (started.error.kind === "remote") await removeOwnedFile(loaded.sessionAttemptFile);
    throw new DispatchPairingError("The task service did not authorize a runner session.");
  }
  if (started.data.expiresAt <= now + MINIMUM_STARTUP_SESSION_VALIDITY_MS) {
    await removeOwnedFile(loaded.sessionAttemptFile);
    throw new DispatchPairingError("The task service returned an unavailable runner session.");
  }

  const currentMetadata = credentialMetadataSchema.safeParse(
    await readOwnedJson(loaded.credentialMetadataFile),
  );
  if (
    !currentMetadata.success ||
    currentMetadata.data.credentialLocator !== loaded.credentialLocator
  ) {
    throw new DispatchPairingError("The local taskctl runner changed during session recovery.");
  }
  if (
    currentMetadata.data.sessionId !== loaded.authorization.sessionId ||
    currentMetadata.data.sessionExpiresAt !== loaded.sessionExpiresAt
  ) {
    if (currentMetadata.data.sessionExpiresAt <= now + MINIMUM_STARTUP_SESSION_VALIDITY_MS) {
      throw new DispatchPairingError("The local taskctl runner changed during session recovery.");
    }
    await removeOwnedFile(loaded.sessionAttemptFile);
    return {
      apiOrigin: loaded.authorization.apiOrigin,
      credential: loaded.authorization.credential,
      sessionId: currentMetadata.data.sessionId,
    };
  }

  const refreshed = credentialMetadataSchema.parse({
    version: 1,
    state: "active",
    secretStore: "keychain",
    credentialLocator: loaded.credentialLocator,
    sessionId: started.data.sessionId,
    sessionExpiresAt: started.data.expiresAt,
  });
  await writeOwnedJson(loaded.credentialMetadataFile, refreshed, random);
  await removeOwnedFile(loaded.sessionAttemptFile);
  return {
    apiOrigin: loaded.authorization.apiOrigin,
    credential: loaded.authorization.credential,
    sessionId: refreshed.sessionId,
  };
}

async function loadPairedDispatchPairing(
  options: Omit<DispatchPairingOptions, "random" | "sessionStarter">,
): Promise<PairedDispatchAuthorization | StoredDispatchPairing | null> {
  const environment = options.environment ?? process.env;
  const injectedCredential = environment["TASKCTL_TOKEN"];
  const injectedSession = environment["TASKCTL_SESSION_ID"];
  if (injectedCredential !== undefined || injectedSession !== undefined) {
    const credential = credentialTokenSchema.safeParse(injectedCredential);
    const sessionId = sessionIdSchema.safeParse(injectedSession);
    const apiOrigin = normalizedOrigin(environment["TASKCTL_API_URL"]);
    if (!credential.success || !sessionId.success || apiOrigin === null) {
      throw new DispatchPairingError("The injected runner authorization is invalid.");
    }
    return {
      apiOrigin,
      credential: credential.data,
      sessionId: sessionId.data,
    };
  }

  const paths = taskctlPaths(environment);
  const [rawProfile, rawMetadata] = await Promise.all([
    readOwnedJson(paths.profileFile),
    readOwnedJson(paths.credentialMetadataFile),
  ]);
  if (rawProfile === null && rawMetadata === null) return null;
  const profile = profileSchema.safeParse(rawProfile);
  const metadata = credentialMetadataSchema.safeParse(rawMetadata);
  if (!profile.success || !metadata.success) {
    throw new DispatchPairingError("The local taskctl runner profile is invalid.");
  }
  const apiOrigin = normalizedOrigin(profile.data.apiUrl);
  if (apiOrigin === null) {
    throw new DispatchPairingError("The local taskctl runner session is unavailable.");
  }
  if (!agentPresetScopes.dispatcher.every((scope) => profile.data.scopes.includes(scope))) {
    throw new DispatchPairingError("The enrolled agent is missing dispatcher authority.");
  }
  if (
    profile.data.credentialId !== undefined &&
    profile.data.credentialId !== metadata.data.credentialLocator
  ) {
    throw new DispatchPairingError("The runner credential does not match its local profile.");
  }
  const secrets = options.secrets ?? { get: async (input) => await Bun.secrets.get(input) };
  let source: string | null;
  try {
    source = await secrets.get({
      service: TASKCTL_KEYCHAIN_SERVICE,
      name: `agent:${resolve(paths.credentialFile)}`,
    });
  } catch {
    throw new DispatchPairingError("The runner credential could not be read from the keychain.");
  }
  const credential = credentialTokenSchema.safeParse(source);
  const parsedToken = credential.success ? parseCredentialToken(credential.data) : null;
  if (!credential.success || parsedToken?.locator !== metadata.data.credentialLocator) {
    throw new DispatchPairingError("The runner credential does not match its local profile.");
  }
  return {
    authorization: {
      apiOrigin,
      credential: credential.data,
      sessionId: metadata.data.sessionId,
    },
    credentialLocator: metadata.data.credentialLocator,
    credentialMetadataFile: paths.credentialMetadataFile,
    sessionAttemptFile: paths.sessionAttemptFile,
    sessionExpiresAt: metadata.data.sessionExpiresAt,
  };
}

export function parseDispatchRepositoryMappings(
  environment: DispatchPairingEnvironment = process.env,
): readonly DispatchRepositoryMapping[] {
  const source = optionalRenamedEnvironmentValue(
    environment,
    "HRA_RUNNER_REPOSITORIES",
  );
  if (source === undefined || source.trim().length === 0) return [];
  let value: unknown;
  try {
    value = JSON.parse(source) as unknown;
  } catch {
    throw new DispatchPairingError("HRA_RUNNER_REPOSITORIES must be valid JSON.");
  }
  const parsed = z.array(repositoryMappingSchema).max(128).safeParse(value);
  if (!parsed.success) {
    throw new DispatchPairingError("HRA_RUNNER_REPOSITORIES is invalid.");
  }
  const repositoryIds = new Set<string>();
  const paths = new Set<string>();
  return parsed.data.map((mapping) => {
    if (!isAbsolute(mapping.repositoryPath)) {
      throw new DispatchPairingError("Every runner repository path must be absolute.");
    }
    const repositoryPath = resolve(mapping.repositoryPath);
    if (repositoryIds.has(mapping.repositoryId) || paths.has(repositoryPath)) {
      throw new DispatchPairingError("Runner repository mappings must be unique.");
    }
    repositoryIds.add(mapping.repositoryId);
    paths.add(repositoryPath);
    return { repositoryId: mapping.repositoryId, repositoryPath };
  });
}

function normalizedOrigin(value: string | undefined): string | null {
  return normalizeDispatchApiOrigin(value ?? "http://127.0.0.1:3211");
}

function taskctlPaths(environment: DispatchPairingEnvironment): {
  readonly credentialFile: string;
  readonly credentialMetadataFile: string;
  readonly profileFile: string;
  readonly sessionAttemptFile: string;
} {
  const configuredRoot = environment["TASKCTL_CONFIG_HOME"];
  const xdgRoot = environment["XDG_CONFIG_HOME"];
  if (configuredRoot !== undefined && !isAbsolute(configuredRoot)) {
    throw new DispatchPairingError("TASKCTL_CONFIG_HOME must be absolute.");
  }
  if (xdgRoot !== undefined && !isAbsolute(xdgRoot)) {
    throw new DispatchPairingError("XDG_CONFIG_HOME must be absolute.");
  }
  const root = configuredRoot ?? (
    xdgRoot === undefined ? join(homedir(), ".config", "taskctl") : join(xdgRoot, "taskctl")
  );
  const credentialFile = environment["TASKCTL_CREDENTIAL_FILE"] ?? join(root, "credentials.json");
  const profileFile = environment["TASKCTL_PROFILE_FILE"] ?? join(root, "profile.json");
  if (!isAbsolute(credentialFile) || !isAbsolute(profileFile)) {
    throw new DispatchPairingError("Taskctl configuration paths must be absolute.");
  }
  return {
    credentialFile,
    credentialMetadataFile: `${credentialFile}.metadata`,
    profileFile,
    sessionAttemptFile: `${credentialFile}.session-attempt`,
  };
}

async function readOwnedJson(path: string): Promise<unknown> {
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  try {
    handle = await open(
      path,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
    );
    const metadata = await handle.stat();
    const expectedUid = typeof process.getuid === "function" ? process.getuid() : undefined;
    if (
      !metadata.isFile() ||
      (expectedUid !== undefined && metadata.uid !== expectedUid) ||
      (metadata.mode & 0o077) !== 0 ||
      metadata.size > MAX_CONFIGURATION_BYTES
    ) {
      throw new DispatchPairingError("A local taskctl configuration file is unsafe.");
    }
    const expectedBytes = Number(metadata.size);
    const bytes = new Uint8Array(expectedBytes);
    let offset = 0;
    while (offset < expectedBytes) {
      const read = await handle.read(bytes, offset, expectedBytes - offset, offset);
      if (read.bytesRead === 0) {
        throw new DispatchPairingError("A local taskctl configuration file changed while read.");
      }
      offset += read.bytesRead;
    }
    if ((await handle.read(new Uint8Array(1), 0, 1, expectedBytes)).bytesRead !== 0) {
      throw new DispatchPairingError("A local taskctl configuration file changed while read.");
    }
    const source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return JSON.parse(source) as unknown;
  } catch (error: unknown) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    if (error instanceof DispatchPairingError) throw error;
    throw new DispatchPairingError("A local taskctl configuration file could not be read.");
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function writeOwnedJson(
  path: string,
  value: unknown,
  random: DispatchPairingRandom,
): Promise<void> {
  const source = `${JSON.stringify(value)}\n`;
  if (
    new TextEncoder().encode(source).byteLength > MAX_CONFIGURATION_BYTES ||
    redactSecretsInText(source) !== source
  ) {
    throw new DispatchPairingError("The runner session metadata is unsafe to persist.");
  }
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const suffix = [...random.bytes(12)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  const temporaryPath = `${path}.${process.pid}.${suffix}.tmp`;
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  try {
    handle = await open(temporaryPath, "wx", 0o600);
    await handle.writeFile(source, "utf8");
    await handle.sync();
    await handle.close();
    handle = null;
    await rename(temporaryPath, path);
    await chmod(path, 0o600);
  } catch {
    await handle?.close().catch(() => undefined);
    await unlink(temporaryPath).catch(() => undefined);
    throw new DispatchPairingError("The runner session metadata could not be persisted.");
  }
}

async function removeOwnedFile(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (error: unknown) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
    throw new DispatchPairingError("The runner session recovery state could not be cleared.");
  }
}
