import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  copyFile,
  lstat,
  mkdtemp,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import {
  CODEX_SIGNATURE_NORMALIZATION_ENTITLEMENTS_FILE,
  codexSignatureNormalizationCodesignArguments,
  codexSignatureNormalizationPolicy,
  codexSignatureNormalizationSigning,
  createCodexSignatureSourceDelta,
  parseCodexSignatureNormalizationEntitlements,
  reconstructCodexSignatureSource,
  verifyCodexSignatureNormalizationContent,
  verifyCodexSignatureNormalizationPackaged,
} from "../codex-signature-normalization";
import { sha256File } from "../verify-macos-package";
import { verifyRuntimePins } from "../verify-runtime-pins";

type CommandResult = Readonly<{
  stderr: string;
  stdout: string;
}>;

async function run(argv: readonly string[]): Promise<CommandResult> {
  const child = Bun.spawn([...argv], {
    stderr: "pipe",
    stdout: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (exitCode !== 0) {
    throw new Error(`${argv.join(" ")} failed with exit code ${exitCode}: ${stderr.trim()}`);
  }
  return { stderr, stdout };
}

async function packagedIdentity(path: string) {
  const [status, sha256, signatureResult, entitlementResult] = await Promise.all([
    lstat(path),
    sha256File(path),
    run(["/usr/bin/codesign", "--display", "--verbose=4", path]),
    run(["/usr/bin/codesign", "--display", "--entitlements", ":-", path]),
  ]);
  const details = `${signatureResult.stdout}\n${signatureResult.stderr}`;
  const value = (pattern: RegExp): string | null =>
    pattern.exec(details)?.[1]?.trim() ?? null;
  const rawFlags = value(/^CodeDirectory .* flags=0x[0-9a-fA-F]+\(([^)]*)\)/mu);
  const rawHashChoices = value(/^Hash choices=(.+)$/mu);
  const rawInfoPlist = value(/^Info\.plist=(.+)$/mu);
  const rawRequirementsCount = value(/^Internal requirements count=([0-9]+) size=/mu);
  const rawPageSize = value(/^Page size=([0-9]+)$/mu);
  const rawTeam = value(/^TeamIdentifier=(.+)$/mu);
  return {
    sha256,
    signature: {
      cdHash: value(/^CDHash=([0-9a-fA-F]+)$/mu)?.toLowerCase() ?? null,
      entitlements: parseCodexSignatureNormalizationEntitlements(
        `${entitlementResult.stdout}\n${entitlementResult.stderr}`,
      ),
      flags: rawFlags === null || rawFlags.length === 0 ? [] : rawFlags.split(","),
      hashChoices: rawHashChoices === null || rawHashChoices.length === 0
        ? []
        : rawHashChoices.split(","),
      hashType: value(/^Hash type=([^ ]+) size=/mu),
      identifier: value(/^Identifier=(.+)$/mu),
      infoPlistBound: rawInfoPlist === null ? null : rawInfoPlist !== "not bound",
      internalRequirementsCount:
        rawRequirementsCount === null ? null : Number(rawRequirementsCount),
      pageSize: rawPageSize === null ? null : Number(rawPageSize),
      runtimeVersion: value(/^Runtime Version=(.+)$/mu),
      sealedResources: value(/^Sealed Resources=(.+)$/mu),
      signatureKind: value(/^Signature=(.+)$/mu),
      teamIdentifier: rawTeam === "not set" ? null : rawTeam,
      timestamp: value(/^Timestamp=(.+)$/mu),
    },
    size: status.size,
  } as const;
}

function withPageSize(argv: readonly string[], pageSize: number): readonly string[] {
  const result = [...argv];
  const optionIndex = result.indexOf("--pagesize");
  if (optionIndex < 0 || result[optionIndex + 1] === undefined) {
    throw new Error("Codex signing arguments omit --pagesize.");
  }
  result[optionIndex + 1] = String(pageSize);
  return result;
}

async function deadline<T>(promise: Promise<T>, label: string): Promise<T> {
  return await Promise.race([
    promise,
    Bun.sleep(10_000).then(() => {
      throw new Error(`Timed out waiting for ${label}.`);
    }),
  ]);
}

class FrameReader {
  readonly #reader: ReadableStreamDefaultReader<Uint8Array>;
  #buffer = Buffer.alloc(0);

  constructor(stream: ReadableStream<Uint8Array>) {
    this.#reader = stream.getReader();
  }

  async #readExact(length: number): Promise<Buffer> {
    while (this.#buffer.byteLength < length) {
      const chunk = await this.#reader.read();
      if (chunk.done) throw new Error("Code-mode host closed its framed output early.");
      this.#buffer = Buffer.concat([this.#buffer, Buffer.from(chunk.value)]);
    }
    const result = this.#buffer.subarray(0, length);
    this.#buffer = this.#buffer.subarray(length);
    return result;
  }

  async read(): Promise<unknown> {
    const length = (await this.#readExact(4)).readUInt32LE(0);
    if (length === 0 || length > 64 * 1024 * 1024) {
      throw new Error(`Code-mode host returned invalid frame length ${length}.`);
    }
    return JSON.parse((await this.#readExact(length)).toString("utf8")) as unknown;
  }
}

async function writeFrame(
  stdin: Bun.FileSink,
  value: unknown,
): Promise<void> {
  const payload = Buffer.from(JSON.stringify(value), "utf8");
  const frame = Buffer.allocUnsafe(4 + payload.byteLength);
  frame.writeUInt32LE(payload.byteLength, 0);
  payload.copy(frame, 4);
  await stdin.write(frame);
  await stdin.flush();
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

async function readUntil(
  reader: FrameReader,
  predicate: (message: Record<string, unknown>) => boolean,
  label: string,
): Promise<Record<string, unknown>> {
  for (let index = 0; index < 8; index += 1) {
    const message = object(
      await deadline(reader.read(), label),
      `code-mode ${label}`,
    );
    if (predicate(message)) return message;
  }
  throw new Error(`Code-mode host did not return ${label}.`);
}

async function verifyCodeModeJit(path: string): Promise<void> {
  const child = Bun.spawn([path], {
    stderr: "pipe",
    stdin: "pipe",
    stdout: "pipe",
  });
  const stderr = new Response(child.stderr).text();
  const reader = new FrameReader(child.stdout);
  try {
    await writeFrame(child.stdin, {
      optionalCapabilities: [],
      requiredCapabilities: [],
      supportedVersions: [1],
      type: "connection/hello",
    });
    expect(await deadline(reader.read(), "code-mode handshake")).toEqual({
      capabilities: [],
      selectedVersion: 1,
      type: "connection/ready",
    });

    await writeFrame(child.stdin, {
      id: 1,
      request: { method: "session/open", sessionId: "hra-jit-smoke" },
      type: "operation/request",
    });
    expect(await deadline(reader.read(), "code-mode session open")).toEqual({
      id: 1,
      result: {
        status: "ok",
        value: { sessionId: "hra-jit-smoke", type: "session/ready" },
      },
      type: "operation/response",
    });

    await writeFrame(child.stdin, {
      id: 2,
      request: {
        method: "session/execute",
        request: {
          enabled_tools: [],
          max_output_tokens: 16,
          source: `
function hot(value) {
  return ((value * 17) ^ (value >>> 3)) & 0xffff;
}
let total = 0;
for (let index = 0; index < 1_000_000; index += 1) {
  total = (total + hot(index)) >>> 0;
}
text(String(total));
`,
          tool_call_id: "hra-jit-smoke",
          yield_time_ms: 60_000,
        },
        sessionId: "hra-jit-smoke",
      },
      type: "operation/request",
    });
    const started = await readUntil(
      reader,
      (message) => message.type === "operation/response" && message.id === 2,
      "code-mode execution start",
    );
    expect(started).toEqual({
      id: 2,
      result: {
        status: "ok",
        value: { cellId: "1", type: "execution/started" },
      },
      type: "operation/response",
    });
    const initial = await readUntil(
      reader,
      (message) => message.type === "execute/initialResponse" && message.id === 2,
      "code-mode JIT result",
    );
    const result = object(initial.result, "code-mode JIT result envelope");
    expect(result.status).toBe("ok");
    const value = object(result.value, "code-mode JIT result value");
    const terminal = object(value.Result, "code-mode JIT terminal result");
    expect(terminal).toMatchObject({
      cell_id: "1",
      error_text: null,
    });
    expect(terminal.content_items).toEqual([
      { text: "2732512480", type: "input_text" },
    ]);

    await writeFrame(child.stdin, {
      id: 3,
      request: { method: "session/shutdown", sessionId: "hra-jit-smoke" },
      type: "operation/request",
    });
    const closed = await readUntil(
      reader,
      (message) => message.type === "operation/response" && message.id === 3,
      "code-mode session shutdown",
    );
    expect(closed).toEqual({
      id: 3,
      result: {
        status: "ok",
        value: { sessionId: "hra-jit-smoke", type: "session/closed" },
      },
      type: "operation/response",
    });
    await child.stdin.end();
    expect(await deadline(child.exited, "code-mode host exit")).toBe(0);
    expect(await stderr).toBe("");
  } catch (error) {
    child.kill("SIGKILL");
    await child.stdin.end();
    await child.exited;
    const details = (await stderr).trim();
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}${details.length === 0 ? "" : `: ${details}`}`,
    );
  }
}

describe("Codex signature normalization on macOS", () => {
  test("reproduces pinned identities and executes the entitled V8 JIT", async () => {
    expect(process.platform).toBe("darwin");
    expect(process.arch).toBe("arm64");
    const pins = await verifyRuntimePins();
    const entitlementsPath = join(
      import.meta.dir,
      `../${CODEX_SIGNATURE_NORMALIZATION_ENTITLEMENTS_FILE}`,
    );
    expect(await sha256File(entitlementsPath))
      .toBe(codexSignatureNormalizationSigning.entitlementsSha256);
    const root = await mkdtemp(join(tmpdir(), "hra-codex-signature-contract-"));
    try {
      for (const entry of codexSignatureNormalizationPolicy.entries) {
        const name = basename(entry.payloadPath);
        const sourcePath = join(pins.codexVendorRoot, entry.payloadPath);
        const legacyPath = join(root, `${name}-4096`);
        const pinnedPath = join(root, `${name}-16384`);
        const deltaPath = join(root, `${name}.source-delta`);
        const reconstructedPath = join(root, `${name}-reconstructed`);
        await Promise.all([
          copyFile(sourcePath, legacyPath),
          copyFile(sourcePath, pinnedPath),
        ]);
        const pinnedArguments = codexSignatureNormalizationCodesignArguments(
          entry,
          entitlementsPath,
          pinnedPath,
        );
        await Promise.all([
          run(withPageSize(
            codexSignatureNormalizationCodesignArguments(
              entry,
              entitlementsPath,
              legacyPath,
            ),
            4_096,
          )),
          run(pinnedArguments),
        ]);

        const [legacyIdentity, pinnedIdentity] = await Promise.all([
          packagedIdentity(legacyPath),
          packagedIdentity(pinnedPath),
        ]);
        expect(() => verifyCodexSignatureNormalizationPackaged(entry, legacyIdentity))
          .toThrow("package identity differs");
        expect(() => verifyCodexSignatureNormalizationPackaged(entry, pinnedIdentity))
          .not.toThrow();
        expect(pinnedIdentity).toMatchObject({
          sha256: entry.packaged.sha256,
          signature: {
            cdHash: entry.packaged.cdHash,
            pageSize: 16_384,
            runtimeVersion: "15.5.0",
          },
          size: entry.packaged.size,
        });
        await Promise.all([
          verifyCodexSignatureNormalizationContent(sourcePath, legacyPath),
          verifyCodexSignatureNormalizationContent(sourcePath, pinnedPath),
          run(["/usr/bin/codesign", "--verify", "--strict", pinnedPath]),
        ]);

        const delta = await createCodexSignatureSourceDelta(sourcePath, pinnedPath);
        expect(delta.byteLength).toBe(entry.sourceDelta.size);
        expect(createHash("sha256").update(delta).digest("hex"))
          .toBe(entry.sourceDelta.sha256);
        await writeFile(deltaPath, delta, { flag: "wx", mode: 0o600 });
        await reconstructCodexSignatureSource(pinnedPath, deltaPath, reconstructedPath);
        expect(await sha256File(reconstructedPath)).toBe(entry.source.sha256);

        if (entry.payloadPath === "bin/codex-code-mode-host") {
          await verifyCodeModeJit(pinnedPath);
        }
      }
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  }, 180_000);
});
