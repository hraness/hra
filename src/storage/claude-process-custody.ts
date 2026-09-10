import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { z } from "zod";
import { providerAccountAuthoritySchema, type ProviderAccountAuthority } from "../domain/provider-accounts";
import { attemptIdSchema, profileIdSchema, sessionIdSchema } from "../domain/values";
import { assertSchemaCohortObjects, normalizeSchemaSql, schemaCohortObjects } from "./schema-cohort";
import { SESSION_SWITCH_BLOCKING_PREDICATE, SESSION_SWITCH_FENCE_SOURCE } from "./session-switch-fence";

const digestSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const identitySchema = z.object({
  pid: z.number().int().positive().safe(), pidDomain: z.enum(["darwin", "linux"]),
  procStart: z.string().min(1).max(128).regex(/^[\x20-\x7e]+$/u),
}).strict();
const proofSchema = z.object({
  version: z.literal(1), kind: z.enum(["exact_provider_v1", "legacy_cleanup"]),
  parentKind: z.enum(["launch", "process"]), profileId: profileIdSchema,
  profileGeneration: z.number().int().nonnegative().safe(),
  providerThreadId: z.string().min(1).max(200), runtimeScope: z.enum(["managed", "personal"]),
  originAt: z.number().int().nonnegative().safe(), intentId: z.string().uuid().nullable(),
  identity: identitySchema.nullable(), authority: providerAccountAuthoritySchema.nullable(),
  launchDigest: digestSchema.nullable(),
  previousDigest: digestSchema.nullable(), claimRevision: z.number().int().positive().safe(),
  launchContext: z.object({
    accountKey: z.string().regex(/^v1:claude:[a-f0-9]{64}$/u),
    sessionId: sessionIdSchema.nullable(), switchAttemptId: attemptIdSchema.nullable(),
  }).strict().nullable(),
}).strict().superRefine((value, context) => {
  if ((value.kind === "legacy_cleanup") !== (value.authority === null)
    || (value.parentKind === "launch") !== (value.intentId !== null)
    || (value.parentKind === "process") !== (value.identity !== null)
    || (value.authority !== null && (value.authority.provider !== "claude"
      || value.authority.profileId !== value.profileId))
    || (value.parentKind === "launch") !== (value.launchContext !== null)
    || (value.parentKind === "launch" && (value.launchDigest !== null || value.previousDigest !== null))
    || (value.launchContext?.switchAttemptId != null && value.launchContext.sessionId === null)) {
    context.addIssue({ code: "custom", message: "Invalid Claude custody proof." });
  }
});
type Proof = z.infer<typeof proofSchema>;
const digest = (json: string): string => createHash("sha256").update(`oompa.claude-process-custody.v1\n${json}`).digest("hex");
const tables = { launch: "session_claude_process_launch_intents", process: "session_claude_process_authorities" } as const;
const marker = "provider_authority_digest";
export const CLAUDE_PROCESS_CUSTODY_COLUMN = `${marker} TEXT REFERENCES session_claude_process_provider_authorities(digest) DEFERRABLE INITIALLY DEFERRED CHECK(${marker} IS NULL OR (length(${marker})=64 AND ${marker} NOT GLOB '*[^a-f0-9]*'))`;

const join = (kind: Proof["parentKind"], parent: string, proof = "p"): string => `
  json_extract(${proof}.proof_json,'$.parentKind')='${kind}'
  AND json_extract(${proof}.proof_json,'$.profileId') IS ${parent}.profile_id
  AND json_extract(${proof}.proof_json,'$.profileGeneration') IS ${parent}.profile_generation
  AND json_extract(${proof}.proof_json,'$.providerThreadId') IS ${parent}.provider_thread_id
  AND json_extract(${proof}.proof_json,'$.runtimeScope') IS ${parent}.runtime_scope
  AND json_extract(${proof}.proof_json,'$.originAt') IS ${parent}.${kind === "launch" ? "staged_at" : "recorded_at"}
  AND ${kind === "launch" ? `json_extract(${proof}.proof_json,'$.intentId') IS ${parent}.intent_id
    AND json_extract(${proof}.proof_json,'$.launchContext.accountKey') IS ${parent}.provider_account_key
    AND json_extract(${proof}.proof_json,'$.launchContext.sessionId') IS ${parent}.session_id` : `
    json_extract(${proof}.proof_json,'$.identity.pid') IS ${parent}.pid
    AND json_extract(${proof}.proof_json,'$.identity.pidDomain') IS ${parent}.pid_domain
    AND json_extract(${proof}.proof_json,'$.identity.procStart') IS ${parent}.proc_start`}`;
const current = (proof = "p"): string => `EXISTS(SELECT 1 FROM provider_accounts a JOIN profiles profile ON profile.id=a.profile_id
  WHERE a.id=json_extract(${proof}.proof_json,'$.authority.providerAccountId')
    AND a.profile_id=json_extract(${proof}.proof_json,'$.authority.profileId') AND a.provider='claude'
    AND a.binding_generation=json_extract(${proof}.proof_json,'$.authority.bindingGeneration')
    AND a.process_generation=json_extract(${proof}.proof_json,'$.authority.processGeneration')
    AND a.readiness!='removed' AND profile.state!='removed')`;

const unrevokedLaunch = (profile: string, scope: string, accountKey: string): string => `NOT EXISTS(
  SELECT 1 FROM provider_runtime_account_revocations r WHERE r.profile_id=${profile}
    AND r.provider='claude' AND r.runtime_scope=${scope}
    AND (r.state='releasing' OR r.current_account_key IS NULL OR r.current_account_key IS NOT ${accountKey}))`;

/** No execution or retention owner is silently discharged to manufacture resumability. */
export const claudeSessionQuiescentSql = (session: string): string => `
  ${session}.provider_v39='claude' AND ${session}.state='idle' AND ${session}.active_turn_id IS NULL
  AND NOT EXISTS(SELECT 1 FROM mutation_attempts m LEFT JOIN mutation_resolutions r ON r.attempt_id=m.id
    WHERE (m.authority_id=${session}.id OR m.id IN (SELECT attempt_id FROM session_start_attempts WHERE session_id=${session}.id))
      AND m.state IN ('prepared','effect_started','ambiguous') AND r.attempt_id IS NULL)
  AND NOT EXISTS(SELECT 1 FROM queue_entries q LEFT JOIN queue_effect_resolutions r ON r.queue_id=q.id
    WHERE q.session_id=${session}.id AND (q.state IN ('pending','dispatching') OR (q.state='ambiguous' AND r.queue_id IS NULL)))
  AND NOT EXISTS(SELECT 1 FROM provider_interactions i
    WHERE (i.session_id=${session}.id OR (i.session_id IS NULL AND i.profile_id=${session}.profile_id AND i.thread_id=${session}.provider_thread_id))
      AND i.state IN ('pending','response_prepared','response_written'))
  AND NOT EXISTS(SELECT 1 FROM ${SESSION_SWITCH_FENCE_SOURCE} switch
    WHERE switch.session_id=${session}.id AND ${SESSION_SWITCH_BLOCKING_PREDICATE})
  AND NOT EXISTS(SELECT 1 FROM legacy_provider_authority_quarantines q
    WHERE q.scope_kind='session' AND q.scope_id=${session}.id)
  AND NOT EXISTS(SELECT 1 FROM queue_attachment_quarantines q WHERE q.session_id=${session}.id AND q.ordinal=1
    AND NOT EXISTS(SELECT 1 FROM queue_attachment_quarantines abandoned WHERE abandoned.queue_id=q.queue_id AND abandoned.ordinal=2))
  AND NOT EXISTS(SELECT 1 FROM attachment_custody_sets custody WHERE custody.released_by IS NULL
    AND json_extract(custody.origin_json,'$.input.sessionId')=${session}.id)
  AND NOT EXISTS(SELECT 1 FROM session_claude_process_launch_intents l WHERE l.session_id=${session}.id)`;

export const claudeReleasedSessionProofSql = (session: string, authority: string, digestExpression?: string): string => `EXISTS(
  SELECT 1 FROM session_claude_process_authorities process
  JOIN session_claude_process_provider_authorities proof ON proof.digest=process.provider_authority_digest
  JOIN session_provider_account_authorities scope ON scope.session_id=${session}.id AND scope.provider='claude'
  WHERE process.session_id=${session}.id AND process.profile_id=${session}.profile_id
    ${digestExpression === undefined ? "" : `AND process.provider_authority_digest=${digestExpression}`}
    AND process.provider_thread_id=${session}.provider_thread_id AND process.runtime_scope=scope.runtime_scope
    AND process.state='released' AND process.released_at IS NOT NULL
    AND json_extract(proof.proof_json,'$.kind')='exact_provider_v1'
    AND ${join("process", "process", "proof")}
    AND json_extract(proof.proof_json,'$.authority.providerAccountId')=${authority}.provider_account_id
    AND json_extract(proof.proof_json,'$.authority.profileId')=${authority}.profile_id
    AND json_extract(proof.proof_json,'$.authority.provider')=${authority}.provider
    AND json_extract(proof.proof_json,'$.authority.bindingGeneration')=${authority}.binding_generation
    AND json_extract(proof.proof_json,'$.authority.processGeneration')=${authority}.process_generation
    AND ((scope.runtime_scope='managed' AND NOT EXISTS(SELECT 1 FROM session_personal_runtime_bindings b
      WHERE b.session_id=${session}.id AND b.state!='detached'))
      OR (scope.runtime_scope='personal' AND EXISTS(SELECT 1 FROM session_personal_runtime_bindings b
        WHERE b.session_id=${session}.id AND b.provider='claude' AND b.provider_thread_id=${session}.provider_thread_id AND b.state='active')))
    AND NOT EXISTS(SELECT 1 FROM provider_runtime_account_revocations r WHERE r.profile_id=process.profile_id
      AND r.provider='claude' AND r.runtime_scope=scope.runtime_scope
      AND (r.state='releasing' OR r.current_account_key IS NULL OR r.current_account_key!=scope.account_key)))`;

const schema = `
CREATE TABLE IF NOT EXISTS session_claude_process_provider_authorities (
  digest TEXT PRIMARY KEY CHECK(length(digest)=64 AND digest NOT GLOB '*[^a-f0-9]*'),
  proof_json TEXT NOT NULL CHECK(json_valid(proof_json) AND length(CAST(proof_json AS BLOB))<=4096)
) STRICT;
CREATE INDEX IF NOT EXISTS session_claude_process_custody_origin
ON session_claude_process_provider_authorities(
  json_extract(proof_json,'$.parentKind'),json_extract(proof_json,'$.runtimeScope'),
  json_extract(proof_json,'$.profileId'),json_extract(proof_json,'$.providerThreadId'),
  json_extract(proof_json,'$.claimRevision') DESC
);
CREATE INDEX IF NOT EXISTS session_claude_process_custody_previous
ON session_claude_process_provider_authorities(json_extract(proof_json,'$.previousDigest'));
CREATE UNIQUE INDEX IF NOT EXISTS session_claude_process_custody_incarnation
ON session_claude_process_provider_authorities(json_extract(proof_json,'$.runtimeScope'),
  json_extract(proof_json,'$.profileId'),json_extract(proof_json,'$.providerThreadId'),
  json_extract(proof_json,'$.claimRevision'))
WHERE json_extract(proof_json,'$.parentKind')='process';
CREATE TRIGGER IF NOT EXISTS claude_process_custody_immutable_update
BEFORE UPDATE ON session_claude_process_provider_authorities
BEGIN SELECT RAISE(ABORT,'CLAUDE_PROCESS_CUSTODY_CORRUPT'); END;
CREATE TRIGGER IF NOT EXISTS claude_process_custody_immutable_delete
BEFORE DELETE ON session_claude_process_provider_authorities
BEGIN SELECT RAISE(ABORT,'CLAUDE_PROCESS_CUSTODY_CORRUPT'); END;
CREATE TABLE IF NOT EXISTS session_claude_launch_dispositions (
  launch_digest TEXT PRIMARY KEY REFERENCES session_claude_process_provider_authorities(digest),
  kind TEXT NOT NULL CHECK(kind IN ('cancelled','claimed')),
  process_digest TEXT REFERENCES session_claude_process_provider_authorities(digest),
  recorded_at INTEGER NOT NULL CHECK(recorded_at>=0),
  CHECK((kind IS 'cancelled' AND process_digest IS NULL) OR (kind IS 'claimed' AND process_digest IS NOT NULL))
) STRICT;
CREATE TRIGGER IF NOT EXISTS claude_launch_disposition_immutable_update
BEFORE UPDATE ON session_claude_launch_dispositions
BEGIN SELECT RAISE(ABORT,'CLAUDE_PROCESS_CUSTODY_CORRUPT'); END;
CREATE TRIGGER IF NOT EXISTS claude_launch_disposition_immutable_delete
BEFORE DELETE ON session_claude_launch_dispositions
BEGIN SELECT RAISE(ABORT,'CLAUDE_PROCESS_CUSTODY_CORRUPT'); END;
`;
const guards = `
CREATE INDEX IF NOT EXISTS claude_process_unreleased_profile_scope
ON session_claude_process_authorities(profile_id,runtime_scope,provider_thread_id)
WHERE state!='released';
CREATE TRIGGER IF NOT EXISTS claude_process_profile_removal_guard
BEFORE UPDATE OF state ON profiles
WHEN NEW.state='removed' AND OLD.state!='removed' AND (
  EXISTS(SELECT 1 FROM session_claude_process_authorities p WHERE p.profile_id=OLD.id AND p.state!='released')
  OR EXISTS(SELECT 1 FROM session_claude_process_launch_intents p WHERE p.profile_id=OLD.id))
BEGIN SELECT RAISE(ABORT,'CLAUDE_PROCESS_PROFILE_REMOVAL_BLOCKED'); END;
CREATE TRIGGER IF NOT EXISTS claude_revocation_profile_rollover_guard
BEFORE UPDATE OF process_generation ON profiles
WHEN NEW.process_generation!=OLD.process_generation AND EXISTS(
  SELECT 1 FROM provider_runtime_account_revocations r
  WHERE r.profile_id=OLD.id AND r.provider='claude' AND r.state='releasing')
  AND NOT (EXISTS(SELECT 1 FROM session_adoption_profile_generation_permits permit
    WHERE permit.profile_id=OLD.id AND permit.from_generation=OLD.process_generation
      AND permit.to_generation=NEW.process_generation)
    AND NOT EXISTS(SELECT 1 FROM provider_runtime_account_revocations r
      WHERE r.profile_id=OLD.id AND r.provider='claude' AND r.state='releasing'
        AND r.profile_generation!=NEW.process_generation))
BEGIN SELECT RAISE(ABORT,'CLAUDE_REVOCATION_PROFILE_ROLLOVER_BLOCKED'); END;
${Object.entries(tables).map(([rawKind, table]) => {
  const kind = z.enum(["launch", "process"]).parse(rawKind);
  return `
CREATE UNIQUE INDEX IF NOT EXISTS claude_${kind}_custody_parent
ON ${table}(provider_authority_digest) WHERE provider_authority_digest IS NOT NULL;
CREATE TRIGGER IF NOT EXISTS claude_${kind}_custody_insert
BEFORE INSERT ON ${table}
WHEN NOT EXISTS(SELECT 1 FROM session_claude_process_provider_authorities p
  WHERE p.digest=NEW.${marker} AND ${join(kind, "NEW")}
    AND json_extract(p.proof_json,'$.kind')='exact_provider_v1' AND ${current()}
    ${kind === "launch" ? `AND ${unrevokedLaunch("NEW.profile_id", "NEW.runtime_scope", "NEW.provider_account_key")}` : ""})
BEGIN SELECT RAISE(ABORT,'CLAUDE_PROCESS_CUSTODY_UNPROVED'); END;
CREATE TRIGGER IF NOT EXISTS claude_${kind}_custody_update
BEFORE UPDATE ON ${table}
WHEN NOT EXISTS(SELECT 1 FROM session_claude_process_provider_authorities p
  WHERE p.digest=NEW.${marker} AND ${join(kind, "NEW")}
    AND (NEW.${marker} IS OLD.${marker}${kind === "process" ? ` OR (OLD.state='released' AND NEW.state='claimed'
      AND json_extract(p.proof_json,'$.kind')='exact_provider_v1' AND ${current()})` : ""}))
BEGIN SELECT RAISE(ABORT,'CLAUDE_PROCESS_CUSTODY_CORRUPT'); END;
`; }).join("\n")}
CREATE TRIGGER IF NOT EXISTS claude_launch_custody_delete
BEFORE DELETE ON session_claude_process_launch_intents
WHEN NOT EXISTS(SELECT 1 FROM session_claude_launch_dispositions d WHERE d.launch_digest=OLD.${marker})
BEGIN SELECT RAISE(ABORT,'CLAUDE_PROCESS_CUSTODY_UNPROVED'); END;
CREATE TRIGGER IF NOT EXISTS claude_process_custody_delete
BEFORE DELETE ON session_claude_process_authorities
BEGIN SELECT RAISE(ABORT,'CLAUDE_PROCESS_CUSTODY_CORRUPT'); END;
CREATE TRIGGER IF NOT EXISTS claude_process_custody_bind
BEFORE UPDATE OF state,session_id ON session_claude_process_authorities
WHEN NEW.state='bound' AND NOT EXISTS(
  SELECT 1 FROM session_claude_process_provider_authorities p
  JOIN session_provider_authorities a ON a.session_id=NEW.session_id
  JOIN sessions s ON s.id=a.session_id
  WHERE p.digest=NEW.provider_authority_digest AND ${join("process", "NEW")}
    AND json_extract(p.proof_json,'$.kind')='exact_provider_v1' AND ${current()}
    AND a.provider='claude' AND a.profile_id=NEW.profile_id
    AND s.provider_v39='claude' AND s.profile_id=NEW.profile_id AND s.provider_thread_id=NEW.provider_thread_id
    AND a.provider_account_id=json_extract(p.proof_json,'$.authority.providerAccountId')
    AND a.binding_generation=json_extract(p.proof_json,'$.authority.bindingGeneration')
    AND a.process_generation=json_extract(p.proof_json,'$.authority.processGeneration'))
BEGIN SELECT RAISE(ABORT,'CLAUDE_PROCESS_CUSTODY_UNPROVED'); END;
CREATE TRIGGER IF NOT EXISTS claude_process_restart_successor_guard
BEFORE INSERT ON session_provider_authority_successors
WHEN (NEW.transition_kind='provider_restart' AND (NEW.from_provider='claude' OR NEW.to_provider='claude'))
  AND NOT EXISTS(
    SELECT 1 FROM sessions s JOIN session_provider_authorities a ON a.session_id=s.id
    JOIN session_claude_process_authorities process ON process.session_id=s.id AND process.provider_authority_digest=NEW.transition_id
    JOIN session_claude_process_provider_authorities proof ON proof.digest=process.provider_authority_digest
    JOIN session_events gap ON gap.session_id=s.id
    JOIN session_event_provider_authorities event ON event.session_id=gap.session_id AND event.sequence=gap.sequence
    WHERE s.id=NEW.session_id AND ${claudeSessionQuiescentSql("s")} AND ${claudeReleasedSessionProofSql("s", "a", "NEW.transition_id")}
      AND NEW.from_provider='claude' AND NEW.to_provider='claude'
      AND NEW.from_provider_account_id=NEW.to_provider_account_id
      AND NEW.from_profile_id=NEW.to_profile_id AND NEW.from_binding_generation=NEW.to_binding_generation
      AND NEW.to_process_generation=NEW.from_process_generation+1
      AND NEW.from_routing_provenance=NEW.to_routing_provenance
      AND NEW.from_applied_pointer_revision IS NEW.to_applied_pointer_revision
      AND process.released_at<=NEW.recorded_at
      AND json_extract(proof.proof_json,'$.authority.processGeneration')=NEW.from_process_generation
      AND gap.recorded_at=NEW.recorded_at AND json_extract(gap.event_json,'$.body.type')='gap'
      AND json_extract(gap.event_json,'$.body.reason')='provider_restart'
      AND event.provider_account_id=NEW.from_provider_account_id AND event.profile_id=NEW.from_profile_id
      AND event.provider=NEW.from_provider AND event.binding_generation=NEW.from_binding_generation
      AND event.process_generation=NEW.from_process_generation)
BEGIN SELECT RAISE(ABORT,'CLAUDE_PROCESS_RESTART_UNPROVED'); END;
CREATE TRIGGER IF NOT EXISTS claude_process_proof_insert
BEFORE INSERT ON session_claude_process_provider_authorities
WHEN json_extract(NEW.proof_json,'$.kind') IS NOT 'exact_provider_v1'
  OR json_extract(NEW.proof_json,'$.version') IS NOT 1
  OR json_type(NEW.proof_json) IS NOT 'object'
  OR (SELECT COUNT(*) FROM json_each(NEW.proof_json))!=15
  OR EXISTS(SELECT 1 FROM json_each(NEW.proof_json) WHERE key NOT IN (
    'version','kind','parentKind','profileId','profileGeneration','providerThreadId','runtimeScope',
    'originAt','intentId','identity','authority','launchDigest','previousDigest','claimRevision','launchContext'))
  OR COALESCE(json_extract(NEW.proof_json,'$.parentKind') IN ('launch','process'),0)=0
  OR json_type(NEW.proof_json,'$.claimRevision') IS NOT 'integer'
  OR json_extract(NEW.proof_json,'$.claimRevision')<1
  OR json_extract(NEW.proof_json,'$.claimRevision')>9007199254740991
  OR json_type(NEW.proof_json,'$.profileGeneration') IS NOT 'integer'
  OR json_extract(NEW.proof_json,'$.profileGeneration') NOT BETWEEN 0 AND 9007199254740991
  OR json_type(NEW.proof_json,'$.originAt') IS NOT 'integer'
  OR json_extract(NEW.proof_json,'$.originAt') NOT BETWEEN 0 AND 9007199254740991
  OR json_type(NEW.proof_json,'$.providerThreadId') IS NOT 'text'
  OR length(json_extract(NEW.proof_json,'$.providerThreadId')) NOT BETWEEN 1 AND 200
  OR COALESCE(json_extract(NEW.proof_json,'$.runtimeScope') IN ('managed','personal'),0)=0
  OR COALESCE(json_type(NEW.proof_json,'$.launchDigest') IN ('null','text'),0)=0
  OR COALESCE(json_type(NEW.proof_json,'$.previousDigest') IN ('null','text'),0)=0
  OR (json_type(NEW.proof_json,'$.launchDigest')='text' AND
    (length(json_extract(NEW.proof_json,'$.launchDigest'))!=64 OR json_extract(NEW.proof_json,'$.launchDigest') GLOB '*[^a-f0-9]*'))
  OR (json_type(NEW.proof_json,'$.previousDigest')='text' AND
    (length(json_extract(NEW.proof_json,'$.previousDigest'))!=64 OR json_extract(NEW.proof_json,'$.previousDigest') GLOB '*[^a-f0-9]*'))
  OR json_type(NEW.proof_json,'$.authority') IS NOT 'object'
  OR (SELECT COUNT(*) FROM json_each(NEW.proof_json,'$.authority'))!=5
  OR EXISTS(SELECT 1 FROM json_each(NEW.proof_json,'$.authority') WHERE key NOT IN (
    'providerAccountId','provider','profileId','bindingGeneration','processGeneration'))
  OR json_type(NEW.proof_json,'$.authority.bindingGeneration') IS NOT 'integer'
  OR json_type(NEW.proof_json,'$.authority.processGeneration') IS NOT 'integer'
  OR json_extract(NEW.proof_json,'$.authority.bindingGeneration') NOT BETWEEN 1 AND 9007199254740991
  OR json_extract(NEW.proof_json,'$.authority.processGeneration') NOT BETWEEN 0 AND 9007199254740991
  OR json_extract(NEW.proof_json,'$.authority.provider') IS NOT 'claude'
  OR json_extract(NEW.proof_json,'$.authority.profileId') IS NOT json_extract(NEW.proof_json,'$.profileId')
  OR NOT EXISTS(SELECT 1 FROM provider_accounts a JOIN profiles profile ON profile.id=a.profile_id
    WHERE a.id=json_extract(NEW.proof_json,'$.authority.providerAccountId') AND a.provider='claude'
      AND a.profile_id=json_extract(NEW.proof_json,'$.profileId')
      AND a.binding_generation=json_extract(NEW.proof_json,'$.authority.bindingGeneration')
      AND a.process_generation=json_extract(NEW.proof_json,'$.authority.processGeneration')
      AND a.readiness!='removed' AND profile.state!='removed')
  OR (json_extract(NEW.proof_json,'$.parentKind')='launch' AND (
    json_type(NEW.proof_json,'$.intentId') IS NOT 'text'
    OR NOT ${unrevokedLaunch("json_extract(NEW.proof_json,'$.profileId')", "json_extract(NEW.proof_json,'$.runtimeScope')", "json_extract(NEW.proof_json,'$.launchContext.accountKey')")}
    OR length(json_extract(NEW.proof_json,'$.intentId'))!=36
    OR json_type(NEW.proof_json,'$.identity') IS NOT 'null'
    OR json_type(NEW.proof_json,'$.launchDigest') IS NOT 'null'
    OR json_type(NEW.proof_json,'$.previousDigest') IS NOT 'null'
    OR json_type(NEW.proof_json,'$.launchContext') IS NOT 'object'
    OR (SELECT COUNT(*) FROM json_each(NEW.proof_json,'$.launchContext'))!=3
    OR EXISTS(SELECT 1 FROM json_each(NEW.proof_json,'$.launchContext') WHERE key NOT IN ('accountKey','sessionId','switchAttemptId'))
    OR json_type(NEW.proof_json,'$.launchContext.accountKey') IS NOT 'text'
    OR length(json_extract(NEW.proof_json,'$.launchContext.accountKey'))!=74
    OR substr(json_extract(NEW.proof_json,'$.launchContext.accountKey'),1,10)!='v1:claude:'
    OR substr(json_extract(NEW.proof_json,'$.launchContext.accountKey'),11) GLOB '*[^a-f0-9]*'
    OR COALESCE(json_type(NEW.proof_json,'$.launchContext.sessionId') IN ('null','text'),0)=0
    OR COALESCE(json_type(NEW.proof_json,'$.launchContext.switchAttemptId') IN ('null','text'),0)=0
    OR (json_type(NEW.proof_json,'$.launchContext.sessionId')='text' AND NOT EXISTS(
      SELECT 1 FROM sessions s WHERE s.id=json_extract(NEW.proof_json,'$.launchContext.sessionId')))
    OR (json_type(NEW.proof_json,'$.launchContext.switchAttemptId')='text' AND NOT EXISTS(
      SELECT 1 FROM session_switch_attempts s
      JOIN session_switch_adoption_capsules capsule ON capsule.attempt_id=s.attempt_id AND capsule.kind='exact_v1'
      JOIN session_switch_adoption_anchors anchor ON anchor.attempt_id=capsule.attempt_id AND anchor.digest=capsule.digest
      WHERE s.attempt_id=json_extract(NEW.proof_json,'$.launchContext.switchAttemptId')
        AND s.session_id=json_extract(NEW.proof_json,'$.launchContext.sessionId') AND s.phase='target_starting'
        AND json_extract(NEW.proof_json,'$.runtimeScope')='managed'
        AND s.target_provider='claude' AND s.target_profile_id=json_extract(NEW.proof_json,'$.profileId')
        AND s.target_provider_account_id=json_extract(NEW.proof_json,'$.authority.providerAccountId')
        AND s.target_binding_generation=json_extract(NEW.proof_json,'$.authority.bindingGeneration')
        AND s.target_process_generation=json_extract(NEW.proof_json,'$.authority.processGeneration')
        AND json_extract(capsule.capsule_json,'$.targetAccountKey')=json_extract(NEW.proof_json,'$.launchContext.accountKey')
        AND NOT EXISTS(SELECT 1 FROM session_switch_target_start_receipts t WHERE t.attempt_id=s.attempt_id)))
  ))
  OR (json_extract(NEW.proof_json,'$.parentKind')='process' AND (
    json_type(NEW.proof_json,'$.intentId') IS NOT 'null'
    OR json_type(NEW.proof_json,'$.launchContext') IS NOT 'null'
    OR json_type(NEW.proof_json,'$.identity') IS NOT 'object'
    OR (SELECT COUNT(*) FROM json_each(NEW.proof_json,'$.identity'))!=3
    OR EXISTS(SELECT 1 FROM json_each(NEW.proof_json,'$.identity') WHERE key NOT IN ('pid','pidDomain','procStart'))
    OR json_type(NEW.proof_json,'$.identity.pid') IS NOT 'integer'
    OR json_extract(NEW.proof_json,'$.identity.pid') NOT BETWEEN 1 AND 9007199254740991
    OR COALESCE(json_extract(NEW.proof_json,'$.identity.pidDomain') IN ('darwin','linux'),0)=0
    OR json_type(NEW.proof_json,'$.identity.procStart') IS NOT 'text'
    OR length(json_extract(NEW.proof_json,'$.identity.procStart')) NOT BETWEEN 1 AND 128
    OR json_extract(NEW.proof_json,'$.identity.procStart') GLOB '*[^ -~]*'
  ))
  OR (json_extract(NEW.proof_json,'$.parentKind')='process' AND EXISTS(
    SELECT 1 FROM session_claude_process_authorities c
    WHERE c.profile_id=json_extract(NEW.proof_json,'$.profileId')
      AND c.runtime_scope=json_extract(NEW.proof_json,'$.runtimeScope')
      AND c.provider_thread_id=json_extract(NEW.proof_json,'$.providerThreadId')
      AND c.provider_authority_digest IS NOT json_extract(NEW.proof_json,'$.previousDigest')
  ))
  OR (json_extract(NEW.proof_json,'$.previousDigest') IS NOT NULL AND NOT EXISTS(
    SELECT 1 FROM session_claude_process_authorities c
    JOIN session_claude_process_provider_authorities prior ON prior.digest=c.provider_authority_digest
    WHERE c.provider_authority_digest=json_extract(NEW.proof_json,'$.previousDigest') AND c.state='released'
      AND c.profile_id=json_extract(NEW.proof_json,'$.profileId')
      AND c.runtime_scope=json_extract(NEW.proof_json,'$.runtimeScope')
      AND c.provider_thread_id=json_extract(NEW.proof_json,'$.providerThreadId')
      AND c.revision+1=json_extract(NEW.proof_json,'$.claimRevision')
  ))
  OR (json_extract(NEW.proof_json,'$.parentKind')='process'
    AND json_type(NEW.proof_json,'$.previousDigest')='null'
    AND json_extract(NEW.proof_json,'$.claimRevision')!=1)
  OR (json_extract(NEW.proof_json,'$.launchDigest') IS NOT NULL AND NOT EXISTS(
    SELECT 1 FROM session_claude_process_provider_authorities launch
    JOIN session_claude_process_launch_intents l ON l.provider_authority_digest=launch.digest
    WHERE launch.digest=json_extract(NEW.proof_json,'$.launchDigest') AND ${join("launch", "l", "launch")}
      AND json_extract(launch.proof_json,'$.kind')='exact_provider_v1'
      AND ${unrevokedLaunch("l.profile_id", "l.runtime_scope", "l.provider_account_key")}
      AND l.profile_id=json_extract(NEW.proof_json,'$.profileId')
      AND l.runtime_scope=json_extract(NEW.proof_json,'$.runtimeScope')
      AND l.provider_thread_id=json_extract(NEW.proof_json,'$.providerThreadId')
      AND json_extract(launch.proof_json,'$.authority') IS json_extract(NEW.proof_json,'$.authority')
      AND l.staged_at<=json_extract(NEW.proof_json,'$.originAt')))
BEGIN SELECT RAISE(ABORT,'CLAUDE_PROCESS_CUSTODY_UNPROVED'); END;
CREATE TRIGGER IF NOT EXISTS claude_launch_disposition_insert
BEFORE INSERT ON session_claude_launch_dispositions
WHEN NOT EXISTS(SELECT 1 FROM session_claude_process_launch_intents l
  JOIN session_claude_process_provider_authorities p ON p.digest=l.${marker}
  WHERE l.${marker}=NEW.launch_digest AND ${join("launch", "l")}
    AND NEW.recorded_at>=l.staged_at
    AND ((NEW.kind='cancelled' AND NOT EXISTS(SELECT 1 FROM session_claude_process_authorities c
      WHERE c.profile_id=l.profile_id AND c.runtime_scope=l.runtime_scope AND c.provider_thread_id=l.provider_thread_id AND c.state!='released'))
      OR (NEW.kind='claimed' AND EXISTS(SELECT 1 FROM session_claude_process_provider_authorities child
        JOIN session_claude_process_authorities c ON c.${marker}=child.digest
        WHERE child.digest=NEW.process_digest AND ${join("process", "c", "child")}
          AND json_extract(child.proof_json,'$.launchDigest')=NEW.launch_digest
          AND json_extract(child.proof_json,'$.authority') IS json_extract(p.proof_json,'$.authority')
          AND c.state='claimed'))))
BEGIN SELECT RAISE(ABORT,'CLAUDE_PROCESS_CUSTODY_CORRUPT'); END;
`;

function fail(): never { throw new Error("CLAUDE_PROCESS_CUSTODY_CORRUPT"); }
export const CLAUDE_PROCESS_CUSTODY_OBJECT_NAMES = schemaCohortObjects(schema, guards).map((object) => object.name);
export const insertClaudeProcessCustody = (database: Database, input: unknown): string => {
  const parsed = proofSchema.parse(input);
  const json = JSON.stringify(parsed);
  const key = digest(json);
  database.query("INSERT OR IGNORE INTO session_claude_process_provider_authorities(digest,proof_json) VALUES(?,?)").run(key, json);
  const row = database.query("SELECT proof_json FROM session_claude_process_provider_authorities WHERE digest=?").get(key) as { proof_json: string } | null;
  if (row?.proof_json !== json) fail();
  return key;
};

export const readClaudeProcessCustodyProof = (database: Database, key: string): Proof => {
  if (!digestSchema.safeParse(key).success) fail();
  const raw = database.query("SELECT proof_json FROM session_claude_process_provider_authorities WHERE digest=?")
    .get(key) as { proof_json: string } | null;
  if (raw === null || Buffer.byteLength(raw.proof_json) > 4096) fail();
  let proof: Proof;
  try { proof = proofSchema.parse(JSON.parse(raw.proof_json) as unknown); } catch { fail(); }
  if (JSON.stringify(proof) !== raw.proof_json || digest(raw.proof_json) !== key) fail();
  return proof;
};

export const readClaudeProcessCustody = (database: Database, kind: Proof["parentKind"], value: unknown): Proof => {
  const parent = z.object({ provider_authority_digest: digestSchema }).passthrough().safeParse(value);
  if (!parent.success) fail();
  const proof = readClaudeProcessCustodyProof(database, parent.data.provider_authority_digest);
  const matched = database.query(`SELECT 1 FROM ${tables[kind]} c JOIN session_claude_process_provider_authorities p ON p.digest=c.${marker}
    WHERE c.${marker}=? AND ${join(kind, "c")}`).get(parent.data.provider_authority_digest);
  if (matched === null) fail();
  if (kind === "process") {
    const latest = database.query(`SELECT digest FROM session_claude_process_provider_authorities
      WHERE json_extract(proof_json,'$.parentKind')='process'
        AND json_extract(proof_json,'$.runtimeScope')=? AND json_extract(proof_json,'$.profileId')=?
        AND json_extract(proof_json,'$.providerThreadId')=?
      ORDER BY json_extract(proof_json,'$.claimRevision') DESC LIMIT 1`)
      .get(proof.runtimeScope, proof.profileId, proof.providerThreadId) as { digest: string } | null;
    if (latest?.digest !== parent.data.provider_authority_digest) fail();
  }
  return proof;
};

export const assertClaudeProcessCustodyAbsent = (database: Database, key: Readonly<{
  runtimeScope: string; profileId: string; providerThreadId: string;
}>): void => {
  if (database.query(`SELECT 1 FROM session_claude_process_provider_authorities
    WHERE json_extract(proof_json,'$.parentKind')='process'
      AND json_extract(proof_json,'$.runtimeScope')=? AND json_extract(proof_json,'$.profileId')=?
      AND json_extract(proof_json,'$.providerThreadId')=? LIMIT 1`)
    .get(key.runtimeScope, key.profileId, key.providerThreadId) !== null) fail();
};

export const claudeProcessAuthorityFromRow = (database: Database, kind: Proof["parentKind"], value: unknown): ProviderAccountAuthority | null =>
  readClaudeProcessCustody(database, kind, value).authority;

export const settleClaudeLaunchCustody = (database: Database, launchDigest: string, processDigest: string | null, recordedAt: number): void => {
  database.query("INSERT INTO session_claude_launch_dispositions(launch_digest,kind,process_digest,recorded_at) VALUES(?,?,?,?)")
    .run(digestSchema.parse(launchDigest), processDigest === null ? "cancelled" : "claimed", processDigest, recordedAt);
};

export const applyClaudeProcessCustody = (database: Database): void => {
  if (!database.inTransaction) fail();
  if (database.query("SELECT 1 FROM sqlite_master WHERE name='session_claude_process_provider_authorities'").get() !== null) fail();
  database.exec(schema);
  for (const [rawKind, table] of Object.entries(tables)) {
    const kind = z.enum(["launch", "process"]).parse(rawKind);
    database.exec(`ALTER TABLE ${table} ADD COLUMN ${CLAUDE_PROCESS_CUSTODY_COLUMN}`);
    // The frozen cohort was audited before migration admission. Its no-update
    // guard protects old business fields, so temporarily remove only that
    // exact guard while adding the classification marker; retain every old
    // revision, timestamp, PID and account field byte-for-byte.
    const historicalGuardName = kind === "launch" ? "session_claude_process_launch_intent_no_update"
      : "session_claude_process_authority_revision_guard";
    const historicalGuard = database.query("SELECT sql FROM sqlite_master WHERE type='trigger' AND name=?")
      .get(historicalGuardName) as { sql: string } | null;
    if (historicalGuard === null) fail();
    database.exec(`DROP TRIGGER ${historicalGuardName}`);
    let after: readonly [string, string, string] = ["", "", ""];
    for (;;) {
      const rows = database.query(`SELECT * FROM ${table} WHERE (runtime_scope,profile_id,provider_thread_id)>(?,?,?)
        ORDER BY runtime_scope,profile_id,provider_thread_id LIMIT 100`).all(...after) as Array<Record<string, unknown>>;
      if (rows.length === 0) break;
      for (const row of rows) {
        const proof = insertClaudeProcessCustody(database, {
          version: 1, kind: "legacy_cleanup", parentKind: kind,
          profileId: row.profile_id, profileGeneration: row.profile_generation,
          runtimeScope: row.runtime_scope, providerThreadId: row.provider_thread_id,
          originAt: kind === "launch" ? row.staged_at : row.recorded_at,
          intentId: kind === "launch" ? row.intent_id : null,
          identity: kind === "process" ? { pid: row.pid, pidDomain: row.pid_domain, procStart: row.proc_start } : null,
          authority: null, launchDigest: null,
          previousDigest: null, claimRevision: row.revision,
          launchContext: kind === "launch" ? {
            accountKey: row.provider_account_key, sessionId: row.session_id, switchAttemptId: null,
          } : null,
        });
        database.query(`UPDATE ${table} SET ${marker}=? WHERE runtime_scope=? AND profile_id=? AND provider_thread_id=?`)
          .run(proof, String(row.runtime_scope), String(row.profile_id), String(row.provider_thread_id));
        after = [String(row.runtime_scope), String(row.profile_id), String(row.provider_thread_id)];
      }
    }
    database.exec(historicalGuard.sql);
  }
  database.exec(guards);
};

export const assertClaudeProcessCustodySchema = (database: Database): void => {
  assertSchemaCohortObjects(database, schemaCohortObjects(schema, guards), "claude-process-custody49");
  for (const [kind, table] of Object.entries(tables)) {
    const sql = database.query("SELECT sql FROM sqlite_master WHERE name=?").get(table) as { sql: string } | null;
    // SQLite appends the marker before the original table constraints in all
    // reviewed fresh49/canonical40/private48 shapes. Admit that exact tail,
    // never a matching declaration hidden inside an unrelated quoted column.
    // A later additive column must explicitly extend this versioned audit.
    const tail = normalizeSchemaSql(`, ${CLAUDE_PROCESS_CUSTODY_COLUMN},
      ${kind === "process" ? "CHECK((state='released')=(released_at IS NOT NULL)), CHECK(state!='bound' OR session_id IS NOT NULL)," : ""}
      PRIMARY KEY(runtime_scope,profile_id,provider_thread_id)
    ) STRICT`);
    if (sql === null || !normalizeSchemaSql(sql.sql).endsWith(tail)) fail();
  }
};

export const auditClaudeProcessCustody = (database: Database): void => {
  assertClaudeProcessCustodySchema(database);
  for (const [rawKind, table] of Object.entries(tables)) {
    const kind = z.enum(["launch", "process"]).parse(rawKind);
    let after: readonly [string, string, string] = ["", "", ""];
    for (;;) {
      const rows = database.query(`SELECT * FROM ${table}
        WHERE (runtime_scope,profile_id,provider_thread_id)>(?,?,?)
        ORDER BY runtime_scope,profile_id,provider_thread_id LIMIT 100`).all(...after) as Array<Record<string, unknown>>;
      if (rows.length === 0) break;
      for (const row of rows) {
        readClaudeProcessCustody(database, kind, row);
        after = [String(row.runtime_scope), String(row.profile_id), String(row.provider_thread_id)];
      }
    }
  }
  let after = "";
  for (;;) {
    const rows = database.query("SELECT digest,proof_json FROM session_claude_process_provider_authorities WHERE digest>? ORDER BY digest LIMIT 100")
      .all(after) as Array<{ digest: string; proof_json: string }>;
    if (rows.length === 0) break;
    for (const row of rows) {
      const proof = proofSchema.parse(JSON.parse(row.proof_json) as unknown);
      if (JSON.stringify(proof) !== row.proof_json || digest(row.proof_json) !== row.digest) fail();
      // A launch may disappear only through an independently retained disposition.
      if (proof.parentKind === "launch" && database.query(`SELECT 1 FROM session_claude_process_launch_intents WHERE ${marker}=?`)
        .get(row.digest) === null && database.query("SELECT 1 FROM session_claude_launch_dispositions WHERE launch_digest=?")
        .get(row.digest) === null) fail();
      if (proof.parentKind === "process" && database.query(`SELECT 1 FROM session_claude_process_authorities WHERE ${marker}=?`)
        .get(row.digest) === null) {
        const next = database.query(`SELECT proof_json FROM session_claude_process_provider_authorities
          WHERE json_extract(proof_json,'$.previousDigest')=? LIMIT 2`).all(row.digest) as Array<{ proof_json: string }>;
        if (next.length !== 1) fail();
        const successor = proofSchema.parse(JSON.parse(next[0]?.proof_json ?? "") as unknown);
        if (successor.parentKind !== "process" || successor.profileId !== proof.profileId
          || successor.runtimeScope !== proof.runtimeScope || successor.providerThreadId !== proof.providerThreadId
          || successor.claimRevision <= proof.claimRevision) fail();
      }
      after = row.digest;
    }
  }
  let afterDisposition = "";
  for (;;) {
    const rows = database.query("SELECT * FROM session_claude_launch_dispositions WHERE launch_digest>? ORDER BY launch_digest LIMIT 100")
      .all(afterDisposition);
    if (rows.length === 0) break;
    for (const raw of rows) {
      const parsed = z.object({ launch_digest: digestSchema, kind: z.enum(["cancelled", "claimed"]),
        process_digest: digestSchema.nullable(), recorded_at: z.number().int().nonnegative().safe() }).strict().safeParse(raw);
      if (!parsed.success) fail();
      const row = parsed.data;
      const launch = readClaudeProcessCustodyProof(database, row.launch_digest);
      if (launch.parentKind !== "launch" || row.recorded_at < launch.originAt
        || (row.kind === "claimed") !== (row.process_digest !== null)
        || database.query("SELECT 1 FROM session_claude_process_launch_intents WHERE provider_authority_digest=?")
          .get(row.launch_digest) !== null) fail();
      if (row.process_digest !== null) {
        const process = readClaudeProcessCustodyProof(database, row.process_digest);
        if (process.parentKind !== "process" || process.launchDigest !== row.launch_digest
          || process.originAt < launch.originAt || process.originAt > row.recorded_at
          || process.profileId !== launch.profileId || process.runtimeScope !== launch.runtimeScope
          || process.providerThreadId !== launch.providerThreadId
          || JSON.stringify(process.authority) !== JSON.stringify(launch.authority)) fail();
      }
      afterDisposition = row.launch_digest;
    }
  }
};
