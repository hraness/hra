import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AutomaticPointerMoveRequest } from "../domain/automatic-pointer-move";
import { createStoredAccountUsageSnapshot } from "../domain/usage-metrics";
import { createCloudUuidV7 } from "../domain/uuid-v7";
import { createAttemptId, type ProfileId } from "../domain/values";
import { applyAutomaticPointerMoveSchema, AutomaticPointerMoveStoreError } from "./automatic-pointer-move";
import { initializeStatePaths, resolveStatePaths } from "./paths";
import { applySessionSendOwnerSchema, SessionSendOwnershipError } from "./session-send-owner";
import { StateStore } from "./state-store";
import { WorkStoreError } from "./work-store";

const stores: StateStore[] = [];
const databases: Database[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const database of databases.splice(0)) database.close(false);
});
const capability = `hrac1_${"A".repeat(43)}`;

async function fixture() {
  const home = await realpath(await mkdtemp(join(tmpdir(), "hra-pointer-boundaries-")));
  const paths = resolveStatePaths({ homeDirectory: home, platform: "darwin" });
  await initializeStatePaths(paths);
  const clock = { now: 1_800_000_000_000 };
  const store = new StateStore(paths, { now: () => clock.now, resolveMachineTimeZone: () => "America/Puerto_Rico",
    publicProviderIdentifierProjector: (raw) => raw.startsWith("opaque_v2_") ? raw : `opaque_v2_${"a".repeat(64)}` });
  stores.push(store);
  const bootId = `boot_${randomUUID().replaceAll("-", "")}`;
  const daemonGeneration = store.nextDaemonGeneration(bootId);
  const profiles = ["Source", "Next", "Last"].map((label) => {
    const profile = store.nextProfileGeneration(store.createProfile(label).id);
    if (!store.setProfileState(profile.id, profile.processGeneration, "signed_in", { email: `${label.toLowerCase()}@example.com`, plan: "Plus" })) {
      throw new Error("Pointer boundary profile fixture failed.");
    }
    return store.requireProfileById(profile.id);
  });
  const source = profiles[0];
  const next = profiles[1];
  const last = profiles[2];
  if (source === undefined || next === undefined || last === undefined) throw new Error("Missing pointer fixture accounts.");
  const revisions = new Map<ProfileId, number>();
  const record = (profileId: ProfileId, usedPercent: number): void => {
    const profile = store.requireProfileById(profileId);
    if (profile.providerEmail === undefined) throw new Error("Missing fixture identity.");
    const revision = (revisions.get(profileId) ?? 0) + 1;
    revisions.set(profileId, revision);
    const authority = store.requireProviderAccountAuthority(profileId, "codex");
    const snapshot = createStoredAccountUsageSnapshot({
      accountFingerprint: createHash("sha256").update(profile.providerEmail.trim().toLowerCase()).digest("hex"),
      daemonGeneration, providerGeneration: authority.processGeneration, sourceSequence: revision,
      observedAt: clock.now, receivedAt: clock.now, previousPayload: store.latestUsage(profileId)?.payload ?? null,
      providerPayload: {
        usage: { summary: { lifetimeTokens: 0, peakDailyTokens: null, longestRunningTurnSec: null, currentStreakDays: null, longestStreakDays: null }, dailyUsageBuckets: null },
        rateLimits: { resetCreditsAvailable: 0, byLimitId: null, primary: {
          limitId: null, limitName: null, planType: null, rateLimitReachedType: null,
          primary: { usedPercent, windowDurationMins: 10_080, resetsAt: (clock.now + 3_600_000) / 1_000 }, secondary: null,
        } },
      },
    });
    store.recordUsage(profileId, revision, clock.now, snapshot, authority);
  };
  for (const profile of profiles) record(profile.id, profile.id === source.id ? 99 : 20);
  const projectRoot = join(home, "project");
  await mkdir(projectRoot);
  const project = await store.createProject("Pointer boundary project", projectRoot, true);
  const unbound = store.createSession({ profileId: source.id, projectId: project.id, provider: "codex", preset: "high", fastEnabled: false });
  const session = store.bindSession({ sessionId: unbound.id, expectedRevision: unbound.revision, providerThreadId: "pointer-boundary-thread", state: "idle" });
  const database = new Database(paths.database, { strict: true });
  databases.push(database);
  database.exec("PRAGMA foreign_keys=ON");
  const work = store.createWorkStore(daemonGeneration, (payload) => `hra1.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.${"A".repeat(43)}`, {
    issue: () => capability, verify: (candidate) => candidate === capability,
  });
  const request = (idempotencyKey: string = randomUUID()): AutomaticPointerMoveRequest => {
    const pointer = store.readProviderAccountState("codex");
    if (pointer.activeProviderAccountId === null) throw new Error("Missing pointer fixture head.");
    const active = store.requireProviderAccountById(pointer.activeProviderAccountId);
    const authority = store.requireProviderAccountAuthority(active.profileId, "codex");
    if (authority.provider !== "codex") throw new Error("Expected Codex authority.");
    const quota = store.latestProviderUsage(active.id)?.quota;
    if (quota === undefined || quota === null) throw new Error("Missing fixture quota.");
    return { idempotencyKey, provider: "codex", daemonGeneration, bootId, expectedSourceAuthority: authority,
      expectedSourceQuotaObservationRevision: quota.observationRevision, expectedSourceQuotaComponentDigest: quota.componentDigest,
      expectedResetPolicyRevision: store.requireAccountRateLimitResetPolicy(active.profileId).revision,
      expectedAutomaticPolicyRevision: store.readAutomaticUsagePolicyConfiguration().automaticPolicyRevision,
      expectedOrderRevision: pointer.orderRevision, expectedPointerRevision: pointer.pointerRevision };
  };
  const send = (idempotencyKey: string = randomUUID()) => ({ kind: "session.send" as const, idempotencyKey, session: session.id, message: "One direct human request.", attachments: [] });
  return { store, database, work, clock, source, next, last, project, session, record, request, send };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

function prepareDispatch(value: Fixture, idempotencyKey = createCloudUuidV7(value.clock.now)) {
  const created = value.work.apply({ kind: "work.create", idempotencyKey: createCloudUuidV7(value.clock.now), clientRef: randomUUID(),
    coordinatorSessionId: value.session.id, objective: "Verify pointer key boundaries.",
    routes: [{ accountId: value.source.id, projectId: value.project.id, preset: "high", fast: false }],
    tasks: [{ clientRef: "boundary", dependsOnRefs: [], dependsOnTaskIds: [], objective: "Preserve exact ownership.", instructions: "Check the guard.", criteria: ["No alternate owner"],
      route: { accountId: value.source.id, projectId: value.project.id }, preset: "high", fast: false, priority: 0, maxAttempts: 3, requiredReviews: 0, resultKind: "text", minEvidence: 0 }],
  });
  if (created.kind !== "work.create" || created.tasks[0] === undefined) throw new Error("Missing Work fixture.");
  value.work.apply({ kind: "work.join", idempotencyKey: createCloudUuidV7(value.clock.now), workId: created.work.id,
    coordinatorSessionId: value.session.id, coordinatorCapability: capability, actorSessionId: value.session.id });
  const claimed = value.work.apply({ kind: "task.claim", idempotencyKey: createCloudUuidV7(value.clock.now), workId: created.work.id,
    taskId: created.tasks[0].id, expectedTaskRevision: created.tasks[0].revision, actorSessionId: value.session.id, actorCapability: capability, leaseMs: 5_000 });
  if (claimed.kind !== "task.claim") throw new Error("Missing Work claim.");
  const operation = { kind: "attempt.dispatch" as const, idempotencyKey, workId: created.work.id, attemptId: claimed.attempt.id,
    expectedAttemptRevision: claimed.attempt.revision, fence: claimed.attempt.fence, actorSessionId: value.session.id,
    attemptCapability: capability, targetSessionId: value.session.id, mode: "send" as const };
  value.work.apply(operation);
  const effect = value.work.preparedEffect(idempotencyKey)?.effect;
  if (effect?.kind !== "dispatch") throw new Error("Missing Work dispatch.");
  return { operation, effect, workId: created.work.id };
}

function genericSend(value: Fixture, key: string) {
  return { kind: "session.send", idempotencyKey: key, authorityId: value.session.id,
    authorityGeneration: value.source.processGeneration, request: { message: "Generic boundary request." },
    providerAuthorities: [{ role: "primary" as const, authority: value.store.requireProviderAccountAuthority(value.source.id, "codex"), provenance: "session_send" }] };
}

function corruptPointer(value: Fixture, attemptId: string, corruption: "anchor_only" | "relocated_key"): void {
  value.database.exec("PRAGMA foreign_keys=OFF");
  try {
    if (corruption === "anchor_only") {
      value.database.exec("DROP TRIGGER automatic_pointer_moves_immutable_delete");
      value.database.exec("DROP TRIGGER automatic_pointer_move_mutation_delete_guard");
      value.database.query("DELETE FROM automatic_pointer_moves WHERE attempt_id=?").run(attemptId);
      value.database.query("DELETE FROM mutation_attempts WHERE id=?").run(attemptId);
    } else {
      value.database.exec("DROP TRIGGER automatic_pointer_moves_immutable_update");
      value.database.query("UPDATE automatic_pointer_moves SET original_key=? WHERE attempt_id=?").run(randomUUID(), attemptId);
    }
    applyAutomaticPointerMoveSchema(value.database);
  } finally {
    value.database.exec("PRAGMA foreign_keys=ON");
  }
}

describe("automatic pointer move cross-consumer boundaries", () => {
  test("reserves the global key against original sends, generic direct-ID effects and configuration", async () => {
    const value = await fixture();
    const request = value.request();
    const move = value.store.settleAutomaticPointerMove(request);
    const rejected = new SessionSendOwnershipError("SESSION_SEND_OWNED_API_REQUIRED");
    expect(() => value.store.readMutation(request.idempotencyKey)).toThrow(rejected);
    expect(() => value.store.prepareOwnedSessionSend(value.send(request.idempotencyKey))).toThrow(rejected);
    expect(() => value.store.prepareMutation(genericSend(value, request.idempotencyKey))).toThrow(rejected);
    expect(() => value.store.beginPreparedMutationEffect({ attemptId: move.attemptId, providerAuthorities: [] })).toThrow(rejected);
    expect(() => value.store.transitionMutation(move.attemptId, "applied", "reconciled")).toThrow(rejected);
    expect(() => value.store.updateAutomaticUsagePolicyConfiguration({ idempotencyKey: request.idempotencyKey,
      expectedAutomaticPolicyRevision: 1, change: { kind: "set_default", enabled: false } })).toThrow(rejected);
    expect(value.store.readAutomaticPointerMove(request.idempotencyKey)?.move).toEqual(move.move);
    expect(value.store.prepareOwnedSessionSend(value.send()).state).toBe("input_required");
    expect(value.store.prepareMutation(genericSend(value, randomUUID())).state).toBe("prepared");
  });

  test("refuses pointer admission over an existing original send key without touching either owner", async () => {
    const value = await fixture();
    const send = value.send();
    const owned = value.store.prepareOwnedSessionSend(send);
    const before = value.store.readProviderAccountState("codex");
    expect(() => value.store.settleAutomaticPointerMove(value.request(send.idempotencyKey))).toThrow(new AutomaticPointerMoveStoreError("AUTOMATIC_POINTER_MOVE_REQUEST_CONFLICT"));
    expect(value.store.readOwnedSessionSend(send.idempotencyKey)?.ownerDigest).toBe(owned.ownerDigest);
    expect(value.store.readProviderAccountState("codex")).toEqual(before);
    expect(value.database.query("SELECT COUNT(*) AS count FROM automatic_pointer_moves").get()).toEqual({ count: 0 });
    expect(value.store.settleAutomaticPointerMove(value.request()).move.target.authority.providerAccountId).toBe(value.next.id);
  });

  test("pointer admission respects inverse original-send reservation when its mutation is missing", async () => {
    const value = await fixture();
    const send = value.send();
    const owner = value.store.prepareOwnedSessionSend(send);
    const anchors = value.database.query("SELECT * FROM session_send_owner_anchors WHERE attempt_id=?").all(owner.owner.attemptId);
    value.database.exec("PRAGMA foreign_keys=OFF");
    try {
      value.database.exec("DROP TRIGGER session_send_mutation_delete_guard");
      value.database.query("DELETE FROM mutation_attempts WHERE id=?").run(owner.owner.attemptId);
      applySessionSendOwnerSchema(value.database);
    } finally {
      value.database.exec("PRAGMA foreign_keys=ON");
    }
    expect(() => value.store.settleAutomaticPointerMove(value.request(send.idempotencyKey))).toThrow("SESSION_SEND_OWNER_CORRUPT");
    expect(value.database.query("SELECT * FROM session_send_owner_anchors WHERE attempt_id=?").all(owner.owner.attemptId)).toEqual(anchors);
    expect(value.database.query("SELECT 1 FROM automatic_pointer_moves WHERE original_key=?").get(send.idempotencyKey)).toBeNull();
    expect(value.store.settleAutomaticPointerMove(value.request()).move.target.authority.providerAccountId).toBe(value.next.id);
  });

  for (const settled of [false, true]) {
    test(`Work ${settled ? "cached accepted replay" : "prepared dispatch"} rejects a protected nested pointer key`, async () => {
      const value = await fixture();
      const prepared = prepareDispatch(value);
      const receipt = { kind: "turn_started" as const, turnId: `opaque_v2_${"a".repeat(64)}`, runtimeProfileDigest: "b".repeat(64),
        mutationAttemptId: createAttemptId(), accountGeneration: value.source.processGeneration };
      if (settled) {
        expect(value.work.authorizePreparedEffect(prepared.operation.idempotencyKey).executable).toBe(true);
        value.work.finalizeDispatch(prepared.operation.idempotencyKey, { kind: "accepted", receipt });
      }
      const moved = value.store.settleAutomaticPointerMove(value.request(prepared.effect.nestedMutationKey));
      const snapshot = value.work.snapshot(prepared.workId);
      const rejected = new WorkStoreError("ATTEMPT_RECOVERY_REQUIRED");
      expect(() => value.work.authorizePreparedEffect(prepared.operation.idempotencyKey)).toThrow(rejected);
      expect(() => value.work.reprojectPreparedEffect(prepared.operation.idempotencyKey)).toThrow(rejected);
      expect(() => value.work.apply(prepared.operation)).toThrow(rejected);
      expect(() => value.work.finalizeDispatch(prepared.operation.idempotencyKey, { kind: "accepted", receipt })).toThrow(rejected);
      expect(() => value.work.settlePreparedEffectNoEffect(prepared.operation.idempotencyKey, "not_dispatched")).toThrow(rejected);
      expect(value.work.snapshot(prepared.workId)).toEqual(snapshot);
      expect(value.store.readAutomaticPointerMove(prepared.effect.nestedMutationKey)?.move).toEqual(moved.move);
    });
  }

  test("does not reserve the independent top-level Work intent namespace", async () => {
    const value = await fixture();
    const key = createCloudUuidV7(value.clock.now);
    const moved = value.store.settleAutomaticPointerMove(value.request(key));
    const prepared = prepareDispatch(value, key);
    expect(prepared.effect.nestedMutationKey).not.toBe(key);
    expect(value.work.authorizePreparedEffect(key).executable).toBe(true);
    expect(value.work.apply(prepared.operation).kind).toBe("attempt.dispatch");
    expect(value.store.readAutomaticPointerMove(key)?.move).toEqual(moved.move);
    expect(value.store.readMutation(prepared.effect.nestedMutationKey)).toBeNull();
  });

  for (const corruption of ["anchor_only", "relocated_key"] as const) {
    test(`${corruption} evidence keeps original key reserved across raw SQL, sends and Work replay`, async () => {
      const value = await fixture();
      const prepared = prepareDispatch(value);
      const request = value.request(prepared.effect.nestedMutationKey);
      const moved = value.store.settleAutomaticPointerMove(request);
      const anchor = value.database.query("SELECT * FROM automatic_pointer_move_anchors WHERE attempt_id=?").get(moved.attemptId);
      corruptPointer(value, moved.attemptId, corruption);
      expect(() => value.store.readAutomaticPointerMove(request.idempotencyKey)).toThrow("AUTOMATIC_POINTER_MOVE_CORRUPT");
      expect(() => value.store.settleAutomaticPointerMove(request)).toThrow("AUTOMATIC_POINTER_MOVE_CORRUPT");
      expect(() => value.store.prepareOwnedSessionSend(value.send(request.idempotencyKey))).toThrow("SESSION_SEND_OWNER_CORRUPT");
      expect(() => value.store.prepareMutation(genericSend(value, request.idempotencyKey))).toThrow("SESSION_SEND_OWNER_CORRUPT");
      expect(() => value.work.authorizePreparedEffect(prepared.operation.idempotencyKey)).toThrow(new WorkStoreError("ATTEMPT_RECOVERY_REQUIRED"));
      for (const [attemptId, key] of [[createAttemptId(), request.idempotencyKey], [moved.attemptId, randomUUID()]]) {
        expect(() => value.database.query(`INSERT INTO mutation_attempts(id,idempotency_key,kind,authority_id,authority_generation,request_digest,state,created_at,updated_at)
          VALUES(?,?,'session.send',?,? ,?,'prepared',?,?)`).run(attemptId!, key!, value.session.id, value.source.processGeneration, "a".repeat(64), value.clock.now, value.clock.now)).toThrow("AUTOMATIC_POINTER_MOVE_CORRUPT");
      }
      expect(value.database.query("SELECT * FROM automatic_pointer_move_anchors WHERE attempt_id=?").get(moved.attemptId)).toEqual(anchor);
      expect(value.store.prepareOwnedSessionSend(value.send()).state).toBe("input_required");
      expect(value.store.prepareMutation(genericSend(value, randomUUID())).state).toBe("prepared");
    });
  }

  test("returns complete named automatic lineage but never bridges a manual pointer transition", async () => {
    const value = await fixture();
    const first = value.store.settleAutomaticPointerMove(value.request());
    value.record(value.next.id, 99);
    const second = value.store.settleAutomaticPointerMove(value.request());
    expect(second.move.target.authority.providerAccountId).toBe(value.last.id);
    expect(value.store.readAutomaticPointerMoveLineage({ fromPointerRevision: first.move.authority.pointerRevision,
      throughPointerRevision: second.move.toPointerRevision }).map((move) => move.moveId)).toEqual([first.move.moveId, second.move.moveId]);
    const manual = value.store.activateProviderAccount({ provider: "codex", expectedPointerRevision: second.move.toPointerRevision, providerAccountId: value.source.id });
    const third = value.store.settleAutomaticPointerMove(value.request());
    expect(third.move.authority.pointerRevision).toBe(manual.pointerRevision);
    expect(value.store.readAutomaticPointerMoveLineage({ fromPointerRevision: manual.pointerRevision,
      throughPointerRevision: third.move.toPointerRevision }).map((move) => move.moveId)).toEqual([third.move.moveId]);
    expect(() => value.store.readAutomaticPointerMoveLineage({ fromPointerRevision: first.move.authority.pointerRevision,
      throughPointerRevision: third.move.toPointerRevision })).toThrow("AUTOMATIC_POINTER_MOVE_LINEAGE_GAP");
    expect(value.store.readAutomaticPointerMove(first.idempotencyKey)?.move).toEqual(first.move);
  });

  test("replays immutable history after quota retention and mutable authority, policy and pointer changes", async () => {
    const value = await fixture();
    const request = value.request();
    const first = value.store.settleAutomaticPointerMove(request);
    const original = value.store.readAutomaticPointerMove(request.idempotencyKey);
    if (original === null) throw new Error("Missing historical pointer receipt.");
    value.clock.now += 2 * 24 * 60 * 60_000;
    for (const profile of [value.source, value.next, value.last]) value.record(profile.id, 0);
    expect(value.database.query("SELECT COUNT(*) AS count FROM usage_snapshots WHERE source_revision=1").get()).toEqual({ count: 0 });
    value.store.replaceProviderAccountOrder({ provider: "codex", expectedOrderRevision: request.expectedOrderRevision,
      providerAccountIds: [value.last.id, value.next.id, value.source.id] });
    value.store.activateProviderAccount({ provider: "codex", expectedPointerRevision: first.move.toPointerRevision, providerAccountId: value.last.id });
    value.store.updateAutomaticUsagePolicyConfiguration({ idempotencyKey: randomUUID(), expectedAutomaticPolicyRevision: 1,
      change: { kind: "set_default", enabled: false } });
    value.store.nextProfileGeneration(value.source.id);
    expect(value.store.readAutomaticPointerMove(request.idempotencyKey)).toEqual(original);
    expect(value.store.settleAutomaticPointerMove(request)).toEqual({ ...original, replayed: true });
    expect(value.store.readProviderAccountState("codex").activeProviderAccountId).toBe(value.last.id);
    expect(value.store.readAutomaticUsagePolicyConfiguration().defaultEnabled).toBe(false);
  });
});
