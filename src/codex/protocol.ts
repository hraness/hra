import { createHash } from "node:crypto";

import { presetRequirements } from "../domain/presets.ts";
import type {
  InteractionDisplay,
  InteractionKind,
  InteractionResolution,
  ProviderInteractionAuthority,
  ProviderRequestId,
} from "../domain/interactions.ts";
import { CodexError } from "./errors.ts";
import {
  array,
  boolean,
  cursor,
  identifier,
  nullable,
  nullableString,
  number,
  oneOf,
  protocol,
  record,
  safeInteger,
  string,
  type UnknownRecord,
} from "./parse.ts";

export const PINNED_CODEX_VERSION = "0.149.0";

export type CodexServerRequestDisposition =
  | "brokered_interaction"
  | "internal_host_service"
  | "unsupported";

/**
 * Exhaustive `ServerRequest["method"]` matrix generated from the experimental
 * app-server bindings shipped by @openai/codex 0.149.0. Internal host services
 * remain unavailable until HRA advertises and witnesses the corresponding
 * capability; the client therefore rejects them without routing them to a
 * person.
 */
export const PINNED_CODEX_SERVER_REQUEST_MATRIX = Object.freeze({
  "item/commandExecution/requestApproval": "brokered_interaction",
  "item/fileChange/requestApproval": "brokered_interaction",
  "item/tool/requestUserInput": "brokered_interaction",
  "mcpServer/elicitation/request": "brokered_interaction",
  "item/permissions/requestApproval": "brokered_interaction",
  "item/tool/call": "internal_host_service",
  "account/chatgptAuthTokens/refresh": "internal_host_service",
  "attestation/generate": "internal_host_service",
  "currentTime/read": "internal_host_service",
  applyPatchApproval: "unsupported",
  execCommandApproval: "unsupported",
} as const satisfies Readonly<Record<string, CodexServerRequestDisposition>>);

export type PinnedCodexServerRequestMethod = keyof typeof PINNED_CODEX_SERVER_REQUEST_MATRIX;
export type BrokeredCodexServerRequestMethod = {
  readonly [Method in PinnedCodexServerRequestMethod]:
    (typeof PINNED_CODEX_SERVER_REQUEST_MATRIX)[Method] extends "brokered_interaction"
      ? Method
      : never;
}[PinnedCodexServerRequestMethod];

/** SHA-256 of the generated 0.149.0 `ServerRequest.ts` file, including experimental methods. */
export const PINNED_CODEX_SERVER_REQUEST_SCHEMA_DIGEST =
  "1c5837adbfbdd005f387478ba87840808d1353b47b82dcf63739a78bb1c8d3be";

const PINNED_CODEX_SERVER_REQUEST_MATRIX_DIGEST =
  "18ca3808834fec7ed6a60ed57469b694446a02c18cee39029d63d138fea0f61f";

export function assertPinnedCodexServerRequestMatrix(): void {
  const signature = `${PINNED_CODEX_VERSION}\n${Object.entries(PINNED_CODEX_SERVER_REQUEST_MATRIX)
    .map(([method, disposition]) => `${method}:${disposition}`)
    .join("\n")}`;
  const digest = createHash("sha256").update(signature).digest("hex");
  if (digest !== PINNED_CODEX_SERVER_REQUEST_MATRIX_DIGEST) {
    throw new CodexError(
      "RUNTIME_MISMATCH",
      "The pinned Codex server-request matrix does not match its reviewed schema",
    );
  }
}

export interface CodexAuthority {
  readonly profileId: string;
  readonly processGeneration: number;
}

export interface FencedCodexValue<T> {
  readonly authority: CodexAuthority;
  readonly value: T;
}

export type CodexOperationEffect = "read" | "auth" | "thread-mutation" | "turn-mutation";
export type LostResponsePolicy = "retry-read" | "reconcile";

export interface CodexOperationDescriptor {
  readonly method: CodexMethod;
  readonly effect: CodexOperationEffect;
  readonly deadlineMs: number;
  readonly lostResponse: LostResponsePolicy;
  readonly experimental: boolean;
}

export type CodexMethod =
  | "account/read"
  | "account/login/start"
  | "account/logout"
  | "account/rateLimits/read"
  | "account/usage/read"
  | "app/list"
  | "experimentalFeature/list"
  | "initialize"
  | "model/list"
  | "permissionProfile/list"
  | "plugin/list"
  | "thread/list"
  | "thread/items/list"
  | "thread/name/set"
  | "thread/read"
  | "thread/resume"
  | "thread/start"
  | "thread/turns/list"
  | "turn/interrupt"
  | "turn/start"
  | "turn/steer";

export const OPERATIONS: Readonly<Record<CodexMethod, CodexOperationDescriptor>> = {
  initialize: operation("initialize", "read", 10_000, "retry-read"),
  "account/read": operation("account/read", "read", 10_000, "retry-read"),
  "account/login/start": operation("account/login/start", "auth", 20_000, "reconcile"),
  "account/logout": operation("account/logout", "auth", 10_000, "reconcile"),
  "account/rateLimits/read": operation(
    "account/rateLimits/read",
    "read",
    15_000,
    "retry-read",
  ),
  "account/usage/read": operation("account/usage/read", "read", 15_000, "retry-read"),
  "model/list": operation("model/list", "read", 15_000, "retry-read"),
  "experimentalFeature/list": operation(
    "experimentalFeature/list",
    "read",
    15_000,
    "retry-read",
  ),
  "permissionProfile/list": operation(
    "permissionProfile/list",
    "read",
    15_000,
    "retry-read",
    true,
  ),
  "plugin/list": operation("plugin/list", "read", 20_000, "retry-read"),
  "app/list": operation("app/list", "read", 20_000, "retry-read", true),
  "thread/list": operation("thread/list", "read", 20_000, "retry-read"),
  "thread/items/list": operation("thread/items/list", "read", 20_000, "retry-read", true),
  "thread/read": operation("thread/read", "read", 20_000, "retry-read"),
  "thread/turns/list": operation("thread/turns/list", "read", 20_000, "retry-read", true),
  "thread/start": operation("thread/start", "thread-mutation", 30_000, "reconcile"),
  "thread/resume": operation("thread/resume", "thread-mutation", 30_000, "reconcile"),
  "thread/name/set": operation("thread/name/set", "thread-mutation", 15_000, "reconcile"),
  "turn/start": operation("turn/start", "turn-mutation", 30_000, "reconcile"),
  "turn/steer": operation("turn/steer", "turn-mutation", 20_000, "reconcile"),
  "turn/interrupt": operation("turn/interrupt", "turn-mutation", 15_000, "reconcile"),
};

function operation(
  method: CodexMethod,
  effect: CodexOperationEffect,
  deadlineMs: number,
  lostResponse: LostResponsePolicy,
  experimental = false,
): CodexOperationDescriptor {
  return { method, effect, deadlineMs, lostResponse, experimental };
}

export interface InitializeResult {
  readonly userAgent: string;
  readonly codexHome: string;
  readonly platformFamily: string;
  readonly platformOs: string;
}

export type CodexAccount =
  | { readonly type: "chatgpt"; readonly email: string | null; readonly planType: string }
  | { readonly type: "apiKey" }
  | {
      readonly type: "amazonBedrock";
      readonly credentialSource: "codexManaged" | "awsManaged";
    };

export interface AccountReadResult {
  readonly account: CodexAccount | null;
  readonly requiresOpenaiAuth: boolean;
}

export type ManagedLoginResult =
  | { readonly type: "chatgpt"; readonly loginId: string; readonly authUrl: string }
  | {
      readonly type: "chatgptDeviceCode";
      readonly loginId: string;
      readonly verificationUrl: string;
      readonly userCode: string;
    };

export interface AccountUsageSummary {
  readonly lifetimeTokens: number | null;
  readonly peakDailyTokens: number | null;
  readonly longestRunningTurnSec: number | null;
  readonly currentStreakDays: number | null;
  readonly longestStreakDays: number | null;
}

export interface DailyUsageBucket {
  readonly startDate: string;
  readonly tokens: number;
}

export interface AccountUsage {
  readonly summary: AccountUsageSummary;
  readonly dailyUsageBuckets: readonly DailyUsageBucket[] | null;
}

export interface RateLimitWindow {
  readonly usedPercent: number;
  readonly windowDurationMins: number | null;
  readonly resetsAt: number | null;
}

export interface RateLimitSnapshot {
  readonly limitId: string | null;
  readonly limitName: string | null;
  readonly primary: RateLimitWindow | null;
  readonly secondary: RateLimitWindow | null;
  readonly planType: string | null;
  readonly rateLimitReachedType: string | null;
}

export interface AccountRateLimits {
  readonly primary: RateLimitSnapshot;
  readonly byLimitId: Readonly<Record<string, RateLimitSnapshot>> | null;
}

export const REASONING_EFFORTS = [
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
] as const;
export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];

export interface CodexServiceTier {
  readonly id: string;
  readonly name: string;
  readonly description: string;
}

export interface CodexModel {
  readonly id: string;
  readonly model: string;
  readonly displayName: string;
  readonly hidden: boolean;
  readonly supportedReasoningEfforts: readonly ReasoningEffort[];
  readonly defaultReasoningEffort: ReasoningEffort;
  readonly serviceTiers: readonly CodexServiceTier[];
  readonly defaultServiceTier: string | null;
  readonly isDefault: boolean;
}

export type ExperimentalFeatureStage =
  | "beta"
  | "underDevelopment"
  | "stable"
  | "deprecated"
  | "removed";

export interface CodexFeature {
  readonly name: string;
  readonly stage: ExperimentalFeatureStage;
  readonly enabled: boolean;
  readonly defaultEnabled: boolean;
}

export interface PermissionProfile {
  readonly id: string;
  readonly description: string | null;
  readonly allowed: boolean;
}

export interface CodexApp {
  readonly id: string;
  readonly name: string;
  readonly description: string | null;
  readonly isAccessible: boolean;
  readonly isEnabled: boolean;
  readonly pluginDisplayNames: readonly string[];
}

export interface CodexPluginSummary {
  readonly id: string;
  readonly name: string;
  readonly displayName: string | null;
  readonly shortDescription: string | null;
  readonly developerName: string | null;
  readonly category: string | null;
  readonly capabilities: readonly string[];
  readonly keywords: readonly string[];
  readonly version: string | null;
  readonly localVersion: string | null;
  readonly sourceType: "local" | "git" | "npm" | "remote";
  readonly installed: boolean;
  readonly enabled: boolean;
  readonly installPolicy: "NOT_AVAILABLE" | "AVAILABLE" | "INSTALLED_BY_DEFAULT";
  readonly authPolicy: "ON_INSTALL" | "ON_USE";
  readonly availability: "AVAILABLE" | "DISABLED_BY_ADMIN";
  readonly disabledReason:
    | "disabled_by_admin"
    | "plan_not_eligible"
    | "required_app_unavailable"
    | "unknown"
    | null;
  readonly eligiblePlanTypes: readonly string[] | null;
}

export interface CodexPluginMarketplace {
  readonly name: string;
  readonly displayName: string | null;
  readonly plugins: readonly CodexPluginSummary[];
}

export interface CodexPluginCatalog {
  readonly marketplaces: readonly CodexPluginMarketplace[];
  readonly featuredPluginIds: readonly string[];
  /** Upstream messages may contain local paths, so HRA exposes only the count. */
  readonly marketplaceLoadErrorCount: number;
  readonly lifecycle: Readonly<{
    readonly discovery: "available";
    readonly install: "blocked_compound_upstream_effect";
    readonly enablement: "no_separate_pinned_method";
    readonly oauth: "separate_foreground_only";
  }>;
}

export interface CodexCapabilitySnapshot {
  readonly models: readonly CodexModel[];
  readonly features: readonly CodexFeature[];
  readonly permissionProfiles: readonly PermissionProfile[] | null;
  readonly apps: readonly CodexApp[] | null;
  readonly pluginLifecycle: "unsupported-under-development";
}

export type PresetAlias = "low" | "high" | "ultra";

export interface ResolvedPreset {
  readonly alias: PresetAlias;
  readonly model: string;
  readonly effort: ReasoningEffort;
  readonly serviceTier: string | null;
  readonly fast: boolean;
}

export type CodexThreadStatus =
  | { readonly type: "notLoaded" | "idle" | "systemError" }
  | { readonly type: "active"; readonly activeFlags: readonly string[] };

export type CodexTurnStatus = "completed" | "interrupted" | "failed" | "inProgress";

export type CodexThreadItem =
  | {
      readonly type: "userMessage";
      readonly id: string;
      readonly clientId: string | null;
      readonly text: readonly string[];
    }
  | { readonly type: "agentMessage"; readonly id: string; readonly text: string }
  | { readonly type: "reasoning"; readonly id: string; readonly summary: readonly string[] }
  | {
      readonly type: "commandExecution";
      readonly id: string;
      readonly command: string;
      readonly cwd: string;
      readonly status: string;
      readonly exitCode: number | null;
      readonly durationMs: number | null;
    }
  | {
      readonly type: "fileChange";
      readonly id: string;
      readonly status: string;
      readonly changedPaths: readonly string[];
    }
  | {
      readonly type: "mcpToolCall";
      readonly id: string;
      readonly server: string;
      readonly tool: string;
      readonly status: string;
      readonly pluginId: string | null;
      readonly durationMs: number | null;
    }
  | { readonly type: "unsupported"; readonly id: string; readonly providerType: string };

export interface CodexTurn {
  readonly id: string;
  readonly items: readonly CodexThreadItem[];
  readonly status: CodexTurnStatus;
  readonly startedAt: number | null;
  readonly completedAt: number | null;
  readonly durationMs: number | null;
}

export interface CodexThread {
  readonly id: string;
  readonly sessionId: string;
  readonly preview: string;
  readonly ephemeral: boolean;
  readonly modelProvider: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly status: CodexThreadStatus;
  readonly cwd: string;
  readonly name: string | null;
  readonly turns: readonly CodexTurn[];
}

export type CodexApprovalPolicy =
  | "untrusted"
  | "on-request"
  | "never"
  | {
      readonly granular: {
        readonly mcpElicitations: boolean;
        readonly requestPermissions: boolean;
        readonly rules: boolean;
        readonly sandboxApproval: boolean;
        readonly skillApproval: boolean;
      };
    };

export type CodexSandboxPolicy =
  | { readonly type: "dangerFullAccess" }
  | { readonly type: "readOnly"; readonly networkAccess: boolean }
  | { readonly type: "externalSandbox"; readonly networkAccess: "restricted" | "enabled" }
  | {
      readonly type: "workspaceWrite";
      readonly writableRoots: readonly string[];
      readonly networkAccess: boolean;
      readonly excludeTmpdirEnvVar: boolean;
      readonly excludeSlashTmp: boolean;
    };

export interface ThreadStartResult {
  readonly thread: CodexThread;
  readonly cwd: string;
  readonly model: string;
  readonly modelProvider: string;
  readonly reasoningEffort: string | null;
  readonly serviceTier: string | null;
  readonly approvalPolicy: CodexApprovalPolicy;
  readonly approvalsReviewer: "user" | "auto_review" | "guardian_subagent";
  readonly sandbox: CodexSandboxPolicy;
  readonly activePermissionProfile: { readonly id: string; readonly extends: string | null } | null;
  readonly runtimeWorkspaceRoots: readonly string[];
}

export interface Page<T> {
  readonly data: readonly T[];
  readonly nextCursor: string | null;
}

export interface ThreadPage extends Page<CodexThread> {
  readonly backwardsCursor: string | null;
}

export interface TurnPage extends Page<CodexTurn> {
  readonly backwardsCursor: string | null;
}

export interface CodexThreadItemEntry {
  readonly turnId: string;
  readonly item: CodexThreadItem;
}

export interface ThreadItemPage extends Page<CodexThreadItemEntry> {
  readonly backwardsCursor: string | null;
}

export interface TurnStartResult {
  readonly turn: CodexTurn;
}

type CodexFactBody =
  | { readonly type: "providerConnected"; readonly connectionId: string }
  | {
      readonly type: "providerDisconnected";
      readonly connectionId: string;
      readonly reason: "eof" | "process_exit" | "closed" | "protocol_fault";
    }
  | { readonly type: "accountUpdated"; readonly authMode: string | null; readonly planType: string | null }
  | { readonly type: "loginCompleted"; readonly loginId: string | null; readonly success: boolean }
  | { readonly type: "threadStatusChanged"; readonly threadId: string; readonly status: CodexThreadStatus }
  | { readonly type: "turnStarted"; readonly threadId: string; readonly turn: CodexTurn }
  | { readonly type: "turnCompleted"; readonly threadId: string; readonly turn: CodexTurn }
  | { readonly type: "threadNameUpdated"; readonly threadId: string; readonly name: string | null }
  | {
      readonly type: "itemStarted" | "itemCompleted";
      readonly threadId: string;
      readonly turnId: string;
      readonly itemId: string;
      readonly itemKind: string;
      readonly status?: string;
      readonly server?: string;
      readonly tool?: string;
    }
  | {
      readonly type: "assistantDelta";
      readonly threadId: string;
      readonly turnId: string;
      readonly itemId: string;
      readonly text: string;
    }
  | {
      readonly type: "reasoningSummaryDelta";
      readonly threadId: string;
      readonly turnId: string;
      readonly itemId: string;
      readonly summaryIndex: number;
      readonly text: string;
    }
  | {
      readonly type: "toolProgress";
      readonly threadId: string;
      readonly turnId: string;
      readonly itemId: string;
      readonly toolKind: string;
      readonly status?: string;
      readonly outputBytesObserved?: number;
      readonly server?: string;
      readonly tool?: string;
    }
  | {
      readonly type: "planUpdated";
      readonly threadId: string;
      readonly turnId: string;
      readonly explanation?: string;
      readonly steps: readonly {
        readonly text: string;
        readonly status: "pending" | "in_progress" | "completed";
      }[];
    }
  | {
      readonly type: "diffUpdated";
      readonly threadId: string;
      readonly turnId: string;
      readonly changedFiles: number;
      readonly patchBytesObserved: number;
    }
  | {
      readonly type: "tokenUsageUpdated";
      readonly threadId: string;
      readonly turnId: string;
      readonly inputTokens: number;
      readonly cachedInputTokens: number;
      readonly outputTokens: number;
      readonly reasoningOutputTokens: number;
      readonly totalTokens: number;
      readonly modelContextWindow: number | null;
    }
  | {
      readonly type: "providerWarning";
      readonly threadId: string;
      readonly code: string;
      readonly message: string;
    }
  | {
      readonly type: "providerError";
      readonly threadId: string;
      readonly turnId: string;
      readonly code: string;
      readonly message: string;
      readonly terminal: boolean;
    }
  | {
      readonly type: "interactionRequested";
      readonly provider: ProviderInteractionAuthority;
      readonly kind: InteractionKind;
      readonly blocking: boolean;
      readonly display: InteractionDisplay;
    }
  | {
      readonly type: "interactionResolved";
      readonly provider: ProviderInteractionAuthority;
      readonly kind: InteractionKind;
    }
  | {
      readonly type: "serverRequestResolved";
      readonly threadId: string;
      readonly requestId: ProviderRequestId;
    }
  | { readonly type: "protocolNotice"; readonly method: string };

/**
 * The client adds its random connection nonce to every notification fact. Old
 * synthetic tests and read-model facts may omit it, so the field remains
 * optional outside connection and interaction facts.
 */
export type CodexFact = CodexFactBody & { readonly connectionId?: string };

export interface ParsedBrokeredCodexServerRequest {
  readonly provider: ProviderInteractionAuthority;
  readonly kind: InteractionKind;
  readonly blocking: boolean;
  readonly display: InteractionDisplay;
  /** Kept only in process memory for exact response validation. */
  readonly privateParams: Readonly<Record<string, unknown>>;
}

export function parseInitialize(value: unknown): InitializeResult {
  const root = record(value, "initialize result");
  return {
    userAgent: string(root.userAgent, "initialize.userAgent", { min: 1, max: 1_024 }),
    codexHome: string(root.codexHome, "initialize.codexHome", { min: 1, max: 16_384 }),
    platformFamily: string(root.platformFamily, "initialize.platformFamily", {
      min: 1,
      max: 128,
    }),
    platformOs: string(root.platformOs, "initialize.platformOs", { min: 1, max: 128 }),
  };
}

export function parseAccountRead(value: unknown): AccountReadResult {
  const root = record(value, "account/read result");
  return {
    account: root.account === null ? null : parseAccount(root.account),
    requiresOpenaiAuth: boolean(root.requiresOpenaiAuth, "account.requiresOpenaiAuth"),
  };
}

function parseAccount(value: unknown): CodexAccount {
  const root = record(value, "account");
  const type = string(root.type, "account.type", { min: 1, max: 128 });
  if (type === "apiKey") return { type };
  if (type === "chatgpt") {
    return {
      type,
      email: nullableString(root.email, "account.email", 1_024),
      planType: string(root.planType, "account.planType", { min: 1, max: 128 }),
    };
  }
  if (type === "amazonBedrock") {
    return {
      type,
      credentialSource: oneOf(
        root.credentialSource,
        "account.credentialSource",
        ["codexManaged", "awsManaged"] as const,
      ),
    };
  }
  throw protocol("account.type is unsupported by this pinned adapter");
}

export function parseManagedLogin(value: unknown): ManagedLoginResult {
  const root = record(value, "account/login/start result");
  const type = string(root.type, "login.type", { min: 1, max: 128 });
  if (type === "chatgpt") {
    return {
      type,
      loginId: identifier(root.loginId, "login.loginId"),
      authUrl: safeHttpUrl(root.authUrl, "login.authUrl"),
    };
  }
  if (type === "chatgptDeviceCode") {
    return {
      type,
      loginId: identifier(root.loginId, "login.loginId"),
      verificationUrl: safeHttpUrl(root.verificationUrl, "login.verificationUrl"),
      userCode: string(root.userCode, "login.userCode", { min: 1, max: 128 }),
    };
  }
  throw protocol("login result is not a managed ChatGPT login");
}

export function parseAccountUsage(value: unknown): AccountUsage {
  const root = record(value, "account/usage/read result");
  const summary = record(root.summary, "usage.summary");
  return {
    summary: {
      lifetimeTokens: nullableNonnegativeInteger(summary.lifetimeTokens, "usage.lifetimeTokens"),
      peakDailyTokens: nullableNonnegativeInteger(summary.peakDailyTokens, "usage.peakDailyTokens"),
      longestRunningTurnSec: nullableNonnegativeInteger(
        summary.longestRunningTurnSec,
        "usage.longestRunningTurnSec",
      ),
      currentStreakDays: nullableNonnegativeInteger(
        summary.currentStreakDays,
        "usage.currentStreakDays",
      ),
      longestStreakDays: nullableNonnegativeInteger(
        summary.longestStreakDays,
        "usage.longestStreakDays",
      ),
    },
    dailyUsageBuckets:
      root.dailyUsageBuckets === null
        ? null
        : array(root.dailyUsageBuckets, "usage.dailyUsageBuckets", parseDailyUsageBucket, 1_000),
  };
}

function parseDailyUsageBucket(value: unknown, index: number): DailyUsageBucket {
  const root = record(value, `usage.dailyUsageBuckets[${String(index)}]`);
  const startDate = string(root.startDate, "usage bucket startDate", { min: 10, max: 10 });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate)) throw protocol("usage bucket date is invalid");
  return {
    startDate,
    tokens: nonnegativeInteger(root.tokens, "usage bucket tokens"),
  };
}

export function parseRateLimits(value: unknown): AccountRateLimits {
  const root = record(value, "account/rateLimits/read result");
  let byLimitId: Record<string, RateLimitSnapshot> | null = null;
  if (root.rateLimitsByLimitId !== null) {
    const source = record(root.rateLimitsByLimitId, "rateLimitsByLimitId");
    const entries = Object.entries(source);
    if (entries.length > 100) throw protocol("rateLimitsByLimitId is too large");
    byLimitId = Object.create(null) as Record<string, RateLimitSnapshot>;
    for (const [key, item] of entries) {
      if (key.length < 1 || key.length > 256) throw protocol("rate limit id is invalid");
      byLimitId[key] = parseRateLimitSnapshot(item, `rateLimitsByLimitId.${key}`);
    }
  }
  return {
    primary: parseRateLimitSnapshot(root.rateLimits, "rateLimits"),
    byLimitId,
  };
}

function parseRateLimitSnapshot(value: unknown, label: string): RateLimitSnapshot {
  const root = record(value, label);
  return {
    limitId: nullableString(root.limitId, `${label}.limitId`, 256),
    limitName: nullableString(root.limitName, `${label}.limitName`, 512),
    primary: nullable(root.primary, (item) => parseRateLimitWindow(item, `${label}.primary`)),
    secondary: nullable(root.secondary, (item) => parseRateLimitWindow(item, `${label}.secondary`)),
    planType: nullableString(root.planType, `${label}.planType`, 128),
    rateLimitReachedType: nullableString(
      root.rateLimitReachedType,
      `${label}.rateLimitReachedType`,
      128,
    ),
  };
}

function parseRateLimitWindow(value: unknown, label: string): RateLimitWindow {
  const root = record(value, label);
  const usedPercent = number(root.usedPercent, `${label}.usedPercent`);
  if (usedPercent < 0 || usedPercent > 100_000) throw protocol(`${label}.usedPercent is invalid`);
  return {
    usedPercent,
    windowDurationMins: nullableNonnegativeNumber(
      root.windowDurationMins,
      `${label}.windowDurationMins`,
    ),
    resetsAt: nullableNonnegativeNumber(root.resetsAt, `${label}.resetsAt`),
  };
}

export function parseModelPage(value: unknown): Page<CodexModel> {
  const root = record(value, "model/list result");
  return {
    data: array(root.data, "models", parseModel, 500),
    nextCursor: cursor(root.nextCursor, "models.nextCursor"),
  };
}

function parseModel(value: unknown, index: number): CodexModel {
  const root = record(value, `models[${String(index)}]`);
  const effortOptions = array(
    root.supportedReasoningEfforts,
    "model.supportedReasoningEfforts",
    (item) => {
      const option = record(item, "reasoning effort option");
      return oneOf(option.reasoningEffort, "reasoning effort", REASONING_EFFORTS);
    },
    32,
  );
  return {
    id: identifier(root.id, "model.id"),
    model: identifier(root.model, "model.model"),
    displayName: string(root.displayName, "model.displayName", { min: 1, max: 512 }),
    hidden: boolean(root.hidden, "model.hidden"),
    supportedReasoningEfforts: effortOptions,
    defaultReasoningEffort: oneOf(
      root.defaultReasoningEffort,
      "model.defaultReasoningEffort",
      REASONING_EFFORTS,
    ),
    serviceTiers: array(root.serviceTiers ?? [], "model.serviceTiers", parseServiceTier, 32),
    defaultServiceTier: nullableString(
      root.defaultServiceTier ?? null,
      "model.defaultServiceTier",
      128,
    ),
    isDefault: boolean(root.isDefault, "model.isDefault"),
  };
}

function parseServiceTier(value: unknown, index: number): CodexServiceTier {
  const root = record(value, `serviceTiers[${String(index)}]`);
  return {
    id: identifier(root.id, "serviceTier.id"),
    name: string(root.name, "serviceTier.name", { min: 1, max: 256 }),
    description: string(root.description, "serviceTier.description", { max: 2_048 }),
  };
}

export function parseFeaturePage(value: unknown): Page<CodexFeature> {
  const root = record(value, "experimentalFeature/list result");
  return {
    data: array(root.data, "features", (item, index) => {
      const feature = record(item, `features[${String(index)}]`);
      return {
        name: identifier(feature.name, "feature.name"),
        stage: oneOf(
          feature.stage,
          "feature.stage",
          ["beta", "underDevelopment", "stable", "deprecated", "removed"] as const,
        ),
        enabled: boolean(feature.enabled, "feature.enabled"),
        defaultEnabled: boolean(feature.defaultEnabled, "feature.defaultEnabled"),
      };
    }, 500),
    nextCursor: cursor(root.nextCursor, "features.nextCursor"),
  };
}

export function parsePermissionProfilePage(value: unknown): Page<PermissionProfile> {
  const root = record(value, "permissionProfile/list result");
  return {
    data: array(root.data, "permission profiles", (item, index) => {
      const profile = record(item, `permission profiles[${String(index)}]`);
      return {
        id: identifier(profile.id, "permission profile id"),
        description: nullableString(profile.description, "permission profile description", 2_048),
        allowed: boolean(profile.allowed, "permission profile allowed"),
      };
    }, 200),
    nextCursor: cursor(root.nextCursor, "permissionProfiles.nextCursor"),
  };
}

export function parseAppPage(value: unknown): Page<CodexApp> {
  const root = record(value, "app/list result");
  return {
    data: array(root.data, "apps", (item, index) => {
      const app = record(item, `apps[${String(index)}]`);
      return {
        id: identifier(app.id, "app.id"),
        name: string(app.name, "app.name", { min: 1, max: 512 }),
        description: nullableString(app.description, "app.description", 4_096),
        isAccessible: boolean(app.isAccessible, "app.isAccessible"),
        isEnabled: boolean(app.isEnabled, "app.isEnabled"),
        pluginDisplayNames: array(
          app.pluginDisplayNames ?? [],
          "app.pluginDisplayNames",
          (name) => string(name, "plugin display name", { min: 1, max: 512 }),
          100,
        ),
      };
    }, 1_000),
    nextCursor: cursor(root.nextCursor, "apps.nextCursor"),
  };
}

const parsePluginInterface = (
  value: unknown,
  label: string,
): Pick<
  CodexPluginSummary,
  "displayName" | "shortDescription" | "developerName" | "category" | "capabilities"
> => {
  if (value === null) {
    return {
      displayName: null,
      shortDescription: null,
      developerName: null,
      category: null,
      capabilities: [],
    };
  }
  const pluginInterface = record(value, label);
  return {
    displayName: nullableString(pluginInterface.displayName, `${label}.displayName`, 512),
    shortDescription: nullableString(
      pluginInterface.shortDescription,
      `${label}.shortDescription`,
      4_096,
    ),
    developerName: nullableString(pluginInterface.developerName, `${label}.developerName`, 512),
    category: nullableString(pluginInterface.category, `${label}.category`, 512),
    capabilities: array(
      pluginInterface.capabilities,
      `${label}.capabilities`,
      (entry) => string(entry, "plugin capability", { min: 1, max: 512 }),
      100,
    ),
  };
};

const parsePluginSummary = (value: unknown, label: string): CodexPluginSummary => {
  const plugin = record(value, label);
  const source = record(plugin.source, `${label}.source`);
  const eligiblePlanTypes = plugin.eligiblePlanTypes === null
    ? null
    : array(
      plugin.eligiblePlanTypes,
      `${label}.eligiblePlanTypes`,
      (entry) => string(entry, "eligible plan type", { min: 1, max: 256 }),
      100,
    );
  const disabledReason = plugin.disabledReason === null
    ? null
    : oneOf(
      plugin.disabledReason,
      `${label}.disabledReason`,
      [
        "disabled_by_admin",
        "plan_not_eligible",
        "required_app_unavailable",
        "unknown",
      ] as const,
    );
  return {
    id: identifier(plugin.id, `${label}.id`),
    name: string(plugin.name, `${label}.name`, { min: 1, max: 512 }),
    ...parsePluginInterface(plugin.interface, `${label}.interface`),
    keywords: array(
      plugin.keywords,
      `${label}.keywords`,
      (entry) => string(entry, "plugin keyword", { min: 1, max: 256 }),
      100,
    ),
    version: nullableString(plugin.version, `${label}.version`, 256),
    localVersion: nullableString(plugin.localVersion, `${label}.localVersion`, 256),
    sourceType: oneOf(
      source.type,
      `${label}.source.type`,
      ["local", "git", "npm", "remote"] as const,
    ),
    installed: boolean(plugin.installed, `${label}.installed`),
    enabled: boolean(plugin.enabled, `${label}.enabled`),
    installPolicy: oneOf(
      plugin.installPolicy,
      `${label}.installPolicy`,
      ["NOT_AVAILABLE", "AVAILABLE", "INSTALLED_BY_DEFAULT"] as const,
    ),
    authPolicy: oneOf(
      plugin.authPolicy,
      `${label}.authPolicy`,
      ["ON_INSTALL", "ON_USE"] as const,
    ),
    availability: oneOf(
      plugin.availability,
      `${label}.availability`,
      ["AVAILABLE", "DISABLED_BY_ADMIN"] as const,
    ),
    disabledReason,
    eligiblePlanTypes,
  };
};

export function parsePluginCatalog(value: unknown): CodexPluginCatalog {
  const root = record(value, "plugin/list result");
  const loadErrors = array(
    root.marketplaceLoadErrors,
    "plugin marketplace load errors",
    (entry, index) => record(entry, `plugin marketplace load errors[${String(index)}]`),
    100,
  );
  return {
    marketplaces: array(
      root.marketplaces,
      "plugin marketplaces",
      (entry, marketplaceIndex) => {
        const marketplace = record(
          entry,
          `plugin marketplaces[${String(marketplaceIndex)}]`,
        );
        const marketplaceInterface = marketplace.interface === null
          ? null
          : record(
            marketplace.interface,
            `plugin marketplaces[${String(marketplaceIndex)}].interface`,
          );
        return {
          name: identifier(marketplace.name, "plugin marketplace name"),
          displayName: marketplaceInterface === null
            ? null
            : nullableString(
              marketplaceInterface.displayName,
              "plugin marketplace display name",
              512,
            ),
          plugins: array(
            marketplace.plugins,
            "marketplace plugins",
            (plugin, pluginIndex) => parsePluginSummary(
              plugin,
              `plugin marketplaces[${String(marketplaceIndex)}].plugins[${String(pluginIndex)}]`,
            ),
            5_000,
          ),
        };
      },
      100,
    ),
    featuredPluginIds: array(
      root.featuredPluginIds,
      "featured plugin ids",
      (entry) => identifier(entry, "featured plugin id"),
      1_000,
    ),
    marketplaceLoadErrorCount: loadErrors.length,
    lifecycle: {
      discovery: "available",
      install: "blocked_compound_upstream_effect",
      enablement: "no_separate_pinned_method",
      oauth: "separate_foreground_only",
    },
  };
}

export function parseThreadPage(value: unknown): ThreadPage {
  const root = record(value, "thread/list result");
  return {
    data: array(root.data, "threads", parseThread, 500),
    nextCursor: cursor(root.nextCursor, "threads.nextCursor"),
    backwardsCursor: cursor(root.backwardsCursor ?? null, "threads.backwardsCursor"),
  };
}

/** Pinned experimental response for `thread/turns/list`. */
export function parseThreadTurnsPage(value: unknown): TurnPage {
  const root = record(value, "thread/turns/list result");
  return {
    data: array(root.data, "turns", parseTurn, 500),
    nextCursor: cursor(root.nextCursor, "turns.nextCursor"),
    backwardsCursor: cursor(root.backwardsCursor, "turns.backwardsCursor"),
  };
}

/** Pinned experimental response for `thread/items/list`. */
export function parseThreadItemsPage(value: unknown): ThreadItemPage {
  const root = record(value, "thread/items/list result");
  return {
    data: array(root.data, "thread items", (value, index) => {
      const entry = record(value, `thread items[${String(index)}]`);
      return {
        turnId: identifier(entry.turnId, "thread item turn id"),
        item: parseThreadItem(entry.item, index),
      };
    }, 1_000),
    nextCursor: cursor(root.nextCursor, "thread items.nextCursor"),
    backwardsCursor: cursor(root.backwardsCursor, "thread items.backwardsCursor"),
  };
}

export function parseThreadRead(value: unknown): CodexThread {
  return parseThread(record(value, "thread/read result").thread, 0);
}

export function parseThreadMetadataRead(value: unknown): CodexThread {
  const thread = record(record(value, "thread/read result").thread, "thread metadata");
  if (thread.turns !== undefined && (!Array.isArray(thread.turns) || thread.turns.length !== 0)) {
    throw protocol("metadata-only thread/read unexpectedly included turns");
  }
  return parseThread(thread, 0);
}

export function parseThreadMutation(value: unknown): CodexThread {
  return parseThread(record(value, "thread mutation result").thread, 0);
}

/** Exact pinned 0.149.0 `thread/start` response, including effective policy. */
export function parseThreadStart(value: unknown): ThreadStartResult {
  const root = record(value, "thread/start result");
  const activePermissionProfile = root.activePermissionProfile === null || root.activePermissionProfile === undefined
    ? null
    : (() => {
        const profile = record(root.activePermissionProfile, "thread/start active permission profile");
        return {
          id: identifier(profile.id, "thread/start active permission profile id"),
          extends: nullableString(profile.extends ?? null, "thread/start active permission profile parent", 512),
        };
      })();
  return {
    thread: parseThread(root.thread, 0),
    cwd: string(root.cwd, "thread/start cwd", { min: 1, max: 16_384 }),
    model: identifier(root.model, "thread/start model"),
    modelProvider: identifier(root.modelProvider, "thread/start model provider"),
    reasoningEffort: nullableString(root.reasoningEffort ?? null, "thread/start reasoning effort", 128),
    serviceTier: nullableString(root.serviceTier ?? null, "thread/start service tier", 128),
    approvalPolicy: parseApprovalPolicy(root.approvalPolicy),
    approvalsReviewer: oneOf(
      root.approvalsReviewer,
      "thread/start approvals reviewer",
      ["user", "auto_review", "guardian_subagent"] as const,
    ),
    sandbox: parseSandboxPolicy(root.sandbox),
    activePermissionProfile,
    runtimeWorkspaceRoots: array(
      root.runtimeWorkspaceRoots ?? [],
      "thread/start runtime workspace roots",
      (item) => string(item, "thread/start runtime workspace root", { min: 1, max: 16_384 }),
      32,
    ),
  };
}

function parseApprovalPolicy(value: unknown): CodexApprovalPolicy {
  if (typeof value === "string") {
    return oneOf(value, "thread/start approval policy", ["untrusted", "on-request", "never"] as const);
  }
  const root = record(value, "thread/start approval policy");
  const granular = record(root.granular, "thread/start granular approval policy");
  return {
    granular: {
      mcpElicitations: boolean(granular.mcp_elicitations, "approval policy mcp_elicitations"),
      requestPermissions: boolean(granular.request_permissions ?? false, "approval policy request_permissions"),
      rules: boolean(granular.rules, "approval policy rules"),
      sandboxApproval: boolean(granular.sandbox_approval, "approval policy sandbox_approval"),
      skillApproval: boolean(granular.skill_approval ?? false, "approval policy skill_approval"),
    },
  };
}

function parseSandboxPolicy(value: unknown): CodexSandboxPolicy {
  const root = record(value, "thread/start sandbox policy");
  const type = oneOf(
    root.type,
    "thread/start sandbox policy type",
    ["dangerFullAccess", "readOnly", "externalSandbox", "workspaceWrite"] as const,
  );
  if (type === "dangerFullAccess") return { type };
  if (type === "readOnly") {
    return { type, networkAccess: boolean(root.networkAccess ?? false, "read-only network access") };
  }
  if (type === "externalSandbox") {
    return {
      type,
      networkAccess: oneOf(
        root.networkAccess ?? "restricted",
        "external sandbox network access",
        ["restricted", "enabled"] as const,
      ),
    };
  }
  return {
    type,
    writableRoots: array(
      root.writableRoots ?? [],
      "workspace-write roots",
      (item) => string(item, "workspace-write root", { min: 1, max: 16_384 }),
      32,
    ),
    networkAccess: boolean(root.networkAccess ?? false, "workspace-write network access"),
    excludeTmpdirEnvVar: boolean(root.excludeTmpdirEnvVar ?? false, "workspace-write exclude TMPDIR"),
    excludeSlashTmp: boolean(root.excludeSlashTmp ?? false, "workspace-write exclude /tmp"),
  };
}

function parseThread(value: unknown, index: number): CodexThread {
  const root = record(value, `threads[${String(index)}]`);
  return {
    id: identifier(root.id, "thread.id"),
    sessionId: identifier(root.sessionId ?? root.id, "thread.sessionId"),
    preview: string(root.preview, "thread.preview", { max: 32_768 }),
    ephemeral: boolean(root.ephemeral, "thread.ephemeral"),
    modelProvider: identifier(root.modelProvider, "thread.modelProvider"),
    createdAt: nonnegativeNumber(root.createdAt, "thread.createdAt"),
    updatedAt: nonnegativeNumber(root.updatedAt, "thread.updatedAt"),
    status: parseThreadStatus(root.status),
    cwd: string(root.cwd, "thread.cwd", { min: 1, max: 16_384 }),
    name: nullableString(root.name, "thread.name", 1_024),
    turns: array(root.turns ?? [], "thread.turns", parseTurn, 10_000),
  };
}

export function parseTurnStart(value: unknown): TurnStartResult {
  return { turn: parseTurn(record(value, "turn/start result").turn, 0) };
}

export function parseTurn(value: unknown, index: number): CodexTurn {
  const root = record(value, `turns[${String(index)}]`);
  return {
    id: identifier(root.id, "turn.id"),
    items: array(root.items ?? [], "turn.items", parseThreadItem, 50_000),
    status: oneOf(
      root.status,
      "turn.status",
      ["completed", "interrupted", "failed", "inProgress"] as const,
    ),
    startedAt: nullableNonnegativeNumber(root.startedAt, "turn.startedAt"),
    completedAt: nullableNonnegativeNumber(root.completedAt, "turn.completedAt"),
    durationMs: nullableNonnegativeNumber(root.durationMs, "turn.durationMs"),
  };
}

function parseThreadItem(value: unknown, index: number): CodexThreadItem {
  const root = record(value, `turn.items[${String(index)}]`);
  const providerType = string(root.type, "thread item type", { min: 1, max: 128 });
  const id = identifier(root.id ?? `unsupported-${String(index)}`, "thread item id");
  if (providerType === "agentMessage") {
    return { type: providerType, id, text: string(root.text, "agent message", { max: 2_000_000 }) };
  }
  if (providerType === "userMessage") {
    const content = array(root.content, "user message content", (item) => item, 1_000);
    const textItems: string[] = [];
    for (const item of content) {
      const input = record(item, "user input");
      if (input.type === "text") {
        textItems.push(string(input.text, "user input text", { max: 2_000_000 }));
      }
    }
    return {
      type: providerType,
      id,
      clientId: nullableString(root.clientId ?? null, "user message client id", 512),
      text: textItems,
    };
  }
  if (providerType === "reasoning") {
    return {
      type: providerType,
      id,
      summary: array(
        root.summary,
        "reasoning summary",
        (item) => string(item, "reasoning summary item", { max: 32_768 }),
        1_000,
      ),
    };
  }
  if (providerType === "commandExecution") {
    return {
      type: providerType,
      id,
      command: string(root.command, "command", { max: 1_000_000 }),
      cwd: string(root.cwd, "command cwd", { max: 16_384 }),
      status: string(root.status, "command status", { min: 1, max: 128 }),
      exitCode: root.exitCode === null ? null : safeInteger(root.exitCode, "command exitCode"),
      durationMs: nullableNonnegativeNumber(root.durationMs, "command durationMs"),
    };
  }
  if (providerType === "fileChange") {
    const changes = array(root.changes, "file changes", (item) => record(item, "file change"), 20_000);
    const changedPaths = changes.map((change) =>
      string(change.path, "file change path", { min: 1, max: 16_384 }),
    );
    return {
      type: providerType,
      id,
      status: string(root.status, "file change status", { min: 1, max: 128 }),
      changedPaths,
    };
  }
  if (providerType === "mcpToolCall") {
    return {
      type: providerType,
      id,
      server: identifier(root.server, "mcp server"),
      tool: identifier(root.tool, "mcp tool"),
      status: string(root.status, "mcp status", { min: 1, max: 128 }),
      pluginId: nullableString(root.pluginId, "mcp plugin id", 512),
      durationMs: nullableNonnegativeNumber(root.durationMs, "mcp durationMs"),
    };
  }
  return { type: "unsupported", id, providerType };
}

export function parseThreadStatus(value: unknown): CodexThreadStatus {
  const root = record(value, "thread status");
  const type = string(root.type, "thread status type", { min: 1, max: 128 });
  if (type === "notLoaded" || type === "idle" || type === "systemError") return { type };
  if (type === "active") {
    return {
      type,
      activeFlags: array(
        root.activeFlags,
        "thread active flags",
        (item) => string(item, "thread active flag", { min: 1, max: 128 }),
        100,
      ),
    };
  }
  throw protocol("thread status is unsupported by this pinned adapter");
}

const canonicalTextEncoder = new TextEncoder();
const unsafeDisplayScalar = /[\p{Cc}\p{Cf}\p{Cs}]/u;

const safeDisplayText = (value: unknown, label: string, maximum: number): string => {
  const source = string(value, label, { max: 4 * 1024 * 1024 });
  let output = "";
  let bytes = 0;
  for (const scalar of source) {
    const safeScalar = unsafeDisplayScalar.test(scalar) ? "�" : scalar;
    const scalarBytes = canonicalTextEncoder.encode(safeScalar).byteLength;
    if (bytes + scalarBytes > maximum) break;
    output += safeScalar;
    bytes += scalarBytes;
  }
  return output;
};

const nullableSafeDisplayText = (
  value: unknown,
  label: string,
  maximum: number,
): string | null => value === null || value === undefined
  ? null
  : safeDisplayText(value, label, maximum);

const canonicalJson = (value: unknown): string => {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw protocol("JSON value contains a non-finite number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value !== "object") throw protocol("JSON value contains an unsupported scalar");
  const root = value as Record<string, unknown>;
  return `{${Object.keys(root)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(root[key])}`)
    .join(",")}}`;
};

export const digestCodexJson = (value: unknown): string =>
  createHash("sha256").update(canonicalJson(value)).digest("hex");

export function parseProviderRequestId(value: unknown): ProviderRequestId {
  if (typeof value === "number") {
    return { type: "number", value: safeInteger(value, "server request id") };
  }
  return {
    type: "string",
    value: string(value, "server request id", { min: 1, max: 512 }),
  };
}

export const providerRequestIdKey = (id: ProviderRequestId): string =>
  id.type === "number" ? `number:${String(id.value)}` : `string:${id.value}`;

export const rawProviderRequestId = (id: ProviderRequestId): number | string => id.value;

export function codexServerRequestDisposition(
  method: string,
): CodexServerRequestDisposition | null {
  if (!Object.hasOwn(PINNED_CODEX_SERVER_REQUEST_MATRIX, method)) return null;
  return PINNED_CODEX_SERVER_REQUEST_MATRIX[method as PinnedCodexServerRequestMethod];
}

const parseCanonicalParams = (value: unknown): Readonly<Record<string, unknown>> => {
  const serialized = canonicalJson(value);
  if (canonicalTextEncoder.encode(serialized).byteLength > 4 * 1024 * 1024) {
    throw new CodexError("PROTOCOL_LIMIT", "server request params exceeded their byte limit");
  }
  return Object.freeze(record(JSON.parse(serialized) as unknown, "server request params"));
};

const nullableRequestIdentifier = (value: unknown, label: string): string | null =>
  value === undefined || value === null ? null : identifier(value, label);

const classifyApprovalCommand = (value: unknown): string => {
  if (value === undefined || value === null) return "command";
  const tokens = string(value, "approval command", { max: 1_000_000 })
    .trim()
    .split(/\s+/u)
    .slice(0, 32);
  const knownTools = ["git", "bun", "npm", "pnpm", "yarn", "cargo", "zig", "python", "python3", "node"];
  const tool = tokens.find((token) => knownTools.some((known) => token === known || token.endsWith(`/${known}`)));
  if (tool === undefined) return "command";
  const name = tool.slice(tool.lastIndexOf("/") + 1);
  if (name !== "git" && name !== "bun" && name !== "cargo") return name;
  const index = tokens.indexOf(tool);
  const allowedActions = name === "git"
    ? new Set(["add", "branch", "checkout", "cherry-pick", "clone", "commit", "diff", "fetch", "log", "merge", "pull", "push", "rebase", "reset", "restore", "revert", "show", "status", "switch", "tag", "worktree"])
    : name === "bun"
      ? new Set(["add", "build", "install", "link", "publish", "remove", "run", "test", "update", "x"])
      : new Set(["add", "build", "check", "clean", "clippy", "fetch", "fix", "install", "publish", "remove", "run", "test", "update"]);
  const action = tokens.slice(index + 1).find((token) => allowedActions.has(token));
  return action === undefined ? name : `${name} ${safeDisplayText(action, "command action", 64)}`;
};

const availableDecision = (value: unknown, decision: string): boolean => {
  if (value === undefined || value === null) return false;
  return array(value, "available decisions", (item) => item, 20)
    .some((candidate) => candidate === decision);
};

const safeInteractionJson = (value: unknown): unknown => {
  const serialized = canonicalJson(value);
  if (canonicalTextEncoder.encode(serialized).byteLength > 64 * 1024) {
    throw new CodexError("PROTOCOL_LIMIT", "interaction display data exceeded its byte limit");
  }
  return JSON.parse(serialized) as unknown;
};

const safeInteractionUrl = (value: unknown): string => {
  const source = string(value, "elicitation URL", { min: 1, max: 4_096 });
  let parsed: URL;
  try {
    parsed = new URL(source);
  } catch {
    throw protocol("elicitation URL is invalid");
  }
  const loopback = parsed.hostname === "localhost"
    || parsed.hostname === "127.0.0.1"
    || parsed.hostname === "[::1]";
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && loopback)) {
    throw protocol("elicitation URL must use HTTPS or a loopback callback");
  }
  if (parsed.username !== "" || parsed.password !== "") {
    throw protocol("elicitation URL contains credentials");
  }
  return parsed.toString();
};

export function parseBrokeredCodexServerRequest(input: {
  readonly authority: CodexAuthority;
  readonly connectionId: string;
  readonly requestId: ProviderRequestId;
  readonly method: BrokeredCodexServerRequestMethod;
  readonly params: unknown;
}): ParsedBrokeredCodexServerRequest {
  const privateParams = parseCanonicalParams(input.params);
  const threadId = identifier(privateParams.threadId, "server request thread id");
  const turnId = nullableRequestIdentifier(privateParams.turnId, "server request turn id");
  const itemId = nullableRequestIdentifier(privateParams.itemId, "server request item id");
  const approvalId = nullableRequestIdentifier(privateParams.approvalId, "server request approval id");
  const provider: ProviderInteractionAuthority = {
    profileId: input.authority.profileId,
    processGeneration: input.authority.processGeneration,
    connectionId: input.connectionId,
    requestId: input.requestId,
    method: input.method,
    requestDigest: digestCodexJson(privateParams),
    threadId,
    turnId,
    itemId,
    approvalId,
  };

  if (input.method === "item/commandExecution/requestApproval") {
    if (turnId === null || itemId === null) throw protocol("command approval omitted turn or item context");
    const commandClass = classifyApprovalCommand(privateParams.command);
    const reason = nullableSafeDisplayText(privateParams.reason, "command approval reason", 4_096);
    return {
      provider,
      kind: "command_approval",
      blocking: true,
      display: {
        kind: "command_approval",
        summary: `Allow ${commandClass}`,
        reason,
        commandClass,
        workingDirectory: nullableSafeDisplayText(privateParams.cwd, "command cwd", 1_024),
        allowsSessionApproval: availableDecision(privateParams.availableDecisions, "acceptForSession"),
      },
      privateParams,
    };
  }
  if (input.method === "item/fileChange/requestApproval") {
    if (turnId === null || itemId === null) throw protocol("file approval omitted turn or item context");
    const reason = nullableSafeDisplayText(privateParams.reason, "file approval reason", 4_096);
    return {
      provider,
      kind: "file_change_approval",
      blocking: true,
      display: {
        kind: "file_change_approval",
        summary: "Allow the requested file changes",
        reason,
        grantRoot: nullableSafeDisplayText(privateParams.grantRoot, "file grant root", 1_024),
        allowsSessionApproval: true,
      },
      privateParams,
    };
  }
  if (input.method === "item/permissions/requestApproval") {
    if (turnId === null || itemId === null) throw protocol("permission approval omitted turn or item context");
    const permissions = record(privateParams.permissions, "requested permissions");
    const requested = Object.entries(permissions)
      .filter(([, value]) => value !== null)
      .map(([name, value]) => ({ name, value: safeInteractionJson(value) }));
    if (requested.length > 100) throw protocol("too many permission categories were requested");
    const reason = nullableSafeDisplayText(privateParams.reason, "permission approval reason", 4_096);
    return {
      provider,
      kind: "permission_approval",
      blocking: true,
      display: {
        kind: "permission_approval",
        summary: "Allow the requested additional permissions",
        reason,
        requested,
        allowsSessionScope: true,
      },
      privateParams,
    };
  }
  if (input.method === "item/tool/requestUserInput") {
    if (turnId === null || itemId === null) throw protocol("user input request omitted turn or item context");
    const questions = array(privateParams.questions, "user input questions", (value, index) => {
      const question = record(value, `user input question ${String(index)}`);
      const options = question.options === null
        ? null
        : array(question.options, "user input options", (option, optionIndex) => {
            const parsed = record(option, `user input option ${String(optionIndex)}`);
            return {
              label: safeDisplayText(parsed.label, "user input option label", 512),
              description: safeDisplayText(parsed.description, "user input option description", 2_048),
            };
          }, 20);
      return {
        id: identifier(question.id, "user input question id"),
        header: safeDisplayText(question.header, "user input header", 256),
        question: safeDisplayText(question.question, "user input question", 4_096),
        options: options === null ? null : [...options],
        allowsOther: boolean(question.isOther, "user input allows other"),
        secret: boolean(question.isSecret, "user input secret flag"),
      };
    }, 3);
    if (questions.length < 1) throw protocol("user input request omitted questions");
    const blocking = boolean(privateParams.isBlocking, "user input blocking flag");
    return {
      provider,
      kind: "user_input",
      blocking,
      display: {
        kind: "user_input",
        summary: questions.length === 1 ? "Codex needs one answer" : `Codex needs ${String(questions.length)} answers`,
        blocking,
        questions: [...questions],
      },
      privateParams,
    };
  }

  const mode = string(privateParams.mode, "MCP elicitation mode", { min: 1, max: 64 });
  if (mode !== "form" && mode !== "openai/form" && mode !== "url") {
    throw protocol("MCP elicitation mode is unsupported");
  }
  const message = safeDisplayText(privateParams.message, "MCP elicitation message", 4_096);
  const serverName = identifier(privateParams.serverName, "MCP server name");
  return {
    provider,
    kind: "mcp_elicitation",
    blocking: true,
    display: {
      kind: "mcp_elicitation",
      summary: message,
      serverName,
      mode: mode === "openai/form" ? "openai_form" : mode,
      url: mode === "url" ? safeInteractionUrl(privateParams.url) : null,
      mayContainSecrets: mode !== "url",
    },
    privateParams,
  };
}

const jsonSubset = (candidate: unknown, requested: unknown): boolean => {
  if (Object.is(candidate, requested)) return true;
  if (Array.isArray(candidate)) {
    if (!Array.isArray(requested)) return false;
    const requestedValues = new Set(requested.map(canonicalJson));
    return candidate.every((value) => requestedValues.has(canonicalJson(value)));
  }
  if (candidate !== null && typeof candidate === "object") {
    if (requested === null || typeof requested !== "object" || Array.isArray(requested)) return false;
    const requestedRecord = requested as Record<string, unknown>;
    return Object.entries(candidate as Record<string, unknown>)
      .every(([key, value]) => Object.hasOwn(requestedRecord, key) && jsonSubset(value, requestedRecord[key]));
  }
  return false;
};

export function compileCodexInteractionResponse(input: {
  readonly method: BrokeredCodexServerRequestMethod;
  readonly kind: InteractionKind;
  readonly privateParams: Readonly<Record<string, unknown>>;
  readonly resolution: InteractionResolution;
}): unknown {
  const { method, kind, privateParams, resolution } = input;
  if (method === "item/commandExecution/requestApproval" || method === "item/fileChange/requestApproval") {
    const expectedKind = method === "item/commandExecution/requestApproval"
      ? "command_approval"
      : "file_change_approval";
    if (kind !== expectedKind || resolution.kind !== "approval_decision") {
      throw new CodexError("INVALID_INPUT", "interaction resolution kind does not match the provider request");
    }
    const decision = resolution.decision === "once"
      ? "accept"
      : resolution.decision === "session"
        ? "acceptForSession"
        : resolution.decision;
    if (
      resolution.decision === "session"
      && method === "item/commandExecution/requestApproval"
      && !availableDecision(privateParams.availableDecisions, "acceptForSession")
    ) {
      throw new CodexError("INVALID_INPUT", "the command approval does not allow session scope");
    }
    return { decision };
  }
  if (method === "item/permissions/requestApproval") {
    if (kind !== "permission_approval") {
      throw new CodexError("INVALID_INPUT", "interaction resolution kind does not match the permission request");
    }
    if (resolution.kind === "approval_decision") {
      if (resolution.decision === "once" || resolution.decision === "session") {
        throw new CodexError("INVALID_INPUT", "permission approval requires an exact requested subset");
      }
      return { permissions: {}, scope: "turn" };
    }
    if (resolution.kind !== "permission_grant") {
      throw new CodexError("INVALID_INPUT", "permission approval requires a permission grant");
    }
    const requested = record(privateParams.permissions, "requested permissions");
    if (!jsonSubset(resolution.permissions, requested)) {
      throw new CodexError("INVALID_INPUT", "granted permissions exceed the requested profile");
    }
    return {
      permissions: safeInteractionJson(resolution.permissions),
      scope: resolution.scope ?? "turn",
    };
  }
  if (method === "item/tool/requestUserInput") {
    if (kind !== "user_input" || resolution.kind !== "user_answers") {
      throw new CodexError("INVALID_INPUT", "user input requires exact question answers");
    }
    const questions = array(privateParams.questions, "user input questions", (value) => record(value, "user input question"), 3);
    const expectedIds = new Set(questions.map((question) => identifier(question.id, "user input question id")));
    const answerIds = Object.keys(resolution.answers);
    if (answerIds.length !== expectedIds.size || answerIds.some((id) => !expectedIds.has(id))) {
      throw new CodexError("INVALID_INPUT", "answers must match the exact requested question ids");
    }
    return { answers: safeInteractionJson(resolution.answers) };
  }
  if (kind !== "mcp_elicitation" || resolution.kind !== "mcp_submission") {
    throw new CodexError("INVALID_INPUT", "MCP elicitation requires an MCP submission");
  }
  if (resolution.action !== "accept" && resolution.content !== undefined) {
    throw new CodexError("INVALID_INPUT", "declined or canceled MCP elicitation cannot include content");
  }
  return {
    action: resolution.action,
    content: resolution.action === "accept" ? safeInteractionJson(resolution.content ?? null) : null,
    _meta: null,
  };
}

export function parseFact(method: string, params: unknown): CodexFact {
  const root = record(params ?? {}, `${method} notification`);
  if (method === "account/updated") {
    return {
      type: "accountUpdated",
      authMode: nullableString(root.authMode, "account authMode", 128),
      planType: nullableString(root.planType, "account planType", 128),
    };
  }
  if (method === "account/login/completed") {
    return {
      type: "loginCompleted",
      loginId: nullableString(root.loginId, "login id", 512),
      success: boolean(root.success, "login success"),
    };
  }
  if (method === "thread/status/changed") {
    return {
      type: "threadStatusChanged",
      threadId: identifier(root.threadId, "thread id"),
      status: parseThreadStatus(root.status),
    };
  }
  if (method === "turn/started" || method === "turn/completed") {
    return {
      type: method === "turn/started" ? "turnStarted" : "turnCompleted",
      threadId: identifier(root.threadId, "thread id"),
      turn: parseTurn(root.turn, 0),
    };
  }
  if (method === "thread/name/updated") {
    return {
      type: "threadNameUpdated",
      threadId: identifier(root.threadId, "thread id"),
      name: nullableString(root.name, "thread name", 1_024),
    };
  }
  if (method === "item/started" || method === "item/completed") {
    const item = record(root.item, "thread item");
    const itemKind = string(item.type, "thread item type", { min: 1, max: 128 });
    const status = item.status === undefined
      ? undefined
      : string(item.status, "thread item status", { min: 1, max: 128 });
    const server = itemKind === "mcpToolCall"
      ? identifier(item.server, "MCP server")
      : undefined;
    const tool = itemKind === "mcpToolCall" || itemKind === "dynamicToolCall"
      ? identifier(item.tool, "tool name")
      : undefined;
    return {
      type: method === "item/started" ? "itemStarted" : "itemCompleted",
      threadId: identifier(root.threadId, "thread id"),
      turnId: identifier(root.turnId, "turn id"),
      itemId: identifier(item.id, "thread item id"),
      itemKind,
      ...(status === undefined ? {} : { status }),
      ...(server === undefined ? {} : { server }),
      ...(tool === undefined ? {} : { tool }),
    };
  }
  if (method === "item/agentMessage/delta") {
    return {
      type: "assistantDelta",
      threadId: identifier(root.threadId, "thread id"),
      turnId: identifier(root.turnId, "turn id"),
      itemId: identifier(root.itemId, "thread item id"),
      text: safeDisplayText(root.delta, "assistant delta", 32_768),
    };
  }
  if (method === "item/reasoning/summaryTextDelta") {
    const summaryIndex = safeInteger(root.summaryIndex, "reasoning summary index");
    if (summaryIndex < 0 || summaryIndex > 10_000) {
      throw protocol("reasoning summary index is outside its bounded range");
    }
    return {
      type: "reasoningSummaryDelta",
      threadId: identifier(root.threadId, "thread id"),
      turnId: identifier(root.turnId, "turn id"),
      itemId: identifier(root.itemId, "thread item id"),
      summaryIndex,
      text: safeDisplayText(root.delta, "reasoning summary delta", 32_768),
    };
  }
  if (
    method === "item/commandExecution/outputDelta"
    || method === "item/fileChange/outputDelta"
  ) {
    const delta = string(root.delta, "tool output delta", { max: 4 * 1024 * 1024 });
    return {
      type: "toolProgress",
      threadId: identifier(root.threadId, "thread id"),
      turnId: identifier(root.turnId, "turn id"),
      itemId: identifier(root.itemId, "thread item id"),
      toolKind: method === "item/commandExecution/outputDelta" ? "command" : "file_change",
      status: "running",
      outputBytesObserved: canonicalTextEncoder.encode(delta).byteLength,
    };
  }
  if (method === "item/mcpToolCall/progress") {
    string(root.message, "MCP progress message", { max: 4 * 1024 * 1024 });
    return {
      type: "toolProgress",
      threadId: identifier(root.threadId, "thread id"),
      turnId: identifier(root.turnId, "turn id"),
      itemId: identifier(root.itemId, "thread item id"),
      toolKind: "mcp",
      status: "running",
    };
  }
  if (method === "turn/plan/updated") {
    const steps = array(root.plan, "turn plan", (value, index) => {
      const step = record(value, `turn plan step ${String(index)}`);
      const status = oneOf(
        step.status,
        "turn plan step status",
        ["pending", "inProgress", "completed"] as const,
      );
      return {
        text: safeDisplayText(step.step, "turn plan step", 1_024),
        status: status === "inProgress" ? "in_progress" as const : status,
      };
    }, 100);
    const explanation = root.explanation === null
      ? undefined
      : safeDisplayText(root.explanation, "turn plan explanation", 4_096);
    return {
      type: "planUpdated",
      threadId: identifier(root.threadId, "thread id"),
      turnId: identifier(root.turnId, "turn id"),
      steps,
      ...(explanation === undefined ? {} : { explanation }),
    };
  }
  if (method === "turn/diff/updated") {
    const diff = string(root.diff, "turn diff", { max: 4 * 1024 * 1024 });
    const changedFiles = Math.min(1_000_000, diff.match(/^diff --git /gmu)?.length ?? 0);
    return {
      type: "diffUpdated",
      threadId: identifier(root.threadId, "thread id"),
      turnId: identifier(root.turnId, "turn id"),
      changedFiles,
      patchBytesObserved: canonicalTextEncoder.encode(diff).byteLength,
    };
  }
  if (method === "item/fileChange/patchUpdated") {
    let patchBytesObserved = 0;
    const changes = array(root.changes, "file changes", (value, index) => {
      const change = record(value, `file change ${String(index)}`);
      identifier(change.path, "file change path");
      const diff = string(change.diff, "file change diff", { max: 4 * 1024 * 1024 });
      patchBytesObserved += canonicalTextEncoder.encode(diff).byteLength;
      return undefined;
    }, 1_000);
    if (!Number.isSafeInteger(patchBytesObserved)) throw protocol("file change patch bytes overflowed");
    return {
      type: "diffUpdated",
      threadId: identifier(root.threadId, "thread id"),
      turnId: identifier(root.turnId, "turn id"),
      changedFiles: changes.length,
      patchBytesObserved,
    };
  }
  if (method === "thread/tokenUsage/updated") {
    const usage = record(root.tokenUsage, "thread token usage");
    const total = record(usage.total, "thread total token usage");
    const nonnegativeToken = (value: unknown, label: string): number => {
      const parsed = safeInteger(value, label);
      if (parsed < 0) throw protocol(`${label} must be nonnegative`);
      return parsed;
    };
    const modelContextWindow = usage.modelContextWindow === null
      ? null
      : nonnegativeToken(usage.modelContextWindow, "model context window");
    if (modelContextWindow !== null && modelContextWindow < 1) {
      throw protocol("model context window must be positive");
    }
    return {
      type: "tokenUsageUpdated",
      threadId: identifier(root.threadId, "thread id"),
      turnId: identifier(root.turnId, "turn id"),
      inputTokens: nonnegativeToken(total.inputTokens, "input tokens"),
      cachedInputTokens: nonnegativeToken(total.cachedInputTokens, "cached input tokens"),
      outputTokens: nonnegativeToken(total.outputTokens, "output tokens"),
      reasoningOutputTokens: nonnegativeToken(total.reasoningOutputTokens, "reasoning output tokens"),
      totalTokens: nonnegativeToken(total.totalTokens, "total tokens"),
      modelContextWindow,
    };
  }
  if (method === "warning") {
    if (root.threadId === null) return { type: "protocolNotice", method };
    return {
      type: "providerWarning",
      threadId: identifier(root.threadId, "warning thread id"),
      code: "provider_warning",
      message: safeDisplayText(root.message, "provider warning", 2_048),
    };
  }
  if (method === "error") {
    const error = record(root.error, "provider error");
    const info = error.codexErrorInfo;
    const code = typeof info === "string"
      ? safeDisplayText(info, "provider error code", 256)
      : info === null
        ? "provider_error"
        : safeDisplayText(Object.keys(record(info, "provider error info"))[0] ?? "provider_error", "provider error code", 256);
    return {
      type: "providerError",
      threadId: identifier(root.threadId, "error thread id"),
      turnId: identifier(root.turnId, "error turn id"),
      code,
      message: safeDisplayText(error.message, "provider error message", 2_048),
      terminal: !boolean(root.willRetry, "provider error retry flag"),
    };
  }
  if (method === "serverRequest/resolved") {
    return {
      type: "serverRequestResolved",
      threadId: identifier(root.threadId, "resolved request thread id"),
      requestId: parseProviderRequestId(root.requestId),
    };
  }
  // Raw reasoning and raw command, patch, process, and tool payload variants
  // are intentionally reduced to a method-only notice. No payload survives.
  return { type: "protocolNotice", method: string(method, "notification method", { max: 512 }) };
}

export function resolvePreset(
  snapshot: CodexCapabilitySnapshot,
  alias: PresetAlias,
  fast: boolean,
): ResolvedPreset {
  const requirement = presetRequirements[alias];
  const candidates = snapshot.models.filter((model) => model.model === requirement.model);
  const model = candidates[0];
  if (
    model === undefined
    || candidates.length !== 1
    || !model.supportedReasoningEfforts.includes(requirement.effort)
  ) {
    throw new CodexError(
      "UNSUPPORTED_CAPABILITY",
      `${alias} requires exactly ${requirement.model} with ${requirement.effort} reasoning for this account generation`,
    );
  }
  const effort: ReasoningEffort = requirement.effort;
  let serviceTier: string | null = null;
  if (fast) {
    const tier = model.serviceTiers.find((candidate) => candidate.id === "priority");
    if (tier === undefined) {
      throw new CodexError(
        "UNSUPPORTED_CAPABILITY",
        `Fast mode is unavailable for ${model.displayName}`,
      );
    }
    serviceTier = tier.id;
  }
  return { alias, model: model.model, effort, serviceTier, fast };
}

function safeHttpUrl(value: unknown, label: string): string {
  const parsed = string(value, label, { min: 1, max: 16_384 });
  let url: URL;
  try {
    url = new URL(parsed);
  } catch {
    throw protocol(`${label} is not a URL`);
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopback(url.hostname))) {
    throw protocol(`${label} must use HTTPS or a loopback callback`);
  }
  if (url.username !== "" || url.password !== "") throw protocol(`${label} contains credentials`);
  return url.toString();
}

function isLoopback(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}

function nullableNonnegativeInteger(value: unknown, label: string): number | null {
  return value === null ? null : nonnegativeInteger(value, label);
}

function nonnegativeInteger(value: unknown, label: string): number {
  const parsed = safeInteger(value, label);
  if (parsed < 0) throw protocol(`${label} must be nonnegative`);
  return parsed;
}

function nullableNonnegativeNumber(value: unknown, label: string): number | null {
  return value === null ? null : nonnegativeNumber(value, label);
}

function nonnegativeNumber(value: unknown, label: string): number {
  const parsed = number(value, label);
  if (parsed < 0) throw protocol(`${label} must be nonnegative`);
  return parsed;
}

export function validateAuthority(authority: CodexAuthority): CodexAuthority {
  const profileId = identifier(authority.profileId, "profile id");
  if (!Number.isSafeInteger(authority.processGeneration) || authority.processGeneration < 1) {
    throw new CodexError("INVALID_INPUT", "process generation must be a positive integer");
  }
  return { profileId, processGeneration: authority.processGeneration };
}

export function boundedPageLimit(value: number | undefined, max = 200): number {
  const selected = value ?? Math.min(50, max);
  if (!Number.isSafeInteger(selected) || selected < 1 || selected > max) {
    throw new CodexError("INVALID_INPUT", `page limit must be between 1 and ${String(max)}`);
  }
  return selected;
}

export function boundedText(value: string, label: string, max = 1_000_000): string {
  if (typeof value !== "string" || value.length < 1 || value.length > max) {
    throw new CodexError("INVALID_INPUT", `${label} must be a non-empty bounded string`);
  }
  return value;
}

export function boundedIdentifier(value: string, label: string): string {
  try {
    return identifier(value, label);
  } catch (error) {
    throw new CodexError("INVALID_INPUT", `${label} is invalid`, { cause: error });
  }
}

export function nullableResult(value: unknown): UnknownRecord {
  return record(value ?? {}, "empty result");
}
