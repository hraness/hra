import { isAbsolute, normalize } from "node:path";

import { z } from "zod";

import { presetSchema } from "./presets";
import { interactionResolutionSchema } from "./interactions";
import {
  SESSION_EVENT_PAGE_LIMIT,
  SESSION_EVENT_WAIT_MAX_MS,
} from "./session-events";
import { labelSchema, messageSchema, noteSchema, titleSchema } from "./values";

const selectorSchema = z.string().trim().min(1).max(200);
const idempotencyKeySchema = z.string().uuid().optional();
const requiredIdempotencyKeySchema = z.string().uuid();
const projectPathSchema = z.string().min(1).max(4096).refine(
  (value) => isAbsolute(value) && normalize(value) === value,
  "Project path must be absolute and normalized.",
);

export const localCommandSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("doctor"), offline: z.boolean() }).strict(),
  z.object({ kind: z.literal("daemon.status") }).strict(),
  z.object({ kind: z.literal("daemon.stop") }).strict(),
  z.object({ kind: z.literal("account.list") }).strict(),
  z.object({ kind: z.literal("account.add"), label: labelSchema }).strict(),
  z.object({ kind: z.literal("account.show"), account: selectorSchema }).strict(),
  z.object({ kind: z.literal("account.login"), account: selectorSchema, deviceCode: z.boolean(), idempotencyKey: idempotencyKeySchema }).strict(),
  z.object({ kind: z.literal("account.logout"), account: selectorSchema, idempotencyKey: idempotencyKeySchema }).strict(),
  z.object({ kind: z.literal("account.usage"), account: selectorSchema.optional(), refresh: z.boolean() }).strict(),
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
  z.object({ kind: z.literal("session.list"), account: selectorSchema.optional(), limit: z.number().int().min(1).max(100) }).strict(),
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
  }).strict(),
  z.object({ kind: z.literal("interaction.show"), interaction: z.string().uuid() }).strict(),
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
  z.object({ kind: z.literal("device.approve"), device: selectorSchema, idempotencyKey: idempotencyKeySchema }).strict(),
  z.object({ kind: z.literal("device.revoke"), device: selectorSchema, idempotencyKey: idempotencyKeySchema }).strict(),
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

export const commandResponseSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), version: z.literal(1), requestId: z.string().uuid(), data: z.unknown() }).strict(),
  z.object({ ok: z.literal(false), version: z.literal(1), requestId: z.string().uuid(), error: z.object({ code: z.enum(["INVALID_INPUT", "NOT_FOUND", "AMBIGUOUS", "CONFLICT", "INTERACTION_REQUIRED", "UNAVAILABLE", "RECOVERY_REQUIRED", "INTERNAL"]), message: z.string().min(1).max(1000), details: z.unknown().optional() }).strict() }).strict(),
]);

export type CommandResponse = z.infer<typeof commandResponseSchema>;
