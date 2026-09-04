import {
  cloudLimits,
  containsAbsolutePath,
  containsUnsafeTerminalScalar,
  isOpaqueIdentifier,
  isRecord,
  isSafeNonNegativeInteger,
  isSafePositiveInteger,
  type SyncStream,
} from "./contracts";
import { decryptBytes, encryptBytes } from "./crypto";

export type ModelPreset = "low" | "high" | "ultra";

export type GitAction = Readonly<{
  commit?: string;
  kind: "branch" | "commit" | "diff" | "status";
  label?: string;
}>;

export type CompactInteractionKind =
  | "command_approval"
  | "file_change_approval"
  | "permission_approval"
  | "user_input"
  | "mcp_elicitation";

export type CompactInteractionState =
  | "pending"
  | "response_prepared"
  | "response_written"
  | "resolved"
  | "declined"
  | "canceled"
  | "expired"
  | "resolution_unknown";

export type CompactInteractionEvent = Readonly<{
  blocking: boolean;
  interactionId: string;
  interactionKind: CompactInteractionKind;
  kind: "interaction_state";
  revision: number;
  sequence: number;
  state: CompactInteractionState;
  summary: string;
}>;

export type CompactMessageActor = "human" | "autorespond";

export type CompactSessionEvent =
  | Readonly<{
      actor?: CompactMessageActor;
      kind: "user_message";
      sequence: number;
      text: string;
      turnId: string;
    }>
  | Readonly<{ kind: "assistant_message"; sequence: number; text: string; turnId: string }>
  | CompactInteractionEvent
  | Readonly<{
      fast?: boolean;
      filesTouched: readonly string[];
      gitActions: readonly GitAction[];
      kind: "turn_summary";
      model?: ModelPreset;
      runtimeMs: number;
      sequence: number;
      turnId: string;
    }>;

export type SessionChunkAuthority = Readonly<{
  firstSequence: number;
  keyVersion: number;
  lastSequence: number;
  previousDigest?: string;
  sessionPublicId: string;
  sourceBootId: string;
  sourceDevicePublicId: string;
  sourceFence: number;
  stream: SyncStream;
  userPublicId: string;
}>;

const commitPattern = /^[0-9a-f]{7,64}$/u;
const interactionIdPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const compactInteractionKinds = new Set<CompactInteractionKind>([
  "command_approval",
  "file_change_approval",
  "permission_approval",
  "user_input",
  "mcp_elicitation",
]);
const compactInteractionStates = new Set<CompactInteractionState>([
  "pending",
  "response_prepared",
  "response_written",
  "resolved",
  "declined",
  "canceled",
  "expired",
  "resolution_unknown",
]);
const forbiddenDetailKeyPattern =
  /^(?:approval_secret|credential|env|environment|provider_token|raw_reasoning|tool_arguments|tool_output)$/iu;
const forbiddenSecretValuePattern =
  /(?:-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----|\b(?:sk|re)_[A-Za-z0-9_-]{8,}|\bsk-ant-[A-Za-z0-9_-]{8,}|\bghp_[A-Za-z0-9_-]{8,}|\bAKIA[A-Z0-9]{12,}|\bBearer\s+[A-Za-z0-9._~-]{8,})/u;

// A wire event body carries only its required fields plus a small, named set
// of optional fields for its kind. Any other key is a forward-compatible
// addition from a later revision: it is accepted and silently ignored rather
// than rejected, so an older parser keeps working against a newer writer.
// The event's own `kind`/`type` literal is still matched exactly, so an
// unrecognized event kind is always rejected.
const maximumUnknownKeySlack = 12;

function hasRequiredKeys(
  value: Readonly<Record<string, unknown>>,
  required: readonly string[],
): boolean {
  try {
    const keys = Reflect.ownKeys(value);
    if (keys.length > required.length + maximumUnknownKeySlack) return false;
    return required.every((key) => Object.hasOwn(value, key));
  } catch {
    return false;
  }
}

export function isProjectRelativePath(value: unknown): value is string {
  if (
    typeof value !== "string"
    || value.length < 1
    || value.length > 512
    || value.startsWith("/")
    || value.startsWith("~")
    || /^[A-Za-z]:\//u.test(value)
    || /^file:\/\//iu.test(value)
    || value.includes("\\")
    || value.includes("\0")
    || containsUnsafeTerminalScalar(value)
  ) return false;
  const segments = value.split("/");
  return segments.every((segment) => segment.length > 0 && segment !== "." && segment !== "..");
}

function parseGitAction(value: unknown): GitAction | null {
  if (!isRecord(value)) return null;
  const allowedKeys = ["commit", "kind", "label"];
  let keys: readonly (string | symbol)[];
  try {
    keys = Reflect.ownKeys(value);
  } catch {
    return null;
  }
  if (
    keys.length < 1
    || keys.length > 3
    || !keys.every((key) => typeof key === "string" && allowedKeys.includes(key))
    || (value.kind !== "branch"
      && value.kind !== "commit"
      && value.kind !== "diff"
      && value.kind !== "status")
    || (value.commit !== undefined
      && (typeof value.commit !== "string" || !commitPattern.test(value.commit)))
    || (value.label !== undefined
      && (typeof value.label !== "string"
        || value.label.length > 120
        || containsAbsolutePath(value.label)
        || containsUnsafeTerminalScalar(value.label)
        || forbiddenSecretValuePattern.test(value.label)))
  ) return null;
  return {
    ...(typeof value.commit === "string" ? { commit: value.commit } : {}),
    kind: value.kind,
    ...(typeof value.label === "string" ? { label: value.label } : {}),
  };
}

export function parseCompactSessionEvent(value: unknown): CompactSessionEvent | null {
  if (!isRecord(value)) return null;
  if (
    (value.kind === "user_message" || value.kind === "assistant_message")
    && hasRequiredKeys(value, ["kind", "sequence", "text", "turnId"])
    && isSafePositiveInteger(value.sequence)
    && typeof value.text === "string"
    && value.text.length <= 64_000
    && !containsAbsolutePath(value.text)
    && !containsUnsafeTerminalScalar(value.text, true)
    && !forbiddenSecretValuePattern.test(value.text)
    && isOpaqueIdentifier(value.turnId)
    && (value.kind !== "user_message"
      || value.actor === undefined
      || value.actor === "human"
      || value.actor === "autorespond")
  ) {
    if (value.kind === "assistant_message") {
      return {
        kind: value.kind,
        sequence: value.sequence,
        text: value.text,
        turnId: value.turnId,
      };
    }
    const actor: CompactMessageActor | undefined =
      value.actor === "human" || value.actor === "autorespond" ? value.actor : undefined;
    return {
      ...(actor === undefined ? {} : { actor }),
      kind: value.kind,
      sequence: value.sequence,
      text: value.text,
      turnId: value.turnId,
    };
  }
  if (
    value.kind === "interaction_state"
    && hasRequiredKeys(value, [
      "blocking",
      "interactionId",
      "interactionKind",
      "kind",
      "revision",
      "sequence",
      "state",
      "summary",
    ])
    && typeof value.blocking === "boolean"
    && typeof value.interactionId === "string"
    && interactionIdPattern.test(value.interactionId)
    && typeof value.interactionKind === "string"
    && compactInteractionKinds.has(value.interactionKind as CompactInteractionKind)
    && isSafePositiveInteger(value.revision)
    && isSafePositiveInteger(value.sequence)
    && typeof value.state === "string"
    && compactInteractionStates.has(value.state as CompactInteractionState)
    && typeof value.summary === "string"
    && value.summary.length <= 512
    && !containsAbsolutePath(value.summary)
    && !containsUnsafeTerminalScalar(value.summary, true)
    && !forbiddenSecretValuePattern.test(value.summary)
  ) {
    return {
      blocking: value.blocking,
      interactionId: value.interactionId,
      interactionKind: value.interactionKind as CompactInteractionKind,
      kind: value.kind,
      revision: value.revision,
      sequence: value.sequence,
      state: value.state as CompactInteractionState,
      summary: value.summary,
    };
  }
  if (
    value.kind !== "turn_summary"
    || !hasRequiredKeys(value, [
      "filesTouched",
      "gitActions",
      "kind",
      "runtimeMs",
      "sequence",
      "turnId",
    ])
    || ((value.fast === undefined) !== (value.model === undefined))
    || (value.fast !== undefined && typeof value.fast !== "boolean")
    || (value.model !== undefined
      && value.model !== "low"
      && value.model !== "high"
      && value.model !== "ultra")
    || !isSafeNonNegativeInteger(value.runtimeMs)
    || value.runtimeMs > 7 * 24 * 60 * 60 * 1_000
    || !isSafePositiveInteger(value.sequence)
    || !isOpaqueIdentifier(value.turnId)
    || !Array.isArray(value.filesTouched)
    || value.filesTouched.length > 128
    || !value.filesTouched.every(isProjectRelativePath)
    || new Set(value.filesTouched).size !== value.filesTouched.length
    || !Array.isArray(value.gitActions)
    || value.gitActions.length > 32
  ) return null;
  const gitActions = value.gitActions.map(parseGitAction);
  if (gitActions.some((action) => action === null)) return null;
  return {
    ...(typeof value.fast === "boolean" ? { fast: value.fast } : {}),
    filesTouched: value.filesTouched,
    gitActions: gitActions as GitAction[],
    kind: value.kind,
    ...(value.model === "low" || value.model === "high" || value.model === "ultra"
      ? { model: value.model }
      : {}),
    runtimeMs: value.runtimeMs,
    sequence: value.sequence,
    turnId: value.turnId,
  };
}

export function parseCompactSessionEvents(value: unknown): readonly CompactSessionEvent[] | null {
  if (!Array.isArray(value) || value.length < 1 || value.length > 256) return null;
  const parsed = value.map(parseCompactSessionEvent);
  if (parsed.some((event) => event === null)) return null;
  const events = parsed as CompactSessionEvent[];
  for (let index = 1; index < events.length; index += 1) {
    const previous = events[index - 1];
    const current = events[index];
    if (current?.sequence !== (previous?.sequence ?? -1) + 1) {
      return null;
    }
  }
  return events;
}

export function sessionChunkAad(authority: SessionChunkAuthority): Uint8Array {
  if (
    !isOpaqueIdentifier(authority.sessionPublicId)
    || !isOpaqueIdentifier(authority.sourceBootId)
    || !isOpaqueIdentifier(authority.sourceDevicePublicId)
    || !isOpaqueIdentifier(authority.userPublicId)
    || !isSafePositiveInteger(authority.firstSequence)
    || !isSafePositiveInteger(authority.lastSequence)
    || authority.lastSequence < authority.firstSequence
    || !isSafePositiveInteger(authority.keyVersion)
    || !isSafePositiveInteger(authority.sourceFence)
  ) throw new Error("Invalid session chunk authority.");
  return new TextEncoder().encode([
    "hra-control-plane-session-chunk:v1",
    authority.userPublicId,
    authority.sessionPublicId,
    authority.stream,
    String(authority.firstSequence),
    String(authority.lastSequence),
    authority.previousDigest ?? "root",
    String(authority.keyVersion),
    authority.sourceDevicePublicId,
    authority.sourceBootId,
    String(authority.sourceFence),
  ].join("\n"));
}

export async function encryptCompactEvents(
  events: readonly CompactSessionEvent[],
  accountKey: Uint8Array,
  authority: SessionChunkAuthority,
) {
  const parsed = parseCompactSessionEvents(events);
  if (
    parsed === null
    || parsed[0]?.sequence !== authority.firstSequence
    || parsed.at(-1)?.sequence !== authority.lastSequence
  ) throw new Error("Invalid compact projection chunk.");
  const plaintext = new TextEncoder().encode(JSON.stringify(parsed));
  if (plaintext.byteLength > cloudLimits.detailChunkBytes) {
    throw new Error("Compact projection chunk is too large.");
  }
  return await encryptBytes(
    plaintext,
    accountKey,
    authority.keyVersion,
    sessionChunkAad(authority),
  );
}

export async function decryptCompactEvents(
  envelope: Parameters<typeof decryptBytes>[0],
  accountKey: Uint8Array,
  authority: SessionChunkAuthority,
): Promise<readonly CompactSessionEvent[]> {
  const plaintext = await decryptBytes(envelope, accountKey, sessionChunkAad(authority));
  if (plaintext.byteLength > cloudLimits.detailChunkBytes) {
    throw new Error("Compact projection chunk is too large.");
  }
  const decoded = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(plaintext)) as unknown;
  const parsed = parseCompactSessionEvents(decoded);
  if (parsed === null) throw new Error("Invalid compact projection chunk.");
  return parsed;
}

// --- Live projection (detail stream) -------------------------------------
//
// The `detail` stream carries a small, closed set of live wire events in
// addition to the generic redacted-JSON rows already accepted by
// `detailProjectionIsSafe`. These are the only detail events the live
// uploader (src/cloud/live-uploader.ts) produces and the only ones a reader
// needs to special-case for rendering; any other detail payload still goes
// through the generic safety check below.

export type SessionStateValue =
  | "working"
  | "needs_approval"
  | "needs_answer"
  | "needs_action"
  | "done"
  | "done_followups"
  | "done_caveats"
  | "aborted";

export type DetailSubagentActivityKind = "started" | "interacted" | "interrupted" | "completed";

export type DetailSessionEvent =
  | Readonly<{ at: number; sequence: number; turnId: string; type: "turn_started" }>
  | Readonly<{ sequence: number; text: string; turnId: string; type: "assistant_delta" }>
  | Readonly<{ sequence: number; text: string; turnId: string; type: "reasoning_summary_delta" }>
  | Readonly<{
      agentId: string;
      depth?: number;
      kind: DetailSubagentActivityKind;
      nickname?: string;
      role?: string;
      sequence: number;
      turnId: string;
      type: "subagent_activity";
    }>
  | Readonly<{
      attention: boolean;
      lastActivityAt: number;
      reason: string;
      revision: number;
      sequence: number;
      state: SessionStateValue;
      type: "session_state";
      verbatimRequired: boolean;
    }>;

const sessionStateValues = new Set<SessionStateValue>([
  "working",
  "needs_approval",
  "needs_answer",
  "needs_action",
  "done",
  "done_followups",
  "done_caveats",
  "aborted",
]);

const subagentActivityKinds = new Set<DetailSubagentActivityKind>([
  "started",
  "interacted",
  "interrupted",
  "completed",
]);

const boundedDetailText = (maximum: number) => (value: unknown): value is string =>
  typeof value === "string"
  && value.length <= maximum
  && !containsAbsolutePath(value)
  && !containsUnsafeTerminalScalar(value, true)
  && !forbiddenSecretValuePattern.test(value);

export function parseDetailSessionEvent(value: unknown): DetailSessionEvent | null {
  if (!isRecord(value)) return null;
  if (
    value.type === "turn_started"
    && hasRequiredKeys(value, ["at", "sequence", "turnId", "type"])
    && isSafeNonNegativeInteger(value.at)
    && isSafePositiveInteger(value.sequence)
    && isOpaqueIdentifier(value.turnId)
  ) {
    return { at: value.at, sequence: value.sequence, turnId: value.turnId, type: value.type };
  }
  if (
    (value.type === "assistant_delta" || value.type === "reasoning_summary_delta")
    && hasRequiredKeys(value, ["sequence", "text", "turnId", "type"])
    && isSafePositiveInteger(value.sequence)
    && boundedDetailText(32_768)(value.text)
    && isOpaqueIdentifier(value.turnId)
  ) {
    return { sequence: value.sequence, text: value.text, turnId: value.turnId, type: value.type };
  }
  if (
    value.type === "subagent_activity"
    && hasRequiredKeys(value, ["agentId", "kind", "sequence", "turnId", "type"])
    && isOpaqueIdentifier(value.agentId)
    && typeof value.kind === "string"
    && subagentActivityKinds.has(value.kind as DetailSubagentActivityKind)
    && isSafePositiveInteger(value.sequence)
    && isOpaqueIdentifier(value.turnId)
    && (value.nickname === undefined || boundedDetailText(120)(value.nickname))
    && (value.role === undefined || boundedDetailText(120)(value.role))
    && (value.depth === undefined
      || (isSafeNonNegativeInteger(value.depth) && value.depth <= 32))
  ) {
    return {
      agentId: value.agentId,
      ...(value.depth === undefined ? {} : { depth: value.depth }),
      kind: value.kind as DetailSubagentActivityKind,
      ...(value.nickname === undefined ? {} : { nickname: value.nickname }),
      ...(value.role === undefined ? {} : { role: value.role }),
      sequence: value.sequence,
      turnId: value.turnId,
      type: value.type,
    };
  }
  if (
    value.type === "session_state"
    && hasRequiredKeys(value, [
      "attention",
      "lastActivityAt",
      "reason",
      "revision",
      "sequence",
      "state",
      "type",
      "verbatimRequired",
    ])
    && typeof value.attention === "boolean"
    && isSafeNonNegativeInteger(value.lastActivityAt)
    && boundedDetailText(256)(value.reason)
    && isSafePositiveInteger(value.revision)
    && isSafePositiveInteger(value.sequence)
    && typeof value.state === "string"
    && sessionStateValues.has(value.state as SessionStateValue)
    && typeof value.verbatimRequired === "boolean"
  ) {
    return {
      attention: value.attention,
      lastActivityAt: value.lastActivityAt,
      reason: value.reason,
      revision: value.revision,
      sequence: value.sequence,
      state: value.state as SessionStateValue,
      type: value.type,
      verbatimRequired: value.verbatimRequired,
    };
  }
  return null;
}

export function parseDetailSessionEvents(value: unknown): readonly DetailSessionEvent[] | null {
  if (!Array.isArray(value) || value.length < 1 || value.length > 256) return null;
  const parsed = value.map(parseDetailSessionEvent);
  if (parsed.some((event) => event === null)) return null;
  const events = parsed as DetailSessionEvent[];
  for (let index = 1; index < events.length; index += 1) {
    const previous = events[index - 1];
    const current = events[index];
    if (current?.sequence !== (previous?.sequence ?? -1) + 1) {
      return null;
    }
  }
  return events;
}

export async function encryptDetailEvents(
  events: readonly DetailSessionEvent[],
  accountKey: Uint8Array,
  authority: SessionChunkAuthority,
) {
  const parsed = parseDetailSessionEvents(events);
  if (
    parsed === null
    || parsed[0]?.sequence !== authority.firstSequence
    || parsed.at(-1)?.sequence !== authority.lastSequence
  ) throw new Error("Invalid detail projection chunk.");
  const plaintext = new TextEncoder().encode(JSON.stringify(parsed));
  if (plaintext.byteLength > cloudLimits.detailChunkBytes) {
    throw new Error("Detail projection chunk is too large.");
  }
  return await encryptBytes(
    plaintext,
    accountKey,
    authority.keyVersion,
    sessionChunkAad(authority),
  );
}

export async function decryptDetailEvents(
  envelope: Parameters<typeof decryptBytes>[0],
  accountKey: Uint8Array,
  authority: SessionChunkAuthority,
): Promise<readonly DetailSessionEvent[]> {
  const plaintext = await decryptBytes(envelope, accountKey, sessionChunkAad(authority));
  if (plaintext.byteLength > cloudLimits.detailChunkBytes) {
    throw new Error("Detail projection chunk is too large.");
  }
  const decoded = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(plaintext)) as unknown;
  const parsed = parseDetailSessionEvents(decoded);
  if (parsed === null) throw new Error("Invalid detail projection chunk.");
  return parsed;
}

export function detailProjectionIsSafe(value: unknown, depth = 0): boolean {
  if (depth > 12) return false;
  if (value === null || typeof value === "boolean" || typeof value === "number") return true;
  if (typeof value === "string") {
    return value.length <= 64_000
      && !containsAbsolutePath(value)
      && !forbiddenSecretValuePattern.test(value);
  }
  if (Array.isArray(value)) {
    return value.length <= 256 && value.every((item) => detailProjectionIsSafe(item, depth + 1));
  }
  if (!isRecord(value)) return false;
  let entries: readonly [string, unknown][];
  try {
    entries = Object.entries(value);
  } catch {
    return false;
  }
  return entries.length <= 128 && entries.every(([key, item]) =>
    key.length <= 96
    && !forbiddenDetailKeyPattern.test(key)
    && detailProjectionIsSafe(item, depth + 1));
}
