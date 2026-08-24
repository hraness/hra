import { describe, expect, test } from "bun:test";

import { createProfileId, createSessionId } from "../domain/values";
import {
  sanitizeInteractionDisplay,
  SessionEventStreamRedactor,
  type SessionEventWrite,
} from "./streaming-redaction";

const accountId = createProfileId();
const sessionId = createSessionId();
const connectionId = "65000000-0000-4000-8000-000000000001";
const privatePathRoot = ["", "Users", "private"].join("/");

const write = (
  body: SessionEventWrite["body"],
  overrides: Partial<Omit<SessionEventWrite, "body">> = {},
): SessionEventWrite => ({
  accountId,
  providerConnectionId: connectionId,
  providerGeneration: 3,
  sessionId,
  ...overrides,
  body,
});

const assistant = (itemId: string, text: string): SessionEventWrite => write({
  type: "assistant_delta",
  turnId: "turn-1",
  itemId,
  text,
});

const start = (
  itemId: string,
  overrides: Partial<Omit<SessionEventWrite, "body">> = {},
  turnId = "turn-1",
): SessionEventWrite => write({
  type: "item_started",
  turnId,
  itemId,
  itemKind: "agentMessage",
}, overrides);

const complete = (itemId: string): SessionEventWrite => write({
  type: "item_completed",
  turnId: "turn-1",
  itemId,
  itemKind: "agentMessage",
  status: "completed",
});

const texts = (writes: readonly SessionEventWrite[], itemId: string): string =>
  writes.flatMap((entry) =>
    (entry.body.type === "assistant_delta" || entry.body.type === "reasoning_summary_delta")
    && entry.body.itemId === itemId
      ? [entry.body.text]
      : []).join("");

describe("SessionEventStreamRedactor", () => {
  test("redacts split authorization, device-code, token, and key assignments before release", () => {
    const redactor = new SessionEventStreamRedactor();
    const output: SessionEventWrite[] = [];

    for (const [itemId, chunks] of [
      ["authorization", ["Safe prefix. Authori", "zation: Bearer super", "secret-token\nSafe suffix."]],
      ["device-code", ["Use device_", "code='DEVICE-SECRET-42", "' after linking."]],
      ["api-key", ["Configuration api_", "key=KEY-VALUE-SECRET-99", " is loaded."]],
      ["token", ["The access_", "token: TOKEN-VALUE-SECRET-88", " is hidden."]],
    ] as const) {
      output.push(...redactor.accept(start(itemId)));
      for (const chunk of chunks) output.push(...redactor.accept(assistant(itemId, chunk)));
      output.push(...redactor.accept(complete(itemId)));
    }

    const serialized = JSON.stringify(output);
    expect(serialized).not.toContain("supersecret-token");
    expect(serialized).not.toContain("DEVICE-SECRET-42");
    expect(serialized).not.toContain("KEY-VALUE-SECRET-99");
    expect(serialized).not.toContain("TOKEN-VALUE-SECRET-88");
    expect(serialized.match(/\[protected\]/gu)?.length).toBeGreaterThanOrEqual(4);
    expect(texts(output, "authorization")).toContain("Safe prefix.");
    expect(texts(output, "authorization")).toContain("Safe suffix.");
  });

  test("keeps interleaved items and reasoning parts isolated and ordered", () => {
    const redactor = new SessionEventStreamRedactor();
    const output: SessionEventWrite[] = [];
    redactor.accept(start("safe-a"));
    redactor.accept(start("secret-b"));
    output.push(...redactor.accept(start("reasoning")));
    output.push(...redactor.accept(assistant("safe-a", "alpha ")));
    output.push(...redactor.accept(assistant("secret-b", "Authorization: Bearer SECRET-B-1234")));
    output.push(...redactor.accept(assistant("safe-a", "continues")));
    output.push(...redactor.accept(write({
      type: "reasoning_summary_delta",
      turnId: "turn-1",
      itemId: "reasoning",
      summaryPart: 0,
      text: "part zero ",
    })));
    output.push(...redactor.accept(write({
      type: "reasoning_summary_delta",
      turnId: "turn-1",
      itemId: "reasoning",
      summaryPart: 1,
      text: "api_key=REASONING-SECRET-55",
    })));
    output.push(...redactor.accept(complete("secret-b")));
    output.push(...redactor.accept(complete("safe-a")));
    output.push(...redactor.accept(complete("reasoning")));

    expect(texts(output, "safe-a")).toBe("alpha continues");
    expect(texts(output, "secret-b")).toContain("[protected]");
    expect(texts(output, "secret-b")).not.toContain("SECRET-B-1234");
    expect(texts(output, "reasoning")).toContain("part zero ");
    expect(texts(output, "reasoning")).toContain("[protected]");
    expect(texts(output, "reasoning")).not.toContain("REASONING-SECRET-55");
    expect(redactor.activeStreamCount).toBe(0);
  });

  test("keeps hostile reasoning-summary interleaving isolated by summary part", () => {
    const redactor = new SessionEventStreamRedactor();
    const output: SessionEventWrite[] = [];
    redactor.accept(start("reasoning-hostile"));
    for (const [summaryPart, text] of [
      [0, "Authorization: Bear"],
      [1, "independent safe part"],
      [0, "er PART-ZERO-SECRET"],
    ] as const) {
      output.push(...redactor.accept(write({
        type: "reasoning_summary_delta",
        turnId: "turn-1",
        itemId: "reasoning-hostile",
        summaryPart,
        text,
      })));
    }
    output.push(...redactor.accept(complete("reasoning-hostile")));

    expect(texts(output, "reasoning-hostile")).toContain("independent safe part");
    expect(texts(output, "reasoning-hostile")).toContain("[protected]");
    expect(JSON.stringify(output)).not.toContain("PART-ZERO-SECRET");
  });

  test("requires an exact item-start boundary and recovers without poisoning later items", () => {
    const redactor = new SessionEventStreamRedactor();
    const unstarted = redactor.accept(assistant("unstarted", "must not enter durable custody"));
    expect(texts(unstarted, "unstarted")).toBe("[protected]");
    expect(JSON.stringify(unstarted)).not.toContain("must not enter");

    redactor.accept(start("started"));
    expect(redactor.accept(assistant("started", "safe after exact start"))).toEqual([]);
    expect(texts(redactor.accept(complete("started")), "started"))
      .toBe("safe after exact start");

    redactor.accept(start("repeated"));
    expect(redactor.accept(assistant("repeated", "unfinished api_"))).toEqual([]);
    const repeatedStart = redactor.accept(start("repeated"));
    expect(texts(repeatedStart, "repeated")).toBe("[protected]");
    expect(JSON.stringify(repeatedStart)).not.toContain("unfinished");
    expect(redactor.accept(assistant("repeated", "safe after repeated start"))).toEqual([]);
    expect(texts(redactor.accept(complete("repeated")), "repeated"))
      .toBe("safe after repeated start");
  });

  test("binds lifecycle custody to the exact provider connection and generation", () => {
    const redactor = new SessionEventStreamRedactor();
    const otherAuthority = {
      providerConnectionId: "65000000-0000-4000-8000-000000000099",
      providerGeneration: 4,
    } as const;
    redactor.accept(start("authority-bound"));

    const mismatched = redactor.accept(write({
      type: "assistant_delta",
      turnId: "turn-1",
      itemId: "authority-bound",
      text: "mismatched authority must not enter custody",
    }, otherAuthority));
    expect(texts(mismatched, "authority-bound")).toBe("[protected]");
    expect(JSON.stringify(mismatched)).not.toContain("mismatched authority");

    expect(redactor.accept(assistant("authority-bound", "exact authority remains safe")))
      .toEqual([]);
    expect(redactor.accept(write({
      type: "item_completed",
      turnId: "turn-1",
      itemId: "authority-bound",
      itemKind: "agentMessage",
      status: "completed",
    }, otherAuthority))).toEqual([]);
    const completed = redactor.accept(complete("authority-bound"));
    expect(texts(completed, "authority-bound")).toBe("exact authority remains safe");
    expect(completed.map((entry) => entry.body.type)).toEqual([
      "assistant_delta",
      "item_completed",
      "item_completed",
    ]);
  });

  test("releases staged interleaved deltas and non-deltas in provider source order", () => {
    const redactor = new SessionEventStreamRedactor();
    const output: SessionEventWrite[] = [];
    redactor.accept(start("safe-a"));
    redactor.accept(start("secret-b"));
    output.push(...redactor.accept(assistant("safe-a", "alpha ")));
    output.push(...redactor.accept(assistant("secret-b", "Authorization: Bearer ORDER-SECRET-11")));
    output.push(...redactor.accept(write({
      type: "plan_updated",
      turnId: "turn-1",
      steps: [{ text: "Keep source order", status: "in_progress" }],
    })));
    output.push(...redactor.accept(assistant("safe-a", "continues")));
    output.push(...redactor.accept(complete("secret-b")));
    output.push(...redactor.accept(complete("safe-a")));

    expect(output.map((entry) => {
      const body = entry.body;
      if (body.type === "assistant_delta") return `${body.itemId}:${body.text}`;
      if (body.type === "item_completed") return `completed:${body.itemId}`;
      return body.type;
    })).toEqual([
      "safe-a:alpha ",
      "secret-b:[protected]",
      "plan_updated",
      "safe-a:continues",
      "completed:secret-b",
      "completed:safe-a",
    ]);
    expect(JSON.stringify(output)).not.toContain("ORDER-SECRET-11");
  });

  test("scopes overflow quarantine to one session and recovers at trustworthy boundaries", () => {
    const otherSessionId = createSessionId();
    const global = new SessionEventStreamRedactor({
      maximumActiveStreams: 1,
      maximumActiveStreamsPerSession: 1,
    });
    global.accept(start("first"));
    expect(global.accept(assistant("first", "first safe-looking fragment"))).toEqual([]);
    global.accept(start("other", { sessionId: otherSessionId }, "turn-other"));
    const rejectedOther = global.accept(write({
      type: "assistant_delta",
      turnId: "turn-other",
      itemId: "other",
      text: "other undecided token_",
    }, { sessionId: otherSessionId }));
    expect(JSON.stringify(rejectedOther)).not.toContain("undecided");
    expect(JSON.stringify(rejectedOther)).toContain("[protected]");

    expect(global.accept(assistant("first", " continues"))).toEqual([]);
    const firstComplete = global.accept(complete("first"));
    expect(texts(firstComplete, "first")).toBe("first safe-looking fragment continues");
    expect(JSON.stringify(firstComplete)).not.toContain("[protected]");

    global.accept(start("other-recovered", { sessionId: otherSessionId }, "turn-other-2"));
    expect(global.accept(write({
      type: "assistant_delta",
      turnId: "turn-other-2",
      itemId: "other-recovered",
      text: "other safe after recovery",
    }, { sessionId: otherSessionId }))).toEqual([]);
    const recovered = global.accept(write({
      type: "item_completed",
      turnId: "turn-other-2",
      itemId: "other-recovered",
      itemKind: "agentMessage",
      status: "completed",
    }, { sessionId: otherSessionId }));
    expect(texts(recovered, "other-recovered")).toBe("other safe after recovery");

    const perSession = new SessionEventStreamRedactor({
      maximumActiveStreams: 2,
      maximumActiveStreamsPerSession: 1,
    });
    perSession.accept(start("one"));
    expect(perSession.accept(assistant("one", "one undecided api_"))).toEqual([]);
    const protectedWrites = [
      ...perSession.accept(start("two")),
      ...perSession.accept(assistant("two", "two undecided secret_")),
    ];
    expect(JSON.stringify(protectedWrites)).not.toContain("undecided");
    expect(JSON.stringify(protectedWrites).match(/\[protected\]/gu)?.length).toBe(2);
    perSession.accept(start("recovered"));
    expect(perSession.accept(assistant("recovered", "safe after item start"))).toEqual([]);
    expect(texts(perSession.accept(complete("recovered")), "recovered"))
      .toBe("safe after item start");

    const staged = new SessionEventStreamRedactor({
      maximumActiveStreams: 2,
      maximumActiveStreamsPerSession: 2,
      maximumStagedNodes: 1,
    });
    staged.accept(start("staged"));
    expect(staged.accept(assistant("staged", "one safe-looking fragment"))).toEqual([]);
    const exhausted = staged.accept(assistant("staged", "second secret_ fragment"));
    expect(JSON.stringify(exhausted)).not.toContain("fragment");
    expect(JSON.stringify(exhausted).match(/\[protected\]/gu)?.length).toBe(2);

    const invalidBacklog = new SessionEventStreamRedactor({
      maximumActiveStreams: 2,
      maximumActiveStreamsPerSession: 2,
      maximumStagedNodes: 2,
    });
    invalidBacklog.accept(start("held"));
    expect(invalidBacklog.accept(assistant("held", "held safe-looking tail"))).toEqual([]);
    expect(invalidBacklog.accept(assistant("unstarted-one", "unstarted raw one"))).toEqual([]);
    const boundedInvalid = invalidBacklog.accept(
      assistant("unstarted-two", "unstarted raw two"),
    );
    expect(JSON.stringify(boundedInvalid)).not.toContain("safe-looking");
    expect(JSON.stringify(boundedInvalid)).not.toContain("unstarted raw");
    expect(JSON.stringify(boundedInvalid).match(/\[protected\]/gu)?.length).toBe(3);
  });

  test("replaces unresolved tails on disconnect and restart boundaries", () => {
    const redactor = new SessionEventStreamRedactor();
    redactor.accept(start("disconnect"));
    expect(redactor.accept(assistant("disconnect", "visible then api_"))).toEqual([]);

    const disconnected = redactor.accept(write({
      type: "connection",
      state: "disconnected",
      reason: "process_exit",
    }));
    expect(texts(disconnected, "disconnect")).toBe("[protected]");
    expect(JSON.stringify(disconnected)).not.toContain("api_");
    expect(disconnected.at(-1)?.body).toEqual({
      type: "connection",
      state: "disconnected",
      reason: "process_exit",
    });
    expect(redactor.activeStreamCount).toBe(0);

    const replacementConnection = "65000000-0000-4000-8000-000000000099";
    const replacement = { providerConnectionId: replacementConnection, providerGeneration: 4 };
    redactor.accept(start("restart", replacement, "turn-restart"));
    expect(redactor.accept(write({
      type: "assistant_delta",
      turnId: "turn-restart",
      itemId: "restart",
      text: "visible then Authori",
    }, replacement))).toEqual([]);
    const restarted = redactor.accept(write({
      type: "gap",
      reason: "provider_restart",
      fromSequence: 12,
      throughSequence: 12,
    }, replacement));
    expect(texts(restarted, "restart")).toBe("[protected]");
    expect(JSON.stringify(restarted)).not.toContain("Authori");
    expect(restarted.at(-1)?.body).toEqual({
      type: "gap",
      reason: "provider_restart",
      fromSequence: 12,
      throughSequence: 12,
    });
    expect(redactor.activeStreamCount).toBe(0);
  });

  test("sanitizes complete plan and interaction prose without changing closed decisions", () => {
    const display = sanitizeInteractionDisplay({
      kind: "user_input",
      summary: "Authorization: Bearer DISPLAY-SECRET-11",
      blocking: true,
      questions: [{
        id: "question-1",
        header: "Device code=DISPLAY-SECRET-22",
        question: `Paste api_key=DISPLAY-SECRET-33 from ${privatePathRoot}/key.txt`,
        options: [{
          label: "Continue",
          description: `Use ${privatePathRoot}/token.txt`,
        }],
        allowsOther: false,
        secret: false,
      }],
    });
    expect(JSON.stringify(display)).not.toContain("DISPLAY-SECRET");
    expect(JSON.stringify(display)).not.toContain(privatePathRoot);
    expect(JSON.stringify(display)).toContain("[protected]");
    expect(JSON.stringify(display)).toContain("[local-path]");

    const redactor = new SessionEventStreamRedactor();
    const plan = redactor.accept(write({
      type: "plan_updated",
      turnId: "turn-1",
      steps: [{ text: "Send Authorization: Bearer PLAN-SECRET-11", status: "pending" }],
      explanation: `Read api_key=PLAN-SECRET-22 from ${privatePathRoot}/.env`,
    }));
    expect(JSON.stringify(plan)).not.toContain("PLAN-SECRET");
    expect(JSON.stringify(plan)).not.toContain(privatePathRoot);
    expect(plan).toHaveLength(1);

    const terminal = redactor.accept(write({
      type: "turn_completed",
      turnId: "turn-terminal-error",
      status: "failed",
      errorCode: "Authorization: Bearer TURN-ERROR-SECRET",
    }));
    expect(terminal).toHaveLength(1);
    expect(JSON.stringify(terminal)).not.toContain("TURN-ERROR-SECRET");
    expect(terminal[0]?.body).toMatchObject({
      type: "turn_completed",
      errorCode: "[protected]",
    });
  });

  test("rejects unsafe or ambiguous exact interaction answer tokens", () => {
    expect(() => sanitizeInteractionDisplay({
      kind: "permission_approval",
      summary: "Grant access",
      reason: null,
      requested: [{ name: "api_key=PERMISSION-SECRET-11" }],
      allowsSessionScope: false,
    })).toThrow("UNSAFE_EXACT_INTERACTION_DISPLAY:permission_name");

    expect(() => sanitizeInteractionDisplay({
      kind: "user_input",
      summary: "Choose",
      blocking: true,
      questions: [{
        id: "Authorization: Bearer QUESTION-ID-SECRET",
        header: "Question",
        question: "Choose one",
        options: null,
        allowsOther: false,
        secret: false,
      }],
    })).toThrow("UNSAFE_EXACT_INTERACTION_DISPLAY:question_id");

    expect(() => sanitizeInteractionDisplay({
      kind: "user_input",
      summary: "Choose",
      blocking: true,
      questions: [{
        id: "question-1",
        header: "Question",
        question: "Choose one",
        options: [
          { label: "same", description: "first" },
          { label: "same", description: "second" },
        ],
        allowsOther: false,
        secret: false,
      }],
    })).toThrow("NON_UNIQUE_EXACT_INTERACTION_DISPLAY:question_option_labels");

    expect(() => sanitizeInteractionDisplay({
      kind: "mcp_elicitation",
      summary: "Configure",
      serverName: "server",
      mode: "form",
      url: null,
      mayContainSecrets: true,
      fields: [{
        name: "target",
        type: "single_select",
        required: true,
        choices: ["safe", "token=MCP-CHOICE-SECRET-11"],
      }],
    })).toThrow("UNSAFE_EXACT_INTERACTION_DISPLAY:mcp_choice");

    expect(() => sanitizeInteractionDisplay({
      kind: "mcp_elicitation",
      summary: "Configure",
      serverName: "server",
      mode: "form",
      url: null,
      mayContainSecrets: true,
      fields: [
        { name: "same", type: "boolean", required: true },
        { name: "same", type: "boolean", required: false },
      ],
    })).toThrow("NON_UNIQUE_EXACT_INTERACTION_DISPLAY:mcp_field_names");
  });
});
