import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  BunBoundedCommandRunner,
  OPENAI_SIGNING_AUTHORITY,
  type ChatGptArchiveInspector,
  type BoundedCommandChild,
  type BoundedCommandResult,
  type BoundedCommandRunner,
  type SupportedChatGptBuild,
  inspectChatGptArchiveStream,
  inspectChatGptBundle,
} from "./bundle.ts";
import { DesktopSwitchError } from "./errors.ts";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const reviewedSource = (input: {
  capture?: string;
  restore?: string;
  resolver?: string;
  resolverCall?: string;
  fence?: string;
  betweenCaptureAndRestore?: string;
} = {}): string => {
  const capture = input.capture ?? "QS";
  const restore = input.restore ?? capture;
  const resolver = input.resolver ?? "ee";
  const resolverCall = input.resolverCall ?? resolver;
  const fence = input.fence ?? "$";
  return [
    `function ${resolver}({appDataPath:e,buildFlavor:n,env:r}){let i=r.CODEX_ELECTRON_USER_DATA_PATH?.trim();if(i)return(0,o.resolve)(i);let a=(0,o.join)(e,n)}`,
    `a.app.setPath(\`userData\`,${resolverCall}({appDataPath:a.app.getPath(\`appData\`),buildFlavor:X,env:process.env}))`,
    `var ${fence}=n.X({isMacOS:je,isPackaged:a.app.isPackaged,hasExplicitUserDataPath:!!process.env.CODEX_ELECTRON_USER_DATA_PATH?.trim()});if(!(!${fence}||a.app.requestSingleInstanceLock()))a.app.exit(0);`,
    `${capture}=process.env.CODEX_ELECTRON_USER_DATA_PATH?.trim()?process.env.CODEX_HOME:void 0`,
    input.betweenCaptureAndRestore ?? "reviewed-shell-import",
    `${restore}!=null&&(process.env.CODEX_HOME=${restore})`,
  ].join(";");
};

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
    sourceOverride ?? reviewedSource(),
  );
  return bundle;
}

const fixtureArchiveInspector: ChatGptArchiveInspector = {
  async inspect(asarPath): Promise<void> {
    const file = Bun.file(asarPath);
    const bytes = new Uint8Array(await file.arrayBuffer());
    await inspectChatGptArchiveStream(file.stream(), {
      asarBytes: bytes.byteLength,
      asarSha256: createHash("sha256").update(bytes).digest("hex"),
    });
  },
};

const sourceStream = (chunks: readonly Uint8Array[]): ReadableStream<Uint8Array> =>
  new ReadableStream<Uint8Array>({
    start(controller): void {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });

async function inspectSource(
  source: string,
  splitEvery = Number.MAX_SAFE_INTEGER,
  expectedOverride: Partial<Pick<SupportedChatGptBuild, "asarBytes" | "asarSha256">> = {},
): Promise<void> {
  const bytes = new TextEncoder().encode(source);
  const chunks: Uint8Array[] = [];
  for (let offset = 0; offset < bytes.byteLength; offset += splitEvery) {
    chunks.push(bytes.slice(offset, Math.min(bytes.byteLength, offset + splitEvery)));
  }
  await inspectChatGptArchiveStream(sourceStream(chunks), {
    asarBytes: expectedOverride.asarBytes ?? bytes.byteLength,
    asarSha256: expectedOverride.asarSha256
      ?? createHash("sha256").update(bytes).digest("hex"),
  });
}

class SignedFixtureRunner implements BoundedCommandRunner {
  constructor(
    readonly build: SupportedChatGptBuild = {
      shortVersion: "26.818.41509",
      bundleVersion: "6962",
      cdHash: "59729f374e9041c73fae77d3fb33ce323d514ba4",
      asarBytes: 284_124_509,
      asarSha256: "8eb91bd9efbf9a4dd04b9b0afdbfcb4e0bab5da18c1919ad74ca327c00c7e791",
    },
  ) {}

  run(argv: readonly [string, ...string[]]): Promise<BoundedCommandResult> {
    if (argv[0] === "/usr/bin/plutil") {
      const key = argv[2];
      const values: Record<string, string> = {
        CFBundleIdentifier: "com.openai.codex",
        CFBundleShortVersionString: this.build.shortVersion,
        CFBundleVersion: this.build.bundleVersion,
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
          `CDHash=${this.build.cdHash}`,
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
  test("accepts the exact reviewed signed build with its streamed structural hooks", async () => {
    const bundle = await fakeBundle();
    const capability = await inspectChatGptBundle(
      bundle,
      new SignedFixtureRunner(),
      fixtureArchiveInspector,
    );
    expect(capability).toMatchObject({
      status: "supported-experimental",
      bundleIdentifier: "com.openai.codex",
      teamIdentifier: "2DC432GLL2",
      shortVersion: "26.818.41509",
      bundleVersion: "6962",
      asarBytes: 284_124_509,
      asarSha256: "8eb91bd9efbf9a4dd04b9b0afdbfcb4e0bab5da18c1919ad74ca327c00c7e791",
      hooks: {
        codexHome: true,
        isolatedDesktopUserData: true,
        preservesCodexHomeAfterShellImport: true,
        explicitPathSingleInstanceFence: true,
      },
    });
  });

  test("accepts randomized minified identifiers across stream boundaries", async () => {
    await expect(inspectSource(reviewedSource({
      capture: "_$capture9",
      resolver: "$resolver7",
      fence: "_fence$",
    }), 7)).resolves.toBeUndefined();
  });

  test("fails closed on mismatched, distant, or duplicate CODEX_HOME dataflow", async () => {
    await expect(inspectSource(reviewedSource({ restore: "RS" }))).rejects
      .toMatchObject({ code: "CAPABILITY_MISSING" });
    await expect(inspectSource(reviewedSource({
      betweenCaptureAndRestore: "x".repeat(4_097),
    }))).rejects.toMatchObject({ code: "CAPABILITY_MISSING" });
    await expect(inspectSource(`${reviewedSource()};${reviewedSource({ capture: "RS" })}`))
      .rejects.toMatchObject({ code: "CAPABILITY_MISSING" });
  });

  test("fails closed when resolver or single-instance relationships are decoys", async () => {
    await expect(inspectSource(reviewedSource({ resolverCall: "other" }))).rejects
      .toMatchObject({ code: "CAPABILITY_MISSING" });
    await expect(inspectSource(reviewedSource().replace(
      "if(!(!$||a.app.requestSingleInstanceLock()))",
      "if(!(!other||a.app.requestSingleInstanceLock()))",
    ))).rejects.toMatchObject({ code: "CAPABILITY_MISSING" });
  });

  test("fails closed when exact archive size or digest drifts", async () => {
    const source = reviewedSource();
    const bytes = new TextEncoder().encode(source);
    await expect(inspectSource(source, 17, { asarBytes: bytes.byteLength + 1 })).rejects
      .toMatchObject({ code: "CAPABILITY_MISSING" });
    await expect(inspectSource(source, 17, { asarSha256: "0".repeat(64) })).rejects
      .toMatchObject({ code: "CAPABILITY_MISSING" });
  });

  test("fails closed when the signed build hash drifts", async () => {
    const bundle = await fakeBundle();
    const error = await inspectChatGptBundle(
      bundle,
      new SignedFixtureRunner({
        shortVersion: "26.818.41509",
        bundleVersion: "6962",
        cdHash: "deadbeef",
        asarBytes: 284_124_509,
        asarSha256: "8eb91bd9efbf9a4dd04b9b0afdbfcb4e0bab5da18c1919ad74ca327c00c7e791",
      }),
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
