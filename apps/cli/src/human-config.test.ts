import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { RandomSource, StoragePaths } from "./config";
import {
  clearHumanAuthentication,
  readEnrollmentFile,
  readHumanAuthentication,
  resolveHumanStoragePaths,
  updateHumanAuthentication,
  writeHumanAuthentication,
  writeNewEnrollmentFile,
  type HumanAuthentication,
  type HumanSecretStore,
} from "./human-config";

const random: RandomSource = (length) =>
  Uint8Array.from({ length }, (_, index) => (length * 7 + index) % 256);

function agentPaths(directory: string): StoragePaths {
  return {
    credentialFile: join(directory, "credentials.json"),
    profileFile: join(directory, "profile.json"),
  };
}

function authentication(): HumanAuthentication {
  return {
    version: 1,
    apiUrl: "http://127.0.0.1:3211",
    accessToken: "access-token-that-is-long-enough",
    refreshToken: "refresh-token-that-is-long-enough",
    user: { id: "user_abc123", email: "human@example.com", name: "Human" },
  };
}

function refreshedAuthentication(): HumanAuthentication {
  return {
    ...authentication(),
    accessToken: "refreshed-access-token-that-is-long-enough",
    refreshToken: "refreshed-refresh-token-that-is-long-enough",
  };
}

function memoryKeychain(): HumanSecretStore & { readonly values: Map<string, string> } {
  const values = new Map<string, string>();
  const key = (input: { readonly service: string; readonly name: string }): string =>
    `${input.service}:${input.name}`;
  return {
    values,
    get: (input) => Promise.resolve(values.get(key(input)) ?? null),
    set: (input) => {
      values.set(key(input), input.value);
      return Promise.resolve();
    },
    delete: (input) => Promise.resolve(values.delete(key(input))),
  };
}

describe("human credential custody", () => {
  test("stores both tokens in an injected operating-system keychain and only metadata on disk", async () => {
    const directory = await mkdtemp(join(tmpdir(), "taskctl-human-config-"));
    const paths = resolveHumanStoragePaths({}, agentPaths(directory));
    const keychain = memoryKeychain();
    const value = authentication();
    try {
      await writeHumanAuthentication(paths, value, "keychain", random, keychain);

      const profileSource = await readFile(paths.profileFile, "utf8");
      expect(profileSource).not.toContain(value.accessToken);
      expect(profileSource).not.toContain(value.refreshToken);
      expect((await stat(paths.profileFile)).mode & 0o777).toBe(0o600);
      expect(keychain.values.size).toBe(1);
      expect(await readHumanAuthentication(paths, keychain)).toMatchObject({
        authentication: value,
        profile: { secretStore: "keychain", user: value.user },
      });

      await clearHumanAuthentication(paths, keychain);
      expect(keychain.values.size).toBe(0);
      expect(await readHumanAuthentication(paths, keychain)).toBeNull();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("uses a mode-0600 file only when the caller explicitly selects the fallback", async () => {
    const directory = await mkdtemp(join(tmpdir(), "taskctl-human-file-"));
    const paths = resolveHumanStoragePaths({}, agentPaths(directory));
    const keychain: HumanSecretStore = {
      get: () => Promise.reject(new Error("keychain unavailable")),
      set: () => Promise.reject(new Error("keychain unavailable")),
      delete: () => Promise.reject(new Error("keychain unavailable")),
    };
    try {
      await writeHumanAuthentication(paths, authentication(), "file", random, keychain);
      expect((await stat(paths.secretFile)).mode & 0o777).toBe(0o600);
      expect((await readHumanAuthentication(paths, keychain))?.profile.secretStore).toBe("file");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("never silently falls back when keychain persistence fails", async () => {
    const directory = await mkdtemp(join(tmpdir(), "taskctl-human-no-fallback-"));
    const paths = resolveHumanStoragePaths({}, agentPaths(directory));
    const unavailable: HumanSecretStore = {
      get: () => Promise.reject(new Error("unavailable")),
      set: () => Promise.reject(new Error("unavailable")),
      delete: () => Promise.reject(new Error("unavailable")),
    };
    try {
      expect(
        writeHumanAuthentication(paths, authentication(), "keychain", random, unavailable),
      ).rejects.toMatchObject({ code: "INTERNAL_ERROR" });
      expect(readFile(paths.secretFile, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("restores the previous keychain secret when profile replacement fails", async () => {
    const directory = await mkdtemp(join(tmpdir(), "taskctl-human-keychain-rollback-"));
    const paths = resolveHumanStoragePaths({}, agentPaths(directory));
    const keychain = memoryKeychain();
    const original = authentication();
    try {
      await writeHumanAuthentication(paths, original, "keychain", random, keychain);
      const current = await readHumanAuthentication(paths, keychain);
      expect(current).not.toBeNull();
      if (current === null) throw new Error("human authentication fixture disappeared");

      const failProfileWrite: RandomSource = () => {
        throw new Error("injected profile write failure");
      };
      expect(
        updateHumanAuthentication(
          paths,
          current.profile,
          refreshedAuthentication(),
          failProfileWrite,
          keychain,
        ),
      ).rejects.toMatchObject({ code: "INTERNAL_ERROR" });
      expect((await readHumanAuthentication(paths, keychain))?.authentication).toEqual(original);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("restores the previous mode-0600 secret file when profile replacement fails", async () => {
    const directory = await mkdtemp(join(tmpdir(), "taskctl-human-file-rollback-"));
    const paths = resolveHumanStoragePaths({}, agentPaths(directory));
    const keychain = memoryKeychain();
    const original = authentication();
    try {
      await writeHumanAuthentication(paths, original, "file", random, keychain);
      const current = await readHumanAuthentication(paths, keychain);
      expect(current).not.toBeNull();
      if (current === null) throw new Error("human authentication fixture disappeared");

      let writes = 0;
      const failSecondWrite: RandomSource = (length) => {
        writes += 1;
        if (writes === 2) throw new Error("injected profile write failure");
        return random(length);
      };
      expect(
        updateHumanAuthentication(
          paths,
          current.profile,
          refreshedAuthentication(),
          failSecondWrite,
          keychain,
        ),
      ).rejects.toMatchObject({ code: "INTERNAL_ERROR" });
      expect((await readHumanAuthentication(paths, keychain))?.authentication).toEqual(original);
      expect((await stat(paths.secretFile)).mode & 0o777).toBe(0o600);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("creates enrollment material only at a new absolute mode-0600 path", async () => {
    const directory = await mkdtemp(join(tmpdir(), "taskctl-enrollment-output-"));
    const path = join(directory, "nested", "builder.enrollment");
    try {
      await writeNewEnrollmentFile(path, "enr_local-test-token");
      expect(await readFile(path, "utf8")).toBe("enr_local-test-token\n");
      expect((await stat(path)).mode & 0o777).toBe(0o600);
      expect(writeNewEnrollmentFile(path, "replacement")).rejects.toMatchObject({
        code: "VALIDATION_ERROR",
      });
      expect(readEnrollmentFile(path)).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
      expect(writeNewEnrollmentFile("relative", "replacement")).rejects.toMatchObject({
        code: "VALIDATION_ERROR",
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
