import {
  agentIdSchema,
  agentScopeSchema,
  createBearerSecret,
  createLocator,
  credentialTokenSchema,
  epochMsSchema,
  formatCredentialToken,
  locatorSchema,
  parseCredentialToken,
  redactSecretsInText,
  sessionIdSchema,
  uuidV7Schema,
  type CredentialToken,
  type ErrorCode,
  type IdempotencyKey,
  type SessionId,
} from "@hraness/agent-tasks-protocol";
import { z } from "@hra-internal/schema";
import { constants } from "node:fs";
import { chmod, mkdir, open, rename, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";

import { normalizeApiUrl, type AgentAuthorization } from "./client";
import { bunSecretStore, type SecretStore } from "./secret-store";

export const DEFAULT_LOCAL_API_URL = "http://127.0.0.1:3211";
export const MAX_AGENT_CONFIGURATION_BYTES = 1 * 1_024 * 1_024;
/**
 * Deployed taskctl Keychain service. The value is a durable storage key and
 * must remain byte-identical so an HRA install can read existing credentials.
 */
export const TASKCTL_KEYCHAIN_SERVICE = "com.jungle.taskctl";

export type AgentSecretStore = SecretStore;
export type AgentSecretStoreKind = "keychain" | "file";
export const bunAgentSecretStore: AgentSecretStore = bunSecretStore;

const pendingCredentialSchema = z
  .object({
    version: z.literal(2),
    state: z.literal("pending_enrollment"),
    credential: credentialTokenSchema,
    apiUrl: z.string().refine((value) => normalizeApiUrl(value) === value, "invalid API origin"),
    redeemIdempotencyKey: uuidV7Schema.optional(),
  })
  .strict();

const activeCredentialSchema = z
  .object({
    version: z.literal(1),
    state: z.literal("active"),
    credential: credentialTokenSchema,
    sessionId: sessionIdSchema,
    sessionExpiresAt: epochMsSchema,
  })
  .strict();

const storedCredentialSchema = z.discriminatedUnion("state", [
  pendingCredentialSchema,
  activeCredentialSchema,
]);

export type StoredCredential = z.infer<typeof storedCredentialSchema>;

const agentCredentialSecretSchema = z
  .object({ version: z.literal(1), credential: credentialTokenSchema })
  .strict();

const pendingCredentialMetadataSchema = z
  .object({
    version: z.literal(1),
    state: z.literal("pending_enrollment"),
    secretStore: z.enum(["keychain", "file"]),
    credentialLocator: locatorSchema,
    apiUrl: z.string().refine((value) => normalizeApiUrl(value) === value, "invalid API origin"),
    redeemIdempotencyKey: uuidV7Schema.optional(),
  })
  .strict();

const activeCredentialMetadataSchema = z
  .object({
    version: z.literal(1),
    state: z.literal("active"),
    secretStore: z.enum(["keychain", "file"]),
    credentialLocator: locatorSchema,
    sessionId: sessionIdSchema,
    sessionExpiresAt: epochMsSchema,
  })
  .strict();

const agentCredentialMetadataSchema = z.discriminatedUnion("state", [
  pendingCredentialMetadataSchema,
  activeCredentialMetadataSchema,
]);

type AgentCredentialMetadata = z.infer<typeof agentCredentialMetadataSchema>;

const storedSessionAttemptSchema = z
  .object({
    version: z.literal(1),
    apiUrl: z.string().refine((value) => normalizeApiUrl(value) === value, "invalid API origin"),
    credentialLocator: locatorSchema,
    idempotencyKey: uuidV7Schema,
  })
  .strict();

export type StoredSessionAttempt = z.infer<typeof storedSessionAttemptSchema>;

export const profileSchema = z
  .object({
    version: z.literal(1),
    apiUrl: z.string().refine((value) => normalizeApiUrl(value) === value, "invalid API origin"),
    agentId: agentIdSchema,
    credentialId: z.string().min(1).max(128).optional(),
    credentialExpiresAt: epochMsSchema.optional(),
    scopes: z.array(agentScopeSchema),
  })
  .strict();

export type TaskctlProfile = z.infer<typeof profileSchema>;

export interface StoragePaths {
  readonly credentialFile: string;
  readonly profileFile: string;
}

export type TaskctlEnvironment = Readonly<Record<string, string | undefined>>;

export interface RandomSource {
  (length: number): Uint8Array;
}

export interface AgentSessionSeed {
  readonly credential: CredentialToken;
  readonly sessionId?: SessionId;
  readonly source: "environment" | AgentSecretStoreKind;
}

export class TaskctlConfigError extends Error {
  readonly code: ErrorCode;

  constructor(code: ErrorCode, message: string) {
    super(message);
    this.name = "TaskctlConfigError";
    this.code = code;
  }
}

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function errorCode(error: unknown): unknown {
  return error instanceof Error && "code" in error ? error.code : undefined;
}

function requireAbsolutePath(path: string, label: string): void {
  if (!isAbsolute(path)) {
    throw new TaskctlConfigError("VALIDATION_ERROR", `${label} must be an absolute path`);
  }
}

function validateStoragePaths(paths: StoragePaths): void {
  requireAbsolutePath(paths.credentialFile, "credential file path");
  requireAbsolutePath(paths.profileFile, "profile file path");
  if (resolve(paths.credentialFile) === resolve(paths.profileFile)) {
    throw new TaskctlConfigError("VALIDATION_ERROR", "credential and profile paths must be distinct");
  }
  if (resolve(`${paths.credentialFile}.session-attempt`) === resolve(paths.profileFile)) {
    throw new TaskctlConfigError(
      "VALIDATION_ERROR",
      "profile and session-attempt paths must be distinct",
    );
  }
  if (resolve(`${paths.credentialFile}.metadata`) === resolve(paths.profileFile)) {
    throw new TaskctlConfigError(
      "VALIDATION_ERROR",
      "profile and credential-metadata paths must be distinct",
    );
  }
}

export function sessionAttemptFile(paths: StoragePaths): string {
  validateStoragePaths(paths);
  return `${paths.credentialFile}.session-attempt`;
}

export function credentialMetadataFile(paths: StoragePaths): string {
  validateStoragePaths(paths);
  return `${paths.credentialFile}.metadata`;
}

export function agentKeychainName(paths: StoragePaths): string {
  validateStoragePaths(paths);
  return `agent:${resolve(paths.credentialFile)}`;
}

export interface ConfigurationFileMetadata {
  readonly isRegularFile: boolean;
  readonly mode: number;
  readonly uid: number;
}

export function assertConfigurationFileMetadata(
  kind:
    | "credential"
    | "credential metadata"
    | "profile"
    | "session attempt"
    | "human profile"
    | "human secret"
    | "human custody"
    | "enrollment output",
  metadata: ConfigurationFileMetadata,
  expectedUid: number | undefined,
): void {
  if (!metadata.isRegularFile) {
    throw new TaskctlConfigError(
      "VALIDATION_ERROR",
      `local taskctl ${kind} file must be a regular file`,
    );
  }
  if (expectedUid !== undefined && metadata.uid !== expectedUid) {
    throw new TaskctlConfigError(
      "VALIDATION_ERROR",
      `local taskctl ${kind} file is owned by another user`,
    );
  }
  if ((metadata.mode & 0o077) !== 0) {
    throw new TaskctlConfigError(
      "VALIDATION_ERROR",
      `local taskctl ${kind} file must not be group or world accessible`,
    );
  }
}

export function webCryptoRandomBytes(length: number): Uint8Array {
  if (!Number.isSafeInteger(length) || length <= 0) throw new RangeError("random byte length is invalid");
  const bytes = new Uint8Array(length);
  globalThis.crypto.getRandomValues(bytes);
  return bytes;
}

export function generateCredentialToken(random: RandomSource = webCryptoRandomBytes): CredentialToken {
  return formatCredentialToken(createLocator(random(26)), createBearerSecret(random(32)));
}

export function resolveStoragePaths(environment: TaskctlEnvironment): StoragePaths {
  const configuredRoot = environment["TASKCTL_CONFIG_HOME"];
  const xdgRoot = environment["XDG_CONFIG_HOME"];
  if (configuredRoot !== undefined) requireAbsolutePath(configuredRoot, "TASKCTL_CONFIG_HOME");
  if (xdgRoot !== undefined) requireAbsolutePath(xdgRoot, "XDG_CONFIG_HOME");
  const root =
    configuredRoot ??
    (xdgRoot === undefined ? join(homedir(), ".config", "taskctl") : join(xdgRoot, "taskctl"));
  const credentialFile = environment["TASKCTL_CREDENTIAL_FILE"] ?? join(root, "credentials.json");
  const profileFile = environment["TASKCTL_PROFILE_FILE"] ?? join(root, "profile.json");
  const paths = { credentialFile, profileFile };
  validateStoragePaths(paths);
  return paths;
}

export function resolveApiUrl(
  environment: TaskctlEnvironment,
  profile: TaskctlProfile | null,
): string {
  const candidate = environment["TASKCTL_API_URL"] ?? profile?.apiUrl ?? DEFAULT_LOCAL_API_URL;
  const normalized = normalizeApiUrl(candidate);
  if (normalized === null) {
    throw new TaskctlConfigError("VALIDATION_ERROR", "TASKCTL_API_URL must be an HTTP(S) origin");
  }
  return normalized;
}

async function readUnknownJson(
  path: string,
  kind: "credential" | "credential metadata" | "profile" | "session attempt",
): Promise<unknown> {
  requireAbsolutePath(path, `${kind} file path`);
  let source: string;
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  try {
    handle = await open(
      path,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
    );
    const metadata = await handle.stat();
    assertConfigurationFileMetadata(
      kind,
      {
        isRegularFile: metadata.isFile(),
        mode: metadata.mode,
        uid: metadata.uid,
      },
      typeof process.getuid === "function" ? process.getuid() : undefined,
    );
    if (metadata.size > MAX_AGENT_CONFIGURATION_BYTES) {
      throw new TaskctlConfigError("VALIDATION_ERROR", `local taskctl ${kind} file is too large`);
    }
    const expectedBytes = Number(metadata.size);
    const bytes = new Uint8Array(expectedBytes);
    let offset = 0;
    while (offset < expectedBytes) {
      const result = await handle.read(bytes, offset, expectedBytes - offset, offset);
      if (result.bytesRead === 0) {
        throw new TaskctlConfigError(
          "VALIDATION_ERROR",
          `local taskctl ${kind} file changed while being read`,
        );
      }
      offset += result.bytesRead;
    }
    if ((await handle.read(new Uint8Array(1), 0, 1, expectedBytes)).bytesRead !== 0) {
      throw new TaskctlConfigError(
        "VALIDATION_ERROR",
        `local taskctl ${kind} file changed while being read`,
      );
    }
    try {
      source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      throw new TaskctlConfigError(
        "VALIDATION_ERROR",
        `local taskctl ${kind} file is not valid UTF-8`,
      );
    }
  } catch (error) {
    if (isMissingFile(error)) return null;
    if (error instanceof TaskctlConfigError) throw error;
    if (errorCode(error) === "ELOOP") {
      throw new TaskctlConfigError(
        "VALIDATION_ERROR",
        `local taskctl ${kind} file must not be a symbolic link`,
      );
    }
    throw new TaskctlConfigError("INTERNAL_ERROR", "could not read local taskctl configuration");
  } finally {
    if (handle !== null) await handle.close().catch(() => undefined);
  }
  try {
    const value: unknown = JSON.parse(source);
    return value;
  } catch {
    throw new TaskctlConfigError("VALIDATION_ERROR", "local taskctl configuration is invalid");
  }
}

async function readCredentialMetadata(paths: StoragePaths): Promise<AgentCredentialMetadata | null> {
  const value = await readUnknownJson(credentialMetadataFile(paths), "credential metadata");
  if (value === null) return null;
  const parsed = agentCredentialMetadataSchema.safeParse(value);
  if (!parsed.success) {
    throw new TaskctlConfigError("VALIDATION_ERROR", "local taskctl credential metadata is invalid");
  }
  return parsed.data;
}

function credentialMetadata(
  credential: StoredCredential,
  secretStore: AgentSecretStoreKind,
): AgentCredentialMetadata {
  const parsed = storedCredentialSchema.parse(credential);
  const token = parseCredentialToken(parsed.credential);
  if (token === null) throw new TaskctlConfigError("VALIDATION_ERROR", "agent credential is invalid");
  return agentCredentialMetadataSchema.parse(
    parsed.state === "pending_enrollment"
      ? {
          version: 1,
          state: parsed.state,
          secretStore,
          credentialLocator: token.locator,
          apiUrl: parsed.apiUrl,
          ...(parsed.redeemIdempotencyKey === undefined
            ? {}
            : { redeemIdempotencyKey: parsed.redeemIdempotencyKey }),
        }
      : {
          version: 1,
          state: parsed.state,
          secretStore,
          credentialLocator: token.locator,
          sessionId: parsed.sessionId,
          sessionExpiresAt: parsed.sessionExpiresAt,
        },
  );
}

function combineCredential(
  metadata: AgentCredentialMetadata,
  credential: CredentialToken,
): StoredCredential {
  const token = parseCredentialToken(credential);
  if (token === null || token.locator !== metadata.credentialLocator) {
    throw new TaskctlConfigError("VALIDATION_ERROR", "local taskctl agent authentication is invalid");
  }
  return storedCredentialSchema.parse(
    metadata.state === "pending_enrollment"
      ? {
          version: 2,
          state: metadata.state,
          credential,
          apiUrl: metadata.apiUrl,
          ...(metadata.redeemIdempotencyKey === undefined
            ? {}
            : { redeemIdempotencyKey: metadata.redeemIdempotencyKey }),
        }
      : {
          version: 1,
          state: metadata.state,
          credential,
          sessionId: metadata.sessionId,
          sessionExpiresAt: metadata.sessionExpiresAt,
        },
  );
}

async function readKeychainCredential(
  paths: StoragePaths,
  keychain: AgentSecretStore,
): Promise<CredentialToken> {
  let source: string | null;
  try {
    source = await keychain.get({
      service: TASKCTL_KEYCHAIN_SERVICE,
      name: agentKeychainName(paths),
    });
  } catch {
    throw new TaskctlConfigError(
      "INTERNAL_ERROR",
      "could not read the operating-system keychain; agent credentials are unchanged",
    );
  }
  if (
    source === null ||
    new TextEncoder().encode(source).byteLength > MAX_AGENT_CONFIGURATION_BYTES
  ) {
    throw new TaskctlConfigError("AUTHENTICATION_FAILED", "agent authentication is not configured");
  }
  const parsed = credentialTokenSchema.safeParse(source);
  if (!parsed.success) {
    throw new TaskctlConfigError("VALIDATION_ERROR", "local taskctl agent authentication is invalid");
  }
  return parsed.data;
}

async function readFileCredential(paths: StoragePaths): Promise<CredentialToken> {
  const value = await readUnknownJson(paths.credentialFile, "credential");
  const parsed = agentCredentialSecretSchema.safeParse(value);
  if (!parsed.success) {
    throw new TaskctlConfigError("VALIDATION_ERROR", "local taskctl agent authentication is invalid");
  }
  return parsed.data.credential;
}

export async function readStoredCredential(
  paths: StoragePaths,
  keychain: AgentSecretStore = bunAgentSecretStore,
): Promise<StoredCredential | null> {
  validateStoragePaths(paths);
  const metadata = await readCredentialMetadata(paths);
  if (metadata === null) {
    const legacy = await readUnknownJson(paths.credentialFile, "credential");
    if (legacy === null) return null;
    if (storedCredentialSchema.safeParse(legacy).success) {
      throw new TaskctlConfigError(
        "VALIDATION_ERROR",
        "a legacy agent credential file requires explicit migration with auth migrate-agent-credential",
      );
    }
    throw new TaskctlConfigError("VALIDATION_ERROR", "local taskctl agent authentication is invalid");
  }
  const credential =
    metadata.secretStore === "keychain"
      ? await readKeychainCredential(paths, keychain)
      : await readFileCredential(paths);
  return combineCredential(metadata, credential);
}

export async function readStoredCredentialSource(
  paths: StoragePaths,
): Promise<AgentSecretStoreKind | null> {
  return (await readCredentialMetadata(paths))?.secretStore ?? null;
}

export async function readProfile(paths: StoragePaths): Promise<TaskctlProfile | null> {
  validateStoragePaths(paths);
  const value = await readUnknownJson(paths.profileFile, "profile");
  if (value === null) return null;
  const parsed = profileSchema.safeParse(value);
  if (!parsed.success) {
    throw new TaskctlConfigError("VALIDATION_ERROR", "local taskctl profile is invalid");
  }
  return parsed.data;
}

export async function readStoredSessionAttempt(
  paths: StoragePaths,
): Promise<StoredSessionAttempt | null> {
  const value = await readUnknownJson(sessionAttemptFile(paths), "session attempt");
  if (value === null) return null;
  const parsed = storedSessionAttemptSchema.safeParse(value);
  if (!parsed.success) {
    throw new TaskctlConfigError("VALIDATION_ERROR", "local taskctl session attempt is invalid");
  }
  return parsed.data;
}

async function atomicWriteMode0600(
  path: string,
  value: string,
  random: RandomSource = webCryptoRandomBytes,
): Promise<void> {
  requireAbsolutePath(path, "configuration file path");
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const suffix = [...random(12)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  const temporaryPath = `${path}.${process.pid}.${suffix}.tmp`;
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  try {
    handle = await open(temporaryPath, "wx", 0o600);
    await handle.writeFile(value, "utf8");
    await handle.sync();
    await handle.close();
    handle = null;
    await rename(temporaryPath, path);
    await chmod(path, 0o600);
  } catch {
    if (handle !== null) await handle.close().catch(() => undefined);
    await unlink(temporaryPath).catch(() => undefined);
    throw new TaskctlConfigError("INTERNAL_ERROR", "could not persist local taskctl configuration");
  }
}

export async function writeStoredCredential(
  paths: StoragePaths,
  credential: StoredCredential,
  random?: RandomSource,
  keychain: AgentSecretStore = bunAgentSecretStore,
  requestedSecretStore?: AgentSecretStoreKind,
): Promise<void> {
  validateStoragePaths(paths);
  const parsed = storedCredentialSchema.parse(credential);
  const existingMetadata = await readCredentialMetadata(paths);
  if (existingMetadata === null) {
    const existingSecret = await readUnknownJson(paths.credentialFile, "credential");
    if (existingSecret !== null) {
      const isLegacy = storedCredentialSchema.safeParse(existingSecret).success;
      throw new TaskctlConfigError(
        "VALIDATION_ERROR",
        isLegacy
          ? "a legacy agent credential file requires explicit migration with auth migrate-agent-credential"
          : "local taskctl agent authentication is invalid",
      );
    }
  }
  const secretStore = existingMetadata?.secretStore ?? requestedSecretStore ?? "keychain";
  if (requestedSecretStore !== undefined && requestedSecretStore !== secretStore) {
    throw new TaskctlConfigError(
      "VALIDATION_ERROR",
      "agent credential storage cannot change during an active enrollment",
    );
  }
  const metadata = credentialMetadata(parsed, secretStore);
  if (
    existingMetadata !== null &&
    existingMetadata.credentialLocator !== metadata.credentialLocator
  ) {
    throw new TaskctlConfigError(
      "VALIDATION_ERROR",
      "agent credential identity cannot change in place",
    );
  }
  const metadataSource = `${JSON.stringify(metadata)}\n`;
  if (redactSecretsInText(metadataSource) !== metadataSource) {
    throw new TaskctlConfigError("VALIDATION_ERROR", "credential metadata contained a secret");
  }

  if (secretStore === "keychain") {
    try {
      await keychain.set({
        service: TASKCTL_KEYCHAIN_SERVICE,
        name: agentKeychainName(paths),
        value: parsed.credential,
      });
    } catch {
      throw new TaskctlConfigError(
        "INTERNAL_ERROR",
        "could not write the operating-system keychain; retry auth enroll with --secret-store file only if a keychain is unavailable",
      );
    }
    try {
      await atomicWriteMode0600(credentialMetadataFile(paths), metadataSource, random);
    } catch (error) {
      if (existingMetadata === null) {
        await keychain
          .delete({ service: TASKCTL_KEYCHAIN_SERVICE, name: agentKeychainName(paths) })
          .catch(() => false);
      }
      throw error;
    }
    return;
  }

  const secret = agentCredentialSecretSchema.parse({ version: 1, credential: parsed.credential });
  await atomicWriteMode0600(credentialMetadataFile(paths), metadataSource, random);
  try {
    await atomicWriteMode0600(paths.credentialFile, `${JSON.stringify(secret)}\n`, random);
  } catch (error) {
    if (existingMetadata === null) {
      await removeIfPresent(credentialMetadataFile(paths)).catch(() => undefined);
    }
    throw error;
  }
}

export async function migrateLegacyStoredCredential(
  paths: StoragePaths,
  target: AgentSecretStoreKind,
  random: RandomSource = webCryptoRandomBytes,
  keychain: AgentSecretStore = bunAgentSecretStore,
): Promise<StoredCredential> {
  validateStoragePaths(paths);
  if ((await readCredentialMetadata(paths)) !== null) {
    throw new TaskctlConfigError("VALIDATION_ERROR", "agent credential storage is already migrated");
  }
  const value = await readUnknownJson(paths.credentialFile, "credential");
  if (value === null) {
    throw new TaskctlConfigError("AUTHENTICATION_FAILED", "no legacy agent credential is configured");
  }
  const parsed = storedCredentialSchema.safeParse(value);
  if (!parsed.success) {
    throw new TaskctlConfigError("VALIDATION_ERROR", "legacy agent credentials are invalid");
  }
  const metadata = credentialMetadata(parsed.data, target);
  const metadataSource = `${JSON.stringify(metadata)}\n`;

  if (target === "keychain") {
    try {
      await keychain.set({
        service: TASKCTL_KEYCHAIN_SERVICE,
        name: agentKeychainName(paths),
        value: parsed.data.credential,
      });
    } catch {
      throw new TaskctlConfigError(
        "INTERNAL_ERROR",
        "could not write the operating-system keychain; legacy credential file was left unchanged",
      );
    }
    try {
      await atomicWriteMode0600(credentialMetadataFile(paths), metadataSource, random);
      await removeIfPresent(paths.credentialFile);
    } catch {
      await removeIfPresent(credentialMetadataFile(paths)).catch(() => undefined);
      await keychain
        .delete({ service: TASKCTL_KEYCHAIN_SERVICE, name: agentKeychainName(paths) })
        .catch(() => false);
      throw new TaskctlConfigError(
        "INTERNAL_ERROR",
        "could not migrate the legacy agent credential; legacy credential file was retained",
      );
    }
  } else {
    await atomicWriteMode0600(credentialMetadataFile(paths), metadataSource, random);
    const secret = agentCredentialSecretSchema.parse({
      version: 1,
      credential: parsed.data.credential,
    });
    try {
      await atomicWriteMode0600(paths.credentialFile, `${JSON.stringify(secret)}\n`, random);
    } catch {
      await removeIfPresent(credentialMetadataFile(paths)).catch(() => undefined);
      throw new TaskctlConfigError(
        "INTERNAL_ERROR",
        "could not migrate the legacy agent credential; legacy credential file was retained",
      );
    }
  }
  return parsed.data;
}

export async function writeProfile(
  paths: StoragePaths,
  profile: TaskctlProfile,
  random?: RandomSource,
): Promise<void> {
  validateStoragePaths(paths);
  const parsed = profileSchema.parse(profile);
  const serialized = `${JSON.stringify(parsed)}\n`;
  if (redactSecretsInText(serialized) !== serialized) {
    throw new TaskctlConfigError("VALIDATION_ERROR", "profile metadata contained a secret");
  }
  await atomicWriteMode0600(paths.profileFile, serialized, random);
}

export function sessionAttemptRecord(
  credential: CredentialToken,
  apiUrl: string,
  idempotencyKey: IdempotencyKey,
): StoredSessionAttempt {
  const parsedCredential = parseCredentialToken(credential);
  if (parsedCredential === null) {
    throw new TaskctlConfigError("VALIDATION_ERROR", "agent credential is invalid");
  }
  return storedSessionAttemptSchema.parse({
    version: 1,
    apiUrl,
    credentialLocator: parsedCredential.locator,
    idempotencyKey,
  });
}

export async function writeStoredSessionAttempt(
  paths: StoragePaths,
  attempt: StoredSessionAttempt,
  random?: RandomSource,
): Promise<void> {
  const parsed = storedSessionAttemptSchema.parse(attempt);
  await atomicWriteMode0600(sessionAttemptFile(paths), `${JSON.stringify(parsed)}\n`, random);
}

async function removeIfPresent(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (error) {
    if (!isMissingFile(error)) {
      throw new TaskctlConfigError("INTERNAL_ERROR", "could not remove local taskctl configuration");
    }
  }
}

export async function clearStoredAuthentication(
  paths: StoragePaths,
  keychain: AgentSecretStore = bunAgentSecretStore,
): Promise<void> {
  validateStoragePaths(paths);
  const metadata = await readCredentialMetadata(paths);
  if (metadata?.secretStore === "keychain") {
    try {
      await keychain.delete({
        service: TASKCTL_KEYCHAIN_SERVICE,
        name: agentKeychainName(paths),
      });
    } catch {
      throw new TaskctlConfigError(
        "INTERNAL_ERROR",
        "could not remove agent authentication from the operating-system keychain",
      );
    }
  }
  await Promise.all([
    removeIfPresent(paths.credentialFile),
    removeIfPresent(credentialMetadataFile(paths)),
    removeIfPresent(paths.profileFile),
    removeIfPresent(sessionAttemptFile(paths)),
  ]);
}

export async function clearStoredSessionAttempt(paths: StoragePaths): Promise<void> {
  await removeIfPresent(sessionAttemptFile(paths));
}

export async function resolveAgentAuthorization(
  environment: TaskctlEnvironment,
  paths: StoragePaths,
  now: number = Date.now(),
  keychain: AgentSecretStore = bunAgentSecretStore,
): Promise<{
  readonly authorization: AgentAuthorization;
  readonly source: "environment" | AgentSecretStoreKind;
}> {
  const seed = await resolveAgentSessionSeed(environment, paths, now, keychain);
  if (seed.sessionId === undefined) {
    throw new TaskctlConfigError("SESSION_REQUIRED", "no valid agent session is configured");
  }
  return {
    source: seed.source,
    authorization: { credential: seed.credential, sessionId: seed.sessionId },
  };
}

export async function resolveAgentSessionSeed(
  environment: TaskctlEnvironment,
  paths: StoragePaths,
  now: number = Date.now(),
  keychain: AgentSecretStore = bunAgentSecretStore,
): Promise<AgentSessionSeed> {
  const environmentCredential = environment["TASKCTL_TOKEN"];
  const environmentSession = environment["TASKCTL_SESSION_ID"];

  if (environmentCredential !== undefined) {
    const credentialResult = credentialTokenSchema.safeParse(environmentCredential);
    if (!credentialResult.success) {
      throw new TaskctlConfigError("AUTHENTICATION_FAILED", "TASKCTL_TOKEN is invalid");
    }
    if (environmentSession === undefined) {
      return { source: "environment", credential: credentialResult.data };
    }
    const sessionResult = sessionIdSchema.safeParse(environmentSession);
    if (!sessionResult.success) {
      throw new TaskctlConfigError(
        "SESSION_INVALID",
        "TASKCTL_SESSION_ID is invalid",
      );
    }
    return {
      source: "environment",
      credential: credentialResult.data,
      sessionId: sessionResult.data,
    };
  }

  const stored = await readStoredCredential(paths, keychain);
  if (stored === null) {
    throw new TaskctlConfigError("AUTHENTICATION_FAILED", "no agent credential is configured");
  }
  if (stored.state === "pending_enrollment") {
    throw new TaskctlConfigError("SESSION_REQUIRED", "agent enrollment has not established a session");
  }
  if (environmentSession !== undefined) {
    const sessionResult = sessionIdSchema.safeParse(environmentSession);
    if (!sessionResult.success) {
      throw new TaskctlConfigError("SESSION_INVALID", "TASKCTL_SESSION_ID is invalid");
    }
    return {
      source: (await readStoredCredentialSource(paths)) ?? "file",
      credential: stored.credential,
      sessionId: sessionResult.data,
    };
  }
  const sessionIsCurrent = stored.sessionExpiresAt > now;
  return {
    source: (await readStoredCredentialSource(paths)) ?? "file",
    credential: stored.credential,
    ...(sessionIsCurrent ? { sessionId: stored.sessionId } : {}),
  };
}

export function activeCredentialRecord(
  credential: CredentialToken,
  sessionId: SessionId,
  sessionExpiresAt: number,
): z.infer<typeof activeCredentialSchema> {
  return activeCredentialSchema.parse({
    version: 1,
    state: "active",
    credential,
    sessionId,
    sessionExpiresAt,
  });
}

export function pendingCredentialRecord(
  credential: CredentialToken,
  apiUrl: string,
  redeemIdempotencyKey?: IdempotencyKey,
): z.infer<typeof pendingCredentialSchema> {
  return pendingCredentialSchema.parse({
    version: 2,
    state: "pending_enrollment",
    credential,
    apiUrl,
    ...(redeemIdempotencyKey === undefined ? {} : { redeemIdempotencyKey }),
  });
}
