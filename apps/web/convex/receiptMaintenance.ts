import { v } from "convex/values";

import { internal } from "./_generated/api";
import { internalMutation } from "./_generated/server";
import { legacyHostedMutationReceiptReference } from "./hostedMutationAttempts";

const RECEIPT_SWEEP_BATCH_SIZE = 64;

const sweepResultValidator = v.object({
  deleted: v.number(),
  protected: v.number(),
  scheduled: v.boolean(),
});

export const sweepExpiredHumanReceipts = internalMutation({
  args: { cursor: v.optional(v.string()) },
  returns: sweepResultValidator,
  handler: async (ctx, args) => {
    const page = await ctx.db
      .query("humanCommandReceipts")
      .withIndex("by_expiry", (query) => query.lte("expiresAt", Date.now()))
      .paginate({
        cursor: args.cursor ?? null,
        numItems: RECEIPT_SWEEP_BATCH_SIZE,
      });
    let deleted = 0;
    let protectedCount = 0;
    for (const receipt of page.page) {
      const reference = await ctx.db
        .query("hostedMutationAttempts")
        .withIndex("by_receipt", (query) =>
          query.eq("receiptId", receipt._id))
        .first();
      if (reference !== null) {
        protectedCount += 1;
        continue;
      }
      let legacyReference: Awaited<
        ReturnType<typeof legacyHostedMutationReceiptReference>
      >;
      try {
        legacyReference = await legacyHostedMutationReceiptReference(
          ctx,
          receipt,
        );
      } catch {
        legacyReference = "ambiguous";
      }
      if (legacyReference !== "absent") {
        protectedCount += 1;
        continue;
      }
      await ctx.db.delete(receipt._id);
      deleted += 1;
    }
    if (!page.isDone) {
      await ctx.scheduler.runAfter(
        0,
        internal.receiptMaintenance.sweepExpiredHumanReceipts,
        { cursor: page.continueCursor },
      );
    }
    return {
      deleted,
      protected: protectedCount,
      scheduled: !page.isDone,
    };
  },
});

export const sweepExpiredAgentReceipts = internalMutation({
  args: { cursor: v.optional(v.string()) },
  returns: sweepResultValidator,
  handler: async (ctx, args) => {
    const page = await ctx.db
      .query("commandReceipts")
      .withIndex("by_expiry", (query) => query.lte("expiresAt", Date.now()))
      .paginate({
        cursor: args.cursor ?? null,
        numItems: RECEIPT_SWEEP_BATCH_SIZE,
      });
    for (const receipt of page.page) {
      await ctx.db.delete(receipt._id);
    }
    if (!page.isDone) {
      await ctx.scheduler.runAfter(
        0,
        internal.receiptMaintenance.sweepExpiredAgentReceipts,
        { cursor: page.continueCursor },
      );
    }
    return {
      deleted: page.page.length,
      protected: 0,
      scheduled: !page.isDone,
    };
  },
});
