import { describe, expect, test } from "bun:test";

import { createHRADirectRuntime } from "./runtime";

describe("HRA Direct attention projection", () => {
  test("uses the real bridge and shell for pathless local and aggregate task attention", async () => {
    const runtime = createHRADirectRuntime({
      kind: "scenario",
      scenario: "attention-mission-control",
    });
    try {
      await runtime.shell.connect();
      const response = await runtime.shell.dispatch({ type: "observation.attention.list" });
      expect(response).toMatchObject({
        ok: true,
        result: {
          type: "attentionProjection",
          projection: { completeness: "complete" },
        },
      });
      if (!response.ok || response.result.type !== "attentionProjection") {
        throw new Error("Direct did not return the canonical attention projection.");
      }
      expect(response.result.projection.items).toEqual([{
        source: "pane",
        paneId: "pane_missioncontrol",
        title: "Release delivery",
        repositoryName: "hra",
        reason: { kind: "ambiguous_delivery" },
      }, {
        source: "workspace",
        workspaceId: "wsp_00000000000000000000000000",
        name: "Local hra",
        reason: "task_attention",
        count: { capped: false, value: 2 },
      }, {
        source: "workspace",
        workspaceId: "wsp_00000000000000000000000000",
        name: "Local hra",
        reason: "task_review",
        count: { capped: false, value: 1 },
      }]);
      const serialized = JSON.stringify(response.result.projection);
      expect(serialized).not.toContain("Private queued text");
      expect(serialized).not.toContain("chatmsg_missioncontrol");
      expect(serialized).not.toContain("/Users/");
    } finally {
      runtime.dispose();
    }
  });
});
