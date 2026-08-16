import { describe, expect, test } from "bun:test";

import {
  AUTHENTICATED_RATE_LIMIT_SHARDS,
  RATE_LIMIT_WINDOW_MS,
  perShardRateLimit,
  planRateLimitConsumption,
  rateLimitShard,
  rateLimitWindow,
  type RateLimitBucketSnapshot,
  type RateLimitSubject,
} from "./rateLimitPolicy";

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

function generator(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state ^ (state >>> 15), 2_246_822_519) + 3_266_489_917) >>> 0;
    return state;
  };
}

function requestId(value: number): string {
  let remaining = value;
  let suffix = "";
  for (let index = 0; index < 26; index += 1) {
    suffix = `${CROCKFORD[remaining % CROCKFORD.length] ?? "0"}${suffix}`;
    remaining = Math.floor(remaining / CROCKFORD.length);
  }
  return `req_${suffix}`;
}

describe("rate-limit sharding properties", () => {
  test("a 100-agent claim storm reads one workspace shard per request", () => {
    for (let seed = 1; seed <= 100; seed += 1) {
      const next = generator(seed);
      const now = next() % RATE_LIMIT_WINDOW_MS;
      const window = rateLimitWindow(now, RATE_LIMIT_WINDOW_MS);
      if (window === null) throw new Error("invalid window");
      const workspaceRows = new Map<number, RateLimitBucketSnapshot>();
      const observedShards = new Set<number>();

      for (let index = 0; index < 100; index += 1) {
        const id = requestId(next());
        const shard = rateLimitShard(id, AUTHENTICATED_RATE_LIMIT_SHARDS);
        if (shard === null) throw new Error("invalid request ID");
        observedShards.add(shard);
        const credential: RateLimitSubject = { kind: "credential", key: `credential-${index}` };
        const workspace: RateLimitSubject = { kind: "workspace", key: "workspace-shared" };
        const existingWorkspace = workspaceRows.get(shard);
        const plan = planRateLimitConsumption({
          routeClass: "agent_claim",
          subjects: [credential, workspace],
          currentWindowBuckets: existingWorkspace === undefined ? [] : [existingWorkspace],
          requestId: id,
          now,
        });
        expect(plan.kind).toBe("allowed");
        if (plan.kind !== "allowed") continue;
        expect(plan.writes).toHaveLength(2);
        const workspaceWrite = plan.writes.find(
          (write) => write.kind === "insert" && write.bucket.kind === "workspace" ||
            write.kind === "increment" && write.id.startsWith("workspace-"),
        );
        expect(workspaceWrite).toBeDefined();
        if (workspaceWrite?.kind === "insert") {
          workspaceRows.set(shard, { ...workspaceWrite.bucket, id: `workspace-${shard}` });
        } else if (workspaceWrite?.kind === "increment" && existingWorkspace !== undefined) {
          workspaceRows.set(shard, { ...existingWorkspace, count: workspaceWrite.count });
        }
      }

      expect(observedShards.size).toBe(AUTHENTICATED_RATE_LIMIT_SHARDS);
      expect(workspaceRows.size).toBe(AUTHENTICATED_RATE_LIMIT_SHARDS);
      expect([...workspaceRows.values()].reduce((sum, row) => sum + row.count, 0)).toBe(100);
      const allowance = perShardRateLimit("agent_claim", "workspace");
      if (allowance === null) throw new Error("missing allowance");
      for (const row of workspaceRows.values()) {
        expect(row.count).toBeLessThanOrEqual(allowance);
        expect(row.shard).toBeGreaterThanOrEqual(0);
        expect(row.shard).toBeLessThan(AUTHENTICATED_RATE_LIMIT_SHARDS);
      }
    }
  });

  test("selected-shard plans reject rows from every other shard", () => {
    for (let seed = 1; seed <= 500; seed += 1) {
      const id = requestId(seed);
      const selected = rateLimitShard(id, AUTHENTICATED_RATE_LIMIT_SHARDS);
      if (selected === null) throw new Error("invalid request ID");
      const other = (selected + 1) % AUTHENTICATED_RATE_LIMIT_SHARDS;
      const window = rateLimitWindow(1, RATE_LIMIT_WINDOW_MS);
      if (window === null) throw new Error("invalid window");
      const subjects = [
        { kind: "credential" as const, key: `credential-${seed}` },
        { kind: "workspace" as const, key: "workspace" },
      ];
      expect(
        planRateLimitConsumption({
          routeClass: "agent_claim",
          subjects,
          currentWindowBuckets: [
            {
              id: `wrong-${seed}`,
              ...subjects[1]!,
              routeClass: "agent_claim",
              windowStartedAt: window.startedAt,
              shard: other,
              count: 1,
              expiresAt: window.expiresAt,
            },
          ],
          requestId: id,
          now: 1,
        }).kind,
      ).toBe("invalid");
    }
  });
});
