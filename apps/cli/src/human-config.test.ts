import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { RandomSource, StoragePaths } from "./config";
import {
  clearHumanAuthentication,
  compareAndSwapHumanAuthentication,
  preserveHumanAuthenticationIfCredentialMatches,
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
    version: 2,
    apiUrl: "http://127.0.0.1:3211",
    accessToken: "access-token-that-is-long-enough",
    refreshToken: "refresh-token-that-is-long-enough",
    user: { id: "user_abc123", email: "human@example.com", name: "Human" },
    organization: {
      id: "organization-1",
      name: "Example",
      role: "owner",
      status: "active",
    },
    workspace: {
      id: "workspace-1",
      organizationId: "organization-1",
      slug: "core",
      name: "Core",
      taskKeyPrefix: "OPS",
      roles: ["planner"],
    },
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

const unavailableKeychain: HumanSecretStore = {
  get: () => Promise.reject(new Error("keychain unavailable")),
  set: () => Promise.reject(new Error("keychain unavailable")),
  delete: () => Promise.reject(new Error("keychain unavailable")),
};

async function waitForFile(path: string): Promise<void> {
  for (let attempt = 0; attempt < 1_000; attempt += 1) {
    try {
      await stat(path);
      return;
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
        throw error;
      }
    }
    await Bun.sleep(2);
  }
  throw new Error("human custody subprocess did not become ready");
}

function startCustodyWorker(input: unknown) {
  const subprocess = Bun.spawn(
    [process.execPath, "run", join(import.meta.dir, "human-custody-process-worker.ts")],
    {
      cwd: import.meta.dir,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const inputWritten = (async () => {
    await subprocess.stdin.write(JSON.stringify(input));
    await subprocess.stdin.end();
  })();
  return { subprocess, inputWritten };
}

async function custodyWorkerResult(
  worker: ReturnType<typeof startCustodyWorker>,
): Promise<boolean> {
  await worker.inputWritten;
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(worker.subprocess.stdout).text(),
    new Response(worker.subprocess.stderr).text(),
    worker.subprocess.exited,
  ]);
  if (exitCode !== 0) {
    throw new Error(`human custody subprocess failed: ${stderr.trim()}`);
  }
  const value: unknown = JSON.parse(stdout);
  if (
    typeof value !== "object" ||
    value === null ||
    !("replaced" in value) ||
    typeof value.replaced !== "boolean"
  ) {
    throw new Error("human custody subprocess returned invalid output");
  }
  return value.replaced;
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
      const [slot] = await readdir(paths.fileSlotDirectory);
      expect(slot).toBeDefined();
      if (slot === undefined) throw new Error("human file custody slot is missing");
      expect((await stat(join(paths.fileSlotDirectory, slot))).mode & 0o777).toBe(0o600);
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

  test("leaves version-one custody intact and requires explicit pairing recovery", async () => {
    const directory = await mkdtemp(join(tmpdir(), "taskctl-human-recovery-"));
    const paths = resolveHumanStoragePaths({}, agentPaths(directory));
    const keychain = memoryKeychain();
    try {
      const legacySource = `${JSON.stringify({
        version: 1,
        apiUrl: "http://127.0.0.1:3211",
        accessToken: "legacy-access-token-that-is-long-enough",
        refreshToken: "legacy-refresh-token-that-is-long-enough",
        user: { id: "user_abc123", email: "human@example.com" },
        externalOrganizationId: "external-organization",
      })}\n`;
      const legacyProfileSource = `${JSON.stringify({
        version: 1,
        apiUrl: "http://127.0.0.1:3211",
        secretStore: "file",
        user: { id: "user_abc123", email: "human@example.com" },
        externalOrganizationId: "external-organization",
      })}\n`;
      await writeFile(paths.secretFile, legacySource, { mode: 0o600 });
      await writeFile(paths.profileFile, legacyProfileSource, { mode: 0o600 });

      expect(readHumanAuthentication(paths, keychain)).rejects.toMatchObject({
        code: "AUTHENTICATION_FAILED",
      });
      expect(await readFile(paths.secretFile, "utf8")).toBe(legacySource);
      expect(await readFile(paths.profileFile, "utf8")).toBe(legacyProfileSource);
      await writeHumanAuthentication(
        paths,
        authentication(),
        "file",
        random,
        keychain,
        { replaceLegacy: true },
      );
      expect((await readHumanAuthentication(paths, keychain))?.authentication.version).toBe(2);
      expect(await readFile(paths.secretFile, "utf8")).toBe(legacySource);
      const preservedSources = await Promise.all(
        (await readdir(paths.fileSlotDirectory)).map(async (name) =>
          await readFile(join(paths.fileSlotDirectory, name), "utf8")
        ),
      );
      expect(preservedSources.some((source) =>
        source.includes("legacy-access-token-that-is-long-enough") &&
        source.includes("external-organization")
      )).toBeTrue();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("preserves fixed Keychain version-one bytes before a new pairing commits", async () => {
    const directory = await mkdtemp(join(tmpdir(), "taskctl-human-keychain-recovery-"));
    const paths = resolveHumanStoragePaths({}, agentPaths(directory));
    const keychain = memoryKeychain();
    const legacySource = JSON.stringify({
      version: 1,
      apiUrl: "http://127.0.0.1:3211",
      accessToken: "legacy-keychain-access-token-that-is-long-enough",
      refreshToken: "legacy-keychain-refresh-token-that-is-long-enough",
      user: { id: "user_abc123", email: "human@example.com" },
      externalOrganizationId: "external-organization",
    });
    try {
      await writeFile(paths.profileFile, `${JSON.stringify({
        version: 1,
        apiUrl: "http://127.0.0.1:3211",
        secretStore: "keychain",
        user: { id: "user_abc123", email: "human@example.com" },
        externalOrganizationId: "external-organization",
      })}\n`, { mode: 0o600 });
      await keychain.set({
        service: paths.keychainService,
        name: paths.keychainName,
        value: legacySource,
      });

      expect(readHumanAuthentication(paths, keychain)).rejects.toMatchObject({
        code: "AUTHENTICATION_FAILED",
      });
      await writeHumanAuthentication(
        paths,
        authentication(),
        "keychain",
        random,
        keychain,
        { replaceLegacy: true },
      );

      expect(await keychain.get({
        service: paths.keychainService,
        name: paths.keychainName,
      })).toBe(legacySource);
      expect((await readHumanAuthentication(paths, keychain))?.authentication)
        .toEqual(authentication());
      expect(keychain.values.size).toBe(3);
      expect([...keychain.values.values()].filter((source) =>
        source.includes("legacy-keychain-access-token-that-is-long-enough")
      )).toHaveLength(2);
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
      const [slot] = await readdir(paths.fileSlotDirectory);
      expect(slot).toBeDefined();
      if (slot === undefined) throw new Error("human file custody slot is missing");
      expect((await stat(join(paths.fileSlotDirectory, slot))).mode & 0o777).toBe(0o600);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("serializes exact whole-credential replacement and retains the winning rotation", async () => {
    const directory = await mkdtemp(join(tmpdir(), "taskctl-human-cas-"));
    const paths = resolveHumanStoragePaths({}, agentPaths(directory));
    const keychain = memoryKeychain();
    const original = authentication();
    const first = refreshedAuthentication();
    const second: HumanAuthentication = {
      ...original,
      accessToken: "concurrent-access-token-that-is-long-enough",
      refreshToken: "concurrent-refresh-token-that-is-long-enough",
    };
    try {
      await writeHumanAuthentication(paths, original, "keychain", random, keychain);
      const observed = await readHumanAuthentication(paths, keychain);
      if (observed === null) throw new Error("human authentication fixture disappeared");
      const replacements = await Promise.all([
        compareAndSwapHumanAuthentication(paths, observed, first, random, keychain),
        compareAndSwapHumanAuthentication(paths, observed, second, random, keychain),
      ]);
      expect(replacements.filter((replacement) => replacement !== null)).toHaveLength(1);
      const stored = await readHumanAuthentication(paths, keychain);
      if (stored === null) throw new Error("winning human credential disappeared");
      expect([first, second]).toContainEqual(stored.authentication);
      expect(
        await preserveHumanAuthenticationIfCredentialMatches(
          paths,
          { expectedGeneration: observed.generation, candidates: [original] },
          random,
          keychain,
        ),
      ).toBeFalse();
      expect((await readHumanAuthentication(paths, keychain))?.authentication)
        .toEqual(stored.authentication);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("enforces credential CAS and stale quarantine across operating-system processes", async () => {
    const directory = await mkdtemp(join(tmpdir(), "taskctl-human-process-cas-"));
    const paths = resolveHumanStoragePaths({}, agentPaths(directory));
    const original = authentication();
    const first = refreshedAuthentication();
    const second: HumanAuthentication = {
      ...original,
      accessToken: "other-process-access-token-that-is-long-enough",
      refreshToken: "other-process-refresh-token-that-is-long-enough",
      workspace: {
        id: "workspace-other-process",
        organizationId: "organization-1",
        slug: "other-process",
        name: "Other process",
        taskKeyPrefix: "OTH",
        roles: ["planner"],
      },
    };
    try {
      await writeHumanAuthentication(paths, original, "file", random, unavailableKeychain);
      const observed = await readHumanAuthentication(paths, unavailableKeychain);
      if (observed === null) throw new Error("human authentication fixture disappeared");
      const gate = join(directory, "cas.gate");
      const firstReady = join(directory, "first.ready");
      const secondReady = join(directory, "second.ready");
      const firstWorker = startCustodyWorker({
        action: "compare_and_swap",
        paths,
        expected: observed,
        next: first,
        readyFile: firstReady,
        gateFile: gate,
      });
      const secondWorker = startCustodyWorker({
        action: "compare_and_swap",
        paths,
        expected: observed,
        next: second,
        readyFile: secondReady,
        gateFile: gate,
      });
      await Promise.all([waitForFile(firstReady), waitForFile(secondReady)]);
      await writeFile(gate, "go\n", { flag: "wx", mode: 0o600 });
      const replacements = await Promise.all([
        custodyWorkerResult(firstWorker),
        custodyWorkerResult(secondWorker),
      ]);
      expect(replacements.filter(Boolean)).toHaveLength(1);
      const winner = await readHumanAuthentication(paths, unavailableKeychain);
      if (winner === null) throw new Error("cross-process winner disappeared");
      expect([first, second]).toContainEqual(winner.authentication);
      const loser = winner.authentication.workspace?.id === first.workspace?.id
        ? second
        : first;
      await writeFile(paths.profileFile, `${JSON.stringify({
        version: 2,
        apiUrl: loser.apiUrl,
        secretStore: "file",
        user: loser.user,
        organization: loser.organization,
        workspace: loser.workspace,
      })}\n`, { mode: 0o600 });
      const custodyAuthoritative = await readHumanAuthentication(paths, unavailableKeychain);
      expect(custodyAuthoritative?.authentication).toEqual(winner.authentication);
      expect(custodyAuthoritative?.profile.workspace?.id)
        .toBe(winner.authentication.workspace?.id);

      const selected: HumanAuthentication = {
        ...winner.authentication,
        accessToken: "selected-process-access-token-that-is-long-enough",
        refreshToken: "selected-process-refresh-token-that-is-long-enough",
      };
      const winnerReady = join(directory, "winner.ready");
      const preserveReady = join(directory, "preserve.ready");
      const winnerGate = join(directory, "winner.gate");
      const preserveGate = join(directory, "preserve.gate");
      const selectionWorker = startCustodyWorker({
        action: "compare_and_swap",
        paths,
        expected: winner,
        next: selected,
        readyFile: winnerReady,
        gateFile: winnerGate,
      });
      const stalePreserver = startCustodyWorker({
        action: "preserve",
        paths,
        expected: winner,
        readyFile: preserveReady,
        gateFile: preserveGate,
      });
      await Promise.all([waitForFile(winnerReady), waitForFile(preserveReady)]);
      await writeFile(winnerGate, "go\n", { flag: "wx", mode: 0o600 });
      expect(await custodyWorkerResult(selectionWorker)).toBeTrue();
      await writeFile(preserveGate, "go\n", { flag: "wx", mode: 0o600 });
      expect(await custodyWorkerResult(stalePreserver)).toBeFalse();
      expect((await readHumanAuthentication(paths, unavailableKeychain))?.authentication)
        .toEqual(selected);
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
