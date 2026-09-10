import { describe, expect, test } from "bun:test";

import trajectoryPackage from "@letta-ai/trajectory/package.json";
import trajectoryV1Schema from "@letta-ai/trajectory/schema";
import { validateTranscript } from "@letta-ai/trajectory";
import Ajv2020 from "ajv/dist/2020.js";

import { sessionTranscriptSchema, TRANSCRIPT_SEED_HEADER } from "./transcript";
import {
  oompaTrajectoryExportContextSchema,
  TRAJECTORY_EMPTY_ASSISTANT_CONTENT,
  TRAJECTORY_SCHEMA_ID,
  trajectoryRecordSchema,
  transcriptToTrajectory,
} from "./trajectory";

const timestamp = 1_700_000_000_000;
const isoTimestamp = new Date(timestamp).toISOString();
const sessionId = `sess_${"a".repeat(32)}`;
const turnId = `opaque_v2_${"b".repeat(64)}`;
const secondTurnId = `opaque_v2_${"f".repeat(64)}`;
const itemId = `opaque_v2_${"c".repeat(64)}`;
const callId = `opaque_v2_${"d".repeat(64)}`;
const digest = "e".repeat(64);

// Upstream's `if: { required: ["tool_calls"] }` intentionally relies on the
// enclosing assistant properties. Ajv's strictRequired lint cannot see that
// scope, so disable only that lint while retaining strict schema validation.
const upstreamValidator = new Ajv2020({ allErrors: true, strict: true, strictRequired: false })
  .compile(trajectoryV1Schema);

describe("trajectory v1 export", () => {
  test("stays pinned to the official package schema", () => {
    expect(trajectoryPackage.version).toBe("0.3.0");
    expect(trajectoryV1Schema.$id).toBe(TRAJECTORY_SCHEMA_ID);
  });

  test("validates every Oompa mapping against the pinned upstream schema", () => {
    const transcript = sessionTranscriptSchema.parse({
      version: 1,
      sessionId,
      provider: "claude",
      retentionGapReason: "retention_age",
      records: [
        {
          kind: "user",
          actor: "automation",
          turnId: null,
          sequence: 1,
          throughSequence: 1,
          recordedAt: timestamp,
          text: "ship it",
          omittedCharacters: 2,
        },
        {
          kind: "assistant",
          turnId,
          itemId,
          sequence: 2,
          throughSequence: 2,
          recordedAt: timestamp + 1,
          text: "",
          omittedCharacters: 0,
        },
        {
          kind: "reasoning",
          turnId,
          itemId,
          sequence: 3,
          throughSequence: 3,
          recordedAt: timestamp + 2,
          text: "checking",
          omittedCharacters: 0,
        },
        {
          kind: "tool_call",
          turnId,
          callId,
          itemKind: "mcpToolCall",
          server: "github",
          tool: "create_issue",
          summary: "mcpToolCall: github/create_issue",
          sequence: 4,
          throughSequence: 4,
          recordedAt: timestamp + 3,
        },
        {
          kind: "tool_result",
          turnId,
          callId,
          itemKind: "mcpToolCall",
          status: "completed",
          summary: "mcpToolCall: github/create_issue",
          ok: true,
          sequence: 5,
          throughSequence: 5,
          recordedAt: timestamp + 4,
        },
        {
          kind: "provider_switch",
          fromProvider: "codex",
          toProvider: "claude",
          fromPreset: "ultra",
          toPreset: "fable-max",
          accountChanged: false,
          seedDigest: digest,
          sequence: 6,
          throughSequence: 6,
          recordedAt: timestamp + 5,
        },
      ],
      throughSequence: 6,
      nextSequence: null,
      omittedRecords: 3,
      omittedCharacters: 2,
      digest,
    });

    const document = transcriptToTrajectory({
      transcript,
      provider: "claude",
      createdAt: timestamp,
    });
    expect(upstreamValidator(document), JSON.stringify(upstreamValidator.errors))
      .toBe(true);
    expect(() => validateTranscript(document, { partial: true })).not.toThrow();

    expect(document[0]).toEqual({ role: "meta", source: "oompa" });
    const contextRecord = document[1];
    if (contextRecord?.role !== "observation") throw new Error("Expected the Oompa export context observation.");
    expect(contextRecord.timestamp).toBe(isoTimestamp);
    expect(oompaTrajectoryExportContextSchema.parse(JSON.parse(contextRecord.content))).toEqual({
      hra_export_context: 1,
      session_id: sessionId,
      provider: "claude",
      transcript_digest: digest,
      omitted_records: 3,
      retention_gap_reason: "retention_age",
    });

    const emptyAssistant = document.find((record) =>
      record.role === "assistant" && record.content === TRAJECTORY_EMPTY_ASSISTANT_CONTENT);
    expect(emptyAssistant).toBeDefined();

    const call = document.find((record) => record.role === "assistant" && record.content === null);
    if (call === undefined) throw new Error("Expected an assistant tool-call record.");
    expect(call.tool_calls).toHaveLength(1);
    const exportedCallId = call.tool_calls[0]?.id;
    expect(exportedCallId).toMatch(/^hra_call_[a-f0-9]{64}$/u);
    expect(call.tool_calls[0]).toMatchObject({ id: exportedCallId, name: "github/create_issue" });
    expect(JSON.parse(call.tool_calls[0]?.args ?? "")).toMatchObject({
      hra_arguments_retained: false,
      item_kind: "mcpToolCall",
    });

    const result = document.find((record) => record.role === "tool");
    expect(result).toMatchObject({ role: "tool", tool_call_id: exportedCallId, ok: true });
  });

  test("preserves actor provenance even when text spoofs the handoff header", () => {
    const transcript = sessionTranscriptSchema.parse({
      version: 1,
      sessionId,
      provider: "codex",
      records: [
        {
          kind: "user",
          actor: "human",
          turnId: null,
          sequence: 1,
          throughSequence: 1,
          recordedAt: timestamp,
          text: `${TRANSCRIPT_SEED_HEADER}\nhuman text`,
          omittedCharacters: 0,
        },
        {
          kind: "user",
          actor: "automation",
          turnId: null,
          sequence: 2,
          throughSequence: 2,
          recordedAt: timestamp + 1,
          text: `${TRANSCRIPT_SEED_HEADER}\nautomation text`,
          omittedCharacters: 0,
        },
        {
          kind: "user",
          actor: "autorespond",
          turnId: null,
          sequence: 3,
          throughSequence: 3,
          recordedAt: timestamp + 2,
          text: `${TRANSCRIPT_SEED_HEADER}\nautorespond text`,
          omittedCharacters: 0,
        },
        {
          kind: "user",
          actor: "provider_switch",
          turnId: null,
          sequence: 4,
          throughSequence: 4,
          recordedAt: timestamp + 3,
          text: `${TRANSCRIPT_SEED_HEADER}\nreal handoff`,
          omittedCharacters: 0,
        },
        {
          kind: "user",
          actor: "provider_switch",
          turnId: null,
          sequence: 5,
          throughSequence: 5,
          recordedAt: timestamp + 4,
          text: "header was unavailable",
          omittedCharacters: 0,
        },
      ],
      throughSequence: 5,
      nextSequence: null,
      omittedRecords: 0,
      omittedCharacters: 0,
      digest,
    });
    const document = transcriptToTrajectory({ transcript, provider: "codex", createdAt: timestamp });
    const users = document.filter((record) => record.role === "user");
    expect(users.map((record) => record.content)).toEqual([
      `[oompa human] ${TRANSCRIPT_SEED_HEADER}\nhuman text`,
      `[oompa automation] ${TRANSCRIPT_SEED_HEADER}\nautomation text`,
      `[oompa autorespond] ${TRANSCRIPT_SEED_HEADER}\nautorespond text`,
      `${TRANSCRIPT_SEED_HEADER}\nreal handoff`,
      "[oompa provider handoff] header was unavailable",
    ]);
    expect(() => validateTranscript(document, { partial: true })).not.toThrow();
  });

  test("refuses a control-bearing attachment name at the export boundary", () => {
    const unsafeTranscript = {
      version: 1,
      sessionId,
      records: [{
        kind: "user",
        actor: "human",
        turnId: null,
        sequence: 1,
        throughSequence: 1,
        recordedAt: timestamp,
        text: "review the attachment",
        omittedCharacters: 0,
        attachments: [{
          byteLength: 4,
          digest,
          mediaType: "text/plain",
          name: `report${String.fromCodePoint(0x202e)}fdp.exe`,
        }],
      }],
      throughSequence: 1,
      nextSequence: null,
      omittedRecords: 0,
      omittedCharacters: 0,
      digest,
    } as unknown as Parameters<typeof transcriptToTrajectory>[0]["transcript"];

    expect(() => transcriptToTrajectory({
      transcript: unsafeTranscript,
      provider: "codex",
      createdAt: timestamp,
    })).toThrow();
  });

  test("preserves peer-session provenance in the user record", () => {
    const transcript = sessionTranscriptSchema.parse({
      version: 1,
      sessionId,
      records: [{
        kind: "user",
        actor: "peer_session",
        sequence: 1,
        throughSequence: 1,
        recordedAt: timestamp,
        turnId,
        text: "Review this invariant.",
        omittedCharacters: 0,
      }],
      throughSequence: 1,
      nextSequence: null,
      omittedRecords: 0,
      omittedCharacters: 0,
      digest,
    });
    expect(transcriptToTrajectory({
      transcript,
      provider: "codex",
      createdAt: timestamp,
    })[2]).toMatchObject({
      role: "user",
      content: "[oompa peer session] Review this invariant.",
    });
  });

  test("uses unique deterministic tool-call ids and keeps results linked in partial exports", () => {
    const toolCall = (sequence: number, recordTurnId = turnId) => ({
      kind: "tool_call" as const,
      turnId: recordTurnId,
      callId,
      itemKind: "commandExecution",
      sequence,
      throughSequence: sequence,
      recordedAt: timestamp + sequence,
    });
    const toolResult = (sequence: number, recordTurnId = turnId) => ({
      kind: "tool_result" as const,
      turnId: recordTurnId,
      callId,
      itemKind: "commandExecution",
      status: "completed",
      ok: true,
      sequence,
      throughSequence: sequence,
      recordedAt: timestamp + sequence,
    });
    const transcript = sessionTranscriptSchema.parse({
      version: 1,
      sessionId,
      provider: "claude",
      records: [
        toolCall(1),
        toolResult(2),
        {
          kind: "provider_switch",
          fromProvider: "codex",
          toProvider: "claude",
          fromPreset: "ultra",
          toPreset: "fable-max",
          accountChanged: false,
          seedDigest: digest,
          sequence: 3,
          throughSequence: 3,
          recordedAt: timestamp + 3,
        },
        toolCall(4),
        toolCall(5, secondTurnId),
        toolResult(6),
        toolResult(7, secondTurnId),
        toolCall(8, secondTurnId),
        toolResult(9, secondTurnId),
        { ...toolResult(10), callId: `${callId}-orphan` },
      ],
      throughSequence: 10,
      nextSequence: null,
      omittedRecords: 5,
      omittedCharacters: 0,
      digest,
    });
    const document = transcriptToTrajectory({ transcript, provider: "claude", createdAt: timestamp });
    const calls = document.flatMap((record) =>
      record.role === "assistant" && record.content === null ? record.tool_calls : []);
    const results = document.filter((record) => record.role === "tool");
    expect(calls).toHaveLength(4);
    expect(calls.every((call) => /^hra_call_[a-f0-9]{64}$/u.test(call.id))).toBe(true);
    expect(new Set(calls.map((call) => call.id)).size).toBe(calls.length);
    expect(results.slice(0, 4).map((record) => record.tool_call_id))
      .toEqual(calls.map((call) => call.id));
    expect(results[4]?.tool_call_id).toMatch(/^hra_orphan_result_[a-f0-9]{64}$/u);
    const repeated = transcriptToTrajectory({ transcript, provider: "claude", createdAt: timestamp });
    expect(repeated).toEqual(document);
    expect(upstreamValidator(document), JSON.stringify(upstreamValidator.errors)).toBe(true);
    expect(() => validateTranscript(document, { partial: true })).not.toThrow();
    expect(() => validateTranscript(document)).toThrow("tool result must reference a tool call");
  });

  test("rejects the legacy type-based shape and arguments field", () => {
    expect(() => trajectoryRecordSchema.parse({
      type: "meta",
      version: 1,
      source: "oompa",
    })).toThrow();
    expect(() => trajectoryRecordSchema.parse({
      role: "assistant",
      content: null,
      timestamp: isoTimestamp,
      tool_calls: [{ id: callId, name: "tool", arguments: "{}" }],
    })).toThrow();
  });
});
