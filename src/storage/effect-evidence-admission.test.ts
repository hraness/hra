import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

import { mutationEffectEvidence49Schema } from "./effect-evidence-codecs";
import { initializeStatePaths, resolveStatePaths } from "./paths";
import { StateStore } from "./state-store";

const recordedAt = 1_900_000_000_000;
const options = { now: () => recordedAt, resolveMachineTimeZone: () => "UTC" };
const hash = (value: string | Uint8Array): string => createHash("sha256").update(value).digest("hex");
const rowSchema = z.record(z.string(), z.unknown());
const evidenceRowSchema = z.object({
  attempt_id: z.string(),
  kind: z.string(),
  evidence_json: z.string(),
  evidence_digest: z.string(),
  recorded_at: z.number(),
}).strict();
type GenericKind = "session.stop" | "session.rename";
type GenericEvidence = Extract<
  Parameters<StateStore["beginSessionMutationEffect"]>[0]["evidence"],
  { kind: GenericKind }
>;

const snapshot = (database: Database) => {
  const tables = z.object({ name: z.string().regex(/^[a-z][a-z0-9_]*$/u) }).strict().array().parse(
    database.query("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name LIMIT 513").all(),
  );
  expect(tables.length).toBeLessThanOrEqual(512);
  const rows: Record<string, z.infer<typeof rowSchema>[]> = {};
  for (const { name } of tables) {
    const values = rowSchema.array().parse(database.query(`SELECT * FROM "${name}" LIMIT 4097`).all());
    expect(values.length).toBeLessThanOrEqual(4096);
    rows[name] = values.sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  }
  const value = {
    version: database.query("PRAGMA user_version").get(),
    ledger: database.query("SELECT version,applied_at FROM migrations ORDER BY version").all(),
    schema: database.query("SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name").all(),
    foreignKeys: database.query("PRAGMA foreign_key_check").all(),
    rows,
  };
  expect(value.foreignKeys).toEqual([]);
  expect(Buffer.byteLength(JSON.stringify(value), "utf8")).toBeLessThanOrEqual(16 * 1024 * 1024);
  return value;
};

const stageEffect = (store: StateStore, profile: ReturnType<StateStore["requireProfile"]>, kind: GenericKind, suffix: string) => {
  const providerThreadId = `synthetic-evidence-admission-${suffix}`;
  const session = store.upsertProviderSession({
    profileId: profile.id,
    provider: "codex",
    providerAuthority: store.requireProviderAccountAuthority(profile.id, "codex"),
    providerAccountKey: `v1:codex:${hash("evidence-admission@example.com")}`,
    providerThreadId,
    preset: "high",
    fastEnabled: false,
    state: "idle",
    title: "Before rename",
    providerUpdatedAt: 10,
  });
  const key = suffix === "sentinel"
    ? "49000000-0000-4000-8000-000000000002"
    : "49000000-0000-4000-8000-000000000001";
  const attempt = store.prepareMutation({
    kind,
    authorityId: session.id,
    authorityGeneration: profile.processGeneration,
    request: kind === "session.stop" ? {} : { name: "After rename" },
    idempotencyKey: key,
  });
  const baseline = { providerUpdatedAt: 10, status: "idle" as const, activeTurnId: null };
  const evidence: GenericEvidence = kind === "session.stop"
    ? { kind, providerThreadId, baseline, activeTurnId: null }
    : { kind, providerThreadId, baseline, requestedName: "After rename" };
  const record = store.beginSessionMutationEffect({
    attemptId: attempt.id,
    sessionId: session.id,
    profileGeneration: profile.processGeneration,
    providerAuthority: store.requireProviderAccountAuthority(profile.id, "codex"),
    evidence,
  });
  expect(store.readMutation(key)).toMatchObject({ state: "effect_started", evidence: record });
  expect(store.readLegacyProviderAuthorityQuarantine("mutation", attempt.id)).toBeNull();
  return { attempt, key, session, evidence, record };
};

const withEffectFixture = async (
  kind: GenericKind,
  run: (input: {
    paths: StateStore["paths"];
    database: Database;
    staged: ReturnType<typeof stageEffect>;
  }) => Promise<void>,
): Promise<void> => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "hra-effect-evidence-admission-")));
  let store: StateStore | undefined;
  let database: Database | undefined;
  try {
    const paths = resolveStatePaths({ rootDirectory: root });
    await initializeStatePaths(paths);
    store = new StateStore(paths, options);
    const created = store.createProfile("Evidence admission");
    const current = store.nextProfileGeneration(created.id);
    expect(store.setProfileState(current.id, current.processGeneration, "signed_in", {
      email: "evidence-admission@example.com", plan: "Plus",
    })).toBe(true);
    const profile = store.requireProfile(current.id);
    // Writable startup otherwise initializes this unrelated lazy allocator.
    // Converge it through the real API before the full no-write baseline;
    // allocating a sequence does not fabricate a provider usage observation.
    expect(store.allocateNextUsageRevision(profile.id)).toBe(1);
    const staged = stageEffect(store, profile, kind, "subject");
    // Keep a real, nonempty resolved receipt alongside the unresolved subject;
    // whole-database snapshots below must preserve its original evidence too.
    const sentinel = stageEffect(store, profile, "session.rename", "sentinel");
    expect(store.transitionMutation(sentinel.attempt.id, "effect_started", "ambiguous", { code: "LOST_RESPONSE" })).toBe(true);
    store.quarantineSession(sentinel.session.id);
    store.resolveSessionMutation({
      attemptId: sentinel.attempt.id,
      expectedOriginalState: "ambiguous",
      expectedEvidenceDigest: sentinel.record.digest,
      resolution: "proven_applied",
      resolutionEvidence: { source: "thread/read", providerUpdatedAt: 11 },
      receipt: { renamed: true },
      provider: { providerThreadId: sentinel.evidence.providerThreadId, title: "After rename", status: "idle", providerUpdatedAt: 11 },
    });
    expect(store.readMutation(sentinel.key)).toMatchObject({ state: "reconciled", resolution: { kind: "proven_applied" } });
    store.close();
    store = undefined;
    database = new Database(paths.database, { create: false, strict: true });
    database.exec("PRAGMA foreign_keys=ON");
    expect(database.query("PRAGMA user_version").get()).toEqual({ user_version: 49 });
    expect(database.query("SELECT version FROM migrations ORDER BY version").all())
      .toEqual(Array.from({ length: 49 }, (_, index) => ({ version: index + 1 })));
    expect(database.query("SELECT profile_id,next_revision FROM usage_revision_authority").all())
      .toEqual([{ profile_id: profile.id, next_revision: 2 }]);
    expect(database.query("SELECT * FROM usage_snapshots").all()).toEqual([]);
    expect(database.query("SELECT * FROM usage_poll_failures").all()).toEqual([]);
    expect(database.query("SELECT attempt_id FROM mutation_resolutions").all())
      .toEqual([{ attempt_id: sentinel.attempt.id }]);
    await run({ paths, database, staged });
  } finally {
    database?.close(false);
    store?.close();
    await rm(root, { recursive: true, force: true });
  }
};

// Real current49 API-created rows followed by deliberately synthetic corruption.
// These are not archived provider effects and do not claim historical provenance.
const corruptEvidence = (database: Database, attemptId: string, replacement: {
  json: string;
  digest: string;
  kind?: string;
}): void => {
  const guard = z.object({ sql: z.string() }).strict().parse(database.query(
    "SELECT sql FROM sqlite_master WHERE type='trigger' AND name='mutation_effect_evidence_immutable_update'",
  ).get());
  const before = snapshot(database);
  database.transaction(() => {
    database.exec("DROP TRIGGER mutation_effect_evidence_immutable_update");
    try {
      expect(database.query(`UPDATE mutation_effect_evidence SET evidence_json=?,evidence_digest=?,kind=COALESCE(?,kind)
        WHERE attempt_id=?`).run(replacement.json, replacement.digest, replacement.kind ?? null, attemptId).changes).toBe(1);
    } finally { database.exec(guard.sql); }
  }).immediate();
  const after = snapshot(database);
  expect(after.schema).toEqual(before.schema);
  expect(after.version).toEqual(before.version);
  expect(after.ledger).toEqual(before.ledger);
  const beforeEvidence = before.rows.mutation_effect_evidence;
  if (beforeEvidence === undefined) throw new Error("Missing fixture effect evidence table.");
  expect(after.rows).toEqual({
    ...before.rows,
    mutation_effect_evidence: beforeEvidence.map((row) => row.attempt_id === attemptId
      ? { ...row, evidence_json: replacement.json, evidence_digest: replacement.digest, kind: replacement.kind ?? row.kind }
      : row),
  });
  expect(() => database.query("UPDATE mutation_effect_evidence SET evidence_digest=evidence_digest WHERE attempt_id=?").run(attemptId))
    .toThrow("mutation effect evidence is immutable");
};

const jsonWithLaterUnit = (evidence: GenericEvidence): string => JSON.stringify({
  kind: evidence.kind,
  providerThreadId: evidence.providerThreadId,
  providerTimestampUnit: "unix_milliseconds_v1",
  baseline: evidence.baseline,
  ...(evidence.kind === "session.stop" ? { activeTurnId: evidence.activeTurnId } : { requestedName: evidence.requestedName }),
});

type Corruption = {
  name: string;
  json: (evidence: GenericEvidence) => string;
  wrongDigest?: true;
  valid49Document?: true;
  sqlUnit?: "unix_milliseconds_v1";
  nonJson?: true;
};
const corruptions: readonly Corruption[] = [
  { name: "later unit with matching byte digest", json: jsonWithLaterUnit, sqlUnit: "unix_milliseconds_v1" },
  { name: "later unit with wrong digest", json: jsonWithLaterUnit, wrongDigest: true, sqlUnit: "unix_milliseconds_v1" },
  { name: "unknown field rejected by both dialects", json: (evidence) => JSON.stringify({ ...evidence, unexpected: true }) },
  {
    name: "later unit plus unknown field rejected by both dialects",
    json: (evidence) => `${jsonWithLaterUnit(evidence).slice(0, -1)},"unexpected":true}`,
    sqlUnit: "unix_milliseconds_v1",
  },
  {
    name: "duplicate unit keys rejected by both dialects",
    json: (evidence) => `${jsonWithLaterUnit(evidence).slice(0, -1)},"providerTimestampUnit":null}`,
    sqlUnit: "unix_milliseconds_v1",
  },
  {
    name: "JSON5 unit readable by SQLite but not JSON.parse",
    json: (evidence) => `${JSON.stringify(evidence).slice(0, -1)},providerTimestampUnit:"unix_milliseconds_v1"}`,
    sqlUnit: "unix_milliseconds_v1",
    nonJson: true,
  },
  { name: "valid49 document with wrong digest", json: JSON.stringify, wrongDigest: true, valid49Document: true },
];

const preserveThroughReopens = async (
  input: Parameters<Parameters<typeof withEffectFixture>[1]>[0],
  read: "invalid_shape" | "invalid_digest" | "unchecked",
): Promise<void> => {
  const { database, paths, staged } = input;
  expect(database.query("PRAGMA wal_checkpoint(TRUNCATE)").get()).toEqual({ busy: 0, log: 0, checkpointed: 0 });
  // This holder keeps WAL sidecars available to genuine readonly StateStores.
  // It cannot write and holds no transaction spanning a writable reopen.
  database.exec("PRAGMA query_only=ON");
  const expected = snapshot(database);
  for (const readonly of [false, true, false, true]) {
    const beforeBytes = hash(await readFile(paths.database));
    const reopened = new StateStore(paths, { ...options, readonly });
    try {
      expect(snapshot(database)).toEqual(expected);
      if (read === "invalid_shape") expect(() => reopened.readMutation(staged.key)).toThrow();
      if (read === "invalid_digest") expect(() => reopened.readMutation(staged.key)).toThrow("MUTATION_EFFECT_EVIDENCE_DIGEST_MISMATCH");
      expect(reopened.requireSession(staged.session.id)).toEqual(staged.session);
      if (!readonly) {
        expect(reopened.recoverEffectStartedMutations()).toEqual({
          recovered: [],
          unresolved: [{ id: staged.attempt.id, kind: staged.evidence.kind, authorityId: staged.session.id }],
        });
        // A second pass must neither invent a resolution nor quarantine a
        // session from an untrusted timestamp, mismatched kind or bad digest.
        expect(reopened.recoverEffectStartedMutations()).toEqual({
          recovered: [],
          unresolved: [{ id: staged.attempt.id, kind: staged.evidence.kind, authorityId: staged.session.id }],
        });
      }
      expect(snapshot(database)).toEqual(expected);
    } finally { reopened.close(); }
    expect(snapshot(database)).toEqual(expected);
    if (readonly) expect(hash(await readFile(paths.database))).toBe(beforeBytes);
  }
};

for (const kind of ["session.stop", "session.rename"] as const) {
  for (const corruption of corruptions) {
    test(`current49 preserves unresolved ${kind}: ${corruption.name}`, async () => {
      await withEffectFixture(kind, async (input) => {
        const { database, staged } = input;
        const json = corruption.json(staged.evidence);
        const digest = corruption.wrongDigest === true ? "0".repeat(64) : hash(json);
        expect(digest === hash(json)).toBe(corruption.wrongDigest !== true);
        if (corruption.nonJson === true) expect(() => JSON.parse(json) as unknown).toThrow();
        else expect(mutationEffectEvidence49Schema.safeParse(JSON.parse(json) as unknown).success)
          .toBe(corruption.valid49Document === true);
        corruptEvidence(database, staged.attempt.id, { json, digest });
        const retained = evidenceRowSchema.parse(database.query("SELECT * FROM mutation_effect_evidence WHERE attempt_id=?").get(staged.attempt.id));
        expect(retained).toEqual({ attempt_id: staged.attempt.id, kind, evidence_json: json, evidence_digest: digest, recorded_at: recordedAt });
        if (corruption.sqlUnit !== undefined) {
          // Raw SQL JSON extraction is not evidence validation. These probes
          // include malformed-both, duplicate-key and JSON5 counterexamples.
          expect(database.query("SELECT json_extract(evidence_json,'$.providerTimestampUnit') AS unit FROM mutation_effect_evidence WHERE attempt_id=?").get(staged.attempt.id))
            .toEqual({ unit: corruption.sqlUnit });
        }
        await preserveThroughReopens(input, corruption.valid49Document === true ? "invalid_digest" : "invalid_shape");
      });
    });
  }

  for (const mismatch of ["stored evidence kind", "parsed evidence kind"] as const) {
    test(`current49 preserves unresolved ${kind} with mismatched ${mismatch}`, async () => {
      await withEffectFixture(kind, async (input) => {
        const { database, staged } = input;
        const otherKind = kind === "session.stop" ? "session.rename" : "session.stop";
        const otherEvidence: GenericEvidence = otherKind === "session.stop"
          ? { kind: otherKind, providerThreadId: staged.evidence.providerThreadId, baseline: staged.evidence.baseline, activeTurnId: null }
          : { kind: otherKind, providerThreadId: staged.evidence.providerThreadId, baseline: staged.evidence.baseline, requestedName: "Other mutation" };
        const json = JSON.stringify(mismatch === "stored evidence kind" ? staged.evidence : otherEvidence);
        expect(mutationEffectEvidence49Schema.safeParse(JSON.parse(json) as unknown).success).toBe(true);
        corruptEvidence(database, staged.attempt.id, {
          json,
          digest: hash(json),
          ...(mismatch === "stored evidence kind" ? { kind: otherKind } : {}),
        });
        // readMutation historically does not validate these kind joins. This
        // test promises only admission preservation and recovery containment.
        await preserveThroughReopens(input, "unchecked");
      });
    });
  }

  test(`valid current49 ${kind} control still enters existing restart containment`, async () => {
    await withEffectFixture(kind, async ({ paths, database, staged }) => {
      const expected = snapshot(database);
      const reopened = new StateStore(paths, options);
      try {
        expect(snapshot(database)).toEqual(expected);
        expect(reopened.recoverEffectStartedMutations()).toEqual({ recovered: [staged.attempt.id], unresolved: [] });
        expect(reopened.readMutation(staged.key)).toMatchObject({ state: "ambiguous", result: { code: "DAEMON_RESTART" }, evidence: staged.record });
        expect(reopened.requireSession(staged.session.id)).toMatchObject({ state: "recovery_required" });
        const after = snapshot(database);
        expect(after.schema).toEqual(expected.schema);
        expect(after.ledger).toEqual(expected.ledger);
        expect(after.version).toEqual(expected.version);
        expect(after.rows.mutation_effect_evidence).toEqual(expected.rows.mutation_effect_evidence);
        expect(after.rows.mutation_resolutions).toEqual(expected.rows.mutation_resolutions);
        expect(reopened.recoverEffectStartedMutations()).toEqual({ recovered: [], unresolved: [] });
      } finally { reopened.close(); }
    });
  });
}
