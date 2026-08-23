import { describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ChatGptBundleCapability } from "./bundle.ts";
import { deriveDesktopProfilePaths } from "./profile.ts";
import {
  DesktopSwitchRecoveryController,
  type DesktopRecoveryBinding,
  type DesktopRecoveryStorePort,
} from "./recovery.ts";

const stateRoot = join(tmpdir(), "hra-recovery-test");
const targetProfileId = "acct_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const idempotencyKey = "11111111-1111-4111-8111-111111111111";
const executablePath = "/Applications/ChatGPT.app/Contents/MacOS/ChatGPT";
const cdHash = "a".repeat(40);
const identityToken = "b".repeat(64);

const capability: ChatGptBundleCapability = {
  status: "supported-experimental",
  bundlePath: "/Applications/ChatGPT.app",
  executablePath,
  codexPath: "/Applications/ChatGPT.app/Contents/Resources/codex",
  asarPath: "/Applications/ChatGPT.app/Contents/Resources/app.asar",
  bundleIdentifier: "com.openai.codex",
  teamIdentifier: "2DC432GLL2",
  signingAuthority: "Developer ID Application: OpenAI OpCo, LLC (2DC432GLL2)",
  shortVersion: "26.818.22352",
  bundleVersion: "6872",
  cdHash,
  hooks: {
    codexHome: true,
    isolatedDesktopUserData: true,
    preservesCodexHomeAfterShellImport: true,
    explicitPathSingleInstanceFence: true,
  },
};

function recoveryPlan(originalPhase = "launch_started") {
  return {
    status: "recovery_required",
    attemptId: `attempt_${"c".repeat(32)}`,
    idempotencyKey,
    switchGeneration: 7,
    sourceProfileId: null,
    sourceProcessGeneration: null,
    targetProfileId,
    targetProcessGeneration: 3,
    originalPhase,
    diagnostic: "EFFECT_ADJACENT_RESTART",
    recoveryDeadlineAt: 2_000,
    bundleCdHash: cdHash,
    sourcePid: null,
    launchedPid: 202,
    expectedAccountKey: "person@example.com",
  } as const;
}

function instance(codexHome: string, desktopUserData: string, token = identityToken) {
  return {
    pid: 202,
    uid: 501,
    executablePath,
    identityToken: token,
    environment: [
      { name: "CODEX_HOME", value: codexHome },
      { name: "CODEX_ELECTRON_USER_DATA_PATH", value: desktopUserData },
    ],
  } as const;
}

function fixture(options: {
  plan?: unknown;
  processScans?: readonly (readonly { pid: number; executablePath: string }[])[];
  instances?: readonly unknown[];
  email?: string;
  rejectResolution?: boolean;
} = {}) {
  let current = options.plan ?? recoveryPlan();
  const scans = [...(options.processScans ?? [
    [{ pid: 202, executablePath }],
    [{ pid: 202, executablePath }],
  ])];
  const target = deriveDesktopProfilePaths(stateRoot, targetProfileId);
  const observations = [...(options.instances ?? [
    instance(target.codexHome, target.desktopUserData),
    instance(target.codexHome, target.desktopUserData),
  ])];
  const resolutions: unknown[] = [];
  const quarantines: DesktopRecoveryBinding[] = [];
  const store: DesktopRecoveryStorePort = {
    readCurrentDesktopSwitchRecovery: () => current,
    resolveDesktopSwitchRecovery: (input) => {
      resolutions.push(input);
      if (options.rejectResolution === true) throw new Error("stale CAS");
      const receipt = {
        status: input.resolution,
        attemptId: input.attemptId,
        idempotencyKey: input.idempotencyKey,
        switchGeneration: input.switchGeneration,
        sourceProfileId: input.sourceProfileId,
        sourceProcessGeneration: input.sourceProcessGeneration,
        targetProfileId: input.targetProfileId,
        targetProcessGeneration: input.targetProcessGeneration,
        diagnostic: input.diagnostic,
        observationDigest: input.observationDigest,
        resolvedAt: 5_000,
        ...(input.activeAccount === undefined ? {} : { activeAccount: input.activeAccount }),
      };
      current = receipt;
      return receipt;
    },
    quarantineDesktopSwitchTarget: (binding) => {
      quarantines.push(binding);
      return true;
    },
  };
  const controller = new DesktopSwitchRecoveryController({
    stateRoot,
    store,
    runtime: {
      desktopInstanceObservationCapability: () =>
        Promise.resolve({ status: "supported", mechanism: "pid-bound-desktop-account-v1" }),
      inspectDesktopInstance: () => Promise.resolve(observations.shift()),
      observeDesktopInstanceAccount: (input) =>
        Promise.resolve({
          status: "observed",
          desktopPid: input.instance.pid,
          uid: 501,
          identityToken,
          executablePath: input.instance.executablePath,
          bundleCdHash: input.instance.bundleCdHash,
          codexHome: input.instance.codexHome,
          desktopUserData: input.instance.desktopUserData,
          account: { signedIn: true, email: options.email ?? "Person@Example.com", plan: "Plus" },
        }),
    },
    bundle: { inspect: () => Promise.resolve(capability) },
    process: {
      listExact: () => Promise.resolve(scans.shift() ?? []),
      requestGracefulQuit: () => Promise.reject(new Error("recovery must not quit")),
      waitForExit: () => Promise.reject(new Error("recovery must not wait for quit")),
      launch: () => Promise.reject(new Error("recovery must not launch")),
      waitForExactProcess: () => Promise.reject(new Error("recovery must not wait for launch")),
    },
    lock: { withLock: async (effect) => effect() },
    now: () => 5_000,
    betweenScans: () => Promise.resolve(),
  });
  return { controller, resolutions, quarantines };
}

describe("DesktopSwitchRecoveryController", () => {
  test("resolves a stable same-user target process only after exact account verification", async () => {
    const value = fixture();
    const first = await value.controller.recover(new AbortController().signal);
    expect(first).toMatchObject({
      status: "resolved_applied",
      idempotencyKey,
      targetProfileId,
      activeAccount: { email: "Person@Example.com" },
    });
    expect(value.resolutions).toHaveLength(1);
    expect(await value.controller.recover(new AbortController().signal)).toEqual(first);
    expect(value.resolutions).toHaveLength(1);
  });

  test("resolves zero or one stable non-target process as not applied after the original deadline", async () => {
    const zero = fixture({ processScans: [[], []], instances: [] });
    expect(await zero.controller.recover(new AbortController().signal)).toMatchObject({
      status: "resolved_not_applied",
      diagnostic: "ZERO_EXACT_PROCESSES",
    });

    const other = deriveDesktopProfilePaths(stateRoot, "acct_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    const nonTarget = fixture({
      instances: [
        instance(other.codexHome, other.desktopUserData),
        instance(other.codexHome, other.desktopUserData),
      ],
    });
    expect(await nonTarget.controller.recover(new AbortController().signal)).toMatchObject({
      status: "resolved_not_applied",
      diagnostic: "STABLE_NON_TARGET_PROCESS",
    });
  });

  test("recognizes a stable source-profile process as provably non-target", async () => {
    const sourceProfileId = "acct_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const source = deriveDesktopProfilePaths(stateRoot, sourceProfileId);
    const value = fixture({
      plan: {
        ...recoveryPlan("quit_started"),
        sourceProfileId,
        sourceProcessGeneration: 2,
      },
      instances: [
        instance(source.codexHome, source.desktopUserData),
        instance(source.codexHome, source.desktopUserData),
      ],
    });
    expect(await value.controller.recover(new AbortController().signal)).toMatchObject({
      status: "resolved_not_applied",
      diagnostic: "STABLE_NON_TARGET_PROCESS",
    });
  });

  test("keeps multiple and changing process sets unresolved", async () => {
    const multiple = fixture({
      processScans: [[
        { pid: 202, executablePath },
        { pid: 203, executablePath },
      ]],
    });
    expect(await multiple.controller.recover(new AbortController().signal)).toMatchObject({
      status: "recovery_required",
      diagnostic: "MULTIPLE_EXACT_PROCESSES",
      action: "hra account switch-recover",
    });

    const changing = fixture({
      processScans: [
        [{ pid: 202, executablePath }],
        [{ pid: 203, executablePath }],
      ],
    });
    expect(await changing.controller.recover(new AbortController().signal)).toMatchObject({
      status: "recovery_required",
      diagnostic: "PROCESS_SET_CHANGED",
    });
  });

  test("keeps an unverifiable target environment unresolved", async () => {
    const value = fixture({
      instances: [{
        pid: 202,
        uid: 501,
        executablePath,
        identityToken,
        environment: [],
      }],
    });
    expect(await value.controller.recover(new AbortController().signal)).toMatchObject({
      status: "recovery_required",
      diagnostic: "TARGET_ENVIRONMENT_UNVERIFIABLE",
    });
    expect(value.resolutions).toHaveLength(0);
  });

  test("quarantines an exact target whose account does not match", async () => {
    const value = fixture({ email: "different@example.com" });
    expect(await value.controller.recover(new AbortController().signal)).toMatchObject({
      status: "recovery_required",
      diagnostic: "TARGET_ACCOUNT_MISMATCH",
    });
    expect(value.quarantines).toHaveLength(1);
    expect(value.resolutions).toHaveLength(0);
  });

  test("a stale resolution CAS cannot release newer authority", async () => {
    const value = fixture({ rejectResolution: true });
    expect(await value.controller.recover(new AbortController().signal)).toMatchObject({
      status: "recovery_required",
      diagnostic: "RECOVERY_AUTHORITY_CHANGED",
    });
  });

  for (const originalPhase of [
    "prepared",
    "quit_started",
    "quit_confirmed",
    "launch_started",
    "verify_started",
  ] as const) {
    test(`reconciles a ${originalPhase} crash without application effects`, async () => {
      const value = fixture({
        plan: recoveryPlan(originalPhase),
        processScans: [[], []],
        instances: [],
      });
      expect(await value.controller.recover(new AbortController().signal)).toMatchObject({
        status: "resolved_not_applied",
      });
    });
  }
});
