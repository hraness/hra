import { createHash } from "node:crypto";

import { z } from "zod";

import { providerSchema, type Provider } from "./presets";
import { sessionEventGapReasonSchema } from "./session-events";
import {
  sessionTranscriptSchema,
  TRANSCRIPT_SEED_HEADER,
  type SessionTranscript,
  type TranscriptRecord,
} from "./transcript";

const trajectoryAttachmentSuffix = (
  record: Extract<TranscriptRecord, { kind: "user" }>,
): string => record.attachments === undefined
  ? ""
  : ` [attachments: ${record.attachments.map((attachment) =>
    `${attachment.name} (${attachment.mediaType}, ${String(attachment.byteLength)} bytes, sha256:${attachment.digest})`)
    .join("; ")}; contents not embedded]`;

/**
 * The @letta-ai/trajectory v1 emitter.
 *
 * Upstream is an import-oriented normalizer: it converts many harnesses'
 * native logs into the normalized shape and does not convert normalized
 * records back into their native formats. HRA emits that shape for consumers
 * that accept normalized trajectory v1 arrays.
 * The pinned upstream package and its exported JSON Schema are development
 * fixtures that test this mapping; they are not runtime dependencies.
 *
 * Everything emitted comes from HRA's redacted event stream. HRA never stored
 * raw tool arguments or raw tool output, so a tool call's `args` string states
 * what identity HRA does hold, and a tool record's `content` says plainly that
 * no output was retained.
 */

export const TRAJECTORY_SCHEMA_ID = "https://letta.ai/schemas/trajectory/v1.json";
export const TRAJECTORY_NO_OUTPUT_CONTENT = "[hra] tool output was never retained";
export const TRAJECTORY_EMPTY_ASSISTANT_CONTENT = "[hra] assistant message was empty";
export const HRA_TRAJECTORY_EXPORT_CONTEXT_VERSION = 1;

const isoTimestamp = (value: number): string => new Date(value).toISOString();

// Match the timestamp pattern in trajectory-v1.schema.json rather than Zod's
// narrower default datetime parser, which rejects schema-valid numeric offsets.
const trajectoryTimestampSchema = z.string().regex(
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})$/u,
);
const trajectoryIdSchema = z.string().min(1);

export const trajectoryToolCallSchema = z.object({
  id: trajectoryIdSchema,
  name: z.string().min(1),
  args: z.string(),
}).strict();

const trajectoryMetaSchema = z.object({
  role: z.literal("meta"),
  source: z.string().min(1),
  cwd: z.string().optional(),
  git_branch: z.string().optional(),
  model: z.string().optional(),
}).strict();

const trajectoryTextRecordSchemas = [
  z.object({
    role: z.literal("system"),
    content: z.string(),
    timestamp: trajectoryTimestampSchema,
  }).strict(),
  z.object({
    role: z.literal("observation"),
    content: z.string(),
    timestamp: trajectoryTimestampSchema,
  }).strict(),
  z.object({
    role: z.literal("user"),
    content: z.string(),
    timestamp: trajectoryTimestampSchema,
  }).strict(),
  z.object({
    role: z.literal("reasoning"),
    content: z.string(),
    timestamp: trajectoryTimestampSchema,
  }).strict(),
] as const;

const trajectoryAssistantMessageSchema = z.object({
  role: z.literal("assistant"),
  content: z.string().min(1),
  timestamp: trajectoryTimestampSchema,
}).strict();

const trajectoryAssistantToolCallSchema = z.object({
  role: z.literal("assistant"),
  content: z.null(),
  timestamp: trajectoryTimestampSchema,
  tool_calls: z.array(trajectoryToolCallSchema).min(1),
}).strict();

const trajectoryToolResultSchema = z.object({
  role: z.literal("tool"),
  tool_call_id: trajectoryIdSchema,
  content: z.string(),
  ok: z.boolean().optional(),
  timestamp: trajectoryTimestampSchema,
}).strict();

/** Runtime mirror of @letta-ai/trajectory 0.3.0's trajectory v1 record schema. */
export const trajectoryRecordSchema = z.union([
  trajectoryMetaSchema,
  ...trajectoryTextRecordSchemas,
  trajectoryAssistantMessageSchema,
  trajectoryAssistantToolCallSchema,
  trajectoryToolResultSchema,
]);

/** Runtime mirror of the trajectory v1 root array. */
export const trajectoryDocumentSchema = z.array(trajectoryRecordSchema).min(1);

export type TrajectoryRecord = z.infer<typeof trajectoryRecordSchema>;

/**
 * HRA-specific export facts carried as JSON text in a standard observation.
 * These are not extension properties on trajectory v1 records.
 */
export const hraTrajectoryExportContextSchema = z.object({
  hra_export_context: z.literal(HRA_TRAJECTORY_EXPORT_CONTEXT_VERSION),
  session_id: trajectoryIdSchema,
  provider: providerSchema,
  transcript_digest: z.string().regex(/^[a-f0-9]{64}$/u),
  omitted_records: z.number().int().nonnegative(),
  retention_gap_reason: sessionEventGapReasonSchema.optional(),
}).strict();

export type HraTrajectoryExportContext = z.infer<typeof hraTrajectoryExportContextSchema>;

const toolName = (record: Extract<TranscriptRecord, { kind: "tool_call" }>): string => {
  if (record.tool === undefined) return record.itemKind;
  return record.server === undefined ? record.tool : `${record.server}/${record.tool}`;
};

const textWithOmission = (record: Readonly<{
  text: string;
  omittedCharacters: number;
}>): string => `${record.text}${record.omittedCharacters > 0
  ? ` [+${String(record.omittedCharacters)} characters omitted]`
  : ""}`;

const exportToolId = (input: Readonly<{
  kind: "call" | "orphan_result";
  provider: Provider;
  turnId: string;
  sequence: number;
  callId: string;
}>): string => `hra_${input.kind}_${createHash("sha256")
  .update("hra:trajectory-tool-id:v1\0", "utf8")
  .update(JSON.stringify([
    input.provider,
    input.turnId,
    input.sequence,
    input.callId,
  ]), "utf8")
  .digest("hex")}`;

const recordToTrajectory = (
  record: TranscriptRecord,
  linkedToolCallId?: string,
): readonly TrajectoryRecord[] => {
  const timestamp = isoTimestamp(record.recordedAt);
  switch (record.kind) {
    case "user": {
      // A handoff seed already opens with its own explicit header, so it is
      // not labelled twice. Other actors cannot spoof that header to erase
      // their durable provenance.
      const prefix = record.actor === "human"
        ? record.text.startsWith(TRANSCRIPT_SEED_HEADER)
          ? "[hra human] "
          : ""
        : record.actor === "automation"
          ? "[hra automation] "
          : record.actor === "autorespond"
            ? "[hra autorespond] "
            : record.text.startsWith(TRANSCRIPT_SEED_HEADER)
              ? ""
              : "[hra provider handoff] ";
      return [{
        role: "user",
        content: `${prefix}${textWithOmission(record)}${trajectoryAttachmentSuffix(record)}`,
        timestamp,
      }];
    }
    case "assistant": {
      const content = textWithOmission(record);
      return [{
        role: "assistant",
        // The upstream schema requires nonempty assistant prose. Preserve an
        // empty HRA event explicitly instead of emitting an invalid record.
        content: content.length === 0 ? TRAJECTORY_EMPTY_ASSISTANT_CONTENT : content,
        timestamp,
      }];
    }
    case "reasoning": return [{
      role: "reasoning",
      content: textWithOmission(record),
      timestamp,
    }];
    case "tool_call": return [{
      role: "assistant",
      content: null,
      tool_calls: [{
        id: linkedToolCallId ?? record.callId,
        name: toolName(record),
        // HRA holds no raw arguments. The stringified object states exactly
        // what it does hold, so `args` is not fabricated provider input.
        args: JSON.stringify({
          hra_arguments_retained: false,
          item_kind: record.itemKind,
          ...(record.server === undefined ? {} : { server: record.server }),
          ...(record.tool === undefined ? {} : { tool: record.tool }),
          ...(record.summary === undefined ? {} : { summary: record.summary }),
        }),
      }],
      timestamp,
    }];
    case "tool_result": return [{
      role: "tool",
      tool_call_id: linkedToolCallId ?? record.callId,
      content: record.status === undefined
        ? TRAJECTORY_NO_OUTPUT_CONTENT
        : `${TRAJECTORY_NO_OUTPUT_CONTENT} (status: ${record.status})`,
      ...(record.ok === null ? {} : { ok: record.ok }),
      timestamp,
    }];
    case "provider_switch": return [{
      role: "observation",
      content: `[hra] provider switched from ${record.fromProvider} (${record.fromPreset}) to `
        + `${record.toProvider} (${record.toPreset}); account ${
          record.accountChanged ? "changed" : "unchanged"}; seed digest ${record.seedDigest}`,
      timestamp,
    }];
  }
};

/**
 * Map one neutral transcript into an ordered @letta-ai/trajectory v1 document.
 * The standard meta record comes first. The next standard observation carries
 * HRA's typed export facts as JSON text because v1 meta forbids extra fields.
 */
export const transcriptToTrajectory = (input: Readonly<{
  transcript: SessionTranscript;
  provider: Provider;
  createdAt: number;
}>): readonly TrajectoryRecord[] => {
  const transcript = sessionTranscriptSchema.parse(input.transcript);
  const exportContext = hraTrajectoryExportContextSchema.parse({
    hra_export_context: HRA_TRAJECTORY_EXPORT_CONTEXT_VERSION,
    session_id: transcript.sessionId,
    provider: input.provider,
    transcript_digest: transcript.digest,
    omitted_records: transcript.omittedRecords,
    ...(transcript.retentionGapReason === undefined
      || transcript.retentionGapReason === null
      ? {}
      : { retention_gap_reason: transcript.retentionGapReason }),
  });
  const records: TrajectoryRecord[] = [
    { role: "meta", source: "hra" },
    {
      role: "observation",
      content: JSON.stringify(exportContext),
      timestamp: isoTimestamp(input.createdAt),
    },
  ];
  const firstSwitch = transcript.records.find((record) => record.kind === "provider_switch");
  let recordProvider = firstSwitch?.fromProvider ?? input.provider;
  const latestCallIds = new Map<string, string>();
  const usedCallIds = new Set<string>();
  for (const record of transcript.records) {
    let linkedToolCallId: string | undefined;
    if (record.kind === "tool_call") {
      const baseId = exportToolId({
        kind: "call",
        provider: recordProvider,
        turnId: record.turnId,
        sequence: record.sequence,
        callId: record.callId,
      });
      linkedToolCallId = baseId;
      let collision = 1;
      while (usedCallIds.has(linkedToolCallId)) {
        linkedToolCallId = `${baseId}:${String(collision)}`;
        collision += 1;
      }
      usedCallIds.add(linkedToolCallId);
      latestCallIds.set(JSON.stringify([record.turnId, record.callId]), linkedToolCallId);
    } else if (record.kind === "tool_result") {
      linkedToolCallId = latestCallIds.get(JSON.stringify([record.turnId, record.callId]))
        ?? exportToolId({
          kind: "orphan_result",
          provider: recordProvider,
          turnId: record.turnId,
          sequence: record.sequence,
          callId: record.callId,
        });
    }
    records.push(...recordToTrajectory(record, linkedToolCallId));
    if (record.kind === "provider_switch") {
      recordProvider = record.toProvider;
      latestCallIds.clear();
    }
  }
  return trajectoryDocumentSchema.parse(records);
};
