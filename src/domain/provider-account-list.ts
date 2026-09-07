import { z } from "zod";

import {
  claudeProviderAccountIdSchema,
  codexProviderAccountIdSchema,
  providerAccountReadinessSchema,
} from "./provider-accounts";
import { usageProviderAccountIdSchema, usageProviderSchema } from "./provider-usage";
import { canonicalLabelKey, labelSchema, profileIdSchema, utf8Bytes } from "./values";

// A row ceiling, not a promise that every maximum-size list fits. Keep a
// separate canonical-result bound below the local transport's 4 MiB envelope.
export const PROVIDER_ACCOUNT_LIST_MAX_COUNT = 10_000;
export const PROVIDER_ACCOUNT_LIST_MAX_BYTES = 3 * 1024 * 1024;

const revisionSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const canonicalLabelSchema = z.string().max(160).refine((value) => {
  const parsed = labelSchema.safeParse(value);
  return parsed.success && parsed.data === value;
}, "An account label must already satisfy the stored label contract.");

const providerAccountListEntrySchema = z.object({
  id: usageProviderAccountIdSchema,
  profileId: profileIdSchema,
  label: canonicalLabelSchema,
  readiness: providerAccountReadinessSchema.exclude(["removed"]),
  readinessObservedAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable(),
  orderPosition: z.number().int().positive().max(PROVIDER_ACCOUNT_LIST_MAX_COUNT),
  active: z.boolean(),
}).strict().readonly();

/** Cached local defaults/readiness, never quota freshness or dispatch authority. */
export const providerAccountListResultSchema = z.object({
  version: z.literal(1),
  provider: usageProviderSchema,
  orderRevision: revisionSchema,
  pointerRevision: revisionSchema,
  activeProviderAccountId: usageProviderAccountIdSchema.nullable(),
  accounts: z.array(providerAccountListEntrySchema).max(PROVIDER_ACCOUNT_LIST_MAX_COUNT).readonly(),
}).strict().superRefine((value, context) => {
  const accountIds = new Set<string>();
  const profileIds = new Set<string>();
  const labelKeys = new Set<string>();
  const idSchema = value.provider === "codex" ? codexProviderAccountIdSchema : claudeProviderAccountIdSchema;
  for (const [index, account] of value.accounts.entries()) {
    const labelKey = canonicalLabelKey(account.label);
    if (!idSchema.safeParse(account.id).success
      || (value.provider === "codex" && account.id !== account.profileId)
      || account.orderPosition !== index + 1
      || account.active !== (account.id === value.activeProviderAccountId)
      || accountIds.has(account.id) || profileIds.has(account.profileId) || labelKeys.has(labelKey)) {
      context.addIssue({ code: "custom", path: ["accounts", index],
        message: "Provider accounts must have exact unique identities, total order and one matching default." });
    }
    accountIds.add(account.id);
    profileIds.add(account.profileId);
    labelKeys.add(labelKey);
  }
  if ((value.accounts.length === 0) !== (value.activeProviderAccountId === null)
    || (value.activeProviderAccountId !== null && !accountIds.has(value.activeProviderAccountId))) {
    context.addIssue({ code: "custom", path: ["activeProviderAccountId"],
      message: "The default must be an exact listed member, or null only for an empty list." });
  }
  if (utf8Bytes(JSON.stringify(value)) > PROVIDER_ACCOUNT_LIST_MAX_BYTES) {
    context.addIssue({ code: "custom", message: "The cached provider account result exceeds its byte bound." });
  }
}).readonly();

export type ProviderAccountListResult = z.infer<typeof providerAccountListResultSchema>;
