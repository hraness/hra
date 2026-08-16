import { describe, expect, test } from "bun:test";
import {
  MAX_RUN_INTERACTION_VIEWS,
  type RunInteractionRequest,
} from "@hraness/agent-tasks-protocol";

import type { MutationCtx } from "./_generated/server";
import { refreshTaskHumanInputProjection } from "./dispatchInteractions";
import {
  boundedHumanInputPreview,
  deriveActionableHumanInputSummary,
  deriveHumanInputProjection,
  deriveHumanInputSummary,
  humanInputProjectionFromTask,
  humanInputProjectionIsDisplayableAt,
  storedHumanInputProjection,
} from "./humanTaskProjection";
import { MAX_HUMAN_INPUT_PREVIEW_BYTES } from "./model";

function reply() {
  return {
    version: 1 as const,
    algorithm: "P256-HKDF-SHA256-A256GCM" as const,
    keyId: `hitlkey_${"a".repeat(32)}`,
    publicKey: "B".repeat(87),
    runnerId: "runner_current0001",
    bootId: "boot_current0001",
    bootGeneration: 1,
    claimId: "claim_current001",
    claimFence: 1,
    requestDigest: `sha256_${"b".repeat(64)}`,
  };
}

function userInput(id: string, createdAt: number, prompt: string): RunInteractionRequest {
  return {
    id,
    createdAt,
    expiresAt: createdAt + 60_000,
    kind: "user_input",
    questions: [{
      id: `question_${id.replace(/^interaction_/u, "")}`,
      header: "Choice",
      prompt,
      allowOther: true,
      options: [],
    }],
    reply: reply(),
  };
}

function approval(id: string, createdAt: number): RunInteractionRequest {
  return {
    id,
    createdAt,
    expiresAt: createdAt + 60_000,
    kind: "file_change_approval",
    scope: "once",
    reply: reply(),
  };
}

describe("human-input summary", () => {
  test("uses the oldest request and keeps provider prose to one bounded line", () => {
    const summary = deriveHumanInputSummary([
      { publicId: "interaction_new", request: approval("interaction_new", 20) },
      {
        publicId: "interaction_old",
        request: userInput("interaction_old", 10, `  Which\npath? ${"🙂".repeat(100)}`),
      },
    ]);
    expect(summary?.pendingCount).toBe(2);
    expect(summary?.oldestRequestedAt).toBe(10);
    expect(summary?.expiresAt).toBe(60_010);
    expect(summary?.kind).toBe("user_input");
    expect(summary?.preview.startsWith("Which path?")).toBeTrue();
    expect(summary?.preview.includes("\n")).toBeFalse();
    expect(new TextEncoder().encode(summary?.preview).byteLength)
      .toBeLessThanOrEqual(MAX_HUMAN_INPUT_PREVIEW_BYTES);
  });

  test("round-trips an exact all-or-nothing stored projection", () => {
    const summary = {
      pendingCount: 2,
      oldestRequestedAt: 10,
      expiresAt: 20,
      latestExpiresAt: 30,
      kind: "approval" as const,
      preview: "Allow this task to change files?",
    };
    expect(humanInputProjectionFromTask(storedHumanInputProjection(summary))).toEqual(summary);
    expect(humanInputProjectionFromTask(storedHumanInputProjection(null))).toBeNull();
    expect(humanInputProjectionFromTask({ hasPendingHumanInput: true })).toBeUndefined();
    expect(humanInputProjectionFromTask({
      ...storedHumanInputProjection(summary),
      pendingHumanInputCount: MAX_RUN_INTERACTION_VIEWS + 1,
    })).toBeUndefined();
    for (const lineBreak of ["\r", "\v", "\f", "\u0085", "\u2028", "\u2029"]) {
      expect(humanInputProjectionFromTask({
        ...storedHumanInputProjection(summary),
        pendingHumanInputPreview: `Question${lineBreak}continued`,
      })).toBeUndefined();
    }
  });

  test("falls back to useful copy for an empty normalized prompt", () => {
    expect(boundedHumanInputPreview(" \n\t ")).toBe("This task needs your input.");
  });

  test("a delayed expiry scheduler exposes the next live question, never the stale one", () => {
    const interactions = [
      {
        publicId: "interaction_stale",
        request: { ...userInput("interaction_stale", 10, "Stale"), expiresAt: 25 },
      },
      {
        publicId: "interaction_live",
        request: { ...approval("interaction_live", 20), expiresAt: 80 },
      },
    ];
    expect(deriveHumanInputProjection(interactions)).toEqual({
      pendingCount: 2,
      oldestRequestedAt: 10,
      expiresAt: 25,
      latestExpiresAt: 80,
      kind: "user_input",
      preview: "Stale",
    });
    expect(deriveActionableHumanInputSummary(interactions, 30)).toEqual({
      pendingCount: 1,
      oldestRequestedAt: 20,
      expiresAt: 80,
      kind: "approval",
      preview: "Allow this task to change files?",
    });
    expect(deriveActionableHumanInputSummary(interactions, 80)).toBeNull();
  });

  test("a continuation never displays HITL that expired after its cursor snapshot", () => {
    const projection = deriveHumanInputProjection([
      { publicId: "interaction_page", request: approval("interaction_page", 10) },
    ]);
    expect(humanInputProjectionIsDisplayableAt(projection, 20, 60_009)).toBeTrue();
    expect(humanInputProjectionIsDisplayableAt(projection, 20, 60_010)).toBeFalse();
    expect(humanInputProjectionIsDisplayableAt(null, 20, 60_010)).toBeTrue();
  });
});

describe("transactional task projection refresh", () => {
  function context(interactions: Array<Record<string, unknown>>) {
    const task = {
      _id: "task_current",
      organizationId: "organization_current",
      workspaceId: "workspace_current",
    };
    const patches: Array<Record<string, unknown>> = [];
    const builder = { eq: () => builder };
    const ctx = {
      db: {
        get: async (id: string) => id === task._id ? task : null,
        patch: async (_id: string, patch: Record<string, unknown>) => {
          patches.push(patch);
        },
        query: () => {
          const chain = {
            withIndex: (_name: string, range: (value: typeof builder) => unknown) => {
              range(builder);
              return chain;
            },
            take: async () => interactions.filter((row) =>
              row.taskId === task._id && row.state === "pending"),
          };
          return chain;
        },
      },
    } as unknown as MutationCtx;
    return { ctx, patches, task };
  }

  function row(
    id: string,
    request: RunInteractionRequest,
    overrides: Record<string, unknown> = {},
  ): Record<string, unknown> {
    return {
      _id: `${id}_document`,
      publicId: id,
      organizationId: "organization_current",
      workspaceId: "workspace_current",
      taskId: "task_current",
      state: "pending",
      request,
      expiresAt: request.expiresAt,
      ...overrides,
    };
  }

  test("open, answer, expiry, and settlement preserve the exact remaining oldest request", async () => {
    const interactions: Array<Record<string, unknown>> = [
      row("interaction_old", userInput("interaction_old", 10, "Choose a path")),
      row("interaction_new", approval("interaction_new", 20)),
    ];
    const { ctx, patches } = context(interactions);
    await refreshTaskHumanInputProjection(ctx, "task_current" as never);
    expect(humanInputProjectionFromTask(patches.at(-1) ?? {})).toEqual({
      pendingCount: 2,
      oldestRequestedAt: 10,
      expiresAt: 60_010,
      latestExpiresAt: 60_020,
      kind: "user_input",
      preview: "Choose a path",
    });

    const oldInteraction = interactions[0];
    const newInteraction = interactions[1];
    if (oldInteraction === undefined || newInteraction === undefined) {
      throw new Error("Expected two interaction fixtures.");
    }
    oldInteraction.state = "answered";
    await refreshTaskHumanInputProjection(ctx, "task_current" as never);
    expect(humanInputProjectionFromTask(patches.at(-1) ?? {})).toEqual({
      pendingCount: 1,
      oldestRequestedAt: 20,
      expiresAt: 60_020,
      latestExpiresAt: 60_020,
      kind: "approval",
      preview: "Allow this task to change files?",
    });

    newInteraction.state = "expired";
    await refreshTaskHumanInputProjection(ctx, "task_current" as never);
    expect(humanInputProjectionFromTask(patches.at(-1) ?? {})).toBeNull();

    oldInteraction.state = "resolved";
    await refreshTaskHumanInputProjection(ctx, "task_current" as never);
    expect(humanInputProjectionFromTask(patches.at(-1) ?? {})).toBeNull();
  });

  test("tenant corruption faults before a task projection write", async () => {
    const foreign = row(
      "interaction_foreign",
      userInput("interaction_foreign", 10, "Foreign prompt"),
      { organizationId: "organization_foreign" },
    );
    const { ctx, patches } = context([foreign]);
    await expect(refreshTaskHumanInputProjection(ctx, "task_current" as never))
      .rejects.toThrow("disagree with their task tenant");
    expect(patches).toHaveLength(0);
  });
});
