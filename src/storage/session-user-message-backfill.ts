import type { Database } from "bun:sqlite";
import { z } from "zod";

import { normalizeSchemaSql } from "./schema-cohort";
import { SESSION_SEND_OWNER_SCHEMA_OBJECTS } from "./session-send-owner";

const backfill = (database: Database): void => {
  // These are the unchanged v43 updates. Pre-v43 dispatched sources without a
  // retained event cannot revive unavailable prose; prepared/pending stay open.
  database.query(
    `UPDATE mutation_attempts
     SET transcript_status=CASE WHEN EXISTS (
       SELECT 1 FROM session_events e
       WHERE e.session_id=mutation_attempts.authority_id
         AND json_extract(e.event_json,'$.body.type')='user_message'
         AND json_extract(e.event_json,'$.body.sourceId')=mutation_attempts.idempotency_key
     ) THEN 'finalized' ELSE 'unavailable' END,
         transcript_finalized=CASE WHEN EXISTS (
       SELECT 1 FROM session_events e
       WHERE e.session_id=mutation_attempts.authority_id
         AND json_extract(e.event_json,'$.body.type')='user_message'
         AND json_extract(e.event_json,'$.body.sourceId')=mutation_attempts.idempotency_key
     ) THEN 1 ELSE 0 END
     WHERE kind IN ('session.send','session.steer')
       AND state IN ('effect_started','applied','ambiguous')`,
  ).run();
  database.query(
    `UPDATE queue_entries
     SET transcript_status=CASE WHEN EXISTS (
       SELECT 1 FROM session_events e
       WHERE e.session_id=queue_entries.session_id
         AND json_extract(e.event_json,'$.body.type')='user_message'
         AND json_extract(e.event_json,'$.body.sourceId')=queue_entries.id
     ) THEN 'finalized' ELSE 'unavailable' END,
         transcript_finalized=CASE WHEN EXISTS (
       SELECT 1 FROM session_events e
       WHERE e.session_id=queue_entries.session_id
         AND json_extract(e.event_json,'$.body.type')='user_message'
         AND json_extract(e.event_json,'$.body.sourceId')=queue_entries.id
     ) THEN 1 ELSE 0 END
     WHERE state IN ('dispatching','applied','ambiguous')`,
  ).run();
};

const guardName = "session_send_mutation_guard";
const fail = (): never => { throw new Error("STATE_SCHEMA_V43_TRANSCRIPT_BACKFILL_INVALID"); };
const quoted = (identifier: string): string => `"${identifier.replaceAll('"', '""')}"`;

/** Caller owns exact-cohort admission; this never authorizes a current write. */
export const backfillSessionUserMessageFinalizations = (
  database: Database,
  source: "canonical" | "retained_usage",
): void => {
  try {
    if (!database.inTransaction) return fail();
    const admittedSource = z.enum(["canonical", "retained_usage"]).parse(source);
    // Unqualified historical UPDATEs must still resolve to the admitted main
    // tables, never a connection-local shadow or a second same-name guard.
    if (database.query(`SELECT 1 FROM sqlite_temp_master WHERE name=?
      OR name IN ('mutation_attempts','queue_entries','session_events')
      OR tbl_name IN ('mutation_attempts','queue_entries','session_events') LIMIT 1`).get(guardName) !== null) return fail();
    const observed = z.object({ type: z.string(), tbl_name: z.string(), sql: z.string() })
      .strict().array().max(1).parse(database.query(
        "SELECT type,tbl_name,sql FROM main.sqlite_master WHERE name=?",
      ).all(guardName));
    if (admittedSource === "canonical") {
      if (observed.length !== 0) return fail();
      database.transaction(() => backfill(database))();
      return;
    }
    const original = observed[0];
    const expected = SESSION_SEND_OWNER_SCHEMA_OBJECTS.find((object) => object.name === guardName);
    if (original === undefined || expected === undefined || original.type !== "trigger"
      || original.tbl_name !== "mutation_attempts"
      || normalizeSchemaSql(original.sql) !== normalizeSchemaSql(expected.sql)) return fail();
    const columns = z.object({
      cid: z.number().int().nonnegative(), name: z.string().min(1).max(512), type: z.string(),
      notnull: z.union([z.literal(0), z.literal(1)]), dflt_value: z.string().nullable(),
      pk: z.number().int().nonnegative(), hidden: z.number().int().nonnegative(),
    }).strict().array().max(2000).parse(database.query("PRAGMA main.table_xinfo('mutation_attempts')").all());
    const names = columns.map((column) => column.name);
    if (new Set(names).size !== names.length || !names.includes("transcript_status")
      || !names.includes("transcript_finalized") || !names.includes("id")) return fail();
    // A column's declared collation must not turn equal meaning into equal
    // bytes; preserve SQLite storage classes as well as binary scalar values.
    const preserved = names.filter((name) => name !== "transcript_status" && name !== "transcript_finalized")
      .map((name) => `(typeof(NEW.${quoted(name)})=typeof(OLD.${quoted(name)})
        AND NEW.${quoted(name)} COLLATE BINARY IS OLD.${quoted(name)} COLLATE BINARY)`).join(" AND ");
    const eventExists = `EXISTS(SELECT 1 FROM session_events e
      WHERE e.session_id=OLD.authority_id AND json_extract(e.event_json,'$.body.type')='user_message'
        AND json_extract(e.event_json,'$.body.sourceId')=OLD.idempotency_key)`;
    const metadataGuard = `CREATE TRIGGER ${guardName} BEFORE UPDATE ON mutation_attempts WHEN NOT (
      ${preserved} AND OLD.kind IN ('session.send','session.steer')
      AND OLD.state IN ('effect_started','applied','ambiguous')
      AND NEW.transcript_status IS CASE WHEN ${eventExists} THEN 'finalized' ELSE 'unavailable' END
      AND NEW.transcript_finalized IS CASE WHEN ${eventExists} THEN 1 ELSE 0 END
    ) BEGIN SELECT RAISE(ABORT,'STATE_SCHEMA_V43_TRANSCRIPT_BACKFILL_INVALID'); END;`;
    // A savepoint makes both updates atomic even if an outer caller catches the
    // failure. No callbacks/awaits escape the temporary metadata-only boundary.
    database.transaction(() => {
      database.exec(`DROP TRIGGER main.${guardName}`);
      try {
        database.exec(metadataGuard);
        backfill(database);
      } finally {
        database.exec(`DROP TRIGGER IF EXISTS main.${guardName}`);
        database.exec(original.sql);
      }
    })();
  } catch {
    return fail();
  }
};
