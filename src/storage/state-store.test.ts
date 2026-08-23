import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, symlink } from "node:fs/promises";
import { join } from "node:path";

import { Database } from "bun:sqlite";

import { deriveDesktopProfilePaths } from "../desktop/profile";
import { SESSION_EVENT_RETAIN_AGE_MS } from "../domain/session-events";
import { canTransitionQueue, queueStateSchema, type QueueState } from "../domain/transitions";
import { initializeProfilePaths, initializeStatePaths, resolveStatePaths } from "./paths";
import { SelectionError, StateStore } from "./state-store";

const stores: StateStore[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});

async function fixture(): Promise<{ store: StateStore; home: string }> {
  const home = await mkdtemp(join("/private/tmp", "hra-store-"));
  const paths = resolveStatePaths({ homeDirectory: home, platform: "darwin" });
  await initializeStatePaths(paths);
  const store = new StateStore(paths, { now: (() => { let value = 1_000; return () => value++; })() });
  stores.push(store);
  return { store, home };
}

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
        allowsSessionApproval: false,
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

  test("rejects ambiguous labels without effects", async () => {
    const { store } = await fixture();
    store.createProfile("Alpha");
    expect(() => store.createProfile("alpha")).toThrow();
    expect(() => store.requireProfile("missing")).toThrow(SelectionError);
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
    const home = await mkdtemp(join("/private/tmp", "hra-store-fifo-"));
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
    const home = await mkdtemp(join("/private/tmp", "hra-desktop-deadline-"));
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

    const localSend = store.createSession({ profileId: profile.id, preset: "high", fastEnabled: false });
    const sendSession = store.bindSession({ sessionId: localSend.id, expectedRevision: localSend.revision, providerThreadId: "thread-send-cas", state: "idle", providerUpdatedAt: 10 });
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

  test("evicts a deterministic contiguous event prefix by age and reports the exact floor gap", async () => {
    const home = await mkdtemp(join("/private/tmp", "hra-store-event-retention-"));
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
      allowsSessionApproval: true,
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

  test("pages successful usage by exact source revision independent of observation time", async () => {
    const { store } = await fixture();
    const profile = store.createProfile("Usage upload ledger");
    store.recordUsage(profile.id, 1, 30_000, { totalTokens: 100 });
    store.recordUsage(profile.id, 2, 10_000, { totalTokens: 200 });
    store.recordUsagePollFailure(profile.id, 3, 40_000);
    store.recordUsage(profile.id, 4, 20_000, { totalTokens: 400 });

    expect(store.usageAfterRevision({
      afterSourceRevision: 1,
      limit: 2,
      profileId: profile.id,
    })).toEqual([
      { sourceRevision: 2, observedAt: 10_000, payload: { totalTokens: 200 } },
      { sourceRevision: 4, observedAt: 20_000, payload: { totalTokens: 400 } },
    ]);
    expect(store.usageAfterRevision({
      afterSourceRevision: 2,
      limit: 1,
      profileId: profile.id,
    })).toEqual([
      { sourceRevision: 4, observedAt: 20_000, payload: { totalTokens: 400 } },
    ]);
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
        allowsSessionApproval: false,
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
      expect(inspector.query("PRAGMA user_version").get()).toEqual({ user_version: 10 });
      expect(inspector.query("SELECT version FROM migrations ORDER BY version").all()).toEqual([{ version: 1 }, { version: 2 }, { version: 3 }, { version: 4 }, { version: 5 }, { version: 6 }, { version: 7 }, { version: 8 }, { version: 9 }, { version: 10 }]);
      expect(inspector.query("PRAGMA table_info(sessions)").all()).toContainEqual(expect.objectContaining({ name: "provider_updated_at", type: "REAL" }));
      expect(inspector.query("PRAGMA table_info(desktop_switches)").all()).toContainEqual(expect.objectContaining({ name: "switch_generation", type: "INTEGER" }));
      expect(inspector.query("PRAGMA table_info(usage_poll_failures)").all()).toContainEqual(expect.objectContaining({ name: "reason_code", type: "TEXT" }));
    } finally {
      inspector.close(false);
    }
  });

  test("opens and transactionally migrates a real v1 database without losing sessions", async () => {
    const home = await mkdtemp(join("/private/tmp", "hra-store-v1-"));
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
      expect(inspector.query("PRAGMA user_version").get()).toEqual({ user_version: 10 });
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
      ]);
      expect(inspector.query("PRAGMA table_info(sessions)").all()).toContainEqual(expect.objectContaining({ name: "provider_updated_at" }));
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
      expect(inspector.query("PRAGMA user_version").get()).toEqual({ user_version: 10 });
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
    const home = await mkdtemp(join("/private/tmp", "hra-store-newer-"));
    const paths = resolveStatePaths({ homeDirectory: home, platform: "darwin" });
    await initializeStatePaths(paths);
    const newer = new Database(paths.database, { create: true, strict: true });
    newer.exec("PRAGMA user_version = 11");
    newer.close(false);
    expect(() => new StateStore(paths)).toThrow("STATE_SCHEMA_NEWER:11:10");
  });
});
