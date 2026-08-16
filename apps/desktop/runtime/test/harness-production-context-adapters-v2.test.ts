import { createHmac } from "node:crypto";
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";

import {
  HarnessContextValueNameDigesterV2,
  HarnessContextValueQuotaAuthorityV2,
  LEGACY_OPRTE_CONTEXT_VALUE_NAME_HMAC_DOMAIN_V2,
} from "../src/harness/production-context-adapters-v2";
import type {
  HarnessProductionContextAdapterV2Error,
} from "../src/harness/production-context-adapters-v2";
import {
  deriveHarnessContextDigestKey,
  deriveHarnessContextScopeKey,
  HarnessInstallKeyCustody,
  type HarnessContextKeyProvider,
  type HarnessSecretStore,
} from "../src/harness/key-custody";
import { applyMigrations } from "../src/state/database";

const MIB = 1024 * 1024;
const at = "2031-01-01T00:00:00.000Z";
const deadline = "2031-01-02T00:00:00.000Z";
const projectId = "project-production-context-v2";
const epochId = "hepoch_production_context01";
const actorId = "hactor_production_context01";
const siblingEpochId = "hepoch_production_context02";
const siblingActorId = "hactor_production_context02";

function openDatabase(): Database {
  const database = new Database(":memory:", { strict: true });
  database.exec("PRAGMA foreign_keys = ON");
  applyMigrations(database);
  database.query(`
    INSERT INTO projects (
      project_id, canonical_repository_path, canonical_git_common_dir,
      display_name, created_at, updated_at
    ) VALUES (?1, '/tmp/production-context', '/tmp/production-context/.git',
      'Production context', ?2, ?2)
  `).run(projectId, at);
  insertLineage(database, {
    epochId,
    actorId,
    byteBudget: 16 * MIB,
  });
  return database;
}

function insertLineage(
  database: Database,
  input: Readonly<{
    epochId: string;
    actorId: string;
    byteBudget: number;
  }>,
): void {
  database.query(`
    INSERT INTO harness_actor_epochs (
      epoch_id, project_id, source_sha, root_actor_id,
      max_depth, max_active_descendants, max_durable_descendants,
      token_budget, byte_budget, deadline, lane_authority,
      token_reserved, byte_reserved, next_root_completion_sequence,
      state, revision, created_at, updated_at, stopped_at
    ) VALUES (
      ?1, ?2, ?3, ?4, 3, 8, 50, 100000, ?5, ?6,
      'managedWrite', 0, 0, 1, 'active', 1, ?7, ?7, NULL
    )
  `).run(
    input.epochId,
    projectId,
    "a".repeat(40),
    input.actorId,
    input.byteBudget,
    deadline,
    at,
  );
  database.query(`
    INSERT INTO harness_actors (
      actor_id, epoch_id, parent_actor_id, depth, title, state,
      max_depth, max_active_descendants, max_durable_descendants,
      token_budget, byte_budget, deadline, lane_authority,
      token_reserved, byte_reserved, next_turn_ordinal, next_result_ordinal,
      revision, created_at, updated_at, stopped_at
    ) VALUES (
      ?1, ?2, NULL, 0, 'Root actor', 'active', 3, 8, 50,
      100000, ?3, ?4, 'managedWrite', 0, 0, 1, 1,
      1, ?5, ?5, NULL
    )
  `).run(input.actorId, input.epochId, input.byteBudget, deadline, at);
}

function memorySecrets(): Readonly<{
  secrets: HarnessSecretStore;
  read: () => string | null;
}> {
  let value: string | null = null;
  return {
    secrets: {
      get: () => Promise.resolve(value),
      set: (input) => {
        value = input.value;
        return Promise.resolve();
      },
      delete: () => {
        const existed = value !== null;
        value = null;
        return Promise.resolve(existed);
      },
    },
    read: () => value,
  };
}

async function rejection(operation: Promise<unknown>): Promise<unknown> {
  try {
    await operation;
  } catch (error: unknown) {
    return error;
  }
  throw new Error("expected operation to reject");
}

describe("production context adapters v2", () => {
  test("derives deterministic actor-scoped name HMACs without persisting names", async () => {
    const master = Uint8Array.from({ length: 32 }, (_, index) => index + 1);
    const memory = memorySecrets();
    const custody = new HarnessInstallKeyCustody({
      secrets: memory.secrets,
      randomMaster: () => Uint8Array.from(master),
    });
    const scopes: unknown[] = [];
    const keys: HarnessContextKeyProvider = {
      withContextKey: async (scope, operation) => {
        scopes.push(scope);
        return await custody.withContextKey(scope, operation);
      },
    };
    const names = new HarnessContextValueNameDigesterV2(keys);
    const name = "private/research-plan";
    const input = { epochId, ownerActorId: actorId, name };
    const first = await names.digestName(input);
    expect(await names.digestName(input)).toBe(first);
    expect(first).toMatch(/^[a-f0-9]{64}$/u);
    expect(scopes).toEqual([
      { epochId, ownerActorId: actorId, sourceTurnId: null },
      { epochId, ownerActorId: actorId, sourceTurnId: null },
    ]);

    const contextKey = deriveHarnessContextScopeKey(master, {
      epochId,
      ownerActorId: actorId,
      sourceTurnId: null,
    });
    const digestKey = deriveHarnessContextDigestKey(contextKey);
    contextKey.fill(0);
    const expected = createHmac("sha256", digestKey).update(JSON.stringify({
      domain: LEGACY_OPRTE_CONTEXT_VALUE_NAME_HMAC_DOMAIN_V2,
      version: 2,
      epochId,
      ownerActorId: actorId,
      sourceTurnId: null,
      name,
    }), "utf8").digest("hex");
    digestKey.fill(0);
    expect(first).toBe(expected);

    expect(await names.digestName({
      epochId: siblingEpochId,
      ownerActorId: actorId,
      name,
    })).not.toBe(first);
    expect(await names.digestName({
      epochId,
      ownerActorId: siblingActorId,
      name,
    })).not.toBe(first);
    expect(memory.read()).not.toContain(name);

    const unavailable = new HarnessContextValueNameDigesterV2({
      withContextKey: () => Promise.reject(new Error(name)),
    });
    expect(await rejection(unavailable.digestName(input))).toMatchObject({
      code: "key_unavailable",
      message: "The context-name digest key is unavailable.",
    } satisfies Partial<HarnessProductionContextAdapterV2Error>);
    expect(await rejection(names.digestName({ ...input, name: " bad" })))
      .toMatchObject({
        code: "invalid_request",
        message: "The production context request is invalid.",
      } satisfies Partial<HarnessProductionContextAdapterV2Error>);
  });

  test("returns the whole-MiB minimum of live settings and actor authority", async () => {
    const database = openDatabase();
    try {
      const quotas = new HarnessContextValueQuotaAuthorityV2(database);
      database.query(`
        UPDATE harness_settings SET context_quota_bytes = ?1
        WHERE singleton = 1
      `).run(24 * MIB);
      expect(await quotas.resolveQuotaLimit({
        epochId,
        ownerActorId: actorId,
      })).toBe(16 * MIB);
      database.query(`
        UPDATE harness_settings SET context_quota_bytes = ?1
        WHERE singleton = 1
      `).run(8 * MIB);
      expect(await quotas.resolveQuotaLimit({
        epochId,
        ownerActorId: actorId,
      })).toBe(8 * MIB);
    } finally {
      database.close();
    }
  });

  test("fails closed for missing, non-live, or incompatible quota authority", async () => {
    const database = openDatabase();
    try {
      const quotas = new HarnessContextValueQuotaAuthorityV2(database);
      database.query(`
        UPDATE harness_actors SET state = 'stopRequested'
        WHERE actor_id = ?1
      `).run(actorId);
      expect(await rejection(quotas.resolveQuotaLimit({
        epochId,
        ownerActorId: actorId,
      }))).toMatchObject({
        code: "quota_unavailable",
        message: "The context-value quota authority is unavailable.",
      } satisfies Partial<HarnessProductionContextAdapterV2Error>);

      database.query(`
        UPDATE harness_actors SET state = 'active'
        WHERE actor_id = ?1
      `).run(actorId);
      database.query(`
        UPDATE harness_actor_epochs SET state = 'stopRequested'
        WHERE epoch_id = ?1
      `).run(epochId);
      expect(await rejection(quotas.resolveQuotaLimit({
        epochId,
        ownerActorId: actorId,
      }))).toMatchObject({ code: "quota_unavailable" });

      database.query(`
        UPDATE harness_actor_epochs SET state = 'active'
        WHERE epoch_id = ?1
      `).run(epochId);
      database.exec("PRAGMA ignore_check_constraints = ON");
      database.query(`
        UPDATE harness_actors SET byte_budget = ?1
        WHERE actor_id = ?2
      `).run(MIB + MIB / 2, actorId);
      database.exec("PRAGMA ignore_check_constraints = OFF");
      expect(await rejection(quotas.resolveQuotaLimit({
        epochId,
        ownerActorId: actorId,
      }))).toMatchObject({ code: "quota_unavailable" });

      database.query("DELETE FROM harness_settings WHERE singleton = 1").run();
      expect(await rejection(quotas.resolveQuotaLimit({
        epochId,
        ownerActorId: actorId,
      }))).toMatchObject({ code: "quota_unavailable" });
    } finally {
      database.close();
    }
  });

  test("rejects ambiguous joined authority and invalid requests with fixed errors", async () => {
    const database = new Database(":memory:", { strict: true });
    try {
      database.exec(`
        CREATE TABLE harness_settings (
          singleton INTEGER,
          context_quota_bytes INTEGER
        ) STRICT;
        CREATE TABLE harness_actor_epochs (
          epoch_id TEXT,
          state TEXT
        ) STRICT;
        CREATE TABLE harness_actors (
          actor_id TEXT,
          epoch_id TEXT,
          state TEXT,
          byte_budget INTEGER
        ) STRICT;
      `);
      database.query(`
        INSERT INTO harness_actor_epochs (epoch_id, state)
        VALUES (?1, 'active')
      `).run(epochId);
      database.query(`
        INSERT INTO harness_actors (actor_id, epoch_id, state, byte_budget)
        VALUES (?1, ?2, 'active', ?3)
      `).run(actorId, epochId, 8 * MIB);
      database.query(`
        INSERT INTO harness_settings (singleton, context_quota_bytes)
        VALUES (1, ?1), (1, ?1)
      `).run(8 * MIB);
      const quotas = new HarnessContextValueQuotaAuthorityV2(database);
      expect(await rejection(quotas.resolveQuotaLimit({
        epochId,
        ownerActorId: actorId,
      }))).toMatchObject({ code: "quota_unavailable" });

      expect(await rejection(quotas.resolveQuotaLimit({
        epochId: "bad",
        ownerActorId: actorId,
      }))).toMatchObject({
        code: "invalid_request",
        message: "The production context request is invalid.",
      } satisfies Partial<HarnessProductionContextAdapterV2Error>);
    } finally {
      database.close();
    }
  });
});
