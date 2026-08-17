import type { RuntimeSnapshot } from "../../contracts/runtime";

import type { DevStatusClient } from "./status-client";
import {
  DevelopmentReloadAcceptedUnconfirmedError,
  DevelopmentReloadOutcomeUnconfirmedError,
  type DevStatusEnvelope,
  type DevelopmentReloadResponse,
} from "./protocol";

const activePaneStates = new Set(["starting", "streaming", "continuing"]);
const activeHarnessStates = new Set(["starting", "running", "waiting"]);

export function runtimeSnapshotHasActiveWork(snapshot: RuntimeSnapshot): boolean {
  return snapshot.chat.panes.some((pane) => (
    activePaneStates.has(pane.state) ||
    pane.workspace?.state === "preparing" ||
    pane.workspace?.state === "waitingCapacity" ||
    pane.harness?.descendants.truncated === true ||
    (pane.harness?.descendants.children.some((child) => (
      activeHarnessStates.has(child.state)
    )) ?? false)
  ));
}

export interface DevApplyOperations {
  readonly statuses: DevStatusClient;
  readonly takeSnapshot: () => Promise<RuntimeSnapshot>;
  readonly reloadAndConfirm: (candidateId: string) => Promise<DevelopmentReloadResponse>;
}

export type DevApplyOutcome =
  | { readonly kind: "applied"; readonly status: DevStatusEnvelope }
  | { readonly kind: "activeWork"; readonly status: DevStatusEnvelope }
  | {
      readonly kind: "runtimeBusy" | "runtimeUnavailable";
      readonly status: DevStatusEnvelope;
    }
  | { readonly kind: "acceptedUnconfirmed"; readonly status: DevStatusEnvelope }
  | { readonly kind: "stale"; readonly status: DevStatusEnvelope }
  | { readonly kind: "failed"; readonly status: DevStatusEnvelope | null };

function exactApplyingCandidate(
  status: DevStatusEnvelope,
  candidateId: string,
): boolean {
  return status.state === "applying" && status.candidateId === candidateId;
}

async function bestEffortCancel(
  statuses: DevStatusClient,
  sessionId: string,
  candidateId: string,
): Promise<DevStatusEnvelope | null> {
  try {
    return await statuses.cancel(sessionId, candidateId);
  } catch {
    return null;
  }
}

export async function applyStagedDevelopmentUpdate(
  displayed: DevStatusEnvelope,
  operations: DevApplyOperations,
): Promise<DevApplyOutcome> {
  const candidateId = displayed.state === "staged" ? displayed.candidateId : null;
  if (candidateId === null) return { kind: "stale", status: displayed };

  let current: DevStatusEnvelope | null = null;
  try {
    current = await operations.statuses.read();
    if (current.state !== "staged" || current.candidateId !== candidateId) {
      return { kind: "stale", status: current };
    }
    const snapshot = await operations.takeSnapshot();
    if (runtimeSnapshotHasActiveWork(snapshot)) {
      return { kind: "activeWork", status: current };
    }
    if (current.authority !== "launcher") return { kind: "stale", status: current };
    const reserved = await operations.statuses.reserve(current.sessionId, candidateId);
    current = reserved;
    if (!exactApplyingCandidate(reserved, candidateId)) {
      return { kind: "stale", status: reserved };
    }

    let reload: DevelopmentReloadResponse;
    try {
      reload = await operations.reloadAndConfirm(candidateId);
    } catch (reason: unknown) {
      if (
        reason instanceof DevelopmentReloadAcceptedUnconfirmedError
        || reason instanceof DevelopmentReloadOutcomeUnconfirmedError
      ) {
        return { kind: "acceptedUnconfirmed", status: reserved };
      }
      const cancelled = await bestEffortCancel(
        operations.statuses,
        current.sessionId,
        candidateId,
      );
      return { kind: "failed", status: cancelled ?? reserved };
    }
    if (reload.candidateId !== candidateId) {
      if (reload.status === "accepted") {
        return { kind: "acceptedUnconfirmed", status: reserved };
      }
      const cancelled = await bestEffortCancel(
        operations.statuses,
        current.sessionId,
        candidateId,
      );
      return { kind: "failed", status: cancelled ?? reserved };
    }
    if (reload.status !== "accepted") {
      const cancelled = await bestEffortCancel(
        operations.statuses,
        current.sessionId,
        candidateId,
      );
      return {
        kind: reload.status === "busy" ? "runtimeBusy" : "runtimeUnavailable",
        status: cancelled ?? reserved,
      };
    }

    let acknowledged: DevStatusEnvelope;
    try {
      acknowledged = await operations.statuses.acknowledge(
        current.sessionId,
        candidateId,
      );
    } catch {
      return { kind: "acceptedUnconfirmed", status: reserved };
    }
    return exactApplyingCandidate(acknowledged, candidateId)
      ? { kind: "acceptedUnconfirmed", status: acknowledged }
      : { kind: "applied", status: acknowledged };
  } catch {
    return { kind: "failed", status: current };
  }
}
