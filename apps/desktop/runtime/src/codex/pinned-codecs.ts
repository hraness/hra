import { z } from "@hra-internal/schema";
import { createHash } from "node:crypto";
import { isAbsolute } from "node:path";

import type { ClientRequest as GeneratedClientRequest } from "../../../contracts/generated/codex/0.144.6/typescript/ClientRequest";
import type { InitializeResponse as GeneratedInitializeResponse } from "../../../contracts/generated/codex/0.144.6/typescript/InitializeResponse";
import type { ServerNotification as GeneratedServerNotification } from "../../../contracts/generated/codex/0.144.6/typescript/ServerNotification";
import type { ServerRequest as GeneratedServerRequest } from "../../../contracts/generated/codex/0.144.6/typescript/ServerRequest";
import type { CancelLoginAccountResponse as GeneratedCancelLoginAccountResponse } from "../../../contracts/generated/codex/0.144.6/typescript/v2/CancelLoginAccountResponse";
import type { GetAccountRateLimitsResponse as GeneratedGetAccountRateLimitsResponse } from "../../../contracts/generated/codex/0.144.6/typescript/v2/GetAccountRateLimitsResponse";
import type { GetAccountResponse as GeneratedGetAccountResponse } from "../../../contracts/generated/codex/0.144.6/typescript/v2/GetAccountResponse";
import type { GetAccountTokenUsageResponse as GeneratedGetAccountTokenUsageResponse } from "../../../contracts/generated/codex/0.144.6/typescript/v2/GetAccountTokenUsageResponse";
import type { LoginAccountResponse as GeneratedLoginAccountResponse } from "../../../contracts/generated/codex/0.144.6/typescript/v2/LoginAccountResponse";
import type { LogoutAccountResponse as GeneratedLogoutAccountResponse } from "../../../contracts/generated/codex/0.144.6/typescript/v2/LogoutAccountResponse";
import type { ModelListResponse as GeneratedModelListResponse } from "../../../contracts/generated/codex/0.144.6/typescript/v2/ModelListResponse";
import type { ThreadInjectItemsResponse as GeneratedThreadInjectItemsResponse } from "../../../contracts/generated/codex/0.144.6/typescript/v2/ThreadInjectItemsResponse";
import type { ThreadItemsListResponse as GeneratedThreadItemsListResponse } from "../../../contracts/generated/codex/0.144.6/typescript/v2/ThreadItemsListResponse";
import type { ThreadForkResponse as GeneratedThreadForkResponse } from "../../../contracts/generated/codex/0.144.6/typescript/v2/ThreadForkResponse";
import type { ThreadGoalClearResponse as GeneratedThreadGoalClearResponse } from "../../../contracts/generated/codex/0.144.6/typescript/v2/ThreadGoalClearResponse";
import type { ThreadGoalGetResponse as GeneratedThreadGoalGetResponse } from "../../../contracts/generated/codex/0.144.6/typescript/v2/ThreadGoalGetResponse";
import type { ThreadGoalSetResponse as GeneratedThreadGoalSetResponse } from "../../../contracts/generated/codex/0.144.6/typescript/v2/ThreadGoalSetResponse";
import type { ThreadListResponse as GeneratedThreadListResponse } from "../../../contracts/generated/codex/0.144.6/typescript/v2/ThreadListResponse";
import type { ThreadReadResponse as GeneratedThreadReadResponse } from "../../../contracts/generated/codex/0.144.6/typescript/v2/ThreadReadResponse";
import type { ThreadResumeResponse as GeneratedThreadResumeResponse } from "../../../contracts/generated/codex/0.144.6/typescript/v2/ThreadResumeResponse";
import type { ThreadSetNameResponse as GeneratedThreadSetNameResponse } from "../../../contracts/generated/codex/0.144.6/typescript/v2/ThreadSetNameResponse";
import type { ThreadStartResponse as GeneratedThreadStartResponse } from "../../../contracts/generated/codex/0.144.6/typescript/v2/ThreadStartResponse";
import type { ThreadTurnsListResponse as GeneratedThreadTurnsListResponse } from "../../../contracts/generated/codex/0.144.6/typescript/v2/ThreadTurnsListResponse";
import type { TurnInterruptResponse as GeneratedTurnInterruptResponse } from "../../../contracts/generated/codex/0.144.6/typescript/v2/TurnInterruptResponse";
import type { TurnStartResponse as GeneratedTurnStartResponse } from "../../../contracts/generated/codex/0.144.6/typescript/v2/TurnStartResponse";
import type { TurnSteerResponse as GeneratedTurnSteerResponse } from "../../../contracts/generated/codex/0.144.6/typescript/v2/TurnSteerResponse";

const MAX_ID_CHARACTERS = 512;
const MAX_PATH_CHARACTERS = 4_096;
const MAX_TEXT_CHARACTERS = 1_000_000;
// This per-field parser bound stays above the session layer's lower semantic
// history circuit. The JSONL decoder has separate aggregate envelope headroom.
const MAX_PROTOCOL_TEXT_CHARACTERS = 8 * 1_024 * 1_024;
const MAX_THREAD_ITEMS = 10_000;
const MAX_THREADS_PER_PAGE = 256;
const MAX_TURNS_PER_PAGE = 128;
const MAX_ITEMS_PER_PAGE = 256;
const MAX_AUTHORIZATION_URL_CHARACTERS = 2_048;
const APPROVED_AUTHORIZATION_ORIGIN = "https://auth.openai.com";

export const PINNED_CODEX_MAX_SAFE_COUNT = Number.MAX_SAFE_INTEGER;

const idSchema = z.string().min(1).max(MAX_ID_CHARACTERS);
const providerAnswerKeySchema = idSchema.refine(
  (value) => value !== "__proto__" && value !== "constructor" && value !== "prototype",
  "unsafe provider answer key",
);
const pathSchema = z.string().min(1).max(MAX_PATH_CHARACTERS)
  .refine((value) => !value.includes("\0"), "path contains NUL");
const absolutePathSchema = pathSchema.refine(isAbsolute, "path is not absolute");
const largeTextSchema = z.string().max(MAX_TEXT_CHARACTERS);
const protocolTextSchema = z.string().max(MAX_PROTOCOL_TEXT_CHARACTERS);
const nullableProtocolTextSchema = protocolTextSchema.nullable();
const safeNonNegativeIntegerSchema = z.number().int().min(0).max(PINNED_CODEX_MAX_SAFE_COUNT);
const unixSecondsSchema = safeNonNegativeIntegerSchema.max(8_640_000_000_000);
const unixMillisecondsSchema = safeNonNegativeIntegerSchema.max(8_640_000_000_000_000);

const planTypeSchema = z.enum([
  "free",
  "go",
  "plus",
  "pro",
  "prolite",
  "team",
  "self_serve_business_usage_based",
  "business",
  "enterprise_cbp_usage_based",
  "enterprise",
  "edu",
  "unknown",
]);

const authModeSchema = z.enum([
  "apikey",
  "chatgpt",
  "chatgptAuthTokens",
  "headers",
  "agentIdentity",
  "personalAccessToken",
  "bedrockApiKey",
]);

const decimalCountSchema = z
  .union([z.bigint().nonnegative(), safeNonNegativeIntegerSchema])
  .transform((value) => value.toString())
  .pipe(z.string().regex(/^(?:0|[1-9][0-9]{0,19})$/u));

const nullableDecimalCountSchema = decimalCountSchema.nullable();

const emptyObjectSchema = z.object({}).strict().transform(() => undefined);
const undefinedSchema = z.undefined();

const approvedAuthorizationUrlSchema = z
  .string()
  .max(MAX_AUTHORIZATION_URL_CHARACTERS)
  .url()
  .refine((value) => {
    try {
      const parsed = new URL(value);
      const authority = /^[a-z][a-z0-9+.-]*:\/\/([^/?#]*)/iu.exec(value)?.[1];
      return parsed.origin === APPROVED_AUTHORIZATION_ORIGIN &&
        authority?.toLowerCase() === "auth.openai.com" &&
        parsed.username.length === 0 &&
        parsed.password.length === 0 &&
        parsed.port.length === 0;
    } catch {
      return false;
    }
  }, "unapproved Codex authorization URL")
  .transform((value) => new URL(value).href)
  .pipe(z.string().max(MAX_AUTHORIZATION_URL_CHARACTERS))
  .brand<"PinnedCodexApprovedAuthorizationUrl">();

const initializeInputSchema = z.object({
  clientInfo: z.object({
    name: z.string().min(1).max(160),
    title: z.string().max(160).nullable(),
    version: z.string().min(1).max(160),
  }).strict(),
  capabilities: z.object({
    experimentalApi: z.boolean(),
    requestAttestation: z.boolean(),
    mcpServerOpenaiFormElicitation: z.boolean().optional(),
    optOutNotificationMethods: z.array(z.string().min(1).max(160)).max(128).nullable().optional(),
  }).strict().nullable(),
}).strict();

const initializeOutputSchema = z.object({
  userAgent: z.string().min(1).max(1_024),
  codexHome: absolutePathSchema,
  platformFamily: z.string().min(1).max(160),
  platformOs: z.string().min(1).max(160),
});

const loginStartInputSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("apiKey"), apiKey: z.string().min(1).max(65_536) }).strict(),
  z.object({
    type: z.literal("chatgpt"),
    codexStreamlinedLogin: z.boolean().optional(),
    useHostedLoginSuccessPage: z.boolean().optional(),
    appBrand: z.enum(["codex", "chatgpt"]).nullable().optional(),
  }).strict(),
  z.object({ type: z.literal("chatgptDeviceCode") }).strict(),
  z.object({
    type: z.literal("chatgptAuthTokens"),
    accessToken: z.string().min(1).max(65_536),
    chatgptAccountId: z.string().min(1).max(512),
    chatgptPlanType: z.string().min(1).max(160).nullable().optional(),
  }).strict(),
]);

const loginStartOutputSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("apiKey") }),
  z.object({
    type: z.literal("chatgpt"),
    loginId: z.string().min(1).max(256),
    authUrl: approvedAuthorizationUrlSchema,
  }),
  z.object({
    type: z.literal("chatgptDeviceCode"),
    loginId: z.string().min(1).max(256),
    verificationUrl: approvedAuthorizationUrlSchema,
    userCode: z.string().min(1).max(128),
  }),
  z.object({ type: z.literal("chatgptAuthTokens") }),
]);

const loginCancelInputSchema = z.object({ loginId: z.string().min(1).max(256) }).strict();
const loginCancelOutputSchema = z.object({
  status: z.enum(["canceled", "notFound"]),
});

const accountReadInputSchema = z.object({ refreshToken: z.boolean().optional() }).strict();
const accountSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("apiKey") }),
  z.object({
    type: z.literal("chatgpt"),
    email: z.string().min(1).max(320).nullable(),
    planType: planTypeSchema,
  }),
  z.object({
    type: z.literal("amazonBedrock"),
    credentialSource: z.enum(["codexManaged", "awsManaged"]),
  }),
]);
const accountReadOutputSchema = z.object({
  account: accountSchema.nullable(),
  requiresOpenaiAuth: z.boolean(),
});

const rateLimitWindowSchema = z.object({
  usedPercent: z.number().finite().min(0).max(100),
  windowDurationMins: safeNonNegativeIntegerSchema.max(5_256_000).nullable(),
  resetsAt: unixSecondsSchema.nullable(),
});
const creditsSnapshotSchema = z.object({
  hasCredits: z.boolean(),
  unlimited: z.boolean(),
  balance: z.string().max(160).nullable(),
});
const spendControlLimitSchema = z.object({
  limit: z.string().min(1).max(160),
  used: z.string().min(1).max(160),
  remainingPercent: z.number().finite().min(0).max(100),
  resetsAt: unixSecondsSchema,
});
const rateLimitReachedTypeSchema = z.enum([
  "rate_limit_reached",
  "workspace_owner_credits_depleted",
  "workspace_member_credits_depleted",
  "workspace_owner_usage_limit_reached",
  "workspace_member_usage_limit_reached",
]);
const rateLimitSnapshotSchema = z.object({
  limitId: z.string().min(1).max(160).nullable(),
  limitName: z.string().min(1).max(160).nullable(),
  primary: rateLimitWindowSchema.nullable(),
  secondary: rateLimitWindowSchema.nullable(),
  credits: creditsSnapshotSchema.nullable(),
  individualLimit: spendControlLimitSchema.nullable(),
  planType: planTypeSchema.nullable(),
  rateLimitReachedType: rateLimitReachedTypeSchema.nullable(),
});
const rateLimitResetCreditSchema = z.object({
  id: z.string().min(1).max(160),
  resetType: z.enum(["codexRateLimits", "unknown"]),
  status: z.enum(["available", "redeeming", "redeemed", "unknown"]),
  grantedAt: unixSecondsSchema,
  expiresAt: unixSecondsSchema.nullable(),
  title: z.string().max(160).nullable(),
  description: z.string().max(500).nullable(),
});
const rateLimitResetCreditsSchema = z.object({
  availableCount: decimalCountSchema,
  credits: z.array(rateLimitResetCreditSchema).max(64).nullable(),
});
const rateLimitMapSchema = z
  .record(z.string().min(1).max(160), rateLimitSnapshotSchema.optional())
  .refine(
    (value) => Object.values(value).every((snapshot) => snapshot !== undefined),
    "undefined rate-limit bucket",
  )
  .transform((value) => Object.fromEntries(
    Object.entries(value).filter(
      (entry): entry is [string, z.infer<typeof rateLimitSnapshotSchema>] =>
        entry[1] !== undefined,
    ),
  ))
  .refine((value) => Object.keys(value).length <= 32, "too many rate-limit buckets");
const rateLimitsOutputSchema = z.object({
  rateLimits: rateLimitSnapshotSchema,
  rateLimitsByLimitId: rateLimitMapSchema.nullable(),
  rateLimitResetCredits: rateLimitResetCreditsSchema.nullable(),
});

const tokenUsageSummarySchema = z.object({
  lifetimeTokens: nullableDecimalCountSchema,
  peakDailyTokens: nullableDecimalCountSchema,
  longestRunningTurnSec: nullableDecimalCountSchema,
  currentStreakDays: nullableDecimalCountSchema,
  longestStreakDays: nullableDecimalCountSchema,
});
const tokenUsageOutputSchema = z.object({
  summary: tokenUsageSummarySchema,
  dailyUsageBuckets: z.array(z.object({
    startDate: z.string().date(),
    tokens: decimalCountSchema,
  })).max(5_000).nullable(),
});

const threadStatusSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("notLoaded") }),
  z.object({ type: z.literal("idle") }),
  z.object({ type: z.literal("systemError") }),
  z.object({
    type: z.literal("active"),
    activeFlags: z.array(z.enum(["waitingOnApproval", "waitingOnUserInput"])).max(64),
  }),
]);

type LosslessJsonValue =
  | string
  | number
  | bigint
  | boolean
  | null
  | LosslessJsonValue[]
  | { readonly [key: string]: LosslessJsonValue | undefined };

const losslessJsonValueSchema: z.ZodType<LosslessJsonValue> = z.lazy(() => z.union([
  protocolTextSchema,
  z.number().finite(),
  z.bigint(),
  z.boolean(),
  z.null(),
  z.array(losslessJsonValueSchema).max(MAX_THREAD_ITEMS),
  z.record(z.string().max(1_024), losslessJsonValueSchema.optional())
    .refine((value) => Object.keys(value).length <= MAX_THREAD_ITEMS, "too many JSON keys"),
]));

const imageDetailSchema = z.enum(["auto", "low", "high", "original"]);
const textElementSchema = z.object({
  byteRange: z.object({
    start: safeNonNegativeIntegerSchema,
    end: safeNonNegativeIntegerSchema,
  }).strict(),
  placeholder: protocolTextSchema.nullable(),
}).strict();
const threadUserInputSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("text"),
    text: protocolTextSchema,
    text_elements: z.array(textElementSchema).max(MAX_THREAD_ITEMS),
  }).strict(),
  z.object({
    type: z.literal("image"),
    detail: imageDetailSchema.optional(),
    url: protocolTextSchema,
  }).strict(),
  z.object({
    type: z.literal("localImage"),
    detail: imageDetailSchema.optional(),
    path: pathSchema,
  }).strict(),
  z.object({
    type: z.literal("skill"),
    name: largeTextSchema,
    path: pathSchema,
  }).strict(),
  z.object({
    type: z.literal("mention"),
    name: largeTextSchema,
    path: pathSchema,
  }).strict(),
]);
const memoryCitationSchema = z.object({
  entries: z.array(z.object({
    path: pathSchema,
    lineStart: safeNonNegativeIntegerSchema,
    lineEnd: safeNonNegativeIntegerSchema,
    note: protocolTextSchema,
  }).strict()).max(MAX_THREAD_ITEMS),
  threadIds: z.array(idSchema).max(MAX_THREAD_ITEMS),
}).strict();
const commandActionSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("read"),
    command: protocolTextSchema,
    name: largeTextSchema,
    path: absolutePathSchema,
  }).strict(),
  z.object({
    type: z.literal("listFiles"),
    command: protocolTextSchema,
    path: pathSchema.nullable(),
  }).strict(),
  z.object({
    type: z.literal("search"),
    command: protocolTextSchema,
    query: largeTextSchema.nullable(),
    path: pathSchema.nullable(),
  }).strict(),
  z.object({ type: z.literal("unknown"), command: protocolTextSchema }).strict(),
]);
const fileUpdateChangeSchema = z.object({
  path: pathSchema,
  kind: z.discriminatedUnion("type", [
    z.object({ type: z.literal("add") }).strict(),
    z.object({ type: z.literal("delete") }).strict(),
    z.object({ type: z.literal("update"), move_path: pathSchema.nullable() }).strict(),
  ]),
  diff: protocolTextSchema,
}).strict();
const mcpToolCallResultSchema = z.object({
  content: z.array(losslessJsonValueSchema).max(MAX_THREAD_ITEMS),
  structuredContent: losslessJsonValueSchema.nullable(),
  _meta: losslessJsonValueSchema.nullable(),
}).strict();
const dynamicToolCallContentSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("inputText"), text: protocolTextSchema }).strict(),
  z.object({ type: z.literal("inputImage"), imageUrl: protocolTextSchema }).strict(),
]);
const collabAgentStateSchema = z.object({
  status: z.enum([
    "pendingInit",
    "running",
    "interrupted",
    "completed",
    "errored",
    "shutdown",
    "notFound",
  ]),
  message: protocolTextSchema.nullable(),
}).strict();
const collabAgentStatesSchema = z.record(
  idSchema,
  collabAgentStateSchema.optional(),
).refine(
  (value) => Object.values(value).every((state) => state !== undefined),
  "undefined collab-agent state",
).refine((value) => Object.keys(value).length <= 128, "too many collab-agent states");
const webSearchActionSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("search"),
    query: protocolTextSchema.nullable(),
    queries: z.array(protocolTextSchema).max(MAX_THREAD_ITEMS).nullable(),
  }).strict(),
  z.object({ type: z.literal("openPage"), url: protocolTextSchema.nullable() }).strict(),
  z.object({
    type: z.literal("findInPage"),
    url: protocolTextSchema.nullable(),
    pattern: protocolTextSchema.nullable(),
  }).strict(),
  z.object({ type: z.literal("other") }).strict(),
]);

const rawThreadItemSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("userMessage"),
    id: idSchema,
    clientId: idSchema.nullable(),
    content: z.array(threadUserInputSchema).max(MAX_THREAD_ITEMS),
  }).strict(),
  z.object({
    type: z.literal("hookPrompt"),
    id: idSchema,
    fragments: z.array(z.object({
      text: protocolTextSchema,
      hookRunId: idSchema,
    }).strict()).max(MAX_THREAD_ITEMS),
  }).strict(),
  z.object({
    type: z.literal("agentMessage"),
    id: idSchema,
    text: protocolTextSchema,
    phase: z.enum(["commentary", "final_answer"]).nullable(),
    memoryCitation: memoryCitationSchema.nullable(),
  }).strict(),
  z.object({ type: z.literal("plan"), id: idSchema, text: protocolTextSchema }).strict(),
  z.object({
    type: z.literal("reasoning"),
    id: idSchema,
    summary: z.array(protocolTextSchema).max(MAX_THREAD_ITEMS),
    content: z.array(protocolTextSchema).max(MAX_THREAD_ITEMS),
  }).strict(),
  z.object({
    type: z.literal("commandExecution"),
    id: idSchema,
    command: protocolTextSchema,
    cwd: pathSchema,
    processId: idSchema.nullable(),
    source: z.enum(["agent", "userShell", "unifiedExecStartup", "unifiedExecInteraction"]),
    status: z.enum(["inProgress", "completed", "failed", "declined"]),
    commandActions: z.array(commandActionSchema).max(MAX_THREAD_ITEMS),
    aggregatedOutput: nullableProtocolTextSchema,
    exitCode: z.number().int().safe().nullable(),
    durationMs: safeNonNegativeIntegerSchema.nullable(),
  }).strict(),
  z.object({
    type: z.literal("fileChange"),
    id: idSchema,
    changes: z.array(fileUpdateChangeSchema).max(512),
    status: z.enum(["inProgress", "completed", "failed", "declined"]),
  }).strict(),
  z.object({
    type: z.literal("mcpToolCall"),
    id: idSchema,
    server: largeTextSchema,
    tool: largeTextSchema,
    status: z.enum(["inProgress", "completed", "failed"]),
    arguments: losslessJsonValueSchema,
    appContext: z.object({
      connectorId: idSchema,
      linkId: idSchema.nullable(),
      resourceUri: protocolTextSchema.nullable(),
      appName: largeTextSchema.nullable(),
      templateId: idSchema.nullable(),
      actionName: largeTextSchema.nullable(),
    }).strict().nullable(),
    mcpAppResourceUri: protocolTextSchema.optional(),
    pluginId: idSchema.nullable(),
    result: mcpToolCallResultSchema.nullable(),
    error: z.object({ message: protocolTextSchema }).strict().nullable(),
    durationMs: safeNonNegativeIntegerSchema.nullable(),
  }).strict(),
  z.object({
    type: z.literal("dynamicToolCall"),
    id: idSchema,
    namespace: largeTextSchema.nullable(),
    tool: largeTextSchema,
    arguments: losslessJsonValueSchema,
    status: z.enum(["inProgress", "completed", "failed"]),
    contentItems: z.array(dynamicToolCallContentSchema).max(MAX_THREAD_ITEMS).nullable(),
    success: z.boolean().nullable(),
    durationMs: safeNonNegativeIntegerSchema.nullable(),
  }).strict(),
  z.object({
    type: z.literal("collabAgentToolCall"),
    id: idSchema,
    tool: z.enum(["spawnAgent", "sendInput", "resumeAgent", "wait", "closeAgent"]),
    status: z.enum(["inProgress", "completed", "failed"]),
    senderThreadId: idSchema,
    receiverThreadIds: z.array(idSchema).max(128),
    prompt: protocolTextSchema.nullable(),
    model: largeTextSchema.nullable(),
    reasoningEffort: largeTextSchema.nullable(),
    agentsStates: collabAgentStatesSchema,
  }).strict(),
  z.object({
    type: z.literal("subAgentActivity"),
    id: idSchema,
    kind: z.enum(["started", "interacted", "interrupted"]),
    agentThreadId: idSchema,
    agentPath: pathSchema,
  }).strict(),
  z.object({
    type: z.literal("webSearch"),
    id: idSchema,
    query: protocolTextSchema,
    action: webSearchActionSchema.nullable(),
  }).strict(),
  z.object({ type: z.literal("imageView"), id: idSchema, path: pathSchema }).strict(),
  z.object({
    type: z.literal("sleep"),
    id: idSchema,
    durationMs: safeNonNegativeIntegerSchema,
  }).strict(),
  z.object({
    type: z.literal("imageGeneration"),
    id: idSchema,
    status: largeTextSchema,
    revisedPrompt: protocolTextSchema.nullable(),
    result: protocolTextSchema,
    savedPath: absolutePathSchema.optional(),
  }).strict(),
  z.object({
    type: z.literal("enteredReviewMode"),
    id: idSchema,
    review: protocolTextSchema,
  }).strict(),
  z.object({
    type: z.literal("exitedReviewMode"),
    id: idSchema,
    review: protocolTextSchema,
  }).strict(),
  z.object({ type: z.literal("contextCompaction"), id: idSchema }).strict(),
]);

const threadItemSchema = rawThreadItemSchema.transform((item) => {
  switch (item.type) {
    case "agentMessage":
    case "plan":
      return { type: item.type, id: item.id, text: item.text };
    case "reasoning":
      return { type: item.type, id: item.id, summary: item.summary };
    case "commandExecution":
      return {
        type: item.type,
        id: item.id,
        command: item.command,
        status: item.status,
        aggregatedOutput: item.aggregatedOutput,
        exitCode: item.exitCode,
      };
    case "fileChange":
      return {
        type: item.type,
        id: item.id,
        status: item.status,
        changes: item.changes.map(({ path }) => ({ path })),
      };
    case "userMessage":
      return {
        type: item.type,
        id: item.id,
        clientId: item.clientId,
      };
    case "hookPrompt":
    case "mcpToolCall":
    case "dynamicToolCall":
    case "collabAgentToolCall":
    case "subAgentActivity":
    case "webSearch":
    case "imageView":
    case "sleep":
    case "imageGeneration":
    case "enteredReviewMode":
    case "exitedReviewMode":
    case "contextCompaction":
      return { type: item.type, id: item.id };
  }
});

const codexErrorInfoSchema = z.union([
  z.enum([
    "contextWindowExceeded",
    "sessionBudgetExceeded",
    "usageLimitExceeded",
    "serverOverloaded",
    "cyberPolicy",
    "internalServerError",
    "unauthorized",
    "badRequest",
    "threadRollbackFailed",
    "sandboxError",
    "other",
  ]),
  z.object({ httpConnectionFailed: z.object({
    httpStatusCode: z.number().int().safe().nullable(),
  }).strict() }).strict(),
  z.object({ responseStreamConnectionFailed: z.object({
    httpStatusCode: z.number().int().safe().nullable(),
  }).strict() }).strict(),
  z.object({ responseStreamDisconnected: z.object({
    httpStatusCode: z.number().int().safe().nullable(),
  }).strict() }).strict(),
  z.object({ responseTooManyFailedAttempts: z.object({
    httpStatusCode: z.number().int().safe().nullable(),
  }).strict() }).strict(),
  z.object({ activeTurnNotSteerable: z.object({
    turnKind: z.enum(["review", "compact"]),
  }).strict() }).strict(),
]);
const turnErrorSchema = z.object({
  message: protocolTextSchema,
  codexErrorInfo: codexErrorInfoSchema.nullable(),
  additionalDetails: nullableProtocolTextSchema,
}).strict();
const turnSchema = z.object({
  id: idSchema,
  items: z.array(threadItemSchema).max(MAX_THREAD_ITEMS),
  itemsView: z.enum(["notLoaded", "summary", "full"]),
  status: z.enum(["completed", "interrupted", "failed", "inProgress"]),
  error: turnErrorSchema.nullable().optional(),
  startedAt: unixSecondsSchema.nullable(),
  completedAt: unixSecondsSchema.nullable(),
}).transform(({ error, ...turn }) => error?.codexErrorInfo === "usageLimitExceeded"
  ? { ...turn, quotaProof: "provider_usage_limit_exceeded" as const }
  : turn);

const threadSchema = z.object({
  id: idSchema,
  ephemeral: z.boolean(),
  historyMode: z.enum(["legacy", "paginated"]).optional(),
  preview: largeTextSchema,
  createdAt: unixSecondsSchema,
  updatedAt: unixSecondsSchema,
  status: threadStatusSchema,
  cwd: absolutePathSchema,
  threadSource: z.string().min(1).max(512).nullable(),
  name: largeTextSchema.nullable(),
  turns: z.array(turnSchema).max(MAX_THREAD_ITEMS),
});

const threadListInputSchema = z.object({
  cursor: z.string().max(MAX_PATH_CHARACTERS).nullable().optional(),
  limit: z.number().int().safe().min(1).max(MAX_THREADS_PER_PAGE).nullable().optional(),
  sortKey: z.enum(["created_at", "updated_at", "recency_at"]).nullable().optional(),
  sortDirection: z.enum(["asc", "desc"]).nullable().optional(),
  modelProviders: z.array(z.string().min(1).max(160)).max(64).nullable().optional(),
  sourceKinds: z.array(z.enum([
    "cli",
    "vscode",
    "exec",
    "appServer",
    "subAgent",
    "subAgentReview",
    "subAgentCompact",
    "subAgentThreadSpawn",
    "subAgentOther",
    "unknown",
  ])).max(64).nullable().optional(),
  archived: z.boolean().nullable().optional(),
  cwd: z.union([absolutePathSchema, z.array(absolutePathSchema).max(64)]).nullable().optional(),
  useStateDbOnly: z.boolean().optional(),
  searchTerm: z.string().max(1_024).nullable().optional(),
}).strict();
const threadListOutputSchema = z.object({
  data: z.array(threadSchema).max(MAX_THREADS_PER_PAGE),
  nextCursor: z.string().max(MAX_PATH_CHARACTERS).nullable(),
  backwardsCursor: z.string().max(MAX_PATH_CHARACTERS).nullable(),
});

const approvalPolicySchema = z.enum(["untrusted", "on-request", "never"]);
const approvalsReviewerSchema = z.enum(["user", "auto_review", "guardian_subagent"]);
const sandboxModeSchema = z.enum(["read-only", "workspace-write", "danger-full-access"]);
const modelNameSchema = z.string().min(1).max(160);
const reasoningEffortSchema = z.string().min(1).max(160);
const serviceTierNameSchema = z.string().min(1).max(160);
const threadSourceSchema = z.string().min(1).max(512);
const threadConfigSchema = z.record(
  z.string().min(1).max(256),
  losslessJsonValueSchema.optional(),
).superRefine((value, context) => {
  if (Object.keys(value).length > 64) {
    context.addIssue({
      code: "custom",
      message: "thread config exceeds the pinned key bound",
    });
  }
});
const threadStartInputSchema = z.object({
  model: modelNameSchema.nullable().optional(),
  allowProviderModelFallback: z.boolean().optional(),
  serviceTier: serviceTierNameSchema.nullable().optional(),
  cwd: absolutePathSchema.nullable().optional(),
  approvalPolicy: approvalPolicySchema.nullable().optional(),
  approvalsReviewer: approvalsReviewerSchema.nullable().optional(),
  sandbox: sandboxModeSchema.nullable().optional(),
  config: threadConfigSchema.nullable().optional(),
  developerInstructions: protocolTextSchema.nullable().optional(),
  ephemeral: z.boolean().nullable().optional(),
  historyMode: z.enum(["legacy", "paginated"]).nullable().optional(),
  threadSource: threadSourceSchema.nullable().optional(),
}).strict();
const threadResumeInputSchema = z.object({
  threadId: idSchema,
  model: modelNameSchema.nullable().optional(),
  serviceTier: serviceTierNameSchema.nullable().optional(),
  cwd: absolutePathSchema.nullable().optional(),
  approvalPolicy: approvalPolicySchema.nullable().optional(),
  approvalsReviewer: approvalsReviewerSchema.nullable().optional(),
  sandbox: sandboxModeSchema.nullable().optional(),
  config: threadConfigSchema.nullable().optional(),
  developerInstructions: protocolTextSchema.nullable().optional(),
}).strict();
const threadReadInputSchema = z.object({
  threadId: idSchema,
  includeTurns: z.boolean(),
}).strict();
const threadResponseSchema = z.object({ thread: threadSchema });
const threadAdmissionResponseSchema = threadResponseSchema.extend({
  model: modelNameSchema,
  reasoningEffort: reasoningEffortSchema.nullable(),
  serviceTier: serviceTierNameSchema.nullable(),
});
const threadForkInputSchema = z.object({
  threadId: idSchema,
  lastTurnId: idSchema.nullable().optional(),
  model: modelNameSchema.nullable().optional(),
  cwd: absolutePathSchema.nullable().optional(),
  approvalPolicy: approvalPolicySchema.nullable().optional(),
  approvalsReviewer: approvalsReviewerSchema.nullable().optional(),
  sandbox: sandboxModeSchema.nullable().optional(),
  developerInstructions: protocolTextSchema.nullable().optional(),
  ephemeral: z.boolean().optional(),
}).strict();

const historyThreadItemSchema = rawThreadItemSchema.transform((item) => {
  const providerEvidenceDigest = digestHistoryProviderEvidence(item);
  if (item.type === "userMessage") {
    const onlyInput = item.content.length === 1 ? item.content[0] : undefined;
    const context = onlyInput?.type === "text" && onlyInput.text_elements.length === 0
      ? { kind: "plainText" as const, text: onlyInput.text }
      : { kind: "nonRepresentable" as const };
    return {
      type: item.type,
      id: item.id,
      clientId: item.clientId,
      context,
      providerEvidenceDigest,
    } as const;
  }
  if (item.type === "agentMessage") {
    const context = item.phase === "final_answer" && item.memoryCitation === null
      ? { kind: "plainTextFinal" as const, text: item.text }
      : item.phase === "commentary"
        ? { kind: "nonFinal" as const }
        : { kind: "nonRepresentable" as const };
    return {
      type: item.type,
      id: item.id,
      phase: item.phase,
      context,
      providerEvidenceDigest,
      text: item.text,
    } as const;
  }
  return { type: item.type, id: item.id, providerEvidenceDigest } as const;
});

/**
 * Keep exact, content-free evidence for every parsed provider item. This
 * digest is deliberately computed before the history projection discards
 * attachments, paths, tool payloads, or other non-materializable fields.
 */
function digestHistoryProviderEvidence(value: unknown): string {
  return createHash("sha256")
    .update("oprte.pinned-codex.history-provider-item.v1\0")
    .update(JSON.stringify(canonicalHistoryProviderEvidence(value)))
    .digest("hex");
}

function canonicalHistoryProviderEvidence(value: unknown): unknown {
  if (value === null) return ["null"];
  if (Array.isArray(value)) {
    return ["array", value.map(canonicalHistoryProviderEvidence)];
  }
  if (value !== null && typeof value === "object") {
    return ["object", Object.entries(value)
      .toSorted(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([key, entry]) => [key, canonicalHistoryProviderEvidence(entry)])];
  }
  if (typeof value === "bigint") return ["bigint", value.toString()];
  if (typeof value === "boolean") return ["boolean", value];
  if (typeof value === "number") {
    return ["number", Object.is(value, -0) ? "-0" : value.toString()];
  }
  if (typeof value === "string") return ["string", value];
  if (value === undefined) return ["undefined"];
  throw new Error("Pinned Codex history evidence contains an unsupported value");
}

const historyTurnSchema = z.object({
  id: idSchema,
  items: z.array(historyThreadItemSchema).max(MAX_THREAD_ITEMS),
  itemsView: z.enum(["notLoaded", "summary", "full"]),
  status: z.enum(["completed", "interrupted", "failed", "inProgress"]),
  startedAt: unixSecondsSchema.nullable(),
  completedAt: unixSecondsSchema.nullable(),
});
const threadHistoryResponseSchema = z.object({
  thread: z.object({
    id: idSchema,
    turns: z.array(historyTurnSchema).max(MAX_THREAD_ITEMS),
  }),
});

const threadTurnsListInputSchema = z.object({
  threadId: idSchema,
  cursor: z.string().max(MAX_PATH_CHARACTERS).nullable().optional(),
  limit: z.number().int().safe().min(1).max(MAX_TURNS_PER_PAGE).nullable().optional(),
  sortDirection: z.enum(["asc", "desc"]).nullable().optional(),
  itemsView: z.enum(["notLoaded", "summary", "full"]).nullable().optional(),
}).strict();
const threadTurnsListOutputSchema = z.object({
  data: z.array(turnSchema).max(MAX_TURNS_PER_PAGE),
  nextCursor: z.string().max(MAX_PATH_CHARACTERS).nullable(),
  backwardsCursor: z.string().max(MAX_PATH_CHARACTERS).nullable(),
}).strict();
const threadItemsListInputSchema = z.object({
  threadId: idSchema,
  turnId: idSchema.nullable().optional(),
  cursor: z.string().max(MAX_PATH_CHARACTERS).nullable().optional(),
  limit: z.number().int().safe().min(1).max(MAX_ITEMS_PER_PAGE).nullable().optional(),
  sortDirection: z.enum(["asc", "desc"]).nullable().optional(),
}).strict();
const threadItemsListOutputSchema = z.object({
  data: z.array(historyThreadItemSchema).max(MAX_ITEMS_PER_PAGE),
  nextCursor: z.string().max(MAX_PATH_CHARACTERS).nullable(),
  backwardsCursor: z.string().max(MAX_PATH_CHARACTERS).nullable(),
}).strict();

const threadGoalStatusSchema = z.enum([
  "active",
  "paused",
  "blocked",
  "usageLimited",
  "budgetLimited",
  "complete",
]);
const threadGoalSchema = z.object({
  threadId: idSchema,
  objective: protocolTextSchema,
  status: threadGoalStatusSchema,
  tokenBudget: safeNonNegativeIntegerSchema.nullable(),
  tokensUsed: safeNonNegativeIntegerSchema,
  timeUsedSeconds: safeNonNegativeIntegerSchema,
  createdAt: unixSecondsSchema,
  updatedAt: unixSecondsSchema,
}).strict();
const threadGoalSetInputSchema = z.object({
  threadId: idSchema,
  objective: protocolTextSchema.nullable().optional(),
  status: threadGoalStatusSchema.nullable().optional(),
  tokenBudget: safeNonNegativeIntegerSchema.nullable().optional(),
}).strict();
const threadGoalGetInputSchema = z.object({ threadId: idSchema }).strict();
const threadGoalClearInputSchema = threadGoalGetInputSchema;
const threadGoalSetOutputSchema = z.object({ goal: threadGoalSchema }).strict();
const threadGoalGetOutputSchema = z.object({ goal: threadGoalSchema.nullable() }).strict();
const threadGoalClearOutputSchema = z.object({ cleared: z.boolean() }).strict();

const threadSetNameInputSchema = z.object({
  threadId: idSchema,
  name: z.string().min(1).max(160),
}).strict();
const injectedHistoryItemSchema = z.discriminatedUnion("role", [
  z.object({
    type: z.literal("message"),
    role: z.literal("user"),
    content: z.array(z.object({
      type: z.literal("input_text"),
      text: protocolTextSchema,
    }).strict()).min(1).max(1),
  }).strict(),
  z.object({
    type: z.literal("message"),
    role: z.literal("assistant"),
    content: z.array(z.object({
      type: z.literal("output_text"),
      text: protocolTextSchema,
    }).strict()).min(1).max(1),
  }).strict(),
]);
const threadInjectItemsInputSchema = z.object({
  threadId: idSchema,
  items: z.array(injectedHistoryItemSchema).min(1).max(1_024),
}).strict();
const modelListInputSchema = z.object({
  cursor: z.string().max(MAX_PATH_CHARACTERS).nullable().optional(),
  limit: z.number().int().safe().min(1).max(256).nullable().optional(),
  includeHidden: z.boolean().nullable().optional(),
}).strict();
const modelListOutputSchema = z.object({
  data: z.array(z.object({
    model: modelNameSchema,
    supportedReasoningEfforts: z.array(z.object({
      reasoningEffort: reasoningEffortSchema,
    }).passthrough()).max(32),
    serviceTiers: z.array(z.object({
      id: serviceTierNameSchema,
      name: z.string().min(1).max(160),
      description: z.string().max(1_024),
    }).strict()).max(32).default([]),
  }).passthrough()).max(256),
  nextCursor: z.string().max(MAX_PATH_CHARACTERS).nullable(),
});

const textInputSchema = z.object({
  type: z.literal("text"),
  text: z.string().min(1).max(MAX_TEXT_CHARACTERS),
  text_elements: z.array(z.never()).max(0),
}).strict();
const turnStartInputSchema = z.object({
  threadId: idSchema,
  clientUserMessageId: idSchema,
  input: z.array(textInputSchema).min(1).max(64),
  cwd: absolutePathSchema.nullable().optional(),
  approvalPolicy: approvalPolicySchema.nullable().optional(),
  approvalsReviewer: approvalsReviewerSchema.nullable().optional(),
  sandboxPolicy: z.discriminatedUnion("type", [
    z.object({ type: z.literal("dangerFullAccess") }).strict(),
    z.object({ type: z.literal("readOnly"), networkAccess: z.boolean() }).strict(),
    z.object({
      type: z.literal("externalSandbox"),
      networkAccess: z.enum(["restricted", "enabled"]),
    }).strict(),
    z.object({
      type: z.literal("workspaceWrite"),
      writableRoots: z.array(absolutePathSchema).max(64),
      networkAccess: z.boolean(),
      excludeTmpdirEnvVar: z.boolean(),
      excludeSlashTmp: z.boolean(),
    }).strict(),
  ]).nullable().optional(),
  model: modelNameSchema.nullable().optional(),
  effort: reasoningEffortSchema.nullable().optional(),
  serviceTier: serviceTierNameSchema.nullable().optional(),
}).strict();
const turnStartOutputSchema = z.object({ turn: turnSchema });
const turnSteerInputSchema = z.object({
  threadId: idSchema,
  clientUserMessageId: idSchema.nullable().optional(),
  input: z.array(textInputSchema).min(1).max(64),
  expectedTurnId: idSchema,
}).strict();
const turnSteerOutputSchema = z.object({ turnId: idSchema });
const turnInterruptInputSchema = z.object({ threadId: idSchema, turnId: idSchema }).strict();
const turnInterruptOutputSchema = emptyObjectSchema.transform(() => ({
  kind: "accepted_pending_terminal" as const,
}));

export interface PinnedCodexCodec<T> {
  parse(value: unknown): T;
}

function codec<T>(schema: Readonly<{ parse(value: unknown): T }>): PinnedCodexCodec<T> {
  return Object.freeze({
    parse(value: unknown): T {
      try {
        return schema.parse(value);
      } catch {
        throw new Error("Pinned Codex payload validation failed");
      }
    },
  });
}

export type PinnedCodexInitializeInput = z.infer<typeof initializeInputSchema>;
export type PinnedCodexInitializeOutput = z.infer<typeof initializeOutputSchema>;
export type PinnedCodexLoginStartInput = z.infer<typeof loginStartInputSchema>;
export type PinnedCodexLoginStart = z.infer<typeof loginStartOutputSchema>;
export type PinnedCodexLoginCancelInput = z.infer<typeof loginCancelInputSchema>;
export type PinnedCodexLoginCancel = z.infer<typeof loginCancelOutputSchema>;
export type PinnedCodexAccountReadInput = z.infer<typeof accountReadInputSchema>;
export type PinnedCodexAccountRead = z.infer<typeof accountReadOutputSchema>;
export type PinnedCodexRateLimits = z.infer<typeof rateLimitsOutputSchema>;
export type PinnedCodexTokenUsage = z.infer<typeof tokenUsageOutputSchema>;
export type PinnedCodexThreadItem = z.infer<typeof threadItemSchema>;
export type PinnedCodexTurn = z.infer<typeof turnSchema>;
export type PinnedCodexThread = z.infer<typeof threadSchema>;
export type PinnedCodexThreadListInput = z.infer<typeof threadListInputSchema>;
export type PinnedCodexThreadList = z.infer<typeof threadListOutputSchema>;
export type PinnedCodexThreadStartInput = z.infer<typeof threadStartInputSchema>;
export type PinnedCodexThreadResumeInput = z.infer<typeof threadResumeInputSchema>;
export type PinnedCodexThreadReadInput = z.infer<typeof threadReadInputSchema>;
export type PinnedCodexThreadResponse = z.infer<typeof threadResponseSchema>;
export type PinnedCodexThreadAdmissionResponse = z.infer<
  typeof threadAdmissionResponseSchema
>;
export type PinnedCodexThreadForkInput = z.infer<typeof threadForkInputSchema>;
export type PinnedCodexThreadHistoryResponse = z.infer<typeof threadHistoryResponseSchema>;
export type PinnedCodexHistoryThreadItem = z.infer<typeof historyThreadItemSchema>;
export type PinnedCodexThreadTurnsListInput = z.infer<typeof threadTurnsListInputSchema>;
export type PinnedCodexThreadTurnsList = z.infer<typeof threadTurnsListOutputSchema>;
export type PinnedCodexThreadItemsListInput = z.infer<typeof threadItemsListInputSchema>;
export type PinnedCodexThreadItemsList = z.infer<typeof threadItemsListOutputSchema>;
export type PinnedCodexThreadGoal = z.infer<typeof threadGoalSchema>;
export type PinnedCodexThreadGoalSetInput = z.infer<typeof threadGoalSetInputSchema>;
export type PinnedCodexThreadGoalGetInput = z.infer<typeof threadGoalGetInputSchema>;
export type PinnedCodexThreadGoalClearInput = z.infer<typeof threadGoalClearInputSchema>;
export type PinnedCodexThreadSetNameInput = z.infer<typeof threadSetNameInputSchema>;
export type PinnedCodexThreadInjectItemsInput = z.infer<typeof threadInjectItemsInputSchema>;
export type PinnedCodexModelListInput = z.infer<typeof modelListInputSchema>;
export type PinnedCodexModelList = z.infer<typeof modelListOutputSchema>;
export type PinnedCodexTurnStartInput = z.infer<typeof turnStartInputSchema>;
export type PinnedCodexTurnStart = z.infer<typeof turnStartOutputSchema>;
export type PinnedCodexTurnSteerInput = z.infer<typeof turnSteerInputSchema>;
export type PinnedCodexTurnSteer = z.infer<typeof turnSteerOutputSchema>;
export type PinnedCodexTurnInterruptInput = z.infer<typeof turnInterruptInputSchema>;
export type PinnedCodexTurnInterrupt = z.infer<typeof turnInterruptOutputSchema>;

export interface PinnedCodexRequestShapes {
  readonly clientInitialize: {
    readonly input: PinnedCodexInitializeInput;
    readonly output: PinnedCodexInitializeOutput;
  };
  readonly accountLoginStart: {
    readonly input: PinnedCodexLoginStartInput;
    readonly output: PinnedCodexLoginStart;
  };
  readonly accountLoginCancel: {
    readonly input: PinnedCodexLoginCancelInput;
    readonly output: PinnedCodexLoginCancel;
  };
  readonly accountLogout: { readonly input: undefined; readonly output: undefined };
  readonly accountRead: {
    readonly input: PinnedCodexAccountReadInput;
    readonly output: PinnedCodexAccountRead;
  };
  readonly accountRateLimitsRead: {
    readonly input: undefined;
    readonly output: PinnedCodexRateLimits;
  };
  readonly accountUsageRead: {
    readonly input: undefined;
    readonly output: PinnedCodexTokenUsage;
  };
  readonly threadList: {
    readonly input: PinnedCodexThreadListInput;
    readonly output: PinnedCodexThreadList;
  };
  readonly threadStart: {
    readonly input: PinnedCodexThreadStartInput;
    readonly output: PinnedCodexThreadAdmissionResponse;
  };
  readonly threadResume: {
    readonly input: PinnedCodexThreadResumeInput;
    readonly output: PinnedCodexThreadAdmissionResponse;
  };
  readonly threadRead: {
    readonly input: PinnedCodexThreadReadInput;
    readonly output: PinnedCodexThreadResponse;
  };
  readonly threadHistoryRead: {
    readonly input: PinnedCodexThreadReadInput;
    readonly output: PinnedCodexThreadHistoryResponse;
  };
  readonly threadTurnsList: {
    readonly input: PinnedCodexThreadTurnsListInput;
    readonly output: PinnedCodexThreadTurnsList;
  };
  readonly threadItemsList: {
    readonly input: PinnedCodexThreadItemsListInput;
    readonly output: PinnedCodexThreadItemsList;
  };
  readonly threadFork: {
    readonly input: PinnedCodexThreadForkInput;
    readonly output: PinnedCodexThreadResponse;
  };
  readonly threadGoalSet: {
    readonly input: PinnedCodexThreadGoalSetInput;
    readonly output: Readonly<{ goal: PinnedCodexThreadGoal }>;
  };
  readonly threadGoalGet: {
    readonly input: PinnedCodexThreadGoalGetInput;
    readonly output: Readonly<{ goal: PinnedCodexThreadGoal | null }>;
  };
  readonly threadGoalClear: {
    readonly input: PinnedCodexThreadGoalClearInput;
    readonly output: Readonly<{ cleared: boolean }>;
  };
  readonly threadSetName: {
    readonly input: PinnedCodexThreadSetNameInput;
    readonly output: undefined;
  };
  readonly threadInjectItems: {
    readonly input: PinnedCodexThreadInjectItemsInput;
    readonly output: undefined;
  };
  readonly modelList: {
    readonly input: PinnedCodexModelListInput;
    readonly output: PinnedCodexModelList;
  };
  readonly turnStart: {
    readonly input: PinnedCodexTurnStartInput;
    readonly output: PinnedCodexTurnStart;
  };
  readonly turnSteer: {
    readonly input: PinnedCodexTurnSteerInput;
    readonly output: PinnedCodexTurnSteer;
  };
  readonly turnInterrupt: {
    readonly input: PinnedCodexTurnInterruptInput;
    readonly output: PinnedCodexTurnInterrupt;
  };
}

export const pinnedCodexCodecPairs = Object.freeze({
  clientInitialize: Object.freeze({
    input: codec(initializeInputSchema),
    output: codec(initializeOutputSchema),
  }),
  accountLoginStart: Object.freeze({
    input: codec(loginStartInputSchema),
    output: codec(loginStartOutputSchema),
  }),
  accountLoginCancel: Object.freeze({
    input: codec(loginCancelInputSchema),
    output: codec(loginCancelOutputSchema),
  }),
  accountLogout: Object.freeze({ input: codec(undefinedSchema), output: codec(emptyObjectSchema) }),
  accountRead: Object.freeze({
    input: codec(accountReadInputSchema),
    output: codec(accountReadOutputSchema),
  }),
  accountRateLimitsRead: Object.freeze({
    input: codec(undefinedSchema),
    output: codec(rateLimitsOutputSchema),
  }),
  accountUsageRead: Object.freeze({
    input: codec(undefinedSchema),
    output: codec(tokenUsageOutputSchema),
  }),
  threadList: Object.freeze({
    input: codec(threadListInputSchema),
    output: codec(threadListOutputSchema),
  }),
  threadStart: Object.freeze({
    input: codec(threadStartInputSchema),
    output: codec(threadAdmissionResponseSchema),
  }),
  threadResume: Object.freeze({
    input: codec(threadResumeInputSchema),
    output: codec(threadAdmissionResponseSchema),
  }),
  threadRead: Object.freeze({
    input: codec(threadReadInputSchema),
    output: codec(threadResponseSchema),
  }),
  threadHistoryRead: Object.freeze({
    input: codec(threadReadInputSchema),
    output: codec(threadHistoryResponseSchema),
  }),
  threadTurnsList: Object.freeze({
    input: codec(threadTurnsListInputSchema),
    output: codec(threadTurnsListOutputSchema),
  }),
  threadItemsList: Object.freeze({
    input: codec(threadItemsListInputSchema),
    output: codec(threadItemsListOutputSchema),
  }),
  threadFork: Object.freeze({
    input: codec(threadForkInputSchema),
    output: codec(threadResponseSchema),
  }),
  threadGoalSet: Object.freeze({
    input: codec(threadGoalSetInputSchema),
    output: codec(threadGoalSetOutputSchema),
  }),
  threadGoalGet: Object.freeze({
    input: codec(threadGoalGetInputSchema),
    output: codec(threadGoalGetOutputSchema),
  }),
  threadGoalClear: Object.freeze({
    input: codec(threadGoalClearInputSchema),
    output: codec(threadGoalClearOutputSchema),
  }),
  threadSetName: Object.freeze({
    input: codec(threadSetNameInputSchema),
    output: codec(emptyObjectSchema),
  }),
  threadInjectItems: Object.freeze({
    input: codec(threadInjectItemsInputSchema),
    output: codec(emptyObjectSchema),
  }),
  modelList: Object.freeze({
    input: codec(modelListInputSchema),
    output: codec(modelListOutputSchema),
  }),
  turnStart: Object.freeze({
    input: codec(turnStartInputSchema),
    output: codec(turnStartOutputSchema),
  }),
  turnSteer: Object.freeze({
    input: codec(turnSteerInputSchema),
    output: codec(turnSteerOutputSchema),
  }),
  turnInterrupt: Object.freeze({
    input: codec(turnInterruptInputSchema),
    output: codec(turnInterruptOutputSchema),
  }),
}) satisfies {
  readonly [K in keyof PinnedCodexRequestShapes]: {
    readonly input: PinnedCodexCodec<PinnedCodexRequestShapes[K]["input"]>;
    readonly output: PinnedCodexCodec<PinnedCodexRequestShapes[K]["output"]>;
  };
};

export const pinnedCodexMethods = Object.freeze({
  clientInitialize: "initialize",
  accountLoginStart: "account/login/start",
  accountLoginCancel: "account/login/cancel",
  accountLogout: "account/logout",
  accountRead: "account/read",
  accountRateLimitsRead: "account/rateLimits/read",
  accountUsageRead: "account/usage/read",
  threadList: "thread/list",
  threadStart: "thread/start",
  threadResume: "thread/resume",
  threadRead: "thread/read",
  threadHistoryRead: "thread/read",
  threadTurnsList: "thread/turns/list",
  threadItemsList: "thread/items/list",
  threadFork: "thread/fork",
  threadGoalSet: "thread/goal/set",
  threadGoalGet: "thread/goal/get",
  threadGoalClear: "thread/goal/clear",
  threadSetName: "thread/name/set",
  threadInjectItems: "thread/inject_items",
  modelList: "model/list",
  turnStart: "turn/start",
  turnSteer: "turn/steer",
  turnInterrupt: "turn/interrupt",
} as const);

type PinnedOperation = keyof PinnedCodexRequestShapes;
type GeneratedOperation = PinnedOperation;
type PinnedMethod<K extends GeneratedOperation> = (typeof pinnedCodexMethods)[K];
type GeneratedParams<K extends GeneratedOperation> = Extract<
  GeneratedClientRequest,
  { readonly method: PinnedMethod<K> }
>["params"];

interface GeneratedResponses {
  readonly clientInitialize: GeneratedInitializeResponse;
  readonly accountLoginStart: GeneratedLoginAccountResponse;
  readonly accountLoginCancel: GeneratedCancelLoginAccountResponse;
  readonly accountLogout: GeneratedLogoutAccountResponse;
  readonly accountRead: GeneratedGetAccountResponse;
  readonly accountRateLimitsRead: GeneratedGetAccountRateLimitsResponse;
  readonly accountUsageRead: GeneratedGetAccountTokenUsageResponse;
  readonly threadList: GeneratedThreadListResponse;
  readonly threadStart: GeneratedThreadStartResponse;
  readonly threadResume: GeneratedThreadResumeResponse;
  readonly threadRead: GeneratedThreadReadResponse;
  readonly threadHistoryRead: GeneratedThreadReadResponse;
  readonly threadTurnsList: GeneratedThreadTurnsListResponse;
  readonly threadItemsList: GeneratedThreadItemsListResponse;
  readonly threadFork: GeneratedThreadForkResponse;
  readonly threadGoalSet: GeneratedThreadGoalSetResponse;
  readonly threadGoalGet: GeneratedThreadGoalGetResponse;
  readonly threadGoalClear: GeneratedThreadGoalClearResponse;
  readonly threadSetName: GeneratedThreadSetNameResponse;
  readonly threadInjectItems: GeneratedThreadInjectItemsResponse;
  readonly modelList: GeneratedModelListResponse;
  readonly turnStart: GeneratedTurnStartResponse;
  readonly turnSteer: GeneratedTurnSteerResponse;
  readonly turnInterrupt: GeneratedTurnInterruptResponse;
}

type NormalizeGenerated<T> = T extends bigint
  ? string
  : T extends readonly (infer Entry)[]
    ? NormalizeGenerated<Entry>[]
    : T extends object
      ? { readonly [K in keyof T]: NormalizeGenerated<T[K]> }
      : T;

type WireShape<T> = T extends readonly (infer Entry)[]
  ? WireShape<Entry>[]
  : T extends object
    ? {
        readonly [K in keyof T as undefined extends T[K] ? never : K]: WireShape<T[K]>;
      } & {
        readonly [K in keyof T as undefined extends T[K] ? K : never]?: WireShape<
          Exclude<T[K], undefined>
        >;
      }
    : T;

type OutputCodecInput<K extends GeneratedOperation> =
  K extends "clientInitialize"
    ? z.input<typeof initializeOutputSchema>
    : K extends "accountLoginStart"
      ? z.input<typeof loginStartOutputSchema>
      : K extends "accountLoginCancel"
        ? z.input<typeof loginCancelOutputSchema>
        : K extends "accountLogout" | "turnInterrupt" | "threadSetName" | "threadInjectItems"
          ? z.input<typeof emptyObjectSchema>
          : K extends "accountRead"
            ? z.input<typeof accountReadOutputSchema>
            : K extends "accountRateLimitsRead"
              ? z.input<typeof rateLimitsOutputSchema>
              : K extends "accountUsageRead"
                ? z.input<typeof tokenUsageOutputSchema>
                : K extends "threadList"
                  ? z.input<typeof threadListOutputSchema>
                  : K extends "threadStart" | "threadResume"
                    ? z.input<typeof threadAdmissionResponseSchema>
                    : K extends "threadRead" | "threadFork"
                      ? z.input<typeof threadResponseSchema>
                    : K extends "threadHistoryRead"
                      ? z.input<typeof threadHistoryResponseSchema>
                      : K extends "threadTurnsList"
                        ? z.input<typeof threadTurnsListOutputSchema>
                        : K extends "threadItemsList"
                          ? z.input<typeof threadItemsListOutputSchema>
                      : K extends "threadGoalSet"
                        ? z.input<typeof threadGoalSetOutputSchema>
                        : K extends "threadGoalGet"
                          ? z.input<typeof threadGoalGetOutputSchema>
                          : K extends "threadGoalClear"
                            ? z.input<typeof threadGoalClearOutputSchema>
                    : K extends "modelList"
                      ? z.input<typeof modelListOutputSchema>
                      : K extends "turnStart"
                        ? z.input<typeof turnStartOutputSchema>
                        : K extends "turnSteer"
                          ? z.input<typeof turnSteerOutputSchema>
                          : never;

type InputCompatibility = {
  readonly [K in GeneratedOperation]: WireShape<
    PinnedCodexRequestShapes[K]["input"]
  > extends GeneratedParams<K>
    ? true
    : false;
};
type OutputCompatibility = {
  readonly [K in GeneratedOperation]: GeneratedResponses[K] extends OutputCodecInput<K>
    ? true
    : false;
};

export const pinnedCodexGeneratedAssociationWitness = Object.freeze({
  input: Object.freeze({
    clientInitialize: true,
    accountLoginStart: true,
    accountLoginCancel: true,
    accountLogout: true,
    accountRead: true,
    accountRateLimitsRead: true,
    accountUsageRead: true,
    threadList: true,
    threadStart: true,
    threadResume: true,
    threadRead: true,
    threadHistoryRead: true,
    threadTurnsList: true,
    threadItemsList: true,
    threadFork: true,
    threadGoalSet: true,
    threadGoalGet: true,
    threadGoalClear: true,
    threadSetName: true,
    threadInjectItems: true,
    modelList: true,
    turnStart: true,
    turnSteer: true,
    turnInterrupt: true,
  } satisfies InputCompatibility),
  output: Object.freeze({
    clientInitialize: true,
    accountLoginStart: true,
    accountLoginCancel: true,
    accountLogout: true,
    accountRead: true,
    accountRateLimitsRead: true,
    accountUsageRead: true,
    threadList: true,
    threadStart: true,
    threadResume: true,
    threadRead: true,
    threadHistoryRead: true,
    threadTurnsList: true,
    threadItemsList: true,
    threadFork: true,
    threadGoalSet: true,
    threadGoalGet: true,
    threadGoalClear: true,
    threadSetName: true,
    threadInjectItems: true,
    modelList: true,
    turnStart: true,
    turnSteer: true,
    turnInterrupt: true,
  } satisfies OutputCompatibility),
});

export const codexNotificationDispositions = Object.freeze({
  error: "ignored",
  "thread/started": "routed",
  "thread/status/changed": "routed",
  "thread/archived": "routed",
  "thread/deleted": "routed",
  "thread/unarchived": "routed",
  "thread/closed": "routed",
  "skills/changed": "ignored",
  "thread/name/updated": "routed",
  "thread/goal/updated": "ignored",
  "thread/goal/cleared": "ignored",
  "thread/settings/updated": "ignored",
  "thread/tokenUsage/updated": "routed",
  "turn/started": "routed",
  "hook/started": "ignored",
  "turn/completed": "routed",
  "hook/completed": "ignored",
  "turn/diff/updated": "ignored",
  "turn/plan/updated": "routed",
  "item/started": "routed",
  "item/autoApprovalReview/started": "ignored",
  "item/autoApprovalReview/completed": "ignored",
  "item/completed": "routed",
  "rawResponseItem/completed": "ignored",
  "item/agentMessage/delta": "routed",
  "item/plan/delta": "ignored",
  "command/exec/outputDelta": "ignored",
  "process/outputDelta": "ignored",
  "process/exited": "ignored",
  "item/commandExecution/outputDelta": "routed",
  "item/commandExecution/terminalInteraction": "ignored",
  "item/fileChange/outputDelta": "ignored",
  "item/fileChange/patchUpdated": "routed",
  "serverRequest/resolved": "control",
  "item/mcpToolCall/progress": "ignored",
  "mcpServer/oauthLogin/completed": "ignored",
  "mcpServer/startupStatus/updated": "ignored",
  "account/updated": "routed",
  "account/rateLimits/updated": "routed",
  "app/list/updated": "ignored",
  "remoteControl/status/changed": "ignored",
  "externalAgentConfig/import/progress": "ignored",
  "externalAgentConfig/import/completed": "ignored",
  "fs/changed": "ignored",
  "item/reasoning/summaryTextDelta": "routed",
  "item/reasoning/summaryPartAdded": "ignored",
  "item/reasoning/textDelta": "discarded",
  "thread/compacted": "ignored",
  "model/rerouted": "routed",
  "model/verification": "ignored",
  "turn/moderationMetadata": "ignored",
  "model/safetyBuffering/updated": "ignored",
  warning: "ignored",
  guardianWarning: "ignored",
  deprecationNotice: "ignored",
  configWarning: "ignored",
  "fuzzyFileSearch/sessionUpdated": "ignored",
  "fuzzyFileSearch/sessionCompleted": "ignored",
  "thread/realtime/started": "ignored",
  "thread/realtime/itemAdded": "ignored",
  "thread/realtime/transcript/delta": "ignored",
  "thread/realtime/transcript/done": "ignored",
  "thread/realtime/outputAudio/delta": "ignored",
  "thread/realtime/sdp": "ignored",
  "thread/realtime/error": "ignored",
  "thread/realtime/closed": "ignored",
  "windows/worldWritableWarning": "ignored",
  "windowsSandbox/setupCompleted": "ignored",
  "account/login/completed": "routed",
} as const satisfies Record<
  GeneratedServerNotification["method"],
  "routed" | "ignored" | "control" | "discarded"
>);

export const codexServerRequestDispositions = Object.freeze({
  "item/commandExecution/requestApproval": "routed",
  "item/fileChange/requestApproval": "routed",
  "item/tool/requestUserInput": "routed",
  "mcpServer/elicitation/request": "routed",
  "item/permissions/requestApproval": "routed",
  "item/tool/call": "rejected",
  "currentTime/read": "rejected",
  "account/chatgptAuthTokens/refresh": "rejected",
  "attestation/generate": "rejected",
  applyPatchApproval: "routed",
  execCommandApproval: "routed",
} as const satisfies Record<GeneratedServerRequest["method"], "routed" | "rejected">);

export type CodexNotificationMethod = keyof typeof codexNotificationDispositions;
export type CodexServerRequestMethod = keyof typeof codexServerRequestDispositions;
export type RoutedCodexServerRequestMethod = {
  readonly [K in CodexServerRequestMethod]:
    (typeof codexServerRequestDispositions)[K] extends "routed" ? K : never;
}[CodexServerRequestMethod];

export const supportedCodexNotificationMethods = Object.freeze(
  Object.keys(codexNotificationDispositions) as CodexNotificationMethod[],
);
export const supportedCodexServerRequestMethods = Object.freeze(
  Object.entries(codexServerRequestDispositions)
    .filter(([, disposition]) => disposition === "routed")
    .map(([method]) => method) as RoutedCodexServerRequestMethod[],
);

export function isCodexNotificationMethod(
  method: string,
): method is CodexNotificationMethod {
  return Object.hasOwn(codexNotificationDispositions, method);
}

export function isRoutedCodexServerRequestMethod(
  method: string,
): method is RoutedCodexServerRequestMethod {
  return Object.hasOwn(codexServerRequestDispositions, method) &&
    codexServerRequestDispositions[method as CodexServerRequestMethod] === "routed";
}

const accountLoginCompletedSchema = z.object({
  loginId: z.string().min(1).max(256).nullable(),
  success: z.boolean(),
  error: z.string().max(4_096).nullable(),
}).strict().transform(({ loginId, success }) => ({ loginId, success }));
const accountUpdatedSchema = z.object({
  authMode: authModeSchema.nullable(),
  planType: planTypeSchema.nullable(),
});
const codex01446SparseRateLimitSnapshotSchema = z.object({
  limitId: z.string().min(1).max(160).nullable().optional(),
  limitName: z.string().min(1).max(160).nullable().optional(),
  primary: rateLimitWindowSchema.nullable().optional(),
  secondary: rateLimitWindowSchema.nullable().optional(),
  credits: creditsSnapshotSchema.nullable().optional(),
  individualLimit: spendControlLimitSchema.nullable().optional(),
  planType: planTypeSchema.nullable().optional(),
  rateLimitReachedType: rateLimitReachedTypeSchema.nullable().optional(),
}).strict();
const accountRateLimitsUpdatedSchema = z.object({
  rateLimits: codex01446SparseRateLimitSnapshotSchema,
}).strict();
const threadStartedSchema = z.object({ thread: threadSchema });
const threadReferenceSchema = z.object({ threadId: idSchema }).strict();
const threadStatusChangedSchema = threadReferenceSchema.extend({
  status: threadStatusSchema,
}).strict();
const threadNameUpdatedSchema = threadReferenceSchema.extend({
  threadName: largeTextSchema.optional(),
}).strict().transform(({ threadId, threadName }) => ({
  threadId,
  threadName: threadName ?? null,
}));
const turnLifecycleSchema = z.object({ threadId: idSchema, turn: turnSchema });
const threadTokenUsageUpdatedSchema = z.object({
  threadId: idSchema,
  turnId: idSchema,
  tokenUsage: z.object({
    total: z.object({
      totalTokens: z.number().int().nonnegative().safe(),
      inputTokens: z.number().int().nonnegative().safe(),
      cachedInputTokens: z.number().int().nonnegative().safe(),
      outputTokens: z.number().int().nonnegative().safe(),
      reasoningOutputTokens: z.number().int().nonnegative().safe(),
    }).strict(),
    last: z.object({
      totalTokens: z.number().int().nonnegative().safe(),
      inputTokens: z.number().int().nonnegative().safe(),
      cachedInputTokens: z.number().int().nonnegative().safe(),
      outputTokens: z.number().int().nonnegative().safe(),
      reasoningOutputTokens: z.number().int().nonnegative().safe(),
    }).strict(),
    modelContextWindow: z.number().int().positive().safe().nullable(),
  }).strict(),
}).strict();
const activityReferenceSchema = z.object({ threadId: idSchema, turnId: idSchema });
const modelReroutedSchema = activityReferenceSchema.extend({
  fromModel: modelNameSchema,
  toModel: modelNameSchema,
  reason: z.literal("highRiskCyberActivity"),
}).strict();
const turnPlanUpdatedWireSchema = activityReferenceSchema.extend({
  explanation: protocolTextSchema.nullable(),
  plan: z.array(z.object({
    step: protocolTextSchema,
    status: z.enum(["pending", "inProgress", "completed"]),
  })).max(1_024),
}).transform(({ threadId, turnId }) => ({ threadId, turnId }));
const itemStartedSchema = activityReferenceSchema.extend({
  item: threadItemSchema,
  startedAtMs: unixMillisecondsSchema,
});
const itemCompletedSchema = activityReferenceSchema.extend({
  item: threadItemSchema,
  completedAtMs: unixMillisecondsSchema,
});
const deltaSchema = activityReferenceSchema.extend({
  itemId: idSchema,
  delta: protocolTextSchema,
});
const reasoningSummaryDeltaSchema = deltaSchema.extend({
  summaryIndex: safeNonNegativeIntegerSchema,
});
const discardedReasoningDeltaSchema = deltaSchema.extend({
  contentIndex: safeNonNegativeIntegerSchema,
}).transform(() => undefined);
const patchUpdatedWireSchema = activityReferenceSchema.extend({
  itemId: idSchema,
  changes: z.array(z.object({
    path: pathSchema,
    kind: z.discriminatedUnion("type", [
      z.object({ type: z.literal("add") }),
      z.object({ type: z.literal("delete") }),
      z.object({ type: z.literal("update"), move_path: pathSchema.nullable() }),
    ]),
    diff: protocolTextSchema,
  })).max(512),
}).transform(({ threadId, turnId }) => ({ threadId, turnId }));
const resolvedRequestSchema = z.object({
  threadId: idSchema,
  requestId: z.union([z.string().min(1).max(512), z.number().int().safe()]),
});

export type PinnedCodexAccountLoginCompleted = z.infer<typeof accountLoginCompletedSchema>;
export type PinnedCodexAccountUpdated = z.infer<typeof accountUpdatedSchema>;
export type PinnedCodexRateLimitsUpdated = z.infer<typeof accountRateLimitsUpdatedSchema>;
export type PinnedCodexTurnLifecycle = z.infer<typeof turnLifecycleSchema>;
export type PinnedCodexActivityReference = z.infer<typeof activityReferenceSchema>;
export type PinnedCodexModelRerouted = z.infer<typeof modelReroutedSchema>;
export type PinnedCodexItemLifecycle =
  | z.infer<typeof itemStartedSchema>
  | z.infer<typeof itemCompletedSchema>;
export type PinnedCodexDelta = z.infer<typeof deltaSchema>;
export type PinnedCodexReasoningSummaryDelta = z.infer<typeof reasoningSummaryDeltaSchema>;
export type PinnedCodexServerRequestResolved = z.infer<typeof resolvedRequestSchema>;
export type PinnedCodexThreadReference = z.infer<typeof threadReferenceSchema>;
export type PinnedCodexThreadStatusChanged = z.infer<typeof threadStatusChangedSchema>;
export type PinnedCodexThreadNameUpdated = z.infer<typeof threadNameUpdatedSchema>;
export type PinnedCodexThreadTokenUsageUpdated = z.infer<typeof threadTokenUsageUpdatedSchema>;

type IgnoredNotificationMethod = {
  readonly [K in CodexNotificationMethod]:
    (typeof codexNotificationDispositions)[K] extends "ignored" ? K : never;
}[CodexNotificationMethod];

function isIgnoredCodexNotificationMethod(
  method: CodexNotificationMethod,
): method is IgnoredNotificationMethod {
  return codexNotificationDispositions[method] === "ignored";
}

export type ParsedCodexNotification =
  | Readonly<{ method: "account/login/completed"; params: PinnedCodexAccountLoginCompleted }>
  | Readonly<{ method: "account/updated"; params: PinnedCodexAccountUpdated }>
  | Readonly<{ method: "account/rateLimits/updated"; params: PinnedCodexRateLimitsUpdated }>
  | Readonly<{ method: "thread/started"; params: PinnedCodexThreadResponse }>
  | Readonly<{
      method: "thread/archived" | "thread/closed" | "thread/deleted" | "thread/unarchived";
      params: PinnedCodexThreadReference;
    }>
  | Readonly<{
      method: "thread/status/changed";
      params: PinnedCodexThreadStatusChanged;
    }>
  | Readonly<{
      method: "thread/name/updated";
      params: PinnedCodexThreadNameUpdated;
    }>
  | Readonly<{
      method: "thread/tokenUsage/updated";
      params: PinnedCodexThreadTokenUsageUpdated;
    }>
  | Readonly<{ method: "turn/started" | "turn/completed"; params: PinnedCodexTurnLifecycle }>
  | Readonly<{
      method: "turn/plan/updated";
      params: PinnedCodexActivityReference;
    }>
  | Readonly<{
      method: "item/fileChange/patchUpdated";
      params: PinnedCodexActivityReference;
    }>
  | Readonly<{ method: "item/started"; params: z.infer<typeof itemStartedSchema> }>
  | Readonly<{ method: "item/completed"; params: z.infer<typeof itemCompletedSchema> }>
  | Readonly<{
      method:
        | "item/agentMessage/delta"
        | "item/commandExecution/outputDelta";
      params: PinnedCodexDelta;
    }>
  | Readonly<{
      method: "item/reasoning/summaryTextDelta";
      params: PinnedCodexReasoningSummaryDelta;
    }>
  | Readonly<{
      method: "serverRequest/resolved";
      params: PinnedCodexServerRequestResolved;
    }>
  | Readonly<{
      method: "model/rerouted";
      params: PinnedCodexModelRerouted;
    }>
  | Readonly<{ method: "item/reasoning/textDelta"; params: undefined }>
  | Readonly<{ method: IgnoredNotificationMethod; params: undefined }>;

export function parseCodexNotification(
  method: CodexNotificationMethod,
  params: unknown,
): ParsedCodexNotification | null {
  try {
    if (isIgnoredCodexNotificationMethod(method)) {
      return { method, params: undefined };
    }
    switch (method) {
      case "account/login/completed":
        return { method, params: accountLoginCompletedSchema.parse(params) };
      case "account/updated":
        return { method, params: accountUpdatedSchema.parse(params) };
      case "account/rateLimits/updated":
        return { method, params: accountRateLimitsUpdatedSchema.parse(params) };
      case "thread/started":
        return { method, params: threadStartedSchema.parse(params) };
      case "thread/archived":
      case "thread/closed":
      case "thread/deleted":
      case "thread/unarchived":
        return { method, params: threadReferenceSchema.parse(params) };
      case "thread/status/changed":
        return { method, params: threadStatusChangedSchema.parse(params) };
      case "thread/name/updated":
        return { method, params: threadNameUpdatedSchema.parse(params) };
      case "thread/tokenUsage/updated":
        return { method, params: threadTokenUsageUpdatedSchema.parse(params) };
      case "turn/started":
      case "turn/completed":
        return { method, params: turnLifecycleSchema.parse(params) };
      case "turn/plan/updated":
        return { method, params: turnPlanUpdatedWireSchema.parse(params) };
      case "item/fileChange/patchUpdated":
        return { method, params: patchUpdatedWireSchema.parse(params) };
      case "item/started":
        return { method, params: itemStartedSchema.parse(params) };
      case "item/completed":
        return { method, params: itemCompletedSchema.parse(params) };
      case "item/agentMessage/delta":
      case "item/commandExecution/outputDelta":
        return { method, params: deltaSchema.parse(params) };
      case "item/reasoning/summaryTextDelta":
        return { method, params: reasoningSummaryDeltaSchema.parse(params) };
      case "serverRequest/resolved":
        return { method, params: resolvedRequestSchema.parse(params) };
      case "model/rerouted":
        return { method, params: modelReroutedSchema.parse(params) };
      case "item/reasoning/textDelta":
        return { method, params: discardedReasoningDeltaSchema.parse(params) };
    }
  } catch {
    return null;
  }
}

const approvalReferenceSchema = activityReferenceSchema.extend({
  itemId: idSchema,
  startedAtMs: unixMillisecondsSchema,
});
const commandApprovalWireSchema = approvalReferenceSchema.extend({
  environmentId: idSchema.nullable(),
  approvalId: idSchema.nullable().optional(),
  reason: z.string().max(4_096).nullable().optional(),
  networkApprovalContext: z.object({
    host: z.string().min(1).max(1_024),
    protocol: z.enum(["http", "https", "socks5Tcp", "socks5Udp"]),
  }).nullable().optional(),
  command: protocolTextSchema.nullable().optional(),
  cwd: pathSchema.nullable().optional(),
  commandActions: z.array(z.object({}).passthrough()).max(256).nullable().optional(),
  proposedExecpolicyAmendment: z.array(protocolTextSchema).max(256).nullable().optional(),
  proposedNetworkPolicyAmendments: z.array(z.object({}).passthrough()).max(256).nullable().optional(),
}).transform(({ threadId, turnId, itemId, startedAtMs }) => ({
  threadId,
  turnId,
  itemId,
  startedAtMs,
}));
const fileChangeApprovalSchema = approvalReferenceSchema.extend({
  reason: z.string().max(4_096).nullable().optional(),
  grantRoot: absolutePathSchema.nullable().optional(),
});
const userInputRequestSchema = approvalReferenceSchema.omit({ startedAtMs: true }).extend({
  questions: z.array(z.object({
    id: providerAnswerKeySchema,
    header: z.string().min(1).max(64),
    question: z.string().min(1).max(1_024),
    isOther: z.boolean(),
    isSecret: z.boolean(),
    options: z.array(z.object({
      label: z.string().min(1).max(128),
      description: z.string().max(512),
    })).max(8).nullable(),
  })).min(1).max(3).refine(
    (questions) => new Set(questions.map(({ id }) => id)).size === questions.length,
    "duplicate provider question id",
  ),
  autoResolutionMs: z.number().int().positive().max(3_600_000).nullable(),
});
const mcpElicitationBaseShape = {
  threadId: idSchema,
  turnId: idSchema.nullable(),
  serverName: z.string().min(1).max(512),
  _meta: z.unknown().nullable(),
  message: z.string().min(1).max(16_384),
} as const;
const mcpElicitationWireSchema = z.discriminatedUnion("mode", [
  z.object({
    ...mcpElicitationBaseShape,
    mode: z.literal("form"),
    requestedSchema: z.object({}).passthrough(),
  }),
  z.object({
    ...mcpElicitationBaseShape,
    mode: z.literal("openai/form"),
    requestedSchema: z.unknown(),
  }),
  z.object({
    ...mcpElicitationBaseShape,
    mode: z.literal("url"),
    url: z.string().url().max(4_096),
    elicitationId: idSchema,
  }),
]).transform(({ threadId, turnId }) => ({ threadId, turnId }));
const fileSystemPathSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("path"), path: pathSchema }),
  z.object({ type: z.literal("glob_pattern"), pattern: protocolTextSchema }),
  z.object({
    type: z.literal("special"),
    value: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("root") }),
      z.object({ kind: z.literal("minimal") }),
      z.object({ kind: z.literal("project_roots"), subpath: pathSchema.nullable() }),
      z.object({ kind: z.literal("tmpdir") }),
      z.object({ kind: z.literal("slash_tmp") }),
      z.object({ kind: z.literal("unknown"), path: pathSchema, subpath: pathSchema.nullable() }),
    ]),
  }),
]);
const permissionsApprovalWireSchema = approvalReferenceSchema.extend({
  environmentId: idSchema.nullable(),
  cwd: absolutePathSchema,
  reason: z.string().max(4_096).nullable(),
  permissions: z.object({
    network: z.object({ enabled: z.boolean().nullable() }).nullable(),
    fileSystem: z.object({
      read: z.array(pathSchema).max(512).nullable(),
      write: z.array(pathSchema).max(512).nullable(),
      globScanMaxDepth: safeNonNegativeIntegerSchema.max(1_024).optional(),
      entries: z.array(z.object({
        path: fileSystemPathSchema,
        access: z.enum(["read", "write", "deny"]),
      })).max(512).optional(),
    }).nullable(),
  }),
}).transform(({ threadId, turnId, itemId, startedAtMs }) => ({
  threadId,
  turnId,
  itemId,
  startedAtMs,
}));
const legacyFileChangeSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("add"), content: protocolTextSchema }),
  z.object({ type: z.literal("delete"), content: protocolTextSchema }),
  z.object({
    type: z.literal("update"),
    unified_diff: protocolTextSchema,
    move_path: pathSchema.nullable(),
  }),
]);
const legacyApplyPatchApprovalSchema = z.object({
  conversationId: idSchema,
  callId: idSchema,
  fileChanges: z.record(pathSchema, legacyFileChangeSchema.optional())
    .refine(
      (value) => Object.values(value).every((change) => change !== undefined),
      "undefined file change",
    )
    .refine((value) => Object.keys(value).length <= 512, "too many file changes"),
  reason: z.string().max(4_096).nullable(),
  grantRoot: pathSchema.nullable(),
}).transform(() => undefined);
const legacyParsedCommandSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("read"), cmd: protocolTextSchema, name: largeTextSchema, path: pathSchema }),
  z.object({ type: z.literal("list_files"), cmd: protocolTextSchema, path: pathSchema.nullable() }),
  z.object({
    type: z.literal("search"),
    cmd: protocolTextSchema,
    query: largeTextSchema.nullable(),
    path: pathSchema.nullable(),
  }),
  z.object({ type: z.literal("unknown"), cmd: protocolTextSchema }),
]);
const legacyExecCommandApprovalSchema = z.object({
  conversationId: idSchema,
  callId: idSchema,
  approvalId: idSchema.nullable(),
  command: z.array(protocolTextSchema).min(1).max(256),
  cwd: pathSchema,
  reason: z.string().max(4_096).nullable(),
  parsedCmd: z.array(legacyParsedCommandSchema).max(256),
}).transform(() => undefined);

export type PinnedCodexApprovalReference = z.infer<typeof approvalReferenceSchema>;
export type PinnedCodexFileChangeApproval = z.infer<typeof fileChangeApprovalSchema>;
export type PinnedCodexUserInputRequest = z.infer<typeof userInputRequestSchema>;
export type PinnedCodexMcpElicitationReference = z.output<typeof mcpElicitationWireSchema>;

export type ParsedCodexServerRequest =
  | Readonly<{
      method: "item/commandExecution/requestApproval" | "item/permissions/requestApproval";
      params: PinnedCodexApprovalReference;
    }>
  | Readonly<{
      method: "item/fileChange/requestApproval";
      params: PinnedCodexFileChangeApproval;
    }>
  | Readonly<{
      method: "item/tool/requestUserInput";
      params: PinnedCodexUserInputRequest;
    }>
  | Readonly<{
      method: "mcpServer/elicitation/request";
      params: PinnedCodexMcpElicitationReference;
    }>
  | Readonly<{ method: "applyPatchApproval" | "execCommandApproval"; params: undefined }>;

export function parseCodexServerRequest(
  method: RoutedCodexServerRequestMethod,
  params: unknown,
): ParsedCodexServerRequest | null {
  try {
    switch (method) {
      case "item/commandExecution/requestApproval":
        return { method, params: commandApprovalWireSchema.parse(params) };
      case "item/permissions/requestApproval":
        return { method, params: permissionsApprovalWireSchema.parse(params) };
      case "item/fileChange/requestApproval":
        return { method, params: fileChangeApprovalSchema.parse(params) };
      case "item/tool/requestUserInput":
        return { method, params: userInputRequestSchema.parse(params) };
      case "mcpServer/elicitation/request":
        return { method, params: mcpElicitationWireSchema.parse(params) };
      case "applyPatchApproval":
        return { method, params: legacyApplyPatchApprovalSchema.parse(params) };
      case "execCommandApproval":
        return { method, params: legacyExecCommandApprovalSchema.parse(params) };
    }
  } catch {
    return null;
  }
}

type GeneratedNotificationParams<M extends GeneratedServerNotification["method"]> = Extract<
  GeneratedServerNotification,
  { readonly method: M }
>["params"];
type AssociatedNotificationMethod = {
  readonly [K in CodexNotificationMethod]:
    (typeof codexNotificationDispositions)[K] extends "ignored" ? never : K;
}[CodexNotificationMethod];
type NotificationAssociationView<M extends AssociatedNotificationMethod> =
  M extends "account/login/completed"
    ? z.input<typeof accountLoginCompletedSchema>
    : M extends "account/updated"
      ? PinnedCodexAccountUpdated
      : M extends "account/rateLimits/updated"
        ? PinnedCodexRateLimitsUpdated
        : M extends "thread/started"
          ? z.input<typeof threadStartedSchema>
          : M extends "thread/archived" | "thread/closed" | "thread/deleted" | "thread/unarchived"
            ? z.input<typeof threadReferenceSchema>
            : M extends "thread/status/changed"
              ? z.input<typeof threadStatusChangedSchema>
              : M extends "thread/name/updated"
                ? z.input<typeof threadNameUpdatedSchema>
                : M extends "thread/tokenUsage/updated"
                  ? z.input<typeof threadTokenUsageUpdatedSchema>
                : M extends "turn/started" | "turn/completed"
                  ? z.input<typeof turnLifecycleSchema>
            : M extends "turn/plan/updated"
              ? z.input<typeof turnPlanUpdatedWireSchema>
              : M extends "item/fileChange/patchUpdated"
                ? z.input<typeof patchUpdatedWireSchema>
                : M extends "item/started"
                  ? z.input<typeof itemStartedSchema>
                  : M extends "item/completed"
                    ? z.input<typeof itemCompletedSchema>
                    : M extends
                        | "item/agentMessage/delta"
                        | "item/commandExecution/outputDelta"
                      ? z.input<typeof deltaSchema>
                      : M extends "item/reasoning/summaryTextDelta"
                        ? z.input<typeof reasoningSummaryDeltaSchema>
                        : M extends "item/reasoning/textDelta"
                          ? z.input<typeof discardedReasoningDeltaSchema>
                          : M extends "model/rerouted"
                            ? z.input<typeof modelReroutedSchema>
                          : M extends "serverRequest/resolved"
                            ? PinnedCodexServerRequestResolved
                            : never;
type NotificationPayloadCompatibility = {
  readonly [M in AssociatedNotificationMethod]:
    WireShape<NormalizeGenerated<GeneratedNotificationParams<M>>> extends NotificationAssociationView<M>
      ? true
      : false;
};

type GeneratedServerRequestParams<M extends GeneratedServerRequest["method"]> = Extract<
  GeneratedServerRequest,
  { readonly method: M }
>["params"];
type ServerRequestAssociationView<M extends RoutedCodexServerRequestMethod> =
  M extends "item/commandExecution/requestApproval"
    ? z.input<typeof commandApprovalWireSchema>
    : M extends "item/permissions/requestApproval"
      ? z.input<typeof permissionsApprovalWireSchema>
    : M extends "item/fileChange/requestApproval"
      ? z.input<typeof fileChangeApprovalSchema>
      : M extends "item/tool/requestUserInput"
        ? z.input<typeof userInputRequestSchema>
        : M extends "mcpServer/elicitation/request"
          ? z.input<typeof mcpElicitationWireSchema>
          : M extends "applyPatchApproval"
            ? z.input<typeof legacyApplyPatchApprovalSchema>
            : M extends "execCommandApproval"
              ? z.input<typeof legacyExecCommandApprovalSchema>
              : never;
type ServerRequestPayloadCompatibility = {
  readonly [M in RoutedCodexServerRequestMethod]:
    WireShape<NormalizeGenerated<GeneratedServerRequestParams<M>>> extends ServerRequestAssociationView<M>
      ? true
      : false;
};

export const pinnedCodexInboundAssociationWitness = Object.freeze({
  notification: Object.freeze({
    "thread/started": true,
    "thread/status/changed": true,
    "thread/archived": true,
    "thread/deleted": true,
    "thread/unarchived": true,
    "thread/closed": true,
    "thread/name/updated": true,
    "thread/tokenUsage/updated": true,
    "turn/started": true,
    "turn/completed": true,
    "turn/plan/updated": true,
    "item/started": true,
    "item/completed": true,
    "item/agentMessage/delta": true,
    "item/commandExecution/outputDelta": true,
    "item/fileChange/patchUpdated": true,
    "serverRequest/resolved": true,
    "account/updated": true,
    "account/rateLimits/updated": true,
    "item/reasoning/summaryTextDelta": true,
    "item/reasoning/textDelta": true,
    "model/rerouted": true,
    "account/login/completed": true,
  } satisfies NotificationPayloadCompatibility),
  serverRequest: Object.freeze({
    "item/commandExecution/requestApproval": true,
    "item/fileChange/requestApproval": true,
    "item/tool/requestUserInput": true,
    "mcpServer/elicitation/request": true,
    "item/permissions/requestApproval": true,
    applyPatchApproval: true,
    execCommandApproval: true,
  } satisfies ServerRequestPayloadCompatibility),
});
