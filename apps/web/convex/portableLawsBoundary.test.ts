import { describe, expect, test } from "bun:test";
import * as domain from "@hraness/agent-tasks-domain";

import * as dispatchAdapter from "./dispatchLaws";
import * as interactionAdapter from "./dispatchInteractionLaws";
import * as graphAdapter from "./workGraphLaws";

const graphLawNames = [
  "blockerContribution",
  "blockerPropagationReadBound",
  "derivedNeedsAttention",
  "derivedReady",
  "isCredentialFreeHttpsUrl",
  "reviewAcceptanceAllowed",
  "reviewActorAllowed",
  "taskCancellationDisposition",
  "transitionBlockerCounters",
  "transitionSubmissionLifecycle",
  "validateDependencyInsertion",
  "validateParentInsertion",
] as const;

const dispatchLawNames = [
  "contiguousEventBatch",
  "dispatchRetryAllowed",
  "dispatchSubmissionInputRevisionMatches",
  "isTerminalRunPhase",
  "nextRunPhase",
  "resolvedAmbiguousDispatchPhase",
  "runDisplayBudgetAfterBatch",
  "runEventSequenceAllowed",
  "storedRunEventPayloadMatches",
  "taskDispatchBlocksTaskRelease",
] as const;

const interactionLawNames = [
  "boundedRunInteractionPage",
  "openInteractionCountAfterSettlement",
  "pendingExpiredInteractionPage",
  "planRunInteractionBatchAdmission",
  "runInteractionAdmissionDisposition",
  "runInteractionDeliveryProjectionMatches",
  "runInteractionOpenAdmissionDisposition",
  "runInteractionResponseProjectionMatches",
  "runInteractionSettlementDisposition",
] as const;

describe("portable task-law adapter boundary", () => {
  test("Convex re-exports the exact provider-neutral law implementations", () => {
    for (const name of graphLawNames) {
      expect(graphAdapter[name]).toBe(domain[name]);
    }
    for (const name of dispatchLawNames) {
      expect(dispatchAdapter[name]).toBe(domain[name]);
    }
    for (const name of interactionLawNames) {
      expect(interactionAdapter[name]).toBe(domain[name]);
    }
  });

  test("tenant, row, election, fairness, and lease gates remain cloud-owned", () => {
    for (const cloudOnlyName of [
      "activeTaskClaimTupleMatches",
      "agentGrantTupleMatches",
      "dispatchClaimLeaseDisposition",
      "dispatchTenantTupleMatches",
      "runnerAuthorityDisposition",
      "scheduledDispatchExpiryDisposition",
      "selectFairDispatchCandidateRows",
      "taskMatchesAuthorizedScope",
    ]) {
      expect(Object.hasOwn(domain, cloudOnlyName)).toBeFalse();
    }

    expect(graphAdapter.taskMatchesAuthorizedScope({
      authorizedOrganizationId: "org-authorized",
      authorizedWorkspaceId: "workspace-authorized",
      taskOrganizationId: "org-foreign",
      taskWorkspaceId: "workspace-authorized",
    })).toBeFalse();
    expect(dispatchAdapter.runnerAuthorityDisposition({
      runnerPublicId: "runner-current",
      installationId: "installation-current",
      generation: 4,
      leaseUntil: 2_000,
    }, {
      runnerPublicId: "runner-other",
      installationId: "installation-other",
    }, 1_000)).toEqual({ kind: "conflict", retryAfterMs: 1_000 });
    expect(dispatchAdapter.scheduledDispatchExpiryDisposition({
      dispatchId: "dispatch-current",
      runnerId: "runner-current",
      bootId: "boot-current",
      bootGeneration: 2,
      taskClaimId: "claim-current",
      claimFence: 5,
      leaseGeneration: 3,
      leaseUntil: 2_000,
      phase: "running",
    }, {
      dispatchId: "dispatch-current",
      runnerId: "runner-current",
      bootId: "boot-current",
      bootGeneration: 2,
      taskClaimId: "claim-current",
      claimFence: 5,
      leaseGeneration: 2,
      expectedDeadline: 2_000,
    }, 2_000)).toBe("stale");
  });
});
