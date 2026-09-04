import { describe, expect, test } from "bun:test";

import type { CompactInteractionKind, SessionStateValue } from "../hra/cloud";
import {
  formatDuration,
  interactionAffordance,
  interactionKindLabel,
  interactionRestriction,
  isIdleSession,
  orderSessionCards,
  resolveComposerTarget,
  sessionStateLabel,
  sessionStateTone,
  shortSessionLabel,
  turnSummaryLine,
  type SessionCardSummary,
} from "./session-view";

const allStates: readonly SessionStateValue[] = [
  "working",
  "needs_approval",
  "needs_answer",
  "needs_action",
  "done",
  "done_followups",
  "done_caveats",
  "aborted",
];

const allInteractionKinds: readonly CompactInteractionKind[] = [
  "command_approval",
  "file_change_approval",
  "permission_approval",
  "user_input",
  "mcp_elicitation",
];

function card(
  publicId: string,
  overrides: Partial<SessionCardSummary> = {},
): SessionCardSummary {
  return {
    archived: false,
    attention: false,
    lastActivityAt: 0,
    metadataRevision: 1,
    publicId,
    state: "done",
    title: publicId,
    ...overrides,
  };
}

describe("state presentation", () => {
  test("every state has a label and a tone", () => {
    for (const state of allStates) {
      expect(sessionStateLabel[state].length).toBeGreaterThan(0);
      expect(sessionStateTone[state]).toBeDefined();
    }
  });

  test("the three attention states are toned as attention", () => {
    expect(sessionStateTone.needs_approval).toBe("attention");
    expect(sessionStateTone.needs_answer).toBe("attention");
    expect(sessionStateTone.needs_action).toBe("attention");
  });
});

describe("orderSessionCards", () => {
  test("attention first, then working, then the rest", () => {
    const ordered = orderSessionCards([
      card("done-old", { lastActivityAt: 10 }),
      card("working", { lastActivityAt: 20, state: "working" }),
      card("attention", { attention: true, lastActivityAt: 1, state: "needs_answer" }),
      card("done-new", { lastActivityAt: 30 }),
    ]);
    expect(ordered.map((entry) => entry.publicId))
      .toEqual(["attention", "working", "done-new", "done-old"]);
  });

  test("orders inside a group by last activity, newest first", () => {
    const ordered = orderSessionCards([
      card("a", { attention: true, lastActivityAt: 5, state: "needs_approval" }),
      card("b", { attention: true, lastActivityAt: 50, state: "needs_action" }),
      card("c", { attention: true, lastActivityAt: 25, state: "needs_answer" }),
    ]);
    expect(ordered.map((entry) => entry.publicId)).toEqual(["b", "c", "a"]);
  });

  test("breaks a timestamp tie on the public id so the order is stable", () => {
    const first = orderSessionCards([card("zeta"), card("alpha")]);
    const second = orderSessionCards([card("alpha"), card("zeta")]);
    expect(first.map((entry) => entry.publicId)).toEqual(["alpha", "zeta"]);
    expect(second.map((entry) => entry.publicId)).toEqual(["alpha", "zeta"]);
  });

  test("hides archived sessions", () => {
    const ordered = orderSessionCards([
      card("kept", { lastActivityAt: 1 }),
      card("gone", { archived: true, attention: true, lastActivityAt: 99 }),
    ]);
    expect(ordered.map((entry) => entry.publicId)).toEqual(["kept"]);
  });

  test("an attention card that is also working still sorts first", () => {
    const ordered = orderSessionCards([
      card("plain-working", { lastActivityAt: 99, state: "working" }),
      card("asking", { attention: true, lastActivityAt: 1, state: "needs_approval" }),
    ]);
    expect(ordered[0]?.publicId).toBe("asking");
  });

  test("leaves the input array untouched", () => {
    const input = [card("b", { lastActivityAt: 1 }), card("a", { lastActivityAt: 2 })];
    orderSessionCards(input);
    expect(input.map((entry) => entry.publicId)).toEqual(["b", "a"]);
  });
});

describe("resolveComposerTarget", () => {
  const summaries = [
    card("idle-selected", { lastActivityAt: 1, state: "done" }),
    card("busy-selected", { lastActivityAt: 2, state: "working" }),
    card("freshest", { lastActivityAt: 100, state: "working" }),
  ];

  test("sends to the selected session when it is idle", () => {
    expect(resolveComposerTarget(summaries, "idle-selected")?.publicId).toBe("idle-selected");
  });

  test("falls back to the most recently active session when the selection is working", () => {
    expect(resolveComposerTarget(summaries, "busy-selected")?.publicId).toBe("freshest");
  });

  test("falls back to the most recently active session when nothing is selected", () => {
    expect(resolveComposerTarget(summaries, null)?.publicId).toBe("freshest");
  });

  test("ignores a selection that is not on the page", () => {
    expect(resolveComposerTarget(summaries, "missing")?.publicId).toBe("freshest");
  });

  test("never targets an archived session", () => {
    const archivedOnly = [card("hidden", { archived: true, lastActivityAt: 500 })];
    expect(resolveComposerTarget(archivedOnly, "hidden")).toBeNull();
  });

  test("returns null when there is nothing to send to", () => {
    expect(resolveComposerTarget([], "anything")).toBeNull();
  });
});

describe("isIdleSession", () => {
  test("the four terminal states are idle and the rest are not", () => {
    expect(allStates.filter(isIdleSession))
      .toEqual(["done", "done_followups", "done_caveats", "aborted"]);
  });
});

describe("interaction affordances", () => {
  test("every kind has a label and an affordance", () => {
    for (const kind of allInteractionKinds) {
      expect(interactionKindLabel[kind].length).toBeGreaterThan(0);
      expect(interactionAffordance(kind).kind).toBeDefined();
    }
  });

  test("only a command approval offers an approve button", () => {
    const approving = allInteractionKinds
      .filter((kind) => interactionAffordance(kind).kind === "approve_or_decline");
    expect(approving).toEqual(["command_approval"]);
  });

  test("a file change approval may only be declined from a browser", () => {
    expect(interactionAffordance("file_change_approval")).toEqual({ kind: "decline_only" });
  });

  test("permission requests and MCP forms stay on the machine", () => {
    expect(interactionAffordance("permission_approval")).toEqual({ kind: "local_only" });
    expect(interactionAffordance("mcp_elicitation")).toEqual({ kind: "local_only" });
  });

  test("answers are offered for user input alone", () => {
    const answerable = allInteractionKinds
      .filter((kind) => interactionAffordance(kind).kind === "answers");
    expect(answerable).toEqual(["user_input"]);
  });

  test("every withheld affordance states a reason", () => {
    for (const kind of allInteractionKinds) {
      const restriction = interactionRestriction(kind);
      if (interactionAffordance(kind).kind === "approve_or_decline") {
        expect(restriction).toBeNull();
      } else {
        expect(restriction?.length ?? 0).toBeGreaterThan(0);
      }
    }
  });
});

describe("turn summary line", () => {
  test("counts files, names git actions, and states the runtime", () => {
    expect(turnSummaryLine({ filesTouched: 3, gitActions: ["commit"], runtimeMs: 4_200 }))
      .toBe("3 files · commit · 4s");
  });

  test("uses the singular for one file and omits an empty git list", () => {
    expect(turnSummaryLine({ filesTouched: 1, gitActions: [], runtimeMs: 500 }))
      .toBe("1 file · 1s");
  });
});

describe("formatDuration", () => {
  test("scales from seconds to hours", () => {
    expect(formatDuration(0)).toBe("0s");
    expect(formatDuration(59_000)).toBe("59s");
    expect(formatDuration(90_000)).toBe("1m 30s");
    expect(formatDuration(3_930_000)).toBe("1h 5m");
  });

  test("refuses a value that is not a duration", () => {
    expect(formatDuration(Number.NaN)).toBe("unknown");
    expect(formatDuration(-1)).toBe("unknown");
  });
});

describe("shortSessionLabel", () => {
  test("is bounded and derived from the public id", () => {
    expect(shortSessionLabel("0199aaaabbbbccccdddd")).toBe("Session 0199aaaa");
  });
});
