import { z } from "zod";

import type { Provider } from "./presets";
import {
  TRANSCRIPT_SEED_HEADER,
  type SessionTranscript,
  type TranscriptRecord,
} from "./transcript";

/**
 * The letta-ai trajectory v1 emitter.
 *
 * Upstream (`@letta-ai/trajectory`, `schema/trajectory-v1.schema.json`) is an
 * import-oriented normalizer: it converts many harnesses' native logs *into*
 * this shape and does not convert back out. HRA emits the same shape so its
 * own neutral transcript can be fed to the memory and search tooling built
 * around it. The mapping is written here rather than taken as a dependency,
 * and `docs/providers/portability.md` states the field-by-field mapping.
 *
 * Everything emitted comes from HRA's own redacted event stream. HRA never
 * stored raw tool arguments or raw tool output, so a tool call's `arguments`
 * is a stringified JSON object of the identity HRA does hold, and a tool
 * record's `content` says plainly that no output was retained.
 */

export const TRAJECTORY_SCHEMA_VERSION = 1;
export const TRAJECTORY_NO_OUTPUT_CONTENT = "[hra] tool output was never retained";

const isoTimestamp = (value: number): string => new Date(value).toISOString();

const trajectoryTimestampSchema = z.string().datetime();
const trajectoryTextSchema = z.string().max(65_536);
const trajectoryIdSchema = z.string().min(1).max(256);

export const trajectoryRecordSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("meta"),
    version: z.literal(TRAJECTORY_SCHEMA_VERSION),
    source: z.literal("hra"),
    session_id: trajectoryIdSchema,
    provider: z.string().min(1).max(64),
    created_at: trajectoryTimestampSchema,
    transcript_digest: z.string().regex(/^[a-f0-9]{64}$/u),
    omitted_records: z.number().int().nonnegative(),
  }).strict(),
  z.object({
    type: z.literal("user"),
    content: trajectoryTextSchema,
    timestamp: trajectoryTimestampSchema,
  }).strict(),
  z.object({
    type: z.literal("assistant"),
    content: trajectoryTextSchema,
    timestamp: trajectoryTimestampSchema,
  }).strict(),
  z.object({
    type: z.literal("reasoning"),
    content: trajectoryTextSchema,
    timestamp: trajectoryTimestampSchema,
  }).strict(),
  z.object({
    type: z.literal("tool_call"),
    id: trajectoryIdSchema,
    name: z.string().min(1).max(256),
    arguments: trajectoryTextSchema,
    timestamp: trajectoryTimestampSchema,
  }).strict(),
  z.object({
    type: z.literal("tool"),
    tool_call_id: trajectoryIdSchema,
    content: trajectoryTextSchema,
    ok: z.boolean().optional(),
    timestamp: trajectoryTimestampSchema,
  }).strict(),
  z.object({
    type: z.literal("observation"),
    content: trajectoryTextSchema,
    timestamp: trajectoryTimestampSchema,
  }).strict(),
]);

export type TrajectoryRecord = z.infer<typeof trajectoryRecordSchema>;

const toolName = (record: Extract<TranscriptRecord, { kind: "tool_call" }>): string => {
  if (record.tool === undefined) return record.itemKind;
  return record.server === undefined ? record.tool : `${record.server}/${record.tool}`;
};

const recordToTrajectory = (record: TranscriptRecord): readonly TrajectoryRecord[] => {
  const timestamp = isoTimestamp(record.recordedAt);
  switch (record.kind) {
    case "user": {
      // A handoff seed already opens with its own explicit header, so it is
      // not labelled twice.
      const prefix = record.actor === "human" || record.text.startsWith(TRANSCRIPT_SEED_HEADER)
        ? ""
        : record.actor === "autorespond"
          ? "[hra autorespond] "
          : "[hra provider handoff] ";
      return [{
        type: "user",
        content: `${prefix}${record.text}${
          record.omittedCharacters > 0
            ? ` [+${String(record.omittedCharacters)} characters omitted]`
            : ""}`,
        timestamp,
      }];
    }
    case "assistant": return [{
      type: "assistant",
      content: `${record.text}${
        record.omittedCharacters > 0
          ? ` [+${String(record.omittedCharacters)} characters omitted]`
          : ""}`,
      timestamp,
    }];
    case "reasoning": return [{
      type: "reasoning",
      content: `${record.text}${
        record.omittedCharacters > 0
          ? ` [+${String(record.omittedCharacters)} characters omitted]`
          : ""}`,
      timestamp,
    }];
    case "tool_call": return [{
      type: "tool_call",
      id: record.callId,
      name: toolName(record),
      // HRA holds no raw arguments. The stringified object states exactly what
      // it does hold, so the field keeps its contract without inventing input.
      arguments: JSON.stringify({
        hra_arguments_retained: false,
        item_kind: record.itemKind,
        ...(record.server === undefined ? {} : { server: record.server }),
        ...(record.tool === undefined ? {} : { tool: record.tool }),
        ...(record.summary === undefined ? {} : { summary: record.summary }),
      }),
      timestamp,
    }];
    case "tool_result": return [{
      type: "tool",
      tool_call_id: record.callId,
      content: record.status === undefined
        ? TRAJECTORY_NO_OUTPUT_CONTENT
        : `${TRAJECTORY_NO_OUTPUT_CONTENT} (status: ${record.status})`,
      ...(record.ok === null ? {} : { ok: record.ok }),
      timestamp,
    }];
    case "provider_switch": return [{
      type: "observation",
      content: `[hra] provider switched from ${record.fromProvider} (${record.fromPreset}) to `
        + `${record.toProvider} (${record.toPreset}); account ${
          record.accountChanged ? "changed" : "unchanged"}; seed digest ${record.seedDigest}`,
      timestamp,
    }];
  }
};

/**
 * Map one neutral transcript into an ordered letta-ai trajectory v1 document.
 * The meta record always comes first.
 */
export const transcriptToTrajectory = (input: Readonly<{
  transcript: SessionTranscript;
  provider: Provider;
  createdAt: number;
}>): readonly TrajectoryRecord[] => {
  const records: TrajectoryRecord[] = [{
    type: "meta",
    version: TRAJECTORY_SCHEMA_VERSION,
    source: "hra",
    session_id: input.transcript.sessionId,
    provider: input.provider,
    created_at: isoTimestamp(input.createdAt),
    transcript_digest: input.transcript.digest,
    omitted_records: input.transcript.omittedRecords,
  }];
  for (const record of input.transcript.records) records.push(...recordToTrajectory(record));
  return records.map((record) => trajectoryRecordSchema.parse(record));
};
