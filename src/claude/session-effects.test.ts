import { describe, expect, test } from "bun:test";

import type { ClaudeFact } from "./assembler.ts";
import { ClaudeStreamClient } from "./client.ts";
import type { ClaudeProcess } from "./process.ts";

const CONFIG_DIR = "/var/hra/profiles/synthetic/claude";

type Outcome<A> = Readonly<{ status: "fulfilled"; value: A }>
  | Readonly<{ status: "rejected"; reason: unknown }>;

const observe = <A>(promise: Promise<A>): Promise<Outcome<A>> => promise.then(
  (value) => ({ status: "fulfilled", value }),
  (reason: unknown) => ({ status: "rejected", reason }),
);

const deferred = <A>() => {
  let resolve!: (value: A) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<A>((accept, fail) => { resolve = accept; reject = fail; });
  return { promise, resolve, reject };
};

const milestoneDeadline = () => {
  const deadline = deferred<never>();
  const timer = setTimeout(() => {
    deadline.reject(new Error("The controlled facade did not reach its native milestone"));
  }, 1_000);
  void deadline.promise.catch(() => undefined);
  return {
    observe: <A>(milestone: Promise<A>): Promise<A> => Promise.race([milestone, deadline.promise]),
    clear: (): void => { clearTimeout(timer); },
  };
};

// A single controlled stdout chunk and one original pending write are enough
// for these public-facade schedules. No provider is launched; filesystem and
// clock adapters are unchanged.
const controlledProcess = (events: string[]) => {
  const firstWrite = deferred<undefined>();
  const firstWriteEntered = deferred<undefined>();
  const output = deferred<Uint8Array | null>();
  const outputConsumed = deferred<undefined>();
  const exited = deferred<number>();
  const writes: string[] = [];
  const signals: string[] = [];
  const finish = (): void => { output.resolve(null); exited.resolve(0); };
  const process: ClaudeProcess = {
    identity: Promise.resolve({ pid: 8_123, pidDomain: "darwin", procStart: "synthetic-effect-facade" }),
    exited: exited.promise,
    stdout: {
      async *[Symbol.asyncIterator]() {
        const chunk = await output.promise;
        if (chunk !== null) {
          yield chunk;
          // The real reader requested another chunk after awaiting dispatch of
          // every decoded value, so this is a buffering milestone, not a sleep.
          events.push("stdout-chunk-consumed");
          outputConsumed.resolve(undefined);
        }
        await exited.promise;
      },
    },
    stderr: { async *[Symbol.asyncIterator]() { /* silent synthetic stream */ } },
    write(bytes) {
      writes.push(new TextDecoder().decode(bytes));
      events.push("native-write-" + String(writes.length));
      if (writes.length === 1) {
        firstWriteEntered.resolve(undefined);
        return firstWrite.promise;
      }
      return Promise.resolve();
    },
    terminate() { signals.push("SIGTERM"); finish(); },
    forceTerminate() { signals.push("SIGKILL"); finish(); },
  };
  const emitAssistant = (): void => output.resolve(new TextEncoder().encode(JSON.stringify({
    type: "assistant",
    session_id: "synthetic-session",
    parent_tool_use_id: null,
    message: {
      id: "synthetic-message",
      model: "claude-fable-5-1",
      content: [{ type: "text", text: "Observed before write settlement" }],
    },
  }) + "\n"));
  return { process, firstWrite, firstWriteEntered, outputConsumed, writes, signals, finish, emitAssistant };
};

describe("Claude connection facade causal contracts", () => {
  test("W1 admits synchronously while native writes remain deferred and FIFO", async () => {
    const events: string[] = [];
    const child = controlledProcess(events);
    const facts: ClaudeFact[] = [];
    const client = new ClaudeStreamClient({
      configDir: CONFIG_DIR,
      process: child.process,
      onFact: (fact) => { facts.push(fact); },
    });
    let started: Promise<Outcome<void>> | undefined;
    let steered: Promise<Outcome<void>> | undefined;
    let duplicate: Promise<Outcome<void>> | undefined;
    const deadline = milestoneDeadline();
    try {
      started = observe(client.startTurn({ turnId: "turn-fifo", message: "first" }));
      events.push("start-returned");
      expect(client.activeTurnId).toBe("turn-fifo");
      expect(child.writes).toEqual([]);
      duplicate = observe(client.startTurn({ turnId: "turn-duplicate", message: "must not write" }));
      steered = observe(client.steer("second"));
      events.push("steer-returned");
      expect(child.writes).toEqual([]);

      await deadline.observe(child.firstWriteEntered.promise);
      expect(events.indexOf("native-write-1")).toBeGreaterThan(events.indexOf("steer-returned"));
      expect(child.writes).toHaveLength(1);
      expect(facts.some((fact) => fact.type === "turnStarted")).toBe(false);
      child.firstWrite.resolve(undefined);
      const [startOutcome, steerOutcome, duplicateOutcome] = await Promise.all([started, steered, duplicate]);
      expect(startOutcome.status).toBe("fulfilled");
      expect(steerOutcome.status).toBe("fulfilled");
      expect(duplicateOutcome).toMatchObject({ status: "rejected", reason: { code: "INVALID_INPUT" } });
      expect(child.writes.map((line) => JSON.parse(line) as unknown)).toEqual([
        { type: "user", message: { role: "user", content: [{ type: "text", text: "first" }] } },
        { type: "user", message: { role: "user", content: [{ type: "text", text: "second" }] } },
      ]);
      expect(facts.filter((fact) => fact.type === "turnStarted")).toEqual([
        { type: "turnStarted", turnId: "turn-fifo" },
      ]);
    } finally {
      deadline.clear();
      child.firstWrite.resolve(undefined);
      await Promise.all([started, steered, duplicate]);
      await client.close();
    }
  });

  test.each([
    { label: "diagnostic undefined", diagnostic: "throws", reason: undefined },
    { label: "diagnostic null", diagnostic: "throws", reason: null },
    { label: "diagnostic false", diagnostic: "throws", reason: false },
    { label: "diagnostic zero", diagnostic: "throws", reason: 0 },
    { label: "diagnostic empty string", diagnostic: "throws", reason: "" },
    { label: "normal diagnostic with undefined write failure", diagnostic: "returns", reason: undefined },
    { label: "omitted diagnostic with null write failure", diagnostic: "absent", reason: null },
  ] as const)("R4 preserves failed-write diagnostic precedence: $label", async (scenario) => {
    const events: string[] = [];
    const child = controlledProcess(events);
    const facts: ClaudeFact[] = [];
    const diagnostics: string[] = [];
    const observerReason = new Error("Synthetic buffered-fact observer rejection");
    const writeReason: unknown = scenario.diagnostic === "throws"
      ? new Error("Synthetic original write rejection") : scenario.reason;
    let faultEnabled = true;
    const client = new ClaudeStreamClient({
      configDir: CONFIG_DIR,
      process: child.process,
      onFact: (fact) => {
        facts.push(fact);
        if (faultEnabled && fact.type === "assistantDelta") {
          events.push("buffered-observer-rejected");
          throw observerReason;
        }
      },
      ...(scenario.diagnostic === "absent" ? {} : {
        onSafeDiagnostic: (message: string) => {
          diagnostics.push(message);
          events.push("diagnostic-called");
          if (faultEnabled && scenario.diagnostic === "throws") {
            // eslint-disable-next-line @typescript-eslint/only-throw-error -- This regression must preserve each original falsey foreign failure value.
            throw scenario.reason;
          }
        },
      }),
    });
    let started: Promise<Outcome<void>> | undefined;
    const deadline = milestoneDeadline();
    try {
      const originalStart = client.startTurn({ turnId: "turn-diagnostic", message: "Controlled write" });
      started = observe(originalStart);
      events.push("start-returned");
      expect(originalStart).toBeInstanceOf(Promise);
      expect(client.activeTurnId).toBe("turn-diagnostic");
      expect(child.writes).toEqual([]);
      await deadline.observe(child.firstWriteEntered.promise);
      child.emitAssistant();
      await deadline.observe(child.outputConsumed.promise);
      expect(facts).toEqual([]);
      child.firstWrite.reject(writeReason);
      const outcome = await started;
      events.push("start-observed");
      expect(outcome.status).toBe("rejected");
      if (outcome.status === "rejected") {
        expect(outcome.reason).toBe(scenario.diagnostic === "throws" ? scenario.reason : writeReason);
      }
      expect(child.writes).toHaveLength(1);
      expect(facts.filter((fact) => fact.type === "assistantDelta")).toHaveLength(1);
      expect(facts.some((fact) => fact.type === "turnStarted")).toBe(false);
      expect(events.filter((event) => event === "buffered-observer-rejected")).toHaveLength(1);
      expect(events.indexOf("stdout-chunk-consumed")).toBeLessThan(events.indexOf("buffered-observer-rejected"));
      if (scenario.diagnostic === "absent") expect(diagnostics).toEqual([]);
      else {
        expect(diagnostics).toEqual(["HRA fact delivery failed after Claude turn admission failed"]);
        expect(events.indexOf("diagnostic-called")).toBeGreaterThan(events.indexOf("buffered-observer-rejected"));
        expect(events.indexOf("diagnostic-called")).toBeLessThan(events.indexOf("start-observed"));
      }
      // A throwing diagnostic currently precedes abandonTurn; silently running
      // that cleanup would change both raw failure precedence and public state.
      expect(client.activeTurnId).toBe(scenario.diagnostic === "throws" ? "turn-diagnostic" : null);
    } finally {
      deadline.clear();
      faultEnabled = false;
      child.firstWrite.resolve(undefined);
      child.finish();
      await started;
      await client.close();
    }
  });
});
