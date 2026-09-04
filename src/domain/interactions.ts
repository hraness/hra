import { z } from "zod";

import { publicProviderIdentifierSchema } from "../public-provider-identifier";
import { profileIdSchema, sessionIdSchema, unixMillisecondsSchema } from "./values";

const digestSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const providerIdentifierSchema = z.string().min(1).max(512);
const nullableProviderIdentifierSchema = providerIdentifierSchema.nullable();
const safeDisplayTextSchema = z.string().max(4_096);

export const providerRequestIdSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("number"), value: z.number().int().safe() }).strict(),
  z.object({ type: z.literal("string"), value: z.string().min(1).max(512) }).strict(),
]);

export type ProviderRequestId = z.infer<typeof providerRequestIdSchema>;

export const interactionKindSchema = z.enum([
  "command_approval",
  "file_change_approval",
  "permission_approval",
  "user_input",
  "mcp_elicitation",
]);

export type InteractionKind = z.infer<typeof interactionKindSchema>;

export const interactionStateSchema = z.enum([
  "pending",
  "response_prepared",
  "response_written",
  "resolved",
  "declined",
  "canceled",
  "expired",
  "resolution_unknown",
]);

export type InteractionState = z.infer<typeof interactionStateSchema>;

export const interactionDecisionSchema = z.enum(["once", "session", "decline", "cancel"]);

export type InteractionDecision = z.infer<typeof interactionDecisionSchema>;

/**
 * Per-session and daemon-default answering policy for brokered protocol
 * approvals. `auto:all` autoresponds every approval kind; `auto:workspace`
 * autoresponds commands and file changes but escalates permission approvals
 * whose requested category looks like network access, MCP, or an
 * unrecognised tool; `manual` never autoresponds (file-change approvals are
 * still auto-declined under `manual` because HRA cannot show their exact
 * affected paths, so no informed human decision is possible).
 */
export const approvalModeSchema = z.enum(["auto:all", "auto:workspace", "manual"]);

export type ApprovalMode = z.infer<typeof approvalModeSchema>;

/** Who produced the terminal decision for an interaction, beyond the default human CLI path. */
export const interactionResolvedBySchema = z.enum(["autorespond"]).nullable();

const availableInteractionDecisionsSchema = z.array(interactionDecisionSchema).min(1).max(4)
  .superRefine((decisions, context) => {
    if (new Set(decisions).size !== decisions.length) {
      context.addIssue({
        code: "custom",
        message: "Available interaction decisions must be unique.",
      });
    }
  });

export const interactionIntendedTerminalStateSchema = z.enum([
  "resolved",
  "declined",
  "canceled",
  "expired",
]);

export type InteractionIntendedTerminalState = z.infer<
  typeof interactionIntendedTerminalStateSchema
>;

/** HRA never leaves an admitted provider callback pending longer than 30 minutes. */
export const INTERACTION_MAX_PENDING_MS = 30 * 60 * 1_000;

export const providerInteractionAuthoritySchema = z.object({
  profileId: profileIdSchema,
  processGeneration: z.number().int().nonnegative(),
  connectionId: z.string().uuid(),
  requestId: providerRequestIdSchema,
  method: z.string().min(1).max(512),
  requestDigest: digestSchema,
  threadId: nullableProviderIdentifierSchema,
  turnId: nullableProviderIdentifierSchema,
  itemId: nullableProviderIdentifierSchema,
  approvalId: nullableProviderIdentifierSchema,
}).strict();

export type ProviderInteractionAuthority = z.infer<typeof providerInteractionAuthoritySchema>;

const interactionOptionSchema = z.object({
  label: z.string().min(1).max(512),
  description: z.string().max(2_048),
}).strict();

const interactionQuestionSchema = z.object({
  id: providerIdentifierSchema,
  header: z.string().min(1).max(256),
  question: z.string().min(1).max(4_096),
  options: z.array(interactionOptionSchema).max(20).nullable(),
  allowsOther: z.boolean(),
  secret: z.boolean(),
}).strict();

const permissionNameSchema = z.string().min(1).max(256);

const requestedPermissionSchema = z.object({
  name: permissionNameSchema,
}).strict();

const permissionSelectionSchema = z.array(permissionNameSchema).min(1).max(100)
  .superRefine((names, context) => {
    if (new Set(names).size !== names.length) {
      context.addIssue({
        code: "custom",
        message: "Selected permission names must be unique.",
      });
    }
  });

const mcpFormFieldNameSchema = z.string().regex(/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/u);
const mcpFormChoiceSchema = z.string().max(128);

export const mcpFormFieldSchema = z.discriminatedUnion("type", [
  z.object({
    name: mcpFormFieldNameSchema,
    type: z.literal("string"),
    required: z.boolean(),
    minLength: z.number().int().min(0).max(16_384),
    maxLength: z.number().int().min(0).max(16_384),
    format: z.enum(["email", "uri", "date", "date-time"]).nullable(),
  }).strict(),
  z.object({
    name: mcpFormFieldNameSchema,
    type: z.enum(["number", "integer"]),
    required: z.boolean(),
    minimum: z.number().finite().nullable(),
    maximum: z.number().finite().nullable(),
  }).strict(),
  z.object({
    name: mcpFormFieldNameSchema,
    type: z.literal("boolean"),
    required: z.boolean(),
  }).strict(),
  z.object({
    name: mcpFormFieldNameSchema,
    type: z.literal("single_select"),
    required: z.boolean(),
    choices: z.array(mcpFormChoiceSchema).min(1).max(20),
  }).strict(),
  z.object({
    name: mcpFormFieldNameSchema,
    type: z.literal("multi_select"),
    required: z.boolean(),
    choices: z.array(mcpFormChoiceSchema).min(1).max(20),
    minItems: z.number().int().min(0).max(20),
    maxItems: z.number().int().min(0).max(20),
  }).strict(),
]).superRefine((field, context) => {
  if (field.type === "string" && field.minLength > field.maxLength) {
    context.addIssue({
      code: "custom",
      message: "An MCP string field minimum cannot exceed its maximum.",
      path: ["minLength"],
    });
  }
  if (
    (field.type === "number" || field.type === "integer")
    && field.minimum !== null
    && field.maximum !== null
    && field.minimum > field.maximum
  ) {
    context.addIssue({
      code: "custom",
      message: "An MCP numeric field minimum cannot exceed its maximum.",
      path: ["minimum"],
    });
  }
  if (field.type === "multi_select" && field.minItems > field.maxItems) {
    context.addIssue({
      code: "custom",
      message: "An MCP multi-select minimum cannot exceed its maximum.",
      path: ["minItems"],
    });
  }
  if (
    (field.type === "single_select" || field.type === "multi_select")
    && new Set(field.choices).size !== field.choices.length
  ) {
    context.addIssue({
      code: "custom",
      message: "MCP form choices must be unique.",
      path: ["choices"],
    });
  }
});

export type McpFormField = z.infer<typeof mcpFormFieldSchema>;

export const interactionDisplaySchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("command_approval"),
    summary: safeDisplayTextSchema,
    reason: safeDisplayTextSchema.nullable(),
    commandClass: z.string().min(1).max(256),
    workingDirectory: z.string().max(1_024).nullable(),
    availableDecisions: availableInteractionDecisionsSchema,
  }).strict(),
  z.object({
    kind: z.literal("file_change_approval"),
    summary: safeDisplayTextSchema,
    reason: safeDisplayTextSchema.nullable(),
    grantRoot: z.string().max(1_024).nullable(),
    availableDecisions: availableInteractionDecisionsSchema,
  }).strict(),
  z.object({
    kind: z.literal("permission_approval"),
    summary: safeDisplayTextSchema,
    reason: safeDisplayTextSchema.nullable(),
    requested: z.array(requestedPermissionSchema).max(100),
    allowsSessionScope: z.boolean(),
  }).strict(),
  z.object({
    kind: z.literal("user_input"),
    summary: safeDisplayTextSchema,
    blocking: z.boolean(),
    questions: z.array(interactionQuestionSchema).min(1).max(3),
  }).strict(),
  z.object({
    kind: z.literal("mcp_elicitation"),
    summary: safeDisplayTextSchema,
    serverName: z.string().min(1).max(256),
    mode: z.enum(["form", "openai_form"]),
    url: z.null(),
    mayContainSecrets: z.literal(true),
    fields: z.array(mcpFormFieldSchema).max(16).optional(),
  }).strict(),
]).superRefine((display, context) => {
  if (display.kind !== "mcp_elicitation" || display.fields === undefined) return;
  const names = display.fields.map((field) => field.name);
  if (new Set(names).size !== names.length) {
    context.addIssue({
      code: "custom",
      message: "MCP form field names must be unique.",
      path: ["fields"],
    });
  }
});

export type InteractionDisplay = z.infer<typeof interactionDisplaySchema>;

export const interactionRecordSchema = z.object({
  version: z.literal(1),
  publicId: z.string().uuid(),
  sessionId: sessionIdSchema.nullable(),
  authority: providerInteractionAuthoritySchema,
  kind: interactionKindSchema,
  state: interactionStateSchema,
  revision: z.number().int().positive(),
  blocking: z.boolean(),
  display: interactionDisplaySchema,
  responseDigest: digestSchema.nullable(),
  intendedTerminalState: interactionIntendedTerminalStateSchema.nullable(),
  resolvedBy: interactionResolvedBySchema.optional(),
  requestedAt: unixMillisecondsSchema,
  deadlineAt: unixMillisecondsSchema,
  updatedAt: unixMillisecondsSchema,
  terminalAt: unixMillisecondsSchema.nullable(),
}).strict().superRefine((interaction, context) => {
  if (interaction.deadlineAt < interaction.requestedAt) {
    context.addIssue({
      code: "custom",
      message: "The interaction deadline cannot precede its request time.",
      path: ["deadlineAt"],
    });
  }
});

export type InteractionRecord = z.infer<typeof interactionRecordSchema>;

const publicInteractionDisplaySchema = interactionDisplaySchema;

export const publicInteractionSchema = z.object({
  version: z.literal(1),
  id: z.string().uuid(),
  sessionId: sessionIdSchema.nullable(),
  kind: interactionKindSchema,
  state: interactionStateSchema,
  revision: z.number().int().positive(),
  blocking: z.boolean(),
  display: publicInteractionDisplaySchema,
  presentation: z.lazy(() => interactionPresentationSchema).optional(),
  responseRecorded: z.boolean(),
  resolvedBy: interactionResolvedBySchema.optional(),
  context: z.object({
    turnId: publicProviderIdentifierSchema.nullable(),
    itemId: publicProviderIdentifierSchema.nullable(),
  }).strict(),
  requestedAt: unixMillisecondsSchema,
  deadlineAt: unixMillisecondsSchema,
  updatedAt: unixMillisecondsSchema,
  terminalAt: unixMillisecondsSchema.nullable(),
}).strict().superRefine((interaction, context) => {
  if (interaction.kind !== interaction.display.kind) {
    context.addIssue({
      code: "custom",
      message: "The public interaction kind must match its display kind.",
      path: ["display", "kind"],
    });
  }
});

export type PublicInteraction = z.infer<typeof publicInteractionSchema>;

export type ProtectedInteractionJson =
  | null
  | boolean
  | number
  | string
  | ProtectedInteractionJson[]
  | { readonly [key: string]: ProtectedInteractionJson };

/** Complete live approval authority plus its public binding must fit this document. */
export const PROTECTED_INTERACTION_DETAIL_MAXIMUM_BYTES = 3 * 1024 * 1024;
export const PROTECTED_INTERACTION_TERMINAL_MAXIMUM_BYTES = 64 * 1024;

const isProtectedInteractionJson = (value: unknown): value is ProtectedInteractionJson => {
  const pending: Array<{ readonly depth: number; readonly value: unknown }> = [{ depth: 0, value }];
  let visited = 0;
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined || ++visited > 100_000 || current.depth > 64) return false;
    const entry = current.value;
    if (entry === null || typeof entry === "string" || typeof entry === "boolean") continue;
    if (typeof entry === "number") {
      if (!Number.isFinite(entry)) return false;
      continue;
    }
    if (Array.isArray(entry)) {
      for (const child of entry) pending.push({ depth: current.depth + 1, value: child });
      continue;
    }
    if (typeof entry !== "object") return false;
    const objectEntry = entry as Record<string, unknown>;
    const prototype: unknown = Object.getPrototypeOf(objectEntry);
    if (prototype !== Object.prototype && prototype !== null) return false;
    for (const child of Object.values(objectEntry)) {
      pending.push({ depth: current.depth + 1, value: child });
    }
  }
  return true;
};

const protectedInteractionJsonSchema = z.custom<ProtectedInteractionJson>(
  isProtectedInteractionJson,
  "Expected bounded JSON interaction authority.",
);

export const liveInteractionApprovalAuthoritySchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("command_approval"),
    command: z.string().min(1).max(1_000_000),
    reason: z.string().max(4_096).nullable(),
    availableDecisions: protectedInteractionJsonSchema,
    workingDirectory: z.string().max(16_384).nullable(),
    environmentId: z.string().min(1).max(512).nullable(),
    commandActions: protectedInteractionJsonSchema.nullable(),
    networkApprovalContext: protectedInteractionJsonSchema.nullable(),
    additionalPermissions: protectedInteractionJsonSchema.nullable(),
    proposedExecpolicyAmendment: protectedInteractionJsonSchema.nullable(),
    proposedNetworkPolicyAmendments: protectedInteractionJsonSchema.nullable(),
  }).strict(),
  z.object({
    kind: z.literal("permission_approval"),
    permissions: protectedInteractionJsonSchema,
    reason: z.string().max(4_096).nullable(),
    workingDirectory: z.string().min(1).max(16_384),
    environmentId: z.string().min(1).max(512).nullable(),
  }).strict(),
]);

export type LiveInteractionApprovalAuthority = z.infer<
  typeof liveInteractionApprovalAuthoritySchema
>;

const protectedInteractionBindingSchema = z.object({
  interactionId: z.string().uuid(),
  revision: z.number().int().positive(),
  kind: z.enum(["command_approval", "permission_approval"]),
  sessionId: sessionIdSchema.nullable(),
  profileId: profileIdSchema,
  processGeneration: z.number().int().nonnegative(),
  connectionId: z.string().uuid(),
}).strict();

export const protectedInteractionDetailDocumentSchema = z.object({
  type: z.literal("hra_protected_interaction_detail"),
  version: z.literal(1),
  binding: protectedInteractionBindingSchema,
  authority: liveInteractionApprovalAuthoritySchema,
}).strict().superRefine((document, context) => {
  if (document.binding.kind !== document.authority.kind) {
    context.addIssue({
      code: "custom",
      message: "The protected authority kind must match its interaction binding.",
      path: ["authority", "kind"],
    });
  }
});

export type ProtectedInteractionDetailDocument = z.infer<
  typeof protectedInteractionDetailDocumentSchema
>;

/** The newline is part of the protected document contract and every byte bound. */
export const encodeProtectedInteractionDetailDocument = (
  document: ProtectedInteractionDetailDocument,
): Uint8Array => new TextEncoder().encode(`${JSON.stringify(document)}\n`);

export const interactionResolutionSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("approval_decision"),
    decision: interactionDecisionSchema,
  }).strict(),
  z.object({
    kind: z.literal("permission_grant"),
    permissions: permissionSelectionSchema,
    scope: z.enum(["turn", "session"]).nullable(),
  }).strict(),
  z.object({
    kind: z.literal("user_answers"),
    answers: z.record(
      providerIdentifierSchema,
      z.object({ answers: z.array(z.string().max(16_384)).max(20) }).strict(),
    ),
  }).strict(),
  z.object({
    kind: z.literal("mcp_submission"),
    action: z.enum(["accept", "decline", "cancel"]),
    content: z.unknown().optional(),
  }).strict(),
]);

export type InteractionResolution = z.infer<typeof interactionResolutionSchema>;

export const preparedInteractionResponseSchema = z.object({
  interactionId: z.string().uuid(),
  expectedRevision: z.number().int().positive(),
  responseDigest: digestSchema,
  resolution: interactionResolutionSchema,
}).strict();

export type PreparedInteractionResponse = z.infer<typeof preparedInteractionResponseSchema>;

// --- Provider-neutral presentation -----------------------------------------
//
// `presentation` is computed only from an already-sanitised `InteractionDisplay`
// (the stored form ran through `sanitizeInteractionDisplay`, which strips
// absolute paths, control scalars, and secret-shaped text). This function adds
// no new raw provider text, so it inherits that safety without re-checking it.

const interactionPresentationOptionSchema = z.object({
  id: z.string().min(1).max(64),
  label: z.string().min(1).max(256),
}).strict();

export const interactionPresentationSchema = z.object({
  label: z.string().min(1).max(64),
  /** A short semantic icon token (not an emoji glyph) a client maps to its own icon set. */
  glyph: z.string().min(1).max(32),
  headline: z.string().min(1).max(512),
  detailMarkdown: z.string().max(4_096),
  options: z.array(interactionPresentationOptionSchema).max(20).optional(),
}).strict();

export type InteractionPresentation = z.infer<typeof interactionPresentationSchema>;

const decisionOptionLabel: Readonly<Record<InteractionDecision, string>> = {
  once: "Approve once",
  session: "Approve for this session",
  decline: "Decline",
  cancel: "Cancel",
};

const decisionOptions = (
  decisions: readonly InteractionDecision[],
): { id: string; label: string }[] =>
  decisions.map((decision) => ({ id: decision, label: decisionOptionLabel[decision] }));

/** Computes the bounded, provider-neutral presentation for one interaction display. */
export function computeInteractionPresentation(display: InteractionDisplay): InteractionPresentation {
  switch (display.kind) {
    case "command_approval": {
      const lines = [`Run: ${display.commandClass}`];
      if (display.workingDirectory !== null) lines.push(`Directory: ${display.workingDirectory}`);
      if (display.reason !== null) lines.push(`Reason: ${display.reason}`);
      return {
        label: "Command approval",
        glyph: "terminal",
        headline: display.summary,
        detailMarkdown: lines.map((entry) => `- ${entry}`).join("\n"),
        options: decisionOptions(display.availableDecisions),
      };
    }
    case "file_change_approval": {
      const lines: string[] = [];
      if (display.grantRoot !== null) lines.push(`Grant root: ${display.grantRoot}`);
      if (display.reason !== null) lines.push(`Reason: ${display.reason}`);
      lines.push("HRA cannot show the exact affected paths for this provider version.");
      return {
        label: "File change approval",
        glyph: "file-edit",
        headline: display.summary,
        detailMarkdown: lines.map((entry) => `- ${entry}`).join("\n"),
        options: decisionOptions(display.availableDecisions),
      };
    }
    case "permission_approval": {
      const names = display.requested.map((permission) => permission.name);
      const lines = [`Requested: ${names.length === 0 ? "none" : names.join(", ")}`];
      if (display.reason !== null) lines.push(`Reason: ${display.reason}`);
      return {
        label: "Permission approval",
        glyph: "shield",
        headline: display.summary,
        detailMarkdown: lines.map((entry) => `- ${entry}`).join("\n"),
        options: [{ id: "decline", label: "Decline" }],
      };
    }
    case "user_input": {
      const first = display.questions[0];
      const options = first?.options?.map((option) => ({
        id: option.label,
        label: option.label,
      }));
      return {
        label: "Question",
        glyph: "help",
        headline: display.summary,
        detailMarkdown: display.questions
          .map((question) => `- ${question.header}: ${question.question}`)
          .join("\n"),
        ...(options === undefined || options.length === 0 ? {} : { options }),
      };
    }
    case "mcp_elicitation":
      return {
        label: "MCP form",
        glyph: "form",
        headline: display.summary,
        detailMarkdown: `- Server: ${display.serverName}\n- This form may contain protected values.`,
      };
    default: {
      const exhaustive: never = display;
      throw new Error(`Unhandled interaction display kind: ${JSON.stringify(exhaustive)}`);
    }
  }
}

// --- Autorespond decision mapping ------------------------------------------
//
// Pure, provider-neutral policy: given an interaction kind, its sanitised
// display, and the effective approval mode, decide whether to resolve it
// automatically (and with what resolution) or to leave it for a human.
// Budgets, evidence, and the actual provider round trip live in
// `src/daemon/autorespond.ts`, which is the only caller of this function.

export type PermissionCategoryClass = "network" | "mcp" | "workspace" | "unknown";

/**
 * Heuristic classification of a requested permission category name. Codex's
 * exact permission-category vocabulary is not published, so this errs
 * conservative: anything not recognisably workspace-local classifies as
 * `unknown` and escalates under `auto:workspace`.
 */
export function classifyPermissionCategory(name: string): PermissionCategoryClass {
  const lower = name.toLowerCase();
  if (/network|\bnet\b|http|dns|socket|proxy/u.test(lower)) return "network";
  if (/\bmcp\b/u.test(lower)) return "mcp";
  if (/^(file|fs|filesystem|shell|exec|process|command|read|write|workspace)/u.test(lower)) {
    return "workspace";
  }
  return "unknown";
}

export type AutorespondAction =
  | Readonly<{ action: "resolve"; resolution: InteractionResolution; outcome: "accepted" | "refused" }>
  | Readonly<{ action: "escalate"; reason: string }>;

/**
 * Decision table (kind × mode → action):
 *
 * | kind                 | manual              | auto:all | auto:workspace                                  |
 * | --------------------- | ------------------- | -------- | ------------------------------------------------ |
 * | command_approval      | escalate            | accept   | accept                                            |
 * | file_change_approval  | decline (refused)   | accept   | accept                                            |
 * | permission_approval   | escalate            | accept   | accept unless any requested category is network, MCP, or unknown; then escalate |
 * | user_input            | escalate (always)   | escalate | escalate                                          |
 * | mcp_elicitation       | escalate (always)   | escalate | escalate                                          |
 *
 * "accept" for command_approval and file_change_approval means Codex decision
 * `accept` (HRA `once` scope), never `acceptForSession`. "accept" for
 * permission_approval means a `permission_grant` of every requested category
 * at `scope: "turn"`, never `session`.
 */
export function decideAutorespondAction(input: {
  readonly kind: InteractionKind;
  readonly display: InteractionDisplay;
  readonly mode: ApprovalMode;
}): AutorespondAction {
  const { kind, display, mode } = input;
  if (kind === "user_input" || kind === "mcp_elicitation") {
    return { action: "escalate", reason: "This interaction kind always requires a human." };
  }
  if (kind === "file_change_approval") {
    if (display.kind !== "file_change_approval") {
      return { action: "escalate", reason: "The interaction display does not match its kind." };
    }
    if (mode === "manual") {
      if (!display.availableDecisions.includes("decline")) {
        return { action: "escalate", reason: "The provider request does not offer decline." };
      }
      return {
        action: "resolve",
        resolution: { kind: "approval_decision", decision: "decline" },
        outcome: "refused",
      };
    }
    if (!display.availableDecisions.includes("once")) {
      return { action: "escalate", reason: "The provider request does not offer once-scope acceptance." };
    }
    return {
      action: "resolve",
      resolution: { kind: "approval_decision", decision: "once" },
      outcome: "accepted",
    };
  }
  if (mode === "manual") {
    return { action: "escalate", reason: "Approval mode is manual." };
  }
  if (kind === "command_approval") {
    if (display.kind !== "command_approval") {
      return { action: "escalate", reason: "The interaction display does not match its kind." };
    }
    if (!display.availableDecisions.includes("once")) {
      return { action: "escalate", reason: "The provider request does not offer once-scope acceptance." };
    }
    return {
      action: "resolve",
      resolution: { kind: "approval_decision", decision: "once" },
      outcome: "accepted",
    };
  }
  // permission_approval
  if (display.kind !== "permission_approval") {
    return { action: "escalate", reason: "The interaction display does not match its kind." };
  }
  if (display.requested.length === 0) {
    return { action: "escalate", reason: "No permission category was requested." };
  }
  if (mode === "auto:workspace") {
    const sensitive = display.requested.find((permission) => {
      const cls = classifyPermissionCategory(permission.name);
      return cls === "network" || cls === "mcp" || cls === "unknown";
    });
    if (sensitive !== undefined) {
      return {
        action: "escalate",
        reason: `The requested "${sensitive.name}" permission category is not auto-approved under auto:workspace.`,
      };
    }
  }
  return {
    action: "resolve",
    resolution: {
      kind: "permission_grant",
      permissions: display.requested.map((permission) => permission.name),
      scope: "turn",
    },
    outcome: "accepted",
  };
}
