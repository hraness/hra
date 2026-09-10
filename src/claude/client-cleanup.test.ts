import { expect, test } from "bun:test";

import type { ClaudeFact } from "./assembler";
import { ClaudeStreamClient } from "./client";
import type { ClaudeProcess } from "./process";

const inMemoryProcess = () => {
  let finish!: (code: number) => void;
  const exited = new Promise<number>((resolve) => { finish = resolve; });
  const signals: string[] = [];
  const writes: Uint8Array[] = [];
  const process: ClaudeProcess = {
    identity: Promise.resolve({ pid: 8_123, pidDomain: "darwin", procStart: "synthetic-cleanup-child" }),
    exited,
    stdout: {
      [Symbol.asyncIterator]() {
        return {
          async next(): Promise<IteratorResult<Uint8Array>> {
            await exited;
            return { done: true, value: undefined };
          },
        };
      },
    },
    stderr: { async *[Symbol.asyncIterator]() { /* silent synthetic child */ } },
    async write(bytes) { writes.push(bytes.slice()); },
    terminate() { signals.push("SIGTERM"); finish(0); },
    forceTerminate() { signals.push("SIGKILL"); finish(0); },
  };
  return { process, signals, writes };
};

type CloseOutcome =
  | Readonly<{ kind: "joined" }>
  | Readonly<{ kind: "rejected"; error: unknown }>
  | Readonly<{ kind: "harness_deadline" }>;

test.each(["turnStarted", "providerError"] as const)(
  "bounds cleanup while its %s observer is held and retains the same drain for retry", async (blockedFact) => {
    const child = inMemoryProcess();
    const facts: ClaudeFact[] = [];
    let enterObserver!: () => void;
    const observerEntered = new Promise<void>((resolve) => { enterObserver = resolve; });
    let releaseObserver!: () => void;
    const observerGate = new Promise<void>((resolve) => { releaseObserver = resolve; });
    const client = new ClaudeStreamClient({
      process: child.process,
      configDir: "/var/oompa/profiles/synthetic/claude",
      shutdownSettlementMs: 10,
      onFact: async (fact) => {
        facts.push(fact);
        if (fact.type === blockedFact) { enterObserver(); await observerGate; }
      },
    });
    const closes: Promise<CloseOutcome>[] = [];
    const tryClose = async (): Promise<CloseOutcome> => {
      const closing = client.close().then(
        (): CloseOutcome => ({ kind: "joined" }),
        (error: unknown): CloseOutcome => ({ kind: "rejected", error }),
      );
      closes.push(closing);
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        // This deadline only detects the old infinite await. It neither
        // releases the observer nor supplies production cleanup evidence.
        return await Promise.race([
          closing,
          new Promise<CloseOutcome>((resolve) => {
            timer = setTimeout(() => resolve({ kind: "harness_deadline" }), 100);
          }),
        ]);
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    };
    const starting = client.startTurn({ turnId: "turn-held-cleanup", message: "Bounded cleanup" });
    const startOutcome = starting.then(() => null, (error: unknown) => error);
    try {
      if (blockedFact === "turnStarted") await observerEntered;
      else expect(await startOutcome).toBeNull();
      const firstAttempt = tryClose();
      await observerEntered;
      const first = await firstAttempt;
      expect(client.state).toBe("closing");
      const second = await tryClose();
      expect(client.state).toBe("closing");
      expect(child.signals).toEqual(["SIGTERM"]);
      expect(child.writes).toHaveLength(1);
      expect(facts.map((fact) => fact.type)).toEqual(blockedFact === "turnStarted"
        ? ["turnStarted"] : ["turnStarted", "providerError"]);
      await expect(client.steer("must remain fenced")).rejects.toMatchObject({ code: "PROCESS_EXITED" });

      releaseObserver();
      expect(await startOutcome).toBeNull();
      await Promise.all(closes);
      await client.close();
      expect(client.state).toBe("closed");
      expect(facts.map((fact) => fact.type)).toEqual(["turnStarted", "providerError", "turnCompleted"]);
      expect(facts.find((fact) => fact.type === "turnCompleted"))
        .toMatchObject({ turnId: "turn-held-cleanup", status: "failed" });
      expect(child.signals).toEqual(["SIGTERM"]);
      await client.close();
      expect(child.signals).toEqual(["SIGTERM"]);
      expect(first).toMatchObject({ kind: "rejected", error: { code: "TIMEOUT" } });
      expect(second).toMatchObject({ kind: "rejected", error: { code: "TIMEOUT" } });
    } finally {
      // Even the unbounded baseline gets its observer released and its exact
      // child/drain joined before this deterministic test returns.
      releaseObserver();
      await startOutcome;
      await Promise.all(closes);
      await client.close();
    }
  },
);

test.each(["turnStarted", "providerError"] as const)(
  "retains terminal history and the first error when its held %s observer rejects", async (blockedFact) => {
    const child = inMemoryProcess();
    const facts: ClaudeFact[] = [];
    const observerError = new Error("synthetic first observer failure");
    const laterError = new Error("synthetic completion observer failure");
    let enterObserver!: () => void;
    const observerEntered = new Promise<void>((resolve) => { enterObserver = resolve; });
    let releaseObserver!: () => void;
    let rejectObserver!: (error: Error) => void;
    const observerGate = new Promise<void>((resolve, reject) => {
      releaseObserver = resolve;
      rejectObserver = reject;
    });
    const client = new ClaudeStreamClient({
      process: child.process,
      configDir: "/var/oompa/profiles/synthetic/claude",
      shutdownSettlementMs: 10,
      onFact: async (fact) => {
        facts.push(fact);
        if (fact.type === blockedFact) { enterObserver(); await observerGate; }
        // Even a later delivery failure must not replace the first one.
        if (fact.type === "turnCompleted") throw laterError;
      },
    });
    const starting = client.startTurn({ turnId: "turn-rejecting-cleanup", message: "Retain all terminal attempts" });
    const startOutcome = starting.then(() => null, (error: unknown) => error);
    let firstClose: Promise<CloseOutcome> | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      if (blockedFact === "turnStarted") await observerEntered;
      else expect(await startOutcome).toBeNull();
      firstClose = client.close().then(
        (): CloseOutcome => ({ kind: "joined" }),
        (error: unknown): CloseOutcome => ({ kind: "rejected", error }),
      );
      await observerEntered;
      // Crossing the actual close deadline proves its retained task already
      // owns the blocked observer before rejection, without private-state access.
      const held = await Promise.race([
        firstClose,
        new Promise<CloseOutcome>((resolve) => {
          timer = setTimeout(() => resolve({ kind: "harness_deadline" }), 100);
        }),
      ]);
      if (timer !== undefined) clearTimeout(timer);
      expect(client.state).toBe("closing");
      expect(child.signals).toEqual(["SIGTERM"]);
      rejectObserver(observerError);
      const error = await client.close().then(() => null, (failure: unknown) => failure);
      expect(await startOutcome).toBe(blockedFact === "turnStarted" ? observerError : null);
      expect(held).toMatchObject({ kind: "rejected", error: { code: "TIMEOUT" } });
      expect(error).toBe(observerError);
      expect(facts.map((fact) => fact.type)).toEqual(["turnStarted", "providerError", "turnCompleted"]);
      expect(facts.find((fact) => fact.type === "turnCompleted"))
        .toMatchObject({ turnId: "turn-rejecting-cleanup", status: "failed" });
      const delivered = [...facts];
      await client.close();
      expect(client.state).toBe("closed");
      expect(facts).toEqual(delivered);
      expect(child.signals).toEqual(["SIGTERM"]);
      expect(child.writes).toHaveLength(1);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      releaseObserver();
      await startOutcome;
      await firstClose;
      // Delivery rejection is already an asserted result, not permission to
      // leave any exact process/observer task unjoined during test cleanup.
      await client.close().catch(() => undefined);
    }
  },
);
