import {
  createHash,
  createHmac,
  hkdfSync,
} from "node:crypto";

import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { assertAsyncProperty, fc } from "@hra-internal/test";

import {
  HarnessActorContinuationIntentIdentityV2,
  LEGACY_OPRTE_ACTOR_CONTINUATION_INTENT_HMAC_DOMAIN_V2,
} from "../src/harness/actor-continuation-intent-identity-v2";
import {
  PersistentActorContinuationSQLiteAuthorityV2,
} from "../src/harness/actor-continuation-intent-sqlite-v2";
import type {
  PersistentActorContinuationIntent,
  PersistentActorContinuationIntentMetadata,
  PersistentActorContinuationIntentState,
} from "../src/harness/codex-persistent-actor-provider";
import type {
  HarnessContextKeyProvider,
} from "../src/harness/key-custody";
import { applyMigrations } from "../src/state/database";

const at = "2031-02-03T04:05:06.000Z";
const deadline = "2031-02-04T04:05:06.000Z";
const projectId = "project_continuation_intent_v2";
const epochId = "hepoch_continuation_intent01";
const actorId = "hactor_continuation_intent01";
const contextKey = Uint8Array.from(
  { length: 32 },
  (_, index) => index + 1,
);
const ledgerDigest = "a".repeat(64);
const historyDigest = "c".repeat(64);
const absenceProofDigest = "d".repeat(64);
const otherDigest = "e".repeat(64);
const recoveryProofOne = "1".repeat(64);
const recoveryProofTwo = "2".repeat(64);
const recoveryProofThree = "3".repeat(64);
const SQLITE_PROPERTY_INTERRUPT_AFTER_TIME_LIMIT = 30_000;
const SQLITE_PROPERTY_TIMEOUT =
  SQLITE_PROPERTY_INTERRUPT_AFTER_TIME_LIMIT + 5_000;

class StrictDeterministicContextKeys implements HarnessContextKeyProvider {
  readonly scopes: unknown[] = [];

  async withContextKey<T>(
    scopeValue: unknown,
    operation: (key: Uint8Array) => Promise<T> | T,
  ): Promise<T> {
    if (
      typeof scopeValue !== "object" ||
      scopeValue === null ||
      Array.isArray(scopeValue)
    ) throw new Error("continuation identity received an invalid key scope");
    const scope = scopeValue as Record<string, unknown>;
    if (
      Object.keys(scope).sort().join(",") !==
        "epochId,ownerActorId,sourceTurnId" ||
      typeof scope.epochId !== "string" ||
      !/^hepoch_[A-Za-z0-9_-]+$/u.test(scope.epochId) ||
      typeof scope.ownerActorId !== "string" ||
      !/^hactor_[A-Za-z0-9_-]+$/u.test(scope.ownerActorId) ||
      typeof scope.sourceTurnId !== "string" ||
      !/^hturn_[A-Za-z0-9_-]+$/u.test(scope.sourceTurnId)
    ) throw new Error("continuation identity received an invalid key scope");
    this.scopes.push(Object.freeze({ ...scope }));
    const borrowed = Uint8Array.from(contextKey);
    try {
      return await operation(borrowed);
    } finally {
      borrowed.fill(0);
    }
  }
}

function turnId(index: number): string {
  return `hturn_continuation_intent${String(index).padStart(2, "0")}`;
}

function metadata(
  index: number,
  overrides: Partial<PersistentActorContinuationIntentMetadata> = {},
): PersistentActorContinuationIntentMetadata {
  return Object.freeze({
    actorId,
    actorTurnId: turnId(index),
    clientUserMessageId:
      `client-continuation-message-${String(index).padStart(2, "0")}`,
    historyDigest,
    historyItemCount: 4,
    historyUtf8Bytes: 321,
    sourceAccountProfileId: "raw-source-account-private",
    sourceProcessGeneration: 17,
    sourceProviderThreadId: "raw-source-provider-thread-private",
    sourceProviderTurnId: "raw-source-provider-turn-private",
    targetAccountProfileId: "raw-target-account-private",
    targetProcessGeneration: 23,
    targetProviderThreadId: "raw-target-provider-thread-private",
    ...overrides,
  });
}

function openDatabase(turnCount = 12): Database {
  const value = new Database(":memory:", { strict: true });
  value.exec("PRAGMA foreign_keys = ON");
  applyMigrations(value);
  value.query(`
    INSERT INTO projects (
      project_id, canonical_repository_path, canonical_git_common_dir,
      display_name, created_at, updated_at
    ) VALUES (?1, '/tmp/continuation', '/tmp/continuation/.git',
      'Continuation', ?2, ?2)
  `).run(projectId, at);
  value.query(`
    INSERT INTO harness_actor_epochs (
      epoch_id, project_id, source_sha, root_actor_id,
      max_depth, max_active_descendants, max_durable_descendants,
      token_budget, byte_budget, deadline, lane_authority,
      state, revision, created_at, updated_at
    ) VALUES (
      ?1, ?2, ?3, ?4, 3, 8, 50, 100000, 16777216, ?5,
      'managedWrite', 'active', 1, ?6, ?6
    )
  `).run(epochId, projectId, "b".repeat(40), actorId, deadline, at);
  value.query(`
    INSERT INTO harness_actors (
      actor_id, epoch_id, parent_actor_id, depth, title, state,
      max_depth, max_active_descendants, max_durable_descendants,
      token_budget, byte_budget, deadline, lane_authority,
      revision, created_at, updated_at
    ) VALUES (
      ?1, ?2, NULL, 0, 'Continuation actor', 'active',
      3, 8, 50, 100000, 16777216, ?3, 'managedWrite', 1, ?4, ?4
    )
  `).run(actorId, epochId, deadline, at);
  for (let index = 1; index <= turnCount; index += 1) {
    seedTurn(value, index);
  }
  return value;
}

function seedTurn(database: Database, index: number): void {
  const suffix = String(index).padStart(2, "0");
  const valueId = `ctxval_continuation_input${suffix}`;
  database.query(`
    INSERT INTO harness_context_values (
      value_id, operation_id, epoch_id, owner_actor_id, source_turn_id,
      kind, purpose, schema_version, name_digest, utf8_bytes,
      content_digest, chunk_size, chunk_count, manifest_digest,
      manifest_byte_length, quota_limit_bytes, state, recovery_reason,
      revision, created_at, updated_at, effect_started_at, activated_at
    ) VALUES (
      ?1, ?2, ?3, ?4, NULL, 'text', 'currentInput', 1, NULL, 1,
      ?5, 65536, 1, ?5, 64, 16777216, 'active', NULL,
      3, ?6, ?6, ?6, ?6
    )
  `).run(
    valueId,
    `operation_continuation_input${suffix}`,
    epochId,
    actorId,
    ledgerDigest,
    at,
  );
  database.query(`
    INSERT INTO harness_context_value_chunks (
      value_id, ordinal, plaintext_bytes, object_digest, object_byte_length
    ) VALUES (?1, 0, 1, ?2, 32)
  `).run(valueId, ledgerDigest);
  database.query(`
    INSERT INTO harness_actor_turns (
      turn_id, epoch_id, actor_id, ordinal, idempotency_key,
      input_value_id, state, desired_state, revision,
      created_at, started_at, settled_at, outcome_code
    ) VALUES (
      ?1, ?2, ?3, ?4, ?5, ?6, 'quotaRejected', 'run', 3,
      ?7, ?7, ?7, 'quota_exhausted'
    )
  `).run(
    turnId(index),
    epochId,
    actorId,
    index,
    `idempotency_continuation_${suffix}`,
    valueId,
    at,
  );
}

function fixture(): Readonly<{
  authority: () => PersistentActorContinuationSQLiteAuthorityV2;
  database: Database;
  keys: StrictDeterministicContextKeys;
}> {
  const database = openDatabase();
  const keys = new StrictDeterministicContextKeys();
  const identities = new HarnessActorContinuationIntentIdentityV2(keys);
  let tick = 0;
  const now = () => {
    const value = new Date(Date.parse(at) + tick * 1_000);
    tick += 1;
    return value;
  };
  return Object.freeze({
    authority: () => new PersistentActorContinuationSQLiteAuthorityV2(
      database,
      { identities, now },
    ),
    database,
    keys,
  });
}

function expectedIdentityDigests(
  value: PersistentActorContinuationIntentMetadata,
): Readonly<{
  sourceIdentityDigest: string;
  effectIdentityDigest: string;
  metadataDigest: string;
}> {
  const salt = createHash("sha256")
    .update("OPRTE actor continuation intent salt v2", "utf8")
    .digest();
  const info = Buffer.from(
    "OPRTE actor continuation intent HMAC key v2",
    "utf8",
  );
  const digestKey = Buffer.from(hkdfSync(
    "sha256",
    contextKey,
    salt,
    info,
    32,
  ));
  try {
    const hmac = (payload: readonly unknown[]) =>
      createHmac("sha256", digestKey).update(JSON.stringify(payload))
        .digest("hex");
    return Object.freeze({
      sourceIdentityDigest: hmac([
        `${LEGACY_OPRTE_ACTOR_CONTINUATION_INTENT_HMAC_DOMAIN_V2}.source`,
        value.actorId,
        value.actorTurnId,
        value.sourceAccountProfileId,
        value.sourceProcessGeneration,
        value.sourceProviderThreadId,
        value.sourceProviderTurnId,
      ]),
      effectIdentityDigest: hmac([
        `${LEGACY_OPRTE_ACTOR_CONTINUATION_INTENT_HMAC_DOMAIN_V2}.effect`,
        value.actorId,
        value.actorTurnId,
        value.clientUserMessageId,
        value.targetAccountProfileId,
        value.targetProcessGeneration,
        value.targetProviderThreadId,
      ]),
      metadataDigest: hmac([
      LEGACY_OPRTE_ACTOR_CONTINUATION_INTENT_HMAC_DOMAIN_V2,
      value.actorId,
      value.actorTurnId,
      value.clientUserMessageId,
      value.historyDigest,
      value.historyItemCount,
      value.historyUtf8Bytes,
      value.sourceAccountProfileId,
      value.sourceProcessGeneration,
      value.sourceProviderThreadId,
      value.sourceProviderTurnId,
      value.targetAccountProfileId,
      value.targetProcessGeneration,
      value.targetProviderThreadId,
      ]),
    });
  } finally {
    digestKey.fill(0);
    salt.fill(0);
    info.fill(0);
  }
}

async function oneCasWinner(
  operations: readonly [
    () => Promise<PersistentActorContinuationIntent>,
    () => Promise<PersistentActorContinuationIntent>,
  ],
): Promise<PersistentActorContinuationIntent> {
  const outcomes = await Promise.allSettled(operations.map(
    async (operation) => await operation(),
  ));
  const fulfilled = outcomes.filter(
    (outcome): outcome is PromiseFulfilledResult<
      PersistentActorContinuationIntent
    > => outcome.status === "fulfilled",
  );
  const rejected = outcomes.filter(
    (outcome) => outcome.status === "rejected",
  );
  expect(fulfilled).toHaveLength(1);
  expect(rejected).toHaveLength(1);
  return fulfilled[0]!.value;
}

async function advanceTo(
  authority: PersistentActorContinuationSQLiteAuthorityV2,
  intentMetadata: PersistentActorContinuationIntentMetadata,
  target: PersistentActorContinuationIntentState,
): Promise<PersistentActorContinuationIntent> {
  let intent = await authority.prepareInjection(intentMetadata);
  if (target === "prepared") return intent;
  intent = await authority.markInjectionEffectStarted({
    metadata: intentMetadata,
    expectedRevision: intent.revision,
  });
  if (target === "injectionEffectStarted") return intent;
  intent = await authority.settleInjectionApplied({
    metadata: intentMetadata,
    expectedRevision: intent.revision,
    exactReadbackDigest: intentMetadata.historyDigest,
  });
  if (target === "injected") return intent;
  intent = await authority.prepareContinueDispatch({
    metadata: intentMetadata,
    expectedRevision: intent.revision,
  });
  if (target === "continueDispatchPrepared") return intent;
  return await authority.markContinueDispatchEffectStarted({
    metadata: intentMetadata,
    expectedRevision: intent.revision,
    absenceProofDigest,
  });
}

describe("actor continuation SQLite intent authority v2", () => {
  test("derives one deterministic keyed identity from every private metadata field", async () => {
    const keys = new StrictDeterministicContextKeys();
    const identities = new HarnessActorContinuationIntentIdentityV2(keys);
    const original = metadata(1);
    const first = await identities.digest({ epochId, metadata: original });
    expect(first).toEqual(expectedIdentityDigests(original));
    expect(await identities.digest({ epochId, metadata: original }))
      .toEqual(first);

    const variants: PersistentActorContinuationIntentMetadata[] = [
      metadata(1, { actorId: "hactor_continuation_intent02" }),
      metadata(1, { actorTurnId: turnId(2) }),
      metadata(1, { clientUserMessageId: "client-continuation-message-other" }),
      metadata(1, { historyDigest: otherDigest }),
      metadata(1, { historyItemCount: 5 }),
      metadata(1, { historyUtf8Bytes: 322 }),
      metadata(1, { sourceAccountProfileId: "source-account-other" }),
      metadata(1, { sourceProcessGeneration: 18 }),
      metadata(1, { sourceProviderThreadId: "source-thread-other" }),
      metadata(1, { sourceProviderTurnId: "source-turn-other" }),
      metadata(1, { targetAccountProfileId: "target-account-other" }),
      metadata(1, { targetProcessGeneration: 24 }),
      metadata(1, { targetProviderThreadId: "target-thread-other" }),
    ];
    const variantDigests = await Promise.all(variants.map(
      async (variant) => await identities.digest({ epochId, metadata: variant }),
    ));
    expect(new Set([
      first.metadataDigest,
      ...variantDigests.map(({ metadataDigest }) => metadataDigest),
    ]).size).toBe(
      variants.length + 1,
    );
    for (const offset of [0, 1, 6, 7, 8, 9]) {
      expect(variantDigests[offset]!.sourceIdentityDigest)
        .not.toBe(first.sourceIdentityDigest);
    }
    for (const offset of [2, 3, 4, 5, 10, 11, 12]) {
      expect(variantDigests[offset]!.sourceIdentityDigest)
        .toBe(first.sourceIdentityDigest);
    }
    for (const offset of [0, 1, 2, 10, 11, 12]) {
      expect(variantDigests[offset]!.effectIdentityDigest)
        .not.toBe(first.effectIdentityDigest);
    }
    for (const offset of [3, 4, 5, 6, 7, 8, 9]) {
      expect(variantDigests[offset]!.effectIdentityDigest)
        .toBe(first.effectIdentityDigest);
    }
    expect(keys.scopes[0]).toEqual({
      epochId,
      ownerActorId: actorId,
      sourceTurnId: turnId(1),
    });
    expect(keys.scopes.at(-1)).toEqual({
      epochId,
      ownerActorId: actorId,
      sourceTurnId: turnId(1),
    });
    expect(identities.digest({
      epochId,
      metadata: metadata(1, { actorId: "../not-an-actor" }),
    })).rejects.toThrow("invalid key scope");
  });

  test("admits one CAS winner per effect stage and replays exact state after restart", async () => {
    const value = fixture();
    try {
      const intentMetadata = metadata(1);
      const firstAuthority = value.authority();
      const secondAuthority = value.authority();
      const concurrentPrepare = await Promise.all([
        firstAuthority.prepareInjection(intentMetadata),
        secondAuthority.prepareInjection(intentMetadata),
      ]);
      expect(concurrentPrepare[0]).toEqual(concurrentPrepare[1]);
      expect(concurrentPrepare[0]).toMatchObject({
        state: "prepared",
        revision: 1,
        exactReadbackDigest: null,
        absenceProofDigest: null,
        ambiguityCode: null,
      });
      expect(value.database.query(`
        SELECT COUNT(*) AS count FROM harness_actor_continuation_intents
      `).get()).toEqual({ count: 1 });

      let current = await oneCasWinner([
        async () => await firstAuthority.markInjectionEffectStarted({
          metadata: intentMetadata,
          expectedRevision: 1,
        }),
        async () => await secondAuthority.markInjectionEffectStarted({
          metadata: intentMetadata,
          expectedRevision: 1,
        }),
      ]);
      expect(current).toMatchObject({
        state: "injectionEffectStarted",
        revision: 2,
      });
      expect(await value.authority().readInjection({
        metadata: intentMetadata,
      })).toEqual(current);
      expect(value.authority().settleInjectionApplied({
        metadata: intentMetadata,
        expectedRevision: current.revision,
        exactReadbackDigest: otherDigest,
      })).rejects.toThrow("conflicts with durable evidence");

      current = await oneCasWinner([
        async () => await firstAuthority.settleInjectionApplied({
          metadata: intentMetadata,
          expectedRevision: current.revision,
          exactReadbackDigest: historyDigest,
        }),
        async () => await secondAuthority.settleInjectionApplied({
          metadata: intentMetadata,
          expectedRevision: current.revision,
          exactReadbackDigest: historyDigest,
        }),
      ]);
      expect(current).toMatchObject({
        state: "injected",
        revision: 3,
        exactReadbackDigest: historyDigest,
      });
      current = await oneCasWinner([
        async () => await firstAuthority.prepareContinueDispatch({
          metadata: intentMetadata,
          expectedRevision: current.revision,
        }),
        async () => await secondAuthority.prepareContinueDispatch({
          metadata: intentMetadata,
          expectedRevision: current.revision,
        }),
      ]);
      expect(current).toMatchObject({
        state: "continueDispatchPrepared",
        revision: 4,
      });
      expect(firstAuthority.markContinueDispatchEffectStarted({
        metadata: intentMetadata,
        expectedRevision: current.revision,
        absenceProofDigest: "not-a-digest",
      })).rejects.toThrow();
      current = await oneCasWinner([
        async () => await firstAuthority.markContinueDispatchEffectStarted({
          metadata: intentMetadata,
          expectedRevision: current.revision,
          absenceProofDigest,
        }),
        async () => await secondAuthority.markContinueDispatchEffectStarted({
          metadata: intentMetadata,
          expectedRevision: current.revision,
          absenceProofDigest,
        }),
      ]);
      expect(current).toMatchObject({
        state: "continueDispatchEffectStarted",
        revision: 5,
        exactReadbackDigest: historyDigest,
        absenceProofDigest,
      });
      const restarted = value.authority();
      expect(await restarted.readInjection({ metadata: intentMetadata }))
        .toEqual(current);
      expect(await restarted.prepareInjection(intentMetadata)).toEqual(current);
      expect(restarted.markContinueDispatchEffectStarted({
        metadata: intentMetadata,
        expectedRevision: current.revision,
        absenceProofDigest,
      })).rejects.toThrow("conflicts with durable evidence");
    } finally {
      value.database.close();
    }
  });

  test("fails closed on wrong private metadata, lineage, and history readback", async () => {
    const value = fixture();
    try {
      const authority = value.authority();
      const original = metadata(2);
      const prepared = await authority.prepareInjection(original);
      const changedEffects: PersistentActorContinuationIntentMetadata[] = [
        metadata(2, { clientUserMessageId: "client-message-wrong-private" }),
        metadata(2, { targetAccountProfileId: "wrong-target-account" }),
        metadata(2, { targetProcessGeneration: 10 }),
        metadata(2, { targetProviderThreadId: "wrong-target-thread" }),
      ];
      for (const variant of changedEffects) {
        expect(await authority.readInjection({ metadata: variant })).toBeNull();
        expect(authority.prepareInjection(variant)).rejects.toThrow(
          "conflicts with durable evidence",
        );
      }
      const changedSources: PersistentActorContinuationIntentMetadata[] = [
        metadata(2, { sourceAccountProfileId: "wrong-source-account" }),
        metadata(2, { sourceProcessGeneration: 9 }),
        metadata(2, { sourceProviderThreadId: "wrong-source-thread" }),
        metadata(2, { sourceProviderTurnId: "wrong-source-turn" }),
      ];
      for (const variant of changedSources) {
        expect(authority.readInjection({ metadata: variant })).rejects.toThrow(
          "conflicts with durable evidence",
        );
        expect(authority.prepareInjection(variant)).rejects.toThrow(
          "conflicts with durable evidence",
        );
      }
      expect(await authority.readInjection({ metadata: original })).toEqual(
        prepared,
      );
      expect(authority.prepareInjection(metadata(2, {
        sourceProviderThreadId: "bad\0thread",
      }))).rejects.toThrow();
      expect(authority.prepareInjection(metadata(2, {
        sourceAccountProfileId: "bad\0account",
      }))).rejects.toThrow();
      expect(authority.prepareInjection(metadata(2, {
        targetAccountProfileId: "bad\0account",
      }))).rejects.toThrow();
      expect(authority.prepareInjection(metadata(2, {
        actorId: "hactor_continuation_intent99",
      }))).rejects.toThrow();

      expect(authority.readInjection({
        metadata: metadata(2, { historyDigest: otherDigest }),
      })).rejects.toThrow("conflicts with durable evidence");
      expect(await authority.readInjection({ metadata: original }))
        .toMatchObject({
          state: "ambiguous",
          revision: 2,
          ambiguityCode: "history_identity_mismatch",
        });

      const readbackMetadata = metadata(10);
      await authority.prepareInjection(readbackMetadata);
      const started = await authority.markInjectionEffectStarted({
        metadata: readbackMetadata,
        expectedRevision: 1,
      });
      expect(authority.settleInjectionApplied({
        metadata: readbackMetadata,
        expectedRevision: started.revision,
        exactReadbackDigest: otherDigest,
      })).rejects.toThrow("conflicts with durable evidence");
      expect(await authority.readInjection({ metadata: readbackMetadata })).toEqual(
        started,
      );
      expect(value.database.query(`
        SELECT COUNT(*) AS count FROM harness_actor_continuation_intents
      `).get()).toEqual({ count: 2 });
    } finally {
      value.database.close();
    }
  });

  test("stores only opaque keyed evidence and makes its durable identity immutable", async () => {
    const value = fixture();
    try {
      const intentMetadata = metadata(3);
      const prepared = await value.authority().prepareInjection(intentMetadata);
      const row = value.database.query(`
        SELECT * FROM harness_actor_continuation_intents
        WHERE actor_turn_id = ?1
      `).get(intentMetadata.actorTurnId) as Record<string, unknown>;
      expect(Object.keys(row).sort()).toEqual([
        "absence_proof_digest",
        "actor_id",
        "actor_turn_id",
        "ambiguity_code",
        "created_at",
        "effect_identity_digest",
        "exact_readback_verified",
        "intent_id",
        "metadata_digest",
        "predecessor_intent_id",
        "recovery_proof_digest",
        "revision",
        "settled_at",
        "source_identity_digest",
        "state",
        "target_process_generation",
        "updated_at",
      ]);
      const expectedDigests = expectedIdentityDigests(intentMetadata);
      expect(row.source_identity_digest).toBe(
        expectedDigests.sourceIdentityDigest,
      );
      expect(row.effect_identity_digest).toBe(
        expectedDigests.effectIdentityDigest,
      );
      expect(row.metadata_digest).toBe(expectedDigests.metadataDigest);
      expect(row.metadata_digest).not.toBe(historyDigest);
      const persistedBytes = Buffer.from(value.database.serialize())
        .toString("latin1");
      for (const privateValue of [
        intentMetadata.clientUserMessageId,
        intentMetadata.historyDigest,
        intentMetadata.sourceAccountProfileId,
        intentMetadata.sourceProviderThreadId,
        intentMetadata.sourceProviderTurnId,
        intentMetadata.targetAccountProfileId,
        intentMetadata.targetProviderThreadId,
      ]) expect(persistedBytes.includes(privateValue)).toBeFalse();

      for (const mutation of [
        () => value.database.query(`
          UPDATE harness_actor_continuation_intents
          SET intent_id = ?2, state = 'injectionEffectStarted',
            revision = revision + 1, updated_at = '${deadline}'
          WHERE intent_id = ?1
        `).run(prepared.intentId, `hcontinuation_${otherDigest}`),
        () => value.database.query(`
          UPDATE harness_actor_continuation_intents
          SET actor_id = ?2, state = 'injectionEffectStarted',
            revision = revision + 1, updated_at = '${deadline}'
          WHERE intent_id = ?1
        `).run(prepared.intentId, "hactor_continuation_intent99"),
        () => value.database.query(`
          UPDATE harness_actor_continuation_intents
          SET actor_turn_id = ?2, state = 'injectionEffectStarted',
            revision = revision + 1, updated_at = '${deadline}'
          WHERE intent_id = ?1
        `).run(prepared.intentId, turnId(4)),
        () => value.database.query(`
          UPDATE harness_actor_continuation_intents
          SET source_identity_digest = ?2,
            state = 'injectionEffectStarted', revision = revision + 1,
            updated_at = '${deadline}' WHERE intent_id = ?1
        `).run(prepared.intentId, otherDigest),
        () => value.database.query(`
          UPDATE harness_actor_continuation_intents
          SET effect_identity_digest = ?2,
            state = 'injectionEffectStarted', revision = revision + 1,
            updated_at = '${deadline}' WHERE intent_id = ?1
        `).run(prepared.intentId, otherDigest),
        () => value.database.query(`
          UPDATE harness_actor_continuation_intents
          SET metadata_digest = ?2, state = 'injectionEffectStarted',
            revision = revision + 1, updated_at = '${deadline}'
          WHERE intent_id = ?1
        `).run(prepared.intentId, otherDigest),
        () => value.database.query(`
          UPDATE harness_actor_continuation_intents
          SET created_at = ?2, state = 'injectionEffectStarted',
            revision = revision + 1, updated_at = ?2
          WHERE intent_id = ?1
        `).run(prepared.intentId, deadline),
      ]) expect(mutation).toThrow("identity is immutable");
      expect(() => value.database.query(`
        INSERT INTO harness_actor_continuation_intents (
          intent_id, actor_id, actor_turn_id, source_identity_digest,
          effect_identity_digest, metadata_digest, state, revision,
          exact_readback_verified, absence_proof_digest, ambiguity_code,
          created_at, updated_at, settled_at
        ) VALUES (
          ?1, ?2, ?3, ?4, ?5, ?6, 'prepared', 1,
          0, NULL, NULL, ?7, ?7, NULL
        )
      `).run(
        `hcontinuation_${otherDigest}`,
        intentMetadata.actorId,
        intentMetadata.actorTurnId,
        "f".repeat(64),
        "9".repeat(64),
        "8".repeat(64),
        at,
      )).toThrow();
      expect(await value.authority().readInjection({
        metadata: intentMetadata,
      })).toEqual(prepared);
    } finally {
      value.database.close();
    }
  });

  test("fences ambiguity exactly once from every nonterminal stage", async () => {
    const value = fixture();
    try {
      const authority = value.authority();
      const stages = [
        "prepared",
        "injectionEffectStarted",
        "injected",
        "continueDispatchPrepared",
        "continueDispatchEffectStarted",
      ] as const;
      const codes = [
        "history_identity_mismatch",
        "injection_readback_mismatch",
        "history_identity_mismatch",
        "injection_readback_mismatch",
        "continue_definitively_absent_after_dispatch",
      ] as const;
      for (const [offset, stage] of stages.entries()) {
        const intentMetadata = metadata(offset + 4);
        const before = await advanceTo(authority, intentMetadata, stage);
        const fenced = await authority.fenceInjectionAmbiguous({
          metadata: intentMetadata,
          expectedRevision: before.revision,
          proofCode: codes[offset]!,
        });
        expect(fenced).toMatchObject({
          state: "ambiguous",
          revision: before.revision + 1,
          exactReadbackDigest: before.exactReadbackDigest,
          absenceProofDigest: before.absenceProofDigest,
          ambiguityCode: codes[offset],
        });
        expect(authority.fenceInjectionAmbiguous({
          metadata: intentMetadata,
          expectedRevision: before.revision,
          proofCode: codes[offset]!,
        })).rejects.toThrow("conflicts with durable evidence");
        expect(authority.markInjectionEffectStarted({
          metadata: intentMetadata,
          expectedRevision: fenced.revision,
        })).rejects.toThrow("conflicts with durable evidence");
        expect(await value.authority().readInjection({
          metadata: intentMetadata,
        })).toEqual(fenced);
      }
    } finally {
      value.database.close();
    }
  });

  test("rejects illegal transitions and duplicate sources while allowing a distinct next hop", async () => {
    const value = fixture();
    try {
      const authority = value.authority();
      const intentMetadata = metadata(9);
      const prepared = await authority.prepareInjection(intentMetadata);
      expect(authority.settleInjectionApplied({
        metadata: intentMetadata,
        expectedRevision: prepared.revision,
        exactReadbackDigest: historyDigest,
      })).rejects.toThrow("conflicts with durable evidence");
      expect(authority.prepareContinueDispatch({
        metadata: intentMetadata,
        expectedRevision: prepared.revision,
      })).rejects.toThrow("conflicts with durable evidence");
      expect(authority.markContinueDispatchEffectStarted({
        metadata: intentMetadata,
        expectedRevision: prepared.revision,
        absenceProofDigest,
      })).rejects.toThrow("conflicts with durable evidence");
      expect(() => value.database.query(`
        UPDATE harness_actor_continuation_intents SET
          state = 'injected', revision = revision + 1,
          exact_readback_verified = 1, updated_at = ?2
        WHERE intent_id = ?1
      `).run(prepared.intentId, deadline)).toThrow("transition is incoherent");
      expect(() => value.database.query(`
        UPDATE harness_actor_continuation_intents SET
          state = 'ambiguous', revision = revision + 1,
          exact_readback_verified = 1, absence_proof_digest = ?2,
          ambiguity_code = 'history_identity_mismatch',
          updated_at = ?3, settled_at = ?3
        WHERE intent_id = ?1
      `).run(prepared.intentId, absenceProofDigest, deadline)).toThrow(
        "transition is incoherent",
      );
      expect(() => value.database.query(`
        DELETE FROM harness_actor_continuation_intents
        WHERE intent_id = ?1
      `).run(prepared.intentId)).toThrow("evidence is append-only");

      expect(authority.prepareInjection(metadata(9, {
        targetAccountProfileId: "same-source-different-target",
        targetProviderThreadId: "same-source-different-target-thread",
      }))).rejects.toThrow("conflicts with durable evidence");
      expect(await authority.readInjection({ metadata: intentMetadata }))
        .toEqual(prepared);

      const nextHop = metadata(9, {
        clientUserMessageId: "client-continuation-next-hop",
        sourceAccountProfileId: intentMetadata.targetAccountProfileId,
        sourceProcessGeneration: intentMetadata.targetProcessGeneration,
        sourceProviderThreadId: intentMetadata.targetProviderThreadId,
        sourceProviderTurnId: "raw-next-hop-provider-turn-private",
        targetAccountProfileId: "raw-third-account-private",
        targetProcessGeneration: 29,
        targetProviderThreadId: "raw-third-provider-thread-private",
      });
      expect(await authority.prepareInjection(nextHop)).toMatchObject({
        actorTurnId: intentMetadata.actorTurnId,
        state: "prepared",
        revision: 1,
      });
      expect(value.database.query(`
        SELECT COUNT(*) AS count FROM harness_actor_continuation_intents
        WHERE actor_turn_id = ?1
      `).get(intentMetadata.actorTurnId)).toEqual({ count: 2 });
    } finally {
      value.database.close();
    }
  });

  test("atomically advances one source lineage across N to N+1 to N+2", async () => {
    const value = fixture();
    try {
      const authority = value.authority();
      const generationN = metadata(11, { targetProcessGeneration: 23 });
      const generationN1 = metadata(11, { targetProcessGeneration: 24 });
      const generationN2 = metadata(11, { targetProcessGeneration: 25 });

      const injectionOwned = await advanceTo(
        authority,
        generationN,
        "injectionEffectStarted",
      );
      const firstRecovery = await authority.supersedeForRecovery({
        predecessorMetadata: generationN,
        expectedRevision: injectionOwned.revision,
        recoveryProofDigest: recoveryProofOne,
        predecessorState: "supersededApplied",
        successorMetadata: generationN1,
        successorHistoryApplied: true,
      });
      expect(firstRecovery.predecessor).toMatchObject({
        state: "supersededApplied",
        revision: 3,
        recoveryProofDigest: recoveryProofOne,
      });
      expect(firstRecovery.successor).toMatchObject({
        state: "injected",
        revision: 3,
        predecessorIntentId: firstRecovery.predecessor.intentId,
        recoveryProofDigest: recoveryProofOne,
        exactReadbackDigest: historyDigest,
        targetProcessGeneration: 24,
      });
      if (firstRecovery.successor === null) {
        throw new Error("first recovery did not install its successor");
      }

      const continuePrepared = await authority.prepareContinueDispatch({
        metadata: generationN1,
        expectedRevision: firstRecovery.successor.revision,
      });
      const secondRecovery = await authority.supersedeForRecovery({
        predecessorMetadata: generationN1,
        expectedRevision: continuePrepared.revision,
        recoveryProofDigest: recoveryProofTwo,
        predecessorState: "supersededApplied",
        successorMetadata: generationN2,
        successorHistoryApplied: true,
      });
      expect(secondRecovery.predecessor).toMatchObject({
        state: "supersededApplied",
        recoveryProofDigest: recoveryProofTwo,
      });
      expect(secondRecovery.successor).toMatchObject({
        state: "injected",
        revision: 3,
        predecessorIntentId: secondRecovery.predecessor.intentId,
        recoveryProofDigest: recoveryProofTwo,
        targetProcessGeneration: 25,
      });
      if (secondRecovery.successor === null) {
        throw new Error("second recovery did not install its successor");
      }

      const thirdPrepared = await authority.prepareContinueDispatch({
        metadata: generationN2,
        expectedRevision: secondRecovery.successor.revision,
      });
      const thirdOwned = await authority.markContinueDispatchEffectStarted({
        metadata: generationN2,
        expectedRevision: thirdPrepared.revision,
        absenceProofDigest,
      });
      const terminal = await authority.supersedeForRecovery({
        predecessorMetadata: generationN2,
        expectedRevision: thirdOwned.revision,
        recoveryProofDigest: recoveryProofThree,
        predecessorState: "supersededApplied",
        successorMetadata: null,
        successorHistoryApplied: false,
      });
      expect(terminal.successor).toBeNull();
      expect(terminal.predecessor).toMatchObject({
        state: "supersededApplied",
        revision: 6,
        recoveryProofDigest: recoveryProofThree,
        absenceProofDigest,
      });

      expect(await authority.readLatestInjection({
        metadata: metadata(11, { targetProcessGeneration: 99 }),
      })).toEqual(terminal.predecessor);
      const rows = value.database.query(`
        SELECT target_process_generation, state, predecessor_intent_id,
          recovery_proof_digest, exact_readback_verified
        FROM harness_actor_continuation_intents
        WHERE actor_turn_id = ?1
        ORDER BY target_process_generation
      `).all(turnId(11));
      expect(rows).toEqual([
        {
          target_process_generation: 23,
          state: "supersededApplied",
          predecessor_intent_id: null,
          recovery_proof_digest: recoveryProofOne,
          exact_readback_verified: 0,
        },
        {
          target_process_generation: 24,
          state: "supersededApplied",
          predecessor_intent_id: firstRecovery.predecessor.intentId,
          recovery_proof_digest: recoveryProofTwo,
          exact_readback_verified: 1,
        },
        {
          target_process_generation: 25,
          state: "supersededApplied",
          predecessor_intent_id: secondRecovery.predecessor.intentId,
          recovery_proof_digest: recoveryProofThree,
          exact_readback_verified: 1,
        },
      ]);
      expect(value.database.query(`
        SELECT COUNT(*) AS count
        FROM harness_actor_continuation_intents
        WHERE state IN (
          'prepared', 'injectionEffectStarted', 'injected',
          'continueDispatchPrepared', 'continueDispatchEffectStarted'
        )
      `).get()).toEqual({ count: 0 });
      expect(authority.supersedeForRecovery({
        predecessorMetadata: generationN2,
        expectedRevision: thirdOwned.revision,
        recoveryProofDigest: recoveryProofThree,
        predecessorState: "supersededApplied",
        successorMetadata: null,
        successorHistoryApplied: false,
      })).rejects.toThrow("conflicts with durable evidence");
      expect(value.database.query(`
        SELECT COUNT(*) AS count FROM harness_actor_continuation_intents
      `).get()).toEqual({ count: 3 });
    } finally {
      value.database.close();
    }
  });

  test("rolls back a recovery unless its successor is strictly newer and coherent", async () => {
    const value = fixture();
    try {
      const authority = value.authority();
      const predecessorMetadata = metadata(12, { targetProcessGeneration: 23 });
      const predecessor = await authority.prepareInjection(predecessorMetadata);
      for (const targetProcessGeneration of [22, 23]) {
        expect(authority.supersedeForRecovery({
          predecessorMetadata,
          expectedRevision: predecessor.revision,
          recoveryProofDigest: recoveryProofOne,
          predecessorState: "supersededNotApplied",
          successorMetadata: metadata(12, { targetProcessGeneration }),
          successorHistoryApplied: false,
        })).rejects.toThrow("conflicts with durable evidence");
      }
      expect(authority.supersedeForRecovery({
        predecessorMetadata,
        expectedRevision: predecessor.revision,
        recoveryProofDigest: recoveryProofOne,
        predecessorState: "supersededApplied",
        successorMetadata: null,
        successorHistoryApplied: true,
      })).rejects.toThrow("conflicts with durable evidence");
      expect(await authority.readInjection({ metadata: predecessorMetadata }))
        .toEqual(predecessor);
      expect(value.database.query(`
        SELECT COUNT(*) AS count FROM harness_actor_continuation_intents
      `).get()).toEqual({ count: 1 });
    } finally {
      value.database.close();
    }
  });

  test("admits one atomic successor winner under concurrent recovery", async () => {
    const value = fixture();
    try {
      const first = value.authority();
      const second = value.authority();
      const predecessorMetadata = metadata(12, { targetProcessGeneration: 23 });
      const successorMetadata = metadata(12, { targetProcessGeneration: 24 });
      const predecessor = await first.prepareInjection(predecessorMetadata);
      const recover = async (
        authority: PersistentActorContinuationSQLiteAuthorityV2,
      ) => await authority.supersedeForRecovery({
        predecessorMetadata,
        expectedRevision: predecessor.revision,
        recoveryProofDigest: recoveryProofOne,
        predecessorState: "supersededNotApplied",
        successorMetadata,
        successorHistoryApplied: false,
      });
      const outcomes = await Promise.allSettled([
        recover(first),
        recover(second),
      ]);
      expect(outcomes.filter(({ status }) => status === "fulfilled"))
        .toHaveLength(1);
      expect(outcomes.filter(({ status }) => status === "rejected"))
        .toHaveLength(1);
      expect(await value.authority().readLatestInjection({
        metadata: successorMetadata,
      })).toMatchObject({
        state: "prepared",
        targetProcessGeneration: 24,
        predecessorIntentId: predecessor.intentId,
      });
      expect(value.database.query(`
        SELECT COUNT(*) AS count FROM harness_actor_continuation_intents
      `).get()).toEqual({ count: 2 });
      expect(value.database.query(`
        SELECT COUNT(*) AS count FROM harness_actor_continuation_intents
        WHERE state = 'prepared'
      `).get()).toEqual({ count: 1 });
    } finally {
      value.database.close();
    }
  });

  test("property: arbitrary restart chains retain one live owner and immutable ancestry", async () => {
    await assertAsyncProperty(fc.asyncProperty(
      fc.array(fc.record({
        generationIncrement: fc.integer({ min: 1, max: 4 }),
        historyApplied: fc.boolean(),
      }), { minLength: 1, maxLength: 5 }),
      async (steps) => {
        const value = fixture();
        try {
          let generation = 23;
          let currentMetadata = metadata(1, {
            targetProcessGeneration: generation,
          });
          let current = await value.authority().prepareInjection(currentMetadata);
          const ancestry: string[] = [current.intentId];
          for (const [index, step] of steps.entries()) {
            generation += step.generationIncrement;
            const successorMetadata = metadata(1, {
              targetProcessGeneration: generation,
            });
            const proof = createHash("sha256").update(JSON.stringify([
              "continuation-property-recovery",
              index,
              current.intentId,
              generation,
              step.historyApplied,
            ])).digest("hex");
            const recovered = await value.authority().supersedeForRecovery({
              predecessorMetadata: currentMetadata,
              expectedRevision: current.revision,
              recoveryProofDigest: proof,
              predecessorState: step.historyApplied
                ? "supersededApplied"
                : "supersededNotApplied",
              successorMetadata,
              successorHistoryApplied: step.historyApplied,
            });
            expect(recovered.successor).not.toBeNull();
            if (recovered.successor === null) {
              throw new Error("property recovery did not create a successor");
            }
            expect(recovered.successor.predecessorIntentId)
              .toBe(recovered.predecessor.intentId);
            expect(recovered.successor.recoveryProofDigest).toBe(proof);
            expect(recovered.successor.state)
              .toBe(step.historyApplied ? "injected" : "prepared");
            ancestry.push(recovered.successor.intentId);
            currentMetadata = successorMetadata;
            current = recovered.successor;
            expect(await value.authority().readLatestInjection({
              metadata: metadata(1, {
                targetProcessGeneration: generation + 100,
              }),
            })).toEqual(current);
          }
          expect(new Set(ancestry).size).toBe(ancestry.length);
          expect(value.database.query(`
            SELECT COUNT(*) AS count FROM harness_actor_continuation_intents
          `).get()).toEqual({ count: steps.length + 1 });
          expect(value.database.query(`
            SELECT COUNT(*) AS count
            FROM harness_actor_continuation_intents
            WHERE state IN (
              'prepared', 'injectionEffectStarted', 'injected',
              'continueDispatchPrepared', 'continueDispatchEffectStarted'
            )
          `).get()).toEqual({ count: 1 });
        } finally {
          value.database.close();
        }
      },
    ), {
      numRuns: 50,
      interruptAfterTimeLimit: SQLITE_PROPERTY_INTERRUPT_AFTER_TIME_LIMIT,
    });
  }, SQLITE_PROPERTY_TIMEOUT);

  test("fails closed when keyed identity custody is unavailable or malformed", () => {
    const database = openDatabase(1);
    try {
      const unavailable = new PersistentActorContinuationSQLiteAuthorityV2(
        database,
        {
          identities: {
            digest: () => Promise.reject(new Error("keychain unavailable")),
          },
        },
      );
      expect(unavailable.prepareInjection(metadata(1))).rejects.toThrow(
        "identity custody is unavailable",
      );
      const malformed = new PersistentActorContinuationSQLiteAuthorityV2(
        database,
        {
          identities: {
            digest: () => Promise.resolve({
              sourceIdentityDigest: "not-a-digest",
              effectIdentityDigest: "not-a-digest",
              metadataDigest: "not-a-digest",
            }),
          },
        },
      );
      expect(malformed.prepareInjection(metadata(1))).rejects.toThrow(
        "identity custody is unavailable",
      );
      expect(database.query(`
        SELECT COUNT(*) AS count FROM harness_actor_continuation_intents
      `).get()).toEqual({ count: 0 });
    } finally {
      database.close();
    }
  });
});
