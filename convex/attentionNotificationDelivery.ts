import { makeFunctionReference } from "convex/server";
import { v } from "convex/values";

import type { CanonicalAuthEmail } from "../src/cloud/authCredentials";
import {
  hasExactKeys,
  isRecord,
  isSafeNonNegativeInteger,
  snapshotForeignJson,
} from "../src/cloud/contracts";
import {
  createOompaAttentionEmailSender,
  type OompaAttentionEmailBody,
  type OompaAttentionEmailResult,
} from "./attentionEmail";
import { internalAction, type ActionCtx } from "./server";

export const attentionNotificationActionGroupLimit = 10;

type ClaimedEffect = Readonly<{
  body: OompaAttentionEmailBody;
  deliveryId: string;
  generation: number;
  globalNotificationGeneration: number;
  idempotencyKey: string;
  kind: "effect";
  recipient: CanonicalAuthEmail;
}>;

type ClaimResult = ClaimedEffect | Readonly<{
  kind: "closed";
  quarantineFaultId?: string;
}> | null;

type SettlementMutationResult = Readonly<{
  kind: string;
  quarantineFaultId?: string;
}>;

type InactiveDeploymentStatus = Readonly<{
  generation: number;
  globalState: "absent" | "disabled" | "enabled";
  outboxOccupancy: 0 | 1;
  safetyFaultOccupancy: 0 | 1;
}>;

const inactiveDeploymentStatus = makeFunctionReference<
  "query",
  Record<string, never>,
  InactiveDeploymentStatus
>("attentionNotificationControl:inactiveDeploymentStatus");

const claimNext = makeFunctionReference<"mutation", Record<string, never>, ClaimResult>(
  "attentionNotifications:claimNext",
);
const settleAttempt = makeFunctionReference<
  "mutation",
  Readonly<{
    deliveryId: string;
    generation: number;
    globalNotificationGeneration: number;
    result: OompaAttentionEmailResult;
  }>,
  SettlementMutationResult
>("attentionNotifications:settleAttempt");
const quarantineFaultedDelivery = makeFunctionReference<
  "mutation",
  Readonly<{ faultId: string }>,
  unknown
>("attentionNotifications:quarantineFaultedDelivery");

export type AttentionNotificationSender = (
  input: Readonly<{
    body: OompaAttentionEmailBody;
    idempotencyKey: string;
    recipient: CanonicalAuthEmail;
  }>,
) => Promise<OompaAttentionEmailResult>;

function requireDrainLimit(value: number): number {
  if (
    !Number.isSafeInteger(value)
    || value < 1
    || value > attentionNotificationActionGroupLimit
  ) throw new Error("Invalid attention-notification drain limit.");
  return value;
}

export async function runAttentionNotificationDrain(
  ctx: Pick<ActionCtx, "runMutation">,
  limit: number,
  send?: AttentionNotificationSender,
) {
  const maximum = requireDrainLimit(limit);
  // Configuration failure must not claim an effect or spend a delivery attempt.
  const sender = send ?? createOompaAttentionEmailSender();
  let claimed = 0;
  let closed = 0;
  for (let slot = 0; slot < maximum; slot += 1) {
    const claim = await ctx.runMutation(claimNext, {});
    if (claim === null) break;
    if (claim.kind === "closed") {
      closed += 1;
      if (claim.quarantineFaultId !== undefined) {
        try {
          await ctx.runMutation(quarantineFaultedDelivery, {
            faultId: claim.quarantineFaultId,
          });
        } catch {
          // The safety latch was committed by the preceding mutation. Cleanup
          // is best effort here and is retried independently by maintenance.
        }
        break;
      }
      continue;
    }
    claimed += 1;
    let result: OompaAttentionEmailResult;
    try {
      result = await sender({
        body: claim.body,
        idempotencyKey: claim.idempotencyKey,
        recipient: claim.recipient,
      });
    } catch {
      // The transport normally converts failures into a closed retryable
      // result. An unexpected failure after claim still has an uncertain
      // provider effect and must retain the ordinary bounded retry semantics.
      result = { kind: "retryable", reason: "network" };
    }
    const settlement = await ctx.runMutation(settleAttempt, {
      deliveryId: claim.deliveryId,
      generation: claim.generation,
      globalNotificationGeneration: claim.globalNotificationGeneration,
      result,
    });
    if (
      settlement.kind === "safety_fault"
      && settlement.quarantineFaultId !== undefined
    ) {
      try {
        await ctx.runMutation(quarantineFaultedDelivery, {
          faultId: settlement.quarantineFaultId,
        });
      } catch {
        // The control latch lives in the already-committed settlement
        // mutation, so cleanup failure cannot reopen provider delivery.
      }
      break;
    }
  }
  return { claimed, closed, processed: claimed + closed };
}

function isUntouchedInactiveDeployment(value: unknown): boolean {
  const snapshot = snapshotForeignJson(value);
  if (
    !snapshot.ok
    || !isRecord(snapshot.value)
    || !hasExactKeys(snapshot.value, [
      "generation", "globalState", "outboxOccupancy", "safetyFaultOccupancy",
    ])
    || !isSafeNonNegativeInteger(snapshot.value.generation)
    || (snapshot.value.globalState !== "absent"
      && snapshot.value.globalState !== "disabled"
      && snapshot.value.globalState !== "enabled")
    || (snapshot.value.outboxOccupancy !== 0 && snapshot.value.outboxOccupancy !== 1)
    || (snapshot.value.safetyFaultOccupancy !== 0 && snapshot.value.safetyFaultOccupancy !== 1)
    || (snapshot.value.globalState === "absent"
      ? snapshot.value.generation !== 0
      : snapshot.value.generation === 0)
  ) throw new Error("Attention notification status is unavailable.");
  return snapshot.value.globalState === "absent"
    && snapshot.value.generation === 0
    && snapshot.value.outboxOccupancy === 0
    && snapshot.value.safetyFaultOccupancy === 0;
}

export async function runAttentionNotificationAction(
  ctx: Pick<ActionCtx, "runMutation" | "runQuery">,
  limit: number,
) {
  const maximum = requireDrainLimit(limit);
  let status: InactiveDeploymentStatus;
  try {
    status = await ctx.runQuery(inactiveDeploymentStatus, {});
  } catch {
    throw new Error("Attention notification status is unavailable.");
  }
  // Only the untouched, empty preactivation deployment is a quiet no-op.
  // Existing delivery or fault work must retain the normal claim boundary.
  if (isUntouchedInactiveDeployment(status)) return { claimed: 0, closed: 0, processed: 0 };
  return await runAttentionNotificationDrain(ctx, maximum);
}

export const drain = internalAction({
  args: { limit: v.number() },
  handler: async (ctx, args) => await runAttentionNotificationAction(ctx, args.limit),
});
