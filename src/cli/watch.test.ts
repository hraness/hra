import { describe, expect, test } from "bun:test";

import type { SessionEvent, SessionEventPage } from "../domain/session-events";
import { followSessionEvents, writeSessionEventPageJsonl } from "./watch";

const sessionId = "sess_00000000000000000000000000000000" as const;
const accountId = "acct_00000000000000000000000000000000" as const;
const streamEpoch = "80000000-0000-4000-8000-000000000001";

const event = (
  sequence: number,
  message = "visible",
  epoch = streamEpoch,
): SessionEvent => ({
  version: 1,
  sessionId,
  streamEpoch: epoch,
  sequence,
  recordedAt: sequence,
  accountId,
  providerGeneration: 1,
  providerConnectionId: null,
  body: { type: "warning", code: "NOTICE", message },
});

const page = (input: {
  requestedCursor: string | null;
  nextCursor: string;
  events?: SessionEvent[];
  gap?: SessionEventPage["gap"];
}): SessionEventPage => ({
  version: 1,
  sessionId,
  requestedCursor: input.requestedCursor,
  retentionFloorCursor: "floor",
  observedThroughCursor: input.nextCursor,
  nextCursor: input.nextCursor,
  gap: input.gap ?? null,
  events: input.events ?? [],
});

describe("session event watch", () => {
  test("writes safe event lines followed by a resumable checkpoint", async () => {
    const stdout: string[] = [];
    await writeSessionEventPageJsonl(page({
      requestedCursor: "c0",
      nextCursor: "c1",
      events: [event(1, "visible\u001b]0;hidden\u0007")],
    }), { writeStdout: (value) => { stdout.push(value); } });
    expect(stdout).toHaveLength(2);
    const first = JSON.parse(stdout[0] ?? "") as Record<string, unknown>;
    const second = JSON.parse(stdout[1] ?? "") as Record<string, unknown>;
    expect(first).toMatchObject({ kind: "event", sessionId });
    expect(second).toEqual({
      version: 1,
      kind: "checkpoint",
      sessionId,
      nextCursor: "c1",
      retentionFloorCursor: "floor",
      observedThroughCursor: "c1",
      eventCount: 1,
    });
    expect(stdout.join("")).not.toContain("\u001b");
    expect(stdout.join("")).not.toContain("\u0007");
  });

  test("advances the opaque cursor across bounded long-poll pages", async () => {
    const requested: Array<string | undefined> = [];
    const stdout: string[] = [];
    const pages = [
      page({ requestedCursor: null, nextCursor: "c1", events: [event(1)] }),
      page({ requestedCursor: "c1", nextCursor: "c2", events: [event(2)] }),
    ];
    const result = await followSessionEvents({
      command: { kind: "session.events", session: "release", limit: 20, waitMs: 30_000 },
      fetchPage: (command) => {
        requested.push(command.cursor);
        const next = pages.shift();
        if (next === undefined) throw new Error("No page fixture.");
        return Promise.resolve(next);
      },
      maxPages: 2,
      output: { writeStdout: (value) => { stdout.push(value); } },
      signal: new AbortController().signal,
    });
    expect(requested).toEqual([undefined, "c1"]);
    expect(result).toEqual({ events: 2, lastCursor: "c2", pages: 2 });
    expect(stdout.map((line) => (JSON.parse(line) as { kind: string }).kind)).toEqual([
      "event",
      "checkpoint",
      "event",
      "checkpoint",
    ]);
  });

  test("reconnects after a classified transient fetch failure from the last durable cursor", async () => {
    const requested: Array<string | undefined> = [];
    const retryAttempts: number[] = [];
    const pages = [
      page({ requestedCursor: null, nextCursor: "c1", events: [event(1)] }),
      page({ requestedCursor: "c1", nextCursor: "c2", events: [event(2)] }),
    ];
    let transient = true;
    const result = await followSessionEvents({
      command: { kind: "session.events", session: "release", limit: 20, waitMs: 30_000 },
      fetchPage: (command) => {
        requested.push(command.cursor);
        if (command.cursor === "c1" && transient) {
          transient = false;
          return Promise.reject(new Error("transient transport loss"));
        }
        const next = pages.shift();
        if (next === undefined) throw new Error("No page fixture.");
        return Promise.resolve(next);
      },
      maxPages: 2,
      output: { writeStdout: () => {} },
      retryFetchError: (error, attempt) => {
        retryAttempts.push(attempt);
        return Promise.resolve(error instanceof Error && error.message === "transient transport loss");
      },
      signal: new AbortController().signal,
    });
    expect(requested).toEqual([undefined, "c1", "c1"]);
    expect(retryAttempts).toEqual([1]);
    expect(result).toEqual({ events: 2, lastCursor: "c2", pages: 2 });
  });

  test("emits a typed gap before retained events and its checkpoint", async () => {
    const stdout: string[] = [];
    await writeSessionEventPageJsonl(page({
      requestedCursor: "old",
      nextCursor: "new",
      gap: { reason: "retention_age", requestedSequence: 1, retainedFromSequence: 9 },
      events: [event(9)],
    }), { writeStdout: (value) => { stdout.push(value); } });
    expect(stdout.map((line) => (JSON.parse(line) as { kind: string }).kind)).toEqual([
      "gap",
      "event",
      "checkpoint",
    ]);
  });

  test("fails closed on cursor mismatch, non-advancing events, and zero-wait follow", async () => {
    const base = {
      command: { kind: "session.events", session: "release", limit: 20, waitMs: 30_000 } as const,
      maxPages: 1,
      output: { writeStdout: () => {} },
      signal: new AbortController().signal,
    };
    await expect(followSessionEvents({
      ...base,
      fetchPage: () => Promise.resolve(page({ requestedCursor: "foreign", nextCursor: "c1" })),
    })).rejects.toThrow("CURSOR_MISMATCH");
    await expect(followSessionEvents({
      ...base,
      command: { ...base.command, cursor: "c1" },
      fetchPage: () => Promise.resolve(page({ requestedCursor: "c1", nextCursor: "c1", events: [event(1)] })),
    })).rejects.toThrow("DID_NOT_ADVANCE");
    await expect(followSessionEvents({
      ...base,
      command: { ...base.command, waitMs: 0 },
      fetchPage: () => Promise.resolve(page({ requestedCursor: null, nextCursor: "c1" })),
    })).rejects.toThrow("REQUIRES_WAIT");
  });

  test("rejects foreign sessions and duplicate sequence delivery", async () => {
    const base = {
      command: { kind: "session.events", session: "release", limit: 20, waitMs: 30_000 } as const,
      maxPages: 1,
      output: { writeStdout: () => {} },
      signal: new AbortController().signal,
    };
    await expect(followSessionEvents({
      ...base,
      fetchPage: () => Promise.resolve({
        ...page({ requestedCursor: null, nextCursor: "c1", events: [event(1)] }),
        sessionId: "sess_11111111111111111111111111111111",
      }),
    })).rejects.toThrow("SESSION_MISMATCH");
    await expect(followSessionEvents({
      ...base,
      fetchPage: () => Promise.resolve(page({
        requestedCursor: null,
        nextCursor: "c1",
        events: [event(2), event(2)],
      })),
    })).rejects.toThrow("ORDER_MISMATCH");
  });

  test("keeps one session and one stream epoch per emitted page", async () => {
    const pages = [
      page({ requestedCursor: null, nextCursor: "c1" }),
      {
        ...page({ requestedCursor: "c1", nextCursor: "c2" }),
        sessionId: "sess_11111111111111111111111111111111" as const,
      },
    ];
    await expect(followSessionEvents({
      command: { kind: "session.events", session: "release", limit: 20, waitMs: 30_000 },
      fetchPage: () => {
        const next = pages.shift();
        if (next === undefined) throw new Error("No page fixture.");
        return Promise.resolve(next);
      },
      maxPages: 2,
      output: { writeStdout: () => {} },
      signal: new AbortController().signal,
    })).rejects.toThrow("SESSION_CHANGED");

    await expect(followSessionEvents({
      command: { kind: "session.events", session: "release", limit: 20, waitMs: 30_000 },
      fetchPage: () => Promise.resolve(page({
        requestedCursor: null,
        nextCursor: "c1",
        gap: { reason: "stream_restored", requestedSequence: null, retainedFromSequence: 1 },
        events: [
          event(1),
          event(2, "different epoch", "80000000-0000-4000-8000-000000000002"),
        ],
      })),
      maxPages: 1,
      output: { writeStdout: () => {} },
      signal: new AbortController().signal,
    })).rejects.toThrow("PAGE_STREAM_MISMATCH");
  });

  test("yields after empty unchanged pages and stops cleanly on abort", async () => {
    const controller = new AbortController();
    let yields = 0;
    const result = await followSessionEvents({
      command: { kind: "session.events", session: "release", cursor: "c1", limit: 20, waitMs: 30_000 },
      fetchPage: () => Promise.resolve(page({ requestedCursor: "c1", nextCursor: "c1" })),
      output: { writeStdout: () => {} },
      signal: controller.signal,
      yieldAfterEmptyPage: () => {
        yields += 1;
        controller.abort();
        return Promise.resolve();
      },
    });
    expect(yields).toBe(1);
    expect(result).toEqual({ events: 0, lastCursor: "c1", pages: 1 });
  });

  test("does not advance or fetch the next cursor until every JSONL line drains", async () => {
    const requested: Array<string | undefined> = [];
    const stdout: string[] = [];
    let releaseFirstLine!: () => void;
    const firstLineDrained = new Promise<void>((resolve) => { releaseFirstLine = resolve; });
    let firstWrite = true;
    const following = followSessionEvents({
      command: { kind: "session.events", session: "release", limit: 20, waitMs: 30_000 },
      fetchPage: (command) => {
        requested.push(command.cursor);
        return Promise.resolve(command.cursor === undefined
          ? page({ requestedCursor: null, nextCursor: "c1", events: [event(1)] })
          : page({ requestedCursor: "c1", nextCursor: "c2", events: [event(2)] }));
      },
      maxPages: 2,
      output: {
        writeStdout: () => { throw new Error("The async JSONL writer must own follow output."); },
        writeStdoutAsync: async (value) => {
          stdout.push(value);
          if (firstWrite) {
            firstWrite = false;
            await firstLineDrained;
          }
        },
      },
      signal: new AbortController().signal,
    });

    await Promise.resolve();
    await Promise.resolve();
    expect(requested).toEqual([undefined]);
    expect(stdout.map((line) => (JSON.parse(line) as { kind: string }).kind)).toEqual(["event"]);

    releaseFirstLine();
    const result = await following;
    expect(requested).toEqual([undefined, "c1"]);
    expect(result).toEqual({ events: 2, lastCursor: "c2", pages: 2 });
    expect(stdout.map((line) => (JSON.parse(line) as { kind: string }).kind)).toEqual([
      "event",
      "checkpoint",
      "event",
      "checkpoint",
    ]);
  });
});
