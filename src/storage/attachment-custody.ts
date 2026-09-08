import { createHash, randomUUID } from "node:crypto";
import type { Database } from "bun:sqlite";
import { z } from "zod";

import { attachmentReferenceListSchema } from "../domain/attachment-schemas";
import { isAttachmentImageMediaType, type AttachmentReference } from "../domain/attachments";
import { providerAccountAuthoritySchema, type ProviderAccountAuthority } from "../domain/provider-accounts";
import { reviewedRuntimeProfileSchema } from "../domain/runtime-profile";
import { sessionIdSchema, unixMillisecondsSchema, utf8Bytes } from "../domain/values";
import { ATTACHMENT_CUSTODY_COLUMNS, type InitialAttachmentInput } from "./attachment-custody-schema";
import { historicalSessionSendOwnerAuditFormatSchema, requireHistoricalSessionSendOwnerForAudit, requireSessionSendOwner } from "./session-send-owner";
import { queueAttachmentIdentityDigest, queueAttachmentManifestDigest, readQueueAttachmentIdentity } from "./queue-attachment-identity";
import { normalizeSchemaSql } from "./schema-cohort";
import { schemaSqlBeforeJoinedTranscriptColumns, type UsageSchemaColumnMode } from "./joined-transcript-columns";
import { checkMutationEvidenceEnvelope, EFFECT_EVIDENCE_JSON_MAX_BYTES, historicalEffectEvidenceFormatSchema } from "./effect-evidence-reader";
import { readMutationEffectEvidenceProvenance } from "./effect-evidence-provenance";
import { assertJoinedAttachmentTerminalGuard, installJoinedAttachmentTerminalGuard } from "./joined-attachment-terminal-guard";

export class AttachmentCustodyError extends Error {
  constructor(readonly code: "ATTACHMENT_CUSTODY_CORRUPT" | "ATTACHMENT_CUSTODY_REQUEST_CONFLICT"
    | "ATTACHMENT_CUSTODY_UNPROVED" | "ATTACHMENT_CUSTODY_AUTHORITY_CHANGED"
    | "ATTACHMENT_CUSTODY_LIMIT" | "ATTACHMENT_CUSTODY_INVALID_INPUT") { super(code); this.name = "AttachmentCustodyError"; }
}
function fail(code: AttachmentCustodyError["code"] = "ATTACHMENT_CUSTODY_CORRUPT"): never { throw new AttachmentCustodyError(code); }
const sha = (value: string): string => createHash("sha256").update(value).digest("hex");
const digest = z.string().regex(/^[a-f0-9]{64}$/u);
const custodyId = z.string().regex(/^custody_[a-f0-9]{32}$/u);
const generation = z.number().int().positive().safe();
const bootId = z.string().regex(/^boot_[a-f0-9]{32}$/u);
const operation = z.enum(["session.send", "session.steer", "session.queue"]);
export const attachmentDaemonSchema = z.object({ daemonGeneration: generation, bootId }).strict();
export type AttachmentDaemon = z.infer<typeof attachmentDaemonSchema>;
export type AttachmentReservation = Readonly<{ reservationId: string; reservationDigest: string }>;
export type AttachmentIngressInput = Readonly<{
  kind: "session.send" | "session.steer" | "session.queue"; sessionId: string; idempotencyKey: string;
  message: string; attachments: readonly AttachmentReference[]; providerAuthority: ProviderAccountAuthority;
  daemonGeneration: number; bootId: string;
}>;
export const parseAttachmentInput = (input: unknown): AttachmentIngressInput => {
  try {
    const parsed = z.object({ kind: operation, sessionId: sessionIdSchema, idempotencyKey: z.string().uuid(),
      message: z.string().min(1).max(262144).refine((value) => value.trim().length > 0), providerAuthority: providerAccountAuthoritySchema,
      attachments: z.union([z.tuple([]), attachmentReferenceListSchema]), daemonGeneration: generation, bootId }).strict().parse(input);
    if (!parsed.message.isWellFormed() || utf8Bytes(parsed.message) > 262144 || parsed.attachments.some((ref) => !ref.name.isWellFormed())) fail("ATTACHMENT_CUSTODY_INVALID_INPUT");
    return parsed;
  } catch (error) { if (error instanceof z.ZodError) fail("ATTACHMENT_CUSTODY_INVALID_INPUT"); throw error; }
};
export const attachmentReferencesDigest = (refs: readonly AttachmentReference[]): string => sha(JSON.stringify({
  domain: "hra:attachment-custody-references:v1", references: refs.map((ref) => [ref.byteLength, ref.digest, ref.mediaType, ref.name]),
}));
const memberSchema = z.object({ digest, canonicalMediaType: z.enum(["image/png", "image/jpeg", "image/gif", "image/webp", "text/plain"]),
  byteLength: z.number().int().min(1).max(5242880) }).strict();
const inputProofSchema = z.object({ version: z.literal(1), kind: operation, sessionId: sessionIdSchema,
  idempotencyKey: z.string().uuid(), authority: providerAccountAuthoritySchema, requestDigest: digest,
  messageDigest: digest, messageUtf8Bytes: z.number().int().min(0).max(262144), referenceDigest: digest,
  referenceCount: z.number().int().min(0).max(8), members: z.array(memberSchema).max(8), daemon: attachmentDaemonSchema.optional() }).strict()
  .refine((input) => input.referenceCount === input.members.length && (input.messageUtf8Bytes > 0 || input.referenceCount > 0)
    && input.members.reduce((total, member) => total + member.byteLength, 0) <= 10 * 1024 * 1024);
type InputProof = z.infer<typeof inputProofSchema>;
const originSchema = z.object({ version: z.literal(1), id: custodyId, input: inputProofSchema,
  daemonGeneration: generation, bootId, createdAt: unixMillisecondsSchema }).strict()
  .refine((origin) => origin.input.daemon?.daemonGeneration === origin.daemonGeneration && origin.input.daemon.bootId === origin.bootId);
type Origin = z.infer<typeof originSchema>;
const proofDigest = (value: unknown): string => sha(JSON.stringify({ domain: "hra:attachment-custody:v1", value }));
export function attachmentInputProof(input: Omit<AttachmentIngressInput, "daemonGeneration" | "bootId"> & Partial<AttachmentDaemon>, originalRequestDigest?: string): InputProof {
  const refs = input.attachments;
  const request = refs.length === 0 ? { message: input.message } : input.kind === "session.queue"
    ? { version: 2, message: input.message, attachments: refs } : { message: input.message, attachments: refs };
  const requestDigest = originalRequestDigest ?? sha(JSON.stringify({ kind: input.kind, authorityId: input.sessionId,
    authorityGeneration: input.providerAuthority.processGeneration, request }));
  return inputProofSchema.parse({ version: 1, kind: input.kind, sessionId: input.sessionId, idempotencyKey: input.idempotencyKey,
    authority: input.providerAuthority, requestDigest, messageDigest: sha(input.message), messageUtf8Bytes: utf8Bytes(input.message),
    referenceDigest: attachmentReferencesDigest(refs), referenceCount: refs.length,
    members: refs.map((ref) => ({ digest: ref.digest, canonicalMediaType: isAttachmentImageMediaType(ref.mediaType) ? ref.mediaType : "text/plain", byteLength: ref.byteLength })),
    ...(input.daemonGeneration === undefined && input.bootId === undefined ? {} : { daemon: { daemonGeneration: input.daemonGeneration, bootId: input.bootId } }) });
}
const tables = [
  { name: "attachment_custody_sets", sql: `CREATE TABLE IF NOT EXISTS attachment_custody_sets(
    id TEXT PRIMARY KEY, original_key TEXT NOT NULL, origin_json TEXT NOT NULL CHECK(json_valid(origin_json) AND length(CAST(origin_json AS BLOB))<=16384),
    digest TEXT NOT NULL UNIQUE CHECK(length(digest)=64), released_by TEXT REFERENCES attachment_custody_dispositions(digest) DEFERRABLE INITIALLY DEFERRED
  ) STRICT;` },
  { name: "attachment_custody_members", sql: `CREATE TABLE IF NOT EXISTS attachment_custody_members(
    custody_id TEXT NOT NULL REFERENCES attachment_custody_sets(id), position INTEGER NOT NULL CHECK(position BETWEEN 0 AND 7),
    digest TEXT NOT NULL CHECK(length(digest)=64), canonical_media_type TEXT NOT NULL CHECK(canonical_media_type IN ('image/png','image/jpeg','image/gif','image/webp','text/plain')),
    byte_length INTEGER NOT NULL CHECK(byte_length BETWEEN 1 AND 5242880), PRIMARY KEY(custody_id,position)
  ) STRICT;` },
  { name: "attachment_custody_anchors", sql: `CREATE TABLE IF NOT EXISTS attachment_custody_anchors(
    id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK(kind IN ('custody','empty_input_v1','legacy_unknown')),
    original_key TEXT NOT NULL, attempt_id TEXT REFERENCES mutation_attempts(id) DEFERRABLE INITIALLY DEFERRED,
    proof_json TEXT NOT NULL CHECK(json_valid(proof_json) AND length(CAST(proof_json AS BLOB))<=16384),
    digest TEXT UNIQUE CHECK(digest IS NULL OR length(digest)=64), released_by TEXT,
    CHECK((kind IS 'legacy_unknown' AND digest IS NULL AND attempt_id IS NOT NULL) OR (kind IS NOT 'legacy_unknown' AND digest IS NOT NULL)),
    CHECK(kind IS NOT 'empty_input_v1' OR (attempt_id IS NOT NULL AND released_by IS NULL))
  ) STRICT;` },
  { name: "attachment_custody_dispositions", sql: `CREATE TABLE IF NOT EXISTS attachment_custody_dispositions(
    custody_id TEXT NOT NULL REFERENCES attachment_custody_sets(id), ordinal INTEGER NOT NULL CHECK(ordinal IN (1,2)),
    original_key TEXT NOT NULL,
    predecessor TEXT REFERENCES attachment_custody_dispositions(digest), kind TEXT NOT NULL CHECK(kind IN ('released','boot_retired','queue_transferred','mutation_owned','terminal')),
    attempt_id TEXT REFERENCES mutation_attempts(id), proof_json TEXT NOT NULL CHECK(json_valid(proof_json) AND length(CAST(proof_json AS BLOB))<=16384),
    digest TEXT NOT NULL UNIQUE CHECK(length(digest)=64), recorded_at INTEGER NOT NULL CHECK(recorded_at>=0), PRIMARY KEY(custody_id,ordinal),
    CHECK((ordinal=1 AND predecessor IS NULL) OR (ordinal=2 AND predecessor IS NOT NULL AND kind='terminal')),
    CHECK(kind NOT IN ('mutation_owned','terminal') OR attempt_id IS NOT NULL)
  ) STRICT;` },
  { name: "attachment_custody_slots", sql: `CREATE TABLE IF NOT EXISTS attachment_custody_slots(
    slot INTEGER PRIMARY KEY CHECK(slot BETWEEN 1 AND 64), custody_id TEXT NOT NULL UNIQUE REFERENCES attachment_custody_sets(id), digest TEXT NOT NULL
  ) STRICT;` },
  { name: "attachment_legacy_cleanup_blockers", sql: `CREATE TABLE IF NOT EXISTS attachment_legacy_cleanup_blockers(
    attempt_id TEXT PRIMARY KEY REFERENCES mutation_attempts(id), original_key TEXT NOT NULL UNIQUE,
    origin_json TEXT NOT NULL CHECK(json_valid(origin_json) AND length(CAST(origin_json AS BLOB))<=16384), terminal_digest TEXT
  ) STRICT;` },
] as const;
const protectedMutation = (id: string) => `EXISTS(SELECT 1 FROM mutation_attempts retained WHERE retained.id=${id} AND retained.kind IN ('session.send','session.steer') AND retained.attachment_cleanup_terminal_digest IS NULL)`;
export const attachmentMutationProtectedSql = protectedMutation;
const unknownJson = (alias: string) => `json_object('attemptId',${alias}.id,'idempotencyKey',${alias}.idempotency_key,'kind',${alias}.kind,'sessionId',${alias}.authority_id,'authorityGeneration',${alias}.authority_generation,'requestDigest',${alias}.request_digest,'requestFormat',${alias}.request_format)`;
const nativeReceiptSql = (m: string, json: string, effect: string): string => `(CASE WHEN json_valid(${json}) THEN
  json_type(${json})='object' AND ((${m}.kind='session.send' AND json_type(${json},'$.turnId')='text'
    AND length(json_extract(${json},'$.turnId')) BETWEEN 1 AND 200 AND json_extract(${json},'$.sourceId')=${m}.id
    AND NOT EXISTS(SELECT 1 FROM json_each(${json}) WHERE key NOT IN ('turnId','sourceId','status','effectiveRuntimeProfile'))
    AND (json_type(${json},'$.status') IS NULL OR json_extract(${json},'$.status') IN ('completed','interrupted','failed','inProgress'))
    AND (json_type(${json},'$.effectiveRuntimeProfile') IS NULL OR json_extract(${json},'$.effectiveRuntimeProfile')=json_extract(${effect},'$.runtimeProfile')))
  OR (${m}.kind='session.steer' AND json_type(${json},'$.steered')='true'
    AND json_type(${json},'$.activeTurnId')='text' AND json_extract(${json},'$.activeTurnId')=json_extract(${effect},'$.activeTurnId')
    AND NOT EXISTS(SELECT 1 FROM json_each(${json}) WHERE key NOT IN ('steered','activeTurnId')))) ELSE 0 END) IS 1`;
/** SQL admission mirrors the closed terminal reader. A state/enum or arbitrary
 * JSON object alone cannot remove an entry from the independently live indexes. */
const terminalParentSql = (m: string): string => `(
  (${m}.request_format IS NOT NULL AND EXISTS(SELECT 1 FROM session_send_owner_outcomes outcome
    JOIN session_send_owner_anchors anchor ON anchor.attempt_id=outcome.attempt_id AND anchor.kind='outcome_'||outcome.ordinal
    JOIN session_send_owners owner ON owner.attempt_id=outcome.attempt_id
    LEFT JOIN session_send_execution_claims claim ON claim.attempt_id=owner.attempt_id
    LEFT JOIN session_send_owner_outcomes previous ON previous.attempt_id=owner.attempt_id AND previous.ordinal=1 AND outcome.ordinal=2
    WHERE outcome.attempt_id=${m}.id AND outcome.original_key=${m}.idempotency_key AND anchor.original_key=outcome.original_key
      AND owner.original_key=outcome.original_key AND anchor.digest=outcome.outcome_digest
      AND json_extract(outcome.outcome_json,'$.version')=1 AND json_extract(outcome.outcome_json,'$.attemptId')=${m}.id
      AND json_extract(outcome.outcome_json,'$.ordinal')=outcome.ordinal AND json_extract(outcome.outcome_json,'$.ownerDigest')=owner.owner_digest
      AND json_extract(outcome.outcome_json,'$.claimDigest') IS claim.claim_digest
      AND json_extract(outcome.outcome_json,'$.previousDigest') IS previous.outcome_digest
      AND json_type(outcome.outcome_json,'$.recordedAt')='integer' AND json_extract(outcome.outcome_json,'$.recordedAt')>=0
      AND (SELECT COUNT(*) FROM json_each(outcome.outcome_json))=8
      AND NOT EXISTS(SELECT 1 FROM json_each(outcome.outcome_json) WHERE key NOT IN ('version','attemptId','ordinal','ownerDigest','claimDigest','previousDigest','outcome','recordedAt'))
      AND ((outcome.ordinal=1 AND ${m}.updated_at=json_extract(outcome.outcome_json,'$.recordedAt')
          AND ${m}.state=CASE json_extract(outcome.outcome_json,'$.outcome.kind') WHEN 'accepted' THEN 'applied' WHEN 'cancelled' THEN 'cancelled' END
          AND ${m}.result_json IS json_extract(outcome.outcome_json,'$.outcome.receipt'))
        OR (outcome.ordinal=2 AND ${m}.state='ambiguous' AND json_extract(previous.outcome_json,'$.outcome.kind')='ambiguous'
          AND EXISTS(SELECT 1 FROM session_send_owner_anchors previous_anchor WHERE previous_anchor.attempt_id=owner.attempt_id
            AND previous_anchor.kind='outcome_1' AND previous_anchor.digest=previous.outcome_digest)
          AND EXISTS(SELECT 1 FROM mutation_resolutions resolution WHERE resolution.attempt_id=owner.attempt_id
            AND resolution.resolution_kind=CASE json_extract(outcome.outcome_json,'$.outcome.kind') WHEN 'accepted' THEN 'proven_applied' WHEN 'abandoned' THEN 'abandoned' END
            AND resolution.receipt_json IS json_extract(outcome.outcome_json,'$.outcome.receipt')
            AND resolution.evidence_json=json_object('version',1,'ownerDigest',owner.owner_digest,'claimDigest',claim.claim_digest,'outcomeDigest',outcome.outcome_digest)
            AND resolution.created_at=json_extract(outcome.outcome_json,'$.recordedAt'))))
      AND ((claim.attempt_id IS NULL AND outcome.ordinal=1 AND json_extract(outcome.outcome_json,'$.outcome')='{"kind":"cancelled"}')
        OR (claim.original_key=owner.original_key AND EXISTS(SELECT 1 FROM session_send_owner_anchors claim_anchor WHERE claim_anchor.attempt_id=owner.attempt_id
          AND claim_anchor.kind='claim' AND claim_anchor.digest=claim.claim_digest) AND (
          (outcome.ordinal=2 AND json_extract(outcome.outcome_json,'$.outcome')='{"kind":"abandoned","acknowledgeOutcomeUnknown":true}')
          OR (json_extract(outcome.outcome_json,'$.outcome.kind')='accepted'
            AND (SELECT COUNT(*) FROM json_each(outcome.outcome_json,'$.outcome'))=2
            AND json_type(outcome.outcome_json,'$.outcome.receipt.turnId')='text'
            AND length(json_extract(outcome.outcome_json,'$.outcome.receipt.turnId')) BETWEEN 1 AND 200
            AND json_extract(outcome.outcome_json,'$.outcome.receipt.sourceId')=${m}.id
            AND json_extract(outcome.outcome_json,'$.outcome.receipt.status') IN ('completed','interrupted','failed','inProgress')
            AND json_type(outcome.outcome_json,'$.outcome.receipt.effectiveRuntimeProfile')='object'
            AND json_extract(outcome.outcome_json,'$.outcome.receipt.effectiveRuntimeProfile')=json_extract(claim.claim_json,'$.evidence.runtimeProfile')
            AND (SELECT COUNT(*) FROM json_each(outcome.outcome_json,'$.outcome.receipt'))=4
            AND NOT EXISTS(SELECT 1 FROM json_each(outcome.outcome_json,'$.outcome.receipt') WHERE key NOT IN ('turnId','status','sourceId','effectiveRuntimeProfile'))))))))
  OR (${m}.request_format IS NULL AND (
    (${m}.state='cancelled' AND ${m}.result_json IS NULL AND NOT EXISTS(SELECT 1 FROM mutation_effect_evidence effect WHERE effect.attempt_id=${m}.id))
    OR EXISTS(SELECT 1 FROM mutation_effect_evidence effect JOIN mutation_provider_authorities primary_authority ON primary_authority.attempt_id=effect.attempt_id AND primary_authority.role='primary'
      WHERE effect.attempt_id=${m}.id AND effect.kind=${m}.kind AND primary_authority.process_generation=${m}.authority_generation
        AND json_extract(effect.evidence_json,'$.kind')=${m}.kind AND json_extract(effect.evidence_json,'$.clientMessageId')=${m}.id
        AND json_type(effect.evidence_json,'$.providerThreadId')='text' AND length(json_extract(effect.evidence_json,'$.providerThreadId')) BETWEEN 1 AND 200
        AND json_type(effect.evidence_json,'$.messageDigest')='text' AND length(json_extract(effect.evidence_json,'$.messageDigest'))=64
        AND json_extract(effect.evidence_json,'$.messageDigest') NOT GLOB '*[^a-f0-9]*'
        AND json_type(effect.evidence_json,'$.baseline')='object' AND (SELECT COUNT(*) FROM json_each(effect.evidence_json,'$.baseline'))=3
        AND json_extract(effect.evidence_json,'$.baseline.status') IN ('active','idle','terminal')
        AND (json_type(effect.evidence_json,'$.baseline.activeTurnId')='null' OR (json_type(effect.evidence_json,'$.baseline.activeTurnId')='text' AND length(json_extract(effect.evidence_json,'$.baseline.activeTurnId')) BETWEEN 1 AND 200))
        AND (json_type(effect.evidence_json,'$.baseline.providerUpdatedAt')='null' OR (json_type(effect.evidence_json,'$.baseline.providerUpdatedAt') IN ('integer','real') AND json_extract(effect.evidence_json,'$.baseline.providerUpdatedAt')>=0))
        AND NOT EXISTS(SELECT 1 FROM json_each(effect.evidence_json,'$.baseline') WHERE key NOT IN ('status','activeTurnId','providerUpdatedAt'))
        AND ((${m}.kind='session.send' AND NOT EXISTS(SELECT 1 FROM json_each(effect.evidence_json) WHERE key NOT IN ('kind','providerThreadId','baseline','clientMessageId','messageDigest','runtimeProfile'))
          AND (json_type(effect.evidence_json,'$.runtimeProfile') IS NULL OR (json_type(effect.evidence_json,'$.runtimeProfile')='object'
            AND json_extract(effect.evidence_json,'$.runtimeProfile.profileId')=primary_authority.profile_id
            AND json_extract(effect.evidence_json,'$.runtimeProfile.processGeneration')=primary_authority.process_generation)))
          OR (${m}.kind='session.steer' AND NOT EXISTS(SELECT 1 FROM json_each(effect.evidence_json) WHERE key NOT IN ('kind','providerThreadId','baseline','clientMessageId','messageDigest','activeTurnId'))
            AND (json_type(effect.evidence_json,'$.activeTurnId')='null' OR (json_type(effect.evidence_json,'$.activeTurnId')='text' AND length(json_extract(effect.evidence_json,'$.activeTurnId')) BETWEEN 1 AND 200))))
        AND (( ${m}.state='applied' AND NOT EXISTS(SELECT 1 FROM mutation_resolutions resolved WHERE resolved.attempt_id=${m}.id) AND ${nativeReceiptSql(m, `${m}.result_json`, "effect.evidence_json")} )
          OR (${m}.state='failed' AND NOT EXISTS(SELECT 1 FROM mutation_resolutions resolved WHERE resolved.attempt_id=${m}.id) AND CASE WHEN json_valid(${m}.result_json) THEN json_type(${m}.result_json)='object'
            AND json_type(${m}.result_json,'$.code')='text' AND length(json_extract(${m}.result_json,'$.code')) BETWEEN 1 AND 80
            AND json_extract(${m}.result_json,'$.code') GLOB '[A-Za-z]*' AND json_extract(${m}.result_json,'$.code') NOT GLOB '*[^A-Za-z0-9_]*'
            AND (SELECT COUNT(*) FROM json_each(${m}.result_json))=1 ELSE 0 END)
          OR EXISTS(SELECT 1 FROM mutation_resolutions resolution WHERE resolution.attempt_id=${m}.id AND CASE WHEN json_valid(resolution.evidence_json) THEN
            (resolution.resolution_kind='abandoned' AND resolution.receipt_json IS NULL AND json_extract(resolution.evidence_json,'$.action')='user_abandon'
              AND json_type(resolution.evidence_json,'$.providerEffectRetried')='false' AND json_type(resolution.evidence_json,'$.providerStateDeleted')='false'
              AND (json_type(resolution.evidence_json,'$.observedProviderUpdatedAt') IS NULL OR json_type(resolution.evidence_json,'$.observedProviderUpdatedAt')='null'
                OR (json_type(resolution.evidence_json,'$.observedProviderUpdatedAt') IN ('integer','real') AND json_extract(resolution.evidence_json,'$.observedProviderUpdatedAt')>=0))
              AND NOT EXISTS(SELECT 1 FROM json_each(resolution.evidence_json) WHERE key NOT IN ('action','providerEffectRetried','providerStateDeleted','observedProviderUpdatedAt')))
            OR (resolution.resolution_kind='proven_applied' AND ${nativeReceiptSql(m, "resolution.receipt_json", "effect.evidence_json")}
              AND json_extract(resolution.evidence_json,'$.kind')=${m}.kind AND json_extract(resolution.evidence_json,'$.clientMessageId')=${m}.id
              AND json_extract(resolution.evidence_json,'$.turnId')=CASE WHEN ${m}.kind='session.send' THEN json_extract(resolution.receipt_json,'$.turnId') ELSE json_extract(resolution.receipt_json,'$.activeTurnId') END
              AND (json_type(resolution.evidence_json,'$.providerUpdatedAt') IS NULL
                OR (json_type(resolution.evidence_json,'$.providerUpdatedAt') IN ('integer','real') AND json_extract(resolution.evidence_json,'$.providerUpdatedAt')>=0))
              AND NOT EXISTS(SELECT 1 FROM json_each(resolution.evidence_json) WHERE key NOT IN ('kind','clientMessageId','turnId','providerUpdatedAt')))
            ELSE 0 END)
        ))))) IS 1`;
const guardSpecs = [
  { name: "attachment_generic_input_insert_guard", table: "mutation_attempts", sql: `CREATE TRIGGER IF NOT EXISTS attachment_generic_input_insert_guard BEFORE INSERT ON mutation_attempts
    WHEN NEW.kind IN ('session.send','session.steer') AND NEW.request_format IS NULL AND NEW.attachment_input_format IS NULL
    BEGIN SELECT RAISE(ABORT,'ATTACHMENT_CUSTODY_UNPROVED'); END;` },
  { name: "attachment_queue_admission_guard", table: "queue_attachment_identities", sql: `CREATE TRIGGER IF NOT EXISTS attachment_queue_admission_guard BEFORE INSERT ON queue_attachment_identities
    WHEN json_extract(NEW.identity_json,'$.attachmentCount')>0 AND NOT EXISTS(
      SELECT 1 FROM attachment_custody_slots slot CROSS JOIN attachment_custody_sets s ON s.id=slot.custody_id
      JOIN attachment_custody_anchors anchor ON anchor.id=s.id JOIN daemon_state daemon ON daemon.singleton=1
      WHERE s.original_key=NEW.original_key AND s.digest=slot.digest AND s.released_by IS NULL
        AND anchor.kind='custody' AND anchor.digest=s.digest AND anchor.proof_json=s.origin_json AND anchor.released_by IS NULL
        AND daemon.stopped_at IS NULL AND daemon.generation=json_extract(s.origin_json,'$.daemonGeneration')
        AND daemon.boot_id=json_extract(s.origin_json,'$.bootId')
        AND json_extract(s.origin_json,'$.input.kind')='session.queue' AND json_extract(s.origin_json,'$.input.sessionId')=NEW.session_id
        AND json_extract(s.origin_json,'$.input.requestDigest')=json_extract(NEW.identity_json,'$.requestDigest')
        AND json_extract(s.origin_json,'$.input.messageDigest')=json_extract(NEW.identity_json,'$.messageDigest')
        AND json_extract(s.origin_json,'$.input.referenceCount')=json_extract(NEW.identity_json,'$.attachmentCount')
        AND json_extract(s.origin_json,'$.input.authority.providerAccountId')=json_extract(NEW.identity_json,'$.authority.providerAccountId')
        AND json_extract(s.origin_json,'$.input.authority.profileId')=json_extract(NEW.identity_json,'$.authority.profileId')
        AND json_extract(s.origin_json,'$.input.authority.provider')=json_extract(NEW.identity_json,'$.authority.provider')
        AND json_extract(s.origin_json,'$.input.authority.bindingGeneration')=json_extract(NEW.identity_json,'$.authority.bindingGeneration')
        AND json_extract(s.origin_json,'$.input.authority.processGeneration')=json_extract(NEW.identity_json,'$.authority.processGeneration')
        AND NOT EXISTS(SELECT 1 FROM attachment_custody_dispositions disposition WHERE disposition.custody_id=s.id)
        AND NOT EXISTS(SELECT 1 FROM mutation_attempts parent WHERE parent.attachment_custody_id=s.id))
    BEGIN SELECT RAISE(ABORT,'ATTACHMENT_CUSTODY_UNPROVED'); END;` },
  { name: "attachment_terminal_projection_guard", table: "mutation_attempts", sql: `CREATE TRIGGER IF NOT EXISTS attachment_terminal_projection_guard BEFORE UPDATE OF attachment_cleanup_terminal_digest ON mutation_attempts
    WHEN NEW.attachment_cleanup_terminal_digest IS NOT OLD.attachment_cleanup_terminal_digest AND NOT ${terminalParentSql("NEW")}
    BEGIN SELECT RAISE(ABORT,'ATTACHMENT_CUSTODY_UNPROVED'); END;` },
  { name: "attachment_set_projection_guard", table: "attachment_custody_sets", sql: `CREATE TRIGGER IF NOT EXISTS attachment_set_projection_guard BEFORE UPDATE ON attachment_custody_sets
    WHEN NEW.id IS NOT OLD.id OR NEW.original_key IS NOT OLD.original_key OR NEW.origin_json IS NOT OLD.origin_json OR NEW.digest IS NOT OLD.digest
      OR OLD.released_by IS NOT NULL OR NEW.released_by IS NULL
      OR NOT EXISTS(SELECT 1 FROM attachment_custody_dispositions d WHERE d.custody_id=OLD.id AND d.digest=NEW.released_by AND d.kind!='mutation_owned')
    BEGIN SELECT RAISE(ABORT,'ATTACHMENT_CUSTODY_CORRUPT'); END;` },
  { name: "attachment_anchor_projection_guard", table: "attachment_custody_anchors", sql: `CREATE TRIGGER IF NOT EXISTS attachment_anchor_projection_guard BEFORE UPDATE ON attachment_custody_anchors
    WHEN NEW.id IS NOT OLD.id OR NEW.kind IS NOT OLD.kind OR NEW.original_key IS NOT OLD.original_key OR NEW.attempt_id IS NOT OLD.attempt_id
      OR NEW.proof_json IS NOT OLD.proof_json OR NEW.digest IS NOT OLD.digest OR OLD.released_by IS NOT NULL OR NEW.released_by IS NULL
      OR OLD.kind='empty_input_v1' OR (OLD.kind='custody' AND NOT EXISTS(SELECT 1 FROM attachment_custody_sets s
        JOIN attachment_custody_dispositions d ON d.custody_id=s.id WHERE s.id=OLD.id AND s.released_by=NEW.released_by AND d.digest=NEW.released_by AND d.kind!='mutation_owned'))
      OR (OLD.kind='legacy_unknown' AND NOT EXISTS(SELECT 1 FROM mutation_attempts m JOIN attachment_legacy_cleanup_blockers b ON b.attempt_id=m.id
        WHERE m.id=OLD.attempt_id AND m.attachment_cleanup_terminal_digest=NEW.released_by AND b.terminal_digest=NEW.released_by))
    BEGIN SELECT RAISE(ABORT,'ATTACHMENT_CUSTODY_CORRUPT'); END;` },
  { name: "attachment_blocker_projection_guard", table: "attachment_legacy_cleanup_blockers", sql: `CREATE TRIGGER IF NOT EXISTS attachment_blocker_projection_guard BEFORE UPDATE ON attachment_legacy_cleanup_blockers
    WHEN NEW.attempt_id IS NOT OLD.attempt_id OR NEW.original_key IS NOT OLD.original_key OR NEW.origin_json IS NOT OLD.origin_json
      OR OLD.terminal_digest IS NOT NULL OR NEW.terminal_digest IS NULL OR NOT EXISTS(SELECT 1 FROM mutation_attempts m
        WHERE m.id=OLD.attempt_id AND m.idempotency_key=OLD.original_key AND m.attachment_input_format IS NULL AND m.attachment_cleanup_terminal_digest=NEW.terminal_digest)
    BEGIN SELECT RAISE(ABORT,'ATTACHMENT_CUSTODY_CORRUPT'); END;` },
  { name: "attachment_empty_anchor_guard", table: "attachment_custody_anchors", sql: `CREATE TRIGGER IF NOT EXISTS attachment_empty_anchor_guard BEFORE INSERT ON attachment_custody_anchors
    WHEN NEW.kind='empty_input_v1' AND NOT EXISTS(SELECT 1 FROM mutation_attempts m JOIN mutation_provider_authorities a ON a.attempt_id=m.id AND a.role='primary'
      WHERE NEW.id='empty:'||m.id AND m.id=NEW.attempt_id AND m.idempotency_key=NEW.original_key AND m.attachment_input_format='empty_v1'
        AND m.attachment_input_digest=NEW.digest AND m.attachment_custody_id IS NULL AND m.state='prepared'
        AND m.kind=json_extract(NEW.proof_json,'$.kind') AND m.authority_id=json_extract(NEW.proof_json,'$.sessionId')
        AND m.request_digest=json_extract(NEW.proof_json,'$.requestDigest') AND m.idempotency_key=json_extract(NEW.proof_json,'$.idempotencyKey')
        AND m.authority_generation=json_extract(NEW.proof_json,'$.authority.processGeneration') AND json_extract(NEW.proof_json,'$.referenceCount')=0
        AND json_array_length(NEW.proof_json,'$.members')=0 AND json_extract(NEW.proof_json,'$.referenceDigest')='${attachmentReferencesDigest([])}'
        AND a.provider_account_id=json_extract(NEW.proof_json,'$.authority.providerAccountId') AND a.profile_id=json_extract(NEW.proof_json,'$.authority.profileId')
        AND a.provider=json_extract(NEW.proof_json,'$.authority.provider') AND a.binding_generation=json_extract(NEW.proof_json,'$.authority.bindingGeneration')
        AND a.process_generation=m.authority_generation)
    BEGIN SELECT RAISE(ABORT,'ATTACHMENT_CUSTODY_CORRUPT'); END;` },
  { name: "attachment_member_insert_guard", table: "attachment_custody_members", sql: `CREATE TRIGGER IF NOT EXISTS attachment_member_insert_guard BEFORE INSERT ON attachment_custody_members
    WHEN EXISTS(SELECT 1 FROM attachment_custody_slots WHERE custody_id=NEW.custody_id) OR NOT EXISTS(SELECT 1 FROM attachment_custody_sets s
      WHERE s.id=NEW.custody_id AND s.released_by IS NULL AND json_extract(s.origin_json,'$.input.members['||NEW.position||'].digest')=NEW.digest
        AND json_extract(s.origin_json,'$.input.members['||NEW.position||'].canonicalMediaType')=NEW.canonical_media_type
        AND json_extract(s.origin_json,'$.input.members['||NEW.position||'].byteLength')=NEW.byte_length)
    BEGIN SELECT RAISE(ABORT,'ATTACHMENT_CUSTODY_CORRUPT'); END;` },
  { name: "attachment_slot_insert_guard", table: "attachment_custody_slots", sql: `CREATE TRIGGER IF NOT EXISTS attachment_slot_insert_guard BEFORE INSERT ON attachment_custody_slots
    WHEN NOT EXISTS(SELECT 1 FROM attachment_custody_sets s JOIN attachment_custody_anchors a ON a.id=s.id WHERE s.id=NEW.custody_id AND s.digest=NEW.digest
      AND s.released_by IS NULL AND a.released_by IS NULL AND a.digest=s.digest AND a.proof_json=s.origin_json
      AND (SELECT COUNT(*) FROM attachment_custody_members member WHERE member.custody_id=s.id)=json_extract(s.origin_json,'$.input.referenceCount'))
    BEGIN SELECT RAISE(ABORT,'ATTACHMENT_CUSTODY_CORRUPT'); END;` },
  { name: "attachment_disposition_insert_guard", table: "attachment_custody_dispositions", sql: `CREATE TRIGGER IF NOT EXISTS attachment_disposition_insert_guard BEFORE INSERT ON attachment_custody_dispositions
    WHEN NOT EXISTS(SELECT 1 FROM attachment_custody_sets s JOIN attachment_custody_anchors a ON a.id=s.id JOIN attachment_custody_slots slot ON slot.custody_id=s.id
      WHERE s.id=NEW.custody_id AND s.original_key=NEW.original_key AND s.released_by IS NULL AND a.released_by IS NULL AND s.digest=a.digest AND slot.digest=s.digest
        AND NEW.recorded_at>=json_extract(s.origin_json,'$.createdAt') AND (
          (NEW.ordinal=1 AND NEW.predecessor IS NULL AND NOT EXISTS(SELECT 1 FROM attachment_custody_dispositions old WHERE old.custody_id=s.id)
            AND ((NEW.kind='mutation_owned' AND EXISTS(SELECT 1 FROM mutation_attempts m JOIN mutation_provider_authorities p ON p.attempt_id=m.id AND p.role='primary'
              WHERE m.id=NEW.attempt_id AND m.state='prepared' AND m.attachment_input_format='retained_v1' AND m.attachment_custody_id=s.id
                AND m.attachment_input_digest=s.digest AND m.idempotency_key=s.original_key AND m.authority_id=json_extract(s.origin_json,'$.input.sessionId')
                AND m.kind=json_extract(s.origin_json,'$.input.kind') AND m.request_digest=json_extract(s.origin_json,'$.input.requestDigest')
                AND NEW.proof_json=json_object('attemptId',m.id,'requestDigest',m.request_digest)
                AND p.provider_account_id=json_extract(s.origin_json,'$.input.authority.providerAccountId') AND p.profile_id=json_extract(s.origin_json,'$.input.authority.profileId')
                AND p.provider=json_extract(s.origin_json,'$.input.authority.provider') AND p.binding_generation=json_extract(s.origin_json,'$.input.authority.bindingGeneration')
                AND p.process_generation=json_extract(s.origin_json,'$.input.authority.processGeneration')))
            OR (NEW.kind IN ('released','boot_retired','queue_transferred') AND NEW.attempt_id IS NULL
              AND NOT EXISTS(SELECT 1 FROM mutation_attempts m WHERE m.attachment_custody_id=s.id))))
          OR (NEW.ordinal=2 AND NEW.kind='terminal' AND EXISTS(SELECT 1 FROM attachment_custody_dispositions old JOIN mutation_attempts m ON m.id=old.attempt_id
            WHERE old.custody_id=s.id AND old.ordinal=1 AND old.kind='mutation_owned' AND old.digest=NEW.predecessor AND old.attempt_id=NEW.attempt_id
              AND NEW.proof_json=json_object('terminalDigest',m.attachment_cleanup_terminal_digest) AND m.attachment_cleanup_terminal_digest IS NOT NULL))))
    BEGIN SELECT RAISE(ABORT,'ATTACHMENT_CUSTODY_CORRUPT'); END;` },
  { name: "attachment_ingress_release_guard", table: "attachment_custody_dispositions", sql: `CREATE TRIGGER IF NOT EXISTS attachment_ingress_release_guard BEFORE INSERT ON attachment_custody_dispositions
    WHEN NEW.kind IN ('released','boot_retired') AND NOT EXISTS(SELECT 1 FROM attachment_custody_sets s JOIN daemon_state d ON d.singleton=1
      WHERE s.id=NEW.custody_id AND d.stopped_at IS NULL AND d.generation=json_extract(NEW.proof_json,'$.daemonGeneration')
        AND d.boot_id=json_extract(NEW.proof_json,'$.bootId') AND NEW.proof_json=json_object('daemonGeneration',d.generation,'bootId',d.boot_id)
        AND ((NEW.kind='released' AND d.generation=json_extract(s.origin_json,'$.daemonGeneration') AND d.boot_id=json_extract(s.origin_json,'$.bootId'))
          OR (NEW.kind='boot_retired' AND d.generation>json_extract(s.origin_json,'$.daemonGeneration') AND d.boot_id!=json_extract(s.origin_json,'$.bootId'))))
    BEGIN SELECT RAISE(ABORT,'ATTACHMENT_CUSTODY_AUTHORITY_CHANGED'); END;` },
  { name: "attachment_queue_transfer_guard", table: "attachment_custody_dispositions", sql: `CREATE TRIGGER IF NOT EXISTS attachment_queue_transfer_guard BEFORE INSERT ON attachment_custody_dispositions
    WHEN NEW.kind='queue_transferred' AND NOT EXISTS(SELECT 1 FROM attachment_custody_sets s
      JOIN queue_attachment_identities identity ON identity.queue_id=json_extract(NEW.proof_json,'$.queueId')
      JOIN queue_attachment_identity_anchors anchor ON anchor.queue_id=identity.queue_id
      WHERE s.id=NEW.custody_id AND json_extract(s.origin_json,'$.input.kind')='session.queue' AND identity.original_key=s.original_key
        AND NEW.proof_json=json_object('queueId',identity.queue_id,'identityDigest',identity.identity_digest)
        AND anchor.original_key=identity.original_key AND anchor.attempt_id=identity.attempt_id AND anchor.identity_digest=identity.identity_digest
        AND identity.identity_digest=json_extract(NEW.proof_json,'$.identityDigest') AND identity.session_id=json_extract(s.origin_json,'$.input.sessionId')
        AND json_extract(identity.identity_json,'$.requestDigest')=json_extract(s.origin_json,'$.input.requestDigest')
        AND json_extract(identity.identity_json,'$.messageDigest')=json_extract(s.origin_json,'$.input.messageDigest')
        AND json_extract(identity.identity_json,'$.attachmentCount')=json_extract(s.origin_json,'$.input.referenceCount')
        AND json_extract(identity.identity_json,'$.authority.providerAccountId')=json_extract(s.origin_json,'$.input.authority.providerAccountId')
        AND json_extract(identity.identity_json,'$.authority.profileId')=json_extract(s.origin_json,'$.input.authority.profileId')
        AND json_extract(identity.identity_json,'$.authority.provider')=json_extract(s.origin_json,'$.input.authority.provider')
        AND json_extract(identity.identity_json,'$.authority.bindingGeneration')=json_extract(s.origin_json,'$.input.authority.bindingGeneration')
        AND json_extract(identity.identity_json,'$.authority.processGeneration')=json_extract(s.origin_json,'$.input.authority.processGeneration'))
    BEGIN SELECT RAISE(ABORT,'ATTACHMENT_CUSTODY_CORRUPT'); END;` },
  { name: "attachment_manifest_input_guard", table: "message_attachments", sql: `CREATE TRIGGER IF NOT EXISTS attachment_manifest_input_guard BEFORE INSERT ON message_attachments
    WHEN EXISTS(SELECT 1 FROM mutation_attempts m WHERE m.id=NEW.source_id AND m.attachment_input_format IS NOT NULL
      AND (m.authority_id!=NEW.session_id OR m.attachment_input_format='empty_v1' OR m.state!='prepared'
        OR NOT EXISTS(SELECT 1 FROM attachment_custody_members member WHERE member.custody_id=m.attachment_custody_id AND member.position=NEW.position
          AND member.digest=NEW.digest AND member.byte_length=NEW.byte_length)))
    BEGIN SELECT RAISE(ABORT,'ATTACHMENT_CUSTODY_REQUEST_CONFLICT'); END;` },
  { name: "attachment_unknown_capture", table: "mutation_attempts", sql: `CREATE TRIGGER IF NOT EXISTS attachment_unknown_capture AFTER INSERT ON mutation_attempts
    WHEN NEW.kind IN ('session.send','session.steer') AND NEW.attachment_input_format IS NULL
    BEGIN INSERT INTO attachment_legacy_cleanup_blockers(attempt_id,original_key,origin_json) VALUES(NEW.id,NEW.idempotency_key,${unknownJson("NEW")});
      INSERT INTO attachment_custody_anchors(id,kind,original_key,attempt_id,proof_json) VALUES('legacy:'||NEW.id,'legacy_unknown',NEW.idempotency_key,NEW.id,${unknownJson("NEW")}); END;` },
  { name: "attachment_parent_insert_guard", table: "mutation_attempts", sql: `CREATE TRIGGER IF NOT EXISTS attachment_parent_insert_guard BEFORE INSERT ON mutation_attempts WHEN
    EXISTS(SELECT 1 FROM attachment_legacy_cleanup_blockers b WHERE b.attempt_id=NEW.id OR b.original_key=NEW.idempotency_key)
    OR EXISTS(SELECT 1 FROM attachment_custody_anchors a WHERE a.attempt_id=NEW.id OR (a.kind!='custody' AND a.original_key=NEW.idempotency_key))
    OR EXISTS(SELECT 1 FROM attachment_custody_dispositions d WHERE d.kind='mutation_owned' AND (d.attempt_id=NEW.id OR d.original_key=NEW.idempotency_key))
    OR NEW.attachment_cleanup_terminal_digest IS NOT NULL
    OR (NEW.attachment_input_format IS NOT NULL AND (NEW.kind NOT IN ('session.send','session.steer') OR NEW.state!='prepared' OR NEW.result_json IS NOT NULL))
    BEGIN SELECT RAISE(ABORT,'ATTACHMENT_CUSTODY_CORRUPT'); END;` },
  { name: "attachment_parent_immutable", table: "mutation_attempts", sql: `CREATE TRIGGER IF NOT EXISTS attachment_parent_immutable BEFORE UPDATE ON mutation_attempts
    WHEN NEW.attachment_input_format IS NOT OLD.attachment_input_format OR NEW.attachment_custody_id IS NOT OLD.attachment_custody_id
      OR NEW.attachment_input_digest IS NOT OLD.attachment_input_digest
      OR (OLD.kind IN ('session.send','session.steer') AND (NEW.id IS NOT OLD.id OR NEW.idempotency_key IS NOT OLD.idempotency_key OR NEW.kind IS NOT OLD.kind
        OR NEW.authority_id IS NOT OLD.authority_id OR NEW.authority_generation IS NOT OLD.authority_generation OR NEW.request_digest IS NOT OLD.request_digest))
      OR (OLD.attachment_cleanup_terminal_digest IS NOT NULL AND NEW.attachment_cleanup_terminal_digest IS NOT OLD.attachment_cleanup_terminal_digest)
      OR (NEW.attachment_cleanup_terminal_digest IS NOT OLD.attachment_cleanup_terminal_digest AND NOT (
        NEW.state IN ('applied','failed','cancelled') OR EXISTS(SELECT 1 FROM mutation_resolutions r WHERE r.attempt_id=OLD.id)))
    BEGIN SELECT RAISE(ABORT,'ATTACHMENT_CUSTODY_CORRUPT'); END;` },
  { name: "attachment_parent_delete_guard", table: "mutation_attempts", sql: `CREATE TRIGGER IF NOT EXISTS attachment_parent_delete_guard BEFORE DELETE ON mutation_attempts
    WHEN OLD.kind IN ('session.send','session.steer') BEGIN SELECT RAISE(ABORT,'ATTACHMENT_CUSTODY_CORRUPT'); END;` },
  { name: "attachment_input_begin_guard", table: "mutation_attempts", sql: `CREATE TRIGGER IF NOT EXISTS attachment_input_begin_guard BEFORE UPDATE OF state ON mutation_attempts
    WHEN OLD.state='prepared' AND NEW.state='effect_started' AND OLD.attachment_input_format IS NOT NULL AND (
      NOT EXISTS(SELECT 1 FROM mutation_effect_evidence effect JOIN attachment_custody_anchors a ON a.digest=OLD.attachment_input_digest JOIN daemon_state d ON d.singleton=1
        WHERE effect.attempt_id=OLD.id AND effect.kind=OLD.kind AND json_extract(effect.evidence_json,'$.clientMessageId')=OLD.id
          AND (OLD.request_format IS NOT NULL OR json_extract(effect.evidence_json,'$.messageDigest')=CASE WHEN a.kind='custody' THEN json_extract(a.proof_json,'$.input.messageDigest') ELSE json_extract(a.proof_json,'$.messageDigest') END)
          AND d.stopped_at IS NULL AND (OLD.request_format IS NOT NULL OR (
            d.generation=CASE WHEN a.kind='custody' THEN json_extract(a.proof_json,'$.daemonGeneration') ELSE json_extract(a.proof_json,'$.daemon.daemonGeneration') END
            AND d.boot_id=CASE WHEN a.kind='custody' THEN json_extract(a.proof_json,'$.bootId') ELSE json_extract(a.proof_json,'$.daemon.bootId') END)))
      OR
      NOT EXISTS(SELECT 1 FROM attachment_custody_anchors a WHERE a.digest=OLD.attachment_input_digest AND a.original_key=OLD.idempotency_key
        AND ((OLD.attachment_input_format='empty_v1' AND a.kind='empty_input_v1' AND a.attempt_id=OLD.id
          AND json_extract(a.proof_json,'$.referenceCount')=0 AND json_extract(a.proof_json,'$.requestDigest')=OLD.request_digest)
        OR (OLD.attachment_input_format='retained_v1' AND a.kind='custody' AND a.id=OLD.attachment_custody_id AND a.released_by IS NULL
          AND EXISTS(SELECT 1 FROM attachment_custody_dispositions d WHERE d.custody_id=a.id AND d.kind='mutation_owned' AND d.attempt_id=OLD.id))))
      OR (OLD.request_format IS NULL AND (SELECT COUNT(*) FROM message_attachments l WHERE l.source_id=OLD.id AND l.session_id=OLD.authority_id) !=
        COALESCE((SELECT CASE WHEN a.kind='custody' THEN json_extract(a.proof_json,'$.input.referenceCount') ELSE json_extract(a.proof_json,'$.referenceCount') END
          FROM attachment_custody_anchors a WHERE a.digest=OLD.attachment_input_digest),-1)))
    BEGIN SELECT RAISE(ABORT,'ATTACHMENT_CUSTODY_UNPROVED'); END;` },
  { name: "attachment_owned_claim_guard", table: "session_send_execution_claims", sql: `CREATE TRIGGER IF NOT EXISTS attachment_owned_claim_guard BEFORE INSERT ON session_send_execution_claims
    WHEN EXISTS(SELECT 1 FROM session_send_owners o JOIN mutation_attempts m ON m.id=o.attempt_id WHERE o.attempt_id=NEW.attempt_id
      AND json_extract(o.owner_json,'$.fingerprint.attachmentCount')>0 AND (m.attachment_input_format IS NOT 'retained_v1'
        OR NOT EXISTS(SELECT 1 FROM attachment_custody_sets s JOIN attachment_custody_anchors a ON a.id=s.id
          JOIN attachment_custody_slots slot ON slot.custody_id=s.id WHERE s.id=m.attachment_custody_id AND s.digest=m.attachment_input_digest
          AND a.digest=s.digest AND s.released_by IS NULL AND a.released_by IS NULL)))
    BEGIN SELECT RAISE(ABORT,'ATTACHMENT_CUSTODY_UNPROVED'); END;` },
  { name: "attachment_manifest_retention_guard", table: "message_attachments", sql: `CREATE TRIGGER IF NOT EXISTS attachment_manifest_retention_guard BEFORE DELETE ON message_attachments
    WHEN ${protectedMutation("OLD.source_id")} BEGIN SELECT RAISE(ABORT,'ATTACHMENT_CUSTODY_CORRUPT'); END;` },
  { name: "attachment_member_delete_guard", table: "attachment_custody_members", sql: `CREATE TRIGGER IF NOT EXISTS attachment_member_delete_guard BEFORE DELETE ON attachment_custody_members
    WHEN EXISTS(SELECT 1 FROM attachment_custody_sets s WHERE s.id=OLD.custody_id AND s.released_by IS NULL)
    BEGIN SELECT RAISE(ABORT,'ATTACHMENT_CUSTODY_CORRUPT'); END;` },
  { name: "attachment_slot_delete_guard", table: "attachment_custody_slots", sql: `CREATE TRIGGER IF NOT EXISTS attachment_slot_delete_guard BEFORE DELETE ON attachment_custody_slots
    WHEN NOT EXISTS(SELECT 1 FROM attachment_custody_sets s JOIN attachment_custody_anchors a ON a.id=s.id
      WHERE s.id=OLD.custody_id AND s.released_by IS NOT NULL AND a.released_by=s.released_by)
    BEGIN SELECT RAISE(ABORT,'ATTACHMENT_CUSTODY_CORRUPT'); END;` },
] as const;
const immutable = ["attachment_custody_members", "attachment_custody_dispositions", "attachment_custody_slots"] as const;
const permanent = ["attachment_custody_sets", "attachment_custody_anchors", "attachment_custody_dispositions", "attachment_legacy_cleanup_blockers"] as const;
const indexes = [
  ["attachment_custody_sets_live", "attachment_custody_sets", "id WHERE released_by IS NULL"],
  ["attachment_custody_anchors_live", "attachment_custody_anchors", "id WHERE kind='custody' AND released_by IS NULL"],
  ["attachment_custody_unknown_anchor_live", "attachment_custody_anchors", "id WHERE kind='legacy_unknown' AND released_by IS NULL"],
  ["attachment_legacy_cleanup_live", "attachment_legacy_cleanup_blockers", "attempt_id WHERE terminal_digest IS NULL"],
  ["attachment_custody_parent_live", "mutation_attempts", "attachment_custody_id WHERE attachment_input_format='retained_v1' AND attachment_cleanup_terminal_digest IS NULL"],
  ["attachment_custody_parent_id", "mutation_attempts", "attachment_custody_id WHERE attachment_custody_id IS NOT NULL"],
  ["attachment_custody_parent_unknown_live", "mutation_attempts", "id WHERE kind IN ('session.send','session.steer') AND attachment_input_format IS NULL AND attachment_cleanup_terminal_digest IS NULL"],
  ["attachment_custody_member_digest", "attachment_custody_members", "digest,custody_id"],
  ["attachment_custody_anchor_attempt", "attachment_custody_anchors", "attempt_id"],
  ["attachment_custody_anchor_key", "attachment_custody_anchors", "original_key"],
  ["attachment_custody_parent_anchor_key", "attachment_custody_anchors", "original_key WHERE kind!='custody'"],
  ["attachment_custody_set_key", "attachment_custody_sets", "original_key"],
  ["attachment_custody_owned_key", "attachment_custody_dispositions", "original_key WHERE kind='mutation_owned'"],
  ["attachment_custody_owned_attempt", "attachment_custody_dispositions", "attempt_id WHERE kind='mutation_owned'"],
] as const;
export const ATTACHMENT_CUSTODY_SCHEMA_OBJECTS = [
  ...tables.map((o) => ({ ...o, table: o.name, type: "table" })),
  ...guardSpecs.map((o) => ({ ...o, type: "trigger" })),
  ...immutable.map((table) => ({ name: `${table}_immutable`, table, type: "trigger", sql: `CREATE TRIGGER IF NOT EXISTS ${table}_immutable BEFORE UPDATE ON ${table} BEGIN SELECT RAISE(ABORT,'ATTACHMENT_CUSTODY_CORRUPT'); END;` })),
  ...permanent.map((table) => ({ name: `${table}_permanent`, table, type: "trigger", sql: `CREATE TRIGGER IF NOT EXISTS ${table}_permanent BEFORE DELETE ON ${table} BEGIN SELECT RAISE(ABORT,'ATTACHMENT_CUSTODY_CORRUPT'); END;` })),
  ...indexes.map(([name, table, expression]) => { const [columns, where] = expression.split(" WHERE "); return { name, table, type: "index", sql: `CREATE INDEX IF NOT EXISTS ${name} ON ${table}(${columns})${where === undefined ? "" : ` WHERE ${where}`};` }; }),
];
export function applyAttachmentCustodySchema(db: Database): void {
  for (const column of ATTACHMENT_CUSTODY_COLUMNS) db.exec(`ALTER TABLE mutation_attempts ADD COLUMN ${column}`);
  for (const object of ATTACHMENT_CUSTODY_SCHEMA_OBJECTS) db.exec(object.sql);
  db.exec(`INSERT INTO attachment_legacy_cleanup_blockers(attempt_id,original_key,origin_json)
    SELECT m.id,m.idempotency_key,${unknownJson("m")} FROM mutation_attempts m WHERE m.kind IN ('session.send','session.steer');
    INSERT INTO attachment_custody_anchors(id,kind,original_key,attempt_id,proof_json)
    SELECT 'legacy:'||attempt_id,'legacy_unknown',original_key,attempt_id,origin_json FROM attachment_legacy_cleanup_blockers;`);
}
export function assertAttachmentCustodySchema(db: Database, mode: UsageSchemaColumnMode = "historical"): void {
  const row = db.query("SELECT sql FROM sqlite_master WHERE name='mutation_attempts' AND type='table'").get() as { sql: string } | null;
  const parentSql = row === null ? null : schemaSqlBeforeJoinedTranscriptColumns(db, "mutation_attempts", row.sql, mode);
  if (parentSql === null || !parentSql.endsWith(`${ATTACHMENT_CUSTODY_COLUMNS.map(normalizeSchemaSql).join(", ")}) STRICT`)) fail();
  for (const object of ATTACHMENT_CUSTODY_SCHEMA_OBJECTS) {
    if (mode === "joined" && object.name === "attachment_terminal_projection_guard") {
      assertJoinedAttachmentTerminalGuard(db, object.sql);
      continue;
    }
    const actual = db.query("SELECT type,tbl_name,sql FROM sqlite_master WHERE name=?").get(object.name) as { type: string; tbl_name: string; sql: string } | null;
    if (actual === null || actual.type !== object.type || actual.tbl_name !== object.table || normalizeSchemaSql(actual.sql) !== normalizeSchemaSql(object.sql)) fail();
  }
}
export function applyJoinedAttachmentTerminalGuard(db: Database): void {
  const predecessor = ATTACHMENT_CUSTODY_SCHEMA_OBJECTS.find((object) => object.name === "attachment_terminal_projection_guard");
  if (predecessor === undefined) fail();
  installJoinedAttachmentTerminalGuard(db, predecessor.sql);
}
export function hasAttachmentCustodyArtifacts(db: Database): boolean {
  const names = ATTACHMENT_CUSTODY_SCHEMA_OBJECTS.map((object) => object.name);
  return db.query(`SELECT 1 FROM sqlite_master WHERE name IN (${names.map(() => "?").join(",")}) LIMIT 1`).get(...names) !== null
    || db.query("SELECT 1 FROM pragma_table_info('mutation_attempts') WHERE name LIKE 'attachment_%' LIMIT 1").get() !== null;
}
export function assertAttachmentDaemon(db: Database, input: AttachmentDaemon): void {
  const parsed = attachmentDaemonSchema.parse({ daemonGeneration: input.daemonGeneration, bootId: input.bootId });
  if (db.query("SELECT 1 FROM daemon_state WHERE singleton=1 AND generation=? AND boot_id=? AND stopped_at IS NULL").get(parsed.daemonGeneration, parsed.bootId) === null) fail("ATTACHMENT_CUSTODY_AUTHORITY_CHANGED");
}
const decode = <T>(schema: z.ZodType<T>, json: string): T => { try { return schema.parse(JSON.parse(json) as unknown); } catch { return fail(); } };
const custodyAuditOptionsSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("source_selected") }).strict(),
  z.object({ kind: z.literal("historical"), format: historicalEffectEvidenceFormatSchema }).strict(),
]);
export type AttachmentCustodyAuditOptions = Readonly<z.infer<typeof custodyAuditOptionsSchema>>;
const sourceSelectedCustodyEvidence: AttachmentCustodyAuditOptions = { kind: "source_selected" };
const setRowSchema = z.object({ id: custodyId, original_key: z.string().uuid(), origin_json: z.string(), digest, released_by: digest.nullable() }).strict();
export type CustodySet = Readonly<{ origin: Origin; digest: string; releasedBy: string | null; parentAttemptId: string | null }>;
export function readAttachmentSet(db: Database, id: string): CustodySet {
  return readAttachmentSetWithEvidence(db, id, sourceSelectedCustodyEvidence);
}
function readAttachmentSetWithEvidence(db: Database, id: string, evidence: AttachmentCustodyAuditOptions): CustodySet {
  const row = setRowSchema.safeParse(db.query("SELECT * FROM attachment_custody_sets WHERE id=?").get(id));
  if (!row.success) fail();
  const value = row.data;
  const origin = decode(originSchema, value.origin_json);
  if (origin.id !== value.id || origin.input.idempotencyKey !== value.original_key || proofDigest(origin) !== value.digest
    || origin.input.referenceCount < 1 || origin.input.referenceCount !== origin.input.members.length) fail();
  const anchor = db.query("SELECT * FROM attachment_custody_anchors WHERE id=?").get(id) as { kind: string; original_key: string; attempt_id: string | null; proof_json: string; digest: string; released_by: string | null } | null;
  if (anchor === null || anchor.kind !== "custody" || anchor.original_key !== value.original_key || anchor.proof_json !== value.origin_json
    || anchor.digest !== value.digest || anchor.released_by !== value.released_by || anchor.attempt_id !== null) fail();
  const members = db.query("SELECT position,digest,canonical_media_type,byte_length FROM attachment_custody_members WHERE custody_id=? ORDER BY position LIMIT 9").all(id) as
    { position: number; digest: string; canonical_media_type: string; byte_length: number }[];
  if (value.released_by === null || members.length !== 0) {
    if (members.length !== origin.input.members.length || members.some((member, index) => {
      const expected = origin.input.members[index]; return expected === undefined || member.position !== index || member.digest !== expected.digest
        || member.canonical_media_type !== expected.canonicalMediaType || member.byte_length !== expected.byteLength;
    })) fail();
  }
  const disposition = db.query("SELECT * FROM attachment_custody_dispositions WHERE custody_id=? ORDER BY ordinal LIMIT 3").all(id) as DispositionRow[];
  if (disposition.length > 2) fail();
  let parentAttemptId: string | null = null;
  let previous: DispositionRow | undefined;
  for (const item of disposition) {
    validateDisposition(db, origin, item, evidence, previous);
    if (item.kind === "mutation_owned") parentAttemptId = item.attempt_id;
    previous = item;
  }
  const terminal = previous === undefined || previous.kind === "mutation_owned" ? null : previous.digest;
  if (terminal !== value.released_by) fail();
  const slot = db.query("SELECT digest FROM attachment_custody_slots WHERE custody_id=?").get(id) as { digest: string } | null;
  if (value.released_by === null ? slot?.digest !== value.digest : slot !== null) fail();
  if (parentAttemptId !== null) {
    const parent = db.query("SELECT * FROM mutation_attempts WHERE id=?").get(parentAttemptId) as ParentRow | null;
    if (parent === null || parent.idempotency_key !== origin.input.idempotencyKey || parent.authority_id !== origin.input.sessionId
      || parent.kind !== origin.input.kind || parent.attachment_input_format !== "retained_v1" || parent.authority_generation !== origin.input.authority.processGeneration
      || parent.request_digest !== origin.input.requestDigest || parent.attachment_custody_id !== id || parent.attachment_input_digest !== value.digest
      || (terminal === null) !== (parent.attachment_cleanup_terminal_digest === null)) fail();
    const primary = db.query("SELECT provider_account_id,profile_id,provider,binding_generation,process_generation FROM mutation_provider_authorities WHERE attempt_id=? AND role='primary'").get(parentAttemptId) as
      { provider_account_id: string; profile_id: string; provider: string; binding_generation: number; process_generation: number } | null;
    if (primary === null || primary.provider_account_id !== origin.input.authority.providerAccountId || primary.profile_id !== origin.input.authority.profileId
      || primary.provider !== origin.input.authority.provider || primary.binding_generation !== origin.input.authority.bindingGeneration
      || primary.process_generation !== origin.input.authority.processGeneration) fail();
    if (parent.attachment_cleanup_terminal_digest !== null && attachmentTerminalProofWithEvidence(db, parent.id, evidence) !== parent.attachment_cleanup_terminal_digest) fail();
  }
  return { origin, digest: value.digest, releasedBy: terminal, parentAttemptId };
}
type DispositionRow = { custody_id: string; ordinal: number; original_key: string; predecessor: string | null; kind: string; attempt_id: string | null; proof_json: string; digest: string; recorded_at: number };
function dispositionDigest(row: Omit<DispositionRow, "digest">): string { return proofDigest(row); }
function validateDisposition(db: Database, origin: Origin, row: DispositionRow, evidence: AttachmentCustodyAuditOptions, previous?: DispositionRow): void {
  const { digest: actual, ...body } = row;
  if (row.custody_id !== origin.id || row.original_key !== origin.input.idempotencyKey || row.ordinal !== (previous === undefined ? 1 : 2) || row.predecessor !== (previous?.digest ?? null)
    || dispositionDigest(body) !== actual || row.recorded_at < origin.createdAt || (previous !== undefined && previous.kind !== "mutation_owned")) fail();
  if (row.kind === "mutation_owned") {
    if (previous !== undefined || row.attempt_id === null || row.proof_json !== JSON.stringify({ attemptId: row.attempt_id, requestDigest: origin.input.requestDigest })) fail();
  } else if (row.kind === "terminal") {
    if (row.attempt_id === null || previous?.attempt_id !== row.attempt_id) fail();
    const terminal = attachmentTerminalProofWithEvidence(db, row.attempt_id, evidence);
    if (terminal === null || row.proof_json !== JSON.stringify({ terminalDigest: terminal })) fail();
  } else if (row.kind === "queue_transferred") {
    if (previous !== undefined || row.attempt_id !== null) fail();
    const proof = decode(z.object({ queueId: z.string(), identityDigest: digest }).strict(), row.proof_json);
    const identity = readQueueAttachmentIdentity(db, proof.queueId);
    if (identity === null || identity.idempotencyKey !== origin.input.idempotencyKey || identity.sessionId !== origin.input.sessionId
      || identity.requestDigest !== origin.input.requestDigest || identity.messageDigest !== origin.input.messageDigest
      || identity.attachmentCount !== origin.input.referenceCount || queueAttachmentIdentityDigest(identity) !== proof.identityDigest
      || JSON.stringify(identity.authority) !== JSON.stringify(origin.input.authority)) fail();
  } else if (row.kind === "released" || row.kind === "boot_retired") {
    if (previous !== undefined || row.attempt_id !== null) fail();
    const daemon = decode(attachmentDaemonSchema, row.proof_json);
    if (row.kind === "released" ? (daemon.daemonGeneration !== origin.daemonGeneration || daemon.bootId !== origin.bootId)
      : (daemon.daemonGeneration <= origin.daemonGeneration || daemon.bootId === origin.bootId)) fail();
  } else fail();
}
export function assertLiveAttachmentClosure(db: Database): readonly CustodySet[] {
  return assertLiveAttachmentClosureWithEvidence(db, sourceSelectedCustodyEvidence);
}
function assertLiveAttachmentClosureWithEvidence(db: Database, evidence: AttachmentCustodyAuditOptions): readonly CustodySet[] {
  const ids = new Set<string>();
  for (const sql of [
    "SELECT id FROM attachment_custody_sets WHERE released_by IS NULL LIMIT 65",
    "SELECT id FROM attachment_custody_anchors WHERE kind='custody' AND released_by IS NULL LIMIT 65",
    "SELECT attachment_custody_id AS id FROM mutation_attempts WHERE attachment_input_format='retained_v1' AND attachment_cleanup_terminal_digest IS NULL LIMIT 65",
    "SELECT custody_id AS id FROM attachment_custody_slots LIMIT 65",
  ]) for (const row of db.query(sql).all() as { id: string }[]) ids.add(row.id);
  if (ids.size > 64) fail();
  return [...ids].map((id) => readAttachmentSetWithEvidence(db, id, evidence));
}
export function reserveAttachmentSet(db: Database, input: AttachmentIngressInput, now: number, requestDigest?: string): AttachmentReservation {
  assertAttachmentDaemon(db, input);
  reconcileLiveAttachmentTerminals(db, now);
  const live = assertLiveAttachmentClosure(db);
  if (live.length >= 64) fail("ATTACHMENT_CUSTODY_LIMIT");
  const id = `custody_${randomUUID().replaceAll("-", "")}`;
  const origin = originSchema.parse({ version: 1, id, input: attachmentInputProof(input, requestDigest), daemonGeneration: input.daemonGeneration, bootId: input.bootId, createdAt: now });
  const digest = proofDigest(origin);
  const used = new Set((db.query("SELECT slot FROM attachment_custody_slots").all() as { slot: number }[]).map((row) => row.slot));
  const slot = Array.from({ length: 64 }, (_, index) => index + 1).find((value) => !used.has(value));
  if (slot === undefined) fail("ATTACHMENT_CUSTODY_LIMIT");
  db.query("INSERT INTO attachment_custody_sets(id,original_key,origin_json,digest) VALUES(?,?,?,?)").run(id, input.idempotencyKey, JSON.stringify(origin), digest);
  db.query("INSERT INTO attachment_custody_anchors(id,kind,original_key,proof_json,digest) VALUES(?,'custody',?,?,?)").run(id, input.idempotencyKey, JSON.stringify(origin), digest);
  for (const [index, member] of origin.input.members.entries()) db.query("INSERT INTO attachment_custody_members(custody_id,position,digest,canonical_media_type,byte_length) VALUES(?,?,?,?,?)").run(id, index, member.digest, member.canonicalMediaType, member.byteLength);
  db.query("INSERT INTO attachment_custody_slots(slot,custody_id,digest) VALUES(?,?,?)").run(slot, id, digest);
  readAttachmentSet(db, id);
  return { reservationId: id, reservationDigest: digest };
}
export function requireAttachmentReservation(db: Database, ref: AttachmentReservation, input: AttachmentIngressInput, requestDigest?: string): CustodySet {
  const set = readAttachmentSet(db, custodyId.parse(ref.reservationId));
  if (set.digest !== digest.parse(ref.reservationDigest) || JSON.stringify(set.origin.input) !== JSON.stringify(attachmentInputProof(input, requestDigest))) fail("ATTACHMENT_CUSTODY_REQUEST_CONFLICT");
  if (set.releasedBy !== null) fail("ATTACHMENT_CUSTODY_REQUEST_CONFLICT");
  if (set.origin.daemonGeneration !== input.daemonGeneration || set.origin.bootId !== input.bootId) fail("ATTACHMENT_CUSTODY_AUTHORITY_CHANGED");
  return set;
}
function appendDisposition(db: Database, set: CustodySet, kind: DispositionRow["kind"], attemptId: string | null, proof: unknown, now: number): string {
  const previous = db.query("SELECT digest FROM attachment_custody_dispositions WHERE custody_id=? ORDER BY ordinal DESC LIMIT 1").get(set.origin.id) as { digest: string } | null;
  const row = { custody_id: set.origin.id, ordinal: previous === null ? 1 : 2, original_key: set.origin.input.idempotencyKey, predecessor: previous?.digest ?? null, kind, attempt_id: attemptId,
    proof_json: JSON.stringify(proof), recorded_at: Math.max(now, set.origin.createdAt) };
  const digest = dispositionDigest(row);
  db.query("INSERT INTO attachment_custody_dispositions(custody_id,ordinal,original_key,predecessor,kind,attempt_id,proof_json,digest,recorded_at) VALUES(?,?,?,?,?,?,?,?,?)")
    .run(row.custody_id, row.ordinal, row.original_key, row.predecessor, row.kind, row.attempt_id, row.proof_json, digest, row.recorded_at);
  if (kind !== "mutation_owned") {
    db.query("UPDATE attachment_custody_sets SET released_by=? WHERE id=? AND released_by IS NULL").run(digest, set.origin.id);
    db.query("UPDATE attachment_custody_anchors SET released_by=? WHERE id=? AND released_by IS NULL").run(digest, set.origin.id);
    db.query("DELETE FROM attachment_custody_slots WHERE custody_id=?").run(set.origin.id);
  }
  return digest;
}
export function releaseAttachmentSet(db: Database, ref: AttachmentReservation, daemon: AttachmentDaemon, now: number,
  reason: "released" = "released"): { released: boolean; reason: "released" | "already_released" | "mutation_owned" } {
  assertAttachmentDaemon(db, daemon);
  const set = readAttachmentSet(db, ref.reservationId);
  if (set.digest !== ref.reservationDigest) fail("ATTACHMENT_CUSTODY_REQUEST_CONFLICT");
  if (set.parentAttemptId !== null) return { released: false, reason: "mutation_owned" };
  if (set.releasedBy !== null) return { released: false, reason: "already_released" };
  if (set.origin.daemonGeneration !== daemon.daemonGeneration || set.origin.bootId !== daemon.bootId) fail("ATTACHMENT_CUSTODY_AUTHORITY_CHANGED");
  appendDisposition(db, set, reason, null, { daemonGeneration: daemon.daemonGeneration, bootId: daemon.bootId }, now);
  readAttachmentSet(db, set.origin.id);
  return { released: true, reason: "released" };
}
export function transferAttachmentQueue(db: Database, ref: AttachmentReservation, daemon: AttachmentDaemon, input: AttachmentIngressInput, queueId: string, now: number): void {
  assertAttachmentDaemon(db, daemon);
  const set = requireAttachmentReservation(db, ref, input);
  const identity = readQueueAttachmentIdentity(db, queueId);
  if (set.parentAttemptId !== null || identity === null || input.kind !== "session.queue"
    || identity.idempotencyKey !== input.idempotencyKey || identity.sessionId !== input.sessionId
    || identity.requestDigest !== set.origin.input.requestDigest || identity.manifestDigest !== queueAttachmentManifestDigest(input.attachments)
    || identity.messageDigest !== set.origin.input.messageDigest || JSON.stringify(identity.authority) !== JSON.stringify(input.providerAuthority)) fail("ATTACHMENT_CUSTODY_REQUEST_CONFLICT");
  appendDisposition(db, set, "queue_transferred", null, { queueId, identityDigest: queueAttachmentIdentityDigest(identity) }, now);
  readAttachmentSet(db, set.origin.id);
}
export function initialEmptyAttachmentInput(input: Omit<AttachmentIngressInput, "daemonGeneration" | "bootId">, requestDigest?: string): InitialAttachmentInput {
  const proof = attachmentInputProof(input, requestDigest);
  if (proof.referenceCount !== 0) fail();
  const digest = proofDigest(proof);
  return { format: "empty_v1", custodyId: null, digest };
}
export function insertEmptyAttachmentInput(db: Database, attemptId: string, input: Omit<AttachmentIngressInput, "daemonGeneration" | "bootId">, requestDigest?: string): void {
  const proof = attachmentInputProof(input, requestDigest);
  const { digest } = initialEmptyAttachmentInput(input, requestDigest);
  db.query("INSERT INTO attachment_custody_anchors(id,kind,original_key,attempt_id,proof_json,digest) VALUES(?,'empty_input_v1',?,?,?,?)")
    .run(`empty:${attemptId}`, input.idempotencyKey, attemptId, JSON.stringify(proof), digest);
}
export function bindAttachmentParent(db: Database, attemptId: string, set: CustodySet, now: number): void {
  if (set.parentAttemptId !== null || set.releasedBy !== null) fail();
  appendDisposition(db, set, "mutation_owned", attemptId, { attemptId, requestDigest: set.origin.input.requestDigest }, now);
  readAttachmentSet(db, set.origin.id);
}
export function readAttachmentParent(db: Database, attemptId: string): { format: "empty_v1" | "retained_v1" | null; proof: InputProof | null; custody: CustodySet | null } {
  return readAttachmentParentWithEvidence(db, attemptId, sourceSelectedCustodyEvidence);
}
function readAttachmentParentWithEvidence(db: Database, attemptId: string, evidence: AttachmentCustodyAuditOptions): { format: "empty_v1" | "retained_v1" | null; proof: InputProof | null; custody: CustodySet | null } {
  const row = db.query("SELECT * FROM mutation_attempts WHERE id=?").get(attemptId) as ParentRow | null;
  if (row === null) fail();
  if (row.attachment_input_format === null) { assertUnknownParent(db, row, evidence); return { format: null, proof: null, custody: null }; }
  let proof: InputProof;
  let custody: CustodySet | null = null;
  if (row.attachment_input_format === "retained_v1") {
    if (row.attachment_custody_id === null) fail();
    custody = readAttachmentSetWithEvidence(db, row.attachment_custody_id, evidence);
    if (custody.parentAttemptId !== row.id || custody.digest !== row.attachment_input_digest) fail();
    proof = custody.origin.input;
  } else if (row.attachment_input_format === "empty_v1") {
    const anchor = db.query("SELECT * FROM attachment_custody_anchors WHERE digest=?").get(row.attachment_input_digest) as
      { id: string; kind: string; original_key: string; attempt_id: string; proof_json: string; digest: string; released_by: string | null } | null;
    if (anchor === null || anchor.id !== `empty:${row.id}` || anchor.kind !== "empty_input_v1" || anchor.attempt_id !== row.id || anchor.original_key !== row.idempotency_key || anchor.released_by !== null || row.attachment_custody_id !== null) fail();
    proof = decode(inputProofSchema, anchor.proof_json);
    if (proofDigest(proof) !== anchor.digest || proof.referenceCount !== 0 || proof.members.length !== 0 || proof.referenceDigest !== attachmentReferencesDigest([])) fail();
  } else return fail();
  if (proof.kind !== row.kind || proof.sessionId !== row.authority_id || proof.idempotencyKey !== row.idempotency_key || proof.requestDigest !== row.request_digest || proof.authority.processGeneration !== row.authority_generation) fail();
  const authority = db.query("SELECT provider_account_id,profile_id,provider,binding_generation,process_generation FROM mutation_provider_authorities WHERE attempt_id=? AND role='primary'").get(row.id) as
    { provider_account_id: string; profile_id: string; provider: string; binding_generation: number; process_generation: number } | null;
  if (authority === null || authority.provider_account_id !== proof.authority.providerAccountId || authority.profile_id !== proof.authority.profileId
    || authority.provider !== proof.authority.provider || authority.binding_generation !== proof.authority.bindingGeneration || authority.process_generation !== proof.authority.processGeneration) fail();
  if (row.attachment_cleanup_terminal_digest !== null && attachmentTerminalProofWithEvidence(db, row.id, evidence) !== row.attachment_cleanup_terminal_digest) fail();
  return { format: row.attachment_input_format, proof, custody };
}
type ParentRow = { id: string; idempotency_key: string; kind: string; authority_id: string; authority_generation: number; request_digest: string;
  state: string; result_json: string | null; request_format: string | null; attachment_input_format: string | null;
  attachment_custody_id: string | null; attachment_input_digest: string | null; attachment_cleanup_terminal_digest: string | null };
const unknownProof = (row: ParentRow) => ({ attemptId: row.id, idempotencyKey: row.idempotency_key, kind: row.kind, sessionId: row.authority_id,
  authorityGeneration: row.authority_generation, requestDigest: row.request_digest, requestFormat: row.request_format });
function assertUnknownParent(db: Database, row: ParentRow, evidence: AttachmentCustodyAuditOptions): void {
  const blocker = db.query("SELECT * FROM attachment_legacy_cleanup_blockers WHERE attempt_id=?").get(row.id) as
    { original_key: string; origin_json: string; terminal_digest: string | null } | null;
  const anchor = db.query("SELECT * FROM attachment_custody_anchors WHERE id=?").get(`legacy:${row.id}`) as
    { kind: string; original_key: string; attempt_id: string; proof_json: string; digest: string | null; released_by: string | null } | null;
  const json = JSON.stringify(unknownProof(row));
  if (blocker === null || anchor === null || blocker.original_key !== row.idempotency_key || blocker.origin_json !== json
    || anchor.kind !== "legacy_unknown" || anchor.original_key !== row.idempotency_key || anchor.attempt_id !== row.id || anchor.proof_json !== json || anchor.digest !== null
    || blocker.terminal_digest !== row.attachment_cleanup_terminal_digest || anchor.released_by !== row.attachment_cleanup_terminal_digest) fail();
  if (row.attachment_cleanup_terminal_digest !== null && attachmentTerminalProofWithEvidence(db, row.id, evidence) !== row.attachment_cleanup_terminal_digest) fail();
}
/** Conservatively returns null when the existing effect contract cannot prove
 * terminality. SQL state labels and session/provider retirement are not proofs. */
export function attachmentTerminalProof(db: Database, attemptId: string): string | null {
  return attachmentTerminalProofWithEvidence(db, attemptId, sourceSelectedCustodyEvidence);
}
function attachmentTerminalProofWithEvidence(db: Database, attemptId: string, context: AttachmentCustodyAuditOptions): string | null {
  const row = db.query("SELECT * FROM mutation_attempts WHERE id=?").get(attemptId) as ParentRow | null;
  if (row === null) fail();
  if (row.request_format !== null) {
    const owner = context.kind === "historical"
      ? requireHistoricalSessionSendOwnerForAudit(db, { attemptId }, historicalSessionSendOwnerAuditFormatSchema.parse(context.format))
      : requireSessionSendOwner(db, { attemptId });
    if (!["accepted", "abandoned", "cancelled"].includes(owner.state)) return null;
    return proofDigest({ attemptId, ownerDigest: owner.ownerDigest, outcomes: owner.outcomes });
  }
  const effect = db.query("SELECT kind,evidence_digest FROM mutation_effect_evidence WHERE attempt_id=?").get(attemptId) as
    { kind: string; evidence_digest: string } | null;
  if (row.state === "cancelled" && effect === null && row.result_json === null) return proofDigest({ attemptId, state: "cancelled", requestDigest: row.request_digest });
  if (effect === null || effect.kind !== row.kind) return null;
  const selected = (() => {
    try {
      if (context.kind === "historical") {
        if (!db.inTransaction) return null;
        const raw = z.object({ bytes: z.instanceof(Uint8Array) }).strict().safeParse(db.query(`SELECT
          CASE WHEN length(CAST(evidence_json AS BLOB))<=? THEN CAST(evidence_json AS BLOB) ELSE NULL END AS bytes
          FROM mutation_effect_evidence WHERE attempt_id=?`).get(EFFECT_EVIDENCE_JSON_MAX_BYTES, attemptId));
        if (!raw.success) return null;
        const json = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(raw.data.bytes);
        const checked = checkMutationEvidenceEnvelope({ format: context.format, json, digest: effect.evidence_digest,
          evidenceKind: effect.kind, parentKind: row.kind });
        return checked.kind === "checked_envelope" && checked.canonicalJson === json
          ? { format: checked.format, evidence: checked.value } : null;
      }
      const checked = readMutationEffectEvidenceProvenance(db, attemptId);
      return checked.kind === "parsed" && checked.digest === effect.evidence_digest
        ? { format: checked.format, evidence: checked.evidence } : null;
    } catch { return null; }
  })();
  if (selected === null || (selected.evidence.kind !== "session.send" && selected.evidence.kind !== "session.steer")
    || selected.evidence.clientMessageId !== row.id || selected.evidence.kind !== row.kind) return null;
  const evidence = selected.evidence;
  // Before the joined replacement is installed, the frozen terminal SQL never
  // admitted actor-bearing generic effects. Preserve that historical release
  // boundary; subsequent source-selected reconciliation uses the joined guard.
  if (context.kind === "historical" && "messageActor" in evidence && evidence.messageActor !== undefined) return null;
  if (selected.format === "joined_v1") {
    const transcript = db.query(`SELECT CASE WHEN length(CAST(transcript_intent_json AS BLOB))<=?
      THEN transcript_intent_json ELSE NULL END AS transcript_intent_json FROM mutation_attempts WHERE id=?`)
      .get(EFFECT_EVIDENCE_JSON_MAX_BYTES, attemptId) as { transcript_intent_json: string | null };
    try {
      const actor = z.object({ actor: z.string() }).passthrough().parse(JSON.parse(transcript.transcript_intent_json ?? "null") as unknown).actor;
      if (!("messageActor" in evidence) || evidence.messageActor === undefined || evidence.messageActor !== actor) return null;
    } catch { return null; }
  }
  const nativeId = z.string().min(1).max(200);
  const primaryRow = db.query("SELECT provider_account_id,profile_id,provider,binding_generation,process_generation FROM mutation_provider_authorities WHERE attempt_id=? AND role='primary'").get(row.id) as
    { provider_account_id: string; profile_id: string; provider: string; binding_generation: number; process_generation: number } | null;
  if (primaryRow === null) return null;
  const primary = providerAccountAuthoritySchema.safeParse({ providerAccountId: primaryRow.provider_account_id, profileId: primaryRow.profile_id,
    provider: primaryRow.provider, bindingGeneration: primaryRow.binding_generation, processGeneration: primaryRow.process_generation });
  if (!primary.success || primary.data.processGeneration !== row.authority_generation) return null;
  if (evidence.kind === "session.send" && evidence.runtimeProfile !== undefined
    && (evidence.runtimeProfile.profileId !== primary.data.profileId || evidence.runtimeProfile.processGeneration !== row.authority_generation)) return null;
  const turnReceipt = z.object({ turnId: nativeId, status: z.enum(["completed", "interrupted", "failed", "inProgress"]).optional(),
    sourceId: nativeId.optional(), effectiveRuntimeProfile: reviewedRuntimeProfileSchema.optional() }).strict();
  const steerReceipt = z.object({ steered: z.literal(true), activeTurnId: nativeId }).strict();
  const validReceipt = (json: string | null): { turnId: string } | null => {
    if (json === null || utf8Bytes(json) > 262144) return null;
    let value: unknown;
    try { value = JSON.parse(json) as unknown; } catch { return null; }
    if (evidence.kind === "session.steer") {
      const receipt = steerReceipt.safeParse(value);
      return receipt.success && evidence.activeTurnId !== null && receipt.data.activeTurnId === evidence.activeTurnId ? { turnId: receipt.data.activeTurnId } : null;
    }
    const receipt = turnReceipt.safeParse(value);
    if (!receipt.success || receipt.data.sourceId !== row.id) return null;
    if (receipt.data.effectiveRuntimeProfile !== undefined && JSON.stringify(receipt.data.effectiveRuntimeProfile) !== JSON.stringify(evidence.runtimeProfile)) return null;
    return { turnId: receipt.data.turnId };
  };
  const resolution = db.query("SELECT resolution_kind,evidence_json,receipt_json,created_at FROM mutation_resolutions WHERE attempt_id=?").get(attemptId) as
    { resolution_kind: string; evidence_json: string; receipt_json: string | null; created_at: number } | null;
  if (resolution !== null) {
    if (utf8Bytes(resolution.evidence_json) > 262144) return null;
    let value: unknown;
    try { value = JSON.parse(resolution.evidence_json) as unknown; } catch { return null; }
    if (resolution.resolution_kind === "abandoned") {
      const abandoned = z.object({ action: z.literal("user_abandon"), providerEffectRetried: z.literal(false), providerStateDeleted: z.literal(false),
        observedProviderUpdatedAt: z.number().nonnegative().nullable().optional() }).strict().safeParse(value);
      if (!abandoned.success || resolution.receipt_json !== null) return null;
    } else if (resolution.resolution_kind === "proven_applied") {
      const receipt = validReceipt(resolution.receipt_json);
      const causal = z.object({ kind: z.enum(["session.send", "session.steer"]), clientMessageId: nativeId, turnId: nativeId,
        providerUpdatedAt: z.number().nonnegative().optional() }).strict().safeParse(value);
      if (receipt === null || !causal.success || causal.data.kind !== row.kind || causal.data.clientMessageId !== evidence.clientMessageId || causal.data.turnId !== receipt.turnId) return null;
    } else return null;
    return proofDigest({ attemptId, requestDigest: row.request_digest, effectDigest: effect.evidence_digest, resolution });
  }
  if (row.state === "failed" && row.result_json !== null) {
    let failure: unknown;
    try { failure = JSON.parse(row.result_json) as unknown; } catch { return null; }
    if (!z.object({ code: z.string().min(1).max(80).regex(/^[A-Za-z][A-Za-z0-9_]*$/u) }).strict().safeParse(failure).success) return null;
    return proofDigest({ attemptId, requestDigest: row.request_digest, effectDigest: effect.evidence_digest, state: row.state, result: row.result_json });
  }
  if (row.state === "applied" && validReceipt(row.result_json) !== null) {
    return proofDigest({ attemptId, requestDigest: row.request_digest, effectDigest: effect.evidence_digest, state: row.state, result: row.result_json });
  }
  return null;
}
export function settleAttachmentParent(db: Database, attemptId: string, now: number): void {
  settleAttachmentParentWithEvidence(db, attemptId, now, sourceSelectedCustodyEvidence);
}
function settleAttachmentParentWithEvidence(db: Database, attemptId: string, now: number, evidence: AttachmentCustodyAuditOptions): void {
  const row = db.query("SELECT * FROM mutation_attempts WHERE id=? AND kind IN ('session.send','session.steer')").get(attemptId) as ParentRow | null;
  if (row === null) return;
  const parent = readAttachmentParentWithEvidence(db, attemptId, evidence);
  const terminal = attachmentTerminalProofWithEvidence(db, attemptId, evidence);
  if (terminal === null || row.attachment_cleanup_terminal_digest !== null) return;
  // A terminal pointer is a derived, one-way projection of immutable proof.
  db.query("UPDATE mutation_attempts SET attachment_cleanup_terminal_digest=? WHERE id=? AND attachment_cleanup_terminal_digest IS NULL").run(terminal, attemptId);
  if (parent.format === null) {
    db.query("UPDATE attachment_legacy_cleanup_blockers SET terminal_digest=? WHERE attempt_id=?").run(terminal, attemptId);
    db.query("UPDATE attachment_custody_anchors SET released_by=? WHERE id=?").run(terminal, `legacy:${attemptId}`);
  } else if (parent.custody !== null) appendDisposition(db, parent.custody, "terminal", attemptId, { terminalDigest: terminal }, now);
  readAttachmentParentWithEvidence(db, attemptId, evidence);
}
export function hasUnknownAttachmentCustody(db: Database): boolean {
  const rows = [
    db.query("SELECT id FROM mutation_attempts WHERE kind IN ('session.send','session.steer') AND attachment_input_format IS NULL AND attachment_cleanup_terminal_digest IS NULL LIMIT 1").get(),
    db.query("SELECT attempt_id AS id FROM attachment_legacy_cleanup_blockers WHERE terminal_digest IS NULL LIMIT 1").get(),
    db.query("SELECT attempt_id AS id FROM attachment_custody_anchors WHERE kind='legacy_unknown' AND released_by IS NULL LIMIT 1").get(),
  ] as ({ id: string } | null)[];
  for (const row of rows) if (row !== null) readAttachmentParent(db, row.id);
  return rows.some((row) => row !== null);
}
export function auditAttachmentCustody(db: Database, options: AttachmentCustodyAuditOptions = sourceSelectedCustodyEvidence): void {
  const parsed = custodyAuditOptionsSchema.safeParse(options);
  if (!parsed.success || (parsed.data.kind === "historical" && !db.inTransaction)) fail();
  const evidence = parsed.data;
  assertAttachmentCustodySchema(db, evidence.kind === "historical" ? "historical" : "joined");
  assertLiveAttachmentClosureWithEvidence(db, evidence);
  for (const [table, column] of [["mutation_attempts", "id"], ["attachment_custody_sets", "id"], ["attachment_custody_anchors", "id"], ["attachment_legacy_cleanup_blockers", "attempt_id"],
    ["attachment_custody_members", "custody_id"], ["attachment_custody_dispositions", "custody_id"]] as const) {
    let cursor = "";
    for (;;) {
      const rows = db.query(`SELECT ${column} AS id FROM ${table} WHERE ${column}>? ${table === "mutation_attempts" ? "AND kind IN ('session.send','session.steer')" : ""} GROUP BY ${column} ORDER BY ${column} LIMIT 100`).all(cursor) as { id: string }[];
      if (rows.length === 0) break;
      for (const row of rows) {
        if (table === "attachment_custody_sets" || table === "attachment_custody_members" || table === "attachment_custody_dispositions") readAttachmentSetWithEvidence(db, row.id, evidence);
        else if (table === "attachment_custody_anchors") {
          const a = db.query("SELECT kind,attempt_id FROM attachment_custody_anchors WHERE id=?").get(row.id) as { kind: string; attempt_id: string | null };
          if (a.kind === "custody") readAttachmentSetWithEvidence(db, row.id, evidence); else if (a.attempt_id === null) fail(); else readAttachmentParentWithEvidence(db, a.attempt_id, evidence);
        } else readAttachmentParentWithEvidence(db, row.id, evidence);
        cursor = row.id;
      }
    }
  }
}
export function reconcileAttachmentTerminals(db: Database, now: number, options: AttachmentCustodyAuditOptions = sourceSelectedCustodyEvidence): void {
  const parsed = custodyAuditOptionsSchema.safeParse(options);
  if (!parsed.success || (parsed.data.kind === "historical" && !db.inTransaction)) fail();
  let cursor = "";
  for (;;) {
    const rows = db.query("SELECT id FROM mutation_attempts WHERE id>? AND kind IN ('session.send','session.steer') AND attachment_cleanup_terminal_digest IS NULL ORDER BY id LIMIT 100").all(cursor) as { id: string }[];
    if (rows.length === 0) break;
    for (const row of rows) { settleAttachmentParentWithEvidence(db, row.id, now, parsed.data); cursor = row.id; }
  }
}
/** Missed legacy bulk settlement hooks may conservatively leave a projection.
 * Reconcile only bounded live indexes here; never scan terminal history on GC. */
export function reconcileLiveAttachmentTerminals(db: Database, now: number): void {
  for (const set of assertLiveAttachmentClosure(db)) if (set.parentAttemptId !== null) settleAttachmentParent(db, set.parentAttemptId, now);
  const ids = new Set<string>();
  for (const query of [
    "SELECT id FROM mutation_attempts WHERE kind IN ('session.send','session.steer') AND attachment_input_format IS NULL AND attachment_cleanup_terminal_digest IS NULL LIMIT 64",
    "SELECT attempt_id AS id FROM attachment_legacy_cleanup_blockers WHERE terminal_digest IS NULL LIMIT 64",
    "SELECT attempt_id AS id FROM attachment_custody_anchors WHERE kind='legacy_unknown' AND released_by IS NULL LIMIT 64",
  ]) for (const row of db.query(query).all() as { id: string }[]) ids.add(row.id);
  for (const id of [...ids].slice(0, 64)) settleAttachmentParent(db, id, now);
}
export function retireAttachmentIngress(db: Database, daemon: AttachmentDaemon, now: number): void {
  assertAttachmentDaemon(db, daemon);
  for (const set of assertLiveAttachmentClosure(db)) if (set.parentAttemptId === null
    && (set.origin.daemonGeneration !== daemon.daemonGeneration || set.origin.bootId !== daemon.bootId)) {
    if (db.query("SELECT 1 FROM mutation_attempts WHERE attachment_custody_id=? LIMIT 1").get(set.origin.id) !== null) fail();
    appendDisposition(db, set, "boot_retired", null, daemon, now);
  }
}
