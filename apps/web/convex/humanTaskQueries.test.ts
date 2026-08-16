import { describe, expect, test } from "bun:test";

import {
  allRowsBelongToHumanTaskTenant,
  belongsToHumanTaskTenant,
  countHumanTaskViews,
  deriveHumanTaskCapabilities,
  humanTaskMatchesScopedView,
  humanTaskMatchesView,
  humanTaskViewUsesHumanInputPriority,
  joinHumanTaskListData,
  selectHumanTaskPatchHeads,
  type HumanTaskView,
  validHumanTaskClassifiedAt,
} from "./humanTaskQueries";

const now = 1_000;

function task(
  overrides: Partial<{
    assigneeAgentPublicId: string;
    availableAt: number;
    cancelledBlockerCount: number;
    latestPendingHumanInputExpiresAt: number;
    isBlocked: boolean;
    isReady: boolean;
    currentClaim: { leaseUntil: number };
    needsAttention: boolean;
    status: "open" | "in_progress" | "in_review" | "done" | "cancelled";
    unresolvedBlockerCount: number;
  }> = {},
) {
  return {
    availableAt: 0,
    cancelledBlockerCount: 0,
    isReady: false,
    status: "open" as const,
    unresolvedBlockerCount: 0,
    ...overrides,
  };
}

describe("human task capabilities", () => {
  test.each(["owner", "admin"] as const)("grants every capability to an %s", (role) => {
    expect(Object.values(deriveHumanTaskCapabilities(role, []))).toEqual(
      Array.from({ length: 10 }, () => true),
    );
  });

  test("unions planner and reviewer capabilities for members", () => {
    expect(deriveHumanTaskCapabilities("member", ["planner"])).toEqual({
      canAssign: true,
      canCancel: true,
      canComment: true,
      canCreate: true,
      canEdit: true,
      canManageGraph: true,
      canManageLabels: true,
      canManageReferences: true,
      canReopen: true,
      canReview: false,
    });
    expect(deriveHumanTaskCapabilities("member", ["reviewer"])).toEqual({
      canAssign: false,
      canCancel: false,
      canComment: true,
      canCreate: false,
      canEdit: false,
      canManageGraph: false,
      canManageLabels: false,
      canManageReferences: false,
      canReopen: false,
      canReview: true,
    });
    expect(deriveHumanTaskCapabilities("member", ["viewer"])).toEqual({
      canAssign: false,
      canCancel: false,
      canComment: false,
      canCreate: false,
      canEdit: false,
      canManageGraph: false,
      canManageLabels: false,
      canManageReferences: false,
      canReopen: false,
      canReview: false,
    });
  });
});

describe("human task list classification", () => {
  const cases: ReadonlyArray<readonly [HumanTaskView, ReturnType<typeof task>]> = [
    ["ready", task({ isReady: true })],
    ["blocked", task({ isBlocked: true, unresolvedBlockerCount: 1 })],
    ["deferred", task({ availableAt: now + 1 })],
    ["attention", task({ cancelledBlockerCount: 1, needsAttention: true })],
    ["assigned", task({ assigneeAgentPublicId: "agt_worker" })],
    ["review", task({ status: "in_review" })],
  ];

  test.each(cases)("classifies the %s view", (view, value) => {
    expect(humanTaskMatchesView(value, view, now)).toBeTrue();
  });

  test("does not classify terminal or future work as ready", () => {
    expect(humanTaskMatchesView(task({ isReady: true, status: "done" }), "ready", now)).toBeFalse();
    expect(humanTaskMatchesView(task({ availableAt: now + 1, isReady: true }), "ready", now)).toBeFalse();
  });

  test("makes an expired claim visible in both ready recovery and attention", () => {
    const expired = task({
      currentClaim: { leaseUntil: now },
      status: "in_progress",
    });
    expect(humanTaskMatchesView(expired, "ready", now)).toBeTrue();
    expect(humanTaskMatchesView(expired, "attention", now)).toBeTrue();
    expect(
      humanTaskMatchesView(
        task({ currentClaim: { leaseUntil: now + 1 }, status: "in_progress" }),
        "ready",
        now,
      ),
    ).toBeFalse();
  });

  test("always includes pending human input in Attention", () => {
    expect(humanTaskMatchesView(task({ latestPendingHumanInputExpiresAt: now + 1 }), "attention", now))
      .toBeTrue();
  });

  test("keeps Assigned patches exact to the requested agent partition", () => {
    const assigned = task({ assigneeAgentPublicId: "agt_worker" });
    expect(humanTaskMatchesScopedView(
      assigned,
      "assigned",
      "agt_worker",
      now,
    )).toBeTrue();
    expect(humanTaskMatchesScopedView(
      assigned,
      "assigned",
      "agt_other",
      now,
    )).toBeFalse();
    expect(humanTaskMatchesScopedView(
      assigned,
      "assigned",
      undefined,
      now,
    )).toBeTrue();
  });

  test("a delayed expiry scheduler cannot keep a stale task in Attention", () => {
    expect(humanTaskMatchesView(
      task({ latestPendingHumanInputExpiresAt: now }),
      "attention",
      now,
    )).toBeFalse();
  });

  test("does not let an unrelated HITL partition starve filtered views", () => {
    expect(humanTaskViewUsesHumanInputPriority("all")).toBeTrue();
    expect(humanTaskViewUsesHumanInputPriority("attention")).toBeTrue();
    for (const view of ["ready", "blocked", "deferred", "assigned", "review"] as const) {
      expect(humanTaskViewUsesHumanInputPriority(view)).toBeFalse();
    }
    const limit = 100;
    const rows = [
      task({ isReady: true }),
      ...Array.from({ length: limit + 1 }, () => task({
        currentClaim: { leaseUntil: now + 10_000 },
        latestPendingHumanInputExpiresAt: now + 10_000,
        status: "in_progress",
      })),
    ];
    // The ready row remains in a recency page even though a HITL-first index
    // would move more than one page of nonmatching active work ahead of it.
    expect(rows.slice(0, limit).some((value) =>
      humanTaskMatchesView(value, "ready", now))).toBeTrue();
  });
});

describe("frozen human task classification clock", () => {
  test("accepts only safe timestamps inside the continuation window", () => {
    const observedAt = 1_735_689_600_000;
    const maximumAgeMs = 5 * 60 * 1_000;
    const maximumFutureSkewMs = 30_000;

    expect(validHumanTaskClassifiedAt(undefined, observedAt)).toBeTrue();
    expect(validHumanTaskClassifiedAt(observedAt - maximumAgeMs, observedAt)).toBeTrue();
    expect(validHumanTaskClassifiedAt(observedAt + maximumFutureSkewMs, observedAt)).toBeTrue();
    expect(validHumanTaskClassifiedAt(observedAt - maximumAgeMs - 1, observedAt)).toBeFalse();
    expect(validHumanTaskClassifiedAt(observedAt + maximumFutureSkewMs + 1, observedAt)).toBeFalse();
    expect(validHumanTaskClassifiedAt(observedAt + 0.5, observedAt)).toBeFalse();
    expect(validHumanTaskClassifiedAt(Number.NaN, observedAt)).toBeFalse();
    expect(validHumanTaskClassifiedAt(Number.POSITIVE_INFINITY, observedAt)).toBeFalse();
  });

  test("keeps time-sensitive view membership pinned to the source clock", () => {
    const classifiedAt = 10_000;
    const value = task({
      availableAt: classifiedAt + 1,
      isReady: true,
      latestPendingHumanInputExpiresAt: classifiedAt + 1,
    });

    expect(humanTaskMatchesView(value, "deferred", classifiedAt)).toBeTrue();
    expect(humanTaskMatchesView(value, "attention", classifiedAt)).toBeTrue();
    expect(humanTaskMatchesView(value, "ready", classifiedAt)).toBeFalse();
    expect(humanTaskMatchesView(value, "deferred", classifiedAt + 1)).toBeFalse();
    expect(humanTaskMatchesView(value, "attention", classifiedAt + 1)).toBeFalse();
    expect(humanTaskMatchesView(value, "ready", classifiedAt + 1)).toBeTrue();
  });
});

describe("atomic human task patch heads", () => {
  const heads = {
    projectionRevision: 9,
    taskViewRevisions: {
      all: 7,
      ready: 8,
      blocked: 4,
      deferred: 5,
      attention: 6,
      assigned: 3,
      review: 2,
    },
  } as const;

  test("returns the active view head only at the exact global snapshot", () => {
    expect(selectHumanTaskPatchHeads(heads, 9, "ready")).toEqual({
      continuationRevision: 8,
      projectionRevision: 9,
    });
  });

  test("rejects stale, future, fractional, and exhausted fences", () => {
    for (const revision of [8, 10, 9.5, 0, Number.MAX_SAFE_INTEGER + 1]) {
      expect(selectHumanTaskPatchHeads(heads, revision, "all")).toBeNull();
    }
  });
});

describe("bounded human task counts", () => {
  test("returns exact per-view values for an uncapped scan", () => {
    const counts = countHumanTaskViews(
      [
        task({ isReady: true }),
        task({ isBlocked: true, unresolvedBlockerCount: 1 }),
        task({ status: "in_review", assigneeAgentPublicId: "agt_reviewer" }),
      ],
      now,
      false,
    );
    expect(counts.all).toEqual({ value: 3, capped: false });
    expect(counts.ready).toEqual({ value: 1, capped: false });
    expect(counts.blocked).toEqual({ value: 1, capped: false });
    expect(counts.assigned).toEqual({ value: 1, capped: false });
    expect(counts.review).toEqual({ value: 1, capped: false });
  });

  test("marks every lower-bound count when the workspace scan is capped", () => {
    const counts = countHumanTaskViews([task({ isReady: true })], now, true);
    expect(Object.values(counts).every(({ capped }) => capped)).toBeTrue();
    expect(counts.all.value).toBe(1);
  });

  test("joins independently cached page and count reads only at one clock", () => {
    const page = {
      now,
      view: "all" as const,
      tasks: [],
      cursor: null,
    };
    const countProjection = {
      now,
      counts: countHumanTaskViews([], now, false),
    };

    expect(joinHumanTaskListData(page, countProjection)).toEqual({
      ...page,
      counts: countProjection.counts,
    });
    expect(joinHumanTaskListData(page, {
      ...countProjection,
      now: now + 1,
    })).toBeNull();
  });
});

test("tenant mapping rejects a same-shaped row from a second tenant", () => {
  const selected = { organizationId: "org_a", workspaceId: "wsp_a" };
  expect(belongsToHumanTaskTenant(selected, selected)).toBeTrue();
  expect(
    belongsToHumanTaskTenant(
      { organizationId: "org_b", workspaceId: "wsp_b" },
      selected,
    ),
  ).toBeFalse();
  expect(
    allRowsBelongToHumanTaskTenant(
      [selected, { organizationId: "org_b", workspaceId: "wsp_a" }],
      selected,
    ),
  ).toBeFalse();
});
