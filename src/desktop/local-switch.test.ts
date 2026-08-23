import { describe, expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { CodexAccountProjection, ProfileAuthority } from "../daemon/ports.ts";
import {
  initializeProfilePaths,
  initializeStatePaths,
  resolveStatePaths,
} from "../storage/paths.ts";
import type { ChatGptBundleCapability } from "./bundle.ts";
import { DesktopSwitchError } from "./errors.ts";
import {
  FileDesktopSwitchLock,
  LocalDesktopSwitchPort,
  desktopAccountKey,
  type LocalDesktopSwitchStorePort,
} from "./local-switch.ts";
import type {
  DesktopProcessIdentity,
  DesktopProcessPort,
  DesktopSwitchJournalEntry,
  DesktopSwitchStage,
} from "./switch.ts";

const sourceId = "acct_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as const;
const targetId = "acct_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" as const;
const idempotencyKey = "11111111-1111-4111-8111-111111111111";

const capability: ChatGptBundleCapability = {
  status: "supported-experimental",
  bundlePath: "/Applications/ChatGPT.app",
  executablePath: "/Applications/ChatGPT.app/Contents/MacOS/ChatGPT",
  codexPath: "/Applications/ChatGPT.app/Contents/Resources/codex",
  asarPath: "/Applications/ChatGPT.app/Contents/Resources/app.asar",
  bundleIdentifier: "com.openai.codex",
  teamIdentifier: "2DC432GLL2",
  signingAuthority: "Developer ID Application: OpenAI OpCo, LLC (2DC432GLL2)",
  shortVersion: "26.818.22352",
  bundleVersion: "6872",
  cdHash: "bec4975bcdb74af55b948acc9ef7e25305743907",
  hooks: {
    codexHome: true,
    isolatedDesktopUserData: true,
    preservesCodexHomeAfterShellImport: true,
    explicitPathSingleInstanceFence: true,
  },
};

async function fixture() {
  const home = await mkdtemp(join("/private/tmp", "hra-local-switch-"));
  const paths = resolveStatePaths({ homeDirectory: home, platform: "darwin" });
  await initializeStatePaths(paths);
  await initializeProfilePaths(paths, sourceId);
  await initializeProfilePaths(paths, targetId);
  const source: ProfileAuthority = {
    id: sourceId,
    generation: 2,
    codexHome: join(paths.profiles, sourceId, "codex-home"),
    desktopUserData: join(paths.profiles, sourceId, "desktop-user-data"),
  };
  const target: ProfileAuthority = {
    id: targetId,
    generation: 3,
    codexHome: join(paths.profiles, targetId, "codex-home"),
    desktopUserData: join(paths.profiles, targetId, "desktop-user-data"),
  };
  return { paths, source, target };
}

function readyPlan() {
  return {
    status: "ready",
    idempotencyKey,
    switchGeneration: 7,
    sourceProfileId: sourceId,
    sourceProcessGeneration: 2,
    targetProfileId: targetId,
    targetProcessGeneration: 3,
    journalStage: "new",
    expectedAccountKey: "person@example.com",
  } as const;
}

function fakeStore(plan: unknown = readyPlan()) {
  const began: unknown[] = [];
  const prepared: DesktopSwitchJournalEntry[] = [];
  const stages: DesktopSwitchStage[] = [];
  const diagnostics: (string | undefined)[] = [];
  const quarantined: unknown[] = [];
  const store: LocalDesktopSwitchStorePort = {
    readDesktopSwitchReplay: () =>
      Promise.resolve(
        typeof plan === "object" && plan !== null && "status" in plan && plan.status !== "ready"
          ? plan
          : null,
      ),
    beginDesktopSwitch: (input) => {
      began.push(input);
      return Promise.resolve(plan);
    },
    prepareDesktopSwitchJournal: (entry) => {
      prepared.push(entry);
      return Promise.resolve();
    },
    advanceDesktopSwitchJournal: (input) => {
      stages.push(input.stage);
      diagnostics.push(input.diagnostic);
      return Promise.resolve();
    },
    assertDesktopEffectsSettled: () => Promise.resolve(),
    isDesktopSwitchCurrent: () => true,
    settlePreparedDesktopSwitch: () => false,
    quarantineDesktopSwitchTargetByGeneration: (input) => {
      quarantined.push(input);
      return true;
    },
    readCurrentDesktopSwitchRecovery: () => ({ status: "none" }),
    resolveDesktopSwitchRecovery: () => {
      throw new Error("not used");
    },
    quarantineDesktopSwitchTarget: () => true,
  };
  return { store, began, prepared, stages, diagnostics, quarantined };
}

function fakeProcess() {
  const launches: {
    readonly executablePath: string;
    readonly environment: Readonly<Record<string, string>>;
  }[] = [];
  const quit: DesktopProcessIdentity[] = [];
  const sourceProcess = { pid: 101, executablePath: capability.executablePath };
  const process: DesktopProcessPort = {
    listExact: () => Promise.resolve([sourceProcess]),
    requestGracefulQuit: (identity) => {
      quit.push(identity);
      return Promise.resolve();
    },
    waitForExit: () => Promise.resolve(true),
    launch: (input) => {
      launches.push(input);
      return Promise.resolve({ pid: 202, executablePath: input.executablePath });
    },
    waitForExactProcess: (executablePath, expectedPid) =>
      Promise.resolve({ pid: expectedPid, executablePath }),
  };
  return { process, launches, quit };
}

function observedAccount(account: CodexAccountProjection) {
  return (input: {
    readonly instance: {
      readonly pid: number;
      readonly executablePath: string;
      readonly bundleCdHash: string;
      readonly codexHome: string;
      readonly desktopUserData: string;
    };
  }) =>
    Promise.resolve({
      status: "observed",
      desktopPid: input.instance.pid,
      executablePath: input.instance.executablePath,
      bundleCdHash: input.instance.bundleCdHash,
      codexHome: input.instance.codexHome,
      desktopUserData: input.instance.desktopUserData,
      account,
    });
}

describe("LocalDesktopSwitchPort", () => {
  test("binds the caller key and executes one journaled isolated-profile switch", async () => {
    const { paths, source, target } = await fixture();
    const stored = fakeStore();
    const effects = fakeProcess();
    const result = await new LocalDesktopSwitchPort({
      paths,
      store: stored.store,
      runtime: {
        desktopInstanceObservationCapability: () =>
          Promise.resolve({
            status: "supported",
            mechanism: "pid-bound-desktop-account-v1",
          }),
        observeDesktopInstanceAccount: observedAccount({
          signedIn: true,
          email: "Person@Example.COM",
          plan: "Plus",
        }),
      },
      bundle: { inspect: () => Promise.resolve(capability) },
      process: effects.process,
      lock: { withLock: async (effect) => effect() },
      baseEnvironment: {
        HOME: "/workspace/home",
        PATH: "/usr/bin:/bin",
        OPENAI_API_KEY: "must-not-pass",
      },
    }).switchAccount({
      idempotencyKey,
      source,
      target,
      signal: new AbortController().signal,
    });

    expect(result).toEqual({
      status: "applied",
      activeAccount: { signedIn: true, email: "Person@Example.COM", plan: "Plus" },
      idempotencyKey,
    });
    expect(stored.began).toEqual([
      {
        idempotencyKey,
        requestedSource: { profileId: sourceId, processGeneration: 2 },
        target: { profileId: targetId, processGeneration: 3 },
      },
    ]);
    expect(stored.prepared).toHaveLength(1);
    expect(stored.prepared[0]?.idempotencyKey).toBe(idempotencyKey);
    expect(stored.stages).toEqual([
      "quit-requested",
      "source-quiesced",
      "launch-requested",
      "target-observed",
      "verified",
    ]);
    expect(effects.quit).toHaveLength(1);
    expect(effects.launches).toHaveLength(1);
    expect(effects.launches[0]?.environment).toMatchObject({
      CODEX_HOME: target.codexHome,
      CODEX_ELECTRON_USER_DATA_PATH: target.desktopUserData,
    });
    expect(effects.launches[0]?.environment).not.toHaveProperty("OPENAI_API_KEY");
  });

  test("returns an exact applied replay without inspecting or mutating the app", async () => {
    const { paths, target } = await fixture();
    const stored = fakeStore({
      status: "applied",
      idempotencyKey,
      switchGeneration: 7,
      sourceProfileId: null,
      sourceProcessGeneration: null,
      targetProfileId: targetId,
      targetProcessGeneration: 3,
      expectedAccountKey: "person@example.com",
      activeAccount: { signedIn: true, email: "person@example.com" },
    });
    let inspected = false;
    const result = await new LocalDesktopSwitchPort({
      paths,
      store: stored.store,
      runtime: {
        observeDesktopInstanceAccount: () => Promise.reject(new Error("must not read")),
      },
      bundle: {
        inspect: () => {
          inspected = true;
          return Promise.resolve(capability);
        },
      },
      process: fakeProcess().process,
      lock: { withLock: async (effect) => effect() },
    }).switchAccount({
      idempotencyKey,
      target,
      signal: new AbortController().signal,
    });

    expect(result).toEqual({
      status: "applied",
      activeAccount: { signedIn: true, email: "person@example.com" },
      idempotencyKey,
    });
    expect(inspected).toBe(false);
    expect(stored.prepared).toHaveLength(0);
  });

  test("fails closed on an indeterminate replay without touching the app", async () => {
    const { paths, target } = await fixture();
    const stored = fakeStore({
      status: "recovery_required",
      idempotencyKey,
      switchGeneration: 7,
      sourceProfileId: sourceId,
      sourceProcessGeneration: 2,
      targetProfileId: targetId,
      targetProcessGeneration: 3,
      diagnostic: "LAUNCH_REQUESTED_INDETERMINATE",
    });
    const effects = fakeProcess();
    const result = await new LocalDesktopSwitchPort({
      paths,
      store: stored.store,
      runtime: {
        observeDesktopInstanceAccount: () => Promise.reject(new Error("must not read")),
      },
      bundle: { inspect: () => Promise.reject(new Error("must not inspect")) },
      process: effects.process,
      lock: { withLock: async (effect) => effect() },
    }).switchAccount({
      idempotencyKey,
      target,
      signal: new AbortController().signal,
    });

    expect(result).toEqual({
      status: "recovery_required",
      diagnostic: "LAUNCH_REQUESTED_INDETERMINATE",
      idempotencyKey,
    });
    expect(effects.launches).toHaveLength(0);
  });

  test("fails closed when an applied receipt names a different account", async () => {
    const { paths, target } = await fixture();
    const stored = fakeStore({
      status: "applied",
      idempotencyKey,
      switchGeneration: 7,
      sourceProfileId: null,
      sourceProcessGeneration: null,
      targetProfileId: targetId,
      targetProcessGeneration: 3,
      expectedAccountKey: "person@example.com",
      activeAccount: { signedIn: true, email: "different@example.com" },
    });
    const effects = fakeProcess();
    const result = await new LocalDesktopSwitchPort({
      paths,
      store: stored.store,
      runtime: {
        observeDesktopInstanceAccount: () => Promise.reject(new Error("must not read")),
      },
      bundle: { inspect: () => Promise.reject(new Error("must not inspect")) },
      process: effects.process,
      lock: { withLock: async (effect) => effect() },
    }).switchAccount({
      idempotencyKey,
      target,
      signal: new AbortController().signal,
    });

    expect(result).toEqual({
      status: "recovery_required",
      diagnostic: "APPLIED_ACCOUNT_BINDING_MISMATCH",
      idempotencyKey,
    });
    expect(effects.launches).toHaveLength(0);
  });

  test("rejects a mismatched durable binding after read-only preflight and before app effects", async () => {
    const { paths, target } = await fixture();
    const stored = fakeStore({ ...readyPlan(), targetProcessGeneration: 4 });
    let inspected = false;
    const error = await new LocalDesktopSwitchPort({
      paths,
      store: stored.store,
      runtime: {
        desktopInstanceObservationCapability: () =>
          Promise.resolve({
            status: "supported",
            mechanism: "pid-bound-desktop-account-v1",
          }),
        observeDesktopInstanceAccount: () => Promise.reject(new Error("must not read")),
      },
      bundle: {
        inspect: () => {
          inspected = true;
          return Promise.resolve(capability);
        },
      },
      process: fakeProcess().process,
      lock: { withLock: async (effect) => effect() },
    })
      .switchAccount({
        idempotencyKey,
        target,
        signal: new AbortController().signal,
      })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(DesktopSwitchError);
    expect((error as DesktopSwitchError).code).toBe("RECOVERY_REQUIRED");
    expect(inspected).toBe(true);
  });

  test("journals recovery when the post-launch account read is indeterminate", async () => {
    const { paths, source, target } = await fixture();
    const stored = fakeStore();
    const result = await new LocalDesktopSwitchPort({
      paths,
      store: stored.store,
      runtime: {
        desktopInstanceObservationCapability: () =>
          Promise.resolve({
            status: "supported",
            mechanism: "pid-bound-desktop-account-v1",
          }),
        observeDesktopInstanceAccount: () =>
          Promise.reject(new Error("provider disconnected")),
      },
      bundle: { inspect: () => Promise.resolve(capability) },
      process: fakeProcess().process,
      lock: { withLock: async (effect) => effect() },
    }).switchAccount({
      idempotencyKey,
      source,
      target,
      signal: new AbortController().signal,
    });

    expect(result).toEqual({
      status: "recovery_required",
      diagnostic: "DESKTOP_SWITCH_RECOVERY_REQUIRED",
      idempotencyKey,
    });
    expect(stored.stages.at(-1)).toBe("recovery-required");
    expect(stored.diagnostics.at(-1)).toBe("DESKTOP_INSTANCE_OBSERVATION_UNAVAILABLE");
  });

  test("rejects an account observation from the wrong desktop PID", async () => {
    const { paths, source, target } = await fixture();
    const stored = fakeStore();
    const result = await new LocalDesktopSwitchPort({
      paths,
      store: stored.store,
      runtime: {
        desktopInstanceObservationCapability: () =>
          Promise.resolve({
            status: "supported",
            mechanism: "pid-bound-desktop-account-v1",
          }),
        observeDesktopInstanceAccount: (input) =>
          Promise.resolve({
            status: "observed",
            desktopPid: input.instance.pid + 1,
            executablePath: input.instance.executablePath,
            bundleCdHash: input.instance.bundleCdHash,
            codexHome: input.instance.codexHome,
            desktopUserData: input.instance.desktopUserData,
            account: { signedIn: true, email: "person@example.com" },
          }),
      },
      bundle: { inspect: () => Promise.resolve(capability) },
      process: fakeProcess().process,
      lock: { withLock: async (effect) => effect() },
    }).switchAccount({
      idempotencyKey,
      source,
      target,
      signal: new AbortController().signal,
    });

    expect(result).toEqual({
      status: "recovery_required",
      diagnostic: "DESKTOP_SWITCH_RECOVERY_REQUIRED",
      idempotencyKey,
    });
    expect(stored.stages.at(-1)).toBe("recovery-required");
    expect(stored.diagnostics.at(-1)).toBe("DESKTOP_INSTANCE_MISMATCH");
  });

  test("quarantines the target when the launched instance exposes another account", async () => {
    const { paths, source, target } = await fixture();
    const stored = fakeStore();
    const result = await new LocalDesktopSwitchPort({
      paths,
      store: stored.store,
      runtime: {
        desktopInstanceObservationCapability: () =>
          Promise.resolve({
            status: "supported",
            mechanism: "pid-bound-desktop-account-v1",
          }),
        observeDesktopInstanceAccount: observedAccount({
          signedIn: true,
          email: "different@example.com",
        }),
      },
      bundle: { inspect: () => Promise.resolve(capability) },
      process: fakeProcess().process,
      lock: { withLock: async (effect) => effect() },
    }).switchAccount({
      idempotencyKey,
      source,
      target,
      signal: new AbortController().signal,
    });

    expect(result).toEqual({
      status: "recovery_required",
      diagnostic: "TARGET_ACCOUNT_MISMATCH",
      idempotencyKey,
    });
    expect(stored.quarantined).toHaveLength(1);
    expect(stored.stages.at(-1)).toBe("recovery-required");
  });

  test("refuses to quit when no desktop-instance observation mechanism exists", async () => {
    const { paths, source, target } = await fixture();
    const stored = fakeStore();
    const effects = fakeProcess();
    let inspected = false;
    const error = await new LocalDesktopSwitchPort({
      paths,
      store: stored.store,
      runtime: {
        desktopInstanceObservationCapability: () =>
          Promise.resolve({ status: "unsupported" }),
        observeDesktopInstanceAccount: () => Promise.reject(new Error("must not read")),
      },
      bundle: {
        inspect: () => {
          inspected = true;
          return Promise.resolve(capability);
        },
      },
      process: effects.process,
      lock: { withLock: async (effect) => effect() },
    })
      .switchAccount({
        idempotencyKey,
        source,
        target,
        signal: new AbortController().signal,
      })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(DesktopSwitchError);
    expect((error as DesktopSwitchError).code).toBe("CAPABILITY_MISSING");
    expect(inspected).toBe(false);
    expect(effects.quit).toHaveLength(0);
    expect(effects.launches).toHaveLength(0);
    expect(stored.prepared).toHaveLength(0);
  });

  test("a deterministic preflight failure reserves nothing and a fresh key can succeed", async () => {
    const { paths, source, target } = await fixture();
    const stored = fakeStore();
    const effects = fakeProcess();
    const runtime = {
      desktopInstanceObservationCapability: () =>
        Promise.resolve({
          status: "supported" as const,
          mechanism: "pid-bound-desktop-account-v1" as const,
        }),
      observeDesktopInstanceAccount: observedAccount({
        signedIn: true,
        email: "person@example.com",
      }),
    };
    const firstKey = "22222222-2222-4222-8222-222222222222";
    const firstError = await new LocalDesktopSwitchPort({
      paths,
      store: stored.store,
      runtime,
      bundle: { inspect: () => Promise.reject(new Error("unsupported bundle")) },
      process: effects.process,
      lock: { withLock: async (effect) => effect() },
    }).switchAccount({
      idempotencyKey: firstKey,
      source,
      target,
      signal: new AbortController().signal,
    }).catch((error: unknown) => error);
    expect(firstError).toBeInstanceOf(Error);
    expect(stored.began).toHaveLength(0);
    expect(effects.quit).toHaveLength(0);
    expect(effects.launches).toHaveLength(0);

    const result = await new LocalDesktopSwitchPort({
      paths,
      store: stored.store,
      runtime,
      bundle: { inspect: () => Promise.resolve(capability) },
      process: effects.process,
      lock: { withLock: async (effect) => effect() },
    }).switchAccount({
      idempotencyKey,
      source,
      target,
      signal: new AbortController().signal,
    });
    expect(result).toMatchObject({ status: "applied", idempotencyKey });
  });

  test("settles a reserved attempt when the process set changes before any app effect", async () => {
    const { paths, source, target } = await fixture();
    const stored = fakeStore();
    const effects = fakeProcess();
    let scans = 0;
    let settlements = 0;
    stored.store.settlePreparedDesktopSwitch = () => {
      settlements += 1;
      return true;
    };
    const error = await new LocalDesktopSwitchPort({
      paths,
      store: stored.store,
      runtime: {
        desktopInstanceObservationCapability: () =>
          Promise.resolve({
            status: "supported",
            mechanism: "pid-bound-desktop-account-v1",
          }),
        observeDesktopInstanceAccount: observedAccount({
          signedIn: true,
          email: "person@example.com",
        }),
      },
      bundle: { inspect: () => Promise.resolve(capability) },
      process: {
        ...effects.process,
        listExact: () => {
          scans += 1;
          return Promise.resolve(
            scans === 1
              ? [{ pid: 101, executablePath: capability.executablePath }]
              : [],
          );
        },
      },
      lock: { withLock: async (effect) => effect() },
    }).switchAccount({
      idempotencyKey,
      source,
      target,
      signal: new AbortController().signal,
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(DesktopSwitchError);
    expect((error as DesktopSwitchError).code).toBe("PROCESS_AMBIGUOUS");
    expect(settlements).toBe(1);
    expect(stored.prepared).toHaveLength(0);
    expect(effects.quit).toHaveLength(0);
    expect(effects.launches).toHaveLength(0);
  });

  test("rejects an already-aborted request before durable planning", async () => {
    const { paths, target } = await fixture();
    const stored = fakeStore();
    const controller = new AbortController();
    controller.abort(new Error("cancelled"));
    await expect(
      new LocalDesktopSwitchPort({
        paths,
        store: stored.store,
        runtime: {
          observeDesktopInstanceAccount: () => Promise.reject(new Error("must not read")),
        },
        bundle: { inspect: () => Promise.reject(new Error("must not inspect")) },
        process: fakeProcess().process,
        lock: { withLock: async (effect) => effect() },
      }).switchAccount({ idempotencyKey, target, signal: controller.signal }),
    ).rejects.toThrow("cancelled");
    expect(stored.began).toHaveLength(0);
  });
});

describe("desktopAccountKey", () => {
  test("uses a canonical signed-in email and refuses unverifiable accounts", () => {
    expect(
      desktopAccountKey({ signedIn: true, email: " Person@Example.COM " }),
    ).toBe("person@example.com");
    expect(desktopAccountKey({ signedIn: true })).toBeNull();
    expect(desktopAccountKey({ signedIn: false, email: "person@example.com" })).toBeNull();
  });
});

describe("FileDesktopSwitchLock", () => {
  test("admits one live owner and releases by inode identity", async () => {
    const { paths } = await fixture();
    const lock = new FileDesktopSwitchLock(paths.switchLock);
    await lock.withLock(async () => {
      const error = await lock.withLock(async () => undefined).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(DesktopSwitchError);
      expect((error as DesktopSwitchError).code).toBe("PROCESS_AMBIGUOUS");
    });
    await expect(lock.withLock(async () => "released")).resolves.toBe("released");
  });

  test("recovers only a well-formed lock owned by a dead process", async () => {
    const { paths } = await fixture();
    await writeFile(
      paths.switchLock,
      JSON.stringify({ version: 1, pid: 999_999, nonce: crypto.randomUUID() }),
      { mode: 0o600 },
    );
    const lock = new FileDesktopSwitchLock(paths.switchLock);
    await expect(lock.withLock(async () => "recovered")).resolves.toBe("recovered");
  });
});
