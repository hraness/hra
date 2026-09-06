import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { attachmentDigest } from "./attachment-store";
import { initializeStatePaths, resolveStatePaths } from "./paths";
import { MESSAGE_ATTACHMENT_SOURCE_PER_SESSION_CAP, StateStore, type StoredMessageAttachment } from "./state-store";

const stores: StateStore[] = [];
const databases: Database[] = [];
afterEach(() => {
  for (const database of databases.splice(0)) database.close(false);
  for (const store of stores.splice(0)) store.close();
});

function attachment(name: string, body: string): StoredMessageAttachment {
  const bytes = new TextEncoder().encode(body);
  return { digest: attachmentDigest(bytes), name, byteLength: bytes.byteLength,
    canonicalMediaType: "text/plain", mediaType: "text/plain" };
}

function manifest(attachments: readonly StoredMessageAttachment[]) {
  return attachments.map(({ digest, name, mediaType, byteLength }) => ({ digest, name, mediaType, byteLength }));
}

async function fixture() {
  const home = await realpath(await mkdtemp(join(tmpdir(), "hra-queue-attachment-identity-")));
  const paths = resolveStatePaths({ homeDirectory: home, platform: "darwin" });
  await initializeStatePaths(paths);
  const clock = { now: 1_800_000_000_000 };
  const store = new StateStore(paths, { now: () => clock.now });
  stores.push(store);
  store.nextDaemonGeneration(`boot_${randomUUID().replaceAll("-", "")}`);
  const profile = store.nextProfileGeneration(store.createProfile("Queue attachments").id);
  expect(store.setProfileState(profile.id, profile.processGeneration, "signed_in", {
    email: "queue@example.com", plan: "Plus",
  })).toBe(true);
  const created = store.createSession({ profileId: profile.id, provider: "codex", preset: "high", fastEnabled: false });
  const session = store.bindSession({ sessionId: created.id, expectedRevision: created.revision,
    providerThreadId: "queue-attachment-thread", state: "idle" });
  const authority = store.requireProviderAccountAuthority(profile.id, "codex");
  const database = new Database(paths.database, { strict: true });
  databases.push(database);
  database.exec("PRAGMA foreign_keys=ON");
  const admit = (attachments: readonly StoredMessageAttachment[] | undefined, idempotencyKey: string = randomUUID()) => {
    const input = { sessionId: session.id, profileGeneration: authority.processGeneration,
      providerAuthority: authority, message: "The exact queued human request.", idempotencyKey,
      ...(attachments === undefined ? {} : { attachments }) };
    return store.enqueueIdempotent(input);
  };
  const enqueue = (attachments: readonly StoredMessageAttachment[], idempotencyKey: string = randomUUID()) => {
    const queued = admit(attachments, idempotencyKey);
    // Exercise the existing daemon's follow-up manifest writer too: once queue
    // admission is atomic, this may only be an exact, inert replay.
    store.recordMessageAttachments({ sessionId: session.id, sourceId: queued.id, attachments });
    return queued;
  };
  const replay = (idempotencyKey: string, attachments: readonly StoredMessageAttachment[]) =>
    store.readQueueEnqueueReplay({ idempotencyKey, sessionId: session.id,
      message: "The exact queued human request.", attachments: manifest(attachments) });
  return { store, database, clock, session, authority, admit, enqueue, replay };
}

describe("queue attachment identity boundaries", () => {
  test("generic queue mutation preparation cannot manufacture a legacy receipt outside atomic admission", async () => {
    const { store, database, authority, session, admit, replay } = await fixture();
    const key = randomUUID();
    expect(() => store.prepareMutation({
      kind: "session.queue", authorityId: session.id, authorityGeneration: authority.processGeneration,
      request: { message: "The exact queued human request." }, idempotencyKey: key,
      providerAuthorities: [{ role: "primary", authority, provenance: "session_queue" }],
    })).toThrow("QUEUE_ATTACHMENT_REQUEST_CONFLICT");
    expect(database.query("SELECT id FROM mutation_attempts WHERE idempotency_key=?").get(key)).toBeNull();
    expect(store.listQueue(session.id)).toEqual([]);
    const queued = admit([], key);
    expect(replay(key, [])).toEqual({ queued, verification: "sealed" });
  });

  test("same-key retry cannot append another attachment to the accepted queue", async () => {
    const { store, database, session, enqueue } = await fixture();
    const key = randomUUID();
    const first = attachment("first.txt", "first");
    const extra = attachment("extra.txt", "extra");
    const queued = enqueue([first], key);
    const original = database.query("SELECT * FROM mutation_attempts WHERE idempotency_key=?").get(key);
    expect(() => enqueue([first, extra], key)).toThrow();
    expect(store.messageAttachmentManifest(session.id, queued.id)).toEqual(manifest([first]));
    expect(store.attachmentCustody(extra.digest)).toBeNull();
    expect(store.listQueue(session.id)).toHaveLength(1);
    expect(database.query("SELECT * FROM mutation_attempts WHERE idempotency_key=?").get(key)).toEqual(original);
  });

  test("manifest insertion failure rolls back queue, mutation, accounting and reference admission", async () => {
    const { store, database, session, enqueue } = await fixture();
    const key = randomUUID();
    const first = attachment("first.txt", "first");
    const sequence = database.query("SELECT * FROM queue_sequence_authority").get();
    database.exec(`CREATE TRIGGER test_queue_manifest_failure BEFORE INSERT ON message_attachments
      BEGIN SELECT RAISE(ABORT, 'injected queue manifest failure'); END`);
    expect(() => enqueue([first], key)).toThrow("injected queue manifest failure");
    expect(store.listQueue(session.id)).toEqual([]);
    expect(database.query("SELECT id FROM mutation_attempts WHERE idempotency_key=?").get(key)).toBeNull();
    expect(database.query("SELECT * FROM queue_sequence_authority").get()).toEqual(sequence);
    expect(store.attachmentCustody(first.digest)).toBeNull();
    expect(database.query("SELECT * FROM queue_provider_authorities").all()).toEqual([]);
  });

  test("pending queue retains its original attachment past the ordinary projection source cap", async () => {
    const { store, clock, session, enqueue } = await fixture();
    const first = attachment("pending.txt", "pending queue bytes");
    const queued = enqueue([first]);
    for (let index = 0; index <= MESSAGE_ATTACHMENT_SOURCE_PER_SESSION_CAP; index += 1) {
      clock.now += 1;
      store.recordMessageAttachments({ sessionId: session.id, sourceId: `attempt_projection_${String(index)}`,
        attachments: [attachment("later.txt", `later ${String(index)}`)] });
    }
    expect(store.requireQueue(queued.id).state).toBe("pending");
    expect(store.messageAttachmentManifest(session.id, queued.id)).toEqual(manifest([first]));
    expect(store.attachmentCustody(first.digest)?.referenceCount).toBe(1);
    expect(store.listUnreferencedAttachments().map((entry) => entry.digest)).not.toContain(first.digest);
    expect(store.forgetAttachment(first.digest)).toBe(false);
  });

  const first = attachment("first.txt", "first");
  const second = attachment("second.txt", "second");
  const changedRequests: readonly [string, readonly StoredMessageAttachment[]][] = [
    ["order", [second, first]],
    ["name", [{ ...first, name: "renamed.txt" }, second]],
    ["declared media type", [{ ...first, mediaType: "text/markdown" }, second]],
    ["digest", [attachment("first.txt", "different bytes"), second]],
    ["byte length", [{ ...first, byteLength: first.byteLength + 1 }, second]],
    ["omitted suffix", [first]],
    ["empty replacement", []],
  ];
  test.each(changedRequests)("same-key changed %s conflicts at both admission and legacy manifest writer", async (...[, changed]) => {
    const { store, database, session, enqueue, replay } = await fixture();
    const key = randomUUID();
    const queued = enqueue([first, second], key);
    const original = database.query("SELECT * FROM mutation_attempts WHERE idempotency_key=?").get(key);
    expect(() => enqueue(changed, key)).toThrow("QUEUE_ATTACHMENT_REQUEST_CONFLICT");
    expect(() => replay(key, changed)).toThrow("QUEUE_ATTACHMENT_REQUEST_CONFLICT");
    expect(() => store.recordMessageAttachments({ sessionId: session.id, sourceId: queued.id, attachments: changed }))
      .toThrow("QUEUE_ATTACHMENT_REQUEST_CONFLICT");
    expect(store.messageAttachmentManifest(session.id, queued.id)).toEqual(manifest([first, second]));
    expect(store.listQueue(session.id)).toEqual([queued]);
    expect(store.attachmentCustody(first.digest)?.referenceCount).toBe(1);
    expect(store.attachmentCustody(second.digest)?.referenceCount).toBe(1);
    expect(database.query("SELECT * FROM mutation_attempts WHERE idempotency_key=?").get(key)).toEqual(original);
  });

  test("new empty identity is proved, replayable, and cannot acquire later attachments", async () => {
    const { store, database, session, admit, replay } = await fixture();
    const key = randomUUID();
    const queued = admit(undefined, key);
    expect(admit([], key)).toEqual(queued);
    expect(replay(key, [])).toEqual({ queued, verification: "sealed" });
    expect(store.messageAttachmentManifest(session.id, queued.id)).toEqual([]);
    expect(() => admit([first], key)).toThrow("QUEUE_ATTACHMENT_REQUEST_CONFLICT");
    expect(() => store.recordMessageAttachments({ sessionId: session.id, sourceId: queued.id, attachments: [first] }))
      .toThrow("QUEUE_ATTACHMENT_REQUEST_CONFLICT");
    expect(store.attachmentCustody(first.digest)).toBeNull();
    expect(database.query("SELECT * FROM message_attachments").all()).toEqual([]);
  });

  test("sealed replay remains historical after body scrub, manifest pruning, accounting deletion and provider retirement", async () => {
    const { store, database, clock, authority, session, admit, replay } = await fixture();
    const key = randomUUID();
    const queued = admit([first, second], key);
    const original = database.query("SELECT * FROM mutation_attempts WHERE idempotency_key=?").get(key);
    expect(store.transitionQueue(queued.id, "pending", "cancelled")).toBe(true);
    const cancelled = store.requireQueue(queued.id);
    expect(cancelled.message).toBe("[queue message removed after settlement]");
    for (let index = 0; index < MESSAGE_ATTACHMENT_SOURCE_PER_SESSION_CAP; index += 1) {
      clock.now += 1;
      store.recordMessageAttachments({ sessionId: session.id, sourceId: `attempt_terminal_later_${String(index)}`,
        attachments: [attachment("later.txt", `terminal later ${String(index)}`)] });
    }
    expect(store.messageAttachmentManifest(session.id, queued.id)).toEqual([]);
    expect(store.forgetAttachment(first.digest)).toBe(true);
    expect(store.forgetAttachment(second.digest)).toBe(true);
    store.nextProfileGeneration(authority.profileId);
    expect(replay(key, [first, second])).toEqual({ queued: cancelled, verification: "sealed" });
    expect(() => replay(key, [second, first])).toThrow("QUEUE_ATTACHMENT_REQUEST_CONFLICT");
    expect(store.requireQueue(queued.id)).toEqual(cancelled);
    expect(store.messageAttachmentManifest(session.id, queued.id)).toEqual([]);
    expect(store.attachmentCustody(first.digest)).toBeNull();
    expect(store.attachmentCustody(second.digest)).toBeNull();
    expect(database.query("SELECT * FROM mutation_attempts WHERE idempotency_key=?").get(key)).toEqual(original);
  });

  test("a second manifest writer cannot append even a separately accounted digest to a sealed queue", async () => {
    const { store, database, session, admit } = await fixture();
    const queued = admit([first]);
    store.recordMessageAttachments({ sessionId: session.id, sourceId: "attempt_other", attachments: [second] });
    expect(() => database.query(`INSERT INTO message_attachments
      (session_id,source_id,position,digest,name,media_type,byte_length,created_at) VALUES (?,?,?,?,?,?,?,?)`)
      .run(session.id, queued.id, 1, second.digest, second.name, second.mediaType, second.byteLength, queued.createdAt))
      .toThrow();
    expect(store.messageAttachmentManifest(session.id, queued.id)).toEqual(manifest([first]));
    expect(store.attachmentCustody(second.digest)?.referenceCount).toBe(1);
  });

  test.each(["canonical media type", "byte length"] as const)("digest accounting collision on %s cannot authorize a different queue", async (field) => {
    const { store, database, session, admit } = await fixture();
    const original = admit([first]);
    const key = randomUUID();
    const collision: StoredMessageAttachment = field === "canonical media type"
      ? { ...first, canonicalMediaType: "image/png", mediaType: "image/png" }
      : { ...first, byteLength: first.byteLength + 1 };
    expect(() => admit([collision], key)).toThrow();
    expect(store.listQueue(session.id)).toEqual([original]);
    expect(store.messageAttachmentManifest(session.id, original.id)).toEqual(manifest([first]));
    expect(store.attachmentCustody(first.digest)).toEqual({ digest: first.digest, byteLength: first.byteLength,
      canonicalMediaType: "text/plain", referenceCount: 1 });
    expect(database.query("SELECT id FROM mutation_attempts WHERE idempotency_key=?").get(key)).toBeNull();
  });

  test("one content digest may have two ordered presentations without conflating identity", async () => {
    const { store, session, admit, replay } = await fixture();
    const key = randomUUID();
    const alternate: StoredMessageAttachment = { ...first, name: "notes.md", mediaType: "text/markdown" };
    const queued = admit([first, alternate], key);
    expect(store.messageAttachmentManifest(session.id, queued.id)).toEqual(manifest([first, alternate]));
    expect(store.attachmentCustody(first.digest)?.referenceCount).toBe(2);
    expect(replay(key, [first, alternate])).toEqual({ queued, verification: "sealed" });
    expect(() => replay(key, [alternate, first])).toThrow("QUEUE_ATTACHMENT_REQUEST_CONFLICT");
  });

  test("attached pending cap is independent of display history and permits capacity recovery without key consumption", async () => {
    const { store, database, clock, session, admit } = await fixture();
    const pending = Array.from({ length: 200 }, () => admit([first]));
    const oldest = pending[0];
    if (oldest === undefined) throw new Error("Missing pending queue fixture.");
    for (let index = 0; index < MESSAGE_ATTACHMENT_SOURCE_PER_SESSION_CAP; index += 1) {
      clock.now += 1;
      store.recordMessageAttachments({ sessionId: session.id, sourceId: `attempt_later_${String(index)}`, attachments: [second] });
    }
    expect(store.messageAttachmentManifest(session.id, oldest.id)).toEqual(manifest([first]));
    expect(store.attachmentCustody(first.digest)?.referenceCount).toBe(200);
    const key = randomUUID();
    expect(() => admit([first], key)).toThrow("QUEUE_ATTACHMENT_LIMIT");
    expect(database.query("SELECT id FROM mutation_attempts WHERE idempotency_key=?").get(key)).toBeNull();
    expect(admit([]).state).toBe("pending");
    expect(store.transitionQueue(oldest.id, "pending", "cancelled")).toBe(true);
    const admittedAfterRelease = admit([first], key);
    expect(admittedAfterRelease.state).toBe("pending");
    expect(store.messageAttachmentManifest(session.id, admittedAfterRelease.id)).toEqual(manifest([first]));
    for (const queued of pending.slice(1)) {
      expect(store.requireQueue(queued.id).state).toBe("pending");
      expect(store.messageAttachmentManifest(session.id, queued.id)).toEqual(manifest([first]));
    }
  });
});
