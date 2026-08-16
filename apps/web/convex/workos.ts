import {
  AuthenticationException,
  BadRequestException,
  NotFoundException,
  OauthException,
  UnauthorizedException,
  WorkOS,
  type AuthenticationResponse,
  type Event as WorkOSEvent,
  type Organization,
  type OrganizationMembership,
} from "@workos-inc/node";

import { env } from "./_generated/server";

const WORKOS_REQUEST_TIMEOUT_MS = 10_000;

// Owner provisioning performs at most one list and one marker-gated, non-idempotent
// create. The create must never be retried by the SDK, and the durable lease must
// outlive both zero-retry request timeouts so another action cannot overlap the attempt.
export const WORKOS_OWNER_MEMBERSHIP_PROVIDER_POLICY = {
  maxRetries: 0,
  maximumCallsPerLease: 2,
  requestTimeoutMs: WORKOS_REQUEST_TIMEOUT_MS,
  leaseDurationMs: 60_000,
} as const;

export interface WorkOSMembershipPage {
  readonly memberships: OrganizationMembership[];
  readonly cursor: string | null;
  readonly diagnostics: WorkOSMembershipPageDiagnostic[];
}

export interface WorkOSMembershipPageDiagnostic {
  readonly resourceKind: "organization" | "organization_membership";
  readonly resourceId: string;
  readonly reason: "provider_locator_mismatch" | "invalid_provider_record";
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : null;
}

function membershipPage(value: unknown): {
  data: unknown[];
  cursor: string | null;
} | null {
  const page = recordValue(value);
  const metadata = recordValue(page?.["listMetadata"]);
  const after = metadata?.["after"];
  if (
    page === null ||
    !Array.isArray(page["data"]) ||
    (after !== undefined && after !== null && typeof after !== "string")
  ) {
    return null;
  }
  return { data: page["data"], cursor: typeof after === "string" ? after : null };
}

export interface WorkOSMembershipLocator {
  readonly id: string;
  readonly organizationId: string;
  readonly userId: string;
}

export function readWorkOSMembershipLocator(value: unknown): WorkOSMembershipLocator | null {
  const membership = recordValue(value);
  const id = membership?.["id"];
  const organizationId = membership?.["organizationId"];
  const userId = membership?.["userId"];
  return typeof id === "string" &&
    typeof organizationId === "string" &&
    typeof userId === "string"
    ? { id, organizationId, userId }
    : null;
}

export function workOSOrganizationExternalIdMatches(
  organization: unknown,
  expectedExternalId: string,
): boolean {
  return recordValue(organization)?.["externalId"] === expectedExternalId;
}

export function workOSMembershipLocatorMatches(
  membership: unknown,
  expected: { readonly organizationId: string; readonly userId: string },
): boolean {
  const locator = readWorkOSMembershipLocator(membership);
  return (
    locator !== null &&
    locator.organizationId === expected.organizationId &&
    locator.userId === expected.userId
  );
}

function loopbackHostname(value: string): boolean {
  return value === "127.0.0.1" || value === "localhost" || value === "::1" || value === "[::1]";
}

function configuredClient(maxRetries: number, requireApiKey: boolean): WorkOS | null {
  const clientId = env.WORKOS_CLIENT_ID;
  const apiKey = env.WORKOS_API_KEY;
  if (
    clientId === undefined ||
    clientId.length === 0 ||
    (requireApiKey && (apiKey === undefined || apiKey.length === 0))
  ) {
    return null;
  }

  const apiHostname = env.WORKOS_API_HOSTNAME;
  const localOverride = apiHostname !== undefined && apiHostname.length > 0;
  if (
    localOverride &&
    (env.TASKCTL_LOCAL_FIXTURES_ENABLED !== "true" || !loopbackHostname(apiHostname))
  ) {
    return null;
  }
  const portValue = env.WORKOS_API_PORT;
  const port = portValue === undefined || portValue.length === 0 ? undefined : Number(portValue);
  if (port !== undefined && (!Number.isSafeInteger(port) || port < 1 || port > 65_535)) return null;
  const https = env.WORKOS_API_HTTPS;
  if (https !== undefined && https !== "true" && https !== "false") return null;
  if (!localOverride && (port !== undefined || https !== undefined)) return null;

  return new WorkOS({
    clientId,
    ...(apiKey === undefined || apiKey.length === 0 ? {} : { apiKey }),
    ...(localOverride ? { apiHostname } : {}),
    ...(https === undefined ? {} : { https: https === "true" }),
    ...(port === undefined ? {} : { port }),
    timeout: WORKOS_REQUEST_TIMEOUT_MS,
    maxRetries,
  });
}

export function workosOwnerRoleSlug(): string {
  const configured = env.WORKOS_OWNER_ROLE_SLUG;
  return configured === undefined || configured.length === 0 ? "admin" : configured;
}

export function isWorkOSNotFound(error: unknown): boolean {
  return error instanceof NotFoundException;
}

export function isDefinitiveRefreshRejection(error: unknown): boolean {
  return (
    error instanceof AuthenticationException ||
    error instanceof BadRequestException ||
    error instanceof OauthException ||
    error instanceof UnauthorizedException
  );
}

export async function refreshWorkOSAuthentication(args: {
  refreshToken: string;
  organizationId?: string;
}): Promise<AuthenticationResponse | null> {
  const client = configuredClient(0, true);
  if (client === null) return null;
  return await client.userManagement.authenticateWithRefreshToken({
    refreshToken: args.refreshToken,
    ...(args.organizationId === undefined ? {} : { organizationId: args.organizationId }),
  });
}

export async function listWorkOSMemberships(args: {
  userId: string;
  cursor?: string;
  limit: number;
}): Promise<WorkOSMembershipPage | null> {
  const client = configuredClient(2, true);
  if (client === null) return null;
  const providerPage: unknown = await client.userManagement.listOrganizationMemberships({
    userId: args.userId,
    statuses: ["active"],
    limit: args.limit,
    ...(args.cursor === undefined ? {} : { after: args.cursor }),
  });
  const page = membershipPage(providerPage);
  if (
    page === null ||
    page.data.some((membership) => readWorkOSMembershipLocator(membership)?.userId !== args.userId)
  ) {
    throw new Error("WorkOS returned a membership for a different user.");
  }
  return {
    memberships: page.data as OrganizationMembership[],
    cursor: page.cursor,
    diagnostics: [],
  };
}

export async function listWorkOSMembershipsForOrganization(args: {
  organizationId: string;
  cursor?: string;
  limit: number;
}): Promise<WorkOSMembershipPage | null> {
  const client = configuredClient(2, true);
  if (client === null) return null;
  const providerPage: unknown = await client.userManagement.listOrganizationMemberships({
    organizationId: args.organizationId,
    statuses: ["active", "inactive", "pending"],
    limit: args.limit,
    ...(args.cursor === undefined ? {} : { after: args.cursor }),
  });
  const page = membershipPage(providerPage);
  if (page === null) {
    return {
      memberships: [],
      cursor: null,
      diagnostics: [
        {
          resourceKind: "organization",
          resourceId: args.organizationId,
          reason: "invalid_provider_record",
        },
      ],
    };
  }
  const memberships: OrganizationMembership[] = [];
  const diagnostics: WorkOSMembershipPageDiagnostic[] = [];
  for (const membership of page.data) {
    const locator = readWorkOSMembershipLocator(membership);
    if (locator?.organizationId === args.organizationId) {
      memberships.push(membership as OrganizationMembership);
    } else {
      diagnostics.push({
        resourceKind: "organization_membership",
        resourceId:
          locator !== null && locator.id.length > 0 && locator.id.length <= 255
            ? locator.id
            : args.organizationId,
        reason: locator === null ? "invalid_provider_record" : "provider_locator_mismatch",
      });
    }
  }
  return { memberships, cursor: page.cursor, diagnostics };
}

export async function getWorkOSMembership(
  organizationMembershipId: string,
): Promise<OrganizationMembership | null | undefined> {
  const client = configuredClient(2, true);
  if (client === null) return undefined;
  try {
    return await client.userManagement.getOrganizationMembership(organizationMembershipId);
  } catch (error) {
    if (isWorkOSNotFound(error)) return null;
    throw error;
  }
}

export async function getWorkOSOrganization(
  organizationId: string,
): Promise<Organization | null | undefined> {
  const client = configuredClient(2, true);
  if (client === null) return undefined;
  try {
    return await client.organizations.getOrganization(organizationId);
  } catch (error) {
    if (isWorkOSNotFound(error)) return null;
    throw error;
  }
}

export async function constructWorkOSWebhookEvent(
  payload: Uint8Array,
  signature: string,
): Promise<WorkOSEvent | null> {
  const secret = env.WORKOS_WEBHOOK_SECRET;
  const client = configuredClient(0, false);
  if (secret === undefined || secret.length === 0 || client === null) return null;
  return await client.webhooks.constructEvent({
    payload,
    sigHeader: signature,
    secret,
  });
}

export async function findWorkOSOrganizationByExternalId(
  externalId: string,
): Promise<Organization | null | undefined> {
  const client = configuredClient(2, true);
  if (client === null) return undefined;
  try {
    return await client.organizations.getOrganizationByExternalId(externalId);
  } catch (error) {
    if (isWorkOSNotFound(error)) return null;
    throw error;
  }
}

export async function createWorkOSOrganization(args: {
  name: string;
  externalId: string;
  idempotencyKey: string;
}): Promise<Organization | null> {
  const client = configuredClient(2, true);
  if (client === null) return null;
  return await client.organizations.createOrganization(
    { name: args.name, externalId: args.externalId },
    { idempotencyKey: args.idempotencyKey },
  );
}

function hasConfiguredOwnerRole(membership: unknown): boolean {
  const record = recordValue(membership);
  const configuredValue = record?.["roles"];
  const fallbackRole = recordValue(record?.["role"]);
  if (
    (configuredValue !== undefined && configuredValue !== null && !Array.isArray(configuredValue)) ||
    typeof fallbackRole?.["slug"] !== "string"
  ) {
    return false;
  }
  const configured: string[] = [];
  for (const value of configuredValue ?? []) {
    const role = recordValue(value);
    if (typeof role?.["slug"] !== "string") return false;
    configured.push(role["slug"]);
  }
  const roles = configured.length === 0 ? [fallbackRole["slug"]] : configured;
  return roles.includes(workosOwnerRoleSlug());
}

export type WorkOSOwnerMembershipPoll =
  | { readonly kind: "active"; readonly membership: OrganizationMembership }
  | { readonly kind: "not_ready" }
  | { readonly kind: "missing" };

export async function pollWorkOSOwnerMembership(args: {
  userId: string;
  organizationId: string;
}): Promise<WorkOSOwnerMembershipPoll | null> {
  const client = configuredClient(WORKOS_OWNER_MEMBERSHIP_PROVIDER_POLICY.maxRetries, true);
  if (client === null) return null;
  const providerPage: unknown = await client.userManagement.listOrganizationMemberships({
    userId: args.userId,
    organizationId: args.organizationId,
    statuses: ["active", "inactive", "pending"],
    limit: 10,
  });
  const page = membershipPage(providerPage);
  if (page === null) throw new Error("WorkOS returned an invalid organization membership page.");
  if (
    page.data.some(
      (membership) => !workOSMembershipLocatorMatches(membership, args),
    )
  ) {
    throw new Error("WorkOS returned a mismatched organization membership.");
  }
  const activeOwner = page.data.find(
    (membership) => recordValue(membership)?.["status"] === "active" && hasConfiguredOwnerRole(membership),
  );
  if (activeOwner !== undefined) {
    return { kind: "active", membership: activeOwner as OrganizationMembership };
  }
  return page.data.length === 0 ? { kind: "missing" } : { kind: "not_ready" };
}

export async function createWorkOSOwnerMembership(args: {
  userId: string;
  organizationId: string;
}): Promise<OrganizationMembership | null> {
  const client = configuredClient(WORKOS_OWNER_MEMBERSHIP_PROVIDER_POLICY.maxRetries, true);
  if (client === null) return null;
  return await client.userManagement.createOrganizationMembership({
    userId: args.userId,
    organizationId: args.organizationId,
    roleSlug: workosOwnerRoleSlug(),
  });
}

export function isActiveWorkOSOwnerMembership(membership: unknown): boolean {
  return recordValue(membership)?.["status"] === "active" && hasConfiguredOwnerRole(membership);
}
