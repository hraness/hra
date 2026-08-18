import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  deriveRootActorTurnId,
  HarnessRootActorAuthorityV2,
} from "../src/harness/root-actor-authority-v2";
import {
  RootTurnRoutingAuthorityV1Error,
  RootTurnRoutingSQLiteAuthorityV1,
} from "../src/harness/root-turn-routing-sqlite-v1";
import { ChatPaneStore } from "../src/state/chat-pane-store";
import { applyMigrations } from "../src/state/database";
import { migrations } from "../src/state/migrations";
import { CHAT_MAX_TURN_RECEIPTS_PER_PANE } from "../src/chat/types";

const at = new Date("2030-01-01T00:00:00.000Z");
const later = new Date("2030-01-01T00:00:01.000Z");
const paneId = "pane_root_route_receipt01";
const otherPaneId = "pane_root_route_receipt02";
const chatTurnId = "chatturn_root_route_receipt0001";
const otherChatTurnId = "chatturn_root_route_receipt0002";
const projectId = "project-root-route-receipt";
const sourceSha = "a".repeat(40);
const inputValueId = "ctxval_root_route_receipt01";

const repository = Object.freeze({
  id: `repo_${"1".repeat(26)}`,
  name: "Root route",
  workingDirectory: "/tmp/root-route",
});

const budget = Object.freeze({
  depthRemaining: 3,
  activeDescendantLimit: 8,
  durableDescendantLimit: 50,
  tokenBudget: 100_000,
  deadline: "2030-01-02T00:00:00.000Z",
  heapByteLimit: 16 * 1024 * 1024,
  contextValueByteLimit: 1024 * 1024,
  messageByteLimit: 128 * 1024,
  laneAuthority: "managedWrite" as const,
});

function database(path = ":memory:"): Database {
  const value = new Database(path, { strict: true });
  value.exec("PRAGMA foreign_keys = ON");
  applyMigrations(value);
  return value;
}

function createPane(
  value: Database,
  id = paneId,
): ChatPaneStore {
  const store = new ChatPaneStore(value);
  store.create({
    paneId: id,
    repository: id === paneId
      ? repository
      : { ...repository, id: `repo_${"2".repeat(26)}` },
    accountProfileId: null,
    now: at,
  });
  return store;
}

function classification(
  id = paneId,
  turnId = chatTurnId,
  now = at,
) {
  return {
    paneId: id,
    chatTurnId: turnId,
    policyVersion: 1 as const,
    classificationReason: "conservativeDefault" as const,
    workClass: "standard" as const,
    requestedProfile: "solMax" as const,
    requestedServiceTier: "standard" as const,
    now,
  };
}

function seedRootTurn(value: Database): Readonly<{
  rootTurnId: string;
  rootEpochId: string;
}> {
  value.query(`
    INSERT INTO projects (
      project_id, canonical_repository_path, canonical_git_common_dir,
      display_name, created_at, updated_at
    ) VALUES (?1, '/tmp/root-route', '/tmp/root-route/.git',
      'Root route', ?2, ?2)
  `).run(projectId, at.toISOString());
  const roots = new HarnessRootActorAuthorityV2(value, {
    now: () => at,
  });
  const preparation = {
    projectId,
    sourceSha,
    paneId,
    chatTurnId,
    title: "Root route",
    budget,
    createdAt: at.toISOString(),
  };
  const prepared = roots.prepareRoot(preparation);
  seedActiveValue(value, prepared.epoch.id, prepared.actor.id);
  const admitted = roots.admitRoot({
    ...preparation,
    inputValueId,
  });
  return {
    rootTurnId: admitted.turn.id,
    rootEpochId: admitted.epoch.id,
  };
}

function seedActiveValue(
  value: Database,
  epochId: string,
  actorId: string,
): void {
  value.query(`
    INSERT INTO harness_context_values (
      value_id, operation_id, epoch_id, owner_actor_id, source_turn_id,
      kind, purpose, schema_version, name_digest, utf8_bytes,
      content_digest, chunk_size, chunk_count, manifest_digest,
      manifest_byte_length, quota_limit_bytes, state, recovery_reason,
      revision, created_at, updated_at, effect_started_at, activated_at
    ) VALUES (
      ?1, 'op_root_route_receipt01', ?2, ?3, NULL,
      'text', 'currentInput', 1, NULL, 5,
      ?4, 65536, 1, ?5, 64, 16777216, 'active', NULL,
      3, ?6, ?6, ?6, ?6
    )
  `).run(
    inputValueId,
    epochId,
    actorId,
    "4".repeat(64),
    "5".repeat(64),
    at.toISOString(),
  );
  value.query(`
    INSERT INTO harness_context_value_chunks (
      value_id, ordinal, plaintext_bytes, object_digest, object_byte_length
    ) VALUES (?1, 0, 5, ?2, 32)
  `).run(inputValueId, "6".repeat(64));
}

describe("RootTurnRoutingSQLiteAuthorityV1", () => {
  test("persists every provider cut, exact-replays, and reopens without identity", () => {
    const directory = mkdtempSync(join(tmpdir(), "hra-root-route-"));
    const path = join(directory, "control-plane.sqlite3");
    let value = database(path);
    try {
      createPane(value);
      const root = seedRootTurn(value);
      const authority = new RootTurnRoutingSQLiteAuthorityV1(value);
      const classified = authority.admitClassification(classification());
      expect(authority.admitClassification(classification(paneId, chatTurnId, later)))
        .toEqual(classified);
      expect(() => authority.admitClassification({
        ...classification(),
        workClass: "wideResearch",
        classificationReason: "wideResearchCue",
        requestedProfile: "solUltra",
      })).toThrow(RootTurnRoutingAuthorityV1Error);
      expect(() => authority.admitClassification({
        ...classification(),
        classificationReason: "continuationInherited",
        workClass: "boundedLeaf",
        requestedProfile: "lunaMax",
        requestedServiceTier: "standard",
      })).toThrow(RootTurnRoutingAuthorityV1Error);
      expect(() => authority.admitClassification({
        ...classification(),
        classificationReason: "continuationInherited",
        workClass: "largeChange",
        requestedProfile: "solUltra",
        requestedServiceTier: "fast",
      })).toThrow(RootTurnRoutingAuthorityV1Error);

      authority.bindRootTurn({
        paneId,
        chatTurnId,
        rootTurnId: root.rootTurnId,
        now: later,
      });
      authority.resolve({
        paneId,
        chatTurnId,
        selectedProfile: "solMax",
        profileFallbackReason: null,
        selectedServiceTier: "standard",
        serviceTierFallbackReason: null,
        now: later,
      });
      authority.markEffectStarted({ paneId, chatTurnId, now: later });
      const accepted = authority.accept({
        paneId,
        chatTurnId,
        acceptedGeneration: 7,
        acceptedStreamPosition: 19,
        now: later,
      });
      expect(authority.accept({
        paneId,
        chatTurnId,
        acceptedGeneration: 7,
        acceptedStreamPosition: 19,
        now: at,
      })).toEqual(accepted);
      expect(() => authority.accept({
        paneId,
        chatTurnId,
        acceptedGeneration: 7,
        acceptedStreamPosition: 20,
        now: later,
      })).toThrow(/different accepted response cursor/i);
      const terminal = authority.settle({
        paneId,
        chatTurnId,
        outcome: "succeeded",
        now: later,
      });
      expect(terminal).toMatchObject({
        rootTurnId: root.rootTurnId,
        state: "terminal",
        operationalOutcome: "succeeded",
        selectedProfile: "solMax",
        acceptedGeneration: 7,
        acceptedStreamPosition: 19,
      });
      expect(JSON.stringify(terminal)).not.toMatch(
        /secret user text|account_profile|provider_turn|repository_id|workingDirectory/iu,
      );
      value.close();
      value = database(path);
      expect(new RootTurnRoutingSQLiteAuthorityV1(value)
        .readTurnRouting(paneId, chatTurnId)).toEqual(terminal);
    } finally {
      value.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("binds only the derived root turn attached to the exact pane", () => {
    const value = database();
    try {
      createPane(value);
      createPane(value, otherPaneId);
      const root = seedRootTurn(value);
      const authority = new RootTurnRoutingSQLiteAuthorityV1(value);
      authority.admitClassification(classification(otherPaneId));
      expect(() => authority.bindRootTurn({
        paneId: otherPaneId,
        chatTurnId,
        rootTurnId: root.rootTurnId,
        now: later,
      })).toThrow(/exact pane chat turn/i);

      authority.admitClassification(classification(paneId, otherChatTurnId));
      expect(root.rootTurnId).not.toBe(
        deriveRootActorTurnId(root.rootEpochId, otherChatTurnId),
      );
      expect(() => authority.bindRootTurn({
        paneId,
        chatTurnId: otherChatTurnId,
        rootTurnId: root.rootTurnId,
        now: later,
      })).toThrow(/exact pane chat turn/i);

      expect(() => value.query(`
        UPDATE harness_root_turn_routing_receipts
        SET root_turn_id = ?1
        WHERE pane_id = ?2 AND chat_turn_id = ?3
      `).run(root.rootTurnId, otherPaneId, chatTurnId)).toThrow(
        /root routing turn binding is immutable/i,
      );
    } finally {
      value.close();
    }
  });

  test("enforces provider-side transitions against direct SQL", () => {
    const value = database();
    try {
      createPane(value);
      const authority = new RootTurnRoutingSQLiteAuthorityV1(value);
      authority.admitClassification(classification());
      expect(() => authority.settle({
        paneId,
        chatTurnId,
        outcome: "failed",
        now: later,
      })).toThrow(/requires a started provider effect/i);
      expect(() => value.query(`
        UPDATE harness_root_turn_routing_receipts
        SET state = 'terminal', operational_outcome = 'failed',
          settled_at = ?1, updated_at = ?1
        WHERE pane_id = ?2 AND chat_turn_id = ?3
      `).run(later.toISOString(), paneId, chatTurnId)).toThrow(
        /invalid root routing transition/i,
      );
      expect(authority.settle({
        paneId,
        chatTurnId,
        outcome: "notApplied",
        now: later,
      })).toMatchObject({ state: "notApplied", operationalOutcome: "notApplied" });
      expect(() => authority.markEffectStarted({ paneId, chatTurnId, now: later }))
        .toThrow(/requires a resolved root route/i);
    } finally {
      value.close();
    }
  });

  test("classifies exactly once inside ordinary turn admission", () => {
    const value = database();
    try {
      const store = createPane(value);
      const begun = store.beginTurn({
        paneId,
        expectedRevision: 1,
        turnId: chatTurnId,
        prompt: "Fix one tooltip label.",
        now: at,
      });
      expect(begun.pane.turn?.routing).toMatchObject({
        classificationReason: "boundedLeafCue",
        requestedProfile: "lunaMax",
        requestedServiceTier: "fast",
        selectedProfile: null,
        selectedServiceTier: null,
      });
      expect(value.query(`
        SELECT COUNT(*) AS count
        FROM harness_root_turn_routing_receipts WHERE pane_id = ?1
      `).get(paneId)).toEqual({ count: 1 });
    } finally {
      value.close();
    }
  });

  test("recovers each crash cut from the exact active turn", () => {
    const value = database();
    try {
      const store = new ChatPaneStore(value);
      const authority = new RootTurnRoutingSQLiteAuthorityV1(value);
      const states = ["classified", "resolved", "effectStarted", "accepted"] as const;
      for (const [index, state] of states.entries()) {
        const id = `pane_route_crash_cut_${index}01`;
        const turnId = `chatturn_route_crash_cut_${index}001`;
        store.create({
          paneId: id,
          repository: { ...repository, id: `repo_${String(index + 3).repeat(26)}` },
          accountProfileId: null,
          now: at,
        });
        store.beginTurn({
          paneId: id,
          expectedRevision: 1,
          turnId,
          prompt: "bounded",
          now: at,
        });
        if (state !== "classified") {
          authority.resolve({
            paneId: id,
            chatTurnId: turnId,
            selectedProfile: "solMax",
            profileFallbackReason: null,
            selectedServiceTier: "standard",
            serviceTierFallbackReason: null,
            now: later,
          });
        }
        if (state === "effectStarted" || state === "accepted") {
          authority.markEffectStarted({ paneId: id, chatTurnId: turnId, now: later });
        }
        if (state === "accepted") {
          authority.accept({
            paneId: id,
            chatTurnId: turnId,
            acceptedGeneration: 1,
            acceptedStreamPosition: 1,
            now: later,
          });
        }
        expect(store.require(id).projection.turn?.routing).toMatchObject({
          policyVersion: 1,
          classificationReason: "conservativeDefault",
          workClass: "standard",
          requestedProfile: "solMax",
          selectedProfile: state === "classified" ? null : "solMax",
          profileFallbackReason: null,
          requestedServiceTier: "standard",
          selectedServiceTier: state === "classified" ? null : "standard",
          serviceTierFallbackReason: null,
        });
      }
      expect(store.recoverInterrupted(new Date("2030-01-01T00:00:02.000Z")))
        .toHaveLength(4);
      expect(states.map((_, index) => authority.readTurnRouting(
        `pane_route_crash_cut_${index}01`,
        `chatturn_route_crash_cut_${index}001`,
      )?.operationalOutcome)).toEqual([
        "notApplied",
        "notApplied",
        "ambiguous",
        "interrupted",
      ]);
    } finally {
      value.close();
    }
  });

  test("outlives bounded chat receipts but follows pane privacy deletion", () => {
    const value = database();
    try {
      const store = createPane(value);
      let revision = 1;
      const turns = CHAT_MAX_TURN_RECEIPTS_PER_PANE + 2;
      for (let index = 0; index < turns; index += 1) {
        const turnId = `chatturn_route_prune_${String(index).padStart(4, "0")}`;
        const now = new Date(at.getTime() + index * 2);
        const begun = store.beginTurn({
          paneId,
          expectedRevision: revision,
          turnId,
          prompt: "bounded",
          now,
        });
        revision = begun.pane.revision;
        const failed = store.enterAttention({
          paneId,
          turnId,
          attention: {
            code: "turn_failed",
            message: "Stopped for receipt pruning.",
            retryable: false,
          },
          clearBinding: false,
          now: new Date(at.getTime() + index * 2 + 1),
        });
        revision = failed?.revision ?? revision;
      }
      expect(value.query(`
        SELECT COUNT(*) AS count FROM chat_turn_receipts WHERE pane_id = ?1
      `).get(paneId)).toEqual({ count: CHAT_MAX_TURN_RECEIPTS_PER_PANE });
      expect(value.query(`
        SELECT COUNT(*) AS count
        FROM harness_root_turn_routing_receipts WHERE pane_id = ?1
      `).get(paneId)).toEqual({ count: turns });
      expect(() => store.beginTurn({
        paneId,
        expectedRevision: revision,
        turnId: "chatturn_route_prune_0000",
        prompt: "bounded",
        now: new Date(at.getTime() + turns * 2),
      })).toThrow(/durable routing history/i);
      expect(value.query(`
        SELECT COUNT(*) AS count
        FROM harness_root_turn_routing_receipts WHERE pane_id = ?1
      `).get(paneId)).toEqual({ count: turns });
      store.remove(
        paneId,
        store.require(paneId).projection.revision,
        later,
      );
      expect(value.query(`
        SELECT COUNT(*) AS count
        FROM harness_root_turn_routing_receipts WHERE pane_id = ?1
      `).get(paneId)).toEqual({ count: 0 });
    } finally {
      value.close();
    }
  });

  test("uses bounded timeline, recovery, and arm indexes", () => {
    const value = database();
    try {
      createPane(value);
      new RootTurnRoutingSQLiteAuthorityV1(value)
        .admitClassification(classification());
      const plans = [
        value.query(`
          EXPLAIN QUERY PLAN
          SELECT * FROM harness_root_turn_routing_receipts
          WHERE pane_id = ?1
          ORDER BY created_at DESC, chat_turn_id DESC LIMIT 1
        `).all(paneId),
        value.query(`
          EXPLAIN QUERY PLAN
          SELECT * FROM harness_root_turn_routing_receipts
          WHERE state IN ('classified', 'resolved', 'effectStarted', 'accepted')
          ORDER BY updated_at, pane_id, chat_turn_id LIMIT 64
        `).all(),
        value.query(`
          EXPLAIN QUERY PLAN
          SELECT * FROM harness_root_turn_routing_receipts
          WHERE work_class = 'standard' AND requested_profile = 'solMax'
        `).all(),
      ].map((plan) => JSON.stringify(plan));
      expect(plans[0]).toContain("harness_root_turn_routing_pane_timeline_idx");
      expect(plans[1]).toContain("harness_root_turn_routing_recovery_idx");
      expect(plans[2]).toContain("harness_root_turn_routing_arm_idx");
    } finally {
      value.close();
    }
  });
});

describe("root-turn routing migration", () => {
  test("adds the receipt ledger without adding a pane routing preference", () => {
    const value = new Database(":memory:", { strict: true });
    value.exec("PRAGMA foreign_keys = ON");
    try {
      for (const migration of migrations) {
        if (migration.version > 44) break;
        value.exec(migration.sql);
      }
      value.query(`
        INSERT INTO chat_panes (
          pane_id, display_order, repository_id, repository_name,
          revision, title, account_profile_id, model, reasoning_effort,
          service_tier, interaction_mode, state, workspace_mode,
          workspace_state, workspace_revision, workspace_recovery_reason,
          created_at, updated_at
        ) VALUES (
          ?1, 0, ?2, 'Root route', 1, 'Root route', NULL,
          'gpt-5.6-sol', 'max', 'standard', 'chat', 'ready',
          'managed_worktree', 'preparing', 1, NULL, ?3, ?3
        )
      `).run(paneId, repository.id, at.toISOString());
      const migration = migrations.find(({ version }) => version === 45);
      if (migration === undefined) throw new Error("migration 45 is missing");
      value.exec(migration.sql);
      const paneColumns = value.query("PRAGMA table_info(chat_panes)").all()
        .map((column) => String((column as { name: unknown }).name));
      expect(paneColumns).not.toContain("routing_mode");
      expect(value.query(`
        SELECT name FROM sqlite_schema
        WHERE type = 'table' AND name = 'harness_root_turn_routing_receipts'
      `).get()).toEqual({ name: "harness_root_turn_routing_receipts" });
    } finally {
      value.close();
    }
  });
});
