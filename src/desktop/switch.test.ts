import { describe, expect, test } from "bun:test";

import type { ChatGptBundleCapability } from "./bundle.ts";
import { DesktopSwitchError } from "./errors.ts";
import {
  DesktopSwitchController,
  desktopLaunchEnvironment,
  type DesktopAccountVerificationPort,
  type DesktopProcessIdentity,
  type DesktopSwitchControllerPorts,
  type DesktopSwitchRequest,
  type DesktopSwitchStage,
} from "./switch.ts";

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

const request: DesktopSwitchRequest = {
  idempotencyKey: "switch-1",
  switchGeneration: 4,
  sourceProfileId: "account-a",
  sourceProcessGeneration: 2,
  targetProfileId: "account-b",
  targetProcessGeneration: 3,
  expectedAccountKey: "account-key-b",
  stateRoot: "/tmp/hra-control-plane",
  baseEnvironment: {
    HOME: "/workspace/home",
    PATH: "/usr/bin:/bin",
    OPENAI_API_KEY: "must-not-pass",
  },
};

function fakePorts(options: { readonly staleAfterQuit?: boolean } = {}): {
  readonly ports: DesktopSwitchControllerPorts;
  readonly stages: DesktopSwitchStage[];
  readonly launches: Readonly<Record<string, string>>[];
  readonly observations: Parameters<DesktopAccountVerificationPort["readAccountKey"]>[0][];
} {
  const stages: DesktopSwitchStage[] = [];
  const launches: Readonly<Record<string, string>>[] = [];
  const observations: Parameters<DesktopAccountVerificationPort["readAccountKey"]>[0][] = [];
  let quit = false;
  const source: DesktopProcessIdentity = {
    pid: 101,
    executablePath: capability.executablePath,
  };
  const ports: DesktopSwitchControllerPorts = {
    bundle: { inspect: () => Promise.resolve(capability) },
    lock: { withLock: async (effect) => effect() },
    journal: {
      prepare: () => Promise.resolve(),
      advance: (_key, _generation, stage) => {
        stages.push(stage);
        return Promise.resolve();
      },
    },
    authority: {
      assertEffectsSettled: () => Promise.resolve(),
      isCurrent: () => !(options.staleAfterQuit === true && quit),
    },
    process: {
      listExact: () => Promise.resolve([source]),
      requestGracefulQuit: () => {
        quit = true;
        return Promise.resolve();
      },
      waitForExit: () => Promise.resolve(true),
      launch: (input) => {
        launches.push(input.environment);
        return Promise.resolve({ pid: 202, executablePath: input.executablePath });
      },
      waitForExactProcess: (executablePath, expectedPid) =>
        Promise.resolve({
          pid: expectedPid,
          executablePath,
        }),
    },
    account: {
      readAccountKey: (input) => {
        observations.push(input);
        return Promise.resolve("account-key-b");
      },
    },
  };
  return { ports, stages, launches, observations };
}

describe("DesktopSwitchController", () => {
  test("journals quit and one direct isolated-profile launch", async () => {
    const fixture = fakePorts();
    const result = await new DesktopSwitchController(fixture.ports).switchProfile(request);
    expect(result).toEqual({
      status: "switched",
      profileId: "account-b",
      processGeneration: 3,
      desktopPid: 202,
      switchGeneration: 4,
    });
    expect(fixture.stages).toEqual([
      "quit-requested",
      "source-quiesced",
      "launch-requested",
      "target-observed",
      "verified",
    ]);
    expect(fixture.launches).toHaveLength(1);
    expect(fixture.launches[0]).toMatchObject({
      HOME: "/workspace/home",
      CODEX_HOME: "/tmp/hra-control-plane/profiles/account-b/codex-home",
      CODEX_ELECTRON_USER_DATA_PATH:
        "/tmp/hra-control-plane/profiles/account-b/desktop-user-data",
    });
    expect(fixture.launches[0]).not.toHaveProperty("OPENAI_API_KEY");
    expect(fixture.observations).toEqual([
      {
        profileId: "account-b",
        processGeneration: 3,
        instance: {
          pid: 202,
          executablePath: capability.executablePath,
          bundleCdHash: capability.cdHash,
          codexHome: "/tmp/hra-control-plane/profiles/account-b/codex-home",
          desktopUserData: "/tmp/hra-control-plane/profiles/account-b/desktop-user-data",
        },
      },
    ]);
  });

  test("does not launch after the generation changes post-quit", async () => {
    const fixture = fakePorts({ staleAfterQuit: true });
    const error = await new DesktopSwitchController(fixture.ports)
      .switchProfile(request)
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(DesktopSwitchError);
    expect(fixture.launches).toHaveLength(0);
    expect(fixture.stages.at(-1)).toBe("recovery-required");
  });

  test("launch environment never forwards secret-like arbitrary variables", () => {
    const environment = desktopLaunchEnvironment(
      { HOME: "/workspace/home", TOKEN: "sentinel", SSH_AUTH_SOCK: "/tmp/socket" },
      {
        profileRoot: "/tmp/root/profiles/a",
        codexHome: "/tmp/root/profiles/a/codex-home",
        desktopUserData: "/tmp/root/profiles/a/desktop-user-data",
      },
    );
    expect(environment).toEqual({
      HOME: "/workspace/home",
      CODEX_HOME: "/tmp/root/profiles/a/codex-home",
      CODEX_ELECTRON_USER_DATA_PATH: "/tmp/root/profiles/a/desktop-user-data",
    });
  });
});
