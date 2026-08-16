import { expect, test } from "bun:test";
import { assertProperty, fc } from "@hra-internal/test";

import {
  openInteractionCountAfterSettlement,
  planRunInteractionBatchAdmission,
  runInteractionAdmissionDisposition,
  runInteractionDeliveryProjectionMatches,
  runInteractionResponseProjectionMatches,
  runInteractionSettlementDisposition,
  type DurableRunInteractionState,
} from "./dispatchInteractionLaws";
import { MAX_RUN_INTERACTIONS_PER_RUN } from "@hraness/agent-tasks-protocol";

const states = ["pending", "answered", "resolved", "expired"] as const satisfies readonly DurableRunInteractionState[];

test("interaction delivery authority is exact across arbitrary tuple values", () => {
  assertProperty(fc.property(
    fc.string(),
    fc.string(),
    fc.string(),
    fc.integer({ min: 1, max: 1_000_000 }),
    fc.string(),
    fc.integer({ min: 1, max: 1_000_000 }),
    fc.string(),
    fc.string(),
    (workspaceId, runnerId, bootId, bootGeneration, claimId, claimFence, keyId, mismatch) => {
      const authority = { workspaceId, runnerId, bootId, bootGeneration, claimId, claimFence };
      const reply = { keyId, runnerId, bootId, bootGeneration, claimId, claimFence };
      expect(runInteractionDeliveryProjectionMatches({
        authority,
        reply,
        sealed: { workspaceId, keyId },
      })).toBeTrue();
      if (mismatch !== workspaceId) {
        expect(runInteractionDeliveryProjectionMatches({
          authority,
          reply,
          sealed: { workspaceId: mismatch, keyId },
        })).toBeFalse();
      }
    },
  ));
});

test("an applied interaction settlement accepts exactly one matching response revision", () => {
  assertProperty(fc.property(
    fc.integer({ min: 1, max: 1_000_000 }),
    fc.integer({ min: 1, max: 1_000_000 }),
    fc.constantFrom(...states),
    (durableRevision, submittedRevision, durableState) => {
      const disposition = runInteractionSettlementDisposition({
        durableResponseRevision: durableRevision,
        durableState,
        settlement: {
          interactionId: "interaction_property001",
          responseRevision: submittedRevision,
          outcome: "applied",
        },
      });
      expect(disposition !== "reject").toBe(
        durableRevision === submittedRevision &&
          (durableState === "answered" || durableState === "resolved" || durableState === "expired"),
      );
    },
  ));
});

test("interaction admission never retries forever beyond the lifetime cap", () => {
  assertProperty(fc.property(
    fc.integer({ min: 0, max: MAX_RUN_INTERACTIONS_PER_RUN * 4 }),
    (count) => {
      expect(runInteractionAdmissionDisposition(count)).toBe(
        count < MAX_RUN_INTERACTIONS_PER_RUN ? "accept" : "terminal_limit",
      );
    },
  ));
});

test("settlement accounting frees exactly one slot only for an applied open row", () => {
  assertProperty(fc.property(
    fc.integer({ min: 1, max: 32 }),
    fc.constantFrom(...states),
    fc.constantFrom("apply", "replay", "reject"),
    (count, durableState, disposition) => {
      expect(openInteractionCountAfterSettlement(count, durableState, disposition)).toBe(
        disposition === "apply" &&
          (durableState === "pending" || durableState === "answered")
          ? count - 1
          : count,
      );
    },
  ));
});

test("batch admission is all-or-nothing and independent of item order", () => {
  assertProperty(fc.property(
    fc.integer({ min: 0, max: MAX_RUN_INTERACTIONS_PER_RUN }),
    fc.integer({ min: 0, max: 32 }),
    fc.array(fc.constantFrom("pending" as const, "expired" as const), { maxLength: 8 }),
    fc.array(fc.record({
      disposition: fc.constantFrom("apply" as const, "replay" as const),
      durableState: fc.constantFrom(...states),
    }), { maxLength: 8 }),
    (lifetimeInteractionCount, openInteractionCount, newInteractionStates, settlements) => {
      const forward = planRunInteractionBatchAdmission({
        lifetimeInteractionCount,
        maximumOpenInteractions: 32,
        newInteractionStates,
        openInteractionCount,
        settlements,
      });
      const reversed = planRunInteractionBatchAdmission({
        lifetimeInteractionCount,
        maximumOpenInteractions: 32,
        newInteractionStates: [...newInteractionStates].reverse(),
        openInteractionCount,
        settlements: [...settlements].reverse(),
      });
      expect(forward).toEqual(reversed);
      if (forward.kind === "accept") {
        expect(forward.lifetimeInteractionCount).toBe(
          lifetimeInteractionCount + newInteractionStates.length,
        );
        expect(forward.openInteractionCount).toBeGreaterThanOrEqual(0);
        expect(forward.openInteractionCount).toBeLessThanOrEqual(32);
      }
    },
  ));
});

test("only an exact single response revision represents an answered interaction", () => {
  assertProperty(fc.property(
    fc.constantFrom(...states),
    fc.option(fc.integer({ min: 1, max: 1_000_000 }), { nil: undefined }),
    fc.array(fc.integer({ min: 1, max: 1_000_000 }), { maxLength: 3 }),
    (durableState, durableResponseRevision, responseRevisions) => {
      const matches = runInteractionResponseProjectionMatches({
        durableState,
        ...(durableResponseRevision === undefined ? {} : { durableResponseRevision }),
        responseRevisions,
      });
      expect(matches).toBe(
        durableState === "answered"
          ? durableResponseRevision !== undefined &&
            responseRevisions.length === 1 &&
            responseRevisions[0] === durableResponseRevision
          : responseRevisions.length === 0 &&
            (durableState !== "pending" || durableResponseRevision === undefined),
      );
    },
  ));
});
