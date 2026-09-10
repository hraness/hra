import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fc from "fast-check";

import { initializeStatePaths, resolveStatePaths } from "./paths";
import { attachmentTerminalProof, readAttachmentParent } from "./attachment-custody";
import { insertPeerSessionCancellation, parsePeerSessionCancellationReceipt,
  PEER_SESSION_CANCELLATION_KIND, readPeerSessionCancellation } from "./peer-session-cancellation";
import { StateStore } from "./state-store";

const stores: StateStore[] = [];
const databases: Database[] = [];
const roots: string[] = [];
afterEach(async () => {
  for (const db of databases.splice(0)) db.close(false);
  for (const store of stores.splice(0)) store.close();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const quote = (value: string) => `"${value.replaceAll('"', '""')}"`;
const code = "PEER_SESSION_PROVIDER_EFFECT_NOT_STARTED";

// Current public APIs, synthetic identities, and no provider process: this is
// cancellation/retention evidence, not a historical capture or provider effect.
async function fixture(delivery: "send" | "steer" = "send") {
  const home = await realpath(await mkdtemp(join(tmpdir(), "oompa-peer-cancellation-")));
  roots.push(home);
  const paths = resolveStatePaths({ homeDirectory: home, platform: "darwin" });
  await initializeStatePaths(paths);
  let now = 10_000;
  const store = new StateStore(paths, { now: () => now++ }); stores.push(store);
  const bootId = `boot_${"a".repeat(32)}`;
  const daemonGeneration = store.nextDaemonGeneration(bootId);
  const directory = join(home, "project"); await mkdir(directory);
  const project = await store.createProject("Peer cancellation", directory);
  const makeSession = (label: string, active: boolean) => {
    const profile = store.nextProfileGeneration(store.createProfile(label).id);
    store.setProfileState(profile.id, profile.processGeneration, "signed_in", { email: `${label}@example.com`, plan: "Plus" });
    let authority = store.requireProviderAccountAuthority(profile.id, "claude");
    for (let index = 0; index < 3; index++) authority = store.advanceProviderAccountProcessGeneration({
      profileId: profile.id, provider: "claude", expectedProcessGeneration: authority.processGeneration,
    });
    const session = store.upsertProviderSession({ profileId: profile.id, provider: "claude", providerAuthority: authority,
      providerAccountKey: `v1:claude:${hash(label)}`, projectId: project.id, providerThreadId: `thread-${label}`,
      title: label, preset: "fable-max", fastEnabled: false, state: active ? "active" : "idle",
      ...(active ? { activeTurnId: `turn-${label}` } : {}),
    });
    const policy = store.requirePeerSessionPolicy(session.id);
    if (policy.mode !== "coordinate") store.setPeerSessionPolicy({ sessionId: session.id, expectedRevision: policy.revision, mode: "coordinate" });
    return { profile, session, authority };
  };
  const actor = makeSession("actor", true), target = makeSession("target", delivery === "steer");
  const message = "Exact retained peer message";
  const request = { actorSessionId: actor.session.id, actorTurnId: "turn-actor", targetSessionId: target.session.id,
    expectedTargetRevision: target.session.revision, delivery, requestDigest: hash("peer envelope"),
    messageDigest: hash(message), reasonDigest: hash("reason"), idempotencyKey: randomUUID() };
  const action = store.admitPeerSessionAction(request).action;
  const db = new Database(paths.database, { create: false, strict: true }); databases.push(db);
  db.exec("PRAGMA foreign_keys=ON");
  const snapshot = () => ({
    schema: db.query("SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name").all(),
    tables: db.query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(({ name }) => {
      const rows = db.query(`SELECT * FROM ${quote(name)} ORDER BY rowid LIMIT 257`).all();
      if (rows.length > 256) throw new Error("Cancellation fixture exceeded row budget.");
      return { name, rows };
    }),
  });
  const receipt = () => parsePeerSessionCancellationReceipt({ version: 1, peerActionId: action.id,
    idempotencyKey: action.idempotencyKey, actorSessionId: action.actorSessionId, actorTurnDigest: action.actorTurnDigest,
    projectId: action.projectId, targetSessionId: action.targetSessionId, targetExpectedRevision: action.targetExpectedRevision,
    delivery: action.delivery, requestDigest: action.requestDigest, messageDigest: action.messageDigest,
    reasonDigest: action.reasonDigest, code, providerEffectStarted: false });
  const cancel = () => store.cancelUnstartedPeerSessionDirectAction({ actionId: action.id, diagnosticCode: code });
  return { store, db, paths, actor, target, request, action, message, receipt, cancel, snapshot, bootId, daemonGeneration,
    advanceTime: () => { now += 31 * 24 * 60 * 60 * 1_000; } };
}

describe("terminal-only peer cancellation", () => {
  test("ordinary human input and queue admission still install their own custody and identity anchors", async () => {
    const f = await fixture();
    const prepared = f.store.prepareSessionInputMutation({ kind: "session.send", sessionId: f.target.session.id,
      idempotencyKey: randomUUID(), message: "ordinary human input", attachments: [],
      providerAuthority: f.target.authority, daemonGeneration: f.daemonGeneration, bootId: f.bootId });
    expect(readAttachmentParent(f.db, prepared.attempt.id).format).toBe("empty_v1");
    const queued = f.store.enqueueIdempotent({ sessionId: f.target.session.id, profileGeneration: f.target.authority.processGeneration,
      providerAuthority: f.target.authority, idempotencyKey: randomUUID(), message: "ordinary human queue" });
    expect(f.store.queueAttachmentManifest(queued.id)).toEqual([]);
    expect(f.db.query("SELECT original_key FROM queue_attachment_identity_anchors WHERE queue_id=?").get(queued.id)).toBeDefined();
  });

  test.each(["send", "steer"] as const)("absent %s input reserves its original key without inventing provider or custody authority", async (delivery) => {
    const f = await fixture(delivery);
    f.store.advanceProviderAccountProcessGeneration({ profileId: f.target.profile.id, provider: "claude",
      expectedProcessGeneration: f.target.authority.processGeneration });
    const cancelled = f.cancel();
    expect(cancelled.state).toBe("cancelled");
    expect(f.store.readMutation(f.action.idempotencyKey)).toMatchObject({ kind: PEER_SESSION_CANCELLATION_KIND,
      authorityId: f.target.session.id, authorityGeneration: 0, state: "cancelled", result: f.receipt() });
    expect(readPeerSessionCancellation(f.db, f.action.idempotencyKey)).toEqual(f.receipt());
    expect(f.store.readPeerSessionMutationJoin(f.action.idempotencyKey)).toMatchObject({ action: cancelled,
      attempt: { state: "cancelled", kind: PEER_SESSION_CANCELLATION_KIND } });
    expect(f.store.readPeerSessionDirectMessageSource(f.action.idempotencyKey)).toBeNull();
    for (const table of ["mutation_effect_evidence", "mutation_resolutions", "mutation_provider_authorities",
      "attachment_custody_sets", "attachment_custody_anchors", "session_send_owners", "session_events"]) {
      expect(f.db.query(`SELECT * FROM ${quote(table)}`).all()).toEqual([]);
    }
    const before = f.snapshot();
    expect(f.cancel()).toEqual(cancelled);
    expect(f.store.admitPeerSessionAction(f.request)).toMatchObject({ replay: true, action: cancelled });
    expect(() => f.store.cancelUnstartedPeerSessionDirectAction({ actionId: f.action.id, diagnosticCode: "OTHER" }))
      .toThrow("PEER_SESSION_CANCELLATION_CONFLICT");
    expect(f.snapshot()).toEqual(before);
    for (const readonly of [false, true]) {
      const reopened = new StateStore(f.paths, { readonly }); stores.push(reopened);
      expect(reopened.readPeerSessionMutationJoin(f.action.idempotencyKey)?.attempt.kind).toBe(PEER_SESSION_CANCELLATION_KIND);
      expect(f.snapshot()).toEqual(before);
    }
  });

  test.each([
    ["send", "effect_started"], ["send", "ambiguous"],
    ["steer", "effect_started"], ["steer", "ambiguous"],
  ] as const)("an outer %s %s with no nested effect cancels exactly after target revision advances", async (delivery, state) => {
    const f = await fixture(delivery);
    f.store.beginPeerSessionActionEffect(f.action.id);
    if (state === "ambiguous") f.store.settlePeerSessionAction({
      actionId: f.action.id, expectedState: "effect_started", state,
    });
    const target = f.store.updateSessionMetadata({ sessionId: f.target.session.id,
      expectedRevision: f.target.session.revision, note: "Target revision advanced before inner dispatch" });
    expect(target.revision).toBe(f.action.targetExpectedRevision + 1);
    const cancelled = f.cancel();
    expect(cancelled).toMatchObject({ state: "cancelled", resultDigest: hash(JSON.stringify(f.receipt())) });
    expect(readPeerSessionCancellation(f.db, f.action.idempotencyKey)).toEqual(f.receipt());
    expect(f.store.requireSession(target.id)).toEqual(target);
    for (const table of ["mutation_effect_evidence", "mutation_resolutions", "mutation_provider_authorities",
      "attachment_custody_sets", "attachment_custody_anchors", "session_send_owners", "session_events"]) {
      expect(f.db.query(`SELECT * FROM ${quote(table)}`).all()).toEqual([]);
    }
    const before = f.snapshot();
    expect(f.cancel()).toEqual(cancelled);
    expect(f.snapshot()).toEqual(before);
    for (const readonly of [false, true]) {
      const reopened = new StateStore(f.paths, { readonly }); stores.push(reopened);
      expect(reopened.readPeerSessionMutationJoin(f.action.idempotencyKey)?.attempt.kind).toBe(PEER_SESSION_CANCELLATION_KIND);
      expect(f.snapshot()).toEqual(before);
    }
  });

  test.each(["result_digest", "updated_at", "target_expected_revision"] as const)(
    "the joined outer cancellation refuses mismatched %s and rolls back the inserted receipt", async (field) => {
      const f = await fixture();
      f.store.beginPeerSessionActionEffect(f.action.id);
      f.store.settlePeerSessionAction({ actionId: f.action.id, expectedState: "effect_started", state: "ambiguous" });
      const before = f.snapshot();
      expect(() => f.db.transaction(() => {
        insertPeerSessionCancellation(f.db, { attemptId: `attempt_${"d".repeat(32)}`,
          receipt: f.receipt(), recordedAt: 20_000 });
        f.db.query(`UPDATE peer_session_actions SET state='cancelled',result_digest=?,updated_at=?,target_expected_revision=? WHERE id=?`)
          .run(field === "result_digest" ? hash("wrong result") : hash(JSON.stringify(f.receipt())),
            field === "updated_at" ? 19_999 : 20_000,
            f.action.targetExpectedRevision + (field === "target_expected_revision" ? 1 : 0), f.action.id);
      }).immediate()).toThrow("illegal peer session action transition");
      expect(f.snapshot()).toEqual(before);
      expect(f.store.readMutation(f.action.idempotencyKey)).toBeNull();
    },
  );

  test("a different nested mutation kind cannot borrow the peer key or authorize cancellation", async () => {
    const f = await fixture();
    f.store.beginPeerSessionActionEffect(f.action.id);
    const before = f.snapshot();
    expect(() => f.store.prepareMutation({ kind: "session.stop", authorityId: f.target.session.id,
      authorityGeneration: f.target.authority.processGeneration,
      request: { activeTurnId: "other-turn" }, idempotencyKey: f.action.idempotencyKey }))
      .toThrow("PEER_SESSION_MUTATION_JOIN_INVALID");
    expect(f.snapshot()).toEqual(before);
    expect(f.store.readMutation(f.action.idempotencyKey)).toBeNull();
  });

  test("an actual nested steer effect stays recoverable and cannot become a no-effect cancellation", async () => {
    const f = await fixture("steer");
    const prepared = f.store.prepareSessionInputMutation({ kind: "session.steer", sessionId: f.target.session.id,
      idempotencyKey: f.action.idempotencyKey, message: f.message, attachments: [],
      providerAuthority: f.target.authority, daemonGeneration: f.daemonGeneration, bootId: f.bootId });
    f.store.beginSessionMutationEffect({ attemptId: prepared.attempt.id, sessionId: f.target.session.id,
      profileGeneration: f.target.authority.processGeneration, providerAuthority: f.target.authority,
      daemonGeneration: f.daemonGeneration, bootId: f.bootId, attachments: [], message: f.message,
      transcript: { accountId: f.target.profile.id, providerGeneration: f.target.authority.processGeneration,
        providerConnectionId: "10000000-0000-4000-8000-000000000099", actor: "peer_session", message: f.message },
      evidence: { kind: "session.steer", providerThreadId: "thread-target", activeTurnId: "turn-target",
        baseline: { providerUpdatedAt: null, status: "active", activeTurnId: "turn-target" },
        clientMessageId: prepared.attempt.id, messageDigest: hash(f.message), messageActor: "peer_session" },
    });
    f.store.settlePeerSessionAction({ actionId: f.action.id, expectedState: "effect_started", state: "ambiguous" });
    const before = f.snapshot();
    expect(f.cancel).toThrow("PEER_SESSION_CANCELLATION_UNPROVEN");
    expect(f.snapshot()).toEqual(before);
    expect(f.store.readMutation(f.action.idempotencyKey)).toMatchObject({ state: "effect_started", kind: "session.steer" });
  });

  test("the terminal row cannot acquire an effect, be rewritten, or be used by generic preparation", async () => {
    const f = await fixture(); f.cancel();
    const attempt = f.store.readMutation(f.action.idempotencyKey);
    if (attempt === null) throw new Error("Expected cancellation receipt.");
    const before = f.snapshot();
    expect(() => f.store.prepareMutation({ kind: PEER_SESSION_CANCELLATION_KIND, authorityId: f.target.session.id,
      authorityGeneration: 0, request: {}, idempotencyKey: randomUUID() })).toThrow("PEER_SESSION_CANCELLATION_CLOSED_API_REQUIRED");
    expect(() => f.store.beginPreparedMutationEffect({ attemptId: attempt.id, providerAuthorities: [] }))
      .toThrow("PEER_SESSION_CANCELLATION_CLOSED_API_REQUIRED");
    expect(() => f.db.query("UPDATE mutation_attempts SET result_json=result_json WHERE id=?").run(attempt.id))
      .toThrow("PEER_SESSION_CANCELLATION_IMMUTABLE");
    expect(() => f.db.query("DELETE FROM mutation_attempts WHERE id=?").run(attempt.id))
      .toThrow("PEER_SESSION_CANCELLATION_IMMUTABLE");
    expect(() => f.db.query("INSERT INTO mutation_effect_evidence(attempt_id,kind,evidence_json,evidence_digest,recorded_at) VALUES(?,?,?,?,?)")
      .run(attempt.id, PEER_SESSION_CANCELLATION_KIND, "{}", hash("{}"), 20_000)).toThrow();
    expect(() => f.db.query("INSERT INTO mutation_resolutions(attempt_id,resolution_kind,evidence_json,receipt_json,created_at) VALUES(?,'abandoned','{}',NULL,20000)")
      .run(attempt.id)).toThrow();
    expect(f.snapshot()).toEqual(before);
  });

  test("actual causal action compaction preserves the cancellation receipt and refuses original-key reuse", async () => {
    const f = await fixture(); f.cancel();
    const receipt = readPeerSessionCancellation(f.db, f.action.idempotencyKey);
    expect(receipt).toEqual(f.receipt());
    const idle = f.store.setSessionTurnState({ sessionId: f.actor.session.id,
      expectedRevision: f.actor.session.revision, state: "idle" });
    f.store.setSessionTurnState({ sessionId: idle.id, expectedRevision: idle.revision,
      state: "active", activeTurnId: "turn-actor-next" });
    f.advanceTime();
    // A fresh, independent actor turn drives the real bounded retention path.
    expect(f.store.admitPeerSessionAction({ ...f.request, actorTurnId: "turn-actor-next",
      idempotencyKey: randomUUID() }).action.state).toBe("prepared");
    expect(f.db.query("SELECT id FROM peer_session_actions WHERE id=?").get(f.action.id)).toBeNull();
    expect(readPeerSessionCancellation(f.db, f.action.idempotencyKey)).toEqual(receipt);
    expect(f.store.readPeerSessionMutationJoin(f.action.idempotencyKey)).toMatchObject({ action: null,
      attempt: { kind: PEER_SESSION_CANCELLATION_KIND, state: "cancelled", result: receipt } });
    const before = f.snapshot();
    expect(() => f.store.admitPeerSessionAction({ ...f.request, actorTurnId: "turn-actor-next" }))
      .toThrow("PEER_SESSION_IDEMPOTENCY_CONFLICT");
    expect(() => f.store.prepareSessionInputMutation({ kind: "session.send", sessionId: f.target.session.id,
      idempotencyKey: f.action.idempotencyKey, message: f.message, attachments: [], providerAuthority: f.target.authority,
      daemonGeneration: f.daemonGeneration, bootId: f.bootId })).toThrow("ATTACHMENT_CUSTODY_REQUEST_CONFLICT");
    expect(f.snapshot()).toEqual(before);
  });

  test.each(["peerActionId", "actorSessionId", "actorTurnDigest", "projectId", "targetSessionId", "targetExpectedRevision", "delivery", "requestDigest", "messageDigest", "reasonDigest"] as const)(
    "SQL cancellation admission refuses an altered %s without writes", async (field) => {
      const f = await fixture();
      f.store.beginPeerSessionActionEffect(f.action.id);
      f.store.settlePeerSessionAction({ actionId: f.action.id, expectedState: "effect_started", state: "ambiguous" });
      const original = f.receipt();
      const value = original[field];
      const changed = field === "delivery" ? "steer" : typeof value === "number" ? value + 1
        : value.startsWith("sess_") ? `sess_${"9".repeat(32)}`
        : value.startsWith("peer_") ? `peer_${"9".repeat(32)}`
        : value.startsWith("proj_") ? `proj_${"9".repeat(32)}` : "9".repeat(64);
      const before = f.snapshot();
      expect(() => f.db.transaction(() => insertPeerSessionCancellation(f.db, {
        attemptId: `attempt_${"d".repeat(32)}`, receipt: parsePeerSessionCancellationReceipt({ ...original, [field]: changed }), recordedAt: 20_000,
      })).immediate()).toThrow("PEER_SESSION_CANCELLATION_UNPROVEN");
      expect(f.snapshot()).toEqual(before);
    },
  );

  test("a retained ingress reservation prevents a false absent-input cancellation", async () => {
    const f = await fixture();
    f.store.beginPeerSessionActionEffect(f.action.id);
    f.store.settlePeerSessionAction({ actionId: f.action.id, expectedState: "effect_started", state: "ambiguous" });
    const reservation = f.store.reserveAttachmentIngress({ kind: "session.send", sessionId: f.target.session.id,
      idempotencyKey: f.action.idempotencyKey, message: f.message, providerAuthority: f.target.authority,
      daemonGeneration: f.daemonGeneration, bootId: f.bootId,
      attachments: [{ digest: hash("attachment"), byteLength: 1, name: "note.txt", mediaType: "text/plain" }] });
    expect(reservation.kind).toBe("reserved");
    const before = f.snapshot();
    expect(f.cancel).toThrow("PEER_SESSION_CANCELLATION_UNPROVEN");
    expect(f.snapshot()).toEqual(before);
  });

  test.each(["send", "steer"] as const)("a genuinely prepared %s keeps its input proof and settles independent no-effect custody", async (delivery) => {
    const f = await fixture(delivery);
    const prepared = f.store.prepareSessionInputMutation({ kind: delivery === "send" ? "session.send" : "session.steer",
      sessionId: f.target.session.id, idempotencyKey: f.action.idempotencyKey, message: f.message, attachments: [],
      providerAuthority: f.target.authority, daemonGeneration: f.daemonGeneration, bootId: f.bootId });
    const proof = readAttachmentParent(f.db, prepared.attempt.id);
    const cancelled = f.cancel();
    expect(cancelled.state).toBe("cancelled");
    expect(f.store.readMutation(f.action.idempotencyKey)).toMatchObject({ kind: `session.${delivery}`, state: "cancelled",
      authorityGeneration: f.target.authority.processGeneration });
    expect(f.db.query("SELECT result_json FROM mutation_attempts WHERE id=?").get(prepared.attempt.id)).toEqual({ result_json: null });
    expect(readAttachmentParent(f.db, prepared.attempt.id)).toEqual(proof);
    expect(attachmentTerminalProof(f.db, prepared.attempt.id)).toMatch(/^[a-f0-9]{64}$/u);
    expect(f.db.query("SELECT attachment_cleanup_terminal_digest FROM mutation_attempts WHERE id=?").get(prepared.attempt.id))
      .toEqual({ attachment_cleanup_terminal_digest: attachmentTerminalProof(f.db, prepared.attempt.id) });
    const before = f.snapshot(); expect(f.cancel()).toEqual(cancelled); expect(f.snapshot()).toEqual(before);
  });

  test("a genuinely prepared attached input retains its original proof and releases only its actual custody", async () => {
    const f = await fixture();
    const input = { kind: "session.send" as const, sessionId: f.target.session.id,
      idempotencyKey: f.action.idempotencyKey, message: f.message, providerAuthority: f.target.authority,
      daemonGeneration: f.daemonGeneration, bootId: f.bootId,
      attachments: [{ digest: hash("retained input"), byteLength: 14, name: "note.txt", mediaType: "text/plain" as const }] };
    const reservation = f.store.reserveAttachmentIngress(input);
    if (reservation.kind !== "reserved") throw new Error("Expected genuine retained reservation.");
    const prepared = f.store.prepareSessionInputMutation({ ...input,
      reservation: { reservationId: reservation.reservationId, reservationDigest: reservation.reservationDigest } });
    const parent = readAttachmentParent(f.db, prepared.attempt.id);
    expect(parent.format).toBe("retained_v1");
    f.cancel();
    const settled = readAttachmentParent(f.db, prepared.attempt.id);
    expect(settled.proof).toEqual(parent.proof);
    expect(settled.custody?.releasedBy).toMatch(/^[a-f0-9]{64}$/u);
    expect(f.db.query("SELECT kind,proof_json FROM attachment_custody_dispositions WHERE custody_id=? ORDER BY ordinal DESC LIMIT 1")
      .get(reservation.reservationId)).toEqual({ kind: "terminal",
        proof_json: JSON.stringify({ terminalDigest: attachmentTerminalProof(f.db, prepared.attempt.id) }) });
    expect(f.db.query("SELECT custody_id FROM attachment_custody_slots WHERE custody_id=?")
      .get(reservation.reservationId)).toBeNull();
    expect(f.db.query("SELECT kind,result_json FROM mutation_attempts WHERE id=?").get(prepared.attempt.id))
      .toEqual({ kind: "session.send", result_json: null });
    const before = f.snapshot(); f.cancel(); expect(f.snapshot()).toEqual(before);
  });

  test("canonical receipt parsing has stable ordering, detachment and closed foreign-value rejection", async () => {
    const f = await fixture(); const original = f.receipt();
    fc.assert(fc.property(fc.shuffledSubarray(Object.entries(original), { minLength: 14, maxLength: 14 }), (entries) => {
      const input = Object.fromEntries(entries);
      const parsed = parsePeerSessionCancellationReceipt(input);
      expect(JSON.stringify(parsed)).toBe(JSON.stringify(original));
      expect(parsed).not.toBe(input); expect(Object.isFrozen(parsed)).toBe(true);
      input.code = "CHANGED"; expect(parsed.code).toBe(code);
    }), { seed: 72011, numRuns: 100 });
    fc.assert(fc.property(fc.jsonValue(), (input) => {
      let parsed: ReturnType<typeof parsePeerSessionCancellationReceipt> | undefined;
      try { parsed = parsePeerSessionCancellationReceipt(input); }
      catch (error) { expect(error).toMatchObject({ message: "PEER_SESSION_CANCELLATION_UNPROVEN" }); return; }
      expect(parsePeerSessionCancellationReceipt(parsed)).toEqual(parsed);
    }), { seed: 72012, numRuns: 100 });
    expect(() => parsePeerSessionCancellationReceipt({ ...original, unexpected: true })).toThrow();
  });
});
