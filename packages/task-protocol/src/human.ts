import { z } from "@hra-internal/schema";

import { successEnvelopeSchema } from "./errors";
import {
  agentIdSchema,
  agentNameSchema,
  agentPresetSchema,
  agentPresetScopes,
  agentScopeSchema,
  agentScopeValues,
  agentStatusSchema,
  MAX_AGENT_CREDENTIAL_LIFETIME_MS,
  MIN_AGENT_CREDENTIAL_LIFETIME_MS,
  epochMsSchema,
  humanUserIdSchema,
  organizationIdSchema,
  organizationNameSchema,
  organizationRoleSchema,
  taskKeyPrefixSchema,
  workspaceIdSchema,
  workspaceNameSchema,
  workspaceRoleSchema,
  workspaceSlugSchema,
} from "./model";
import { bearerSecretSchema, enrollmentTokenSchema, locatorSchema } from "./tokens";

const opaqueHumanTokenSchema = z
  .string()
  .min(20)
  .max(16_384)
  .refine((value) => !/\s/u.test(value), "token cannot contain whitespace");

export const humanAccessTokenSchema = opaqueHumanTokenSchema;
export const humanRefreshTokenSchema = opaqueHumanTokenSchema.max(4_096);

export const refreshAuthRequestSchema = z
  .object({})
  .strict();
export type RefreshAuthRequest = z.infer<typeof refreshAuthRequestSchema>;

export const humanUserViewSchema = z
  .object({
    id: humanUserIdSchema,
    email: z.string().email(),
    name: z.string().min(1).max(240).optional(),
  })
  .strict();

const organizationViewBase = {
  id: organizationIdSchema,
  name: organizationNameSchema,
  role: organizationRoleSchema,
  status: z.literal("active"),
} as const;

export const organizationViewSchema = z.object(organizationViewBase).strict();
export type OrganizationView = z.infer<typeof organizationViewSchema>;

export const workspaceViewSchema = z
  .object({
    id: workspaceIdSchema,
    organizationId: organizationIdSchema,
    slug: workspaceSlugSchema,
    name: workspaceNameSchema,
    taskKeyPrefix: taskKeyPrefixSchema,
    roles: z
      .array(workspaceRoleSchema)
      .max(3)
      .refine((roles) => new Set(roles).size === roles.length, "workspace roles must be unique"),
  })
  .strict();
export type WorkspaceView = z.infer<typeof workspaceViewSchema>;

const humanAuthenticationResponseFields = {
  accessToken: humanAccessTokenSchema,
  refreshToken: humanRefreshTokenSchema,
  user: humanUserViewSchema,
  organization: organizationViewSchema,
} as const;

function requireWorkspaceOrganizationMatch(
  value: Readonly<{ organization: OrganizationView; workspace?: WorkspaceView | undefined }>,
  context: z.RefinementCtx,
): void {
  if (
    value.workspace !== undefined &&
    value.workspace.organizationId !== value.organization.id
  ) {
    context.addIssue({
      code: "custom",
      message: "workspace belongs to another organization",
      path: ["workspace"],
    });
  }
}

export const refreshAuthResponseSchema = z.object({
  ...humanAuthenticationResponseFields,
  workspace: workspaceViewSchema.optional(),
}).strict().superRefine(requireWorkspaceOrganizationMatch);
export type RefreshAuthResponse = z.infer<typeof refreshAuthResponseSchema>;
export const refreshAuthEnvelopeSchema = successEnvelopeSchema(refreshAuthResponseSchema);

export const pairedHumanAuthenticationResponseSchema = z.object({
  ...humanAuthenticationResponseFields,
  workspace: workspaceViewSchema,
}).strict().superRefine(requireWorkspaceOrganizationMatch);
export type PairedHumanAuthenticationResponse = z.infer<
  typeof pairedHumanAuthenticationResponseSchema
>;

export const selectHumanScopeRequestSchema = z.object({
  organizationId: organizationIdSchema,
  workspaceId: workspaceIdSchema.optional(),
}).strict();
export type SelectHumanScopeRequest = z.infer<typeof selectHumanScopeRequestSchema>;

export const selectHumanScopeResponseSchema = z.object({
  ...humanAuthenticationResponseFields,
  workspace: workspaceViewSchema.optional(),
}).strict().superRefine(requireWorkspaceOrganizationMatch);
export type SelectHumanScopeResponse = z.infer<typeof selectHumanScopeResponseSchema>;
export const selectHumanScopeEnvelopeSchema = successEnvelopeSchema(
  selectHumanScopeResponseSchema,
);

export const desktopPairingIdSchema = z.string()
  .regex(/^pair_[0-9A-HJKMNP-TV-Z]{26}$/u, "invalid desktop pairing ID");
export type DesktopPairingId = z.infer<typeof desktopPairingIdSchema>;

export const desktopPairingVerifierSchema = bearerSecretSchema;
export const desktopPairingChallengeSchema = bearerSecretSchema;
export const desktopPairingComparisonCodeSchema = z.string()
  .regex(/^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/u, "invalid comparison code");

export const desktopPairingStartRequestSchema = z.object({
  challenge: desktopPairingChallengeSchema,
}).strict();
export type DesktopPairingStartRequest = z.infer<typeof desktopPairingStartRequestSchema>;

function safeDesktopPairingVerificationUri(value: string): boolean {
  try {
    const url = new URL(value);
    const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1" ||
      url.hostname === "[::1]" || url.hostname === "::1";
    return (
      (url.protocol === "https:" || (url.protocol === "http:" && loopback)) &&
      url.username.length === 0 &&
      url.password.length === 0 &&
      url.search.length === 0 &&
      url.hash.length === 0 &&
      /^\/pair\/desktop\/pair_[0-9A-HJKMNP-TV-Z]{26}$/u.test(url.pathname)
    );
  } catch {
    return false;
  }
}

export const desktopPairingVerificationUriSchema = z.string()
  .url()
  .max(2_048)
  .refine(safeDesktopPairingVerificationUri, "invalid desktop pairing verification URI");

export const desktopPairingStartResponseSchema = z.object({
  pairingId: desktopPairingIdSchema,
  verificationUri: desktopPairingVerificationUriSchema,
  comparisonCode: desktopPairingComparisonCodeSchema,
  expiresAt: epochMsSchema,
  pollIntervalMs: z.number().int().min(1_000).max(30_000),
}).strict().superRefine((value, context) => {
  if (new URL(value.verificationUri).pathname !== `/pair/desktop/${value.pairingId}`) {
    context.addIssue({
      code: "custom",
      message: "verification URI does not match pairing ID",
      path: ["verificationUri"],
    });
  }
});
export type DesktopPairingStartResponse = z.infer<typeof desktopPairingStartResponseSchema>;
export const desktopPairingStartEnvelopeSchema = successEnvelopeSchema(
  desktopPairingStartResponseSchema,
);

export const desktopPairingRedeemRequestSchema = z.object({
  verifier: desktopPairingVerifierSchema,
}).strict();
export type DesktopPairingRedeemRequest = z.infer<typeof desktopPairingRedeemRequestSchema>;

export const desktopPairingRedeemResponseSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("pending"), retryAfterMs: z.number().int().min(1_000).max(30_000) })
    .strict(),
  z.object({
    status: z.literal("approved"),
    authentication: pairedHumanAuthenticationResponseSchema,
  }).strict(),
  z.object({ status: z.literal("denied") }).strict(),
  z.object({ status: z.literal("expired") }).strict(),
  z.object({ status: z.literal("consumed") }).strict(),
]);
export type DesktopPairingRedeemResponse = z.infer<typeof desktopPairingRedeemResponseSchema>;
export const desktopPairingRedeemEnvelopeSchema = successEnvelopeSchema(
  desktopPairingRedeemResponseSchema,
);

const paginatedHumanListQuerySchema = z
  .object({
    cursor: z.string().min(1).max(8_192).optional(),
    limit: z
      .string()
      .regex(/^(?:[1-9]|[1-9][0-9]|100)$/u)
      .transform(Number)
      .pipe(z.number().int().min(1).max(100))
      .optional()
      .transform((value) => value ?? 20),
  })
  .strict();
export const listOrganizationsQuerySchema = paginatedHumanListQuerySchema;
export const listWorkspacesQuerySchema = paginatedHumanListQuerySchema;

export const listOrganizationsResponseSchema = z
  .object({ organizations: z.array(organizationViewSchema).max(100), cursor: z.string().nullable() })
  .strict();
export type ListOrganizationsResponse = z.infer<typeof listOrganizationsResponseSchema>;
export const listOrganizationsEnvelopeSchema = successEnvelopeSchema(listOrganizationsResponseSchema);

export const createOrganizationRequestSchema = z
  .object({ name: organizationNameSchema })
  .strict();
export type CreateOrganizationRequest = z.input<typeof createOrganizationRequestSchema>;
export const createOrganizationResponseSchema = z.object({ organization: organizationViewSchema }).strict();
export type CreateOrganizationResponse = z.infer<typeof createOrganizationResponseSchema>;
export const createOrganizationEnvelopeSchema = successEnvelopeSchema(createOrganizationResponseSchema);

export const listWorkspacesResponseSchema = z
  .object({ workspaces: z.array(workspaceViewSchema).max(100), cursor: z.string().nullable() })
  .strict();
export type ListWorkspacesResponse = z.infer<typeof listWorkspacesResponseSchema>;
export const listWorkspacesEnvelopeSchema = successEnvelopeSchema(listWorkspacesResponseSchema);

export const createWorkspaceRequestSchema = z
  .object({
    name: workspaceNameSchema,
    slug: workspaceSlugSchema,
    taskKeyPrefix: taskKeyPrefixSchema,
  })
  .strict();
export type CreateWorkspaceRequest = z.input<typeof createWorkspaceRequestSchema>;
export const createWorkspaceResponseSchema = z.object({ workspace: workspaceViewSchema }).strict();
export type CreateWorkspaceResponse = z.infer<typeof createWorkspaceResponseSchema>;
export const createWorkspaceEnvelopeSchema = successEnvelopeSchema(createWorkspaceResponseSchema);

const delegatedScopesSchema = z
  .array(agentScopeSchema)
  .min(1)
  .max(agentScopeValues.length)
  .refine((scopes) => new Set(scopes).size === scopes.length, "agent scopes must be unique");

export const agentCredentialLifetimeMsSchema = z
  .number()
  .int()
  .min(MIN_AGENT_CREDENTIAL_LIFETIME_MS)
  .max(MAX_AGENT_CREDENTIAL_LIFETIME_MS);

export const createAgentRequestSchema = z
  .object({
    workspaceId: workspaceIdSchema,
    name: agentNameSchema,
    preset: agentPresetSchema,
    scopes: delegatedScopesSchema.optional(),
    credentialLifetimeMs: agentCredentialLifetimeMsSchema.optional(),
    enrollment: enrollmentTokenSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (value.scopes === undefined) return;
    const maximum = new Set<string>(agentPresetScopes[value.preset]);
    value.scopes.forEach((scope, index) => {
      if (!maximum.has(scope)) {
        context.addIssue({
          code: "custom",
          message: `${scope} is outside the ${value.preset} preset`,
          path: ["scopes", index],
        });
      }
    });
  });
export type CreateAgentRequest = z.input<typeof createAgentRequestSchema>;

export const agentAdminViewSchema = z
  .object({
    id: agentIdSchema,
    workspaceId: workspaceIdSchema,
    name: agentNameSchema,
    status: z.literal("active"),
    scopes: delegatedScopesSchema,
  })
  .strict();

const agentLifecycleViewBase = {
  id: agentIdSchema,
  workspaceId: workspaceIdSchema,
  name: agentNameSchema,
  scopes: delegatedScopesSchema,
  createdAt: epochMsSchema,
  updatedAt: epochMsSchema,
} as const;

export const agentLifecycleViewSchema = z
  .object({ ...agentLifecycleViewBase, status: agentStatusSchema })
  .strict()
  .refine((value) => value.updatedAt >= value.createdAt, "agent update precedes creation");
export type AgentLifecycleView = z.infer<typeof agentLifecycleViewSchema>;

export const disabledAgentViewSchema = z
  .object({ ...agentLifecycleViewBase, status: z.literal("disabled") })
  .strict()
  .refine((value) => value.updatedAt >= value.createdAt, "agent update precedes creation");

export const enrollmentAdminViewSchema = z
  .object({ locator: locatorSchema, expiresAt: epochMsSchema })
  .strict();

export const createAgentResponseSchema = z
  .object({ agent: agentAdminViewSchema, enrollment: enrollmentAdminViewSchema })
  .strict();
export type CreateAgentResponse = z.infer<typeof createAgentResponseSchema>;
export const createAgentEnvelopeSchema = successEnvelopeSchema(createAgentResponseSchema);

export const createAgentEnrollmentRequestSchema = z
  .object({
    workspaceId: workspaceIdSchema,
    enrollment: enrollmentTokenSchema,
    scopes: delegatedScopesSchema.optional(),
    credentialLifetimeMs: agentCredentialLifetimeMsSchema.optional(),
  })
  .strict();
export type CreateAgentEnrollmentRequest = z.infer<typeof createAgentEnrollmentRequestSchema>;
export const createAgentEnrollmentResponseSchema = z
  .object({ enrollment: enrollmentAdminViewSchema })
  .strict();
export type CreateAgentEnrollmentResponse = z.infer<typeof createAgentEnrollmentResponseSchema>;
export const createAgentEnrollmentEnvelopeSchema = successEnvelopeSchema(
  createAgentEnrollmentResponseSchema,
);

const workspaceSelectionQuerySchema = z.object({ workspaceId: workspaceIdSchema }).strict();
export const getAgentQuerySchema = workspaceSelectionQuerySchema;

export const listAgentsQuerySchema = paginatedHumanListQuerySchema.extend({
  workspaceId: workspaceIdSchema,
});

export const listAgentsResponseSchema = z
  .object({ agents: z.array(agentLifecycleViewSchema).max(100), cursor: z.string().nullable() })
  .strict();
export type ListAgentsResponse = z.infer<typeof listAgentsResponseSchema>;
export const listAgentsEnvelopeSchema = successEnvelopeSchema(listAgentsResponseSchema);

export const getAgentResponseSchema = z.object({ agent: agentLifecycleViewSchema }).strict();
export type GetAgentResponse = z.infer<typeof getAgentResponseSchema>;
export const getAgentEnvelopeSchema = successEnvelopeSchema(getAgentResponseSchema);

const agentCredentialViewBase = {
  id: locatorSchema,
  agentId: agentIdSchema,
  workspaceId: workspaceIdSchema,
  scopes: delegatedScopesSchema,
  createdAt: epochMsSchema,
  expiresAt: epochMsSchema,
  lastUsedAt: epochMsSchema,
} as const;

const currentAgentCredentialViewSchema = z
  .object({ ...agentCredentialViewBase, status: z.enum(["active", "expired"]) })
  .strict();
export const revokedAgentCredentialViewSchema = z
  .object({ ...agentCredentialViewBase, status: z.literal("revoked"), revokedAt: epochMsSchema })
  .strict();
export const agentCredentialViewSchema = z
  .discriminatedUnion("status", [currentAgentCredentialViewSchema, revokedAgentCredentialViewSchema])
  .superRefine((value, context) => {
    if (value.lastUsedAt < value.createdAt) {
      context.addIssue({ code: "custom", message: "credential use precedes creation" });
    }
    if (value.status === "revoked" && value.revokedAt < value.createdAt) {
      context.addIssue({ code: "custom", message: "credential revocation precedes creation" });
    }
  });
export type AgentCredentialView = z.infer<typeof agentCredentialViewSchema>;

export const listAgentCredentialsQuerySchema = paginatedHumanListQuerySchema.extend({
  workspaceId: workspaceIdSchema,
});
export const listAgentCredentialsResponseSchema = z
  .object({
    credentials: z.array(agentCredentialViewSchema).max(100),
    cursor: z.string().nullable(),
  })
  .strict();
export type ListAgentCredentialsResponse = z.infer<typeof listAgentCredentialsResponseSchema>;
export const listAgentCredentialsEnvelopeSchema = successEnvelopeSchema(
  listAgentCredentialsResponseSchema,
);

export const revokeAgentCredentialRequestSchema = z.object({ workspaceId: workspaceIdSchema }).strict();
export type RevokeAgentCredentialRequest = z.infer<typeof revokeAgentCredentialRequestSchema>;
export const revokeAgentCredentialResponseSchema = z
  .object({ credential: revokedAgentCredentialViewSchema })
  .strict();
export type RevokeAgentCredentialResponse = z.infer<typeof revokeAgentCredentialResponseSchema>;
export const revokeAgentCredentialEnvelopeSchema = successEnvelopeSchema(
  revokeAgentCredentialResponseSchema,
);

export const activeAgentSessionViewSchema = z
  .object({
    agentId: agentIdSchema,
    workspaceId: workspaceIdSchema,
    credentialId: locatorSchema,
    status: z.literal("active"),
    createdAt: epochMsSchema,
    lastSeenAt: epochMsSchema,
    idleExpiresAt: epochMsSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (value.lastSeenAt < value.createdAt) {
      context.addIssue({ code: "custom", message: "session activity precedes creation" });
    }
    if (value.idleExpiresAt < value.lastSeenAt) {
      context.addIssue({ code: "custom", message: "session expiry precedes activity" });
    }
  });
export type ActiveAgentSessionView = z.infer<typeof activeAgentSessionViewSchema>;

export const listAgentSessionsQuerySchema = paginatedHumanListQuerySchema.extend({
  workspaceId: workspaceIdSchema,
});
export const listAgentSessionsResponseSchema = z
  .object({ sessions: z.array(activeAgentSessionViewSchema).max(100), cursor: z.string().nullable() })
  .strict();
export type ListAgentSessionsResponse = z.infer<typeof listAgentSessionsResponseSchema>;
export const listAgentSessionsEnvelopeSchema = successEnvelopeSchema(
  listAgentSessionsResponseSchema,
);

export const disableAgentRequestSchema = z.object({ workspaceId: workspaceIdSchema }).strict();
export type DisableAgentRequest = z.infer<typeof disableAgentRequestSchema>;
export const disableAgentResponseSchema = z.object({ agent: disabledAgentViewSchema }).strict();
export type DisableAgentResponse = z.infer<typeof disableAgentResponseSchema>;
export const disableAgentEnvelopeSchema = successEnvelopeSchema(disableAgentResponseSchema);
