import { createHash } from "node:crypto";
import type { Database } from "bun:sqlite";
import { z } from "zod";

import { providerAccountAuthoritySchema, sessionRoutingProvenanceSchema } from "../domain/provider-accounts";
import { reviewedRuntimeProfileProviderV1 as reviewedRuntimeProfileProvider, reviewedRuntimeProfileV1Schema as reviewedRuntimeProfileSchema } from "../domain/runtime-profile";
import { sessionSendRequestFingerprintSchema } from "../domain/session-send-request";
import { attemptIdSchema, sessionIdSchema, unixMillisecondsSchema } from "../domain/values";
import { assertNoAutomaticPointerMoveOwnership, AutomaticPointerMoveStoreError } from "./automatic-pointer-move";
import { assertQueueAttachmentMutationIntegrity, QueueAttachmentIdentityError } from "./queue-attachment-identity";
import { ATTACHMENT_CUSTODY_COLUMNS, assertAttachmentCustodyNamespace, AttachmentCustodyNamespaceError, type InitialAttachmentInput } from "./attachment-custody-schema";
import { normalizeSchemaSql } from "./schema-cohort";
import { schemaSqlBeforeJoinedTranscriptColumns, type UsageSchemaColumnMode } from "./joined-transcript-columns";
import { checkMutationEvidenceEnvelope, historicalEffectEvidenceFormatSchema } from "./effect-evidence-reader";
import { insertJoinedMutationEffectEvidence, readMutationEffectEvidenceProvenance } from "./effect-evidence-provenance";

export const SESSION_SEND_REQUEST_FORMAT = "original_send_v1";
const digestSchema = z.string().regex(/^[0-9a-f]{64}$/u);
const revisionSchema = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const nativeIdSchema = z.string().min(1).max(200);
export const ownedDirectSendEvidenceSchema = z.object({
  kind: z.literal("session.send"), providerThreadId: nativeIdSchema,
  baseline: z.object({ providerUpdatedAt: z.number().finite().nonnegative().nullable(),
    status: z.literal("idle"), activeTurnId: z.null() }).strict(),
  clientMessageId: attemptIdSchema, messageDigest: digestSchema, runtimeProfile: reviewedRuntimeProfileSchema,
}).strict();
export const ownedDirectSendReceiptSchema = z.object({
  turnId: nativeIdSchema, status: z.enum(["completed", "interrupted", "failed", "inProgress"]),
  sourceId: attemptIdSchema, effectiveRuntimeProfile: reviewedRuntimeProfileSchema,
}).strict();
export const sessionSendOwnerSchema = z.object({
  version: z.literal(1), attemptId: attemptIdSchema, idempotencyKey: z.string().uuid(), sessionId: sessionIdSchema,
  fingerprint: sessionSendRequestFingerprintSchema, sourceAuthority: providerAccountAuthoritySchema,
  sourceThreadId: nativeIdSchema, sourceSessionRevision: revisionSchema, sourceAuthorityRevision: revisionSchema,
  routingProvenance: sessionRoutingProvenanceSchema, appliedPointerRevision: revisionSchema.nullable(),
  createdAt: unixMillisecondsSchema,
}).strict();
export type SessionSendOwner = z.infer<typeof sessionSendOwnerSchema>;
export const sessionSendExecutionClaimSchema = z.object({
  version: z.literal(1), mode: z.literal("direct"), attemptId: attemptIdSchema, ownerDigest: digestSchema,
  daemonGeneration: revisionSchema, bootId: z.string().regex(/^boot_[a-f0-9]{32}$/u), executionAuthority: providerAccountAuthoritySchema,
  sessionRevision: revisionSchema, sessionAuthorityRevision: revisionSchema, providerThreadId: nativeIdSchema,
  clientMessageId: attemptIdSchema, evidence: ownedDirectSendEvidenceSchema, evidenceDigest: digestSchema,
  createdAt: unixMillisecondsSchema,
}).strict();
export type SessionSendExecutionClaim = z.infer<typeof sessionSendExecutionClaimSchema>;
export const ownedDirectSendOutcomeInputSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("accepted"), receipt: ownedDirectSendReceiptSchema }).strict(),
  z.object({ kind: z.literal("ambiguous"), reason: z.enum(["daemon_restart", "provider_outcome_unknown", "local_commit_unknown"]) }).strict(),
  z.object({ kind: z.literal("abandoned"), acknowledgeOutcomeUnknown: z.literal(true) }).strict(),
]);
export type OwnedDirectSendOutcomeInput = z.infer<typeof ownedDirectSendOutcomeInputSchema>;
export const sessionSendOutcomeSchema = z.object({
  version: z.literal(1), attemptId: attemptIdSchema, ordinal: z.union([z.literal(1), z.literal(2)]),
  ownerDigest: digestSchema, claimDigest: digestSchema.nullable(), previousDigest: digestSchema.nullable(),
  outcome: z.union([ownedDirectSendOutcomeInputSchema, z.object({ kind: z.literal("cancelled") }).strict()]),
  recordedAt: unixMillisecondsSchema,
}).strict();
export type SessionSendOutcome = z.infer<typeof sessionSendOutcomeSchema>;
export class SessionSendOwnershipError extends Error {
  constructor(readonly code: "SESSION_SEND_OWNER_CORRUPT" | "SESSION_SEND_OWNED_API_REQUIRED" | "SESSION_SEND_REQUEST_CONFLICT"
    | "SESSION_SEND_SOURCE_CHANGED" | "SESSION_SEND_CLAIM_CONFLICT" | "SESSION_SEND_OWNER_LIMIT") {
    super(code); this.name = "SessionSendOwnershipError";
  }
}
export const sessionSendDigest = (kind: string, value: unknown): string =>
  createHash("sha256").update(JSON.stringify({ domain: `hra.session-send.${kind}.v1`, value })).digest("hex");
export const sessionSendEvidenceDigest = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");

const ownerTables = [
  { name: "session_send_owners", sql: `CREATE TABLE IF NOT EXISTS session_send_owners(
    attempt_id TEXT PRIMARY KEY REFERENCES mutation_attempts(id), original_key TEXT NOT NULL UNIQUE,
    session_id TEXT NOT NULL REFERENCES sessions(id), owner_json TEXT NOT NULL CHECK(json_valid(owner_json) AND length(CAST(owner_json AS BLOB))<=8192),
    owner_digest TEXT NOT NULL CHECK(length(owner_digest)=64)
  ) STRICT;` },
  { name: "session_send_execution_claims", sql: `CREATE TABLE IF NOT EXISTS session_send_execution_claims(
    attempt_id TEXT PRIMARY KEY REFERENCES session_send_owners(attempt_id), original_key TEXT NOT NULL UNIQUE,
    claim_json TEXT NOT NULL CHECK(json_valid(claim_json) AND length(CAST(claim_json AS BLOB))<=262144),
    claim_digest TEXT NOT NULL CHECK(length(claim_digest)=64)
  ) STRICT;` },
  { name: "session_send_owner_outcomes", sql: `CREATE TABLE IF NOT EXISTS session_send_owner_outcomes(
    attempt_id TEXT NOT NULL REFERENCES session_send_owners(attempt_id), original_key TEXT NOT NULL,
    ordinal INTEGER NOT NULL CHECK(ordinal IN (1,2)), outcome_json TEXT NOT NULL CHECK(json_valid(outcome_json) AND length(CAST(outcome_json AS BLOB))<=262144),
    outcome_digest TEXT NOT NULL CHECK(length(outcome_digest)=64), PRIMARY KEY(attempt_id,ordinal), UNIQUE(original_key,ordinal)
  ) STRICT;` },
  { name: "session_send_owner_anchors", sql: `CREATE TABLE IF NOT EXISTS session_send_owner_anchors(
    attempt_id TEXT NOT NULL REFERENCES session_send_owners(attempt_id), original_key TEXT NOT NULL,
    kind TEXT NOT NULL CHECK(kind IN ('owner','claim','outcome_1','outcome_2')), digest TEXT NOT NULL CHECK(length(digest)=64),
    PRIMARY KEY(attempt_id,kind), UNIQUE(original_key,kind)
  ) STRICT;` },
] as const;
/** Presence is a fence, never a substitute for the canonical reader. */
export const sessionSendOwnedSql = (id: string, key: string, format: string): string => `(${format} IS NOT NULL
  OR EXISTS(SELECT 1 FROM session_send_owners owned WHERE owned.attempt_id=${id} OR owned.original_key=${key})
  OR EXISTS(SELECT 1 FROM session_send_owner_anchors anchored WHERE anchored.attempt_id=${id} OR anchored.original_key=${key})
  OR EXISTS(SELECT 1 FROM session_send_execution_claims claimed WHERE claimed.attempt_id=${id} OR claimed.original_key=${key})
  OR EXISTS(SELECT 1 FROM session_send_owner_outcomes settled WHERE settled.attempt_id=${id} OR settled.original_key=${key}))`;
export const sessionSendUnclaimedSql = (alias: string): string => `(${alias}.request_format='${SESSION_SEND_REQUEST_FORMAT}'
  AND ${alias}.kind='session.send' AND ${alias}.state='prepared' AND ${alias}.result_json IS NULL
  AND EXISTS(SELECT 1 FROM session_send_owners owned JOIN session_send_owner_anchors anchor ON anchor.attempt_id=owned.attempt_id
    AND anchor.kind='owner' AND anchor.original_key=owned.original_key AND anchor.digest=owned.owner_digest
    WHERE owned.attempt_id=${alias}.id AND owned.original_key=${alias}.idempotency_key)
  AND NOT EXISTS(SELECT 1 FROM session_send_execution_claims claimed WHERE claimed.attempt_id=${alias}.id)
  AND NOT EXISTS(SELECT 1 FROM session_send_owner_outcomes settled WHERE settled.attempt_id=${alias}.id)
  AND NOT EXISTS(SELECT 1 FROM mutation_effect_evidence evidence WHERE evidence.attempt_id=${alias}.id)
  AND NOT EXISTS(SELECT 1 FROM mutation_resolutions resolution WHERE resolution.attempt_id=${alias}.id))`;
const ownedNew = sessionSendOwnedSql("NEW.id", "NEW.idempotency_key", "NEW.request_format");
const ownedOld = sessionSendOwnedSql("OLD.id", "OLD.idempotency_key", "OLD.request_format");
const attachedOwned = (id: string): string => `EXISTS(SELECT 1 FROM mutation_attempts mutation WHERE mutation.id=${id}
  AND ${sessionSendOwnedSql("mutation.id", "mutation.idempotency_key", "mutation.request_format")})
  OR EXISTS(SELECT 1 FROM session_send_owners owner WHERE owner.attempt_id=${id})
  OR EXISTS(SELECT 1 FROM session_send_execution_claims claim WHERE claim.attempt_id=${id})
  OR EXISTS(SELECT 1 FROM session_send_owner_outcomes outcome WHERE outcome.attempt_id=${id})
  OR EXISTS(SELECT 1 FROM session_send_owner_anchors anchor WHERE anchor.attempt_id=${id})`;
const ownerGuards = [
  { name: "session_send_mutation_insert_guard", table: "mutation_attempts", sql: `CREATE TRIGGER IF NOT EXISTS session_send_mutation_insert_guard
    BEFORE INSERT ON mutation_attempts WHEN
      EXISTS(SELECT 1 FROM session_send_owners o WHERE o.attempt_id=NEW.id OR o.original_key=NEW.idempotency_key)
      OR EXISTS(SELECT 1 FROM session_send_execution_claims c WHERE c.attempt_id=NEW.id OR c.original_key=NEW.idempotency_key)
      OR EXISTS(SELECT 1 FROM session_send_owner_outcomes r WHERE r.attempt_id=NEW.id OR r.original_key=NEW.idempotency_key)
      OR EXISTS(SELECT 1 FROM session_send_owner_anchors a WHERE a.attempt_id=NEW.id OR a.original_key=NEW.idempotency_key)
    BEGIN SELECT RAISE(ABORT,'SESSION_SEND_OWNER_CORRUPT'); END;` },
  { name: "session_send_format_immutable", table: "mutation_attempts", sql: `CREATE TRIGGER IF NOT EXISTS session_send_format_immutable
    BEFORE UPDATE OF request_format ON mutation_attempts WHEN NEW.request_format IS NOT OLD.request_format
    BEGIN SELECT RAISE(ABORT,'SESSION_SEND_OWNER_CORRUPT'); END;` },
  { name: "session_send_owner_insert_guard", table: "session_send_owners", sql: `CREATE TRIGGER IF NOT EXISTS session_send_owner_insert_guard
    BEFORE INSERT ON session_send_owners WHEN NOT EXISTS(SELECT 1 FROM mutation_attempts m
      WHERE m.id=NEW.attempt_id AND m.idempotency_key=NEW.original_key AND m.authority_id=NEW.session_id
        AND m.kind='session.send' AND m.request_format='${SESSION_SEND_REQUEST_FORMAT}' AND m.state='prepared' AND m.result_json IS NULL
        AND m.request_digest=json_extract(NEW.owner_json,'$.fingerprint.requestDigest')
        AND m.authority_generation=json_extract(NEW.owner_json,'$.sourceAuthority.processGeneration'))
    BEGIN SELECT RAISE(ABORT,'SESSION_SEND_OWNER_CORRUPT'); END;` },
  { name: "session_send_claim_insert_guard", table: "session_send_execution_claims", sql: `CREATE TRIGGER IF NOT EXISTS session_send_claim_insert_guard
    BEFORE INSERT ON session_send_execution_claims WHEN NOT EXISTS(SELECT 1 FROM session_send_owners o
      JOIN mutation_attempts m ON m.id=o.attempt_id JOIN daemon_state d ON d.singleton=1
      JOIN session_provider_authorities s ON s.session_id=o.session_id JOIN sessions local ON local.id=o.session_id
      JOIN provider_accounts account ON account.id=s.provider_account_id
      WHERE o.attempt_id=NEW.attempt_id AND o.original_key=NEW.original_key AND m.state='prepared'
        AND d.generation=json_extract(NEW.claim_json,'$.daemonGeneration') AND d.boot_id=json_extract(NEW.claim_json,'$.bootId') AND d.stopped_at IS NULL
        AND s.provider_account_id=json_extract(NEW.claim_json,'$.executionAuthority.providerAccountId')
        AND s.profile_id=json_extract(NEW.claim_json,'$.executionAuthority.profileId') AND s.provider=json_extract(NEW.claim_json,'$.executionAuthority.provider')
        AND s.binding_generation=json_extract(NEW.claim_json,'$.executionAuthority.bindingGeneration')
        AND s.process_generation=json_extract(NEW.claim_json,'$.executionAuthority.processGeneration')
        AND s.process_generation>0
        AND s.authority_revision=json_extract(NEW.claim_json,'$.sessionAuthorityRevision')
        AND local.revision=json_extract(NEW.claim_json,'$.sessionRevision') AND local.state='idle' AND local.active_turn_id IS NULL
        AND local.provider_thread_id=json_extract(NEW.claim_json,'$.providerThreadId')
        AND account.binding_generation=s.binding_generation AND account.process_generation=s.process_generation
        AND (account.readiness='signed_in' OR (account.provider!='codex' AND account.readiness='unverified' AND s.routing_provenance='explicit'))
        AND json_extract(NEW.claim_json,'$.executionAuthority')=json_extract(o.owner_json,'$.sourceAuthority')
        AND json_extract(NEW.claim_json,'$.sessionRevision')=json_extract(o.owner_json,'$.sourceSessionRevision')
        AND json_extract(NEW.claim_json,'$.sessionAuthorityRevision')=json_extract(o.owner_json,'$.sourceAuthorityRevision')
        AND NOT EXISTS(SELECT 1 FROM mutation_attempts login
          LEFT JOIN mutation_resolutions resolution ON resolution.attempt_id=login.id
          WHERE login.authority_id=account.profile_id AND login.state IN ('prepared','effect_started','ambiguous') AND resolution.attempt_id IS NULL
            AND ((account.provider='codex' AND login.kind IN ('account.login','account.logout','account.login-cancel'))
              OR (account.provider='claude' AND login.kind='account.claude-login')
              OR (account.provider='devin' AND login.kind='account.devin-login')))
        AND NOT EXISTS(SELECT 1 FROM mutation_attempts other LEFT JOIN mutation_resolutions resolution ON resolution.attempt_id=other.id
          WHERE other.authority_id=o.session_id AND other.id!=m.id AND other.state IN ('prepared','effect_started','ambiguous')
            AND resolution.attempt_id IS NULL AND NOT ${sessionSendUnclaimedSql("other")})
        AND NOT EXISTS(SELECT 1 FROM provider_interactions interaction LEFT JOIN interaction_provider_authorities authority ON authority.public_id=interaction.public_id
          WHERE interaction.state IN ('pending','response_prepared','response_written') AND (interaction.session_id=o.session_id OR (
            interaction.session_id IS NULL AND interaction.thread_id=local.provider_thread_id
            AND ((authority.public_id IS NULL AND interaction.profile_id=s.profile_id)
              OR (authority.provider_account_id=s.provider_account_id AND authority.profile_id=s.profile_id AND authority.provider=s.provider
                AND authority.binding_generation=s.binding_generation AND authority.process_generation=s.process_generation)))))
        AND NOT EXISTS(SELECT 1 FROM session_send_owner_outcomes outcome WHERE outcome.attempt_id=o.attempt_id))
    BEGIN SELECT RAISE(ABORT,'SESSION_SEND_CLAIM_CONFLICT'); END;` },
  { name: "session_send_outcome_insert_guard", table: "session_send_owner_outcomes", sql: `CREATE TRIGGER IF NOT EXISTS session_send_outcome_insert_guard
    BEFORE INSERT ON session_send_owner_outcomes WHEN NOT EXISTS(SELECT 1 FROM session_send_owners o JOIN mutation_attempts m ON m.id=o.attempt_id
      WHERE o.attempt_id=NEW.attempt_id AND o.original_key=NEW.original_key AND (
        (NEW.ordinal=1 AND ((m.state='prepared' AND json_extract(NEW.outcome_json,'$.outcome.kind')='cancelled'
          AND NOT EXISTS(SELECT 1 FROM session_send_execution_claims claim WHERE claim.attempt_id=m.id))
          OR (m.state='effect_started' AND EXISTS(SELECT 1 FROM session_send_execution_claims claim WHERE claim.attempt_id=m.id)
            AND json_extract(NEW.outcome_json,'$.outcome.kind') IN ('accepted','ambiguous'))))
        OR (NEW.ordinal=2 AND m.state='ambiguous' AND json_extract(NEW.outcome_json,'$.outcome.kind') IN ('accepted','abandoned')
          AND EXISTS(SELECT 1 FROM session_send_owner_outcomes previous WHERE previous.attempt_id=m.id AND previous.ordinal=1
            AND json_extract(previous.outcome_json,'$.outcome.kind')='ambiguous'
            AND previous.outcome_digest=json_extract(NEW.outcome_json,'$.previousDigest')))))
    BEGIN SELECT RAISE(ABORT,'SESSION_SEND_CLAIM_CONFLICT'); END;` },
  { name: "session_send_mutation_guard", table: "mutation_attempts", sql: `CREATE TRIGGER IF NOT EXISTS session_send_mutation_guard
    BEFORE UPDATE ON mutation_attempts WHEN (${ownedOld} OR ${ownedNew}) AND NOT (
      NEW.id=OLD.id AND NEW.idempotency_key=OLD.idempotency_key AND NEW.kind=OLD.kind AND NEW.authority_id=OLD.authority_id
      AND NEW.authority_generation=OLD.authority_generation AND NEW.request_digest=OLD.request_digest AND NEW.created_at=OLD.created_at
      AND NEW.request_format IS OLD.request_format AND (
        (OLD.state='prepared' AND NEW.state='effect_started' AND NEW.result_json IS NULL AND EXISTS(
          SELECT 1 FROM session_send_execution_claims c JOIN mutation_effect_evidence e ON e.attempt_id=c.attempt_id
          JOIN session_send_owner_anchors a ON a.attempt_id=c.attempt_id AND a.kind='claim' AND a.digest=c.claim_digest
          WHERE c.attempt_id=OLD.id AND e.evidence_digest=json_extract(c.claim_json,'$.evidenceDigest')
            AND NEW.updated_at=json_extract(c.claim_json,'$.createdAt')))
        OR EXISTS(SELECT 1 FROM session_send_owner_outcomes outcome JOIN session_send_owner_anchors anchor
          ON anchor.attempt_id=outcome.attempt_id AND anchor.kind='outcome_1' AND anchor.digest=outcome.outcome_digest
          WHERE outcome.attempt_id=OLD.id AND outcome.ordinal=1
            AND NEW.updated_at=json_extract(outcome.outcome_json,'$.recordedAt')
            AND NEW.state=CASE json_extract(outcome.outcome_json,'$.outcome.kind') WHEN 'accepted' THEN 'applied'
              WHEN 'ambiguous' THEN 'ambiguous' WHEN 'cancelled' THEN 'cancelled' END
            AND NEW.result_json IS json_extract(outcome.outcome_json,'$.outcome.receipt'))))
    BEGIN SELECT RAISE(ABORT,'SESSION_SEND_OWNED_API_REQUIRED'); END;` },
  { name: "session_send_mutation_delete_guard", table: "mutation_attempts", sql: `CREATE TRIGGER IF NOT EXISTS session_send_mutation_delete_guard
    BEFORE DELETE ON mutation_attempts WHEN ${ownedOld} BEGIN SELECT RAISE(ABORT,'SESSION_SEND_OWNED_API_REQUIRED'); END;` },
  { name: "session_send_effect_insert_guard", table: "mutation_effect_evidence", sql: `CREATE TRIGGER IF NOT EXISTS session_send_effect_insert_guard
    BEFORE INSERT ON mutation_effect_evidence WHEN (${attachedOwned("NEW.attempt_id")}) AND NOT EXISTS(
      SELECT 1 FROM session_send_execution_claims c WHERE c.attempt_id=NEW.attempt_id AND NEW.kind='session.send'
        AND NEW.evidence_digest=json_extract(c.claim_json,'$.evidenceDigest') AND NEW.evidence_json=json_extract(c.claim_json,'$.evidence'))
    BEGIN SELECT RAISE(ABORT,'SESSION_SEND_OWNED_API_REQUIRED'); END;` },
  { name: "session_send_resolution_insert_guard", table: "mutation_resolutions", sql: `CREATE TRIGGER IF NOT EXISTS session_send_resolution_insert_guard
    BEFORE INSERT ON mutation_resolutions WHEN (${attachedOwned("NEW.attempt_id")}) AND NOT EXISTS(
      SELECT 1 FROM session_send_owner_outcomes outcome JOIN session_send_owner_anchors anchor ON anchor.attempt_id=outcome.attempt_id
        AND anchor.kind='outcome_2' AND anchor.digest=outcome.outcome_digest
      WHERE outcome.attempt_id=NEW.attempt_id AND outcome.ordinal=2
        AND NEW.resolution_kind=CASE json_extract(outcome.outcome_json,'$.outcome.kind') WHEN 'accepted' THEN 'proven_applied' ELSE 'abandoned' END
        AND NEW.receipt_json IS json_extract(outcome.outcome_json,'$.outcome.receipt')
        AND json_extract(NEW.evidence_json,'$.outcomeDigest')=outcome.outcome_digest)
    BEGIN SELECT RAISE(ABORT,'SESSION_SEND_OWNED_API_REQUIRED'); END;` },
  { name: "session_send_authority_insert_guard", table: "mutation_provider_authorities", sql: `CREATE TRIGGER IF NOT EXISTS session_send_authority_insert_guard
    BEFORE INSERT ON mutation_provider_authorities WHEN (${attachedOwned("NEW.attempt_id")}) AND NOT EXISTS(
      SELECT 1 FROM session_send_owners o WHERE o.attempt_id=NEW.attempt_id AND NEW.role='primary' AND NEW.provenance='session_send_owner'
        AND NEW.provider_account_id=json_extract(o.owner_json,'$.sourceAuthority.providerAccountId')
        AND NEW.profile_id=json_extract(o.owner_json,'$.sourceAuthority.profileId') AND NEW.provider=json_extract(o.owner_json,'$.sourceAuthority.provider')
        AND NEW.binding_generation=json_extract(o.owner_json,'$.sourceAuthority.bindingGeneration')
        AND NEW.process_generation=json_extract(o.owner_json,'$.sourceAuthority.processGeneration'))
    BEGIN SELECT RAISE(ABORT,'SESSION_SEND_OWNED_API_REQUIRED'); END;` },
  ...["session_runtime_profiles", "session_turn_runtime_profiles"].map((table) => ({
    name: `${table}_send_owner_guard`, table, sql: `CREATE TRIGGER IF NOT EXISTS ${table}_send_owner_guard
      BEFORE INSERT ON ${table} WHEN ${attachedOwned("NEW.source_id")}
      BEGIN SELECT RAISE(ABORT,'SESSION_SEND_OWNED_API_REQUIRED'); END;`,
  })),
] as const;
export const SESSION_SEND_OWNER_SCHEMA_OBJECTS = [
  ...ownerTables.map((table) => ({ ...table, table: table.name, type: "table" })),
  { name: "session_send_owners_session", table: "session_send_owners", type: "index",
    sql: "CREATE INDEX IF NOT EXISTS session_send_owners_session ON session_send_owners(session_id,attempt_id);" },
  ...ownerGuards.map((guard) => ({ ...guard, type: "trigger" })),
  ...ownerTables.flatMap((table) => (["UPDATE", "DELETE"] as const).map((operation) => ({
    name: `${table.name}_immutable_${operation.toLowerCase()}`, table: table.name, type: "trigger",
    sql: `CREATE TRIGGER IF NOT EXISTS ${table.name}_immutable_${operation.toLowerCase()} BEFORE ${operation} ON ${table.name}
      BEGIN SELECT RAISE(ABORT,'SESSION_SEND_OWNER_CORRUPT'); END;`,
  }))),
];
export function applySessionSendOwnerSchema(database: Database): void {
  if (database.query("SELECT 1 FROM pragma_table_info('mutation_attempts') WHERE name='request_format'").get() === null) {
    database.exec(`ALTER TABLE mutation_attempts ADD COLUMN request_format TEXT CHECK(request_format IS NULL OR request_format='${SESSION_SEND_REQUEST_FORMAT}')`);
  }
  for (const object of SESSION_SEND_OWNER_SCHEMA_OBJECTS) database.exec(object.sql);
}
export function assertSessionSendOwnerSchema(database: Database, mode: UsageSchemaColumnMode = "historical"): void {
  const column = database.query("SELECT type,\"notnull\" AS required,dflt_value FROM pragma_table_info('mutation_attempts') WHERE name='request_format'").get() as
    { type: string; required: number; dflt_value: string | null } | null;
  if (column?.type !== "TEXT" || column.required !== 0 || column.dflt_value !== null) throw new SessionSendOwnershipError("SESSION_SEND_OWNER_CORRUPT");
  const parent = database.query("SELECT sql FROM sqlite_master WHERE type='table' AND name='mutation_attempts'").get() as { sql: string } | null;
  const suffix = `, request_format TEXT CHECK(request_format IS NULL OR request_format='${SESSION_SEND_REQUEST_FORMAT}')`;
  const custodySuffix = ATTACHMENT_CUSTODY_COLUMNS.map(normalizeSchemaSql).join(", ");
  const parentSql = parent === null ? null : schemaSqlBeforeJoinedTranscriptColumns(database, "mutation_attempts", parent.sql, mode);
  if (parent === null || parentSql === null || /\/\*|--/u.test(parent.sql)
    || (!parentSql.endsWith(`${suffix}) STRICT`) && !parentSql.endsWith(`${suffix}, ${custodySuffix}) STRICT`))) {
    throw new SessionSendOwnershipError("SESSION_SEND_OWNER_CORRUPT");
  }
  for (const object of SESSION_SEND_OWNER_SCHEMA_OBJECTS) {
    const row = database.query("SELECT type,tbl_name,sql FROM sqlite_master WHERE name=?").get(object.name) as
      { type: string; tbl_name: string; sql: string } | null;
    if (row === null || row.type !== object.type || row.tbl_name !== object.table || normalizeSchemaSql(row.sql) !== normalizeSchemaSql(object.sql)) {
      throw new SessionSendOwnershipError("SESSION_SEND_OWNER_CORRUPT");
    }
  }
}

export type SessionSendOwnerHistory = Readonly<{
  kind: "owned"; owner: SessionSendOwner; ownerDigest: string; claim: SessionSendExecutionClaim | null; claimDigest: string | null;
  outcomes: readonly SessionSendOutcome[]; state: "input_required" | "effect_started" | "ambiguous" | "accepted" | "abandoned" | "cancelled";
}>;
export type SessionSendOwnershipLookup = { idempotencyKey: string } | { attemptId: string };
export type SessionSendOwnership = { kind: "absent" } | { kind: "legacy"; attemptId: string } | SessionSendOwnerHistory;
const canonical = <T>(schema: z.ZodType<T>, json: unknown): T => {
  const source = z.string().max(262144).parse(json);
  const value = schema.parse(JSON.parse(source) as unknown);
  if (JSON.stringify(value) !== source) throw new SessionSendOwnershipError("SESSION_SEND_OWNER_CORRUPT");
  return value;
};
const sessionSendOwnerAuditOptionsSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("source_selected") }).strict(),
  z.object({ kind: z.literal("historical"), format: historicalEffectEvidenceFormatSchema }).strict(),
]);
export type SessionSendOwnerAuditOptions = z.infer<typeof sessionSendOwnerAuditOptionsSchema>;

export function classifySessionSendOwnership(database: Database, lookup: SessionSendOwnershipLookup): SessionSendOwnership {
  return classifySessionSendOwnershipWithEvidence(database, lookup, { kind: "source_selected" });
}
function classifySessionSendOwnershipWithEvidence(database: Database, lookup: SessionSendOwnershipLookup,
  evidenceMode: SessionSendOwnerAuditOptions): SessionSendOwnership {
  try { assertAttachmentCustodyNamespace(database, lookup); }
  catch (error: unknown) {
    if (!(error instanceof AttachmentCustodyNamespaceError)) throw error;
    throw new SessionSendOwnershipError("SESSION_SEND_OWNER_CORRUPT");
  }
  try { assertQueueAttachmentMutationIntegrity(database, lookup); }
  catch (error: unknown) {
    if (!(error instanceof QueueAttachmentIdentityError)) throw error;
    throw new SessionSendOwnershipError("SESSION_SEND_OWNER_CORRUPT");
  }
  try { assertNoAutomaticPointerMoveOwnership(database, lookup); }
  catch (error: unknown) {
    if (!(error instanceof AutomaticPointerMoveStoreError)) throw error;
    throw new SessionSendOwnershipError(error.code === "AUTOMATIC_POINTER_MOVE_CORRUPT"
      ? "SESSION_SEND_OWNER_CORRUPT" : "SESSION_SEND_OWNED_API_REQUIRED");
  }
  assertSessionSendOwnerSchema(database, evidenceMode.kind === "historical" ? "historical" : "joined");
  const byKey = "idempotencyKey" in lookup;
  const value = byKey ? z.string().uuid().parse(lookup.idempotencyKey) : z.string().min(1).max(200).parse(lookup.attemptId);
  const ids = database.query(`SELECT id AS attempt_id FROM mutation_attempts WHERE ${byKey ? "idempotency_key" : "id"}=?
    UNION SELECT attempt_id FROM session_send_owners WHERE ${byKey ? "original_key" : "attempt_id"}=?
    UNION SELECT attempt_id FROM session_send_owner_anchors WHERE ${byKey ? "original_key" : "attempt_id"}=?
    UNION SELECT attempt_id FROM session_send_execution_claims WHERE ${byKey ? "original_key" : "attempt_id"}=?
    UNION SELECT attempt_id FROM session_send_owner_outcomes WHERE ${byKey ? "original_key" : "attempt_id"}=? LIMIT 2`)
    .all(value, value, value, value, value) as Array<{ attempt_id: string }>;
  if (ids.length === 0) return { kind: "absent" };
  if (ids.length !== 1 || ids[0] === undefined) throw new SessionSendOwnershipError("SESSION_SEND_OWNER_CORRUPT");
  const attemptId = ids[0].attempt_id;
  const raw = database.query("SELECT id,idempotency_key,kind,authority_id,authority_generation,request_digest,state,result_json,created_at,updated_at,request_format FROM mutation_attempts WHERE id=?").get(attemptId) as
    { id: string; idempotency_key: string; kind: string; authority_id: string; authority_generation: number; request_digest: string; state: string;
      result_json: string | null; created_at: number; updated_at: number; request_format: string | null } | null;
  const row = database.query("SELECT * FROM session_send_owners WHERE attempt_id=?").get(attemptId) as
    { attempt_id: string; original_key: string; session_id: string; owner_json: string; owner_digest: string } | null;
  const anchors = database.query("SELECT original_key,kind,digest FROM session_send_owner_anchors WHERE attempt_id=? LIMIT 5").all(attemptId) as
    Array<{ original_key: string; kind: string; digest: string }>;
  const rawClaim = database.query("SELECT * FROM session_send_execution_claims WHERE attempt_id=?").get(attemptId) as
    { original_key: string; claim_json: string; claim_digest: string } | null;
  const rawOutcomes = database.query("SELECT original_key,ordinal,outcome_json,outcome_digest FROM session_send_owner_outcomes WHERE attempt_id=? ORDER BY ordinal LIMIT 3").all(attemptId) as
    Array<{ original_key: string; ordinal: number; outcome_json: string; outcome_digest: string }>;
  if (raw !== null && raw.request_format === null && row === null && anchors.length === 0 && rawClaim === null && rawOutcomes.length === 0) {
    return { kind: "legacy", attemptId };
  }
  try {
    if (raw === null || row === null || raw.request_format !== SESSION_SEND_REQUEST_FORMAT || raw.kind !== "session.send") throw new Error("owner missing");
    const owner = canonical(sessionSendOwnerSchema, row.owner_json);
    const ownerDigest = sessionSendDigest("owner", owner);
    if (owner.attemptId !== attemptId || owner.idempotencyKey !== raw.idempotency_key || row.original_key !== owner.idempotencyKey
      || row.session_id !== owner.sessionId || raw.authority_id !== owner.sessionId || raw.authority_generation !== owner.sourceAuthority.processGeneration
      || raw.request_digest !== owner.fingerprint.requestDigest || raw.created_at !== owner.createdAt || row.owner_digest !== ownerDigest
      || anchors.some((anchor) => anchor.original_key !== owner.idempotencyKey) || anchors.find((anchor) => anchor.kind === "owner")?.digest !== ownerDigest) throw new Error("origin mismatch");
    const primary = database.query("SELECT role,provider_account_id,profile_id,provider,binding_generation,process_generation,provenance,recorded_at FROM mutation_provider_authorities WHERE attempt_id=? LIMIT 2").all(attemptId) as
      Array<{ role: string; provider_account_id: string; profile_id: string; provider: string; binding_generation: number; process_generation: number; provenance: string; recorded_at: number }>;
    const evidence = primary[0];
    if (primary.length !== 1 || evidence === undefined || evidence.role !== "primary" || evidence.provenance !== "session_send_owner"
      || evidence.provider_account_id !== owner.sourceAuthority.providerAccountId || evidence.profile_id !== owner.sourceAuthority.profileId
      || evidence.provider !== owner.sourceAuthority.provider || evidence.binding_generation !== owner.sourceAuthority.bindingGeneration
      || evidence.process_generation !== owner.sourceAuthority.processGeneration || evidence.recorded_at !== owner.createdAt) throw new Error("primary mismatch");
    const claim = rawClaim === null ? null : canonical(sessionSendExecutionClaimSchema, rawClaim.claim_json);
    const claimDigest = claim === null ? null : sessionSendDigest("claim", claim);
    const effect = database.query("SELECT kind,evidence_json,evidence_digest,recorded_at FROM mutation_effect_evidence WHERE attempt_id=?").get(attemptId) as
      { kind: string; evidence_json: string; evidence_digest: string; recorded_at: number } | null;
    if (claim === null) {
      if (effect !== null || anchors.some((anchor) => anchor.kind === "claim")) throw new Error("detached claim");
    } else {
      if (rawClaim?.original_key !== owner.idempotencyKey || rawClaim.claim_digest !== claimDigest
        || anchors.find((anchor) => anchor.kind === "claim")?.digest !== claimDigest
        || claim.attemptId !== attemptId || claim.clientMessageId !== attemptId || claim.ownerDigest !== ownerDigest
        || JSON.stringify(claim.executionAuthority) !== JSON.stringify(owner.sourceAuthority)
        || claim.sessionRevision !== owner.sourceSessionRevision || claim.sessionAuthorityRevision !== owner.sourceAuthorityRevision
        || claim.providerThreadId !== owner.sourceThreadId || claim.evidence.providerThreadId !== owner.sourceThreadId
        || claim.executionAuthority.processGeneration <= 0
        || claim.evidence.clientMessageId !== attemptId || claim.evidence.messageDigest !== owner.fingerprint.inputDigest
        || claim.evidence.runtimeProfile.profileId !== claim.executionAuthority.profileId
        || claim.evidence.runtimeProfile.processGeneration !== claim.executionAuthority.processGeneration
        || reviewedRuntimeProfileProvider(claim.evidence.runtimeProfile) !== claim.executionAuthority.provider
        || claim.evidenceDigest !== sessionSendEvidenceDigest(claim.evidence) || effect?.evidence_digest !== claim.evidenceDigest
        || effect.kind !== "session.send" || effect.evidence_json !== JSON.stringify(claim.evidence) || effect.recorded_at !== claim.createdAt) throw new Error("claim mismatch");
      if (evidenceMode.kind === "historical") {
        // Only the outer, exact-cohort migration audit supplies this format.
        // Historical interpretation never authorizes a current runtime read.
        const checked = checkMutationEvidenceEnvelope({ format: evidenceMode.format, json: effect.evidence_json,
          digest: effect.evidence_digest, evidenceKind: effect.kind, parentKind: raw.kind });
        if (checked.kind !== "checked_envelope" || checked.canonicalJson !== effect.evidence_json) throw new Error("historical effect mismatch");
      } else {
        const checked = readMutationEffectEvidenceProvenance(database, attemptId);
        if (checked.kind !== "parsed" || checked.evidence.kind !== "session.send"
          || checked.canonicalJson !== effect.evidence_json || checked.digest !== claim.evidenceDigest
          || checked.recordedAt !== claim.createdAt) throw new Error("selected effect mismatch");
      }
    }
    const outcomes = rawOutcomes.map((item) => canonical(sessionSendOutcomeSchema, item.outcome_json));
    if (outcomes.length > 2) throw new Error("outcome overflow");
    for (const [index, outcome] of outcomes.entries()) {
      const item = rawOutcomes[index];
      if (item === undefined || item.original_key !== owner.idempotencyKey || item.ordinal !== index + 1 || outcome.ordinal !== item.ordinal
        || outcome.attemptId !== attemptId || outcome.ownerDigest !== ownerDigest || outcome.claimDigest !== claimDigest
        || outcome.previousDigest !== (index === 0 ? null : rawOutcomes[index - 1]?.outcome_digest)
        || item.outcome_digest !== sessionSendDigest("outcome", outcome)
        || anchors.find((anchor) => anchor.kind === `outcome_${item.ordinal}`)?.digest !== item.outcome_digest
        || (index === 1 && (outcomes[0]?.outcome.kind !== "ambiguous" || ["ambiguous", "cancelled"].includes(outcome.outcome.kind)))
        || (claim === null && (outcome.outcome.kind !== "cancelled" || index !== 0))
        || (claim !== null && outcome.outcome.kind === "cancelled")) throw new Error("outcome mismatch");
      if (outcome.outcome.kind === "accepted" && (claim === null || outcome.outcome.receipt.sourceId !== attemptId
        || JSON.stringify(outcome.outcome.receipt.effectiveRuntimeProfile) !== JSON.stringify(claim.evidence.runtimeProfile))) throw new Error("receipt mismatch");
    }
    if (anchors.length !== 1 + (claim === null ? 0 : 1) + outcomes.length) throw new Error("detached anchor");
    const first = outcomes[0];
    const expectedState = first === undefined ? (claim === null ? "prepared" : "effect_started")
      : ({ accepted: "applied", ambiguous: "ambiguous", cancelled: "cancelled", abandoned: "invalid" } as const)[first.outcome.kind];
    const expectedReceipt = first?.outcome.kind === "accepted" ? JSON.stringify(first.outcome.receipt) : null;
    if (raw.state !== expectedState || raw.result_json !== expectedReceipt
      || raw.updated_at !== (first?.recordedAt ?? claim?.createdAt ?? owner.createdAt)) throw new Error("mutation state mismatch");
    const resolution = database.query("SELECT resolution_kind,evidence_json,receipt_json,created_at FROM mutation_resolutions WHERE attempt_id=?").get(attemptId) as
      { resolution_kind: string; evidence_json: string; receipt_json: string | null; created_at: number } | null;
    const final = outcomes[1];
    if (final === undefined ? resolution !== null : resolution === null
      || resolution.resolution_kind !== (final.outcome.kind === "accepted" ? "proven_applied" : "abandoned")
      || resolution.receipt_json !== (final.outcome.kind === "accepted" ? JSON.stringify(final.outcome.receipt) : null)
      || resolution.evidence_json !== JSON.stringify({ version: 1, ownerDigest, claimDigest, outcomeDigest: rawOutcomes[1]?.outcome_digest })
      || resolution.created_at !== final.recordedAt) throw new Error("resolution mismatch");
    return { kind: "owned", owner, ownerDigest, claim, claimDigest, outcomes,
      state: outcomes.at(-1)?.outcome.kind ?? (claim === null ? "input_required" : "effect_started") };
  } catch (error: unknown) {
    if (error instanceof Error && error.name === "SQLiteError") throw error;
    throw new SessionSendOwnershipError("SESSION_SEND_OWNER_CORRUPT");
  }
}
export function assertLegacyMutationOwnership(database: Database, lookup: SessionSendOwnershipLookup): void {
  const classification = classifySessionSendOwnership(database, lookup);
  if (classification.kind === "owned") throw new SessionSendOwnershipError("SESSION_SEND_OWNED_API_REQUIRED");
  if (classification.kind === "legacy") {
    const row = database.query("SELECT authority_id FROM mutation_attempts WHERE id=?").get(classification.attemptId) as { authority_id: string } | null;
    const session = sessionIdSchema.safeParse(row?.authority_id);
    if (session.success) assertUnsettledSessionSendOwners(database, session.data);
  }
}
/** Historical mode is for a separately admitted pre-bridge cohort, never a runtime fallback. */
export function auditSessionSendOwners(database: Database, options: SessionSendOwnerAuditOptions = { kind: "source_selected" }): void {
  const parsedOptions = sessionSendOwnerAuditOptionsSchema.safeParse(options);
  if (!parsedOptions.success) throw new SessionSendOwnershipError("SESSION_SEND_OWNER_CORRUPT");
  assertSessionSendOwnerSchema(database, parsedOptions.data.kind === "historical" ? "historical" : "joined");
  let after = "";
  for (;;) {
    const rows = database.query(`SELECT id AS attempt_id FROM mutation_attempts WHERE request_format IS NOT NULL AND id>?
      UNION SELECT attempt_id FROM session_send_owners WHERE attempt_id>?
      UNION SELECT attempt_id FROM session_send_owner_anchors WHERE attempt_id>?
      UNION SELECT attempt_id FROM session_send_execution_claims WHERE attempt_id>?
      UNION SELECT attempt_id FROM session_send_owner_outcomes WHERE attempt_id>?
      ORDER BY attempt_id LIMIT 100`).all(after, after, after, after, after) as Array<{ attempt_id: string }>;
    if (rows.length === 0) break;
    for (const row of rows) { classifySessionSendOwnershipWithEvidence(database, { attemptId: row.attempt_id }, parsedOptions.data); after = row.attempt_id; }
  }
}

export function requireSessionSendOwner(database: Database, lookup: SessionSendOwnershipLookup): SessionSendOwnerHistory {
  const record = classifySessionSendOwnership(database, lookup);
  if (record.kind !== "owned") throw new SessionSendOwnershipError("SESSION_SEND_REQUEST_CONFLICT");
  return record;
}
export const historicalSessionSendOwnerAuditFormatSchema = z.enum(["private_task48_v1", "combined49_v1"]);
export type HistoricalSessionSendOwnerAuditFormat = z.infer<typeof historicalSessionSendOwnerAuditFormatSchema>;

/** Read-only preflight for an independently admitted historical cohort. Never a runtime fallback. */
export function requireHistoricalSessionSendOwnerForAudit(database: Database, lookup: SessionSendOwnershipLookup,
  format: HistoricalSessionSendOwnerAuditFormat): SessionSendOwnerHistory {
  const parsedLookup = z.union([
    z.object({ attemptId: attemptIdSchema }).strict(),
    z.object({ idempotencyKey: z.string().uuid() }).strict(),
  ]).safeParse(lookup);
  const parsedFormat = historicalSessionSendOwnerAuditFormatSchema.safeParse(format);
  if (!database.inTransaction || !parsedLookup.success || !parsedFormat.success) {
    throw new SessionSendOwnershipError("SESSION_SEND_OWNER_CORRUPT");
  }
  const record = classifySessionSendOwnershipWithEvidence(database, parsedLookup.data,
    { kind: "historical", format: parsedFormat.data });
  if (record.kind !== "owned") throw new SessionSendOwnershipError("SESSION_SEND_REQUEST_CONFLICT");
  return record;
}
export function insertSessionSendOwner(database: Database, input: SessionSendOwner, attachmentInput?: InitialAttachmentInput): SessionSendOwnerHistory {
  const owner = sessionSendOwnerSchema.parse(input);
  const ownerDigest = sessionSendDigest("owner", owner);
  if (attachmentInput === undefined) database.query(`INSERT INTO mutation_attempts(id,idempotency_key,kind,authority_id,authority_generation,request_digest,state,created_at,updated_at,request_format)
    VALUES(?,?,'session.send',?,?,?,'prepared',?,?,?)`).run(owner.attemptId, owner.idempotencyKey, owner.sessionId,
    owner.sourceAuthority.processGeneration, owner.fingerprint.requestDigest, owner.createdAt, owner.createdAt, SESSION_SEND_REQUEST_FORMAT);
  else database.query(`INSERT INTO mutation_attempts(id,idempotency_key,kind,authority_id,authority_generation,request_digest,state,created_at,updated_at,request_format,
    attachment_input_format,attachment_custody_id,attachment_input_digest) VALUES(?,?,'session.send',?,?,?,'prepared',?,?,?,?,?,?)`).run(owner.attemptId,
    owner.idempotencyKey, owner.sessionId, owner.sourceAuthority.processGeneration, owner.fingerprint.requestDigest, owner.createdAt, owner.createdAt,
    SESSION_SEND_REQUEST_FORMAT, attachmentInput.format, attachmentInput.custodyId, attachmentInput.digest);
  database.query("INSERT INTO session_send_owners(attempt_id,original_key,session_id,owner_json,owner_digest) VALUES(?,?,?,?,?)")
    .run(owner.attemptId, owner.idempotencyKey, owner.sessionId, JSON.stringify(owner), ownerDigest);
  database.query(`INSERT INTO mutation_provider_authorities(attempt_id,role,provider_account_id,profile_id,provider,binding_generation,process_generation,provenance,recorded_at)
    VALUES(?,'primary',?,?,?,?,?,'session_send_owner',?)`).run(owner.attemptId, owner.sourceAuthority.providerAccountId,
    owner.sourceAuthority.profileId, owner.sourceAuthority.provider, owner.sourceAuthority.bindingGeneration, owner.sourceAuthority.processGeneration, owner.createdAt);
  database.query("INSERT INTO session_send_owner_anchors(attempt_id,original_key,kind,digest) VALUES(?,?,'owner',?)")
    .run(owner.attemptId, owner.idempotencyKey, ownerDigest);
  // The enclosing v48 admission transaction still has to insert its deferred
  // input anchor/bind the retained set. Its caller performs the canonical read
  // only after both immutable authorities exist; no dispatch is granted here.
  if (attachmentInput !== undefined) return { kind: "owned", owner, ownerDigest, claim: null, claimDigest: null, outcomes: [], state: "input_required" };
  return requireSessionSendOwner(database, { attemptId: owner.attemptId });
}
export function insertSessionSendExecutionClaim(database: Database, history: SessionSendOwnerHistory, input: SessionSendExecutionClaim): SessionSendOwnerHistory {
  if (!database.inTransaction) throw new SessionSendOwnershipError("SESSION_SEND_CLAIM_CONFLICT");
  const claim = sessionSendExecutionClaimSchema.parse(input);
  if (history.state !== "input_required" || history.claim !== null || claim.attemptId !== history.owner.attemptId || claim.ownerDigest !== history.ownerDigest) {
    throw new SessionSendOwnershipError("SESSION_SEND_CLAIM_CONFLICT");
  }
  const claimDigest = sessionSendDigest("claim", claim);
  database.query("INSERT INTO session_send_execution_claims(attempt_id,original_key,claim_json,claim_digest) VALUES(?,?,?,?)")
    .run(claim.attemptId, history.owner.idempotencyKey, JSON.stringify(claim), claimDigest);
  database.query("INSERT INTO session_send_owner_anchors(attempt_id,original_key,kind,digest) VALUES(?,?,'claim',?)")
    .run(claim.attemptId, history.owner.idempotencyKey, claimDigest);
  const effect = insertJoinedMutationEffectEvidence(database, { attemptId: claim.attemptId, evidence: claim.evidence, recordedAt: claim.createdAt });
  if (effect.canonicalJson !== JSON.stringify(claim.evidence) || effect.digest !== claim.evidenceDigest) {
    throw new SessionSendOwnershipError("SESSION_SEND_CLAIM_CONFLICT");
  }
  const changed = database.query("UPDATE mutation_attempts SET state='effect_started',updated_at=? WHERE id=? AND state='prepared'")
    .run(claim.createdAt, claim.attemptId);
  if (changed.changes !== 1) throw new SessionSendOwnershipError("SESSION_SEND_CLAIM_CONFLICT");
  return requireSessionSendOwner(database, { attemptId: claim.attemptId });
}
/** No no-effect API exists until a reviewed runtime proof can establish no write. */
export function appendSessionSendOutcome(database: Database, history: SessionSendOwnerHistory,
  input: SessionSendOutcome["outcome"], recordedAt: number): SessionSendOwnerHistory {
  const previous = history.outcomes.at(-1);
  if (previous !== undefined && JSON.stringify(previous.outcome) === JSON.stringify(input)) return history;
  if (previous !== undefined && previous.outcome.kind !== "ambiguous") {
    throw new SessionSendOwnershipError("SESSION_SEND_CLAIM_CONFLICT");
  }
  const outcome = sessionSendOutcomeSchema.parse({ version: 1, attemptId: history.owner.attemptId, ordinal: history.outcomes.length + 1,
    ownerDigest: history.ownerDigest, claimDigest: history.claimDigest,
    previousDigest: previous === undefined ? null : sessionSendDigest("outcome", previous), outcome: input, recordedAt });
  const digest = sessionSendDigest("outcome", outcome);
  database.query("INSERT INTO session_send_owner_outcomes(attempt_id,original_key,ordinal,outcome_json,outcome_digest) VALUES(?,?,?,?,?)")
    .run(outcome.attemptId, history.owner.idempotencyKey, outcome.ordinal, JSON.stringify(outcome), digest);
  database.query("INSERT INTO session_send_owner_anchors(attempt_id,original_key,kind,digest) VALUES(?,?,?,?)")
    .run(outcome.attemptId, history.owner.idempotencyKey, `outcome_${outcome.ordinal}`, digest);
  const receipt = input.kind === "accepted" ? JSON.stringify(input.receipt) : null;
  if (outcome.ordinal === 1) {
    const state = input.kind === "accepted" ? "applied" : input.kind;
    const changed = database.query("UPDATE mutation_attempts SET state=?,result_json=?,updated_at=? WHERE id=? AND state=?")
      .run(state, receipt, recordedAt, outcome.attemptId, input.kind === "cancelled" ? "prepared" : "effect_started");
    if (changed.changes !== 1) throw new SessionSendOwnershipError("SESSION_SEND_CLAIM_CONFLICT");
  } else {
    database.query("INSERT INTO mutation_resolutions(attempt_id,resolution_kind,evidence_json,receipt_json,created_at) VALUES(?,?,?,?,?)")
      .run(outcome.attemptId, input.kind === "accepted" ? "proven_applied" : "abandoned",
        JSON.stringify({ version: 1, ownerDigest: history.ownerDigest, claimDigest: history.claimDigest, outcomeDigest: digest }), receipt, recordedAt);
  }
  return requireSessionSendOwner(database, { attemptId: outcome.attemptId });
}
/** Call under the surrounding immediate transaction before SQL exempts inert owners. */
export function assertUnsettledSessionSendOwners(database: Database, sessionId: string): void {
  let after = "";
  for (;;) {
    const rows = database.query(`SELECT m.id FROM mutation_attempts m LEFT JOIN mutation_resolutions r ON r.attempt_id=m.id
      WHERE m.authority_id=? AND m.id>? AND m.state IN ('prepared','effect_started','ambiguous') AND r.attempt_id IS NULL
        AND ${sessionSendOwnedSql("m.id", "m.idempotency_key", "m.request_format")}
      UNION SELECT o.attempt_id AS id FROM session_send_owners o LEFT JOIN mutation_attempts m ON m.id=o.attempt_id
        WHERE o.session_id=? AND o.attempt_id>? AND (m.id IS NULL OR m.authority_id!=o.session_id OR EXISTS(
          SELECT 1 FROM session_send_execution_claims claim WHERE claim.attempt_id=o.attempt_id AND NOT EXISTS(
            SELECT 1 FROM session_send_owner_outcomes outcome WHERE outcome.attempt_id=o.attempt_id
              AND json_extract(outcome.outcome_json,'$.outcome.kind') IN ('accepted','abandoned'))))
      ORDER BY id LIMIT 100`).all(sessionId, after, sessionId, after) as Array<{ id: string }>;
    if (rows.length === 0) return;
    for (const row of rows) { classifySessionSendOwnership(database, { attemptId: row.id }); after = row.id; }
  }
}
