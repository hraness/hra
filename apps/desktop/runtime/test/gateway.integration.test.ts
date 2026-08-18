import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { HRA_HUMAN_KEYCHAIN_SERVICE } from "@hraness/hra-human-client";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  parseRuntimeEvent,
  parseRuntimeDispatchResponse,
  parseRuntimeDispatchTransportResponse,
  parseRuntimeSnapshotResponse,
  parseRuntimeTaskDispatchResponse,
  runtimeDispatchCommand,
  runtimeLocalDataRemovalConfirmation,
  runtimeProtocolVersion,
  runtimeSnapshotCommand,
  runtimeTaskMutationSemanticKey,
  type RuntimeDomainCommand,
  type RuntimeEvent,
  type RuntimeTaskDomainCommand,
} from "../../contracts/runtime";
import { hraReleaseIdentity } from "../release-identity";
import { accountProfileLayout } from "../src/accounts/profile-layout";
import { AccountProfileStore } from "../src/accounts/profile-store";
import {
  HRA_SESSION_SYNC_KEYCHAIN_NAME,
  HRA_SESSION_SYNC_KEYCHAIN_SERVICE,
  HRA_SESSION_SYNC_RECOVERY_KEYCHAIN_NAME,
} from "../src/cloud/session-sync-key-custody";
import {
  hostAccountProfileNativeResultCommand,
  hostHarnessCustodyNativeResultCommand,
  hostLocalDataRemovalNativeLaunchSchema,
  hostLocalDataRemovalNativeTerminationRequiredSchema,
  hostLocalDataRemovalRecoveryCommand,
  hostProjectOnboardingCommand,
} from "../src/host-protocol";
import {
  executeLocalDataRemovalFilesystemRequest,
  FileLocalDataRemovalReceiptStore,
  verifyLocalDataRemovalHelperRequest,
} from "../src/maintenance/local-data-removal";
import {
  canonicalHarnessInstallKeyEnvelope,
  HARNESS_INSTALL_MASTER_KEY_BYTES,
  harnessInstallKeyDescriptor,
  harnessLegacyInstallKeyDescriptor,
} from "../src/harness/key-custody";
import {
  fixedLocalDataRemovalPaths,
} from "../src/maintenance/local-data-removal-inventory";
import { resolveRuntimePaths } from "../src/runtime-paths";
import { acquireControlPlaneLifetimeLock } from "../src/state/control-plane-lock";
import { controlPlanePath, openControlPlane } from "../src/state/database";
import {
  loadOrCreateOperationReceiptKey,
  operationReceiptKeyPath,
} from "../src/state/operation-receipt-key";
import { DispatchRunnerInstallationStore } from "../src/state/dispatch-runner-installation";
import { ChatPaneStore } from "../src/state/chat-pane-store";
import { LocalTaskStore } from "../src/state/local-task-store";

const temporaryDirectories: string[] = [];
const gatewayFaultAppServer = fileURLToPath(
  new URL("./fixtures/gateway-fault-app-server.ts", import.meta.url),
);
const accountAppServer = fileURLToPath(
  new URL("./fixtures/account-app-server.ts", import.meta.url),
);
const effectiveUserHomePreload = fileURLToPath(
  new URL(
    "./fixtures/effective-user-home-preload.ts",
    import.meta.url,
  ),
);
const inMemorySecretsPreload = fileURLToPath(
  new URL("./fixtures/in-memory-secrets-preload.ts", import.meta.url),
);
const shutdownCleanupPreload = fileURLToPath(
  new URL("./fixtures/shutdown-cleanup-preload.ts", import.meta.url),
);
const startupRecoveryDelayPreload = fileURLToPath(
  new URL("./fixtures/startup-recovery-delay-preload.ts", import.meta.url),
);
const startupRecoverySeedFixture = fileURLToPath(
  new URL("./fixtures/startup-recovery-seed.ts", import.meta.url),
);

interface GatewaySpawnOptions {
  readonly cwd: string;
  readonly env: Record<string, string | undefined>;
  readonly testPreload?: string;
  readonly stdin: "pipe";
  readonly stdout: "pipe";
  readonly stderr: "pipe";
}

function spawnGatewayProcess(options: GatewaySpawnOptions) {
  const { testPreload, ...spawnOptions } = options;
  const harnessCustody = gatewayHarnessCustodyFixture(options.env);
  const child = Bun.spawn([
    process.execPath,
    "--preload",
    effectiveUserHomePreload,
    "--preload",
    inMemorySecretsPreload,
    ...(testPreload === undefined ? [] : ["--preload", testPreload]),
    "runtime/src/main.ts",
  ], {
    ...spawnOptions,
    env: {
      ...options.env,
      HRA_DATA_REMOVER_PATH:
        options.env.HRA_DATA_REMOVER_PATH ?? "/usr/bin/false",
      HRA_GATEWAY_TEST_EFFECTIVE_HOME: options.env.HOME,
      HRA_SOURCE_TEST_ALLOW_PATH_GIT: "1",
    },
  });
  gatewayHarnessCustodyResponders.set(
    child.stdout,
    gatewayHarnessCustodyResponder(child, harnessCustody),
  );
  return child;
}

type GatewayProcess = ReturnType<typeof spawnGatewayProcess>;

interface GatewayHarnessCustodyState {
  legacyPreserved: boolean;
  marker: "committed";
  reportMigratedOnNextRead: boolean;
  readonly trace: GatewayHarnessCustodyTraceEntry[];
  v1: string | null;
  v2: string | null;
}

interface GatewayHarnessCustodyFixture {
  readonly state: GatewayHarnessCustodyState;
}

interface GatewayHarnessCustodyTraceEntry {
  readonly absentV1: true;
  readonly absentV2: true;
  readonly action: "deleteBoth";
  readonly deletedV1: boolean;
  readonly deletedV2: boolean;
}

type GatewayOutputResponder = (line: unknown) => Promise<boolean>;

const gatewayHarnessCustodyStates = new Map<
  string,
  GatewayHarnessCustodyState
>();
const gatewayHarnessCustodyResponders = new WeakMap<
  ReadableStream<Uint8Array>,
  GatewayOutputResponder
>();

function gatewayHarnessCustodyFixture(
  environment: Readonly<Record<string, string | undefined>>,
): GatewayHarnessCustodyFixture {
  const home = environment.HOME;
  if (home === undefined || home.length === 0) {
    throw new TypeError("Gateway integration HOME must be explicit.");
  }
  let state = gatewayHarnessCustodyStates.get(home);
  if (state === undefined) {
    state = {
      legacyPreserved: false,
      marker: "committed",
      reportMigratedOnNextRead: false,
      trace: [],
      v1: null,
      v2: gatewayHarnessInstallKey,
    };
    gatewayHarnessCustodyStates.set(home, state);
  }
  return { state };
}

function gatewayHarnessCustodyTrace(
  home: string,
): readonly GatewayHarnessCustodyTraceEntry[] {
  return gatewayHarnessCustodyStates.get(home)?.trace ?? [];
}

interface GatewaySecretTraceEntry {
  readonly name: string;
  readonly operation: "delete" | "get" | "set";
  readonly result:
    | "deleted"
    | "missing"
    | "present"
    | "rejected"
    | "stored";
  readonly service: string;
}

const expectedHarnessNativeDeletion: GatewayHarnessCustodyTraceEntry = {
  absentV1: true,
  absentV2: true,
  action: "deleteBoth",
  deletedV1: false,
  deletedV2: true,
};
const gatewayHarnessInstallKey = canonicalHarnessInstallKeyEnvelope(
  JSON.stringify({
    version: 1,
    algorithm: "hkdf-sha256",
    key: Buffer.alloc(HARNESS_INSTALL_MASTER_KEY_BYTES, 0x5a).toString(
      "base64url",
    ),
  }),
);
const gatewayNativeRemovalCapability = "ab".repeat(32);

function localDataRemovalSecretFixture(root: string, label: string): {
  readonly env: Readonly<Record<string, string>>;
  readonly tracePath: string;
} {
  const tracePath = join(root, `${label}-secrets.jsonl`);
  return {
    env: {
      HRA_GATEWAY_TEST_SECRET_TRACE_PATH: tracePath,
    },
    tracePath,
  };
}

async function readGatewaySecretTrace(
  tracePath: string,
): Promise<readonly GatewaySecretTraceEntry[]> {
  const source = await readFile(tracePath, "utf8");
  return source.trim().split("\n").map((line) =>
    JSON.parse(line) as GatewaySecretTraceEntry
  );
}

function gatewayHarnessCustodyResponder(
  child: GatewayProcess,
  fixture: GatewayHarnessCustodyFixture,
): GatewayOutputResponder {
  return async (line) => {
    if (
      typeof line !== "object"
      || line === null
      || !("kind" in line)
      || line.kind !== "harnessCustodyNativeRequest"
    ) {
      return false;
    }
    if (
      !("version" in line)
      || line.version !== 1
      || !("request" in line)
      || typeof line.request !== "object"
      || line.request === null
      || Array.isArray(line.request)
    ) {
      throw new Error("malformed Harness custody Native request");
    }
    const request = line.request as Record<string, unknown>;
    const nativeRequestId = requiredString(request, "id");
    const binding = requiredString(request, "binding");
    const action = requiredString(request, "action");
    const now = Date.now();
    if (
      !/^native-harness-[a-f0-9]{24}$/u.test(nativeRequestId)
      || !/^binding_[a-f0-9]{48}$/u.test(binding)
      || !Number.isSafeInteger(request.deadlineUnixMilliseconds)
      || (request.deadlineUnixMilliseconds as number) <= now
      || (request.deadlineUnixMilliseconds as number) > now + 50_000
    ) {
      throw new Error("unbound Harness custody Native request");
    }

    const responseBase = {
      kind: "harnessCustodyNativeResult",
      version: 1,
      nativeRequestId,
      binding,
    } as const;
    let payload: Record<string, unknown>;
    if (action === "read") {
      if (Object.keys(request).sort().join("\0") !==
        "action\0binding\0deadlineUnixMilliseconds\0id") {
        throw new Error("Harness custody read carried extra authority");
      }
      if (fixture.state.v2 === null && fixture.state.v1 !== null) {
        fixture.state.v2 = fixture.state.v1;
        fixture.state.legacyPreserved = true;
        fixture.state.reportMigratedOnNextRead = true;
      }
      if (
        fixture.state.v1 !== null
        && fixture.state.v2 !== null
        && fixture.state.v1 !== fixture.state.v2
      ) {
        payload = { ...responseBase, action, ok: false };
      } else if (fixture.state.v2 === null) {
        payload = {
          ...responseBase,
          action,
          ok: true,
          state: "absent",
          value: null,
          migratedFromLegacy: false,
          legacyPreserved: false,
        };
      } else {
        const migratedFromLegacy = fixture.state.reportMigratedOnNextRead;
        fixture.state.reportMigratedOnNextRead = false;
        payload = {
          ...responseBase,
          action,
          ok: true,
          state: "present",
          value: fixture.state.v2,
          migratedFromLegacy,
          legacyPreserved: fixture.state.legacyPreserved,
        };
      }
    } else if (action === "setIfAbsent") {
      if (Object.keys(request).sort().join("\0") !==
        "action\0binding\0deadlineUnixMilliseconds\0id\0value") {
        throw new Error("Harness custody set request is malformed");
      }
      const requestedValue = canonicalHarnessInstallKeyEnvelope(
        requiredString(request, "value"),
      );
      const created = fixture.state.v2 === null;
      if (fixture.state.v2 !== null && fixture.state.v2 !== requestedValue) {
        payload = { ...responseBase, action, ok: false };
      } else {
        fixture.state.v2 ??= requestedValue;
        payload = {
          ...responseBase,
          action,
          ok: true,
          value: fixture.state.v2,
          created,
        };
      }
    } else if (action === "deleteBoth") {
      if (
        Object.keys(request).sort().join("\0") !==
          "action\0binding\0deadlineUnixMilliseconds\0id\0operationId\0previewId\0removalCapability"
        || !/^op_[A-Za-z0-9_-]{7,93}$/u.test(
          requiredString(request, "operationId"),
        )
        || !/^removal_[A-Za-z0-9_-]{7,88}$/u.test(
          requiredString(request, "previewId"),
        )
        || !/^[a-f0-9]{64}$/u.test(
          requiredString(request, "removalCapability"),
        )
      ) {
        throw new Error("Harness custody deletion lacked Native authority");
      }
      const deletedV1 = fixture.state.v1 !== null;
      const deletedV2 = fixture.state.v2 !== null;
      fixture.state.v1 = null;
      fixture.state.v2 = null;
      fixture.state.legacyPreserved = false;
      fixture.state.marker = "committed";
      fixture.state.reportMigratedOnNextRead = false;
      fixture.state.trace.push({
        absentV1: true,
        absentV2: true,
        action,
        deletedV1,
        deletedV2,
      });
      payload = {
        ...responseBase,
        action,
        ok: true,
        deletedV1,
        deletedV2,
        absentV1: true,
        absentV2: true,
      };
    } else {
      throw new Error("unsupported Harness custody Native action");
    }

    await child.stdin.write(`${JSON.stringify({
      id: `custody-result:${nativeRequestId}`,
      command: hostHarnessCustodyNativeResultCommand,
      payload,
    })}\n`);
    return true;
  };
}

function expectRemovalLaunch(
  value: unknown,
  description: string,
): ReturnType<typeof hostLocalDataRemovalNativeLaunchSchema.parse> {
  const termination = hostLocalDataRemovalNativeTerminationRequiredSchema
    .safeParse(value);
  if (termination.success) {
    throw new Error(
      `${description} returned a termination envelope: ${JSON.stringify(termination.data.publicResponse)}`,
    );
  }
  return hostLocalDataRemovalNativeLaunchSchema.parse(value);
}

interface TrackedTestProcess {
  readonly exitCode: number | null;
  readonly exited: Promise<number>;
  kill(signal?: number | NodeJS.Signals): void;
}

interface BoundedUtf8Collection {
  cancel(reason: string): Promise<void>;
  observedBytes(): number;
  readonly text: Promise<string>;
}

const compilerOutputLimitBytes = 256 * 1_024;
const gatewayDiagnosticLimitBytes = 256 * 1_024;
const processCleanupTimeoutMs = 2_000;
const directoryCleanupTimeoutMs = 10_000;
const activeTestProcesses = new Set<TrackedTestProcess>();

function trackTestProcess<Child extends TrackedTestProcess>(child: Child): Child {
  activeTestProcesses.add(child);
  void child.exited.finally(() => {
    activeTestProcesses.delete(child);
  }).catch(() => undefined);
  return child;
}

function spawnGateway(options: GatewaySpawnOptions): GatewayProcess {
  return trackTestProcess(spawnGatewayProcess(options));
}

function asError(reason: unknown): Error {
  return reason instanceof Error ? reason : new Error(String(reason));
}

function isUnknownRecord(
  value: unknown,
): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasStringFields(
  value: unknown,
  expected: Readonly<Record<string, string>>,
): boolean {
  return isUnknownRecord(value) && Object.entries(expected).every(
    ([key, expectedValue]) => value[key] === expectedValue,
  );
}

async function completeWithin<Value>(
  task: Promise<Value>,
  timeoutMs: number,
  timeoutError: Error,
): Promise<Value> {
  void task.catch(() => undefined);
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => reject(timeoutError), timeoutMs);
  });
  try {
    return await Promise.race([task, deadline]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

async function settleWithin(
  task: Promise<unknown>,
  timeoutMs: number,
  description: string,
): Promise<void> {
  const settlement = task.then(
    () => undefined,
    () => undefined,
  );
  await completeWithin(
    settlement,
    timeoutMs,
    new Error(`${description} did not settle within ${String(timeoutMs)}ms.`),
  );
}

async function terminateTestProcessWithin(
  child: TrackedTestProcess,
  description: string,
): Promise<number> {
  const failures: Error[] = [];
  if (child.exitCode === null) {
    try {
      child.kill("SIGKILL");
    } catch (reason: unknown) {
      failures.push(asError(reason));
    }
  }

  let exitCode: number | undefined;
  try {
    exitCode = await completeWithin(
      child.exited,
      processCleanupTimeoutMs,
      new Error(
        `${description} did not exit within ${String(processCleanupTimeoutMs)}ms after SIGKILL.`,
      ),
    );
  } catch (reason: unknown) {
    failures.push(asError(reason));
  }

  if (failures.length > 0) {
    throw new AggregateError(failures, `${description} cleanup failed.`);
  }
  return exitCode!;
}

function collectBoundedUtf8(
  stream: ReadableStream<Uint8Array>,
  maximumBytes: number,
  description: string,
): BoundedUtf8Collection {
  const reader = stream.getReader();
  let cancellation: Promise<void> | undefined;
  let locked = true;
  let observedBytes = 0;
  const text = (async () => {
    const decoder = new TextDecoder();
    let output = "";
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        observedBytes += next.value.byteLength;
        if (observedBytes > maximumBytes) {
          throw new Error(
            `${description} exceeded its ${String(maximumBytes)}-byte limit.`,
          );
        }
        output += decoder.decode(next.value, { stream: true });
      }
      return output + decoder.decode();
    } finally {
      locked = false;
      reader.releaseLock();
    }
  })();
  void text.catch(() => undefined);
  return {
    cancel: async (reason) => {
      cancellation ??= locked ? reader.cancel(reason) : stream.cancel(reason);
      await cancellation;
    },
    observedBytes: () => observedBytes,
    text,
  };
}

afterEach(async () => {
  const active = [...activeTestProcesses];
  const directories = temporaryDirectories.splice(0);
  const processCleanup = await Promise.allSettled(
    active.map(async (child, index) => {
      await terminateTestProcessWithin(child, `Gateway test process ${String(index + 1)}`);
    }),
  );
  const directoryCleanup = await Promise.allSettled(
    directories.map(async (path) => {
      await completeWithin(
        rm(path, { recursive: true, force: true }),
        directoryCleanupTimeoutMs,
        new Error(
          `Gateway test directory cleanup exceeded ${String(directoryCleanupTimeoutMs)}ms: ${path}`,
        ),
      );
    }),
  );
  const failures = [...processCleanup, ...directoryCleanup].flatMap((result) =>
    result.status === "rejected" ? [asError(result.reason)] : []
  );
  if (failures.length > 0) {
    throw new AggregateError(failures, "Gateway integration test cleanup failed.");
  }
  gatewayHarnessCustodyStates.clear();
}, 20_000);

function collectClosedFixtureDatabaseReferences(): void {
  // Bun may retain finalized SQLite statement wrappers until collection.
  // Release fixture-only descriptors before a separate gateway process
  // performs its fail-closed Application Support open-file inspection.
  Bun.gc(true);
}

async function collectCompilerWithin(
  child: Readonly<{
    exitCode: number | null;
    exited: Promise<number>;
    kill(signal?: number | NodeJS.Signals): void;
    stderr: ReadableStream<Uint8Array>;
    stdout: ReadableStream<Uint8Array>;
  }>,
  timeoutMs: number,
  description = "Gateway fault-fixture compiler",
): Promise<Readonly<{ exitCode: number; stderr: string; stdout: string }>> {
  const stdout = collectBoundedUtf8(
    child.stdout,
    compilerOutputLimitBytes,
    `${description} stdout`,
  );
  const stderr = collectBoundedUtf8(
    child.stderr,
    compilerOutputLimitBytes,
    `${description} stderr`,
  );
  const stdoutTask = stdout.text;
  const stderrTask = stderr.text;
  const completed = Promise.all([stdoutTask, stderrTask, child.exited]);
  void completed.catch(() => undefined);
  const timeoutError = new Error(
    `${description} exceeded ${String(timeoutMs)}ms`,
  );
  try {
    const [stdoutText, stderrText, exitCode] = await completeWithin(
      completed,
      timeoutMs,
      timeoutError,
    );
    return { exitCode, stderr: stderrText, stdout: stdoutText };
  } catch (reason: unknown) {
    const failure = reason === timeoutError
      ? new Error(
          `${timeoutError.message}; stdoutBytes=${String(stdout.observedBytes())}; stderrBytes=${String(stderr.observedBytes())}`,
        )
      : asError(reason);
    const cleanup = await Promise.allSettled([
      terminateTestProcessWithin(child, description),
      completeWithin(
        stdout.cancel(`${description} cleanup`),
        processCleanupTimeoutMs,
        new Error(`${description} stdout cancellation timed out.`),
      ),
      completeWithin(
        stderr.cancel(`${description} cleanup`),
        processCleanupTimeoutMs,
        new Error(`${description} stderr cancellation timed out.`),
      ),
      settleWithin(
        stdoutTask,
        processCleanupTimeoutMs,
        `${description} stdout`,
      ),
      settleWithin(
        stderrTask,
        processCleanupTimeoutMs,
        `${description} stderr`,
      ),
    ]);
    const cleanupFailures = cleanup.flatMap((result) =>
      result.status === "rejected" ? [asError(result.reason)] : []
    );
    if (cleanupFailures.length > 0) {
      throw new AggregateError(
        [failure, ...cleanupFailures],
        `${description} failed and cleanup reported additional errors.`,
      );
    }
    throw failure;
  }
}

class GatewayOutputReader {
  readonly #reader: ReadableStreamDefaultReader<Uint8Array>;
  readonly #decoder = new TextDecoder();
  readonly #lines: unknown[] = [];
  #buffer = "";
  #done = false;
  readonly #onLine: GatewayOutputResponder | undefined;

  constructor(
    stream: ReadableStream<Uint8Array>,
    onLine?: GatewayOutputResponder,
  ) {
    this.#reader = stream.getReader();
    const custodyResponder = gatewayHarnessCustodyResponders.get(stream);
    this.#onLine = custodyResponder === undefined
      ? onLine
      : onLine === undefined
      ? custodyResponder
      : async (line) => {
          if (await custodyResponder(line)) return true;
          return await onLine(line);
        };
  }

  currentLines(): readonly unknown[] {
    return this.#lines;
  }

  async cancel(reason: string): Promise<void> {
    await this.#reader.cancel(reason);
  }

  async readUntil(
    predicate: (lines: readonly unknown[]) => boolean,
    description: string,
  ): Promise<void> {
    while (!predicate(this.#lines)) {
      if (!await this.#readLine()) {
        throw new Error(`Gateway stdout closed before ${description}`);
      }
    }
  }

  async readToEnd(): Promise<readonly unknown[]> {
    while (await this.#readLine()) {
      // Drain the remaining gateway output after the state-based join gate.
    }
    return this.#lines;
  }

  async #readLine(): Promise<boolean> {
    while (true) {
      const newline = this.#buffer.indexOf("\n");
      if (newline >= 0) {
        const line = this.#buffer.slice(0, newline).trim();
        this.#buffer = this.#buffer.slice(newline + 1);
        if (line.length === 0) continue;
        const parsed = JSON.parse(line) as unknown;
        if (await this.#onLine?.(parsed) === true) continue;
        this.#lines.push(parsed);
        return true;
      }

      if (this.#done) {
        const line = this.#buffer.trim();
        this.#buffer = "";
        if (line.length === 0) return false;
        const parsed = JSON.parse(line) as unknown;
        if (await this.#onLine?.(parsed) === true) return false;
        this.#lines.push(parsed);
        return true;
      }

      const next = await this.#reader.read();
      if (next.done) {
        this.#done = true;
        this.#buffer += this.#decoder.decode();
      } else {
        this.#buffer += this.#decoder.decode(next.value, { stream: true });
      }
    }
  }
}

async function readGatewayOutputWithin(
  child: GatewayProcess,
  output: GatewayOutputReader,
  predicate: (lines: readonly unknown[]) => boolean,
  description: string,
  timeoutMs: number,
): Promise<void> {
  const read = output.readUntil(predicate, description);
  // When the deadline wins, process cleanup closes stdout after this helper
  // has already selected its timeout result. Observe that losing rejection so
  // Bun reports one startup failure instead of a second unhandled read error.
  void read.catch(() => undefined);

  const timeoutError = new Error(
    `Gateway output did not include ${description} within ${timeoutMs}ms`,
  );
  try {
    await completeWithin(read, timeoutMs, timeoutError);
  } catch (error: unknown) {
    if (error !== timeoutError) {
      const stderr = collectBoundedUtf8(
        child.stderr,
        gatewayDiagnosticLimitBytes,
        "Early-exit gateway stderr",
      );
      const cleanup = await Promise.allSettled([
        terminateTestProcessWithin(child, "Early-exit gateway process"),
        completeWithin(
          stderr.text,
          processCleanupTimeoutMs,
          new Error("Early-exit gateway stderr did not close."),
        ),
        settleWithin(
          read,
          processCleanupTimeoutMs,
          "Early-exit gateway stdout read",
        ),
      ]);
      const cleanupFailures = cleanup.flatMap((result) =>
        result.status === "rejected" ? [asError(result.reason)] : []
      );
      const exitCode = cleanup[0]?.status === "fulfilled"
        ? String(cleanup[0].value)
        : "unreaped";
      const stderrText = cleanup[1]?.status === "fulfilled"
        ? cleanup[1].value
        : "";
      const failure = new Error(
        `${asError(error).message}; exit=${exitCode}; stderrBytes=${String(stderr.observedBytes())}; stderr=${JSON.stringify(stderrText)}`,
        { cause: error },
      );
      if (cleanupFailures.length > 0) {
        throw new AggregateError(
          [failure, ...cleanupFailures],
          "Gateway stdout closed early and cleanup reported additional errors.",
        );
      }
      throw failure;
    }

    const stderr = collectBoundedUtf8(
      child.stderr,
      gatewayDiagnosticLimitBytes,
      "Gateway timeout stderr",
    );
    const cleanup = await Promise.allSettled([
      terminateTestProcessWithin(child, "Timed-out gateway process"),
      completeWithin(
        output.cancel("Gateway output deadline exceeded"),
        processCleanupTimeoutMs,
        new Error("Gateway stdout cancellation timed out."),
      ),
      completeWithin(
        stderr.text,
        processCleanupTimeoutMs,
        new Error("Gateway stderr did not close after SIGKILL."),
      ),
      settleWithin(
        read,
        processCleanupTimeoutMs,
        "Gateway stdout read",
      ),
    ]);
    const cleanupFailures = cleanup.flatMap((result) =>
      result.status === "rejected" ? [asError(result.reason)] : []
    );
    if (cleanup[2]?.status === "rejected") {
      const stderrCleanup = await Promise.allSettled([
        completeWithin(
          stderr.cancel("Gateway timeout cleanup"),
          processCleanupTimeoutMs,
          new Error("Gateway stderr cancellation timed out."),
        ),
        settleWithin(
          stderr.text,
          processCleanupTimeoutMs,
          "Gateway stderr read",
        ),
      ]);
      cleanupFailures.push(...stderrCleanup.flatMap((result) =>
        result.status === "rejected" ? [asError(result.reason)] : []
      ));
    }

    const exitCode = cleanup[0]?.status === "fulfilled"
      ? String(cleanup[0].value)
      : "unreaped";
    const failure = new Error(
      `${timeoutError.message}; exit=${exitCode}; stderrBytes=${String(stderr.observedBytes())}`,
    );
    if (cleanupFailures.length > 0) {
      throw new AggregateError(
        [failure, ...cleanupFailures],
        "Gateway output deadline expired and cleanup reported additional errors.",
      );
    }
    throw failure;
  }
}

function accountProfileNativeResponder(
  child: GatewayProcess,
  expectedControlPlanePath: string,
): GatewayOutputResponder {
  return async (line) => {
    if (
      typeof line !== "object"
      || line === null
      || !("kind" in line)
      || line.kind !== "accountProfileNativeRequest"
    ) {
      return false;
    }
    if (
      !("version" in line)
      || line.version !== 1
      || !("request" in line)
      || typeof line.request !== "object"
      || line.request === null
    ) {
      throw new Error("malformed account-profile Native request");
    }
    const request = line.request as Record<string, unknown>;
    const id = requiredString(request, "id");
    const binding = requiredString(request, "binding");
    const action = requiredString(request, "action");
    const accountProfileId = requiredString(request, "accountProfileId");
    const requestedControlPlanePath = requiredString(
      request,
      "controlPlanePath",
    );
    if (
      !/^native-profile-[a-f0-9]{24}$/u.test(id)
      || !/^binding_[a-f0-9]{48}$/u.test(binding)
      || (action !== "ensure" && action !== "delete")
      || requestedControlPlanePath !== expectedControlPlanePath
    ) {
      throw new Error("unbound account-profile Native request");
    }
    for (const key of [
      "stateRootDevice",
      "stateRootInode",
      "controlPlaneDevice",
      "controlPlaneInode",
    ]) {
      if (!/^[1-9][0-9]{0,19}$/u.test(requiredString(request, key))) {
        throw new Error("invalid account-profile filesystem identity");
      }
    }
    const layout = accountProfileLayout(
      requestedControlPlanePath,
      accountProfileId,
    );
    if (action === "ensure") {
      if (
        "deletionNonce" in request
        || "expectedRevision" in request
      ) {
        throw new Error("ensure request carried deletion authority");
      }
      for (const path of [
        layout.stateRoot,
        join(layout.stateRoot, "codex"),
        layout.accountsRoot,
        layout.profileRoot,
        layout.codexHome,
        layout.runtimeDirectory,
      ]) {
        await mkdir(path, { recursive: true, mode: 0o700 });
        await chmod(path, 0o700);
      }
    } else {
      if (
        !/^deletion_[a-f0-9]{64}$/u.test(
          requiredString(request, "deletionNonce"),
        )
        || !Number.isSafeInteger(request.expectedRevision)
        || (request.expectedRevision as number) < 1
      ) {
        throw new Error("delete request lacked durable authorization");
      }
      await rm(layout.codexHome, { recursive: true, force: true });
    }
    await child.stdin.write(`${JSON.stringify({
      id,
      command: hostAccountProfileNativeResultCommand,
      payload: {
        kind: "accountProfileNativeResult",
        version: 1,
        nativeRequestId: id,
        binding,
        action,
        accountProfileId,
        ok: true,
      },
    })}\n`);
    return true;
  };
}

function requiredString(
  value: Readonly<Record<string, unknown>>,
  key: string,
): string {
  const result = value[key];
  if (typeof result !== "string" || result.length === 0) {
    throw new Error(`account-profile request ${key} must be a string`);
  }
  return result;
}

function runtimeEvents(lines: readonly unknown[]): RuntimeEvent[] {
  const events: RuntimeEvent[] = [];
  for (const line of lines) {
    try {
      events.push(parseRuntimeEvent(line));
    } catch {
      // Host responses share stdout with renderer events.
    }
  }
  return events;
}

function bridgeResult(lines: readonly unknown[], id: string): unknown {
  for (const line of lines) {
    if (typeof line !== "object" || line === null || !("id" in line) || line.id !== id) continue;
    if (!("ok" in line) || line.ok !== true || !("result" in line)) {
      throw new Error(`Bridge request ${id} failed: ${JSON.stringify(line)}`);
    }
    return line.result;
  }
  throw new Error(`Bridge response ${id} was not found`);
}

function expectContinuousSequences(events: readonly RuntimeEvent[]): void {
  expect(events.map(({ sequence }) => sequence)).toEqual(
    events.map((_, index) => index + 1),
  );
}

function accountsAreReady(
  lines: readonly unknown[],
  accountIds: readonly string[],
): boolean {
  const latestAccounts = new Map<string, Extract<RuntimeEvent["event"], {
    type: "account.upserted";
  }>["account"]>();
  for (const { event } of runtimeEvents(lines)) {
    if (event.type === "account.upserted") {
      latestAccounts.set(event.account.id, event.account);
    }
  }
  return accountIds.every((accountId) => {
    const account = latestAccounts.get(accountId);
    return account?.runtime.state === "ready" &&
      account.authState === "signedIn" &&
      account.identityLabel !== null;
  });
}

function snapshotRequest(id: string): string {
  return `${JSON.stringify({
    id,
    command: runtimeSnapshotCommand,
    payload: { version: runtimeProtocolVersion },
  })}\n`;
}

function dispatchRequest(
  id: string,
  operationId: string,
  command: RuntimeDomainCommand,
): string {
  return `${JSON.stringify({
    id,
    command: runtimeDispatchCommand,
    payload: { version: runtimeProtocolVersion, operationId, command },
    ...(command.type === "maintenance.localDataRemoval.remove"
      ? { nativeRemovalCapability: gatewayNativeRemovalCapability }
      : {}),
  })}\n`;
}

function taskDispatchRequest(
  id: string,
  operationId: string,
  command: RuntimeTaskDomainCommand,
): string {
  return `${JSON.stringify({
    id,
    command: runtimeDispatchCommand,
    payload: { version: runtimeProtocolVersion, operationId, command },
  })}\n`;
}

function projectOnboardingRequest(
  id: string,
  trustedDirectoryPath: string,
  workspaceName: string,
): string {
  return `${JSON.stringify({
    id,
    command: hostProjectOnboardingCommand,
    payload: {
      version: runtimeProtocolVersion,
      trustedDirectoryPath,
      workspaceName,
    },
  })}\n`;
}

function localDataRemovalRecoveryRequest(id: string): string {
  return `${JSON.stringify({
    id,
    command: hostLocalDataRemovalRecoveryCommand,
    nativeRemovalCapability: gatewayNativeRemovalCapability,
    payload: { version: 1, nativeRecoveryPrepared: true },
  })}\n`;
}

function dispatchContinuationRequest(
  id: string,
  operationId: string,
  transferId: string,
  index: number,
): string {
  return `${JSON.stringify({
    id,
    command: runtimeDispatchCommand,
    payload: {
      version: runtimeProtocolVersion,
      operationId,
      transferId,
      index,
    },
  })}\n`;
}

function hasBridgeResult(lines: readonly unknown[], id: string): boolean {
  return lines.some((line) =>
    typeof line === "object" &&
    line !== null &&
    "id" in line &&
    line.id === id
  );
}

function hasRuntimeState(
  lines: readonly unknown[],
  state: "ready" | "failed",
): boolean {
  return runtimeEvents(lines).some(({ event }) =>
    event.type === "runtime.changed" && event.runtime.state === state
  );
}

function hasCompletedLocalRunnerRecovery(lines: readonly unknown[]): boolean {
  return runtimeEvents(lines).some(({ event }) =>
    event.type === "runner.changed" && event.runner.state !== "recovering"
  );
}

function publicId(prefix: string, value: number): string {
  const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  let remaining = value;
  let locator = "";
  for (let index = 0; index < 26; index += 1) {
    locator = (alphabet[remaining % 32] ?? "0") + locator;
    remaining = Math.floor(remaining / 32);
  }
  return `${prefix}_${locator}`;
}

async function installFakeGit(root: string): Promise<Readonly<{
  gitBinary: string;
  gitRoot: string;
  invocationLog: string;
}>> {
  const gitRoot = join(root, "fixture-git");
  const gitBinary = join(gitRoot, "bin", "git");
  const invocationLog = join(gitRoot, "invocations.log");
  const fixtureCommit = "a".repeat(40);
  const quotedInvocationLog = `'${invocationLog.replaceAll("'", "'\\''")}'`;
  await mkdir(join(gitRoot, "bin"), { recursive: true });
  await writeFile(gitBinary, [
    "#!/bin/sh",
    "while [ \"$#\" -gt 0 ]; do",
    "  case \"$1\" in",
    "    --no-replace-objects|--no-pager|--no-optional-locks) shift ;;",
    "    -c) shift 2 ;;",
    "    *) break ;;",
    "  esac",
    "done",
    `printf '%s\\n' "$*" >> ${quotedInvocationLog}`,
    "if [ \"$1\" = \"config\" ]; then exit 0; fi",
    "case \"$1:$2\" in",
    "  --version:) printf 'git version 2.53.0\\n' ;;",
    "  rev-parse:--show-toplevel) pwd -P ;;",
    "  rev-parse:--git-common-dir)",
    "    if [ -d .git ]; then printf '%s/.git\\n' \"$(pwd -P)\"; exit 0; fi",
    "    gitdir=$(sed -n 's/^gitdir: //p' .git)",
    "    [ -n \"$gitdir\" ] || exit 1",
    "    (cd \"$gitdir/../..\" && pwd -P)",
    "    ;;",
    "  rev-parse:--git-dir)",
    "    if [ -d .git ]; then printf '%s/.git\\n' \"$(pwd -P)\"; exit 0; fi",
    "    sed -n 's/^gitdir: //p' .git",
    "    ;;",
    "  rev-parse:--verify)",
    `    if [ "$3" = "HEAD^{commit}" ]; then printf '${fixtureCommit}\\n'; else printf '%s\\n' "$3" | sed 's/\\^{commit}$//'; fi`,
    "    ;;",
    "  show-ref:--verify) exit 1 ;;",
    "  worktree:add)",
    "    repository=$(pwd -P)",
    '    if [ "$3" = "--no-track" ] && [ "$4" = "-b" ]; then',
    '      branch=$5; checkout=$6; base=$7',
    "    else",
    '      checkout=$3; branch=$4; base=$4',
    "    fi",
    '    lane=$(basename "$checkout")',
    '    mkdir -p "$checkout" "$repository/.git/worktrees/$lane"',
    '    printf "gitdir: %s/.git/worktrees/%s\\n" "$repository" "$lane" > "$checkout/.git"',
    '    printf "%s\\n" "$branch" > "$checkout/.fixture-branch"',
    '    printf "%s\\n" "$base" > "$checkout/.fixture-base"',
    "    ;;",
    "  branch:--show-current) cat .fixture-branch ;;",
    "  status:--porcelain=v1)",
    "    [ ! -f .fixture-dirty ] || printf ' M .fixture-dirty\\n'",
    "    ;;",
    "  *) printf 'unsupported fixture git command\\n' >&2; exit 1 ;;",
    "esac",
    "",
  ].join("\n"), { mode: 0o700 });
  await chmod(gitBinary, 0o700);
  return { gitBinary, gitRoot, invocationLog };
}

async function installFakeDataRemover(root: string): Promise<string> {
  const executable = join(root, "oprte-data-remover");
  await writeFile(executable, [
    "#!/bin/sh",
    "if [ \"$1\" = \"recover-staged\" ]; then exit 0; fi",
    "exit 64",
    "",
  ].join("\n"), { mode: 0o700 });
  await chmod(executable, 0o700);
  return await realpath(executable);
}

interface GatewayAuthorityState {
  readonly dispatchInstallation: Readonly<{
    installation_id: string;
    runner_public_id: string;
    boot_id: string;
    boot_generation: number;
    accepted_heartbeat_sequence: number;
  }>;
  readonly localInstallation: Readonly<{
    installation_id: string;
    created_at: number;
    updated_at: number;
  }>;
  readonly migrationCount: number;
  readonly receiptCount: number;
}

function readGatewayAuthorityState(root: string): GatewayAuthorityState {
  const database = new Database(controlPlanePath(root), {
    readonly: true,
    strict: true,
  });
  try {
    const dispatchInstallation = database.query<
      GatewayAuthorityState["dispatchInstallation"],
      []
    >(`
      SELECT installation_id, runner_public_id, boot_id, boot_generation,
        accepted_heartbeat_sequence
      FROM dispatch_runner_installation WHERE singleton = 1
    `).get();
    const localInstallation = database.query<
      GatewayAuthorityState["localInstallation"],
      []
    >(`
      SELECT installation_id, created_at, updated_at
      FROM local_installations
      WHERE installation_id = (
        SELECT installation_id
        FROM dispatch_runner_installation
        WHERE singleton = 1
      )
    `).get();
    const migrationCount = database.query<{ count: number }, []>(
      "SELECT COUNT(*) AS count FROM schema_migrations",
    ).get()?.count;
    const receiptCount = database.query<{ count: number }, []>(
      "SELECT COUNT(*) AS count FROM operation_receipts",
    ).get()?.count;
    if (
      dispatchInstallation === null ||
      localInstallation === null ||
      migrationCount === undefined ||
      receiptCount === undefined
    ) {
      throw new Error("Gateway authority fixture is incomplete");
    }
    return {
      dispatchInstallation,
      localInstallation,
      migrationCount,
      receiptCount,
    };
  } finally {
    database.close();
  }
}

describe("compiled gateway boundary", () => {
  test(
    "exits a transiently failed initialization so Native can restart a fresh generation",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "oprte-gateway-init-fault-"));
      temporaryDirectories.push(root);
      const blockedHome = join(root, "home-is-a-file");
      await writeFile(blockedHome, "not a directory");
      const paths = await installFakeGit(root);
      const child = spawnGateway({
        cwd: join(import.meta.dir, "..", ".."),
        env: {
          HOME: blockedHome,
          HRA_CODEX_BIN: process.execPath,
          HRA_GIT_BIN: paths.gitBinary,
          HRA_GIT_ROOT: paths.gitRoot,
          PATH: "/usr/bin:/bin",
          TMPDIR: process.env.TMPDIR ?? tmpdir(),
        },
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      });
      const output = new GatewayOutputReader(child.stdout);
      const [lines, stderr, exitCode] = await Promise.all([
        output.readToEnd(),
        new Response(child.stderr).text(),
        completeWithin(
          child.exited,
          10_000,
          new Error("Initialization-fault gateway stayed alive."),
        ),
      ]);

      expect(exitCode).not.toBe(0);
      expect(hasRuntimeState(lines, "failed")).toBeFalse();
      expect(stderr.length).toBeGreaterThan(0);
    },
    15_000,
  );

  test(
    "routes two account processes without crossing identity, limits, or homes",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "oprte-gateway-accounts-"));
      temporaryDirectories.push(root);
      const codexBinary = join(root, "account-app-server");
      const paths = await installFakeGit(root);
      const compile = trackTestProcess(Bun.spawn(
        [process.execPath, "build", "--compile", accountAppServer, "--outfile", codexBinary],
        { stdout: "pipe", stderr: "pipe" },
      ));
      const compiled = await collectCompilerWithin(compile, 45_000);
      if (compiled.exitCode !== 0) {
        throw new Error(
          `failed to compile account fixture: ${compiled.stdout}${compiled.stderr}`,
        );
      }

      const accountIds = ["acct_gateway_0001", "acct_gateway_0002"] as const;
      const state = openControlPlane(controlPlanePath(root), {
        releaseIdentity: hraReleaseIdentity,
      });
      try {
        const remainingIds = [...accountIds];
        const store = new AccountProfileStore(state, {
          idFactory: () => {
            const id = remainingIds.shift();
            if (id === undefined) throw new Error("account fixture IDs exhausted");
            return id;
          },
        });
        store.create("First");
        store.create("Second");
      } finally {
        state.close();
      }
      collectClosedFixtureDatabaseReferences();

      const child = spawnGateway({
        cwd: join(import.meta.dir, "..", ".."),
        env: {
          HOME: root,
          HRA_CODEX_BIN: codexBinary,
          HRA_GIT_BIN: paths.gitBinary,
          HRA_GIT_ROOT: paths.gitRoot,
          PATH: "/usr/bin:/bin",
          TMPDIR: process.env.TMPDIR ?? tmpdir(),
        },
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      });
      const output = new GatewayOutputReader(
        child.stdout,
        accountProfileNativeResponder(
          child,
          await realpath(controlPlanePath(root)),
        ),
      );
      await Promise.all(accountIds.map(async (accountProfileId, index) => {
        await child.stdin.write(dispatchRequest(
          `bridge-refresh-${String(index + 1)}`,
          `op_refresh_000${String(index + 1)}`,
          { type: "account.refresh", accountProfileId },
        ));
      }));
      await output.readUntil(
        (lines) => accountsAreReady(lines, accountIds),
        "both account projections became ready",
      );
      await child.stdin.write(snapshotRequest("bridge-accounts"));
      await child.stdin.end();

      const [lines, stderr, exitCode] = await Promise.all([
        output.readToEnd(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      expect(stderr).toBe("");
      expect(exitCode).toBe(0);
      const events = runtimeEvents(lines);
      expectContinuousSequences(events);
      const firstResponse = parseRuntimeDispatchResponse(
        bridgeResult(lines, "bridge-refresh-1"),
      );
      const secondResponse = parseRuntimeDispatchResponse(
        bridgeResult(lines, "bridge-refresh-2"),
      );
      expect(firstResponse).toMatchObject({
        ok: true,
        result: { type: "accepted" },
      });
      expect(secondResponse).toMatchObject({
        ok: true,
        result: { type: "accepted" },
      });
      const snapshot = parseRuntimeSnapshotResponse(
        bridgeResult(lines, "bridge-accounts"),
      ).snapshot;
      const accounts = new Map(snapshot.accounts.map((account) => [account.id, account]));
      expect(accounts.get(accountIds[0])).toMatchObject({
        identityLabel: "0001@example.test",
        planLabel: "Plus",
        runtime: { state: "ready", generation: 1 },
      });
      expect(accounts.get(accountIds[1])).toMatchObject({
        identityLabel: "0002@example.test",
        planLabel: "Pro",
        runtime: { state: "ready", generation: 1 },
      });
      for (const account of accounts.values()) {
        expect(account).not.toHaveProperty("usage");
        expect(account).not.toHaveProperty("models");
      }
      const rendererVisible = JSON.stringify({
        events,
        firstResponse,
        secondResponse,
        snapshot,
      });
      expect(rendererVisible).not.toContain(root);
      expect(rendererVisible).not.toContain("CODEX_HOME");
    },
    // This proof boots two compiled gateways serially. On the repository-wide
    // lane they contend with other real-process integration suites, so give
    // process startup the same bounded shared-runner budget as native helper
    // compilation while keeping every product deadline unchanged.
    165_000,
  );

  test(
    "hosts durable chat panes with independent admission, fenced streams, and fail-closed interaction recovery",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "oprte-gateway-chat-"));
      temporaryDirectories.push(root);
      const codexBinary = join(root, "chat-app-server");
      const paths = await installFakeGit(root);
      const compile = trackTestProcess(Bun.spawn(
        [process.execPath, "build", "--compile", accountAppServer, "--outfile", codexBinary],
        { stdout: "pipe", stderr: "pipe" },
      ));
      const compiled = await collectCompilerWithin(compile, 45_000);
      if (compiled.exitCode !== 0) {
        throw new Error(
          `failed to compile chat fixture: ${compiled.stdout}${compiled.stderr}`,
        );
      }

      const accountProfileId = "acct_chat_0001";
      const validRepositoryId = publicId("repo", 9_101);
      const symlinkRepositoryId = publicId("repo", 9_102);
      const restoredPaneId = publicId("pane", 9_101);
      const livePaneId = publicId("pane", 9_102);
      const rejectedPaneId = publicId("pane", 9_103);
      const completedTurnId = publicId("chatturn", 9_101);
      const attentionTurnId = publicId("chatturn", 9_102);
      const retargetedTurnId = publicId("chatturn", 9_103);
      const validRepository = join(root, "valid-repository");
      const symlinkTarget = join(root, "symlink-target");
      const symlinkRepository = join(root, "symlink-repository");
      await Promise.all([
        mkdir(join(validRepository, ".git"), { recursive: true }),
        mkdir(join(symlinkTarget, ".git"), { recursive: true }),
      ]);
      await symlink(symlinkTarget, symlinkRepository, "dir");
      const databasePath = controlPlanePath(root);
      const state = openControlPlane(databasePath, {
        releaseIdentity: hraReleaseIdentity,
      });
      try {
        const accountStore = new AccountProfileStore(state, {
          idFactory: () => accountProfileId,
        });
        accountStore.create("Chat subscription");
        const operationKey = loadOrCreateOperationReceiptKey(
          operationReceiptKeyPath(databasePath),
        );
        const taskStore = new LocalTaskStore(state, operationKey);
        taskStore.registerRepository({
          repositoryId: validRepositoryId,
          name: "Valid repository",
          canonicalRepositoryPath: await realpath(validRepository),
          canonicalGitCommonDir: await realpath(join(validRepository, ".git")),
        });
        taskStore.registerRepository({
          repositoryId: symlinkRepositoryId,
          name: "Symlink repository",
          canonicalRepositoryPath: symlinkRepository,
          canonicalGitCommonDir: await realpath(join(symlinkTarget, ".git")),
        });
        new ChatPaneStore(state).create({
          paneId: restoredPaneId,
          repository: {
            id: validRepositoryId,
            name: "Valid repository",
            workingDirectory: validRepository,
          },
          accountProfileId: null,
          now: new Date("2026-08-03T12:00:00.000Z"),
        });
      } finally {
        state.close();
      }
      collectClosedFixtureDatabaseReferences();

      const child = spawnGateway({
        cwd: join(import.meta.dir, "..", ".."),
        env: {
          HOME: root,
          HRA_CODEX_BIN: codexBinary,
          HRA_GIT_BIN: paths.gitBinary,
          HRA_GIT_ROOT: paths.gitRoot,
          PATH: "/usr/bin:/bin",
          TMPDIR: process.env.TMPDIR ?? tmpdir(),
        },
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      });
      const output = new GatewayOutputReader(
        child.stdout,
        accountProfileNativeResponder(
          child,
          await realpath(databasePath),
        ),
      );
      try {
        await output.readUntil(
          (lines) => hasRuntimeState(lines, "ready"),
          "the chat gateway became ready",
        );
      } catch (error: unknown) {
        const stderr = await new Response(child.stderr).text();
        await child.exited;
        throw new Error(
          `Chat gateway startup failed: ${asError(error).message}; ${stderr}`,
        );
      }

      await child.stdin.write(snapshotRequest("bridge-chat-bootstrap"));
      await output.readUntil(
        (lines) => hasBridgeResult(lines, "bridge-chat-bootstrap"),
        "the bootstrapped chat snapshot",
      );
      const bootstrapped = parseRuntimeSnapshotResponse(
        bridgeResult(output.currentLines(), "bridge-chat-bootstrap"),
      ).snapshot;
      expect(bootstrapped.chat.panes).toHaveLength(1);
      expect(bootstrapped.chat.panes[0]).toMatchObject({
        id: restoredPaneId,
        revision: 1,
        state: "ready",
      });

      await child.stdin.write(dispatchRequest(
        "bridge-chat-slow-refresh",
        "op_chat_slow_refresh",
        { type: "account.refresh", accountProfileId },
      ));
      await child.stdin.write(dispatchRequest(
        "bridge-chat-create",
        "op_chat_create_0001",
        {
          type: "chat.pane.create",
          paneId: livePaneId,
          repositoryId: validRepositoryId,
        },
      ));
      await output.readUntil(
        (lines) => hasBridgeResult(lines, "bridge-chat-create"),
        "the independently admitted chat pane",
      );
      expect(hasBridgeResult(
        output.currentLines(),
        "bridge-chat-slow-refresh",
      )).toBeFalse();
      expect(parseRuntimeDispatchResponse(bridgeResult(
        output.currentLines(),
        "bridge-chat-create",
      ))).toMatchObject({
        ok: true,
        result: {
          type: "chatPane",
          pane: { id: livePaneId, revision: 1 },
        },
      });
      await output.readUntil(
        (lines) =>
          hasBridgeResult(lines, "bridge-chat-slow-refresh") &&
          accountsAreReady(lines, [accountProfileId]),
        "the delayed subscription refresh",
      );

      const workspaceDeadline = Date.now() + 10_000;
      let workspaceProbe = 0;
      let restoredReadyRevision: number | null = null;
      let liveReadyRevision: number | null = null;
      do {
        workspaceProbe += 1;
        const bridgeId = `bridge-chat-workspace-${String(workspaceProbe)}`;
        await child.stdin.write(snapshotRequest(bridgeId));
        await output.readUntil(
          (lines) => hasBridgeResult(lines, bridgeId),
          "the managed chat workspace probe",
        );
        const snapshot = parseRuntimeSnapshotResponse(
          bridgeResult(output.currentLines(), bridgeId),
        ).snapshot;
        const restored = snapshot.chat.panes.find(({ id }) => id === restoredPaneId);
        const live = snapshot.chat.panes.find(({ id }) => id === livePaneId);
        if (
          restored?.workspace?.state === "ready"
          && live?.workspace?.state === "ready"
        ) {
          restoredReadyRevision = restored.revision;
          liveReadyRevision = live.revision;
          break;
        }
        await Bun.sleep(10);
      } while (Date.now() < workspaceDeadline);
      if (restoredReadyRevision === null || liveReadyRevision === null) {
        throw new Error("Managed chat workspaces did not become ready");
      }

      await child.stdin.write(dispatchRequest(
        "bridge-chat-symlink",
        "op_chat_symlink_0001",
        {
          type: "chat.pane.create",
          paneId: rejectedPaneId,
          repositoryId: symlinkRepositoryId,
        },
      ));
      await child.stdin.write(dispatchRequest(
        "bridge-chat-stale",
        "op_chat_stale_0001",
        {
          type: "chat.pane.rename",
          paneId: livePaneId,
          expectedRevision: 99,
          title: "Stale title",
        },
      ));
      await output.readUntil(
        (lines) =>
          hasBridgeResult(lines, "bridge-chat-symlink") &&
          hasBridgeResult(lines, "bridge-chat-stale"),
        "the chat authority failures",
      );
      expect(parseRuntimeDispatchResponse(bridgeResult(
        output.currentLines(),
        "bridge-chat-symlink",
      ))).toMatchObject({ ok: false, error: { code: "not_found" } });
      expect(parseRuntimeDispatchResponse(bridgeResult(
        output.currentLines(),
        "bridge-chat-stale",
      ))).toMatchObject({
        ok: false,
        error: { code: "revision_conflict", retryable: true, action: "retry" },
      });

      await child.stdin.write(dispatchRequest(
        "bridge-chat-turn-completed",
        "op_chat_turn_0001",
        {
          type: "chat.turn.start",
          paneId: restoredPaneId,
          expectedRevision: restoredReadyRevision,
          turnId: completedTurnId,
          prompt: "stream a deterministic response",
        },
      ));
      await output.readUntil(
        (lines) => hasBridgeResult(lines, "bridge-chat-turn-completed"),
        "the immediate completed-path chat turn admission",
      );
      await child.stdin.write(dispatchRequest(
        "bridge-chat-turn-attention",
        "op_chat_turn_0002",
        {
          type: "chat.turn.start",
          paneId: livePaneId,
          expectedRevision: liveReadyRevision,
          turnId: attentionTurnId,
          prompt: "trigger interaction",
        },
      ));
      await output.readUntil(
        (lines) =>
          hasBridgeResult(lines, "bridge-chat-turn-attention"),
        "both immediate chat turn admissions",
      );
      expect(parseRuntimeDispatchResponse(bridgeResult(
        output.currentLines(),
        "bridge-chat-turn-completed",
      ))).toMatchObject({
        ok: true,
        result: {
          type: "chatPane",
          pane: {
            id: restoredPaneId,
            revision: restoredReadyRevision + 1,
            state: "starting",
          },
        },
      });
      expect(parseRuntimeDispatchResponse(bridgeResult(
        output.currentLines(),
        "bridge-chat-turn-attention",
      ))).toMatchObject({
        ok: true,
        result: {
          type: "chatPane",
          pane: {
            id: livePaneId,
            revision: liveReadyRevision + 1,
            state: "starting",
          },
        },
      });
      const chatFixtureLog = join(
        accountProfileLayout(databasePath, accountProfileId).codexHome,
        "chat-fixture.jsonl",
      );
      const fixtureDeadline = Date.now() + 5_000;
      let finalSnapshot: ReturnType<typeof parseRuntimeSnapshotResponse>["snapshot"]
        | null = null;
      let settlementProbe = 0;
      let settlementObserved = false;
      do {
        settlementProbe += 1;
        const bridgeId = `bridge-chat-settle-${String(settlementProbe)}`;
        await child.stdin.write(snapshotRequest(bridgeId));
        await output.readUntil(
          (lines) => hasBridgeResult(lines, bridgeId),
          "the chat settlement probe",
        );
        finalSnapshot = parseRuntimeSnapshotResponse(
          bridgeResult(output.currentLines(), bridgeId),
        ).snapshot;
        const settledPanes = new Map(
          finalSnapshot.chat.panes.map((pane) => [pane.id, pane]),
        );
        if (
          settledPanes.get(restoredPaneId)?.turn?.status === "completed" &&
          settledPanes.get(livePaneId)?.state === "attention"
        ) {
          settlementObserved = true;
          break;
        }
        await Bun.sleep(10);
      } while (Date.now() < fixtureDeadline);
      if (finalSnapshot === null) throw new Error("Chat settlement was not observed");
      expect(settlementObserved).toBeTrue();
      const responseDeadline = Date.now() + 1_000;
      let observedFixtureLog = "";
      do {
        observedFixtureLog = await readFile(chatFixtureLog, "utf8");
        if (observedFixtureLog.includes(
          '"method":"server-response","kind":"error"',
        )) break;
        await Bun.sleep(10);
      } while (Date.now() < responseDeadline);
      expect(observedFixtureLog).toContain('"method":"turn/completed"');
      expect(observedFixtureLog).toContain(
        '"method":"server-response","kind":"error"',
      );
      const panes = new Map(finalSnapshot.chat.panes.map((pane) => [pane.id, pane]));
      const completed = panes.get(restoredPaneId);
      const attention = panes.get(livePaneId);
      const escapedResponsePrefix = "\\".repeat(4_096);
      const expectedResponse = escapedResponsePrefix + "α🙂".repeat(3_000);
      expect(completed).toMatchObject({
        state: "ready",
        turn: {
          id: completedTurnId,
          status: "completed",
          reasoningSummary: {
            tail: "Thinking 🌿",
            totalUtf8Bytes: 13,
            truncatedPrefix: false,
          },
          responseMarkdown: {
            tail: expectedResponse,
            totalUtf8Bytes: 22_096,
            truncatedPrefix: false,
          },
          tools: [{ category: "other", status: "completed" }],
        },
      });
      expect(attention).toMatchObject({
        state: "attention",
        attention: { code: "approval_required", retryable: true },
        turn: { id: attentionTurnId, status: "failed" },
      });
      expect(panes.has(rejectedPaneId)).toBeFalse();
      const eventsBeforeShutdown = runtimeEvents(output.currentLines()).map(
        ({ event }) => event,
      );
      expect(eventsBeforeShutdown).toContainEqual({
        type: "snapshot.invalidated",
        reason: "projectionOverflow",
      });
      expect(eventsBeforeShutdown.some((event) =>
        event.type === "chat.turn.delta" &&
        event.delta === escapedResponsePrefix
      )).toBeFalse();
      expect(eventsBeforeShutdown.some((event) =>
        event.type === "chat.pane.stateChanged" &&
        event.pane.id === livePaneId &&
        event.pane.state === "attention"
      )).toBeTrue();

      if (completed === undefined) {
        throw new Error("Completed chat pane was not projected");
      }
      const providerLogBeforeRetarget = await readFile(chatFixtureLog, "utf8");
      const retargetedCommonDirectory = join(root, "retargeted-common");
      const retargetedGitDirectory = join(
        retargetedCommonDirectory,
        "worktrees",
        "retargeted-chat",
      );
      await mkdir(retargetedGitDirectory, { recursive: true });
      await rm(join(validRepository, ".git"), { recursive: true });
      await writeFile(
        join(validRepository, ".git"),
        `gitdir: ${retargetedGitDirectory}\n`,
      );
      await child.stdin.write(dispatchRequest(
        "bridge-chat-turn-retargeted",
        "op_chat_turn_0003",
        {
          type: "chat.turn.start",
          paneId: restoredPaneId,
          expectedRevision: completed.revision,
          turnId: retargetedTurnId,
          prompt: "must not reach the retargeted repository",
        },
      ));
      await output.readUntil(
        (lines) => hasBridgeResult(lines, "bridge-chat-turn-retargeted"),
        "the retargeted repository turn admission",
      );
      expect(parseRuntimeDispatchResponse(bridgeResult(
        output.currentLines(),
        "bridge-chat-turn-retargeted",
      ))).toMatchObject({
        ok: true,
        result: {
          type: "chatPane",
          pane: { id: restoredPaneId, state: "starting" },
        },
      });
      const retargetDeadline = Date.now() + 5_000;
      let retargetRejected = false;
      let retargetProbe = 0;
      do {
        retargetProbe += 1;
        const bridgeId = `bridge-chat-retarget-${String(retargetProbe)}`;
        await child.stdin.write(snapshotRequest(bridgeId));
        await output.readUntil(
          (lines) => hasBridgeResult(lines, bridgeId),
          "the retargeted repository settlement probe",
        );
        const snapshot = parseRuntimeSnapshotResponse(
          bridgeResult(output.currentLines(), bridgeId),
        ).snapshot;
        const pane = snapshot.chat.panes.find(({ id }) => id === restoredPaneId);
        if (
          pane?.state === "attention"
          && pane.attention?.code === "runtime_unavailable"
          && pane.turn?.id === retargetedTurnId
        ) {
          retargetRejected = true;
          break;
        }
        await Bun.sleep(10);
      } while (Date.now() < retargetDeadline);
      expect(retargetRejected).toBeTrue();
      expect(await readFile(chatFixtureLog, "utf8")).toBe(
        providerLogBeforeRetarget,
      );

      await child.stdin.end();
      const [lines, stderr, exitCode] = await Promise.all([
        output.readToEnd(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      expect(stderr).toBe("");
      expect(exitCode).toBe(0);
      const fixtureLog = (await readFile(
        chatFixtureLog,
        "utf8",
      )).trim().split("\n").map((line) => JSON.parse(line) as unknown);
      expect(fixtureLog.some((entry) => hasStringFields(entry, {
          method: "thread/start",
          model: "gpt-5.6-sol",
          approvalPolicy: "never",
          approvalsReviewer: "auto_review",
          sandbox: "danger-full-access",
        }))).toBeTrue();
      expect(fixtureLog.some((entry) => hasStringFields(entry, {
          method: "turn/start",
          model: "gpt-5.6-sol",
          approvalPolicy: "never",
          approvalsReviewer: "auto_review",
          sandboxType: "dangerFullAccess",
        }))).toBeTrue();
      expect(fixtureLog.some((entry) => hasStringFields(entry, {
        method: "turn/interrupt",
      }))).toBeTrue();
      expect(fixtureLog.some((entry) => hasStringFields(entry, {
        method: "server-response",
        kind: "error",
      }))).toBeTrue();
      const rendererVisible = JSON.stringify({
        events: runtimeEvents(lines),
        completedTurnAdmission: parseRuntimeDispatchResponse(bridgeResult(
          lines,
          "bridge-chat-turn-completed",
        )),
        attentionTurnAdmission: parseRuntimeDispatchResponse(bridgeResult(
          lines,
          "bridge-chat-turn-attention",
        )),
        finalSnapshot,
      });
      expect(rendererVisible).not.toContain(root);
      expect(rendererVisible).not.toContain("chat-thread-");
      expect(rendererVisible).not.toContain("chat-turn-");
      expect(rendererVisible).not.toContain("trigger interaction");
    },
    165_000,
  );

  test(
    "recovers panes from an unavailable subscription without crossing healthy account state",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "oprte-gateway-chat-lifecycle-"));
      temporaryDirectories.push(root);
      const codexBinary = join(root, "chat-app-server");
      const paths = await installFakeGit(root);
      const compile = trackTestProcess(Bun.spawn(
        [process.execPath, "build", "--compile", accountAppServer, "--outfile", codexBinary],
        { stdout: "pipe", stderr: "pipe" },
      ));
      const compiled = await collectCompilerWithin(compile, 45_000);
      if (compiled.exitCode !== 0) {
        throw new Error(
          `failed to compile chat lifecycle fixture: ${compiled.stdout}${compiled.stderr}`,
        );
      }

      const accountIds = ["acct_chat_0001", "acct_chat_0002"] as const;
      const [unavailableAccountId, healthyAccountId] = accountIds;
      const repositoryId = publicId("repo", 9_201);
      const affectedPaneId = publicId("pane", 9_201);
      const unrelatedPaneId = publicId("pane", 9_202);
      const heldTurnId = publicId("chatturn", 9_201);
      const unrelatedTurnId = publicId("chatturn", 9_202);
      const retriedTurnId = publicId("chatturn", 9_203);
      const repository = join(root, "repository");
      await mkdir(join(repository, ".git"), { recursive: true });
      const databasePath = controlPlanePath(root);
      const state = openControlPlane(databasePath, {
        releaseIdentity: hraReleaseIdentity,
      });
      try {
        const remainingIds = [...accountIds];
        const accountStore = new AccountProfileStore(state, {
          idFactory: () => {
            const id = remainingIds.shift();
            if (id === undefined) throw new Error("chat lifecycle account IDs exhausted");
            return id;
          },
        });
        accountStore.create("Primary subscription");
        accountStore.create("Healthy subscription");
        const operationKey = loadOrCreateOperationReceiptKey(
          operationReceiptKeyPath(databasePath),
        );
        new LocalTaskStore(state, operationKey).registerRepository({
          repositoryId,
          name: "Chat lifecycle repository",
          canonicalRepositoryPath: await realpath(repository),
          canonicalGitCommonDir: await realpath(join(repository, ".git")),
        });
      } finally {
        state.close();
      }
      collectClosedFixtureDatabaseReferences();

      const child = spawnGateway({
        cwd: join(import.meta.dir, "..", ".."),
        env: {
          HOME: root,
          HRA_CODEX_BIN: codexBinary,
          HRA_GIT_BIN: paths.gitBinary,
          HRA_GIT_ROOT: paths.gitRoot,
          PATH: "/usr/bin:/bin",
          TMPDIR: process.env.TMPDIR ?? tmpdir(),
        },
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      });
      const output = new GatewayOutputReader(
        child.stdout,
        accountProfileNativeResponder(child, await realpath(databasePath)),
      );
      await output.readUntil(
        (lines) => hasRuntimeState(lines, "ready"),
        "the chat lifecycle gateway became ready",
      );

      await child.stdin.write(accountIds.map((accountProfileId, index) =>
        dispatchRequest(
          `bridge-chat-lifecycle-refresh-${String(index + 1)}`,
          `op_chat_lifecycle_refresh_${String(index + 1)}`,
          { type: "account.refresh", accountProfileId },
        )
      ).join(""));
      await output.readUntil(
        (lines) =>
          accountIds.every((_, index) => hasBridgeResult(
            lines,
            `bridge-chat-lifecycle-refresh-${String(index + 1)}`,
          )) && accountsAreReady(lines, accountIds),
        "both chat lifecycle accounts became ready",
      );

      await child.stdin.write([
        dispatchRequest(
          "bridge-chat-lifecycle-create-affected",
          "op_chat_lifecycle_create_affected",
          {
            type: "chat.pane.create",
            paneId: affectedPaneId,
            repositoryId,
          },
        ),
        dispatchRequest(
          "bridge-chat-lifecycle-create-unrelated",
          "op_chat_lifecycle_create_unrelated",
          {
            type: "chat.pane.create",
            paneId: unrelatedPaneId,
            repositoryId,
          },
        ),
      ].join(""));
      await output.readUntil(
        (lines) =>
          hasBridgeResult(lines, "bridge-chat-lifecycle-create-affected") &&
          hasBridgeResult(lines, "bridge-chat-lifecycle-create-unrelated"),
        "both chat lifecycle panes were created",
      );

      type GatewaySnapshot = ReturnType<
        typeof parseRuntimeSnapshotResponse
      >["snapshot"];
      let snapshotProbe = 0;
      const readSnapshot = async (): Promise<GatewaySnapshot> => {
        snapshotProbe += 1;
        const bridgeId = `bridge-chat-lifecycle-snapshot-${String(snapshotProbe)}`;
        await child.stdin.write(snapshotRequest(bridgeId));
        await output.readUntil(
          (lines) => hasBridgeResult(lines, bridgeId),
          "the chat lifecycle snapshot",
        );
        return parseRuntimeSnapshotResponse(
          bridgeResult(output.currentLines(), bridgeId),
        ).snapshot;
      };
      const waitForSnapshot = async (
        predicate: (snapshot: GatewaySnapshot) => boolean,
        description: string,
      ): Promise<GatewaySnapshot> => {
        const deadline = Date.now() + 10_000;
        do {
          const snapshot = await readSnapshot();
          if (predicate(snapshot)) return snapshot;
          await Bun.sleep(10);
        } while (Date.now() < deadline);
        throw new Error(`Chat lifecycle snapshot did not reach ${description}`);
      };

      const workspaceReadySnapshot = await waitForSnapshot(
        (snapshot) => [affectedPaneId, unrelatedPaneId].every((paneId) =>
          snapshot.chat.panes.some((pane) =>
            pane.id === paneId && pane.workspace?.state === "ready"
          )
        ),
        "both managed workspaces to become ready",
      );
      const affectedReady = workspaceReadySnapshot.chat.panes.find(
        ({ id }) => id === affectedPaneId,
      );
      const unrelatedReady = workspaceReadySnapshot.chat.panes.find(
        ({ id }) => id === unrelatedPaneId,
      );
      if (affectedReady === undefined || unrelatedReady === undefined) {
        throw new Error("Managed workspace panes disappeared before turn admission");
      }

      await child.stdin.write(dispatchRequest(
        "bridge-chat-lifecycle-held-turn",
        "op_chat_lifecycle_held_turn",
        {
          type: "chat.turn.start",
          paneId: affectedPaneId,
          expectedRevision: affectedReady.revision,
          turnId: heldTurnId,
          prompt: "hold active until the account stops",
        },
      ));
      const activeSnapshot = await waitForSnapshot(
        (snapshot) => snapshot.chat.panes.some((pane) =>
          pane.id === affectedPaneId &&
          pane.accountProfileId === unavailableAccountId &&
          pane.state === "streaming"
        ),
        "the held turn to become active",
      );

      await child.stdin.write(dispatchRequest(
        "bridge-chat-lifecycle-select-healthy",
        "op_chat_lifecycle_select_healthy",
        { type: "account.select", accountProfileId: healthyAccountId },
      ));
      await output.readUntil(
        (lines) => hasBridgeResult(lines, "bridge-chat-lifecycle-select-healthy"),
        "the healthy account selection",
      );
      expect(parseRuntimeDispatchResponse(bridgeResult(
        output.currentLines(),
        "bridge-chat-lifecycle-select-healthy",
      ))).toMatchObject({ ok: true, result: { type: "accepted" } });
      const selectedHealthySnapshot = await waitForSnapshot(
        (snapshot) => {
          const unavailable = snapshot.accounts.find(
            ({ id }) => id === unavailableAccountId,
          );
          const healthy = snapshot.accounts.find(({ id }) => id === healthyAccountId);
          const affected = snapshot.chat.panes.find(({ id }) => id === affectedPaneId);
          return unavailable?.selected === false &&
            healthy?.selected === true &&
            affected?.accountProfileId === unavailableAccountId &&
            affected.state === "streaming";
        },
        "the healthy account to become the automatic routing preference",
      );
      expect(selectedHealthySnapshot.chat.panes.find(
        (pane) => pane.id === affectedPaneId,
      )).toEqual(activeSnapshot.chat.panes.find((pane) => pane.id === affectedPaneId));

      await child.stdin.write(dispatchRequest(
        "bridge-chat-lifecycle-unrelated-turn",
        "op_chat_lifecycle_unrelated_turn",
        {
          type: "chat.turn.start",
          paneId: unrelatedPaneId,
          expectedRevision: unrelatedReady.revision,
          turnId: unrelatedTurnId,
          prompt: "complete on the healthy account",
        },
      ));
      const unrelatedCompleted = await waitForSnapshot(
        (snapshot) => {
          const unrelated = snapshot.chat.panes.find(({ id }) => id === unrelatedPaneId);
          const affected = snapshot.chat.panes.find(({ id }) => id === affectedPaneId);
          return unrelated?.accountProfileId === healthyAccountId &&
            unrelated.turn?.status === "completed" &&
            affected?.accountProfileId === unavailableAccountId &&
            affected.state === "streaming";
        },
        "the healthy account turn completion",
      );
      expect(parseRuntimeDispatchResponse(bridgeResult(
        output.currentLines(),
        "bridge-chat-lifecycle-unrelated-turn",
      ))).toMatchObject({
        ok: true,
        result: { type: "chatPane", pane: { state: "starting" } },
      });

      const unrelatedBeforeLogout = unrelatedCompleted.chat.panes.find(
        (pane) => pane.id === unrelatedPaneId,
      );
      const healthyAccountBeforeLogout = unrelatedCompleted.accounts.find(
        (account) => account.id === healthyAccountId,
      );
      expect(unrelatedBeforeLogout).toBeDefined();
      expect(healthyAccountBeforeLogout).toBeDefined();

      await child.stdin.write(dispatchRequest(
        "bridge-chat-lifecycle-logout",
        "op_chat_lifecycle_logout",
        { type: "account.logout", accountProfileId: unavailableAccountId },
      ));
      const detachedSnapshot = await waitForSnapshot(
        (snapshot) => {
          const pane = snapshot.chat.panes.find(({ id }) => id === affectedPaneId);
          return !snapshot.accounts.some(({ id }) => id === unavailableAccountId) &&
            snapshot.retainedAccountLocalData.some(({ id }) => id === unavailableAccountId) &&
            pane?.state === "attention" &&
            pane.accountProfileId === null &&
            pane.attention?.code === "account_unavailable";
        },
        "the logged-out account removal and pane detachment",
      );
      expect(parseRuntimeDispatchResponse(bridgeResult(
        output.currentLines(),
        "bridge-chat-lifecycle-logout",
      ))).toMatchObject({ ok: true, result: { type: "accepted" } });
      const detachedPane = detachedSnapshot.chat.panes.find(
        (pane) => pane.id === affectedPaneId,
      );
      expect(detachedPane).toMatchObject({
        accountProfileId: null,
        state: "attention",
        attention: { code: "account_unavailable", retryable: true },
        turn: { id: heldTurnId, status: "failed" },
      });
      expect(detachedSnapshot.retainedAccountLocalData.some((localData) =>
        localData.id === unavailableAccountId && localData.label === "Primary subscription"
      )).toBeTrue();
      expect(detachedSnapshot.chat.panes.find(
        (pane) => pane.id === unrelatedPaneId,
      )).toEqual(unrelatedBeforeLogout);
      expect(detachedSnapshot.accounts.find(
        (account) => account.id === healthyAccountId,
      )).toEqual(healthyAccountBeforeLogout);
      if (detachedPane === undefined) throw new Error("Affected pane was not detached");

      await child.stdin.write(dispatchRequest(
        "bridge-chat-lifecycle-retry",
        "op_chat_lifecycle_retry",
        {
          type: "chat.turn.start",
          paneId: affectedPaneId,
          expectedRevision: detachedPane.revision,
          turnId: retriedTurnId,
          prompt: "continue on the healthy account",
        },
      ));
      const retriedSnapshot = await waitForSnapshot(
        (snapshot) => snapshot.chat.panes.some((pane) =>
          pane.id === affectedPaneId &&
          pane.accountProfileId === healthyAccountId &&
          pane.turn?.id === retriedTurnId &&
          pane.turn.status === "completed"
        ),
        "the detached pane retry on the healthy account",
      );
      expect(parseRuntimeDispatchResponse(bridgeResult(
        output.currentLines(),
        "bridge-chat-lifecycle-retry",
      ))).toMatchObject({
        ok: true,
        result: { type: "chatPane", pane: { state: "starting" } },
      });
      expect(retriedSnapshot.chat.panes.find(
        (pane) => pane.id === unrelatedPaneId,
      )).toEqual(unrelatedBeforeLogout);
      expect(retriedSnapshot.accounts.find(
        (account) => account.id === healthyAccountId,
      )).toEqual(healthyAccountBeforeLogout);

      await child.stdin.end();
      const [lines, stderr, exitCode] = await Promise.all([
        output.readToEnd(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      expect(stderr).toBe("");
      expect(exitCode).toBe(0);
      expect(await readFile(
        join(
          accountProfileLayout(databasePath, unavailableAccountId).codexHome,
          "chat-fixture.jsonl",
        ),
        "utf8",
      )).toContain('"method":"account/logout"');
      expect(JSON.stringify({
        events: runtimeEvents(lines),
        detachedSnapshot,
        retriedSnapshot,
      })).not.toContain(root);
    },
    165_000,
  );

  test(
    "isolates an exhausted app-server restart budget to its account",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "oprte-gateway-fault-"));
      temporaryDirectories.push(root);
      const codexHome = join(root, "codex-home");
      const codexBinary = join(root, "fault-app-server");
      const paths = await installFakeGit(root);
      const compile = trackTestProcess(Bun.spawn(
        [process.execPath, "build", "--compile", gatewayFaultAppServer, "--outfile", codexBinary],
        { stdout: "pipe", stderr: "pipe" },
      ));
      const compiled = await collectCompilerWithin(compile, 45_000);
      if (compiled.exitCode !== 0) {
        throw new Error(
          `failed to compile gateway fault fixture: ${compiled.stdout}${compiled.stderr}`,
        );
      }

      const accountProfileId = "acct_gateway_fault";
      const state = openControlPlane(controlPlanePath(root), {
        releaseIdentity: hraReleaseIdentity,
      });
      try {
        new AccountProfileStore(state, { idFactory: () => accountProfileId }).create("Fault fixture");
      } finally {
        state.close();
      }
      collectClosedFixtureDatabaseReferences();

      const child = spawnGateway({
        cwd: join(import.meta.dir, "..", ".."),
        env: {
          HOME: root,
          HRA_CODEX_BIN: codexBinary,
          HRA_CODEX_HOME: codexHome,
          HRA_GIT_BIN: paths.gitBinary,
          HRA_GIT_ROOT: paths.gitRoot,
          PATH: "/usr/bin:/bin",
          TMPDIR: process.env.TMPDIR ?? tmpdir(),
        },
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      });
      const output = new GatewayOutputReader(
        child.stdout,
        accountProfileNativeResponder(
          child,
          await realpath(controlPlanePath(root)),
        ),
      );
      await readGatewayOutputWithin(
        child,
        output,
        (lines) => hasRuntimeState(lines, "ready"),
        "the account fault gateway became ready",
        50_000,
      );
      await child.stdin.write(dispatchRequest(
        "bridge-refresh-fault",
        "op_gateway_fault",
        { type: "account.refresh", accountProfileId },
      ));
      await readGatewayOutputWithin(
        child,
        output,
        (lines) => runtimeEvents(lines).some(({ event }) =>
          event.type === "account.upserted" &&
          event.account.id === accountProfileId &&
          event.account.runtime.state === "failed"
        ),
        "the isolated account exhausted its restart budget",
        50_000,
      );
      await child.stdin.write(snapshotRequest("bridge-after-fault"));
      await child.stdin.end();

      const [lines, stderr, exitCode] = await Promise.all([
        output.readToEnd(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      expect(stderr).toBe("");
      expect(exitCode).toBe(0);
      const events = runtimeEvents(lines);
      const snapshot = parseRuntimeSnapshotResponse(
        bridgeResult(lines, "bridge-after-fault"),
      ).snapshot;
      expectContinuousSequences(events);
      expect(events.some(({ event }) =>
        event.type === "runtime.changed" && event.runtime.state === "ready"
      )).toBeTrue();
      expect(events.some(({ event }) =>
        event.type === "account.upserted" &&
        event.account.id === accountProfileId &&
        event.account.runtime.state === "failed"
      )).toBeTrue();
      expect(snapshot.runtime.state).toBe("ready");
      expect(snapshot.accounts).toHaveLength(1);
      expect(snapshot.accounts[0]?.runtime.state).toBe("failed");
      expect(JSON.stringify(snapshot)).not.toContain(codexHome);
    },
    // Fixture compilation and real-process startup share this callback budget
    // with two separately bounded state waits. Keep product deadlines intact,
    // but allow the proof to run beside other native process suites.
    165_000,
  );

  test("queues overlapping renderer snapshot requests", async () => {
    const root = await mkdtemp(join(tmpdir(), "oprte-gateway-overlapping-snapshots-"));
    temporaryDirectories.push(root);
    const paths = await installFakeGit(root);
    const child = spawnGateway({
      cwd: join(import.meta.dir, "..", ".."),
      env: {
        HOME: root,
        HRA_CODEX_BIN: process.execPath,
        HRA_GIT_BIN: paths.gitBinary,
        HRA_GIT_ROOT: paths.gitRoot,
        PATH: "/usr/bin:/bin",
        TMPDIR: process.env.TMPDIR ?? tmpdir(),
      },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    const output = new GatewayOutputReader(child.stdout);
    await output.readUntil(
      (lines) => hasRuntimeState(lines, "ready"),
      "the overlapping-snapshot gateway became ready",
    );
    await child.stdin.write(
      `${snapshotRequest("bridge-strict-mode-disposed")}${snapshotRequest("bridge-strict-mode-live")}`,
    );
    await child.stdin.end();

    const [lines, stderr, exitCode] = await Promise.all([
      output.readToEnd(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect(stderr).toBe("");
    expect(exitCode).toBe(0);
    const disposedSnapshot = parseRuntimeSnapshotResponse(
      bridgeResult(lines, "bridge-strict-mode-disposed"),
    ).snapshot;
    const liveSnapshot = parseRuntimeSnapshotResponse(
      bridgeResult(lines, "bridge-strict-mode-live"),
    ).snapshot;
    expect(disposedSnapshot.runtime.state).toBe("ready");
    expect(liveSnapshot.runtime.state).toBe("ready");
  });

  test(
    "quiesces every writer, emits only the private launch envelope, and rejects queued writes",
    async () => {
      const root = await mkdtemp(join(
        tmpdir(),
        "oprte-gateway-removal-quiesce-",
      ));
      temporaryDirectories.push(root);
      const paths = await installFakeGit(root);
      const dataRemover = await installFakeDataRemover(root);
      const secretFixture = localDataRemovalSecretFixture(
        root,
        "removal-quiesce",
      );
      const gatewayEnvironment = {
        HOME: root,
        ...secretFixture.env,
        HRA_CODEX_BIN: process.execPath,
        HRA_DATA_REMOVER_PATH: dataRemover,
        HRA_GIT_BIN: paths.gitBinary,
        HRA_GIT_ROOT: paths.gitRoot,
        PATH: "/usr/bin:/bin",
        TMPDIR: process.env.TMPDIR ?? tmpdir(),
      };
      const child = spawnGateway({
        cwd: join(import.meta.dir, "..", ".."),
        env: gatewayEnvironment,
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      });
      const output = new GatewayOutputReader(child.stdout);
      await output.readUntil(
        (lines) => hasRuntimeState(lines, "ready"),
        "the removal gateway became ready",
      );
      await child.stdin.write(dispatchRequest(
        "bridge-removal-preview",
        "op_removal_preview01",
        { type: "maintenance.localDataRemoval.preview" },
      ));
      await output.readUntil(
        (lines) => hasBridgeResult(lines, "bridge-removal-preview"),
        "the local-data removal preview",
      );
      const previewResponse = parseRuntimeDispatchResponse(bridgeResult(
        output.currentLines(),
        "bridge-removal-preview",
      ));
      if (
        !previewResponse.ok ||
        previewResponse.result.type !== "localDataRemovalPreview"
      ) {
        throw new Error(
          `Local-data removal preview was not available: ${JSON.stringify(previewResponse)}`,
        );
      }
      expect(previewResponse.result.preview.canRemove).toBeTrue();
      const preview = previewResponse.result.preview;

      await child.stdin.write(
        dispatchRequest(
          "bridge-removal-remove",
          "op_removal_remove01",
          {
            type: "maintenance.localDataRemoval.remove",
            previewId: preview.previewId,
            confirmationToken: preview.confirmationToken,
            confirmation: runtimeLocalDataRemovalConfirmation,
            acknowledgeDirtyWorktrees: true,
          },
        ) +
          taskDispatchRequest(
            "bridge-removal-rejected-write",
            publicId("op", 9_301),
            { type: "task.workspaces.list" },
          ),
      );
      await output.readUntil(
        (lines) =>
          hasBridgeResult(lines, "bridge-removal-remove") &&
          hasBridgeResult(lines, "bridge-removal-rejected-write"),
        "the private launch and rejected queued write",
      );
      const launch = expectRemovalLaunch(
        bridgeResult(output.currentLines(), "bridge-removal-remove"),
        "The quiesced local-data removal",
      );
      expect(
        hostLocalDataRemovalNativeTerminationRequiredSchema.safeParse(launch)
          .success,
      ).toBeFalse();
      expect(Object.keys(launch)).toHaveLength(8);
      expect(launch).toMatchObject({
        kind: "localDataRemovalNativeLaunch",
        version: 1,
        operationId: "op_removal_remove01",
        previewId: preview.previewId,
        publicResponse: {
          version: 3,
          operationId: "op_removal_remove01",
          ok: true,
          result: {
            type: "localDataRemovalScheduled",
            previewId: preview.previewId,
            state: "scheduled",
            willQuitApplication: true,
          },
        },
      });
      const privateJson = JSON.stringify(launch);
      expect(privateJson).not.toContain("signedRequest");
      expect(privateJson).not.toContain("signature");
      expect(privateJson).not.toContain("confirmationToken");
      expect(privateJson).not.toContain("inventoryDigest");
      expect(parseRuntimeTaskDispatchResponse(bridgeResult(
        output.currentLines(),
        "bridge-removal-rejected-write",
      ))).toMatchObject({
        ok: false,
        error: {
          code: "runtime_unavailable",
          retryable: false,
        },
      });
      expect(gatewayHarnessCustodyTrace(root)).toEqual([
        expectedHarnessNativeDeletion,
      ]);

      await child.stdin.end();
      const [stderr, exitCode] = await Promise.all([
        new Response(child.stderr).text(),
        child.exited,
        output.readToEnd(),
      ]);
      expect(stderr).toBe("");
      expect(exitCode).toBe(0);

      const recovery = spawnGateway({
        cwd: join(import.meta.dir, "..", ".."),
        env: {
          ...gatewayEnvironment,
          HRA_STARTUP_REMOVAL_RECOVERY: "1",
        },
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      });
      const recoveryOutput = new GatewayOutputReader(recovery.stdout);
      await recovery.stdin.write(localDataRemovalRecoveryRequest(
        "native-removal-durable-replay",
      ));
      await recoveryOutput.readUntil(
        (lines) => hasBridgeResult(lines, "native-removal-durable-replay"),
        "the durable local-data removal replay",
      );
      const replay = expectRemovalLaunch(
        bridgeResult(
          recoveryOutput.currentLines(),
          "native-removal-durable-replay",
        ),
        "The durable local-data removal replay",
      );
      expect(replay).toMatchObject({
        kind: "localDataRemovalNativeLaunch",
        operationId: "op_removal_remove01",
        previewId: preview.previewId,
      });
      expect(
        hostLocalDataRemovalNativeTerminationRequiredSchema.safeParse(replay)
          .success,
      ).toBeFalse();
      await recovery.stdin.end();
      const [recoveryStderr, recoveryExitCode] = await Promise.all([
        new Response(recovery.stderr).text(),
        recovery.exited,
        recoveryOutput.readToEnd(),
      ]);
      expect(recoveryStderr).toBe("");
      expect(recoveryExitCode).toBe(0);
      expect(gatewayHarnessCustodyTrace(root)).toEqual([
        expectedHarnessNativeDeletion,
      ]);
    },
    30_000,
  );

  test(
    "durably resumes a rejected Keychain deletion without repeating completed effects",
    async () => {
      const root = await realpath(await mkdtemp(join(
        tmpdir(),
        "oprte-gateway-removal-keychain-recovery-",
      )));
      temporaryDirectories.push(root);
      const paths = await installFakeGit(root);
      const dataRemover = await installFakeDataRemover(root);
      const fixed = fixedLocalDataRemovalPaths(root);
      const secretFixture = localDataRemovalSecretFixture(
        root,
        "removal-keychain-recovery",
      );
      const completedTargets = [
        harnessLegacyInstallKeyDescriptor,
        harnessInstallKeyDescriptor,
      ] as const;
      const rejectedTarget = {
        service: HRA_HUMAN_KEYCHAIN_SERVICE,
        name: "primary:slot:human-generation-1",
      } as const;
      const sessionSyncTarget = {
        service: HRA_SESSION_SYNC_KEYCHAIN_SERVICE,
        name: HRA_SESSION_SYNC_KEYCHAIN_NAME,
      } as const;
      const sessionSyncRecoveryTarget = {
        service: HRA_SESSION_SYNC_KEYCHAIN_SERVICE,
        name: HRA_SESSION_SYNC_RECOVERY_KEYCHAIN_NAME,
      } as const;

      const fixtureDatabase = openControlPlane(fixed.controlPlanePath, {
        releaseIdentity: hraReleaseIdentity,
      });
      try {
        const journal = JSON.stringify({
          version: 1,
          revision: 0,
          latestGeneration: 0,
          service: HRA_HUMAN_KEYCHAIN_SERVICE,
          name: "primary",
          committed: {
            generation: 0,
            slot: "human-generation-1",
          },
        });
        fixtureDatabase.query(`
          INSERT INTO human_custody_metadata(
            service, name, revision, latest_generation, journal_json,
            updated_at
          ) VALUES (?1, ?2, 0, 0, ?3, 1)
        `).run(HRA_HUMAN_KEYCHAIN_SERVICE, "primary", journal);
      } finally {
        fixtureDatabase.close();
      }
      collectClosedFixtureDatabaseReferences();

      const first = spawnGateway({
        cwd: join(import.meta.dir, "..", ".."),
        env: {
          HOME: root,
          ...secretFixture.env,
          HRA_CODEX_BIN: process.execPath,
          HRA_DATA_REMOVER_PATH: dataRemover,
          HRA_GATEWAY_TEST_SECRET_REJECT_DELETE: JSON.stringify(
            rejectedTarget,
          ),
          HRA_GIT_BIN: paths.gitBinary,
          HRA_GIT_ROOT: paths.gitRoot,
          PATH: "/usr/bin:/bin",
          TMPDIR: process.env.TMPDIR ?? tmpdir(),
        },
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      });
      const firstOutput = new GatewayOutputReader(first.stdout);
      try {
        await readGatewayOutputWithin(
          first,
          firstOutput,
          (lines) => hasRuntimeState(lines, "ready"),
          "the Keychain-rejection gateway became ready",
          50_000,
        );
      } catch (error: unknown) {
        const stderr = await new Response(first.stderr).text();
        throw new Error(
          `Keychain-rejection gateway startup failed: ${stderr}`,
          { cause: error },
        );
      }
      await first.stdin.write(dispatchRequest(
        "bridge-removal-keychain-preview",
        "op_removal_keychain_preview",
        { type: "maintenance.localDataRemoval.preview" },
      ));
      await readGatewayOutputWithin(
        first,
        firstOutput,
        (lines) => hasBridgeResult(
          lines,
          "bridge-removal-keychain-preview",
        ),
        "the Keychain-rejection removal preview",
        20_000,
      );
      const previewResponse = parseRuntimeDispatchResponse(bridgeResult(
        firstOutput.currentLines(),
        "bridge-removal-keychain-preview",
      ));
      if (
        !previewResponse.ok ||
        previewResponse.result.type !== "localDataRemovalPreview"
      ) {
        throw new Error(
          `Keychain-rejection preview was not available: ${JSON.stringify(previewResponse)}`,
        );
      }
      const preview = previewResponse.result.preview;

      await first.stdin.write(dispatchRequest(
        "bridge-removal-keychain-remove",
        "op_removal_keychain_remove",
        {
          type: "maintenance.localDataRemoval.remove",
          previewId: preview.previewId,
          confirmationToken: preview.confirmationToken,
          confirmation: runtimeLocalDataRemovalConfirmation,
          acknowledgeDirtyWorktrees: true,
        },
      ));
      await readGatewayOutputWithin(
        first,
        firstOutput,
        (lines) => hasBridgeResult(
          lines,
          "bridge-removal-keychain-remove",
        ),
        "the renderer-safe Keychain-rejection termination",
        20_000,
      );
      const termination = bridgeResult(
        firstOutput.currentLines(),
        "bridge-removal-keychain-remove",
      ) as Record<string, unknown>;
      expect(Object.keys(termination)).toHaveLength(3);
      expect(termination).toEqual({
        kind: "localDataRemovalNativeTerminationRequired",
        version: 1,
        publicResponse: {
          version: runtimeProtocolVersion,
          operationId: "op_removal_keychain_remove",
          ok: false,
          error: {
            code: "operation_failed",
            message: "HRA could not remove local data.",
            retryable: false,
            action: "none",
          },
        },
      });
      const publicTerminationJson = JSON.stringify(termination);
      expect(publicTerminationJson).not.toContain(root);
      for (const target of completedTargets) {
        expect(publicTerminationJson).not.toContain(target.service);
      }
      expect(publicTerminationJson).not.toContain(rejectedTarget.service);
      expect(publicTerminationJson).not.toContain("human-generation-1");

      await first.stdin.end();
      const [, firstStderr, firstExitCode] = await Promise.all([
        firstOutput.readToEnd(),
        new Response(first.stderr).text(),
        first.exited,
      ]);
      expect(firstStderr).toBe("");
      expect(firstExitCode).toBe(0);

      const receipts = new FileLocalDataRemovalReceiptStore(
        fixed.helperStateRoot,
      );
      const interruptedReceipts = await receipts.list();
      expect(interruptedReceipts).toHaveLength(1);
      expect(interruptedReceipts[0]).toMatchObject({
        operationId: "op_removal_keychain_remove",
        requestPath: null,
        signingKeyPath: null,
        signedRequest: null,
        keychainTargets: [
          ...completedTargets.map((target) => ({
            ...target,
            completed: true,
          })),
          { ...rejectedTarget, completed: false },
          { ...sessionSyncTarget, completed: false },
          { ...sessionSyncRecoveryTarget, completed: false },
        ],
      });

      const recovery = spawnGateway({
        cwd: join(import.meta.dir, "..", ".."),
        env: {
          HOME: root,
          ...secretFixture.env,
          HRA_CODEX_BIN: join(root, "must-not-open-codex"),
          HRA_GIT_BIN: paths.gitBinary,
          HRA_GIT_ROOT: paths.gitRoot,
          HRA_STARTUP_REMOVAL_RECOVERY: "1",
          PATH: "/usr/bin:/bin",
          TMPDIR: process.env.TMPDIR ?? tmpdir(),
        },
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      });
      const recoveryOutput = new GatewayOutputReader(recovery.stdout);
      await recovery.stdin.write(localDataRemovalRecoveryRequest(
        "native-removal-keychain-recovery",
      ));
      await readGatewayOutputWithin(
        recovery,
        recoveryOutput,
        (lines) => hasBridgeResult(
          lines,
          "native-removal-keychain-recovery",
        ),
        "the resumed native local-data removal launch",
        20_000,
      );
      const launch = hostLocalDataRemovalNativeLaunchSchema.parse(bridgeResult(
        recoveryOutput.currentLines(),
        "native-removal-keychain-recovery",
      ));
      expect(launch).toMatchObject({
        kind: "localDataRemovalNativeLaunch",
        version: 1,
        operationId: "op_removal_keychain_remove",
        previewId: preview.previewId,
        publicResponse: {
          version: runtimeProtocolVersion,
          operationId: "op_removal_keychain_remove",
          ok: true,
          result: {
            type: "localDataRemovalScheduled",
            previewId: preview.previewId,
            state: "scheduled",
            willQuitApplication: true,
          },
        },
      });
      const resumedReceipts = await receipts.list();
      expect(resumedReceipts).toHaveLength(1);
      expect(resumedReceipts[0]).toMatchObject({
        operationId: "op_removal_keychain_remove",
        keychainTargets: [
          ...completedTargets.map((target) => ({
            ...target,
            completed: true,
          })),
          { ...rejectedTarget, completed: true },
          { ...sessionSyncTarget, completed: true },
          { ...sessionSyncRecoveryTarget, completed: true },
        ],
      });
      expect(resumedReceipts[0]?.requestPath).toBe(launch.requestPath);
      expect(resumedReceipts[0]?.signingKeyPath).toBe(launch.signingKeyPath);
      expect(resumedReceipts[0]?.signedRequest).not.toBeNull();

      await recovery.stdin.end();
      const [recoveryStderr, recoveryExitCode] = await Promise.all([
        new Response(recovery.stderr).text(),
        recovery.exited,
        recoveryOutput.readToEnd(),
      ]);
      expect(recoveryStderr).toBe("");
      expect(recoveryExitCode).toBe(0);

      const secretOperations = await readGatewaySecretTrace(
        secretFixture.tracePath,
      );
      const deletionOperations = secretOperations.filter(
        ({ operation }) => operation === "delete",
      );
      expect(deletionOperations).toEqual([
        { operation: "delete", result: "rejected", ...rejectedTarget },
        { operation: "delete", result: "missing", ...rejectedTarget },
        { operation: "delete", result: "missing", ...sessionSyncTarget },
        {
          operation: "delete",
          result: "missing",
          ...sessionSyncRecoveryTarget,
        },
      ]);
      expect(gatewayHarnessCustodyTrace(root)).toEqual([
        expectedHarnessNativeDeletion,
      ]);
      expect(JSON.stringify(secretOperations)).not.toContain("value");
      for (const operation of secretOperations) {
        expect(Object.keys(operation).sort())
          .toEqual(["name", "operation", "result", "service"]);
      }

      const request = JSON.parse(
        await readFile(launch.requestPath, "utf8"),
      ) as unknown;
      const signingKey = new Uint8Array(
        await readFile(launch.signingKeyPath),
      );
      const verified = verifyLocalDataRemovalHelperRequest(
        request,
        signingKey,
      );
      expect(await executeLocalDataRemovalFilesystemRequest({
        request,
        signingKey,
        ownedRoots: verified.payload.ownedRoots,
      })).toEqual({ state: "completed", alreadyCompleted: false });
    },
    90_000,
  );

  test(
    "rejects a confirmed removal when the exact database inventory changes",
    async () => {
      const root = await mkdtemp(join(
        tmpdir(),
        "oprte-gateway-removal-inventory-change-",
      ));
      temporaryDirectories.push(root);
      const canonicalRoot = await realpath(root);
      const paths = await installFakeGit(root);
      const dataRemover = await installFakeDataRemover(root);
      const child = spawnGateway({
        cwd: join(import.meta.dir, "..", ".."),
        env: {
          HOME: root,
          HRA_CODEX_BIN: process.execPath,
          HRA_DATA_REMOVER_PATH: dataRemover,
          HRA_GIT_BIN: paths.gitBinary,
          HRA_GIT_ROOT: paths.gitRoot,
          PATH: "/usr/bin:/bin",
          TMPDIR: process.env.TMPDIR ?? tmpdir(),
        },
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      });
      const output = new GatewayOutputReader(child.stdout);
      await output.readUntil(
        (lines) => hasRuntimeState(lines, "ready"),
        "the inventory-change gateway became ready",
      );
      await child.stdin.write(dispatchRequest(
        "bridge-removal-change-preview",
        "op_removal_change_preview",
        { type: "maintenance.localDataRemoval.preview" },
      ));
      await output.readUntil(
        (lines) => hasBridgeResult(
          lines,
          "bridge-removal-change-preview",
        ),
        "the inventory-change preview",
      );
      const previewResponse = parseRuntimeDispatchResponse(bridgeResult(
        output.currentLines(),
        "bridge-removal-change-preview",
      ));
      if (
        !previewResponse.ok ||
        previewResponse.result.type !== "localDataRemovalPreview"
      ) {
        throw new Error(
          `Local-data removal preview was not available: ${JSON.stringify(previewResponse)}`,
        );
      }
      const preview = previewResponse.result.preview;

      const concurrent = new Database(controlPlanePath(root), {
        strict: true,
      });
      try {
        concurrent.query(`
          INSERT INTO local_repositories(
            repository_id, name, provider, public_url,
            canonical_repository_path, canonical_git_common_dir,
            tombstoned_at, created_at, updated_at
          ) VALUES (?1, ?2, NULL, NULL, ?3, ?4, ?5, ?6, ?7)
        `).run(
          publicId("repo", 9_401),
          "Concurrent tombstone",
          join(canonicalRoot, "concurrent-repository"),
          join(canonicalRoot, "concurrent-repository", ".git"),
          4,
          3,
          4,
        );
      } finally {
        concurrent.close();
      }

      await child.stdin.write(dispatchRequest(
        "bridge-removal-change-remove",
        "op_removal_change_remove",
        {
          type: "maintenance.localDataRemoval.remove",
          previewId: preview.previewId,
          confirmationToken: preview.confirmationToken,
          confirmation: runtimeLocalDataRemovalConfirmation,
          acknowledgeDirtyWorktrees: true,
        },
      ));
      await output.readUntil(
        (lines) => hasBridgeResult(
          lines,
          "bridge-removal-change-remove",
        ),
        "the changed-inventory rejection",
      );
      const termination = hostLocalDataRemovalNativeTerminationRequiredSchema
        .parse(bridgeResult(
          output.currentLines(),
          "bridge-removal-change-remove",
        ));
      expect(Object.keys(termination)).toHaveLength(3);
      expect(
        hostLocalDataRemovalNativeLaunchSchema.safeParse(termination).success,
      ).toBeFalse();
      expect(termination).toMatchObject({
        kind: "localDataRemovalNativeTerminationRequired",
        version: 1,
        publicResponse: {
          version: 3,
          operationId: "op_removal_change_remove",
          ok: false,
          error: {
            code: "conflict",
            retryable: true,
          },
        },
      });
      expect(JSON.stringify(termination)).not.toContain(canonicalRoot);

      await child.stdin.end();
      const [stderr, exitCode] = await Promise.all([
        new Response(child.stderr).text(),
        child.exited,
        output.readToEnd(),
      ]);
      expect(stderr).toBe("");
      expect(exitCode).toBe(0);
    },
    30_000,
  );

  test(
    "includes a dirty manifest-only worktree and removes its reciprocal Git administration",
    async () => {
      const root = await realpath(await mkdtemp(join(
        tmpdir(),
        "oprte-gateway-removal-orphan-",
      )));
      temporaryDirectories.push(root);
      const paths = await installFakeGit(root);
      const dataRemover = await installFakeDataRemover(root);
      const secretFixture = localDataRemovalSecretFixture(
        root,
        "removal-orphan",
      );
      const fixed = fixedLocalDataRemovalPaths(root);
      const repository = join(root, "preserved-repository");
      const commonDirectory = join(repository, ".git");
      const checkout = join(
        fixed.managedWorktreeRoots[0],
        "run_orphan0001",
      );
      const administrativeDirectory = join(
        commonDirectory,
        "worktrees",
        "run_orphan0001",
      );
      const manifestsRoot = fixed.manifestRoots[0];
      await Promise.all([
        mkdir(administrativeDirectory, {
          recursive: true,
          mode: 0o700,
        }),
        mkdir(checkout, { recursive: true, mode: 0o700 }),
        mkdir(manifestsRoot, { recursive: true, mode: 0o700 }),
      ]);
      await writeFile(join(repository, "README.md"), "preserve");
      await writeFile(
        join(checkout, ".git"),
        `gitdir: ${administrativeDirectory}\n`,
      );
      await writeFile(join(checkout, ".fixture-dirty"), "dirty");
      await writeFile(
        join(administrativeDirectory, "gitdir"),
        `${join(checkout, ".git")}\n`,
      );
      await writeFile(
        join(manifestsRoot, "run_orphan0001.json"),
        `${JSON.stringify({
          version: 1,
          runId: "run_orphan0001",
          laneId: "run_orphan0001",
          canonicalRepositoryPath: repository,
          canonicalGitCommonDir: commonDirectory,
          baseSha: "a".repeat(40),
          branchName: "codex/oprte-run_orphan0001",
          canonicalCheckoutPath: checkout,
        })}\n`,
      );
      const state = openControlPlane(fixed.controlPlanePath, {
        releaseIdentity: hraReleaseIdentity,
      });
      try {
        state.query(`
          INSERT INTO local_repositories(
            repository_id, name, provider, public_url,
            canonical_repository_path, canonical_git_common_dir,
            tombstoned_at, created_at, updated_at
          ) VALUES (?1, ?2, NULL, NULL, ?3, ?4, NULL, ?5, ?6)
        `).run(
          publicId("repo", 9_501),
          "Orphan fixture",
          repository,
          commonDirectory,
          1,
          1,
        );
      } finally {
        state.close();
      }
      collectClosedFixtureDatabaseReferences();

      const child = spawnGateway({
        cwd: join(import.meta.dir, "..", ".."),
        env: {
          HOME: root,
          ...secretFixture.env,
          HRA_CODEX_BIN: process.execPath,
          HRA_DATA_REMOVER_PATH: dataRemover,
          HRA_GIT_BIN: paths.gitBinary,
          HRA_GIT_ROOT: paths.gitRoot,
          PATH: "/usr/bin:/bin",
          TMPDIR: process.env.TMPDIR ?? tmpdir(),
        },
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      });
      const output = new GatewayOutputReader(child.stdout);
      await readGatewayOutputWithin(
        child,
        output,
        (lines) =>
          hasRuntimeState(lines, "ready") || hasRuntimeState(lines, "failed"),
        "a terminal orphan-worktree gateway startup state",
        50_000,
      );
      if (hasRuntimeState(output.currentLines(), "failed")) {
        throw new Error("The orphan-worktree gateway reported a failed startup state");
      }
      await child.stdin.write(dispatchRequest(
        "bridge-removal-orphan-preview",
        "op_removal_orphan_preview",
        { type: "maintenance.localDataRemoval.preview" },
      ));
      await output.readUntil(
        (lines) => hasBridgeResult(
          lines,
          "bridge-removal-orphan-preview",
        ),
        "the orphan-worktree preview",
      );
      const previewResponse = parseRuntimeDispatchResponse(bridgeResult(
        output.currentLines(),
        "bridge-removal-orphan-preview",
      ));
      if (
        !previewResponse.ok ||
        previewResponse.result.type !== "localDataRemovalPreview"
      ) {
        throw new Error(
          `Orphan-worktree preview was not available: ${JSON.stringify(previewResponse)}`,
        );
      }
      const preview = previewResponse.result.preview;
      expect(preview.removes.managedWorktrees).toBe(1);
      expect(preview.removes.dirtyManagedWorktrees).toBe(1);
      expect(preview.dirtyWorktreeAcknowledgementRequired).toBeTrue();

      await child.stdin.write(dispatchRequest(
        "bridge-removal-orphan-remove",
        "op_removal_orphan_remove",
        {
          type: "maintenance.localDataRemoval.remove",
          previewId: preview.previewId,
          confirmationToken: preview.confirmationToken,
          confirmation: runtimeLocalDataRemovalConfirmation,
          acknowledgeDirtyWorktrees: true,
        },
      ));
      await output.readUntil(
        (lines) => hasBridgeResult(
          lines,
          "bridge-removal-orphan-remove",
        ),
        "the orphan-worktree helper launch",
      );
      const launch = expectRemovalLaunch(
        bridgeResult(output.currentLines(), "bridge-removal-orphan-remove"),
        "The orphan-worktree local-data removal",
      );
      expect(launch.kind).toBe("localDataRemovalNativeLaunch");
      expect(
        hostLocalDataRemovalNativeTerminationRequiredSchema.safeParse(launch)
          .success,
      ).toBeFalse();
      expect(gatewayHarnessCustodyTrace(root)).toEqual([
        expectedHarnessNativeDeletion,
      ]);
      const request = JSON.parse(
        await readFile(launch.requestPath, "utf8"),
      ) as unknown;
      const signingKey = new Uint8Array(
        await readFile(launch.signingKeyPath),
      );
      const verified = verifyLocalDataRemovalHelperRequest(
        request,
        signingKey,
      );
      await executeLocalDataRemovalFilesystemRequest({
        request,
        signingKey,
        ownedRoots: verified.payload.ownedRoots,
      });
      expect(await stat(checkout).catch(() => null)).toBeNull();
      expect(await stat(administrativeDirectory).catch(() => null))
        .toBeNull();
      expect(await readFile(join(repository, "README.md"), "utf8"))
        .toBe("preserve");

      await child.stdin.end();
      const [stderr, exitCode] = await Promise.all([
        new Response(child.stderr).text(),
        child.exited,
        output.readToEnd(),
      ]);
      expect(stderr).toBe("");
      expect(exitCode).toBe(0);
    },
    // This proof includes a real gateway boot and filesystem removal. Keep
    // the product startup join independently bounded above while allowing
    // fixture work and cleanup to share a contended repository-wide runner.
    165_000,
  );

  test(
    "recovery-only startup never opens the database or normal runtime",
    async () => {
      const root = await mkdtemp(join(
        tmpdir(),
        "oprte-gateway-removal-recovery-",
      ));
      temporaryDirectories.push(root);
      const paths = await installFakeGit(root);
      const databasePath = controlPlanePath(root);
      await mkdir(join(databasePath, ".."), {
        recursive: true,
        mode: 0o700,
      });
      await writeFile(databasePath, "not-a-database");
      const child = spawnGateway({
        cwd: join(import.meta.dir, "..", ".."),
        env: {
          HOME: root,
          HRA_CODEX_BIN: join(root, "must-not-open-codex"),
          HRA_GATEWAY_TEST_EFFECTIVE_HOME: root,
          HRA_GIT_BIN: paths.gitBinary,
          HRA_GIT_ROOT: paths.gitRoot,
          HRA_STARTUP_REMOVAL_RECOVERY: "1",
          PATH: "/usr/bin:/bin",
          TMPDIR: process.env.TMPDIR ?? tmpdir(),
        },
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      });
      const output = new GatewayOutputReader(child.stdout);
      await child.stdin.write(localDataRemovalRecoveryRequest(
        "native-removal-recovery",
      ));
      await output.readUntil(
        (lines) => hasBridgeResult(lines, "native-removal-recovery"),
        "the pathless recovery result",
      );
      expect(bridgeResult(
        output.currentLines(),
        "native-removal-recovery",
      )).toEqual({
        kind: "localDataRemovalRecoveryResult",
        version: 1,
        state: "clear",
        recoveredOperationCount: 0,
      });
      expect(runtimeEvents(output.currentLines())).toEqual([]);
      const databaseContents = await readFile(databasePath, "utf8");
      expect(databaseContents).toBe("not-a-database");

      await child.stdin.end();
      const [stderr, exitCode] = await Promise.all([
        new Response(child.stderr).text(),
        child.exited,
        output.readToEnd(),
      ]);
      expect(stderr).toBe("");
      expect(exitCode).toBe(0);
    },
    30_000,
  );

  test(
    "holds one control-plane authority for the gateway lifetime and recovers after a crash",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "oprte-gateway-lifetime-lock-"));
      temporaryDirectories.push(root);
      const paths = await installFakeGit(root);
      const environment = {
        HOME: root,
        HRA_CODEX_BIN: process.execPath,
        HRA_GIT_BIN: paths.gitBinary,
        HRA_GIT_ROOT: paths.gitRoot,
        PATH: "/usr/bin:/bin",
        TMPDIR: process.env.TMPDIR ?? tmpdir(),
      };
      const first = spawnGateway({
        cwd: join(import.meta.dir, "..", ".."),
        env: environment,
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      });
      const firstOutput = new GatewayOutputReader(first.stdout);
      await firstOutput.readUntil(
        (lines) => hasRuntimeState(lines, "ready"),
        "the first gateway became ready",
      );

      const databasePath = controlPlanePath(root);
      const keyPath = operationReceiptKeyPath(databasePath);
      const authorityBefore = readGatewayAuthorityState(root);
      const keyBefore = await stat(keyPath, { bigint: true });

      const second = spawnGateway({
        cwd: join(import.meta.dir, "..", ".."),
        env: environment,
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      });
      const secondOutput = new GatewayOutputReader(second.stdout);
      const [secondLines, secondError, secondExitCode] = await Promise.all([
        secondOutput.readToEnd(),
        new Response(second.stderr).text(),
        second.exited,
      ]);
      expect(secondError.length).toBeGreaterThan(0);
      expect(secondExitCode).not.toBe(0);
      expect(hasRuntimeState(secondLines, "ready")).toBeFalse();
      expect(hasRuntimeState(secondLines, "failed")).toBeFalse();
      expect(readGatewayAuthorityState(root)).toEqual(authorityBefore);
      const keyAfterContention = await stat(keyPath, { bigint: true });
      expect(keyAfterContention.size).toBe(keyBefore.size);
      expect(keyAfterContention.mtimeNs).toBe(keyBefore.mtimeNs);

      first.kill("SIGKILL");
      const [firstExitCode] = await Promise.all([
        first.exited,
        firstOutput.readToEnd(),
        new Response(first.stderr).text(),
      ]);
      expect(firstExitCode).not.toBe(0);
      collectClosedFixtureDatabaseReferences();

      const recovered = spawnGateway({
        cwd: join(import.meta.dir, "..", ".."),
        env: environment,
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      });
      const recoveredOutput = new GatewayOutputReader(recovered.stdout);
      await recoveredOutput.readUntil(
        (lines) => hasRuntimeState(lines, "ready"),
        "the replacement gateway became ready",
      );
      await recovered.stdin.end();
      const [recoveredLines, recoveredError, recoveredExitCode] =
        await Promise.all([
          recoveredOutput.readToEnd(),
          new Response(recovered.stderr).text(),
          recovered.exited,
        ]);
      expect(recoveredError).toBe("");
      expect(recoveredExitCode).toBe(0);
      expect(hasRuntimeState(recoveredLines, "ready")).toBeTrue();
      expect(
        readGatewayAuthorityState(root).dispatchInstallation.installation_id,
      ).toBe(authorityBefore.dispatchInstallation.installation_id);
    },
    30_000,
  );

  test(
    "continues terminal cleanup after the final local invalidation publication fails",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "oprte-gateway-shutdown-"));
      temporaryDirectories.push(root);
      const tracePath = join(root, "shutdown-cleanup.trace");
      const paths = await installFakeGit(root);
      const child = spawnGateway({
        cwd: join(import.meta.dir, "..", ".."),
        env: {
          HOME: root,
          HRA_CODEX_BIN: process.execPath,
          HRA_GATEWAY_TEST_CONTROL_PLANE_PATH: controlPlanePath(root),
          HRA_GATEWAY_TEST_SHUTDOWN_TRACE_PATH: tracePath,
          HRA_GIT_BIN: paths.gitBinary,
          HRA_GIT_ROOT: paths.gitRoot,
          PATH: "/usr/bin:/bin",
          TMPDIR: process.env.TMPDIR ?? tmpdir(),
        },
        testPreload: shutdownCleanupPreload,
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      });
      const output = new GatewayOutputReader(child.stdout);
      await output.readUntil(
        (lines) => hasRuntimeState(lines, "ready"),
        "the shutdown-fault gateway became ready",
      );

      await child.stdin.end();
      const [lines, stderr, exitCode] = await Promise.all([
        output.readToEnd(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      expect(hasRuntimeState(lines, "ready")).toBeTrue();
      expect(exitCode).not.toBe(0);
      // Bun renders the first AggregateError member for an uncaught aggregate.
      expect(stderr).toContain(
        "Final local task invalidation publication failed.",
      );
      const trace = (await readFile(tracePath, "utf8"))
        .trim()
        .split("\n");
      expect(trace).toEqual([
        "local-task-invalidation.publish.failed",
        "account-service.shutdown",
        "account-profile-filesystem.close",
        "projection.drain",
        "snapshot-transfers.dispose",
        "dispatch-transfers.dispose",
        "database.close",
        "lifetime-lock.reacquired",
        "writer.close",
      ]);
      expect(JSON.stringify(lines)).not.toContain(root);
    },
    30_000,
  );

  test(
    "retains the lifetime lock until exit when the control-plane database cannot close",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "oprte-gateway-shutdown-db-"));
      temporaryDirectories.push(root);
      const tracePath = join(root, "shutdown-database-close.trace");
      const paths = await installFakeGit(root);
      const databasePath = controlPlanePath(root);
      const child = spawnGateway({
        cwd: join(import.meta.dir, "..", ".."),
        env: {
          HOME: root,
          HRA_CODEX_BIN: process.execPath,
          HRA_GATEWAY_TEST_CONTROL_PLANE_PATH: databasePath,
          HRA_GATEWAY_TEST_FAIL_DATABASE_CLOSE: "1",
          HRA_GATEWAY_TEST_SHUTDOWN_TRACE_PATH: tracePath,
          HRA_GIT_BIN: paths.gitBinary,
          HRA_GIT_ROOT: paths.gitRoot,
          PATH: "/usr/bin:/bin",
          TMPDIR: process.env.TMPDIR ?? tmpdir(),
        },
        testPreload: shutdownCleanupPreload,
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      });
      const output = new GatewayOutputReader(child.stdout);
      try {
        await output.readUntil(
          (lines) => hasRuntimeState(lines, "ready"),
          "the database-close-fault gateway became ready",
        );
      } catch (error: unknown) {
        await child.stdin.end();
        const [lines, stderr, exitCode] = await Promise.all([
          output.readToEnd(),
          new Response(child.stderr).text(),
          child.exited,
        ]);
        throw new AggregateError(
          [error],
          `Database-close-fault startup exited ${String(exitCode)} with ` +
            `stdout=${JSON.stringify(lines)} stderr=${stderr}`,
        );
      }

      await child.stdin.end();
      const [lines, stderr, exitCode] = await Promise.all([
        output.readToEnd(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      expect(hasRuntimeState(lines, "ready")).toBeTrue();
      expect(exitCode).not.toBe(0);
      expect(stderr).toContain(
        "Final local task invalidation publication failed.",
      );
      const trace = (await readFile(tracePath, "utf8"))
        .trim()
        .split("\n");
      expect(trace).toEqual([
        "local-task-invalidation.publish.failed",
        "account-service.shutdown",
        "account-profile-filesystem.close",
        "projection.drain",
        "snapshot-transfers.dispose",
        "dispatch-transfers.dispose",
        "database.close.failed",
        "lifetime-lock.retained",
        "writer.close",
      ]);
      const postExitLock = acquireControlPlaneLifetimeLock(databasePath);
      postExitLock.release();
      expect(JSON.stringify(lines)).not.toContain(root);
    },
    30_000,
  );

  test(
    "onboards a trusted Native-selected Git root without exposing its path",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "oprte-gateway-onboarding-"));
      temporaryDirectories.push(root);
      const paths = await installFakeGit(root);
      const repositoryPath = join(root, "private-selected-repository");
      await mkdir(join(repositoryPath, ".git"), { recursive: true });
      const canonicalRepositoryPath = await realpath(repositoryPath);
      const child = spawnGateway({
        cwd: join(import.meta.dir, "..", ".."),
        env: {
          HOME: root,
          HRA_CODEX_BIN: process.execPath,
          HRA_GIT_BIN: paths.gitBinary,
          HRA_GIT_ROOT: paths.gitRoot,
          PATH: "/usr/bin:/bin",
          TMPDIR: process.env.TMPDIR ?? tmpdir(),
        },
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      });
      const output = new GatewayOutputReader(child.stdout);
      await output.readUntil(
        (lines) => hasRuntimeState(lines, "ready"),
        "the onboarding gateway became ready",
      );

      await child.stdin.write(projectOnboardingRequest(
        "native-onboard-first",
        repositoryPath,
        "Private workspace",
      ));
      await output.readUntil(
        (lines) => hasBridgeResult(lines, "native-onboard-first"),
        "the first onboarding response",
      );
      const first = bridgeResult(
        output.currentLines(),
        "native-onboard-first",
      );
      expect(first).toMatchObject({
        ok: true,
        value: {
          repository: { name: "private-selected-repository" },
          workspace: { name: "Private workspace", revision: 1 },
        },
      });
      expect(JSON.stringify(first)).not.toContain(root);
      expect(JSON.stringify(first)).not.toContain(canonicalRepositoryPath);

      await child.stdin.write(projectOnboardingRequest(
        "native-onboard-replay",
        repositoryPath,
        "Ignored replay candidate",
      ));
      await output.readUntil(
        (lines) => hasBridgeResult(lines, "native-onboard-replay"),
        "the replayed onboarding response",
      );
      expect(bridgeResult(
        output.currentLines(),
        "native-onboard-replay",
      )).toEqual(first);

      await child.stdin.write(taskDispatchRequest(
        "bridge-onboarded-workspaces",
        publicId("op", 8_100),
        { type: "task.workspaces.list" },
      ));
      await output.readUntil(
        (lines) => hasBridgeResult(lines, "bridge-onboarded-workspaces"),
        "the onboarded workspace list",
      );
      const workspaceList = parseRuntimeTaskDispatchResponse(bridgeResult(
        output.currentLines(),
        "bridge-onboarded-workspaces",
      ));
      expect(workspaceList).toMatchObject({
        ok: true,
        result: {
          type: "taskWorkspaceSummaries",
          workspaces: [{ name: "Private workspace" }],
        },
      });
      if (
        !workspaceList.ok
        || workspaceList.result.type !== "taskWorkspaceSummaries"
      ) {
        throw new Error("Onboarded workspace list was not successful");
      }
      const workspaceId = workspaceList.result.workspaces[0]?.id;
      if (workspaceId === undefined) throw new Error("Onboarded workspace disappeared");

      await child.stdin.write(taskDispatchRequest(
        "bridge-onboarded-repositories",
        publicId("op", 8_101),
        { type: "task.repositories.list", workspaceId },
      ));
      await output.readUntil(
        (lines) => hasBridgeResult(lines, "bridge-onboarded-repositories"),
        "the runtime-verified repository projection",
      );
      expect(parseRuntimeTaskDispatchResponse(bridgeResult(
        output.currentLines(),
        "bridge-onboarded-repositories",
      ))).toMatchObject({
        ok: true,
        result: {
          type: "taskRepositoryList",
          page: {
            workspaceId,
            repositories: [{
              name: "private-selected-repository",
              ready: true,
            }],
          },
        },
      });

      await child.stdin.write(taskDispatchRequest(
        "bridge-onboarded-context",
        publicId("op", 8_102),
        { type: "task.workspace.context", workspaceId },
      ));
      await output.readUntil(
        (lines) => hasBridgeResult(lines, "bridge-onboarded-context"),
        "the local execution context without cloud pairing",
      );
      expect(parseRuntimeTaskDispatchResponse(bridgeResult(
        output.currentLines(),
        "bridge-onboarded-context",
      ))).toMatchObject({
        ok: true,
        result: {
          type: "taskWorkspaceContext",
          context: {
            workspaceId,
            runner: {
              state: "blocked",
              reason: "no_account",
            },
          },
        },
      });

      await child.stdin.write(taskDispatchRequest(
        "bridge-onboarded-lookup",
        publicId("op", 8_103),
        {
          type: "task.lookup",
          workspaceId,
          taskKey: "OPS-7K2M4Q9",
        },
      ));
      await output.readUntil(
        (lines) => hasBridgeResult(lines, "bridge-onboarded-lookup"),
        "the local task lookup response",
      );
      expect(parseRuntimeTaskDispatchResponse(bridgeResult(
        output.currentLines(),
        "bridge-onboarded-lookup",
      ))).toMatchObject({
        ok: true,
        result: {
          type: "taskLookup",
          workspaceId,
          taskKey: "OPS-7K2M4Q9",
          task: null,
        },
      });

      await child.stdin.end();
      const [lines, stderr, exitCode] = await Promise.all([
        output.readToEnd(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      expect(stderr).toBe("");
      expect(exitCode).toBe(0);
      expect(runtimeEvents(lines).some(({ event }) =>
        event.type === "runner.changed"
        && event.runner.state === "notPaired"
      )).toBeTrue();
      expect(JSON.stringify(lines)).not.toContain(root);
      expect(JSON.stringify(lines)).not.toContain(canonicalRepositoryPath);

      const authority = new Database(controlPlanePath(root), {
        readonly: true,
        strict: true,
      });
      try {
        expect(authority.query<{
          canonical_repository_path: string;
          canonical_git_common_dir: string;
        }, []>(`
          SELECT canonical_repository_path, canonical_git_common_dir
          FROM local_repositories
        `).get()).toEqual({
          canonical_repository_path: canonicalRepositoryPath,
          canonical_git_common_dir: join(canonicalRepositoryPath, ".git"),
        });
        expect(authority.query<{ count: number }, []>(`
          SELECT count(*) AS count FROM local_workspaces
        `).get()?.count).toBe(1);
      } finally {
        authority.close();
      }
    },
    30_000,
  );

  test(
    "serves local task reads, mutations, invalidations, and chunk continuations over JSONL",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "oprte-gateway-local-tasks-"));
      temporaryDirectories.push(root);
      const canonicalRoot = await realpath(root);
      const paths = await installFakeGit(root);
      const databasePath = controlPlanePath(canonicalRoot);
      const workspaceId = publicId("wsp", 901);
      const repositoryId = publicId("repo", 902);
      const taskId = publicId("tsk", 903);
      const canonicalRepositoryPath = join(
        canonicalRoot,
        "private-repository",
      );
      const state = openControlPlane(databasePath, {
        releaseIdentity: hraReleaseIdentity,
      });
      try {
        const { installationId } =
          new DispatchRunnerInstallationStore(state).startBoot();
        const key = loadOrCreateOperationReceiptKey(
          operationReceiptKeyPath(databasePath),
        );
        const store = new LocalTaskStore(state, key);
        store.registerInstallation(installationId, 1);
        store.onboardProject({
          installationId,
          repository: {
            repositoryId,
            name: "Gateway fixture",
            canonicalRepositoryPath,
            canonicalGitCommonDir: join(canonicalRepositoryPath, ".git"),
          },
          workspace: {
            workspaceId,
            name: "Gateway workspace",
            slug: "gateway-workspace",
            keyPrefix: "GTW",
          },
        }, 2);
        const created = store.execute({
          kind: "task.create",
          operationId: publicId("op", 1_000),
          authority: {
            kind: "local_owner",
            workspaceId,
            installationId,
          },
          expectedWorkspaceRevision: 1,
          taskId,
          title: "Large local task",
          description: "Renderer-safe detail",
          type: "task",
          priority: 2,
          availableAt: 1,
          labels: [],
          repositoryId,
        }, undefined, 3);
        expect(created.outcome).toBe("committed");
        for (let index = 0; index < 50; index += 1) {
          const receipt = store.execute({
            kind: "task.comment_add",
            operationId: publicId("op", 1_001 + index),
            authority: {
              kind: "local_owner",
              workspaceId,
              installationId,
            },
            expectedWorkspaceRevision: 2 + index,
            taskId,
            body: `${String(index).padStart(2, "0")}:${"x".repeat(15_996)}`,
          }, undefined, 4 + index);
          expect(receipt.outcome).toBe("committed");
        }
      } finally {
        state.close();
      }
      collectClosedFixtureDatabaseReferences();
      await mkdir(join(canonicalRepositoryPath, ".git"), { recursive: true });

      const child = spawnGateway({
        cwd: join(import.meta.dir, "..", ".."),
        env: {
          HOME: root,
          HRA_CODEX_BIN: process.execPath,
          HRA_GIT_BIN: paths.gitBinary,
          HRA_GIT_ROOT: paths.gitRoot,
          PATH: "/usr/bin:/bin",
          TMPDIR: process.env.TMPDIR ?? tmpdir(),
        },
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      });
      const output = new GatewayOutputReader(child.stdout);
      await readGatewayOutputWithin(
        child,
        output,
        (lines) =>
          hasRuntimeState(lines, "ready") || hasRuntimeState(lines, "failed"),
        "a terminal task gateway startup state",
        50_000,
      );
      if (hasRuntimeState(output.currentLines(), "failed")) {
        throw new Error("The task gateway reported a failed startup state");
      }

      const gitInvocationsBeforeProjection = (await readFile(
        paths.invocationLog,
        "utf8",
      )).trim().split("\n").filter(Boolean).length;
      await child.stdin.write(taskDispatchRequest(
        "bridge-task-workspace-projection",
        "op_gateway_task_workspace_projection",
        {
          type: "task.workspace.projection",
          workspaceId,
          view: "all",
          selectedTaskId: null,
          minimumRevision: 52,
          limit: 100,
        },
      ));
      await output.readUntil(
        (lines) => hasBridgeResult(
          lines,
          "bridge-task-workspace-projection",
        ),
        "the atomic task workspace projection arrived",
      );
      expect(parseRuntimeTaskDispatchResponse(bridgeResult(
        output.currentLines(),
        "bridge-task-workspace-projection",
      ))).toMatchObject({
        ok: true,
        result: {
          type: "taskWorkspaceProjection",
          consistency: "atomic",
          presentation: {
            runner: {
              repositories: [{
                id: repositoryId,
                ready: true,
              }],
            },
            workspace: { id: workspaceId },
          },
          projection: {
            workspaceId,
            selectedTaskId: null,
            projectionRevision: 52,
            continuationRevision: 52,
            firstPage: {
              items: [{ task: { id: taskId } }],
            },
          },
        },
      });
      const projectionGitInvocations = (await readFile(
        paths.invocationLog,
        "utf8",
      )).trim().split("\n").filter(Boolean).slice(
        gitInvocationsBeforeProjection,
      );
      expect(projectionGitInvocations).toEqual([
        "config --null --name-only --list --no-includes",
        "rev-parse --show-toplevel",
        "config --null --name-only --list --no-includes",
        "rev-parse --git-common-dir",
      ]);

      const detailOperationId = "op_gateway_task_detail";
      await child.stdin.write(taskDispatchRequest(
        "bridge-task-detail-0",
        detailOperationId,
        { type: "task.detail", workspaceId, taskId },
      ));
      await output.readUntil(
        (lines) => hasBridgeResult(lines, "bridge-task-detail-0"),
        "the first task detail chunk arrived",
      );
      const firstResponse = parseRuntimeDispatchTransportResponse(
        bridgeResult(output.currentLines(), "bridge-task-detail-0"),
      );
      if (!("base64" in firstResponse)) {
        throw new Error("Large task detail did not use the chunk transport");
      }
      expect(firstResponse.count).toBeGreaterThan(1);

      await child.stdin.write(dispatchContinuationRequest(
        "bridge-task-detail-wrong-operation",
        "op_gateway_task_wrong",
        firstResponse.transferId,
        1,
      ));
      await output.readUntil(
        (lines) => hasBridgeResult(
          lines,
          "bridge-task-detail-wrong-operation",
        ),
        "the mismatched continuation was rejected",
      );
      const wrongContinuation = output.currentLines().find((line) =>
        typeof line === "object" &&
        line !== null &&
        "id" in line &&
        line.id === "bridge-task-detail-wrong-operation"
      );
      expect(wrongContinuation).toMatchObject({
        id: "bridge-task-detail-wrong-operation",
        ok: false,
        error: { code: "invalid_request" },
      });

      const chunks = [firstResponse];
      for (let index = 1; index < firstResponse.count; index += 1) {
        const bridgeId = `bridge-task-detail-${String(index)}`;
        await child.stdin.write(dispatchContinuationRequest(
          bridgeId,
          detailOperationId,
          firstResponse.transferId,
          index,
        ));
        await output.readUntil(
          (lines) => hasBridgeResult(lines, bridgeId),
          `task detail chunk ${String(index)} arrived`,
        );
        const chunk = parseRuntimeDispatchTransportResponse(
          bridgeResult(output.currentLines(), bridgeId),
        );
        if (!("base64" in chunk)) {
          throw new Error("Task detail continuation changed representation");
        }
        chunks.push(chunk);
      }
      for (const [index, chunk] of chunks.entries()) {
        expect(chunk).toMatchObject({
          operationId: detailOperationId,
          transferId: firstResponse.transferId,
          index,
          count: firstResponse.count,
        });
        const envelope = output.currentLines().find((line) =>
          typeof line === "object" &&
          line !== null &&
          "id" in line &&
          line.id === `bridge-task-detail-${String(index)}`
        );
        expect(Buffer.byteLength(JSON.stringify(envelope))).toBeLessThan(
          1024 * 1024,
        );
      }
      const detailBytes = Buffer.concat(
        chunks.map(({ base64 }) => Buffer.from(base64, "base64")),
      );
      const detailResponse = parseRuntimeTaskDispatchResponse(
        JSON.parse(detailBytes.toString("utf8")) as unknown,
      );
      if (
        !detailResponse.ok ||
        detailResponse.result.type !== "taskDetail"
      ) {
        throw new Error("Task detail response was not successful");
      }
      expect(detailResponse.result.detail.comments).toHaveLength(50);
      expect(detailResponse.result.detail.workspaceId).toBe(workspaceId);
      expect(detailResponse.result.detail.task.id).toBe(taskId);

      const mutationCommand = {
        type: "task.mutate",
        workspaceId,
        intent: {
          kind: "workspace.rename",
          operationId: publicId("op", 2_000),
          expectedWorkspaceRevision: 52,
          name: "Renamed gateway workspace",
        },
      } as const;
      const prepareMutationCommand = {
        type: "task.mutation.attempt.prepare",
        workspaceId,
        attemptId: mutationCommand.intent.operationId,
        commandKind: mutationCommand.intent.kind,
        fingerprint: `sha256_${createHash("sha256")
          .update(runtimeTaskMutationSemanticKey(
            mutationCommand.intent.kind,
            mutationCommand.intent,
          ))
          .digest("hex")}`,
      } as const;
      await child.stdin.write(taskDispatchRequest(
        "bridge-task-mutation-unprepared",
        "op_gateway_task_mutation_unprepared",
        mutationCommand,
      ));
      await output.readUntil(
        (lines) => hasBridgeResult(lines, "bridge-task-mutation-unprepared"),
        "the unprepared task mutation was rejected",
      );
      expect(parseRuntimeTaskDispatchResponse(bridgeResult(
        output.currentLines(),
        "bridge-task-mutation-unprepared",
      ))).toMatchObject({
        ok: false,
        error: {
          code: "operation_failed",
          retryable: false,
        },
      });
      await child.stdin.write(taskDispatchRequest(
        "bridge-task-mutation-prepare",
        "op_gateway_task_mutation_prepare",
        prepareMutationCommand,
      ));
      await output.readUntil(
        (lines) => hasBridgeResult(lines, "bridge-task-mutation-prepare"),
        "the task mutation attempt prepared",
      );
      expect(parseRuntimeTaskDispatchResponse(bridgeResult(
        output.currentLines(),
        "bridge-task-mutation-prepare",
      ))).toMatchObject({
        ok: true,
        result: {
          type: "taskMutationAttempt",
          attempt: {
            attemptId: mutationCommand.intent.operationId,
            revision: 1,
            state: "prepared",
          },
        },
      });
      await child.stdin.write(taskDispatchRequest(
        "bridge-task-mutation-start-drift",
        "op_gateway_task_mutation_start_drift",
        {
          type: "task.mutation.attempt.start",
          workspaceId,
          attemptId: mutationCommand.intent.operationId,
          expectedRevision: 1,
          intent: {
            ...mutationCommand.intent,
            name: "A different prepared workspace name",
          },
        },
      ));
      await output.readUntil(
        (lines) =>
          hasBridgeResult(lines, "bridge-task-mutation-start-drift"),
        "the drifted task mutation start was rejected",
      );
      expect(parseRuntimeTaskDispatchResponse(bridgeResult(
        output.currentLines(),
        "bridge-task-mutation-start-drift",
      ))).toMatchObject({
        ok: false,
        error: {
          code: "conflict",
          retryable: false,
        },
      });
      await child.stdin.write(taskDispatchRequest(
        "bridge-task-mutation-start",
        "op_gateway_task_mutation_start",
        {
          type: "task.mutation.attempt.start",
          workspaceId,
          attemptId: mutationCommand.intent.operationId,
          expectedRevision: 1,
          intent: mutationCommand.intent,
        },
      ));
      await output.readUntil(
        (lines) => hasBridgeResult(lines, "bridge-task-mutation-start"),
        "the task mutation effect started",
      );
      expect(parseRuntimeTaskDispatchResponse(bridgeResult(
        output.currentLines(),
        "bridge-task-mutation-start",
      ))).toMatchObject({
        ok: true,
        result: {
          type: "taskMutationAttempt",
          attempt: {
            attemptId: mutationCommand.intent.operationId,
            revision: 2,
            state: "effect_started",
          },
        },
      });
      await child.stdin.write(taskDispatchRequest(
        "bridge-task-mutation-drift",
        "op_gateway_task_mutation_drift",
        {
          ...mutationCommand,
          intent: {
            ...mutationCommand.intent,
            name: "A different started workspace name",
          },
        },
      ));
      await output.readUntil(
        (lines) => hasBridgeResult(lines, "bridge-task-mutation-drift"),
        "the drifted started task mutation was rejected",
      );
      expect(parseRuntimeTaskDispatchResponse(bridgeResult(
        output.currentLines(),
        "bridge-task-mutation-drift",
      ))).toMatchObject({
        ok: false,
        error: {
          code: "conflict",
          retryable: false,
        },
      });
      await child.stdin.write(taskDispatchRequest(
        "bridge-task-mutation",
        "op_gateway_task_mutation",
        mutationCommand,
      ));
      await output.readUntil(
        (lines) => hasBridgeResult(lines, "bridge-task-mutation"),
        "the task mutation committed",
      );
      const mutationResponse = parseRuntimeTaskDispatchResponse(
        bridgeResult(output.currentLines(), "bridge-task-mutation"),
      );
      expect(mutationResponse).toMatchObject({
        ok: true,
        result: {
          type: "taskMutation",
          mutation: {
            workspaceRevision: 53,
            projectionRevision: 53,
          },
        },
      });
      await child.stdin.write(taskDispatchRequest(
        "bridge-task-mutation-replay",
        "op_gateway_task_mutation_replay",
        mutationCommand,
      ));
      await output.readUntil(
        (lines) => hasBridgeResult(lines, "bridge-task-mutation-replay"),
        "the task mutation replay returned its receipt",
      );
      expect(parseRuntimeTaskDispatchResponse(bridgeResult(
        output.currentLines(),
        "bridge-task-mutation-replay",
      ))).toMatchObject({
        ok: true,
        result: {
          type: "taskMutation",
          mutation: {
            operationId: mutationCommand.intent.operationId,
            workspaceRevision: 53,
            projectionRevision: 53,
          },
        },
      });
      await child.stdin.write(taskDispatchRequest(
        "bridge-task-mutation-inspect",
        "op_gateway_task_mutation_inspect",
        {
          type: "task.mutation.attempt.inspect",
          workspaceId,
          attemptId: mutationCommand.intent.operationId,
          expectedRevision: 2,
        },
      ));
      await output.readUntil(
        (lines) => hasBridgeResult(lines, "bridge-task-mutation-inspect"),
        "the task mutation receipt was inspected",
      );
      expect(parseRuntimeTaskDispatchResponse(bridgeResult(
        output.currentLines(),
        "bridge-task-mutation-inspect",
      ))).toMatchObject({
        ok: true,
        result: {
          type: "taskMutationAttemptInspection",
          inspection: {
            attemptId: mutationCommand.intent.operationId,
            workspaceId,
            commandKind: mutationCommand.intent.kind,
            resolution: {
              outcome: "committed",
              mutation: {
                operationId: mutationCommand.intent.operationId,
                workspaceRevision: 53,
              },
            },
          },
        },
      });
      await child.stdin.write(taskDispatchRequest(
        "bridge-task-mutation-reconcile",
        "op_gateway_task_mutation_reconcile",
        {
          type: "task.mutation.attempt.reconcile",
          workspaceId,
          attemptId: mutationCommand.intent.operationId,
          expectedRevision: 2,
        },
      ));
      await output.readUntil(
        (lines) => hasBridgeResult(lines, "bridge-task-mutation-reconcile"),
        "the task mutation receipt reconciled",
      );
      expect(parseRuntimeTaskDispatchResponse(bridgeResult(
        output.currentLines(),
        "bridge-task-mutation-reconcile",
      ))).toMatchObject({
        ok: true,
        result: {
          type: "taskMutationReconciliation",
          reconciliation: {
            attemptId: mutationCommand.intent.operationId,
            workspaceId,
            commandKind: mutationCommand.intent.kind,
            resolution: {
              outcome: "committed",
              mutation: {
                operationId: mutationCommand.intent.operationId,
                workspaceRevision: 53,
              },
            },
          },
        },
      });

      await child.stdin.write(taskDispatchRequest(
        "bridge-task-workspaces",
        "op_gateway_task_workspaces",
        { type: "task.workspaces.list" },
      ));
      await output.readUntil(
        (lines) => hasBridgeResult(lines, "bridge-task-workspaces"),
        "the task workspace projection arrived",
      );
      await child.stdin.end();
      const [lines, stderr, exitCode] = await Promise.all([
        output.readToEnd(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      expect(stderr).toBe("");
      expect(exitCode).toBe(0);
      const workspaceResponse = parseRuntimeTaskDispatchResponse(
        bridgeResult(lines, "bridge-task-workspaces"),
      );
      expect(workspaceResponse).toMatchObject({
        ok: true,
        result: {
          type: "taskWorkspaceSummaries",
          workspaces: [{
            id: workspaceId,
            name: "Renamed gateway workspace",
            revision: 53,
          }],
        },
      });
      const invalidations = runtimeEvents(lines).filter(({ event }) =>
        event.type === "task.invalidated"
      );
      expect(invalidations).toHaveLength(1);
      expect(invalidations[0]?.event).toEqual({
        type: "task.invalidated",
        invalidation: {
          workspaceId,
          projectionRevision: 53,
          scope: "workspace",
        },
      });
      expect(JSON.stringify(lines)).not.toContain(root);
    },
    // This case intentionally persists an almost-megabyte projection before
    // boot and serially proves every continuation. The gateway startup join
    // remains independently bounded above; this outer budget covers fixture
    // work and cleanup under the repository's bounded test concurrency.
    165_000,
  );

  test(
    "browses an activated local recovery copy and rejects every scoped mutation",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "oprte-gateway-recovery-read-"));
      temporaryDirectories.push(root);
      const paths = await installFakeGit(root);
      const databasePath = controlPlanePath(root);
      const localWorkspaceId = publicId("wsp", 2_901);
      const cloudWorkspaceId = publicId("wsp", 2_902);
      const repositoryId = publicId("repo", 2_903);
      const taskId = publicId("tsk", 2_904);
      const promotionId = "promotion_01ARZ3NDEKTSV4RRFFQ69G5FAV";
      const state = openControlPlane(databasePath, {
        releaseIdentity: hraReleaseIdentity,
      });
      let installationId: string;
      try {
        ({ installationId } =
          new DispatchRunnerInstallationStore(state).startBoot());
        const key = loadOrCreateOperationReceiptKey(
          operationReceiptKeyPath(databasePath),
        );
        const store = new LocalTaskStore(state, key);
        store.registerInstallation(installationId, 1);
        store.onboardProject({
          installationId,
          repository: {
            repositoryId,
            name: "Retained project",
            canonicalRepositoryPath: join(root, "private-recovery-repository"),
            canonicalGitCommonDir: join(
              root,
              "private-recovery-repository",
              ".git",
            ),
          },
          workspace: {
            workspaceId: localWorkspaceId,
            name: "Recovered oprte",
            slug: "recovered-oprte",
            keyPrefix: "RCV",
          },
        }, 2);
        expect(store.execute({
          kind: "task.create",
          operationId: publicId("op", 2_905),
          authority: {
            kind: "local_owner",
            workspaceId: localWorkspaceId,
            installationId,
          },
          expectedWorkspaceRevision: 1,
          taskId,
          title: "Browse retained task",
          description: "Renderer-safe recovery detail",
          type: "task",
          priority: 1,
          availableAt: 1,
          labels: [],
          repositoryId,
        }, undefined, 3).outcome).toBe("committed");
        state.transaction(() => {
          state.query(`
            INSERT INTO local_promotion_sessions (
              promotion_id, schema_version, workspace_id, state,
              destination_organization_id, cloud_workspace_id,
              source_workspace_revision, source_event_sequence,
              created_at, updated_at
            ) VALUES (?1, 2, ?2, 'activated', 'org_recovery', ?3, 2, 2, 4, 4)
          `).run(promotionId, localWorkspaceId, cloudWorkspaceId);
          state.query(`
            UPDATE local_workspaces
            SET authority_kind = 'cloud', promotion_id = ?2,
              authority_phase = NULL, cloud_workspace_id = ?3, updated_at = 4
            WHERE workspace_id = ?1
          `).run(localWorkspaceId, promotionId, cloudWorkspaceId);
          state.query(`
            INSERT INTO local_promotion_recovery_copies (
              promotion_id, local_workspace_id, cloud_workspace_id,
              state, created_at, last_opened_at
            ) VALUES (?1, ?2, ?3, 'read_only', 4, 5)
          `).run(promotionId, localWorkspaceId, cloudWorkspaceId);
        })();
      } finally {
        state.close();
      }
      collectClosedFixtureDatabaseReferences();

      const child = spawnGateway({
        cwd: join(import.meta.dir, "..", ".."),
        env: {
          HOME: root,
          HRA_CODEX_BIN: process.execPath,
          HRA_GIT_BIN: paths.gitBinary,
          HRA_GIT_ROOT: paths.gitRoot,
          PATH: "/usr/bin:/bin",
          TMPDIR: process.env.TMPDIR ?? tmpdir(),
        },
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      });
      const output = new GatewayOutputReader(child.stdout);
      await readGatewayOutputWithin(
        child,
        output,
        (lines) =>
          hasRuntimeState(lines, "ready") || hasRuntimeState(lines, "failed"),
        "a terminal recovery gateway startup state",
        50_000,
      );
      if (hasRuntimeState(output.currentLines(), "failed")) {
        throw new Error("The recovery gateway reported a failed startup state");
      }
      await child.stdin.write(taskDispatchRequest(
        "bridge-recovery-open",
        publicId("op", 2_912),
        {
          type: "task.promotion.recovery.open",
          workspaceId: localWorkspaceId,
          promotionId,
        },
      ));
      await output.readUntil(
        (lines) => hasBridgeResult(lines, "bridge-recovery-open"),
        "the retained recovery selector arrived",
      );
      const opened = parseRuntimeTaskDispatchResponse(
        bridgeResult(output.currentLines(), "bridge-recovery-open"),
      );
      if (
        !opened.ok ||
        opened.result.type !== "taskPromotionRecovery" ||
        opened.result.recovery === null
      ) {
        throw new Error("Recovery copy did not open");
      }
      const recovery = opened.result.recovery;
      expect(recovery).toMatchObject({
        promotionId,
        localWorkspaceId,
        cloudWorkspaceId,
        access: "read_only",
      });
      await child.stdin.write(taskDispatchRequest(
        "bridge-recovery-projection",
        publicId("op", 2_913),
        {
          type: "task.workspace.projection",
          workspaceId: cloudWorkspaceId,
          recovery,
          view: "all",
          selectedTaskId: taskId,
          minimumRevision: 2,
          limit: 100,
        },
      ));
      await output.readUntil(
        (lines) => hasBridgeResult(lines, "bridge-recovery-projection"),
        "the atomic retained workspace projection arrived",
      );
      expect(parseRuntimeTaskDispatchResponse(
        bridgeResult(output.currentLines(), "bridge-recovery-projection"),
      )).toMatchObject({
        ok: true,
        result: {
          type: "taskWorkspaceProjection",
          consistency: "atomic",
          presentation: {
            capabilities: {
              canCreate: false,
              canEdit: false,
              canReview: false,
            },
            runner: {
              presence: { state: "offline" },
              repositories: [{
                id: repositoryId,
                ready: false,
              }],
            },
            workspace: { id: cloudWorkspaceId },
          },
          projection: {
            workspaceId: cloudWorkspaceId,
            selectedTaskId: taskId,
            detail: {
              workspaceId: cloudWorkspaceId,
              task: { id: taskId },
            },
          },
        },
      });
      await child.stdin.write(taskDispatchRequest(
        "bridge-recovery-list",
        publicId("op", 2_906),
        {
          type: "task.list",
          workspaceId: cloudWorkspaceId,
          recovery,
          view: "all",
          cursor: null,
          limit: 100,
        },
      ));
      await output.readUntil(
        (lines) => hasBridgeResult(lines, "bridge-recovery-list"),
        "the retained task list arrived",
      );
      expect(parseRuntimeTaskDispatchResponse(
        bridgeResult(output.currentLines(), "bridge-recovery-list"),
      )).toMatchObject({
        ok: true,
        result: {
          type: "taskListPage",
          page: {
            workspaceId: cloudWorkspaceId,
            items: [{ task: { id: taskId, title: "Browse retained task" } }],
          },
        },
      });

      await child.stdin.write(taskDispatchRequest(
        "bridge-recovery-context",
        publicId("op", 2_910),
        {
          type: "task.workspace.context",
          workspaceId: cloudWorkspaceId,
          recovery,
        },
      ));
      await output.readUntil(
        (lines) => hasBridgeResult(lines, "bridge-recovery-context"),
        "the retained workspace context arrived",
      );
      expect(parseRuntimeTaskDispatchResponse(
        bridgeResult(output.currentLines(), "bridge-recovery-context"),
      )).toMatchObject({
        ok: true,
        result: {
          type: "taskWorkspaceContext",
          context: {
            workspaceId: cloudWorkspaceId,
            capabilities: {
              canCreate: false,
              canEdit: false,
              canReview: false,
            },
            runner: { state: "offline" },
          },
        },
      });

      await child.stdin.write(taskDispatchRequest(
        "bridge-recovery-repositories",
        publicId("op", 2_911),
        {
          type: "task.repositories.list",
          workspaceId: cloudWorkspaceId,
          recovery,
        },
      ));
      await output.readUntil(
        (lines) => hasBridgeResult(lines, "bridge-recovery-repositories"),
        "the retained repository summaries arrived",
      );
      expect(parseRuntimeTaskDispatchResponse(
        bridgeResult(output.currentLines(), "bridge-recovery-repositories"),
      )).toMatchObject({
        ok: true,
        result: {
          type: "taskRepositoryList",
          page: {
            workspaceId: cloudWorkspaceId,
            repositories: [{
              id: repositoryId,
              name: "Retained project",
              ready: false,
            }],
          },
        },
      });

      await child.stdin.write(taskDispatchRequest(
        "bridge-recovery-detail",
        publicId("op", 2_907),
        {
          type: "task.detail",
          workspaceId: cloudWorkspaceId,
          recovery,
          taskId,
        },
      ));
      await output.readUntil(
        (lines) => hasBridgeResult(lines, "bridge-recovery-detail"),
        "the retained task detail arrived",
      );
      expect(parseRuntimeTaskDispatchResponse(
        bridgeResult(output.currentLines(), "bridge-recovery-detail"),
      )).toMatchObject({
        ok: true,
        result: {
          type: "taskDetail",
          detail: {
            workspaceId: cloudWorkspaceId,
            task: { id: taskId },
          },
        },
      });

      await child.stdin.write(taskDispatchRequest(
        "bridge-recovery-mutation",
        publicId("op", 2_908),
        {
          type: "task.mutate",
          workspaceId: cloudWorkspaceId,
          recovery,
          intent: {
            kind: "workspace.rename",
            operationId: publicId("op", 2_909),
            expectedWorkspaceRevision: 2,
            name: "Must not change",
          },
        },
      ));
      await output.readUntil(
        (lines) => hasBridgeResult(lines, "bridge-recovery-mutation"),
        "the recovery mutation was rejected",
      );
      expect(parseRuntimeTaskDispatchResponse(
        bridgeResult(output.currentLines(), "bridge-recovery-mutation"),
      )).toMatchObject({
        ok: false,
        error: {
          code: "policy_denied",
          message: "The retained local recovery copy is read-only.",
        },
      });

      await child.stdin.end();
      const [lines, stderr, exitCode] = await Promise.all([
        output.readToEnd(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      expect(stderr).toBe("");
      expect(exitCode).toBe(0);
      expect(JSON.stringify(lines)).not.toContain(
        join(root, "private-recovery-repository"),
      );
    },
    // The assertion path is normally sub-second once ready, but this test
    // source-spawns the complete gateway. Leave room for cold Bun compilation
    // and the repository's concurrent Turbo lane while retaining a bounded,
    // diagnostic startup deadline above.
    60_000,
  );

  test(
    "serves a recovering snapshot while a full startup admission page remains delayed",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "oprte-gateway-startup-tail-"));
      temporaryDirectories.push(root);
      const paths = await installFakeGit(root);
      const gatePath = join(root, "startup-recovery.gate");
      const enteredPath = join(root, "startup-recovery.entered");
      const workspaceId = publicId("wsp", 3_101);
      const repositoryId = publicId("repo", 3_102);
      const repositoryPath = join(root, "private-startup-repository");
      await Promise.all([
        writeFile(gatePath, "hold\n"),
        mkdir(join(repositoryPath, ".git"), { recursive: true }),
      ]);

      // Use a short-lived process to model the real predecessor-generation
      // boundary. Bun may keep finalized statement wrappers alive after
      // `Database.close()`, which correctly trips the gateway's fail-closed
      // cross-process SQLite ownership check when a fixture seeds in-process.
      const seed = trackTestProcess(Bun.spawn(
        [process.execPath, startupRecoverySeedFixture],
        {
          cwd: join(import.meta.dir, "..", ".."),
          env: {
            HOME: root,
            HRA_GATEWAY_TEST_STARTUP_SEED_HOME: root,
            HRA_GATEWAY_TEST_STARTUP_SEED_REPOSITORY_ID: repositoryId,
            HRA_GATEWAY_TEST_STARTUP_SEED_WORKSPACE_ID: workspaceId,
            PATH: "/usr/bin:/bin",
            TMPDIR: process.env.TMPDIR ?? tmpdir(),
          },
          stdout: "pipe",
          stderr: "pipe",
        },
      ));
      const seeded = await collectCompilerWithin(
        seed,
        15_000,
        "Startup recovery fixture seed",
      );
      if (seeded.exitCode !== 0 || seeded.stderr.length > 0) {
        throw new Error(
          `Startup recovery fixture failed: ${seeded.stdout}${seeded.stderr}`,
        );
      }

      const mutationIntent = {
        kind: "workspace.rename",
        operationId: publicId("op", 3_500),
        expectedWorkspaceRevision: 33,
        name: "Ready after recovery",
      } as const;
      const prepareCommand = {
        type: "task.mutation.attempt.prepare",
        workspaceId,
        attemptId: mutationIntent.operationId,
        commandKind: mutationIntent.kind,
        fingerprint: `sha256_${createHash("sha256")
          .update(runtimeTaskMutationSemanticKey(
            mutationIntent.kind,
            mutationIntent,
          ))
          .digest("hex")}`,
      } as const;
      const child = spawnGateway({
        cwd: join(import.meta.dir, "..", ".."),
        env: {
          HOME: root,
          HRA_CODEX_BIN: process.execPath,
          HRA_GATEWAY_TEST_STARTUP_RECOVERY_ENTERED: enteredPath,
          HRA_GATEWAY_TEST_STARTUP_RECOVERY_GATE: gatePath,
          HRA_GIT_BIN: paths.gitBinary,
          HRA_GIT_ROOT: paths.gitRoot,
          PATH: "/usr/bin:/bin",
          TMPDIR: process.env.TMPDIR ?? tmpdir(),
        },
        testPreload: startupRecoveryDelayPreload,
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      });
      const output = new GatewayOutputReader(child.stdout);
      await child.stdin.write([
        snapshotRequest("bridge-startup-recovering"),
        taskDispatchRequest(
          "bridge-startup-mutation-held",
          "op_startup_mutation_held",
          prepareCommand,
        ),
      ].join(""));
      await readGatewayOutputWithin(
        child,
        output,
        (lines) =>
          hasBridgeResult(lines, "bridge-startup-recovering") &&
          hasBridgeResult(lines, "bridge-startup-mutation-held"),
        "the recovering snapshot and deferred mutation response",
        15_000,
      );

      expect(await readFile(enteredPath, "utf8")).toBe("queued_run\n");
      expect(child.exitCode).toBeNull();
      expect(parseRuntimeSnapshotResponse(bridgeResult(
        output.currentLines(),
        "bridge-startup-recovering",
      )).snapshot).toMatchObject({
        runtime: { state: "ready" },
        runner: { state: "recovering" },
      });
      expect(parseRuntimeTaskDispatchResponse(bridgeResult(
        output.currentLines(),
        "bridge-startup-mutation-held",
      ))).toMatchObject({
        ok: false,
        error: {
          code: "runtime_unavailable",
          retryable: true,
          action: "retry",
        },
      });

      await rm(gatePath);
      await readGatewayOutputWithin(
        child,
        output,
        hasCompletedLocalRunnerRecovery,
        "the local runner recovery completion",
        10_000,
      );
      await child.stdin.write(taskDispatchRequest(
        "bridge-startup-mutation-ready",
        "op_startup_mutation_ready",
        prepareCommand,
      ));
      await output.readUntil(
        (lines) => hasBridgeResult(lines, "bridge-startup-mutation-ready"),
        "the post-recovery mutation preparation",
      );
      expect(parseRuntimeTaskDispatchResponse(bridgeResult(
        output.currentLines(),
        "bridge-startup-mutation-ready",
      ))).toMatchObject({
        ok: true,
        result: {
          type: "taskMutationAttempt",
          attempt: { state: "prepared" },
        },
      });

      await child.stdin.end();
      const [stderr, exitCode] = await Promise.all([
        new Response(child.stderr).text(),
        child.exited,
        output.readToEnd(),
      ]);
      expect(stderr).toBe("");
      expect(exitCode).toBe(0);
    },
    45_000,
  );

  test(
    "reconciles deferred work once across clean gateway restarts",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "oprte-gateway-due-work-"));
      temporaryDirectories.push(root);
      const paths = await installFakeGit(root);
      const databasePath = controlPlanePath(root);
      const workspaceId = publicId("wsp", 3_001);
      const repositoryId = publicId("repo", 3_002);
      const taskId = publicId("tsk", 3_003);
      const state = openControlPlane(databasePath, {
        releaseIdentity: hraReleaseIdentity,
      });
      try {
        const { installationId } =
          new DispatchRunnerInstallationStore(state).startBoot();
        const store = new LocalTaskStore(
          state,
          loadOrCreateOperationReceiptKey(
            operationReceiptKeyPath(databasePath),
          ),
        );
        store.registerInstallation(installationId, 1);
        store.onboardProject({
          installationId,
          repository: {
            repositoryId,
            name: "Due-work fixture",
            canonicalRepositoryPath: join(root, "private-due-repository"),
            canonicalGitCommonDir: join(
              root,
              "private-due-repository",
              ".git",
            ),
          },
          workspace: {
            workspaceId,
            name: "Due-work workspace",
            slug: "due-work-workspace",
            keyPrefix: "DUE",
          },
        }, 1);
        expect(store.execute({
          kind: "task.create",
          operationId: publicId("op", 3_010),
          authority: {
            kind: "local_owner",
            workspaceId,
            installationId,
          },
          expectedWorkspaceRevision: 1,
          taskId,
          title: "Wake exactly once",
          description: "",
          type: "task",
          priority: 2,
          availableAt: 1,
          labels: [],
          repositoryId,
        }, undefined, 2).outcome).toBe("committed");
        expect(store.execute({
          kind: "task.defer",
          operationId: publicId("op", 3_011),
          authority: {
            kind: "local_owner",
            workspaceId,
            installationId,
          },
          expectedWorkspaceRevision: 2,
          taskId,
          expectedTaskRevision: 1,
          availableAt: 10,
        }, undefined, 3).outcome).toBe("committed");
      } finally {
        state.close();
      }
      collectClosedFixtureDatabaseReferences();

      const environment = {
        HOME: root,
        HRA_CODEX_BIN: process.execPath,
        HRA_GIT_BIN: paths.gitBinary,
        HRA_GIT_ROOT: paths.gitRoot,
        PATH: "/usr/bin:/bin",
        TMPDIR: process.env.TMPDIR ?? tmpdir(),
      };
      const runGateway = async (): Promise<readonly unknown[]> => {
        const child = spawnGateway({
          cwd: join(import.meta.dir, "..", ".."),
          env: environment,
          stdin: "pipe",
          stdout: "pipe",
          stderr: "pipe",
        });
        const output = new GatewayOutputReader(child.stdout);
        await output.readUntil(
          (lines) =>
            hasRuntimeState(lines, "ready") &&
            hasCompletedLocalRunnerRecovery(lines),
          "the due-work gateway completed local runner recovery",
        );
        await child.stdin.end();
        const [lines, stderr, exitCode] = await Promise.all([
          output.readToEnd(),
          new Response(child.stderr).text(),
          child.exited,
        ]);
        expect(stderr).toBe("");
        expect(exitCode).toBe(0);
        return lines;
      };

      const firstLines = await runGateway();
      expect(runtimeEvents(firstLines).filter(({ event }) =>
        event.type === "task.invalidated"
      ).map(({ event }) => event)).toEqual([{
        type: "task.invalidated",
        invalidation: {
          workspaceId,
          projectionRevision: 4,
          scope: "workspace",
        },
      }]);
      const authorityAfterFirst = new Database(databasePath, {
        readonly: true,
        strict: true,
      });
      const firstDomainState = authorityAfterFirst.query(`
        SELECT
          local_workspaces.revision AS workspace_revision,
          local_workspaces.event_sequence,
          local_tasks.revision AS task_revision,
          local_due_work.state AS due_state,
          local_due_work.attempt_count,
          local_due_work.claimed_boot_generation,
          local_due_work.claimed_at,
          (SELECT count(*) FROM local_operation_receipts) AS receipt_count,
          (SELECT count(*) FROM local_workspace_events) AS event_count
        FROM local_workspaces
        JOIN local_tasks USING (workspace_id)
        JOIN local_due_work USING (workspace_id)
        WHERE local_workspaces.workspace_id = ?1
          AND local_due_work.work_kind = 'defer_wake'
      `).get(workspaceId);
      authorityAfterFirst.close();
      collectClosedFixtureDatabaseReferences();
      expect(firstDomainState).toEqual({
        workspace_revision: 4,
        event_sequence: 4,
        task_revision: 3,
        due_state: "done",
        attempt_count: 1,
        claimed_boot_generation: null,
        claimed_at: null,
        receipt_count: 3,
        event_count: 4,
      });

      const secondLines = await runGateway();
      expect(runtimeEvents(secondLines).some(({ event }) =>
        event.type === "task.invalidated"
      )).toBeFalse();
      const authorityAfterSecond = new Database(databasePath, {
        readonly: true,
        strict: true,
      });
      const secondDomainState = authorityAfterSecond.query(`
        SELECT
          local_workspaces.revision AS workspace_revision,
          local_workspaces.event_sequence,
          local_tasks.revision AS task_revision,
          local_due_work.state AS due_state,
          local_due_work.attempt_count,
          local_due_work.claimed_boot_generation,
          local_due_work.claimed_at,
          (SELECT count(*) FROM local_operation_receipts) AS receipt_count,
          (SELECT count(*) FROM local_workspace_events) AS event_count
        FROM local_workspaces
        JOIN local_tasks USING (workspace_id)
        JOIN local_due_work USING (workspace_id)
        WHERE local_workspaces.workspace_id = ?1
          AND local_due_work.work_kind = 'defer_wake'
      `).get(workspaceId);
      authorityAfterSecond.close();
      expect(secondDomainState).toEqual(firstDomainState);
      expect(JSON.stringify([...firstLines, ...secondLines])).not.toContain(root);
    },
    30_000,
  );

  test.skipIf(process.platform !== "darwin" || process.arch !== "arm64")(
    "initializes pinned Codex and Git and returns a renderer-safe atomic snapshot",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "oprte-gateway-test-"));
      temporaryDirectories.push(root);
      const codexHome = join(root, "codex-home");
      const paths = resolveRuntimePaths({ ...process.env, HRA_CODEX_HOME: codexHome });
      const child = spawnGateway({
        cwd: join(import.meta.dir, "..", ".."),
        env: {
          HOME: root,
          HRA_CODEX_BIN: paths.codexBinary,
          HRA_CODEX_HOME: codexHome,
          HRA_GIT_BIN: paths.gitBinary,
          HRA_GIT_ROOT: paths.gitRoot,
          PATH: "/usr/bin:/bin",
          TMPDIR: process.env.TMPDIR ?? tmpdir(),
        },
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      });
      const output = new GatewayOutputReader(child.stdout);
      await output.readUntil(
        (lines) => hasRuntimeState(lines, "ready"),
        "the pinned-runtime gateway became ready",
      );
      await child.stdin.write(snapshotRequest("bridge-test"));
      await child.stdin.end();

      const [lines, stderr, exitCode] = await Promise.all([
        output.readToEnd(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      expect(stderr).toBe("");
      expect(exitCode).toBe(0);
      const events = runtimeEvents(lines);
      const snapshot = parseRuntimeSnapshotResponse(bridgeResult(lines, "bridge-test")).snapshot;
      expectContinuousSequences(events);
      expect(events.some(({ event }) =>
        event.type === "runtime.changed" && event.runtime.state === "ready"
      )).toBeTrue();
      expect(snapshot.runtime).toEqual({
        state: "ready",
        generation: 1,
      });
      expect(snapshot.lastSequence).toBeGreaterThan(0);
      expect(JSON.stringify(snapshot)).not.toContain("codexHome");
      expect(JSON.stringify(snapshot)).not.toContain(codexHome);
    },
    30_000,
  );
});
