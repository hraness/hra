import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";

import { z } from "zod";

import { providerAccountAuthoritySchema } from "../domain/provider-accounts";
import { attemptIdSchema, sessionIdSchema } from "../domain/values";
import { readClaudeProcessCustody } from "./claude-process-custody";
import { assertSchemaCohortObjects, schemaCohortObjects } from "./schema-cohort";

const integer = z.number().int().nonnegative().safe();
const positive = integer.refine((value) => value > 0);
const digestSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const accountKeySchema = z.string().regex(/^v1:(codex|claude):[a-f0-9]{64}$/u);
const originSchema = z.object({
  attemptId: attemptIdSchema,
  sessionId: sessionIdSchema,
  requestDigest: digestSchema,
  sourceAuthority: providerAccountAuthoritySchema,
  targetAuthority: providerAccountAuthoritySchema,
  sourceProviderThreadId: z.string().min(1).max(200),
  originalSessionRevision: positive,
  originalAuthorityRevision: positive,
  createdAt: integer,
}).strict().refine((value) => value.sourceAuthority.provider !== "devin"
  && value.targetAuthority.provider !== "devin", "Retired providers cannot acquire new switch custody.");
export type SessionSwitchAdoptionOrigin = z.infer<typeof originSchema>;

const capsuleSchema = z.object({
  version: z.literal(1),
  sourceRuntimeScope: z.enum(["managed", "personal"]),
  sourceAccountKey: accountKeySchema,
  sourcePersonalBindingRevision: positive.nullable(),
  sourceProfileGeneration: integer,
  sourceClaudeProcessDigest: digestSchema.nullable(),
  targetAccountKey: accountKeySchema,
  targetProfileGeneration: integer,
}).strict().refine((value) => (value.sourceRuntimeScope === "personal")
  === (value.sourcePersonalBindingRevision !== null));
export type SessionSwitchAdoptionCapsule = z.infer<typeof capsuleSchema>;

const rowSchema = z.object({
  attempt_id: z.string().max(16_384),
  digest: digestSchema,
  kind: z.enum(["exact_v1", "legacy_read_only"]),
  origin_json: z.string().max(16_384),
  capsule_json: z.string().max(4_096).nullable(),
}).strict();
type CapsuleRow = z.infer<typeof rowSchema>;
const fail: () => never = () => { throw new Error("SESSION_SWITCH_ADOPTION_CUSTODY_CORRUPT"); };
const digest = (kind: CapsuleRow["kind"], origin: string, capsule: string | null): string =>
  createHash("sha256").update(JSON.stringify([
    "hra:session-switch-adoption:v1", kind, origin, capsule,
  ])).digest("hex");

// These are immutable parent fields. Malformed private-cohort journals retain
// their literal values in a read-only origin; they never become live authority.
const originFromParent = (value: unknown): unknown => {
  const row = z.record(z.string(), z.unknown()).parse(value);
  const authority = (side: "source" | "target"): unknown => ({
    profileId: row[`${side}_profile_id`],
    bindingGeneration: row[`${side}_binding_generation`],
    processGeneration: row[`${side}_process_generation`],
    provider: row[`${side}_provider`],
    providerAccountId: row[`${side}_provider_account_id`],
  });
  return {
    attemptId: row.attempt_id,
    sessionId: row.session_id,
    requestDigest: row.request_digest,
    sourceAuthority: authority("source"),
    targetAuthority: authority("target"),
    sourceProviderThreadId: row.source_provider_thread_id,
    originalSessionRevision: row.original_session_revision,
    originalAuthorityRevision: row.original_authority_revision,
    createdAt: row.created_at,
  };
};

const originJoin = (parent: string, proof = "proof"): string => [
  ["attemptId", "attempt_id"], ["sessionId", "session_id"],
  ["requestDigest", "request_digest"], ["sourceProviderThreadId", "source_provider_thread_id"],
  ["originalSessionRevision", "original_session_revision"],
  ["originalAuthorityRevision", "original_authority_revision"], ["createdAt", "created_at"],
  ...["source", "target"].flatMap((side) => [
    [`${side}Authority.profileId`, `${side}_profile_id`],
    [`${side}Authority.providerAccountId`, `${side}_provider_account_id`],
    [`${side}Authority.provider`, `${side}_provider`],
    [`${side}Authority.bindingGeneration`, `${side}_binding_generation`],
    [`${side}Authority.processGeneration`, `${side}_process_generation`],
  ]),
].map(([path, column]) => `json_extract(${proof}.origin_json,'$.${path}') IS ${parent}.${column}`).join(" AND ");

const currentAccount = (side: "source" | "target", proof = "NEW", preparing = true): string => `EXISTS(
  SELECT 1 FROM provider_accounts a JOIN profiles p ON p.id=a.profile_id
  WHERE a.id=json_extract(${proof}.origin_json,'$.${side}Authority.providerAccountId')
    AND a.profile_id=json_extract(${proof}.origin_json,'$.${side}Authority.profileId')
    AND a.provider=json_extract(${proof}.origin_json,'$.${side}Authority.provider')
    AND a.binding_generation=json_extract(${proof}.origin_json,'$.${side}Authority.bindingGeneration')
    AND a.process_generation=json_extract(${proof}.origin_json,'$.${side}Authority.processGeneration')
    AND a.provider IN ('codex','claude')
    AND (a.readiness='signed_in'${side === "source" ? `
      OR (a.provider='claude' AND a.readiness='unverified'
        AND json_extract(${proof}.capsule_json,'$.sourceRuntimeScope')='personal')` : ""})
    AND (${preparing ? "0" : "a.provider='claude'"}
      OR p.process_generation=json_extract(${proof}.capsule_json,'$.${side}ProfileGeneration'))
    AND p.state IN ('signed_in','signed_out')
    AND (a.provider!='codex' OR p.codex_account_key=json_extract(${proof}.capsule_json,'$.${side}AccountKey'))
    AND NOT EXISTS(SELECT 1 FROM provider_runtime_account_revocations r
      WHERE r.profile_id=p.id AND r.provider=a.provider
        AND (r.provider='claude' OR r.profile_generation=p.process_generation)
        AND r.runtime_scope=${side === "source" ? `json_extract(${proof}.capsule_json,'$.sourceRuntimeScope')` : "'managed'"}
        AND (r.state='releasing' OR r.current_account_key IS NOT json_extract(${proof}.capsule_json,'$.${side}AccountKey')))
)`;

const closedObject = (json: string, path: string, keys: readonly string[]): string => `(
  json_type(${json},'${path}') IS 'object'
  AND (SELECT COUNT(*) FROM json_each(${json},'${path}'))=${keys.length}
  AND (SELECT COUNT(DISTINCT key) FROM json_each(${json},'${path}'))=${keys.length}
  AND NOT EXISTS(SELECT 1 FROM json_each(${json},'${path}') WHERE key NOT IN (${keys.map((key) => `'${key}'`).join(",")})))`;
const safeInteger = (json: string, path: string, minimum = 0): string => `(
  json_type(${json},'${path}') IS 'integer'
  AND json_extract(${json},'${path}') BETWEEN ${minimum} AND 9007199254740991)`;
const hexString = (json: string, path: string, prefix: string, length: number): string => `(
  json_type(${json},'${path}') IS 'text'
  AND length(json_extract(${json},'${path}'))=${prefix.length + length}
  AND substr(json_extract(${json},'${path}'),1,${prefix.length})='${prefix}'
  AND substr(json_extract(${json},'${path}'),${prefix.length + 1}) NOT GLOB '*[^a-f0-9]*')`;
const exactJsonShape = `
  ${closedObject("NEW.origin_json", "$", ["attemptId", "sessionId", "requestDigest", "sourceAuthority", "targetAuthority", "sourceProviderThreadId", "originalSessionRevision", "originalAuthorityRevision", "createdAt"])}
  AND ${closedObject("NEW.capsule_json", "$", ["version", "sourceRuntimeScope", "sourceAccountKey", "sourcePersonalBindingRevision", "sourceProfileGeneration", "sourceClaudeProcessDigest", "targetAccountKey", "targetProfileGeneration"])}
  AND ${hexString("NEW.origin_json", "$.attemptId", "attempt_", 32)}
  AND ${hexString("NEW.origin_json", "$.sessionId", "sess_", 32)}
  AND ${hexString("NEW.origin_json", "$.requestDigest", "", 64)}
  AND json_type(NEW.origin_json,'$.sourceProviderThreadId') IS 'text'
  AND length(json_extract(NEW.origin_json,'$.sourceProviderThreadId')) BETWEEN 1 AND 200
  AND ${safeInteger("NEW.origin_json", "$.originalSessionRevision", 1)}
  AND ${safeInteger("NEW.origin_json", "$.originalAuthorityRevision", 1)}
  AND ${safeInteger("NEW.origin_json", "$.createdAt")}
  AND json_type(NEW.capsule_json,'$.version') IS 'integer'
  AND json_extract(NEW.capsule_json,'$.sourceRuntimeScope') IN ('managed','personal')
  AND (json_type(NEW.capsule_json,'$.sourcePersonalBindingRevision') IS 'null'
    OR ${safeInteger("NEW.capsule_json", "$.sourcePersonalBindingRevision", 1)})
  AND (json_type(NEW.capsule_json,'$.sourceClaudeProcessDigest') IS 'null'
    OR ${hexString("NEW.capsule_json", "$.sourceClaudeProcessDigest", "", 64)})
  AND ${["source", "target"].map((side) => `(
    ${closedObject("NEW.origin_json", `$.${side}Authority`, ["profileId", "providerAccountId", "provider", "bindingGeneration", "processGeneration"])}
    AND ${hexString("NEW.origin_json", `$.${side}Authority.profileId`, "acct_", 32)}
    AND (${hexString("NEW.origin_json", `$.${side}Authority.providerAccountId`, "acct_", 32)}
      OR ${hexString("NEW.origin_json", `$.${side}Authority.providerAccountId`, "pact_", 32)})
    AND ${safeInteger("NEW.origin_json", `$.${side}Authority.bindingGeneration`, 1)}
    AND ${safeInteger("NEW.origin_json", `$.${side}Authority.processGeneration`)}
    AND ${safeInteger("NEW.capsule_json", `$.${side}ProfileGeneration`)}
    AND ((json_extract(NEW.origin_json,'$.${side}Authority.provider')='codex'
      AND ${hexString("NEW.origin_json", `$.${side}Authority.providerAccountId`, "acct_", 32)}
      AND ${hexString("NEW.capsule_json", `$.${side}AccountKey`, "v1:codex:", 64)})
      OR (json_extract(NEW.origin_json,'$.${side}Authority.provider')='claude'
        AND ${hexString("NEW.origin_json", `$.${side}Authority.providerAccountId`, "pact_", 32)}
        AND ${hexString("NEW.capsule_json", `$.${side}AccountKey`, "v1:claude:", 64)}))
  )`).join(" AND ")}`;

const activeJournal = "p.phase NOT IN ('seed_settled','failed','cancelled','abandoned')";
const releasedSource = `EXISTS(SELECT 1 FROM session_switch_source_release_receipts released
  WHERE released.attempt_id=p.attempt_id AND released.provider_thread_id=p.source_provider_thread_id)
  AND (p.source_provider='codex' OR EXISTS(SELECT 1 FROM session_claude_process_authorities child
    WHERE child.session_id=p.session_id AND child.profile_id=p.source_profile_id
      AND child.provider_thread_id=p.source_provider_thread_id
      AND child.runtime_scope=json_extract(proof.capsule_json,'$.sourceRuntimeScope')
      AND child.provider_authority_digest=json_extract(proof.capsule_json,'$.sourceClaudeProcessDigest')
      AND child.state='released'))`;
const rebindJournal = `FROM session_switch_attempts p
  JOIN session_switch_adoption_capsules proof ON proof.attempt_id=p.attempt_id AND proof.kind='exact_v1'
  JOIN session_switch_adoption_anchors anchor ON anchor.attempt_id=proof.attempt_id AND anchor.digest=proof.digest
  JOIN session_switch_target_start_receipts target ON target.attempt_id=p.attempt_id
  WHERE p.phase='source_released' AND target.state='idle' AND target.active_turn_id IS NULL
    AND ${originJoin("p")} AND ${releasedSource}`;

const effectReceiptTables = [
  "target_start_receipts", "source_release_receipts", "rebind_receipts", "seed_authorities",
  "seed_receipts", "no_effect_receipts", "reconciliation_receipts", "abandon_receipts",
  "target_start_anchors", "source_release_anchors", "rebind_anchors", "seed_anchors",
  "no_effect_anchors", "reconciliation_anchors", "abandon_anchors",
] as const;
const noEffectReceipts = (mutation: string): string => effectReceiptTables.map((table) =>
  `NOT EXISTS(SELECT 1 FROM session_switch_${table} WHERE attempt_id=${mutation}.id)`).join(" AND ");

// Containment derives identity from independent immutable evidence, never from
// the broken journal field. This predicate cannot authorize a provider effect.
const containmentAssociation = (parent: string, proof: string, mutation: string): string => `
  ${proof}.kind='exact_v1'
  AND ${proof}.attempt_id=${mutation}.id
  AND json_extract(${proof}.origin_json,'$.attemptId')=${mutation}.id
  AND ${mutation}.kind='session.switch'
  AND ${mutation}.authority_id=json_extract(${proof}.origin_json,'$.sessionId')
  AND ${mutation}.authority_generation=json_extract(${proof}.origin_json,'$.targetAuthority.processGeneration')
  AND ${mutation}.request_digest=json_extract(${proof}.origin_json,'$.requestDigest')
  AND ${mutation}.created_at=json_extract(${proof}.origin_json,'$.createdAt')
  AND (${mutation}.id=${parent}.attempt_id OR ${mutation}.idempotency_key=${parent}.request_key)
  AND (SELECT COUNT(*) FROM (SELECT id FROM mutation_attempts other
    WHERE other.id=${parent}.attempt_id OR other.idempotency_key=${parent}.request_key LIMIT 2))=1
  AND (SELECT COUNT(*) FROM (SELECT journal_sequence FROM session_switch_attempts other
    WHERE other.attempt_id=${mutation}.id OR other.request_key=${mutation}.idempotency_key LIMIT 2))=1
  AND (SELECT COUNT(*) FROM mutation_provider_authorities WHERE attempt_id=${mutation}.id)=2
  AND ${["source", "target"].map((side) => `EXISTS(
    SELECT 1 FROM mutation_provider_authorities a WHERE a.attempt_id=${mutation}.id AND a.role='${side}'
      AND a.provenance='session_switch_${side}' AND a.recorded_at=${mutation}.created_at
      AND a.profile_id=json_extract(${proof}.origin_json,'$.${side}Authority.profileId')
      AND a.provider_account_id=json_extract(${proof}.origin_json,'$.${side}Authority.providerAccountId')
      AND a.provider=json_extract(${proof}.origin_json,'$.${side}Authority.provider')
      AND a.binding_generation=json_extract(${proof}.origin_json,'$.${side}Authority.bindingGeneration')
      AND a.process_generation=json_extract(${proof}.origin_json,'$.${side}Authority.processGeneration'))`).join(" AND ")}`;

const dispositionIdentity = `d.journal_sequence=p.journal_sequence
  AND d.mutation_request_key=m.idempotency_key AND d.session_id=m.authority_id
  AND d.diagnostic_code='MALFORMED_SWITCH_RECORD' AND d.recorded_at>=m.created_at
  AND d.evidence_depth=CASE d.from_phase
    WHEN 'target_started' THEN 1 WHEN 'source_releasing' THEN 1 WHEN 'source_released' THEN 2
    WHEN 'rebound' THEN 3 WHEN 'seed_dispatching' THEN 4 WHEN 'seed_settled' THEN 5 ELSE 0 END`;
const originalSessionFenced = `EXISTS(SELECT 1 FROM sessions s WHERE s.id=m.authority_id
  AND s.state IN ('recovery_required','terminal') AND s.active_turn_id IS NULL)`;
const containmentParentUpdate = `EXISTS(
  SELECT 1 FROM session_switch_attempts p
  JOIN mutation_attempts m ON m.id=p.attempt_id OR m.idempotency_key=p.request_key
  JOIN session_switch_adoption_capsules proof ON proof.attempt_id=m.id
  JOIN session_switch_adoption_anchors anchor ON anchor.attempt_id=proof.attempt_id AND anchor.digest=proof.digest
  JOIN session_switch_malformed_dispositions d ON d.journal_sequence=p.journal_sequence
  WHERE p.journal_sequence=OLD.journal_sequence AND ${containmentAssociation("p", "proof", "m")}
    AND ${dispositionIdentity}
    AND NEW.journal_sequence=OLD.journal_sequence AND NEW.attempt_id=m.id
    AND (OLD.phase=d.from_phase OR OLD.phase=d.terminal_phase)
    AND ((NEW.phase=OLD.phase AND NEW.diagnostic_code IS OLD.diagnostic_code AND NEW.updated_at=OLD.updated_at)
      OR (NEW.phase=d.terminal_phase AND NEW.diagnostic_code='MALFORMED_SWITCH_RECORD'
        AND NEW.updated_at>=OLD.updated_at AND NEW.updated_at>=d.recorded_at))
    AND ((d.terminal_phase='cancelled' AND d.from_phase='prepared'
      AND m.state IN ('prepared','cancelled') AND ${noEffectReceipts("m")})
      OR (d.terminal_phase='reconciliation_required' AND ${originalSessionFenced}
        AND NOT (d.from_phase='prepared' AND m.state='prepared' AND ${noEffectReceipts("m")})))
)`;

export const SESSION_SWITCH_ADOPTION_TABLES = `
CREATE TABLE IF NOT EXISTS session_switch_adoption_capsules (
  attempt_id TEXT PRIMARY KEY REFERENCES session_switch_attempts(attempt_id) DEFERRABLE INITIALLY DEFERRED,
  digest TEXT NOT NULL CHECK(length(digest)=64 AND digest NOT GLOB '*[^a-f0-9]*'),
  kind TEXT NOT NULL CHECK(kind IN ('exact_v1','legacy_read_only')),
  origin_json TEXT NOT NULL CHECK(json_valid(origin_json) AND length(CAST(origin_json AS BLOB))<=16384),
  capsule_json TEXT CHECK(capsule_json IS NULL OR (json_valid(capsule_json) AND length(CAST(capsule_json AS BLOB))<=4096)),
  UNIQUE(attempt_id,digest),
  FOREIGN KEY(attempt_id,digest) REFERENCES session_switch_adoption_anchors(attempt_id,digest) DEFERRABLE INITIALLY DEFERRED,
  CHECK((kind='legacy_read_only' AND capsule_json IS NULL) OR (kind='exact_v1' AND capsule_json IS NOT NULL))
) STRICT;
CREATE TABLE IF NOT EXISTS session_switch_adoption_anchors (
  attempt_id TEXT PRIMARY KEY,
  digest TEXT NOT NULL,
  UNIQUE(attempt_id,digest),
  FOREIGN KEY(attempt_id,digest) REFERENCES session_switch_adoption_capsules(attempt_id,digest) DEFERRABLE INITIALLY DEFERRED
) STRICT;
`;
export const SESSION_SWITCH_ADOPTION_GUARDS = `
${["capsules", "anchors"].flatMap((suffix) => ["UPDATE", "DELETE"].map((verb) => `
CREATE TRIGGER IF NOT EXISTS session_switch_adoption_${suffix}_${verb.toLowerCase()}
BEFORE ${verb} ON session_switch_adoption_${suffix}
BEGIN SELECT RAISE(ABORT,'SESSION_SWITCH_ADOPTION_CUSTODY_CORRUPT'); END;
`)).join("\n")}
CREATE TRIGGER IF NOT EXISTS session_switch_adoption_capsule_insert
BEFORE INSERT ON session_switch_adoption_capsules
WHEN NEW.kind!='exact_v1' OR json_extract(NEW.capsule_json,'$.version') IS NOT 1
  OR COALESCE((${exactJsonShape}),0)=0
  OR json_extract(NEW.origin_json,'$.attemptId') IS NOT NEW.attempt_id
  OR NOT ${currentAccount("source")} OR NOT ${currentAccount("target")}
  OR NOT EXISTS(SELECT 1 FROM sessions s
    JOIN session_provider_authorities a ON a.session_id=s.id
    JOIN session_provider_account_authorities scope ON scope.session_id=s.id
    WHERE s.id=json_extract(NEW.origin_json,'$.sessionId')
      AND s.revision=json_extract(NEW.origin_json,'$.originalSessionRevision')
      AND s.provider_thread_id=json_extract(NEW.origin_json,'$.sourceProviderThreadId')
      AND s.profile_id=json_extract(NEW.origin_json,'$.sourceAuthority.profileId')
      AND s.provider_v39=json_extract(NEW.origin_json,'$.sourceAuthority.provider')
      AND s.state='idle' AND s.active_turn_id IS NULL
      AND a.authority_revision=json_extract(NEW.origin_json,'$.originalAuthorityRevision')
      AND a.profile_id=s.profile_id AND a.provider=s.provider_v39
      AND a.provider_account_id=json_extract(NEW.origin_json,'$.sourceAuthority.providerAccountId')
      AND a.binding_generation=json_extract(NEW.origin_json,'$.sourceAuthority.bindingGeneration')
      AND a.process_generation=json_extract(NEW.origin_json,'$.sourceAuthority.processGeneration')
      AND scope.provider=s.provider_v39
      AND scope.runtime_scope=json_extract(NEW.capsule_json,'$.sourceRuntimeScope')
      AND scope.account_key=json_extract(NEW.capsule_json,'$.sourceAccountKey')
      AND ((scope.runtime_scope='managed' AND json_type(NEW.capsule_json,'$.sourcePersonalBindingRevision')='null'
        AND NOT EXISTS(SELECT 1 FROM session_personal_runtime_bindings b WHERE b.session_id=s.id
          AND b.state!='detached'))
        OR (scope.runtime_scope='personal' AND EXISTS(SELECT 1 FROM session_personal_runtime_bindings b
          WHERE b.session_id=s.id AND b.provider=s.provider_v39 AND b.provider_thread_id=s.provider_thread_id
            AND b.state='active' AND b.revision=json_extract(NEW.capsule_json,'$.sourcePersonalBindingRevision'))))
      AND ((s.provider_v39='codex' AND json_type(NEW.capsule_json,'$.sourceClaudeProcessDigest')='null')
        OR (s.provider_v39='claude' AND EXISTS(SELECT 1 FROM session_claude_process_authorities c
          WHERE c.session_id=s.id AND c.profile_id=s.profile_id AND c.provider_thread_id=s.provider_thread_id
            AND c.runtime_scope=scope.runtime_scope AND c.state='bound'
            AND c.provider_authority_digest=json_extract(NEW.capsule_json,'$.sourceClaudeProcessDigest')))))
BEGIN SELECT RAISE(ABORT,'SESSION_SWITCH_ADOPTION_UNPROVED'); END;
CREATE TRIGGER IF NOT EXISTS session_switch_adoption_parent_insert
BEFORE INSERT ON session_switch_attempts
WHEN NOT EXISTS(SELECT 1 FROM session_switch_adoption_capsules proof
  JOIN session_switch_adoption_anchors anchor ON anchor.attempt_id=proof.attempt_id AND anchor.digest=proof.digest
  WHERE proof.attempt_id=NEW.attempt_id AND proof.kind='exact_v1' AND ${originJoin("NEW")})
BEGIN SELECT RAISE(ABORT,'SESSION_SWITCH_ADOPTION_UNPROVED'); END;
CREATE TRIGGER IF NOT EXISTS session_switch_adoption_parent_update
BEFORE UPDATE ON session_switch_attempts
WHEN NOT EXISTS(SELECT 1 FROM session_switch_adoption_capsules proof
  JOIN session_switch_adoption_anchors anchor ON anchor.attempt_id=proof.attempt_id AND anchor.digest=proof.digest
  WHERE proof.attempt_id=NEW.attempt_id AND ${originJoin("NEW")}
    AND (proof.kind='exact_v1' OR NEW.phase IS OLD.phase
      OR NEW.phase IN ('cancelled','abandoned','reconciliation_required')))
  AND NOT ${containmentParentUpdate}
BEGIN SELECT RAISE(ABORT,'SESSION_SWITCH_ADOPTION_UNPROVED'); END;
CREATE TRIGGER IF NOT EXISTS session_switch_adoption_rebind_receipt
BEFORE INSERT ON session_switch_rebind_receipts
WHEN NOT EXISTS(SELECT 1 ${rebindJournal}
  AND p.attempt_id=NEW.attempt_id AND NEW.session_revision=p.original_session_revision+1
  AND NEW.authority_revision=p.original_authority_revision+1
  AND ${currentAccount("source", "proof", false)} AND ${currentAccount("target", "proof", false)}
  AND EXISTS(SELECT 1 FROM session_provider_account_authorities scope
    WHERE scope.session_id=p.session_id AND scope.provider=p.source_provider
      AND scope.runtime_scope=json_extract(proof.capsule_json,'$.sourceRuntimeScope')
      AND scope.account_key=json_extract(proof.capsule_json,'$.sourceAccountKey'))
  AND (json_extract(proof.capsule_json,'$.sourceRuntimeScope')='managed'
    OR EXISTS(SELECT 1 FROM session_personal_runtime_bindings b WHERE b.session_id=p.session_id
      AND b.provider=p.source_provider AND b.provider_thread_id=p.source_provider_thread_id
      AND b.state='active' AND b.revision=json_extract(proof.capsule_json,'$.sourcePersonalBindingRevision')))
  AND (p.target_provider='codex' OR EXISTS(SELECT 1 FROM session_claude_process_authorities child
    JOIN session_claude_process_provider_authorities child_proof ON child_proof.digest=child.provider_authority_digest
    JOIN session_claude_process_provider_authorities launch
      ON launch.digest=json_extract(child_proof.proof_json,'$.launchDigest')
    WHERE child.session_id=p.session_id AND child.profile_id=p.target_profile_id
      AND child.runtime_scope='managed' AND child.provider_thread_id=target.provider_thread_id AND child.state='claimed'
      AND json_extract(child_proof.proof_json,'$.kind')='exact_provider_v1'
      AND json_extract(child_proof.proof_json,'$.authority.provider')=p.target_provider
      AND json_extract(child_proof.proof_json,'$.authority.profileId')=p.target_profile_id
      AND json_extract(child_proof.proof_json,'$.authority.providerAccountId')=p.target_provider_account_id
      AND json_extract(child_proof.proof_json,'$.authority.bindingGeneration')=p.target_binding_generation
      AND json_extract(child_proof.proof_json,'$.authority.processGeneration')=p.target_process_generation
      AND json_extract(launch.proof_json,'$.launchContext.switchAttemptId')=p.attempt_id
      AND json_extract(launch.proof_json,'$.launchContext.sessionId')=p.session_id
      AND json_extract(launch.proof_json,'$.launchContext.accountKey')=json_extract(proof.capsule_json,'$.targetAccountKey'))))
BEGIN SELECT RAISE(ABORT,'SESSION_SWITCH_ADOPTION_UNPROVED'); END;
CREATE TRIGGER IF NOT EXISTS session_switch_adoption_source_scope_delete
BEFORE DELETE ON session_provider_account_authorities
WHEN EXISTS(SELECT 1 FROM session_switch_attempts p WHERE p.session_id=OLD.session_id AND ${activeJournal})
  AND NOT EXISTS(SELECT 1 ${rebindJournal}
    AND p.session_id=OLD.session_id AND OLD.provider=p.source_provider
    AND OLD.runtime_scope=json_extract(proof.capsule_json,'$.sourceRuntimeScope')
    AND OLD.account_key=json_extract(proof.capsule_json,'$.sourceAccountKey')
    AND EXISTS(SELECT 1 FROM session_switch_rebind_receipts receipt WHERE receipt.attempt_id=p.attempt_id))
BEGIN SELECT RAISE(ABORT,'SESSION_SWITCH_ADOPTION_UNPROVED'); END;
CREATE TRIGGER IF NOT EXISTS session_switch_adoption_target_scope_insert
BEFORE INSERT ON session_provider_account_authorities
WHEN EXISTS(SELECT 1 FROM session_switch_attempts p WHERE p.session_id=NEW.session_id AND ${activeJournal})
  AND NOT EXISTS(SELECT 1 ${rebindJournal}
    AND p.session_id=NEW.session_id AND NEW.provider=p.target_provider AND NEW.runtime_scope='managed'
    AND NEW.account_key=json_extract(proof.capsule_json,'$.targetAccountKey')
    AND EXISTS(SELECT 1 FROM session_switch_rebind_receipts receipt
      JOIN sessions s ON s.id=p.session_id JOIN session_provider_authorities a ON a.session_id=s.id
      WHERE receipt.attempt_id=p.attempt_id AND s.revision=receipt.session_revision
        AND s.profile_id=p.target_profile_id AND s.provider_v39=p.target_provider
        AND s.provider_thread_id=target.provider_thread_id AND a.authority_revision=receipt.authority_revision
        AND a.provider_account_id=p.target_provider_account_id AND a.profile_id=p.target_profile_id
        AND a.provider=p.target_provider AND a.binding_generation=p.target_binding_generation
        AND a.process_generation=p.target_process_generation))
BEGIN SELECT RAISE(ABORT,'SESSION_SWITCH_ADOPTION_UNPROVED'); END;
CREATE TRIGGER IF NOT EXISTS session_switch_adoption_personal_binding_update
BEFORE UPDATE ON session_personal_runtime_bindings
WHEN EXISTS(SELECT 1 FROM session_switch_attempts p WHERE p.session_id=OLD.session_id AND ${activeJournal})
  AND NOT EXISTS(SELECT 1 ${rebindJournal}
    AND p.session_id=OLD.session_id AND NEW.session_id=OLD.session_id AND NEW.provider=OLD.provider
    AND NEW.provider_thread_id=OLD.provider_thread_id AND OLD.provider=p.source_provider
    AND OLD.provider_thread_id=p.source_provider_thread_id AND OLD.state='active' AND NEW.state='detached'
    AND OLD.revision=json_extract(proof.capsule_json,'$.sourcePersonalBindingRevision')
    AND NEW.revision=OLD.revision+1
    AND EXISTS(SELECT 1 FROM session_switch_rebind_receipts receipt WHERE receipt.attempt_id=p.attempt_id))
BEGIN SELECT RAISE(ABORT,'SESSION_SWITCH_ADOPTION_UNPROVED'); END;
CREATE TRIGGER IF NOT EXISTS session_switch_adoption_personal_binding_delete
BEFORE DELETE ON session_personal_runtime_bindings
WHEN EXISTS(SELECT 1 FROM session_switch_attempts p WHERE p.session_id=OLD.session_id AND ${activeJournal})
BEGIN SELECT RAISE(ABORT,'SESSION_SWITCH_ADOPTION_UNPROVED'); END;
`;

const insertRows = (database: Database, kind: CapsuleRow["kind"], origin: unknown,
  capsule: SessionSwitchAdoptionCapsule | null): void => {
  const originJson = JSON.stringify(origin);
  const capsuleJson = capsule === null ? null : JSON.stringify(capsule);
  const attemptId = z.object({ attemptId: z.string() }).parse(origin).attemptId;
  if (Buffer.byteLength(originJson) > 16_384) fail();
  const key = digest(kind, originJson, capsuleJson);
  database.query("INSERT INTO session_switch_adoption_capsules(attempt_id,digest,kind,origin_json,capsule_json) VALUES(?,?,?,?,?)")
    .run(attemptId, key, kind, originJson, capsuleJson);
  database.query("INSERT INTO session_switch_adoption_anchors(attempt_id,digest) VALUES(?,?)")
    .run(attemptId, key);
};

/** Caller owns the prepare IMMEDIATE transaction, before inserting its parent. */
export const insertSessionSwitchAdoption = (database: Database, input: Readonly<{
  origin: SessionSwitchAdoptionOrigin;
  targetAccountKey: string;
}>): SessionSwitchAdoptionCapsule => {
  const origin = originSchema.parse(input.origin);
  const scope = z.object({ provider: z.enum(["codex", "claude"]), runtime_scope: z.enum(["managed", "personal"]),
    account_key: accountKeySchema }).strict().parse(database.query(
      "SELECT provider,runtime_scope,account_key FROM session_provider_account_authorities WHERE session_id=?",
    ).get(origin.sessionId));
  if (scope.provider !== origin.sourceAuthority.provider) fail();
  const generation = (id: string): number => z.object({ process_generation: integer }).strict().parse(
    database.query("SELECT process_generation FROM profiles WHERE id=?").get(id),
  ).process_generation;
  const binding = scope.runtime_scope === "personal"
    ? z.object({ revision: positive }).strict().parse(database.query(
        "SELECT revision FROM session_personal_runtime_bindings WHERE session_id=? AND provider=? AND provider_thread_id=? AND state='active'",
      ).get(origin.sessionId, scope.provider, origin.sourceProviderThreadId)).revision
    : null;
  let processDigest: string | null = null;
  if (scope.provider === "claude") {
    const raw = database.query("SELECT * FROM session_claude_process_authorities WHERE session_id=? AND profile_id=? AND runtime_scope=? AND provider_thread_id=? AND state='bound'")
      .get(origin.sessionId, origin.sourceAuthority.profileId, scope.runtime_scope, origin.sourceProviderThreadId);
    const proof = readClaudeProcessCustody(database, "process", raw);
    if (proof.authority === null || JSON.stringify(proof.authority) !== JSON.stringify(origin.sourceAuthority)) fail();
    processDigest = z.object({ provider_authority_digest: digestSchema }).parse(raw).provider_authority_digest;
  }
  const capsule = capsuleSchema.parse({
    version: 1, sourceRuntimeScope: scope.runtime_scope, sourceAccountKey: scope.account_key,
    sourcePersonalBindingRevision: binding, sourceProfileGeneration: generation(origin.sourceAuthority.profileId),
    sourceClaudeProcessDigest: processDigest, targetAccountKey: input.targetAccountKey,
    targetProfileGeneration: generation(origin.targetAuthority.profileId),
  });
  if (!capsule.sourceAccountKey.startsWith(`v1:${origin.sourceAuthority.provider}:`)
    || !capsule.targetAccountKey.startsWith(`v1:${origin.targetAuthority.provider}:`)) fail();
  insertRows(database, "exact_v1", origin, capsule);
  return capsule;
};

const readSelf = (database: Database, attemptId: string): CapsuleRow => {
  const parsed = rowSchema.safeParse(database.query(`SELECT
    CASE WHEN length(CAST(attempt_id AS BLOB))<=16384 THEN attempt_id END AS attempt_id,
    CASE WHEN length(digest)=64 THEN digest END AS digest,
    CASE WHEN length(kind)<=32 THEN kind END AS kind,
    CASE WHEN length(CAST(origin_json AS BLOB))<=16384 THEN origin_json END AS origin_json,
    CASE WHEN capsule_json IS NULL OR length(CAST(capsule_json AS BLOB))<=4096
      THEN capsule_json ELSE '' END AS capsule_json
    FROM session_switch_adoption_capsules WHERE attempt_id=?`).get(attemptId));
  if (!parsed.success) fail();
  const row = parsed.data;
  const anchor = database.query("SELECT 1 FROM session_switch_adoption_anchors WHERE attempt_id=? AND digest=?")
    .get(attemptId, row.digest);
  if (anchor === null || digest(row.kind, row.origin_json, row.capsule_json) !== row.digest) fail();
  if (row.kind === "legacy_read_only") {
    if (row.capsule_json !== null) fail();
    return row;
  }
  const origin = originSchema.parse(JSON.parse(row.origin_json) as unknown);
  const capsule = capsuleSchema.parse(JSON.parse(row.capsule_json ?? "null") as unknown);
  if (origin.attemptId !== row.attempt_id || JSON.stringify(origin) !== row.origin_json
    || JSON.stringify(capsule) !== row.capsule_json
    || !capsule.sourceAccountKey.startsWith(`v1:${origin.sourceAuthority.provider}:`)
    || !capsule.targetAccountKey.startsWith(`v1:${origin.targetAuthority.provider}:`)
    || (origin.sourceAuthority.provider === "claude") !== (capsule.sourceClaudeProcessDigest !== null)) fail();
  return row;
};

const parentColumns = [
  "journal_sequence", "request_key", "phase", "diagnostic_code", "updated_at",
  "attempt_id", "session_id", "request_digest", "source_provider_thread_id",
  "original_session_revision", "original_authority_revision", "created_at",
  ...["source", "target"].flatMap((side) => ["profile_id", "provider_account_id", "provider", "binding_generation", "process_generation"]
    .map((column) => `${side}_${column}`)),
] as const;
// A corrupt journal can contain arbitrarily oversized columns. Only bounded
// original identity projections cross this diagnostic reader's SQLite edge.
const parentProjection = parentColumns.map((column) =>
  `CASE WHEN length(CAST(${column} AS BLOB))<=512 THEN ${column} ELSE NULL END AS ${column}`).join(",");
const readRow = (database: Database, attemptId: string): CapsuleRow => {
  const row = readSelf(database, attemptId);
  const parent = database.query(`SELECT ${parentProjection} FROM session_switch_attempts WHERE attempt_id=?`).get(attemptId);
  if (parent === null || row.origin_json !== JSON.stringify(originFromParent(parent))) fail();
  return row;
};

/** Missing custody is corruption, never an implicit historical fallback. */
export const readSessionSwitchAdoption = (database: Database, attemptId: string): SessionSwitchAdoptionCapsule | null => {
  const row = readRow(database, attemptId);
  if (row.kind === "legacy_read_only") {
    if (row.capsule_json !== null) fail();
    return null;
  }
  return capsuleSchema.parse(JSON.parse(row.capsule_json ?? "null") as unknown);
};

/** Runs only after the owning migration has validated the exact prior cohort. */
export const applySessionSwitchAdoption = (database: Database): void => {
  if (database.query("SELECT 1 FROM sqlite_master WHERE name IN ('session_switch_adoption_capsules','session_switch_adoption_anchors')").get() !== null) fail();
  database.exec(SESSION_SWITCH_ADOPTION_TABLES);
  let after = 0;
  for (;;) {
    const rows = database.query("SELECT * FROM session_switch_attempts WHERE journal_sequence>? ORDER BY journal_sequence LIMIT 100").all(after);
    if (rows.length === 0) break;
    for (const row of rows) {
      insertRows(database, "legacy_read_only", originFromParent(row), null);
      after = z.object({ journal_sequence: positive }).parse(row).journal_sequence;
    }
  }
  database.exec(SESSION_SWITCH_ADOPTION_GUARDS);
};

export const assertSessionSwitchAdoptionSchema = (database: Database): void =>
  assertSchemaCohortObjects(database, schemaCohortObjects(SESSION_SWITCH_ADOPTION_TABLES,
    SESSION_SWITCH_ADOPTION_GUARDS), "session-switch-adoption49");

const terminalDisposition = (database: Database, journalSequence: number): boolean =>
  database.query(`SELECT 1 FROM session_switch_attempts p
    JOIN mutation_attempts m ON m.id=p.attempt_id
    JOIN session_switch_adoption_capsules proof ON proof.attempt_id=m.id
    JOIN session_switch_adoption_anchors anchor ON anchor.attempt_id=proof.attempt_id AND anchor.digest=proof.digest
    JOIN session_switch_malformed_dispositions d ON d.journal_sequence=p.journal_sequence
    WHERE p.journal_sequence=? AND ${containmentAssociation("p", "proof", "m")}
      AND ${dispositionIdentity}
      AND ((d.terminal_phase='cancelled' AND d.from_phase='prepared'
        AND p.phase='cancelled' AND p.diagnostic_code='MALFORMED_SWITCH_RECORD'
        AND m.state='cancelled' AND p.updated_at>=d.recorded_at AND m.updated_at>=d.recorded_at
        AND ${noEffectReceipts("m")})
      OR (d.terminal_phase='reconciliation_required' AND ${originalSessionFenced}
        AND ((d.from_phase IN ('failed','cancelled','seed_settled','abandoned') AND p.phase=d.from_phase
          AND m.state=CASE d.from_phase WHEN 'seed_settled' THEN 'applied' WHEN 'abandoned' THEN 'ambiguous' ELSE d.from_phase END)
          OR (d.from_phase='reconciliation_required' AND p.phase=d.from_phase AND m.state='ambiguous')
          OR (d.from_phase NOT IN ('prepared','failed','cancelled','seed_settled','abandoned','reconciliation_required')
            AND p.phase='reconciliation_required' AND m.state='ambiguous'
            AND p.diagnostic_code='MALFORMED_SWITCH_RECORD'
            AND m.result_json=json_object('code','MALFORMED_SWITCH_RECORD')
            AND p.updated_at>=d.recorded_at AND m.updated_at>=d.recorded_at)
          OR (d.from_phase='prepared' AND p.phase='prepared'
            AND NOT (m.state='prepared' AND ${noEffectReceipts("m")})))))
  `).get(journalSequence) !== null;

const validateJournal = (database: Database, journalSequence: number, beforeContainment: boolean): void => {
  const parent = z.record(z.string(), z.unknown()).parse(database.query(
    `SELECT ${parentProjection} FROM session_switch_attempts WHERE journal_sequence=?`,
  ).get(journalSequence));
  const hasDisposition = database.query("SELECT 1 FROM session_switch_malformed_dispositions WHERE journal_sequence=?")
    .get(journalSequence) !== null;
  const parentAttempt = z.string().max(512).nullable().parse(parent.attempt_id);
  const row = parentAttempt === null || database.query("SELECT 1 FROM session_switch_adoption_capsules WHERE attempt_id=?").get(parentAttempt) === null
    ? null : readSelf(database, parentAttempt);
  if (row !== null && row.origin_json === JSON.stringify(originFromParent(parent))
    && (!hasDisposition || row.kind === "legacy_read_only")) return;

  // One parent may nominate an ID and a request key, but disagreement between
  // two real mutations never chooses a winner. Both directions must be unique.
  const matches = z.object({ id: attemptIdSchema }).strict().array().parse(database.query(
    `SELECT id FROM mutation_attempts WHERE id=? OR idempotency_key=? LIMIT 2`,
  ).all(parentAttempt, z.string().max(512).nullable().parse(parent.request_key)));
  const match = matches[0];
  if (matches.length !== 1 || match === undefined) fail();
  const attemptId = match.id;
  const proof = readSelf(database, attemptId);
  if (proof.kind !== "exact_v1" || database.query(`SELECT 1 FROM session_switch_attempts p
    JOIN mutation_attempts m ON m.id=?
    JOIN session_switch_adoption_capsules proof ON proof.attempt_id=m.id
    WHERE p.journal_sequence=? AND ${containmentAssociation("p", "proof", "m")}`)
    .get(attemptId, journalSequence) === null) fail();
  if (hasDisposition) {
    if (!terminalDisposition(database, journalSequence)) fail();
  } else if (!beforeContainment) fail();
};

const audit = (database: Database, beforeContainment: boolean): void => {
  assertSessionSwitchAdoptionSchema(database);
  let after = 0;
  for (;;) {
    const rows = z.object({ journal_sequence: positive }).strict().array().parse(
      database.query("SELECT journal_sequence FROM session_switch_attempts WHERE journal_sequence>? ORDER BY journal_sequence LIMIT 100").all(after),
    );
    if (rows.length === 0) break;
    for (const row of rows) {
      validateJournal(database, row.journal_sequence, beforeContainment);
      after = row.journal_sequence;
    }
  }
  for (const table of ["capsules", "anchors"] as const) {
    if (database.query(`SELECT 1 FROM session_switch_adoption_${table} c
      LEFT JOIN mutation_attempts m ON m.id=c.attempt_id
      LEFT JOIN session_switch_attempts p ON p.attempt_id=c.attempt_id
        ${beforeContainment ? "OR p.request_key=m.idempotency_key" : ""}
      LEFT JOIN session_switch_adoption_${table === "capsules" ? "anchors" : "capsules"} other
        ON other.attempt_id=c.attempt_id AND other.digest=c.digest
      WHERE p.attempt_id IS NULL OR other.attempt_id IS NULL LIMIT 1`).get() !== null) fail();
  }
};

/** Final/reopen audit: mismatched journals require an exact terminal fence. */
export const auditSessionSwitchAdoption = (database: Database): void => audit(database, false);

/** Read-only recognition before the owning transaction performs containment. */
export const auditSessionSwitchAdoptionBeforeContainment = (database: Database): void =>
  audit(database, true);
