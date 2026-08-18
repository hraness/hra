import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { SessionTurnLifecycle } from "../src/sessions/session-service";
import {
  deriveRootActorTurnId,
  HarnessRootActorAuthorityV2,
} from "../src/harness/root-actor-authority-v2";
import {
  HarnessRootSessionLifecycleV2,
  type HarnessRootProjectionReconcilerV2,
  type HarnessRootSessionLookupV2,
} from "../src/harness/root-session-lifecycle-v2";
import {
  RlmCallerAuthorityV2,
} from "../src/harness/rlm-caller-authority-v2";
import {
  RlmRunAuthorityV2,
} from "../src/harness/rlm-run-authority-v2";
import {
  deriveRlmRuntimeAdmissionDigest,
} from "../src/harness/rlm-runtime-v2";
import {
  RLM_V2_MAX_FUEL,
  deriveRlmV2ReceiptId,
  parseRlmV2Caller,
} from "../src/harness/rlm-v2";
import { HarnessSQLiteAuthorityV2 } from "../src/harness/sqlite-authority-v2";
import { ChatPaneStore } from "../src/state/chat-pane-store";
import { applyMigrations } from "../src/state/database";

const at = "2031-02-03T04:05:06.000Z";
const deadline = "2031-02-04T04:05:06.000Z";
const projectId = "project-root-session-v2";
const paneId = "pane_root_session_v2_01";
const accountProfileId = "acct_root_session_v2";
const chatTurnId = "chatturn_root_session_v2_0001";
const providerThreadId = "raw-provider-thread-root-session";
const providerTurnId = "raw-provider-turn-root-session";
const inputValueId = "ctxval_root_session_input01";
const rlmProgramValueId = "ctxval_root_session_program01";
const rlmPrefixValueId = "ctxval_root_session_prefix001";
const rlmSnapshotId = "ctxsnap_root_session_rlm01";
const rlmRunId = "rlmrun_root_session_reopen01";
const rlmProgramDigest = "8".repeat(64);
const rlmReleaseDigest = "9".repeat(64);
const rlmWitnessDigest = "a".repeat(64);

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

class Lookup implements HarnessRootSessionLookupV2 {
  calls: SessionTurnLifecycle[] = [];
  resolution: unknown = { kind: "foreign" };
  blocker: Promise<void> | null = null;

  async resolveCurrentRootTurn(event: SessionTurnLifecycle): Promise<unknown> {
    this.calls.push(event);
    if (this.blocker !== null) await this.blocker;
    return this.resolution;
  }
}

class Projections implements HarnessRootProjectionReconcilerV2 {
  calls: Array<Readonly<{ actorId: string; paneId: string }>> = [];
  failure: Error | null = null;

  reconcile(input: Readonly<{ actorId: string; paneId: string }>): void {
    this.calls.push(input);
    if (this.failure !== null) throw this.failure;
  }
}

function fixture(path = ":memory:"): Readonly<{
  actors: HarnessSQLiteAuthorityV2;
  authority: HarnessRootActorAuthorityV2;
  coordinator: HarnessRootSessionLifecycleV2;
  database: Database;
  lookup: Lookup;
  projections: Projections;
}> {
  const database = new Database(path, { strict: true });
  database.exec("PRAGMA foreign_keys = ON");
  applyMigrations(database);
  database.query(`
    INSERT INTO projects (
      project_id, canonical_repository_path, canonical_git_common_dir,
      display_name, created_at, updated_at
    ) VALUES (?1, '/tmp/root-session-v2', '/tmp/root-session-v2/.git',
      'Root session', ?2, ?2)
  `).run(projectId, at);
  database.query(`
    INSERT INTO account_profiles (
      profile_id, label, auth_state, process_generation,
      selected, created_at, updated_at
    ) VALUES (?1, 'Root session account', 'signed_in', 1, 1, ?2, ?2)
  `).run(accountProfileId, at);
  new ChatPaneStore(database).create({
    paneId,
    repository: {
      id: `repo_${"7".repeat(26)}`,
      name: "Root session",
      workingDirectory: "/tmp/root-session-v2",
    },
    accountProfileId,
    now: new Date(at),
  });
  const actors = new HarnessSQLiteAuthorityV2(database, {
    now: () => new Date(at),
  });
  const authority = new HarnessRootActorAuthorityV2(database, {
    actors,
    now: () => new Date(at),
  });
  const lookup = new Lookup();
  const projections = new Projections();
  return {
    actors,
    authority,
    coordinator: new HarnessRootSessionLifecycleV2({
      authority,
      lookup,
      projections,
    }),
    database,
    lookup,
    projections,
  };
}

async function admit(value: ReturnType<typeof fixture>) {
  const prepared = await value.coordinator.prepareRoot(preparation());
  seedActiveValue(value.database, prepared.epoch.id, prepared.actor.id);
  const admitted = await value.coordinator.admitRootTurn({
    ...preparation(),
    inputValueId,
  });
  value.lookup.resolution = exactResolution(admitted.turn.id);
  value.projections.calls.length = 0;
  return admitted;
}

function preparation() {
  return {
    projectId,
    sourceSha: "a".repeat(40),
    paneId,
    chatTurnId,
    title: "Root session",
    budget,
    createdAt: at,
  };
}

function lifecycle(
  status: SessionTurnLifecycle["status"],
  options: Readonly<{ quota?: boolean; turnId?: string }> = {},
): SessionTurnLifecycle {
  return {
    accountProfileId,
    threadId: providerThreadId,
    turnId: options.turnId ?? providerTurnId,
    status,
    ...(options.quota === true
      ? { quotaProof: "provider_usage_limit_exceeded" as const }
      : {}),
  };
}

function exactResolution(rootTurnId: string) {
  return {
    kind: "exact" as const,
    accountProfileId,
    paneId,
    providerThreadId,
    providerTurnId,
    rootTurnId,
  };
}

function admitRootRlmRun(
  value: ReturnType<typeof fixture>,
  admitted: Awaited<ReturnType<typeof admit>>,
) {
  insertRlmValue(value.database, {
    valueId: rlmProgramValueId,
    operationId: "root-session-rlm-program-op",
    sourceTurnId: admitted.turn.id,
    kind: "json",
    purpose: "programSource",
    contentDigest: rlmProgramDigest,
  });
  insertRlmValue(value.database, {
    valueId: rlmPrefixValueId,
    operationId: "root-session-rlm-prefix-op",
    sourceTurnId: null,
    kind: "selection",
    purpose: "completedPrefix",
    contentDigest: rlmWitnessDigest,
  });
  value.database.query(`
    INSERT INTO harness_context_snapshots (
      snapshot_id, epoch_id, actor_id, completed_through_turn_id,
      coverage_witness_digest, value_id, created_at, expires_at
    ) VALUES (?1, ?2, ?3, NULL, ?4, ?5, ?6, NULL)
  `).run(
    rlmSnapshotId,
    admitted.epoch.id,
    admitted.actor.id,
    rlmWitnessDigest,
    rlmPrefixValueId,
    at,
  );
  const caller = parseRlmV2Caller({
    epochId: admitted.epoch.id,
    actorId: admitted.actor.id,
    turnId: admitted.turn.id,
    capabilities: ["context.read"],
    admittedFeatures: ["boundedPrograms"],
    semanticWitnessDigests: [rlmWitnessDigest],
    budget,
  });
  const authority = new RlmRunAuthorityV2(value.database, {
    now: () => new Date(at),
  });
  const input = {
    id: rlmRunId,
    epochId: admitted.epoch.id,
    actorId: admitted.actor.id,
    turnId: admitted.turn.id,
    programValueId: rlmProgramValueId,
    programDigest: rlmProgramDigest,
    completedPrefixSnapshotId: rlmSnapshotId,
    currentUserInputValueId: inputValueId,
    capabilities: caller.capabilities,
    admittedFeatures: caller.admittedFeatures,
    semanticWitnessDigests: caller.semanticWitnessDigests,
    budget: caller.budget,
    fuelLimit: RLM_V2_MAX_FUEL,
    deadline,
    releaseIdentityDigest: rlmReleaseDigest,
    admissionDigest: deriveRlmRuntimeAdmissionDigest({
      runId: rlmRunId,
      epochId: admitted.epoch.id,
      actorId: admitted.actor.id,
      turnId: admitted.turn.id,
      completedPrefixSnapshotId: rlmSnapshotId,
      currentUserInputValueId: inputValueId,
      releaseIdentityDigest: rlmReleaseDigest,
      fuelLimit: RLM_V2_MAX_FUEL,
      programDigest: rlmProgramDigest,
      caller,
    }),
    createdAt: at,
  } as const;
  const prepared = authority.prepareRun(input);
  const run = authority.transitionRun({
    runId: prepared.id,
    expectedRevision: prepared.revision,
    expectedState: "prepared",
    nextState: "running",
    now: at,
  });
  return { authority, caller, input, run };
}

function insertRlmValue(
  database: Database,
  input: Readonly<{
    valueId: string;
    operationId: string;
    sourceTurnId: string | null;
    kind: "json" | "selection";
    purpose: "programSource" | "completedPrefix" | "programResult";
    contentDigest: string;
  }>,
): void {
  const lineage = database.query<{
    epoch_id: string;
    actor_id: string;
  }, [string]>(`
    SELECT epoch_id, actor_id FROM harness_actor_turns WHERE turn_id = ?1
  `).get(input.sourceTurnId ?? deriveOnlyRootTurnId(database));
  if (lineage === null) throw new Error("root RLM fixture lost actor lineage");
  database.query(`
    INSERT INTO harness_context_values (
      value_id, operation_id, epoch_id, owner_actor_id, source_turn_id,
      kind, purpose, schema_version, name_digest, utf8_bytes,
      content_digest, chunk_size, chunk_count, manifest_digest,
      manifest_byte_length, quota_limit_bytes, state, recovery_reason,
      revision, created_at, updated_at, effect_started_at, activated_at
    ) VALUES (
      ?1, ?2, ?3, ?4, ?5, ?6, ?7, 1, NULL, 2,
      ?8, 65536, 1, ?8, 64, 16777216, 'active', NULL, 3,
      ?9, ?9, ?9, ?9
    )
  `).run(
    input.valueId,
    input.operationId,
    lineage.epoch_id,
    lineage.actor_id,
    input.sourceTurnId,
    input.kind,
    input.purpose,
    input.contentDigest,
    at,
  );
  database.query(`
    INSERT INTO harness_context_value_chunks (
      value_id, ordinal, plaintext_bytes, object_digest, object_byte_length
    ) VALUES (?1, 0, 2, ?2, 64)
  `).run(input.valueId, input.contentDigest);
}

function deriveOnlyRootTurnId(database: Database): string {
  const rows = database.query<{ turn_id: string }, []>(`
    SELECT turn.turn_id
    FROM harness_actor_turns AS turn
    JOIN harness_actors AS actor ON actor.actor_id = turn.actor_id
    WHERE actor.parent_actor_id IS NULL
    ORDER BY turn.turn_id LIMIT 2
  `).all();
  if (rows.length !== 1) throw new Error("root RLM fixture is ambiguous");
  return rows[0]!.turn_id;
}

describe("HarnessRootSessionLifecycleV2", () => {
  test.each([
    ["completed", "succeeded", "codex_completed"],
    [
      "active_after_provider_start",
      "failed",
      "codex_runtime_restarted_after_provider_start",
    ],
    [
      "active_before_provider_start",
      "ambiguous",
      "codex_provider_start_ambiguous",
    ],
  ] as const)(
    "recovers %s root state before chat restart cleanup",
    async (disposition, expectedState, expectedCode) => {
      const value = fixture();
      try {
        const store = new ChatPaneStore(value.database);
        const pane = store.require(paneId);
        store.beginTurn({
          paneId,
          expectedRevision: pane.projection.revision,
          turnId: chatTurnId,
          prompt: "Private restart prompt",
          now: new Date(at),
        });
        if (disposition === "active_after_provider_start" || disposition === "completed") {
          store.reserveAccount(paneId, chatTurnId, accountProfileId, new Date(at));
          store.prepareProviderThread(
            paneId,
            chatTurnId,
            {
              accountProfileId,
              threadId: providerThreadId,
              restartThreadId: "private-restart-thread",
            },
            new Date(at),
          );
          store.markTurnAccepted(
            paneId,
            chatTurnId,
            providerTurnId,
            new Date(at),
          );
        }
        const admitted = await admit(value);
        if (disposition === "completed") {
          value.database.query(`
            UPDATE chat_panes SET state = 'ready', turn_status = 'completed',
              turn_completed_at = ?1, active_provider_turn_id = NULL,
              active_prompt = NULL, updated_at = ?1
            WHERE pane_id = ?2
          `).run(at, paneId);
        }

        expect(await value.coordinator.reconcileOnBoot()).toEqual([{
          actorId: admitted.actor.id,
          paneId,
          turnId: admitted.turn.id,
          disposition,
          state: expectedState,
          outcomeCode: expectedCode,
        }]);
        expect(value.actors.readActorTurn(admitted.turn.id)).toMatchObject({
          state: expectedState,
          outcomeCode: expectedCode,
        });
        expect(value.projections.calls).toEqual([{
          actorId: admitted.actor.id,
          paneId,
        }]);
        expect(await value.coordinator.reconcileOnBoot()).toEqual([]);
      } finally {
        value.database.close();
      }
    },
  );

  test("reopens an admitted root RLM after exact restart settlement and later pane detachment", async () => {
    const directory = mkdtempSync(join(tmpdir(), "oprte-root-rlm-reopen-"));
    const databasePath = join(directory, "control.sqlite");
    try {
      const value = fixture(databasePath);
      const store = new ChatPaneStore(value.database);
      const pane = store.require(paneId);
      store.beginTurn({
        paneId,
        expectedRevision: pane.projection.revision,
        turnId: chatTurnId,
        prompt: "Private restart prompt",
        now: new Date(at),
      });
      store.reserveAccount(paneId, chatTurnId, accountProfileId, new Date(at));
      store.prepareProviderThread(
        paneId,
        chatTurnId,
        {
          accountProfileId,
          threadId: providerThreadId,
          restartThreadId: "private-restart-thread",
        },
        new Date(at),
      );
      store.markTurnAccepted(
        paneId,
        chatTurnId,
        providerTurnId,
        new Date(at),
      );
      const admitted = await admit(value);
      const rlm = admitRootRlmRun(value, admitted);

      expect(await value.coordinator.reconcileOnBoot()).toEqual([{
        actorId: admitted.actor.id,
        paneId,
        turnId: admitted.turn.id,
        disposition: "active_after_provider_start",
        state: "failed",
        outcomeCode: "codex_runtime_restarted_after_provider_start",
      }]);
      value.database.query(`
        UPDATE harness_actor_pane_bindings
        SET state = 'detached', revision = revision + 1, detached_at = ?2
        WHERE actor_id = ?1 AND state = 'attached'
      `).run(admitted.actor.id, at);
      value.database.close();

      const reopened = new Database(databasePath, { strict: true });
      reopened.exec("PRAGMA foreign_keys = ON");
      applyMigrations(reopened);
      try {
        const runs = new RlmRunAuthorityV2(reopened, {
          now: () => new Date(at),
        });
        const durableRun = runs.readRun(rlm.run.id);
        if (durableRun === null) throw new Error("admitted RLM run disappeared");
        const callers = new RlmCallerAuthorityV2(reopened, {
          now: () => new Date(at),
        });
        expect(await callers.resolveCaller(durableRun)).toEqual(rlm.caller);
        const nodePath = [["step", 0]] as const;
        expect(await callers.resolve({
          ...rlm.caller,
          programRunId: durableRun.id,
          programDigest: durableRun.programDigest,
          receiptId: deriveRlmV2ReceiptId(
            durableRun.id,
            durableRun.programDigest,
            nodePath,
          ),
          nodePath,
          signal: new AbortController().signal,
        })).toMatchObject({
          epochId: admitted.epoch.id,
          actorId: admitted.actor.id,
          turnId: admitted.turn.id,
        });

        const rejectedRunId = "rlmrun_root_session_reopen02";
        expect(() => runs.prepareRun({
          ...rlm.input,
          id: rejectedRunId,
          admissionDigest: deriveRlmRuntimeAdmissionDigest({
            runId: rejectedRunId,
            epochId: admitted.epoch.id,
            actorId: admitted.actor.id,
            turnId: admitted.turn.id,
            completedPrefixSnapshotId: rlmSnapshotId,
            currentUserInputValueId: inputValueId,
            releaseIdentityDigest: rlmReleaseDigest,
            fuelLimit: RLM_V2_MAX_FUEL,
            programDigest: rlmProgramDigest,
            caller: rlm.caller,
          }),
        })).toThrow("only a running actor turn can admit an RLM run");

        const resultValueId = "ctxval_root_session_result001";
        insertRlmValue(reopened, {
          valueId: resultValueId,
          operationId: "root-session-rlm-result-op",
          sourceTurnId: admitted.turn.id,
          kind: "json",
          purpose: "programResult",
          contentDigest: "b".repeat(64),
        });
        expect(runs.transitionRun({
          runId: durableRun.id,
          expectedRevision: durableRun.revision,
          expectedState: "running",
          nextState: "completed",
          terminalResultValueId: resultValueId,
          terminalCode: "completed",
          now: at,
        })).toMatchObject({
          id: durableRun.id,
          state: "completed",
          terminalResultValueId: resultValueId,
        });
      } finally {
        reopened.close();
      }
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });

  test.each([
    ["completed", false, "succeeded", "codex_completed"],
    ["interrupted", false, "cancelled", "codex_interrupted"],
    ["failed", false, "failed", "codex_failed"],
    ["failed", true, "failed", "codex_usage_limit_exceeded"],
  ] as const)(
    "maps %s quota=%s to the exact stable root settlement",
    async (status, quota, expectedState, expectedCode) => {
      const value = fixture();
      try {
        const admitted = await admit(value);
        expect(await value.coordinator.observe(lifecycle(status, { quota })))
          .toBe("settled");
        expect(value.actors.readActorTurn(admitted.turn.id)).toMatchObject({
          state: expectedState,
          outcomeCode: expectedCode,
        });
        expect(value.projections.calls).toEqual([{
          actorId: admitted.actor.id,
          paneId,
        }]);
        const durable = JSON.stringify({
          epoch: admitted.epoch,
          actor: admitted.actor,
          turn: value.actors.readActorTurn(admitted.turn.id),
        });
        expect(durable).not.toContain(providerThreadId);
        expect(durable).not.toContain(providerTurnId);
        expect(admitted.turn.id).toBe(
          deriveRootActorTurnId(admitted.epoch.id, chatTurnId),
        );
      } finally {
        value.database.close();
      }
    },
  );

  test("settles a root explicitly when provider start cannot complete", async () => {
    const unavailable = fixture();
    try {
      const admitted = await admit(unavailable);
      expect(await unavailable.coordinator.settleBeforeProvider({
        turnId: admitted.turn.id,
        paneId,
        failure: "provider_unavailable",
        settledAt: at,
      })).toMatchObject({
        state: "failed",
        outcomeCode: "codex_provider_unavailable_before_start",
      });
      expect(await unavailable.coordinator.settleBeforeProvider({
        turnId: admitted.turn.id,
        paneId,
        failure: "provider_unavailable",
        settledAt: at,
      })).toMatchObject({ state: "failed" });
      expect(unavailable.projections.calls).toHaveLength(2);
    } finally {
      unavailable.database.close();
    }

    const ambiguous = fixture();
    try {
      const admitted = await admit(ambiguous);
      expect(await ambiguous.coordinator.settleBeforeProvider({
        turnId: admitted.turn.id,
        paneId,
        failure: "provider_start_ambiguous",
        settledAt: at,
      })).toMatchObject({
        state: "ambiguous",
        outcomeCode: "codex_provider_start_ambiguous",
      });
    } finally {
      ambiguous.database.close();
    }

    const wrongPane = fixture();
    try {
      const admitted = await admit(wrongPane);
      expect(await rejection(wrongPane.coordinator.settleBeforeProvider({
        turnId: admitted.turn.id,
        paneId: "pane_root_session_other_01",
        failure: "provider_unavailable",
        settledAt: at,
      }))).toMatchObject({ code: "corrupt_lineage" });
      expect(wrongPane.actors.readActorTurn(admitted.turn.id)?.state)
        .toBe("running");
    } finally {
      wrongPane.database.close();
    }
  });

  test("ignores active and foreign events, replays duplicates, and drops reordered terminals", async () => {
    const value = fixture();
    try {
      const admitted = await admit(value);
      expect(await value.coordinator.observe(lifecycle("inProgress")))
        .toBe("ignored_active");
      expect(value.lookup.calls).toHaveLength(0);

      value.lookup.resolution = { kind: "foreign" };
      expect(await value.coordinator.observe(lifecycle("completed"))).toBe("foreign");
      expect(value.actors.readActorTurn(admitted.turn.id)?.state).toBe("running");

      value.lookup.resolution = exactResolution(admitted.turn.id);
      expect(await value.coordinator.observe(lifecycle("completed"))).toBe("settled");
      expect(await value.coordinator.observe(lifecycle("completed"))).toBe("duplicate");
      expect(value.projections.calls).toHaveLength(2);
      expect(await value.coordinator.observe(lifecycle("failed"))).toBe("stale");
      expect(value.projections.calls).toHaveLength(2);
      expect(value.actors.readActorTurn(admitted.turn.id)).toMatchObject({
        state: "succeeded",
        outcomeCode: "codex_completed",
      });
    } finally {
      value.database.close();
    }
  });

  test("fails closed on ambiguous same-thread lineage and recovers its serial queue", async () => {
    const value = fixture();
    try {
      const admitted = await admit(value);
      value.lookup.resolution = {
        kind: "ambiguous",
        accountProfileId,
        providerThreadId,
        providerTurnId,
        candidateRootTurnIds: [
          admitted.turn.id,
          deriveRootActorTurnId(
            admitted.epoch.id,
            "chatturn_other_root_candidate",
          ),
        ],
      };
      expect(await rejection(value.coordinator.observe(lifecycle("failed"))))
        .toMatchObject({ code: "ambiguous_lineage" });
      expect(value.actors.readActorTurn(admitted.turn.id)?.state).toBe("running");

      value.lookup.resolution = exactResolution(admitted.turn.id);
      expect(await value.coordinator.observe(lifecycle("failed"))).toBe("settled");
      expect(value.actors.readActorTurn(admitted.turn.id)).toMatchObject({
        state: "failed",
        outcomeCode: "codex_failed",
      });
    } finally {
      value.database.close();
    }
  });

  test("rejects lookup echo conflicts and exact lineages attached to another pane", async () => {
    const value = fixture();
    try {
      const admitted = await admit(value);
      value.lookup.resolution = {
        ...exactResolution(admitted.turn.id),
        providerTurnId: "raw-provider-turn-other",
      };
      expect(await rejection(value.coordinator.observe(lifecycle("completed"))))
        .toMatchObject({ code: "lookup_conflict" });

      value.lookup.resolution = {
        ...exactResolution(admitted.turn.id),
        paneId: "pane_root_session_other_01",
      };
      expect(await rejection(value.coordinator.observe(lifecycle("completed"))))
        .toMatchObject({ code: "corrupt_lineage" });
      expect(value.actors.readActorTurn(admitted.turn.id)?.state).toBe("running");
    } finally {
      value.database.close();
    }
  });

  test("retries projection and closes admission before terminal observation", async () => {
    const value = fixture();
    try {
      const admitted = await admit(value);
      value.projections.failure = new Error("projection unavailable");
      expect(await rejection(value.coordinator.observe(lifecycle("completed"))))
        .toMatchObject({ message: "projection unavailable" });
      expect(value.actors.readActorTurn(admitted.turn.id)?.state).toBe("succeeded");

      value.projections.failure = null;
      expect(await value.coordinator.observe(lifecycle("completed"))).toBe("duplicate");

      let releaseLookup = (): void => undefined;
      value.lookup.blocker = new Promise<void>((resolve) => {
        releaseLookup = resolve;
      });
      const stale = value.coordinator.observe(lifecycle("failed"));
      value.coordinator.closeAdmission();
      expect(await rejection(value.coordinator.prepareRoot(preparation())))
        .toMatchObject({ code: "closed" });
      expect(await value.coordinator.observe(lifecycle("inProgress")))
        .toBe("ignored_active");
      value.coordinator.closeObservation();
      expect(await rejection(value.coordinator.observe(lifecycle("failed"))))
        .toMatchObject({ code: "closed" });
      releaseLookup();
      expect(await stale).toBe("stale");
      await value.coordinator.settled();
    } finally {
      value.database.close();
    }
  });
});

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error: unknown) {
    return error;
  }
  throw new Error("expected promise to reject");
}

function seedActiveValue(database: Database, epochId: string, actorId: string): void {
  database.query(`
    INSERT INTO harness_context_values (
      value_id, operation_id, epoch_id, owner_actor_id, source_turn_id,
      kind, purpose, schema_version, name_digest, utf8_bytes,
      content_digest, chunk_size, chunk_count, manifest_digest,
      manifest_byte_length, quota_limit_bytes, state, recovery_reason,
      revision, created_at, updated_at, effect_started_at, activated_at
    ) VALUES (
      ?1, ?2, ?3, ?4, NULL,
      'text', 'currentInput', 1, NULL, 5,
      ?5, 65536, 1, ?6,
      64, 16777216, 'active', NULL,
      3, ?7, ?7, ?7, ?7
    )
  `).run(
    inputValueId,
    `op_${inputValueId}`,
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
  `).run(inputValueId, "6".repeat(64));
}
