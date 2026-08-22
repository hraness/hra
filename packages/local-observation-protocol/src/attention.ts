import { workspacePublicIdSchema } from "@hraness/agent-tasks-domain/model";
import { z } from "@hra-internal/schema";

export const localObservationVersion = 1 as const;
export const localAttentionItemLimit = 272;

const utf8Encoder = new TextEncoder();
const utf8Decoder = new TextDecoder("utf-8", { fatal: true });

function displayText(maxBytes: number) {
  return z.string().min(1).max(maxBytes).refine((value) => {
    const encoded = utf8Encoder.encode(value);
    return value === value.trim() && !value.includes("\0") &&
      encoded.byteLength <= maxBytes && utf8Decoder.decode(encoded) === value;
  }, "display text must be trimmed, NUL-free, valid Unicode within its byte limit");
}

export const localPaneIdSchema = z.string()
  .min(13)
  .max(96)
  .regex(/^pane_[A-Za-z0-9_-]+$/u, "invalid local pane ID");
export const localAccountProfileIdSchema = z.string()
  .min(13)
  .max(96)
  .regex(/^acct_[A-Za-z0-9_-]+$/u, "invalid local account profile ID");
export const workspaceSetupRequestIdSchema = z.string()
  .regex(/^wssetup_[a-f0-9]{32}$/u, "invalid workspace setup request ID");
export const workspaceRecipeDigestSchema = z.string()
  .regex(/^[a-f0-9]{64}$/u, "invalid workspace recipe digest");

export const localDisplayNameSchema = displayText(160);
export const boundedObservationCountSchema = z.object({
  value: z.number().int().nonnegative().safe(),
  capped: z.boolean(),
}).strict();

export const workspaceRecoveryKindSchema = z.enum([
  "legacyUnbound",
  "capacityUnavailable",
  "insufficientDisk",
  "baseMismatch",
  "bindingMismatch",
  "branchWithoutLane",
  "checkoutMismatch",
  "dirtyCheckout",
  "invalidManifest",
  "manifestMissing",
  "pathEscape",
  "repositoryMismatch",
  "provisionInterrupted",
  "laneMissing",
  "unknown",
]);

export const localChatAttentionCodeSchema = z.enum([
  "account_required",
  "account_unavailable",
  "usage_limit_reached",
  "all_accounts_exhausted",
  "continuation_failed",
  "approval_required",
  "runtime_unavailable",
  "turn_failed",
]);

export const workspaceSetupOutcomeSchema = z.enum([
  "clean_replacement_required",
  "invalid_recipe",
  "runtime_unavailable",
  "exit_nonzero",
  "timeout",
  "output_limit",
  "containment_failed",
  "transcript_unavailable",
]);

const workspaceSetupIdentityFields = {
  setupRequestId: workspaceSetupRequestIdSchema,
  recipeDigest: workspaceRecipeDigestSchema,
  setupRevision: z.number().int().positive().safe(),
} as const;

export const paneAttentionReasonSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("ambiguous_delivery") }).strict(),
  z.object({
    kind: z.literal("workspace_setup_ambiguous"),
    ...workspaceSetupIdentityFields,
  }).strict(),
  z.object({
    kind: z.literal("workspace_setup_approval_required"),
    ...workspaceSetupIdentityFields,
  }).strict(),
  z.object({
    kind: z.literal("workspace_setup_failed"),
    ...workspaceSetupIdentityFields,
    setupOutcome: workspaceSetupOutcomeSchema,
  }).strict(),
  z.object({
    kind: z.literal("workspace_recovery"),
    recoveryKind: workspaceRecoveryKindSchema,
  }).strict(),
  z.object({
    kind: z.literal("chat_attention"),
    code: localChatAttentionCodeSchema,
  }).strict(),
  z.object({
    kind: z.literal("queue_paused"),
    pauseReason: z.enum(["stop", "runtimeRestart", "attention"]),
  }).strict(),
]);

export const paneAttentionItemSchema = z.object({
  source: z.literal("pane"),
  paneId: localPaneIdSchema,
  title: localDisplayNameSchema,
  repositoryName: localDisplayNameSchema.nullable(),
  reason: paneAttentionReasonSchema,
}).strict();

export const accountAttentionItemSchema = z.object({
  source: z.literal("account"),
  accountProfileId: localAccountProfileIdSchema,
  label: localDisplayNameSchema,
  reason: z.enum(["expired", "runtime_unavailable", "usage_exhausted"]),
}).strict();

export const workspaceAttentionItemSchema = z.object({
  source: z.literal("workspace"),
  workspaceId: workspacePublicIdSchema,
  name: localDisplayNameSchema,
  reason: z.enum(["task_attention", "task_review"]),
  count: boundedObservationCountSchema,
}).strict().superRefine((item, context) => {
  if (item.count.value === 0) {
    context.addIssue({
      code: "custom",
      message: "workspace attention rows require a nonzero count",
      path: ["count", "value"],
    });
  }
});

export const systemAttentionItemSchema = z.object({
  source: z.literal("system"),
  reason: z.enum([
    "local_runtime_unavailable",
    "folder_access_missing",
    "codex_account_required",
    "runner_configuration",
    "runner_connection",
    "runner_repository_missing",
    "human_account_recovery",
    "human_account_attention",
    "session_sync_attention",
    "session_sync_recovery",
    "scheduled_chat_recovery",
  ]),
}).strict();

export const attentionItemSchema = z.discriminatedUnion("source", [
  paneAttentionItemSchema,
  accountAttentionItemSchema,
  workspaceAttentionItemSchema,
  systemAttentionItemSchema,
]);

export type AttentionItem = z.infer<typeof attentionItemSchema>;
export type AttentionGroup = "recovery" | "needs_you" | "review";

const recoveryPaneReasons = new Set<string>([
  "ambiguous_delivery",
  "workspace_setup_ambiguous",
  "workspace_recovery",
]);

export function attentionGroup(item: AttentionItem): AttentionGroup {
  if (item.source === "workspace") {
    return item.reason === "task_review" ? "review" : "needs_you";
  }
  if (item.source === "pane" && recoveryPaneReasons.has(item.reason.kind)) {
    return "recovery";
  }
  if (
    item.source === "system" &&
    (item.reason === "human_account_recovery" ||
      item.reason === "session_sync_recovery" ||
      item.reason === "scheduled_chat_recovery")
  ) {
    return "recovery";
  }
  return "needs_you";
}

export function attentionItemKey(item: AttentionItem): string {
  switch (item.source) {
    case "pane":
      return `pane:${item.paneId}`;
    case "account":
      return `account:${item.accountProfileId}`;
    case "workspace":
      return `workspace:${item.workspaceId}:${item.reason}`;
    case "system":
      return `system:${item.reason}`;
  }
}

const groupRank: Readonly<Record<AttentionGroup, number>> = {
  recovery: 0,
  needs_you: 1,
  review: 2,
};

const reasonRank: Readonly<Record<string, number>> = Object.freeze({
  ambiguous_delivery: 0,
  workspace_setup_ambiguous: 1,
  human_account_recovery: 2,
  session_sync_recovery: 3,
  scheduled_chat_recovery: 4,
  workspace_recovery: 5,
  workspace_setup_approval_required: 10,
  workspace_setup_failed: 11,
  chat_attention: 12,
  queue_paused: 13,
  expired: 14,
  runtime_unavailable: 15,
  usage_exhausted: 16,
  local_runtime_unavailable: 17,
  folder_access_missing: 18,
  codex_account_required: 19,
  runner_configuration: 20,
  runner_connection: 21,
  runner_repository_missing: 22,
  human_account_attention: 23,
  session_sync_attention: 24,
  task_attention: 25,
  task_review: 30,
});

function reasonName(item: AttentionItem): string {
  return item.source === "pane" ? item.reason.kind : item.reason;
}

function displayName(item: AttentionItem): string {
  switch (item.source) {
    case "pane":
      return item.repositoryName ?? item.title;
    case "account":
      return item.label;
    case "workspace":
      return item.name;
    case "system":
      return item.reason;
  }
}

function normalized(value: string): string {
  return value.normalize("NFKC").toLowerCase();
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function compareAttentionItems(left: AttentionItem, right: AttentionItem): number {
  const groupDifference = groupRank[attentionGroup(left)] - groupRank[attentionGroup(right)];
  if (groupDifference !== 0) return groupDifference;
  const reasonDifference = (reasonRank[reasonName(left)] ?? 1_000) -
    (reasonRank[reasonName(right)] ?? 1_000);
  if (reasonDifference !== 0) return reasonDifference;
  const displayDifference = compareStrings(normalized(displayName(left)), normalized(displayName(right)));
  if (displayDifference !== 0) return displayDifference;
  return compareStrings(attentionItemKey(left), attentionItemKey(right));
}

export const attentionProjectionSchema = z.object({
  version: z.literal(localObservationVersion),
  completeness: z.enum([
    "complete",
    "cloud_refreshing",
    "cloud_unavailable",
    "task_authority_unavailable",
    "workspace_limit_reached",
  ]),
  items: z.array(attentionItemSchema).max(localAttentionItemLimit),
}).strict().superRefine((projection, context) => {
  const keys = new Set<string>();
  projection.items.forEach((item, index) => {
    const key = attentionItemKey(item);
    if (keys.has(key)) {
      context.addIssue({
        code: "custom",
        message: "attention item keys must be unique",
        path: ["items", index],
      });
    }
    keys.add(key);
    if (index > 0 && compareAttentionItems(projection.items[index - 1]!, item) > 0) {
      context.addIssue({
        code: "custom",
        message: "attention items must use canonical order",
        path: ["items", index],
      });
    }
  });
});

export type AttentionProjection = z.infer<typeof attentionProjectionSchema>;

export function canonicalAttentionProjection(value: unknown): AttentionProjection {
  return attentionProjectionSchema.parse(value);
}
