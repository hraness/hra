import { describe, expect, test } from "bun:test";

import {
  canonicalLocalPaneListProjection,
  localPaneListLimit,
  localPaneListProjectionSchema,
  localPaneSummarySchema,
} from "./panes";

const pane = {
  paneId: "pane_abcdefgh",
  title: "Review the scheduler",
  repositoryName: "hra",
  interactionMode: "chat" as const,
  state: "attention" as const,
  workspace: {
    state: "recoveryRequired" as const,
    recoveryKind: "dirtyCheckout" as const,
  },
  queue: {
    count: { value: 2, capped: false },
    paused: true,
    blocked: true,
  },
  schedule: { nextRunAt: "2026-08-22T10:00:00.000Z" },
};

describe("local pane observation protocol", () => {
  test("accepts the minimized pathless pane projection", () => {
    expect(canonicalLocalPaneListProjection({
      version: 1,
      panes: [pane],
      truncated: false,
    })).toEqual({ version: 1, panes: [pane], truncated: false });
  });

  test("rejects unknown privacy-bearing fields at every boundary", () => {
    expect(localPaneListProjectionSchema.safeParse({
      version: 1,
      panes: [{ ...pane, canonicalPath: "/Users/person/secret" }],
      truncated: false,
    }).success).toBe(false);
    expect(localPaneSummarySchema.safeParse({
      ...pane,
      queue: { ...pane.queue, text: "private queued prompt" },
    }).success).toBe(false);
    expect(localPaneSummarySchema.safeParse({
      ...pane,
      workspace: { ...pane.workspace, transcript: "setup output" },
    }).success).toBe(false);
  });

  test("requires unique pane identities and bounded lists", () => {
    expect(localPaneListProjectionSchema.safeParse({
      version: 1,
      panes: [pane, pane],
      truncated: false,
    }).success).toBe(false);
    expect(localPaneListProjectionSchema.safeParse({
      version: 1,
      panes: Array.from({ length: localPaneListLimit + 1 }, (_, index) => ({
        ...pane,
        paneId: `pane_${String(index).padStart(8, "0")}`,
      })),
      truncated: true,
    }).success).toBe(false);
  });

  test("enforces interaction, schedule, and blocked-queue invariants", () => {
    expect(localPaneSummarySchema.safeParse({
      ...pane,
      interactionMode: "harnessObserver",
    }).success).toBe(false);
    expect(localPaneSummarySchema.safeParse({
      ...pane,
      queue: { ...pane.queue, paused: false },
    }).success).toBe(false);
  });
});
