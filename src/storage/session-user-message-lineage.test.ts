import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fc from "fast-check";

import { effectiveRuntimeProfileSchema } from "../domain/runtime-profile";
import { initializeStatePaths, resolveStatePaths } from "./paths";
import { StateStore } from "./state-store";

const roots: string[] = [];
const stores: StateStore[] = [];
type LineageResources = { roots: string[]; stores: Array<Pick<StateStore, "close">> };
const ownedLineageTeardowns: Array<() => Promise<void>> = [];
afterEach(async () => {
  const teardowns = ownedLineageTeardowns.splice(0);
  for (const store of stores.splice(0)) store.close();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
  // These owners have private resource lists; a timed-out drain cannot take
  // resources from a later test's shared fixture cleanup.
  const results = await Promise.allSettled(teardowns.map(async (teardown) => await teardown()));
  const failures = results.flatMap((result): unknown[] => result.status === "rejected" ? [result.reason] : []);
  if (failures.length > 0) throw new AggregateError(failures, "Lineage case teardown failed.");
});

function ownedLineageCase(
  runCase: (resources: LineageResources, signal: AbortSignal) => Promise<void>,
  teardowns = ownedLineageTeardowns,
): Promise<void> {
  const resources: LineageResources = { roots: [], stores: [] };
  const controller = new AbortController();
  const cancellation = new Error("Owned lineage case is closing.");
  const task = Promise.resolve().then(async () => {
    controller.signal.throwIfAborted();
    await runCase(resources, controller.signal);
    controller.signal.throwIfAborted();
  });
  const settled = task.then(
    () => ({ status: "fulfilled" } as const),
    (reason: unknown) => ({ status: "rejected", reason } as const),
  );
  teardowns.push(async () => {
    controller.abort(cancellation);
    const result = await settled;
    const failures: unknown[] = result.status === "rejected" && result.reason !== cancellation ? [result.reason] : [];
    let storeCloseFailed = false;
    for (const store of resources.stores.splice(0)) {
      try { store.close(); } catch (error: unknown) {
        storeCloseFailed = true;
        failures.push(error);
      }
    }
    if (storeCloseFailed) throw new AggregateError(failures, "Lineage store close failed; owned roots were retained.");
    for (const root of resources.roots.splice(0)) {
      try { await rm(root, { recursive: true, force: true }); } catch (error: unknown) { failures.push(error); }
    }
    if (failures.length > 0) throw new AggregateError(failures, "Owned lineage teardown failed.");
  });
  return task;
}

describe("owned lineage case lifecycle", () => {
  test("registers before deferred setup and cancels before resources open", async () => {
    const teardowns: Array<() => Promise<void>> = [];
    let opened = false;
    const task = ownedLineageCase(async () => { opened = true; }, teardowns);
    expect(teardowns).toHaveLength(1);
    await teardowns[0]?.();
    await expect(task).rejects.toThrow("Owned lineage case is closing.");
    expect(opened).toBe(false);
  });

  test("joins late setup work and retains its failure before attempting every close", async () => {
    const teardowns: Array<() => Promise<void>> = [];
    const entered = Promise.withResolvers<undefined>();
    const release = Promise.withResolvers<undefined>();
    const lateFailure = new Error("late lineage setup failure");
    const closeFailure = new Error("first store close failure");
    const events: string[] = [];
    const task = ownedLineageCase(async (resources) => {
      resources.stores.push({ close: () => { events.push("close-first"); throw closeFailure; } });
      entered.resolve(undefined);
      await release.promise;
      resources.stores.push({ close: () => { events.push("close-late"); } });
      events.push("raw-failed");
      throw lateFailure;
    }, teardowns);
    await entered.promise;
    const closing = teardowns[0]?.().catch((error: unknown) => error);
    await Promise.resolve();
    expect(events).toEqual([]);
    release.resolve(undefined);
    const error = await closing;
    expect(error).toBeInstanceOf(AggregateError);
    if (!(error instanceof AggregateError)) throw new Error("Expected late setup and close failures.");
    expect(error.errors).toEqual([lateFailure, closeFailure]);
    await expect(task).rejects.toBe(lateFailure);
    expect(events).toEqual(["raw-failed", "close-first", "close-late"]);
  });
});

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
const quote = (value: string) => `"${value.replaceAll('"', '""')}"`;
type SourceKind = "send" | "steer" | "queue";

function snapshot(path: string) {
  const db = new Database(path, { readonly: true, strict: true });
  try {
    const names = db.query<{ name: string }, []>(
      "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
    ).all();
    return {
      schema: db.query("SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name").all(),
      tables: names.map(({ name }) => ({ name, rows: db.query(`SELECT * FROM ${quote(name)}`).all() })),
    };
  } finally { db.close(false); }
}

// The StateStore owns a different connection: commit exact fixture corruption
// with every original trigger restored before asking the real API to read it.
function corrupt(path: string, table: string, change: (db: Database) => void) {
  const db = new Database(path, { strict: true });
  try {
    const schema = db.query("SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name").all();
    const triggers = db.query<{ name: string; sql: string }, [string]>(
      "SELECT name,sql FROM sqlite_master WHERE type='trigger' AND tbl_name=? ORDER BY name",
    ).all(table);
    db.transaction(() => {
      for (const trigger of triggers) db.exec(`DROP TRIGGER ${quote(trigger.name)}`);
      change(db);
      for (const trigger of triggers) db.exec(trigger.sql);
    }).immediate();
    expect(db.query("SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name").all()).toEqual(schema);
  } finally { db.close(false); }
}

async function fixture(kind: SourceKind, restarts = 1, resources: LineageResources = { roots, stores }) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "oompa-message-lineage-")));
  resources.roots.push(root);
  const paths = resolveStatePaths({ homeDirectory: root, platform: "darwin" });
  await initializeStatePaths(paths);
  let now = 1_800_000_000_000;
  const store = new StateStore(paths, { now: () => now, resolveMachineTimeZone: () => "UTC" });
  resources.stores.push(store);
  const bootId = `boot_${randomUUID().replaceAll("-", "")}`;
  const daemonGeneration = store.nextDaemonGeneration(bootId);
  const profile = store.nextProfileGeneration(store.createProfile("Message lineage").id);
  const email = "message-lineage@example.com";
  expect(store.setProfileState(profile.id, profile.processGeneration, "signed_in", { email, plan: "Plus" })).toBe(true);
  const authority = store.requireProviderAccountAuthority(profile.id, "codex");
  const threadId = `thread-${kind}`;
  const turnId = `turn-${kind}`;
  const imported = store.upsertProviderSession({
    providerAuthority: authority, profileId: profile.id, provider: "codex",
    providerAccountKey: `v1:codex:${sha256(email)}`, providerThreadId: threadId,
    title: "Message lineage", preset: "high", fastEnabled: false,
    state: kind === "steer" ? "active" : "idle",
    ...(kind === "steer" ? { activeTurnId: turnId } : {}), providerUpdatedAt: 10,
  });
  const session = store.updateSessionMetadata({ sessionId: imported.id, expectedRevision: imported.revision, preset: "high" });
  const requirement = store.requireSessionPresetRequirement(session.id).requirement;
  const runtime = effectiveRuntimeProfileSchema.parse({
    profileId: profile.id, processGeneration: authority.processGeneration, observedAt: now,
    preset: "high", model: requirement.model, reasoningEffort: requirement.effort,
    serviceTier: null, fast: false, approvalPolicy: "on-request", reviewMode: "auto_review",
    permissionProfile: ":workspace", computerUse: true, pluginCapability: true, enabledApps: [],
  });
  const message = `A retained ${kind} message.`;
  const key = randomUUID();
  const provider = { providerThreadId: threadId, title: "Recovered message", status: "active" as const,
    activeTurnId: turnId, providerUpdatedAt: 20 };
  let sourceId: string;
  let recover: () => ReturnType<StateStore["resolveSessionMutation"]>;
  if (kind === "queue") {
    const queue = store.enqueueIdempotent({ sessionId: session.id, profileGeneration: authority.processGeneration,
      providerAuthority: authority, message, idempotencyKey: key });
    sourceId = queue.id;
    const effect = store.beginQueueEffect({ queueId: queue.id, sessionId: session.id,
      profileGeneration: authority.processGeneration, providerAuthority: authority,
      providerConnectionId: randomUUID(), evidence: { kind: "queue.dispatch", queueId: queue.id,
        sessionId: session.id, providerThreadId: threadId, profileGeneration: authority.processGeneration,
        baseline: { providerUpdatedAt: 10, status: "idle", activeTurnId: null },
        clientMessageId: queue.id, messageDigest: sha256(message), runtimeProfile: runtime } });
    store.markQueueEffectAmbiguous(queue.id, effect.digest);
    recover = () => store.resolveQueueEffect({ queueId: queue.id, expectedEvidenceDigest: effect.digest,
      resolution: "proven_applied", resolutionEvidence: { source: "synthetic_exact_projection" },
      receipt: { turnId, sourceId: queue.id }, provider });
  } else {
    const { attempt } = store.prepareSessionInputMutation({ kind: `session.${kind}`, sessionId: session.id,
      providerAuthority: authority, message, attachments: [], idempotencyKey: key, daemonGeneration, bootId });
    sourceId = attempt.id;
    const common = { providerThreadId: threadId,
      baseline: { providerUpdatedAt: 10, status: kind === "steer" ? "active" as const : "idle" as const,
        activeTurnId: kind === "steer" ? turnId : null },
      clientMessageId: attempt.id, messageDigest: sha256(message), messageActor: "human" as const };
    const effect = store.beginSessionMutationEffect({ attemptId: attempt.id, sessionId: session.id,
      profileGeneration: authority.processGeneration, providerAuthority: authority, message, attachments: [],
      daemonGeneration, bootId,
      transcript: { accountId: profile.id, providerGeneration: authority.processGeneration,
        providerConnectionId: randomUUID(), actor: "human", message },
      evidence: kind === "send" ? { ...common, kind: "session.send", runtimeProfile: runtime }
        : { ...common, kind: "session.steer", activeTurnId: turnId } });
    expect(store.transitionMutation(attempt.id, "effect_started", "ambiguous", { code: "synthetic_response_loss" })).toBe(true);
    store.quarantineSession(session.id);
    recover = () => store.resolveSessionMutation({ attemptId: attempt.id, expectedOriginalState: "ambiguous",
      expectedEvidenceDigest: effect.digest, resolution: "proven_applied",
      resolutionEvidence: { source: "synthetic_exact_projection" },
      receipt: kind === "send" ? { turnId } : { steered: true, activeTurnId: turnId }, message, provider });
  }
  for (let index = 0; index < restarts; index += 1) {
    now += 1;
    store.nextDaemonGeneration(`boot_${randomUUID().replaceAll("-", "")}`);
  }
  return { store, paths, session, profile, authority, threadId, turnId, sourceId, key, kind, recover };
}

describe("settled user-message original authority across process lineage", () => {
  for (const kind of ["send", "steer", "queue"] as const) {
    test(`${kind} recovery projects the original tuple once after two genuine restarts`, async () => {
      const value = await fixture(kind, 2);
      const current = value.store.requireSessionProviderAuthority(value.session.id);
      expect(current.processGeneration).toBe(value.authority.processGeneration + 2);
      const beforeLiveRefusal = snapshot(value.paths.database);
      expect(() => value.store.appendSessionEvent({ sessionId: value.session.id,
        accountId: value.authority.profileId, providerGeneration: value.authority.processGeneration,
        providerAuthority: value.authority, providerConnectionId: null,
        body: { type: "turn_started", turnId: value.turnId } })).toThrow();
      expect(snapshot(value.paths.database)).toEqual(beforeLiveRefusal);
      const result = value.recover();
      expect(result.messageEvent).toMatchObject({ appended: true, event: {
        accountId: value.authority.profileId, providerGeneration: value.authority.processGeneration,
        body: { type: "user_message", actor: "human", text: `A retained ${kind} message.` },
      } });
      const event = result.messageEvent?.event;
      if (event === undefined) throw new Error("Expected the recovered event.");
      const db = new Database(value.paths.database, { readonly: true, strict: true });
      try {
        expect(db.query("SELECT provider_account_id,profile_id,provider,binding_generation,process_generation,provenance FROM session_event_provider_authorities WHERE session_id=? AND sequence=?")
          .get(value.session.id, event.sequence)).toEqual({ provider_account_id: value.authority.providerAccountId,
            profile_id: value.authority.profileId, provider: "codex", binding_generation: value.authority.bindingGeneration,
            process_generation: value.authority.processGeneration, provenance: "settled_source" });
      } finally { db.close(false); }
      expect(value.store.requireSessionProviderAuthority(value.session.id)).toEqual(current);
      const beforeReplay = snapshot(value.paths.database);
      expect(value.store.finalizeSessionUserMessageSource({ sessionId: value.session.id,
        sourceKind: kind === "queue" ? "queue" : "mutation",
        sourceId: kind === "queue" ? value.sourceId : value.key, turnId: value.turnId })).toBeNull();
      expect(snapshot(value.paths.database)).toEqual(beforeReplay);
    });
  }

  for (const scenario of ["source thread", "wrong binding", "switched lineage", "missing middle edge"] as const) {
    test(`refuses ${scenario} without committing recovery or transcript changes`, async () => {
      const value = await fixture("send", 3);
      if (scenario === "source thread") corrupt(value.paths.database, "sessions", (db) => {
        expect(db.query("UPDATE sessions SET provider_thread_id=? WHERE id=?")
          .run("a-different-native-thread", value.session.id).changes).toBe(1);
      });
      else if (scenario === "wrong binding") corrupt(value.paths.database, "session_provider_authorities", (db) => {
        expect(db.query("UPDATE session_provider_authorities SET binding_generation=binding_generation+1 WHERE session_id=?")
          .run(value.session.id).changes).toBe(1);
      });
      else corrupt(value.paths.database, "session_provider_authority_successors", (db) => {
        const middle = db.query<{ revision: number }, [string]>(
          "SELECT from_authority_revision AS revision FROM session_provider_authority_successors WHERE session_id=? ORDER BY from_authority_revision LIMIT 1 OFFSET 1",
        ).get(value.session.id);
        if (middle === null) throw new Error("Expected the retained middle edge.");
        expect((scenario === "switched lineage"
          ? db.query("UPDATE session_provider_authority_successors SET transition_kind='session_switch' WHERE session_id=? AND from_authority_revision=?")
          : db.query("DELETE FROM session_provider_authority_successors WHERE session_id=? AND from_authority_revision=?"))
          .run(value.session.id, middle.revision).changes).toBe(1);
      });
      const before = snapshot(value.paths.database);
      expect(value.recover).toThrow();
      expect(snapshot(value.paths.database)).toEqual(before);
    });
  }

  test("missing queue evidence is not promoted to historical source authority", async () => {
    const value = await fixture("queue", 0);
    // Finish the fixture's independently proved queue first. Its ambiguous
    // setup deliberately fences the session against accepting another item.
    value.recover();
    expect(value.store.requireSession(value.session.id).state).not.toBe("recovery_required");
    // A new unrelated queued item never had dispatch evidence. Merely moving
    // its old-compatible state fields to applied must not make it a source.
    const queue = value.store.enqueueIdempotent({ sessionId: value.session.id,
      profileGeneration: value.authority.processGeneration, providerAuthority: value.authority,
      message: "No dispatch proof", idempotencyKey: randomUUID() });
    expect(value.store.transitionQueue(queue.id, "pending", "dispatching")).toBe(true);
    expect(value.store.transitionQueue(queue.id, "dispatching", "applied")).toBe(true);
    const before = snapshot(value.paths.database);
    expect(() => value.store.finalizeSessionUserMessageSource({ sessionId: value.session.id,
      sourceKind: "queue", sourceId: queue.id, turnId: "unproved-turn" })).toThrow();
    expect(snapshot(value.paths.database)).toEqual(before);
  });

  // Preserve the exact eight generated inputs from the former asyncProperty:
  // 2, 4, 2, 1, 2, 1, 2, 2. Each fresh real-schema fixture has its own deadline.
  test.each(fc.sample(fc.integer({ min: 1, max: 4 }), { seed: 20_260_910, numRuns: 8 })
    .map((count, index) => ({ count, sample: index + 1 })))(
    "seeded small restart counts preserve original tuples rather than synthesizing new writers (sample $sample, restarts $count)",
    ({ count }) => ownedLineageCase(async (resources, signal) => {
      const value = await fixture("steer", count, resources);
      signal.throwIfAborted();
      const current = value.store.requireSessionProviderAuthority(value.session.id);
      const result = value.recover();
      expect(result.messageEvent?.event.providerGeneration).toBe(value.authority.processGeneration);
      expect(current.processGeneration).toBe(value.authority.processGeneration + count);
      expect(value.store.requireSessionProviderAuthority(value.session.id)).toEqual(current);
    }),
  );
});
