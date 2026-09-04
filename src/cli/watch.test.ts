import { describe, expect, test } from "bun:test";

import {
  SESSION_EVENT_PAGE_BYTES,
  type SessionEvent,
  type SessionEventPage,
} from "../domain/session-events";
import { followSessionEvents, writeSessionEventPageJsonl } from "./watch";

const sessionId = "sess_00000000000000000000000000000000" as const;
const accountId = "acct_00000000000000000000000000000000" as const;
const streamEpoch = "80000000-0000-4000-8000-000000000001";
const publicTurnId = `opaque_v2_${"1".repeat(64)}`;
const publicItemId = `opaque_v2_${"2".repeat(64)}`;
const cursorWireSignature = "A".repeat(43);
const cursorWire = (labelOrWire: string): string => labelOrWire.startsWith("hra1.")
  ? labelOrWire
  : `hra1.${Buffer.from(`fixture:${labelOrWire}`).toString("base64url")}.${cursorWireSignature}`;

const event = (
  sequence: number,
  message = "visible",
  epoch = streamEpoch,
  eventAccountId: string = accountId,
): SessionEvent => ({
  version: 1,
  sessionId,
  streamEpoch: epoch,
  sequence,
  recordedAt: sequence,
  accountId: eventAccountId,
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
  requestedCursor: input.requestedCursor === null
    ? null
    : cursorWire(input.requestedCursor),
  retentionFloorCursor: cursorWire("floor"),
  observedThroughCursor: cursorWire(input.nextCursor),
  nextCursor: cursorWire(input.nextCursor),
  gap: input.gap ?? null,
  events: input.events ?? [],
});

const waitFor = async (predicate: () => boolean): Promise<void> => {
  const deadline = Date.now() + 1_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for event follow output.");
    await Bun.sleep(1);
  }
};

describe("session event watch", () => {
  test("emits no partial output or checkpoint for a malformed next cursor", async () => {
    const stdout: string[] = [];
    const malformedPage = {
      ...page({
        requestedCursor: null,
        nextCursor: "valid-next",
        events: [event(1)],
      }),
      nextCursor: `hra1.Zh.${cursorWireSignature}`,
    };

    await expect(followSessionEvents({
      command: {
        kind: "session.events",
        session: sessionId,
        limit: 20,
        waitMs: 30_000,
      },
      fetchPage: () => Promise.resolve(malformedPage),
      maxPages: 1,
      output: { writeStdout: (value) => { stdout.push(value); } },
      signal: new AbortController().signal,
    })).rejects.toThrow("canonical HRA cursor envelope");
    expect(stdout).toEqual([]);
  });

  test("emits no partial output or checkpoint for an oversized event page", async () => {
    const stdout: string[] = [];
    const maximumDeltaCharacters = 32_768;
    const events = Array.from(
      {
        length: Math.floor(SESSION_EVENT_PAGE_BYTES / maximumDeltaCharacters) + 1,
      },
      (_, index): SessionEvent => ({
        ...event(index + 1),
        body: {
          type: "assistant_delta",
          turnId: publicTurnId,
          itemId: publicItemId,
          text: "x".repeat(maximumDeltaCharacters),
        },
      }),
    );

    await expect(followSessionEvents({
      command: {
        kind: "session.events",
        session: sessionId,
        limit: 20,
        waitMs: 30_000,
      },
      fetchPage: () => Promise.resolve(page({
        requestedCursor: null,
        nextCursor: "oversized",
        events,
      })),
      maxPages: 1,
      output: { writeStdout: (value) => { stdout.push(value); } },
      signal: new AbortController().signal,
    })).rejects.toThrow("A session event page exceeds its serialized event byte bound.");
    expect(stdout).toEqual([]);
  });

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
      nextCursor: cursorWire("c1"),
      retentionFloorCursor: cursorWire("floor"),
      observedThroughCursor: cursorWire("c1"),
      eventCount: 1,
    });
    expect(stdout.join("")).not.toContain("\u001b");
    expect(stdout.join("")).not.toContain("\u0007");
  });

  test("advances the opaque cursor across bounded long-poll pages", async () => {
    const requested: Array<string | undefined> = [];
    const requestedSessions: string[] = [];
    const stdout: string[] = [];
    const pages = [
      page({ requestedCursor: null, nextCursor: "c1", events: [event(1)] }),
      page({ requestedCursor: "c1", nextCursor: "c2", events: [event(2)] }),
    ];
    const result = await followSessionEvents({
      command: { kind: "session.events", session: "release", limit: 20, waitMs: 30_000 },
      fetchPage: (command) => {
        requested.push(command.cursor);
        requestedSessions.push(command.session);
        const next = pages.shift();
        if (next === undefined) throw new Error("No page fixture.");
        return Promise.resolve(next);
      },
      maxPages: 2,
      output: { writeStdout: (value) => { stdout.push(value); } },
      signal: new AbortController().signal,
    });
    expect(requested).toEqual([undefined, cursorWire("c1")]);
    expect(requestedSessions).toEqual(["release", sessionId]);
    expect(result).toEqual({ events: 2, lastCursor: cursorWire("c2"), pages: 2 });
    expect(stdout.map((line) => (JSON.parse(line) as { kind: string }).kind)).toEqual([
      "event",
      "checkpoint",
      "event",
      "checkpoint",
    ]);
  });

  test("bootstraps an empty stream once and pins follow-up reads to the resolved session", async () => {
    const requested: Array<Readonly<{ cursor: string | undefined; session: string }>> = [];
    const pages = [
      page({ requestedCursor: null, nextCursor: "initial-checkpoint" }),
      page({ requestedCursor: "initial-checkpoint", nextCursor: "c1", events: [event(1)] }),
    ];
    const result = await followSessionEvents({
      command: { kind: "session.events", session: "release", limit: 20, waitMs: 30_000 },
      fetchPage: (command) => {
        requested.push({ cursor: command.cursor, session: command.session });
        const next = pages.shift();
        if (next === undefined) throw new Error("No bootstrap page fixture.");
        return Promise.resolve(next);
      },
      maxPages: 2,
      output: { writeStdout: () => {} },
      signal: new AbortController().signal,
    });

    expect(requested).toEqual([
      { cursor: undefined, session: "release" },
      { cursor: cursorWire("initial-checkpoint"), session: sessionId },
    ]);
    expect(result).toEqual({ events: 1, lastCursor: cursorWire("c1"), pages: 2 });
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
        if (command.cursor === cursorWire("c1") && transient) {
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
    expect(requested).toEqual([
      undefined,
      cursorWire("c1"),
      cursorWire("c1"),
    ]);
    expect(retryAttempts).toEqual([1]);
    expect(result).toEqual({ events: 2, lastCursor: cursorWire("c2"), pages: 2 });
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

  test("continues across a restored stream after the typed gap drains", async () => {
    const restoredEpoch = "80000000-0000-4000-8000-000000000099";
    const requested: Array<string | undefined> = [];
    const stdout: string[] = [];
    let releaseGap!: () => void;
    const gapDrained = new Promise<void>((resolve) => { releaseGap = resolve; });
    const pages = [
      page({ requestedCursor: null, nextCursor: "old-1", events: [event(1)] }),
      page({
        requestedCursor: "old-1",
        nextCursor: "restored-0",
        gap: { reason: "stream_restored", requestedSequence: 1, retainedFromSequence: 1 },
        events: [],
      }),
      page({
        requestedCursor: "restored-0",
        nextCursor: "restored-1",
        events: [event(1, "restored after an empty gap page", restoredEpoch)],
      }),
    ];
    const following = followSessionEvents({
      command: { kind: "session.events", session: "release", limit: 20, waitMs: 30_000 },
      fetchPage: (command) => {
        requested.push(command.cursor);
        const next = pages.shift();
        if (next === undefined) throw new Error("No restored-stream page fixture.");
        return Promise.resolve(next);
      },
      maxPages: 3,
      output: {
        writeStdout: () => { throw new Error("The async JSONL writer must own follow output."); },
        writeStdoutAsync: async (value) => {
          stdout.push(value);
          const parsed = JSON.parse(value) as { kind?: string };
          if (parsed.kind === "gap") await gapDrained;
        },
      },
      signal: new AbortController().signal,
    });

    await waitFor(() => stdout.some((line) =>
      (JSON.parse(line) as { kind?: string }).kind === "gap"));
    expect(requested).toEqual([undefined, cursorWire("old-1")]);
    releaseGap();
    const result = await following;

    expect(requested).toEqual([
      undefined,
      cursorWire("old-1"),
      cursorWire("restored-0"),
    ]);
    expect(result).toEqual({
      events: 2,
      lastCursor: cursorWire("restored-1"),
      pages: 3,
    });
    const parsed = stdout.map((line) => JSON.parse(line) as {
      event?: { streamEpoch?: string };
      kind: string;
    });
    expect(parsed.filter((entry) => entry.kind === "gap")).toHaveLength(1);
    expect(parsed.filter((entry) => entry.kind === "event").map((entry) =>
      entry.event?.streamEpoch)).toEqual([streamEpoch, restoredEpoch]);
  });

  test("fails closed on cross-page sequence, account, and restored-epoch discontinuities", async () => {
    const otherAccountId = "acct_11111111111111111111111111111111" as const;
    const base = {
      command: { kind: "session.events", session: "release", limit: 20, waitMs: 30_000 } as const,
      output: { writeStdout: () => {} },
      signal: new AbortController().signal,
    };
    const follow = async (pages: SessionEventPage[]) => await followSessionEvents({
      ...base,
      fetchPage: () => {
        const next = pages.shift();
        if (next === undefined) throw new Error("No continuity page fixture.");
        return Promise.resolve(next);
      },
      maxPages: pages.length,
    });

    await expect(follow([
      page({ requestedCursor: null, nextCursor: "c1", events: [event(1)] }),
      page({ requestedCursor: "c1", nextCursor: "c3", events: [event(3)] }),
    ])).rejects.toThrow("SESSION_EVENT_CONTINUITY_SEQUENCE_MISMATCH");

    // A provider switch may move a session to another account, so a page under
    // a new account continues the follow rather than failing it.
    await expect(follow([
      page({ requestedCursor: null, nextCursor: "c1", events: [event(1)] }),
      page({
        requestedCursor: "c1",
        nextCursor: "c2",
        events: [event(2, "switched account", streamEpoch, otherAccountId)],
      }),
    ])).resolves.toBeDefined();

    await expect(follow([
      page({ requestedCursor: null, nextCursor: "old-1", events: [event(1)] }),
      page({
        requestedCursor: "old-1",
        nextCursor: "restored-0",
        gap: { reason: "stream_restored", requestedSequence: 1, retainedFromSequence: 1 },
      }),
      page({
        requestedCursor: "restored-0",
        nextCursor: "restored-1",
        events: [event(1, "same old epoch")],
      }),
    ])).rejects.toThrow("SESSION_EVENT_CONTINUITY_RESTORED_EPOCH_DID_NOT_CHANGE");
  });

  test("rejects an empty no-gap page that advances its checkpoint", async () => {
    await expect(followSessionEvents({
      command: {
        kind: "session.events",
        session: "release",
        cursor: cursorWire("c1"),
        limit: 20,
        waitMs: 30_000,
      },
      fetchPage: () => Promise.resolve(page({ requestedCursor: "c1", nextCursor: "c2" })),
      maxPages: 1,
      output: { writeStdout: () => {} },
      signal: new AbortController().signal,
    })).rejects.toThrow("cannot advance its checkpoint");
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
      fetchPage: () => Promise.resolve(page({
        requestedCursor: "foreign",
        nextCursor: "c1",
        events: [event(1)],
      })),
    })).rejects.toThrow("CURSOR_MISMATCH");
    await expect(followSessionEvents({
      ...base,
      command: { ...base.command, cursor: cursorWire("c1") },
      fetchPage: () => Promise.resolve(page({ requestedCursor: "c1", nextCursor: "c1", events: [event(1)] })),
    })).rejects.toThrow("must advance its checkpoint");
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
    })).rejects.toThrow("bind the page session");
    await expect(followSessionEvents({
      ...base,
      expectedSessionId: sessionId,
      fetchPage: () => {
        const foreignSessionId = "sess_11111111111111111111111111111111" as const;
        return Promise.resolve({
          ...page({ requestedCursor: null, nextCursor: "c1", events: [{
            ...event(1),
            sessionId: foreignSessionId,
          }] }),
          sessionId: foreignSessionId,
        });
      },
    })).rejects.toThrow("REQUEST_SESSION_MISMATCH");
    await expect(followSessionEvents({
      ...base,
      fetchPage: () => Promise.resolve(page({
        requestedCursor: null,
        nextCursor: "c1",
        events: [event(2), event(2)],
      })),
    })).rejects.toThrow("exactly contiguous");
  });

  test("keeps one session and one stream epoch per emitted page", async () => {
    const pages = [
      page({ requestedCursor: null, nextCursor: "c1", events: [event(1)] }),
      {
        ...page({
          requestedCursor: "c1",
          nextCursor: "c2",
          events: [{
            ...event(2),
            sessionId: "sess_11111111111111111111111111111111" as const,
          }],
        }),
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
    })).rejects.toThrow("cannot mix stream epochs");

    const changedEpoch = "80000000-0000-4000-8000-000000000003";
    const sameStreamGapPages = [
      page({ requestedCursor: null, nextCursor: "c1", events: [event(1)] }),
      page({
        requestedCursor: "c1",
        nextCursor: "c2",
        gap: { reason: "retention_age", requestedSequence: 1, retainedFromSequence: 2 },
        events: [event(2, "wrong epoch", changedEpoch)],
      }),
    ];
    await expect(followSessionEvents({
      command: { kind: "session.events", session: "release", limit: 20, waitMs: 30_000 },
      fetchPage: () => {
        const next = sameStreamGapPages.shift();
        if (next === undefined) throw new Error("No same-stream gap fixture.");
        return Promise.resolve(next);
      },
      maxPages: 2,
      output: { writeStdout: () => {} },
      signal: new AbortController().signal,
    })).rejects.toThrow("STREAM_CHANGED_WITHOUT_RESTORE");
  });

  test("yields after empty unchanged pages and stops cleanly on abort", async () => {
    const controller = new AbortController();
    let yields = 0;
    const result = await followSessionEvents({
      command: { kind: "session.events", session: "release", cursor: cursorWire("c1"), limit: 20, waitMs: 30_000 },
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
    expect(result).toEqual({ events: 0, lastCursor: cursorWire("c1"), pages: 1 });
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
    expect(requested).toEqual([undefined, cursorWire("c1")]);
    expect(result).toEqual({ events: 2, lastCursor: cursorWire("c2"), pages: 2 });
    expect(stdout.map((line) => (JSON.parse(line) as { kind: string }).kind)).toEqual([
      "event",
      "checkpoint",
      "event",
      "checkpoint",
    ]);
  });

  test("lets a human presenter drain before advancing the shared cursor pump", async () => {
    const requested: Array<string | undefined> = [];
    const presented: string[] = [];
    let releaseFirstPage!: () => void;
    const firstPageDrained = new Promise<void>((resolve) => { releaseFirstPage = resolve; });
    const following = followSessionEvents({
      command: { kind: "session.events", session: "release", limit: 20, waitMs: 30_000 },
      fetchPage: (command) => {
        requested.push(command.cursor);
        return Promise.resolve(command.cursor === undefined
          ? page({ requestedCursor: null, nextCursor: "c1", events: [event(1)] })
          : page({ requestedCursor: "c1", nextCursor: "c2", events: [event(2)] }));
      },
      maxPages: 2,
      output: { writeStdout: () => { throw new Error("Custom page writer owns output."); } },
      signal: new AbortController().signal,
      writePage: async (eventPage) => {
        presented.push(eventPage.nextCursor);
        if (presented.length === 1) await firstPageDrained;
      },
    });
    await waitFor(() => presented.length === 1);
    expect(requested).toEqual([undefined]);
    releaseFirstPage();
    expect(await following).toEqual({
      events: 2,
      lastCursor: cursorWire("c2"),
      pages: 2,
    });
    expect(requested).toEqual([undefined, cursorWire("c1")]);
    expect(presented).toEqual([cursorWire("c1"), cursorWire("c2")]);
  });
});
