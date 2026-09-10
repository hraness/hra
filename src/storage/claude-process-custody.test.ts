import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { assertClaudeProcessCustodySchema, CLAUDE_PROCESS_CUSTODY_COLUMN, insertClaudeProcessCustody } from "./claude-process-custody";
import { initializeStatePaths, resolveStatePaths } from "./paths";
import { StateStore } from "./state-store";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const dispose of cleanup.splice(0).reverse()) await dispose(); });
const fixture = async () => {
  const home = await realpath(await mkdtemp(join(tmpdir(), "oompa-claude-custody-")));
  const paths = resolveStatePaths({ homeDirectory: home, platform: "darwin" });
  await initializeStatePaths(paths);
  const store = new StateStore(paths, { now: () => 10_000 });
  cleanup.push(async () => { store.close(); await rm(home, { recursive: true, force: true }); });
  const profile = store.createProfile("Claude custody");
  const authority = store.advanceProviderAccountProcessGeneration({ profileId: profile.id,
    provider: "claude", expectedProcessGeneration: 0 });
  const input = { profileId: profile.id, profileGeneration: profile.processGeneration,
    providerAuthority: authority, providerThreadId: "custody-thread", runtimeScope: "managed" as const,
    identity: { pid: 412, pidDomain: "darwin" as const, procStart: "start-412" } };
  const key = { profileId: input.profileId, providerThreadId: input.providerThreadId, runtimeScope: input.runtimeScope };
  return { store, paths, input, key };
};

test("Claude process custody preserves an independent exact tuple across release and reopen", async () => {
  const { store, paths, input, key } = await fixture();
  const claimed = store.recordClaimedClaudeProcessAuthority(input);
  expect(claimed.profileGeneration).toBe(0);
  expect(claimed.providerAuthority).toEqual(input.providerAuthority);
  const releasing = store.beginClaudeProcessAuthorityRelease({ ...key, identity: input.identity, expectedRevision: claimed.revision });
  const released = store.completeClaudeProcessAuthorityRelease({ ...key, identity: input.identity, expectedRevision: releasing.revision });
  expect(released.state).toBe("released");
  const next = store.recordClaimedClaudeProcessAuthority({ ...input,
    identity: { ...input.identity, pid: 413, procStart: "start-413" } });
  expect(next.revision).toBe(released.revision + 1);
  const reopened = new StateStore(paths, { readonly: true });
  try { expect(reopened.readClaudeProcessAuthority(key)).toEqual(next); } finally { reopened.close(); }
});

test("Claude process custody rejects a sibling provider tuple without inserting a process", async () => {
  const { store, input, key } = await fixture();
  expect(() => store.recordClaimedClaudeProcessAuthority({ ...input,
    providerAuthority: store.requireProviderAccountAuthority(input.profileId, "codex") })).toThrow();
  expect(store.readClaudeProcessAuthority(key)).toBeNull();
});

test("a retained Claude process root detects a deleted parent on hot read and reopen", async () => {
  const { store, paths, input, key } = await fixture();
  store.recordClaimedClaudeProcessAuthority(input);
  const database = new Database(paths.database);
  try {
    const guard = database.query("SELECT sql FROM sqlite_master WHERE name='claude_process_custody_delete'")
      .get() as { sql: string };
    database.exec("DROP TRIGGER claude_process_custody_delete");
    database.query("DELETE FROM session_claude_process_authorities WHERE provider_thread_id=?").run(input.providerThreadId);
    database.exec(guard.sql);
    expect(() => store.readClaudeProcessAuthority(key)).toThrow("CLAUDE_PROCESS_CUSTODY_CORRUPT");
    expect(() => new StateStore(paths, { readonly: true })).toThrow("CLAUDE_PROCESS_CUSTODY_CORRUPT");
    expect(() => new StateStore(paths)).toThrow("CLAUDE_PROCESS_CUSTODY_CORRUPT");
  } finally { database.close(); }
});

test("Claude process custody rejects a quoted-column decoy for its weakened marker constraint", async () => {
  const { store, paths, input } = await fixture();
  store.recordClaimedClaudeProcessAuthority(input);
  const database = new Database(paths.database);
  try {
    const table = "session_claude_process_authorities";
    const original = database.query("SELECT sql FROM sqlite_master WHERE type='table' AND name=?")
      .get(table) as { sql: string };
    expect(original.sql).toContain(CLAUDE_PROCESS_CUSTODY_COLUMN);
    const objects = database.query("SELECT sql FROM sqlite_master WHERE tbl_name=? AND type IN ('index','trigger') AND sql IS NOT NULL ORDER BY name")
      .all(table) as Array<{ sql: string }>;
    const columns = (database.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>)
      .map((column) => `"${column.name}"`).join(",");
    const rows = database.query(`SELECT ${columns} FROM ${table}`).all();
    const marker = database.query(`SELECT provider_authority_digest FROM ${table}`).get() as { provider_authority_digest: string };
    database.exec("PRAGMA foreign_keys=OFF");
    database.exec(`CREATE TEMP TABLE saved_processes AS SELECT * FROM ${table}`);
    database.exec(`DROP TABLE ${table}`);
    database.exec(original.sql.replace(CLAUDE_PROCESS_CUSTODY_COLUMN,
      `provider_authority_digest TEXT, "${CLAUDE_PROCESS_CUSTODY_COLUMN}" TEXT`));
    database.exec(`INSERT INTO ${table}(${columns}) SELECT ${columns} FROM saved_processes`);
    // Before restoring the exact immutable guards, prove that this real table
    // lost the marker CHECK, then restore the original retained evidence.
    database.query(`UPDATE ${table} SET provider_authority_digest=?`).run("g".repeat(64));
    expect(database.query(`SELECT provider_authority_digest FROM ${table}`).get())
      .toEqual({ provider_authority_digest: "g".repeat(64) });
    database.query(`UPDATE ${table} SET provider_authority_digest=?`).run(marker.provider_authority_digest);
    for (const object of objects) database.exec(object.sql);
    database.exec("DROP TABLE saved_processes");
    const schema = database.query("SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY name").all();
    expect(() => assertClaudeProcessCustodySchema(database)).toThrow("CLAUDE_PROCESS_CUSTODY_CORRUPT");
    expect(database.query(`SELECT ${columns} FROM ${table}`).all()).toEqual(rows);
    expect(database.query("SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY name").all()).toEqual(schema);
  } finally { database.close(); }
});

test("Claude restart selects the exact released process in the session runtime scope", async () => {
  const { store, paths, input } = await fixture();
  const session = store.upsertProviderSession({ providerAuthority: input.providerAuthority,
    profileId: input.profileId, provider: "claude", providerThreadId: input.providerThreadId,
    title: "Scoped restart", preset: "fable-max", fastEnabled: false, state: "idle",
    providerAccountKey: `v1:claude:${"a".repeat(64)}` });
  for (const runtimeScope of ["personal", "managed"] as const) {
    const claimed = store.recordClaimedClaudeProcessAuthority({ ...input, runtimeScope, sessionId: session.id,
      identity: { ...input.identity, pid: runtimeScope === "personal" ? 417 : 418 } });
    const releasing = store.beginClaudeProcessAuthorityRelease({ profileId: claimed.profileId,
      providerThreadId: claimed.providerThreadId, runtimeScope, identity: claimed.identity, expectedRevision: claimed.revision });
    store.completeClaudeProcessAuthorityRelease({ profileId: claimed.profileId, providerThreadId: claimed.providerThreadId,
      runtimeScope, identity: claimed.identity, expectedRevision: releasing.revision });
  }
  const database = new Database(paths.database);
  try {
    const roots = database.query("SELECT runtime_scope,provider_authority_digest FROM session_claude_process_authorities WHERE session_id=? ORDER BY runtime_scope")
      .all(session.id) as Array<{ runtime_scope: string; provider_authority_digest: string }>;
    expect(roots).toHaveLength(2);
    expect(store.nextDaemonGeneration(`boot_${"a".repeat(32)}`)).toBe(1);
    expect(store.requireSession(session.id).state).toBe("idle");
    expect(store.requireCapturedSessionProviderAuthority(session.id).processGeneration).toBe(input.providerAuthority.processGeneration + 1);
    expect(database.query("SELECT transition_id FROM session_provider_authority_successors WHERE session_id=? AND transition_kind='provider_restart'").all(session.id))
      .toEqual([{ transition_id: roots.find((row) => row.runtime_scope === "managed")?.provider_authority_digest }]);
    const reopened = new StateStore(paths, { readonly: true });
    reopened.close();
  } finally { database.close(); }
});

test("profile removal retains an exact Claude process after a sibling Codex rollover", async () => {
  const { store, paths, input, key } = await fixture();
  const claimed = store.recordClaimedClaudeProcessAuthority(input);
  expect(store.profileHasControllingCodexAuthority(input.profileId)).toBe(false);
  const advanced = store.nextProfileGeneration(input.profileId);
  expect(advanced.processGeneration).toBe(input.profileGeneration + 1);
  expect(store.listUnreleasedClaudeProcessAuthorityPage({ profileId: input.profileId,
    runtimeScope: "managed", afterProviderThreadId: null, limit: 1 }).authorities).toEqual([claimed]);
  const database = new Database(paths.database);
  try {
    expect(() => database.query("UPDATE profiles SET state='removed' WHERE id=?").run(input.profileId))
      .toThrow("CLAUDE_PROCESS_PROFILE_REMOVAL_BLOCKED");
    expect(store.readClaudeProcessAuthority(key)).toEqual(claimed);
    expect(store.requireProviderAccountAuthority(input.profileId, "claude")).toEqual(input.providerAuthority);
  } finally { database.close(); }
});

test("a releasing Claude revocation blocks the sibling profile rollover until exact completion", async () => {
  const { store, input } = await fixture();
  const { revocation } = store.beginProviderRuntimeAccountRevocation({ profileId: input.profileId,
    expectedGeneration: input.profileGeneration, provider: "claude", runtimeScope: "managed",
    currentAccountKey: null, workStore: store.createWorkStore(1, () => "unused-cursor",
      { issue: () => `hrac1_${"A".repeat(43)}`, verify: () => true }) });
  expect(store.profileHasControllingCodexAuthority(input.profileId)).toBe(true);
  expect(() => store.nextProfileGeneration(input.profileId)).toThrow("CLAUDE_REVOCATION_PROFILE_ROLLOVER_BLOCKED");
  expect(store.readProviderRuntimeAccountRevocation({ profileId: input.profileId, provider: "claude", runtimeScope: "managed" }))
    .toEqual(revocation);
  expect(store.nextDaemonGeneration(`boot_${"b".repeat(32)}`)).toBe(1);
  const carried = store.readProviderRuntimeAccountRevocation({ profileId: input.profileId, provider: "claude", runtimeScope: "managed" });
  expect(carried).toMatchObject({ state: "releasing", profileGeneration: input.profileGeneration + 1 });
  if (carried === null) throw new Error("Expected the carried revocation.");
  store.completeProviderRuntimeAccountRevocation({ profileId: input.profileId, expectedGeneration: input.profileGeneration + 1,
    provider: "claude", runtimeScope: "managed", expectedRevision: carried.revision });
  expect(store.profileHasControllingCodexAuthority(input.profileId)).toBe(false);
  expect(store.nextProfileGeneration(input.profileId).processGeneration).toBe(input.profileGeneration + 2);
});

test.each(["releasing", "completed_null", "completed_mismatch", "completed_matching"] as const)(
  "Claude launch root and parent SQL respect exact account revocation independently of sibling counters: %s",
  async (state) => {
    const { store, paths, input } = await fixture();
    const accountKey = `v1:claude:${"a".repeat(64)}`;
    const selector = { profileId: input.profileId, provider: "claude" as const, runtimeScope: "personal" as const };
    store.setSessionAdoptionPolicy({ provider: "claude", profileId: input.profileId });
    const { revocation } = store.beginProviderRuntimeAccountRevocation({ ...selector,
      expectedGeneration: input.profileGeneration,
      currentAccountKey: state === "completed_matching" ? accountKey
        : state === "completed_mismatch" ? `v1:claude:${"b".repeat(64)}` : null,
      workStore: store.createWorkStore(1, () => "unused-cursor",
        { issue: () => `hrac1_${"A".repeat(43)}`, verify: () => true }),
    });
    if (state !== "releasing") {
      store.completeProviderRuntimeAccountRevocation({ ...selector,
        expectedGeneration: input.profileGeneration, expectedRevision: revocation.revision });
      store.nextProfileGeneration(input.profileId);
      store.setSessionAdoptionPolicy({ provider: "claude", profileId: input.profileId });
    }
    const profileGeneration = store.requireProfileById(input.profileId).processGeneration;
    const candidate = store.upsertSessionAdoptionCandidate({ provider: "claude",
      providerThreadId: input.providerThreadId, title: "Scoped launch SQL", state: "idle",
      providerUpdatedAt: 10, liveness: "not_live" });
    store.fenceSessionAdoptionCandidateForClaim({ provider: "claude",
      providerThreadId: input.providerThreadId, expectedRevision: candidate.revision });
    const launch = { profileId: input.profileId, profileGeneration,
      providerAuthority: input.providerAuthority, providerThreadId: input.providerThreadId,
      runtimeScope: "personal" as const, providerAccountKey: accountKey };
    const database = new Database(paths.database);
    try {
      if (state === "completed_matching") {
        expect(store.stageClaudeProcessLaunchIntent(launch)).toMatchObject({ profileGeneration, providerAccountKey: accountKey });
        const reopened = new StateStore(paths, { readonly: true });
        reopened.close();
        return;
      }
      const snapshot = () => ({
        roots: database.query("SELECT * FROM session_claude_process_provider_authorities ORDER BY digest").all(),
        launches: database.query("SELECT * FROM session_claude_process_launch_intents").all(),
        revocations: database.query("SELECT * FROM provider_runtime_account_revocations").all(),
        profiles: database.query("SELECT * FROM profiles").all(),
      });
      const before = snapshot();
      const proof = { version: 1, kind: "exact_provider_v1", parentKind: "launch",
        profileId: input.profileId, profileGeneration, providerThreadId: input.providerThreadId,
        runtimeScope: "personal", originAt: 10_000, intentId: randomUUID(), identity: null,
        authority: input.providerAuthority, launchDigest: null, previousDigest: null, claimRevision: 1,
        launchContext: { accountKey, sessionId: null, switchAttemptId: null } };
      expect(() => insertClaudeProcessCustody(database, proof)).toThrow("CLAUDE_PROCESS_CUSTODY_UNPROVED");
      expect(() => store.stageClaudeProcessLaunchIntent(launch)).toThrow("SESSION_CLAUDE_PROCESS_LAUNCH_INTENT_ACCOUNT_STALE");
      expect(snapshot()).toEqual(before);
      // Inject only a root inside a rollback-only corruption probe to prove
      // the independent parent guard, then restore the exact root guard.
      const guard = database.query("SELECT sql FROM sqlite_master WHERE name='claude_process_proof_insert'")
        .get() as { sql: string };
      const probe = database.transaction(() => {
        database.exec("DROP TRIGGER claude_process_proof_insert");
        const digest = insertClaudeProcessCustody(database, proof);
        database.exec(guard.sql);
        expect(() => database.query(`INSERT INTO session_claude_process_launch_intents(
          provider_thread_id,intent_id,profile_id,profile_generation,runtime_scope,provider_account_key,
          session_id,revision,staged_at,updated_at,provider_authority_digest)
          VALUES (?,?,?,?,'personal',?,NULL,1,10000,10000,?)`)
          .run(input.providerThreadId, proof.intentId, input.profileId, profileGeneration, accountKey, digest))
          .toThrow("CLAUDE_PROCESS_CUSTODY_UNPROVED");
        throw new Error("rollback launch SQL probe");
      });
      expect(probe).toThrow("rollback launch SQL probe");
      expect(snapshot()).toEqual(before);
      expect(store.requireProviderAccountAuthority(input.profileId, "claude")).toEqual(input.providerAuthority);
      const reopened = new StateStore(paths, { readonly: true });
      reopened.close();
    } finally { database.close(); }
  },
);
