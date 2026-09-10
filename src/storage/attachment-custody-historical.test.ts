import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fc from "fast-check";
import { z } from "zod";

import { combined49DatabaseBytes } from "../../scripts/fixtures/combined49";
import { privateTask48DatabaseBytes } from "../../scripts/fixtures/private-task48";
import { privateTask48PinnedDatabaseBytes } from "../../scripts/fixtures/private-task48-pinned";
import { applyJoinedAttachmentTerminalGuard, attachmentTerminalProof, auditAttachmentCustody, readAttachmentParent, readAttachmentSet } from "./attachment-custody";
import { applyEffectEvidenceProvenance } from "./effect-evidence-provenance";
import { auditSessionSendOwners, historicalSessionSendOwnerAuditFormatSchema, requireHistoricalSessionSendOwnerForAudit,
  requireSessionSendOwner, sessionSendExecutionClaimSchema,
  sessionSendOutcomeSchema } from "./session-send-owner";

const databases: Database[] = [];
const roots: string[] = [];
afterEach(async () => {
  for (const database of databases.splice(0).reverse()) database.close(false);
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const ownerHash = (kind: string, value: unknown) => hash(JSON.stringify({ domain: `hra.session-send.${kind}.v1`, value }));
const custodyHash = (value: unknown) => hash(JSON.stringify({ domain: "hra:attachment-custody:v1", value }));
const captures = [
  { name: "private48 original", bytes: privateTask48DatabaseBytes, format: "private_task48_v1", inputFormat: "empty_v1" },
  { name: "private48 pinned", bytes: privateTask48PinnedDatabaseBytes, format: "private_task48_v1", inputFormat: "retained_v1" },
  { name: "combined49 pinned", bytes: combined49DatabaseBytes, format: "combined49_v1", inputFormat: "retained_v1" },
] as const;
function snapshot(database: Database) {
  const tables = z.array(z.object({ name: z.string().regex(/^[a-z_0-9]+$/u) }).strict()).parse(
    database.query("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all(),
  );
  return {
    schema: database.query("SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name").all(),
    version: database.query("PRAGMA user_version").get(),
    rows: Object.fromEntries(tables.map(({ name }) => [name,
      database.query(`SELECT * FROM "${name}"`).all().map((row) => JSON.stringify(row)).sort(),
    ])),
    changes: database.query("SELECT total_changes() AS count").get(),
    foreignKeys: database.query("PRAGMA foreign_key_check").all(),
  };
}

// Original archive bytes contain a genuine public-API prepared owner. The
// added claim/outcome below is SYNTHETIC component evidence, using the frozen
// pre-provenance writer's SQL under its real guards. No StateStore migration,
// historical settled capture, provider dispatch, or native receipt is claimed.
async function settledFixture(capture: (typeof captures)[number]) {
  const bytes = capture.bytes();
  const originalBytes = Uint8Array.from(bytes);
  const root = await mkdtemp(join(tmpdir(), "oompa-historical-custody-"));
  roots.push(root);
  const path = join(root, "state.sqlite");
  await writeFile(path, bytes, { mode: 0o600 });
  const database = new Database(path, { create: false, strict: true });
  databases.push(database);
  database.exec("PRAGMA foreign_keys=ON");
  const original = snapshot(database);
  const { attempt_id: attemptId } = z.object({ attempt_id: z.string() }).strict().parse(
    database.query("SELECT attempt_id FROM session_send_owners ORDER BY attempt_id LIMIT 1").get(),
  );
  const prepared = requireSessionSendOwner(database, { attemptId });
  expect(prepared.state).toBe("input_required");
  const { owner, ownerDigest } = prepared;
  const daemon = z.object({ generation: z.number().int().positive(), boot_id: z.string() }).strict().parse(
    database.query("SELECT generation,boot_id FROM daemon_state WHERE singleton=1").get(),
  );
  const runtimeProfile = {
    profileId: owner.sourceAuthority.profileId, processGeneration: owner.sourceAuthority.processGeneration,
    observedAt: owner.createdAt, preset: "ultra", model: "gpt-5.6-sol", reasoningEffort: "ultra",
    serviceTier: "priority", fast: true, approvalPolicy: "on-request", reviewMode: "auto_review",
    permissionProfile: ":workspace", computerUse: true, pluginCapability: true, enabledApps: [],
  };
  const evidence = { kind: "session.send", providerThreadId: owner.sourceThreadId,
    baseline: { providerUpdatedAt: null, status: "idle", activeTurnId: null }, clientMessageId: attemptId,
    messageDigest: owner.fingerprint.inputDigest, runtimeProfile };
  const claim = sessionSendExecutionClaimSchema.parse({ version: 1, mode: "direct", attemptId, ownerDigest,
    daemonGeneration: daemon.generation, bootId: daemon.boot_id, executionAuthority: owner.sourceAuthority,
    sessionRevision: owner.sourceSessionRevision, sessionAuthorityRevision: owner.sourceAuthorityRevision,
    providerThreadId: owner.sourceThreadId, clientMessageId: attemptId, evidence,
    evidenceDigest: hash(JSON.stringify(evidence)), createdAt: owner.createdAt + 1 });
  const claimDigest = ownerHash("claim", claim);
  const outcome = sessionSendOutcomeSchema.parse({ version: 1, attemptId, ordinal: 1, ownerDigest, claimDigest,
    previousDigest: null, outcome: { kind: "accepted", receipt: { turnId: "synthetic-component-turn", status: "completed",
      sourceId: attemptId, effectiveRuntimeProfile: runtimeProfile } }, recordedAt: owner.createdAt + 2 });
  if (outcome.outcome.kind !== "accepted") throw new Error("Synthetic outcome type mismatch.");
  const receipt = JSON.stringify(outcome.outcome.receipt);
  const outcomeDigest = ownerHash("outcome", outcome);
  const terminalDigest = custodyHash({ attemptId, ownerDigest, outcomes: [outcome] });
  database.transaction(() => {
    database.query("INSERT INTO session_send_execution_claims VALUES(?,?,?,?)")
      .run(attemptId, owner.idempotencyKey, JSON.stringify(claim), claimDigest);
    database.query("INSERT INTO session_send_owner_anchors VALUES(?,?,'claim',?)").run(attemptId, owner.idempotencyKey, claimDigest);
    database.query("INSERT INTO mutation_effect_evidence VALUES(?,'session.send',?,?,?)")
      .run(attemptId, JSON.stringify(claim.evidence), claim.evidenceDigest, claim.createdAt);
    database.query("UPDATE mutation_attempts SET state='effect_started',updated_at=? WHERE id=? AND state='prepared'")
      .run(claim.createdAt, attemptId);
    database.query("INSERT INTO session_send_owner_outcomes VALUES(?,?,1,?,?)")
      .run(attemptId, owner.idempotencyKey, JSON.stringify(outcome), outcomeDigest);
    database.query("INSERT INTO session_send_owner_anchors VALUES(?,?,'outcome_1',?)")
      .run(attemptId, owner.idempotencyKey, outcomeDigest);
    database.query("UPDATE mutation_attempts SET state='applied',result_json=?,updated_at=? WHERE id=? AND state='effect_started'")
      .run(receipt, outcome.recordedAt, attemptId);
    database.query("UPDATE mutation_attempts SET attachment_cleanup_terminal_digest=? WHERE id=?")
      .run(terminalDigest, attemptId);
    const parent = z.object({ attachment_input_format: z.string().nullable(), attachment_custody_id: z.string().nullable() }).strict().parse(
      database.query("SELECT attachment_input_format,attachment_custody_id FROM mutation_attempts WHERE id=?").get(attemptId),
    );
    if (parent.attachment_input_format === null) {
      database.query("UPDATE attachment_legacy_cleanup_blockers SET terminal_digest=? WHERE attempt_id=?").run(terminalDigest, attemptId);
      database.query("UPDATE attachment_custody_anchors SET released_by=? WHERE id=?").run(terminalDigest, `legacy:${attemptId}`);
    } else if (parent.attachment_custody_id !== null) {
      const { digest: previousDigest } = z.object({ digest: z.string() }).strict().parse(database.query(
        "SELECT digest FROM attachment_custody_dispositions WHERE custody_id=? AND ordinal=1",
      ).get(parent.attachment_custody_id));
      const body = { custody_id: parent.attachment_custody_id, ordinal: 2, original_key: owner.idempotencyKey,
        predecessor: previousDigest, kind: "terminal", attempt_id: attemptId,
        proof_json: JSON.stringify({ terminalDigest }), recorded_at: outcome.recordedAt };
      const dispositionDigest = custodyHash(body);
      database.query("INSERT INTO attachment_custody_dispositions VALUES(?,?,?,?,?,?,?,?,?)")
        .run(body.custody_id, body.ordinal, body.original_key, body.predecessor, body.kind, body.attempt_id,
          body.proof_json, dispositionDigest, body.recorded_at);
      database.query("UPDATE attachment_custody_sets SET released_by=? WHERE id=?").run(dispositionDigest, body.custody_id);
      database.query("UPDATE attachment_custody_anchors SET released_by=? WHERE id=?").run(dispositionDigest, body.custody_id);
      database.query("DELETE FROM attachment_custody_slots WHERE custody_id=?").run(body.custody_id);
    }
  }).immediate();
  const parent = z.object({ attachment_custody_id: z.string().nullable(), attachment_input_format: z.string().nullable() }).strict().parse(
    database.query("SELECT attachment_custody_id,attachment_input_format FROM mutation_attempts WHERE id=?").get(attemptId),
  );
  expect(parent.attachment_input_format).toBe(capture.inputFormat);
  expect(snapshot(database).schema).toEqual(original.schema);
  expect(snapshot(database).rows.migrations).toEqual(original.rows.migrations);
  expect(snapshot(database).version).toEqual(original.version);
  expect(snapshot(database).foreignKeys).toEqual([]);
  expect(bytes).toEqual(originalBytes);
  return { database, attemptId, idempotencyKey: owner.idempotencyKey, custodyId: parent.attachment_custody_id, terminalDigest };
}

// Deliberately damaged component evidence, not an archived producer capture.
// Restore the exact guards before the audit and no-write comparison.
function corrupt(database: Database, table: string, change: () => void) {
  const schema = snapshot(database).schema;
  const triggers = z.array(z.object({ name: z.string().regex(/^[a-z_0-9]+$/u), sql: z.string() }).strict()).parse(
    database.query("SELECT name,sql FROM sqlite_master WHERE type='trigger' AND tbl_name=? ORDER BY name").all(table),
  );
  database.transaction(() => {
    for (const trigger of triggers) database.exec(`DROP TRIGGER "${trigger.name}"`);
    change();
    for (const trigger of triggers) database.exec(trigger.sql);
  }).immediate();
  expect(snapshot(database).schema).toEqual(schema);
}

describe("historical custody terminal owner evidence", () => {
  for (const capture of captures) {
    test(`${capture.name}: explicit historical audit does not require newly installed provenance`, async () => {
      const { database, attemptId, custodyId, terminalDigest } = await settledFixture(capture);
      const before = snapshot(database);
      database.transaction(() => {
        expect(() => auditSessionSendOwners(database, { kind: "historical", format: capture.format })).not.toThrow();
        expect(() => auditAttachmentCustody(database, { kind: "historical", format: capture.format })).not.toThrow();
      }).immediate();
      expect(snapshot(database)).toEqual(before);
      expect(() => requireSessionSendOwner(database, { attemptId })).toThrow();
      expect(() => attachmentTerminalProof(database, attemptId)).toThrow();
      expect(() => readAttachmentParent(database, attemptId)).toThrow();
      if (custodyId !== null) expect(() => readAttachmentSet(database, custodyId)).toThrow();
      expect(snapshot(database)).toEqual(before);
      database.transaction(() => {
        applyEffectEvidenceProvenance(database, capture.format);
        applyJoinedAttachmentTerminalGuard(database);
      }).immediate();
      const selected = snapshot(database);
      expect(attachmentTerminalProof(database, attemptId)).toBe(terminalDigest);
      expect(() => auditAttachmentCustody(database, { kind: "source_selected", terminalGuard: "joined_v1" })).not.toThrow();
      expect(snapshot(database)).toEqual(selected);
    });
  }

  test("historical context is explicit, closed, transactional, and read-only", async () => {
    const { database, attemptId, idempotencyKey } = await settledFixture(captures[0]);
    const before = snapshot(database);
    expect(() => requireHistoricalSessionSendOwnerForAudit(database, { attemptId }, "private_task48_v1"))
      .toThrow("SESSION_SEND_OWNER_CORRUPT");
    expect(() => auditAttachmentCustody(database, { kind: "historical", format: "private_task48_v1" }))
      .toThrow("ATTACHMENT_CUSTODY_CORRUPT");
    database.transaction(() => {
      expect(requireHistoricalSessionSendOwnerForAudit(database, { attemptId }, "private_task48_v1"))
        .toEqual(requireHistoricalSessionSendOwnerForAudit(database, { idempotencyKey }, "private_task48_v1"));
      for (const lookup of [{ attemptId, idempotencyKey }, { attemptId: "not-an-attempt" }, { idempotencyKey: "not-a-key" }]) {
        expect(() => requireHistoricalSessionSendOwnerForAudit(database, lookup, "private_task48_v1"))
          .toThrow("SESSION_SEND_OWNER_CORRUPT");
      }
      const extraHistorical = { kind: "historical", format: "private_task48_v1", fallback: true } as const;
      const extraSelected = { kind: "source_selected", format: "private_task48_v1" } as const;
      expect(() => auditAttachmentCustody(database, extraHistorical)).toThrow("ATTACHMENT_CUSTODY_CORRUPT");
      expect(() => auditAttachmentCustody(database, extraSelected)).toThrow("ATTACHMENT_CUSTODY_CORRUPT");
      fc.assert(fc.property(fc.jsonValue(), (format) => {
        const known = format === "private_task48_v1" || format === "combined49_v1";
        expect(historicalSessionSendOwnerAuditFormatSchema.safeParse(format).success).toBe(known);
        if (!known) {
          expect(() => { Reflect.apply(requireHistoricalSessionSendOwnerForAudit, undefined, [database, { attemptId }, format]); })
            .toThrow("SESSION_SEND_OWNER_CORRUPT");
          expect(() => { Reflect.apply(auditAttachmentCustody, undefined, [database, { kind: "historical", format }]); })
            .toThrow("ATTACHMENT_CUSTODY_CORRUPT");
        }
      }), { seed: 68201, numRuns: 30 });
    }).immediate();
    expect(snapshot(database)).toEqual(before);
  });

  for (const kind of ["owner outcome digest", "terminal parent digest", "terminal proof extra key"] as const) {
    test(`historical context still refuses corrupt ${kind} without repair`, async () => {
      const capture = captures[1];
      const { database, attemptId, custodyId } = await settledFixture(capture);
      if (custodyId === null) throw new Error("Expected retained synthetic component input.");
      database.transaction(() => auditAttachmentCustody(database, { kind: "historical", format: capture.format })).immediate();
      if (kind === "owner outcome digest") {
        corrupt(database, "session_send_owner_outcomes", () => database.query(
          "UPDATE session_send_owner_outcomes SET outcome_digest=? WHERE attempt_id=? AND ordinal=1",
        ).run("a".repeat(64), attemptId));
      } else if (kind === "terminal parent digest") {
        corrupt(database, "mutation_attempts", () => database.query(
          "UPDATE mutation_attempts SET attachment_cleanup_terminal_digest=? WHERE id=?",
        ).run("a".repeat(64), attemptId));
      } else {
        corrupt(database, "attachment_custody_dispositions", () => database.query(
          "UPDATE attachment_custody_dispositions SET proof_json=json_set(proof_json,'$.unproved',1) WHERE custody_id=? AND ordinal=2",
        ).run(custodyId));
      }
      const before = snapshot(database);
      expect(() => database.transaction(() => auditAttachmentCustody(database, { kind: "historical", format: capture.format })).immediate())
        .toThrow();
      expect(snapshot(database)).toEqual(before);
    });
  }
});
