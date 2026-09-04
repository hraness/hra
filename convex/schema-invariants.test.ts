import { describe, expect, test } from "bun:test";
import { z } from "zod";

import schema from "./schema";
import { DETAIL_CHUNK_RETENTION, HOSTED_TABLE_LIFECYCLE } from "./lifecyclePolicy";
import { QUOTA_GENESIS_CHARGED_TABLES, USER_QUOTA_RESOURCES, USER_RESOURCE_QUOTAS } from "./quota";

describe("hosted schema invariants", () => {
  test("every schema table has exactly one lifecycle, quota, retention, and erasure classification", () => {
    const schemaTables = Object.keys(schema.tables).sort();
    const classifiedTables = Object.keys(HOSTED_TABLE_LIFECYCLE).sort();
    expect(classifiedTables).toEqual(schemaTables);
    for (const table of classifiedTables) {
      const policy = HOSTED_TABLE_LIFECYCLE[table as keyof typeof HOSTED_TABLE_LIFECYCLE];
      expect(policy.owner.length).toBeGreaterThan(0);
      expect(policy.retention.length).toBeGreaterThan(0);
      expect(policy.disposition.length).toBeGreaterThan(0);
      if (policy.owner === "user") expect(policy.deletionOrder).not.toBeNull();
    }
  });

  test("auth verifiers are indexed by session for bounded account erasure", () => {
    const tables = (schema as unknown as { readonly tables: Readonly<Record<string, unknown>> }).tables;
    const table = z.object({
      indexes: z.array(z.object({ indexDescriptor: z.string() }).passthrough()),
    }).passthrough().parse(tables.authVerifiers);
    const indexes = table.indexes.map((index) => index.indexDescriptor);
    expect(indexes).toContain("sessionId");
  });

  test("immutable compact history is erased only through whole-account deletion", () => {
    expect(HOSTED_TABLE_LIFECYCLE.sessionChunks).toMatchObject({ retention: "encrypted_history", disposition: "erase" });
    expect(HOSTED_TABLE_LIFECYCLE.sessionStreamEpochs).toMatchObject({ retention: "encrypted_history", disposition: "erase" });
  });

  test("live_tail is a distinct retention class from the table-wide compact history bulk class", () => {
    expect(DETAIL_CHUNK_RETENTION).toBe("live_tail");
    expect(DETAIL_CHUNK_RETENTION).not.toBe(HOSTED_TABLE_LIFECYCLE.sessionChunks.retention);
    expect(USER_QUOTA_RESOURCES).toContain("live_chunk");
    expect(USER_RESOURCE_QUOTAS.live_chunk).toBe(20_000);
    expect(USER_RESOURCE_QUOTAS.live_chunk).toBeLessThan(USER_RESOURCE_QUOTAS.session_chunk);
  });

  test("hard quota genesis proves every charged table empty", () => {
    const chargedTables = Object.entries(HOSTED_TABLE_LIFECYCLE)
      .filter(([, policy]) => policy.quota !== null)
      .map(([table]) => table)
      .sort();
    const genesisTables: string[] = [...QUOTA_GENESIS_CHARGED_TABLES].sort();
    expect(genesisTables).toEqual(chargedTables);
    expect(HOSTED_TABLE_LIFECYCLE.storageResourceUsageByUser.quota).toBeNull();
    expect(HOSTED_TABLE_LIFECYCLE.storageResourceUsageByAccount.quota).toBeNull();
    expect(HOSTED_TABLE_LIFECYCLE.serviceControl).toEqual({
      owner: "service",
      quota: null,
      retention: "service_permanent",
      deletionOrder: null,
      disposition: "service_reset",
    });
  });
});
