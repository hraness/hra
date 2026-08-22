import {
  humanAccessTokenSchema,
  humanRefreshTokenSchema,
  humanUserViewSchema,
  organizationViewSchema,
  refreshAuthResponseSchema,
  workspaceViewSchema,
} from "@hraness/agent-tasks-protocol";
import { z } from "@hra-internal/schema";

import { normalizeApiOrigin } from "./strict-http";

// These are opaque, already-deployed storage identifiers. Rebranding them
// would strand credentials in Keychain, so only the source symbols change.
export const HRA_HUMAN_KEYCHAIN_SERVICE = "kitchen.hraness.cloud-human.v1";
export const HRA_RUNNER_KEYCHAIN_SERVICE = "kitchen.hraness.cloud-runner.v1";

export const humanApiOriginSchema = z
  .string()
  .refine((value) => normalizeApiOrigin(value) === value, "invalid API origin");

function humanSelectionIssues(
  value: Readonly<{
    organization: z.infer<typeof organizationViewSchema>;
    workspace?: z.infer<typeof workspaceViewSchema> | undefined;
  }>,
  context: z.RefinementCtx,
): void {
  if (
    value.workspace !== undefined &&
    value.workspace.organizationId !== value.organization.id
  ) {
    context.addIssue({
      code: "custom",
      message: "workspace belongs to another organization",
    });
  }
}

export const humanAuthenticationSchema = z
  .object({
    version: z.literal(2),
    apiUrl: humanApiOriginSchema,
    accessToken: humanAccessTokenSchema,
    refreshToken: humanRefreshTokenSchema,
    user: humanUserViewSchema,
    organization: organizationViewSchema,
    workspace: workspaceViewSchema.optional(),
  })
  .strict()
  .superRefine(humanSelectionIssues);

export type HumanAuthentication = z.infer<typeof humanAuthenticationSchema>;

export const humanSecretStoreKindSchema = z.enum(["keychain", "file"]);
export type HumanSecretStoreKind = z.infer<typeof humanSecretStoreKindSchema>;

export const humanProfileSchema = z
  .object({
    version: z.literal(2),
    apiUrl: humanApiOriginSchema,
    secretStore: humanSecretStoreKindSchema,
    user: humanUserViewSchema,
    organization: organizationViewSchema,
    workspace: workspaceViewSchema.optional(),
  })
  .strict()
  .superRefine(humanSelectionIssues);

export type HumanProfile = z.infer<typeof humanProfileSchema>;

export const humanAuthenticationSnapshotSchema = z
  .object({
    generation: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    authentication: humanAuthenticationSchema,
  })
  .strict();

export type HumanAuthenticationSnapshot = z.infer<typeof humanAuthenticationSnapshotSchema>;

export function profileFromHumanAuthentication(
  authentication: HumanAuthentication,
  secretStore: HumanSecretStoreKind,
): HumanProfile {
  return humanProfileSchema.parse({
    version: 2,
    apiUrl: authentication.apiUrl,
    secretStore,
    user: authentication.user,
    organization: authentication.organization,
    ...(authentication.workspace === undefined
      ? {}
      : { workspace: authentication.workspace }),
  });
}

export type StoredHumanAuthenticationDisposition = "current" | "legacy" | "invalid";

function isLegacyVersionOne(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    "version" in value &&
    value.version === 1
  );
}

/**
 * Classify custody without reading any version-1 identity fields. Legacy
 * credentials require an explicit new pairing and are never reinterpreted.
 */
export function storedHumanAuthenticationDisposition(
  value: unknown,
): StoredHumanAuthenticationDisposition {
  if (humanAuthenticationSchema.safeParse(value).success) return "current";
  if (isLegacyVersionOne(value)) return "legacy";
  return "invalid";
}

export function storedHumanProfileDisposition(
  value: unknown,
): StoredHumanAuthenticationDisposition {
  if (humanProfileSchema.safeParse(value).success) return "current";
  if (isLegacyVersionOne(value)) return "legacy";
  return "invalid";
}

export type RefreshedHumanAuthentication =
  | { readonly ok: true; readonly authentication: HumanAuthentication }
  | {
      readonly ok: false;
      readonly reason: "invalid_response" | "identity_mismatch";
    };

/**
 * Validate rotated credentials while preserving only the exact stable user,
 * organization, and workspace selection.
 */
export function refreshedHumanAuthentication(
  current: HumanAuthentication,
  response: unknown,
): RefreshedHumanAuthentication {
  const parsedResponse = refreshAuthResponseSchema.safeParse(response);
  if (!parsedResponse.success) return { ok: false, reason: "invalid_response" };

  if (
    parsedResponse.data.user.id !== current.user.id ||
    parsedResponse.data.organization.id !== current.organization.id ||
    parsedResponse.data.workspace?.id !== current.workspace?.id ||
    (parsedResponse.data.workspace !== undefined &&
      parsedResponse.data.workspace.organizationId !== parsedResponse.data.organization.id)
  ) {
    return { ok: false, reason: "identity_mismatch" };
  }

  const next = humanAuthenticationSchema.safeParse({
    version: 2,
    apiUrl: current.apiUrl,
    accessToken: parsedResponse.data.accessToken,
    refreshToken: parsedResponse.data.refreshToken,
    user: parsedResponse.data.user,
    organization: parsedResponse.data.organization,
    ...(parsedResponse.data.workspace === undefined
      ? {}
      : { workspace: parsedResponse.data.workspace }),
  });
  return next.success
    ? { ok: true, authentication: next.data }
    : { ok: false, reason: "identity_mismatch" };
}
