import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { effectiveClaudeRuntimeProfileSchema } from "../domain/runtime-profile";
import { initializeStatePaths, resolveStatePaths } from "./paths";
import { StateStore } from "./state-store";

const stores: StateStore[] = [];
const databases: Database[] = [];
const directories: string[] = [];
afterEach(async () => {
  for (const database of databases.splice(0)) database.close(false);
  for (const store of stores.splice(0)) store.close();
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const quote = (value: string) => `"${value.replaceAll('"', '""')}"`;

// Real public StateStore APIs capture a Claude queue while both providers are
// at generation one. Advancing only Codex then makes the prior scalar-profile
// lookup observably wrong. No provider process or network call is performed.
async function fixture() {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "hra-queue-provider-generation-")));
  directories.push(directory);
  const paths = resolveStatePaths({ homeDirectory: directory, platform: "darwin" });
  await initializeStatePaths(paths);
  let now = 1_800_000_000_000;
  const store = new StateStore(paths, { now: () => now++, resolveMachineTimeZone: () => "UTC" });
  stores.push(store);
  store.nextDaemonGeneration(`boot_${randomUUID().replaceAll("-", "")}`);
  const profile = store.nextProfileGeneration(store.createProfile("Queue provider generation").id);
  expect(store.setProfileState(profile.id, profile.processGeneration, "signed_in", {
    email: "queue-generation@example.com", plan: "Plus",
  })).toBe(true);
  const initialClaude = store.requireProviderAccountAuthority(profile.id, "claude");
  const advancedClaude = store.advanceProviderAccountProcessGeneration({ profileId: profile.id, provider: "claude",
    expectedProcessGeneration: initialClaude.processGeneration });
  store.observeProviderAccountReadiness({ profileId: profile.id, provider: "claude",
    expectedBindingGeneration: advancedClaude.bindingGeneration, readiness: "signed_in" });
  // Readiness admission may advance the binding independently of the process.
  // Capture the exact resulting tuple before preparing any session or queue.
  const authority = store.requireProviderAccountAuthority(profile.id, "claude");
  expect(authority.processGeneration).toBe(1);
  expect(authority.processGeneration).toBe(profile.processGeneration);
  const session = store.upsertProviderSession({ profileId: profile.id, provider: "claude", providerAuthority: authority,
    providerAccountKey: `v1:claude:${hash("synthetic Claude account")}`, providerThreadId: "queue-claude-thread",
    title: "Claude queue survives sibling restart", preset: "fable-max", fastEnabled: false,
    state: "idle", providerUpdatedAt: 10 });
  const requirement = store.requireSessionPresetRequirement(session.id).requirement;
  const runtime = effectiveClaudeRuntimeProfileSchema.parse({ profileId: profile.id,
    processGeneration: authority.processGeneration, observedAt: now, preset: "fable-max",
    model: requirement.model, reasoningEffort: requirement.effort, claudeVersion: "2.1.260",
    permissionMode: "default", configHome: "isolated", outputFormat: "stream-json", inputFormat: "stream-json",
    nativeFallback: { model: "claude-opus-5", reason: "live_acceptance_required", status: "unavailable" } });
  const message = "Complete under the captured Claude authority.";
  const providerConnectionId = randomUUID();
  const queue = store.enqueueIdempotent({ sessionId: session.id, profileGeneration: authority.processGeneration,
    providerAuthority: authority, message, idempotencyKey: randomUUID(), providerConnectionId });
  const evidence = store.beginQueueEffect({ queueId: queue.id, sessionId: session.id,
    profileGeneration: authority.processGeneration, providerAuthority: authority, providerConnectionId,
    evidence: { kind: "queue.dispatch", queueId: queue.id, sessionId: session.id,
      providerThreadId: "queue-claude-thread", profileGeneration: authority.processGeneration,
      baseline: { providerUpdatedAt: 10, status: "idle", activeTurnId: null }, clientMessageId: queue.id,
      messageDigest: hash(message), runtimeProfile: runtime } });
  const database = new Database(paths.database, { readonly: true, strict: true });
  databases.push(database);
  const complete = () => store.completeQueueEffect({ queueId: queue.id, accountId: profile.id,
    providerGeneration: authority.processGeneration, providerConnectionId, providerAuthority: authority,
    expectedEvidenceDigest: evidence.digest, expectedSessionRevision: session.revision, applyResponseState: true,
    turnId: "queue-claude-turn", turnStatus: "completed", runtimeProfile: runtime,
    message, receipt: { turnId: "queue-claude-turn" } });
  const snapshot = () => {
    const names = database.query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all();
    return { schema: database.query("SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name").all(),
      rows: names.map(({ name }) => ({ name, rows: database.query(`SELECT * FROM ${quote(name)} ORDER BY rowid`).all() })) };
  };
  const immutableQueueProof = () => ({
    evidence: database.query("SELECT * FROM queue_effect_evidence WHERE queue_id=?").get(queue.id),
    provenance: database.query("SELECT * FROM queue_effect_evidence_provenance WHERE queue_id=?").get(queue.id),
    anchor: database.query("SELECT * FROM queue_effect_evidence_provenance_anchors WHERE queue_id=?").get(queue.id),
    authority: database.query("SELECT * FROM queue_provider_authorities WHERE queue_id=?").get(queue.id),
    identity: database.query("SELECT * FROM queue_attachment_identities WHERE queue_id=?").get(queue.id),
    identityAnchor: database.query("SELECT * FROM queue_attachment_identity_anchors WHERE queue_id=?").get(queue.id),
  });
  return { store, database, profile, authority, session, queue, runtime, message, complete, snapshot, immutableQueueProof };
}

describe("queue completion uses the captured provider generation", () => {
  test.each([false, true])("Claude completion retains its exact tuple after sibling Codex restart: %s", async (restartCodex) => {
    const f = await fixture();
    const originalProof = f.immutableQueueProof();
    const originalSession = f.store.requireSession(f.session.id);
    const captured = f.store.requireCapturedSessionProviderAuthority(f.session.id);
    if (restartCodex) {
      const codex = f.store.requireProviderAccountAuthority(f.profile.id, "codex");
      const advanced = f.store.advanceProviderAccountProcessGeneration({ profileId: f.profile.id,
        provider: "codex", expectedProcessGeneration: codex.processGeneration });
      expect(advanced.processGeneration).toBe(codex.processGeneration + 1);
      expect(f.store.requireProfile(f.profile.id).processGeneration).toBe(advanced.processGeneration);
      expect(advanced.processGeneration).not.toBe(f.authority.processGeneration);
    }
    expect(f.store.requireProviderAccountAuthority(f.profile.id, "claude")).toEqual(f.authority);
    expect(f.store.requireCapturedSessionProviderAuthority(f.session.id)).toEqual(captured);
    expect(f.store.requireSession(f.session.id)).toEqual(originalSession);
    expect(f.immutableQueueProof()).toEqual(originalProof);
    const codexBeforeCompletion = f.store.requireProviderAccountAuthority(f.profile.id, "codex");
    const result = f.complete();
    expect(result).toMatchObject({ appended: true, event: { accountId: f.profile.id,
      providerGeneration: f.authority.processGeneration, body: { type: "user_message", actor: "human",
        sourceId: f.queue.id, text: f.message } } });
    expect(f.store.requireQueue(f.queue.id).state).toBe("applied");
    expect(f.store.requireSession(f.session.id)).toMatchObject({ state: "idle", revision: originalSession.revision + 1 });
    expect(f.store.requireProviderAccountAuthority(f.profile.id, "codex")).toEqual(codexBeforeCompletion);
    expect(f.store.requireProviderAccountAuthority(f.profile.id, "claude")).toEqual(f.authority);
    expect(f.store.requireCapturedSessionProviderAuthority(f.session.id)).toEqual(captured);
    expect(f.store.latestSessionRuntimeProfile(f.session.id)?.profile).toEqual(f.runtime);
    expect(f.immutableQueueProof()).toEqual(originalProof);
    const event = result.event;
    expect(f.database.query("SELECT provider_account_id,profile_id,provider,binding_generation,process_generation,provenance FROM session_event_provider_authorities WHERE session_id=? AND sequence=?")
      .get(f.session.id, event.sequence)).toEqual({ provider_account_id: f.authority.providerAccountId,
        profile_id: f.profile.id, provider: "claude", binding_generation: f.authority.bindingGeneration,
        process_generation: f.authority.processGeneration, provenance: "session_event" });
  });

  test("a changed Claude process still refuses completion without rewriting the original queue", async () => {
    const f = await fixture();
    const originalProof = f.immutableQueueProof();
    const advanced = f.store.advanceProviderAccountProcessGeneration({ profileId: f.profile.id, provider: "claude",
      expectedProcessGeneration: f.authority.processGeneration });
    expect(advanced.processGeneration).toBe(f.authority.processGeneration + 1);
    expect(f.store.requireCapturedSessionProviderAuthority(f.session.id).processGeneration).toBe(f.authority.processGeneration);
    const before = f.snapshot();
    expect(f.complete).toThrow("PROVIDER_ACCOUNT_AUTHORITY_STALE");
    expect(f.snapshot()).toEqual(before);
    expect(f.immutableQueueProof()).toEqual(originalProof);
    expect(f.store.requireQueue(f.queue.id).state).toBe("dispatching");
    expect(f.store.latestSessionRuntimeProfile(f.session.id)).toBeNull();
  });
});
