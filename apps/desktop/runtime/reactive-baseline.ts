#!/usr/bin/env bun

import { Database } from "bun:sqlite";
import { constants as fsConstants, rmSync } from "node:fs";
import {
  access,
  mkdir,
  mkdtemp,
  rm,
  stat,
} from "node:fs/promises";
import { createServer as createTcpServer } from "node:net";
import {
  arch,
  cpus,
  platform,
  release,
  tmpdir,
  totalmem,
} from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  chromium,
  type BrowserContext,
} from "playwright-core";
import { createServer as createViteServer, type ViteDevServer } from "vite";

import type { CodexFact } from "./src/codex";
import { projectCodexNotificationFacts } from "./src/codex/fact-projector";
import { createSessionState } from "./src/sessions/model";
import { reduceSessionFacts } from "./src/sessions/reducer";
import { SessionStore } from "./src/sessions/store";
import { applyMigrations } from "./src/state/database";
import { DispatchStore } from "./src/state/dispatch-store";

const BASELINE_SCHEMA = "hra.reactive-baseline/v7" as const;
const PROCESS_COMPILE_TIMEOUT_MS = 120_000;
const PROCESS_EXIT_TIMEOUT_MS = 30_000;
const PROCESS_FORCE_EXIT_TIMEOUT_MS = 5_000;
const BROWSER_ACTION_TIMEOUT_MS = 35_000;
const BROWSER_START_TIMEOUT_MS = 45_000;
const BROWSER_CLOSE_TIMEOUT_MS = 5_000;
const BROWSER_FORCE_CLOSE_TIMEOUT_MS = 35_000;
const DELTA_COUNT = 10_000;
const FOLD_SAMPLE_COUNT = 200;
const FOLD_WARMUP_COUNT = 6;
const PROCESS_OUTPUT_LIMIT_BYTES = 1_048_576;
const QUEUE_EVENT_COUNT = 512;
const QUEUE_SAMPLE_PAIR_COUNT = 3;

const desktopRoot = fileURLToPath(new URL("../", import.meta.url));
const repositoryRoot = resolve(desktopRoot, "../..");
const gatewayEntry = "runtime/src/main.ts";
const projectionQueueWorker = fileURLToPath(new URL(
  "./test/fixtures/reactive-baseline-queue-worker.ts",
  import.meta.url,
));
const directViteConfig = join(desktopRoot, "frontend/direct/vite.config.ts");
const systemChromePath = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

type JsonMetric = Readonly<Record<string, unknown>>;
type StageResult<Value> =
  | Readonly<{ status: "supported"; value: Value }>
  | Readonly<{ status: "unsupported"; disposition: string; reason: string }>
  | Readonly<{ status: "failed"; error: string }>;
type ResourceCloser = () => Promise<void>;

interface ChildHandle {
  readonly exitCode: number | null;
  readonly exited: Promise<number>;
  kill(signal?: number): void;
}

interface PipedChild extends ChildHandle {
  readonly stderr: ReadableStream<Uint8Array>;
  readonly stdout: ReadableStream<Uint8Array>;
}

interface BoundedStreamCollection {
  readonly text: Promise<string>;
  cancel(): Promise<void>;
}

class UnsupportedBaselineMetric extends Error {
  readonly disposition: string;

  constructor(message: string, disposition: string) {
    super(message);
    this.name = "UnsupportedBaselineMetric";
    this.disposition = disposition;
  }
}

const activeChildren = new Set<ChildHandle>();
const activeResourceClosers = new Set<ResourceCloser>();

function supported(value: unknown, context: JsonMetric = {}): JsonMetric {
  return { status: "supported", ...context, value };
}

function unsupported(reason: string, disposition: string): JsonMetric {
  return { status: "unsupported", disposition, reason };
}

function failed(reason: unknown): JsonMetric {
  return { status: "failed", error: renderFailure(reason) };
}

function renderFailure(reason: unknown): string {
  const seen = new Set<unknown>();
  const render = (value: unknown, depth: number): string => {
    if (depth > 3) return "[nested error omitted]";
    if (seen.has(value)) return "[circular error]";
    if (typeof value === "object" && value !== null) seen.add(value);
    if (value instanceof AggregateError) {
      const rawErrors = (value as Error & { readonly errors: unknown }).errors;
      const causes = (Array.isArray(rawErrors) ? rawErrors as readonly unknown[] : [])
        .slice(0, 6)
        .map((error) => render(error, depth + 1));
      return `${value.name}: ${value.message}; causes=[${causes.join(" | ")}]`;
    }
    if (value instanceof Error) {
      const cause = value.cause === undefined ? "" : `; cause=${render(value.cause, depth + 1)}`;
      return `${value.name}: ${value.message}${cause}`;
    }
    if (typeof value === "string") return value;
    try {
      return JSON.stringify(value);
    } catch {
      return "Unknown baseline failure";
    }
  };
  const rendered = render(reason, 0);
  return rendered.length <= 4_096 ? rendered : `${rendered.slice(0, 4_095)}…`;
}

function asError(reason: unknown): Error {
  return reason instanceof Error ? reason : new Error(renderFailure(reason));
}

function elapsedMs(startedAt: number): number {
  return Number((performance.now() - startedAt).toFixed(3));
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function objectField(value: unknown, key: string): unknown {
  if (typeof value !== "object" || value === null || !(key in value)) {
    throw new Error(`Browser baseline result is missing ${key}.`);
  }
  return (value as Readonly<Record<string, unknown>>)[key];
}

function taskEnvironment(
  temporaryRoot: string,
  extra: Readonly<Record<string, string>> = {},
): Record<string, string> {
  return {
    CI: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_TERMINAL_PROMPT: "0",
    LANG: "en_US.UTF-8",
    LC_ALL: "en_US.UTF-8",
    NO_COLOR: "1",
    PATH: "/usr/bin:/bin",
    TERM: "dumb",
    TMPDIR: join(temporaryRoot, "tmp"),
    ...extra,
  };
}

async function withTimeout<Value>(
  promise: Promise<Value>,
  timeoutMs: number,
  message: string,
): Promise<Value> {
  void promise.catch(() => undefined);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(message)), timeoutMs);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function trackChild<Child extends ChildHandle>(child: Child): Child {
  activeChildren.add(child);
  void child.exited.finally(() => {
    activeChildren.delete(child);
  }).catch(() => undefined);
  return child;
}

function trackResourceCloser(action: ResourceCloser): ResourceCloser {
  let inFlight: Promise<void> | null = null;
  const close = async (): Promise<void> => {
    if (inFlight === null) {
      inFlight = (async () => {
        await action();
        activeResourceClosers.delete(close);
      })();
    }
    try {
      await inFlight;
    } catch (reason: unknown) {
      inFlight = null;
      throw reason;
    }
  };
  activeResourceClosers.add(close);
  return close;
}

function collectBoundedUtf8(
  stream: ReadableStream<Uint8Array>,
  label: string,
): BoundedStreamCollection {
  const reader = stream.getReader();
  const text = (async () => {
    const decoder = new TextDecoder();
    let output = "";
    let observedBytes = 0;
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        observedBytes += next.value.byteLength;
        if (observedBytes > PROCESS_OUTPUT_LIMIT_BYTES) {
          throw new Error(
            `${label} exceeded its ${String(PROCESS_OUTPUT_LIMIT_BYTES)}-byte output limit.`,
          );
        }
        output += decoder.decode(next.value, { stream: true });
      }
      return output + decoder.decode();
    } finally {
      reader.releaseLock();
    }
  })();
  return {
    text,
    cancel: async () => {
      try {
        await reader.cancel();
      } catch {
        // A completed reader already released its lock.
      }
    },
  };
}

async function closeResources(
  closers: readonly (ResourceCloser | undefined)[],
): Promise<Error[]> {
  const errors: Error[] = [];
  for (const close of closers) {
    if (close === undefined) continue;
    try {
      await close();
    } catch (reason: unknown) {
      errors.push(asError(reason));
    }
  }
  return errors;
}

async function terminateAndReap(child: ChildHandle): Promise<void> {
  if (child.exitCode !== null) {
    activeChildren.delete(child);
    await child.exited;
    return;
  }
  child.kill();
  const stopped = await Promise.race([
    child.exited.then(() => true),
    Bun.sleep(PROCESS_FORCE_EXIT_TIMEOUT_MS).then(() => false),
  ]);
  if (!stopped) {
    child.kill(9);
    await withTimeout(
      child.exited,
      PROCESS_FORCE_EXIT_TIMEOUT_MS,
      "A baseline child did not exit after SIGKILL.",
    );
  }
  activeChildren.delete(child);
}

async function collectPipedChild(
  child: PipedChild,
  timeoutMs: number,
  label: string,
): Promise<Readonly<{ exitCode: number; stderr: string; stdout: string }>> {
  const stdout = collectBoundedUtf8(child.stdout, `${label} stdout`);
  const stderr = collectBoundedUtf8(child.stderr, `${label} stderr`);
  const stdoutTask = stdout.text;
  const stderrTask = stderr.text;
  const collection = Promise.all([stdoutTask, stderrTask, child.exited]);
  try {
    const [stdout, stderr, exitCode] = await withTimeout(
      collection,
      timeoutMs,
      `${label} exceeded its ${String(timeoutMs)}ms deadline.`,
    );
    return { exitCode, stderr, stdout };
  } catch (reason: unknown) {
    const cleanupErrors: Error[] = [];
    try {
      await terminateAndReap(child);
    } catch (cleanupReason: unknown) {
      cleanupErrors.push(asError(cleanupReason));
    }
    const cancellations = await Promise.allSettled([stdout.cancel(), stderr.cancel()]);
    for (const cancellation of cancellations) {
      if (cancellation.status === "rejected") {
        cleanupErrors.push(asError(cancellation.reason));
      }
    }
    try {
      const streams = await withTimeout(
        Promise.allSettled([stdoutTask, stderrTask]),
        PROCESS_FORCE_EXIT_TIMEOUT_MS,
        `${label} output streams did not close after child termination.`,
      );
      for (const stream of streams) {
        if (stream.status === "rejected") cleanupErrors.push(asError(stream.reason));
      }
    } catch (streamReason: unknown) {
      cleanupErrors.push(asError(streamReason));
    }
    if (cleanupErrors.length > 0) {
      throw new AggregateError(
        [asError(reason), ...cleanupErrors],
        `${label} failed and cleanup reported additional errors.`,
      );
    }
    throw reason;
  } finally {
    if (child.exitCode !== null) activeChildren.delete(child);
  }
}

async function captureStage<Value>(
  action: () => Value | Promise<Value>,
): Promise<StageResult<Value>> {
  try {
    return { status: "supported", value: await action() };
  } catch (reason: unknown) {
    if (reason instanceof UnsupportedBaselineMetric) {
      return {
        status: "unsupported",
        disposition: reason.disposition,
        reason: reason.message,
      };
    }
    return { status: "failed", error: renderFailure(reason) };
  }
}

function projectStage<Input, Output>(
  result: StageResult<Input>,
  project: (value: Input) => Output,
  context: JsonMetric = {},
): JsonMetric {
  if (result.status === "unsupported") {
    return unsupported(result.reason, result.disposition);
  }
  if (result.status === "failed") return failed(result.error);
  try {
    return supported(project(result.value), context);
  } catch (reason: unknown) {
    return failed(reason);
  }
}

function sourceMetadata(temporaryRoot: string): JsonMetric {
  function git(arguments_: readonly string[]): string {
    const result = Bun.spawnSync(["/usr/bin/git", ...arguments_], {
      cwd: repositoryRoot,
      env: taskEnvironment(temporaryRoot),
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    if (result.exitCode !== 0) {
      throw new Error(
        `git ${arguments_.join(" ")} failed: ${new TextDecoder().decode(result.stderr).trim()}`,
      );
    }
    return new TextDecoder().decode(result.stdout).trim();
  }

  const processors = cpus();
  return {
    architecture: arch(),
    bunVersion: Bun.version,
    cpuCount: processors.length,
    cpuModel: processors[0]?.model ?? "unknown",
    operatingSystemRelease: release(),
    platform: platform(),
    sourceRevision: git(["rev-parse", "HEAD"]),
    sourceTree: git(["status", "--porcelain=v1"]).length === 0 ? "clean" : "dirty",
    totalMemoryBytes: totalmem(),
  };
}

function installSignalCleanup(
  cleanup: () => Promise<unknown>,
  emergencyCleanup: (force: boolean) => void,
  finalExitCleanup: () => void,
): () => void {
  let handling = false;
  const handlers = new Map<NodeJS.Signals, () => void>();
  const uninstall = () => {
    for (const [signal, handler] of handlers) process.off(signal, handler);
  };
  const exitWithSignalCode = (signal: "SIGINT" | "SIGTERM") => {
    uninstall();
    process.once("exit", () => {
      try {
        // This late listener removes the harness root after Playwright's live
        // process-group owner has synchronously signaled any browser it owns.
        finalExitCleanup();
      } catch {
        // Exit cleanup cannot report asynchronously; the owned guard prevents
        // this fallback from widening its deletion scope.
      }
    });
    // process.exit emits the exit event, so Playwright can synchronously kill
    // any still-launching browser through its live ChildProcess owner.
    process.exit(signal === "SIGINT" ? 130 : 143);
  };
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    const handler = () => {
      if (handling) {
        try {
          emergencyCleanup(true);
        } catch {
          // The process exits immediately after the best-effort forced sweep.
        }
        exitWithSignalCode(signal);
        return;
      }
      handling = true;
      try {
        emergencyCleanup(false);
      } catch {
        // The bounded asynchronous scope retries and reports cleanup failures.
      }
      void cleanup().catch(() => undefined).finally(() => {
        exitWithSignalCode(signal);
      });
    };
    handlers.set(signal, handler);
    process.on(signal, handler);
  }
  return uninstall;
}

function removeOwnedTemporaryRootSync(temporaryRoot: string): void {
  const resolvedRoot = resolve(temporaryRoot);
  if (
    dirname(resolvedRoot) !== resolve(tmpdir())
    || !basename(resolvedRoot).startsWith("hra-reactive-baseline-")
  ) {
    throw new Error("Refused to remove an unowned reactive-baseline root.");
  }
  rmSync(resolvedRoot, { recursive: true, force: true });
}

async function cleanupBaselineResources(temporaryRoot: string) {
  const errors = await closeResources([...activeResourceClosers].reverse());
  const childCleanup = await Promise.allSettled([...activeChildren].map(async (child) => {
    await terminateAndReap(child);
  }));
  for (const result of childCleanup) {
    if (result.status === "rejected") errors.push(asError(result.reason));
  }
  process.once("exit", () => {
    try {
      // Registration happens after resource closers settle, so this listener
      // follows any Playwright exit owner created by a rejected browser launch.
      removeOwnedTemporaryRootSync(temporaryRoot);
    } catch {
      // The asynchronous removal below reports failures during the run.
    }
  });
  try {
    await withTimeout(
      rm(temporaryRoot, { recursive: true, force: true }),
      PROCESS_EXIT_TIMEOUT_MS,
      "The reactive-baseline temporary root was not removed before its deadline.",
    );
  } catch (reason: unknown) {
    errors.push(asError(reason));
  }
  if (errors.length > 0) {
    throw new AggregateError(errors, "Baseline cleanup failed.");
  }
  return {
    activeChildren: activeChildren.size,
    activeResourceClosers: activeResourceClosers.size,
    temporaryRootRemoved: true,
  };
}

async function measureCompiledGateway(temporaryRoot: string) {
  const output = join(temporaryRoot, "hra-gateway");
  const startedAt = performance.now();
  const build = trackChild(Bun.spawn([
    process.execPath,
    "build",
    "--compile",
    "--minify",
    "--sourcemap=none",
    gatewayEntry,
    "--outfile",
    output,
  ], {
    cwd: desktopRoot,
    env: taskEnvironment(temporaryRoot),
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  }));
  const collected = await collectPipedChild(
    build,
    PROCESS_COMPILE_TIMEOUT_MS,
    "Gateway compile",
  );
  if (collected.exitCode !== 0) {
    throw new Error(
      `Gateway compile exited with ${String(collected.exitCode)}: ${collected.stderr.trim() || collected.stdout.trim()}`,
    );
  }
  const artifact = await stat(output);
  return {
    artifactBytes: artifact.size,
    buildElapsedMs: elapsedMs(startedAt),
    buildStderrBytes: byteLength(collected.stderr),
    buildStdoutBytes: byteLength(collected.stdout),
    command: "bun build --compile --minify --sourcemap=none runtime/src/main.ts",
    sampleCount: 1,
  };
}

function measureAdapterDeltaIngest() {
  let emittedEvents = 0;
  const store = new SessionStore();
  store.dispatchBatch(projectCodexNotificationFacts("acct_baseline01", {
    generation: 1,
    streamPosition: 1,
    method: "thread/started",
    params: {
      thread: {
        id: "thread-baseline",
        ephemeral: false,
        preview: "Reactive baseline",
        createdAt: 1_767_225_600,
        updatedAt: 1_767_225_600,
        status: { type: "active", activeFlags: [] },
        cwd: "/tmp/hra-reactive-baseline",
        historyMode: "paginated",
        name: "Reactive baseline",
        threadSource: null,
        turns: [{
          id: "turn-baseline",
          items: [],
          itemsView: "full",
          status: "inProgress",
          startedAt: 1_767_225_600,
          completedAt: null,
        }],
      },
    },
  }));
  store.subscribe(() => {
    emittedEvents += 1;
  });
  const notification = {
    generation: 1,
    streamPosition: 3,
    method: "item/agentMessage/delta" as const,
    params: {
      threadId: "thread-baseline",
      turnId: "turn-baseline",
      itemId: "item-baseline",
      delta: "x",
    },
  };
  store.dispatchBatch(projectCodexNotificationFacts("acct_baseline01", {
    generation: 1,
    streamPosition: 2,
    method: "item/started",
    params: {
      threadId: "thread-baseline",
      turnId: "turn-baseline",
      item: { type: "agentMessage", id: "item-baseline", text: "" },
      startedAtMs: 1_767_225_600_000,
    },
  }));
  const startedAt = performance.now();
  for (let index = 0; index < DELTA_COUNT; index += 1) {
    store.dispatchBatch(projectCodexNotificationFacts("acct_baseline01", {
      ...notification,
      streamPosition: index + 3,
    }));
  }
  return {
    elapsedMs: elapsedMs(startedAt),
    emittedEvents,
    inputDeltas: DELTA_COUNT,
    label: "codex-fact-project-and-pure-fold",
    lastRevision: store.getSnapshot().revision,
  };
}

function foldTrace(deltaCount: number): readonly CodexFact[] {
  const facts: CodexFact[] = [
    ...projectCodexNotificationFacts("acct_baseline01", {
      generation: 1,
      streamPosition: 1,
      method: "thread/started",
      params: {
        thread: {
          id: "thread-baseline",
          ephemeral: false,
          preview: "Reactive baseline",
          createdAt: 1_767_225_600,
          updatedAt: 1_767_225_600,
          status: { type: "active", activeFlags: [] },
          cwd: "/tmp/hra-reactive-baseline",
          historyMode: "paginated",
          name: "Reactive baseline",
          threadSource: null,
          turns: [{
            id: "turn-baseline",
            items: [],
            itemsView: "full",
            status: "inProgress",
            startedAt: 1_767_225_600,
            completedAt: null,
          }],
        },
      },
    }),
    ...projectCodexNotificationFacts("acct_baseline01", {
      generation: 1,
      streamPosition: 2,
      method: "item/started",
      params: {
        threadId: "thread-baseline",
        turnId: "turn-baseline",
        item: { type: "agentMessage", id: "item-baseline", text: "" },
        startedAtMs: 1_767_225_600_000,
      },
    }),
  ];
  for (let index = 0; index < deltaCount; index += 1) {
    facts.push(...projectCodexNotificationFacts("acct_baseline01", {
      generation: 1,
      streamPosition: index + 3,
      method: "item/agentMessage/delta",
      params: {
        threadId: "thread-baseline",
        turnId: "turn-baseline",
        itemId: "item-baseline",
        delta: "x",
      },
    }));
  }
  return Object.freeze(facts);
}

function percentile95(values: readonly number[]): number {
  if (values.length === 0) throw new Error("A p95 sample must not be empty.");
  const ordered = [...values].sort((left, right) => left - right);
  return ordered[Math.ceil(ordered.length * 0.95) - 1] ?? 0;
}

function measurePureFoldReplay() {
  const halfTrace = foldTrace(DELTA_COUNT / 2);
  const fullTrace = foldTrace(DELTA_COUNT);
  const replay = (facts: readonly CodexFact[]): number => {
    const startedAt = performance.now();
    const state = reduceSessionFacts(createSessionState(), facts);
    if (state.revision !== 1) {
      throw new Error("Pure fold replay did not publish one atomic revision.");
    }
    return elapsedMs(startedAt);
  };
  for (let index = 0; index < FOLD_WARMUP_COUNT; index += 1) {
    if (index % 2 === 0) {
      replay(halfTrace);
      replay(fullTrace);
    } else {
      replay(fullTrace);
      replay(halfTrace);
    }
  }
  const halfSamples: number[] = [];
  const fullSamples: number[] = [];
  for (let index = 0; index < FOLD_SAMPLE_COUNT; index += 1) {
    if (index % 2 === 0) {
      halfSamples.push(replay(halfTrace));
      fullSamples.push(replay(fullTrace));
    } else {
      fullSamples.push(replay(fullTrace));
      halfSamples.push(replay(halfTrace));
    }
  }
  const halfP95Ms = percentile95(halfSamples);
  const fullP95Ms = percentile95(fullSamples);
  const doublingRatio = Number((fullP95Ms / halfP95Ms).toFixed(3));
  if (!Number.isFinite(doublingRatio) || doublingRatio > 2.5) {
    throw new Error(
      `Pure fold replay scaling exceeded 2.5x (${String(doublingRatio)}x; ` +
        `half p95 ${String(halfP95Ms)}ms; full p95 ${String(fullP95Ms)}ms).`,
    );
  }
  return {
    doublingRatio,
    full: { acceptedFacts: fullTrace.length, p95Ms: fullP95Ms, samplesMs: fullSamples },
    half: { acceptedFacts: halfTrace.length, p95Ms: halfP95Ms, samplesMs: halfSamples },
    limit: 2.5,
    sampleCount: FOLD_SAMPLE_COUNT,
    workload: "immutable owned facts with one active assistant-text item",
  };
}

interface ProjectionQueueWorkerSample {
  readonly heapNodeCount: number;
  readonly heapNodeSelfSizeBytes: number;
  readonly queuedEventCount: number;
  readonly serializedQueueBytes: number;
}

async function projectionQueueSample(
  temporaryRoot: string,
  mode: "drained" | "retained",
): Promise<ProjectionQueueWorkerSample> {
  const child = trackChild(Bun.spawn([process.execPath, projectionQueueWorker], {
    cwd: desktopRoot,
    env: taskEnvironment(temporaryRoot, {
      HRA_REACTIVE_BASELINE_QUEUE_MODE: mode,
    }),
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  }));
  const collected = await collectPipedChild(
    child,
    PROCESS_EXIT_TIMEOUT_MS,
    `Projection queue ${mode} worker`,
  );
  if (collected.exitCode !== 0) {
    throw new Error(
      `Projection queue ${mode} worker exited with ${String(collected.exitCode)}: ${collected.stderr.trim()}`,
    );
  }
  const parsed: unknown = JSON.parse(collected.stdout);
  if (
    typeof parsed !== "object"
    || parsed === null
    || !("heapNodeCount" in parsed)
    || !("heapNodeSelfSizeBytes" in parsed)
    || !("queuedEventCount" in parsed)
    || !("serializedQueueBytes" in parsed)
    || typeof parsed.heapNodeCount !== "number"
    || typeof parsed.heapNodeSelfSizeBytes !== "number"
    || typeof parsed.queuedEventCount !== "number"
    || typeof parsed.serializedQueueBytes !== "number"
    || !Number.isSafeInteger(parsed.heapNodeCount)
    || !Number.isSafeInteger(parsed.heapNodeSelfSizeBytes)
    || !Number.isSafeInteger(parsed.queuedEventCount)
    || !Number.isSafeInteger(parsed.serializedQueueBytes)
  ) {
    throw new Error(`Projection queue ${mode} worker returned an invalid sample.`);
  }
  return {
    heapNodeCount: parsed.heapNodeCount,
    heapNodeSelfSizeBytes: parsed.heapNodeSelfSizeBytes,
    queuedEventCount: parsed.queuedEventCount,
    serializedQueueBytes: parsed.serializedQueueBytes,
  };
}

function median(values: readonly number[]): number {
  if (values.length === 0) throw new Error("A median requires at least one value.");
  const ordered = [...values].sort((left, right) => left - right);
  return ordered[Math.floor(ordered.length / 2)] ?? 0;
}

async function measureProjectionQueue(temporaryRoot: string) {
  const samples: Array<Readonly<{
    drained: ProjectionQueueWorkerSample;
    heapNodeSelfSizeDeltaBytes: number;
    retained: ProjectionQueueWorkerSample;
  }>> = [];
  for (let index = 0; index < QUEUE_SAMPLE_PAIR_COUNT; index += 1) {
    const drained = await projectionQueueSample(temporaryRoot, "drained");
    const retained = await projectionQueueSample(temporaryRoot, "retained");
    if (
      drained.queuedEventCount !== 0
      || retained.queuedEventCount !== QUEUE_EVENT_COUNT
      || drained.serializedQueueBytes !== 0
    ) {
      throw new Error("Projection queue workers did not preserve the intended workloads.");
    }
    samples.push({
      drained,
      heapNodeSelfSizeDeltaBytes:
        retained.heapNodeSelfSizeBytes - drained.heapNodeSelfSizeBytes,
      retained,
    });
  }
  const serializedQueueBytes = samples[0]?.retained.serializedQueueBytes;
  if (
    serializedQueueBytes === undefined
    || samples.some(({ retained }) => retained.serializedQueueBytes !== serializedQueueBytes)
  ) {
    throw new Error("Projection queue serialized byte samples were not deterministic.");
  }
  return {
    eventCount: QUEUE_EVENT_COUNT,
    heapNodeSelfSizeDeltaBytesMedian: median(
      samples.map(({ heapNodeSelfSizeDeltaBytes }) => heapNodeSelfSizeDeltaBytes),
    ),
    heapMeasurement:
      "approximate three-pair fresh-process median; allocator and runtime noise remain",
    samplePairs: samples,
    serializedQueueBytes,
    serializedQueueBytesMeasurement: "exact RuntimeProjection queue accounting",
    workload: "512 renderer-safe workspace invalidations",
  };
}

function createDispatchStoreFixture(database: Database): DispatchStore {
  database.exec("PRAGMA foreign_keys = ON");
  applyMigrations(database);
  database.query(`
    INSERT INTO projects (
      project_id, canonical_repository_path, canonical_git_common_dir,
      display_name, created_at, updated_at
    ) VALUES ('project_baseline', '/fixture/repo', '/fixture/repo/.git',
      'Baseline', '2026-07-29T00:00:00.000Z', '2026-07-29T00:00:00.000Z')
  `).run();
  const store = new DispatchStore(database);
  store.bindRepository({
    repositoryPublicId: "repo_baseline01",
    projectId: "project_baseline",
    canonicalRepositoryPath: "/fixture/repo",
    canonicalGitCommonDir: "/fixture/repo/.git",
    now: new Date("2026-07-29T00:00:00.000Z"),
  });
  store.reserve({
    runId: "run_baseline001",
    taskId: "task_baseline001",
    taskKey: "OPS-7K2M4Q9",
    claimId: "claim_baseline01",
    claimFence: 1,
    inputReviewRevision: 1,
    runtimePublicId: "runner_baseline1",
    runtimeBootId: "boot_baseline001",
    repositoryPublicId: "repo_baseline01",
    now: new Date("2026-07-29T00:00:00.000Z"),
  });
  return store;
}

async function measureSqliteTransactions(temporaryRoot: string) {
  const databasePath = join(temporaryRoot, "control-plane-latency.sqlite");
  const database = new Database(databasePath, { create: true, strict: true });
  try {
    database.exec([
      "PRAGMA foreign_keys = ON",
      "PRAGMA journal_mode = WAL",
      "PRAGMA synchronous = FULL",
      "PRAGMA trusted_schema = OFF",
    ].join("; "));
    const store = createDispatchStoreFixture(database);
    const originalTransaction = database.transaction.bind(database);
    let transactionCount = 0;
    const installed = Reflect.set(
      database,
      "transaction",
      (callback: () => unknown) => {
        transactionCount += 1;
        return originalTransaction(callback);
      },
    );
    if (!installed) throw new Error("Could not install SQLite transaction counter.");
    const now = new Date("2026-07-29T00:00:01.000Z");
    let acceptedBytes = 0;
    const batchSize = 100;
    const batchSamplesMs: number[] = [];
    const startedAt = performance.now();
    let batchStartedAt = startedAt;
    for (let index = 0; index < DELTA_COUNT; index += 1) {
      acceptedBytes += store.appendDisplayDelta({
        runId: "run_baseline001",
        kind: "codex.assistant_message.delta",
        displayText: "x",
        now,
      });
      if (index % batchSize === batchSize - 1) {
        batchSamplesMs.push(elapsedMs(batchStartedAt));
        batchStartedAt = performance.now();
      }
    }
    const databaseFile = await stat(databasePath);
    const walFile = await stat(`${databasePath}-wal`);
    return {
      acceptedBytes,
      batch: {
        operations: batchSize,
        p50Ms: median(batchSamplesMs),
        p95Ms: percentile95(batchSamplesMs),
        samples: batchSamplesMs.length,
      },
      databaseBytes: databaseFile.size,
      elapsedMs: elapsedMs(startedAt),
      elapsedMeasurement: "owned file-backed SQLite WAL with synchronous FULL",
      inputDeltas: DELTA_COUNT,
      instrumentation: "top-level bun:sqlite Database.transaction calls",
      journalMode: "wal",
      storage: "owned temporary filesystem",
      synchronous: "FULL",
      transactionCount,
      walBytes: walFile.size,
      workload: "DispatchStore.appendDisplayDelta",
    };
  } finally {
    database.close();
  }
}

function browserBaselineIsStable(): boolean {
  const baseline = Reflect.get(window, "__hraReactiveBaseline") as
    | Readonly<{ snapshot: () => unknown }>
    | undefined;
  if (baseline === undefined) return false;
  const sample = baseline.snapshot();
  if (typeof sample !== "object" || sample === null) return false;
  const sampleRecord = sample as Readonly<Record<string, unknown>>;
  const activeRequests = sampleRecord.activeRequests;
  const ready = sampleRecord.ready;
  if (ready !== true || activeRequests !== 0) return false;
  const key = [
    sampleRecord.commits,
    sampleRecord.invocationCount,
    sampleRecord.rootRenderAttempts,
    sampleRecord.snapshotReads,
    sampleRecord.unrelatedSelectionRenders,
  ].join(":");
  const previous = Reflect.get(window, "__hraReactiveBaselineQuiet") as
    | Readonly<{ key: string; since: number }>
    | undefined;
  if (previous?.key !== key) {
    Reflect.set(window, "__hraReactiveBaselineQuiet", { key, since: Date.now() });
    return false;
  }
  return Date.now() - previous.since >= 150;
}

async function reserveLoopbackPort(): Promise<number> {
  const server = createTcpServer();
  try {
    await new Promise<void>((resolvePromise, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolvePromise());
    });
    const address = server.address();
    if (typeof address !== "object" || address === null) {
      throw new Error("Could not reserve a loopback TCP port.");
    }
    return address.port;
  } finally {
    await new Promise<void>((resolvePromise, reject) => {
      server.close((error) => error === undefined ? resolvePromise() : reject(error));
    });
  }
}

async function measureBrowserPaneUpdate(temporaryRoot: string): Promise<unknown> {
  if (platform() !== "darwin") {
    throw new UnsupportedBaselineMetric(
      "The Phase 0 desktop browser sample is defined for the macOS system Chrome runtime.",
      "Environment: run this metric on a supported macOS host.",
    );
  }
  try {
    await access(systemChromePath, fsConstants.X_OK);
  } catch {
    throw new UnsupportedBaselineMetric(
      "System Chrome is not installed at the pinned macOS application path.",
      "Environment: install system Chrome on the supported macOS measurement host.",
    );
  }

  const port = await reserveLoopbackPort();
  const baseUrl = `http://127.0.0.1:${String(port)}`;
  let context: BrowserContext | undefined;
  let server: ViteDevServer | undefined;
  let closeContext: ResourceCloser | undefined;
  let closeServer: ResourceCloser | undefined;
  let primaryFailure: unknown;
  let result: unknown;
  let blockedExternalRequests = 0;

  try {
    server = await createViteServer({
      configFile: directViteConfig,
      logLevel: "silent",
      root: join(desktopRoot, "frontend/direct"),
      server: {
        hmr: false,
        host: "127.0.0.1",
        port,
        strictPort: true,
      },
    });
    const ownedServer = server;
    closeServer = trackResourceCloser(async () => {
      await withTimeout(
        ownedServer.close(),
        PROCESS_EXIT_TIMEOUT_MS,
        "The baseline Direct Vite server did not close before its deadline.",
      );
    });
    await withTimeout(
      server.listen(),
      BROWSER_START_TIMEOUT_MS,
      "The owned Direct Vite server did not start before the baseline deadline.",
    );
    const contextLaunch = chromium.launchPersistentContext("", {
      env: taskEnvironment(temporaryRoot),
      executablePath: systemChromePath,
      headless: true,
      handleSIGINT: false,
      handleSIGTERM: false,
      serviceWorkers: "block",
      timeout: BROWSER_START_TIMEOUT_MS,
      args: [
        "--disable-background-networking",
        "--disable-breakpad",
        "--disable-component-update",
        "--disable-crash-reporter",
        "--disable-default-apps",
        "--disable-sync",
        "--metrics-recording-only",
        "--no-first-run",
      ],
    });
    closeContext = trackResourceCloser(async () => {
      let ownedContext: BrowserContext;
      try {
        // Playwright owns the detached browser process group before this
        // promise settles. A rejection starts Playwright's owned rollback.
        ownedContext = await contextLaunch;
      } catch {
        return;
      }
      try {
        await withTimeout(
          ownedContext.close(),
          BROWSER_CLOSE_TIMEOUT_MS,
          "The baseline Chrome context did not close before its graceful deadline.",
        );
      } catch (gracefulReason: unknown) {
        const ownedBrowser = ownedContext.browser();
        if (ownedBrowser === null) throw asError(gracefulReason);
        try {
          // Playwright owns the detached launcher process group. Its pinned
          // browser close is a bounded graceful close followed by group kill.
          await withTimeout(
            ownedBrowser.close(),
            BROWSER_FORCE_CLOSE_TIMEOUT_MS,
            "The baseline Chrome browser did not exit through Playwright's close-or-kill path.",
          );
        } catch (forceReason: unknown) {
          throw new AggregateError(
            [asError(gracefulReason), asError(forceReason)],
            "The baseline Chrome process resisted graceful and forced cleanup.",
          );
        }
      }
    });
    context = await contextLaunch;
    const browser = context.browser();
    if (browser === null) throw new Error("The persistent Chrome context has no process owner.");
    context.setDefaultTimeout(BROWSER_ACTION_TIMEOUT_MS);
    await context.route("**/*", async (route) => {
      const requestUrl = new URL(route.request().url());
      if (
        (requestUrl.protocol === "http:" || requestUrl.protocol === "https:")
        && requestUrl.origin !== baseUrl
      ) {
        blockedExternalRequests += 1;
        await route.abort("blockedbyclient");
        return;
      }
      await route.continue();
    });
    const page = context.pages()[0] ?? await context.newPage();
    await page.goto(`${baseUrl}/reactive-baseline.html`, { waitUntil: "networkidle" });
    await page.locator(".chat-pane").first().waitFor();
    await page.getByRole("button", { exact: true, name: "Rename Parallel pane 1" }).waitFor();
    await page.waitForFunction(browserBaselineIsStable);
    await page.evaluate(() => {
      Reflect.set(window, "__hraReactiveBaselineQuiet", undefined);
      const baseline = Reflect.get(window, "__hraReactiveBaseline") as
        | Readonly<{ begin: () => unknown }>
        | undefined;
      if (baseline === undefined) throw new Error("The browser baseline is unavailable.");
      return baseline.begin();
    });
    await page.getByRole("button", {
      exact: true,
      name: "Rename Reactive baseline pane",
    }).waitFor();
    await page.waitForFunction(browserBaselineIsStable);
    const measured = await page.evaluate(() => {
      const baseline = Reflect.get(window, "__hraReactiveBaseline") as
        | Readonly<{ finish: () => unknown }>
        | undefined;
      if (baseline === undefined) throw new Error("The browser baseline is unavailable.");
      return baseline.finish();
    });
    JSON.stringify(measured);
    result = {
      ...(measured as Readonly<Record<string, unknown>>),
      containment: {
        automation: "playwright-core with a Playwright-owned temporary persistent profile",
        blockedExternalRequests,
        browserVersion: browser.version(),
        directBrowserFirewall: "installed by createHRADirectShellFactory",
        browserProcess:
          "allowlisted environment with pinned Playwright graceful-close and force-kill ownership",
        server: "owned loopback-only Vite server on a strict reserved port",
      },
    };
  } catch (reason: unknown) {
    primaryFailure = reason;
  }

  const cleanupErrors = await closeResources([
    closeContext,
    closeServer,
  ]);
  if (primaryFailure !== undefined) {
    if (cleanupErrors.length > 0) {
      throw new AggregateError(
        [asError(primaryFailure), ...cleanupErrors],
        "Browser measurement failed and cleanup reported additional errors.",
      );
    }
    throw asError(primaryFailure);
  }
  if (cleanupErrors.length > 0) {
    throw new AggregateError(cleanupErrors, "Browser measurement cleanup failed.");
  }
  if (result === undefined) throw new Error("Browser measurement produced no result.");
  return result;
}

async function run() {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "hra-reactive-baseline-"));
  let cleanupPromise: ReturnType<typeof cleanupBaselineResources> | null = null;
  const cleanupResources = () => {
    cleanupPromise ??= cleanupBaselineResources(temporaryRoot);
    return cleanupPromise;
  };
  const uninstallSignalCleanup = installSignalCleanup(
    cleanupResources,
    (force) => {
      for (const child of activeChildren) {
        try {
          if (child.exitCode === null) child.kill(force ? 9 : undefined);
        } catch {
          // The bounded asynchronous scope retries process cleanup.
        }
      }
    },
    () => removeOwnedTemporaryRootSync(temporaryRoot),
  );
  let primaryFailure: unknown;
  let report: Readonly<{
    environment: JsonMetric;
    metrics: Record<string, JsonMetric>;
  }> | undefined;

  try {
    await mkdir(join(temporaryRoot, "tmp"), { recursive: true });
    const environment = sourceMetadata(temporaryRoot);
    const artifact = await captureStage(async () => await measureCompiledGateway(temporaryRoot));
    const adapter = await captureStage(measureAdapterDeltaIngest);
    const fold = await captureStage(measurePureFoldReplay);
    const queue = await captureStage(async () => await measureProjectionQueue(temporaryRoot));
    const sqlite = await captureStage(async () =>
      await measureSqliteTransactions(temporaryRoot)
    );
    const browser = await captureStage(async () => await measureBrowserPaneUpdate(temporaryRoot));
    const sourceLifecycleUnsupportedReason =
      "Production gateway startup derives its control-plane root from userInfo().homedir. This harness cannot override that effective-OS-user boundary and refuses to touch the real account root, so startup, heap, and shutdown remain unmeasured until Phase 6 adds an explicit owned-state-root composition seam.";
    const phase6LifecycleDisposition =
      "Phase 6: add an explicit owned-state-root composition seam, then measure lifecycle.";

    report = {
      environment,
      metrics: {
        "gateway.compiled_artifact": projectStage(artifact, (value) => value),
        "gateway.source_startup": unsupported(
          sourceLifecycleUnsupportedReason,
          phase6LifecycleDisposition,
        ),
        "gateway.source_post_ready_gc_heap": unsupported(
          sourceLifecycleUnsupportedReason,
          phase6LifecycleDisposition,
        ),
        "gateway.source_shutdown": unsupported(
          sourceLifecycleUnsupportedReason,
          phase6LifecycleDisposition,
        ),
        "gateway.compiled_startup_and_heap": unsupported(
          "The compiled gateway resolves its state root from the effective OS user. The test-only homedir preload cannot be embedded without changing the measured artifact.",
          phase6LifecycleDisposition,
        ),
        "session.adapter_delta_ingest_10000": projectStage(adapter, (value) => value),
        "session.fold_replay_10000": projectStage(fold, (value) => value),
        "projection.queue_memory": projectStage(queue, (value) => value),
        "sqlite.delta_transactions_10000": projectStage(sqlite, (value) => value),
        "renderer.direct_bridge_requests": projectStage(browser, (value) =>
          objectField(value, "directBridge"), {
          containment: browser.status === "supported"
            ? objectField(browser.value, "containment")
            : undefined,
          workload: browser.status === "supported"
            ? objectField(browser.value, "workload")
            : undefined,
        }),
        "renderer.react_profiler_commits": projectStage(browser, (value) =>
          objectField(value, "react"), {
          containment: browser.status === "supported"
            ? objectField(browser.value, "containment")
            : undefined,
          workload: browser.status === "supported"
            ? objectField(browser.value, "workload")
            : undefined,
        }),
        "renderer.react_component_render_count": unsupported(
          "React Profiler reports commits, not an exhaustive count of production component invocations. The Direct harness observes one named pane selector subscriber, so that scoped probe cannot stand in for an all-component count.",
          "Add production component-level instrumentation and report either a total or per-component render count before comparing this metric.",
        ),
        "renderer.react_unrelated_selector_probe_render_count": projectStage(
          browser,
          (value) => objectField(
            objectField(value, "react"),
            "unrelatedSelectionRenders",
          ), {
          component: "UnrelatedPaneSelection",
          containment: browser.status === "supported"
            ? objectField(browser.value, "containment")
            : undefined,
          environment: "development-only Direct baseline probe",
          expected: 0,
          selector: "selectPane(unrelatedPaneId)",
          trigger: "real chat.pane.stateChanged event through RuntimeShell",
          workload: browser.status === "supported"
            ? objectField(browser.value, "workload")
            : undefined,
        }),
      },
    };
  } catch (reason: unknown) {
    primaryFailure = reason;
  }

  const cleanup = await captureStage(cleanupResources);
  uninstallSignalCleanup();
  if (primaryFailure !== undefined) {
    if (cleanup.status === "failed") {
      throw new AggregateError(
        [asError(primaryFailure), new Error(cleanup.error)],
        "The reactive baseline failed and cleanup also failed.",
      );
    }
    throw asError(primaryFailure);
  }
  if (report === undefined) throw new Error("The reactive baseline produced no report.");
  report.metrics["harness.cleanup"] = projectStage(cleanup, (value) => value);

  return {
    schema: BASELINE_SCHEMA,
    ok: Object.values(report.metrics).every((metric) => metric.status !== "failed"),
    generatedAt: new Date().toISOString(),
    environment: report.environment,
    metrics: report.metrics,
  };
}

try {
  const report = await run();
  console.log(JSON.stringify(report, null, 2));
  if (!report.ok) process.exitCode = 1;
} catch (reason: unknown) {
  console.log(JSON.stringify({
    schema: BASELINE_SCHEMA,
    ok: false,
    generatedAt: new Date().toISOString(),
    error: renderFailure(reason),
  }, null, 2));
  process.exitCode = 1;
}
