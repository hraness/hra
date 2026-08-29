import { describe, expect, test } from "bun:test";

import {
  WORK_EVENT_PAGE_MAX_BYTES,
  WORK_EVENT_STREAM_LINE_MAX_BYTES,
  type WorkEvent,
  type WorkEventPage,
} from "../domain/work";
import { followWorkEvents, writeWorkEventPageJsonl } from "./work-watch";

const workId = `work_${"0".repeat(32)}` as const;
const otherWorkId = `work_${"1".repeat(32)}` as const;
const actorSessionId = `sess_${"2".repeat(32)}` as const;
const streamEpoch = "80000000-0000-4000-8000-000000000001";
const otherStreamEpoch = "80000000-0000-4000-8000-000000000002";
const cursorSignature = "A".repeat(43);

const cursorWire = (labelOrWire: string): string => labelOrWire.startsWith("hra1.")
  ? labelOrWire
  : `hra1.${Buffer.from(`work-fixture:${labelOrWire}`).toString("base64url")}.${cursorSignature}`;

const event = (
  sequence: number,
  _summary = "visible",
  eventWorkId: WorkEvent["workId"] = workId,
  epoch = streamEpoch,
): WorkEvent => {
  void _summary;
  return {
    version: 1,
    workId: eventWorkId,
    streamEpoch: epoch,
    sequence,
    occurredAt: sequence,
    actorSessionId,
    body: {
      type: "work.failed",
      requestDigest: "a".repeat(64),
      evidenceCount: 0,
    },
  };
};

const page = (input: Readonly<{
  requestedCursor: string | null;
  nextCursor: string;
  events?: readonly WorkEvent[];
  gap?: WorkEventPage["gap"];
  pageWorkId?: WorkEventPage["workId"];
  epoch?: string;
}>): WorkEventPage => ({
  version: 1,
  workId: input.pageWorkId ?? workId,
  streamEpoch: input.epoch ?? streamEpoch,
  requestedCursor: input.requestedCursor === null
    ? null
    : cursorWire(input.requestedCursor),
  retentionFloorCursor: cursorWire("floor"),
  observedThroughCursor: cursorWire(`observed-${input.nextCursor}`),
  nextCursor: cursorWire(input.nextCursor),
  gap: input.gap ?? null,
  events: input.events === undefined ? [] : [...input.events],
});

const command = (cursor?: string) => ({
  kind: "work.events" as const,
  work: workId,
  ...(cursor === undefined ? {} : { cursor: cursorWire(cursor) }),
  limit: 20,
  waitMs: 30_000,
});

const waitFor = async (predicate: () => boolean): Promise<void> => {
  const deadline = Date.now() + 1_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for work event output.");
    await Bun.sleep(1);
  }
};

describe("work event watch", () => {
  test("validates the complete page before emitting any line", async () => {
    const stdout: string[] = [];
    const malformedPage = {
      ...page({
        requestedCursor: null,
        nextCursor: "c2",
        events: [event(1), event(2)],
      }),
      events: [event(1), { ...event(2), unexpected: true }],
    };

    await expect(followWorkEvents({
      command: command(),
      fetchPage: () => Promise.resolve(malformedPage),
      maxPages: 1,
      output: { writeStdout: (value) => { stdout.push(value); } },
      signal: new AbortController().signal,
    })).rejects.toThrow();
    expect(stdout).toEqual([]);

    await expect(followWorkEvents({
      command: command(),
      fetchPage: () => Promise.resolve({
        ...page({
          requestedCursor: null,
          nextCursor: "valid-next",
          events: [event(1)],
        }),
        nextCursor: `hra1.Zh.${cursorSignature}`,
      }),
      maxPages: 1,
      output: { writeStdout: (value) => { stdout.push(value); } },
      signal: new AbortController().signal,
    })).rejects.toThrow("canonical HRA cursor envelope");
    expect(stdout).toEqual([]);
  });

  test("keeps a maximum compact event page below the byte ceiling", async () => {
    const stdout: string[] = [];
    const taskIds = Array.from(
      { length: 32 },
      (_, index) => `task_${index.toString(16).padStart(32, "0")}` as const,
    );
    const events = Array.from({ length: 200 }, (_, index): WorkEvent => ({
      ...event(index + 1),
      body: { type: "task.batch_added", taskIds },
    }));
    const serializedBytes = new TextEncoder().encode(JSON.stringify(events)).byteLength;
    expect(serializedBytes).toBeLessThanOrEqual(WORK_EVENT_PAGE_MAX_BYTES);

    await followWorkEvents({
      command: command(),
      fetchPage: () => Promise.resolve(page({
        requestedCursor: null,
        nextCursor: "maximum",
        events,
      })),
      maxPages: 1,
      output: { writeStdout: (value) => { stdout.push(value); } },
      signal: new AbortController().signal,
    });
    expect(stdout).toHaveLength(201);
    expect(stdout.every((line) =>
      Buffer.byteLength(line, "utf8") <= WORK_EVENT_STREAM_LINE_MAX_BYTES)).toBe(true);
  });

  test("bounds every gap, event, and checkpoint line before the first write", async () => {
    const stdout: string[] = [];
    const maximumCursor = `hra1.${"A".repeat(1_999)}.${cursorSignature}`;
    const maximumNextCursor = `hra1.${"E".repeat(1_999)}.${cursorSignature}`;
    const maximumFloorCursor = `hra1.${"I".repeat(1_999)}.${cursorSignature}`;
    const maximumObservedCursor = `hra1.${"M".repeat(1_999)}.${cursorSignature}`;
    const maximum = {
      ...page({
        requestedCursor: maximumCursor,
        nextCursor: maximumNextCursor,
        gap: {
          reason: "retention_count" as const,
          requestedSequence: 1,
          retainedFromSequence: 1,
        },
        events: [event(1)],
      }),
      retentionFloorCursor: maximumFloorCursor,
      observedThroughCursor: maximumObservedCursor,
      nextCursor: maximumNextCursor,
    };
    await writeWorkEventPageJsonl(maximum, {
      writeStdout: (value) => { stdout.push(value); },
    });
    expect(stdout).toHaveLength(3);
    expect(stdout.every((line) =>
      Buffer.byteLength(line, "utf8") <= WORK_EVENT_STREAM_LINE_MAX_BYTES)).toBe(true);
  });

  test("writes safe compact events and one checkpoint", async () => {
    const stdout: string[] = [];
    const eventPage = page({
      requestedCursor: "c0",
      nextCursor: "c1",
      events: [event(1, "visible\u001b]0;hidden\u0007")],
    });

    await writeWorkEventPageJsonl(eventPage, {
      writeStdout: (value) => { stdout.push(value); },
    });

    expect(stdout).toHaveLength(2);
    expect(stdout.every((line) => line.endsWith("\n") && !line.slice(0, -1).includes("\n")))
      .toBe(true);
    expect(JSON.parse(stdout[0] ?? "")).toMatchObject({
      version: 1,
      kind: "event",
      workId,
      event: { sequence: 1, streamEpoch },
    });
    expect(JSON.parse(stdout[1] ?? "")).toEqual({
      version: 1,
      kind: "checkpoint",
      workId,
      streamEpoch,
      nextCursor: cursorWire("c1"),
      retentionFloorCursor: cursorWire("floor"),
      observedThroughCursor: cursorWire("observed-c1"),
      eventCount: 1,
    });
    expect(stdout.join("")).not.toContain("\u001b");
    expect(stdout.join("")).not.toContain("\u0007");
  });

  test("emits a typed gap before retained events and the checkpoint", async () => {
    const stdout: string[] = [];
    await writeWorkEventPageJsonl(page({
      requestedCursor: "old",
      nextCursor: "new",
      gap: {
        reason: "retention_count",
        requestedSequence: 1,
        retainedFromSequence: 9,
      },
      events: [event(9)],
    }), { writeStdout: (value) => { stdout.push(value); } });

    expect(stdout.map((line) => (JSON.parse(line) as { kind: string }).kind)).toEqual([
      "gap",
      "event",
      "checkpoint",
    ]);
  });

  test("advances only the opaque cursor returned by each validated page", async () => {
    const requested: Array<Readonly<{ cursor: string | undefined; work: string }>> = [];
    const pages = [
      page({ requestedCursor: null, nextCursor: "c1", events: [event(1)] }),
      page({ requestedCursor: "c1", nextCursor: "c2", events: [event(2)] }),
    ];
    const result = await followWorkEvents({
      command: command(),
      fetchPage: (nextCommand) => {
        requested.push({ cursor: nextCommand.cursor, work: nextCommand.work });
        const next = pages.shift();
        if (next === undefined) throw new Error("No page fixture.");
        return Promise.resolve(next);
      },
      maxPages: 2,
      output: { writeStdout: () => {} },
      signal: new AbortController().signal,
    });

    expect(requested).toEqual([
      { cursor: undefined, work: workId },
      { cursor: cursorWire("c1"), work: workId },
    ]);
    expect(result).toEqual({ events: 2, lastCursor: cursorWire("c2"), pages: 2 });
  });

  test("fails closed if the requested cursor, work, epoch, or sequence changes", async () => {
    const base = {
      command: command(),
      maxPages: 1,
      output: { writeStdout: () => {} },
      signal: new AbortController().signal,
    };

    await expect(followWorkEvents({
      ...base,
      fetchPage: () => Promise.resolve(page({
        requestedCursor: "foreign",
        nextCursor: "c1",
        events: [event(1)],
      })),
    })).rejects.toThrow("WORK_EVENT_FOLLOW_CURSOR_MISMATCH");

    await expect(followWorkEvents({
      ...base,
      fetchPage: () => Promise.resolve(page({
        requestedCursor: null,
        nextCursor: "c1",
        pageWorkId: otherWorkId,
        events: [event(1, "foreign", otherWorkId)],
      })),
    })).rejects.toThrow("WORK_EVENT_FOLLOW_REQUEST_WORK_MISMATCH");

    const changedEpochPages = [
      page({ requestedCursor: null, nextCursor: "c1", events: [event(1)] }),
      page({
        requestedCursor: "c1",
        nextCursor: "c2",
        epoch: otherStreamEpoch,
        events: [event(2, "foreign epoch", workId, otherStreamEpoch)],
      }),
    ];
    await expect(followWorkEvents({
      ...base,
      fetchPage: () => {
        const next = changedEpochPages.shift();
        if (next === undefined) throw new Error("No epoch fixture.");
        return Promise.resolve(next);
      },
      maxPages: 2,
    })).rejects.toThrow("WORK_EVENT_FOLLOW_STREAM_EPOCH_CHANGED");

    const skippedSequencePages = [
      page({ requestedCursor: null, nextCursor: "c1", events: [event(1)] }),
      page({ requestedCursor: "c1", nextCursor: "c3", events: [event(3)] }),
    ];
    await expect(followWorkEvents({
      ...base,
      fetchPage: () => {
        const next = skippedSequencePages.shift();
        if (next === undefined) throw new Error("No sequence fixture.");
        return Promise.resolve(next);
      },
      maxPages: 2,
    })).rejects.toThrow("WORK_EVENT_FOLLOW_SEQUENCE_MISMATCH");
  });

  test("emits no part of a page whose resolved identity changes", async () => {
    const stdout: string[] = [];
    const pages = [
      page({ requestedCursor: null, nextCursor: "c1", events: [event(1)] }),
      page({
        requestedCursor: "c1",
        nextCursor: "c2",
        pageWorkId: otherWorkId,
        events: [event(2, "foreign", otherWorkId)],
      }),
    ];
    await expect(followWorkEvents({
      command: command(),
      fetchPage: () => {
        const next = pages.shift();
        if (next === undefined) throw new Error("No identity fixture.");
        return Promise.resolve(next);
      },
      maxPages: 2,
      output: { writeStdout: (value) => { stdout.push(value); } },
      signal: new AbortController().signal,
    })).rejects.toThrow("WORK_EVENT_FOLLOW_WORK_CHANGED");

    expect(stdout.map((line) => (JSON.parse(line) as { kind: string }).kind)).toEqual([
      "event",
      "checkpoint",
    ]);
  });

  test("rejects non-advancing event pages, advancing empty pages, and zero-wait follow", async () => {
    const base = {
      command: command("c1"),
      maxPages: 1,
      output: { writeStdout: () => {} },
      signal: new AbortController().signal,
    };

    await expect(followWorkEvents({
      ...base,
      fetchPage: () => Promise.resolve(page({
        requestedCursor: "c1",
        nextCursor: "c1",
        events: [event(1)],
      })),
    })).rejects.toThrow("must advance its checkpoint");

    await expect(followWorkEvents({
      ...base,
      fetchPage: () => Promise.resolve(page({
        requestedCursor: "c1",
        nextCursor: "c2",
      })),
    })).rejects.toThrow("cannot advance its checkpoint");

    let fetched = false;
    await expect(followWorkEvents({
      ...base,
      command: { ...base.command, waitMs: 0 },
      fetchPage: () => {
        fetched = true;
        return Promise.resolve(page({ requestedCursor: "c1", nextCursor: "c1" }));
      },
    })).rejects.toThrow("WORK_EVENT_FOLLOW_REQUIRES_WAIT");
    expect(fetched).toBe(false);
  });

  test("retries classified fetch failures from the last drained checkpoint", async () => {
    const requested: Array<string | undefined> = [];
    const retryAttempts: number[] = [];
    const pages = [
      page({ requestedCursor: null, nextCursor: "c1", events: [event(1)] }),
      page({ requestedCursor: "c1", nextCursor: "c2", events: [event(2)] }),
    ];
    let initialTransient = true;
    let resumedTransient = true;

    const result = await followWorkEvents({
      command: command(),
      fetchPage: (nextCommand) => {
        requested.push(nextCommand.cursor);
        if (nextCommand.cursor === undefined && initialTransient) {
          initialTransient = false;
          return Promise.reject(new Error("transient transport loss"));
        }
        if (nextCommand.cursor === cursorWire("c1") && resumedTransient) {
          resumedTransient = false;
          return Promise.reject(new Error("transient transport loss"));
        }
        const next = pages.shift();
        if (next === undefined) throw new Error("No retry fixture.");
        return Promise.resolve(next);
      },
      maxConsecutiveRetries: 2,
      maxPages: 2,
      output: { writeStdout: () => {} },
      retryFetchError: (error, attempt) => {
        retryAttempts.push(attempt);
        return Promise.resolve(
          error instanceof Error && error.message === "transient transport loss",
        );
      },
      signal: new AbortController().signal,
    });

    expect(requested).toEqual([
      undefined,
      undefined,
      cursorWire("c1"),
      cursorWire("c1"),
    ]);
    expect(retryAttempts).toEqual([1, 1]);
    expect(result).toEqual({ events: 2, lastCursor: cursorWire("c2"), pages: 2 });
  });

  test("bounds retry decisions and stops cleanly when a retry hook aborts", async () => {
    let fetches = 0;
    const attempts: number[] = [];
    await expect(followWorkEvents({
      command: command(),
      fetchPage: () => {
        fetches += 1;
        return Promise.reject(new Error("offline"));
      },
      maxConsecutiveRetries: 2,
      maxPages: 1,
      output: { writeStdout: () => {} },
      retryFetchError: (_error, attempt) => {
        attempts.push(attempt);
        return Promise.resolve(true);
      },
      signal: new AbortController().signal,
    })).rejects.toThrow("offline");
    expect(fetches).toBe(3);
    expect(attempts).toEqual([1, 2]);

    const controller = new AbortController();
    const aborted = await followWorkEvents({
      command: command(),
      fetchPage: () => Promise.reject(new Error("disconnect")),
      maxConsecutiveRetries: 1,
      maxPages: 1,
      output: { writeStdout: () => {} },
      retryFetchError: () => {
        controller.abort();
        return Promise.resolve(true);
      },
      signal: controller.signal,
    });
    expect(aborted).toEqual({ events: 0, lastCursor: null, pages: 0 });
  });

  test("does not fetch or advance until the async checkpoint write drains", async () => {
    const requested: Array<string | undefined> = [];
    const stdout: string[] = [];
    let releaseCheckpoint!: () => void;
    const checkpointDrained = new Promise<void>((resolve) => {
      releaseCheckpoint = resolve;
    });
    const following = followWorkEvents({
      command: command(),
      fetchPage: (nextCommand) => {
        requested.push(nextCommand.cursor);
        return Promise.resolve(nextCommand.cursor === undefined
          ? page({ requestedCursor: null, nextCursor: "c1", events: [event(1)] })
          : page({ requestedCursor: "c1", nextCursor: "c2", events: [event(2)] }));
      },
      maxPages: 2,
      output: {
        writeStdout: () => { throw new Error("The async writer must own JSONL output."); },
        writeStdoutAsync: async (value) => {
          stdout.push(value);
          const frame = JSON.parse(value) as { kind: string; nextCursor?: string };
          if (frame.kind === "checkpoint" && frame.nextCursor === cursorWire("c1")) {
            await checkpointDrained;
          }
        },
      },
      signal: new AbortController().signal,
    });

    await waitFor(() => stdout.length === 2);
    expect(requested).toEqual([undefined]);
    expect(stdout.map((line) => (JSON.parse(line) as { kind: string }).kind)).toEqual([
      "event",
      "checkpoint",
    ]);

    releaseCheckpoint();
    expect(await following).toEqual({
      events: 2,
      lastCursor: cursorWire("c2"),
      pages: 2,
    });
    expect(requested).toEqual([undefined, cursorWire("c1")]);
  });

  test("leaves the prior cursor durable after a partial write for at-least-once replay", async () => {
    const requested: Array<string | undefined> = [];
    const stdout: string[] = [];
    let rejectCheckpoint = true;
    const run = async () => await followWorkEvents({
      command: command(),
      fetchPage: (nextCommand) => {
        requested.push(nextCommand.cursor);
        return Promise.resolve(page({
          requestedCursor: null,
          nextCursor: "c1",
          events: [event(1)],
        }));
      },
      maxPages: 1,
      output: {
        writeStdout: () => { throw new Error("The async writer must own JSONL output."); },
        writeStdoutAsync: (value) => {
          const frame = JSON.parse(value) as { kind: string };
          if (frame.kind === "checkpoint" && rejectCheckpoint) {
            rejectCheckpoint = false;
            return Promise.reject(new Error("stdout closed before checkpoint"));
          }
          stdout.push(value);
          return Promise.resolve();
        },
      },
      signal: new AbortController().signal,
    });

    await expect(run()).rejects.toThrow("stdout closed before checkpoint");
    expect(stdout.map((line) => (JSON.parse(line) as { kind: string }).kind)).toEqual([
      "event",
    ]);

    expect(await run()).toEqual({ events: 1, lastCursor: cursorWire("c1"), pages: 1 });
    expect(requested).toEqual([undefined, undefined]);
    expect(stdout.map((line) => (JSON.parse(line) as { kind: string }).kind)).toEqual([
      "event",
      "event",
      "checkpoint",
    ]);
  });

  test("yields after an empty unchanged page and honors abort", async () => {
    const controller = new AbortController();
    const stdout: string[] = [];
    let yields = 0;
    const result = await followWorkEvents({
      command: command("c1"),
      fetchPage: () => Promise.resolve(page({
        requestedCursor: "c1",
        nextCursor: "c1",
      })),
      output: { writeStdout: (value) => { stdout.push(value); } },
      signal: controller.signal,
      yieldAfterEmptyPage: () => {
        yields += 1;
        controller.abort();
        return Promise.resolve();
      },
    });

    expect(yields).toBe(1);
    expect(stdout).toEqual([]);
    expect(result).toEqual({ events: 0, lastCursor: cursorWire("c1"), pages: 1 });
  });

  test("rejects invalid page and retry bounds before fetching", async () => {
    let fetches = 0;
    const base = {
      command: command(),
      fetchPage: () => {
        fetches += 1;
        return Promise.resolve(page({ requestedCursor: null, nextCursor: "c1" }));
      },
      output: { writeStdout: () => {} },
      signal: new AbortController().signal,
    };

    await expect(followWorkEvents({ ...base, maxPages: 0 }))
      .rejects.toThrow("WORK_EVENT_FOLLOW_PAGE_BOUND_INVALID");
    await expect(followWorkEvents({ ...base, maxConsecutiveRetries: 32 }))
      .rejects.toThrow("WORK_EVENT_FOLLOW_RETRY_BOUND_INVALID");
    expect(fetches).toBe(0);
  });
});
