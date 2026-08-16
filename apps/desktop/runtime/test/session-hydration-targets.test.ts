import { describe, expect, test } from "bun:test";

import type { CodexItemSnapshot, CodexThreadSnapshot } from "../src/codex";
import { SESSION_HYDRATION_POLICY } from "../src/sessions/hydration";
import {
  planSessionHydrationTargets,
  windowSessionThreadDisplay,
} from "../src/sessions/hydration-targets";

describe("session hydration targets", () => {
  test("prioritizes selected and active threads under fixed bounds", () => {
    const threads = Array.from({ length: 300 }, (_, index) => ({
      executionActive: index % 5 === 0,
      id: `thread_${String(index).padStart(3, "0")}`,
      updatedAt: new Date(1_700_000_000_000 + index).toISOString(),
    }));
    const plan = planSessionHydrationTargets({
      cwds: Array.from({ length: 130 }, (_, index) => `/tmp/${String(index)}`),
      selectedThreadId: "thread_001",
      threads,
    });
    expect(plan.metadataThreadIds).toHaveLength(
      SESSION_HYDRATION_POLICY.maxMetadataThreadsPerAccount,
    );
    expect(plan.metadataThreadIds[0]).toBe("thread_001");
    expect(plan.historyThreadIds[0]).toBe("thread_001");
    expect(plan.historyThreadIds).toHaveLength(
      SESSION_HYDRATION_POLICY.maxHistoryThreadsPerAccount,
    );
    expect(plan.cwdFilterBatches.map((batch) => batch.length)).toEqual([64, 64, 2]);
  });

  test("deduplicates metadata and cwd inputs deterministically", () => {
    const plan = planSessionHydrationTargets({
      cwds: ["/b", "/a", "/b"],
      selectedThreadId: "thread_1",
      threads: [{
        executionActive: false,
        id: "thread_1",
        updatedAt: "2026-07-29T00:00:00.000Z",
      }, {
        executionActive: true,
        id: "thread_1",
        updatedAt: "2026-07-29T00:00:00.000Z",
      }],
    });
    expect(plan.metadataThreadIds).toEqual(["thread_1"]);
    expect(plan.historyThreadIds).toEqual(["thread_1"]);
    expect(plan.cwdFilterBatches).toEqual([["/a", "/b"]]);
  });

  test("retains an active thread cwd before bounding a large workspace set", () => {
    const plan = planSessionHydrationTargets({
      cwds: Array.from({ length: 300 }, (_, index) => `/tmp/${String(index)}`),
      selectedThreadId: null,
      threads: [{
        cwd: "/zz/active",
        executionActive: true,
        id: "thread_active",
        updatedAt: "2026-07-29T00:00:00.000Z",
      }],
    });
    expect(plan.cwdFilterBatches).toHaveLength(4);
    expect(plan.cwdFilterBatches[0]?.[0]).toBe("/zz/active");
    expect(plan.cwdFilterBatches.flat()).toHaveLength(
      SESSION_HYDRATION_POLICY.maxMetadataThreadsPerAccount,
    );
  });

  test("retains newest display items in original order", () => {
    const items: CodexItemSnapshot[] = Array.from({ length: 300 }, (_, index) => ({
      id: `item_${String(index).padStart(3, "0")}`,
      kind: "assistant_text" as const,
      text: "x",
      truncated: false,
    }));
    const snapshot: CodexThreadSnapshot = {
      archived: false,
      createdAt: "2026-07-29T00:00:00.000Z",
      cwd: "/tmp/project",
      id: "thread_1",
      status: "idle",
      title: null,
      turns: [{
        completedAt: "2026-07-29T00:01:00.000Z",
        id: "turn_1",
        items,
        startedAt: "2026-07-29T00:00:01.000Z",
        status: "completed",
      }],
      updatedAt: "2026-07-29T00:01:00.000Z",
    };
    const window = windowSessionThreadDisplay(snapshot);
    expect(window.truncated).toBe(true);
    expect(window.items).toBe(SESSION_HYDRATION_POLICY.maxDisplayItemsPerThread);
    expect(window.snapshot.turns?.[0]?.items?.[0]?.id).toBe("item_044");
    expect(window.snapshot.turns?.[0]?.items?.at(-1)?.id).toBe("item_299");
  });

  test("preserves partial turn identity without claiming completeness", () => {
    const snapshot: CodexThreadSnapshot = {
      archived: false,
      createdAt: "2026-07-29T00:00:00.000Z",
      cwd: "/tmp/project",
      id: "thread_1",
      status: "active",
      title: null,
      turns: [{
        completedAt: null,
        id: "turn_1",
        items: null,
        startedAt: null,
        status: "active",
      }],
      updatedAt: "2026-07-29T00:01:00.000Z",
    };
    const window = windowSessionThreadDisplay(snapshot);
    expect(window).toEqual({ bytes: 0, items: 0, snapshot, truncated: false });
    expect(window.snapshot.turns?.[0]).toBe(snapshot.turns?.[0]);
  });
});
