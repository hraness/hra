import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import { ClaudeDeltaAssembler, type ClaudeFact } from "./assembler";
import { ClaudeError } from "./errors";
import { parseClaudeStreamLine } from "./protocol";

const fixtureDirectory = join(import.meta.dir, "..", "..", "docs", "providers", "claude-fixtures");

const fixtureFacts = async (
  name: string,
  assembler: ClaudeDeltaAssembler,
): Promise<readonly ClaudeFact[]> => {
  const text = await Bun.file(join(fixtureDirectory, `${name}.jsonl.txt`)).text();
  return text
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .flatMap((line) => [...assembler.apply(parseClaudeStreamLine(JSON.parse(line) as unknown))]);
};

describe("Claude delta assembler", () => {
  test("assembles the captured single turn into HRA facts", async () => {
    const assembler = new ClaudeDeltaAssembler();
    const started = assembler.beginTurn("turn-1");
    expect(started).toEqual([{ turnId: "turn-1", type: "turnStarted" }]);
    expect(assembler.activeTurnId).toBe("turn-1");

    const facts = await fixtureFacts("stream-json-single-turn", assembler);
    expect(facts.map((fact) => fact.type)).toEqual([
      "sessionBootstrapped",
      "assistantDelta",
      "rateLimitObserved",
      "tokenUsageUpdated",
      "turnCompleted",
      "turnSummary",
    ]);
    expect(facts[0]).toMatchObject({
      model: "claude-fable-5-1",
      permissionMode: "default",
      type: "sessionBootstrapped",
    });
    expect(facts[1]).toMatchObject({ text: "ok", turnId: "turn-1", type: "assistantDelta" });
    expect(facts[4]).toEqual({ status: "completed", turnId: "turn-1", type: "turnCompleted" });
    expect(facts[5]).toMatchObject({
      resultText: "ok",
      status: "completed",
      stopReason: "end_turn",
      terminalReason: "completed",
      turnId: "turn-1",
      type: "turnSummary",
    });
    // The `result` line is the turn boundary, so the turn is over.
    expect(assembler.activeTurnId).toBeNull();
    expect(assembler.providerSessionId).toBe("726b1b3d-ed97-4b55-9904-e58fa7d7eb45");
  });

  test("classifies an unauthenticated result as a failed turn with a bounded error", async () => {
    const assembler = new ClaudeDeltaAssembler();
    assembler.beginTurn("turn-1");
    const facts = await fixtureFacts("output-json-unauthenticated", assembler);
    expect(facts.map((fact) => fact.type)).toEqual([
      "tokenUsageUpdated",
      "providerError",
      "turnCompleted",
      "turnSummary",
    ]);
    expect(facts[1]).toMatchObject({ code: "api_error", terminal: false, type: "providerError" });
    expect(facts[2]).toMatchObject({ status: "failed" });
  });

  test("marks an interrupted turn even when Claude reports success", () => {
    const assembler = new ClaudeDeltaAssembler();
    assembler.beginTurn("turn-1");
    assembler.markInterrupted();
    const facts = assembler.apply(parseClaudeStreamLine({
      duration_ms: 12,
      is_error: false,
      num_turns: 1,
      result: "stopped",
      session_id: "s",
      stop_reason: "end_turn",
      terminal_reason: "completed",
      type: "result",
      usage: {},
    }));
    expect(facts.find((fact) => fact.type === "turnCompleted")).toEqual({
      status: "interrupted",
      turnId: "turn-1",
      type: "turnCompleted",
    });
  });

  test("projects subagent activity from the recorded task events", async () => {
    const assembler = new ClaudeDeltaAssembler();
    assembler.beginTurn("turn-1");
    const facts = await fixtureFacts("bb-control-protocol-examples", assembler);
    const subagents = facts.filter((fact) => fact.type === "subagentActivity");
    expect(subagents.map((fact) => fact.activity)).toEqual([
      "started",
      "interacted",
      "interacted",
      "interacted",
    ]);
    expect(subagents[0]).toMatchObject({
      depth: 1,
      itemId: "toolu_01RNa8dUfBrdgn5ocMFVqkSN",
      nickname: "Read README first line",
      role: "Explore",
      taskId: "a5fb5e66c43a1adcd",
      turnId: "turn-1",
    });
    // Every recorded control request became an interaction with its mapped kind.
    expect(facts.filter((fact) => fact.type === "interactionRequested").map((fact) => fact.kind))
      .toEqual(["command_approval", "command_approval", "user_input"]);
  });

  test("routes a subagent's own message to activity, never the parent transcript", () => {
    const assembler = new ClaudeDeltaAssembler();
    assembler.beginTurn("turn-1");
    assembler.apply(parseClaudeStreamLine({
      description: "Read README first line",
      is_backgrounded: false,
      session_id: "s",
      spawn_depth: 1,
      subagent_type: "Explore",
      subtype: "task_started",
      task_id: "task-1",
      tool_use_id: "toolu_parent",
      type: "system",
    }));
    const facts = assembler.apply(parseClaudeStreamLine({
      message: {
        content: [{ text: "subagent said this", type: "text" }],
        id: "msg_1",
        model: "claude-fable-5-1",
        role: "assistant",
        type: "message",
      },
      parent_tool_use_id: "toolu_parent",
      session_id: "s",
      type: "assistant",
    }));
    expect(facts).toEqual([{
      activity: "interacted",
      depth: 1,
      itemId: "toolu_parent",
      nickname: "Read README first line",
      role: "Explore",
      taskId: "task-1",
      turnId: "turn-1",
      type: "subagentActivity",
    }]);
    expect(JSON.stringify(facts)).not.toContain("subagent said this");
  });

  test("marks a killed subagent as interrupted", () => {
    const assembler = new ClaudeDeltaAssembler();
    assembler.beginTurn("turn-1");
    assembler.apply(parseClaudeStreamLine({
      description: "d",
      session_id: "s",
      spawn_depth: 1,
      subagent_type: "Explore",
      subtype: "task_started",
      task_id: "task-1",
      tool_use_id: "toolu_parent",
      type: "system",
    }));
    const facts = assembler.apply(parseClaudeStreamLine({
      patch: { status: "killed" },
      session_id: "s",
      subtype: "task_updated",
      task_id: "task-1",
      type: "system",
    }));
    expect(facts[0]).toMatchObject({ activity: "interrupted", status: "killed" });
  });

  test("separates thinking from assistant text", () => {
    const assembler = new ClaudeDeltaAssembler();
    assembler.beginTurn("turn-1");
    const facts = assembler.apply(parseClaudeStreamLine({
      message: {
        content: [
          { thinking: "weighing options", type: "thinking" },
          { text: "done", type: "text" },
        ],
        id: "msg_1",
        model: "claude-fable-5-1",
        role: "assistant",
        type: "message",
      },
      parent_tool_use_id: null,
      session_id: "s",
      type: "assistant",
    }));
    expect(facts).toEqual([
      { itemId: "msg_1", summaryIndex: 0, text: "weighing options", turnId: "turn-1", type: "reasoningSummaryDelta" },
      { itemId: "msg_1", text: "done", turnId: "turn-1", type: "assistantDelta" },
    ]);
  });

  test("refuses a second in-flight turn and ends an abandoned one exactly once", () => {
    const assembler = new ClaudeDeltaAssembler();
    assembler.beginTurn("turn-1");
    expect(() => assembler.beginTurn("turn-2")).toThrow(ClaudeError);
    expect(assembler.abandonTurn("the Claude stream ended").map((fact) => fact.type))
      .toEqual(["providerError", "turnCompleted"]);
    expect(assembler.abandonTurn("again")).toEqual([]);
    expect(() => assembler.beginTurn("turn-2")).not.toThrow();
  });

  test("drops every event that arrives outside a turn", () => {
    const assembler = new ClaudeDeltaAssembler();
    expect(assembler.apply(parseClaudeStreamLine({
      message: { content: [{ text: "stray", type: "text" }], id: "m", role: "assistant", type: "message" },
      parent_tool_use_id: null,
      session_id: "s",
      type: "assistant",
    }))).toEqual([]);
  });
});
