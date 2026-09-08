import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { presetRequirements } from "../domain/presets";
import { effectiveRuntimeProfileSchema } from "../domain/runtime-profile";
import { createAttemptId } from "../domain/values";
import { initializeStatePaths, resolveStatePaths } from "./paths";
import { SessionSendOwnershipError } from "./session-send-owner";
import { StateStore } from "./state-store";

const stores: StateStore[] = [];
const databases: Database[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const database of databases.splice(0)) database.close(false);
});

async function fixture(stage: "unclaimed" | "claimed" | "settled" = "unclaimed") {
  const home = await realpath(await mkdtemp(join(tmpdir(), "hra-send-owner-guards-")));
  const paths = resolveStatePaths({ homeDirectory: home, platform: "darwin" });
  await initializeStatePaths(paths);
  const store = new StateStore(paths, { now: () => 10_000, resolveMachineTimeZone: () => "America/Puerto_Rico" });
  stores.push(store);
  const bootId = `boot_${randomUUID().replaceAll("-", "")}`;
  const daemonGeneration = store.nextDaemonGeneration(bootId);
  const profile = store.nextProfileGeneration(store.createProfile("Guarded original send").id);
  if (!store.setProfileState(profile.id, profile.processGeneration, "signed_in", {
    email: "owner-guards@example.com", plan: "Plus",
  })) throw new Error("guard fixture account admission failed");
  const createSession = (thread: string) => {
    const created = store.createSession({ profileId: profile.id, preset: "high", fastEnabled: false });
    return store.bindSession({ sessionId: created.id, expectedRevision: created.revision, providerThreadId: thread, state: "idle" });
  };
  const session = createSession("owned-original-thread");
  const unrelated = createSession("unrelated-thread");
  const request = {
    kind: "session.send" as const, idempotencyKey: randomUUID(), session: session.id,
    message: "One unchanged original request.", attachments: [],
  };
  const prepared = store.prepareOwnedSessionSend(request);
  const authority = prepared.owner.sourceAuthority;
  const runtimeProfile = effectiveRuntimeProfileSchema.parse({
    approvalPolicy: "on-request", computerUse: true, enabledApps: [], fast: false,
    model: presetRequirements.high.model, observedAt: 10_000, permissionProfile: ":workspace",
    pluginCapability: true, preset: "high", processGeneration: authority.processGeneration,
    profileId: authority.profileId, reasoningEffort: "max", reviewMode: "auto_review", serviceTier: null,
  });
  const evidence = {
    kind: "session.send" as const, providerThreadId: prepared.owner.sourceThreadId,
    baseline: { providerUpdatedAt: null, status: "idle" as const, activeTurnId: null },
    clientMessageId: prepared.owner.attemptId, messageDigest: prepared.owner.fingerprint.inputDigest,
    runtimeProfile,
  };
  const receipt = {
    turnId: "owned-turn", status: "completed" as const,
    sourceId: prepared.owner.attemptId, effectiveRuntimeProfile: runtimeProfile,
  };
  if (stage !== "unclaimed") {
    const claim = store.beginOwnedDirectSendEffect({
      attemptId: prepared.owner.attemptId, ownerDigest: prepared.ownerDigest,
      requestFingerprint: prepared.owner.fingerprint, daemonGeneration, bootId,
      expectedSessionRevision: session.revision, executionAuthority: authority, evidence,
    });
    if (stage === "settled") {
      if (claim.claimDigest === null) throw new Error("guard fixture claim missing");
      store.settleOwnedDirectSend({
        attemptId: prepared.owner.attemptId, ownerDigest: prepared.ownerDigest,
        claimDigest: claim.claimDigest, outcome: { kind: "accepted", receipt },
      });
    }
  }
  const database = new Database(paths.database, { strict: true });
  databases.push(database);
  database.exec("PRAGMA foreign_keys=ON");
  return { store, database, request, prepared, authority, runtimeProfile, evidence, receipt, session, unrelated, daemonGeneration, bootId };
}

function genericSend(value: Awaited<ReturnType<typeof fixture>>, idempotencyKey = value.request.idempotencyKey, sessionId = value.session.id) {
  return {
    kind: "session.send", idempotencyKey, authorityId: sessionId,
    authorityGeneration: value.authority.processGeneration,
    request: { message: value.request.message },
    providerAuthorities: [{ role: "primary" as const, authority: value.authority, provenance: "session_send" }],
  };
}

function detachMutation(value: Awaited<ReturnType<typeof fixture>>, corruption: "orphan" | "relocated"): void {
  const names = corruption === "orphan"
    ? ["session_send_mutation_delete_guard", "attachment_parent_delete_guard"]
    : ["session_send_mutation_guard", "attachment_parent_immutable"];
  const guards = names.map((name) => {
    const row = value.database.query<{ sql: string }, [string]>(
      "SELECT sql FROM sqlite_master WHERE type='trigger' AND name=?",
    ).get(name);
    if (row === null) throw new Error(`Missing controlled-corruption guard: ${name}`);
    return { name, sql: row.sql };
  });
  value.database.exec("PRAGMA foreign_keys=OFF");
  try {
    for (const guard of guards) value.database.exec(`DROP TRIGGER ${guard.name}`);
    if (corruption === "orphan") {
      value.database.query("DELETE FROM mutation_attempts WHERE id=?").run(value.prepared.owner.attemptId);
    } else {
      value.database.query("UPDATE mutation_attempts SET idempotency_key=? WHERE id=?")
        .run(randomUUID(), value.prepared.owner.attemptId);
    }
  } finally {
    for (const guard of guards) value.database.exec(guard.sql);
    value.database.exec("PRAGMA foreign_keys=ON");
  }
}

describe("original send generic guards", () => {
  for (const stage of ["unclaimed", "claimed", "settled"] as const) {
    test(`rejects generic API and direct-ID acceptance for ${stage} ownership`, async () => {
      const value = await fixture(stage);
      const attemptId = value.prepared.owner.attemptId;
      const before = value.store.readOwnedSessionSend(value.request.idempotencyKey);
      const sessionBefore = value.store.requireSession(value.session.id);
      const rejected = new SessionSendOwnershipError("SESSION_SEND_OWNED_API_REQUIRED");
      expect(() => value.store.readMutation(value.request.idempotencyKey)).toThrow(rejected);
      expect(() => value.store.prepareMutation(genericSend(value))).toThrow(rejected);
      expect(() => value.store.beginPreparedMutationEffect({
        attemptId, providerAuthorities: [{ role: "primary", authority: value.authority, provenance: "session_send_owner" }],
      })).toThrow(rejected);
      expect(() => value.store.transitionMutation(attemptId, "prepared", "effect_started")).toThrow(rejected);
      expect(() => value.store.beginSessionMutationEffect({
        attemptId, sessionId: value.session.id, profileGeneration: value.authority.processGeneration,
        providerAuthority: value.authority, evidence: value.evidence,
        message: value.request.message,
        transcript: { accountId: value.authority.profileId, providerGeneration: value.authority.processGeneration,
          providerConnectionId: "48000000-0000-4000-8000-000000000004", actor: "human", message: value.request.message },
      })).toThrow(rejected);
      expect(() => value.store.completeSessionTurnEffect({
        attemptId, sessionId: value.session.id, expectedSessionRevision: value.session.revision,
        accountId: value.authority.profileId, providerGeneration: value.authority.processGeneration,
        providerConnectionId: "48000000-0000-4000-8000-000000000004", message: value.request.message,
        applyResponseState: true, providerAuthority: value.authority,
        turnId: value.receipt.turnId, turnStatus: value.receipt.status,
        runtimeProfile: value.runtimeProfile, receipt: value.receipt,
      })).toThrow(rejected);
      expect(() => value.store.resolveSessionMutation({
        attemptId, expectedOriginalState: "effect_started", expectedEvidenceDigest: "0".repeat(64),
        resolution: "abandoned", resolutionEvidence: {}, acknowledgeProviderStateUnknown: true,
      })).toThrow(rejected);
      expect(() => value.store.recordSessionRuntimeProfile({
        sessionId: value.session.id, sourceKind: "turn_start", sourceId: attemptId,
        profile: value.runtimeProfile, providerAuthority: value.authority,
      })).toThrow("SESSION_SEND_OWNED_API_REQUIRED");
      expect(value.store.readOwnedSessionSend(value.request.idempotencyKey)).toEqual(before);
      expect(value.store.requireSession(value.session.id)).toEqual(sessionBefore);
      expect(value.store.latestSessionRuntimeProfile(value.session.id)).toBeNull();
    });

    test(`rejects raw generic writes and runtime receipts for ${stage} ownership`, async () => {
      const value = await fixture(stage);
      const attemptId = value.prepared.owner.attemptId;
      const before = value.store.readOwnedSessionSend(value.request.idempotencyKey);
      expect(() => value.database.query("UPDATE mutation_attempts SET request_format=NULL WHERE id=?").run(attemptId)).toThrow("SESSION_SEND_");
      expect(() => value.database.query("UPDATE mutation_attempts SET idempotency_key=? WHERE id=?").run(randomUUID(), attemptId)).toThrow("ATTACHMENT_CUSTODY_CORRUPT");
      expect(() => value.database.query("UPDATE mutation_attempts SET result_json='{}' WHERE id=?").run(attemptId)).toThrow("SESSION_SEND_");
      expect(() => value.database.query("DELETE FROM mutation_attempts WHERE id=?").run(attemptId)).toThrow("ATTACHMENT_CUSTODY_CORRUPT");
      const changedEvidence = JSON.stringify({ ...value.evidence, messageDigest: "0".repeat(64) });
      expect(() => value.database.query(`INSERT INTO mutation_effect_evidence(attempt_id,kind,evidence_json,evidence_digest,recorded_at)
        VALUES (?,'session.send',?,?,10000)`).run(attemptId, changedEvidence, createHash("sha256").update(changedEvidence).digest("hex")))
        .toThrow("SESSION_SEND_");
      expect(() => value.database.query(`INSERT INTO mutation_resolutions(attempt_id,resolution_kind,evidence_json,receipt_json,created_at)
        VALUES (?,'abandoned','{}',NULL,10000)`).run(attemptId)).toThrow("SESSION_SEND_");
      expect(() => value.database.query(`INSERT INTO mutation_provider_authorities(
        attempt_id,role,provider_account_id,profile_id,provider,binding_generation,process_generation,provenance,recorded_at
      ) VALUES (?,'target',?,?,?, ?,?,'session_send',10000)`).run(
        attemptId, value.authority.providerAccountId, value.authority.profileId, value.authority.provider,
        value.authority.bindingGeneration, value.authority.processGeneration,
      )).toThrow("SESSION_SEND_");
      const profileJson = JSON.stringify(value.runtimeProfile);
      expect(() => value.database.query(`INSERT INTO session_runtime_profiles(
        session_id,revision,source_kind,source_id,profile_id,process_generation,observed_at,profile_json,recorded_at
      ) VALUES (?,1,'turn_start',?,?,?,10000,?,10000)`).run(
        value.session.id, attemptId, value.authority.profileId, value.authority.processGeneration, profileJson,
      )).toThrow("SESSION_SEND_");
      expect(() => value.database.query(`INSERT INTO session_turn_runtime_profiles(
        session_id,turn_id,source_kind,source_id,profile_id,process_generation,observed_at,profile_json,profile_digest,recorded_at
      ) VALUES (?,'borrowed-turn','turn_start',?,?,?,10000,?,?,10000)`).run(
        value.session.id, attemptId, value.authority.profileId, value.authority.processGeneration, profileJson,
        createHash("sha256").update(profileJson).digest("hex"),
      )).toThrow("SESSION_SEND_");
      expect(value.store.readOwnedSessionSend(value.request.idempotencyKey)).toEqual(before);
    });
  }

  for (const corruption of ["orphan", "relocated"] as const) {
    test(`reserves the original key and attempt ID after ${corruption} mutation corruption`, async () => {
      const value = await fixture("claimed");
      detachMutation(value, corruption);
      const rejected = new SessionSendOwnershipError("SESSION_SEND_OWNER_CORRUPT");
      expect(() => value.store.readMutation(value.request.idempotencyKey)).toThrow(rejected);
      expect(() => value.store.prepareMutation(genericSend(value))).toThrow(rejected);
      expect(() => value.store.prepareOwnedSessionSend(value.request)).toThrow(rejected);
      const mutationsBefore = value.database.query("SELECT * FROM mutation_attempts ORDER BY id").all();
      for (const [attemptId, key] of [
        [createAttemptId(), value.request.idempotencyKey],
        [value.prepared.owner.attemptId, randomUUID()],
      ] as const) {
        expect(() => value.database.query(`INSERT INTO mutation_attempts(
          id,idempotency_key,kind,authority_id,authority_generation,request_digest,state,created_at,updated_at
        ) VALUES (?,?,'session.send',?,?,?,'prepared',10000,10000)`).run(
          attemptId, key, value.session.id, value.authority.processGeneration, "0".repeat(64),
        )).toThrow("ATTACHMENT_CUSTODY_CORRUPT");
      }
      expect(value.database.query("SELECT * FROM mutation_attempts ORDER BY id").all()).toEqual(mutationsBefore);
      expect(value.database.query("SELECT COUNT(*) AS count FROM session_send_execution_claims WHERE attempt_id=?")
        .get(value.prepared.owner.attemptId)).toEqual({ count: 1 });
    });
  }

  test("refuses a different-key same-session mutation while a claimed owner mutation is missing", async () => {
    const value = await fixture("claimed");
    detachMutation(value, "orphan");
    const key = randomUUID();
    expect(() => value.store.prepareMutation(genericSend(value, key)))
      .toThrow(new SessionSendOwnershipError("SESSION_SEND_OWNER_CORRUPT"));
    expect(value.database.query("SELECT id FROM mutation_attempts WHERE idempotency_key=?").get(key)).toBeNull();
    const unrelatedKey = randomUUID();
    expect(value.store.prepareSessionInputMutation({ kind: "session.send", idempotencyKey: unrelatedKey,
      sessionId: value.unrelated.id, providerAuthority: value.authority, message: value.request.message,
      attachments: [], daemonGeneration: value.daemonGeneration, bootId: value.bootId }).attempt.state).toBe("prepared");
    expect(value.database.query("SELECT COUNT(*) AS count FROM session_send_execution_claims WHERE attempt_id=?")
      .get(value.prepared.owner.attemptId)).toEqual({ count: 1 });
  });
});
