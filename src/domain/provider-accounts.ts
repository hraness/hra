import { randomUUID } from "node:crypto";

import { z } from "zod";

import { profileIdSchema } from "./values";

/**
 * Codex keeps the established public profile id. Claude receives a distinct,
 * HRA-owned opaque id because its auth-status probe exposes no stable account
 * identity that HRA can safely join across profiles or machines.
 */
export const codexProviderAccountIdSchema = z.string().regex(/^acct_[0-9a-f]{32}$/u);
export const claudeProviderAccountIdSchema = z.string().regex(/^pact_[0-9a-f]{32}$/u);
export const providerAccountIdSchema = z.union([
  codexProviderAccountIdSchema,
  claudeProviderAccountIdSchema,
]);

export type ProviderAccountId = z.infer<typeof providerAccountIdSchema>;

export const createClaudeProviderAccountId = (): ProviderAccountId =>
  providerAccountIdSchema.parse(`pact_${randomUUID().replaceAll("-", "")}`);

export const providerAccountReadinessSchema = z.enum([
  "unverified",
  "signed_out",
  "login_pending",
  "signed_in",
  "recovery_required",
  "removed",
]);

export type ProviderAccountReadiness = z.infer<
  typeof providerAccountReadinessSchema
>;

export const sessionRoutingProvenanceSchema = z.enum(["explicit", "managed"]);
export type SessionRoutingProvenance = z.infer<
  typeof sessionRoutingProvenanceSchema
>;

export const providerAuthorityRoleSchema = z.enum([
  "primary",
  "source",
  "target",
]);
export type ProviderAuthorityRole = z.infer<typeof providerAuthorityRoleSchema>;

/** Exact authority required before a provider effect may escape. */
const providerAuthorityFields = {
  profileId: profileIdSchema,
  bindingGeneration: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  processGeneration: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
} as const;

export const providerAccountAuthoritySchema = z.discriminatedUnion("provider", [
  z.object({
    ...providerAuthorityFields,
    provider: z.literal("codex"),
    providerAccountId: codexProviderAccountIdSchema,
  }).strict(),
  z.object({
    ...providerAuthorityFields,
    provider: z.literal("claude"),
    providerAccountId: claudeProviderAccountIdSchema,
  }).strict(),
]);

export type ProviderAccountAuthority = z.infer<
  typeof providerAccountAuthoritySchema
>;
