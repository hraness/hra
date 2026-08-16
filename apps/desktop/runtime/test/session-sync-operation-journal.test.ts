import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
  sessionPublicIdSchema,
  syncSha256DigestSchema,
} from "@hraness/agent-tasks-protocol";

import {
  SessionSyncOperationJournal,
  SessionSyncOperationJournalError,
  classifySessionSyncOperationRestart,
  digestSessionSyncJournalValue,
  sessionSyncHumanOperationPolicies,
  sessionSyncWireOperationPolicies,
} from "../src/state/session-sync-operation-journal";
import { installSessionSyncSchema } from "../src/state/session-sync-store";

function database(): Database {
  const value = new Database(":memory:", { strict: true });
  value.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE chat_panes (
      pane_id TEXT PRIMARY KEY,
      revision INTEGER NOT NULL CHECK (revision > 0),
      title TEXT NOT NULL,
      repository_name TEXT NOT NULL,
      reasoning_effort TEXT NOT NULL,
      state TEXT NOT NULL,
      activity_kind TEXT NOT NULL,
      attention_code TEXT,
      archived_at TEXT,
      created_at INTEGER NOT NULL
    ) STRICT;
  `);
  installSessionSyncSchema(value);
  return value;
}

function session(index: number) {
  return sessionPublicIdSchema.parse(
    `syncsession_${index.toString(16).padStart(32, "0")}`,
  );
}

function operationId(index: number): string {
  return `syncop_${index.toString(16).padStart(32, "0")}`;
}

function digest(character: string) {
  return syncSha256DigestSchema.parse(`sha256_${character.repeat(64)}`);
}

describe("session sync shared operation journal", () => {
  test("classifies every current wire and human operation with explicit crash semantics", () => {
    expect(Object.keys(sessionSyncWireOperationPolicies).toSorted()).toEqual([
      "acquire_writer",
      "admit_membership_proposal",
      "approve_enrollment",
      "begin_snapshot",
      "change_page",
      "delete_session",
      "establish_boot",
      "heartbeat",
      "list_enrollment_requests",
      "publish_session",
      "read_membership",
      "reserve_session",
      "root_key_link_page",
      "snapshot_page",
      "update_membership",
    ]);
    expect(Object.keys(sessionSyncHumanOperationPolicies).toSorted()).toEqual([
      "bootstrap_vault",
      "claim_enrollment",
      "negotiate",
      "recover_vault",
      "recovery_context",
      "submit_enrollment",
    ]);
    expect(sessionSyncWireOperationPolicies.publish_session.replay)
      .toBe("exact_replay");
    expect(sessionSyncWireOperationPolicies.reserve_session.replay)
      .toBe("deterministic_reconcile");
    expect(sessionSyncWireOperationPolicies.snapshot_page.access).toBe("read");
  });

  test("survives prepare, send, ambiguous response, restart, and terminal replay boundaries", () => {
    const db = database();
    try {
      const request = {
        operation: "bootstrap",
        vaultId: `syncvault_${"v".repeat(32)}`,
        membershipDigest: `sha256_${"a".repeat(64)}`,
      };
      const prepared = new SessionSyncOperationJournal(db).prepare({
        operationId: operationId(1),
        kind: "bootstrap_vault",
        request,
        keychainReferences: [{
          service: "kitchen.hraness.session-sync.v1",
          name: "device-vault",
        }],
        now: 1,
      });
      expect(prepared).toMatchObject({
        state: "prepared",
        replayPolicy: "exact_replay",
        request,
      });
      expect(prepared.requestDigest).toBe(digestSessionSyncJournalValue(request));
      expect(classifySessionSyncOperationRestart(prepared))
        .toBe("dispatch_prepared");

      const sent = new SessionSyncOperationJournal(db).markDispatched(
        prepared.operationId,
        2,
      );
      expect(sent.state).toBe("dispatched");
      expect(classifySessionSyncOperationRestart(sent)).toBe("replay_exact");
      const ambiguous = new SessionSyncOperationJournal(db).markAmbiguous(
        prepared.operationId,
        3,
      );
      expect(ambiguous.state).toBe("ambiguous");
      expect(new SessionSyncOperationJournal(db).listRecoverable())
        .toEqual([ambiguous]);
      expect(new SessionSyncOperationJournal(db).listRestartWork())
        .toEqual([{ entry: ambiguous, disposition: "replay_exact" }]);

      const outcome = { kind: "accepted", membershipEpoch: "1" };
      const terminal = new SessionSyncOperationJournal(db).settle({
        operationId: prepared.operationId,
        outcome,
        now: 4,
      });
      expect(terminal).toMatchObject({ state: "terminal", outcome });
      expect(new SessionSyncOperationJournal(db).settle({
        operationId: prepared.operationId,
        outcome,
        now: 5,
      })).toEqual(terminal);
      expect(new SessionSyncOperationJournal(db).listRecoverable()).toEqual([]);
      expect(classifySessionSyncOperationRestart(terminal)).toBeNull();
    } finally {
      db.close();
    }
  });

  test("rejects secret plaintext and conflicting operation or scope reuse", () => {
    const db = database();
    try {
      const journal = new SessionSyncOperationJournal(db);
      expect(() => journal.prepare({
        operationId: operationId(1),
        kind: "recover_vault",
        request: { recoverySigningPkcs8: "must-never-enter-sqlite" },
        now: 1,
      })).toThrow("cannot persist");
      for (const [field, value] of [
        ["access_token", "access"],
        ["bearerToken", "bearer"],
        ["recoveryKit", { root: "kit" }],
        ["databasePassword", "password"],
        ["private_key_material", "private"],
      ] as const) {
        expect(() => journal.prepare({
          operationId: operationId(100 + field.length),
          kind: "recover_vault",
          request: { [field]: value },
          now: 1,
        })).toThrow("cannot persist");
      }
      const first = journal.prepare({
        operationId: operationId(1),
        kind: "recover_vault",
        request: { requestDigest: `sha256_${"b".repeat(64)}` },
        now: 1,
      });
      expect(() => journal.prepare({
        operationId: first.operationId,
        kind: "recover_vault",
        request: { requestDigest: `sha256_${"c".repeat(64)}` },
        now: 2,
      })).toThrow("different intent");
      expect(() => journal.prepare({
        operationId: operationId(2),
        kind: "bootstrap_vault",
        request: { requestDigest: `sha256_${"d".repeat(64)}` },
        now: 2,
      })).toThrow("already owns this scope");
      expect(() => journal.prepare({
        operationId: operationId(3),
        kind: "heartbeat",
        request: { heartbeatSequence: "1" },
        requestDigest: digest("0"),
        now: 3,
      })).toThrow("does not match");
    } finally {
      db.close();
    }
  });

  test("recomputes canonical request and outcome bindings on every read", () => {
    const db = database();
    try {
      const journal = new SessionSyncOperationJournal(db);
      const prepared = journal.prepare({
        operationId: operationId(1),
        kind: "bootstrap_vault",
        request: { alpha: 1, beta: 2 },
        now: 1,
      });
      expect(() => db.query(`
        UPDATE session_sync_operation_journal
        SET response_digest = ?2 WHERE operation_id = ?1
      `).run(prepared.operationId, `sha256_${"e".repeat(64)}`)).toThrow();
      expect(() => db.query(`
        UPDATE session_sync_operation_journal
        SET state = 'terminal', terminal_at = 2, updated_at = 2
        WHERE operation_id = ?1
      `).run(prepared.operationId)).toThrow();
      db.query(`
        UPDATE session_sync_operation_journal
        SET canonical_request_json = ?2 WHERE operation_id = ?1
      `).run(prepared.operationId, '{"beta":2,"alpha":1}');
      expect(() => journal.get(prepared.operationId)).toThrow(
        SessionSyncOperationJournalError,
      );

      db.query(`
        UPDATE session_sync_operation_journal
        SET canonical_request_json = ?2 WHERE operation_id = ?1
      `).run(prepared.operationId, '{"alpha":1,"beta":3}');
      try {
        journal.get(prepared.operationId);
        throw new Error("expected corrupt journal request");
      } catch (error) {
        expect(error).toBeInstanceOf(SessionSyncOperationJournalError);
        expect((error as SessionSyncOperationJournalError).code).toBe("corrupt_state");
      }

      db.query(`
        UPDATE session_sync_operation_journal
        SET canonical_request_json = ?2 WHERE operation_id = ?1
      `).run(prepared.operationId, '{"alpha":1,"beta":2}');
      const terminal = journal.settle({
        operationId: prepared.operationId,
        outcome: { kind: "accepted", epoch: "1" },
        now: 2,
      });
      expect(() => journal.settle({
        operationId: prepared.operationId,
        outcome: terminal.outcome,
        responseDigest: digest("f"),
        now: 3,
      })).toThrow("does not match");
      db.query(`
        UPDATE session_sync_operation_journal
        SET outcome_json = ?2 WHERE operation_id = ?1
      `).run(prepared.operationId, '{"epoch":"2","kind":"accepted"}');
      expect(() => journal.get(prepared.operationId)).toThrow(
        SessionSyncOperationJournalError,
      );
    } finally {
      db.close();
    }
  });

  test("atomically fences an ambiguous global operation for explicit verified recovery", () => {
    const db = database();
    try {
      const journal = new SessionSyncOperationJournal(db);
      const old = journal.prepare({
        operationId: operationId(1),
        kind: "update_membership",
        request: { candidateDigest: `sha256_${"a".repeat(64)}` },
        now: 1,
      });
      journal.markDispatched(old.operationId, 2);
      journal.markAmbiguous(old.operationId, 3);
      const recoveryRequest = {
        operation: "recover_vault",
        membershipDigest: `sha256_${"b".repeat(64)}`,
      };
      const evidence = {
        serverMembershipDigest: digest("b"),
        recoveryAuthorityDigest: digest("c"),
        recoveryIntentDigest: digestSessionSyncJournalValue(recoveryRequest),
        observedAt: 4,
      } as const;
      const replacement = journal.supersedeGlobalForRecovery({
        supersededOperationId: old.operationId,
        expectedSupersededRequestDigest: old.requestDigest,
        operationId: operationId(2),
        request: recoveryRequest,
        keychainReferences: [{
          service: "kitchen.hraness.session-sync.v1",
          name: "recovery-authority",
        }],
        evidence,
        now: 5,
      });
      expect(replacement).toMatchObject({
        kind: "recover_vault",
        state: "prepared",
        request: recoveryRequest,
      });
      const restarted = new SessionSyncOperationJournal(db);
      expect(restarted.get(old.operationId)).toMatchObject({
        state: "terminal",
        outcome: {
          kind: "superseded_for_recovery",
          replacementOperationId: replacement.operationId,
        },
      });
      expect(restarted.listRecoverable()).toEqual([replacement]);
      expect(() => restarted.markAmbiguous(old.operationId, 6)).toThrow(
        "cannot make that transition",
      );
      expect(restarted.supersedeGlobalForRecovery({
        supersededOperationId: old.operationId,
        expectedSupersededRequestDigest: old.requestDigest,
        operationId: replacement.operationId,
        request: recoveryRequest,
        keychainReferences: replacement.keychainReferences,
        evidence,
        now: 7,
      })).toEqual(replacement);
    } finally {
      db.close();
    }
  });

  test("failed recovery replacement rolls back its supersession fence", () => {
    const db = database();
    try {
      const journal = new SessionSyncOperationJournal(db);
      const occupied = journal.prepare({
        operationId: operationId(9),
        kind: "recover_vault",
        request: { membershipDigest: `sha256_${"9".repeat(64)}` },
        now: 1,
      });
      journal.settle({
        operationId: occupied.operationId,
        outcome: { kind: "rejected" },
        now: 2,
      });
      const old = journal.prepare({
        operationId: operationId(1),
        kind: "bootstrap_vault",
        request: { membershipDigest: `sha256_${"1".repeat(64)}` },
        now: 3,
      });
      journal.markDispatched(old.operationId, 4);
      journal.markAmbiguous(old.operationId, 5);
      const request = { membershipDigest: `sha256_${"2".repeat(64)}` };
      expect(() => journal.supersedeGlobalForRecovery({
        supersededOperationId: old.operationId,
        expectedSupersededRequestDigest: old.requestDigest,
        operationId: occupied.operationId,
        request,
        evidence: {
          serverMembershipDigest: digest("2"),
          recoveryAuthorityDigest: digest("3"),
          recoveryIntentDigest: digestSessionSyncJournalValue(request),
          observedAt: 5,
        },
        now: 6,
      })).toThrow("different intent");
      expect(journal.get(old.operationId)?.state).toBe("ambiguous");
    } finally {
      db.close();
    }
  });

  test("restart never automatically replays ambiguous reconcile-only effects and time never regresses", () => {
    const db = database();
    try {
      const journal = new SessionSyncOperationJournal(db);
      const prepared = journal.prepare({
        operationId: operationId(1),
        kind: "reserve_session",
        sessionId: session(1),
        request: { sessionId: session(1), creationGrantDigest: digest("a") },
        now: 10,
      });
      expect(classifySessionSyncOperationRestart(prepared))
        .toBe("dispatch_prepared");
      expect(() => journal.markDispatched(prepared.operationId, 9))
        .toThrow("time cannot move backward");
      const dispatched = journal.markDispatched(prepared.operationId, 11);
      expect(classifySessionSyncOperationRestart(dispatched))
        .toBe("reconcile_only");
      const ambiguous = journal.markAmbiguous(prepared.operationId, 12);
      expect(classifySessionSyncOperationRestart(ambiguous))
        .toBe("reconcile_only");
      expect(journal.listRestartWork()).toEqual([{
        entry: ambiguous,
        disposition: "reconcile_only",
      }]);
      expect(() => journal.settle({
        operationId: prepared.operationId,
        outcome: { kind: "reconciled" },
        now: 11,
      })).toThrow("time cannot move backward");
      expect(journal.get(prepared.operationId)?.state).toBe("ambiguous");
    } finally {
      db.close();
    }
  });

  test("bounds concurrent work to one control, heartbeat, observer, and 64 sessions", () => {
    const db = database();
    try {
      const journal = new SessionSyncOperationJournal(db);
      journal.prepare({
        operationId: operationId(1),
        kind: "heartbeat",
        request: { heartbeatSequence: "1" },
        now: 1,
      });
      journal.prepare({
        operationId: operationId(2),
        kind: "begin_snapshot",
        request: { snapshotId: "snapshot_one" },
        now: 1,
      });
      journal.prepare({
        operationId: operationId(3),
        kind: "bootstrap_vault",
        request: { membershipDigest: `sha256_${"f".repeat(64)}` },
        now: 1,
      });
      for (let index = 0; index < 64; index += 1) {
        journal.prepare({
          operationId: operationId(index + 10),
          kind: "reserve_session",
          sessionId: session(index),
          request: {
            sessionId: session(index),
            creationGrantDigest: `sha256_${index.toString(16).padStart(64, "0")}`,
          },
          now: index + 2,
        });
      }
      expect(journal.listRecoverable()).toHaveLength(67);
      expect(() => journal.prepare({
        operationId: operationId(100),
        kind: "reserve_session",
        sessionId: session(64),
        request: { sessionId: session(64) },
        now: 100,
      })).toThrow(SessionSyncOperationJournalError);
      expect(() => journal.prepare({
        operationId: operationId(101),
        kind: "heartbeat",
        request: { heartbeatSequence: "2" },
        now: 101,
      })).toThrow("already owns this scope");
      expect(() => journal.prepare({
        operationId: operationId(102),
        kind: "recover_vault",
        request: { requestDigest: `sha256_${"e".repeat(64)}` },
        now: 102,
      })).toThrow("already owns this scope");
    } finally {
      db.close();
    }
  });
});
