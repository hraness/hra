import { describe, expect, test } from "bun:test";

import type { CanonicalAuthEmail } from "../src/cloud/authCredentials";
import type { HraAttentionEmailResult } from "./attentionEmail";
import {
  attentionNotificationActionGroupLimit,
  runAttentionNotificationDrain,
} from "./attentionNotificationDelivery";
import type { ActionCtx } from "./server";

const body = {
  text: [
    "HRA needs your attention",
    "",
    "Open HRA to review:",
    "- Command approval: https://app.hra.sh/#/session/session_action_test",
  ].join("\n"),
  version: 1 as const,
};

describe("attention notification delivery action", () => {
  test("processes at most ten claimed groups and settles every attempted effect", async () => {
    let claimCalls = 0;
    const settlements: unknown[] = [];
    const context = {
      runMutation: async (_reference: unknown, args: Readonly<Record<string, unknown>>) => {
        if (Object.hasOwn(args, "deliveryId")) {
          settlements.push(args);
          return { kind: "accepted" };
        }
        claimCalls += 1;
        return {
          body,
          deliveryId: `01912345-6789-7abc-8def-${String(claimCalls).padStart(12, "0")}`,
          generation: 1,
          globalNotificationGeneration: 1,
          idempotencyKey: "a".repeat(64),
          kind: "effect" as const,
          recipient: "attention@example.com" as CanonicalAuthEmail,
        };
      },
    } as unknown as Pick<ActionCtx, "runMutation">;
    const sends: string[] = [];
    const send = async (input: Readonly<{ idempotencyKey: string }>): Promise<HraAttentionEmailResult> => {
      sends.push(input.idempotencyKey);
      return { kind: "accepted", providerMessageId: "message_action" };
    };

    expect(await runAttentionNotificationDrain(
      context,
      attentionNotificationActionGroupLimit,
      send,
    )).toEqual({ claimed: 10, closed: 0, processed: 10 });
    expect(claimCalls).toBe(10);
    expect(sends).toHaveLength(10);
    expect(settlements).toHaveLength(10);
  });

  test("stops on idle, counts closed claims, and rejects an oversized action request", async () => {
    const claims = [{ kind: "closed" as const }, null];
    const context = {
      runMutation: async () => claims.shift() ?? null,
    } as unknown as Pick<ActionCtx, "runMutation">;
    expect(await runAttentionNotificationDrain(context, 10)).toEqual({
      claimed: 0,
      closed: 1,
      processed: 1,
    });
    await expect(runAttentionNotificationDrain(
      context,
      attentionNotificationActionGroupLimit + 1,
    )).rejects.toThrow("Invalid attention-notification drain limit");
  });

  test("stops after a committed safety latch and quarantines in a separate mutation", async () => {
    let claimCalls = 0;
    const mutations: Readonly<Record<string, unknown>>[] = [];
    const deliveryId = "01912345-6789-7abc-8def-0123456789f1";
    const context = {
      runMutation: async (_reference: unknown, args: Readonly<Record<string, unknown>>) => {
        mutations.push(args);
        if (Object.hasOwn(args, "result")) {
          return { kind: "safety_fault", quarantineFaultId: deliveryId };
        }
        if (Object.hasOwn(args, "faultId")) {
          return { deleted: 1, remaining: false };
        }
        claimCalls += 1;
        return {
          body,
          deliveryId,
          generation: 1,
          globalNotificationGeneration: 1,
          idempotencyKey: "a".repeat(64),
          kind: "effect" as const,
          recipient: "attention@example.com" as CanonicalAuthEmail,
        };
      },
    } as unknown as Pick<ActionCtx, "runMutation">;
    const send = async (): Promise<HraAttentionEmailResult> => ({
      kind: "ambiguous",
      providerErrorType: "invalid_idempotent_request",
      safetyFault: true,
      status: 409,
    });

    expect(await runAttentionNotificationDrain(context, 10, send)).toEqual({
      claimed: 1,
      closed: 0,
      processed: 1,
    });
    expect(claimCalls).toBe(1);
    expect(mutations).toHaveLength(3);
    expect(mutations[1]).toMatchObject({ deliveryId, result: { kind: "ambiguous" } });
    expect(mutations[2]).toEqual({ faultId: deliveryId });
  });

  test("retains a valid idempotency ambiguity without dispatching quarantine", async () => {
    let claimCalls = 0;
    const mutations: Readonly<Record<string, unknown>>[] = [];
    const deliveryId = "01912345-6789-7abc-8def-0123456789f2";
    const context = {
      runMutation: async (_reference: unknown, args: Readonly<Record<string, unknown>>) => {
        mutations.push(args);
        if (Object.hasOwn(args, "result")) {
          return { kind: "ambiguous", reason: "idempotency_mismatch" };
        }
        claimCalls += 1;
        if (claimCalls > 1) return null;
        return {
          body,
          deliveryId,
          generation: 1,
          globalNotificationGeneration: 1,
          idempotencyKey: "a".repeat(64),
          kind: "effect" as const,
          recipient: "attention@example.com" as CanonicalAuthEmail,
        };
      },
    } as unknown as Pick<ActionCtx, "runMutation">;
    const send = async (): Promise<HraAttentionEmailResult> => ({
      kind: "ambiguous",
      providerErrorType: "invalid_idempotent_request",
      safetyFault: true,
      status: 409,
    });

    expect(await runAttentionNotificationDrain(context, 10, send)).toEqual({
      claimed: 1,
      closed: 0,
      processed: 1,
    });
    expect(claimCalls).toBe(2);
    expect(mutations.filter((args) => Object.hasOwn(args, "deliveryId"))).toHaveLength(1);
    expect(mutations[1]).toMatchObject({ deliveryId, result: { kind: "ambiguous" } });
  });
});
