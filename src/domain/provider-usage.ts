import { createHash } from "node:crypto";

import { z } from "zod";

import {
  claudeProviderAccountAuthoritySchema,
  claudeProviderAccountIdSchema,
  codexProviderAccountAuthoritySchema,
  codexProviderAccountIdSchema,
} from "./provider-accounts";
import {
  storedAccountUsageSnapshotSchema,
  type StoredAccountUsageSnapshot,
} from "./usage-metrics";
import { sessionIdSchema, unixMillisecondsSchema } from "./values";

/** Subscription quota and automatic usage management are not general provider capabilities. */
export const usageProviderSchema = z.enum(["codex", "claude"]);
export type UsageProvider = z.infer<typeof usageProviderSchema>;
export const usageProviderAccountIdSchema = z.union([
  codexProviderAccountIdSchema, claudeProviderAccountIdSchema,
]);
export const usageProviderAccountAuthoritySchema = z.discriminatedUnion("provider", [
  codexProviderAccountAuthoritySchema, claudeProviderAccountAuthoritySchema,
]);
export type UsageProviderAccountAuthority = z.infer<typeof usageProviderAccountAuthoritySchema>;

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);
const safeNonnegativeIntegerSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const safePositiveIntegerSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const utf8Bytes = (value: string): number => new TextEncoder().encode(value).byteLength;
const compareCanonicalString = (left: string, right: string): number =>
  left === right ? 0 : left < right ? -1 : 1;
const providerCodeCharacters = /^[A-Za-z0-9_.:+/-]+$/u;
const boundedProviderCodeSchema = z.string().min(1).regex(providerCodeCharacters).refine(
  (value) => utf8Bytes(value) <= 128,
  "Provider code exceeds 128 UTF-8 bytes.",
);
const boundedModelKeySchema = z.string().min(1).regex(providerCodeCharacters).refine(
  (value) => utf8Bytes(value) <= 128,
  "Model key exceeds 128 UTF-8 bytes.",
);

export const providerUsageSourceSchema = z.enum([
  "codex_app_server",
  "claude_rate_limit_event",
  "claude_result",
]);
export type ProviderUsageSource = z.infer<typeof providerUsageSourceSchema>;

export const providerUsageComponentKindSchema = z.enum(["quota", "accounting"]);
export type ProviderUsageComponentKind = z.infer<typeof providerUsageComponentKindSchema>;

export const providerUsageAuthorityModeSchema = z.enum([
  "mutation_authoritative",
  "compatibility_display_only",
]);
export type ProviderUsageAuthorityMode = z.infer<typeof providerUsageAuthorityModeSchema>;

export const providerUsageTurnProvenanceSchema = z.object({
  sessionId: sessionIdSchema,
  turnId: z.string().min(1).max(200),
}).strict();
export type ProviderUsageTurnProvenance = z.infer<typeof providerUsageTurnProvenanceSchema>;

export const providerUsageWindowSchema = z.object({
  id: boundedProviderCodeSchema,
  scope: z.literal("account"),
  usedPercent: z.number().finite().min(0).max(100),
  resetsAtMs: unixMillisecondsSchema,
}).strict();
export type ProviderUsageWindow = z.infer<typeof providerUsageWindowSchema>;

export const claudeRateLimitStatusSchema = z.union([
  z.object({
    state: z.literal("known"),
    value: z.enum(["allowed", "warning", "blocked", "denied", "rejected"]),
  }).strict(),
  z.object({
    state: z.literal("unknown"),
    value: boundedProviderCodeSchema,
  }).strict(),
]);
export type ClaudeRateLimitStatus = z.infer<typeof claudeRateLimitStatusSchema>;

export const claudeQuotaUsageSchema = z.object({
  format: z.literal("claude_v1"),
  status: claudeRateLimitStatusSchema,
  rateLimitType: boundedProviderCodeSchema.nullable(),
  resetsAtMs: unixMillisecondsSchema.nullable(),
  overageStatus: boundedProviderCodeSchema.nullable(),
  overageDisabledReason: boundedProviderCodeSchema.nullable(),
  isUsingOverage: z.boolean().nullable(),
  windows: z.array(providerUsageWindowSchema).max(16),
}).strict();
export type ClaudeQuotaUsage = z.infer<typeof claudeQuotaUsageSchema>;

const nullableTokenCountSchema = safeNonnegativeIntegerSchema.nullable();

export const providerUsageModelAccountingSchema = z.object({
  model: boundedModelKeySchema,
  costUsd: z.number().finite().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable(),
  inputTokens: nullableTokenCountSchema,
  cacheReadInputTokens: nullableTokenCountSchema,
  cacheCreationInputTokens: nullableTokenCountSchema,
  outputTokens: nullableTokenCountSchema,
  thinkingTokens: nullableTokenCountSchema,
  contextWindow: nullableTokenCountSchema,
  maxOutputTokens: nullableTokenCountSchema,
}).strict();
export type ProviderUsageModelAccounting = z.infer<typeof providerUsageModelAccountingSchema>;

export const claudeAccountingUsageSchema = z.object({
  format: z.literal("claude_v1"),
  totalCostUsd: z.number().finite().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable(),
  inputTokens: nullableTokenCountSchema,
  cacheReadInputTokens: nullableTokenCountSchema,
  cacheCreationInputTokens: nullableTokenCountSchema,
  outputTokens: nullableTokenCountSchema,
  thinkingTokens: nullableTokenCountSchema,
  models: z.array(providerUsageModelAccountingSchema).max(32),
}).strict();
export type ClaudeAccountingUsage = z.infer<typeof claudeAccountingUsageSchema>;

const codexQuotaWindowSchema = z.object({
  usedPercent: z.number().finite().min(0).max(100),
  windowDurationMins: z.number().finite().nonnegative().nullable(),
  resetsAtMs: unixMillisecondsSchema.nullable(),
}).strict();

const codexQuotaLimitSchema = z.object({
  id: z.string().min(1).max(256),
  limitId: z.string().min(1).max(256).nullable(),
  limitName: z.string().min(1).max(256).nullable(),
  planType: z.string().min(1).max(128).nullable(),
  rateLimitReachedType: z.string().min(1).max(128).nullable(),
  primary: codexQuotaWindowSchema.nullable(),
  secondary: codexQuotaWindowSchema.nullable(),
}).strict();

export const codexQuotaUsageSchema = z.object({
  format: z.literal("codex_v1"),
  resetCreditsAvailable: safeNonnegativeIntegerSchema,
  limits: z.array(codexQuotaLimitSchema).max(101),
}).strict();
export type CodexQuotaUsage = z.infer<typeof codexQuotaUsageSchema>;

const codexUsageSummarySchema = z.object({
  lifetimeTokens: nullableTokenCountSchema,
  peakDailyTokens: nullableTokenCountSchema,
  longestRunningTurnSec: nullableTokenCountSchema,
  currentStreakDays: nullableTokenCountSchema,
  longestStreakDays: nullableTokenCountSchema,
}).strict();

const codexDailyUsageBucketSchema = z.object({
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u),
  tokens: safeNonnegativeIntegerSchema,
}).strict();

export const codexAccountingUsageSchema = z.object({
  format: z.literal("codex_v1"),
  summary: codexUsageSummarySchema,
  dailyUsageBuckets: z.array(codexDailyUsageBucketSchema).max(1_000).nullable(),
}).strict();
export type CodexAccountingUsage = z.infer<typeof codexAccountingUsageSchema>;

const providerUsageComponentBase = {
  version: z.literal(2),
  authority: usageProviderAccountAuthoritySchema,
  observationRevision: safeNonnegativeIntegerSchema,
  idempotencyKey: sha256Schema,
  sourceEventDigest: sha256Schema,
  componentDigest: sha256Schema,
  observedAt: unixMillisecondsSchema,
  receivedAt: unixMillisecondsSchema,
} as const;

const codexQuotaComponentSchema = z.object({
  ...providerUsageComponentBase,
  component: z.literal("quota"),
  source: z.literal("codex_app_server"),
  turn: z.null(),
  quota: codexQuotaUsageSchema,
}).strict();

const claudeQuotaComponentSchema = z.object({
  ...providerUsageComponentBase,
  component: z.literal("quota"),
  source: z.literal("claude_rate_limit_event"),
  turn: providerUsageTurnProvenanceSchema,
  quota: claudeQuotaUsageSchema,
}).strict();
export type ClaudeProviderUsageQuotaComponent = z.infer<typeof claudeQuotaComponentSchema>;

export const providerUsageQuotaComponentSchema = z.union([
  codexQuotaComponentSchema,
  claudeQuotaComponentSchema,
]).superRefine((value, context) => {
  const expectedProvider = value.source === "codex_app_server" ? "codex" : "claude";
  if (value.authority.provider !== expectedProvider) {
    context.addIssue({ code: "custom", message: "Usage quota source/provider mismatch." });
  }
  if (value.source === "claude_rate_limit_event" && value.observationRevision < 1) {
    context.addIssue({ code: "custom", message: "Claude quota revision must be positive." });
  }
  if (
    value.source === "claude_rate_limit_event"
    && value.receivedAt !== value.observedAt
  ) {
    context.addIssue({
      code: "custom",
      message: "Claude quota observation time must be its local receive time.",
    });
  }
});
export type ProviderUsageQuotaComponent = z.infer<typeof providerUsageQuotaComponentSchema>;

const codexAccountingComponentSchema = z.object({
  ...providerUsageComponentBase,
  component: z.literal("accounting"),
  source: z.literal("codex_app_server"),
  turn: z.null(),
  accounting: codexAccountingUsageSchema,
}).strict();

const claudeAccountingComponentSchema = z.object({
  ...providerUsageComponentBase,
  component: z.literal("accounting"),
  source: z.literal("claude_result"),
  turn: providerUsageTurnProvenanceSchema,
  accounting: claudeAccountingUsageSchema,
}).strict();
export type ClaudeProviderUsageAccountingComponent = z.infer<
  typeof claudeAccountingComponentSchema
>;

export const providerUsageAccountingComponentSchema = z.union([
  codexAccountingComponentSchema,
  claudeAccountingComponentSchema,
]).superRefine((value, context) => {
  const expectedProvider = value.source === "codex_app_server" ? "codex" : "claude";
  if (value.authority.provider !== expectedProvider) {
    context.addIssue({ code: "custom", message: "Usage accounting source/provider mismatch." });
  }
  if (value.source === "claude_result" && value.observationRevision < 1) {
    context.addIssue({ code: "custom", message: "Claude accounting revision must be positive." });
  }
  if (value.source === "claude_result" && value.receivedAt !== value.observedAt) {
    context.addIssue({
      code: "custom",
      message: "Claude accounting observation time must be its local receive time.",
    });
  }
});
export type ProviderUsageAccountingComponent = z.infer<
  typeof providerUsageAccountingComponentSchema
>;

export const providerUsageComponentSchema = z.union([
  providerUsageQuotaComponentSchema,
  providerUsageAccountingComponentSchema,
]);
export type ProviderUsageComponent = z.infer<typeof providerUsageComponentSchema>;

const sameAuthority = (
  left: UsageProviderAccountAuthority,
  right: UsageProviderAccountAuthority,
): boolean =>
  left.providerAccountId === right.providerAccountId
  && left.profileId === right.profileId
  && left.provider === right.provider
  && left.bindingGeneration === right.bindingGeneration
  && left.processGeneration === right.processGeneration;

export const providerUsageObservationV2Schema = z.object({
  version: z.literal(2),
  authority: usageProviderAccountAuthoritySchema,
  authorityMode: providerUsageAuthorityModeSchema,
  quota: providerUsageQuotaComponentSchema.nullable(),
  accounting: providerUsageAccountingComponentSchema.nullable(),
}).strict().superRefine((value, context) => {
  if (value.quota === null && value.accounting === null) {
    context.addIssue({ code: "custom", message: "Usage observation has no components." });
  }
  for (const component of [value.quota, value.accounting]) {
    if (component !== null && !sameAuthority(value.authority, component.authority)) {
      context.addIssue({ code: "custom", message: "Usage component authority mismatch." });
    }
  }
  if (
    value.authorityMode === "compatibility_display_only"
    && value.authority.provider !== "codex"
  ) {
    context.addIssue({
      code: "custom",
      message: "Only migrated Codex usage may be compatibility display-only.",
    });
  }
});
export type ProviderUsageObservationV2 = z.infer<typeof providerUsageObservationV2Schema>;

type CanonicalJson = null | boolean | number | string | readonly CanonicalJson[] | {
  readonly [key: string]: CanonicalJson;
};

const canonicalJsonValue = (value: unknown): CanonicalJson => {
  if (value === null || typeof value === "boolean" || typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map(canonicalJsonValue);
  if (typeof value === "object") {
    const result: Record<string, CanonicalJson> = Object.create(null) as Record<string, CanonicalJson>;
    for (const key of Object.keys(value).sort()) {
      const item = (value as Readonly<Record<string, unknown>>)[key];
      if (item === undefined) throw new Error("Provider usage canonical value contains undefined.");
      result[key] = canonicalJsonValue(item);
    }
    return result;
  }
  throw new Error("Provider usage canonical value is not JSON-safe.");
};

export const canonicalProviderUsageJson = (value: unknown): string =>
  JSON.stringify(canonicalJsonValue(value));

export const providerUsageDigest = (value: unknown): string =>
  createHash("sha256").update(canonicalProviderUsageJson(value)).digest("hex");

export function providerUsageIdempotencyKey(input: Readonly<{
  authority: UsageProviderAccountAuthority;
  component: ProviderUsageComponentKind;
  sessionId: string;
  turnId: string;
  sourceEventId: string;
}>): string {
  return providerUsageDigest({
    domain: "hra:provider-usage-component-idempotency:v2",
    authority: usageProviderAccountAuthoritySchema.parse(input.authority),
    component: providerUsageComponentKindSchema.parse(input.component),
    sessionId: sessionIdSchema.parse(input.sessionId),
    turnId: z.string().min(1).max(200).parse(input.turnId),
    sourceEventId: z.string().uuid().parse(input.sourceEventId),
  });
}

const unsignedComponent = (component: ProviderUsageComponent): Readonly<Record<string, unknown>> => {
  const unsigned: Record<string, unknown> = { ...component };
  delete unsigned.componentDigest;
  return unsigned;
};

export const computedProviderUsageComponentDigest = (
  component: ProviderUsageComponent,
): string => providerUsageDigest(unsignedComponent(component));

export function canonicalProviderUsageComponent(
  value: ProviderUsageComponent,
): ProviderUsageComponent {
  const parsed = providerUsageComponentSchema.parse(value);
  const canonical = parsed.component === "quota" && parsed.source === "claude_rate_limit_event"
    ? {
        ...parsed,
        quota: {
          ...parsed.quota,
          windows: [...parsed.quota.windows]
            .sort((left, right) => compareCanonicalString(left.id, right.id)),
        },
      }
    : parsed.component === "accounting" && parsed.source === "claude_result"
      ? {
          ...parsed,
          accounting: {
            ...parsed.accounting,
            models: [...parsed.accounting.models]
              .sort((left, right) => compareCanonicalString(left.model, right.model)),
          },
        }
      : parsed;
  const identities = canonical.component === "quota"
    ? canonical.quota.format === "claude_v1"
      ? canonical.quota.windows.map((window) => window.id)
      : canonical.quota.limits.map((limit) => limit.id)
    : canonical.accounting.format === "claude_v1"
      ? canonical.accounting.models.map((model) => model.model)
      : [];
  if (new Set(identities).size !== identities.length) {
    throw new Error("Provider usage component contains duplicate identities.");
  }
  const expectedDigest = providerUsageDigest(unsignedComponent(canonical));
  if (canonical.componentDigest !== expectedDigest) {
    throw new Error("PROVIDER_USAGE_COMPONENT_DIGEST_MISMATCH");
  }
  return providerUsageComponentSchema.parse(canonical);
}

type ClaudeComponentInputBase = Readonly<{
  authority: UsageProviderAccountAuthority;
  sessionId: string;
  turnId: string;
  sourceEventId: string;
  sourceEventDigest: string;
  observationRevision: number;
  observedAt: number;
  receivedAt: number;
}>;

export type CreateClaudeQuotaUsageComponentInput = ClaudeComponentInputBase & Readonly<{
  quota: Omit<ClaudeQuotaUsage, "format" | "windows"> & Readonly<{
    windows: readonly ProviderUsageWindow[];
  }>;
}>;

export function createClaudeQuotaUsageComponent(
  input: CreateClaudeQuotaUsageComponentInput,
): ClaudeProviderUsageQuotaComponent {
  const authority = usageProviderAccountAuthoritySchema.parse(input.authority);
  if (authority.provider !== "claude") throw new Error("Claude quota authority is not Claude.");
  const quota = claudeQuotaUsageSchema.parse({ ...input.quota, format: "claude_v1" });
  const sortedQuota: ClaudeQuotaUsage = {
    ...quota,
    windows: [...quota.windows]
      .sort((left, right) => compareCanonicalString(left.id, right.id)),
  };
  if (new Set(sortedQuota.windows.map((window) => window.id)).size !== sortedQuota.windows.length) {
    throw new Error("Claude quota windows contain duplicate ids.");
  }
  const unsigned = {
    version: 2 as const,
    authority,
    component: "quota" as const,
    source: "claude_rate_limit_event" as const,
    turn: providerUsageTurnProvenanceSchema.parse({
      sessionId: input.sessionId,
      turnId: input.turnId,
    }),
    observationRevision: safePositiveIntegerSchema.parse(input.observationRevision),
    idempotencyKey: providerUsageIdempotencyKey({
      authority,
      component: "quota",
      sessionId: input.sessionId,
      turnId: input.turnId,
      sourceEventId: input.sourceEventId,
    }),
    sourceEventDigest: sha256Schema.parse(input.sourceEventDigest),
    observedAt: unixMillisecondsSchema.parse(input.observedAt),
    receivedAt: unixMillisecondsSchema.parse(input.receivedAt),
    quota: sortedQuota,
  };
  return providerUsageQuotaComponentSchema.parse({
    ...unsigned,
    componentDigest: providerUsageDigest(unsigned),
  }) as ClaudeProviderUsageQuotaComponent;
}

export type CreateClaudeAccountingUsageComponentInput = ClaudeComponentInputBase & Readonly<{
  accounting: Omit<ClaudeAccountingUsage, "format" | "models"> & Readonly<{
    models: readonly ProviderUsageModelAccounting[];
  }>;
}>;

export function createClaudeAccountingUsageComponent(
  input: CreateClaudeAccountingUsageComponentInput,
): ClaudeProviderUsageAccountingComponent {
  const authority = usageProviderAccountAuthoritySchema.parse(input.authority);
  if (authority.provider !== "claude") throw new Error("Claude accounting authority is not Claude.");
  const accounting = claudeAccountingUsageSchema.parse({
    ...input.accounting,
    format: "claude_v1",
  });
  const sortedAccounting: ClaudeAccountingUsage = {
    ...accounting,
    models: [...accounting.models]
      .sort((left, right) => compareCanonicalString(left.model, right.model)),
  };
  if (
    new Set(sortedAccounting.models.map((model) => model.model)).size
      !== sortedAccounting.models.length
  ) throw new Error("Claude accounting contains duplicate model keys.");
  const unsigned = {
    version: 2 as const,
    authority,
    component: "accounting" as const,
    source: "claude_result" as const,
    turn: providerUsageTurnProvenanceSchema.parse({
      sessionId: input.sessionId,
      turnId: input.turnId,
    }),
    observationRevision: safePositiveIntegerSchema.parse(input.observationRevision),
    idempotencyKey: providerUsageIdempotencyKey({
      authority,
      component: "accounting",
      sessionId: input.sessionId,
      turnId: input.turnId,
      sourceEventId: input.sourceEventId,
    }),
    sourceEventDigest: sha256Schema.parse(input.sourceEventDigest),
    observedAt: unixMillisecondsSchema.parse(input.observedAt),
    receivedAt: unixMillisecondsSchema.parse(input.receivedAt),
    accounting: sortedAccounting,
  };
  return providerUsageAccountingComponentSchema.parse({
    ...unsigned,
    componentDigest: providerUsageDigest(unsigned),
  }) as ClaudeProviderUsageAccountingComponent;
}

const componentOrder = (left: ProviderUsageComponent, right: ProviderUsageComponent): number =>
  left.observedAt - right.observedAt
  || left.receivedAt - right.receivedAt
  || left.observationRevision - right.observationRevision
  || compareCanonicalString(left.idempotencyKey, right.idempotencyKey);

export function mergeProviderUsageComponents(input: Readonly<{
  components: readonly ProviderUsageComponent[];
  authorityMode?: ProviderUsageAuthorityMode;
}>): ProviderUsageObservationV2 | null {
  const components = input.components.map(canonicalProviderUsageComponent);
  const authority = components[0]?.authority;
  if (authority === undefined) return null;
  if (components.some((component) => !sameAuthority(authority, component.authority))) {
    throw new Error("PROVIDER_USAGE_AUTHORITY_MIXED");
  }
  const quota = components
    .filter((component): component is ProviderUsageQuotaComponent => component.component === "quota")
    .sort(componentOrder).at(-1) ?? null;
  const accounting = components
    .filter((component): component is ProviderUsageAccountingComponent =>
      component.component === "accounting")
    .sort(componentOrder).at(-1) ?? null;
  return providerUsageObservationV2Schema.parse({
    version: 2,
    authority,
    authorityMode: input.authorityMode ?? "mutation_authoritative",
    quota,
    accounting,
  });
}

const codexInputQuotaWindowSchema = z.object({
  usedPercent: z.number().finite().min(0).max(100),
  windowDurationMins: z.number().finite().nonnegative().nullable(),
  resetsAt: z.number().int().nonnegative().max(99_999_999_999).nullable(),
}).passthrough();

const codexInputQuotaLimitSchema = z.object({
  limitId: z.string().min(1).max(256).nullable(),
  limitName: z.string().min(1).max(256).nullable(),
  planType: z.string().min(1).max(128).nullable(),
  rateLimitReachedType: z.string().min(1).max(128).nullable(),
  primary: codexInputQuotaWindowSchema.nullable(),
  secondary: codexInputQuotaWindowSchema.nullable(),
}).passthrough();

// The projected v2 quota has one synthetic primary entry in addition to these
// keyed limits. Bound both the collection and the prefixed output id at the
// permissive v1 decode edge so malformed legacy provider data remains a
// display-only/null projection instead of throwing part-way through a read.
const codexInputByLimitIdSchema = z.record(
  z.string().min(1).max(250),
  codexInputQuotaLimitSchema,
).refine(
  (value) => Object.keys(value).length <= 100,
  "Codex usage contains too many keyed limits.",
);

const codexInputPayloadSchema = z.object({
  usage: z.object({
    summary: codexUsageSummarySchema,
    dailyUsageBuckets: z.array(codexDailyUsageBucketSchema).max(1_000).nullable(),
  }).passthrough(),
  rateLimits: z.object({
    primary: codexInputQuotaLimitSchema,
    byLimitId: codexInputByLimitIdSchema.nullable(),
    resetCreditsAvailable: safeNonnegativeIntegerSchema,
  }).passthrough(),
}).passthrough();

const codexWindow = (
  value: z.infer<typeof codexInputQuotaWindowSchema> | null,
): z.infer<typeof codexQuotaWindowSchema> | null => value === null ? null : ({
  usedPercent: value.usedPercent,
  windowDurationMins: value.windowDurationMins,
  resetsAtMs: value.resetsAt === null ? null : value.resetsAt * 1_000,
});

export type CodexV1UsageProjection = Readonly<{
  /** The original object reference; the adapter never rewrites stored v1 bytes. */
  legacySnapshot: StoredAccountUsageSnapshot;
  sourceRevision: number;
  observedAt: number;
  storedDigest: string;
  observation: ProviderUsageObservationV2 | null;
}>;

export function projectCodexV1Usage(input: Readonly<{
  snapshot: unknown;
  sourceRevision: number;
  observedAt: number;
  storedDigest: string;
  authority: UsageProviderAccountAuthority;
  authorityMode: ProviderUsageAuthorityMode;
}>): CodexV1UsageProjection {
  const parsedSnapshot = storedAccountUsageSnapshotSchema.parse(input.snapshot);
  // Validation is read-only: preserve the caller's exact v1 object/payload
  // rather than returning Zod's cloned projection.
  const snapshot = input.snapshot as StoredAccountUsageSnapshot;
  const sourceRevision = safeNonnegativeIntegerSchema.parse(input.sourceRevision);
  const observedAt = unixMillisecondsSchema.parse(input.observedAt);
  const storedDigest = sha256Schema.parse(input.storedDigest);
  const authority = usageProviderAccountAuthoritySchema.parse(input.authority);
  if (
    authority.provider !== "codex"
    || authority.processGeneration !== parsedSnapshot.observation.providerGeneration
  ) throw new Error("CODEX_USAGE_PROJECTION_AUTHORITY_MISMATCH");
  const providerPayload = codexInputPayloadSchema.safeParse(parsedSnapshot.providerPayload);
  if (!providerPayload.success) {
    return { legacySnapshot: snapshot, sourceRevision, observedAt, storedDigest, observation: null };
  }
  const limits = [
    ["legacy:primary", providerPayload.data.rateLimits.primary] as const,
    ...Object.entries(providerPayload.data.rateLimits.byLimitId ?? {})
      .sort(([left], [right]) => compareCanonicalString(left, right))
      .map(([key, value]) => [`limit:${key}`, value] as const),
  ].map(([id, limit]) => ({
    id,
    limitId: limit.limitId,
    limitName: limit.limitName,
    planType: limit.planType,
    rateLimitReachedType: limit.rateLimitReachedType,
    primary: codexWindow(limit.primary),
    secondary: codexWindow(limit.secondary),
  }));
  const base = {
    version: 2 as const,
    authority,
    source: "codex_app_server" as const,
    turn: null,
    observationRevision: sourceRevision,
    sourceEventDigest: storedDigest,
    observedAt,
    receivedAt: parsedSnapshot.observation.receivedAt,
  };
  const quotaUnsigned = {
    ...base,
    component: "quota" as const,
    idempotencyKey: providerUsageDigest({
      domain: "hra:codex-v1-usage-component:v2",
      authority,
      component: "quota",
      sourceRevision,
      storedDigest,
    }),
    quota: codexQuotaUsageSchema.parse({
      format: "codex_v1",
      resetCreditsAvailable: providerPayload.data.rateLimits.resetCreditsAvailable,
      limits,
    }),
  };
  const accountingUnsigned = {
    ...base,
    component: "accounting" as const,
    idempotencyKey: providerUsageDigest({
      domain: "hra:codex-v1-usage-component:v2",
      authority,
      component: "accounting",
      sourceRevision,
      storedDigest,
    }),
    accounting: codexAccountingUsageSchema.parse({
      format: "codex_v1",
      summary: providerPayload.data.usage.summary,
      dailyUsageBuckets: providerPayload.data.usage.dailyUsageBuckets,
    }),
  };
  const quota = providerUsageQuotaComponentSchema.parse({
    ...quotaUnsigned,
    componentDigest: providerUsageDigest(quotaUnsigned),
  });
  const accounting = providerUsageAccountingComponentSchema.parse({
    ...accountingUnsigned,
    componentDigest: providerUsageDigest(accountingUnsigned),
  });
  return {
    legacySnapshot: snapshot,
    sourceRevision,
    observedAt,
    storedDigest,
    observation: providerUsageObservationV2Schema.parse({
      version: 2,
      authority,
      authorityMode: input.authorityMode,
      quota,
      accounting,
    }),
  };
}
