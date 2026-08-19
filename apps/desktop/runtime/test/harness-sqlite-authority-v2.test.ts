import { describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { Database } from "bun:sqlite";
import { assertProperty, fc, propertyParameters } from "@hra-internal/test";

import {
  actorEpochSchema,
  actorSchema,
  type Actor,
  type ActorEpoch,
} from "../src/harness/actor-domain";
import {
  HarnessSQLiteAuthorityV2,
  HarnessSQLiteAuthorityV2Error,
} from "../src/harness/sqlite-authority-v2";
import type {
  ActorTokenUsageIdentityInput,
  ActorTokenUsageIdentityPortV2,
} from
  "../src/harness/actor-token-usage-identity-v2";
import { applyMigrations } from "../src/state/database";

const at = "2030-01-01T00:00:00.000Z";
const later = "2030-01-01T00:00:01.000Z";
const deadline = "2030-01-02T00:00:00.000Z";
const projectId = "project-harness-v2";
const accountId = "acct_harnessv2_0001";
const rootActorId = "hactor_root0000001";
const epochId = "hepoch_root0000001";
const sourceSha = "a".repeat(40);
const MIB = 1024 * 1024;
const PROPERTY_TIMEOUT = propertyParameters.interruptAfterTimeLimit + 5_000;

const tokenUsageIdentities: ActorTokenUsageIdentityPortV2 = Object.freeze({
  digest: (input: ActorTokenUsageIdentityInput) => Promise.resolve(createHmac(
    "sha256",
    "oprte-harness-v2-test-token-usage-key",
  ).update(JSON.stringify(input)).digest("hex")),
});

function digest(character: string): string {
  return character.repeat(64);
}

function rootBudget() {
  return {
    maxDepth: 3,
    maxActiveDescendants: 8,
    maxDurableDescendants: 50,
    tokenBudget: 100_000,
    byteBudget: 16 * MIB,
    deadline,
    laneAuthority: "managedWrite" as const,
  };
}

function epochAndRoot(): { epoch: ActorEpoch; rootActor: Actor } {
  const budget = rootBudget();
  const epoch = actorEpochSchema.parse({
    id: epochId,
    projectId,
    sourceSha,
    rootActorId,
    budget,
    tokenReserved: 0,
    byteReserved: 0,
    nextRootCompletionSequence: 1,
    state: "active",
    revision: 1,
    createdAt: at,
    updatedAt: at,
    stoppedAt: null,
  });
  const rootActor = actorSchema.parse({
    id: rootActorId,
    epochId,
    parentActorId: null,
    depth: 0,
    title: "Root actor",
    state: "active",
    budget,
    tokenReserved: 0,
    byteReserved: 0,
    nextTurnOrdinal: 1,
    nextResultOrdinal: 1,
    revision: 1,
    createdAt: at,
    updatedAt: at,
    stoppedAt: null,
  });
  return { epoch, rootActor };
}

interface Fixture {
  readonly authority: HarnessSQLiteAuthorityV2;
  readonly database: Database;
}

function fixture(
  usageIdentities: ActorTokenUsageIdentityPortV2 = tokenUsageIdentities,
): Fixture {
  const database = new Database(":memory:", { strict: true });
  database.exec("PRAGMA foreign_keys = ON");
  applyMigrations(database);
  database.query(`
    INSERT INTO projects (
      project_id, canonical_repository_path, canonical_git_common_dir,
      display_name, created_at, updated_at
    ) VALUES (?1, '/tmp/oprte-harness-v2', '/tmp/oprte-harness-v2/.git',
      'Harness V2', ?2, ?2)
  `).run(projectId, at);
  database.query(`
    INSERT INTO account_profiles (
      profile_id, label, auth_state, process_generation,
      selected, created_at, updated_at
    ) VALUES (?1, 'Harness account', 'signed_in', 1, 1, ?2, ?2)
  `).run(accountId, at);
  return {
    database,
    authority: new HarnessSQLiteAuthorityV2(database, {
      now: () => new Date(later),
      tokenUsageIdentities: usageIdentities,
    }),
  };
}

function deferred<T>(): Readonly<{
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolveValue, rejectValue) => {
    resolve = resolveValue;
    reject = rejectValue;
  });
  return Object.freeze({ promise, resolve, reject });
}

async function expectRejectedMessage(
  operation: Promise<unknown>,
  expectedMessage: string,
): Promise<void> {
  try {
    await operation;
  } catch (error: unknown) {
    expect(error).toBeInstanceOf(Error);
    if (!(error instanceof Error)) throw new Error("expected rejected error");
    expect(error.message).toContain(expectedMessage);
    return;
  }
  throw new Error(`expected rejection containing: ${expectedMessage}`);
}

function child(input: Readonly<{
  id?: string;
  parent?: Actor;
  tokenBudget?: number;
  byteBudget?: number;
  authority?: "readOnlySnapshot" | "managedWrite";
}> = {}): Actor {
  const parent = input.parent ?? epochAndRoot().rootActor;
  return actorSchema.parse({
    id: input.id ?? "hactor_child000001",
    epochId,
    parentActorId: parent.id,
    depth: parent.depth + 1,
    title: "Child actor",
    state: "active",
    budget: {
      ...parent.budget,
      tokenBudget: input.tokenBudget ?? 20_000,
      byteBudget: input.byteBudget ?? 4 * MIB,
      laneAuthority: input.authority ?? "readOnlySnapshot",
    },
    tokenReserved: 0,
    byteReserved: 0,
    nextTurnOrdinal: 1,
    nextResultOrdinal: 1,
    revision: 1,
    createdAt: later,
    updatedAt: later,
    stoppedAt: null,
  });
}

function insertContextValue(
  database: Database,
  input: Readonly<{
    valueId: string;
    actorId: string;
    epochId?: string;
    purpose: "actorTask" | "currentInput" | "agentResult";
    sourceTurnId?: string | null;
    marker?: string;
  }>,
): void {
  const marker = input.marker ?? "b";
  database.query(`
    INSERT INTO harness_context_values (
      value_id, operation_id, epoch_id, owner_actor_id, source_turn_id,
      kind, purpose, schema_version, name_digest, utf8_bytes,
      content_digest, chunk_size, chunk_count, manifest_digest,
      manifest_byte_length, quota_limit_bytes, state, recovery_reason,
      revision, created_at, updated_at, effect_started_at, activated_at
    ) VALUES (
      ?1, ?2, ?3, ?4, ?5, 'text', ?6, 1, NULL, 1,
      ?7, 65536, 1, ?8, 1, 16777216, 'active', NULL,
      3, ?9, ?9, ?9, ?9
    )
  `).run(
    input.valueId,
    `contextop_${input.valueId}`,
    input.epochId ?? epochId,
    input.actorId,
    input.sourceTurnId ?? null,
    input.purpose,
    digest(marker),
    digest(marker === "f" ? "e" : "f"),
    at,
  );
  database.query(`
    INSERT INTO harness_context_value_chunks (
      value_id, ordinal, plaintext_bytes, object_digest, object_byte_length
    ) VALUES (?1, 0, 1, ?2, 1)
  `).run(input.valueId, digest(marker === "d" ? "c" : "d"));
}

function insertCompletedPrefix(
  database: Database,
  input: Readonly<{
    valueId: string;
    actorId: string;
    sourceTurnId: string;
    marker: string;
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
      ?1, ?2, ?3, ?4, ?5, 'selection', 'completedPrefix', 1, NULL, 1,
      ?6, 65536, 1, ?7, 1, 16777216, 'active', NULL,
      3, ?8, ?8, ?8, ?8
    )
  `).run(
    input.valueId,
    `contextop_${input.valueId}`,
    epochId,
    input.actorId,
    input.sourceTurnId,
    digest(input.marker),
    digest(input.marker === "a" ? "b" : "a"),
    later,
  );
  database.query(`
    INSERT INTO harness_context_value_chunks (
      value_id, ordinal, plaintext_bytes, object_digest, object_byte_length
    ) VALUES (?1, 0, 1, ?2, 1)
  `).run(input.valueId, digest(input.marker === "c" ? "d" : "c"));
}

function recoveryProof(input: Readonly<{
  generation: number;
  priorRecoveryProofDigest?: string | null;
  marker?: string;
}>) {
  const marker = input.marker ?? "7";
  return {
    recoveryProofDigest: digest(marker),
    priorRecoveryProofDigest: input.priorRecoveryProofDigest ?? null,
    observationGeneration: input.generation,
    historyEvidenceDigest: digest(marker === "7" ? "8" : "7"),
    firstObservationPosition: input.generation * 10,
    secondObservationPosition: input.generation * 10 + 1,
    historyTurnCount: 0,
    historyItemCount: 0,
  } as const;
}

function bindFixtureWorkspace(
  value: Fixture,
  actorId: string,
  suffix: string,
): void {
  const laneId = `lane_usage_${suffix}`;
  value.database.query(`
    INSERT INTO workspace_leases (
      lane_id, project_id, canonical_checkout_path, mode, status,
      base_sha, branch_name, retention, dirty_hint,
      created_at, updated_at, quarantine_reason, quarantined_at
    ) VALUES (
      ?1, ?2, ?3, 'managed_worktree', 'ready', ?4, ?6,
      'preserve', 0, ?5, ?5, NULL, NULL
    )
  `).run(
    laneId,
    projectId,
    `/tmp/oprte-harness-v2-${suffix}`,
    sourceSha,
    at,
    `codex/${suffix}`,
  );
  value.authority.bindActorWorkspace({
    bindingId: `hbinding_usage_${suffix}`,
    actorId,
    laneId,
    authority: "managedWrite",
    createdAt: at,
  });
}

function prepareRunningTurn(
  fixtureValue: Fixture,
  input: Readonly<{
    actorId?: string;
    turnSuffix: string;
    valueSuffix?: string;
  }>,
) {
  const actorId = input.actorId ?? rootActorId;
  const valueId = `ctxval_input${input.valueSuffix ?? input.turnSuffix}`;
  const turnId = `hturn_${input.turnSuffix}`;
  insertContextValue(fixtureValue.database, {
    valueId,
    actorId,
    purpose: "currentInput",
  });
  let turn = fixtureValue.authority.createActorTurn({
    turnId,
    epochId,
    actorId,
    idempotencyKey: `idempotency-${input.turnSuffix}`,
    inputValueId: valueId,
    createdAt: at,
  });
  turn = fixtureValue.authority.transitionActorTurn({
    turnId,
    expectedRevision: turn.revision,
    nextState: "starting",
    now: later,
  });
  turn = fixtureValue.authority.transitionActorTurn({
    turnId,
    expectedRevision: turn.revision,
    nextState: "running",
    now: "2030-01-01T00:00:02.000Z",
  });
  return turn;
}

function prepareStartingAttempt(
  value: Fixture,
  input: Readonly<{
    providerThreadId?: string;
    attemptId?: string;
    withAccountLease?: boolean;
  }> = {},
) {
  const root = epochAndRoot();
  value.authority.createActorEpoch(input.withAccountLease === true
    ? {
        ...root,
        dispatchPolicy: { policyVersion: 1, workClass: "standard" },
      }
    : root);
  const turn = prepareRunningTurn(value, { turnSuffix: "usageinbox000001" });
  const operation = value.authority.prepareActorOperation({
    operationId: "hoperation_usageinboxstart01",
    actorId: rootActorId,
    turnId: null,
    kind: "actorStart",
    requestDigest: digest("1"),
    effectKey: digest("2"),
    providerIdentityJson: '{"request":{"fixture":true},"version":1}',
    createdAt: at,
  });
  const incarnationInput = {
    incarnationId: "hincarnation_usageinbox01",
    actorId: rootActorId,
    startOperationId: operation.id,
    clientRequestId: "client-request-usage-inbox-01",
    threadSource: "oprte:usage-inbox:fixture:01",
    toolsetDigest: digest("3"),
    createdAt: at,
  } as const;
  const leasedIncarnation = input.withAccountLease === true
    ? value.authority.createActorIncarnationWithAccountLease({
        ...incarnationInput,
        leaseId: "haccountlease_usageinbox01",
        candidates: [{
          accountProfileId: accountId,
          processGeneration: 1,
          profile: {
            modelId: "gpt-5.6-sol",
            reasoningEffort: "max",
            profileFallbackReason: null,
            capabilityEvidenceDigest: digest("4"),
            supportsFast: true,
          },
          routingPriority: {
            profileFallbackRank: 0,
            budgetRank: 0,
            remainingHeadroomRank: 0,
            rendezvousScore: digest("5"),
            selected: true,
          },
          operationRequest: {
            requestDigest: digest("6"),
            effectKey: operation.effectKey,
            providerIdentityJson:
              '{"request":{"account":"usage-inbox"},"version":1}',
          },
        }],
      }).incarnation
    : null;
  value.authority.transitionActorOperation({
    operationId: operation.id,
    expectedState: "prepared",
    nextState: "effectStarted",
    now: later,
  });
  value.authority.transitionActorOperation({
    operationId: operation.id,
    expectedState: "effectStarted",
    nextState: "succeeded",
    providerIdentityJson: JSON.stringify({
      providerThreadId: input.providerThreadId ?? "thread-usage-inbox",
    }),
    now: "2030-01-01T00:00:02.000Z",
  });
  const incarnation = leasedIncarnation ??
    value.authority.createActorIncarnation({
        ...incarnationInput,
        accountProfileId: accountId,
        processGeneration: 1,
      });
  const idle = value.authority.transitionActorIncarnation({
    incarnationId: incarnation.id,
    expectedState: "starting",
    nextState: "idle",
    providerThreadId: input.providerThreadId ?? "thread-usage-inbox",
    now: later,
  });
  const attempt = value.authority.createActorAttempt({
    attemptId: input.attemptId ?? "hattempt_usageinbox001",
    turnId: turn.id,
    incarnationId: idle.id,
    accountProfileId: accountId,
    processGeneration: 1,
    clientUserMessageId: "client-message-usage-inbox-01",
    createdAt: later,
  });
  return { attempt, incarnation: idle, turn };
}

function prepareRerouteAttempt(
  value: Fixture,
  input: Readonly<{
    providerThreadId?: string;
    workspaceSuffix?: string;
  }> = {},
) {
  const prepared = prepareStartingAttempt(value, {
    providerThreadId: input.providerThreadId ?? "thread-reroute-inbox",
    withAccountLease: true,
  });
  bindFixtureWorkspace(
    value,
    rootActorId,
    input.workspaceSuffix ?? "reroute_inbox",
  );
  const session = value.authority.bindActorSession({
    incarnationId: prepared.incarnation.id,
    recoveryProof: recoveryProof({ generation: 1, marker: "9" }),
    createdAt: later,
  });
  return Object.freeze({ ...prepared, session });
}

function prepareFastReservation(
  value: Fixture,
  input: Readonly<{
    suffix: string;
    updatedAt: string;
    nextState: "quarantined" | "consumed";
  }>,
) {
  const localEpochId = `hepoch_${input.suffix}`;
  const localRootActorId = `hactor_${input.suffix}`;
  const localAccountId = `acct_${input.suffix}`;
  const localTurnId = `hturn_${input.suffix}`;
  const localAttemptId = `hattempt_${input.suffix}`;
  const localReservationId = `hfast_${input.suffix}`;
  const budget = rootBudget();
  const epoch = actorEpochSchema.parse({
    id: localEpochId,
    projectId,
    sourceSha,
    rootActorId: localRootActorId,
    budget,
    tokenReserved: 0,
    byteReserved: 0,
    nextRootCompletionSequence: 1,
    state: "active",
    revision: 1,
    createdAt: at,
    updatedAt: at,
    stoppedAt: null,
  });
  const rootActor = actorSchema.parse({
    id: localRootActorId,
    epochId: localEpochId,
    parentActorId: null,
    depth: 0,
    title: `Fast scan ${input.suffix}`,
    state: "active",
    budget,
    tokenReserved: 0,
    byteReserved: 0,
    nextTurnOrdinal: 1,
    nextResultOrdinal: 1,
    revision: 1,
    createdAt: at,
    updatedAt: at,
    stoppedAt: null,
  });
  value.database.query(`
    INSERT INTO account_profiles (
      profile_id, label, auth_state, process_generation,
      selected, created_at, updated_at
    ) VALUES (?1, ?1, 'signed_in', 1, 0, ?2, ?2)
  `).run(localAccountId, at);
  value.authority.createActorEpoch({
    epoch,
    rootActor,
    dispatchPolicy: { policyVersion: 1, workClass: "boundedLeaf" },
  });
  insertContextValue(value.database, {
    valueId: `ctxval_${input.suffix}`,
    actorId: localRootActorId,
    epochId: localEpochId,
    purpose: "currentInput",
  });
  let turn = value.authority.createActorTurn({
    turnId: localTurnId,
    epochId: localEpochId,
    actorId: localRootActorId,
    idempotencyKey: `idempotency-${input.suffix}`,
    inputValueId: `ctxval_${input.suffix}`,
    createdAt: at,
  });
  turn = value.authority.transitionActorTurn({
    turnId: turn.id,
    expectedRevision: turn.revision,
    nextState: "starting",
    now: later,
  });
  const operation = value.authority.prepareActorOperation({
    operationId: `hoperation_${input.suffix}`,
    actorId: localRootActorId,
    turnId: null,
    kind: "actorStart",
    requestDigest: digest("1"),
    effectKey: digest("2"),
    providerIdentityJson: '{"request":{"fixture":"fast-scan"},"version":1}',
    createdAt: at,
  });
  const incarnation = value.authority.createActorIncarnationWithAccountLease({
    leaseId: `haccountlease_${input.suffix}`,
    incarnationId: `hincarnation_${input.suffix}`,
    actorId: localRootActorId,
    candidates: [{
      accountProfileId: localAccountId,
      processGeneration: 1,
      profile: {
        modelId: "gpt-5.6-luna",
        reasoningEffort: "max",
        profileFallbackReason: null,
        capabilityEvidenceDigest: digest("3"),
        supportsFast: true,
      },
      routingPriority: {
        profileFallbackRank: 0,
        budgetRank: 0,
        remainingHeadroomRank: 1,
        rendezvousScore: digest("4"),
        selected: false,
      },
      operationRequest: {
        requestDigest: digest("5"),
        effectKey: operation.effectKey,
        providerIdentityJson:
          '{"request":{"fixture":"fast-scan-account"},"version":1}',
      },
    }],
    startOperationId: operation.id,
    clientRequestId: `client-request-${input.suffix}`,
    threadSource: `hra:fast-scan:${input.suffix}`,
    toolsetDigest: digest("6"),
    createdAt: at,
  }).incarnation;
  value.authority.transitionActorOperation({
    operationId: operation.id,
    expectedState: "prepared",
    nextState: "effectStarted",
    now: later,
  });
  value.authority.transitionActorOperation({
    operationId: operation.id,
    expectedState: "effectStarted",
    nextState: "succeeded",
    providerIdentityJson: JSON.stringify({
      providerThreadId: `thread-${input.suffix}`,
    }),
    now: later,
  });
  const idle = value.authority.transitionActorIncarnation({
    incarnationId: incarnation.id,
    expectedState: "starting",
    nextState: "idle",
    providerThreadId: `thread-${input.suffix}`,
    now: later,
  });
  bindFixtureWorkspace(value, localRootActorId, input.suffix);
  value.authority.bindActorSession({
    incarnationId: idle.id,
    recoveryProof: recoveryProof({
      generation: 1,
      marker: input.suffix.slice(-1),
    }),
    createdAt: later,
  });
  value.authority.claimActorAttempt({
    attemptId: localAttemptId,
    turnId: turn.id,
    incarnationId: idle.id,
    accountProfileId: localAccountId,
    processGeneration: 1,
    clientUserMessageId: `client-message-${input.suffix}`,
    dispatch: {
      capabilityEvidenceDigest: digest("3"),
      fastReservationId: localReservationId,
    },
    createdAt: later,
  });
  value.authority.markActorFastReservationEffectStarted({
    reservationId: localReservationId,
    attemptId: localAttemptId,
    now: later,
  });
  return value.authority.settleActorFastReservation({
    reservationId: localReservationId,
    attemptId: localAttemptId,
    expectedState: "effectStarted",
    nextState: input.nextState,
    reason: input.nextState === "quarantined"
      ? "ambiguousProviderEffect"
      : "providerTerminal",
    now: input.updatedAt,
  });
}

describe("HarnessSQLiteAuthorityV2 actor authority", () => {
  test("keeps historical acceleration columns outside current runtime authority", async () => {
    const source = await Bun.file(new URL(
      "../src/harness/sqlite-authority-v2.ts",
      import.meta.url,
    )).text();
    expect(source).toContain("requested_service_tier");
    expect(source).not.toContain("acceleration_mode");
    expect(source).not.toContain("acceleration_critical_path");
    expect(source).not.toContain("acceleration_bottleneck");
    expect(source).not.toContain("automaticFastDisabled");
  });

  test("binds explicit successor capability evidence without rewriting admission", () => {
    const value = fixture();
    try {
      const { attempt, incarnation } = prepareStartingAttempt(value, {
        withAccountLease: true,
      });
      expect(attempt).toMatchObject({
        requestedServiceTier: "standard",
        realizedServiceTier: "standard",
      });
      bindFixtureWorkspace(value, rootActorId, "initial_successor_catalog");
      value.database.query(`
        UPDATE account_profiles SET process_generation = 2, updated_at = ?2
        WHERE profile_id = ?1
      `).run(accountId, "2030-01-01T00:00:03.000Z");
      const proof = recoveryProof({ generation: 2, marker: "8" });
      const evidence = Object.freeze({
        observationGeneration: 2,
        evidenceDigest: digest("9"),
        supportsFast: false,
      });

      const first = value.authority.bindActorSession({
        incarnationId: incarnation.id,
        liveCapabilityEvidence: evidence,
        recoveryProof: proof,
        createdAt: "2030-01-01T00:00:04.000Z",
      });
      expect(first).toMatchObject({
        admissionGeneration: 1,
        liveGeneration: 2,
        capabilityEvidenceDigest: digest("4"),
        supportsFast: true,
        liveCapabilityEvidenceDigest: digest("9"),
        liveSupportsFast: false,
      });
      expect(value.authority.bindActorSession({
        incarnationId: incarnation.id,
        liveCapabilityEvidence: evidence,
        recoveryProof: proof,
        createdAt: "2030-01-01T00:00:05.000Z",
      })).toEqual(first);
    } finally {
      value.database.close();
    }

    const changedAtAdmission = fixture();
    try {
      const { incarnation } = prepareStartingAttempt(changedAtAdmission, {
        withAccountLease: true,
      });
      bindFixtureWorkspace(
        changedAtAdmission,
        rootActorId,
        "changed_admission_catalog",
      );
      expect(() => changedAtAdmission.authority.bindActorSession({
        incarnationId: incarnation.id,
        liveCapabilityEvidence: {
          observationGeneration: 1,
          evidenceDigest: digest("9"),
          supportsFast: false,
        },
        recoveryProof: recoveryProof({ generation: 1, marker: "7" }),
        createdAt: "2030-01-01T00:00:04.000Z",
      })).toThrow("changed at admission");
      expect(changedAtAdmission.authority.readActorSessionBinding(
        incarnation.id,
      )).toBeNull();
    } finally {
      changedAtAdmission.database.close();
    }
  });

  test("atomically leases account load and fails closed around Fast provider effects", () => {
    const value = fixture();
    try {
      const { epoch, rootActor } = epochAndRoot();
      value.authority.createActorEpoch({
        epoch,
        rootActor,
        dispatchPolicy: { policyVersion: 1, workClass: "boundedLeaf" },
      });
      expect(value.authority.readActorDispatchPolicy(rootActorId)).toEqual({
        actorId: rootActorId,
        policyVersion: 1,
        workClass: "boundedLeaf",
      });
      insertContextValue(value.database, {
        valueId: "ctxval_fastpolicyinput001",
        actorId: rootActorId,
        purpose: "currentInput",
      });
      let turn = value.authority.createActorTurn({
        turnId: "hturn_fastpolicy00001",
        epochId,
        actorId: rootActorId,
        idempotencyKey: "idempotency-fast-policy-001",
        inputValueId: "ctxval_fastpolicyinput001",
        createdAt: at,
      });
      expect(value.authority.readActorTurnRequestedServiceTier(turn.id))
        .toEqual({ turnId: turn.id, requestedServiceTier: "fast" });
      turn = value.authority.transitionActorTurn({
        turnId: turn.id,
        expectedRevision: turn.revision,
        nextState: "starting",
        now: later,
      });
      const operation = value.authority.prepareActorOperation({
        operationId: "hoperation_fastpolicystart01",
        actorId: rootActorId,
        turnId: null,
        kind: "actorStart",
        requestDigest: digest("1"),
        effectKey: digest("2"),
        providerIdentityJson: '{"request":{"fast":true},"version":1}',
        createdAt: at,
      });
      const routed = value.authority.createActorIncarnationWithAccountLease({
        leaseId: "haccountlease_fastpolicy001",
        incarnationId: "hincarnation_fastpolicy001",
        actorId: rootActorId,
        candidates: [
          {
            accountProfileId: "account-fallback",
            processGeneration: 1,
            profile: {
              modelId: "gpt-5.6-sol",
              reasoningEffort: "max",
              profileFallbackReason: "lunaUnavailable",
              capabilityEvidenceDigest: digest("6"),
              supportsFast: true,
            },
            routingPriority: {
              profileFallbackRank: 1,
              budgetRank: 0,
              remainingHeadroomRank: 0,
              rendezvousScore: digest("f"),
              selected: true,
            },
            operationRequest: {
              requestDigest: digest("7"),
              effectKey: digest("2"),
              providerIdentityJson:
                '{"request":{"account":"fallback"},"version":1}',
            },
          },
          {
            accountProfileId: accountId,
            processGeneration: 1,
            profile: {
              modelId: "gpt-5.6-luna",
              reasoningEffort: "max",
              profileFallbackReason: null,
              capabilityEvidenceDigest: digest("3"),
              supportsFast: true,
            },
            routingPriority: {
              profileFallbackRank: 0,
              budgetRank: 0,
              remainingHeadroomRank: 10,
              rendezvousScore: digest("5"),
              selected: true,
            },
            operationRequest: {
              requestDigest: digest("8"),
              effectKey: digest("2"),
              providerIdentityJson:
                '{"request":{"account":"exact"},"version":1}',
            },
          },
        ],
        startOperationId: operation.id,
        clientRequestId: "client-request-fast-policy-001",
        threadSource: "hra:fast-policy:fixture:0001",
        toolsetDigest: digest("4"),
        createdAt: at,
      });
      expect(routed.incarnation.accountProfileId).toBe(accountId);
      expect(value.authority.readActorOperation(operation.id)).toMatchObject({
        requestDigest: digest("8"),
        providerIdentityJson:
          '{"request":{"account":"exact"},"version":1}',
      });
      expect(routed.activeLoad).toBe(1);
      expect(value.authority.readActiveActorAccountLoad({
        accountProfileId: accountId,
        processGeneration: 1,
      })).toBe(1);
      value.authority.transitionActorOperation({
        operationId: operation.id,
        expectedState: "prepared",
        nextState: "effectStarted",
        now: later,
      });
      value.authority.transitionActorOperation({
        operationId: operation.id,
        expectedState: "effectStarted",
        nextState: "succeeded",
        providerIdentityJson: '{"providerThreadId":"thread-fast-policy"}',
        now: "2030-01-01T00:00:02.000Z",
      });
      const idle = value.authority.transitionActorIncarnation({
        incarnationId: routed.incarnation.id,
        expectedState: "starting",
        nextState: "idle",
        providerThreadId: "thread-fast-policy",
        now: "2030-01-01T00:00:02.000Z",
      });
      bindFixtureWorkspace(value, rootActorId, "fast_policy");
      const session = value.authority.bindActorSession({
        incarnationId: idle.id,
        recoveryProof: recoveryProof({ generation: 1, marker: "5" }),
        createdAt: "2030-01-01T00:00:02.000Z",
      });
      expect(session).toMatchObject({
        modelId: "gpt-5.6-luna",
        reasoningEffort: "max",
        supportsFast: true,
      });
      expect(() => value.database.query(`
        INSERT INTO harness_actor_turn_attempts (
          attempt_id, turn_id, incarnation_id, ordinal,
          account_profile_id, process_generation, effect_generation,
          client_user_message_id, provider_turn_id, state,
          requested_service_tier, realized_service_tier,
          tier_fallback_reason, capability_evidence_digest,
          fast_reservation_id, created_at, started_at, settled_at
        ) VALUES (
          'hattempt_fastpolicymismatch1', 'hturn_fastpolicy00001',
          'hincarnation_fastpolicy001', 1, ?1, 1, 1,
          'client-message-fast-policy-mismatch', NULL, 'starting',
          'standard', 'standard', NULL, ?2, NULL, ?3, NULL, NULL
        )
      `).run(accountId, digest("3"), "2030-01-01T00:00:03.000Z"))
        .toThrow("invalid actor attempt dispatch evidence");
      expect(() => value.database.query(`
        INSERT INTO harness_actor_turn_attempts (
          attempt_id, turn_id, incarnation_id, ordinal,
          account_profile_id, process_generation, effect_generation,
          client_user_message_id, provider_turn_id, state,
          requested_service_tier, realized_service_tier,
          tier_fallback_reason, capability_evidence_digest,
          fast_reservation_id, created_at, started_at, settled_at
        ) VALUES (
          'hattempt_fastpolicylegacyfallback', 'hturn_fastpolicy00001',
          'hincarnation_fastpolicy001', 1, ?1, 1, 1,
          'client-message-fast-policy-legacy-fallback', NULL, 'starting',
          'fast', 'standard', 'automaticFastDisabled', ?2, NULL,
          ?3, NULL, NULL
        )
      `).run(accountId, digest("3"), "2030-01-01T00:00:03.000Z"))
        .toThrow("invalid actor attempt dispatch evidence");
      expect(() => value.authority.createActorAttempt({
        attemptId: "hattempt_fastpolicylegacy01",
        turnId: turn.id,
        incarnationId: idle.id,
        accountProfileId: accountId,
        processGeneration: 1,
        clientUserMessageId: "client-message-fast-policy-legacy",
        createdAt: "2030-01-01T00:00:03.000Z",
      })).toThrow(
        "Fast actor turns require claimed capability and reservation evidence",
      );
      const claimed = value.authority.claimActorAttempt({
        attemptId: "hattempt_fastpolicy0001",
        turnId: turn.id,
        incarnationId: idle.id,
        accountProfileId: accountId,
        processGeneration: 1,
        clientUserMessageId: "client-message-fast-policy-001",
        dispatch: {
          capabilityEvidenceDigest: digest("3"),
          fastReservationId: "hfast_fastpolicy00001",
        },
        createdAt: "2030-01-01T00:00:03.000Z",
      });
      expect(claimed.attempt).toMatchObject({
        processGeneration: 1,
        effectGeneration: 1,
        requestedServiceTier: "fast",
        realizedServiceTier: "fast",
        tierFallbackReason: null,
        fastReservationId: "hfast_fastpolicy00001",
      });
      expect(claimed.fastReservation?.state).toBe("reserved");
      const turnOperation = value.authority.prepareActorOperation({
        operationId: "hoperation_fastpolicyturn001",
        actorId: rootActorId,
        turnId: turn.id,
        kind: "turnStart",
        requestDigest: digest("a"),
        effectKey: digest("b"),
        providerIdentityJson: '{"request":{"tier":"fast-g1"},"version":1}',
        createdAt: "2030-01-01T00:00:03.000Z",
      });
      value.database.query(`
        UPDATE account_profiles SET process_generation = 2, updated_at = ?2
        WHERE profile_id = ?1
      `).run(accountId, "2030-01-01T00:00:04.000Z");
      const successor = value.authority.advanceActorSessionBinding({
        incarnationId: idle.id,
        expectedRevision: session.revision,
        expectedLiveGeneration: session.liveGeneration,
        liveCapabilityEvidence: {
          evidenceDigest: digest("9"),
          supportsFast: true,
        },
        recoveryProof: recoveryProof({
          generation: 2,
          marker: "8",
          priorRecoveryProofDigest:
            session.recoveryProof.recoveryProofDigest,
        }),
        now: "2030-01-01T00:00:05.000Z",
      });
      expect(() => value.authority.startActorTurnEffect({
        operationId: turnOperation.id,
        attemptId: claimed.attempt.id,
        expectedOperationRequestDigest: turnOperation.requestDigest,
        expectedSessionRevision: session.revision,
        effectGeneration: successor.liveGeneration,
        capabilityEvidenceDigest: successor.liveCapabilityEvidenceDigest,
        requestDigest: digest("c"),
        effectKey: turnOperation.effectKey,
        providerIdentityJson: '{"request":{"tier":"stale"},"version":1}',
        now: "2030-01-01T00:00:05.000Z",
      })).toThrow("revision changed");
      expect(value.authority.readActorAttempt(claimed.attempt.id)).toMatchObject({
        effectGeneration: 1,
        realizedServiceTier: "fast",
      });
      expect(value.authority.readActorFastReservationForAttempt(
        claimed.attempt.id,
      )).toMatchObject({ state: "reserved", processGeneration: 1 });
      expect(value.authority.readActorOperation(turnOperation.id)).toMatchObject({
        state: "prepared",
        requestDigest: turnOperation.requestDigest,
      });
      const fallback = value.authority.startActorTurnEffect({
        operationId: turnOperation.id,
        attemptId: claimed.attempt.id,
        expectedOperationRequestDigest: turnOperation.requestDigest,
        expectedSessionRevision: successor.revision,
        effectGeneration: successor.liveGeneration,
        capabilityEvidenceDigest: successor.liveCapabilityEvidenceDigest,
        requestDigest: digest("c"),
        effectKey: turnOperation.effectKey,
        providerIdentityJson: '{"request":{"tier":"fast-g2"},"version":1}',
        now: "2030-01-01T00:00:05.000Z",
      });
      expect(fallback).toMatchObject({
        kind: "retryStandard",
        attempt: {
          processGeneration: 1,
          effectGeneration: 2,
          realizedServiceTier: "standard",
          tierFallbackReason: "fastReservationUnavailable",
          capabilityEvidenceDigest: digest("9"),
          fastReservationId: null,
        },
        releasedFastReservation: {
          processGeneration: 1,
          state: "released",
          terminalReason: "preEffectTerminal",
        },
      });
      const started = value.authority.startActorTurnEffect({
        operationId: turnOperation.id,
        attemptId: claimed.attempt.id,
        expectedOperationRequestDigest: turnOperation.requestDigest,
        expectedSessionRevision: successor.revision,
        effectGeneration: successor.liveGeneration,
        capabilityEvidenceDigest: successor.liveCapabilityEvidenceDigest,
        requestDigest: digest("d"),
        effectKey: turnOperation.effectKey,
        providerIdentityJson: '{"request":{"tier":"standard-g2"},"version":1}',
        now: "2030-01-01T00:00:05.000Z",
      });
      expect(started).toMatchObject({
        kind: "effectStarted",
        changed: true,
        operation: {
          state: "effectStarted",
          requestDigest: digest("d"),
        },
        attempt: { processGeneration: 1, effectGeneration: 2 },
      });
      expect(value.authority.transitionActorAttempt({
        attemptId: claimed.attempt.id,
        expectedState: "starting",
        nextState: "failed",
        now: "2030-01-01T00:00:05.000Z",
      }).state).toBe("failed");
      value.authority.transitionActorIncarnation({
        incarnationId: idle.id,
        expectedState: "running",
        nextState: "closed",
        providerThreadId: "thread-fast-policy",
        now: "2030-01-01T00:00:06.000Z",
      });
      expect(value.authority.readActiveActorAccountLoad({
        accountProfileId: accountId,
        processGeneration: 1,
      })).toBe(0);
      expect(value.authority.readActorAccountLease(
        "haccountlease_fastpolicy001",
      )?.state).toBe("released");
    } finally {
      value.database.close();
    }
  });

  test("lists quarantined Fast capacity with a stable bounded recovery cursor", () => {
    const value = fixture();
    try {
      const first = prepareFastReservation(value, {
        suffix: "fastscan00000001",
        updatedAt: "2030-01-01T00:00:10.000Z",
        nextState: "quarantined",
      });
      const second = prepareFastReservation(value, {
        suffix: "fastscan00000002",
        updatedAt: "2030-01-01T00:00:10.000Z",
        nextState: "quarantined",
      });
      const ignored = prepareFastReservation(value, {
        suffix: "fastscan00000003",
        updatedAt: "2030-01-01T00:00:11.000Z",
        nextState: "consumed",
      });
      const third = prepareFastReservation(value, {
        suffix: "fastscan00000004",
        updatedAt: "2030-01-01T00:00:12.000Z",
        nextState: "quarantined",
      });
      expect(ignored.state).toBe("consumed");

      const firstPage = value.authority.listQuarantinedActorFastReservations({
        limit: 2,
      });
      expect(firstPage).toEqual([first, second]);
      expect(Object.isFrozen(firstPage)).toBe(true);
      const secondPage = value.authority.listQuarantinedActorFastReservations({
        after: {
          updatedAt: second.updatedAt,
          reservationId: second.id,
        },
        limit: 2,
      });
      expect(secondPage).toEqual([third]);
      expect(value.authority.listQuarantinedActorFastReservations({
        after: {
          updatedAt: third.updatedAt,
          reservationId: third.id,
        },
        limit: 2,
      })).toEqual([]);
      expect(() => value.authority.listQuarantinedActorFastReservations({
        limit: 0,
      })).toThrow();
      expect(() => value.authority.listQuarantinedActorFastReservations({
        limit: 129,
      })).toThrow();
    } finally {
      value.database.close();
    }
  });

  test("atomically repairs an ambiguous Fast prefix and revokes only the parent control path", () => {
    const value = fixture();
    try {
      const suffix = "fastcontain000001";
      const reservation = prepareFastReservation(value, {
        suffix,
        updatedAt: "2030-01-01T00:00:10.000Z",
        nextState: "quarantined",
      });
      const attempt = value.authority.readActorAttempt(reservation.attemptId);
      const parent = value.authority.readActor(reservation.actorId);
      if (attempt === null || parent === null) {
        throw new Error("ambiguous Fast fixture lost its lineage");
      }
      const turn = value.authority.readActorTurn(attempt.turnId);
      const incarnation = value.authority.readActorIncarnation(
        attempt.incarnationId,
      );
      if (turn === null || incarnation === null) {
        throw new Error("ambiguous Fast fixture lost its live effect");
      }
      value.database.query(`
        INSERT INTO harness_actor_turn_usage_inbox (
          attempt_id, provider_identity_digest, observation_generation,
          stream_position, cumulative_input_tokens, cumulative_output_tokens,
          quarantined, quarantine_reason
        ) VALUES (?1, ?2, 1, 3, 5, 2, 0, NULL)
      `).run(attempt.id, digest("9"));
      const liveChild = value.authority.createChildActor(actorSchema.parse({
        ...child({
          id: "hactor_fastcontain_child01",
          parent,
          tokenBudget: 5_000,
          byteBudget: 2 * MIB,
          authority: "managedWrite",
        }),
        epochId: parent.epochId,
      }), { policyVersion: 1, workClass: "standard" });
      const revisedParent = value.authority.readActor(parent.id);
      if (revisedParent === null) throw new Error("Fast parent disappeared");
      value.authority.requestActorStop({
        actorId: revisedParent.id,
        expectedRevision: revisedParent.revision,
        now: "2030-01-01T00:00:11.000Z",
      });
      const operationId = `hoperation_${suffix}`;
      const operationBefore = value.authority.readActorOperation(operationId);

      const contained = value.authority.containAmbiguousActorTurn({
        attemptId: attempt.id,
        now: "2030-01-01T00:00:12.000Z",
      });
      expect(contained).toMatchObject({
        actor: { id: parent.id, state: "quarantined" },
        evidenceTurn: { id: turn.id, state: "ambiguous" },
        containedTurn: { id: turn.id, state: "ambiguous" },
        evidenceAttempt: { id: attempt.id, state: "ambiguous" },
        containedAttempt: { id: attempt.id, state: "ambiguous" },
        evidenceIncarnation: {
          id: incarnation.id,
          state: "quarantined",
        },
        containedIncarnation: {
          id: incarnation.id,
          state: "quarantined",
        },
        evidenceFastReservation: {
          id: reservation.id,
          state: "quarantined",
          terminalReason: "ambiguousProviderEffect",
        },
        containedFastReservation: {
          id: reservation.id,
          state: "quarantined",
          terminalReason: "ambiguousProviderEffect",
        },
      });
      expect(value.authority.readActor(liveChild.id)?.state).toBe("active");
      expect(value.authority.readActorSessionBinding(incarnation.id))
        .toMatchObject({
          state: "quarantined",
          quarantineReason: "recovery_protocol_error",
          workspaceMode: "managed",
        });
      expect(value.authority.readActorAccountLease(
        `haccountlease_${suffix}`,
      )?.state).toBe("quarantined");
      expect(value.database.query(`
        SELECT state FROM harness_actor_workspace_bindings
        WHERE binding_id = ?1
      `).get(`hbinding_usage_${suffix}`)).toEqual({ state: "quarantined" });
      expect(value.database.query(`
        SELECT status, quarantine_reason FROM workspace_leases
        WHERE lane_id = ?1
      `).get(`lane_usage_${suffix}`)).toEqual({
        status: "quarantined",
        quarantine_reason: "ambiguous_provider_effect",
      });
      expect(value.database.query(`
        SELECT quarantined, quarantine_reason
        FROM harness_actor_turn_usage_inbox WHERE attempt_id = ?1
      `).get(attempt.id)).toEqual({
        quarantined: 1,
        quarantine_reason: "ambiguous_provider_effect",
      });
      expect(value.authority.readActorOperation(operationId))
        .toEqual(operationBefore);

      const replay = value.authority.containAmbiguousActorTurn({
        attemptId: attempt.id,
        now: "2030-01-01T00:00:13.000Z",
      });
      expect(replay).toMatchObject({
        actor: contained.actor,
        evidenceTurn: contained.evidenceTurn,
        containedTurn: null,
        evidenceAttempt: contained.evidenceAttempt,
        containedAttempt: null,
        evidenceIncarnation: contained.evidenceIncarnation,
        containedIncarnation: null,
        evidenceFastReservation: contained.evidenceFastReservation,
        containedFastReservation: null,
      });
      expect(value.authority.readActor(parent.id)).toEqual(contained.actor);
      expect(value.authority.readActorTurn(turn.id))
        .toEqual(contained.evidenceTurn);
      expect(value.authority.readActorAttempt(attempt.id))
        .toEqual(contained.evidenceAttempt);
      expect(value.authority.readActorOperation(operationId))
        .toEqual(operationBefore);
    } finally {
      value.database.close();
    }
  });

  test("contains an actor-wide idle incarnation and prepared turn from retired evidence", () => {
    const value = fixture();
    try {
      const source = prepareRerouteAttempt(value, {
        workspaceSuffix: "old_source_current_idle",
      });
      const terminalSource = value.authority.transitionActorAttempt({
        attemptId: source.attempt.id,
        expectedState: source.attempt.state,
        nextState: "interrupted",
        now: "2030-01-01T00:00:02.000Z",
      });
      value.authority.settleActorResult({
        resultId: "hresult_oldsource_currentidle01",
        turnId: source.turn.id,
        terminalAttemptId: terminalSource.id,
        outcome: "cancelled",
        valueId: null,
        expectedTurnRevision: source.turn.revision,
        outcomeCode: "retired_source",
        createdAt: "2030-01-01T00:00:03.000Z",
      });
      value.authority.transitionActorIncarnation({
        incarnationId: source.incarnation.id,
        expectedState: source.incarnation.state,
        nextState: "closed",
        providerThreadId: source.incarnation.providerThreadId,
        now: "2030-01-01T00:00:04.000Z",
      });
      const evidenceAttempt = value.authority.readActorAttempt(source.attempt.id);
      const evidenceTurn = value.authority.readActorTurn(source.turn.id);
      const evidenceIncarnation = value.authority.readActorIncarnation(
        source.incarnation.id,
      );
      if (
        evidenceAttempt === null || evidenceTurn === null ||
        evidenceIncarnation === null
      ) throw new Error("retired evidence fixture did not settle");

      const currentOperation = value.authority.prepareActorOperation({
        operationId: "hoperation_currentidle_start01",
        actorId: rootActorId,
        turnId: null,
        kind: "actorStart",
        requestDigest: digest("a"),
        effectKey: digest("b"),
        providerIdentityJson:
          '{"request":{"fixture":"current-idle"},"version":1}',
        createdAt: "2030-01-01T00:00:05.000Z",
      });
      const currentIncarnation = value.authority
        .createActorIncarnationWithAccountLease({
          leaseId: "haccountlease_currentidle01",
          incarnationId: "hincarnation_currentidle01",
          actorId: rootActorId,
          candidates: [{
            accountProfileId: accountId,
            processGeneration: 1,
            profile: {
              modelId: "gpt-5.6-sol",
              reasoningEffort: "max",
              profileFallbackReason: null,
              capabilityEvidenceDigest: digest("c"),
              supportsFast: true,
            },
            routingPriority: {
              profileFallbackRank: 0,
              budgetRank: 0,
              remainingHeadroomRank: 0,
              rendezvousScore: digest("d"),
              selected: true,
            },
            operationRequest: {
              requestDigest: digest("e"),
              effectKey: currentOperation.effectKey,
              providerIdentityJson:
                '{"request":{"account":"current-idle"},"version":1}',
            },
          }],
          startOperationId: currentOperation.id,
          clientRequestId: "client-request-current-idle-01",
          threadSource: "hra:current-idle:fixture:01",
          toolsetDigest: digest("f"),
          createdAt: "2030-01-01T00:00:05.000Z",
        }).incarnation;
      value.authority.transitionActorOperation({
        operationId: currentOperation.id,
        expectedState: "prepared",
        nextState: "effectStarted",
        now: "2030-01-01T00:00:06.000Z",
      });
      value.authority.transitionActorOperation({
        operationId: currentOperation.id,
        expectedState: "effectStarted",
        nextState: "succeeded",
        providerIdentityJson: JSON.stringify({
          providerThreadId: "thread-current-idle",
        }),
        now: "2030-01-01T00:00:07.000Z",
      });
      value.authority.transitionActorIncarnation({
        incarnationId: currentIncarnation.id,
        expectedState: "starting",
        nextState: "idle",
        providerThreadId: "thread-current-idle",
        now: "2030-01-01T00:00:08.000Z",
      });
      value.authority.bindActorSession({
        incarnationId: currentIncarnation.id,
        recoveryProof: recoveryProof({ generation: 1, marker: "a" }),
        createdAt: "2030-01-01T00:00:08.000Z",
      });
      insertContextValue(value.database, {
        valueId: "ctxval_currentidle_prepared01",
        actorId: rootActorId,
        purpose: "currentInput",
      });
      const currentTurn = value.authority.createActorTurn({
        turnId: "hturn_currentidle_prepared01",
        epochId,
        actorId: rootActorId,
        idempotencyKey: "idempotency-current-idle-prepared-01",
        inputValueId: "ctxval_currentidle_prepared01",
        createdAt: "2030-01-01T00:00:09.000Z",
      });
      const operationBefore = value.authority.readActorOperation(
        currentOperation.id,
      );

      const contained = value.authority.containAmbiguousActorTurn({
        attemptId: evidenceAttempt.id,
        evidenceDigest: digest("1"),
        now: "2030-01-01T00:00:10.000Z",
      });
      expect(contained).toMatchObject({
        actor: { id: rootActorId, state: "quarantined" },
        evidenceTurn,
        containedTurn: { id: currentTurn.id, state: "ambiguous" },
        evidenceAttempt,
        containedAttempt: null,
        evidenceIncarnation,
        containedIncarnation: {
          id: currentIncarnation.id,
          state: "quarantined",
        },
      });
      expect(value.authority.readActorAttempt(evidenceAttempt.id))
        .toEqual(evidenceAttempt);
      expect(value.authority.readActorTurn(evidenceTurn.id))
        .toEqual(evidenceTurn);
      expect(value.authority.readActorIncarnation(evidenceIncarnation.id))
        .toEqual(evidenceIncarnation);
      expect(value.authority.readActorSessionBinding(evidenceIncarnation.id))
        .toMatchObject({ state: "retired" });
      expect(value.authority.readActorSessionBinding(currentIncarnation.id))
        .toMatchObject({ state: "quarantined" });
      expect(value.authority.readActorAccountLease(
        "haccountlease_currentidle01",
      )?.state).toBe("quarantined");
      expect(value.authority.readActiveActorAccountLoad({
        accountProfileId: accountId,
        processGeneration: 1,
      })).toBe(0);
      expect(value.authority.readActorOperation(currentOperation.id))
        .toEqual(operationBefore);
    } finally {
      value.database.close();
    }
  });

  test("preserves a retired quota source while containing a later actor-wide effect", () => {
    const value = fixture();
    try {
      const source = prepareRerouteAttempt(value, {
        workspaceSuffix: "quota_source_later_effect",
      });
      const quotaSource = value.authority.transitionActorAttempt({
        attemptId: source.attempt.id,
        expectedState: source.attempt.state,
        nextState: "quotaRejected",
        quotaProofDigest: digest("7"),
        now: "2030-01-01T00:00:02.000Z",
      });
      const quotaTurn = value.authority.transitionActorTurn({
        turnId: source.turn.id,
        expectedRevision: source.turn.revision,
        nextState: "reconciling",
        now: "2030-01-01T00:00:02.000Z",
      });
      value.authority.settleActorResult({
        resultId: "hresult_quotasource_latereffect1",
        turnId: source.turn.id,
        terminalAttemptId: quotaSource.id,
        outcome: "quotaRejected",
        valueId: null,
        expectedTurnRevision: quotaTurn.revision,
        outcomeCode: "quota_source",
        createdAt: "2030-01-01T00:00:03.000Z",
      });
      value.authority.transitionActorIncarnation({
        incarnationId: source.incarnation.id,
        expectedState: source.incarnation.state,
        nextState: "closed",
        providerThreadId: source.incarnation.providerThreadId,
        now: "2030-01-01T00:00:04.000Z",
      });
      const evidenceAttempt = value.authority.readActorAttempt(source.attempt.id);
      const evidenceTurn = value.authority.readActorTurn(source.turn.id);
      const evidenceIncarnation = value.authority.readActorIncarnation(
        source.incarnation.id,
      );
      if (
        evidenceAttempt === null || evidenceTurn === null ||
        evidenceIncarnation === null
      ) throw new Error("quota source fixture did not settle");

      const startOperation = value.authority.prepareActorOperation({
        operationId: "hoperation_latereffect_start01",
        actorId: rootActorId,
        turnId: null,
        kind: "actorStart",
        requestDigest: digest("a"),
        effectKey: digest("b"),
        providerIdentityJson:
          '{"request":{"fixture":"later-effect"},"version":1}',
        createdAt: "2030-01-01T00:00:05.000Z",
      });
      const currentIncarnation = value.authority
        .createActorIncarnationWithAccountLease({
          leaseId: "haccountlease_latereffect01",
          incarnationId: "hincarnation_latereffect01",
          actorId: rootActorId,
          candidates: [{
            accountProfileId: accountId,
            processGeneration: 1,
            profile: {
              modelId: "gpt-5.6-sol",
              reasoningEffort: "max",
              profileFallbackReason: null,
              capabilityEvidenceDigest: digest("c"),
              supportsFast: true,
            },
            routingPriority: {
              profileFallbackRank: 0,
              budgetRank: 0,
              remainingHeadroomRank: 0,
              rendezvousScore: digest("d"),
              selected: true,
            },
            operationRequest: {
              requestDigest: digest("e"),
              effectKey: startOperation.effectKey,
              providerIdentityJson:
                '{"request":{"account":"later-effect"},"version":1}',
            },
          }],
          startOperationId: startOperation.id,
          clientRequestId: "client-request-later-effect-01",
          threadSource: "hra:later-effect:fixture:01",
          toolsetDigest: digest("f"),
          createdAt: "2030-01-01T00:00:05.000Z",
        }).incarnation;
      value.authority.transitionActorOperation({
        operationId: startOperation.id,
        expectedState: "prepared",
        nextState: "effectStarted",
        now: "2030-01-01T00:00:06.000Z",
      });
      value.authority.transitionActorOperation({
        operationId: startOperation.id,
        expectedState: "effectStarted",
        nextState: "succeeded",
        providerIdentityJson: JSON.stringify({
          providerThreadId: "thread-later-effect",
        }),
        now: "2030-01-01T00:00:07.000Z",
      });
      value.authority.transitionActorIncarnation({
        incarnationId: currentIncarnation.id,
        expectedState: "starting",
        nextState: "idle",
        providerThreadId: "thread-later-effect",
        now: "2030-01-01T00:00:08.000Z",
      });
      value.authority.bindActorSession({
        incarnationId: currentIncarnation.id,
        recoveryProof: recoveryProof({ generation: 1, marker: "a" }),
        createdAt: "2030-01-01T00:00:08.000Z",
      });
      insertContextValue(value.database, {
        valueId: "ctxval_latereffect_input01",
        actorId: rootActorId,
        purpose: "currentInput",
      });
      let currentTurn = value.authority.createActorTurn({
        turnId: "hturn_latereffect_current01",
        epochId,
        actorId: rootActorId,
        idempotencyKey: "idempotency-later-effect-current-01",
        inputValueId: "ctxval_latereffect_input01",
        createdAt: "2030-01-01T00:00:09.000Z",
      });
      currentTurn = value.authority.transitionActorTurn({
        turnId: currentTurn.id,
        expectedRevision: currentTurn.revision,
        nextState: "starting",
        now: "2030-01-01T00:00:10.000Z",
      });
      const currentAttempt = value.authority.claimActorAttempt({
        attemptId: "hattempt_latereffect_current01",
        turnId: currentTurn.id,
        incarnationId: currentIncarnation.id,
        accountProfileId: accountId,
        processGeneration: 1,
        clientUserMessageId: "client-message-later-effect-01",
        dispatch: { capabilityEvidenceDigest: digest("c") },
        createdAt: "2030-01-01T00:00:10.000Z",
      }).attempt;
      const turnOperation = value.authority.prepareActorOperation({
        operationId: "hoperation_latereffect_turn01",
        actorId: rootActorId,
        turnId: currentTurn.id,
        kind: "turnStart",
        requestDigest: digest("c"),
        effectKey: digest("d"),
        providerIdentityJson:
          '{"request":{"fixture":"later-turn-effect"},"version":1}',
        createdAt: "2030-01-01T00:00:10.000Z",
      });
      value.authority.transitionActorOperation({
        operationId: turnOperation.id,
        expectedState: "prepared",
        nextState: "effectStarted",
        providerIdentityJson: turnOperation.providerIdentityJson,
        now: "2030-01-01T00:00:11.000Z",
      });
      const operationBefore = value.authority.readActorOperation(
        turnOperation.id,
      );

      const contained = value.authority.containAmbiguousActorTurn({
        attemptId: evidenceAttempt.id,
        evidenceDigest: digest("2"),
        now: "2030-01-01T00:00:12.000Z",
      });
      expect(contained).toMatchObject({
        evidenceTurn,
        containedTurn: { id: currentTurn.id, state: "ambiguous" },
        evidenceAttempt,
        containedAttempt: { id: currentAttempt.id, state: "ambiguous" },
        evidenceIncarnation,
        containedIncarnation: {
          id: currentIncarnation.id,
          state: "quarantined",
        },
      });
      expect(value.authority.readActorAttempt(evidenceAttempt.id))
        .toEqual(evidenceAttempt);
      expect(value.authority.readActorTurn(evidenceTurn.id))
        .toEqual(evidenceTurn);
      expect(value.authority.readActorIncarnation(evidenceIncarnation.id))
        .toEqual(evidenceIncarnation);
      expect(value.authority.readActorOperation(turnOperation.id))
        .toEqual(operationBefore);
      expect(value.authority.readActiveActorAccountLoad({
        accountProfileId: accountId,
        processGeneration: 1,
      })).toBe(0);
    } finally {
      value.database.close();
    }
  });

  test("persists a content-free early reroute across reopen and binds it atomically", async () => {
    const value = fixture();
    let database = value.database;
    try {
      const prepared = prepareRerouteAttempt(value);
      const fact = {
        accountProfileId: accountId,
        observationGeneration: 1,
        providerThreadId: "thread-reroute-inbox",
        providerTurnId: "provider-turn-reroute-inbox",
        streamPosition: 71,
        fromModel: "gpt-5.6-sol",
        toModel: "safety-reroute-model",
        reason: "highRiskCyberActivity" as const,
      };
      const [pending] = await value.authority.recordActorModelReroute(fact);
      if (pending === undefined) throw new Error("pending reroute is missing");
      expect(pending).toMatchObject({
        attemptId: prepared.attempt.id,
        state: "pending",
        boundAt: null,
      });
      expect(await value.authority.recordActorModelReroute(fact))
        .toEqual([pending]);
      const stored = database.query<{
        attempt_id: string;
        provider_identity_digest: string;
        fact_digest: string;
      }, []>(`
        SELECT * FROM harness_actor_model_reroute_inbox
      `).get();
      if (stored === null) throw new Error("stored reroute is missing");
      const encoded = JSON.stringify(stored);
      expect(encoded).not.toContain(accountId);
      expect(encoded).not.toContain(fact.providerThreadId);
      expect(encoded).not.toContain(fact.providerTurnId);
      expect(stored.attempt_id).toBe(prepared.attempt.id);
      expect(stored.provider_identity_digest).toMatch(/^[0-9a-f]{64}$/);
      expect(stored.fact_digest).toMatch(/^[0-9a-f]{64}$/);

      const beforeBind = database.serialize();
      database.close();
      database = Database.deserialize(beforeBind, { strict: true });
      database.exec("PRAGMA foreign_keys = ON");
      let restarted = new HarnessSQLiteAuthorityV2(database, {
        now: () => new Date("2030-01-01T00:00:04.000Z"),
        tokenUsageIdentities,
      });
      expect(restarted.readActorModelRerouteForAttempt(prepared.attempt.id))
        .toEqual(pending);
      await restarted.bindActorAttemptProviderTurn({
        attemptId: prepared.attempt.id,
        expectedState: "starting",
        providerTurnId: fact.providerTurnId,
      });
      expect(restarted.readActorModelRerouteForAttempt(prepared.attempt.id))
        .toMatchObject({
          state: "bound",
          boundAt: "2030-01-01T00:00:04.000Z",
        });

      const afterBind = database.serialize();
      database.close();
      database = Database.deserialize(afterBind, { strict: true });
      database.exec("PRAGMA foreign_keys = ON");
      restarted = new HarnessSQLiteAuthorityV2(database, {
        now: () => new Date("2030-01-01T00:00:05.000Z"),
        tokenUsageIdentities,
      });
      const [bound] = restarted.listUnsettledActorModelReroutes({ limit: 1 });
      expect(bound).toMatchObject({
        attemptId: prepared.attempt.id,
        state: "bound",
      });
      if (bound === undefined) throw new Error("bound reroute is missing");
      expect(restarted.settleActorModelReroute({
        attemptId: bound.attemptId,
        factDigest: bound.factDigest,
        expectedState: "bound",
      })).toMatchObject({ state: "settled" });
      expect(restarted.listUnsettledActorModelReroutes({ limit: 1 }))
        .toEqual([]);
    } finally {
      database.close();
    }
  });

  test("re-resolves reroute ownership when provider binding wins the HMAC race", async () => {
    const firstDigestStarted = deferred<void>();
    const releaseFirstDigest = deferred<void>();
    let digestCalls = 0;
    const racingIdentities: ActorTokenUsageIdentityPortV2 = Object.freeze({
      digest: async (input: ActorTokenUsageIdentityInput) => {
        digestCalls += 1;
        if (digestCalls === 1) {
          firstDigestStarted.resolve(undefined);
          await releaseFirstDigest.promise;
        }
        return await tokenUsageIdentities.digest(input);
      },
    });
    const value = fixture(racingIdentities);
    try {
      const prepared = prepareRerouteAttempt(value, {
        workspaceSuffix: "reroute_digest_race",
      });
      const fact = {
        accountProfileId: accountId,
        observationGeneration: 1,
        providerThreadId: "thread-reroute-inbox",
        providerTurnId: "provider-turn-reroute-digest-race",
        streamPosition: 76,
        fromModel: "gpt-5.6-sol",
        toModel: "safety-reroute-model",
        reason: "highRiskCyberActivity" as const,
      };
      const recording = value.authority.recordActorModelReroute(fact);
      await firstDigestStarted.promise;
      await value.authority.bindActorAttemptProviderTurn({
        attemptId: prepared.attempt.id,
        expectedState: "starting",
        providerTurnId: fact.providerTurnId,
      });
      releaseFirstDigest.resolve(undefined);
      expect(await recording).toMatchObject([{
        attemptId: prepared.attempt.id,
        state: "bound",
      }]);
      expect(digestCalls).toBe(2);
    } finally {
      value.database.close();
    }
  });

  test("preserves a generation-G reroute while session custody advances to G plus 1", async () => {
    const firstDigestStarted = deferred<void>();
    const releaseFirstDigest = deferred<void>();
    let digestCalls = 0;
    const racingIdentities: ActorTokenUsageIdentityPortV2 = Object.freeze({
      digest: async (input: ActorTokenUsageIdentityInput) => {
        digestCalls += 1;
        if (digestCalls === 1) {
          firstDigestStarted.resolve(undefined);
          await releaseFirstDigest.promise;
        }
        return await tokenUsageIdentities.digest(input);
      },
    });
    const value = fixture(racingIdentities);
    try {
      const prepared = prepareRerouteAttempt(value, {
        workspaceSuffix: "reroute_generation_race",
      });
      const fact = {
        accountProfileId: accountId,
        observationGeneration: 1,
        providerThreadId: "thread-reroute-inbox",
        providerTurnId: "provider-turn-reroute-generation-race",
        streamPosition: 78,
        fromModel: "gpt-5.6-sol",
        toModel: "safety-reroute-model",
        reason: "highRiskCyberActivity" as const,
      };
      const recording = value.authority.recordActorModelReroute(fact);
      await firstDigestStarted.promise;
      value.database.query(`
        UPDATE account_profiles SET process_generation = 2, updated_at = ?2
        WHERE profile_id = ?1
      `).run(accountId, "2030-01-01T00:00:04.000Z");
      const successor = value.authority.advanceActorSessionBinding({
        incarnationId: prepared.incarnation.id,
        expectedRevision: prepared.session.revision,
        expectedLiveGeneration: prepared.session.liveGeneration,
        liveCapabilityEvidence: {
          evidenceDigest: digest("8"),
          supportsFast: true,
        },
        recoveryProof: recoveryProof({
          generation: 2,
          priorRecoveryProofDigest:
            prepared.session.recoveryProof.recoveryProofDigest,
          marker: "7",
        }),
        now: "2030-01-01T00:00:04.000Z",
      });
      releaseFirstDigest.resolve(undefined);

      const [pending] = await recording;
      expect(pending).toMatchObject({
        attemptId: prepared.attempt.id,
        observationGeneration: 1,
        state: "pending",
      });
      if (pending === undefined) {
        throw new Error("generation-race reroute record is missing");
      }
      expect(successor).toMatchObject({
        admissionGeneration: 1,
        liveGeneration: 2,
      });
      expect(await value.authority.recordActorModelReroute(fact))
        .toEqual([pending]);
      await value.authority.bindActorAttemptProviderTurn({
        attemptId: prepared.attempt.id,
        expectedState: "starting",
        providerTurnId: fact.providerTurnId,
      });
      expect(value.authority.readActorModelRerouteForAttempt(
        prepared.attempt.id,
      )).toMatchObject({
        observationGeneration: 1,
        state: "bound",
      });
    } finally {
      releaseFirstDigest.resolve(undefined);
      value.database.close();
    }
  });

  test("prefers an exact old provider turn over a newer unbound fallback", async () => {
    const value = fixture();
    try {
      const prepared = prepareRerouteAttempt(value, {
        workspaceSuffix: "reroute_exact_precedence",
      });
      const providerTurnId = "provider-turn-reroute-exact-old";
      await value.authority.bindActorAttemptProviderTurn({
        attemptId: prepared.attempt.id,
        expectedState: "starting",
        providerTurnId,
      });
      const newerTurn = prepareRunningTurn(value, {
        turnSuffix: "rerouteexactnewer02",
      });
      const newerAttempt = value.authority.createActorAttempt({
        attemptId: "hattempt_rerouteexactnewer02",
        turnId: newerTurn.id,
        incarnationId: prepared.incarnation.id,
        accountProfileId: accountId,
        processGeneration: 1,
        clientUserMessageId: "client-message-reroute-exact-newer-02",
        createdAt: "2030-01-01T00:00:03.000Z",
      });
      const [record] = await value.authority.recordActorModelReroute({
        accountProfileId: accountId,
        observationGeneration: 1,
        providerThreadId: "thread-reroute-inbox",
        providerTurnId,
        streamPosition: 79,
        fromModel: "gpt-5.6-sol",
        toModel: "safety-reroute-model",
        reason: "highRiskCyberActivity",
      });
      expect(record).toMatchObject({
        attemptId: prepared.attempt.id,
        state: "bound",
      });
      expect(value.authority.readActorModelRerouteForAttempt(newerAttempt.id))
        .toBeNull();

      const insertInvalidInboxState = (
        state: "bound" | "settled",
      ): void => {
        value.database.query(`
          INSERT INTO harness_actor_model_reroute_inbox (
            attempt_id, provider_identity_digest, observation_generation,
            stream_position, from_model, to_model, reason, fact_digest,
            state, quarantine_reason, created_at, updated_at, bound_at,
            quarantined_at, settled_at
          ) VALUES (
            ?1, ?2, 1, 80, 'gpt-5.6-sol', 'safety-reroute-model',
            'highRiskCyberActivity', ?3, ?4, NULL, ?5, ?5, ?5, NULL, ?6
          )
        `).run(
          newerAttempt.id,
          digest(state === "bound" ? "3" : "4"),
          digest(state === "bound" ? "5" : "6"),
          state,
          "2030-01-01T00:00:04.000Z",
          state === "settled" ? "2030-01-01T00:00:04.000Z" : null,
        );
      };
      expect(() => insertInvalidInboxState("bound"))
        .toThrow("actor model reroute inbox lineage is incoherent");
      expect(() => insertInvalidInboxState("settled"))
        .toThrow("actor model reroute inbox lineage is incoherent");
    } finally {
      value.database.close();
    }
  });

  test("admits an exact reroute from a retired actor session", async () => {
    const value = fixture();
    try {
      const prepared = prepareRerouteAttempt(value, {
        workspaceSuffix: "reroute_retired_exact",
      });
      const providerTurnId = "provider-turn-reroute-retired-exact";
      const bound = await value.authority.bindActorAttemptProviderTurn({
        attemptId: prepared.attempt.id,
        expectedState: "starting",
        providerTurnId,
      });
      const terminal = value.authority.transitionActorAttempt({
        attemptId: bound.id,
        expectedState: bound.state,
        nextState: "interrupted",
        now: "2030-01-01T00:00:03.000Z",
      });
      value.authority.settleActorResult({
        resultId: "hresult_rerouteretiredexact01",
        turnId: prepared.turn.id,
        terminalAttemptId: terminal.id,
        outcome: "cancelled",
        valueId: null,
        expectedTurnRevision: prepared.turn.revision,
        outcomeCode: "retired_reroute_source",
        createdAt: "2030-01-01T00:00:04.000Z",
      });
      value.authority.transitionActorIncarnation({
        incarnationId: prepared.incarnation.id,
        expectedState: prepared.incarnation.state,
        nextState: "closed",
        providerThreadId: prepared.incarnation.providerThreadId,
        now: "2030-01-01T00:00:05.000Z",
      });
      expect(value.authority.readActorSessionBinding(prepared.incarnation.id))
        .toMatchObject({ state: "retired", liveGeneration: 1 });

      expect(await value.authority.recordActorModelReroute({
        accountProfileId: accountId,
        observationGeneration: 1,
        providerThreadId: "thread-reroute-inbox",
        providerTurnId,
        streamPosition: 81,
        fromModel: "gpt-5.6-sol",
        toModel: "safety-reroute-model",
        reason: "highRiskCyberActivity",
      })).toMatchObject([{
        attemptId: prepared.attempt.id,
        observationGeneration: 1,
        state: "bound",
      }]);
    } finally {
      value.database.close();
    }
  });

  test("settles a reroute that finishes HMAC custody after a clean actor stop", async () => {
    const digestStarted = deferred<void>();
    const releaseDigest = deferred<void>();
    let blockNextDigest = false;
    const racingIdentities: ActorTokenUsageIdentityPortV2 = Object.freeze({
      digest: async (input: ActorTokenUsageIdentityInput) => {
        if (blockNextDigest) {
          blockNextDigest = false;
          digestStarted.resolve(undefined);
          await releaseDigest.promise;
        }
        return await tokenUsageIdentities.digest(input);
      },
    });
    const value = fixture(racingIdentities);
    let database = value.database;
    try {
      const prepared = prepareRerouteAttempt(value, {
        workspaceSuffix: "reroute_stopped_hmac",
      });
      const providerTurnId = "provider-turn-reroute-stopped-hmac";
      const bound = await value.authority.bindActorAttemptProviderTurn({
        attemptId: prepared.attempt.id,
        expectedState: "starting",
        providerTurnId,
      });
      const terminal = value.authority.transitionActorAttempt({
        attemptId: bound.id,
        expectedState: bound.state,
        nextState: "interrupted",
        now: "2030-01-01T00:00:03.000Z",
      });
      value.authority.settleActorResult({
        resultId: "hresult_reroutestoppedhmac01",
        turnId: prepared.turn.id,
        terminalAttemptId: terminal.id,
        outcome: "cancelled",
        valueId: null,
        expectedTurnRevision: prepared.turn.revision,
        outcomeCode: "clean_stop_before_delayed_reroute",
        createdAt: "2030-01-01T00:00:04.000Z",
      });
      value.authority.transitionActorIncarnation({
        incarnationId: prepared.incarnation.id,
        expectedState: prepared.incarnation.state,
        nextState: "closed",
        providerThreadId: prepared.incarnation.providerThreadId,
        now: "2030-01-01T00:00:05.000Z",
      });
      const fact = {
        accountProfileId: accountId,
        observationGeneration: 1,
        providerThreadId: "thread-reroute-inbox",
        providerTurnId,
        streamPosition: 82,
        fromModel: "gpt-5.6-sol",
        toModel: "safety-reroute-model",
        reason: "highRiskCyberActivity" as const,
        now: "2030-01-01T00:00:06.000Z",
      };
      blockNextDigest = true;
      const recording = value.authority.recordActorModelReroute(fact);
      await digestStarted.promise;
      let actor = value.authority.readActor(rootActorId);
      if (actor === null) throw new Error("stopped-reroute actor is missing");
      actor = value.authority.requestActorStop({
        actorId: actor.id,
        expectedRevision: actor.revision,
        now: "2030-01-01T00:00:07.000Z",
      });
      const stopped = value.authority.settleActorStop({
        actorId: actor.id,
        expectedRevision: actor.revision,
        nextState: "stopped",
        now: "2030-01-01T00:00:08.000Z",
      });
      releaseDigest.resolve(undefined);
      const [record] = await recording;
      if (record === undefined) throw new Error("stopped reroute was dropped");
      expect(record).toMatchObject({
        attemptId: terminal.id,
        observationGeneration: 1,
        state: "bound",
      });

      const attemptBefore = value.authority.readActorAttempt(terminal.id);
      const turnBefore = value.authority.readActorTurn(prepared.turn.id);
      const incarnationBefore = value.authority.readActorIncarnation(
        prepared.incarnation.id,
      );
      const operationBefore = value.authority.readActorOperation(
        prepared.incarnation.startOperationId,
      );
      const reopenedBytes = database.serialize();
      database.close();
      database = Database.deserialize(reopenedBytes, { strict: true });
      database.exec("PRAGMA foreign_keys = ON");
      const restarted = new HarnessSQLiteAuthorityV2(database, {
        now: () => new Date("2030-01-01T00:00:09.000Z"),
        tokenUsageIdentities,
      });

      const contained = restarted.containAmbiguousActorTurn({
        attemptId: terminal.id,
        evidenceDigest: record.factDigest,
      });
      expect(contained).toMatchObject({
        actor: stopped,
        evidenceAttempt: attemptBefore,
        evidenceTurn: turnBefore,
        evidenceIncarnation: incarnationBefore,
        containedAttempt: null,
        containedTurn: null,
        containedIncarnation: null,
        containedFastReservation: null,
      });
      expect(restarted.readActorAttempt(terminal.id)).toEqual(attemptBefore);
      expect(restarted.readActorTurn(prepared.turn.id)).toEqual(turnBefore);
      expect(restarted.readActorIncarnation(prepared.incarnation.id))
        .toEqual(incarnationBefore);
      expect(restarted.readActorOperation(prepared.incarnation.startOperationId))
        .toEqual(operationBefore);
      const settled = restarted.settleActorModelReroute({
        attemptId: terminal.id,
        factDigest: record.factDigest,
        expectedState: "bound",
      });
      expect(settled.state).toBe("settled");
      expect(await restarted.recordActorModelReroute(fact)).toEqual([settled]);
      expect(restarted.containAmbiguousActorTurn({
        attemptId: terminal.id,
        evidenceDigest: record.factDigest,
      })).toMatchObject({
        actor: stopped,
        evidenceAttempt: attemptBefore,
        evidenceTurn: turnBefore,
        evidenceIncarnation: incarnationBefore,
        containedAttempt: null,
        containedTurn: null,
        containedIncarnation: null,
      });
      expect(restarted.settleActorModelReroute({
        attemptId: terminal.id,
        factDigest: record.factDigest,
        expectedState: "bound",
      })).toEqual(settled);
    } finally {
      releaseDigest.resolve(undefined);
      database.close();
    }
  });

  test("rejects stopped reroute containment when any live lineage remains", async () => {
    const value = fixture();
    try {
      const prepared = prepareRerouteAttempt(value, {
        workspaceSuffix: "reroute_stopped_live",
      });
      const providerTurnId = "provider-turn-reroute-stopped-live";
      await value.authority.bindActorAttemptProviderTurn({
        attemptId: prepared.attempt.id,
        expectedState: "starting",
        providerTurnId,
      });
      const [record] = await value.authority.recordActorModelReroute({
        accountProfileId: accountId,
        observationGeneration: 1,
        providerThreadId: "thread-reroute-inbox",
        providerTurnId,
        streamPosition: 83,
        fromModel: "gpt-5.6-sol",
        toModel: "safety-reroute-model",
        reason: "highRiskCyberActivity",
      });
      if (record === undefined) throw new Error("live reroute is missing");
      const actor = value.authority.readActor(rootActorId);
      if (actor === null) throw new Error("live reroute actor is missing");
      value.database.query(`
        UPDATE harness_actors SET
          state = 'stopped', revision = revision + 1,
          updated_at = ?2, stopped_at = ?2
        WHERE actor_id = ?1
      `).run(actor.id, "2030-01-01T00:00:04.000Z");
      const attemptBefore = value.authority.readActorAttempt(
        prepared.attempt.id,
      );
      const turnBefore = value.authority.readActorTurn(prepared.turn.id);
      const incarnationBefore = value.authority.readActorIncarnation(
        prepared.incarnation.id,
      );
      const operationBefore = value.authority.readActorOperation(
        prepared.incarnation.startOperationId,
      );

      expect(() => value.authority.containAmbiguousActorTurn({
        attemptId: prepared.attempt.id,
        evidenceDigest: record.factDigest,
      })).toThrow("stopped actor retains live ambiguous containment lineage");
      expect(value.authority.readActorModelRerouteForAttempt(
        prepared.attempt.id,
      )).toEqual(record);
      expect(value.authority.readActorAttempt(prepared.attempt.id))
        .toEqual(attemptBefore);
      expect(value.authority.readActorTurn(prepared.turn.id))
        .toEqual(turnBefore);
      expect(value.authority.readActorIncarnation(prepared.incarnation.id))
        .toEqual(incarnationBefore);
      expect(value.authority.readActorOperation(prepared.incarnation.startOperationId))
        .toEqual(operationBefore);
    } finally {
      value.database.close();
    }
  });

  test("quarantines reroute identity mismatch and ambiguous candidates with a bounded cursor", async () => {
    const mismatch = fixture();
    try {
      const prepared = prepareRerouteAttempt(mismatch, {
        workspaceSuffix: "reroute_mismatch",
      });
      const fact = {
        accountProfileId: accountId,
        observationGeneration: 1,
        providerThreadId: "thread-reroute-inbox",
        providerTurnId: "provider-turn-reroute-expected",
        streamPosition: 81,
        fromModel: "gpt-5.6-sol",
        toModel: "safety-reroute-model",
        reason: "highRiskCyberActivity" as const,
      };
      expect(await mismatch.authority.recordActorModelReroute(fact))
        .toMatchObject([{ state: "pending" }]);
      await mismatch.authority.bindActorAttemptProviderTurn({
        attemptId: prepared.attempt.id,
        expectedState: "starting",
        providerTurnId: "provider-turn-reroute-conflict",
      });
      const conflicted = mismatch.authority.readActorModelRerouteForAttempt(
        prepared.attempt.id,
      );
      expect(conflicted).toMatchObject({
        state: "quarantined",
        quarantineReason: "provider_identity_conflict",
      });
      if (conflicted === null) throw new Error("conflicted reroute is missing");
      expect(mismatch.authority.settleActorModelReroute({
        attemptId: conflicted.attemptId,
        factDigest: conflicted.factDigest,
        expectedState: "quarantined",
      })).toMatchObject({
        state: "settled",
        quarantineReason: "provider_identity_conflict",
      });
    } finally {
      mismatch.database.close();
    }

    const ambiguous = fixture();
    try {
      const prepared = prepareRerouteAttempt(ambiguous, {
        workspaceSuffix: "reroute_ambiguous",
      });
      const secondTurn = prepareRunningTurn(ambiguous, {
        turnSuffix: "rerouteambiguous02",
      });
      const secondAttempt = ambiguous.authority.createActorAttempt({
        attemptId: "hattempt_rerouteambiguous02",
        turnId: secondTurn.id,
        incarnationId: prepared.incarnation.id,
        accountProfileId: accountId,
        processGeneration: 1,
        clientUserMessageId: "client-message-reroute-ambiguous-02",
        createdAt: later,
      });
      const fact = {
        accountProfileId: accountId,
        observationGeneration: 1,
        providerThreadId: "thread-reroute-inbox",
        providerTurnId: "provider-turn-reroute-ambiguous",
        streamPosition: 91,
        fromModel: "gpt-5.6-sol",
        toModel: "safety-reroute-model",
        reason: "highRiskCyberActivity" as const,
      };
      const records = await ambiguous.authority.recordActorModelReroute(fact);
      expect(records.map(({ attemptId, state, quarantineReason }) => ({
        attemptId,
        state,
        quarantineReason,
      }))).toEqual(([
        {
          attemptId: secondAttempt.id,
          state: "quarantined",
          quarantineReason: "ambiguous_candidate",
        },
        {
          attemptId: prepared.attempt.id,
          state: "quarantined",
          quarantineReason: "ambiguous_candidate",
        },
      ] as const).toSorted((left, right) =>
        left.attemptId.localeCompare(right.attemptId)
      ));
      expect(await ambiguous.authority.recordActorModelReroute(fact))
        .toEqual(records);

      const firstPage = ambiguous.authority.listUnsettledActorModelReroutes({
        limit: 1,
      });
      expect(firstPage).toHaveLength(1);
      const first = firstPage[0]!;
      const secondPage = ambiguous.authority.listUnsettledActorModelReroutes({
        after: { updatedAt: first.updatedAt, attemptId: first.attemptId },
        limit: 1,
      });
      expect(secondPage).toHaveLength(1);
      const second = secondPage[0]!;
      expect(ambiguous.authority.listUnsettledActorModelReroutes({
        after: { updatedAt: second.updatedAt, attemptId: second.attemptId },
        limit: 1,
      })).toEqual([]);
      expect(() => ambiguous.authority.listUnsettledActorModelReroutes({
        limit: 0,
      })).toThrow();
      expect(() => ambiguous.authority.listUnsettledActorModelReroutes({
        limit: 129,
      })).toThrow();
    } finally {
      ambiguous.database.close();
    }
  });

  test("durably buffers opaque cumulative usage and consumes exact reconciliation", async () => {
    const value = fixture();
    try {
      const { attempt } = prepareStartingAttempt(value);
      const usage = {
        accountProfileId: accountId,
        processGeneration: 1,
        providerThreadId: "thread-usage-inbox",
        providerTurnId: "provider-turn-usage-inbox",
        streamPosition: 41,
        cumulativeInputTokens: 321,
        cumulativeOutputTokens: 89,
        cumulativeCachedInputTokens: 200,
        cumulativeReasoningOutputTokens: 40,
      } as const;
      expect(await value.authority.recordActorTurnUsage(usage)).toBe(true);
      expect(value.authority.readActorTurnUsage({
        accountProfileId: usage.accountProfileId,
        processGeneration: usage.processGeneration,
        providerTurnId: usage.providerTurnId,
      })).toBeNull();
      const inboxColumns = value.database.query(`
        SELECT name FROM pragma_table_info('harness_actor_turn_usage_inbox')
        ORDER BY cid
      `).all().map((row) => (row as { name: string }).name);
      expect(inboxColumns).toEqual([
        "attempt_id",
        "provider_identity_digest",
        "observation_generation",
        "stream_position",
        "cumulative_input_tokens",
        "cumulative_output_tokens",
        "quarantined",
        "quarantine_reason",
        "cumulative_cached_input_tokens",
        "cumulative_reasoning_output_tokens",
      ]);
      const expectedIdentityDigest = await tokenUsageIdentities.digest({
        epochId,
        actorId: rootActorId,
        accountProfileId: usage.accountProfileId,
        processGeneration: usage.processGeneration,
        providerThreadId: usage.providerThreadId,
        providerTurnId: usage.providerTurnId,
      });
      const buffered = value.database.query(`
        SELECT attempt_id, provider_identity_digest, observation_generation,
          stream_position,
          cumulative_input_tokens, cumulative_output_tokens,
          cumulative_cached_input_tokens,
          cumulative_reasoning_output_tokens
        FROM harness_actor_turn_usage_inbox
      `).get();
      expect(buffered).toEqual({
        attempt_id: attempt.id,
        provider_identity_digest: expectedIdentityDigest,
        observation_generation: usage.processGeneration,
        stream_position: usage.streamPosition,
        cumulative_input_tokens: usage.cumulativeInputTokens,
        cumulative_output_tokens: usage.cumulativeOutputTokens,
        cumulative_cached_input_tokens: usage.cumulativeCachedInputTokens,
        cumulative_reasoning_output_tokens:
          usage.cumulativeReasoningOutputTokens,
      });
      const serializedBuffered = JSON.stringify(buffered);
      expect(serializedBuffered).not.toContain(usage.accountProfileId);
      expect(serializedBuffered).not.toContain(usage.providerThreadId);
      expect(serializedBuffered).not.toContain(usage.providerTurnId);

      const restarted = new HarnessSQLiteAuthorityV2(value.database, {
        now: () => new Date("2030-01-01T00:00:03.000Z"),
        tokenUsageIdentities,
      });
      expect(await restarted.recordActorTurnUsage(usage)).toBe(true);
      await expectRejectedMessage(restarted.recordActorTurnUsage({
        ...usage,
        cumulativeCachedInputTokens: usage.cumulativeCachedInputTokens + 1,
      }), "conflicting actor usage");
      await expectRejectedMessage(restarted.recordActorTurnUsage({
        ...usage,
        cumulativeReasoningOutputTokens:
          usage.cumulativeReasoningOutputTokens + 1,
      }), "conflicting actor usage");
      expect(await restarted.recordActorTurnUsage({
        ...usage,
        providerThreadId: "ordinary-root-thread",
      })).toBe(false);
      await expectRejectedMessage(restarted.recordActorTurnUsage({
        ...usage,
        cumulativeOutputTokens: usage.cumulativeOutputTokens + 1,
      }), "conflicting actor usage");
      expect(await restarted.recordActorTurnUsage({
        ...usage,
        streamPosition: 42,
      })).toBe(true);
      const advancedUsage = {
        ...usage,
        streamPosition: 43,
        cumulativeInputTokens: 330,
        cumulativeOutputTokens: 95,
        cumulativeCachedInputTokens: 205,
        cumulativeReasoningOutputTokens: 43,
      } as const;
      expect(await restarted.recordActorTurnUsage(advancedUsage)).toBe(true);
      expect(await restarted.recordActorTurnUsage({
        ...usage,
        streamPosition: 42,
      })).toBe(true);
      await expectRejectedMessage(restarted.recordActorTurnUsage({
        ...advancedUsage,
        streamPosition: 44,
        cumulativeInputTokens: 329,
      }), "regressed actor token evidence");

      restarted.transitionActorAttempt({
        attemptId: attempt.id,
        expectedState: "starting",
        nextState: "reconciling",
        now: "2030-01-01T00:00:04.000Z",
      });
      await expectRejectedMessage(restarted.bindActorAttemptProviderTurn({
        attemptId: attempt.id,
        expectedState: "reconciling",
        providerTurnId: "provider-turn-wrong",
      }), "contradicts its bound provider identity");
      expect(restarted.readActorAttempt(attempt.id)).toMatchObject({
        state: "reconciling",
        providerTurnId: null,
        inputTokens: null,
        outputTokens: null,
      });
      expect(value.database.query(`
        SELECT COUNT(*) AS count FROM harness_actor_turn_usage_inbox
      `).get()).toEqual({ count: 1 });
      const bound = await restarted.bindActorAttemptProviderTurn({
        attemptId: attempt.id,
        expectedState: "reconciling",
        providerTurnId: usage.providerTurnId,
      });
      expect(bound).toMatchObject({
        providerTurnId: usage.providerTurnId,
        tokenUsageIdentityDigest: expectedIdentityDigest,
        tokenUsageStreamPosition: advancedUsage.streamPosition,
        tokenUsageCumulativeInputTokens: advancedUsage.cumulativeInputTokens,
        tokenUsageCumulativeOutputTokens: advancedUsage.cumulativeOutputTokens,
        tokenUsageCumulativeCachedInputTokens:
          advancedUsage.cumulativeCachedInputTokens,
        tokenUsageCumulativeReasoningOutputTokens:
          advancedUsage.cumulativeReasoningOutputTokens,
        inputTokens: advancedUsage.cumulativeInputTokens,
        outputTokens: advancedUsage.cumulativeOutputTokens,
        cachedInputTokens: advancedUsage.cumulativeCachedInputTokens,
        reasoningOutputTokens: advancedUsage.cumulativeReasoningOutputTokens,
        state: "reconciling",
      });

      const running = restarted.transitionActorAttempt({
        attemptId: attempt.id,
        expectedState: "reconciling",
        nextState: "running",
        now: "2030-01-01T00:00:06.000Z",
      });
      expect(running).toMatchObject({
        providerTurnId: usage.providerTurnId,
        inputTokens: advancedUsage.cumulativeInputTokens,
        outputTokens: advancedUsage.cumulativeOutputTokens,
        state: "running",
      });
      expect(value.database.query(`
        SELECT COUNT(*) AS count FROM harness_actor_turn_usage_inbox
      `).get()).toEqual({ count: 0 });
      const terminalUsage = {
        ...advancedUsage,
        streamPosition: 44,
        cumulativeInputTokens: 335,
        cumulativeOutputTokens: 97,
        cumulativeCachedInputTokens: 208,
        cumulativeReasoningOutputTokens: 44,
      } as const;
      expect(await restarted.recordActorTurnUsage(terminalUsage)).toBe(true);
      expect(restarted.readActorTurnUsage({
        accountProfileId: usage.accountProfileId,
        processGeneration: usage.processGeneration,
        providerTurnId: usage.providerTurnId,
      })).toEqual({
        inputTokens: 335,
        outputTokens: 97,
        cachedInputTokens: 208,
        reasoningOutputTokens: 44,
      });
      const terminal = restarted.transitionActorAttempt({
        attemptId: attempt.id,
        expectedState: "running",
        nextState: "completed",
        inputTokens: 335,
        outputTokens: 97,
        now: "2030-01-01T00:00:07.000Z",
      });
      expect(terminal).toMatchObject({
        state: "completed",
        inputTokens: 335,
        outputTokens: 97,
      });
    } finally {
      value.database.close();
    }
  });

  test("rejects successor usage that regresses a known token breakdown", async () => {
    const value = fixture();
    try {
      const { attempt, incarnation } = prepareStartingAttempt(value);
      bindFixtureWorkspace(value, rootActorId, "successor_usage_regression");
      value.authority.bindActorSession({
        incarnationId: incarnation.id,
        recoveryProof: recoveryProof({ generation: 1 }),
        createdAt: at,
      });
      const providerTurnId = "provider-turn-successor-regression";
      await value.authority.bindActorAttemptProviderTurn({
        attemptId: attempt.id,
        expectedState: "starting",
        providerTurnId,
      });
      value.authority.transitionActorAttempt({
        attemptId: attempt.id,
        expectedState: "starting",
        nextState: "running",
        providerTurnId,
        now: "2030-01-01T00:00:04.000Z",
      });
      const firstUsage = {
        accountProfileId: accountId,
        processGeneration: 1,
        providerThreadId: "thread-usage-inbox",
        providerTurnId,
        streamPosition: 17,
        cumulativeInputTokens: 44,
        cumulativeOutputTokens: 9,
        cumulativeCachedInputTokens: 30,
        cumulativeReasoningOutputTokens: 5,
      } as const;
      expect(await value.authority.recordActorTurnUsage(firstUsage)).toBe(true);
      value.database.query(`
        UPDATE account_profiles SET process_generation = 2 WHERE profile_id = ?1
      `).run(accountId);

      await expectRejectedMessage(value.authority.recordActorTurnUsage({
        ...firstUsage,
        processGeneration: 2,
        streamPosition: 1,
        cumulativeCachedInputTokens: 29,
      }), "successor provider generation regressed actor token evidence");
      await expectRejectedMessage(value.authority.recordActorTurnUsage({
        ...firstUsage,
        processGeneration: 2,
        streamPosition: 1,
        cumulativeReasoningOutputTokens: 4,
      }), "successor provider generation regressed actor token evidence");
      expect(value.database.query(`
        SELECT COUNT(*) AS count FROM harness_actor_turn_usage_inbox
        WHERE attempt_id = ?1
      `).get(attempt.id)).toEqual({ count: 0 });
      expect(value.authority.readActorAttempt(attempt.id)).toMatchObject({
        tokenUsageObservationGeneration: 1,
        tokenUsageStreamPosition: firstUsage.streamPosition,
        inputTokens: firstUsage.cumulativeInputTokens,
        outputTokens: firstUsage.cumulativeOutputTokens,
        cachedInputTokens: firstUsage.cumulativeCachedInputTokens,
        reasoningOutputTokens: firstUsage.cumulativeReasoningOutputTokens,
      });
    } finally {
      value.database.close();
    }
  });

  test("treats a null token breakdown as unknown at an exact position", async () => {
    const value = fixture();
    try {
      const { attempt } = prepareStartingAttempt(value);
      const totalsOnly = {
        accountProfileId: accountId,
        processGeneration: 1,
        providerThreadId: "thread-usage-inbox",
        providerTurnId: "provider-turn-usage-null-breakdown",
        streamPosition: 21,
        cumulativeInputTokens: 55,
        cumulativeOutputTokens: 13,
      } as const;
      expect(await value.authority.recordActorTurnUsage(totalsOnly)).toBe(true);
      expect(value.database.query(`
        SELECT cumulative_cached_input_tokens,
          cumulative_reasoning_output_tokens
        FROM harness_actor_turn_usage_inbox WHERE attempt_id = ?1
      `).get(attempt.id)).toEqual({
        cumulative_cached_input_tokens: null,
        cumulative_reasoning_output_tokens: null,
      });

      const completedEvidence = {
        ...totalsOnly,
        cumulativeCachedInputTokens: 34,
        cumulativeReasoningOutputTokens: 7,
      } as const;
      expect(await value.authority.recordActorTurnUsage(completedEvidence))
        .toBe(true);
      expect(await value.authority.recordActorTurnUsage(completedEvidence))
        .toBe(true);
      expect(value.database.query(`
        SELECT cumulative_cached_input_tokens,
          cumulative_reasoning_output_tokens
        FROM harness_actor_turn_usage_inbox WHERE attempt_id = ?1
      `).get(attempt.id)).toEqual({
        cumulative_cached_input_tokens: null,
        cumulative_reasoning_output_tokens: null,
      });
    } finally {
      value.database.close();
    }
  });

  test("attributes a buffered successor usage observation exactly once", async () => {
    const value = fixture();
    try {
      const { attempt, incarnation } = prepareStartingAttempt(value);
      bindFixtureWorkspace(value, rootActorId, "successor_usage_exact");
      const firstSession = value.authority.bindActorSession({
        incarnationId: incarnation.id,
        recoveryProof: recoveryProof({ generation: 1 }),
        createdAt: at,
      });
      const providerTurnId = "provider-turn-successor-exact";
      await value.authority.bindActorAttemptProviderTurn({
        attemptId: attempt.id,
        expectedState: "starting",
        providerTurnId,
      });
      value.authority.transitionActorAttempt({
        attemptId: attempt.id,
        expectedState: "starting",
        nextState: "running",
        providerTurnId,
        now: "2030-01-01T00:00:04.000Z",
      });
      const firstUsage = {
        accountProfileId: accountId,
        processGeneration: 1,
        providerThreadId: "thread-usage-inbox",
        providerTurnId,
        streamPosition: 17,
        cumulativeInputTokens: 40,
        cumulativeOutputTokens: 10,
        cumulativeCachedInputTokens: 30,
        cumulativeReasoningOutputTokens: 6,
      } as const;
      expect(await value.authority.recordActorTurnUsage(firstUsage)).toBe(true);
      value.database.query(`
        UPDATE account_profiles SET process_generation = 2 WHERE profile_id = ?1
      `).run(accountId);
      const successorUsage = {
        ...firstUsage,
        processGeneration: 2,
        streamPosition: 2,
        cumulativeInputTokens: 46,
        cumulativeOutputTokens: 13,
        cumulativeCachedInputTokens: 35,
        cumulativeReasoningOutputTokens: 8,
      } as const;

      expect(await value.authority.recordActorTurnUsage(successorUsage)).toBe(true);
      expect(value.database.query(`
        SELECT observation_generation, stream_position,
          cumulative_input_tokens, cumulative_output_tokens,
          cumulative_cached_input_tokens,
          cumulative_reasoning_output_tokens
        FROM harness_actor_turn_usage_inbox WHERE attempt_id = ?1
      `).get(attempt.id)).toEqual({
        observation_generation: successorUsage.processGeneration,
        stream_position: successorUsage.streamPosition,
        cumulative_input_tokens: successorUsage.cumulativeInputTokens,
        cumulative_output_tokens: successorUsage.cumulativeOutputTokens,
        cumulative_cached_input_tokens:
          successorUsage.cumulativeCachedInputTokens,
        cumulative_reasoning_output_tokens:
          successorUsage.cumulativeReasoningOutputTokens,
      });
      expect(value.authority.readActorAttempt(attempt.id)).toMatchObject({
        tokenUsageObservationGeneration: 1,
        inputTokens: firstUsage.cumulativeInputTokens,
        outputTokens: firstUsage.cumulativeOutputTokens,
        cachedInputTokens: firstUsage.cumulativeCachedInputTokens,
        reasoningOutputTokens: firstUsage.cumulativeReasoningOutputTokens,
      });

      value.authority.advanceActorSessionBinding({
        incarnationId: incarnation.id,
        expectedRevision: firstSession.revision,
        expectedLiveGeneration: firstSession.liveGeneration,
        liveCapabilityEvidence: {
          evidenceDigest: "c".repeat(64),
          supportsFast: true,
        },
        recoveryProof: recoveryProof({
          generation: 2,
          priorRecoveryProofDigest:
            firstSession.recoveryProof.recoveryProofDigest,
          marker: "4",
        }),
        now: "2030-01-01T00:00:05.000Z",
      });
      expect(value.database.query(`
        SELECT COUNT(*) AS count FROM harness_actor_turn_usage_inbox
        WHERE attempt_id = ?1
      `).get(attempt.id)).toEqual({ count: 0 });
      const applied = value.authority.readActorAttempt(attempt.id);
      expect(applied).toMatchObject({
        tokenUsageObservationGeneration: 2,
        tokenUsageStreamPosition: successorUsage.streamPosition,
        tokenUsageCumulativeInputTokens:
          successorUsage.cumulativeInputTokens,
        tokenUsageCumulativeOutputTokens:
          successorUsage.cumulativeOutputTokens,
        tokenUsageCumulativeCachedInputTokens:
          successorUsage.cumulativeCachedInputTokens,
        tokenUsageCumulativeReasoningOutputTokens:
          successorUsage.cumulativeReasoningOutputTokens,
        inputTokens: successorUsage.cumulativeInputTokens,
        outputTokens: successorUsage.cumulativeOutputTokens,
        cachedInputTokens: successorUsage.cumulativeCachedInputTokens,
        reasoningOutputTokens:
          successorUsage.cumulativeReasoningOutputTokens,
      });

      expect(await value.authority.recordActorTurnUsage(successorUsage)).toBe(true);
      expect(value.authority.readActorAttempt(attempt.id)).toEqual(applied);
    } finally {
      value.database.close();
    }
  });

  test("fails closed rather than stranding buffered usage on a terminal attempt", async () => {
    const value = fixture();
    try {
      const { attempt } = prepareStartingAttempt(value);
      expect(await value.authority.recordActorTurnUsage({
        accountProfileId: accountId,
        processGeneration: 1,
        providerThreadId: "thread-usage-inbox",
        providerTurnId: "provider-turn-usage-terminal",
        streamPosition: 7,
        cumulativeInputTokens: 12,
        cumulativeOutputTokens: 3,
      })).toBe(true);
      expect(() => value.authority.transitionActorAttempt({
        attemptId: attempt.id,
        expectedState: "starting",
        nextState: "failed",
        now: "2030-01-01T00:00:03.000Z",
      })).toThrow("buffered actor usage must be bound before this transition");
      expect(value.authority.readActorAttempt(attempt.id)).toMatchObject({
        state: "starting",
        providerTurnId: null,
      });
      expect(value.database.query(`
        SELECT COUNT(*) AS count FROM harness_actor_turn_usage_inbox
      `).get()).toEqual({ count: 1 });
    } finally {
      value.database.close();
    }
  });

  test("rejects usage that arrives after an attempt terminalized without identity", async () => {
    const value = fixture();
    try {
      const { attempt } = prepareStartingAttempt(value);
      value.authority.transitionActorAttempt({
        attemptId: attempt.id,
        expectedState: "starting",
        nextState: "failed",
        now: "2030-01-01T00:00:03.000Z",
      });
      await expectRejectedMessage(value.authority.recordActorTurnUsage({
        accountProfileId: accountId,
        processGeneration: 1,
        providerThreadId: "thread-usage-inbox",
        providerTurnId: "provider-turn-too-late",
        streamPosition: 8,
        cumulativeInputTokens: 12,
        cumulativeOutputTokens: 3,
      }), "terminal unbound actor attempt");
      expect(value.database.query(`
        SELECT COUNT(*) AS count FROM harness_actor_turn_usage_inbox
      `).get()).toEqual({ count: 0 });
    } finally {
      value.database.close();
    }
  });

  test("settles quota evidence exactly once and rejects every one-field replay mutation", async () => {
    const value = fixture();
    try {
      const { attempt, incarnation, turn } = prepareStartingAttempt(value);
      const providerTurnId = "provider-turn-quota-settlement";
      await value.authority.bindActorAttemptProviderTurn({
        attemptId: attempt.id,
        expectedState: "starting",
        providerTurnId,
      });
      value.authority.transitionActorAttempt({
        attemptId: attempt.id,
        expectedState: "starting",
        nextState: "running",
        providerTurnId,
        now: "2030-01-01T00:00:03.000Z",
      });
      expect(await value.authority.recordActorTurnUsage({
        accountProfileId: accountId,
        processGeneration: 1,
        providerThreadId: "thread-usage-inbox",
        providerTurnId,
        streamPosition: 9,
        cumulativeInputTokens: 31,
        cumulativeOutputTokens: 12,
      })).toBe(true);
      const continuationHistoryValueId = "ctxval_quota_settlement_capsule";
      insertCompletedPrefix(value.database, {
        valueId: continuationHistoryValueId,
        actorId: rootActorId,
        sourceTurnId: turn.id,
        marker: "9",
      });
      const settlement = {
        attemptId: attempt.id,
        expectedState: "running" as const,
        providerTurnId,
        continuationHistoryValueId,
        quotaProofDigest: digest("6"),
        inputTokens: 31,
        outputTokens: 12,
        now: "2030-01-01T00:00:04.000Z",
      };

      const settled = value.authority.settleActorQuotaRejection(settlement);
      expect(settled).toMatchObject({
        state: "quotaRejected",
        providerTurnId,
        continuationHistoryValueId,
        quotaProofDigest: settlement.quotaProofDigest,
        inputTokens: settlement.inputTokens,
        outputTokens: settlement.outputTokens,
      });
      expect(value.authority.settleActorQuotaRejection(settlement)).toEqual(settled);

      const mutations = [
        { ...settlement, providerTurnId: "provider-turn-quota-mutated" },
        {
          ...settlement,
          continuationHistoryValueId: "ctxval_quota_settlement_changed",
        },
        { ...settlement, quotaProofDigest: digest("5") },
        { ...settlement, inputTokens: settlement.inputTokens + 1 },
        { ...settlement, outputTokens: settlement.outputTokens + 1 },
      ] as const;
      for (const mutation of mutations) {
        expect(() => value.authority.settleActorQuotaRejection(mutation))
          .toThrow("replayed quota settlement changed its exact terminal evidence");
        expect(value.authority.readActorAttempt(attempt.id)).toEqual(settled);
      }

      const reconciling = value.authority.transitionActorTurn({
        turnId: turn.id,
        expectedRevision: value.authority.readActorTurn(turn.id)!.revision,
        nextState: "reconciling",
        now: "2030-01-01T00:00:05.000Z",
      });
      value.authority.transitionActorIncarnation({
        incarnationId: incarnation.id,
        expectedState: "idle",
        nextState: "closed",
        now: "2030-01-01T00:00:05.000Z",
      });
      const replacementOperation = value.authority.prepareActorOperation({
        operationId: "hoperation_quota_replacement01",
        actorId: rootActorId,
        turnId: null,
        kind: "actorStart",
        requestDigest: digest("a"),
        effectKey: digest("b"),
        providerIdentityJson: '{"request":{"replacement":true},"version":1}',
        createdAt: "2030-01-01T00:00:05.000Z",
      });
      value.authority.transitionActorOperation({
        operationId: replacementOperation.id,
        expectedState: "prepared",
        nextState: "effectStarted",
        now: "2030-01-01T00:00:05.000Z",
      });
      value.authority.transitionActorOperation({
        operationId: replacementOperation.id,
        expectedState: "effectStarted",
        nextState: "succeeded",
        providerIdentityJson: '{"providerThreadId":"thread-quota-replacement"}',
        now: "2030-01-01T00:00:05.000Z",
      });
      const replacementIncarnation = value.authority.createActorIncarnation({
        incarnationId: "hincarnation_quota_replacement01",
        actorId: rootActorId,
        accountProfileId: accountId,
        processGeneration: 1,
        startOperationId: replacementOperation.id,
        clientRequestId: "client-request-quota-replacement-01",
        threadSource: "oprte:quota-replacement:fixture:01",
        toolsetDigest: digest("c"),
        createdAt: "2030-01-01T00:00:05.000Z",
      });
      value.authority.transitionActorIncarnation({
        incarnationId: replacementIncarnation.id,
        expectedState: "starting",
        nextState: "idle",
        providerThreadId: "thread-quota-replacement",
        now: "2030-01-01T00:00:05.000Z",
      });
      bindFixtureWorkspace(value, rootActorId, "quota_replacement");
      value.authority.bindActorSession({
        incarnationId: replacementIncarnation.id,
        recoveryProof: recoveryProof({ generation: 1, marker: "4" }),
        createdAt: "2030-01-01T00:00:05.000Z",
      });
      const replacement = value.authority.claimActorAttempt({
        attemptId: "hattempt_quota_replacement01",
        turnId: turn.id,
        incarnationId: replacementIncarnation.id,
        accountProfileId: accountId,
        processGeneration: 1,
        clientUserMessageId: "client-message-quota-replacement-01",
        createdAt: "2030-01-01T00:00:05.000Z",
      });
      const actorBefore = value.authority.readActor(rootActorId)!;
      const epochBefore = value.authority.readActorEpoch(epochId)!;
      const replacementAttemptBefore = value.authority.readActorAttempt(
        replacement.attempt.id,
      );
      const replacementIncarnationBefore = value.authority.readActorIncarnation(
        replacement.incarnation.id,
      );
      const replacementSessionBefore = value.authority.readActorSessionBinding(
        replacement.incarnation.id,
      );
      const containment = {
        resultId: "hresult_invalidquotacontainment01",
        turnId: turn.id,
        terminalAttemptId: attempt.id,
        expectedTurnRevision: reconciling.revision,
        outcomeCode: "quota_continuation_source_invalid",
        createdAt: "2030-01-01T00:00:06.000Z",
      } as const;
      value.database.exec(`
        CREATE TEMP TRIGGER fail_invalid_quota_quarantine
        BEFORE UPDATE OF state ON harness_actors
        WHEN NEW.state = 'quarantined'
        BEGIN
          SELECT RAISE(ABORT, 'injected invalid quota quarantine crash');
        END
      `);
      expect(() => value.authority.settleInvalidQuotaContinuation(containment))
        .toThrow("injected invalid quota quarantine crash");
      expect(value.authority.readActorResult(containment.resultId)).toBeNull();
      expect(value.authority.readActorTurn(turn.id)).toEqual(reconciling);
      expect(value.authority.readActor(rootActorId)).toEqual(actorBefore);
      expect(value.authority.readActorEpoch(epochId)).toEqual(epochBefore);
      expect(value.authority.readActorAttempt(replacement.attempt.id))
        .toEqual(replacementAttemptBefore);
      expect(value.authority.readActorIncarnation(replacement.incarnation.id))
        .toEqual(replacementIncarnationBefore);
      expect(value.authority.readActorSessionBinding(replacement.incarnation.id))
        .toEqual(replacementSessionBefore);

      value.database.exec("DROP TRIGGER fail_invalid_quota_quarantine");
      const contained = value.authority.settleInvalidQuotaContinuation(
        containment,
      );
      expect(contained).toMatchObject({
        actor: { id: rootActorId, state: "quarantined" },
        result: {
          id: containment.resultId,
          turnId: turn.id,
          terminalAttemptId: attempt.id,
          outcome: "quotaRejected",
        },
      });
      expect(value.authority.readActorTurn(turn.id)).toMatchObject({
        state: "quotaRejected",
        outcomeCode: containment.outcomeCode,
      });
      expect(value.authority.readActorAttempt(replacement.attempt.id)).toMatchObject({
        state: "interrupted",
        providerTurnId: null,
      });
      expect(value.authority.readActorIncarnation(replacement.incarnation.id))
        .toMatchObject({ state: "quarantined" });
      expect(value.authority.readActorSessionBinding(replacement.incarnation.id))
        .toMatchObject({
          state: "quarantined",
          quarantineReason: "recovery_protocol_error",
        });
      expect(value.authority.readActiveIncarnationForActor(rootActorId)).toBeNull();
      expect(value.authority.settleInvalidQuotaContinuation(containment))
        .toEqual(contained);
    } finally {
      value.database.close();
    }
  });

  test("generic result settlement cannot mint effect-free quota evidence", () => {
    const value = fixture();
    try {
      value.authority.createActorEpoch(epochAndRoot());
      insertContextValue(value.database, {
        valueId: "ctxval_effect_free_quota_guard",
        actorId: rootActorId,
        purpose: "currentInput",
      });
      const turn = value.authority.createActorTurn({
        turnId: "hturn_effectfreequotaguard01",
        epochId,
        actorId: rootActorId,
        idempotencyKey: "idempotency-effect-free-quota-guard",
        inputValueId: "ctxval_effect_free_quota_guard",
        createdAt: at,
      });
      const actorBefore = value.authority.readActor(rootActorId);
      const epochBefore = value.authority.readActorEpoch(epochId);

      expect(() => value.authority.settleActorResult({
        resultId: "hresult_effectfreequotaguard01",
        turnId: turn.id,
        terminalAttemptId: null,
        outcome: "quotaRejected",
        valueId: null,
        expectedTurnRevision: turn.revision,
        outcomeCode: "quota_exhausted_before_actor_start",
        createdAt: later,
      })).toThrow();

      expect(value.authority.readActorResultForTurn(turn.id)).toBeNull();
      expect(value.authority.readActorTurn(turn.id)).toEqual(turn);
      expect(value.authority.readActor(rootActorId)).toEqual(actorBefore);
      expect(value.authority.readActorEpoch(epochId)).toEqual(epochBefore);
    } finally {
      value.database.close();
    }
  });

  test("re-resolves successor ownership when session recovery wins the usage-digest race", async () => {
    const digestStarted = deferred<void>();
    const releaseDigest = deferred<void>();
    let digestCalls = 0;
    let delayNextDigest = false;
    const delayedIdentities: ActorTokenUsageIdentityPortV2 = Object.freeze({
      digest: async (input: ActorTokenUsageIdentityInput) => {
        digestCalls += 1;
        if (delayNextDigest) {
          delayNextDigest = false;
          digestStarted.resolve();
          await releaseDigest.promise;
        }
        return await tokenUsageIdentities.digest(input);
      },
    });
    const value = fixture(delayedIdentities);
    try {
      const { attempt, incarnation } = prepareStartingAttempt(value);
      bindFixtureWorkspace(value, rootActorId, "successor_digest_race");
      const first = value.authority.bindActorSession({
        incarnationId: incarnation.id,
        recoveryProof: recoveryProof({ generation: 1 }),
        createdAt: at,
      });
      const providerTurnId = "provider-turn-successor-race";
      await value.authority.bindActorAttemptProviderTurn({
        attemptId: attempt.id,
        expectedState: "starting",
        providerTurnId,
      });
      value.authority.transitionActorAttempt({
        attemptId: attempt.id,
        expectedState: "starting",
        nextState: "running",
        providerTurnId,
        now: "2030-01-01T00:00:04.000Z",
      });
      value.database.query(`
        UPDATE account_profiles SET process_generation = 2 WHERE profile_id = ?1
      `).run(accountId);
      const usage = {
        accountProfileId: accountId,
        processGeneration: 2,
        providerThreadId: "thread-usage-inbox",
        providerTurnId,
        streamPosition: 17,
        cumulativeInputTokens: 44,
        cumulativeOutputTokens: 9,
      } as const;
      delayNextDigest = true;
      const recording = value.authority.recordActorTurnUsage(usage);
      await digestStarted.promise;
      expect(value.authority.advanceActorSessionBinding({
        incarnationId: incarnation.id,
        expectedRevision: first.revision,
        expectedLiveGeneration: first.liveGeneration,
        liveCapabilityEvidence: {
          evidenceDigest: "c".repeat(64),
          supportsFast: true,
        },
        recoveryProof: recoveryProof({
          generation: 2,
          priorRecoveryProofDigest: first.recoveryProof.recoveryProofDigest,
          marker: "4",
        }),
        now: "2030-01-01T00:00:05.000Z",
      })).toMatchObject({ liveGeneration: 2 });
      releaseDigest.resolve();

      expect(await recording).toBe(true);
      expect(digestCalls).toBe(3);
      expect(value.database.query(`
        SELECT COUNT(*) AS count FROM harness_actor_turn_usage_inbox
        WHERE attempt_id = ?1 AND quarantined = 0
      `).get(attempt.id)).toEqual({ count: 0 });
      const applied = value.authority.readActorAttempt(attempt.id);
      expect(applied).toMatchObject({
        providerTurnId: usage.providerTurnId,
        tokenUsageObservationGeneration: 2,
        tokenUsageStreamPosition: usage.streamPosition,
        inputTokens: usage.cumulativeInputTokens,
        outputTokens: usage.cumulativeOutputTokens,
      });
      expect(value.database.query(`
        SELECT COUNT(*) AS count FROM harness_actor_turn_usage_inbox
        WHERE attempt_id = ?1
      `).get(attempt.id)).toEqual({ count: 0 });
      expect(await value.authority.recordActorTurnUsage(usage)).toBe(true);
      expect(value.authority.readActorAttempt(attempt.id)).toEqual(applied);
    } finally {
      releaseDigest.resolve();
      value.database.close();
    }
  });

  test("quarantines every pre-binding usage row and never lets it bind", async () => {
    const reasons = [
      "provider_identity_mismatch",
      "thread_source_mismatch",
      "workspace_mismatch",
      "sandbox_mismatch",
      "history_unstable",
      "actor_ownership_conflict",
      "generation_regression",
      "token_evidence_regression",
      "recovery_protocol_error",
    ] as const;
    for (const [index, reason] of reasons.entries()) {
      const value = fixture();
      try {
        const { attempt, incarnation } = prepareStartingAttempt(value, {
          withAccountLease: true,
        });
        const suffix = `quarantine_${String(index).padStart(2, "0")}`;
        bindFixtureWorkspace(value, rootActorId, suffix);
        const bound = value.authority.bindActorSession({
          incarnationId: incarnation.id,
          recoveryProof: recoveryProof({ generation: 1 }),
          createdAt: at,
        });
        expect(value.authority.readActiveActorAccountLoad({
          accountProfileId: accountId,
          processGeneration: 1,
        })).toBe(1);
        const providerTurnId = `provider-turn-quarantine-${index}`;
        expect(await value.authority.recordActorTurnUsage({
          accountProfileId: accountId,
          processGeneration: 1,
          providerThreadId: "thread-usage-inbox",
          providerTurnId,
          streamPosition: index + 1,
          cumulativeInputTokens: 100 + index,
          cumulativeOutputTokens: 20 + index,
        })).toBe(true);

        expect(value.authority.quarantineActorSessionBinding({
          incarnationId: incarnation.id,
          expectedRevision: bound.revision,
          reason,
          now: "2030-01-01T00:00:05.000Z",
        })).toMatchObject({ state: "quarantined", quarantineReason: reason });
        expect(value.authority.readActorIncarnation(incarnation.id))
          .toMatchObject({ state: "quarantined" });
        expect(value.authority.readActiveActorAccountLoad({
          accountProfileId: accountId,
          processGeneration: 1,
        })).toBe(0);
        expect(value.authority.readActorAccountLease(
          "haccountlease_usageinbox01",
        )).toMatchObject({ state: "quarantined" });
        expect(value.database.query(`
          SELECT quarantined, quarantine_reason FROM harness_actor_turn_usage_inbox
          WHERE attempt_id = ?1
        `).get(attempt.id)).toEqual({
          quarantined: 1,
          quarantine_reason: reason,
        });
        expect(value.authority.readActorAttempt(attempt.id)).toMatchObject({
          providerTurnId: null,
          tokenUsageIdentityDigest: null,
          inputTokens: null,
          outputTokens: null,
        });
        await expectRejectedMessage(value.authority.bindActorAttemptProviderTurn({
          attemptId: attempt.id,
          expectedState: "starting",
          providerTurnId,
        }), "live provider session identity");
        expect(value.authority.readActorAttempt(attempt.id)).toMatchObject({
          providerTurnId: null,
          inputTokens: null,
          outputTokens: null,
        });
      } finally {
        value.database.close();
      }
    }

    const healthy = fixture();
    try {
      const { incarnation } = prepareStartingAttempt(healthy);
      bindFixtureWorkspace(healthy, rootActorId, "healthy_successor");
      const first = healthy.authority.bindActorSession({
        incarnationId: incarnation.id,
        recoveryProof: recoveryProof({ generation: 1 }),
        createdAt: at,
      });
      healthy.database.query(`
        UPDATE account_profiles SET process_generation = 2 WHERE profile_id = ?1
      `).run(accountId);
      expect(healthy.authority.advanceActorSessionBinding({
        incarnationId: incarnation.id,
        expectedRevision: first.revision,
        expectedLiveGeneration: first.liveGeneration,
        liveCapabilityEvidence: {
          evidenceDigest: "c".repeat(64),
          supportsFast: true,
        },
        recoveryProof: recoveryProof({
          generation: 2,
          priorRecoveryProofDigest: first.recoveryProof.recoveryProofDigest,
          marker: "4",
        }),
        now: "2030-01-01T00:00:06.000Z",
      })).toMatchObject({
        state: "bound",
        admissionGeneration: 1,
        liveGeneration: 2,
        revision: first.revision + 1,
      });
    } finally {
      healthy.database.close();
    }
  });

  test("creates one exact epoch/root and atomically narrows child reservations", () => {
    const value = fixture();
    try {
      const initial = epochAndRoot();
      expect(value.authority.createActorEpoch(initial)).toEqual(initial);
      expect(value.authority.createActorEpoch(initial)).toEqual(initial);

      const firstChild = child();
      expect(value.authority.createChildActor(firstChild)).toEqual(firstChild);
      expect(value.authority.createChildActor(firstChild)).toEqual(firstChild);
      expect(value.authority.readActor(rootActorId)).toMatchObject({
        tokenReserved: firstChild.budget.tokenBudget,
        byteReserved: firstChild.budget.byteBudget,
        revision: 2,
      });

      expect(() => value.authority.createChildActor(child({
        id: "hactor_child000002",
        tokenBudget: 90_000,
      }))).toThrow(HarnessSQLiteAuthorityV2Error);
      expect(value.authority.readActor("hactor_child000002")).toBeNull();
      expect(value.authority.readActor(rootActorId)).toMatchObject({
        tokenReserved: firstChild.budget.tokenBudget,
        revision: 2,
      });
      expect(() => value.authority.settleActorStop({
        actorId: rootActorId,
        expectedRevision: 2,
        nextState: "stopped",
      })).toThrow("descendant remains live");

      const requestedStop = value.authority.requestActorStop({
        actorId: firstChild.id,
        expectedRevision: firstChild.revision,
        now: "2030-01-01T00:00:02.000Z",
      });
      expect(value.authority.requestActorStop({
        actorId: firstChild.id,
        expectedRevision: firstChild.revision,
        now: "2030-01-01T00:00:02.000Z",
      })).toEqual(requestedStop);
      const settledStop = value.authority.settleActorStop({
        actorId: firstChild.id,
        expectedRevision: requestedStop.revision,
        nextState: "stopped",
        now: "2030-01-01T00:00:03.000Z",
      });
      expect(value.authority.settleActorStop({
        actorId: firstChild.id,
        expectedRevision: requestedStop.revision,
        nextState: "stopped",
        now: "2030-01-01T00:00:03.000Z",
      })).toEqual(settledStop);
      expect(settledStop).toMatchObject({ state: "stopped", revision: 3 });
      expect(() => value.authority.settleActorStop({
        actorId: firstChild.id,
        expectedRevision: firstChild.revision,
        nextState: "quarantined",
      })).toThrow("revision changed");
    } finally {
      value.database.close();
    }
  });

  test("persists multiple monotonic turns without terminalizing the actor", async () => {
    const value = fixture();
    try {
      value.authority.createActorEpoch(epochAndRoot());
      const first = prepareRunningTurn(value, { turnSuffix: "turn000000001" });
      expect(first.ordinal).toBe(1);

      const startOperation = value.authority.prepareActorOperation({
        operationId: "hoperation_start000001",
        actorId: rootActorId,
        turnId: null,
        kind: "actorStart",
        requestDigest: digest("1"),
        effectKey: digest("2"),
        providerIdentityJson: '{"request":{"fixture":true},"version":1}',
        createdAt: at,
      });
      value.authority.transitionActorOperation({
        operationId: startOperation.id,
        expectedState: "prepared",
        nextState: "effectStarted",
        now: later,
      });
      value.authority.transitionActorOperation({
        operationId: startOperation.id,
        expectedState: "effectStarted",
        nextState: "succeeded",
        providerIdentityJson: '{"providerThreadId":"thread-one"}',
        now: "2030-01-01T00:00:02.000Z",
      });
      const incarnation = value.authority.createActorIncarnation({
        incarnationId: "hincarnation_root0001",
        actorId: rootActorId,
        accountProfileId: accountId,
        processGeneration: 1,
        startOperationId: startOperation.id,
        clientRequestId: "client-request-root-0001",
        threadSource: "oprte:epoch:root:0001",
        toolsetDigest: digest("3"),
        createdAt: at,
      });
      value.authority.transitionActorIncarnation({
        incarnationId: incarnation.id,
        expectedState: "starting",
        nextState: "idle",
        providerThreadId: "thread-one",
        now: later,
      });
      expect(value.authority.readActiveIncarnationForActor(rootActorId))
        .toMatchObject({ id: incarnation.id, state: "idle" });
      const attempt = value.authority.createActorAttempt({
        attemptId: "hattempt_turn000001",
        turnId: first.id,
        incarnationId: incarnation.id,
        accountProfileId: accountId,
        processGeneration: 1,
        clientUserMessageId: "client-message-turn-0001",
        createdAt: later,
      });
      const running = value.authority.transitionActorAttempt({
        attemptId: attempt.id,
        expectedState: "starting",
        nextState: "running",
        providerTurnId: "provider-turn-one",
        now: "2030-01-01T00:00:03.000Z",
      });
      expect(value.authority.readActorAttemptByProviderTurnId({
        accountProfileId: accountId,
        processGeneration: 1,
        providerTurnId: "provider-turn-one",
      })).toEqual(running);
      expect(value.authority.listUnsettledActorAttempts({ limit: 128 }))
        .toEqual([running]);
      expect(value.authority.listLiveActorAttempts({ limit: 128 }))
        .toEqual([running]);
      expect(value.authority.listLiveActorTurns({ limit: 128 }))
        .toEqual([first]);
      expect(await value.authority.recordActorTurnUsage({
        accountProfileId: accountId,
        processGeneration: 1,
        providerThreadId: "thread-one",
        providerTurnId: "provider-turn-one",
        streamPosition: 1,
        cumulativeInputTokens: 100,
        cumulativeOutputTokens: 50,
      })).toBe(true);
      expect(value.authority.readActorTurnUsage({
        accountProfileId: accountId,
        processGeneration: 1,
        providerTurnId: "provider-turn-one",
      })).toEqual({
        inputTokens: 100,
        outputTokens: 50,
        cachedInputTokens: null,
        reasoningOutputTokens: null,
      });
      value.authority.transitionActorAttempt({
        attemptId: attempt.id,
        expectedState: running.state,
        nextState: "completed",
        inputTokens: 100,
        outputTokens: 50,
        now: "2030-01-01T00:00:04.000Z",
      });
      insertContextValue(value.database, {
        valueId: "ctxval_result0000001",
        actorId: rootActorId,
        purpose: "agentResult",
        sourceTurnId: first.id,
        marker: "7",
      });
      const firstResult = value.authority.settleActorResult({
        resultId: "hresult_turn000001",
        turnId: first.id,
        terminalAttemptId: attempt.id,
        outcome: "succeeded",
        valueId: "ctxval_result0000001",
        expectedTurnRevision: first.revision,
        outcomeCode: "completed",
        createdAt: "2030-01-01T00:00:05.000Z",
      });
      expect(firstResult).toMatchObject({
        actorResultOrdinal: 1,
        rootCompletionSequence: 1,
      });
      expect(value.authority.readActor(rootActorId)?.state).toBe("active");

      const second = prepareRunningTurn(value, { turnSuffix: "turn000000002" });
      expect(second.ordinal).toBe(2);
      expect(value.authority.readActor(rootActorId)).toMatchObject({
        state: "active",
        nextTurnOrdinal: 3,
        nextResultOrdinal: 2,
      });
    } finally {
      value.database.close();
    }
  });

  test("settles unique results and both sequence counters in one transaction", () => {
    const value = fixture();
    try {
      value.authority.createActorEpoch(epochAndRoot());
      const childActor = value.authority.createChildActor(child());
      expect(value.authority.listActorChildren({
        parentActorId: rootActorId,
        limit: 51,
      })).toEqual([childActor]);
      const turn = prepareRunningTurn(value, {
        actorId: childActor.id,
        turnSuffix: "childturn000001",
      });
      const operation = value.authority.prepareActorOperation({
        operationId: "hoperation_childstart01",
        actorId: childActor.id,
        turnId: null,
        kind: "actorStart",
        requestDigest: digest("4"),
        effectKey: digest("5"),
        providerIdentityJson: '{"request":{"fixture":true},"version":1}',
        createdAt: at,
      });
      value.authority.transitionActorOperation({
        operationId: operation.id,
        expectedState: "prepared",
        nextState: "effectStarted",
      });
      expect(value.authority.listRecoverableActorOperations({ limit: 128 }))
        .toHaveLength(1);
      value.authority.transitionActorOperation({
        operationId: operation.id,
        expectedState: "effectStarted",
        nextState: "succeeded",
        providerIdentityJson: '{"providerThreadId":"child-thread"}',
      });
      expect(value.authority.listRecoverableActorOperations({ limit: 128 }))
        .toEqual([value.authority.readActorOperation(operation.id)!]);
      const incarnation = value.authority.createActorIncarnation({
        incarnationId: "hincarnation_child001",
        actorId: childActor.id,
        accountProfileId: accountId,
        processGeneration: 1,
        startOperationId: operation.id,
        clientRequestId: "client-request-child-001",
        threadSource: "oprte:epoch:child:0001",
        toolsetDigest: digest("6"),
      });
      expect(value.authority.listRecoverableActorOperations({ limit: 128 }))
        .toEqual([value.authority.readActorOperation(operation.id)!]);
      value.authority.transitionActorIncarnation({
        incarnationId: incarnation.id,
        expectedState: "starting",
        nextState: "idle",
        providerThreadId: "child-thread",
      });
      const attempt = value.authority.createActorAttempt({
        attemptId: "hattempt_childturn001",
        turnId: turn.id,
        incarnationId: incarnation.id,
        accountProfileId: accountId,
        processGeneration: 1,
        clientUserMessageId: "client-message-child-001",
      });
      value.authority.transitionActorAttempt({
        attemptId: attempt.id,
        expectedState: "starting",
        nextState: "running",
        providerTurnId: "child-provider-turn",
      });
      value.authority.transitionActorAttempt({
        attemptId: attempt.id,
        expectedState: "running",
        nextState: "failed",
      });
      const result = value.authority.settleActorResult({
        resultId: "hresult_childturn001",
        turnId: turn.id,
        terminalAttemptId: attempt.id,
        outcome: "failed",
        valueId: null,
        expectedTurnRevision: turn.revision,
        outcomeCode: "provider_failed",
      });
      const replay = value.authority.settleActorResult({
        resultId: result.id,
        turnId: turn.id,
        terminalAttemptId: attempt.id,
        outcome: "failed",
        valueId: null,
        expectedTurnRevision: turn.revision,
        outcomeCode: "provider_failed",
      });
      expect(replay).toEqual(result);
      expect(value.authority.listActorResults({
        actorId: childActor.id,
        limit: 8,
      })).toEqual([result]);
      expect(value.authority.waitAnyResult({
        epochId,
        actorIds: [rootActorId, childActor.id],
      })).toEqual(result);
      expect(value.authority.readActor(childActor.id)).toMatchObject({
        nextResultOrdinal: 2,
      });
      expect(value.authority.readActorEpoch(epochId)).toMatchObject({
        nextRootCompletionSequence: 2,
      });
    } finally {
      value.database.close();
    }
  });

  test("persists stop intent and ambiguous operation recovery before effects resume", () => {
    const value = fixture();
    try {
      value.authority.createActorEpoch(epochAndRoot());
      const turn = prepareRunningTurn(value, { turnSuffix: "stopturn0000001" });
      const stopped = value.authority.requestActorTurnStop({
        turnId: turn.id,
        expectedRevision: turn.revision,
      });
      expect(stopped.desiredState).toBe("stop");
      expect(value.authority.readActorTurn(turn.id)?.desiredState).toBe("stop");

      const operation = value.authority.prepareActorOperation({
        operationId: "hoperation_recovery0001",
        actorId: rootActorId,
        turnId: turn.id,
        kind: "turnInterrupt",
        requestDigest: digest("8"),
        effectKey: digest("9"),
        providerIdentityJson: '{"request":{"fixture":true},"version":1}',
      });
      expect(value.authority.prepareActorOperation({
        operationId: operation.id,
        actorId: rootActorId,
        turnId: turn.id,
        kind: "turnInterrupt",
        requestDigest: digest("8"),
        effectKey: digest("9"),
        providerIdentityJson: '{"request":{"fixture":true},"version":1}',
      })).toEqual(operation);
      const rebasedIdentity =
        '{"request":{"fixture":true,"processGeneration":2},"version":1}';
      const rebased = value.authority.rebasePreparedActorOperation({
        operationId: operation.id,
        expectedRequestDigest: operation.requestDigest,
        requestDigest: digest("7"),
        effectKey: operation.effectKey,
        providerIdentityJson: rebasedIdentity,
        now: later,
      });
      expect(rebased).toMatchObject({
        state: "prepared",
        requestDigest: digest("7"),
        providerIdentityJson: rebasedIdentity,
        updatedAt: later,
      });
      expect(() => value.authority.rebasePreparedActorOperation({
        operationId: operation.id,
        expectedRequestDigest: operation.requestDigest,
        requestDigest: digest("6"),
        effectKey: operation.effectKey,
        providerIdentityJson: rebasedIdentity,
      })).toThrow("rebase fence changed");
      value.authority.transitionActorOperation({
        operationId: operation.id,
        expectedState: "prepared",
        nextState: "effectStarted",
      });
      expect(value.authority.readActorOperation(operation.id)?.state)
        .toBe("effectStarted");
      expect(() => value.authority.rebasePreparedActorOperation({
        operationId: operation.id,
        expectedRequestDigest: rebased.requestDigest,
        requestDigest: digest("6"),
        effectKey: operation.effectKey,
        providerIdentityJson: rebasedIdentity,
      })).toThrow("rebase fence changed");
      const recovered = value.authority.transitionActorOperation({
        operationId: operation.id,
        expectedState: "effectStarted",
        nextState: "ambiguous",
        providerIdentityJson: '{"requestId":"lost-response"}',
      });
      expect(recovered).toMatchObject({
        state: "ambiguous",
        settledAt: later,
      });
      expect(() => value.authority.transitionActorOperation({
        operationId: operation.id,
        expectedState: "effectStarted",
        nextState: "succeeded",
      })).toThrow("CAS state changed");
    } finally {
      value.database.close();
    }
  });

  test("persists a starting incarnation before its provider effect and quarantines lost starts", () => {
    const value = fixture();
    try {
      value.authority.createActorEpoch(epochAndRoot());
      const operation = value.authority.prepareActorOperation({
        operationId: "hoperation_prestart0001",
        actorId: rootActorId,
        turnId: null,
        kind: "actorStart",
        requestDigest: digest("a"),
        effectKey: digest("b"),
        providerIdentityJson: '{"request":{"fixture":true},"version":1}',
        createdAt: at,
      });
      const incarnation = value.authority.createActorIncarnation({
        incarnationId: "hincarnation_prestart1",
        actorId: rootActorId,
        accountProfileId: accountId,
        processGeneration: 1,
        startOperationId: operation.id,
        clientRequestId: "client-request-prestart1",
        threadSource: "oprte:epoch:prestart:1",
        toolsetDigest: digest("c"),
        createdAt: at,
      });
      expect(value.authority.readActiveIncarnationForActor(rootActorId))
        .toEqual(incarnation);
      value.authority.transitionActorOperation({
        operationId: operation.id,
        expectedState: "prepared",
        nextState: "effectStarted",
        now: later,
      });
      value.authority.transitionActorOperation({
        operationId: operation.id,
        expectedState: "effectStarted",
        nextState: "recoveryRequired",
        providerIdentityJson: '{"cause":"stable-scan-conflict"}',
        now: "2030-01-01T00:00:02.000Z",
      });
      expect(value.authority.transitionActorIncarnation({
        incarnationId: incarnation.id,
        expectedState: "starting",
        nextState: "quarantined",
        now: "2030-01-01T00:00:03.000Z",
      })).toMatchObject({
        state: "quarantined",
        providerThreadId: null,
      });
      expect(value.authority.readActiveIncarnationForActor(rootActorId)).toBeNull();
    } finally {
      value.database.close();
    }
  });

  test("binds exact workspace authority and pane detachment never changes actor state", () => {
    const value = fixture();
    try {
      value.authority.createActorEpoch(epochAndRoot());
      const childActor = value.authority.createChildActor(child());
      value.database.query(`
        INSERT INTO workspace_leases (
          lane_id, project_id, canonical_checkout_path, mode, status,
          base_sha, branch_name, retention, dirty_hint,
          created_at, updated_at, quarantine_reason, quarantined_at
        ) VALUES (
          'lane_readonly_0001', ?1, '/tmp/oprte-harness-v2-ro',
          'harness_read_only_snapshot', 'ready', ?2, NULL,
          'preserve', 0, ?3, ?3, NULL, NULL
        )
      `).run(projectId, sourceSha, at);
      const workspace = value.authority.bindActorWorkspace({
        bindingId: "hbinding_child000001",
        actorId: childActor.id,
        laneId: "lane_readonly_0001",
        authority: "readOnlySnapshot",
        createdAt: at,
      });
      expect(workspace.state).toBe("active");

      value.database.query(`
        INSERT INTO chat_panes (
          pane_id, palette_index, display_order, repository_id, repository_name, revision,
          title, account_profile_id, model, reasoning_effort, state,
          created_at, updated_at
        ) VALUES (
          'pane_harnessv20001',
          (SELECT next_palette_index FROM chat_pane_palette_sequence WHERE singleton = 1),
          1, ?1, 'Harness V2', 1,
          'Actor pane', ?2, 'gpt-5.6-sol', 'ultra', 'ready', ?3, ?3
        )
      `).run(projectId, accountId, at);
      const attached = value.authority.attachActorPane({
        bindingId: "hpanebinding_child001",
        actorId: childActor.id,
        paneId: "pane_harnessv20001",
        attachedAt: at,
      });
      expect(value.authority.readPaneBindingForActor(childActor.id)).toEqual(attached);
      expect(value.authority.readActorForPane("pane_harnessv20001")).toEqual(
        value.authority.readActor(childActor.id),
      );
      const actorBefore = value.authority.readActor(childActor.id);
      expect(value.authority.detachActorPane({
        bindingId: attached.id,
        expectedRevision: attached.revision,
        detachedAt: later,
      })).toMatchObject({ state: "detached", revision: 2 });
      expect(value.authority.readActor(childActor.id)).toEqual(actorBefore);
      expect(value.authority.readPaneBindingForActor(childActor.id)).toBeNull();
      expect(value.authority.readActorForPane("pane_harnessv20001")).toBeNull();
      expect(value.authority.releaseActorWorkspace({
        bindingId: workspace.id,
        expectedRevision: workspace.revision,
      })).toMatchObject({ state: "released", revision: 2 });
    } finally {
      value.database.close();
    }
  });

  test("turn idempotency keys fail closed without consuming ordinals", () => {
    const value = fixture();
    try {
      value.authority.createActorEpoch(epochAndRoot());
      insertContextValue(value.database, {
        valueId: "ctxval_idempotent0001",
        actorId: rootActorId,
        purpose: "currentInput",
      });
      const first = value.authority.createActorTurn({
        turnId: "hturn_idempotent0001",
        epochId,
        actorId: rootActorId,
        idempotencyKey: "idempotency-key-00001", // gitleaks:allow - deterministic test vector
        inputValueId: "ctxval_idempotent0001",
        createdAt: at,
      });
      expect(value.authority.createActorTurn({
        turnId: first.id,
        epochId,
        actorId: rootActorId,
        idempotencyKey: first.idempotencyKey,
        inputValueId: first.inputValueId,
        createdAt: later,
      })).toEqual(first);
      expect(() => value.authority.createActorTurn({
        turnId: "hturn_idempotent0002",
        epochId,
        actorId: rootActorId,
        idempotencyKey: first.idempotencyKey,
        inputValueId: first.inputValueId,
      })).toThrow("already bound");
      expect(value.authority.readActor(rootActorId)?.nextTurnOrdinal).toBe(2);
    } finally {
      value.database.close();
    }
  });
});

test("reservation boundary regression remains atomic", () => {
  const value = fixture();
  try {
    value.authority.createActorEpoch(epochAndRoot());
    const requests = [12070, 14607, 4, 15, 19996, 13319, 19995];
    let reserved = 0;
    for (const [index, requested] of requests.entries()) {
      const admitted = value.authority.createChildActor(child({
        id: `hactor_regression${String(index).padStart(8, "0")}`,
        tokenBudget: requested,
        byteBudget: MIB,
      }));
      reserved += requested;
      expect(admitted.budget.tokenBudget).toBe(requested);
      expect(value.authority.readActor(rootActorId)?.tokenReserved).toBe(reserved);
    }
  } finally {
    value.database.close();
  }
});

test("arbitrary valid child reservations are monotonic and rejected reservations are atomic", () => {
  const value = fixture();
  try {
    assertProperty(fc.property(
      fc.array(fc.integer({ min: 1, max: 20_000 }), {
        minLength: 1,
        maxLength: 20,
      }),
      (requests) => {
        try {
          value.authority.createActorEpoch(epochAndRoot());
          let reserved = 0;
          let admittedCount = 0;
          for (const [index, requested] of requests.entries()) {
            const actorId = `hactor_property${String(index).padStart(8, "0")}`;
            const remaining = rootBudget().tokenBudget - reserved;
            if (requested <= remaining && admittedCount < 8) {
              const admitted = value.authority.createChildActor(child({
                id: actorId,
                tokenBudget: requested,
                byteBudget: MIB,
              }));
              reserved += requested;
              admittedCount += 1;
              expect(admitted.budget.tokenBudget).toBe(requested);
            } else {
              expect(() => value.authority.createChildActor(child({
                id: actorId,
                tokenBudget: requested,
                byteBudget: MIB,
              }))).toThrow(HarnessSQLiteAuthorityV2Error);
            }
            expect(value.authority.readActor(rootActorId)?.tokenReserved)
              .toBe(reserved);
          }
        } finally {
          value.database.query(
            "DELETE FROM harness_actors WHERE parent_actor_id IS NOT NULL",
          ).run();
          value.database.query(
            "DELETE FROM harness_actors WHERE parent_actor_id IS NULL",
          ).run();
          value.database.query("DELETE FROM harness_actor_epochs").run();
        }
      },
    ));
  } finally {
    value.database.close();
  }
}, PROPERTY_TIMEOUT);

test("turn counts 1 through 12 allocate gap-free actor and root result sequences", () => {
  const value = fixture();
  try {
    for (let turnCount = 1; turnCount <= 12; turnCount += 1) {
      try {
          value.authority.createActorEpoch(epochAndRoot());
          const operation = value.authority.prepareActorOperation({
            operationId: "hoperation_propertyseq01",
            actorId: rootActorId,
            turnId: null,
            kind: "actorStart",
            requestDigest: digest("1"),
            effectKey: digest("2"),
            providerIdentityJson: '{"request":{"fixture":true},"version":1}',
            createdAt: at,
          });
          value.authority.transitionActorOperation({
            operationId: operation.id,
            expectedState: "prepared",
            nextState: "effectStarted",
          });
          value.authority.transitionActorOperation({
            operationId: operation.id,
            expectedState: "effectStarted",
            nextState: "succeeded",
            providerIdentityJson: '{"providerThreadId":"property-thread"}',
          });
          const incarnation = value.authority.createActorIncarnation({
            incarnationId: "hincarnation_property1",
            actorId: rootActorId,
            accountProfileId: accountId,
            processGeneration: 1,
            startOperationId: operation.id,
            clientRequestId: "client-request-property-1",
            threadSource: "oprte:epoch:property:1",
            toolsetDigest: digest("3"),
          });
          value.authority.transitionActorIncarnation({
            incarnationId: incarnation.id,
            expectedState: "starting",
            nextState: "idle",
            providerThreadId: "property-thread",
          });

          for (let index = 1; index <= turnCount; index += 1) {
            const suffix = String(index).padStart(8, "0");
            const valueId = `ctxval_propseqinput${suffix}`;
            const turnId = `hturn_propseq${suffix}`;
            const attemptId = `hattempt_propseq${suffix}`;
            insertContextValue(value.database, {
              valueId,
              actorId: rootActorId,
              purpose: "currentInput",
              marker: index % 2 === 0 ? "a" : "b",
            });
            let turn = value.authority.createActorTurn({
              turnId,
              epochId,
              actorId: rootActorId,
              idempotencyKey: `property-turn-key-${suffix}`,
              inputValueId: valueId,
            });
            turn = value.authority.transitionActorTurn({
              turnId,
              expectedRevision: turn.revision,
              nextState: "starting",
            });
            turn = value.authority.transitionActorTurn({
              turnId,
              expectedRevision: turn.revision,
              nextState: "running",
            });
            const attempt = value.authority.createActorAttempt({
              attemptId,
              turnId,
              incarnationId: incarnation.id,
              accountProfileId: accountId,
              processGeneration: 1,
              clientUserMessageId: `client-property-message-${suffix}`,
            });
            value.authority.transitionActorAttempt({
              attemptId,
              expectedState: attempt.state,
              nextState: "running",
              providerTurnId: `provider-property-turn-${suffix}`,
            });
            value.authority.transitionActorAttempt({
              attemptId,
              expectedState: "running",
              nextState: "failed",
            });
            const result = value.authority.settleActorResult({
              resultId: `hresult_propseq${suffix}`,
              turnId,
              terminalAttemptId: attemptId,
              outcome: "failed",
              valueId: null,
              expectedTurnRevision: turn.revision,
              outcomeCode: "property_failure",
            });
            expect(result.actorResultOrdinal).toBe(index);
            expect(result.rootCompletionSequence).toBe(index);
            expect(value.authority.settleActorResult({
              resultId: result.id,
              turnId,
              terminalAttemptId: attemptId,
              outcome: "failed",
              valueId: null,
              expectedTurnRevision: turn.revision,
              outcomeCode: "property_failure",
            })).toEqual(result);
          }
          expect(value.authority.listEpochResults({ epochId, limit: 128 })
            .map((result) => result.rootCompletionSequence))
            .toEqual(Array.from({ length: turnCount }, (_, index) => index + 1));
          expect(value.authority.readActor(rootActorId)).toMatchObject({
            state: "active",
            nextTurnOrdinal: turnCount + 1,
            nextResultOrdinal: turnCount + 1,
          });
      } finally {
        value.database.query("DELETE FROM harness_actor_results").run();
        value.database.query("DELETE FROM harness_actor_turn_attempts").run();
        value.database.query("DELETE FROM harness_actor_incarnations").run();
        value.database.query("DELETE FROM harness_actor_operations").run();
        value.database.query("DELETE FROM harness_actor_turns").run();
        value.database.query("DELETE FROM harness_context_value_chunks").run();
        value.database.query("DELETE FROM harness_context_values").run();
        value.database.query("DELETE FROM harness_actors").run();
        value.database.query("DELETE FROM harness_actor_epochs").run();
      }
    }
  } finally {
    value.database.close();
  }
});
