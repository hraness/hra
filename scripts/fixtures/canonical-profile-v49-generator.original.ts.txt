import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { Database, type SQLQueryBindings } from "bun:sqlite";
import { z } from "zod";

import type * as StateStoreModule from "../../src/storage/state-store";
import type * as WorkStoreModule from "../../src/storage/work-store";
import type * as WorkCapabilityModule from "../../src/storage/work-capability";
import type * as StatePathsModule from "../../src/storage/paths";

// Manual offline source-bound generator, never part of ordinary tests. Supply
// an immutable checkout/export with its own frozen dependencies. No provider,
// credentials, Git/network request, or current migration implementation is used.
const [sourceArgument, outputArgument] = process.argv.slice(2);
if (sourceArgument === undefined || outputArgument === undefined || process.argv.length !== 4) {
  throw new Error("Usage: bun scripts/fixtures/canonical-profile-v49-generator.ts <exact-source-root> <new-output.json>");
}
const sourceRoot = resolve(sourceArgument);
const output = resolve(outputArgument);
const source = {
  commit: "7ab347813f8d7e4f31e9584752c801dd1ca0cda0",
  equivalentCommit: "0787b6d9e503b831d657c495e923fae734ec998f",
  tree: "978bdc30b6fb9d259c92d0ca91335a854227d6f4",
  runtimeFiles: 180,
  runtimeManifestSha256: "43d69f664f588a89b3a51d285404559ec8411b10cd0c6403aaa2953f363089f8",
  stateStoreSha256: "01edcbdc3f7e870f8252e07de1be90a2d3fe8f2e1b32a5b948c04fd64c774923",
  workStoreSha256: "0b79503811b93ce56171f5cdcb1d5d840e7e6c005068b579f3f1a8637eee2146",
  lockSha256: "0a108a3ba2a4b705a96564548592108c9169697ed1f10186c9dfb7f6e3a229ad",
  packageSha256: "1ab5a6e4f2ca9839a5971bf5e3bf462343667a05891780bee48428ab7fbd3708",
  bunVersion: "1.3.14",
} as const;
const sha256 = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex");
assert.equal(Bun.version, source.bunVersion);
assert.equal((await readFile(join(sourceRoot, ".bun-version"), "utf8")).trim(), source.bunVersion);
for (const [path, expected] of [["bun.lock", source.lockSha256], ["package.json", source.packageSha256],
  ["src/storage/state-store.ts", source.stateStoreSha256], ["src/storage/work-store.ts", source.workStoreSha256]] as const) {
  assert.equal(sha256(await readFile(join(sourceRoot, path))), expected);
}
const runtimeManifest: [string, string][] = [];
async function inspectRuntime(at: string): Promise<void> {
  for (const name of (await readdir(join(sourceRoot, at))).sort()) {
    const path = `${at}/${name}`;
    const metadata = await lstat(join(sourceRoot, path));
    if (metadata.isSymbolicLink()) throw new Error("Source runtime contains a symlink.");
    if (metadata.isDirectory()) await inspectRuntime(path);
    else if (metadata.isFile() && !path.endsWith(".test.ts") && !path.endsWith(".test.tsx")) {
      runtimeManifest.push([path, sha256(await readFile(join(sourceRoot, path)))]);
    }
  }
}
await inspectRuntime("src");
runtimeManifest.sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
assert.equal(runtimeManifest.length, source.runtimeFiles);
assert.equal(sha256(JSON.stringify(runtimeManifest)), source.runtimeManifestSha256);

// This literal is deliberately public synthetic input, not a normalized copy
// of any private project. Fail if it already exists; leave it for owner cleanup.
const syntheticParent = "/private/tmp/hra-public-canonical49-profile-fixture";
const syntheticProject = `${syntheticParent}/project`;
const absent = await lstat(syntheticParent).then(() => false, (error: unknown) => {
  if (z.object({ code: z.literal("ENOENT") }).passthrough().safeParse(error).success) return true;
  throw error;
});
assert.equal(absent, true, "Synthetic fixture parent already exists; no overwrite is permitted.");
await mkdir(syntheticParent, { mode: 0o700 });
await mkdir(syntheticProject, { mode: 0o700 });

// Full immutable runtime bytes above bind these dynamically loaded modules.
const { StateStore } = await import(pathToFileURL(join(sourceRoot, "src/storage/state-store.ts")).href) as typeof StateStoreModule;
const { canonicalWorkJson } = await import(pathToFileURL(join(sourceRoot, "src/storage/work-store.ts")).href) as typeof WorkStoreModule;
const { WorkCapabilityCodec } = await import(pathToFileURL(join(sourceRoot, "src/storage/work-capability.ts")).href) as typeof WorkCapabilityModule;
const { resolveStatePaths, initializeStatePaths } = await import(pathToFileURL(join(sourceRoot, "src/storage/paths.ts")).href) as typeof StatePathsModule;
type Store = InstanceType<typeof StateStore>;
const privateRoot = await realpath(await mkdtemp(join(tmpdir(), "hra-canonical49-generator-")));
const paths = resolveStatePaths({ homeDirectory: privateRoot, platform: "linux", rootDirectory: join(privateRoot, "state") });
await initializeStatePaths(paths);
const fixedNow = () => 10_000;
const options = { now: fixedNow, resolveMachineTimeZone: () => "UTC" };
const codec = new WorkCapabilityCodec(new Uint8Array(32).fill(7));
const createWorkStore = (store: Store) => store.createWorkStore(1,
  (payload) => `hra1.${Buffer.from(JSON.stringify(payload), "utf8").toString("base64url")}.${"A".repeat(43)}`,
  {
    issue: (authority) => authority.scope === "attempt"
      ? codec.issue({ scope: "attempt", workId: authority.workId, sessionId: authority.sessionId,
          subjectId: authority.attemptId, fence: authority.fence }) : codec.issue(authority),
    verify: (capability, authority) => authority.scope === "attempt"
      ? codec.verify({ capability, scope: "attempt", workId: authority.workId, sessionId: authority.sessionId,
          subjectId: authority.attemptId, fence: authority.fence }) : codec.verify({ ...authority, capability }),
  });
const query = (db: Database, sql: string, ...bindings: SQLQueryBindings[]) => {
  const statement = db.prepare(sql);
  try { return statement.all(...bindings) as Record<string, unknown>[]; } finally { statement.finalize(); }
};
function snapshot(path = paths.database) {
  const db = new Database(path, { readonly: true, strict: true });
  try {
    const schema = query(db, "SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name");
    assert.deepEqual(query(db, "PRAGMA foreign_key_check"), []);
    assert.deepEqual(query(db, "PRAGMA integrity_check"), [{ integrity_check: "ok" }]);
    return { version: query(db, "PRAGMA user_version"), schema,
      rows: Object.fromEntries(schema.filter((row) => row.type === "table").map((row) => {
        const name = z.string().parse(row.name);
        return [name, query(db, `SELECT * FROM "${name.replaceAll('"', '""')}"`)
          .sort((a, b) => canonicalWorkJson(a).localeCompare(canonicalWorkJson(b)))];
      })) };
  } finally { db.close(false); }
}
let store: Store | null = new StateStore(paths, options);
try {
  store.nextDaemonGeneration(`boot_${"1".repeat(32)}`);
  const createdProfile = store.createProfile("Synthetic canonical49 account");
  const profile = store.nextProfileGeneration(createdProfile.id);
  const email = "canonical49-fixture@example.invalid";
  assert.equal(store.setProfileState(profile.id, profile.processGeneration, "signed_in", { email, plan: "Plus" }), true);
  const project = await store.createProject("Synthetic canonical49 project", syntheticProject, true);
  // Explicitly admit the historical v9 maintenance delta before the capture.
  assert.deepEqual(snapshot().rows.usage_revision_authority, []);
  const beforeMaintenance = snapshot();
  store.close(); store = new StateStore(paths, options);
  assert.equal(canonicalWorkJson(snapshot()), canonicalWorkJson({ ...beforeMaintenance,
    rows: { ...beforeMaintenance.rows, usage_revision_authority: [{ profile_id: profile.id, next_revision: 1 }] } }));
  const work = createWorkStore(store);
  let sequence = 0;
  const nextKey = () => `01890f31-a123-7000-8000-${(++sequence).toString(16).padStart(12, "0")}`;
  const cases = [];
  for (const state of ["claimed", "released", "submitted"] as const) {
    const session = store.upsertProviderSession({ profileId: profile.id, projectId: project.id,
      provider: "codex", providerThreadId: `synthetic-canonical49-${state}`, title: `Synthetic ${state} worker`,
      providerAccountKey: `v1:codex:${sha256(email)}`, preset: "ultra", fastEnabled: false, state: "idle" });
    const created = work.apply({ kind: "work.create", idempotencyKey: nextKey(), clientRef: `canonical49-${state}`,
      coordinatorSessionId: session.id, objective: "Preserve the source-created canonical49 predecessor.",
      routes: [{ accountId: profile.id, projectId: project.id, preset: "ultra", fast: false }],
      tasks: [{ clientRef: `task-${state}`, dependsOnRefs: [], dependsOnTaskIds: [],
        objective: "Keep immutable history intact.", instructions: "No provider effect is executed by this fixture.",
        criteria: ["Preserve exact identity and replay."], route: { accountId: profile.id, projectId: project.id },
        preset: "ultra", fast: false, priority: 0, maxAttempts: 3, requiredReviews: 1, resultKind: "text", minEvidence: 0 }] });
    assert.equal(created.kind, "work.create");
    const task = created.tasks[0]; assert.ok(task);
    const claim = { kind: "task.claim", idempotencyKey: nextKey(), workId: created.work.id,
      taskId: task.id, expectedTaskRevision: task.revision, actorSessionId: session.id,
      actorCapability: created.memberCapability, leaseMs: 50_000 } as const;
    const claimed = work.apply(claim); assert.equal(claimed.kind, "task.claim");
    if (state === "released") work.apply({ kind: "attempt.release", idempotencyKey: nextKey(), workId: created.work.id,
      attemptId: claimed.attempt.id, expectedAttemptRevision: claimed.attempt.revision, fence: claimed.attempt.fence,
      actorSessionId: session.id, attemptCapability: claimed.attemptCapability, reason: "Synthetic release before dispatch." });
    if (state === "submitted") {
      const key = nextKey();
      work.apply({ kind: "attempt.dispatch", idempotencyKey: key, workId: created.work.id, attemptId: claimed.attempt.id,
        expectedAttemptRevision: claimed.attempt.revision, fence: claimed.attempt.fence, actorSessionId: session.id,
        attemptCapability: claimed.attemptCapability, targetSessionId: session.id, mode: "send" });
      assert.equal(work.authorizePreparedEffect(key).executable, true);
      const settled = work.finalizeDispatch(key, { kind: "accepted", receipt: { kind: "turn_started",
        turnId: `opaque_v2_${"a".repeat(64)}`, runtimeProfileDigest: "b".repeat(64),
        mutationAttemptId: `attempt_${"c".repeat(32)}`, accountGeneration: profile.processGeneration } });
      work.apply({ kind: "attempt.report", idempotencyKey: nextKey(), workId: created.work.id,
        attemptId: settled.id, expectedAttemptRevision: settled.revision, fence: settled.fence,
        actorSessionId: session.id, attemptCapability: claimed.attemptCapability,
        report: { kind: "submit", summary: "Synthetic submission awaiting review.", result: { kind: "text", text: "complete" }, evidence: [] } });
    }
    cases.push({ state, sessionId: session.id, workId: created.work.id, taskId: task.id,
      attemptId: claimed.attempt.id, claim, replay: work.apply(claim),
      projection: { task: work.task(task.id), history: work.taskHistory(task.id),
        events: work.events(created.work.id), snapshot: work.snapshot(created.work.id) } });
  }
  const payload = snapshot();
  assert.deepEqual(payload.version, [{ user_version: 49 }]);
  assert.equal(payload.rows.migrations?.length, 49);
  store.close(); store = null;
  for (const readonly of [true, false]) {
    store = new StateStore(paths, { ...options, readonly });
    const reopened = createWorkStore(store);
    for (const entry of cases) {
      assert.equal(canonicalWorkJson({ task: reopened.task(entry.taskId), history: reopened.taskHistory(entry.taskId),
        events: reopened.events(entry.workId), snapshot: reopened.snapshot(entry.workId) }), canonicalWorkJson(entry.projection));
      if (!readonly) assert.equal(canonicalWorkJson(reopened.apply(entry.claim)), canonicalWorkJson(entry.replay));
    }
    assert.equal(canonicalWorkJson(snapshot()), canonicalWorkJson(payload));
    store.close(); store = null;
  }
  // Independently materialize the exact logical snapshot before admitting it.
  // This restores source-created rows and schema, not a current DB relabelled49.
  const restoredPaths = resolveStatePaths({ homeDirectory: privateRoot, platform: "linux", rootDirectory: join(privateRoot, "restored") });
  await initializeStatePaths(restoredPaths);
  const restored = new Database(restoredPaths.database, { create: true, strict: true });
  try {
    restored.exec("PRAGMA foreign_keys=OFF");
    const install = restored.transaction(() => {
      for (const object of payload.schema) {
        if (object.type === "table" && object.sql !== null && !z.string().parse(object.name).startsWith("sqlite_")) {
          restored.exec(z.string().parse(object.sql));
        }
      }
      restored.exec("DELETE FROM sqlite_sequence");
      for (const [table, rows] of Object.entries(payload.rows)) {
        for (const row of rows) {
          const names = Object.keys(row);
          const identifier = (name: string) => `"${name.replaceAll('"', '""')}"`;
          const statement = restored.prepare(`INSERT INTO ${identifier(table)}(${names.map(identifier).join(",")}) VALUES(${names.map(() => "?").join(",")})`);
          try { statement.run(...names.map((name) => z.union([z.string(), z.number(), z.null()]).parse(row[name]))); }
          finally { statement.finalize(); }
        }
      }
      for (const object of payload.schema) {
        if (object.type !== "table" && object.sql !== null) restored.exec(z.string().parse(object.sql));
      }
      restored.exec("PRAGMA user_version=49");
    });
    install.immediate();
    // A logical fixture is not a physical WAL image. Keep its fresh DELETE
    // journal until the real writable constructor establishes its normal WAL.
    assert.deepEqual(query(restored, "PRAGMA journal_mode"), [{ journal_mode: "delete" }]);
  } finally { restored.close(false); }
  await chmod(restoredPaths.database, 0o600);
  assert.equal(canonicalWorkJson(snapshot(restoredPaths.database)), canonicalWorkJson(payload));
  for (const readonly of [true, false]) {
    store = new StateStore(restoredPaths, { ...options, readonly });
    const reopened = createWorkStore(store);
    for (const entry of cases) {
      assert.equal(canonicalWorkJson({ task: reopened.task(entry.taskId), history: reopened.taskHistory(entry.taskId),
        events: reopened.events(entry.workId), snapshot: reopened.snapshot(entry.workId) }), canonicalWorkJson(entry.projection));
      if (!readonly) assert.equal(canonicalWorkJson(reopened.apply(entry.claim)), canonicalWorkJson(entry.replay));
    }
    assert.equal(canonicalWorkJson(snapshot(restoredPaths.database)), canonicalWorkJson(payload));
    store.close(); store = null;
  }
  const serialized = canonicalWorkJson(payload);
  assert.ok(!serialized.includes(privateRoot) && !serialized.includes(sourceRoot));
  assert.ok(!/\/Users\/|\/home\/|\/var\/folders\/|-----BEGIN .*PRIVATE KEY|Bearer [A-Za-z0-9]/u.test(serialized));
  const fixture = { format: "hra-source-created-state49-v1", description: "Synthetic semantic StateStore fixture, not an admitted release artifact or provider acceptance.",
    source, generatorSha256: sha256(await readFile(import.meta.path)), fixedNow: fixedNow(), daemonGeneration: 1,
    publicSyntheticProject: syntheticProject, usageV9Maintenance: "Only first writable reopen initialized one profile next_revision=1; subsequent complete snapshots unchanged.",
    logicalRestoration: "Exact schema/all rows and both source readonly/writable reopen plus replay verified.",
    payloadSha256: sha256(serialized), cases, payload };
  const bytes = `${JSON.stringify(fixture)}\n`;
  assert.ok(Buffer.byteLength(bytes) <= 500 * 1_024, "Fixture exceeds reviewed size budget.");
  await writeFile(output, bytes, { flag: "wx", mode: 0o600 });
  console.log(JSON.stringify({ status: "generated", bytes: Buffer.byteLength(bytes), sha256: sha256(bytes), payloadSha256: fixture.payloadSha256,
    sourceCommit: source.commit, schemaVersion: 49, cases: cases.map(({ state }) => state) }));
} finally { store?.close(); }
