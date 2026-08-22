import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import type { RuntimeAttentionProjection } from "../../../../contracts/runtime";
import {
  AttentionDrawerPanel,
  dispatchWorkspaceSetupApproval,
  presentAttentionItem,
  workspaceSetupApprovalCommand,
} from "./AttentionDrawer";

const setupRequestId = `wssetup_${"a".repeat(32)}`;
const recipeDigest = "b".repeat(64);
const setupReason = {
  kind: "workspace_setup_approval_required" as const,
  setupRequestId,
  recipeDigest,
  setupRevision: 7,
};
const projection: RuntimeAttentionProjection = {
  version: 1,
  completeness: "cloud_unavailable",
  items: [{
    source: "pane",
    paneId: "pane_attention0001",
    title: "Release audit",
    repositoryName: "hra",
    reason: setupReason,
  }, {
    source: "workspace",
    workspaceId: "wsp_00000000000000000000000000",
    name: "Local HRA",
    reason: "task_review",
    count: { value: 2, capped: false },
  }],
};

describe("attention drawer", () => {
  test("groups a partial pathless projection into semantic recovery work", () => {
    const html = renderToStaticMarkup(createElement(AttentionDrawerPanel, {
      approvalErrorRequestId: null,
      approvingSetupRequestId: null,
      loadState: "ready",
      onApproveSetup: () => undefined,
      onClose: () => undefined,
      onRefresh: () => undefined,
      panelId: "attention-panel",
      projection,
      titleId: "attention-title",
    }));
    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-labelledby="attention-title"');
    expect(html).toContain("Needs you");
    expect(html).toContain("Review");
    expect(html).toContain("Approve locked Bun install (scripts disabled)");
    expect(html).toContain("Approve locked Bun install for Release audit");
    expect(html).toContain("2 tasks are ready for review");
    expect(html).toContain("Cloud task status is unavailable");
    expect(html).not.toContain(setupRequestId);
    expect(html).not.toContain(recipeDigest);
    expect(html).not.toContain("/Users/");
    expect(html).not.toContain("providerSession");
  });

  test("maps setup approval only from opaque identity and its exact CAS revision", () => {
    expect(workspaceSetupApprovalCommand(setupReason)).toEqual({
      type: "workspace.setup.approve",
      setupRequestId,
      recipeDigest,
      expectedSetupRevision: 7,
    });
  });

  test("dispatches the exact setup approval and correlates its opaque result", async () => {
    const commands: unknown[] = [];
    await dispatchWorkspaceSetupApproval({
      dispatch: (command) => {
        commands.push(command);
        return Promise.resolve({
          version: 3,
          operationId: "op_attentionapproval0001",
          ok: true,
          result: {
            type: "workspaceSetupApproval",
            setupRequestId,
            recipeDigest,
            revision: 8,
            changed: true,
          },
        });
      },
    }, setupReason);
    expect(commands).toEqual([{
      type: "workspace.setup.approve",
      setupRequestId,
      recipeDigest,
      expectedSetupRevision: 7,
    }]);
  });

  test("keeps complete empty attention quiet and explicit", () => {
    const html = renderToStaticMarkup(createElement(AttentionDrawerPanel, {
      approvalErrorRequestId: null,
      approvingSetupRequestId: null,
      loadState: "ready",
      onApproveSetup: () => undefined,
      onClose: () => undefined,
      onRefresh: () => undefined,
      panelId: "attention-panel",
      projection: { version: 1, completeness: "complete", items: [] },
      titleId: "attention-title",
    }));
    expect(html).toContain("Nothing needs your attention.");
    expect(html).not.toContain("Local attention is");
  });

  test("presents only closed reason language", () => {
    expect(presentAttentionItem({
      source: "pane",
      paneId: "pane_attention0001",
      title: "Release audit",
      repositoryName: "hra",
      reason: {
        kind: "workspace_setup_failed",
        setupRequestId,
        recipeDigest,
        setupRevision: 7,
        setupOutcome: "timeout",
      },
    }).label).toBe("Workspace setup timed out");
    expect(presentAttentionItem({
      source: "pane",
      paneId: "pane_attention0001",
      title: "Release audit",
      repositoryName: "hra",
      reason: {
        kind: "workspace_setup_failed",
        setupRequestId,
        recipeDigest,
        setupRevision: 1,
        setupOutcome: "clean_replacement_required",
      },
    }).label).toBe(
      "Replace this pane with a clean managed workspace. Setup will not retry",
    );
    expect(presentAttentionItem({
      source: "system",
      reason: "scheduled_chat_recovery",
    }).label).toBe("A scheduled chat needs recovery");
  });

  test("prescribes clean replacement for ambiguity without offering a retry", () => {
    const ambiguousProjection: RuntimeAttentionProjection = {
      version: 1,
      completeness: "complete",
      items: [{
        source: "pane",
        paneId: "pane_attention0001",
        title: "Release audit",
        repositoryName: "hra",
        reason: {
          kind: "workspace_setup_ambiguous",
          setupRequestId,
          recipeDigest,
          setupRevision: 4,
        },
      }],
    };
    const html = renderToStaticMarkup(createElement(AttentionDrawerPanel, {
      approvalErrorRequestId: null,
      approvingSetupRequestId: null,
      loadState: "ready",
      onApproveSetup: () => undefined,
      onClose: () => undefined,
      onRefresh: () => undefined,
      panelId: "attention-panel",
      projection: ambiguousProjection,
      titleId: "attention-title",
    }));
    expect(html).toContain(
      "Replace this pane with a clean managed workspace. Setup will not retry",
    );
    expect(html).not.toContain(">Approve<");
    expect(html).not.toContain(">Retry<");
  });
});
