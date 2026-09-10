import type { Database } from "bun:sqlite";

import { normalizeSchemaSql } from "./schema-cohort";
import { peerSessionCancellationSourceDeleteSql } from "./peer-session-cancellation";

// Exact usage-49 predecessor definitions, retained separately from the joined
// replacement. Installation is not an historical cohort recognizer.
export const JOINED_EVIDENCE_PREDECESSOR_GUARDS = Object.freeze([
  {
    "name": "session_events_account_authority_guard",
    "table": "session_events",
    "sql": "CREATE TRIGGER session_events_account_authority_guard\nBEFORE INSERT ON session_events\nWHEN NOT EXISTS(\n  SELECT 1 FROM sessions s\n  JOIN session_provider_authorities a ON a.session_id=s.id\n  WHERE s.id=NEW.session_id\n    AND s.profile_id=NEW.account_id\n    AND s.profile_id=a.profile_id\n    AND s.provider_v39=a.provider\n    AND a.process_generation=NEW.provider_generation\n)\nBEGIN SELECT RAISE(ABORT, 'session event account authority mismatch'); END;"
  },
  {
    "name": "session_event_provider_authorities_insert_guard",
    "table": "session_event_provider_authorities",
    "sql": "CREATE TRIGGER IF NOT EXISTS session_event_provider_authorities_insert_guard\nBEFORE INSERT ON session_event_provider_authorities\nWHEN NOT EXISTS(\n  SELECT 1 FROM session_events e\n  JOIN provider_accounts a ON a.id=NEW.provider_account_id\n  WHERE e.session_id=NEW.session_id AND e.sequence=NEW.sequence\n    AND e.account_id=NEW.profile_id AND e.provider_generation=NEW.process_generation\n    AND a.profile_id=NEW.profile_id AND a.provider=NEW.provider\n    AND a.binding_generation=NEW.binding_generation\n    AND (\n      (NEW.provenance='session_event' AND EXISTS(\n        SELECT 1 FROM session_provider_authorities captured\n        WHERE captured.session_id=e.session_id\n          AND captured.provider_account_id=NEW.provider_account_id\n          AND captured.profile_id=NEW.profile_id AND captured.provider=NEW.provider\n          AND captured.binding_generation=NEW.binding_generation\n          AND captured.process_generation=NEW.process_generation\n      ))\n      OR (NEW.provenance='legacy_interaction_authority' AND EXISTS(\n        SELECT 1 FROM interaction_provider_authorities source\n        WHERE source.public_id=json_extract(e.event_json,'$.body.interactionId')\n          AND source.provider_account_id=NEW.provider_account_id\n          AND source.profile_id=NEW.profile_id AND source.provider=NEW.provider\n          AND source.binding_generation=NEW.binding_generation\n          AND source.process_generation=NEW.process_generation\n      ))\n      OR (NEW.provenance='legacy_turn_runtime' AND EXISTS(\n        SELECT 1 FROM session_turn_runtime_profiles turn\n        JOIN session_runtime_profiles runtime\n          ON runtime.session_id=turn.session_id\n         AND runtime.source_kind=turn.source_kind AND runtime.source_id=turn.source_id\n        JOIN runtime_profile_provider_authorities source\n          ON source.session_id=runtime.session_id AND source.revision=runtime.revision\n        WHERE turn.session_id=e.session_id\n          AND turn.turn_id=json_extract(e.event_json,'$.body.turnId')\n          AND source.provider_account_id=NEW.provider_account_id\n          AND source.profile_id=NEW.profile_id AND source.provider=NEW.provider\n          AND source.binding_generation=NEW.binding_generation\n          AND source.process_generation=NEW.process_generation\n      ))\n      OR (NEW.provenance='legacy_session_runtime' AND EXISTS(\n        SELECT 1 FROM runtime_profile_provider_authorities source\n        WHERE source.session_id=e.session_id\n          AND source.provider_account_id=NEW.provider_account_id\n          AND source.profile_id=NEW.profile_id AND source.provider=NEW.provider\n          AND source.binding_generation=NEW.binding_generation\n          AND source.process_generation=NEW.process_generation\n      ))\n    )\n)\nBEGIN SELECT RAISE(ABORT, 'session event provider authority mismatch'); END;"
  }
].map((value) => Object.freeze(value)));

const refusal = "JOINED_EVIDENCE_BOUNDARY_REFUSED";
const fail = (): never => { throw new Error("JOINED_EVIDENCE_BOUNDARY_SCHEMA_INVALID"); };
const json = (value: string, path: string, maximum = 262_144): string =>
  `(CASE WHEN length(CAST(${value} AS BLOB))<=${maximum} AND json_valid(${value})
    THEN json_extract(${value},'${path}') ELSE NULL END)`;
const sameTuple = (left: string, right: string): string => [
  "provider_account_id", "profile_id", "provider", "binding_generation", "process_generation",
].map((field) => `${left}.${field}=${right}.${field}`).join(" AND ");
const runtimeProvider = (provider: string): string => `(
  (${provider}='codex' AND ${json("p.projection_json", "$.runtimeProfile.preset")} IN ('low','high','ultra'))
  OR (${provider}='claude' AND ${json("p.projection_json", "$.runtimeProfile.preset")}='fable-max')
  OR (${provider}='devin' AND ${json("p.projection_json", "$.runtimeProfile.preset")}='astra'))`;

// The anchor and exact raw/projection correspondence are necessary SQL proof,
// not a SHA-256 or closed-codec implementation. The TS source-selected reader
// MUST still run in the same transaction before an authority-producing write.
// Historical projections come only from exact-cohort import; runtime insertion
// remains joined_v1-only under the independent provenance module's guards.
const proof = (scope: "mutation" | "queue"): string => {
  const mutation = scope === "mutation";
  return `p.opaque_reason IS NULL AND p.projection_json IS NOT NULL
    AND p.format IN ('canonical40_v1','canonical41_v1','canonical43_v1','canonical_sol43_v1','canonical49_v1','private_task48_v1','combined49_v1','joined_v1')
    AND p.parent_kind=${mutation ? "m.kind" : "'queue.dispatch'"}
    AND p.parent_authority_id=${mutation ? "m.authority_id" : "q.session_id"}
    AND p.parent_authority_generation_decimal IS ${mutation ? "CAST(m.authority_generation AS TEXT)" : "NULL"}
    AND p.evidence_kind=${mutation ? "e.kind" : "'queue.dispatch'"}
    ${mutation ? "AND e.kind=m.kind" : ""}
    AND p.stored_digest=e.evidence_digest AND p.raw_sha256=p.stored_digest
    AND p.recorded_at_decimal=CAST(e.recorded_at AS TEXT)
    AND p.raw_byte_length=length(CAST(e.evidence_json AS BLOB))
    AND CAST(p.projection_json AS BLOB)=CAST(e.evidence_json AS BLOB)`;
};
const joins = (scope: "mutation" | "queue"): string => {
  const id = scope === "mutation" ? "attempt_id" : "queue_id";
  const parent = scope === "mutation" ? "m" : "q";
  return `JOIN ${scope}_effect_evidence e ON e.${id}=${parent}.id
    JOIN ${scope}_effect_evidence_provenance p ON p.${id}=e.${id}
    JOIN ${scope}_effect_evidence_provenance_anchors anchor
      ON anchor.${id}=p.${id} AND anchor.provenance_digest=p.provenance_digest`;
};
const mutationActor = `COALESCE(${json("p.projection_json", "$.messageActor")},CASE
  WHEN EXISTS(SELECT 1 FROM autorespond_message_sources a WHERE a.session_id=m.authority_id AND a.source_id=m.id) THEN 'autorespond'
  WHEN EXISTS(SELECT 1 FROM peer_session_direct_message_sources peer
    WHERE peer.idempotency_key=m.idempotency_key AND peer.target_session_id=m.authority_id
      AND m.kind=('session.' || peer.delivery))
    OR EXISTS(SELECT 1 FROM peer_session_actions peer
      WHERE peer.idempotency_key=m.idempotency_key AND peer.target_session_id=m.authority_id
        AND m.kind=('session.' || peer.delivery)) THEN 'peer_session'
  WHEN EXISTS(SELECT 1 FROM work_prepared_effects work
    WHERE ${json("work.instruction_json", "$.nestedMutationKey")}=m.idempotency_key
      AND ${json("work.instruction_json", "$.targetSessionId")}=m.authority_id
      AND ((${json("work.instruction_json", "$.kind")}='dispatch' AND m.kind='session.send')
        OR (${json("work.instruction_json", "$.kind")}='signal'
          AND ${json("work.instruction_json", "$.mode")}='steer' AND m.kind='session.steer'))) THEN 'automation'
  ELSE 'human' END)`;

// Exact settled source projections. No mutable current account is substituted
// for either original authority. The queue's frozen transcript actor is still
// constrained by its original peer/human marker; no absent evidence fallback.
const sourceRows = `SELECT m.id AS source_id,'mutation' AS source_kind,m.idempotency_key AS event_source_id,
    m.authority_id AS session_id,a.provider_account_id,a.profile_id,a.provider,a.binding_generation,a.process_generation,
    ${mutationActor} AS actor,p.projection_json,m.transcript_intent_json AS intent_json,m.transcript_status,
    m.kind,CASE WHEN r.resolution_kind='proven_applied' THEN r.receipt_json ELSE m.result_json END AS receipt_json
  FROM mutation_attempts m ${joins("mutation")}
  JOIN mutation_provider_authorities a ON a.attempt_id=m.id AND a.role='primary'
  LEFT JOIN mutation_resolutions r ON r.attempt_id=m.id
  WHERE m.kind IN ('session.send','session.steer') AND ${proof("mutation")}
    AND a.process_generation=m.authority_generation
    AND (SELECT count(*) FROM mutation_provider_authorities all_a WHERE all_a.attempt_id=m.id)=1
    AND ${json("p.projection_json", "$.clientMessageId")}=m.id
    AND (m.state='applied' OR r.resolution_kind='proven_applied')
  UNION ALL
  SELECT q.id,'queue',q.id,q.session_id,a.provider_account_id,a.profile_id,a.provider,a.binding_generation,a.process_generation,
    ${json("q.transcript_intent_json", "$.actor")},p.projection_json,q.transcript_intent_json,q.transcript_status,
    'queue.dispatch',CASE WHEN r.resolution_kind='proven_applied' THEN r.receipt_json ELSE NULL END
  FROM queue_entries q ${joins("queue")}
  JOIN queue_provider_authorities a ON a.queue_id=q.id
  LEFT JOIN queue_effect_resolutions r ON r.queue_id=q.id
  WHERE ${proof("queue")}
    AND ${json("p.projection_json", "$.queueId")}=q.id
    AND ${json("p.projection_json", "$.sessionId")}=q.session_id
    AND ${json("p.projection_json", "$.clientMessageId")}=q.id
    AND ${json("p.projection_json", "$.profileGeneration")}=a.process_generation
    AND ${json("p.projection_json", "$.runtimeProfile.profileId")}=a.profile_id
    AND ${json("p.projection_json", "$.runtimeProfile.processGeneration")}=a.process_generation
    AND ${runtimeProvider("a.provider")}
    AND ((q.message_actor='peer_session' AND ${json("q.transcript_intent_json", "$.actor")}='peer_session')
      OR (q.message_actor='human' AND ${json("q.transcript_intent_json", "$.actor")}!='peer_session'))
    AND (q.state='applied' OR r.resolution_kind='proven_applied')`;

const historicalEvent = (event: string, extra = "1"): string => `EXISTS(
  SELECT 1 FROM (${sourceRows}) origin
  JOIN sessions s ON s.id=origin.session_id
  JOIN session_provider_authorities current ON current.session_id=s.id
  JOIN provider_accounts account ON account.id=current.provider_account_id
  JOIN profiles profile ON profile.id=account.profile_id
  WHERE origin.session_id=${event}.session_id AND origin.event_source_id=${json(`${event}.event_json`, "$.body.sourceId", 65536)}
    AND origin.provider='codex' AND current.provider='codex' AND s.provider_v39='codex'
    AND s.profile_id=origin.profile_id AND origin.profile_id=${event}.account_id
    AND origin.process_generation=${event}.provider_generation
    AND current.provider_account_id=origin.provider_account_id AND current.profile_id=origin.profile_id
    AND current.binding_generation=origin.binding_generation AND current.process_generation>origin.process_generation
    AND account.profile_id=current.profile_id AND account.provider=current.provider
    AND account.binding_generation=current.binding_generation AND account.process_generation=current.process_generation
    AND profile.process_generation=current.process_generation AND profile.state!='removed' AND account.readiness!='removed'
    AND ${json(`${event}.event_json`, "$.body.type", 65536)}='user_message'
    AND ${event}.projection_version=2
    AND ${json(`${event}.event_json`, "$.version", 65536)}=1
    AND ${json(`${event}.event_json`, "$.sessionId", 65536)}=${event}.session_id
    AND ${json(`${event}.event_json`, "$.streamEpoch", 65536)}=${event}.stream_epoch
    AND ${json(`${event}.event_json`, "$.sequence", 65536)}=${event}.sequence
    AND ${json(`${event}.event_json`, "$.recordedAt", 65536)}=${event}.recorded_at
    AND ${json(`${event}.event_json`, "$.accountId", 65536)}=${event}.account_id
    AND ${json(`${event}.event_json`, "$.providerGeneration", 65536)}=${event}.provider_generation
    AND ${json(`${event}.event_json`, "$.providerConnectionId", 65536)} IS ${event}.provider_connection_id
    AND ${json(`${event}.event_json`, "$.body.actor", 65536)}=origin.actor
    AND ${json("origin.projection_json", "$.providerThreadId")}=s.provider_thread_id
    AND ((origin.kind='session.steer'
      AND ${json("origin.projection_json", "$.activeTurnId")} IS NOT NULL
      AND ${json("origin.projection_json", "$.activeTurnId")}=${json("origin.receipt_json", "$.activeTurnId")})
      OR (origin.kind IN ('session.send','queue.dispatch') AND EXISTS(
        SELECT 1 FROM session_runtime_profiles runtime
        JOIN session_turn_runtime_profiles turn ON turn.session_id=runtime.session_id
          AND turn.source_kind=runtime.source_kind AND turn.source_id=runtime.source_id
        JOIN runtime_profile_provider_authorities runtime_authority
          ON runtime_authority.session_id=runtime.session_id AND runtime_authority.revision=runtime.revision
        WHERE runtime.session_id=origin.session_id AND runtime.source_id=origin.source_id
          AND runtime.source_kind=CASE WHEN origin.kind='session.send' THEN 'turn_start' ELSE 'queue_start' END
          AND runtime.profile_id=origin.profile_id AND runtime.process_generation=origin.process_generation
          AND ${sameTuple("runtime_authority", "origin")}
          AND CAST(runtime.profile_json AS BLOB)=CAST(${json("origin.projection_json", "$.runtimeProfile")} AS BLOB)
          AND CAST(turn.profile_json AS BLOB)=CAST(runtime.profile_json AS BLOB)
          AND ((origin.kind='queue.dispatch' AND origin.receipt_json IS NULL)
            OR ${json("origin.receipt_json", "$.turnId")}=turn.turn_id))))
    AND origin.transcript_status='pending'
    AND ${json("origin.intent_json", "$.accountId")}=origin.profile_id
    AND ${json("origin.intent_json", "$.providerGeneration")}=origin.process_generation
    AND ${json("origin.intent_json", "$.actor")}=origin.actor
    AND ${json("origin.intent_json", "$.text") }=${json(`${event}.event_json`, "$.body.text", 65536)}
    AND ${json("origin.intent_json", "$.omittedCharacters")}=${json(`${event}.event_json`, "$.body.omittedCharacters", 65536)}
    AND ${json("origin.intent_json", "$.providerConnectionId")} IS ${event}.provider_connection_id
    AND COALESCE(${json("origin.intent_json", "$.attachments")},'[]')=COALESCE(${json(`${event}.event_json`, "$.body.attachments", 65536)},'[]')
    AND NOT EXISTS(SELECT 1 FROM (${sourceRows}) other WHERE other.session_id=origin.session_id
      AND other.event_source_id=origin.event_source_id AND (other.source_id!=origin.source_id OR other.source_kind!=origin.source_kind))
    AND EXISTS(WITH RECURSIVE lineage(revision,generation) AS (
      SELECT current.authority_revision,current.process_generation
      UNION ALL SELECT edge.from_authority_revision,edge.from_process_generation
      FROM session_provider_authority_successors edge JOIN lineage path
        ON edge.session_id=current.session_id AND edge.to_authority_revision=path.revision
          AND edge.to_process_generation=path.generation
      WHERE edge.to_authority_revision=edge.from_authority_revision+1
        AND edge.to_process_generation-edge.from_process_generation IN (1,2)
        AND edge.from_process_generation>=origin.process_generation AND edge.transition_kind='provider_restart'
        AND edge.from_provider_account_id=current.provider_account_id AND edge.to_provider_account_id=current.provider_account_id
        AND edge.from_profile_id=current.profile_id AND edge.to_profile_id=current.profile_id
        AND edge.from_provider=current.provider AND edge.to_provider=current.provider
        AND edge.from_binding_generation=current.binding_generation AND edge.to_binding_generation=current.binding_generation
        AND edge.from_routing_provenance=current.routing_provenance AND edge.to_routing_provenance=current.routing_provenance
        AND edge.from_applied_pointer_revision IS current.applied_pointer_revision
        AND edge.to_applied_pointer_revision IS current.applied_pointer_revision
    ) SELECT 1 FROM lineage WHERE generation=origin.process_generation)
    AND ${extra}
)`;

const replaced = JOINED_EVIDENCE_PREDECESSOR_GUARDS.map((old) => {
  const body = old.sql.slice(old.sql.indexOf("WHEN NOT ") + "WHEN NOT ".length, old.sql.lastIndexOf("\nBEGIN")).trim();
  const eventGuard = old.table === "session_events";
  const exception = eventGuard ? historicalEvent("NEW") : `NEW.provenance='settled_source' AND EXISTS(
    SELECT 1 FROM session_events e WHERE e.session_id=NEW.session_id AND e.sequence=NEW.sequence
      AND e.recorded_at=NEW.recorded_at AND ${historicalEvent("e", sameTuple("origin", "NEW"))})`;
  return Object.freeze({ name: old.name, table: old.table,
    sql: `CREATE TRIGGER ${old.name} BEFORE INSERT ON ${old.table}
WHEN NOT ((${body}) OR (${exception}))
BEGIN SELECT RAISE(ABORT,'${refusal}'); END;` });
});
const additive = (suffix: string, table: string, event: string, predicate: string) => Object.freeze({
  name: `joined_evidence_boundary_${suffix}`, table,
  sql: `CREATE TRIGGER joined_evidence_boundary_${suffix} BEFORE ${event} ON ${table}
WHEN NOT (${predicate}) BEGIN SELECT RAISE(ABORT,'${refusal}'); END;`,
});
export const JOINED_EVIDENCE_GUARDS = Object.freeze([
  ...replaced,
  additive("peer_source_delete", "peer_session_direct_message_sources", "DELETE", `EXISTS(
    SELECT 1 FROM mutation_attempts m LEFT JOIN mutation_resolutions r ON r.attempt_id=m.id
    WHERE m.idempotency_key=OLD.idempotency_key AND m.authority_id=OLD.target_session_id
      AND m.kind=('session.' || OLD.delivery) AND (
        m.state IN ('failed','cancelled') OR r.resolution_kind='abandoned'
        OR EXISTS(SELECT 1 FROM session_message_event_sources source
          WHERE source.source_id=m.id AND source.session_id=OLD.target_session_id AND source.actor='peer_session')
        OR EXISTS(SELECT 1 FROM mutation_attempts proved ${joins("mutation")}
          WHERE proved.id=m.id AND p.attempt_id=m.id AND ${proof("mutation")}
            AND ${json("p.projection_json", "$.messageActor")}='peer_session'))) OR ${peerSessionCancellationSourceDeleteSql("OLD")}`),
  additive("message_source_insert", "session_message_event_sources", "INSERT", `EXISTS(
    SELECT 1 FROM (${sourceRows}) origin
    JOIN session_events event ON event.session_id=origin.session_id AND event.sequence=NEW.event_sequence
    JOIN session_event_provider_authorities captured ON captured.session_id=event.session_id AND captured.sequence=event.sequence
    WHERE origin.source_id=NEW.source_id AND origin.source_kind=NEW.source_kind AND origin.session_id=NEW.session_id
      AND origin.actor=NEW.actor AND ${sameTuple("origin", "captured")}
      AND event.account_id=origin.profile_id AND event.provider_generation=origin.process_generation
      AND event.recorded_at=NEW.created_at AND event.stream_epoch=NEW.stream_epoch
      AND ${json("event.event_json", "$.body.sourceId", 65536)}=origin.event_source_id
      AND ${json("event.event_json", "$.body.type", 65536)}='user_message'
      AND ${json("event.event_json", "$.body.actor", 65536)}=origin.actor)`),
  additive("queue_runtime_insert", "queue_provider_authorities", "INSERT", `NEW.provenance NOT IN ('queue_runtime','legacy_queue_runtime') OR EXISTS(
    SELECT 1 FROM queue_entries q ${joins("queue")}
    WHERE q.id=NEW.queue_id AND ${proof("queue")}
      AND ${json("p.projection_json", "$.queueId")}=q.id AND ${json("p.projection_json", "$.sessionId")}=q.session_id
      AND ${json("p.projection_json", "$.profileGeneration")}=NEW.process_generation
      AND ${json("p.projection_json", "$.runtimeProfile.profileId")}=NEW.profile_id
      AND ${json("p.projection_json", "$.runtimeProfile.processGeneration")}=NEW.process_generation
      AND ${runtimeProvider("NEW.provider")})`),
  additive("timestamp_resolution_insert", "mutation_resolutions", "INSERT", `NEW.resolution_kind!='proven_applied'
    OR NOT EXISTS(SELECT 1 FROM mutation_attempts m WHERE m.id=NEW.attempt_id AND m.kind IN ('session.stop','session.rename'))
    OR EXISTS(SELECT 1 FROM mutation_attempts m ${joins("mutation")}
      WHERE m.id=NEW.attempt_id AND m.kind IN ('session.stop','session.rename') AND ${proof("mutation")}
        AND ${json("p.projection_json", "$.providerTimestampUnit")}='unix_milliseconds_v1')`),
]);

const observed = (database: Database, name: string) => database.query(`SELECT type,tbl_name,
  CASE WHEN length(CAST(sql AS BLOB))<=131072 THEN sql ELSE NULL END AS sql FROM sqlite_master WHERE name=?`)
  .get(name) as { type: string; tbl_name: string; sql: string | null } | null;
const matches = (row: ReturnType<typeof observed>, expected: { table: string; sql: string }) =>
  row !== null && row.type === "trigger" && row.tbl_name === expected.table && row.sql !== null
    && normalizeSchemaSql(row.sql) === normalizeSchemaSql(expected.sql);
export const auditJoinedEvidenceGuards = (database: Database): void => {
  for (const guard of JOINED_EVIDENCE_GUARDS) if (!matches(observed(database, guard.name), guard)) fail();
  const count = database.query("SELECT count(*) AS n FROM sqlite_master WHERE lower(name) GLOB 'joined_evidence_boundary_*'")
    .get() as { n: number };
  if (count.n !== JOINED_EVIDENCE_GUARDS.length - replaced.length) fail();
};

/** Install only after original cohort and provenance admission. Never modify
 * historical constants/rows or accept an arbitrary observed predecessor. */
export const applyJoinedEvidenceGuards = (database: Database): void => {
  database.transaction(() => {
    const current = JOINED_EVIDENCE_GUARDS.every((guard) => matches(observed(database, guard.name), guard));
    if (current) { auditJoinedEvidenceGuards(database); return; }
    const count = database.query("SELECT count(*) AS n FROM sqlite_master WHERE lower(name) GLOB 'joined_evidence_boundary_*'")
      .get() as { n: number };
    if (count.n !== 0 || !JOINED_EVIDENCE_PREDECESSOR_GUARDS.every((guard) => matches(observed(database, guard.name), guard))) fail();
    for (const guard of JOINED_EVIDENCE_PREDECESSOR_GUARDS) database.exec(`DROP TRIGGER ${guard.name}`);
    for (const guard of JOINED_EVIDENCE_GUARDS) database.exec(guard.sql);
    auditJoinedEvidenceGuards(database);
  }).immediate();
};
