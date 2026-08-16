import { describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";

import { AccountServiceError } from "../src/accounts/account-service";
import {
  actorEpochSchema,
  actorSchema,
  type Actor,
  type ActorEpoch,
} from "../src/harness/actor-domain";
import {
  HarnessActorSessionRecoveryV2,
  type HarnessActorSessionRecoveryAuthorityPortV2,
  type HarnessActorSessionRecoverySchedulerV2,
} from "../src/harness/actor-session-recovery-v2";
import type {
  ActorTokenUsageIdentityInput,
  ActorTokenUsageIdentityPortV2,
} from
  "../src/harness/actor-token-usage-identity-v2";
import {
  actorSessionBindingRecordV2Schema,
  HarnessSQLiteAuthorityV2Error,
  HarnessSQLiteAuthorityV2,
  type ActorSessionBindingRecordV2,
  type ActorSessionRecoveryProofV2,
} from "../src/harness/sqlite-authority-v2";
import { applyMigrations } from "../src/state/database";

const at = "2032-01-01T00:00:00.000Z";
const later = "2032-01-01T00:00:01.000Z";
const recoveredAt = "2032-01-01T00:00:02.000Z";
const settledAt = "2032-01-01T00:00:03.000Z";
const deadline = "2032-01-02T00:00:00.000Z";
const projectId = "project-actor-session-v2";
const accountId = "acct_actor_session_v2";
const epochId = "hepoch_actorsession001";
const actorId = "hactor_actorsession001";
const incarnationId = "hincarnation_session001";
const providerThreadId = "provider-thread-session-001";
const sourceSha = "a".repeat(40);

const tokenUsageIdentities: ActorTokenUsageIdentityPortV2 = Object.freeze({
  digest: (input: ActorTokenUsageIdentityInput) => Promise.resolve(createHmac(
    "sha256",
    "actor-session-recovery-token-key",
  ).update(JSON.stringify(input)).digest("hex")),
});

function digest(marker: string): string {
  return marker.repeat(64);
}

function readHarnessModelCatalog(
  _accountProfileId: string,
  expectedGeneration: number,
) {
  return Promise.resolve(Object.freeze({
    evidenceDigest: digest("c"),
    generation: expectedGeneration,
    models: Object.freeze([
      Object.freeze({
        modelId: "gpt-5.6-luna",
        reasoningEfforts: Object.freeze(["max"]),
        serviceTiers: Object.freeze(["fast"]),
      }),
      Object.freeze({
        modelId: "gpt-5.6-sol",
        reasoningEfforts: Object.freeze(["max", "ultra"]),
        serviceTiers: Object.freeze(["fast"]),
      }),
    ]),
  }));
}

function epochAndActor(): Readonly<{ epoch: ActorEpoch; rootActor: Actor }> {
  const budget = {
    maxDepth: 3,
    maxActiveDescendants: 8,
    maxDurableDescendants: 50,
    tokenBudget: 100_000,
    byteBudget: 16 * 1024 * 1024,
    deadline,
    laneAuthority: "managedWrite" as const,
  };
  const epoch = actorEpochSchema.parse({
    id: epochId,
    projectId,
    sourceSha,
    rootActorId: actorId,
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
  return {
    epoch,
    rootActor: actorSchema.parse({
      id: actorId,
      epochId,
      parentActorId: null,
      depth: 0,
      title: "Recoverable root actor",
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
    }),
  };
}

function proof(
  generation: number,
  marker: string,
  priorRecoveryProofDigest: string | null,
): ActorSessionRecoveryProofV2 {
  return {
    recoveryProofDigest: digest(marker),
    priorRecoveryProofDigest,
    observationGeneration: generation,
    historyEvidenceDigest: digest(marker === "d" ? "e" : "d"),
    firstObservationPosition: generation * 10,
    secondObservationPosition: generation * 10 + 1,
    historyTurnCount: 0,
    historyItemCount: 0,
  };
}

function openFixture(path = ":memory:") {
  const database = new Database(path, { strict: true });
  database.exec("PRAGMA foreign_keys = ON");
  applyMigrations(database);
  if (database.query("SELECT 1 FROM projects WHERE project_id = ?1")
    .get(projectId) === null) {
    database.query(`
      INSERT INTO projects (
        project_id, canonical_repository_path, canonical_git_common_dir,
        display_name, created_at, updated_at
      ) VALUES (?1, '/tmp/actor-session-source',
        '/tmp/actor-session-source/.git', 'Actor Session', ?2, ?2)
    `).run(projectId, at);
    database.query(`
      INSERT INTO account_profiles (
        profile_id, label, auth_state, process_generation,
        selected, created_at, updated_at
      ) VALUES (?1, 'Actor session account', 'signed_in', 1, 1, ?2, ?2)
    `).run(accountId, at);
  }
  return {
    database,
    authority: new HarnessSQLiteAuthorityV2(database, {
      now: () => new Date(recoveredAt),
      tokenUsageIdentities,
    }),
  };
}

function prepareLiveSession(
  authority: HarnessSQLiteAuthorityV2,
  database: Database,
): void {
  authority.createActorEpoch(epochAndActor());
  database.query(`
    INSERT INTO workspace_leases (
      lane_id, project_id, canonical_checkout_path, mode, status,
      base_sha, branch_name, retention, dirty_hint,
      created_at, updated_at, quarantine_reason, quarantined_at
    ) VALUES (
      'lane_actor_session_001', ?1, '/tmp/actor-session-workspace',
      'managed_worktree', 'ready', ?2, 'codex/actor-session',
      'preserve', 0, ?3, ?3, NULL, NULL
    )
  `).run(projectId, sourceSha, at);
  authority.bindActorWorkspace({
    bindingId: "hbinding_actorsession001",
    actorId,
    laneId: "lane_actor_session_001",
    authority: "managedWrite",
    createdAt: at,
  });
  authority.prepareActorOperation({
    operationId: "hoperation_actorsessionstart01",
    actorId,
    turnId: null,
    kind: "actorStart",
    requestDigest: digest("1"),
    effectKey: digest("2"),
    providerIdentityJson: '{"request":{"fixture":true},"version":1}',
    createdAt: at,
  });
  authority.transitionActorOperation({
    operationId: "hoperation_actorsessionstart01",
    expectedState: "prepared",
    nextState: "effectStarted",
    now: at,
  });
  authority.transitionActorOperation({
    operationId: "hoperation_actorsessionstart01",
    expectedState: "effectStarted",
    nextState: "succeeded",
    providerIdentityJson: JSON.stringify({ providerThreadId }),
    now: later,
  });
  authority.createActorIncarnation({
    incarnationId,
    actorId,
    accountProfileId: accountId,
    processGeneration: 1,
    startOperationId: "hoperation_actorsessionstart01",
    clientRequestId: "client-request-actor-session-01",
    threadSource: "oprte:actor-session:source:0001",
    toolsetDigest: digest("3"),
    createdAt: at,
  });
  authority.transitionActorIncarnation({
    incarnationId,
    expectedState: "starting",
    nextState: "idle",
    providerThreadId,
    now: later,
  });
}

function prepareBoundSession(
  authority: HarnessSQLiteAuthorityV2,
  database: Database,
) {
  prepareLiveSession(authority, database);
  return authority.bindActorSession({
    incarnationId,
    recoveryProof: proof(1, "4", null),
    createdAt: later,
  });
}

function prepareStartingAttempt(
  authority: HarnessSQLiteAuthorityV2,
  database: Database,
) {
  database.query(`
    INSERT INTO harness_context_values (
      value_id, operation_id, epoch_id, owner_actor_id, source_turn_id,
      kind, purpose, schema_version, name_digest, utf8_bytes,
      content_digest, chunk_size, chunk_count, manifest_digest,
      manifest_byte_length, quota_limit_bytes, state, recovery_reason,
      revision, created_at, updated_at, effect_started_at, activated_at
    ) VALUES (
      'ctxval_actorinput0001', 'contextop_actorinput0001', ?1, ?2, NULL,
      'text', 'actorTask', 1, NULL, 1, ?3, 65536, 1, ?4,
      1, 16777216, 'active', NULL, 3, ?5, ?5, ?5, ?5
    )
  `).run(epochId, actorId, digest("5"), digest("6"), at);
  database.query(`
    INSERT INTO harness_context_value_chunks (
      value_id, ordinal, plaintext_bytes, object_digest, object_byte_length
    ) VALUES ('ctxval_actorinput0001', 0, 1, ?1, 1)
  `).run(digest("7"));
  const turn = authority.createActorTurn({
    turnId: "hturn_actorsession0001",
    epochId,
    actorId,
    idempotencyKey: "turn-key-actor-session-0001",
    inputValueId: "ctxval_actorinput0001",
    createdAt: later,
  });
  const attempt = authority.createActorAttempt({
    attemptId: "hattempt_actorsession001",
    turnId: turn.id,
    incarnationId,
    accountProfileId: accountId,
    processGeneration: 1,
    clientUserMessageId: "client-message-actor-session-01",
    createdAt: later,
  });
  return attempt;
}

function prepareRunningAttempt(
  authority: HarnessSQLiteAuthorityV2,
  database: Database,
) {
  const attempt = prepareStartingAttempt(authority, database);
  authority.transitionActorAttempt({
    attemptId: attempt.id,
    expectedState: "starting",
    nextState: "running",
    providerTurnId: "provider-turn-actor-session-01",
    now: later,
  });
  return authority.readActorAttempt(attempt.id)!;
}

function insertCompletedPrefix(
  database: Database,
  input: Readonly<{ valueId: string; sourceTurnId: string; marker: string }>,
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
    actorId,
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

function isolatedBinding(
  suffix: string,
  accountProfileId: string,
): ActorSessionBindingRecordV2 {
  return actorSessionBindingRecordV2Schema.parse({
    incarnationId: `hincarnation_recovery_${suffix}`,
    actorId: `hactor_recovery_${suffix}`,
    actorTitle: `Recovery ${suffix}`,
    workspaceBindingId: `hbinding_recovery_${suffix}`,
    workspaceLaneId: `lane_recovery_${suffix}`,
    workspacePath: `/tmp/recovery-${suffix}`,
    workspaceMode: "managed",
    accountProfileId,
    admissionGeneration: 1,
    liveGeneration: 1,
    providerThreadId: `provider-thread-recovery-${suffix}`,
    threadSource: `oprte:recovery:${suffix}:source`,
    modelId: "gpt-5.6-sol",
    reasoningEffort: "max",
    capabilityEvidenceDigest: digest("c"),
    supportsFast: true,
    liveCapabilityEvidenceDigest: digest("c"),
    liveSupportsFast: true,
    recoveryProof: proof(1, "4", null),
    state: "bound",
    quarantineReason: null,
    revision: 1,
    createdAt: at,
    updatedAt: at,
    recoveredAt: null,
    retiredAt: null,
    quarantinedAt: null,
  });
}

function isolatedAuthority(bindings: readonly ActorSessionBindingRecordV2[]) {
  const records = new Map(bindings.map((binding) => [
    binding.incarnationId,
    binding,
  ]));
  const advanced: string[] = [];
  const quarantined: string[] = [];
  const authority: HarnessActorSessionRecoveryAuthorityPortV2 = {
    readActorSessionBinding: (incarnationId) =>
      records.get(incarnationId) ?? null,
    listRecoverableActorSessions: ({ afterIncarnationId, limit }) =>
      [...records.values()]
        .filter((binding) =>
          binding.state === "bound" &&
          binding.incarnationId > (afterIncarnationId ?? ""))
        .toSorted((left, right) =>
          left.incarnationId.localeCompare(right.incarnationId))
        .slice(0, limit),
    advanceActorSessionBinding: (input) => {
      const current = records.get(input.incarnationId);
      if (
        current === undefined || current.revision !== input.expectedRevision ||
        current.liveGeneration !== input.expectedLiveGeneration ||
        input.recoveryProof.priorRecoveryProofDigest !==
          current.recoveryProof.recoveryProofDigest
      ) throw new Error("stale actor-session advance");
      const next = actorSessionBindingRecordV2Schema.parse({
        ...current,
        liveGeneration: input.recoveryProof.observationGeneration,
        liveCapabilityEvidenceDigest:
          input.liveCapabilityEvidence.evidenceDigest,
        liveSupportsFast: input.liveCapabilityEvidence.supportsFast,
        recoveryProof: input.recoveryProof,
        revision: current.revision + 1,
        updatedAt: input.now ?? recoveredAt,
        recoveredAt: input.now ?? recoveredAt,
      });
      records.set(current.incarnationId, next);
      advanced.push(current.incarnationId);
      return next;
    },
    quarantineActorSessionBinding: (input) => {
      const current = records.get(input.incarnationId);
      if (current === undefined || current.revision !== input.expectedRevision) {
        throw new Error("stale actor-session quarantine");
      }
      const next = actorSessionBindingRecordV2Schema.parse({
        ...current,
        state: "quarantined",
        quarantineReason: input.reason,
        revision: current.revision + 1,
        updatedAt: input.now ?? recoveredAt,
        quarantinedAt: input.now ?? recoveredAt,
      });
      records.set(current.incarnationId, next);
      quarantined.push(current.incarnationId);
      return next;
    },
  };
  return { advanced, authority, quarantined, records };
}

class ManualRecoveryScheduler
implements HarnessActorSessionRecoverySchedulerV2 {
  now = 0;
  readonly scheduled: Array<Readonly<{
    callback: () => void;
    delayMilliseconds: number;
    timer: { cancelled: boolean };
  }>> = [];

  monotonicNow(): number {
    return this.now;
  }

  schedule(callback: () => void, delayMilliseconds: number) {
    const timer = { cancelled: false };
    this.scheduled.push({ callback, delayMilliseconds, timer });
    return { cancel: () => {
      timer.cancelled = true;
    } };
  }

  runNext(): void {
    const scheduled = this.scheduled.shift();
    if (scheduled === undefined) throw new Error("no actor recovery retry is armed");
    this.now += scheduled.delayMilliseconds;
    if (!scheduled.timer.cancelled) scheduled.callback();
  }
}

async function eventually(assertion: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (assertion()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 1));
  }
  throw new Error("actor-session recovery did not converge");
}

function deferredValue<T>() {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve } as const;
}

function resumedBinding(
  binding: ActorSessionBindingRecordV2,
  generation = 2,
) {
  return {
    admissionGeneration: binding.admissionGeneration,
    generation,
    observedProfile: {
      modelId: binding.modelId,
      reasoningEffort: binding.reasoningEffort,
    },
    providerThreadId: binding.providerThreadId,
    threadId: `thread_owned_${binding.incarnationId}`,
    projectId,
    streamPosition: generation * 10,
    workspaceLaneId: binding.workspaceLaneId,
    recoveryProof: proof(
      generation,
      "8",
      binding.recoveryProof.recoveryProofDigest,
    ),
  } as const;
}

describe("actor session recovery v2", () => {
  test("bootstraps a same-generation legacy session into exact live catalog custody", async () => {
    const value = openFixture();
    try {
      const bound = prepareBoundSession(value.authority, value.database);
      expect(bound).toMatchObject({
        capabilityEvidenceDigest: null,
        supportsFast: null,
        liveCapabilityEvidenceDigest: null,
        liveSupportsFast: null,
        liveGeneration: 1,
        revision: 1,
      });
      const recovery = new HarnessActorSessionRecoveryV2({
        accounts: {
          ensureExactActorAccountRuntime: () => Promise.resolve({ generation: 1 }),
        },
        authority: value.authority,
        sessions: {
          readHarnessModelCatalog,
          resumeHarnessActorThread: () => Promise.resolve(
            resumedBinding(bound, 1),
          ),
        },
        now: () => new Date(recoveredAt),
      });

      expect(await recovery.recoverActorSessions()).toEqual({
        recoveredIncarnationIds: [incarnationId],
        quarantinedIncarnationIds: [],
        deferredIncarnationIds: [],
      });
      expect(value.authority.readActorSessionBinding(incarnationId))
        .toMatchObject({
          state: "bound",
          liveGeneration: 1,
          capabilityEvidenceDigest: null,
          supportsFast: null,
          liveCapabilityEvidenceDigest: digest("c"),
          liveSupportsFast: true,
          revision: 2,
          recoveredAt,
        });
      await recovery.close();
    } finally {
      value.database.close();
    }
  });

  test("closing an idle incarnation atomically retires its live session", () => {
    const value = openFixture();
    try {
      const bound = prepareBoundSession(value.authority, value.database);
      const closed = value.authority.transitionActorIncarnation({
        incarnationId,
        expectedState: "idle",
        nextState: "closed",
        now: settledAt,
      });
      expect(closed).toMatchObject({ state: "closed", closedAt: settledAt });
      expect(value.authority.readActorSessionBinding(incarnationId)).toMatchObject({
        state: "retired",
        revision: bound.revision + 1,
        retiredAt: settledAt,
        quarantinedAt: null,
        quarantineReason: null,
      });
      expect(value.authority.listRecoverableActorSessions({ limit: 32 }))
        .toEqual([]);
    } finally {
      value.database.close();
    }
  });

  test("quarantining an incarnation atomically fences its session", () => {
    const value = openFixture();
    try {
      const bound = prepareBoundSession(value.authority, value.database);
      value.authority.transitionActorIncarnation({
        incarnationId,
        expectedState: "idle",
        nextState: "quarantined",
        now: settledAt,
      });
      expect(value.authority.readActorSessionBinding(incarnationId)).toMatchObject({
        state: "quarantined",
        revision: bound.revision + 1,
        retiredAt: null,
        quarantinedAt: settledAt,
        quarantineReason: "recovery_protocol_error",
      });
      expect(value.authority.listRecoverableActorSessions({ limit: 32 }))
        .toEqual([]);
    } finally {
      value.database.close();
    }
  });

  test("quarantines a missing account, defers sign-in, and recovers a healthy account", async () => {
    const missing = isolatedBinding("missing001", "acct_missing_recovery");
    const signedOut = isolatedBinding("signedout01", "acct_signed_out_recovery");
    const healthy = isolatedBinding("healthy0001", "acct_healthy_recovery");
    const value = isolatedAuthority([missing, signedOut, healthy]);
    const resumeRequests: unknown[] = [];
    const recovery = new HarnessActorSessionRecoveryV2({
      accounts: {
        ensureExactActorAccountRuntime: ({ accountProfileId }) => {
          if (accountProfileId === missing.accountProfileId) {
            throw new AccountServiceError(
              "not_found",
              "The account was removed.",
              false,
              "none",
            );
          }
          if (accountProfileId === signedOut.accountProfileId) {
            throw new AccountServiceError(
              "capability_unavailable",
              "Sign in before recovery.",
              false,
              "signIn",
            );
          }
          return Promise.resolve({ generation: 2 });
        },
      },
      authority: value.authority,
      sessions: {
        readHarnessModelCatalog,
        resumeHarnessActorThread: (request) => {
          resumeRequests.push(request);
          return Promise.resolve(resumedBinding(healthy));
        },
      },
      now: () => new Date(recoveredAt),
    });

    expect(await recovery.recoverActorSessions()).toEqual({
      recoveredIncarnationIds: [healthy.incarnationId],
      quarantinedIncarnationIds: [missing.incarnationId],
      deferredIncarnationIds: [signedOut.incarnationId],
    });
    expect(value.advanced).toEqual([healthy.incarnationId]);
    expect(resumeRequests).toEqual([expect.objectContaining({
      model: healthy.modelId,
      reasoningEffort: healthy.reasoningEffort,
    })]);
    expect(value.quarantined).toEqual([missing.incarnationId]);
    expect(value.records.get(signedOut.incarnationId)).toMatchObject({
      state: "bound",
      revision: 1,
    });
    expect(value.records.get(healthy.incarnationId)).toMatchObject({
      state: "bound",
      liveGeneration: 2,
      liveCapabilityEvidenceDigest: digest("c"),
      liveSupportsFast: true,
      revision: 2,
    });
    await recovery.close();
  });

  test("quarantines a successor catalog that cannot prove the requested profile", async () => {
    const binding = isolatedBinding("catalogmiss1", "acct_catalog_missing");
    const value = isolatedAuthority([binding]);
    let resumed = false;
    const recovery = new HarnessActorSessionRecoveryV2({
      accounts: {
        ensureExactActorAccountRuntime: () => Promise.resolve({ generation: 2 }),
      },
      authority: value.authority,
      sessions: {
        readHarnessModelCatalog: (_accountProfileId, generation) =>
          Promise.resolve({
            evidenceDigest: digest("b"),
            generation,
            models: [{
              modelId: binding.modelId,
              reasoningEfforts: ["low"],
              serviceTiers: ["fast"],
            }],
          }),
        resumeHarnessActorThread: () => {
          resumed = true;
          return Promise.resolve(resumedBinding(binding));
        },
      },
      now: () => new Date(recoveredAt),
    });

    expect(await recovery.recoverActorSessions()).toEqual({
      recoveredIncarnationIds: [],
      quarantinedIncarnationIds: [binding.incarnationId],
      deferredIncarnationIds: [],
    });
    expect(resumed).toBeFalse();
    expect(value.records.get(binding.incarnationId)).toMatchObject({
      state: "quarantined",
      quarantineReason: "recovery_protocol_error",
    });
    await recovery.close();
  });

  test("quarantines a provider proof that repeats the bound recovery digest", async () => {
    const binding = isolatedBinding("proofreplay01", "acct_proof_replay");
    const value = isolatedAuthority([binding]);
    const recovery = new HarnessActorSessionRecoveryV2({
      accounts: {
        ensureExactActorAccountRuntime: () => Promise.resolve({ generation: 2 }),
      },
      authority: value.authority,
      sessions: {
        readHarnessModelCatalog,
        resumeHarnessActorThread: () => Promise.resolve({
          ...resumedBinding(binding),
          recoveryProof: {
            ...resumedBinding(binding).recoveryProof,
            recoveryProofDigest: binding.recoveryProof.recoveryProofDigest,
          },
        }),
      },
    });

    expect(await recovery.recoverActorSessions()).toEqual({
      recoveredIncarnationIds: [],
      quarantinedIncarnationIds: [binding.incarnationId],
      deferredIncarnationIds: [],
    });
    expect(value.advanced).toEqual([]);
    expect(value.quarantined).toEqual([binding.incarnationId]);
    expect(value.records.get(binding.incarnationId)).toMatchObject({
      state: "quarantined",
      quarantineReason: "recovery_protocol_error",
      revision: binding.revision + 1,
    });
    await recovery.close();
  });

  test("defers an account when its durable generation changes during the recovery CAS", async () => {
    const binding = isolatedBinding("generation01", "acct_generation_race");
    const value = isolatedAuthority([binding]);
    const scheduler = new ManualRecoveryScheduler();
    const recovery = new HarnessActorSessionRecoveryV2({
      accounts: {
        ensureExactActorAccountRuntime: () => Promise.resolve({ generation: 2 }),
      },
      authority: {
        ...value.authority,
        advanceActorSessionBinding: () => {
          throw new HarnessSQLiteAuthorityV2Error(
            "conflict",
            "actor session recovery generation is not the durable account generation",
          );
        },
      },
      sessions: {
        readHarnessModelCatalog,
        resumeHarnessActorThread: () => Promise.resolve(resumedBinding(binding)),
      },
      scheduler,
      retryDelayMs: 10,
    });

    expect(await recovery.recoverActorSessions()).toEqual({
      recoveredIncarnationIds: [],
      quarantinedIncarnationIds: [],
      deferredIncarnationIds: [binding.incarnationId],
    });
    expect(value.records.get(binding.incarnationId)).toEqual(binding);
    expect(value.advanced).toEqual([]);
    expect(value.quarantined).toEqual([]);
    expect(scheduler.scheduled).toHaveLength(1);
    await recovery.close();
  });

  test("bounds boot latency and concurrency when one account runtime never settles", async () => {
    const stalled = isolatedBinding("stalled0001", "acct_00_stalled_recovery");
    const healthy = Array.from({ length: 6 }, (_, index) => isolatedBinding(
      `healthy${String(index).padStart(4, "0")}`,
      `acct_${String(index + 1).padStart(2, "0")}_healthy_recovery`,
    ));
    const byAccount = new Map(healthy.map((binding) => [
      binding.accountProfileId,
      binding,
    ]));
    const value = isolatedAuthority([stalled, ...healthy]);
    let active = 0;
    let maximumActive = 0;
    const recovery = new HarnessActorSessionRecoveryV2({
      accounts: {
        ensureExactActorAccountRuntime: async ({ accountProfileId }) => {
          active += 1;
          maximumActive = Math.max(maximumActive, active);
          if (accountProfileId === stalled.accountProfileId) {
            return await new Promise<never>(() => undefined);
          }
          await new Promise<void>((resolve) => setTimeout(resolve, 2));
          active -= 1;
          return { generation: 2 };
        },
      },
      authority: value.authority,
      sessions: {
        readHarnessModelCatalog,
        resumeHarnessActorThread: (request) => {
          const binding = byAccount.get(request.accountProfileId);
          if (binding === undefined) throw new Error("unexpected stalled resume");
          return Promise.resolve(resumedBinding(binding));
        },
      },
      concurrency: 2,
      recoveryTimeoutMs: 40,
      retryDelayMs: 60_000,
    });
    const startedAt = performance.now();
    const report = await recovery.recoverActorSessions();
    const elapsed = performance.now() - startedAt;

    expect(report).toEqual({
      recoveredIncarnationIds: healthy.map(({ incarnationId }) => incarnationId)
        .toSorted(),
      quarantinedIncarnationIds: [],
      deferredIncarnationIds: [stalled.incarnationId],
    });
    expect(maximumActive).toBeLessThanOrEqual(2);
    expect(elapsed).toBeLessThan(200);
    // The deliberately unresolved runtime remains in flight, so shutdown
    // correctly refuses to claim a drain in this latency-only fixture.
    void recovery.close();
  });

  test("rotates retry admission past eight wedged accounts so later accounts recover", async () => {
    const wedged = Array.from({ length: 8 }, (_, index) => isolatedBinding(
      `wedged${String(index).padStart(5, "0")}`,
      `acct_${String(index).padStart(2, "0")}_wedged_recovery`,
    ));
    const healthy = Array.from({ length: 4 }, (_, index) => isolatedBinding(
      `later${String(index).padStart(6, "0")}`,
      `acct_${String(index + 8).padStart(2, "0")}_healthy_recovery`,
    ));
    const byAccount = new Map(healthy.map((binding) => [
      binding.accountProfileId,
      binding,
    ]));
    const value = isolatedAuthority([...wedged, ...healthy]);
    const scheduler = new ManualRecoveryScheduler();
    const accountAttempts: string[] = [];
    const recovery = new HarnessActorSessionRecoveryV2({
      accounts: {
        ensureExactActorAccountRuntime: ({ accountProfileId }) => {
          accountAttempts.push(accountProfileId);
          if (accountProfileId.includes("_wedged_")) {
            return new Promise<never>(() => undefined);
          }
          return Promise.resolve({ generation: 2 });
        },
      },
      authority: value.authority,
      sessions: {
        readHarnessModelCatalog,
        resumeHarnessActorThread: (request) => {
          const binding = byAccount.get(request.accountProfileId);
          if (binding === undefined) throw new Error("wedged account resumed");
          return Promise.resolve(resumedBinding(binding));
        },
      },
      concurrency: 8,
      recoveryTimeoutMs: 40,
      retryDelayMs: 10,
      scheduler: {
        monotonicNow: () => performance.now(),
        schedule: (callback, delayMilliseconds) =>
          scheduler.schedule(callback, delayMilliseconds),
      },
    });

    expect(await recovery.recoverActorSessions()).toEqual({
      recoveredIncarnationIds: [],
      quarantinedIncarnationIds: [],
      deferredIncarnationIds: [...wedged, ...healthy]
        .map(({ incarnationId }) => incarnationId).toSorted(),
    });
    expect(accountAttempts).toEqual(wedged.map(({ accountProfileId }) =>
      accountProfileId));

    scheduler.runNext();
    await eventually(() => value.advanced.length === healthy.length);
    expect(value.advanced.toSorted()).toEqual(
      healthy.map(({ incarnationId }) => incarnationId).toSorted(),
    );
    expect(accountAttempts.slice(8, 12)).toEqual(
      healthy.map(({ accountProfileId }) => accountProfileId),
    );
    for (const binding of healthy) {
      expect(recovery.isActorSessionReady(binding.incarnationId)).toBeTrue();
    }
    for (const binding of wedged) {
      expect(recovery.isActorSessionReady(binding.incarnationId)).toBeFalse();
    }
    void recovery.close();
  });

  test("rotates a retry past one hung incarnation within the same account", async () => {
    const accountProfileId = "acct_shared_incarnation_fairness";
    const bindings = [
      isolatedBinding("sharedhung01", accountProfileId),
      isolatedBinding("sharedready1", accountProfileId),
      isolatedBinding("sharedready2", accountProfileId),
    ];
    const [hung, ...healthy] = bindings;
    if (hung === undefined) throw new Error("hung binding fixture is missing");
    const byActorId = new Map(bindings.map((binding) => [
      binding.actorId,
      binding,
    ]));
    const value = isolatedAuthority(bindings);
    const scheduler = new ManualRecoveryScheduler();
    const hungResume = deferredValue<ReturnType<typeof resumedBinding>>();
    const resumeAttempts: string[] = [];
    const readyWakes: string[] = [];
    const recovery = new HarnessActorSessionRecoveryV2({
      accounts: {
        ensureExactActorAccountRuntime: () => Promise.resolve({ generation: 2 }),
      },
      authority: value.authority,
      sessions: {
        readHarnessModelCatalog,
        resumeHarnessActorThread: (request) => {
          const binding = byActorId.get(request.actorId);
          if (binding === undefined) throw new Error("unknown actor resume");
          resumeAttempts.push(binding.incarnationId);
          return binding.incarnationId === hung.incarnationId
            ? hungResume.promise
            : Promise.resolve(resumedBinding(binding));
        },
      },
      recoveryTimeoutMs: 10,
      retryDelayMs: 10,
      scheduler: {
        monotonicNow: () => performance.now(),
        schedule: (callback, delayMilliseconds) =>
          scheduler.schedule(callback, delayMilliseconds),
      },
      onIncarnationReady: (incarnationId) => {
        readyWakes.push(incarnationId);
      },
    });

    expect(await recovery.recoverActorSessions()).toEqual({
      recoveredIncarnationIds: [],
      quarantinedIncarnationIds: [],
      deferredIncarnationIds: bindings.map(({ incarnationId }) => incarnationId)
        .toSorted(),
    });
    expect(resumeAttempts).toEqual([hung.incarnationId]);

    scheduler.runNext();
    await eventually(() => value.advanced.length === healthy.length);
    expect(value.advanced.toSorted()).toEqual(
      healthy.map(({ incarnationId }) => incarnationId).toSorted(),
    );
    expect(resumeAttempts).toEqual(bindings.map(({ incarnationId }) =>
      incarnationId));
    expect(recovery.isActorSessionReady(hung.incarnationId)).toBeFalse();
    expect(readyWakes.toSorted()).toEqual(
      healthy.map(({ incarnationId }) => incarnationId).toSorted(),
    );

    hungResume.resolve(resumedBinding(hung));
    await eventually(() => value.advanced.length === bindings.length);
    expect(value.advanced.toSorted()).toEqual(
      bindings.map(({ incarnationId }) => incarnationId).toSorted(),
    );
    expect(new Set(value.advanced).size).toBe(bindings.length);
    expect(resumeAttempts).toEqual(bindings.map(({ incarnationId }) =>
      incarnationId));
    expect(readyWakes.toSorted()).toEqual(
      bindings.map(({ incarnationId }) => incarnationId).toSorted(),
    );
    expect(new Set(readyWakes).size).toBe(bindings.length);
    expect(recovery.isActorSessionReady(hung.incarnationId)).toBeTrue();
    await recovery.close();
  });

  test("retries a transient account fault later without replaying a recovered session", async () => {
    const binding = isolatedBinding("retry000001", "acct_retry_recovery");
    const value = isolatedAuthority([binding]);
    const scheduler = new ManualRecoveryScheduler();
    let accountAttempts = 0;
    let resumeAttempts = 0;
    const readyWakes: string[] = [];
    const recovery = new HarnessActorSessionRecoveryV2({
      accounts: {
        ensureExactActorAccountRuntime: () => {
          accountAttempts += 1;
          if (accountAttempts === 1) {
            throw new AccountServiceError(
              "runtime_unavailable",
              "Runtime is backing off.",
              true,
              "restartRuntime",
            );
          }
          return Promise.resolve({ generation: 2 });
        },
      },
      authority: value.authority,
      sessions: {
        readHarnessModelCatalog,
        resumeHarnessActorThread: () => {
          resumeAttempts += 1;
          return Promise.resolve(resumedBinding(binding));
        },
      },
      scheduler,
      retryDelayMs: 10,
      onIncarnationReady: (readyIncarnationId) => {
        readyWakes.push(readyIncarnationId);
      },
    });
    expect(await recovery.recoverActorSessions()).toEqual({
      recoveredIncarnationIds: [],
      quarantinedIncarnationIds: [],
      deferredIncarnationIds: [binding.incarnationId],
    });
    expect(scheduler.scheduled).toHaveLength(1);
    expect(recovery.isActorSessionReady(binding.incarnationId)).toBeFalse();
    expect(readyWakes).toEqual([]);

    scheduler.runNext();
    await eventually(() => value.advanced.length === 1);
    expect(accountAttempts).toBe(2);
    expect(resumeAttempts).toBe(1);
    expect(value.advanced).toEqual([binding.incarnationId]);
    expect(scheduler.scheduled).toHaveLength(0);
    expect(recovery.isActorSessionReady(binding.incarnationId)).toBeTrue();
    expect(readyWakes).toEqual([binding.incarnationId]);
    await recovery.close();
  });

  test("a timed-out detached resume wakes liveness immediately when its original promise succeeds", async () => {
    const binding = isolatedBinding("detachedwake1", "acct_detached_wake");
    const value = isolatedAuthority([binding]);
    const scheduler = new ManualRecoveryScheduler();
    const resume = deferredValue<ReturnType<typeof resumedBinding>>();
    const readyWakes: string[] = [];
    let resumeAttempts = 0;
    const recovery = new HarnessActorSessionRecoveryV2({
      accounts: {
        ensureExactActorAccountRuntime: () => Promise.resolve({ generation: 2 }),
      },
      authority: value.authority,
      sessions: {
        readHarnessModelCatalog,
        resumeHarnessActorThread: () => {
          resumeAttempts += 1;
          return resume.promise;
        },
      },
      recoveryTimeoutMs: 10,
      retryDelayMs: 10,
      scheduler: {
        monotonicNow: () => performance.now(),
        schedule: (callback, delayMilliseconds) =>
          scheduler.schedule(callback, delayMilliseconds),
      },
      onIncarnationReady: (readyIncarnationId) => {
        readyWakes.push(readyIncarnationId);
      },
    });

    expect(await recovery.recoverActorSessions()).toEqual({
      recoveredIncarnationIds: [],
      quarantinedIncarnationIds: [],
      deferredIncarnationIds: [binding.incarnationId],
    });
    expect(recovery.isActorSessionReady(binding.incarnationId)).toBeFalse();
    expect(resumeAttempts).toBe(1);
    expect(scheduler.scheduled).toHaveLength(1);

    resume.resolve(resumedBinding(binding));
    await eventually(() => value.advanced.length === 1);
    expect(recovery.isActorSessionReady(binding.incarnationId)).toBeTrue();
    expect(readyWakes).toEqual([binding.incarnationId]);
    expect(resumeAttempts).toBe(1);
    expect(scheduler.scheduled[0]?.timer.cancelled).toBeTrue();
    await recovery.close();
  });

  test("one recoverable account fault defers every same-account binding with one runtime attempt", async () => {
    const bindings = Array.from({ length: 4 }, (_, index) => isolatedBinding(
      `signin${String(index).padStart(5, "0")}`,
      "acct_shared_signed_out_recovery",
    ));
    const value = isolatedAuthority(bindings);
    const scheduler = new ManualRecoveryScheduler();
    let accountAttempts = 0;
    const recovery = new HarnessActorSessionRecoveryV2({
      accounts: {
        ensureExactActorAccountRuntime: () => {
          accountAttempts += 1;
          throw new AccountServiceError(
            "capability_unavailable",
            "Sign in before recovery.",
            false,
            "signIn",
          );
        },
      },
      authority: value.authority,
      sessions: {
        readHarnessModelCatalog,
        resumeHarnessActorThread: () => {
          throw new Error("signed-out accounts must not reach session resume");
        },
      },
      scheduler,
      retryDelayMs: 10,
    });

    expect(await recovery.recoverActorSessions()).toEqual({
      recoveredIncarnationIds: [],
      quarantinedIncarnationIds: [],
      deferredIncarnationIds: bindings.map(({ incarnationId }) => incarnationId)
        .toSorted(),
    });
    expect(accountAttempts).toBe(1);
    expect(scheduler.scheduled).toHaveLength(1);
    await recovery.close();
  });

  test("a newer or terminal durable binding makes a stale retry a terminal no-op", async () => {
    for (const nextState of ["bound", "retired"] as const) {
      const binding = isolatedBinding(
        `stale${nextState.padEnd(7, "0")}`,
        `acct_stale_${nextState}`,
      );
      const value = isolatedAuthority([binding]);
      const scheduler = new ManualRecoveryScheduler();
      let accountAttempts = 0;
      const recovery = new HarnessActorSessionRecoveryV2({
        accounts: {
          ensureExactActorAccountRuntime: () => {
            accountAttempts += 1;
            throw new AccountServiceError(
              "runtime_unavailable",
              "Retry later.",
              true,
              "restartRuntime",
            );
          },
        },
        authority: value.authority,
        sessions: {
          readHarnessModelCatalog,
          resumeHarnessActorThread: () => {
            throw new Error("transient account failure must not resume");
          },
        },
        scheduler,
        retryDelayMs: 10,
      });
      expect((await recovery.recoverActorSessions()).deferredIncarnationIds)
        .toEqual([binding.incarnationId]);
      const current = value.records.get(binding.incarnationId)!;
      value.records.set(binding.incarnationId, actorSessionBindingRecordV2Schema.parse({
        ...current,
        revision: current.revision + 1,
        state: nextState,
        retiredAt: nextState === "retired" ? settledAt : null,
        updatedAt: settledAt,
        recoveredAt: nextState === "bound" ? settledAt : current.recoveredAt,
      }));

      scheduler.runNext();
      await new Promise<void>((resolve) => setTimeout(resolve, 1));
      expect(accountAttempts).toBe(1);
      expect(scheduler.scheduled).toHaveLength(0);
      await recovery.close();
    }
  });

  test("a late in-flight completion cannot CAS or requeue after a newer durable revision", async () => {
    const binding = isolatedBinding("latecurrent1", "acct_late_current_recovery");
    const value = isolatedAuthority([binding]);
    const scheduler = new ManualRecoveryScheduler();
    const resume = deferredValue<ReturnType<typeof resumedBinding>>();
    const recovery = new HarnessActorSessionRecoveryV2({
      accounts: {
        ensureExactActorAccountRuntime: () => Promise.resolve({ generation: 2 }),
      },
      authority: value.authority,
      sessions: {
        readHarnessModelCatalog,
        resumeHarnessActorThread: () => resume.promise,
      },
      recoveryTimeoutMs: 10,
      retryDelayMs: 10,
      scheduler: {
        monotonicNow: () => performance.now(),
        schedule: (callback, delayMilliseconds) =>
          scheduler.schedule(callback, delayMilliseconds),
      },
    });
    expect((await recovery.recoverActorSessions()).deferredIncarnationIds)
      .toEqual([binding.incarnationId]);
    const current = value.records.get(binding.incarnationId)!;
    value.records.set(binding.incarnationId, actorSessionBindingRecordV2Schema.parse({
      ...current,
      revision: 2,
      updatedAt: settledAt,
      recoveredAt: settledAt,
    }));

    resume.resolve(resumedBinding(binding));
    await new Promise<void>((resolve) => setTimeout(resolve, 1));
    expect(value.advanced).toEqual([]);
    expect(value.quarantined).toEqual([]);
    expect(value.records.get(binding.incarnationId)).toMatchObject({
      state: "bound",
      revision: 2,
    });
    expect(scheduler.scheduled[0]?.timer.cancelled).toBeTrue();
    await recovery.close();
  });

  test("post-preflight revision and deletion races are terminal only after durable reread", async () => {
    for (const code of ["revision_conflict", "not_found"] as const) {
      const binding = isolatedBinding(
        `cas${code === "not_found" ? "deleted001" : "revision01"}`,
        `acct_${code}_race`,
      );
      const value = isolatedAuthority([binding]);
      const scheduler = new ManualRecoveryScheduler();
      const recovery = new HarnessActorSessionRecoveryV2({
        accounts: {
          ensureExactActorAccountRuntime: () => Promise.resolve({ generation: 2 }),
        },
        authority: {
          ...value.authority,
          advanceActorSessionBinding: () => {
            if (code === "not_found") {
              value.records.delete(binding.incarnationId);
            } else {
              value.records.set(
                binding.incarnationId,
                actorSessionBindingRecordV2Schema.parse({
                  ...binding,
                  revision: binding.revision + 1,
                  updatedAt: settledAt,
                  recoveredAt: settledAt,
                }),
              );
            }
            throw new HarnessSQLiteAuthorityV2Error(
              code,
              `injected post-preflight ${code}`,
            );
          },
        },
        sessions: {
          readHarnessModelCatalog,
          resumeHarnessActorThread: () => Promise.resolve(resumedBinding(binding)),
        },
        scheduler,
      });

      expect(await recovery.recoverActorSessions()).toEqual({
        recoveredIncarnationIds: [],
        quarantinedIncarnationIds: [],
        deferredIncarnationIds: [],
      });
      expect(value.advanced).toEqual([]);
      expect(value.quarantined).toEqual([]);
      expect(scheduler.scheduled).toHaveLength(0);
      await recovery.close();
    }
  });

  test("a late unclassified rejection becomes sticky fatal recovery evidence", async () => {
    const binding = isolatedBinding("latefailure1", "acct_late_failure_recovery");
    const value = isolatedAuthority([binding]);
    const scheduler = new ManualRecoveryScheduler();
    const resume = deferredValue<ReturnType<typeof resumedBinding>>();
    const published: Error[] = [];
    const recovery = new HarnessActorSessionRecoveryV2({
      accounts: {
        ensureExactActorAccountRuntime: () => Promise.resolve({ generation: 2 }),
      },
      authority: value.authority,
      sessions: {
        readHarnessModelCatalog,
        resumeHarnessActorThread: () => resume.promise,
      },
      recoveryTimeoutMs: 10,
      retryDelayMs: 10,
      scheduler: {
        monotonicNow: () => performance.now(),
        schedule: (callback, delayMilliseconds) =>
          scheduler.schedule(callback, delayMilliseconds),
      },
      onFatalFailure: (error) => {
        published.push(error);
        throw new Error("recovery sink unavailable");
      },
    });
    expect((await recovery.recoverActorSessions()).deferredIncarnationIds)
      .toEqual([binding.incarnationId]);
    expect(scheduler.scheduled).toHaveLength(1);

    resume.reject(new Error("late corrupt provider rejection"));
    await new Promise<void>((resolve) => setTimeout(resolve, 1));
    expect(scheduler.scheduled[0]?.timer.cancelled).toBeTrue();
    expect(recovery.isActorSessionReady(binding.incarnationId)).toBeFalse();
    expect(published).toHaveLength(1);
    expect(published[0]?.message).toBe("late corrupt provider rejection");
    const nextRecovery = recovery.recoverActorSessions();
    expect(nextRecovery).rejects.toThrow("late corrupt provider rejection");
    await nextRecovery.catch(() => undefined);
    const closing = recovery.close();
    expect(closing).rejects.toThrow("late corrupt provider rejection");
    await closing.catch(() => undefined);
    expect(value.advanced).toEqual([]);
    expect(value.quarantined).toEqual([]);
  });

  test("multiple detached fatal failures publish only the first exact failure", async () => {
    const bindings = [
      isolatedBinding("fatalmulti01", "acct_fatal_multi_01"),
      isolatedBinding("fatalmulti02", "acct_fatal_multi_02"),
    ];
    const value = isolatedAuthority(bindings);
    const scheduler = new ManualRecoveryScheduler();
    const resumes = new Map(bindings.map((binding) => [
      binding.actorId,
      deferredValue<ReturnType<typeof resumedBinding>>(),
    ]));
    const published: Error[] = [];
    const recovery = new HarnessActorSessionRecoveryV2({
      accounts: {
        ensureExactActorAccountRuntime: () => Promise.resolve({ generation: 2 }),
      },
      authority: value.authority,
      sessions: {
        readHarnessModelCatalog,
        resumeHarnessActorThread: (request) => {
          const resume = resumes.get(request.actorId);
          if (resume === undefined) throw new Error("unknown fatal fixture actor");
          return resume.promise;
        },
      },
      concurrency: 2,
      recoveryTimeoutMs: 10,
      retryDelayMs: 10,
      scheduler: {
        monotonicNow: () => performance.now(),
        schedule: (callback, delayMilliseconds) =>
          scheduler.schedule(callback, delayMilliseconds),
      },
      onFatalFailure: (error) => {
        published.push(error);
      },
    });
    expect((await recovery.recoverActorSessions()).deferredIncarnationIds)
      .toEqual(bindings.map(({ incarnationId }) => incarnationId).toSorted());

    resumes.get(bindings[0]!.actorId)!.reject(new Error("first detached fatal"));
    await eventually(() => published.length === 1);
    resumes.get(bindings[1]!.actorId)!.reject(new Error("second detached fatal"));
    await new Promise<void>((resolve) => setTimeout(resolve, 1));
    expect(published.map(({ message }) => message)).toEqual([
      "first detached fatal",
    ]);
    for (const binding of bindings) {
      expect(recovery.isActorSessionReady(binding.incarnationId)).toBeFalse();
    }
    const closing = recovery.close();
    expect(closing).rejects.toThrow("first detached fatal");
    await closing.catch(() => undefined);
  });

  test("a retry-pass fatal failure publishes once while initial boot failures do not", async () => {
    const retryBinding = isolatedBinding(
      "fatalretry01",
      "acct_fatal_retry_publish",
    );
    const retryValue = isolatedAuthority([retryBinding]);
    const scheduler = new ManualRecoveryScheduler();
    const published: Error[] = [];
    let accountAttempts = 0;
    const recovery = new HarnessActorSessionRecoveryV2({
      accounts: {
        ensureExactActorAccountRuntime: () => {
          accountAttempts += 1;
          if (accountAttempts === 1) {
            throw new AccountServiceError(
              "runtime_unavailable",
              "retry account startup",
              true,
              "restartRuntime",
            );
          }
          throw new Error("retry pass corrupt adapter result");
        },
      },
      authority: retryValue.authority,
      sessions: {
        readHarnessModelCatalog,
        resumeHarnessActorThread: () => {
          throw new Error("retry account failure must not resume");
        },
      },
      scheduler,
      retryDelayMs: 10,
      onFatalFailure: (error) => {
        published.push(error);
      },
    });
    expect((await recovery.recoverActorSessions()).deferredIncarnationIds)
      .toEqual([retryBinding.incarnationId]);
    scheduler.runNext();
    await eventually(() => published.length === 1);
    expect(published[0]?.message).toBe("retry pass corrupt adapter result");
    expect(recovery.isActorSessionReady(retryBinding.incarnationId)).toBeFalse();
    await recovery.close().catch(() => undefined);

    const bootBinding = isolatedBinding("fatalboot001", "acct_fatal_boot");
    const bootValue = isolatedAuthority([bootBinding]);
    const bootPublished: Error[] = [];
    const boot = new HarnessActorSessionRecoveryV2({
      accounts: {
        ensureExactActorAccountRuntime: () => {
          throw new Error("initial boot corruption");
        },
      },
      authority: bootValue.authority,
      sessions: {
        readHarnessModelCatalog,
        resumeHarnessActorThread: () => {
          throw new Error("initial boot failure must not resume");
        },
      },
      onFatalFailure: (error) => {
        bootPublished.push(error);
      },
    });
    expect(boot.recoverActorSessions()).rejects.toThrow(
      "initial boot corruption",
    );
    expect(bootPublished).toEqual([]);
    await boot.close().catch(() => undefined);
  });

  test("unclassified account and authority CAS failures fail closed without retry", async () => {
    const unclassifiedBinding = isolatedBinding(
      "unclassified1",
      "acct_unclassified_recovery",
    );
    const unclassifiedValue = isolatedAuthority([unclassifiedBinding]);
    const unclassifiedScheduler = new ManualRecoveryScheduler();
    const unclassified = new HarnessActorSessionRecoveryV2({
      accounts: {
        ensureExactActorAccountRuntime: () => {
          throw new Error("corrupt account adapter result");
        },
      },
      authority: unclassifiedValue.authority,
      sessions: {
        readHarnessModelCatalog,
        resumeHarnessActorThread: () => {
          throw new Error("unclassified account failure must not resume");
        },
      },
      scheduler: unclassifiedScheduler,
    });
    const unclassifiedRecovery = unclassified.recoverActorSessions();
    expect(unclassifiedRecovery).rejects.toThrow(
      "corrupt account adapter result",
    );
    await unclassifiedRecovery.catch(() => undefined);
    expect(unclassifiedScheduler.scheduled).toHaveLength(0);
    await unclassified.close().catch(() => undefined);

    const casBinding = isolatedBinding("casfailure01", "acct_cas_recovery");
    const casValue = isolatedAuthority([casBinding]);
    const casScheduler = new ManualRecoveryScheduler();
    const cas = new HarnessActorSessionRecoveryV2({
      accounts: {
        ensureExactActorAccountRuntime: () => Promise.resolve({ generation: 2 }),
      },
      authority: {
        ...casValue.authority,
        advanceActorSessionBinding: () => {
          throw new Error("injected actor-session CAS conflict");
        },
      },
      sessions: {
        readHarnessModelCatalog,
        resumeHarnessActorThread: () => Promise.resolve(resumedBinding(casBinding)),
      },
      scheduler: casScheduler,
    });
    const casRecovery = cas.recoverActorSessions();
    expect(casRecovery).rejects.toThrow(
      "injected actor-session CAS conflict",
    );
    await casRecovery.catch(() => undefined);
    expect(casScheduler.scheduled).toHaveLength(0);
    await cas.close().catch(() => undefined);
  });

  test("corrupt authority state and unrelated conflicts remain fatal", async () => {
    for (const [code, message] of [
      ["corrupt_state", "injected actor-session corruption"],
      ["conflict", "injected unrelated authority conflict"],
    ] as const) {
      const binding = isolatedBinding(
        `fatal${code === "conflict" ? "conflict01" : "corrupt001"}`,
        `acct_fatal_${code}`,
      );
      const value = isolatedAuthority([binding]);
      const scheduler = new ManualRecoveryScheduler();
      const recovery = new HarnessActorSessionRecoveryV2({
        accounts: {
          ensureExactActorAccountRuntime: () => Promise.resolve({ generation: 2 }),
        },
        authority: {
          ...value.authority,
          advanceActorSessionBinding: () => {
            throw new HarnessSQLiteAuthorityV2Error(code, message);
          },
        },
        sessions: {
          readHarnessModelCatalog,
          resumeHarnessActorThread: () => Promise.resolve(resumedBinding(binding)),
        },
        scheduler,
      });

      const operation = recovery.recoverActorSessions();
      expect(operation).rejects.toThrow(message);
      await operation.catch(() => undefined);
      expect(value.advanced).toEqual([]);
      expect(value.quarantined).toEqual([]);
      expect(scheduler.scheduled).toHaveLength(0);
      await recovery.close().catch(() => undefined);
    }
  });

  test("shutdown cancels retry and forbids a late resume from touching durable authority", async () => {
    const binding = isolatedBinding("shutdown0001", "acct_shutdown_recovery");
    const value = isolatedAuthority([binding]);
    const scheduler = new ManualRecoveryScheduler();
    const resume = deferredValue<ReturnType<typeof resumedBinding>>();
    const readyWakes: string[] = [];
    const recovery = new HarnessActorSessionRecoveryV2({
      accounts: {
        ensureExactActorAccountRuntime: () => Promise.resolve({ generation: 2 }),
      },
      authority: value.authority,
      sessions: {
        readHarnessModelCatalog,
        resumeHarnessActorThread: () => resume.promise,
      },
      recoveryTimeoutMs: 10,
      retryDelayMs: 10,
      scheduler: {
        monotonicNow: () => performance.now(),
        schedule: (callback, delayMilliseconds) =>
          scheduler.schedule(callback, delayMilliseconds),
      },
      onIncarnationReady: (readyIncarnationId) => {
        readyWakes.push(readyIncarnationId);
      },
    });
    expect(await recovery.recoverActorSessions()).toEqual({
      recoveredIncarnationIds: [],
      quarantinedIncarnationIds: [],
      deferredIncarnationIds: [binding.incarnationId],
    });
    expect(scheduler.scheduled).toHaveLength(1);
    expect(recovery.isActorSessionReady(binding.incarnationId)).toBeFalse();

    const closing = recovery.close();
    expect(scheduler.scheduled[0]?.timer.cancelled).toBeTrue();
    resume.resolve(resumedBinding(binding));
    await closing;
    await new Promise<void>((resolve) => setTimeout(resolve, 1));
    expect(value.advanced).toEqual([]);
    expect(value.quarantined).toEqual([]);
    expect(readyWakes).toEqual([]);
    expect(recovery.isActorSessionReady(binding.incarnationId)).toBeFalse();
  });

  test("restart replay retains the exact bound proof after a transient boot fault", async () => {
    const directory = mkdtempSync(join(tmpdir(), "oprte-actor-restart-recovery-"));
    const databasePath = join(directory, "control.sqlite");
    try {
      const first = openFixture(databasePath);
      const bound = prepareBoundSession(first.authority, first.database);
      const transient = new HarnessActorSessionRecoveryV2({
        accounts: {
          ensureExactActorAccountRuntime: () => {
            throw new AccountServiceError(
              "runtime_unavailable",
              "Runtime is temporarily unavailable.",
              true,
              "restartRuntime",
            );
          },
        },
        authority: first.authority,
        sessions: {
          readHarnessModelCatalog,
          resumeHarnessActorThread: () => {
            throw new Error("a transient account fault must not resume");
          },
        },
        retryDelayMs: 60_000,
      });
      expect(await transient.recoverActorSessions()).toMatchObject({
        recoveredIncarnationIds: [],
        quarantinedIncarnationIds: [],
        deferredIncarnationIds: [incarnationId],
      });
      await transient.close();
      expect(first.authority.readActorSessionBinding(incarnationId)).toEqual(bound);
      first.database.close();

      const restarted = openFixture(databasePath);
      restarted.database.query(`
        UPDATE account_profiles SET process_generation = 2, updated_at = ?2
        WHERE profile_id = ?1
      `).run(accountId, recoveredAt);
      let resumeAttempts = 0;
      const nextProof = proof(2, "8", bound.recoveryProof.recoveryProofDigest);
      const recovery = new HarnessActorSessionRecoveryV2({
        accounts: {
          ensureExactActorAccountRuntime: () => Promise.resolve({ generation: 2 }),
        },
        authority: restarted.authority,
        sessions: {
          readHarnessModelCatalog,
          resumeHarnessActorThread: (request) => {
            resumeAttempts += 1;
            expect(request.previousRecoveryProofDigest).toBe(
              bound.recoveryProof.recoveryProofDigest,
            );
            return Promise.resolve({
              ...resumedBinding(actorSessionBindingRecordV2Schema.parse(bound)),
              recoveryProof: nextProof,
            });
          },
        },
        now: () => new Date(recoveredAt),
      });
      expect(await recovery.recoverActorSessions()).toEqual({
        recoveredIncarnationIds: [incarnationId],
        quarantinedIncarnationIds: [],
        deferredIncarnationIds: [],
      });
      expect(resumeAttempts).toBe(1);
      expect(restarted.authority.readActorSessionBinding(incarnationId))
        .toMatchObject({
          state: "bound",
          liveGeneration: 2,
          revision: bound.revision + 1,
          recoveryProof: nextProof,
        });
      await recovery.close();
      restarted.database.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("file-backed N to N+1 recovery advances proof while preserving admission", async () => {
    const directory = mkdtempSync(join(tmpdir(), "oprte-actor-session-db-"));
    const databasePath = join(directory, "control.sqlite");
    try {
      const first = openFixture(databasePath);
      const bound = prepareBoundSession(first.authority, first.database);
      first.database.close();

      const restarted = openFixture(databasePath);
      restarted.database.query(`
        UPDATE account_profiles SET process_generation = 2, updated_at = ?2
        WHERE profile_id = ?1
      `).run(accountId, recoveredAt);
      const nextProof = proof(2, "8", bound.recoveryProof.recoveryProofDigest);
      const recovery = new HarnessActorSessionRecoveryV2({
        accounts: {
          ensureExactActorAccountRuntime: () => Promise.resolve({ generation: 2 }),
        },
        authority: restarted.authority,
        sessions: {
          readHarnessModelCatalog,
          resumeHarnessActorThread: (request) => Promise.resolve({
            admissionGeneration: request.admissionGeneration,
            generation: request.expectedGeneration,
            observedProfile: {
              modelId: request.model,
              reasoningEffort: request.reasoningEffort,
            },
            providerThreadId: request.providerThreadId,
            threadId: "thread_owned_actor_session",
            projectId,
            streamPosition: 20,
            workspaceLaneId: "lane_owned_actor_session",
            recoveryProof: nextProof,
          }),
        },
        now: () => new Date(recoveredAt),
      });
      expect(await recovery.recoverActorSessions()).toEqual({
        recoveredIncarnationIds: [incarnationId],
        quarantinedIncarnationIds: [],
        deferredIncarnationIds: [],
      });
      expect(restarted.authority.readActorSessionBinding(incarnationId))
        .toMatchObject({
          admissionGeneration: 1,
          liveGeneration: 2,
          revision: 2,
          state: "bound",
          recoveryProof: nextProof,
        });
      restarted.database.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("file-backed N to N+1 recovery preserves pre-binding usage for exact binding", async () => {
    const directory = mkdtempSync(join(tmpdir(), "oprte-actor-usage-db-"));
    const databasePath = join(directory, "control.sqlite");
    const usage = {
      accountProfileId: accountId,
      processGeneration: 1,
      providerThreadId,
      providerTurnId: "provider-turn-prebinding-session-01",
      streamPosition: 41,
      cumulativeInputTokens: 321,
      cumulativeOutputTokens: 89,
    } as const;
    try {
      const first = openFixture(databasePath);
      const bound = prepareBoundSession(first.authority, first.database);
      const attempt = prepareStartingAttempt(first.authority, first.database);
      expect(await first.authority.recordActorTurnUsage(usage)).toBeTrue();
      expect(first.authority.readActorAttempt(attempt.id)).toMatchObject({
        state: "starting",
        providerTurnId: null,
        inputTokens: null,
        outputTokens: null,
      });
      expect(first.database.query(`
        SELECT COUNT(*) AS count FROM harness_actor_turn_usage_inbox
        WHERE attempt_id = ?1 AND quarantined = 0
      `).get(attempt.id)).toEqual({ count: 1 });
      first.database.close();

      const restarted = openFixture(databasePath);
      restarted.database.query(`
        UPDATE account_profiles SET process_generation = 2, updated_at = ?2
        WHERE profile_id = ?1
      `).run(accountId, recoveredAt);
      const nextProof = proof(2, "8", bound.recoveryProof.recoveryProofDigest);
      const recovery = new HarnessActorSessionRecoveryV2({
        accounts: {
          ensureExactActorAccountRuntime: () => Promise.resolve({ generation: 2 }),
        },
        authority: restarted.authority,
        sessions: {
          readHarnessModelCatalog,
          resumeHarnessActorThread: (request) => Promise.resolve({
            admissionGeneration: request.admissionGeneration,
            generation: request.expectedGeneration,
            observedProfile: {
              modelId: request.model,
              reasoningEffort: request.reasoningEffort,
            },
            providerThreadId: request.providerThreadId,
            threadId: "thread_owned_prebinding_usage",
            projectId,
            streamPosition: 20,
            workspaceLaneId: "lane_owned_prebinding_usage",
            recoveryProof: nextProof,
          }),
        },
        now: () => new Date(recoveredAt),
      });
      expect(await recovery.recoverActorSessions()).toEqual({
        recoveredIncarnationIds: [incarnationId],
        quarantinedIncarnationIds: [],
        deferredIncarnationIds: [],
      });
      expect(restarted.authority.readActorSessionBinding(incarnationId))
        .toMatchObject({ liveGeneration: 2, revision: 2, state: "bound" });
      expect(restarted.authority.readActorAttempt(attempt.id)).toMatchObject({
        state: "starting",
        providerTurnId: null,
        inputTokens: null,
        outputTokens: null,
      });
      expect(restarted.database.query(`
        SELECT observation_generation, stream_position,
          cumulative_input_tokens, cumulative_output_tokens, quarantined
        FROM harness_actor_turn_usage_inbox WHERE attempt_id = ?1
      `).get(attempt.id)).toEqual({
        observation_generation: 1,
        stream_position: usage.streamPosition,
        cumulative_input_tokens: usage.cumulativeInputTokens,
        cumulative_output_tokens: usage.cumulativeOutputTokens,
        quarantined: 0,
      });

      restarted.authority.transitionActorAttempt({
        attemptId: attempt.id,
        expectedState: "starting",
        nextState: "reconciling",
        now: settledAt,
      });
      const expectedIdentityDigest = await tokenUsageIdentities.digest({
        epochId,
        actorId,
        accountProfileId: usage.accountProfileId,
        processGeneration: usage.processGeneration,
        providerThreadId: usage.providerThreadId,
        providerTurnId: usage.providerTurnId,
      });
      const consumed = await restarted.authority.bindActorAttemptProviderTurn({
        attemptId: attempt.id,
        expectedState: "reconciling",
        providerTurnId: usage.providerTurnId,
      });
      expect(consumed).toMatchObject({
        state: "reconciling",
        providerTurnId: usage.providerTurnId,
        tokenUsageIdentityDigest: expectedIdentityDigest,
        tokenUsageObservationGeneration: 1,
        tokenUsageStreamPosition: usage.streamPosition,
        tokenUsageCumulativeInputTokens: usage.cumulativeInputTokens,
        tokenUsageCumulativeOutputTokens: usage.cumulativeOutputTokens,
        inputTokens: usage.cumulativeInputTokens,
        outputTokens: usage.cumulativeOutputTokens,
      });
      expect(await restarted.authority.bindActorAttemptProviderTurn({
        attemptId: attempt.id,
        expectedState: "reconciling",
        providerTurnId: usage.providerTurnId,
      })).toEqual(consumed);
      expect(restarted.database.query(`
        SELECT COUNT(*) AS count FROM harness_actor_turn_usage_inbox
        WHERE attempt_id = ?1
      `).get(attempt.id)).toEqual({ count: 0 });
      restarted.database.close();

      const verified = openFixture(databasePath);
      expect(await verified.authority.recordActorTurnUsage(usage)).toBeTrue();
      expect(verified.authority.readActorAttempt(attempt.id)).toEqual(consumed);
      expect(verified.authority.readActorTurnUsage({
        accountProfileId: usage.accountProfileId,
        processGeneration: usage.processGeneration,
        providerTurnId: usage.providerTurnId,
      })).toEqual({
        cachedInputTokens: null,
        inputTokens: usage.cumulativeInputTokens,
        outputTokens: usage.cumulativeOutputTokens,
        reasoningOutputTokens: null,
      });
      expect(verified.database.query(`
        SELECT COUNT(*) AS count FROM harness_actor_turn_usage_inbox
        WHERE attempt_id = ?1
      `).get(attempt.id)).toEqual({ count: 0 });
      verified.database.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("a lost initial start binds its first proof at an exact successor generation", () => {
    const value = openFixture();
    try {
      prepareLiveSession(value.authority, value.database);
      const successorProof = proof(2, "8", null);
      const legacySuccessorCapabilityEvidence = {
        observationGeneration: 2,
        evidenceDigest: null,
        supportsFast: null,
      } as const;
      expect(() => value.authority.bindActorSession({
        incarnationId,
        liveCapabilityEvidence: legacySuccessorCapabilityEvidence,
        recoveryProof: successorProof,
        createdAt: recoveredAt,
      })).toThrow("does not match the live account runtime");
      value.database.query(`
        UPDATE account_profiles SET process_generation = 2, updated_at = ?2
        WHERE profile_id = ?1
      `).run(accountId, recoveredAt);
      const binding = value.authority.bindActorSession({
        incarnationId,
        liveCapabilityEvidence: legacySuccessorCapabilityEvidence,
        recoveryProof: successorProof,
        createdAt: recoveredAt,
      });
      expect(binding).toMatchObject({
        admissionGeneration: 1,
        liveGeneration: 2,
        revision: 1,
        recoveryProof: {
          observationGeneration: 2,
          priorRecoveryProofDigest: null,
        },
      });
      expect(value.authority.bindActorSession({
        incarnationId,
        liveCapabilityEvidence: legacySuccessorCapabilityEvidence,
        recoveryProof: successorProof,
        createdAt: settledAt,
      })).toEqual(binding);
    } finally {
      value.database.close();
    }
  });

  test("proof conflict and provider tampering fail closed", async () => {
    const value = openFixture();
    try {
      const bound = prepareBoundSession(value.authority, value.database);
      value.database.query(`
        UPDATE account_profiles SET process_generation = 2 WHERE profile_id = ?1
      `).run(accountId);
      expect(() => value.authority.advanceActorSessionBinding({
        incarnationId,
        expectedRevision: bound.revision,
        expectedLiveGeneration: 1,
        liveCapabilityEvidence: {
          evidenceDigest: "c".repeat(64),
          supportsFast: true,
        },
        recoveryProof: proof(2, "8", digest("f")),
      })).toThrow("does not advance its exact chain");
      expect(() => value.database.query(`
        UPDATE harness_actor_session_bindings
        SET provider_thread_id = 'provider-thread-tampered'
        WHERE incarnation_id = ?1
      `).run(incarnationId)).toThrow("identity is immutable");

      const recovery = new HarnessActorSessionRecoveryV2({
        accounts: {
          ensureExactActorAccountRuntime: () => Promise.resolve({ generation: 2 }),
        },
        authority: value.authority,
        sessions: {
          readHarnessModelCatalog,
          resumeHarnessActorThread: () => Promise.resolve({
            admissionGeneration: 1,
            generation: 2,
            observedProfile: {
              modelId: "gpt-5.6-sol" as const,
              reasoningEffort: "ultra" as const,
            },
            providerThreadId: "another-provider-thread",
            threadId: "thread_wrong",
            projectId,
            streamPosition: 20,
            workspaceLaneId: "lane_wrong",
            recoveryProof: proof(2, "8", bound.recoveryProof.recoveryProofDigest),
          }),
        },
        now: () => new Date(recoveredAt),
      });
      expect(await recovery.recoverActorSessions()).toEqual({
        recoveredIncarnationIds: [],
        quarantinedIncarnationIds: [incarnationId],
        deferredIncarnationIds: [],
      });
      expect(value.authority.readActorSessionBinding(incarnationId))
        .toMatchObject({
          state: "quarantined",
          quarantineReason: "recovery_protocol_error",
        });
      expect(value.authority.readActorIncarnation(incarnationId))
        .toMatchObject({ state: "quarantined" });
    } finally {
      value.database.close();
    }
  });

  test("successor usage resets position but preserves monotonic totals and attribution", async () => {
    const value = openFixture();
    try {
      const bound = prepareBoundSession(value.authority, value.database);
      const attempt = prepareRunningAttempt(value.authority, value.database);
      expect(await value.authority.recordActorTurnUsage({
        accountProfileId: accountId,
        processGeneration: 1,
        providerThreadId,
        providerTurnId: attempt.providerTurnId!,
        streamPosition: 50,
        cumulativeInputTokens: 100,
        cumulativeOutputTokens: 20,
      })).toBeTrue();
      value.database.query(`
        UPDATE account_profiles SET process_generation = 2 WHERE profile_id = ?1
      `).run(accountId);
      value.authority.advanceActorSessionBinding({
        incarnationId,
        expectedRevision: bound.revision,
        expectedLiveGeneration: 1,
        liveCapabilityEvidence: {
          evidenceDigest: "c".repeat(64),
          supportsFast: true,
        },
        recoveryProof: proof(2, "8", bound.recoveryProof.recoveryProofDigest),
      });
      expect(await value.authority.recordActorTurnUsage({
        accountProfileId: accountId,
        processGeneration: 2,
        providerThreadId,
        providerTurnId: attempt.providerTurnId!,
        streamPosition: 1,
        cumulativeInputTokens: 100,
        cumulativeOutputTokens: 20,
      })).toBeTrue();
      expect(await value.authority.recordActorTurnUsage({
        accountProfileId: accountId,
        processGeneration: 2,
        providerThreadId,
        providerTurnId: attempt.providerTurnId!,
        streamPosition: 2,
        cumulativeInputTokens: 105,
        cumulativeOutputTokens: 22,
      })).toBeTrue();
      expect(value.authority.readActorTurnUsage({
        accountProfileId: accountId,
        processGeneration: 1,
        providerTurnId: attempt.providerTurnId!,
      })).toEqual({
        cachedInputTokens: null,
        inputTokens: 105,
        outputTokens: 22,
        reasoningOutputTokens: null,
      });
      expect(value.authority.resolveActorAttemptObservation({
        accountProfileId: accountId,
        observationGeneration: 2,
        providerThreadId,
        providerTurnId: attempt.providerTurnId!,
      })).toMatchObject({
        admissionGeneration: 1,
        currentObservationGeneration: 2,
        attempt: { id: attempt.id, processGeneration: 1 },
      });

      let contradiction: unknown = null;
      try {
        await value.authority.recordActorTurnUsage({
          accountProfileId: accountId,
          processGeneration: 2,
          providerThreadId,
          providerTurnId: attempt.providerTurnId!,
          streamPosition: 3,
          cumulativeInputTokens: 104,
          cumulativeOutputTokens: 23,
        });
      } catch (cause: unknown) {
        contradiction = cause;
      }
      expect(contradiction).toBeInstanceOf(Error);
      expect((contradiction as Error).message)
        .toContain("contradicted its verified session successor");
      expect(value.authority.readActorSessionBinding(incarnationId))
        .toMatchObject({
          state: "quarantined",
          quarantineReason: "token_evidence_regression",
        });
      expect(await value.authority.recordActorTurnUsage({
        accountProfileId: accountId,
        processGeneration: 1,
        providerThreadId,
        providerTurnId: attempt.providerTurnId!,
        streamPosition: 50,
        cumulativeInputTokens: 100,
        cumulativeOutputTokens: 20,
      })).toBeFalse();
    } finally {
      value.database.close();
    }
  });

  test("quota continuation capsule binding is exact, idempotent, and terminally narrow", () => {
    const value = openFixture();
    try {
      prepareBoundSession(value.authority, value.database);
      const attempt = prepareRunningAttempt(value.authority, value.database);
      const capsuleValueId = "ctxval_continuationcapsule01";
      insertCompletedPrefix(value.database, {
        valueId: capsuleValueId,
        sourceTurnId: attempt.turnId,
        marker: "8",
      });

      expect(() => value.authority.transitionActorAttempt({
        attemptId: attempt.id,
        expectedState: "running",
        nextState: "quotaRejected",
        quotaProofDigest: digest("9"),
        now: recoveredAt,
      })).toThrow("requires sealed continuation history");
      const bound = value.authority.bindActorQuotaContinuationCapsule({
        attemptId: attempt.id,
        expectedState: "running",
        continuationHistoryValueId: capsuleValueId,
      });
      expect(bound.continuationHistoryValueId).toBe(capsuleValueId);
      expect(value.authority.bindActorQuotaContinuationCapsule({
        attemptId: attempt.id,
        expectedState: "running",
        continuationHistoryValueId: capsuleValueId,
      })).toEqual(bound);
      expect(() => value.authority.transitionActorAttempt({
        attemptId: attempt.id,
        expectedState: "running",
        nextState: "completed",
        now: recoveredAt,
      })).toThrow("may only terminalize for quota");
      expect(value.authority.transitionActorAttempt({
        attemptId: attempt.id,
        expectedState: "running",
        nextState: "quotaRejected",
        quotaProofDigest: digest("9"),
        now: recoveredAt,
      })).toMatchObject({
        state: "quotaRejected",
        continuationHistoryValueId: capsuleValueId,
      });
      expect(() => value.authority.bindActorQuotaContinuationCapsule({
        attemptId: attempt.id,
        expectedState: "running",
        continuationHistoryValueId: capsuleValueId,
      })).toThrow("CAS state changed");

      value.database.query(`
        INSERT INTO harness_context_values (
          value_id, operation_id, epoch_id, owner_actor_id, source_turn_id,
          kind, purpose, schema_version, name_digest, utf8_bytes,
          content_digest, chunk_size, chunk_count, manifest_digest,
          manifest_byte_length, quota_limit_bytes, state, recovery_reason,
          revision, created_at, updated_at, effect_started_at, activated_at
        ) VALUES (
          'ctxval_preeffectinput0001', 'contextop_preeffectinput0001',
          ?1, ?2, NULL, 'text', 'actorTask', 1, NULL, 1,
          ?3, 65536, 1, ?4, 1, 16777216, 'active', NULL,
          3, ?5, ?5, ?5, ?5
        )
      `).run(epochId, actorId, digest("a"), digest("b"), settledAt);
      value.database.query(`
        INSERT INTO harness_context_value_chunks (
          value_id, ordinal, plaintext_bytes, object_digest, object_byte_length
        ) VALUES ('ctxval_preeffectinput0001', 0, 1, ?1, 1)
      `).run(digest("c"));
      const preEffectTurn = value.authority.createActorTurn({
        turnId: "hturn_preeffectquota0001",
        epochId,
        actorId,
        idempotencyKey: "turn-key-preeffect-quota-0001", // gitleaks:allow - deterministic test vector
        inputValueId: "ctxval_preeffectinput0001",
        createdAt: settledAt,
      });
      const preEffectAttempt = value.authority.createActorAttempt({
        attemptId: "hattempt_preeffectquota001",
        turnId: preEffectTurn.id,
        incarnationId,
        accountProfileId: accountId,
        processGeneration: 1,
        clientUserMessageId: "client-message-preeffect-quota-01",
        createdAt: settledAt,
      });
      expect(value.authority.transitionActorAttempt({
        attemptId: preEffectAttempt.id,
        expectedState: "starting",
        nextState: "quotaRejected",
        quotaProofDigest: digest("d"),
        now: settledAt,
      })).toMatchObject({
        state: "quotaRejected",
        providerTurnId: null,
        continuationHistoryValueId: null,
      });
    } finally {
      value.database.close();
    }
  });

  test("v29 reserves fail-closed semantic evidence and successor continuation lineage", () => {
    const value = openFixture();
    try {
      prepareBoundSession(value.authority, value.database);
      const attempt = prepareRunningAttempt(value.authority, value.database);
      expect(value.database.query<{ count: number }, []>(`
        SELECT COUNT(*) AS count FROM harness_semantic_evidence_bundles
        WHERE state = 'active'
      `).get()?.count).toBe(0);
      value.database.query(`
        INSERT INTO harness_semantic_evidence_bundles (
          bundle_digest, provider_id, account_profile_id,
          account_generation, process_generation, runtime_binary_sha256,
          codex_version, observed_at, expires_at, signer_key_id,
          manifest_digest, manifest_signature, state, quarantine_reason,
          revision, created_at, updated_at
        ) VALUES (
          ?1, 'codex-app-server', ?2, 1, 1, ?3, '0.144.6', ?4, ?5,
          'oprte-semantic-key-v1', ?6, ?7, 'active', NULL, 1, ?8, ?8
        )
      `).run(
        digest("1"),
        accountId,
        digest("2"),
        at,
        deadline,
        digest("3"),
        "A".repeat(86),
        later,
      );
      expect(() => value.database.query(`
        UPDATE harness_semantic_evidence_bundles
        SET manifest_digest = ?2 WHERE bundle_digest = ?1
      `).run(digest("1"), digest("4"))).toThrow("identity is immutable");
      value.database.query(`
        UPDATE harness_semantic_evidence_bundles SET
          state = 'superseded', revision = 2, updated_at = ?2
        WHERE bundle_digest = ?1
      `).run(digest("1"), recoveredAt);

      const sourceDigest = digest("4");
      const firstEffectDigest = digest("5");
      const firstIntentId = `hcontinuation_${firstEffectDigest}`;
      value.database.query(`
        INSERT INTO harness_actor_continuation_intents (
          intent_id, actor_id, actor_turn_id, source_identity_digest,
          target_process_generation, effect_identity_digest, metadata_digest,
          predecessor_intent_id,
          recovery_proof_digest, state, revision, exact_readback_verified,
          absence_proof_digest, ambiguity_code,
          created_at, updated_at, settled_at
        ) VALUES (
          ?1, ?2, ?3, ?4, 1, ?5, ?6, NULL, NULL,
          'prepared', 1, 0, NULL, NULL, ?7, ?7, NULL
        )
      `).run(
        firstIntentId,
        actorId,
        attempt.turnId,
        sourceDigest,
        firstEffectDigest,
        digest("6"),
        later,
      );
      expect(() => value.database.query(`
        INSERT INTO harness_actor_continuation_intents (
          intent_id, actor_id, actor_turn_id, source_identity_digest,
          target_process_generation, effect_identity_digest, metadata_digest,
          predecessor_intent_id,
          recovery_proof_digest, state, revision, exact_readback_verified,
          absence_proof_digest, ambiguity_code,
          created_at, updated_at, settled_at
        ) VALUES (
          ?1, ?2, ?3, ?4, 1, ?5, ?6, NULL, NULL,
          'prepared', 1, 0, NULL, NULL, ?7, ?7, NULL
        )
      `).run(
        `hcontinuation_${digest("7")}`,
        actorId,
        attempt.turnId,
        sourceDigest,
        digest("7"),
        digest("8"),
        recoveredAt,
      )).toThrow();

      const firstRecoveryProof = digest("9");
      value.database.query(`
        UPDATE harness_actor_continuation_intents SET
          state = 'supersededNotApplied', recovery_proof_digest = ?2,
          revision = 2, updated_at = ?3, settled_at = ?3
        WHERE intent_id = ?1
      `).run(firstIntentId, firstRecoveryProof, recoveredAt);
      const secondEffectDigest = digest("a");
      const secondIntentId = `hcontinuation_${secondEffectDigest}`;
      value.database.query(`
        INSERT INTO harness_actor_continuation_intents (
          intent_id, actor_id, actor_turn_id, source_identity_digest,
          target_process_generation, effect_identity_digest, metadata_digest,
          predecessor_intent_id,
          recovery_proof_digest, state, revision, exact_readback_verified,
          absence_proof_digest, ambiguity_code,
          created_at, updated_at, settled_at
        ) VALUES (
          ?1, ?2, ?3, ?4, 2, ?5, ?6, ?7, ?8,
          'prepared', 1, 0, NULL, NULL, ?9, ?9, NULL
        )
      `).run(
        secondIntentId,
        actorId,
        attempt.turnId,
        sourceDigest,
        secondEffectDigest,
        digest("b"),
        firstIntentId,
        firstRecoveryProof,
        settledAt,
      );
      const secondRecoveryProof = digest("c");
      value.database.query(`
        UPDATE harness_actor_continuation_intents SET
          state = 'supersededApplied', recovery_proof_digest = ?2,
          revision = 2, updated_at = ?3, settled_at = ?3
        WHERE intent_id = ?1
      `).run(secondIntentId, secondRecoveryProof, deadline);
      expect(() => value.database.query(`
        UPDATE harness_actor_continuation_intents SET
          revision = 3, updated_at = ?2 WHERE intent_id = ?1
      `).run(secondIntentId, deadline)).toThrow("transition is incoherent");
    } finally {
      value.database.close();
    }
  });
});
