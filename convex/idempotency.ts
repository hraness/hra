import type { GenericId as Id } from "convex/values";

import { isAuthDigest } from "./authPolicy";
import { reserveQuotaForInsert } from "./quota";
import type { MutationCtx } from "./server";

const uuidV7Pattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const receiptLifetimeMs = 7 * 24 * 60 * 60 * 1_000;
const futureSkewMs = 5 * 60 * 1_000;

function uuidV7Timestamp(value: string): number | null {
  if (!uuidV7Pattern.test(value)) return null;
  const prefix = value.replaceAll("-", "").slice(0, 12);
  const timestamp = Number.parseInt(prefix, 16);
  return Number.isSafeInteger(timestamp) ? timestamp : null;
}

export function validateIdempotencyInput(
  idempotencyKey: string,
  requestDigest: string,
  now: number,
): void {
  const timestamp = uuidV7Timestamp(idempotencyKey);
  if (
    timestamp === null
    || timestamp < now - receiptLifetimeMs
    || timestamp > now + futureSkewMs
    || !isAuthDigest(requestDigest)
  ) throw new Error("Invalid idempotency authority.");
}

export type IdempotencyScope = Readonly<{
  deviceId?: Id<"devices">;
  operation: string;
  scopeId: string;
  userId: Id<"users">;
}>;

export async function loadIdempotencyReceipt(
  ctx: MutationCtx,
  scope: IdempotencyScope,
  idempotencyKey: string,
  requestDigest: string,
): Promise<Readonly<Record<string, unknown>> | null> {
  const now = Date.now();
  validateIdempotencyInput(idempotencyKey, requestDigest, now);
  const matches = await ctx.db
    .query("idempotencyReceipts")
    .withIndex("by_scope_and_key", (query) => query
      .eq("userId", scope.userId)
      .eq("deviceId", scope.deviceId)
      .eq("operation", scope.operation)
      .eq("scopeId", scope.scopeId)
      .eq("idempotencyKey", idempotencyKey))
    .take(2);
  if (matches.length > 1) throw new Error("Idempotency receipt invariant failed.");
  const receipt = matches[0];
  if (receipt === undefined) return null;
  if (receipt.requestDigest !== requestDigest) throw new Error("IDEMPOTENCY_CONFLICT");
  try {
    const parsed = JSON.parse(receipt.responseJson) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error("Idempotency receipt invariant failed.");
    }
    return parsed as Readonly<Record<string, unknown>>;
  } catch {
    throw new Error("Idempotency receipt invariant failed.");
  }
}

export async function storeIdempotencyReceipt(
  ctx: MutationCtx,
  scope: IdempotencyScope,
  input: Readonly<{
    idempotencyKey: string;
    requestDigest: string;
    response: unknown;
  }>,
): Promise<void> {
  const now = Date.now();
  validateIdempotencyInput(input.idempotencyKey, input.requestDigest, now);
  const responseJson = JSON.stringify(input.response);
  if (
    responseJson.length > 4_096
    || scope.operation.length < 1
    || scope.operation.length > 64
    || scope.scopeId.length < 1
    || scope.scopeId.length > 128
  ) throw new Error("Idempotency receipt is too large.");
  const receiptDocument = {
    createdAt: now,
    ...(scope.deviceId === undefined ? {} : { deviceId: scope.deviceId }),
    expiresAt: now + receiptLifetimeMs,
    idempotencyKey: input.idempotencyKey,
    operation: scope.operation,
    requestDigest: input.requestDigest,
    responseJson,
    scopeId: scope.scopeId,
    userId: scope.userId,
  } as const;
  await reserveQuotaForInsert(ctx, scope.userId, "receipt", receiptDocument);
  await ctx.db.insert("idempotencyReceipts", receiptDocument);
}
