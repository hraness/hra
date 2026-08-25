import { isAbsolute, normalize } from "node:path";

import { z } from "zod";

import { presetSchema } from "./presets";
import { interactionResolutionSchema } from "./interactions";
import {
  SESSION_EVENT_PAGE_LIMIT,
  SESSION_EVENT_WAIT_MAX_MS,
} from "./session-events";
import { ACCOUNT_USAGE_HISTORY_PAGE_LIMIT } from "./usage-metrics";
import {
  labelSchema,
  messageSchema,
  noteSchema,
  profileIdSchema,
  titleSchema,
  unixMillisecondsSchema,
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
const daemonStopAuthoritySchema = z.object({
  protocol: z.literal("hra-control-plane-local-v1"),
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
  z.object({ kind: z.literal("account.login-cancel"), account: selectorSchema }).strict(),
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
  z.object({
    kind: z.literal("session.events"),
    session: selectorSchema,
    cursor: z.string().min(1).max(2_048).optional(),
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
]);

export type LocalCommand = z.infer<typeof localCommandSchema>;

export const commandEnvelopeSchema = z
  .object({
    version: z.literal(1),
    capability: z.string().regex(/^[A-Za-z0-9_-]{43}$/u),
    requestId: z.string().uuid(),
    command: localCommandSchema,
  })
  .strict();

// This validates only the transport envelope. Successful data stays unknown
// until the caller validates it against the command that produced it.
export const commandResponseSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), version: z.literal(1), requestId: z.string().uuid(), data: z.unknown() }).strict(),
  z.object({ ok: z.literal(false), version: z.literal(1), requestId: z.string().uuid(), error: z.object({ code: z.enum(["INVALID_INPUT", "NOT_FOUND", "AMBIGUOUS", "CONFLICT", "INTERACTION_REQUIRED", "UNAVAILABLE", "RECOVERY_REQUIRED", "INTERNAL"]), message: z.string().min(1).max(1000), details: z.unknown().optional() }).strict() }).strict(),
]);

export type CommandResponse = z.infer<typeof commandResponseSchema>;
