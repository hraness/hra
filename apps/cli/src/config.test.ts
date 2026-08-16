import { describe, expect, test } from "bun:test";
import {
  createBearerSecret,
  createLocator,
  formatCredentialToken,
  type CredentialToken,
  type SessionId,
} from "@hraness/agent-tasks-protocol";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  MAX_AGENT_CONFIGURATION_BYTES,
  TaskctlConfigError,
  activeCredentialRecord,
  agentKeychainName,
  assertConfigurationFileMetadata,
  clearStoredAuthentication,
  credentialMetadataFile,
  generateCredentialToken,
  migrateLegacyStoredCredential,
  pendingCredentialRecord,
  readProfile,
  readStoredCredential,
  readStoredSessionAttempt,
  resolveAgentAuthorization,
  resolveStoragePaths,
  sessionAttemptFile,
  writeProfile,
  writeStoredCredential,
  type RandomSource,
  type AgentSecretStore,
  type StoragePaths,
  type TaskctlProfile,
} from "./config";

const SESSION_ID: SessionId = "ses_00000000000000000000000000";
const LOCAL_API_URL = "http://127.0.0.1:3211";

const deterministicRandom: RandomSource = (length) =>
  Uint8Array.from({ length }, (_, index) => (index * 13 + length) % 256);

interface FakeKeychain extends AgentSecretStore {
  readonly values: Map<string, string>;
  failGet: boolean;
  failSet: boolean;
  failDelete: boolean;
}

function fakeKeychain(): FakeKeychain {
  const values = new Map<string, string>();
  return {
    values,
    failGet: false,
    failSet: false,
    failDelete: false,
    get(input) {
      if (this.failGet) return Promise.reject(new Error(`secret leaked: ${values.get(input.name)}`));
      return Promise.resolve(values.get(`${input.service}:${input.name}`) ?? null);
    },
    set(input) {
      if (this.failSet) return Promise.reject(new Error(`secret leaked: ${input.value}`));
      values.set(`${input.service}:${input.name}`, input.value);
      return Promise.resolve();
    },
    delete(input) {
      if (this.failDelete) {
        return Promise.reject(new Error(`secret leaked: ${values.get(`${input.service}:${input.name}`)}`));
      }
      return Promise.resolve(values.delete(`${input.service}:${input.name}`));
    },
  };
}

function credential(): CredentialToken {
  return formatCredentialToken(
    createLocator(Uint8Array.from({ length: 26 }, (_, index) => index)),
    createBearerSecret(Uint8Array.from({ length: 32 }, (_, index) => index)),
  );
}

async function temporaryPaths(): Promise<{ readonly directory: string; readonly paths: StoragePaths }> {
  const directory = await mkdtemp(join(tmpdir(), "taskctl-config-test-"));
  return {
    directory,
    paths: {
      credentialFile: join(directory, "private", "credentials.json"),
      profileFile: join(directory, "public", "profile.json"),
    },
  };
}

describe("credential custody", () => {
  test("generates canonical credentials from an injected Web Crypto seam", () => {
    const first = generateCredentialToken(deterministicRandom);
    const second = generateCredentialToken(deterministicRandom);
    expect(first).toBe(second);
    expect(first).toStartWith("agt_");
  });

  test("defaults the storage primitive to keychain custody", async () => {
    const { directory, paths } = await temporaryPaths();
    const token = credential();
    const keychain = fakeKeychain();
    try {
      const active = activeCredentialRecord(token, SESSION_ID, 1_800_000_000_000);
      await writeStoredCredential(paths, active, deterministicRandom, keychain);

      expect(stat(paths.credentialFile)).rejects.toMatchObject({ code: "ENOENT" });
      expect((await stat(credentialMetadataFile(paths))).mode & 0o777).toBe(0o600);
      const metadata = await readFile(credentialMetadataFile(paths), "utf8");
      expect(metadata).toContain('"secretStore":"keychain"');
      expect(metadata).toContain(SESSION_ID);
      expect(metadata).not.toContain(token);
      expect(metadata).not.toContain(token.slice(-43));
      expect(keychain.values.get(`com.jungle.taskctl:${agentKeychainName(paths)}`)).toBe(token);
      expect(await readStoredCredential(paths, keychain)).toEqual(active);

      await clearStoredAuthentication(paths, keychain);
      expect(keychain.values.size).toBe(0);
      expect(stat(credentialMetadataFile(paths))).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("keychain failures are deterministic, retryable, and redact credential values", async () => {
    const { directory, paths } = await temporaryPaths();
    const token = credential();
    const keychain = fakeKeychain();
    const active = activeCredentialRecord(token, SESSION_ID, 1_800_000_000_000);
    try {
      keychain.failSet = true;
      expect(
        writeStoredCredential(paths, active, deterministicRandom, keychain),
      ).rejects.toMatchObject({ code: "INTERNAL_ERROR" });
      let errorText = "";
      try {
        await writeStoredCredential(paths, active, deterministicRandom, keychain);
      } catch (error) {
        errorText = error instanceof Error ? `${error.name}: ${error.message}` : JSON.stringify(error);
      }
      expect(errorText).not.toContain(token);
      expect(errorText).not.toContain(token.slice(-43));
      expect(stat(credentialMetadataFile(paths))).rejects.toMatchObject({ code: "ENOENT" });

      keychain.failSet = false;
      await writeStoredCredential(paths, active, deterministicRandom, keychain);
      keychain.failGet = true;
      expect(readStoredCredential(paths, keychain)).rejects.toMatchObject({
        code: "INTERNAL_ERROR",
      });
      keychain.failGet = false;
      keychain.failDelete = true;
      expect(clearStoredAuthentication(paths, keychain)).rejects.toMatchObject({
        code: "INTERNAL_ERROR",
      });
      expect(await readStoredCredential(paths, keychain)).toEqual(active);
      keychain.failDelete = false;
      await clearStoredAuthentication(paths, keychain);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("migrates legacy credential files only through the explicit command path", async () => {
    const { directory, paths } = await temporaryPaths();
    const token = credential();
    const keychain = fakeKeychain();
    const legacy = activeCredentialRecord(token, SESSION_ID, 1_800_000_000_000);
    try {
      await mkdir(join(directory, "private"), { recursive: true });
      await writeFile(paths.credentialFile, `${JSON.stringify(legacy)}\n`, { mode: 0o600 });
      expect(readStoredCredential(paths, keychain)).rejects.toThrow(
        "auth migrate-agent-credential",
      );

      keychain.failSet = true;
      expect(
        migrateLegacyStoredCredential(paths, "keychain", deterministicRandom, keychain),
      ).rejects.toMatchObject({ code: "INTERNAL_ERROR" });
      expect(await readFile(paths.credentialFile, "utf8")).toContain(token);

      keychain.failSet = false;
      expect(
        await migrateLegacyStoredCredential(paths, "keychain", deterministicRandom, keychain),
      ).toEqual(legacy);
      expect(stat(paths.credentialFile)).rejects.toMatchObject({ code: "ENOENT" });
      expect(await readStoredCredential(paths, keychain)).toEqual(legacy);
    } finally {
      await clearStoredAuthentication(paths, keychain).catch(() => undefined);
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("keeps explicit file-fallback secrets separate from non-secret state", async () => {
    const { directory, paths } = await temporaryPaths();
    const token = credential();
    try {
      await writeStoredCredential(
        paths,
        pendingCredentialRecord(token, LOCAL_API_URL),
        deterministicRandom,
        fakeKeychain(),
        "file",
      );
      expect(await readStoredCredential(paths)).toEqual({
        version: 2,
        state: "pending_enrollment",
        credential: token,
        apiUrl: LOCAL_API_URL,
      });

      await writeStoredCredential(
        paths,
        activeCredentialRecord(token, SESSION_ID, 1_800_000_000_000),
        deterministicRandom,
        fakeKeychain(),
        "file",
      );
      await writeProfile(
        paths,
        {
          version: 1,
          apiUrl: "http://127.0.0.1:3211",
          agentId: "agent-1",
          credentialId: "credential-1",
          credentialExpiresAt: 1_800_000_000_000,
          scopes: ["tasks:read", "tasks:claim"],
        },
        deterministicRandom,
      );

      expect((await stat(paths.credentialFile)).mode & 0o777).toBe(0o600);
      expect((await stat(paths.profileFile)).mode & 0o777).toBe(0o600);
      const credentialSource = await readFile(paths.credentialFile, "utf8");
      const metadataSource = await readFile(credentialMetadataFile(paths), "utf8");
      const profileSource = await readFile(paths.profileFile, "utf8");
      expect(credentialSource).toContain(token);
      expect(credentialSource).not.toContain(SESSION_ID);
      expect(metadataSource).toContain(SESSION_ID);
      expect(metadataSource).not.toContain(token);
      expect(metadataSource).not.toContain(token.slice(-43));
      expect(profileSource).not.toContain(token);
      expect(profileSource).not.toContain(token.slice(-43));
      expect(profileSource).not.toContain(SESSION_ID);
      expect(await readProfile(paths)).toMatchObject({ agentId: "agent-1" });
      expect((await readdir(join(directory, "private"))).sort()).toEqual([
        "credentials.json",
        "credentials.json.metadata",
      ]);
      expect(await readdir(join(directory, "public"))).toEqual(["profile.json"]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("environment credentials require their own explicit session override", async () => {
    const { directory, paths } = await temporaryPaths();
    const token = credential();
    try {
      await writeStoredCredential(
        paths,
        activeCredentialRecord(token, SESSION_ID, 1_800_000_000_000),
        deterministicRandom,
        fakeKeychain(),
        "file",
      );
      let rejected: unknown;
      try {
        await resolveAgentAuthorization({ TASKCTL_TOKEN: token }, paths);
      } catch (error) {
        rejected = error;
      }
      expect(rejected).toMatchObject({ code: "SESSION_REQUIRED" });
      const resolved = await resolveAgentAuthorization(
        { TASKCTL_TOKEN: token, TASKCTL_SESSION_ID: SESSION_ID },
        paths,
      );
      expect(resolved).toEqual({
        source: "environment",
        authorization: { credential: token, sessionId: SESSION_ID },
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("logout removes both local records without affecting path overrides", async () => {
    const { directory, paths } = await temporaryPaths();
    const token = credential();
    try {
      await writeStoredCredential(
        paths,
        pendingCredentialRecord(token, LOCAL_API_URL),
        deterministicRandom,
        fakeKeychain(),
        "file",
      );
      await writeProfile(
        paths,
        {
          version: 1,
          apiUrl: "http://127.0.0.1:3211",
          agentId: "agent-1",
          scopes: ["tasks:read"],
        },
        deterministicRandom,
      );
      await clearStoredAuthentication(paths);
      expect(await readStoredCredential(paths)).toBeNull();
      expect(await readProfile(paths)).toBeNull();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

test("storage paths are independently overrideable", () => {
  expect(
    resolveStoragePaths({
      TASKCTL_CONFIG_HOME: "/unused",
      TASKCTL_CREDENTIAL_FILE: "/tmp/taskctl-test-credential",
      TASKCTL_PROFILE_FILE: "/tmp/taskctl-test-profile",
    }),
  ).toEqual({
    credentialFile: "/tmp/taskctl-test-credential",
    profileFile: "/tmp/taskctl-test-profile",
  });
  expect(() =>
    resolveStoragePaths({
      TASKCTL_CREDENTIAL_FILE: "/tmp/same",
      TASKCTL_PROFILE_FILE: "/tmp/same",
    }),
  ).toThrow(TaskctlConfigError);
  expect(() => resolveStoragePaths({ TASKCTL_CONFIG_HOME: "relative" })).toThrow(
    TaskctlConfigError,
  );
  expect(() =>
    resolveStoragePaths({
      TASKCTL_CREDENTIAL_FILE: "relative.json",
      TASKCTL_PROFILE_FILE: "/tmp/profile.json",
    }),
  ).toThrow(TaskctlConfigError);
});

test("configuration reads reject unsafe file metadata", async () => {
  const { directory, paths } = await temporaryPaths();
  const token = credential();
  try {
    await writeStoredCredential(
      paths,
      pendingCredentialRecord(token, LOCAL_API_URL),
      deterministicRandom,
      fakeKeychain(),
      "file",
    );
    await chmod(credentialMetadataFile(paths), 0o644);
    expect(readStoredCredential(paths)).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await chmod(credentialMetadataFile(paths), 0o600);
    await chmod(paths.credentialFile, 0o644);
    expect(readStoredCredential(paths)).rejects.toMatchObject({ code: "VALIDATION_ERROR" });

    await rm(paths.credentialFile, { force: true });
    const target = join(directory, "credential-target.json");
    await writeFile(
      target,
      `${JSON.stringify(pendingCredentialRecord(token, LOCAL_API_URL))}\n`,
      { mode: 0o600 },
    );
    await mkdir(join(directory, "private"), { recursive: true });
    await symlink(target, paths.credentialFile);
    expect(readStoredCredential(paths)).rejects.toMatchObject({ code: "VALIDATION_ERROR" });

    await rm(paths.credentialFile, { force: true });
    if (process.platform !== "win32") {
      const fifo = Bun.spawnSync(["/usr/bin/mkfifo", paths.credentialFile], {
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(fifo.exitCode).toBe(0);
      expect(readStoredCredential(paths)).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
      await rm(paths.credentialFile, { force: true });
    }
    await mkdir(paths.credentialFile);
    expect(readStoredCredential(paths)).rejects.toMatchObject({ code: "VALIDATION_ERROR" });

    expect(() =>
      assertConfigurationFileMetadata(
        "profile",
        { isRegularFile: true, mode: 0o600, uid: 2000 },
        1000,
      ),
    ).toThrow(TaskctlConfigError);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("authoritative profiles require regular owner-only files", async () => {
  const { directory, paths } = await temporaryPaths();
  const profile: TaskctlProfile = {
    version: 1,
    apiUrl: LOCAL_API_URL,
    agentId: "agent-1",
    scopes: ["tasks:read"],
  };
  try {
    await writeProfile(paths, profile, deterministicRandom);
    await chmod(paths.profileFile, 0o640);
    expect(readProfile(paths)).rejects.toMatchObject({ code: "VALIDATION_ERROR" });

    await rm(paths.profileFile, { force: true });
    const target = join(directory, "profile-target.json");
    await writeFile(target, `${JSON.stringify(profile)}\n`, { mode: 0o600 });
    await mkdir(join(directory, "public"), { recursive: true });
    await symlink(target, paths.profileFile);
    expect(readProfile(paths)).rejects.toMatchObject({ code: "VALIDATION_ERROR" });

    await rm(paths.profileFile, { force: true });
    await mkdir(paths.profileFile);
    expect(readProfile(paths)).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("agent credential metadata, fallback, profile, and session reads reject oversized files", async () => {
  const { directory, paths } = await temporaryPaths();
  const oversized = "x".repeat(MAX_AGENT_CONFIGURATION_BYTES + 1);
  try {
    await Promise.all([
      mkdir(join(directory, "private"), { recursive: true }),
      mkdir(join(directory, "public"), { recursive: true }),
    ]);
    await writeFile(credentialMetadataFile(paths), oversized, { mode: 0o600 });
    expect(readStoredCredential(paths)).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await rm(credentialMetadataFile(paths), { force: true });

    await writeFile(paths.credentialFile, oversized, { mode: 0o600 });
    expect(readStoredCredential(paths)).rejects.toMatchObject({ code: "VALIDATION_ERROR" });

    await writeFile(paths.profileFile, oversized, { mode: 0o600 });
    expect(readProfile(paths)).rejects.toMatchObject({ code: "VALIDATION_ERROR" });

    await writeFile(sessionAttemptFile(paths), oversized, { mode: 0o600 });
    expect(readStoredSessionAttempt(paths)).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("legacy pending-enrollment records fail safe instead of changing API origin", async () => {
  const { directory, paths } = await temporaryPaths();
  const token = credential();
  try {
    await mkdir(join(directory, "private"), { recursive: true });
    await writeFile(
      paths.credentialFile,
      `${JSON.stringify({ version: 1, state: "pending_enrollment", credential: token })}\n`,
      { mode: 0o600 },
    );
    expect(readStoredCredential(paths)).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
