import type { WorkspaceSummary } from "@hraness/agent-tasks-protocol";
import {
  attentionProjectionSchema,
  compareAttentionItems,
  localAttentionItemLimit,
  type AttentionItem,
  type AttentionProjection,
} from "@hraness/hra-local-observation-protocol/attention";

import type { RuntimeSnapshot } from "../../../contracts/runtime";

export type WorkspaceSetupAttentionObservation = Readonly<{
  paneId: string;
  setupRequestId: string;
  recipeDigest: string;
  setupRevision: number;
}> & (
  | Readonly<{ state: "ambiguous" }>
  | Readonly<{ state: "approvalRequired" }>
  | Readonly<{
      state: "failed";
      outcome:
        | "clean_replacement_required"
        | "invalid_recipe"
        | "runtime_unavailable"
        | "exit_nonzero"
        | "timeout"
        | "output_limit"
        | "containment_failed"
        | "transcript_unavailable";
    }>
);

export type TaskAttentionObservation = Readonly<{
  completeness: AttentionProjection["completeness"];
  workspaces: readonly WorkspaceSummary[];
}>;

export interface AttentionProjectionInput {
  readonly snapshot: RuntimeSnapshot;
  readonly setup?: readonly WorkspaceSetupAttentionObservation[];
  readonly tasks?: TaskAttentionObservation;
}

const encoder = new TextEncoder();

function safeDisplayText(value: string, fallback: string): string {
  const trimmed = value.trim();
  const source = trimmed.length === 0 ? fallback : trimmed;
  let result = "";
  for (const originalCharacter of source) {
    const codePoint = originalCharacter.codePointAt(0)!;
    const character = codePoint === 0 || (codePoint >= 0xd800 && codePoint <= 0xdfff)
      ? "\uFFFD"
      : originalCharacter;
    if (encoder.encode(result + character).byteLength > 160) break;
    result += character;
  }
  return result.length === 0 ? fallback : result;
}

const setupRank: Readonly<Record<WorkspaceSetupAttentionObservation["state"], number>> = {
  ambiguous: 0,
  approvalRequired: 1,
  failed: 2,
};

function setupByPane(
  observations: readonly WorkspaceSetupAttentionObservation[],
): ReadonlyMap<string, WorkspaceSetupAttentionObservation> {
  const selected = new Map<string, WorkspaceSetupAttentionObservation>();
  for (const observation of observations) {
    const current = selected.get(observation.paneId);
    if (
      current === undefined ||
      setupRank[observation.state] < setupRank[current.state] ||
      (
        setupRank[observation.state] === setupRank[current.state] &&
        observation.setupRequestId < current.setupRequestId
      )
    ) selected.set(observation.paneId, observation);
  }
  return selected;
}

function setupReason(
  observation: WorkspaceSetupAttentionObservation,
): Extract<AttentionItem, { readonly source: "pane" }>["reason"] {
  const identity = {
    setupRequestId: observation.setupRequestId,
    recipeDigest: observation.recipeDigest,
    setupRevision: observation.setupRevision,
  };
  switch (observation.state) {
    case "ambiguous":
      return { kind: "workspace_setup_ambiguous", ...identity };
    case "approvalRequired":
      return { kind: "workspace_setup_approval_required", ...identity };
    case "failed":
      return {
        kind: "workspace_setup_failed",
        ...identity,
        setupOutcome: observation.outcome,
      };
  }
}

function paneAttentionItems(
  snapshot: RuntimeSnapshot,
  setup: readonly WorkspaceSetupAttentionObservation[],
): readonly AttentionItem[] {
  const setupObservations = setupByPane(setup);
  const items: AttentionItem[] = [];
  for (const pane of snapshot.chat.panes) {
    let reason: Extract<AttentionItem, { readonly source: "pane" }>["reason"] | null = null;
    if (
      pane.messageQueue.pauseReason === "ambiguousEffect" ||
      pane.messageQueue.blockedMessage !== null
    ) {
      reason = { kind: "ambiguous_delivery" };
    } else {
      const setupObservation = setupObservations.get(pane.id);
      if (setupObservation !== undefined) {
        reason = setupReason(setupObservation);
      } else if (pane.workspace?.recoveryKind !== null && pane.workspace !== null) {
        reason = {
          kind: "workspace_recovery",
          recoveryKind: pane.workspace.recoveryKind,
        };
      } else if (pane.attention !== null) {
        reason = { kind: "chat_attention", code: pane.attention.code };
      } else if (pane.messageQueue.pauseReason !== null) {
        reason = {
          kind: "queue_paused",
          pauseReason: pane.messageQueue.pauseReason,
        };
      }
    }
    if (reason === null) continue;
    items.push({
      source: "pane",
      paneId: pane.id,
      title: safeDisplayText(pane.title, "Untitled pane"),
      repositoryName: safeDisplayText(pane.repository.name, "Repository"),
      reason,
    });
  }
  return items;
}

function accountAttentionItems(snapshot: RuntimeSnapshot): readonly AttentionItem[] {
  const items: AttentionItem[] = [];
  for (const account of snapshot.accounts) {
    let reason: Extract<AttentionItem, { readonly source: "account" }>["reason"] | null = null;
    if (account.authState === "expired") {
      reason = "expired";
    } else if (
      account.authState === "signedIn" &&
      (account.runtime.state === "backingOff" ||
        account.runtime.state === "failed" ||
        account.runtime.state === "stopped")
    ) {
      reason = "runtime_unavailable";
    } else if (
      account.authState === "signedIn" &&
      account.weeklyUsage?.remainingPercent === 0
    ) {
      reason = "usage_exhausted";
    }
    if (reason === null) continue;
    items.push({
      source: "account",
      accountProfileId: account.id,
      label: safeDisplayText(account.label, "Codex account"),
      reason,
    });
  }
  return items;
}

function systemAttentionItems(snapshot: RuntimeSnapshot): readonly AttentionItem[] {
  const reasons = new Set<Extract<AttentionItem, { readonly source: "system" }>["reason"]>();
  if (
    snapshot.runtime.state === "backingOff" ||
    snapshot.runtime.state === "failed" ||
    snapshot.runtime.state === "stopped"
  ) reasons.add("local_runtime_unavailable");
  if (snapshot.execution.folderAccess.availability === "missing") {
    reasons.add("folder_access_missing");
  }
  if (
    snapshot.accounts.length === 0 ||
    snapshot.accounts.every(({ authState }) =>
      authState === "signedOut" || authState === "expired"
    )
  ) reasons.add("codex_account_required");
  if (snapshot.runner.state === "attention") {
    reasons.add(snapshot.runner.reason === "configuration"
      ? "runner_configuration"
      : snapshot.runner.reason === "connection"
        ? "runner_connection"
        : "runner_repository_missing");
  }
  if (snapshot.humanAccount.state === "recoveryRequired") {
    reasons.add("human_account_recovery");
  } else if (snapshot.humanAccount.state === "error") {
    reasons.add(snapshot.humanAccount.code === "CREDENTIAL_RECOVERY_REQUIRED"
      ? "human_account_recovery"
      : "human_account_attention");
  } else if (
    snapshot.humanAccount.state === "unavailable" &&
    snapshot.humanAccount.reason === "configuration_invalid"
  ) {
    reasons.add("human_account_attention");
  }

  const syncStatus = snapshot.sessionSync.status;
  if (syncStatus.state === "active") {
    if (syncStatus.scheduledChatRecovery !== null) {
      reasons.add("scheduled_chat_recovery");
    }
    if (syncStatus.recovery === "exportRequired") {
      reasons.add("session_sync_recovery");
    }
    if (
      syncStatus.health === "attention" ||
      syncStatus.pendingEnrollments.length > 0 ||
      snapshot.sessionSync.remoteSessions.some(({ state }) =>
        state === "attention" || state === "error" || state === "updateRequired"
      )
    ) reasons.add("session_sync_attention");
  } else if (syncStatus.state === "unavailable") {
    if (syncStatus.reason === "keychainUnavailable") {
      reasons.add("session_sync_recovery");
    } else if (
      syncStatus.reason === "serviceUnavailable" ||
      syncStatus.reason === "updateRequired"
    ) reasons.add("session_sync_attention");
  }

  return [...reasons].map((reason) => ({ source: "system" as const, reason }));
}

function workspaceAttentionItems(
  observations: TaskAttentionObservation | undefined,
): readonly AttentionItem[] {
  if (observations === undefined) return [];
  const workspaces = new Map<string, WorkspaceSummary>();
  for (const workspace of observations.workspaces) {
    const current = workspaces.get(workspace.id);
    if (current === undefined || workspace.revision > current.revision) {
      workspaces.set(workspace.id, workspace);
    }
  }
  const items: AttentionItem[] = [];
  for (const workspace of workspaces.values()) {
    const name = safeDisplayText(workspace.name, "Workspace");
    if (workspace.counts.attention.value > 0) {
      items.push({
        source: "workspace",
        workspaceId: workspace.id,
        name,
        reason: "task_attention",
        count: workspace.counts.attention,
      });
    }
    if (workspace.counts.review.value > 0) {
      items.push({
        source: "workspace",
        workspaceId: workspace.id,
        name,
        reason: "task_review",
        count: workspace.counts.review,
      });
    }
  }
  return items;
}

export function projectAttention(input: AttentionProjectionInput): AttentionProjection {
  const items = [
    ...paneAttentionItems(input.snapshot, input.setup ?? []),
    ...accountAttentionItems(input.snapshot),
    ...systemAttentionItems(input.snapshot),
    ...workspaceAttentionItems(input.tasks),
  ].sort(compareAttentionItems);
  const truncated = items.length > localAttentionItemLimit;
  const optionalCloudIsQuiet = input.tasks?.completeness === "cloud_unavailable" &&
    (input.snapshot.humanAccount.state === "signedOut" ||
      (input.snapshot.humanAccount.state === "unavailable" &&
        input.snapshot.humanAccount.reason === "configuration_missing"));
  return attentionProjectionSchema.parse({
    version: 1,
    completeness: truncated
      ? "workspace_limit_reached"
      : optionalCloudIsQuiet
        ? "complete"
        : input.tasks?.completeness ?? "complete",
    items: items.slice(0, localAttentionItemLimit),
  });
}
