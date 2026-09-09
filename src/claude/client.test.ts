import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import type { ClaudeFact } from "./assembler";
import { ClaudeStreamClient } from "./client";
import { ClaudeError } from "./errors";
import type { ClaudeProcess, ClaudeProcessIdentity } from "./process";

const CONFIG_DIR = "/var/hra/profiles/acct/claude";

/**
 * A deterministic in-memory stand-in for the pinned `claude` process. Every
 * test drives the exact captured stream-json shapes; nothing shells out, so
 * these tests run identically on a machine with no Claude Code installed.
 */
class FakeClaudeProcess implements ClaudeProcess {
  readonly identity: Promise<ClaudeProcessIdentity> = Promise.resolve(Object.freeze({
    pid: 8_123,
    pidDomain: "darwin",
    procStart: "Fri Sep  4 12:00:00 2026",
  }));
  readonly written: string[] = [];
  readonly signals: string[] = [];
  onWrite: (() => void) | undefined;
  afterChunkRead: (() => void) | undefined;
  writeSettlementGate: Promise<void> | undefined;
  terminated = false;
  readonly #ignoreTerm: boolean;
  readonly #ignoreKill: boolean;
  readonly #leaveStreamsOpenAfterKill: boolean;
  #resolveExit: ((code: number) => void) | undefined;
  #rejectExit: ((error: Error) => void) | undefined;
  #push: ((chunk: Uint8Array) => void) | undefined;
  #finish: (() => void) | undefined;
  readonly exited: Promise<number>;
  readonly stdout: AsyncIterable<Uint8Array>;
  readonly stderr: AsyncIterable<Uint8Array> = { async *[Symbol.asyncIterator]() { /* silent */ } };

  constructor(options: Readonly<{
    ignoreTerm?: boolean;
    ignoreKill?: boolean;
    leaveStreamsOpenAfterKill?: boolean;
  }> = {}) {
    this.#ignoreTerm = options.ignoreTerm ?? false;
    this.#ignoreKill = options.ignoreKill ?? false;
    this.#leaveStreamsOpenAfterKill = options.leaveStreamsOpenAfterKill ?? false;
    this.exited = new Promise((resolve, reject) => {
      this.#resolveExit = resolve;
      this.#rejectExit = reject;
    });
    const queue: Uint8Array[] = [];
    let waiter: (() => void) | undefined;
    let done = false;
    this.#push = (chunk) => { queue.push(chunk); waiter?.(); waiter = undefined; };
    this.#finish = () => { done = true; waiter?.(); waiter = undefined; };
    const chunkRead = (): void => { this.afterChunkRead?.(); };
    this.stdout = {
      async *[Symbol.asyncIterator]() {
        for (;;) {
          const chunk = queue.shift();
          if (chunk !== undefined) { yield chunk; chunkRead(); continue; }
          if (done) return;
          await new Promise<void>((resolve) => { waiter = resolve; });
        }
      },
    };
  }

  emit(...lines: readonly unknown[]): void {
    const text = lines.map((line) => `${JSON.stringify(line)}\n`).join("");
    this.#push?.(new TextEncoder().encode(text));
  }

  end(): void {
    this.#finish?.();
    this.#resolveExit?.(0);
  }

  failExitProof(): void {
    this.#rejectExit?.(new Error("exit proof unavailable"));
  }

  async write(bytes: Uint8Array): Promise<void> {
    this.written.push(new TextDecoder().decode(bytes));
    this.onWrite?.();
    const gate = this.writeSettlementGate;
    this.writeSettlementGate = undefined;
    if (gate !== undefined) await gate;
  }

  terminate(): void {
    this.terminated = true;
    this.signals.push("SIGTERM");
    if (!this.#ignoreTerm) this.end();
  }

  forceTerminate(): void {
    this.terminated = true;
    this.signals.push("SIGKILL");
    if (this.#ignoreKill) return;
    if (this.#leaveStreamsOpenAfterKill) this.#resolveExit?.(137);
    else this.end();
  }
}

const settle = async (): Promise<void> => {
  for (let index = 0; index < 12; index += 1) await Promise.resolve();
  await new Promise((resolve) => { setTimeout(resolve, 1); });
};

const open = (): Readonly<{
  client: ClaudeStreamClient;
  facts: ClaudeFact[];
  process: FakeClaudeProcess;
}> => {
  const process = new FakeClaudeProcess();
  const facts: ClaudeFact[] = [];
  const client = new ClaudeStreamClient({
    configDir: CONFIG_DIR,
    onFact: (fact) => { facts.push(fact); },
    process,
  });
  return { client, facts, process };
};

const writtenLines = (process: FakeClaudeProcess): readonly unknown[] =>
  process.written.flatMap((chunk) =>
    chunk.split("\n").filter((line) => line.length > 0).map((line) => JSON.parse(line) as unknown));

describe("Claude stream client", () => {
  test.each(["count", "bytes"] as const)("fences pending first-write facts at the %s bound", async (bound) => {
    const process = new FakeClaudeProcess();
    const facts: ClaudeFact[] = [];
    const diagnostics: string[] = [];
    let signalDisconnected!: () => void;
    const disconnected = new Promise<void>((resolve) => { signalDisconnected = resolve; });
    const client = new ClaudeStreamClient({
      process, configDir: CONFIG_DIR,
      onFact: (fact) => {
        facts.push(fact);
        if (fact.type === "providerDisconnected") signalDisconnected();
      },
      onSafeDiagnostic: (message) => { diagnostics.push(message); },
    });
    let resolveWrite!: () => void;
    process.writeSettlementGate = new Promise<void>((resolve) => { resolveWrite = resolve; });
    let signalWrite!: () => void;
    const wrote = new Promise<void>((resolve) => { signalWrite = resolve; });
    process.onWrite = signalWrite;
    const starting = client.startTurn({ turnId: "turn-overflow", message: "Bound pending facts" });
    const outcome = starting.then(() => null, (error: unknown) => error);
    try {
      await wrote;
      process.emit(...Array.from({ length: bound === "count" ? 257 : 129 }, (_, index) => ({
        type: "assistant", session_id: "session", parent_tool_use_id: null,
        message: { id: `message-${String(index)}`, model: "claude-fable-5-1", role: "assistant",
          content: [{ type: "text", text: bound === "count" ? "bounded" : "x".repeat(8192) }] },
      })));
      await disconnected;
      expect(client.state).toBe("failed");
      expect(process.terminated).toBe(true);
      expect(diagnostics).toContain("Claude pending turn facts exceeded their bounded capacity");
      expect(facts.some((fact) => fact.type === "turnStarted")).toBe(false);
      const admitted = facts.filter((fact) => fact.type === "assistantDelta");
      if (bound === "count") expect(admitted).toHaveLength(256);
      else {
        expect(admitted.length).toBeGreaterThan(0);
        expect(admitted.length).toBeLessThan(129);
        expect(admitted.reduce((bytes, fact) => bytes + new TextEncoder().encode(JSON.stringify(fact)).byteLength, 0))
          .toBeLessThanOrEqual(1024 * 1024);
      }
      expect(admitted[0]).toMatchObject({ itemId: "message-0", turnId: "turn-overflow" });
      resolveWrite();
      expect(await outcome).toBeInstanceOf(ClaudeError);
      expect(client.activeTurnId).toBeNull();
    } finally {
      resolveWrite();
      await outcome;
      await client.close();
    }
  });

  test("preserves staged first-write order across bounded observer reentrancy", async () => {
    await fc.assert(fc.asyncProperty(
      fc.array(fc.integer({ min: 0, max: 999 }), { minLength: 1, maxLength: 8 }),
      async (values) => {
        const process = new FakeClaudeProcess();
        const facts: ClaudeFact[] = [];
        const emitAndRead = async (ids: readonly number[]): Promise<void> => {
          const consumed = new Promise<void>((resolve) => {
            process.afterChunkRead = () => { process.afterChunkRead = undefined; resolve(); };
          });
          process.emit(...ids.map((id, index) => ({
            type: "assistant", session_id: "session", parent_tool_use_id: null,
            message: { id: `message-${String(id)}-${String(index)}`, model: "claude-fable-5-1",
              content: [{ type: "text", text: String(id) }] },
          })));
          await consumed;
        };
        const client = new ClaudeStreamClient({
          process, configDir: CONFIG_DIR,
          onFact: async (fact) => {
            facts.push(fact);
            // The reader must keep consuming while a start observer awaits a
            // later frame; the exact pending FIFO captures that concurrent tail.
            if (fact.type === "turnStarted") await emitAndRead([1000]);
          },
        });
        let resolveWrite!: () => void;
        process.writeSettlementGate = new Promise<void>((resolve) => { resolveWrite = resolve; });
        let signalWrite!: () => void;
        const wrote = new Promise<void>((resolve) => { signalWrite = resolve; });
        process.onWrite = signalWrite;
        const starting = client.startTurn({ turnId: "turn-ordered", message: "Ordered facts" });
        try {
          await wrote;
          await emitAndRead(values);
          expect(facts).toEqual([]);
          resolveWrite();
          await starting;
          expect(facts[0]).toEqual({ type: "turnStarted", turnId: "turn-ordered" });
          expect(facts.filter((fact) => fact.type === "assistantDelta").map((fact) => fact.text))
            .toEqual([...values, 1000].map(String));
        } finally {
          resolveWrite();
          await starting;
          await client.close();
        }
      },
    ), { seed: 48_049, numRuns: 16 });
  });

  test.each([
    { stage: "pending", defer: false },
    { stage: "pending", defer: true },
    { stage: "reader", defer: false },
    { stage: "reader", defer: true },
  ] as const)("refuses a callback-local close join without releasing the child: %j", async ({ stage, defer }) => {
    const process = new FakeClaudeProcess();
    const facts: ClaudeFact[] = [];
    let recordAttempt!: (value: Readonly<{ error: unknown; state: string; signals: readonly string[] }>) => void;
    const attempted = new Promise<Readonly<{ error: unknown; state: string; signals: readonly string[] }>>(
      (resolve) => { recordAttempt = resolve; },
    );
    const client: ClaudeStreamClient = new ClaudeStreamClient({
      process, configDir: CONFIG_DIR, shutdownSettlementMs: 10,
      onFact: async (fact) => {
        facts.push(fact);
        if (fact.type !== (stage === "pending" ? "turnStarted" : "assistantDelta")) return;
        if (defer) await Promise.resolve();
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          // A deadline only detects the self-join. Returning this observer at
          // that boundary lets the old implementation finish honest cleanup.
          const error = await Promise.race([
            client.close().then(() => null, (failure: unknown) => failure),
            new Promise<Error>((resolve) => {
              timer = setTimeout(() => resolve(new Error("callback close self-joined")), 100);
            }),
          ]);
          recordAttempt({ error, state: client.state, signals: [...process.signals] });
        } finally {
          if (timer !== undefined) clearTimeout(timer);
        }
      },
    });
    let releaseWrite!: () => void;
    let signalWrite!: () => void;
    const wrote = new Promise<void>((resolve) => { signalWrite = resolve; });
    process.onWrite = signalWrite;
    process.writeSettlementGate = new Promise<void>((resolve) => { releaseWrite = resolve; });
    const starting = client.startTurn({ turnId: "turn-callback-close", message: "Preserve actual history" });
    const startOutcome = starting.then(() => null, (error: unknown) => error);
    try {
      await wrote;
      if (stage === "reader") { releaseWrite(); await startOutcome; }
      const consumed = new Promise<void>((resolve) => {
        process.afterChunkRead = () => { process.afterChunkRead = undefined; resolve(); };
      });
      process.emit({
        type: "assistant", session_id: "session", parent_tool_use_id: null,
        message: { id: "message-callback-close", model: "claude-fable-5-1",
          content: [{ type: "text", text: "Actual observed history" }] },
      });
      if (stage === "pending") { await consumed; releaseWrite(); }
      const attempt = await attempted;
      await startOutcome;
      await consumed;
      expect(attempt.error).toMatchObject({ code: "INVALID_INPUT" });
      expect(attempt.state).toBe("open");
      expect(attempt.signals).toEqual([]);
      expect(facts.filter((fact) => fact.type === "assistantDelta").map((fact) => fact.text))
        .toEqual(["Actual observed history"]);
      expect(facts.filter((fact) => fact.type === "turnStarted")).toHaveLength(1);
      // This external owner is not the observer: it must really join the
      // exact child and every admitted fact, not inherit a false release.
      await client.close();
      expect(client.state).toBe("closed");
      expect(process.signals).toEqual(["SIGTERM"]);
      await client.close();
      expect(process.signals).toEqual(["SIGTERM"]);
    } finally {
      releaseWrite();
      await startOutcome;
      await client.close();
    }
  });

  test("joins an external close while a staged observer is still active", async () => {
    const process = new FakeClaudeProcess();
    const facts: ClaudeFact[] = [];
    let signalObserver!: () => void;
    const observed = new Promise<void>((resolve) => { signalObserver = resolve; });
    let releaseObserver!: () => void;
    const observerGate = new Promise<void>((resolve) => { releaseObserver = resolve; });
    const client = new ClaudeStreamClient({
      process, configDir: CONFIG_DIR,
      onFact: async (fact) => {
        facts.push(fact);
        if (fact.type === "turnStarted") { signalObserver(); await observerGate; }
      },
    });
    const starting = client.startTurn({ turnId: "turn-external-close", message: "External close" });
    let closing: Promise<void> | undefined;
    try {
      await observed;
      const consumed = new Promise<void>((resolve) => {
        process.afterChunkRead = () => { process.afterChunkRead = undefined; resolve(); };
      });
      process.emit({
        type: "assistant", session_id: "session", parent_tool_use_id: null,
        message: { id: "message-external-close", model: "claude-fable-5-1",
          content: [{ type: "text", text: "Retain while closing" }] },
      });
      await consumed;
      let joined = false;
      closing = client.close().then(() => { joined = true; });
      expect(client.state).toBe("closing");
      expect(process.signals).toEqual(["SIGTERM"]);
      expect(joined).toBe(false);
      releaseObserver();
      await starting;
      await closing;
      expect(joined).toBe(true);
      expect(client.state).toBe("closed");
      expect(facts.filter((fact) => fact.type === "assistantDelta").map((fact) => fact.text))
        .toEqual(["Retain while closing"]);
    } finally {
      releaseObserver();
      await starting;
      await closing;
      await client.close();
    }
  });

  test.each(["providerError", "providerDisconnected"] as const)(
    "does not report cleanup joined while an exit-watcher %s callback is still active", async (blockedFact) => {
      const process = new FakeClaudeProcess({ leaveStreamsOpenAfterKill: true });
      const facts: ClaudeFact[] = [];
      let signalObserver!: () => void;
      const observed = new Promise<void>((resolve) => { signalObserver = resolve; });
      let releaseObserver!: () => void;
      const observerGate = new Promise<void>((resolve) => { releaseObserver = resolve; });
      let signalDisconnected!: () => void;
      const disconnected = new Promise<void>((resolve) => { signalDisconnected = resolve; });
      const client = new ClaudeStreamClient({
        process, configDir: CONFIG_DIR, shutdownSettlementMs: 20,
        onFact: async (fact) => {
          facts.push(fact);
          if (fact.type === blockedFact) { signalObserver(); await observerGate; }
          if (fact.type === "providerDisconnected") signalDisconnected();
        },
      });
      try {
        if (blockedFact === "providerError") {
          await client.startTurn({ turnId: "turn-exit-watcher-close", message: "Retain terminal history" });
        }
        // Exit is proved before stdout EOF, so the independent exit watcher
        // owns this callback. Ending stdout cannot prove that observer joined.
        process.forceTerminate();
        await observed;
        process.end();
        await expect(client.close()).rejects.toMatchObject({ code: "TIMEOUT" });
        expect(client.state).toBe("closing");
        releaseObserver();
        await disconnected;
        await client.close();
        expect(client.state).toBe("closed");
        expect(facts.map((fact) => fact.type)).toEqual(blockedFact === "providerError"
          ? ["turnStarted", "providerError", "turnCompleted", "providerDisconnected"]
          : ["providerDisconnected"]);
        expect(process.signals).toEqual(["SIGKILL"]);
      } finally {
        releaseObserver();
        process.end();
        await disconnected;
        await client.close();
      }
    },
  );

  test("allows inherited observer work to close after its callback finishes", async () => {
    const process = new FakeClaudeProcess();
    let permitClose!: () => void;
    const gate = new Promise<void>((resolve) => { permitClose = resolve; });
    let inheritedClose: Promise<void> | undefined;
    const client: ClaudeStreamClient = new ClaudeStreamClient({
      process, configDir: CONFIG_DIR,
      onFact: (fact) => {
        if (fact.type !== "turnStarted") return;
        inheritedClose = (async () => { await gate; await client.close(); })();
      },
    });
    try {
      await client.startTurn({ turnId: "turn-inherited-close", message: "Close afterward" });
      expect(client.state).toBe("open");
      expect(process.signals).toEqual([]);
      expect(inheritedClose).toBeDefined();
      permitClose();
      await inheritedClose;
      expect(client.state).toBe("closed");
      expect(process.signals).toEqual(["SIGTERM"]);
    } finally {
      permitClose();
      await inheritedClose;
      await client.close();
    }
  });

  test.each(["accepted", "rejected_after_result", "rejected_without_result", "closed_after_result"] as const)(
    "orders a first write against actual early stream facts: %s", async (disposition) => {
      const { client, process, facts } = open();
      const sessionId = "726b1b3d-ed97-4b55-9904-e58fa7d7eb45";
      process.emit({
        type: "system", subtype: "init", session_id: sessionId,
        claude_code_version: "2.1.260", model: "claude-fable-5-1", permissionMode: "default", tools: [],
      });
      await client.waitForInitialization({ signal: new AbortController().signal, timeoutMs: 1000 });
      let resolveWrite!: () => void;
      let rejectWrite!: (error: Error) => void;
      process.writeSettlementGate = new Promise<void>((resolve, reject) => {
        resolveWrite = resolve;
        rejectWrite = reject;
      });
      let signalWrite!: () => void;
      const wrote = new Promise<void>((resolve) => { signalWrite = resolve; });
      process.onWrite = signalWrite;
      const writeError = new Error("test-only rejected first write");
      const starting = client.startTurn({ message: "Immediate result", turnId: "turn-early" });
      const settledStart = starting.then(() => null, (error: unknown) => error);
      try {
        await wrote;
        if (disposition !== "rejected_without_result") {
          const consumed = new Promise<void>((resolve) => {
            process.afterChunkRead = () => { process.afterChunkRead = undefined; resolve(); };
          });
          process.emit({
            type: "result", session_id: sessionId, subtype: "success", is_error: false,
            result: "real early completion", duration_ms: 1, usage: { input_tokens: 1, output_tokens: 2 },
            uuid: "48c87f50-1645-4f71-a091-4949d337eb87", total_cost_usd: 0.01,
          });
          await consumed;
        }
        expect(facts.some((fact) => fact.type === "turnStarted")).toBe(false);
        if (disposition === "accepted") resolveWrite();
        else if (disposition === "closed_after_result") {
          // Drain observed history, but do not claim the original native write
          // joined until it settles. Retry retains this exact closed connection.
          await expect(client.close()).rejects.toMatchObject({ code: "TIMEOUT" });
          expect(client.state).toBe("closing");
          expect(facts.some((fact) => fact.type === "turnCompleted")).toBe(true);
          resolveWrite();
          await settledStart;
          await client.close();
        } else rejectWrite(writeError);
        const outcome = await settledStart;
        if (disposition === "accepted") {
          expect(outcome).toBeNull();
          expect(facts.filter((fact) => fact.type === "turnStarted")).toHaveLength(1);
          expect(facts.findIndex((fact) => fact.type === "turnStarted"))
            .toBeLessThan(facts.findIndex((fact) => fact.type === "turnCompleted"));
        } else {
          expect(outcome).toBeInstanceOf(Error);
          if (disposition !== "closed_after_result") expect(outcome).toBe(writeError);
          expect(facts.some((fact) => fact.type === "turnStarted")).toBe(false);
        }
        expect(client.activeTurnId).toBeNull();
        expect(facts.filter((fact) => fact.type === "turnSummary")).toHaveLength(
          disposition === "rejected_without_result" ? 0 : 1,
        );
        if (disposition !== "rejected_without_result") {
          expect(facts.find((fact) => fact.type === "turnSummary"))
            .toMatchObject({ turnId: "turn-early", status: "completed", resultText: "real early completion" });
        }
      } finally {
        resolveWrite();
        await settledStart;
        await client.close();
      }
    },
  );

  test("waits for one bounded, abortable initialization identity", async () => {
    const { client, process } = open();
    const initialization = client.waitForInitialization({
      signal: new AbortController().signal,
      timeoutMs: 1_000,
    });
    process.emit({
      claude_code_version: "2.1.260",
      model: "claude-fable-5-1",
      permissionMode: "default",
      session_id: "726b1b3d-ed97-4b55-9904-e58fa7d7eb45",
      subtype: "init",
      tools: [],
      type: "system",
    });
    await expect(initialization).resolves.toEqual({
      claudeVersion: "2.1.260",
      model: "claude-fable-5-1",
      permissionMode: "default",
      providerSessionId: "726b1b3d-ed97-4b55-9904-e58fa7d7eb45",
    });
    await client.close();
  });

  test("refuses a silent or aborted initialization wait", async () => {
    const silent = open();
    await expect(silent.client.waitForInitialization({
      signal: new AbortController().signal,
      timeoutMs: 1,
    })).rejects.toMatchObject({ code: "TIMEOUT" });
    await silent.client.close();

    const aborted = open();
    const controller = new AbortController();
    controller.abort(new Error("caller stopped"));
    await expect(aborted.client.waitForInitialization({
      signal: controller.signal,
      timeoutMs: 1_000,
    })).rejects.toThrow("caller stopped");
    await aborted.client.close();
  });

  test("continues draining stderr after the bounded diagnostic count is reached", async () => {
    const process = new FakeClaudeProcess();
    const facts: ClaudeFact[] = [];
    const completed = Promise.withResolvers<undefined>();
    let yieldedChunks = 0;
    const chunkCount = 32;
    let releaseDrain: (() => void) | undefined;
    const drainAllowed = new Promise<void>((resolve) => { releaseDrain = resolve; });
    const stderr: AsyncIterable<Uint8Array> = {
      async *[Symbol.asyncIterator]() {
        await drainAllowed;
        for (let index = 0; index < chunkCount; index += 1) {
          yieldedChunks += 1;
          yield new Uint8Array(4 * 1024);
        }
        process.emit({
          claude_code_version: "2.1.260",
          model: "claude-fable-5-1",
          permissionMode: "default",
          session_id: "sess",
          subtype: "init",
          tools: [],
          type: "system",
        }, {
          duration_ms: 1,
          is_error: false,
          modelUsage: {},
          num_turns: 1,
          result: "done after stderr",
          session_id: "sess",
          stop_reason: "end_turn",
          terminal_reason: "completed",
          type: "result",
          usage: {},
          uuid: "00000000-0000-4000-8000-000000000003",
        });
      },
    };
    const diagnostics: string[] = [];
    const drainingProcess: ClaudeProcess = {
      exited: process.exited,
      forceTerminate: () => process.forceTerminate(),
      identity: process.identity,
      stderr,
      stdout: process.stdout,
      terminate: () => process.terminate(),
      write: async (bytes) => await process.write(bytes),
    };
    const client = new ClaudeStreamClient({
      configDir: CONFIG_DIR,
      onFact: (fact) => {
        facts.push(fact);
        if (fact.type === "turnCompleted") completed.resolve(undefined);
      },
      onSafeDiagnostic: (message) => diagnostics.push(message),
      process: drainingProcess,
    });

    const deadline = setTimeout(() => completed.reject(new Error("stderr drain did not complete the turn")), 1_000);
    try {
      await client.startTurn({ message: "work", turnId: "turn-stderr" });
      releaseDrain?.();
      // Completion is causally after the last stderr chunk, not a guessed
      // number of microtasks or a timer turn on one JavaScript runtime.
      await completed.promise;
      expect(yieldedChunks).toBe(chunkCount);
      expect(facts.some((fact) => fact.type === "turnCompleted")).toBe(true);
    } finally {
      clearTimeout(deadline);
      releaseDrain?.();
      process.end();
      await client.close();
    }
    expect(diagnostics).toEqual(["claude stderr bytes: 4096+"]);
  });

  test("bounds shutdown when TERM and inherited streams never settle", async () => {
    const never = new Promise<never>(() => undefined);
    const neverEnding: AsyncIterable<Uint8Array> = {
      [Symbol.asyncIterator]() {
        return { next: async () => await never };
      },
    };
    const signals: string[] = [];
    const process: ClaudeProcess = {
      exited: never,
      forceTerminate: () => { signals.push("SIGKILL"); },
      identity: Promise.resolve(Object.freeze({
        pid: 8_124,
        pidDomain: "darwin",
        procStart: "Fri Sep  4 12:00:01 2026",
      })),
      stderr: neverEnding,
      stdout: neverEnding,
      terminate: () => { signals.push("SIGTERM"); },
      write: async () => undefined,
    };
    const diagnostics: string[] = [];
    const client = new ClaudeStreamClient({
      configDir: CONFIG_DIR,
      onFact: () => undefined,
      onSafeDiagnostic: (message) => diagnostics.push(message),
      process,
      shutdownSettlementMs: 5,
      shutdownTermGraceMs: 5,
    });

    const outcome = await Promise.race([
      Promise.allSettled([client.close(), client.close()]).then((settlements) => ({
        kind: "settled" as const,
        settlements,
      })),
      new Promise<"timed-out">((resolve) => { setTimeout(() => resolve("timed-out"), 250); }),
    ]);

    expect(outcome).not.toBe("timed-out");
    if (outcome === "timed-out") throw new Error("Claude close exceeded its bound");
    expect(outcome.settlements).toHaveLength(2);
    expect(outcome.settlements.every((settlement) => settlement.status === "rejected")).toBe(true);
    expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
    expect(diagnostics).toEqual([]);
  });

  test("drives one full turn: user line in, deltas and a result out", async () => {
    const { client, facts, process } = open();
    await client.startTurn({ message: "say ok", turnId: "turn-1" });
    expect(writtenLines(process)).toEqual([{
      message: { content: [{ text: "say ok", type: "text" }], role: "user" },
      type: "user",
    }]);

    process.emit(
      {
        claude_code_version: "2.1.260",
        cwd: "<redacted>",
        model: "claude-fable-5-1",
        permissionMode: "default",
        session_id: "sess",
        subtype: "init",
        tools: ["Bash"],
        type: "system",
      },
      {
        message: {
          content: [{ text: "ok", type: "text" }],
          id: "msg_1",
          model: "claude-fable-5-1",
          role: "assistant",
          type: "message",
        },
        parent_tool_use_id: null,
        session_id: "sess",
        type: "assistant",
      },
      {
        duration_ms: 2_259,
        is_error: false,
        modelUsage: {},
        num_turns: 1,
        result: "ok",
        session_id: "sess",
        stop_reason: "end_turn",
        terminal_reason: "completed",
        type: "result",
        usage: { input_tokens: 2, output_tokens: 4 },
        uuid: "00000000-0000-4000-8000-000000000001",
      },
    );
    await settle();

    expect(facts.map((fact) => fact.type)).toEqual([
      "turnStarted",
      "sessionBootstrapped",
      "assistantDelta",
      "tokenUsageUpdated",
      "turnCompleted",
      "turnSummary",
      "usageAccountingObserved",
    ]);
    expect(client.activeTurnId).toBeNull();
    expect(client.providerSessionId).toBe("sess");
    await client.close();
  });

  test("steers mid-turn by writing another user line on the same stream", async () => {
    const { client, process } = open();
    await client.startTurn({ message: "count to 40", turnId: "turn-1" });
    await client.steer("stop counting now");
    expect(writtenLines(process)).toEqual([
      { message: { content: [{ text: "count to 40", type: "text" }], role: "user" }, type: "user" },
      { message: { content: [{ text: "stop counting now", type: "text" }], role: "user" }, type: "user" },
    ]);
    await client.close();
  });

  test("refuses to steer when no turn is in flight", async () => {
    const { client } = open();
    await expect(client.steer("hello")).rejects.toThrow(ClaudeError);
    await client.close();
  });

  test("interrupts an in-flight turn and marks its result interrupted", async () => {
    const { client, facts, process } = open();
    await client.startTurn({ message: "long job", turnId: "turn-1" });
    await client.interrupt();
    const interrupt = writtenLines(process).at(-1);
    expect(interrupt).toMatchObject({ request: { subtype: "interrupt" }, type: "control_request" });

    process.emit(
      {
        claude_code_version: "2.1.260",
        model: "claude-fable-5-1",
        permissionMode: "default",
        session_id: "sess",
        subtype: "init",
        tools: [],
        type: "system",
      },
      {
        duration_ms: 10,
        is_error: false,
        modelUsage: {},
        num_turns: 1,
        result: "stopped",
        session_id: "sess",
        stop_reason: "end_turn",
        terminal_reason: "completed",
        type: "result",
        usage: {},
        uuid: "00000000-0000-4000-8000-000000000002",
      },
    );
    await settle();
    expect(facts.find((fact) => fact.type === "turnCompleted"))
      .toMatchObject({ status: "interrupted" });
    await client.close();
  });

  test("brokers a Bash approval and answers with the request's own input", async () => {
    const { client, facts, process } = open();
    await client.startTurn({ message: "run it", turnId: "turn-1" });
    process.emit({
      request: {
        description: "Fetch HTTP status line from example.com",
        display_name: "Bash",
        input: { command: "curl -sI https://example.com | head -n 1" },
        permission_suggestions: [{
          behavior: "allow",
          destination: "localSettings",
          rules: [{ ruleContent: "curl -sI https://example.com", toolName: "Bash" }],
          type: "addRules",
        }],
        subtype: "can_use_tool",
        tool_name: "Bash",
        tool_use_id: "toolu_1",
      },
      request_id: "req-1",
      type: "control_request",
    });
    await settle();

    const requested = facts.find((fact) => fact.type === "interactionRequested");
    expect(requested).toMatchObject({ blocking: true, kind: "command_approval", requestId: "req-1" });
    expect(client.pendingInteraction("req-1")).toBeDefined();

    const validated = client.validateInteractionResolution("req-1", { kind: "allow" });
    const resolved = await client.resolveInteraction("req-1", { kind: "allow" });
    expect(resolved.responseDigest).toBe(validated.responseDigest);
    expect(writtenLines(process).at(-1)).toEqual({
      response: {
        request_id: "req-1",
        response: {
          behavior: "allow",
          toolUseID: "toolu_1",
          updatedInput: { command: "curl -sI https://example.com | head -n 1" },
        },
        subtype: "success",
      },
      type: "control_response",
    });
    // The response is written once; the request is no longer pending.
    expect(client.pendingInteraction("req-1")).toBeUndefined();
    await expect(client.resolveInteraction("req-1", { kind: "allow" })).rejects.toThrow(ClaudeError);
    await client.close();
  });

  test("answers a question through updatedInput.answers", async () => {
    const { client, facts, process } = open();
    await client.startTurn({ message: "ask me", turnId: "turn-1" });
    process.emit({
      request: {
        display_name: "AskUserQuestion",
        input: {
          questions: [{
            header: "Indent",
            multiSelect: false,
            options: [
              { description: "Indent with tab characters", label: "tabs" },
              { description: "Indent with space characters", label: "spaces" },
            ],
            question: "Tabs or spaces?",
          }],
        },
        requires_user_interaction: true,
        subtype: "can_use_tool",
        tool_name: "AskUserQuestion",
        tool_use_id: "toolu_q",
      },
      request_id: "req-q",
      type: "control_request",
    });
    await settle();
    expect(facts.find((fact) => fact.type === "interactionRequested")).toMatchObject({
      kind: "user_input",
    });
    await client.resolveInteraction("req-q", { answers: { q0: "spaces" }, kind: "answer" });
    expect(writtenLines(process).at(-1)).toMatchObject({
      response: {
        response: {
          behavior: "allow",
          updatedInput: { answers: { "Tabs or spaces?": "spaces" } },
        },
      },
    });
    await client.close();
  });

  test("drops a canceled control request instead of answering it", async () => {
    const { client, process } = open();
    await client.startTurn({ message: "run it", turnId: "turn-1" });
    process.emit(
      {
        request: {
          display_name: "Bash",
          input: { command: "true" },
          subtype: "can_use_tool",
          tool_name: "Bash",
          tool_use_id: "toolu_1",
        },
        request_id: "req-1",
        type: "control_request",
      },
      { request_id: "req-1", type: "control_cancel_request" },
    );
    await settle();
    expect(client.pendingInteraction("req-1")).toBeUndefined();
    await client.close();
  });

  test("ends an in-flight turn when the stream stops without a result", async () => {
    const { client, facts, process } = open();
    await client.startTurn({ message: "hello", turnId: "turn-1" });
    process.end();
    await settle();
    expect(facts.map((fact) => fact.type)).toEqual([
      "turnStarted",
      "providerError",
      "turnCompleted",
      "providerDisconnected",
    ]);
    expect(facts.at(-2)).toMatchObject({ status: "failed" });
    expect(facts.at(-1)).toMatchObject({ reason: "eof" });
    await client.close();
  });

  test("reports an unexpected disconnect while idle", async () => {
    const { client, facts, process } = open();
    process.end();
    await settle();
    expect(facts).toEqual([{ reason: "eof", type: "providerDisconnected" }]);
    await client.close();
  });

  test("keeps malformed usage advisories from faulting or abandoning a turn", async () => {
    const { client, facts, process } = open();
    await client.startTurn({ message: "say ok", turnId: "turn-1" });
    process.emit(
      {
        claude_code_version: "2.1.260",
        model: "claude-fable-5-1",
        permissionMode: "default",
        session_id: "sess",
        subtype: "init",
        tools: [],
        type: "system",
      },
      {
        rate_limit_info: {
          status: "allowed",
          unifiedWindows: {
            five_hour: { resetsAt: 1_788_499_800_000, utilization: 0.5 },
          },
        },
        session_id: "sess",
        type: "rate_limit_event",
        uuid: "00000000-0000-4000-8000-000000000003",
      },
      {
        duration_ms: 10,
        is_error: false,
        modelUsage: { model: { canonicalModel: "different" } },
        num_turns: 1,
        result: "ok",
        session_id: "sess",
        total_cost_usd: Number.NaN,
        type: "result",
        usage: { input_tokens: 2, output_tokens: 4 },
        uuid: "not-a-uuid",
      },
    );
    await settle();
    expect(facts.map((fact) => fact.type)).toEqual([
      "turnStarted",
      "sessionBootstrapped",
      "protocolNotice",
      "tokenUsageUpdated",
      "turnCompleted",
      "turnSummary",
      "protocolNotice",
    ]);
    expect(facts.filter((fact) => fact.type === "providerDisconnected")).toEqual([]);
    expect(client.activeTurnId).toBeNull();
    await client.close();
  });

  test("requires an absolute reviewed config directory", () => {
    expect(() => new ClaudeStreamClient({
      configDir: "relative/home",
      onFact: () => undefined,
      process: new FakeClaudeProcess(),
    })).toThrow(ClaudeError);
  });

  test("refuses every write after close", async () => {
    const { client } = open();
    await client.close();
    await expect(client.startTurn({ message: "x", turnId: "t" })).rejects.toThrow(ClaudeError);
  });

  test("requires exact exit settlement after KILL and permits an exact close retry", async () => {
    const process = new FakeClaudeProcess({
      ignoreKill: true,
      ignoreTerm: true,
      leaveStreamsOpenAfterKill: true,
    });
    const diagnostics: string[] = [];
    const client = new ClaudeStreamClient({
      configDir: CONFIG_DIR,
      onFact: () => undefined,
      onSafeDiagnostic: (message) => { diagnostics.push(message); },
      process,
      shutdownSettlementMs: 5,
      shutdownTermGraceMs: 5,
    });
    await expect(Promise.all([client.close(), client.close()])).rejects.toMatchObject({
      code: "TIMEOUT",
    });
    expect(process.signals).toEqual(["SIGTERM", "SIGKILL"]);

    process.end();
    await expect(client.close()).resolves.toBeUndefined();
    expect(process.signals).toEqual(["SIGTERM", "SIGKILL", "SIGTERM"]);
  });

  test("fences writes when process exit settlement becomes indeterminate", async () => {
    const process = new FakeClaudeProcess();
    const diagnostics: string[] = [];
    const client = new ClaudeStreamClient({
      configDir: CONFIG_DIR,
      onFact: () => undefined,
      onSafeDiagnostic: (message) => { diagnostics.push(message); },
      process,
      shutdownSettlementMs: 5,
      shutdownTermGraceMs: 5,
    });
    process.failExitProof();
    await settle();

    await expect(client.startTurn({ message: "must not write", turnId: "turn-1" }))
      .rejects.toMatchObject({ code: "PROCESS_EXITED" });
    expect(process.written).toHaveLength(0);
    expect(diagnostics).toContain("Claude process exit settlement was indeterminate");
    await expect(client.close()).rejects.toMatchObject({ code: "TIMEOUT" });
  });

  test("refuses a queued frame when the process authority is fenced before its write begins", async () => {
    const process = new FakeClaudeProcess();
    const facts: ClaudeFact[] = [];
    const client = new ClaudeStreamClient({
      configDir: CONFIG_DIR,
      onFact: (fact) => { facts.push(fact); },
      process,
      shutdownSettlementMs: 5,
      shutdownTermGraceMs: 5,
    });
    let releaseFirstWrite!: () => void;
    let markFirstWriteStarted!: () => void;
    const firstWriteGate = new Promise<void>((resolve) => { releaseFirstWrite = resolve; });
    const firstWriteStarted = new Promise<void>((resolve) => { markFirstWriteStarted = resolve; });
    process.writeSettlementGate = firstWriteGate;
    process.onWrite = markFirstWriteStarted;

    const first = client.startTurn({ message: "first", turnId: "turn-1" });
    await firstWriteStarted;
    process.onWrite = undefined;
    const queued = client.steer("must stay fenced").then(
      () => null,
      (error: unknown) => error,
    );
    process.failExitProof();
    await settle();
    releaseFirstWrite();

    // A late stdin resolution does not revive an admission whose process
    // authority was already lost, even though those first bytes escaped.
    await expect(first).rejects.toMatchObject({ code: "PROCESS_EXITED" });
    expect(facts.some((fact) => fact.type === "turnStarted")).toBe(false);
    expect(await queued).toMatchObject({ code: "PROCESS_EXITED" });
    expect(writtenLines(process)).toEqual([
      {
        message: {
          content: [{ text: "first", type: "text" }],
          role: "user",
        },
        type: "user",
      },
    ]);
    await expect(client.close()).rejects.toMatchObject({ code: "TIMEOUT" });
  });

  test("force-terminates and exactly joins a session child that ignores TERM", async () => {
    const process = new FakeClaudeProcess();
    let forceTerminations = 0;
    const gracefulExit = process.terminate.bind(process);
    process.terminate = () => { process.terminated = true; };
    process.forceTerminate = () => {
      forceTerminations += 1;
      gracefulExit();
    };
    const client = new ClaudeStreamClient({
      configDir: CONFIG_DIR,
      onFact: () => undefined,
      process,
      shutdownSettlementMs: 20,
      shutdownTermGraceMs: 1,
    });

    await client.close();

    expect(process.terminated).toBe(true);
    expect(forceTerminations).toBe(1);
    await expect(process.exited).resolves.toBe(0);
  });
});

describe("Claude stream client constructor ownership", () => {
  test("snapshots mutable options for config, writes, streams and callback receivers", async () => {
    const original = new FakeClaudeProcess();
    const replacement = new FakeClaudeProcess();
    const stderrGate = Promise.withResolvers<undefined>();
    const assistantSeen = Promise.withResolvers<undefined>();
    const diagnosticSeen = Promise.withResolvers<undefined>();
    const reads = { originalStdout: 0, originalStderr: 0, replacementStdout: 0, replacementStderr: 0 };
    const port = (process: FakeClaudeProcess, name: "original" | "replacement"): ClaudeProcess => ({
      identity: process.identity,
      exited: process.exited,
      stdout: {
        [Symbol.asyncIterator]() {
          reads[`${name}Stdout`] += 1;
          return process.stdout[Symbol.asyncIterator]();
        },
      },
      stderr: {
        async *[Symbol.asyncIterator]() {
          reads[`${name}Stderr`] += 1;
          await stderrGate.promise;
          yield new TextEncoder().encode(name);
        },
      },
      write: (bytes) => process.write(bytes),
      terminate: () => { process.terminate(); },
      forceTerminate: () => { process.forceTerminate(); },
    });
    const originalFacts: ClaudeFact[] = [];
    const replacementFacts: ClaudeFact[] = [];
    const originalDiagnostics: string[] = [];
    const replacementDiagnostics: string[] = [];
    const factReceivers: unknown[] = [];
    const diagnosticReceivers: unknown[] = [];
    const options = {
      process: port(original, "original"),
      configDir: CONFIG_DIR,
      onFact(this: unknown, fact: ClaudeFact) {
        factReceivers.push(this);
        originalFacts.push(fact);
        if (fact.type === "assistantDelta") assistantSeen.resolve(undefined);
      },
      onSafeDiagnostic(this: unknown, message: string) {
        diagnosticReceivers.push(this);
        originalDiagnostics.push(message);
        diagnosticSeen.resolve(undefined);
      },
    };
    const client = new ClaudeStreamClient(options);
    options.process = port(replacement, "replacement");
    options.configDir = "/var/hra/profiles/replacement/claude";
    options.onFact = function (this: unknown, fact: ClaudeFact) {
      replacementFacts.push(fact);
      if (fact.type === "assistantDelta") assistantSeen.resolve(undefined);
    };
    options.onSafeDiagnostic = function (this: unknown, message: string) {
      replacementDiagnostics.push(message);
      diagnosticSeen.resolve(undefined);
    };
    const observedConfig = client.configDir;
    let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
      deadlineTimer = setTimeout(() => { reject(new Error("constructor ownership milestone timed out")); }, 1_000);
    });
    const starting = client.startTurn({ message: "original authority", turnId: "turn-owned" });
    let cleanup: PromiseSettledResult<unknown>[] = [];
    try {
      await Promise.race([starting, deadline]);
      for (const [process, name] of [[original, "original"], [replacement, "replacement"]] as const) {
        process.emit({
          type: "assistant", session_id: "session", parent_tool_use_id: null,
          message: { id: `message-${name}`, model: "claude-fable-5-1", role: "assistant",
            content: [{ type: "text", text: name }] },
        });
      }
      stderrGate.resolve(undefined);
      // Either callback route releases these milestones, so the old alias is
      // an observed wrong result rather than a fixture waiting for the fix.
      await Promise.race([Promise.all([assistantSeen.promise, diagnosticSeen.promise]), deadline]);
    } finally {
      stderrGate.resolve(undefined);
      original.end();
      replacement.end();
      cleanup = await Promise.allSettled([starting, original.exited, replacement.exited, client.close()]);
      clearTimeout(deadlineTimer);
    }
    expect(cleanup.every((result) => result.status === "fulfilled")).toBe(true);
    expect(observedConfig).toBe(CONFIG_DIR);
    expect(writtenLines(original)).toEqual([{
      message: { content: [{ text: "original authority", type: "text" }], role: "user" }, type: "user",
    }]);
    expect(replacement.written).toEqual([]);
    expect(originalFacts.filter((fact) => fact.type === "assistantDelta").map((fact) => fact.text)).toEqual(["original"]);
    expect(replacementFacts).toEqual([]);
    expect(originalDiagnostics).toEqual(["claude stderr bytes: 8"]);
    expect(replacementDiagnostics).toEqual([]);
    expect(factReceivers.length).toBeGreaterThan(0);
    expect(factReceivers.every((receiver) => receiver === client)).toBe(true);
    expect(diagnosticReceivers).toEqual([client]);
    expect(reads).toEqual({ originalStdout: 1, originalStderr: 1, replacementStdout: 0, replacementStderr: 0 });
  });

  test("retains original TERM, KILL and exit custody after the caller replaces its process", async () => {
    const original = new FakeClaudeProcess({ ignoreTerm: true, ignoreKill: true });
    const replacement = new FakeClaudeProcess({ ignoreTerm: true, ignoreKill: true });
    const killEntered = Promise.withResolvers<undefined>();
    for (const process of [original, replacement]) {
      const forceTerminate = process.forceTerminate.bind(process);
      process.forceTerminate = () => { forceTerminate(); killEntered.resolve(undefined); };
    }
    const options = {
      process: original, configDir: CONFIG_DIR, onFact: () => undefined,
      shutdownTermGraceMs: 1, shutdownSettlementMs: 20,
    };
    const client = new ClaudeStreamClient(options);
    options.process = replacement;
    let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
      deadlineTimer = setTimeout(() => { reject(new Error("original exit custody milestone timed out")); }, 1_000);
    });
    const closing = client.close().then(
      () => ({ status: "fulfilled" as const }),
      (reason: unknown) => ({ status: "rejected" as const, reason }),
    );
    let cleanup: PromiseSettledResult<unknown>[] = [];
    try {
      await Promise.race([killEntered.promise, deadline]);
      replacement.end();
      await replacement.exited;
      const firstOutcome = await Promise.race([closing, deadline]);
      expect(firstOutcome).toMatchObject({ status: "rejected", reason: { code: "TIMEOUT" } });
      expect(client.state).toBe("closing");
      expect(original.signals).toEqual(["SIGTERM", "SIGKILL"]);
      expect(replacement.signals).toEqual([]);
      original.end();
      await original.exited;
      await Promise.race([client.close(), deadline]);
      expect(client.state).toBe("closed");
    } finally {
      original.end();
      replacement.end();
      cleanup = await Promise.allSettled([closing, original.exited, replacement.exited, client.close()]);
      clearTimeout(deadlineTimer);
    }
    expect(cleanup.every((result) => result.status === "fulfilled")).toBe(true);
  });

  test("reads process once in constructor order and retains an omitted diagnostic callback", async () => {
    const original = new FakeClaudeProcess();
    const replacement = new FakeClaudeProcess();
    const reads: string[] = [];
    let processReads = 0;
    let configReads = 0;
    const diagnostic: { current: ((message: string) => void) | undefined } = { current: undefined };
    const lateDiagnostics: string[] = [];
    const stderrGate = Promise.withResolvers<undefined>();
    const originalPort: ClaudeProcess = {
      identity: original.identity, exited: original.exited, stdout: original.stdout,
      stderr: { async *[Symbol.asyncIterator]() { await stderrGate.promise; yield new Uint8Array([1]); } },
      write: (bytes) => original.write(bytes),
      terminate: () => { original.terminate(); },
      forceTerminate: () => { original.forceTerminate(); },
    };
    const options = {
      get configDir() { configReads += 1; reads.push("configDir"); return configReads <= 2 ? CONFIG_DIR : "/replacement"; },
      get process() { processReads += 1; reads.push("process"); return processReads === 1 ? originalPort : replacement; },
      get onFact() { reads.push("onFact"); return () => undefined; },
    };
    Object.defineProperty(options, "onSafeDiagnostic", {
      get() { reads.push("onSafeDiagnostic"); return diagnostic.current; },
    });
    const client = new ClaudeStreamClient(options);
    const constructionReads = [...reads];
    diagnostic.current = (message) => { lateDiagnostics.push(message); };
    const observedConfig = client.configDir;
    const starting = client.startTurn({ message: "captured process", turnId: "turn-accessor" });
    let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
      deadlineTimer = setTimeout(() => { reject(new Error("accessor ownership milestone timed out")); }, 1_000);
    });
    let cleanup: PromiseSettledResult<unknown>[] = [];
    try {
      await Promise.race([starting, deadline]);
    } finally {
      stderrGate.resolve(undefined);
      original.end();
      replacement.end();
      cleanup = await Promise.allSettled([starting, original.exited, replacement.exited, client.close()]);
      clearTimeout(deadlineTimer);
    }
    expect(cleanup.every((result) => result.status === "fulfilled")).toBe(true);
    expect(constructionReads).toEqual(["configDir", "process", "configDir", "onFact", "onSafeDiagnostic"]);
    expect(reads).toEqual(constructionReads);
    expect(processReads).toBe(1);
    expect(configReads).toBe(2);
    expect(observedConfig).toBe(CONFIG_DIR);
    expect(writtenLines(original)).toEqual([{
      message: { content: [{ text: "captured process", type: "text" }], role: "user" }, type: "user",
    }]);
    expect(replacement.written).toEqual([]);
    expect(replacement.signals).toEqual([]);
    expect(lateDiagnostics).toEqual([]);
  });
});
