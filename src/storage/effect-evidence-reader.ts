import { createHash } from "node:crypto";

import { z } from "zod";

import { mutationEffectEvidence49Schema, queueEffectEvidence49Schema } from "./effect-evidence-codecs";
import {
  mutationEvidenceCanonical40Schema,
  mutationEvidenceCanonical41Schema,
  mutationEvidenceCanonical43Schema,
  mutationEvidenceCanonical49Schema,
  mutationEvidenceCanonicalSol43Schema,
  mutationEvidencePrivate48Schema,
  queueEvidenceCanonicalSchema,
  queueEvidencePrivate48Schema,
} from "./historical-effect-evidence-codecs";

// These names select historical interpretation, not an original writer or a
// SQLite version inferred from the payload. The migration must independently
// bind the selected format to retained rows before an authority reader uses it.
export const historicalEffectEvidenceFormatSchema = z.enum([
  "canonical40_v1",
  "canonical41_v1",
  "canonical43_v1",
  "canonical49_v1",
  "canonical_sol43_v1",
  "private_task48_v1",
  "combined49_v1",
]);
export type HistoricalEffectEvidenceFormat = z.infer<typeof historicalEffectEvidenceFormatSchema>;

// Historical canonical writers bound embedded runtime profiles to 240 KiB.
// This larger raw-input bound also leaves room for enclosing evidence. A larger
// retained document stays opaque; this reader never deletes or rewrites it.
export const EFFECT_EVIDENCE_JSON_MAX_BYTES = 512 * 1024;

export type HistoricalMutationEvidence =
  | z.infer<typeof mutationEffectEvidence49Schema>
  | z.infer<typeof mutationEvidenceCanonical40Schema>
  | z.infer<typeof mutationEvidenceCanonical41Schema>
  | z.infer<typeof mutationEvidenceCanonical43Schema>
  | z.infer<typeof mutationEvidenceCanonical49Schema>
  | z.infer<typeof mutationEvidenceCanonicalSol43Schema>
  | z.infer<typeof mutationEvidencePrivate48Schema>;
export type HistoricalQueueEvidence =
  | z.infer<typeof queueEffectEvidence49Schema>
  | z.infer<typeof queueEvidenceCanonicalSchema>
  | z.infer<typeof queueEvidencePrivate48Schema>;

type OpaqueEvidence = Readonly<{
  kind: "opaque";
  reason: "unsupported_format" | "invalid_json" | "invalid_shape" | "input_too_large";
}>;
type ParsedEvidence<Value> = Readonly<{
  kind: "parsed";
  format: HistoricalEffectEvidenceFormat;
  value: Value;
  canonicalJson: string;
}>;
export type DecodedEvidence<Value> = ParsedEvidence<Value> | OpaqueEvidence;

const mutationCodec = (format: HistoricalEffectEvidenceFormat): z.ZodType<HistoricalMutationEvidence> => {
  switch (format) {
    case "canonical40_v1": return mutationEvidenceCanonical40Schema;
    case "canonical41_v1": return mutationEvidenceCanonical41Schema;
    case "canonical43_v1": return mutationEvidenceCanonical43Schema;
    case "canonical49_v1": return mutationEvidenceCanonical49Schema;
    case "canonical_sol43_v1": return mutationEvidenceCanonicalSol43Schema;
    case "private_task48_v1": return mutationEvidencePrivate48Schema;
    case "combined49_v1": return mutationEffectEvidence49Schema;
  }
};
const queueCodec = (format: HistoricalEffectEvidenceFormat): z.ZodType<HistoricalQueueEvidence> => {
  switch (format) {
    case "canonical40_v1":
    case "canonical41_v1":
    case "canonical43_v1":
    case "canonical_sol43_v1":
    case "canonical49_v1": return queueEvidenceCanonicalSchema;
    case "private_task48_v1": return queueEvidencePrivate48Schema;
    case "combined49_v1": return queueEffectEvidence49Schema;
  }
};

const decode = <Value>(
  input: { format: unknown; json: unknown },
  select: (format: HistoricalEffectEvidenceFormat) => z.ZodType<Value>,
): DecodedEvidence<Value> => {
  const format = historicalEffectEvidenceFormatSchema.safeParse(input.format);
  if (!format.success) return { kind: "opaque", reason: "unsupported_format" };
  if (typeof input.json !== "string") return { kind: "opaque", reason: "invalid_json" };
  if (input.json.length > EFFECT_EVIDENCE_JSON_MAX_BYTES
    || Buffer.byteLength(input.json, "utf8") > EFFECT_EVIDENCE_JSON_MAX_BYTES) {
    return { kind: "opaque", reason: "input_too_large" };
  }
  let value: unknown;
  try { value = JSON.parse(input.json) as unknown; }
  catch { return { kind: "opaque", reason: "invalid_json" }; }
  const parsed = select(format.data).safeParse(value);
  if (!parsed.success) return { kind: "opaque", reason: "invalid_shape" };
  return { kind: "parsed", format: format.data, value: parsed.data, canonicalJson: JSON.stringify(parsed.data) };
};

/** Interpretation only: neither parsing nor an embedded actor grants authority. */
export const decodeMutationEvidence = (input: { format: unknown; json: unknown }): DecodedEvidence<HistoricalMutationEvidence> =>
  decode(input, mutationCodec);

/** Interpretation only; caller must bind retained queue/session/account identity. */
export const decodeQueueEvidence = (input: { format: unknown; json: unknown }): DecodedEvidence<HistoricalQueueEvidence> =>
  decode(input, queueCodec);

const digestSchema = z.string().regex(/^[a-f0-9]{64}$/u);
type EnvelopeRefusal = Readonly<{
  kind: "opaque";
  reason: "invalid_digest" | "digest_mismatch" | "kind_mismatch" | "parent_mismatch";
}>;
type CheckedEnvelope<Value> = Readonly<{
  kind: "checked_envelope";
  format: HistoricalEffectEvidenceFormat;
  value: Value;
  canonicalJson: string;
  digest: string;
}>;
export type EvidenceEnvelopeResult<Value> = CheckedEnvelope<Value> | OpaqueEvidence | EnvelopeRefusal;

const checkDigest = <Value>(
  parsed: DecodedEvidence<Value>,
  storedDigest: unknown,
): EvidenceEnvelopeResult<Value> => {
  if (parsed.kind === "opaque") return parsed;
  const digest = digestSchema.safeParse(storedDigest);
  if (!digest.success) return { kind: "opaque", reason: "invalid_digest" };
  if (createHash("sha256").update(parsed.canonicalJson).digest("hex") !== digest.data) {
    return { kind: "opaque", reason: "digest_mismatch" };
  }
  return {
    kind: "checked_envelope", format: parsed.format, value: parsed.value,
    canonicalJson: parsed.canonicalJson, digest: digest.data,
  };
};

// An envelope check is still not execution authority. The owning transaction
// must bind row IDs, format provenance, source/session/account relationships and
// its action-specific proofs. SQL must consume a separately validated projection,
// never reinterpret the raw JSON with a different duplicate-key/JSON5 decoder.
export const checkMutationEvidenceEnvelope = (input: {
  format: unknown; json: unknown; digest: unknown; evidenceKind: unknown; parentKind: unknown;
}): EvidenceEnvelopeResult<HistoricalMutationEvidence> => {
  const result = checkDigest(decodeMutationEvidence(input), input.digest);
  if (result.kind === "opaque") return result;
  if (input.evidenceKind !== result.value.kind || input.parentKind !== result.value.kind) {
    return { kind: "opaque", reason: "kind_mismatch" };
  }
  return result;
};

// Queue evidence has no stored kind column, and a session.queue mutation is not
// a queue.dispatch parent. Bind the queue/session tuple instead. This proves
// equality only; the owning transaction must independently admit that parent.
export const checkQueueEvidenceEnvelope = (input: {
  format: unknown; json: unknown; digest: unknown;
  queueId: unknown; sessionId: unknown; providerThreadId: unknown; profileGeneration: unknown;
}): EvidenceEnvelopeResult<HistoricalQueueEvidence> => {
  const result = checkDigest(decodeQueueEvidence(input), input.digest);
  if (result.kind === "opaque") return result;
  if (input.queueId !== result.value.queueId || input.sessionId !== result.value.sessionId
    || input.providerThreadId !== result.value.providerThreadId || input.profileGeneration !== result.value.profileGeneration) {
    return { kind: "opaque", reason: "parent_mismatch" };
  }
  return result;
};
