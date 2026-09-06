import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

import { canonical41TimestampsDatabaseBytes, canonical41TimestampsFixture, canonical41TimestampsGeneratorSource } from "../../scripts/fixtures/canonical41-timestamps";
import { canonical43MemoryDatabaseBytes, canonical43MemoryFixture, canonical43MemoryGeneratorSource } from "../../scripts/fixtures/canonical43-memory";

// These are archive-inspection tests, not current StateStore migration tests.
// Generator strings are hashed as inert data; no archived code is executed.
const hash = (value: string | Uint8Array): string => createHash("sha256").update(value).digest("hex");
const rowSchema = z.record(z.string(), z.unknown());
type Row = z.infer<typeof rowSchema>;
const equal = (actual: unknown, expected: unknown): void => { expect(actual).toEqual(expected); };
const sorted = <T>(values: readonly T[]): T[] => [...values].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
const queryRows = (database: Database, sql: string): Row[] => {
  const statement = database.prepare(sql);
  try { return z.array(rowSchema).parse(statement.all()); }
  finally { statement.finalize(); }
};
const snapshot = (database: Database) => {
  const tables = z.array(z.object({ name: z.string().regex(/^[A-Za-z0-9_]+$/u) }).strict()).parse(
    queryRows(database, "SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name LIMIT 513"),
  );
  expect(tables.length).toBeLessThanOrEqual(512);
  const rows: Record<string, Row[]> = {};
  for (const { name } of tables) {
    const values = queryRows(database, `SELECT * FROM "${name}" LIMIT 4097`);
    expect(values.length).toBeLessThanOrEqual(4096);
    rows[name] = sorted(values);
  }
  const schema = queryRows(database, "SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name LIMIT 4097");
  expect(schema.length).toBeLessThanOrEqual(4096);
  const value = {
    schemaVersion: z.object({ user_version: z.number().int() }).strict().parse(database.query("PRAGMA user_version").get()).user_version,
    schema,
    migrations: queryRows(database, "SELECT version,applied_at FROM migrations ORDER BY version"),
    rows,
    queueColumns: queryRows(database, "PRAGMA table_info(queue_entries)"),
    foreignKeyCheck: queryRows(database, "PRAGMA foreign_key_check"),
    inspectionChanges: database.query("SELECT total_changes() AS count").get(),
  };
  expect(database.query("PRAGMA encoding").get()).toEqual({ encoding: "UTF-8" });
  expect(value.foreignKeyCheck).toEqual([]);
  expect(value.inspectionChanges).toEqual({ count: 0 });
  expect(Buffer.byteLength(JSON.stringify(value))).toBeLessThanOrEqual(16 * 1024 * 1024);
  return value;
};
type Snapshot = ReturnType<typeof snapshot>;
const rows = (captured: Snapshot, table: string): Row[] => {
  const value = captured.rows[table];
  if (value === undefined) throw new Error(`Missing historical fixture table: ${table}`);
  return value;
};
const one = (captured: Snapshot, table: string, key: string, value: string | number): Row => {
  const matches = rows(captured, table).filter((row) => row[key] === value);
  expect(matches).toHaveLength(1);
  const result = matches[0];
  if (result === undefined) throw new Error(`Missing historical fixture row: ${table}`);
  return result;
};
const json = (value: unknown): Row => rowSchema.parse(JSON.parse(z.string().parse(value)) as unknown);

type ArchiveIdentity = Readonly<{
  schemaVersion: number; databaseBytes: number; databaseSha256: string; generatorSha256: string;
  migrations: readonly Readonly<{ version: number; applied_at: number }>[];
  timestampGuard: Readonly<{ type: string; name: string; tbl_name: string; sql: string }>;
  timestampGuardSha256: string;
}>;
const inspectArchive = async (
  bytes: Uint8Array,
  fixture: ArchiveIdentity,
  generator: string,
  inspect: (captured: Snapshot) => void,
): Promise<void> => {
  expect(bytes.byteLength).toBe(fixture.databaseBytes);
  expect(hash(bytes)).toBe(fixture.databaseSha256);
  expect(hash(generator)).toBe(fixture.generatorSha256);
  const directory = await realpath(await mkdtemp(join(tmpdir(), "hra-canonical-history-")));
  await chmod(directory, 0o700);
  const path = join(directory, "archive.sqlite");
  let initializer: Database | undefined;
  try {
    await writeFile(path, bytes, { mode: 0o600, flag: "wx" });
    // A retained WAL-mode main image needs sidecars for a readonly open.
    // This query-only holder initializes them without touching stored rows.
    initializer = new Database(path, { create: false, strict: true });
    initializer.exec("PRAGMA query_only=ON");
    initializer.query("SELECT name FROM sqlite_schema LIMIT 1").all();
    let original: Snapshot | undefined;
    for (let opening = 0; opening < 2; opening++) {
      const database = new Database(path, { readonly: true, strict: true });
      try {
        const captured = snapshot(database);
        expect(captured.schemaVersion).toBe(fixture.schemaVersion);
        equal(captured.migrations, [...fixture.migrations].sort((a, b) => a.version - b.version));
        equal(captured.migrations.map((row) => row.version), Array.from({ length: fixture.schemaVersion }, (_, index) => index + 1));
        const guards = captured.schema.filter((row) => row.name === "mutation_resolutions_timestamp_proof_insert");
        equal(guards, [fixture.timestampGuard]);
        expect(hash(z.string().parse(guards[0]?.sql))).toBe(fixture.timestampGuardSha256);
        expect(fixture.timestampGuardSha256).toBe("58bf7130250f47f8cae27ba0e58057df1483b0b325e988e0116c2512d40acd8d");
        expect(one(captured, "notification_hours", "singleton", 1).time_zone).toBe("UTC");
        if (original === undefined) {
          original = captured;
          inspect(captured);
        } else equal(captured, original);
        // All tables, internal tables, DDL and the ledger are compared again.
        equal(snapshot(database), captured);
      } finally { database.close(false); }
      expect(hash(await readFile(path))).toBe(fixture.databaseSha256);
    }
    expect(initializer.query("SELECT total_changes() AS count").get()).toEqual({ count: 0 });
  } finally {
    initializer?.close(false);
    await rm(directory, { recursive: true, force: true });
  }
};

test("authentic canonical41 retains six timestamp preimages and only the two marked resolutions without writes", async () => {
  const fixture = canonical41TimestampsFixture;
  expect(fixture.sourceRevision).toBe("576ccd76a6742cd62759ab6176a6a41844846daa");
  expect(fixture.sourceTree).toBe("a410268ccca4f5f6096a97b63d06652153d196be");
  expect(fixture.databaseSha256).toBe("ad4842496d9ee5f8d51210ef9a99e255d76e6c42505cc3f6e996c919b2caa106");
  expect(fixture.generatorSha256).toBe("6fb00eeb88e06436d6c35a77863585021a1c4e9badf3353c0b817c79a2e25456");
  expect(fixture.provenance).toMatchObject({ bunVersion: "1.3.14", timeZone: "UTC", dependency: { name: "zod", version: "4.4.3" },
    syntheticOnly: true, providerProcessesInvoked: false, rawSqlWrites: false,
    unusedUsageRevisionReservationPerProfile: 1, quotaObservations: 0, deterministicDatabaseBytes: false });
  expect(fixture.nativeProviderAcceptance).toBe(false);
  expect(fixture.currentSchemaCompatibilityProved).toBe(false);
  await inspectArchive(canonical41TimestampsDatabaseBytes(), fixture, canonical41TimestampsGeneratorSource, (captured) => {
    equal(rows(captured, "notification_hours"), fixture.notificationHours);
    equal(rows(captured, "attention_email_policy"), fixture.attentionEmailPolicy);
    equal(rows(captured, "mutation_effect_evidence"), sorted(fixture.effects));
    equal(rows(captured, "mutation_resolutions"), sorted(fixture.resolutions));
    expect(fixture.effects).toHaveLength(6);
    expect(fixture.resolutions).toHaveLength(2);
    expect(Object.keys(fixture.scenarios)).toHaveLength(6);
    expect(fixture.rawTimestamp).toBe(1_700_000_000);

    for (const [name, scenario] of Object.entries(fixture.scenarios)) {
      const effect = one(captured, "mutation_effect_evidence", "attempt_id", scenario.attemptId);
      const evidence = scenario.originalEffect.evidence;
      expect(effect.evidence_json).toBe(JSON.stringify(evidence));
      equal(hash(z.string().parse(effect.evidence_json)), effect.evidence_digest);
      expect(effect.evidence_digest).toBe(scenario.originalEffect.digest);
      expect(evidence.baseline.providerUpdatedAt).toBe(fixture.rawTimestamp);
      const request = evidence.kind === "session.stop" ? { activeTurnId: evidence.activeTurnId } : { name: evidence.requestedName };
      const requestDigest = hash(JSON.stringify({ kind: evidence.kind, authorityId: scenario.sessionId,
        authorityGeneration: scenario.finalMutation.authorityGeneration, request }));
      expect(one(captured, "mutation_attempts", "id", scenario.attemptId)).toMatchObject({
        idempotency_key: scenario.idempotencyKey, kind: evidence.kind, authority_id: scenario.sessionId,
        authority_generation: scenario.finalMutation.authorityGeneration, request_digest: requestDigest,
        state: "ambiguous", result_json: JSON.stringify({ code: "SYNTHETIC_LOST_RESPONSE" }),
      });
      expect(requestDigest).toBe(scenario.finalMutation.requestDigest);
      const session = one(captured, "sessions", "id", scenario.sessionId);
      expect(session).toMatchObject({ profile_id: scenario.originalSession.profileId,
        provider_thread_id: evidence.providerThreadId, provider_updated_at: scenario.finalSession.providerUpdatedAt,
        title: scenario.finalSession.title, state: scenario.finalSession.state, revision: scenario.finalSession.revision,
        created_at: scenario.originalSession.createdAt, updated_at: scenario.finalSession.updatedAt });
      const resolutions = rows(captured, "mutation_resolutions").filter((row) => row.attempt_id === scenario.attemptId);
      if ("resolution" in scenario.finalMutation) {
        const resolution = scenario.finalMutation.resolution;
        expect(name.endsWith("-marked_resolved")).toBe(true);
        equal(resolutions, [{ attempt_id: scenario.attemptId, resolution_kind: "proven_applied",
          evidence_json: JSON.stringify(resolution.evidence), receipt_json: JSON.stringify(resolution.receipt),
          created_at: resolution.createdAt }]);
        expect(resolution.evidence.providerTimestampUnit).toBe("unix_milliseconds_v1");
        equal(resolution.evidence.providerUpdatedAt, fixture.rawTimestamp + 1);
        expect(session.state).toBe("idle");
      } else {
        expect(resolutions).toEqual([]);
        expect(session.provider_updated_at).toBe(fixture.rawTimestamp);
        expect(session.state).toBe("recovery_required");
      }
      if (name.endsWith("-legacy_unmarked")) {
        expect(Object.hasOwn(evidence, "providerTimestampUnit")).toBe(false);
        expect(json(effect.evidence_json).providerTimestampUnit).toBeUndefined();
      } else expect(json(effect.evidence_json).providerTimestampUnit).toBe("unix_milliseconds_v1");
    }
    // The captured generator exercised these refusals and checked every row
    // before/after. Here we inspect their retained no-resolution outcome only.
    equal(fixture.rejectedLegacyProofs, { "stop-legacy_unmarked": "MUTATION_RECOVERY_TIMESTAMP_PROOF_INVALID",
      "rename-legacy_unmarked": "MUTATION_RECOVERY_TIMESTAMP_PROOF_INVALID" });
    const queue = [...rows(captured, "queue_entries")].sort((a, b) => z.number().parse(a.enqueue_sequence) - z.number().parse(b.enqueue_sequence));
    equal(queue.map((row) => ({ id: row.id, message: row.message, state: row.state, sequence: row.enqueue_sequence })),
      [fixture.queue.first, fixture.queue.second].map((entry, index) => ({ id: entry.id, message: entry.message, state: "pending", sequence: index + 1 })));
    expect(rows(captured, "profiles")).toHaveLength(2);
    expect(rows(captured, "session_provider_account_authorities")).toHaveLength(7);
    for (const profile of fixture.profiles) {
      expect(one(captured, "usage_revision_authority", "profile_id", profile.id).next_revision).toBe(2);
      expect(one(captured, "profiles", "id", profile.id)).toMatchObject({ state: "signed_in", process_generation: 1 });
    }
    for (const table of ["usage_snapshots", "usage_poll_failures", "usage_cloud_upload_anchors", "queue_effect_evidence"]) {
      expect(rows(captured, table)).toEqual([]);
    }
  });
});

test("authentic canonical43 retains human FIFO, peer policy and only reserved prepared allocating memory history", async () => {
  const fixture = canonical43MemoryFixture;
  expect(fixture.sourceRevision).toBe("eaf0448e19383ac899c30d0a9cd70bbea71ff8b3");
  expect(fixture.sourceTree).toBe("5ce8a9dd0c21fe47d5724b4fc4760380aaaf6100");
  expect(fixture.databaseSha256).toBe("046f5ede0c377a0db943206e09b6dfbee5e8aa0a55d90e06f98e0faf6f9ffeb5");
  expect(fixture.generatorSha256).toBe("9cf4dc9b20858d5f7bf0511e56d1643b493b47883e7c254e905cafcfe7399499");
  expect(fixture).toMatchObject({ bunVersion: "1.3.14", timeZone: "UTC", fixedTime: 43001,
    syntheticOnly: true, nativeProviderEffects: 0, networkEffects: 0, physicalMemoryInitialization: false,
    hostToolExecution: false, peerActionsExecuted: false, rawSqlRowOrSchemaWrites: false });
  expect(fixture.dependencies).toMatchObject({ "@hraness/oh": "0.4.1", effect: "3.22.1", zod: "4.4.3" });
  await inspectArchive(canonical43MemoryDatabaseBytes(), fixture, canonical43MemoryGeneratorSource, (captured) => {
    equal(captured.schema, fixture.schema);
    equal(captured.rows, fixture.rows);
    equal(captured.queueColumns, fixture.queueColumns);
    equal(rows(captured, "notification_hours"), fixture.notificationHours);
    equal(rows(captured, "attention_email_policy"), fixture.attentionEmailPolicy);
    equal(captured.migrations, Array.from({ length: 43 }, (_, index) => ({ version: index + 1, applied_at: fixture.fixedTime })));
    const observed = fixture.observations;
    expect(one(captured, "projects", "id", observed.project.id).root_path).toBe(fixture.publicFixtureProjectRoot);
    expect(observed.unusedUsageRevision).toBe(1);
    equal(rows(captured, "usage_revision_authority"), [{ profile_id: observed.profile.id, next_revision: 2 }]);
    for (const policy of observed.policies) {
      expect(one(captured, "session_peer_policies", "session_id", policy.sessionId)).toMatchObject({ mode: policy.mode, revision: 2 });
    }
    equal(observed.policies.map((policy) => policy.mode), ["inspect", "off"]);
    expect(one(captured, "session_host_capability_bindings", "session_id", observed.hostCapabilities.sessionId)).toMatchObject({
      preamble_digest: observed.hostCapabilities.preambleDigest, manifest_digest: observed.hostCapabilities.manifestDigest,
    });
    const queue = [...rows(captured, "queue_entries")].sort((a, b) => z.number().parse(a.enqueue_sequence) - z.number().parse(b.enqueue_sequence));
    equal(queue.map((row) => ({ id: row.id, message: row.message, sequence: row.enqueue_sequence,
      actor: row.message_actor, peer: row.peer_action_id, state: row.state })), observed.queue.map((entry, index) => ({
      id: entry.id, message: entry.message, sequence: index + 1, actor: "human", peer: null, state: "pending",
    })));
    expect(one(captured, "project_memory_authorities", "project_id", observed.project.id)).toMatchObject({
      identity_contract: 2, physical_state: "reserved", initialized_at: null,
      authority_digest: observed.canonicalIdentity.authorityDigest, binding_digest: observed.canonicalIdentity.bindingDigest,
      head_sequence: 0, head_operation_sha256: null, head_digest: observed.memoryAuthority.head.headDigest,
      revision: 1, sync_state: "local_only", last_exchange_at: null,
    });
    expect(one(captured, "memory_submissions", "id", observed.memorySubmission.id)).toMatchObject({
      state: "prepared", kind: "remember", request_digest: observed.memorySubmission.requestDigest,
      content_digest: hash("Synthetic pending local memory request."), key_digest: hash("fixture:pending"),
      working_binding_digest: observed.workingBinding.bindingDigest, working_epoch: 1,
      expected_head_sequence: 0, expected_head_operation_sha256: null,
      effect_record_sha256: null, attestation_sha256: null, operation_id: null, receipt_digest: null,
      result_head_sequence: null, result_head_operation_sha256: null, result_head_digest: null,
    });
    equal(observed.memorySubmission.requestDigest, hash(JSON.stringify({ kind: "remember", key: "fixture:pending", content: "Synthetic pending local memory request." })));
    expect(one(captured, "project_memory_hosted_create_intents", "id", observed.hostedCreate.id)).toMatchObject({
      state: "allocating", project_id: observed.project.id, canonical_binding_digest: observed.canonicalIdentity.bindingDigest,
      authority_revision: 1, authority_head_sequence: 0, authority_head_operation_sha256: null,
      remote_space_id: observed.hostedCreate.remoteSpaceId, genesis_token: null, request_digest: null,
      effect_started_at: null, winner_digest: null, settled_at: null,
    });
    for (const table of ["mutation_effect_evidence", "mutation_resolutions", "queue_effect_evidence", "peer_session_actions",
      "usage_snapshots", "usage_poll_failures", "usage_cloud_upload_anchors", "memory_page_attestations", "memory_page_attestation_refs",
      "memory_working_attestation_heads", "memory_working_attestation_forks", "project_memory_hosted_attachments",
      "project_memory_sync_intents", "project_memory_sync_spool", "project_memory_portable_adoption_proofs"]) {
      expect(rows(captured, table)).toEqual([]);
    }
    expect(rows(captured, "mutation_attempts")).toHaveLength(2);
    expect(rows(captured, "mutation_attempts").every((row) => row.kind === "session.queue" && row.state === "applied")).toBe(true);
  });
});
