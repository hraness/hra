import { describe, expect, test } from "bun:test";

import type { CodexRuntimePort, ProfileAuthority } from "../daemon/ports.ts";
import type { ChatGptBundleCapability } from "./bundle.ts";
import { CODEX_ELECTRON_USER_DATA_PATH, CODEX_HOME } from "./bundle.ts";
import { DesktopSwitchError } from "./errors.ts";
import {
  PidBoundDesktopAccountRuntime,
  parseDarwinProcArgs,
  type DesktopInstanceInspectorPort,
} from "./instance-account.ts";

const profileId = "acct_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" as const;
const instance = {
  pid: 202,
  executablePath: "/Applications/ChatGPT.app/Contents/MacOS/ChatGPT",
  bundleCdHash: "bec4975bcdb74af55b948acc9ef7e25305743907",
  codexHome: "/tmp/hra-control-plane/profiles/account-b/codex-home",
  desktopUserData: "/tmp/hra-control-plane/profiles/account-b/desktop-user-data",
} as const;
const authority: ProfileAuthority = {
  id: profileId,
  generation: 3,
  codexHome: instance.codexHome,
  desktopUserData: instance.desktopUserData,
};

const capability: ChatGptBundleCapability = {
  status: "supported-experimental",
  bundlePath: "/Applications/ChatGPT.app",
  executablePath: instance.executablePath,
  codexPath: "/Applications/ChatGPT.app/Contents/Resources/codex",
  asarPath: "/Applications/ChatGPT.app/Contents/Resources/app.asar",
  bundleIdentifier: "com.openai.codex",
  teamIdentifier: "2DC432GLL2",
  signingAuthority: "Developer ID Application: OpenAI OpCo, LLC (2DC432GLL2)",
  shortVersion: "26.818.22352",
  bundleVersion: "6872",
  cdHash: instance.bundleCdHash,
  hooks: {
    codexHome: true,
    isolatedDesktopUserData: true,
    preservesCodexHomeAfterShellImport: true,
    explicitPathSingleInstanceFence: true,
  },
};

const exactEnvironment = [
  { name: CODEX_HOME, value: instance.codexHome },
  { name: CODEX_ELECTRON_USER_DATA_PATH, value: instance.desktopUserData },
] as const;

const observation = (overrides: Record<string, unknown> = {}) => ({
  pid: instance.pid,
  uid: 501,
  executablePath: instance.executablePath,
  identityToken: "a".repeat(64),
  environment: exactEnvironment,
  ...overrides,
});

function inspector(sequence: readonly unknown[]): DesktopInstanceInspectorPort {
  let index = 0;
  return {
    supported: () => true,
    inspect: () => {
      const value = sequence[Math.min(index, sequence.length - 1)];
      index += 1;
      return value instanceof Error ? Promise.reject(value) : Promise.resolve(value);
    },
  };
}

function runtime(sequence: readonly unknown[]) {
  let reads = 0;
  const codex = {
    readAccount: () => {
      reads += 1;
      return Promise.resolve({ signedIn: true, email: "person@example.com", plan: "Plus" });
    },
  } as Pick<CodexRuntimePort, "readAccount">;
  const value = new PidBoundDesktopAccountRuntime({
    codex,
    bundle: { inspect: () => Promise.resolve(capability) },
    inspector: inspector(sequence),
    currentUid: 501,
  });
  return { value, reads: () => reads };
}

const request = () => ({
  authority,
  instance,
  signal: new AbortController().signal,
});

describe("PidBoundDesktopAccountRuntime", () => {
  test("brackets the account read with the exact same launched desktop identity", async () => {
    const fixture = runtime([observation(), observation()]);
    await expect(fixture.value.desktopInstanceObservationCapability()).resolves.toEqual({
      status: "supported",
      mechanism: "pid-bound-desktop-account-v1",
    });
    await expect(fixture.value.observeDesktopInstanceAccount(request())).resolves.toEqual({
      status: "observed",
      desktopPid: instance.pid,
      uid: 501,
      identityToken: "a".repeat(64),
      executablePath: instance.executablePath,
      bundleCdHash: instance.bundleCdHash,
      codexHome: instance.codexHome,
      desktopUserData: instance.desktopUserData,
      account: { signedIn: true, email: "person@example.com", plan: "Plus" },
    });
    expect(fixture.reads()).toBe(1);
  });

  for (const [name, environment] of [
    ["missing CODEX_HOME", [exactEnvironment[1]]],
    ["missing desktop user-data", [exactEnvironment[0]]],
    ["duplicate CODEX_HOME", [exactEnvironment[0], exactEnvironment[0], exactEnvironment[1]]],
    [
      "wrong desktop user-data",
      [exactEnvironment[0], { name: CODEX_ELECTRON_USER_DATA_PATH, value: "/tmp/wrong" }],
    ],
  ] as const) {
    test(`refuses ${name} before reading the account`, async () => {
      const fixture = runtime([observation({ environment })]);
      const error = await fixture.value
        .observeDesktopInstanceAccount(request())
        .catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(DesktopSwitchError);
      expect((error as DesktopSwitchError).code).toBe("RECOVERY_REQUIRED");
      expect(fixture.reads()).toBe(0);
    });
  }

  test("refuses an executable-path mismatch before reading the account", async () => {
    const fixture = runtime([observation({ executablePath: "/tmp/not-chatgpt" })]);
    await expect(fixture.value.observeDesktopInstanceAccount(request())).rejects.toBeInstanceOf(
      DesktopSwitchError,
    );
    expect(fixture.reads()).toBe(0);
  });

  test("refuses a target path mismatch before process inspection", async () => {
    const fixture = runtime([observation()]);
    const mismatched = {
      ...request(),
      instance: { ...instance, codexHome: "/tmp/wrong-home" },
    };
    await expect(
      fixture.value.observeDesktopInstanceAccount(mismatched),
    ).rejects.toBeInstanceOf(DesktopSwitchError);
    expect(fixture.reads()).toBe(0);
  });

  test("fails closed when the launched PID exits after the account read", async () => {
    const fixture = runtime([
      observation(),
      new DesktopSwitchError("RECOVERY_REQUIRED", "process exited"),
    ]);
    await expect(fixture.value.observeDesktopInstanceAccount(request())).rejects.toBeInstanceOf(
      DesktopSwitchError,
    );
    expect(fixture.reads()).toBe(1);
  });

  test("fails closed when the PID is reused during the account read", async () => {
    const fixture = runtime([
      observation(),
      observation({ identityToken: "b".repeat(64) }),
    ]);
    const error = await fixture.value
      .observeDesktopInstanceAccount(request())
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(DesktopSwitchError);
    expect((error as DesktopSwitchError).message).toContain("identity changed");
    expect(fixture.reads()).toBe(1);
  });

  test("reports unsupported before any observation on a host without a same-user inspector", async () => {
    const value = new PidBoundDesktopAccountRuntime({
      codex: {
        readAccount: () => Promise.reject(new Error("must not read")),
      },
      bundle: { inspect: () => Promise.reject(new Error("must not inspect")) },
      inspector: { supported: () => false, inspect: () => Promise.reject(new Error("must not inspect")) },
      currentUid: 501,
    });
    await expect(value.desktopInstanceObservationCapability()).resolves.toEqual({
      status: "unsupported",
    });
  });
});

describe("parseDarwinProcArgs", () => {
  test("preserves spaces and duplicate reviewed environment bindings", () => {
    const profileHome = ["", "Users", "person", "Library", "Application Support", "HRA", "profile"].join("/");
    const bytes = procArgsFixture({
      executablePath: instance.executablePath,
      arguments: [instance.executablePath],
      environment: [
        "UNRELATED_SECRET=must-not-return",
        `${CODEX_HOME}=${profileHome}`,
        `${CODEX_HOME}=/tmp/duplicate`,
        `${CODEX_ELECTRON_USER_DATA_PATH}=/tmp/desktop profile`,
      ],
    });
    expect(parseDarwinProcArgs(bytes)).toEqual({
      executablePath: instance.executablePath,
      environment: [
        {
          name: CODEX_HOME,
          value: profileHome,
        },
        { name: CODEX_HOME, value: "/tmp/duplicate" },
        { name: CODEX_ELECTRON_USER_DATA_PATH, value: "/tmp/desktop profile" },
      ],
    });
  });
});

function procArgsFixture(input: {
  executablePath: string;
  arguments: readonly string[];
  environment: readonly string[];
}): Uint8Array {
  const encoder = new TextEncoder();
  const strings = [input.executablePath, ...input.arguments, ...input.environment];
  const encoded = strings.map((value) => encoder.encode(value));
  const size = 4 + encoded.reduce((total, value) => total + value.byteLength + 1, 0);
  const output = new Uint8Array(size);
  new DataView(output.buffer).setInt32(0, input.arguments.length, true);
  let offset = 4;
  for (const value of encoded) {
    output.set(value, offset);
    offset += value.byteLength + 1;
  }
  return output;
}
