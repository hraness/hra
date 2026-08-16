import { describe, expect, test } from "bun:test";

import {
  agentTasksDirectDefinition,
  agentTasksScenarioMetadata,
} from "./scenarios";
import { AGENT_TASKS_DIRECT_TIME, parseAgentTasksDirectWorld } from "./world";

const expectedScenarioIds = [
  "tasks-empty-ready",
  "tasks-query-failed",
  "tasks-rich-review",
  "runner-offline",
  "runner-heartbeat-expired",
  "runner-run-streaming",
  "runner-blocked-account",
  "runner-blocked-credential",
  "runner-ready",
  "runner-draining",
  "tasks-readiness-race",
  "runner-worktree-failed",
  "runner-start-ambiguous",
  "runner-waiting-approval",
  "runner-waiting-question",
  "runner-input-changed",
  "runner-run-submitted",
  "runner-queued-cancel",
  "runner-failed-retry",
  "runner-cancelled-retry",
  "runner-ambiguous-resolve",
  "tasks-review-rejected",
  "tasks-review-conflict",
  "tasks-review-observer",
  "tasks-viewer-read-only",
  "tasks-expired-claim",
  "tasks-create-success",
  "tasks-create-pending-isolation",
  "tasks-pagination-scope",
] as const;

const expectedCoverageKeys = [
  "tasks.read.states",
  "tasks.detail.auditability",
  "tasks.identity.presentation",
  "tasks.recovery.presentation",
  "tasks.responsive.accessibility",
  "tasks.network.containment",
  "tasks.review.command",
  "tasks.review.four-eyes",
  "tasks.capability.enforcement",
  "tasks.create.command",
  "tasks.pagination.realtime",
  "runner.presence.presentation",
  "runner.lifecycle.presentation",
  "runner.hitl.response",
  "runner.dispatch.readiness",
  "runner.recovery.commands",
  "auth.workos-session",
  "auth.organization-switch",
  "convex.realtime-subscriptions",
  "convex.command-semantics",
  "configuration.next-runtime",
] as const;

const {
  coverage: agentTasksCoverageCatalog,
  scenarios: agentTasksScenarioCatalog,
} = agentTasksDirectDefinition;

describe("Agent Tasks Direct catalogs", () => {
  test("keeps the complete stable, strict dispatch-state scenario matrix", () => {
    const scenarios = agentTasksScenarioCatalog.list();
    expect(scenarios.map(({ id }) => String(id))).toEqual([...expectedScenarioIds]);
    expect(new Set(scenarios.map(({ id }) => id)).size).toBe(scenarios.length);
    expect(Object.keys(agentTasksScenarioMetadata)).toEqual([...expectedScenarioIds]);
    for (const scenario of scenarios) {
      expect(scenario.route).toBe("/");
      expect(scenario.title.trim()).not.toBe("");
      expect(scenario.description?.trim() ?? "").not.toBe("");
      expect(scenario.runtime).toMatchObject({
        schema: "direct.runtime/v1",
        nowMs: AGENT_TASKS_DIRECT_TIME,
        nextOperation: 1,
      });
      expect(parseAgentTasksDirectWorld(scenario.world)).toEqual(scenario.world);
      const metadata = agentTasksScenarioMetadata[String(scenario.id)];
      if (metadata === undefined) throw new Error(`Missing metadata for ${scenario.id}.`);
      expect(["compact", "stacked", "wide"]).toContain(metadata.viewport);
    }
  });

  test("keeps exact proof modes and cites every fixture scenario", () => {
    expect(agentTasksCoverageCatalog.keys().map(String)).toEqual([...expectedCoverageKeys]);
    expect(agentTasksCoverageCatalog.requireExactKeys(expectedCoverageKeys)).toEqual({
      ok: true,
      value: true,
    });
    const cited = new Set<string>();
    for (const entry of agentTasksCoverageCatalog.list()) {
      if (entry.mode === "direct") {
        expect(entry.scenarios).toEqual([]);
      } else {
        expect(entry.scenarios.length).toBeGreaterThan(0);
      }
      for (const scenario of entry.scenarios) cited.add(String(scenario));
    }
    expect(expectedScenarioIds.filter((id) => !cited.has(id))).toEqual([]);
    expect(agentTasksCoverageCatalog.list().map(({ mode }) => mode)).toContain("fixture");
    expect(agentTasksCoverageCatalog.list().map(({ mode }) => mode)).toContain("mixed");
    expect(agentTasksCoverageCatalog.list().map(({ mode }) => mode)).toContain("direct");
  });
});
