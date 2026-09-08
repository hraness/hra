import type { ApprovalMode } from "./interactions";

export const AUTORESPOND_CONSECUTIVE_LIMIT = 3;
export const AUTORESPOND_HOURLY_BUDGET = 10;
export const AUTORESPOND_DAILY_BUDGET = 40;
export const AUTORESPOND_HOUR_MS = 60 * 60 * 1_000;
export const AUTORESPOND_DAY_MS = 24 * AUTORESPOND_HOUR_MS;
// Unresolved prose retains its admission until transcript settlement. Refuse
// further admission if recovery debt fills this separate bounded authority.
export const AUTORESPOND_RESERVATIONS_PER_SESSION_CAP = 500;

export type AutorespondBudgetReservationInput = Readonly<{
  sessionId: string;
  sourceKind: "protocol" | "prose";
  sourceId: string;
  expectedMode: ApprovalMode;
}>;

export type AutorespondBudgetRefusal =
  | "manual_mode"
  | "policy_changed"
  | "protected_authority_required"
  | "decision_unavailable"
  | "not_an_approval"
  | "consecutive_limit"
  | "hourly_budget"
  | "daily_budget"
  | "history_unavailable";

export type AutorespondBudgetReservationResult =
  | Readonly<{ state: "reserved" }>
  | Readonly<{ state: "existing" }>
  | Readonly<{ state: "refused"; code: AutorespondBudgetRefusal }>;
