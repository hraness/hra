import type { Infer } from "convex/values";
import { safeErrorMessage, taskViewSchema } from "@hraness/agent-tasks-protocol";

import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import { digestArrayBuffer, encodeDigest } from "./crypto";
import { MAX_COMMAND_RECEIPT_BYTES } from "./model";
import type {
  domainErrorValidator,
  errorCodeValidator,
  errorDetailsValidator,
  taskViewValidator,
} from "./model";

const CROCKFORD_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const UUID_V7_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const REQUEST_ID_PATTERN = /^req_[0-9A-HJKMNP-TV-Z]{26}$/u;
const DIGEST_PATTERN = /^[A-Za-z0-9_-]{43}$/u;
const IDEMPOTENCY_WINDOW_MS = 7 * 24 * 60 * 60 * 1_000;
const IDEMPOTENCY_FUTURE_SKEW_MS = 5 * 60 * 1_000;

export type DomainError = Infer<typeof domainErrorValidator>;
type ErrorCode = Infer<typeof errorCodeValidator>;
export type ErrorDetails = Infer<typeof errorDetailsValidator>;

export function domainFailure(
  code: ErrorCode,
  requestId: string,
  details?: ErrorDetails,
): { ok: false; error: DomainError };
export function domainFailure(
  code: ErrorCode,
  ignoredMessage: string,
  requestId: string,
  details?: ErrorDetails,
): { ok: false; error: DomainError };
export function domainFailure(
  code: ErrorCode,
  second: string,
  third: string | ErrorDetails = {},
  fourth: ErrorDetails = {},
): { ok: false; error: DomainError } {
  const requestId = typeof third === "string" ? third : second;
  const details = typeof third === "string" ? fourth : third;
  return { ok: false, error: { code, message: safeErrorMessage[code], requestId, details } };
}

export function assertRequestMetadata(args: {
  idempotencyKey: string;
  requestDigest: string;
  requestId: string;
  now: number;
}): { ok: true } | { ok: false; error: DomainError } {
  if (!REQUEST_ID_PATTERN.test(args.requestId) || !DIGEST_PATTERN.test(args.requestDigest)) {
    return domainFailure("VALIDATION_ERROR", "Invalid request metadata.", args.requestId);
  }
  if (!UUID_V7_PATTERN.test(args.idempotencyKey)) {
    return domainFailure("IDEMPOTENCY_REQUIRED", "A UUIDv7 Idempotency-Key is required.", args.requestId);
  }
  const timestamp = Number.parseInt(args.idempotencyKey.replaceAll("-", "").slice(0, 12), 16);
  if (!Number.isSafeInteger(timestamp)) {
    return domainFailure("IDEMPOTENCY_REQUIRED", "A UUIDv7 Idempotency-Key is required.", args.requestId);
  }
  if (timestamp < args.now - IDEMPOTENCY_WINDOW_MS) {
    return domainFailure("IDEMPOTENCY_EXPIRED", "The idempotency key has expired.", args.requestId);
  }
  if (timestamp > args.now + IDEMPOTENCY_FUTURE_SKEW_MS) {
    return domainFailure("VALIDATION_ERROR", "The idempotency key timestamp is too far in the future.", args.requestId);
  }
  return { ok: true };
}

export interface ReceiptIdentity {
  readonly kind: "agent" | "enrollment";
  readonly publicId: string;
  readonly organizationId: Id<"organizations">;
  readonly workspaceId: Id<"workspaces">;
}

export type ReceiptLookup<Data> =
  | { readonly kind: "none" }
  | { readonly kind: "replay"; readonly data: Data; readonly requestId: string }
  | { readonly kind: "failure"; readonly result: { ok: false; error: DomainError } };

export function commandReceiptMatches(input: {
  readonly storedOrganizationId: string;
  readonly storedWorkspaceId: string;
  readonly storedPrincipalKind: string;
  readonly storedPrincipalId: string;
  readonly storedOperation: string;
  readonly storedIdempotencyKey: string;
  readonly storedRequestDigest: string | ArrayBuffer;
  readonly expectedOrganizationId: string;
  readonly expectedWorkspaceId: string;
  readonly expectedPrincipalKind: string;
  readonly expectedPrincipalId: string;
  readonly expectedOperation: string;
  readonly expectedIdempotencyKey: string;
  readonly expectedRequestDigest: string;
}): boolean {
  const storedDigest =
    typeof input.storedRequestDigest === "string"
      ? input.storedRequestDigest
      : encodeDigest(input.storedRequestDigest);
  return (
    input.storedOrganizationId === input.expectedOrganizationId &&
    input.storedWorkspaceId === input.expectedWorkspaceId &&
    input.storedPrincipalKind === input.expectedPrincipalKind &&
    input.storedPrincipalId === input.expectedPrincipalId &&
    input.storedOperation === input.expectedOperation &&
    input.storedIdempotencyKey === input.expectedIdempotencyKey &&
    storedDigest === input.expectedRequestDigest
  );
}

export async function lookupReceipt<Data>(
  ctx: MutationCtx,
  args: {
    identity: ReceiptIdentity;
    operation: string;
    idempotencyKey: string;
    requestDigest: string;
    requestId: string;
    parse: (value: unknown) => Data | null;
  },
): Promise<ReceiptLookup<Data>> {
  const receipt = await ctx.db
    .query("commandReceipts")
    .withIndex("by_scope_principal_operation_key", (query) =>
      query
        .eq("organizationId", args.identity.organizationId)
        .eq("workspaceId", args.identity.workspaceId)
        .eq("principalKind", args.identity.kind)
        .eq("principalId", args.identity.publicId)
        .eq("operation", args.operation)
        .eq("idempotencyKey", args.idempotencyKey),
    )
    .unique();
  if (receipt === null) return { kind: "none" };
  if (
    !commandReceiptMatches({
      storedOrganizationId: receipt.organizationId,
      storedWorkspaceId: receipt.workspaceId,
      storedPrincipalKind: receipt.principalKind,
      storedPrincipalId: receipt.principalId,
      storedOperation: receipt.operation,
      storedIdempotencyKey: receipt.idempotencyKey,
      storedRequestDigest: receipt.requestDigest,
      expectedOrganizationId: args.identity.organizationId,
      expectedWorkspaceId: args.identity.workspaceId,
      expectedPrincipalKind: args.identity.kind,
      expectedPrincipalId: args.identity.publicId,
      expectedOperation: args.operation,
      expectedIdempotencyKey: args.idempotencyKey,
      expectedRequestDigest: args.requestDigest,
    })
  ) {
    return {
      kind: "failure",
      result: domainFailure(
        "IDEMPOTENCY_CONFLICT",
        "The idempotency key was already used for a different request.",
        args.requestId,
      ),
    };
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(receipt.responseJson);
  } catch {
    return {
      kind: "failure",
      result: domainFailure("INTERNAL_ERROR", "The stored command receipt is invalid.", args.requestId),
    };
  }
  const data = args.parse(decoded);
  if (data === null) {
    return {
      kind: "failure",
      result: domainFailure("INTERNAL_ERROR", "The stored command receipt is invalid.", args.requestId),
    };
  }
  return { kind: "replay", data, requestId: receipt.requestId };
}

export async function storeReceipt<Data>(
  ctx: MutationCtx,
  args: {
    identity: ReceiptIdentity;
    operation: string;
    idempotencyKey: string;
    requestDigest: string;
    requestId: string;
    data: Data;
    now: number;
  },
): Promise<Id<"commandReceipts">> {
  const responseJson = JSON.stringify(args.data);
  if (new TextEncoder().encode(responseJson).length > MAX_COMMAND_RECEIPT_BYTES) {
    throw new Error("Command receipt exceeds its bounded response limit.");
  }
  const requestDigest = digestArrayBuffer(args.requestDigest);
  if (requestDigest === null) throw new Error("Command receipt request digest is invalid.");
  return await ctx.db.insert("commandReceipts", {
    principalKind: args.identity.kind,
    principalId: args.identity.publicId,
    organizationId: args.identity.organizationId,
    workspaceId: args.identity.workspaceId,
    operation: args.operation,
    idempotencyKey: args.idempotencyKey,
    requestDigest,
    requestId: args.requestId,
    responseJson,
    createdAt: args.now,
    expiresAt: args.now + IDEMPOTENCY_WINDOW_MS,
  });
}

export function randomCrockford(length: number): string {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  let result = "";
  for (const byte of bytes) result += CROCKFORD_ALPHABET[byte % CROCKFORD_ALPHABET.length];
  return result;
}

export function randomPublicId(
  prefix: "clm" | "cmt" | "evt" | "ref" | "repo" | "ses" | "sub" | "tsk",
): string {
  return `${prefix}_${randomCrockford(26)}`;
}

export function randomRequestId(): string {
  return `req_${randomCrockford(26)}`;
}

export function randomUuidV7(now: number): string {
  const bytes = new Uint8Array(16);
  let remaining = now;
  for (let index = 5; index >= 0; index -= 1) {
    bytes[index] = remaining % 256;
    remaining = Math.floor(remaining / 256);
  }
  crypto.getRandomValues(bytes.subarray(6));
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x70;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function taskView(task: Doc<"tasks">): Infer<typeof taskViewValidator> {
  const assigneeAgentId = task.assigneeAgentPublicId;
  const base = {
    id: task.publicId,
    key: task.key,
    title: task.title,
    type: task.type,
    priority: task.priority,
    availableAt: task.availableAt,
    isReady: task.isReady,
    unresolvedBlockerCount: task.unresolvedBlockerCount,
    cancelledBlockerCount: task.cancelledBlockerCount,
    revision: task.revision,
    reviewRevision: task.reviewRevision,
    ...(assigneeAgentId === undefined ? {} : { assigneeAgentId }),
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
  };
  if (task.status === "in_progress") {
    if (task.currentClaim === undefined) throw new Error("In-progress task lacks a current claim.");
    return {
      ...base,
      status: "in_progress" as const,
      currentClaim: {
        id: task.currentClaim.publicId,
        agentId: task.currentClaim.agentPublicId,
        fence: task.currentClaim.fence,
        leaseGeneration: task.currentClaim.leaseGeneration,
        leaseUntil: task.currentClaim.leaseUntil,
      },
    };
  }
  if (task.currentClaim !== undefined) throw new Error("Non-active task retains a current claim.");
  return { ...base, status: task.status };
}

export function parseTaskData(value: unknown): { task: ReturnType<typeof taskView> } | null {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.keys(value).length !== 1 ||
    !("task" in value)
  ) {
    return null;
  }
  const parsed = taskViewSchema.safeParse(value.task);
  if (!parsed.success) return null;
  // Readiness is a backend projection, not just a status-shaped protocol
  // field. Historical receipts that marked active or terminal work ready are
  // malformed and must not be replayed as current task data.
  if (parsed.data.status !== "open" && parsed.data.isReady) return null;
  if (parsed.data.assigneeAgentId === undefined) {
    const { assigneeAgentId: ignoredAssignee, ...task } = parsed.data;
    void ignoredAssignee;
    return { task };
  }
  return { task: { ...parsed.data, assigneeAgentId: parsed.data.assigneeAgentId } };
}

export function isTaskReady(task: Doc<"tasks">, now: number): boolean {
  return (
    task.status === "open" &&
    task.currentClaim === undefined &&
    task.availableAt <= now &&
    task.unresolvedBlockerCount === 0 &&
    task.cancelledBlockerCount === 0
  );
}
