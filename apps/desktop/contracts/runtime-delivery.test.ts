import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  runtimeChatPaneStateChangedEvent,
  runtimeChatPaneUpsertEventOrInvalidation,
  runtimeEventDeliveryClass,
  runtimeEventDeliveryClassByType,
} from "./runtime-delivery";
import {
  runtimeEventSchema,
  runtimeEventUtf8ByteLimit,
  runtimeProtocolVersion,
  type ChatPaneProjection,
} from "./runtime";

const managedWorkspace = {
  mode: "managedWorktree",
  state: "ready",
  revision: 1,
  recoveryKind: null,
} as const;

function pane(responseMarkdown = ""): ChatPaneProjection {
  return {
    id: "pane_delivery01",
    revision: 1,
    title: "Delivery",
    repository: {
      id: "repo_00000000000000000000000000",
      name: "example",
    },
    accountProfileId: null,
    model: "gpt-5.6-sol",
    reasoningEffort: "ultra",
    serviceTier: "standard",
    interactionMode: "chat",
    state: "ready",
    activity: { ordinal: 1, kind: "responseCompleted" },
    workspace: managedWorkspace,
    turn: {
      id: "chatturn_delivery01",
      status: "completed",
      startedAt: "2026-08-03T12:00:00.000Z",
      completedAt: "2026-08-03T12:00:01.000Z",
      continuationCount: 0,
      responseMarkdown: {
        tail: responseMarkdown,
        totalUtf8Bytes: new TextEncoder().encode(responseMarkdown).byteLength,
        truncatedPrefix: false,
      },
      reasoningSummary: { tail: "", totalUtf8Bytes: 0, truncatedPrefix: false },
      tools: [],
    },
    attention: null,
    recoverablePrompt: false,
    harness: null,
  };
}

function zigEventTypes(constant: string): readonly string[] {
  const source = readFileSync(new URL("../src/runtime_host.zig", import.meta.url), "utf8");
  const prefix = `const ${constant} = [_][]const u8{`;
  const start = source.indexOf(prefix);
  const end = start < 0 ? -1 : source.indexOf("\n};", start + prefix.length);
  if (start < 0 || end < 0) {
    throw new Error(`Missing Zig event delivery declaration ${constant}.`);
  }
  const declaration = source.slice(start + prefix.length, end);
  return [...declaration.matchAll(/"([^"]+)"/gu)].map((match) => match[1] ?? "");
}

describe("renderer event delivery classes", () => {
  test("classifies every closed event kind", () => {
    expect(runtimeEventDeliveryClassByType).toEqual({
      "runtime.changed": "state-recoverable",
      "runner.changed": "state-recoverable",
      "account.upserted": "state-recoverable",
      "account.removed": "state-recoverable",
      "chat.pane.upserted": "state-recoverable",
      "chat.pane.stateChanged": "state-recoverable",
      "chat.pane.removed": "state-recoverable",
      "chat.panes.reordered": "state-recoverable",
      "chat.turn.delta": "state-recoverable",
      "accountLocalData.upserted": "state-recoverable",
      "accountLocalData.removed": "state-recoverable",
      "humanAccount.changed": "state-recoverable",
      "sessionSync.statusChanged": "state-recoverable",
      "sessionSync.localGrid.changed": "state-recoverable",
      "sessionSync.remote.upserted": "state-recoverable",
      "sessionSync.remote.removed": "state-recoverable",
      "sessionSync.remote.cleared": "state-recoverable",
      "snapshot.invalidated": "state-recoverable",
      "operation.completed": "transient-exact",
      "task.invalidated": "transient-exact",
    });
    expect(runtimeEventDeliveryClass({
      type: "snapshot.invalidated",
      reason: "projectionOverflow",
    })).toBe("state-recoverable");
  });

  test("stays in exact parity with the Native host classifier", () => {
    const expected = Object.entries(runtimeEventDeliveryClassByType);
    expect(zigEventTypes("state_recoverable_event_types").toSorted()).toEqual(
      expected
        .filter(([, deliveryClass]) => deliveryClass === "state-recoverable")
        .map(([type]) => type)
        .toSorted(),
    );
    expect(zigEventTypes("transient_exact_event_types").toSorted()).toEqual(
      expected
        .filter(([, deliveryClass]) => deliveryClass === "transient-exact")
        .map(([type]) => type)
        .toSorted(),
    );
  });

  test("invalidates oversized recoverable pane state instead of crossing Native limits", () => {
    expect(runtimeChatPaneUpsertEventOrInvalidation(1, pane()).type)
      .toBe("chat.pane.upserted");

    const oversized = pane("x".repeat(8_000));
    expect(runtimeChatPaneUpsertEventOrInvalidation(2, oversized)).toEqual({
      type: "snapshot.invalidated",
      reason: "projectionOverflow",
    });
    expect(() => runtimeEventSchema.parse({
      version: runtimeProtocolVersion,
      sequence: 2,
      event: {
        type: "chat.pane.upserted",
        revision: oversized.revision,
        pane: oversized,
      },
    })).toThrow("runtime event exceeds 7168 UTF-8 bytes");
  });

  test("delivers worst-case lifecycle, attention, and tool state without repeating text tails", () => {
    const responseMarkdown = "private-response-tail".repeat(512);
    const oversized = pane(responseMarkdown);
    const tools = Array.from({ length: 32 }, (_, index) => ({
      id: `chattool_${String(index).padStart(2, "0")}_${"x".repeat(84)}`,
      category: "filesystem" as const,
      status: "completed" as const,
    }));
    const event = runtimeChatPaneStateChangedEvent(Number.MAX_SAFE_INTEGER, {
      ...oversized,
      id: `pane_${"p".repeat(91)}`,
      revision: 2,
      title: "🙂".repeat(80),
      accountProfileId: `acct_${"a".repeat(91)}`,
      state: "attention",
      turn: {
        ...oversized.turn!,
        id: `chatturn_${"t".repeat(87)}`,
        tools,
      },
      attention: {
        code: "all_accounts_exhausted",
        message: "🙂".repeat(120),
        retryable: true,
      },
    });
    const envelope = {
      version: runtimeProtocolVersion,
      sequence: Number.MAX_SAFE_INTEGER,
      event,
    };
    const encoded = JSON.stringify(envelope);

    expect(event.type).toBe("chat.pane.stateChanged");
    expect(encoded).not.toContain("responseMarkdown");
    expect(encoded).not.toContain("reasoningSummary");
    expect(encoded).not.toContain(responseMarkdown);
    expect(new TextEncoder().encode(encoded).byteLength)
      .toBeLessThanOrEqual(runtimeEventUtf8ByteLimit);
    expect(runtimeEventSchema.parse(envelope)).toEqual(envelope);
  });

  test("keeps harness decoration out of ordinary pane lifecycle delivery", () => {
    const base = pane();
    const event = runtimeChatPaneStateChangedEvent(1, {
      ...base,
      harness: {
        revision: 1,
        descendants: {
          count: 1,
          truncated: false,
          children: [{
            id: "hactor_delivery0001",
            revision: 1,
            title: "Delivery child",
            state: "idle",
            openedPaneId: null,
            canOpen: false,
            canMessage: false,
            canStop: true,
          }],
        },
      },
    });

    expect(event.type).toBe("chat.pane.stateChanged");
    if (event.type !== "chat.pane.stateChanged") throw new Error("Expected pane state");
    expect(event.pane.interactionMode).toBe("chat");
    expect(event.pane).not.toHaveProperty("harness");
  });
});
