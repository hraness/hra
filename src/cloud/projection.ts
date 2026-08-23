import {
  cloudLimits,
  containsAbsolutePath,
  containsUnsafeTerminalScalar,
  hasExactKeys,
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

export type CompactSessionEvent =
  | Readonly<{ kind: "user_message"; sequence: number; text: string; turnId: string }>
  | Readonly<{ kind: "assistant_message"; sequence: number; text: string; turnId: string }>
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
const forbiddenDetailKeyPattern =
  /^(?:approval_secret|credential|env|environment|provider_token|raw_reasoning|tool_arguments|tool_output)$/iu;
const forbiddenSecretValuePattern =
  /(?:-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----|\b(?:sk|re)_[A-Za-z0-9_-]{8,}|\bBearer\s+[A-Za-z0-9._~-]{8,})/u;

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
    && hasExactKeys(value, ["kind", "sequence", "text", "turnId"])
    && isSafePositiveInteger(value.sequence)
    && typeof value.text === "string"
    && value.text.length <= 64_000
    && !containsAbsolutePath(value.text)
    && !containsUnsafeTerminalScalar(value.text, true)
    && !forbiddenSecretValuePattern.test(value.text)
    && isOpaqueIdentifier(value.turnId)
  ) {
    return {
      kind: value.kind,
      sequence: value.sequence,
      text: value.text,
      turnId: value.turnId,
    };
  }
  if (
    value.kind !== "turn_summary"
    || !hasExactKeys(value, [
      "filesTouched",
      "gitActions",
      "kind",
      "runtimeMs",
      "sequence",
      "turnId",
      ...(value.fast === undefined ? [] : ["fast"]),
      ...(value.model === undefined ? [] : ["model"]),
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
