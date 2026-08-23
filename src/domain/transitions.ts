import { z } from "zod";

export const mutationStateSchema = z.enum([
  "prepared",
  "effect_started",
  "applied",
  "failed",
  "ambiguous",
  "cancelled",
  "reconciled",
]);
export type MutationState = z.infer<typeof mutationStateSchema>;

const legalMutationTransitions: Readonly<Record<MutationState, readonly MutationState[]>> = {
  prepared: ["effect_started", "cancelled"],
  effect_started: ["applied", "failed", "ambiguous"],
  applied: [],
  failed: [],
  ambiguous: [],
  cancelled: [],
  reconciled: [],
};

export function canTransitionMutation(from: MutationState, to: MutationState): boolean {
  return legalMutationTransitions[from].includes(to);
}

export function transitionMutation(from: MutationState, to: MutationState): MutationState {
  if (!canTransitionMutation(from, to)) {
    throw new Error(`Illegal mutation transition: ${from} -> ${to}`);
  }
  return to;
}

export const queueStateSchema = z.enum(["pending", "dispatching", "applied", "failed", "ambiguous", "cancelled"]);
export type QueueState = z.infer<typeof queueStateSchema>;

const legalQueueTransitions: Readonly<Record<QueueState, readonly QueueState[]>> = {
  pending: ["dispatching", "cancelled"],
  dispatching: ["applied", "failed", "ambiguous"],
  applied: [],
  failed: [],
  ambiguous: [],
  cancelled: [],
};

export function canTransitionQueue(from: QueueState, to: QueueState): boolean {
  return legalQueueTransitions[from].includes(to);
}
