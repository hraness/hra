import { describe, expect, test } from "bun:test";
import { assertProperty, fc } from "@hra-internal/test";

import { digestArrayBuffer, encodeDigest } from "./crypto";
import { commandReceiptMatches } from "./domain";
import {
  activeTaskClaimTupleMatches,
  claimCommandDisposition,
  derivedNeedsAttention,
  derivedReady,
  nextClaimFence,
  reviewAcceptanceAllowed,
  reviewActorAllowed,
  scheduledClaimDisposition,
  taskCancellationDisposition,
  transitionBlockerCounters,
  transitionSubmissionLifecycle,
  type BlockerLifecycle,
  type SubmissionLifecycle,
} from "./workGraphLaws";

type SerialOrder = "left_then_right" | "right_then_left";
type AgentId = "agt_alpha" | "agt_beta";
type ClaimState = "active" | "expired" | "released" | "replaced" | "submitted";

const COMMAND_NOW = 150;
const EXPIRED_CLAIM_DEADLINE = 100;
const LIVE_CLAIM_DEADLINE = 200;
const RENEWED_CLAIM_DEADLINE = 300;
const CLAIM_RENEWAL_THRESHOLD = 100;

interface ClaimView {
  readonly id: string;
  readonly agentId: AgentId;
  readonly fence: number;
  readonly leaseGeneration: number;
  readonly live: boolean;
  readonly state: ClaimState;
}

interface SubmissionView {
  readonly id: string;
  readonly submittedByAgentId: AgentId;
  readonly reviewRevision: number;
  readonly status: SubmissionLifecycle;
}

interface TaskRaceSnapshot {
  readonly status: BlockerLifecycle;
  readonly revision: number;
  readonly reviewRevision: number;
  readonly claimFence: number;
  readonly currentClaim: Omit<ClaimView, "live" | "state"> | null;
  readonly claims: readonly ClaimView[];
  readonly submissions: readonly SubmissionView[];
  readonly blockerStatus: BlockerLifecycle;
  readonly unresolvedBlockerCount: number;
  readonly cancelledBlockerCount: number;
  readonly isReady: boolean;
  readonly needsAttention: boolean;
  readonly sideEffects: readonly string[];
}

interface ClaimInitialization {
  readonly fence: number;
  readonly leaseGeneration: number;
  readonly live: boolean;
  readonly revision: number;
  readonly reviewRevision: number;
}

interface ReviewInitialization {
  readonly revision: number;
  readonly reviewRevision: number;
}

interface PairOutcome {
  readonly left: boolean;
  readonly right: boolean;
}

function claimId(fence: number): string {
  return `clm_${fence}`;
}

function claimView(
  fence: number,
  leaseGeneration: number,
  agentId: AgentId,
  live: boolean,
  state: ClaimState,
): ClaimView {
  return {
    id: claimId(fence),
    agentId,
    fence,
    leaseGeneration,
    live,
    state,
  };
}

function currentClaimView(
  fence: number,
  leaseGeneration: number,
  agentId: AgentId,
): Omit<ClaimView, "live" | "state"> {
  return { id: claimId(fence), agentId, fence, leaseGeneration };
}

function runSerializablePair(
  order: SerialOrder,
  left: () => boolean,
  right: () => boolean,
): PairOutcome {
  if (order === "left_then_right") {
    const leftResult = left();
    const rightResult = right();
    return { left: leftResult, right: rightResult };
  }
  const rightResult = right();
  const leftResult = left();
  return { left: leftResult, right: rightResult };
}

class SerializableTaskRaceSystem {
  private status: BlockerLifecycle;
  private revision: number;
  private readonly reviewRevision: number;
  private claimFence: number;
  private claimLeaseUntil: number;
  private currentClaim: Omit<ClaimView, "live" | "state"> | null;
  private readonly claims: ClaimView[];
  private readonly submissions: SubmissionView[];
  private blockerStatus: BlockerLifecycle = "done";
  private unresolvedBlockerCount = 0;
  private cancelledBlockerCount = 0;
  private isReady: boolean;
  private needsAttention: boolean;
  private readonly sideEffects: string[] = [];

  private constructor(args: {
    readonly status: BlockerLifecycle;
    readonly revision: number;
    readonly reviewRevision: number;
    readonly claimFence: number;
    readonly currentClaim: Omit<ClaimView, "live" | "state"> | null;
    readonly claims: readonly ClaimView[];
    readonly submissions: readonly SubmissionView[];
  }) {
    this.status = args.status;
    this.revision = args.revision;
    this.reviewRevision = args.reviewRevision;
    this.claimFence = args.claimFence;
    this.claimLeaseUntil = args.claims[0]?.live
      ? LIVE_CLAIM_DEADLINE
      : EXPIRED_CLAIM_DEADLINE;
    this.currentClaim = args.currentClaim === null ? null : { ...args.currentClaim };
    this.claims = args.claims.map((claim) => ({ ...claim }));
    this.submissions = args.submissions.map((submission) => ({ ...submission }));
    this.isReady = this.deriveReady();
    this.needsAttention = this.deriveNeedsAttention();
  }

  static withClaim(args: ClaimInitialization): SerializableTaskRaceSystem {
    return new SerializableTaskRaceSystem({
      status: "in_progress",
      revision: args.revision,
      reviewRevision: args.reviewRevision,
      claimFence: args.fence,
      currentClaim: currentClaimView(args.fence, args.leaseGeneration, "agt_alpha"),
      claims: [
        claimView(
          args.fence,
          args.leaseGeneration,
          "agt_alpha",
          args.live,
          "active",
        ),
      ],
      submissions: [],
    });
  }

  static inReview(args: ReviewInitialization): SerializableTaskRaceSystem {
    return new SerializableTaskRaceSystem({
      status: "in_review",
      revision: args.revision,
      reviewRevision: args.reviewRevision,
      claimFence: 0,
      currentClaim: null,
      claims: [],
      submissions: [
        {
          id: "sub_1",
          submittedByAgentId: "agt_alpha",
          reviewRevision: args.reviewRevision,
          status: "pending",
        },
      ],
    });
  }

  snapshot(): TaskRaceSnapshot {
    return {
      status: this.status,
      revision: this.revision,
      reviewRevision: this.reviewRevision,
      claimFence: this.claimFence,
      currentClaim: this.currentClaim === null ? null : { ...this.currentClaim },
      claims: this.claims.map((claim) => ({ ...claim })),
      submissions: this.submissions.map((submission) => ({ ...submission })),
      blockerStatus: this.blockerStatus,
      unresolvedBlockerCount: this.unresolvedBlockerCount,
      cancelledBlockerCount: this.cancelledBlockerCount,
      isReady: this.isReady,
      needsAttention: this.needsAttention,
      sideEffects: [...this.sideEffects],
    };
  }

  assertInvariants(): void {
    const activeClaims = this.claims.filter((claim) => claim.state === "active");
    const pendingSubmissions = this.submissions.filter(
      (submission) => submission.status === "pending",
    );
    expect(activeClaims).toHaveLength(this.currentClaim === null ? 0 : 1);
    expect(this.currentClaim !== null).toBe(this.status === "in_progress");
    expect(pendingSubmissions).toHaveLength(this.status === "in_review" ? 1 : 0);
    expect(new Set(this.claims.map((claim) => claim.fence)).size).toBe(this.claims.length);
    expect(this.claims.every((claim) => claim.fence <= this.claimFence)).toBeTrue();
    expect(new Set(this.sideEffects).size).toBe(this.sideEffects.length);
    expect(this.isReady).toBe(this.deriveReady());
    expect(this.needsAttention).toBe(this.deriveNeedsAttention());
    if (this.currentClaim !== null) {
      expect(this.currentClaim.fence).toBe(this.claimFence);
      expect(this.activeClaimTupleMatches()).toBeTrue();
    }
  }

  renew(fence: number): boolean {
    const durable = this.activeClaim();
    const disposition = claimCommandDisposition({
      command: "renew",
      taskStatus: this.status,
      hasCurrentClaim: this.currentClaim !== null,
      ...(this.currentClaim === null
        ? {}
        : {
            currentAgentId: this.currentClaim.agentId,
            currentFence: this.currentClaim.fence,
            currentLeaseUntil: this.claimLeaseUntil,
          }),
      authorizedAgentId: "agt_alpha",
      requestedFence: fence,
      now: COMMAND_NOW,
      renewalThresholdMs: CLAIM_RENEWAL_THRESHOLD,
    });
    if (
      durable === null ||
      !this.activeClaimTupleMatches() ||
      disposition.kind !== "allowed" ||
      this.currentClaim === null
    ) {
      return false;
    }
    const leaseGeneration = durable.leaseGeneration + 1;
    this.replaceClaim(durable, { ...durable, leaseGeneration });
    this.currentClaim = { ...this.currentClaim, leaseGeneration };
    this.claimLeaseUntil = RENEWED_CLAIM_DEADLINE;
    this.revision += 1;
    this.addSideEffect("event:task.claim_renewed");
    this.addSideEffect(`schedule:claim.expiry:${fence}:${leaseGeneration}`);
    return true;
  }

  expireScheduledClaim(claim: string, fence: number, leaseGeneration: number): boolean {
    const durable = this.activeClaim();
    const disposition = scheduledClaimDisposition({
      activeTupleMatches: this.activeClaimTupleMatches(),
      scheduledClaimId: claim,
      currentClaimId: this.currentClaim?.id,
      scheduledFence: fence,
      currentFence: this.currentClaim?.fence,
      scheduledLeaseGeneration: leaseGeneration,
      currentLeaseGeneration: this.currentClaim?.leaseGeneration,
      scheduledDeadline: LIVE_CLAIM_DEADLINE,
      currentLeaseUntil:
        this.currentClaim === null ? undefined : this.claimLeaseUntil,
      now: LIVE_CLAIM_DEADLINE,
    });
    if (durable === null || disposition !== "expire") {
      return false;
    }
    this.closeClaim(durable, "expired");
    this.status = "open";
    this.revision += 1;
    this.refreshProjections();
    this.addSideEffect("event:task.claim_expired");
    return true;
  }

  reclaim(agentId: AgentId): boolean {
    const previous = this.activeClaim();
    if (
      previous === null ||
      !this.activeClaimTupleMatches() ||
      previous.live ||
      this.unresolvedBlockerCount + this.cancelledBlockerCount !== 0
    ) {
      return false;
    }
    const nextFence = nextClaimFence(this.claimFence);
    if (nextFence === null) return false;
    this.replaceClaim(previous, { ...previous, state: "replaced" });
    this.claimFence = nextFence;
    this.claimLeaseUntil = RENEWED_CLAIM_DEADLINE;
    const next = claimView(this.claimFence, 1, agentId, true, "active");
    this.claims.push(next);
    this.currentClaim = currentClaimView(this.claimFence, 1, agentId);
    this.revision += 1;
    this.refreshProjections();
    this.addSideEffect("event:task.reclaimed");
    this.addSideEffect(`schedule:claim.expiry:${this.claimFence}:1`);
    return true;
  }

  submit(agentId: AgentId, fence: number): boolean {
    const durable = this.activeClaim();
    const disposition = claimCommandDisposition({
      command: "submit",
      taskStatus: this.status,
      hasCurrentClaim: this.currentClaim !== null,
      ...(this.currentClaim === null
        ? {}
        : {
            currentAgentId: this.currentClaim.agentId,
            currentFence: this.currentClaim.fence,
            currentLeaseUntil: this.claimLeaseUntil,
          }),
      authorizedAgentId: agentId,
      requestedFence: fence,
      now: COMMAND_NOW,
    });
    if (
      durable === null ||
      !this.activeClaimTupleMatches() ||
      disposition.kind !== "allowed" ||
      this.unresolvedBlockerCount + this.cancelledBlockerCount !== 0 ||
      this.submissions.some((submission) => submission.status === "pending")
    ) {
      return false;
    }
    this.closeClaim(durable, "submitted");
    this.submissions.push({
      id: `sub_${this.submissions.length + 1}`,
      submittedByAgentId: agentId,
      reviewRevision: this.reviewRevision,
      status: "pending",
    });
    this.status = "in_review";
    this.revision += 1;
    this.refreshProjections();
    this.addSideEffect("event:task.submitted");
    return true;
  }

  cancel(expectedRevision: number): boolean {
    if (
      taskCancellationDisposition({
        currentRevision: this.revision,
        expectedRevision,
        status: this.status,
      }) !== "allowed"
    ) {
      return false;
    }
    const durable = this.activeClaim();
    if (durable !== null) this.closeClaim(durable, "released");
    const pending = this.submissions.find((submission) => submission.status === "pending");
    if (pending !== undefined) {
      const cancelled = transitionSubmissionLifecycle(pending.status, "cancel");
      if (cancelled === null) return false;
      this.replaceSubmission(pending, { ...pending, status: cancelled });
    }
    this.status = "cancelled";
    this.revision += 1;
    this.refreshProjections();
    this.addSideEffect("event:task.cancelled");
    return true;
  }

  transitionBlocker(next: Exclude<BlockerLifecycle, "done">): boolean {
    const counters = transitionBlockerCounters(
      {
        unresolved: this.unresolvedBlockerCount,
        cancelled: this.cancelledBlockerCount,
      },
      this.blockerStatus,
      next,
    );
    this.blockerStatus = next;
    this.unresolvedBlockerCount = counters.unresolved;
    this.cancelledBlockerCount = counters.cancelled;
    this.revision += 1;
    this.refreshProjections();
    this.addSideEffect("event:task.updated:blockers");
    return true;
  }

  acceptSubmission(reviewer: AgentId, expectedReviewRevision: number): boolean {
    const pending = this.submissions.filter((submission) => submission.status === "pending");
    const submission = pending.length === 1 ? pending[0] : undefined;
    if (
      this.status !== "in_review" ||
      this.currentClaim !== null ||
      submission === undefined ||
      submission.reviewRevision !== expectedReviewRevision ||
      this.reviewRevision !== expectedReviewRevision ||
      !reviewActorAllowed({
        submittedByAgentId: submission.submittedByAgentId,
        reviewerAgentId: reviewer,
      }) ||
      !reviewAcceptanceAllowed({
        action: "accept",
        blockingCount: this.unresolvedBlockerCount + this.cancelledBlockerCount,
      })
    ) {
      return false;
    }
    const accepted = transitionSubmissionLifecycle(submission.status, "accept");
    if (accepted === null) return false;
    this.replaceSubmission(submission, { ...submission, status: accepted });
    this.status = "done";
    this.revision += 1;
    this.refreshProjections();
    this.addSideEffect("event:task.reviewed:accepted");
    return true;
  }

  private deriveReady(): boolean {
    return derivedReady({
      status: this.status,
      availableAt: 0,
      now: 1,
      unresolved: this.unresolvedBlockerCount,
      cancelled: this.cancelledBlockerCount,
    });
  }

  private deriveNeedsAttention(): boolean {
    return derivedNeedsAttention({
      status: this.status,
      unresolved: this.unresolvedBlockerCount,
      cancelled: this.cancelledBlockerCount,
    });
  }

  private refreshProjections(): void {
    this.isReady = this.deriveReady();
    this.needsAttention = this.deriveNeedsAttention();
  }

  private activeClaim(): ClaimView | null {
    if (this.currentClaim === null) return null;
    return this.claims.find((claim) => claim.id === this.currentClaim?.id) ?? null;
  }

  private activeClaimTupleMatches(): boolean {
    const compact = this.currentClaim;
    const durable = this.activeClaim();
    if (compact === null || durable === null) return false;
    return activeTaskClaimTupleMatches({
      taskStatus: this.status,
      taskOrganizationId: "org_1",
      taskWorkspaceId: "wsp_1",
      taskId: "tsk_1",
      compactClaimId: compact.id,
      compactClaimPublicId: compact.id,
      compactAgentId: compact.agentId,
      compactAgentPublicId: compact.agentId,
      compactFence: compact.fence,
      compactLeaseGeneration: compact.leaseGeneration,
      compactLeaseUntil: this.claimLeaseUntil,
      claimId: durable.id,
      claimOrganizationId: "org_1",
      claimWorkspaceId: "wsp_1",
      claimTaskId: "tsk_1",
      claimPublicId: durable.id,
      claimAgentId: durable.agentId,
      claimAgentPublicId: durable.agentId,
      claimState: durable.state,
      claimFence: durable.fence,
      claimLeaseGeneration: durable.leaseGeneration,
      claimLeaseUntil: this.claimLeaseUntil,
    });
  }

  private closeClaim(claim: ClaimView, state: Exclude<ClaimState, "active">): void {
    this.replaceClaim(claim, { ...claim, live: false, state });
    this.currentClaim = null;
  }

  private replaceClaim(previous: ClaimView, next: ClaimView): void {
    const index = this.claims.findIndex((claim) => claim.id === previous.id);
    if (index < 0) throw new Error("Durable claim disappeared during a transaction.");
    this.claims[index] = next;
  }

  private replaceSubmission(previous: SubmissionView, next: SubmissionView): void {
    const index = this.submissions.findIndex((submission) => submission.id === previous.id);
    if (index < 0) throw new Error("Submission disappeared during a transaction.");
    this.submissions[index] = next;
  }

  private addSideEffect(effect: string): void {
    this.sideEffects.push(effect);
  }
}

function expectedRenewExpiry(
  args: ClaimInitialization & { readonly order: SerialOrder },
): { readonly outcome: PairOutcome; readonly snapshot: TaskRaceSnapshot } {
  if (args.order === "left_then_right") {
    const renewedGeneration = args.leaseGeneration + 1;
    return {
      outcome: { left: true, right: false },
      snapshot: {
        status: "in_progress",
        revision: args.revision + 1,
        reviewRevision: args.reviewRevision,
        claimFence: args.fence,
        currentClaim: currentClaimView(args.fence, renewedGeneration, "agt_alpha"),
        claims: [claimView(args.fence, renewedGeneration, "agt_alpha", true, "active")],
        submissions: [],
        blockerStatus: "done",
        unresolvedBlockerCount: 0,
        cancelledBlockerCount: 0,
        isReady: false,
        needsAttention: false,
        sideEffects: [
          "event:task.claim_renewed",
          `schedule:claim.expiry:${args.fence}:${renewedGeneration}`,
        ],
      },
    };
  }
  return {
    outcome: { left: false, right: true },
    snapshot: {
      status: "open",
      revision: args.revision + 1,
      reviewRevision: args.reviewRevision,
      claimFence: args.fence,
      currentClaim: null,
      claims: [claimView(args.fence, args.leaseGeneration, "agt_alpha", false, "expired")],
      submissions: [],
      blockerStatus: "done",
      unresolvedBlockerCount: 0,
      cancelledBlockerCount: 0,
      isReady: true,
      needsAttention: false,
      sideEffects: ["event:task.claim_expired"],
    },
  };
}

function expectedReclaimAfterStaleSubmit(
  args: ClaimInitialization,
): TaskRaceSnapshot {
  const nextFence = args.fence + 1;
  return {
    status: "in_progress",
    revision: args.revision + 1,
    reviewRevision: args.reviewRevision,
    claimFence: nextFence,
    currentClaim: currentClaimView(nextFence, 1, "agt_beta"),
    claims: [
      claimView(args.fence, args.leaseGeneration, "agt_alpha", false, "replaced"),
      claimView(nextFence, 1, "agt_beta", true, "active"),
    ],
    submissions: [],
    blockerStatus: "done",
    unresolvedBlockerCount: 0,
    cancelledBlockerCount: 0,
    isReady: false,
    needsAttention: false,
    sideEffects: [
      "event:task.reclaimed",
      `schedule:claim.expiry:${nextFence}:1`,
    ],
  };
}

function expectedCancelSubmit(
  args: ClaimInitialization & { readonly order: SerialOrder },
): { readonly outcome: PairOutcome; readonly snapshot: TaskRaceSnapshot } {
  if (args.order === "left_then_right") {
    return {
      outcome: { left: true, right: false },
      snapshot: {
        status: "cancelled",
        revision: args.revision + 1,
        reviewRevision: args.reviewRevision,
        claimFence: args.fence,
        currentClaim: null,
        claims: [claimView(args.fence, args.leaseGeneration, "agt_alpha", false, "released")],
        submissions: [],
        blockerStatus: "done",
        unresolvedBlockerCount: 0,
        cancelledBlockerCount: 0,
        isReady: false,
        needsAttention: false,
        sideEffects: ["event:task.cancelled"],
      },
    };
  }
  return {
    outcome: { left: false, right: true },
    snapshot: {
      status: "in_review",
      revision: args.revision + 1,
      reviewRevision: args.reviewRevision,
      claimFence: args.fence,
      currentClaim: null,
      claims: [claimView(args.fence, args.leaseGeneration, "agt_alpha", false, "submitted")],
      submissions: [
        {
          id: "sub_1",
          submittedByAgentId: "agt_alpha",
          reviewRevision: args.reviewRevision,
          status: "pending",
        },
      ],
      blockerStatus: "done",
      unresolvedBlockerCount: 0,
      cancelledBlockerCount: 0,
      isReady: false,
      needsAttention: false,
      sideEffects: ["event:task.submitted"],
    },
  };
}

function expectedBlockerAccept(args: {
  readonly order: SerialOrder;
  readonly revision: number;
  readonly reviewRevision: number;
  readonly blockerStatus: Exclude<BlockerLifecycle, "done">;
}): { readonly outcome: PairOutcome; readonly snapshot: TaskRaceSnapshot } {
  const unresolved = args.blockerStatus === "cancelled" ? 0 : 1;
  const cancelled = args.blockerStatus === "cancelled" ? 1 : 0;
  const acceptFirst = args.order === "right_then_left";
  return {
    outcome: { left: true, right: acceptFirst },
    snapshot: {
      status: acceptFirst ? "done" : "in_review",
      revision: args.revision + (acceptFirst ? 2 : 1),
      reviewRevision: args.reviewRevision,
      claimFence: 0,
      currentClaim: null,
      claims: [],
      submissions: [
        {
          id: "sub_1",
          submittedByAgentId: "agt_alpha",
          reviewRevision: args.reviewRevision,
          status: acceptFirst ? "accepted" : "pending",
        },
      ],
      blockerStatus: args.blockerStatus,
      unresolvedBlockerCount: unresolved,
      cancelledBlockerCount: cancelled,
      isReady: false,
      needsAttention: cancelled > 0 || (acceptFirst && unresolved > 0),
      sideEffects: acceptFirst
        ? ["event:task.reviewed:accepted", "event:task.updated:blockers"]
        : ["event:task.updated:blockers"],
    },
  };
}

interface ReceiptCommand {
  readonly operation: string;
  readonly key: string;
  readonly digest: string;
  readonly requestId: string;
  readonly responseRevision: number;
}

type ReceiptCommandResult =
  | { readonly kind: "applied" | "replay"; readonly responseRevision: number; readonly requestId: string }
  | { readonly kind: "conflict" };

interface ReceiptSnapshot {
  readonly receipts: readonly {
    readonly operation: string;
    readonly key: string;
    readonly digest: string;
    readonly requestId: string;
    readonly responseRevision: number;
  }[];
  readonly sideEffects: readonly {
    readonly operation: string;
    readonly key: string;
    readonly responseRevision: number;
  }[];
}

class SerializableReceiptSystem {
  private readonly receipts = new Map<
    string,
    {
      readonly command: ReceiptCommand;
      readonly digest: ArrayBuffer;
    }
  >();
  private readonly sideEffects: Array<{
    readonly operation: string;
    readonly key: string;
    readonly responseRevision: number;
  }> = [];

  execute(command: ReceiptCommand): ReceiptCommandResult {
    const locator = `${command.operation}\u0000${command.key}`;
    const existing = this.receipts.get(locator);
    if (existing !== undefined) {
      if (
        !commandReceiptMatches({
          storedOrganizationId: "org_1",
          storedWorkspaceId: "wsp_1",
          storedPrincipalKind: "agent",
          storedPrincipalId: "agt_alpha",
          storedOperation: existing.command.operation,
          storedIdempotencyKey: existing.command.key,
          storedRequestDigest: existing.digest,
          expectedOrganizationId: "org_1",
          expectedWorkspaceId: "wsp_1",
          expectedPrincipalKind: "agent",
          expectedPrincipalId: "agt_alpha",
          expectedOperation: command.operation,
          expectedIdempotencyKey: command.key,
          expectedRequestDigest: command.digest,
        })
      ) {
        return { kind: "conflict" };
      }
      return {
        kind: "replay",
        responseRevision: existing.command.responseRevision,
        requestId: existing.command.requestId,
      };
    }
    const digest = digestArrayBuffer(command.digest);
    if (digest === null) throw new Error("Generated request digest was not canonical.");
    this.sideEffects.push({
      operation: command.operation,
      key: command.key,
      responseRevision: command.responseRevision,
    });
    this.receipts.set(locator, { command, digest });
    return {
      kind: "applied",
      responseRevision: command.responseRevision,
      requestId: command.requestId,
    };
  }

  snapshot(): ReceiptSnapshot {
    return {
      receipts: [...this.receipts.values()].map(({ command, digest }) => ({
        operation: command.operation,
        key: command.key,
        digest: encodeDigest(digest),
        requestId: command.requestId,
        responseRevision: command.responseRevision,
      })),
      sideEffects: this.sideEffects.map((effect) => ({ ...effect })),
    };
  }
}

function digestForMarker(marker: number): string {
  const bytes = new Uint8Array(32);
  new DataView(bytes.buffer).setUint32(0, marker, false);
  return encodeDigest(bytes.buffer);
}

function expectedReceiptRace(
  order: SerialOrder,
  sameDigest: boolean,
  left: ReceiptCommand,
  right: ReceiptCommand,
): {
  readonly outcome: {
    readonly left: ReceiptCommandResult;
    readonly right: ReceiptCommandResult;
  };
  readonly snapshot: ReceiptSnapshot;
} {
  const first = order === "left_then_right" ? left : right;
  const applied = {
    kind: "applied" as const,
    responseRevision: first.responseRevision,
    requestId: first.requestId,
  };
  const later = sameDigest
    ? {
        kind: "replay" as const,
        responseRevision: first.responseRevision,
        requestId: first.requestId,
      }
    : { kind: "conflict" as const };
  return {
    outcome:
      order === "left_then_right"
        ? { left: applied, right: later }
        : { left: later, right: applied },
    snapshot: {
      receipts: [
        {
          operation: first.operation,
          key: first.key,
          digest: first.digest,
          requestId: first.requestId,
          responseRevision: first.responseRevision,
        },
      ],
      sideEffects: [
        {
          operation: first.operation,
          key: first.key,
          responseRevision: first.responseRevision,
        },
      ],
    },
  };
}

const orderArbitrary = fc.constantFrom<SerialOrder>("left_then_right", "right_then_left");
const revisionArbitrary = fc.integer({ min: 1, max: 1_000_000 });
const fenceArbitrary = fc.integer({ min: 1, max: 100_000 });
const generationArbitrary = fc.integer({ min: 1, max: 100_000 });
const reviewRevisionArbitrary = fc.integer({ min: 1, max: 1_000_000 });
const claimRaceArbitrary = fc.record({
  order: orderArbitrary,
  revision: revisionArbitrary,
  reviewRevision: reviewRevisionArbitrary,
  fence: fenceArbitrary,
  leaseGeneration: generationArbitrary,
});
const unresolvedBlockerArbitrary = fc.constantFrom<Exclude<BlockerLifecycle, "done">>(
  "open",
  "in_progress",
  "in_review",
  "cancelled",
);

describe("work graph serializable race properties", () => {
  test("an exhausted claim fence rejects reclaim before any durable side effect", () => {
    const system = SerializableTaskRaceSystem.withClaim({
      fence: Number.MAX_SAFE_INTEGER,
      leaseGeneration: 1,
      live: false,
      revision: 1,
      reviewRevision: 1,
    });
    const before = system.snapshot();

    expect(system.reclaim("agt_beta")).toBeFalse();
    expect(system.snapshot()).toEqual(before);
  });

  test("renewal and its stale scheduled expiry have exactly one serial winner", () => {
    assertProperty(
      fc.property(claimRaceArbitrary, (args) => {
        const system = SerializableTaskRaceSystem.withClaim({ ...args, live: true });
        const outcome = runSerializablePair(
          args.order,
          () => system.renew(args.fence),
          () =>
            system.expireScheduledClaim(
              claimId(args.fence),
              args.fence,
              args.leaseGeneration,
            ),
        );
        const expected = expectedRenewExpiry({ ...args, live: true });
        expect(outcome).toEqual(expected.outcome);
        expect(system.snapshot()).toEqual(expected.snapshot);
        expect(Number(outcome.left) + Number(outcome.right)).toBe(1);
        system.assertInvariants();
      }),
      { numRuns: 500 },
    );
  });

  test("a reclaim fences every stale submit in either serial order", () => {
    assertProperty(
      fc.property(claimRaceArbitrary, (args) => {
        const system = SerializableTaskRaceSystem.withClaim({ ...args, live: false });
        const outcome = runSerializablePair(
          args.order,
          () => system.reclaim("agt_beta"),
          () => system.submit("agt_alpha", args.fence),
        );
        expect(outcome).toEqual({ left: true, right: false });
        expect(system.snapshot()).toEqual(
          expectedReclaimAfterStaleSubmit({ ...args, live: false }),
        );
        expect(system.snapshot().claimFence).toBe(args.fence + 1);
        expect(system.snapshot().submissions).toHaveLength(0);
        system.assertInvariants();
      }),
      { numRuns: 500 },
    );
  });

  test("revision-checked cancellation and fenced submission cannot both commit", () => {
    assertProperty(
      fc.property(claimRaceArbitrary, (args) => {
        const system = SerializableTaskRaceSystem.withClaim({ ...args, live: true });
        const outcome = runSerializablePair(
          args.order,
          () => system.cancel(args.revision),
          () => system.submit("agt_alpha", args.fence),
        );
        const expected = expectedCancelSubmit({ ...args, live: true });
        expect(outcome).toEqual(expected.outcome);
        expect(system.snapshot()).toEqual(expected.snapshot);
        expect(Number(outcome.left) + Number(outcome.right)).toBe(1);
        system.assertInvariants();
      }),
      { numRuns: 500 },
    );
  });

  test("blocker propagation either prevents acceptance or follows an immutable acceptance", () => {
    assertProperty(
      fc.property(
        fc.record({
          order: orderArbitrary,
          revision: revisionArbitrary,
          reviewRevision: reviewRevisionArbitrary,
          blockerStatus: unresolvedBlockerArbitrary,
        }),
        (args) => {
          const system = SerializableTaskRaceSystem.inReview(args);
          const outcome = runSerializablePair(
            args.order,
            () => system.transitionBlocker(args.blockerStatus),
            () => system.acceptSubmission("agt_beta", args.reviewRevision),
          );
          const expected = expectedBlockerAccept(args);
          expect(outcome).toEqual(expected.outcome);
          expect(system.snapshot()).toEqual(expected.snapshot);
          if (outcome.right) {
            expect(system.snapshot().submissions[0]?.status).toBe("accepted");
          }
          system.assertInvariants();
        },
      ),
      { numRuns: 500 },
    );
  });

  test("one idempotency key replays one digest and conflicts with every other digest", () => {
    assertProperty(
      fc.property(
        fc.record({
          order: orderArbitrary,
          sameDigest: fc.boolean(),
          digestMarker: fc.integer({ min: 0, max: 0xffff_fffe }),
          keyMarker: fc.integer({ min: 0, max: 1_000_000 }),
          responseRevision: fc.integer({ min: 1, max: 999_999 }),
        }),
        (args) => {
          const firstDigest = digestForMarker(args.digestMarker);
          const secondDigest = args.sameDigest
            ? firstDigest
            : digestForMarker(args.digestMarker + 1);
          const left: ReceiptCommand = {
            operation: "tasks.submit",
            key: `idem_${args.keyMarker}`,
            digest: firstDigest,
            requestId: "req_left",
            responseRevision: args.responseRevision,
          };
          const right: ReceiptCommand = {
            operation: left.operation,
            key: left.key,
            digest: secondDigest,
            requestId: "req_right",
            responseRevision: args.sameDigest
              ? args.responseRevision
              : args.responseRevision + 1,
          };
          const system = new SerializableReceiptSystem();
          let outcome: { left: ReceiptCommandResult; right: ReceiptCommandResult };
          if (args.order === "left_then_right") {
            const leftResult = system.execute(left);
            const rightResult = system.execute(right);
            outcome = { left: leftResult, right: rightResult };
          } else {
            const rightResult = system.execute(right);
            const leftResult = system.execute(left);
            outcome = { left: leftResult, right: rightResult };
          }
          const expected = expectedReceiptRace(
            args.order,
            args.sameDigest,
            left,
            right,
          );
          expect(outcome).toEqual(expected.outcome);
          expect(system.snapshot()).toEqual(expected.snapshot);
          expect(system.snapshot().receipts).toHaveLength(1);
          expect(system.snapshot().sideEffects).toHaveLength(1);
        },
      ),
      { numRuns: 500 },
    );
  });
});
