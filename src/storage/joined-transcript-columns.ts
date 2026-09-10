import type { Database } from "bun:sqlite";
import { z } from "zod";

import { normalizeSchemaSql } from "./schema-cohort";

const columnModeSchema = z.enum(["historical", "joined"]);
export type UsageSchemaColumnMode = z.infer<typeof columnModeSchema>;

// Frozen canonical43 declarations at 97cebc44ecd2d27b8c0b6399b0814b1993d94fc1.
// Retained private48/combined49 tables already end in owner/custody or queue
// identity columns. The join appends these three columns without rebuilding
// their parents. Never derive this historical suffix from current defaults.
const transcriptSuffix = normalizeSchemaSql(`,
  transcript_finalized INTEGER NOT NULL DEFAULT 0 CHECK(transcript_finalized IN (0,1)),
  transcript_status TEXT NOT NULL DEFAULT 'none' CHECK(transcript_status IN ('none','pending','finalized','unavailable','abandoned')),
  transcript_intent_json TEXT CHECK(transcript_intent_json IS NULL OR (
    json_valid(transcript_intent_json)
    AND length(CAST(transcript_intent_json AS BLOB))<=65536
  ))) STRICT`);
// Canonical47 appends these two declarations after canonical43 on retained
// queues. The mutation table never has this suffix.
const queuePeerSuffix = transcriptSuffix.slice(0, -") STRICT".length) + normalizeSchemaSql(`,
  message_actor TEXT NOT NULL DEFAULT 'human' CHECK(message_actor IN ('human','peer_session')),
  peer_action_id TEXT REFERENCES peer_session_actions(id)) STRICT`);
const columnSchema = z.object({
  name: z.string(), type: z.string(), required: z.number().int(),
  dflt_value: z.string().nullable(), pk: z.number().int(), hidden: z.number().int(),
}).strict();
const expectedColumns = [
  { name: "transcript_intent_json", type: "TEXT", required: 0, dflt_value: null, pk: 0, hidden: 0 },
  { name: "transcript_status", type: "TEXT", required: 1, dflt_value: "'none'", pk: 0, hidden: 0 },
  { name: "transcript_finalized", type: "INTEGER", required: 1, dflt_value: "0", pk: 0, hidden: 0 },
];
const expectedQueuePeerColumns = [
  { name: "peer_action_id", type: "TEXT", required: 0, dflt_value: null, pk: 0, hidden: 0 },
  { name: "message_actor", type: "TEXT", required: 1, dflt_value: "'human'", pk: 0, hidden: 0 },
  ...expectedColumns,
];

/**
 * Return the normalized historical parent SQL for an explicitly joined audit.
 * This only recognizes the exact appended declarations and their real SQLite
 * column positions; it does not install columns, rewrite SQL, or admit a cohort.
 * Historical mode retains the original caller's absolute-tail check unchanged.
 */
export function schemaSqlBeforeJoinedTranscriptColumns(
  database: Database,
  table: "mutation_attempts" | "queue_entries",
  sql: string,
  mode: UsageSchemaColumnMode,
): string | null {
  if (!columnModeSchema.safeParse(mode).success) return null;
  const normalized = normalizeSchemaSql(sql);
  if (mode === "historical") return normalized;
  const peerTail = table === "queue_entries" && normalized.endsWith(queuePeerSuffix);
  const suffix = peerTail ? queuePeerSuffix : transcriptSuffix;
  if (!normalized.endsWith(suffix)) return normalized;
  if (/\/\*|--/u.test(sql)) return null;
  const expected = peerTail ? expectedQueuePeerColumns : expectedColumns;
  const columns = columnSchema.array().safeParse(database.query(
    `SELECT name,type,"notnull" AS required,dflt_value,pk,hidden
     FROM pragma_table_xinfo(?) ORDER BY cid DESC LIMIT ?`,
  ).all(table, expected.length));
  if (!columns.success || JSON.stringify(columns.data) !== JSON.stringify(expected)) return null;
  return normalized.slice(0, -suffix.length) + ") STRICT";
}
