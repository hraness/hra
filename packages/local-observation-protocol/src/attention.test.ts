import { describe, expect, test } from "bun:test";

import {
  attentionGroup,
  attentionItemKey,
  attentionProjectionSchema,
  canonicalAttentionProjection,
  compareAttentionItems,
  type AttentionItem,
} from "./attention";

const pane = {
  source: "pane" as const,
  paneId: "pane_attention0001",
  title: "Release audit",
  repositoryName: "hra",
  reason: { kind: "ambiguous_delivery" as const },
};
const workspace = {
  source: "workspace" as const,
  workspaceId: "wsp_00000000000000000000000000",
  name: "HRA",
  reason: "task_review" as const,
  count: { value: 2, capped: false },
};

describe("local attention projection", () => {
  test("derives stable keys and presentation groups without redundant labels", () => {
    expect(attentionItemKey(pane)).toBe("pane:pane_attention0001");
    expect(attentionGroup(pane)).toBe("recovery");
    expect(attentionItemKey(workspace)).toBe(
      "workspace:wsp_00000000000000000000000000:task_review",
    );
    expect(attentionGroup(workspace)).toBe("review");
  });

  test("requires unique canonically ordered items", () => {
    const account: AttentionItem = {
      source: "account",
      accountProfileId: "acct_attention0001",
      label: "Work",
      reason: "expired",
    };
    const items = [workspace, account, pane].sort(compareAttentionItems);
    expect(canonicalAttentionProjection({
      version: 1,
      completeness: "complete",
      items,
    }).items).toEqual([pane, account, workspace]);
    expect(attentionProjectionSchema.safeParse({
      version: 1,
      completeness: "complete",
      items: [workspace, pane],
    }).success).toBeFalse();
    expect(attentionProjectionSchema.safeParse({
      version: 1,
      completeness: "complete",
      items: [pane, pane],
    }).success).toBeFalse();
  });

  test("rejects zero aggregate rows, unknown fields, paths, and content", () => {
    expect(attentionProjectionSchema.safeParse({
      version: 1,
      completeness: "complete",
      items: [{ ...workspace, count: { value: 0, capped: false } }],
    }).success).toBeFalse();
    for (const forbidden of [
      { path: "/Users/example/private" },
      { prompt: "secret prompt" },
      { response: "secret response" },
      { providerSessionId: "provider-private" },
      { transcript: "setup output" },
    ]) {
      expect(attentionProjectionSchema.safeParse({
        version: 1,
        completeness: "complete",
        items: [{ ...pane, ...forbidden }],
      }).success).toBeFalse();
    }
  });

  test("carries only opaque setup identity and a closed failure code", () => {
    const setupItem = {
      source: "pane" as const,
      paneId: "pane_setupattention",
      title: "Workspace setup",
      repositoryName: "hra",
      reason: {
        kind: "workspace_setup_failed" as const,
        setupRequestId: `wssetup_${"a".repeat(32)}`,
        recipeDigest: "b".repeat(64),
        setupRevision: 3,
        setupOutcome: "timeout" as const,
      },
    };
    expect(attentionProjectionSchema.parse({
      version: 1,
      completeness: "cloud_unavailable",
      items: [setupItem],
    }).items).toEqual([setupItem]);
    expect(attentionProjectionSchema.safeParse({
      version: 1,
      completeness: "complete",
      items: [{
        ...setupItem,
        reason: { ...setupItem.reason, command: "bun install" },
      }],
    }).success).toBeFalse();
  });
});
