import { createHash } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import { join } from "node:path";

import { DesktopSwitchError } from "./errors.ts";

export const CHATGPT_BUNDLE_ID = "com.openai.codex";
export const OPENAI_TEAM_ID = "2DC432GLL2";
export const OPENAI_SIGNING_AUTHORITY =
  "Developer ID Application: OpenAI OpCo, LLC (2DC432GLL2)";
export const CODEX_ELECTRON_USER_DATA_PATH = "CODEX_ELECTRON_USER_DATA_PATH";
export const CODEX_HOME = "CODEX_HOME";

export interface SupportedChatGptBuild {
  readonly shortVersion: string;
  readonly bundleVersion: string;
  readonly cdHash: string;
  readonly asarBytes: number;
  readonly asarSha256: string;
}

export const SUPPORTED_CHATGPT_BUILDS: readonly SupportedChatGptBuild[] = [
  {
    shortVersion: "26.818.41509",
    bundleVersion: "6962",
    cdHash: "59729f374e9041c73fae77d3fb33ce323d514ba4",
    asarBytes: 284_124_509,
    asarSha256: "8eb91bd9efbf9a4dd04b9b0afdbfcb4e0bab5da18c1919ad74ca327c00c7e791",
  },
] as const;

export interface ChatGptArchiveInspector {
  inspect(asarPath: string, build: SupportedChatGptBuild): Promise<void>;
}

export interface BoundedCommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface BoundedCommandRunner {
  run(argv: readonly [string, ...string[]], timeoutMs: number): Promise<BoundedCommandResult>;
}

export interface BoundedCommandChild {
  readonly stdout: ReadableStream<Uint8Array> | number | undefined;
  readonly stderr: ReadableStream<Uint8Array> | number | undefined;
  readonly exited: Promise<number>;
  kill(signal: "SIGTERM" | "SIGKILL"): void;
}

export interface BunBoundedCommandRunnerOptions {
  readonly spawn?: (argv: readonly [string, ...string[]]) => BoundedCommandChild;
  readonly termGraceMs?: number;
  readonly settlementMs?: number;
}

export interface ChatGptBundleCapability {
  readonly status: "supported-experimental";
  readonly bundlePath: string;
  readonly executablePath: string;
  readonly codexPath: string;
  readonly asarPath: string;
  readonly bundleIdentifier: typeof CHATGPT_BUNDLE_ID;
  readonly teamIdentifier: typeof OPENAI_TEAM_ID;
  readonly signingAuthority: typeof OPENAI_SIGNING_AUTHORITY;
  readonly shortVersion: string;
  readonly bundleVersion: string;
  readonly cdHash: string;
  readonly asarBytes?: number;
  readonly asarSha256?: string;
  readonly hooks: {
    readonly codexHome: true;
    readonly isolatedDesktopUserData: true;
    readonly preservesCodexHomeAfterShellImport: true;
    readonly explicitPathSingleInstanceFence: true;
  };
}

export async function inspectChatGptBundle(
  bundlePath: string,
  runner: BoundedCommandRunner = new BunBoundedCommandRunner(),
  archiveInspector: ChatGptArchiveInspector = defaultChatGptArchiveInspector,
): Promise<ChatGptBundleCapability> {
  const inputStat = await lstat(bundlePath).catch((error: unknown) => {
    throw new DesktopSwitchError("BUNDLE_UNSUPPORTED", "ChatGPT bundle is unavailable", {
      cause: error,
    });
  });
  if (inputStat.isSymbolicLink() || !inputStat.isDirectory()) {
    throw new DesktopSwitchError(
      "BUNDLE_UNSUPPORTED",
      "ChatGPT bundle must be a real application directory",
    );
  }
  const canonicalBundle = await realpath(bundlePath);
  const plist = join(canonicalBundle, "Contents", "Info.plist");
  const executablePath = join(canonicalBundle, "Contents", "MacOS", "ChatGPT");
  const codexPath = join(canonicalBundle, "Contents", "Resources", "codex");
  const asarPath = join(canonicalBundle, "Contents", "Resources", "app.asar");
  await assertRegularFile(executablePath, "ChatGPT executable");
  await assertRegularFile(codexPath, "bundled Codex executable");
  await assertRegularFile(asarPath, "ChatGPT application archive");

  const [identifier, shortVersion, bundleVersion] = await Promise.all([
    plistValue(plist, "CFBundleIdentifier", runner),
    plistValue(plist, "CFBundleShortVersionString", runner),
    plistValue(plist, "CFBundleVersion", runner),
  ]);
  if (identifier !== CHATGPT_BUNDLE_ID) {
    throw new DesktopSwitchError("BUNDLE_UNSUPPORTED", "ChatGPT bundle identifier is unsupported");
  }

  const verify = await runner.run(
    ["/usr/bin/codesign", "--verify", "--deep", "--strict", "--verbose=4", canonicalBundle],
    30_000,
  );
  if (verify.exitCode !== 0) {
    throw new DesktopSwitchError("SIGNATURE_INVALID", "ChatGPT code signature verification failed");
  }
  const display = await runner.run(
    ["/usr/bin/codesign", "-dv", "--verbose=5", canonicalBundle],
    10_000,
  );
  if (display.exitCode !== 0) {
    throw new DesktopSwitchError("SIGNATURE_INVALID", "ChatGPT signing identity is unavailable");
  }
  const signingText = `${display.stdout}\n${display.stderr}`;
  const teamIdentifier = exactCapture(signingText, /^TeamIdentifier=(.+)$/m, "team identifier");
  const cdHash = exactCapture(signingText, /^CDHash=([a-f0-9]+)$/m, "CDHash");
  const authorities = [...signingText.matchAll(/^Authority=(.+)$/gm)].map((match) => match[1]);
  if (teamIdentifier !== OPENAI_TEAM_ID || authorities[0] !== OPENAI_SIGNING_AUTHORITY) {
    throw new DesktopSwitchError("SIGNATURE_INVALID", "ChatGPT signer is not the supported OpenAI team");
  }
  const gatekeeper = await runner.run(
    ["/usr/sbin/spctl", "-a", "-vv", "-t", "execute", canonicalBundle],
    30_000,
  );
  const gatekeeperText = `${gatekeeper.stdout}\n${gatekeeper.stderr}`;
  if (
    gatekeeper.exitCode !== 0 ||
    !gatekeeperText.includes("accepted") ||
    !gatekeeperText.includes("source=Notarized Developer ID") ||
    !gatekeeperText.includes(`origin=${OPENAI_SIGNING_AUTHORITY}`)
  ) {
    throw new DesktopSwitchError("SIGNATURE_INVALID", "Gatekeeper did not accept the OpenAI bundle");
  }

  const supported = SUPPORTED_CHATGPT_BUILDS.find(
    (build) =>
      build.shortVersion === shortVersion &&
      build.bundleVersion === bundleVersion &&
      build.cdHash === cdHash,
  );
  if (supported === undefined) {
    throw new DesktopSwitchError(
      "BUNDLE_UNSUPPORTED",
      "this signed ChatGPT build has not passed the HRA compatibility probe",
    );
  }

  await archiveInspector.inspect(asarPath, supported);
  return {
    status: "supported-experimental",
    bundlePath: canonicalBundle,
    executablePath,
    codexPath,
    asarPath,
    bundleIdentifier: CHATGPT_BUNDLE_ID,
    teamIdentifier: OPENAI_TEAM_ID,
    signingAuthority: OPENAI_SIGNING_AUTHORITY,
    shortVersion,
    bundleVersion,
    cdHash,
    asarBytes: supported.asarBytes,
    asarSha256: supported.asarSha256,
    hooks: {
      codexHome: true,
      isolatedDesktopUserData: true,
      preservesCodexHomeAfterShellImport: true,
      explicitPathSingleInstanceFence: true,
    },
  };
}

export class BunBoundedCommandRunner implements BoundedCommandRunner {
  readonly #spawn: NonNullable<BunBoundedCommandRunnerOptions["spawn"]>;
  readonly #termGraceMs: number;
  readonly #settlementMs: number;

  constructor(options: BunBoundedCommandRunnerOptions = {}) {
    this.#spawn =
      options.spawn ??
      ((argv) => {
        const child = Bun.spawn([...argv], {
          stdin: "ignore",
          stdout: "pipe",
          stderr: "pipe",
        });
        return {
          stdout: child.stdout,
          stderr: child.stderr,
          exited: child.exited,
          kill(signal): void {
            child.kill(signal);
          },
        };
      });
    this.#termGraceMs = boundedCleanupDuration(options.termGraceMs ?? 1_000);
    this.#settlementMs = boundedCleanupDuration(options.settlementMs ?? 1_000);
  }

  async run(
    argv: readonly [string, ...string[]],
    timeoutMs: number,
  ): Promise<BoundedCommandResult> {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) {
      throw new DesktopSwitchError("CAPABILITY_MISSING", "command timeout is invalid");
    }
    const child = this.#spawn(argv);
    const stdout = boundedRead(child.stdout, 256 * 1024);
    const stderr = boundedRead(child.stderr, 256 * 1024);
    const exited = child.exited;
    const command = Promise.all([stdout.result, stderr.result, exited]);
    const joined = Promise.allSettled([stdout.result, stderr.result, exited]).then(
      () => undefined,
    );
    const outcome = await settleWithin(command, timeoutMs);
    if (outcome.status === "fulfilled") {
      return {
        stdout: outcome.value[0],
        stderr: outcome.value[1],
        exitCode: outcome.value[2],
      };
    }

    const failure =
      outcome.status === "rejected"
        ? errorFromUnknown(outcome.reason)
        : new DesktopSwitchError("CAPABILITY_MISSING", "command exceeded its timeout");
    safeKill(child, "SIGTERM");
    const termExit = await settleWithin(exited, this.#termGraceMs);
    if (termExit.status !== "fulfilled") safeKill(child, "SIGKILL");
    stdout.cancel();
    stderr.cancel();
    await settleWithin(joined, this.#settlementMs);
    throw failure;
  }
}

async function plistValue(
  plist: string,
  key: string,
  runner: BoundedCommandRunner,
): Promise<string> {
  const result = await runner.run(
    ["/usr/bin/plutil", "-extract", key, "raw", "-o", "-", plist],
    10_000,
  );
  if (result.exitCode !== 0) {
    throw new DesktopSwitchError("BUNDLE_UNSUPPORTED", `ChatGPT ${key} is unavailable`);
  }
  const value = result.stdout.trim();
  if (value.length < 1 || value.length > 512 || /[\r\n]/.test(value)) {
    throw new DesktopSwitchError("BUNDLE_UNSUPPORTED", `ChatGPT ${key} is invalid`);
  }
  return value;
}

const maximumReviewedAsarBytes = 384 * 1024 * 1024;
const semanticScanTailCharacters = 128 * 1024;
const codexHomeRestorationWindowCharacters = 4_096;
const identifierSource = "[A-Za-z_$][A-Za-z0-9_$]*";
const codexHomeCapturePattern = new RegExp(
  `(${identifierSource})=process\\.env\\.${CODEX_ELECTRON_USER_DATA_PATH}\\?\\.trim\\(\\)\\?process\\.env\\.${CODEX_HOME}:void 0`,
  "gu",
);
const codexHomeRestorePattern = new RegExp(
  `(${identifierSource})!=null&&\\(process\\.env\\.${CODEX_HOME}=\\1\\)`,
  "gu",
);
const userDataResolverPattern = new RegExp(
  `function (${identifierSource})\\(\\{appDataPath:(${identifierSource}),buildFlavor:(${identifierSource}),env:(${identifierSource})\\}\\)\\{let (${identifierSource})=\\4\\.${CODEX_ELECTRON_USER_DATA_PATH}\\?\\.trim\\(\\);if\\(\\5\\)return\\(0,(${identifierSource})\\.resolve\\)\\(\\5\\);`,
  "gu",
);
const userDataSetPathPattern = new RegExp(
  `\\.app\\.setPath\\(\\x60userData\\x60,(${identifierSource})\\(\\{appDataPath:${identifierSource}\\.app\\.getPath\\(\\x60appData\\x60\\),buildFlavor:${identifierSource},env:process\\.env\\}\\)\\)`,
  "gu",
);
const explicitPathFencePattern = new RegExp(
  `var (${identifierSource})=${identifierSource}\\.${identifierSource}\\(\\{isMacOS:${identifierSource},isPackaged:${identifierSource}\\.app\\.isPackaged,hasExplicitUserDataPath:!!process\\.env\\.${CODEX_ELECTRON_USER_DATA_PATH}\\?\\.trim\\(\\)\\}\\);if\\(!\\(!\\1\\|\\|${identifierSource}\\.app\\.requestSingleInstanceLock\\(\\)\\)\\)`,
  "gu",
);

type PositionedIdentifier = Readonly<{ identifier: string; offset: number; end: number }>;

class ProfileHookScanner {
  readonly #captures = new Map<number, PositionedIdentifier>();
  readonly #restores = new Map<number, PositionedIdentifier>();
  readonly #resolverDefinitions = new Map<number, PositionedIdentifier>();
  readonly #resolverCalls = new Map<number, PositionedIdentifier>();
  readonly #fences = new Set<number>();
  #tail = "";
  #characters = 0;

  push(value: string): void {
    if (value.length === 0) return;
    const source = this.#tail + value;
    const sourceOffset = this.#characters - this.#tail.length;
    this.#collectIdentifiers(source, sourceOffset, codexHomeCapturePattern, this.#captures);
    this.#collectIdentifiers(source, sourceOffset, codexHomeRestorePattern, this.#restores);
    this.#collectIdentifiers(source, sourceOffset, userDataResolverPattern, this.#resolverDefinitions);
    this.#collectIdentifiers(source, sourceOffset, userDataSetPathPattern, this.#resolverCalls);
    this.#collectOffsets(source, sourceOffset, explicitPathFencePattern, this.#fences);
    this.#characters += value.length;
    this.#tail = source.slice(-semanticScanTailCharacters);
  }

  assertComplete(): void {
    const captures = [...this.#captures.values()];
    if (captures.length !== 1) throwMissingProfileHook();
    const capture = captures[0] as PositionedIdentifier;
    const matchingRestores = [...this.#restores.values()].filter((restore) =>
      restore.identifier === capture.identifier
      && restore.offset >= capture.end
      && restore.offset - capture.end <= codexHomeRestorationWindowCharacters);
    if (matchingRestores.length !== 1 || this.#restores.size !== 1) throwMissingProfileHook();

    const resolverDefinitions = new Set(
      [...this.#resolverDefinitions.values()].map((entry) => entry.identifier),
    );
    const matchingResolverCalls = [...this.#resolverCalls.values()].filter((entry) =>
      resolverDefinitions.has(entry.identifier));
    if (
      this.#resolverDefinitions.size !== 1
      || this.#resolverCalls.size !== 1
      || matchingResolverCalls.length !== 1
      || this.#fences.size !== 1
    ) throwMissingProfileHook();
  }

  #collectIdentifiers(
    source: string,
    sourceOffset: number,
    pattern: RegExp,
    target: Map<number, PositionedIdentifier>,
  ): void {
    pattern.lastIndex = 0;
    for (const match of source.matchAll(pattern)) {
      const identifier = match[1];
      if (identifier === undefined) continue;
      const index = match.index;
      const offset = sourceOffset + index;
      target.set(offset, { identifier, offset, end: offset + match[0].length });
    }
  }

  #collectOffsets(
    source: string,
    sourceOffset: number,
    pattern: RegExp,
    target: Set<number>,
  ): void {
    pattern.lastIndex = 0;
    for (const match of source.matchAll(pattern)) {
      target.add(sourceOffset + match.index);
    }
  }
}

export async function inspectChatGptArchiveStream(
  stream: ReadableStream<Uint8Array>,
  expected: Pick<SupportedChatGptBuild, "asarBytes" | "asarSha256">,
): Promise<void> {
  if (
    !Number.isSafeInteger(expected.asarBytes)
    || expected.asarBytes < 1
    || expected.asarBytes > maximumReviewedAsarBytes
    || !/^[0-9a-f]{64}$/u.test(expected.asarSha256)
  ) throwMissingProfileHook();
  const digest = createHash("sha256");
  const decoder = new TextDecoder("utf-8");
  const scanner = new ProfileHookScanner();
  const reader = stream.getReader();
  let bytes = 0;
  try {
    let read = await reader.read();
    while (!read.done) {
      bytes += read.value.byteLength;
      if (bytes > expected.asarBytes || bytes > maximumReviewedAsarBytes) {
        throwMissingProfileHook();
      }
      digest.update(read.value);
      scanner.push(decoder.decode(read.value, { stream: true }));
      read = await reader.read();
    }
    scanner.push(decoder.decode());
  } finally {
    reader.releaseLock();
  }
  if (bytes !== expected.asarBytes || digest.digest("hex") !== expected.asarSha256) {
    throwMissingProfileHook();
  }
  scanner.assertComplete();
}

const defaultChatGptArchiveInspector: ChatGptArchiveInspector = {
  async inspect(asarPath, build): Promise<void> {
    const file = Bun.file(asarPath);
    if (file.size !== build.asarBytes) throwMissingProfileHook();
    await inspectChatGptArchiveStream(file.stream(), build);
  },
};

function throwMissingProfileHook(): never {
  throw new DesktopSwitchError(
    "CAPABILITY_MISSING",
    "ChatGPT does not expose the reviewed isolated-profile launch hook",
  );
}

async function assertRegularFile(path: string, label: string): Promise<void> {
  const stat = await lstat(path).catch((error: unknown) => {
    throw new DesktopSwitchError("BUNDLE_UNSUPPORTED", `${label} is unavailable`, {
      cause: error,
    });
  });
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new DesktopSwitchError("BUNDLE_UNSUPPORTED", `${label} is not a regular file`);
  }
}

function exactCapture(source: string, pattern: RegExp, label: string): string {
  const match = pattern.exec(source);
  if (match?.[1] === undefined || match[1].length > 512) {
    throw new DesktopSwitchError("SIGNATURE_INVALID", `ChatGPT ${label} is unavailable`);
  }
  return match[1];
}

function boundedRead(
  stream: ReadableStream<Uint8Array> | number | undefined,
  maxBytes: number,
): { readonly result: Promise<string>; readonly cancel: () => void } {
  if (stream === undefined || typeof stream === "number") {
    return { result: Promise.resolve(""), cancel: () => undefined };
  }
  const reader = stream.getReader();
  let released = false;
  const result = (async () => {
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      let chunk = await reader.read();
      while (!chunk.done) {
        total += chunk.value.byteLength;
        if (total > maxBytes) {
          throw new DesktopSwitchError("CAPABILITY_MISSING", "command output exceeded its limit");
        }
        chunks.push(chunk.value);
        chunk = await reader.read();
      }
    } finally {
      reader.releaseLock();
      released = true;
    }
    const joined = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      joined.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return new TextDecoder("utf-8", { fatal: true }).decode(joined);
  })();
  return {
    result,
    cancel(): void {
      const cancellation = released ? stream.cancel() : reader.cancel();
      void cancellation.catch(() => undefined);
    },
  };
}

function boundedCleanupDuration(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 10_000) {
    throw new DesktopSwitchError("CAPABILITY_MISSING", "command cleanup timeout is invalid");
  }
  return value;
}

function safeKill(child: BoundedCommandChild, signal: "SIGTERM" | "SIGKILL"): void {
  try {
    child.kill(signal);
  } catch {
    // The bounded joins below remain authoritative even when the process handle is stale.
  }
}

function errorFromUnknown(reason: unknown): Error {
  return reason instanceof Error
    ? reason
    : new DesktopSwitchError("CAPABILITY_MISSING", "command failed", { cause: reason });
}

type TimedSettlement<T> =
  | { readonly status: "fulfilled"; readonly value: T }
  | { readonly status: "rejected"; readonly reason: unknown }
  | { readonly status: "timed-out" };

async function settleWithin<T>(promise: Promise<T>, timeoutMs: number): Promise<TimedSettlement<T>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<TimedSettlement<T>>((resolveTimeout) => {
    timer = setTimeout(() => resolveTimeout({ status: "timed-out" }), timeoutMs);
  });
  try {
    const settlement = promise.then(
      (value): TimedSettlement<T> => ({ status: "fulfilled", value }),
      (reason: unknown): TimedSettlement<T> => ({ status: "rejected", reason }),
    );
    return await Promise.race([
      settlement,
      timeout,
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
