import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";

import { z } from "zod";

import { snapshotForeignJson } from "../domain/guards";
import { providerAccountAuthoritySchema } from "../domain/provider-accounts";
import { presetContractSchema } from "../domain/presets";
import { sessionSwitchRawRequestV1Schema, sessionSwitchRawRequestV2Schema } from "../domain/session-switch-request";
import { attemptIdSchema } from "../domain/values";
import { normalizeSchemaSql, schemaCohortObjects } from "./schema-cohort";

const integer = z.number().int().nonnegative().safe();
const positive = z.number().int().positive().safe();
const digestSchema = z.string().regex(/^[0-9a-f]{64}$/u);
export const sessionSwitchExecutionHostCapabilitiesSchema = z.object({
  preambleVersion: positive,
  preambleDigest: digestSchema,
  manifestVersion: positive,
  manifestDigest: digestSchema,
}).strict().readonly();
export type SessionSwitchExecutionHostCapabilities = z.infer<typeof sessionSwitchExecutionHostCapabilitiesSchema>;

const common = {
  requestDigest: digestSchema,
  planDigest: digestSchema,
  targetAuthority: providerAccountAuthoritySchema.readonly(),
  createdAt: integer,
};
const contextSchema = z.discriminatedUnion("requestFormat", [
  z.object({
    attemptId: attemptIdSchema, requestFormat: z.literal(1), ...common,
    rendererVersion: z.literal(1), targetPresetContract: z.literal(2), targetHostCapabilities: z.null(),
  }).strict().readonly(),
  z.object({
    attemptId: attemptIdSchema, requestFormat: z.literal(2), ...common,
    rendererVersion: z.literal(2), targetPresetContract: presetContractSchema,
    targetHostCapabilities: sessionSwitchExecutionHostCapabilitiesSchema,
  }).strict().refine((value) => value.targetAuthority.provider !== "devin").readonly(),
]);
export type SessionSwitchExecutionContext = z.infer<typeof contextSchema>;

const fail = (): never => { throw new Error("SESSION_SWITCH_EXECUTION_CONTEXT_CORRUPT"); };
const parseContext = (input: unknown): SessionSwitchExecutionContext => {
  const snapshot = snapshotForeignJson(input);
  if (!snapshot.ok) return fail();
  const parsed = contextSchema.safeParse(snapshot.value);
  return parsed.success ? parsed.data : fail();
};
const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");
// The original plan digest and original target tuple stay immutable even after
// a separately proved process-generation rebind. No current capability defaults
// enter this preimage or the historical branch.
const contextDigest = (value: SessionSwitchExecutionContext): string => sha256(JSON.stringify({
  domain: "hra:session-switch-execution-context:v2",
  ...value,
}));

const capsKeys = ["preambleVersion", "preambleDigest", "manifestVersion", "manifestDigest"] as const;
const closedJson = (json: string, keys: readonly string[]): string => `(
  json_type(${json}) IS 'object'
  AND (SELECT COUNT(*) FROM json_each(${json}))=${keys.length}
  AND (SELECT COUNT(DISTINCT key) FROM json_each(${json}))=${keys.length}
  AND NOT EXISTS(SELECT 1 FROM json_each(${json}) WHERE key NOT IN (${keys.map((key) => `'${key}'`).join(",")})))`;
const capsShape = (json: string): string => `${closedJson(json, capsKeys)}
  AND ${["preambleVersion", "manifestVersion"].map((key) => `(
    json_type(${json},'$.${key}') IS 'integer'
    AND json_extract(${json},'$.${key}') BETWEEN 1 AND 9007199254740991)`).join(" AND ")}
  AND ${["preambleDigest", "manifestDigest"].map((key) => `(
    json_type(${json},'$.${key}') IS 'text'
    AND length(json_extract(${json},'$.${key}'))=64
    AND json_extract(${json},'$.${key}') NOT GLOB '*[^0-9a-f]*')`).join(" AND ")}`;
const rawShape = (parent: string, format: string, contract: string): string => `(CASE
  WHEN length(CAST(${parent}.raw_request_json AS BLOB)) BETWEEN 2 AND 2048
    AND json_valid(${parent}.raw_request_json) THEN (
  json_type(${parent}.raw_request_json,'$.session') IS 'text'
  AND length(json_extract(${parent}.raw_request_json,'$.session')) BETWEEN 1 AND 200
  AND json_extract(${parent}.raw_request_json,'$.provider') IN ('codex','claude','devin')
  AND json_extract(${parent}.raw_request_json,'$.provider') IS ${parent}.target_provider
  AND (json_type(${parent}.raw_request_json,'$.account') IS 'null'
    OR (json_type(${parent}.raw_request_json,'$.account') IS 'text'
      AND length(json_extract(${parent}.raw_request_json,'$.account')) BETWEEN 1 AND 200))
  AND (json_type(${parent}.raw_request_json,'$.preset') IS 'null'
    OR json_extract(${parent}.raw_request_json,'$.preset') IN ('low','high','ultra','fable-max','astra'))
  AND ((${format}=1 AND ${closedJson(`${parent}.raw_request_json`, ["session", "provider", "account", "preset"])})
  OR (${format}=2 AND ${closedJson(`${parent}.raw_request_json`, ["version", "session", "provider", "account", "preset", "presetContract"])}
    AND json_type(${parent}.raw_request_json,'$.version') IS 'integer'
    AND json_extract(${parent}.raw_request_json,'$.version')=2
    AND (json_type(${parent}.raw_request_json,'$.presetContract') IS 'null'
      OR (json_type(${parent}.raw_request_json,'$.presetContract') IS 'integer'
        AND json_extract(${parent}.raw_request_json,'$.presetContract') IN (1,2)
        AND json_extract(${parent}.raw_request_json,'$.presetContract')=${contract}))))) ELSE 0 END)`;
const parentJoin = (parent: string, context: string): string => [
  "attempt_id", "request_digest", "target_provider_account_id", "target_profile_id", "target_provider",
  "target_binding_generation", "target_process_generation", "renderer_version", "created_at",
].map((column) => `${parent}.${column} IS ${context}.${column}`).join(" AND ")
  + ` AND ${parent}.target_preset_contract=2`;

export const SESSION_SWITCH_EXECUTION_CONTEXT_TABLES = `
CREATE TABLE session_switch_execution_contexts (
  attempt_id TEXT PRIMARY KEY REFERENCES session_switch_attempts(attempt_id) DEFERRABLE INITIALLY DEFERRED
    CHECK(length(attempt_id)=40 AND substr(attempt_id,1,8)='attempt_' AND substr(attempt_id,9) NOT GLOB '*[^0-9a-f]*'),
  request_format INTEGER NOT NULL CHECK(request_format IN (1,2)),
  request_digest TEXT NOT NULL CHECK(length(request_digest)=64 AND request_digest NOT GLOB '*[^0-9a-f]*'),
  plan_digest TEXT NOT NULL CHECK(length(plan_digest)=64 AND plan_digest NOT GLOB '*[^0-9a-f]*'),
  target_provider_account_id TEXT NOT NULL,
  target_profile_id TEXT NOT NULL CHECK(length(target_profile_id)=37 AND substr(target_profile_id,1,5)='acct_' AND substr(target_profile_id,6) NOT GLOB '*[^0-9a-f]*'),
  target_provider TEXT NOT NULL CHECK(target_provider IN ('codex','claude','devin')),
  target_binding_generation INTEGER NOT NULL CHECK(target_binding_generation BETWEEN 1 AND 9007199254740991),
  target_process_generation INTEGER NOT NULL CHECK(target_process_generation BETWEEN 0 AND 9007199254740991),
  renderer_version INTEGER NOT NULL CHECK(renderer_version=request_format),
  target_preset_contract INTEGER NOT NULL CHECK(target_preset_contract IN (1,2)
    AND (request_format=2 OR target_preset_contract=2)),
  target_host_capabilities_json TEXT CHECK(target_host_capabilities_json IS NULL OR
    (json_valid(target_host_capabilities_json) AND length(CAST(target_host_capabilities_json AS BLOB)) BETWEEN 2 AND 512)),
  created_at INTEGER NOT NULL CHECK(created_at BETWEEN 0 AND 9007199254740991),
  context_digest TEXT NOT NULL CHECK(length(context_digest)=64 AND context_digest NOT GLOB '*[^0-9a-f]*'),
  UNIQUE(attempt_id,context_digest),
  FOREIGN KEY(attempt_id) REFERENCES session_switch_plan_anchors(attempt_id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY(attempt_id,context_digest) REFERENCES session_switch_execution_context_anchors(attempt_id,context_digest) DEFERRABLE INITIALLY DEFERRED,
  CHECK(length(target_provider_account_id)=37 AND substr(target_provider_account_id,6) NOT GLOB '*[^0-9a-f]*'
    AND substr(target_provider_account_id,1,5)=CASE target_provider WHEN 'codex' THEN 'acct_' WHEN 'claude' THEN 'pact_' ELSE 'dact_' END),
  CHECK((request_format=1 AND target_host_capabilities_json IS NULL)
    OR (request_format=2 AND target_provider IN ('codex','claude') AND target_host_capabilities_json IS NOT NULL))
) STRICT;
CREATE TABLE session_switch_execution_context_anchors (
  attempt_id TEXT PRIMARY KEY,
  context_digest TEXT NOT NULL,
  UNIQUE(attempt_id,context_digest),
  FOREIGN KEY(attempt_id,context_digest) REFERENCES session_switch_execution_contexts(attempt_id,context_digest) DEFERRABLE INITIALLY DEFERRED
) STRICT;
`;

export const SESSION_SWITCH_EXECUTION_CONTEXT_GUARDS = `
${["contexts", "context_anchors"].flatMap((suffix) => ["UPDATE", "DELETE"].map((verb) => `
CREATE TRIGGER session_switch_execution_${suffix}_${verb.toLowerCase()}
BEFORE ${verb} ON session_switch_execution_${suffix}
BEGIN SELECT RAISE(ABORT,'SESSION_SWITCH_EXECUTION_CONTEXT_CORRUPT'); END;
`)).join("\n")}
CREATE TRIGGER session_switch_execution_context_insert
BEFORE INSERT ON session_switch_execution_contexts
WHEN NEW.request_format!=2 OR (CASE
  WHEN length(CAST(NEW.target_host_capabilities_json AS BLOB)) BETWEEN 2 AND 512
    AND json_valid(NEW.target_host_capabilities_json)
  THEN COALESCE((${capsShape("NEW.target_host_capabilities_json")}),0) ELSE 0 END)=0
  OR EXISTS(SELECT 1 FROM session_switch_attempts WHERE attempt_id=NEW.attempt_id)
BEGIN SELECT RAISE(ABORT,'SESSION_SWITCH_EXECUTION_CONTEXT_CORRUPT'); END;
CREATE TRIGGER session_switch_execution_parent_insert
BEFORE INSERT ON session_switch_attempts
WHEN NOT EXISTS(SELECT 1 FROM session_switch_execution_contexts c
  JOIN session_switch_execution_context_anchors a ON a.attempt_id=c.attempt_id AND a.context_digest=c.context_digest
  WHERE ${parentJoin("NEW", "c")} AND c.request_format=2 AND ${rawShape("NEW", "c.request_format", "c.target_preset_contract")})
BEGIN SELECT RAISE(ABORT,'SESSION_SWITCH_EXECUTION_CONTEXT_CORRUPT'); END;
CREATE TRIGGER session_switch_execution_plan_insert
BEFORE INSERT ON session_switch_plan_anchors
WHEN NOT EXISTS(SELECT 1 FROM session_switch_execution_contexts c
  JOIN session_switch_attempts p ON ${parentJoin("p", "c")}
  WHERE c.attempt_id=NEW.attempt_id AND c.plan_digest=NEW.plan_digest AND c.created_at=NEW.recorded_at)
BEGIN SELECT RAISE(ABORT,'SESSION_SWITCH_EXECUTION_CONTEXT_CORRUPT'); END;
CREATE TRIGGER session_switch_execution_parent_advance
BEFORE UPDATE ON session_switch_attempts
WHEN NEW.phase IN ('target_starting','target_started','source_releasing','source_released','rebound','seed_dispatching','seed_settled')
  AND NOT EXISTS(SELECT 1 FROM session_switch_execution_contexts c
    JOIN session_switch_execution_context_anchors a ON a.attempt_id=c.attempt_id AND a.context_digest=c.context_digest
    JOIN session_switch_plan_anchors plan ON plan.attempt_id=c.attempt_id AND plan.plan_digest=c.plan_digest AND plan.recorded_at=c.created_at
    WHERE ${parentJoin("NEW", "c")} AND ${rawShape("NEW", "c.request_format", "c.target_preset_contract")})
BEGIN SELECT RAISE(ABORT,'SESSION_SWITCH_EXECUTION_CONTEXT_CORRUPT'); END;
`;
export const SESSION_SWITCH_EXECUTION_CONTEXT_DDL = SESSION_SWITCH_EXECUTION_CONTEXT_TABLES + SESSION_SWITCH_EXECUTION_CONTEXT_GUARDS;

const rowSchema = z.object({
  attempt_id: attemptIdSchema, request_format: z.union([z.literal(1), z.literal(2)]),
  request_digest: digestSchema, plan_digest: digestSchema,
  target_provider_account_id: z.string().max(37), target_profile_id: z.string().max(37),
  target_provider: z.enum(["codex", "claude", "devin"]), target_binding_generation: positive,
  target_process_generation: integer, renderer_version: z.union([z.literal(1), z.literal(2)]),
  target_preset_contract: presetContractSchema,
  target_host_capabilities_json: z.string().max(512).nullable(), created_at: integer,
  context_digest: digestSchema,
}).strict();
const parentSchema = z.object({
  attempt_id: attemptIdSchema, request_digest: digestSchema, raw_request_json: z.string().max(2048),
  target_provider_account_id: z.string().max(37), target_profile_id: z.string().max(37),
  target_provider: z.enum(["codex", "claude", "devin"]), target_binding_generation: positive,
  target_process_generation: integer, renderer_version: z.union([z.literal(1), z.literal(2)]),
  target_preset_contract: z.literal(2),
  created_at: integer, plan_digest: digestSchema, plan_recorded_at: integer,
}).strict();
const boundedColumn = (expression: string, alias: string, maximum: number): string =>
  `CASE WHEN length(CAST(${expression} AS BLOB))<=${maximum} THEN ${expression} ELSE NULL END AS ${alias}`;
const parentProjection = Object.keys(parentSchema.shape).map((key) => boundedColumn(
  key === "plan_digest" ? "plan.plan_digest" : key === "plan_recorded_at" ? "plan.recorded_at" : `p.${key}`,
  key, key === "raw_request_json" ? 2048 : 128,
)).join(",");
const readParent = (database: Database, attemptId: string) => {
  const result = parentSchema.safeParse(database.query(`SELECT ${parentProjection}
    FROM session_switch_attempts p LEFT JOIN session_switch_plan_anchors plan ON plan.attempt_id=p.attempt_id
    WHERE p.attempt_id=?`).get(attemptId));
  return result.success ? result.data : fail();
};
const contextFromParent = (parent: z.infer<typeof parentSchema>, requestFormat: 1 | 2,
  targetPresetContract: 1 | 2, targetHostCapabilities: unknown): SessionSwitchExecutionContext => parseContext({
  attemptId: parent.attempt_id, requestFormat, requestDigest: parent.request_digest, planDigest: parent.plan_digest,
  targetAuthority: { profileId: parent.target_profile_id, bindingGeneration: parent.target_binding_generation,
    processGeneration: parent.target_process_generation, provider: parent.target_provider,
    providerAccountId: parent.target_provider_account_id },
  createdAt: parent.created_at, rendererVersion: parent.renderer_version, targetPresetContract, targetHostCapabilities,
});
const assertParent = (parent: z.infer<typeof parentSchema>, context: SessionSwitchExecutionContext): void => {
  const raw: unknown = JSON.parse(parent.raw_request_json);
  const parsed = context.requestFormat === 1
    ? sessionSwitchRawRequestV1Schema.safeParse(raw) : sessionSwitchRawRequestV2Schema.safeParse(raw);
  if (!parsed.success || JSON.stringify(parsed.data) !== parent.raw_request_json
    || sha256(parent.raw_request_json) !== context.requestDigest || parent.plan_recorded_at !== context.createdAt
    || parsed.data.provider !== context.targetAuthority.provider
    || ("presetContract" in parsed.data && parsed.data.presetContract !== null
      && parsed.data.presetContract !== context.targetPresetContract)
    || JSON.stringify(contextFromParent(parent, context.requestFormat, context.targetPresetContract,
      context.targetHostCapabilities)) !== JSON.stringify(context)) fail();
};
const insertRows = (database: Database, context: SessionSwitchExecutionContext): void => {
  const digest = contextDigest(context);
  database.query(`INSERT INTO session_switch_execution_contexts VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    context.attemptId, context.requestFormat, context.requestDigest, context.planDigest,
    context.targetAuthority.providerAccountId, context.targetAuthority.profileId, context.targetAuthority.provider,
    context.targetAuthority.bindingGeneration, context.targetAuthority.processGeneration, context.rendererVersion,
    context.targetPresetContract,
    context.targetHostCapabilities === null ? null : JSON.stringify(context.targetHostCapabilities), context.createdAt, digest,
  );
  database.query("INSERT INTO session_switch_execution_context_anchors VALUES(?,?)").run(context.attemptId, digest);
};

/** Caller owns IMMEDIATE; insert before the exact journal and plan anchor. */
export const insertSessionSwitchExecutionContext = (database: Database, input: unknown): void => {
  if (!database.inTransaction) fail();
  const context = parseContext(input);
  if (context.requestFormat !== 2) fail();
  insertRows(database, context);
};

const readContextInTransaction = (database: Database, input: string): SessionSwitchExecutionContext => {
  try {
    const attemptId = attemptIdSchema.parse(input);
    const columns = Object.keys(rowSchema.shape).map((key) => boundedColumn(`c.${key}`, key,
      key === "target_host_capabilities_json" ? 512 : 128)).join(",");
    const row = rowSchema.parse(database.query(`SELECT ${columns} FROM session_switch_execution_contexts c
      JOIN session_switch_execution_context_anchors a ON a.attempt_id=c.attempt_id AND a.context_digest=c.context_digest
      WHERE c.attempt_id=?`).get(attemptId));
    const parent = readParent(database, attemptId);
    const context = contextFromParent(parent, row.request_format, row.target_preset_contract,
      row.target_host_capabilities_json === null ? null : JSON.parse(row.target_host_capabilities_json) as unknown);
    const expectedRow = {
      attempt_id: context.attemptId, request_format: context.requestFormat, request_digest: context.requestDigest,
      plan_digest: context.planDigest, target_provider_account_id: context.targetAuthority.providerAccountId,
      target_profile_id: context.targetAuthority.profileId, target_provider: context.targetAuthority.provider,
      target_binding_generation: context.targetAuthority.bindingGeneration, target_process_generation: context.targetAuthority.processGeneration,
      renderer_version: context.rendererVersion,
      target_preset_contract: context.targetPresetContract,
      target_host_capabilities_json: context.targetHostCapabilities === null ? null : JSON.stringify(context.targetHostCapabilities),
      created_at: context.createdAt, context_digest: contextDigest(context),
    };
    if (JSON.stringify(row) !== JSON.stringify(expectedRow)) fail();
    assertParent(parent, context);
    return context;
  } catch { return fail(); }
};

/** Missing context is corruption, never an inferred historical capability mode. */
export const readSessionSwitchExecutionContext = (database: Database, input: string): SessionSwitchExecutionContext =>
  database.inTransaction ? readContextInTransaction(database, input)
    : database.transaction(() => readContextInTransaction(database, input)).deferred();

export const assertSessionSwitchExecutionContextSchema = (database: Database): void => {
  const expected = schemaCohortObjects(SESSION_SWITCH_EXECUTION_CONTEXT_TABLES, SESSION_SWITCH_EXECUTION_CONTEXT_GUARDS);
  const schemaRow = z.object({ type: z.string(), name: z.string(), tbl_name: z.string(), sql: z.string() }).strict();
  for (const object of expected) {
    const found = schemaRow.safeParse(database.query(`SELECT
      ${boundedColumn("type", "type", 16)}, ${boundedColumn("name", "name", 256)}, ${boundedColumn("tbl_name", "tbl_name", 256)},
      ${boundedColumn("sql", "sql", 65536)} FROM sqlite_master WHERE name=?`).get(object.name));
    if (!found.success || found.data.type !== object.type || found.data.tbl_name !== object.tbl_name
      || normalizeSchemaSql(found.data.sql) !== normalizeSchemaSql(object.sql)) fail();
  }
  const count = z.object({ count: integer }).strict().parse(database.query(`SELECT COUNT(*) AS count FROM sqlite_master
    WHERE sql IS NOT NULL AND (name GLOB 'session_switch_execution_*'
      OR tbl_name IN ('session_switch_execution_contexts','session_switch_execution_context_anchors'))`).get()).count;
  if (count !== expected.length) fail();
};

export type SessionSwitchExecutionAuditOptions = Readonly<{
  /** Caller has independently proved each exact malformed-disposition association. */
  excludedMalformedJournalSequences: ReadonlySet<number>;
  onExcludedJournalSequence?: (journalSequence: number) => void;
}>;
const noExclusions: SessionSwitchExecutionAuditOptions = { excludedMalformedJournalSequences: new Set() };
// The caller holds one read/IMMEDIATE transaction. A finite initial count bounds
// total work without inventing a durable-lifetime journal retention limit.
const walkParents = (database: Database, options: SessionSwitchExecutionAuditOptions,
  visit: (attemptId: string) => void): void => {
  const total = z.object({ count: integer }).strict().parse(database.query(
    "SELECT COUNT(*) AS count FROM session_switch_attempts").get()).count;
  let after = 0;
  let seen = 0;
  let excluded = 0;
  for (const sequence of options.excludedMalformedJournalSequences) {
    if (!positive.safeParse(sequence).success) fail();
  }
  while (seen < total) {
    // A proved malformed journal may have no parseable attempt/request ID.
    // Sequence is its independently admitted locator; never bless an invalid
    // identifier merely to enumerate the quarantined row. Even excluded IDs
    // are byte-bounded in SQL before they can cross into JavaScript.
    const page = z.object({ journal_sequence: positive, attempt_id: z.string().max(40).nullable() })
      .strict().array().max(100).safeParse(database.query(
        `SELECT journal_sequence,
           CASE WHEN typeof(attempt_id)='text' AND length(CAST(attempt_id AS BLOB))=40
             THEN attempt_id ELSE NULL END AS attempt_id
         FROM session_switch_attempts
         WHERE journal_sequence>? ORDER BY journal_sequence LIMIT 100`).all(after));
    if (!page.success) return fail();
    const rows = page.data;
    if (rows.length === 0 || seen + rows.length > total) fail();
    for (const row of rows) {
      if (row.journal_sequence <= after) fail();
      after = row.journal_sequence;
      seen++;
      if (options.excludedMalformedJournalSequences.has(row.journal_sequence)) {
        excluded++;
        if (database.query(`SELECT 1 FROM session_switch_execution_contexts c
              JOIN session_switch_attempts p ON p.attempt_id=c.attempt_id WHERE p.journal_sequence=?
            UNION ALL SELECT 1 FROM session_switch_execution_context_anchors a
              JOIN session_switch_attempts p ON p.attempt_id=a.attempt_id WHERE p.journal_sequence=? LIMIT 1`)
          .get(row.journal_sequence, row.journal_sequence) !== null) fail();
        options.onExcludedJournalSequence?.(row.journal_sequence);
      } else {
        const attemptId = attemptIdSchema.safeParse(row.attempt_id);
        if (!attemptId.success) return fail();
        visit(attemptId.data);
      }
    }
  }
  if (excluded !== options.excludedMalformedJournalSequences.size
    || database.query("SELECT 1 FROM session_switch_attempts WHERE journal_sequence>? LIMIT 1").get(after) !== null) fail();
};

/** Only the exact-cohort migration calls this, before current-only guards exist. */
export const applySessionSwitchExecutionContexts = (database: Database,
  options: SessionSwitchExecutionAuditOptions = noExclusions): void => {
  if (!database.inTransaction) fail();
  if (database.query("SELECT 1 FROM sqlite_master WHERE name GLOB 'session_switch_execution_*' LIMIT 1").get() !== null) fail();
  database.exec(SESSION_SWITCH_EXECUTION_CONTEXT_TABLES);
  walkParents(database, options, (attemptId) => {
    const parent = readParent(database, attemptId);
    const context = contextFromParent(parent, 1, parent.target_preset_contract, null);
    assertParent(parent, context);
    insertRows(database, context);
  });
  database.exec(SESSION_SWITCH_EXECUTION_CONTEXT_GUARDS);
};

/** Read-only; the owning transaction and outer historical admission are required. */
export const auditSessionSwitchExecutionContexts = (database: Database,
  options: SessionSwitchExecutionAuditOptions = noExclusions): void => {
  if (!database.inTransaction) fail();
  assertSessionSwitchExecutionContextSchema(database);
  walkParents(database, options, (attemptId) => { readSessionSwitchExecutionContext(database, attemptId); });
  for (const [table, other] of [["contexts", "context_anchors"], ["context_anchors", "contexts"]] as const) {
    if (database.query(`SELECT 1 FROM session_switch_execution_${table} c
      LEFT JOIN session_switch_execution_${other} a ON a.attempt_id=c.attempt_id AND a.context_digest=c.context_digest
      LEFT JOIN session_switch_attempts p ON p.attempt_id=c.attempt_id
      WHERE a.attempt_id IS NULL OR p.attempt_id IS NULL LIMIT 1`).get() !== null) fail();
  }
};
