import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { renameSync, symlinkSync } from "node:fs";
import { chmod, lstat, mkdtemp, mkdir, realpath, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Database, constants as sqliteConstants } from "bun:sqlite";
import { z } from "zod";

import { deriveDesktopProfilePaths } from "../desktop/profile";
import {
  ROOT_STATUS_ATTENTION_LIMIT,
  ROOT_STATUS_MAXIMUM_BYTES,
  sessionLocalObservationSnapshotSchema,
} from "../domain/observation";
import type { InteractionDisplay, InteractionKind } from "../domain/interactions";
import {
  currentPresetContract,
  legacyPresetContract,
} from "../domain/presets";
import {
  createPortableProjectMemoryCanonicalIdentity,
  deriveProjectMemoryCanonicalIdentity,
  legacyProjectMemorySpaceId,
  PROJECT_MEMORY_EMPTY_HEAD,
} from "../domain/project-memory";
import {
  SESSION_EVENT_MAX_BYTES,
  SESSION_EVENT_PUBLIC_MAX_BYTES,
  SESSION_EVENT_RETAIN_AGE_MS,
  SESSION_EVENT_USER_MESSAGE_MAX_CHARACTERS,
} from "../domain/session-events";
import {
  accountUsageCounterSamples,
  createStoredAccountUsageSnapshot,
  observedAccountTokenVelocity,
  type StoredAccountUsageSnapshot,
} from "../domain/usage-metrics";
import { utf8Bytes, type ProjectId } from "../domain/values";
import { canTransitionQueue, queueStateSchema, type QueueState } from "../domain/transitions";
import { projectPublicProviderIdentifier } from "../public-provider-identifier";
import {
  effectiveClaudeRuntimeProfileSchema,
  effectiveDevinRuntimeProfileSchema,
  effectiveRuntimeProfileSchema,
} from "../domain/runtime-profile";
import { initializeProfilePaths, initializeStatePaths, resolveStatePaths } from "./paths";
import {
  ATTENTION_NOTIFICATION_SNAPSHOT_LIMIT,
  CONTROL_PLANE_RECONCILIATION_BATCH_LIMIT,
  MEMORY_SUBMISSION_RETAIN_AGE_MS,
  PEER_SESSION_ACTION_RETAIN_AGE_MS,
  PEER_SESSION_HOP_LIMIT,
  PEER_SESSION_HOURLY_ACTION_LIMIT,
  PEER_SESSION_HOURLY_DISTINCT_TARGET_LIMIT,
  PEER_SESSION_PROJECT_HOURLY_ACTION_LIMIT,
  PEER_SESSION_RATE_WINDOW_MS,
  PEER_SESSION_RETAINED_ACTION_LIMIT,
  USAGE_CLOUD_UPLOAD_MIN_INTERVAL_MS,
  USAGE_CLOUD_UPLOAD_ANCHOR_COUNT,
  USAGE_LOCAL_RETAIN_AGE_MS,
  USAGE_LOCAL_RETAIN_BYTES,
  USAGE_LOCAL_RETAIN_SUCCESS_COUNT,
  SelectionError,
  StateSecurityScrubRequiredError,
  StateStore,
  type MachineTimeZoneResolver,
  type ProjectRecord,
  type ProjectMemoryHeadRef,
  type SecurityScrubCheckpointPolicy,
  type SessionRecord,
} from "./state-store";
import { WORK_SCHEMA_SQL } from "./work-store";

const stores: StateStore[] = [];
const privateUserPathRoot = ["", "Users", "private"].join("/");
const publicProviderIdentifierKey = new Uint8Array(32).fill(19);
const publicProviderIdentifier = (value: string) =>
  projectPublicProviderIdentifier(value, publicProviderIdentifierKey);

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});

async function fixture(
  options: Readonly<{
    now?: () => number;
    resolveMachineTimeZone?: MachineTimeZoneResolver;
    securityScrubCheckpoint?: SecurityScrubCheckpointPolicy;
  }> = {},
): Promise<{ store: StateStore; home: string }> {
  const home = await realpath(await mkdtemp(join(tmpdir(), "hra-store-")));
  const paths = resolveStatePaths({ homeDirectory: home, platform: "darwin" });
  await initializeStatePaths(paths);
  const store = new StateStore(paths, {
    now: options.now ?? (() => { let value = 1_000; return () => value++; })(),
    resolveMachineTimeZone: () => "America/Puerto_Rico",
    ...options,
  });
  stores.push(store);
  return { store, home };
}

const dropProviderAuthorityObjectsForLegacyFeatureFixture = (database: Database): void => {
  database.exec(`
    PRAGMA foreign_keys=OFF;
    DROP TRIGGER IF EXISTS session_provider_switch_session_update_guard;
    DROP TRIGGER IF EXISTS session_provider_switch_session_delete_guard;
    DROP TABLE IF EXISTS session_provider_switches;
    DROP TABLE session_mutation_authority_rebinds_v39;
    DROP TABLE session_provider_switch_source_releases;
    DROP TABLE session_provider_switch_seed_results;
    DROP TABLE session_provider_switch_seed_intents;
    DROP TABLE session_provider_switch_target_releases;
    DROP TABLE session_provider_switch_targets;
    DROP TABLE session_mutation_authority_rebinds;
    PRAGMA foreign_keys=ON;
  `);
};

const providerSwitchSchemaObjectCount = (database: Database): number =>
  z.object({ count: z.number().int().nonnegative() }).strict().parse(database.query(
    `SELECT COUNT(*) AS count FROM sqlite_master
     WHERE name LIKE 'session_provider_switch_%'
        OR name LIKE 'session_mutation_authority_rebinds%'`,
  ).get()).count;

const replaceAutorespondEvidenceWithVersion30Fixture = (
  database: Database,
  sessionId: string,
): void => {
  database.query("DROP TABLE IF EXISTS autorespond_message_sources").run();
  database.query("DROP TABLE IF EXISTS autorespond_evidence_next").run();
  database.query("DROP TABLE autorespond_evidence").run();
  database.query(`
    CREATE TABLE autorespond_evidence (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      interaction_id TEXT NOT NULL CHECK(length(interaction_id) = 36),
      kind TEXT NOT NULL CHECK(kind IN ('command_approval','file_change_approval','permission_approval')),
      class TEXT NOT NULL CHECK(length(class) BETWEEN 1 AND 256),
      decision TEXT NOT NULL CHECK(length(decision) BETWEEN 1 AND 64),
      mode TEXT NOT NULL CHECK(mode IN ('auto:all','auto:workspace','manual')),
      outcome TEXT NOT NULL CHECK(outcome IN ('accepted','refused')),
      latency_ms INTEGER NOT NULL CHECK(latency_ms >= 0),
      subagent INTEGER NOT NULL CHECK(subagent IN (0,1)),
      occurred_at INTEGER NOT NULL CHECK(occurred_at >= 0)
    ) STRICT
  `).run();
  database.query(`
    INSERT INTO autorespond_evidence(
      id,session_id,interaction_id,kind,class,decision,mode,outcome,latency_ms,subagent,occurred_at
    ) VALUES (7,?,'00000000-0000-4000-8000-000000000731','command_approval','shell','accept','manual','accepted',17,1,1500)
  `).run(sessionId);
  database.query("DELETE FROM migrations WHERE version > 30").run();
  database.query("PRAGMA user_version = 30").run();
};

// Pinned-reader tests prove the scrub fails once a reader outlives the whole
// checkpoint budget. The production budget is three 5 s attempts; this policy
// keeps the same shape and the same failure at a test-sized wait.
const shortScrubCheckpoint: SecurityScrubCheckpointPolicy = {
  busyTimeoutMs: 50,
  attempts: 2,
  backoffMs: 10,
};

// Runs readonly reads in a second Bun process so the main thread's synchronous
// settlement meets a concurrent reader, as the daemon does when `hra status`
// opens the same state directory. The script is written into the fixture home
// and reports one line per event on stdout.
type ReaderProcess = Readonly<{
  nextLine: () => Promise<string>;
  exited: Promise<number>;
  kill: () => void;
}>;

async function spawnReaderProcess(
  home: string,
  name: string,
  source: string,
  args: readonly string[],
): Promise<ReaderProcess> {
  const script = join(home, `${name}.ts`);
  await writeFile(script, source, { mode: 0o600 });
  const child = Bun.spawn([process.execPath, script, ...args], {
    env: process.env,
    stderr: "pipe",
    stdin: "ignore",
    stdout: "pipe",
  });
  const reader = child.stdout.getReader();
  const decoder = new TextDecoder();
  const lines: string[] = [];
  let buffered = "";
  const nextLine = async (): Promise<string> => {
    for (;;) {
      const line = lines.shift();
      if (line !== undefined) return line;
      const chunk = await reader.read();
      if (chunk.done) {
        throw new Error(`reader process ended early: ${await new Response(child.stderr).text()}`);
      }
      buffered += decoder.decode(chunk.value, { stream: true });
      const parts = buffered.split("\n");
      buffered = parts.pop() ?? "";
      lines.push(...parts.filter((part) => part.length > 0));
    }
  };
  return { nextLine, exited: child.exited, kill: () => child.kill() };
}

// Pins one WAL snapshot on a raw readonly connection for argv[3] milliseconds.
// Synchronous fd writes keep each report line ahead of the blocking sleep.
const pinnedReaderSource = `
import { writeSync } from "node:fs";
import { Database } from "bun:sqlite";
const [databasePath, holdMs] = Bun.argv.slice(2);
const reader = new Database(databasePath, { readonly: true, strict: true });
reader.exec("BEGIN");
reader.query("SELECT count(*) AS total FROM queue_entries").get();
writeSync(1, "pinned\\n");
Bun.sleepSync(Number(holdMs));
reader.exec("COMMIT");
reader.close(false);
writeSync(1, "released\\n");
`;

// Repeats readonly StateStore opens plus status-shaped reads until the stop
// file exists. A readonly open that lands between the writer's scrub marker
// and its checkpoint is refused by design; the loop retries it like a user
// rerunning hra status.
const statusReaderSource = `
import { existsSync, writeSync } from "node:fs";
import { resolveStatePaths } from ${JSON.stringify(join(import.meta.dir, "paths.ts"))};
import { StateStore } from ${JSON.stringify(join(import.meta.dir, "state-store.ts"))};
const [homeDirectory, stopFile] = Bun.argv.slice(2);
const paths = resolveStatePaths({ homeDirectory, platform: "darwin" });
let opens = 0;
let scrubBlockedOpens = 0;
let started = false;
while (!existsSync(stopFile) && opens + scrubBlockedOpens < 10_000) {
  try {
    const store = new StateStore(paths, { readonly: true });
    try {
      store.listProjects();
      store.listProfiles();
      store.listSessions();
    } finally {
      store.close();
    }
    opens += 1;
  } catch (error) {
    if (error instanceof Error && error.message === "STATE_SECURITY_SCRUB_REQUIRED") {
      scrubBlockedOpens += 1;
    } else {
      writeSync(1, JSON.stringify({ error: error instanceof Error ? error.message : "UNKNOWN" }) + "\\n");
      process.exit(1);
    }
  }
  if (!started) {
    started = true;
    writeSync(1, "started\\n");
  }
}
writeSync(1, JSON.stringify({ opens, scrubBlockedOpens }) + "\\n");
`;

const statusReaderReportSchema = z.object({
  opens: z.number().int().nonnegative(),
  scrubBlockedOpens: z.number().int().nonnegative(),
}).strict();

function signInProfile(store: StateStore, label: string, email: string) {
  const created = store.createProfile(label);
  const current = store.nextProfileGeneration(created.id);
  expect(
    store.setProfileState(current.id, current.processGeneration, "signed_in", {
      email,
      plan: "Plus",
    }),
  ).toBe(true);
  return store.requireProfile(current.id);
}

async function prepareSignedOutSessionStart(
  store: StateStore,
  home: string,
  input: Readonly<{
    idempotencyKey: string;
    label: string;
    preset: "high" | "fable-max";
    provider: "codex" | "claude";
  }>,
) {
  const profile = store.createProfile(input.label);
  const projectRoot = join(home, `${input.label.toLowerCase().replaceAll(" ", "-")}-project`);
  await mkdir(projectRoot);
  const project = await store.createProject(`${input.label} project`, projectRoot, true);
  const attempt = store.prepareMutation({
    authorityGeneration: profile.processGeneration,
    authorityId: profile.id,
    idempotencyKey: input.idempotencyKey,
    kind: "session.start",
    request: {
      fast: false,
      preset: input.preset,
      projectId: project.id,
      provider: input.provider,
    },
  });
  return { attempt, profile, project };
}

const usageFingerprint = "a".repeat(64);
const resetAccountFingerprint = (email: string): string =>
  createHash("sha256").update(email.trim().toLowerCase()).digest("hex");
const testDigest = (value: string): string =>
  createHash("sha256").update(value, "utf8").digest("hex");
const testCanonicalMemoryEnvelope = (value: string, keyVersion = 1) => ({
  algorithm: "A256GCM" as const,
  ciphertext: testDigest(`ciphertext:${value}`),
  keyVersion,
  nonce: testDigest(`nonce:${value}`).slice(0, 16),
});
const testCanonicalMemoryHostedCreateRequest = (
  remoteSpaceId: string,
  keyVersion = 7,
  accountKeyVersion = 3,
) => ({
  bindingPolicy: "one_project_one_space" as const,
  encryptedDescriptor: testCanonicalMemoryEnvelope(
    "PRIVATE HOSTED CREATE DESCRIPTOR",
    keyVersion,
  ),
  genesisHeadProof: testCanonicalMemoryEnvelope(
    "PRIVATE HOSTED CREATE GENESIS PROOF",
    keyVersion,
  ),
  genesisToken: testDigest("hosted create genesis token"),
  identityContract: 2 as const,
  keyVersion,
  spaceId: remoteSpaceId,
  wrappedSpaceKey: testCanonicalMemoryEnvelope(
    "PRIVATE HOSTED CREATE WRAPPED KEY",
    accountKeyVersion,
  ),
});
const reserveTestProjectMemoryAuthority = (
  store: StateStore,
  projectId: ProjectId,
  head: ProjectMemoryHeadRef,
) => {
  const identity = createPortableProjectMemoryCanonicalIdentity(projectId);
  const reserved = store.reserveProjectMemoryAuthority({
    canonicalSpaceId: identity.canonicalSpaceId,
    head,
    identityContract: identity.identityContract,
    projectId,
  });
  return store.markProjectMemoryAuthorityInitialized({
    expectedHead: reserved.head,
    expectedRevision: reserved.revision,
    projectId,
  });
};
const peerIdempotencyKey = (index: number): string =>
  `20000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`;
const codexRuntimeProfile = (
  profile: Readonly<{ id: string; processGeneration: number }>,
  observedAt = 2_000,
) => ({
  profileId: profile.id,
  processGeneration: profile.processGeneration,
  observedAt,
  preset: "high" as const,
  model: "gpt-6-astra",
  reasoningEffort: "max" as const,
  serviceTier: null,
  fast: false,
  approvalPolicy: "on-request" as const,
  reviewMode: "auto_review" as const,
  permissionProfile: ":workspace" as const,
  computerUse: true as const,
  pluginCapability: true as const,
  enabledApps: [],
});

const prepareAuthorizedReset = (
  store: StateStore,
  input: Parameters<StateStore["prepareAccountRateLimitReset"]>[0],
) => {
  expect(store.authorizeAccountRateLimitResetPolicy({
    profileId: input.profileId,
    processGeneration: input.processGeneration,
    accountFingerprint: input.accountFingerprint,
    weeklyWindowDurationMinutes: 10_080,
    weeklyWindowResetsAt: input.weeklyWindowResetsAt,
  }).decision).toBe("allow");
  return store.prepareAccountRateLimitReset(input);
};

function usageSnapshot(input: Readonly<{
  accountFingerprint?: string;
  fillerBytes?: number;
  lifetimeTokens: number;
  observedAt: number;
  previous: StoredAccountUsageSnapshot | null;
  receivedAt: number;
  sourceSequence: number;
}>): StoredAccountUsageSnapshot {
  return createStoredAccountUsageSnapshot({
    accountFingerprint: input.accountFingerprint ?? usageFingerprint,
    daemonGeneration: 1,
    observedAt: input.observedAt,
    previousPayload: input.previous,
    providerGeneration: 1,
    providerPayload: {
      usage: { summary: { lifetimeTokens: input.lifetimeTokens } },
      ...(input.fillerBytes === undefined ? {} : { filler: "x".repeat(input.fillerBytes) }),
    },
    receivedAt: input.receivedAt,
    sourceSequence: input.sourceSequence,
  });
}

function seedLegacyMcpUrlInteraction(input: Readonly<{
  interactionId: string;
  paths: ReturnType<typeof resolveStatePaths>;
  processGeneration: number;
  profileId: string;
  sentinel: string;
  sessionId: string;
}>): void {
  const legacy = new Database(input.paths.database, { create: false, strict: true });
  legacy.exec(`
    DROP TRIGGER IF EXISTS provider_interactions_mcp_url_guard_insert;
    DROP TRIGGER IF EXISTS provider_interactions_mcp_url_guard_update;
    DROP TABLE IF EXISTS usage_cloud_upload_anchors;
    DROP TABLE IF EXISTS security_scrub_authority;
    DELETE FROM migrations WHERE version>10;
    PRAGMA user_version=10;
  `);
  const displayJson = JSON.stringify({
    kind: "mcp_elicitation",
    summary: "Authorize the legacy MCP server",
    serverName: "legacy",
    mode: "url",
    url: `https://example.com/oauth?access_token=${input.sentinel}#${input.sentinel}`,
    mayContainSecrets: false,
  });
  legacy.query(
    `INSERT INTO provider_interactions(
       public_id,session_id,profile_id,process_generation,connection_id,
       request_id_type,request_id_number,request_id_text,method,request_digest,
       thread_id,turn_id,item_id,approval_id,kind,state,revision,blocking,
       display_json,response_digest,response_expected_revision,requested_at,updated_at,terminal_at
     ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    input.interactionId,
    input.sessionId,
    input.profileId,
    input.processGeneration,
    "028f1f55-3f10-7c1a-8f7b-c6dc608bcd3b",
    "string",
    null,
    "legacy-url-request",
    "mcpServer/elicitation/request",
    "d".repeat(64),
    "legacy-thread",
    "legacy-turn",
    null,
    null,
    "mcp_elicitation",
    "pending",
    1,
    1,
    displayJson,
    null,
    null,
    5_000,
    5_000,
    null,
  );
  legacy.query(
    `INSERT INTO provider_interaction_transitions(
       public_id,revision,state,response_digest,recorded_at
     ) VALUES (?,1,'pending',NULL,5000)`,
  ).run(input.interactionId);
  legacy.close(false);
}

function seedLegacyPermissionValueInteraction(input: Readonly<{
  interactionId: string;
  paths: ReturnType<typeof resolveStatePaths>;
  processGeneration: number;
  profileId: string;
  sentinel: string;
  sessionId: string;
}>): void {
  const legacy = new Database(input.paths.database, { create: false, strict: true });
  legacy.exec(`
    PRAGMA secure_delete=OFF;
    DROP TRIGGER IF EXISTS provider_interactions_permission_value_guard_insert;
    DROP TRIGGER IF EXISTS provider_interactions_permission_value_guard_update;
    DELETE FROM migrations WHERE version=15;
    PRAGMA user_version=14;
  `);
  const legacyPrivatePath = ["", "Users", "alice", "private"].join("/");
  const displayJson = JSON.stringify({
    kind: "permission_approval",
    summary: "Allow legacy permissions",
    reason: null,
    requested: [{
      name: "fileSystem",
      value: { read: [`${legacyPrivatePath}/${input.sentinel}${"x".repeat(1_536)}`] },
    }],
    allowsSessionScope: true,
  });
  legacy.query(
    `INSERT INTO provider_interactions(
       public_id,session_id,profile_id,process_generation,connection_id,
       request_id_type,request_id_number,request_id_text,method,request_digest,
       thread_id,turn_id,item_id,approval_id,kind,state,revision,blocking,
       display_json,response_digest,response_expected_revision,requested_at,updated_at,terminal_at
     ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    input.interactionId,
    input.sessionId,
    input.profileId,
    input.processGeneration,
    "038f1f55-3f10-7c1a-8f7b-c6dc608bcd3b",
    "string",
    null,
    "legacy-permission-request",
    "item/permissions/requestApproval",
    "e".repeat(64),
    "legacy-thread",
    "legacy-turn",
    "legacy-item",
    null,
    "permission_approval",
    "pending",
    1,
    1,
    displayJson,
    null,
    null,
    5_000,
    5_000,
    null,
  );
  legacy.query(
    `INSERT INTO provider_interaction_transitions(
       public_id,revision,state,response_digest,recorded_at
     ) VALUES (?,1,'pending',NULL,5000)`,
  ).run(input.interactionId);
  expect(legacy.query("PRAGMA wal_checkpoint(TRUNCATE)").get()).toEqual({
    busy: 0,
    log: 0,
    checkpointed: 0,
  });
  legacy.close(false);
}

function simulateLogicallyRedactedMcpDatabase(input: Readonly<{
  interactionId: string;
  paths: ReturnType<typeof resolveStatePaths>;
  targetVersion: 11 | 12 | 13;
}>): void {
  const legacy = new Database(input.paths.database, { create: false, strict: true });
  legacy.exec(`
    PRAGMA secure_delete=OFF;
    DROP TRIGGER IF EXISTS provider_interactions_authority_immutable;
  `);
  expect(legacy.query("PRAGMA wal_checkpoint(TRUNCATE)").get()).toEqual({
    busy: 0,
    log: 0,
    checkpointed: 0,
  });
  legacy.query(
    `UPDATE provider_interactions
     SET state='resolution_unknown',revision=revision+1,display_json=?,updated_at=9000,terminal_at=9000
     WHERE public_id=? AND revision=1`,
  ).run(JSON.stringify({
    kind: "mcp_elicitation",
    summary: "Unsupported MCP browser handoff canceled during security migration",
    serverName: "redacted",
    mode: "form",
    url: null,
    mayContainSecrets: true,
  }), input.interactionId);
  legacy.query(
    `INSERT INTO provider_interaction_transitions(
       public_id,revision,state,response_digest,recorded_at
     ) SELECT public_id,revision,state,response_digest,9000
       FROM provider_interactions WHERE public_id=?`,
  ).run(input.interactionId);
  legacy.query("INSERT INTO migrations(version,applied_at) VALUES (11,9000)").run();
  if (input.targetVersion >= 12) {
    legacy.exec(`
      CREATE TABLE usage_cloud_upload_anchors (
        profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
        source_revision INTEGER NOT NULL CHECK(source_revision >= 0),
        received_at INTEGER NOT NULL CHECK(received_at >= 0),
        PRIMARY KEY(profile_id, source_revision)
      ) STRICT;
      CREATE INDEX usage_cloud_upload_anchors_recent
        ON usage_cloud_upload_anchors(profile_id, source_revision DESC);
      INSERT INTO migrations(version,applied_at) VALUES (12,9000);
    `);
  }
  if (input.targetVersion === 13) {
    legacy.exec(`
      CREATE TABLE security_scrub_authority (
        singleton INTEGER PRIMARY KEY CHECK(singleton=1),
        reason TEXT NOT NULL CHECK(reason='mcp_url_redaction'),
        required_at INTEGER NOT NULL CHECK(required_at >= 0)
      ) STRICT;
      INSERT INTO migrations(version,applied_at) VALUES (13,9000);
      PRAGMA user_version=13;
    `);
  } else if (input.targetVersion === 12) {
    legacy.exec("PRAGMA user_version=12");
  } else {
    legacy.exec("PRAGMA user_version=11");
  }
  expect(legacy.query("PRAGMA wal_checkpoint(TRUNCATE)").get()).toEqual({
    busy: 0,
    log: 0,
    checkpointed: 0,
  });
  legacy.close(false);
}

async function stateFileSuffixesContaining(databasePath: string, value: string): Promise<string[]> {
  const matches: string[] = [];
  for (const suffix of ["", "-wal", "-shm"] as const) {
    const file = Bun.file(`${databasePath}${suffix}`);
    if (
      await file.exists()
      && Buffer.from(await file.arrayBuffer()).includes(Buffer.from(value))
    ) matches.push(suffix);
  }
  return matches;
}

function moveQueueTo(store: StateStore, queueId: ReturnType<StateStore["enqueue"]>["id"], state: QueueState): void {
  if (state === "pending") return;
  if (state === "cancelled") {
    expect(store.transitionQueue(queueId, "pending", "cancelled")).toBe(true);
    return;
  }
  expect(store.transitionQueue(queueId, "pending", "dispatching")).toBe(true);
  if (state !== "dispatching") {
    expect(store.transitionQueue(queueId, "dispatching", state)).toBe(true);
  }
}

describe("StateStore", () => {
  test("creates the main database as an exact private single-link file", async () => {
    const { store } = await fixture();
    const metadata = await lstat(store.paths.database);

    expect(metadata.isFile()).toBe(true);
    expect(metadata.isSymbolicLink()).toBe(false);
    expect(metadata.nlink).toBe(1);
    expect(metadata.mode & 0o777).toBe(0o600);
    const owner = process.getuid?.();
    if (owner !== undefined) expect(metadata.uid).toBe(owner);
  });

  test("fails closed without chmod when an existing database is permission-unsafe", async () => {
    const { store } = await fixture();
    const paths = store.paths;
    store.close();
    stores.splice(stores.indexOf(store), 1);
    await chmod(paths.database, 0o644);

    expect(() => new StateStore(paths)).toThrow("STATE_DATABASE_FILE_UNSAFE");
    expect(() => new StateStore(paths, { readonly: true }))
      .toThrow("STATE_DATABASE_FILE_UNSAFE");
    expect((await lstat(paths.database)).mode & 0o777).toBe(0o644);
  });

  test("refuses a symlink at the main database boundary before SQLite opens it", async () => {
    const home = await realpath(await mkdtemp(join(tmpdir(), "hra-store-link-")));
    const paths = resolveStatePaths({ homeDirectory: home, platform: "darwin" });
    await initializeStatePaths(paths);
    const target = join(paths.root, "database-target");
    await writeFile(target, "not-a-database", { mode: 0o600 });
    await symlink(target, paths.database);

    expect(() => new StateStore(paths)).toThrow("STATE_DATABASE_FILE_UNSAFE");
    expect(await Bun.file(target).text()).toBe("not-a-database");
  });

  test("refuses a symlink swapped in after the main database precheck", async () => {
    const { store } = await fixture();
    const paths = store.paths;
    store.close();
    stores.splice(stores.indexOf(store), 1);
    const original = `${paths.database}.validated`;
    const target = `${paths.database}.target`;
    await writeFile(target, "target-must-remain-untouched", { mode: 0o600 });
    let observedFlags = 0;

    let failure: unknown;
    try {
      new StateStore(paths, {
        beforeDatabaseOpen: ({ flags, path }) => {
          observedFlags = flags;
          renameSync(path, original);
          symlinkSync(target, path);
        },
      });
    } catch (error: unknown) {
      failure = error;
    }

    expect(observedFlags).toBe(
      sqliteConstants.SQLITE_OPEN_READWRITE
        | sqliteConstants.SQLITE_OPEN_CREATE
        | sqliteConstants.SQLITE_OPEN_NOFOLLOW,
    );
    expect(failure).toMatchObject({
      code: "SQLITE_CANTOPEN_SYMLINK",
      errno: 1_550,
    });
    expect(await Bun.file(target).text()).toBe("target-must-remain-untouched");
    const originalMetadata = await lstat(original);
    expect(originalMetadata.isFile()).toBe(true);
    expect(originalMetadata.nlink).toBe(1);
    expect(originalMetadata.mode & 0o777).toBe(0o600);
  });

  test("isolates profiles and fences process generations", async () => {
    const { store } = await fixture();
    const work = store.createProfile("Work");
    const personal = store.createProfile("Personal");
    expect(work.id).not.toBe(personal.id);
    expect(store.nextProfileGeneration(work.id).processGeneration).toBe(1);
    expect(store.setProfileState(work.id, 0, "signed_in")).toBe(false);
    expect(store.setProfileState(work.id, 1, "signed_in", { email: "work@example.com", plan: "Plus" })).toBe(true);
    expect(store.requireProfile("work").providerEmail).toBe("work@example.com");
  });

  test("a new daemon boot fences every prior provider process and terminalizes callbacks", async () => {
    const { store } = await fixture();
    const profile = signInProfile(store, "Daemon restart", "restart@example.com");
    const session = store.createSession({
      profileId: profile.id,
      preset: "high",
      fastEnabled: false,
    });
    store.bindSession({
      sessionId: session.id,
      expectedRevision: session.revision,
      providerThreadId: "thread-restart",
      state: "idle",
    });
    const admit = (publicId: string, requestId: string) => store.admitInteraction({
      publicId,
      sessionId: session.id,
      authority: {
        profileId: profile.id,
        processGeneration: profile.processGeneration,
        connectionId: "10000000-0000-4000-8000-000000000001",
        requestId: { type: "string" as const, value: requestId },
        method: "item/fileChange/requestApproval",
        requestDigest: requestId.repeat(64).slice(0, 64),
        threadId: "thread-restart",
        turnId: "turn-restart",
        itemId: `item-${requestId}`,
        approvalId: null,
      },
      kind: "file_change_approval" as const,
      blocking: true,
      display: {
        kind: "file_change_approval" as const,
        summary: "Apply bounded changes",
        reason: null,
        grantRoot: null,
        availableDecisions: ["once" as const, "decline" as const, "cancel" as const],
      },
    }).record;
    const pending = admit("10000000-0000-4000-8000-000000000002", "a");
    const prepared = store.prepareInteractionResponse({
      id: admit("10000000-0000-4000-8000-000000000003", "b").publicId,
      expectedRevision: 1,
      responseDigest: "c".repeat(64),
    });

    expect(store.nextDaemonGeneration(`boot_${"d".repeat(32)}`)).toBe(1);
    expect(store.requireProfileById(profile.id).processGeneration).toBe(2);
    expect(store.requireInteraction(pending.publicId)).toMatchObject({
      state: "expired",
      revision: 2,
    });
    expect(store.requireInteraction(prepared.publicId)).toMatchObject({
      state: "resolution_unknown",
      revision: 3,
    });
    expect(store.listSessionEvents({
      sessionId: session.id,
      afterSequence: null,
      limit: 10,
    }).events).toMatchObject([{
      providerGeneration: 2,
      providerConnectionId: null,
      body: { type: "gap", reason: "provider_restart" },
    }]);
    expect(store.nextDaemonGeneration(`boot_${"e".repeat(32)}`)).toBe(2);
    expect(store.requireProfileById(profile.id).processGeneration).toBe(3);
  });

  test("keeps profile recovery absorbing", async () => {
    const { store } = await fixture();
    const profile = signInProfile(store, "Profile recovery", "profile@example.com");
    expect(store.setProfileState(profile.id, profile.processGeneration, "recovery_required", {
      ...(profile.providerEmail === undefined ? {} : { email: profile.providerEmail }),
      ...(profile.providerPlan === undefined ? {} : { plan: profile.providerPlan }),
    })).toBe(true);
    expect(store.setProfileState(profile.id, profile.processGeneration, "signed_in", { email: "notification@example.com" })).toBe(false);
    expect(store.requireProfile(profile.id)).toMatchObject({ state: "recovery_required", providerEmail: "profile@example.com" });
  });

  test("enforces the selector's Unicode label identity without effects", async () => {
    const { store, home } = await fixture();
    const account = store.createProfile("Équipe");
    expect(() => store.createProfile("équipe")).toThrow();
    expect(store.requireProfile("e\u0301QUIPE").id).toBe(account.id);

    const firstRoot = join(home, "Café");
    const secondRoot = join(home, "Cafe-decomposed");
    await mkdir(firstRoot);
    await mkdir(secondRoot);
    const project = await store.createProject("Café", firstRoot);
    await expect(store.createProject("Cafe\u0301", secondRoot)).rejects.toThrow();
    expect(store.requireProject("CAFE\u0301").id).toBe(project.id);
    expect(() => store.requireProfile("missing")).toThrow(SelectionError);
  });

  test("holds the two device-command switches with their shipped defaults", async () => {
    const { store } = await fixture();
    // Commands are allowed because a browser is already an enrolled key holder;
    // account linking is denied because relaying a login is the one command that
    // hands a credential path to another surface.
    expect(store.readDeviceCommandPolicy()).toEqual({
      accountLinkingAllowed: false,
      deviceCommandsAllowed: true,
    });
    store.setDeviceCommandsAllowed(false);
    store.setAccountLinkingAllowed(true);
    expect(store.readDeviceCommandPolicy()).toEqual({
      accountLinkingAllowed: true,
      deviceCommandsAllowed: false,
    });
    store.setDeviceCommandsAllowed(true);
    expect(store.readDeviceCommandPolicy().deviceCommandsAllowed).toBe(true);
  });

  test("counts device commands per requesting device and notifies once", async () => {
    const { store } = await fixture();
    expect(store.readDeviceCommandLedger("device_browser1")).toEqual({
      dayCount: 0,
      dayKey: 0,
      firstSessionStartNotifiedAt: null,
    });
    store.recordDeviceCommandAdmission({
      dayCount: 1,
      dayKey: 20_000,
      devicePublicId: "device_browser1",
      notifiedFirstSessionStart: true,
    });
    const first = store.readDeviceCommandLedger("device_browser1");
    expect(first).toMatchObject({ dayCount: 1, dayKey: 20_000 });
    expect(first.firstSessionStartNotifiedAt).not.toBeNull();
    // The notice timestamp is written once and never cleared, so the desktop
    // notice fires exactly once for a given device.
    store.recordDeviceCommandAdmission({
      dayCount: 2,
      dayKey: 20_001,
      devicePublicId: "device_browser1",
      notifiedFirstSessionStart: false,
    });
    expect(store.readDeviceCommandLedger("device_browser1")).toMatchObject({
      dayCount: 2,
      dayKey: 20_001,
      firstSessionStartNotifiedAt: first.firstSessionStartNotifiedAt,
    });
    // A second device keeps its own bucket and its own first notice.
    expect(store.readDeviceCommandLedger("device_browser2").firstSessionStartNotifiedAt)
      .toBeNull();
    expect(() => store.readDeviceCommandLedger("no")).toThrow();
  });

  test("a browser-started session inherits the project's approval mode", async () => {
    const { store, home } = await fixture();
    const repository = join(home, "Inherit");
    await mkdir(repository);
    const project = await store.createProject("Inherit", repository, true);
    expect(store.readProjectApprovalMode(project.id))
      .toEqual({ mode: "auto:all", source: "default" });
    store.setDefaultApprovalMode("manual");
    expect(store.readProjectApprovalMode(project.id))
      .toEqual({ mode: "manual", source: "default" });
    store.setProjectApprovalMode(project.id, "auto:workspace");
    expect(store.readProjectApprovalMode(project.id))
      .toEqual({ mode: "auto:workspace", source: "project" });
    store.setProjectApprovalMode(project.id, null);
    expect(store.readProjectApprovalMode(project.id))
      .toEqual({ mode: "manual", source: "default" });
    expect(() => store.setProjectApprovalMode("proj_missing00000000", "manual")).toThrow();
  });

  test("creates a project and session with CAS metadata", async () => {
    const { store, home } = await fixture();
    const repository = join(home, "Documents");
    await mkdir(repository);
    const profile = store.createProfile("Main");
    const project = await store.createProject("Documents", repository, true);
    const session = store.createSession({ profileId: profile.id, projectId: project.id, preset: "high", fastEnabled: true });
    const bound = store.bindSession({ sessionId: session.id, expectedRevision: 1, providerThreadId: "thread-provider", state: "idle" });
    const updated = store.updateSessionMetadata({ sessionId: session.id, expectedRevision: bound.revision, title: "Release work", note: "Check the package." });
    expect(updated.title).toBe("Release work");
    expect(updated.note).toBe("Check the package.");
    expect(updated.fastEnabled).toBe(true);
  });

  test("keeps imported sessions legacy until an explicit preset selection", async () => {
    const { store } = await fixture();
    const profile = store.createProfile("Preset contracts");
    const created = store.createSession({
      profileId: profile.id,
      preset: "high",
      fastEnabled: false,
    });
    expect(store.requireSessionPresetRequirement(created.id)).toEqual({
      preset: "high",
      requirement: { model: "gpt-6-astra", effort: "max" },
    });

    const imported = store.upsertProviderSession({
      profileId: profile.id,
      providerThreadId: "thread-imported-contract",
      title: "Imported",
      state: "idle",
    });
    expect(store.requireSessionPresetRequirement(imported.id)).toEqual({
      preset: "high",
      requirement: { model: "gpt-5.6-sol", effort: "max" },
    });
    const renamed = store.updateSessionMetadata({
      sessionId: imported.id,
      expectedRevision: imported.revision,
      title: "Still legacy",
    });
    expect(store.requireSessionPresetRequirement(imported.id).requirement.model)
      .toBe("gpt-5.6-sol");
    store.updateSessionMetadata({
      sessionId: imported.id,
      expectedRevision: renamed.revision,
      preset: "high",
    });
    expect(store.requireSessionPresetRequirement(imported.id).requirement.model)
      .toBe("gpt-6-astra");
  });

  test("settles immutable legacy evidence before permitting a preset-contract upgrade", async () => {
    const { store } = await fixture();
    const profile = signInProfile(store, "Legacy recovery preset", "legacy-recovery@example.com");
    const session = store.upsertProviderSession({
      profileId: profile.id,
      providerThreadId: "thread-legacy-recovery-preset",
      title: "Legacy recovery preset",
      state: "idle",
      providerUpdatedAt: 10,
    });
    const runtimeProfile = {
      approvalPolicy: "on-request" as const,
      computerUse: true as const,
      enabledApps: [],
      fast: false,
      model: "gpt-5.6-sol",
      observedAt: 2_000,
      permissionProfile: ":workspace" as const,
      pluginCapability: true as const,
      preset: "high" as const,
      processGeneration: profile.processGeneration,
      profileId: profile.id,
      reasoningEffort: "max" as const,
      reviewMode: "auto_review" as const,
      serviceTier: null,
    };
    const idempotencyKey = "00000000-0000-4000-8000-0000000006c0";
    const attempt = store.prepareMutation({
      authorityGeneration: profile.processGeneration,
      authorityId: session.id,
      idempotencyKey,
      kind: "session.send",
      request: { message: "legacy recovery" },
    });
    const evidence = store.beginSessionMutationEffect({
      attemptId: attempt.id,
      sessionId: session.id,
      profileGeneration: profile.processGeneration,
      message: "legacy recovery",
      evidence: {
        baseline: { activeTurnId: null, providerUpdatedAt: 10, status: "idle" },
        clientMessageId: attempt.id,
        kind: "session.send",
        messageDigest: createHash("sha256").update("legacy recovery").digest("hex"),
        providerThreadId: "thread-legacy-recovery-preset",
        runtimeProfile,
      },
    });
    expect(store.transitionMutation(attempt.id, "effect_started", "ambiguous", {
      code: "LOST_RESPONSE",
    })).toBe(true);
    const quarantined = store.quarantineSession(session.id);
    expect(() => store.updateSessionMetadata({
      expectedRevision: quarantined.revision,
      preset: "high",
      sessionId: session.id,
    })).toThrow("SESSION_PRESET_RECOVERY_REQUIRED");

    const recovered = store.resolveSessionMutation({
      attemptId: attempt.id,
      expectedEvidenceDigest: evidence.digest,
      expectedOriginalState: "ambiguous",
      provider: {
        providerThreadId: "thread-legacy-recovery-preset",
        providerUpdatedAt: 11,
        status: "idle",
        title: "Legacy recovery preset",
      },
      receipt: { turnId: "turn-legacy-recovery-preset" },
      message: "legacy recovery",
      resolution: "proven_applied",
      resolutionEvidence: { providerUpdatedAt: 11, source: "thread/read" },
    });
    expect(recovered.state).toBe("idle");
    expect(recovered.messageEvent).toMatchObject({
      appended: true,
      event: {
        body: {
          type: "user_message",
          actor: "human",
          text: "legacy recovery",
        },
      },
    });
    expect(store.readSessionMessageEventSource(session.id, attempt.id))
      .toMatchObject({ actor: "human", sourceKind: "mutation" });
    expect(store.runtimeProfileForTurn(session.id, "turn-legacy-recovery-preset"))
      .toEqual(runtimeProfile);
    expect(store.requireSessionPresetRequirement(session.id).requirement)
      .toEqual({ model: "gpt-5.6-sol", effort: "max" });

    store.updateSessionMetadata({
      expectedRevision: recovered.revision,
      preset: "high",
      sessionId: session.id,
    });
    expect(store.requireSessionPresetRequirement(session.id).requirement)
      .toEqual({ model: "gpt-6-astra", effort: "max" });
  });

  test("records the session provider and refuses another provider's preset", async () => {
    const { store } = await fixture();
    const profile = store.createProfile("Providers");

    // Every existing path is unchanged: no provider named means Codex.
    const codex = store.createSession({ profileId: profile.id, preset: "high", fastEnabled: false });
    expect(codex.provider).toBe("codex");
    expect(codex.preset).toBe("high");

    const claude = store.createSession({
      profileId: profile.id,
      preset: "fable-max",
      provider: "claude",
      fastEnabled: false,
    });
    expect(claude.provider).toBe("claude");
    expect(claude.preset).toBe("fable-max");
    expect(store.requireSession(claude.id).preset).toBe("fable-max");

    expect(() => store.createSession({
      profileId: profile.id,
      preset: "fable-max",
      fastEnabled: false,
    })).toThrow("does not support the `fable-max` model preset");
    expect(() => store.createSession({
      profileId: profile.id,
      preset: "ultra",
      provider: "claude",
      fastEnabled: false,
    })).toThrow("does not support the `ultra` model preset");

    // A preset change is refused, never silently ignored.
    expect(() => store.updateSessionMetadata({
      sessionId: claude.id,
      expectedRevision: claude.revision,
      preset: "ultra",
    })).toThrow("does not support the `ultra` model preset");
    expect(() => store.updateSessionMetadata({
      sessionId: codex.id,
      expectedRevision: codex.revision,
      preset: "fable-max",
    })).toThrow("does not support the `fable-max` model preset");
    expect(store.requireSession(claude.id).preset).toBe("fable-max");
  });

  test("reads the daemon default preset against the named provider", async () => {
    const { store } = await fixture();
    expect(store.readDefaultPreset()).toBe("ultra");
    expect(store.readDefaultPreset("claude")).toBe("fable-max");
    store.setDefaultPreset("fable-max");
    expect(store.readDefaultPreset()).toBe("ultra");
    expect(store.readDefaultPreset("claude")).toBe("fable-max");
    store.setDefaultPreset("low");
    expect(store.readDefaultPreset()).toBe("low");
    expect(() => store.readDefaultPreset("claude")).toThrow("No claude model preset exists");
  });

  test("archives sessions out of the default listing and keeps them readable", async () => {
    const { store } = await fixture();
    const profile = store.createProfile("Archive");
    const kept = store.createSession({ profileId: profile.id, preset: "high", fastEnabled: false });
    const archived = store.createSession({ profileId: profile.id, preset: "high", fastEnabled: false });
    expect(store.requireSession(archived.id).archivedAt).toBeUndefined();

    const marked = store.setSessionArchived(archived.id, true);
    expect(marked.archivedAt).toBeGreaterThan(0);
    // Archive is presentation state, not session authority: the revision is
    // untouched so an in-flight optimistic update still applies.
    expect(marked.revision).toBe(archived.revision);
    expect(store.listSessions(50).map((session) => session.id)).toEqual([kept.id]);
    expect(store.listSessions(50, profile.id).map((session) => session.id)).toEqual([kept.id]);
    expect(store.listSessions(50, undefined, true).map((session) => session.id).sort())
      .toEqual([kept.id, archived.id].sort());
    expect(store.listLocalSessionPage({ profileId: profile.id, after: null, limit: 50 })
      .sessions.map((session) => session.id)).toEqual([kept.id]);
    expect(store.listLocalSessionPage({ profileId: profile.id, after: null, includeArchived: true, limit: 50 })
      .sessions).toHaveLength(2);
    // The session itself is never hidden from a direct read.
    expect(store.requireSession(archived.id).id).toBe(archived.id);

    expect(store.setSessionArchived(archived.id, false).archivedAt).toBeUndefined();
    expect(store.listSessions(50)).toHaveLength(2);
    expect(() => store.setSessionArchived("sess_00000000000000000000000000000001", true))
      .toThrow(SelectionError);
  });

  test("keeps show-thinking and the default preset as daemon settings with session overrides", async () => {
    const { store } = await fixture();
    const profile = store.createProfile("Settings");
    const session = store.createSession({ profileId: profile.id, preset: "high", fastEnabled: false });

    expect(store.readDefaultShowThinking()).toBe(false);
    expect(store.readSessionShowThinking(session.id)).toEqual({ enabled: false, source: "default" });
    store.setSessionShowThinking(session.id, true);
    expect(store.readSessionShowThinking(session.id)).toEqual({ enabled: true, source: "session" });
    store.setDefaultShowThinking(true);
    store.setSessionShowThinking(session.id, false);
    expect(store.readSessionShowThinking(session.id)).toEqual({ enabled: false, source: "session" });
    store.setSessionShowThinking(session.id, null);
    expect(store.readSessionShowThinking(session.id)).toEqual({ enabled: true, source: "default" });
    expect(() => store.setSessionShowThinking("sess_00000000000000000000000000000001", true))
      .toThrow(SelectionError);

    expect(store.readDefaultPreset()).toBe("ultra");
    store.setDefaultPreset("low");
    expect(store.readDefaultPreset()).toBe("low");
    expect(() => store.setDefaultPreset("max" as "low")).toThrow();
  });

  test("keeps session recovery absorbing across passive and exact-state reconciliation", async () => {
    const { store } = await fixture();
    const profile = signInProfile(store, "Recovery", "recovery@example.com");
    const local = store.createSession({ profileId: profile.id, preset: "high", fastEnabled: false });
    const bound = store.bindSession({
      sessionId: local.id,
      expectedRevision: local.revision,
      providerThreadId: "thread-recovery",
      state: "idle",
      providerUpdatedAt: 10,
    });
    const quarantined = store.quarantineSession(bound.id);
    expect(quarantined).toMatchObject({ state: "recovery_required", providerUpdatedAt: 10 });

    const passive = store.upsertProviderSession({
      profileId: profile.id,
      providerThreadId: "thread-recovery",
      title: "Passive projection",
      state: "active",
      activeTurnId: "turn-passive",
      providerUpdatedAt: 11,
    });
    expect(passive).toMatchObject({ state: "recovery_required", title: "Untitled session", revision: quarantined.revision });

    expect(store.reconcileSessionFromProvider({ sessionId: quarantined.id, state: "active", activeTurnId: "turn-exact", title: "Exact projection" })).toEqual(quarantined);
    expect(() => store.resolveSessionStatusRecovery({
      sessionId: quarantined.id,
      expectedRevision: quarantined.revision,
      resolution: "provider_state_reconciled",
      provider: {
        providerThreadId: "thread-recovery",
        title: "Missing active turn",
        status: "active",
        providerUpdatedAt: 12,
      },
    })).toThrow("SESSION_STATUS_RECOVERY_ACTIVE_TURN_MISSING");
    expect(store.requireSession(quarantined.id)).toEqual(quarantined);
  });

  test("deletes only exact unbound and evidence-free starting sessions", async () => {
    const { store } = await fixture();
    const profile = store.createProfile("Cleanup");
    const removable = store.createSession({
      profileId: profile.id,
      preset: "high",
      fastEnabled: false,
    });
    expect(store.deleteUnboundStartingSession(removable.id, removable.revision + 1)).toBe(false);
    expect(store.deleteUnboundStartingSession(removable.id, removable.revision)).toBe(true);
    expect(() => store.requireSession(removable.id)).toThrow(SelectionError);

    const bound = store.createSession({ profileId: profile.id, preset: "high", fastEnabled: false });
    store.bindSession({
      sessionId: bound.id,
      expectedRevision: bound.revision,
      providerThreadId: "thread-bound",
      state: "idle",
    });
    expect(store.deleteUnboundStartingSession(bound.id, bound.revision)).toBe(false);

    const queued = store.createSession({ profileId: profile.id, preset: "high", fastEnabled: false });
    store.enqueue(queued.id, "retained queue evidence");
    expect(store.deleteUnboundStartingSession(queued.id, queued.revision)).toBe(false);

    const summarized = store.createSession({ profileId: profile.id, preset: "high", fastEnabled: false });
    const database = new Database(store.paths.database, { create: false, strict: true });
    try {
      database
        .query("INSERT INTO turn_summaries(session_id,turn_id,sequence,summary_json,created_at) VALUES (?,?,?,?,?)")
        .run(summarized.id, "turn-1", 0, "{}", 1_000);
    } finally {
      database.close(false);
    }
    expect(store.deleteUnboundStartingSession(summarized.id, summarized.revision)).toBe(false);
  });

  test("persists idempotent mutation receipts and rejects changed reuse", async () => {
    const { store } = await fixture();
    const key = "b83efca6-d731-498e-ac2c-876555a4ae2d";
    const first = store.prepareMutation({ kind: "turn.start", authorityId: "session", authorityGeneration: 1, request: { message: "hello" }, idempotencyKey: key });
    expect(first.replay).toBe(false);
    expect(store.transitionMutation(first.id, "prepared", "effect_started")).toBe(true);
    expect(store.transitionMutation(first.id, "effect_started", "applied", { turnId: "turn-1" })).toBe(true);
    expect(store.prepareMutation({ kind: "turn.start", authorityId: "session", authorityGeneration: 1, request: { message: "hello" }, idempotencyKey: key })).toMatchObject({ replay: true, state: "applied", result: { turnId: "turn-1" } });
    expect(() => store.prepareMutation({ kind: "turn.start", authorityId: "session", authorityGeneration: 1, request: { message: "changed" }, idempotencyKey: key })).toThrow("IDEMPOTENCY_CONFLICT");
  });

  test("leaves a crash before effect dispatch replayable without quarantining its authority", async () => {
    const { store } = await fixture();
    const profile = signInProfile(store, "Prepared crash", "prepared@example.com");
    const local = store.createSession({ profileId: profile.id, preset: "high", fastEnabled: false });
    const session = store.bindSession({ sessionId: local.id, expectedRevision: local.revision, providerThreadId: "thread-prepared", state: "idle", providerUpdatedAt: 5 });
    const input = { kind: "session.send", authorityId: session.id, authorityGeneration: profile.processGeneration, request: { message: "prepared" }, idempotencyKey: "00000000-0000-4000-8000-000000000609" } as const;
    const attempt = store.prepareMutation(input);
    expect(attempt).toMatchObject({ state: "prepared", replay: false });
    expect(store.recoverEffectStartedMutations()).toEqual({ recovered: [], unresolved: [] });
    expect(store.requireSession(session.id)).toMatchObject({ state: "idle" });
    expect(store.prepareMutation(input)).toMatchObject({ id: attempt.id, state: "prepared", replay: true });
  });

  test("fences one-shot Claude login grants and settles the exact joined outcome", async () => {
    const { store } = await fixture();
    const created = store.createProfile("Claude auth");
    const profile = store.nextProfileGeneration(created.id);
    const key = "00000000-0000-4000-8000-000000000611";
    const attempt = store.prepareMutation({
      kind: "account.claude-login",
      authorityId: profile.id,
      authorityGeneration: profile.processGeneration,
      request: { provider: "claude" },
      idempotencyKey: key,
    });
    store.beginClaudeLoginMutationEffect({
      attemptId: attempt.id,
      profileId: profile.id,
      profileGeneration: profile.processGeneration,
      evidence: { kind: "account.claude-login", provider: "claude", baselineSignedIn: false },
    });
    expect(store.readMutation(key)).toMatchObject({
      id: attempt.id,
      state: "effect_started",
      evidence: { evidence: { kind: "account.claude-login", provider: "claude" } },
    });
    expect(store.providerAuthorityAdvanceBlocker(profile.id, "claude"))
      .toBe("unsettled_authority");
    expect(() => store.nextProfileGeneration(profile.id))
      .toThrow("CLAUDE_LOGIN_AUTHORITY_UNSETTLED");
    expect(() => store.advanceProfileGeneration(profile.id, profile.processGeneration))
      .toThrow("CLAUDE_LOGIN_AUTHORITY_UNSETTLED");
    expect(() => store.prepareMutation({
      kind: "account.claude-login",
      authorityId: profile.id,
      authorityGeneration: profile.processGeneration,
      request: { provider: "claude" },
      idempotencyKey: "00000000-0000-4000-8000-000000000612",
    })).toThrow("UNSETTLED_MUTATION_AUTHORITY");

    expect(() => store.settleClaudeLoginMutation({
      attemptId: attempt.id,
      idempotencyKey: key,
      profileId: profile.id,
      profileGeneration: profile.processGeneration,
      signedIn: true,
      outcome: { state: "joined", exitCode: 0, interruptedBy: null },
    })).not.toThrow();
    expect(store.readMutation(key)).toMatchObject({ state: "applied" });
    expect(store.providerAuthorityAdvanceBlocker(profile.id, "claude")).toBeNull();
  });

  test("restart advances a generation-zero Claude child launch and keeps it recovery-required", async () => {
    const { store, home } = await fixture();
    const profile = store.createProfile("Claude crash");
    const pristine = store.createProfile("Pristine signed out");
    const key = "00000000-0000-4000-8000-000000000613";
    const attempt = store.prepareMutation({
      kind: "account.claude-login",
      authorityId: profile.id,
      authorityGeneration: profile.processGeneration,
      request: { provider: "claude" },
      idempotencyKey: key,
    });
    store.beginClaudeLoginMutationEffect({
      attemptId: attempt.id,
      profileId: profile.id,
      profileGeneration: profile.processGeneration,
      evidence: { kind: "account.claude-login", provider: "claude", baselineSignedIn: false },
    });
    store.close();

    const restarted = new StateStore(
      resolveStatePaths({ homeDirectory: home, platform: "darwin" }),
      { now: () => 2_000 },
    );
    stores.push(restarted);
    expect(restarted.nextDaemonGeneration(`boot_${"0".repeat(32)}`)).toBe(1);
    expect(restarted.requireProfile(profile.id)).toMatchObject({
      state: "signed_out",
      processGeneration: 1,
    });
    expect(restarted.requireProfile(pristine.id)).toMatchObject({
      state: "signed_out",
      processGeneration: 0,
    });
    expect(restarted.recoverEffectStartedMutations()).toEqual({ recovered: [attempt.id], unresolved: [] });
    expect(restarted.readMutation(key)).toMatchObject({ state: "ambiguous" });
    expect(restarted.providerAuthorityAdvanceBlocker(profile.id, "claude"))
      .toBe("unsettled_authority");
    expect(restarted.settleClaudeLoginMutation({
      attemptId: attempt.id,
      idempotencyKey: key,
      profileId: profile.id,
      profileGeneration: 0,
      signedIn: false,
      outcome: { state: "joined", exitCode: 1, interruptedBy: null },
    })).toMatchObject({ providerGeneration: 0, signedIn: false });
    expect(restarted.providerAuthorityAdvanceBlocker(profile.id, "claude")).toBeNull();
  });

  test("reopens across daemon generation advance and resolves the exact historical Claude launch", async () => {
    const { store, home } = await fixture();
    const created = store.createProfile("Claude historical child");
    const profile = store.nextProfileGeneration(created.id);
    const key = "00000000-0000-4000-8000-000000000614";
    const attempt = store.prepareMutation({
      kind: "account.claude-login",
      authorityId: profile.id,
      authorityGeneration: profile.processGeneration,
      request: { provider: "claude" },
      idempotencyKey: key,
    });
    store.beginClaudeLoginMutationEffect({
      attemptId: attempt.id,
      profileId: profile.id,
      profileGeneration: profile.processGeneration,
      evidence: { kind: "account.claude-login", provider: "claude", baselineSignedIn: false },
    });
    store.close();

    const paths = resolveStatePaths({ homeDirectory: home, platform: "darwin" });
    const firstRestart = new StateStore(paths, { now: () => 2_000 });
    stores.push(firstRestart);
    expect(firstRestart.nextDaemonGeneration(`boot_${"e".repeat(32)}`)).toBe(1);
    expect(firstRestart.requireProfileById(profile.id).processGeneration)
      .toBe(profile.processGeneration + 1);
    expect(firstRestart.recoverEffectStartedMutations()).toEqual({
      recovered: [attempt.id],
      unresolved: [],
    });
    expect(firstRestart.readMutation(key)).toMatchObject({ state: "ambiguous" });
    firstRestart.close();

    const restarted = new StateStore(paths, { now: () => 3_000 });
    stores.push(restarted);
    expect(restarted.nextDaemonGeneration(`boot_${"f".repeat(32)}`)).toBe(2);
    expect(restarted.requireProfileById(profile.id).processGeneration)
      .toBe(profile.processGeneration + 2);
    expect(restarted.recoverEffectStartedMutations()).toEqual({ recovered: [], unresolved: [] });
    expect(restarted.readMutation(key)).toMatchObject({ state: "ambiguous" });
    expect(restarted.providerAuthorityAdvanceBlocker(profile.id, "claude"))
      .toBe("unsettled_authority");
    const completion = {
      attemptId: attempt.id,
      idempotencyKey: key,
      profileId: profile.id,
      profileGeneration: profile.processGeneration,
      signedIn: true,
      outcome: { state: "joined" as const, exitCode: 0, interruptedBy: null },
    };
    expect(restarted.settleClaudeLoginMutation(completion)).toMatchObject({
      accountId: profile.id,
      providerGeneration: profile.processGeneration,
      signedIn: true,
    });
    expect(restarted.readMutation(key)).toMatchObject({
      state: "reconciled",
      originalState: "ambiguous",
      resolution: { kind: "proven_applied" },
    });
    expect(restarted.settleClaudeLoginMutation(completion)).toMatchObject({
      signedIn: true,
    });
    expect(restarted.providerAuthorityAdvanceBlocker(profile.id, "claude")).toBeNull();
  });

  test("requires exact live Claude authority for idempotent acknowledged local abandon", async () => {
    const { store } = await fixture();
    const profile = store.createProfile("Claude local abandon");
    const key = "00000000-0000-4000-8000-000000000615";
    const attempt = store.prepareMutation({
      kind: "account.claude-login",
      authorityId: profile.id,
      authorityGeneration: profile.processGeneration,
      request: { provider: "claude" },
      idempotencyKey: key,
    });
    store.beginClaudeLoginMutationEffect({
      attemptId: attempt.id,
      profileId: profile.id,
      profileGeneration: profile.processGeneration,
      evidence: { kind: "account.claude-login", provider: "claude", baselineSignedIn: false },
    });
    const abandon = {
      attemptId: attempt.id,
      idempotencyKey: key,
      profileId: profile.id,
      profileGeneration: profile.processGeneration,
      acknowledgeChildExited: true as const,
    };
    expect(() => store.abandonClaudeLoginMutation({
      ...abandon,
      profileGeneration: profile.processGeneration + 1,
    })).toThrow("CLAUDE_LOGIN_AUTHORITY_MISMATCH");
    expect(store.abandonClaudeLoginMutation(abandon)).toMatchObject({
      acknowledgedChildExited: true,
      accountId: profile.id,
    });
    expect(store.abandonClaudeLoginMutation(abandon)).toMatchObject({
      acknowledgedChildExited: true,
    });
    expect(store.readMutation(key)).toMatchObject({
      state: "reconciled",
      resolution: { kind: "abandoned" },
    });
    expect(() => store.settleClaudeLoginMutation({
      attemptId: attempt.id,
      idempotencyKey: key,
      profileId: profile.id,
      profileGeneration: profile.processGeneration,
      signedIn: false,
      outcome: { state: "joined", exitCode: 1, interruptedBy: null },
    })).toThrow("CLAUDE_LOGIN_TERMINAL_OUTCOME_CONFLICT");

    const settledKey = "00000000-0000-4000-8000-000000000616";
    const settled = store.prepareMutation({
      kind: "account.claude-login",
      authorityId: profile.id,
      authorityGeneration: profile.processGeneration,
      request: { provider: "claude" },
      idempotencyKey: settledKey,
    });
    store.beginClaudeLoginMutationEffect({
      attemptId: settled.id,
      profileId: profile.id,
      profileGeneration: profile.processGeneration,
      evidence: { kind: "account.claude-login", provider: "claude", baselineSignedIn: false },
    });
    store.settleClaudeLoginMutation({
      attemptId: settled.id,
      idempotencyKey: settledKey,
      profileId: profile.id,
      profileGeneration: profile.processGeneration,
      signedIn: false,
      outcome: { state: "not_started", reason: "spawn_failed" },
    });
    expect(() => store.abandonClaudeLoginMutation({
      attemptId: settled.id,
      idempotencyKey: settledKey,
      profileId: profile.id,
      profileGeneration: profile.processGeneration,
      acknowledgeChildExited: true,
    })).toThrow("CLAUDE_LOGIN_NOT_UNSETTLED");
  });

  test("persists and idempotently resolves Devin foreground-login authority across restart", async () => {
    const { store, home } = await fixture();
    const profile = store.createProfile("Devin foreground auth");
    const key = "00000000-0000-4000-8000-000000000617";
    const attempt = store.prepareMutation({
      kind: "account.devin-login",
      authorityId: profile.id,
      authorityGeneration: profile.processGeneration,
      request: { provider: "devin" },
      idempotencyKey: key,
    });
    store.beginDevinLoginMutationEffect({
      attemptId: attempt.id,
      profileId: profile.id,
      profileGeneration: profile.processGeneration,
      evidence: { kind: "account.devin-login", provider: "devin", baselineSignedIn: false },
    });
    expect(store.readMutation(key)).toMatchObject({
      state: "effect_started",
      evidence: { evidence: { kind: "account.devin-login", provider: "devin" } },
    });
    expect(store.providerAuthorityAdvanceBlocker(profile.id, "devin"))
      .toBe("unsettled_authority");
    expect(store.providerAuthorityAdvanceBlocker(profile.id, "codex"))
      .toBe("unsettled_authority");
    expect(() => store.nextProfileGeneration(profile.id))
      .toThrow("DEVIN_LOGIN_AUTHORITY_UNSETTLED");
    store.close();

    const restarted = new StateStore(
      resolveStatePaths({ homeDirectory: home, platform: "darwin" }),
      { now: (() => { let value = 2_000; return () => value++; })() },
    );
    stores.push(restarted);
    expect(restarted.nextDaemonGeneration(`boot_${"d".repeat(32)}`)).toBe(1);
    expect(restarted.requireProfile(profile.id).processGeneration).toBe(1);
    expect(restarted.recoverEffectStartedMutations()).toEqual({
      recovered: [attempt.id],
      unresolved: [],
    });
    const completion = {
      attemptId: attempt.id,
      idempotencyKey: key,
      profileId: profile.id,
      profileGeneration: profile.processGeneration,
      signedIn: true,
      outcome: { state: "joined" as const, exitCode: 0, interruptedBy: null },
    };
    expect(restarted.settleDevinLoginMutation(completion)).toMatchObject({
      accountId: profile.id,
      providerGeneration: profile.processGeneration,
      signedIn: true,
    });
    expect(restarted.settleDevinLoginMutation(completion)).toMatchObject({ signedIn: true });
    expect(restarted.readMutation(key)).toMatchObject({
      state: "reconciled",
      originalState: "ambiguous",
      resolution: { kind: "proven_applied" },
    });

    const current = restarted.requireProfile(profile.id);
    const abandonKey = "00000000-0000-4000-8000-000000000618";
    const abandonedAttempt = restarted.prepareMutation({
      kind: "account.devin-login",
      authorityId: current.id,
      authorityGeneration: current.processGeneration,
      request: { provider: "devin" },
      idempotencyKey: abandonKey,
    });
    restarted.beginDevinLoginMutationEffect({
      attemptId: abandonedAttempt.id,
      profileId: current.id,
      profileGeneration: current.processGeneration,
      evidence: { kind: "account.devin-login", provider: "devin", baselineSignedIn: false },
    });
    const abandon = {
      attemptId: abandonedAttempt.id,
      idempotencyKey: abandonKey,
      profileId: current.id,
      profileGeneration: current.processGeneration,
      acknowledgeChildExited: true as const,
    };
    expect(restarted.abandonDevinLoginMutation(abandon))
      .toMatchObject({ acknowledgedChildExited: true });
    expect(restarted.abandonDevinLoginMutation(abandon))
      .toMatchObject({ acknowledgedChildExited: true });
    expect(restarted.readMutation(abandonKey)).toMatchObject({
      state: "reconciled",
      resolution: { kind: "abandoned" },
    });
    expect(() => restarted.settleDevinLoginMutation({
      attemptId: abandonedAttempt.id,
      idempotencyKey: abandonKey,
      profileId: current.id,
      profileGeneration: current.processGeneration,
      signedIn: false,
      outcome: { state: "joined", exitCode: 1, interruptedBy: null },
    })).toThrow("DEVIN_LOGIN_TERMINAL_OUTCOME_CONFLICT");
  });

  test("classifies effect-started authorities at restart and rejects new keys", async () => {
    const { store } = await fixture();
    const profile = signInProfile(store, "Restart recovery", "restart@example.com");
    const local = store.createSession({ profileId: profile.id, preset: "high", fastEnabled: false });
    const session = store.bindSession({ sessionId: local.id, expectedRevision: local.revision, providerThreadId: "thread-restart", state: "idle" });
    const send = store.prepareMutation({
      kind: "session.send",
      authorityId: session.id,
      authorityGeneration: profile.processGeneration,
      request: { message: "uncertain" },
      idempotencyKey: "00000000-0000-4000-8000-000000000601",
    });
    store.beginSessionMutationEffect({
      attemptId: send.id,
      sessionId: session.id,
      profileGeneration: profile.processGeneration,
      message: "uncertain",
      evidence: {
        kind: "session.send",
        providerThreadId: "thread-restart",
        baseline: { providerUpdatedAt: 10, status: "idle", activeTurnId: null },
        clientMessageId: send.id,
        messageDigest: createHash("sha256").update("uncertain").digest("hex"),
      },
    });
    expect(() => store.prepareMutation({
      kind: "session.send",
      authorityId: session.id,
      authorityGeneration: profile.processGeneration,
      request: { message: "different" },
      idempotencyKey: "00000000-0000-4000-8000-000000000602",
    })).toThrow("UNSETTLED_MUTATION_AUTHORITY");

    expect(store.recoverEffectStartedMutations()).toEqual({ recovered: [send.id], unresolved: [] });
    expect(store.readMutation("00000000-0000-4000-8000-000000000601")).toMatchObject({ state: "ambiguous" });
    expect(store.requireSession(session.id)).toMatchObject({ state: "recovery_required" });
  });

  test("terminalizes only exact quiescent idle Claude authority for account login", async () => {
    const { store } = await fixture();
    const profile = store.createProfile("Claude relink");
    const created = store.createSession({
      fastEnabled: false,
      preset: "fable-max",
      profileId: profile.id,
      provider: "claude",
    });
    let session = store.bindSession({
      expectedRevision: created.revision,
      providerThreadId: "claude-thread-relink",
      sessionId: created.id,
      state: "idle",
    });
    const input = {
      accountId: profile.id,
      providerConnectionId: null,
      providerGeneration: profile.processGeneration,
      sessionId: session.id,
    } as const;

    expect(store.canReleaseIdleClaudeSessionForAccountLogin({
      profileId: profile.id,
      profileGeneration: profile.processGeneration,
      sessionId: session.id,
    })).toBe(true);
    session = store.setSessionTurnState({
      activeTurnId: "claude-turn-relink",
      expectedRevision: session.revision,
      sessionId: session.id,
      state: "active",
    });
    expect(store.canReleaseIdleClaudeSessionForAccountLogin({
      profileId: profile.id,
      profileGeneration: profile.processGeneration,
      sessionId: session.id,
    })).toBe(false);
    expect(() => store.terminalizeIdleClaudeSessionForAccountLogin(input))
      .toThrow("CLAUDE_LOGIN_SESSION_NOT_QUIESCENT");
    session = store.setSessionTurnState({
      expectedRevision: session.revision,
      sessionId: session.id,
      state: "idle",
    });
    const queued = store.enqueue(session.id, "preserve this queued send");
    expect(store.canReleaseIdleClaudeSessionForAccountLogin({
      profileId: profile.id,
      profileGeneration: profile.processGeneration,
      sessionId: session.id,
    })).toBe(false);
    expect(() => store.terminalizeIdleClaudeSessionForAccountLogin(input))
      .toThrow("CLAUDE_LOGIN_SESSION_NOT_QUIESCENT");
    expect(store.requireSession(session.id)).toMatchObject({ state: "idle" });
    expect(store.requireQueue(queued.id)).toMatchObject({ state: "pending" });

    expect(store.transitionQueue(queued.id, "pending", "cancelled")).toBe(true);
    expect(store.terminalizeIdleClaudeSessionForAccountLogin(input)).toMatchObject({
      changed: true,
      event: {
        body: { activeTurnId: null, status: "terminal", type: "session_status" },
      },
      interactions: [],
      session: { provider: "claude", state: "terminal" },
    });
  });

  test("terminalizes only exact quiescent idle Devin authority for account login", async () => {
    const { store } = await fixture();
    const profile = store.createProfile("Devin relink");
    const created = store.createSession({
      fastEnabled: false,
      preset: "astra",
      profileId: profile.id,
      provider: "devin",
    });
    let session = store.bindSession({
      expectedRevision: created.revision,
      providerThreadId: "devin-thread-relink",
      sessionId: created.id,
      state: "idle",
    });
    const input = {
      accountId: profile.id,
      providerConnectionId: null,
      providerGeneration: profile.processGeneration,
      sessionId: session.id,
    } as const;

    expect(store.canReleaseIdleDevinSessionForAccountLogin({
      profileId: profile.id,
      profileGeneration: profile.processGeneration,
      sessionId: session.id,
    })).toBe(true);
    expect(store.canReleaseIdleClaudeSessionForAccountLogin({
      profileId: profile.id,
      profileGeneration: profile.processGeneration,
      sessionId: session.id,
    })).toBe(false);
    session = store.setSessionTurnState({
      activeTurnId: "devin-turn-relink",
      expectedRevision: session.revision,
      sessionId: session.id,
      state: "active",
    });
    expect(store.canReleaseIdleDevinSessionForAccountLogin({
      profileId: profile.id,
      profileGeneration: profile.processGeneration,
      sessionId: session.id,
    })).toBe(false);
    expect(() => store.terminalizeIdleDevinSessionForAccountLogin(input))
      .toThrow("DEVIN_LOGIN_SESSION_NOT_QUIESCENT");
    session = store.setSessionTurnState({
      expectedRevision: session.revision,
      sessionId: session.id,
      state: "idle",
    });
    const queued = store.enqueue(session.id, "preserve this Devin queued send");
    expect(store.canReleaseIdleDevinSessionForAccountLogin({
      profileId: profile.id,
      profileGeneration: profile.processGeneration,
      sessionId: session.id,
    })).toBe(false);
    expect(() => store.terminalizeIdleDevinSessionForAccountLogin(input))
      .toThrow("DEVIN_LOGIN_SESSION_NOT_QUIESCENT");
    expect(store.requireSession(session.id)).toMatchObject({ state: "idle" });
    expect(store.requireQueue(queued.id)).toMatchObject({ state: "pending" });

    expect(store.transitionQueue(queued.id, "pending", "cancelled")).toBe(true);
    expect(store.terminalizeIdleDevinSessionForAccountLogin(input)).toMatchObject({
      changed: true,
      event: {
        body: { activeTurnId: null, status: "terminal", type: "session_status" },
      },
      interactions: [],
      session: { provider: "devin", state: "terminal" },
    });
  });

  test("provider deletion atomically terminalizes pending and in-flight session authority", async () => {
    const { store } = await fixture();
    const profile = signInProfile(store, "Provider deletion", "deleted@example.com");
    const created = store.createSession({
      fastEnabled: false,
      preset: "high",
      profileId: profile.id,
    });
    const session = store.bindSession({
      expectedRevision: created.revision,
      providerThreadId: "thread-provider-deleted",
      sessionId: created.id,
      state: "idle",
    });
    store.prepareMutation({
      authorityGeneration: profile.processGeneration,
      authorityId: session.id,
      idempotencyKey: "00000000-0000-4000-8000-000000000603",
      kind: "session.rename",
      request: { name: "never dispatched" },
    });
    const effect = store.prepareMutation({
      authorityGeneration: profile.processGeneration,
      authorityId: session.id,
      idempotencyKey: "00000000-0000-4000-8000-000000000604",
      kind: "session.rename",
      request: { name: "possibly dispatched" },
    });
    store.beginSessionMutationEffect({
      attemptId: effect.id,
      evidence: {
        baseline: { activeTurnId: null, providerUpdatedAt: 10, status: "idle" },
        kind: "session.rename",
        providerThreadId: "thread-provider-deleted",
        requestedName: "possibly dispatched",
      },
      profileGeneration: profile.processGeneration,
      sessionId: session.id,
    });
    const runtime = {
      approvalPolicy: "on-request" as const,
      computerUse: true as const,
      enabledApps: [],
      fast: false,
      model: "gpt-6-astra",
      permissionProfile: ":workspace" as const,
      pluginCapability: true as const,
      preset: "high" as const,
      processGeneration: profile.processGeneration,
      profileId: profile.id,
      reasoningEffort: "max" as const,
      reviewMode: "auto_review" as const,
      serviceTier: null,
      observedAt: 2_000,
    };
    const queued = store.enqueue(session.id, "possibly dispatched queue");
    store.beginQueueEffect({
      queueId: queued.id,
      sessionId: session.id,
      profileGeneration: profile.processGeneration,
      evidence: {
        baseline: { activeTurnId: null, providerUpdatedAt: 10, status: "idle" },
        clientMessageId: queued.id,
        kind: "queue.dispatch",
        messageDigest: new Bun.CryptoHasher("sha256")
          .update("possibly dispatched queue")
          .digest("hex"),
        profileGeneration: profile.processGeneration,
        providerThreadId: "thread-provider-deleted",
        queueId: queued.id,
        runtimeProfile: runtime,
        sessionId: session.id,
      },
    });

    expect(() => store.terminalizeSessionFromProviderDeletion({
      accountId: profile.id,
      providerConnectionId: null,
      providerGeneration: profile.processGeneration + 1,
      sessionId: session.id,
    })).toThrow("SESSION_EVENT_AUTHORITY_CHANGED");
    expect(store.requireSession(session.id)).toMatchObject({ state: "idle" });
    expect(store.readMutation("00000000-0000-4000-8000-000000000603"))
      .toMatchObject({ state: "prepared" });
    expect(store.readMutation("00000000-0000-4000-8000-000000000604"))
      .toMatchObject({ state: "effect_started" });
    expect(store.requireQueue(queued.id)).toMatchObject({ state: "dispatching" });

    const terminal = store.terminalizeSessionFromProviderDeletion({
      accountId: profile.id,
      providerConnectionId: null,
      providerGeneration: profile.processGeneration,
      sessionId: session.id,
    });
    expect(terminal).toMatchObject({
      changed: true,
      event: {
        body: { activeTurnId: null, status: "terminal", type: "session_status" },
      },
      session: { state: "terminal" },
    });
    expect(store.readMutation("00000000-0000-4000-8000-000000000603"))
      .toMatchObject({ state: "cancelled" });
    expect(store.readMutation("00000000-0000-4000-8000-000000000604"))
      .toMatchObject({
      originalState: "effect_started",
      resolution: {
        evidence: { source: "provider_thread_deleted" },
        kind: "abandoned",
      },
      state: "reconciled",
      });
    expect(store.requireQueue(queued.id)).toMatchObject({ state: "ambiguous" });
    expect(store.readQueueEffect(queued.id)).toMatchObject({
      resolution: {
        evidence: { source: "provider_thread_deleted" },
        kind: "abandoned",
      },
    });
    expect(store.listUnsettledMutations({ sessionId: session.id })).toEqual([]);
    expect(store.listUnsettledQueueEffects(session.id)).toEqual([]);
    expect(store.terminalizeSessionFromProviderDeletion({
      accountId: profile.id,
      providerConnectionId: null,
      providerGeneration: profile.processGeneration,
      sessionId: session.id,
    })).toMatchObject({
      changed: false,
      interactions: [],
      session: { state: "terminal" },
    });
    expect(store.listSessionEvents({
      afterSequence: 0,
      sessionId: session.id,
    }).events.filter((event) =>
      event.body.type === "session_status" && event.body.status === "terminal"))
      .toHaveLength(1);
  });

  test("atomically binds a session-start placeholder before its provider effect is admitted", async () => {
    const { store, home } = await fixture();
    const profile = signInProfile(store, "Bound start", "bound-start@example.com");
    const projectRoot = join(home, "bound-start-project");
    await mkdir(projectRoot);
    const project = await store.createProject("Bound start project", projectRoot, true);
    const attempt = store.prepareMutation({
      kind: "session.start",
      authorityId: profile.id,
      authorityGeneration: profile.processGeneration,
      request: { projectId: project.id, preset: "high", fast: false, message: null },
      idempotencyKey: "00000000-0000-4000-8000-000000000610",
    });
    const session = store.beginSessionStartEffect({
      attemptId: attempt.id,
      profileId: profile.id,
      profileGeneration: profile.processGeneration,
      projectId: project.id,
      preset: "high",
      fastEnabled: false,
      evidence: { kind: "session.start", projectId: project.id, clientMessageId: null, messageDigest: null },
      hostCapabilities: {
        preambleVersion: 1,
        preambleDigest: "a".repeat(64),
        manifestVersion: 1,
        manifestDigest: "b".repeat(64),
      },
    });
    expect(store.requireSessionHostCapabilityBinding(session.id)).toMatchObject({
      preambleVersion: 1,
      preambleDigest: "a".repeat(64),
      manifestVersion: 1,
      manifestDigest: "b".repeat(64),
    });
    expect(store.readMutation("00000000-0000-4000-8000-000000000610")).toMatchObject({
      state: "effect_started",
      sessionStartId: session.id,
      evidence: { evidence: { kind: "session.start", projectId: project.id } },
    });
    expect(store.recoverEffectStartedMutations()).toEqual({ recovered: [attempt.id], unresolved: [] });
    expect(store.requireSession(session.id)).toMatchObject({ state: "recovery_required" });
    expect(store.requireSession(session.id).providerThreadId).toBeUndefined();
  });

  test("keeps a bound unresolved session-start authority current across close and restart advances", async () => {
    const { store, home } = await fixture();
    const profile = signInProfile(store, "Successor lineage", "successor-lineage@example.com");
    const projectRoot = join(home, "successor-lineage-project");
    await mkdir(projectRoot);
    const project = await store.createProject("Successor lineage project", projectRoot, true);
    const runtimeProfile = {
      approvalPolicy: "on-request" as const,
      computerUse: true as const,
      enabledApps: [],
      fast: false,
      model: "gpt-6-astra",
      observedAt: 2_000,
      permissionProfile: ":workspace" as const,
      pluginCapability: true as const,
      preset: "high" as const,
      processGeneration: profile.processGeneration,
      profileId: profile.id,
      reasoningEffort: "max" as const,
      reviewMode: "auto_review" as const,
      serviceTier: null,
    };
    const key = "00000000-0000-4000-8000-0000000006c0";
    const attempt = store.prepareMutation({
      authorityGeneration: profile.processGeneration,
      authorityId: profile.id,
      idempotencyKey: key,
      kind: "session.start",
      request: { fast: false, preset: "high", projectId: project.id },
    });
    const starting = store.beginSessionStartEffect({
      attemptId: attempt.id,
      evidence: {
        clientMessageId: null,
        kind: "session.start",
        messageDigest: null,
        projectId: project.id,
        runtimeProfile,
      },
      fastEnabled: false,
      preset: "high",
      profileGeneration: profile.processGeneration,
      profileId: profile.id,
      projectId: project.id,
      provider: "codex",
    });
    const bound = store.bindSessionStartRecoveryTarget({
      attemptId: attempt.id,
      expectedSessionRevision: starting.revision,
      providerThreadId: "thread-successor-lineage",
      runtimeProfile,
      sessionId: starting.id,
      title: "Successor lineage",
    });
    expect(bound).toMatchObject({
      providerThreadId: "thread-successor-lineage",
      state: "recovery_required",
    });

    const workStore = {
      prepareProfileAuthorityChange: () => [],
    } as unknown as Parameters<StateStore["advanceProfileGenerationWithWorkRetirement"]>[2];
    const closed = store.advanceProfileGenerationWithWorkRetirement(
      profile.id,
      profile.processGeneration,
      workStore,
      { preserveSessionMutationAuthorities: true },
    );
    expect(closed.profile.processGeneration).toBe(profile.processGeneration + 1);
    expect(store.isSessionMutationProviderAuthorityCurrent({
      attemptId: attempt.id,
      originGeneration: profile.processGeneration,
      profileId: profile.id,
      provider: "codex",
    })).toBe(true);

    expect(store.nextDaemonGeneration(`boot_${"c".repeat(32)}`)).toBe(1);
    expect(store.requireProfileById(profile.id).processGeneration)
      .toBe(profile.processGeneration + 2);
    expect(store.isSessionMutationProviderAuthorityCurrent({
      attemptId: attempt.id,
      originGeneration: profile.processGeneration,
      profileId: profile.id,
      provider: "codex",
    })).toBe(true);
    expect(store.readMutation(key)).toMatchObject({ state: "effect_started" });
    expect(store.requireSession(starting.id)).toMatchObject({
      providerThreadId: "thread-successor-lineage",
      state: "recovery_required",
    });
  });

  test("completes a journaled provider switch through successor generations and attributes its seed", async () => {
    const { store } = await fixture();
    const source = signInProfile(store, "Switch successor source", "switch-source@example.com");
    const target = signInProfile(store, "Switch successor target", "switch-target@example.com");
    const created = store.createSession({
      profileId: source.id,
      preset: "high",
      fastEnabled: false,
    });
    const session = store.bindSession({
      sessionId: created.id,
      expectedRevision: created.revision,
      providerThreadId: "thread-switch-successor-source",
      state: "idle",
    });
    const targetRuntime = codexRuntimeProfile(target, 2_100);
    const seedText = "Continue after the provider switch.";
    const seedDigest = createHash("sha256")
      .update("hra:session-transcript-seed:v1\0", "utf8")
      .update(seedText, "utf8")
      .digest("hex");
    const hostCapabilities = {
      preambleVersion: 1,
      preambleDigest: testDigest("switch preamble"),
      manifestVersion: 1,
      manifestDigest: testDigest("switch manifest"),
    };
    const journal = store.beginSessionProviderSwitch({
      idempotencyKey: peerIdempotencyKey(71_000),
      request: {
        sessionId: session.id,
        provider: "codex",
        requestedPreset: "high",
        targetProfileId: target.id,
      },
      source: {
        profileId: source.id,
        processGeneration: source.processGeneration,
        provider: "codex",
        preset: "high",
        providerThreadId: "thread-switch-successor-source",
        sessionRevision: session.revision,
      },
      target: {
        profileId: target.id,
        processGeneration: target.processGeneration,
        provider: "codex",
        preset: "high",
        review: {
          reviewId: "71000000-0000-4000-8000-000000000001",
          kind: "session_start",
          effectiveRuntimeProfile: targetRuntime,
        },
      },
      fastEnabled: false,
      hostCapabilities,
      transcriptDigest: testDigest("switch transcript"),
      seed: {
        text: seedText,
        digest: seedDigest,
        includedRecords: 1,
        omittedRecords: 0,
      },
    });
    store.recordJournaledSessionProviderSwitchTarget({
      attemptId: journal.attemptId,
      providerThreadId: "thread-switch-successor-target",
      state: "idle",
      runtimeProfile: targetRuntime,
    });
    store.beginSessionProviderSwitchSourceRelease(journal.attemptId);
    store.recordJournaledSessionProviderSwitchSourceReleased(journal.attemptId);

    const workStore = {
      prepareProfileAuthorityChange: () => [],
    } as unknown as Parameters<StateStore["advanceProfileGenerationWithWorkRetirement"]>[2];
    const nextSource = store.advanceProfileGenerationWithWorkRetirement(
      source.id,
      source.processGeneration,
      workStore,
      { preserveSessionMutationAuthorities: true },
    ).profile;
    const nextTarget = store.advanceProfileGenerationWithWorkRetirement(
      target.id,
      target.processGeneration,
      workStore,
      { preserveSessionMutationAuthorities: true },
    ).profile;
    expect(nextSource.processGeneration).toBe(source.processGeneration + 1);
    expect(nextTarget.processGeneration).toBe(target.processGeneration + 1);
    expect(store.isJournaledSessionProviderSwitchAuthorityCurrent(journal.attemptId)).toBe(true);

    const paths = store.paths;
    store.close();
    stores.splice(stores.indexOf(store), 1);
    const restarted = new StateStore(paths);
    stores.push(restarted);
    const completed = restarted.completeJournaledSessionProviderSwitch(journal.attemptId);
    expect(completed.phase).toBe("applied");
    expect(restarted.requireSession(session.id)).toMatchObject({
      profileId: target.id,
      providerThreadId: "thread-switch-successor-target",
      state: "idle",
    });
    expect(restarted.latestSessionRuntimeProfile(session.id)?.profile)
      .toEqual(targetRuntime);
    const switchedEvent = restarted.listSessionEvents({
      sessionId: session.id,
      afterSequence: 0,
    }).events.find((event) => event.body.type === "provider_switched");
    expect(switchedEvent).toMatchObject({
      accountId: target.id,
      providerGeneration: nextTarget.processGeneration,
      body: { type: "provider_switched" },
    });

    restarted.beginSessionProviderSwitchSeed(journal.attemptId);
    const seedAttempt = restarted.prepareMutation({
      kind: "session.send",
      authorityId: session.id,
      authorityGeneration: nextTarget.processGeneration,
      request: { message: seedText },
      idempotencyKey: journal.seed.idempotencyKey,
    });
    const currentTargetRuntime = {
      ...targetRuntime,
      processGeneration: nextTarget.processGeneration,
      observedAt: 2_200,
    };
    const seedEvidence = restarted.beginSessionMutationEffect({
      attemptId: seedAttempt.id,
      sessionId: session.id,
      profileGeneration: nextTarget.processGeneration,
      message: seedText,
      evidence: {
        kind: "session.send",
        providerThreadId: "thread-switch-successor-target",
        baseline: { providerUpdatedAt: null, status: "idle", activeTurnId: null },
        clientMessageId: seedAttempt.id,
        messageDigest: testDigest(seedText),
        runtimeProfile: currentTargetRuntime,
      },
    });
    expect(seedEvidence.evidence).toMatchObject({ messageActor: "provider_switch" });
    const switchedSession = restarted.requireSession(session.id);
    const seedEvent = restarted.completeSessionTurnEffect({
      attemptId: seedAttempt.id,
      sessionId: session.id,
      accountId: target.id,
      providerGeneration: nextTarget.processGeneration,
      providerConnectionId: null,
      expectedSessionRevision: switchedSession.revision,
      applyResponseState: false,
      turnId: "turn-switch-successor-seed",
      turnStatus: "completed",
      runtimeProfile: currentTargetRuntime,
      message: seedText,
      receipt: { turnId: "turn-switch-successor-seed" },
    });
    expect(seedEvent.event.body).toMatchObject({
      type: "user_message",
      actor: "provider_switch",
      text: seedText,
    });
    expect(restarted.sessionMessageActorForSource(session.id, seedAttempt.id))
      .toBe("provider_switch");
    expect(restarted.finishSessionProviderSwitchSeed({
      attemptId: journal.attemptId,
      state: "applied",
      turnId: "turn-switch-successor-seed",
      finalResult: { turnId: "turn-switch-successor-seed" },
    }).seed.state).toBe("applied");
  });

  test("journaled Codex to Devin switches atomically remove the host capability binding", async () => {
    const { store } = await fixture();
    const source = signInProfile(store, "Codex switch source", "codex-source@example.com");
    const target = signInProfile(store, "Devin switch target", "devin-target@example.com");
    const created = store.createSession({
      profileId: source.id,
      preset: "high",
      fastEnabled: false,
    });
    const session = store.bindSession({
      sessionId: created.id,
      expectedRevision: created.revision,
      providerThreadId: "thread-codex-source",
      state: "idle",
    });
    const sourceHostCapabilities = {
      preambleVersion: 1,
      preambleDigest: testDigest("source Codex preamble"),
      manifestVersion: 1,
      manifestDigest: testDigest("source Codex manifest"),
    };
    store.bindSessionHostCapabilities({
      sessionId: session.id,
      ...sourceHostCapabilities,
    });
    const targetRuntime = {
      devinVersion: "3000.6.14" as const,
      isolatedHome: true as const,
      model: "gpt-6-astra" as const,
      observedAt: 2_300,
      preset: "astra" as const,
      processGeneration: target.processGeneration,
      profileId: target.id,
      protocolVersion: 1 as const,
      reasoningEffort: "provider-default" as const,
    };
    const seedText = "Continue in the reviewed Devin target.";
    const journal = store.beginSessionProviderSwitch({
      idempotencyKey: peerIdempotencyKey(71_001),
      providerAuthentication: {
        profileId: target.id,
        processGeneration: target.processGeneration,
        provider: "devin",
        signedIn: true,
      },
      request: {
        sessionId: session.id,
        provider: "devin",
        requestedPreset: "astra",
        targetProfileId: target.id,
      },
      source: {
        profileId: source.id,
        processGeneration: source.processGeneration,
        provider: "codex",
        preset: "high",
        providerThreadId: "thread-codex-source",
        sessionRevision: session.revision,
        hostCapabilities: sourceHostCapabilities,
      },
      target: {
        profileId: target.id,
        processGeneration: target.processGeneration,
        provider: "devin",
        preset: "astra",
        review: {
          reviewId: "71001000-0000-4000-8000-000000000001",
          kind: "session_start",
          effectiveRuntimeProfile: targetRuntime,
        },
      },
      fastEnabled: false,
      transcriptDigest: testDigest("Codex to Devin transcript"),
      seed: {
        text: seedText,
        digest: createHash("sha256")
          .update("hra:session-transcript-seed:v1\0", "utf8")
          .update(seedText, "utf8")
          .digest("hex"),
        includedRecords: 1,
        omittedRecords: 0,
      },
    });
    expect(journal.hostCapabilities).toBeUndefined();
    const inspector = new Database(store.paths.database, { readonly: true, strict: true });
    try {
      expect(inspector.query(
        `SELECT target_provider,target_preset,target_provider_v40,target_preset_v40,
                target_preamble_version_v40,target_preamble_digest_v40,
                target_manifest_version_v40,target_manifest_digest_v40
         FROM session_provider_switches WHERE attempt_id=?`,
      ).get(journal.attemptId)).toEqual({
        target_provider: "codex",
        target_preset: "ultra",
        target_provider_v40: "devin",
        target_preset_v40: "astra",
        target_preamble_version_v40: null,
        target_preamble_digest_v40: null,
        target_manifest_version_v40: null,
        target_manifest_digest_v40: null,
      });
    } finally {
      inspector.close(false);
    }

    store.recordJournaledSessionProviderSwitchTarget({
      attemptId: journal.attemptId,
      providerThreadId: "thread-devin-target",
      state: "idle",
      runtimeProfile: targetRuntime,
    });
    store.beginSessionProviderSwitchSourceRelease(journal.attemptId);
    store.recordJournaledSessionProviderSwitchSourceReleased(journal.attemptId);
    expect(store.completeJournaledSessionProviderSwitch(journal.attemptId).phase).toBe("applied");
    expect(store.requireSession(session.id)).toMatchObject({
      preset: "astra",
      profileId: target.id,
      provider: "devin",
      providerThreadId: "thread-devin-target",
    });
    expect(store.readSessionHostCapabilityBinding(session.id)).toBeNull();

    const readDamagedReplay = () => store.readSessionProviderSwitchReplay({
      idempotencyKey: journal.idempotencyKey,
      request: {
        sessionId: session.id,
        provider: "devin" as const,
        requestedPreset: "astra" as const,
        targetProfileId: target.id,
      },
    });
    const damaged = new Database(store.paths.database, { create: false, strict: true });
    try {
      damaged.exec("DROP TRIGGER session_provider_switch_authority_immutable");
      damaged.exec("DROP TRIGGER session_provider_switch_v40_authority_immutable");
      damaged.query(
        "UPDATE session_provider_switches SET target_preset_contract=? WHERE attempt_id=?",
      ).run(legacyPresetContract, journal.attemptId);
      expect(readDamagedReplay).toThrow("SESSION_PROVIDER_SWITCH_RUNTIME_PROFILE_MISMATCH");
      damaged.query(
        `UPDATE session_provider_switches
         SET target_preset_contract=?,source_preset_contract=?,source_preset_v40='astra'
         WHERE attempt_id=?`,
      ).run(currentPresetContract, legacyPresetContract, journal.attemptId);
      expect(readDamagedReplay).toThrow("SESSION_PROVIDER_SWITCH_RUNTIME_PROFILE_MISMATCH");
    } finally {
      damaged.close(false);
    }
  });

  test("advances a terminal generation-zero unresolved session start on consecutive restarts", async () => {
    const { store, home } = await fixture();
    const key = "00000000-0000-4000-8000-0000000006c1";
    const { attempt, profile, project } = await prepareSignedOutSessionStart(
      store,
      home,
      {
        idempotencyKey: key,
        label: "Terminal zero start",
        preset: "fable-max",
        provider: "claude",
      },
    );
    const starting = store.beginSessionStartEffect({
      attemptId: attempt.id,
      evidence: {
        clientMessageId: null,
        kind: "session.start",
        messageDigest: null,
        projectId: project.id,
      },
      fastEnabled: false,
      preset: "fable-max",
      profileGeneration: profile.processGeneration,
      profileId: profile.id,
      projectId: project.id,
      provider: "claude",
      providerAuthentication: {
        profileId: profile.id,
        processGeneration: profile.processGeneration,
        provider: "claude",
        signedIn: true,
      },
    });
    expect(store.reconcileSessionFromProvider({
      activeTurnId: null,
      sessionId: starting.id,
      state: "terminal",
    })).toMatchObject({ state: "terminal" });
    const paths = store.paths;
    store.close();
    stores.splice(stores.indexOf(store), 1);

    const firstRestart = new StateStore(paths, { now: () => 2_000 });
    stores.push(firstRestart);
    expect(firstRestart.nextDaemonGeneration(`boot_${"d".repeat(32)}`)).toBe(1);
    expect(firstRestart.requireProfileById(profile.id).processGeneration).toBe(1);
    expect(firstRestart.requireSession(starting.id).state).toBe("terminal");
    expect(firstRestart.readMutation(key)).toMatchObject({ state: "effect_started" });
    firstRestart.close();
    stores.splice(stores.indexOf(firstRestart), 1);

    const secondRestart = new StateStore(paths, { now: () => 3_000 });
    stores.push(secondRestart);
    expect(secondRestart.nextDaemonGeneration(`boot_${"e".repeat(32)}`)).toBe(2);
    expect(secondRestart.requireProfileById(profile.id).processGeneration).toBe(2);
    expect(secondRestart.isSessionMutationProviderAuthorityCurrent({
      attemptId: attempt.id,
      originGeneration: profile.processGeneration,
      profileId: profile.id,
      provider: "claude",
    })).toBe(true);
    const inspector = new Database(paths.database, { readonly: true, strict: true });
    try {
      expect(inspector.query(
        `SELECT provider,from_generation,to_generation
         FROM session_mutation_authority_rebinds
         WHERE attempt_id=? AND profile_id=?
         ORDER BY from_generation`,
      ).all(attempt.id, profile.id)).toEqual([
        { provider: "claude", from_generation: 0, to_generation: 1 },
        { provider: "claude", from_generation: 1, to_generation: 2 },
      ]);
    } finally {
      inspector.close(false);
    }
  });

  test("direct account effect admission refuses relevant unsettled session authorities", async () => {
    const loginFixture = await fixture();
    const loginStart = await prepareSignedOutSessionStart(
      loginFixture.store,
      loginFixture.home,
      {
        idempotencyKey: "00000000-0000-4000-8000-0000000006c2",
        label: "Blocked login",
        preset: "fable-max",
        provider: "claude",
      },
    );
    const loginKey = "00000000-0000-4000-8000-0000000006c3";
    const loginAttempt = loginFixture.store.prepareMutation({
      authorityGeneration: loginStart.profile.processGeneration + 1,
      authorityId: loginStart.profile.id,
      idempotencyKey: loginKey,
      kind: "account.login",
      request: { deviceCode: true },
    });
    loginFixture.store.beginSessionStartEffect({
      attemptId: loginStart.attempt.id,
      evidence: {
        clientMessageId: null,
        kind: "session.start",
        messageDigest: null,
        projectId: loginStart.project.id,
      },
      fastEnabled: false,
      preset: "fable-max",
      profileGeneration: loginStart.profile.processGeneration,
      profileId: loginStart.profile.id,
      projectId: loginStart.project.id,
      provider: "claude",
      providerAuthentication: {
        profileId: loginStart.profile.id,
        processGeneration: loginStart.profile.processGeneration,
        provider: "claude",
        signedIn: true,
      },
    });
    expect(() => loginFixture.store.beginAccountMutationEffect({
      attemptId: loginAttempt.id,
      evidence: { kind: "account.login", method: "device_code" },
      profileGeneration: loginStart.profile.processGeneration + 1,
      profileId: loginStart.profile.id,
    })).toThrow("SESSION_MUTATION_AUTHORITY_UNSETTLED");
    expect(loginFixture.store.readMutation(loginKey)).toMatchObject({ state: "prepared" });
    expect(loginFixture.store.requireProfileById(loginStart.profile.id)).toMatchObject({
      processGeneration: 0,
      state: "signed_out",
    });

    const logoutFixture = await fixture();
    const logoutProfile = signInProfile(
      logoutFixture.store,
      "Blocked logout",
      "blocked-logout@example.com",
    );
    const logoutProjectRoot = join(logoutFixture.home, "blocked-logout-project");
    await mkdir(logoutProjectRoot);
    const logoutProject = await logoutFixture.store.createProject(
      "Blocked logout project",
      logoutProjectRoot,
      true,
    );
    const logoutStartAttempt = logoutFixture.store.prepareMutation({
      authorityGeneration: logoutProfile.processGeneration,
      authorityId: logoutProfile.id,
      idempotencyKey: "00000000-0000-4000-8000-0000000006c4",
      kind: "session.start",
      request: { fast: false, preset: "high", projectId: logoutProject.id },
    });
    const logoutKey = "00000000-0000-4000-8000-0000000006c5";
    const logoutAttempt = logoutFixture.store.prepareMutation({
      authorityGeneration: logoutProfile.processGeneration,
      authorityId: logoutProfile.id,
      idempotencyKey: logoutKey,
      kind: "account.logout",
      request: {},
    });
    logoutFixture.store.beginSessionStartEffect({
      attemptId: logoutStartAttempt.id,
      evidence: {
        clientMessageId: null,
        kind: "session.start",
        messageDigest: null,
        projectId: logoutProject.id,
      },
      fastEnabled: false,
      preset: "high",
      profileGeneration: logoutProfile.processGeneration,
      profileId: logoutProfile.id,
      projectId: logoutProject.id,
      provider: "codex",
    });
    expect(() => logoutFixture.store.beginAccountMutationEffect({
      attemptId: logoutAttempt.id,
      evidence: { baselineSignedIn: true, kind: "account.logout" },
      profileGeneration: logoutProfile.processGeneration,
      profileId: logoutProfile.id,
    })).toThrow("SESSION_MUTATION_AUTHORITY_UNSETTLED");
    expect(logoutFixture.store.readMutation(logoutKey)).toMatchObject({ state: "prepared" });
    expect(logoutFixture.store.requireProfileById(logoutProfile.id)).toMatchObject({
      processGeneration: logoutProfile.processGeneration,
      state: "signed_in",
    });
  });

  test("admits a signed-out Claude session start with an exact provider authentication proof", async () => {
    const { store, home } = await fixture();
    const { attempt, profile, project } = await prepareSignedOutSessionStart(
      store,
      home,
      {
        idempotencyKey: "00000000-0000-4000-8000-0000000006a3",
        label: "Claude proof",
        preset: "fable-max",
        provider: "claude",
      },
    );

    const session = store.beginSessionStartEffect({
      attemptId: attempt.id,
      evidence: {
        clientMessageId: null,
        kind: "session.start",
        messageDigest: null,
        projectId: project.id,
      },
      fastEnabled: false,
      preset: "fable-max",
      profileGeneration: profile.processGeneration,
      profileId: profile.id,
      projectId: project.id,
      provider: "claude",
      providerAuthentication: {
        profileId: profile.id,
        processGeneration: profile.processGeneration,
        provider: "claude",
        signedIn: true,
      },
    });

    expect(session).toMatchObject({
      profileId: profile.id,
      provider: "claude",
      state: "starting",
    });
    expect(store.requireProfileById(profile.id).state).toBe("signed_out");
  });

  test("refuses missing or mismatched Claude session-start authentication proof", async () => {
    const { store, home } = await fixture();
    const { attempt, profile, project } = await prepareSignedOutSessionStart(
      store,
      home,
      {
        idempotencyKey: "00000000-0000-4000-8000-0000000006a4",
        label: "Claude proof refusal",
        preset: "fable-max",
        provider: "claude",
      },
    );
    const start = (providerAuthentication?: Readonly<{
      profileId: typeof profile.id;
      processGeneration: number;
      provider: "codex" | "claude";
      signedIn: true;
    }>) => store.beginSessionStartEffect({
      attemptId: attempt.id,
      evidence: {
        clientMessageId: null,
        kind: "session.start" as const,
        messageDigest: null,
        projectId: project.id,
      },
      fastEnabled: false,
      preset: "fable-max",
      profileGeneration: profile.processGeneration,
      profileId: profile.id,
      projectId: project.id,
      provider: "claude",
      ...(providerAuthentication === undefined ? {} : { providerAuthentication }),
    });

    expect(() => start()).toThrow("SESSION_START_PROVIDER_AUTHENTICATION_REQUIRED");
    expect(() => start({
      profileId: profile.id,
      processGeneration: profile.processGeneration,
      provider: "codex",
      signedIn: true,
    }))
      .toThrow("SESSION_START_PROVIDER_AUTHENTICATION_MISMATCH");
    expect(() => start({
      profileId: profile.id,
      processGeneration: profile.processGeneration + 1,
      provider: "claude",
      signedIn: true,
    })).toThrow("SESSION_START_PROVIDER_AUTHENTICATION_MISMATCH");
    expect(store.readMutation("00000000-0000-4000-8000-0000000006a4"))
      .toMatchObject({ state: "prepared" });
  });

  test("does not let provider authentication proof bypass the Codex profile-state gate", async () => {
    const { store, home } = await fixture();
    const { attempt, profile, project } = await prepareSignedOutSessionStart(
      store,
      home,
      {
        idempotencyKey: "00000000-0000-4000-8000-0000000006a5",
        label: "Codex proof refusal",
        preset: "high",
        provider: "codex",
      },
    );

    expect(() => store.beginSessionStartEffect({
      attemptId: attempt.id,
      evidence: {
        clientMessageId: null,
        kind: "session.start",
        messageDigest: null,
        projectId: project.id,
      },
      fastEnabled: false,
      preset: "high",
      profileGeneration: profile.processGeneration,
      profileId: profile.id,
      projectId: project.id,
      provider: "codex",
      providerAuthentication: {
        profileId: profile.id,
        processGeneration: profile.processGeneration,
        provider: "codex",
        signedIn: true,
      },
    })).toThrow("MUTATION_EFFECT_AUTHORITY_CHANGED");
    expect(store.readMutation("00000000-0000-4000-8000-0000000006a5"))
      .toMatchObject({ state: "prepared" });
  });

  test("carries every provider's reviewed runtime profile through one session-start evidence row", async () => {
    const { store, home } = await fixture();
    const profile = signInProfile(store, "Both providers", "both-providers@example.com");
    const projectRoot = join(home, "both-providers-project");
    await mkdir(projectRoot);
    const project = await store.createProject("Both providers project", projectRoot, true);
    const codexProfile = {
      approvalPolicy: "on-request" as const,
      computerUse: true as const,
      enabledApps: [],
      fast: false,
      model: "gpt-6-astra",
      observedAt: 2_000,
      permissionProfile: ":workspace" as const,
      pluginCapability: true as const,
      preset: "high" as const,
      processGeneration: profile.processGeneration,
      profileId: profile.id,
      reasoningEffort: "max" as const,
      reviewMode: "auto_review" as const,
      serviceTier: null,
    };
    // The Claude document has none of the Codex fields and is stored exactly
    // as the Claude port reviewed it.
    const claudeProfile = {
      claudeVersion: "2.1.260",
      inputFormat: "stream-json" as const,
      isolatedConfigDir: true as const,
      model: "claude-fable-5-1",
      observedAt: 2_100,
      outputFormat: "stream-json" as const,
      permissionMode: "default" as const,
      preset: "fable-max" as const,
      processGeneration: profile.processGeneration,
      profileId: profile.id,
      reasoningEffort: "max" as const,
    };
    const devinProfile = {
      devinVersion: "3000.6.14" as const,
      isolatedHome: true as const,
      model: "gpt-6-astra" as const,
      observedAt: 2_200,
      preset: "astra" as const,
      processGeneration: profile.processGeneration,
      profileId: profile.id,
      protocolVersion: 1 as const,
      reasoningEffort: "provider-default" as const,
    };

    const start = (
      idempotencyKey: string,
      provider: "codex" | "claude" | "devin",
      preset: "high" | "fable-max" | "astra",
      runtimeProfile: typeof codexProfile | typeof claudeProfile | typeof devinProfile,
    ) => {
      const attempt = store.prepareMutation({
        authorityGeneration: profile.processGeneration,
        authorityId: profile.id,
        idempotencyKey,
        kind: "session.start",
        request: { fast: false, preset, projectId: project.id },
      });
      const session = store.beginSessionStartEffect({
        attemptId: attempt.id,
        evidence: {
          clientMessageId: null,
          kind: "session.start",
          messageDigest: null,
          projectId: project.id,
          runtimeProfile,
        },
        fastEnabled: false,
        preset,
        profileGeneration: profile.processGeneration,
        profileId: profile.id,
        projectId: project.id,
        provider,
        ...(provider !== "codex"
          ? {
              providerAuthentication: {
                profileId: profile.id,
                processGeneration: profile.processGeneration,
                provider,
                signedIn: true as const,
              },
            }
          : {}),
      });
      store.completeSessionStartEffect({
        attemptId: attempt.id,
        expectedSessionRevision: session.revision,
        providerThreadId: `thread-${provider}`,
        receipt: { effectiveRuntimeProfile: runtimeProfile, sessionId: session.id },
        runtimeProfile,
        sessionId: session.id,
        state: "idle",
      });
      return { attempt, session };
    };

    const codex = start("00000000-0000-4000-8000-0000000006a0", "codex", "high", codexProfile);
    const claude = start("00000000-0000-4000-8000-0000000006a1", "claude", "fable-max", claudeProfile);
    const devin = start("00000000-0000-4000-8000-0000000006a2", "devin", "astra", devinProfile);

    expect(store.requireSession(codex.session.id)).toMatchObject({ preset: "high", provider: "codex" });
    expect(store.requireSession(claude.session.id))
      .toMatchObject({ preset: "fable-max", provider: "claude" });
    expect(store.requireSession(devin.session.id))
      .toMatchObject({ preset: "astra", provider: "devin" });
    expect(store.latestSessionRuntimeProfile(codex.session.id))
      .toMatchObject({ profile: codexProfile, sourceKind: "session_start" });
    expect(store.latestSessionRuntimeProfile(claude.session.id))
      .toMatchObject({ profile: claudeProfile, sourceKind: "session_start" });
    expect(store.latestSessionRuntimeProfile(devin.session.id))
      .toMatchObject({ profile: devinProfile, sourceKind: "session_start" });
    expect(store.readMutation("00000000-0000-4000-8000-0000000006a1")).toMatchObject({
      evidence: { evidence: { kind: "session.start", runtimeProfile: claudeProfile } },
      result: { effectiveRuntimeProfile: claudeProfile },
      state: "applied",
    });

    // A Codex row is stored byte for byte as it was before the widening.
    const inspector = new Database(store.paths.database, { create: false, strict: true });
    try {
      const rows = inspector.query(
        "SELECT session_id,profile_json FROM session_runtime_profiles ORDER BY session_id",
      ).all() as { profile_json: string; session_id: string }[];
      const stored = new Map(rows.map((row) => [row.session_id, row.profile_json]));
      // The widened union re-serialises a Codex document byte for byte as the
      // Codex-only schema always did, so every row written before Claude
      // existed still round-trips and still digests the same.
      expect(stored.get(codex.session.id))
        .toBe(JSON.stringify(effectiveRuntimeProfileSchema.parse(codexProfile)));
      expect(stored.get(claude.session.id))
        .toBe(JSON.stringify(effectiveClaudeRuntimeProfileSchema.parse(claudeProfile)));
      expect(stored.get(devin.session.id))
        .toBe(JSON.stringify(effectiveDevinRuntimeProfileSchema.parse(devinProfile)));
    } finally {
      inspector.close(false);
    }

    // A store holding both providers' evidence opens again with no migration.
    const reopened = new StateStore(store.paths);
    stores.push(reopened);
    expect(reopened.latestSessionRuntimeProfile(codex.session.id))
      .toMatchObject({ profile: codexProfile });
    expect(reopened.latestSessionRuntimeProfile(claude.session.id))
      .toMatchObject({ profile: claudeProfile });
    expect(reopened.latestSessionRuntimeProfile(devin.session.id))
      .toMatchObject({ profile: devinProfile });
  });

  test("rebinds a session to another provider and account in one transaction", async () => {
    const { store, home } = await fixture();
    const codexAccount = signInProfile(store, "Codex account", "codex@example.com");
    const claudeAccount = signInProfile(store, "Claude account", "claude@example.com");
    const projectRoot = join(home, "switch-project");
    await mkdir(projectRoot);
    const project = await store.createProject("Switch project", projectRoot, true);
    const codexProfile = {
      approvalPolicy: "on-request" as const,
      computerUse: true as const,
      enabledApps: [],
      fast: false,
      model: "gpt-6-astra",
      observedAt: 2_000,
      permissionProfile: ":workspace" as const,
      pluginCapability: true as const,
      preset: "high" as const,
      processGeneration: codexAccount.processGeneration,
      profileId: codexAccount.id,
      reasoningEffort: "max" as const,
      reviewMode: "auto_review" as const,
      serviceTier: null,
    };
    const claudeProfile = {
      claudeVersion: "2.1.260",
      inputFormat: "stream-json" as const,
      isolatedConfigDir: true as const,
      model: "claude-fable-5-1",
      observedAt: 2_100,
      outputFormat: "stream-json" as const,
      permissionMode: "default" as const,
      preset: "fable-max" as const,
      processGeneration: claudeAccount.processGeneration,
      profileId: claudeAccount.id,
      reasoningEffort: "max" as const,
    };
    const startAttempt = store.prepareMutation({
      authorityGeneration: codexAccount.processGeneration,
      authorityId: codexAccount.id,
      idempotencyKey: "00000000-0000-4000-8000-0000000006b0",
      kind: "session.start",
      request: { fast: false, preset: "high", projectId: project.id },
    });
    const started = store.beginSessionStartEffect({
      attemptId: startAttempt.id,
      evidence: {
        clientMessageId: null,
        kind: "session.start",
        messageDigest: null,
        projectId: project.id,
        runtimeProfile: codexProfile,
      },
      fastEnabled: false,
      preset: "high",
      profileGeneration: codexAccount.processGeneration,
      profileId: codexAccount.id,
      projectId: project.id,
      provider: "codex",
    });
    store.completeSessionStartEffect({
      attemptId: startAttempt.id,
      expectedSessionRevision: started.revision,
      providerThreadId: "codex-thread",
      receipt: { effectiveRuntimeProfile: codexProfile, sessionId: started.id },
      runtimeProfile: codexProfile,
      sessionId: started.id,
      state: "idle",
    });

    const switchAttempt = store.prepareMutation({
      authorityGeneration: claudeAccount.processGeneration,
      authorityId: started.id,
      idempotencyKey: "00000000-0000-4000-8000-0000000006b1",
      kind: "session.switch",
      request: { preset: "fable-max", provider: "claude" },
    });
    const seedText = "Continue this session after switching providers.";
    const seedDigest = createHash("sha256")
      .update("hra:session-transcript-seed:v1\0", "utf8")
      .update(seedText, "utf8")
      .digest("hex");
    const transcriptDigest = createHash("sha256").update("switch transcript").digest("hex");
    const immutableSwitchEvidence = {
      kind: "session.switch" as const,
      daemonGeneration: 0,
      requestedAccountId: null,
      requestedPreset: "fable-max" as const,
      runtimeProfile: claudeProfile,
      seedDigest,
      seedIncludedRecords: 1,
      seedOmittedRecords: 0,
      sourcePreset: "high" as const,
      sourceProcessGeneration: codexAccount.processGeneration,
      sourceProfileId: codexAccount.id,
      sourceProvider: "codex" as const,
      sourceProviderThreadId: "codex-thread",
      targetPreset: "fable-max" as const,
      targetProcessGeneration: claudeAccount.processGeneration,
      targetProfileId: claudeAccount.id,
      targetProvider: "claude" as const,
      transcriptDigest,
    };
    expect(() => store.beginSessionProviderSwitchEffect({
      attemptId: switchAttempt.id,
      sessionId: started.id,
      providerAuthentication: {
        profileId: claudeAccount.id,
        processGeneration: claudeAccount.processGeneration,
        provider: "claude",
        signedIn: true,
      },
      evidence: { ...immutableSwitchEvidence, daemonGeneration: 1 },
    })).toThrow("SESSION_PROVIDER_SWITCH_AUTHORITY_CHANGED");
    expect(store.readMutation("00000000-0000-4000-8000-0000000006b1"))
      .toMatchObject({ state: "prepared" });
    const switchEvidence = store.beginSessionProviderSwitchEffect({
      attemptId: switchAttempt.id,
      sessionId: started.id,
      providerAuthentication: {
        profileId: claudeAccount.id,
        processGeneration: claudeAccount.processGeneration,
        provider: "claude",
        signedIn: true,
      },
      evidence: immutableSwitchEvidence,
    });
    expect(() => store.resolveSessionMutation({
      attemptId: switchAttempt.id,
      expectedEvidenceDigest: switchEvidence.digest,
      expectedOriginalState: "effect_started",
      receipt: { forged: true },
      resolution: "abandoned",
      resolutionEvidence: { localOnly: true },
    })).toThrow("SESSION_PROVIDER_SWITCH_RECOVERY_RECEIPT_UNEXPECTED");
    expect(() => store.resolveSessionMutation({
      attemptId: switchAttempt.id,
      expectedEvidenceDigest: switchEvidence.digest,
      expectedOriginalState: "effect_started",
      resolution: "proven_applied",
      resolutionEvidence: { exact: false },
    })).toThrow("SESSION_PROVIDER_SWITCH_RECOVERY_RECEIPT_REQUIRED");
    expect(store.readMutation("00000000-0000-4000-8000-0000000006b1"))
      .toMatchObject({ state: "effect_started" });
    store.recordSessionProviderSwitchTarget({
      attemptId: switchAttempt.id,
      sessionId: started.id,
      providerThreadId: "claude-thread",
    });
    store.recordSessionProviderSwitchSeedIntent({
      attemptId: switchAttempt.id,
      sessionId: started.id,
      providerThreadId: "claude-thread",
      runtimeProfile: claudeProfile,
      seedText,
    });
    store.recordSessionProviderSwitchSeedResult({
      attemptId: switchAttempt.id,
      sessionId: started.id,
      providerThreadId: "claude-thread",
      runtimeProfile: claudeProfile,
      turnId: "claude-turn",
      turnStatus: "completed",
    });
    store.recordSessionProviderSwitchSourceReleased({
      attemptId: switchAttempt.id,
      sessionId: started.id,
    });
    const before = store.requireSession(started.id);
    const switchReceipt = {
      from: { account: codexAccount.id, preset: "high" as const, provider: "codex" as const },
      providerThreadId: "claude-thread",
      request: { accountId: null, preset: "fable-max" as const, provider: "claude" as const },
      seed: {
        digest: seedDigest,
        includedRecords: 1,
        omittedRecords: 0,
        status: "completed" as const,
      },
      sessionId: started.id,
      to: { account: claudeAccount.id, preset: "fable-max" as const, provider: "claude" as const },
      transcriptDigest,
      turnId: "claude-turn",
    };
    const targetHostCapabilities = {
      preambleVersion: 1,
      preambleDigest: "a".repeat(64),
      manifestVersion: 1,
      manifestDigest: "b".repeat(64),
    };
    expect(() => store.completeSessionProviderSwitch({
      attemptId: switchAttempt.id,
      expectedSessionRevision: before.revision,
      preset: "fable-max",
      profileId: claudeAccount.id,
      provider: "claude",
      providerThreadId: "claude-thread",
      hostCapabilities: targetHostCapabilities,
      receipt: { ...switchReceipt, turnId: "wrong-turn" },
      runtimeProfile: claudeProfile,
      seedTurnId: "claude-turn",
      sessionId: started.id,
      state: "idle",
    })).toThrow("SESSION_PROVIDER_SWITCH_RECEIPT_MISMATCH");
    expect(store.requireSession(started.id).provider).toBe("codex");
    expect(() => store.completeSessionProviderSwitch({
      attemptId: switchAttempt.id,
      expectedSessionRevision: before.revision - 1,
      preset: "fable-max",
      profileId: claudeAccount.id,
      provider: "claude",
      providerThreadId: "claude-thread",
      hostCapabilities: targetHostCapabilities,
      receipt: switchReceipt,
      runtimeProfile: claudeProfile,
      seedTurnId: "claude-turn",
      sessionId: started.id,
      state: "idle",
    })).toThrow("SESSION_PROVIDER_SWITCH_CAS_CONFLICT");
    const switched = store.completeSessionProviderSwitch({
      attemptId: switchAttempt.id,
      expectedSessionRevision: before.revision,
      preset: "fable-max",
      profileId: claudeAccount.id,
      provider: "claude",
      providerThreadId: "claude-thread",
      hostCapabilities: targetHostCapabilities,
      receipt: switchReceipt,
      runtimeProfile: claudeProfile,
      seedTurnId: "claude-turn",
      sessionId: started.id,
      state: "idle",
    });
    // The provider, the account, the preset, and the thread are one binding.
    expect(switched).toMatchObject({
      preset: "fable-max",
      profileId: claudeAccount.id,
      provider: "claude",
      providerThreadId: "claude-thread",
    });
    // The runtime-profile authority guard requires the row's account to equal
    // the session's, so the rebind must land before the profile is inserted.
    expect(store.latestSessionRuntimeProfile(started.id)).toMatchObject({
      profile: { ...claudeProfile, profileId: claudeAccount.id },
      sourceKind: "turn_start",
    });
    expect(store.readMutation("00000000-0000-4000-8000-0000000006b1")).toMatchObject({
      result: {
        session: {
          id: started.id,
          profileId: claudeAccount.id,
          provider: "claude",
          providerThreadId: "claude-thread",
        },
      },
      state: "applied",
    });
    expect(store.requireSessionHostCapabilityBinding(started.id)).toMatchObject({
      preambleVersion: 1,
      preambleDigest: "a".repeat(64),
      manifestVersion: 1,
      manifestDigest: "b".repeat(64),
    });

    // A preset the target cannot run is refused before anything is written.
    expect(() => store.completeSessionProviderSwitch({
      attemptId: switchAttempt.id,
      expectedSessionRevision: switched.revision,
      preset: "high",
      profileId: claudeAccount.id,
      provider: "claude",
      providerThreadId: "claude-thread-2",
      receipt: {},
      runtimeProfile: claudeProfile,
      seedTurnId: "claude-turn",
      sessionId: started.id,
      state: "idle",
    })).toThrow("does not support the `high` model preset");
    expect(store.requireSession(started.id).providerThreadId).toBe("claude-thread");
  });

  test("fences provider-switch seed reviews to the exact historical preset contract", async () => {
    const { store } = await fixture();
    const sourceProfile = signInProfile(store, "Seed source", "seed-source@example.com");
    const targetProfile = signInProfile(store, "Seed target", "seed-target@example.com");
    const astraProfile = {
      approvalPolicy: "on-request" as const,
      computerUse: true as const,
      enabledApps: [],
      fast: false,
      model: "gpt-6-astra",
      observedAt: 2_200,
      permissionProfile: ":workspace" as const,
      pluginCapability: true as const,
      preset: "high" as const,
      processGeneration: targetProfile.processGeneration,
      profileId: targetProfile.id,
      reasoningEffort: "max" as const,
      reviewMode: "auto_review" as const,
      serviceTier: null,
    };
    const solProfile = { ...astraProfile, model: "gpt-5.6-sol" };
    const stageSwitch = (suffix: string, seedText: string) => {
      const starting = store.createSession({
        fastEnabled: false,
        preset: "fable-max",
        profileId: sourceProfile.id,
        provider: "claude",
      });
      const session = store.bindSession({
        expectedRevision: starting.revision,
        providerThreadId: `source-${suffix}`,
        sessionId: starting.id,
        state: "idle",
      });
      const attempt = store.prepareMutation({
        authorityGeneration: targetProfile.processGeneration,
        authorityId: session.id,
        idempotencyKey: `00000000-0000-4000-8000-000000000${suffix}`,
        kind: "session.switch",
        request: { preset: "high", provider: "codex" },
      });
      const seedDigest = createHash("sha256")
        .update("hra:session-transcript-seed:v1\0", "utf8")
        .update(seedText, "utf8")
        .digest("hex");
      const evidence = {
        kind: "session.switch" as const,
        daemonGeneration: 0,
        requestedAccountId: targetProfile.id,
        requestedPreset: "high" as const,
        runtimeProfile: astraProfile,
        seedDigest,
        seedIncludedRecords: 1,
        seedOmittedRecords: 0,
        sourcePreset: "fable-max" as const,
        sourceProcessGeneration: sourceProfile.processGeneration,
        sourceProfileId: sourceProfile.id,
        sourceProvider: "claude" as const,
        sourceProviderThreadId: `source-${suffix}`,
        targetPreset: "high" as const,
        targetProcessGeneration: targetProfile.processGeneration,
        targetProfileId: targetProfile.id,
        targetProvider: "codex" as const,
        transcriptDigest: createHash("sha256").update(`transcript-${suffix}`).digest("hex"),
      };
      store.beginSessionProviderSwitchEffect({
        attemptId: attempt.id,
        evidence,
        sessionId: session.id,
      });
      store.recordSessionProviderSwitchTarget({
        attemptId: attempt.id,
        providerThreadId: `target-${suffix}`,
        sessionId: session.id,
      });
      return { attempt, seedText, session };
    };

    const current = stageSwitch("6b2", "Seed the current Astra target.");
    expect(() => store.recordSessionProviderSwitchSeedIntent({
      attemptId: current.attempt.id,
      providerThreadId: "target-6b2",
      runtimeProfile: solProfile,
      seedText: current.seedText,
      sessionId: current.session.id,
    })).toThrow("SESSION_PROVIDER_SWITCH_SEED_INTENT_AUTHORITY_MISMATCH");
    expect(store.readSessionProviderSwitchProgress(current.attempt.id).seed).toBeUndefined();
    store.recordSessionProviderSwitchSeedIntent({
      attemptId: current.attempt.id,
      providerThreadId: "target-6b2",
      runtimeProfile: astraProfile,
      seedText: current.seedText,
      sessionId: current.session.id,
    });
    expect(store.readSessionProviderSwitchProgress(current.attempt.id).seed?.runtimeProfile.model)
      .toBe("gpt-6-astra");

    const legacy = stageSwitch("6b3", "Resume the historical Sol target.");
    const inspector = new Database(store.paths.database, { create: false, strict: true });
    try {
      // Simulate the immutable switch evidence a pre-v38 daemon could have
      // left after the provider target was created but before its seed began.
      const stored = inspector.query(
        "SELECT evidence_json FROM mutation_effect_evidence WHERE attempt_id=?",
      ).get(legacy.attempt.id) as { evidence_json: string };
      const legacyEvidence = JSON.parse(stored.evidence_json) as {
        runtimeProfile: { model: string };
      };
      legacyEvidence.runtimeProfile.model = "gpt-5.6-sol";
      const legacyEvidenceJson = JSON.stringify(legacyEvidence);
      inspector.exec("DROP TRIGGER mutation_effect_evidence_immutable_update");
      inspector.query(
        `UPDATE mutation_effect_evidence SET evidence_json=?,evidence_digest=?
         WHERE attempt_id=?`,
      ).run(
        legacyEvidenceJson,
        createHash("sha256").update(legacyEvidenceJson).digest("hex"),
        legacy.attempt.id,
      );
      inspector.exec(`
        CREATE TRIGGER mutation_effect_evidence_immutable_update
        BEFORE UPDATE ON mutation_effect_evidence
        BEGIN SELECT RAISE(ABORT, 'mutation effect evidence is immutable'); END;
      `);
    } finally {
      inspector.close(false);
    }
    expect(store.readMutation("00000000-0000-4000-8000-0000000006b3"))
      .toMatchObject({ evidence: { evidence: { runtimeProfile: { model: "gpt-5.6-sol" } } } });
    expect(store.isSessionMutationProviderAuthorityCurrent({
      attemptId: legacy.attempt.id,
      originGeneration: targetProfile.processGeneration,
      profileId: targetProfile.id,
      provider: "codex",
    })).toBe(true);
    expect(() => store.recordSessionProviderSwitchSeedIntent({
      attemptId: legacy.attempt.id,
      providerThreadId: "target-6b3",
      runtimeProfile: solProfile,
      seedText: legacy.seedText,
      sessionId: legacy.session.id,
    })).not.toThrow();
    expect(store.readSessionProviderSwitchProgress(legacy.attempt.id).seed?.runtimeProfile.model)
      .toBe("gpt-5.6-sol");
  });

  test("releases a Devin source binding before completing its provider switch", async () => {
    const { store, home } = await fixture();
    const account = signInProfile(store, "Devin switch source", "devin-switch@example.com");
    const projectRoot = join(home, "devin-switch-project");
    await mkdir(projectRoot);
    const project = await store.createProject("Devin switch project", projectRoot, true);
    const devinProfile = {
      devinVersion: "3000.6.14" as const,
      isolatedHome: true as const,
      model: "gpt-6-astra" as const,
      observedAt: 2_000,
      preset: "astra" as const,
      processGeneration: account.processGeneration,
      profileId: account.id,
      protocolVersion: 1 as const,
      reasoningEffort: "provider-default" as const,
    };
    const codexProfile = {
      approvalPolicy: "on-request" as const,
      computerUse: true as const,
      enabledApps: [],
      fast: false,
      model: "gpt-6-astra",
      observedAt: 2_100,
      permissionProfile: ":workspace" as const,
      pluginCapability: true as const,
      preset: "high" as const,
      processGeneration: account.processGeneration,
      profileId: account.id,
      reasoningEffort: "max" as const,
      reviewMode: "auto_review" as const,
      serviceTier: null,
    };
    const startAttempt = store.prepareMutation({
      authorityGeneration: account.processGeneration,
      authorityId: account.id,
      idempotencyKey: "00000000-0000-4000-8000-0000000006b2",
      kind: "session.start",
      request: { fast: false, preset: "astra", projectId: project.id },
    });
    const started = store.beginSessionStartEffect({
      attemptId: startAttempt.id,
      evidence: {
        clientMessageId: null,
        kind: "session.start",
        messageDigest: null,
        projectId: project.id,
        runtimeProfile: devinProfile,
      },
      fastEnabled: false,
      preset: "astra",
      profileGeneration: account.processGeneration,
      profileId: account.id,
      projectId: project.id,
      provider: "devin",
      providerAuthentication: {
        profileId: account.id,
        processGeneration: account.processGeneration,
        provider: "devin",
        signedIn: true,
      },
    });
    store.completeSessionStartEffect({
      attemptId: startAttempt.id,
      expectedSessionRevision: started.revision,
      providerThreadId: "devin-source-thread",
      receipt: { effectiveRuntimeProfile: devinProfile, sessionId: started.id },
      runtimeProfile: devinProfile,
      sessionId: started.id,
      state: "idle",
    });

    expect(store.requireSession(started.id)).toMatchObject({
      preset: "astra",
      provider: "devin",
      providerThreadId: "devin-source-thread",
    });
    const inspector = new Database(store.paths.database, { create: false, strict: true });
    try {
      expect(inspector.query(
        "SELECT provider,provider_v39 FROM sessions WHERE id=?",
      ).get(started.id)).toEqual({ provider: "codex", provider_v39: "devin" });
    } finally {
      inspector.close(false);
    }

    const switchAttempt = store.prepareMutation({
      authorityGeneration: account.processGeneration,
      authorityId: started.id,
      idempotencyKey: "00000000-0000-4000-8000-0000000006b3",
      kind: "session.switch",
      request: { preset: "high", provider: "codex" },
    });
    const seedText = "Continue after switching away from Devin.";
    const seedDigest = createHash("sha256")
      .update("hra:session-transcript-seed:v1\0", "utf8")
      .update(seedText, "utf8")
      .digest("hex");
    const transcriptDigest = createHash("sha256")
      .update("devin source switch transcript")
      .digest("hex");
    const evidence = {
      daemonGeneration: 0,
      kind: "session.switch" as const,
      requestedAccountId: null,
      requestedPreset: "high" as const,
      runtimeProfile: codexProfile,
      seedDigest,
      seedIncludedRecords: 1,
      seedOmittedRecords: 0,
      sourcePreset: "astra" as const,
      sourceProcessGeneration: account.processGeneration,
      sourceProfileId: account.id,
      sourceProvider: "devin" as const,
      sourceProviderThreadId: "devin-source-thread",
      targetPreset: "high" as const,
      targetProcessGeneration: account.processGeneration,
      targetProfileId: account.id,
      targetProvider: "codex" as const,
      transcriptDigest,
    };
    store.beginSessionProviderSwitchEffect({
      attemptId: switchAttempt.id,
      evidence,
      sessionId: started.id,
    });
    store.recordSessionProviderSwitchTarget({
      attemptId: switchAttempt.id,
      providerThreadId: "codex-target-thread",
      sessionId: started.id,
    });
    store.recordSessionProviderSwitchSeedIntent({
      attemptId: switchAttempt.id,
      providerThreadId: "codex-target-thread",
      runtimeProfile: codexProfile,
      seedText,
      sessionId: started.id,
    });
    store.recordSessionProviderSwitchSeedResult({
      attemptId: switchAttempt.id,
      providerThreadId: "codex-target-thread",
      runtimeProfile: codexProfile,
      sessionId: started.id,
      turnId: "codex-seed-turn",
      turnStatus: "completed",
    });

    expect(store.readSessionProviderSwitchProgress(switchAttempt.id).sourceReleased).toBe(false);
    store.recordSessionProviderSwitchSourceReleased({
      attemptId: switchAttempt.id,
      sessionId: started.id,
    });
    expect(store.readSessionProviderSwitchProgress(switchAttempt.id).sourceReleased).toBe(true);

    const before = store.requireSession(started.id);
    const switched = store.completeSessionProviderSwitch({
      attemptId: switchAttempt.id,
      expectedSessionRevision: before.revision,
      preset: "high",
      profileId: account.id,
      provider: "codex",
      providerThreadId: "codex-target-thread",
      hostCapabilities: {
        preambleVersion: 1,
        preambleDigest: "c".repeat(64),
        manifestVersion: 1,
        manifestDigest: "d".repeat(64),
      },
      receipt: {
        from: { account: account.id, preset: "astra", provider: "devin" },
        providerThreadId: "codex-target-thread",
        request: { accountId: null, preset: "high", provider: "codex" },
        seed: {
          digest: seedDigest,
          includedRecords: 1,
          omittedRecords: 0,
          status: "completed",
        },
        sessionId: started.id,
        to: { account: account.id, preset: "high", provider: "codex" },
        transcriptDigest,
        turnId: "codex-seed-turn",
      },
      runtimeProfile: codexProfile,
      seedTurnId: "codex-seed-turn",
      sessionId: started.id,
      state: "idle",
    });
    expect(switched).toMatchObject({
      preset: "high",
      profileId: account.id,
      provider: "codex",
      providerThreadId: "codex-target-thread",
    });
    expect(store.readMutation("00000000-0000-4000-8000-0000000006b3"))
      .toMatchObject({
        evidence: { evidence: { sourceProvider: "devin", targetProvider: "codex" } },
        result: { from: { provider: "devin" }, session: { provider: "codex" } },
        state: "applied",
      });
    expect(store.requireSessionHostCapabilityBinding(started.id)).toMatchObject({
      preambleDigest: "c".repeat(64),
      manifestDigest: "d".repeat(64),
    });

    const returnAttempt = store.prepareMutation({
      authorityGeneration: account.processGeneration,
      authorityId: started.id,
      idempotencyKey: "00000000-0000-4000-8000-0000000006b4",
      kind: "session.switch",
      request: { preset: "astra", provider: "devin" },
    });
    const returnSeedText = "Continue after switching back to Devin.";
    const returnSeedDigest = createHash("sha256")
      .update("hra:session-transcript-seed:v1\0", "utf8")
      .update(returnSeedText, "utf8")
      .digest("hex");
    const returnTranscriptDigest = createHash("sha256")
      .update("Codex source switch transcript")
      .digest("hex");
    store.beginSessionProviderSwitchEffect({
      attemptId: returnAttempt.id,
      evidence: {
        daemonGeneration: 0,
        kind: "session.switch",
        requestedAccountId: null,
        requestedPreset: "astra",
        runtimeProfile: devinProfile,
        seedDigest: returnSeedDigest,
        seedIncludedRecords: 1,
        seedOmittedRecords: 0,
        sourcePreset: "high",
        sourceProcessGeneration: account.processGeneration,
        sourceProfileId: account.id,
        sourceProvider: "codex",
        sourceProviderThreadId: "codex-target-thread",
        targetPreset: "astra",
        targetProcessGeneration: account.processGeneration,
        targetProfileId: account.id,
        targetProvider: "devin",
        transcriptDigest: returnTranscriptDigest,
      },
      providerAuthentication: {
        profileId: account.id,
        processGeneration: account.processGeneration,
        provider: "devin",
        signedIn: true,
      },
      sessionId: started.id,
    });
    store.recordSessionProviderSwitchTarget({
      attemptId: returnAttempt.id,
      providerThreadId: "devin-return-thread",
      sessionId: started.id,
    });
    store.recordSessionProviderSwitchSeedIntent({
      attemptId: returnAttempt.id,
      providerThreadId: "devin-return-thread",
      runtimeProfile: devinProfile,
      seedText: returnSeedText,
      sessionId: started.id,
    });
    store.recordSessionProviderSwitchSeedResult({
      attemptId: returnAttempt.id,
      providerThreadId: "devin-return-thread",
      runtimeProfile: devinProfile,
      sessionId: started.id,
      turnId: "devin-return-seed-turn",
      turnStatus: "completed",
    });
    store.recordSessionProviderSwitchSourceReleased({
      attemptId: returnAttempt.id,
      sessionId: started.id,
    });
    const beforeReturn = store.requireSession(started.id);
    expect(store.completeSessionProviderSwitch({
      attemptId: returnAttempt.id,
      expectedSessionRevision: beforeReturn.revision,
      preset: "astra",
      profileId: account.id,
      provider: "devin",
      providerThreadId: "devin-return-thread",
      receipt: {
        from: { account: account.id, preset: "high", provider: "codex" },
        providerThreadId: "devin-return-thread",
        request: { accountId: null, preset: "astra", provider: "devin" },
        seed: {
          digest: returnSeedDigest,
          includedRecords: 1,
          omittedRecords: 0,
          status: "completed",
        },
        sessionId: started.id,
        to: { account: account.id, preset: "astra", provider: "devin" },
        transcriptDigest: returnTranscriptDigest,
        turnId: "devin-return-seed-turn",
      },
      runtimeProfile: devinProfile,
      seedTurnId: "devin-return-seed-turn",
      sessionId: started.id,
      state: "idle",
    })).toMatchObject({
      preset: "astra",
      provider: "devin",
      providerThreadId: "devin-return-thread",
    });
    expect(store.readSessionHostCapabilityBinding(started.id)).toBeNull();
  });

  test("refuses a session-start evidence row whose profile names another provider", async () => {
    const { store, home } = await fixture();
    const profile = signInProfile(store, "Mismatch", "mismatch@example.com");
    const projectRoot = join(home, "mismatch-project");
    await mkdir(projectRoot);
    const project = await store.createProject("Mismatch project", projectRoot, true);
    const attempt = store.prepareMutation({
      authorityGeneration: profile.processGeneration,
      authorityId: profile.id,
      idempotencyKey: "00000000-0000-4000-8000-0000000006a2",
      kind: "session.start",
      request: { fast: false, preset: "fable-max", projectId: project.id },
    });
    expect(() => store.beginSessionStartEffect({
      attemptId: attempt.id,
      evidence: {
        clientMessageId: null,
        kind: "session.start",
        messageDigest: null,
        projectId: project.id,
        runtimeProfile: {
          claudeVersion: "2.1.260",
          inputFormat: "stream-json",
          isolatedConfigDir: true,
          model: "claude-fable-5-1",
          observedAt: 2_100,
          outputFormat: "stream-json",
          permissionMode: "default",
          preset: "fable-max",
          processGeneration: profile.processGeneration,
          profileId: profile.id,
          reasoningEffort: "max",
        },
      },
      fastEnabled: true,
      preset: "fable-max",
      profileGeneration: profile.processGeneration,
      profileId: profile.id,
      projectId: project.id,
      provider: "claude",
      providerAuthentication: {
        profileId: profile.id,
        processGeneration: profile.processGeneration,
        provider: "claude",
        signedIn: true,
      },
    })).toThrow("MUTATION_EFFECT_RUNTIME_PROFILE_MISMATCH");
  });

  test("appends an immutable resolution with stale-CAS rejection and releases only the exact authority", async () => {
    const { store } = await fixture();
    const profile = signInProfile(store, "Resolution", "resolution@example.com");
    const local = store.createSession({ profileId: profile.id, preset: "high", fastEnabled: false });
    const session = store.bindSession({ sessionId: local.id, expectedRevision: local.revision, providerThreadId: "thread-resolution", state: "idle", providerUpdatedAt: 10 });
    const key = "00000000-0000-4000-8000-000000000611";
    const attempt = store.prepareMutation({ kind: "session.rename", authorityId: session.id, authorityGeneration: profile.processGeneration, request: { name: "Resolved" }, idempotencyKey: key });
    const evidence = store.beginSessionMutationEffect({
      attemptId: attempt.id,
      sessionId: session.id,
      profileGeneration: profile.processGeneration,
      evidence: { kind: "session.rename", providerThreadId: "thread-resolution", baseline: { providerUpdatedAt: 10, status: "idle", activeTurnId: null }, requestedName: "Resolved" },
    });
    expect(store.transitionMutation(attempt.id, "effect_started", "ambiguous", { code: "LOST_RESPONSE" })).toBe(true);
    store.quarantineSession(session.id);
    expect(() => store.prepareMutation({ kind: "session.rename", authorityId: session.id, authorityGeneration: profile.processGeneration, request: { name: "Other" }, idempotencyKey: "00000000-0000-4000-8000-000000000612" })).toThrow("UNSETTLED_MUTATION_AUTHORITY");

    expect(store.resolveSessionMutation({
      attemptId: attempt.id,
      expectedOriginalState: "ambiguous",
      expectedEvidenceDigest: evidence.digest,
      resolution: "proven_applied",
      resolutionEvidence: { source: "thread/read", providerUpdatedAt: 11 },
      receipt: { renamed: true },
      provider: { providerThreadId: "thread-resolution", title: "Resolved", status: "idle", providerUpdatedAt: 11 },
    })).toMatchObject({ state: "idle", title: "Resolved", providerUpdatedAt: 11 });
    expect(store.readMutation(key)).toMatchObject({ state: "reconciled", originalState: "ambiguous", result: { renamed: true }, resolution: { kind: "proven_applied" } });
    expect(() => store.resolveSessionMutation({
      attemptId: attempt.id,
      expectedOriginalState: "ambiguous",
      expectedEvidenceDigest: evidence.digest,
      resolution: "proven_applied",
      resolutionEvidence: { stale: true },
      receipt: { renamed: true },
      provider: { providerThreadId: "thread-resolution", title: "Resolved", status: "idle", providerUpdatedAt: 11 },
    })).toThrow();
    expect(store.prepareMutation({ kind: "session.rename", authorityId: session.id, authorityGeneration: profile.processGeneration, request: { name: "Other" }, idempotencyKey: "00000000-0000-4000-8000-000000000612" })).toMatchObject({ replay: false, state: "prepared" });

    const inspector = new Database(store.paths.database, { create: false, strict: true });
    try {
      expect(() => inspector.query("UPDATE mutation_effect_evidence SET evidence_digest=? WHERE attempt_id=?").run("b".repeat(64), attempt.id)).toThrow("immutable");
      expect(() => inspector.query("UPDATE mutation_resolutions SET resolution_kind='abandoned' WHERE attempt_id=?").run(attempt.id)).toThrow("immutable");
    } finally {
      inspector.close(false);
    }
  });

  test("rejects an unbound legacy effect-started session creation at daemon admission", async () => {
    const { store } = await fixture();
    const profile = signInProfile(store, "Legacy start", "legacy-start@example.com");
    const starting = store.createSession({ profileId: profile.id, preset: "high", fastEnabled: false });
    const attempt = store.prepareMutation({
      kind: "session.start",
      authorityId: profile.id,
      authorityGeneration: profile.processGeneration,
      request: { message: null },
      idempotencyKey: "00000000-0000-4000-8000-000000000603",
    });
    expect(store.transitionMutation(attempt.id, "prepared", "effect_started")).toBe(true);

    expect(store.recoverEffectStartedMutations()).toEqual({
      recovered: [],
      unresolved: [{ id: attempt.id, kind: "session.start", authorityId: profile.id }],
    });
    expect(store.requireProfile(profile.id)).toMatchObject({ state: "signed_in" });
    expect(store.requireSession(starting.id)).toMatchObject({ state: "starting" });
  });

  test("leaves unknown effect-started authorities unresolved so daemon admission can fail", async () => {
    const { store } = await fixture();
    const attempt = store.prepareMutation({
      kind: "unknown.effect",
      authorityId: "unknown-authority",
      authorityGeneration: 1,
      request: {},
      idempotencyKey: "00000000-0000-4000-8000-000000000604",
    });
    expect(store.transitionMutation(attempt.id, "prepared", "effect_started")).toBe(true);
    expect(store.recoverEffectStartedMutations()).toEqual({
      recovered: [],
      unresolved: [{ id: attempt.id, kind: "unknown.effect", authorityId: "unknown-authority" }],
    });
    expect(store.readMutation("00000000-0000-4000-8000-000000000604")).toMatchObject({ state: "effect_started" });
  });

  test("rejects symlinked project roots", async () => {
    const { store, home } = await fixture();
    const actual = join(home, "actual");
    const link = join(home, "link");
    await mkdir(actual);
    await symlink(actual, link);
    await expect(store.createProject("Unsafe", link)).rejects.toThrow("without symbolic links");
  });

  test("creates user-only profile directories", async () => {
    const { store } = await fixture();
    const profile = store.createProfile("Isolated");
    const owned = await initializeProfilePaths(store.paths, profile.id);
    expect(owned.codexHome).toContain(profile.id);
    expect(owned.desktopUserData).toContain(profile.id);
  });

  test("exact session IDs remain selectable beyond the recent-list page", async () => {
    const { store } = await fixture();
    const profile = store.createProfile("Many");
    const first = store.createSession({ profileId: profile.id, title: "First", preset: "high", fastEnabled: false });
    for (let index = 0; index < 101; index += 1) store.createSession({ profileId: profile.id, title: `Session ${index}`, preset: "high", fastEnabled: false });
    expect(store.requireSession(first.id).id).toBe(first.id);
  });

  test("pages every cloud session by stable identifier beyond the recent-list bound", async () => {
    const { store } = await fixture();
    const profile = store.createProfile("Cloud pages");
    const created = Array.from({ length: 53 }, (_, index) => store.createSession({
      fastEnabled: false,
      preset: "high",
      profileId: profile.id,
      title: `Cloud session ${index}`,
    }));
    const observed: string[] = [];
    let afterId: string | null = null;
    for (let pageNumber = 0; pageNumber < 4; pageNumber += 1) {
      const page = store.listCloudSessionPage({ afterId, limit: 25 });
      expect(page.sessions.length).toBeLessThanOrEqual(25);
      observed.push(...page.sessions.map((session) => session.id));
      afterId = page.continueAfterId;
      if (page.isDone) break;
    }
    expect(observed).toEqual(created.map((session) => session.id).sort());
    expect(afterId).toBeNull();
    expect(() => store.listCloudSessionPage({
      afterId: "not-a-session-id",
      limit: 25,
    })).toThrow();
  });

  test("tombstones profiles while preserving exact historical session reads", async () => {
    const { store } = await fixture();
    const profile = signInProfile(store, "Archived", "archive@example.com");
    const session = store.createSession({
      profileId: profile.id,
      title: "Retained history",
      preset: "high",
      fastEnabled: false,
    });
    store.setSessionTurnState({
      sessionId: session.id,
      expectedRevision: session.revision,
      state: "terminal",
    });

    store.removeProfile(profile.id);

    expect(() => store.requireProfile(profile.id)).toThrow(SelectionError);
    expect(store.requireProfileById(profile.id, { includeRemoved: true })).toMatchObject({
      id: profile.id,
      state: "removed",
    });
    expect(store.requireSession(session.id)).toMatchObject({
      id: session.id,
      title: "Retained history",
      profileId: profile.id,
    });
    expect(() => store.requireAccountRateLimitResetPolicy(profile.id))
      .toThrow("ACCOUNT_RATE_LIMIT_RESET_POLICY_MISSING");
  });

  test("enforces every queue transition at both the store and SQLite boundaries", async () => {
    const { store } = await fixture();
    const profile = store.createProfile("Queue graph");
    const session = store.createSession({
      profileId: profile.id,
      preset: "high",
      fastEnabled: false,
    });
    const database = new Database(store.paths.database, { create: false, strict: true });
    try {
      for (const from of queueStateSchema.options) {
        for (const to of queueStateSchema.options) {
          const throughStore = store.enqueue(session.id, `${from} to ${to} through store`);
          moveQueueTo(store, throughStore.id, from);
          if (canTransitionQueue(from, to)) {
            expect(store.transitionQueue(throughStore.id, from, to)).toBe(true);
          } else {
            expect(() => store.transitionQueue(throughStore.id, from, to)).toThrow(
              `Illegal queue transition: ${from} -> ${to}`,
            );
          }

          const throughSql = store.enqueue(session.id, `${from} to ${to} through sqlite`);
          moveQueueTo(store, throughSql.id, from);
          const direct = () =>
            database
              .query("UPDATE queue_entries SET state=? WHERE id=? AND state=?")
              .run(to, throughSql.id, from);
          if (canTransitionQueue(from, to)) {
            expect(direct).not.toThrow();
          } else {
            expect(direct).toThrow("illegal queue transition");
          }
        }
      }
    } finally {
      database.close(false);
    }
  });

  test("preserves enqueue FIFO when queue timestamps are identical", async () => {
    const home = await realpath(await mkdtemp(join(tmpdir(), "hra-store-fifo-")));
    const paths = resolveStatePaths({ homeDirectory: home, platform: "darwin" });
    await initializeStatePaths(paths);
    const store = new StateStore(paths, { now: () => 1_000 });
    stores.push(store);
    const profile = store.createProfile("Queue FIFO");
    const session = store.createSession({
      profileId: profile.id,
      preset: "high",
      fastEnabled: false,
    });
    const first = store.enqueue(session.id, "first");
    const second = store.enqueue(session.id, "second");

    expect(first.createdAt).toBe(second.createdAt);
    expect(store.listQueue(session.id).map((entry) => entry.id)).toEqual([first.id, second.id]);
    expect(store.nextPendingQueue(session.id)?.id).toBe(first.id);
    expect(store.transitionQueue(first.id, "pending", "dispatching")).toBe(true);
    expect(store.transitionQueue(first.id, "dispatching", "failed")).toBe(true);
    expect(store.nextPendingQueue(session.id)?.id).toBe(second.id);
    expect(() => store.enqueue(`sess_${"f".repeat(32)}`, "must roll back"))
      .toThrow("FOREIGN KEY constraint failed");
    const third = store.enqueue(session.id, "third");

    const inspector = new Database(paths.database, { create: false, strict: true });
    try {
      expect(inspector.query(
        "SELECT id,enqueue_sequence FROM queue_entries ORDER BY enqueue_sequence",
      ).all()).toEqual([
        { enqueue_sequence: 1, id: first.id },
        { enqueue_sequence: 2, id: second.id },
        { enqueue_sequence: 3, id: third.id },
      ]);
      expect(() => inspector.query(
        "UPDATE queue_entries SET enqueue_sequence=enqueue_sequence+100 WHERE id=?",
      ).run(second.id)).toThrow("queue enqueue sequence is immutable");
      expect(() => inspector.query(
        `INSERT OR REPLACE INTO queue_entries(
           id,session_id,message,state,created_at,updated_at,enqueue_sequence
         ) VALUES(?,?,?,?,?,?,?)`,
      ).run(second.id, session.id, "replace existing id", "pending", 1_000, 1_000, 100))
        .toThrow("queue enqueue identity already exists");
      expect(() => inspector.query(
        `INSERT OR REPLACE INTO queue_entries(
           id,session_id,message,state,created_at,updated_at,enqueue_sequence
         ) VALUES(?,?,?,?,?,?,?)`,
      ).run(`queue_${"f".repeat(32)}`, session.id, "steal sequence", "pending", 1_000, 1_000, 2))
        .toThrow("queue enqueue identity already exists");
      expect(inspector.query(
        "SELECT id,enqueue_sequence FROM queue_entries ORDER BY enqueue_sequence",
      ).all()).toEqual([
        { enqueue_sequence: 1, id: first.id },
        { enqueue_sequence: 2, id: second.id },
        { enqueue_sequence: 3, id: third.id },
      ]);
      expect(() => inspector.query(
        "UPDATE queue_sequence_authority SET next_sequence=1 WHERE singleton=1",
      ).run()).toThrow("queue sequence authority cannot regress");
      expect(() => inspector.query(
        "INSERT OR REPLACE INTO queue_sequence_authority(singleton,next_sequence) VALUES(1,1)",
      ).run()).toThrow("queue sequence authority already exists");
    } finally {
      inspector.close(false);
    }
  });

  test("selects the oldest pending queue row without scanning terminal history", async () => {
    const { store } = await fixture();
    const profile = store.createProfile("Bounded queue lookup");
    const session = store.createSession({
      profileId: profile.id,
      preset: "high",
      fastEnabled: false,
    });
    for (let index = 0; index < 2_000; index += 1) {
      const terminal = store.enqueue(session.id, `terminal ${String(index)}`);
      if (!store.transitionQueue(terminal.id, "pending", "cancelled")) {
        throw new Error("Terminal queue fixture transition failed.");
      }
    }
    const expected = store.enqueue(session.id, "bounded pending work");
    const later = store.enqueue(session.id, "later pending work");

    const originalListQueue = store.listQueue.bind(store);
    (store as unknown as { listQueue: StateStore["listQueue"] }).listQueue = () => {
      throw new Error("nextPendingQueue must not materialize terminal history");
    };
    try {
      expect(store.nextPendingQueue(session.id)).toMatchObject({
        id: expected.id,
        message: "bounded pending work",
        state: "pending",
      });
    } finally {
      (store as unknown as { listQueue: StateStore["listQueue"] }).listQueue = originalListQueue;
    }
    expect(store.nextPendingQueue(session.id)?.id).not.toBe(later.id);

    const inspector = new Database(store.paths.database, { create: false, strict: true });
    try {
      const plan = inspector.query(
        `EXPLAIN QUERY PLAN
         SELECT id,session_id,message,state,created_at,updated_at
         FROM queue_entries
         WHERE session_id=? AND state='pending'
         ORDER BY enqueue_sequence LIMIT 1`,
      ).all(session.id) as Array<{ detail: string }>;
      expect(plan.map((entry) => entry.detail).join(" ")).toContain("queue_pending_sequence");
    } finally {
      inspector.close(false);
    }
  });

  test("removes settled queue bodies without losing replay or recovery authority", async () => {
    const { store } = await fixture();
    const profile = signInProfile(store, "Queue body custody", "queue-body@example.com");
    const created = store.createSession({
      profileId: profile.id,
      preset: "high",
      fastEnabled: false,
    });
    const session = store.bindSession({
      sessionId: created.id,
      expectedRevision: created.revision,
      providerThreadId: "thread-queue-body-custody",
      state: "idle",
      providerUpdatedAt: 10,
    });
    const runtime = {
      profileId: profile.id,
      processGeneration: profile.processGeneration,
      observedAt: 2_000,
      preset: "high" as const,
      model: "gpt-6-astra",
      reasoningEffort: "max" as const,
      serviceTier: null,
      fast: false,
      approvalPolicy: "on-request" as const,
      reviewMode: "auto_review" as const,
      permissionProfile: ":workspace" as const,
      computerUse: true as const,
      pluginCapability: true as const,
      enabledApps: [],
    };
    const removed = "[queue message removed after settlement]";
    const pending = store.enqueue(session.id, "pending body remains available");
    expect(store.requireQueue(pending.id).message).toBe("pending body remains available");

    const replayKey = "00000000-0000-4000-8000-000000000801";
    const sentinel = "QUEUE_TERMINAL_BODY_SENTINEL";
    const maximumBody = `${sentinel}${"x".repeat(262_144 - sentinel.length)}`;
    const cancelled = store.enqueueIdempotent({
      sessionId: session.id,
      profileGeneration: profile.processGeneration,
      message: maximumBody,
      idempotencyKey: replayKey,
    });
    expect(store.transitionQueue(cancelled.id, "pending", "cancelled")).toBe(true);
    expect(store.requireQueue(cancelled.id)).toMatchObject({
      id: cancelled.id,
      message: removed,
      state: "cancelled",
    });
    expect(store.enqueueIdempotent({
      sessionId: session.id,
      profileGeneration: profile.processGeneration,
      message: maximumBody,
      idempotencyKey: replayKey,
    })).toMatchObject({
      id: cancelled.id,
      message: removed,
      state: "cancelled",
    });
    expect(store.listQueue(session.id).filter((entry) => entry.id === cancelled.id))
      .toHaveLength(1);
    expect(await stateFileSuffixesContaining(store.paths.database, sentinel)).toEqual([]);

    const begin = (message: string) => {
      const queued = store.enqueue(session.id, message);
      const evidence = store.beginQueueEffect({
        queueId: queued.id,
        sessionId: session.id,
        profileGeneration: profile.processGeneration,
        evidence: {
          kind: "queue.dispatch",
          queueId: queued.id,
          sessionId: session.id,
          providerThreadId: "thread-queue-body-custody",
          profileGeneration: profile.processGeneration,
          baseline: { providerUpdatedAt: 10, status: "idle" as const, activeTurnId: null },
          clientMessageId: queued.id,
          messageDigest: new Bun.CryptoHasher("sha256").update(message).digest("hex"),
          runtimeProfile: runtime,
        },
      });
      return { evidence, queued };
    };

    const applied = begin("applied queue body sentinel");
    const invalidDispatchResolution = new Database(store.paths.database, { create: false, strict: true });
    try {
      expect(() => invalidDispatchResolution.query(
        `INSERT INTO queue_effect_resolutions(
           queue_id,resolution_kind,evidence_json,receipt_json,created_at
         ) VALUES (?,?,?,?,?)`,
      ).run(
        applied.queued.id,
        "abandoned",
        JSON.stringify({ source: "invalid_dispatch_resolution" }),
        null,
        2_000,
      )).toThrow("queue effect resolution authority mismatch");
      expect(invalidDispatchResolution.query(
        "SELECT message,state FROM queue_entries WHERE id=?",
      ).get(applied.queued.id)).toEqual({
        message: "applied queue body sentinel",
        state: "dispatching",
      });
    } finally {
      invalidDispatchResolution.close(false);
    }
    store.completeQueueEffect({
      queueId: applied.queued.id,
      accountId: profile.id,
      providerGeneration: profile.processGeneration,
      providerConnectionId: null,
      expectedEvidenceDigest: applied.evidence.digest,
      expectedSessionRevision: session.revision,
      applyResponseState: false,
      turnId: "turn-queue-body-custody",
      turnStatus: "completed",
      runtimeProfile: runtime,
      message: "applied queue body sentinel",
      receipt: { turnId: "turn-queue-body-custody" },
    });
    expect(store.requireQueue(applied.queued.id)).toMatchObject({
      message: removed,
      state: "applied",
    });

    const failed = begin("failed queue body sentinel");
    expect(store.failQueueEffect(failed.queued.id)).toBe(true);
    expect(store.requireQueue(failed.queued.id)).toMatchObject({
      message: removed,
      state: "failed",
    });

    const ambiguous = begin("ambiguous body retained until exact recovery");
    store.markQueueEffectAmbiguous(ambiguous.queued.id, ambiguous.evidence.digest);
    expect(store.requireQueue(ambiguous.queued.id)).toMatchObject({
      message: "ambiguous body retained until exact recovery",
      state: "ambiguous",
    });
    const invalidAmbiguousResolution = new Database(store.paths.database, { create: false, strict: true });
    try {
      const insert = (kind: "abandoned" | "proven_applied", evidence: string, receipt: string | null) =>
        invalidAmbiguousResolution.query(
          `INSERT INTO queue_effect_resolutions(
             queue_id,resolution_kind,evidence_json,receipt_json,created_at
           ) VALUES (?,?,?,?,?)`,
        ).run(ambiguous.queued.id, kind, evidence, receipt, 2_000);
      expect(() => insert(
        "proven_applied",
        JSON.stringify({ source: "missing_receipt" }),
        null,
      )).toThrow("queue effect resolution authority mismatch");
      expect(() => insert(
        "abandoned",
        JSON.stringify({ source: "unexpected_receipt" }),
        JSON.stringify({ turnId: "turn-should-not-exist" }),
      )).toThrow("queue effect resolution authority mismatch");
      expect(() => insert("abandoned", "not-json", null))
        .toThrow("queue effect resolution authority mismatch");
      expect(() => insert(
        "abandoned",
        JSON.stringify({ source: "syntactically_valid_but_unauthorized" }),
        null,
      )).toThrow("queue effect resolution authority mismatch");
      invalidAmbiguousResolution.exec("BEGIN IMMEDIATE");
      try {
        invalidAmbiguousResolution.query(
          "UPDATE sessions SET state='idle',revision=revision+1,updated_at=updated_at+1 WHERE id=?",
        ).run(session.id);
        expect(() => insert(
          "proven_applied",
          JSON.stringify({ source: "missing_exact_turn_binding" }),
          JSON.stringify({ turnId: "turn-without-queue-binding" }),
        )).toThrow("queue effect resolution authority mismatch");
      } finally {
        invalidAmbiguousResolution.exec("ROLLBACK");
      }
      expect(invalidAmbiguousResolution.query(
        "SELECT message,state FROM queue_entries WHERE id=?",
      ).get(ambiguous.queued.id)).toEqual({
        message: "ambiguous body retained until exact recovery",
        state: "ambiguous",
      });
    } finally {
      invalidAmbiguousResolution.close(false);
    }
    store.resolveQueueEffect({
      queueId: ambiguous.queued.id,
      expectedEvidenceDigest: ambiguous.evidence.digest,
      resolution: "abandoned",
      resolutionEvidence: { source: "test_provider_observation" },
      provider: {
        providerThreadId: "thread-queue-body-custody",
        title: "Recovered queue body custody",
        status: "idle",
        providerUpdatedAt: 20,
      },
    });
    expect(store.requireQueue(ambiguous.queued.id)).toMatchObject({
      message: removed,
      state: "ambiguous",
    });
    expect(store.readQueueEffect(ambiguous.queued.id)).toMatchObject({
      digest: ambiguous.evidence.digest,
      resolution: {
        evidence: { source: "test_provider_observation" },
        kind: "abandoned",
      },
    });
    expect(store.listUnsettledQueueEffects(session.id)).toEqual([]);

    const directTransitionSentinel = "DIRECT_SQL_TERMINAL_BODY_SENTINEL";
    const terminalInsertSentinel = "DIRECT_SQL_TERMINAL_INSERT_SENTINEL";
    const insertedId = `queue_${"e".repeat(32)}`;
    const directTransition = store.enqueue(session.id, directTransitionSentinel);
    const inspector = new Database(store.paths.database, { create: false, strict: true });
    try {
      inspector.query(
        "UPDATE queue_entries SET state='cancelled',updated_at=updated_at+1 WHERE id=?",
      ).run(directTransition.id);
      expect(inspector.query("SELECT message,state FROM queue_entries WHERE id=?").get(
        directTransition.id,
      )).toEqual({ message: directTransitionSentinel, state: "cancelled" });
      expect(() => inspector.query(
        "UPDATE queue_entries SET message='restored raw body' WHERE id=?",
      ).run(directTransition.id)).toThrow(
        "queue message is immutable except for settlement removal",
      );
      expect(() => inspector.query(
        "UPDATE queue_entries SET message='rewritten pending body' WHERE id=?",
      ).run(pending.id)).toThrow(
        "queue message is immutable except for settlement removal",
      );

      inspector.query(
        `INSERT INTO queue_entries(
           id,session_id,message,state,created_at,updated_at,enqueue_sequence
         ) VALUES(?,?,?,?,?,?,?)`,
      ).run(
        insertedId,
        session.id,
        terminalInsertSentinel,
        "cancelled",
        1_000,
        1_000,
        900_000,
      );
      expect(inspector.query("SELECT message,state FROM queue_entries WHERE id=?").get(
        insertedId,
      )).toEqual({ message: terminalInsertSentinel, state: "cancelled" });
      expect(JSON.stringify(inspector.query(
        "SELECT message FROM queue_entries WHERE id IN (?,?) ORDER BY id",
      ).all(directTransition.id, insertedId)))
        .toContain(directTransitionSentinel);
      expect(inspector.query(
        "SELECT requires_vacuum FROM queue_message_scrub_authority WHERE singleton=1",
      ).get()).toEqual({ requires_vacuum: 0 });
    } finally {
      inspector.close(false);
    }
    const paths = store.paths;
    store.close();
    stores.splice(stores.indexOf(store), 1);
    const reopened = new StateStore(paths, { now: () => 3_000 });
    stores.push(reopened);
    expect(reopened.requireQueue(directTransition.id)).toMatchObject({
      message: removed,
      state: "cancelled",
    });
    expect(reopened.requireQueue(insertedId as `queue_${string}`)).toMatchObject({
      message: removed,
      state: "cancelled",
    });
    expect(await stateFileSuffixesContaining(paths.database, directTransitionSentinel)).toEqual([]);
    expect(await stateFileSuffixesContaining(paths.database, terminalInsertSentinel)).toEqual([]);
    const scrubInspector = new Database(paths.database, { readonly: true, strict: true });
    try {
      expect(scrubInspector.query(
        "SELECT required_at,requires_vacuum FROM queue_message_scrub_authority WHERE singleton=1",
      ).get()).toBeNull();
    } finally {
      scrubInspector.close(false);
    }
  });

  test("migrates and physically scrubs v20 terminal and resolved-ambiguous queue bodies", async () => {
    const { store } = await fixture();
    const profile = signInProfile(store, "Legacy queue bodies", "legacy-queue@example.com");
    const created = store.createSession({
      profileId: profile.id,
      preset: "high",
      fastEnabled: false,
    });
    const session = store.bindSession({
      sessionId: created.id,
      expectedRevision: created.revision,
      providerThreadId: "thread-legacy-queue-bodies",
      state: "idle",
      providerUpdatedAt: 10,
    });
    const terminal = store.enqueue(session.id, "already terminal body");
    expect(store.transitionQueue(terminal.id, "pending", "cancelled")).toBe(true);

    const ambiguousMessage = "V20_RESOLVED_AMBIGUOUS_QUEUE_SENTINEL";
    const ambiguous = store.enqueue(session.id, ambiguousMessage);
    const runtime = {
      profileId: profile.id,
      processGeneration: profile.processGeneration,
      observedAt: 2_000,
      preset: "high" as const,
      model: "gpt-6-astra",
      reasoningEffort: "max" as const,
      serviceTier: null,
      fast: false,
      approvalPolicy: "on-request" as const,
      reviewMode: "auto_review" as const,
      permissionProfile: ":workspace" as const,
      computerUse: true as const,
      pluginCapability: true as const,
      enabledApps: [],
    };
    const evidence = store.beginQueueEffect({
      queueId: ambiguous.id,
      sessionId: session.id,
      profileGeneration: profile.processGeneration,
      evidence: {
        kind: "queue.dispatch",
        queueId: ambiguous.id,
        sessionId: session.id,
        providerThreadId: "thread-legacy-queue-bodies",
        profileGeneration: profile.processGeneration,
        baseline: { providerUpdatedAt: 10, status: "idle", activeTurnId: null },
        clientMessageId: ambiguous.id,
        messageDigest: new Bun.CryptoHasher("sha256").update(ambiguousMessage).digest("hex"),
        runtimeProfile: runtime,
      },
    });
    store.markQueueEffectAmbiguous(ambiguous.id, evidence.digest);

    const paths = store.paths;
    store.close();
    stores.splice(stores.indexOf(store), 1);
    const legacy = new Database(paths.database, { create: false, strict: true });
    legacy.exec(`
      PRAGMA secure_delete=OFF;
      DROP TRIGGER IF EXISTS queue_message_settlement_guard;
      DROP TRIGGER IF EXISTS queue_message_terminal_insert_scrub;
      DROP TRIGGER IF EXISTS queue_message_terminal_transition_scrub;
      DROP TRIGGER IF EXISTS queue_message_resolution_scrub;
      DROP TRIGGER IF EXISTS queue_message_scrub_authority_record;
      DROP TRIGGER IF EXISTS queue_effect_resolution_authority_guard;
      DROP TABLE IF EXISTS queue_message_scrub_authority;
      DELETE FROM migrations WHERE version IN (21,22,23,24);
      PRAGMA user_version=20;
    `);
    legacy.query(
      "UPDATE queue_entries SET message=? WHERE id=?",
    ).run("V20_TERMINAL_QUEUE_SENTINEL", terminal.id);
    legacy.query(
      `INSERT INTO queue_effect_resolutions(
         queue_id,resolution_kind,evidence_json,receipt_json,created_at
       ) VALUES (?,?,?,?,?)`,
    ).run(
      ambiguous.id,
      "abandoned",
      JSON.stringify({ source: "legacy_provider_observation" }),
      null,
      2_000,
    );
    legacy.query(
      `UPDATE sessions
       SET state='idle',active_turn_id=NULL,revision=revision+1,updated_at=MAX(updated_at,2000)
       WHERE id=? AND state='recovery_required'`,
    ).run(session.id);
    legacy.close(false);

    expect(await stateFileSuffixesContaining(paths.database, "V20_TERMINAL_QUEUE_SENTINEL"))
      .not.toEqual([]);
    expect(await stateFileSuffixesContaining(paths.database, ambiguousMessage)).not.toEqual([]);

    const migrated = new StateStore(paths, { now: () => 3_000 });
    stores.push(migrated);
    const removed = "[queue message removed after settlement]";
    expect(migrated.requireQueue(terminal.id)).toMatchObject({
      message: removed,
      state: "cancelled",
    });
    expect(migrated.requireQueue(ambiguous.id)).toMatchObject({
      message: removed,
      state: "ambiguous",
    });
    expect(migrated.readQueueEffect(ambiguous.id)).toMatchObject({
      digest: evidence.digest,
      resolution: {
        evidence: { source: "legacy_provider_observation" },
        kind: "abandoned",
      },
    });
    expect(migrated.listUnsettledQueueEffects(session.id)).toEqual([]);

    const inspector = new Database(paths.database, { readonly: true, strict: true });
    try {
      expect(inspector.query("PRAGMA user_version").get()).toEqual({ user_version: 41 });
      expect(inspector.query(
        "SELECT applied_at FROM migrations WHERE version=23",
      ).get()).toEqual({ applied_at: 3_000 });
      expect(JSON.stringify(inspector.query(
        "SELECT id,message FROM queue_entries WHERE id IN (?,?) ORDER BY id",
      ).all(terminal.id, ambiguous.id))).not.toContain("QUEUE_SENTINEL");
      expect(inspector.query(
        "SELECT required_at,requires_vacuum FROM queue_message_scrub_authority WHERE singleton=1",
      ).get()).toBeNull();
    } finally {
      inspector.close(false);
    }
    expect(await stateFileSuffixesContaining(paths.database, "V20_TERMINAL_QUEUE_SENTINEL"))
      .toEqual([]);
    expect(await stateFileSuffixesContaining(paths.database, ambiguousMessage)).toEqual([]);
  });

  test("keeps a pinned-reader queue scrub unavailable until restart can truncate its WAL", async () => {
    const { store } = await fixture({ securityScrubCheckpoint: shortScrubCheckpoint });
    const profile = signInProfile(store, "Pinned queue scrub", "pinned-queue@example.com");
    const session = store.createSession({
      profileId: profile.id,
      preset: "high",
      fastEnabled: false,
    });
    const sentinel = `PINNED_QUEUE_BODY_SENTINEL_${"x".repeat(8_192)}`;
    const queued = store.enqueue(session.id, sentinel);
    const paths = store.paths;
    const pinnedReader = new Database(paths.database, { readonly: true, strict: true });
    pinnedReader.exec("BEGIN");
    expect(pinnedReader.query("SELECT message FROM queue_entries WHERE id=?").get(queued.id))
      .toEqual({ message: sentinel });
    try {
      let failure: unknown;
      try {
        store.transitionQueue(queued.id, "pending", "cancelled");
      } catch (error: unknown) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(StateSecurityScrubRequiredError);
      expect(failure).toMatchObject({
        message: "STATE_SECURITY_SCRUB_REQUIRED",
        operationCommitted: true,
      });
      expect(store.requireQueue(queued.id)).toMatchObject({
        message: "[queue message removed after settlement]",
        state: "cancelled",
      });
      const inspector = new Database(paths.database, { readonly: true, strict: true });
      try {
        expect(inspector.query(
          "SELECT requires_vacuum FROM queue_message_scrub_authority WHERE singleton=1",
        ).get()).toEqual({ requires_vacuum: 0 });
      } finally {
        inspector.close(false);
      }
      expect(() => {
        const unexpectedlyReadable = new StateStore(paths, { readonly: true });
        unexpectedlyReadable.close();
      }).toThrow("STATE_SECURITY_SCRUB_REQUIRED");
      expect(await stateFileSuffixesContaining(paths.database, "PINNED_QUEUE_BODY_SENTINEL"))
        .not.toEqual([]);
    } finally {
      pinnedReader.exec("COMMIT");
      pinnedReader.close(false);
    }

    // The same exact call first resumes the durable scrub. Its false result
    // preserves CAS ownership instead of pretending the retry performed the
    // already-committed transition.
    expect(store.transitionQueue(queued.id, "pending", "cancelled")).toBe(false);
    expect(await stateFileSuffixesContaining(paths.database, "PINNED_QUEUE_BODY_SENTINEL"))
      .toEqual([]);

    store.close();
    stores.splice(stores.indexOf(store), 1);
    const recovered = new StateStore(paths, { now: () => 4_000 });
    stores.push(recovered);
    expect(recovered.requireQueue(queued.id)).toMatchObject({
      message: "[queue message removed after settlement]",
      state: "cancelled",
    });
    expect(await stateFileSuffixesContaining(paths.database, "PINNED_QUEUE_BODY_SENTINEL"))
      .toEqual([]);
  }, 20_000);

  test("completes a queue scrub after a brief reader releases its WAL snapshot", async () => {
    const { store, home } = await fixture();
    const profile = signInProfile(store, "Brief reader queue scrub", "brief-reader@example.com");
    const session = store.createSession({
      profileId: profile.id,
      preset: "high",
      fastEnabled: false,
    });
    const sentinel = `BRIEF_READER_QUEUE_BODY_SENTINEL_${"x".repeat(8_192)}`;
    const queued = store.enqueue(session.id, sentinel);
    const paths = store.paths;
    // 750 ms outlives the retired 250 ms single attempt and sits well inside
    // one 5 s attempt of the production policy.
    const reader = await spawnReaderProcess(home, "pinned-reader", pinnedReaderSource, [
      paths.database,
      "750",
    ]);
    try {
      expect(await reader.nextLine()).toBe("pinned");
      const startedAt = performance.now();
      expect(store.transitionQueue(queued.id, "pending", "cancelled")).toBe(true);
      // The checkpoint waited on the pinned snapshot rather than passing vacuously.
      expect(performance.now() - startedAt).toBeGreaterThanOrEqual(400);
      expect(await reader.nextLine()).toBe("released");
      expect(await reader.exited).toBe(0);
    } finally {
      reader.kill();
    }
    expect(store.requireQueue(queued.id)).toMatchObject({
      message: "[queue message removed after settlement]",
      state: "cancelled",
    });
    const inspector = new Database(paths.database, { readonly: true, strict: true });
    try {
      expect(inspector.query(
        "SELECT required_at FROM queue_message_scrub_authority WHERE singleton=1",
      ).get()).toBeNull();
    } finally {
      inspector.close(false);
    }
    expect(await stateFileSuffixesContaining(paths.database, "BRIEF_READER_QUEUE_BODY_SENTINEL"))
      .toEqual([]);
    const readonly = new StateStore(paths, { readonly: true });
    stores.push(readonly);
    expect(readonly.requireQueue(queued.id).state).toBe("cancelled");
  }, 20_000);

  test("settles queue messages while a readonly status reader reopens the same state directory", async () => {
    const { store, home } = await fixture();
    const profile = signInProfile(store, "Status reader settlement", "status-reader@example.com");
    const session = store.createSession({
      profileId: profile.id,
      preset: "high",
      fastEnabled: false,
    });
    const paths = store.paths;
    const stopFile = join(home, "stop-status-reader");
    const reader = await spawnReaderProcess(home, "status-reader", statusReaderSource, [
      home,
      stopFile,
    ]);
    let settled = 0;
    try {
      expect(await reader.nextLine()).toBe("started");
      const deadline = performance.now() + 1_500;
      while ((settled < 25 || performance.now() < deadline) && settled < 200) {
        const queued = store.enqueue(
          session.id,
          `STATUS_READER_QUEUE_BODY_${settled}_${"y".repeat(4_096)}`,
        );
        expect(store.transitionQueue(queued.id, "pending", "cancelled")).toBe(true);
        settled += 1;
      }
      await writeFile(stopFile, "stop\n", { mode: 0o600 });
      const report = statusReaderReportSchema.parse(JSON.parse(await reader.nextLine()));
      expect(report.opens).toBeGreaterThanOrEqual(2);
      expect(await reader.exited).toBe(0);
    } finally {
      reader.kill();
    }
    expect(settled).toBeGreaterThanOrEqual(25);
    expect(await stateFileSuffixesContaining(paths.database, "STATUS_READER_QUEUE_BODY_"))
      .toEqual([]);
  }, 30_000);

  test("skips the foreign key scan on readonly opens and keeps it on writable opens", async () => {
    const { store } = await fixture();
    signInProfile(store, "Readonly integrity", "readonly-integrity@example.com");
    const paths = store.paths;
    store.close();
    stores.splice(stores.indexOf(store), 1);
    // A dangling child row passes every identity check and is visible only to
    // PRAGMA foreign_key_check, so it separates the two open paths exactly.
    const raw = new Database(paths.database, { strict: true });
    try {
      raw.exec("PRAGMA foreign_keys=OFF");
      raw.query(
        "INSERT INTO usage_cloud_upload_anchors(profile_id,source_revision,received_at) VALUES (?,1,1)",
      ).run(`acct_${"f".repeat(32)}`);
      expect(raw.query("PRAGMA foreign_key_check").all()).toHaveLength(1);
    } finally {
      raw.close(false);
    }
    const readonly = new StateStore(paths, { readonly: true });
    stores.push(readonly);
    expect(readonly.listProfiles()).toHaveLength(1);
    expect(() => {
      const writable = new StateStore(paths);
      writable.close();
    }).toThrow("WORK_SCHEMA_FOREIGN_KEY_VIOLATION");
  });

  test("repairs stale current-version queue triggers before accepting more state", async () => {
    const { store } = await fixture();
    const profile = signInProfile(store, "Stale queue trigger", "stale-trigger@example.com");
    const session = store.createSession({
      profileId: profile.id,
      preset: "high",
      fastEnabled: false,
    });
    const sentinel = "STALE_TRIGGER_QUEUE_BODY_SENTINEL";
    const queued = store.enqueue(session.id, sentinel);
    const paths = store.paths;
    store.close();
    stores.splice(stores.indexOf(store), 1);

    const stale = new Database(paths.database, { create: false, strict: true });
    stale.exec(`
      DROP TRIGGER queue_message_terminal_transition_scrub;
      CREATE TRIGGER queue_message_terminal_transition_scrub
      AFTER UPDATE OF state ON queue_entries
      BEGIN SELECT 1; END;
    `);
    stale.query(
      "UPDATE queue_entries SET state='cancelled',updated_at=updated_at+1 WHERE id=?",
    ).run(queued.id);
    expect(stale.query(
      "SELECT message,state FROM queue_entries WHERE id=?",
    ).get(queued.id)).toEqual({ message: sentinel, state: "cancelled" });
    expect(stale.query(
      "SELECT generation FROM queue_message_scrub_authority WHERE singleton=1",
    ).get()).toBeNull();
    stale.close(false);

    const repaired = new StateStore(paths, { now: () => 5_000 });
    stores.push(repaired);
    expect(repaired.requireQueue(queued.id)).toMatchObject({
      message: "[queue message removed after settlement]",
      state: "cancelled",
    });
    expect(await stateFileSuffixesContaining(paths.database, sentinel)).toEqual([]);
    const inspector = new Database(paths.database, { readonly: true, strict: true });
    try {
      expect(inspector.query(
        "SELECT generation FROM queue_message_scrub_authority WHERE singleton=1",
      ).get()).toBeNull();
      const trigger = z.object({ sql: z.string() }).parse(inspector.query(
        "SELECT sql FROM sqlite_master WHERE type='trigger' AND name='queue_message_terminal_transition_scrub'",
      ).get());
      expect(trigger.sql).toContain("queue_message_scrub_authority");
    } finally {
      inspector.close(false);
    }
  });

  test("retains a newer scrub generation when a settlement follows a checkpoint snapshot", async () => {
    const { store } = await fixture();
    const profile = signInProfile(store, "Scrub generation", "scrub-generation@example.com");
    const session = store.createSession({
      profileId: profile.id,
      preset: "high",
      fastEnabled: false,
    });
    const firstSentinel = "SCRUB_GENERATION_FIRST_SENTINEL";
    const secondSentinel = "SCRUB_GENERATION_SECOND_SENTINEL";
    const first = store.enqueue(session.id, firstSentinel);
    const second = store.enqueue(session.id, secondSentinel);
    const paths = store.paths;
    store.close();
    stores.splice(stores.indexOf(store), 1);

    const writer = new Database(paths.database, { create: false, strict: true });
    writer.query(
      "UPDATE queue_entries SET state='cancelled',updated_at=updated_at+1 WHERE id=?",
    ).run(first.id);
    const firstAuthority = z.object({ generation: z.number().int().positive() }).parse(
      writer.query(
        "SELECT generation FROM queue_message_scrub_authority WHERE singleton=1",
      ).get(),
    );
    expect(writer.query("PRAGMA wal_checkpoint(TRUNCATE)").get()).toEqual(
      expect.objectContaining({ busy: 0 }),
    );
    writer.query(
      "UPDATE queue_entries SET state='cancelled',updated_at=updated_at+1 WHERE id=?",
    ).run(second.id);
    expect(writer.query(
      "DELETE FROM queue_message_scrub_authority WHERE singleton=1 AND generation=?",
    ).run(firstAuthority.generation).changes).toBe(0);
    expect(writer.query(
      "SELECT generation FROM queue_message_scrub_authority WHERE singleton=1",
    ).get()).toEqual({ generation: firstAuthority.generation + 1 });
    writer.close(false);

    const recovered = new StateStore(paths, { now: () => 6_000 });
    stores.push(recovered);
    expect(recovered.requireQueue(first.id).message).toBe("[queue message removed after settlement]");
    expect(recovered.requireQueue(second.id).message).toBe("[queue message removed after settlement]");
    expect(await stateFileSuffixesContaining(paths.database, firstSentinel)).toEqual([]);
    expect(await stateFileSuffixesContaining(paths.database, secondSentinel)).toEqual([]);
  });

  test("binds, journals, applies, and exactly replays a desktop switch", async () => {
    const { store } = await fixture();
    const source = signInProfile(store, "Source", "source@example.com");
    const target = signInProfile(store, "Target", "Target@Example.com");
    const key = "11111111-1111-4111-8111-111111111111";
    const plan = await store.beginDesktopSwitch({
      idempotencyKey: key,
      requestedSource: {
        profileId: source.id,
        processGeneration: source.processGeneration,
      },
      target: {
        profileId: target.id,
        processGeneration: target.processGeneration,
      },
    });
    expect(plan).toMatchObject({
      status: "ready",
      journalStage: "new",
      expectedAccountKey: "target@example.com",
    });
    if (plan.status !== "ready") throw new Error("Expected a ready desktop switch plan.");
    const targetPaths = deriveDesktopProfilePaths(store.paths.root, target.id);
    const journal = {
      idempotencyKey: key,
      switchGeneration: plan.switchGeneration,
      sourceProfileId: source.id,
      sourceProcessGeneration: source.processGeneration,
      targetProfileId: target.id,
      targetProcessGeneration: target.processGeneration,
      bundleCdHash: "a".repeat(40),
      sourcePid: 101,
      targetPaths,
      expectedAccountKey: "target@example.com",
    } as const;
    await store.prepareDesktopSwitchJournal(journal);
    await store.prepareDesktopSwitchJournal(journal);
    expect(await store.beginDesktopSwitch({
      idempotencyKey: key,
      requestedSource: {
        profileId: source.id,
        processGeneration: source.processGeneration,
      },
      target: {
        profileId: target.id,
        processGeneration: target.processGeneration,
      },
    })).toMatchObject({ status: "ready", journalStage: "prepared" });
    await store.assertDesktopEffectsSettled(plan);
    await store.advanceDesktopSwitchJournal({
      idempotencyKey: key,
      switchGeneration: plan.switchGeneration,
      stage: "quit-requested",
    });
    await store.advanceDesktopSwitchJournal({
      idempotencyKey: key,
      switchGeneration: plan.switchGeneration,
      stage: "source-quiesced",
    });
    await store.advanceDesktopSwitchJournal({
      idempotencyKey: key,
      switchGeneration: plan.switchGeneration,
      stage: "launch-requested",
    });
    await store.advanceDesktopSwitchJournal({
      idempotencyKey: key,
      switchGeneration: plan.switchGeneration,
      stage: "target-observed",
      launchedPid: 202,
    });
    await store.advanceDesktopSwitchJournal({
      idempotencyKey: key,
      switchGeneration: plan.switchGeneration,
      stage: "verified",
      launchedPid: 202,
    });

    expect(await store.beginDesktopSwitch({
      idempotencyKey: key,
      requestedSource: {
        profileId: source.id,
        processGeneration: source.processGeneration,
      },
      target: {
        profileId: target.id,
        processGeneration: target.processGeneration,
      },
    })).toEqual({
      status: "applied",
      idempotencyKey: key,
      switchGeneration: plan.switchGeneration,
      sourceProfileId: source.id,
      sourceProcessGeneration: source.processGeneration,
      targetProfileId: target.id,
      targetProcessGeneration: target.processGeneration,
      expectedAccountKey: "target@example.com",
      activeAccount: {
        signedIn: true,
        email: "target@example.com",
        plan: "Plus",
      },
    });
  });

  test("rejects desktop idempotency and journal binding changes", async () => {
    const { store } = await fixture();
    const target = signInProfile(store, "Target", "target@example.com");
    const other = signInProfile(store, "Other", "other@example.com");
    const key = "22222222-2222-4222-8222-222222222222";
    const plan = await store.beginDesktopSwitch({
      idempotencyKey: key,
      target: { profileId: target.id, processGeneration: target.processGeneration },
    });
    if (plan.status !== "ready") throw new Error("Expected a ready desktop switch plan.");
    await expect(store.beginDesktopSwitch({
      idempotencyKey: key,
      target: { profileId: other.id, processGeneration: other.processGeneration },
    })).rejects.toThrow("IDEMPOTENCY_CONFLICT");
    const journal = {
      idempotencyKey: key,
      switchGeneration: plan.switchGeneration,
      sourceProfileId: null,
      sourceProcessGeneration: null,
      targetProfileId: target.id,
      targetProcessGeneration: target.processGeneration,
      bundleCdHash: "b".repeat(40),
      sourcePid: null,
      targetPaths: deriveDesktopProfilePaths(store.paths.root, target.id),
      expectedAccountKey: "target@example.com",
    } as const;
    await store.prepareDesktopSwitchJournal(journal);
    await expect(store.prepareDesktopSwitchJournal({
      ...journal,
      bundleCdHash: "c".repeat(40),
    })).rejects.toThrow("DESKTOP_JOURNAL_BINDING_CONFLICT");
  });

  test("collapses an effect-adjacent desktop restart to durable recovery", async () => {
    const { store } = await fixture();
    const target = signInProfile(store, "Crash target", "crash@example.com");
    const key = "33333333-3333-4333-8333-333333333333";
    const plan = await store.beginDesktopSwitch({
      idempotencyKey: key,
      target: { profileId: target.id, processGeneration: target.processGeneration },
    });
    if (plan.status !== "ready") throw new Error("Expected a ready desktop switch plan.");
    await store.prepareDesktopSwitchJournal({
      idempotencyKey: key,
      switchGeneration: plan.switchGeneration,
      sourceProfileId: null,
      sourceProcessGeneration: null,
      targetProfileId: target.id,
      targetProcessGeneration: target.processGeneration,
      bundleCdHash: "d".repeat(40),
      sourcePid: null,
      targetPaths: deriveDesktopProfilePaths(store.paths.root, target.id),
      expectedAccountKey: "crash@example.com",
    });
    await store.advanceDesktopSwitchJournal({
      idempotencyKey: key,
      switchGeneration: plan.switchGeneration,
      stage: "launch-requested",
    });

    const paths = store.paths;
    store.close();
    stores.splice(stores.indexOf(store), 1);
    const restarted = new StateStore(paths, { now: () => 7_000 });
    stores.push(restarted);

    expect(await restarted.beginDesktopSwitch({
      idempotencyKey: key,
      target: { profileId: target.id, processGeneration: target.processGeneration },
    })).toMatchObject({
      status: "recovery_required",
      diagnostic: "EFFECT_ADJACENT_RESTART",
    });
    expect(restarted.readMutation(key)).toMatchObject({ state: "ambiguous" });
    expect(await restarted.beginDesktopSwitch({
      idempotencyKey: key,
      target: { profileId: target.id, processGeneration: target.processGeneration },
    })).toMatchObject({
      status: "recovery_required",
      diagnostic: "EFFECT_ADJACENT_RESTART",
    });
  });

  test("fences desktop authority when a bound profile generation advances", async () => {
    const { store } = await fixture();
    const target = signInProfile(store, "Fence target", "fence@example.com");
    const plan = await store.beginDesktopSwitch({
      idempotencyKey: "44444444-4444-4444-8444-444444444444",
      target: { profileId: target.id, processGeneration: target.processGeneration },
    });
    if (plan.status !== "ready") throw new Error("Expected a ready desktop switch plan.");
    await store.prepareDesktopSwitchJournal({
      idempotencyKey: plan.idempotencyKey,
      switchGeneration: plan.switchGeneration,
      sourceProfileId: null,
      sourceProcessGeneration: null,
      targetProfileId: target.id,
      targetProcessGeneration: target.processGeneration,
      bundleCdHash: "e".repeat(40),
      sourcePid: null,
      targetPaths: deriveDesktopProfilePaths(store.paths.root, target.id),
      expectedAccountKey: "fence@example.com",
    });
    expect(store.isDesktopSwitchCurrent(plan)).toBe(true);
    expect(store.isDesktopSwitchCurrent({
      ...plan,
      targetProcessGeneration: target.processGeneration + 1,
    })).toBe(false);
    store.nextProfileGeneration(target.id);
    expect(store.isDesktopSwitchCurrent(plan)).toBe(false);
    await expect(store.assertDesktopEffectsSettled(plan)).rejects.toThrow(
      "DESKTOP_SWITCH_GENERATION_STALE",
    );
  });

  test("atomically cancels and releases a reserved switch after a no-effect failure", async () => {
    const { store } = await fixture();
    const target = signInProfile(store, "Prepared target", "prepared@example.com");
    const key = "55555555-5555-4555-8555-555555555555";
    const plan = await store.beginDesktopSwitch({
      idempotencyKey: key,
      target: { profileId: target.id, processGeneration: target.processGeneration },
    });
    if (plan.status !== "ready") throw new Error("Expected a ready desktop switch plan.");
    expect(store.settlePreparedDesktopSwitch({
      idempotencyKey: key,
      switchGeneration: plan.switchGeneration,
      sourceProfileId: plan.sourceProfileId,
      sourceProcessGeneration: plan.sourceProcessGeneration,
      targetProfileId: plan.targetProfileId,
      targetProcessGeneration: plan.targetProcessGeneration,
      diagnostic: "PRE_EFFECT_FAILURE",
    })).toBe(true);
    expect(store.readMutation(key)).toMatchObject({ state: "cancelled" });
    expect(store.readCurrentDesktopSwitchRecovery()).toEqual({ status: "none" });
    expect(store.settlePreparedDesktopSwitch({
      idempotencyKey: key,
      switchGeneration: plan.switchGeneration,
      sourceProfileId: plan.sourceProfileId,
      sourceProcessGeneration: plan.sourceProcessGeneration,
      targetProfileId: plan.targetProfileId,
      targetProcessGeneration: plan.targetProcessGeneration,
      diagnostic: "PRE_EFFECT_FAILURE",
    })).toBe(false);
    expect(await store.beginDesktopSwitch({
      idempotencyKey: "66666666-6666-4666-8666-666666666666",
      target: { profileId: target.id, processGeneration: target.processGeneration },
    })).toMatchObject({ status: "ready", switchGeneration: plan.switchGeneration + 1 });
  });

  test("appends a byte-stable desktop resolution without rewriting ambiguous evidence", async () => {
    const { store } = await fixture();
    const target = signInProfile(store, "Recovered target", "recover@example.com");
    const key = "77777777-7777-4777-8777-777777777777";
    const plan = await store.beginDesktopSwitch({
      idempotencyKey: key,
      target: { profileId: target.id, processGeneration: target.processGeneration },
    });
    if (plan.status !== "ready") throw new Error("Expected a ready desktop switch plan.");
    await store.prepareDesktopSwitchJournal({
      idempotencyKey: key,
      switchGeneration: plan.switchGeneration,
      sourceProfileId: null,
      sourceProcessGeneration: null,
      targetProfileId: target.id,
      targetProcessGeneration: target.processGeneration,
      bundleCdHash: "f".repeat(40),
      sourcePid: null,
      targetPaths: deriveDesktopProfilePaths(store.paths.root, target.id),
      expectedAccountKey: "recover@example.com",
    });
    await store.advanceDesktopSwitchJournal({
      idempotencyKey: key,
      switchGeneration: plan.switchGeneration,
      stage: "launch-requested",
    });
    await store.advanceDesktopSwitchJournal({
      idempotencyKey: key,
      switchGeneration: plan.switchGeneration,
      stage: "recovery-required",
      diagnostic: "LAUNCH_REQUESTED_INDETERMINATE",
    });
    const recovery = store.readCurrentDesktopSwitchRecovery() as {
      status: string;
      attemptId: string;
      originalPhase: string;
    } & Record<string, unknown>;
    expect(recovery).toMatchObject({
      status: "recovery_required",
      originalPhase: "launch_started",
      diagnostic: "LAUNCH_REQUESTED_INDETERMINATE",
    });
    const inspector = new Database(store.paths.database, { readonly: true, strict: true });
    const before = inspector.query("SELECT d.phase,d.ambiguous_from_phase,d.diagnostic_code,m.state AS mutation_state FROM desktop_switches d JOIN mutation_attempts m ON m.id=d.attempt_id WHERE d.attempt_id=?").get(recovery.attemptId);
    inspector.close(false);

    const resolutionInput = {
      attemptId: recovery.attemptId,
      idempotencyKey: key,
      switchGeneration: plan.switchGeneration,
      sourceProfileId: null,
      sourceProcessGeneration: null,
      targetProfileId: target.id,
      targetProcessGeneration: target.processGeneration,
      resolution: "resolved_applied" as const,
      diagnostic: "STABLE_TARGET_ACCOUNT_VERIFIED",
      observationDigest: "a".repeat(64),
      activeAccount: { signedIn: true, email: "Recover@Example.com", plan: "Plus" },
    };
    const receipt = store.resolveDesktopSwitchRecovery(resolutionInput);
    expect(store.resolveDesktopSwitchRecovery(resolutionInput)).toEqual(receipt);
    expect(store.readCurrentDesktopSwitchRecovery()).toEqual(receipt);
    expect(store.readDesktopSwitchReplay({
      idempotencyKey: key,
      target: { profileId: target.id, processGeneration: target.processGeneration },
    })).toMatchObject({
      status: "applied",
      activeAccount: { signedIn: true, email: "recover@example.com" },
    });
    const afterInspector = new Database(store.paths.database, { create: false, strict: true });
    try {
      expect(afterInspector.query("SELECT d.phase,d.ambiguous_from_phase,d.diagnostic_code,m.state AS mutation_state FROM desktop_switches d JOIN mutation_attempts m ON m.id=d.attempt_id WHERE d.attempt_id=?").get(recovery.attemptId)).toEqual(before);
      expect(afterInspector.query("UPDATE desktop_switch_resolutions SET diagnostic_code='CHANGED' WHERE attempt_id=?").run.bind(
        afterInspector.query("UPDATE desktop_switch_resolutions SET diagnostic_code='CHANGED' WHERE attempt_id=?"),
        recovery.attemptId,
      )).toThrow("desktop switch resolution is immutable");
    } finally {
      afterInspector.close(false);
    }

    const next = await store.beginDesktopSwitch({
      idempotencyKey: "88888888-8888-4888-8888-888888888888",
      target: { profileId: target.id, processGeneration: target.processGeneration },
    });
    expect(next).toMatchObject({ status: "ready", switchGeneration: plan.switchGeneration + 1 });
    expect(() => store.resolveDesktopSwitchRecovery(resolutionInput)).toThrow("DESKTOP_RECOVERY_CAS_CONFLICT");
    if (next.status !== "ready") throw new Error("Expected a ready second switch.");
    expect(store.isDesktopSwitchCurrent(next)).toBe(true);
  });

  test("enforces the original deadline before resolving a switch as not applied", async () => {
    const home = await realpath(await mkdtemp(join(tmpdir(), "hra-desktop-deadline-")));
    const paths = resolveStatePaths({ homeDirectory: home, platform: "darwin" });
    await initializeStatePaths(paths);
    let now = 10_000;
    const store = new StateStore(paths, { now: () => now });
    stores.push(store);
    const target = signInProfile(store, "Deadline target", "deadline@example.com");
    const key = "99999999-9999-4999-8999-999999999999";
    const plan = await store.beginDesktopSwitch({
      idempotencyKey: key,
      target: { profileId: target.id, processGeneration: target.processGeneration },
    });
    if (plan.status !== "ready") throw new Error("Expected a ready desktop switch plan.");
    await store.prepareDesktopSwitchJournal({
      idempotencyKey: key,
      switchGeneration: plan.switchGeneration,
      sourceProfileId: null,
      sourceProcessGeneration: null,
      targetProfileId: target.id,
      targetProcessGeneration: target.processGeneration,
      bundleCdHash: "e".repeat(40),
      sourcePid: null,
      targetPaths: deriveDesktopProfilePaths(store.paths.root, target.id),
      expectedAccountKey: "deadline@example.com",
    });
    await store.advanceDesktopSwitchJournal({ idempotencyKey: key, switchGeneration: plan.switchGeneration, stage: "launch-requested" });
    await store.advanceDesktopSwitchJournal({ idempotencyKey: key, switchGeneration: plan.switchGeneration, stage: "recovery-required" });
    const recovery = store.readCurrentDesktopSwitchRecovery() as { attemptId: string };
    const input = {
      attemptId: recovery.attemptId,
      idempotencyKey: key,
      switchGeneration: plan.switchGeneration,
      sourceProfileId: null,
      sourceProcessGeneration: null,
      targetProfileId: target.id,
      targetProcessGeneration: target.processGeneration,
      resolution: "resolved_not_applied" as const,
      diagnostic: "ZERO_EXACT_PROCESSES",
      observationDigest: "b".repeat(64),
    };
    expect(() => store.resolveDesktopSwitchRecovery(input)).toThrow("DESKTOP_RECOVERY_DEADLINE_PENDING");
    now += 30_001;
    expect(store.resolveDesktopSwitchRecovery(input)).toMatchObject({ status: "resolved_not_applied" });
  });

  test("records immutable effective runtime profiles under exact session authority", async () => {
    const { store } = await fixture();
    const profile = signInProfile(store, "Runtime profile", "runtime@example.com");
    const other = signInProfile(store, "Other runtime", "other-runtime@example.com");
    const session = store.createSession({ profileId: profile.id, preset: "high", fastEnabled: true });
    const firstProfile = {
      profileId: profile.id,
      processGeneration: profile.processGeneration,
      observedAt: 2_000,
      preset: "high" as const,
      model: "gpt-6-astra",
      reasoningEffort: "max" as const,
      serviceTier: null,
      fast: false,
      approvalPolicy: "on-request" as const,
      reviewMode: "auto_review" as const,
      permissionProfile: ":workspace" as const,
      computerUse: true as const,
      pluginCapability: true as const,
      enabledApps: [{ id: "app.alpha", name: "Alpha", pluginDisplayNames: ["Alpha plugin"] }],
    };
    const first = store.recordSessionRuntimeProfile({ sessionId: session.id, sourceKind: "session_start", sourceId: "attempt-one", profile: firstProfile });
    expect(first).toMatchObject({ revision: 1, sourceKind: "session_start", profile: firstProfile });
    expect(store.recordSessionRuntimeProfile({ sessionId: session.id, sourceKind: "session_start", sourceId: "attempt-one", profile: firstProfile })).toEqual(first);

    const secondProfile = { ...firstProfile, observedAt: 2_001, enabledApps: [] };
    expect(store.recordSessionRuntimeProfile({ sessionId: session.id, sourceKind: "turn_start", sourceId: "attempt-two", profile: secondProfile })).toMatchObject({ revision: 2 });
    expect(store.latestSessionRuntimeProfile(session.id)).toMatchObject({ revision: 2, profile: secondProfile });
    expect(() => store.recordSessionRuntimeProfile({ sessionId: session.id, sourceKind: "session_start", sourceId: "attempt-one", profile: secondProfile })).toThrow("source authority changed");
    expect(() => store.recordSessionRuntimeProfile({ sessionId: session.id, sourceKind: "queue_start", sourceId: "queue-one", profile: { ...secondProfile, profileId: other.id } })).toThrow("runtime profile session authority mismatch");

    const inspector = new Database(store.paths.database, { create: false, strict: true });
    try {
      expect(() => inspector.query("UPDATE session_runtime_profiles SET observed_at=observed_at+1 WHERE session_id=?").run(session.id)).toThrow("immutable");
      expect(() => inspector.query("DELETE FROM session_runtime_profiles WHERE session_id=?").run(session.id)).toThrow("immutable");
    } finally {
      inspector.close(false);
    }
  });

  test("rolls back send and queue receipts when their exact session revision CAS fails", async () => {
    const { store } = await fixture();
    const profile = signInProfile(store, "Receipt CAS", "receipt-cas@example.com");
    const runtime = {
      profileId: profile.id,
      processGeneration: profile.processGeneration,
      observedAt: 2_000,
      preset: "high" as const,
      model: "gpt-6-astra",
      reasoningEffort: "max" as const,
      serviceTier: null,
      fast: false,
      approvalPolicy: "on-request" as const,
      reviewMode: "auto_review" as const,
      permissionProfile: ":workspace" as const,
      computerUse: true as const,
      pluginCapability: true as const,
      enabledApps: [],
    };

    const localSend = store.createSession({ profileId: profile.id, preset: "high", fastEnabled: false });
    const sendSession = store.bindSession({ sessionId: localSend.id, expectedRevision: localSend.revision, providerThreadId: "thread-send-cas", state: "idle", providerUpdatedAt: 10 });
    const sendKey = "00000000-0000-4000-8000-000000000711";
    const sendAttempt = store.prepareMutation({ kind: "session.send", authorityId: sendSession.id, authorityGeneration: profile.processGeneration, request: { message: "send" }, idempotencyKey: sendKey });
    store.beginSessionMutationEffect({
      attemptId: sendAttempt.id,
      sessionId: sendSession.id,
      profileGeneration: profile.processGeneration,
      message: "send",
      evidence: {
        kind: "session.send",
        providerThreadId: "thread-send-cas",
        baseline: { providerUpdatedAt: 10, status: "idle", activeTurnId: null },
        clientMessageId: sendAttempt.id,
        messageDigest: createHash("sha256").update("send").digest("hex"),
        runtimeProfile: runtime,
      },
    });
    store.updateSessionMetadata({ sessionId: sendSession.id, expectedRevision: sendSession.revision, note: "concurrent" });
    expect(() => store.completeSessionTurnEffect({
      attemptId: sendAttempt.id,
      sessionId: sendSession.id,
      accountId: profile.id,
      providerGeneration: profile.processGeneration,
      providerConnectionId: null,
      expectedSessionRevision: sendSession.revision,
      applyResponseState: true,
      turnId: "turn-send-cas",
      turnStatus: "inProgress",
      runtimeProfile: runtime,
      message: "send",
      receipt: { turnId: "turn-send-cas" },
    })).toThrow("SESSION_TURN_STATE_CAS_CONFLICT");
    expect(store.readMutation(sendKey)).toMatchObject({ state: "effect_started" });
    expect(store.latestSessionRuntimeProfile(sendSession.id)).toBeNull();
    expect(store.requireSession(sendSession.id)).toMatchObject({ state: "idle", note: "concurrent" });

    const localQueue = store.createSession({ profileId: profile.id, preset: "high", fastEnabled: false });
    const queueSession = store.bindSession({ sessionId: localQueue.id, expectedRevision: localQueue.revision, providerThreadId: "thread-queue-cas", state: "idle", providerUpdatedAt: 10 });
    const queue = store.enqueue(queueSession.id, "queued");
    const queueEvidence = store.beginQueueEffect({
      queueId: queue.id,
      sessionId: queueSession.id,
      profileGeneration: profile.processGeneration,
      evidence: {
        kind: "queue.dispatch",
        queueId: queue.id,
        sessionId: queueSession.id,
        providerThreadId: "thread-queue-cas",
        profileGeneration: profile.processGeneration,
        baseline: { providerUpdatedAt: 10, status: "idle", activeTurnId: null },
        clientMessageId: queue.id,
        messageDigest: new Bun.CryptoHasher("sha256").update("queued").digest("hex"),
        runtimeProfile: runtime,
      },
    });
    store.updateSessionMetadata({ sessionId: queueSession.id, expectedRevision: queueSession.revision, fastEnabled: true });
    expect(() => store.completeQueueEffect({
      queueId: queue.id,
      accountId: profile.id,
      providerGeneration: profile.processGeneration,
      providerConnectionId: null,
      expectedEvidenceDigest: queueEvidence.digest,
      expectedSessionRevision: queueSession.revision,
      applyResponseState: true,
      turnId: "turn-queue-cas",
      turnStatus: "inProgress",
      runtimeProfile: runtime,
      message: "queued",
      receipt: { turnId: "turn-queue-cas" },
    })).toThrow("QUEUE_EFFECT_SESSION_CAS_CONFLICT");
    expect(store.requireQueue(queue.id)).toMatchObject({ state: "dispatching" });
    expect(store.latestSessionRuntimeProfile(queueSession.id)).toBeNull();
    expect(store.requireSession(queueSession.id)).toMatchObject({ state: "idle", fastEnabled: true });
  });

  test("commits sanitized send, steer, and queue message events with their effect receipts", async () => {
    const { store } = await fixture();
    const profile = signInProfile(store, "Atomic message events", "atomic-events@example.com");
    const runtime = codexRuntimeProfile(profile);
    const bind = (
      thread: string,
      state: "active" | "idle",
      activeTurnId?: string,
    ) => {
      const created = store.createSession({
        profileId: profile.id,
        preset: "high",
        fastEnabled: false,
      });
      return store.bindSession({
        sessionId: created.id,
        expectedRevision: created.revision,
        providerThreadId: thread,
        state,
        ...(activeTurnId === undefined ? {} : { activeTurnId }),
      });
    };

    const sendSession = bind("thread-atomic-send", "idle");
    const sendMessage = `/Users/private/project/${"x".repeat(
      SESSION_EVENT_USER_MESSAGE_MAX_CHARACTERS,
    )}`;
    const sendKey = peerIdempotencyKey(70_001);
    const sendAttempt = store.prepareMutation({
      kind: "session.send",
      authorityId: sendSession.id,
      authorityGeneration: profile.processGeneration,
      request: { message: sendMessage },
      idempotencyKey: sendKey,
    });
    store.beginSessionMutationEffect({
      attemptId: sendAttempt.id,
      sessionId: sendSession.id,
      profileGeneration: profile.processGeneration,
      message: sendMessage,
      evidence: {
        kind: "session.send",
        providerThreadId: "thread-atomic-send",
        baseline: { providerUpdatedAt: null, status: "idle", activeTurnId: null },
        clientMessageId: sendAttempt.id,
        messageDigest: testDigest(sendMessage),
        runtimeProfile: runtime,
      },
    });
    expect(store.bumpAutorespondCounter(sendSession.id)).toBe(1);
    expect(store.bumpAutorespondCounter(sendSession.id)).toBe(2);
    expect(() => store.completeSessionTurnEffect({
      attemptId: sendAttempt.id,
      sessionId: sendSession.id,
      accountId: profile.id,
      providerGeneration: profile.processGeneration,
      providerConnectionId: null,
      expectedSessionRevision: sendSession.revision,
      applyResponseState: false,
      turnId: "turn-atomic-send",
      turnStatus: "completed",
      runtimeProfile: runtime,
      message: `${sendMessage}changed`,
      receipt: { turnId: "turn-atomic-send" },
    })).toThrow("SESSION_MESSAGE_DIGEST_MISMATCH");
    expect(store.readMutation(sendKey)?.state).toBe("effect_started");
    expect(store.readSessionMessageEventSource(sendSession.id, sendAttempt.id)).toBeNull();
    expect(store.listSessionEvents({ sessionId: sendSession.id, afterSequence: 0 }).events)
      .toEqual([]);
    expect(store.latestSessionRuntimeProfile(sendSession.id)).toBeNull();
    expect(store.readAutorespondBudgets(sendSession.id).consecutive).toBe(2);

    const sent = store.completeSessionTurnEffect({
      attemptId: sendAttempt.id,
      sessionId: sendSession.id,
      accountId: profile.id,
      providerGeneration: profile.processGeneration,
      providerConnectionId: null,
      expectedSessionRevision: sendSession.revision,
      applyResponseState: false,
      turnId: "turn-atomic-send",
      turnStatus: "completed",
      runtimeProfile: runtime,
      message: sendMessage,
      receipt: { turnId: "turn-atomic-send" },
    });
    expect(sent).toMatchObject({
      appended: true,
      event: {
        body: {
          type: "user_message",
          actor: "human",
          text: "[local-path]",
          omittedCharacters: sendMessage.length
            - SESSION_EVENT_USER_MESSAGE_MAX_CHARACTERS,
        },
      },
    });
    expect(store.readAutorespondBudgets(sendSession.id).consecutive).toBe(0);
    expect(store.bumpAutorespondCounter(sendSession.id)).toBe(1);
    expect(store.appendSessionUserMessageEventOnce({
      sourceId: sendAttempt.id,
      sessionId: sendSession.id,
      accountId: profile.id,
      providerGeneration: profile.processGeneration,
      providerConnectionId: null,
      turnId: "turn-atomic-send",
      message: sendMessage,
    })).toEqual({ ...sent, appended: false });
    expect(store.readAutorespondBudgets(sendSession.id).consecutive).toBe(1);

    const steerSession = bind("thread-atomic-steer", "active", "turn-atomic-steer");
    const steerMessage = "sk_testabcdefgh";
    const steerKey = peerIdempotencyKey(70_002);
    const steerAttempt = store.prepareMutation({
      kind: "session.steer",
      authorityId: steerSession.id,
      authorityGeneration: profile.processGeneration,
      request: { message: steerMessage },
      idempotencyKey: steerKey,
    });
    store.beginSessionMutationEffect({
      attemptId: steerAttempt.id,
      sessionId: steerSession.id,
      profileGeneration: profile.processGeneration,
      message: steerMessage,
      evidence: {
        kind: "session.steer",
        providerThreadId: "thread-atomic-steer",
        baseline: {
          providerUpdatedAt: null,
          status: "active",
          activeTurnId: "turn-atomic-steer",
        },
        activeTurnId: "turn-atomic-steer",
        clientMessageId: steerAttempt.id,
        messageDigest: testDigest(steerMessage),
      },
    });
    expect(store.completeSessionSteerEffect({
      attemptId: steerAttempt.id,
      sessionId: steerSession.id,
      accountId: profile.id,
      providerGeneration: profile.processGeneration,
      providerConnectionId: null,
      turnId: "turn-atomic-steer",
      message: steerMessage,
      receipt: { steered: true, activeTurnId: "turn-atomic-steer" },
    })).toMatchObject({
      appended: true,
      event: { body: { type: "user_message", actor: "human", text: "[protected]" } },
    });

    const queueSession = bind("thread-atomic-queue", "idle");
    const queueMessage = "line one\nright\u202Eleft\u0000done";
    const queue = store.enqueue(queueSession.id, queueMessage);
    const queueEvidence = store.beginQueueEffect({
      queueId: queue.id,
      sessionId: queueSession.id,
      profileGeneration: profile.processGeneration,
      evidence: {
        kind: "queue.dispatch",
        queueId: queue.id,
        sessionId: queueSession.id,
        providerThreadId: "thread-atomic-queue",
        profileGeneration: profile.processGeneration,
        baseline: { providerUpdatedAt: null, status: "idle", activeTurnId: null },
        clientMessageId: queue.id,
        messageDigest: testDigest(queueMessage),
        runtimeProfile: runtime,
      },
    });
    expect(store.completeQueueEffect({
      queueId: queue.id,
      accountId: profile.id,
      providerGeneration: profile.processGeneration,
      providerConnectionId: null,
      expectedEvidenceDigest: queueEvidence.digest,
      expectedSessionRevision: queueSession.revision,
      applyResponseState: false,
      turnId: "turn-atomic-queue",
      turnStatus: "completed",
      runtimeProfile: runtime,
      message: queueMessage,
      receipt: { turnId: "turn-atomic-queue" },
    })).toMatchObject({
      appended: true,
      event: {
        body: {
          type: "user_message",
          actor: "human",
          text: "line one\nright�left�done",
        },
      },
    });

    const cutoffSecrets = [
      ["aws", "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"],
      ["google", `AIza${"Sy".repeat(17)}A`],
      ["npm", `npm_${"Ab9".repeat(12)}`],
    ] as const;
    for (const [index, [name, secret]] of cutoffSecrets.entries()) {
      const cutoffMessage = `${" ".repeat(
        SESSION_EVENT_USER_MESSAGE_MAX_CHARACTERS - secret.length + 1,
      )}${secret} tail`;
      expect(cutoffMessage.slice(0, SESSION_EVENT_USER_MESSAGE_MAX_CHARACTERS))
        .toEndWith(secret.slice(0, -1));
      const cutoffSession = bind(`thread-atomic-cutoff-${name}`, "idle");
      const cutoffKey = peerIdempotencyKey(70_010 + index);
      const cutoffAttempt = store.prepareMutation({
        kind: "session.send",
        authorityId: cutoffSession.id,
        authorityGeneration: profile.processGeneration,
        request: { message: cutoffMessage },
        idempotencyKey: cutoffKey,
      });
      store.beginSessionMutationEffect({
        attemptId: cutoffAttempt.id,
        sessionId: cutoffSession.id,
        profileGeneration: profile.processGeneration,
        message: cutoffMessage,
        evidence: {
          kind: "session.send",
          providerThreadId: `thread-atomic-cutoff-${name}`,
          baseline: { providerUpdatedAt: null, status: "idle", activeTurnId: null },
          clientMessageId: cutoffAttempt.id,
          messageDigest: testDigest(cutoffMessage),
          runtimeProfile: runtime,
        },
      });
      const cutoffResult = store.completeSessionTurnEffect({
        attemptId: cutoffAttempt.id,
        sessionId: cutoffSession.id,
        accountId: profile.id,
        providerGeneration: profile.processGeneration,
        providerConnectionId: null,
        expectedSessionRevision: cutoffSession.revision,
        applyResponseState: false,
        turnId: `turn-atomic-cutoff-${name}`,
        turnStatus: "completed",
        runtimeProfile: runtime,
        message: cutoffMessage,
        receipt: { turnId: `turn-atomic-cutoff-${name}` },
      });
      if (cutoffResult.event.body.type !== "user_message") {
        throw new Error("Expected a cutoff user-message event.");
      }
      expect(cutoffResult.event.body.text).toContain("[protected]");
      expect(cutoffResult.event.body.text).not.toContain(secret.slice(0, -1));
      expect(cutoffResult.event.body.omittedCharacters).toBe(
        cutoffMessage.length - SESSION_EVENT_USER_MESSAGE_MAX_CHARACTERS,
      );
    }
  });

  test("reports whether any session is mid-turn as a cloud cadence hint", async () => {
    const { store } = await fixture();
    const profile = signInProfile(store, "Cadence authority", "cadence@example.com");
    expect(store.hasSessionWithActiveTurn()).toBe(false);
    const created = store.createSession({ profileId: profile.id, preset: "high", fastEnabled: false });
    expect(store.hasSessionWithActiveTurn()).toBe(false);
    const bound = store.bindSession({
      sessionId: created.id,
      expectedRevision: created.revision,
      providerThreadId: "thread-cadence",
      state: "active",
      activeTurnId: "turn-cadence",
    });
    expect(store.hasSessionWithActiveTurn()).toBe(true);
    store.reconcileSessionFromProvider({
      sessionId: bound.id,
      state: "idle",
      activeTurnId: null,
    });
    expect(store.hasSessionWithActiveTurn()).toBe(false);
  });

  test("appends ordered bounded session events and reads an atomic snapshot cursor", async () => {
    const { store } = await fixture();
    const profile = signInProfile(store, "Event authority", "events@example.com");
    const created = store.createSession({ profileId: profile.id, preset: "high", fastEnabled: false });
    const session = store.bindSession({
      sessionId: created.id,
      expectedRevision: created.revision,
      providerThreadId: "thread-events",
      state: "active",
      activeTurnId: "turn-events",
    });
    const connectionId = "10000000-0000-4000-8000-000000000001";
    const first = store.appendSessionEvent({
      sessionId: session.id,
      accountId: profile.id,
      providerGeneration: profile.processGeneration,
      providerConnectionId: connectionId,
      body: { type: "turn_started", turnId: "turn-events" },
    });
    const second = store.appendSessionEvent({
      sessionId: session.id,
      accountId: profile.id,
      providerGeneration: profile.processGeneration,
      providerConnectionId: connectionId,
      body: {
        type: "assistant_delta",
        turnId: "turn-events",
        itemId: "item-events",
        text: "Visible progress",
      },
    });
    expect(first).toMatchObject({ sequence: 1, accountId: profile.id, providerGeneration: profile.processGeneration });
    expect(second).toMatchObject({ sequence: 2, streamEpoch: first.streamEpoch });
    expect(store.eventStreamPosition(session.id)).toEqual({
      streamEpoch: first.streamEpoch,
      floorSequence: 1,
      observedThroughSequence: 2,
    });
    expect(store.readSessionSnapshotWithEventPosition(session.id)).toMatchObject({
      session: { id: session.id, state: "active", activeTurnId: "turn-events" },
      streamEpoch: first.streamEpoch,
      floorSequence: 1,
      observedThroughSequence: 2,
    });
    expect(store.listSessionEvents({ sessionId: session.id, afterSequence: 0, limit: 1 })).toMatchObject({
      streamEpoch: first.streamEpoch,
      floorSequence: 1,
      observedThroughSequence: 2,
      gapReason: null,
      events: [{ sequence: 1 }],
    });
    expect(store.listSessionEvents({ sessionId: session.id, afterSequence: 1 })).toMatchObject({
      events: [{ sequence: 2, body: { type: "assistant_delta", text: "Visible progress" } }],
    });
    expect(() => store.listSessionEvents({ sessionId: session.id, afterSequence: 3 })).toThrow("SESSION_EVENT_CURSOR_AHEAD");
    expect(() => store.appendSessionEvent({
      sessionId: session.id,
      accountId: profile.id,
      providerGeneration: profile.processGeneration + 1,
      providerConnectionId: connectionId,
      body: { type: "warning", code: "STALE", message: "must not append" },
    })).toThrow("SESSION_EVENT_AUTHORITY_CHANGED");
    expect(store.eventStreamPosition(session.id).observedThroughSequence).toBe(2);

    const inspector = new Database(store.paths.database, { create: false, strict: true });
    try {
      const stored = inspector.query(
        "SELECT event_bytes,length(CAST(event_json AS BLOB)) AS actual_bytes FROM session_events WHERE session_id=? ORDER BY sequence",
      ).all(session.id);
      expect(stored).toEqual([
        expect.objectContaining({ event_bytes: expect.any(Number), actual_bytes: expect.any(Number) }),
        expect.objectContaining({ event_bytes: expect.any(Number), actual_bytes: expect.any(Number) }),
      ]);
      for (const row of stored as Array<{ event_bytes: number; actual_bytes: number }>) {
        expect(row.event_bytes).toBe(row.actual_bytes);
      }
      expect(() => inspector.query(
        "UPDATE session_events SET event_json='{}' WHERE session_id=? AND sequence=1",
      ).run(session.id)).toThrow("session event is immutable");
    } finally {
      inspector.close(false);
    }
  });

  test("projects legacy private identifiers and MCP summaries on every public read", async () => {
    const { store } = await fixture();
    const profile = signInProfile(store, "Legacy public projection", "legacy-projection@example.com");
    const created = store.createSession({
      profileId: profile.id,
      title: "Legacy public projection",
      preset: "high",
      fastEnabled: false,
    });
    const rawTurnId = `${privateUserPathRoot}/api_key=LEGACY-TURN-SECRET-1234`;
    const session = store.bindSession({
      sessionId: created.id,
      expectedRevision: created.revision,
      providerThreadId: "thread-legacy-public-projection",
      state: "active",
      activeTurnId: rawTurnId,
    });
    const connectionId = "10000000-0000-4000-8000-000000000099";
    const interaction = store.admitInteraction({
      publicId: "10000000-0000-4000-8000-000000000098",
      sessionId: session.id,
      authority: {
        profileId: profile.id,
        processGeneration: profile.processGeneration,
        connectionId,
        requestId: { type: "string", value: "legacy-mcp" },
        method: "mcpServer/elicitation/request",
        requestDigest: "a".repeat(64),
        threadId: "thread-legacy-public-projection",
        turnId: rawTurnId,
        itemId: null,
        approvalId: null,
      },
      kind: "mcp_elicitation",
      blocking: true,
      display: {
        kind: "mcp_elicitation",
        summary: "credential=LEGACY-MCP-SECRET-9415",
        serverName: "example",
        mode: "form",
        url: null,
        mayContainSecrets: true,
        fields: [],
      },
    }).record;
    const turnEvent = store.appendSessionEvent({
      sessionId: session.id,
      accountId: profile.id,
      providerGeneration: profile.processGeneration,
      providerConnectionId: connectionId,
      body: { type: "turn_started", turnId: "turn-safe-before-upgrade" },
    });
    const interactionEvent = store.appendSessionEvent({
      sessionId: session.id,
      accountId: profile.id,
      providerGeneration: profile.processGeneration,
      providerConnectionId: connectionId,
      body: {
        type: "interaction_requested",
        interactionId: interaction.publicId,
        interactionKind: "mcp_elicitation",
        revision: interaction.revision,
        blocking: true,
        summary: "Codex requests MCP form input",
      },
    });

    const inspector = new Database(store.paths.database, { create: false, strict: true });
    try {
      inspector.exec("DROP TRIGGER session_events_immutable_update");
      const replaceBody = (sequence: number, body: unknown): void => {
        const row = z.object({ event_json: z.string() }).strict().parse(
          inspector.query("SELECT event_json FROM session_events WHERE session_id=? AND sequence=?")
            .get(session.id, sequence),
        );
        const event = z.object({ body: z.unknown() }).passthrough()
          .parse(JSON.parse(row.event_json) as unknown);
        const eventJson = JSON.stringify({ ...event, body });
        inspector.query(
          "UPDATE session_events SET event_json=?,event_bytes=length(CAST(? AS BLOB)),projection_version=1 WHERE session_id=? AND sequence=?",
        ).run(eventJson, eventJson, session.id, sequence);
      };
      replaceBody(turnEvent.sequence, { type: "turn_started", turnId: rawTurnId });
      replaceBody(interactionEvent.sequence, {
        type: "interaction_requested",
        interactionId: interaction.publicId,
        interactionKind: "mcp_elicitation",
        revision: interaction.revision,
        blocking: true,
        summary: "credential=LEGACY-EVENT-SECRET-9415",
      });
    } finally {
      inspector.exec(`CREATE TRIGGER session_events_immutable_update
        BEFORE UPDATE ON session_events
        BEGIN SELECT RAISE(ABORT, 'session event is immutable'); END`);
      inspector.close(false);
    }

    const snapshot = store.readSessionObservationSnapshot(session.id);
    expect(snapshot.session.activeTurnId).toBe(
      store.projectPublicProviderIdentifier(rawTurnId),
    );
    expect(snapshot.interactions.pending.some((candidate) =>
      candidate.id === interaction.publicId
      && candidate.summary === "Codex requests MCP form input"
    )).toBe(true);
    expect(store.requireInteraction(interaction.publicId).display.summary)
      .toBe("Codex requests MCP form input");
    const publicEvents = store.listSessionEvents({
      sessionId: session.id,
      afterSequence: 0,
    }).events;
    expect(publicEvents.find((candidate) => candidate.sequence === turnEvent.sequence))
      .toMatchObject({
      sequence: turnEvent.sequence,
      body: {
        type: "turn_started",
        turnId: store.projectPublicProviderIdentifier(rawTurnId),
      },
    });
    expect(publicEvents.find((candidate) => candidate.sequence === interactionEvent.sequence))
      .toMatchObject({
      sequence: interactionEvent.sequence,
      body: {
        type: "interaction_requested",
        summary: "Codex requests MCP form input",
      },
    });
    expect(JSON.stringify({ snapshot, publicEvents })).not.toContain("LEGACY-");
  });

  test("stores an exact 64 KiB public event and reads a maximally expanded legacy row", async () => {
    const home = await realpath(await mkdtemp(join(tmpdir(), "hra-store-event-bound-")));
    const paths = resolveStatePaths({ homeDirectory: home, platform: "darwin" });
    await initializeStatePaths(paths);
    const now = 1_700_000_000_000;
    const store = new StateStore(paths, {
      now: () => now,
      publicProviderIdentifierProjector: publicProviderIdentifier,
    });
    stores.push(store);
    const profile = signInProfile(store, "Event byte bound", "event-bound@example.com");
    const session = store.createSession({
      profileId: profile.id,
      title: "Event byte bound",
      preset: "high",
      fastEnabled: false,
    });
    const stream = store.eventStreamPosition(session.id);
    const turnId = publicProviderIdentifier("t");
    const itemId = publicProviderIdentifier("i");
    const sizedText = (base: unknown, targetBytes: number): string => {
      const baseBytes = utf8Bytes(JSON.stringify(base));
      const remaining = targetBytes - baseBytes;
      if (remaining < 0) throw new Error("Event envelope exceeds its target size.");
      return `${"界".repeat(Math.floor(remaining / 3))}${"x".repeat(remaining % 3)}`;
    };
    const publicBase = {
      version: 1 as const,
      sessionId: session.id,
      streamEpoch: stream.streamEpoch,
      sequence: 1,
      recordedAt: now,
      accountId: profile.id,
      providerGeneration: profile.processGeneration,
      providerConnectionId: null,
      body: { type: "assistant_delta" as const, turnId, itemId, text: "" },
    };
    const publicText = sizedText(publicBase, SESSION_EVENT_MAX_BYTES);
    const appended = store.appendPublicSessionEvent({
      sessionId: session.id,
      accountId: profile.id,
      providerGeneration: profile.processGeneration,
      providerConnectionId: null,
      body: { ...publicBase.body, text: publicText },
    });
    expect(utf8Bytes(JSON.stringify(appended))).toBe(SESSION_EVENT_MAX_BYTES);

    const inspector = new Database(store.paths.database, { create: false, strict: true });
    try {
      const stored = z.object({
        event_bytes: z.number().int(),
        projection_version: z.number().int(),
      }).strict().parse(inspector.query(
        "SELECT event_bytes,projection_version FROM session_events WHERE session_id=? AND sequence=1",
      ).get(session.id));
      expect(stored).toEqual({
        event_bytes: SESSION_EVENT_MAX_BYTES,
        projection_version: 2,
      });
      const legacyBase = {
        ...publicBase,
        body: { ...publicBase.body, turnId: "t", itemId: "i", text: "" },
      };
      const legacyEvent = {
        ...legacyBase,
        body: {
          ...legacyBase.body,
          text: sizedText(legacyBase, SESSION_EVENT_MAX_BYTES),
        },
      };
      expect(utf8Bytes(JSON.stringify(legacyEvent))).toBe(SESSION_EVENT_MAX_BYTES);
      inspector.exec("DROP TRIGGER session_events_immutable_update");
      inspector.query(
        "UPDATE session_events SET event_json=?,event_bytes=?,projection_version=1 WHERE session_id=? AND sequence=1",
      ).run(JSON.stringify(legacyEvent), SESSION_EVENT_MAX_BYTES, session.id);
    } finally {
      inspector.exec(`CREATE TRIGGER session_events_immutable_update
        BEFORE UPDATE ON session_events
        BEGIN SELECT RAISE(ABORT, 'session event is immutable'); END`);
      inspector.close(false);
    }

    const projected = store.listSessionEvents({
      sessionId: session.id,
      afterSequence: 0,
    }).events[0];
    if (projected === undefined) throw new Error("Expected the projected legacy event.");
    expect(projected.body).toMatchObject({
      type: "assistant_delta",
      turnId,
      itemId,
    });
    expect(utf8Bytes(JSON.stringify(projected))).toBe(SESSION_EVENT_PUBLIC_MAX_BYTES);
  });

  test("reads one bounded local session observation with exact interaction and queue semantics", async () => {
    const { store } = await fixture();
    const profile = signInProfile(store, "Observation account", "observation@example.com");
    const created = store.createSession({
      profileId: profile.id,
      title: `Observed api_key=TITLE-SECRET-1234 ${privateUserPathRoot}/work`,
      preset: "high",
      fastEnabled: false,
    });
    const session = store.bindSession({
      sessionId: created.id,
      expectedRevision: created.revision,
      providerThreadId: "thread-observation",
      state: "idle",
    });
    const connectionId = "10100000-0000-4000-8000-000000000001";
    const admit = (input: Readonly<{
      id: string;
      request: string;
      requestedAt: number;
      deadlineAt: number;
      summary: string;
    }>) => store.admitInteraction({
      publicId: input.id,
      sessionId: session.id,
      authority: {
        profileId: profile.id,
        processGeneration: profile.processGeneration,
        connectionId,
        requestId: { type: "string", value: input.request },
        method: "item/commandExecution/requestApproval",
        requestDigest: new Bun.CryptoHasher("sha256").update(input.request).digest("hex"),
        threadId: "thread-observation",
        turnId: "turn-observation",
        itemId: input.request,
        approvalId: null,
      },
      kind: "command_approval",
      blocking: true,
      display: {
        kind: "command_approval",
        summary: input.summary,
        reason: null,
        commandClass: "test",
        workingDirectory: null,
        availableDecisions: ["once", "decline", "cancel"],
      },
      requestedAt: input.requestedAt,
      deadlineAt: input.deadlineAt,
    }).record;
    const later = admit({
      id: "10100000-0000-4000-8000-000000000002",
      request: "later",
      requestedAt: 200,
      deadlineAt: 900,
      summary: `api_key=SUMMARY-SECRET-1234 ${privateUserPathRoot}/summary`,
    });
    const urgent = admit({
      id: "10100000-0000-4000-8000-000000000003",
      request: "urgent",
      requestedAt: 100,
      deadlineAt: 800,
      summary: "u".repeat(700),
    });
    const prepared = admit({
      id: "10100000-0000-4000-8000-000000000004",
      request: "prepared",
      requestedAt: 300,
      deadlineAt: 950,
      summary: "prepared response",
    });
    store.prepareInteractionResponse({
      id: prepared.publicId,
      expectedRevision: prepared.revision,
      responseDigest: "a".repeat(64),
    });

    const pendingQueue = store.enqueue(session.id, "pending secret");
    const dispatchingQueue = store.enqueue(session.id, "dispatching secret");
    expect(store.transitionQueue(dispatchingQueue.id, "pending", "dispatching")).toBe(true);
    const ambiguousQueue = store.enqueue(session.id, "ambiguous secret");
    expect(store.transitionQueue(ambiguousQueue.id, "pending", "dispatching")).toBe(true);
    expect(store.transitionQueue(ambiguousQueue.id, "dispatching", "ambiguous")).toBe(true);
    const failedQueue = store.enqueue(session.id, "failed secret");
    expect(store.transitionQueue(failedQueue.id, "pending", "dispatching")).toBe(true);
    expect(store.transitionQueue(failedQueue.id, "dispatching", "failed")).toBe(true);
    const event = store.appendSessionEvent({
      sessionId: session.id,
      accountId: profile.id,
      providerGeneration: profile.processGeneration,
      providerConnectionId: connectionId,
      body: { type: "session_status", status: "idle", activeTurnId: null },
    });

    const snapshot = store.readSessionObservationSnapshot(session.id, 1);
    expect(sessionLocalObservationSnapshotSchema.parse(snapshot)).toEqual(snapshot);
    expect(snapshot).toMatchObject({
      session: {
        id: session.id,
        accountId: profile.id,
        projectId: null,
        title: "Observed [protected] [local-path]",
        execution: "idle",
        activeTurnId: null,
        revision: session.revision,
      },
      eventStream: {
        streamEpoch: event.streamEpoch,
        floorSequence: 1,
        observedThroughSequence: 1,
      },
      interactions: {
        pendingCount: 2,
        responseInFlightCount: 1,
        truncated: true,
        pending: [{ id: urgent.publicId, summary: "u".repeat(512) }],
      },
      queue: {
        depth: 1,
        dispatchingCount: 1,
        ambiguousCount: 1,
        failedCount: 1,
      },
    });
    expect(snapshot.interactions.pending.some((item) => item.id === prepared.publicId)).toBe(false);
    const completeSnapshot = store.readSessionObservationSnapshot(session.id);
    const encodedCompleteSnapshot = JSON.stringify(completeSnapshot);
    expect(encodedCompleteSnapshot).not.toContain("TITLE-SECRET-1234");
    expect(encodedCompleteSnapshot).not.toContain("SUMMARY-SECRET-1234");
    expect(encodedCompleteSnapshot).not.toContain(privateUserPathRoot);
    expect(completeSnapshot.interactions.pending.some((candidate) =>
      candidate.id === later.publicId
      && candidate.summary === "[protected] [local-path]"
    )).toBe(true);
    expect(store.requireQueue(pendingQueue.id).state).toBe("pending");
    expect(later.state).toBe("pending");
    expect(snapshot.observedAt).toBeGreaterThanOrEqual(session.updatedAt);
    expect(() => store.readSessionObservationSnapshot(session.id, 0)).toThrow();
    expect(() => store.readSessionObservationSnapshot(session.id, 11)).toThrow();

    const expansion = store.createSession({
      profileId: profile.id,
      title: "/a ".repeat(106).trim(),
      preset: "high",
      fastEnabled: false,
    });
    const expandedSnapshot = store.readSessionObservationSnapshot(expansion.id);
    expect(utf8Bytes(expandedSnapshot.session.title)).toBeLessThanOrEqual(320);
    expect(expandedSnapshot.session.title).toEndWith("[truncated]");
    expect(expandedSnapshot.session.title).not.toContain("/a");

    const privateTurnId = `${privateUserPathRoot}/api_key=TURN-SECRET-1234`;
    const privateTurnCreated = store.createSession({
      profileId: profile.id,
      title: "Private provider identifier",
      preset: "high",
      fastEnabled: false,
    });
    const privateTurnSession = store.bindSession({
      sessionId: privateTurnCreated.id,
      expectedRevision: privateTurnCreated.revision,
      providerThreadId: "thread-private-provider-id",
      state: "active",
      activeTurnId: privateTurnId,
    });
    const privateTurnSnapshot = store.readSessionObservationSnapshot(privateTurnSession.id);
    expect(privateTurnSnapshot.session.activeTurnId)
      .toBe(store.projectPublicProviderIdentifier(privateTurnId));
    expect(privateTurnSnapshot.session.activeTurnId)
      .toMatch(/^opaque_v2_[a-f0-9]{64}$/u);
    expect(JSON.stringify(privateTurnSnapshot)).not.toContain("TURN-SECRET-1234");
    expect(store.requireSession(privateTurnSession.id).activeTurnId).toBe(privateTurnId);

    const longTurnId = "l".repeat(201);
    const longTurnCreated = store.createSession({
      profileId: profile.id,
      title: "Long provider identifier",
      preset: "high",
      fastEnabled: false,
    });
    const longTurnSession = store.bindSession({
      sessionId: longTurnCreated.id,
      expectedRevision: longTurnCreated.revision,
      providerThreadId: "thread-long-provider-id",
      state: "active",
      activeTurnId: longTurnId,
    });
    expect(store.readSessionObservationSnapshot(longTurnSession.id).session.activeTurnId)
      .toBe(store.projectPublicProviderIdentifier(longTurnId));
    expect(store.requireSession(longTurnSession.id).activeTurnId).toBe(longTurnId);
  });

  test("establishes each SQLite observation cut before assigning its observed time", async () => {
    const { store } = await fixture();
    const profile = store.createProfile("Snapshot boundary");
    const session = store.createSession({
      profileId: profile.id,
      title: "Snapshot boundary",
      preset: "high",
      fastEnabled: false,
    });
    let sessionWriterRan = false;
    const sessionObserver = new StateStore(store.paths, {
      readonly: true,
      now: () => {
        if (sessionWriterRan) throw new Error("Session observation clock was read more than once.");
        sessionWriterRan = true;
        store.setSessionTurnState({
          sessionId: session.id,
          expectedRevision: session.revision,
          state: "idle",
        });
        return 10_000;
      },
    });
    stores.push(sessionObserver);

    const sessionSnapshot = sessionObserver.readSessionObservationSnapshot(session.id);
    expect(sessionWriterRan).toBe(true);
    expect(sessionSnapshot.observedAt).toBe(10_000);
    expect(sessionSnapshot.session).toMatchObject({
      execution: "starting",
      revision: session.revision,
    });
    expect(store.requireSession(session.id)).toMatchObject({
      state: "idle",
      revision: session.revision + 1,
    });

    const accountCountBeforeRootCut = store.listProfiles().length;
    let rootWriterRan = false;
    const rootObserver = new StateStore(store.paths, {
      readonly: true,
      now: () => {
        if (rootWriterRan) throw new Error("Root observation clock was read more than once.");
        rootWriterRan = true;
        store.createProfile("Committed after root cut");
        return 20_000;
      },
    });
    stores.push(rootObserver);

    const rootSnapshot = rootObserver.readRootStatusSnapshot();
    expect(rootWriterRan).toBe(true);
    expect(rootSnapshot.localObservation.observedAt).toBe(20_000);
    expect(
      rootSnapshot.counts.accounts.signedOut
      + rootSnapshot.counts.accounts.loginPending
      + rootSnapshot.counts.accounts.signedIn
      + rootSnapshot.counts.accounts.recoveryRequired,
    ).toBe(accountCountBeforeRootCut);
    expect(store.listProfiles()).toHaveLength(accountCountBeforeRootCut + 1);
  });

  test("reads latest nonremoved account usage outcomes without leaking private root data", async () => {
    const { store } = await fixture();
    const observed = signInProfile(store, "Observed private label", "observed-private@example.com");
    const failed = signInProfile(store, "Failed private label", "failed-private@example.com");
    const missing = store.createProfile("Missing private label");
    const removed = signInProfile(store, "Removed private label", "removed-private@example.com");
    store.recordUsage(observed.id, 1, 100, { sentinel: "old-observed-payload" });
    store.recordUsagePollFailure(
      observed.id,
      resetAccountFingerprint("observed-private@example.com"),
      2,
      200,
    );
    store.recordUsage(observed.id, 3, 300, { sentinel: "latest-observed-payload" });
    store.recordUsage(failed.id, 1, 100, { sentinel: "old-failed-payload" });
    store.recordUsagePollFailure(
      failed.id,
      resetAccountFingerprint("failed-private@example.com"),
      2,
      200,
    );
    store.recordUsage(removed.id, 1, 100, { sentinel: "removed-account-payload" });
    store.removeProfile(removed.id);

    const session = store.createSession({
      profileId: observed.id,
      title: "private session title",
      preset: "high",
      fastEnabled: false,
    });
    store.updateSessionMetadata({
      sessionId: session.id,
      expectedRevision: session.revision,
      note: "private session note",
    });
    store.admitInteraction({
      publicId: "10200000-0000-4000-8000-000000000001",
      sessionId: session.id,
      authority: {
        profileId: observed.id,
        processGeneration: observed.processGeneration,
        connectionId: "10200000-0000-4000-8000-000000000002",
        requestId: { type: "string", value: "private-interaction" },
        method: "item/commandExecution/requestApproval",
        requestDigest: "b".repeat(64),
        threadId: "private-thread",
        turnId: "private-turn",
        itemId: "private-item",
        approvalId: null,
      },
      kind: "command_approval",
      blocking: true,
      display: {
        kind: "command_approval",
        summary: "private interaction summary",
        reason: "private interaction reason",
        commandClass: "private command class",
        workingDirectory: "/private/root",
        availableDecisions: ["once", "decline"],
      },
    });
    store.enqueue(session.id, "private queued message");

    const status = store.readRootStatusSnapshot();
    expect(status.counts).toMatchObject({
      accounts: { signedOut: 1, loginPending: 0, signedIn: 2, recoveryRequired: 0 },
      sessions: { starting: 1 },
      interactions: { pending: 1 },
      queue: { pending: 1 },
      usage: { observed: 1, failed: 1, missing: 1 },
    });
    expect(status.attention).toMatchObject({
      total: 1,
      truncated: false,
      records: [{
        kind: "interaction_pending",
        accountId: observed.id,
        sessionId: session.id,
      }],
    });
    expect(status.providerObservation.coverage).toBe("not_attempted");
    expect(status.cloudObservation.devices).toEqual({ registered: null, online: null });
    const encoded = JSON.stringify(status);
    for (const forbidden of [
      z.string().parse(observed.providerEmail),
      z.string().parse(failed.providerEmail),
      z.string().parse(removed.providerEmail),
      "Observed private label",
      "Failed private label",
      "Missing private label",
      "Removed private label",
      "private session title",
      "private session note",
      "private interaction summary",
      "private interaction reason",
      "private command class",
      "/private/root",
      "private queued message",
      "old-observed-payload",
      "latest-observed-payload",
      "old-failed-payload",
      "removed-account-payload",
    ]) {
      expect(encoded).not.toContain(forbidden);
    }
    expect(status.attention.records[0]?.intent).toEqual({
      kind: "inspect_interaction",
      interactionId: "10200000-0000-4000-8000-000000000001",
      expectedRevision: 1,
    });
    expect(missing.state).toBe("signed_out");
    expect(new TextEncoder().encode(encoded).byteLength).toBeLessThanOrEqual(ROOT_STATUS_MAXIMUM_BYTES);
  });

  test("emits executable root attention intents for every interaction kind and in-flight state", async () => {
    const { store } = await fixture();
    const profile = signInProfile(store, "Actionable attention", "attention@example.com");
    const session = store.createSession({
      profileId: profile.id,
      title: "Actionable attention",
      preset: "high",
      fastEnabled: false,
    });
    const cases = [
      {
        kind: "command_approval",
        method: "item/commandExecution/requestApproval",
        display: {
          kind: "command_approval",
          summary: "Approve command",
          reason: null,
          commandClass: "test",
          workingDirectory: null,
          availableDecisions: ["once", "decline", "cancel"],
        },
      },
      {
        kind: "file_change_approval",
        method: "item/fileChange/requestApproval",
        display: {
          kind: "file_change_approval",
          summary: "Approve files",
          reason: null,
          grantRoot: null,
          availableDecisions: ["once", "decline", "cancel"],
        },
      },
      {
        kind: "permission_approval",
        method: "item/permissions/requestApproval",
        display: {
          kind: "permission_approval",
          summary: "Approve permission",
          reason: null,
          requested: [{ name: "network" }],
          allowsSessionScope: true,
        },
      },
      {
        kind: "user_input",
        method: "item/tool/requestUserInput",
        display: {
          kind: "user_input",
          summary: "Answer question",
          blocking: true,
          questions: [{
            id: "answer",
            header: "Answer",
            question: "Continue?",
            options: null,
            allowsOther: true,
            secret: false,
          }],
        },
      },
      {
        kind: "mcp_elicitation",
        method: "mcpServer/elicitation/request",
        display: {
          kind: "mcp_elicitation",
          summary: "Codex requests MCP form input",
          serverName: "example",
          mode: "form",
          url: null,
          mayContainSecrets: true,
          fields: [],
        },
      },
    ] satisfies readonly Readonly<{
      kind: InteractionKind;
      method: string;
      display: InteractionDisplay;
    }>[];
    const admit = (candidate: (typeof cases)[number], index: number) =>
      store.admitInteraction({
        publicId: `10300000-0000-4000-8000-${index.toString().padStart(12, "0")}`,
        sessionId: session.id,
        authority: {
          profileId: profile.id,
          processGeneration: profile.processGeneration,
          connectionId: "10300000-0000-4000-8000-000000000099",
          requestId: { type: "string", value: `attention-${String(index)}` },
          method: candidate.method,
          requestDigest: index.toString(16).padStart(64, "0"),
          threadId: "thread-actionable-attention",
          turnId: "turn-actionable-attention",
          itemId: `item-${String(index)}`,
          approvalId: null,
        },
        kind: candidate.kind,
        blocking: true,
        display: candidate.display,
      }).record;
    const pending = cases.map((candidate, index) => admit(candidate, index + 1));
    const preparedSeed = admit(cases[0]!, 6);
    const prepared = store.prepareInteractionResponse({
      id: preparedSeed.publicId,
      expectedRevision: preparedSeed.revision,
      responseDigest: "b".repeat(64),
    });
    const writtenSeed = admit(cases[0]!, 7);
    const writtenPrepared = store.prepareInteractionResponse({
      id: writtenSeed.publicId,
      expectedRevision: writtenSeed.revision,
      responseDigest: "c".repeat(64),
    });
    const written = store.markInteractionResponseWritten({
      id: writtenPrepared.publicId,
      expectedRevision: writtenPrepared.revision,
      responseDigest: "c".repeat(64),
    });

    const status = store.readRootStatusSnapshot();
    expect(status.attention.total).toBe(7);
    const byId = new Map(status.attention.records.flatMap((record) =>
      "interactionId" in record ? [[record.interactionId, record] as const] : []));
    for (const record of pending) {
      const attention = byId.get(record.publicId);
      if (record.kind === "command_approval" || record.kind === "permission_approval") {
        expect(attention?.intent).toEqual({
          kind: "inspect_interaction",
          interactionId: record.publicId,
          expectedRevision: record.revision,
        });
      } else {
        expect(attention?.intent).toEqual({
          kind: "show_interaction",
          interactionId: record.publicId,
        });
      }
    }
    for (const record of [prepared, written]) {
      expect(byId.get(record.publicId)?.intent).toEqual({
        kind: "show_interaction",
        interactionId: record.publicId,
      });
    }
  });

  test("caps deterministic root attention with truthful truncation under the byte bound", async () => {
    const { store } = await fixture();
    const accountIds: string[] = [];
    for (let index = 0; index < ROOT_STATUS_ATTENTION_LIMIT + 5; index += 1) {
      const account = store.createProfile(`Recovery ${String(index).padStart(2, "0")}`);
      expect(store.setProfileState(
        account.id,
        account.processGeneration,
        "recovery_required",
      )).toBe(true);
      accountIds.push(account.id);
    }

    const status = store.readRootStatusSnapshot();
    expect(status.attention.records).toHaveLength(ROOT_STATUS_ATTENTION_LIMIT);
    expect(status.attention.total).toBe(ROOT_STATUS_ATTENTION_LIMIT + 5);
    expect(status.attention.truncated).toBe(true);
    expect(status.attention.records.map((record) => record.accountId))
      .toEqual(accountIds.slice(0, ROOT_STATUS_ATTENTION_LIMIT));
    expect(new TextEncoder().encode(JSON.stringify(status)).byteLength)
      .toBeLessThanOrEqual(ROOT_STATUS_MAXIMUM_BYTES);
    expect(() => store.readRootStatusSnapshot(0)).toThrow();
    expect(() => store.readRootStatusSnapshot(ROOT_STATUS_ATTENTION_LIMIT + 1)).toThrow();
  });

  test("atomically retires one provider generation before an account login advances it", async () => {
    const { store } = await fixture();
    const profile = signInProfile(store, "Login retirement", "login-retirement@example.com");
    const created = store.createSession({
      profileId: profile.id,
      preset: "high",
      fastEnabled: false,
    });
    const session = store.bindSession({
      sessionId: created.id,
      expectedRevision: created.revision,
      providerThreadId: "thread-login-retirement",
      state: "idle",
    });
    const connectionId = "11000000-0000-4000-8000-000000000001";
    store.appendSessionEvent({
      sessionId: session.id,
      accountId: profile.id,
      providerGeneration: profile.processGeneration,
      providerConnectionId: connectionId,
      body: { type: "connection", state: "connected" },
    });
    const interaction = store.admitInteraction({
      publicId: "11000000-0000-4000-8000-000000000002",
      sessionId: session.id,
      authority: {
        profileId: profile.id,
        processGeneration: profile.processGeneration,
        connectionId,
        requestId: { type: "string", value: "login-retirement" },
        method: "item/commandExecution/requestApproval",
        requestDigest: "1".repeat(64),
        threadId: "thread-login-retirement",
        turnId: "turn-login-retirement",
        itemId: "item-login-retirement",
        approvalId: null,
      },
      kind: "command_approval",
      blocking: true,
      display: {
        kind: "command_approval",
        summary: "Retire this prompt",
        reason: null,
        commandClass: "test",
        workingDirectory: null,
        availableDecisions: ["once", "decline", "cancel"],
      },
    }).record;
    const attempt = store.prepareMutation({
      kind: "account.login",
      authorityId: profile.id,
      authorityGeneration: profile.processGeneration + 1,
      request: { deviceCode: false },
      idempotencyKey: "00000000-0000-4000-8000-000000000811",
    });

    const begun = store.beginAccountMutationEffect({
      attemptId: attempt.id,
      profileId: profile.id,
      profileGeneration: profile.processGeneration + 1,
      evidence: { kind: "account.login", method: "browser" },
      providerRetirements: [{
        sessionId: session.id,
        connectionId,
        releasedEvents: [{
          accountId: profile.id,
          sessionId: session.id,
          providerGeneration: profile.processGeneration,
          providerConnectionId: connectionId,
          body: {
            type: "assistant_delta",
            turnId: publicProviderIdentifier("turn-login-retirement"),
            itemId: publicProviderIdentifier("item-login-retirement"),
            text: "[protected]",
          },
        }, {
          accountId: profile.id,
          sessionId: session.id,
          providerGeneration: profile.processGeneration,
          providerConnectionId: null,
          body: {
            type: "warning",
            code: "provider_resume_unavailable",
            message: "Provider observation is unavailable.",
          },
        }],
      }],
    });

    expect(begun).toMatchObject({
      profile: { processGeneration: profile.processGeneration + 1, state: "login_pending" },
      retiredSessionIds: [session.id],
    });
    expect(store.requireInteraction(interaction.publicId)).toMatchObject({
      revision: interaction.revision + 1,
      state: "expired",
    });
    expect(store.readMutation("00000000-0000-4000-8000-000000000811"))
      .toMatchObject({ state: "effect_started" });
    const events = store.listSessionEvents({
      sessionId: session.id,
      afterSequence: 0,
      limit: 100,
    }).events;
    expect(events.map((event) => event.body)).toEqual([
      { type: "connection", state: "connected" },
      {
        type: "assistant_delta",
        turnId: publicProviderIdentifier("turn-login-retirement"),
        itemId: publicProviderIdentifier("item-login-retirement"),
        text: "[protected]",
      },
      {
        type: "warning",
        code: "provider_resume_unavailable",
        message: "Provider observation is unavailable.",
      },
      {
        type: "interaction_state",
        interactionId: interaction.publicId,
        state: "expired",
        revision: interaction.revision + 1,
      },
      { type: "connection", state: "disconnected", reason: "closed" },
      {
        type: "gap",
        reason: "provider_disconnect",
        fromSequence: 6,
        throughSequence: 6,
      },
    ]);
    expect(events.map((event) => event.providerGeneration))
      .toEqual(events.map(() => profile.processGeneration));
    expect(events.map((event) => event.sequence)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  test("rolls an invalid account-login retirement back and permits an exact retry", async () => {
    const { store } = await fixture();
    const profile = signInProfile(store, "Rollback retirement", "rollback-retirement@example.com");
    const other = signInProfile(store, "Other retirement", "other-retirement@example.com");
    const session = store.createSession({
      profileId: profile.id,
      preset: "high",
      fastEnabled: false,
    });
    const otherSession = store.createSession({
      profileId: other.id,
      preset: "high",
      fastEnabled: false,
    });
    const connectionId = "12000000-0000-4000-8000-000000000001";
    const interaction = store.admitInteraction({
      publicId: "12000000-0000-4000-8000-000000000002",
      sessionId: session.id,
      authority: {
        profileId: profile.id,
        processGeneration: profile.processGeneration,
        connectionId,
        requestId: { type: "number", value: 1 },
        method: "item/commandExecution/requestApproval",
        requestDigest: "2".repeat(64),
        threadId: "thread-rollback-retirement",
        turnId: "turn-rollback-retirement",
        itemId: "item-rollback-retirement",
        approvalId: null,
      },
      kind: "command_approval",
      blocking: true,
      display: {
        kind: "command_approval",
        summary: "Keep pending after rollback",
        reason: null,
        commandClass: "test",
        workingDirectory: null,
        availableDecisions: ["once", "decline", "cancel"],
      },
    }).record;
    const key = "00000000-0000-4000-8000-000000000812";
    const attempt = store.prepareMutation({
      kind: "account.login",
      authorityId: profile.id,
      authorityGeneration: profile.processGeneration + 1,
      request: { deviceCode: false },
      idempotencyKey: key,
    });
    const begin = (providerRetirements: Parameters<StateStore["beginAccountMutationEffect"]>[0]["providerRetirements"]) =>
      store.beginAccountMutationEffect({
        attemptId: attempt.id,
        profileId: profile.id,
        profileGeneration: profile.processGeneration + 1,
        evidence: { kind: "account.login", method: "browser" },
        ...(providerRetirements === undefined ? {} : { providerRetirements }),
      });
    const assertUnchanged = (): void => {
      expect(store.requireProfileById(profile.id)).toMatchObject({
        processGeneration: profile.processGeneration,
        state: "signed_in",
      });
      expect(store.requireInteraction(interaction.publicId)).toMatchObject({
        revision: interaction.revision,
        state: "pending",
      });
      expect(store.readMutation(key)).toMatchObject({ state: "prepared" });
      expect(store.eventStreamPosition(session.id).observedThroughSequence).toBe(0);
    };

    expect(() => begin([{
      sessionId: session.id,
      connectionId,
      releasedEvents: [{
        accountId: profile.id,
        sessionId: session.id,
        providerGeneration: profile.processGeneration,
        providerConnectionId: null,
        body: {
          type: "assistant_delta",
          turnId: publicProviderIdentifier("turn-rollback-retirement"),
          itemId: publicProviderIdentifier("item-rollback-retirement"),
          text: "[protected]",
        },
      }],
    }])).toThrow("ACCOUNT_LOGIN_RETIREMENT_EVENT_AUTHORITY_MISMATCH");
    assertUnchanged();
    expect(() => begin([{
      sessionId: session.id,
      connectionId,
      releasedEvents: [{
        accountId: profile.id,
        sessionId: session.id,
        providerGeneration: profile.processGeneration,
        providerConnectionId: connectionId,
        body: {
          type: "gap",
          reason: "provider_disconnect",
          fromSequence: 1,
          throughSequence: 1,
        },
      }],
    }])).toThrow("ACCOUNT_LOGIN_RETIREMENT_EVENT_AUTHORITY_MISMATCH");
    assertUnchanged();
    expect(() => begin([{
      sessionId: otherSession.id,
      connectionId,
      releasedEvents: [],
    }])).toThrow("ACCOUNT_LOGIN_RETIREMENT_SESSION_AUTHORITY_MISMATCH");
    assertUnchanged();

    expect(begin([{
      sessionId: session.id,
      connectionId,
      releasedEvents: [],
    }])).toMatchObject({
      profile: { processGeneration: profile.processGeneration + 1 },
      retiredSessionIds: [session.id],
    });
    expect(store.requireInteraction(interaction.publicId).state).toBe("expired");
  });

  test("evicts a deterministic contiguous event prefix by age and reports the exact floor gap", async () => {
    const home = await realpath(await mkdtemp(join(tmpdir(), "hra-store-event-retention-")));
    const paths = resolveStatePaths({ homeDirectory: home, platform: "darwin" });
    await initializeStatePaths(paths);
    let currentTime = 1_000;
    const store = new StateStore(paths, { now: () => currentTime });
    stores.push(store);
    const profile = signInProfile(store, "Retention", "retention@example.com");
    const session = store.createSession({ profileId: profile.id, preset: "high", fastEnabled: false });
    const append = (message: string) => store.appendSessionEvent({
      sessionId: session.id,
      accountId: profile.id,
      providerGeneration: profile.processGeneration,
      providerConnectionId: null,
      body: { type: "warning", code: "RETENTION", message },
    });
    const first = append("first");
    currentTime = 1_001;
    append("second");
    currentTime = 1_002 + SESSION_EVENT_RETAIN_AGE_MS;
    const third = append("third");

    expect(third).toMatchObject({ sequence: 3, streamEpoch: first.streamEpoch });
    expect(store.eventStreamPosition(session.id)).toEqual({
      streamEpoch: first.streamEpoch,
      floorSequence: 3,
      observedThroughSequence: 3,
    });
    expect(store.listSessionEvents({ sessionId: session.id, afterSequence: 0 })).toMatchObject({
      gapReason: "retention_age",
      floorSequence: 3,
      observedThroughSequence: 3,
      events: [{ sequence: 3 }],
    });
    expect(store.listSessionEvents({ sessionId: session.id, afterSequence: null })).toMatchObject({
      gapReason: null,
      events: [{ sequence: 3 }],
    });
  });

  test("maintains the age bound while reading an idle stream with no new append", async () => {
    const home = await realpath(await mkdtemp(join(tmpdir(), "hra-store-event-read-retention-")));
    const paths = resolveStatePaths({ homeDirectory: home, platform: "darwin" });
    await initializeStatePaths(paths);
    let currentTime = 1_000;
    const store = new StateStore(paths, { now: () => currentTime });
    stores.push(store);
    const profile = signInProfile(store, "Idle retention", "idle-retention@example.com");
    const session = store.createSession({
      profileId: profile.id,
      preset: "high",
      fastEnabled: false,
    });
    const event = store.appendSessionEvent({
      sessionId: session.id,
      accountId: profile.id,
      providerGeneration: profile.processGeneration,
      providerConnectionId: null,
      body: { type: "warning", code: "RETENTION", message: "age without append" },
    });

    currentTime += SESSION_EVENT_RETAIN_AGE_MS + 1;

    expect(store.listSessionEvents({
      sessionId: session.id,
      afterSequence: 0,
    })).toMatchObject({
      gapReason: "retention_age",
      floorSequence: event.sequence + 1,
      observedThroughSequence: event.sequence,
      events: [],
    });
  });

  test("caps event pages by encoded bytes without splitting or reordering events", async () => {
    const { store } = await fixture();
    const profile = signInProfile(store, "Page bytes", "page-bytes@example.com");
    const session = store.createSession({ profileId: profile.id, preset: "high", fastEnabled: false });
    for (let index = 0; index < 18; index += 1) {
      store.appendSessionEvent({
        sessionId: session.id,
        accountId: profile.id,
        providerGeneration: profile.processGeneration,
        providerConnectionId: null,
        body: {
          type: "assistant_delta",
          turnId: "turn-page",
          itemId: `item-${index}`,
          text: "x".repeat(32_768),
        },
      });
    }
    const page = store.listSessionEvents({ sessionId: session.id, afterSequence: 0, limit: 18 });
    expect(page.events.length).toBeGreaterThan(1);
    expect(page.events.length).toBeLessThan(18);
    expect(page.events.map((event) => event.sequence)).toEqual(
      Array.from({ length: page.events.length }, (_, index) => index + 1),
    );
  });

  test("brokers tagged provider requests with exact replay and write-ahead CAS states", async () => {
    const { store } = await fixture();
    const profile = signInProfile(store, "Interactions", "interactions@example.com");
    const session = store.createSession({ profileId: profile.id, preset: "high", fastEnabled: false });
    const connectionId = "20000000-0000-4000-8000-000000000001";
    const authority = {
      profileId: profile.id,
      processGeneration: profile.processGeneration,
      connectionId,
      requestId: { type: "number" as const, value: 1 },
      method: "item/commandExecution/requestApproval",
      requestDigest: "a".repeat(64),
      threadId: "thread-interaction",
      turnId: "turn-interaction",
      itemId: "item-interaction",
      approvalId: "approval-interaction",
    };
    const display = {
      kind: "command_approval" as const,
      summary: "Run the bounded check",
      reason: null,
      commandClass: "test",
      workingDirectory: null,
      availableDecisions: ["once" as const, "session" as const, "decline" as const, "cancel" as const],
    };
    const admitted = store.admitInteraction({
      publicId: "20000000-0000-4000-8000-000000000002",
      sessionId: session.id,
      authority,
      kind: "command_approval",
      blocking: true,
      display,
    });
    expect(admitted).toMatchObject({ replayed: false, record: { state: "pending", revision: 1 } });
    expect(store.admitInteraction({
      publicId: "20000000-0000-4000-8000-000000000003",
      sessionId: session.id,
      authority,
      kind: "command_approval",
      blocking: true,
      display,
    })).toMatchObject({ replayed: true, record: { publicId: admitted.record.publicId, revision: 1 } });
    expect(() => store.admitInteraction({
      publicId: "20000000-0000-4000-8000-000000000004",
      sessionId: session.id,
      authority: { ...authority, requestDigest: "b".repeat(64) },
      kind: "command_approval",
      blocking: true,
      display,
    })).toThrow("INTERACTION_REQUEST_REPLAY_CONFLICT");

    const stringRequest = store.admitInteraction({
      publicId: "20000000-0000-4000-8000-000000000005",
      sessionId: session.id,
      authority: {
        ...authority,
        requestId: { type: "string", value: "1" },
        requestDigest: "c".repeat(64),
      },
      kind: "command_approval",
      blocking: true,
      display,
    });
    expect(stringRequest.record.publicId).not.toBe(admitted.record.publicId);

    const responseDigest = "d".repeat(64);
    const prepared = store.prepareInteractionResponse({
      id: admitted.record.publicId,
      expectedRevision: 1,
      responseDigest,
    });
    expect(prepared).toMatchObject({ state: "response_prepared", revision: 2, responseDigest });
    expect(store.prepareInteractionResponse({
      id: admitted.record.publicId,
      expectedRevision: 1,
      responseDigest,
    })).toEqual(prepared);
    expect(() => store.prepareInteractionResponse({
      id: admitted.record.publicId,
      expectedRevision: 1,
      responseDigest: "e".repeat(64),
    })).toThrow("INTERACTION_RESPONSE_CONFLICT");
    const written = store.markInteractionResponseWritten({
      id: admitted.record.publicId,
      expectedRevision: prepared.revision,
      responseDigest,
    });
    expect(written).toMatchObject({ state: "response_written", revision: 3 });
    expect(store.markInteractionResponseWritten({
      id: admitted.record.publicId,
      expectedRevision: prepared.revision,
      responseDigest,
    })).toEqual(written);
    expect(() => store.settleInteraction({
      id: admitted.record.publicId,
      expectedRevision: written.revision,
      state: "resolved",
      authority: { ...authority, connectionId: "20000000-0000-4000-8000-000000000099" },
      responseDigest,
    })).toThrow("INTERACTION_AUTHORITY_MISMATCH");
    const settled = store.settleInteraction({
      id: admitted.record.publicId,
      expectedRevision: written.revision,
      state: "resolved",
      authority,
      responseDigest,
    });
    expect(settled).toMatchObject({ state: "resolved", revision: 4, responseDigest });
    expect(store.settleInteraction({
      id: admitted.record.publicId,
      expectedRevision: written.revision,
      state: "resolved",
      authority,
      responseDigest,
    })).toEqual(settled);
    expect(store.listInteractions({ sessionId: session.id, pendingOnly: true })).toEqual([
      expect.objectContaining({ publicId: stringRequest.record.publicId, state: "pending" }),
    ]);

    const inspector = new Database(store.paths.database, { readonly: true, strict: true });
    try {
      const columns = inspector.query("PRAGMA table_info(provider_interactions)").all() as Array<{ name: string }>;
      expect(columns.map((column) => column.name)).not.toContain("resolution_json");
      expect(inspector.query(
        "SELECT response_digest,display_json FROM provider_interactions WHERE public_id=?",
      ).get(admitted.record.publicId)).toEqual({ response_digest: responseDigest, display_json: JSON.stringify(display) });
      expect(inspector.query(
        "SELECT revision,state FROM provider_interaction_transitions WHERE public_id=? ORDER BY revision",
      ).all(admitted.record.publicId)).toEqual([
        { revision: 1, state: "pending" },
        { revision: 2, state: "response_prepared" },
        { revision: 3, state: "response_written" },
        { revision: 4, state: "resolved" },
      ]);
    } finally {
      inspector.close(false);
    }
  });

  test("paginates tied interactions exactly once in descending-time ascending-id order", async () => {
    const home = await realpath(await mkdtemp(join(tmpdir(), "hra-store-interaction-page-")));
    const paths = resolveStatePaths({ homeDirectory: home, platform: "darwin" });
    await initializeStatePaths(paths);
    const store = new StateStore(paths, { now: () => 20_000 });
    stores.push(store);
    const profile = signInProfile(store, "Interaction pages", "interaction-pages@example.com");
    const session = store.createSession({ profileId: profile.id, preset: "high", fastEnabled: false });
    const display = {
      kind: "command_approval" as const,
      summary: "Resolve the paged interaction",
      reason: null,
      commandClass: "test",
      workingDirectory: null,
      availableDecisions: ["once" as const, "decline" as const, "cancel" as const],
    };
    const publicIds: string[] = [];
    for (let index = 0; index < 105; index += 1) {
      const suffix = String(index).padStart(12, "0");
      const publicId = `23000000-0000-4000-8000-${suffix}`;
      publicIds.push(publicId);
      store.admitInteraction({
        publicId,
        sessionId: session.id,
        authority: {
          profileId: profile.id,
          processGeneration: profile.processGeneration,
          connectionId: "23000000-0000-4000-8000-999999999999",
          requestId: { type: "number", value: index },
          method: "item/commandExecution/requestApproval",
          requestDigest: index.toString(16).padStart(64, "0"),
          threadId: "thread-interaction-page",
          turnId: `turn-${String(index)}`,
          itemId: `item-${String(index)}`,
          approvalId: null,
        },
        kind: "command_approval",
        blocking: true,
        display,
        requestedAt: 10_000,
        deadlineAt: 30_000,
      });
    }

    const first = store.listInteractionPage({
      sessionId: session.id,
      pendingOnly: true,
      limit: 100,
    });
    expect(first.interactions.map((interaction) => interaction.publicId)).toEqual(publicIds.slice(0, 100));
    const firstPageLastId = publicIds[99];
    if (firstPageLastId === undefined) throw new Error("Expected the first interaction page to be full.");
    expect(first.nextPosition).toEqual({ requestedAt: 10_000, publicId: firstPageLastId });
    if (first.nextPosition === null) throw new Error("Expected an interaction continuation.");
    const second = store.listInteractionPage({
      sessionId: session.id,
      pendingOnly: true,
      limit: 100,
      after: first.nextPosition,
    });
    expect(second.interactions.map((interaction) => interaction.publicId)).toEqual(publicIds.slice(100));
    expect(second.nextPosition).toBeNull();
    expect(new Set([...first.interactions, ...second.interactions].map((interaction) => interaction.publicId)).size)
      .toBe(105);
  });

  test("reads only linked, pending, unexpired attention in deterministic deadline order", async () => {
    const home = await realpath(await mkdtemp(join(tmpdir(), "hra-store-attention-snapshot-")));
    const paths = resolveStatePaths({ homeDirectory: home, platform: "darwin" });
    await initializeStatePaths(paths);
    const now = 50_000;
    const store = new StateStore(paths, { now: () => now });
    stores.push(store);
    const profile = signInProfile(store, "Attention snapshot", "attention-snapshot@example.com");
    const session = store.createSession({ profileId: profile.id, preset: "high", fastEnabled: false });
    const connectionId = "24000000-0000-4000-8000-999999999999";
    const display = {
      kind: "command_approval" as const,
      summary: "Review the bounded interaction",
      reason: null,
      commandClass: "test",
      workingDirectory: null,
      availableDecisions: ["decline" as const],
    };
    const admit = (input: Readonly<{
      deadlineAt: number;
      index: number;
      requestedAt: number;
    }>) => store.admitInteraction({
      publicId: `24000000-0000-4000-8000-${String(input.index).padStart(12, "0")}`,
      sessionId: session.id,
      authority: {
        profileId: profile.id,
        processGeneration: profile.processGeneration,
        connectionId,
        requestId: { type: "number" as const, value: input.index },
        method: "item/commandExecution/requestApproval",
        requestDigest: input.index.toString(16).padStart(64, "0"),
        threadId: "thread-attention-snapshot",
        turnId: `turn-${String(input.index)}`,
        itemId: `item-${String(input.index)}`,
        approvalId: null,
      },
      kind: "command_approval",
      blocking: true,
      display,
      requestedAt: input.requestedAt,
      deadlineAt: input.deadlineAt,
    }).record;

    expect(store.readAttentionNotificationSnapshot({
      limit: ATTENTION_NOTIFICATION_SNAPSHOT_LIMIT,
      now,
    })).toEqual({ interactions: [], observedAt: now, status: "complete" });

    const later = admit({ deadlineAt: now + 500, index: 1, requestedAt: now - 100 });
    const tiedFirst = admit({ deadlineAt: now + 100, index: 2, requestedAt: now - 300 });
    const tiedSecond = admit({ deadlineAt: now + 100, index: 3, requestedAt: now - 300 });
    admit({ deadlineAt: now, index: 4, requestedAt: now - 400 });
    const preparedBase = admit({ deadlineAt: now + 50, index: 5, requestedAt: now - 500 });
    const writtenBase = admit({ deadlineAt: now + 25, index: 6, requestedAt: now - 600 });
    const boundaryFuture = admit({ deadlineAt: now + 1, index: 7, requestedAt: now - 700 });
    store.prepareInteractionResponse({
      id: preparedBase.publicId,
      expectedRevision: preparedBase.revision,
      responseDigest: "a".repeat(64),
    });
    const writtenPrepared = store.prepareInteractionResponse({
      id: writtenBase.publicId,
      expectedRevision: writtenBase.revision,
      responseDigest: "b".repeat(64),
    });
    store.markInteractionResponseWritten({
      id: writtenPrepared.publicId,
      expectedRevision: writtenPrepared.revision,
      responseDigest: "b".repeat(64),
    });

    const snapshot = store.readAttentionNotificationSnapshot({
      limit: ATTENTION_NOTIFICATION_SNAPSHOT_LIMIT,
      now,
    });
    expect(snapshot.status).toBe("complete");
    expect(snapshot.observedAt).toBe(now);
    expect(snapshot.interactions.map((interaction) => interaction.publicId)).toEqual([
      boundaryFuture.publicId,
      tiedFirst.publicId,
      tiedSecond.publicId,
      later.publicId,
    ]);
    expect(snapshot.interactions.every((interaction) =>
      interaction.sessionId !== null
      && interaction.state === "pending"
      && interaction.deadlineAt > now)).toBe(true);

    for (const invalid of [
      { limit: 0, now },
      { limit: ATTENTION_NOTIFICATION_SNAPSHOT_LIMIT + 1, now },
      { limit: 1.5, now },
      { limit: 1, now: -1 },
      { limit: 1, now: Number.NaN },
    ]) {
      expect(() => store.readAttentionNotificationSnapshot(invalid)).toThrow();
    }
  });

  test("returns no partial attention candidates on linked overflow", async () => {
    const home = await realpath(await mkdtemp(join(tmpdir(), "hra-store-attention-overflow-")));
    const paths = resolveStatePaths({ homeDirectory: home, platform: "darwin" });
    await initializeStatePaths(paths);
    const now = 80_000;
    const store = new StateStore(paths, { now: () => now });
    stores.push(store);
    const profile = signInProfile(store, "Attention overflow", "attention-overflow@example.com");
    const session = store.createSession({ profileId: profile.id, preset: "high", fastEnabled: false });
    const connectionId = "25000000-0000-4000-8000-999999999999";
    const admit = (index: number, sessionId: string | null) => store.admitInteraction({
      publicId: `25000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
      sessionId,
      authority: {
        profileId: profile.id,
        processGeneration: profile.processGeneration,
        connectionId,
        requestId: { type: "number" as const, value: index },
        method: "item/commandExecution/requestApproval",
        requestDigest: index.toString(16).padStart(64, "0"),
        threadId: sessionId === null ? null : "thread-attention-overflow",
        turnId: sessionId === null ? null : `turn-${String(index)}`,
        itemId: sessionId === null ? null : `item-${String(index)}`,
        approvalId: null,
      },
      kind: "command_approval",
      blocking: true,
      display: {
        kind: "command_approval",
        summary: "Review overflow accounting",
        reason: null,
        commandClass: "test",
        workingDirectory: null,
        availableDecisions: ["decline"],
      },
      requestedAt: now - 1_000,
      deadlineAt: now + 1_000,
    }).record;

    for (let index = 1; index <= ATTENTION_NOTIFICATION_SNAPSHOT_LIMIT + 16; index += 1) {
      admit(index, null);
    }
    const linked = Array.from(
      { length: ATTENTION_NOTIFICATION_SNAPSHOT_LIMIT },
      (_, offset) => admit(100 + offset, session.id),
    );
    expect(store.readAttentionNotificationSnapshot({
      limit: ATTENTION_NOTIFICATION_SNAPSHOT_LIMIT,
      now,
    })).toEqual({
      interactions: linked,
      observedAt: now,
      status: "complete",
    });

    admit(100 + ATTENTION_NOTIFICATION_SNAPSHOT_LIMIT, session.id);
    expect(store.readAttentionNotificationSnapshot({
      limit: ATTENTION_NOTIFICATION_SNAPSHOT_LIMIT,
      now,
    })).toEqual({ interactions: [], observedAt: now, status: "overflow" });
  });

  test("anchors immutable interaction deadlines and terminal intent across delayed admission", async () => {
    const home = await realpath(await mkdtemp(join(tmpdir(), "hra-store-deadline-")));
    const paths = resolveStatePaths({ homeDirectory: home, platform: "darwin" });
    await initializeStatePaths(paths);
    let now = 10_000;
    const store = new StateStore(paths, { now: () => now });
    stores.push(store);
    const profile = signInProfile(store, "Deadline", "deadline@example.com");
    const session = store.createSession({ profileId: profile.id, preset: "high", fastEnabled: false });
    const authority = {
      profileId: profile.id,
      processGeneration: profile.processGeneration,
      connectionId: "21000000-0000-4000-8000-000000000001",
      requestId: { type: "number" as const, value: 1 },
      method: "item/fileChange/requestApproval",
      requestDigest: "a".repeat(64),
      threadId: "thread-deadline",
      turnId: "turn-deadline",
      itemId: "item-deadline",
      approvalId: null,
    };
    const display = {
      kind: "file_change_approval" as const,
      summary: "Allow bounded changes",
      reason: null,
      grantRoot: null,
      availableDecisions: ["once" as const, "decline" as const, "cancel" as const],
    };
    now = 15_000;
    const admitted = store.admitInteraction({
      publicId: "21000000-0000-4000-8000-000000000002",
      sessionId: session.id,
      authority,
      kind: "file_change_approval",
      blocking: true,
      display,
      requestedAt: 10_000,
      deadlineAt: 16_000,
    });
    expect(admitted.record).toMatchObject({ requestedAt: 10_000, deadlineAt: 16_000 });
    expect(store.nextInteractionDeadlineAt()).toBe(16_000);
    expect(store.listDueInteractions({ now: 15_999 })).toEqual([]);
    expect(store.listDueInteractions({ now: 16_000 })).toEqual([admitted.record]);
    now = 16_000;
    expect(store.admitInteraction({
      publicId: "21000000-0000-4000-8000-000000000003",
      sessionId: session.id,
      authority,
      kind: "file_change_approval",
      blocking: true,
      display,
      requestedAt: 10_000,
      deadlineAt: 16_000,
    })).toEqual({ record: admitted.record, replayed: true });
    expect(() => store.admitInteraction({
      publicId: "21000000-0000-4000-8000-000000000004",
      sessionId: session.id,
      authority,
      kind: "file_change_approval",
      blocking: true,
      display,
      requestedAt: 10_000,
      deadlineAt: 16_001,
    })).toThrow("INTERACTION_REQUEST_REPLAY_CONFLICT");

    const digest = "b".repeat(64);
    const prepared = store.prepareInteractionResponse({
      id: admitted.record.publicId,
      expectedRevision: admitted.record.revision,
      responseDigest: digest,
      intendedTerminalState: "declined",
    });
    const written = store.markInteractionResponseWritten({
      id: prepared.publicId,
      expectedRevision: prepared.revision,
      responseDigest: digest,
    });
    expect(() => store.settleInteraction({
      id: written.publicId,
      expectedRevision: written.revision,
      state: "resolved",
      authority,
      responseDigest: digest,
    })).toThrow("INTERACTION_TERMINAL_INTENT_CONFLICT");
    expect(store.settleInteraction({
      id: written.publicId,
      expectedRevision: written.revision,
      state: "declined",
      authority,
      responseDigest: digest,
    })).toMatchObject({ state: "declined", intendedTerminalState: "declined", deadlineAt: 16_000 });
  });

  test("supersedes only the exact elapsed prepared response with a durable timeout intent", async () => {
    const home = await realpath(await mkdtemp(join(tmpdir(), "hra-store-timeout-cas-")));
    const paths = resolveStatePaths({ homeDirectory: home, platform: "darwin" });
    await initializeStatePaths(paths);
    let now = 15_000;
    const store = new StateStore(paths, { now: () => now });
    stores.push(store);
    const profile = signInProfile(store, "Timeout CAS", "timeout-cas@example.com");
    const session = store.createSession({ profileId: profile.id, preset: "high", fastEnabled: false });
    const authority = {
      profileId: profile.id,
      processGeneration: profile.processGeneration,
      connectionId: "22000000-0000-4000-8000-000000000001",
      requestId: { type: "string" as const, value: "timeout-cas" },
      method: "item/commandExecution/requestApproval",
      requestDigest: "a".repeat(64),
      threadId: "thread-timeout-cas",
      turnId: "turn-timeout-cas",
      itemId: "item-timeout-cas",
      approvalId: null,
    };
    const admitted = store.admitInteraction({
      publicId: "22000000-0000-4000-8000-000000000002",
      sessionId: session.id,
      authority,
      kind: "command_approval",
      blocking: true,
      display: {
        kind: "command_approval",
        summary: "Allow before the deadline",
        reason: null,
        commandClass: "test",
        workingDirectory: null,
        availableDecisions: ["once", "decline", "cancel"],
      },
      requestedAt: 10_000,
      deadlineAt: 16_000,
    }).record;
    const manualResponseDigest = "b".repeat(64);
    const timeoutResponseDigest = "c".repeat(64);
    const prepared = store.prepareInteractionResponse({
      id: admitted.publicId,
      expectedRevision: admitted.revision,
      responseDigest: manualResponseDigest,
      intendedTerminalState: "resolved",
    });
    expect(() => store.supersedePreparedInteractionResponseWithTimeout({
      id: prepared.publicId,
      expectedRevision: prepared.revision,
      manualResponseDigest,
      timeoutResponseDigest,
    })).toThrow("INTERACTION_DEADLINE_NOT_ELAPSED");

    now = 16_000;
    const superseded = store.supersedePreparedInteractionResponseWithTimeout({
      id: prepared.publicId,
      expectedRevision: prepared.revision,
      manualResponseDigest,
      timeoutResponseDigest,
    });
    expect(superseded).toMatchObject({
      state: "response_prepared",
      revision: 3,
      responseDigest: timeoutResponseDigest,
      intendedTerminalState: "expired",
    });
    expect(store.supersedePreparedInteractionResponseWithTimeout({
      id: prepared.publicId,
      expectedRevision: prepared.revision,
      manualResponseDigest,
      timeoutResponseDigest,
    })).toEqual(superseded);
    expect(() => store.supersedePreparedInteractionResponseWithTimeout({
      id: prepared.publicId,
      expectedRevision: prepared.revision,
      manualResponseDigest: "d".repeat(64),
      timeoutResponseDigest,
    })).toThrow("INTERACTION_RESPONSE_CONFLICT");
    expect(() => store.markInteractionResponseWritten({
      id: superseded.publicId,
      expectedRevision: superseded.revision,
      responseDigest: manualResponseDigest,
    })).toThrow("INTERACTION_RESPONSE_CONFLICT");
    const written = store.markInteractionResponseWritten({
      id: superseded.publicId,
      expectedRevision: superseded.revision,
      responseDigest: timeoutResponseDigest,
    });
    expect(written).toMatchObject({ state: "response_written", revision: 4 });
    expect(() => store.supersedePreparedInteractionResponseWithTimeout({
      id: prepared.publicId,
      expectedRevision: prepared.revision,
      manualResponseDigest,
      timeoutResponseDigest: "e".repeat(64),
    })).toThrow("INTERACTION_REVISION_CONFLICT");

    const raw = new Database(paths.database, { create: false, strict: true });
    try {
      expect(() => raw.query(
        "UPDATE provider_interactions SET response_digest=? WHERE public_id=?",
      ).run("f".repeat(64), admitted.publicId)).toThrow(
        "provider interaction response authority is immutable",
      );
      expect(raw.query(
        `SELECT revision,state,response_digest FROM provider_interaction_transitions
         WHERE public_id=? ORDER BY revision`,
      ).all(admitted.publicId)).toEqual([
        { revision: 1, state: "pending", response_digest: null },
        { revision: 2, state: "response_prepared", response_digest: manualResponseDigest },
        { revision: 3, state: "response_prepared", response_digest: timeoutResponseDigest },
        { revision: 4, state: "response_written", response_digest: timeoutResponseDigest },
      ]);
    } finally {
      raw.close(false);
    }
  });

  test("expires untouched generation interactions and quarantines write-adjacent responses", async () => {
    const { store } = await fixture();
    const profile = signInProfile(store, "Interaction restart", "interaction-restart@example.com");
    const connectionId = "30000000-0000-4000-8000-000000000001";
    const admit = (publicId: string, requestId: number) => store.admitInteraction({
      publicId,
      sessionId: null,
      authority: {
        profileId: profile.id,
        processGeneration: profile.processGeneration,
        connectionId,
        requestId: { type: "number", value: requestId },
        method: "item/tool/requestUserInput",
        requestDigest: requestId.toString(16).padStart(64, "0"),
        threadId: null,
        turnId: null,
        itemId: null,
        approvalId: null,
      },
      kind: "user_input",
      blocking: true,
      display: {
        kind: "user_input",
        summary: "A protected question",
        blocking: true,
        questions: [{
          id: `question-${requestId}`,
          header: "Choice",
          question: "Continue?",
          options: null,
          allowsOther: true,
          secret: true,
        }],
      },
    }).record;
    const pending = admit("30000000-0000-4000-8000-000000000002", 1);
    const preparedBase = admit("30000000-0000-4000-8000-000000000003", 2);
    const prepared = store.prepareInteractionResponse({
      id: preparedBase.publicId,
      expectedRevision: preparedBase.revision,
      responseDigest: "f".repeat(64),
    });
    store.nextProfileGeneration(profile.id);
    expect(() => store.prepareInteractionResponse({
      id: pending.publicId,
      expectedRevision: pending.revision,
      responseDigest: "1".repeat(64),
    })).toThrow("INTERACTION_AUTHORITY_CHANGED");
    const terminal = store.expireGenerationInteractions({
      profileId: profile.id,
      processGeneration: profile.processGeneration,
      connectionId,
    });
    expect(terminal).toEqual([
      expect.objectContaining({ publicId: pending.publicId, state: "expired", revision: 2 }),
      expect.objectContaining({ publicId: prepared.publicId, state: "resolution_unknown", revision: 3 }),
    ]);
    expect(store.listInteractions({ pendingOnly: true })).toEqual([]);
    expect(() => store.prepareInteractionResponse({
      id: pending.publicId,
      expectedRevision: pending.revision,
      responseDigest: "1".repeat(64),
    })).toThrow("INTERACTION_AUTHORITY_CHANGED");
  });

  for (const effect of ["known_unsent", "possibly_sent"] as const) {
    test(`atomically quarantines an interaction persistence boundary that is ${effect}`, async () => {
      const { store } = await fixture();
      const profile = signInProfile(
        store,
        `Persistence ${effect}`,
        `persistence-${effect}@example.com`,
      );
      const session = store.createSession({
        profileId: profile.id,
        preset: "high",
        fastEnabled: false,
      });
      const connectionId = effect === "known_unsent"
        ? "30100000-0000-4000-8000-000000000001"
        : "30200000-0000-4000-8000-000000000001";
      let request = 0;
      const admit = (connection = connectionId) => {
        request += 1;
        return store.admitInteraction({
          publicId: crypto.randomUUID(),
          sessionId: session.id,
          authority: {
            profileId: profile.id,
            processGeneration: profile.processGeneration,
            connectionId: connection,
            requestId: { type: "number", value: request },
            method: "item/commandExecution/requestApproval",
            requestDigest: request.toString(16).padStart(64, "0"),
            threadId: "thread-persistence-quarantine",
            turnId: "turn-persistence-quarantine",
            itemId: `item-${String(request)}`,
            approvalId: null,
          },
          kind: "command_approval",
          blocking: true,
          display: {
            kind: "command_approval",
            summary: "Quarantine the persistence boundary",
            reason: null,
            commandClass: "test",
            workingDirectory: null,
            availableDecisions: ["once", "decline", "cancel"],
          },
        }).record;
      };
      const focalBase = admit();
      const focalPrepared = store.prepareInteractionResponse({
        id: focalBase.publicId,
        expectedRevision: focalBase.revision,
        responseDigest: "a".repeat(64),
      });
      const focal = effect === "known_unsent"
        ? focalPrepared
        : store.markInteractionResponseWritten({
            id: focalPrepared.publicId,
            expectedRevision: focalPrepared.revision,
            responseDigest: "a".repeat(64),
          });
      const peerPending = admit();
      const peerPrepared = store.prepareInteractionResponse({
        id: admit().publicId,
        expectedRevision: 1,
        responseDigest: "b".repeat(64),
      });
      const peerPreparedForWrite = store.prepareInteractionResponse({
        id: admit().publicId,
        expectedRevision: 1,
        responseDigest: "c".repeat(64),
      });
      const peerWritten = store.markInteractionResponseWritten({
        id: peerPreparedForWrite.publicId,
        expectedRevision: peerPreparedForWrite.revision,
        responseDigest: "c".repeat(64),
      });
      const otherConnection = admit("30900000-0000-4000-8000-000000000001");

      expect(() => store.quarantineInteractionPersistenceBoundary({
        profileId: profile.id,
        processGeneration: profile.processGeneration,
        connectionId,
        focalInteractionId: focal.publicId,
        effect,
        responseDigest: "f".repeat(64),
      })).toThrow("INTERACTION_QUARANTINE_RESPONSE_CONFLICT");
      expect(store.requireProfileById(profile.id).processGeneration).toBe(
        profile.processGeneration,
      );
      expect(store.requireInteraction(focal.publicId)).toEqual(focal);
      expect(store.requireInteraction(peerPending.publicId)).toEqual(peerPending);
      expect(store.requireInteraction(otherConnection.publicId)).toEqual(otherConnection);

      const quarantined = store.quarantineInteractionPersistenceBoundary({
        profileId: profile.id,
        processGeneration: profile.processGeneration,
        connectionId,
        focalInteractionId: focal.publicId,
        effect,
        responseDigest: "a".repeat(64),
      });

      expect(quarantined.profile.processGeneration).toBe(profile.processGeneration + 1);
      expect(quarantined.focalInteraction).toMatchObject({
        publicId: focal.publicId,
        state: effect === "known_unsent" ? "expired" : "resolution_unknown",
        revision: focal.revision + 1,
      });
      expect(quarantined.terminalInteractions).toEqual([
        expect.objectContaining({ publicId: focal.publicId }),
        expect.objectContaining({ publicId: peerPending.publicId, state: "expired" }),
        expect.objectContaining({ publicId: peerPrepared.publicId, state: "resolution_unknown" }),
        expect.objectContaining({ publicId: peerWritten.publicId, state: "resolution_unknown" }),
        expect.objectContaining({ publicId: otherConnection.publicId, state: "expired" }),
      ]);
      const terminalEvents = store.listSessionEvents({
        sessionId: session.id,
        afterSequence: 0,
      }).events;
      expect(terminalEvents).toHaveLength(quarantined.terminalInteractions.length);
      expect(terminalEvents.map((event) => ({
        accountId: event.accountId,
        body: event.body,
        providerGeneration: event.providerGeneration,
      }))).toEqual(quarantined.terminalInteractions.map((interaction) => ({
        accountId: profile.id,
        body: {
          type: "interaction_state",
          interactionId: interaction.publicId,
          state: interaction.state,
          revision: interaction.revision,
        },
        providerGeneration: profile.processGeneration,
      })));
      expect(store.requireInteraction(otherConnection.publicId)).toMatchObject({
        state: "expired",
        revision: 2,
      });
      expect(() => store.prepareInteractionResponse({
        id: otherConnection.publicId,
        expectedRevision: otherConnection.revision,
        responseDigest: "d".repeat(64),
      })).toThrow("INTERACTION_AUTHORITY_CHANGED");

      const inspector = new Database(store.paths.database, { readonly: true, strict: true });
      try {
        for (const terminal of quarantined.terminalInteractions) {
          expect(inspector.query(
            `SELECT revision,state FROM provider_interaction_transitions
             WHERE public_id=? ORDER BY revision DESC LIMIT 1`,
          ).get(terminal.publicId)).toEqual({
            revision: terminal.revision,
            state: terminal.state,
          });
        }
        expect(inspector.query(
          "SELECT COUNT(*) AS count FROM provider_interaction_transitions WHERE public_id=?",
        ).get(otherConnection.publicId)).toEqual({ count: 2 });
      } finally {
        inspector.close(false);
      }
    });
  }

  test("rolls back every quarantine transition when its generation fence cannot commit", async () => {
    const { store } = await fixture();
    const profile = signInProfile(store, "Persistence rollback", "persistence-rollback@example.com");
    const session = store.createSession({
      profileId: profile.id,
      preset: "high",
      fastEnabled: false,
    });
    const connectionId = "30300000-0000-4000-8000-000000000001";
    const admit = (requestId: number) => store.admitInteraction({
      publicId: crypto.randomUUID(),
      sessionId: session.id,
      authority: {
        profileId: profile.id,
        processGeneration: profile.processGeneration,
        connectionId,
        requestId: { type: "number", value: requestId },
        method: "item/tool/requestUserInput",
        requestDigest: requestId.toString(16).padStart(64, "0"),
        threadId: "thread-persistence-rollback",
        turnId: null,
        itemId: null,
        approvalId: null,
      },
      kind: "user_input",
      blocking: true,
      display: {
        kind: "user_input",
        summary: "Rollback the persistence quarantine",
        blocking: true,
        questions: [{
          id: `rollback-${String(requestId)}`,
          header: "Rollback",
          question: "Continue?",
          options: null,
          allowsOther: true,
          secret: true,
        }],
      },
    }).record;
    const focal = store.prepareInteractionResponse({
      id: admit(1).publicId,
      expectedRevision: 1,
      responseDigest: "a".repeat(64),
    });
    const peer = admit(2);
    const injector = new Database(store.paths.database, { create: false, strict: true });
    try {
      injector.exec(`
        CREATE TRIGGER reject_interaction_quarantine_generation
        BEFORE UPDATE OF process_generation ON profiles
        WHEN OLD.id='${profile.id}'
        BEGIN SELECT RAISE(ABORT, 'injected quarantine rollback'); END;
      `);
    } finally {
      injector.close(false);
    }

    expect(() => store.quarantineInteractionPersistenceBoundary({
      profileId: profile.id,
      processGeneration: profile.processGeneration,
      connectionId,
      focalInteractionId: focal.publicId,
      effect: "known_unsent",
      responseDigest: "a".repeat(64),
    })).toThrow("injected quarantine rollback");
    expect(store.requireProfileById(profile.id).processGeneration).toBe(
      profile.processGeneration,
    );
    expect(store.requireInteraction(focal.publicId)).toEqual(focal);
    expect(store.requireInteraction(peer.publicId)).toEqual(peer);
    expect(store.listSessionEvents({ sessionId: session.id, afterSequence: 0 }).events).toEqual([]);
    const inspector = new Database(store.paths.database, { readonly: true, strict: true });
    try {
      expect(inspector.query(
        "SELECT revision,state FROM provider_interaction_transitions WHERE public_id=? ORDER BY revision",
      ).all(focal.publicId)).toEqual([
        { revision: 1, state: "pending" },
        { revision: 2, state: "response_prepared" },
      ]);
      expect(inspector.query(
        "SELECT revision,state FROM provider_interaction_transitions WHERE public_id=? ORDER BY revision",
      ).all(peer.publicId)).toEqual([{ revision: 1, state: "pending" }]);
    } finally {
      inspector.close(false);
    }
  });

  test("allocates usage revisions atomically and pages the historical ledger", async () => {
    const { store } = await fixture();
    const profile = store.createProfile("Usage ledger");
    expect(store.allocateNextUsageRevision(profile.id)).toBe(1);
    store.recordUsage(profile.id, 1, 10_000, { totalTokens: 100 });
    expect(store.allocateNextUsageRevision(profile.id)).toBe(2);
    store.recordUsage(profile.id, 2, 20_000, { totalTokens: 250 });
    store.recordUsage(profile.id, 2, 20_000, { totalTokens: 250 });
    expect(() => store.recordUsage(profile.id, 2, 20_000, { totalTokens: 251 })).toThrow("Usage source revision conflict");
    expect(store.usageRange({ profileId: profile.id, fromObservedAt: 15_000, throughObservedAt: 25_000 })).toEqual([
      { sourceRevision: 2, observedAt: 20_000, payload: { totalTokens: 250 } },
    ]);
    expect(store.latestUsage(profile.id)).toEqual({
      sourceRevision: 2,
      observedAt: 20_000,
      payload: { totalTokens: 250 },
    });
  });

  test("creates new profiles with explicit active reset policy atomically", async () => {
    const { store } = await fixture();
    const profile = store.createProfile("Policy active");
    expect(store.requireAccountRateLimitResetPolicy(profile.id)).toMatchObject({
      state: "active_unbound",
      accountFingerprint: null,
      weeklyWindowResetsAt: null,
      revision: 1,
    });

    const writer = new Database(store.paths.database, { create: false, strict: true });
    try {
      writer.exec(`
        CREATE TRIGGER test_reset_policy_insert_failure
        BEFORE INSERT ON account_rate_limit_reset_policies
        WHEN NEW.profile_id IN (SELECT id FROM profiles WHERE label='Policy rollback')
        BEGIN SELECT RAISE(ABORT, 'injected policy insert failure'); END;
      `);
    } finally {
      writer.close(false);
    }
    expect(() => store.createProfile("Policy rollback"))
      .toThrow("injected policy insert failure");
    expect(store.listProfiles().map((candidate) => candidate.label))
      .not.toContain("Policy rollback");
  });

  test("re-pends an unbound reset policy when the signed-in identity changes", async () => {
    const { store } = await fixture();
    const firstEmail = "unbound-first@example.com";
    const profile = signInProfile(store, "Unbound identity drift", firstEmail);
    expect(store.requireAccountRateLimitResetPolicy(profile.id)).toMatchObject({
      state: "active_unbound",
      accountFingerprint: null,
      weeklyWindowResetsAt: null,
      revision: 1,
    });

    const secondEmail = "unbound-second@example.com";
    expect(store.setProfileState(
      profile.id,
      profile.processGeneration,
      "signed_in",
      { email: secondEmail, plan: "Plus" },
    )).toBe(true);
    expect(store.requireProfileById(profile.id)).toMatchObject({
      providerEmail: secondEmail,
    });
    expect(store.requireAccountRateLimitResetPolicy(profile.id)).toMatchObject({
      state: "reconciliation_required",
      accountFingerprint: null,
      weeklyWindowResetsAt: null,
      revision: 2,
    });

    const secondFingerprint = resetAccountFingerprint(secondEmail);
    expect(() => store.prepareAccountRateLimitReset({
      profileId: profile.id,
      processGeneration: profile.processGeneration,
      accountFingerprint: secondFingerprint,
      weeklyWindowResetsAt: 500_000_000,
      observedUsedPercent: 99,
    })).toThrow("ACCOUNT_RATE_LIMIT_RESET_POLICY_NOT_ACTIVE");
    expect(store.authorizeAccountRateLimitResetPolicy({
      profileId: profile.id,
      processGeneration: profile.processGeneration,
      accountFingerprint: secondFingerprint,
      weeklyWindowDurationMinutes: 10_080,
      weeklyWindowResetsAt: 500_000_000,
    })).toMatchObject({
      decision: "suppress",
      reason: "reconciliation_window",
      policy: {
        accountFingerprint: secondFingerprint,
        state: "window_suppressed",
        weeklyWindowResetsAt: 500_000_000,
      },
    });
  });

  test("migrates every nonremoved v27 profile into fail-closed reconciliation", async () => {
    const { store } = await fixture();
    const email = "legacy-policy@example.com";
    const signedIn = signInProfile(store, "Legacy signed in", email);
    const signedOut = store.createProfile("Legacy signed out");
    const removed = store.createProfile("Legacy removed");
    store.removeProfile(removed.id);
    const accountFingerprint = resetAccountFingerprint(email);
    const prepared = prepareAuthorizedReset(store, {
      profileId: signedIn.id,
      processGeneration: signedIn.processGeneration,
      accountFingerprint,
      weeklyWindowResetsAt: 500_000_000,
      observedUsedPercent: 99,
    });
    expect(store.beginAccountRateLimitReset(prepared.idempotencyKey).state)
      .toBe("effect_started");
    const paths = store.paths;
    store.close();
    stores.splice(stores.indexOf(store), 1);

    const legacy = new Database(paths.database, { create: false, strict: true });
    try {
      legacy.exec(`
        DROP TRIGGER account_rate_limit_reset_attempt_policy_insert_guard;
        DROP TRIGGER account_rate_limit_reset_attempt_policy_begin_guard;
        DROP TRIGGER account_rate_limit_reset_attempt_policy_close_guard;
        DROP TRIGGER account_rate_limit_reset_rebind_policy_guard;
        DROP TRIGGER account_rate_limit_reset_policy_insert_guard;
        DROP TRIGGER account_rate_limit_reset_policy_transition_guard;
        DROP TRIGGER account_rate_limit_reset_policy_delete_guard;
        DROP TABLE account_rate_limit_reset_policies;
        DELETE FROM migrations WHERE version=28;
        PRAGMA user_version=27;
      `);
    } finally {
      legacy.close(false);
    }

    const migrated = new StateStore(paths, { now: () => 2_000 });
    stores.push(migrated);
    for (const profileId of [signedIn.id, signedOut.id]) {
      expect(migrated.requireAccountRateLimitResetPolicy(profileId)).toMatchObject({
        state: "reconciliation_required",
        accountFingerprint: null,
        weeklyWindowResetsAt: null,
        revision: 1,
      });
    }
    expect(() => migrated.requireAccountRateLimitResetPolicy(removed.id))
      .toThrow("ACCOUNT_RATE_LIMIT_RESET_POLICY_MISSING");
    expect(migrated.readRecoverableAccountRateLimitReset(
      signedIn.id,
      accountFingerprint,
    )).toMatchObject({
      idempotencyKey: prepared.idempotencyKey,
      outcome: null,
      state: "effect_started",
    });
    expect(() => migrated.prepareAccountRateLimitReset({
      profileId: signedIn.id,
      processGeneration: signedIn.processGeneration,
      accountFingerprint,
      weeklyWindowResetsAt: 500_000_000,
      observedUsedPercent: 99,
    })).toThrow("ACCOUNT_RATE_LIMIT_RESET_POLICY_NOT_ACTIVE");
    const replacementEmail = "legacy-policy-replacement@example.com";
    expect(migrated.setProfileState(
      signedIn.id,
      signedIn.processGeneration,
      "signed_in",
      { email: replacementEmail, plan: "Plus" },
    )).toBe(true);
    expect(migrated.readRecoverableAccountRateLimitReset(
      signedIn.id,
      accountFingerprint,
    )).toMatchObject({
      idempotencyKey: prepared.idempotencyKey,
      outcome: null,
      state: "effect_started",
    });
    const replacementFingerprint = resetAccountFingerprint(replacementEmail);
    expect(migrated.authorizeAccountRateLimitResetPolicy({
      profileId: signedIn.id,
      processGeneration: signedIn.processGeneration,
      accountFingerprint: replacementFingerprint,
      weeklyWindowDurationMinutes: 10_080,
      weeklyWindowResetsAt: 500_100_000,
    })).toMatchObject({
      decision: "suppress",
      policy: {
        accountFingerprint: replacementFingerprint,
        state: "window_suppressed",
      },
    });
    expect(migrated.readRecoverableAccountRateLimitReset(
      signedIn.id,
      accountFingerprint,
    )).toBeNull();
    expect(migrated.latestAccountRateLimitResetAttempt(
      signedIn.id,
      accountFingerprint,
    )).toMatchObject({
      idempotencyKey: prepared.idempotencyKey,
      localResolution: "account_identity_changed",
      outcome: null,
      state: "closed",
    });
    const inspector = new Database(paths.database, { readonly: true, strict: true });
    try {
      expect(inspector.query("PRAGMA user_version").get()).toEqual({ user_version: 41 });
      expect(inspector.query(
        "SELECT COUNT(*) AS count FROM account_rate_limit_reset_attempts",
      ).get()).toEqual({ count: 1 });
    } finally {
      inspector.close(false);
    }
  });

  test("reconciles retained partial-v28 policies when user_version is still 27", async () => {
    const { store } = await fixture();
    const email = "partial-policy@example.com";
    const profile = signInProfile(store, "Partial reset policy", email);
    const accountFingerprint = resetAccountFingerprint(email);
    const prepared = prepareAuthorizedReset(store, {
      profileId: profile.id,
      processGeneration: profile.processGeneration,
      accountFingerprint,
      weeklyWindowResetsAt: 500_000_000,
      observedUsedPercent: 99,
    });
    store.beginAccountRateLimitReset(prepared.idempotencyKey);
    const previousPolicy = store.requireAccountRateLimitResetPolicy(profile.id);
    const paths = store.paths;
    store.close();
    stores.splice(stores.indexOf(store), 1);

    const partial = new Database(paths.database, { create: false, strict: true });
    try {
      partial.exec("DELETE FROM migrations WHERE version=28; PRAGMA user_version=27");
    } finally {
      partial.close(false);
    }

    const migrated = new StateStore(paths, { now: () => 2_000 });
    stores.push(migrated);
    expect(migrated.requireAccountRateLimitResetPolicy(profile.id)).toMatchObject({
      state: "reconciliation_required",
      accountFingerprint: null,
      weeklyWindowResetsAt: null,
      revision: previousPolicy.revision + 1,
    });
    expect(migrated.readRecoverableAccountRateLimitReset(
      profile.id,
      accountFingerprint,
    )).toMatchObject({
      idempotencyKey: prepared.idempotencyKey,
      outcome: null,
      state: "effect_started",
    });
  });

  test("persists reset-policy reconciliation until the suppressed boundary has elapsed", async () => {
    const home = await realpath(await mkdtemp(join(tmpdir(), "hra-policy-boundary-")));
    const paths = resolveStatePaths({ homeDirectory: home, platform: "darwin" });
    await initializeStatePaths(paths);
    let now = 1_000;
    const store = new StateStore(paths, { now: () => now });
    stores.push(store);
    const firstEmail = "policy-first@example.com";
    const profile = signInProfile(store, "Policy transitions", firstEmail);
    const firstFingerprint = resetAccountFingerprint(firstEmail);
    const firstWindow = 10_000;
    const first = store.authorizeAccountRateLimitResetPolicy({
      profileId: profile.id,
      processGeneration: profile.processGeneration,
      accountFingerprint: firstFingerprint,
      weeklyWindowDurationMinutes: 10_080,
      weeklyWindowResetsAt: firstWindow,
    });
    expect(first).toMatchObject({ decision: "allow", policy: { state: "active_bound" } });
    expect(store.authorizeAccountRateLimitResetPolicy({
      profileId: profile.id,
      processGeneration: profile.processGeneration,
      accountFingerprint: firstFingerprint,
      weeklyWindowDurationMinutes: 10_080,
      weeklyWindowResetsAt: firstWindow - 1,
    })).toMatchObject({
      decision: "block",
      reason: "weekly_window_nonmonotonic",
      policy: { revision: first.policy.revision },
    });
    expect(store.authorizeAccountRateLimitResetPolicy({
      profileId: profile.id,
      processGeneration: profile.processGeneration,
      accountFingerprint: firstFingerprint,
      weeklyWindowDurationMinutes: 10_080,
      weeklyWindowResetsAt: firstWindow + 1_000,
    })).toMatchObject({
      decision: "allow",
      policy: { state: "active_bound", weeklyWindowResetsAt: firstWindow + 1_000 },
    });

    const secondEmail = "policy-second@example.com";
    expect(store.setProfileState(
      profile.id,
      profile.processGeneration,
      "signed_in",
      { email: secondEmail, plan: "Plus" },
    )).toBe(true);
    expect(store.requireAccountRateLimitResetPolicy(profile.id)).toMatchObject({
      state: "reconciliation_required",
      accountFingerprint: null,
      weeklyWindowResetsAt: null,
    });
    const secondFingerprint = resetAccountFingerprint(secondEmail);
    const suppressedWindow = 20_000;
    const suppressed = store.authorizeAccountRateLimitResetPolicy({
      profileId: profile.id,
      processGeneration: profile.processGeneration,
      accountFingerprint: secondFingerprint,
      weeklyWindowDurationMinutes: 10_080,
      weeklyWindowResetsAt: suppressedWindow,
    });
    expect(suppressed).toMatchObject({
      decision: "suppress",
      reason: "reconciliation_window",
      policy: { state: "window_suppressed" },
    });
    store.nextDaemonGeneration(`boot_${"w".repeat(32)}`);
    const restarted = store.requireProfileById(profile.id);
    expect(store.authorizeAccountRateLimitResetPolicy({
      profileId: profile.id,
      processGeneration: restarted.processGeneration,
      accountFingerprint: secondFingerprint,
      weeklyWindowDurationMinutes: 10_080,
      weeklyWindowResetsAt: suppressedWindow,
    })).toMatchObject({
      decision: "suppress",
      policy: { revision: suppressed.policy.revision },
    });
    expect(store.authorizeAccountRateLimitResetPolicy({
      profileId: profile.id,
      processGeneration: restarted.processGeneration,
      accountFingerprint: secondFingerprint,
      weeklyWindowDurationMinutes: 10_080,
      weeklyWindowResetsAt: suppressedWindow - 1_000,
    })).toMatchObject({
      decision: "block",
      reason: "weekly_window_nonmonotonic",
      policy: { revision: suppressed.policy.revision },
    });
    expect(store.authorizeAccountRateLimitResetPolicy({
      profileId: profile.id,
      processGeneration: restarted.processGeneration,
      accountFingerprint: secondFingerprint,
      weeklyWindowDurationMinutes: 10_080,
      weeklyWindowResetsAt: suppressedWindow + 1_000,
    })).toMatchObject({
      decision: "block",
      reason: "weekly_window_nonmonotonic",
      policy: { revision: suppressed.policy.revision },
    });
    now = suppressedWindow - 1;
    expect(store.authorizeAccountRateLimitResetPolicy({
      profileId: profile.id,
      processGeneration: restarted.processGeneration,
      accountFingerprint: secondFingerprint,
      weeklyWindowDurationMinutes: 10_080,
      weeklyWindowResetsAt: suppressedWindow,
    })).toMatchObject({
      decision: "suppress",
      policy: { revision: suppressed.policy.revision },
    });
    expect(store.authorizeAccountRateLimitResetPolicy({
      profileId: profile.id,
      processGeneration: restarted.processGeneration,
      accountFingerprint: secondFingerprint,
      weeklyWindowDurationMinutes: 10_080,
      weeklyWindowResetsAt: suppressedWindow + 1_000,
    })).toMatchObject({
      decision: "block",
      reason: "weekly_window_nonmonotonic",
      policy: { revision: suppressed.policy.revision },
    });
    now = suppressedWindow;
    const activated = store.authorizeAccountRateLimitResetPolicy({
      profileId: profile.id,
      processGeneration: restarted.processGeneration,
      accountFingerprint: secondFingerprint,
      weeklyWindowDurationMinutes: 10_080,
      weeklyWindowResetsAt: suppressedWindow + 1_000,
    });
    expect(activated).toMatchObject({
      decision: "allow",
      policy: { state: "active_bound", weeklyWindowResetsAt: suppressedWindow + 1_000 },
    });
    expect(store.authorizeAccountRateLimitResetPolicy({
      profileId: profile.id,
      processGeneration: restarted.processGeneration,
      accountFingerprint: secondFingerprint,
      weeklyWindowDurationMinutes: 10_080,
      weeklyWindowResetsAt: suppressedWindow + 2_000,
    })).toMatchObject({
      decision: "allow",
      policy: { state: "active_bound", weeklyWindowResetsAt: suppressedWindow + 2_000 },
    });

    const thirdEmail = "policy-third@example.com";
    expect(store.setProfileState(
      profile.id,
      restarted.processGeneration,
      "signed_in",
      { email: thirdEmail, plan: "Plus" },
    )).toBe(true);
    expect(store.requireAccountRateLimitResetPolicy(profile.id)).toMatchObject({
      state: "reconciliation_required",
      accountFingerprint: null,
      weeklyWindowResetsAt: null,
    });
    const thirdFingerprint = resetAccountFingerprint(thirdEmail);
    const pending = store.authorizeAccountRateLimitResetPolicy({
      profileId: profile.id,
      processGeneration: restarted.processGeneration,
      accountFingerprint: thirdFingerprint,
      weeklyWindowDurationMinutes: 300,
      weeklyWindowResetsAt: suppressedWindow + 3_000,
    });
    expect(pending).toMatchObject({
      decision: "block",
      reason: "weekly_window_unavailable",
      policy: { state: "reconciliation_required" },
    });
    expect(store.authorizeAccountRateLimitResetPolicy({
      profileId: profile.id,
      processGeneration: restarted.processGeneration,
      accountFingerprint: thirdFingerprint,
      weeklyWindowDurationMinutes: 300,
      weeklyWindowResetsAt: suppressedWindow + 3_000,
    })).toMatchObject({
      decision: "block",
      reason: "weekly_window_unavailable",
      policy: { revision: pending.policy.revision, state: "reconciliation_required" },
    });
  });

  test("re-pends bound identity drift and closes every old-identity recoverable state", async () => {
    const { store } = await fixture();
    const recoverableStates = [
      "prepared",
      "retryable",
      "ambiguous",
      "effect_started",
    ] as const;

    for (const [index, recoverableState] of recoverableStates.entries()) {
      const firstEmail = `identity-${recoverableState}@example.com`;
      const profile = signInProfile(
        store,
        `Identity ${recoverableState}`,
        firstEmail,
      );
      expect(store.requireAccountRateLimitResetPolicy(profile.id)).toMatchObject({
        state: "active_unbound",
        accountFingerprint: null,
      });
      const firstFingerprint = resetAccountFingerprint(firstEmail);
      const prepared = prepareAuthorizedReset(store, {
        profileId: profile.id,
        processGeneration: profile.processGeneration,
        accountFingerprint: firstFingerprint,
        weeklyWindowResetsAt: 500_000_000 + index,
        observedUsedPercent: 99,
      });
      if (recoverableState !== "prepared") {
        store.beginAccountRateLimitReset(prepared.idempotencyKey);
      }
      if (recoverableState === "retryable" || recoverableState === "ambiguous") {
        store.deferAccountRateLimitReset(prepared.idempotencyKey, recoverableState);
      }
      const policyBeforeDrift = store.requireAccountRateLimitResetPolicy(profile.id);
      const secondEmail = `replacement-${recoverableState}@example.com`;
      expect(store.setProfileState(
        profile.id,
        profile.processGeneration,
        "signed_in",
        { email: secondEmail, plan: "Plus" },
      )).toBe(true);

      expect(store.requireAccountRateLimitResetPolicy(profile.id)).toMatchObject({
        state: "reconciliation_required",
        accountFingerprint: null,
        weeklyWindowResetsAt: null,
        revision: policyBeforeDrift.revision + 1,
      });
      expect(store.latestAccountRateLimitResetAttempt(profile.id, firstFingerprint))
        .toMatchObject({
          idempotencyKey: prepared.idempotencyKey,
          localResolution: "account_identity_changed",
          outcome: null,
          state: "closed",
        });
      expect(store.readRecoverableAccountRateLimitReset(profile.id, firstFingerprint))
        .toBeNull();

      const secondFingerprint = resetAccountFingerprint(secondEmail);
      expect(store.authorizeAccountRateLimitResetPolicy({
        profileId: profile.id,
        processGeneration: profile.processGeneration,
        accountFingerprint: secondFingerprint,
        weeklyWindowDurationMinutes: 10_080,
        weeklyWindowResetsAt: 500_100_000 + index,
      })).toMatchObject({
        decision: "suppress",
        reason: "reconciliation_window",
        policy: {
          accountFingerprint: secondFingerprint,
          state: "window_suppressed",
        },
      });
    }
  });

  test("refuses to reopen a current database with missing reset policy authority", async () => {
    const { store } = await fixture();
    const profile = store.createProfile("Missing reset policy");
    const paths = store.paths;
    store.close();
    stores.splice(stores.indexOf(store), 1);
    const damaged = new Database(paths.database, { create: false, strict: true });
    try {
      damaged.exec("DROP TRIGGER account_rate_limit_reset_policy_delete_guard");
      damaged.query(
        "DELETE FROM account_rate_limit_reset_policies WHERE profile_id=?",
      ).run(profile.id);
    } finally {
      damaged.close(false);
    }
    expect(() => new StateStore(paths))
      .toThrow("STATE_ACCOUNT_RATE_LIMIT_RESET_POLICY_MISSING");
  });

  test("readonly open rejects a stale same-name reset-policy guard", async () => {
    const { store } = await fixture();
    const paths = store.paths;
    store.close();
    stores.splice(stores.indexOf(store), 1);
    const damaged = new Database(paths.database, { create: false, strict: true });
    try {
      damaged.exec(`
        DROP TRIGGER account_rate_limit_reset_policy_transition_guard;
        CREATE TRIGGER account_rate_limit_reset_policy_transition_guard
        BEFORE UPDATE ON account_rate_limit_reset_policies
        BEGIN SELECT 1; END;
      `);
    } finally {
      damaged.close(false);
    }

    expect(() => new StateStore(paths, { readonly: true }))
      .toThrow("STATE_SCHEMA_V28_STRUCTURE_INVALID");
  });

  test("readonly open rejects a weakened same-name reset-policy table", async () => {
    const { store } = await fixture();
    const paths = store.paths;
    store.close();
    stores.splice(stores.indexOf(store), 1);
    const damaged = new Database(paths.database, { create: false, strict: true });
    try {
      const triggers = damaged.query(
        `SELECT name,sql FROM sqlite_master
         WHERE type='trigger' AND (
           name LIKE 'account_rate_limit_reset_policy_%'
           OR name='account_rate_limit_reset_attempt_transition_guard'
           OR name LIKE 'account_rate_limit_reset_attempt_policy_%'
           OR name IN (
             'account_rate_limit_reset_rebind_policy_guard',
             'account_rate_limit_reset_rebind_insert_guard'
           )
         ) ORDER BY name`,
      ).all().map((row) => z.object({ name: z.string(), sql: z.string() })
        .strict().parse(row));
      for (const trigger of triggers) {
        damaged.exec(`DROP TRIGGER ${trigger.name}`);
      }
      damaged.exec(`
        ALTER TABLE account_rate_limit_reset_policies
          RENAME TO account_rate_limit_reset_policies_strict;
        CREATE TABLE account_rate_limit_reset_policies (
          profile_id TEXT PRIMARY KEY,
          state TEXT NOT NULL,
          account_fingerprint TEXT,
          weekly_window_resets_at INTEGER,
          revision INTEGER NOT NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
        INSERT INTO account_rate_limit_reset_policies
          SELECT * FROM account_rate_limit_reset_policies_strict;
        DROP TABLE account_rate_limit_reset_policies_strict;
      `);
      for (const trigger of triggers) damaged.exec(trigger.sql);
    } finally {
      damaged.close(false);
    }

    expect(() => new StateStore(paths, { readonly: true }))
      .toThrow("STATE_SCHEMA_V28_STRUCTURE_INVALID");
  });

  test("readonly open rejects a corrupt reset-policy row under exact guards", async () => {
    const { store } = await fixture();
    const profile = store.createProfile("Corrupt reset policy");
    const paths = store.paths;
    store.close();
    stores.splice(stores.indexOf(store), 1);
    const damaged = new Database(paths.database, { create: false, strict: true });
    try {
      const transition = z.object({ sql: z.string() }).strict().parse(
        damaged.query(
          `SELECT sql FROM sqlite_master
           WHERE type='trigger'
             AND name='account_rate_limit_reset_policy_transition_guard'`,
        ).get(),
      ).sql;
      damaged.exec(`
        DROP TRIGGER account_rate_limit_reset_policy_transition_guard;
        PRAGMA ignore_check_constraints=ON;
      `);
      damaged.query(
        `UPDATE account_rate_limit_reset_policies
         SET state='active_bound',account_fingerprint=NULL,
           weekly_window_resets_at=NULL,revision=revision+1
         WHERE profile_id=?`,
      ).run(profile.id);
      damaged.exec(transition);
      damaged.exec("PRAGMA ignore_check_constraints=OFF");
    } finally {
      damaged.close(false);
    }

    expect(() => new StateStore(paths, { readonly: true }))
      .toThrow("STATE_ACCOUNT_RATE_LIMIT_RESET_POLICY_INVALID");
  });

  test("readonly open rejects reset policy authority outside the live profile set", async () => {
    const { store } = await fixture();
    const profile = store.createProfile("Orphan reset policy");
    const paths = store.paths;
    store.close();
    stores.splice(stores.indexOf(store), 1);
    const damaged = new Database(paths.database, { create: false, strict: true });
    try {
      expect(damaged.query(
        "UPDATE profiles SET state='removed' WHERE id=?",
      ).run(profile.id).changes).toBe(1);
    } finally {
      damaged.close(false);
    }

    expect(() => new StateStore(paths, { readonly: true }))
      .toThrow("STATE_ACCOUNT_RATE_LIMIT_RESET_POLICY_ORPHANED");
  });

  test("journals automatic weekly reset redemption and retries only the same indeterminate key", async () => {
    const { store } = await fixture();
    const email = "reset@example.com";
    const profile = signInProfile(store, "Reset journal", email);
    const input = {
      profileId: profile.id,
      processGeneration: profile.processGeneration,
      accountFingerprint: resetAccountFingerprint(email),
      weeklyWindowResetsAt: 500_000_000,
      observedUsedPercent: 99,
    };
    const prepared = prepareAuthorizedReset(store, input);
    expect(prepared).toMatchObject({
      profileId: input.profileId,
      originProcessGeneration: input.processGeneration,
      currentProcessGeneration: input.processGeneration,
      accountFingerprint: input.accountFingerprint,
      weeklyWindowResetsAt: input.weeklyWindowResetsAt,
      observedUsedPercent: input.observedUsedPercent,
      outcome: null,
      localResolution: null,
      state: "prepared",
    });
    expect(store.prepareAccountRateLimitReset({
      ...input,
      observedUsedPercent: 99.8,
    }).idempotencyKey).toBe(prepared.idempotencyKey);

    expect(store.beginAccountRateLimitReset(prepared.idempotencyKey).state)
      .toBe("effect_started");
    expect(store.deferAccountRateLimitReset(prepared.idempotencyKey, "ambiguous").state)
      .toBe("ambiguous");
    expect(() => store.closeAccountRateLimitReset(
      prepared.idempotencyKey,
      "weekly_window_changed",
    )).toThrow("ACCOUNT_RATE_LIMIT_RESET_CLOSE_RESOLUTION_INVALID");
    expect(store.readRecoverableAccountRateLimitReset(
      profile.id,
      input.accountFingerprint,
    )?.idempotencyKey).toBe(prepared.idempotencyKey);
    expect(store.beginAccountRateLimitReset(prepared.idempotencyKey)).toMatchObject({
      idempotencyKey: prepared.idempotencyKey,
      state: "effect_started",
    });
    expect(store.deferAccountRateLimitReset(prepared.idempotencyKey, "ambiguous"))
      .toMatchObject({ idempotencyKey: prepared.idempotencyKey, state: "ambiguous" });
    expect(store.latestAccountRateLimitResetAttempt(
      profile.id,
      input.accountFingerprint,
    )).toMatchObject({
      idempotencyKey: prepared.idempotencyKey,
      state: "ambiguous",
      outcome: null,
    });
    expect(store.latestAccountRateLimitResetAttempt(
      profile.id,
      resetAccountFingerprint("someone-else@example.com"),
    )).toBeNull();

    expect(store.prepareAccountRateLimitReset({
      ...input,
      observedUsedPercent: 100,
    }).idempotencyKey).toBe(prepared.idempotencyKey);
    expect(store.readRecoverableAccountRateLimitReset(
      profile.id,
      input.accountFingerprint,
    )).toMatchObject({ idempotencyKey: prepared.idempotencyKey, state: "ambiguous" });
  });

  test("enforces reset-policy dispatch and ambiguous-effect guards in SQLite", async () => {
    const { store } = await fixture();
    const firstEmail = "raw-policy@example.com";
    const first = signInProfile(store, "Raw policy guard", firstEmail);
    const firstFingerprint = resetAccountFingerprint(firstEmail);
    const prepared = prepareAuthorizedReset(store, {
      profileId: first.id,
      processGeneration: first.processGeneration,
      accountFingerprint: firstFingerprint,
      weeklyWindowResetsAt: 500_000_000,
      observedUsedPercent: 99,
    });
    const changedEmail = "raw-policy-changed@example.com";
    expect(store.setProfileState(
      first.id,
      first.processGeneration,
      "signed_in",
      { email: changedEmail, plan: "Plus" },
    )).toBe(true);
    expect(store.latestAccountRateLimitResetAttempt(first.id, firstFingerprint))
      .toMatchObject({ idempotencyKey: prepared.idempotencyKey, state: "closed" });
    expect(store.authorizeAccountRateLimitResetPolicy({
      profileId: first.id,
      processGeneration: first.processGeneration,
      accountFingerprint: resetAccountFingerprint(changedEmail),
      weeklyWindowDurationMinutes: null,
      weeklyWindowResetsAt: null,
    })).toMatchObject({
      decision: "block",
      reason: "weekly_window_unavailable",
      policy: { state: "reconciliation_required" },
    });

    const secondEmail = "raw-ambiguous@example.com";
    const second = signInProfile(store, "Raw ambiguous guard", secondEmail);
    const secondFingerprint = resetAccountFingerprint(secondEmail);
    const ambiguous = prepareAuthorizedReset(store, {
      profileId: second.id,
      processGeneration: second.processGeneration,
      accountFingerprint: secondFingerprint,
      weeklyWindowResetsAt: 500_000_000,
      observedUsedPercent: 99,
    });
    store.beginAccountRateLimitReset(ambiguous.idempotencyKey);
    store.deferAccountRateLimitReset(ambiguous.idempotencyKey, "ambiguous");

    const inspector = new Database(store.paths.database, { create: false, strict: true });
    try {
      expect(() => inspector.query(
        `UPDATE account_rate_limit_reset_attempts
         SET state='closed',local_resolution='weekly_window_changed'
         WHERE idempotency_key=?`,
      ).run(ambiguous.idempotencyKey))
        .toThrow("illegal account rate-limit reset transition");
      inspector.query(
        `UPDATE account_rate_limit_reset_policies
         SET state='reconciliation_required',account_fingerprint=NULL,
           weekly_window_resets_at=NULL,revision=revision+1,
           updated_at=MAX(updated_at,?)
         WHERE profile_id=?`,
      ).run(2_000, second.id);
      expect(() => inspector.query(
        `INSERT INTO account_rate_limit_reset_attempts(
           idempotency_key,profile_id,origin_process_generation,
           current_process_generation,account_fingerprint,weekly_window_resets_at,
           observed_used_percent,state,created_at,updated_at
         ) VALUES (?,?,?,?,?,?,?,'prepared',?,?)`,
      ).run(
        "00000000-0000-4000-8000-000000000028",
        first.id,
        first.processGeneration,
        first.processGeneration,
        resetAccountFingerprint(changedEmail),
        500_000_001,
        99,
        2_000,
        2_000,
      )).toThrow("policy does not authorize preparation");
      expect(() => inspector.query(
        `UPDATE account_rate_limit_reset_attempts
         SET state='effect_started' WHERE idempotency_key=?`,
      ).run(ambiguous.idempotencyKey))
        .toThrow("policy does not authorize dispatch");
      expect(() => inspector.query(
        `INSERT INTO account_rate_limit_reset_rebinds(
           idempotency_key,from_process_generation,to_process_generation,
           account_fingerprint,created_at
         ) VALUES (?,?,?,?,?)`,
      ).run(
        ambiguous.idempotencyKey,
        ambiguous.currentProcessGeneration,
        ambiguous.currentProcessGeneration + 1,
        secondFingerprint,
        2_000,
      )).toThrow("policy does not authorize rebind");
    } finally {
      inspector.close(false);
    }
  });

  test("refuses to begin a reset after its authorized window expires", async () => {
    const home = await realpath(await mkdtemp(join(tmpdir(), "hra-reset-expired-begin-")));
    const paths = resolveStatePaths({ homeDirectory: home, platform: "darwin" });
    await initializeStatePaths(paths);
    let now = 1_000;
    const store = new StateStore(paths, { now: () => now });
    stores.push(store);
    const email = "expired-begin@example.com";
    const profile = signInProfile(store, "Expired reset begin", email);
    const prepared = prepareAuthorizedReset(store, {
      profileId: profile.id,
      processGeneration: profile.processGeneration,
      accountFingerprint: resetAccountFingerprint(email),
      weeklyWindowResetsAt: 5_000,
      observedUsedPercent: 99,
    });

    now = prepared.weeklyWindowResetsAt;
    expect(() => store.beginAccountRateLimitReset(prepared.idempotencyKey))
      .toThrow("ACCOUNT_RATE_LIMIT_RESET_WINDOW_NOT_FRESH");
    expect(store.readRecoverableAccountRateLimitReset(
      profile.id,
      prepared.accountFingerprint,
    )).toMatchObject({ idempotencyKey: prepared.idempotencyKey, state: "prepared" });
  });

  test("orders the most recent reset attempt by a durable sequence across clock rollback and vacuum", async () => {
    const home = await realpath(await mkdtemp(join(tmpdir(), "hra-reset-sequence-")));
    const paths = resolveStatePaths({ homeDirectory: home, platform: "darwin" });
    await initializeStatePaths(paths);
    let now = 10_000;
    const store = new StateStore(paths, { now: () => now });
    stores.push(store);
    const email = "ordered-reset@example.com";
    const profile = signInProfile(store, "Ordered reset", email);
    const accountFingerprint = resetAccountFingerprint(email);
    const first = prepareAuthorizedReset(store, {
      profileId: profile.id,
      processGeneration: profile.processGeneration,
      accountFingerprint,
      weeklyWindowResetsAt: 500_000_000,
      observedUsedPercent: 99,
    });
    store.beginAccountRateLimitReset(first.idempotencyKey);
    store.settleAccountRateLimitReset(first.idempotencyKey, "reset");

    now = 9_000;
    const second = prepareAuthorizedReset(store, {
      profileId: profile.id,
      processGeneration: profile.processGeneration,
      accountFingerprint,
      weeklyWindowResetsAt: 500_100_000,
      observedUsedPercent: 99,
    });
    expect(second.attemptSequence).toBeGreaterThan(first.attemptSequence);
    expect(second.createdAt).toBeLessThan(first.createdAt);
    expect(store.latestAccountRateLimitResetAttempt(profile.id, accountFingerprint))
      .toMatchObject({
        attemptSequence: second.attemptSequence,
        idempotencyKey: second.idempotencyKey,
        state: "prepared",
        weeklyWindowResetsAt: second.weeklyWindowResetsAt,
      });

    store.close();
    stores.splice(stores.indexOf(store), 1);
    const maintenance = new Database(paths.database, { create: false, strict: true });
    try {
      maintenance.exec("VACUUM");
    } finally {
      maintenance.close(false);
    }
    const reopened = new StateStore(paths);
    stores.push(reopened);
    expect(reopened.latestAccountRateLimitResetAttempt(profile.id, accountFingerprint))
      .toMatchObject({
        attemptSequence: second.attemptSequence,
        idempotencyKey: second.idempotencyKey,
        state: "prepared",
      });
  });

  test("retries a known no-op only after the weekly percentage advances", async () => {
    const { store } = await fixture();
    const email = "noop@example.com";
    const profile = signInProfile(store, "Reset no-op", email);
    const base = {
      profileId: profile.id,
      processGeneration: profile.processGeneration,
      accountFingerprint: resetAccountFingerprint(email),
      weeklyWindowResetsAt: 500_000_000,
    };
    const first = prepareAuthorizedReset(store, {
      ...base,
      observedUsedPercent: 99,
    });
    store.beginAccountRateLimitReset(first.idempotencyKey);
    store.settleAccountRateLimitReset(first.idempotencyKey, "nothingToReset");
    expect(store.prepareAccountRateLimitReset({
      ...base,
      observedUsedPercent: 99.9,
    }).idempotencyKey).toBe(first.idempotencyKey);
    const finalPercent = store.prepareAccountRateLimitReset({
      ...base,
      observedUsedPercent: 100,
    });
    expect(finalPercent.idempotencyKey).not.toBe(first.idempotencyKey);
    expect(finalPercent.state).toBe("prepared");
  });

  test("recovers effect-adjacent reset attempts without changing account state", async () => {
    const { store } = await fixture();
    const email = "recovery@example.com";
    const profile = signInProfile(store, "Reset recovery", email);
    const accountFingerprint = resetAccountFingerprint(email);
    const prepared = prepareAuthorizedReset(store, {
      profileId: profile.id,
      processGeneration: profile.processGeneration,
      accountFingerprint,
      weeklyWindowResetsAt: 500_000_000,
      observedUsedPercent: 99,
    });
    store.beginAccountRateLimitReset(prepared.idempotencyKey);
    expect(store.recoverAccountRateLimitResetAttempts({
      profileId: profile.id,
      processGeneration: profile.processGeneration,
      accountFingerprint,
      weeklyWindowResetsAt: prepared.weeklyWindowResetsAt,
    }))
      .toEqual([prepared.idempotencyKey]);
    expect(store.readRecoverableAccountRateLimitReset(
      profile.id,
      accountFingerprint,
    )).toMatchObject({
      idempotencyKey: prepared.idempotencyKey,
      state: "ambiguous",
    });
    expect(store.requireProfileById(profile.id).state).toBe("signed_in");
  });

  test("rebinds and retries an ambiguous key only after a later policy window activates", async () => {
    const home = await realpath(await mkdtemp(join(tmpdir(), "hra-reset-later-recovery-")));
    const paths = resolveStatePaths({ homeDirectory: home, platform: "darwin" });
    await initializeStatePaths(paths);
    let now = 1_000;
    const store = new StateStore(paths, { now: () => now });
    stores.push(store);
    const email = "restart-reset@example.com";
    const profile = signInProfile(store, "Reset restart", email);
    const accountFingerprint = resetAccountFingerprint(email);
    const firstWindow = 10_000;
    const prepared = prepareAuthorizedReset(store, {
      profileId: profile.id,
      processGeneration: profile.processGeneration,
      accountFingerprint,
      weeklyWindowResetsAt: firstWindow,
      observedUsedPercent: 99,
    });
    store.beginAccountRateLimitReset(prepared.idempotencyKey);
    store.recoverAccountRateLimitResetAttempts({
      profileId: profile.id,
      processGeneration: profile.processGeneration,
      accountFingerprint,
      weeklyWindowResetsAt: prepared.weeklyWindowResetsAt,
    });

    const migration = new Database(store.paths.database, { create: false, strict: true });
    try {
      migration.query(
        `UPDATE account_rate_limit_reset_policies
         SET state='reconciliation_required',account_fingerprint=NULL,
           weekly_window_resets_at=NULL,revision=revision+1,
           updated_at=MAX(updated_at,?)
         WHERE profile_id=?`,
      ).run(now, profile.id);
    } finally {
      migration.close(false);
    }
    expect(store.authorizeAccountRateLimitResetPolicy({
      profileId: profile.id,
      processGeneration: profile.processGeneration,
      accountFingerprint,
      weeklyWindowDurationMinutes: 10_080,
      weeklyWindowResetsAt: firstWindow,
    })).toMatchObject({ decision: "suppress", policy: { state: "window_suppressed" } });
    expect(() => store.beginAccountRateLimitReset(prepared.idempotencyKey))
      .toThrow("ACCOUNT_RATE_LIMIT_RESET_POLICY_NOT_ACTIVE");
    store.nextDaemonGeneration(`boot_${"r".repeat(32)}`);
    const restarted = store.requireProfileById(profile.id);

    const recoverable = store.readRecoverableAccountRateLimitReset(
      profile.id,
      accountFingerprint,
    );
    expect(recoverable).toMatchObject({
      idempotencyKey: prepared.idempotencyKey,
      originProcessGeneration: profile.processGeneration,
      currentProcessGeneration: profile.processGeneration,
      state: "ambiguous",
    });
    expect(() => store.rebindAccountRateLimitReset({
      idempotencyKey: prepared.idempotencyKey,
      expectedCurrentProcessGeneration: profile.processGeneration,
      nextProcessGeneration: restarted.processGeneration,
      accountFingerprint,
    })).toThrow("ACCOUNT_RATE_LIMIT_RESET_POLICY_NOT_ACTIVE");
    expect(store.listAccountRateLimitResetRebinds(prepared.idempotencyKey)).toEqual([]);
    now = firstWindow;
    const laterWindow = 20_000;
    expect(store.authorizeAccountRateLimitResetPolicy({
      profileId: profile.id,
      processGeneration: restarted.processGeneration,
      accountFingerprint,
      weeklyWindowDurationMinutes: 10_080,
      weeklyWindowResetsAt: laterWindow,
    })).toMatchObject({
      decision: "allow",
      policy: { state: "active_bound", weeklyWindowResetsAt: laterWindow },
    });
    expect(store.rebindAccountRateLimitReset({
      idempotencyKey: prepared.idempotencyKey,
      expectedCurrentProcessGeneration: profile.processGeneration,
      nextProcessGeneration: restarted.processGeneration,
      accountFingerprint,
    })).toMatchObject({
      idempotencyKey: prepared.idempotencyKey,
      state: "ambiguous",
      weeklyWindowResetsAt: firstWindow,
    });
    expect(store.beginAccountRateLimitReset(prepared.idempotencyKey)).toMatchObject({
      idempotencyKey: prepared.idempotencyKey,
      state: "effect_started",
      weeklyWindowResetsAt: firstWindow,
    });
    expect(store.listAccountRateLimitResetRebinds(prepared.idempotencyKey))
      .toHaveLength(1);
  });

  test("keeps prepared and retryable attempts bound to their exact active window", async () => {
    const { store } = await fixture();
    const attempts: Array<{
      accountFingerprint: string;
      idempotencyKey: string;
      profileId: ReturnType<typeof signInProfile>["id"];
      processGeneration: number;
    }> = [];
    for (const [index, state] of (["prepared", "retryable"] as const).entries()) {
      const email = `exact-window-${state}@example.com`;
      const profile = signInProfile(store, `Exact window ${state}`, email);
      const accountFingerprint = resetAccountFingerprint(email);
      const weeklyWindowResetsAt = 500_000_000 + index * 10_000;
      const prepared = prepareAuthorizedReset(store, {
        profileId: profile.id,
        processGeneration: profile.processGeneration,
        accountFingerprint,
        weeklyWindowResetsAt,
        observedUsedPercent: 99,
      });
      if (state === "retryable") {
        store.beginAccountRateLimitReset(prepared.idempotencyKey);
        store.deferAccountRateLimitReset(prepared.idempotencyKey, "retryable");
      }
      expect(store.authorizeAccountRateLimitResetPolicy({
        profileId: profile.id,
        processGeneration: profile.processGeneration,
        accountFingerprint,
        weeklyWindowDurationMinutes: 10_080,
        weeklyWindowResetsAt: weeklyWindowResetsAt + 1_000,
      })).toMatchObject({ decision: "allow", policy: { state: "active_bound" } });
      expect(() => store.beginAccountRateLimitReset(prepared.idempotencyKey))
        .toThrow("ACCOUNT_RATE_LIMIT_RESET_POLICY_NOT_ACTIVE");
      attempts.push({
        accountFingerprint,
        idempotencyKey: prepared.idempotencyKey,
        profileId: profile.id,
        processGeneration: profile.processGeneration,
      });
    }

    store.nextDaemonGeneration(`boot_${"e".repeat(32)}`);
    for (const attempt of attempts) {
      const restarted = store.requireProfileById(attempt.profileId);
      expect(() => store.rebindAccountRateLimitReset({
        idempotencyKey: attempt.idempotencyKey,
        expectedCurrentProcessGeneration: attempt.processGeneration,
        nextProcessGeneration: restarted.processGeneration,
        accountFingerprint: attempt.accountFingerprint,
      })).toThrow("ACCOUNT_RATE_LIMIT_RESET_POLICY_NOT_ACTIVE");
    }
  });

  test("cascades rebind evidence when expired parent history is pruned", async () => {
    const home = await realpath(await mkdtemp(join(tmpdir(), "hra-reset-rebind-prune-")));
    const paths = resolveStatePaths({ homeDirectory: home, platform: "darwin" });
    await initializeStatePaths(paths);
    let now = 1_000;
    const store = new StateStore(paths, { now: () => now++ });
    stores.push(store);
    const email = "pruned-rebind-reset@example.com";
    const profile = signInProfile(store, "Reset rebind prune", email);
    const accountFingerprint = resetAccountFingerprint(email);
    const expiringWindowResetsAt = 500_000;
    const prepared = prepareAuthorizedReset(store, {
      profileId: profile.id,
      processGeneration: profile.processGeneration,
      accountFingerprint,
      weeklyWindowResetsAt: expiringWindowResetsAt,
      observedUsedPercent: 99,
    });
    store.nextDaemonGeneration(`boot_${"p".repeat(32)}`);
    const restarted = store.requireProfileById(profile.id);
    store.rebindAccountRateLimitReset({
      idempotencyKey: prepared.idempotencyKey,
      expectedCurrentProcessGeneration: profile.processGeneration,
      nextProcessGeneration: restarted.processGeneration,
      accountFingerprint,
    });
    store.beginAccountRateLimitReset(prepared.idempotencyKey);
    store.settleAccountRateLimitReset(prepared.idempotencyKey, "reset");
    expect(store.listAccountRateLimitResetRebinds(prepared.idempotencyKey))
      .toHaveLength(1);

    for (let index = 0; index < 129; index += 1) {
      const historical = prepareAuthorizedReset(store, {
        profileId: restarted.id,
        processGeneration: restarted.processGeneration,
        accountFingerprint,
        weeklyWindowResetsAt: expiringWindowResetsAt + index + 1,
        observedUsedPercent: 99,
      });
      store.beginAccountRateLimitReset(historical.idempotencyKey);
      store.settleAccountRateLimitReset(historical.idempotencyKey, "noCredit");
    }
    now = 1_000_000;
    prepareAuthorizedReset(store, {
      profileId: restarted.id,
      processGeneration: restarted.processGeneration,
      accountFingerprint,
      weeklyWindowResetsAt: 1_500_000,
      observedUsedPercent: 99,
    });

    const inspector = new Database(store.paths.database, { create: false, strict: true });
    try {
      expect(inspector.query(
        "SELECT 1 FROM account_rate_limit_reset_attempts WHERE idempotency_key=?",
      ).get(prepared.idempotencyKey)).toBeNull();
      expect(inspector.query(
        "SELECT 1 FROM account_rate_limit_reset_rebinds WHERE idempotency_key=?",
      ).get(prepared.idempotencyKey)).toBeNull();
    } finally {
      inspector.close(false);
    }
  });

  test("keeps a successful weekly-window latch across daemon generations", async () => {
    const { store } = await fixture();
    const email = "latched-reset@example.com";
    const profile = signInProfile(store, "Reset latch", email);
    const accountFingerprint = resetAccountFingerprint(email);
    const input = {
      profileId: profile.id,
      processGeneration: profile.processGeneration,
      accountFingerprint,
      weeklyWindowResetsAt: 500_000_000,
      observedUsedPercent: 99,
    };
    const prepared = prepareAuthorizedReset(store, input);
    store.beginAccountRateLimitReset(prepared.idempotencyKey);
    store.settleAccountRateLimitReset(prepared.idempotencyKey, "reset");
    store.nextDaemonGeneration(`boot_${"s".repeat(32)}`);
    const restarted = store.requireProfileById(profile.id);

    expect(store.prepareAccountRateLimitReset({
      ...input,
      processGeneration: restarted.processGeneration,
      observedUsedPercent: 100,
    })).toMatchObject({
      idempotencyKey: prepared.idempotencyKey,
      originProcessGeneration: profile.processGeneration,
      outcome: "reset",
      state: "settled",
    });
  });

  test("keeps terminal reset evidence immutable", async () => {
    const { store } = await fixture();
    const email = "immutable-reset@example.com";
    const profile = signInProfile(store, "Reset evidence", email);
    const base = {
      profileId: profile.id,
      processGeneration: profile.processGeneration,
      accountFingerprint: resetAccountFingerprint(email),
      observedUsedPercent: 99,
    };
    const settled = prepareAuthorizedReset(store, {
      ...base,
      weeklyWindowResetsAt: 500_000_000,
    });
    store.beginAccountRateLimitReset(settled.idempotencyKey);
    store.settleAccountRateLimitReset(settled.idempotencyKey, "reset");
    const closed = prepareAuthorizedReset(store, {
      ...base,
      weeklyWindowResetsAt: 500_001_000,
    });
    store.closeAccountRateLimitReset(closed.idempotencyKey, "weekly_window_changed");

    const inspector = new Database(store.paths.database, { create: false, strict: true });
    try {
      expect(() => inspector.query(
        "UPDATE account_rate_limit_reset_attempts SET outcome='noCredit' WHERE idempotency_key=?",
      ).run(settled.idempotencyKey)).toThrow("terminal evidence is immutable");
      expect(() => inspector.query(
        `UPDATE account_rate_limit_reset_attempts
         SET local_resolution='account_identity_changed' WHERE idempotency_key=?`,
      ).run(closed.idempotencyKey)).toThrow("terminal evidence is immutable");
    } finally {
      inspector.close(false);
    }
    expect(store.latestAccountRateLimitResetAttempt(
      profile.id,
      base.accountFingerprint,
    )).toMatchObject({
      idempotencyKey: closed.idempotencyKey,
      state: "closed",
    });
  });

  test("retains every live-window latch while bounding expired reset history", async () => {
    const home = await realpath(await mkdtemp(join(tmpdir(), "hra-reset-retention-")));
    const paths = resolveStatePaths({ homeDirectory: home, platform: "darwin" });
    await initializeStatePaths(paths);
    let now = 1_000;
    const store = new StateStore(paths, { now: () => now++ });
    stores.push(store);
    const email = "retained-reset@example.com";
    const profile = signInProfile(store, "Reset retention", email);
    const accountFingerprint = resetAccountFingerprint(email);
    const firstWindowResetsAt = 500_000;
    let firstKey: string | null = null;

    for (let index = 0; index < 130; index += 1) {
      const prepared = prepareAuthorizedReset(store, {
        profileId: profile.id,
        processGeneration: profile.processGeneration,
        accountFingerprint,
        weeklyWindowResetsAt: firstWindowResetsAt + index,
        observedUsedPercent: 99,
      });
      firstKey ??= prepared.idempotencyKey;
      store.beginAccountRateLimitReset(prepared.idempotencyKey);
      store.settleAccountRateLimitReset(prepared.idempotencyKey, "reset");
    }
    if (firstKey === null) throw new Error("Expected the first reset latch.");
    expect(store.latestAccountRateLimitResetAttempt(profile.id, accountFingerprint))
      .not.toBeNull();

    now = firstWindowResetsAt + 1_000;
    prepareAuthorizedReset(store, {
      profileId: profile.id,
      processGeneration: profile.processGeneration,
      accountFingerprint,
      weeklyWindowResetsAt: now + 500_000,
      observedUsedPercent: 99,
    });

    const inspector = new Database(store.paths.database, { create: false, strict: true });
    try {
      expect(inspector.query(
        `SELECT COUNT(*) AS count FROM account_rate_limit_reset_attempts
         WHERE profile_id=? AND state IN ('settled','closed')
           AND weekly_window_resets_at<=?`,
      ).get(profile.id, now)).toEqual({ count: 128 });
      expect(inspector.query(
        "SELECT 1 FROM account_rate_limit_reset_attempts WHERE idempotency_key=?",
      ).get(firstKey)).toBeNull();
    } finally {
      inspector.close(false);
    }
  });

  test("closes identity-mismatched recovery without minting a duplicate key", async () => {
    const { store } = await fixture();
    const email = "identity-reset@example.com";
    const profile = signInProfile(store, "Reset identity", email);
    const accountFingerprint = resetAccountFingerprint(email);
    const input = {
      profileId: profile.id,
      processGeneration: profile.processGeneration,
      accountFingerprint,
      weeklyWindowResetsAt: 500_000_000,
      observedUsedPercent: 99,
    };
    const prepared = prepareAuthorizedReset(store, input);
    store.nextDaemonGeneration(`boot_${"i".repeat(32)}`);
    const restarted = store.requireProfileById(profile.id);
    expect(store.setProfileState(
      restarted.id,
      restarted.processGeneration,
      "signed_in",
      { email: "different@example.com", plan: "Plus" },
    )).toBe(true);

    expect(() => store.rebindAccountRateLimitReset({
      idempotencyKey: prepared.idempotencyKey,
      expectedCurrentProcessGeneration: profile.processGeneration,
      nextProcessGeneration: restarted.processGeneration,
      accountFingerprint,
    })).toThrow("ACCOUNT_RATE_LIMIT_RESET_REBIND_STATE_INVALID");
    expect(store.readRecoverableAccountRateLimitReset(profile.id, accountFingerprint))
      .toBeNull();
    expect(store.latestAccountRateLimitResetAttempt(profile.id, accountFingerprint))
      .toMatchObject({
        idempotencyKey: prepared.idempotencyKey,
        localResolution: "account_identity_changed",
        outcome: null,
        state: "closed",
      });
    expect(store.listAccountRateLimitResetRebinds(prepared.idempotencyKey)).toEqual([]);
    expect(() => store.prepareAccountRateLimitReset({
      ...input,
      processGeneration: restarted.processGeneration,
    })).toThrow("ACCOUNT_RATE_LIMIT_RESET_AUTHORITY_CHANGED");
  });

  test("admits one later no-credit attempt per whole-percent observation and bounds repeats", async () => {
    const { store } = await fixture();
    const email = "credit-reset@example.com";
    const profile = signInProfile(store, "Reset credit", email);
    const base = {
      profileId: profile.id,
      processGeneration: profile.processGeneration,
      accountFingerprint: resetAccountFingerprint(email),
      weeklyWindowResetsAt: 500_000_000,
    };
    const first = prepareAuthorizedReset(store, {
      ...base,
      observedUsedPercent: 99,
    });
    store.beginAccountRateLimitReset(first.idempotencyKey);
    store.settleAccountRateLimitReset(first.idempotencyKey, "noCredit");

    const later = store.prepareAccountRateLimitReset({
      ...base,
      observedUsedPercent: 99.5,
    });
    expect(later.idempotencyKey).not.toBe(first.idempotencyKey);
    store.beginAccountRateLimitReset(later.idempotencyKey);
    store.settleAccountRateLimitReset(later.idempotencyKey, "noCredit");
    expect(store.prepareAccountRateLimitReset({
      ...base,
      observedUsedPercent: 99.8,
    }).idempotencyKey).toBe(later.idempotencyKey);

    const exhausted = store.prepareAccountRateLimitReset({
      ...base,
      observedUsedPercent: 100,
    });
    expect(exhausted.idempotencyKey).not.toBe(later.idempotencyKey);
  });

  test("pages successful and failed usage observations in one exact source order", async () => {
    const { store } = await fixture();
    const profile = store.createProfile("Usage history page");
    const firstPayload = usageSnapshot({
      lifetimeTokens: 100,
      observedAt: 30_000,
      previous: null,
      receivedAt: 30_000,
      sourceSequence: 1,
    });
    const thirdPayload = usageSnapshot({
      lifetimeTokens: 300,
      observedAt: 20_000,
      previous: firstPayload,
      receivedAt: 20_000,
      sourceSequence: 3,
    });
    store.recordUsage(profile.id, 1, 30_000, firstPayload);
    store.recordUsagePollFailure(profile.id, usageFingerprint, 2, 10_000);
    store.recordUsage(profile.id, 3, 20_000, thirdPayload);
    store.recordUsagePollFailure(profile.id, usageFingerprint, 4, 50_000);

    const first = store.usageHistoryPage({
      profileId: profile.id,
      accountFingerprint: usageFingerprint,
      fromObservedAt: 5_000,
      throughObservedAt: 40_000,
      limit: 2,
    });
    expect(first).toEqual({
      entries: [
        {
          state: "observed",
          sourceRevision: 1,
          observedAt: 30_000,
          payload: firstPayload,
        },
        {
          state: "failed",
          sourceRevision: 2,
          observedAt: 10_000,
          reasonCode: "account_usage_read_failed",
        },
      ],
      nextSourceRevision: 2,
    });
    expect(store.usageHistoryPage({
      profileId: profile.id,
      accountFingerprint: usageFingerprint,
      fromObservedAt: 5_000,
      throughObservedAt: 40_000,
      afterSourceRevision: first.nextSourceRevision ?? 0,
      limit: 2,
    })).toEqual({
      entries: [{
        state: "observed",
        sourceRevision: 3,
        observedAt: 20_000,
        payload: thirdPayload,
      }],
      nextSourceRevision: null,
    });
  });

  test("selects latest usage outcomes by durable source revision instead of provider time", async () => {
    const { store } = await fixture();
    const profile = store.createProfile("Usage source order");
    store.recordUsage(profile.id, 1, 30_000, { totalTokens: 100 });
    store.recordUsage(profile.id, 2, 10_000, { totalTokens: 200 });
    store.recordUsagePollFailure(profile.id, usageFingerprint, 3, 40_000);
    store.recordUsagePollFailure(profile.id, usageFingerprint, 4, 5_000);

    expect(store.latestUsage(profile.id)).toEqual({
      sourceRevision: 2,
      observedAt: 10_000,
      payload: { totalTokens: 200 },
    });
    expect(store.latestUsagePollFailure(profile.id, usageFingerprint)).toEqual({
      sourceRevision: 4,
      observedAt: 5_000,
      reasonCode: "account_usage_read_failed",
    });
  });

  test("scopes usage snapshots and failures to the exact account after an identity change", async () => {
    const { store } = await fixture();
    const firstEmail = "usage-a@example.com";
    const secondEmail = "usage-b@example.com";
    const firstFingerprint = resetAccountFingerprint(firstEmail);
    const secondFingerprint = resetAccountFingerprint(secondEmail);
    const profile = signInProfile(store, "Usage identity", firstEmail);
    const first = usageSnapshot({
      accountFingerprint: firstFingerprint,
      lifetimeTokens: 100,
      observedAt: 10_000,
      previous: null,
      receivedAt: 1_000,
      sourceSequence: 1,
    });
    store.recordUsage(profile.id, 1, 10_000, first);
    store.recordUsagePollFailure(profile.id, firstFingerprint, 2, 20_000);

    expect(store.setProfileState(
      profile.id,
      profile.processGeneration,
      "signed_in",
      { email: secondEmail, plan: "Plus" },
    )).toBe(true);
    const second = usageSnapshot({
      accountFingerprint: secondFingerprint,
      lifetimeTokens: 200,
      observedAt: 30_000,
      previous: null,
      receivedAt: 1_000 + USAGE_CLOUD_UPLOAD_MIN_INTERVAL_MS,
      sourceSequence: 3,
    });
    store.recordUsage(profile.id, 3, 30_000, second);
    store.recordUsagePollFailure(profile.id, secondFingerprint, 4, 40_000);
    const staleFirst = usageSnapshot({
      accountFingerprint: firstFingerprint,
      lifetimeTokens: 300,
      observedAt: 50_000,
      previous: first,
      receivedAt: 1_000 + 2 * USAGE_CLOUD_UPLOAD_MIN_INTERVAL_MS,
      sourceSequence: 5,
    });
    store.recordUsage(profile.id, 5, 50_000, staleFirst);
    store.recordUsagePollFailure(profile.id, null, 6, 60_000);

    expect(store.latestUsage(profile.id)).toMatchObject({ sourceRevision: 5 });
    expect(store.latestUsageForAccount(profile.id, firstFingerprint))
      .toEqual({ sourceRevision: 5, observedAt: 50_000, payload: staleFirst });
    expect(store.latestUsageForAccount(profile.id, secondFingerprint))
      .toEqual({ sourceRevision: 3, observedAt: 30_000, payload: second });
    expect(store.latestUsagePollFailure(profile.id, firstFingerprint))
      .toMatchObject({ sourceRevision: 2 });
    expect(store.latestUsagePollFailure(profile.id, secondFingerprint))
      .toMatchObject({ sourceRevision: 4 });

    expect(store.usageHistoryPage({
      accountFingerprint: secondFingerprint,
      profileId: profile.id,
      fromObservedAt: 0,
      throughObservedAt: 60_000,
      limit: 10,
    }).entries.map((entry) => entry.sourceRevision)).toEqual([3, 4]);
    expect(store.usageHistoryPage({
      accountFingerprint: firstFingerprint,
      profileId: profile.id,
      fromObservedAt: 0,
      throughObservedAt: 60_000,
      limit: 10,
    }).entries.map((entry) => entry.sourceRevision)).toEqual([1, 2, 5]);
    expect(store.usageAfterRevision({
      accountFingerprint: secondFingerprint,
      afterSourceRevision: 0,
      limit: 10,
      profileId: profile.id,
    }).map((snapshot) => snapshot.sourceRevision)).toEqual([3]);
    expect(store.usageAfterRevision({
      accountFingerprint: firstFingerprint,
      afterSourceRevision: 0,
      limit: 10,
      profileId: profile.id,
    }).map((snapshot) => snapshot.sourceRevision)).toEqual([1, 5]);
  });

  test("pages successful usage by exact source revision independent of observation time", async () => {
    const { store } = await fixture();
    const profile = store.createProfile("Usage upload ledger");
    const first = usageSnapshot({
      lifetimeTokens: 100,
      observedAt: 30_000,
      previous: null,
      receivedAt: 1_000,
      sourceSequence: 1,
    });
    const second = usageSnapshot({
      lifetimeTokens: 200,
      observedAt: 10_000,
      previous: first,
      receivedAt: 1_000 + USAGE_CLOUD_UPLOAD_MIN_INTERVAL_MS,
      sourceSequence: 2,
    });
    const fourth = usageSnapshot({
      lifetimeTokens: 400,
      observedAt: 20_000,
      previous: second,
      receivedAt: 1_000 + 2 * USAGE_CLOUD_UPLOAD_MIN_INTERVAL_MS,
      sourceSequence: 4,
    });
    store.recordUsage(profile.id, 1, 30_000, first);
    store.recordUsage(profile.id, 2, 10_000, second);
    store.recordUsagePollFailure(profile.id, usageFingerprint, 3, 40_000);
    store.recordUsage(profile.id, 4, 20_000, fourth);

    expect(store.usageAfterRevision({
      afterSourceRevision: 1,
      accountFingerprint: usageFingerprint,
      limit: 2,
      profileId: profile.id,
    })).toEqual([
      { sourceRevision: 2, observedAt: 10_000, payload: second },
      { sourceRevision: 4, observedAt: 20_000, payload: fourth },
    ]);
    expect(store.usageAfterRevision({
      afterSourceRevision: 2,
      accountFingerprint: usageFingerprint,
      limit: 1,
      profileId: profile.id,
    })).toEqual([
      { sourceRevision: 4, observedAt: 20_000, payload: fourth },
    ]);
  });

  test("coalesces cloud upload history at the durable received-time cadence", async () => {
    const { store } = await fixture();
    const profile = store.createProfile("Usage upload cadence");
    let previous: StoredAccountUsageSnapshot | null = null;
    const received = [
      1_000,
      1_000 + USAGE_CLOUD_UPLOAD_MIN_INTERVAL_MS - 1,
      1_000 + USAGE_CLOUD_UPLOAD_MIN_INTERVAL_MS,
      1_000 + 2 * USAGE_CLOUD_UPLOAD_MIN_INTERVAL_MS - 1,
      1_000 + 2 * USAGE_CLOUD_UPLOAD_MIN_INTERVAL_MS,
    ];
    for (const [index, receivedAt] of received.entries()) {
      const sourceSequence = index + 1;
      const snapshot = usageSnapshot({
        lifetimeTokens: sourceSequence * 100,
        observedAt: receivedAt + 10_000,
        previous,
        receivedAt,
        sourceSequence,
      });
      store.recordUsage(profile.id, sourceSequence, snapshot.observation.observedAt, snapshot);
      previous = snapshot;
    }

    expect(store.usageAfterRevision({
      afterSourceRevision: 0,
      accountFingerprint: usageFingerprint,
      limit: 10,
      profileId: profile.id,
    }).map((snapshot) => snapshot.sourceRevision)).toEqual([1, 3, 5]);
    expect(store.usageAfterRevision({
      afterSourceRevision: 1,
      accountFingerprint: usageFingerprint,
      limit: 10,
      profileId: profile.id,
    }).map((snapshot) => snapshot.sourceRevision)).toEqual([3, 5]);
  });

  test("keeps daily upload cadence when the uploaded payload row is byte-pruned", async () => {
    const home = await realpath(await mkdtemp(join(tmpdir(), "hra-usage-anchor-retention-")));
    const paths = resolveStatePaths({ homeDirectory: home, platform: "linux" });
    await initializeStatePaths(paths);
    let now = 100_000;
    const store = new StateStore(paths, { now: () => now });
    stores.push(store);
    const profile = store.createProfile("Usage durable anchor");
    let previous: StoredAccountUsageSnapshot | null = null;
    for (let sourceSequence = 1; sourceSequence <= 70; sourceSequence += 1) {
      now = 100_000 + (sourceSequence - 1) * 50_000;
      const snapshot = usageSnapshot({
        fillerBytes: 249 * 1_024,
        lifetimeTokens: sourceSequence * 100,
        observedAt: now,
        previous,
        receivedAt: now,
        sourceSequence,
      });
      store.recordUsage(profile.id, sourceSequence, now, snapshot);
      previous = snapshot;
    }

    expect(store.usageRange({ profileId: profile.id, limit: 10_000 })[0]?.sourceRevision)
      .toBeGreaterThan(1);
    expect(store.usageAfterRevision({
      afterSourceRevision: 1,
      accountFingerprint: usageFingerprint,
      limit: 10,
      profileId: profile.id,
    })).toEqual([]);
    const inspector = new Database(paths.database, { readonly: true, strict: true });
    try {
      expect(inspector.query(
        `SELECT source_revision,received_at FROM usage_cloud_upload_anchors
         WHERE profile_id=? ORDER BY source_revision`,
      ).all(profile.id)).toEqual([{ received_at: 100_000, source_revision: 1 }]);
    } finally {
      inspector.close(false);
    }

    now = 100_000 + USAGE_CLOUD_UPLOAD_MIN_INTERVAL_MS;
    const next = usageSnapshot({
      fillerBytes: 249 * 1_024,
      lifetimeTokens: 7_100,
      observedAt: now,
      previous,
      receivedAt: now,
      sourceSequence: 71,
    });
    store.recordUsage(profile.id, 71, now, next);
    expect(store.usageAfterRevision({
      afterSourceRevision: 1,
      accountFingerprint: usageFingerprint,
      limit: 10,
      profileId: profile.id,
    }).map((snapshot) => snapshot.sourceRevision)).toEqual([71]);
  });

  test("bounds compact upload anchors independently of payload retention", async () => {
    const home = await realpath(await mkdtemp(join(tmpdir(), "hra-usage-anchor-bound-")));
    const paths = resolveStatePaths({ homeDirectory: home, platform: "linux" });
    await initializeStatePaths(paths);
    let now = 1_000;
    const store = new StateStore(paths, { now: () => now });
    stores.push(store);
    const profile = store.createProfile("Usage anchor bound");
    for (
      let sourceRevision = 1;
      sourceRevision <= USAGE_CLOUD_UPLOAD_ANCHOR_COUNT + 2;
      sourceRevision += 1
    ) {
      now = 1_000 + (sourceRevision - 1) * USAGE_CLOUD_UPLOAD_MIN_INTERVAL_MS;
      store.recordUsage(profile.id, sourceRevision, now, { totalTokens: sourceRevision });
    }
    const inspector = new Database(paths.database, { readonly: true, strict: true });
    try {
      const anchors = inspector.query(
        `SELECT source_revision FROM usage_cloud_upload_anchors
         WHERE profile_id=? ORDER BY source_revision`,
      ).all(profile.id) as { source_revision: number }[];
      expect(anchors).toHaveLength(USAGE_CLOUD_UPLOAD_ANCHOR_COUNT);
      expect(anchors[0]?.source_revision).toBe(3);
    } finally {
      inspector.close(false);
    }
  });

  test("bounds local usage bytes while preserving the live velocity window", async () => {
    const home = await realpath(await mkdtemp(join(tmpdir(), "hra-usage-retention-")));
    const paths = resolveStatePaths({ homeDirectory: home, platform: "linux" });
    await initializeStatePaths(paths);
    let now = 1_000;
    const store = new StateStore(paths, { now: () => now });
    stores.push(store);
    const profile = store.createProfile("Usage byte retention");
    let previous: StoredAccountUsageSnapshot | null = null;
    for (let sourceSequence = 1; sourceSequence <= 100; sourceSequence += 1) {
      now = 100_000 + sourceSequence * 50_000;
      const snapshot = usageSnapshot({
        fillerBytes: 240_000,
        lifetimeTokens: sourceSequence * 100,
        observedAt: now,
        previous,
        receivedAt: now,
        sourceSequence,
      });
      store.recordUsage(profile.id, sourceSequence, now, snapshot);
      previous = snapshot;
    }

    const ledger = store.usageRange({ profileId: profile.id, limit: 10_000 });
    const retainedBytes = ledger.reduce(
      (total, snapshot) => total + new TextEncoder().encode(JSON.stringify(snapshot.payload)).byteLength,
      0,
    );
    expect(ledger.length).toBeLessThan(100);
    expect(retainedBytes).toBeLessThanOrEqual(USAGE_LOCAL_RETAIN_BYTES);
    expect(observedAccountTokenVelocity({
      samples: accountUsageCounterSamples(ledger),
      window: "15m",
      now,
    })).toMatchObject({
      available: true,
      throughSourceSequence: 100,
    });
  });

  test("bounds local usage rows and removes observations past the age contract", async () => {
    const home = await realpath(await mkdtemp(join(tmpdir(), "hra-usage-row-retention-")));
    const paths = resolveStatePaths({ homeDirectory: home, platform: "linux" });
    await initializeStatePaths(paths);
    let now = 1_000;
    const store = new StateStore(paths, { now: () => now });
    stores.push(store);
    const profile = store.createProfile("Usage row retention");
    for (
      let sourceRevision = 1;
      sourceRevision <= USAGE_LOCAL_RETAIN_SUCCESS_COUNT + 2;
      sourceRevision += 1
    ) {
      now += 1;
      store.recordUsage(profile.id, sourceRevision, now, { totalTokens: sourceRevision });
    }
    const bounded = store.usageRange({ profileId: profile.id, limit: 10_000 });
    expect(bounded).toHaveLength(USAGE_LOCAL_RETAIN_SUCCESS_COUNT);
    expect(bounded[0]?.sourceRevision).toBe(3);

    now += USAGE_LOCAL_RETAIN_AGE_MS + 1;
    store.recordUsage(
      profile.id,
      USAGE_LOCAL_RETAIN_SUCCESS_COUNT + 3,
      now,
      { totalTokens: USAGE_LOCAL_RETAIN_SUCCESS_COUNT + 3 },
    );
    expect(store.usageRange({ profileId: profile.id, limit: 10_000 })).toEqual([{
      observedAt: now,
      payload: { totalTokens: USAGE_LOCAL_RETAIN_SUCCESS_COUNT + 3 },
      sourceRevision: USAGE_LOCAL_RETAIN_SUCCESS_COUNT + 3,
    }]);
  });

  test("reopens v9 event and interaction state read-only without rotating authority", async () => {
    const { store } = await fixture();
    const profile = signInProfile(store, "Readonly v9", "readonly-v9@example.com");
    const session = store.createSession({ profileId: profile.id, preset: "high", fastEnabled: false });
    const event = store.appendSessionEvent({
      sessionId: session.id,
      accountId: profile.id,
      providerGeneration: profile.processGeneration,
      providerConnectionId: null,
      body: { type: "warning", code: "PERSISTED", message: "safe" },
    });
    const interaction = store.admitInteraction({
      publicId: "40000000-0000-4000-8000-000000000001",
      sessionId: session.id,
      authority: {
        profileId: profile.id,
        processGeneration: profile.processGeneration,
        connectionId: "40000000-0000-4000-8000-000000000002",
        requestId: { type: "string", value: "request-readonly" },
        method: "item/fileChange/requestApproval",
        requestDigest: "4".repeat(64),
        threadId: "thread-readonly",
        turnId: "turn-readonly",
        itemId: "item-readonly",
        approvalId: null,
      },
      kind: "file_change_approval",
      blocking: true,
      display: {
        kind: "file_change_approval",
        summary: "Apply safe changes",
        reason: null,
        grantRoot: null,
        availableDecisions: ["once" as const, "decline" as const, "cancel" as const],
      },
    }).record;
    const paths = store.paths;
    store.close();
    stores.splice(stores.indexOf(store), 1);
    const readonly = new StateStore(paths, { readonly: true });
    stores.push(readonly);
    expect(readonly.eventStreamPosition(session.id)).toEqual({
      streamEpoch: event.streamEpoch,
      floorSequence: 1,
      observedThroughSequence: 1,
    });
    expect(readonly.listSessionEvents({ sessionId: session.id, afterSequence: 0 }).events).toEqual([event]);
    expect(readonly.requireInteraction(interaction.publicId)).toEqual(interaction);
  });

  test("creates fresh databases at the latest append-only schema version", async () => {
    const { store } = await fixture();
    const inspector = new Database(store.paths.database, { readonly: true, strict: true });
    try {
      expect(inspector.query("PRAGMA user_version").get()).toEqual({ user_version: 41 });
      expect(inspector.query("SELECT version FROM migrations ORDER BY version").all()).toEqual([{ version: 1 }, { version: 2 }, { version: 3 }, { version: 4 }, { version: 5 }, { version: 6 }, { version: 7 }, { version: 8 }, { version: 9 }, { version: 10 }, { version: 11 }, { version: 12 }, { version: 13 }, { version: 14 }, { version: 15 }, { version: 16 }, { version: 17 }, { version: 18 }, { version: 19 }, { version: 20 }, { version: 21 }, { version: 22 }, { version: 23 }, { version: 24 }, { version: 25 }, { version: 26 }, { version: 27 }, { version: 28 }, { version: 29 }, { version: 30 }, { version: 31 }, { version: 32 }, { version: 33 }, { version: 34 }, { version: 35 }, { version: 36 }, { version: 37 }, { version: 38 }, { version: 39 }, { version: 40 }, { version: 41 }]);
      expect(inspector.query("PRAGMA table_info(account_rate_limit_reset_attempts)").all())
        .toContainEqual(expect.objectContaining({ name: "attempt_sequence", type: "INTEGER", pk: 1 }));
      expect(inspector.query("PRAGMA table_info(account_rate_limit_reset_attempts)").all())
        .toContainEqual(expect.objectContaining({ name: "idempotency_key", type: "TEXT", notnull: 1, pk: 0 }));
      const resetAttemptColumns = inspector
        .query("PRAGMA table_info(account_rate_limit_reset_attempts)").all();
      for (const expected of [
        { name: "origin_process_generation", type: "INTEGER", notnull: 1 },
        { name: "current_process_generation", type: "INTEGER", notnull: 1 },
        { name: "account_fingerprint", type: "TEXT", notnull: 1 },
      ]) expect(resetAttemptColumns).toContainEqual(expect.objectContaining(expected));
      expect(inspector.query("PRAGMA table_info(account_rate_limit_reset_rebinds)").all())
        .toContainEqual(expect.objectContaining({ name: "sequence", type: "INTEGER", pk: 1 }));
      const resetPolicyColumns = inspector
        .query("PRAGMA table_info(account_rate_limit_reset_policies)").all();
      for (const expected of [
        { name: "profile_id", type: "TEXT", notnull: 1, pk: 1 },
        { name: "state", type: "TEXT", notnull: 1 },
        { name: "account_fingerprint", type: "TEXT", notnull: 0 },
        { name: "weekly_window_resets_at", type: "INTEGER", notnull: 0 },
        { name: "revision", type: "INTEGER", notnull: 1 },
      ]) expect(resetPolicyColumns).toContainEqual(expect.objectContaining(expected));
      expect(inspector.query("PRAGMA table_info(profiles)").all())
        .toContainEqual(expect.objectContaining({ name: "label_key", type: "TEXT" }));
      expect(inspector.query("PRAGMA table_info(projects)").all())
        .toContainEqual(expect.objectContaining({ name: "label_key", type: "TEXT" }));
      expect(inspector.query(
        "SELECT name FROM sqlite_master WHERE type='index' AND name LIKE '%label_key%' ORDER BY name",
      ).all()).toEqual([
        { name: "profiles_label_key_active" },
        { name: "projects_label_key_unique" },
      ]);
      expect(inspector.query("PRAGMA table_info(sessions)").all()).toContainEqual(expect.objectContaining({ name: "provider_updated_at", type: "REAL" }));
      expect(inspector.query("PRAGMA table_info(desktop_switches)").all()).toContainEqual(expect.objectContaining({ name: "switch_generation", type: "INTEGER" }));
      expect(inspector.query("PRAGMA table_info(usage_poll_failures)").all()).toContainEqual(expect.objectContaining({ name: "reason_code", type: "TEXT" }));
      expect(inspector.query("PRAGMA table_info(usage_poll_failures)").all()).toContainEqual(
        expect.objectContaining({ name: "account_fingerprint", type: "TEXT", notnull: 0 }),
      );
      expect(inspector.query("PRAGMA table_info(usage_cloud_upload_anchors)").all())
        .toContainEqual(expect.objectContaining({ name: "received_at", type: "INTEGER" }));
      expect(inspector.query("PRAGMA table_info(provider_interactions)").all())
        .toContainEqual(expect.objectContaining({ name: "deadline_at", type: "INTEGER", notnull: 1 }));
      expect(inspector.query("PRAGMA table_info(provider_interactions)").all())
        .toContainEqual(expect.objectContaining({ name: "intended_terminal_state", type: "TEXT" }));
      expect(inspector.query("PRAGMA table_info(provider_login_authorities)").all())
        .toContainEqual(expect.objectContaining({ name: "login_id", type: "TEXT", notnull: 1 }));
      const queueScrubPlan = inspector.query(
        `EXPLAIN QUERY PLAN
         SELECT 1
         FROM queue_entries
         WHERE message!='[queue message removed after settlement]'
           AND (
             state IN ('applied','failed','cancelled')
             OR EXISTS(
               SELECT 1 FROM queue_effect_resolutions r
               WHERE r.queue_id=queue_entries.id
             )
           )
         LIMIT 1`,
      ).all() as Array<{ detail: string }>;
      expect(queueScrubPlan.map((entry) => entry.detail).join(" "))
        .toContain("queue_entries_message_scrub_candidates");
      expect(inspector.query(
        "SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE 'provider_interactions_mcp_url_guard_%' ORDER BY name",
      ).all()).toEqual([
        { name: "provider_interactions_mcp_url_guard_insert" },
        { name: "provider_interactions_mcp_url_guard_update" },
      ]);
      expect(inspector.query(
        "SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'provider_interactions_listing_%' ORDER BY name",
      ).all()).toEqual([
        { name: "provider_interactions_listing_global" },
        { name: "provider_interactions_listing_pending_global" },
        { name: "provider_interactions_listing_pending_session" },
        { name: "provider_interactions_listing_session" },
      ]);
    } finally {
      inspector.close(false);
    }
  });

  test("migrates historical Sol runtime profiles without rewriting their durable JSON", async () => {
    const { store } = await fixture();
    const profile = signInProfile(store, "Historical Sol", "historical-sol@example.com");
    const session = store.upsertProviderSession({
      profileId: profile.id,
      providerThreadId: "thread-historical-sol",
      title: "Historical Sol",
      state: "idle",
    });
    const runtimeProfile = effectiveRuntimeProfileSchema.parse({
      profileId: profile.id,
      processGeneration: profile.processGeneration,
      observedAt: 2_000,
      preset: "high",
      model: "gpt-5.6-sol",
      reasoningEffort: "max",
      serviceTier: null,
      fast: false,
      approvalPolicy: "on-request",
      reviewMode: "auto_review",
      permissionProfile: ":workspace",
      computerUse: true,
      pluginCapability: true,
      enabledApps: [],
    });
    const legacyBinding = new Database(store.paths.database, { create: false, strict: true });
    try {
      legacyBinding.query(
        "UPDATE sessions SET preset_contract=? WHERE id=?",
      ).run(legacyPresetContract, session.id);
    } finally {
      legacyBinding.close(false);
    }
    store.recordSessionRuntimeProfile({
      sessionId: session.id,
      sourceKind: "turn_start",
      sourceId: "historical-sol-source",
      profile: runtimeProfile,
    });
    const paths = store.paths;
    store.close();
    stores.splice(stores.indexOf(store), 1);

    const legacy = new Database(paths.database, { create: false, strict: true });
    const before = z.object({ profile_json: z.string() }).strict().parse(legacy.query(
      "SELECT profile_json FROM session_runtime_profiles WHERE source_id='historical-sol-source'",
    ).get()).profile_json;
    legacy.exec("DELETE FROM migrations WHERE version>=38; PRAGMA user_version=37;");
    legacy.close(false);

    expect(() => new StateStore(paths, { readonly: true }))
      .toThrow("STATE_SCHEMA_MIGRATION_REQUIRED:37:41");
    const migrated = new StateStore(paths, { now: () => 4_000 });
    stores.push(migrated);
    expect(migrated.latestSessionRuntimeProfile(session.id)?.profile).toEqual(runtimeProfile);
    expect(migrated.requireSessionPresetRequirement(session.id)).toEqual({
      preset: "high",
      requirement: { model: "gpt-5.6-sol", effort: "max" },
    });
    const inspector = new Database(paths.database, { readonly: true, strict: true });
    try {
      expect(inspector.query(
        "SELECT profile_json FROM session_runtime_profiles WHERE source_id='historical-sol-source'",
      ).get()).toEqual({ profile_json: before });
      expect(inspector.query("PRAGMA user_version").get()).toEqual({ user_version: 41 });
    } finally {
      inspector.close(false);
    }
  });

  test("widens v38 provider authority without replacing existing session or rebind rows", async () => {
    const { store } = await fixture();
    const profile = signInProfile(store, "V38 provider authority", "v38-provider@example.com");
    const codex = store.createSession({
      profileId: profile.id,
      preset: "high",
      fastEnabled: false,
    });
    const claude = store.createSession({
      profileId: profile.id,
      provider: "claude",
      preset: "fable-max",
      fastEnabled: false,
    });
    const queued = store.enqueue(codex.id, "retained across provider widening");
    const attempt = store.prepareMutation({
      authorityGeneration: profile.processGeneration,
      authorityId: profile.id,
      idempotencyKey: "00000000-0000-4000-8000-000000003901",
      kind: "migration.provider-authority",
      request: { provider: "claude" },
    });
    const paths = store.paths;
    store.close();
    stores.splice(stores.indexOf(store), 1);

    const legacy = new Database(paths.database, { create: false, strict: true });
    try {
      legacy.query(
        `INSERT INTO session_mutation_authority_rebinds(
           attempt_id,profile_id,provider,from_generation,to_generation,recorded_at
         ) VALUES (?,?,?,?,?,?)`,
      ).run(
        attempt.id,
        profile.id,
        "claude",
        profile.processGeneration,
        profile.processGeneration + 1,
        1_500,
      );
      legacy.exec(`
        DROP TRIGGER work_devin_preset_contract_guard;
        DROP TRIGGER work_session_devin_contract_guard;
        DROP TRIGGER work_attempt_route_guard;
        DROP TRIGGER work_session_attempt_authority_guard;
        DROP TRIGGER work_profile_attempt_authority_guard;
        DROP TRIGGER work_signal_member_guard;
        DROP TABLE session_mutation_authority_rebinds_v39;
        ALTER TABLE sessions DROP COLUMN provider_v39;
        DELETE FROM migrations WHERE version IN (39,40,41);
        PRAGMA user_version=38;
      `);
      expect(legacy.query("PRAGMA table_info(sessions)").all())
        .not.toContainEqual(expect.objectContaining({ name: "provider_v39" }));
    } finally {
      legacy.close(false);
    }

    const migrated = new StateStore(paths, { now: () => 2_000 });
    stores.push(migrated);
    expect(migrated.requireSession(codex.id)).toMatchObject({ provider: "codex", preset: "high" });
    expect(migrated.requireSession(claude.id))
      .toMatchObject({ provider: "claude", preset: "fable-max" });
    expect(migrated.requireQueue(queued.id).message).toBe("retained across provider widening");
    const devin = migrated.createSession({
      profileId: profile.id,
      provider: "devin",
      preset: "astra",
      fastEnabled: false,
    });
    expect(migrated.requireSession(devin.id))
      .toMatchObject({ provider: "devin", preset: "astra" });

    const inspector = new Database(paths.database, { create: false, strict: true });
    try {
      expect(inspector.query("PRAGMA user_version").get()).toEqual({ user_version: 41 });
      expect(inspector.query(
        "SELECT id,provider,provider_v39 FROM sessions ORDER BY id",
      ).all()).toEqual([
        { id: claude.id, provider: "claude", provider_v39: "claude" },
        { id: codex.id, provider: "codex", provider_v39: "codex" },
        { id: devin.id, provider: "codex", provider_v39: "devin" },
      ].sort((left, right) => left.id.localeCompare(right.id)));
      expect(inspector.query(
        `SELECT attempt_id,profile_id,provider,from_generation,to_generation,recorded_at
         FROM session_mutation_authority_rebinds_v39 WHERE attempt_id=?`,
      ).get(attempt.id)).toEqual({
        attempt_id: attempt.id,
        profile_id: profile.id,
        provider: "claude",
        from_generation: profile.processGeneration,
        to_generation: profile.processGeneration + 1,
        recorded_at: 1_500,
      });
      inspector.query(
        `INSERT INTO session_mutation_authority_rebinds_v39(
           attempt_id,profile_id,provider,from_generation,to_generation,recorded_at
         ) VALUES (?,?,?,?,?,?)`,
      ).run(
        attempt.id,
        profile.id,
        "devin",
        profile.processGeneration,
        profile.processGeneration + 1,
        2_001,
      );
      expect(() => inspector.query(
        `UPDATE session_mutation_authority_rebinds_v39
         SET recorded_at=recorded_at+1 WHERE attempt_id=? AND provider='devin'`,
      ).run(attempt.id)).toThrow("immutable");
    } finally {
      inspector.close(false);
    }
  });

  test("rejects a v39 Devin session persisted under the legacy preset contract", async () => {
    const { store } = await fixture();
    const profile = signInProfile(store, "Invalid Devin contract", "invalid-devin@example.com");
    const session = store.createSession({
      profileId: profile.id,
      preset: "high",
      fastEnabled: false,
    });
    const paths = store.paths;
    store.close();
    stores.splice(stores.indexOf(store), 1);

    const partial = new Database(paths.database, { create: false, strict: true });
    try {
      partial.exec("DROP TRIGGER work_session_devin_contract_guard");
      partial.exec("PRAGMA ignore_check_constraints=ON");
      partial.query(
        "UPDATE sessions SET provider_v39='devin',preset_contract=? WHERE id=?",
      ).run(legacyPresetContract, session.id);
      partial.exec(`
        PRAGMA ignore_check_constraints=OFF;
        DELETE FROM migrations WHERE version IN (39,40,41);
        PRAGMA user_version=38;
      `);
    } finally {
      partial.close(false);
    }

    expect(() => new StateStore(paths))
      .toThrow("STATE_SCHEMA_V39_DEVIN_PRESET_CONTRACT_INVALID:sessions");

    const inspector = new Database(paths.database, { readonly: true, strict: true });
    try {
      expect(inspector.query("PRAGMA user_version").get()).toEqual({ user_version: 38 });
      expect(inspector.query(
        "SELECT provider_v39,preset_contract FROM sessions WHERE id=?",
      ).get(session.id)).toEqual({
        provider_v39: "devin",
        preset_contract: legacyPresetContract,
      });
      expect(inspector.query("SELECT version FROM migrations WHERE version=39").get()).toBeNull();
    } finally {
      inspector.close(false);
    }
  });

  test("pre-applies v38 preset contracts before replaying the current work schema from v25", async () => {
    const { store } = await fixture();
    const profile = store.createProfile("Pre-v26 preset contract");
    const session = store.createSession({
      profileId: profile.id,
      preset: "high",
      fastEnabled: false,
    });
    const paths = store.paths;
    store.close();
    stores.splice(stores.indexOf(store), 1);

    const legacy = new Database(paths.database, { create: false, strict: true });
    for (const trigger of [
      "work_attempt_route_guard",
      "work_devin_preset_contract_guard",
      "work_profile_attempt_authority_guard",
      "work_session_attempt_authority_guard",
      "work_session_devin_contract_guard",
      "work_signal_member_guard",
      "works_identity_immutable",
    ] as const) legacy.exec(`DROP TRIGGER IF EXISTS ${trigger}`);
    // Keep each ALTER separate: Bun's multi-statement exec can continue past
    // an intermediate schema error, which would leave this fixture current.
    legacy.exec("ALTER TABLE works DROP COLUMN preset_contract");
    legacy.exec("ALTER TABLE sessions DROP COLUMN provider_v39");
    legacy.exec("ALTER TABLE sessions DROP COLUMN preset_contract");
    expect(legacy.query("PRAGMA table_info(sessions)").all())
      .not.toContainEqual(expect.objectContaining({ name: "preset_contract" }));
    expect(legacy.query("PRAGMA table_info(sessions)").all())
      .not.toContainEqual(expect.objectContaining({ name: "provider_v39" }));
    legacy.exec("DELETE FROM migrations WHERE version > 25; PRAGMA user_version=25;");
    legacy.close(false);

    const migrated = new StateStore(paths, { now: () => 5_000 });
    stores.push(migrated);
    expect(migrated.requireSessionPresetRequirement(session.id)).toEqual({
      preset: "high",
      requirement: { model: "gpt-5.6-sol", effort: "max" },
    });
    const inspector = new Database(paths.database, { readonly: true, strict: true });
    try {
      expect(inspector.query("PRAGMA table_info(sessions)").all())
        .toContainEqual(expect.objectContaining({ name: "preset_contract", notnull: 1 }));
      expect(inspector.query("PRAGMA table_info(works)").all())
        .toContainEqual(expect.objectContaining({ name: "preset_contract", notnull: 1 }));
      expect(inspector.query("SELECT preset_contract FROM sessions WHERE id=?").get(session.id))
        .toEqual({ preset_contract: legacyPresetContract });
      expect(inspector.query("PRAGMA user_version").get()).toEqual({ user_version: 41 });
      expect(inspector.query("SELECT version FROM migrations WHERE version=38").get())
        .toEqual({ version: 38 });
      expect(inspector.query("SELECT version FROM migrations WHERE version=39").get())
        .toEqual({ version: 39 });
    } finally {
      inspector.close(false);
    }
  });

  test("captures the fresh notification-hours default from the machine zone exactly once", async () => {
    const home = await realpath(await mkdtemp(join(tmpdir(), "hra-hours-fresh-")));
    const paths = resolveStatePaths({ homeDirectory: home, platform: "darwin" });
    await initializeStatePaths(paths);
    let resolutions = 0;
    const store = new StateStore(paths, {
      now: () => 4_000,
      resolveMachineTimeZone: () => {
        resolutions += 1;
        return "america/puerto_rico";
      },
    });
    stores.push(store);
    expect(store.readNotificationHours()).toEqual({
      version: 1,
      revision: 1,
      startMinute: 600,
      endMinute: 1_320,
      timeZone: "America/Puerto_Rico",
    });
    expect(store.readNotificationEmailPolicy()).toEqual({
      enabled: false,
      revision: 1,
      version: 1,
    });
    expect(resolutions).toBe(1);

    const inspector = new Database(paths.database, { readonly: true, strict: true });
    try {
      expect(inspector.query(
        `SELECT singleton,version,revision,start_minute,end_minute,time_zone,created_at,updated_at
         FROM notification_hours`,
      ).get()).toEqual({
        singleton: 1,
        version: 1,
        revision: 1,
        start_minute: 600,
        end_minute: 1_320,
        time_zone: "America/Puerto_Rico",
        created_at: 4_000,
        updated_at: 4_000,
      });
      expect(inspector.query(
        `SELECT singleton,version,enabled,revision,created_at,updated_at
         FROM attention_email_policy`,
      ).get()).toEqual({
        singleton: 1,
        version: 1,
        enabled: 0,
        revision: 1,
        created_at: 4_000,
        updated_at: 4_000,
      });
    } finally {
      inspector.close(false);
    }
  });

  test("migrates populated main-v35 provider-switch evidence to v39 without rewriting it", async () => {
    const { store } = await fixture();
    const profile = signInProfile(store, "Main v35", "main-v35@example.com");
    const session = store.createSession({
      profileId: profile.id,
      preset: "high",
      fastEnabled: false,
    });
    const attempt = store.prepareMutation({
      authorityGeneration: profile.processGeneration,
      authorityId: session.id,
      idempotencyKey: "00000000-0000-4000-8000-000000000735",
      kind: "session.switch",
      request: { preset: "fable-max", provider: "claude" },
    });
    const paths = store.paths;
    store.close();
    stores.splice(stores.indexOf(store), 1);

    const mainV35 = new Database(paths.database, { create: false, strict: true });
    mainV35.query(
      `INSERT INTO session_provider_switch_targets(attempt_id,provider_thread_id,recorded_at)
       VALUES (?,?,?)`,
    ).run(attempt.id, "retained-provider-thread", 7_350);
    mainV35.exec(`
      DROP TABLE attention_email_policy;
      DROP TABLE notification_hours;
      DELETE FROM migrations WHERE version IN (36,37,38,39,40,41);
      PRAGMA user_version=35;
    `);
    mainV35.close(false);

    expect(() => new StateStore(paths, { readonly: true }))
      .toThrow("STATE_SCHEMA_MIGRATION_REQUIRED:35:41");
    const migrated = new StateStore(paths, {
      now: () => 8_000,
      resolveMachineTimeZone: () => "UTC",
    });
    stores.push(migrated);
    expect(migrated.readNotificationHours()).toMatchObject({ revision: 1, timeZone: "UTC" });
    expect(migrated.readNotificationEmailPolicy()).toEqual({
      enabled: false,
      revision: 1,
      version: 1,
    });
    const inspector = new Database(paths.database, { readonly: true, strict: true });
    try {
      expect(inspector.query("PRAGMA user_version").get()).toEqual({ user_version: 41 });
      expect(inspector.query(
        "SELECT provider_thread_id,recorded_at FROM session_provider_switch_targets WHERE attempt_id=?",
      ).get(attempt.id)).toEqual({
        provider_thread_id: "retained-provider-thread",
        recorded_at: 7_350,
      });
      expect(inspector.query(
        "SELECT version FROM migrations WHERE version BETWEEN 35 AND 41 ORDER BY version",
      ).all()).toEqual([
        { version: 35 },
        { version: 36 },
        { version: 37 },
        { version: 38 },
        { version: 39 },
        { version: 40 },
        { version: 41 },
      ]);
    } finally {
      inspector.close(false);
    }
  });

  test("converges an exact legacy feature-v35 hours authority without resolving the zone", async () => {
    const { store } = await fixture();
    expect(store.updateNotificationHours({
      expectedRevision: 1,
      version: 1,
      startMinute: 480,
      endMinute: 1_200,
      timeZone: "UTC",
    }).revision).toBe(2);
    const paths = store.paths;
    store.close();
    stores.splice(stores.indexOf(store), 1);

    const legacy = new Database(paths.database, { create: false, strict: true });
    dropProviderAuthorityObjectsForLegacyFeatureFixture(legacy);
    legacy.exec(`
      DROP TABLE attention_email_policy;
      DELETE FROM migrations WHERE version IN (36,37,38,39,40,41);
      PRAGMA user_version=35;
    `);
    expect(providerSwitchSchemaObjectCount(legacy)).toBe(0);
    legacy.close(false);

    expect(() => new StateStore(paths, { readonly: true }))
      .toThrow("STATE_SCHEMA_MIGRATION_REQUIRED:35:41");
    const migrated = new StateStore(paths, {
      now: () => 9_000,
      resolveMachineTimeZone: () => {
        throw new Error("LEGACY_V35_MUST_RETAIN_ITS_ZONE");
      },
    });
    stores.push(migrated);
    expect(migrated.readNotificationEmailPolicy()).toEqual({
      enabled: false,
      revision: 2,
      version: 1,
    });
    expect(migrated.readNotificationHours()).toMatchObject({
      revision: 2,
      startMinute: 480,
      endMinute: 1_200,
      timeZone: "UTC",
    });
    const inspector = new Database(paths.database, { readonly: true, strict: true });
    try {
      expect(providerSwitchSchemaObjectCount(inspector)).toBe(32);
      expect(inspector.query("PRAGMA user_version").get()).toEqual({ user_version: 41 });
    } finally {
      inspector.close(false);
    }
  });

  test("refuses an enabled email lookalike under canonical v36 and rolls back", async () => {
    const { store } = await fixture();
    expect(store.updateNotificationEmailPolicy({
      enabled: true,
      expectedRevision: 1,
    }).enabled).toBe(true);
    const paths = store.paths;
    store.close();
    stores.splice(stores.indexOf(store), 1);

    const legacy = new Database(paths.database, { create: false, strict: true });
    legacy.exec(`
      DELETE FROM migrations WHERE version IN (37,38,39,40,41);
      PRAGMA user_version=36;
    `);
    legacy.close(false);

    expect(() => new StateStore(paths, { readonly: true }))
      .toThrow("STATE_SCHEMA_MIGRATION_REQUIRED:36:41");

    expect(() => new StateStore(paths))
      .toThrow("ATTENTION_EMAIL_POLICY_MIGRATION_OPT_IN_REFUSED");
    const unchanged = new Database(paths.database, { readonly: true, strict: true });
    try {
      expect(unchanged.query("PRAGMA user_version").get())
        .toEqual({ user_version: 36 });
      expect(unchanged.query("SELECT version FROM migrations WHERE version=37").get())
        .toBeNull();
      expect(unchanged.query(
        "SELECT enabled,revision FROM attention_email_policy WHERE singleton=1",
      ).get()).toEqual({ enabled: 1, revision: 2 });
    } finally {
      unchanged.close(false);
    }
  });

  test("preserves an exact legacy feature-v36 explicit email opt-in", async () => {
    const { store } = await fixture();
    expect(store.updateNotificationHours({
      expectedRevision: 1,
      version: 1,
      startMinute: 420,
      endMinute: 1_260,
      timeZone: "Asia/Tokyo",
    }).revision).toBe(2);
    expect(store.updateNotificationEmailPolicy({
      enabled: true,
      expectedRevision: 2,
    })).toEqual({ enabled: true, revision: 3, version: 1 });
    const paths = store.paths;
    store.close();
    stores.splice(stores.indexOf(store), 1);

    const legacy = new Database(paths.database, { create: false, strict: true });
    dropProviderAuthorityObjectsForLegacyFeatureFixture(legacy);
    legacy.exec("DELETE FROM migrations WHERE version IN (37,38,39,40,41); PRAGMA user_version=36;");
    const before = legacy.query(
      `SELECT h.start_minute,h.end_minute,h.time_zone,h.revision AS hours_revision,
              e.enabled,e.revision AS email_revision,e.created_at,e.updated_at
       FROM notification_hours h JOIN attention_email_policy e ON h.singleton=e.singleton`,
    ).get();
    expect(providerSwitchSchemaObjectCount(legacy)).toBe(0);
    legacy.close(false);

    expect(() => new StateStore(paths, { readonly: true }))
      .toThrow("STATE_SCHEMA_MIGRATION_REQUIRED:36:41");
    const migrated = new StateStore(paths, {
      now: () => 12_000,
      resolveMachineTimeZone: () => {
        throw new Error("LEGACY_V36_MUST_RETAIN_ITS_ZONE");
      },
    });
    stores.push(migrated);
    expect(migrated.readNotificationHours()).toEqual({
      version: 1,
      revision: 3,
      startMinute: 420,
      endMinute: 1_260,
      timeZone: "Asia/Tokyo",
    });
    expect(migrated.readNotificationEmailPolicy()).toEqual({
      enabled: true,
      revision: 3,
      version: 1,
    });
    const inspector = new Database(paths.database, { readonly: true, strict: true });
    try {
      expect(inspector.query(
        `SELECT h.start_minute,h.end_minute,h.time_zone,h.revision AS hours_revision,
                e.enabled,e.revision AS email_revision,e.created_at,e.updated_at
         FROM notification_hours h JOIN attention_email_policy e ON h.singleton=e.singleton`,
      ).get()).toEqual(before);
      expect(providerSwitchSchemaObjectCount(inspector)).toBe(32);
      expect(inspector.query("PRAGMA user_version").get()).toEqual({ user_version: 41 });
    } finally {
      inspector.close(false);
    }
  });

  test("rejects a legacy-v36 lookalike with an extra policy object and rolls back", async () => {
    const { store } = await fixture();
    expect(store.updateNotificationEmailPolicy({
      enabled: true,
      expectedRevision: 1,
    }).enabled).toBe(true);
    const paths = store.paths;
    store.close();
    stores.splice(stores.indexOf(store), 1);

    const lookalike = new Database(paths.database, { create: false, strict: true });
    dropProviderAuthorityObjectsForLegacyFeatureFixture(lookalike);
    lookalike.exec(`
      CREATE INDEX attention_email_policy_untrusted ON attention_email_policy(enabled);
      DELETE FROM migrations WHERE version IN (37,38,39,40,41);
      PRAGMA user_version=36;
    `);
    lookalike.close(false);

    expect(() => new StateStore(paths))
      .toThrow("ATTENTION_EMAIL_POLICY_MIGRATION_OPT_IN_REFUSED");
    const unchanged = new Database(paths.database, { readonly: true, strict: true });
    try {
      expect(unchanged.query("PRAGMA user_version").get()).toEqual({ user_version: 36 });
      expect(unchanged.query("SELECT version FROM migrations WHERE version=37").get())
        .toBeNull();
      expect(providerSwitchSchemaObjectCount(unchanged)).toBe(0);
      expect(unchanged.query(
        "SELECT name FROM sqlite_master WHERE name='attention_email_policy_untrusted'",
      ).get()).toEqual({ name: "attention_email_policy_untrusted" });
    } finally {
      unchanged.close(false);
    }
  });

  test("shares one immediate CAS revision across email opt-in and hours", async () => {
    const { store } = await fixture();
    const contender = new StateStore(store.paths, {
      now: () => 3_000,
      resolveMachineTimeZone: () => {
        throw new Error("CURRENT_SCHEMA_MUST_NOT_RESOLVE_MACHINE_ZONE");
      },
    });
    stores.push(contender);

    expect(store.updateNotificationEmailPolicy({
      enabled: true,
      expectedRevision: 1,
    })).toEqual({ enabled: true, revision: 2, version: 1 });
    expect(store.readNotificationHours()).toMatchObject({ revision: 2 });
    expect(() => contender.updateNotificationHours({
      expectedRevision: 1,
      version: 1,
      startMinute: 0,
      endMinute: 60,
      timeZone: "UTC",
    })).toThrow("NOTIFICATION_HOURS_REVISION_CONFLICT");
    expect(store.updateNotificationHours({
      expectedRevision: 2,
      version: 1,
      startMinute: 0,
      endMinute: 60,
      timeZone: "UTC",
    })).toMatchObject({ revision: 3 });
    expect(store.readNotificationEmailPolicy()).toEqual({
      enabled: true,
      revision: 3,
      version: 1,
    });
    expect(store.updateNotificationEmailPolicy({
      enabled: false,
      expectedRevision: 3,
    })).toEqual({ enabled: false, revision: 4, version: 1 });
    expect(store.readNotificationHours()).toMatchObject({ revision: 4 });
    const inspector = new Database(store.paths.database, { create: false, strict: true });
    try {
      expect(inspector.query(
        `SELECT h.revision AS hours_revision,e.revision AS email_revision,e.enabled
         FROM notification_hours h JOIN attention_email_policy e
         ON h.singleton=e.singleton`,
      ).get()).toEqual({ hours_revision: 4, email_revision: 4, enabled: 0 });
      expect(() => inspector.query(
        "UPDATE attention_email_policy SET enabled=1 WHERE singleton=1",
      ).run()).toThrow("invalid attention email policy transition");
      expect(() => inspector.query(
        "DELETE FROM attention_email_policy WHERE singleton=1",
      ).run()).toThrow("attention email policy cannot be deleted");
      expect(() => inspector.query(
        `INSERT OR REPLACE INTO attention_email_policy(
           singleton,version,enabled,revision,created_at,updated_at
         ) VALUES (1,1,0,1,1,1)`,
      ).run()).toThrow("attention email policy already exists");
    } finally {
      inspector.close(false);
    }
  });

  test("fails closed when the composite notification revision diverges", async () => {
    const { store } = await fixture();
    const paths = store.paths;
    store.close();
    stores.splice(stores.indexOf(store), 1);
    const tampered = new Database(paths.database, { create: false, strict: true });
    tampered.query(
      `UPDATE attention_email_policy
       SET revision=revision+1,updated_at=updated_at+1 WHERE singleton=1`,
    ).run();
    tampered.close(false);

    expect(() => new StateStore(paths, { readonly: true }))
      .toThrow("NOTIFICATION_POLICY_REVISION_DIVERGED");
    expect(() => new StateStore(paths))
      .toThrow("NOTIFICATION_POLICY_REVISION_DIVERGED");
  });

  test("migrates a populated v34 database once and preserves its authority", async () => {
    const { store } = await fixture();
    const profile = store.createProfile("V34 retained");
    const paths = store.paths;
    store.close();
    stores.splice(stores.indexOf(store), 1);

    const legacy = new Database(paths.database, { create: false, strict: true });
    dropProviderAuthorityObjectsForLegacyFeatureFixture(legacy);
    legacy.exec(`
      DROP TABLE attention_email_policy;
      DROP TABLE notification_hours;
      DELETE FROM migrations WHERE version BETWEEN 35 AND 41;
      PRAGMA user_version=34;
    `);
    legacy.close(false);

    expect(() => new StateStore(paths, { readonly: true }))
      .toThrow("STATE_SCHEMA_MIGRATION_REQUIRED:34:41");
    const unchanged = new Database(paths.database, { readonly: true, strict: true });
    try {
      expect(unchanged.query("PRAGMA user_version").get()).toEqual({ user_version: 34 });
      expect(unchanged.query(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name='notification_hours'",
      ).get()).toBeNull();
    } finally {
      unchanged.close(false);
    }

    let resolutions = 0;
    const migrated = new StateStore(paths, {
      now: () => 5_000,
      resolveMachineTimeZone: () => {
        resolutions += 1;
        return "Asia/Tokyo";
      },
    });
    stores.push(migrated);
    expect(migrated.requireProfile(profile.id)).toMatchObject({
      id: profile.id,
      label: "V34 retained",
    });
    expect(migrated.readNotificationHours()).toEqual({
      version: 1,
      revision: 1,
      startMinute: 600,
      endMinute: 1_320,
      timeZone: "Asia/Tokyo",
    });
    expect(resolutions).toBe(1);
    migrated.close();
    stores.splice(stores.indexOf(migrated), 1);

    const reopened = new StateStore(paths, {
      now: () => 6_000,
      resolveMachineTimeZone: () => {
        throw new Error("CURRENT_SCHEMA_MUST_NOT_RESOLVE_MACHINE_ZONE");
      },
    });
    stores.push(reopened);
    expect(reopened.readNotificationHours().timeZone).toBe("Asia/Tokyo");
    expect(reopened.requireProfile(profile.id).label).toBe("V34 retained");
    reopened.close();
    stores.splice(stores.indexOf(reopened), 1);

    const readonly = new StateStore(paths, {
      readonly: true,
      resolveMachineTimeZone: () => {
        throw new Error("READONLY_CURRENT_SCHEMA_MUST_NOT_RESOLVE_MACHINE_ZONE");
      },
    });
    stores.push(readonly);
    expect(readonly.readNotificationHours().timeZone).toBe("Asia/Tokyo");
    const schemaInspector = new Database(paths.database, { readonly: true, strict: true });
    try {
      expect(providerSwitchSchemaObjectCount(schemaInspector)).toBe(32);
      expect(schemaInspector.query("PRAGMA user_version").get()).toEqual({ user_version: 41 });
    } finally {
      schemaInspector.close(false);
    }
  });

  test("rolls a failed v34 notification-hours migration back without a UTC fallback", async () => {
    const { store } = await fixture();
    const paths = store.paths;
    store.close();
    stores.splice(stores.indexOf(store), 1);
    const legacy = new Database(paths.database, { create: false, strict: true });
    dropProviderAuthorityObjectsForLegacyFeatureFixture(legacy);
    legacy.exec(`
      DROP TABLE attention_email_policy;
      DROP TABLE notification_hours;
      DELETE FROM migrations WHERE version BETWEEN 35 AND 41;
      PRAGMA user_version=34;
    `);
    legacy.close(false);

    expect(() => new StateStore(paths, {
      now: () => 7_000,
      resolveMachineTimeZone: () => "+00:00",
    })).toThrow();
    const inspector = new Database(paths.database, { readonly: true, strict: true });
    try {
      expect(inspector.query("PRAGMA user_version").get()).toEqual({ user_version: 34 });
      expect(inspector.query(
        "SELECT 1 FROM migrations WHERE version=35",
      ).get()).toBeNull();
      expect(inspector.query(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name='notification_hours'",
      ).get()).toBeNull();
      expect(providerSwitchSchemaObjectCount(inspector)).toBe(0);
    } finally {
      inspector.close(false);
    }

    const recovered = new StateStore(paths, {
      now: () => 8_000,
      resolveMachineTimeZone: () => "UTC",
    });
    stores.push(recovered);
    expect(recovered.readNotificationHours()).toMatchObject({
      revision: 1,
      timeZone: "UTC",
    });
  });

  test("updates notification hours by independent revision CAS across clock rollback", async () => {
    const home = await realpath(await mkdtemp(join(tmpdir(), "hra-hours-cas-")));
    const paths = resolveStatePaths({ homeDirectory: home, platform: "darwin" });
    await initializeStatePaths(paths);
    let now = 10_000;
    const store = new StateStore(paths, {
      now: () => now,
      resolveMachineTimeZone: () => "UTC",
    });
    stores.push(store);
    const contender = new StateStore(paths, {
      now: () => 13_000,
      resolveMachineTimeZone: () => {
        throw new Error("CURRENT_SCHEMA_MUST_NOT_RESOLVE_MACHINE_ZONE");
      },
    });
    stores.push(contender);

    now = 12_000;
    expect(store.updateNotificationHours({
      expectedRevision: 1,
      version: 1,
      startMinute: 1_320,
      endMinute: 600,
      timeZone: "asia/tokyo",
    })).toEqual({
      version: 1,
      revision: 2,
      startMinute: 1_320,
      endMinute: 600,
      timeZone: "Asia/Tokyo",
    });
    store.setDefaultShowThinking(true);
    expect(store.readNotificationHours().revision).toBe(2);
    expect(() => contender.updateNotificationHours({
      expectedRevision: 1,
      version: 1,
      startMinute: 0,
      endMinute: 60,
      timeZone: "UTC",
    })).toThrow("NOTIFICATION_HOURS_REVISION_CONFLICT");
    expect(() => store.updateNotificationHours({
      expectedRevision: 2,
      version: 1,
      startMinute: 60,
      endMinute: 60,
      timeZone: "UTC",
    })).toThrow();
    expect(() => store.updateNotificationHours({
      expectedRevision: 2,
      version: 1,
      startMinute: 0,
      endMinute: 60,
      timeZone: "+00:00",
    })).toThrow();
    expect(store.readNotificationHours()).toMatchObject({
      revision: 2,
      startMinute: 1_320,
      timeZone: "Asia/Tokyo",
    });

    now = 9_000;
    expect(store.updateNotificationHours({
      expectedRevision: 2,
      version: 1,
      startMinute: 0,
      endMinute: 60,
      timeZone: "UTC",
    })).toMatchObject({ revision: 3, timeZone: "UTC" });
    const inspector = new Database(paths.database, { create: false, strict: true });
    try {
      expect(inspector.query(
        "SELECT revision,created_at,updated_at FROM notification_hours WHERE singleton=1",
      ).get()).toEqual({ revision: 3, created_at: 10_000, updated_at: 12_000 });
      expect(() => inspector.query(
        `INSERT OR REPLACE INTO notification_hours(
           singleton,version,revision,start_minute,end_minute,time_zone,created_at,updated_at
         ) VALUES (1,1,1,600,1320,'UTC',1,1)`,
      ).run()).toThrow("notification hours already exists");
      expect(inspector.query(
        "SELECT revision,created_at,updated_at FROM notification_hours WHERE singleton=1",
      ).get()).toEqual({ revision: 3, created_at: 10_000, updated_at: 12_000 });
      expect(() => inspector.query(
        "UPDATE notification_hours SET start_minute=120 WHERE singleton=1",
      ).run()).toThrow("invalid notification hours transition");
      expect(() => inspector.query(
        "DELETE FROM notification_hours WHERE singleton=1",
      ).run()).toThrow("notification hours cannot be deleted");
    } finally {
      inspector.close(false);
    }
  });

  test("refuses notification-hours revision exhaustion", async () => {
    const { store } = await fixture();
    const paths = store.paths;
    store.close();
    stores.splice(stores.indexOf(store), 1);
    const authority = new Database(paths.database, { create: false, strict: true });
    authority.exec(`
      DROP TRIGGER notification_hours_update_guard;
      DROP TRIGGER attention_email_policy_update_guard;
      UPDATE notification_hours
      SET revision=9007199254740991
      WHERE singleton=1;
      UPDATE attention_email_policy
      SET revision=9007199254740991
      WHERE singleton=1;
    `);
    authority.close(false);

    const reopened = new StateStore(paths, {
      now: () => 20_000,
      resolveMachineTimeZone: () => {
        throw new Error("CURRENT_SCHEMA_MUST_NOT_RESOLVE_MACHINE_ZONE");
      },
    });
    stores.push(reopened);
    expect(() => reopened.updateNotificationHours({
      expectedRevision: Number.MAX_SAFE_INTEGER,
      version: 1,
      startMinute: 0,
      endMinute: 60,
      timeZone: "UTC",
    })).toThrow("NOTIFICATION_HOURS_REVISION_EXHAUSTED");
    expect(() => reopened.updateNotificationEmailPolicy({
      enabled: true,
      expectedRevision: Number.MAX_SAFE_INTEGER,
    })).toThrow("ATTENTION_EMAIL_POLICY_REVISION_EXHAUSTED");
    expect(reopened.readNotificationHours().revision).toBe(Number.MAX_SAFE_INTEGER);
    expect(reopened.readNotificationEmailPolicy().revision)
      .toBe(Number.MAX_SAFE_INTEGER);
  });

  test("refuses missing and noncanonical notification-hours authority", async () => {
    const missingFixture = await fixture();
    const missingPaths = missingFixture.store.paths;
    missingFixture.store.close();
    stores.splice(stores.indexOf(missingFixture.store), 1);
    const missing = new Database(missingPaths.database, { create: false, strict: true });
    missing.exec(`
      DROP TRIGGER notification_hours_delete_guard;
      DELETE FROM notification_hours WHERE singleton=1;
      CREATE TRIGGER notification_hours_delete_guard
      BEFORE DELETE ON notification_hours
      BEGIN SELECT RAISE(ABORT, 'notification hours cannot be deleted'); END;
    `);
    missing.close(false);
    expect(() => new StateStore(missingPaths, { readonly: true }))
      .toThrow("NOTIFICATION_HOURS_POLICY_MISSING");
    expect(() => new StateStore(missingPaths, {
      resolveMachineTimeZone: () => "UTC",
    })).toThrow("NOTIFICATION_HOURS_POLICY_MISSING");

    const corruptFixture = await fixture();
    const corruptPaths = corruptFixture.store.paths;
    corruptFixture.store.close();
    stores.splice(stores.indexOf(corruptFixture.store), 1);
    const corrupt = new Database(corruptPaths.database, { create: false, strict: true });
    corrupt.exec(`
      DROP TRIGGER notification_hours_update_guard;
      UPDATE notification_hours
      SET revision=revision+1,time_zone='america/puerto_rico'
      WHERE singleton=1;
      CREATE TRIGGER notification_hours_update_guard
      BEFORE UPDATE ON notification_hours
      WHEN NEW.singleton != OLD.singleton
        OR NEW.version != OLD.version
        OR NEW.created_at != OLD.created_at
        OR NEW.revision != OLD.revision + 1
        OR NEW.updated_at < OLD.updated_at
      BEGIN SELECT RAISE(ABORT, 'invalid notification hours transition'); END;
    `);
    corrupt.close(false);
    expect(() => new StateStore(corruptPaths, { readonly: true }))
      .toThrow("NOTIFICATION_HOURS_POLICY_INVALID");
    expect(() => new StateStore(corruptPaths, {
      resolveMachineTimeZone: () => "UTC",
    })).toThrow("NOTIFICATION_HOURS_POLICY_INVALID");

    const weakenedFixture = await fixture();
    const weakenedPaths = weakenedFixture.store.paths;
    weakenedFixture.store.close();
    stores.splice(stores.indexOf(weakenedFixture.store), 1);
    const weakened = new Database(weakenedPaths.database, { create: false, strict: true });
    weakened.exec(`
      DROP TRIGGER notification_hours_update_guard;
      CREATE TRIGGER notification_hours_update_guard
      BEFORE UPDATE ON notification_hours
      BEGIN SELECT 1; END;
      UPDATE notification_hours SET start_minute=601 WHERE singleton=1;
    `);
    weakened.close(false);
    expect(() => new StateStore(weakenedPaths, { readonly: true }))
      .toThrow("STATE_SCHEMA_V36_NOTIFICATION_HOURS_STRUCTURE_INVALID");
    expect(() => new StateStore(weakenedPaths, {
      resolveMachineTimeZone: () => "UTC",
    })).toThrow("STATE_SCHEMA_V36_NOTIFICATION_HOURS_STRUCTURE_INVALID");

    const weakenedInsertFixture = await fixture();
    const weakenedInsertPaths = weakenedInsertFixture.store.paths;
    weakenedInsertFixture.store.close();
    stores.splice(stores.indexOf(weakenedInsertFixture.store), 1);
    const weakenedInsert = new Database(
      weakenedInsertPaths.database,
      { create: false, strict: true },
    );
    weakenedInsert.exec(`
      DROP TRIGGER notification_hours_insert_guard;
      CREATE TRIGGER notification_hours_insert_guard
      BEFORE INSERT ON notification_hours
      BEGIN SELECT 1; END;
    `);
    weakenedInsert.close(false);
    expect(() => new StateStore(weakenedInsertPaths, { readonly: true }))
      .toThrow("STATE_SCHEMA_V36_NOTIFICATION_HOURS_STRUCTURE_INVALID");
    expect(() => new StateStore(weakenedInsertPaths, {
      resolveMachineTimeZone: () => "UTC",
    })).toThrow("STATE_SCHEMA_V36_NOTIFICATION_HOURS_STRUCTURE_INVALID");
  });

  test("heals a v30 work schema before rebuilding the legacy autorespond table", async () => {
    const { store } = await fixture();
    const paths = store.paths;
    store.close();
    stores.splice(stores.indexOf(store), 1);

    const legacy = new Database(paths.database, { create: false, strict: true });
    try {
      legacy.exec(`
        DROP TRIGGER work_attempt_route_guard;
        DROP TRIGGER work_session_attempt_authority_guard;
        DROP TRIGGER work_profile_attempt_authority_guard;
        DROP TRIGGER work_signal_member_guard;
        ALTER TABLE sessions DROP COLUMN provider;
        DROP TABLE autorespond_evidence;
        CREATE TABLE autorespond_evidence (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
          interaction_id TEXT NOT NULL CHECK(length(interaction_id) = 36),
          kind TEXT NOT NULL CHECK(kind IN (
            'command_approval','file_change_approval','permission_approval'
          )),
          class TEXT NOT NULL CHECK(length(class) BETWEEN 1 AND 256),
          decision TEXT NOT NULL CHECK(length(decision) BETWEEN 1 AND 64),
          mode TEXT NOT NULL CHECK(mode IN ('auto:all','auto:workspace','manual')),
          outcome TEXT NOT NULL CHECK(outcome IN ('accepted','refused')),
          latency_ms INTEGER NOT NULL CHECK(latency_ms >= 0),
          subagent INTEGER NOT NULL CHECK(subagent IN (0,1)),
          occurred_at INTEGER NOT NULL CHECK(occurred_at >= 0)
        ) STRICT;
        CREATE INDEX autorespond_evidence_session
          ON autorespond_evidence(session_id, occurred_at DESC, id DESC);
        CREATE INDEX autorespond_evidence_recent
          ON autorespond_evidence(occurred_at DESC, id DESC);
      `);
      // SQLite accepts trigger definitions that reference a missing column.
      // The next schema rewrite must not be the first operation to discover it.
      legacy.exec(WORK_SCHEMA_SQL);
      legacy.exec("DELETE FROM migrations WHERE version>30; PRAGMA user_version=30;");
      expect(legacy.query("PRAGMA user_version").get()).toEqual({ user_version: 30 });
      expect(legacy.query("PRAGMA table_info(sessions)").all())
        .not.toContainEqual(expect.objectContaining({ name: "provider" }));
      expect(legacy.query("PRAGMA table_info(autorespond_evidence)").all())
        .not.toContainEqual(expect.objectContaining({ name: "path" }));
    } finally {
      legacy.close(false);
    }

    const migrated = new StateStore(paths, { now: () => 2_000 });
    stores.push(migrated);
    const inspector = new Database(paths.database, { readonly: true, strict: true });
    try {
      expect(inspector.query("PRAGMA user_version").get()).toEqual({ user_version: 41 });
      expect(inspector.query("PRAGMA table_info(sessions)").all())
        .toContainEqual(expect.objectContaining({ name: "provider", dflt_value: "'codex'" }));
      expect(inspector.query("PRAGMA table_info(autorespond_evidence)").all())
        .toContainEqual(expect.objectContaining({ name: "path" }));
      expect(inspector.query(
        "SELECT version FROM migrations WHERE version BETWEEN 30 AND 41 ORDER BY version",
      ).all()).toEqual([
        { version: 30 },
        { version: 31 },
        { version: 32 },
        { version: 33 },
        { version: 34 },
        { version: 35 },
        { version: 36 },
        { version: 37 },
        { version: 38 },
        { version: 39 },
        { version: 40 },
        { version: 41 },
      ]);
    } finally {
      inspector.close(false);
    }
  });

  test("readonly open rejects a missing v35 object", async () => {
    const { store } = await fixture();
    const paths = store.paths;
    store.close();
    stores.splice(stores.indexOf(store), 1);
    const damaged = new Database(paths.database, { create: false, strict: true });
    try {
      damaged.exec("DROP TRIGGER session_provider_switch_targets_immutable_delete");
    } finally {
      damaged.close(false);
    }

    expect(() => new StateStore(paths, { readonly: true }))
      .toThrow("STATE_SCHEMA_V35_OBJECT_MISSING:session_provider_switch_targets_immutable_delete");
  });

  test("writable open repairs a missing additive v35 object", async () => {
    const { store } = await fixture();
    const paths = store.paths;
    store.close();
    stores.splice(stores.indexOf(store), 1);
    const damaged = new Database(paths.database, { create: false, strict: true });
    try {
      damaged.exec("DROP TABLE session_provider_switch_target_releases");
    } finally {
      damaged.close(false);
    }

    const repaired = new StateStore(paths, { now: () => 2_000 });
    stores.push(repaired);
    const inspector = new Database(paths.database, { readonly: true, strict: true });
    try {
      expect(inspector.query(
        `SELECT name,type,tbl_name FROM sqlite_master
         WHERE name='session_provider_switch_target_releases'
            OR name LIKE 'session_provider_switch_target_releases_immutable_%'
         ORDER BY type,name`,
      ).all()).toEqual([
        {
          name: "session_provider_switch_target_releases",
          tbl_name: "session_provider_switch_target_releases",
          type: "table",
        },
        {
          name: "session_provider_switch_target_releases_immutable_delete",
          tbl_name: "session_provider_switch_target_releases",
          type: "trigger",
        },
        {
          name: "session_provider_switch_target_releases_immutable_update",
          tbl_name: "session_provider_switch_target_releases",
          type: "trigger",
        },
      ]);
    } finally {
      inspector.close(false);
    }
  });

  test("rejects a same-name no-op v35 immutable trigger as invalid", async () => {
    const { store } = await fixture();
    const paths = store.paths;
    store.close();
    stores.splice(stores.indexOf(store), 1);
    const damaged = new Database(paths.database, { create: false, strict: true });
    try {
      damaged.exec(`
        DROP TRIGGER session_mutation_authority_rebinds_immutable_update;
        CREATE TRIGGER session_mutation_authority_rebinds_immutable_update
        BEFORE UPDATE ON session_mutation_authority_rebinds
        BEGIN SELECT 1; END;
      `);
    } finally {
      damaged.close(false);
    }

    expect(() => new StateStore(paths, { now: () => 2_000 }))
      .toThrow("STATE_SCHEMA_V35_OBJECT_INVALID:session_mutation_authority_rebinds_immutable_update");
  });

  test("rejects a same-name v35 immutable trigger attached to the wrong table", async () => {
    const { store } = await fixture();
    const paths = store.paths;
    store.close();
    stores.splice(stores.indexOf(store), 1);
    const damaged = new Database(paths.database, { create: false, strict: true });
    try {
      damaged.exec(`
        DROP TRIGGER session_provider_switch_targets_immutable_delete;
        CREATE TRIGGER session_provider_switch_targets_immutable_delete
        BEFORE DELETE ON session_provider_switch_seed_intents
        BEGIN SELECT RAISE(ABORT, 'session provider switch target is immutable'); END;
      `);
    } finally {
      damaged.close(false);
    }

    expect(() => new StateStore(paths, { readonly: true }))
      .toThrow("STATE_SCHEMA_V35_OBJECT_INVALID:session_provider_switch_targets_immutable_delete");
  });


  test("repairs a same-name nonunique v24 Unicode label index while readonly refuses it", async () => {
    const { store } = await fixture();
    const paths = store.paths;
    store.createProfile("Équipe");
    store.close();
    stores.splice(stores.indexOf(store), 1);

    const stale = new Database(paths.database, { create: false, strict: true });
    stale.exec(`
      DROP INDEX profiles_label_key_active;
      CREATE INDEX profiles_label_key_active
        ON profiles(label_key) WHERE state!='removed';
    `);
    stale.close(false);

    expect(() => new StateStore(paths, { readonly: true }))
      .toThrow("STATE_SCHEMA_V24_STRUCTURE_INVALID");
    const unchanged = new Database(paths.database, { readonly: true, strict: true });
    try {
      expect(unchanged.query(
        "SELECT sql FROM sqlite_master WHERE type='index' AND name='profiles_label_key_active'",
      ).get()).toEqual({
        sql: "CREATE INDEX profiles_label_key_active\n        ON profiles(label_key) WHERE state!='removed'",
      });
    } finally {
      unchanged.close(false);
    }

    const repaired = new StateStore(paths, { now: () => 2_000 });
    stores.push(repaired);
    expect(() => repaired.createProfile("équipe")).toThrow();
    const inspector = new Database(paths.database, { readonly: true, strict: true });
    try {
      expect(inspector.query(
        `SELECT "unique" AS is_unique,partial
         FROM pragma_index_list('profiles') WHERE name='profiles_label_key_active'`,
      ).get()).toEqual({ is_unique: 1, partial: 1 });
    } finally {
      inspector.close(false);
    }
  });

  test("repairs a stale same-name v24 guard while readonly leaves it untouched", async () => {
    const { store } = await fixture();
    const paths = store.paths;
    store.close();
    stores.splice(stores.indexOf(store), 1);

    const stale = new Database(paths.database, { create: false, strict: true });
    stale.exec(`
      DROP TRIGGER profiles_label_key_insert_guard;
      CREATE TRIGGER profiles_label_key_insert_guard
      BEFORE INSERT ON profiles
      BEGIN SELECT 1; END;
    `);
    stale.close(false);

    expect(() => new StateStore(paths, { readonly: true }))
      .toThrow("STATE_SCHEMA_V24_STRUCTURE_INVALID");
    const unchanged = new Database(paths.database, { readonly: true, strict: true });
    try {
      expect(unchanged.query(
        "SELECT sql FROM sqlite_master WHERE type='trigger' AND name='profiles_label_key_insert_guard'",
      ).get()).toEqual({
        sql: "CREATE TRIGGER profiles_label_key_insert_guard\n      BEFORE INSERT ON profiles\n      BEGIN SELECT 1; END",
      });
    } finally {
      unchanged.close(false);
    }

    const repaired = new StateStore(paths, { now: () => 2_000 });
    stores.push(repaired);
    repaired.close();
    stores.splice(stores.indexOf(repaired), 1);
    const writer = new Database(paths.database, { create: false, strict: true });
    try {
      expect(() => writer.query(
        `INSERT INTO profiles(
           id,label,label_key,state,process_generation,created_at,updated_at
         ) VALUES ('acct_00000000000000000000000000000025','Unsafe',NULL,'signed_out',0,1000,1000)`,
      ).run()).toThrow("invalid profile label key");
      expect(writer.query(
        "SELECT sql FROM sqlite_master WHERE type='trigger' AND name='profiles_label_key_insert_guard'",
      ).get()).toEqual({
        sql: "CREATE TRIGGER profiles_label_key_insert_guard\nBEFORE INSERT ON profiles\nWHEN NEW.label_key IS NULL\n  OR length(CAST(NEW.label_key AS BLOB)) NOT BETWEEN 1 AND 4096\nBEGIN SELECT RAISE(ABORT, 'invalid profile label key'); END",
      });
    } finally {
      writer.close(false);
    }
  });

  test("fails closed when a v23 account state contains a Unicode label collision", async () => {
    const { store } = await fixture();
    const paths = store.paths;
    store.createProfile("Équipe");
    store.close();
    stores.splice(stores.indexOf(store), 1);

    const legacy = new Database(paths.database, { create: false, strict: true });
    legacy.exec(`
      DROP INDEX profiles_label_key_active;
      DROP TRIGGER profiles_label_key_insert_guard;
      DROP TRIGGER profiles_label_key_immutable;
      DELETE FROM migrations WHERE version=24;
      PRAGMA user_version=23;
    `);
    legacy.query(
      `INSERT INTO profiles(
         id,label,label_key,state,process_generation,created_at,updated_at
       ) VALUES (?,?,NULL,'signed_out',0,1000,1000)`,
    ).run("acct_00000000000000000000000000000024", "équipe");
    legacy.close(false);

    expect(() => new StateStore(paths, { now: () => 2_000 }))
      .toThrow("STATE_ACCOUNT_LABEL_COLLISION");
    const inspector = new Database(paths.database, { readonly: true, strict: true });
    try {
      expect(inspector.query("PRAGMA user_version").get()).toEqual({ user_version: 23 });
      expect(inspector.query("SELECT version FROM migrations WHERE version=24").get()).toBeNull();
      expect(inspector.query(
        "SELECT label_key FROM profiles WHERE id='acct_00000000000000000000000000000024'",
      ).get()).toEqual({ label_key: null });
    } finally {
      inspector.close(false);
    }
  });

  test("fails closed when a v23 project state contains canonically equivalent labels", async () => {
    const { store, home } = await fixture();
    const paths = store.paths;
    const firstRoot = join(home, "project-composed");
    const secondRoot = join(home, "project-decomposed");
    await mkdir(firstRoot);
    await mkdir(secondRoot);
    await store.createProject("Café", firstRoot);
    store.close();
    stores.splice(stores.indexOf(store), 1);

    const legacy = new Database(paths.database, { create: false, strict: true });
    legacy.exec(`
      DROP INDEX projects_label_key_unique;
      DROP TRIGGER projects_label_key_insert_guard;
      DROP TRIGGER projects_label_key_immutable;
      DELETE FROM migrations WHERE version=24;
      PRAGMA user_version=23;
    `);
    legacy.query(
      `INSERT INTO projects(
         id,label,label_key,root_path,is_default,created_at,updated_at
       ) VALUES (?,?,NULL,?,0,1000,1000)`,
    ).run("proj_00000000000000000000000000000024", "Cafe\u0301", secondRoot);
    legacy.close(false);

    expect(() => new StateStore(paths, { now: () => 2_000 }))
      .toThrow("STATE_PROJECT_LABEL_COLLISION");
    const inspector = new Database(paths.database, { readonly: true, strict: true });
    try {
      expect(inspector.query("PRAGMA user_version").get()).toEqual({ user_version: 23 });
      expect(inspector.query("SELECT version FROM migrations WHERE version=24").get()).toBeNull();
      expect(inspector.query(
        "SELECT label_key FROM projects WHERE id='proj_00000000000000000000000000000024'",
      ).get()).toEqual({ label_key: null });
    } finally {
      inspector.close(false);
    }
  });

  test("migrates v18 databases to the exact prepared-response supersession guards", async () => {
    const { store } = await fixture();
    const paths = store.paths;
    store.close();
    stores.splice(stores.indexOf(store), 1);
    const legacy = new Database(paths.database, { create: false, strict: true });
    legacy.exec(`
      DROP TRIGGER IF EXISTS provider_interactions_response_fields_guard;
      DROP TRIGGER IF EXISTS provider_interactions_revision_guard;
      DELETE FROM migrations WHERE version=19;
      PRAGMA user_version=18;
    `);
    legacy.close(false);

    const migrated = new StateStore(paths, { now: () => 9_000 });
    stores.push(migrated);
    const inspector = new Database(paths.database, { readonly: true, strict: true });
    try {
      expect(inspector.query("PRAGMA user_version").get()).toEqual({ user_version: 41 });
      expect(inspector.query(
        `SELECT name FROM sqlite_master
         WHERE type='trigger' AND name IN (
           'provider_interactions_intent_immutable',
           'provider_interactions_response_fields_guard',
           'provider_interactions_revision_guard'
         ) ORDER BY name`,
      ).all()).toEqual([
        { name: "provider_interactions_intent_immutable" },
        { name: "provider_interactions_response_fields_guard" },
        { name: "provider_interactions_revision_guard" },
      ]);
    } finally {
      inspector.close(false);
    }
  });

  test("migrates legacy approval scope booleans into exact ordered decisions", async () => {
    const { store } = await fixture();
    const profile = signInProfile(store, "Legacy approvals", "legacy-approvals@example.com");
    const session = store.createSession({ profileId: profile.id, preset: "high", fastEnabled: false });
    const connectionId = "50000000-0000-4000-8000-000000000001";
    const admit = (input: {
      publicId: string;
      method: "item/commandExecution/requestApproval" | "item/fileChange/requestApproval";
      kind: "command_approval" | "file_change_approval";
      display: Parameters<StateStore["admitInteraction"]>[0]["display"];
    }) => store.admitInteraction({
      publicId: input.publicId,
      sessionId: session.id,
      authority: {
        profileId: profile.id,
        processGeneration: profile.processGeneration,
        connectionId,
        requestId: { type: "string", value: input.publicId },
        method: input.method,
        requestDigest: input.publicId.endsWith("1") ? "1".repeat(64) : "2".repeat(64),
        threadId: "thread-legacy-approvals",
        turnId: "turn-legacy-approvals",
        itemId: input.publicId,
        approvalId: null,
      },
      kind: input.kind,
      blocking: true,
      display: input.display,
    }).record;
    const command = admit({
      publicId: "50000000-0000-4000-8000-000000000011",
      method: "item/commandExecution/requestApproval",
      kind: "command_approval",
      display: {
        kind: "command_approval",
        summary: "Allow legacy command",
        reason: null,
        commandClass: "test",
        workingDirectory: null,
        availableDecisions: ["once", "session", "decline", "cancel"],
      },
    });
    const files = admit({
      publicId: "50000000-0000-4000-8000-000000000012",
      method: "item/fileChange/requestApproval",
      kind: "file_change_approval",
      display: {
        kind: "file_change_approval",
        summary: "Allow legacy files",
        reason: null,
        grantRoot: null,
        availableDecisions: ["once", "decline", "cancel"],
      },
    });
    const paths = store.paths;
    store.close();
    stores.splice(stores.indexOf(store), 1);

    const legacy = new Database(paths.database, { create: false, strict: true });
    legacy.exec("DROP TRIGGER IF EXISTS provider_interactions_authority_immutable");
    legacy.query("UPDATE provider_interactions SET display_json=? WHERE public_id=?").run(JSON.stringify({
      kind: "command_approval",
      summary: "Allow legacy command",
      reason: null,
      commandClass: "test",
      workingDirectory: null,
      allowsSessionApproval: true,
    }), command.publicId);
    legacy.query("UPDATE provider_interactions SET display_json=? WHERE public_id=?").run(JSON.stringify({
      kind: "file_change_approval",
      summary: "Allow legacy files",
      reason: null,
      grantRoot: null,
      allowsSessionApproval: false,
    }), files.publicId);
    legacy.exec("DELETE FROM migrations WHERE version=18; PRAGMA user_version=17");
    legacy.close(false);

    const migrated = new StateStore(paths, { now: () => 9_000 });
    stores.push(migrated);
    expect(migrated.requireInteraction(command.publicId).display).toMatchObject({
      kind: "command_approval",
      availableDecisions: ["once", "session", "decline", "cancel"],
    });
    expect(migrated.requireInteraction(files.publicId).display).toMatchObject({
      kind: "file_change_approval",
      availableDecisions: ["once", "decline", "cancel"],
    });
    const inspector = new Database(paths.database, { readonly: true, strict: true });
    try {
      expect(inspector.query("PRAGMA user_version").get()).toEqual({ user_version: 41 });
      expect(JSON.stringify(inspector.query(
        "SELECT display_json FROM provider_interactions ORDER BY public_id",
      ).all())).not.toContain("allowsSessionApproval");
    } finally {
      inspector.close(false);
    }
  });

  test("migrates a v16 pending login without a provider login ID to an explicit fresh-login state", async () => {
    const { store } = await fixture();
    const profile = store.createProfile("Legacy pending login");
    const idempotencyKey = "00000000-0000-4000-8000-000000000981";
    const attempt = store.prepareMutation({
      kind: "account.login",
      authorityId: profile.id,
      authorityGeneration: 1,
      request: { deviceCode: false },
      idempotencyKey,
    });
    store.beginAccountMutationEffect({
      attemptId: attempt.id,
      profileId: profile.id,
      profileGeneration: 1,
      evidence: { kind: "account.login", method: "browser" },
    });
    expect(store.transitionMutation(attempt.id, "effect_started", "applied", { status: "pending" })).toBe(true);
    const paths = store.paths;
    store.close();
    stores.splice(stores.indexOf(store), 1);

    const legacy = new Database(paths.database, { create: false, strict: true });
    legacy.exec(`
      DROP TRIGGER IF EXISTS provider_login_authority_identity_immutable;
      DROP TRIGGER IF EXISTS provider_login_authority_generation_guard;
      DROP TRIGGER IF EXISTS provider_login_authority_state_guard;
      DROP TRIGGER IF EXISTS provider_login_authority_immutable_delete;
      DROP TABLE provider_login_authorities;
      DELETE FROM migrations WHERE version>=17;
      PRAGMA user_version=16;
    `);
    legacy.close(false);

    const migrated = new StateStore(paths, { now: () => 9_000 });
    stores.push(migrated);
    expect(migrated.requireProfile(profile.id)).toMatchObject({
      processGeneration: 1,
      state: "signed_out",
    });
    expect(migrated.readMutation(idempotencyKey)).toMatchObject({
      originalState: "applied",
      resolution: {
        kind: "abandoned",
        evidence: { source: "schema17", reason: "missing_provider_login_id" },
      },
      state: "reconciled",
    });
    expect(migrated.readPendingLoginAuthority(profile.id, 1)).toBeNull();
    expect(migrated.prepareMutation({
      kind: "account.login",
      authorityId: profile.id,
      authorityGeneration: 2,
      request: { deviceCode: false },
      idempotencyKey: "00000000-0000-4000-8000-000000000982",
    })).toMatchObject({ replay: false, state: "prepared" });
  });

  test("redacts and terminalizes secret-bearing MCP URL interactions when upgrading v10", async () => {
    const { store } = await fixture();
    const profile = signInProfile(store, "Legacy URL profile", "legacy-url@example.com");
    const session = store.createSession({
      profileId: profile.id,
      title: "Legacy URL session",
      preset: "high",
      fastEnabled: false,
    });
    const paths = store.paths;
    store.close();
    stores.splice(stores.indexOf(store), 1);

    const sentinel = "MCP_V10_URL_SECRET_SENTINEL";
    const interactionId = "018f1f55-3f10-7c1a-8f7b-c6dc608bcd3b";
    seedLegacyMcpUrlInteraction({
      interactionId,
      paths,
      processGeneration: profile.processGeneration,
      profileId: profile.id,
      sentinel,
      sessionId: session.id,
    });

    const migrated = new StateStore(paths, { now: () => 9_000 });
    stores.push(migrated);
    expect(migrated.requireInteraction(interactionId)).toMatchObject({
      publicId: interactionId,
      state: "resolution_unknown",
      revision: 2,
      display: {
        kind: "mcp_elicitation",
        summary: "Codex requests MCP form input",
        serverName: "redacted",
        mode: "form",
        url: null,
        mayContainSecrets: true,
      },
      updatedAt: 9_000,
      terminalAt: 9_000,
    });
    expect(migrated.listInteractions({ sessionId: session.id })).toHaveLength(1);
    expect(migrated.listInteractions({ sessionId: session.id, pendingOnly: true })).toEqual([]);
    migrated.close();
    stores.splice(stores.indexOf(migrated), 1);

    const inspector = new Database(paths.database, { readonly: true, strict: true });
    try {
      expect(inspector.query("PRAGMA user_version").get()).toEqual({ user_version: 41 });
      expect(inspector.query(
        "SELECT revision,state FROM provider_interaction_transitions WHERE public_id=? ORDER BY revision",
      ).all(interactionId)).toEqual([
        { revision: 1, state: "pending" },
        { revision: 2, state: "resolution_unknown" },
      ]);
      expect(JSON.stringify(inspector.query(
        "SELECT display_json FROM provider_interactions WHERE public_id=?",
      ).get(interactionId))).not.toContain(sentinel);
    } finally {
      inspector.close(false);
    }
    expect(await stateFileSuffixesContaining(paths.database, sentinel)).toEqual([]);
  });

  test("redacts and physically scrubs permission values when upgrading v14", async () => {
    const { store } = await fixture();
    const profile = signInProfile(store, "Legacy permission profile", "legacy-permission@example.com");
    const session = store.createSession({
      profileId: profile.id,
      title: "Legacy permission session",
      preset: "high",
      fastEnabled: false,
    });
    const paths = store.paths;
    store.close();
    stores.splice(stores.indexOf(store), 1);

    const sentinel = "PERMISSION_V14_VALUE_SENTINEL";
    const interactionId = "118f1f55-3f10-7c1a-8f7b-c6dc608bcd3b";
    seedLegacyPermissionValueInteraction({
      interactionId,
      paths,
      processGeneration: profile.processGeneration,
      profileId: profile.id,
      sentinel,
      sessionId: session.id,
    });
    expect(await stateFileSuffixesContaining(paths.database, sentinel)).toContain("");

    const migrated = new StateStore(paths, { now: () => 9_000 });
    stores.push(migrated);
    expect(migrated.requireInteraction(interactionId)).toMatchObject({
      state: "pending",
      revision: 1,
      responseDigest: null,
      display: {
        kind: "permission_approval",
        requested: [{ name: "fileSystem" }],
      },
    });
    migrated.close();
    stores.splice(stores.indexOf(migrated), 1);

    const inspector = new Database(paths.database, { readonly: true, strict: true });
    try {
      expect(inspector.query("PRAGMA user_version").get()).toEqual({ user_version: 41 });
      expect(inspector.query(
        "SELECT revision,state FROM provider_interaction_transitions WHERE public_id=? ORDER BY revision",
      ).all(interactionId)).toEqual([{ revision: 1, state: "pending" }]);
      expect(JSON.stringify(inspector.query(
        "SELECT display_json FROM provider_interactions WHERE public_id=?",
      ).get(interactionId))).not.toContain(sentinel);
    } finally {
      inspector.close(false);
    }
    expect(await stateFileSuffixesContaining(paths.database, sentinel)).toEqual([]);
  });

  for (const targetVersion of [11, 12, 13] as const) {
    test(`physically scrubs logically safe v${targetVersion} state without changing queue FIFO`, async () => {
      const home = await realpath(await mkdtemp(join(tmpdir(), `hra-store-v${targetVersion}-physical-scrub-`)));
      const paths = resolveStatePaths({ homeDirectory: home, platform: "darwin" });
      await initializeStatePaths(paths);
      const store = new StateStore(paths, { now: () => 5_000 });
      const profile = signInProfile(store, `Physical v${targetVersion}`, `physical-v${targetVersion}@example.com`);
      const session = store.createSession({
        profileId: profile.id,
        title: `Physical v${targetVersion} session`,
        preset: "high",
        fastEnabled: false,
      });
      const queue = ["first", "deleted", "third", "fourth"].map((message) => store.enqueue(session.id, message));
      store.close();

      const legacyQueue = new Database(paths.database, { create: false, strict: true });
      legacyQueue.exec(`
        DROP TRIGGER IF EXISTS queue_enqueue_sequence_required;
        DROP TRIGGER IF EXISTS queue_enqueue_identity_insert_once;
        DROP TRIGGER IF EXISTS queue_enqueue_sequence_immutable;
        DROP TRIGGER IF EXISTS queue_sequence_authority_no_delete;
        DROP TRIGGER IF EXISTS queue_sequence_authority_singleton_immutable;
        DROP INDEX IF EXISTS queue_pending_sequence;
        DROP INDEX IF EXISTS queue_enqueue_sequence_unique;
        DROP TABLE IF EXISTS queue_sequence_authority;
        ALTER TABLE queue_entries DROP COLUMN enqueue_sequence;
      `);
      legacyQueue.query("DELETE FROM queue_entries WHERE id=?").run(queue[1]!.id);
      legacyQueue.close(false);

      const sentinelNeedle = `MCP_V${targetVersion}_PHYSICAL_SECRET_SENTINEL`;
      const interactionId = `${targetVersion === 11 ? "218" : targetVersion === 12 ? "318" : "418"}f1f55-3f10-7c1a-8f7b-c6dc608bcd3b`;
      seedLegacyMcpUrlInteraction({
        interactionId,
        paths,
        processGeneration: profile.processGeneration,
        profileId: profile.id,
        sentinel: `${sentinelNeedle}${"x".repeat(1_536)}`,
        sessionId: session.id,
      });
      simulateLogicallyRedactedMcpDatabase({ interactionId, paths, targetVersion });

      const logicalInspector = new Database(paths.database, { readonly: true, strict: true });
      try {
        expect(JSON.stringify(logicalInspector.query(
          "SELECT display_json FROM provider_interactions WHERE public_id=?",
        ).get(interactionId))).not.toContain(sentinelNeedle);
        expect(logicalInspector.query(
          "SELECT id FROM queue_entries ORDER BY rowid",
        ).all()).toEqual([
          { id: queue[0]!.id },
          { id: queue[2]!.id },
          { id: queue[3]!.id },
        ]);
      } finally {
        logicalInspector.close(false);
      }
      expect(await stateFileSuffixesContaining(paths.database, sentinelNeedle)).toEqual([""]);

      const migrated = new StateStore(paths, { now: () => 10_000 });
      expect(migrated.listQueue(session.id).map((entry) => entry.id)).toEqual([
        queue[0]!.id,
        queue[2]!.id,
        queue[3]!.id,
      ]);
      expect(migrated.listRecoverableQueue().map((entry) => entry.id)).toEqual([
        queue[0]!.id,
        queue[2]!.id,
        queue[3]!.id,
      ]);
      migrated.close();

      const inspector = new Database(paths.database, { readonly: true, strict: true });
      try {
      expect(inspector.query("PRAGMA user_version").get()).toEqual({ user_version: 41 });
        expect(inspector.query(
          "SELECT enqueue_sequence FROM queue_entries ORDER BY enqueue_sequence",
        ).all()).toEqual([
          { enqueue_sequence: 1 },
          { enqueue_sequence: 2 },
          { enqueue_sequence: 3 },
        ]);
        expect(inspector.query(
          "SELECT reason,required_at FROM security_scrub_authority WHERE singleton=1",
        ).get()).toBeNull();
        expect(inspector.query(
          "SELECT revision,state FROM provider_interaction_transitions WHERE public_id=? ORDER BY revision",
        ).all(interactionId)).toEqual([
          { revision: 1, state: "pending" },
          { revision: 2, state: "resolution_unknown" },
        ]);
      } finally {
        inspector.close(false);
      }
      expect(await stateFileSuffixesContaining(paths.database, sentinelNeedle)).toEqual([]);
    });
  }

  test("keeps a busy-reader MCP scrub unavailable until WAL truncation can finish", async () => {
    const { store } = await fixture();
    const profile = signInProfile(store, "Pinned legacy URL", "pinned-legacy-url@example.com");
    const session = store.createSession({
      profileId: profile.id,
      title: "Pinned legacy URL session",
      preset: "high",
      fastEnabled: false,
    });
    const paths = store.paths;
    store.close();
    stores.splice(stores.indexOf(store), 1);

    const sentinel = "MCP_PINNED_READER_SECRET_SENTINEL";
    const interactionId = "118f1f55-3f10-7c1a-8f7b-c6dc608bcd3b";
    seedLegacyMcpUrlInteraction({
      interactionId,
      paths,
      processGeneration: profile.processGeneration,
      profileId: profile.id,
      sentinel,
      sessionId: session.id,
    });

    const pinnedReader = new Database(paths.database, { readonly: true, strict: true });
    pinnedReader.exec("BEGIN");
    expect(JSON.stringify(pinnedReader.query(
      "SELECT display_json FROM provider_interactions WHERE public_id=?",
    ).get(interactionId))).toContain(sentinel);
    try {
      // Reproduce the buggy v12 boundary: the durable interaction transition
      // commits, its checkpoint reports busy, and no scrub-completion marker
      // survives to distinguish the schema stamp from a byte purge.
      const buggyMigration = new Database(paths.database, { create: false, strict: true });
      buggyMigration.exec(`
        PRAGMA secure_delete=OFF;
        DROP TRIGGER IF EXISTS provider_interactions_authority_immutable;
      `);
      buggyMigration.query(
        `UPDATE provider_interactions
         SET state='resolution_unknown',revision=revision+1,display_json=?,updated_at=9000,terminal_at=9000
         WHERE public_id=? AND revision=1`,
      ).run(JSON.stringify({
        kind: "mcp_elicitation",
        summary: "Unsupported MCP browser handoff canceled during security migration",
        serverName: "redacted",
        mode: "form",
        url: null,
        mayContainSecrets: true,
      }), interactionId);
      buggyMigration.query(
        `INSERT INTO provider_interaction_transitions(
           public_id,revision,state,response_digest,recorded_at
         ) SELECT public_id,revision,state,response_digest,9000
           FROM provider_interactions WHERE public_id=?`,
      ).run(interactionId);
      buggyMigration.exec(`
        CREATE TABLE usage_cloud_upload_anchors (
          profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
          source_revision INTEGER NOT NULL CHECK(source_revision >= 0),
          received_at INTEGER NOT NULL CHECK(received_at >= 0),
          PRIMARY KEY(profile_id, source_revision)
        ) STRICT;
        CREATE INDEX usage_cloud_upload_anchors_recent
          ON usage_cloud_upload_anchors(profile_id, source_revision DESC);
        INSERT INTO migrations(version,applied_at) VALUES (11,9000),(12,9000);
        PRAGMA user_version=12;
      `);
      expect(buggyMigration.query("PRAGMA wal_checkpoint(TRUNCATE)").get())
        .toEqual(expect.objectContaining({ busy: 1 }));
      buggyMigration.close(false);

      expect(() => {
        const unexpectedlyOpened = new StateStore(paths, {
          now: () => 9_000,
          securityScrubCheckpoint: shortScrubCheckpoint,
        });
        unexpectedlyOpened.close();
      }).toThrow("STATE_SECURITY_SCRUB_REQUIRED");

      const inspector = new Database(paths.database, { readonly: true, strict: true });
      try {
      expect(inspector.query("PRAGMA user_version").get()).toEqual({ user_version: 41 });
        expect(inspector.query(
          "SELECT reason,required_at FROM security_scrub_authority WHERE singleton=1",
        ).get()).toEqual({ reason: "mcp_url_redaction", required_at: 9_000 });
        expect(inspector.query(
          "SELECT revision,state FROM provider_interaction_transitions WHERE public_id=? ORDER BY revision",
        ).all(interactionId)).toEqual([
          { revision: 1, state: "pending" },
          { revision: 2, state: "resolution_unknown" },
        ]);
      } finally {
        inspector.close(false);
      }
      expect(() => {
        const unexpectedlyReadable = new StateStore(paths, { readonly: true });
        unexpectedlyReadable.close();
      }).toThrow("STATE_SECURITY_SCRUB_REQUIRED");
      expect(await stateFileSuffixesContaining(paths.database, sentinel)).not.toEqual([]);
    } finally {
      pinnedReader.exec("COMMIT");
      pinnedReader.close(false);
    }

    const recovered = new StateStore(paths, { now: () => 10_000 });
    stores.push(recovered);
    expect(recovered.requireInteraction(interactionId)).toMatchObject({
      revision: 2,
      state: "resolution_unknown",
      updatedAt: 9_000,
    });
    recovered.close();
    stores.splice(stores.indexOf(recovered), 1);

    const inspector = new Database(paths.database, { readonly: true, strict: true });
    try {
      expect(inspector.query(
        "SELECT reason,required_at FROM security_scrub_authority WHERE singleton=1",
      ).get()).toBeNull();
      expect(inspector.query(
        "SELECT revision,state FROM provider_interaction_transitions WHERE public_id=? ORDER BY revision",
      ).all(interactionId)).toEqual([
        { revision: 1, state: "pending" },
        { revision: 2, state: "resolution_unknown" },
      ]);
    } finally {
      inspector.close(false);
    }
    expect(await stateFileSuffixesContaining(paths.database, sentinel)).toEqual([]);
  }, 20_000);

  test("transactionally rebuilds v30 autorespond evidence and preserves rows across reopen", async () => {
    const { store } = await fixture();
    const profile = store.createProfile("Autorespond migration");
    const session = store.createSession({
      profileId: profile.id,
      preset: "high",
      fastEnabled: false,
    });
    const paths = store.paths;
    store.close();
    stores.splice(stores.indexOf(store), 1);

    const legacy = new Database(paths.database, { create: false, strict: true });
    replaceAutorespondEvidenceWithVersion30Fixture(legacy, session.id);
    legacy.close(false);

    const expectedEvidence = {
      approvalClass: "shell",
      decision: "accept",
      interactionId: "00000000-0000-4000-8000-000000000731",
      kind: "command_approval",
      latencyMs: 17,
      mode: "manual",
      model: null,
      occurredAt: 1_500,
      outcome: "accepted",
      path: "protocol",
      rule: null,
      sessionId: session.id,
      subagent: true,
    } as const;
    const migrated = new StateStore(paths, { now: () => 2_000 });
    stores.push(migrated);
    expect(migrated.listAutorespondEvidence({ sessionId: session.id })).toEqual([expectedEvidence]);
    migrated.close();
    stores.splice(stores.indexOf(migrated), 1);

    const reopened = new StateStore(paths, { now: () => 3_000 });
    stores.push(reopened);
    expect(reopened.listAutorespondEvidence({ sessionId: session.id })).toEqual([expectedEvidence]);
    const inspector = new Database(paths.database, { readonly: true, strict: true });
    try {
      expect(inspector.query("PRAGMA user_version").get()).toEqual({ user_version: 41 });
      expect(inspector.query("SELECT id,path,rule,model FROM autorespond_evidence").get()).toEqual({
        id: 7,
        path: "protocol",
        rule: null,
        model: null,
      });
    } finally {
      inspector.close(false);
    }
  });

  test("rolls back the v31 rebuild when an intermediate schema statement fails", async () => {
    const { store } = await fixture();
    const profile = store.createProfile("Autorespond rollback");
    const session = store.createSession({
      profileId: profile.id,
      preset: "high",
      fastEnabled: false,
    });
    const paths = store.paths;
    store.close();
    stores.splice(stores.indexOf(store), 1);

    const legacy = new Database(paths.database, { create: false, strict: true });
    replaceAutorespondEvidenceWithVersion30Fixture(legacy, session.id);
    legacy.query("CREATE TABLE autorespond_evidence_next (blocked TEXT) STRICT").run();
    legacy.close(false);

    expect(() => new StateStore(paths, { now: () => 2_000 })).toThrow();
    const inspector = new Database(paths.database, { readonly: true, strict: true });
    try {
      expect(inspector.query("PRAGMA user_version").get()).toEqual({ user_version: 30 });
      expect(inspector.query("SELECT version FROM migrations WHERE version=31").get()).toBeNull();
      expect(inspector.query("SELECT id,session_id FROM autorespond_evidence").get()).toEqual({
        id: 7,
        session_id: session.id,
      });
      expect(inspector.query("PRAGMA table_info(autorespond_evidence)").all())
        .not.toContainEqual(expect.objectContaining({ name: "path" }));
    } finally {
      inspector.close(false);
    }
  });

  test("opens and transactionally migrates a real v1 database without losing sessions", async () => {
    const home = await realpath(await mkdtemp(join(tmpdir(), "hra-store-v1-")));
    const paths = resolveStatePaths({ homeDirectory: home, platform: "darwin" });
    await initializeStatePaths(paths);
    const legacy = new Database(paths.database, { create: true, strict: true });
    legacy.exec(`
      CREATE TABLE migrations (
        version INTEGER PRIMARY KEY,
        applied_at INTEGER NOT NULL CHECK(applied_at >= 0)
      ) STRICT;
      INSERT INTO migrations(version, applied_at) VALUES (1, 1000);
      CREATE TABLE profiles (
        id TEXT PRIMARY KEY CHECK(id GLOB 'acct_[0-9a-f]*' AND length(id) = 37),
        label TEXT NOT NULL CHECK(length(label) BETWEEN 1 AND 160),
        state TEXT NOT NULL CHECK(state IN ('signed_out','login_pending','signed_in','recovery_required','removed')),
        process_generation INTEGER NOT NULL CHECK(process_generation >= 0),
        provider_email TEXT,
        provider_plan TEXT,
        created_at INTEGER NOT NULL CHECK(created_at >= 0),
        updated_at INTEGER NOT NULL CHECK(updated_at >= created_at)
      ) STRICT;
      CREATE TABLE projects (
        id TEXT PRIMARY KEY CHECK(id GLOB 'proj_[0-9a-f]*' AND length(id) = 37),
        label TEXT NOT NULL CHECK(length(label) BETWEEN 1 AND 160),
        root_path TEXT NOT NULL UNIQUE,
        is_default INTEGER NOT NULL CHECK(is_default IN (0,1)),
        created_at INTEGER NOT NULL CHECK(created_at >= 0),
        updated_at INTEGER NOT NULL CHECK(updated_at >= created_at)
      ) STRICT;
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY CHECK(id GLOB 'sess_[0-9a-f]*' AND length(id) = 37),
        profile_id TEXT NOT NULL REFERENCES profiles(id),
        project_id TEXT REFERENCES projects(id),
        provider_thread_id TEXT,
        title TEXT NOT NULL CHECK(length(title) <= 320),
        note TEXT NOT NULL DEFAULT '' CHECK(length(CAST(note AS BLOB)) <= 16384),
        preset TEXT NOT NULL CHECK(preset IN ('low','high','ultra')),
        fast_enabled INTEGER NOT NULL CHECK(fast_enabled IN (0,1)),
        state TEXT NOT NULL CHECK(state IN ('starting','active','idle','terminal','recovery_required')),
        active_turn_id TEXT,
        revision INTEGER NOT NULL CHECK(revision > 0),
        created_at INTEGER NOT NULL CHECK(created_at >= 0),
        updated_at INTEGER NOT NULL CHECK(updated_at >= created_at),
        UNIQUE(profile_id, provider_thread_id)
      ) STRICT;
      INSERT INTO profiles(id,label,state,process_generation,created_at,updated_at)
        VALUES ('acct_00000000000000000000000000000000','Legacy','signed_in',3,1000,1000);
      INSERT INTO sessions(id,profile_id,title,note,preset,fast_enabled,state,revision,created_at,updated_at)
        VALUES ('sess_00000000000000000000000000000000','acct_00000000000000000000000000000000','Preserved','','high',0,'idle',1,1000,1000);
      PRAGMA user_version = 1;
    `);
    legacy.close(false);
    await chmod(paths.database, 0o600);

    const store = new StateStore(paths, { now: () => 2000 });
    stores.push(store);
    const preserved = store.requireSession("sess_00000000000000000000000000000000");
    expect(preserved).toMatchObject({
      title: "Preserved",
      revision: 1,
    });
    expect("providerUpdatedAt" in preserved).toBe(false);
    const inspector = new Database(paths.database, { readonly: true, strict: true });
    try {
      expect(inspector.query("PRAGMA user_version").get()).toEqual({ user_version: 41 });
      expect(inspector.query("SELECT version, applied_at FROM migrations ORDER BY version").all()).toEqual([
        { version: 1, applied_at: 1000 },
        { version: 2, applied_at: 2000 },
        { version: 3, applied_at: 2000 },
        { version: 4, applied_at: 2000 },
        { version: 5, applied_at: 2000 },
        { version: 6, applied_at: 2000 },
        { version: 7, applied_at: 2000 },
        { version: 8, applied_at: 2000 },
        { version: 9, applied_at: 2000 },
        { version: 10, applied_at: 2000 },
        { version: 11, applied_at: 2000 },
        { version: 12, applied_at: 2000 },
        { version: 13, applied_at: 2000 },
        { version: 14, applied_at: 2000 },
        { version: 15, applied_at: 2000 },
        { version: 16, applied_at: 2000 },
        { version: 17, applied_at: 2000 },
        { version: 18, applied_at: 2000 },
        { version: 19, applied_at: 2000 },
        { version: 20, applied_at: 2000 },
        { version: 21, applied_at: 2000 },
        { version: 22, applied_at: 2000 },
        { version: 23, applied_at: 2000 },
        { version: 24, applied_at: 2000 },
        { version: 25, applied_at: 2000 },
        { version: 26, applied_at: 2000 },
        { version: 27, applied_at: 2000 },
        { version: 28, applied_at: 2000 },
        { version: 29, applied_at: 2000 },
        { version: 30, applied_at: 2000 },
        { version: 31, applied_at: 2000 },
        { version: 32, applied_at: 2000 },
        { version: 33, applied_at: 2000 },
        { version: 34, applied_at: 2000 },
        { version: 35, applied_at: 2000 },
        { version: 36, applied_at: 2000 },
        { version: 37, applied_at: 2000 },
        { version: 38, applied_at: 2000 },
        { version: 39, applied_at: 2000 },
        { version: 40, applied_at: 2000 },
        { version: 41, applied_at: 2000 },
      ]);
      expect(inspector.query("PRAGMA table_info(sessions)").all()).toContainEqual(expect.objectContaining({ name: "provider_updated_at" }));
      expect(inspector.query("SELECT label,label_key FROM profiles").get()).toEqual({
        label: "Legacy",
        label_key: "legacy",
      });
    } finally {
      inspector.close(false);
    }
  });

  test("upgrades an early-stamped v2 database to v3 without losing authority data", async () => {
    const { store } = await fixture();
    const profile = signInProfile(store, "V2 profile", "v2@example.com");
    const session = store.createSession({
      profileId: profile.id,
      title: "V2 retained",
      preset: "high",
      fastEnabled: false,
    });
    const paths = store.paths;
    store.close();
    stores.splice(stores.indexOf(store), 1);

    const legacy = new Database(paths.database, { create: false, strict: true });
    legacy.exec(`
      DROP TRIGGER IF EXISTS queue_transition_guard;
      DROP TRIGGER IF EXISTS desktop_switch_transition_guard;
      DROP TABLE IF EXISTS desktop_switch_authority;
      DELETE FROM migrations WHERE version=3;
      PRAGMA user_version=2;
    `);
    legacy.close(false);

    const migrated = new StateStore(paths, { now: () => 9_000 });
    stores.push(migrated);
    expect(migrated.requireProfile(profile.id)).toMatchObject({
      id: profile.id,
      providerEmail: "v2@example.com",
    });
    expect(migrated.requireSession(session.id)).toMatchObject({
      id: session.id,
      title: "V2 retained",
    });
    const inspector = new Database(paths.database, { readonly: true, strict: true });
    try {
      expect(inspector.query("PRAGMA user_version").get()).toEqual({ user_version: 41 });
      expect(inspector.query("SELECT applied_at FROM migrations WHERE version=3").get()).toEqual({
        applied_at: 9_000,
      });
      expect(inspector.query("SELECT * FROM desktop_switch_authority").get()).toEqual({
        singleton: 1,
        current_generation: 0,
        current_attempt_id: null,
        released_generation: 0,
      });
    } finally {
      inspector.close(false);
    }
  });

  test("binds immutable host capabilities and keeps project memory authority content-free", async () => {
    const { store, home } = await fixture();
    const root = join(home, "memory-project");
    await mkdir(root);
    const project = await store.createProject("Memory project", root);
    const profile = signInProfile(store, "Memory account", "memory@example.com");
    const session = store.createSession({
      profileId: profile.id,
      projectId: project.id,
      preset: "high",
      fastEnabled: false,
    });

    expect(store.requirePeerSessionPolicy(session.id)).toMatchObject({
      mode: "coordinate",
      revision: 1,
    });
    expect(store.setPeerSessionPolicy({
      sessionId: session.id,
      expectedRevision: 1,
      mode: "inspect",
    })).toMatchObject({ mode: "inspect", revision: 2 });
    expect(() => store.setPeerSessionPolicy({
      sessionId: session.id,
      expectedRevision: 1,
      mode: "off",
    })).toThrow("PEER_SESSION_POLICY_REVISION_CONFLICT");

    expect(() => store.bindSessionHostCapabilities({
      sessionId: session.id,
      preambleVersion: 1,
      preambleDigest: "a".repeat(64),
      manifestVersion: 1,
      manifestDigest: "b".repeat(64),
    })).toThrow("SESSION_HOST_CAPABILITY_ADOPTION_MID_TURN");
    const idleSession = store.bindSession({
      sessionId: session.id,
      expectedRevision: session.revision,
      providerThreadId: "thread-capability-idle",
      state: "idle",
    });
    const capability = store.bindSessionHostCapabilities({
      sessionId: idleSession.id,
      preambleVersion: 1,
      preambleDigest: "a".repeat(64),
      manifestVersion: 1,
      manifestDigest: "b".repeat(64),
    });
    expect(store.bindSessionHostCapabilities({
      sessionId: session.id,
      preambleVersion: 1,
      preambleDigest: "a".repeat(64),
      manifestVersion: 1,
      manifestDigest: "b".repeat(64),
    })).toEqual(capability);
    expect(() => store.bindSessionHostCapabilities({
      sessionId: session.id,
      preambleVersion: 2,
      preambleDigest: "a".repeat(64),
      manifestVersion: 1,
      manifestDigest: "b".repeat(64),
    })).toThrow("SESSION_HOST_CAPABILITY_BINDING_CONFLICT");
    const active = store.createSession({
      profileId: profile.id,
      projectId: project.id,
      preset: "high",
      fastEnabled: false,
    });
    store.setSessionTurnState({
      sessionId: active.id,
      expectedRevision: active.revision,
      state: "active",
      activeTurnId: "turn-mid-adoption",
    });
    expect(() => store.bindSessionHostCapabilities({
      sessionId: active.id,
      preambleVersion: 1,
      preambleDigest: "a".repeat(64),
      manifestVersion: 1,
      manifestDigest: "b".repeat(64),
    })).toThrow("SESSION_HOST_CAPABILITY_ADOPTION_MID_TURN");

    const emptyHead = PROJECT_MEMORY_EMPTY_HEAD;
    const invalidIdentity = createPortableProjectMemoryCanonicalIdentity(project.id);
    expect(() => store.reserveProjectMemoryAuthority({
      canonicalSpaceId: invalidIdentity.canonicalSpaceId,
      head: { ...emptyHead, headDigest: "c".repeat(64) },
      identityContract: invalidIdentity.identityContract,
      projectId: project.id,
    })).toThrow("PROJECT_MEMORY_AUTHORITY_RESERVATION_INVALID");
    expect(store.readProjectMemoryAuthority(project.id)).toBeNull();
    const identity = createPortableProjectMemoryCanonicalIdentity(project.id);
    const reserved = store.reserveProjectMemoryAuthority({
      canonicalSpaceId: identity.canonicalSpaceId,
      head: emptyHead,
      identityContract: identity.identityContract,
      projectId: project.id,
    });
    expect(reserved).toMatchObject({
      physicalState: "reserved",
      revision: 1,
    });
    expect(reserved.initializedAt).toBeUndefined();
    expect(() => store.compareAndSwapProjectMemoryHead({
      projectId: project.id,
      expectedRevision: reserved.revision,
      expectedHead: emptyHead,
      nextHead: {
        sequence: 1,
        operationSha256: "e".repeat(64),
        headDigest: "2".repeat(64),
      },
    })).toThrow("PROJECT_MEMORY_AUTHORITY_NOT_INITIALIZED");
    const initialized = store.markProjectMemoryAuthorityInitialized({
      expectedHead: reserved.head,
      expectedRevision: reserved.revision,
      projectId: project.id,
    });
    expect(initialized).toMatchObject({
      initializedAt: expect.any(Number),
      physicalState: "initialized",
      revision: 2,
    });
    expect(store.markProjectMemoryAuthorityInitialized({
      expectedHead: reserved.head,
      expectedRevision: reserved.revision,
      projectId: project.id,
    })).toEqual(initialized);
    const losingIdentity = createPortableProjectMemoryCanonicalIdentity(project.id);
    expect(store.reserveProjectMemoryAuthority({
      canonicalSpaceId: losingIdentity.canonicalSpaceId,
      head: emptyHead,
      identityContract: losingIdentity.identityContract,
      projectId: project.id,
    })).toEqual(initialized);
    const nextHead = {
      sequence: 1,
      operationSha256: "f".repeat(64),
      headDigest: "1".repeat(64),
    } as const;
    const advanced = store.compareAndSwapProjectMemoryHead({
      projectId: project.id,
      expectedRevision: initialized.revision,
      expectedHead: emptyHead,
      nextHead,
    });
    expect(advanced).toMatchObject({ head: nextHead, revision: 3, syncState: "local_only" });
    const settled = store.recordProjectMemorySyncObservation({
      projectId: project.id,
      expectedRevision: advanced.revision,
      expectedHead: nextHead,
      state: "settled",
      exchangeHead: nextHead,
    });
    expect(settled).toMatchObject({
      revision: 4,
      syncState: "settled",
      lastExchangeHead: nextHead,
    });

    const memoryRequestDigest = testDigest("memory request");
    const memoryContentDigest = testDigest("PRIVATE MEMORY CONTENT");
    const memoryKeyDigest = testDigest("private:key");
    const memoryWorkingBindingDigest = testDigest("private working binding");
    const memoryRecordDigest = testDigest("private memory record");
    const memoryAttestationDigest = testDigest("private memory attestation");
    const workingRemember = store.prepareMemorySubmission({
      actorSessionId: session.id,
      projectId: project.id,
      kind: "remember",
      requestDigest: memoryRequestDigest,
      contentDigest: memoryContentDigest,
      keyDigest: memoryKeyDigest,
      workingBindingDigest: memoryWorkingBindingDigest,
      workingEpoch: 1,
      expectedHead: emptyHead,
      idempotencyKey: peerIdempotencyKey(7_999),
    }).record;
    store.bindMemorySubmissionEffect({
      submissionId: workingRemember.id,
      effectRecordSha256: memoryRecordDigest,
      attestationSha256: memoryAttestationDigest,
      operationId: "memory_remember_private",
    });
    store.beginMemorySubmission(workingRemember.id);
    store.settleMemorySubmission({
      submissionId: workingRemember.id,
      expectedState: "effect_started",
      state: "applied",
      outcomeCode: "remember_committed",
      resultHead: nextHead,
      receiptDigest: testDigest("private remember receipt"),
    });

    const prepared = store.prepareMemorySubmission({
      actorSessionId: session.id,
      projectId: project.id,
      kind: "share",
      requestDigest: memoryRequestDigest,
      contentDigest: memoryContentDigest,
      keyDigest: memoryKeyDigest,
      workingBindingDigest: memoryWorkingBindingDigest,
      workingEpoch: 1,
      expectedHead: nextHead,
      idempotencyKey: peerIdempotencyKey(8_000),
    });
    expect(store.prepareMemorySubmission({
      actorSessionId: session.id,
      projectId: project.id,
      kind: "share",
      requestDigest: memoryRequestDigest,
      contentDigest: memoryContentDigest,
      keyDigest: memoryKeyDigest,
      workingBindingDigest: memoryWorkingBindingDigest,
      workingEpoch: 1,
      expectedHead: nextHead,
      idempotencyKey: peerIdempotencyKey(8_000),
    })).toMatchObject({ replay: true, record: { id: prepared.record.id } });
    const invariantWriter = new Database(store.paths.database, { create: false, strict: true });
    invariantWriter.exec("PRAGMA foreign_keys=ON");
    expect(() => invariantWriter.query(
      `UPDATE memory_submissions
       SET result_head_operation_sha256=? WHERE id=?`,
    ).run("9".repeat(64), prepared.record.id)).toThrow();
    expect(() => invariantWriter.query(
      `UPDATE project_memory_authorities
       SET head_sequence=0,head_operation_sha256=NULL,head_digest=?,revision=revision+1
       WHERE project_id=?`,
    ).run(emptyHead.headDigest, project.id)).toThrow();
    expect(() => invariantWriter.query(
      "DELETE FROM session_host_capability_bindings WHERE session_id=?",
    ).run(idleSession.id)).toThrow();
    invariantWriter.close(false);
    store.bindMemorySubmissionEffect({
      submissionId: prepared.record.id,
      effectRecordSha256: memoryRecordDigest,
      attestationSha256: memoryAttestationDigest,
      operationId: "memory_adopt_private",
      sourceHead: nextHead,
      nominationSha256: testDigest("private memory nomination"),
    });
    store.beginMemorySubmission(prepared.record.id);
    const resultHead = {
      sequence: 2,
      operationSha256: "2".repeat(64),
      headDigest: "3".repeat(64),
    } as const;
    expect(store.settleMemorySubmission({
      submissionId: prepared.record.id,
      expectedState: "effect_started",
      state: "applied",
      outcomeCode: "share_adopted",
      resultHead,
      receiptDigest: "4".repeat(64),
    })).toMatchObject({ state: "applied", resultHead });
    expect(store.readProjectMemoryAuthority(project.id)).toMatchObject({
      head: resultHead,
      lastExchangeHead: nextHead,
      syncState: "local_only",
    });

    const inspector = new Database(store.paths.database, { readonly: true, strict: true });
    try {
      const retained = JSON.stringify({
        authority: inspector.query("SELECT * FROM project_memory_authorities").get(),
        capability: inspector.query("SELECT * FROM session_host_capability_bindings").get(),
        submission: inspector.query("SELECT * FROM memory_submissions").get(),
      });
      expect(retained).not.toContain("PRIVATE MEMORY CONTENT");
      expect(retained).not.toContain("private:key");
      expect(retained).not.toContain(root);
    } finally {
      inspector.close(false);
    }

    const currentAuthority = store.readProjectMemoryAuthority(project.id);
    if (currentAuthority === null) throw new Error("Expected project memory authority.");
    const frozen = store.recordProjectMemorySyncObservation({
      projectId: project.id,
      expectedRevision: currentAuthority.revision,
      expectedHead: currentAuthority.head,
      state: "error",
      diagnosticCode: "MEMORY_CANONICAL_DIVERGED",
    });
    expect(() => store.recordProjectMemorySyncObservation({
      projectId: project.id,
      expectedRevision: frozen.revision,
      expectedHead: frozen.head,
      state: "local_only",
    })).toThrow("PROJECT_MEMORY_SYNC_FROZEN");
    const thawWriter = new Database(store.paths.database, { create: false, strict: true });
    thawWriter.exec("PRAGMA foreign_keys=ON");
    expect(() => thawWriter.query(
      `UPDATE project_memory_authorities
       SET sync_state='local_only',diagnostic_code=NULL,revision=revision+1
       WHERE project_id=?`,
    ).run(project.id)).toThrow();
    thawWriter.close(false);
  });

  test("journals hosted canonical create through crash recovery and exact replay", async () => {
    let now = 20_000;
    const { store, home } = await fixture({ now: () => now++ });
    const root = join(home, "hosted-memory-create-journal");
    await mkdir(root);
    const project = await store.createProject("Hosted memory create journal", root);
    const authority = reserveTestProjectMemoryAuthority(
      store,
      project.id,
      PROJECT_MEMORY_EMPTY_HEAD,
    );
    const accountBindingDigest = testDigest("hosted create account binding");
    const remoteSpaceId = `memory_${"c".repeat(32)}`;
    const idempotencyKey = peerIdempotencyKey(87_501);
    const allocated = store.allocateCanonicalMemoryHostedCreate({
      accountBindingDigest,
      idempotencyKey,
      projectId: project.id,
      remoteSpaceId,
    });
    expect(allocated).toMatchObject({
      replay: false,
      record: {
        accountBindingDigest,
        authorityHead: authority.head,
        authorityRevision: authority.revision,
        canonicalBindingDigest: authority.bindingDigest,
        projectId: project.id,
        remoteSpaceId,
        state: "allocating",
      },
    });
    expect(store.isCanonicalMemoryMutationFenced(project.id)).toBe(true);
    expect(store.allocateCanonicalMemoryHostedCreate({
      accountBindingDigest,
      idempotencyKey,
      projectId: project.id,
      remoteSpaceId,
    })).toMatchObject({ replay: true, record: { id: allocated.record.id } });
    expect(() => store.allocateCanonicalMemoryHostedCreate({
      accountBindingDigest: testDigest("different hosted create account"),
      idempotencyKey,
      projectId: project.id,
      remoteSpaceId,
    })).toThrow("CANONICAL_MEMORY_HOSTED_CREATE_IDEMPOTENCY_CONFLICT");
    expect(() => store.allocateCanonicalMemoryHostedCreate({
      accountBindingDigest,
      idempotencyKey: peerIdempotencyKey(87_502),
      projectId: project.id,
      remoteSpaceId,
    })).toThrow("CANONICAL_MEMORY_HOSTED_CREATE_RECOVERY_REQUIRED");
    const unreconciledGenesisToken = testDigest("unjournaled create genesis");
    expect(() => store.attachCanonicalMemoryHostedSpace({
      accountBindingDigest,
      canonicalSpaceId: authority.canonicalSpaceId,
      projectId: project.id,
      remote: {
        genesisToken: unreconciledGenesisToken,
        head: PROJECT_MEMORY_EMPTY_HEAD,
        headProofDigest: testDigest("unreconciled create proof"),
        headToken: unreconciledGenesisToken,
        keyVersion: 7,
        revision: 1,
      },
      remoteSpaceId,
    })).toThrow("CANONICAL_MEMORY_HOSTED_CREATE_RECOVERY_REQUIRED");
    expect(() => store.compareAndSwapProjectMemoryHead({
      expectedHead: authority.head,
      expectedRevision: authority.revision,
      nextHead: {
        sequence: 1,
        operationSha256: testDigest("create fenced operation"),
        headDigest: testDigest("create fenced head"),
      },
      projectId: project.id,
    })).toThrow("canonical memory mutation fenced by hosted create");

    const request = testCanonicalMemoryHostedCreateRequest(remoteSpaceId);
    expect(store.stageCanonicalMemoryHostedCreateKey({
      intentId: allocated.record.id,
      keyVersion: request.keyVersion,
      wrappedSpaceKey: request.wrappedSpaceKey,
    })).toMatchObject({
      keyVersion: request.keyVersion,
      state: "key_staged",
      wrappedSpaceKey: request.wrappedSpaceKey,
    });
    expect(store.stageCanonicalMemoryHostedCreateKey({
      intentId: allocated.record.id,
      keyVersion: request.keyVersion,
      wrappedSpaceKey: request.wrappedSpaceKey,
    })).toMatchObject({ state: "key_staged" });
    expect(() => store.stageCanonicalMemoryHostedCreateKey({
      intentId: allocated.record.id,
      keyVersion: request.keyVersion,
      wrappedSpaceKey: testCanonicalMemoryEnvelope("different wrapped key", 3),
    })).toThrow("CANONICAL_MEMORY_HOSTED_CREATE_KEY_CONFLICT");
    expect(store.prepareCanonicalMemoryHostedCreate({
      intentId: allocated.record.id,
      request,
    })).toMatchObject({ request, requestDigest: expect.any(String), state: "prepared" });
    expect(store.prepareCanonicalMemoryHostedCreate({
      intentId: allocated.record.id,
      request,
    })).toMatchObject({ state: "prepared" });
    expect(() => store.prepareCanonicalMemoryHostedCreate({
      intentId: allocated.record.id,
      request: {
        ...request,
        encryptedDescriptor: testCanonicalMemoryEnvelope("different descriptor", 7),
      },
    })).toThrow("CANONICAL_MEMORY_HOSTED_CREATE_REQUEST_CONFLICT");
    expect(store.markCanonicalMemoryHostedCreateEffectStarted(allocated.record.id))
      .toMatchObject({ effectStartedAt: expect.any(Number), state: "effect_started" });

    const paths = store.paths;
    store.close();
    stores.splice(stores.indexOf(store), 1);
    now += 1_000;
    const recovered = new StateStore(paths, { now: () => now++ });
    stores.push(recovered);
    expect(recovered.readUnresolvedCanonicalMemoryHostedCreateIntent(project.id))
      .toMatchObject({
        id: allocated.record.id,
        request,
        state: "effect_started",
      });
    const winner = { ...request, replay: false, revision: 1 } as const;
    expect(recovered.recordCanonicalMemoryHostedCreateWinner({
      intentId: allocated.record.id,
      winner,
    })).toMatchObject({
      state: "winner_observed",
      winnerReplay: false,
      winnerRevision: 1,
    });
    expect(recovered.recordCanonicalMemoryHostedCreateWinner({
      intentId: allocated.record.id,
      winner,
    })).toMatchObject({ state: "winner_observed" });
    expect(recovered.settleCanonicalMemoryHostedCreate(allocated.record.id))
      .toMatchObject({ state: "settled" });
    expect(recovered.settleCanonicalMemoryHostedCreate(allocated.record.id))
      .toMatchObject({ state: "settled" });
    expect(recovered.readCanonicalMemoryHostedAttachment(project.id)).toMatchObject({
      accountBindingDigest,
      canonicalBindingDigest: authority.bindingDigest,
      generation: 1,
      remote: {
        genesisToken: request.genesisToken,
        head: PROJECT_MEMORY_EMPTY_HEAD,
        headProofDigest: expect.stringMatching(/^[a-f0-9]{64}$/u),
        headToken: request.genesisToken,
        keyVersion: request.keyVersion,
        revision: 1,
      },
      remoteSpaceId,
      revision: 1,
      state: "attached",
    });
    expect(recovered.readUnresolvedCanonicalMemoryHostedCreateIntent(project.id)).toBeNull();
    expect(recovered.isCanonicalMemoryMutationFenced(project.id)).toBe(false);
    expect(recovered.allocateCanonicalMemoryHostedCreate({
      accountBindingDigest,
      idempotencyKey,
      projectId: project.id,
      remoteSpaceId,
    })).toMatchObject({ replay: true, record: { state: "settled" } });
    expect(recovered.stageCanonicalMemoryHostedCreateKey({
      intentId: allocated.record.id,
      keyVersion: request.keyVersion,
      wrappedSpaceKey: request.wrappedSpaceKey,
    })).toMatchObject({ state: "settled" });
    expect(recovered.prepareCanonicalMemoryHostedCreate({
      intentId: allocated.record.id,
      request,
    })).toMatchObject({ state: "settled" });
    expect(recovered.markCanonicalMemoryHostedCreateEffectStarted(allocated.record.id))
      .toMatchObject({ state: "settled" });
    const settledAuthority = recovered.readProjectMemoryAuthority(project.id);
    if (settledAuthority === null) throw new Error("Expected settled create authority.");
    const laterLocalHead = {
      sequence: 1,
      operationSha256: testDigest("post-create local operation"),
      headDigest: testDigest("post-create local head"),
    } as const;
    recovered.compareAndSwapProjectMemoryHead({
      expectedHead: settledAuthority.head,
      expectedRevision: settledAuthority.revision,
      nextHead: laterLocalHead,
      projectId: project.id,
    });
    expect(recovered.detachCanonicalMemoryHostedSpace({
      expectedGeneration: 1,
      projectId: project.id,
    })).toMatchObject({ generation: 2, state: "detached" });
    recovered.close();
    stores.splice(stores.indexOf(recovered), 1);
    const afterLifecycleAdvance = new StateStore(paths, { now: () => now++ });
    stores.push(afterLifecycleAdvance);
    expect(afterLifecycleAdvance.readCanonicalMemoryHostedCreateIntent(allocated.record.id))
      .toMatchObject({ state: "settled" });
    expect(afterLifecycleAdvance.readCanonicalMemoryHostedAttachment(project.id))
      .toMatchObject({ generation: 2, state: "detached" });
    expect(afterLifecycleAdvance.settleCanonicalMemoryHostedCreate(allocated.record.id))
      .toMatchObject({ state: "settled" });

    const inspector = new Database(paths.database, { readonly: true, strict: true });
    try {
      const persisted = inspector.query(
        "SELECT * FROM project_memory_hosted_create_intents WHERE id=?",
      ).get(allocated.record.id);
      expect(persisted).toMatchObject({
        descriptor_ciphertext: request.encryptedDescriptor.ciphertext,
        genesis_proof_ciphertext: request.genesisHeadProof.ciphertext,
        wrapped_key_ciphertext: request.wrappedSpaceKey.ciphertext,
      });
      const retained = JSON.stringify(persisted);
      expect(retained).not.toContain("PRIVATE HOSTED CREATE DESCRIPTOR");
      expect(retained).not.toContain("PRIVATE HOSTED CREATE GENESIS PROOF");
      expect(retained).not.toContain("PRIVATE HOSTED CREATE WRAPPED KEY");
      expect(retained).not.toContain(root);
    } finally {
      inspector.close(false);
    }
  });

  test("keeps an uncertain hosted create fenced and freezes a proven failure", async () => {
    const { store, home } = await fixture();
    const root = join(home, "hosted-memory-create-uncertain");
    await mkdir(root);
    const project = await store.createProject("Hosted memory create uncertain", root);
    reserveTestProjectMemoryAuthority(store, project.id, PROJECT_MEMORY_EMPTY_HEAD);
    const accountBindingDigest = testDigest("uncertain hosted create account");
    const remoteSpaceId = `memory_${"d".repeat(32)}`;
    const allocated = store.allocateCanonicalMemoryHostedCreate({
      accountBindingDigest,
      idempotencyKey: peerIdempotencyKey(87_503),
      projectId: project.id,
      remoteSpaceId,
    }).record;
    const request = testCanonicalMemoryHostedCreateRequest(remoteSpaceId, 11, 5);
    store.stageCanonicalMemoryHostedCreateKey({
      intentId: allocated.id,
      keyVersion: request.keyVersion,
      wrappedSpaceKey: request.wrappedSpaceKey,
    });
    store.prepareCanonicalMemoryHostedCreate({ intentId: allocated.id, request });
    store.markCanonicalMemoryHostedCreateEffectStarted(allocated.id);
    expect(() => store.recordCanonicalMemoryHostedCreateWinner({
      intentId: allocated.id,
      winner: {
        ...request,
        encryptedDescriptor: testCanonicalMemoryEnvelope("hostile descriptor", 11),
        replay: true,
        revision: 1,
      },
    })).toThrow("CANONICAL_MEMORY_HOSTED_CREATE_WINNER_INVALID");
    expect(store.readUnresolvedCanonicalMemoryHostedCreateIntent(project.id))
      .toMatchObject({ id: allocated.id, state: "effect_started" });

    const guarded = new Database(store.paths.database, { create: false, strict: true });
    guarded.exec("PRAGMA foreign_keys=ON");
    try {
      expect(() => guarded.query(
        `UPDATE project_memory_authorities
         SET revision=revision+1 WHERE project_id=?`,
      ).run(project.id)).toThrow("canonical memory mutation fenced by hosted create");
      expect(() => guarded.query(
        "DELETE FROM project_memory_hosted_create_intents WHERE id=?",
      ).run(allocated.id)).toThrow("canonical memory hosted create intent is immutable");
    } finally {
      guarded.close(false);
    }

    expect(store.failCanonicalMemoryHostedCreate({
      diagnosticCode: "REMOTE_MEMORY_CREATE_CONFLICT",
      intentId: allocated.id,
      state: "conflict",
    })).toMatchObject({
      diagnosticCode: "REMOTE_MEMORY_CREATE_CONFLICT",
      state: "conflict",
    });
    expect(store.failCanonicalMemoryHostedCreate({
      diagnosticCode: "REMOTE_MEMORY_CREATE_CONFLICT",
      intentId: allocated.id,
      state: "conflict",
    })).toMatchObject({ state: "conflict" });
    expect(() => store.failCanonicalMemoryHostedCreate({
      diagnosticCode: "REMOTE_MEMORY_CREATE_ERROR",
      intentId: allocated.id,
      state: "error",
    })).toThrow("CANONICAL_MEMORY_HOSTED_CREATE_FAILURE_CONFLICT");
    expect(store.readUnresolvedCanonicalMemoryHostedCreateIntent(project.id)).toBeNull();
    expect(store.isCanonicalMemoryMutationFenced(project.id)).toBe(true);
    expect(store.readProjectMemoryAuthority(project.id)).toMatchObject({
      diagnosticCode: "REMOTE_MEMORY_CREATE_CONFLICT",
      syncState: "conflict",
    });
    expect(() => store.recordCanonicalMemoryHostedCreateWinner({
      intentId: allocated.id,
      winner: { ...request, replay: false, revision: 1 },
    })).toThrow("CANONICAL_MEMORY_HOSTED_CREATE_STATE_CONFLICT");
  });

  test("journals hosted canonical push before effect and preserves exact replay", async () => {
    let now = 10_000;
    const { store, home } = await fixture({ now: () => now });
    const root = join(home, "hosted-memory-journal");
    await mkdir(root);
    const project = await store.createProject("Hosted memory journal", root);
    const profile = signInProfile(
      store,
      "Hosted memory journal",
      "hosted-memory-journal@example.com",
    );
    const actor = store.createSession({
      profileId: profile.id,
      projectId: project.id,
      preset: "high",
      fastEnabled: false,
    });
    const identity = createPortableProjectMemoryCanonicalIdentity(project.id);
    const genesisToken = testDigest("hosted genesis token");
    const initialRemote = {
      genesisToken,
      head: PROJECT_MEMORY_EMPTY_HEAD,
      headProofDigest: testDigest("hosted genesis proof"),
      headToken: genesisToken,
      keyVersion: 1,
      revision: 1,
    } as const;
    const attached = store.attachCanonicalMemoryHostedSpace({
      accountBindingDigest: testDigest("hosted owner account"),
      canonicalSpaceId: identity.canonicalSpaceId,
      projectId: project.id,
      remote: initialRemote,
      remoteSpaceId: `memory_${"a".repeat(32)}`,
    });
    expect(attached).toMatchObject({ generation: 1, revision: 1, state: "attached" });
    const reserved = store.readProjectMemoryAuthority(project.id);
    if (reserved === null) throw new Error("Expected hosted attach to reserve memory authority.");
    expect(reserved).toMatchObject({
      canonicalSpaceId: identity.canonicalSpaceId,
      physicalState: "reserved",
    });
    const initialized = store.markProjectMemoryAuthorityInitialized({
      expectedHead: reserved.head,
      expectedRevision: reserved.revision,
      projectId: project.id,
    });
    const localHead = {
      sequence: 1,
      operationSha256: testDigest("hosted local operation"),
      headDigest: testDigest("hosted local head"),
    } as const;
    const advanced = store.compareAndSwapProjectMemoryHead({
      expectedHead: initialized.head,
      expectedRevision: initialized.revision,
      nextHead: localHead,
      projectId: project.id,
    });
    const terminalShareInput = {
      actorSessionId: actor.id,
      projectId: project.id,
      kind: "share" as const,
      requestDigest: testDigest("terminal hosted share request"),
      contentDigest: testDigest("terminal hosted share content"),
      keyDigest: testDigest("terminal hosted share key"),
      workingBindingDigest: testDigest("terminal hosted share working binding"),
      workingEpoch: 1,
      expectedHead: localHead,
      idempotencyKey: peerIdempotencyKey(87_999),
    };
    const cancelledShare = store.cancelPreparedMemorySubmission(
      store.prepareMemorySubmission(terminalShareInput).record.id,
    );
    expect(cancelledShare.state).toBe("cancelled");
    const localHeadToken = testDigest("hosted local head token");
    const requestOperation = {
      adoptionProof: testCanonicalMemoryEnvelope("PRIVATE HOSTED ADOPTION PROOF"),
      genesisToken,
      headToken: localHeadToken,
      operation: testCanonicalMemoryEnvelope("PRIVATE HOSTED OPERATION"),
      priorToken: genesisToken,
      sequence: 1,
      terminalHeadProof: testCanonicalMemoryEnvelope("PRIVATE HOSTED HEAD PROOF"),
    } as const;
    const idempotencyKey = peerIdempotencyKey(88_001);
    const prepared = store.prepareCanonicalMemorySync({
      direction: "push",
      idempotencyKey,
      localHeadToken,
      projectId: project.id,
      requestOperation,
    });
    expect(prepared).toMatchObject({
      replay: false,
      record: {
        attachmentGeneration: attached.generation,
        attachmentRevision: attached.revision,
        authorityRevision: advanced.revision,
        requestOperation,
        state: "prepared",
      },
    });
    expect(store.isCanonicalMemoryMutationFenced(project.id)).toBe(true);
    expect(store.prepareMemorySubmission(terminalShareInput)).toMatchObject({
      record: { id: cancelledShare.id, state: "cancelled" },
      replay: true,
    });
    expect(() => store.prepareMemorySubmission({
      ...terminalShareInput,
      idempotencyKey: peerIdempotencyKey(88_099),
      requestDigest: testDigest("new fenced hosted share request"),
    })).toThrow("CANONICAL_MEMORY_SYNC_RECOVERY_REQUIRED");
    const fencedWriter = new Database(store.paths.database, { create: false, strict: true });
    fencedWriter.exec("PRAGMA foreign_keys=ON");
    try {
      expect(() => fencedWriter.query(
        `INSERT INTO memory_submissions
         SELECT ?,?,kind,actor_session_id,project_id,request_digest,content_digest,
           key_digest,working_binding_digest,working_epoch,effect_record_sha256,
           attestation_sha256,operation_id,source_head_sequence,
           source_head_operation_sha256,source_head_digest,nomination_sha256,
           expected_head_sequence,expected_head_operation_sha256,expected_head_digest,
           result_head_sequence,result_head_operation_sha256,result_head_digest,
           receipt_digest,outcome_code,conflict_actual_head_sequence,
           conflict_actual_head_operation_sha256,conflict_actual_head_digest,
           conflict_canonical_record_sha256,conflict_nominated_record_sha256,
           'prepared',created_at,updated_at
         FROM memory_submissions WHERE id=?`,
      ).run(
        `memsub_${"f".repeat(32)}`,
        peerIdempotencyKey(88_100),
        cancelledShare.id,
      )).toThrow("canonical memory mutation fenced by hosted sync");
    } finally {
      fencedWriter.close(false);
    }
    expect(() => store.detachCanonicalMemoryHostedSpace({
      expectedGeneration: attached.generation,
      projectId: project.id,
    })).toThrow("CANONICAL_MEMORY_SYNC_RECOVERY_REQUIRED");
    expect(() => store.compareAndSwapProjectMemoryHead({
      expectedHead: localHead,
      expectedRevision: advanced.revision,
      nextHead: {
        sequence: 2,
        operationSha256: testDigest("fenced operation"),
        headDigest: testDigest("fenced head"),
      },
      projectId: project.id,
    })).toThrow("canonical memory mutation fenced by hosted sync");

    const begun = store.markCanonicalMemorySyncEffectStarted(prepared.record.id);
    expect(begun).toMatchObject({ effectStartedAt: expect.any(Number), state: "effect_started" });
    const responseRemote = {
      genesisToken,
      head: localHead,
      headProofDigest: testDigest("hosted accepted proof"),
      headToken: localHeadToken,
      keyVersion: 1,
      revision: 1,
    } as const;
    const observed = store.recordCanonicalMemorySyncResponse({
      intentId: prepared.record.id,
      remote: responseRemote,
    });
    expect(observed).toMatchObject({
      responseObservation: responseRemote,
      state: "response_observed",
    });
    const settled = store.settleCanonicalMemorySync({
      intentId: prepared.record.id,
      resultHead: localHead,
    });
    expect(settled).toMatchObject({ resultHead: localHead, state: "settled" });
    expect(store.isCanonicalMemoryMutationFenced(project.id)).toBe(false);
    expect(store.readProjectMemoryAuthority(project.id)).toMatchObject({
      head: localHead,
      lastExchangeHead: localHead,
      syncState: "settled",
    });
    expect(store.prepareCanonicalMemorySync({
      direction: "push",
      idempotencyKey,
      localHeadToken,
      projectId: project.id,
      requestOperation,
    })).toMatchObject({ replay: true, record: { id: prepared.record.id } });
    expect(() => store.prepareCanonicalMemorySync({
      direction: "push",
      idempotencyKey,
      localHeadToken,
      projectId: project.id,
      requestOperation: {
        ...requestOperation,
        adoptionProof: testCanonicalMemoryEnvelope("DIFFERENT HOSTED ADOPTION PROOF"),
      },
    })).toThrow("CANONICAL_MEMORY_SYNC_IDEMPOTENCY_CONFLICT");

    const inspector = new Database(store.paths.database, { readonly: true, strict: true });
    try {
      const retained = JSON.stringify({
        attachment: inspector.query("SELECT * FROM project_memory_hosted_attachments").get(),
        intent: inspector.query("SELECT * FROM project_memory_sync_intents").get(),
        spool: inspector.query("SELECT * FROM project_memory_sync_spool").get(),
      });
      expect(retained).not.toContain(root);
      expect(retained).not.toContain("PRIVATE HOSTED OPERATION");
      expect(retained).not.toContain("PRIVATE HOSTED HEAD PROOF");
      expect(retained).not.toContain("PRIVATE HOSTED ADOPTION PROOF");
    } finally {
      inspector.close(false);
    }
    const settledAuthority = store.readProjectMemoryAuthority(project.id);
    if (settledAuthority === null) throw new Error("Expected settled hosted authority.");
    const secondLocalHead = {
      sequence: 2,
      operationSha256: testDigest("second hosted local operation"),
      headDigest: testDigest("second hosted local head"),
    } as const;
    store.compareAndSwapProjectMemoryHead({
      expectedHead: settledAuthority.head,
      expectedRevision: settledAuthority.revision,
      nextHead: secondLocalHead,
      projectId: project.id,
    });
    now += 30 * 24 * 60 * 60_000 + 1;
    const retainedPreparation = store.prepareCanonicalMemorySync({
      direction: "push",
      idempotencyKey: peerIdempotencyKey(88_101),
      localHeadToken: testDigest("second hosted local head token"),
      projectId: project.id,
      requestOperation: {
        adoptionProof: null,
        genesisToken,
        headToken: testDigest("second hosted local head token"),
        operation: testCanonicalMemoryEnvelope("SECOND PRIVATE HOSTED OPERATION"),
        priorToken: localHeadToken,
        sequence: 2,
        terminalHeadProof: testCanonicalMemoryEnvelope("SECOND PRIVATE HOSTED HEAD PROOF"),
      },
    });
    expect(store.readCanonicalMemorySyncIntent(prepared.record.id)).toBeNull();
    const retentionInspector = new Database(
      store.paths.database,
      { readonly: true, strict: true },
    );
    try {
      expect(retentionInspector.query(
        "SELECT COUNT(*) AS count FROM project_memory_sync_spool WHERE intent_id=?",
      ).get(prepared.record.id)).toEqual({ count: 0 });
    } finally {
      retentionInspector.close(false);
    }
    const tamperWriter = new Database(store.paths.database, { create: false, strict: true });
    try {
      const guard = z.object({ sql: z.string() }).strict().parse(tamperWriter.query(
        `SELECT sql FROM sqlite_master
         WHERE type='trigger' AND name='project_memory_sync_spool_update_guard'`,
      ).get());
      tamperWriter.exec("DROP TRIGGER project_memory_sync_spool_update_guard");
      expect(() => tamperWriter.query(
        `UPDATE project_memory_sync_spool SET adoption_proof_algorithm='A256GCM'
         WHERE intent_id=? AND phase='request'`,
      ).run(retainedPreparation.record.id)).toThrow();
      tamperWriter.query(
        `UPDATE project_memory_sync_spool SET operation_digest=?
         WHERE intent_id=? AND phase='request'`,
      ).run("f".repeat(64), retainedPreparation.record.id);
      tamperWriter.exec(guard.sql);
    } finally {
      tamperWriter.close(false);
    }
    expect(() => store.readCanonicalMemorySyncIntent(retainedPreparation.record.id))
      .toThrow("CANONICAL_MEMORY_SYNC_SPOOL_INVALID");
  });

  test("migrates v40 to the exact hosted-memory journal and repairs writable tampering", async () => {
    const { store, home } = await fixture();
    const root = join(home, "hosted-memory-v40-migration");
    await mkdir(root);
    const project = await store.createProject("Hosted memory v40 migration", root);
    const paths = store.paths;
    store.close();
    stores.splice(stores.indexOf(store), 1);

    const legacy = new Database(paths.database, { create: false, strict: true });
    legacy.exec(`
      PRAGMA foreign_keys=OFF;
      DROP TRIGGER IF EXISTS canonical_memory_sync_share_fence;
      DROP TRIGGER IF EXISTS project_memory_sync_authority_fence;
      DROP TABLE project_memory_sync_spool;
      DROP TABLE project_memory_sync_intents;
      DROP TABLE project_memory_hosted_attachments;
      DROP TABLE project_memory_hosted_create_intents;
      DELETE FROM migrations WHERE version=41;
      PRAGMA user_version=40;
      PRAGMA foreign_keys=ON;
    `);
    legacy.close(false);

    expect(() => new StateStore(paths, { readonly: true }))
      .toThrow("STATE_SCHEMA_MIGRATION_REQUIRED:40:41");
    const migrated = new StateStore(paths, { now: () => 5_000 });
    stores.push(migrated);
    expect(migrated.requireProject(project.id).label).toBe(project.label);
    const inspector = new Database(paths.database, { readonly: true, strict: true });
    try {
      expect(inspector.query("PRAGMA user_version").get()).toEqual({ user_version: 41 });
      expect(inspector.query(
        "SELECT applied_at FROM migrations WHERE version=41",
      ).get()).toEqual({ applied_at: 5_000 });
      expect(inspector.query(
        `SELECT name FROM sqlite_master
         WHERE name IN ('project_memory_hosted_attachments',
           'project_memory_hosted_create_intents','project_memory_sync_intents',
           'project_memory_sync_spool','canonical_memory_sync_share_fence')
         ORDER BY name`,
      ).all()).toEqual([
        { name: "canonical_memory_sync_share_fence" },
        { name: "project_memory_hosted_attachments" },
        { name: "project_memory_hosted_create_intents" },
        { name: "project_memory_sync_intents" },
        { name: "project_memory_sync_spool" },
      ]);
      expect(inspector.query("PRAGMA table_info(project_memory_sync_spool)").all()
        .filter((column) => z.object({ name: z.string() }).passthrough().parse(column)
          .name.startsWith("adoption_proof_"))
        .map((column) => {
          const parsed = z.object({ name: z.string(), notnull: z.number().int() })
            .passthrough().parse(column);
          return { name: parsed.name, notnull: parsed.notnull };
        })).toEqual([
        { name: "adoption_proof_algorithm", notnull: 0 },
        { name: "adoption_proof_ciphertext", notnull: 0 },
        { name: "adoption_proof_key_version", notnull: 0 },
        { name: "adoption_proof_nonce", notnull: 0 },
      ]);
    } finally {
      inspector.close(false);
    }
    migrated.close();
    stores.splice(stores.indexOf(migrated), 1);

    const weakened = new Database(paths.database, { create: false, strict: true });
    weakened.exec(`
      DROP TRIGGER canonical_memory_sync_share_fence;
      CREATE TRIGGER canonical_memory_sync_share_fence
      BEFORE INSERT ON memory_submissions BEGIN SELECT 1; END;
    `);
    weakened.close(false);
    expect(() => new StateStore(paths, { readonly: true }))
      .toThrow("STATE_SCHEMA_V41_STRUCTURE_INVALID");
    const repaired = new StateStore(paths, { now: () => 6_000 });
    stores.push(repaired);
    repaired.close();
    stores.splice(stores.indexOf(repaired), 1);
    const readonly = new StateStore(paths, { readonly: true });
    stores.push(readonly);
    expect(readonly.requireProject(project.id).label).toBe(project.label);
  });

  test("imports one encrypted pull operation and settles only after pinned revalidation", async () => {
    const { store, home } = await fixture();
    const root = join(home, "hosted-memory-pull");
    await mkdir(root);
    const project = await store.createProject("Hosted memory pull", root);
    const identity = createPortableProjectMemoryCanonicalIdentity(project.id);
    const genesisToken = testDigest("pull genesis");
    const remoteHead = {
      sequence: 1,
      operationSha256: testDigest("pull operation sha"),
      headDigest: testDigest("pull raw head"),
    } as const;
    const initialRemote = {
      genesisToken,
      head: PROJECT_MEMORY_EMPTY_HEAD,
      headProofDigest: testDigest("pull genesis proof"),
      headToken: genesisToken,
      keyVersion: 3,
      revision: 7,
    } as const;
    const remote = {
      genesisToken,
      head: remoteHead,
      headProofDigest: testDigest("pull terminal proof"),
      headToken: testDigest("pull terminal token"),
      keyVersion: 3,
      revision: 7,
    } as const;
    const attached = store.attachCanonicalMemoryHostedSpace({
      accountBindingDigest: testDigest("pull account"),
      canonicalSpaceId: identity.canonicalSpaceId,
      projectId: project.id,
      remote: initialRemote,
      remoteSpaceId: `memory_${"b".repeat(32)}`,
    });
    const reserved = store.readProjectMemoryAuthority(project.id);
    if (reserved === null) throw new Error("Expected pull authority reservation.");
    store.markProjectMemoryAuthorityInitialized({
      expectedHead: reserved.head,
      expectedRevision: reserved.revision,
      projectId: project.id,
    });
    const observedRemoteAdvance = store.recordCanonicalMemoryHostedObservation({
      expectedGeneration: attached.generation,
      expectedRevision: attached.revision,
      projectId: project.id,
      remote,
    });
    expect(observedRemoteAdvance).toMatchObject({
      generation: attached.generation,
      remote,
      revision: attached.revision + 1,
      state: "attached",
    });
    expect(() => store.recordCanonicalMemoryHostedObservation({
      expectedGeneration: attached.generation,
      expectedRevision: attached.revision,
      projectId: project.id,
      remote,
    })).toThrow("CANONICAL_MEMORY_HOSTED_OBSERVATION_CONFLICT");
    const prepared = store.prepareCanonicalMemorySync({
      direction: "pull",
      idempotencyKey: peerIdempotencyKey(88_002),
      localHeadToken: genesisToken,
      projectId: project.id,
    }).record;
    expect(() => store.recordCanonicalMemoryHostedObservation({
      expectedGeneration: observedRemoteAdvance.generation,
      expectedRevision: observedRemoteAdvance.revision,
      projectId: project.id,
      remote: {
        ...remote,
        head: {
          sequence: 2,
          operationSha256: testDigest("later pull operation sha"),
          headDigest: testDigest("later pull raw head"),
        },
        headProofDigest: testDigest("later pull terminal proof"),
        headToken: testDigest("later pull terminal token"),
      },
    })).toThrow("CANONICAL_MEMORY_SYNC_RECOVERY_REQUIRED");
    store.markCanonicalMemorySyncEffectStarted(prepared.id);
    const operation = {
      adoptionProof: testCanonicalMemoryEnvelope("PULL ADOPTION PROOF CIPHERTEXT", 3),
      genesisToken,
      headToken: remote.headToken,
      operation: testCanonicalMemoryEnvelope("PULL OPERATION CIPHERTEXT", 3),
      priorToken: genesisToken,
      sequence: 1,
      terminalHeadProof: testCanonicalMemoryEnvelope("PULL HEAD CIPHERTEXT", 3),
    } as const;
    expect(store.recordCanonicalMemorySyncResponse({
      intentId: prepared.id,
      operation,
      remote,
    })).toMatchObject({ responseOperation: operation, state: "response_observed" });
    expect(store.recordCanonicalMemorySyncResponse({
      intentId: prepared.id,
      operation,
      remote,
    })).toMatchObject({ responseOperation: operation, state: "response_observed" });
    expect(() => store.recordCanonicalMemorySyncResponse({
      intentId: prepared.id,
      operation: {
        ...operation,
        adoptionProof: testCanonicalMemoryEnvelope("DIFFERENT PULL ADOPTION PROOF", 3),
      },
      remote,
    })).toThrow("CANONICAL_MEMORY_SYNC_RESPONSE_CONFLICT");
    expect(store.isCanonicalMemoryPhysicalHeadAuthorized({
      canonicalBindingDigest: identity.bindingDigest,
      controlHead: PROJECT_MEMORY_EMPTY_HEAD,
      observedHead: remoteHead,
      projectId: project.id,
    })).toBe(false);
    expect(() => store.settleCanonicalMemorySync({
      intentId: prepared.id,
      resultHead: remoteHead,
    })).toThrow("CANONICAL_MEMORY_SYNC_SETTLEMENT_INVALID");
    const authorized = store.authorizeCanonicalMemoryPullResult({
      intentId: prepared.id,
      resultHead: remoteHead,
    });
    expect(authorized).toMatchObject({
      resultHead: remoteHead,
      state: "response_observed",
    });
    expect(store.isCanonicalMemoryPhysicalHeadAuthorized({
      canonicalBindingDigest: identity.bindingDigest,
      controlHead: PROJECT_MEMORY_EMPTY_HEAD,
      observedHead: remoteHead,
      projectId: project.id,
    })).toBe(true);
    expect(store.isCanonicalMemoryPhysicalHeadAuthorized({
      canonicalBindingDigest: testDigest("hostile pull binding"),
      controlHead: PROJECT_MEMORY_EMPTY_HEAD,
      observedHead: remoteHead,
      projectId: project.id,
    })).toBe(false);
    expect(store.isCanonicalMemoryPhysicalHeadAuthorized({
      canonicalBindingDigest: identity.bindingDigest,
      controlHead: {
        sequence: 1,
        operationSha256: testDigest("hostile stale control operation"),
        headDigest: testDigest("hostile stale control head"),
      },
      observedHead: remoteHead,
      projectId: project.id,
    })).toBe(false);
    expect(store.isCanonicalMemoryPhysicalHeadAuthorized({
      canonicalBindingDigest: identity.bindingDigest,
      controlHead: PROJECT_MEMORY_EMPTY_HEAD,
      observedHead: {
        ...remoteHead,
        headDigest: testDigest("hostile observed pull head"),
      },
      projectId: project.id,
    })).toBe(false);
    expect(store.authorizeCanonicalMemoryPullResult({
      intentId: prepared.id,
      resultHead: remoteHead,
    })).toEqual(authorized);
    expect(() => store.authorizeCanonicalMemoryPullResult({
      intentId: prepared.id,
      resultHead: {
        ...remoteHead,
        headDigest: testDigest("different authorized pull result"),
      },
    })).toThrow("CANONICAL_MEMORY_SYNC_RESULT_AUTHORIZATION_CONFLICT");
    expect(store.settleCanonicalMemorySync({
      intentId: prepared.id,
      resultHead: remoteHead,
    })).toMatchObject({ resultHead: remoteHead, state: "settled" });
    expect(store.readProjectMemoryAuthority(project.id)).toMatchObject({
      head: remoteHead,
      lastExchangeHead: remoteHead,
      syncState: "settled",
    });
    expect(store.isCanonicalMemoryPhysicalHeadAuthorized({
      canonicalBindingDigest: identity.bindingDigest,
      controlHead: PROJECT_MEMORY_EMPTY_HEAD,
      observedHead: remoteHead,
      projectId: project.id,
    })).toBe(true);
  });

  test("freezes equal-sequence pull disagreement before preparing an effect", async () => {
    const { store, home } = await fixture();
    for (const [index, disagreement] of ["token", "raw-head"].entries()) {
      const root = join(home, `hosted-memory-equal-${disagreement}`);
      await mkdir(root);
      const project = await store.createProject(`Hosted equal ${disagreement}`, root);
      const identity = createPortableProjectMemoryCanonicalIdentity(project.id);
      const genesisToken = testDigest(`equal ${disagreement} genesis`);
      const remoteHead = {
        sequence: 1,
        operationSha256: testDigest(`equal ${disagreement} remote operation`),
        headDigest: testDigest(`equal ${disagreement} remote head`),
      } as const;
      const remote = {
        genesisToken,
        head: remoteHead,
        headProofDigest: testDigest(`equal ${disagreement} proof`),
        headToken: testDigest(`equal ${disagreement} remote token`),
        keyVersion: 1,
        revision: 1,
      } as const;
      store.attachCanonicalMemoryHostedSpace({
        accountBindingDigest: testDigest(`equal ${disagreement} account`),
        canonicalSpaceId: identity.canonicalSpaceId,
        projectId: project.id,
        remote,
        remoteSpaceId: `memory_${String(index + 4).repeat(32)}`,
      });
      const reserved = store.readProjectMemoryAuthority(project.id);
      if (reserved === null) throw new Error("Expected equal-sequence authority reservation.");
      const initialized = store.markProjectMemoryAuthorityInitialized({
        expectedHead: reserved.head,
        expectedRevision: reserved.revision,
        projectId: project.id,
      });
      const localHead = disagreement === "raw-head"
        ? {
            sequence: 1,
            operationSha256: testDigest("different equal-sequence local operation"),
            headDigest: testDigest("different equal-sequence local head"),
          }
        : remoteHead;
      store.compareAndSwapProjectMemoryHead({
        expectedHead: initialized.head,
        expectedRevision: initialized.revision,
        nextHead: localHead,
        projectId: project.id,
      });
      expect(() => store.prepareCanonicalMemorySync({
        direction: "pull",
        idempotencyKey: peerIdempotencyKey(88_020 + index),
        localHeadToken: disagreement === "token"
          ? testDigest("different equal-sequence local token")
          : remote.headToken,
        projectId: project.id,
      })).toThrow("CANONICAL_MEMORY_SYNC_EQUAL_SEQUENCE_CONFLICT");
      expect(store.readUnresolvedCanonicalMemorySyncIntent(project.id)).toBeNull();
      expect(store.readCanonicalMemoryHostedAttachment(project.id)).toMatchObject({
        diagnosticCode: "REMOTE_MEMORY_EQUAL_SEQUENCE_CONFLICT",
        state: "conflict",
      });
      expect(store.readProjectMemoryAuthority(project.id)).toMatchObject({
        diagnosticCode: "REMOTE_MEMORY_EQUAL_SEQUENCE_CONFLICT",
        lastExchangeHead: remoteHead,
        syncState: "conflict",
      });
      expect(store.isCanonicalMemoryMutationFenced(project.id)).toBe(true);
    }
  });

  test("freezes hosted configuration drift and same-sequence observation divergence", async () => {
    const { store, home } = await fixture();
    const variants = ["genesis", "revision", "key", "same-sequence"] as const;
    for (const [index, variant] of variants.entries()) {
      const root = join(home, `hosted-memory-observation-${variant}`);
      await mkdir(root);
      const project = await store.createProject(`Hosted observation ${variant}`, root);
      const identity = createPortableProjectMemoryCanonicalIdentity(project.id);
      const genesisToken = testDigest(`observation ${variant} genesis`);
      const remote = {
        genesisToken,
        head: PROJECT_MEMORY_EMPTY_HEAD,
        headProofDigest: testDigest(`observation ${variant} proof`),
        headToken: genesisToken,
        keyVersion: 1,
        revision: 1,
      } as const;
      const attached = store.attachCanonicalMemoryHostedSpace({
        accountBindingDigest: testDigest(`observation ${variant} account`),
        canonicalSpaceId: identity.canonicalSpaceId,
        projectId: project.id,
        remote,
        remoteSpaceId: `memory_${String(index + 6).repeat(32)}`,
      });
      const reserved = store.readProjectMemoryAuthority(project.id);
      if (reserved === null) throw new Error("Expected observation authority reservation.");
      store.markProjectMemoryAuthorityInitialized({
        expectedHead: reserved.head,
        expectedRevision: reserved.revision,
        projectId: project.id,
      });
      const differentGenesis = testDigest(`different observation ${variant} genesis`);
      const changedRemote = variant === "genesis"
        ? { ...remote, genesisToken: differentGenesis, headToken: differentGenesis }
        : variant === "revision"
          ? { ...remote, revision: 2 }
          : variant === "key"
            ? { ...remote, keyVersion: 2 }
            : {
                ...remote,
                headProofDigest: testDigest("divergent same-sequence observation proof"),
              };
      expect(() => store.recordCanonicalMemoryHostedObservation({
        expectedGeneration: attached.generation,
        expectedRevision: attached.revision,
        projectId: project.id,
        remote: changedRemote,
      })).toThrow("CANONICAL_MEMORY_HOSTED_OBSERVATION_CONFLICT");
      const diagnosticCode = variant === "same-sequence"
        ? "REMOTE_MEMORY_HEAD_CONFLICT"
        : "REMOTE_MEMORY_CONFIGURATION_CONFLICT";
      expect(store.readCanonicalMemoryHostedAttachment(project.id)).toMatchObject({
        diagnosticCode,
        state: "conflict",
      });
      expect(store.readProjectMemoryAuthority(project.id)).toMatchObject({
        diagnosticCode,
        syncState: "conflict",
      });
      expect(store.isCanonicalMemoryMutationFenced(project.id)).toBe(true);
    }
  });

  test("preserves permanent hosted identity across detach and freezes sticky failure", async () => {
    const { store, home } = await fixture();
    const root = join(home, "hosted-memory-detach");
    await mkdir(root);
    const project = await store.createProject("Hosted memory detach", root);
    const identity = createPortableProjectMemoryCanonicalIdentity(project.id);
    const genesisToken = testDigest("detach genesis");
    const remote = {
      genesisToken,
      head: PROJECT_MEMORY_EMPTY_HEAD,
      headProofDigest: testDigest("detach proof"),
      headToken: genesisToken,
      keyVersion: 1,
      revision: 1,
    } as const;
    expect(() => store.attachCanonicalMemoryHostedSpace({
      accountBindingDigest: testDigest("detach account"),
      canonicalSpaceId: identity.canonicalSpaceId,
      projectId: project.id,
      remote,
      remoteSpaceId: "memory_short",
    })).toThrow();
    const attached = store.attachCanonicalMemoryHostedSpace({
      accountBindingDigest: testDigest("detach account"),
      canonicalSpaceId: identity.canonicalSpaceId,
      projectId: project.id,
      remote,
      remoteSpaceId: `memory_${"c".repeat(32)}`,
    });
    const detached = store.detachCanonicalMemoryHostedSpace({
      expectedGeneration: attached.generation,
      projectId: project.id,
    });
    expect(detached).toMatchObject({ generation: 2, state: "detached" });
    expect(() => store.attachCanonicalMemoryHostedSpace({
      accountBindingDigest: testDigest("detach account"),
      canonicalSpaceId: identity.canonicalSpaceId,
      projectId: project.id,
      remote,
      remoteSpaceId: `memory_${"d".repeat(32)}`,
    })).toThrow("CANONICAL_MEMORY_HOSTED_REBIND_REFUSED");
    const reattached = store.attachCanonicalMemoryHostedSpace({
      accountBindingDigest: testDigest("detach account"),
      canonicalSpaceId: identity.canonicalSpaceId,
      projectId: project.id,
      remote,
      remoteSpaceId: `memory_${"c".repeat(32)}`,
    });
    expect(reattached).toMatchObject({ generation: 3, state: "attached" });
    const reserved = store.readProjectMemoryAuthority(project.id);
    if (reserved === null) throw new Error("Expected detached identity authority.");
    store.markProjectMemoryAuthorityInitialized({
      expectedHead: reserved.head,
      expectedRevision: reserved.revision,
      projectId: project.id,
    });
    const intent = store.prepareCanonicalMemorySync({
      direction: "pull",
      idempotencyKey: peerIdempotencyKey(88_003),
      localHeadToken: genesisToken,
      projectId: project.id,
    }).record;
    const failed = store.failCanonicalMemorySync({
      diagnosticCode: "REMOTE_MEMORY_ERASED",
      intentId: intent.id,
      state: "error",
    });
    expect(failed).toMatchObject({
      diagnosticCode: "REMOTE_MEMORY_ERASED",
      state: "error",
    });
    expect(store.failCanonicalMemorySync({
      diagnosticCode: "REMOTE_MEMORY_ERASED",
      intentId: intent.id,
      state: "error",
    })).toEqual(failed);
    expect(store.isCanonicalMemoryMutationFenced(project.id)).toBe(true);
    expect(store.readCanonicalMemoryHostedAttachment(project.id)).toMatchObject({
      diagnosticCode: "REMOTE_MEMORY_ERASED",
      remoteSpaceId: `memory_${"c".repeat(32)}`,
      state: "error",
    });
    expect(() => store.detachCanonicalMemoryHostedSpace({
      expectedGeneration: reattached.generation,
      projectId: project.id,
    })).toThrow("CANONICAL_MEMORY_HOSTED_ATTACHMENT_FROZEN");
    expect(() => store.prepareCanonicalMemorySync({
      direction: "pull",
      idempotencyKey: peerIdempotencyKey(88_004),
      localHeadToken: genesisToken,
      projectId: project.id,
    })).toThrow("CANONICAL_MEMORY_HOSTED_ATTACHMENT_NOT_ACTIVE");

    const writer = new Database(store.paths.database, { create: false, strict: true });
    writer.exec("PRAGMA foreign_keys=ON");
    expect(() => writer.query(
      "DELETE FROM project_memory_hosted_attachments WHERE project_id=?",
    ).run(project.id)).toThrow();
    expect(() => writer.query(
      `UPDATE project_memory_hosted_attachments
       SET state='attached',diagnostic_code=NULL,revision=revision+1 WHERE project_id=?`,
    ).run(project.id)).toThrow();
    writer.close(false);
  });

  test("freezes a missing hosted attachment before any sync intent exists", async () => {
    const { store, home } = await fixture();
    const root = join(home, "hosted-memory-pre-intent-failure");
    await mkdir(root);
    const project = await store.createProject("Hosted memory pre-intent failure", root);
    const identity = createPortableProjectMemoryCanonicalIdentity(project.id);
    const genesisToken = testDigest("pre-intent failure genesis");
    const remote = {
      genesisToken,
      head: PROJECT_MEMORY_EMPTY_HEAD,
      headProofDigest: testDigest("pre-intent failure proof"),
      headToken: genesisToken,
      keyVersion: 1,
      revision: 1,
    } as const;
    const attached = store.attachCanonicalMemoryHostedSpace({
      accountBindingDigest: testDigest("pre-intent failure account"),
      canonicalSpaceId: identity.canonicalSpaceId,
      projectId: project.id,
      remote,
      remoteSpaceId: `memory_${"e".repeat(32)}`,
    });
    const reserved = store.readProjectMemoryAuthority(project.id);
    if (reserved === null) throw new Error("Expected a reserved project authority.");
    store.markProjectMemoryAuthorityInitialized({
      expectedHead: reserved.head,
      expectedRevision: reserved.revision,
      projectId: project.id,
    });

    const failed = store.failCanonicalMemoryHostedAttachment({
      diagnosticCode: "REMOTE_MEMORY_ERASED",
      expectedGeneration: attached.generation,
      expectedRevision: attached.revision,
      projectId: project.id,
      state: "error",
    });
    expect(failed).toMatchObject({
      diagnosticCode: "REMOTE_MEMORY_ERASED",
      revision: attached.revision + 1,
      state: "error",
    });
    expect(store.failCanonicalMemoryHostedAttachment({
      diagnosticCode: "REMOTE_MEMORY_ERASED",
      expectedGeneration: attached.generation,
      expectedRevision: attached.revision,
      projectId: project.id,
      state: "error",
    })).toEqual(failed);
    expect(store.readProjectMemoryAuthority(project.id)).toMatchObject({
      diagnosticCode: "REMOTE_MEMORY_ERASED",
      syncState: "error",
    });
    expect(store.isCanonicalMemoryMutationFenced(project.id)).toBe(true);
  });

  test("keeps compact page attestations across journal GC and releases them with exact lane refs", async () => {
    let now = 10_000;
    const { store, home } = await fixture({ now: () => now });
    const root = join(home, "memory-attestation-retention");
    await mkdir(root);
    const project = await store.createProject("Memory attestation retention", root);
    const profile = signInProfile(store, "Memory attestation retention", "attest@example.com");
    const actor = store.createSession({
      profileId: profile.id,
      projectId: project.id,
      preset: "high",
      fastEnabled: false,
    });
    const emptyHead = PROJECT_MEMORY_EMPTY_HEAD;
    const authorityDigest = reserveTestProjectMemoryAuthority(
      store,
      project.id,
      emptyHead,
    ).authorityDigest;
    const workingBindingDigest = testDigest("attestation working binding");
    const remember = (
      index: number,
      expectedHead: typeof emptyHead | Readonly<{
        sequence: number;
        operationSha256: string;
        headDigest: string;
      }>,
    ) => {
      const keyDigest = testDigest(`attestation key ${String(index)}`);
      const contentDigest = testDigest(`attestation content ${String(index)}`);
      const effectRecordSha256 = testDigest(`attestation record ${String(index)}`);
      const attestationSha256 = testDigest(`attestation evidence ${String(index)}`);
      const record = store.prepareMemorySubmission({
        actorSessionId: actor.id,
        projectId: project.id,
        kind: "remember",
        requestDigest: testDigest(`attestation request ${String(index)}`),
        contentDigest,
        keyDigest,
        workingBindingDigest,
        workingEpoch: 1,
        expectedHead,
        idempotencyKey: peerIdempotencyKey(60_000 + index),
      }).record;
      store.bindMemorySubmissionEffect({
        submissionId: record.id,
        effectRecordSha256,
        attestationSha256,
        operationId: `memory_attestation_${String(index)}`,
      });
      store.beginMemorySubmission(record.id);
      const resultHead = {
        sequence: expectedHead.sequence + 1,
        operationSha256: testDigest(`attestation operation ${String(index)}`),
        headDigest: testDigest(`attestation head ${String(index)}`),
      };
      store.settleMemorySubmission({
        submissionId: record.id,
        expectedState: "effect_started",
        state: "applied",
        outcomeCode: "remember_committed",
        resultHead,
        receiptDigest: testDigest(`attestation receipt ${String(index)}`),
      });
      return {
        attestationSha256,
        contentDigest,
        effectRecordSha256,
        idempotencyKey: record.idempotencyKey,
        keyDigest,
        resultHead,
      };
    };
    const first = remember(0, emptyHead);
    const second = remember(1, first.resultHead);
    expect(store.findMemoryPageAttestation(first.attestationSha256)).toMatchObject({
      actorSessionId: actor.id,
      projectId: project.id,
      keyDigest: first.keyDigest,
    });
    expect(store.isMemoryPageAttestationReferenced({
      attestationSha256: first.attestationSha256,
      authorityDigest: workingBindingDigest,
      keyDigest: first.keyDigest,
      lane: "working",
      projectId: project.id,
    })).toBe(true);

    const share = store.prepareMemorySubmission({
      actorSessionId: actor.id,
      projectId: project.id,
      kind: "share",
      requestDigest: testDigest("attestation share request"),
      contentDigest: first.contentDigest,
      keyDigest: first.keyDigest,
      workingBindingDigest,
      workingEpoch: 1,
      expectedHead: emptyHead,
      idempotencyKey: peerIdempotencyKey(60_100),
    }).record;
    store.bindMemorySubmissionEffect({
      submissionId: share.id,
      effectRecordSha256: first.effectRecordSha256,
      attestationSha256: first.attestationSha256,
      operationId: "memory_adopt_attestation",
      sourceHead: second.resultHead,
      nominationSha256: testDigest("attestation nomination"),
    });
    store.beginMemorySubmission(share.id);
    const canonicalHead = {
      sequence: 1,
      operationSha256: testDigest("attestation canonical operation"),
      headDigest: testDigest("attestation canonical head"),
    } as const;
    store.settleMemorySubmission({
      submissionId: share.id,
      expectedState: "effect_started",
      state: "applied",
      outcomeCode: "share_adopted",
      resultHead: canonicalHead,
      receiptDigest: testDigest("attestation share receipt"),
    });
    expect(store.isMemoryPageAttestationReferenced({
      attestationSha256: first.attestationSha256,
      authorityDigest,
      keyDigest: first.keyDigest,
      lane: "canonical",
      projectId: project.id,
    })).toBe(true);
    const portableProof = store.readCanonicalMemoryPortableAdoptionProof({
      operationSha256: canonicalHead.operationSha256,
      projectId: project.id,
      sequence: canonicalHead.sequence,
    });
    expect(portableProof).toMatchObject({
      bindingDigest: store.readProjectMemoryAuthority(project.id)?.bindingDigest,
      canonicalSpaceId: store.readProjectMemoryAuthority(project.id)?.canonicalSpaceId,
      contentDigest: first.contentDigest,
      keyDigest: first.keyDigest,
      operationSha256: canonicalHead.operationSha256,
      projectId: project.id,
      recordSha256: first.effectRecordSha256,
      sequence: canonicalHead.sequence,
      sourceReceiptSha256: testDigest("attestation share receipt"),
    });
    expect(store.isCanonicalMemoryPortableAdoptionProofReferenced({
      bindingDigest: portableProof?.bindingDigest ?? "",
      contentDigest: first.contentDigest,
      keyDigest: first.keyDigest,
      projectId: project.id,
      recordSha256: first.effectRecordSha256,
    })).toBe(true);
    const proofWriter = new Database(store.paths.database, { create: false, strict: true });
    proofWriter.exec("PRAGMA foreign_keys=ON");
    expect(() => proofWriter.query(
      `UPDATE project_memory_portable_adoption_proofs
       SET source_receipt_sha256=? WHERE project_id=? AND sequence=?`,
    ).run(testDigest("forged receipt"), project.id, canonicalHead.sequence)).toThrow();
    expect(() => proofWriter.query(
      `DELETE FROM project_memory_portable_adoption_proofs
       WHERE project_id=? AND sequence=?`,
    ).run(project.id, canonicalHead.sequence)).toThrow();
    proofWriter.close(false);

    const childBindingDigest = testDigest("attestation child binding");
    const childSessionId = `sess_${"f".repeat(32)}`;
    const childHead = {
      sequence: 1,
      operationSha256: testDigest("attestation child fork operation"),
      digest: testDigest("attestation child fork head"),
    } as const;
    const parentHead = {
      sequence: second.resultHead.sequence,
      operationSha256: second.resultHead.operationSha256,
      digest: second.resultHead.headDigest,
    } as const;
    expect(store.reserveMemoryWorkingPageAttestationFork({
      childBindingDigest,
      childSessionId,
      parentBindingDigest: workingBindingDigest,
      parentHead,
    })).toEqual({ references: 2, state: "reserved" });
    expect(store.hasMemoryWorkingAttestationForkFromParent(workingBindingDigest)).toBe(true);
    const third = remember(2, second.resultHead);
    expect(store.reserveMemoryWorkingPageAttestationFork({
      childBindingDigest,
      childSessionId,
      parentBindingDigest: workingBindingDigest,
      parentHead,
    })).toEqual({ references: 0, state: "reserved" });
    expect(store.finalizeMemoryWorkingPageAttestationFork({
      childBindingDigest,
      childHead,
      parentBindingDigest: workingBindingDigest,
      parentHead,
    })).toBe(0);
    expect(store.hasMemoryWorkingAttestationForkFromParent(workingBindingDigest)).toBe(false);
    expect(store.reserveMemoryWorkingPageAttestationFork({
      childBindingDigest,
      childSessionId,
      parentBindingDigest: workingBindingDigest,
      parentHead,
    })).toEqual({ references: 0, state: "finalized" });
    expect(store.finalizeMemoryWorkingPageAttestationFork({
      childBindingDigest,
      childHead,
      parentBindingDigest: workingBindingDigest,
      parentHead,
    })).toBe(0);
    expect(store.readMemoryWorkingAttestationHead(childBindingDigest)).toMatchObject({
      authorityDigest: childBindingDigest,
      forkParentAuthorityDigest: workingBindingDigest,
      forkParentHead: second.resultHead,
      head: {
        sequence: childHead.sequence,
        operationSha256: childHead.operationSha256,
        headDigest: childHead.digest,
      },
      origin: "fork",
    });
    now += MEMORY_SUBMISSION_RETAIN_AGE_MS + 1;
    const pruningAdmission = store.prepareMemorySubmission({
      actorSessionId: actor.id,
      projectId: project.id,
      kind: "remember",
      requestDigest: testDigest("attestation pruning request"),
      contentDigest: testDigest("attestation pruning content"),
      keyDigest: testDigest("attestation pruning key"),
      workingBindingDigest,
      workingEpoch: 1,
      expectedHead: third.resultHead,
      idempotencyKey: peerIdempotencyKey(60_200),
    }).record;
    store.cancelPreparedMemorySubmission(pruningAdmission.id);
    expect(store.readMemorySubmissionByIdempotencyKey(first.idempotencyKey)).toBeNull();
    expect(store.findMemoryPageAttestation(first.attestationSha256)).not.toBeNull();
    expect(store.findMemoryPageAttestation(second.attestationSha256)).not.toBeNull();
    expect(store.findMemoryPageAttestation(third.attestationSha256)).not.toBeNull();

    expect(store.purgeMemoryWorkingPageAttestations({
      bindingDigest: workingBindingDigest,
    })).toBe(3);
    expect(store.findMemoryPageAttestation(second.attestationSha256)).not.toBeNull();
    expect(store.findMemoryPageAttestation(third.attestationSha256)).toBeNull();
    expect(store.purgeMemoryWorkingPageAttestations({
      bindingDigest: childBindingDigest,
    })).toBe(2);
    expect(store.findMemoryPageAttestation(second.attestationSha256)).toBeNull();
    expect(store.findMemoryPageAttestation(first.attestationSha256)).not.toBeNull();
  });

  test("pages only actor-authorized visible same-project peers in stable creation order", async () => {
    const { store, home } = await fixture({ now: () => 4_000 });
    const firstRoot = join(home, "peer-directory-a");
    const secondRoot = join(home, "peer-directory-b");
    await mkdir(firstRoot);
    await mkdir(secondRoot);
    const firstProject = await store.createProject("Peer directory A", firstRoot);
    const secondProject = await store.createProject("Peer directory B", secondRoot);
    const profile = signInProfile(store, "Peer directory account", "directory@example.com");
    const create = (projectId: typeof firstProject.id, title: string) => store.createSession({
      profileId: profile.id,
      projectId,
      title,
      preset: "high",
      fastEnabled: false,
    });
    const actorBase = create(firstProject.id, "Actor private note never projected");
    const actor = store.setSessionTurnState({
      sessionId: actorBase.id,
      expectedRevision: actorBase.revision,
      state: "active",
      activeTurnId: "peer-directory-turn",
    });
    const visible = [
      create(firstProject.id, "Visible one"),
      create(firstProject.id, "Visible two"),
    ];
    const off = create(firstProject.id, "Hidden by policy");
    store.setPeerSessionPolicy({
      sessionId: off.id,
      expectedRevision: 1,
      mode: "off",
    });
    const archived = create(firstProject.id, "Hidden by archive");
    store.setSessionArchived(archived.id, true);
    create(secondProject.id, "Hidden by project");

    expect(() => store.listPeerProjectSessionPage({
      actorSessionId: actor.id,
      actorTurnId: "wrong-turn",
      after: null,
      limit: 1,
    })).toThrow("PEER_SESSION_ACTOR_TURN_REFUSED");

    const expected = visible.map((session) => session.id).sort();
    const first = store.listPeerProjectSessionPage({
      actorSessionId: actor.id,
      actorTurnId: actor.activeTurnId!,
      after: null,
      limit: 1,
    });
    expect(first.sessions.map((session) => session.id)).toEqual(expected.slice(0, 1));
    expect(first.nextPosition).not.toBeNull();
    expect(Object.keys(first.sessions[0] ?? {}).sort()).toEqual([
      "active",
      "createdAt",
      "id",
      "policy",
      "policyRevision",
      "preset",
      "provider",
      "revision",
      "state",
      "title",
      "updatedAt",
    ]);
    const second = store.listPeerProjectSessionPage({
      actorSessionId: actor.id,
      actorTurnId: actor.activeTurnId!,
      after: first.nextPosition,
      limit: 1,
    });
    expect(second.sessions.map((session) => session.id)).toEqual(expected.slice(1));
    expect(second.nextPosition).toBeNull();

    const policy = store.requirePeerSessionPolicy(actor.id);
    store.setPeerSessionPolicy({
      sessionId: actor.id,
      expectedRevision: policy.revision,
      mode: "off",
    });
    expect(() => store.listPeerProjectSessionPage({
      actorSessionId: actor.id,
      actorTurnId: actor.activeTurnId!,
      after: null,
      limit: 50,
    })).toThrow("PEER_SESSION_POLICY_REFUSED");
    expect(() => store.listPeerProjectSessionPage({
      actorSessionId: actor.id,
      actorTurnId: actor.activeTurnId!,
      after: null,
      limit: 51,
    })).toThrow();
  });

  test("admits peer queues idempotently and preserves attributed provenance across restart", async () => {
    const { store, home } = await fixture();
    const root = join(home, "peer-project");
    await mkdir(root);
    const project = await store.createProject("Peer project", root);
    const profile = signInProfile(store, "Peer account", "peer@example.com");
    const actor = store.createSession({
      profileId: profile.id,
      projectId: project.id,
      preset: "high",
      fastEnabled: false,
    });
    const activeActor = store.setSessionTurnState({
      sessionId: actor.id,
      expectedRevision: actor.revision,
      state: "active",
      activeTurnId: "actor-turn-without-sensitive-bytes",
    });
    const targetBase = store.createSession({
      profileId: profile.id,
      projectId: project.id,
      preset: "high",
      fastEnabled: false,
    });
    const target = store.bindSession({
      sessionId: targetBase.id,
      expectedRevision: targetBase.revision,
      providerThreadId: "thread-peer-begin-authority",
      state: "idle",
    });
    const message = "PRIVATE PEER MESSAGE BODY";
    const request = {
      actorSessionId: activeActor.id,
      actorTurnId: activeActor.activeTurnId!,
      targetSessionId: target.id,
      expectedTargetRevision: target.revision,
      delivery: "queue" as const,
      requestDigest: testDigest("PRIVATE PEER REQUEST AND REASON"),
      messageDigest: testDigest(message),
      reasonDigest: testDigest("PRIVATE PEER REASON"),
      idempotencyKey: peerIdempotencyKey(9_000),
      message,
    };
    const admitted = store.admitPeerSessionAction(request);
    expect(admitted).toMatchObject({
      replay: false,
      action: {
        actorPolicyRevision: 1,
        delivery: "queue",
        hop: 1,
        projectId: project.id,
        state: "queued",
        targetPolicyRevision: 1,
      },
      queue: {
        messageActor: "peer_session",
        peerActionId: admitted.action.id,
        state: "pending",
      },
    });
    expect(store.admitPeerSessionAction(request)).toMatchObject({
      replay: true,
      action: { id: admitted.action.id },
      queue: { id: admitted.queue?.id },
    });
    expect(() => store.admitPeerSessionAction({
      ...request,
      reasonDigest: testDigest("changed reason"),
    })).toThrow("PEER_SESSION_IDEMPOTENCY_CONFLICT");
    const inspector = new Database(store.paths.database, { readonly: true, strict: true });
    try {
      const peerLedger = JSON.stringify(
        inspector.query("SELECT * FROM peer_session_actions WHERE id=?").get(admitted.action.id),
      );
      expect(peerLedger).not.toContain(message);
      expect(peerLedger).not.toContain("PRIVATE PEER REASON");
      expect(peerLedger).not.toContain("actor-turn-without-sensitive-bytes");
      expect(peerLedger).not.toContain(root);
    } finally {
      inspector.close(false);
    }

    const paths = store.paths;
    store.close();
    stores.splice(stores.indexOf(store), 1);
    const restarted = new StateStore(paths);
    stores.push(restarted);
    expect(restarted.requireQueue(admitted.queue!.id)).toMatchObject({
      message,
      messageActor: "peer_session",
      peerActionId: admitted.action.id,
      state: "pending",
    });
    expect(restarted.transitionQueue(admitted.queue!.id, "pending", "cancelled")).toBe(true);
    expect(restarted.requirePeerSessionAction(admitted.action.id)).toMatchObject({
      state: "cancelled",
    });
  });

  test("revokes a queued peer dispatch when its actor policy or project changes", async () => {
    const { store, home } = await fixture();
    const firstRoot = join(home, "peer-queue-actor-authority-a");
    const secondRoot = join(home, "peer-queue-actor-authority-b");
    await mkdir(firstRoot);
    await mkdir(secondRoot);
    const firstProject = await store.createProject("Peer queue actor authority A", firstRoot);
    const secondProject = await store.createProject("Peer queue actor authority B", secondRoot);
    const profile = signInProfile(
      store,
      "Peer queue actor authority",
      "peer-queue-actor@example.com",
    );
    const admitQueue = (index: number) => {
      const actorBase = store.createSession({
        profileId: profile.id,
        projectId: firstProject.id,
        preset: "high",
        fastEnabled: false,
      });
      const actor = store.setSessionTurnState({
        sessionId: actorBase.id,
        expectedRevision: actorBase.revision,
        state: "active",
        activeTurnId: `turn-peer-queue-actor-${String(index)}`,
      });
      const targetBase = store.createSession({
        profileId: profile.id,
        projectId: firstProject.id,
        preset: "high",
        fastEnabled: false,
      });
      const providerThreadId = `thread-peer-queue-actor-${String(index)}`;
      const target = store.bindSession({
        sessionId: targetBase.id,
        expectedRevision: targetBase.revision,
        providerThreadId,
        state: "idle",
      });
      const message = `queued actor authority ${String(index)}`;
      const admitted = store.admitPeerSessionAction({
        actorSessionId: actor.id,
        actorTurnId: actor.activeTurnId!,
        targetSessionId: target.id,
        expectedTargetRevision: target.revision,
        delivery: "queue",
        requestDigest: testDigest(`queued actor request ${String(index)}`),
        messageDigest: testDigest(message),
        reasonDigest: testDigest(`queued actor reason ${String(index)}`),
        idempotencyKey: peerIdempotencyKey(9_050 + index),
        message,
      });
      const begin = () => store.beginQueueEffect({
        queueId: admitted.queue!.id,
        sessionId: target.id,
        profileGeneration: profile.processGeneration,
        evidence: {
          kind: "queue.dispatch" as const,
          queueId: admitted.queue!.id,
          sessionId: target.id,
          providerThreadId,
          profileGeneration: profile.processGeneration,
          baseline: { providerUpdatedAt: null, status: "idle" as const, activeTurnId: null },
          clientMessageId: admitted.queue!.id,
          messageDigest: testDigest(message),
          runtimeProfile: codexRuntimeProfile(profile),
        },
      });
      return { actor, admitted, begin, target };
    };

    const policyRevoked = admitQueue(0);
    const actorPolicy = store.requirePeerSessionPolicy(policyRevoked.actor.id);
    store.setPeerSessionPolicy({
      sessionId: policyRevoked.actor.id,
      expectedRevision: actorPolicy.revision,
      mode: "off",
    });
    const laterHuman = store.enqueue(
      policyRevoked.target.id,
      "human work after revoked peer queue",
    );
    expect(policyRevoked.begin).toThrow("PEER_SESSION_POLICY_REVISION_CONFLICT");
    expect(store.nextPendingQueue(policyRevoked.target.id)?.id)
      .toBe(policyRevoked.admitted.queue!.id);
    expect(store.readQueueEffect(policyRevoked.admitted.queue!.id)).toBeNull();
    expect(store.cancelRevokedPendingPeerQueue(policyRevoked.admitted.queue!.id))
      .toMatchObject({ state: "cancelled" });
    expect(store.requirePeerSessionAction(policyRevoked.admitted.action.id).state)
      .toBe("cancelled");
    expect(store.nextPendingQueue(policyRevoked.target.id)?.id).toBe(laterHuman.id);
    expect(store.cancelRevokedPendingPeerQueue(policyRevoked.admitted.queue!.id)).toBeNull();

    const projectRevoked = admitQueue(1);
    store.updateSessionMetadata({
      sessionId: projectRevoked.actor.id,
      expectedRevision: projectRevoked.actor.revision,
      projectId: secondProject.id,
    });
    expect(projectRevoked.begin).toThrow("PEER_SESSION_PROJECT_REFUSED");
    expect(store.readQueueEffect(projectRevoked.admitted.queue!.id)).toBeNull();
    expect(store.cancelRevokedPendingPeerQueue(projectRevoked.admitted.queue!.id))
      .toMatchObject({ state: "cancelled" });
    expect(store.requirePeerSessionAction(projectRevoked.admitted.action.id).state)
      .toBe("cancelled");
  });

  test("attaches a queued peer action to the accepted target turn transactionally", async () => {
    const { store, home } = await fixture();
    const root = join(home, "peer-queue-effect");
    await mkdir(root);
    const project = await store.createProject("Peer queue effect", root);
    const profile = signInProfile(store, "Peer queue effect", "peer-queue@example.com");
    const actorBase = store.createSession({
      profileId: profile.id,
      projectId: project.id,
      preset: "high",
      fastEnabled: false,
    });
    const actor = store.setSessionTurnState({
      sessionId: actorBase.id,
      expectedRevision: actorBase.revision,
      state: "active",
      activeTurnId: "turn-peer-source",
    });
    const targetBase = store.createSession({
      profileId: profile.id,
      projectId: project.id,
      preset: "high",
      fastEnabled: false,
    });
    const target = store.bindSession({
      sessionId: targetBase.id,
      expectedRevision: targetBase.revision,
      providerThreadId: "thread-peer-target",
      state: "idle",
    });
    const message = "queued attributed coordination";
    const admitted = store.admitPeerSessionAction({
      actorSessionId: actor.id,
      actorTurnId: actor.activeTurnId!,
      targetSessionId: target.id,
      expectedTargetRevision: target.revision,
      delivery: "queue",
      requestDigest: testDigest("queue effect request"),
      messageDigest: testDigest(message),
      reasonDigest: testDigest("queue effect reason"),
      idempotencyKey: peerIdempotencyKey(9_100),
      message,
    });
    const runtime = {
      profileId: profile.id,
      processGeneration: profile.processGeneration,
      observedAt: 2_000,
      preset: "high" as const,
      model: "gpt-6-astra",
      reasoningEffort: "max" as const,
      serviceTier: null,
      fast: false,
      approvalPolicy: "on-request" as const,
      reviewMode: "auto_review" as const,
      permissionProfile: ":workspace" as const,
      computerUse: true as const,
      pluginCapability: true as const,
      enabledApps: [],
    };
    const evidence = store.beginQueueEffect({
      queueId: admitted.queue!.id,
      sessionId: target.id,
      profileGeneration: profile.processGeneration,
      evidence: {
        kind: "queue.dispatch",
        queueId: admitted.queue!.id,
        sessionId: target.id,
        providerThreadId: "thread-peer-target",
        profileGeneration: profile.processGeneration,
        baseline: { providerUpdatedAt: null, status: "idle", activeTurnId: null },
        clientMessageId: admitted.queue!.id,
        messageDigest: testDigest(message),
        runtimeProfile: runtime,
      },
    });
    expect(store.requirePeerSessionAction(admitted.action.id).state).toBe("effect_started");
    store.completeQueueEffect({
      queueId: admitted.queue!.id,
      accountId: profile.id,
      providerGeneration: profile.processGeneration,
      providerConnectionId: null,
      expectedEvidenceDigest: evidence.digest,
      expectedSessionRevision: target.revision,
      applyResponseState: true,
      turnId: "turn-peer-target",
      turnStatus: "inProgress",
      runtimeProfile: runtime,
      message,
      receipt: { turnId: "turn-peer-target" },
    });
    expect(store.requirePeerSessionAction(admitted.action.id)).toMatchObject({
      state: "applied",
      targetTurnDigest: testDigest("turn-peer-target"),
      resultDigest: testDigest(JSON.stringify({ turnId: "turn-peer-target" })),
    });
    expect(store.readPeerSessionTurnOrigins({
      sessionId: target.id,
      turnId: "turn-peer-target",
    }).map((action) => action.id)).toEqual([admitted.action.id]);
  });

  test("reconciles ambiguous peer queues as proven applied or abandoned across restart", async () => {
    const { store, home } = await fixture();
    const root = join(home, "peer-queue-recovery");
    await mkdir(root);
    const project = await store.createProject("Peer queue recovery", root);
    const profile = signInProfile(store, "Peer queue recovery", "peer-recovery@example.com");
    const actorBase = store.createSession({
      profileId: profile.id,
      projectId: project.id,
      preset: "high",
      fastEnabled: false,
    });
    const actor = store.setSessionTurnState({
      sessionId: actorBase.id,
      expectedRevision: actorBase.revision,
      state: "active",
      activeTurnId: "turn-peer-recovery-source",
    });
    const runtime = {
      profileId: profile.id,
      processGeneration: profile.processGeneration,
      observedAt: 2_000,
      preset: "high" as const,
      model: "gpt-6-astra",
      reasoningEffort: "max" as const,
      serviceTier: null,
      fast: false,
      approvalPolicy: "on-request" as const,
      reviewMode: "auto_review" as const,
      permissionProfile: ":workspace" as const,
      computerUse: true as const,
      pluginCapability: true as const,
      enabledApps: [],
    };
    const prepare = (index: number) => {
      const providerThreadId = `thread-peer-recovery-${String(index)}`;
      const targetBase = store.createSession({
        profileId: profile.id,
        projectId: project.id,
        preset: "high",
        fastEnabled: false,
      });
      const target = store.bindSession({
        sessionId: targetBase.id,
        expectedRevision: targetBase.revision,
        providerThreadId,
        state: "idle",
      });
      const message = `peer recovery message ${String(index)}`;
      const admitted = store.admitPeerSessionAction({
        actorSessionId: actor.id,
        actorTurnId: actor.activeTurnId!,
        targetSessionId: target.id,
        expectedTargetRevision: target.revision,
        delivery: "queue",
        requestDigest: testDigest(`peer recovery request ${String(index)}`),
        messageDigest: testDigest(message),
        reasonDigest: testDigest(`peer recovery reason ${String(index)}`),
        idempotencyKey: peerIdempotencyKey(45_000 + index),
        message,
      });
      const evidence = store.beginQueueEffect({
        queueId: admitted.queue!.id,
        sessionId: target.id,
        profileGeneration: profile.processGeneration,
        evidence: {
          kind: "queue.dispatch",
          queueId: admitted.queue!.id,
          sessionId: target.id,
          providerThreadId,
          profileGeneration: profile.processGeneration,
          baseline: { providerUpdatedAt: null, status: "idle", activeTurnId: null },
          clientMessageId: admitted.queue!.id,
          messageDigest: testDigest(message),
          runtimeProfile: runtime,
        },
      });
      expect(store.requirePeerSessionAction(admitted.action.id).state).toBe("effect_started");
      return { action: admitted.action, evidence, providerThreadId, queue: admitted.queue!, target };
    };

    const proven = prepare(0);
    store.markQueueEffectAmbiguous(proven.queue.id, proven.evidence.digest);
    expect(store.requirePeerSessionAction(proven.action.id).state).toBe("ambiguous");
    const recovered = store.resolveQueueEffect({
      queueId: proven.queue.id,
      expectedEvidenceDigest: proven.evidence.digest,
      resolution: "proven_applied",
      resolutionEvidence: { source: "exact_provider_turn" },
      receipt: { turnId: "turn-peer-recovered" },
      provider: {
        providerThreadId: proven.providerThreadId,
        title: "Recovered applied peer queue",
        status: "idle",
      },
    });
    expect(recovered.messageEvent).toMatchObject({
      appended: true,
      event: {
        body: {
          type: "user_message",
          actor: "peer_session",
          text: "peer recovery message 0",
        },
      },
    });
    expect(store.requirePeerSessionAction(proven.action.id)).toMatchObject({
      state: "applied",
      targetTurnDigest: testDigest("turn-peer-recovered"),
      resultDigest: testDigest(JSON.stringify({ turnId: "turn-peer-recovered" })),
    });
    expect(store.readPeerSessionTurnOrigins({
      sessionId: proven.target.id,
      turnId: "turn-peer-recovered",
    }).map((action) => action.id)).toEqual([proven.action.id]);

    const abandoned = prepare(1);
    const paths = store.paths;
    store.close();
    stores.splice(stores.indexOf(store), 1);
    const restarted = new StateStore(paths);
    stores.push(restarted);
    expect(restarted.recoverDispatchingQueueEffects()).toEqual({
      recovered: [abandoned.queue.id],
      unresolved: [],
    });
    expect(restarted.requirePeerSessionAction(abandoned.action.id).state).toBe("ambiguous");
    restarted.resolveQueueEffect({
      queueId: abandoned.queue.id,
      expectedEvidenceDigest: abandoned.evidence.digest,
      resolution: "abandoned",
      resolutionEvidence: { source: "exact_provider_absence" },
      provider: {
        providerThreadId: abandoned.providerThreadId,
        title: "Recovered abandoned peer queue",
        status: "idle",
      },
    });
    expect(restarted.requirePeerSessionAction(abandoned.action.id)).toMatchObject({
      state: "failed",
      resultDigest: testDigest(JSON.stringify({ source: "exact_provider_absence" })),
    });
  });

  test("refuses peer self, scope, policy, stale revision, and target-state violations distinctly", async () => {
    const { store, home } = await fixture();
    const firstRoot = join(home, "peer-refusal-a");
    const secondRoot = join(home, "peer-refusal-b");
    await mkdir(firstRoot);
    await mkdir(secondRoot);
    const firstProject = await store.createProject("Peer refusal A", firstRoot);
    const secondProject = await store.createProject("Peer refusal B", secondRoot);
    const profile = signInProfile(store, "Peer refusal", "peer-refusal@example.com");
    const create = (projectId: typeof firstProject.id) => store.createSession({
      profileId: profile.id,
      projectId,
      preset: "high",
      fastEnabled: false,
    });
    const actorBase = create(firstProject.id);
    const actor = store.setSessionTurnState({
      sessionId: actorBase.id,
      expectedRevision: actorBase.revision,
      state: "active",
      activeTurnId: "turn-refusal-actor",
    });
    const target = create(firstProject.id);
    const otherProject = create(secondProject.id);
    let key = 10_000;
    const attempt = (overrides: Partial<Parameters<StateStore["admitPeerSessionAction"]>[0]> = {}) =>
      store.admitPeerSessionAction({
        actorSessionId: actor.id,
        actorTurnId: actor.activeTurnId!,
        targetSessionId: target.id,
        expectedTargetRevision: target.revision,
        delivery: "queue",
        requestDigest: testDigest(`refusal request ${String(key)}`),
        messageDigest: testDigest("refusal message"),
        reasonDigest: testDigest("refusal reason"),
        idempotencyKey: peerIdempotencyKey(key++),
        message: "refusal message",
        ...overrides,
      });
    expect(() => attempt({ targetSessionId: actor.id, expectedTargetRevision: actor.revision }))
      .toThrow("PEER_SESSION_SELF_REFUSED");
    expect(() => attempt({
      targetSessionId: otherProject.id,
      expectedTargetRevision: otherProject.revision,
    })).toThrow("PEER_SESSION_PROJECT_REFUSED");
    store.setPeerSessionPolicy({ sessionId: target.id, expectedRevision: 1, mode: "off" });
    expect(() => attempt()).toThrow("PEER_SESSION_POLICY_REFUSED");
    store.setPeerSessionPolicy({ sessionId: target.id, expectedRevision: 2, mode: "coordinate" });
    expect(() => attempt({ expectedTargetRevision: target.revision + 1 }))
      .toThrow("PEER_SESSION_REVISION_CONFLICT");
    expect(() => attempt({ actorTurnId: "not-the-active-turn" }))
      .toThrow("PEER_SESSION_ACTOR_TURN_REFUSED");
    const activeTarget = store.setSessionTurnState({
      sessionId: target.id,
      expectedRevision: target.revision,
      state: "active",
      activeTurnId: "turn-refusal-target",
    });
    expect(() => store.admitPeerSessionAction({
      actorSessionId: actor.id,
      actorTurnId: actor.activeTurnId!,
      targetSessionId: activeTarget.id,
      expectedTargetRevision: activeTarget.revision,
      delivery: "send",
      requestDigest: testDigest("active target request"),
      messageDigest: testDigest("active target message"),
      reasonDigest: testDigest("active target reason"),
      idempotencyKey: peerIdempotencyKey(key++),
    })).toThrow("PEER_SESSION_TARGET_STATE_REFUSED");
  });

  test("unions every turn origin and refuses cycles and the ninth peer hop", async () => {
    const { store, home } = await fixture();
    const root = join(home, "peer-causal");
    await mkdir(root);
    const project = await store.createProject("Peer causal", root);
    const profile = signInProfile(store, "Peer causal", "peer-causal@example.com");
    const sessions = Array.from({ length: 11 }, (_, index) => {
      const created = store.createSession({
        profileId: profile.id,
        projectId: project.id,
        preset: "high",
        fastEnabled: false,
      });
      return store.setSessionTurnState({
        sessionId: created.id,
        expectedRevision: created.revision,
        state: "active",
        activeTurnId: `turn-causal-${String(index)}`,
      });
    });
    let key = 20_000;
    const steer = (from: number, to: number) => {
      const actor = sessions[from]!;
      const target = sessions[to]!;
      const action = store.admitPeerSessionAction({
        actorSessionId: actor.id,
        actorTurnId: actor.activeTurnId!,
        targetSessionId: target.id,
        expectedTargetRevision: target.revision,
        delivery: "steer",
        requestDigest: testDigest(`causal request ${String(key)}`),
        messageDigest: testDigest(`causal message ${String(key)}`),
        reasonDigest: testDigest(`causal reason ${String(key)}`),
        idempotencyKey: peerIdempotencyKey(key++),
      }).action;
      store.beginPeerSessionActionEffect(action.id);
      return store.settlePeerSessionAction({
        actionId: action.id,
        expectedState: "effect_started",
        state: "applied",
        targetTurnId: target.activeTurnId!,
        resultDigest: testDigest(`causal receipt ${String(key)}`),
      });
    };
    const chain = [];
    for (let index = 0; index < PEER_SESSION_HOP_LIMIT; index += 1) {
      chain.push(steer(index, index + 1));
    }
    expect(chain.map((action) => action.hop)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(() => steer(8, 9)).toThrow("PEER_SESSION_HOP_LIMIT_REFUSED");
    expect(() => steer(1, 0)).toThrow("PEER_SESSION_CYCLE_REFUSED");

    const independent = steer(9, 2);
    expect(store.readPeerSessionTurnOrigins({
      sessionId: sessions[2]!.id,
      turnId: sessions[2]!.activeTurnId!,
    })).toHaveLength(2);
    expect(() => steer(2, 9)).toThrow("PEER_SESSION_CYCLE_REFUSED");
    const unioned = steer(2, 10);
    expect(unioned).toMatchObject({
      hop: 3,
      parentActionIds: expect.arrayContaining([chain[1]!.id, independent.id]),
      rootActionIds: expect.arrayContaining([chain[0]!.id, independent.id]),
    });
  });

  test("enforces atomic hourly peer action and distinct-target boundaries without charging replay", async () => {
    let now = 1_000;
    const { store, home } = await fixture({ now: () => now });
    const root = join(home, "peer-budgets");
    await mkdir(root);
    const project = await store.createProject("Peer budgets", root);
    const profile = signInProfile(store, "Peer budgets", "peer-budgets@example.com");
    const actorBase = store.createSession({
      profileId: profile.id,
      projectId: project.id,
      preset: "high",
      fastEnabled: false,
    });
    const actor = store.setSessionTurnState({
      sessionId: actorBase.id,
      expectedRevision: actorBase.revision,
      state: "active",
      activeTurnId: "turn-budget-actor",
    });
    const targetBase = store.createSession({
      profileId: profile.id,
      projectId: project.id,
      preset: "high",
      fastEnabled: false,
    });
    const target = store.setSessionTurnState({
      sessionId: targetBase.id,
      expectedRevision: targetBase.revision,
      state: "idle",
    });
    const send = (index: number, targetSession = target) => store.admitPeerSessionAction({
      actorSessionId: actor.id,
      actorTurnId: actor.activeTurnId!,
      targetSessionId: targetSession.id,
      expectedTargetRevision: targetSession.revision,
      delivery: "send",
      requestDigest: testDigest(`rate request ${String(index)}`),
      messageDigest: testDigest(`rate message ${String(index)}`),
      reasonDigest: testDigest("rate reason"),
      idempotencyKey: peerIdempotencyKey(30_000 + index),
    });
    const first = send(0);
    expect(send(0)).toMatchObject({ replay: true, action: { id: first.action.id } });
    for (let index = 1; index < PEER_SESSION_HOURLY_ACTION_LIMIT; index += 1) send(index);
    expect(() => send(PEER_SESSION_HOURLY_ACTION_LIMIT))
      .toThrow("PEER_SESSION_RATE_LIMIT_REFUSED");

    const fanoutActorBase = store.createSession({
      profileId: profile.id,
      projectId: project.id,
      preset: "high",
      fastEnabled: false,
    });
    const fanoutActor = store.setSessionTurnState({
      sessionId: fanoutActorBase.id,
      expectedRevision: fanoutActorBase.revision,
      state: "active",
      activeTurnId: "turn-fanout-actor",
    });
    expect(() => store.admitPeerSessionAction({
      actorSessionId: fanoutActor.id,
      actorTurnId: fanoutActor.activeTurnId!,
      targetSessionId: target.id,
      expectedTargetRevision: target.revision,
      delivery: "send",
      requestDigest: testDigest("aggregate project rate request"),
      messageDigest: testDigest("aggregate project rate message"),
      reasonDigest: testDigest("aggregate project rate reason"),
      idempotencyKey: peerIdempotencyKey(39_999),
    })).toThrow("PEER_SESSION_RATE_LIMIT_REFUSED");
    expect(PEER_SESSION_PROJECT_HOURLY_ACTION_LIMIT).toBe(PEER_SESSION_HOURLY_ACTION_LIMIT);
    const isolatedRoot = join(home, "peer-budgets-isolated");
    await mkdir(isolatedRoot);
    const isolatedProject = await store.createProject("Peer budgets isolated", isolatedRoot);
    const isolatedActorBase = store.createSession({
      profileId: profile.id,
      projectId: isolatedProject.id,
      preset: "high",
      fastEnabled: false,
    });
    const isolatedActor = store.setSessionTurnState({
      sessionId: isolatedActorBase.id,
      expectedRevision: isolatedActorBase.revision,
      state: "active",
      activeTurnId: "turn-isolated-budget-actor",
    });
    const isolatedTarget = store.createSession({
      profileId: profile.id,
      projectId: isolatedProject.id,
      preset: "high",
      fastEnabled: false,
    });
    expect(store.admitPeerSessionAction({
      actorSessionId: isolatedActor.id,
      actorTurnId: isolatedActor.activeTurnId!,
      targetSessionId: isolatedTarget.id,
      expectedTargetRevision: isolatedTarget.revision,
      delivery: "queue",
      requestDigest: testDigest("isolated aggregate rate request"),
      messageDigest: testDigest("isolated aggregate rate message"),
      reasonDigest: testDigest("isolated aggregate rate reason"),
      idempotencyKey: peerIdempotencyKey(39_998),
      message: "isolated aggregate rate message",
    })).toMatchObject({ replay: false });
    now += PEER_SESSION_RATE_WINDOW_MS + 1;
    const targets = Array.from(
      { length: PEER_SESSION_HOURLY_DISTINCT_TARGET_LIMIT + 1 },
      () => store.createSession({
        profileId: profile.id,
        projectId: project.id,
        preset: "high",
        fastEnabled: false,
      }),
    );
    const queue = (index: number) => {
      const message = `fanout message ${String(index)}`;
      return store.admitPeerSessionAction({
        actorSessionId: fanoutActor.id,
        actorTurnId: fanoutActor.activeTurnId!,
        targetSessionId: targets[index]!.id,
        expectedTargetRevision: targets[index]!.revision,
        delivery: "queue",
        requestDigest: testDigest(`fanout request ${String(index)}`),
        messageDigest: testDigest(message),
        reasonDigest: testDigest("fanout reason"),
        idempotencyKey: peerIdempotencyKey(40_000 + index),
        message,
      });
    };
    for (let index = 0; index < PEER_SESSION_HOURLY_DISTINCT_TARGET_LIMIT; index += 1) {
      queue(index);
    }
    expect(() => queue(PEER_SESSION_HOURLY_DISTINCT_TARGET_LIMIT))
      .toThrow("PEER_SESSION_FANOUT_LIMIT_REFUSED");
  });

  test("retains exact peer replay for seven days then atomically compacts terminal queue provenance", async () => {
    let now = 10_000;
    const { store, home } = await fixture({ now: () => now });
    const root = join(home, "peer-retention-terminal");
    await mkdir(root);
    const project = await store.createProject("Peer retention terminal", root);
    const profile = signInProfile(store, "Peer retention terminal", "peer-retention@example.com");
    const actorBase = store.createSession({
      profileId: profile.id,
      projectId: project.id,
      preset: "high",
      fastEnabled: false,
    });
    const actor = store.setSessionTurnState({
      sessionId: actorBase.id,
      expectedRevision: actorBase.revision,
      state: "active",
      activeTurnId: "turn-peer-retention-old",
    });
    const targetBase = store.createSession({
      profileId: profile.id,
      projectId: project.id,
      preset: "high",
      fastEnabled: false,
    });
    const target = store.setSessionTurnState({
      sessionId: targetBase.id,
      expectedRevision: targetBase.revision,
      state: "idle",
    });
    const message = "terminal peer retention message";
    const oldRequest = {
      actorSessionId: actor.id,
      actorTurnId: actor.activeTurnId!,
      targetSessionId: target.id,
      expectedTargetRevision: target.revision,
      delivery: "queue" as const,
      requestDigest: testDigest("terminal peer retention request"),
      messageDigest: testDigest(message),
      reasonDigest: testDigest("terminal peer retention reason"),
      idempotencyKey: peerIdempotencyKey(54_000),
      message,
    };
    const old = store.admitPeerSessionAction(oldRequest);
    expect(store.transitionQueue(old.queue!.id, "pending", "cancelled")).toBe(true);
    const idleActor = store.setSessionTurnState({
      sessionId: actor.id,
      expectedRevision: actor.revision,
      state: "idle",
    });

    now += PEER_SESSION_ACTION_RETAIN_AGE_MS;
    const currentActor = store.setSessionTurnState({
      sessionId: idleActor.id,
      expectedRevision: idleActor.revision,
      state: "active",
      activeTurnId: "turn-peer-retention-current",
    });
    expect(store.admitPeerSessionAction(oldRequest)).toMatchObject({
      replay: true,
      action: { id: old.action.id },
      queue: { id: old.queue!.id },
    });
    const admitFresh = (index: number) => store.admitPeerSessionAction({
      actorSessionId: currentActor.id,
      actorTurnId: currentActor.activeTurnId!,
      targetSessionId: target.id,
      expectedTargetRevision: target.revision,
      delivery: "send",
      requestDigest: testDigest(`terminal retention fresh request ${String(index)}`),
      messageDigest: testDigest(`terminal retention fresh message ${String(index)}`),
      reasonDigest: testDigest("terminal retention fresh reason"),
      idempotencyKey: peerIdempotencyKey(54_001 + index),
    });
    admitFresh(0);
    expect(store.requirePeerSessionAction(old.action.id).state).toBe("cancelled");

    now += 1;
    const injector = new Database(store.paths.database, { create: false, strict: true });
    injector.exec(`
      CREATE TRIGGER peer_retention_test_abort
      BEFORE DELETE ON peer_session_actions
      BEGIN SELECT RAISE(ABORT, 'test peer retention abort'); END;
    `);
    injector.close(false);
    expect(() => admitFresh(1)).toThrow("test peer retention abort");
    expect(store.requireQueue(old.queue!.id)).toMatchObject({
      messageActor: "peer_session",
      peerActionId: old.action.id,
      state: "cancelled",
    });
    expect(store.readPeerSessionActionByIdempotencyKey(peerIdempotencyKey(54_002))).toBeNull();
    const repair = new Database(store.paths.database, { create: false, strict: true });
    repair.exec("DROP TRIGGER peer_retention_test_abort;");
    repair.close(false);

    expect(admitFresh(1)).toMatchObject({ replay: false });
    expect(() => store.requirePeerSessionAction(old.action.id)).toThrow("PEER_SESSION_NOT_FOUND");
    expect(store.requireQueue(old.queue!.id)).toMatchObject({
      messageActor: "peer_session",
      state: "cancelled",
    });
    expect(store.requireQueue(old.queue!.id)).not.toHaveProperty("peerActionId");
    expect(store.isPeerSessionMessageSource(target.id, old.queue!.id)).toBe(true);
    const inspector = new Database(store.paths.database, { readonly: true, strict: true });
    try {
      expect(inspector.query("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally {
      inspector.close(false);
    }

    const paths = store.paths;
    store.close();
    stores.splice(stores.indexOf(store), 1);
    const restarted = new StateStore(paths, { now: () => now });
    stores.push(restarted);
    expect(restarted.requireQueue(old.queue!.id)).toMatchObject({
      messageActor: "peer_session",
      state: "cancelled",
    });
    expect(restarted.requireQueue(old.queue!.id)).not.toHaveProperty("peerActionId");
    expect(restarted.isPeerSessionMessageSource(target.id, old.queue!.id)).toBe(true);
  });

  test("pins unsettled actions and recursively required causal roots beyond the retention window", async () => {
    let now = 20_000;
    const { store, home } = await fixture({ now: () => now });
    const root = join(home, "peer-retention-pins");
    await mkdir(root);
    const project = await store.createProject("Peer retention pins", root);
    const profile = signInProfile(store, "Peer retention pins", "peer-retention-pins@example.com");
    const createActive = (turnId: string) => {
      const created = store.createSession({
        profileId: profile.id,
        projectId: project.id,
        preset: "high",
        fastEnabled: false,
      });
      return store.setSessionTurnState({
        sessionId: created.id,
        expectedRevision: created.revision,
        state: "active",
        activeTurnId: turnId,
      });
    };
    const first = createActive("turn-peer-retention-first");
    const second = createActive("turn-peer-retention-second");
    const third = createActive("turn-peer-retention-third");
    const maintainer = createActive("turn-peer-retention-maintainer");
    const pendingTargetBase = store.createSession({
      profileId: profile.id,
      projectId: project.id,
      preset: "high",
      fastEnabled: false,
    });
    const pendingTarget = store.setSessionTurnState({
      sessionId: pendingTargetBase.id,
      expectedRevision: pendingTargetBase.revision,
      state: "idle",
    });
    let key = 55_000;
    const steer = (actor: typeof first, target: typeof first) => {
      const action = store.admitPeerSessionAction({
        actorSessionId: actor.id,
        actorTurnId: actor.activeTurnId!,
        targetSessionId: target.id,
        expectedTargetRevision: target.revision,
        delivery: "steer",
        requestDigest: testDigest(`retention causal request ${String(key)}`),
        messageDigest: testDigest(`retention causal message ${String(key)}`),
        reasonDigest: testDigest("retention causal reason"),
        idempotencyKey: peerIdempotencyKey(key++),
      }).action;
      store.beginPeerSessionActionEffect(action.id);
      return store.settlePeerSessionAction({
        actionId: action.id,
        expectedState: "effect_started",
        state: "applied",
        targetTurnId: target.activeTurnId!,
        resultDigest: testDigest(`retention causal result ${action.id}`),
      });
    };
    const rootAction = steer(first, second);
    const descendant = steer(second, third);
    expect(descendant.parentActionIds).toContain(rootAction.id);
    const actorPinned = store.admitPeerSessionAction({
      actorSessionId: maintainer.id,
      actorTurnId: maintainer.activeTurnId!,
      targetSessionId: pendingTarget.id,
      expectedTargetRevision: pendingTarget.revision,
      delivery: "send",
      requestDigest: testDigest("active actor retention request"),
      messageDigest: testDigest("active actor retention message"),
      reasonDigest: testDigest("active actor retention reason"),
      idempotencyKey: peerIdempotencyKey(key++),
    }).action;
    store.beginPeerSessionActionEffect(actorPinned.id);
    store.settlePeerSessionAction({
      actionId: actorPinned.id,
      expectedState: "effect_started",
      state: "failed",
      resultDigest: testDigest("active actor retention failed result"),
    });
    const unresolvedKey = peerIdempotencyKey(key++);
    const unresolvedMessage = "unresolved evidence retention message";
    const unresolvedPinned = store.admitPeerSessionAction({
      actorSessionId: first.id,
      actorTurnId: first.activeTurnId!,
      targetSessionId: pendingTarget.id,
      expectedTargetRevision: pendingTarget.revision,
      delivery: "send",
      requestDigest: testDigest("unresolved evidence retention request"),
      messageDigest: testDigest(unresolvedMessage),
      reasonDigest: testDigest("unresolved evidence retention reason"),
      idempotencyKey: unresolvedKey,
    }).action;
    store.prepareMutation({
      kind: "session.send",
      authorityId: pendingTarget.id,
      authorityGeneration: profile.processGeneration,
      request: { message: unresolvedMessage },
      idempotencyKey: unresolvedKey,
    });
    store.beginPeerSessionActionEffect(unresolvedPinned.id);
    store.settlePeerSessionAction({
      actionId: unresolvedPinned.id,
      expectedState: "effect_started",
      state: "failed",
      resultDigest: testDigest("unresolved evidence outer result"),
    });
    const pendingMessage = "unsettled retention queue";
    const pending = store.admitPeerSessionAction({
      actorSessionId: first.id,
      actorTurnId: first.activeTurnId!,
      targetSessionId: pendingTarget.id,
      expectedTargetRevision: pendingTarget.revision,
      delivery: "queue",
      requestDigest: testDigest("unsettled retention request"),
      messageDigest: testDigest(pendingMessage),
      reasonDigest: testDigest("unsettled retention reason"),
      idempotencyKey: peerIdempotencyKey(key++),
      message: pendingMessage,
    });
    const idleFirst = store.setSessionTurnState({
      sessionId: first.id,
      expectedRevision: first.revision,
      state: "idle",
    });
    store.setSessionTurnState({
      sessionId: second.id,
      expectedRevision: second.revision,
      state: "idle",
    });

    now += PEER_SESSION_ACTION_RETAIN_AGE_MS + 1;
    store.admitPeerSessionAction({
      actorSessionId: maintainer.id,
      actorTurnId: maintainer.activeTurnId!,
      targetSessionId: idleFirst.id,
      expectedTargetRevision: idleFirst.revision,
      delivery: "send",
      requestDigest: testDigest("retention maintenance request"),
      messageDigest: testDigest("retention maintenance message"),
      reasonDigest: testDigest("retention maintenance reason"),
      idempotencyKey: peerIdempotencyKey(key++),
    });
    expect(store.requirePeerSessionAction(rootAction.id).state).toBe("applied");
    expect(store.requirePeerSessionAction(descendant.id)).toMatchObject({
      state: "applied",
      parentActionIds: [rootAction.id],
      rootActionIds: [rootAction.id],
    });
    expect(store.requirePeerSessionAction(pending.action.id).state).toBe("queued");
    expect(store.requirePeerSessionAction(actorPinned.id).state).toBe("failed");
    expect(store.requirePeerSessionAction(unresolvedPinned.id).state).toBe("failed");
    expect(store.readMutation(unresolvedKey)).toMatchObject({ state: "prepared" });
    expect(() => store.admitPeerSessionAction({
      actorSessionId: third.id,
      actorTurnId: third.activeTurnId!,
      targetSessionId: idleFirst.id,
      expectedTargetRevision: idleFirst.revision,
      delivery: "send",
      requestDigest: testDigest("retention cycle request"),
      messageDigest: testDigest("retention cycle message"),
      reasonDigest: testDigest("retention cycle reason"),
      idempotencyKey: peerIdempotencyKey(key++),
    })).toThrow("PEER_SESSION_CYCLE_REFUSED");

    const idleThird = store.setSessionTurnState({
      sessionId: third.id,
      expectedRevision: third.revision,
      state: "idle",
    });
    store.admitPeerSessionAction({
      actorSessionId: maintainer.id,
      actorTurnId: maintainer.activeTurnId!,
      targetSessionId: idleThird.id,
      expectedTargetRevision: idleThird.revision,
      delivery: "send",
      requestDigest: testDigest("retention closed-subgraph maintenance request"),
      messageDigest: testDigest("retention closed-subgraph maintenance message"),
      reasonDigest: testDigest("retention closed-subgraph maintenance reason"),
      idempotencyKey: peerIdempotencyKey(key++),
    });
    expect(() => store.requirePeerSessionAction(rootAction.id)).toThrow("PEER_SESSION_NOT_FOUND");
    expect(() => store.requirePeerSessionAction(descendant.id)).toThrow("PEER_SESSION_NOT_FOUND");

    const reactivatedThird = store.setSessionTurnState({
      sessionId: idleThird.id,
      expectedRevision: idleThird.revision,
      state: "active",
      activeTurnId: third.activeTurnId!,
    });
    const postCompaction = store.admitPeerSessionAction({
      actorSessionId: reactivatedThird.id,
      actorTurnId: reactivatedThird.activeTurnId!,
      targetSessionId: idleFirst.id,
      expectedTargetRevision: idleFirst.revision,
      delivery: "send",
      requestDigest: testDigest("retention post-compaction request"),
      messageDigest: testDigest("retention post-compaction message"),
      reasonDigest: testDigest("retention post-compaction reason"),
      idempotencyKey: peerIdempotencyKey(key++),
    }).action;
    expect(postCompaction).toMatchObject({
      hop: 1,
      parentActionIds: [],
      rootActionIds: [postCompaction.id],
    });

    const paths = store.paths;
    store.close();
    stores.splice(stores.indexOf(store), 1);
    const restarted = new StateStore(paths, { now: () => now });
    stores.push(restarted);
    expect(restarted.listUnsettledPeerSessionActions(10).map((action) => action.id))
      .toContain(pending.action.id);
    expect(restarted.requireQueue(pending.queue!.id)).toMatchObject({
      messageActor: "peer_session",
      peerActionId: pending.action.id,
      state: "pending",
    });
    expect(restarted.requirePeerSessionAction(unresolvedPinned.id).state).toBe("failed");
    expect(restarted.readMutation(unresolvedKey)).toMatchObject({ state: "prepared" });
  });

  test("never carries peer causal parents across a project boundary", async () => {
    let now = 40_000;
    const { store, home } = await fixture({ now: () => now });
    const firstRoot = join(home, "peer-causal-project-a");
    const secondRoot = join(home, "peer-causal-project-b");
    await mkdir(firstRoot);
    await mkdir(secondRoot);
    const firstProject = await store.createProject("Peer causal project A", firstRoot);
    const secondProject = await store.createProject("Peer causal project B", secondRoot);
    const profile = signInProfile(store, "Peer causal account", "peer-causal@example.com");
    const createSession = (
      projectId: ProjectId,
      state: "active" | "idle",
      activeTurnId?: string,
    ) => {
      const created = store.createSession({
        profileId: profile.id,
        projectId,
        preset: "high",
        fastEnabled: false,
      });
      return store.setSessionTurnState({
        sessionId: created.id,
        expectedRevision: created.revision,
        state,
        ...(activeTurnId === undefined ? {} : { activeTurnId }),
      });
    };
    const source = createSession(firstProject.id, "active", "turn-peer-project-source");
    const movingBase = createSession(firstProject.id, "idle");
    const firstAction = store.admitPeerSessionAction({
      actorSessionId: source.id,
      actorTurnId: source.activeTurnId!,
      targetSessionId: movingBase.id,
      expectedTargetRevision: movingBase.revision,
      delivery: "send",
      requestDigest: testDigest("first project causal request"),
      messageDigest: testDigest("first project causal message"),
      reasonDigest: testDigest("first project causal reason"),
      idempotencyKey: peerIdempotencyKey(56_000),
    }).action;
    store.beginPeerSessionActionEffect(firstAction.id);
    store.settlePeerSessionAction({
      actionId: firstAction.id,
      expectedState: "effect_started",
      state: "applied",
      targetTurnId: "turn-peer-project-moving",
      resultDigest: testDigest("first project causal result"),
    });
    const movingActive = store.setSessionTurnState({
      sessionId: movingBase.id,
      expectedRevision: movingBase.revision,
      state: "active",
      activeTurnId: "turn-peer-project-moving",
    });
    expect(() => store.updateSessionMetadata({
      sessionId: movingActive.id,
      expectedRevision: movingActive.revision,
      projectId: secondProject.id,
    })).toThrow("SESSION_PROJECT_REQUIRES_IDLE");
    const movingIdle = store.setSessionTurnState({
      sessionId: movingActive.id,
      expectedRevision: movingActive.revision,
      state: "idle",
    });
    const moved = store.updateSessionMetadata({
      sessionId: movingIdle.id,
      expectedRevision: movingIdle.revision,
      projectId: secondProject.id,
    });
    const reactivated = store.setSessionTurnState({
      sessionId: moved.id,
      expectedRevision: moved.revision,
      state: "active",
      activeTurnId: "turn-peer-project-moving",
    });
    const secondTarget = createSession(secondProject.id, "idle");
    const secondAction = store.admitPeerSessionAction({
      actorSessionId: reactivated.id,
      actorTurnId: reactivated.activeTurnId!,
      targetSessionId: secondTarget.id,
      expectedTargetRevision: secondTarget.revision,
      delivery: "send",
      requestDigest: testDigest("second project causal request"),
      messageDigest: testDigest("second project causal message"),
      reasonDigest: testDigest("second project causal reason"),
      idempotencyKey: peerIdempotencyKey(56_001),
    }).action;
    expect(secondAction).toMatchObject({
      hop: 1,
      parentActionIds: [],
      projectId: secondProject.id,
      rootActionIds: [secondAction.id],
    });
    store.beginPeerSessionActionEffect(secondAction.id);
    store.settlePeerSessionAction({
      actionId: secondAction.id,
      expectedState: "effect_started",
      state: "failed",
      resultDigest: testDigest("second project causal result"),
    });
    store.setSessionTurnState({
      sessionId: source.id,
      expectedRevision: source.revision,
      state: "idle",
    });
    store.setSessionTurnState({
      sessionId: reactivated.id,
      expectedRevision: reactivated.revision,
      state: "idle",
    });

    now += PEER_SESSION_ACTION_RETAIN_AGE_MS + 1;
    const maintainer = createSession(firstProject.id, "active", "turn-peer-project-maintainer");
    const maintenanceTarget = createSession(firstProject.id, "idle");
    store.admitPeerSessionAction({
      actorSessionId: maintainer.id,
      actorTurnId: maintainer.activeTurnId!,
      targetSessionId: maintenanceTarget.id,
      expectedTargetRevision: maintenanceTarget.revision,
      delivery: "send",
      requestDigest: testDigest("first project maintenance request"),
      messageDigest: testDigest("first project maintenance message"),
      reasonDigest: testDigest("first project maintenance reason"),
      idempotencyKey: peerIdempotencyKey(56_002),
    });
    expect(() => store.requirePeerSessionAction(firstAction.id))
      .toThrow("PEER_SESSION_NOT_FOUND");
    expect(store.requirePeerSessionAction(secondAction.id)).toMatchObject({
      parentActionIds: [],
      projectId: secondProject.id,
      rootActionIds: [secondAction.id],
      state: "failed",
    });
  });

  test("keeps protected peer capacity fail-closed with a seven-day aggregate-rate envelope", async () => {
    expect(PEER_SESSION_PROJECT_HOURLY_ACTION_LIMIT * 24 * 7).toBe(20_160);
    expect(
      PEER_SESSION_RETAINED_ACTION_LIMIT
        - PEER_SESSION_PROJECT_HOURLY_ACTION_LIMIT * 24 * 7,
    ).toBe(4_840);

    const { store, home } = await fixture({ now: () => 30_000 });
    const root = join(home, "peer-retention-capacity");
    await mkdir(root);
    const project = await store.createProject("Peer retention capacity", root);
    const profile = signInProfile(store, "Peer retention capacity", "peer-retention-capacity@example.com");
    const actorBase = store.createSession({
      profileId: profile.id,
      projectId: project.id,
      preset: "high",
      fastEnabled: false,
    });
    const actor = store.setSessionTurnState({
      sessionId: actorBase.id,
      expectedRevision: actorBase.revision,
      state: "active",
      activeTurnId: "turn-peer-retention-capacity",
    });
    const targetBase = store.createSession({
      profileId: profile.id,
      projectId: project.id,
      preset: "high",
      fastEnabled: false,
    });
    const target = store.setSessionTurnState({
      sessionId: targetBase.id,
      expectedRevision: targetBase.revision,
      state: "idle",
    });
    const paths = store.paths;
    store.close();
    stores.splice(stores.indexOf(store), 1);
    const seed = new Database(paths.database, { create: false, strict: true });
    seed.exec(`
      PRAGMA foreign_keys=ON;
      DROP TRIGGER peer_session_action_retained_quota;
      WITH RECURSIVE counter(value) AS (
        SELECT 1
        UNION ALL
        SELECT value+1 FROM counter WHERE value<${String(PEER_SESSION_RETAINED_ACTION_LIMIT)}
      )
      INSERT INTO peer_session_actions(
        id,idempotency_key,actor_session_id,actor_turn_digest,project_id,
        actor_policy_revision,target_session_id,target_expected_revision,
        target_policy_revision,delivery,request_digest,message_digest,reason_digest,
        state,hop,target_turn_digest,result_digest,created_at,updated_at
      )
      SELECT
        'peer_' || printf('%032x',value),
        '30000000-0000-4000-8000-' || printf('%012x',value),
        '${actor.id}','${testDigest(actor.activeTurnId!)}','${project.id}',
        1,'${target.id}',${String(target.revision)},1,'send',
        '${testDigest("capacity request")}',
        '${testDigest("capacity message")}',
        '${testDigest("capacity reason")}',
        'prepared',1,NULL,NULL,1,1
      FROM counter;
    `);
    seed.close(false);
    const filled = new StateStore(paths, { now: () => 30_000 });
    stores.push(filled);
    expect(() => filled.admitPeerSessionAction({
      actorSessionId: actor.id,
      actorTurnId: actor.activeTurnId!,
      targetSessionId: target.id,
      expectedTargetRevision: target.revision,
      delivery: "send",
      requestDigest: testDigest("capacity refused request"),
      messageDigest: testDigest("capacity refused message"),
      reasonDigest: testDigest("capacity refused reason"),
      idempotencyKey: peerIdempotencyKey(56_000),
    })).toThrow("PEER_SESSION_RETENTION_LIMIT_REFUSED");
  });

  test("lists bounded unsettled peer and memory effects across restart for reconciliation", async () => {
    const { store, home } = await fixture();
    const root = join(home, "control-plane-reconciliation");
    await mkdir(root);
    const project = await store.createProject("Control plane reconciliation", root);
    const profile = signInProfile(store, "Control plane reconciliation", "reconcile@example.com");
    const actorBase = store.createSession({
      profileId: profile.id,
      projectId: project.id,
      preset: "high",
      fastEnabled: false,
    });
    const actor = store.setSessionTurnState({
      sessionId: actorBase.id,
      expectedRevision: actorBase.revision,
      state: "active",
      activeTurnId: "turn-reconciliation-actor",
    });
    const secondRoot = join(home, "control-plane-reconciliation-second");
    await mkdir(secondRoot);
    const secondProject = await store.createProject(
      "Control plane reconciliation second",
      secondRoot,
    );
    const secondActor = store.createSession({
      profileId: profile.id,
      projectId: secondProject.id,
      preset: "high",
      fastEnabled: false,
    });
    const targetBase = store.createSession({
      profileId: profile.id,
      projectId: project.id,
      preset: "high",
      fastEnabled: false,
    });
    const target = store.setSessionTurnState({
      sessionId: targetBase.id,
      expectedRevision: targetBase.revision,
      state: "idle",
    });
    const admit = (index: number, delivery: "send" | "queue") => {
      const message = `reconciliation message ${String(index)}`;
      return store.admitPeerSessionAction({
        actorSessionId: actor.id,
        actorTurnId: actor.activeTurnId!,
        targetSessionId: target.id,
        expectedTargetRevision: target.revision,
        delivery,
        requestDigest: testDigest(`reconciliation request ${String(index)}`),
        messageDigest: testDigest(message),
        reasonDigest: testDigest(`reconciliation reason ${String(index)}`),
        idempotencyKey: peerIdempotencyKey(50_000 + index),
        ...(delivery === "queue" ? { message } : {}),
      });
    };
    const ambiguousPeer = admit(0, "send").action;
    store.beginPeerSessionActionEffect(ambiguousPeer.id);
    store.settlePeerSessionAction({
      actionId: ambiguousPeer.id,
      expectedState: "effect_started",
      state: "ambiguous",
      resultDigest: testDigest("crash observation peer"),
    });
    const preparedPeer = admit(1, "send").action;
    const queuedPeer = admit(2, "queue").action;
    const appliedPeer = admit(3, "send").action;
    store.beginPeerSessionActionEffect(appliedPeer.id);
    store.settlePeerSessionAction({
      actionId: appliedPeer.id,
      expectedState: "effect_started",
      state: "applied",
      targetTurnId: "turn-reconciliation-applied",
      resultDigest: testDigest("applied peer receipt"),
    });

    const emptyHead = PROJECT_MEMORY_EMPTY_HEAD;
    reserveTestProjectMemoryAuthority(store, project.id, emptyHead);
    reserveTestProjectMemoryAuthority(store, secondProject.id, emptyHead);
    const prepareMemory = (
      index: number,
      memoryActor = actor,
      memoryProject = project,
    ) => {
      const record = store.prepareMemorySubmission({
        actorSessionId: memoryActor.id,
        projectId: memoryProject.id,
        kind: "remember",
        requestDigest: testDigest(`memory reconciliation request ${String(index)}`),
        contentDigest: testDigest(`memory reconciliation content ${String(index)}`),
        keyDigest: testDigest(`memory reconciliation key ${String(index)}`),
        workingBindingDigest: testDigest("memory reconciliation working binding"),
        workingEpoch: 1,
        expectedHead: emptyHead,
        idempotencyKey: peerIdempotencyKey(51_000 + index),
      }).record;
      return store.bindMemorySubmissionEffect({
        submissionId: record.id,
        effectRecordSha256: testDigest(`memory reconciliation record ${String(index)}`),
        attestationSha256: testDigest(`memory reconciliation attestation ${String(index)}`),
        operationId: `memory_reconciliation_${String(index)}`,
      });
    };
    const ambiguousMemory = prepareMemory(0);
    store.beginMemorySubmission(ambiguousMemory.id);
    store.settleMemorySubmission({
      submissionId: ambiguousMemory.id,
      expectedState: "effect_started",
      state: "ambiguous",
    });
    expect(() => prepareMemory(1)).toThrow("MEMORY_RECOVERY_REQUIRED");
    const preparedMemory = prepareMemory(1, secondActor, secondProject);

    const paths = store.paths;
    store.close();
    stores.splice(stores.indexOf(store), 1);
    const restarted = new StateStore(paths);
    stores.push(restarted);
    expect(restarted.listUnsettledPeerSessionActions(1).map((action) => action.id))
      .toEqual([ambiguousPeer.id]);
    expect(restarted.listUnsettledPeerSessionActions(3).map((action) => action.id))
      .toEqual([ambiguousPeer.id, preparedPeer.id, queuedPeer.id]);
    expect(restarted.listUnsettledMemorySubmissions(1).map((submission) => submission.id))
      .toEqual([ambiguousMemory.id]);
    expect(restarted.listUnsettledMemorySubmissions(2).map((submission) => submission.id))
      .toEqual([ambiguousMemory.id, preparedMemory.id]);
    expect(restarted.settlePeerSessionAction({
      actionId: ambiguousPeer.id,
      expectedState: "ambiguous",
      state: "failed",
    }).state).toBe("failed");
    expect(restarted.settleMemorySubmission({
      submissionId: ambiguousMemory.id,
      expectedState: "ambiguous",
      state: "failed",
      outcomeCode: "remember_not_applied",
    }).state).toBe("failed");
    expect(() => restarted.listUnsettledPeerSessionActions(0)).toThrow();
    expect(() => restarted.listUnsettledMemorySubmissions(
      CONTROL_PLANE_RECONCILIATION_BATCH_LIMIT + 1,
    )).toThrow();
  });

  test("revalidates direct peer authority at replay and begin and joins its nested mutation exactly", async () => {
    const { store, home } = await fixture();
    const root = join(home, "peer-begin-authority");
    await mkdir(root);
    const project = await store.createProject("Peer begin authority", root);
    const profile = signInProfile(store, "Peer begin authority", "peer-begin@example.com");
    const actorBase = store.createSession({
      profileId: profile.id,
      projectId: project.id,
      preset: "high",
      fastEnabled: false,
    });
    const actor = store.setSessionTurnState({
      sessionId: actorBase.id,
      expectedRevision: actorBase.revision,
      state: "active",
      activeTurnId: "turn-peer-begin",
    });
    const targetBase = store.createSession({
      profileId: profile.id,
      projectId: project.id,
      preset: "high",
      fastEnabled: false,
    });
    const target = store.setSessionTurnState({
      sessionId: targetBase.id,
      expectedRevision: targetBase.revision,
      state: "idle",
    });
    const key = peerIdempotencyKey(52_000);
    const request = {
      actorSessionId: actor.id,
      actorTurnId: actor.activeTurnId!,
      targetSessionId: target.id,
      expectedTargetRevision: target.revision,
      delivery: "send" as const,
      requestDigest: testDigest("peer begin request"),
      messageDigest: testDigest("peer begin message"),
      reasonDigest: testDigest("peer begin reason"),
      idempotencyKey: key,
    };
    const action = store.admitPeerSessionAction(request).action;
    expect(() => store.prepareMutation({
      kind: "session.send",
      authorityId: target.id,
      authorityGeneration: profile.processGeneration,
      request: { message: "different peer begin message" },
      idempotencyKey: key,
    })).toThrow("PEER_SESSION_MESSAGE_DIGEST_MISMATCH");
    expect(store.readMutation(key)).toBeNull();
    expect(store.requirePeerSessionAction(action.id).state).toBe("prepared");
    const attempt = store.prepareMutation({
      kind: "session.send",
      authorityId: target.id,
      authorityGeneration: profile.processGeneration,
      request: { message: "peer begin message" },
      idempotencyKey: key,
    });
    expect(() => store.beginSessionMutationEffect({
      attemptId: attempt.id,
      sessionId: target.id,
      profileGeneration: profile.processGeneration,
      message: "different peer begin message",
      evidence: {
        kind: "session.send",
        providerThreadId: "thread-peer-begin-authority",
        baseline: { providerUpdatedAt: null, status: "idle", activeTurnId: null },
        clientMessageId: attempt.id,
        messageDigest: testDigest("different peer begin message"),
        runtimeProfile: codexRuntimeProfile(profile),
        messageActor: "peer_session",
      },
    })).toThrow("PEER_SESSION_MESSAGE_DIGEST_MISMATCH");
    expect(store.readMutation(key)?.state).toBe("prepared");
    expect(store.readMutation(key)?.evidence).toBeUndefined();
    expect(store.requirePeerSessionAction(action.id).state).toBe("prepared");
    expect(store.readPeerSessionDirectMessageSource(key)).not.toBeNull();
    expect(store.readPeerSessionMutationJoin(key)).toMatchObject({
      action: { id: action.id },
      attempt: { id: attempt.id },
    });

    const steerTargetBase = store.createSession({
      profileId: profile.id,
      projectId: project.id,
      preset: "high",
      fastEnabled: false,
    });
    const steerTarget = store.bindSession({
      sessionId: steerTargetBase.id,
      expectedRevision: steerTargetBase.revision,
      providerThreadId: "thread-peer-begin-steer",
      state: "active",
      activeTurnId: "turn-peer-begin-steer",
    });
    const steerMessage = "peer steer message";
    const steerMismatch = "different peer steer message";
    const steerKey = peerIdempotencyKey(52_002);
    const steerAction = store.admitPeerSessionAction({
      actorSessionId: actor.id,
      actorTurnId: actor.activeTurnId!,
      targetSessionId: steerTarget.id,
      expectedTargetRevision: steerTarget.revision,
      delivery: "steer",
      requestDigest: testDigest("peer steer request"),
      messageDigest: testDigest(steerMessage),
      reasonDigest: testDigest("peer steer reason"),
      idempotencyKey: steerKey,
    }).action;
    expect(() => store.prepareMutation({
      kind: "session.steer",
      authorityId: steerTarget.id,
      authorityGeneration: profile.processGeneration,
      request: { message: steerMismatch },
      idempotencyKey: steerKey,
    })).toThrow("PEER_SESSION_MESSAGE_DIGEST_MISMATCH");
    const steerAttempt = store.prepareMutation({
      kind: "session.steer",
      authorityId: steerTarget.id,
      authorityGeneration: profile.processGeneration,
      request: { message: steerMessage },
      idempotencyKey: steerKey,
    });
    expect(() => store.beginSessionMutationEffect({
      attemptId: steerAttempt.id,
      sessionId: steerTarget.id,
      profileGeneration: profile.processGeneration,
      message: steerMismatch,
      evidence: {
        kind: "session.steer",
        providerThreadId: "thread-peer-begin-steer",
        baseline: {
          providerUpdatedAt: null,
          status: "active",
          activeTurnId: "turn-peer-begin-steer",
        },
        activeTurnId: "turn-peer-begin-steer",
        clientMessageId: steerAttempt.id,
        messageDigest: testDigest(steerMismatch),
        messageActor: "peer_session",
      },
    })).toThrow("PEER_SESSION_MESSAGE_DIGEST_MISMATCH");
    expect(store.readMutation(steerKey)?.state).toBe("prepared");
    expect(store.readMutation(steerKey)?.evidence).toBeUndefined();
    expect(store.requirePeerSessionAction(steerAction.id).state).toBe("prepared");

    const queueTargetBase = store.createSession({
      profileId: profile.id,
      projectId: project.id,
      preset: "high",
      fastEnabled: false,
    });
    const queueTarget = store.bindSession({
      sessionId: queueTargetBase.id,
      expectedRevision: queueTargetBase.revision,
      providerThreadId: "thread-peer-begin-queue",
      state: "idle",
    });
    const queueMessage = "peer queue message";
    const queueMismatch = "different peer queue message";
    const queued = store.admitPeerSessionAction({
      actorSessionId: actor.id,
      actorTurnId: actor.activeTurnId!,
      targetSessionId: queueTarget.id,
      expectedTargetRevision: queueTarget.revision,
      delivery: "queue",
      requestDigest: testDigest("peer queue request"),
      messageDigest: testDigest(queueMessage),
      reasonDigest: testDigest("peer queue reason"),
      idempotencyKey: peerIdempotencyKey(52_003),
      message: queueMessage,
    });
    expect(() => store.beginQueueEffect({
      queueId: queued.queue!.id,
      sessionId: queueTarget.id,
      profileGeneration: profile.processGeneration,
      evidence: {
        kind: "queue.dispatch",
        queueId: queued.queue!.id,
        sessionId: queueTarget.id,
        providerThreadId: "thread-peer-begin-queue",
        profileGeneration: profile.processGeneration,
        baseline: { providerUpdatedAt: null, status: "idle", activeTurnId: null },
        clientMessageId: queued.queue!.id,
        messageDigest: testDigest(queueMismatch),
        runtimeProfile: codexRuntimeProfile(profile),
      },
    })).toThrow("QUEUE_EFFECT_AUTHORITY_CHANGED");
    expect(store.requireQueue(queued.queue!.id).state).toBe("pending");
    expect(store.readQueueEffect(queued.queue!.id)).toBeNull();
    expect(store.requirePeerSessionAction(queued.action.id).state).toBe("queued");

    // Model a pre-fix/corrupt join whose queue still holds A but whose action
    // digest claims B. The action/evidence comparison must fail independently
    // of the queue/body comparison and roll the evidence insert back.
    const queueCorruptor = new Database(store.paths.database, { create: false, strict: true });
    const transitionTrigger = z.object({ sql: z.string() }).strict().parse(
      queueCorruptor.query(
        "SELECT sql FROM sqlite_master WHERE type='trigger' AND name='peer_session_action_transition_guard'",
      ).get(),
    );
    queueCorruptor.exec("DROP TRIGGER peer_session_action_transition_guard");
    queueCorruptor.query(
      "UPDATE peer_session_actions SET message_digest=? WHERE id=?",
    ).run(testDigest(queueMismatch), queued.action.id);
    queueCorruptor.exec(transitionTrigger.sql);
    queueCorruptor.close(false);
    expect(() => store.beginQueueEffect({
      queueId: queued.queue!.id,
      sessionId: queueTarget.id,
      profileGeneration: profile.processGeneration,
      evidence: {
        kind: "queue.dispatch",
        queueId: queued.queue!.id,
        sessionId: queueTarget.id,
        providerThreadId: "thread-peer-begin-queue",
        profileGeneration: profile.processGeneration,
        baseline: { providerUpdatedAt: null, status: "idle", activeTurnId: null },
        clientMessageId: queued.queue!.id,
        messageDigest: testDigest(queueMessage),
        runtimeProfile: codexRuntimeProfile(profile),
      },
    })).toThrow("QUEUE_PEER_ACTION_AUTHORITY_CHANGED");
    expect(store.requireQueue(queued.queue!.id).state).toBe("pending");
    expect(store.readQueueEffect(queued.queue!.id)).toBeNull();
    expect(store.requirePeerSessionAction(queued.action.id).state).toBe("queued");

    const mismatchedSteerEvidence = {
      kind: "session.steer" as const,
      providerThreadId: "thread-peer-begin-steer",
      baseline: {
        providerUpdatedAt: null,
        status: "active" as const,
        activeTurnId: "turn-peer-begin-steer",
      },
      activeTurnId: "turn-peer-begin-steer",
      clientMessageId: steerAttempt.id,
      messageDigest: testDigest(steerMismatch),
      messageActor: "peer_session" as const,
    };
    const mismatchedCanonical = JSON.stringify(mismatchedSteerEvidence);
    const joinInjector = new Database(store.paths.database, { create: false, strict: true });
    joinInjector.query(
      `INSERT INTO mutation_effect_evidence(
         attempt_id,kind,evidence_json,evidence_digest,recorded_at
       ) VALUES (?,?,?,?,?)`,
    ).run(
      steerAttempt.id,
      "session.steer",
      mismatchedCanonical,
      testDigest(mismatchedCanonical),
      2_000,
    );
    joinInjector.query(
      "UPDATE mutation_attempts SET state='effect_started' WHERE id=? AND state='prepared'",
    ).run(steerAttempt.id);
    joinInjector.close(false);
    expect(() => store.readPeerSessionMutationJoin(steerKey))
      .toThrow("PEER_SESSION_MUTATION_JOIN_INVALID");
    expect(store.requirePeerSessionAction(steerAction.id).state).toBe("prepared");

    expect(store.beginPeerSessionActionEffect(action.id).state).toBe("effect_started");
    // A crash after the outer begin but before the exact same-key nested begin
    // is resumable without rewriting either ledger.
    expect(store.beginPeerSessionActionEffect(action.id).state).toBe("effect_started");
    store.settlePeerSessionAction({
      actionId: action.id,
      expectedState: "effect_started",
      state: "ambiguous",
    });
    expect(store.beginPeerSessionActionEffect(action.id).state).toBe("ambiguous");
    const crashInjector = new Database(store.paths.database, { create: false, strict: true });
    crashInjector.query(
      "UPDATE mutation_attempts SET state='effect_started' WHERE id=? AND state='prepared'",
    ).run(attempt.id);
    crashInjector.close(false);
    expect(() => store.beginPeerSessionActionEffect(action.id))
      .toThrow("PEER_SESSION_NESTED_MUTATION_NOT_RESUMABLE");
    store.setPeerSessionPolicy({
      sessionId: target.id,
      expectedRevision: 1,
      mode: "inspect",
    });
    expect(() => store.admitPeerSessionAction(request))
      .toThrow("PEER_SESSION_POLICY_REVISION_CONFLICT");
    expect(() => store.beginPeerSessionActionEffect(action.id))
      .toThrow("PEER_SESSION_POLICY_REVISION_CONFLICT");
    expect(store.requirePeerSessionAction(action.id).state).toBe("ambiguous");
  });

  test("retains direct peer attribution through compaction and cancels provably unstarted joins", async () => {
    let now = 40_000;
    const { store, home } = await fixture({ now: () => now++ });
    const root = join(home, "peer-direct-retention");
    await mkdir(root);
    const project = await store.createProject("Peer direct retention", root);
    const profile = signInProfile(store, "Peer direct retention", "peer-direct@example.com");
    const actorBase = store.createSession({
      profileId: profile.id,
      projectId: project.id,
      preset: "high",
      fastEnabled: false,
    });
    let actor: SessionRecord = store.setSessionTurnState({
      sessionId: actorBase.id,
      expectedRevision: actorBase.revision,
      state: "active",
      activeTurnId: "turn-peer-direct-origin",
    });
    const createTarget = (thread: string) => {
      const created = store.createSession({
        profileId: profile.id,
        projectId: project.id,
        preset: "high",
        fastEnabled: false,
      });
      return store.bindSession({
        sessionId: created.id,
        expectedRevision: created.revision,
        providerThreadId: thread,
        state: "idle",
      });
    };
    const target = createTarget("thread-peer-direct-retained");
    const message = "retained peer message";
    const key = peerIdempotencyKey(72_000);
    const request = {
      actorSessionId: actor.id,
      actorTurnId: actor.activeTurnId!,
      targetSessionId: target.id,
      expectedTargetRevision: target.revision,
      delivery: "send" as const,
      requestDigest: testDigest("retained peer request"),
      messageDigest: testDigest(message),
      reasonDigest: testDigest("retained peer reason"),
      idempotencyKey: key,
    };
    const action = store.admitPeerSessionAction(request).action;
    const attempt = store.prepareMutation({
      kind: "session.send",
      authorityId: target.id,
      authorityGeneration: profile.processGeneration,
      request: { message },
      idempotencyKey: key,
    });
    const runtime = codexRuntimeProfile(profile);
    const evidence = store.beginSessionMutationEffect({
      attemptId: attempt.id,
      sessionId: target.id,
      profileGeneration: profile.processGeneration,
      message,
      evidence: {
        kind: "session.send",
        providerThreadId: "thread-peer-direct-retained",
        baseline: { providerUpdatedAt: null, status: "idle", activeTurnId: null },
        clientMessageId: attempt.id,
        messageDigest: testDigest(message),
        runtimeProfile: runtime,
      },
    });
    expect(evidence.evidence).toMatchObject({ messageActor: "peer_session" });
    expect(store.requirePeerSessionAction(action.id).state).toBe("effect_started");
    expect(store.readPeerSessionDirectMessageSource(key)).toBeNull();
    const appended = store.completeSessionTurnEffect({
      attemptId: attempt.id,
      sessionId: target.id,
      accountId: profile.id,
      providerGeneration: profile.processGeneration,
      providerConnectionId: null,
      expectedSessionRevision: target.revision,
      applyResponseState: false,
      turnId: "turn-peer-direct-target",
      turnStatus: "completed",
      runtimeProfile: runtime,
      message,
      receipt: { turnId: "turn-peer-direct-target" },
    });
    expect(appended.event.body).toMatchObject({
      type: "user_message",
      actor: "peer_session",
      text: message,
    });
    store.settlePeerSessionAction({
      actionId: action.id,
      expectedState: "effect_started",
      state: "applied",
      targetTurnId: "turn-peer-direct-target",
      resultDigest: testDigest("retained peer result"),
    });

    actor = store.setSessionTurnState({
      sessionId: actor.id,
      expectedRevision: actor.revision,
      state: "idle",
    });
    actor = store.setSessionTurnState({
      sessionId: actor.id,
      expectedRevision: actor.revision,
      state: "active",
      activeTurnId: "turn-peer-direct-next",
    });
    now += PEER_SESSION_ACTION_RETAIN_AGE_MS + 1;
    const cleanupMessage = "new peer message";
    store.admitPeerSessionAction({
      actorSessionId: actor.id,
      actorTurnId: actor.activeTurnId!,
      targetSessionId: target.id,
      expectedTargetRevision: target.revision,
      delivery: "send",
      requestDigest: testDigest("new peer request"),
      messageDigest: testDigest(cleanupMessage),
      reasonDigest: testDigest("new peer reason"),
      idempotencyKey: peerIdempotencyKey(72_001),
    });
    expect(() => store.requirePeerSessionAction(action.id)).toThrow("PEER_SESSION_NOT_FOUND");
    expect(store.sessionMessageActorForSource(target.id, attempt.id)).toBe("peer_session");
    expect(store.readPeerSessionMutationJoin(key)).toMatchObject({
      action: null,
      attempt: { id: attempt.id, state: "applied" },
    });
    expect(() => store.admitPeerSessionAction(request))
      .toThrow("PEER_SESSION_IDEMPOTENCY_CONFLICT");

    const crashTarget = createTarget("thread-peer-direct-crash");
    const crashKey = peerIdempotencyKey(72_002);
    const crashAction = store.admitPeerSessionAction({
      actorSessionId: actor.id,
      actorTurnId: actor.activeTurnId!,
      targetSessionId: crashTarget.id,
      expectedTargetRevision: crashTarget.revision,
      delivery: "send",
      requestDigest: testDigest("crash peer request"),
      messageDigest: testDigest("crash peer message"),
      reasonDigest: testDigest("crash peer reason"),
      idempotencyKey: crashKey,
    }).action;
    store.beginPeerSessionActionEffect(crashAction.id);
    store.settlePeerSessionAction({
      actionId: crashAction.id,
      expectedState: "effect_started",
      state: "ambiguous",
    });
    store.updateSessionMetadata({
      sessionId: crashTarget.id,
      expectedRevision: crashTarget.revision,
      note: "revision moved before provider dispatch",
    });

    const paths = store.paths;
    store.close();
    stores.splice(stores.indexOf(store), 1);
    const restarted = new StateStore(paths, { now: () => now++ });
    stores.push(restarted);
    const cancelled = restarted.cancelUnstartedPeerSessionDirectAction({
      actionId: crashAction.id,
      diagnosticCode: "PEER_SESSION_PROVIDER_EFFECT_NOT_STARTED",
    });
    expect(cancelled.state).toBe("cancelled");
    expect(restarted.readMutation(crashKey)).toMatchObject({
      state: "cancelled",
      result: { providerEffectStarted: false },
    });
    expect(restarted.readPeerSessionDirectMessageSource(crashKey)).toBeNull();
    expect(restarted.cancelUnstartedPeerSessionDirectAction({
      actionId: crashAction.id,
      diagnosticCode: "PEER_SESSION_PROVIDER_EFFECT_NOT_STARTED",
    })).toEqual(cancelled);

    const preparedBase = restarted.createSession({
      profileId: profile.id,
      projectId: project.id,
      preset: "high",
      fastEnabled: false,
    });
    const preparedTarget = restarted.bindSession({
      sessionId: preparedBase.id,
      expectedRevision: preparedBase.revision,
      providerThreadId: "thread-peer-direct-prepared",
      state: "idle",
    });
    const preparedKey = peerIdempotencyKey(72_003);
    const preparedAction = restarted.admitPeerSessionAction({
      actorSessionId: actor.id,
      actorTurnId: actor.activeTurnId!,
      targetSessionId: preparedTarget.id,
      expectedTargetRevision: preparedTarget.revision,
      delivery: "send",
      requestDigest: testDigest("prepared peer envelope"),
      messageDigest: testDigest("prepared peer message"),
      reasonDigest: testDigest("prepared peer reason"),
      idempotencyKey: preparedKey,
    }).action;
    restarted.prepareMutation({
      kind: "session.send",
      authorityId: preparedTarget.id,
      authorityGeneration: profile.processGeneration,
      request: { message: "prepared peer message" },
      idempotencyKey: preparedKey,
    });
    restarted.beginPeerSessionActionEffect(preparedAction.id);
    expect(restarted.cancelUnstartedPeerSessionDirectAction({
      actionId: preparedAction.id,
      diagnosticCode: "PEER_SESSION_PROVIDER_EFFECT_NOT_STARTED",
    }).state).toBe("cancelled");
    expect(restarted.readMutation(preparedKey)?.state).toBe("cancelled");
  });

  test("requires peer queue effect evidence and quarantines missing-evidence restart state", async () => {
    const { store, home } = await fixture();
    const root = join(home, "peer-queue-evidence");
    await mkdir(root);
    const project = await store.createProject("Peer queue evidence", root);
    const profile = signInProfile(store, "Peer queue evidence", "peer-queue-evidence@example.com");
    const actorBase = store.createSession({
      profileId: profile.id,
      projectId: project.id,
      preset: "high",
      fastEnabled: false,
    });
    const actor = store.setSessionTurnState({
      sessionId: actorBase.id,
      expectedRevision: actorBase.revision,
      state: "active",
      activeTurnId: "turn-peer-queue-evidence",
    });
    const targetBase = store.createSession({
      profileId: profile.id,
      projectId: project.id,
      preset: "high",
      fastEnabled: false,
    });
    const target = store.bindSession({
      sessionId: targetBase.id,
      expectedRevision: targetBase.revision,
      providerThreadId: "thread-peer-queue-evidence",
      state: "idle",
    });
    const message = "evidence must precede dispatch";
    const admitted = store.admitPeerSessionAction({
      actorSessionId: actor.id,
      actorTurnId: actor.activeTurnId!,
      targetSessionId: target.id,
      expectedTargetRevision: target.revision,
      delivery: "queue",
      requestDigest: testDigest("peer queue evidence request"),
      messageDigest: testDigest(message),
      reasonDigest: testDigest("peer queue evidence reason"),
      idempotencyKey: peerIdempotencyKey(52_001),
      message,
    });
    expect(() => store.transitionQueue(admitted.queue!.id, "pending", "dispatching"))
      .toThrow("PEER_QUEUE_EFFECT_EVIDENCE_REQUIRED");
    const injector = new Database(store.paths.database, { create: false, strict: true });
    injector.exec("PRAGMA foreign_keys=ON; DROP TRIGGER queue_peer_effect_evidence_guard;");
    injector.query("UPDATE queue_entries SET state='dispatching' WHERE id=?")
      .run(admitted.queue!.id);
    injector.close(false);
    const paths = store.paths;
    store.close();
    stores.splice(stores.indexOf(store), 1);
    const restarted = new StateStore(paths);
    stores.push(restarted);
    expect(restarted.recoverDispatchingQueueEffects()).toEqual({
      recovered: [],
      unresolved: [admitted.queue!.id],
    });
    expect(restarted.requireQueue(admitted.queue!.id).state).toBe("ambiguous");
    expect(restarted.requirePeerSessionAction(admitted.action.id).state).toBe("ambiguous");
    expect(restarted.requireSession(target.id).state).toBe("recovery_required");
  });

  test("atomically advances only share memory heads and recovers started control effects with cursors", async () => {
    const { store, home } = await fixture({ now: () => 7_000 });
    const root = join(home, "memory-control-cas");
    await mkdir(root);
    const project = await store.createProject("Memory control CAS", root);
    const profile = signInProfile(store, "Memory control CAS", "memory-control@example.com");
    const actorBase = store.createSession({
      profileId: profile.id,
      projectId: project.id,
      preset: "high",
      fastEnabled: false,
    });
    const actor = store.setSessionTurnState({
      sessionId: actorBase.id,
      expectedRevision: actorBase.revision,
      state: "active",
      activeTurnId: "turn-memory-control",
    });
    const head = PROJECT_MEMORY_EMPTY_HEAD;
    reserveTestProjectMemoryAuthority(store, project.id, head);
    const remember = store.prepareMemorySubmission({
      actorSessionId: actor.id,
      projectId: project.id,
      kind: "remember",
      requestDigest: testDigest("remember request"),
      contentDigest: testDigest("remember content"),
      keyDigest: testDigest("remember key"),
      workingBindingDigest: testDigest("memory control working binding"),
      workingEpoch: 1,
      expectedHead: head,
      idempotencyKey: peerIdempotencyKey(52_002),
    }).record;
    store.bindMemorySubmissionEffect({
      submissionId: remember.id,
      effectRecordSha256: testDigest("memory control remember record"),
      attestationSha256: testDigest("memory control remember attestation"),
      operationId: "memory_control_remember",
    });
    store.beginMemorySubmission(remember.id);
    const advancedHead = {
      sequence: 1,
      operationSha256: testDigest("share operation"),
      headDigest: testDigest("share head"),
    } as const;
    const skippedHead = {
      sequence: 2,
      operationSha256: testDigest("skipped remember operation"),
      headDigest: testDigest("skipped remember head"),
    } as const;
    expect(() => store.settleMemorySubmission({
      submissionId: remember.id,
      expectedState: "effect_started",
      state: "applied",
      outcomeCode: "remember_committed",
      resultHead: skippedHead,
      receiptDigest: testDigest("remember receipt"),
    })).toThrow("MEMORY_SUBMISSION_OUTCOME_STATE_MISMATCH");
    expect(store.readProjectMemoryAuthority(project.id)?.head).toEqual(head);
    expect(store.settleMemorySubmission({
      submissionId: remember.id,
      expectedState: "effect_started",
      state: "applied",
      outcomeCode: "remember_committed",
      resultHead: advancedHead,
      receiptDigest: testDigest("remember receipt"),
    })).toMatchObject({ state: "applied", resultHead: advancedHead });
    expect(store.readProjectMemoryAuthority(project.id)?.head).toEqual(head);
    const share = store.prepareMemorySubmission({
      actorSessionId: actor.id,
      projectId: project.id,
      kind: "share",
      requestDigest: testDigest("share request"),
      contentDigest: remember.contentDigest,
      keyDigest: remember.keyDigest,
      workingBindingDigest: testDigest("memory control working binding"),
      workingEpoch: 1,
      expectedHead: head,
      idempotencyKey: peerIdempotencyKey(52_003),
    }).record;
    store.bindMemorySubmissionEffect({
      submissionId: share.id,
      effectRecordSha256: testDigest("memory control remember record"),
      attestationSha256: testDigest("memory control remember attestation"),
      operationId: "memory_adopt_control_share",
      sourceHead: advancedHead,
      nominationSha256: testDigest("memory control nomination"),
    });
    store.beginMemorySubmission(share.id);
    expect(store.recoverStartedControlPlaneEffects()).toEqual({
      peerActionIds: [],
      memorySubmissionIds: [share.id],
    });
    expect(() => store.beginMemorySubmission(
      share.id,
      peerIdempotencyKey(99_999),
    )).toThrow("MEMORY_SUBMISSION_IDEMPOTENCY_CONFLICT");
    expect(store.beginMemorySubmission(share.id, share.idempotencyKey).state)
      .toBe("ambiguous");
    expect(store.listUnsettledMemorySubmissionsPage({ limit: 1 }).records).toHaveLength(1);
    store.settleMemorySubmission({
      submissionId: share.id,
      expectedState: "ambiguous",
      state: "applied",
      outcomeCode: "share_adopted",
      resultHead: advancedHead,
      receiptDigest: testDigest("share receipt"),
    });
    expect(store.readProjectMemoryAuthority(project.id)).toMatchObject({
      head: advancedHead,
      syncState: "local_only",
    });
  });

  test("transactionally fences memory preparation and effect start by actor lifecycle", async () => {
    const { store, home } = await fixture({ now: () => 7_100 });
    const profile = signInProfile(store, "Memory actor lifecycle", "memory-lifecycle@example.com");
    let key = 53_000;
    const actorFor = async (
      label: string,
      state: "idle" | "recovery_required" | "terminal",
    ) => {
      const root = join(home, `memory-actor-${label}`);
      await mkdir(root);
      const project = await store.createProject(`Memory actor ${label}`, root);
      const created = store.createSession({
        fastEnabled: false,
        preset: "high",
        profileId: profile.id,
        projectId: project.id,
      });
      const actor = state === "recovery_required"
        ? store.quarantineSession(created.id)
        : store.setSessionTurnState({
            expectedRevision: created.revision,
            sessionId: created.id,
            state,
          });
      return { actor, project };
    };
    const submissionInput = (
      actor: SessionRecord,
      project: ProjectRecord,
      label: string,
    ) => ({
      actorSessionId: actor.id,
      contentDigest: testDigest(`${label} content`),
      expectedHead: PROJECT_MEMORY_EMPTY_HEAD,
      idempotencyKey: peerIdempotencyKey(key++),
      keyDigest: testDigest(`${label} key`),
      kind: "remember" as const,
      projectId: project.id,
      requestDigest: testDigest(`${label} request`),
      workingBindingDigest: testDigest(`${label} working binding`),
      workingEpoch: 1,
    });

    const terminalPrepare = await actorFor("terminal-prepare", "terminal");
    expect(() => store.prepareMemorySubmission(submissionInput(
      terminalPrepare.actor,
      terminalPrepare.project,
      "terminal prepare",
    ))).toThrow("MEMORY_SUBMISSION_ACTOR_TERMINAL");

    const recoveryPrepare = await actorFor("recovery-prepare", "recovery_required");
    expect(() => store.prepareMemorySubmission(submissionInput(
      recoveryPrepare.actor,
      recoveryPrepare.project,
      "recovery prepare",
    ))).toThrow("MEMORY_SUBMISSION_ACTOR_RECOVERY_REQUIRED");

    for (const terminalState of ["terminal", "recovery_required"] as const) {
      const selected = await actorFor(`${terminalState}-begin`, "idle");
      const prepared = store.prepareMemorySubmission(submissionInput(
        selected.actor,
        selected.project,
        `${terminalState} begin`,
      )).record;
      store.bindMemorySubmissionEffect({
        attestationSha256: testDigest(`${terminalState} begin attestation`),
        effectRecordSha256: testDigest(`${terminalState} begin record`),
        operationId: `${terminalState}_begin_operation`,
        submissionId: prepared.id,
      });
      const current = store.requireSession(selected.actor.id);
      if (terminalState === "terminal") {
        store.setSessionTurnState({
          expectedRevision: current.revision,
          sessionId: current.id,
          state: "terminal",
        });
      } else {
        store.quarantineSession(current.id);
      }
      expect(() => store.beginMemorySubmission(prepared.id, prepared.idempotencyKey))
        .toThrow(terminalState === "terminal"
          ? "MEMORY_SUBMISSION_ACTOR_TERMINAL"
          : "MEMORY_SUBMISSION_ACTOR_RECOVERY_REQUIRED");
      expect(store.requireMemorySubmission(prepared.id).state).toBe("prepared");
    }
  });

  test("makes a rejected project-memory reservation durable and terminal", async () => {
    const { store, home } = await fixture();
    const root = join(home, "rejected-project-memory");
    await mkdir(root);
    const project = await store.createProject("Rejected memory", root);
    const identity = createPortableProjectMemoryCanonicalIdentity(project.id);
    const reserved = store.reserveProjectMemoryAuthority({
      canonicalSpaceId: identity.canonicalSpaceId,
      head: PROJECT_MEMORY_EMPTY_HEAD,
      identityContract: identity.identityContract,
      projectId: project.id,
    });
    const rejected = store.rejectReservedProjectMemoryAuthority({
      diagnosticCode: "MEMORY_CANONICAL_DIVERGED",
      expectedHead: reserved.head,
      expectedRevision: reserved.revision,
      projectId: project.id,
    });
    expect(rejected).toMatchObject({
      diagnosticCode: "MEMORY_CANONICAL_DIVERGED",
      physicalState: "rejected",
      revision: 2,
      syncState: "error",
    });
    expect(store.rejectReservedProjectMemoryAuthority({
      diagnosticCode: "MEMORY_CANONICAL_DIVERGED",
      expectedHead: reserved.head,
      expectedRevision: reserved.revision,
      projectId: project.id,
    })).toEqual(rejected);
    expect(() => store.markProjectMemoryAuthorityInitialized({
      expectedHead: reserved.head,
      expectedRevision: rejected.revision,
      projectId: project.id,
    })).toThrow("PROJECT_MEMORY_REVISION_CONFLICT");

    const writer = new Database(store.paths.database, { create: false, strict: true });
    try {
      expect(() => writer.query(
        `UPDATE project_memory_authorities
         SET physical_state='initialized',initialized_at=updated_at,
             sync_state='local_only',diagnostic_code=NULL,revision=revision+1
         WHERE project_id=?`,
      ).run(project.id)).toThrow();
    } finally {
      writer.close(false);
    }
    expect(store.readProjectMemoryAuthority(project.id)).toEqual(rejected);
  });

  test("repairs a pre-portable v40 memory authority without changing its physical identity", async () => {
    const { store, home } = await fixture();
    const root = join(home, "legacy-project-memory-identity");
    await mkdir(root);
    const project = await store.createProject("Legacy memory identity", root);
    const paths = store.paths;
    store.close();
    stores.splice(stores.indexOf(store), 1);

    const legacyIdentity = deriveProjectMemoryCanonicalIdentity({
      canonicalSpaceId: legacyProjectMemorySpaceId(project.id),
      identityContract: 1,
      projectId: project.id,
    });
    const emptyHead = PROJECT_MEMORY_EMPTY_HEAD;
    const legacy = new Database(paths.database, { create: false, strict: true });
    const currentSql = z.object({ sql: z.string() }).strict().parse(legacy.query(
      "SELECT sql FROM sqlite_master WHERE type='table' AND name='project_memory_authorities'",
    ).get()).sql;
    const identityStart = currentSql.indexOf(",\n  identity_contract");
    const authorityStart = currentSql.indexOf(",\n  authority_digest", identityStart);
    if (identityStart < 0 || authorityStart < 0) {
      throw new Error("Expected the portable identity columns in the current fixture.");
    }
    const legacySql = (currentSql.slice(0, identityStart) + currentSql.slice(authorityStart))
      .replace(
        ",\n  CHECK((physical_state='initialized') = (initialized_at IS NOT NULL))",
        "",
      )
      .replace(
        ",\n  CHECK(initialized_at IS NULL OR (initialized_at >= created_at AND initialized_at <= updated_at))",
        "",
      )
      .replace(
        `,\n  CHECK(head_sequence != 0 OR head_digest = '${PROJECT_MEMORY_EMPTY_HEAD.headDigest}')`,
        "",
      )
      .replace(
        `,\n  CHECK(\n    last_exchange_sequence IS NULL\n    OR last_exchange_sequence != 0\n    OR last_exchange_head_digest = '${PROJECT_MEMORY_EMPTY_HEAD.headDigest}'\n  )`,
        "",
      )
      .replace(
        `,\n  CHECK(\n    physical_state!='reserved'\n    OR (\n      head_sequence=0\n      AND head_operation_sha256 IS NULL\n      AND head_digest='${PROJECT_MEMORY_EMPTY_HEAD.headDigest}'\n      AND sync_state='local_only'\n      AND last_exchange_at IS NULL\n      AND last_exchange_sequence IS NULL\n      AND last_exchange_operation_sha256 IS NULL\n      AND last_exchange_head_digest IS NULL\n      AND diagnostic_code IS NULL\n    )\n  )`,
        "",
      )
      .replace(
        `,\n  CHECK(\n    physical_state!='rejected'\n    OR (\n      initialized_at IS NULL\n      AND head_sequence=0\n      AND head_operation_sha256 IS NULL\n      AND head_digest='${PROJECT_MEMORY_EMPTY_HEAD.headDigest}'\n      AND sync_state='error'\n      AND last_exchange_at IS NULL\n      AND last_exchange_sequence IS NULL\n      AND last_exchange_operation_sha256 IS NULL\n      AND last_exchange_head_digest IS NULL\n      AND diagnostic_code IS NOT NULL\n    )\n  )`,
        "",
      );
    legacy.exec(`
      PRAGMA foreign_keys=OFF;
      DROP TRIGGER IF EXISTS memory_page_attestation_ref_insert_guard;
      DROP TRIGGER IF EXISTS memory_page_attestation_ref_update_guard;
      DROP TRIGGER IF EXISTS project_memory_authority_delete_guard;
      DROP TRIGGER IF EXISTS project_memory_authority_insert_guard;
      DROP TRIGGER IF EXISTS project_memory_authority_transition_guard;
      DROP INDEX IF EXISTS project_memory_authorities_space_unique;
      DROP TABLE project_memory_authorities;
    `);
    legacy.exec(legacySql);
    legacy.query(
      `INSERT INTO project_memory_authorities(
         project_id,authority_digest,binding_digest,head_sequence,
         head_operation_sha256,head_digest,revision,sync_state,
         last_exchange_at,last_exchange_sequence,last_exchange_operation_sha256,
         last_exchange_head_digest,diagnostic_code,created_at,updated_at
       ) VALUES (?,?,?,?,?,?,1,'local_only',NULL,NULL,NULL,NULL,NULL,?,?)`,
    ).run(
      project.id,
      legacyIdentity.authorityDigest,
      legacyIdentity.bindingDigest,
      emptyHead.sequence,
      emptyHead.operationSha256,
      emptyHead.headDigest,
      4_000,
      4_000,
    );
    legacy.exec("PRAGMA foreign_keys=ON");
    legacy.close(false);

    const corrupted = new Database(paths.database, { create: false, strict: true });
    corrupted.query(
      "UPDATE project_memory_authorities SET head_digest=? WHERE project_id=?",
    ).run("c".repeat(64), project.id);
    corrupted.close(false);
    expect(() => new StateStore(paths, { now: () => 8_000 }))
      .toThrow("PROJECT_MEMORY_AUTHORITY_MIGRATION_INVALID");
    const repaired = new Database(paths.database, { create: false, strict: true });
    expect(repaired.query<{ name: string }, []>(
      "SELECT name FROM pragma_table_info('project_memory_authorities') WHERE name='identity_contract'",
    ).get()).toBeNull();
    repaired.query(
      "UPDATE project_memory_authorities SET head_digest=? WHERE project_id=?",
    ).run(PROJECT_MEMORY_EMPTY_HEAD.headDigest, project.id);
    repaired.close(false);

    expect(() => new StateStore(paths, { readonly: true }))
      .toThrow("STATE_SCHEMA_V40_STRUCTURE_INVALID");
    const migrated = new StateStore(paths, { now: () => 9_000 });
    stores.push(migrated);
    expect(migrated.readProjectMemoryAuthority(project.id)).toEqual({
      authorityDigest: legacyIdentity.authorityDigest,
      bindingDigest: legacyIdentity.bindingDigest,
      canonicalSpaceId: legacyIdentity.canonicalSpaceId,
      createdAt: 4_000,
      head: emptyHead,
      identityContract: 1,
      initializedAt: 4_000,
      physicalState: "initialized",
      projectId: project.id,
      revision: 1,
      syncState: "local_only",
      updatedAt: 4_000,
    });
    const losingIdentity = createPortableProjectMemoryCanonicalIdentity(project.id);
    expect(migrated.reserveProjectMemoryAuthority({
      canonicalSpaceId: losingIdentity.canonicalSpaceId,
      head: emptyHead,
      identityContract: losingIdentity.identityContract,
      projectId: project.id,
    })).toMatchObject({
      canonicalSpaceId: legacyIdentity.canonicalSpaceId,
      identityContract: 1,
    });
  });

  test("upgrades a frozen upstream-v39 schema to attributed v40 state", async () => {
    const { store } = await fixture();
    const profile = store.createProfile("Upstream v39 peer migration");
    const session = store.createSession({
      profileId: profile.id,
      preset: "high",
      fastEnabled: false,
    });
    const queue = store.enqueue(session.id, "legacy human queue");
    const paths = store.paths;
    store.close();
    stores.splice(stores.indexOf(store), 1);
    const legacy = new Database(paths.database, { create: false, strict: true });
    legacy.exec(`
      PRAGMA foreign_keys=OFF;
      DROP TRIGGER IF EXISTS queue_peer_action_transition;
      DROP TRIGGER IF EXISTS queue_peer_effect_evidence_guard;
      DROP TRIGGER IF EXISTS queue_peer_inbound_quota_guard;
      DROP TRIGGER IF EXISTS queue_peer_provenance_immutable;
      DROP TRIGGER IF EXISTS queue_peer_provenance_insert_guard;
      DROP TRIGGER IF EXISTS session_peer_policy_default;
      DROP TRIGGER IF EXISTS session_provider_switch_session_update_guard;
      DROP TRIGGER IF EXISTS session_provider_switch_session_delete_guard;
      DROP TRIGGER IF EXISTS session_message_event_source_event_delete;
      DROP INDEX IF EXISTS queue_peer_action;
      DROP TABLE IF EXISTS session_message_event_sources;
      ALTER TABLE queue_entries DROP COLUMN peer_action_id;
      ALTER TABLE queue_entries DROP COLUMN message_actor;
      DROP TABLE IF EXISTS session_provider_switches;
      DROP TABLE IF EXISTS peer_session_direct_message_sources;
      DROP TABLE IF EXISTS peer_session_turn_origins;
      DROP TABLE IF EXISTS peer_session_action_roots;
      DROP TABLE IF EXISTS peer_session_action_visits;
      DROP TABLE IF EXISTS peer_session_action_parents;
      DROP TABLE IF EXISTS peer_session_actions;
      DROP TABLE IF EXISTS session_peer_policies;
      DROP TABLE IF EXISTS memory_page_attestation_refs;
      DROP TABLE IF EXISTS memory_working_attestation_forks;
      DROP TABLE IF EXISTS memory_working_attestation_heads;
      DROP TABLE IF EXISTS memory_page_attestations;
      DROP TABLE IF EXISTS memory_submissions;
      DROP TRIGGER IF EXISTS project_memory_sync_authority_fence;
      DROP TABLE IF EXISTS project_memory_sync_spool;
      DROP TABLE IF EXISTS project_memory_sync_intents;
      DROP TABLE IF EXISTS project_memory_hosted_attachments;
      DROP TABLE IF EXISTS project_memory_authorities;
      DROP TABLE IF EXISTS session_host_capability_bindings;
      DELETE FROM migrations WHERE version IN (40,41);
      PRAGMA user_version=39;
      PRAGMA foreign_keys=ON;
    `);
    legacy.close(false);
    expect(() => new StateStore(paths, { readonly: true }))
      .toThrow("STATE_SCHEMA_MIGRATION_REQUIRED:39:41");
    const migrated = new StateStore(paths, { now: () => 9_000 });
    stores.push(migrated);
    expect(migrated.requireQueue(queue.id)).toMatchObject({
      messageActor: "human",
      state: "pending",
    });
    expect(migrated.requireQueue(queue.id)).not.toHaveProperty("peerActionId");
    expect(migrated.requirePeerSessionPolicy(session.id)).toMatchObject({
      mode: "coordinate",
      revision: 1,
    });
    const inspector = new Database(paths.database, { readonly: true, strict: true });
    try {
      expect(inspector.query("PRAGMA user_version").get()).toEqual({ user_version: 41 });
      expect(inspector.query("SELECT applied_at FROM migrations WHERE version=40").get())
        .toEqual({ applied_at: 9_000 });
    } finally {
      inspector.close(false);
    }
  });

  test("converges a pre-release feature-v39 journal without losing recovery evidence", async () => {
    const { store } = await fixture();
    const profile = signInProfile(
      store,
      "Feature v39 journal",
      "feature-v39-journal@example.com",
    );
    const created = store.createSession({
      profileId: profile.id,
      preset: "high",
      fastEnabled: false,
    });
    const session = store.bindSession({
      sessionId: created.id,
      expectedRevision: created.revision,
      providerThreadId: "feature-v39-source-thread",
      state: "idle",
    });
    const targetRuntime = codexRuntimeProfile(profile, 7_100);
    const seedText = "Preserve the pre-release provider-switch journal.";
    const journal = store.beginSessionProviderSwitch({
      idempotencyKey: peerIdempotencyKey(79_000),
      request: {
        sessionId: session.id,
        provider: "codex",
        requestedPreset: "high",
        targetProfileId: profile.id,
      },
      source: {
        profileId: profile.id,
        processGeneration: profile.processGeneration,
        provider: "codex",
        preset: "high",
        providerThreadId: "feature-v39-source-thread",
        sessionRevision: session.revision,
      },
      target: {
        profileId: profile.id,
        processGeneration: profile.processGeneration,
        provider: "codex",
        preset: "high",
        review: {
          reviewId: "79000000-0000-4000-8000-000000000001",
          kind: "session_start",
          effectiveRuntimeProfile: targetRuntime,
        },
      },
      fastEnabled: false,
      hostCapabilities: {
        preambleVersion: 1,
        preambleDigest: testDigest("feature v39 preamble"),
        manifestVersion: 1,
        manifestDigest: testDigest("feature v39 manifest"),
      },
      transcriptDigest: testDigest("feature v39 transcript"),
      seed: {
        text: seedText,
        digest: createHash("sha256")
          .update("hra:session-transcript-seed:v1\0", "utf8")
          .update(seedText, "utf8")
          .digest("hex"),
        includedRecords: 1,
        omittedRecords: 0,
      },
    });
    const request = {
      sessionId: session.id,
      provider: "codex" as const,
      requestedPreset: "high" as const,
      targetProfileId: profile.id,
    };
    const paths = store.paths;
    store.close();
    stores.splice(stores.indexOf(store), 1);

    const legacy = new Database(paths.database, { create: false, strict: true });
    legacy.exec(`
      DROP TRIGGER session_provider_switch_v40_authority_guard;
      DROP TRIGGER session_provider_switch_v40_authority_immutable;
      ALTER TABLE session_provider_switches DROP COLUMN authority_contract_v40;
      ALTER TABLE session_provider_switches DROP COLUMN target_manifest_digest_v40;
      ALTER TABLE session_provider_switches DROP COLUMN target_manifest_version_v40;
      ALTER TABLE session_provider_switches DROP COLUMN target_preamble_digest_v40;
      ALTER TABLE session_provider_switches DROP COLUMN target_preamble_version_v40;
      ALTER TABLE session_provider_switches DROP COLUMN target_preset_v40;
      ALTER TABLE session_provider_switches DROP COLUMN target_provider_v40;
      ALTER TABLE session_provider_switches DROP COLUMN source_preset_v40;
      ALTER TABLE session_provider_switches DROP COLUMN source_provider_v40;
      DROP TRIGGER work_devin_preset_contract_guard;
      DROP TRIGGER work_session_devin_contract_guard;
      DROP TRIGGER work_attempt_route_guard;
      DROP TRIGGER work_session_attempt_authority_guard;
      DROP TRIGGER work_profile_attempt_authority_guard;
      DROP TRIGGER work_signal_member_guard;
      DROP TRIGGER IF EXISTS canonical_memory_sync_share_fence;
      DROP TRIGGER IF EXISTS project_memory_sync_authority_fence;
      DROP TABLE IF EXISTS project_memory_sync_spool;
      DROP TABLE IF EXISTS project_memory_sync_intents;
      DROP TABLE IF EXISTS project_memory_hosted_attachments;
      DROP TABLE session_mutation_authority_rebinds_v39;
      ALTER TABLE sessions DROP COLUMN provider_v39;
      DELETE FROM migrations WHERE version IN (40,41);
      PRAGMA user_version=39;
    `);
    expect(legacy.query("PRAGMA table_info(session_provider_switches)").all())
      .not.toContainEqual(expect.objectContaining({ name: "authority_contract_v40" }));
    expect(legacy.query("PRAGMA table_info(sessions)").all())
      .not.toContainEqual(expect.objectContaining({ name: "provider_v39" }));
    legacy.close(false);

    expect(() => new StateStore(paths, { readonly: true }))
      .toThrow("STATE_SCHEMA_MIGRATION_REQUIRED:39:41");
    const migrated = new StateStore(paths, { now: () => 7_200 });
    stores.push(migrated);
    expect(migrated.readSessionProviderSwitchReplay({
      idempotencyKey: journal.idempotencyKey,
      request,
    })).toMatchObject({
      attemptId: journal.attemptId,
      journalDigest: journal.journalDigest,
      source: { provider: "codex", preset: "high" },
      target: { provider: "codex", preset: "high" },
    });
    expect(migrated.requireSession(session.id)).toMatchObject({ provider: "codex" });
    const inspector = new Database(paths.database, { readonly: true, strict: true });
    try {
      expect(inspector.query(
        `SELECT source_provider_v40,target_provider_v40,authority_contract_v40
         FROM session_provider_switches WHERE attempt_id=?`,
      ).get(journal.attemptId)).toEqual({
        source_provider_v40: "codex",
        target_provider_v40: "codex",
        authority_contract_v40: 1,
      });
    } finally {
      inspector.close(false);
    }
    migrated.close();
    stores.splice(stores.indexOf(migrated), 1);
    const reopened = new StateStore(paths, { readonly: true });
    stores.push(reopened);
    expect(reopened.readSessionProviderSwitchReplay({
      idempotencyKey: journal.idempotencyKey,
      request,
    })?.journalDigest).toBe(journal.journalDigest);
  });

  test("readonly open requires the exact v40 peer and memory guards", async () => {
    const { store } = await fixture();
    const paths = store.paths;
    store.close();
    stores.splice(stores.indexOf(store), 1);
    const weakened = new Database(paths.database, { create: false, strict: true });
    weakened.exec(`
      DROP TRIGGER queue_peer_effect_evidence_guard;
      CREATE TRIGGER queue_peer_effect_evidence_guard
      BEFORE UPDATE OF state ON queue_entries
      BEGIN SELECT 1; END;
    `);
    weakened.close(false);
    expect(() => new StateStore(paths, { readonly: true }))
      .toThrow("STATE_SCHEMA_V40_STRUCTURE_INVALID");
    const repaired = new StateStore(paths);
    stores.push(repaired);
    repaired.close();
    stores.splice(stores.indexOf(repaired), 1);
    const readonly = new StateStore(paths, { readonly: true });
    stores.push(readonly);
  });

  test("readonly open rejects a missing v40 authority trigger and index", async () => {
    const { store } = await fixture();
    const paths = store.paths;
    store.close();
    stores.splice(stores.indexOf(store), 1);
    const weakened = new Database(paths.database, { create: false, strict: true });
    weakened.exec(`
      DROP TRIGGER session_host_capability_binding_immutable;
      DROP INDEX memory_submissions_project_recent;
    `);
    weakened.close(false);
    expect(() => new StateStore(paths, { readonly: true }))
      .toThrow("STATE_SCHEMA_V40_STRUCTURE_INVALID");
    const repaired = new StateStore(paths);
    stores.push(repaired);
    repaired.close();
    stores.splice(stores.indexOf(repaired), 1);
    const readonly = new StateStore(paths, { readonly: true });
    stores.push(readonly);
  });

  test("readonly open rejects a weakened previously unaudited v40 guard", async () => {
    const { store } = await fixture();
    const paths = store.paths;
    store.close();
    stores.splice(stores.indexOf(store), 1);
    const weakened = new Database(paths.database, { create: false, strict: true });
    weakened.exec(`
      DROP TRIGGER session_peer_policy_transition_guard;
      CREATE TRIGGER session_peer_policy_transition_guard
      BEFORE UPDATE ON session_peer_policies
      BEGIN SELECT 1; END;
    `);
    weakened.close(false);
    expect(() => new StateStore(paths, { readonly: true }))
      .toThrow("STATE_SCHEMA_V40_STRUCTURE_INVALID");
  });

  test("rejects databases written by a newer schema version", async () => {
    const home = await realpath(await mkdtemp(join(tmpdir(), "hra-store-newer-")));
    const paths = resolveStatePaths({ homeDirectory: home, platform: "darwin" });
    await initializeStatePaths(paths);
    const newer = new Database(paths.database, { create: true, strict: true });
    newer.exec("PRAGMA user_version = 42");
    newer.close(false);
    await chmod(paths.database, 0o600);
    expect(() => new StateStore(paths)).toThrow("STATE_SCHEMA_NEWER:42:41");
  });
});
