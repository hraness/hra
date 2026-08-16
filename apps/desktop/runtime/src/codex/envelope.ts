export type CodexRequestId = string | number;

export const MAX_CODEX_REQUEST_ID_CHARACTERS = 512;

export type CodexEnvelope =
  | Readonly<{
      type: "request";
      id: CodexRequestId;
      method: string;
      params: unknown;
    }>
  | Readonly<{
      type: "notification";
      method: string;
      params: unknown;
    }>
  | Readonly<{
      type: "success";
      id: CodexRequestId;
      result: unknown;
    }>
  | Readonly<{
      type: "error";
      id: CodexRequestId;
      error: Readonly<Record<string, unknown>>;
    }>;

export type CodexEnvelopeFaultReason =
  | "malformed_json"
  | "not_object"
  | "invalid_jsonrpc_version"
  | "invalid_method"
  | "invalid_request_id"
  | "ambiguous_envelope"
  | "missing_response_payload"
  | "invalid_error_payload";

export type CodexEnvelopeClassification =
  | Readonly<{ ok: true; envelope: CodexEnvelope }>
  | Readonly<{ ok: false; reason: CodexEnvelopeFaultReason }>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isRequestId(value: unknown): value is CodexRequestId {
  return (typeof value === "string" && value.length <= MAX_CODEX_REQUEST_ID_CHARACTERS) ||
    (typeof value === "number" && Number.isSafeInteger(value));
}

function has(object: Readonly<Record<string, unknown>>, key: string): boolean {
  return Object.hasOwn(object, key);
}

export function classifyCodexEnvelope(value: unknown): CodexEnvelopeClassification {
  if (!isRecord(value)) return { ok: false, reason: "not_object" };
  if (has(value, "jsonrpc") && value.jsonrpc !== "2.0") {
    return { ok: false, reason: "invalid_jsonrpc_version" };
  }

  const hasMethod = has(value, "method");
  const hasId = has(value, "id");
  const hasResult = has(value, "result");
  const hasError = has(value, "error");

  if (hasMethod) {
    if (typeof value.method !== "string" || value.method.length === 0) {
      return { ok: false, reason: "invalid_method" };
    }
    if (hasResult || hasError) return { ok: false, reason: "ambiguous_envelope" };
    const params = has(value, "params") ? value.params : undefined;
    if (!hasId) return { ok: true, envelope: { type: "notification", method: value.method, params } };
    if (!isRequestId(value.id)) return { ok: false, reason: "invalid_request_id" };
    return {
      ok: true,
      envelope: { type: "request", id: value.id, method: value.method, params },
    };
  }

  if (!hasId) return { ok: false, reason: "missing_response_payload" };
  if (!isRequestId(value.id)) return { ok: false, reason: "invalid_request_id" };
  if (hasResult === hasError) return { ok: false, reason: "missing_response_payload" };
  if (hasResult) {
    return { ok: true, envelope: { type: "success", id: value.id, result: value.result } };
  }
  if (!isRecord(value.error)) return { ok: false, reason: "invalid_error_payload" };
  return { ok: true, envelope: { type: "error", id: value.id, error: value.error } };
}

export function classifyCodexJsonLine(line: string): CodexEnvelopeClassification {
  let value: unknown;
  try {
    value = losslessJson.parse(line, preserveUnsafeJsonInteger);
  } catch {
    return { ok: false, reason: "malformed_json" };
  }
  return classifyCodexEnvelope(value);
}

interface JsonReviverContext {
  readonly source: string;
}

interface LosslessJsonParser {
  parse(
    text: string,
    reviver: (
      key: string,
      value: unknown,
      context?: JsonReviverContext,
    ) => unknown,
  ): unknown;
}

const losslessJson: LosslessJsonParser = JSON;
const integerJsonToken = /^-?(?:0|[1-9][0-9]*)$/u;

function preserveUnsafeJsonInteger(
  _key: string,
  value: unknown,
  context?: JsonReviverContext,
): unknown {
  if (
    typeof value === "number" &&
    Number.isInteger(value) &&
    !Number.isSafeInteger(value) &&
    context !== undefined &&
    integerJsonToken.test(context.source)
  ) {
    return BigInt(context.source);
  }
  return value;
}
