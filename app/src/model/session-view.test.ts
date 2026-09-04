import { describe, expect, test } from "bun:test";

import type { CompactInteractionKind, SessionStateValue } from "../hra/cloud";
import {
  formatDuration,
  interactionAffordance,
  interactionKindLabel,
  interactionIsLocalOnly,
  isIdleSession,
  orderSessionCards,
  resolveComposerTarget,
  sessionStateLabel,
  sessionStateTone,
  shortSessionLabel,
  subagentChipCharacters,
  subagentChips,
  turnSummaryLine,
  type SessionCardSummary,
  type SubagentChipInput,
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

describe("orderSessionCards with a manual arrangement", () => {
  test("an empty arrangement orders exactly as the automatic ladder does", () => {
    const summaries = [
      card("done-old", { lastActivityAt: 10 }),
      card("working", { lastActivityAt: 20, state: "working" }),
      card("attention", { attention: true, lastActivityAt: 1, state: "needs_answer" }),
      card("done-new", { lastActivityAt: 30 }),
    ];
    expect(orderSessionCards(summaries, []).map((entry) => entry.publicId))
      .toEqual(orderSessionCards(summaries).map((entry) => entry.publicId));
  });

  test("the arrangement decides the order, not the activity", () => {
    const ordered = orderSessionCards(
      [
        card("a", { lastActivityAt: 1 }),
        card("b", { lastActivityAt: 100, state: "working" }),
        card("c", { lastActivityAt: 50 }),
      ],
      ["c", "a", "b"],
    );
    expect(ordered.map((entry) => entry.publicId)).toEqual(["c", "a", "b"]);
  });

  test("an attention card still floats to the front of an arrangement", () => {
    const ordered = orderSessionCards(
      [
        card("first", { lastActivityAt: 9 }),
        card("second", { lastActivityAt: 8 }),
        card("asking", { attention: true, lastActivityAt: 1, state: "needs_approval" }),
      ],
      ["first", "second", "asking"],
    );
    expect(ordered.map((entry) => entry.publicId)).toEqual(["asking", "first", "second"]);
  });

  test("an arranged card takes its place back when the question is answered", () => {
    const arrangement = ["first", "second", "third"];
    const asking = orderSessionCards(
      [
        card("first"),
        card("second", { attention: true, state: "needs_answer" }),
        card("third"),
      ],
      arrangement,
    );
    expect(asking.map((entry) => entry.publicId)).toEqual(["second", "first", "third"]);
    const answered = orderSessionCards(
      [card("first"), card("second"), card("third")],
      arrangement,
    );
    expect(answered.map((entry) => entry.publicId)).toEqual(arrangement);
  });

  test("a card the arrangement does not name falls in behind every card it does", () => {
    const ordered = orderSessionCards(
      [
        card("new", { lastActivityAt: 999, state: "working" }),
        card("placed", { lastActivityAt: 1 }),
      ],
      ["placed"],
    );
    expect(ordered.map((entry) => entry.publicId)).toEqual(["placed", "new"]);
  });

  test("unnamed cards keep the automatic ladder among themselves", () => {
    const ordered = orderSessionCards(
      [
        card("idle-new", { lastActivityAt: 30 }),
        card("working-old", { lastActivityAt: 5, state: "working" }),
        card("placed", { lastActivityAt: 1 }),
      ],
      ["placed"],
    );
    expect(ordered.map((entry) => entry.publicId)).toEqual(["placed", "working-old", "idle-new"]);
  });

  test("an arrangement naming sessions that are gone changes nothing for the rest", () => {
    const ordered = orderSessionCards(
      [card("a", { lastActivityAt: 1 }), card("b", { lastActivityAt: 2 })],
      ["ghost", "b", "a"],
    );
    expect(ordered.map((entry) => entry.publicId)).toEqual(["b", "a"]);
  });

  test("an arranged archived session still leaves the grid", () => {
    const ordered = orderSessionCards(
      [card("kept"), card("gone", { archived: true })],
      ["gone", "kept"],
    );
    expect(ordered.map((entry) => entry.publicId)).toEqual(["kept"]);
  });
});

describe("subagentChips", () => {
  const agent = (
    agentId: string,
    overrides: Partial<SubagentChipInput> = {},
  ): SubagentChipInput => ({
    agentId,
    depth: 1,
    nickname: null,
    role: null,
    ...overrides,
  });

  test("a session with no subagents gets nothing", () => {
    expect(subagentChips([])).toEqual({ chips: [], overflow: 0 });
  });

  test("the face is the nickname, then the role, then an opaque short id", () => {
    const { chips } = subagentChips([
      agent("aaaaaaaaaaaa", { nickname: "Scout", role: "reviewer" }),
      agent("bbbbbbbbbbbb", { role: "reviewer" }),
      agent("cccccccccccc"),
    ]);
    expect(chips.map((chip) => chip.label)).toEqual(["Agent cccccc", "Scout", "reviewer"]);
  });

  test("the detail line carries the role and the depth", () => {
    const { chips } = subagentChips([agent("a", { depth: 2, role: "reviewer" })]);
    expect(chips[0]?.detail).toBe("reviewer · depth 2");
  });

  test("an unreported role or depth says so rather than inventing one", () => {
    const { chips } = subagentChips([agent("a", { depth: null })]);
    expect(chips[0]?.detail).toBe("No role reported · depth unknown");
  });

  test("shows three and counts the rest", () => {
    const set = subagentChips([
      agent("a", { nickname: "one" }),
      agent("b", { nickname: "two" }),
      agent("c", { nickname: "three" }),
      agent("d", { nickname: "four" }),
      agent("e", { nickname: "five" }),
    ]);
    expect(set.chips.length).toBe(3);
    expect(set.overflow).toBe(2);
  });

  test("orders shallowest first so a repainting card does not reshuffle", () => {
    const input = [
      agent("a", { depth: 3, nickname: "deep" }),
      agent("b", { depth: null, nickname: "unknown" }),
      agent("c", { depth: 1, nickname: "shallow" }),
    ];
    const first = subagentChips(input).chips.map((chip) => chip.label);
    const second = subagentChips([...input].reverse()).chips.map((chip) => chip.label);
    expect(first).toEqual(["shallow", "deep", "unknown"]);
    expect(second).toEqual(first);
  });

  test("a long face is clamped", () => {
    const { chips } = subagentChips([agent("a", { nickname: "n".repeat(80) })]);
    expect(chips[0]?.label.length).toBe(subagentChipCharacters);
    expect(chips[0]?.label.endsWith("…")).toBe(true);
  });

  test("leaves the input array untouched", () => {
    const input = [agent("b", { depth: 2 }), agent("a", { depth: 1 })];
    subagentChips(input);
    expect(input.map((entry) => entry.agentId)).toEqual(["b", "a"]);
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
  const pending = (
    overrides: Partial<Parameters<typeof interactionAffordance>[0]> = {},
  ): Parameters<typeof interactionAffordance>[0] => ({
    availableDecisions: null,
    commandClass: null,
    interactionKind: "command_approval",
    questions: null,
    ...overrides,
  });

  test("every kind has a label and a derivable affordance", () => {
    for (const interactionKind of allInteractionKinds) {
      expect(interactionKindLabel[interactionKind].length).toBeGreaterThan(0);
      const affordance = interactionAffordance(pending({ interactionKind }));
      expect(affordance.decisions).toEqual([]);
      expect(affordance.answerable).toEqual([]);
    }
  });

  test("an interaction projected without detail offers nothing and says so", () => {
    for (const interactionKind of allInteractionKinds) {
      const affordance = interactionAffordance(pending({ interactionKind }));
      expect(interactionIsLocalOnly(affordance)).toBe(true);
      expect(affordance.reasons.length).toBeGreaterThan(0);
    }
  });

  test("a command approval offers approve only with a class the daemon can re-verify", () => {
    expect(interactionAffordance(pending({
      availableDecisions: ["once", "decline"],
      commandClass: "git commit",
    })).decisions).toEqual(["once", "decline"]);
    const classless = interactionAffordance(pending({
      availableDecisions: ["once", "decline"],
    }));
    expect(classless.decisions).toEqual(["decline"]);
    expect(classless.reasons.join(" ")).toContain("command class");
  });

  test("a decision the provider did not offer never becomes a button", () => {
    expect(interactionAffordance(pending({
      availableDecisions: ["decline"],
      commandClass: "bun test",
    })).decisions).toEqual(["decline"]);
  });

  test("a file change approval may only be declined from a browser", () => {
    const affordance = interactionAffordance(pending({
      availableDecisions: ["once", "decline"],
      commandClass: "unused",
      interactionKind: "file_change_approval",
    }));
    expect(affordance.decisions).toEqual(["decline"]);
    expect(affordance.reasons.join(" ")).toContain("exact diff");
  });

  test("a permission approval is decidable only with a workspace class", () => {
    expect(interactionAffordance(pending({
      availableDecisions: ["once", "decline"],
      commandClass: "permission:workspace",
      interactionKind: "permission_approval",
    })).decisions).toEqual(["once", "decline"]);
    const external = interactionAffordance(pending({
      availableDecisions: ["once", "decline"],
      interactionKind: "permission_approval",
    }));
    expect(external.decisions).toEqual([]);
    expect(interactionIsLocalOnly(external)).toBe(true);
  });

  test("a secret question is listed and never becomes an answer id", () => {
    const questions = [
      { id: "where", label: "Where", secret: false },
      { id: "token", label: "Token", secret: true },
    ] as const;
    // A provider question set is answered whole, so one protected answer
    // sends the whole question to the machine.
    const asked = interactionAffordance(pending({ interactionKind: "user_input", questions }));
    expect(asked.answerable).toEqual([]);
    expect(asked.locked.map((question) => question.id)).toEqual(["token"]);
    expect(interactionIsLocalOnly(asked)).toBe(true);
    expect(asked.reasons.length).toBeGreaterThan(0);

    // An MCP form leaves out what it cannot carry, so its text fields stay
    // answerable while the protected ones are never offered.
    const form = interactionAffordance(pending({
      interactionKind: "mcp_elicitation",
      questions,
    }));
    expect(form.answerable.map((question) => question.id)).toEqual(["where"]);
    expect(form.decisions).toEqual([]);
  });

  test("a question set that is entirely secret leaves nothing to answer", () => {
    const affordance = interactionAffordance(pending({
      interactionKind: "user_input",
      questions: [{ id: "token", label: "Token", secret: true }],
    }));
    expect(interactionIsLocalOnly(affordance)).toBe(true);
    expect(affordance.reasons.length).toBeGreaterThan(0);
  });

  test("an approval kind never gains an answer field from a stray question list", () => {
    const affordance = interactionAffordance(pending({
      availableDecisions: ["decline"],
      interactionKind: "file_change_approval",
      questions: [{ id: "where", label: "Where", secret: false }],
    }));
    expect(affordance.answerable).toEqual([]);
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
