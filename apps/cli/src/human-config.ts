import {
  enrollmentTokenSchema,
  redactSecretsInText,
  type EnrollmentToken,
} from "@hraness/agent-tasks-protocol";
import {
  GenerationalSecretCustody,
  SecretCustodyError,
  humanAuthenticationSchema,
  humanProfileSchema,
  profileFromHumanAuthentication,
  secretCustodyJournalSchema,
  secretCustodyQuarantinePointerSchema,
  storedHumanAuthenticationDisposition,
  storedHumanProfileDisposition,
  type HumanAuthentication,
  type HumanProfile,
  type SecretCustodyDescriptor,
  type SecretCustodyJournal,
  type SecretCustodyMetadataStore,
  type SecretCustodyQuarantinePointer,
  type SecretCustodyLiveInspection,
  type SecretStore as GenerationalSecretStore,
} from "@hraness/hra-human-client";
import { z } from "@hra-internal/schema";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { chmod, link, lstat, mkdir, open, readdir, rename, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";

import {
  TaskctlConfigError,
  TASKCTL_KEYCHAIN_SERVICE,
  assertConfigurationFileMetadata,
  type RandomSource,
  type StoragePaths,
  type TaskctlEnvironment,
} from "./config";
import { bunSecretStore, type SecretStore } from "./secret-store";

const MAX_CONFIGURATION_BYTES = 1 * 1_024 * 1_024;
const MAX_CUSTODY_REVISIONS = 10_000;
const humanCustodyTails = new Map<string, Promise<void>>();

async function withHumanCustodyLock<Value>(
  paths: HumanStoragePaths,
  operation: () => Promise<Value>,
): Promise<Value> {
  const key = resolve(paths.profileFile);
  const predecessor = humanCustodyTails.get(key) ?? Promise.resolve();
  let release = (): void => undefined;
  const gate = new Promise<void>((resolveGate) => {
    release = resolveGate;
  });
  const tail = predecessor.catch(() => undefined).then(async () => await gate);
  humanCustodyTails.set(key, tail);
  await predecessor.catch(() => undefined);
  try {
    return await operation();
  } finally {
    release();
    if (humanCustodyTails.get(key) === tail) humanCustodyTails.delete(key);
  }
}
export {
  humanAuthenticationSchema,
  humanProfileSchema,
  type HumanAuthentication,
  type HumanProfile,
} from "@hraness/hra-human-client";

export interface HumanStoragePaths {
  readonly profileFile: string;
  readonly secretFile: string;
  readonly custodyDirectory: string;
  readonly fileSlotDirectory: string;
  readonly keychainService: string;
  readonly keychainName: string;
}

export type HumanSecretStore = SecretStore;

export const bunHumanSecretStore: HumanSecretStore = bunSecretStore;

function missingFile(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function systemErrorCode(error: unknown): unknown {
  return error instanceof Error && "code" in error ? error.code : undefined;
}

function requireAbsolute(path: string, label: string): void {
  if (!isAbsolute(path)) {
    throw new TaskctlConfigError("VALIDATION_ERROR", `${label} must be an absolute path`);
  }
}

export function resolveHumanStoragePaths(
  environment: TaskctlEnvironment,
  agentPaths: StoragePaths,
): HumanStoragePaths {
  const profileFile = environment["TASKCTL_HUMAN_PROFILE_FILE"] ?? `${agentPaths.profileFile}.human`;
  const secretFile = environment["TASKCTL_HUMAN_SECRET_FILE"] ?? `${agentPaths.credentialFile}.human`;
  requireAbsolute(profileFile, "human profile file path");
  requireAbsolute(secretFile, "human secret file path");
  const paths = [profileFile, secretFile, agentPaths.profileFile, agentPaths.credentialFile].map((path) =>
    resolve(path),
  );
  if (new Set(paths).size !== paths.length) {
    throw new TaskctlConfigError(
      "VALIDATION_ERROR",
      "human and agent authentication paths must be distinct",
    );
  }
  return {
    profileFile,
    secretFile,
    custodyDirectory: `${profileFile}.custody`,
    fileSlotDirectory: `${secretFile}.slots`,
    keychainService: TASKCTL_KEYCHAIN_SERVICE,
    keychainName: `human:${resolve(profileFile)}`,
  };
}

async function readSecureFile(
  path: string,
  kind: "human profile" | "human secret" | "human custody" | "enrollment output",
): Promise<string | null> {
  requireAbsolute(path, `${kind} file path`);
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  try {
    handle = await open(
      path,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
    );
    const metadata = await handle.stat();
    assertConfigurationFileMetadata(
      kind,
      { isRegularFile: metadata.isFile(), mode: metadata.mode, uid: metadata.uid },
      typeof process.getuid === "function" ? process.getuid() : undefined,
    );
    if (metadata.size > MAX_CONFIGURATION_BYTES) {
      throw new TaskctlConfigError("VALIDATION_ERROR", `local taskctl ${kind} file is too large`);
    }
    return await handle.readFile({ encoding: "utf8" });
  } catch (error) {
    if (missingFile(error)) return null;
    if (error instanceof TaskctlConfigError) throw error;
    if (systemErrorCode(error) === "ELOOP") {
      throw new TaskctlConfigError(
        "VALIDATION_ERROR",
        `local taskctl ${kind} file must not be a symbolic link`,
      );
    }
    throw new TaskctlConfigError("INTERNAL_ERROR", `could not read local taskctl ${kind}`);
  } finally {
    if (handle !== null) await handle.close().catch(() => undefined);
  }
}

function parseJson(
  source: string,
  kind: "human profile" | "human secret" | "human custody",
): unknown {
  try {
    const value: unknown = JSON.parse(source);
    return value;
  } catch {
    throw new TaskctlConfigError("VALIDATION_ERROR", `local taskctl ${kind} is invalid`);
  }
}

async function atomicWrite0600(
  path: string,
  value: string,
  random: RandomSource,
): Promise<void> {
  requireAbsolute(path, "configuration file path");
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  let temporaryPath: string | null = null;
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  try {
    const suffix = [...random(12)]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
    temporaryPath = `${path}.${process.pid}.${suffix}.tmp`;
    handle = await open(temporaryPath, "wx", 0o600);
    await handle.writeFile(value, "utf8");
    await handle.sync();
    await handle.close();
    handle = null;
    await rename(temporaryPath, path);
    await chmod(path, 0o600);
  } catch {
    if (handle !== null) await handle.close().catch(() => undefined);
    if (temporaryPath !== null) await unlink(temporaryPath).catch(() => undefined);
    throw new TaskctlConfigError("INTERNAL_ERROR", "could not persist local taskctl configuration");
  }
}

async function removeIfPresent(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (error) {
    if (!missingFile(error)) {
      throw new TaskctlConfigError("INTERNAL_ERROR", "could not remove local taskctl configuration");
    }
  }
}

const storedHumanCredentialSchema = z.object({
  version: z.literal(1),
  secretStore: z.enum(["keychain", "file"]),
  authentication: humanAuthenticationSchema,
}).strict();

type StoredHumanCredential = z.infer<typeof storedHumanCredentialSchema>;

const humanCustodyRevisionSchema = z.object({
  version: z.literal(1),
  journal: secretCustodyJournalSchema,
  quarantined: z.array(secretCustodyQuarantinePointerSchema).max(64),
}).strict();

interface HumanCustodyRevision {
  readonly version: 1;
  readonly journal: SecretCustodyJournal;
  readonly quarantined: readonly SecretCustodyQuarantinePointer[];
}

let custodyPublishCounter = 0;
let custodySlotCounter = 0;

function randomHex(random: RandomSource, length: number): string {
  return [...random(length)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function requireSecureDirectory(path: string, create: boolean): Promise<boolean> {
  try {
    const metadata = await lstat(path);
    const owner = typeof process.getuid === "function" ? process.getuid() : undefined;
    if (
      !metadata.isDirectory() ||
      metadata.isSymbolicLink() ||
      (metadata.mode & 0o077) !== 0 ||
      (owner !== undefined && metadata.uid !== owner)
    ) {
      throw new TaskctlConfigError(
        "VALIDATION_ERROR",
        "local taskctl human custody directory must be owner-only",
      );
    }
    return true;
  } catch (error) {
    if (!missingFile(error)) throw error;
    if (!create) return false;
  }
  await mkdir(path, { mode: 0o700 });
  return true;
}

async function ensureHumanCustodyDirectory(paths: HumanStoragePaths): Promise<void> {
  await requireSecureDirectory(paths.custodyDirectory, true);
  await requireSecureDirectory(join(paths.custodyDirectory, "journal"), true);
}

async function ensureHumanFileSlotDirectory(paths: HumanStoragePaths): Promise<void> {
  await requireSecureDirectory(paths.fileSlotDirectory, true);
}

async function publishImmutable0600(path: string, source: string): Promise<boolean> {
  let temporaryPath: string | null = null;
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  try {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      custodyPublishCounter += 1;
      temporaryPath = `${path}.${process.pid}.${Date.now()}.${custodyPublishCounter}.tmp`;
      try {
        handle = await open(temporaryPath, "wx", 0o600);
        break;
      } catch (error) {
        if (systemErrorCode(error) !== "EEXIST") throw error;
      }
    }
    if (handle === null || temporaryPath === null) {
      throw new Error("could not allocate immutable custody staging file");
    }
    await handle.writeFile(source, "utf8");
    await handle.sync();
    await handle.close();
    handle = null;
    try {
      await link(temporaryPath, path);
    } catch (error) {
      if (systemErrorCode(error) === "EEXIST") return false;
      throw error;
    }
    await chmod(path, 0o600);
    return true;
  } catch (error) {
    if (error instanceof TaskctlConfigError) throw error;
    throw new TaskctlConfigError(
      "INTERNAL_ERROR",
      "could not persist immutable local human custody",
    );
  } finally {
    if (handle !== null) await handle.close().catch(() => undefined);
    if (temporaryPath !== null) await unlink(temporaryPath).catch(() => undefined);
  }
}

function custodyRevisionFile(paths: HumanStoragePaths, revision: number): string {
  return join(
    paths.custodyDirectory,
    "journal",
    `revision-${String(revision).padStart(16, "0")}.json`,
  );
}

async function readHumanCustodyRevisions(
  paths: HumanStoragePaths,
): Promise<readonly HumanCustodyRevision[]> {
  if (!(await requireSecureDirectory(paths.custodyDirectory, false))) return [];
  const journalDirectory = join(paths.custodyDirectory, "journal");
  if (!(await requireSecureDirectory(journalDirectory, false))) return [];
  const names = await readdir(journalDirectory);
  const revisions = names
    .map((name) => {
      const match = /^revision-([0-9]{16})\.json$/u.exec(name);
      if (match === null) return null;
      return { name, revision: Number(match[1]) };
    })
    .filter((entry): entry is { readonly name: string; readonly revision: number } =>
      entry !== null
    )
    .sort((left, right) => left.revision - right.revision);
  if (revisions.length > MAX_CUSTODY_REVISIONS) {
    throw new TaskctlConfigError("VALIDATION_ERROR", "local human custody has too many revisions");
  }
  const records: HumanCustodyRevision[] = [];
  for (const [index, entry] of revisions.entries()) {
    if (entry.revision !== index) {
      throw new TaskctlConfigError("VALIDATION_ERROR", "local human custody revision chain is invalid");
    }
    const source = await readSecureFile(
      join(journalDirectory, entry.name),
      "human custody",
    );
    if (source === null) {
      throw new TaskctlConfigError("VALIDATION_ERROR", "local human custody revision is missing");
    }
    const parsed = humanCustodyRevisionSchema.safeParse(parseJson(source, "human custody"));
    if (!parsed.success || parsed.data.journal.revision !== entry.revision) {
      throw new TaskctlConfigError("VALIDATION_ERROR", "local human custody revision is invalid");
    }
    records.push(parsed.data);
  }
  return records;
}

function humanCustodyMetadata(paths: HumanStoragePaths): SecretCustodyMetadataStore {
  const writeRevision = async (
    expectedRevision: number | null,
    next: SecretCustodyJournal,
    quarantined: readonly SecretCustodyQuarantinePointer[],
  ): Promise<boolean> => {
    const records = await readHumanCustodyRevisions(paths);
    const currentRevision = records.at(-1)?.journal.revision ?? null;
    if (currentRevision !== expectedRevision) return false;
    const expectedNext = (expectedRevision ?? -1) + 1;
    if (next.revision !== expectedNext) {
      throw new TaskctlConfigError("VALIDATION_ERROR", "local human custody revision did not advance");
    }
    const record = humanCustodyRevisionSchema.parse({
      version: 1,
      journal: next,
      quarantined,
    });
    const source = `${JSON.stringify(record)}\n`;
    if (redactSecretsInText(source) !== source) {
      throw new TaskctlConfigError("VALIDATION_ERROR", "human custody metadata contained a secret");
    }
    await ensureHumanCustodyDirectory(paths);
    return await publishImmutable0600(
      custodyRevisionFile(paths, next.revision),
      source,
    );
  };

  return {
    read: async () => (await readHumanCustodyRevisions(paths)).at(-1)?.journal ?? null,
    compareAndSwap: async (input) =>
      await writeRevision(input.expectedRevision, input.next, []),
    compareAndSwapWithQuarantine: async (input) =>
      await writeRevision(input.expectedRevision, input.next, input.quarantined),
    isQuarantinedSlot: async (input) =>
      (await readHumanCustodyRevisions(paths)).some((record) =>
        record.quarantined.some(({ pointer }) => pointer.slot === input.slot)
      ),
  };
}

function humanCustodyDescriptor(paths: HumanStoragePaths): SecretCustodyDescriptor {
  const nameDigest = createHash("sha256")
    .update(resolve(paths.profileFile), "utf8")
    .digest("hex")
    .slice(0, 32);
  return { service: paths.keychainService, name: `human-${nameDigest}` };
}

function slotFromCustodyName(descriptor: SecretCustodyDescriptor, name: string): string {
  const prefix = `${descriptor.name}:slot:`;
  if (!name.startsWith(prefix) || name.length === prefix.length) {
    throw new TaskctlConfigError("VALIDATION_ERROR", "local human custody slot is invalid");
  }
  return name.slice(prefix.length);
}

function humanGenerationalSecretStore(
  paths: HumanStoragePaths,
  keychain: HumanSecretStore,
): GenerationalSecretStore {
  const descriptor = humanCustodyDescriptor(paths);
  const filePath = (slot: string): string => join(paths.fileSlotDirectory, slot);
  return {
    get: async (input) => {
      const slot = slotFromCustodyName(descriptor, input.name);
      if (slot.startsWith("file_")) {
        return await readSecureFile(filePath(slot), "human secret");
      }
      if (!slot.startsWith("keychain_")) {
        throw new TaskctlConfigError("VALIDATION_ERROR", "local human custody slot is invalid");
      }
      return await keychain.get(input);
    },
    set: async (input) => {
      const slot = slotFromCustodyName(descriptor, input.name);
      if (slot.startsWith("file_")) {
        await ensureHumanFileSlotDirectory(paths);
        if (!(await publishImmutable0600(filePath(slot), input.value))) {
          throw new TaskctlConfigError("INTERNAL_ERROR", "human file custody slot already exists");
        }
        return;
      }
      if (!slot.startsWith("keychain_")) {
        throw new TaskctlConfigError("VALIDATION_ERROR", "local human custody slot is invalid");
      }
      await keychain.set(input);
    },
    delete: async (input) => {
      const slot = slotFromCustodyName(descriptor, input.name);
      if (!slot.startsWith("file_")) return await keychain.delete(input);
      try {
        await unlink(filePath(slot));
        return true;
      } catch (error) {
        if (missingFile(error)) return false;
        throw error;
      }
    },
  };
}

function humanCustody(
  paths: HumanStoragePaths,
  keychain: HumanSecretStore,
  random?: RandomSource,
  nextStore: "keychain" | "file" = "keychain",
): GenerationalSecretCustody {
  const allocateSlot = (): string => {
    custodySlotCounter += 1;
    return `${nextStore}_${randomHex(random as RandomSource, 20)}_${process.pid.toString(36)}_${custodySlotCounter.toString(36)}`;
  };
  return new GenerationalSecretCustody({
    descriptor: humanCustodyDescriptor(paths),
    metadata: humanCustodyMetadata(paths),
    secrets: humanGenerationalSecretStore(paths, keychain),
    nextSlot: random === undefined
      ? () => {
          throw new TaskctlConfigError("INTERNAL_ERROR", "human custody cannot allocate a slot");
        }
      : allocateSlot,
    requireExplicitPendingRecovery: true,
  });
}

function humanCustodyFailure(error: unknown): TaskctlConfigError {
  if (error instanceof TaskctlConfigError) return error;
  if (error instanceof SecretCustodyError) {
    return new TaskctlConfigError(
      error.reason === "pending_secret_missing" || error.reason === "stale_generation"
        ? "AUTHENTICATION_FAILED"
        : "INTERNAL_ERROR",
      error.reason === "pending_secret_missing" || error.reason === "stale_generation"
        ? "stored human authentication requires recovery; run auth login"
        : "local human credential custody is unavailable",
    );
  }
  return new TaskctlConfigError("INTERNAL_ERROR", "local human credential custody is unavailable");
}

function storedHumanCredentialSource(
  authentication: HumanAuthentication,
  secretStore: "keychain" | "file",
): string {
  const stored = storedHumanCredentialSchema.parse({
    version: 1,
    secretStore,
    authentication,
  });
  return JSON.stringify(stored);
}

function parseStoredHumanCredential(source: string): StoredHumanCredential {
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch {
    throw new TaskctlConfigError(
      "AUTHENTICATION_FAILED",
      "stored human authentication requires recovery; run auth login",
    );
  }
  const parsed = storedHumanCredentialSchema.safeParse(value);
  if (!parsed.success) {
    throw new TaskctlConfigError(
      "AUTHENTICATION_FAILED",
      "stored human authentication requires recovery; run auth login",
    );
  }
  return parsed.data;
}

async function readSecretSource(
  paths: HumanStoragePaths,
  profile: Readonly<{ readonly secretStore: "keychain" | "file" }>,
  keychain: HumanSecretStore,
): Promise<string | null> {
  if (profile.secretStore === "file") return await readSecureFile(paths.secretFile, "human secret");
  try {
    return await keychain.get({ service: paths.keychainService, name: paths.keychainName });
  } catch {
    throw new TaskctlConfigError(
      "INTERNAL_ERROR",
      "could not read the operating-system keychain; use auth login --secret-store file only if a keychain is unavailable",
    );
  }
}

interface FixedHumanCustody {
  readonly profileSource: string;
  readonly secretSource: string;
  readonly secretStore: "keychain" | "file";
  readonly authentication?: HumanAuthentication;
}

export interface HumanAuthenticationObservation {
  readonly authentication: HumanAuthentication;
  readonly profile: HumanProfile;
  readonly generation: number | null;
}

async function inspectFixedHumanCustody(
  paths: HumanStoragePaths,
  keychain: HumanSecretStore,
): Promise<FixedHumanCustody | null> {
  const profileSource = await readSecureFile(paths.profileFile, "human profile");
  if (profileSource === null) return null;
  const profileValue = parseJson(profileSource, "human profile");
  if (
    typeof profileValue !== "object" ||
    profileValue === null ||
    !("secretStore" in profileValue) ||
    (profileValue.secretStore !== "keychain" && profileValue.secretStore !== "file")
  ) {
    throw new TaskctlConfigError("VALIDATION_ERROR", "local taskctl human profile is invalid");
  }
  const secretStore = profileValue.secretStore;
  const secretSource = await readSecretSource(paths, { secretStore }, keychain);
  if (secretSource === null) {
    throw new TaskctlConfigError("AUTHENTICATION_FAILED", "human authentication is not configured");
  }
  const secretValue = parseJson(secretSource, "human secret");
  if (
    storedHumanProfileDisposition(profileValue) === "legacy" ||
    storedHumanAuthenticationDisposition(secretValue) === "legacy"
  ) {
    return { profileSource, secretSource, secretStore };
  }
  const profile = humanProfileSchema.safeParse(profileValue);
  const authentication = humanAuthenticationSchema.safeParse(secretValue);
  if (
    !profile.success ||
    !authentication.success ||
    authentication.data.apiUrl !== profile.data.apiUrl
  ) {
    throw new TaskctlConfigError("VALIDATION_ERROR", "local taskctl human authentication is invalid");
  }
  return {
    profileSource,
    secretSource,
    secretStore,
    authentication: authentication.data,
  };
}

export async function readHumanAuthentication(
  paths: HumanStoragePaths,
  keychain: HumanSecretStore = bunHumanSecretStore,
): Promise<HumanAuthenticationObservation | null> {
  const custody = humanCustody(paths, keychain);
  try {
    const current = await custody.read();
    if (current !== null) {
      const stored = parseStoredHumanCredential(current.value);
      return {
        authentication: stored.authentication,
        profile: profileFromHumanAuthentication(
          stored.authentication,
          stored.secretStore,
        ),
        generation: current.generation,
      };
    }
    if ((await custody.inspectLiveValues()).sourceRevision !== null) return null;
  } catch (error) {
    throw humanCustodyFailure(error);
  }

  const fixed = await inspectFixedHumanCustody(paths, keychain);
  if (fixed === null) return null;
  if (fixed.authentication === undefined) {
    throw new TaskctlConfigError(
      "AUTHENTICATION_FAILED",
      "stored human authentication requires recovery; run auth login",
    );
  }
  return {
    authentication: fixed.authentication,
    profile: profileFromHumanAuthentication(fixed.authentication, fixed.secretStore),
    generation: null,
  };
}

async function preserveFixedHumanCustody(
  paths: HumanStoragePaths,
  fixed: FixedHumanCustody,
  random: RandomSource,
  keychain: HumanSecretStore,
): Promise<void> {
  const evidence = JSON.stringify({
    version: 1,
    kind: "fixed-layout-recovery",
    secretStore: fixed.secretStore,
    profileSource: fixed.profileSource,
    secretSource: fixed.secretSource,
  });
  if (new TextEncoder().encode(evidence).length > MAX_CONFIGURATION_BYTES) {
    throw new TaskctlConfigError(
      "AUTHENTICATION_FAILED",
      "stored human authentication cannot be preserved safely",
    );
  }
  const custody = humanCustody(paths, keychain, random, fixed.secretStore);
  const pointer = await custody.compareAndSwap(null, evidence);
  if (pointer === null) {
    throw new TaskctlConfigError("INTERNAL_ERROR", "human authentication changed concurrently");
  }
  const inspected = await custody.inspectLiveValues();
  const preserved = await custody.preserveLiveValuesForRecovery(inspected);
  if (preserved.state !== "quarantined") {
    throw new TaskctlConfigError("INTERNAL_ERROR", "human authentication recovery was not preserved");
  }
}

async function preserveLiveHumanCustodyForExplicitRecovery(
  paths: HumanStoragePaths,
  keychain: HumanSecretStore,
): Promise<void> {
  const custody = humanCustody(paths, keychain);
  const inspected = await custody.inspectLiveValues();
  if (inspected.values.length === 0) return;
  const preserved = await custody.preserveLiveValuesForRecovery(inspected);
  if (preserved.state !== "quarantined") {
    throw new TaskctlConfigError("INTERNAL_ERROR", "human authentication recovery was not preserved");
  }
}

async function writeHumanProfileProjection(
  paths: HumanStoragePaths,
  authentication: HumanAuthentication,
  secretStore: "keychain" | "file",
  random: RandomSource,
): Promise<void> {
  const profile = profileFromHumanAuthentication(authentication, secretStore);
  const profileSource = `${JSON.stringify(profile)}\n`;
  if (redactSecretsInText(profileSource) !== profileSource) {
    throw new TaskctlConfigError("VALIDATION_ERROR", "human profile metadata contained a secret");
  }
  await atomicWrite0600(paths.profileFile, profileSource, random);
}

async function writeHumanAuthenticationUnlocked(
  paths: HumanStoragePaths,
  authentication: HumanAuthentication,
  secretStore: "keychain" | "file",
  random: RandomSource,
  keychain: HumanSecretStore = bunHumanSecretStore,
  options: Readonly<{ readonly replaceLegacy?: boolean }> = {},
): Promise<void> {
  const parsed = humanAuthenticationSchema.parse(authentication);
  let current: HumanAuthenticationObservation | null = null;
  try {
    current = await readHumanAuthentication(paths, keychain);
  } catch (error) {
    if (options.replaceLegacy !== true) throw error;
    const inspection = await humanCustody(paths, keychain).inspectLiveValues();
    if (inspection.sourceRevision === null) {
      const fixed = await inspectFixedHumanCustody(paths, keychain);
      if (fixed === null) throw error;
      await preserveFixedHumanCustody(paths, fixed, random, keychain);
    } else {
      await preserveLiveHumanCustodyForExplicitRecovery(paths, keychain);
    }
  }
  if (current?.generation === null && options.replaceLegacy === true) {
    const fixed = await inspectFixedHumanCustody(paths, keychain);
    if (fixed !== null) {
      await preserveFixedHumanCustody(paths, fixed, random, keychain);
      current = null;
    }
  }
  const custody = humanCustody(paths, keychain, random, secretStore);
  // The profile is a token-free projection, never the authority read by an
  // authenticated operation. Persist it before publishing the credential so
  // a projection failure cannot strand a remotely rotated scope as locally
  // live-but-unreported.
  await writeHumanProfileProjection(paths, parsed, secretStore, random);
  let pointer: Awaited<ReturnType<GenerationalSecretCustody["compareAndSwap"]>>;
  try {
    pointer = await custody.compareAndSwap(
      current?.generation ?? null,
      storedHumanCredentialSource(parsed, secretStore),
    );
  } catch (error) {
    throw humanCustodyFailure(error);
  }
  if (pointer === null) {
    throw new TaskctlConfigError("INTERNAL_ERROR", "human authentication changed concurrently");
  }
}

export async function writeHumanAuthentication(
  paths: HumanStoragePaths,
  authentication: HumanAuthentication,
  secretStore: "keychain" | "file",
  random: RandomSource,
  keychain: HumanSecretStore = bunHumanSecretStore,
  options: Readonly<{ readonly replaceLegacy?: boolean }> = {},
): Promise<void> {
  await withHumanCustodyLock(paths, async () => {
    await writeHumanAuthenticationUnlocked(
      paths,
      authentication,
      secretStore,
      random,
      keychain,
      options,
    );
  });
}

export async function updateHumanAuthentication(
  paths: HumanStoragePaths,
  currentProfile: HumanProfile,
  authentication: HumanAuthentication,
  random: RandomSource,
  keychain: HumanSecretStore = bunHumanSecretStore,
): Promise<void> {
  const current = await readHumanAuthentication(paths, keychain);
  if (current === null) {
    throw new TaskctlConfigError("AUTHENTICATION_FAILED", "human authentication is not configured");
  }
  if ((await compareAndSwapHumanAuthentication(
    paths,
    current,
    authentication,
    random,
    keychain,
  )) === null) {
    throw new TaskctlConfigError("INTERNAL_ERROR", "human authentication changed concurrently");
  }
  void currentProfile;
}

function sameHumanAuthentication(
  left: HumanAuthentication,
  right: HumanAuthentication,
): boolean {
  return JSON.stringify(humanAuthenticationSchema.parse(left)) ===
    JSON.stringify(humanAuthenticationSchema.parse(right));
}

/** Replace one exact locally observed v2 credential as a single custody unit. */
export async function compareAndSwapHumanAuthentication(
  paths: HumanStoragePaths,
  expected: Readonly<{
    readonly authentication: HumanAuthentication;
    readonly generation: number | null;
  }>,
  next: HumanAuthentication,
  random: RandomSource,
  keychain: HumanSecretStore = bunHumanSecretStore,
): Promise<HumanAuthenticationObservation | null> {
  const parsedExpected = humanAuthenticationSchema.parse(expected.authentication);
  const parsedNext = humanAuthenticationSchema.parse(next);
  return await withHumanCustodyLock(paths, async () => {
    const inspectionCustody = humanCustody(paths, keychain);
    let current: HumanAuthenticationObservation | null;
    let inspected: SecretCustodyLiveInspection;
    try {
      inspected = await inspectionCustody.inspectLiveValues();
    } catch (error) {
      throw humanCustodyFailure(error);
    }
    if (inspected.sourceRevision === null) {
      current = await readHumanAuthentication(paths, keychain);
    } else {
      // Another process that has published a pending pointer owns this CAS.
      // Returning a lost race avoids recovering, promoting, or deleting its
      // in-flight generation.
      if (inspected.values.some(({ role }) => role === "pending")) return null;
      const committed = inspected.values.find(({ role }) => role === "committed");
      if (committed === undefined) {
        current = null;
      } else if (committed.state !== "valid") {
        throw new TaskctlConfigError(
          "AUTHENTICATION_FAILED",
          "stored human authentication requires recovery; run auth login",
        );
      } else {
        const stored = parseStoredHumanCredential(committed.value);
        current = {
          authentication: stored.authentication,
          profile: profileFromHumanAuthentication(
            stored.authentication,
            stored.secretStore,
          ),
          generation: committed.pointer.generation,
        };
      }
    }
    if (
      current === null ||
      current.generation !== expected.generation ||
      !sameHumanAuthentication(current.authentication, parsedExpected)
    ) {
      return null;
    }
    const custody = humanCustody(paths, keychain, random, current.profile.secretStore);
    await writeHumanProfileProjection(
      paths,
      parsedNext,
      current.profile.secretStore,
      random,
    );
    let pointer: Awaited<ReturnType<GenerationalSecretCustody["compareAndSwap"]>>;
    try {
      pointer = await custody.compareAndSwap(
        current.generation,
        storedHumanCredentialSource(parsedNext, current.profile.secretStore),
      );
    } catch (error) {
      if (
        error instanceof SecretCustodyError &&
        (error.reason === "pending_secret_missing" ||
          error.reason === "concurrent_update")
      ) {
        return null;
      }
      throw humanCustodyFailure(error);
    }
    if (pointer === null) return null;
    return {
      authentication: parsedNext,
      profile: profileFromHumanAuthentication(
        parsedNext,
        current.profile.secretStore,
      ),
      generation: pointer.generation,
    };
  });
}

async function clearHumanAuthenticationUnlocked(
  paths: HumanStoragePaths,
  keychain: HumanSecretStore = bunHumanSecretStore,
): Promise<void> {
  let keychainFailure = false;
  try {
    await humanCustody(paths, keychain).clear();
  } catch (error) {
    throw humanCustodyFailure(error);
  }
  try {
    await keychain.delete({ service: paths.keychainService, name: paths.keychainName });
  } catch {
    keychainFailure = true;
  }
  await Promise.all([removeIfPresent(paths.secretFile), removeIfPresent(paths.profileFile)]);
  if (keychainFailure) {
    throw new TaskctlConfigError("INTERNAL_ERROR", "could not remove human authentication from the keychain");
  }
}

export async function clearHumanAuthentication(
  paths: HumanStoragePaths,
  keychain: HumanSecretStore = bunHumanSecretStore,
): Promise<void> {
  await withHumanCustodyLock(paths, async () => {
    await clearHumanAuthenticationUnlocked(paths, keychain);
  });
}

/**
 * Preserve only exact credentials involved in an indeterminate rotation.
 * Live admission is retired atomically while Keychain/file bytes remain.
 */
export async function preserveHumanAuthenticationIfCredentialMatches(
  paths: HumanStoragePaths,
  input: Readonly<{
    readonly expectedGeneration: number | null;
    readonly candidates: readonly HumanAuthentication[];
  }>,
  random: RandomSource,
  keychain: HumanSecretStore = bunHumanSecretStore,
): Promise<boolean> {
  const parsedCandidates = input.candidates.map((candidate) =>
    humanAuthenticationSchema.parse(candidate)
  );
  const successorGeneration = input.expectedGeneration === null
    ? 0
    : input.expectedGeneration < Number.MAX_SAFE_INTEGER
      ? input.expectedGeneration + 1
      : null;
  return await withHumanCustodyLock(paths, async () => {
    const custody = humanCustody(paths, keychain);
    const inspected = await custody.inspectLiveValues();
    if (inspected.sourceRevision === null) {
      const fixed = await inspectFixedHumanCustody(paths, keychain);
      const fixedAuthentication = fixed?.authentication;
      if (
        fixed === null ||
        input.expectedGeneration !== null ||
        fixedAuthentication === undefined ||
        !parsedCandidates.some((candidate) =>
          sameHumanAuthentication(fixedAuthentication, candidate)
        )
      ) return false;
      await preserveFixedHumanCustody(paths, fixed, random, keychain);
      return true;
    }
    if (inspected.values.length === 0) return false;
    let matchedCredential = false;
    let matchedContainmentGeneration = false;
    for (const observed of inspected.values) {
      const generationMatches =
        observed.pointer.generation === input.expectedGeneration ||
        observed.pointer.generation === successorGeneration;
      if (!generationMatches) return false;
      if (generationMatches) {
        matchedContainmentGeneration = true;
      }
      if (observed.state !== "valid") continue;
      let stored: StoredHumanCredential;
      try {
        stored = parseStoredHumanCredential(observed.value);
      } catch {
        continue;
      }
      if (
        !parsedCandidates.some((candidate) =>
          sameHumanAuthentication(stored.authentication, candidate)
        )
      ) return false;
      matchedCredential = true;
    }
    if (!matchedCredential || !matchedContainmentGeneration) return false;
    const preserved = await custody.preserveLiveValuesForRecovery(inspected);
    return preserved.state === "quarantined";
  });
}

export async function writeNewEnrollmentFile(path: string, enrollment: string): Promise<void> {
  requireAbsolute(path, "enrollment output path");
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  let created = false;
  try {
    handle = await open(
      path,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    created = true;
    await handle.writeFile(`${enrollment}\n`, "utf8");
    await handle.sync();
    await handle.chmod(0o600);
  } catch (error) {
    if (handle !== null) await handle.close().catch(() => undefined);
    handle = null;
    if (created) await unlink(path).catch(() => undefined);
    if (systemErrorCode(error) === "EEXIST" || systemErrorCode(error) === "ELOOP") {
      throw new TaskctlConfigError(
        "VALIDATION_ERROR",
        "enrollment output must name a new regular file",
      );
    }
    throw new TaskctlConfigError("INTERNAL_ERROR", "could not write the enrollment output file");
  } finally {
    if (handle !== null) await handle.close().catch(() => undefined);
  }
}

export async function readEnrollmentFile(path: string): Promise<EnrollmentToken | null> {
  const source = await readSecureFile(path, "enrollment output");
  if (source === null) return null;
  if (new TextEncoder().encode(source).length > 1_024) {
    throw new TaskctlConfigError("VALIDATION_ERROR", "enrollment output file is invalid");
  }
  const parsed = enrollmentTokenSchema.safeParse(source.trim());
  if (!parsed.success) {
    throw new TaskctlConfigError("VALIDATION_ERROR", "enrollment output file is invalid");
  }
  return parsed.data;
}

export function humanProfileOutput(profile: HumanProfile | null): unknown {
  if (profile === null) return null;
  return {
    authenticated: true,
    source: profile.secretStore,
    apiUrl: profile.apiUrl,
    user: profile.user,
    organization: profile.organization ?? null,
    workspace: profile.workspace ?? null,
  };
}
