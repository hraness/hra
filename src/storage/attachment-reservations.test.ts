import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdtemp, realpath, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { canonical40QueuesDatabaseBytes, canonical40QueuesFixture } from "../../scripts/fixtures/canonical40-queues";
import { AttachmentBlobStore, type AttachmentCleanupPort } from "./attachment-store";
import { initializeStatePaths, resolveStatePaths } from "./paths";
import { MESSAGE_ATTACHMENT_SOURCE_PER_SESSION_CAP, StateStore, type StoredMessageAttachment } from "./state-store";

const roots: string[] = [];
const stores: StateStore[] = [];
const databases: Database[] = [];

afterEach(async () => {
  for (const database of databases.splice(0)) database.close(false);
  for (const store of stores.splice(0)) store.close();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

type CleanupHook = (...args: Parameters<AttachmentCleanupPort["unlinkCleanupCandidateSync"]>) => void;

function databaseSnapshot(database: Database) {
  return {
    schema: database.query("SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name").all(),
    tables: database.query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all()
      .map(({ name }) => ({ name, rows: database.query(`SELECT * FROM "${name.replaceAll('"', '""')}"`).all() })),
  };
}

async function fixture(hook?: CleanupHook, legacyKind?: "session.send" | "session.steer") {
  const home = await realpath(await mkdtemp(join(tmpdir(), "hra-attachment-reservations-")));
  roots.push(home);
  const paths = resolveStatePaths({ homeDirectory: home, platform: "darwin" });
  await initializeStatePaths(paths);
  if (legacyKind !== undefined) {
    await writeFile(paths.database, canonical40QueuesDatabaseBytes());
    await chmod(paths.database, 0o600);
  }
  const clock = { now: legacyKind === undefined ? 1_800_000_000_000 : 1_900_000_001_000 };
  const blobs = AttachmentBlobStore.forStatePaths(paths);
  const cleanupCalls: Parameters<AttachmentCleanupPort["unlinkCleanupCandidateSync"]>[] = [];
  // Fixed at construction: a candidate never supplies executable cleanup code.
  const attachmentCleanupPort: AttachmentCleanupPort = {
    unlinkCleanupCandidateSync(candidate, options) {
      cleanupCalls.push([candidate, options]);
      hook?.(candidate, options);
      return blobs.unlinkCleanupCandidateSync(candidate, options);
    },
  };
  const store = new StateStore(paths, { now: () => clock.now, attachmentCleanupPort });
  stores.push(store);
  const bootId = legacyKind === undefined ? `boot_${randomUUID().replaceAll("-", "")}` : canonical40QueuesFixture.bootId;
  const daemonGeneration = legacyKind === undefined ? store.nextDaemonGeneration(bootId) : canonical40QueuesFixture.daemonGeneration;
  const daemon = { daemonGeneration, bootId };
  const historical = legacyKind === undefined ? undefined : canonical40QueuesFixture.sessionInputs.find((entry) => entry.kind === legacyKind);
  if (legacyKind !== undefined && historical === undefined) throw new Error("Missing archived input fixture.");
  const profile = historical === undefined ? store.nextProfileGeneration(store.createProfile("Attachment reservations").id)
    : store.requireProfileById(canonical40QueuesFixture.profileId);
  if (historical === undefined) expect(store.setProfileState(profile.id, profile.processGeneration, "signed_in", {
    email: "attachments@example.com", plan: "Plus",
  })).toBe(true);
  const authority = store.requireProviderAccountAuthority(profile.id, "codex");
  const session = (() => {
    if (historical !== undefined) return store.requireSession(historical.sessionId);
    const imported = store.upsertProviderSession({ profileId: profile.id, provider: "codex",
      providerAuthority: authority, providerAccountKey: `v1:codex:${createHash("sha256").update("attachments@example.com").digest("hex")}`,
      title: "Attachment reservations", preset: "high", fastEnabled: false, providerThreadId: "attachment-reservation-thread", state: "idle" });
    return store.updateSessionMetadata({ sessionId: imported.id, expectedRevision: imported.revision, preset: "high" });
  })();
  if (historical !== undefined) {
    // The archive carries both kinds. Canonically cancel the unrelated one so
    // this test's terminal cleanup oracle depends only on its own old request.
    for (const entry of canonical40QueuesFixture.sessionInputs) if (entry.kind !== historical.kind) {
      expect(store.transitionMutation(entry.attemptId, "prepared", "cancelled")).toBe(true);
    }
  }
  const other = new StateStore(paths, { now: () => clock.now });
  stores.push(other);
  const database = new Database(paths.database, { strict: true });
  databases.push(database);
  database.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=0");
  const put = async (body = "Original attachment bytes.", name = "notes.txt") => {
    const bytes = new TextEncoder().encode(body);
    const result = await blobs.put("text/plain", bytes);
    if (result.kind !== "stored") throw new Error("Expected a valid stored attachment");
    const stored = result.value;
    await utimes(stored.path, new Date(1_000), new Date(1_000));
    const attachment: StoredMessageAttachment = { digest: stored.digest, byteLength: stored.byteLength,
      canonicalMediaType: "text/plain", mediaType: "text/plain", name };
    const candidate = { kind: "blob" as const, digest: stored.digest, canonicalMediaType: "text/plain" as const };
    return { bytes, stored, attachment, candidate };
  };
  const input = (attachments: readonly StoredMessageAttachment[], idempotencyKey: string = randomUUID(),
    kind: "session.send" | "session.steer" | "session.queue" = "session.send") => ({
    kind, sessionId: session.id, idempotencyKey, message: "The exact human request.",
    attachments: attachments.map(({ digest, name, mediaType, byteLength }) => ({ digest, name, mediaType, byteLength })),
    providerAuthority: authority, ...daemon,
  });
  const reserve = (attachments: readonly StoredMessageAttachment[], idempotencyKey: string = randomUUID(),
    target = store, kind: "session.send" | "session.steer" | "session.queue" = "session.send") => {
    const reserved = target.reserveAttachmentIngress(input(attachments, idempotencyKey, kind));
    if (reserved.kind !== "reserved") throw new Error("Expected nonempty retention custody");
    return { reservationId: reserved.reservationId, reservationDigest: reserved.reservationDigest };
  };
  const release = (reservation: ReturnType<typeof reserve>, target = store) =>
    target.releaseAttachmentIngress({ ...reservation, ...daemon });
  const cleanup = (candidate: Parameters<AttachmentCleanupPort["unlinkCleanupCandidateSync"]>[0]) =>
    store.cleanupAttachmentCandidate({ candidate, ...daemon });
  const prepare = (attachments: readonly StoredMessageAttachment[], key: string,
    reservation?: ReturnType<typeof reserve>, target = store) => target.prepareSessionInputMutation({
    ...input(attachments, key), kind: "session.send", ...(reservation === undefined ? {} : { reservation }),
  });
  const beginInput = (prepared: ReturnType<typeof prepare>, attachments: readonly StoredMessageAttachment[]) => ({
    attemptId: prepared.attempt.id, sessionId: session.id, profileGeneration: authority.processGeneration,
    providerAuthority: authority, ...daemon, attachments,
    message: "The exact human request.",
    transcript: { accountId: authority.profileId, providerGeneration: authority.processGeneration,
      providerConnectionId: "48000000-0000-4000-8000-000000000001", actor: "human" as const,
      message: "The exact human request." },
    ...(prepared.custody.kind === "empty" ? {} : { custody: {
      custodyId: prepared.custody.custodyId, custodyDigest: prepared.custody.custodyDigest,
    } }),
    evidence: { kind: "session.send" as const, providerThreadId: "attachment-reservation-thread",
      baseline: { providerUpdatedAt: null, activeTurnId: null, status: "idle" as const },
      clientMessageId: prepared.attempt.id,
      messageDigest: createHash("sha256").update("The exact human request.").digest("hex") },
  });
  return { paths, store, other, database, clock, blobs, daemon, session, authority, cleanupCalls, attachmentCleanupPort,
    put, input, reserve, release, cleanup, prepare, beginInput, historical };
}

describe("attachment reservations across storage and filesystem custody", () => {
  test("a second writer's reservation wins before cleanup even for an old unaccounted blob", async () => {
    const value = await fixture();
    const blob = await value.put();
    const candidate = (await value.blobs.listCleanupCandidates()).candidates[0];
    expect(candidate).toEqual(blob.candidate);
    const key = randomUUID();
    const reservation = value.reserve([blob.attachment], key, value.other);
    expect(value.store.attachmentCustody(blob.attachment.digest)).toBeNull();
    expect(value.cleanup(blob.candidate).kind).toBe("retained");
    expect(value.cleanupCalls).toEqual([]);
    expect(await value.blobs.read(blob.attachment.digest, "text/plain")).toEqual(blob.bytes);
    expect(value.release(reservation, value.other).released).toBe(true);
    expect(value.cleanup(blob.candidate)).toEqual({ kind: "deleted" });
    expect(await value.blobs.has(blob.attachment.digest, "text/plain")).toBe(false);
  });

  test("cleanup holds the SQLite writer through synchronous unlink and a later reservation cannot restore missing bytes", async () => {
    const observed: { database?: Database; busy: boolean[] } = { busy: [] };
    const value = await fixture(() => {
      if (observed.database === undefined) throw new Error("Writer probe was not initialized");
      try {
        observed.database.exec("BEGIN IMMEDIATE");
        observed.database.exec("ROLLBACK");
        observed.busy.push(false);
      } catch (error) {
        if (!(error instanceof Error) || !error.message.includes("database is locked")) throw error;
        observed.busy.push(true);
      }
    });
    observed.database = value.database;
    const blob = await value.put();
    expect(value.cleanup(blob.candidate)).toEqual({ kind: "deleted" });
    expect(observed.busy).toEqual([true]);
    const key = randomUUID();
    const reservation = value.reserve([blob.attachment], key, value.other);
    // Reservation is retention, not byte verification or provider permission.
    await expect(value.blobs.read(blob.attachment.digest, "text/plain")).rejects.toThrow();
    expect(value.store.readMutation(key)).toBeNull();
    expect(value.store.listQueue(value.session.id)).toEqual([]);
    expect(value.release(reservation, value.other).released).toBe(true);
    expect(value.cleanup(blob.candidate)).toEqual({ kind: "absent" });
  });

  test("the deletion boundary rechecks current age rather than the earlier enumeration hint", async () => {
    const value = await fixture();
    const blob = await value.put();
    expect((await value.blobs.listCleanupCandidates()).candidates).toEqual([blob.candidate]);
    await utimes(blob.stored.path, new Date(value.clock.now), new Date(value.clock.now));
    expect(value.cleanup(blob.candidate)).toEqual({ kind: "retained", reason: "young" });
    expect(await value.blobs.read(blob.attachment.digest, "text/plain")).toEqual(blob.bytes);
    await utimes(blob.stored.path, new Date(1_000), new Date(1_000));
    expect(value.cleanup(blob.candidate)).toEqual({ kind: "deleted" });
  });

  test("same-key concurrent invocations have independent holds and one release cannot dispose the other", async () => {
    const value = await fixture();
    const blob = await value.put();
    const key = randomUUID();
    const first = value.reserve([blob.attachment], key);
    const second = value.reserve([blob.attachment], key, value.other);
    expect(second.reservationId).not.toBe(first.reservationId);
    expect(value.release(first)).toEqual({ released: true, reason: "released" });
    expect(value.release(first)).toEqual({ released: false, reason: "already_released" });
    expect(value.cleanup(blob.candidate).kind).toBe("retained");
    expect(value.cleanupCalls).toHaveLength(0);
    expect(value.release(second, value.other).released).toBe(true);
    expect(value.cleanup(blob.candidate)).toEqual({ kind: "deleted" });
  });

  test("a pre-effect failure leaves the first mutation-owned hold for exact prepared retry", async () => {
    const value = await fixture();
    const blob = await value.put();
    const key = randomUUID();
    const first = value.reserve([blob.attachment], key);
    const original = value.prepare([blob.attachment], key, first);
    expect(original.attempt).toMatchObject({ state: "prepared", replay: false });
    expect(original.custody.kind).toBe("mutation_owned");
    const immutableAttempt = value.store.readMutation(key);
    // A runtime review failure happens before begin. Ordinary finally cleanup
    // may not release a hold already transferred to the durable mutation.
    expect(value.release(first)).toEqual({ released: false, reason: "mutation_owned" });
    expect(value.cleanup(blob.candidate).kind).toBe("retained");
    const redundant = value.reserve([blob.attachment], key, value.other);
    const replay = value.prepare([blob.attachment], key, redundant, value.other);
    expect(replay.attempt).toMatchObject({ id: original.attempt.id, state: "prepared", replay: true });
    expect(replay.custody).toEqual(original.custody);
    expect(value.release(redundant, value.other)).toEqual({ released: false, reason: "already_released" });
    expect(value.store.readMutation(key)).toEqual(immutableAttempt);
    expect(value.store.messageAttachmentManifest(value.session.id, original.attempt.id)).toEqual([]);
    expect(value.cleanup(blob.candidate).kind).toBe("retained");
    expect(value.store.transitionMutation(original.attempt.id, "prepared", "cancelled")).toBe(true);
    expect(value.cleanup(blob.candidate)).toEqual({ kind: "deleted" });
  });

  test("a changed retry cannot replace an original prepared attachment hold with positive empty input", async () => {
    const value = await fixture();
    const blob = await value.put();
    const key = randomUUID();
    const reservation = value.reserve([blob.attachment], key);
    const original = value.prepare([blob.attachment], key, reservation);
    const snapshot = value.store.readMutation(key);
    expect(() => value.prepare([], key)).toThrow("ATTACHMENT_CUSTODY_REQUEST_CONFLICT");
    expect(value.store.readMutation(key)).toEqual(snapshot);
    expect(value.cleanup(blob.candidate).kind).toBe("retained");
    expect(value.release(reservation).reason).toBe("mutation_owned");
    expect(original.custody.kind).toBe("mutation_owned");
  });

  test("a conflicting same-key invocation releases only its own hold and leaves the prepared original retryable", async () => {
    const value = await fixture();
    const originalBlob = await value.put();
    const changedBlob = await value.put("Different requested bytes.", "changed.txt");
    const key = randomUUID();
    const originalHold = value.reserve([originalBlob.attachment], key);
    const original = value.prepare([originalBlob.attachment], key, originalHold);
    const attempt = value.store.readMutation(key);
    const authority = value.store.readMutationProviderAuthorities(original.attempt.id);
    const conflictingHold = value.reserve([changedBlob.attachment], key, value.other);
    expect(() => value.prepare([changedBlob.attachment], key, conflictingHold, value.other))
      .toThrow("ATTACHMENT_CUSTODY_REQUEST_CONFLICT");
    expect(value.store.readMutation(key)).toEqual(attempt);
    expect(value.store.readMutationProviderAuthorities(original.attempt.id)).toEqual(authority);
    expect(value.release(conflictingHold, value.other).reason).toBe("released");
    expect(value.cleanup(changedBlob.candidate)).toEqual({ kind: "deleted" });
    expect(value.cleanup(originalBlob.candidate).kind).toBe("retained");
    expect(value.prepare([originalBlob.attachment], key, originalHold).custody).toEqual(original.custody);
    expect(value.release(originalHold).reason).toBe("mutation_owned");
    expect(await value.blobs.read(originalBlob.attachment.digest, "text/plain")).toEqual(originalBlob.bytes);
  });

  test("a reservation cannot be transplanted to another key or released with another hold's digest", async () => {
    const value = await fixture();
    const blob = await value.put();
    const firstKey = randomUUID();
    const secondKey = randomUUID();
    const first = value.reserve([blob.attachment], firstKey);
    const second = value.reserve([blob.attachment], secondKey, value.other);
    expect(() => value.prepare([blob.attachment], secondKey, first)).toThrow("ATTACHMENT_CUSTODY_REQUEST_CONFLICT");
    expect(value.store.readMutation(firstKey)).toBeNull();
    expect(value.store.readMutation(secondKey)).toBeNull();
    expect(() => value.release({ reservationId: first.reservationId, reservationDigest: second.reservationDigest }))
      .toThrow("ATTACHMENT_CUSTODY_REQUEST_CONFLICT");
    expect(value.cleanup(blob.candidate).kind).toBe("retained");
    expect(value.release(first).reason).toBe("released");
    expect(value.cleanup(blob.candidate).kind).toBe("retained");
    expect(value.release(second, value.other).reason).toBe("released");
    expect(value.cleanup(blob.candidate)).toEqual({ kind: "deleted" });
  });

  test("reserve, fresh prepare and begin require every field of the exact captured provider authority", async () => {
    const value = await fixture();
    const blob = await value.put();
    const key = randomUUID();
    const prepared = value.prepare([], key);
    const original = value.store.readMutation(key);
    const captured = value.store.readMutationProviderAuthorities(prepared.attempt.id);
    const wrongAuthorities = [
      { ...value.authority, providerAccountId: `acct_${"e".repeat(32)}` },
      { ...value.authority, profileId: `acct_${"f".repeat(32)}` },
      { ...value.authority, bindingGeneration: value.authority.bindingGeneration + 1 },
      { ...value.authority, processGeneration: value.authority.processGeneration + 1 },
      value.store.requireProviderAccountAuthority(value.authority.profileId, "claude"),
    ];
    for (const providerAuthority of wrongAuthorities) {
      const refusedKey = randomUUID();
      expect(() => value.store.reserveAttachmentIngress({ ...value.input([blob.attachment], refusedKey), providerAuthority })).toThrow();
      expect(() => value.store.prepareSessionInputMutation({ ...value.input([], refusedKey), kind: "session.send", providerAuthority })).toThrow();
      expect(value.store.readMutation(refusedKey)).toBeNull();
      expect(() => value.store.beginSessionMutationEffect({ ...value.beginInput(prepared, []), providerAuthority })).toThrow();
      expect(value.store.readMutation(key)).toEqual(original);
      expect(value.store.readMutationProviderAuthorities(prepared.attempt.id)).toEqual(captured);
    }
    expect(value.cleanup(blob.candidate)).toEqual({ kind: "deleted" });
    value.store.beginSessionMutationEffect(value.beginInput(prepared, []));
    expect(value.store.readMutation(key)).toMatchObject({ state: "effect_started", evidence: { attemptId: prepared.attempt.id } });
  });

  test.each(["missing", "wrong boot", "wrong generation", "stopped"] as const)("positive-empty begin refuses a %s daemon fence without recording native evidence", async (mode) => {
    const value = await fixture();
    const key = randomUUID();
    const prepared = value.prepare([], key);
    const { daemonGeneration, bootId, ...withoutDaemon } = value.beginInput(prepared, []);
    const daemon = mode === "missing" ? {} : {
      daemonGeneration: mode === "wrong generation" ? daemonGeneration + 1 : daemonGeneration,
      bootId: mode === "wrong boot" ? `boot_${"f".repeat(32)}` : bootId,
    };
    if (mode === "stopped") expect(value.store.markDaemonStopped(daemonGeneration, bootId)).toBe(true);
    expect(() => value.store.beginSessionMutationEffect({ ...withoutDaemon, ...daemon }))
      .toThrow("ATTACHMENT_CUSTODY_AUTHORITY_CHANGED");
    expect(value.store.readMutation(key)?.state).toBe("prepared");
    expect(value.store.readMutation(key)?.evidence).toBeUndefined();
    expect(value.store.messageAttachmentManifest(value.session.id, prepared.attempt.id)).toEqual([]);
  });

  test("a sibling provider generation change does not invalidate exact Codex custody or begin", async () => {
    const value = await fixture();
    const blob = await value.put();
    const key = randomUUID();
    const reservation = value.reserve([blob.attachment], key);
    const prepared = value.prepare([blob.attachment], key, reservation);
    const original = value.store.readMutation(key);
    const sibling = value.store.requireProviderAccountAuthority(value.authority.profileId, "claude");
    value.other.advanceProviderAccountProcessGeneration({ profileId: sibling.profileId, provider: sibling.provider,
      expectedProcessGeneration: sibling.processGeneration });
    expect(value.store.requireProviderAccountAuthority(value.authority.profileId, "codex")).toEqual(value.authority);
    expect(value.store.readMutation(key)).toEqual(original);
    value.store.beginSessionMutationEffect(value.beginInput(prepared, [blob.attachment]));
    expect(value.store.readMutation(key)?.state).toBe("effect_started");
    expect(value.release(reservation).reason).toBe("mutation_owned");
    expect(await value.blobs.read(blob.attachment.digest, "text/plain")).toEqual(blob.bytes);
  });

  test("native begin commits the exact manifest and evidence together and cannot dispatch twice after prepared retry", async () => {
    const value = await fixture();
    const blob = await value.put();
    const key = randomUUID();
    const reservation = value.reserve([blob.attachment], key);
    const original = value.prepare([blob.attachment], key, reservation);
    const redundant = value.reserve([blob.attachment], key, value.other);
    const replay = value.prepare([blob.attachment], key, redundant, value.other);
    if (replay.custody.kind !== "mutation_owned") throw new Error("Expected the original mutation hold");
    const beginInput = value.beginInput(replay, [blob.attachment]);
    // A second metadata INSERT, even with identical ON CONFLICT input, is not
    // needed: the one atomic transcript stage must own the manifest write.
    value.database.exec(`CREATE TRIGGER test_attachment_manifest_single_write BEFORE INSERT ON message_attachments
      WHEN EXISTS(SELECT 1 FROM message_attachments WHERE session_id=NEW.session_id AND source_id=NEW.source_id AND position=NEW.position)
      BEGIN SELECT RAISE(ABORT, 'duplicate attachment manifest staging'); END`);
    value.database.exec(`CREATE TRIGGER test_attachment_native_evidence_failure BEFORE INSERT ON mutation_effect_evidence
      BEGIN SELECT RAISE(ABORT, 'injected attachment native evidence failure'); END`);
    const before = databaseSnapshot(value.database);
    // The provenance writer deliberately sanitizes the injected SQL error;
    // full rollback plus the successful sibling below pin its causal effect.
    expect(() => value.other.beginSessionMutationEffect(beginInput)).toThrow("EFFECT_EVIDENCE_PROVENANCE_CORRUPT");
    expect(databaseSnapshot(value.database)).toEqual(before);
    expect(value.store.readMutation(key)?.state).toBe("prepared");
    expect(value.store.messageAttachmentManifest(value.session.id, original.attempt.id)).toEqual([]);
    expect(value.cleanup(blob.candidate).kind).toBe("retained");
    value.database.exec("DROP TRIGGER test_attachment_native_evidence_failure");
    value.other.beginSessionMutationEffect(beginInput);
    expect(value.store.readMutation(key)?.state).toBe("effect_started");
    expect(value.store.messageAttachmentManifest(value.session.id, original.attempt.id)).toEqual([
      { digest: blob.attachment.digest, name: blob.attachment.name,
        mediaType: blob.attachment.mediaType, byteLength: blob.attachment.byteLength },
    ]);
    expect(value.store.readSessionUserMessageSource(value.session.id, "mutation", key)).toMatchObject({
      status: "pending", intent: { actor: "human", attachments: [{ digest: blob.attachment.digest,
        name: blob.attachment.name, mediaType: blob.attachment.mediaType, byteLength: blob.attachment.byteLength }] },
    });
    expect(() => value.store.beginSessionMutationEffect(beginInput)).toThrow();
    expect(value.database.query("SELECT attempt_id FROM mutation_effect_evidence WHERE attempt_id=?")
      .all(original.attempt.id)).toHaveLength(1);
    expect(value.release(reservation).reason).toBe("mutation_owned");
    expect(value.cleanup(blob.candidate).kind).toBe("retained");
  });

  test.each(["reference omission", "reference order", "reference name", "stored omission", "stored name", "stored canonical type"] as const)(
    "explicit transcript %s cannot replace the original ordered custody manifest",
    async (mismatch) => {
      const value = await fixture();
      const first = await value.put("First immutable attachment.", "first.txt");
      const second = await value.put("Second immutable attachment.", "second.txt");
      const attachments = [first.attachment, second.attachment];
      const key = randomUUID();
      const reservation = value.reserve(attachments, key);
      const prepared = value.prepare(attachments, key, reservation);
      const references = attachments.map(({ byteLength, digest, mediaType, name }) => ({ byteLength, digest, mediaType, name }));
      const supplied = value.beginInput(prepared, attachments);
      const transcript = {
        ...supplied.transcript,
        attachments: mismatch === "reference omission" ? [] : mismatch === "reference order" ? [...references].reverse()
          : mismatch === "reference name" ? references.map((entry) => ({ ...entry, name: "changed.txt" })) : references,
        storedAttachments: mismatch === "stored omission" ? [] : mismatch === "stored name"
          ? attachments.map((entry) => ({ ...entry, name: "changed.txt" })) : mismatch === "stored canonical type"
            ? attachments.map((entry) => ({ ...entry, canonicalMediaType: "text/markdown" as const })) : attachments,
      };
      const before = databaseSnapshot(value.database);
      expect(() => value.store.beginSessionMutationEffect({ ...supplied, transcript }))
        .toThrow("SESSION_USER_MESSAGE_ATTACHMENT_INTENT_MISMATCH");
      expect(databaseSnapshot(value.database)).toEqual(before);
      expect(value.store.readMutation(key)?.state).toBe("prepared");
      expect(value.store.messageAttachmentManifest(value.session.id, prepared.attempt.id)).toEqual([]);
      // The same original request remains usable after the refused mismatch.
      value.store.beginSessionMutationEffect({ ...supplied, transcript: { ...supplied.transcript, attachments: references, storedAttachments: attachments } });
      expect(value.store.readSessionUserMessageSource(value.session.id, "mutation", key)).toMatchObject({ status: "pending", intent: { attachments: references } });
    },
  );

  test("queue manifest failure rolls back transfer while the caller's reservation remains live", async () => {
    const value = await fixture();
    const blob = await value.put();
    const key = randomUUID();
    const reservation = value.reserve([blob.attachment], key, value.store, "session.queue");
    const enqueue = () => value.store.enqueueIdempotentWithResult({
      sessionId: value.session.id, profileGeneration: value.authority.processGeneration,
      providerAuthority: value.authority, message: "The exact human request.", idempotencyKey: key,
      attachments: [{ digest: blob.attachment.digest, name: blob.attachment.name,
        mediaType: blob.attachment.mediaType, byteLength: blob.attachment.byteLength }],
      storedAttachments: [blob.attachment], attachmentReservation: { ...reservation, ...value.daemon },
    });
    const sequence = value.database.query("SELECT * FROM queue_sequence_authority").get();
    value.database.exec(`CREATE TRIGGER test_reservation_manifest_failure BEFORE INSERT ON message_attachments
      BEGIN SELECT RAISE(ABORT, 'injected reservation manifest failure'); END`);
    expect(enqueue).toThrow("injected reservation manifest failure");
    expect(value.store.readMutation(key)).toBeNull();
    expect(value.store.listQueue(value.session.id)).toEqual([]);
    expect(value.store.attachmentCustody(blob.attachment.digest)).toBeNull();
    expect(value.database.query("SELECT * FROM queue_sequence_authority").get()).toEqual(sequence);
    expect(value.cleanup(blob.candidate).kind).toBe("retained");
    value.database.exec("DROP TRIGGER test_reservation_manifest_failure");
    const result = enqueue();
    expect(result).toMatchObject({ replayed: false, verification: "sealed" });
    expect(value.release(reservation)).toEqual({ released: false, reason: "already_released" });
    expect(value.store.attachmentCustody(blob.attachment.digest)?.referenceCount).toBe(1);
    expect(value.cleanup(blob.candidate).kind).toBe("retained");
    expect(value.cleanupCalls).toHaveLength(0);
    expect(await value.blobs.read(blob.attachment.digest, "text/plain")).toEqual(blob.bytes);
  });

  test("an exact queue replay releases only its redundant reservation and preserves the sealed manifest", async () => {
    const value = await fixture();
    const blob = await value.put();
    const key = randomUUID();
    const first = value.reserve([blob.attachment], key, value.store, "session.queue");
    const enqueue = (reservation: typeof first, store = value.store) => store.enqueueIdempotentWithResult({
      sessionId: value.session.id, profileGeneration: value.authority.processGeneration,
      providerAuthority: value.authority, message: "The exact human request.", idempotencyKey: key,
      attachments: [{ digest: blob.attachment.digest, name: blob.attachment.name,
        mediaType: blob.attachment.mediaType, byteLength: blob.attachment.byteLength }],
      storedAttachments: [blob.attachment], attachmentReservation: { ...reservation, ...value.daemon },
    });
    const original = enqueue(first);
    const redundant = value.reserve([blob.attachment], key, value.other, "session.queue");
    const replay = enqueue(redundant, value.other);
    expect(replay).toEqual({ ...original, replayed: true });
    expect(value.release(redundant, value.other).reason).toBe("already_released");
    expect(value.store.queueAttachmentManifest(original.queued.id)).toEqual([
      { digest: blob.attachment.digest, name: blob.attachment.name,
        mediaType: blob.attachment.mediaType, byteLength: blob.attachment.byteLength },
    ]);
    expect(value.store.attachmentCustody(blob.attachment.digest)?.referenceCount).toBe(1);
    expect(value.cleanup(blob.candidate).kind).toBe("retained");
  });

  test("positive empty closed preparation does not consume attached custody or block unrelated cleanup", async () => {
    const value = await fixture();
    const blob = await value.put();
    const key = randomUUID();
    expect(value.store.reserveAttachmentIngress(value.input([], key))).toEqual({ kind: "empty" });
    const prepared = value.prepare([], key);
    expect(prepared.attempt).toMatchObject({ state: "prepared", replay: false });
    expect(prepared.custody).toEqual({ kind: "empty" });
    expect(value.prepare([], key)).toEqual({ ...prepared, attempt: { ...prepared.attempt, replay: true } });
    expect(value.cleanup(blob.candidate)).toEqual({ kind: "deleted" });
    expect(value.store.readMutation(key)?.state).toBe("prepared");
    expect(value.store.messageAttachmentManifest(value.session.id, prepared.attempt.id)).toEqual([]);
  });

  test.each(["session.send", "session.steer"] as const)("historical unproved %s preparation blocks cleanup and cannot gain empty proof from closed replay", async (kind) => {
    const value = await fixture(undefined, kind);
    const historical = value.historical;
    if (historical === undefined) throw new Error("Expected an archived prepared request.");
    const blob = await value.put();
    const key = historical.idempotencyKey;
    const description = { kind, authorityId: value.session.id,
      authorityGeneration: value.authority.processGeneration, request: { message: "The exact human request." },
      idempotencyKey: randomUUID(), providerAuthorities: [{ role: "primary", authority: value.authority, provenance: "session_effect" }],
    } as const;
    expect(() => value.store.prepareMutation(description)).toThrow("ATTACHMENT_CUSTODY_UNPROVED");
    const store = value.store;
    const attemptId = historical.attemptId;
    const cleanup = () => store.cleanupAttachmentCandidate({ candidate: blob.candidate, ...value.daemon });
    const original = store.readMutation(key);
    expect(original).toMatchObject({ id: attemptId, state: "prepared" });
    expect(cleanup().kind).toBe("retained");
    expect(value.cleanupCalls).toEqual([]);
    expect(() => store.prepareSessionInputMutation({ ...value.input([], key, kind), kind }))
      .toThrow("ATTACHMENT_CUSTODY_UNPROVED");
    expect(store.readMutation(key)).toEqual(original);
    expect(store.transitionMutation(attemptId, "prepared", "cancelled")).toBe(true);
    expect(cleanup()).toEqual({ kind: "deleted" });
  });

  test("unlink failure preserves bytes and a later successful cleanup can retry", async () => {
    const injected = { fail: true };
    const value = await fixture(() => { if (injected.fail) throw new Error("injected unlink failure"); });
    const blob = await value.put();
    expect(() => value.cleanup(blob.candidate)).toThrow();
    expect(await value.blobs.read(blob.attachment.digest, "text/plain")).toEqual(blob.bytes);
    injected.fail = false;
    expect(value.cleanup(blob.candidate)).toEqual({ kind: "deleted" });
  });

  test("post-unlink SQL failure retains unreferenced metadata until a fully rechecked ENOENT retry", async () => {
    const value = await fixture();
    const blob = await value.put();
    const later = await value.put("Later retained display bytes.", "later.txt");
    value.store.recordMessageAttachments({ sessionId: value.session.id, sourceId: "old_attachment_source",
      attachments: [blob.attachment] });
    for (let index = 0; index < MESSAGE_ATTACHMENT_SOURCE_PER_SESSION_CAP; index += 1) {
      value.clock.now += 1;
      value.store.recordMessageAttachments({ sessionId: value.session.id, sourceId: `new_source_${String(index)}`,
        attachments: [later.attachment] });
    }
    expect(value.store.attachmentCustody(blob.attachment.digest)?.referenceCount).toBe(0);
    value.database.exec(`CREATE TRIGGER test_cleanup_accounting_failure BEFORE DELETE ON attachments
      BEGIN SELECT RAISE(ABORT, 'injected cleanup accounting failure'); END`);
    expect(() => value.cleanup(blob.candidate)).toThrow("injected cleanup accounting failure");
    expect(await value.blobs.has(blob.attachment.digest, "text/plain")).toBe(false);
    expect(value.store.attachmentCustody(blob.attachment.digest)?.referenceCount).toBe(0);
    expect(value.cleanupCalls).toHaveLength(1);
    value.database.exec("DROP TRIGGER test_cleanup_accounting_failure");
    expect(value.cleanup(blob.candidate)).toEqual({ kind: "absent" });
    expect(value.store.attachmentCustody(blob.attachment.digest)).toBeNull();
    expect(await value.blobs.read(later.attachment.digest, "text/plain")).toEqual(later.bytes);
  });

  test("a replacement daemon fences stale deletion and retires only the old invocation hold", async () => {
    const value = await fixture();
    const blob = await value.put();
    value.reserve([blob.attachment]);
    const bootId = `boot_${randomUUID().replaceAll("-", "")}`;
    const daemonGeneration = value.other.nextDaemonGeneration(bootId);
    expect(() => value.cleanup(blob.candidate)).toThrow("ATTACHMENT_CUSTODY_AUTHORITY_CHANGED");
    expect(value.cleanupCalls).toEqual([]);
    expect(await value.blobs.read(blob.attachment.digest, "text/plain")).toEqual(blob.bytes);
    expect(value.store.cleanupAttachmentCandidate({ candidate: blob.candidate, daemonGeneration, bootId }))
      .toEqual({ kind: "deleted" });
  });
});
