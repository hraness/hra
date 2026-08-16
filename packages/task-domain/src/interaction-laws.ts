export const MAX_RUN_INTERACTIONS_PER_RUN = 128;

export type DurableRunInteractionState = "pending" | "answered" | "resolved" | "expired";
export type RunInteractionSettlementDisposition = "apply" | "replay" | "reject";
export type RunInteractionAdmissionDisposition = "accept" | "terminal_limit";
export type RunInteractionOpenAdmissionDisposition = "accept" | "capacity_full";
export type RunInteractionSettlement =
  | Readonly<{
      interactionId: string;
      responseRevision: number;
      outcome: "applied";
    }>
  | Readonly<{
      interactionId: string;
      responseRevision?: number | undefined;
      outcome: "expired";
      reason: "local_deadline" | "provider_expired" | "cloud_expired";
    }>;

export type RunInteractionBatchAdmissionPlan =
  | Readonly<{
      kind: "accept";
      lifetimeInteractionCount: number;
      openInteractionCount: number;
    }>
  | Readonly<{ kind: "capacity_full" | "invalid" | "terminal_limit" }>;

export interface RunInteractionDeliveryProjection {
  readonly authority: Readonly<{
    workspaceId: string;
    runnerId: string;
    bootId: string;
    bootGeneration: number;
    claimId: string;
    claimFence: number;
  }>;
  readonly reply: Readonly<{
    keyId: string;
    runnerId: string;
    bootId: string;
    bootGeneration: number;
    claimId: string;
    claimFence: number;
  }>;
  readonly sealed: Readonly<{ workspaceId: string; keyId: string }>;
}

export function runInteractionDeliveryProjectionMatches(
  input: RunInteractionDeliveryProjection,
): boolean {
  return input.sealed.workspaceId === input.authority.workspaceId &&
    input.sealed.keyId === input.reply.keyId &&
    input.reply.runnerId === input.authority.runnerId &&
    input.reply.bootId === input.authority.bootId &&
    input.reply.bootGeneration === input.authority.bootGeneration &&
    input.reply.claimId === input.authority.claimId &&
    input.reply.claimFence === input.authority.claimFence;
}

export function boundedRunInteractionPage<Value>(
  orderedValues: readonly Value[],
  limit: number,
): Readonly<{ items: readonly Value[]; hasMore: boolean }> {
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new TypeError("Interaction page limit must be positive");
  }
  return {
    items: orderedValues.slice(0, limit),
    hasMore: orderedValues.length > limit,
  };
}

export function pendingExpiredInteractionPage<Value extends Readonly<{
  settlementAcknowledgedAt?: number;
}>>(
  orderedValues: readonly Value[],
  limit: number,
): readonly Value[] {
  return orderedValues
    .filter(({ settlementAcknowledgedAt }) => settlementAcknowledgedAt === undefined)
    .slice(0, limit);
}

export function runInteractionAdmissionDisposition(
  lifetimeInteractionCount: number,
): RunInteractionAdmissionDisposition {
  return Number.isSafeInteger(lifetimeInteractionCount) &&
      lifetimeInteractionCount >= 0 &&
      lifetimeInteractionCount < MAX_RUN_INTERACTIONS_PER_RUN
    ? "accept"
    : "terminal_limit";
}

export function openInteractionCountAfterSettlement(
  openInteractionCount: number,
  durableState: DurableRunInteractionState,
  disposition: RunInteractionSettlementDisposition,
): number {
  if (!Number.isSafeInteger(openInteractionCount) || openInteractionCount < 0) {
    throw new TypeError("Open interaction count must be a non-negative integer");
  }
  const closesOpen = disposition === "apply" &&
    (durableState === "pending" || durableState === "answered");
  if (!closesOpen) return openInteractionCount;
  if (openInteractionCount === 0) {
    throw new TypeError("Settlement underflowed open interactions");
  }
  return openInteractionCount - 1;
}

export function runInteractionOpenAdmissionDisposition(
  openInteractionCount: number,
  maximumOpenInteractions: number,
): RunInteractionOpenAdmissionDisposition {
  if (
    !Number.isSafeInteger(openInteractionCount) ||
    openInteractionCount < 0 ||
    !Number.isSafeInteger(maximumOpenInteractions) ||
    maximumOpenInteractions < 1
  ) return "capacity_full";
  return openInteractionCount < maximumOpenInteractions ? "accept" : "capacity_full";
}

export function planRunInteractionBatchAdmission(input: Readonly<{
  lifetimeInteractionCount: number;
  maximumOpenInteractions: number;
  newInteractionStates: readonly ("pending" | "expired")[];
  openInteractionCount: number;
  settlements: readonly Readonly<{
    disposition: RunInteractionSettlementDisposition;
    durableState: DurableRunInteractionState;
  }>[];
}>): RunInteractionBatchAdmissionPlan {
  if (
    !Number.isSafeInteger(input.lifetimeInteractionCount) ||
    input.lifetimeInteractionCount < 0 ||
    !Number.isSafeInteger(input.openInteractionCount) ||
    input.openInteractionCount < 0 ||
    !Number.isSafeInteger(input.maximumOpenInteractions) ||
    input.maximumOpenInteractions < 1 ||
    input.settlements.some(({ disposition }) => disposition === "reject")
  ) return { kind: "invalid" };

  const closedOpenInteractions = input.settlements.filter(
    ({ disposition, durableState }) => disposition === "apply" &&
      (durableState === "pending" || durableState === "answered"),
  ).length;
  if (closedOpenInteractions > input.openInteractionCount) return { kind: "invalid" };

  const lifetimeInteractionCount =
    input.lifetimeInteractionCount + input.newInteractionStates.length;
  if (lifetimeInteractionCount > MAX_RUN_INTERACTIONS_PER_RUN) {
    return { kind: "terminal_limit" };
  }
  const openInteractionCount = input.openInteractionCount - closedOpenInteractions +
    input.newInteractionStates.filter((state) => state === "pending").length;
  if (openInteractionCount > input.maximumOpenInteractions) {
    return { kind: "capacity_full" };
  }
  return { kind: "accept", lifetimeInteractionCount, openInteractionCount };
}

export function runInteractionResponseProjectionMatches(input: Readonly<{
  durableResponseRevision?: number;
  durableState: DurableRunInteractionState;
  responseRevisions: readonly number[];
}>): boolean {
  const durableRevisionIsValid = input.durableResponseRevision === undefined ||
    (Number.isSafeInteger(input.durableResponseRevision) && input.durableResponseRevision > 0);
  if (
    !durableRevisionIsValid ||
    input.responseRevisions.some((revision) => !Number.isSafeInteger(revision) || revision < 1)
  ) return false;
  if (input.durableState === "answered") {
    return input.durableResponseRevision !== undefined &&
      input.responseRevisions.length === 1 &&
      input.responseRevisions[0] === input.durableResponseRevision;
  }
  return input.responseRevisions.length === 0 &&
    (input.durableState === "pending" ? input.durableResponseRevision === undefined : true);
}

export function runInteractionSettlementDisposition(input: Readonly<{
  durableResponseRevision?: number;
  durableState: DurableRunInteractionState;
  settlement: RunInteractionSettlement;
}>): RunInteractionSettlementDisposition {
  const revisionMatches = input.durableResponseRevision === input.settlement.responseRevision;
  if (input.settlement.outcome === "applied") {
    if (!revisionMatches) return "reject";
    if (input.durableState === "answered") return "apply";
    if (input.durableState === "expired" && input.durableResponseRevision !== undefined) {
      return "apply";
    }
    return input.durableState === "resolved" ? "replay" : "reject";
  }
  if (input.durableState === "resolved") return "reject";
  if (input.durableState === "pending") {
    return input.settlement.responseRevision === undefined ? "apply" : "reject";
  }
  if (
    input.settlement.responseRevision !== undefined &&
    input.settlement.responseRevision !== input.durableResponseRevision
  ) return "reject";
  if (input.durableState === "answered") return "apply";
  return input.durableState === "expired" ? "replay" : "reject";
}
