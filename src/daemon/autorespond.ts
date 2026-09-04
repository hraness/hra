/*
 * Autorespond policy for brokered provider approvals.
 *
 * When a session runs in an `auto:*` approval mode, HRA answers command,
 * file-change, and (under `auto:all`) permission approvals immediately with
 * the accept decision at `once` scope. Session scope is never granted by the
 * policy, questions and MCP forms are never answered here, and every action
 * is bounded by a consecutive counter that only a human message resets plus
 * hourly and daily budgets. The decision is pure; the controller applies it
 * through the daemon's ordinary resolve path and records evidence.
 */

import type { ApprovalMode, InteractionDisplay, InteractionKind } from "../domain/interactions";

export const AUTORESPOND_CONSECUTIVE_LIMIT = 3;
export const AUTORESPOND_HOURLY_BUDGET = 10;
export const AUTORESPOND_DAILY_BUDGET = 40;

export type AutorespondBudgets = Readonly<{
  consecutive: number;
  lastHour: number;
  lastDay: number;
}>;

export type AutorespondDecision =
  | Readonly<{ action: "accept"; decision: "once"; approvalClass: string }>
  | Readonly<{ action: "escalate"; code: AutorespondEscalation; approvalClass: string }>;

export type AutorespondEscalation =
  | "manual_mode"
  | "not_an_approval"
  | "decision_unavailable"
  | "network_or_external"
  | "consecutive_limit"
  | "hourly_budget"
  | "daily_budget";

const networkPermissionPattern = /(?:network|internet|http|https|url|fetch|socket|dns|proxy|mcp|remote|web)/iu;

/*
 * Bounded class label for evidence and for the `auto:workspace` gate. Command
 * approvals carry a provider command class; permission approvals are classed
 * by their requested permission names; unknown shapes are `unknown`.
 */
export function approvalClassOf(display: InteractionDisplay): string {
  switch (display.kind) {
    case "command_approval": return `command:${display.commandClass}`.slice(0, 256);
    case "file_change_approval": return "file_change";
    case "permission_approval": {
      const names = display.requested.map((permission) => permission.name).join(",");
      return `permission:${names.length === 0 ? "unknown" : names}`.slice(0, 256);
    }
    case "user_input": return "user_input";
    case "mcp_elicitation": return "mcp_elicitation";
  }
}

export function permissionNamesOf(display: InteractionDisplay): string[] {
  return display.kind === "permission_approval"
    ? display.requested.map((permission) => permission.name)
    : [];
}

export function isNetworkOrExternalPermission(display: Extract<InteractionDisplay, { kind: "permission_approval" }>): boolean {
  if (display.requested.length === 0) return true;
  return display.requested.some((permission) => networkPermissionPattern.test(permission.name));
}

export function decideAutorespond(input: Readonly<{
  budgets: AutorespondBudgets;
  display: InteractionDisplay;
  kind: InteractionKind;
  mode: ApprovalMode;
}>): AutorespondDecision {
  const approvalClass = approvalClassOf(input.display);
  if (input.mode === "manual") return { action: "escalate", code: "manual_mode", approvalClass };
  if (
    input.kind !== "command_approval"
    && input.kind !== "file_change_approval"
    && input.kind !== "permission_approval"
  ) return { action: "escalate", code: "not_an_approval", approvalClass };
  if (input.display.kind !== input.kind) return { action: "escalate", code: "not_an_approval", approvalClass };
  if (input.display.kind === "permission_approval") {
    if (input.display.requested.length === 0) {
      return { action: "escalate", code: "decision_unavailable", approvalClass };
    }
    if (input.mode === "auto:workspace" && isNetworkOrExternalPermission(input.display)) {
      return { action: "escalate", code: "network_or_external", approvalClass };
    }
  } else if (!input.display.availableDecisions.includes("once")) {
    return { action: "escalate", code: "decision_unavailable", approvalClass };
  }
  if (input.budgets.consecutive >= AUTORESPOND_CONSECUTIVE_LIMIT) {
    return { action: "escalate", code: "consecutive_limit", approvalClass };
  }
  if (input.budgets.lastHour >= AUTORESPOND_HOURLY_BUDGET) {
    return { action: "escalate", code: "hourly_budget", approvalClass };
  }
  if (input.budgets.lastDay >= AUTORESPOND_DAILY_BUDGET) {
    return { action: "escalate", code: "daily_budget", approvalClass };
  }
  return { action: "accept", decision: "once", approvalClass };
}

export type AutorespondEvidenceInput = Readonly<{
  approvalClass: string;
  decision: string;
  interactionId: string;
  kind: InteractionKind;
  latencyMs: number;
  mode: ApprovalMode;
  outcome: "accepted" | "refused";
  sessionId: string;
  subagent: boolean;
}>;
