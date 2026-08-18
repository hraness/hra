import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";

import {
  HarnessRootActorAuthorityV2,
} from "../src/harness/root-actor-authority-v2";
import {
  HarnessRootSessionLifecycleV2,
} from "../src/harness/root-session-lifecycle-v2";
import {
  HarnessRootSessionSQLiteLookupV2,
} from "../src/harness/root-session-sqlite-lookup-v2";
import { HarnessSQLiteAuthorityV2 } from "../src/harness/sqlite-authority-v2";
import { ChatPaneStore } from "../src/state/chat-pane-store";
import { applyMigrations } from "../src/state/database";

const at = "2032-01-01T00:00:00.000Z";
const later = "2032-01-01T00:01:00.000Z";
const deadline = "2032-01-02T00:00:00.000Z";
const projectId = "project-root-lookup-v2";
const paneId = "pane_root_lookup_v2_01";
const chatTurnId = "chatturn_root_lookup_v2_0001";
const inputValueId = "ctxval_root_lookup_input01";
const firstAccountId = "acct_root_lookup_v2_first";
const secondAccountId = "acct_root_lookup_v2_second";
const firstThreadId = "thread_root_lookup_v2_first";
const firstTurnId = "turn_root_lookup_v2_first";
const secondThreadId = "thread_root_lookup_v2_second";
const secondTurnId = "turn_root_lookup_v2_second";

const budget = {
  depthRemaining: 3,
  activeDescendantLimit: 8,
  durableDescendantLimit: 50,
  tokenBudget: 100_000,
  deadline,
  heapByteLimit: 16 * 1024 * 1024,
  contextValueByteLimit: 1024 * 1024,
  messageByteLimit: 128 * 1024,
  laneAuthority: "managedWrite" as const,
};

function fixture(): Readonly<{
  actors: HarnessSQLiteAuthorityV2;
  database: Database;
  roots: HarnessRootActorAuthorityV2;
  store: ChatPaneStore;
}> {
  const database = new Database(":memory:", { strict: true });
  database.exec("PRAGMA foreign_keys = ON");
  applyMigrations(database);
  database.query(`
    INSERT INTO projects (
      project_id, canonical_repository_path, canonical_git_common_dir,
      display_name, created_at, updated_at
    ) VALUES (?1, '/tmp/root-lookup-v2', '/tmp/root-lookup-v2/.git',
      'Root lookup', ?2, ?2)
  `).run(projectId, at);
  for (const [accountId, selected] of [
    [firstAccountId, 1],
    [secondAccountId, 0],
  ] as const) {
    database.query(`
      INSERT INTO account_profiles (
        profile_id, label, auth_state, process_generation,
        selected, created_at, updated_at
      ) VALUES (?1, ?1, 'signed_in', 1, ?2, ?3, ?3)
    `).run(accountId, selected, at);
  }
  const store = new ChatPaneStore(database);
  store.create({
    paneId,
    repository: {
      id: `repo_${"8".repeat(26)}`,
      name: "Root lookup",
      workingDirectory: "/tmp/root-lookup-v2",
    },
    accountProfileId: firstAccountId,
    now: new Date(at),
  });
  const actors = new HarnessSQLiteAuthorityV2(database, {
    now: () => new Date(at),
  });
  return {
    actors,
    database,
    roots: new HarnessRootActorAuthorityV2(database, {
      actors,
      now: () => new Date(at),
    }),
    store,
  };
}

function prepareRoot(value: ReturnType<typeof fixture>, targetPaneId = paneId) {
  const input = {
    projectId,
    sourceSha: targetPaneId === paneId ? "a".repeat(40) : "b".repeat(40),
    paneId: targetPaneId,
    chatTurnId,
    title: "Root lookup",
    budget,
    createdAt: at,
  };
  const prepared = value.roots.prepareRoot(input);
  const valueId = targetPaneId === paneId
    ? inputValueId
    : "ctxval_root_lookup_input02";
  seedActiveValue(
    value.database,
    valueId,
    prepared.epoch.id,
    prepared.actor.id,
  );
  return value.roots.admitRoot({ ...input, inputValueId: valueId });
}

function startFirstSession(store: ChatPaneStore, targetPaneId = paneId): void {
  const current = store.require(targetPaneId);
  store.beginTurn({
    paneId: targetPaneId,
    expectedRevision: current.projection.revision,
    turnId: chatTurnId,
    prompt: "Continue across accounts",
    now: new Date(at),
  });
  store.reserveAccount(targetPaneId, chatTurnId, firstAccountId, new Date(at));
  store.prepareProviderThread(
    targetPaneId,
    chatTurnId,
    {
      accountProfileId: firstAccountId,
      threadId: firstThreadId,
      restartThreadId: `raw_restart_${targetPaneId}_first`,
    },
    new Date(at),
  );
  store.markTurnAccepted(targetPaneId, chatTurnId, firstTurnId, new Date(at));
}

function lifecycle(
  accountProfileId: string,
  threadId: string,
  turnId: string,
) {
  return { accountProfileId, threadId, turnId, status: "completed" as const };
}

describe("HarnessRootSessionSQLiteLookupV2", () => {
  test("maps only the current continuation tuple to one stable root turn", async () => {
    const value = fixture();
    try {
      startFirstSession(value.store);
      const root = prepareRoot(value);
      const lookup = new HarnessRootSessionSQLiteLookupV2(value.database, {
        actors: value.actors,
        roots: value.roots,
      });
      expect(await lookup.resolveCurrentRootTurn(
        lifecycle(firstAccountId, firstThreadId, firstTurnId),
      )).toEqual({
        kind: "exact",
        accountProfileId: firstAccountId,
        paneId,
        providerThreadId: firstThreadId,
        providerTurnId: firstTurnId,
        rootTurnId: root.turn.id,
      });

      value.store.beginContinuation(
        paneId,
        chatTurnId,
        secondAccountId,
        new Date(later),
      );
      value.store.prepareProviderThread(
        paneId,
        chatTurnId,
        {
          accountProfileId: secondAccountId,
          threadId: secondThreadId,
          restartThreadId: "unselected_raw_restart_identity",
        },
        new Date(later),
      );
      value.store.markTurnAccepted(
        paneId,
        chatTurnId,
        secondTurnId,
        new Date(later),
      );
      expect(await lookup.resolveCurrentRootTurn(
        lifecycle(firstAccountId, firstThreadId, firstTurnId),
      )).toEqual({ kind: "foreign" });
      expect(await lookup.resolveCurrentRootTurn(
        lifecycle(secondAccountId, secondThreadId, secondTurnId),
      )).toMatchObject({ rootTurnId: root.turn.id, paneId });

      const projections: string[] = [];
      const service = new HarnessRootSessionLifecycleV2({
        authority: value.roots,
        lookup,
        projections: {
          reconcile: ({ actorId }) => {
            projections.push(actorId);
          },
        },
      });
      expect(await service.observe(
        lifecycle(firstAccountId, firstThreadId, firstTurnId),
      )).toBe("foreign");
      expect(value.actors.readActorTurn(root.turn.id)?.state).toBe("running");
      expect(await service.observe(
        lifecycle(secondAccountId, secondThreadId, secondTurnId),
      )).toBe("settled");
      expect(value.actors.readActorTurn(root.turn.id)?.state).toBe("succeeded");
      expect(projections).toEqual([root.actor.id]);
    } finally {
      value.database.close();
    }
  });

  test("reports duplicate current gateway ownership as ambiguous", async () => {
    const value = fixture();
    try {
      startFirstSession(value.store);
      prepareRoot(value);
      value.database.exec("DROP INDEX chat_panes_one_live_provider_thread_idx");
      const secondPaneId = "pane_root_lookup_v2_02";
      value.store.create({
        paneId: secondPaneId,
        repository: {
          id: `repo_${"9".repeat(26)}`,
          name: "Second lookup",
          workingDirectory: "/tmp/root-lookup-v2-second",
        },
        accountProfileId: firstAccountId,
        now: new Date(at),
      });
      startFirstSession(value.store, secondPaneId);
      const secondRoot = prepareRoot(value, secondPaneId);
      const lookup = new HarnessRootSessionSQLiteLookupV2(value.database, {
        actors: value.actors,
        roots: value.roots,
      });
      const ambiguous = await lookup.resolveCurrentRootTurn(
        lifecycle(firstAccountId, firstThreadId, firstTurnId),
      );
      expect(ambiguous).toMatchObject({ kind: "ambiguous" });
      expect(JSON.stringify(ambiguous)).toContain(secondRoot.turn.id);
    } finally {
      value.database.close();
    }
  });
});

function seedActiveValue(
  database: Database,
  valueId: string,
  epochId: string,
  actorId: string,
): void {
  database.query(`
    INSERT INTO harness_context_values (
      value_id, operation_id, epoch_id, owner_actor_id, source_turn_id,
      kind, purpose, schema_version, name_digest, utf8_bytes,
      content_digest, chunk_size, chunk_count, manifest_digest,
      manifest_byte_length, quota_limit_bytes, state, recovery_reason,
      revision, created_at, updated_at, effect_started_at, activated_at
    ) VALUES (
      ?1, ?2, ?3, ?4, NULL, 'text', 'currentInput', 1, NULL, 5,
      ?5, 65536, 1, ?6, 64, 16777216, 'active', NULL,
      3, ?7, ?7, ?7, ?7
    )
  `).run(
    valueId,
    `op_${valueId}`,
    epochId,
    actorId,
    "4".repeat(64),
    "5".repeat(64),
    at,
  );
  database.query(`
    INSERT INTO harness_context_value_chunks (
      value_id, ordinal, plaintext_bytes, object_digest, object_byte_length
    ) VALUES (?1, 0, 5, ?2, 32)
  `).run(valueId, "6".repeat(64));
}
