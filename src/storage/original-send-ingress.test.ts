import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { mkdtemp, realpath, rm, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

import { fingerprintSessionSendRequest, type SessionSendRequest } from "../domain/session-send-request";
import { AttachmentBlobStore } from "./attachment-store";
import { initializeStatePaths, resolveStatePaths } from "./paths";
import { StateStore } from "./state-store";

const roots: string[] = [];
const stores: StateStore[] = [];
const databases: Database[] = [];
afterEach(async () => {
  for (const database of databases.splice(0)) database.close(false);
  for (const store of stores.splice(0)) store.close();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "oompa-original-send-ingress-")));
  roots.push(root);
  const paths = resolveStatePaths({ rootDirectory: root });
  await initializeStatePaths(paths);
  const open = () => {
    const store = new StateStore(paths, { now: () => 1_900_000_000_000, resolveMachineTimeZone: () => "UTC" });
    stores.push(store);
    return store;
  };
  const store = open();
  const bootId = `boot_${randomUUID().replaceAll("-", "")}`;
  const daemon = { bootId, daemonGeneration: store.nextDaemonGeneration(bootId) };
  const profile = store.nextProfileGeneration(store.createProfile("Original ingress").id);
  expect(store.setProfileState(profile.id, profile.processGeneration, "signed_in", {
    email: "original-ingress@example.com", plan: "Plus",
  })).toBe(true);
  const created = store.createSession({ profileId: profile.id, preset: "high", fastEnabled: false });
  store.bindSession({ sessionId: created.id, expectedRevision: created.revision,
    providerThreadId: "original-ingress-thread", state: "idle" });
  const session = store.reconcileSessionFromProvider({ sessionId: created.id, title: "Original ingress session" });
  const blobs = AttachmentBlobStore.forStatePaths(paths);
  const stored = await blobs.put("text/plain", new TextEncoder().encode("Original input attachment."));
  if (stored.kind !== "stored") throw new Error("Synthetic attachment admission failed");
  await utimes(stored.value.path, new Date(1_000), new Date(1_000));
  const reference = { digest: stored.value.digest, byteLength: stored.value.byteLength,
    mediaType: "text/plain" as const, name: "original.txt" };
  const request: SessionSendRequest = { kind: "session.send", session: session.title, message: "",
    attachments: [reference], idempotencyKey: randomUUID() };
  const database = new Database(paths.database, { strict: true });
  databases.push(database);
  database.exec("PRAGMA foreign_keys=ON");
  const count = (table: string) => z.object({ count: z.number() }).strict().parse(
    database.query(`SELECT COUNT(*) AS count FROM ${table}`).get(),
  ).count;
  const candidate = { kind: "blob" as const, digest: reference.digest, canonicalMediaType: "text/plain" as const };
  const reserve = (input = request, target = store) => {
    const result = target.reserveOriginalSessionSendIngress({ request: input, ...daemon });
    if (result.kind !== "reserved") throw new Error("Expected a pre-owner reservation");
    return { reservationId: result.reservationId, reservationDigest: result.reservationDigest };
  };
  const prepare = (reservation: ReturnType<typeof reserve>, input = request, target = store) =>
    target.prepareOwnedSessionSendWithCustody({ request: input, reservation, ...daemon });
  const release = (reservation: ReturnType<typeof reserve>) => store.releaseAttachmentIngress({ ...reservation, ...daemon });
  return { store, open, database, paths, daemon, profile, session, request, reference, reserve, prepare, release, count,
    cleanup: () => store.cleanupAttachmentCandidate({ candidate, ...daemon }) };
}

test("original attachment-only ingress retains bytes before ownership and transfers the same slot atomically", async () => {
  const value = await fixture();
  const reservation = value.reserve();
  expect(value.store.readOwnedSessionSend(value.request.idempotencyKey)).toBeNull();
  expect(value.count("mutation_attempts")).toBe(0);
  expect(value.count("attachment_custody_slots")).toBe(1);
  const origin = z.object({ origin_json: z.string() }).parse(value.database.query(
    "SELECT origin_json FROM attachment_custody_sets WHERE id=?",
  ).get(reservation.reservationId));
  expect(z.object({ input: z.object({ requestDigest: z.string(), messageUtf8Bytes: z.number() }) })
    .parse(JSON.parse(origin.origin_json))).toMatchObject({ input: {
      requestDigest: fingerprintSessionSendRequest(value.request).requestDigest, messageUtf8Bytes: 0,
    } });
  expect(value.cleanup()).toEqual({ kind: "retained", reason: "reserved" });
  const owner = value.prepare(reservation);
  expect(owner.replayed).toBe(false);
  expect(owner.custody).toEqual({ kind: "mutation_owned", custodyId: reservation.reservationId,
    custodyDigest: reservation.reservationDigest });
  expect(value.count("attachment_custody_sets")).toBe(1);
  expect(value.count("attachment_custody_slots")).toBe(1);
  expect(value.release(reservation)).toEqual({ released: false, reason: "mutation_owned" });
  expect(value.store.cancelOwnedSessionSend({ attemptId: owner.owner.attemptId, ownerDigest: owner.ownerDigest }).state).toBe("cancelled");
  expect(value.count("attachment_custody_slots")).toBe(0);
  expect(value.prepare(reservation).state).toBe("cancelled");
  expect(value.cleanup()).toEqual({ kind: "deleted" });
  value.store.nextDaemonGeneration(`boot_${"c".repeat(32)}`);
  expect(value.prepare(reservation).state).toBe("cancelled");
  expect(value.count("attachment_custody_sets")).toBe(1);
  expect(value.count("session_send_execution_claims")).toBe(0);
  expect(value.count("mutation_effect_evidence")).toBe(0);
});

test("same-key reservations are independent and exact owner replay precedes changed selectors and daemon state", async () => {
  const value = await fixture();
  const first = value.reserve();
  const second = value.reserve(value.request, value.open());
  expect(first.reservationId).not.toBe(second.reservationId);
  expect(value.release(first).released).toBe(true);
  expect(value.cleanup().kind).toBe("retained");
  const owner = value.prepare(second);
  value.store.reconcileSessionFromProvider({ sessionId: value.session.id, title: "A different live selector" });
  const replay = value.store.reserveOriginalSessionSendIngress({ request: value.request,
    daemonGeneration: value.daemon.daemonGeneration + 1, bootId: `boot_${"f".repeat(32)}` });
  expect(replay.kind).toBe("owned");
  if (replay.kind === "owned") expect(replay.history.ownerDigest).toBe(owner.ownerDigest);
  expect(value.count("attachment_custody_sets")).toBe(2);
  expect(() => value.reserve({ ...value.request, message: "Changed original input" })).toThrow("SESSION_SEND_REQUEST_CONFLICT");
  expect(() => value.reserve({ ...value.request, session: "Missing selector" })).toThrow("SESSION_SEND_REQUEST_CONFLICT");
});

test("a competing retained direct owner keeps its mode and releases only the redundant invocation hold", async () => {
  const value = await fixture();
  const reservation = value.reserve();
  const other = value.open();
  const winner = other.prepareOwnedSessionSendWithCustody({ request: value.request, ...value.daemon });
  const replay = value.prepare(reservation);
  expect(replay.replayed).toBe(true);
  expect(replay.ownerDigest).toBe(winner.ownerDigest);
  expect(replay.custody).toEqual(winner.custody);
  expect(value.count("session_send_owners")).toBe(1);
  expect(value.count("attachment_custody_sets")).toBe(2);
  expect(value.count("attachment_custody_slots")).toBe(1);
  expect(value.release(reservation)).toEqual({ released: false, reason: "already_released" });
  // A lost response after redundant release must remain an inert same-key
  // replay, not require a fresh reservation or a live daemon generation.
  expect(value.prepare(reservation).ownerDigest).toBe(winner.ownerDigest);
  const dispositions = value.count("attachment_custody_dispositions");
  value.store.nextDaemonGeneration(`boot_${"d".repeat(32)}`);
  expect(value.prepare(reservation).ownerDigest).toBe(winner.ownerDigest);
  expect(value.count("attachment_custody_sets")).toBe(2);
  expect(value.count("attachment_custody_dispositions")).toBe(dispositions);
  expect(value.count("attachment_custody_slots")).toBe(1);
  expect(value.count("session_send_execution_claims")).toBe(0);
});

test("a competing unproved owner is not upgraded by a later original reservation", async () => {
  const value = await fixture();
  const reservation = value.reserve();
  const winner = value.open().prepareOwnedSessionSend(value.request);
  expect(() => value.prepare(reservation)).toThrow("ATTACHMENT_CUSTODY_UNPROVED");
  expect(value.store.readOwnedSessionSend(value.request.idempotencyKey)?.ownerDigest).toBe(winner.ownerDigest);
  expect(value.count("attachment_custody_slots")).toBe(1);
  expect(value.release(reservation).released).toBe(true);
});

test("released custody from another request cannot use the existing-owner replay exception", async () => {
  const value = await fixture();
  const foreign = value.reserve({ ...value.request, idempotencyKey: randomUUID() });
  expect(value.release(foreign).released).toBe(true);
  const winner = value.store.prepareOwnedSessionSendWithCustody({ request: value.request, ...value.daemon });
  const counts = ["attachment_custody_sets", "attachment_custody_dispositions", "attachment_custody_slots", "session_send_owners"];
  const before = counts.map(value.count);
  expect(() => value.prepare(foreign)).toThrow("ATTACHMENT_CUSTODY_REQUEST_CONFLICT");
  expect(counts.map(value.count)).toEqual(before);
  expect(value.store.readOwnedSessionSend(value.request.idempotencyKey)?.ownerDigest).toBe(winner.ownerDigest);
  expect(value.count("session_send_execution_claims")).toBe(0);
});

test("changed input or a generic reservation cannot be rebound under an original fingerprint", async () => {
  const value = await fixture();
  const reservation = value.reserve();
  for (const request of [{ ...value.request, message: "changed" },
    { ...value.request, attachments: [{ ...value.reference, name: "changed.txt" }] },
    { ...value.request, idempotencyKey: randomUUID() }]) {
    expect(() => value.prepare(reservation, request)).toThrow("ATTACHMENT_CUSTODY_REQUEST_CONFLICT");
  }
  expect(value.count("session_send_owners")).toBe(0);
  expect(value.count("attachment_custody_slots")).toBe(1);
  const textRequest = { ...value.request, message: "Generic text-bearing input", idempotencyKey: randomUUID() };
  const generic = value.store.reserveAttachmentIngress({ kind: "session.send", sessionId: value.session.id,
    idempotencyKey: textRequest.idempotencyKey, message: textRequest.message, attachments: textRequest.attachments,
    providerAuthority: value.store.requireProviderAccountAuthority(value.profile.id, "codex"), ...value.daemon });
  if (generic.kind !== "reserved") throw new Error("Missing generic reservation");
  expect(() => value.prepare({ reservationId: generic.reservationId, reservationDigest: generic.reservationDigest }, textRequest))
    .toThrow("ATTACHMENT_CUSTODY_REQUEST_CONFLICT");
  expect(value.count("session_send_owners")).toBe(0);
  expect(value.count("attachment_custody_slots")).toBe(2);
});

test("late insertion failure rolls back ownership without losing either invocation's hold", async () => {
  const value = await fixture();
  const first = value.reserve();
  const second = value.reserve();
  value.database.exec("CREATE TRIGGER original_ingress_test_failure BEFORE INSERT ON session_send_owner_anchors BEGIN SELECT RAISE(ABORT,'ORIGINAL_INGRESS_TEST_FAILURE'); END");
  expect(() => value.prepare(first)).toThrow("ORIGINAL_INGRESS_TEST_FAILURE");
  expect(value.count("mutation_attempts")).toBe(0);
  expect(value.count("session_send_owners")).toBe(0);
  expect(value.count("attachment_custody_slots")).toBe(2);
  expect(value.release(first).released).toBe(true);
  value.database.exec("DROP TRIGGER original_ingress_test_failure");
  expect(value.prepare(second).replayed).toBe(false);
  expect(value.count("attachment_custody_slots")).toBe(1);
});

test("source movement after blob admission cannot bind the old reservation to a new owner", async () => {
  const value = await fixture();
  const reservation = value.reserve();
  value.store.nextProfileGeneration(value.profile.id);
  expect(() => value.prepare(reservation)).toThrow("PROVIDER_ACCOUNT_AUTHORITY_STALE");
  expect(value.count("session_send_owners")).toBe(0);
  expect(value.count("attachment_custody_slots")).toBe(1);
  expect(value.release(reservation).released).toBe(true);
  expect(value.cleanup()).toEqual({ kind: "deleted" });
});

test("restart retires pre-owner custody and never turns it into an owner or a fresh hold", async () => {
  const value = await fixture();
  const reservation = value.reserve();
  value.store.nextDaemonGeneration(`boot_${"e".repeat(32)}`);
  expect(value.count("attachment_custody_slots")).toBe(0);
  expect(value.count("session_send_owners")).toBe(0);
  expect(() => value.prepare(reservation)).toThrow("ATTACHMENT_CUSTODY_AUTHORITY_CHANGED");
  expect(value.count("attachment_custody_sets")).toBe(1);
  expect(value.count("session_send_execution_claims")).toBe(0);
});

test("legacy global keys and entirely empty original input refuse without creating retention", async () => {
  const value = await fixture();
  value.store.prepareMutation({ kind: "session.rename", authorityId: value.session.id,
    authorityGeneration: value.profile.processGeneration, request: { name: "Reserved legacy key" },
    idempotencyKey: value.request.idempotencyKey });
  expect(() => value.reserve({ ...value.request, session: "Not a current selector" })).toThrow("SESSION_SEND_REQUEST_CONFLICT");
  expect(() => value.reserve({ ...value.request, attachments: [] })).toThrow();
  expect(value.count("session_send_owners")).toBe(0);
  expect(value.count("attachment_custody_sets")).toBe(0);
});

test("empty references need no slot even at capacity and closed input rejects caller digest authority", async () => {
  const value = await fixture();
  const first = value.reserve();
  for (let index = 1; index < 64; index++) value.reserve();
  expect(value.count("attachment_custody_slots")).toBe(64);
  expect(() => value.reserve()).toThrow("ATTACHMENT_CUSTODY_LIMIT");
  const empty = { ...value.request, message: "Text only", attachments: [] };
  expect(value.store.reserveOriginalSessionSendIngress({ request: empty, ...value.daemon })).toEqual({ kind: "empty" });
  const foreign = { request: value.request, requestDigest: "a".repeat(64), ...value.daemon };
  expect(() => value.store.reserveOriginalSessionSendIngress(foreign)).toThrow();
  expect(value.count("session_send_owners")).toBe(0);
  expect(value.count("attachment_custody_sets")).toBe(64);
  expect(value.prepare(first).replayed).toBe(false);
  expect(value.count("attachment_custody_sets")).toBe(64);
  expect(value.count("attachment_custody_slots")).toBe(64);
}, 20_000);
