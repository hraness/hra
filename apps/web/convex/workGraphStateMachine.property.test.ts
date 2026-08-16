import { describe, expect, test } from "bun:test";
import { assertProperty, fc, type Command } from "@hra-internal/test";

import {
  activeTaskClaimTupleMatches,
  derivedNeedsAttention,
  derivedReady,
  reviewActorAllowed,
  transitionBlockerCounters,
  transitionSubmissionLifecycle,
  type BlockerLifecycle,
  type SubmissionLifecycle,
} from "./workGraphLaws";

type AgentId = "agt_alpha" | "agt_beta";
type ReviewActor = AgentId | "human";
type CurrentOrStale = "current" | "stale";
type ReviewReference = "current" | "stale_revision" | "stale_submission";

interface ClaimSnapshot {
  readonly id: string;
  readonly agentId: AgentId;
  readonly fence: number;
  readonly leaseGeneration: number;
}

interface SubmissionSnapshot {
  readonly id: string;
  readonly submittedByAgentId: AgentId;
  readonly reviewRevision: number;
  readonly status: SubmissionLifecycle;
}

interface LifecycleSnapshot {
  readonly status: BlockerLifecycle;
  readonly revision: number;
  readonly reviewRevision: number;
  readonly claimFence: number;
  readonly claim: ClaimSnapshot | null;
  readonly submissions: readonly SubmissionSnapshot[];
  readonly blockerStatus: BlockerLifecycle;
  readonly unresolvedBlockerCount: number;
  readonly cancelledBlockerCount: number;
  readonly isReady: boolean;
  readonly needsAttention: boolean;
}

interface ReferenceModel {
  status: BlockerLifecycle;
  revision: number;
  reviewRevision: number;
  claimFence: number;
  claim: ClaimSnapshot | null;
  submissions: SubmissionSnapshot[];
  blockerStatus: BlockerLifecycle;
  unresolvedBlockerCount: number;
  cancelledBlockerCount: number;
}

type CommandSpec =
  | { readonly kind: "claim"; readonly actor: AgentId }
  | {
      readonly kind: "renew" | "release" | "submit";
      readonly actor: AgentId;
      readonly fence: CurrentOrStale;
    }
  | { readonly kind: "expire"; readonly lease: CurrentOrStale }
  | {
      readonly kind: "review";
      readonly actor: ReviewActor;
      readonly action: "accept" | "reject";
      readonly reference: ReviewReference;
    }
  | { readonly kind: "cancel" | "reopen"; readonly revision: CurrentOrStale }
  | { readonly kind: "blocker"; readonly next: BlockerLifecycle };

type MaterializedCommand =
  | { readonly kind: "claim"; readonly actor: AgentId }
  | {
      readonly kind: "renew" | "release" | "submit";
      readonly actor: AgentId;
      readonly fence: number;
    }
  | { readonly kind: "expire"; readonly fence: number; readonly leaseGeneration: number }
  | {
      readonly kind: "review";
      readonly actor: ReviewActor;
      readonly action: "accept" | "reject";
      readonly submissionId: string;
      readonly reviewRevision: number;
    }
  | { readonly kind: "cancel" | "reopen"; readonly revision: number }
  | { readonly kind: "blocker"; readonly next: BlockerLifecycle };

function initialReferenceModel(): ReferenceModel {
  return {
    status: "open",
    revision: 1,
    reviewRevision: 1,
    claimFence: 0,
    claim: null,
    submissions: [],
    blockerStatus: "done",
    unresolvedBlockerCount: 0,
    cancelledBlockerCount: 0,
  };
}

function isReadyWithoutProductionCode(model: ReferenceModel): boolean {
  return (
    model.status === "open" &&
    model.unresolvedBlockerCount === 0 &&
    model.cancelledBlockerCount === 0
  );
}

function needsAttentionWithoutProductionCode(model: ReferenceModel): boolean {
  return (
    model.cancelledBlockerCount > 0 ||
    (model.status === "done" && model.unresolvedBlockerCount > 0)
  );
}

function referenceSnapshot(model: ReferenceModel): LifecycleSnapshot {
  return {
    status: model.status,
    revision: model.revision,
    reviewRevision: model.reviewRevision,
    claimFence: model.claimFence,
    claim: model.claim === null ? null : { ...model.claim },
    submissions: model.submissions.map((submission) => ({ ...submission })),
    blockerStatus: model.blockerStatus,
    unresolvedBlockerCount: model.unresolvedBlockerCount,
    cancelledBlockerCount: model.cancelledBlockerCount,
    isReady: isReadyWithoutProductionCode(model),
    needsAttention: needsAttentionWithoutProductionCode(model),
  };
}

function pendingSubmission(model: ReferenceModel): SubmissionSnapshot | null {
  const pending = model.submissions.filter((submission) => submission.status === "pending");
  return pending.length === 1 ? (pending[0] ?? null) : null;
}

function staleNumber(current: number): number {
  return current === 0 ? 1 : current - 1;
}

function materialize(model: ReferenceModel, command: CommandSpec): MaterializedCommand {
  if (command.kind === "claim" || command.kind === "blocker") return command;
  if (command.kind === "renew" || command.kind === "release" || command.kind === "submit") {
    const currentFence = model.claim?.fence ?? model.claimFence;
    return {
      kind: command.kind,
      actor: command.actor,
      fence: command.fence === "current" ? currentFence : staleNumber(currentFence),
    };
  }
  if (command.kind === "expire") {
    const currentFence = model.claim?.fence ?? model.claimFence;
    const currentGeneration = model.claim?.leaseGeneration ?? 0;
    return {
      kind: "expire",
      fence: currentFence,
      leaseGeneration:
        command.lease === "current" ? currentGeneration : staleNumber(currentGeneration),
    };
  }
  if (command.kind === "review") {
    const submission = pendingSubmission(model);
    return {
      kind: "review",
      actor: command.actor,
      action: command.action,
      submissionId:
        command.reference === "stale_submission"
          ? "sub_stale"
          : (submission?.id ?? "sub_missing"),
      reviewRevision:
        command.reference === "stale_revision"
          ? staleNumber(model.reviewRevision)
          : model.reviewRevision,
    };
  }
  if ("revision" in command) {
    return {
      kind: command.kind,
      revision:
        command.revision === "current" ? model.revision : staleNumber(model.revision),
    };
  }
  throw new Error(`Unhandled command: ${JSON.stringify(command)}`);
}

function setReferenceBlockerCounters(model: ReferenceModel, next: BlockerLifecycle): void {
  model.unresolvedBlockerCount = next === "done" || next === "cancelled" ? 0 : 1;
  model.cancelledBlockerCount = next === "cancelled" ? 1 : 0;
}

/** Independent executable specification: intentionally does not call production law helpers. */
function applyReference(model: ReferenceModel, command: MaterializedCommand): boolean {
  if (command.kind === "blocker") {
    if (model.blockerStatus === command.next) return false;
    model.blockerStatus = command.next;
    setReferenceBlockerCounters(model, command.next);
    model.revision += 1;
    return true;
  }

  if (command.kind === "claim") {
    if (!isReadyWithoutProductionCode(model)) return false;
    model.claimFence += 1;
    model.claim = {
      id: `clm_${model.claimFence}`,
      agentId: command.actor,
      fence: model.claimFence,
      leaseGeneration: 1,
    };
    model.status = "in_progress";
    model.revision += 1;
    return true;
  }

  if (command.kind === "renew" || command.kind === "release" || command.kind === "submit") {
    const claim = model.claim;
    if (
      model.status !== "in_progress" ||
      claim === null ||
      claim.agentId !== command.actor ||
      claim.fence !== command.fence
    ) {
      return false;
    }
    if (command.kind === "renew") {
      model.claim = { ...claim, leaseGeneration: claim.leaseGeneration + 1 };
    } else if (command.kind === "release") {
      model.claim = null;
      model.status = "open";
    } else {
      if (model.unresolvedBlockerCount + model.cancelledBlockerCount > 0) return false;
      model.submissions.push({
        id: `sub_${model.submissions.length + 1}`,
        submittedByAgentId: command.actor,
        reviewRevision: model.reviewRevision,
        status: "pending",
      });
      model.claim = null;
      model.status = "in_review";
    }
    model.revision += 1;
    return true;
  }

  if (command.kind === "expire") {
    const claim = model.claim;
    if (
      model.status !== "in_progress" ||
      claim === null ||
      claim.fence !== command.fence ||
      claim.leaseGeneration !== command.leaseGeneration
    ) {
      return false;
    }
    model.claim = null;
    model.status = "open";
    model.revision += 1;
    return true;
  }

  if (command.kind === "review") {
    const submission = pendingSubmission(model);
    if (
      model.status !== "in_review" ||
      model.claim !== null ||
      submission === null ||
      submission.id !== command.submissionId ||
      submission.reviewRevision !== command.reviewRevision ||
      model.reviewRevision !== command.reviewRevision ||
      (command.actor !== "human" && command.actor === submission.submittedByAgentId) ||
      (command.action === "accept" &&
        model.unresolvedBlockerCount + model.cancelledBlockerCount > 0)
    ) {
      return false;
    }
    const index = model.submissions.findIndex((candidate) => candidate.id === submission.id);
    model.submissions[index] = {
      ...submission,
      status: command.action === "accept" ? "accepted" : "rejected",
    };
    model.status = command.action === "accept" ? "done" : "open";
    model.revision += 1;
    return true;
  }

  if ("revision" in command && command.kind === "cancel") {
    if (
      model.revision !== command.revision ||
      model.status === "done" ||
      model.status === "cancelled"
    ) {
      return false;
    }
    const submission = pendingSubmission(model);
    if (submission !== null) {
      const index = model.submissions.findIndex((candidate) => candidate.id === submission.id);
      model.submissions[index] = { ...submission, status: "cancelled" };
    }
    model.claim = null;
    model.status = "cancelled";
    model.revision += 1;
    return true;
  }

  if ("revision" in command) {
    if (
      model.revision !== command.revision ||
      (model.status !== "done" && model.status !== "cancelled")
    ) {
      return false;
    }
    model.claim = null;
    model.status = "open";
    model.revision += 1;
    return true;
  }
  throw new Error(`Unhandled command: ${JSON.stringify(command)}`);
}

type ClaimRecordState = "active" | "released" | "expired" | "submitted";

interface ClaimRecord {
  readonly id: string;
  readonly agentId: AgentId;
  readonly fence: number;
  leaseGeneration: number;
  readonly publicId: string;
  readonly agentPublicId: AgentId;
  state: ClaimRecordState;
}

/** In-memory system under test composed from the same pure laws used by Convex mutations. */
class CoordinationSystem {
  private status: BlockerLifecycle = "open";
  private revision = 1;
  private readonly reviewRevision = 1;
  private claimFence = 0;
  private currentClaim: ClaimSnapshot | null = null;
  private readonly claims: ClaimRecord[] = [];
  private readonly submissions: SubmissionSnapshot[] = [];
  private blockerStatus: BlockerLifecycle = "done";
  private unresolvedBlockerCount = 0;
  private cancelledBlockerCount = 0;
  private isReady = true;
  private needsAttention = false;

  snapshot(): LifecycleSnapshot {
    return {
      status: this.status,
      revision: this.revision,
      reviewRevision: this.reviewRevision,
      claimFence: this.claimFence,
      claim: this.currentClaim === null ? null : { ...this.currentClaim },
      submissions: this.submissions.map((submission) => ({ ...submission })),
      blockerStatus: this.blockerStatus,
      unresolvedBlockerCount: this.unresolvedBlockerCount,
      cancelledBlockerCount: this.cancelledBlockerCount,
      isReady: this.isReady,
      needsAttention: this.needsAttention,
    };
  }

  terminalSubmissions(): readonly SubmissionSnapshot[] {
    return this.submissions
      .filter((submission) => submission.status !== "pending")
      .map((submission) => ({ ...submission }));
  }

  assertInvariants(): void {
    const activeClaims = this.claims.filter((claim) => claim.state === "active");
    const pending = this.submissions.filter((submission) => submission.status === "pending");
    expect(this.currentClaim !== null).toBe(this.status === "in_progress");
    expect(activeClaims.length).toBe(this.currentClaim === null ? 0 : 1);
    expect(pending.length).toBe(this.status === "in_review" ? 1 : 0);
    expect(this.status === "in_review" && this.currentClaim !== null).toBeFalse();
    expect(this.claimFence).toBe(this.claims.length);
    expect(this.claims.map((claim) => claim.fence)).toEqual(
      Array.from({ length: this.claimFence }, (_, index) => index + 1),
    );
    expect(this.isReady).toBe(
      derivedReady({
        status: this.status,
        availableAt: 0,
        now: 1,
        unresolved: this.unresolvedBlockerCount,
        cancelled: this.cancelledBlockerCount,
      }),
    );
    expect(this.needsAttention).toBe(
      derivedNeedsAttention({
        status: this.status,
        unresolved: this.unresolvedBlockerCount,
        cancelled: this.cancelledBlockerCount,
      }),
    );
    if (this.currentClaim !== null) expect(this.activeClaimTupleMatches()).toBeTrue();
  }

  apply(command: MaterializedCommand): boolean {
    if (command.kind === "blocker") return this.transitionBlocker(command.next);
    if (command.kind === "claim") return this.claim(command.actor);
    if (command.kind === "expire") {
      return this.expire(command.fence, command.leaseGeneration);
    }
    if (command.kind === "review") return this.review(command);
    if ("revision" in command) {
      return command.kind === "cancel"
        ? this.cancel(command.revision)
        : this.reopen(command.revision);
    }
    if (!("actor" in command) || !("fence" in command)) {
      throw new Error(`Unhandled command: ${JSON.stringify(command)}`);
    }
    if (!this.claimOwnedBy(command.actor, command.fence)) return false;
    if (command.kind === "renew") return this.renew();
    if (command.kind === "release") return this.release();
    return this.submit(command.actor);
  }

  private refreshDerivedProjections(): void {
    this.isReady = derivedReady({
      status: this.status,
      availableAt: 0,
      now: 1,
      unresolved: this.unresolvedBlockerCount,
      cancelled: this.cancelledBlockerCount,
    });
    this.needsAttention = derivedNeedsAttention({
      status: this.status,
      unresolved: this.unresolvedBlockerCount,
      cancelled: this.cancelledBlockerCount,
    });
  }

  private activeClaimRecord(): ClaimRecord | null {
    if (this.currentClaim === null) return null;
    return this.claims.find((claim) => claim.id === this.currentClaim?.id) ?? null;
  }

  private activeClaimTupleMatches(): boolean {
    const compact = this.currentClaim;
    const durable = this.activeClaimRecord();
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
      compactLeaseUntil: compact.leaseGeneration,
      claimId: durable.id,
      claimOrganizationId: "org_1",
      claimWorkspaceId: "wsp_1",
      claimTaskId: "tsk_1",
      claimPublicId: durable.publicId,
      claimAgentId: durable.agentId,
      claimAgentPublicId: durable.agentPublicId,
      claimState: durable.state,
      claimFence: durable.fence,
      claimLeaseGeneration: durable.leaseGeneration,
      claimLeaseUntil: durable.leaseGeneration,
    });
  }

  private claimOwnedBy(actor: AgentId, fence: number): boolean {
    return (
      this.activeClaimTupleMatches() &&
      this.currentClaim?.agentId === actor &&
      this.currentClaim.fence === fence
    );
  }

  private closeClaim(state: Exclude<ClaimRecordState, "active">): void {
    const durable = this.activeClaimRecord();
    if (durable === null) throw new Error("Active claim projection disappeared.");
    durable.state = state;
    this.currentClaim = null;
  }

  private claim(actor: AgentId): boolean {
    if (!this.isReady) return false;
    this.claimFence += 1;
    const claim: ClaimRecord = {
      id: `clm_${this.claimFence}`,
      publicId: `clm_${this.claimFence}`,
      agentId: actor,
      agentPublicId: actor,
      fence: this.claimFence,
      leaseGeneration: 1,
      state: "active",
    };
    this.claims.push(claim);
    this.currentClaim = {
      id: claim.id,
      agentId: claim.agentId,
      fence: claim.fence,
      leaseGeneration: claim.leaseGeneration,
    };
    this.status = "in_progress";
    this.revision += 1;
    this.refreshDerivedProjections();
    return true;
  }

  private renew(): boolean {
    const durable = this.activeClaimRecord();
    if (durable === null || this.currentClaim === null) return false;
    const leaseGeneration = durable.leaseGeneration + 1;
    durable.leaseGeneration = leaseGeneration;
    this.currentClaim = { ...this.currentClaim, leaseGeneration };
    this.revision += 1;
    return true;
  }

  private release(): boolean {
    this.closeClaim("released");
    this.status = "open";
    this.revision += 1;
    this.refreshDerivedProjections();
    return true;
  }

  private expire(fence: number, leaseGeneration: number): boolean {
    if (
      !this.activeClaimTupleMatches() ||
      this.currentClaim?.fence !== fence ||
      this.currentClaim.leaseGeneration !== leaseGeneration
    ) {
      return false;
    }
    this.closeClaim("expired");
    this.status = "open";
    this.revision += 1;
    this.refreshDerivedProjections();
    return true;
  }

  private submit(actor: AgentId): boolean {
    if (this.unresolvedBlockerCount + this.cancelledBlockerCount > 0) return false;
    this.closeClaim("submitted");
    this.submissions.push({
      id: `sub_${this.submissions.length + 1}`,
      submittedByAgentId: actor,
      reviewRevision: this.reviewRevision,
      status: "pending",
    });
    this.status = "in_review";
    this.revision += 1;
    this.refreshDerivedProjections();
    return true;
  }

  private review(command: Extract<MaterializedCommand, { readonly kind: "review" }>): boolean {
    const pending = this.submissions.filter((submission) => submission.status === "pending");
    const submission = pending.length === 1 ? pending[0] : undefined;
    if (
      this.status !== "in_review" ||
      this.currentClaim !== null ||
      submission === undefined ||
      submission.id !== command.submissionId ||
      submission.reviewRevision !== command.reviewRevision ||
      this.reviewRevision !== command.reviewRevision ||
      !reviewActorAllowed({
        submittedByAgentId: submission.submittedByAgentId,
        ...(command.actor === "human" ? {} : { reviewerAgentId: command.actor }),
      }) ||
      (command.action === "accept" &&
        this.unresolvedBlockerCount + this.cancelledBlockerCount > 0)
    ) {
      return false;
    }
    const next = transitionSubmissionLifecycle(submission.status, command.action);
    if (next === null) return false;
    const index = this.submissions.findIndex((candidate) => candidate.id === submission.id);
    this.submissions[index] = { ...submission, status: next };
    this.status = command.action === "accept" ? "done" : "open";
    this.revision += 1;
    this.refreshDerivedProjections();
    return true;
  }

  private cancel(revision: number): boolean {
    if (this.revision !== revision || this.status === "done" || this.status === "cancelled") {
      return false;
    }
    if (this.currentClaim !== null) this.closeClaim("released");
    const pending = this.submissions.find((submission) => submission.status === "pending");
    if (pending !== undefined) {
      const next = transitionSubmissionLifecycle(pending.status, "cancel");
      if (next === null) return false;
      const index = this.submissions.findIndex((candidate) => candidate.id === pending.id);
      this.submissions[index] = { ...pending, status: next };
    }
    this.status = "cancelled";
    this.revision += 1;
    this.refreshDerivedProjections();
    return true;
  }

  private reopen(revision: number): boolean {
    if (
      this.revision !== revision ||
      (this.status !== "done" && this.status !== "cancelled")
    ) {
      return false;
    }
    this.currentClaim = null;
    this.status = "open";
    this.revision += 1;
    this.refreshDerivedProjections();
    return true;
  }

  private transitionBlocker(next: BlockerLifecycle): boolean {
    if (this.blockerStatus === next) return false;
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
    this.refreshDerivedProjections();
    return true;
  }
}

class LifecycleCommand implements Command<ReferenceModel, CoordinationSystem> {
  private readonly command: CommandSpec;

  constructor(command: CommandSpec) {
    this.command = command;
  }

  check(): boolean {
    return true;
  }

  run(model: ReferenceModel, system: CoordinationSystem): void {
    const materialized = materialize(model, this.command);
    const systemBefore = system.snapshot();
    const terminalSubmissionsBefore = system.terminalSubmissions();
    const expectedApplied = applyReference(model, materialized);
    const actualApplied = system.apply(materialized);

    expect(actualApplied).toBe(expectedApplied);
    expect(system.snapshot()).toEqual(referenceSnapshot(model));
    if (!expectedApplied) expect(system.snapshot()).toEqual(systemBefore);
    const terminalSubmissionsAfter = system.terminalSubmissions();
    for (const terminalSubmission of terminalSubmissionsBefore) {
      expect(
        terminalSubmissionsAfter.find(
          (candidate) => candidate.id === terminalSubmission.id,
        ),
      ).toEqual(terminalSubmission);
    }
    system.assertInvariants();
  }

  toString(): string {
    return JSON.stringify(this.command);
  }
}

const agentArbitrary = fc.constantFrom<AgentId>("agt_alpha", "agt_beta");
const reviewActorArbitrary = fc.constantFrom<ReviewActor>("agt_alpha", "agt_beta", "human");
const currentOrStaleArbitrary = fc.constantFrom<CurrentOrStale>("current", "stale");
const blockerLifecycleArbitrary = fc.constantFrom<BlockerLifecycle>(
  "open",
  "in_progress",
  "in_review",
  "done",
  "cancelled",
);

const claimCommand = agentArbitrary.map(
  (actor) => new LifecycleCommand({ kind: "claim", actor }),
);
const claimBoundCommand = fc
  .record({
    kind: fc.constantFrom<"renew" | "release" | "submit">("renew", "release", "submit"),
    actor: agentArbitrary,
    fence: currentOrStaleArbitrary,
  })
  .map((command) => new LifecycleCommand(command));
const expireCommand = currentOrStaleArbitrary.map(
  (lease) => new LifecycleCommand({ kind: "expire", lease }),
);
const reviewCommand = fc
  .record({
    actor: reviewActorArbitrary,
    action: fc.constantFrom<"accept" | "reject">("accept", "reject"),
    reference: fc.constantFrom<ReviewReference>(
      "current",
      "stale_revision",
      "stale_submission",
    ),
  })
  .map((command) => new LifecycleCommand({ kind: "review", ...command }));
const terminalCommand = fc
  .record({
    kind: fc.constantFrom<"cancel" | "reopen">("cancel", "reopen"),
    revision: currentOrStaleArbitrary,
  })
  .map((command) => new LifecycleCommand(command));
const blockerCommand = blockerLifecycleArbitrary.map(
  (next) => new LifecycleCommand({ kind: "blocker", next }),
);

const lifecycleCommandArbitrary = fc.oneof(
  claimCommand,
  claimCommand,
  claimBoundCommand,
  claimBoundCommand,
  reviewCommand,
  reviewCommand,
  terminalCommand,
  terminalCommand,
  blockerCommand,
  expireCommand,
);

describe("work graph lifecycle state machine properties", () => {
  test("arbitrary task, claim, blocker, and review command walks preserve every projection", () => {
    assertProperty(
      fc.property(
        fc.commands([lifecycleCommandArbitrary], { maxCommands: 100 }),
        (commands) => {
          fc.modelRun(
            () => ({ model: initialReferenceModel(), real: new CoordinationSystem() }),
            commands,
          );
        },
      ),
      { numRuns: 300 },
    );
  });
});
