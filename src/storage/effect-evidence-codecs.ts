import { z } from "zod";

import {
  presetV1Schema as presetSchema,
  providerV1Schema as providerSchema,
} from "../domain/presets";
import { reviewedRuntimeProfileV1Schema as reviewedRuntimeProfileSchema } from "../domain/runtime-profile";
import {
  profileIdSchema,
  projectIdSchema,
  queueIdSchema,
  sessionIdSchema,
  titleSchema,
} from "../domain/values";

// These codecs describe retained combined-schema-49 evidence, not the current
// writer contract. Preserve field order and absent optional fields: parsed JSON
// is also the input to the historical evidence digest. New evidence fields need
// a separate format rather than extending what old records can authorize.
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);
const providerThreadIdSchema = z.string().min(1).max(200);
const providerLoginIdSchema = z.string().min(1).max(512).refine(
  (value) => !/\p{Cc}/u.test(value),
  "Provider login ID contains control characters.",
);
const providerAccountAuthorityKeySchema = z.string()
  .regex(/^v1:(?:codex|claude):[a-f0-9]{64}$/u);
const providerBaselineSchema = z.object({
  providerUpdatedAt: z.number().nonnegative().nullable(),
  status: z.enum(["active", "idle", "terminal"]),
  activeTurnId: z.string().min(1).max(200).nullable(),
}).strict();

export const mutationEffectEvidence49Schema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("session.send"), providerThreadId: providerThreadIdSchema, baseline: providerBaselineSchema, clientMessageId: z.string().min(1).max(512), messageDigest: sha256Schema, runtimeProfile: reviewedRuntimeProfileSchema.optional() }).strict(),
  z.object({ kind: z.literal("session.steer"), providerThreadId: providerThreadIdSchema, baseline: providerBaselineSchema, activeTurnId: z.string().min(1).max(200).nullable(), clientMessageId: z.string().min(1).max(512), messageDigest: sha256Schema }).strict(),
  z.object({ kind: z.literal("session.stop"), providerThreadId: providerThreadIdSchema, baseline: providerBaselineSchema, activeTurnId: z.string().min(1).max(200).nullable() }).strict(),
  z.object({ kind: z.literal("session.rename"), providerThreadId: providerThreadIdSchema, baseline: providerBaselineSchema, requestedName: titleSchema }).strict(),
  z.object({ kind: z.literal("session.start"), projectId: projectIdSchema, clientMessageId: z.string().min(1).max(512).nullable(), messageDigest: sha256Schema.nullable(), runtimeProfile: reviewedRuntimeProfileSchema.optional(), conversationAutomationCapability: z.literal("hra.automation_update.v1").optional() }).strict(),
  z.object({
    kind: z.literal("session.switch"),
    // Historical unsettled receipts can predate durable daemon/account proof.
    // Current writer admission separately enforces its daemon/account proof.
    daemonGeneration: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
    requestedAccountId: profileIdSchema.nullable(),
    requestedPreset: presetSchema.nullable(),
    sourceProfileId: profileIdSchema,
    sourceProcessGeneration: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    sourceProvider: providerSchema,
    sourceProviderThreadId: providerThreadIdSchema,
    sourcePreset: presetSchema,
    targetProfileId: profileIdSchema,
    targetProcessGeneration: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    targetProvider: providerSchema,
    targetProviderAccountKey: providerAccountAuthorityKeySchema.optional(),
    targetPreset: presetSchema,
    transcriptDigest: sha256Schema,
    seedDigest: sha256Schema,
    seedIncludedRecords: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    seedOmittedRecords: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    runtimeProfile: reviewedRuntimeProfileSchema,
  }).strict(),
  z.object({ kind: z.literal("account.login"), method: z.enum(["browser", "device_code"]) }).strict(),
  z.object({ kind: z.literal("account.claude-login"), provider: z.literal("claude"), baselineSignedIn: z.literal(false) }).strict(),
  z.object({ kind: z.literal("account.devin-login"), provider: z.literal("devin"), baselineSignedIn: z.literal(false) }).strict(),
  z.object({ kind: z.literal("account.logout"), baselineSignedIn: z.boolean() }).strict(),
  z.object({ kind: z.literal("account.login-cancel"), loginId: providerLoginIdSchema }).strict(),
]);

export const queueEffectEvidence49Schema = z.object({
  kind: z.literal("queue.dispatch"),
  queueId: queueIdSchema,
  sessionId: sessionIdSchema,
  providerThreadId: providerThreadIdSchema,
  profileGeneration: z.number().int().nonnegative(),
  baseline: providerBaselineSchema,
  clientMessageId: z.string().min(1).max(512),
  messageDigest: sha256Schema,
  runtimeProfile: reviewedRuntimeProfileSchema,
}).strict();
