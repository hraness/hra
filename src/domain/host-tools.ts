import { createHash } from "node:crypto";

import { z } from "zod";

import {
  MESSAGE_MAX_BYTES,
  positiveRevisionSchema,
  sessionIdSchema,
  sessionTaskIdSchema,
  utf8Bytes,
} from "./values.ts";

export const OOMPA_HOST_TOOL_MANIFEST_VERSION = 1 as const;
export const OOMPA_HOST_TOOL_MANIFEST_ID = "hra.host-tools.v1" as const;
export const OOMPA_HOST_TOOL_NAMESPACE = "hra" as const;
/** Exact UTF-8 ceiling shared by every provider transport and result paginator. */
export const OOMPA_HOST_TOOL_PUBLIC_RESULT_MAX_BYTES = 64 * 1_024;
/** Reserve space for HRA's immutable provenance and untrusted-input wrapper. */
export const OOMPA_PEER_MESSAGE_MAX_BYTES = MESSAGE_MAX_BYTES - 4_096;
/** Leaves room for Oh's physical `edition:` key prefix within its 512-character limit. */
export const OOMPA_MEMORY_LOGICAL_KEY_MAX_LENGTH = 504;

export const OOMPA_HOST_TOOL_NAMES = Object.freeze([
  "automation_update",
  "sessions_list",
  "session_inspect",
  "session_message",
  "memory_remember",
  "memory_query",
  "memory_explain",
  "memory_share",
] as const);

export type OompaHostToolName = (typeof OOMPA_HOST_TOOL_NAMES)[number];

export type ConversationAutomationSchedule = Readonly<{
  kind: "interval_minutes";
  minutes: number;
}>;

export type ConversationAutomationOperation =
  | Readonly<{
      mode: "create";
      name: string;
      prompt: string;
      schedule: ConversationAutomationSchedule;
      paused?: boolean;
    }>
  | Readonly<{
      mode: "update";
      id: string;
      revision: number;
      name?: string;
      prompt?: string;
      schedule?: ConversationAutomationSchedule;
      status?: "active" | "paused";
    }>
  | Readonly<{ mode: "view"; id: string }>
  | Readonly<{ mode: "list" }>
  | Readonly<{ mode: "delete"; id: string; revision: number }>;

export type OompaSessionsListInput = Readonly<{
  cursor?: string;
  limit?: number;
}>;

export type OompaSessionInspectInput = Readonly<{
  cursor?: string;
  expectedRevision: number;
  limit?: number;
  sessionId: string;
}>;

export type OompaSessionMessageInput = Readonly<{
  delivery: "queue" | "send" | "steer";
  expectedRevision: number;
  message: string;
  reason: string;
  sessionId: string;
}>;

export type OompaMemoryRememberInput = Readonly<{
  body: string;
  key: string;
  language?: string | undefined;
  summary: string;
  title: string;
}>;

export type OompaMemoryQueryInput =
  | Readonly<{
      continuation?: string | undefined;
      mode: "list";
      scope?: "composite" | "working" | undefined;
    }>
  | Readonly<{
      continuation?: string | undefined;
      key: string;
      mode: "get";
      scope?: "composite" | "working" | undefined;
    }>
  | Readonly<{
      continuation?: string | undefined;
      mode: "search";
      scope?: "composite" | "working" | undefined;
      text: string;
    }>;

export type OompaMemoryExplainInput = Readonly<{
  queryId: string;
  row: number;
}>;

export type OompaMemoryShareInput = Readonly<{
  key: string;
  reason: string;
}>;

export type OompaHostToolRequest =
  | Readonly<{ input: ConversationAutomationOperation; tool: "automation_update" }>
  | Readonly<{ input: OompaSessionsListInput; tool: "sessions_list" }>
  | Readonly<{ input: OompaSessionInspectInput; tool: "session_inspect" }>
  | Readonly<{ input: OompaSessionMessageInput; tool: "session_message" }>
  | Readonly<{ input: OompaMemoryRememberInput; tool: "memory_remember" }>
  | Readonly<{ input: OompaMemoryQueryInput; tool: "memory_query" }>
  | Readonly<{ input: OompaMemoryExplainInput; tool: "memory_explain" }>
  | Readonly<{ input: OompaMemoryShareInput; tool: "memory_share" }>;

export type OompaHostToolJsonSchema = Readonly<Record<string, unknown>>;

export type OompaHostToolDefinition = Readonly<{
  description: string;
  inputSchema: OompaHostToolJsonSchema;
  name: OompaHostToolName;
}>;

const intervalMinutesJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["kind", "minutes"],
  properties: {
    kind: { const: "interval_minutes" },
    minutes: { type: "integer", minimum: 15, maximum: 10_080 },
  },
} as const;

const memoryKeyJsonSchema = {
  type: "string",
  minLength: 1,
  maxLength: OOMPA_MEMORY_LOGICAL_KEY_MAX_LENGTH,
  pattern: "^[a-z][a-z0-9]*(?:[._:/-][a-z0-9]+)*$",
} as const;

const continuationJsonSchema = {
  type: "string",
  minLength: 1,
  maxLength: 4_096,
} as const;

const automationInputJsonSchema = {
  oneOf: [
    {
      type: "object",
      additionalProperties: false,
      required: ["mode", "name", "prompt", "schedule"],
      properties: {
        mode: { const: "create" },
        name: { type: "string", minLength: 1, maxLength: 160 },
        prompt: { type: "string", minLength: 1, maxLength: MESSAGE_MAX_BYTES },
        schedule: intervalMinutesJsonSchema,
        paused: { type: "boolean" },
      },
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["mode", "id", "revision"],
      anyOf: [
        { required: ["name"] },
        { required: ["prompt"] },
        { required: ["schedule"] },
        { required: ["status"] },
      ],
      properties: {
        mode: { const: "update" },
        id: { type: "string", pattern: "^stask_[0-9a-f]{32}$" },
        revision: { type: "integer", minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
        name: { type: "string", minLength: 1, maxLength: 160 },
        prompt: { type: "string", minLength: 1, maxLength: MESSAGE_MAX_BYTES },
        schedule: intervalMinutesJsonSchema,
        status: { enum: ["active", "paused"] },
      },
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["mode", "id"],
      properties: {
        mode: { const: "view" },
        id: { type: "string", pattern: "^stask_[0-9a-f]{32}$" },
      },
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["mode"],
      properties: { mode: { const: "list" } },
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["mode", "id", "revision"],
      properties: {
        mode: { const: "delete" },
        id: { type: "string", pattern: "^stask_[0-9a-f]{32}$" },
        revision: { type: "integer", minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
      },
    },
  ],
} as const;

const hostToolDefinitions = [
  {
    name: "automation_update",
    description: "Create, inspect, edit, pause, resume, or delete interval tasks bound to this session.",
    inputSchema: automationInputJsonSchema,
  },
  {
    name: "sessions_list",
    description: "List a bounded page of other HRA sessions in this session's current project.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        cursor: { type: "string", minLength: 1, maxLength: 2_048 },
        limit: { type: "integer", minimum: 1, maximum: 50 },
      },
    },
  },
  {
    name: "session_inspect",
    description: "Read bounded provider-neutral state and transcript records for one current-project HRA session.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["sessionId", "expectedRevision"],
      properties: {
        sessionId: { type: "string", pattern: "^sess_[0-9a-f]{32}$" },
        expectedRevision: { type: "integer", minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
        cursor: { type: "string", minLength: 1, maxLength: 2_048 },
        limit: { type: "integer", minimum: 1, maximum: 50 },
      },
    },
  },
  {
    name: "session_message",
    description: "Send or queue a message for, or steer the active turn of, one current-project HRA session.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["sessionId", "expectedRevision", "delivery", "message", "reason"],
      properties: {
        sessionId: { type: "string", pattern: "^sess_[0-9a-f]{32}$" },
        expectedRevision: { type: "integer", minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
        delivery: { enum: ["send", "queue", "steer"] },
        message: { type: "string", minLength: 1, maxLength: OOMPA_PEER_MESSAGE_MAX_BYTES },
        reason: { type: "string", minLength: 1, maxLength: 1_024 },
      },
    },
  },
  {
    name: "memory_remember",
    description: "Remember one bounded page in this session's expiring working memory.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["key", "title", "summary", "body"],
      properties: {
        key: memoryKeyJsonSchema,
        title: { type: "string", minLength: 1, maxLength: 512 },
        summary: { type: "string", minLength: 1, maxLength: 8_192 },
        body: { type: "string", minLength: 1, maxLength: 512 * 1_024 },
        language: {
          type: "string",
          maxLength: 255,
          pattern: "^(?:und|[a-z]{2,3}(?:-[a-z0-9]{2,8})*)$",
        },
      },
    },
  },
  {
    name: "memory_query",
    description: "List, get, or search this session's memory. The default composite scope includes current-project shared memory and fails closed when canonical custody is unavailable; explicit working scope reads only the session lane.",
    inputSchema: {
      oneOf: [
        {
          type: "object",
          additionalProperties: false,
          required: ["mode"],
          properties: {
            mode: { const: "list" },
            scope: { enum: ["composite", "working"] },
            continuation: continuationJsonSchema,
          },
        },
        {
          type: "object",
          additionalProperties: false,
          required: ["mode", "key"],
          properties: {
            mode: { const: "get" },
            key: memoryKeyJsonSchema,
            scope: { enum: ["composite", "working"] },
            continuation: continuationJsonSchema,
          },
        },
        {
          type: "object",
          additionalProperties: false,
          required: ["mode", "text"],
          properties: {
            mode: { const: "search" },
            text: { type: "string", minLength: 1, maxLength: 8_192 },
            scope: { enum: ["composite", "working"] },
            continuation: continuationJsonSchema,
          },
        },
      ],
    },
  },
  {
    name: "memory_explain",
    description: "Explain one row from a memory query previously issued to this session.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["queryId", "row"],
      properties: {
        queryId: { type: "string", pattern: "^memq_[0-9a-f]{32}$" },
        row: { type: "integer", minimum: 0, maximum: 255 },
      },
    },
  },
  {
    name: "memory_share",
    description: "Explicitly nominate one working-memory page for compare-and-swap adoption into current-project shared memory.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["key", "reason"],
      properties: {
        key: memoryKeyJsonSchema,
        reason: { type: "string", minLength: 1, maxLength: 1_024 },
      },
    },
  },
] as const satisfies readonly OompaHostToolDefinition[];

const deepFreeze = <T>(value: T): Readonly<T> => {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const item of Object.values(value)) deepFreeze(item);
    Object.freeze(value);
  }
  return value;
};

export const OOMPA_HOST_TOOL_MANIFEST = deepFreeze({
  description: "Use HRA's session-bound coordination, memory, and scheduled-work services.",
  id: OOMPA_HOST_TOOL_MANIFEST_ID,
  namespace: OOMPA_HOST_TOOL_NAMESPACE,
  tools: hostToolDefinitions,
  version: OOMPA_HOST_TOOL_MANIFEST_VERSION,
});

const canonicalJson = (value: unknown): string => {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Host-tool manifest contains a non-finite number.");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value !== "object") throw new TypeError("Host-tool manifest is not canonical JSON.");
  const record = value as Readonly<Record<string, unknown>>;
  return `{${Object.keys(record).sort().map((key) =>
    `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
};

/** Measure the exact provider-visible body using the shared canonical encoding. */
export const oompaHostToolPublicResultBytes = (value: unknown): number =>
  utf8Bytes(typeof value === "string" ? value : canonicalJson(value));

export const digestOompaHostToolManifest = (value: unknown): string =>
  createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");

export const OOMPA_HOST_TOOL_MANIFEST_DIGEST = digestOompaHostToolManifest(
  OOMPA_HOST_TOOL_MANIFEST,
);

const automationNameSchema = z.string().min(1).max(160)
  .refine((value) => utf8Bytes(value) <= 160)
  .refine((value) => !/\p{Cc}|\p{Cf}|\p{Cs}/u.test(value));
const automationPromptSchema = z.string().min(1).max(MESSAGE_MAX_BYTES)
  .refine((value) => utf8Bytes(value) <= MESSAGE_MAX_BYTES);
const intervalMinutesSchema = z.object({
  kind: z.literal("interval_minutes"),
  minutes: z.number().int().safe().min(15).max(10_080),
}).strict();
const automationCreateSchema = z.object({
  mode: z.literal("create"),
  name: automationNameSchema,
  prompt: automationPromptSchema,
  schedule: intervalMinutesSchema,
  paused: z.boolean().optional(),
}).strict();
const automationUpdateSchema = z.object({
  mode: z.literal("update"),
  id: sessionTaskIdSchema,
  revision: positiveRevisionSchema,
  name: automationNameSchema.optional(),
  prompt: automationPromptSchema.optional(),
  schedule: intervalMinutesSchema.optional(),
  status: z.enum(["active", "paused"]).optional(),
}).strict().refine((value) => value.name !== undefined
  || value.prompt !== undefined
  || value.schedule !== undefined
  || value.status !== undefined);
const automationOperationSchema = z.union([
  automationCreateSchema,
  automationUpdateSchema,
  z.object({ mode: z.literal("view"), id: sessionTaskIdSchema }).strict(),
  z.object({ mode: z.literal("list") }).strict(),
  z.object({
    mode: z.literal("delete"),
    id: sessionTaskIdSchema,
    revision: positiveRevisionSchema,
  }).strict(),
]);

const safeCursorSchema = z.string().min(1).max(2_048)
  .refine((value) => utf8Bytes(value) <= 2_048)
  .refine((value) => !/\p{Cc}|\p{Cs}/u.test(value));
const pageLimitSchema = z.number().int().safe().min(1).max(50);
const peerReasonSchema = z.string().min(1).max(1_024)
  .refine((value) => utf8Bytes(value) <= 1_024)
  .refine((value) => value.normalize("NFC") === value)
  // The reason is rendered on a host-authored provenance line. Format
  // controls (notably bidi isolates/overrides) could make that fixed framing
  // visually ambiguous even though they cannot change its semantics.
  .refine((value) => !/[\r\n\u0085\u2028\u2029]|\p{Cc}|\p{Cf}|\p{Cs}/u.test(value));
const hasDisallowedModelScalar = (value: string): boolean => {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (
      code <= 8
      || (code >= 11 && code <= 12)
      || (code >= 14 && code <= 31)
      || (code >= 127 && code <= 159)
    ) return true;
  }
  return false;
};
const modelText = (maximumBytes: number) => z.string().min(1).max(maximumBytes)
  .refine((value) => utf8Bytes(value) <= maximumBytes)
  .refine((value) => value.normalize("NFC") === value)
  .refine((value) => !hasDisallowedModelScalar(value) && !/\p{Cs}/u.test(value));
const memoryKeySchema = z.string().min(1).max(OOMPA_MEMORY_LOGICAL_KEY_MAX_LENGTH)
  .regex(/^[a-z][a-z0-9]*(?:[._:/-][a-z0-9]+)*$/u);
const memoryContinuationSchema = z.string().min(1).max(4_096)
  .refine((value) => utf8Bytes(value) <= 4_096)
  .refine((value) => !/\p{Cc}|\p{Cs}/u.test(value));

const inputSchemas = {
  automation_update: automationOperationSchema,
  sessions_list: z.object({
    cursor: safeCursorSchema.optional(),
    limit: pageLimitSchema.optional(),
  }).strict(),
  session_inspect: z.object({
    sessionId: sessionIdSchema,
    expectedRevision: positiveRevisionSchema,
    cursor: safeCursorSchema.optional(),
    limit: pageLimitSchema.optional(),
  }).strict(),
  session_message: z.object({
    sessionId: sessionIdSchema,
    expectedRevision: positiveRevisionSchema,
    delivery: z.enum(["send", "queue", "steer"]),
    message: modelText(OOMPA_PEER_MESSAGE_MAX_BYTES),
    reason: peerReasonSchema,
  }).strict(),
  memory_remember: z.object({
    key: memoryKeySchema,
    title: modelText(512).refine((value) => !/[\r\n\u0085\u2028\u2029]/u.test(value)),
    summary: modelText(8_192),
    body: modelText(512 * 1_024),
    language: z.string().max(255)
      .regex(/^(?:und|[a-z]{2,3}(?:-[a-z0-9]{2,8})*)$/u).optional(),
  }).strict(),
  memory_query: z.union([
    z.object({
      mode: z.literal("list"),
      scope: z.enum(["composite", "working"]).optional(),
      continuation: memoryContinuationSchema.optional(),
    }).strict(),
    z.object({
      mode: z.literal("get"),
      key: memoryKeySchema,
      scope: z.enum(["composite", "working"]).optional(),
      continuation: memoryContinuationSchema.optional(),
    }).strict(),
    z.object({
      mode: z.literal("search"),
      text: modelText(8_192),
      scope: z.enum(["composite", "working"]).optional(),
      continuation: memoryContinuationSchema.optional(),
    }).strict(),
  ]),
  memory_explain: z.object({
    queryId: z.string().regex(/^memq_[0-9a-f]{32}$/u),
    row: z.number().int().safe().min(0).max(255),
  }).strict(),
  memory_share: z.object({
    key: memoryKeySchema,
    reason: peerReasonSchema,
  }).strict(),
} as const;

/**
 * The local owner CLI and provider bridges share these exact bounded memory
 * value schemas. The surrounding authorities differ, but accepting a wider
 * page, query, explanation, or nomination shape at one ingress would make the
 * coordinator's closed policy depend on which client called it.
 */
export const oompaMemoryRememberInputSchema = inputSchemas.memory_remember;
export const oompaMemoryQueryInputSchema = inputSchemas.memory_query;
export const oompaMemoryExplainInputSchema = inputSchemas.memory_explain;
export const oompaMemoryShareInputSchema = inputSchemas.memory_share;

export const isOompaHostToolName = (value: unknown): value is OompaHostToolName =>
  typeof value === "string" && (OOMPA_HOST_TOOL_NAMES as readonly string[]).includes(value);

/** Parse one provider-supplied call against the same closed contract that is advertised. */
export function parseOompaHostToolRequest(tool: unknown, value: unknown): OompaHostToolRequest {
  if (!isOompaHostToolName(tool)) throw new TypeError("Unknown HRA host tool.");
  const parsed = inputSchemas[tool].safeParse(value);
  if (!parsed.success) throw new TypeError("Invalid HRA host-tool input.");
  return { tool, input: parsed.data } as OompaHostToolRequest;
}
