import {
  containsAbsolutePath,
  containsUnsafeTerminalScalar,
  hasExactKeys,
  isOpaqueIdentifier,
  isRecord,
  type CommandKind,
  type EncryptedEnvelope,
} from "./contracts";
import { decryptBytes, encryptBytes } from "./crypto";
import {
  parseUsageEncryptedEnvelope,
  parseUsageProjection,
  type UsageProjection,
} from "./usage";

// Interaction identifiers are provider-brokered UUIDs (see
// `src/domain/interactions.ts`, `z.string().uuid()`) that are not necessarily
// UUIDv7, so this checks the generic RFC 4122 shape rather than reusing the
// stricter `isUuidV7` idempotency-key check.
const uuidPattern =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/u;

function isInteractionId(value: unknown): value is string {
  return typeof value === "string" && uuidPattern.test(value);
}

function isRemoteInteractionAnswerMap(
  value: unknown,
): value is Readonly<Record<string, Readonly<{ answers: readonly string[] }>>> {
  if (!isRecord(value)) return false;
  const entries = Object.entries(value);
  if (entries.length < 1 || entries.length > 20) return false;
  return entries.every(([questionId, answer]) =>
    questionId.length >= 1
    && questionId.length <= 512
    && isRecord(answer)
    && hasExactKeys(answer, ["answers"])
    && Array.isArray(answer.answers)
    && answer.answers.length <= 20
    && answer.answers.every((entry) =>
      typeof entry === "string"
      && entry.length <= 16_384
      && !containsAbsolutePath(entry)
      && !containsUnsafeTerminalScalar(entry, true)));
}

export type ResolveInteractionDecisionPayload = Readonly<{
  decision: "once" | "decline" | "cancel";
  interactionId: string;
  kind: "resolve_interaction";
  revision: number;
}>;

export type ResolveInteractionAnswersPayload = Readonly<{
  answers: Readonly<Record<string, Readonly<{ answers: readonly string[] }>>>;
  interactionId: string;
  kind: "resolve_interaction";
  revision: number;
}>;

export type RemoteCommandPayload =
  | Readonly<{ kind: "send" | "queue" | "steer" | "send_or_steer"; message: string }>
  | Readonly<{ kind: "stop" }>
  | Readonly<{ kind: "set_model"; preset: "low" | "high" | "ultra" }>
  | Readonly<{ enabled: boolean; kind: "set_fast" }>
  | ResolveInteractionDecisionPayload
  | ResolveInteractionAnswersPayload;

export type SessionMetadataPayload = Readonly<{
  name: string | null;
  note: string | null;
}>;

export type CloudPayloadAuthority = Readonly<{
  entityPublicId: string;
  keyVersion: number;
  kind: "command" | "session_metadata" | "usage";
  userPublicId: string;
}>;

export function parseRemoteCommandPayload(value: unknown): RemoteCommandPayload | null {
  if (!isRecord(value)) return null;
  if (
    (value.kind === "send" || value.kind === "queue" || value.kind === "steer"
      || value.kind === "send_or_steer")
    && hasExactKeys(value, ["kind", "message"])
    && typeof value.message === "string"
    && value.message.length >= 1
    && value.message.length <= 64_000
    && !containsAbsolutePath(value.message)
    && !containsUnsafeTerminalScalar(value.message, true)
  ) return { kind: value.kind, message: value.message };
  if (value.kind === "stop" && hasExactKeys(value, ["kind"])) return { kind: value.kind };
  if (
    value.kind === "set_model"
    && hasExactKeys(value, ["kind", "preset"])
    && (value.preset === "low" || value.preset === "high" || value.preset === "ultra")
  ) return { kind: value.kind, preset: value.preset };
  if (
    value.kind === "set_fast"
    && hasExactKeys(value, ["enabled", "kind"])
    && typeof value.enabled === "boolean"
  ) return { enabled: value.enabled, kind: value.kind };
  if (
    value.kind === "resolve_interaction"
    && isInteractionId(value.interactionId)
    && Number.isSafeInteger(value.revision)
    && (value.revision as number) > 0
  ) {
    if (
      hasExactKeys(value, ["decision", "interactionId", "kind", "revision"])
      && (value.decision === "once" || value.decision === "decline" || value.decision === "cancel")
    ) {
      return {
        decision: value.decision,
        interactionId: value.interactionId,
        kind: value.kind,
        revision: value.revision as number,
      };
    }
    if (
      hasExactKeys(value, ["answers", "interactionId", "kind", "revision"])
      && isRemoteInteractionAnswerMap(value.answers)
    ) {
      return {
        answers: value.answers,
        interactionId: value.interactionId,
        kind: value.kind,
        revision: value.revision as number,
      };
    }
  }
  return null;
}

export function commandPayloadKind(payload: RemoteCommandPayload): CommandKind {
  return payload.kind;
}

export function parseSessionMetadataPayload(value: unknown): SessionMetadataPayload | null {
  if (!isRecord(value) || !hasExactKeys(value, ["name", "note"])) return null;
  if (
    value.name !== null
    && (typeof value.name !== "string"
      || value.name.length < 1
      || value.name.length > 160
      || containsAbsolutePath(value.name)
      || containsUnsafeTerminalScalar(value.name))
  ) return null;
  if (
    value.note !== null
    && (typeof value.note !== "string"
      || value.note.length > 8_000
      || containsAbsolutePath(value.note)
      || containsUnsafeTerminalScalar(value.note, true))
  ) return null;
  return { name: value.name, note: value.note };
}

export function cloudPayloadAad(authority: CloudPayloadAuthority): Uint8Array {
  if (
    !isOpaqueIdentifier(authority.entityPublicId)
    || !isOpaqueIdentifier(authority.userPublicId)
    || !Number.isSafeInteger(authority.keyVersion)
    || authority.keyVersion < 1
  ) throw new Error("Invalid cloud payload authority.");
  return new TextEncoder().encode([
    "hra-control-plane-cloud-payload:v1",
    authority.kind,
    authority.userPublicId,
    authority.entityPublicId,
    String(authority.keyVersion),
  ].join("\n"));
}

async function encryptJson(
  value: unknown,
  key: Uint8Array,
  authority: CloudPayloadAuthority,
): Promise<EncryptedEnvelope> {
  return await encryptBytes(
    new TextEncoder().encode(JSON.stringify(value)),
    key,
    authority.keyVersion,
    cloudPayloadAad(authority),
  );
}

async function decryptJson(
  envelope: EncryptedEnvelope,
  key: Uint8Array,
  authority: CloudPayloadAuthority,
): Promise<unknown> {
  if (envelope.keyVersion !== authority.keyVersion) throw new Error("Cloud payload key mismatch.");
  const plaintext = await decryptBytes(envelope, key, cloudPayloadAad(authority));
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(plaintext)) as unknown;
}

export async function encryptRemoteCommand(
  payload: RemoteCommandPayload,
  key: Uint8Array,
  authority: CloudPayloadAuthority,
): Promise<EncryptedEnvelope> {
  if (authority.kind !== "command" || parseRemoteCommandPayload(payload) === null) {
    throw new Error("Invalid remote command payload.");
  }
  return await encryptJson(payload, key, authority);
}

export async function decryptRemoteCommand(
  envelope: EncryptedEnvelope,
  key: Uint8Array,
  authority: CloudPayloadAuthority,
): Promise<RemoteCommandPayload> {
  if (authority.kind !== "command") throw new Error("Invalid remote command authority.");
  const parsed = parseRemoteCommandPayload(await decryptJson(envelope, key, authority));
  if (parsed === null) throw new Error("Invalid remote command payload.");
  return parsed;
}

export async function encryptSessionMetadata(
  payload: SessionMetadataPayload,
  key: Uint8Array,
  authority: CloudPayloadAuthority,
): Promise<EncryptedEnvelope> {
  if (authority.kind !== "session_metadata" || parseSessionMetadataPayload(payload) === null) {
    throw new Error("Invalid session metadata payload.");
  }
  return await encryptJson(payload, key, authority);
}

export async function decryptSessionMetadata(
  envelope: EncryptedEnvelope,
  key: Uint8Array,
  authority: CloudPayloadAuthority,
): Promise<SessionMetadataPayload> {
  if (authority.kind !== "session_metadata") throw new Error("Invalid session metadata authority.");
  const parsed = parseSessionMetadataPayload(await decryptJson(envelope, key, authority));
  if (parsed === null) throw new Error("Invalid session metadata payload.");
  return parsed;
}

export async function encryptUsageProjection(
  payload: UsageProjection,
  key: Uint8Array,
  authority: CloudPayloadAuthority,
): Promise<EncryptedEnvelope> {
  if (authority.kind !== "usage" || parseUsageProjection(payload) === null) {
    throw new Error("Invalid usage projection.");
  }
  const envelope = await encryptJson(payload, key, authority);
  if (parseUsageEncryptedEnvelope(envelope) === null) {
    throw new Error("Encrypted usage projection exceeds its closed envelope bound.");
  }
  return envelope;
}

export async function decryptUsageProjection(
  envelope: EncryptedEnvelope,
  key: Uint8Array,
  authority: CloudPayloadAuthority,
): Promise<UsageProjection> {
  if (
    authority.kind !== "usage"
    || parseUsageEncryptedEnvelope(envelope) === null
  ) throw new Error("Invalid usage authority.");
  const parsed = parseUsageProjection(await decryptJson(envelope, key, authority));
  if (parsed === null) throw new Error("Invalid usage projection.");
  return parsed;
}
