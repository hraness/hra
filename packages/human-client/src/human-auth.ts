import {
  humanAccessTokenSchema,
  humanRefreshTokenSchema,
  humanUserViewSchema,
  organizationViewSchema,
  refreshAuthResponseSchema,
  workspaceViewSchema,
  workosOrganizationIdSchema,
  type OrganizationView,
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
    organization?: OrganizationView | undefined;
    workspace?: z.infer<typeof workspaceViewSchema> | undefined;
    workosOrganizationId?: string | undefined;
  }>,
  context: z.RefinementCtx,
): void {
  if (value.workspace !== undefined && value.organization === undefined) {
    context.addIssue({
      code: "custom",
      message: "workspace selection requires an organization",
    });
  }
  if (
    value.workspace !== undefined &&
    value.organization !== undefined &&
    value.workspace.organizationId !== value.organization.id
  ) {
    context.addIssue({
      code: "custom",
      message: "workspace belongs to another organization",
    });
  }
  if (
    value.organization?.workosOrganizationId !== undefined &&
    value.workosOrganizationId !== value.organization.workosOrganizationId
  ) {
    context.addIssue({
      code: "custom",
      message: "token belongs to another organization",
    });
  }
}

export const humanAuthenticationSchema = z
  .object({
    version: z.literal(1),
    apiUrl: humanApiOriginSchema,
    accessToken: humanAccessTokenSchema,
    refreshToken: humanRefreshTokenSchema,
    user: humanUserViewSchema,
    workosOrganizationId: workosOrganizationIdSchema.optional(),
    organization: organizationViewSchema.optional(),
    workspace: workspaceViewSchema.optional(),
  })
  .strict()
  .superRefine(humanSelectionIssues);

export type HumanAuthentication = z.infer<typeof humanAuthenticationSchema>;

export const humanSecretStoreKindSchema = z.enum(["keychain", "file"]);
export type HumanSecretStoreKind = z.infer<typeof humanSecretStoreKindSchema>;

export const humanProfileSchema = z
  .object({
    version: z.literal(1),
    apiUrl: humanApiOriginSchema,
    secretStore: humanSecretStoreKindSchema,
    user: humanUserViewSchema,
    workosOrganizationId: workosOrganizationIdSchema.optional(),
    organization: organizationViewSchema.optional(),
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
    version: 1,
    apiUrl: authentication.apiUrl,
    secretStore,
    user: authentication.user,
    ...(authentication.workosOrganizationId === undefined
      ? {}
      : { workosOrganizationId: authentication.workosOrganizationId }),
    ...(authentication.organization === undefined
      ? {}
      : { organization: authentication.organization }),
    ...(authentication.workspace === undefined
      ? {}
      : { workspace: authentication.workspace }),
  });
}

export type RefreshedHumanAuthentication =
  | { readonly ok: true; readonly authentication: HumanAuthentication }
  | {
      readonly ok: false;
      readonly reason: "invalid_response" | "identity_mismatch";
    };

/**
 * Validate rotated credentials while preserving only selections that remain
 * bound to the same user and WorkOS organization.
 */
export function refreshedHumanAuthentication(
  current: HumanAuthentication,
  response: unknown,
  targetOrganization?: OrganizationView,
): RefreshedHumanAuthentication {
  const parsedResponse = refreshAuthResponseSchema.safeParse(response);
  if (!parsedResponse.success) return { ok: false, reason: "invalid_response" };

  const expectedOrganizationId =
    targetOrganization?.workosOrganizationId ?? current.workosOrganizationId;
  if (
    parsedResponse.data.user.id !== current.user.id ||
    (expectedOrganizationId !== undefined &&
      parsedResponse.data.workosOrganizationId !== expectedOrganizationId)
  ) {
    return { ok: false, reason: "identity_mismatch" };
  }

  const preserveWorkspace = targetOrganization === undefined;
  const next = humanAuthenticationSchema.safeParse({
    version: 1,
    apiUrl: current.apiUrl,
    accessToken: parsedResponse.data.accessToken,
    refreshToken: parsedResponse.data.refreshToken,
    user: parsedResponse.data.user,
    ...(parsedResponse.data.workosOrganizationId === undefined
      ? {}
      : { workosOrganizationId: parsedResponse.data.workosOrganizationId }),
    ...(targetOrganization === undefined
      ? current.organization === undefined
        ? {}
        : { organization: current.organization }
      : { organization: targetOrganization }),
    ...(preserveWorkspace && current.workspace !== undefined
      ? { workspace: current.workspace }
      : {}),
  });
  return next.success
    ? { ok: true, authentication: next.data }
    : { ok: false, reason: "identity_mismatch" };
}
