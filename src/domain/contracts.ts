import { isAbsolute, normalize } from "node:path";

import { z } from "zod";

import { presetSchema } from "./presets";
import { interactionResolutionSchema } from "./interactions";
import {
  SESSION_EVENT_PAGE_LIMIT,
  SESSION_EVENT_WAIT_MAX_MS,
  sessionEventCursorWireSchema,
} from "./session-events";
import { ACCOUNT_USAGE_HISTORY_PAGE_LIMIT } from "./usage-metrics";
import {
  WORK_EVENT_PAGE_LIMIT,
  WORK_TASK_HISTORY_ITEM_LIMIT,
  WORK_WAIT_MAX_MS,
  workEventCursorWireSchema,
  workIdSchema,
  workOperationSchema,
  workTaskIdSchema,
} from "./work";
import { workProtocolQuerySchema } from "./work-protocol";
import {
  labelSchema,
  messageSchema,
  noteSchema,
  profileIdSchema,
  projectIdSchema,
  sessionIdSchema,
  titleSchema,
  unixMillisecondsSchema,
  utf8Bytes,
} from "./values";

const selectorSchema = z.string().trim().min(1).max(200);
const idempotencyKeySchema = z.string().uuid().optional();
const requiredIdempotencyKeySchema = z.string().uuid();
const requiredUuidV7IdempotencyKeySchema = z.string().regex(
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
  "Idempotency key must be a UUIDv7.",
);
const projectPathSchema = z.string().min(1).max(4096).refine(
  (value) => isAbsolute(value) && normalize(value) === value,
  "Project path must be absolute and normalized.",
);
export const LOCAL_DAEMON_PROTOCOL = "hra-control-plane-local-v2" as const;
export const LOCAL_COMMAND_REQUEST_VERSION = 2 as const;
export const LOCAL_COMMAND_REQUEST_MAX_BYTES = 4 * 1024 * 1024;

const daemonStopAuthoritySchema = z.object({
  protocol: z.literal(LOCAL_DAEMON_PROTOCOL),
  pid: z.number().int().positive(),
  nonce: z.string().uuid(),
  generation: z.number().int().positive(),
  bootId: z.string().regex(/^boot_[a-f0-9]{32}$/u),
}).strict();

export const signedOutSessionListMetadataSchema = z.object({
  accountSelector: profileIdSchema,
  accountState: z.literal("signed_out"),
  scope: z.literal("local_only"),
  freshness: z.literal("stale"),
  localCompleteness: z.enum(["partial", "complete"]),
  providerAccess: z.literal("not_attempted"),
  providerCompleteness: z.literal("unknown"),
  nextCommand: z.string().min(1).max(256),
}).strict().superRefine((value, context) => {
  if (value.nextCommand !== `hra account login ${value.accountSelector}`) {
    context.addIssue({
      code: "custom",
      path: ["nextCommand"],
      message: "Signed-out session-list recovery must bind the exact account selector.",
    });
  }
});

export type SignedOutSessionListMetadata = z.infer<typeof signedOutSessionListMetadataSchema>;

export const publicSessionListItemSchema = z.object({
  id: sessionIdSchema,
  profileId: profileIdSchema,
  projectId: projectIdSchema.optional(),
  title: titleSchema,
  state: z.enum(["starting", "active", "idle", "terminal", "recovery_required"]),
  preset: presetSchema,
  fastEnabled: z.boolean(),
  revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  createdAt: unixMillisecondsSchema,
  updatedAt: unixMillisecondsSchema,
});

export const publicSessionListPageSchema = z.object({
  accountId: profileIdSchema.nullable(),
  sessions: z.array(publicSessionListItemSchema).max(100),
  nextCursor: z.string().min(1).max(2_048).nullable(),
  listing: signedOutSessionListMetadataSchema.optional(),
  recovery: z.object({
    required: z.literal(true),
    diagnostic: z.literal(
      "Provider reconciliation is paused while compact-projection recovery preserves exact local authority.",
    ),
  }).strict().optional(),
}).superRefine((value, context) => {
  if (value.accountId === null) {
    if (value.nextCursor !== null) {
      context.addIssue({
        code: "custom",
        path: ["nextCursor"],
        message: "An unscoped session listing cannot continue.",
      });
    }
    if (value.listing !== undefined) {
      context.addIssue({
        code: "custom",
        path: ["listing"],
        message: "Signed-out listing metadata requires an exact account.",
      });
    }
  } else {
    for (const [index, session] of value.sessions.entries()) {
      if (session.profileId !== value.accountId) {
        context.addIssue({
          code: "custom",
          path: ["sessions", index, "profileId"],
          message: "Every scoped session must belong to the resolved account.",
        });
      }
    }
    if (
      value.listing !== undefined
      && value.listing.accountSelector !== value.accountId
    ) {
      context.addIssue({
        code: "custom",
        path: ["listing", "accountSelector"],
        message: "Signed-out listing metadata must bind the resolved account.",
      });
    }
  }
});

export type PublicSessionListPage = z.infer<typeof publicSessionListPageSchema>;

export const localCommandSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("doctor"), offline: z.boolean() }).strict(),
  z.object({ kind: z.literal("daemon.status") }).strict(),
  // The parser emits an unbound stop request. The CLI must bind it to the
  // observed daemon authority before it crosses the local transport boundary.
  z.object({ kind: z.literal("daemon.stop"), expected: daemonStopAuthoritySchema.optional() }).strict(),
  z.object({ kind: z.literal("account.list") }).strict(),
  z.object({ kind: z.literal("account.add"), label: labelSchema }).strict(),
  z.object({ kind: z.literal("account.show"), account: selectorSchema }).strict(),
  z.object({ kind: z.literal("account.login"), account: selectorSchema, deviceCode: z.boolean(), idempotencyKey: idempotencyKeySchema }).strict(),
  z.object({ kind: z.literal("account.login-cancel"), account: selectorSchema, idempotencyKey: idempotencyKeySchema }).strict(),
  z.object({ kind: z.literal("account.logout"), account: selectorSchema, idempotencyKey: idempotencyKeySchema }).strict(),
  z.object({ kind: z.literal("account.usage"), account: selectorSchema.optional(), refresh: z.boolean() }).strict(),
  z.object({
    kind: z.literal("account.usage-history"),
    account: selectorSchema,
    fromObservedAt: unixMillisecondsSchema.optional(),
    throughObservedAt: unixMillisecondsSchema.optional(),
    limit: z.number().int().min(1).max(ACCOUNT_USAGE_HISTORY_PAGE_LIMIT),
    cursor: z.string().min(1).max(2_048).optional(),
  }).strict(),
  z.object({ kind: z.literal("account.switch"), account: selectorSchema, idempotencyKey: requiredIdempotencyKeySchema }).strict(),
  z.object({ kind: z.literal("account.switch-recover") }).strict(),
  z.object({
    kind: z.literal("plugin.list"),
    account: selectorSchema,
    project: selectorSchema.optional(),
    refresh: z.boolean(),
  }).strict(),
  z.object({
    kind: z.literal("plugin.show"),
    account: selectorSchema,
    plugin: selectorSchema,
    project: selectorSchema.optional(),
    refresh: z.boolean(),
  }).strict(),
  z.object({ kind: z.literal("project.list") }).strict(),
  z.object({ kind: z.literal("project.add"), label: labelSchema, path: projectPathSchema }).strict(),
  z.object({ kind: z.literal("project.use"), project: selectorSchema }).strict(),
  z.object({
    kind: z.literal("session.list"),
    account: selectorSchema.optional(),
    limit: z.number().int().min(1).max(100),
    cursor: z.string().min(1).max(2_048).optional(),
  }).strict(),
  z.object({ kind: z.literal("session.show"), session: selectorSchema, detail: z.boolean() }).strict(),
  z.object({ kind: z.literal("session.status"), session: selectorSchema }).strict(),
  z.object({ kind: z.literal("session.state"), session: selectorSchema }).strict(),
  z.object({
    kind: z.literal("session.events"),
    session: selectorSchema,
    cursor: sessionEventCursorWireSchema.optional(),
    limit: z.number().int().min(1).max(SESSION_EVENT_PAGE_LIMIT),
    waitMs: z.number().int().min(0).max(SESSION_EVENT_WAIT_MAX_MS),
  }).strict(),
  z.object({
    kind: z.literal("session.interactions"),
    session: selectorSchema,
    pending: z.boolean(),
    limit: z.number().int().min(1).max(100),
    cursor: z.string().min(1).max(2_048).optional(),
  }).strict(),
  z.object({ kind: z.literal("session.start"), account: selectorSchema, project: selectorSchema.optional(), preset: presetSchema, fast: z.boolean(), idempotencyKey: idempotencyKeySchema }).strict(),
  z.object({ kind: z.literal("session.send"), session: selectorSchema, message: messageSchema, idempotencyKey: idempotencyKeySchema }).strict(),
  z.object({ kind: z.literal("session.queue"), session: selectorSchema, message: messageSchema, idempotencyKey: idempotencyKeySchema }).strict(),
  z.object({ kind: z.literal("session.steer"), session: selectorSchema, message: messageSchema, idempotencyKey: idempotencyKeySchema }).strict(),
  z.object({ kind: z.literal("session.stop"), session: selectorSchema, idempotencyKey: idempotencyKeySchema }).strict(),
  z.object({ kind: z.literal("session.rename"), session: selectorSchema, name: titleSchema, idempotencyKey: idempotencyKeySchema }).strict(),
  z.object({ kind: z.literal("session.recover"), session: selectorSchema }).strict(),
  z.object({ kind: z.literal("session.abandon"), session: selectorSchema }).strict(),
  z.object({ kind: z.literal("session.note.get"), session: selectorSchema }).strict(),
  z.object({ kind: z.literal("session.note.edit"), session: selectorSchema }).strict(),
  z.object({ kind: z.literal("session.note.set"), session: selectorSchema, note: noteSchema, idempotencyKey: idempotencyKeySchema }).strict(),
  z.object({ kind: z.literal("session.note.clear"), session: selectorSchema, idempotencyKey: idempotencyKeySchema }).strict(),
  z.object({ kind: z.literal("session.preset"), session: selectorSchema, preset: presetSchema, idempotencyKey: idempotencyKeySchema }).strict(),
  z.object({ kind: z.literal("session.fast"), session: selectorSchema, enabled: z.boolean(), idempotencyKey: idempotencyKeySchema }).strict(),
  z.object({ kind: z.literal("session.project"), session: selectorSchema, project: selectorSchema, idempotencyKey: idempotencyKeySchema }).strict(),
  z.object({ kind: z.literal("turn.inspect"), session: selectorSchema, turn: selectorSchema }).strict(),
  z.object({
    kind: z.literal("interaction.list"),
    session: selectorSchema.optional(),
    pending: z.boolean(),
    limit: z.number().int().min(1).max(100),
    cursor: z.string().min(1).max(2_048).optional(),
  }).strict(),
  z.object({ kind: z.literal("interaction.show"), interaction: z.string().uuid() }).strict(),
  z.object({
    kind: z.literal("interaction.inspect"),
    interaction: z.string().uuid(),
    expectedRevision: z.number().int().positive(),
  }).strict(),
  z.object({
    kind: z.literal("interaction.resolve"),
    interaction: z.string().uuid(),
    expectedRevision: z.number().int().positive(),
    resolution: interactionResolutionSchema,
  }).strict(),
  z.object({
    kind: z.literal("auth.login"),
    email: z.string().email().max(254),
    code: z.string().regex(/^\d{8}$/u).optional(),
    invite: z.string().regex(/^hra_invite_identity_v1_[A-Za-z0-9_-]{43}$/u).optional(),
  }).strict(),
  z.object({ kind: z.literal("auth.status") }).strict(),
  z.object({ kind: z.literal("auth.logout"), idempotencyKey: idempotencyKeySchema }).strict(),
  z.object({ kind: z.literal("auth.delete"), acknowledgeErasure: z.literal(true) }).strict(),
  z.object({ kind: z.literal("device.list") }).strict(),
  z.object({ kind: z.literal("device.pair") }).strict(),
  z.object({
    acknowledgeNoKeyHolders: z.literal(true),
    kind: z.literal("device.key-loss"),
  }).strict(),
  z.object({ kind: z.literal("device.approve"), device: selectorSchema, idempotencyKey: requiredUuidV7IdempotencyKeySchema }).strict(),
  z.object({ kind: z.literal("device.revoke"), device: selectorSchema, idempotencyKey: requiredUuidV7IdempotencyKeySchema }).strict(),
  z.object({ kind: z.literal("sync.status") }).strict(),
  z.object({ kind: z.literal("sync.now") }).strict(),
  z.object({ kind: z.literal("sync.projection-recover"), session: selectorSchema, idempotencyKey: requiredIdempotencyKeySchema, acknowledgeGap: z.literal(true) }).strict(),
  z.object({ kind: z.literal("work.protocol"), query: workProtocolQuerySchema }).strict(),
  z.object({
    kind: z.literal("work.apply"),
    requestId: z.string().uuid(),
    operation: workOperationSchema,
  }).strict(),
  z.object({ kind: z.literal("work.snapshot"), work: workIdSchema, actor: sessionIdSchema.optional() }).strict(),
  z.object({
    kind: z.literal("work.task"),
    task: workTaskIdSchema,
    historyLimit: z.number().int().min(1).max(WORK_TASK_HISTORY_ITEM_LIMIT).optional(),
    historyCursor: workEventCursorWireSchema.optional(),
  }).strict(),
  z.object({
    kind: z.literal("work.poll"),
    work: workIdSchema,
    actor: sessionIdSchema.optional(),
    cursor: workEventCursorWireSchema.optional(),
    actionCursor: workEventCursorWireSchema.optional(),
    limit: z.number().int().min(1).max(50),
    waitMs: z.number().int().min(0).max(WORK_WAIT_MAX_MS),
  }).strict().superRefine((value, context) => {
    if (value.actionCursor !== undefined && value.waitMs !== 0) {
      context.addIssue({
        code: "custom",
        path: ["waitMs"],
        message: "A continued work action page cannot long-poll; waitMs must be zero.",
      });
    }
  }),
  z.object({
    kind: z.literal("work.events"),
    work: workIdSchema,
    cursor: workEventCursorWireSchema.optional(),
    limit: z.number().int().min(1).max(WORK_EVENT_PAGE_LIMIT),
    waitMs: z.number().int().min(0).max(WORK_WAIT_MAX_MS),
  }).strict(),
]);

export type LocalCommand = z.infer<typeof localCommandSchema>;

export const commandEnvelopeSchema = z
  .object({
    version: z.literal(LOCAL_COMMAND_REQUEST_VERSION),
    capability: z.string().regex(/^[A-Za-z0-9_-]{43}$/u),
    requestId: z.string().uuid(),
    command: localCommandSchema,
  })
  .strict()
  .superRefine((request, context) => {
    if (utf8Bytes(JSON.stringify(request)) > LOCAL_COMMAND_REQUEST_MAX_BYTES) {
      context.addIssue({
        code: "custom",
        message: "The local command envelope exceeds its serialized UTF-8 byte bound.",
      });
    }
  });

// This validates only the transport envelope. Successful data stays unknown
// until the caller validates it against the command that produced it.
export const commandResponseSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), version: z.literal(1), requestId: z.string().uuid(), data: z.unknown() }).strict(),
  z.object({ ok: z.literal(false), version: z.literal(1), requestId: z.string().uuid(), error: z.object({ code: z.enum(["INVALID_INPUT", "NOT_FOUND", "AMBIGUOUS", "CONFLICT", "INTERACTION_REQUIRED", "UNAVAILABLE", "RECOVERY_REQUIRED", "INTERNAL"]), message: z.string().min(1).max(1000), details: z.unknown().optional() }).strict() }).strict(),
]);

export type CommandResponse = z.infer<typeof commandResponseSchema>;
