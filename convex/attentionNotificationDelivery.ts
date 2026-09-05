import { makeFunctionReference } from "convex/server";
import { v } from "convex/values";

import type { CanonicalAuthEmail } from "../src/cloud/authCredentials";
import {
  sendHraAttentionEmail,
  type HraAttentionEmailBody,
  type HraAttentionEmailResult,
} from "./attentionEmail";
import { internalAction, type ActionCtx } from "./server";

export const attentionNotificationActionGroupLimit = 10;

type ClaimedEffect = Readonly<{
  body: HraAttentionEmailBody;
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

const claimNext = makeFunctionReference<"mutation", Record<string, never>, ClaimResult>(
  "attentionNotifications:claimNext",
);
const settleAttempt = makeFunctionReference<
  "mutation",
  Readonly<{
    deliveryId: string;
    generation: number;
    globalNotificationGeneration: number;
    result: HraAttentionEmailResult;
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
    body: HraAttentionEmailBody;
    idempotencyKey: string;
    recipient: CanonicalAuthEmail;
  }>,
) => Promise<HraAttentionEmailResult>;

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
  send: AttentionNotificationSender = sendHraAttentionEmail,
) {
  const maximum = requireDrainLimit(limit);
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
    let result: HraAttentionEmailResult;
    try {
      result = await send({
        body: claim.body,
        idempotencyKey: claim.idempotencyKey,
        recipient: claim.recipient,
      });
    } catch {
      // The transport normally converts failures into a closed retryable
      // result. Keep an unexpected pre-request configuration failure honest
      // and bounded instead of claiming that no provider effect occurred.
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

export const drain = internalAction({
  args: { limit: v.number() },
  handler: async (ctx, args) => await runAttentionNotificationDrain(ctx, args.limit),
});
