import { createHash } from "node:crypto";
import { resolve } from "node:path";

import { describe, expect, test } from "bun:test";

import { HRA_VERSION } from "../src/version";
import {
  BoundedProcessCleanupUnprovenError,
  BoundedProcessContainmentUnavailableError,
} from "./bounded-process";
import type { CommandRequest, CommandResult } from "./configure-hosted-sync";
import { HRA_CONVEX_PROJECT_ID, HRA_CONVEX_TEAM_ID, type ConvexTarget } from "./convex-target";
import {
  MEMORY_READBACK_INPUT_MAXIMUM_BYTES,
  memoryReadbackCliArguments,
  parseMemoryReadbackInput,
  readMemoryReadbackInput,
  type MemoryReadbackOperation,
} from "./live-acceptance-memory-readback-child";
import {
  createLiveAcceptanceMemoryReadback,
  liveMemoryErasureObservationSchema,
  liveMemoryQuotaObservationSchema,
} from "./live-acceptance-memory-readback";

const target: ConvexTarget = {
  deploymentId: 7_654_321,
  deploymentName: "steady-otter-321",
  deploymentUrl: "https://steady-otter-321.convex.cloud",
  projectId: HRA_CONVEX_PROJECT_ID,
  teamId: HRA_CONVEX_TEAM_ID,
};
const candidate = {
  cloudTargetDigest: createHash("sha256").update(target.deploymentUrl).digest("hex"),
  packageVersion: HRA_VERSION,
  sourceRevision: "a".repeat(40),
};
const devices = ["018bcfe5-6800-7000-8000-000000000931", "018bcfe5-6800-7000-8000-000000000932"] as const;
const userId = "disposable-user-identity";
const signal = (): AbortSignal => new AbortController().signal;
const bytes = (value: unknown): Uint8Array => new TextEncoder().encode(JSON.stringify(value));
const input = (operation: MemoryReadbackOperation): Uint8Array => bytes({ operation, target, version: 1 });
const ok = (value: unknown): CommandResult => ({ exitCode: 0, stderr: "", stdout: JSON.stringify(value) });
const categories = ["identity", "device", "account", "session", "chunk", "usage", "command", "custody", "receipt", "security", "job", "memory"];
const quotaRows = (memoryBytes = 300, memoryRecords = 4) => categories.map((category) => ({
  category,
  logicalBytes: category === "memory" ? memoryBytes : 0,
  records: category === "memory" ? memoryRecords : 0,
  updatedAt: 1,
}));
const page = (table: "memorySpaces" | "memoryOperations", records: number, logicalBytes: number,
  cursor = "", isDone = true) => ({ category: "memory", continueCursor: cursor, isDone, logicalBytes, records, table });
const populated = () => [ok(quotaRows()), ok(page("memorySpaces", 1, 100)), ok(page("memoryOperations", 3, 200)), ok(quotaRows())];
const erased = () => [ok([]), ok(page("memorySpaces", 0, 0)), ok(page("memoryOperations", 0, 0)), ok([])];

function fixture(results: CommandResult[] = [ok({ userId }), ...populated(), ...erased()],
  change: Readonly<{ failTargetAt?: number; failRuntimeAt?: number; runnerError?: Error }> = {}) {
  const requests: CommandRequest[] = [];
  const ordering: string[] = [];
  let targetChecks = 0;
  let runtimeChecks = 0;
  const port = createLiveAcceptanceMemoryReadback({
    candidate,
    environment: { HOME: "/fixture-home", PATH: "/fixture-bin", XDG_CONFIG_HOME: userId },
    runner: async (request) => {
      requests.push(request);
      ordering.push("run");
      if (change.runnerError !== undefined) throw change.runnerError;
      const result = results.shift();
      if (result === undefined) throw new Error("unexpected_fixture_call");
      return result;
    },
    target,
    verifyRuntime: async () => {
      ordering.push("runtime");
      runtimeChecks += 1;
      if (change.failRuntimeAt === runtimeChecks) throw new Error("runtime_changed");
    },
    verifyTarget: async (observed) => {
      expect(observed).toEqual(target);
      ordering.push("target");
      targetChecks += 1;
      if (change.failTargetAt === targetChecks) throw new Error("target_changed");
    },
  });
  return { ordering, port, requests, results };
}

describe("live memory operator stdin protocol", () => {
  test("maps four closed operations to exact pinned CLI functions and deployment", () => {
    const bind = memoryReadbackCliArguments(input({ devicePublicIds: [...devices], kind: "bind_devices" }));
    expect(bind.slice(0, 2)).toEqual(["run", "--inline-query"]);
    expect(bind.at(-2)).toBe("--deployment");
    expect(bind.at(-1)).toBe(target.deploymentName);
    expect(bind[2]).toContain('.take(2)');
    expect(bind[2]).toContain('a.userId !== b.userId');
    expect(bind[2]).toContain('a._id === b._id');
    expect(bind[2]).toContain('a.status !== "active"');
    expect(bind[2]).toContain('b.deviceClass !== "daemon"');
    expect(bind[2]).toContain('return { userId: a.userId }');
    expect(memoryReadbackCliArguments(input({ kind: "read_category", userId }))).toEqual([
      "run", "quota:readUser", JSON.stringify({ userId }), "--deployment", target.deploymentName,
    ]);
    for (const [kind, table] of [["audit_memory_spaces", "memorySpaces"], ["audit_memory_operations", "memoryOperations"]] as const) {
      const argv = memoryReadbackCliArguments(input({ cursor: 'opaque"cursor', kind, userId }));
      expect(argv).toEqual(["run", "quota:auditDirectTablePage", JSON.stringify({
        paginationOpts: { cursor: 'opaque"cursor', numItems: 200 }, table, userId,
      }), "--deployment", target.deploymentName]);
      for (const forbidden of ["--push", "--watch", "--identity", "--component", "--prod"]) {
        expect(argv).not.toContain(forbidden);
      }
    }
  });

  test("rejects selectors, duplicate devices, malformed bytes, extra frames and oversized input", () => {
    const valid = { operation: { kind: "read_category", userId }, target, version: 1 };
    const badInputs = [
      bytes({ ...valid, executable: "anything" }),
      bytes({ ...valid, operation: { kind: "run", userId } }),
      bytes({ ...valid, operation: { kind: "read_category", function: "auth:delete", userId } }),
      bytes({ ...valid, operation: { kind: "read_category", userId: 'x";bad()' } }),
      bytes({ ...valid, operation: { kind: "bind_devices", devicePublicIds: [devices[0], devices[0]] } }),
      bytes({ ...valid, operation: { kind: "bind_devices", devicePublicIds: [devices[0], '";bad()'] } }),
      bytes({ ...valid, target: { ...target, deploymentName: "--push" } }),
      bytes({ ...valid, operation: { kind: "audit_memory_spaces", cursor: "x".repeat(16 * 1024 + 1), userId } }),
      new TextEncoder().encode(`${JSON.stringify(valid)}\n${JSON.stringify(valid)}`),
      new Uint8Array([0xff]),
      new Uint8Array(MEMORY_READBACK_INPUT_MAXIMUM_BYTES + 1),
    ];
    for (const invalid of badInputs) expect(() => memoryReadbackCliArguments(invalid)).toThrow("memory_readback_input_invalid");
  });

  test("waits for one complete bounded stdin document and rejects a stalled or overflowing stream", async () => {
    const document = input({ kind: "read_category", userId });
    const stream = new ReadableStream<Uint8Array>({ start(controller) {
      controller.enqueue(document.subarray(0, 5));
      controller.enqueue(document.subarray(5));
      controller.close();
    } });
    expect(await readMemoryReadbackInput(stream)).toEqual(document);
    await expect(readMemoryReadbackInput(new ReadableStream<Uint8Array>(), 5)).rejects.toThrow("memory_readback_input_invalid");
    const overflowing = new ReadableStream<Uint8Array>({ start(controller) {
      controller.enqueue(new Uint8Array(MEMORY_READBACK_INPUT_MAXIMUM_BYTES + 1));
    } });
    await expect(readMemoryReadbackInput(overflowing)).rejects.toThrow("memory_readback_input_invalid");
  });

  test("the real child consumes stdin EOF and refuses empty or malformed input before Convex", async () => {
    for (const document of ["", '{"unreviewed":"input"}\n']) {
      const child = Bun.spawn([process.execPath, resolve(import.meta.dir, "live-acceptance-memory-readback-child.ts")], {
        cwd: resolve(import.meta.dir, ".."),
        env: { PATH: "/usr/bin:/bin" },
        stdin: "pipe", stdout: "pipe", stderr: "pipe",
      });
      const timer = setTimeout(() => child.kill("SIGKILL"), 2_000);
      try {
        await child.stdin.write(document);
        await child.stdin.end();
        const [exitCode, stdout, stderr] = await Promise.all([
          child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
        ]);
        expect(exitCode).toBe(1);
        expect(stdout).toBe("");
        expect(stderr).toBe("memory_readback_child_failed\n");
      } finally {
        clearTimeout(timer);
        child.kill("SIGKILL");
        await child.exited;
      }
    }
  });
});

describe("live memory quota and erasure readback", () => {
  test("proves exact account counters and post-delete absence without private IDs in argv or evidence", async () => {
    const f = fixture();
    await f.port.bindDevices(devices, signal());
    const before = await f.port.observePopulated(3, signal());
    const after = await f.port.observeErased(signal());
    expect(before).toEqual({ logicalBytes: 300, operationRecords: 3, quotaMatches: true, records: 4, spaceRecords: 1 });
    expect(after).toEqual({ logicalBytes: 0, operationRecords: 0, quotaCategory: "absent", records: 0, spaceRecords: 0 });
    expect(liveMemoryQuotaObservationSchema.parse(before)).toEqual(before);
    expect(liveMemoryErasureObservationSchema.parse(after)).toEqual(after);
    expect(JSON.stringify({ before, after })).not.toContain(userId);
    expect(f.results).toHaveLength(0);
    expect(f.requests).toHaveLength(9);
    expect(f.ordering).toEqual(Array.from({ length: 9 }, () => ["target", "runtime", "run", "target", "runtime"]).flat());
    for (const request of f.requests) {
      expect(request.arguments).toHaveLength(1);
      expect(request.arguments[0]).toEndWith("/scripts/live-acceptance-memory-readback-child.ts");
      expect(JSON.stringify(request.arguments)).not.toContain(userId);
      expect(request.containment).toBe("authority");
      expect(request.timeoutMs).toBe(60_000);
      expect(request.outputMaximumBytes).toBe(64 * 1024);
      const parsed = parseMemoryReadbackInput(new TextEncoder().encode(request.stdin));
      if (parsed.operation.kind !== "bind_devices") {
        expect(parsed.operation.userId).toBe(userId);
        expect(JSON.stringify(request.environment)).not.toContain(userId);
      }
    }
    await expect(f.port.observeErased(signal())).rejects.toThrow("live_memory_readback_refused");
  });

  test("follows bounded cursor pages and adds their exact bytes and records", async () => {
    const f = fixture([ok({ userId }), ok(quotaRows()), ok(page("memorySpaces", 1, 100)),
      ok(page("memoryOperations", 1, 75, "cursor-1", false)),
      ok(page("memoryOperations", 2, 125)), ok(quotaRows())]);
    await f.port.bindDevices(devices, signal());
    expect((await f.port.observePopulated(3, signal())).operationRecords).toBe(3);
    expect(parseMemoryReadbackInput(new TextEncoder().encode(f.requests[4]!.stdin)).operation)
      .toEqual({ cursor: "cursor-1", kind: "audit_memory_operations", userId });
  });

  test("rejects drift, missing or duplicate categories, mismatched rows and repeated cursors", async () => {
    const cases = [
      [ok(quotaRows()), ok(page("memorySpaces", 1, 100)), ok(page("memoryOperations", 3, 200)), ok(quotaRows(301))],
      [ok(quotaRows().filter((row) => row.category !== "memory")), ...populated().slice(1)],
      [ok([...quotaRows().slice(0, -1), quotaRows()[0]])],
      [ok(quotaRows()), ok(page("memorySpaces", 2, 100)), ok(page("memoryOperations", 3, 200)), ok(quotaRows())],
      [ok(quotaRows()), ok(page("memorySpaces", 1, 100)), ok(page("memoryOperations", 4, 200)), ok(quotaRows())],
      [ok(quotaRows()), ok(page("memoryOperations", 1, 100))],
      [ok(quotaRows()), ok(page("memorySpaces", 201, 100))],
      [ok(quotaRows()), ok(page("memorySpaces", 1, 100, "repeat", false)), ok(page("memorySpaces", 0, 0, "repeat", false))],
      [ok(quotaRows()), ...Array.from({ length: 4 }, (_, index) => ok(page("memorySpaces", 1, 100, `cursor-${index}`, false)))],
    ];
    for (const results of cases) {
      const f = fixture([ok({ userId }), ...results]);
      await f.port.bindDevices(devices, signal());
      await expect(f.port.observePopulated(3, signal())).rejects.toThrow("live_memory_readback_refused");
      const count = f.requests.length;
      await expect(f.port.observeErased(signal())).rejects.toThrow("live_memory_readback_refused");
      expect(f.requests).toHaveLength(count);
    }
  });

  test("never infers erasure from vanished devices or absent quota alone", async () => {
    const remnants = [
      [ok(quotaRows())],
      [ok([]), ok(page("memorySpaces", 1, 100)), ok(page("memoryOperations", 0, 0)), ok([])],
      [ok([]), ok(page("memorySpaces", 0, 0)), ok(page("memoryOperations", 1, 200)), ok([])],
      [ok([]), ok(page("memorySpaces", 0, 0)), ok(page("memoryOperations", 0, 1)), ok([])],
      [ok([]), ok(page("memorySpaces", 0, 0)), ok(page("memoryOperations", 0, 0)), ok(quotaRows(0, 0))],
    ];
    for (const result of remnants) {
      // Supply complete reads even for a before-quota remnant: no early success.
      const complete = result.length === 1 ? [...result, ...erased().slice(1)] : result;
      const f = fixture([ok({ userId }), ...populated(), ...complete]);
      await f.port.bindDevices(devices, signal());
      await f.port.observePopulated(3, signal());
      await expect(f.port.observeErased(signal())).rejects.toThrow("live_memory_readback_refused");
    }
  });

  test("rejects vendor noise, malformed results, nonzero child exit, and oversized output without echoing it", async () => {
    for (const result of [
      { exitCode: 1, stderr: userId, stdout: "" },
      { exitCode: 0, stderr: "vendor notice", stdout: JSON.stringify({ userId }) },
      { exitCode: 0, stderr: "", stdout: `${JSON.stringify({ userId })}\nlog` },
      { exitCode: 0, stderr: "", stdout: "x".repeat(64 * 1024 + 1) },
      ok({ userId, raw: "unreviewed" }), ok({ userId: "bad/id" }),
    ]) {
      const f = fixture([result]);
      await expect(f.port.bindDevices(devices, signal())).rejects.toThrow("live_memory_readback_refused");
      expect(f.ordering).toEqual(["target", "runtime", "run", "target", "runtime"]);
    }
  });

  test("checks runtime and exact default target before and after every invocation", async () => {
    for (const change of [{ failTargetAt: 1 }, { failRuntimeAt: 1 }, { failTargetAt: 2 }, { failRuntimeAt: 2 }]) {
      const f = fixture([ok({ userId })], change);
      await expect(f.port.bindDevices(devices, signal())).rejects.toThrow();
      expect(f.requests).toHaveLength(change.failTargetAt === 1 || change.failRuntimeAt === 1 ? 0 : 1);
      await expect(f.port.observePopulated(3, signal())).rejects.toThrow("live_memory_readback_refused");
    }
  });

  test.skipIf(process.platform === "linux")("the default readback runner requires real authority containment", async () => {
    const ordering: string[] = [];
    const port = createLiveAcceptanceMemoryReadback({
      candidate,
      target,
      verifyTarget: async () => { ordering.push("target"); },
      verifyRuntime: async () => { ordering.push("runtime"); },
    });
    try {
      await expect(port.bindDevices(devices, signal()))
        .rejects.toBeInstanceOf(BoundedProcessContainmentUnavailableError);
      expect(ordering).toEqual(["target", "runtime"]);
    } finally {
      port.close();
    }
  });

  test("does not perform postflight effects after unproven process cleanup", async () => {
    const failure = new BoundedProcessCleanupUnprovenError(123, "fixture");
    const f = fixture([], { runnerError: failure });
    await expect(f.port.bindDevices(devices, signal())).rejects.toBe(failure);
    expect(f.ordering).toEqual(["target", "runtime", "run"]);
  });

  test("refuses stale candidate, out-of-order reads and aborts before operator effects", async () => {
    expect(() => createLiveAcceptanceMemoryReadback({
      candidate: { ...candidate, cloudTargetDigest: "0".repeat(64) }, target,
      verifyRuntime: async () => undefined,
    })).toThrow("live_memory_readback_refused");
    const f = fixture();
    await expect(f.port.observeErased(signal())).rejects.toThrow("live_memory_readback_refused");
    expect(f.requests).toHaveLength(0);
    const aborted = new AbortController();
    aborted.abort();
    const other = fixture();
    await expect(other.port.bindDevices(devices, aborted.signal)).rejects.toThrow("live_memory_readback_refused");
    expect(other.requests).toHaveLength(0);
  });

  test("rejects duplicate device bindings before reading operator authority", async () => {
    const f = fixture();
    await expect(f.port.bindDevices([devices[0], devices[0]], signal())).rejects.toThrow();
    expect(f.ordering).toHaveLength(0);
    expect(f.requests).toHaveLength(0);
  });

  test("a concurrent call or close invalidates an in-flight proof before another effect", async () => {
    for (const concurrent of [false, true]) {
      let release!: () => void;
      let entered!: () => void;
      const begun = new Promise<void>((resolvePromise) => { entered = resolvePromise; });
      const waiting = new Promise<void>((resolvePromise) => { release = resolvePromise; });
      let calls = 0;
      const port = createLiveAcceptanceMemoryReadback({
        candidate, target,
        runner: async () => { calls += 1; return ok({ userId }); },
        verifyRuntime: async () => undefined,
        verifyTarget: async () => { entered(); await waiting; },
      });
      const pending = port.bindDevices(devices, signal());
      await begun;
      if (concurrent) {
        await expect(port.bindDevices(devices, signal())).rejects.toThrow("live_memory_readback_refused");
      } else port.close();
      release();
      await expect(pending).rejects.toThrow("live_memory_readback_refused");
      expect(calls).toBe(0);
    }
  });
});
