import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { effectiveClaudeRuntimeProfileSchema } from "../domain/runtime-profile";
import { queueAttachmentRequestDigest } from "./queue-attachment-identity";
import { initializeStatePaths, resolveStatePaths } from "./paths";
import { StateStore, type StoredMessageAttachment } from "./state-store";

const stores: StateStore[] = [];
const databases: Database[] = [];
afterEach(() => {
  for (const database of databases.splice(0)) database.close(false);
  for (const store of stores.splice(0)) store.close();
});
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const quote = (value: string) => `"${value.replaceAll('"', '""')}"`;

// The fixture uses real authority/session/peer APIs. It is not an archived
// canonical peer producer and makes no migration or historical-byte claim.
async function fixture() {
  const home = await realpath(await mkdtemp(join(tmpdir(), "oompa-peer-queue-join-")));
  const paths = resolveStatePaths({ homeDirectory: home, platform: "darwin" });
  await initializeStatePaths(paths);
  let now = 10_000;
  const store = new StateStore(paths, { now: () => now++ });
  stores.push(store);
  const bootId = `boot_${"a".repeat(32)}`;
  const daemonGeneration = store.nextDaemonGeneration(bootId);
  const directory = join(home, "project");
  await mkdir(directory);
  const project = await store.createProject("Peer queue join", directory);
  const makeSession = (label: string, active: boolean) => {
    const profile = store.nextProfileGeneration(store.createProfile(label).id);
    expect(store.setProfileState(profile.id, profile.processGeneration, "signed_in", {
      email: `${label.toLowerCase()}@example.com`, plan: "Plus",
    })).toBe(true);
    let authority = store.requireProviderAccountAuthority(profile.id, "claude");
    for (let index = 0; index < 3; index += 1) {
      authority = store.advanceProviderAccountProcessGeneration({ profileId: profile.id,
        provider: "claude", expectedProcessGeneration: authority.processGeneration });
    }
    expect(authority.processGeneration).not.toBe(profile.processGeneration);
    const session = store.upsertProviderSession({
      profileId: profile.id, provider: "claude", providerAuthority: authority,
      providerAccountKey: `v1:claude:${hash(label)}`, projectId: project.id,
      providerThreadId: `thread-${label}`, title: label, preset: "fable-max", fastEnabled: false,
      state: active ? "active" : "idle", ...(active ? { activeTurnId: `turn-${label}` } : {}),
    });
    const policy = store.requirePeerSessionPolicy(session.id);
    if (policy.mode !== "coordinate") store.setPeerSessionPolicy({ sessionId: session.id,
      expectedRevision: policy.revision, mode: "coordinate" });
    return { profile, session, authority };
  };
  const actor = makeSession("Actor", true);
  const target = makeSession("Target", false);
  const database = new Database(paths.database, { strict: true });
  databases.push(database);
  database.exec("PRAGMA foreign_keys=ON");
  const snapshot = () => {
    const schema = database.query("SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name").all();
    const tables = database.query("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as { name: string }[];
    return { schema, tables: tables.map(({ name }) => ({ name,
      digest: hash(JSON.stringify(database.query(`SELECT * FROM ${quote(name)}`).all().map((row) => JSON.stringify(row)).sort())),
    })) };
  };
  const request = () => ({ actorSessionId: actor.session.id, actorTurnId: "turn-Actor",
    targetSessionId: target.session.id, expectedTargetRevision: target.session.revision,
    delivery: "queue" as const, requestDigest: hash("peer full request"),
    messageDigest: hash("peer body"), reasonDigest: hash("peer reason"), idempotencyKey: randomUUID(), message: "peer body" });
  const runtime = effectiveClaudeRuntimeProfileSchema.parse({
    claudeVersion: "2.1.260", inputFormat: "stream-json", isolatedConfigDir: true,
    model: "claude-fable-5-1", observedAt: 9_000, outputFormat: "stream-json",
    permissionMode: "default", preset: "fable-max", processGeneration: target.authority.processGeneration,
    profileId: target.profile.id, reasoningEffort: "max",
  });
  const begin = (queue: NonNullable<ReturnType<StateStore["admitPeerSessionAction"]>["queue"]>) => store.beginQueueEffect({
    queueId: queue.id, sessionId: target.session.id, profileGeneration: target.authority.processGeneration,
    providerAuthority: target.authority, providerConnectionId: randomUUID(), evidence: {
      kind: "queue.dispatch", queueId: queue.id, sessionId: target.session.id,
      providerThreadId: "thread-Target", profileGeneration: target.authority.processGeneration,
      baseline: { providerUpdatedAt: null, status: "idle", activeTurnId: null },
      clientMessageId: queue.id, messageDigest: hash(queue.message), runtimeProfile: runtime,
    },
  });
  return { store, database, actor, target, snapshot, request, begin, daemonGeneration, bootId };
}

describe("peer queue provider and attachment join", () => {
  test("atomically seals the original peer key, empty manifest, actor and exact divergent target tuple", async () => {
    const f = await fixture();
    const input = f.request();
    const admitted = f.store.admitPeerSessionAction(input);
    const queue = admitted.queue;
    if (queue === undefined) throw new Error("Expected peer queue.");
    expect(queue).toMatchObject({ messageActor: "peer_session", peerActionId: admitted.action.id, message: input.message });
    const mutation = f.store.readMutation(input.idempotencyKey);
    expect(mutation).toMatchObject({ kind: "session.queue", authorityId: f.target.session.id,
      authorityGeneration: f.target.authority.processGeneration, state: "applied", result: { queueId: queue.id },
      requestDigest: queueAttachmentRequestDigest({ sessionId: f.target.session.id,
        authorityGeneration: f.target.authority.processGeneration, message: input.message, attachments: [] }) });
    expect(f.store.readQueueProviderAuthority(queue.id)).toEqual(f.target.authority);
    expect(f.store.queueAttachmentManifest(queue.id)).toEqual([]);
    expect(f.store.readSessionUserMessageSource(f.target.session.id, "queue", queue.id)).toMatchObject({
      status: "pending", intent: { actor: "peer_session", providerGeneration: f.target.authority.processGeneration },
    });
    expect(admitted.action.visitedSessionIds).toEqual([f.actor.session.id, f.target.session.id].sort());
    expect(admitted.action.rootActionIds).toEqual([admitted.action.id]);
    const before = f.snapshot();
    expect(f.store.admitPeerSessionAction(input)).toMatchObject({ replay: true, queue: { id: queue.id } });
    expect(f.snapshot()).toEqual(before);
    expect(() => f.store.admitPeerSessionAction({ ...input, reasonDigest: hash("different reason") }))
      .toThrow("PEER_SESSION_IDEMPOTENCY_CONFLICT");
    expect(f.snapshot()).toEqual(before);
  });

  test.each(["queue_attachment_identities", "queue_attachment_identity_anchors"] as const)(
    "late %s insertion failure rolls back peer, causal, receipt, queue, transcript and sequence rows", async (table) => {
      const f = await fixture();
      f.database.exec(`CREATE TRIGGER test_peer_join_failure BEFORE INSERT ON ${table}
        BEGIN SELECT RAISE(ABORT,'TEST_PEER_SEAL_FAILURE'); END`);
      const before = f.snapshot();
      try {
        expect(() => f.store.admitPeerSessionAction(f.request())).toThrow("TEST_PEER_SEAL_FAILURE");
        expect(f.snapshot()).toEqual(before);
      } finally { f.database.exec("DROP TRIGGER test_peer_join_failure"); }
      expect(f.store.admitPeerSessionAction(f.request()).queue?.state).toBe("pending");
    },
  );

  test.each(["actor", "target"] as const)("new admission refuses a stale %s process without writes", async (side) => {
    const f = await fixture();
    const selected = f[side];
    f.store.advanceProviderAccountProcessGeneration({ profileId: selected.profile.id, provider: "claude",
      expectedProcessGeneration: selected.authority.processGeneration });
    const before = f.snapshot();
    expect(() => f.store.admitPeerSessionAction(f.request())).toThrow("SESSION_PROVIDER_AUTHORITY_STALE");
    expect(f.snapshot()).toEqual(before);
  });

  test.each(["actor", "target"] as const)("new admission refuses a mismatched %s binding without writes", async (side) => {
    const f = await fixture();
    const selected = f[side];
    const triggers = f.database.query("SELECT name,sql FROM sqlite_master WHERE type='trigger' AND tbl_name='provider_accounts' ORDER BY name")
      .all() as { name: string; sql: string }[];
    // Deliberately corrupt only the current account binding, then restore the
    // exact guards before exercising admission and taking the no-write oracle.
    f.database.transaction(() => {
      for (const trigger of triggers) f.database.exec(`DROP TRIGGER ${quote(trigger.name)}`);
      f.database.query("UPDATE provider_accounts SET binding_generation=binding_generation+1 WHERE id=?")
        .run(selected.authority.providerAccountId);
      for (const trigger of triggers) f.database.exec(trigger.sql);
    }).immediate();
    expect(f.database.query("SELECT binding_generation FROM provider_accounts WHERE id=?")
      .get(selected.authority.providerAccountId)).toEqual({ binding_generation: selected.authority.bindingGeneration + 1 });
    const before = f.snapshot();
    expect(() => f.store.admitPeerSessionAction(f.request())).toThrow("SESSION_PROVIDER_AUTHORITY_STALE");
    expect(f.snapshot()).toEqual(before);
  });

  test("an admitted queue retains actor policy authority after the actor turn and process end", async () => {
    const f = await fixture();
    const admitted = f.store.admitPeerSessionAction(f.request());
    if (admitted.queue === undefined) throw new Error("Expected peer queue.");
    f.store.setSessionTurnState({ sessionId: f.actor.session.id, expectedRevision: f.actor.session.revision, state: "idle" });
    f.store.advanceProviderAccountProcessGeneration({ profileId: f.actor.profile.id, provider: "claude",
      expectedProcessGeneration: f.actor.authority.processGeneration });
    expect(f.begin(admitted.queue).evidence.kind).toBe("queue.dispatch");
    expect(f.store.requirePeerSessionAction(admitted.action.id).state).toBe("effect_started");
  });

  test("an admitted queue cannot dispatch through a replaced target process", async () => {
    const f = await fixture();
    const admitted = f.store.admitPeerSessionAction(f.request());
    const queue = admitted.queue;
    if (queue === undefined) throw new Error("Expected peer queue.");
    f.store.advanceProviderAccountProcessGeneration({ profileId: f.target.profile.id, provider: "claude",
      expectedProcessGeneration: f.target.authority.processGeneration });
    const before = f.snapshot();
    expect(() => f.begin(queue)).toThrow("SESSION_PROVIDER_AUTHORITY_STALE");
    expect(f.store.readQueueProviderAuthority(queue.id)).toEqual(f.target.authority);
    expect(f.snapshot()).toEqual(before);
  });

  test("absent-input cancellation retains only control-plane authority after its Claude process expires", async () => {
    const f = await fixture();
    const { message, ...request } = f.request();
    expect(hash(message)).toBe(request.messageDigest);
    const admitted = f.store.admitPeerSessionAction({ ...request, delivery: "send" });
    f.store.advanceProviderAccountProcessGeneration({ profileId: f.target.profile.id, provider: "claude",
      expectedProcessGeneration: f.target.authority.processGeneration });
    expect(f.store.cancelUnstartedPeerSessionDirectAction({ actionId: admitted.action.id,
      diagnosticCode: "PEER_SESSION_TARGET_STATE_REFUSED" }).state).toBe("cancelled");
    expect(f.store.readMutation(request.idempotencyKey)).toMatchObject({ kind: "peer.session.cancel", state: "cancelled",
      authorityGeneration: 0 });
  });

  test("generic enqueue refuses peer provenance and retains automation transcript and actor replay identity", async () => {
    const f = await fixture();
    const input = { sessionId: f.target.session.id, profileGeneration: f.target.authority.processGeneration,
      providerAuthority: f.target.authority, message: "ordinary queue", idempotencyKey: randomUUID() };
    const before = f.snapshot();
    expect(() => f.store.enqueueIdempotent({ ...input, actor: "peer_session" })).toThrow("QUEUE_ATTACHMENT_REQUEST_CONFLICT");
    expect(f.snapshot()).toEqual(before);
    const providerConnectionId = randomUUID();
    const queued = f.store.enqueueIdempotent({ ...input, actor: "automation", providerConnectionId });
    expect(f.store.readSessionUserMessageSource(f.target.session.id, "queue", queued.id)).toMatchObject({
      status: "pending", intent: { actor: "automation", providerConnectionId },
    });
    expect(f.store.readMutation(input.idempotencyKey)?.result).toEqual({ queueId: queued.id });
    const settled = f.snapshot();
    expect(f.store.enqueueIdempotent({ ...input, actor: "automation" }).id).toBe(queued.id);
    expect(() => f.store.enqueueIdempotent({ ...input, actor: "human" })).toThrow("QUEUE_ATTACHMENT_REQUEST_CONFLICT");
    expect(f.snapshot()).toEqual(settled);
  });

  test("original attachment references are sealed independently of prepared metadata and mismatches roll back", async () => {
    const f = await fixture();
    const reference = { digest: hash("attachment"), byteLength: 10, name: "original.md", mediaType: "text/markdown" as const };
    const metadata: StoredMessageAttachment = { ...reference, canonicalMediaType: "text/plain" };
    const input = { sessionId: f.target.session.id, profileGeneration: f.target.authority.processGeneration,
      providerAuthority: f.target.authority, message: "with attachment", idempotencyKey: randomUUID(), attachments: [reference] };
    const reservation = f.store.reserveAttachmentIngress({ kind: "session.queue", sessionId: input.sessionId,
      providerAuthority: input.providerAuthority, message: input.message, idempotencyKey: input.idempotencyKey,
      attachments: input.attachments,
      daemonGeneration: f.daemonGeneration, bootId: f.bootId });
    if (reservation.kind !== "reserved") throw new Error("Expected attachment reservation.");
    const attachmentReservation = { reservationId: reservation.reservationId, reservationDigest: reservation.reservationDigest,
      daemonGeneration: f.daemonGeneration, bootId: f.bootId };
    const before = f.snapshot();
    expect(() => f.store.enqueueIdempotent({ ...input, attachmentReservation,
      storedAttachments: [{ ...metadata, name: "normalized.txt" }] })).toThrow("SESSION_USER_MESSAGE_ATTACHMENT_INTENT_MISMATCH");
    expect(f.snapshot()).toEqual(before);
    const queue = f.store.enqueueIdempotent({ ...input, attachmentReservation, storedAttachments: [metadata] });
    expect(f.store.queueAttachmentManifest(queue.id)).toEqual([reference]);
    expect(f.store.readMutation(input.idempotencyKey)?.requestDigest).toBe(queueAttachmentRequestDigest({
      sessionId: input.sessionId, authorityGeneration: input.profileGeneration, message: input.message, attachments: input.attachments,
    }));
  });
});
