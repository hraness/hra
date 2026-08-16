import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";

import type { AccountRuntimeRouter } from "../src/accounts/runtime-router";
import { actorSchema } from "../src/harness/actor-domain";
import {
  HarnessDynamicToolEvidenceSettingsAuthorityV2,
  HarnessDynamicToolEvidenceSettingsV2Error,
} from "../src/harness/dynamic-tool-evidence-settings-v2";
import type { HarnessFeature } from "../src/harness/semantic-gate";
import { HarnessRootActorAuthorityV2 } from
  "../src/harness/root-actor-authority-v2";
import { HarnessSQLiteAuthorityV2 } from "../src/harness/sqlite-authority-v2";
import { ChatPaneStore } from "../src/state/chat-pane-store";
import { applyMigrations } from "../src/state/database";

const at = "2030-01-01T00:00:00.000Z";
const deadline = "2030-01-02T00:00:00.000Z";
const accountProfileId = "acct_evidence_settings_v2";
const projectId = "project-evidence-settings-v2";
const repositoryId = `repo_${"1".repeat(26)}`;
const paneId = "pane_evidence_settings_v2_01";
const chatTurnId = "chatturn_evidence_settings_v2_0001";
const inputValueId = "ctxval_evidence_settings_input01";

const recursiveBudget = Object.freeze({
  depthRemaining: 3,
  activeDescendantLimit: 8,
  durableDescendantLimit: 50,
  tokenBudget: 100_000,
  heapByteLimit: 16 * 1024 * 1024,
  contextValueByteLimit: 1024 * 1024,
  messageByteLimit: 128 * 1024,
  deadline,
  laneAuthority: "managedWrite" as const,
});

const futureSemanticFeatures = {
  decideMany: (features: readonly HarnessFeature[]) =>
    Promise.resolve(features.map((feature, index) => ({
    enabled: true as const,
    feature,
    witnessDigests: [`${(index + 1).toString(16)}`.padStart(64, "0")],
  }))),
};

function fixture(
  refinementMode: "off" | "suggest" = "off",
  features = futureSemanticFeatures,
) {
  const database = new Database(":memory:", { strict: true });
  database.exec("PRAGMA foreign_keys = ON");
  applyMigrations(database);
  database.query(`
    INSERT INTO projects (
      project_id, canonical_repository_path, canonical_git_common_dir,
      display_name, created_at, updated_at
    ) VALUES (?1, '/tmp/evidence-settings-v2',
      '/tmp/evidence-settings-v2/.git', 'Evidence settings', ?2, ?2)
  `).run(projectId, at);
  database.query(`
    INSERT INTO local_repositories (
      repository_id, name, provider, public_url,
      canonical_repository_path, canonical_git_common_dir,
      tombstoned_at, created_at, updated_at
    ) VALUES (?1, 'Evidence settings', NULL, NULL,
      '/tmp/evidence-settings-v2', '/tmp/evidence-settings-v2/.git',
      NULL, 1, 1)
  `).run(repositoryId);
  database.query(`
    INSERT INTO account_profiles (
      profile_id, label, auth_state, process_generation,
      selected, created_at, updated_at
    ) VALUES (?1, 'Evidence account', 'signed_in', 7, 1, ?2, ?2)
  `).run(accountProfileId, at);
  database.query(`
    UPDATE harness_settings SET recursive_sessions_enabled = 1,
      context_quota_bytes = 50331648, refinement_mode = ?1
    WHERE singleton = 1
  `).run(refinementMode);

  const panes = new ChatPaneStore(database);
  const created = panes.create({
    paneId,
    repository: {
      id: repositoryId,
      name: "Evidence settings",
      workingDirectory: "/tmp/evidence-settings-v2",
    },
    accountProfileId,
    reasoningEffort: "ultra",
    now: new Date(at),
  });
  panes.beginTurn({
    paneId,
    expectedRevision: created.revision,
    turnId: chatTurnId,
    prompt: "Use the recursive harness.",
    now: new Date(at),
  });
  panes.reserveAccount(paneId, chatTurnId, accountProfileId, new Date(at));
  panes.prepareProviderThread(paneId, chatTurnId, {
    accountProfileId,
    threadId: "thread_gateway_evidence_settings_v2",
    restartThreadId: "raw_private_evidence_settings_v2",
  }, new Date(at));
  panes.markTurnAccepted(
    paneId,
    chatTurnId,
    "turn_gateway_evidence_settings_v2",
    new Date(at),
  );

  const actors = new HarnessSQLiteAuthorityV2(database, {
    now: () => new Date(at),
  });
  const roots = new HarnessRootActorAuthorityV2(database, {
    actors,
    now: () => new Date(at),
  });
  const rootInput = {
    projectId,
    sourceSha: "a".repeat(40),
    paneId,
    chatTurnId,
    title: "Evidence settings",
    budget: recursiveBudget,
    createdAt: at,
  };
  const prepared = roots.prepareRoot(rootInput);
  seedActiveInput(database, prepared.epoch.id, prepared.actor.id);
  const admitted = roots.admitRoot({ ...rootInput, inputValueId });

  let runtimeGeneration = 7;
  let capabilityProjection: (generation: number) => unknown;
  const capability = (generation: number) => ({
    caller: { accountProfileId, accountGeneration: generation },
    runtimeBinarySha256: "b".repeat(64),
    witness: {
      binarySha256: "b".repeat(64),
      processGeneration: generation,
      evidenceObjectDigest: "c".repeat(64),
    },
  }) as unknown as NonNullable<
    ReturnType<AccountRuntimeRouter["readDynamicToolCapability"]>
  >;
  capabilityProjection = capability;
  const runtimes: Pick<
    AccountRuntimeRouter,
    "generation" | "readDynamicToolCapability"
  > = {
    generation: (profileId: string) =>
      profileId === accountProfileId ? runtimeGeneration : null,
    readDynamicToolCapability: (profileId: string, generation: number) =>
      profileId === accountProfileId && generation === runtimeGeneration
        ? capabilityProjection(generation) as ReturnType<
          AccountRuntimeRouter["readDynamicToolCapability"]
        >
        : null,
  };
  // `features` deliberately models future externally signed semantic input.
  // Structural extra properties are accepted by JavaScript composition, but
  // current production admission must never consult or derive authority from it.
  const serviceOptions = {
    database,
    actors,
    runtimes,
    features,
    now: () => Date.parse(at) + 1,
  };
  const service = new HarnessDynamicToolEvidenceSettingsAuthorityV2(
    serviceOptions,
  );
  return {
    admitted,
    database,
    service,
    setRuntimeGeneration(generation: number) {
      runtimeGeneration = generation;
    },
    setCapabilityProjection(
      projection: (generation: number) => unknown,
    ) {
      capabilityProjection = projection;
    },
  };
}

describe("HarnessDynamicToolEvidenceSettingsAuthorityV2", () => {
  test("binds a live root to its exact direct probe without exposing its account", async () => {
    const value = fixture();
    try {
      const result = await value.service.readAcceptedSettings(
        settingsInput(value.admitted),
      ) as Record<string, unknown>;
      expect(result.capabilities).toEqual([
        "agent.cancel",
        "agent.message",
        "agent.spawn",
        "agent.wait",
        "heap.read",
        "heap.write",
      ]);
      expect(result.admittedFeatures).toEqual([
        "boundedPrograms",
        "recursiveAgents",
      ]);
      expect(result.semanticWitnessDigests).toEqual(["c".repeat(64)]);
      expect(result.budget).toEqual(recursiveBudget);
      expect(result.releaseIdentityDigest).toMatch(/^[a-f0-9]{64}$/u);
      expect(JSON.stringify(result)).not.toContain(accountProfileId);
      expect(JSON.stringify(result)).not.toContain("raw_private");
    } finally {
      value.database.close();
    }
  });

  test("admits proposal capability only under Suggest and fails closed when disabled", async () => {
    const suggested = fixture("suggest");
    try {
      const result = await suggested.service.readAcceptedSettings(
        settingsInput(suggested.admitted),
      ) as { capabilities: string[]; admittedFeatures: string[] };
      expect(result.capabilities).toContain("harness.propose");
      expect(result.admittedFeatures).toContain("instructionCandidates");
      suggested.database.query(`
        UPDATE harness_settings SET recursive_sessions_enabled = 0
        WHERE singleton = 1
      `).run();
      expect(suggested.service.readAcceptedSettings(
        settingsInput(suggested.admitted),
      )).rejects.toBeInstanceOf(HarnessDynamicToolEvidenceSettingsV2Error);
    } finally {
      suggested.database.close();
    }
  });

  test("resolves a nested actor from its exact running attempt owner", async () => {
    const value = fixture();
    try {
      const actor = value.database.transaction(() => {
        const child = new HarnessSQLiteAuthorityV2(value.database, {
          now: () => new Date(at),
        }).createChildActor(actorSchema.parse({
          id: "hactor_evidence_nested_01",
          epochId: value.admitted.epoch.id,
          parentActorId: value.admitted.actor.id,
          depth: 1,
          title: "Nested evidence actor",
          state: "active",
          budget: {
            ...value.admitted.actor.budget,
            tokenBudget: 20_000,
            byteBudget: 4 * 1024 * 1024,
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
        seedActiveInput(
          value.database,
          value.admitted.epoch.id,
          child.id,
          "ctxval_evidence_nested_input01",
          "nestedinput_evidence_settings_v2",
        );
        return child;
      })();
      const actors = new HarnessSQLiteAuthorityV2(value.database, {
        now: () => new Date(at),
      });
      value.database.query(`
        INSERT INTO workspace_leases (
          lane_id, project_id, canonical_checkout_path, mode, status,
          base_sha, branch_name, retention, dirty_hint,
          created_at, updated_at, quarantine_reason, quarantined_at
        ) VALUES (
          'lane_evidence_nested_001', ?1, '/tmp/evidence-nested-snapshot',
          'harness_read_only_snapshot', 'ready', ?2, NULL,
          'preserve', 0, ?3, ?3, NULL, NULL
        )
      `).run(projectId, "a".repeat(40), at);
      actors.bindActorWorkspace({
        bindingId: "hbinding_evidence_nested_01",
        actorId: actor.id,
        laneId: "lane_evidence_nested_001",
        authority: "readOnlySnapshot",
        createdAt: at,
      });
      let turn = actors.createActorTurn({
        turnId: "hturn_evidence_nested_0001",
        epochId: value.admitted.epoch.id,
        actorId: actor.id,
        idempotencyKey: "nested-evidence-settings-turn-0001",
        inputValueId: "ctxval_evidence_nested_input01",
        createdAt: at,
      });
      turn = actors.transitionActorTurn({
        turnId: turn.id,
        expectedRevision: turn.revision,
        nextState: "starting",
        now: at,
      });
      turn = actors.transitionActorTurn({
        turnId: turn.id,
        expectedRevision: turn.revision,
        nextState: "running",
        now: at,
      });
      let operation = actors.prepareActorOperation({
        operationId: "hoperation_evidence_nested_start01",
        actorId: actor.id,
        turnId: null,
        kind: "actorStart",
        requestDigest: "1".repeat(64),
        effectKey: "2".repeat(64),
        providerIdentityJson: "{}",
        createdAt: at,
      });
      operation = actors.transitionActorOperation({
        operationId: operation.id,
        expectedState: "prepared",
        nextState: "effectStarted",
        now: at,
      });
      operation = actors.transitionActorOperation({
        operationId: operation.id,
        expectedState: "effectStarted",
        nextState: "succeeded",
        providerIdentityJson: '{"providerThreadId":"nested-thread"}',
        now: at,
      });
      let incarnation = actors.createActorIncarnation({
        incarnationId: "hincarnation_evidence_nested_01",
        actorId: actor.id,
        accountProfileId,
        processGeneration: 7,
        startOperationId: operation.id,
        clientRequestId: "nested-evidence-client-request-0001",
        threadSource: "oprte:evidence:nested:0001",
        toolsetDigest: "3".repeat(64),
        createdAt: at,
      });
      incarnation = actors.transitionActorIncarnation({
        incarnationId: incarnation.id,
        expectedState: "starting",
        nextState: "idle",
        providerThreadId: "nested-thread",
        now: at,
      });
      let attempt = actors.createActorAttempt({
        attemptId: "hattempt_evidence_nested_0001",
        turnId: turn.id,
        incarnationId: incarnation.id,
        accountProfileId,
        processGeneration: 7,
        clientUserMessageId: "nested-evidence-client-message-0001",
        createdAt: at,
      });
      attempt = actors.transitionActorAttempt({
        attemptId: attempt.id,
        expectedState: "starting",
        nextState: "running",
        providerTurnId: "nested-provider-turn",
        now: at,
      });

      expect(attempt.ordinal).toBe(1);
      expect(value.service.readAcceptedSettings({
        ...settingsInput(value.admitted),
        actorId: actor.id,
        turnId: turn.id,
      })).rejects.toBeInstanceOf(HarnessDynamicToolEvidenceSettingsV2Error);
      let session = actors.bindActorSession({
        incarnationId: incarnation.id,
        recoveryProof: {
          recoveryProofDigest: "4".repeat(64),
          priorRecoveryProofDigest: null,
          observationGeneration: 7,
          historyEvidenceDigest: "5".repeat(64),
          firstObservationPosition: 70,
          secondObservationPosition: 71,
          historyTurnCount: 0,
          historyItemCount: 0,
        },
        createdAt: at,
      });
      expect(await value.service.readAcceptedSettings({
        ...settingsInput(value.admitted),
        actorId: actor.id,
        turnId: turn.id,
      })).toMatchObject({
        budget: {
          depthRemaining: 2,
          tokenBudget: 20_000,
          laneAuthority: "readOnly",
        },
      });

      value.database.query(`
        UPDATE account_profiles SET process_generation = 8, updated_at = ?2
        WHERE profile_id = ?1
      `).run(accountProfileId, at);
      session = actors.advanceActorSessionBinding({
        incarnationId: incarnation.id,
        expectedRevision: session.revision,
        expectedLiveGeneration: 7,
        liveCapabilityEvidence: {
          evidenceDigest: "c".repeat(64),
          supportsFast: true,
        },
        recoveryProof: {
          recoveryProofDigest: "6".repeat(64),
          priorRecoveryProofDigest: session.recoveryProof.recoveryProofDigest,
          observationGeneration: 8,
          historyEvidenceDigest: "7".repeat(64),
          firstObservationPosition: 80,
          secondObservationPosition: 81,
          historyTurnCount: 0,
          historyItemCount: 0,
        },
        now: at,
      });
      value.setRuntimeGeneration(8);
      expect(session.admissionGeneration).toBe(7);
      expect(session.liveGeneration).toBe(8);
      expect(value.service.readAcceptedSettings({
        ...settingsInput(value.admitted),
        actorId: actor.id,
        turnId: turn.id,
      })).rejects.toBeInstanceOf(HarnessDynamicToolEvidenceSettingsV2Error);
      expect(await value.service.readAcceptedSettings({
        ...settingsInput(value.admitted),
        actorId: actor.id,
        turnId: turn.id,
        accountGeneration: 8,
        processGeneration: 8,
      })).toMatchObject({
        budget: { tokenBudget: 20_000 },
      });

      value.database.exec("SAVEPOINT retired_actor_session");
      actors.transitionActorIncarnation({
        incarnationId: incarnation.id,
        expectedState: "idle",
        nextState: "closed",
        now: at,
      });
      expect(value.service.readAcceptedSettings({
        ...settingsInput(value.admitted),
        actorId: actor.id,
        turnId: turn.id,
        accountGeneration: 8,
        processGeneration: 8,
      })).rejects.toBeInstanceOf(HarnessDynamicToolEvidenceSettingsV2Error);
      value.database.exec(
        "ROLLBACK TO retired_actor_session; RELEASE retired_actor_session",
      );

      value.database.exec("SAVEPOINT quarantined_actor_session");
      actors.quarantineActorSessionBinding({
        incarnationId: incarnation.id,
        expectedRevision: session.revision,
        reason: "recovery_protocol_error",
        now: at,
      });
      expect(value.service.readAcceptedSettings({
        ...settingsInput(value.admitted),
        actorId: actor.id,
        turnId: turn.id,
        accountGeneration: 8,
        processGeneration: 8,
      })).rejects.toBeInstanceOf(HarnessDynamicToolEvidenceSettingsV2Error);
      value.database.exec(
        "ROLLBACK TO quarantined_actor_session; RELEASE quarantined_actor_session",
      );
    } finally {
      value.database.close();
    }
  });

  test("future signed semantic decisions cannot narrow or widen current authority", async () => {
    let reads = 0;
    const value = fixture("off", {
      decideMany: (features: readonly HarnessFeature[]) => {
        reads += 1;
        return Promise.resolve(features.map((feature) => ({
          enabled: true as const,
          feature,
          witnessDigests: ["f".repeat(64)],
        })));
      },
    });
    try {
      const result = await value.service.readAcceptedSettings(
        settingsInput(value.admitted),
      ) as { capabilities: string[]; admittedFeatures: string[] };
      expect(result.admittedFeatures).toEqual([
        "boundedPrograms",
        "recursiveAgents",
      ]);
      expect(result.admittedFeatures).not.toContain("goals");
      expect(result.admittedFeatures).not.toContain("contextMaterialization");
      expect(result.capabilities).not.toContain("context.read");
      expect(reads).toBe(0);
    } finally {
      value.database.close();
    }
  });

  test("rejects a substituted callback binding before consulting semantic evidence", () => {
    let featureReads = 0;
    const value = fixture("off", {
      decideMany: (features: readonly HarnessFeature[]) => {
        featureReads += 1;
        return futureSemanticFeatures.decideMany(features);
      },
    });
    try {
      expect(value.service.readAcceptedSettings({
        ...settingsInput(value.admitted),
        accountProfileId: "acct_substituted_evidence_owner",
      })).rejects.toBeInstanceOf(HarnessDynamicToolEvidenceSettingsV2Error);
      expect(featureReads).toBe(0);
    } finally {
      value.database.close();
    }
  });

  test("rejects malformed, stale, and cross-account direct capabilities", () => {
    const value = fixture();
    try {
      const invalidCapabilities: readonly ((generation: number) => unknown)[] = [
        (generation) => ({
          caller: { accountProfileId, accountGeneration: generation },
          runtimeBinarySha256: "b".repeat(64),
          witness: {
            binarySha256: "b".repeat(64),
            processGeneration: generation,
          },
        }),
        (generation) => ({
          caller: { accountProfileId, accountGeneration: generation },
          runtimeBinarySha256: "b".repeat(64),
          witness: {
            binarySha256: "b".repeat(64),
            processGeneration: generation - 1,
            evidenceObjectDigest: "c".repeat(64),
          },
        }),
        (generation) => ({
          caller: {
            accountProfileId: "acct_cross_account_direct_probe",
            accountGeneration: generation,
          },
          runtimeBinarySha256: "b".repeat(64),
          witness: {
            binarySha256: "b".repeat(64),
            processGeneration: generation,
            evidenceObjectDigest: "c".repeat(64),
          },
        }),
        (generation) => ({
          caller: { accountProfileId, accountGeneration: generation },
          runtimeBinarySha256: "b".repeat(64),
          witness: {
            binarySha256: "d".repeat(64),
            processGeneration: generation,
            evidenceObjectDigest: "c".repeat(64),
          },
        }),
      ];
      for (const projection of invalidCapabilities) {
        value.setCapabilityProjection(projection);
        expect(value.service.readAcceptedSettings(
          settingsInput(value.admitted),
        )).rejects.toBeInstanceOf(HarnessDynamicToolEvidenceSettingsV2Error);
      }
    } finally {
      value.database.close();
    }
  });
});

function settingsInput(admitted: ReturnType<
  HarnessRootActorAuthorityV2["admitRoot"]
>) {
  return {
    epochId: admitted.epoch.id,
    actorId: admitted.actor.id,
    turnId: admitted.turn.id,
    requestInstanceId: 41,
    accountProfileId,
    accountGeneration: 7,
    processGeneration: 7,
  };
}

function seedActiveInput(
  database: Database,
  epochId: string,
  actorId: string,
  valueId = inputValueId,
  operationId = "rootinput_evidence_settings_v2",
): void {
  database.query(`
    INSERT INTO harness_context_values (
      value_id, operation_id, epoch_id, owner_actor_id, source_turn_id,
      kind, purpose, schema_version, name_digest, utf8_bytes,
      content_digest, chunk_size, chunk_count, manifest_digest,
      manifest_byte_length, quota_limit_bytes, state, recovery_reason,
      revision, created_at, updated_at, effect_started_at, activated_at
    ) VALUES (
      ?1, ?2, ?3, ?4, NULL,
      'text', 'currentInput', 1, NULL, 26,
      ?5, 65536, 1, ?6, 64, 16777216, 'active', NULL,
      3, ?7, ?7, ?7, ?7
    )
  `).run(
    valueId,
    operationId,
    epochId,
    actorId,
    "d".repeat(64),
    "e".repeat(64),
    at,
  );
}
