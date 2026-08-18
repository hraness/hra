import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";

import {
  actorSchema,
} from "../src/harness/actor-domain";
import type {
  HarnessDynamicToolActorResolverPortV2,
} from "../src/harness/dynamic-tool-stable-caller-v2";
import {
  HarnessRootActorAuthorityV2,
  deriveActorPaneBindingId,
  deriveRootActorId,
  deriveRootEpochId,
  deriveSessionProjectIdForCanonicalPath,
} from "../src/harness/root-actor-authority-v2";
import { HarnessSQLiteAuthorityV2 } from "../src/harness/sqlite-authority-v2";
import { ChatPaneStore } from "../src/state/chat-pane-store";
import { applyMigrations } from "../src/state/database";

const at = "2030-01-01T00:00:00.000Z";
const settledAt = "2030-01-01T00:01:00.000Z";
const deadline = "2030-01-02T00:00:00.000Z";
const projectId = "project-root-actor-v2";
const paneId = "pane_root_actor_v2_01";
const chatTurnId = "chatturn_root_actor_v2_0001";
const gatewayThreadId = "thread_root_actor_v2_01";
const gatewayTurnId = "turn_gateway_root_actor_v2_0001";
const repositoryPath = "/tmp/root-actor-v2";
const sessionProjectId = deriveSessionProjectIdForCanonicalPath(repositoryPath);
const sourceSha = "a".repeat(40);
const inputValueId = "ctxval_root_actor_input01";

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
  authority: HarnessRootActorAuthorityV2;
  database: Database;
}> {
  const database = new Database(":memory:", { strict: true });
  database.exec("PRAGMA foreign_keys = ON");
  applyMigrations(database);
  database.query(`
    INSERT INTO projects (
      project_id, canonical_repository_path, canonical_git_common_dir,
      display_name, created_at, updated_at
    ) VALUES (?1, '/tmp/root-actor-v2', '/tmp/root-actor-v2/.git',
      'Root actor', ?2, ?2)
  `).run(projectId, at);
  database.query(`
    INSERT INTO local_repositories (
      repository_id, name, provider, public_url,
      canonical_repository_path, canonical_git_common_dir,
      tombstoned_at, created_at, updated_at
    ) VALUES (?1, 'Root actor', NULL, NULL, ?2, ?3, NULL, 1, 1)
  `).run(`repo_${"1".repeat(26)}`, repositoryPath, `${repositoryPath}/.git`);
  database.query(`
    INSERT INTO account_profiles (
      profile_id, label, auth_state, process_generation,
      selected, created_at, updated_at
    ) VALUES ('acct_root_actor_v2', 'Root actor account',
      'signed_in', 1, 1, ?1, ?1)
  `).run(at);
  new ChatPaneStore(database).create({
    paneId,
    repository: {
      id: `repo_${"1".repeat(26)}`,
      name: "Root actor",
      workingDirectory: "/tmp/root-actor-v2",
    },
    accountProfileId: "acct_root_actor_v2",
    now: new Date(at),
  });
  const actors = new HarnessSQLiteAuthorityV2(database, {
    now: () => new Date(at),
  });
  return {
    actors,
    authority: new HarnessRootActorAuthorityV2(database, {
      actors,
      now: () => new Date(at),
    }),
    database,
  };
}

function prepareAndSeed(
  value: ReturnType<typeof fixture>,
  createdAt = at,
) {
  const prepared = value.authority.prepareRoot(preparation(createdAt));
  seedActiveValue(value.database, {
    valueId: inputValueId,
    epochId: prepared.epoch.id,
    actorId: prepared.actor.id,
    sourceTurnId: null,
    purpose: "currentInput",
  });
  return prepared;
}

function preparation(createdAt = at) {
  return {
    projectId,
    sourceSha,
    paneId,
    chatTurnId,
    title: "Root chat",
    budget,
    createdAt,
  };
}

function admission(createdAt = at) {
  return { ...preparation(createdAt), inputValueId };
}

describe("HarnessRootActorAuthorityV2", () => {
  test("prepares, admits, and exact-replays a provider-neutral root turn", () => {
    const value = fixture();
    const { authority, database } = value;
    try {
      const prepared = prepareAndSeed(value);
      expect(authority.prepareRoot(preparation(settledAt))).toEqual(prepared);
      const first = authority.admitRoot(admission());
      const replay = authority.admitRoot(admission(settledAt));
      expect(replay).toEqual(first);
      expect(first.actor).toMatchObject({
        epochId: first.epoch.id,
        parentActorId: null,
        state: "active",
      });
      expect(first.turn).toMatchObject({
        epochId: first.epoch.id,
        actorId: first.actor.id,
        inputValueId,
        state: "running",
      });
      expect(first.paneBinding).toMatchObject({
        actorId: first.actor.id,
        paneId,
        state: "attached",
      });
      expect(prepared.plannedTurnId).toBe(first.turn.id);
      expect(JSON.stringify(first)).not.toMatch(/account|provider|generation/iu);
    } finally {
      database.close();
    }
  });

  test("fails closed on changed root budget and a live competing source epoch", () => {
    const value = fixture();
    const { authority, actors, database } = value;
    try {
      expect(() => authority.admitRoot(admission())).toThrow(/must be prepared/i);
      prepareAndSeed(value);
      authority.admitRoot(admission());
      expect(() => authority.prepareRoot({
        ...preparation(),
        budget: { ...budget, tokenBudget: budget.tokenBudget - 1 },
      })).toThrow(/another admission/i);

      const competingSha = "b".repeat(40);
      const competingEpochId = deriveRootEpochId({
        projectId,
        sourceSha: competingSha,
        paneId,
      });
      expect(() => authority.prepareRoot({
        ...preparation(),
        sourceSha: competingSha,
      })).toThrow(/conflicts/i);
      expect(actors.readActorEpoch(competingEpochId)).toBeNull();
    } finally {
      database.close();
    }
  });

  test("atomically hands a quiescent pane to a new immutable source epoch", () => {
    const value = fixture();
    const { authority, actors, database } = value;
    try {
      prepareAndSeed(value);
      const previous = authority.admitRoot(admission());
      authority.settleRootTurn({
        turnId: previous.turn.id,
        state: "succeeded",
        outcomeCode: "codex_completed",
        settledAt,
      });
      const currentPreviousActor = actors.readActor(previous.actor.id)!;
      const historicalChild = actors.createChildActor(actorSchema.parse({
        id: "hactor_rotationchild0001",
        epochId: previous.epoch.id,
        parentActorId: previous.actor.id,
        depth: 1,
        title: "Historical child",
        state: "active",
        budget: {
          ...currentPreviousActor.budget,
          maxActiveDescendants: 1,
          maxDurableDescendants: 1,
          tokenBudget: 1_000,
          byteBudget: 1024 * 1024,
          laneAuthority: "readOnlySnapshot",
        },
        tokenReserved: 0,
        byteReserved: 0,
        nextTurnOrdinal: 1,
        nextResultOrdinal: 1,
        revision: 1,
        createdAt: settledAt,
        updatedAt: settledAt,
        stoppedAt: null,
      }));
      const previousEpoch = actors.readActorEpoch(previous.epoch.id);
      const nextInput = {
        ...preparation(settledAt),
        sourceSha: "b".repeat(40),
        chatTurnId: "chatturn_root_actor_v2_0002",
      };

      const prepared = authority.prepareRoot(nextInput);
      expect(prepared.epoch.id).not.toBe(previous.epoch.id);
      expect(prepared.actor.id).not.toBe(previous.actor.id);
      expect(prepared.paneBinding).toMatchObject({
        actorId: prepared.actor.id,
        paneId,
        state: "attached",
        revision: 1,
      });
      expect(actors.readActorPaneBinding(previous.paneBinding.id))
        .toMatchObject({ state: "detached", revision: 2 });
      expect(actors.readActorEpoch(previous.epoch.id)).toEqual(previousEpoch);
      expect(actors.readActor(historicalChild.id)).toEqual(historicalChild);
      expect(database.query(`
        SELECT COUNT(*) AS count FROM harness_actor_pane_bindings
        WHERE pane_id = ?1 AND state = 'attached'
      `).get(paneId)).toEqual({ count: 1 });

      const replay = authority.prepareRoot(nextInput);
      expect(replay).toEqual(prepared);
      expect(actors.readActorPaneBinding(prepared.paneBinding.id))
        .toMatchObject({ state: "attached", revision: 1 });
      expect(actors.readActorPaneBinding(previous.paneBinding.id))
        .toMatchObject({ state: "detached", revision: 2 });
    } finally {
      database.close();
    }
  });

  test("rolls back the old detachment and target epoch when attachment fails", () => {
    const value = fixture();
    const { authority, actors, database } = value;
    try {
      prepareAndSeed(value);
      const previous = authority.admitRoot(admission());
      authority.settleRootTurn({
        turnId: previous.turn.id,
        state: "succeeded",
        outcomeCode: "codex_completed",
        settledAt,
      });
      const targetSha = "c".repeat(40);
      const targetEpochId = deriveRootEpochId({
        projectId,
        sourceSha: targetSha,
        paneId,
      });
      const targetBindingId = deriveActorPaneBindingId(
        deriveRootActorId(targetEpochId),
      );
      database.exec(`
        CREATE TRIGGER reject_target_root_binding
        BEFORE INSERT ON harness_actor_pane_bindings
        WHEN NEW.binding_id = '${targetBindingId}'
        BEGIN
          SELECT RAISE(ABORT, 'injected target attachment failure');
        END
      `);

      expect(() => authority.prepareRoot({
        ...preparation(settledAt),
        sourceSha: targetSha,
        chatTurnId: "chatturn_root_actor_v2_rollback",
      })).toThrow(/conflicts/iu);
      expect(actors.readActorEpoch(targetEpochId)).toBeNull();
      expect(actors.readActorPaneBinding(previous.paneBinding.id))
        .toMatchObject({ state: "attached", revision: 1 });
      expect(actors.readActorForPane(paneId)?.id).toBe(previous.actor.id);
    } finally {
      database.close();
    }
  });

  test("settles a root turn idempotently without terminalizing its actor", () => {
    const value = fixture();
    const { authority, database } = value;
    try {
      prepareAndSeed(value);
      const admitted = authority.admitRoot(admission());
      const settled = authority.settleRootTurn({
        turnId: admitted.turn.id,
        state: "succeeded",
        outcomeCode: "rlm_completed",
        settledAt,
      });
      expect(authority.settleRootTurn({
        turnId: admitted.turn.id,
        state: "succeeded",
        outcomeCode: "rlm_completed",
        settledAt,
      })).toEqual(settled);
      expect(settled).toMatchObject({
        state: "succeeded",
        outcomeCode: "rlm_completed",
      });
      expect(() => authority.settleRootTurn({
        turnId: admitted.turn.id,
        state: "failed",
        outcomeCode: "different",
      })).toThrow(/another outcome/i);
    } finally {
      database.close();
    }
  });

  test("enumerates bounded content-free restart dispositions from exact chat state", () => {
    const beforeProvider = fixture();
    try {
      const store = new ChatPaneStore(beforeProvider.database);
      const pane = store.require(paneId);
      store.beginTurn({
        paneId,
        expectedRevision: pane.projection.revision,
        turnId: chatTurnId,
        prompt: "private prompt that recovery must not select",
        now: new Date(at),
      });
      prepareAndSeed(beforeProvider);
      const admitted = beforeProvider.authority.admitRoot(admission());
      expect(beforeProvider.authority.listLiveRootTurnsForRecovery()).toEqual([{
        actorId: admitted.actor.id,
        paneId,
        turnId: admitted.turn.id,
        disposition: "active_before_provider_start",
      }]);
      expect(JSON.stringify(
        beforeProvider.authority.listLiveRootTurnsForRecovery(),
      )).not.toContain("private prompt");
    } finally {
      beforeProvider.database.close();
    }

    const afterProvider = fixture();
    try {
      activateChatPane(afterProvider.database, {
        paneId,
        rawRestartThreadId: "private_restart_identity",
        rawProviderTurnId: gatewayTurnId,
      });
      prepareAndSeed(afterProvider);
      const admitted = afterProvider.authority.admitRoot(admission());
      const recovery = afterProvider.authority.listLiveRootTurnsForRecovery();
      expect(recovery).toEqual([{
        actorId: admitted.actor.id,
        paneId,
        turnId: admitted.turn.id,
        disposition: "active_after_provider_start",
      }]);
      expect(JSON.stringify(recovery)).not.toMatch(/private_restart|gateway/iu);
    } finally {
      afterProvider.database.close();
    }

    const completed = fixture();
    try {
      activateChatPane(completed.database, {
        paneId,
        rawRestartThreadId: "private_completed_restart",
        rawProviderTurnId: gatewayTurnId,
      });
      prepareAndSeed(completed);
      const admitted = completed.authority.admitRoot(admission());
      completed.database.query(`
        UPDATE chat_panes SET state = 'ready', turn_status = 'completed',
          turn_completed_at = ?1, active_provider_turn_id = NULL,
          active_prompt = NULL, updated_at = ?1
        WHERE pane_id = ?2
      `).run(settledAt, paneId);
      expect(completed.authority.listLiveRootTurnsForRecovery()).toEqual([{
        actorId: admitted.actor.id,
        paneId,
        turnId: admitted.turn.id,
        disposition: "completed",
      }]);
    } finally {
      completed.database.close();
    }
  });

  test("restart enumeration fails closed on partial or mismatched root lineage", () => {
    const mismatch = fixture();
    try {
      const store = new ChatPaneStore(mismatch.database);
      const pane = store.require(paneId);
      store.beginTurn({
        paneId,
        expectedRevision: pane.projection.revision,
        turnId: chatTurnId,
        prompt: "Mismatch",
        now: new Date(at),
      });
      prepareAndSeed(mismatch);
      mismatch.authority.admitRoot(admission());
      mismatch.database.query(`
        UPDATE chat_panes SET active_turn_id = ?1 WHERE pane_id = ?2
      `).run("chatturn_root_actor_v2_mismatch", paneId);
      expect(() => mismatch.authority.listLiveRootTurnsForRecovery())
        .toThrow(/does not match its pane chat turn/iu);
    } finally {
      mismatch.database.close();
    }

    const detached = fixture();
    try {
      const store = new ChatPaneStore(detached.database);
      const pane = store.require(paneId);
      store.beginTurn({
        paneId,
        expectedRevision: pane.projection.revision,
        turnId: chatTurnId,
        prompt: "Detached",
        now: new Date(at),
      });
      prepareAndSeed(detached);
      const admitted = detached.authority.admitRoot(admission());
      detached.actors.detachActorPane({
        bindingId: admitted.paneBinding.id,
        expectedRevision: admitted.paneBinding.revision,
        detachedAt: settledAt,
      });
      expect(() => detached.authority.listLiveRootTurnsForRecovery())
        .toThrow(/partially attached/iu);
    } finally {
      detached.database.close();
    }
  });

  test("anchors each later root turn to the exact prior terminal turn", () => {
    const value = fixture();
    const { authority, actors, database } = value;
    try {
      prepareAndSeed(value);
      const first = authority.admitRoot(admission());
      authority.settleRootTurn({
        turnId: first.turn.id,
        state: "succeeded",
        outcomeCode: "codex_completed",
        settledAt,
      });
      const secondChatTurnId = "chatturn_root_actor_v2_0002";
      const secondInputValueId = "ctxval_root_actor_input02";
      const secondInput = {
        ...preparation(settledAt),
        chatTurnId: secondChatTurnId,
      };
      const prepared = authority.prepareRoot(secondInput);
      seedActiveValue(database, {
        valueId: secondInputValueId,
        epochId: prepared.epoch.id,
        actorId: prepared.actor.id,
        sourceTurnId: null,
        purpose: "currentInput",
      });
      const second = authority.admitRoot({
        ...secondInput,
        inputValueId: secondInputValueId,
      });
      expect(actors.readActorCompletedThroughTurnId(first.turn.id)).toBeNull();
      expect(actors.readActorCompletedThroughTurnId(second.turn.id))
        .toBe(first.turn.id);
      expect(authority.readRootTurn(second.turn.id)).toMatchObject({
        completedThroughTurnId: first.turn.id,
      });
    } finally {
      database.close();
    }
  });

  test("rejects a missing or nonterminal completed-prefix anchor", () => {
    const livePrior = fixture();
    try {
      prepareAndSeed(livePrior);
      livePrior.authority.admitRoot(admission());
      const secondInput = {
        ...preparation(settledAt),
        chatTurnId: "chatturn_root_actor_v2_live_prior",
      };
      const prepared = livePrior.authority.prepareRoot(secondInput);
      seedActiveValue(livePrior.database, {
        valueId: "ctxval_root_actor_liveprior",
        epochId: prepared.epoch.id,
        actorId: prepared.actor.id,
        sourceTurnId: null,
        purpose: "currentInput",
      });
      const second = livePrior.authority.admitRoot({
        ...secondInput,
        inputValueId: "ctxval_root_actor_liveprior",
      });
      expect(() => livePrior.actors.readActorCompletedThroughTurnId(second.turn.id))
        .toThrow(/terminal completed-prefix anchor/iu);
    } finally {
      livePrior.database.close();
    }

    const gap = fixture();
    try {
      prepareAndSeed(gap);
      const first = gap.authority.admitRoot(admission());
      gap.authority.settleRootTurn({
        turnId: first.turn.id,
        state: "succeeded",
        outcomeCode: "codex_completed",
        settledAt,
      });
      const secondInput = {
        ...preparation(settledAt),
        chatTurnId: "chatturn_root_actor_v2_gap",
      };
      const prepared = gap.authority.prepareRoot(secondInput);
      seedActiveValue(gap.database, {
        valueId: "ctxval_root_actor_gapinput",
        epochId: prepared.epoch.id,
        actorId: prepared.actor.id,
        sourceTurnId: null,
        purpose: "currentInput",
      });
      const second = gap.authority.admitRoot({
        ...secondInput,
        inputValueId: "ctxval_root_actor_gapinput",
      });
      gap.database.query(`
        UPDATE harness_actor_turns SET ordinal = 3 WHERE turn_id = ?1
      `).run(second.turn.id);
      expect(() => gap.actors.readActorCompletedThroughTurnId(second.turn.id))
        .toThrow(/ordinal gap/iu);
    } finally {
      gap.database.close();
    }
  });

  test("maps only the exact live child provider attempt to stable actor identity", () => {
    const value = fixture();
    const { authority, actors, database } = value;
    try {
      prepareAndSeed(value);
      const root = authority.admitRoot(admission());
      const childId = "hactor_root_actor_child01";
      const childTurnId = "hturn_root_actor_child001";
      const childInputId = "ctxval_root_actor_child01";
      actors.createChildActor(actorSchema.parse({
        id: childId,
        epochId: root.epoch.id,
        parentActorId: root.actor.id,
        depth: 1,
        title: "Child",
        state: "active",
        budget: {
          maxDepth: 3,
          maxActiveDescendants: 2,
          maxDurableDescendants: 4,
          tokenBudget: 8_000,
          byteBudget: 1024 * 1024,
          deadline,
          laneAuthority: "readOnlySnapshot",
        },
        tokenReserved: 0,
        byteReserved: 0,
        nextTurnOrdinal: 1,
        nextResultOrdinal: 1,
        revision: 1,
        createdAt: at,
        updatedAt: at,
        stoppedAt: null,
      }));
      seedActiveValue(database, {
        valueId: childInputId,
        epochId: root.epoch.id,
        actorId: childId,
        sourceTurnId: null,
        purpose: "actorTask",
      });
      let childTurn = actors.createActorTurn({
        turnId: childTurnId,
        epochId: root.epoch.id,
        actorId: childId,
        idempotencyKey: "child_turn_request_0001",
        inputValueId: childInputId,
        createdAt: at,
      });
      childTurn = actors.transitionActorTurn({
        turnId: childTurn.id,
        expectedRevision: childTurn.revision,
        nextState: "starting",
        now: at,
      });
      childTurn = actors.transitionActorTurn({
        turnId: childTurn.id,
        expectedRevision: childTurn.revision,
        nextState: "running",
        now: at,
      });
      let operation = actors.prepareActorOperation({
        operationId: "hoperation_root_child_start01",
        actorId: childId,
        turnId: null,
        kind: "actorStart",
        requestDigest: "1".repeat(64),
        effectKey: "2".repeat(64),
        providerIdentityJson: '{"request":{"fixture":true},"version":1}',
        createdAt: at,
      });
      operation = actors.transitionActorOperation({
        operationId: operation.id,
        expectedState: "prepared",
        nextState: "effectStarted",
        now: at,
      });
      actors.transitionActorOperation({
        operationId: operation.id,
        expectedState: "effectStarted",
        nextState: "succeeded",
        providerIdentityJson: JSON.stringify({ threadId: "raw_child_thread" }),
        now: at,
      });
      let incarnation = actors.createActorIncarnation({
        incarnationId: "hincarnation_root_child01",
        actorId: childId,
        accountProfileId: "acct_root_actor_v2",
        processGeneration: 7,
        startOperationId: operation.id,
        clientRequestId: "client_request_child_01",
        threadSource: "oprte-harness-child-v2",
        toolsetDigest: "3".repeat(64),
        createdAt: at,
      });
      incarnation = actors.transitionActorIncarnation({
        incarnationId: incarnation.id,
        expectedState: "starting",
        nextState: "idle",
        providerThreadId: "raw_child_thread",
        now: at,
      });
      database.query(`
        INSERT INTO workspace_leases (
          lane_id, project_id, canonical_checkout_path, mode, status,
          base_sha, branch_name, retention, dirty_hint,
          created_at, updated_at, quarantine_reason, quarantined_at
        ) VALUES (
          'lane_root_actor_child_01', ?1, '/tmp/root-actor-child-01',
          'harness_read_only_snapshot', 'ready', ?2, NULL,
          'preserve', 0, ?3, ?3, NULL, NULL
        )
      `).run(projectId, sourceSha, at);
      actors.bindActorWorkspace({
        bindingId: "hbinding_root_actor_child01",
        actorId: childId,
        laneId: "lane_root_actor_child_01",
        authority: "readOnlySnapshot",
        createdAt: at,
      });
      database.query(`
        UPDATE account_profiles SET process_generation = ?2, updated_at = ?3
        WHERE profile_id = ?1
      `).run(incarnation.accountProfileId, incarnation.processGeneration, at);
      actors.bindActorSession({
        incarnationId: incarnation.id,
        recoveryProof: {
          recoveryProofDigest: "4".repeat(64),
          priorRecoveryProofDigest: null,
          observationGeneration: incarnation.processGeneration,
          historyEvidenceDigest: "5".repeat(64),
          firstObservationPosition: 70,
          secondObservationPosition: 71,
          historyTurnCount: 0,
          historyItemCount: 0,
        },
        createdAt: at,
      });
      incarnation = actors.transitionActorIncarnation({
        incarnationId: incarnation.id,
        expectedState: "idle",
        nextState: "running",
        now: at,
      });
      const attempt = actors.createActorAttempt({
        attemptId: "hattempt_root_child0001",
        turnId: childTurn.id,
        incarnationId: incarnation.id,
        accountProfileId: incarnation.accountProfileId,
        processGeneration: incarnation.processGeneration,
        clientUserMessageId: "client_message_child_01",
        createdAt: at,
      });
      actors.transitionActorAttempt({
        attemptId: attempt.id,
        expectedState: "starting",
        nextState: "running",
        providerTurnId: "raw_child_turn",
        now: at,
      });

      expect(authority.resolveNestedCaller({
        accountProfileId: incarnation.accountProfileId,
        processGeneration: incarnation.processGeneration,
        providerThreadId: "raw_child_thread",
        providerTurnId: "raw_child_turn",
      })).toMatchObject({
        epoch: { id: root.epoch.id },
        actor: { id: childId },
        turn: { id: childTurn.id },
        completedThroughTurnId: null,
      });
      expect(authority.resolveNestedCaller({
        accountProfileId: incarnation.accountProfileId,
        processGeneration: incarnation.processGeneration,
        providerThreadId: "wrong_thread",
        providerTurnId: "raw_child_turn",
      })).toBeNull();
    } finally {
      database.close();
    }
  });

  test("resolves one active root caller without raw provider identity", () => {
    const value = fixture();
    const { authority, database } = value;
    try {
      const rawRestartThreadId = "raw_restart_root_actor_v2";
      const rawProviderTurnId = gatewayTurnId;
      activateChatPane(database, {
        paneId,
        rawRestartThreadId,
        rawProviderTurnId,
      });
      prepareAndSeed(value);
      const admitted = authority.admitRoot(admission());
      const resolver: HarnessDynamicToolActorResolverPortV2 = authority;
      expect(resolver).toBe(authority);

      const resolved = authority.resolveRootCaller({
        projectId: sessionProjectId,
        gatewayThreadId,
        gatewayTurnId,
      });
      expect(resolved).toEqual({
        epoch: admitted.epoch,
        actor: admitted.actor,
        turn: admitted.turn,
        completedThroughTurnId: null,
      });
      expect(authority.resolveRootCaller({
        projectId,
        gatewayThreadId,
        gatewayTurnId,
      })).toBeNull();
      expect(JSON.stringify(resolved)).not.toContain(rawRestartThreadId);
      expect(JSON.stringify(resolved)).not.toContain(rawProviderTurnId);

      new ChatPaneStore(database).markTurnAccepted(
        paneId,
        chatTurnId,
        "turn_gateway_root_actor_v2_0002",
        new Date(settledAt),
      );
      expect(authority.resolveRootCaller({
        projectId: sessionProjectId,
        gatewayThreadId,
        gatewayTurnId: "turn_gateway_root_actor_v2_0002",
      })).toEqual(resolved);
      expect(authority.resolveRootCaller({
        projectId: sessionProjectId,
        gatewayThreadId,
        gatewayTurnId,
      })).toBeNull();

      const continuationAccountId = "acct_root_actor_v2_continuation";
      database.query(`
        INSERT INTO account_profiles (
          profile_id, label, auth_state, process_generation,
          selected, created_at, updated_at
        ) VALUES (?1, 'Continuation account', 'signed_in', 1, 0, ?2, ?2)
      `).run(continuationAccountId, settledAt);
      const store = new ChatPaneStore(database);
      store.beginContinuation(
        paneId,
        chatTurnId,
        continuationAccountId,
        new Date(settledAt),
      );
      const continuationThreadId = "thread_root_actor_v2_continuation";
      const continuationTurnId = "turn_gateway_root_actor_v2_0003";
      store.prepareProviderThread(
        paneId,
        chatTurnId,
        {
          accountProfileId: continuationAccountId,
          threadId: continuationThreadId,
          restartThreadId: "raw_restart_root_actor_continuation_v2",
        },
        new Date(settledAt),
      );
      store.markTurnAccepted(
        paneId,
        chatTurnId,
        continuationTurnId,
        new Date(settledAt),
      );
      expect(authority.resolveRootCaller({
        projectId: sessionProjectId,
        gatewayThreadId: continuationThreadId,
        gatewayTurnId: continuationTurnId,
      })).toEqual(resolved);
      expect(authority.resolveRootCaller({
        projectId: sessionProjectId,
        gatewayThreadId,
        gatewayTurnId: "turn_gateway_root_actor_v2_0002",
      })).toBeNull();
    } finally {
      database.close();
    }
  });

  test("fails closed on absent, detached, and terminal root lineage", () => {
    const detached = fixture();
    try {
      activateChatPane(detached.database, {
        paneId,
        rawRestartThreadId: "raw_restart_detached_v2",
        rawProviderTurnId: gatewayTurnId,
      });
      prepareAndSeed(detached);
      const admitted = detached.authority.admitRoot(admission());
      expect(detached.authority.resolveRootCaller({
        projectId: sessionProjectId,
        gatewayThreadId: "thread_absent_root_actor_v2",
        gatewayTurnId,
      })).toBeNull();
      detached.actors.detachActorPane({
        bindingId: admitted.paneBinding.id,
        expectedRevision: admitted.paneBinding.revision,
        detachedAt: settledAt,
      });
      expect(detached.authority.resolveRootCaller({
        projectId: sessionProjectId,
        gatewayThreadId,
        gatewayTurnId,
      })).toBeNull();
    } finally {
      detached.database.close();
    }

    const terminal = fixture();
    try {
      activateChatPane(terminal.database, {
        paneId,
        rawRestartThreadId: "raw_restart_terminal_v2",
        rawProviderTurnId: gatewayTurnId,
      });
      prepareAndSeed(terminal);
      const admitted = terminal.authority.admitRoot(admission());
      terminal.authority.settleRootTurn({
        turnId: admitted.turn.id,
        state: "failed",
        outcomeCode: "codex_failed",
        settledAt,
      });
      expect(terminal.authority.resolveRootCaller({
        projectId: sessionProjectId,
        gatewayThreadId,
        gatewayTurnId,
      })).toBeNull();
    } finally {
      terminal.database.close();
    }
  });

  test("rejects ambiguous active panes before choosing a root lineage", () => {
    const value = fixture();
    const { authority, database } = value;
    try {
      activateChatPane(database, {
        paneId,
        rawRestartThreadId: "raw_restart_ambiguous_a_v2",
        rawProviderTurnId: gatewayTurnId,
      });
      prepareAndSeed(value);
      authority.admitRoot(admission());

      const secondPaneId = "pane_root_actor_v2_02";
      const secondInputValueId = "ctxval_root_actor_input02";
      const secondAccountId = "acct_root_actor_v2_second";
      database.query(`
        INSERT INTO account_profiles (
          profile_id, label, auth_state, process_generation,
          selected, created_at, updated_at
        ) VALUES (?1, 'Second root actor account',
          'signed_in', 1, 0, ?2, ?2)
      `).run(secondAccountId, at);
      const secondRepositoryId = `repo_${"2".repeat(26)}`;
      const secondRepositoryPath = "/tmp/root-actor-v2-second";
      database.query(`
        INSERT INTO local_repositories (
          repository_id, name, provider, public_url,
          canonical_repository_path, canonical_git_common_dir,
          tombstoned_at, created_at, updated_at
        ) VALUES (?1, 'Second root actor', NULL, NULL, ?2, ?3, NULL, 2, 2)
      `).run(
        secondRepositoryId,
        secondRepositoryPath,
        `${secondRepositoryPath}/.git`,
      );
      new ChatPaneStore(database).create({
        paneId: secondPaneId,
        repository: {
          id: secondRepositoryId,
          name: "Second root actor",
          workingDirectory: "/tmp/root-actor-v2-second",
        },
        accountProfileId: secondAccountId,
        now: new Date(at),
      });
      activateChatPane(database, {
        paneId: secondPaneId,
        accountProfileId: secondAccountId,
        rawRestartThreadId: "raw_restart_ambiguous_b_v2",
        rawProviderTurnId: gatewayTurnId,
      });
      const secondPreparation = {
        ...preparation(),
        paneId: secondPaneId,
        sourceSha: "b".repeat(40),
      };
      const secondRoot = authority.prepareRoot(secondPreparation);
      seedActiveValue(database, {
        valueId: secondInputValueId,
        epochId: secondRoot.epoch.id,
        actorId: secondRoot.actor.id,
        sourceTurnId: null,
        purpose: "currentInput",
      });
      authority.admitRoot({
        ...secondPreparation,
        inputValueId: secondInputValueId,
      });

      expect(() => authority.resolveRootCaller({
        projectId: sessionProjectId,
        gatewayThreadId,
        gatewayTurnId,
      })).toThrow(/multiple active chat panes/iu);
    } finally {
      database.close();
    }
  });
});

function activateChatPane(
  database: Database,
  input: Readonly<{
    paneId: string;
    accountProfileId?: string;
    rawRestartThreadId: string;
    rawProviderTurnId: string;
  }>,
): void {
  const store = new ChatPaneStore(database);
  const current = store.require(input.paneId);
  const begun = store.beginTurn({
    paneId: input.paneId,
    expectedRevision: current.projection.revision,
    turnId: chatTurnId,
    prompt: "Resolve this root caller",
    now: new Date(at),
  });
  store.reserveAccount(
    input.paneId,
    chatTurnId,
    input.accountProfileId ?? "acct_root_actor_v2",
    new Date(at),
  );
  store.prepareProviderThread(
    input.paneId,
    chatTurnId,
    {
      accountProfileId: input.accountProfileId ?? "acct_root_actor_v2",
      threadId: gatewayThreadId,
      restartThreadId: input.rawRestartThreadId,
    },
    new Date(at),
  );
  store.markTurnAccepted(
    input.paneId,
    begun.pane.turn?.id ?? chatTurnId,
    input.rawProviderTurnId,
    new Date(at),
  );
}

function seedActiveValue(
  database: Database,
  input: Readonly<{
    valueId: string;
    epochId: string;
    actorId: string;
    sourceTurnId: string | null;
    purpose: "currentInput" | "actorTask";
  }>,
): void {
  database.query(`
      INSERT INTO harness_context_values (
        value_id, operation_id, epoch_id, owner_actor_id, source_turn_id,
        kind, purpose, schema_version, name_digest, utf8_bytes,
        content_digest, chunk_size, chunk_count, manifest_digest,
        manifest_byte_length, quota_limit_bytes, state, recovery_reason,
        revision, created_at, updated_at, effect_started_at, activated_at
      ) VALUES (
        ?1, ?2, ?3, ?4, ?5, 'text', ?6, 1, NULL, 5,
        ?7, 65536, 1, ?8, 64, 16777216, 'active', NULL,
        3, ?9, ?9, ?9, ?9
      )
    `).run(
      input.valueId,
      `op_${input.valueId}`,
      input.epochId,
      input.actorId,
      input.sourceTurnId,
      input.purpose,
      "4".repeat(64),
      "5".repeat(64),
      at,
    );
  database.query(`
      INSERT INTO harness_context_value_chunks (
        value_id, ordinal, plaintext_bytes, object_digest, object_byte_length
      ) VALUES (?1, 0, 5, ?2, 32)
  `).run(input.valueId, "6".repeat(64));
}
