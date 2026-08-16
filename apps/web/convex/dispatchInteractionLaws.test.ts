import { describe, expect, test } from "bun:test";

import {
  boundedRunInteractionPage,
  openInteractionCountAfterSettlement,
  pendingExpiredInteractionPage,
  planRunInteractionBatchAdmission,
  runInteractionAdmissionDisposition,
  runInteractionDeliveryProjectionMatches,
  runInteractionOpenAdmissionDisposition,
  runInteractionResponseProjectionMatches,
  runInteractionSettlementDisposition,
} from "./dispatchInteractionLaws";

describe("run interaction settlement laws", () => {
  test("delivers ciphertext only to its exact durable workspace, key, and claim tuple", () => {
    const projection = {
      authority: {
        workspaceId: "workspace_current",
        runnerId: "runner_current",
        bootId: "boot_current",
        bootGeneration: 3,
        claimId: "claim_current",
        claimFence: 8,
      },
      reply: {
        keyId: "key_current",
        runnerId: "runner_current",
        bootId: "boot_current",
        bootGeneration: 3,
        claimId: "claim_current",
        claimFence: 8,
      },
      sealed: { workspaceId: "workspace_current", keyId: "key_current" },
    } as const;
    expect(runInteractionDeliveryProjectionMatches(projection)).toBeTrue();
    expect(runInteractionDeliveryProjectionMatches({
      ...projection,
      sealed: { ...projection.sealed, workspaceId: "workspace_foreign" },
    })).toBeFalse();
    expect(runInteractionDeliveryProjectionMatches({
      ...projection,
      sealed: { ...projection.sealed, keyId: "key_stale" },
    })).toBeFalse();
    for (const reply of [
      { ...projection.reply, runnerId: "runner_stale" },
      { ...projection.reply, bootId: "boot_stale" },
      { ...projection.reply, bootGeneration: 2 },
      { ...projection.reply, claimId: "claim_stale" },
      { ...projection.reply, claimFence: 7 },
    ]) {
      expect(runInteractionDeliveryProjectionMatches({ ...projection, reply })).toBeFalse();
    }
  });

  test("a settlement frees an open slot before a mixed-batch upsert is admitted", () => {
    const afterSettlement = openInteractionCountAfterSettlement(32, "answered", "apply");
    expect(afterSettlement).toBe(31);
    expect(runInteractionOpenAdmissionDisposition(afterSettlement, 32)).toBe("accept");
    expect(runInteractionOpenAdmissionDisposition(32, 32)).toBe("capacity_full");
    expect(planRunInteractionBatchAdmission({
      lifetimeInteractionCount: 32,
      maximumOpenInteractions: 32,
      newInteractionStates: ["pending"],
      openInteractionCount: 32,
      settlements: [{ disposition: "apply", durableState: "answered" }],
    })).toEqual({
      kind: "accept",
      lifetimeInteractionCount: 33,
      openInteractionCount: 32,
    });
  });

  test("preflights a whole batch instead of partially admitting its prefix", () => {
    expect(planRunInteractionBatchAdmission({
      lifetimeInteractionCount: 127,
      maximumOpenInteractions: 32,
      newInteractionStates: ["pending", "expired"],
      openInteractionCount: 0,
      settlements: [],
    })).toEqual({ kind: "terminal_limit" });
    expect(planRunInteractionBatchAdmission({
      lifetimeInteractionCount: 10,
      maximumOpenInteractions: 32,
      newInteractionStates: ["pending", "pending"],
      openInteractionCount: 31,
      settlements: [],
    })).toEqual({ kind: "capacity_full" });
    expect(planRunInteractionBatchAdmission({
      lifetimeInteractionCount: 10,
      maximumOpenInteractions: 32,
      newInteractionStates: [],
      openInteractionCount: 1,
      settlements: [{ disposition: "reject", durableState: "answered" }],
    })).toEqual({ kind: "invalid" });
  });

  test("requires one exact ciphertext row only while an answer is pending delivery", () => {
    expect(runInteractionResponseProjectionMatches({
      durableResponseRevision: 2,
      durableState: "answered",
      responseRevisions: [2],
    })).toBeTrue();
    for (const responseRevisions of [[], [1], [2, 2]]) {
      expect(runInteractionResponseProjectionMatches({
        durableResponseRevision: 2,
        durableState: "answered",
        responseRevisions,
      })).toBeFalse();
    }
    for (const durableState of ["pending", "resolved", "expired"] as const) {
      expect(runInteractionResponseProjectionMatches({
        durableState,
        responseRevisions: [],
      })).toBeTrue();
      expect(runInteractionResponseProjectionMatches({
        durableState,
        responseRevisions: [1],
      })).toBeFalse();
    }
  });

  test("turns the lifetime cap into a terminal admission result", () => {
    expect(runInteractionAdmissionDisposition(127)).toBe("accept");
    expect(runInteractionAdmissionDisposition(128)).toBe("terminal_limit");
    expect(runInteractionAdmissionDisposition(129)).toBe("terminal_limit");
  });

  test("pages more than eight answers and expiries without repeating the first page", () => {
    const ordered = Array.from({ length: 9 }, (_, index) => ({ id: `interaction_${index}` }));
    const ninth = ordered[8];
    if (ninth === undefined) throw new Error("Expected a ninth interaction");
    const answers = boundedRunInteractionPage(ordered, 8);
    expect(answers.items.map(({ id }) => id)).toEqual(ordered.slice(0, 8).map(({ id }) => id));
    expect(answers.hasMore).toBeTrue();
    expect(boundedRunInteractionPage(ordered.slice(8), 8)).toEqual({
      items: [ninth],
      hasMore: false,
    });

    const acknowledged = new Set(answers.items.map(({ id }) => id));
    const expiredRows = ordered.map((row) => ({
      ...row,
      ...(acknowledged.has(row.id) ? { settlementAcknowledgedAt: 1 } : {}),
    }));
    expect(pendingExpiredInteractionPage(expiredRows, 8).map(({ id }) => id))
      .toEqual([ninth.id]);
  });
  test("settles a human answer only against its exact response revision", () => {
    expect(runInteractionSettlementDisposition({
      durableResponseRevision: 3,
      durableState: "answered",
      settlement: {
        interactionId: "interaction_settlement01",
        responseRevision: 3,
        outcome: "applied",
      },
    })).toBe("apply");
    expect(runInteractionSettlementDisposition({
      durableResponseRevision: 4,
      durableState: "answered",
      settlement: {
        interactionId: "interaction_settlement01",
        responseRevision: 3,
        outcome: "applied",
      },
    })).toBe("reject");
  });

  test("expires an unanswered request without manufacturing an answer revision", () => {
    expect(runInteractionSettlementDisposition({
      durableState: "pending",
      settlement: {
        interactionId: "interaction_settlement01",
        outcome: "expired",
        reason: "local_deadline",
      },
    })).toBe("apply");
    expect(runInteractionSettlementDisposition({
      durableState: "expired",
      settlement: {
        interactionId: "interaction_settlement01",
        outcome: "expired",
        reason: "local_deadline",
      },
    })).toBe("replay");
  });

  test("lets authoritative provider expiry consume an answer without knowing its revision", () => {
    expect(runInteractionSettlementDisposition({
      durableResponseRevision: 1,
      durableState: "answered",
      settlement: {
        interactionId: "interaction_settlement01",
        outcome: "expired",
        reason: "provider_expired",
      },
    })).toBe("apply");
    expect(runInteractionSettlementDisposition({
      durableState: "pending",
      settlement: {
        interactionId: "interaction_settlement01",
        responseRevision: 1,
        outcome: "expired",
        reason: "local_deadline",
      },
    })).toBe("reject");
  });

  test("accepts exact apply after cloud expiry deleted the sealed response", () => {
    expect(runInteractionSettlementDisposition({
      durableResponseRevision: 2,
      durableState: "expired",
      settlement: {
        interactionId: "interaction_settlement01",
        responseRevision: 2,
        outcome: "applied",
      },
    })).toBe("apply");
    expect(runInteractionSettlementDisposition({
      durableState: "expired",
      settlement: {
        interactionId: "interaction_settlement01",
        responseRevision: 2,
        outcome: "applied",
      },
    })).toBe("reject");
  });
});
