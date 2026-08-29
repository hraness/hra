import { describe, expect, test } from "bun:test";

import {
  WORK_TASK_HISTORY_DEFAULT_ITEM_LIMIT,
  WORK_TASK_HISTORY_ITEM_LIMIT,
} from "../domain/work";
import {
  CliUsageError,
  parseCli,
  requestsJsonOutput,
  requestsJsonlOutput,
  requestsWorkApplyProtocol,
} from "./parser";

const workId = `work_${"1".repeat(32)}`;
const taskId = `task_${"2".repeat(32)}`;
const actorSessionId = `sess_${"3".repeat(32)}`;
const idempotencyKey = "018f1f64-6c17-7d35-8f8e-b24a1d3a5211";
const cursor = `hra1.${Buffer.from("work-parser-cursor").toString("base64url")}.${"A".repeat(43)}`;

describe("agent-first work CLI parser contract", () => {
  test("parses all seven public work commands as JSON-only agent invocations", () => {
    expect(parseCli(["work", "protocol"])).toEqual({
      kind: "command",
      command: { kind: "work.protocol", query: { kind: "index" } },
      json: true,
    });
    expect(parseCli(["work", "apply", "--input-stdin"])).toEqual({
      input: { kind: "stdin" },
      json: true,
      kind: "work.apply-input",
    });
    expect(parseCli([
      "work",
      "snapshot",
      workId,
      "--actor",
      actorSessionId,
    ])).toEqual({
      kind: "command",
      command: { kind: "work.snapshot", work: workId, actor: actorSessionId },
      json: true,
    });
    expect(parseCli(["work", "task", taskId])).toEqual({
      kind: "command",
      command: { kind: "work.task", task: taskId },
      json: true,
    });
    expect(parseCli([
      "work",
      "task",
      taskId,
      "--history-limit",
      "7",
    ])).toEqual({
      kind: "command",
      command: { kind: "work.task", task: taskId, historyLimit: 7 },
      json: true,
    });
    expect(parseCli([
      "work",
      "task",
      taskId,
      "--history-cursor",
      cursor,
    ])).toEqual({
      kind: "command",
      command: {
        kind: "work.task",
        task: taskId,
        historyLimit: WORK_TASK_HISTORY_DEFAULT_ITEM_LIMIT,
        historyCursor: cursor,
      },
      json: true,
    });
    expect(() => parseCli([
      "work",
      "task",
      taskId,
      "--history-limit",
      String(WORK_TASK_HISTORY_ITEM_LIMIT + 1),
    ])).toThrow(CliUsageError);
    expect(parseCli(["work", "poll", workId])).toEqual({
      kind: "command",
      command: {
        kind: "work.poll",
        work: workId,
        limit: 20,
        waitMs: 0,
      },
      json: true,
    });
    expect(parseCli([
      "work",
      "poll",
      workId,
      "--actor",
      actorSessionId,
      "--action-cursor",
      cursor,
    ])).toEqual({
      kind: "command",
      command: {
        kind: "work.poll",
        work: workId,
        actor: actorSessionId,
        actionCursor: cursor,
        limit: 20,
        waitMs: 0,
      },
      json: true,
    });
    expect(() => parseCli([
      "work",
      "poll",
      workId,
      "--action-cursor",
      cursor,
      "--wait-ms",
      "1",
    ])).toThrow("requires --wait-ms 0");
    expect(parseCli(["work", "events", workId])).toEqual({
      kind: "command",
      command: {
        kind: "work.events",
        work: workId,
        limit: 200,
        waitMs: 0,
      },
      json: true,
    });
    expect(parseCli(["work", "watch", workId, "--cursor", cursor])).toEqual({
      command: {
        kind: "work.events",
        work: workId,
        cursor,
        limit: 200,
        waitMs: 30_000,
      },
      jsonl: true,
      kind: "work.events.follow",
    });

    for (const action of ["protocol", "snapshot", "task", "poll", "events"] as const) {
      const target = action === "task" ? taskId : workId;
      const argv = action === "protocol"
        ? ["work", action, "--json"]
        : ["work", action, target, "--json"];
      const invocation = parseCli(argv);
      expect(invocation.kind).toBe("command");
      if (invocation.kind === "command") expect(invocation.json).toBe(true);
    }
    expect(requestsJsonOutput(["work", "protocol"])).toBe(true);
    expect(requestsJsonOutput(["work", "watch", workId])).toBe(true);
    expect(requestsJsonOutput([
      "--idempotency-key",
      idempotencyKey,
      "work",
      "protocol",
    ])).toBe(true);
    expect(requestsJsonOutput(["--idempotency-key", "work", "status"])).toBe(false);
    expect(requestsJsonOutput(["account", "show", "work"])).toBe(false);
  });

  test("selects one bounded protocol shard and rejects ambiguous discovery queries", () => {
    expect(parseCli(["work", "protocol", "--operation", "work.release"])).toEqual({
      kind: "command",
      command: {
        kind: "work.protocol",
        query: { kind: "operation", operation: "work.release" },
      },
      json: true,
    });
    expect(parseCli(["work", "protocol", "--type", "ReconcileOutcome"])).toEqual({
      kind: "command",
      command: {
        kind: "work.protocol",
        query: { kind: "type", name: "ReconcileOutcome" },
      },
      json: true,
    });
    expect(parseCli(["work", "protocol", "--topic", "envelopes"])).toEqual({
      kind: "command",
      command: {
        kind: "work.protocol",
        query: { kind: "topic", topic: "envelopes" },
      },
      json: true,
    });

    for (const argv of [
      ["work", "protocol", "--operation", "work.unknown"],
      ["work", "protocol", "--type", "UnknownType"],
      ["work", "protocol", "--topic", "unknown"],
      ["work", "protocol", "--operation", "work.release", "--type", "WorkRecord"],
      ["work", "protocol", "--type", "WorkRecord", "--type", "WorkRecord"],
    ]) {
      expect(() => parseCli(argv)).toThrow(CliUsageError);
    }
  });

  test("keeps watch and event following as compact JSON Lines", () => {
    const expected = {
      command: {
        kind: "work.events",
        work: workId,
        limit: 200,
        waitMs: 30_000,
      },
      jsonl: true,
      kind: "work.events.follow",
    } as const;
    expect(parseCli(["work", "events", workId, "--jsonl"])).toEqual(expected);
    expect(parseCli(["work", "events", workId, "--follow"])).toEqual(expected);
    expect(parseCli(["work", "events", workId, "--follow", "--jsonl"]))
      .toEqual(expected);
    expect(parseCli(["work", "watch", workId])).toEqual(expected);
    expect(requestsJsonlOutput(["work", "events", workId, "--jsonl"])).toBe(true);
    expect(requestsJsonlOutput(["work", "events", workId, "--follow"])).toBe(true);
    expect(requestsJsonlOutput(["work", "watch", workId])).toBe(true);
    expect(requestsJsonlOutput([
      "--idempotency-key",
      idempotencyKey,
      "work",
      "watch",
      workId,
    ])).toBe(true);
    expect(requestsJsonlOutput(["--idempotency-key", "work", "watch", workId]))
      .toBe(false);
    expect(() => parseCli(["work", "events", workId, "--jsonl", "--wait-ms", "0"]))
      .toThrow("requires --wait-ms from 1 to 30000");
    expect(() => parseCli(["work", "watch", workId, "--json"]))
      .toThrow("already JSON Lines");
    expect(() => parseCli(["work", "events", workId, "--json", "--jsonl"]))
      .toThrow("mutually exclusive");
    for (const argv of [
      ["work", "protocol", "--jsonl"],
      ["work", "apply", "--input-stdin", "--jsonl"],
      ["work", "snapshot", workId, "--jsonl"],
      ["work", "task", taskId, "--jsonl"],
      ["work", "poll", workId, "--jsonl"],
    ]) {
      expect(() => parseCli(argv)).toThrow("one JSON document, not JSON Lines");
    }
  });

  test("rejects human formatting and global mutation-key authorities", () => {
    for (const argv of [
      ["work", "protocol", "--human"],
      ["work", "snapshot", workId, "--pretty"],
      ["work", "task", taskId, "--no-json"],
      ["work", "poll", workId, "--format", "human"],
      ["work", "events", workId, "--output", "table"],
      ["work", "watch", workId, "--human"],
    ]) {
      expect(() => parseCli(argv)).toThrow(CliUsageError);
    }

    const commands = [
      ["work", "protocol"],
      ["work", "apply", "--input-stdin"],
      ["work", "snapshot", workId],
      ["work", "task", taskId],
      ["work", "poll", workId],
      ["work", "events", workId],
      ["work", "watch", workId],
    ] as const;
    for (const argv of commands) {
      expect(() => parseCli([
        ...argv,
        "--idempotency-key",
        idempotencyKey,
      ])).toThrow("carry one idempotencyKey inside the strict input document");
    }
  });

  test("requires exactly one bounded non-output input descriptor for apply", () => {
    expect(requestsWorkApplyProtocol(["work", "apply", "--input-stdin"])).toBe(true);
    expect(requestsWorkApplyProtocol(["--json", "work", "apply", "--input-stdin"])).toBe(true);
    expect(requestsWorkApplyProtocol(["session", "unknown", "work", "apply"])).toBe(false);
    expect(parseCli(["work", "apply", "--input-fd", "0"])).toEqual({
      input: { fd: 0, kind: "fd" },
      json: true,
      kind: "work.apply-input",
    });
    expect(parseCli(["work", "apply", "--input-fd", "1048575"])).toMatchObject({
      input: { fd: 1_048_575, kind: "fd" },
    });
    for (const argv of [
      ["work", "apply"],
      ["work", "apply", "--input-stdin", "--input-fd", "0"],
      ["work", "apply", "--input-fd", "-1"],
      ["work", "apply", "--input-fd", "1"],
      ["work", "apply", "--input-fd", "2"],
      ["work", "apply", "--input-fd", "1048576"],
      ["work", "apply", "--input-fd", "1.5"],
      ["work", "apply", "--input-stdin", "operation.json"],
      ["work", "apply", "--input-stdin", "--input-stdin"],
    ]) {
      expect(() => parseCli(argv)).toThrow(CliUsageError);
    }
  });

  test("rejects unknown flags, missing values, duplicate options, and extra positionals", () => {
    for (const argv of [
      ["work", "protocol", "extra"],
      ["work", "apply", "--input-stdin", "extra"],
      ["work", "snapshot", workId, "extra"],
      ["work", "task", taskId, "extra"],
      ["work", "poll", workId, "extra"],
      ["work", "events", workId, "extra"],
      ["work", "watch", workId, "extra"],
      ["work", "protocol", "--surprise"],
      ["work", "snapshot", workId, "--actor"],
      ["work", "poll", workId, "--limit"],
      ["work", "events", workId, "--cursor"],
      ["work", "poll", workId, "--limit", "1", "--limit", "2"],
      ["work", "events", workId, "--follow", "--follow"],
      ["work", "watch", workId, "--limit", "1"],
      ["work", "watch", workId, "--wait-ms", "1"],
      ["work", "watch", workId, "--follow"],
      ["work", "unknown", workId],
    ]) {
      expect(() => parseCli(argv)).toThrow(CliUsageError);
    }
  });

  test("enforces poll, event, wait, actor, ID, and cursor bounds", () => {
    expect(parseCli([
      "work",
      "poll",
      workId,
      "--actor",
      actorSessionId,
      "--cursor",
      cursor,
      "--limit",
      "50",
      "--wait-ms",
      "30000",
    ])).toMatchObject({
      command: {
        actor: actorSessionId,
        cursor,
        limit: 50,
        waitMs: 30_000,
      },
    });
    expect(parseCli([
      "work",
      "events",
      workId,
      "--cursor",
      cursor,
      "--limit",
      "200",
      "--wait-ms",
      "30000",
    ])).toMatchObject({
      command: { cursor, limit: 200, waitMs: 30_000 },
    });

    for (const argv of [
      ["work", "poll", workId, "--limit", "0"],
      ["work", "poll", workId, "--limit", "51"],
      ["work", "poll", workId, "--limit", "1.5"],
      ["work", "poll", workId, "--wait-ms", "30001"],
      ["work", "events", workId, "--limit", "0"],
      ["work", "events", workId, "--limit", "201"],
      ["work", "events", workId, "--wait-ms", "-1"],
      ["work", "events", workId, "--wait-ms", "30001"],
      ["work", "snapshot", "work_invalid"],
      ["work", "task", "task_invalid"],
      ["work", "snapshot", workId, "--actor", "worker-one"],
      ["work", "events", workId, "--cursor", "not-a-cursor"],
      ["work", "poll", workId, "--cursor", "x".repeat(2_049)],
    ]) {
      expect(() => parseCli(argv)).toThrow(CliUsageError);
    }
  });
});
