import type { Database } from "bun:sqlite";
import { z } from "zod";

import { reviewedRuntimeProfileV1Schema, type ReviewedRuntimeProfileV1 } from "../domain/runtime-profile";
import { profileIdSchema, sessionIdSchema } from "../domain/values";
import { historicalEffectEvidenceFormatSchema, type HistoricalEffectEvidenceFormat } from "./effect-evidence-reader";

const integer = z.number().int().nonnegative().safe();
const positive = z.number().int().positive().safe();
// These source restrictions are immutable historical interpretations. The
// joined reader's V1 alias alone is not predecessor-dialect admission.
const canonicalRuntimeSchema = reviewedRuntimeProfileV1Schema.refine((value) => !("nativeFallback" in value));
const privateRuntimeSchema = reviewedRuntimeProfileV1Schema.refine((value) => !("configHome" in value));
const runtimeSchemaFor = (format: HistoricalEffectEvidenceFormat) => {
  switch (format) {
    case "canonical40_v1":
    case "canonical41_v1":
    case "canonical43_v1":
    case "canonical_sol43_v1":
    case "canonical49_v1": return canonicalRuntimeSchema;
    case "private_task48_v1": return privateRuntimeSchema;
    case "combined49_v1": return reviewedRuntimeProfileV1Schema;
  }
};
const locatorSchema = z.object({ session_id: sessionIdSchema, revision: positive });
const rowSchema = locatorSchema.extend({
  profile_id: z.string().nullable(), process_generation: integer.nullable(),
  observed_at: integer.nullable(), recorded_at: integer.nullable(),
  profile_bytes: z.instanceof(Uint8Array).nullable(),
}).strict();
export type HistoricalRuntimeProfileAuthorityRow = Readonly<{
  sessionId: z.infer<typeof sessionIdSchema>;
  revision: number;
}> & (Readonly<{ kind: "opaque" }> | Readonly<{
  kind: "parsed";
  profile: ReviewedRuntimeProfileV1;
  recordedAt: number;
}>);
const fail = (): never => { throw new Error("HISTORICAL_RUNTIME_PROFILE_AUTHORITY_CORRUPT"); };
const requireTransaction = (database: Database): void => { if (!database.inTransaction) fail(); };
const decode = (raw: unknown, format: HistoricalEffectEvidenceFormat): HistoricalRuntimeProfileAuthorityRow => {
  const locator = locatorSchema.safeParse(raw);
  if (!locator.success) return fail();
  const identity = { sessionId: locator.data.session_id, revision: locator.data.revision };
  const opaque = (): HistoricalRuntimeProfileAuthorityRow => ({ ...identity, kind: "opaque" });
  const row = rowSchema.safeParse(raw);
  if (!row.success || row.data.profile_bytes === null || row.data.process_generation === null
    || row.data.observed_at === null || row.data.recorded_at === null) return opaque();
  const profileId = profileIdSchema.safeParse(row.data.profile_id);
  if (!profileId.success) return opaque();
  try {
    const bytes = row.data.profile_bytes;
    const json = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const parsed = runtimeSchemaFor(format).safeParse(JSON.parse(json) as unknown);
    if (!parsed.success || parsed.data.profileId !== profileId.data
      || parsed.data.processGeneration !== row.data.process_generation
      || parsed.data.observedAt !== row.data.observed_at) return opaque();
    const canonical = JSON.stringify(parsed.data);
    const canonicalBytes = new TextEncoder().encode(canonical);
    if (canonical !== json || bytes.byteLength !== canonicalBytes.byteLength
      || !bytes.every((value, index) => value === canonicalBytes[index])) return opaque();
    return { ...identity, kind: "parsed", profile: parsed.data, recordedAt: row.data.recorded_at };
  } catch {
    return opaque();
  }
};

function* readRows(
  database: Database,
  sourceFormat: HistoricalEffectEvidenceFormat,
): Generator<HistoricalRuntimeProfileAuthorityRow> {
  requireTransaction(database);
  const selected = historicalEffectEvidenceFormatSchema.safeParse(sourceFormat);
  if (!selected.success) return fail();
  const count = z.object({ count: integer }).strict().safeParse(database.query(
    "SELECT COUNT(*) AS count FROM session_runtime_profiles",
  ).get());
  if (!count.success) return fail();
  let afterSession = "";
  let afterRevision = 0;
  let seen = 0;
  while (seen < count.data.count) {
    requireTransaction(database);
    // Bounded original bytes cross the SQLite edge only as a BLOB. Never let
    // Bun's permissive TEXT conversion replace invalid UTF-8 before decoding.
    const rows = database.query(`SELECT
        CASE WHEN typeof(session_id)='text' AND length(CAST(session_id AS BLOB))<=200 THEN session_id END AS session_id,
        CASE WHEN typeof(revision)='integer' AND revision BETWEEN 1 AND 9007199254740991 THEN revision END AS revision,
        CASE WHEN typeof(profile_id)='text' AND length(CAST(profile_id AS BLOB))<=200 THEN profile_id END AS profile_id,
        CASE WHEN typeof(process_generation)='integer' AND process_generation BETWEEN 0 AND 9007199254740991
          THEN process_generation END AS process_generation,
        CASE WHEN typeof(observed_at)='integer' AND observed_at BETWEEN 0 AND 9007199254740991 THEN observed_at END AS observed_at,
        CASE WHEN typeof(recorded_at)='integer' AND recorded_at BETWEEN 0 AND 9007199254740991 THEN recorded_at END AS recorded_at,
        CASE WHEN typeof(profile_json)='text' AND length(CAST(profile_json AS BLOB)) BETWEEN 2 AND 262144
          THEN CAST(profile_json AS BLOB) END AS profile_bytes
      FROM session_runtime_profiles
      WHERE (session_id,revision)>(?,?) ORDER BY session_id,revision LIMIT 100`).all(afterSession, afterRevision);
    if (rows.length === 0 || seen + rows.length > count.data.count) return fail();
    for (const row of rows) {
      requireTransaction(database);
      const parsed = decode(row, selected.data);
      if (parsed.sessionId < afterSession || (parsed.sessionId === afterSession && parsed.revision <= afterRevision)) return fail();
      afterSession = parsed.sessionId;
      afterRevision = parsed.revision;
      seen++;
      yield parsed;
    }
  }
  requireTransaction(database);
  if (database.query("SELECT 1 FROM session_runtime_profiles WHERE (session_id,revision)>(?,?) LIMIT 1")
    .get(afterSession, afterRevision) !== null) return fail();
}

/** Read-only migration input, selected only after the caller's exact cohort proof. */
export function* readHistoricalRuntimeProfileAuthorityRows(
  database: Database,
  sourceFormat: HistoricalEffectEvidenceFormat,
): Generator<HistoricalRuntimeProfileAuthorityRow> {
  try { yield* readRows(database, sourceFormat); }
  catch { return fail(); }
}
