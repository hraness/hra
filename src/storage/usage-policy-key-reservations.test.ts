import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { SessionSendRequest } from "../domain/session-send-request";
import { AttachmentBlobStore } from "./attachment-store";
import { initializeStatePaths, resolveStatePaths } from "./paths";
import { StateStore, type StoredMessageAttachment } from "./state-store";

const roots: string[] = [];
const stores: StateStore[] = [];
afterEach(async () => {
  for (const store of stores.splice(0)) store.close();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

const inputKinds = ["original_send", "session.steer", "session.queue"] as const;
type InputKind = typeof inputKinds[number];
const collisionErrors = {
  original_send: "SESSION_SEND_REQUEST_CONFLICT",
  "session.steer": "ATTACHMENT_CUSTODY_REQUEST_CONFLICT",
  "session.queue": "QUEUE_ATTACHMENT_REQUEST_CONFLICT",
} as const;

async function fixture(kind: InputKind) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "oompa-policy-input-key-")));
  roots.push(root);
  const paths = resolveStatePaths({ rootDirectory: root });
  await initializeStatePaths(paths);
  const store = new StateStore(paths, { now: () => 1_900_000_000_000, resolveMachineTimeZone: () => "UTC" });
  stores.push(store);
  const bootId = `boot_${randomUUID().replaceAll("-", "")}`;
  const daemon = { bootId, daemonGeneration: store.nextDaemonGeneration(bootId) };
  const profile = store.nextProfileGeneration(store.createProfile("Policy input key").id);
  expect(store.setProfileState(profile.id, profile.processGeneration, "signed_in", {
    email: "policy-input-key@example.com", plan: "Plus",
  })).toBe(true);
  const authority = store.requireProviderAccountAuthority(profile.id, "codex");
  const session = (() => {
    if (kind === "session.queue") {
      const imported = store.upsertProviderSession({ profileId: profile.id, provider: "codex", providerAuthority: authority,
        providerAccountKey: `v1:codex:${createHash("sha256").update("policy-input-key@example.com").digest("hex")}`,
        title: "Policy input queue", preset: "high", fastEnabled: false, providerThreadId: "policy-input-key-thread", state: "idle" });
      return store.updateSessionMetadata({ sessionId: imported.id, expectedRevision: imported.revision, preset: "high" });
    }
    const created = store.createSession({ profileId: profile.id, preset: "high", fastEnabled: false });
    return store.bindSession({ sessionId: created.id, expectedRevision: created.revision,
      providerThreadId: "policy-input-key-thread", state: "idle" });
  })();
  const stored = await AttachmentBlobStore.forStatePaths(paths).put("text/plain", new TextEncoder().encode("Policy key custody fixture."));
  if (stored.kind !== "stored") throw new Error("Synthetic attachment admission failed");
  const attachment: StoredMessageAttachment = { digest: stored.value.digest, byteLength: stored.value.byteLength,
    canonicalMediaType: "text/plain", mediaType: "text/plain", name: "input.txt" };
  const reference = { digest: attachment.digest, byteLength: attachment.byteLength,
    mediaType: attachment.mediaType, name: attachment.name };
  const idempotencyKey = randomUUID();
  const request: SessionSendRequest = { kind: "session.send", session: session.id, message: "",
    attachments: [reference], idempotencyKey };
  const genericInput = { kind: kind === "session.queue" ? "session.queue" as const : "session.steer" as const,
    sessionId: session.id, message: "Exact input before policy admission.", idempotencyKey,
    attachments: [reference], providerAuthority: authority, ...daemon };
  const reserved = kind === "original_send"
    ? store.reserveOriginalSessionSendIngress({ request, ...daemon })
    : store.reserveAttachmentIngress(genericInput);
  if (reserved.kind !== "reserved") throw new Error("Expected a bare invocation reservation");
  const reservation = { reservationId: reserved.reservationId, reservationDigest: reserved.reservationDigest };
  const admit = () => {
    if (kind === "original_send") return store.prepareOwnedSessionSendWithCustody({ request, reservation, ...daemon });
    if (kind === "session.steer") return store.prepareSessionInputMutation({ ...genericInput, kind, reservation });
    return store.enqueueIdempotentWithResult({ sessionId: session.id, profileGeneration: authority.processGeneration,
      providerAuthority: authority, message: genericInput.message, idempotencyKey, attachments: [reference], storedAttachments: [attachment],
      attachmentReservation: { ...reservation, ...daemon } });
  };
  const snapshot = () => {
    const database = new Database(paths.database, { readonly: true, strict: true });
    try {
      const names = database.query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all();
      return {
        version: database.query("PRAGMA user_version").get(),
        schemaVersion: database.query("PRAGMA schema_version").get(),
        applicationId: database.query("PRAGMA application_id").get(),
        schema: database.query("SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name").all(),
        tables: names.map(({ name }) => ({ name,
          rows: database.query(`SELECT * FROM "${name.replaceAll('"', '""')}"`).all() })),
      };
    } finally { database.close(false); }
  };
  const policyInput = { idempotencyKey, expectedAutomaticPolicyRevision: 1,
    change: { kind: "set_default" as const, enabled: false } };
  return { store, daemon, reservation, idempotencyKey, policyInput, admit, snapshot };
}

type Snapshot = ReturnType<Awaited<ReturnType<typeof fixture>>["snapshot"]>;
function rows(snapshot: Snapshot, table: string) {
  const entry = snapshot.tables.find((candidate) => candidate.name === table);
  if (entry === undefined) throw new Error(`Snapshot is missing ${table}`);
  return entry.rows;
}
const outsidePolicy = (snapshot: Snapshot) => ({ ...snapshot,
  tables: snapshot.tables.filter(({ name }) => name !== "mutation_attempts" && name !== "automatic_usage_policy_revisions"),
});

describe("automatic policy and input key admission ordering", () => {
  for (const kind of inputKinds) {
    for (const lifecycle of ["live", "released", "boot_retired"] as const) {
      test(`${kind} ${lifecycle} invocation retention grants no key ownership over policy admission`, async () => {
        const value = await fixture(kind);
        if (lifecycle === "released") expect(value.store.releaseAttachmentIngress({ ...value.reservation, ...value.daemon }))
          .toEqual({ released: true, reason: "released" });
        if (lifecycle === "boot_retired") value.store.nextDaemonGeneration(`boot_${randomUUID().replaceAll("-", "")}`);
        expect(value.store.readMutation(value.idempotencyKey)).toBeNull();
        const initial = value.snapshot();
        expect(rows(initial, "mutation_attempts")).toHaveLength(0);
        expect(rows(initial, "attachment_custody_sets")).toHaveLength(1);
        expect(rows(initial, "attachment_custody_anchors")).toHaveLength(1);
        expect(rows(initial, "attachment_custody_slots")).toHaveLength(lifecycle === "live" ? 1 : 0);
        expect(rows(initial, "attachment_custody_dispositions")).toHaveLength(lifecycle === "live" ? 0 : 1);

        // A bare token grants retention only. The first admitted mutation owns
        // the key, and later input admission must reclassify before custody.
        const original = value.store.updateAutomaticUsagePolicyConfiguration(value.policyInput);
        expect(original).toMatchObject({ defaultEnabled: false, automaticPolicyRevision: 2 });
        const admitted = value.snapshot();
        expect(outsidePolicy(admitted)).toEqual(outsidePolicy(initial));
        expect(rows(admitted, "mutation_attempts")).toHaveLength(1);
        expect(rows(admitted, "automatic_usage_policy_revisions")).toHaveLength(2);
        expect(() => value.admit()).toThrow(collisionErrors[kind]);
        expect(value.snapshot()).toEqual(admitted);

        // Response-loss replay is an immutable receipt, even after the policy
        // head changes; it cannot become another edit or input admission.
        value.store.updateAutomaticUsagePolicyConfiguration({ idempotencyKey: randomUUID(),
          expectedAutomaticPolicyRevision: 2, change: { kind: "set_override", provider: "codex", override: "on" } });
        const later = value.snapshot();
        expect(value.store.updateAutomaticUsagePolicyConfiguration(value.policyInput)).toEqual(original);
        expect(value.snapshot()).toEqual(later);
        expect(value.store.readAutomaticUsagePolicyConfiguration()).toMatchObject({ automaticPolicyRevision: 3,
          defaultEnabled: false, overrides: { codex: "on", claude: "inherit" } });
        expect(() => value.admit()).toThrow(collisionErrors[kind]);
        expect(value.snapshot()).toEqual(later);
        for (const table of ["session_send_owners", "session_send_execution_claims", "mutation_effect_evidence", "queue_entries", "queue_effect_evidence"]) {
          expect(rows(later, table)).toHaveLength(0);
        }
      });
    }

    test(`${kind} already admitted input refuses a policy edit with its key without changing any rows`, async () => {
      const value = await fixture(kind);
      value.admit();
      const before = value.snapshot();
      expect(rows(before, "mutation_attempts")).toHaveLength(1);
      expect(rows(before, "automatic_usage_policy_revisions")).toHaveLength(1);
      expect(rows(before, kind === "original_send" ? "session_send_owners"
        : kind === "session.queue" ? "queue_attachment_identities" : "attachment_custody_dispositions")).toHaveLength(1);
      expect(() => value.store.updateAutomaticUsagePolicyConfiguration(value.policyInput))
        .toThrow(kind === "original_send" ? "SESSION_SEND_OWNED_API_REQUIRED" : "IDEMPOTENCY_CONFLICT");
      expect(value.snapshot()).toEqual(before);
      expect(value.store.readAutomaticUsagePolicyConfiguration()).toMatchObject({ defaultEnabled: true, automaticPolicyRevision: 1 });
      expect(rows(before, "session_send_execution_claims")).toHaveLength(0);
      expect(rows(before, "mutation_effect_evidence")).toHaveLength(0);
      expect(rows(before, "queue_effect_evidence")).toHaveLength(0);
    });
  }
});
