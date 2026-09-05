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
  SESSION_EVENT_MAX_BYTES,
  SESSION_EVENT_PUBLIC_MAX_BYTES,
  SESSION_EVENT_RETAIN_AGE_MS,
} from "../domain/session-events";
import {
  accountUsageCounterSamples,
  createStoredAccountUsageSnapshot,
  observedAccountTokenVelocity,
  type StoredAccountUsageSnapshot,
} from "../domain/usage-metrics";
import { utf8Bytes } from "../domain/values";
import { canTransitionQueue, queueStateSchema, type QueueState } from "../domain/transitions";
import { projectPublicProviderIdentifier } from "../public-provider-identifier";
import { presetRequirements, type Preset } from "../domain/presets";
import {
  effectiveClaudeRuntimeProfileSchema,
  effectiveRuntimeProfileSchema,
} from "../domain/runtime-profile";
import { initializeProfilePaths, initializeStatePaths, resolveStatePaths } from "./paths";
import {
  USAGE_CLOUD_UPLOAD_MIN_INTERVAL_MS,
  USAGE_CLOUD_UPLOAD_ANCHOR_COUNT,
  USAGE_LOCAL_RETAIN_AGE_MS,
  USAGE_LOCAL_RETAIN_BYTES,
  USAGE_LOCAL_RETAIN_SUCCESS_COUNT,
  SelectionError,
  StateSecurityScrubRequiredError,
  StateStore,
  type SecurityScrubCheckpointPolicy,
} from "./state-store";

const stores: StateStore[] = [];
const privateUserPathRoot = ["", "Users", "private"].join("/");
const publicProviderIdentifierKey = new Uint8Array(32).fill(19);
const publicProviderIdentifier = (value: string) =>
  projectPublicProviderIdentifier(value, publicProviderIdentifierKey);
const testProviderAccountKey = (provider: "codex" | "claude"): string =>
  `v1:${provider}:${createHash("sha256").update(`test-${provider}-account`).digest("hex")}`;
const namedProviderAccountKey = (
  provider: "codex" | "claude",
  name: string,
): string => `v1:${provider}:${createHash("sha256").update(name).digest("hex")}`;

type ProviderSessionInput = Parameters<StateStore["upsertProviderSession"]>[0];
const upsertProvenTestSession = (
  store: StateStore,
  input: Omit<ProviderSessionInput, "provider" | "providerAccountKey" | "title"> &
    Partial<Pick<ProviderSessionInput, "provider" | "providerAccountKey" | "title">>,
) => {
  const provider = input.provider ?? "codex";
  return store.upsertProviderSession({
    ...input,
    provider,
    title: input.title ?? "Untitled session",
    providerAccountKey: input.providerAccountKey ?? testProviderAccountKey(provider),
  });
};

let provenTestSessionSequence = 0;
type CreateProvenTestSessionInput =
  & Omit<ProviderSessionInput, "provider" | "providerThreadId" | "providerAccountKey" | "state" | "title">
  & Partial<Pick<
    ProviderSessionInput,
    "provider" | "providerThreadId" | "providerAccountKey" | "state" | "title"
  >>;
const createProvenTestSession = (
  store: StateStore,
  input: CreateProvenTestSessionInput,
) => {
  const { providerThreadId, state, ...rest } = input;
  provenTestSessionSequence += 1;
  return upsertProvenTestSession(store, {
    ...rest,
    providerThreadId: providerThreadId ?? `test-provider-thread-${provenTestSessionSequence}`,
    state: state ?? "idle",
  });
};

const createRevocationWorkStore = (store: StateStore, generation = 1) =>
  store.createWorkStore(
    generation,
    () => "unused-revocation-cursor",
    {
      issue: () => `hrac1_${"A".repeat(43)}`,
      verify: () => true,
    },
  );

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});

async function fixture(
  options: Readonly<{ securityScrubCheckpoint?: SecurityScrubCheckpointPolicy }> = {},
): Promise<{ store: StateStore; home: string }> {
  const home = await realpath(await mkdtemp(join(tmpdir(), "hra-store-")));
  const paths = resolveStatePaths({ homeDirectory: home, platform: "darwin" });
  await initializeStatePaths(paths);
  const store = new StateStore(paths, {
    now: (() => { let value = 1_000; return () => value++; })(),
    ...options,
  });
  stores.push(store);
  return { store, home };
}

const codexAdoptionRuntimeProfile = (
  profile: Readonly<{ id: string; processGeneration: number }>,
  preset: Exclude<Preset, "fable-max">,
  fast: boolean,
) => ({
  approvalPolicy: "on-request" as const,
  computerUse: true as const,
  enabledApps: [],
  fast,
  model: presetRequirements[preset].model,
  observedAt: 2_000,
  permissionProfile: ":workspace" as const,
  pluginCapability: true as const,
  preset,
  processGeneration: profile.processGeneration,
  profileId: profile.id,
  reasoningEffort: presetRequirements[preset].effort,
  reviewMode: "auto_review" as const,
  serviceTier: fast ? "priority" as const : null,
});

const claudeAdoptionRuntimeProfile = (
  profile: Readonly<{ id: string; processGeneration: number }>,
) => ({
  claudeVersion: "2.1.260",
  configHome: "personal" as const,
  inputFormat: "stream-json" as const,
  model: presetRequirements["fable-max"].model,
  observedAt: 2_000,
  outputFormat: "stream-json" as const,
  permissionMode: "default" as const,
  preset: "fable-max" as const,
  processGeneration: profile.processGeneration,
  profileId: profile.id,
  reasoningEffort: "max" as const,
});

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

const usageFingerprint = "a".repeat(64);
const resetAccountFingerprint = (email: string): string =>
  createHash("sha256").update(email.trim().toLowerCase()).digest("hex");

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
    const session = upsertProvenTestSession(store, {
      profileId: profile.id,
      providerThreadId: "thread-restart",
      preset: "high",
      fastEnabled: false,
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
    const session = store.createSession({
      profileId: profile.id,
      preset: "high",
      fastEnabled: false,
    });

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

  test("adopts personal-home candidates atomically and keeps provenance private", async () => {
    const { store } = await fixture();
    const profile = signInProfile(store, "Personal runtime", "personal-runtime@example.com");
    expect(store.readSessionAdoptionPolicy("codex")).toBeNull();
    expect(store.setSessionAdoptionPolicy({
      provider: "codex",
      profileId: profile.id,
    })).toMatchObject({
      enabled: true,
      profileId: profile.id,
      provider: "codex",
      revision: 1,
    });

    const candidate = store.upsertSessionAdoptionCandidate({
      provider: "codex",
      providerThreadId: "personal-thread",
      title: "Personal terminal session",
      state: "idle",
      providerUpdatedAt: 10,
      liveness: "not_live",
    });
    expect(candidate).toMatchObject({
      provider: "codex",
      providerThreadId: "personal-thread",
      status: "pending",
    });
    const refreshedCandidate = store.upsertSessionAdoptionCandidate({
      provider: "codex",
      providerThreadId: "personal-thread",
      title: "Personal terminal session",
      state: "idle",
      providerUpdatedAt: 10,
      liveness: "not_live",
    });
    expect(() => store.adoptSessionCandidate({
      provider: "codex",
      providerThreadId: candidate.providerThreadId,
      expectedCandidateRevision: candidate.revision,
      profileId: profile.id,
      profileGeneration: profile.processGeneration,
      preset: "ultra",
      fastEnabled: true,
      runtimeProfile: codexAdoptionRuntimeProfile(profile, "ultra", true),
      providerAccountKey: testProviderAccountKey("codex"),
    })).toThrow("SESSION_ADOPTION_CANDIDATE_STALE");
    expect(() => store.adoptSessionCandidate({
      provider: "codex",
      providerThreadId: candidate.providerThreadId,
      expectedCandidateRevision: refreshedCandidate.revision,
      profileId: profile.id,
      profileGeneration: profile.processGeneration,
      preset: "ultra",
      fastEnabled: true,
      runtimeProfile: codexAdoptionRuntimeProfile(profile, "ultra", true),
      providerAccountKey: testProviderAccountKey("codex"),
    })).toThrow("SESSION_ADOPTION_CANDIDATE_NOT_CLAIMED");
    const claimedCandidate = store.fenceSessionAdoptionCandidateForClaim({
      provider: "codex",
      providerThreadId: candidate.providerThreadId,
      expectedRevision: refreshedCandidate.revision,
    });
    const adopted = store.adoptSessionCandidate({
      provider: "codex",
      providerThreadId: candidate.providerThreadId,
      expectedCandidateRevision: claimedCandidate.revision,
      profileId: profile.id,
      profileGeneration: profile.processGeneration,
      preset: "ultra",
      fastEnabled: true,
      runtimeProfile: codexAdoptionRuntimeProfile(profile, "ultra", true),
      providerAccountKey: testProviderAccountKey("codex"),
    });
    expect(adopted.session).toMatchObject({
      profileId: profile.id,
      provider: "codex",
      providerThreadId: "personal-thread",
      preset: "ultra",
      fastEnabled: true,
      state: "idle",
    });
    expect(adopted.candidate.status).toBe("adopted");
    expect(adopted.binding).toMatchObject({
      sessionId: adopted.session.id,
      state: "active",
    });
    expect(store.latestSessionRuntimeProfile(adopted.session.id)).toMatchObject({
      sourceKind: "session_start",
      profile: codexAdoptionRuntimeProfile(profile, "ultra", true),
    });
    expect(Object.keys(adopted.session)).not.toContain("origin");
    expect(Object.keys(adopted.session)).not.toContain("adopted");
    expect(store.isConversationAutomationEnabled(
      adopted.session.id,
      adopted.session.providerThreadId ?? "",
    )).toBe(true);
    expect(store.listLocalSessionPage({
      profileId: profile.id,
      after: null,
      limit: 1,
    })).toEqual({ sessions: [adopted.session], nextPosition: null });
    store.setSessionArchived(adopted.session.id, true);
    expect(store.listLocalSessionPage({
      profileId: profile.id,
      after: null,
      limit: 1,
    }).sessions).toEqual([]);
    expect(store.listLocalSessionPage({
      profileId: profile.id,
      after: null,
      includeArchived: true,
      limit: 1,
    }).sessions).toEqual([store.requireSession(adopted.session.id)]);
    store.setSessionArchived(adopted.session.id, false);

    const detached = store.detachPersonalSession({ sessionId: adopted.session.id });
    expect(detached.binding.state).toBe("detached");
    expect(detached.candidate.status).toBe("fenced");
    expect(detached.session.archivedAt).toBeDefined();
    expect(store.readSessionPersonalRuntimeBinding(adopted.session.id)).toBeNull();
    expect(store.readSessionPersonalRuntimeBinding(adopted.session.id, true)?.state)
      .toBe("detached");
    expect(store.listLocalSessionPage({
      profileId: profile.id,
      after: null,
      includeArchived: true,
      limit: 1,
    }).sessions).toEqual([store.requireSession(adopted.session.id)]);

    // A liveness-only observation does not invent conversation activity and
    // therefore cannot defeat an explicit detach fence.
    expect(store.upsertSessionAdoptionCandidate({
      provider: "codex",
      providerThreadId: "personal-thread",
      title: "Personal terminal session",
      state: "idle",
      providerUpdatedAt: 10,
      liveness: "not_live",
    }).status).toBe("fenced");

    store.setSessionAdoptionPolicy({ provider: "codex", profileId: null });
    store.setSessionAdoptionPolicy({ provider: "codex", profileId: profile.id });
    const pendingAgain = store.listSessionAdoptionCandidates({ provider: "codex" })[0];
    expect(pendingAgain?.status).toBe("pending");
    if (pendingAgain === undefined) throw new Error("Expected the candidate to be pending again.");
    const claimedAgain = store.fenceSessionAdoptionCandidateForClaim({
      provider: "codex",
      providerThreadId: pendingAgain.providerThreadId,
      expectedRevision: pendingAgain.revision,
    });
    const readopted = store.adoptSessionCandidate({
      provider: "codex",
      providerThreadId: "personal-thread",
      expectedCandidateRevision: claimedAgain.revision,
      profileId: profile.id,
      profileGeneration: profile.processGeneration,
      preset: "high",
      fastEnabled: false,
      runtimeProfile: codexAdoptionRuntimeProfile(profile, "high", false),
      providerAccountKey: testProviderAccountKey("codex"),
    });
    expect(readopted.session).toMatchObject({
      id: adopted.session.id,
      preset: "high",
      fastEnabled: false,
    });
    expect("archivedAt" in readopted.session).toBe(false);
    expect(readopted.binding).toMatchObject({ state: "active", revision: 4 });
    expect(store.isConversationAutomationEnabled(
      readopted.session.id,
      readopted.session.providerThreadId ?? "",
    )).toBe(true);

    store.detachPersonalSession({ sessionId: adopted.session.id, archive: false });
    expect(store.upsertSessionAdoptionCandidate({
      provider: "codex",
      providerThreadId: "personal-thread",
      title: "Personal terminal session",
      state: "idle",
      providerUpdatedAt: 11,
      liveness: "not_live",
    }).status).toBe("pending");
  });

  test("stores truthful provider configuration and refuses adoption collisions", async () => {
    const { store } = await fixture();
    const first = signInProfile(store, "First adopter", "first-adopter@example.com");
    const second = signInProfile(store, "Second adopter", "second-adopter@example.com");
    const claude = store.upsertProviderSession({
      profileId: first.id,
      provider: "claude",
      providerThreadId: "truthful-thread",
      title: "Truthful provider",
      preset: "fable-max",
      fastEnabled: false,
      state: "idle",
      providerUpdatedAt: 1,
      providerAccountKey: testProviderAccountKey("claude"),
    });
    expect(claude).toMatchObject({
      provider: "claude",
      preset: "fable-max",
      fastEnabled: false,
    });
    expect(() => store.upsertProviderSession({
      profileId: first.id,
      provider: "codex",
      providerThreadId: "truthful-thread",
      title: "Conflicting provider",
      preset: "high",
      fastEnabled: false,
      state: "idle",
      providerUpdatedAt: 2,
      providerAccountKey: testProviderAccountKey("codex"),
    })).toThrow("SESSION_PROVIDER_THREAD_COLLISION");

    store.setSessionAdoptionPolicy({ provider: "codex", profileId: first.id });
    const ownerCandidate = store.upsertSessionAdoptionCandidate({
      provider: "codex",
      providerThreadId: "one-owner-thread",
      title: "One owner",
      state: "idle",
      liveness: "not_live",
    });
    const claimedOwner = store.fenceSessionAdoptionCandidateForClaim({
      provider: "codex",
      providerThreadId: ownerCandidate.providerThreadId,
      expectedRevision: ownerCandidate.revision,
    });
    const adopted = store.adoptSessionCandidate({
      provider: "codex",
      providerThreadId: "one-owner-thread",
      expectedCandidateRevision: claimedOwner.revision,
      profileId: first.id,
      profileGeneration: first.processGeneration,
      preset: "high",
      fastEnabled: false,
      runtimeProfile: codexAdoptionRuntimeProfile(first, "high", false),
      providerAccountKey: testProviderAccountKey("codex"),
    });
    expect(() => store.setSessionAdoptionPolicy({
      provider: "codex",
      profileId: second.id,
    })).toThrow("SESSION_ADOPTION_POLICY_ACTIVE_BINDINGS");
    expect(store.readSessionAdoptionPolicy("codex")?.profileId).toBe(first.id);
    store.detachPersonalSession({ sessionId: adopted.session.id, archive: false });
    store.setSessionAdoptionPolicy({ provider: "codex", profileId: second.id });
    const reassignedCandidate = store.listSessionAdoptionCandidates({
      provider: "codex",
      status: "pending",
    })[0];
    if (reassignedCandidate === undefined) throw new Error("Expected a reassigned candidate.");
    const claimedReassignment = store.fenceSessionAdoptionCandidateForClaim({
      provider: "codex",
      providerThreadId: reassignedCandidate.providerThreadId,
      expectedRevision: reassignedCandidate.revision,
    });
    expect(() => store.adoptSessionCandidate({
      provider: "codex",
      providerThreadId: "one-owner-thread",
      expectedCandidateRevision: claimedReassignment.revision,
      profileId: second.id,
      profileGeneration: second.processGeneration,
      preset: "high",
      fastEnabled: false,
      runtimeProfile: codexAdoptionRuntimeProfile(second, "high", false),
      providerAccountKey: testProviderAccountKey("codex"),
    })).toThrow("SESSION_ADOPTION_BINDING_COLLISION");
    expect(store.requireSession(adopted.session.id).profileId).toBe(first.id);
  });

  test("recovers an interrupted claim only after a later quiet observation", async () => {
    const { store } = await fixture();
    const profile = signInProfile(store, "Interrupted adopter", "interrupted-adopter@example.com");
    const otherProfile = signInProfile(
      store,
      "Other interrupted adopter",
      "other-interrupted-adopter@example.com",
    );
    store.setSessionAdoptionPolicy({ provider: "codex", profileId: profile.id });
    const candidate = store.upsertSessionAdoptionCandidate({
      provider: "codex",
      providerThreadId: "interrupted-claim-thread",
      title: "Interrupted claim",
      state: "idle",
      providerUpdatedAt: 10,
      liveness: "not_live",
    });
    const claiming = store.fenceSessionAdoptionCandidateForClaim({
      provider: "codex",
      providerThreadId: candidate.providerThreadId,
      expectedRevision: candidate.revision,
    });

    expect(() => store.recoverSessionAdoptionClaimAfterObservation({
      provider: "codex",
      providerThreadId: claiming.providerThreadId,
      profileId: profile.id,
      expectedRevision: claiming.revision,
    })).toThrow("SESSION_ADOPTION_CLAIM_RECOVERY_NOT_PROVEN");
    expect(() => store.setSessionAdoptionPolicy({
      provider: "codex",
      profileId: null,
    })).toThrow("SESSION_ADOPTION_POLICY_UNSETTLED_CLAIM");
    expect(() => store.setSessionAdoptionPolicy({
      provider: "codex",
      profileId: otherProfile.id,
    })).toThrow("SESSION_ADOPTION_POLICY_UNSETTLED_CLAIM");
    expect(store.readSessionAdoptionPolicy("codex")?.profileId).toBe(profile.id);
    expect(store.listSessionAdoptionCandidates({ provider: "codex" })[0]?.status)
      .toBe("claiming");

    const observedAgain = store.upsertSessionAdoptionCandidate({
      provider: "codex",
      providerThreadId: claiming.providerThreadId,
      title: "Interrupted claim",
      state: "idle",
      providerUpdatedAt: 10,
      liveness: "not_live",
    });
    expect(store.recoverSessionAdoptionClaimAfterObservation({
      provider: "codex",
      providerThreadId: claiming.providerThreadId,
      profileId: profile.id,
      expectedRevision: observedAgain.revision,
    }).status).toBe("pending");
  });

  test("round-trips Claude source identity and applies exact-probe liveness with a strict CAS", async () => {
    const home = await realpath(await mkdtemp(join(tmpdir(), "hra-store-claude-probe-")));
    const paths = resolveStatePaths({ homeDirectory: home, platform: "darwin" });
    await initializeStatePaths(paths);
    const store = new StateStore(paths, { now: () => 1_000 });
    stores.push(store);
    const profile = signInProfile(store, "Claude probe", "claude-probe@example.com");
    store.setSessionAdoptionPolicy({ provider: "claude", profileId: profile.id });
    const identity = {
      pid: 41_001,
      pidDomain: "darwin" as const,
      procStart: "Fri Sep  4 11:00:00 2026",
    };
    const replacementIdentity = {
      pid: 41_002,
      pidDomain: "darwin" as const,
      procStart: "Fri Sep  4 11:01:00 2026",
    };
    const observed = store.upsertSessionAdoptionCandidate({
      provider: "claude",
      providerThreadId: "claude-retained-probe",
      title: "Retained Claude candidate",
      state: "terminal",
      providerUpdatedAt: 10,
      liveness: "live",
      sourceProcessIdentity: identity,
    });
    expect(observed.sourceProcessIdentity).toEqual(identity);
    const preserved = store.upsertSessionAdoptionCandidate({
      provider: "claude",
      providerThreadId: observed.providerThreadId,
      title: observed.title,
      state: observed.providerState,
      ...(observed.providerUpdatedAt === null
        ? {}
        : { providerUpdatedAt: observed.providerUpdatedAt }),
      liveness: observed.liveness,
    });
    expect(preserved.sourceProcessIdentity).toEqual(identity);

    const claiming = store.fenceSessionAdoptionCandidateForClaim({
      provider: "claude",
      providerThreadId: preserved.providerThreadId,
      expectedRevision: preserved.revision,
    });
    const probed = store.updateClaudeSessionAdoptionCandidateLivenessAfterExactProbe({
      providerThreadId: claiming.providerThreadId,
      expectedRevision: claiming.revision,
      expectedSourceProcessIdentity: identity,
      liveness: "not_live",
    });
    expect(probed).toMatchObject({
      liveness: "not_live",
      sourceProcessIdentity: identity,
      status: "claiming",
    });
    expect(probed.lastObservedAt).toBeGreaterThan(probed.lastAttemptAt ?? Number.MAX_VALUE);
    expect(() => store.updateClaudeSessionAdoptionCandidateLivenessAfterExactProbe({
      providerThreadId: probed.providerThreadId,
      expectedRevision: claiming.revision,
      expectedSourceProcessIdentity: identity,
      liveness: "live",
    })).toThrow("SESSION_ADOPTION_CANDIDATE_PROBE_CONFLICT");
    expect(() => store.updateClaudeSessionAdoptionCandidateLivenessAfterExactProbe({
      providerThreadId: probed.providerThreadId,
      expectedRevision: probed.revision,
      expectedSourceProcessIdentity: replacementIdentity,
      liveness: "live",
    })).toThrow("SESSION_ADOPTION_CANDIDATE_PROBE_CONFLICT");

    const recovered = store.recoverSessionAdoptionClaimAfterObservation({
      provider: "claude",
      providerThreadId: probed.providerThreadId,
      profileId: profile.id,
      expectedRevision: probed.revision,
    });
    const reclaimed = store.fenceSessionAdoptionCandidateForClaim({
      provider: "claude",
      providerThreadId: recovered.providerThreadId,
      expectedRevision: recovered.revision,
    });
    store.recordClaimedClaudeProcessAuthority({
      providerThreadId: reclaimed.providerThreadId,
      profileId: profile.id,
      profileGeneration: profile.processGeneration,
      runtimeScope: "personal",
      identity,
    });
    const claimedWithAuthority = store.listSessionAdoptionCandidates({
      provider: "claude",
    }).find((candidate) => candidate.providerThreadId === reclaimed.providerThreadId);
    if (claimedWithAuthority === undefined) {
      throw new Error("Expected the claimed candidate after process custody was recorded.");
    }
    const adopted = store.adoptSessionCandidate({
      provider: "claude",
      providerThreadId: reclaimed.providerThreadId,
      expectedCandidateRevision: claimedWithAuthority.revision,
      profileId: profile.id,
      profileGeneration: profile.processGeneration,
      preset: "fable-max",
      fastEnabled: false,
      runtimeProfile: claudeAdoptionRuntimeProfile(profile),
      providerAccountKey: testProviderAccountKey("claude"),
      claudeProcessIdentity: identity,
    });
    expect(() => store.updateClaudeSessionAdoptionCandidateLivenessAfterExactProbe({
      providerThreadId: adopted.candidate.providerThreadId,
      expectedRevision: adopted.candidate.revision,
      expectedSourceProcessIdentity: identity,
      liveness: "live",
    })).toThrow("SESSION_ADOPTION_CANDIDATE_PROBE_CONFLICT");

    const authority = store.readClaudeProcessAuthority({
      providerThreadId: adopted.candidate.providerThreadId,
      profileId: profile.id,
      runtimeScope: "personal",
    });
    if (authority === null) throw new Error("Expected retained Claude process authority.");
    const releasing = store.beginClaudeProcessAuthorityRelease({
      providerThreadId: authority.providerThreadId,
      profileId: authority.profileId,
      runtimeScope: authority.runtimeScope,
      expectedRevision: authority.revision,
      identity: authority.identity,
    });
    store.completeClaudeProcessAuthorityRelease({
      providerThreadId: releasing.providerThreadId,
      profileId: releasing.profileId,
      runtimeScope: releasing.runtimeScope,
      expectedRevision: releasing.revision,
      identity: releasing.identity,
    });
    const detached = store.detachPersonalSession({
      sessionId: adopted.session.id,
      archive: false,
    });
    expect(detached.candidate.status).toBe("fenced");
    expect(() => store.updateClaudeSessionAdoptionCandidateLivenessAfterExactProbe({
      providerThreadId: detached.candidate.providerThreadId,
      expectedRevision: detached.candidate.revision,
      expectedSourceProcessIdentity: identity,
      liveness: "live",
    })).toThrow("SESSION_ADOPTION_CANDIDATE_PROBE_CONFLICT");

    const sameIdentity = store.upsertSessionAdoptionCandidate({
      provider: "claude",
      providerThreadId: detached.candidate.providerThreadId,
      title: detached.candidate.title,
      state: detached.candidate.providerState,
      ...(detached.candidate.providerUpdatedAt === null
        ? {}
        : { providerUpdatedAt: detached.candidate.providerUpdatedAt }),
      liveness: detached.candidate.liveness,
    });
    expect(sameIdentity).toMatchObject({
      sourceProcessIdentity: identity,
      status: "fenced",
    });
    const changedIdentity = store.upsertSessionAdoptionCandidate({
      provider: "claude",
      providerThreadId: detached.candidate.providerThreadId,
      title: detached.candidate.title,
      state: detached.candidate.providerState,
      ...(detached.candidate.providerUpdatedAt === null
        ? {}
        : { providerUpdatedAt: detached.candidate.providerUpdatedAt }),
      liveness: detached.candidate.liveness,
      sourceProcessIdentity: replacementIdentity,
    });
    expect(changedIdentity).toMatchObject({
      sourceProcessIdentity: replacementIdentity,
      status: "pending",
    });
    expect(store.listRecentClaudeSessionAdoptionCandidatesWithSourceIdentity({
      providerUpdatedAfter: 10,
    }).map((candidate) => candidate.providerThreadId)).toContain(
      changedIdentity.providerThreadId,
    );
    const detachedBindingProbed = store
      .updateClaudeSessionAdoptionCandidateLivenessAfterExactProbe({
        providerThreadId: changedIdentity.providerThreadId,
        expectedRevision: changedIdentity.revision,
        expectedSourceProcessIdentity: replacementIdentity,
        liveness: "not_live",
      });
    expect(detachedBindingProbed.status).toBe("pending");
    expect(store.upsertSessionAdoptionCandidate({
      provider: "claude",
      providerThreadId: detached.candidate.providerThreadId,
      title: detached.candidate.title,
      state: detached.candidate.providerState,
      ...(detached.candidate.providerUpdatedAt === null
        ? {}
        : { providerUpdatedAt: detached.candidate.providerUpdatedAt }),
      liveness: detached.candidate.liveness,
      sourceProcessIdentity: null,
    }).sourceProcessIdentity).toBeNull();
    expect(() => store.upsertSessionAdoptionCandidate({
      provider: "codex",
      providerThreadId: "codex-cannot-own-source-pid",
      title: "Invalid Codex source",
      state: "idle",
      providerUpdatedAt: 10,
      liveness: "not_live",
      sourceProcessIdentity: identity,
    })).toThrow("SESSION_ADOPTION_SOURCE_PROCESS_PROVIDER_INVALID");
  });

  test("fairly bounds recent retained Claude candidates eligible for exact reprobe", async () => {
    const home = await realpath(await mkdtemp(join(tmpdir(), "hra-store-claude-fair-")));
    const paths = resolveStatePaths({ homeDirectory: home, platform: "darwin" });
    await initializeStatePaths(paths);
    const store = new StateStore(paths, { now: () => 1_000 });
    stores.push(store);
    const identity = (pid: number) => ({
      pid,
      pidDomain: "darwin" as const,
      procStart: `claude-process-${pid}`,
    });
    const first = store.upsertSessionAdoptionCandidate({
      provider: "claude",
      providerThreadId: "a-retained-claude",
      title: "First retained Claude candidate",
      state: "terminal",
      providerUpdatedAt: 10,
      liveness: "live",
      sourceProcessIdentity: identity(43_001),
    });
    const second = store.upsertSessionAdoptionCandidate({
      provider: "claude",
      providerThreadId: "b-retained-claude",
      title: "Second retained Claude candidate",
      state: "terminal",
      providerUpdatedAt: 10,
      liveness: "live",
      sourceProcessIdentity: identity(43_002),
    });
    store.upsertSessionAdoptionCandidate({
      provider: "claude",
      providerThreadId: "c-old-claude",
      title: "Old Claude candidate",
      state: "terminal",
      providerUpdatedAt: 9,
      liveness: "live",
      sourceProcessIdentity: identity(43_003),
    });
    store.upsertSessionAdoptionCandidate({
      provider: "claude",
      providerThreadId: "d-identity-free-claude",
      title: "Identity-free Claude candidate",
      state: "terminal",
      providerUpdatedAt: 10,
      liveness: "unknown",
      sourceProcessIdentity: null,
    });
    expect(store.listRecentClaudeSessionAdoptionCandidatesWithSourceIdentity({
      providerUpdatedAfter: 10,
      limit: 1,
    }).map((candidate) => candidate.providerThreadId)).toEqual([first.providerThreadId]);
    store.updateClaudeSessionAdoptionCandidateLivenessAfterExactProbe({
      providerThreadId: first.providerThreadId,
      expectedRevision: first.revision,
      expectedSourceProcessIdentity: identity(43_001),
      liveness: "live",
    });
    expect(store.listRecentClaudeSessionAdoptionCandidatesWithSourceIdentity({
      providerUpdatedAfter: 10,
      limit: 2,
    }).map((candidate) => candidate.providerThreadId)).toEqual([
      second.providerThreadId,
      first.providerThreadId,
    ]);
  });

  test("claims Claude only after liveness ends and fences profile removal", async () => {
    const { store } = await fixture();
    const profile = signInProfile(store, "Claude adopter", "claude-adopter@example.com");
    store.setSessionAdoptionPolicy({ provider: "claude", profileId: profile.id });
    const live = store.upsertSessionAdoptionCandidate({
      provider: "claude",
      providerThreadId: "claude-personal-thread",
      title: "Claude terminal session",
      state: "terminal",
      providerUpdatedAt: 10,
      liveness: "live",
    });
    const processIdentity = {
      pid: 42_001,
      pidDomain: "darwin" as const,
      procStart: "Fri Sep  4 12:00:00 2026",
    };
    store.fenceSessionAdoptionCandidateForClaim({
      provider: "claude",
      providerThreadId: live.providerThreadId,
      expectedRevision: live.revision,
    });
    store.recordClaimedClaudeProcessAuthority({
      providerThreadId: live.providerThreadId,
      profileId: profile.id,
      profileGeneration: profile.processGeneration,
      runtimeScope: "personal",
      identity: processIdentity,
    });
    const claimedLive = store.listSessionAdoptionCandidates({ provider: "claude" })[0];
    if (claimedLive === undefined) throw new Error("Expected the claimed Claude candidate.");
    expect(() => store.adoptSessionCandidate({
      provider: "claude",
      providerThreadId: live.providerThreadId,
      expectedCandidateRevision: claimedLive.revision,
      profileId: profile.id,
      profileGeneration: profile.processGeneration,
      preset: "fable-max",
      fastEnabled: false,
      runtimeProfile: claudeAdoptionRuntimeProfile(profile),
      providerAccountKey: testProviderAccountKey("claude"),
      claudeProcessIdentity: processIdentity,
    })).toThrow("SESSION_ADOPTION_SOURCE_STILL_LIVE");

    const stopped = store.upsertSessionAdoptionCandidate({
      provider: "claude",
      providerThreadId: "claude-personal-thread",
      title: "Claude terminal session",
      state: "terminal",
      providerUpdatedAt: 10,
      liveness: "not_live",
    });
    const adopted = store.adoptSessionCandidate({
      provider: "claude",
      providerThreadId: stopped.providerThreadId,
      expectedCandidateRevision: stopped.revision,
      profileId: profile.id,
      profileGeneration: profile.processGeneration,
      preset: "fable-max",
      fastEnabled: false,
      runtimeProfile: claudeAdoptionRuntimeProfile(profile),
      providerAccountKey: testProviderAccountKey("claude"),
      claudeProcessIdentity: processIdentity,
    });
    expect(adopted.session.state).toBe("terminal");
    expect(() => store.removeProfile(profile.id))
      .toThrow("SESSION_ADOPTION_PROFILE_ACTIVE_BINDINGS");

    expect(store.setSessionAdoptionPolicy({
      provider: "claude",
      profileId: null,
    })).toMatchObject({ enabled: false, profileId: null });
    expect(store.readSessionPersonalRuntimeBinding(adopted.session.id)).toMatchObject({
      state: "active",
    });
    expect(store.readClaudeProcessAuthority({
      providerThreadId: live.providerThreadId,
      profileId: profile.id,
      runtimeScope: "personal",
    })).toMatchObject({ state: "bound", sessionId: adopted.session.id });

    const claimedProcess = store.readClaudeProcessAuthority({
      providerThreadId: live.providerThreadId,
      profileId: profile.id,
      runtimeScope: "personal",
    });
    if (claimedProcess === null) throw new Error("Expected Claude process custody.");
    const releasingProcess = store.beginClaudeProcessAuthorityRelease({
      providerThreadId: claimedProcess.providerThreadId,
      profileId: claimedProcess.profileId,
      runtimeScope: claimedProcess.runtimeScope,
      expectedRevision: claimedProcess.revision,
      identity: claimedProcess.identity,
    });
    store.completeClaudeProcessAuthorityRelease({
      providerThreadId: releasingProcess.providerThreadId,
      profileId: releasingProcess.profileId,
      runtimeScope: releasingProcess.runtimeScope,
      expectedRevision: releasingProcess.revision,
      identity: releasingProcess.identity,
    });
    store.detachPersonalSession({ sessionId: adopted.session.id });
    store.removeProfile(profile.id);
    expect(store.requireProfileById(profile.id, { includeRemoved: true }).state).toBe("removed");
    expect(store.readSessionAdoptionPolicy("claude")).toMatchObject({
      enabled: false,
      profileId: null,
    });
  });

  test("scopes Claude process authority by provider home and releases only the exact row", async () => {
    const { store } = await fixture();
    const first = signInProfile(store, "First Claude home", "first-claude-home@example.com");
    const second = signInProfile(store, "Second Claude home", "second-claude-home@example.com");
    const sharedThreadId = "same-opaque-claude-thread";
    const records = [
      store.recordClaimedClaudeProcessAuthority({
        providerThreadId: sharedThreadId,
        profileId: first.id,
        profileGeneration: first.processGeneration,
        runtimeScope: "managed",
        identity: { pid: 51_001, pidDomain: "darwin", procStart: "managed-first" },
      }),
      store.recordClaimedClaudeProcessAuthority({
        providerThreadId: sharedThreadId,
        profileId: first.id,
        profileGeneration: first.processGeneration,
        runtimeScope: "personal",
        identity: { pid: 51_002, pidDomain: "darwin", procStart: "personal-first" },
      }),
      store.recordClaimedClaudeProcessAuthority({
        providerThreadId: sharedThreadId,
        profileId: second.id,
        profileGeneration: second.processGeneration,
        runtimeScope: "personal",
        identity: { pid: 51_003, pidDomain: "darwin", procStart: "personal-second" },
      }),
    ];
    expect(records.map((record) => [record.runtimeScope, record.profileId])).toEqual([
      ["managed", first.id],
      ["personal", first.id],
      ["personal", second.id],
    ]);

    const selected = records[2];
    if (selected === undefined) throw new Error("Expected a selected authority row.");
    const releasing = store.beginClaudeProcessAuthorityRelease({
      providerThreadId: selected.providerThreadId,
      profileId: selected.profileId,
      runtimeScope: selected.runtimeScope,
      expectedRevision: selected.revision,
      identity: selected.identity,
    });
    store.completeClaudeProcessAuthorityRelease({
      providerThreadId: releasing.providerThreadId,
      profileId: releasing.profileId,
      runtimeScope: releasing.runtimeScope,
      expectedRevision: releasing.revision,
      identity: releasing.identity,
    });
    expect(store.readClaudeProcessAuthority({
      providerThreadId: sharedThreadId,
      profileId: second.id,
      runtimeScope: "personal",
    })?.state).toBe("released");
    expect(store.readClaudeProcessAuthority({
      providerThreadId: sharedThreadId,
      profileId: first.id,
      runtimeScope: "managed",
    })?.state).toBe("claimed");
    expect(store.readClaudeProcessAuthority({
      providerThreadId: sharedThreadId,
      profileId: first.id,
      runtimeScope: "personal",
    })?.state).toBe("claimed");
  });

  test("stages one-shot Claude launch intent authority and fences restaging ABA", async () => {
    const { store } = await fixture();
    const profile = signInProfile(
      store,
      "Claude launch intent",
      "claude-launch-intent@example.com",
    );
    const firstSession = store.createSession({
      profileId: profile.id,
      provider: "claude",
      preset: "fable-max",
      fastEnabled: false,
    });
    const secondSession = store.createSession({
      profileId: profile.id,
      provider: "claude",
      preset: "fable-max",
      fastEnabled: false,
    });
    const staged = store.stageClaudeProcessLaunchIntent({
      providerThreadId: "launch-intent-thread",
      profileId: profile.id,
      profileGeneration: profile.processGeneration,
      runtimeScope: "managed",
      sessionId: firstSession.id,
    });
    expect(staged).toMatchObject({
      profileId: profile.id,
      profileGeneration: profile.processGeneration,
      providerThreadId: "launch-intent-thread",
      revision: 1,
      runtimeScope: "managed",
      sessionId: firstSession.id,
    });
    expect(staged.intentId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u,
    );
    expect(() => store.stageClaudeProcessLaunchIntent({
      providerThreadId: staged.providerThreadId,
      profileId: staged.profileId,
      profileGeneration: staged.profileGeneration,
      runtimeScope: staged.runtimeScope,
      sessionId: firstSession.id,
    })).toThrow("SESSION_CLAUDE_PROCESS_LAUNCH_INTENT_CONFLICT");
    expect(store.readClaudeProcessLaunchIntent({
      providerThreadId: staged.providerThreadId,
      profileId: staged.profileId,
      runtimeScope: staged.runtimeScope,
    })).toEqual(staged);
    expect(store.listClaudeProcessLaunchIntents()).toEqual([staged]);
    expect(store.profileHasClaudeProcessLaunchIntents(
      profile.id,
      profile.processGeneration,
    )).toBe(true);

    expect(() => store.stageClaudeProcessLaunchIntent({
      providerThreadId: staged.providerThreadId,
      profileId: staged.profileId,
      profileGeneration: staged.profileGeneration,
      runtimeScope: staged.runtimeScope,
      sessionId: secondSession.id,
    })).toThrow("SESSION_CLAUDE_PROCESS_LAUNCH_INTENT_CONFLICT");
    expect(() => store.stageClaudeProcessLaunchIntent({
      providerThreadId: "second-launch-for-same-session",
      profileId: staged.profileId,
      profileGeneration: staged.profileGeneration,
      runtimeScope: staged.runtimeScope,
      sessionId: firstSession.id,
    })).toThrow("SESSION_CLAUDE_PROCESS_LAUNCH_INTENT_SESSION_CONFLICT");
    expect(() => store.stageClaudeProcessLaunchIntent({
      providerThreadId: "stale-launch-intent",
      profileId: profile.id,
      profileGeneration: profile.processGeneration + 1,
      runtimeScope: "managed",
    })).toThrow("SESSION_CLAUDE_PROCESS_LAUNCH_INTENT_PROFILE_STALE");
    const signedOut = store.createProfile("Signed-out Claude launch");
    expect(() => store.stageClaudeProcessLaunchIntent({
      providerThreadId: "signed-out-launch-intent",
      profileId: signedOut.id,
      profileGeneration: signedOut.processGeneration,
      runtimeScope: "managed",
    })).toThrow("SESSION_CLAUDE_PROCESS_LAUNCH_INTENT_PROFILE_STALE");

    expect(() => store.cancelClaudeProcessLaunchIntent({
      providerThreadId: staged.providerThreadId,
      profileId: staged.profileId,
      profileGeneration: staged.profileGeneration,
      runtimeScope: staged.runtimeScope,
      intentId: "00000000-0000-4000-8000-000000000001",
      expectedRevision: staged.revision,
    })).toThrow("SESSION_CLAUDE_PROCESS_LAUNCH_INTENT_CONFLICT");
    expect(store.cancelClaudeProcessLaunchIntent({
      providerThreadId: staged.providerThreadId,
      profileId: staged.profileId,
      profileGeneration: staged.profileGeneration,
      runtimeScope: staged.runtimeScope,
      intentId: staged.intentId,
      expectedRevision: staged.revision,
    })).toEqual(staged);
    const restaged = store.stageClaudeProcessLaunchIntent({
      providerThreadId: staged.providerThreadId,
      profileId: staged.profileId,
      profileGeneration: staged.profileGeneration,
      runtimeScope: staged.runtimeScope,
      sessionId: firstSession.id,
    });
    expect(restaged.intentId).not.toBe(staged.intentId);
    expect(() => store.cancelClaudeProcessLaunchIntent({
      providerThreadId: staged.providerThreadId,
      profileId: staged.profileId,
      profileGeneration: staged.profileGeneration,
      runtimeScope: staged.runtimeScope,
      intentId: staged.intentId,
      expectedRevision: staged.revision,
    })).toThrow("SESSION_CLAUDE_PROCESS_LAUNCH_INTENT_CONFLICT");
    expect(store.readClaudeProcessLaunchIntent({
      providerThreadId: restaged.providerThreadId,
      profileId: restaged.profileId,
      runtimeScope: restaged.runtimeScope,
    })).toEqual(restaged);

    const process = store.recordClaimedClaudeProcessAuthority({
      providerThreadId: "already-live-launch-intent",
      profileId: profile.id,
      profileGeneration: profile.processGeneration,
      runtimeScope: "managed",
      identity: {
        pid: 51_050,
        pidDomain: "darwin",
        procStart: "already-live-before-launch-intent",
      },
    });
    expect(() => store.stageClaudeProcessLaunchIntent({
      providerThreadId: process.providerThreadId,
      profileId: process.profileId,
      profileGeneration: process.profileGeneration,
      runtimeScope: process.runtimeScope,
    })).toThrow("SESSION_CLAUDE_PROCESS_LAUNCH_INTENT_PROCESS_LIVE");
  });

  test("atomically hands exact Claude launch intent authority to exact process custody", async () => {
    const { store } = await fixture();
    const profile = signInProfile(
      store,
      "Claude launch handoff",
      "claude-launch-handoff@example.com",
    );
    const session = store.createSession({
      profileId: profile.id,
      provider: "claude",
      preset: "fable-max",
      fastEnabled: false,
    });
    const otherSession = store.createSession({
      profileId: profile.id,
      provider: "claude",
      preset: "fable-max",
      fastEnabled: false,
    });
    const intent = store.stageClaudeProcessLaunchIntent({
      providerThreadId: "launch-handoff-thread",
      profileId: profile.id,
      profileGeneration: profile.processGeneration,
      runtimeScope: "managed",
      sessionId: session.id,
    });
    const collidingIdentity = {
      pid: 51_051,
      pidDomain: "darwin" as const,
      procStart: "launch-handoff-collision",
    };
    store.recordClaimedClaudeProcessAuthority({
      providerThreadId: "launch-handoff-existing-process",
      profileId: profile.id,
      profileGeneration: profile.processGeneration,
      runtimeScope: "managed",
      identity: collidingIdentity,
    });
    const claim = (overrides: Partial<Parameters<
      StateStore["recordClaimedClaudeProcessAuthority"]
    >[0]> = {}) => store.recordClaimedClaudeProcessAuthority({
      providerThreadId: intent.providerThreadId,
      profileId: intent.profileId,
      profileGeneration: intent.profileGeneration,
      runtimeScope: intent.runtimeScope,
      ...(intent.sessionId === null ? {} : { sessionId: intent.sessionId }),
      identity: {
        pid: 51_052,
        pidDomain: "darwin",
        procStart: "launch-handoff-exact-process",
      },
      expectedLaunchIntentId: intent.intentId,
      expectedLaunchIntentRevision: intent.revision,
      ...overrides,
    });

    expect(() => claim({
      expectedLaunchIntentId: "00000000-0000-4000-8000-000000000002",
    })).toThrow("SESSION_CLAUDE_PROCESS_LAUNCH_INTENT_CONFLICT");
    expect(() => claim({ sessionId: otherSession.id }))
      .toThrow("SESSION_CLAUDE_PROCESS_LAUNCH_INTENT_CONFLICT");
    expect(() => claim({ identity: collidingIdentity })).toThrow();
    expect(store.readClaudeProcessAuthority({
      providerThreadId: intent.providerThreadId,
      profileId: intent.profileId,
      runtimeScope: intent.runtimeScope,
    })).toBeNull();
    expect(store.readClaudeProcessLaunchIntent({
      providerThreadId: intent.providerThreadId,
      profileId: intent.profileId,
      runtimeScope: intent.runtimeScope,
    })).toEqual(intent);

    const claimed = claim();
    expect(claimed).toMatchObject({
      providerThreadId: intent.providerThreadId,
      profileId: intent.profileId,
      profileGeneration: intent.profileGeneration,
      runtimeScope: intent.runtimeScope,
      sessionId: session.id,
      state: "claimed",
      identity: {
        pid: 51_052,
        pidDomain: "darwin",
        procStart: "launch-handoff-exact-process",
      },
    });
    expect(store.readClaudeProcessLaunchIntent({
      providerThreadId: intent.providerThreadId,
      profileId: intent.profileId,
      runtimeScope: intent.runtimeScope,
    })).toBeNull();
    expect(() => claim()).toThrow("SESSION_CLAUDE_PROCESS_LAUNCH_INTENT_CONFLICT");
    expect(store.readClaudeProcessAuthority({
      providerThreadId: intent.providerThreadId,
      profileId: intent.profileId,
      runtimeScope: intent.runtimeScope,
    })).toEqual(claimed);
  });

  test("launch intents guard account state, generation, identity, and staged recovery", async () => {
    const { store } = await fixture();
    const profile = signInProfile(
      store,
      "Claude launch guards",
      "claude-launch-guards@example.com",
    );
    const otherProfile = signInProfile(
      store,
      "Other Claude launch guards",
      "other-claude-launch-guards@example.com",
    );
    store.setSessionAdoptionPolicy({ provider: "claude", profileId: profile.id });
    const intent = store.stageClaudeProcessLaunchIntent({
      providerThreadId: "launch-guard-thread",
      profileId: profile.id,
      profileGeneration: profile.processGeneration,
      runtimeScope: "personal",
    });

    expect(() => store.setSessionAdoptionPolicy({
      provider: "claude",
      profileId: null,
    })).toThrow("SESSION_ADOPTION_POLICY_UNSETTLED_CLAIM");
    expect(() => store.setSessionAdoptionPolicy({
      provider: "claude",
      profileId: otherProfile.id,
    })).toThrow("SESSION_ADOPTION_POLICY_UNSETTLED_CLAIM");
    expect(store.readSessionAdoptionPolicy("claude")?.profileId).toBe(profile.id);

    expect(() => store.setProfileState(
      profile.id,
      profile.processGeneration,
      "signed_out",
    )).toThrow();
    expect(() => store.removeProfile(profile.id)).toThrow();
    expect(() => store.advanceProfileGeneration(
      profile.id,
      profile.processGeneration,
    )).toThrow("live session controllers must release before account generation changes");
    expect(() => store.setProfileState(
      profile.id,
      profile.processGeneration,
      "signed_in",
    )).toThrow("live session controllers must release before account identity changes");
    expect(() => store.setProfileState(
      profile.id,
      profile.processGeneration,
      "signed_in",
      { email: "replacement-launch-identity@example.com", plan: "Plus" },
    )).toThrow("live session controllers must release before account identity changes");
    expect(() => store.setProfileState(
      profile.id,
      profile.processGeneration,
      "recovery_required",
      { email: "claude-launch-guards@example.com", plan: "Plus" },
    )).toThrow("controller revocation must be staged before account recovery");

    const revocation = store.stageProfilePersonalAuthorityRevocation({
      profileId: profile.id,
      expectedGeneration: profile.processGeneration,
    });
    expect(store.setProfileState(
      profile.id,
      profile.processGeneration,
      "recovery_required",
      { email: "claude-launch-guards@example.com", plan: "Plus" },
    )).toBe(true);
    expect(() => store.completeProfilePersonalAuthorityRevocation({
      profileId: profile.id,
      expectedGeneration: profile.processGeneration,
    })).toThrow("PROFILE_PERSONAL_AUTHORITY_REVOCATION_CLAUDE_LAUNCH_INTENT_LIVE");
    expect(store.readProfilePersonalAuthorityRevocation(profile.id)).toEqual(revocation);
    store.cancelClaudeProcessLaunchIntent({
      providerThreadId: intent.providerThreadId,
      profileId: intent.profileId,
      profileGeneration: intent.profileGeneration,
      runtimeScope: intent.runtimeScope,
      intentId: intent.intentId,
      expectedRevision: intent.revision,
    });
    expect(store.requireProfileById(profile.id)).toMatchObject({
      processGeneration: profile.processGeneration,
      state: "recovery_required",
    });
    expect(store.readSessionAdoptionPolicy("claude")).toMatchObject({
      enabled: true,
      profileId: profile.id,
    });
    expect(store.completeProfilePersonalAuthorityRevocation({
      profileId: profile.id,
      expectedGeneration: profile.processGeneration,
    }).state).toBe("signed_out");
  });

  test("launch intents fence session rebind and personal detach", async () => {
    const { store } = await fixture();
    const profile = signInProfile(
      store,
      "Claude launch session fences",
      "claude-launch-session-fences@example.com",
    );
    const starting = store.createSession({
      profileId: profile.id,
      provider: "claude",
      preset: "fable-max",
      fastEnabled: false,
    });
    const startIntent = store.stageClaudeProcessLaunchIntent({
      providerThreadId: "launch-before-session-bind",
      profileId: profile.id,
      profileGeneration: profile.processGeneration,
      runtimeScope: "managed",
      sessionId: starting.id,
    });
    expect(() => store.bindSession({
      sessionId: starting.id,
      expectedRevision: starting.revision,
      providerThreadId: startIntent.providerThreadId,
      state: "idle",
    })).toThrow("live Claude process authority must be released before session rebind");
    store.cancelClaudeProcessLaunchIntent({
      providerThreadId: startIntent.providerThreadId,
      profileId: startIntent.profileId,
      profileGeneration: startIntent.profileGeneration,
      runtimeScope: startIntent.runtimeScope,
      intentId: startIntent.intentId,
      expectedRevision: startIntent.revision,
    });

    store.setSessionAdoptionPolicy({ provider: "codex", profileId: profile.id });
    const candidate = store.upsertSessionAdoptionCandidate({
      provider: "codex",
      providerThreadId: "launch-detach-adopted",
      title: "Launch detach adopted",
      state: "idle",
      providerUpdatedAt: 10,
      liveness: "not_live",
    });
    const claiming = store.fenceSessionAdoptionCandidateForClaim({
      provider: "codex",
      providerThreadId: candidate.providerThreadId,
      expectedRevision: candidate.revision,
    });
    const adopted = store.adoptSessionCandidate({
      provider: "codex",
      providerThreadId: claiming.providerThreadId,
      expectedCandidateRevision: claiming.revision,
      profileId: profile.id,
      profileGeneration: profile.processGeneration,
      preset: "high",
      fastEnabled: false,
      runtimeProfile: codexAdoptionRuntimeProfile(profile, "high", false),
      providerAccountKey: testProviderAccountKey("codex"),
    });
    const detachIntent = store.stageClaudeProcessLaunchIntent({
      providerThreadId: "launch-during-personal-detach",
      profileId: profile.id,
      profileGeneration: profile.processGeneration,
      runtimeScope: "managed",
      sessionId: adopted.session.id,
    });
    expect(() => store.beginPersonalSessionDetach({
      sessionId: adopted.session.id,
    })).toThrow("Claude process launch intent must be cancelled before personal session detach");
    store.cancelClaudeProcessLaunchIntent({
      providerThreadId: detachIntent.providerThreadId,
      profileId: detachIntent.profileId,
      profileGeneration: detachIntent.profileGeneration,
      runtimeScope: detachIntent.runtimeScope,
      intentId: detachIntent.intentId,
      expectedRevision: detachIntent.revision,
    });
    expect(store.detachPersonalSession({
      sessionId: adopted.session.id,
      archive: false,
    }).binding.state).toBe("detached");
  });

  test("reopens durable Claude launch intents without changing their authority", async () => {
    const { store } = await fixture();
    const profile = signInProfile(
      store,
      "Claude launch reopen",
      "claude-launch-reopen@example.com",
    );
    const intent = store.stageClaudeProcessLaunchIntent({
      providerThreadId: "launch-reopen-thread",
      profileId: profile.id,
      profileGeneration: profile.processGeneration,
      runtimeScope: "personal",
    });
    const paths = store.paths;
    store.close();
    stores.splice(stores.indexOf(store), 1);

    const reopened = new StateStore(paths);
    stores.push(reopened);
    expect(reopened.readClaudeProcessLaunchIntent({
      providerThreadId: intent.providerThreadId,
      profileId: intent.profileId,
      runtimeScope: intent.runtimeScope,
    })).toEqual(intent);
    expect(reopened.listClaudeProcessLaunchIntents()).toEqual([intent]);
    expect(reopened.profileHasClaudeProcessLaunchIntents(
      profile.id,
      profile.processGeneration,
    )).toBe(true);
    expect(() => reopened.advanceProfileGeneration(
      profile.id,
      profile.processGeneration,
    )).toThrow("live session controllers must release before account generation changes");
    expect(() => reopened.nextDaemonGeneration(`boot_${"l".repeat(32)}`))
      .toThrow("live session controllers must release before account generation changes");
    expect(reopened.requireProfileById(profile.id)).toMatchObject({
      processGeneration: profile.processGeneration,
      state: "signed_in",
    });
    expect(reopened.readClaudeProcessLaunchIntent({
      providerThreadId: intent.providerThreadId,
      profileId: intent.profileId,
      runtimeScope: intent.runtimeScope,
    })).toEqual(intent);
  });

  test("carries an interrupted personal revocation across daemon generation rollover", async () => {
    const { store } = await fixture();
    const profile = signInProfile(
      store,
      "Restarted personal revocation",
      "restarted-personal-revocation@example.com",
    );
    store.setSessionAdoptionPolicy({ provider: "codex", profileId: profile.id });
    const candidate = store.upsertSessionAdoptionCandidate({
      provider: "codex",
      providerThreadId: "restarted-personal-revocation-thread",
      title: "Restarted personal revocation",
      state: "idle",
      providerUpdatedAt: 10,
      liveness: "not_live",
    });
    const claiming = store.fenceSessionAdoptionCandidateForClaim({
      provider: "codex",
      providerThreadId: candidate.providerThreadId,
      expectedRevision: candidate.revision,
    });
    const adopted = store.adoptSessionCandidate({
      provider: "codex",
      providerThreadId: claiming.providerThreadId,
      expectedCandidateRevision: claiming.revision,
      profileId: profile.id,
      profileGeneration: profile.processGeneration,
      preset: "high",
      fastEnabled: false,
      runtimeProfile: codexAdoptionRuntimeProfile(profile, "high", false),
      providerAccountKey: testProviderAccountKey("codex"),
    });
    const workStore = store.createWorkStore(
      11,
      () => "unused-revocation-rollover-cursor",
      {
        issue: () => `hrac1_${"B".repeat(43)}`,
        verify: () => true,
      },
    );
    const begun = store.beginProfilePersonalAuthorityRevocation({
      profileId: profile.id,
      expectedGeneration: profile.processGeneration,
      workStore,
    });
    expect(begun.revocation).toMatchObject({
      profileGeneration: profile.processGeneration,
      state: "releasing",
    });
    expect(begun.bindings).toEqual([
      expect.objectContaining({ sessionId: adopted.session.id, state: "detaching" }),
    ]);

    const paths = store.paths;
    store.close();
    stores.splice(stores.indexOf(store), 1);
    const restarted = new StateStore(paths, { now: () => 2_000 });
    stores.push(restarted);

    expect(restarted.nextDaemonGeneration(`boot_${"v".repeat(32)}`)).toBe(1);
    const rolledProfile = restarted.requireProfileById(profile.id);
    const rolledRevocation = restarted.readProfilePersonalAuthorityRevocation(profile.id);
    expect(rolledProfile).toMatchObject({
      processGeneration: profile.processGeneration + 1,
      state: "recovery_required",
    });
    expect(rolledRevocation).toMatchObject({
      profileGeneration: rolledProfile.processGeneration,
      revision: begun.revocation.revision + 1,
      state: "releasing",
    });
    expect(rolledRevocation?.updatedAt).toBeGreaterThanOrEqual(begun.revocation.updatedAt);

    expect(restarted.completePersonalSessionDetach({
      sessionId: adopted.session.id,
      archive: true,
    }).binding.state).toBe("detached");
    expect(restarted.completeProfilePersonalAuthorityRevocation({
      profileId: profile.id,
      expectedGeneration: rolledProfile.processGeneration,
    })).toMatchObject({
      processGeneration: rolledProfile.processGeneration + 1,
      state: "signed_out",
    });
  });

  test("blocks ordinary account authority loss while managed Claude custody is unreleased", async () => {
    const { store } = await fixture();
    const profile = signInProfile(
      store,
      "Managed Claude controller",
      "managed-claude-controller@example.com",
    );
    const authority = store.recordClaimedClaudeProcessAuthority({
      providerThreadId: "managed-controller-thread",
      profileId: profile.id,
      profileGeneration: profile.processGeneration,
      runtimeScope: "managed",
      identity: {
        pid: 51_101,
        pidDomain: "darwin",
        procStart: "managed-controller-current-generation",
      },
    });

    expect(() => store.setProfileState(
      profile.id,
      profile.processGeneration,
      "signed_out",
    )).toThrow("live session controllers must release before account authority ends");
    expect(() => store.advanceProfileGeneration(
      profile.id,
      profile.processGeneration,
    )).toThrow("live session controllers must release before account generation changes");

    expect(store.requireProfileById(profile.id)).toMatchObject({
      processGeneration: profile.processGeneration,
      state: "signed_in",
    });
    expect(store.readClaudeProcessAuthority({
      providerThreadId: authority.providerThreadId,
      profileId: authority.profileId,
      runtimeScope: authority.runtimeScope,
    })).toEqual(authority);
  });

  test("pages unbound Claude custody by exact profile generation and scope", async () => {
    const { store } = await fixture();
    const profile = signInProfile(
      store,
      "Paged Claude custody",
      "paged-claude-custody@example.com",
    );
    for (const [index, providerThreadId] of ["custody-a", "custody-b"].entries()) {
      store.recordClaimedClaudeProcessAuthority({
        providerThreadId,
        profileId: profile.id,
        profileGeneration: profile.processGeneration,
        runtimeScope: "managed",
        identity: {
          pid: 53_000 + index,
          pidDomain: "darwin",
          procStart: `paged-custody-${index}`,
        },
      });
    }
    const first = store.listUnreleasedClaudeProcessAuthorityPage({
      profileId: profile.id,
      profileGeneration: profile.processGeneration,
      runtimeScope: "managed",
      afterProviderThreadId: null,
      limit: 1,
    });
    expect(first.authorities).toEqual([
      expect.objectContaining({ providerThreadId: "custody-a", sessionId: null }),
    ]);
    expect(first.continueAfterProviderThreadId).toBe("custody-a");
    const second = store.listUnreleasedClaudeProcessAuthorityPage({
      profileId: profile.id,
      profileGeneration: profile.processGeneration,
      runtimeScope: "managed",
      afterProviderThreadId: first.continueAfterProviderThreadId,
      limit: 1,
    });
    expect(second.authorities).toEqual([
      expect.objectContaining({ providerThreadId: "custody-b", sessionId: null }),
    ]);
  });

  test("binds native and adopted-neutral session authority to the original account identity", async () => {
    const { store } = await fixture();
    const profile = signInProfile(
      store,
      "Session identity binding",
      "original-session-owner@example.com",
    );
    const unproven = store.createSession({
      profileId: profile.id,
      provider: "codex",
      preset: "high",
      fastEnabled: false,
    });
    expect(store.sessionAccountAuthorityMatches(unproven.id, profile.id)).toBe(false);
    expect(store.readSessionProviderAccountAuthority(unproven.id)).toBeNull();
    const merelyBound = store.bindSession({
      sessionId: unproven.id,
      expectedRevision: unproven.revision,
      providerThreadId: "account-unproven-native-thread",
      state: "idle",
    });
    expect(store.sessionAccountAuthorityMatches(merelyBound.id, profile.id)).toBe(false);
    expect(() => store.enqueue(merelyBound.id, "must have provider identity proof"))
      .toThrow("session account authority does not match the signed-in provider identity");

    const session = store.upsertProviderSession({
      profileId: profile.id,
      provider: "codex",
      providerThreadId: "account-bound-native-thread",
      title: "Provider-proven session",
      preset: "high",
      fastEnabled: false,
      state: "idle",
      providerAccountKey: testProviderAccountKey("codex"),
    });
    expect(store.sessionAccountAuthorityMatches(session.id, profile.id)).toBe(true);
    expect(store.readSessionProviderAccountAuthority(session.id)).toMatchObject({
      accountKey: testProviderAccountKey("codex"),
      provider: "codex",
      runtimeScope: "managed",
    });
    expect(store.listLocalSessionPage({
      profileId: profile.id,
      after: null,
      limit: 10,
      requireCurrentAccountAuthority: true,
    }).sessions).toEqual([session]);

    expect(store.setProfileState(
      profile.id,
      profile.processGeneration,
      "signed_in",
      { email: "replacement-session-owner@example.com", plan: "Plus" },
    )).toBe(true);
    expect(store.sessionAccountAuthorityMatches(session.id, profile.id)).toBe(false);
    expect(store.listLocalSessionPage({
      profileId: profile.id,
      after: null,
      limit: 10,
      requireCurrentAccountAuthority: true,
    }).sessions).toEqual([]);
    expect(() => store.enqueue(session.id, "must not cross account identities"))
      .toThrow("session account authority does not match the signed-in provider identity");
    expect(() => store.setSessionTurnState({
      sessionId: session.id,
      expectedRevision: session.revision,
      state: "active",
      activeTurnId: "replacement-account-turn",
    })).toThrow("session account authority does not match the signed-in provider identity");

    expect(store.setProfileState(
      profile.id,
      profile.processGeneration,
      "signed_in",
      { email: "ORIGINAL-SESSION-OWNER@example.com", plan: "Plus" },
    )).toBe(true);
    expect(store.sessionAccountAuthorityMatches(session.id, profile.id)).toBe(true);
    expect(store.listLocalSessionPage({
      profileId: profile.id,
      after: null,
      limit: 10,
      requireCurrentAccountAuthority: true,
    }).sessions).toEqual([store.requireSession(session.id)]);
    expect(store.enqueue(session.id, "same identity may resume")).toMatchObject({
      sessionId: session.id,
      state: "pending",
    });

    expect(store.setProfileState(
      profile.id,
      profile.processGeneration,
      "signed_in",
      { plan: "apiKey" },
    )).toBe(true);
    expect(store.sessionAccountAuthorityMatches(session.id, profile.id)).toBe(false);
    expect(store.listLocalSessionPage({
      profileId: profile.id,
      after: null,
      limit: 10,
      requireCurrentAccountAuthority: true,
    }).sessions).toEqual([]);
    expect(() => store.enqueue(session.id, "unprovable credentials stay fenced"))
      .toThrow("session account authority does not match the signed-in provider identity");
  });

  test("durably pages a scoped account fence and supersedes dirty observations", async () => {
    const value = await fixture();
    let store = value.store;
    const profile = signInProfile(
      store,
      "Paged scoped revocation",
      "paged-scoped-revocation@example.com",
    );
    const accountA = namedProviderAccountKey("codex", "scoped-account-a");
    const accountB = namedProviderAccountKey("codex", "scoped-account-b");
    const accountC = namedProviderAccountKey("codex", "scoped-account-c");
    const affected = Array.from({ length: 502 }, (_, index) =>
      store.upsertProviderSession({
        profileId: profile.id,
        provider: "codex",
        providerThreadId: `paged-scoped-${String(index).padStart(4, "0")}`,
        title: `Paged scoped ${index}`,
        preset: "high",
        fastEnabled: false,
        state: "idle",
        providerAccountKey: accountA,
      }));
    const safe = store.upsertProviderSession({
      profileId: profile.id,
      provider: "codex",
      providerThreadId: "paged-scoped-safe",
      title: "Paged scoped safe",
      preset: "high",
      fastEnabled: false,
      state: "idle",
      providerAccountKey: accountB,
    });

    // Missing and falsely scoped provider rows must not disappear from the
    // selection merely because the old implementation used an inner join.
    const raw = new Database(store.paths.database, { create: false, strict: true });
    try {
      raw.exec("DROP TRIGGER session_provider_account_authority_update_guard");
      raw.query(
        "DELETE FROM session_provider_account_authorities WHERE session_id=?",
      ).run(affected[0]?.id ?? "");
      raw.query(
        `UPDATE session_provider_account_authorities SET runtime_scope='personal'
         WHERE session_id=?`,
      ).run(affected[1]?.id ?? "");
    } finally {
      raw.close(false);
    }

    const begun = store.beginProviderRuntimeAccountRevocation({
      profileId: profile.id,
      expectedGeneration: profile.processGeneration,
      provider: "codex",
      runtimeScope: "managed",
      currentAccountKey: accountB,
      workStore: createRevocationWorkStore(store),
    });
    expect(begun.revocation).toMatchObject({
      currentAccountKey: accountB,
      revision: 1,
      state: "releasing",
    });
    expect(begun.sessionIds).toHaveLength(502);
    expect(new Set(begun.sessionIds)).toEqual(new Set(affected.map((session) => session.id)));
    expect(store.requireSession(safe.id).state).toBe("idle");
    const fencedRevision = store.requireSession(affected[0]?.id ?? "").revision;
    for (const session of affected) {
      expect(store.requireSession(session.id).state).toBe("recovery_required");
    }

    const paths = store.paths;
    store.close();
    stores.splice(stores.indexOf(store), 1);
    store = new StateStore(paths, { now: () => 5_000 });
    stores.push(store);
    expect(store.listReleasingProviderRuntimeAccountRevocations()).toEqual([
      expect.objectContaining({
        profileId: profile.id,
        currentAccountKey: accountB,
        revision: begun.revocation.revision,
      }),
    ]);

    expect(store.nextDaemonGeneration(`boot_${"r".repeat(32)}`)).toBe(1);
    const rolledProfile = store.requireProfileById(profile.id);
    const rolled = store.readProviderRuntimeAccountRevocation({
      profileId: profile.id,
      provider: "codex",
      runtimeScope: "managed",
    });
    expect(rolled).toMatchObject({
      profileGeneration: rolledProfile.processGeneration,
      revision: begun.revocation.revision + 1,
      state: "releasing",
    });
    if (rolled === null) throw new Error("Expected the scoped revocation after restart.");
    const repeated = store.beginProviderRuntimeAccountRevocation({
      profileId: profile.id,
      expectedGeneration: rolledProfile.processGeneration,
      provider: "codex",
      runtimeScope: "managed",
      currentAccountKey: accountB,
      workStore: createRevocationWorkStore(store),
    });
    expect(repeated.revocation.revision).toBe(rolled.revision);
    expect(store.requireSession(affected[0]?.id ?? "").revision).toBe(fencedRevision);

    const superseding = store.beginProviderRuntimeAccountRevocation({
      profileId: profile.id,
      expectedGeneration: rolledProfile.processGeneration,
      provider: "codex",
      runtimeScope: "managed",
      currentAccountKey: accountC,
      workStore: createRevocationWorkStore(store),
    });
    expect(superseding.revocation).toMatchObject({
      currentAccountKey: accountC,
      revision: rolled.revision + 1,
      state: "releasing",
    });
    expect(() => store.completeProviderRuntimeAccountRevocation({
      profileId: profile.id,
      expectedGeneration: rolledProfile.processGeneration,
      provider: "codex",
      runtimeScope: "managed",
      expectedRevision: rolled.revision,
    })).toThrow("PROVIDER_ACCOUNT_AUTHORITY_REVOCATION_CONFLICT");
    const completed = store.completeProviderRuntimeAccountRevocation({
      profileId: profile.id,
      expectedGeneration: rolledProfile.processGeneration,
      provider: "codex",
      runtimeScope: "managed",
      expectedRevision: superseding.revocation.revision,
    });
    expect(completed.state).toBe("completed");
    expect(store.completeProviderRuntimeAccountRevocation({
      profileId: profile.id,
      expectedGeneration: rolledProfile.processGeneration,
      provider: "codex",
      runtimeScope: "managed",
      expectedRevision: superseding.revocation.revision,
    })).toEqual(completed);
  });

  test("a personal scoped revocation fences an overlapping claim before disabling adoption", async () => {
    const { store } = await fixture();
    const profile = signInProfile(
      store,
      "Overlapping adoption claim",
      "overlapping-adoption-claim@example.com",
    );
    store.setSessionAdoptionPolicy({ provider: "codex", profileId: profile.id });
    const candidate = store.upsertSessionAdoptionCandidate({
      provider: "codex",
      providerThreadId: "overlapping-adoption-claim",
      title: "Overlapping adoption claim",
      state: "idle",
      liveness: "not_live",
    });
    const claiming = store.fenceSessionAdoptionCandidateForClaim({
      provider: "codex",
      providerThreadId: candidate.providerThreadId,
      expectedRevision: candidate.revision,
    });
    expect(claiming.status).toBe("claiming");

    const begun = store.beginProviderRuntimeAccountRevocation({
      profileId: profile.id,
      expectedGeneration: profile.processGeneration,
      provider: "codex",
      runtimeScope: "personal",
      currentAccountKey: namedProviderAccountKey("codex", "replacement-personal-home"),
      workStore: createRevocationWorkStore(store),
    });
    expect(begun.sessionIds).toEqual([]);
    expect(store.readSessionAdoptionPolicy("codex")).toMatchObject({
      enabled: false,
      profileId: null,
    });
    expect(store.listSessionAdoptionCandidates({ provider: "codex" })).toEqual([
      expect.objectContaining({
        providerThreadId: candidate.providerThreadId,
        status: "fenced",
      }),
    ]);
    expect(() => store.setSessionAdoptionPolicy({
      provider: "codex",
      profileId: profile.id,
    })).toThrow("provider runtime account revocation must complete before adoption is enabled");
    store.completeProviderRuntimeAccountRevocation({
      profileId: profile.id,
      expectedGeneration: profile.processGeneration,
      provider: "codex",
      runtimeScope: "personal",
      expectedRevision: begun.revocation.revision,
    });
    expect(store.setSessionAdoptionPolicy({
      provider: "codex",
      profileId: profile.id,
    }).enabled).toBe(true);
  });

  test("refuses a foreign WorkStore before staging a scoped fence", async () => {
    const { store } = await fixture();
    const other = await fixture();
    const profile = signInProfile(
      store,
      "Scoped work transaction",
      "scoped-work-transaction@example.com",
    );
    const session = store.upsertProviderSession({
      profileId: profile.id,
      provider: "codex",
      providerThreadId: "scoped-work-transaction",
      title: "Scoped work transaction",
      preset: "high",
      fastEnabled: false,
      state: "idle",
      providerAccountKey: namedProviderAccountKey("codex", "scoped-work-a"),
    });
    expect(() => store.beginProviderRuntimeAccountRevocation({
      profileId: profile.id,
      expectedGeneration: profile.processGeneration,
      provider: "codex",
      runtimeScope: "managed",
      currentAccountKey: namedProviderAccountKey("codex", "scoped-work-b"),
      workStore: createRevocationWorkStore(other.store),
    })).toThrow("PROVIDER_ACCOUNT_AUTHORITY_REVOCATION_WORK_STORE_MISMATCH");
    expect(store.readProviderRuntimeAccountRevocation({
      profileId: profile.id,
      provider: "codex",
      runtimeScope: "managed",
    })).toBeNull();
    expect(store.requireSession(session.id).state).toBe("idle");
  });

  test("rolls back work retirement with a failed scoped session fence", async () => {
    const { store, home } = await fixture();
    const profile = signInProfile(
      store,
      "Atomic scoped work fence",
      "atomic-scoped-work-fence@example.com",
    );
    const projectRoot = join(home, "atomic-scoped-work-fence");
    await mkdir(projectRoot);
    const project = await store.createProject(
      "Atomic scoped work fence",
      projectRoot,
      true,
    );
    const accountA = namedProviderAccountKey("codex", "atomic-scoped-work-a");
    const session = store.upsertProviderSession({
      profileId: profile.id,
      provider: "codex",
      providerThreadId: "atomic-scoped-work-fence",
      projectId: project.id,
      title: "Atomic scoped work fence",
      preset: "high",
      fastEnabled: false,
      state: "idle",
      providerAccountKey: accountA,
    });
    const workStore = createRevocationWorkStore(store);
    const created = workStore.apply({
      kind: "work.create",
      idempotencyKey: "01890f31-a123-7000-8000-000000000901",
      clientRef: "atomic-scoped-work-fence",
      coordinatorSessionId: session.id,
      objective: "Prove the shared authority transaction.",
      routes: [{
        accountId: profile.id,
        projectId: project.id,
        preset: "high",
        fast: false,
      }],
      tasks: [{
        clientRef: "atomic-scoped-work-task",
        dependsOnRefs: [],
        dependsOnTaskIds: [],
        objective: "Hold one claimed task.",
        instructions: "Remain claimed until authority is fenced.",
        criteria: ["The authority fence retires the claim."],
        route: { accountId: profile.id, projectId: project.id },
        preset: "high",
        fast: false,
        priority: 0,
        maxAttempts: 3,
        requiredReviews: 0,
        resultKind: "text",
        minEvidence: 0,
      }],
    });
    if (created.kind !== "work.create") throw new Error("Expected a created work item.");
    const task = created.tasks[0];
    if (task === undefined) throw new Error("Expected one work task.");
    const claimed = workStore.apply({
      kind: "task.claim",
      idempotencyKey: "01890f31-a123-7000-8000-000000000902",
      workId: created.work.id,
      taskId: task.id,
      expectedTaskRevision: task.revision,
      actorSessionId: session.id,
      actorCapability: `hrac1_${"A".repeat(43)}`,
      leaseMs: 5_000,
    });
    if (claimed.kind !== "task.claim") throw new Error("Expected a claimed work task.");

    const raw = new Database(store.paths.database, { create: false, strict: true });
    try {
      raw.exec(`
        CREATE TRIGGER injected_scoped_session_fence_failure
        BEFORE UPDATE OF state ON sessions
        WHEN OLD.id='${session.id}' AND NEW.state='recovery_required'
        BEGIN SELECT RAISE(ABORT,'INJECTED_SCOPED_SESSION_FENCE_FAILURE'); END;
      `);
      expect(() => store.beginProviderRuntimeAccountRevocation({
        profileId: profile.id,
        expectedGeneration: profile.processGeneration,
        provider: "codex",
        runtimeScope: "managed",
        currentAccountKey: namedProviderAccountKey("codex", "atomic-scoped-work-b"),
        workStore,
      })).toThrow("INJECTED_SCOPED_SESSION_FENCE_FAILURE");
      expect(store.readProviderRuntimeAccountRevocation({
        profileId: profile.id,
        provider: "codex",
        runtimeScope: "managed",
      })).toBeNull();
      expect(store.requireSession(session.id).state).toBe("idle");
      expect(workStore.task(task.id).activeAttempt).toMatchObject({
        id: claimed.attempt.id,
        status: "claimed",
      });
      raw.exec("DROP TRIGGER injected_scoped_session_fence_failure");
    } finally {
      raw.close(false);
    }

    const begun = store.beginProviderRuntimeAccountRevocation({
      profileId: profile.id,
      expectedGeneration: profile.processGeneration,
      provider: "codex",
      runtimeScope: "managed",
      currentAccountKey: namedProviderAccountKey("codex", "atomic-scoped-work-b"),
      workStore,
    });
    expect(begun.affectedWorkIds).toEqual([created.work.id]);
    expect(store.requireSession(session.id).state).toBe("recovery_required");
    expect(workStore.task(task.id).activeAttempt).toBeNull();
  });

  test("scoped revocation preserves an unresolved Claude launch and blocks restart", async () => {
    const { store } = await fixture();
    const profile = signInProfile(
      store,
      "Revoked Claude launch",
      "revoked-claude-launch@example.com",
    );
    const session = store.createSession({
      profileId: profile.id,
      provider: "claude",
      preset: "fable-max",
      fastEnabled: false,
    });
    const intent = store.stageClaudeProcessLaunchIntent({
      providerThreadId: "revoked-claude-launch",
      profileId: profile.id,
      profileGeneration: profile.processGeneration,
      runtimeScope: "managed",
      sessionId: session.id,
    });
    const begun = store.beginProviderRuntimeAccountRevocation({
      profileId: profile.id,
      expectedGeneration: profile.processGeneration,
      provider: "claude",
      runtimeScope: "managed",
      currentAccountKey: null,
      workStore: createRevocationWorkStore(store),
    });
    expect(begun.sessionIds).toEqual([session.id]);
    expect(store.requireSession(session.id).state).toBe("recovery_required");
    expect(store.readClaudeProcessLaunchIntent({
      providerThreadId: intent.providerThreadId,
      profileId: intent.profileId,
      runtimeScope: intent.runtimeScope,
    })).toEqual(intent);
    expect(() => store.completeProviderRuntimeAccountRevocation({
      profileId: profile.id,
      expectedGeneration: profile.processGeneration,
      provider: "claude",
      runtimeScope: "managed",
      expectedRevision: begun.revocation.revision,
    })).toThrow("PROVIDER_ACCOUNT_AUTHORITY_REVOCATION_CLAUDE_LAUNCH_INTENT_LIVE");
    expect(() => store.nextDaemonGeneration(`boot_${"q".repeat(32)}`))
      .toThrow("live session controllers must release before account generation changes");
    expect(store.readClaudeProcessLaunchIntent({
      providerThreadId: intent.providerThreadId,
      profileId: intent.profileId,
      runtimeScope: intent.runtimeScope,
    })).toEqual(intent);
    expect(store.readProviderRuntimeAccountRevocation({
      profileId: profile.id,
      provider: "claude",
      runtimeScope: "managed",
    })).toEqual(begun.revocation);
  });

  test("global account replacement retires native and adopted sessions identically", async () => {
    const { store } = await fixture();
    const profile = signInProfile(
      store,
      "Native adopted parity",
      "native-adopted-parity@example.com",
    );
    const accountKey = namedProviderAccountKey("codex", "native-adopted-parity");
    const native = store.upsertProviderSession({
      profileId: profile.id,
      provider: "codex",
      providerThreadId: "native-parity-thread",
      title: "Native parity",
      preset: "high",
      fastEnabled: false,
      state: "idle",
      providerAccountKey: accountKey,
    });
    store.setSessionAdoptionPolicy({ provider: "codex", profileId: profile.id });
    const candidate = store.upsertSessionAdoptionCandidate({
      provider: "codex",
      providerThreadId: "adopted-parity-thread",
      title: "Adopted parity",
      state: "idle",
      liveness: "not_live",
    });
    const claiming = store.fenceSessionAdoptionCandidateForClaim({
      provider: "codex",
      providerThreadId: candidate.providerThreadId,
      expectedRevision: candidate.revision,
    });
    const adopted = store.adoptSessionCandidate({
      provider: "codex",
      providerThreadId: candidate.providerThreadId,
      expectedCandidateRevision: claiming.revision,
      profileId: profile.id,
      profileGeneration: profile.processGeneration,
      preset: "high",
      fastEnabled: false,
      runtimeProfile: codexAdoptionRuntimeProfile(profile, "high", false),
      providerAccountKey: accountKey,
    }).session;
    const queueIds = [native, adopted].map((session, index) =>
      store.enqueue(session.id, `parity queue ${index}`).id);
    const mutationKeys = [native, adopted].map((session, index) => {
      const idempotencyKey = `00000000-0000-4000-8000-${String(820 + index).padStart(12, "0")}`;
      store.prepareMutation({
        kind: "session.rename",
        authorityId: session.id,
        authorityGeneration: profile.processGeneration,
        request: { name: `parity ${index}` },
        idempotencyKey,
      });
      return idempotencyKey;
    });
    const taskStore = store.createSessionTaskStore();
    const taskIds = [native, adopted].map((session, index) =>
      taskStore.create({
        sessionId: session.id,
        name: `Parity task ${index}`,
        prompt: `Run parity task ${index}`,
        minutes: 15,
        status: "active",
        idempotencyKey: `00000000-0000-4000-8000-${String(830 + index).padStart(12, "0")}`,
      }).id);
    const interactions = [native, adopted].map((session, index) =>
      store.admitInteraction({
        publicId: `00000000-0000-4000-8000-${String(840 + index).padStart(12, "0")}`,
        sessionId: session.id,
        authority: {
          profileId: profile.id,
          processGeneration: profile.processGeneration,
          connectionId: `00000000-0000-4000-8000-${String(850 + index).padStart(12, "0")}`,
          requestId: { type: "string", value: `parity-${index}` },
          method: "item/fileChange/requestApproval",
          requestDigest: String(index + 1).repeat(64),
          threadId: session.providerThreadId ?? "",
          turnId: `parity-turn-${index}`,
          itemId: `parity-item-${index}`,
          approvalId: null,
        },
        kind: "file_change_approval",
        blocking: true,
        display: {
          kind: "file_change_approval",
          summary: "Approve parity change",
          reason: null,
          grantRoot: null,
          availableDecisions: ["once", "decline", "cancel"],
        },
      }).record);

    const begun = store.beginProfilePersonalAuthorityRevocation({
      profileId: profile.id,
      expectedGeneration: profile.processGeneration,
      workStore: createRevocationWorkStore(store),
    });
    expect(new Set(begun.sessionIds)).toEqual(new Set([native.id, adopted.id]));
    for (const session of [native, adopted]) {
      const fenced = store.requireSession(session.id);
      expect(fenced.state).toBe("recovery_required");
      expect(fenced.activeTurnId).toBeUndefined();
    }
    for (const queueId of queueIds) {
      expect(store.requireQueue(queueId).state).toBe("cancelled");
    }
    for (const mutationKey of mutationKeys) {
      expect(store.readMutation(mutationKey)?.state).toBe("cancelled");
    }
    for (const [index, taskId] of taskIds.entries()) {
      const sessionId = [native, adopted][index]?.id ?? "";
      expect(taskStore.list(sessionId).find((task) => task.id === taskId)).toMatchObject({
        status: "paused",
        nextDueAt: null,
      });
    }
    for (const interaction of interactions) {
      expect(store.requireInteraction(interaction.publicId).state).toBe("expired");
    }

    store.completePersonalSessionDetach({ sessionId: adopted.id, archive: false });
    store.completeProfilePersonalAuthorityRevocation({
      profileId: profile.id,
      expectedGeneration: profile.processGeneration,
    });
    for (const session of [native, adopted]) {
      const retired = store.requireSession(session.id);
      expect(retired.state).toBe("recovery_required");
      expect(retired.archivedAt).toBeUndefined();
    }
  });

  test("stages recovery before releasing exact managed Claude custody", async () => {
    const { store } = await fixture();
    const profile = signInProfile(
      store,
      "Managed Claude recovery",
      "managed-claude-recovery@example.com",
    );
    const authority = store.recordClaimedClaudeProcessAuthority({
      providerThreadId: "managed-recovery-thread",
      profileId: profile.id,
      profileGeneration: profile.processGeneration,
      runtimeScope: "managed",
      identity: {
        pid: 51_102,
        pidDomain: "darwin",
        procStart: "managed-controller-recovery",
      },
    });

    expect(() => store.setProfileState(
      profile.id,
      profile.processGeneration,
      "recovery_required",
      { email: "managed-claude-recovery@example.com", plan: "Plus" },
    )).toThrow("controller revocation must be staged before account recovery");
    expect(store.stageProfilePersonalAuthorityRevocation({
      profileId: profile.id,
      expectedGeneration: profile.processGeneration,
    })).toMatchObject({
      profileGeneration: profile.processGeneration,
      state: "releasing",
    });
    expect(store.setProfileState(
      profile.id,
      profile.processGeneration,
      "recovery_required",
      { email: "managed-claude-recovery@example.com", plan: "Plus" },
    )).toBe(true);
    expect(() => store.completeProfilePersonalAuthorityRevocation({
      profileId: profile.id,
      expectedGeneration: profile.processGeneration,
    })).toThrow("PROFILE_PERSONAL_AUTHORITY_REVOCATION_CLAUDE_PROCESS_LIVE");

    expect(() => store.beginClaudeProcessAuthorityRelease({
      providerThreadId: authority.providerThreadId,
      profileId: authority.profileId,
      runtimeScope: authority.runtimeScope,
      expectedRevision: authority.revision,
      identity: { ...authority.identity, procStart: "wrong-controller-identity" },
    })).toThrow("SESSION_CLAUDE_PROCESS_AUTHORITY_IDENTITY_MISMATCH");
    const releasing = store.beginClaudeProcessAuthorityRelease({
      providerThreadId: authority.providerThreadId,
      profileId: authority.profileId,
      runtimeScope: authority.runtimeScope,
      expectedRevision: authority.revision,
      identity: authority.identity,
    });
    store.completeClaudeProcessAuthorityRelease({
      providerThreadId: releasing.providerThreadId,
      profileId: releasing.profileId,
      runtimeScope: releasing.runtimeScope,
      expectedRevision: releasing.revision,
      identity: releasing.identity,
    });
    expect(store.completeProfilePersonalAuthorityRevocation({
      profileId: profile.id,
      expectedGeneration: profile.processGeneration,
    })).toMatchObject({
      processGeneration: profile.processGeneration + 1,
      state: "signed_out",
    });
    expect(store.readProfilePersonalAuthorityRevocation(profile.id)).toMatchObject({
      profileGeneration: profile.processGeneration,
      state: "completed",
    });
  });

  test("requires exact managed Claude release before daemon generation rollover", async () => {
    const { store } = await fixture();
    const profile = signInProfile(
      store,
      "Managed Claude restart",
      "managed-claude-restart@example.com",
    );
    const authority = store.recordClaimedClaudeProcessAuthority({
      providerThreadId: "managed-restart-thread",
      profileId: profile.id,
      profileGeneration: profile.processGeneration,
      runtimeScope: "managed",
      identity: {
        pid: 51_103,
        pidDomain: "darwin",
        procStart: "managed-controller-before-restart",
      },
    });
    const workStore = store.createWorkStore(
      9,
      () => "unused-test-cursor",
      {
        issue: () => `hrac1_${"A".repeat(43)}`,
        verify: () => true,
      },
    );

    expect(() => store.advanceProfileGenerationForDaemonShutdown(
      profile.id,
      profile.processGeneration,
      workStore,
    )).toThrow("live session controllers must release before account generation changes");
    expect(store.requireProfileById(profile.id)).toMatchObject({
      processGeneration: profile.processGeneration,
      state: "signed_in",
    });
    expect(store.readClaudeProcessAuthority({
      providerThreadId: authority.providerThreadId,
      profileId: authority.profileId,
      runtimeScope: authority.runtimeScope,
    })).toEqual(authority);

    const releasing = store.beginClaudeProcessAuthorityRelease({
      providerThreadId: authority.providerThreadId,
      profileId: authority.profileId,
      runtimeScope: authority.runtimeScope,
      expectedRevision: authority.revision,
      identity: authority.identity,
    });
    const released = store.completeClaudeProcessAuthorityRelease({
      providerThreadId: releasing.providerThreadId,
      profileId: releasing.profileId,
      runtimeScope: releasing.runtimeScope,
      expectedRevision: releasing.revision,
      identity: releasing.identity,
    });
    expect(store.advanceProfileGenerationForDaemonShutdown(
      profile.id,
      profile.processGeneration,
      workStore,
    )).toMatchObject({
      affectedWorkIds: [],
      profile: {
        processGeneration: profile.processGeneration + 1,
        state: "signed_in",
      },
    });
    expect(store.readClaudeProcessAuthority({
      providerThreadId: authority.providerThreadId,
      profileId: authority.profileId,
      runtimeScope: authority.runtimeScope,
    })).toEqual(released);
    expect(store.listUnreleasedClaudeProcessAuthorities()).not.toContainEqual(released);
  });

  test("repairs an early v35 Claude authority key without losing custody state", async () => {
    const { store } = await fixture();
    const profile = signInProfile(store, "Legacy Claude authority", "legacy-claude@example.com");
    const identities = [
      { pid: 52_001, pidDomain: "darwin" as const, procStart: "legacy-claimed" },
      { pid: 52_002, pidDomain: "darwin" as const, procStart: "legacy-releasing" },
      { pid: 52_003, pidDomain: "darwin" as const, procStart: "legacy-released" },
    ];
    const claimed = identities.map((identity, index) =>
      store.recordClaimedClaudeProcessAuthority({
        providerThreadId: `legacy-thread-${index}`,
        profileId: profile.id,
        profileGeneration: profile.processGeneration,
        runtimeScope: "managed",
        identity,
      }));
    const releasing = store.beginClaudeProcessAuthorityRelease({
      providerThreadId: claimed[1]?.providerThreadId ?? "",
      profileId: profile.id,
      runtimeScope: "managed",
      expectedRevision: claimed[1]?.revision ?? 0,
      identity: identities[1] ?? identities[0]!,
    });
    const releasedBegin = store.beginClaudeProcessAuthorityRelease({
      providerThreadId: claimed[2]?.providerThreadId ?? "",
      profileId: profile.id,
      runtimeScope: "managed",
      expectedRevision: claimed[2]?.revision ?? 0,
      identity: identities[2] ?? identities[0]!,
    });
    store.completeClaudeProcessAuthorityRelease({
      providerThreadId: releasedBegin.providerThreadId,
      profileId: releasedBegin.profileId,
      runtimeScope: releasedBegin.runtimeScope,
      expectedRevision: releasedBegin.revision,
      identity: releasedBegin.identity,
    });
    expect(releasing.state).toBe("releasing");
    const databasePath = store.paths.database;
    store.close();
    stores.splice(stores.indexOf(store), 1);

    const legacy = new Database(databasePath, { create: false, strict: true });
    try {
      legacy.exec(`
        DROP TRIGGER IF EXISTS session_claude_process_authority_session_guard_insert;
        DROP TRIGGER IF EXISTS session_claude_process_authority_session_guard_update;
        DROP TRIGGER IF EXISTS session_claude_process_authority_revision_guard;
        DROP TRIGGER IF EXISTS sessions_claude_process_authority_rebind_guard;
        DROP INDEX IF EXISTS session_claude_process_authorities_live_identity;
        DROP INDEX IF EXISTS session_claude_process_authorities_session;
        ALTER TABLE session_claude_process_authorities
          RENAME TO session_claude_process_authorities_scoped_backup;
        CREATE TABLE session_claude_process_authorities (
          provider_thread_id TEXT PRIMARY KEY,
          profile_id TEXT NOT NULL,
          profile_generation INTEGER NOT NULL,
          runtime_scope TEXT NOT NULL,
          session_id TEXT,
          pid INTEGER NOT NULL,
          pid_domain TEXT NOT NULL,
          proc_start TEXT NOT NULL,
          state TEXT NOT NULL,
          revision INTEGER NOT NULL,
          recorded_at INTEGER NOT NULL,
          released_at INTEGER
        ) STRICT;
        INSERT INTO session_claude_process_authorities
          SELECT * FROM session_claude_process_authorities_scoped_backup;
        DROP TABLE session_claude_process_authorities_scoped_backup;
      `);
    } finally {
      legacy.close(false);
    }

    const reopened = new StateStore(store.paths);
    stores.push(reopened);
    const primaryKey = new Database(databasePath, { readonly: true, strict: true });
    try {
      expect((primaryKey.query(
        "PRAGMA table_info(session_claude_process_authorities)",
      ).all() as { name: string; pk: number }[])
        .filter((column) => column.pk > 0)
        .sort((left, right) => left.pk - right.pk)
        .map((column) => column.name)).toEqual([
          "runtime_scope",
          "profile_id",
          "provider_thread_id",
        ]);
    } finally {
      primaryKey.close(false);
    }
    expect([0, 1, 2].map((index) => reopened.readClaudeProcessAuthority({
      providerThreadId: `legacy-thread-${index}`,
      profileId: profile.id,
      runtimeScope: "managed",
    })?.state)).toEqual(["claimed", "releasing", "released"]);
  });

  test("migrates legacy and partial v35 session identity without inventing provenance", async () => {
    const { store, home } = await fixture();
    const profile = signInProfile(
      store,
      "Legacy provider provenance",
      "legacy-provider-provenance@example.com",
    );
    const projectRoot = join(home, "legacy-provider-provenance");
    await mkdir(projectRoot);
    const project = await store.createProject(
      "Legacy provider provenance",
      projectRoot,
      true,
    );
    const key = namedProviderAccountKey("codex", "legacy-provider-provenance");
    const proven = store.upsertProviderSession({
      profileId: profile.id,
      provider: "codex",
      providerThreadId: "proven-v35-session",
      title: "Proven v35 session",
      preset: "high",
      fastEnabled: false,
      state: "idle",
      providerAccountKey: key,
    });
    const partial = store.upsertProviderSession({
      profileId: profile.id,
      provider: "codex",
      providerThreadId: "partial-v35-session",
      projectId: project.id,
      title: "Partial v35 session",
      preset: "high",
      fastEnabled: false,
      state: "idle",
      providerAccountKey: key,
    });
    const queue = store.enqueue(partial.id, "legacy queued effect");
    const mutationKey = "00000000-0000-4000-8000-000000000903";
    store.prepareMutation({
      kind: "session.rename",
      authorityId: partial.id,
      authorityGeneration: profile.processGeneration,
      request: { name: "Legacy prepared rename" },
      idempotencyKey: mutationKey,
    });
    const sessionTask = store.createSessionTaskStore().create({
      sessionId: partial.id,
      name: "Legacy active task",
      prompt: "Do not dispatch after migration.",
      minutes: 15,
      status: "active",
      idempotencyKey: "00000000-0000-4000-8000-000000000904",
    });
    const interaction = store.admitInteraction({
      publicId: "00000000-0000-4000-8000-000000000905",
      sessionId: partial.id,
      authority: {
        profileId: profile.id,
        processGeneration: profile.processGeneration,
        connectionId: "00000000-0000-4000-8000-000000000906",
        requestId: { type: "string", value: "legacy-migration" },
        method: "item/fileChange/requestApproval",
        requestDigest: "9".repeat(64),
        threadId: partial.providerThreadId ?? "",
        turnId: "legacy-migration-turn",
        itemId: "legacy-migration-item",
        approvalId: null,
      },
      kind: "file_change_approval",
      blocking: true,
      display: {
        kind: "file_change_approval",
        summary: "Legacy migration approval",
        reason: null,
        grantRoot: null,
        availableDecisions: ["once", "decline", "cancel"],
      },
    }).record;
    const workStore = createRevocationWorkStore(store);
    const createdWork = workStore.apply({
      kind: "work.create",
      idempotencyKey: "01890f31-a123-7000-8000-000000000907",
      clientRef: "legacy-migration-work",
      coordinatorSessionId: partial.id,
      objective: "Prove migration-time work retirement.",
      routes: [{
        accountId: profile.id,
        projectId: project.id,
        preset: "high",
        fast: false,
      }],
      tasks: [{
        clientRef: "legacy-migration-work-task",
        dependsOnRefs: [],
        dependsOnTaskIds: [],
        objective: "Hold one legacy claim.",
        instructions: "Retire this claim during v35 repair.",
        criteria: ["The claim is no longer active."],
        route: { accountId: profile.id, projectId: project.id },
        preset: "high",
        fast: false,
        priority: 0,
        maxAttempts: 3,
        requiredReviews: 0,
        resultKind: "text",
        minEvidence: 0,
      }],
    });
    if (createdWork.kind !== "work.create") throw new Error("Expected legacy work.");
    const workTask = createdWork.tasks[0];
    if (workTask === undefined) throw new Error("Expected one legacy work task.");
    const workClaim = workStore.apply({
      kind: "task.claim",
      idempotencyKey: "01890f31-a123-7000-8000-000000000908",
      workId: createdWork.work.id,
      taskId: workTask.id,
      expectedTaskRevision: workTask.revision,
      actorSessionId: partial.id,
      actorCapability: `hrac1_${"A".repeat(43)}`,
      leaseMs: 5_000,
    });
    if (workClaim.kind !== "task.claim") throw new Error("Expected legacy work claim.");
    const paths = store.paths;
    store.close();
    stores.splice(stores.indexOf(store), 1);
    const partialV35 = new Database(paths.database, { create: false, strict: true });
    try {
      partialV35.query(
        "DELETE FROM session_provider_account_authorities WHERE session_id=?",
      ).run(partial.id);
    } finally {
      partialV35.close(false);
    }
    const repaired = new StateStore(paths);
    stores.push(repaired);
    expect(repaired.sessionAccountAuthorityMatches(proven.id, profile.id)).toBe(true);
    expect(repaired.sessionAccountAuthorityMatches(partial.id, profile.id)).toBe(false);
    expect(repaired.readSessionProviderAccountAuthority(partial.id)).toBeNull();
    expect(repaired.requireSession(partial.id).state).toBe("recovery_required");
    expect(repaired.requireQueue(queue.id).state).toBe("cancelled");
    expect(repaired.readMutation(mutationKey)?.state).toBe("cancelled");
    expect(repaired.createSessionTaskStore().list(partial.id)
      .find((task) => task.id === sessionTask.id)).toMatchObject({
        status: "paused",
        nextDueAt: null,
      });
    expect(repaired.requireInteraction(interaction.publicId).state).toBe("expired");
    expect(createRevocationWorkStore(repaired).task(workTask.id).activeAttempt).toBeNull();
    const inspector = new Database(paths.database, { readonly: true, strict: true });
    try {
      expect(inspector.query(
        "SELECT account_key FROM session_account_authorities WHERE session_id=?",
      ).get(partial.id)).toEqual({ account_key: null });
    } finally {
      inspector.close(false);
    }

    const legacyValue = await fixture();
    const legacyProfile = signInProfile(
      legacyValue.store,
      "Version 34 legacy session",
      "version-34-legacy-session@example.com",
    );
    const legacySession = legacyValue.store.createSession({
      profileId: legacyProfile.id,
      provider: "codex",
      preset: "high",
      fastEnabled: false,
    });
    legacyValue.store.close();
    stores.splice(stores.indexOf(legacyValue.store), 1);
    const legacy = new Database(legacyValue.store.paths.database, {
      create: false,
      strict: true,
    });
    try {
      legacy.exec(`
        PRAGMA foreign_keys=OFF;
        DROP TABLE session_provider_account_authorities;
        DROP TABLE session_account_authorities;
        DELETE FROM migrations WHERE version=35;
        PRAGMA user_version=34;
      `);
    } finally {
      legacy.close(false);
    }
    const migrated = new StateStore(legacyValue.store.paths);
    stores.push(migrated);
    expect(migrated.sessionAccountAuthorityMatches(
      legacySession.id,
      legacyProfile.id,
    )).toBe(false);
    expect(migrated.requireSession(legacySession.id).state).toBe("recovery_required");
    expect(migrated.readSessionProviderAccountAuthority(legacySession.id)).toBeNull();
  });

  test("additively repairs early v35 adoption candidates without releasing legacy fences", async () => {
    const { store } = await fixture();
    const candidate = store.upsertSessionAdoptionCandidate({
      provider: "claude",
      providerThreadId: "legacy-v35-candidate",
      title: "Legacy v35 candidate",
      state: "terminal",
      providerUpdatedAt: 10,
      liveness: "not_live",
    });
    const databasePath = store.paths.database;
    store.close();
    stores.splice(stores.indexOf(store), 1);

    const legacy = new Database(databasePath, { create: false, strict: true });
    try {
      legacy.query(
        `UPDATE session_adoption_candidates
         SET claim_status='fenced',fenced_fingerprint=candidate_fingerprint,
           revision=revision+1
         WHERE provider=? AND provider_thread_id=?`,
      ).run(candidate.provider, candidate.providerThreadId);
      legacy.exec(`
        PRAGMA foreign_keys=OFF;
        PRAGMA legacy_alter_table=ON;
        BEGIN IMMEDIATE;
        DROP TRIGGER IF EXISTS session_adoption_candidate_identity_immutable;
        DROP TRIGGER IF EXISTS session_adoption_candidate_revision_guard;
        DROP TRIGGER IF EXISTS session_adoption_candidate_source_identity_guard_insert;
        DROP TRIGGER IF EXISTS session_adoption_candidate_source_identity_guard_update;
        DROP INDEX IF EXISTS session_adoption_candidates_pending;
        DROP INDEX IF EXISTS session_adoption_candidates_claude_reprobe;
        ALTER TABLE session_adoption_candidates
          RENAME TO session_adoption_candidates_v35_early;
        CREATE TABLE session_adoption_candidates (
          provider TEXT NOT NULL CHECK(provider IN ('codex','claude')),
          provider_thread_id TEXT NOT NULL CHECK(length(provider_thread_id) BETWEEN 1 AND 200),
          project_id TEXT,
          title TEXT NOT NULL CHECK(length(CAST(title AS BLOB)) BETWEEN 1 AND 320),
          provider_state TEXT NOT NULL CHECK(provider_state IN ('active','idle','terminal')),
          active_turn_id TEXT CHECK(active_turn_id IS NULL OR length(active_turn_id) BETWEEN 1 AND 2048),
          provider_updated_at REAL CHECK(provider_updated_at IS NULL OR provider_updated_at >= 0),
          liveness TEXT NOT NULL CHECK(liveness IN ('live','not_live','unknown')),
          claim_status TEXT NOT NULL CHECK(claim_status IN ('pending','claiming','adopted','fenced')),
          candidate_fingerprint TEXT NOT NULL CHECK(length(candidate_fingerprint)=64 AND candidate_fingerprint GLOB '[0-9a-f]*'),
          fenced_fingerprint TEXT CHECK(fenced_fingerprint IS NULL OR (length(fenced_fingerprint)=64 AND fenced_fingerprint GLOB '[0-9a-f]*')),
          revision INTEGER NOT NULL CHECK(revision BETWEEN 1 AND 9007199254740991),
          first_discovered_at INTEGER NOT NULL CHECK(first_discovered_at >= 0),
          last_observed_at INTEGER NOT NULL CHECK(last_observed_at >= first_discovered_at),
          last_changed_at INTEGER NOT NULL CHECK(last_changed_at BETWEEN first_discovered_at AND last_observed_at),
          last_attempt_at INTEGER CHECK(last_attempt_at IS NULL OR last_attempt_at >= first_discovered_at),
          PRIMARY KEY(provider,provider_thread_id),
          CHECK(
            (claim_status='fenced' AND fenced_fingerprint IS NOT NULL)
            OR (claim_status!='fenced' AND fenced_fingerprint IS NULL)
          )
        ) STRICT;
        INSERT INTO session_adoption_candidates(
          provider,provider_thread_id,project_id,title,provider_state,
          active_turn_id,provider_updated_at,liveness,claim_status,
          candidate_fingerprint,fenced_fingerprint,revision,
          first_discovered_at,last_observed_at,last_changed_at,last_attempt_at
        )
        SELECT provider,provider_thread_id,project_id,title,provider_state,
          active_turn_id,provider_updated_at,liveness,claim_status,
          candidate_fingerprint,fenced_fingerprint,revision,
          first_discovered_at,last_observed_at,last_changed_at,last_attempt_at
        FROM session_adoption_candidates_v35_early;
        DROP TABLE session_adoption_candidates_v35_early;
        COMMIT;
        PRAGMA legacy_alter_table=OFF;
      `);
    } finally {
      legacy.close(false);
    }

    const reopened = new StateStore(store.paths);
    stores.push(reopened);
    const repaired = reopened.listSessionAdoptionCandidates({ provider: "claude" })[0];
    expect(repaired).toMatchObject({
      providerThreadId: candidate.providerThreadId,
      sourceProcessIdentity: null,
      status: "fenced",
    });
    expect(reopened.upsertSessionAdoptionCandidate({
      provider: candidate.provider,
      providerThreadId: candidate.providerThreadId,
      title: candidate.title,
      state: candidate.providerState,
      ...(candidate.providerUpdatedAt === null
        ? {}
        : { providerUpdatedAt: candidate.providerUpdatedAt }),
      liveness: candidate.liveness,
    }).status).toBe("fenced");
    const inspector = new Database(databasePath, { readonly: true, strict: true });
    try {
      const candidateColumns = inspector.query(
        "PRAGMA table_info(session_adoption_candidates)",
      ).all() as Array<{ name: string }>;
      const candidateColumnNames = candidateColumns.map((column) => column.name);
      for (const name of ["source_pid", "source_pid_domain", "source_proc_start"]) {
        expect(candidateColumnNames.includes(name)).toBe(true);
      }
    } finally {
      inspector.close(false);
    }
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
      provider: "codex",
      providerThreadId: "thread-recovery",
      preset: "high",
      fastEnabled: false,
      title: "Passive projection",
      state: "active",
      activeTurnId: "turn-passive",
      providerUpdatedAt: 11,
      providerAccountKey: testProviderAccountKey("codex"),
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
    const { store, home } = await fixture();
    const profile = signInProfile(store, "Cleanup", "cleanup@example.com");
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

    const projectRoot = join(home, "starting-queue-evidence");
    await mkdir(projectRoot);
    const project = await store.createProject("Starting queue evidence", projectRoot);
    const startAttempt = store.prepareMutation({
      kind: "session.start",
      authorityId: profile.id,
      authorityGeneration: profile.processGeneration,
      request: { projectId: project.id, preset: "high", fast: false },
      idempotencyKey: "00000000-0000-4000-8000-0000000006c0",
    });
    const queued = store.beginSessionStartEffect({
      attemptId: startAttempt.id,
      profileId: profile.id,
      profileGeneration: profile.processGeneration,
      projectId: project.id,
      preset: "high",
      fastEnabled: false,
      providerAccountKey: testProviderAccountKey("codex"),
      evidence: {
        kind: "session.start",
        projectId: project.id,
        clientMessageId: null,
        messageDigest: null,
      },
    });
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
      evidence: {
        kind: "session.send",
        providerThreadId: "thread-restart",
        baseline: { providerUpdatedAt: 10, status: "idle", activeTurnId: null },
        clientMessageId: send.id,
        messageDigest: "a".repeat(64),
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

  test("provider deletion atomically terminalizes pending and in-flight session authority", async () => {
    const { store } = await fixture();
    const profile = signInProfile(store, "Provider deletion", "deleted@example.com");
    const session = upsertProvenTestSession(store, {
      fastEnabled: false,
      preset: "high",
      profileId: profile.id,
      providerThreadId: "thread-provider-deleted",
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
      model: "gpt-5.6-sol",
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
      providerAccountKey: testProviderAccountKey("codex"),
      evidence: { kind: "session.start", projectId: project.id, clientMessageId: null, messageDigest: null },
    });
    expect(store.readMutation("00000000-0000-4000-8000-000000000610")).toMatchObject({
      state: "effect_started",
      sessionStartId: session.id,
      evidence: { evidence: { kind: "session.start", projectId: project.id } },
    });
    expect(store.recoverEffectStartedMutations()).toEqual({ recovered: [attempt.id], unresolved: [] });
    expect(store.requireSession(session.id)).toMatchObject({ state: "recovery_required" });
    expect(store.requireSession(session.id).providerThreadId).toBeUndefined();
    expect(store.sessionAccountAuthorityMatches(session.id, profile.id)).toBe(true);
    expect(store.readSessionProviderAccountAuthority(session.id)).toMatchObject({
      accountKey: testProviderAccountKey("codex"),
      provider: "codex",
      runtimeScope: "managed",
    });
  });

  test("carries either provider's reviewed runtime profile through one session-start evidence row", async () => {
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

    const start = (
      idempotencyKey: string,
      provider: "codex" | "claude",
      preset: "high" | "fable-max",
      runtimeProfile: typeof codexProfile | typeof claudeProfile,
    ) => {
      const providerThreadId = `thread-${provider}`;
      const claudeProcessIdentity = provider === "claude"
        ? {
            pid: 42_101,
            pidDomain: "darwin" as const,
            procStart: "Fri Sep  4 12:01:00 2026",
          }
        : undefined;
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
        providerAccountKey: testProviderAccountKey(provider),
      });
      if (claudeProcessIdentity !== undefined) {
        store.recordClaimedClaudeProcessAuthority({
          providerThreadId,
          profileId: profile.id,
          profileGeneration: profile.processGeneration,
          runtimeScope: "managed",
          sessionId: session.id,
          identity: claudeProcessIdentity,
        });
      }
      store.completeSessionStartEffect({
        attemptId: attempt.id,
        expectedSessionRevision: session.revision,
        providerThreadId,
        receipt: { effectiveRuntimeProfile: runtimeProfile, sessionId: session.id },
        runtimeProfile,
        ...(claudeProcessIdentity === undefined ? {} : { claudeProcessIdentity }),
        sessionId: session.id,
        state: "idle",
      });
      return { attempt, session };
    };

    const codex = start("00000000-0000-4000-8000-0000000006a0", "codex", "high", codexProfile);
    const claude = start("00000000-0000-4000-8000-0000000006a1", "claude", "fable-max", claudeProfile);

    expect(store.requireSession(codex.session.id)).toMatchObject({ preset: "high", provider: "codex" });
    expect(store.requireSession(claude.session.id))
      .toMatchObject({ preset: "fable-max", provider: "claude" });
    expect(store.latestSessionRuntimeProfile(codex.session.id))
      .toMatchObject({ profile: codexProfile, sourceKind: "session_start" });
    expect(store.latestSessionRuntimeProfile(claude.session.id))
      .toMatchObject({ profile: claudeProfile, sourceKind: "session_start" });
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
      model: "gpt-5.6-sol",
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
      providerAccountKey: testProviderAccountKey("codex"),
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
    expect(store.transitionMutation(switchAttempt.id, "prepared", "effect_started")).toBe(true);
    const before = store.requireSession(started.id);
    const claudeProcessIdentity = {
      pid: 42_102,
      pidDomain: "darwin" as const,
      procStart: "Fri Sep  4 12:01:01 2026",
    };
    store.recordClaimedClaudeProcessAuthority({
      providerThreadId: "claude-thread",
      profileId: claudeAccount.id,
      profileGeneration: claudeAccount.processGeneration,
      runtimeScope: "managed",
      sessionId: started.id,
      identity: claudeProcessIdentity,
    });
    const switched = store.completeSessionProviderSwitch({
      attemptId: switchAttempt.id,
      expectedSessionRevision: before.revision,
      expectedTargetProfileGeneration: claudeAccount.processGeneration,
      preset: "fable-max",
      profileId: claudeAccount.id,
      provider: "claude",
      providerThreadId: "claude-thread",
      receipt: { providerThreadId: "claude-thread", sessionId: started.id, toProvider: "claude" },
      runtimeProfile: claudeProfile,
      providerAccountKey: testProviderAccountKey("claude"),
      claudeProcessIdentity,
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
      sourceKind: "session_start",
    });
    expect(store.readMutation("00000000-0000-4000-8000-0000000006b1")).toMatchObject({
      state: "applied",
    });

    // A stale revision never rebinds, and a preset the target cannot run is
    // refused before anything is written.
    const sourceProcess = store.readClaudeProcessAuthority({
      providerThreadId: "claude-thread",
      profileId: claudeAccount.id,
      runtimeScope: "managed",
    });
    if (sourceProcess === null) throw new Error("Expected the bound Claude process authority.");
    const releasingSource = store.beginClaudeProcessAuthorityRelease({
      providerThreadId: sourceProcess.providerThreadId,
      profileId: sourceProcess.profileId,
      runtimeScope: sourceProcess.runtimeScope,
      expectedRevision: sourceProcess.revision,
      identity: sourceProcess.identity,
    });
    store.completeClaudeProcessAuthorityRelease({
      providerThreadId: releasingSource.providerThreadId,
      profileId: releasingSource.profileId,
      runtimeScope: releasingSource.runtimeScope,
      expectedRevision: releasingSource.revision,
      identity: releasingSource.identity,
    });
    const replacementProcessIdentity = {
      pid: 42_103,
      pidDomain: "darwin" as const,
      procStart: "Fri Sep  4 12:01:02 2026",
    };
    store.recordClaimedClaudeProcessAuthority({
      providerThreadId: "claude-thread-2",
      profileId: claudeAccount.id,
      profileGeneration: claudeAccount.processGeneration,
      runtimeScope: "managed",
      sessionId: started.id,
      identity: replacementProcessIdentity,
    });
    expect(() => store.completeSessionProviderSwitch({
      attemptId: switchAttempt.id,
      expectedSessionRevision: before.revision,
      expectedTargetProfileGeneration: claudeAccount.processGeneration,
      preset: "fable-max",
      profileId: claudeAccount.id,
      provider: "claude",
      providerThreadId: "claude-thread-2",
      receipt: {},
      runtimeProfile: claudeProfile,
      providerAccountKey: testProviderAccountKey("claude"),
      claudeProcessIdentity: replacementProcessIdentity,
      sessionId: started.id,
      state: "idle",
    })).toThrow("SESSION_PROVIDER_SWITCH_CAS_CONFLICT");
    expect(() => store.completeSessionProviderSwitch({
      attemptId: switchAttempt.id,
      expectedSessionRevision: switched.revision,
      expectedTargetProfileGeneration: claudeAccount.processGeneration,
      preset: "high",
      profileId: claudeAccount.id,
      provider: "claude",
      providerThreadId: "claude-thread-2",
      receipt: {},
      runtimeProfile: claudeProfile,
      providerAccountKey: testProviderAccountKey("claude"),
      sessionId: started.id,
      state: "idle",
    })).toThrow("does not support the `high` model preset");
    expect(store.requireSession(started.id).providerThreadId).toBe("claude-thread");
  });

  test("rejects provider-switch completion after target authority changes without rebinding", async () => {
    for (const scenario of ["signed_out", "new_generation"] as const) {
      const { store } = await fixture();
      const sourceAccount = signInProfile(
        store,
        `Switch source ${scenario}`,
        `source-${scenario}@example.com`,
      );
      const targetAccount = signInProfile(
        store,
        `Switch target ${scenario}`,
        `target-${scenario}@example.com`,
      );
      const created = store.createSession({
        profileId: sourceAccount.id,
        provider: "codex",
        preset: "high",
        fastEnabled: false,
      });
      const session = store.bindSession({
        sessionId: created.id,
        expectedRevision: created.revision,
        providerThreadId: `source-thread-${scenario}`,
        state: "idle",
      });
      const idempotencyKey = scenario === "signed_out"
        ? "00000000-0000-4000-8000-0000000006b3"
        : "00000000-0000-4000-8000-0000000006b4";
      const attempt = store.prepareMutation({
        authorityGeneration: targetAccount.processGeneration,
        authorityId: session.id,
        idempotencyKey,
        kind: "session.switch",
        request: { preset: "fable-max", provider: "claude" },
      });
      expect(store.transitionMutation(attempt.id, "prepared", "effect_started")).toBe(true);
      const processIdentity = {
        pid: scenario === "signed_out" ? 42_104 : 42_105,
        pidDomain: "darwin" as const,
        procStart: scenario === "signed_out"
          ? "Fri Sep  4 12:01:03 2026"
          : "Fri Sep  4 12:01:04 2026",
      };
      const providerThreadId = `target-thread-${scenario}`;

      if (scenario === "signed_out") {
        expect(store.setProfileState(
          targetAccount.id,
          targetAccount.processGeneration,
          "signed_out",
        )).toBe(true);
        expect(store.requireProfileById(targetAccount.id)).toMatchObject({
          state: "signed_out",
          processGeneration: targetAccount.processGeneration,
        });
      } else {
        expect(store.advanceProfileGeneration(
          targetAccount.id,
          targetAccount.processGeneration,
        )).toMatchObject({
          state: "signed_in",
          processGeneration: targetAccount.processGeneration + 1,
        });
      }
      const beforeSession = store.requireSession(session.id);
      const beforeMutation = store.readMutation(idempotencyKey);
      expect(beforeMutation).toMatchObject({
        authorityGeneration: targetAccount.processGeneration,
        authorityId: session.id,
        state: "effect_started",
      });

      expect(() => store.completeSessionProviderSwitch({
        attemptId: attempt.id,
        expectedSessionRevision: session.revision,
        expectedTargetProfileGeneration: targetAccount.processGeneration,
        preset: "fable-max",
        profileId: targetAccount.id,
        provider: "claude",
        providerThreadId,
        receipt: { providerThreadId, sessionId: session.id, toProvider: "claude" },
        providerAccountKey: testProviderAccountKey("claude"),
        runtimeProfile: {
          claudeVersion: "2.1.260",
          inputFormat: "stream-json",
          isolatedConfigDir: true,
          model: "claude-fable-5-1",
          observedAt: 2_100,
          outputFormat: "stream-json",
          permissionMode: "default",
          preset: "fable-max",
          processGeneration: targetAccount.processGeneration,
          profileId: targetAccount.id,
          reasoningEffort: "max",
        },
        claudeProcessIdentity: processIdentity,
        sessionId: session.id,
        state: "idle",
      })).toThrow("SESSION_PROVIDER_SWITCH_TARGET_AUTHORITY_CHANGED");

      expect(store.requireSession(session.id)).toEqual(beforeSession);
      expect(store.readMutation(idempotencyKey)).toEqual(beforeMutation);
      expect(store.latestSessionRuntimeProfile(session.id)).toBeNull();
    }
  });

  test("retires personal runtime custody and readopts its old identity after a provider switch", async () => {
    const { store } = await fixture();
    const codexAccount = signInProfile(store, "Adopted Codex", "adopted-codex@example.com");
    const claudeAccount = signInProfile(store, "Adopted Claude", "adopted-claude@example.com");
    store.setSessionAdoptionPolicy({ provider: "codex", profileId: codexAccount.id });
    const candidate = store.upsertSessionAdoptionCandidate({
      provider: "codex",
      providerThreadId: "adopted-switch-thread",
      title: "Adopted switch",
      state: "idle",
      providerUpdatedAt: 10,
      liveness: "not_live",
    });
    const claimed = store.fenceSessionAdoptionCandidateForClaim({
      provider: "codex",
      providerThreadId: candidate.providerThreadId,
      expectedRevision: candidate.revision,
    });
    const adopted = store.adoptSessionCandidate({
      provider: "codex",
      providerThreadId: candidate.providerThreadId,
      expectedCandidateRevision: claimed.revision,
      profileId: codexAccount.id,
      profileGeneration: codexAccount.processGeneration,
      preset: "high",
      fastEnabled: false,
      runtimeProfile: codexAdoptionRuntimeProfile(codexAccount, "high", false),
      providerAccountKey: testProviderAccountKey("codex"),
    });

    const direct = new Database(store.paths.database, { create: false, strict: true });
    try {
      expect(() => direct.query(
        "UPDATE sessions SET provider_thread_id=? WHERE id=?",
      ).run("unfenced-thread", adopted.session.id))
        .toThrow("active personal runtime binding must be retired before session rebind");
    } finally {
      direct.close(false);
    }

    const switchAttempt = store.prepareMutation({
      authorityGeneration: claudeAccount.processGeneration,
      authorityId: adopted.session.id,
      idempotencyKey: "00000000-0000-4000-8000-0000000006b2",
      kind: "session.switch",
      request: { preset: "fable-max", provider: "claude" },
    });
    expect(store.transitionMutation(switchAttempt.id, "prepared", "effect_started")).toBe(true);
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
    const targetProcessIdentity = {
      pid: 42_002,
      pidDomain: "darwin" as const,
      procStart: "Fri Sep  4 12:00:01 2026",
    };
    store.recordClaimedClaudeProcessAuthority({
      providerThreadId: "claimed-claude-thread",
      profileId: claudeAccount.id,
      profileGeneration: claudeAccount.processGeneration,
      runtimeScope: "managed",
      sessionId: adopted.session.id,
      identity: targetProcessIdentity,
    });
    const switched = store.completeSessionProviderSwitch({
      attemptId: switchAttempt.id,
      expectedSessionRevision: adopted.session.revision,
      expectedTargetProfileGeneration: claudeAccount.processGeneration,
      preset: "fable-max",
      profileId: claudeAccount.id,
      provider: "claude",
      providerThreadId: "claimed-claude-thread",
      receipt: { providerThreadId: "claimed-claude-thread" },
      runtimeProfile: claudeProfile,
      providerAccountKey: testProviderAccountKey("claude"),
      claudeProcessIdentity: targetProcessIdentity,
      sessionId: adopted.session.id,
      state: "idle",
    });
    expect(switched).toMatchObject({
      profileId: claudeAccount.id,
      provider: "claude",
      providerThreadId: "claimed-claude-thread",
    });
    expect(store.readSessionPersonalRuntimeBinding(switched.id)).toBeNull();
    expect(store.readSessionPersonalRuntimeBinding(switched.id, true)).toMatchObject({
      provider: "codex",
      providerThreadId: "adopted-switch-thread",
      state: "detached",
    });
    expect(store.listLocalSessionPage({
      profileId: claudeAccount.id,
      after: null,
      limit: 1,
    })).toEqual({ sessions: [switched], nextPosition: null });
    expect(store.listSessionAdoptionCandidates({ provider: "codex" })[0]?.status)
      .toBe("fenced");

    const switchEvent = store.appendSessionEvent({
      sessionId: switched.id,
      accountId: claudeAccount.id,
      providerGeneration: claudeAccount.processGeneration,
      providerConnectionId: null,
      body: {
        type: "provider_switched",
        fromProvider: "codex",
        toProvider: "claude",
        fromPreset: "high",
        toPreset: "fable-max",
        accountChanged: true,
        transcriptDigest: "a".repeat(64),
        seedDigest: "b".repeat(64),
        seedOmittedRecords: 0,
      },
    });

    store.setSessionAdoptionPolicy({ provider: "codex", profileId: null });
    store.setSessionAdoptionPolicy({ provider: "codex", profileId: codexAccount.id });
    const pendingAgain = store.listSessionAdoptionCandidates({
      provider: "codex",
      status: "pending",
    })[0];
    if (pendingAgain === undefined) throw new Error("Expected the switched identity to be pending again.");
    const claimedAgain = store.fenceSessionAdoptionCandidateForClaim({
      provider: "codex",
      providerThreadId: pendingAgain.providerThreadId,
      expectedRevision: pendingAgain.revision,
    });
    const readopted = store.adoptSessionCandidate({
      provider: "codex",
      providerThreadId: pendingAgain.providerThreadId,
      expectedCandidateRevision: claimedAgain.revision,
      profileId: codexAccount.id,
      profileGeneration: codexAccount.processGeneration,
      preset: "ultra",
      fastEnabled: true,
      runtimeProfile: codexAdoptionRuntimeProfile(codexAccount, "ultra", true),
      providerAccountKey: testProviderAccountKey("codex"),
    });

    expect(readopted.session).toMatchObject({
      profileId: codexAccount.id,
      provider: "codex",
      providerThreadId: "adopted-switch-thread",
      preset: "ultra",
      fastEnabled: true,
    });
    expect(readopted.session.id).not.toBe(switched.id);
    expect(readopted.binding).toMatchObject({
      sessionId: readopted.session.id,
      provider: "codex",
      providerThreadId: "adopted-switch-thread",
      state: "active",
    });
    expect(store.requireSession(switched.id)).toMatchObject({
      profileId: claudeAccount.id,
      provider: "claude",
      providerThreadId: "claimed-claude-thread",
      preset: "fable-max",
    });
    expect(store.readSessionPersonalRuntimeBinding(switched.id, true)).toBeNull();
    expect(store.latestSessionRuntimeProfile(switched.id)).toMatchObject({
      sourceKind: "session_start",
      profile: claudeProfile,
    });
    expect(store.listSessionEvents({
      sessionId: switched.id,
      afterSequence: 0,
    }).events).toEqual([switchEvent]);
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
      providerAccountKey: testProviderAccountKey("claude"),
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
    const profile = signInProfile(store, "Queue graph", "queue-graph@example.com");
    const session = createProvenTestSession(store, {
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
    const profile = signInProfile(store, "Queue FIFO", "queue-fifo@example.com");
    const session = createProvenTestSession(store, {
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
      .toThrow("session account authority does not match the signed-in provider identity");
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
    const profile = signInProfile(store, "Bounded queue lookup", "bounded-queue@example.com");
    const session = createProvenTestSession(store, {
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
    const session = upsertProvenTestSession(store, {
      profileId: profile.id,
      preset: "high",
      fastEnabled: false,
      providerThreadId: "thread-queue-body-custody",
      state: "idle",
      providerUpdatedAt: 10,
    });
    const runtime = {
      profileId: profile.id,
      processGeneration: profile.processGeneration,
      observedAt: 2_000,
      preset: "high" as const,
      model: "gpt-5.6-sol",
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
      expectedEvidenceDigest: applied.evidence.digest,
      expectedSessionRevision: session.revision,
      applyResponseState: false,
      turnId: "turn-queue-body-custody",
      turnStatus: "completed",
      runtimeProfile: runtime,
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
    const session = upsertProvenTestSession(store, {
      profileId: profile.id,
      preset: "high",
      fastEnabled: false,
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
      model: "gpt-5.6-sol",
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
      expect(inspector.query("PRAGMA user_version").get()).toEqual({ user_version: 35 });
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
    const session = createProvenTestSession(store, {
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
    const session = createProvenTestSession(store, {
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
    const session = createProvenTestSession(store, {
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
    const session = createProvenTestSession(store, {
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
    const session = createProvenTestSession(store, {
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
      model: "gpt-5.6-sol",
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
      model: "gpt-5.6-sol",
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

    const sendSession = upsertProvenTestSession(store, {
      profileId: profile.id,
      preset: "high",
      fastEnabled: false,
      providerThreadId: "thread-send-cas",
      state: "idle",
      providerUpdatedAt: 10,
    });
    const sendKey = "00000000-0000-4000-8000-000000000711";
    const sendAttempt = store.prepareMutation({ kind: "session.send", authorityId: sendSession.id, authorityGeneration: profile.processGeneration, request: { message: "send" }, idempotencyKey: sendKey });
    store.beginSessionMutationEffect({
      attemptId: sendAttempt.id,
      sessionId: sendSession.id,
      profileGeneration: profile.processGeneration,
      evidence: {
        kind: "session.send",
        providerThreadId: "thread-send-cas",
        baseline: { providerUpdatedAt: 10, status: "idle", activeTurnId: null },
        clientMessageId: sendAttempt.id,
        messageDigest: "a".repeat(64),
        runtimeProfile: runtime,
      },
    });
    store.updateSessionMetadata({ sessionId: sendSession.id, expectedRevision: sendSession.revision, note: "concurrent" });
    expect(() => store.completeSessionTurnEffect({
      attemptId: sendAttempt.id,
      sessionId: sendSession.id,
      expectedSessionRevision: sendSession.revision,
      applyResponseState: true,
      turnId: "turn-send-cas",
      turnStatus: "inProgress",
      runtimeProfile: runtime,
      receipt: { turnId: "turn-send-cas" },
    })).toThrow("SESSION_TURN_STATE_CAS_CONFLICT");
    expect(store.readMutation(sendKey)).toMatchObject({ state: "effect_started" });
    expect(store.latestSessionRuntimeProfile(sendSession.id)).toBeNull();
    expect(store.requireSession(sendSession.id)).toMatchObject({ state: "idle", note: "concurrent" });

    const queueSession = upsertProvenTestSession(store, {
      profileId: profile.id,
      preset: "high",
      fastEnabled: false,
      providerThreadId: "thread-queue-cas",
      state: "idle",
      providerUpdatedAt: 10,
    });
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
      expectedEvidenceDigest: queueEvidence.digest,
      expectedSessionRevision: queueSession.revision,
      applyResponseState: true,
      turnId: "turn-queue-cas",
      turnStatus: "inProgress",
      runtimeProfile: runtime,
      receipt: { turnId: "turn-queue-cas" },
    })).toThrow("QUEUE_EFFECT_SESSION_CAS_CONFLICT");
    expect(store.requireQueue(queue.id)).toMatchObject({ state: "dispatching" });
    expect(store.latestSessionRuntimeProfile(queueSession.id)).toBeNull();
    expect(store.requireSession(queueSession.id)).toMatchObject({ state: "idle", fastEnabled: true });
  });

  test("reports whether any session is mid-turn as a cloud cadence hint", async () => {
    const { store } = await fixture();
    const profile = signInProfile(store, "Cadence authority", "cadence@example.com");
    expect(store.hasSessionWithActiveTurn()).toBe(false);
    const bound = upsertProvenTestSession(store, {
      profileId: profile.id,
      preset: "high",
      fastEnabled: false,
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
    const session = upsertProvenTestSession(store, {
      profileId: profile.id,
      preset: "high",
      fastEnabled: false,
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
    const session = upsertProvenTestSession(store, {
      profileId: profile.id,
      title: "Legacy public projection",
      preset: "high",
      fastEnabled: false,
      providerThreadId: "thread-legacy-public-projection",
      state: "active",
      activeTurnId: `${privateUserPathRoot}/api_key=LEGACY-TURN-SECRET-1234`,
    });
    const rawTurnId = `${privateUserPathRoot}/api_key=LEGACY-TURN-SECRET-1234`;
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
    const session = upsertProvenTestSession(store, {
      profileId: profile.id,
      title: `Observed api_key=TITLE-SECRET-1234 ${privateUserPathRoot}/work`,
      preset: "high",
      fastEnabled: false,
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
    const privateTurnSession = upsertProvenTestSession(store, {
      profileId: profile.id,
      title: "Private provider identifier",
      preset: "high",
      fastEnabled: false,
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
    const longTurnSession = upsertProvenTestSession(store, {
      profileId: profile.id,
      title: "Long provider identifier",
      preset: "high",
      fastEnabled: false,
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

    const session = createProvenTestSession(store, {
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
      sessions: { idle: 1 },
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
    const session = createProvenTestSession(store, {
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
    const session = upsertProvenTestSession(store, {
      profileId: profile.id,
      preset: "high",
      fastEnabled: false,
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
    const session = createProvenTestSession(store, {
      profileId: profile.id,
      preset: "high",
      fastEnabled: false,
      providerThreadId: "thread-rollback-retirement",
    });
    const otherSession = createProvenTestSession(store, {
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
    const session = createProvenTestSession(store, {
      profileId: profile.id,
      preset: "high",
      fastEnabled: false,
      providerThreadId: "thread-interaction",
    });
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
    const session = createProvenTestSession(store, {
      profileId: profile.id,
      preset: "high",
      fastEnabled: false,
      providerThreadId: "thread-interaction-page",
    });
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
    const session = createProvenTestSession(store, {
      profileId: profile.id,
      preset: "high",
      fastEnabled: false,
      providerThreadId: "thread-deadline",
    });
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
    const session = createProvenTestSession(store, {
      profileId: profile.id,
      preset: "high",
      fastEnabled: false,
      providerThreadId: "thread-interaction-page",
    });
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

  test("anchors immutable interaction deadlines and terminal intent across delayed admission", async () => {
    const home = await realpath(await mkdtemp(join(tmpdir(), "hra-store-deadline-")));
    const paths = resolveStatePaths({ homeDirectory: home, platform: "darwin" });
    await initializeStatePaths(paths);
    let now = 10_000;
    const store = new StateStore(paths, { now: () => now });
    stores.push(store);
    const profile = signInProfile(store, "Deadline", "deadline@example.com");
    const session = createProvenTestSession(store, {
      profileId: profile.id,
      preset: "high",
      fastEnabled: false,
      providerThreadId: "thread-deadline",
    });
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
    const session = createProvenTestSession(store, {
      profileId: profile.id,
      preset: "high",
      fastEnabled: false,
      providerThreadId: "thread-timeout-cas",
    });
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
      const session = createProvenTestSession(store, {
        profileId: profile.id,
        preset: "high",
        fastEnabled: false,
        providerThreadId: "thread-persistence-quarantine",
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
    const session = createProvenTestSession(store, {
      profileId: profile.id,
      preset: "high",
      fastEnabled: false,
      providerThreadId: "thread-persistence-rollback",
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
      expect(inspector.query("PRAGMA user_version").get()).toEqual({ user_version: 35 });
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
    const session = createProvenTestSession(store, {
      profileId: profile.id,
      preset: "high",
      fastEnabled: false,
      providerThreadId: "thread-readonly",
    });
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
      expect(inspector.query("PRAGMA user_version").get()).toEqual({ user_version: 35 });
      expect(inspector.query("SELECT version FROM migrations ORDER BY version").all()).toEqual([{ version: 1 }, { version: 2 }, { version: 3 }, { version: 4 }, { version: 5 }, { version: 6 }, { version: 7 }, { version: 8 }, { version: 9 }, { version: 10 }, { version: 11 }, { version: 12 }, { version: 13 }, { version: 14 }, { version: 15 }, { version: 16 }, { version: 17 }, { version: 18 }, { version: 19 }, { version: 20 }, { version: 21 }, { version: 22 }, { version: 23 }, { version: 24 }, { version: 25 }, { version: 26 }, { version: 27 }, { version: 28 }, { version: 29 }, { version: 30 }, { version: 31 }, { version: 32 }, { version: 33 }, { version: 34 }, { version: 35 }]);
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
      expect(inspector.query("PRAGMA table_info(session_adoption_policies)").all())
        .toContainEqual(expect.objectContaining({ name: "provider", type: "TEXT", pk: 1 }));
      const adoptionCandidateColumns = inspector
        .query("PRAGMA table_info(session_adoption_candidates)").all();
      expect(adoptionCandidateColumns)
        .toContainEqual(expect.objectContaining({ name: "liveness", type: "TEXT", notnull: 1 }));
      for (const name of ["source_pid", "source_pid_domain", "source_proc_start"]) {
        expect(adoptionCandidateColumns)
          .toContainEqual(expect.objectContaining({ name, notnull: 0 }));
      }
      expect(inspector.query(
        "SELECT name FROM sqlite_master WHERE type='index' AND name='session_adoption_candidates_claude_reprobe'",
      ).get()).toEqual({ name: "session_adoption_candidates_claude_reprobe" });
      expect(inspector.query("PRAGMA table_info(session_personal_runtime_bindings)").all())
        .toContainEqual(expect.objectContaining({ name: "session_id", type: "TEXT", pk: 1 }));
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
      expect(inspector.query("PRAGMA user_version").get()).toEqual({ user_version: 35 });
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
    const session = createProvenTestSession(store, {
      profileId: profile.id,
      preset: "high",
      fastEnabled: false,
      providerThreadId: "thread-legacy-approvals",
    });
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
      expect(inspector.query("PRAGMA user_version").get()).toEqual({ user_version: 35 });
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
    const session = createProvenTestSession(store, {
      profileId: profile.id,
      title: "Legacy URL session",
      preset: "high",
      fastEnabled: false,
      providerThreadId: "legacy-thread",
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
      expect(inspector.query("PRAGMA user_version").get()).toEqual({ user_version: 35 });
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
    const session = createProvenTestSession(store, {
      profileId: profile.id,
      title: "Legacy permission session",
      preset: "high",
      fastEnabled: false,
      providerThreadId: "legacy-permission-thread",
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
      expect(inspector.query("PRAGMA user_version").get()).toEqual({ user_version: 35 });
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
      const session = createProvenTestSession(store, {
        profileId: profile.id,
        title: `Physical v${targetVersion} session`,
        preset: "high",
        fastEnabled: false,
        providerThreadId: `legacy-physical-thread-${targetVersion}`,
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
        expect(inspector.query("PRAGMA user_version").get()).toEqual({ user_version: 35 });
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
    const session = createProvenTestSession(store, {
      profileId: profile.id,
      title: "Pinned legacy URL session",
      preset: "high",
      fastEnabled: false,
      providerThreadId: "legacy-thread",
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
        expect(inspector.query("PRAGMA user_version").get()).toEqual({ user_version: 35 });
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
      revision: 2,
      state: "recovery_required",
    });
    expect("providerUpdatedAt" in preserved).toBe(false);
    const inspector = new Database(paths.database, { readonly: true, strict: true });
    try {
      expect(inspector.query("PRAGMA user_version").get()).toEqual({ user_version: 35 });
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
      expect(inspector.query("PRAGMA user_version").get()).toEqual({ user_version: 35 });
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

  test("rejects databases written by a newer schema version", async () => {
    const home = await realpath(await mkdtemp(join(tmpdir(), "hra-store-newer-")));
    const paths = resolveStatePaths({ homeDirectory: home, platform: "darwin" });
    await initializeStatePaths(paths);
    const newer = new Database(paths.database, { create: true, strict: true });
    newer.exec("PRAGMA user_version = 36");
    newer.close(false);
    await chmod(paths.database, 0o600);
    expect(() => new StateStore(paths)).toThrow("STATE_SCHEMA_NEWER:36:35");
  });
});
