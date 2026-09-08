import { z } from "zod";

import {
  AUTORESPOND_CONSECUTIVE_LIMIT,
  AUTORESPOND_DAILY_BUDGET,
  AUTORESPOND_HOURLY_BUDGET,
} from "./autorespond-budget";
import { snapshotForeignJson } from "./guards";
import {
  isWithinNotificationHours,
  notificationHoursPolicySchema,
  type NotificationHoursPolicy,
} from "./notification-hours";

/** Separate consent, not a notification-email policy or a schedule update. */
export const autorespondAfterHoursPolicySchema = z.object({
  kind: z.literal("autorespond_after_hours"),
  version: z.literal(1),
  revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  enabled: z.boolean(),
}).strict().readonly();

export type AutorespondAfterHoursPolicy = z.infer<typeof autorespondAfterHoursPolicySchema>;

/** Missing or malformed consent has no enabled default. Never invoke accessors. */
export function parseAutorespondAfterHoursPolicy(value: unknown): AutorespondAfterHoursPolicy | null {
  const snapshot = snapshotForeignJson(value);
  if (!snapshot.ok) return null;
  const result = autorespondAfterHoursPolicySchema.safeParse(snapshot.value);
  return result.success ? result.data : null;
}

const baselineLimits = Object.freeze({
  consecutive: AUTORESPOND_CONSECUTIVE_LIMIT,
  lastHour: AUTORESPOND_HOURLY_BUDGET,
  lastDay: AUTORESPOND_DAILY_BUDGET,
});

const afterHoursLimits = Object.freeze({ consecutive: 6, lastHour: 20, lastDay: 80 } as const);

const inputSchema = z.object({
  sourceKind: z.enum(["protocol", "prose"]),
  approvalEligibility: z.enum(["eligible", "ineligible", "unknown"]),
  // "proven" means both rolling-window history and the consecutive count
  // are known. A legacy floor of three is not proof of exact consecutive spend.
  historyEligibility: z.enum(["proven", "unknown", "human_reset_required"]),
  policy: z.unknown().optional(),
  schedule: z.unknown().optional(),
  observedAt: z.unknown().optional(),
}).strict();

const instantSchema = z.number().int().nonnegative().max(8_640_000_000_000_000);

export type AutorespondAfterHoursBaselineReason =
  | "input_invalid"
  | "prose_baseline"
  | "policy_missing"
  | "policy_invalid"
  | "policy_disabled"
  | "approval_ineligible"
  | "history_unproven"
  | "human_reset_required"
  | "schedule_invalid"
  | "clock_invalid"
  | "time_evaluation_failed"
  | "within_hours";

type SelectionSnapshot = Readonly<{
  policy: AutorespondAfterHoursPolicy;
  schedule: NotificationHoursPolicy;
  observedAt: number;
}>;

export type AutorespondAfterHoursSelection = Readonly<{
  version: 1;
  mode: "provisional";
  runtimeMutationAllowed: false;
} & (
  | {
      tier: "baseline";
      limits: typeof baselineLimits;
      reason: AutorespondAfterHoursBaselineReason;
      snapshot: SelectionSnapshot | null;
    }
  | {
      tier: "after_hours";
      limits: typeof afterHoursLimits;
      reason: "eligible_outside_hours";
      snapshot: SelectionSnapshot;
    }
)>;

function baseline(
  reason: AutorespondAfterHoursBaselineReason,
  snapshot: SelectionSnapshot | null = null,
): AutorespondAfterHoursSelection {
  return Object.freeze({
    version: 1,
    mode: "provisional",
    runtimeMutationAllowed: false,
    tier: "baseline",
    limits: baselineLimits,
    reason,
    snapshot,
  });
}

/**
 * Select provisional limits, never admit an effect.
 *
 * No clock, storage, provider, counters, or notification consent is read here.
 * Final transactional admission must independently establish eligibility,
 * complete history, a coherent current policy/schedule, and valid accounting
 * time before charging the shared ledger. Baseline selection after a bad clock
 * is not permission to admit against corrupt or unavailable accounting time.
 * No selection resets counters, refunds reservations, or proves a human reset.
 */
export function selectAutorespondAfterHoursTier(value: unknown): AutorespondAfterHoursSelection {
  const foreign = snapshotForeignJson(value);
  if (!foreign.ok) return baseline("input_invalid");
  const parsed = inputSchema.safeParse(foreign.value);
  if (!parsed.success) return baseline("input_invalid");
  const input = parsed.data;
  if (input.sourceKind === "prose") return baseline("prose_baseline");
  if (input.policy === undefined || input.policy === null) return baseline("policy_missing");
  const policy = parseAutorespondAfterHoursPolicy(input.policy);
  if (policy === null) return baseline("policy_invalid");
  if (!policy.enabled) return baseline("policy_disabled");
  if (input.approvalEligibility !== "eligible") return baseline("approval_ineligible");
  if (input.historyEligibility === "unknown") return baseline("history_unproven");
  if (input.historyEligibility === "human_reset_required") return baseline("human_reset_required");

  const hours = notificationHoursPolicySchema.safeParse(input.schedule);
  if (!hours.success) return baseline("schedule_invalid");
  const instant = instantSchema.safeParse(input.observedAt);
  if (!instant.success) return baseline("clock_invalid");
  const snapshot: SelectionSnapshot = Object.freeze({
    policy,
    schedule: Object.freeze(hours.data),
    observedAt: instant.data,
  });
  try {
    if (isWithinNotificationHours(snapshot.schedule, snapshot.observedAt)) {
      return baseline("within_hours", snapshot);
    }
  } catch {
    return baseline("time_evaluation_failed");
  }
  return Object.freeze({
    version: 1,
    mode: "provisional",
    runtimeMutationAllowed: false,
    tier: "after_hours",
    limits: afterHoursLimits,
    reason: "eligible_outside_hours",
    snapshot,
  });
}
