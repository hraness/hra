import type { CanonicalAuthEmail } from "../src/cloud/authCredentials";
import { isCanonicalAuthEmail } from "../src/cloud/authCredentials";
import {
  hasExactKeys,
  isOpaqueIdentifier,
  isRecord,
  snapshotForeignJson,
} from "../src/cloud/contracts";
import type { InteractionKind } from "../src/domain/interactions";
import { requireHraResendApiKey } from "./resendApiKey";

export const hraAttentionEmailFrom =
  "HRA attention <notifications@news.hraness.com>" as const;
export const hraAttentionEmailSubject = "HRA needs your attention" as const;
export const hraAttentionEmailEndpoint = "https://api.resend.com/emails" as const;
export const hraAttentionEmailUserAgent = "hra-attention-email/1" as const;
export const hraAttentionEmailDeliveryTimeoutMs = 8_000;

const attentionEmailBodyV1Version = 1 as const;
const attentionEmailBodyV1MaximumBodyBytes = 8 * 1_024;
const attentionEmailBodyV1MaximumItems = 8;
const attentionEmailBodyV1SubjectLine = "HRA needs your attention" as const;

export const hraAttentionEmailMaximumBodyBytes = attentionEmailBodyV1MaximumBodyBytes;
export const hraAttentionEmailMaximumItems = attentionEmailBodyV1MaximumItems;
export const hraAttentionEmailBodyVersion = attentionEmailBodyV1Version;

const maximumProviderResponseBytes = 4 * 1_024;
const maximumProviderMessageIdCharacters = 256;
const maximumProviderErrorMessageCharacters = 4_096;
const utf8Encoder = new TextEncoder();
const utf8Decoder = new TextDecoder("utf-8", { fatal: true });
const providerMessageIdPattern = /^[A-Za-z0-9_-]+$/u;
const idempotencyKeyPattern = /^[!-~]+$/u;

/*
 * This is the immutable v1 wire-body vocabulary. A later presentation change
 * must add a body version rather than changing these strings, because an
 * effect-started outbox row must remain byte-identical across every retry.
 */
const attentionEmailBodyV1InteractionKindLabels = Object.freeze({
  command_approval: "Command approval",
  file_change_approval: "File change approval",
  mcp_elicitation: "MCP elicitation",
  permission_approval: "Permission approval",
  user_input: "User input",
} satisfies Readonly<Record<InteractionKind, string>>);
const attentionEmailBodyV1ReviewLine = "Open HRA to review:" as const;
const attentionEmailBodyV1SessionUrl = "https://app.hra.sh/#/session/" as const;

const interactionKinds = new Set<InteractionKind>(
  Object.keys(attentionEmailBodyV1InteractionKindLabels) as InteractionKind[],
);
const interactionKindLabelV1Values = new Set<string>(
  Object.values(attentionEmailBodyV1InteractionKindLabels),
);

export type HraAttentionEmailRefusalType =
  | "invalid_access"
  | "invalid_api_key"
  | "invalid_attachment"
  | "invalid_from_address"
  | "invalid_idempotency_key"
  | "invalid_parameter"
  | "invalid_region"
  | "method_not_allowed"
  | "missing_api_key"
  | "missing_required_field"
  | "not_found"
  | "restricted_api_key"
  | "validation_error";

const documentedNoEffectPairs = new Map<number, ReadonlySet<HraAttentionEmailRefusalType>>([
  [400, new Set(["invalid_idempotency_key", "validation_error"])],
  [401, new Set(["missing_api_key", "restricted_api_key"])],
  [403, new Set([
    "invalid_api_key",
    "validation_error",
  ])],
  [404, new Set(["not_found"])],
  [405, new Set(["method_not_allowed"])],
  [422, new Set([
    "invalid_access",
    "invalid_attachment",
    "invalid_from_address",
    "invalid_parameter",
    "invalid_region",
    "missing_required_field",
  ])],
]);

export type HraAttentionEmailItem = Readonly<{
  interactionKind: InteractionKind;
  sessionPublicId: string;
}>;

export type HraAttentionEmailBody = Readonly<{
  text: string;
  version: typeof attentionEmailBodyV1Version;
}>;

export type HraAttentionEmailPayload = Readonly<{
  from: typeof hraAttentionEmailFrom;
  subject: typeof hraAttentionEmailSubject;
  text: string;
  to: readonly [CanonicalAuthEmail];
}>;

export type HraAttentionEmailResult =
  | Readonly<{
      kind: "accepted";
      providerMessageId: string;
    }>
  | Readonly<{
      kind: "refused";
      providerErrorType: HraAttentionEmailRefusalType;
      status: number;
    }>
  | Readonly<{
      kind: "ambiguous";
      providerErrorType: "invalid_idempotent_request";
      safetyFault: true;
      status: 409;
    }>
  | Readonly<{
      kind: "retryable";
      reason:
        | "concurrent_idempotency"
        | "malformed_success"
        | "network"
        | "timeout"
        | "transient_http"
        | "unknown_or_incoherent_response";
    }>;

export type HraAttentionEmailFetch = (
  resource: string,
  init: RequestInit,
) => Promise<Response>;

const retryable = (
  reason: Extract<HraAttentionEmailResult, { kind: "retryable" }>["reason"],
): HraAttentionEmailResult => Object.freeze({ kind: "retryable", reason });

function requireAttentionEmailItem(value: unknown): HraAttentionEmailItem {
  const snapshot = snapshotForeignJson(value);
  if (
    !snapshot.ok
    || !isRecord(snapshot.value)
    || !hasExactKeys(snapshot.value, ["interactionKind", "sessionPublicId"])
    || typeof snapshot.value.interactionKind !== "string"
    || !interactionKinds.has(snapshot.value.interactionKind as InteractionKind)
    || !isOpaqueIdentifier(snapshot.value.sessionPublicId)
  ) throw new Error("Attention email delivery is unavailable.");
  return {
    interactionKind: snapshot.value.interactionKind as InteractionKind,
    sessionPublicId: snapshot.value.sessionPublicId,
  };
}

function requireAttentionEmailIdempotencyKey(value: unknown): string {
  if (
    typeof value !== "string"
    || value.length < 1
    || value.length > 256
    || !idempotencyKeyPattern.test(value)
  ) throw new Error("Attention email delivery is unavailable.");
  return value;
}

export function buildHraAttentionEmailBody(
  input: readonly HraAttentionEmailItem[],
): HraAttentionEmailBody {
  if (
    !Array.isArray(input)
    || input.length < 1
    || input.length > attentionEmailBodyV1MaximumItems
  ) throw new Error("Attention email delivery is unavailable.");

  const items = input.map(requireAttentionEmailItem);
  const text = [
    attentionEmailBodyV1SubjectLine,
    "",
    attentionEmailBodyV1ReviewLine,
    ...items.map((item) =>
      `- ${attentionEmailBodyV1InteractionKindLabels[item.interactionKind]}: ${attentionEmailBodyV1SessionUrl}${item.sessionPublicId}`),
  ].join("\n");
  if (utf8Encoder.encode(text).byteLength > attentionEmailBodyV1MaximumBodyBytes) {
    throw new Error("Attention email delivery is unavailable.");
  }

  return Object.freeze({ text, version: attentionEmailBodyV1Version });
}

function isAttentionEmailBodyV1Text(text: string): boolean {
  if (utf8Encoder.encode(text).byteLength > attentionEmailBodyV1MaximumBodyBytes) return false;
  const lines = text.split("\n");
  if (
    lines.length < 4
    || lines.length > 3 + attentionEmailBodyV1MaximumItems
    || lines[0] !== attentionEmailBodyV1SubjectLine
    || lines[1] !== ""
    || lines[2] !== attentionEmailBodyV1ReviewLine
  ) return false;

  return lines.slice(3).every((line) => {
    if (!line.startsWith("- ")) return false;
    const marker = `: ${attentionEmailBodyV1SessionUrl}`;
    const markerIndex = line.indexOf(marker, 2);
    if (markerIndex < 3 || line.indexOf(marker, markerIndex + marker.length) !== -1) return false;
    const label = line.slice(2, markerIndex);
    const sessionId = line.slice(markerIndex + marker.length);
    return interactionKindLabelV1Values.has(label) && isOpaqueIdentifier(sessionId);
  });
}

/**
 * Revalidates the versioned body stored by the hosted claim. Version 1 stays a
 * fixed grammar so later template versions cannot rewrite an in-flight effect.
 */
export function parseHraAttentionEmailBody(value: unknown): HraAttentionEmailBody | null {
  const snapshot = snapshotForeignJson(value);
  if (
    !snapshot.ok
    || !isRecord(snapshot.value)
    || !hasExactKeys(snapshot.value, ["text", "version"])
    || snapshot.value.version !== attentionEmailBodyV1Version
    || typeof snapshot.value.text !== "string"
    || !isAttentionEmailBodyV1Text(snapshot.value.text)
  ) return null;
  return Object.freeze({
    text: snapshot.value.text,
    version: attentionEmailBodyV1Version,
  });
}

export function buildHraAttentionEmailPayload(input: Readonly<{
  body: HraAttentionEmailBody;
  recipient: CanonicalAuthEmail;
}>): HraAttentionEmailPayload {
  const body = parseHraAttentionEmailBody(input.body);
  if (body === null || !isCanonicalAuthEmail(input.recipient)) {
    throw new Error("Attention email delivery is unavailable.");
  }

  return Object.freeze({
    from: hraAttentionEmailFrom,
    subject: hraAttentionEmailSubject,
    text: body.text,
    to: Object.freeze([input.recipient] as const),
  });
}

function strictProviderError(
  body: unknown,
  status: number,
): Readonly<{ name: string }> | null {
  const snapshot = snapshotForeignJson(body);
  if (
    !snapshot.ok
    || !isRecord(snapshot.value)
    || !hasExactKeys(snapshot.value, ["message", "name", "statusCode"])
    || typeof snapshot.value.name !== "string"
    || snapshot.value.name.length < 1
    || snapshot.value.name.length > 128
    || !/^[a-z][a-z0-9_]*$/u.test(snapshot.value.name)
    || typeof snapshot.value.message !== "string"
    || snapshot.value.message.length < 1
    || snapshot.value.message.length > maximumProviderErrorMessageCharacters
    || snapshot.value.statusCode !== status
  ) return null;
  return { name: snapshot.value.name };
}

export function isHraAttentionEmailDocumentedRefusal(
  status: number,
  name: string,
): name is HraAttentionEmailRefusalType {
  return documentedNoEffectPairs.get(status)?.has(name as HraAttentionEmailRefusalType) === true;
}

export function classifyHraAttentionEmailResponse(input: Readonly<{
  body: unknown;
  status: number;
}>): HraAttentionEmailResult {
  if (!Number.isInteger(input.status) || input.status < 100 || input.status > 599) {
    return retryable("unknown_or_incoherent_response");
  }

  if (input.status >= 200 && input.status < 300) {
    const snapshot = snapshotForeignJson(input.body);
    if (
      snapshot.ok
      && isRecord(snapshot.value)
      && hasExactKeys(snapshot.value, ["id"])
      && typeof snapshot.value.id === "string"
      && snapshot.value.id.length >= 1
      && snapshot.value.id.length <= maximumProviderMessageIdCharacters
      && providerMessageIdPattern.test(snapshot.value.id)
    ) {
      return Object.freeze({
        kind: "accepted",
        providerMessageId: snapshot.value.id,
      });
    }
    return retryable("malformed_success");
  }

  if (
    input.status === 408
    || input.status === 429
    || input.status >= 500
  ) return retryable("transient_http");

  const error = strictProviderError(input.body, input.status);
  if (input.status === 409 && error?.name === "invalid_idempotent_request") {
    return Object.freeze({
      kind: "ambiguous",
      providerErrorType: "invalid_idempotent_request",
      safetyFault: true,
      status: 409,
    });
  }
  if (input.status === 409 && error?.name === "concurrent_idempotent_requests") {
    return retryable("concurrent_idempotency");
  }
  if (error !== null && isHraAttentionEmailDocumentedRefusal(input.status, error.name)) {
    return Object.freeze({
      kind: "refused",
      providerErrorType: error.name,
      status: input.status,
    });
  }
  return retryable("unknown_or_incoherent_response");
}

async function readBoundedJson(response: Response): Promise<unknown> {
  const contentType = response.headers.get("content-type");
  if (
    contentType === null
    || !/^application\/json(?:\s*;\s*charset=utf-8)?$/iu.test(contentType)
  ) {
    await response.body?.cancel().catch(() => undefined);
    return null;
  }
  const declared = response.headers.get("content-length");
  if (
    declared !== null
    && (!/^[0-9]{1,15}$/u.test(declared) || Number(declared) > maximumProviderResponseBytes)
  ) {
    await response.body?.cancel().catch(() => undefined);
    return null;
  }
  if (response.body === null) return null;

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > maximumProviderResponseBytes) {
        await reader.cancel().catch(() => undefined);
        return null;
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(utf8Decoder.decode(bytes)) as unknown;
  } catch {
    return null;
  }
}

export async function sendHraAttentionEmail(
  input: Readonly<{
    body: HraAttentionEmailBody;
    idempotencyKey: string;
    recipient: CanonicalAuthEmail;
  }>,
  options: Readonly<{
    environment?: Readonly<Record<string, string | undefined>>;
    fetch?: HraAttentionEmailFetch;
  }> = {},
): Promise<HraAttentionEmailResult> {
  const payload = buildHraAttentionEmailPayload(input);
  const idempotencyKey = requireAttentionEmailIdempotencyKey(input.idempotencyKey);
  const apiKey = requireHraResendApiKey(options.environment);
  const fetchImplementation: HraAttentionEmailFetch = options.fetch ?? globalThis.fetch;
  const controller = new AbortController();
  const timeoutError = new Error("Attention email delivery timed out.");
  let rejectDeadline!: (error: Error) => void;
  const deadline = new Promise<never>((_resolve, reject) => {
    rejectDeadline = reject;
  });
  const timeout = setTimeout(() => {
    rejectDeadline(timeoutError);
    controller.abort(timeoutError);
  }, hraAttentionEmailDeliveryTimeoutMs);

  try {
    const request = fetchImplementation(hraAttentionEmailEndpoint, {
      body: JSON.stringify(payload),
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "Idempotency-Key": idempotencyKey,
        "User-Agent": hraAttentionEmailUserAgent,
      },
      method: "POST",
      redirect: "error",
      signal: controller.signal,
    }).then(async (response) => classifyHraAttentionEmailResponse({
      body: await readBoundedJson(response),
      status: response.status,
    }));
    return await Promise.race([request, deadline]);
  } catch (error: unknown) {
    return retryable(error === timeoutError ? "timeout" : "network");
  } finally {
    clearTimeout(timeout);
  }
}
