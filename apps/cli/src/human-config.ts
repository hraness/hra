import {
  enrollmentTokenSchema,
  redactSecretsInText,
  type EnrollmentToken,
} from "@hraness/agent-tasks-protocol";
import {
  humanAuthenticationSchema,
  humanProfileSchema,
  profileFromHumanAuthentication,
  type HumanAuthentication,
  type HumanProfile,
} from "@hraness/hra-human-client";
import { constants } from "node:fs";
import { chmod, mkdir, open, rename, unlink } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";

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
export {
  humanAuthenticationSchema,
  humanProfileSchema,
  type HumanAuthentication,
  type HumanProfile,
} from "@hraness/hra-human-client";

export interface HumanStoragePaths {
  readonly profileFile: string;
  readonly secretFile: string;
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
    keychainService: TASKCTL_KEYCHAIN_SERVICE,
    keychainName: `human:${resolve(profileFile)}`,
  };
}

async function readSecureFile(
  path: string,
  kind: "human profile" | "human secret" | "enrollment output",
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

function parseJson(source: string, kind: "human profile" | "human secret"): unknown {
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

export async function readHumanProfile(paths: HumanStoragePaths): Promise<HumanProfile | null> {
  const source = await readSecureFile(paths.profileFile, "human profile");
  if (source === null) return null;
  const parsed = humanProfileSchema.safeParse(parseJson(source, "human profile"));
  if (!parsed.success) {
    throw new TaskctlConfigError("VALIDATION_ERROR", "local taskctl human profile is invalid");
  }
  return parsed.data;
}

async function readSecretSource(
  paths: HumanStoragePaths,
  profile: HumanProfile,
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

export async function readHumanAuthentication(
  paths: HumanStoragePaths,
  keychain: HumanSecretStore = bunHumanSecretStore,
): Promise<{ readonly authentication: HumanAuthentication; readonly profile: HumanProfile } | null> {
  const profile = await readHumanProfile(paths);
  if (profile === null) return null;
  const source = await readSecretSource(paths, profile, keychain);
  if (source === null) {
    throw new TaskctlConfigError("AUTHENTICATION_FAILED", "human authentication is not configured");
  }
  if (new TextEncoder().encode(source).length > MAX_CONFIGURATION_BYTES) {
    throw new TaskctlConfigError("VALIDATION_ERROR", "local taskctl human secret is invalid");
  }
  const parsed = humanAuthenticationSchema.safeParse(parseJson(source, "human secret"));
  if (!parsed.success || parsed.data.apiUrl !== profile.apiUrl) {
    throw new TaskctlConfigError("VALIDATION_ERROR", "local taskctl human authentication is invalid");
  }
  return {
    authentication: parsed.data,
    profile: profileFromHumanAuthentication(parsed.data, profile.secretStore),
  };
}

export async function writeHumanAuthentication(
  paths: HumanStoragePaths,
  authentication: HumanAuthentication,
  secretStore: "keychain" | "file",
  random: RandomSource,
  keychain: HumanSecretStore = bunHumanSecretStore,
): Promise<void> {
  const parsed = humanAuthenticationSchema.parse(authentication);
  const secretSource = `${JSON.stringify(parsed)}\n`;
  const profile = profileFromHumanAuthentication(parsed, secretStore);
  const profileSource = `${JSON.stringify(profile)}\n`;
  if (redactSecretsInText(profileSource) !== profileSource) {
    throw new TaskctlConfigError("VALIDATION_ERROR", "human profile metadata contained a secret");
  }

  const previousProfile = await readHumanProfile(paths);
  const previousSecret =
    previousProfile === null
      ? null
      : await readSecretSource(paths, previousProfile, keychain);

  const writeSecret = async (store: "keychain" | "file", source: string): Promise<void> => {
    if (store === "keychain") {
      try {
        await keychain.set({
          service: paths.keychainService,
          name: paths.keychainName,
          value: source,
        });
      } catch {
        throw new TaskctlConfigError(
          "INTERNAL_ERROR",
          "could not write the operating-system keychain; retry with auth login --secret-store file only if a keychain is unavailable",
        );
      }
      return;
    }
    await atomicWrite0600(paths.secretFile, source, random);
  };

  const removeSecret = async (store: "keychain" | "file"): Promise<void> => {
    if (store === "keychain") {
      try {
        await keychain.delete({ service: paths.keychainService, name: paths.keychainName });
      } catch {
        throw new TaskctlConfigError(
          "INTERNAL_ERROR",
          "could not remove superseded human authentication from the operating-system keychain",
        );
      }
      return;
    }
    await removeIfPresent(paths.secretFile);
  };

  await writeSecret(secretStore, secretSource);

  try {
    await atomicWrite0600(paths.profileFile, profileSource, random);
  } catch (error) {
    try {
      if (previousProfile?.secretStore === secretStore && previousSecret !== null) {
        await writeSecret(secretStore, previousSecret);
      } else {
        await removeSecret(secretStore);
      }
    } catch {
      throw new TaskctlConfigError(
        "INTERNAL_ERROR",
        "could not restore the previous human authentication after a profile write failure",
      );
    }
    throw error;
  }

  if (previousProfile !== null && previousProfile.secretStore !== secretStore) {
    await removeSecret(previousProfile.secretStore);
  }
}

export async function updateHumanAuthentication(
  paths: HumanStoragePaths,
  currentProfile: HumanProfile,
  authentication: HumanAuthentication,
  random: RandomSource,
  keychain: HumanSecretStore = bunHumanSecretStore,
): Promise<void> {
  await writeHumanAuthentication(paths, authentication, currentProfile.secretStore, random, keychain);
}

export async function clearHumanAuthentication(
  paths: HumanStoragePaths,
  keychain: HumanSecretStore = bunHumanSecretStore,
): Promise<void> {
  const profile = await readHumanProfile(paths);
  let keychainFailure = false;
  if (profile?.secretStore === "keychain") {
    try {
      await keychain.delete({ service: paths.keychainService, name: paths.keychainName });
    } catch {
      keychainFailure = true;
    }
  }
  await Promise.all([removeIfPresent(paths.secretFile), removeIfPresent(paths.profileFile)]);
  if (keychainFailure) {
    throw new TaskctlConfigError("INTERNAL_ERROR", "could not remove human authentication from the keychain");
  }
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
