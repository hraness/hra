import { describe, expect, test } from "bun:test";
import {
  humanRefreshTokenSchema,
  taskctlApiOperations,
} from "@hraness/agent-tasks-protocol";

import { hmacSha256Utf8KeyBase64Url } from "./crypto";
import {
  AUTHENTICATED_RATE_LIMIT_SHARDS,
  MAX_RATE_LIMIT_CLEANUP_ROWS,
  RATE_LIMIT_EXPIRY_INDEX_FIELDS,
  RATE_LIMIT_SELECTED_SHARD_INDEX_FIELDS,
  RATE_LIMIT_WINDOW_MS,
  UNAUTHENTICATED_RATE_LIMIT_SLOTS,
  agentOperationAuthorizationPolicy,
  agentReadOperations,
  apiOperationRateLimitClass,
  perShardRateLimit,
  planRateLimitConsumption,
  rateLimitPolicies,
  rateLimitShard,
  rateLimitWindow,
  selectExpiredRateLimitBucketIds,
  subjectKindsForProfile,
  unauthenticatedSlotKey,
  type RateLimitBucketSnapshot,
  type RateLimitRouteClass,
  type RateLimitSubject,
  type RateLimitWrite,
} from "./rateLimitPolicy";

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

function requestId(value: number): string {
  let remaining = value;
  let suffix = "";
  for (let index = 0; index < 26; index += 1) {
    suffix = `${CROCKFORD[remaining % CROCKFORD.length] ?? "0"}${suffix}`;
    remaining = Math.floor(remaining / CROCKFORD.length);
  }
  return `req_${suffix}`;
}

function token(subject: RateLimitSubject): string {
  return `${subject.kind}:${subject.key}`;
}

function selectedRows(
  store: readonly RateLimitBucketSnapshot[],
  routeClass: RateLimitRouteClass,
  subjects: readonly RateLimitSubject[],
  id: string,
  now: number,
): readonly RateLimitBucketSnapshot[] {
  const policy = rateLimitPolicies[routeClass];
  const shard = rateLimitShard(id, policy.shardCount);
  const window = rateLimitWindow(now, policy.windowMs);
  if (shard === null || window === null) throw new Error("invalid test request");
  const subjectTokens = new Set(subjects.map(token));
  return store.filter(
    (bucket) =>
      bucket.routeClass === routeClass &&
      bucket.windowStartedAt === window.startedAt &&
      bucket.shard === shard &&
      subjectTokens.has(token(bucket)),
  );
}

function applyWrites(
  store: RateLimitBucketSnapshot[],
  writes: readonly RateLimitWrite[],
): void {
  for (const write of writes) {
    if (write.kind === "insert") {
      store.push({ ...write.bucket, id: `bucket-${store.length + 1}` });
      continue;
    }
    const index = store.findIndex((bucket) => bucket.id === write.id);
    if (index < 0) throw new Error("missing test bucket");
    const existing = store[index];
    if (existing === undefined) throw new Error("missing test bucket");
    store[index] = { ...existing, count: write.count, expiresAt: write.expiresAt };
  }
}

function consume(
  store: RateLimitBucketSnapshot[],
  routeClass: RateLimitRouteClass,
  subjects: readonly RateLimitSubject[],
  id: string,
  now: number,
) {
  const plan = planRateLimitConsumption({
    routeClass,
    subjects,
    currentWindowBuckets: selectedRows(store, routeClass, subjects, id, now),
    requestId: id,
    now,
  });
  if (plan.kind === "allowed") applyWrites(store, plan.writes);
  return plan;
}

describe("prerelease rate-limit policy", () => {
  test("maps every protocol operation to a satisfiable explicit subject profile", () => {
    expect(Object.keys(apiOperationRateLimitClass).toSorted()).toEqual(
      Object.keys(taskctlApiOperations).toSorted(),
    );
    for (const rule of Object.values(apiOperationRateLimitClass)) {
      if (rule.kind !== "consume") continue;
      const kinds = subjectKindsForProfile(rule.subjectProfile);
      expect(kinds.length).toBeGreaterThan(0);
      for (const kind of kinds) expect(perShardRateLimit(rule.routeClass, kind)).not.toBeNull();
    }
    expect(apiOperationRateLimitClass.listOrganizations).toEqual({
      kind: "consume",
      routeClass: "human_read",
      subjectProfile: "human_user",
    });
    expect(apiOperationRateLimitClass.createWorkspace).toEqual({
      kind: "consume",
      routeClass: "human_mutation",
      subjectProfile: "human_user",
    });
    expect(apiOperationRateLimitClass.redeemEnrollment).toEqual({
      kind: "failure_only",
      authenticationFailureClass: "enrollment_auth_failure",
    });
    expect(apiOperationRateLimitClass.refreshAuth).toEqual({
      kind: "opaque_pre_auth",
      routeClass: "refresh_auth",
    });
    expect(perShardRateLimit("human_poll", "user")).toBe(3);
    expect(perShardRateLimit("human_poll", "workspace")).toBe(8);

    const authenticatedAgentOperations = Object.entries(apiOperationRateLimitClass)
      .flatMap(([operation, rule]) =>
        rule.kind === "consume" && rule.subjectProfile === "agent_credential_workspace"
          ? [operation]
          : [],
      )
      .toSorted();
    expect(Object.keys(agentOperationAuthorizationPolicy).toSorted()).toEqual(
      authenticatedAgentOperations,
    );
    expect([...agentReadOperations].toSorted().join(",")).toBe(
      Object.entries(agentOperationAuthorizationPolicy)
        .flatMap(([operation, policy]) => policy.kind === "read" ? [operation] : [])
        .toSorted()
        .join(","),
    );
    expect(agentOperationAuthorizationPolicy.startSession).toEqual({
      kind: "session_start",
    });
    expect(agentOperationAuthorizationPolicy.context).toEqual({
      kind: "read",
      requiredScope: "tasks:read",
    });
    expect(agentOperationAuthorizationPolicy.reviewQueue).toEqual({
      kind: "read",
      requiredScope: "tasks:review",
    });
    expect(agentOperationAuthorizationPolicy.addTaskDependency.requiredScope).toBe(
      "dependencies:write",
    );
    const writeOperations = Object.entries(agentOperationAuthorizationPolicy)
      .flatMap(([operation, policy]) => policy.kind === "write" ? [operation] : [])
      .toSorted();
    expect(writeOperations).toEqual([
      "acceptTask",
      "addTaskComment",
      "addTaskDependency",
      "addTaskLabel",
      "addTaskReference",
      "assignTask",
      "claimTask",
      "clearTaskParent",
      "createTask",
      "deferTask",
      "rejectTask",
      "releaseClaim",
      "removeTaskDependency",
      "removeTaskLabel",
      "removeTaskReference",
      "renewClaim",
      "setTaskParent",
      "submitTask",
      "updateTask",
    ]);
    const rulesByOperation = new Map(Object.entries(apiOperationRateLimitClass));
    for (const operation of writeOperations) {
      const rule = rulesByOperation.get(operation);
      expect(rule).toBeDefined();
      if (rule === undefined) continue;
      expect(rule.kind).toBe("consume");
      if (rule.kind !== "consume") continue;
      expect(rule.routeClass).not.toBe("agent_read");
    }
  });

  test("freezes selected-shard and cleanup persistence index contracts", () => {
    expect(RATE_LIMIT_SELECTED_SHARD_INDEX_FIELDS).toEqual([
      "subjectKind",
      "subjectKey",
      "routeClass",
      "windowStartedAt",
      "shard",
    ]);
    expect(RATE_LIMIT_EXPIRY_INDEX_FIELDS).toEqual(["expiresAt"]);
  });

  test("uses documented per-shard ceilings with less than one shard-count of overshoot", () => {
    for (const [routeClass, policy] of Object.entries(rateLimitPolicies)) {
      for (const [kind, target] of Object.entries(policy.limits)) {
        const allowance = perShardRateLimit(
          routeClass as RateLimitRouteClass,
          kind as keyof typeof policy.limits,
        );
        expect(allowance).not.toBeNull();
        if (allowance === null || target === undefined) continue;
        const effectiveMaximum = allowance * policy.shardCount;
        expect(effectiveMaximum).toBeGreaterThanOrEqual(target);
        expect(effectiveMaximum - target).toBeLessThan(policy.shardCount);
      }
    }
  });

  test("resets on an exact fixed-window boundary with deterministic retryAfterMs", () => {
    const store: RateLimitBucketSnapshot[] = [];
    const subjects: readonly RateLimitSubject[] = [
      { kind: "credential", key: "credential-a" },
      { kind: "workspace", key: "workspace-a" },
    ];
    const id = requestId(17);
    const now = 12_345;
    const allowance = perShardRateLimit("agent_claim", "credential");
    if (allowance === null) throw new Error("missing allowance");
    for (let index = 0; index < allowance; index += 1) {
      expect(consume(store, "agent_claim", subjects, id, now).kind).toBe("allowed");
    }
    const limited = consume(store, "agent_claim", subjects, id, now);
    expect(limited).toEqual({
      kind: "limited",
      retryAfterMs: RATE_LIMIT_WINDOW_MS - now,
      writes: [],
    });
    expect(consume(store, "agent_claim", subjects, id, RATE_LIMIT_WINDOW_MS).kind).toBe(
      "allowed",
    );
  });

  test("checks credential and workspace atomically before returning writes", () => {
    const now = 10_000;
    const id = requestId(29);
    const shard = rateLimitShard(id, AUTHENTICATED_RATE_LIMIT_SHARDS);
    if (shard === null) throw new Error("invalid shard");
    const window = rateLimitWindow(now, RATE_LIMIT_WINDOW_MS);
    if (window === null) throw new Error("invalid window");
    const subjects: readonly RateLimitSubject[] = [
      { kind: "credential", key: "credential-a" },
      { kind: "workspace", key: "workspace-a" },
    ];
    const workspaceAllowance = perShardRateLimit("agent_claim", "workspace");
    if (workspaceAllowance === null) throw new Error("missing allowance");
    const rows: RateLimitBucketSnapshot[] = [
      {
        id: "credential-row",
        ...subjects[0]!,
        routeClass: "agent_claim",
        windowStartedAt: window.startedAt,
        shard,
        count: 1,
        expiresAt: window.expiresAt,
      },
      {
        id: "workspace-row",
        ...subjects[1]!,
        routeClass: "agent_claim",
        windowStartedAt: window.startedAt,
        shard,
        count: workspaceAllowance,
        expiresAt: window.expiresAt,
      },
    ];
    expect(
      planRateLimitConsumption({
        routeClass: "agent_claim",
        subjects,
        currentWindowBuckets: rows,
        requestId: id,
        now,
      }),
    ).toEqual({ kind: "limited", retryAfterMs: 50_000, writes: [] });
    expect(rows[0]?.count).toBe(1);
  });

  test("isolates credentials, workspaces, route classes, and windows", () => {
    const store: RateLimitBucketSnapshot[] = [];
    const first = [
      { kind: "credential", key: "credential-a" },
      { kind: "workspace", key: "workspace-a" },
    ] as const;
    const second = [
      { kind: "credential", key: "credential-b" },
      { kind: "workspace", key: "workspace-b" },
    ] as const;
    expect(consume(store, "agent_write", first, requestId(1), 1).kind).toBe("allowed");
    expect(consume(store, "agent_write", second, requestId(1), 1).kind).toBe("allowed");
    expect(consume(store, "agent_read", first, requestId(1), 1).kind).toBe("allowed");
    expect(consume(store, "agent_write", first, requestId(1), RATE_LIMIT_WINDOW_MS).kind).toBe(
      "allowed",
    );
    expect(store).toHaveLength(8);
  });

  test("collapses unknown auth material into fixed opaque slots only", () => {
    const digest = "A".repeat(43);
    const slot = unauthenticatedSlotKey(digest);
    expect(slot).toMatch(/^slot_[0-9]{3}$/u);
    expect(unauthenticatedSlotKey(digest)).toBe(slot);
    expect(slot).not.toContain(digest);
    expect(unauthenticatedSlotKey("agt_locator_plaintext")).toBeNull();
    const slots = new Set<string>();
    for (let index = 0; index < 2_000; index += 1) {
      const candidate = `${index.toString(36).padStart(42, "A")}Z`.slice(-43);
      const key = unauthenticatedSlotKey(candidate);
      if (key !== null) slots.add(key);
    }
    expect(slots.size).toBeLessThanOrEqual(UNAUTHENTICATED_RATE_LIMIT_SLOTS);

    const unknown = slot === null ? [] : [{ kind: "unauthenticated" as const, key: slot }];
    expect(
      planRateLimitConsumption({
        routeClass: "agent_auth_failure",
        subjects: unknown,
        currentWindowBuckets: [],
        requestId: requestId(3),
        now: 0,
      }).kind,
    ).toBe("allowed");
    expect(
      planRateLimitConsumption({
        routeClass: "agent_read",
        subjects: unknown,
        currentWindowBuckets: [],
        requestId: requestId(3),
        now: 0,
      }).kind,
    ).toBe("invalid");
  });

  test("bounds random refresh tokens and isolates valid token slots", async () => {
    const workosKey = "sk_test_rate_limit_key";
    const tokens = Array.from(
      { length: 1_024 },
      (_, index) => `workos-refresh-token-${index.toString().padStart(6, "0")}`,
    );
    expect(tokens.every((token) => humanRefreshTokenSchema.safeParse(token).success)).toBeTrue();
    const slotPairs = await Promise.all(
      tokens.map(async (refreshToken) => {
        const digest = await hmacSha256Utf8KeyBase64Url(
          workosKey,
          `taskctl-refresh-rate-limit-v1:${refreshToken}`,
        );
        return [refreshToken, unauthenticatedSlotKey(digest)] as const;
      }),
    );
    const slots = new Set(slotPairs.flatMap(([, slot]) => (slot === null ? [] : [slot])));
    expect(slots.size).toBeLessThanOrEqual(UNAUTHENTICATED_RATE_LIMIT_SLOTS);
    expect(
      UNAUTHENTICATED_RATE_LIMIT_SLOTS *
        rateLimitPolicies.refresh_auth.shardCount *
        2,
    ).toBe(2_048);
    for (const [refreshToken, slot] of slotPairs) {
      expect(slot).not.toContain(refreshToken);
    }
    const first = slotPairs[0]?.[1];
    const isolated = slotPairs.find(([, slot]) => slot !== first)?.[1];
    expect(first).toBeDefined();
    expect(isolated).toBeDefined();
    if (first === null || first === undefined || isolated === null || isolated === undefined) {
      throw new Error("Refresh HMAC fixtures must occupy two slots.");
    }
    for (const [index, slot] of [first, isolated].entries()) {
      expect(
        planRateLimitConsumption({
          routeClass: "refresh_auth",
          subjects: [{ kind: "unauthenticated", key: slot }],
          currentWindowBuckets: [],
          requestId: requestId(index + 90),
          now: 0,
        }).kind,
      ).toBe("allowed");
    }
  });

  test("refresh slots enforce eight-per-minute target and reset by window", () => {
    const store: RateLimitBucketSnapshot[] = [];
    const subjects = [{ kind: "unauthenticated" as const, key: "slot_007" }];
    const id = requestId(707);
    const allowance = perShardRateLimit("refresh_auth", "unauthenticated");
    expect(allowance).toBe(2);
    if (allowance === null) throw new Error("missing refresh allowance");
    for (let index = 0; index < allowance; index += 1) {
      expect(consume(store, "refresh_auth", subjects, id, 10_000).kind).toBe("allowed");
    }
    expect(consume(store, "refresh_auth", subjects, id, 10_000)).toEqual({
      kind: "limited",
      retryAfterMs: 50_000,
      writes: [],
    });
    expect(consume(store, "refresh_auth", subjects, id, RATE_LIMIT_WINDOW_MS).kind).toBe(
      "allowed",
    );
  });

  test("selects cleanup rows deterministically and never exceeds the hard bound", () => {
    const rows = Array.from({ length: 150 }, (_, index) => ({
      id: `bucket-${index.toString().padStart(3, "0")}`,
      expiresAt: index % 3 === 0 ? 2_000 : 500,
    }));
    const selected = selectExpiredRateLimitBucketIds(rows, 1_000, 1_000);
    expect(selected).toHaveLength(MAX_RATE_LIMIT_CLEANUP_ROWS);
    expect(selected).toEqual([...selected].toSorted());
    expect(selectExpiredRateLimitBucketIds(rows, 499)).toEqual([]);
  });
});
