import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  BunBoundedCommandRunner,
  OPENAI_SIGNING_AUTHORITY,
  type BoundedCommandChild,
  type BoundedCommandResult,
  type BoundedCommandRunner,
  inspectChatGptBundle,
} from "./bundle.ts";
import { DesktopSwitchError } from "./errors.ts";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fakeBundle(sourceOverride?: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "hra-control-plane-bundle-"));
  roots.push(root);
  const bundle = join(root, "ChatGPT.app");
  await mkdir(join(bundle, "Contents", "MacOS"), { recursive: true });
  await mkdir(join(bundle, "Contents", "Resources"), { recursive: true });
  await writeFile(join(bundle, "Contents", "Info.plist"), "fixture");
  await writeFile(join(bundle, "Contents", "MacOS", "ChatGPT"), "fixture");
  await writeFile(join(bundle, "Contents", "Resources", "codex"), "fixture");
  await writeFile(
    join(bundle, "Contents", "Resources", "app.asar"),
    sourceOverride ??
      "CODEX_ELECTRON_USER_DATA_PATH CODEX_HOME setPath(`userData` hasExplicitUserDataPath process.env.CODEX_HOME=ZS",
  );
  return bundle;
}

class SignedFixtureRunner implements BoundedCommandRunner {
  constructor(readonly cdHash = "bec4975bcdb74af55b948acc9ef7e25305743907") {}

  run(argv: readonly [string, ...string[]]): Promise<BoundedCommandResult> {
    if (argv[0] === "/usr/bin/plutil") {
      const key = argv[2];
      const values: Record<string, string> = {
        CFBundleIdentifier: "com.openai.codex",
        CFBundleShortVersionString: "26.818.22352",
        CFBundleVersion: "6872",
      };
      return Promise.resolve({
        exitCode: 0,
        stdout: `${values[key ?? ""] ?? ""}\n`,
        stderr: "",
      });
    }
    if (argv[0] === "/usr/bin/codesign" && argv.includes("-dv")) {
      return Promise.resolve({
        exitCode: 0,
        stdout: "",
        stderr: [
          "Identifier=com.openai.codex",
          `CDHash=${this.cdHash}`,
          `Authority=${OPENAI_SIGNING_AUTHORITY}`,
          "Authority=Developer ID Certification Authority",
          "Authority=Apple Root CA",
          "TeamIdentifier=2DC432GLL2",
        ].join("\n"),
      });
    }
    if (argv[0] === "/usr/bin/codesign") {
      return Promise.resolve({ exitCode: 0, stdout: "", stderr: "" });
    }
    if (argv[0] === "/usr/sbin/spctl") {
      return Promise.resolve({
        exitCode: 0,
        stdout: "",
        stderr: `accepted\nsource=Notarized Developer ID\norigin=${OPENAI_SIGNING_AUTHORITY}\n`,
      });
    }
    throw new Error(`unexpected fixture command: ${argv[0]}`);
  }
}

class TermIgnoringChild implements BoundedCommandChild {
  readonly signals: ("SIGTERM" | "SIGKILL")[] = [];
  readonly stdout: ReadableStream<Uint8Array>;
  readonly stderr: ReadableStream<Uint8Array>;
  readonly exited: Promise<number>;
  stdoutCancellations = 0;
  stderrCancellations = 0;
  #resolveExit!: (code: number) => void;

  constructor() {
    this.stdout = new ReadableStream<Uint8Array>({
      cancel: () => {
        this.stdoutCancellations += 1;
      },
    });
    this.stderr = new ReadableStream<Uint8Array>({
      cancel: () => {
        this.stderrCancellations += 1;
      },
    });
    this.exited = new Promise((resolve) => {
      this.#resolveExit = resolve;
    });
  }

  kill(signal: "SIGTERM" | "SIGKILL"): void {
    this.signals.push(signal);
    if (signal === "SIGKILL") this.#resolveExit(137);
  }
}

describe("ChatGPT bundle capability gate", () => {
  test("accepts only the exact signed build with all profile hooks", async () => {
    const bundle = await fakeBundle();
    const capability = await inspectChatGptBundle(bundle, new SignedFixtureRunner());
    expect(capability).toMatchObject({
      status: "supported-experimental",
      bundleIdentifier: "com.openai.codex",
      teamIdentifier: "2DC432GLL2",
      shortVersion: "26.818.22352",
      bundleVersion: "6872",
      hooks: {
        codexHome: true,
        isolatedDesktopUserData: true,
        preservesCodexHomeAfterShellImport: true,
        explicitPathSingleInstanceFence: true,
      },
    });
  });

  test("fails closed when one semantic hook disappears", async () => {
    const bundle = await fakeBundle(
      "CODEX_ELECTRON_USER_DATA_PATH CODEX_HOME setPath(`userData` hasExplicitUserDataPath",
    );
    const error = await inspectChatGptBundle(bundle, new SignedFixtureRunner()).catch(
      (caught: unknown) => caught,
    );
    expect(error).toMatchObject({ code: "CAPABILITY_MISSING" });
  });

  test("fails closed when the signed build hash drifts", async () => {
    const bundle = await fakeBundle();
    const error = await inspectChatGptBundle(
      bundle,
      new SignedFixtureRunner("deadbeef"),
    ).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(DesktopSwitchError);
  });

  test("bounds command cleanup and escalates when a child ignores TERM", async () => {
    const child = new TermIgnoringChild();
    let receivedArgv: readonly string[] = [];
    const runner = new BunBoundedCommandRunner({
      spawn: (argv) => {
        receivedArgv = argv;
        return child;
      },
      termGraceMs: 5,
      settlementMs: 5,
    });

    const outcome = await Promise.race([
      runner.run(["/fake/tool", "$(must-remain-an-argument)"], 5).catch((caught: unknown) => caught),
      Bun.sleep(500).then(() => "timed-out" as const),
    ]);

    expect(outcome).toBeInstanceOf(DesktopSwitchError);
    expect(outcome).toMatchObject({ code: "CAPABILITY_MISSING" });
    expect(receivedArgv).toEqual(["/fake/tool", "$(must-remain-an-argument)"]);
    expect(child.signals).toEqual(["SIGTERM", "SIGKILL"]);
    expect(child.stdoutCancellations).toBe(1);
    expect(child.stderrCancellations).toBe(1);
  });
});
