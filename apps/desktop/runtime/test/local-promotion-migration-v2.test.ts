import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";

import { applyMigrations } from "../src/state/database";

const INSTALLATION_ID = "install_promotion_migration";
const WORKSPACE_ID = "wsp_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const IDEMPOTENCY_KEY = "018f22e2-7b44-7cc0-8e5d-657f31f9064a"; // gitleaks:allow - deterministic test vector

function database(): Database {
  const value = new Database(":memory:", { strict: true });
  value.exec("PRAGMA foreign_keys = ON");
  applyMigrations(value);
  value.query(`
    INSERT INTO local_installations (
      installation_id, created_at, updated_at
    ) VALUES (?1, 1, 1)
  `).run(INSTALLATION_ID);
  value.query(`
    INSERT INTO local_workspaces (
      workspace_id, name, slug, key_prefix, authority_kind,
      owner_installation_id, created_at, updated_at
    ) VALUES (?1, 'Migration', 'migration', 'MIG', 'local', ?2, 1, 1)
  `).run(WORKSPACE_ID, INSTALLATION_ID);
  return value;
}

function insertSession(
  value: Database,
  input: Readonly<{
    promotionId: string;
    state: "snapshot_frozen" | "activated" | "aborted";
    createdAt: number;
    schemaVersion?: 1 | 2;
    cloudWorkspaceId?: string;
  }>,
): void {
  value.query(`
    INSERT INTO local_promotion_sessions (
      promotion_id, schema_version, workspace_id, state,
      destination_organization_id, cloud_workspace_id,
      source_workspace_revision, source_event_sequence,
      created_at, updated_at
    ) VALUES (?1, ?2, ?3, ?4, 'org_destination', ?5, 1, 1, ?6, ?6)
  `).run(
    input.promotionId,
    input.schemaVersion ?? 2,
    WORKSPACE_ID,
    input.state,
    input.cloudWorkspaceId ?? null,
    input.createdAt,
  );
}

describe("local promotion v2 migration", () => {
  test("retains terminal history while permitting only one live promotion", () => {
    const value = database();
    try {
      insertSession(value, {
        promotionId: "promotion_terminal_1",
        state: "aborted",
        createdAt: 2,
      });
      insertSession(value, {
        promotionId: "promotion_terminal_2",
        state: "aborted",
        createdAt: 3,
      });
      insertSession(value, {
        promotionId: "promotion_live_1",
        state: "snapshot_frozen",
        createdAt: 4,
      });
      expect(() => insertSession(value, {
        promotionId: "promotion_live_2",
        state: "snapshot_frozen",
        createdAt: 5,
      })).toThrow("UNIQUE constraint failed");
      expect(value.query<{ count: number }, []>(`
        SELECT count(*) AS count FROM local_promotion_sessions
      `).get()?.count).toBe(3);
    } finally {
      value.close();
    }
  });

  test("keeps the v1 session table synchronized for the legacy store", () => {
    const value = database();
    try {
      insertSession(value, {
        promotionId: "promotion_legacy_compat",
        state: "snapshot_frozen",
        createdAt: 2,
        schemaVersion: 1,
      });
      expect(value.query<{
        state: string;
        workspace_id: string;
      }, [string]>(`
        SELECT state, workspace_id FROM local_promotion_sessions_v1
        WHERE promotion_id = ?1
      `).get("promotion_legacy_compat")).toEqual({
        state: "snapshot_frozen",
        workspace_id: WORKSPACE_ID,
      });
      value.query(`
        UPDATE local_promotion_sessions
        SET state = 'aborted', updated_at = 3
        WHERE promotion_id = ?1
      `).run("promotion_legacy_compat");
      expect(value.query<{ state: string }, [string]>(`
        SELECT state FROM local_promotion_sessions_v1
        WHERE promotion_id = ?1
      `).get("promotion_legacy_compat")?.state).toBe("aborted");
    } finally {
      value.close();
    }
  });

  test("enforces token-free, revision-bound human metadata journals", () => {
    const value = database();
    try {
      const account = JSON.stringify({
        version: 1,
        revision: 0,
        credentialGeneration: 0,
        profile: null,
      });
      value.query(`
        INSERT INTO human_account_metadata (
          singleton, revision, credential_generation, metadata_json, updated_at
        ) VALUES (1, 0, 0, ?1, 1)
      `).run(account);
      expect(() => value.query(`
        UPDATE human_account_metadata
        SET metadata_json = ?1
        WHERE singleton = 1
      `).run(JSON.stringify({
        version: 1,
        revision: 0,
        credentialGeneration: 0,
        profile: { accessToken: "must-never-enter-sqlite" },
      }))).toThrow("secret-bearing account metadata");

      const journal = JSON.stringify({
        version: 1,
        revision: 0,
        latestGeneration: 0,
        service: "kitchen.hraness.cloud-human.v1",
        name: "primary",
      });
      value.query(`
        INSERT INTO human_custody_metadata (
          service, name, revision, latest_generation, journal_json, updated_at
        ) VALUES (
          'kitchen.hraness.cloud-human.v1', 'primary', 0, 0, ?1, 1
        )
      `).run(journal);
      expect(() => value.query(`
        UPDATE human_custody_metadata
        SET journal_json = ?1
        WHERE service = 'kitchen.hraness.cloud-human.v1' AND name = 'primary'
      `).run(JSON.stringify({
        version: 1,
        revision: 0,
        latestGeneration: 0,
        service: "kitchen.hraness.cloud-human.v1",
        name: "primary",
        refreshToken: "must-never-enter-sqlite",
      }))).toThrow("secret-bearing custody metadata");
      expect(() => value.query(`
        UPDATE human_custody_metadata
        SET revision = 1
        WHERE service = 'kitchen.hraness.cloud-human.v1' AND name = 'primary'
      `).run()).toThrow("CHECK constraint failed");
    } finally {
      value.close();
    }
  });

  test("binds normal cloud operation replay to a digest and UUIDv7 key", () => {
    const value = database();
    try {
      value.query(`
        INSERT INTO cloud_human_operation_receipts (
          operation_id, workspace_id, command_kind, keyed_command_digest,
          http_idempotency_key, state, created_at, updated_at
        ) VALUES (
          'operation_started', 'wsp_cloud', 'task.create', ?1, ?2,
          'started', 1, 1
        )
      `).run("a".repeat(64), IDEMPOTENCY_KEY);
      expect(() => value.query(`
        INSERT INTO cloud_human_operation_receipts (
          operation_id, workspace_id, command_kind, keyed_command_digest,
          http_idempotency_key, state, created_at, updated_at
        ) VALUES (
          'operation_replay_conflict', 'wsp_cloud', 'task.update', ?1, ?2,
          'started', 2, 2
        )
      `).run("b".repeat(64), IDEMPOTENCY_KEY)).toThrow(
        "UNIQUE constraint failed",
      );
      expect(() => value.query(`
        INSERT INTO cloud_human_operation_receipts (
          operation_id, workspace_id, command_kind, keyed_command_digest,
          http_idempotency_key, state, response_json,
          created_at, updated_at, completed_at
        ) VALUES (
          'operation_bad_uuid', 'wsp_cloud', 'task.create', ?1,
          '018f22e2-7b44-4cc0-8e5d-657f31f9064a',
          'succeeded', '{}', 3, 3, 3
        )
      `).run("c".repeat(64))).toThrow("CHECK constraint failed");
      expect(() => value.query(`
        UPDATE cloud_human_operation_receipts
        SET state = 'succeeded', response_json = '{}', completed_at = 2,
          updated_at = 2
        WHERE operation_id = 'operation_started'
      `).run()).not.toThrow();
      expect(value.query<{ state: string }, [string]>(`
        SELECT state FROM cloud_human_operation_receipts
        WHERE operation_id = ?1
      `).get("operation_started")?.state).toBe("succeeded");
    } finally {
      value.close();
    }
  });

  test("persists cloud-only invalidation heads without local workspace coupling", () => {
    const value = database();
    try {
      value.query(`
        INSERT INTO cloud_invalidation_heads (
          workspace_id, account_user_id, credential_generation,
          projection_head, updated_at
        ) VALUES ('wsp_cloud_only', 'user_cloud', 7, 0, 1)
      `).run();
      value.query(`
        UPDATE cloud_invalidation_heads
        SET projection_head = 42, updated_at = 2
        WHERE workspace_id = 'wsp_cloud_only'
          AND account_user_id = 'user_cloud'
          AND credential_generation = 7
      `).run();
      expect(value.query<{ projection_head: number }, [string]>(`
        SELECT projection_head FROM cloud_invalidation_heads
        WHERE workspace_id = ?1
      `).get("wsp_cloud_only")?.projection_head).toBe(42);
      expect(() => value.query(`
        UPDATE cloud_invalidation_heads SET projection_head = -1
        WHERE workspace_id = 'wsp_cloud_only'
      `).run()).toThrow("CHECK constraint failed");
    } finally {
      value.close();
    }
  });

  test("durably reuses a token-free create-organization UUIDv7", () => {
    const value = database();
    try {
      value.query(`
        INSERT INTO human_organization_operations (
          operation_id, name, http_idempotency_key, state,
          created_at, updated_at
        ) VALUES ('operation_create_org', 'OPRTE Team', ?1, 'started', 1, 1)
      `).run(IDEMPOTENCY_KEY);
      expect(() => value.query(`
        INSERT INTO human_organization_operations (
          operation_id, name, http_idempotency_key, state,
          created_at, updated_at
        ) VALUES ('operation_conflict', 'Other Team', ?1, 'started', 2, 2)
      `).run(IDEMPOTENCY_KEY)).toThrow("UNIQUE constraint failed");
      expect(() => value.query(`
        UPDATE human_organization_operations
        SET state = 'succeeded', response_json = ?1,
          updated_at = 3, completed_at = 3
        WHERE operation_id = 'operation_create_org'
      `).run(JSON.stringify({
        organization: {
          id: "org_oprte",
          accessToken: "must-never-enter-sqlite",
        },
      }))).toThrow("secret-bearing organization response");
      value.query(`
        UPDATE human_organization_operations
        SET state = 'succeeded', response_json = ?1,
          updated_at = 3, completed_at = 3
        WHERE operation_id = 'operation_create_org'
      `).run(JSON.stringify({
        organization: { id: "org_oprte", name: "OPRTE Team" },
      }));
      expect(value.query<{ state: string }, [string]>(`
        SELECT state FROM human_organization_operations
        WHERE operation_id = ?1
      `).get("operation_create_org")?.state).toBe("succeeded");
    } finally {
      value.close();
    }
  });
});
