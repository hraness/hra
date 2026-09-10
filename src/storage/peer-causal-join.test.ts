import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

import { effectiveClaudeRuntimeProfileSchema } from "../domain/runtime-profile";
import { readMutationEffectEvidenceProvenance, readQueueEffectEvidenceProvenance } from "./effect-evidence-provenance";
import { initializeStatePaths, resolveStatePaths } from "./paths";
import { PEER_SESSION_TURN_ORIGIN_LIMIT, StateStore, type SessionRecord } from "./state-store";

const stores: StateStore[] = [];
const databases: Database[] = [];
const homes: string[] = [];
afterEach(async () => {
  for (const db of databases.splice(0)) db.close(false);
  for (const store of stores.splice(0)) store.close();
  for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true });
});
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const quote = (value: string) => `"${value.replaceAll('"', '""')}"`;
const snapshot = (db: Database) => ({ schema: db.query("SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY name").all(),
  tables: db.query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all()
    .map(({ name }) => ({ name, digest: hash(JSON.stringify(db.query(`SELECT * FROM ${quote(name)}`).all()
      .map((row) => JSON.stringify(row)).sort())) })),
});
function corrupt(db: Database, tables: readonly string[], operation: () => void): void {
  const guards = db.query<{ name: string; sql: string; tbl_name: string }, []>(
    "SELECT name,sql,tbl_name FROM sqlite_master WHERE type='trigger' ORDER BY name",
  ).all().filter((row) => tables.includes(row.tbl_name));
  db.transaction(() => {
    for (const guard of guards) db.exec(`DROP TRIGGER ${quote(guard.name)}`);
    operation();
    for (const guard of guards) db.exec(guard.sql);
  }).immediate();
  expect(db.query<{ name: string; sql: string; tbl_name: string }, []>(
    "SELECT name,sql,tbl_name FROM sqlite_master WHERE type='trigger' ORDER BY name",
  ).all().filter((row) => tables.includes(row.tbl_name))).toEqual(guards);
}

// Current public storage APIs, synthetic native observations, no provider. The
// fixture does not claim to be an archived producer or a migration capture.
async function fixture(targetActive = false) {
  const home = await realpath(await mkdtemp(join(tmpdir(), "oompa-peer-causal-join-"))); homes.push(home);
  const paths = resolveStatePaths({ homeDirectory: home, platform: "darwin" }); await initializeStatePaths(paths);
  const store = new StateStore(paths, { now: () => 50_000 }); stores.push(store);
  const bootId = `boot_${"a".repeat(32)}`;
  const daemon = { bootId, daemonGeneration: store.nextDaemonGeneration(bootId) };
  const directory = join(home, "project"); await mkdir(directory);
  const project = await store.createProject("Peer causal join", directory);
  const profile = store.nextProfileGeneration(store.createProfile("Peer").id);
  store.setProfileState(profile.id, profile.processGeneration, "signed_in", { email: "peer@example.com", plan: "Plus" });
  for (let index = 0; index < 2; index += 1) store.advanceProviderAccountProcessGeneration({
    profileId: profile.id, provider: "claude", expectedProcessGeneration: index,
  });
  const authority = store.requireProviderAccountAuthority(profile.id, "claude");
  const create = (label: string, active: boolean) => {
    const session = store.upsertProviderSession({ profileId: profile.id, provider: "claude", providerAuthority: authority,
      providerAccountKey: `v1:claude:${hash("synthetic account")}`, projectId: project.id,
      providerThreadId: `thread-${label}`, title: label, preset: "fable-max", fastEnabled: false,
      state: active ? "active" : "idle", ...(active ? { activeTurnId: `turn-${label}` } : {}) });
    const policy = store.requirePeerSessionPolicy(session.id);
    if (policy.mode !== "coordinate") store.setPeerSessionPolicy({ sessionId: session.id, expectedRevision: policy.revision, mode: "coordinate" });
    return session;
  };
  const source = create("source", true), target = create("target", targetActive), spare = create("spare", true);
  const db = new Database(paths.database, { strict: true }); databases.push(db); db.exec("PRAGMA foreign_keys=ON");
  const request = (actor: SessionRecord, destination: SessionRecord, delivery: "send" | "steer" | "queue" = "steer", message = "peer message") => {
    const turn = store.requireSession(actor.id).activeTurnId;
    if (turn === undefined) throw new Error("Missing active fixture actor");
    const key = randomUUID();
    return { actorSessionId: actor.id, actorTurnId: turn, targetSessionId: destination.id,
      expectedTargetRevision: store.requireSession(destination.id).revision, delivery,
      requestDigest: hash(key), messageDigest: hash(message), reasonDigest: hash("reason"), idempotencyKey: key,
      ...(delivery === "queue" ? { message } : {}) };
  };
  const changeTurn = (session: SessionRecord, turn: string | null) => store.setSessionTurnState({ sessionId: session.id,
    expectedRevision: store.requireSession(session.id).revision, state: turn === null ? "idle" : "active",
    ...(turn === null ? {} : { activeTurnId: turn }) });
  const runtime = effectiveClaudeRuntimeProfileSchema.parse({ profileId: profile.id, processGeneration: authority.processGeneration,
    observedAt: 50_000, preset: "fable-max", model: "claude-fable-5-1", reasoningEffort: "max", claudeVersion: "2.1.260",
    permissionMode: "default", isolatedConfigDir: true, outputFormat: "stream-json", inputFormat: "stream-json" });
  return { store, db, paths, daemon, authority, source, target, spare, request, changeTurn, runtime };
}
async function abandoned(delivery: "send" | "steer" | "queue") {
  const f = await fixture(delivery === "steer");
  const request = f.request(f.source, f.target, delivery);
  const incoming = f.store.admitPeerSessionAction(request);
  const message = "peer message";
  let attemptId: string | undefined;
  let evidenceDigest: string;
  if (incoming.queue !== undefined) {
    const queue = incoming.queue;
    evidenceDigest = f.store.beginQueueEffect({ queueId: queue.id, sessionId: f.target.id,
      profileGeneration: f.authority.processGeneration, providerAuthority: f.authority, providerConnectionId: randomUUID(),
      evidence: { kind: "queue.dispatch", queueId: queue.id, sessionId: f.target.id, providerThreadId: "thread-target",
        profileGeneration: f.authority.processGeneration, baseline: { providerUpdatedAt: null, status: "idle", activeTurnId: null },
        clientMessageId: queue.id, messageDigest: hash(message), runtimeProfile: f.runtime } }).digest;
  } else {
    const kind = delivery === "send" ? "session.send" : "session.steer";
    const prepared = f.store.prepareSessionInputMutation({ kind, sessionId: f.target.id, message, attachments: [],
      idempotencyKey: request.idempotencyKey, providerAuthority: f.authority, ...f.daemon });
    attemptId = prepared.attempt.id;
    const common = { providerThreadId: "thread-target", clientMessageId: prepared.attempt.id,
      messageDigest: hash(message), messageActor: "peer_session" as const };
    evidenceDigest = f.store.beginSessionMutationEffect({ attemptId: prepared.attempt.id, sessionId: f.target.id,
      profileGeneration: f.authority.processGeneration, providerAuthority: f.authority, ...f.daemon,
      message, attachments: [], transcript: { accountId: f.authority.profileId, providerGeneration: f.authority.processGeneration,
        providerConnectionId: randomUUID(), actor: "peer_session", message },
      evidence: delivery === "send" ? { ...common, kind: "session.send", runtimeProfile: f.runtime,
        baseline: { providerUpdatedAt: null, status: "idle", activeTurnId: null } }
        : { ...common, kind: "session.steer", activeTurnId: "turn-target",
          baseline: { providerUpdatedAt: null, status: "active", activeTurnId: "turn-target" } } }).digest;
  }
  if (delivery !== "steer") f.changeTurn(f.target, "turn-target");
  const pending = f.store.admitPeerSessionAction(f.request(f.target, f.spare)).action;
  if (incoming.queue !== undefined) f.store.markQueueEffectAmbiguous(incoming.queue.id, evidenceDigest);
  else {
    if (attemptId === undefined) throw new Error("Missing direct source");
    f.store.transitionMutation(attemptId, "effect_started", "ambiguous"); f.store.quarantineSession(f.target.id);
    f.store.settlePeerSessionAction({ actionId: incoming.action.id, expectedState: "effect_started", state: "ambiguous" });
  }
  const id = incoming.queue?.id ?? attemptId;
  if (id === undefined) throw new Error("Missing effect identity");
  const resolutionTable = incoming.queue === undefined ? "mutation_resolutions" : "queue_effect_resolutions";
  const effectTable = incoming.queue === undefined ? "mutation_effect_evidence" : "queue_effect_evidence";
  const column = incoming.queue === undefined ? "attempt_id" : "queue_id";
  const resolve = (value: unknown = { action: "user_abandon", providerEffectRetried: false }, active = true) => {
    const provider = { providerThreadId: "thread-target", title: "Recovered target", status: active ? "active" as const : "idle" as const,
      ...(active ? { activeTurnId: "turn-target" } : {}) };
    if (incoming.queue !== undefined) return f.store.resolveQueueEffect({ queueId: incoming.queue.id,
      expectedEvidenceDigest: evidenceDigest, resolution: "abandoned", resolutionEvidence: value, provider });
    if (attemptId === undefined) throw new Error("Missing direct source");
    return f.store.resolveSessionMutation({ attemptId, expectedOriginalState: "ambiguous", expectedEvidenceDigest: evidenceDigest,
      resolution: "abandoned", resolutionEvidence: value, provider });
  };
  const resolution = () => z.object({ evidence_json: z.string() }).parse(f.db.query(`SELECT evidence_json FROM ${resolutionTable} WHERE ${column}=?`).get(id)).evidence_json;
  const rewrite = (json: string) => corrupt(f.db, [resolutionTable], () => f.db.query(`UPDATE ${resolutionTable} SET evidence_json=? WHERE ${column}=?`).run(json, id));
  const outgoing = () => f.store.admitPeerSessionAction(f.request(f.target, f.spare));
  return { ...f, incoming, pending, id, column, resolutionTable, effectTable, resolve, resolution, rewrite, outgoing };
}

describe("joined peer causal completeness", () => {
  test("candidate enumeration crosses the 16-row page before refusing absent selected evidence", async () => {
    const f = await fixture();
    for (let index = 0; index < 17; index += 1) {
      const message = `explicit human source ${index}`;
      const prepared = f.store.prepareSessionInputMutation({ kind: "session.send", sessionId: f.target.id,
        message, attachments: [], idempotencyKey: randomUUID(), providerAuthority: f.authority, ...f.daemon });
      const effect = f.store.beginSessionMutationEffect({ attemptId: prepared.attempt.id, sessionId: f.target.id,
        profileGeneration: f.authority.processGeneration, providerAuthority: f.authority, ...f.daemon,
        message, attachments: [], transcript: { accountId: f.authority.profileId,
          providerGeneration: f.authority.processGeneration, providerConnectionId: randomUUID(), actor: "human", message },
        evidence: { kind: "session.send", providerThreadId: "thread-target", clientMessageId: prepared.attempt.id,
          messageDigest: hash(message), messageActor: "human", runtimeProfile: f.runtime,
          baseline: { providerUpdatedAt: null, status: "idle", activeTurnId: null } } });
      f.store.transitionMutation(prepared.attempt.id, "effect_started", "ambiguous");
      f.store.quarantineSession(f.target.id);
      f.store.resolveSessionMutation({ attemptId: prepared.attempt.id, expectedOriginalState: "ambiguous",
        expectedEvidenceDigest: effect.digest, resolution: "abandoned",
        resolutionEvidence: { action: "user_abandon", providerEffectRetried: false },
        provider: { providerThreadId: "thread-target", title: "Target", status: "idle" } });
    }
    f.changeTurn(f.target, "turn-target");
    // Explicit selected nonpeer sources are not inferred peer ancestors.
    expect(f.store.admitPeerSessionAction(f.request(f.target, f.spare)).action.state).toBe("prepared");
    const rows = f.db.query<{ attempt_id: string }, []>("SELECT attempt_id FROM mutation_resolutions ORDER BY attempt_id").all();
    expect(rows).toHaveLength(17);
    const last = rows[16]; if (last === undefined) throw new Error("Missing second-page source");
    f.db.exec("PRAGMA foreign_keys=OFF");
    try { corrupt(f.db, ["mutation_effect_evidence"], () => {
      expect(f.db.query("DELETE FROM mutation_effect_evidence WHERE attempt_id=?").run(last.attempt_id).changes).toBe(1);
    }); } finally { f.db.exec("PRAGMA foreign_keys=ON"); }
    const before = snapshot(f.db);
    expect(() => f.store.admitPeerSessionAction(f.request(f.target, f.spare))).toThrow("PEER_SESSION_ACTOR_TURN_REFUSED");
    expect(snapshot(f.db)).toEqual(before);
  });

  test.each(["send", "steer", "queue"] as const)("%s abandonment fences the active turn and preadmitted direct begin", async (delivery) => {
    const f = await abandoned(delivery); f.resolve();
    expect(JSON.parse(f.resolution())).toEqual({ action: "user_abandon", providerEffectRetried: false,
      peerCausalFence: { version: 1, providerThreadId: "thread-target", activeTurnId: "turn-target" } });
    if (delivery === "queue") expect(f.store.requirePeerSessionAction(f.incoming.action.id).resultDigest).toBe(hash(f.resolution()));
    const before = snapshot(f.db);
    expect(f.outgoing).toThrow("PEER_SESSION_ACTOR_TURN_REFUSED");
    expect(() => f.store.beginPeerSessionActionEffect(f.pending.id)).toThrow("PEER_SESSION_ACTOR_TURN_REFUSED");
    expect(snapshot(f.db)).toEqual(before);
    f.changeTurn(f.target, "unrelated-new-turn");
    expect(f.outgoing().action.state).toBe("prepared");
  });

  test.each(["send", "queue"] as const)("%s rejects caller-owned undefined and toJSON marker smuggling before writes", async (delivery) => {
    const f = await abandoned(delivery); const before = snapshot(f.db);
    expect(() => f.resolve({ peerCausalFence: undefined })).toThrow("PEER_SESSION_CAUSAL_FENCE_RESERVED");
    let calls = 0;
    expect(() => f.resolve({ toJSON() { calls += 1; return { peerCausalFence: { version: 1, providerThreadId: "thread-target", activeTurnId: null } }; } }))
      .toThrow("PEER_SESSION_CAUSAL_FENCE_EVIDENCE_INVALID");
    expect(calls).toBe(0); expect(snapshot(f.db)).toEqual(before);
    f.resolve(); expect(f.outgoing).toThrow("PEER_SESSION_ACTOR_TURN_REFUSED");
  });

  test.each(["duplicate_outer", "duplicate_inner", "extra_key", "missing", "wrong_thread"] as const)(
    "a %s marker never becomes permission for a different turn", async (variant) => {
      const f = await abandoned("send"); f.resolve();
      const base = '{"action":"user_abandon","providerEffectRetried":false';
      const good = '{"version":1,"providerThreadId":"thread-target","activeTurnId":"turn-target"}';
      const json = variant === "duplicate_outer" ? `${base},"peerCausalFence":${good},"peerCausalFence":${good}}`
        : variant === "duplicate_inner" ? `${base},"peerCausalFence":${good.slice(0, -1)},"activeTurnId":null}}`
        : variant === "extra_key" ? `${base},"peerCausalFence":${good.slice(0, -1)},"extra":true}}`
        : variant === "wrong_thread" ? `${base},"peerCausalFence":${good.replace("thread-target", "other-thread")}}` : `${base}}`;
      f.rewrite(json); f.changeTurn(f.target, "unrelated-new-turn");
      const before = snapshot(f.db); expect(f.outgoing).toThrow("PEER_SESSION_ACTOR_TURN_REFUSED");
      expect(snapshot(f.db)).toEqual(before);
    },
  );

  test.each(["send", "queue"] as const)("missing %s evidence cannot disappear through the candidate join", async (delivery) => {
    const f = await abandoned(delivery); f.resolve(); f.changeTurn(f.target, "unrelated-new-turn");
    f.db.exec("PRAGMA foreign_keys=OFF");
    corrupt(f.db, [f.effectTable], () => f.db.query(`DELETE FROM ${f.effectTable} WHERE ${f.column}=?`).run(f.id));
    f.db.exec("PRAGMA foreign_keys=ON");
    const before = snapshot(f.db); expect(f.outgoing).toThrow("PEER_SESSION_ACTOR_TURN_REFUSED");
    expect(snapshot(f.db)).toEqual(before);
  });

  test("a valid opaque projection cannot hide behind a raw different-thread claim", async () => {
    const f = await abandoned("send"); f.resolve(); f.changeTurn(f.target, "unrelated-new-turn");
    const json = JSON.stringify({ kind: "session.send", providerThreadId: "other-thread", unknown: true });
    const proofTable = `${f.effectTable}_provenance`, anchorTable = `${proofTable}_anchors`;
    const retained = z.object({ parent_kind: z.string(), parent_authority_id: z.string(), parent_authority_generation_decimal: z.string(),
      evidence_kind: z.string(), recorded_at_decimal: z.string() }).passthrough().parse(f.db.query(`SELECT * FROM ${proofTable} WHERE attempt_id=?`).get(f.id));
    const meta = { row_id: f.id, parent_kind: retained.parent_kind, parent_authority_id: retained.parent_authority_id,
      parent_authority_generation_decimal: retained.parent_authority_generation_decimal, evidence_kind: retained.evidence_kind,
      stored_digest: hash(json), recorded_at_decimal: retained.recorded_at_decimal, raw_sha256: hash(json), raw_byte_length: Buffer.byteLength(json) };
    const digest = hash(JSON.stringify({ domain: "oompa:effect-evidence-provenance:v1", scope: "mutation", ...meta,
      format: "joined_v1", projection_json: null, opaque_reason: "invalid_shape" }));
    corrupt(f.db, [f.effectTable, proofTable, anchorTable], () => {
      f.db.query(`UPDATE ${f.effectTable} SET evidence_json=?,evidence_digest=? WHERE attempt_id=?`).run(json, hash(json), f.id);
      f.db.query(`UPDATE ${proofTable} SET stored_digest=?,raw_sha256=?,raw_byte_length=?,projection_json=NULL,opaque_reason='invalid_shape',provenance_digest=? WHERE attempt_id=?`)
        .run(hash(json), hash(json), Buffer.byteLength(json), digest, f.id);
      f.db.query(`UPDATE ${anchorTable} SET provenance_digest=? WHERE attempt_id=?`).run(digest, f.id);
    });
    expect(f.db.transaction(() => readMutationEffectEvidenceProvenance(f.db, f.id)).deferred())
      .toEqual({ kind: "opaque", format: "joined_v1", reason: "invalid_shape" });
    const before = snapshot(f.db); expect(f.outgoing).toThrow("PEER_SESSION_ACTOR_TURN_REFUSED");
    expect(snapshot(f.db)).toEqual(before);
  });

  test("explicit peer effect versus nonpeer transcript contradiction refuses despite a different-turn marker", async () => {
    const f = await abandoned("send"); f.resolve(); f.changeTurn(f.target, "unrelated-new-turn");
    corrupt(f.db, ["mutation_attempts"], () => f.db.query("UPDATE mutation_attempts SET transcript_intent_json=json_set(transcript_intent_json,'$.actor','human') WHERE id=?").run(f.id));
    const before = snapshot(f.db); expect(f.outgoing).toThrow("PEER_SESSION_ACTOR_TURN_REFUSED");
    expect(snapshot(f.db)).toEqual(before);
  });

  test("selected markerless steer excludes only its exact different target, while idle observation permits a later turn", async () => {
    const f = await abandoned("steer"); f.resolve(); f.rewrite('{"action":"user_abandon","providerEffectRetried":false}');
    expect(f.outgoing).toThrow("PEER_SESSION_ACTOR_TURN_REFUSED");
    f.changeTurn(f.target, "different-steer-target"); expect(f.outgoing().action.state).toBe("prepared");
    const g = await abandoned("queue"); g.resolve(undefined, false); g.changeTurn(g.target, "later-turn");
    expect(g.outgoing().action.state).toBe("prepared");
    expect(g.db.transaction(() => readQueueEffectEvidenceProvenance(g.db, g.id)).deferred().kind).toBe("parsed");
  });

  test("origin capacity is checked at admission and effect begin, while exact attached-origin replay remains inert", async () => {
    const f = await fixture(true);
    const begin = f.store.admitPeerSessionAction(f.request(f.source, f.target)).action;
    f.store.beginPeerSessionActionEffect(begin.id);
    const prepared = f.store.admitPeerSessionAction(f.request(f.source, f.target)).action;
    const accepted = [];
    for (let index = 0; index < PEER_SESSION_TURN_ORIGIN_LIMIT; index += 1) {
      const action = f.store.admitPeerSessionAction(f.request(f.source, f.target)).action;
      f.store.beginPeerSessionActionEffect(action.id);
      accepted.push(f.store.settlePeerSessionAction({ actionId: action.id, expectedState: "effect_started", state: "applied",
        targetTurnId: "turn-target", resultDigest: hash(`receipt${index}`) }));
    }
    const first = accepted[0]; if (first === undefined) throw new Error("Missing origin");
    const before = snapshot(f.db);
    expect(() => f.store.admitPeerSessionAction(f.request(f.source, f.target))).toThrow("PEER_SESSION_CAUSAL_LIMIT_REFUSED");
    expect(() => f.store.beginPeerSessionActionEffect(prepared.id)).toThrow("PEER_SESSION_CAUSAL_LIMIT_REFUSED");
    expect(() => f.store.settlePeerSessionAction({ actionId: begin.id, expectedState: "effect_started", state: "applied",
      targetTurnId: "turn-target", resultDigest: hash("too many") })).toThrow("peer session turn origin quota exceeded");
    expect(f.store.attachPeerSessionActionToTurn({ actionId: first.id, targetSessionId: f.target.id, turnId: "turn-target" })).toEqual(first);
    expect(snapshot(f.db)).toEqual(before);
  });
});
