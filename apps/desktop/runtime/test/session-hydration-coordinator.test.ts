import { describe, expect, test } from "bun:test";

import {
  CodexJsonlWriter,
  MAX_CODEX_JSONL_LINE_BYTES,
  PinnedCodexProtocol,
  type CodexFact,
  type CodexJsonlSink,
  type PinnedCodexResponseAtPosition,
  type PinnedCodexThread,
  type PinnedCodexThreadList,
  type PinnedCodexThreadResponse,
} from "../src/codex";
import {
  SESSION_HYDRATION_POLICY,
  SessionHydrationBufferPool,
} from "../src/sessions/hydration";
import {
  SessionHydrationCoordinator,
  type SessionHydrationRequestPort,
  type SessionHydrationThreadListRequest,
  type SessionHydrationThreadReadRequest,
} from "../src/sessions/hydration-coordinator";
import {
  pinnedThreadFixture,
  pinnedTurnFixture,
} from "./codex-pinned-fixtures";

const accountProfileId = "account_1";
const generation = 7;
const jsonEncoder = new TextEncoder();
const jsonDecoder = new TextDecoder();

class MemorySink implements CodexJsonlSink {
  readonly writes: string[] = [];

  write(bytes: Uint8Array): number {
    this.writes.push(jsonDecoder.decode(bytes));
    return bytes.byteLength;
  }
}

function lastRequestId(sink: MemorySink): string {
  const line = sink.writes.at(-1);
  if (line === undefined) throw new Error("Missing Codex request");
  const parsed: unknown = JSON.parse(line);
  if (
    typeof parsed !== "object" || parsed === null ||
    !("id" in parsed) || typeof parsed.id !== "string"
  ) {
    throw new Error("Codex request is missing its identifier");
  }
  return parsed.id;
}

function thread(
  state: "active" | "terminal" = "terminal",
  items?: PinnedCodexThread["turns"][number]["items"],
): PinnedCodexThread {
  const turnItems = items ?? [...pinnedTurnFixture.items];
  return {
    ...pinnedThreadFixture,
    status: state === "active"
      ? { type: "active", activeFlags: [] }
      : { type: "idle" },
    turns: state === "active"
      ? [{
          id: pinnedTurnFixture.id,
          items: turnItems,
          itemsView: pinnedTurnFixture.itemsView,
          status: "inProgress",
          startedAt: pinnedTurnFixture.startedAt,
          completedAt: null,
        }]
      : [{ ...pinnedTurnFixture, items: turnItems }],
  };
}

function positioned<T>(
  output: T,
  streamPosition: number,
  responseGeneration = generation,
): PinnedCodexResponseAtPosition<T> {
  return { generation: responseGeneration, output, streamPosition };
}

function listed(
  raw: PinnedCodexThread,
  streamPosition = 10,
): PinnedCodexResponseAtPosition<PinnedCodexThreadList> {
  return listPage([raw], streamPosition);
}

function listPage(
  data: readonly PinnedCodexThread[],
  streamPosition: number,
  nextCursor: string | null = null,
): PinnedCodexResponseAtPosition<PinnedCodexThreadList> {
  return positioned({
    backwardsCursor: null,
    data: [...data],
    nextCursor,
  }, streamPosition);
}

function read(
  raw: PinnedCodexThread,
  streamPosition = 20,
): PinnedCodexResponseAtPosition<PinnedCodexThreadResponse> {
  return positioned({ thread: raw }, streamPosition);
}

function targetPlan() {
  return {
    cwdFilterBatches: [[pinnedThreadFixture.cwd]],
    historyThreadIds: [pinnedThreadFixture.id],
    metadataThreadIds: [pinnedThreadFixture.id],
  } as const;
}

function delta(streamPosition: number, encodedBytes = 1): CodexFact {
  return {
    accountProfileId,
    channel: "assistant_text",
    delta: "x",
    encodedBytes,
    factIndex: 0,
    generation,
    itemId: pinnedTurnFixture.items[0]!.id,
    origin: "live",
    streamPosition,
    threadId: pinnedThreadFixture.id,
    truncated: false,
    turnId: pinnedTurnFixture.id,
    type: "item.delta",
  };
}

function accountFact(streamPosition: number): CodexFact {
  return {
    accountProfileId,
    availability: "signed_in",
    encodedBytes: 1,
    factIndex: 0,
    generation,
    origin: "live",
    streamPosition,
    type: "account.changed",
  };
}

function threadStatusFact(
  streamPosition: number,
  status: "active" | "idle" = "idle",
): CodexFact {
  return {
    accountProfileId,
    encodedBytes: 1,
    factIndex: 0,
    generation,
    origin: "live",
    status,
    streamPosition,
    threadId: pinnedThreadFixture.id,
    type: "thread.status_changed",
  };
}

function threadDeletedFact(streamPosition: number): CodexFact {
  return {
    accountProfileId,
    encodedBytes: 1,
    factIndex: 0,
    generation,
    origin: "live",
    streamPosition,
    threadId: pinnedThreadFixture.id,
    type: "thread.deleted",
  };
}

function threadSnapshotFact(
  streamPosition: number,
  status: "active" | "idle",
): CodexFact {
  return {
    accountProfileId,
    encodedBytes: 1,
    factIndex: 0,
    generation,
    origin: "live",
    streamPosition,
    thread: {
      archived: false,
      createdAt: "2026-07-29T00:00:00.000Z",
      cwd: pinnedThreadFixture.cwd,
      id: pinnedThreadFixture.id,
      status,
      title: "Thread",
      turns: status === "active"
        ? [{
            completedAt: null,
            id: pinnedTurnFixture.id,
            items: null,
            startedAt: "2026-07-29T00:00:01.000Z",
            status: "active",
          }]
        : [],
      updatedAt: "2026-07-29T00:01:00.000Z",
    },
    type: "thread.snapshot",
  };
}

function terminalTurnSnapshotFact(streamPosition: number): CodexFact {
  return {
    accountProfileId,
    encodedBytes: 1,
    factIndex: 0,
    generation,
    origin: "live",
    streamPosition,
    threadId: pinnedThreadFixture.id,
    turn: {
      completedAt: "2026-07-29T00:01:00.000Z",
      id: pinnedTurnFixture.id,
      items: [{
        id: pinnedTurnFixture.items[0]!.id,
        kind: "assistant_text",
        text: "authoritative completion",
        truncated: false,
      }],
      startedAt: "2026-07-29T00:00:01.000Z",
      status: "completed",
    },
    type: "turn.snapshot",
  };
}

function partialTerminalTurnSnapshotFact(streamPosition: number): CodexFact {
  const fact = terminalTurnSnapshotFact(streamPosition);
  if (fact.type !== "turn.snapshot") throw new Error("Expected turn snapshot");
  return { ...fact, turn: { ...fact.turn, items: null } };
}

function turnCompletedFact(streamPosition: number, factIndex = 0): CodexFact {
  return {
    accountProfileId,
    completedAt: "2026-07-29T00:01:00.000Z",
    encodedBytes: 1,
    factIndex,
    generation,
    origin: "live",
    status: "completed",
    streamPosition,
    threadId: pinnedThreadFixture.id,
    turnId: pinnedTurnFixture.id,
    type: "turn.completed",
  };
}

function createCoordinator(input: Readonly<{
  install?: (facts: readonly CodexFact[]) => void;
  now?: () => number;
  pool?: SessionHydrationBufferPool;
  requests: SessionHydrationRequestPort;
  sleep?: (milliseconds: number) => Promise<void>;
}>): SessionHydrationCoordinator {
  return new SessionHydrationCoordinator({
    getTargetPlan: targetPlan,
    install: ({ facts }) => input.install?.(facts),
    now: input.now ?? (() => 0),
    ...(input.pool === undefined ? {} : { pool: input.pool }),
    requests: input.requests,
    ...(input.sleep === undefined ? {} : { sleep: input.sleep }),
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

describe("SessionHydrationCoordinator", () => {
  test("installs one ordered terminal snapshot batch across the response boundary", async () => {
    const installed: Array<readonly CodexFact[]> = [];
    const listRequests: SessionHydrationThreadListRequest[] = [];
    const readRequests: SessionHydrationThreadReadRequest[] = [];
    const coordinatorReference: { current: SessionHydrationCoordinator | null } = {
      current: null,
    };
    const requests: SessionHydrationRequestPort = {
      threadList(request) {
        listRequests.push(request);
        return Promise.resolve(listed(thread()));
      },
      threadRead(request) {
        readRequests.push(request);
        // Position 19 precedes the response envelope. Position 21 models a
        // notification parsed after envelope 20 but before this promise wakes.
        const active = coordinatorReference.current;
        if (active === null) throw new Error("Hydration coordinator is not active");
        expect(active.acceptLiveFact(delta(19))).toBe(true);
        const response = read(thread());
        expect(active.acceptLiveFact(delta(21))).toBe(true);
        return Promise.resolve(response);
      },
    };
    const coordinator = createCoordinator({
      install: (facts) => installed.push(facts),
      requests,
    });
    coordinatorReference.current = coordinator;
    coordinator.startGeneration({ accountProfileId, generation, startedAt: 0 });
    expect(coordinator.acceptLiveFact(delta(5))).toBe(true);
    expect(coordinator.acceptLiveFact(accountFact(6))).toBe(true);

    const result = await coordinator.onRunning(accountProfileId, generation);

    expect(result).toEqual({
      attempts: 1,
      facts: 5,
      kind: "installed",
      recoveringThreadIds: [],
    });
    expect(installed).toHaveLength(1);
    expect(installed[0]?.map((fact) => [
      fact.streamPosition,
      fact.factIndex,
      fact.type,
    ])).toEqual([
      [6, 0, "account.changed"],
      [10, 0, "thread.snapshot"],
      [20, 0, "thread.snapshot"],
      [20, 1, "hydration.changed"],
      [21, 0, "item.delta"],
    ]);
    expect(installed[0]?.some((fact) => fact.streamPosition === 5)).toBe(false);
    expect(installed[0]?.some((fact) => fact.streamPosition === 19)).toBe(false);
    expect(coordinator.acceptLiveFact(delta(22))).toBe(false);
    expect(listRequests[0]?.input).toEqual({
      archived: false,
      cursor: null,
      cwd: [pinnedThreadFixture.cwd],
      limit: SESSION_HYDRATION_POLICY.maxMetadataThreadsPerAccount,
      sortDirection: "desc",
      sortKey: "updated_at",
      sourceKinds: ["appServer"],
    });
    expect(readRequests[0]?.input).toEqual({
      includeTurns: true,
      threadId: pinnedThreadFixture.id,
    });
  });

  test("keeps active unwatermarked history explicitly recovering", async () => {
    const installed: Array<readonly CodexFact[]> = [];
    const coordinatorReference: { current: SessionHydrationCoordinator | null } = {
      current: null,
    };
    const coordinator = createCoordinator({
      install: (facts) => installed.push(facts),
      requests: {
        threadList: () => Promise.resolve(listed(thread("active"))),
        threadRead: () => {
          const active = coordinatorReference.current;
          if (active === null) throw new Error("Hydration coordinator is not active");
          expect(active.acceptLiveFact(delta(19))).toBe(true);
          const response = read(thread("active"));
          expect(active.acceptLiveFact(delta(21))).toBe(true);
          return Promise.resolve(response);
        },
      },
    });
    coordinatorReference.current = coordinator;
    coordinator.startGeneration({ accountProfileId, generation, startedAt: 0 });

    const result = await coordinator.onRunning(accountProfileId, generation);

    expect(result).toEqual({
      attempts: 1,
      facts: 2,
      kind: "installed",
      recoveringThreadIds: [pinnedThreadFixture.id],
    });
    expect(installed[0]?.map((fact) => [fact.type, fact.streamPosition])).toEqual([
      ["thread.snapshot", 10],
      ["hydration.changed", 20],
    ]);
    const recoveryFact = installed[0]?.[1];
    expect(recoveryFact?.type).toBe("hydration.changed");
    if (recoveryFact?.type !== "hydration.changed") {
      throw new Error("Expected a hydration fact");
    }
    expect(recoveryFact.status).toBe("recovering");
    expect(recoveryFact.threadId).toBe(pinnedThreadFixture.id);
    expect(coordinator.recoveringThreadIds(accountProfileId, generation)).toEqual([
      pinnedThreadFixture.id,
    ]);
    expect(coordinator.admitAfterHydration(delta(22))).toBe(false);
    expect(coordinator.admitAfterHydration(threadSnapshotFact(23, "active"))).toBe(false);
    expect(coordinator.admitAfterHydration(threadStatusFact(24, "active"))).toBe(true);
    expect(coordinator.recoveringThreadIds(accountProfileId, generation)).toEqual([
      pinnedThreadFixture.id,
    ]);
    // A completion notification projects the authoritative terminal snapshot
    // before its lifecycle fact at the same stream position. Admit both so the
    // completed items replace any stale streaming text.
    expect(coordinator.admitAfterHydration(terminalTurnSnapshotFact(25))).toBe(true);
    expect(coordinator.admitAfterHydration(turnCompletedFact(25, 1))).toBe(true);
    expect(coordinator.recoveringThreadIds(accountProfileId, generation)).toEqual([]);
    expect(coordinator.takeRecoveredThreadIds(accountProfileId, generation)).toEqual([
      pinnedThreadFixture.id,
    ]);
    expect(coordinator.takeRecoveredThreadIds(accountProfileId, generation)).toEqual([]);
    expect(coordinator.admitAfterHydration(delta(26))).toBe(true);
  });

  test("clears recovery only on authoritative complete quiescent snapshots", async () => {
    const clearingFacts = [
      {
        accountProfileId,
        encodedBytes: 1,
        factIndex: 0,
        generation,
        origin: "live",
        streamPosition: 30,
        threadId: pinnedThreadFixture.id,
        type: "thread.deleted",
      } satisfies CodexFact,
      threadSnapshotFact(30, "idle"),
    ];
    for (const clearingFact of clearingFacts) {
      const coordinator = createCoordinator({
        requests: {
          threadList: () => Promise.resolve(listed(thread("active"))),
          threadRead: () => Promise.resolve(read(thread("active"))),
        },
      });
      coordinator.startGeneration({ accountProfileId, generation, startedAt: 0 });
      const result = await coordinator.onRunning(accountProfileId, generation);
      expect(result.kind).toBe("installed");
      expect(coordinator.recoveringThreadIds(accountProfileId, generation)).toEqual([
        pinnedThreadFixture.id,
      ]);

      expect(coordinator.admitAfterHydration(clearingFact)).toBe(true);
      expect(coordinator.recoveringThreadIds(accountProfileId, generation)).toEqual([]);
      expect(coordinator.admitAfterHydration(delta(31))).toBe(true);
      coordinator.stop();
    }
  });

  test("keeps partial completion and status-only quiescence recovering", async () => {
    const coordinator = createCoordinator({
      requests: {
        threadList: () => Promise.resolve(listed(thread("active"))),
        threadRead: () => Promise.resolve(read(thread("active"))),
      },
    });
    coordinator.startGeneration({ accountProfileId, generation, startedAt: 0 });
    expect((await coordinator.onRunning(accountProfileId, generation)).kind).toBe(
      "installed",
    );
    expect(coordinator.admitAfterHydration(partialTerminalTurnSnapshotFact(30)))
      .toBe(false);
    expect(coordinator.admitAfterHydration(turnCompletedFact(30, 1))).toBe(false);
    expect(coordinator.admitAfterHydration(threadStatusFact(31))).toBe(true);
    expect(coordinator.recoveringThreadIds(accountProfileId, generation)).toEqual([
      pinnedThreadFixture.id,
    ]);
    expect(coordinator.takeRecoveredThreadIds(accountProfileId, generation)).toEqual([]);
  });

  test("retries after count overflow without publishing the discarded attempt", async () => {
    const firstList = deferred<PinnedCodexResponseAtPosition<PinnedCodexThreadList>>();
    const firstListStarted = deferred<void>();
    const sleeps: number[] = [];
    const installed: Array<readonly CodexFact[]> = [];
    let listCalls = 0;
    const coordinator = createCoordinator({
      install: (facts) => installed.push(facts),
      requests: {
        threadList: async () => {
          listCalls += 1;
          if (listCalls === 1) {
            firstListStarted.resolve();
            return await firstList.promise;
          }
          return listed(thread(), 4_000);
        },
        threadRead: () => Promise.resolve(read(thread(), 5_000)),
      },
      sleep: (milliseconds) => {
        sleeps.push(milliseconds);
        return Promise.resolve();
      },
    });
    coordinator.startGeneration({ accountProfileId, generation, startedAt: 0 });
    const running = coordinator.onRunning(accountProfileId, generation);
    await firstListStarted.promise;
    for (
      let index = 0;
      index <= SESSION_HYDRATION_POLICY.maxFactsPerAccount;
      index += 1
    ) {
      expect(coordinator.acceptLiveFact(delta(index + 1, 0))).toBe(true);
    }
    firstList.resolve(listed(thread(), 3_000));

    const result = await running;

    expect(result).toEqual({
      attempts: 2,
      facts: 3,
      kind: "installed",
      recoveringThreadIds: [],
    });
    expect(listCalls).toBe(2);
    expect(sleeps).toEqual([250]);
    expect(installed).toHaveLength(1);
    expect(installed[0]?.every((fact) => fact.streamPosition >= 4_000)).toBe(true);
  });

  test("retries an attempt whose total deadline expires during a read", async () => {
    const firstList = deferred<PinnedCodexResponseAtPosition<PinnedCodexThreadList>>();
    const firstListStarted = deferred<void>();
    const sleeps: number[] = [];
    let now = 0;
    let listCalls = 0;
    const coordinator = createCoordinator({
      now: () => now,
      requests: {
        threadList: async () => {
          listCalls += 1;
          if (listCalls === 1) {
            firstListStarted.resolve();
            return await firstList.promise;
          }
          return listed(thread(), 20);
        },
        threadRead: () => Promise.resolve(read(thread(), 30)),
      },
      sleep: (milliseconds) => {
        sleeps.push(milliseconds);
        return Promise.resolve();
      },
    });
    coordinator.startGeneration({ accountProfileId, generation, startedAt: now });
    const running = coordinator.onRunning(accountProfileId, generation);
    await firstListStarted.promise;
    now = SESSION_HYDRATION_POLICY.attemptDeadlineMs;
    firstList.resolve(listed(thread(), 10));

    const result = await running;

    expect(result.kind).toBe("installed");
    if (result.kind !== "installed") throw new Error("Expected installed hydration");
    expect(result.attempts).toBe(2);
    expect(listCalls).toBe(2);
    expect(sleeps).toEqual([250]);
  });

  test("suppresses a single over-byte fact while its attempt retries", async () => {
    const firstList = deferred<PinnedCodexResponseAtPosition<PinnedCodexThreadList>>();
    const firstListStarted = deferred<void>();
    let listCalls = 0;
    const coordinator = createCoordinator({
      requests: {
        threadList: async () => {
          listCalls += 1;
          if (listCalls === 1) {
            firstListStarted.resolve();
            return await firstList.promise;
          }
          return listed(thread(), 40);
        },
        threadRead: () => Promise.resolve(read(thread(), 50)),
      },
      sleep: () => Promise.resolve(),
    });
    coordinator.startGeneration({ accountProfileId, generation, startedAt: 0 });
    const running = coordinator.onRunning(accountProfileId, generation);
    await firstListStarted.promise;
    const oversized = delta(5, SESSION_HYDRATION_POLICY.maxFactBytesPerAccount + 1);
    expect(coordinator.acceptLiveFact(oversized)).toBe(false);
    expect(coordinator.admitAfterHydration(oversized)).toBe(false);
    firstList.resolve(listed(thread(), 30));

    const result = await running;
    expect(result.kind).toBe("installed");
    if (result.kind !== "installed") throw new Error("Expected installed hydration");
    expect(result.attempts).toBe(2);
  });

  test("opens a typed history-unavailable circuit for oversize non-pageable history", async () => {
    const largeText = "x".repeat(1_600_000);
    const largeItems: PinnedCodexThread["turns"][number]["items"] = Array.from(
      { length: 4 },
      (_, index) => ({
        id: `item-large-${String(index)}`,
        text: largeText,
        type: "agentMessage" as const,
      }),
    );
    const largeThread = thread("terminal", largeItems);
    const installed: Array<readonly CodexFact[]> = [];
    const sleeps: number[] = [];
    let readCalls = 0;
    const coordinator = createCoordinator({
      install: (facts) => installed.push(facts),
      requests: {
        threadList: () => Promise.resolve(listed(largeThread)),
        threadRead: () => {
          readCalls += 1;
          return Promise.resolve(read(largeThread));
        },
      },
      sleep: (milliseconds) => {
        sleeps.push(milliseconds);
        return Promise.resolve();
      },
    });
    coordinator.startGeneration({ accountProfileId, generation, startedAt: 0 });

    const result = await coordinator.onRunning(accountProfileId, generation);

    expect(result).toEqual({
      attempts: 1,
      facts: 2,
      kind: "installed",
      recoveringThreadIds: [],
    });
    expect(readCalls).toBe(1);
    expect(sleeps).toEqual([]);
    const unavailableFact = installed[0]?.[1];
    expect(unavailableFact?.type).toBe("hydration.changed");
    if (unavailableFact?.type !== "hydration.changed") {
      throw new Error("Expected a hydration fact");
    }
    expect(unavailableFact.status).toBe("history_unavailable");
  }, 20_000);

  test("classifies a serialized large thread/read through the production JSONL boundary", async () => {
    const text = "x".repeat(2 * 1_024 * 1_024 + 64 * 1_024);
    const rawThread = {
      ...thread(),
      turns: [{
        ...pinnedTurnFixture,
        items: Array.from({ length: 4 }, (_, index) => ({
          type: "agentMessage" as const,
          id: `serialized-large-item-${String(index)}`,
          text,
          phase: null,
          memoryCitation: null,
        })),
      }],
    };
    const sink = new MemorySink();
    const protocol = new PinnedCodexProtocol(
      generation,
      new CodexJsonlWriter(sink),
    );
    const installed: Array<readonly CodexFact[]> = [];
    const coordinator = createCoordinator({
      install: (facts) => installed.push(facts),
      requests: {
        threadList: () => Promise.resolve(listed(thread(), 1)),
        threadRead: async ({ input }) => {
          const response = protocol.requestWithResponsePosition("threadRead", input);
          await Bun.sleep(0);
          const id = lastRequestId(sink);
          await protocol.receiveValue(generation, {
            method: "account/updated",
            params: { authMode: null, planType: null },
          });
          const line = JSON.stringify({ id, result: { thread: rawThread } });
          const bytes = jsonEncoder.encode(`${line}\n`);
          expect(bytes.byteLength).toBeGreaterThan(8 * 1_024 * 1_024);
          expect(bytes.byteLength).toBeLessThan(MAX_CODEX_JSONL_LINE_BYTES);
          await protocol.receiveChunk(generation, bytes);
          return await response;
        },
      },
    });
    coordinator.startGeneration({ accountProfileId, generation, startedAt: 0 });

    const result = await coordinator.onRunning(accountProfileId, generation);

    expect(result).toEqual({
      attempts: 1,
      facts: 2,
      kind: "installed",
      recoveringThreadIds: [],
    });
    const unavailable = installed[0]?.find((fact) => fact.type === "hydration.changed");
    expect(unavailable?.type).toBe("hydration.changed");
    if (unavailable?.type !== "hydration.changed") {
      throw new Error("Expected typed history compatibility state");
    }
    expect(unavailable.status).toBe("history_unavailable");
  }, 30_000);

  test("bounds read retries without asking process supervision to restart", async () => {
    const sleeps: number[] = [];
    const installed: Array<readonly CodexFact[]> = [];
    let calls = 0;
    const coordinator = createCoordinator({
      install: (facts) => installed.push(facts),
      requests: {
        threadList: () => {
          calls += 1;
          return Promise.reject(new Error("bounded fake read failure"));
        },
        threadRead: () => Promise.resolve(read(thread())),
      },
      sleep: (milliseconds) => {
        sleeps.push(milliseconds);
        return Promise.resolve();
      },
    });
    coordinator.startGeneration({ accountProfileId, generation, startedAt: 0 });

    const result = await coordinator.onRunning(accountProfileId, generation);

    expect(result).toEqual({
      attempts: 6,
      kind: "failed",
      reason: "read",
      recoveringThreadIds: [pinnedThreadFixture.id],
    });
    expect(calls).toBe(6);
    expect(sleeps).toEqual([250, 500, 1_000, 2_000, 5_000]);
    expect(installed).toEqual([]);
    expect(coordinator.recoveringThreadIds(accountProfileId, generation)).toEqual([
      pinnedThreadFixture.id,
    ]);
    expect(coordinator.admitAfterHydration(delta(50))).toBe(false);
    expect(coordinator.admitAfterHydration(threadStatusFact(51))).toBe(true);
    expect(coordinator.recoveringThreadIds(accountProfileId, generation)).toEqual([
      pinnedThreadFixture.id,
    ]);
    expect(coordinator.admitAfterHydration(delta(52))).toBe(false);
  });

  test("rejects stale generation completion and releases buffers idempotently", async () => {
    const firstList = deferred<PinnedCodexResponseAtPosition<PinnedCodexThreadList>>();
    const firstListStarted = deferred<void>();
    const installed: Array<readonly CodexFact[]> = [];
    const pool = new SessionHydrationBufferPool();
    const coordinator = createCoordinator({
      install: (facts) => installed.push(facts),
      pool,
      requests: {
        threadList: async () => {
          firstListStarted.resolve();
          return await firstList.promise;
        },
        threadRead: () => Promise.resolve(read(thread())),
      },
    });
    coordinator.startGeneration({ accountProfileId, generation, startedAt: 0 });
    const staleRun = coordinator.onRunning(accountProfileId, generation);
    await firstListStarted.promise;
    coordinator.startGeneration({
      accountProfileId,
      generation: generation + 1,
      startedAt: 1,
    });
    expect(coordinator.acceptLiveFact(delta(9))).toBe(false);
    firstList.resolve(listed(thread()));

    expect(await staleRun).toEqual({ kind: "stale_generation" });
    expect(installed).toEqual([]);
    coordinator.endGeneration(accountProfileId, generation);
    coordinator.endGeneration(accountProfileId, generation + 1);
    coordinator.endGeneration(accountProfileId, generation + 1);
    coordinator.stop();
    coordinator.stop();
    expect(pool.usage()).toEqual({ bytes: 0, facts: 0 });
  });

  test("fails closed when an exact-cwd list returns a foreign workspace", async () => {
    const installed: Array<readonly CodexFact[]> = [];
    const coordinator = createCoordinator({
      install: (facts) => installed.push(facts),
      requests: {
        threadList: () => Promise.resolve(listed({ ...thread(), cwd: "/tmp/foreign" })),
        threadRead: () => Promise.resolve(read(thread())),
      },
    });
    coordinator.startGeneration({ accountProfileId, generation, startedAt: 0 });

    const result = await coordinator.onRunning(accountProfileId, generation);

    expect(result).toEqual({
      attempts: 1,
      kind: "failed",
      reason: "protocol",
      recoveringThreadIds: [pinnedThreadFixture.id],
    });
    expect(installed).toEqual([]);
  });

  test("follows bounded metadata pagination before reading selected history", async () => {
    const requests: SessionHydrationThreadListRequest[] = [];
    let listPosition = 10;
    const coordinator = createCoordinator({
      requests: {
        threadList: (request) => {
          requests.push(request);
          const response = request.input.cursor === null
            ? listPage([{
                ...thread(),
                id: "unrelated-thread",
              }], listPosition, "page-2")
            : listPage([thread()], listPosition);
          listPosition += 1;
          return Promise.resolve(response);
        },
        threadRead: () => Promise.resolve(read(thread(), 20)),
      },
    });
    coordinator.startGeneration({ accountProfileId, generation, startedAt: 0 });

    const result = await coordinator.onRunning(accountProfileId, generation);

    expect(result.kind).toBe("installed");
    expect(requests.map(({ input }) => [input.archived, input.cursor])).toEqual([
      [false, null],
      [false, "page-2"],
    ]);
  });

  test("reconciles archived targets and leaves missing targets recovering", async () => {
    for (const disposition of ["archived", "unresolved"] as const) {
      const installed: Array<readonly CodexFact[]> = [];
      let readCalls = 0;
      let position = 10;
      const coordinator = createCoordinator({
        install: (facts) => installed.push(facts),
        requests: {
          threadList: (request) => {
            const data = request.input.archived === true && disposition === "archived"
              ? [thread()]
              : [];
            const response = listPage(data, position);
            position += 1;
            return Promise.resolve(response);
          },
          threadRead: () => {
            readCalls += 1;
            return Promise.resolve(read(thread()));
          },
        },
      });
      coordinator.startGeneration({ accountProfileId, generation, startedAt: 0 });

      const result = await coordinator.onRunning(accountProfileId, generation);

      expect(result).toEqual(disposition === "archived"
        ? {
            attempts: 1,
            facts: 1,
            kind: "installed",
            recoveringThreadIds: [],
          }
        : {
            attempts: 1,
            facts: 1,
            kind: "installed",
            recoveringThreadIds: [pinnedThreadFixture.id],
          });
      expect(readCalls).toBe(0);
      const fact = installed[0]?.[0];
      if (disposition === "archived") {
        expect(fact?.type).toBe("thread.snapshot");
        if (fact?.type !== "thread.snapshot") throw new Error("Expected snapshot");
        expect(fact.thread.archived).toBe(true);
      } else {
        expect(fact?.type).toBe("hydration.changed");
        if (fact?.type !== "hydration.changed") {
          throw new Error("Expected hydration recovery");
        }
        expect(fact.status).toBe("recovering");
      }
      coordinator.stop();
    }
  });

  test("preserves an authoritative buffered deletion across a missing list result", async () => {
    const installed: Array<readonly CodexFact[]> = [];
    let position = 10;
    let buffered = false;
    const coordinator = createCoordinator({
      install: (facts) => installed.push(facts),
      requests: {
        threadList: () => {
          if (!buffered) {
            buffered = true;
            expect(coordinator.acceptLiveFact(threadDeletedFact(9))).toBe(true);
          }
          const response = listPage([], position);
          position += 1;
          return Promise.resolve(response);
        },
        threadRead: () => Promise.resolve(read(thread())),
      },
    });
    coordinator.startGeneration({ accountProfileId, generation, startedAt: 0 });

    expect(await coordinator.onRunning(accountProfileId, generation)).toEqual({
      attempts: 1,
      facts: 1,
      kind: "installed",
      recoveringThreadIds: [],
    });
    expect(installed[0]?.map(({ type }) => type)).toEqual(["thread.deleted"]);
  });

  test("installs explicit recovery when bounded metadata pagination never settles", async () => {
    let listCalls = 0;
    let readCalls = 0;
    const coordinator = createCoordinator({
      requests: {
        threadList: () => {
          listCalls += 1;
          return Promise.resolve(listPage(
            [{ ...thread(), id: `unrelated-${String(listCalls)}` }],
            listCalls,
            `cursor-${String(listCalls)}`,
          ));
        },
        threadRead: () => {
          readCalls += 1;
          return Promise.resolve(read(thread()));
        },
      },
      sleep: () => Promise.resolve(),
    });
    coordinator.startGeneration({ accountProfileId, generation, startedAt: 0 });

    const result = await coordinator.onRunning(accountProfileId, generation);

    expect(result).toEqual({
      attempts: 1,
      facts: 1,
      kind: "installed",
      recoveringThreadIds: [pinnedThreadFixture.id],
    });
    expect(listCalls).toBe(SESSION_HYDRATION_POLICY.maxMetadataPagesPerQuery * 2);
    expect(readCalls).toBe(0);
  });

  test("detects a repeated metadata cursor without spinning", async () => {
    let listCalls = 0;
    const coordinator = createCoordinator({
      requests: {
        threadList: () => {
          listCalls += 1;
          return Promise.resolve(listPage([], listCalls, "stuck-cursor"));
        },
        threadRead: () => Promise.resolve(read(thread())),
      },
    });
    coordinator.startGeneration({ accountProfileId, generation, startedAt: 0 });

    expect(await coordinator.onRunning(accountProfileId, generation)).toEqual({
      attempts: 1,
      facts: 1,
      kind: "installed",
      recoveringThreadIds: [pinnedThreadFixture.id],
    });
    expect(listCalls).toBe(4);
  });
});
