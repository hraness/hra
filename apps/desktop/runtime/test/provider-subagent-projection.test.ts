import { describe, expect, test } from "bun:test";
import { assertProperty, fc } from "@hra-internal/test";

import {
  MAX_RENDERED_PROVIDER_SUBAGENTS,
  ProviderSubagentInvariantError,
  ProviderSubagentProjectionTracker,
  type ProviderSubagentTurnScope,
} from "../src/sessions/provider-subagent-projection";

const scope: ProviderSubagentTurnScope = Object.freeze({
  accountProfileId: "private-account",
  generation: 9,
  threadId: "private-root-thread",
  turnId: "private-root-turn",
});

function observation(
  agentId: string,
  status: "running" | "starting" | "terminal",
  streamPosition: number,
  factIndex = 0,
) {
  return { ...scope, agentId, status, streamPosition, factIndex };
}

describe("ProviderSubagentProjectionTracker", () => {
  test("deduplicates provider channels into stable opaque semantic rows", () => {
    const tracker = new ProviderSubagentProjectionTracker();
    tracker.beginTurn(scope);
    expect(tracker.observe(observation("raw-agent-thread-a", "starting", 1))).toBeTrue();
    const starting = tracker.snapshot(scope);
    expect(starting).toEqual({
      agents: [{
        id: "provideragent_0000000001",
        label: "Agent 1",
        status: "starting",
      }],
      overflowCount: 0,
    });
    expect(tracker.observe(observation("raw-agent-thread-a", "running", 2))).toBeTrue();
    expect(tracker.observe(observation("raw-agent-thread-a", "running", 2))).toBeFalse();
    expect(tracker.snapshot(scope)).toEqual({
      agents: [{
        id: starting.agents[0]!.id,
        label: "Agent 1",
        status: "running",
      }],
      overflowCount: 0,
    });
    expect(JSON.stringify(tracker.snapshot(scope))).not.toContain("raw-agent-thread-a");
    expect(JSON.stringify(tracker.snapshot(scope))).not.toContain(scope.accountProfileId);
    expect(JSON.stringify(tracker.snapshot(scope))).not.toContain(scope.threadId);
    expect(JSON.stringify(tracker.snapshot(scope))).not.toContain(scope.turnId);
  });

  test("accepts multiple raw agents at one positioned parent fact", () => {
    const tracker = new ProviderSubagentProjectionTracker();
    expect(tracker.observe(observation("raw-agent-a", "starting", 1, 0))).toBeTrue();
    expect(tracker.observe(observation("raw-agent-b", "running", 1, 0))).toBeTrue();
    expect(tracker.snapshot(scope)).toMatchObject({
      agents: [
        { label: "Agent 1", status: "starting" },
        { label: "Agent 2", status: "running" },
      ],
      overflowCount: 0,
    });
  });

  test("makes terminal status absorbing against late nonterminal observations", () => {
    const tracker = new ProviderSubagentProjectionTracker();
    tracker.observe(observation("raw-agent", "running", 1));
    tracker.observe(observation("raw-agent", "terminal", 2));
    expect(tracker.snapshot(scope)).toEqual({ agents: [], overflowCount: 0 });
    expect(tracker.observe(observation("raw-agent", "starting", 3))).toBeFalse();
    expect(tracker.observe(observation("raw-agent", "running", 4))).toBeFalse();
    expect(tracker.snapshot(scope)).toEqual({ agents: [], overflowCount: 0 });
  });

  test("bounds output with exact overflow while preserving first-seen order", () => {
    const tracker = new ProviderSubagentProjectionTracker();
    const total = MAX_RENDERED_PROVIDER_SUBAGENTS + 5;
    for (let index = 0; index < total; index += 1) {
      tracker.observe(observation(`raw-agent-${index}`, "running", index + 1));
    }
    const projected = tracker.snapshot(scope);
    expect(projected.agents).toHaveLength(MAX_RENDERED_PROVIDER_SUBAGENTS);
    expect(projected.agents.map(({ label }) => label)).toEqual(
      Array.from({ length: MAX_RENDERED_PROVIDER_SUBAGENTS }, (_, index) =>
        `Agent ${index + 1}`
      ),
    );
    expect(projected.overflowCount).toBe(5);
  });

  test("generation, parent-turn, terminal, and privacy cuts drop all active rows", () => {
    const tracker = new ProviderSubagentProjectionTracker();
    tracker.observe(observation("raw-agent", "running", 1));
    const nextTurn = { ...scope, turnId: "private-next-root-turn" };
    tracker.beginTurn(nextTurn);
    expect(tracker.snapshot(scope)).toEqual({ agents: [], overflowCount: 0 });
    tracker.observe({
      ...nextTurn,
      agentId: "raw-agent-next",
      status: "running",
      streamPosition: 2,
      factIndex: 0,
    });
    expect(tracker.completeTurn(nextTurn)).toBeTrue();
    expect(tracker.snapshot(nextTurn)).toEqual({ agents: [], overflowCount: 0 });

    tracker.observe(observation("raw-agent", "running", 3));
    const priorOpaqueId = tracker.snapshot(scope).agents[0]!.id;
    tracker.advanceGeneration(scope.accountProfileId, scope.generation + 1);
    expect(tracker.trackedTurnCount).toBe(0);
    expect(tracker.observe(observation("stale-agent", "running", 4))).toBeFalse();

    const currentScope = { ...scope, generation: scope.generation + 1 };
    tracker.observe({
      ...currentScope,
      agentId: "current-agent",
      status: "running",
      streamPosition: 1,
      factIndex: 0,
    });
    expect(tracker.snapshot(currentScope).agents[0]!.id).not.toBe(priorOpaqueId);
    tracker.purgeAccount(scope.accountProfileId);
    expect(tracker.trackedTurnCount).toBe(0);
  });

  test("rejects a changed replay and positioned regression", () => {
    const changed = new ProviderSubagentProjectionTracker();
    changed.observe(observation("raw-agent", "starting", 1));
    expect(() => changed.observe(observation("raw-agent", "running", 1)))
      .toThrow(ProviderSubagentInvariantError);

    const regressed = new ProviderSubagentProjectionTracker();
    regressed.observe(observation("raw-agent", "running", 2));
    expect(() => regressed.observe(observation("raw-other", "running", 1)))
      .toThrow(ProviderSubagentInvariantError);
  });

  test("arbitrary status updates never change identity, label, or order", () => {
    assertProperty(fc.property(
      fc.integer({ min: 1, max: MAX_RENDERED_PROVIDER_SUBAGENTS + 6 }),
      fc.array(fc.constantFrom("starting" as const, "running" as const), {
        minLength: 1,
        maxLength: 20,
      }),
      (agentCount, statuses) => {
        const tracker = new ProviderSubagentProjectionTracker();
        let position = 1;
        for (let index = 0; index < agentCount; index += 1) {
          tracker.observe(observation(`raw-${index}`, "starting", position++));
        }
        const initial = tracker.snapshot(scope).agents.map(({ id, label }) => ({ id, label }));
        for (let index = 0; index < statuses.length; index += 1) {
          tracker.observe(observation(
            `raw-${index % agentCount}`,
            statuses[index]!,
            position++,
          ));
        }
        expect(tracker.snapshot(scope).agents.map(({ id, label }) => ({ id, label })))
          .toEqual(initial);
      },
    ));
  });
});
