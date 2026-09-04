import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import { ClaudeError } from "./errors";
import { CLAUDE_PIN, CLAUDE_PIN_MODEL, PINNED_CLAUDE_MATRIX_DIGESTS } from "./pin";
import {
  assertPinnedClaudeMatrices,
  assertPinnedClaudeModel,
  assertPinnedClaudeVersion,
  boundClaudeText,
  claudeAnswerMap,
  claudeCommandClass,
  claudeControlResponse,
  claudeControlResponseLine,
  claudeInteractionDisplay,
  claudeInteractionKind,
  claudeMatrixDigest,
  claudeUserLine,
  parseClaudeStreamLine,
  sanitizeClaudeText,
  PINNED_CLAUDE_CONTROL_REQUEST_MATRIX,
  PINNED_CLAUDE_STREAM_MATRIX,
  type ClaudeCanUseTool,
  type ClaudeStreamEvent,
} from "./protocol";

const fixtureDirectory = join(import.meta.dir, "..", "..", "docs", "providers", "claude-fixtures");

/**
 * Fixtures are stored as `.jsonl.txt` because the package policy admits only
 * reviewed text extensions. Each line is one captured stream-json object.
 */
const readFixture = async (name: string): Promise<readonly unknown[]> => {
  const text = await Bun.file(join(fixtureDirectory, `${name}.jsonl.txt`)).text();
  return text
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as unknown);
};

const parseFixture = async (name: string): Promise<readonly ClaudeStreamEvent[]> =>
  (await readFixture(name)).map(parseClaudeStreamLine);

const canUseTool = (event: ClaudeStreamEvent): ClaudeCanUseTool => {
  if (event.type !== "control_request") throw new Error("expected a control request");
  return event.request;
};

describe("Claude pin", () => {
  test("admits only the reviewed version, model, and effort", () => {
    expect(() => { assertPinnedClaudeVersion(CLAUDE_PIN); }).not.toThrow();
    expect(() => { assertPinnedClaudeVersion("2.1.259"); }).toThrow(ClaudeError);
    expect(() => { assertPinnedClaudeModel(CLAUDE_PIN_MODEL, "max"); }).not.toThrow();
    expect(() => { assertPinnedClaudeModel("claude-fable-5", "max"); }).toThrow(ClaudeError);
    // "max without ultracode": ultracode is a real effort HRA never requests.
    expect(() => { assertPinnedClaudeModel(CLAUDE_PIN_MODEL, "ultracode"); }).toThrow(
      "never requests the `ultracode` reasoning effort",
    );
    expect(() => { assertPinnedClaudeModel(CLAUDE_PIN_MODEL, "high"); }).toThrow(ClaudeError);
  });

  test("fails closed when the reviewed event matrix drifts", () => {
    expect(() => { assertPinnedClaudeMatrices(); }).not.toThrow();
    expect(claudeMatrixDigest(CLAUDE_PIN, PINNED_CLAUDE_STREAM_MATRIX))
      .toBe(PINNED_CLAUDE_MATRIX_DIGESTS.streamEvent);
    expect(claudeMatrixDigest(CLAUDE_PIN, PINNED_CLAUDE_CONTROL_REQUEST_MATRIX))
      .toBe(PINNED_CLAUDE_MATRIX_DIGESTS.controlRequest);
    expect(claudeMatrixDigest("2.1.259", PINNED_CLAUDE_STREAM_MATRIX))
      .not.toBe(PINNED_CLAUDE_MATRIX_DIGESTS.streamEvent);
    expect(claudeMatrixDigest(CLAUDE_PIN, { ...PINNED_CLAUDE_STREAM_MATRIX, assistant: "ignored" }))
      .not.toBe(PINNED_CLAUDE_MATRIX_DIGESTS.streamEvent);
  });
});

describe("Claude stream-json fixtures", () => {
  test("parses every line of the captured single turn", async () => {
    const events = await parseFixture("stream-json-single-turn");
    expect(events.map((event) => event.type)).toEqual([
      "ignored",
      "ignored",
      "ignored",
      "ignored",
      "ignored",
      "ignored",
      "session_init",
      "assistant_message",
      "rate_limit",
      "result",
    ]);
    const init = events[6];
    if (init?.type !== "session_init") throw new Error("expected session_init");
    expect(init.model).toBe(CLAUDE_PIN_MODEL);
    expect(init.permissionMode).toBe("default");
    expect(init.claudeVersion).toMatch(/^\d+\.\d+\.\d+$/u);
    expect(init.sessionId).toBe("726b1b3d-ed97-4b55-9904-e58fa7d7eb45");

    const assistant = events[7];
    if (assistant?.type !== "assistant_message") throw new Error("expected assistant_message");
    expect(assistant.text).toBe("ok");
    expect(assistant.thinking).toBe("");
    expect(assistant.parentToolUseId).toBeNull();

    const result = events[9];
    if (result?.type !== "result") throw new Error("expected result");
    expect(result.isError).toBe(false);
    expect(result.stopReason).toBe("end_turn");
    expect(result.terminalReason).toBe("completed");
    expect(result.usage.inputTokens).toBe(2);
    expect(result.usage.outputTokens).toBe(4);
    expect(result.usage.cachedInputTokens).toBe(11_059 + 10_123);
  });

  test("classifies the authenticated and unauthenticated result envelopes", async () => {
    const [authenticated] = await parseFixture("output-json-authenticated");
    if (authenticated?.type !== "result") throw new Error("expected result");
    expect(authenticated.isError).toBe(false);
    expect(authenticated.terminalReason).toBe("completed");
    expect(authenticated.resultText).toBe("ok");

    const [unauthenticated] = await parseFixture("output-json-unauthenticated");
    if (unauthenticated?.type !== "result") throw new Error("expected result");
    // The CLI's outer envelope still says `subtype: "success"`; only
    // `is_error` and `terminal_reason` classify the failure.
    expect(unauthenticated.isError).toBe(true);
    expect(unauthenticated.terminalReason).toBe("api_error");
    expect(unauthenticated.resultText).toContain("Not logged in");
    expect(unauthenticated.usage.outputTokens).toBe(0);
  });

  test("parses the recorded control protocol and subagent events", async () => {
    const events = await parseFixture("bb-control-protocol-examples");
    expect(events.map((event) => event.type)).toEqual([
      "control_request",
      "ignored",
      "control_request",
      "ignored",
      "control_request",
      "ignored",
      "task_started",
      "task_progress",
      "task_updated",
      "task_notification",
    ]);

    const bashAllow = canUseTool(events[0] as ClaudeStreamEvent);
    expect(bashAllow.toolName).toBe("Bash");
    expect(bashAllow.requiresUserInteraction).toBe(false);
    expect(bashAllow.permissionSuggestionCount).toBe(1);
    expect(bashAllow.blockedPath).toBeNull();

    const bashDeny = canUseTool(events[2] as ClaudeStreamEvent);
    expect(bashDeny.blockedPath).not.toBeNull();

    const question = canUseTool(events[4] as ClaudeStreamEvent);
    expect(question.toolName).toBe("AskUserQuestion");
    expect(question.requiresUserInteraction).toBe(true);
    expect(question.questions).toEqual([
      {
        header: "Indent",
        multiSelect: false,
        options: [
          { description: "Indent with tab characters", label: "tabs" },
          { description: "Indent with space characters", label: "spaces" },
        ],
        question: "Tabs or spaces?",
      },
    ]);

    const started = events[6];
    if (started?.type !== "task_started") throw new Error("expected task_started");
    expect(started.subagentType).toBe("Explore");
    expect(started.spawnDepth).toBe(1);
    expect(started.toolUseId).toBe("toolu_01RNa8dUfBrdgn5ocMFVqkSN");

    const progress = events[7];
    if (progress?.type !== "task_progress") throw new Error("expected task_progress");
    expect(progress.lastToolName).toBe("Bash");
    expect(progress.totalTokens).toBe(12_851);

    const updated = events[8];
    if (updated?.type !== "task_updated") throw new Error("expected task_updated");
    expect(updated.status).toBe("completed");

    const notification = events[9];
    if (notification?.type !== "task_notification") throw new Error("expected task_notification");
    expect(notification.status).toBe("completed");
  });
});

describe("Claude event admission", () => {
  test("keeps Claude's own plumbing out of the HRA model", () => {
    for (const subtype of ["hook_callback", "mcp_message", "set_permission_mode", "initialize"]) {
      expect(parseClaudeStreamLine({
        request: { subtype },
        request_id: "r1",
        type: "control_request",
      })).toEqual({ event: `control_request/${subtype}`, type: "ignored" });
    }
    expect(parseClaudeStreamLine({
      message: { content: "hi", role: "user" },
      type: "user",
    })).toEqual({ event: "user", type: "ignored" });
  });

  test("reports an unrecognised event as a bounded notice, not a fault", () => {
    expect(parseClaudeStreamLine({ type: "brand_new_event" }))
      .toEqual({ event: "brand_new_event", type: "protocol_notice" });
    expect(parseClaudeStreamLine({ subtype: "brand_new", type: "system" }))
      .toEqual({ event: "system/brand_new", type: "protocol_notice" });
    expect(parseClaudeStreamLine({ request: { subtype: "brand_new" }, request_id: "r", type: "control_request" }))
      .toEqual({ event: "control_request/brand_new", type: "protocol_notice" });
  });

  test("refuses a malformed envelope from unknown", () => {
    expect(() => parseClaudeStreamLine(null)).toThrow(ClaudeError);
    expect(() => parseClaudeStreamLine([])).toThrow(ClaudeError);
    expect(() => parseClaudeStreamLine({ type: 7 })).toThrow(ClaudeError);
    expect(() => parseClaudeStreamLine({ subtype: "init", type: "system" })).toThrow(ClaudeError);
  });

  test("assembles text and thinking deltas from partial messages", () => {
    expect(parseClaudeStreamLine({
      event: {
        delta: { text: "he", type: "text_delta" },
        index: 0,
        type: "content_block_delta",
      },
      parent_tool_use_id: null,
      session_id: "s",
      type: "stream_event",
    })).toEqual({
      block: "text",
      blockIndex: 0,
      parentToolUseId: null,
      sessionId: "s",
      text: "he",
      type: "content_delta",
    });
    expect(parseClaudeStreamLine({
      event: {
        delta: { thinking: "hm", type: "thinking_delta" },
        index: 1,
        type: "content_block_delta",
      },
      parent_tool_use_id: null,
      session_id: "s",
      type: "stream_event",
    })).toMatchObject({ block: "thinking", blockIndex: 1, text: "hm" });
    expect(parseClaudeStreamLine({
      event: { index: 0, type: "content_block_start" },
      session_id: "s",
      type: "stream_event",
    })).toEqual({ event: "stream_event/content_block_start", type: "ignored" });
  });
});

// Composed, never spelled: the package policy refuses a literal absolute
// user path anywhere in published source.
const absoluteFixture = ["", "home", "someone", "project", "notes.md"].join("/");

const request = (overrides: Partial<ClaudeCanUseTool> = {}): ClaudeCanUseTool => ({
  blockedPath: null,
  decisionReasonType: null,
  description: null,
  displayName: "Bash",
  input: { command: "/bin/echo hi" },
  permissionSuggestionCount: 0,
  questions: null,
  requiresUserInteraction: false,
  subtype: "can_use_tool",
  toolName: "Bash",
  toolUseId: "toolu_1",
  ...overrides,
});

describe("can_use_tool mapping", () => {
  test("maps every tool onto the plan's interaction kind", () => {
    expect(claudeInteractionKind(request())).toBe("command_approval");
    for (const toolName of ["Edit", "Write", "NotebookEdit"]) {
      expect(claudeInteractionKind(request({ toolName }))).toBe("file_change_approval");
    }
    for (const toolName of ["WebFetch", "Read", "Task", "mcp__server__tool"]) {
      expect(claudeInteractionKind(request({ toolName }))).toBe("permission_approval");
    }
    expect(claudeInteractionKind(request({
      input: { questions: [] },
      questions: [],
      requiresUserInteraction: true,
      toolName: "AskUserQuestion",
    }))).toBe("user_input");
    // A request the runtime marks as needing a person wins over its tool name.
    expect(claudeInteractionKind(request({ requiresUserInteraction: true }))).toBe("user_input");
  });

  test("builds a bounded, sanitized display for each kind", () => {
    const command = claudeInteractionDisplay(request({
      description: "Echo",
      input: { command: "/bin/echo hi" },
    }));
    expect(command).toEqual({
      availableDecisions: ["once", "decline"],
      // The command line itself is never projected verbatim: only its
      // bounded class survives, and its absolute path is reduced.
      commandClass: "echo",
      kind: "command_approval",
      reason: "Echo",
      summary: "Bash: [local-path] hi",
      workingDirectory: null,
    });

    const fileChange = claudeInteractionDisplay(request({
      displayName: "Edit",
      input: { file_path: absoluteFixture },
      toolName: "Edit",
    }));
    expect(fileChange.kind).toBe("file_change_approval");
    // Absolute paths never reach a projection verbatim.
    expect(fileChange.summary).not.toContain(absoluteFixture);

    const permission = claudeInteractionDisplay(request({
      blockedPath: "/etc/hosts",
      displayName: "WebFetch",
      toolName: "WebFetch",
    }));
    if (permission.kind !== "permission_approval") throw new Error("expected permission approval");
    expect(permission.requested).toEqual([{ name: "WebFetch" }]);
    expect(permission.allowsSessionScope).toBe(false);

    const question = claudeInteractionDisplay(request({
      displayName: "AskUserQuestion",
      input: {},
      questions: [{
        header: "Indent",
        multiSelect: false,
        options: [
          { description: "Tabs", label: "tabs" },
          { description: "Spaces", label: "spaces" },
        ],
        question: "Tabs or spaces?",
      }],
      requiresUserInteraction: true,
      toolName: "AskUserQuestion",
    }));
    if (question.kind !== "user_input") throw new Error("expected user input");
    expect(question.questions).toEqual([{
      allowsOther: false,
      header: "Indent",
      id: "q0",
      options: [
        { description: "Tabs", label: "tabs" },
        { description: "Spaces", label: "spaces" },
      ],
      question: "Tabs or spaces?",
      secret: false,
    }]);
  });

  test("classifies commands without ever projecting the command line", () => {
    expect(claudeCommandClass("/usr/bin/git status")).toBe("git");
    expect(claudeCommandClass("curl -sI https://example.com | head -n 1")).toBe("curl");
    expect(claudeCommandClass("")).toBe("command");
    expect(claudeCommandClass("$(evil)")).toBe("command");
  });
});

describe("control responses", () => {
  test("an allow echoes only the request's own input", () => {
    const allow = claudeControlResponse(request(), { kind: "allow" });
    expect(allow).toEqual({
      behavior: "allow",
      toolUseID: "toolu_1",
      updatedInput: { command: "/bin/echo hi" },
    });
    // No `permission_suggestions` rule is ever echoed back, so HRA can grant
    // nothing beyond this one tool use.
    expect(JSON.stringify(allow)).not.toContain("permission_suggestions");
  });

  test("a deny carries a bounded message and no updated input", () => {
    const deny = claudeControlResponse(request(), { kind: "deny", message: "Permission request denied" });
    expect(deny).toEqual({
      behavior: "deny",
      message: "Permission request denied",
      toolUseID: "toolu_1",
    });
  });

  test("an answer folds the answers map into updatedInput keyed by question text", () => {
    const asked = request({
      input: { questions: [{ header: "Indent", question: "Tabs or spaces?" }] },
      questions: [{
        header: "Indent",
        multiSelect: false,
        options: [{ description: "", label: "tabs" }, { description: "", label: "spaces" }],
        question: "Tabs or spaces?",
      }],
      requiresUserInteraction: true,
      toolName: "AskUserQuestion",
    });
    const answered = claudeControlResponse(asked, { answers: { q0: "spaces" }, kind: "answer" });
    if (answered.behavior !== "allow") throw new Error("expected allow");
    expect(answered.updatedInput.answers).toEqual({ "Tabs or spaces?": "spaces" });
    expect(claudeAnswerMap(asked, { q0: "tabs" })).toEqual({ "Tabs or spaces?": "tabs" });
    expect(() => claudeAnswerMap(asked, { q0: "not-an-option" })).toThrow(ClaudeError);
    expect(() => claudeAnswerMap(asked, {})).toThrow(ClaudeError);
  });

  test("writes exactly one newline-terminated JSON line", () => {
    const line = claudeControlResponseLine("req-1", claudeControlResponse(request(), { kind: "allow" }));
    expect(line.endsWith("\n")).toBe(true);
    expect(line.split("\n").filter((value) => value.length > 0)).toHaveLength(1);
    expect(JSON.parse(line) as unknown).toEqual({
      response: {
        request_id: "req-1",
        response: {
          behavior: "allow",
          toolUseID: "toolu_1",
          updatedInput: { command: "/bin/echo hi" },
        },
        subtype: "success",
      },
      type: "control_response",
    });
    expect(JSON.parse(claudeUserLine("go on")) as unknown).toEqual({
      message: { content: [{ text: "go on", type: "text" }], role: "user" },
      type: "user",
    });
  });
});

describe("provider text safety", () => {
  test("reduces paths, protects secrets, and folds unsafe scalars", () => {
    expect(sanitizeClaudeText(absoluteFixture)).not.toContain("someone");
    expect(sanitizeClaudeText("token: abcdefghijklmnop")).toContain("[protected]");
    expect(sanitizeClaudeText("ab")).toBe("a�b");
    expect(sanitizeClaudeText("line\nline", true)).toBe("line\nline");
  });

  test("bounds text on scalar boundaries", () => {
    expect(boundClaudeText("héllo", 3)).toBe("hé");
    expect(boundClaudeText("abc", 32)).toBe("abc");
  });
});
