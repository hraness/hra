import { createUuidV7, encodeBase64Url } from "@hraness/agent-tasks-protocol";

const CLIENT_ID = "client_taskctl_local";
const API_KEY = "sk_test_taskctl_local_fixture";
const WEBHOOK_SECRET = "whsec_taskctl_local_fixture";
const USER_ID = "user_taskctllocalowner";
const USER_EMAIL = "owner@taskctl.local.invalid";
const USER_NAME = "Local Taskctl Owner";
const KEY_ID = "taskctl-local-rs256-v1";
const JSON_HEADERS = { "Content-Type": "application/json; charset=utf-8" } as const;

export interface FakeOrganization {
  readonly id: string;
  readonly name: string;
  readonly externalId: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface FakeMembership {
  readonly id: string;
  readonly organizationId: string;
  readonly userId: string;
  readonly roleSlug: string;
  readonly status: "active" | "inactive" | "pending";
  readonly createdAt: string;
  readonly updatedAt: string;
}

interface RefreshGrant {
  readonly userId: string;
  readonly active: boolean;
}

export interface FakeWorkOSSnapshot {
  readonly organizationCount: number;
  readonly membershipCount: number;
  readonly membershipCreateCount: number;
  readonly refreshCount: number;
  readonly deviceAuthorizationCount: number;
  readonly devicePollCount: number;
}

export interface SignedWorkOSWebhook {
  readonly body: string;
  readonly signature: string;
}

export interface FakeWorkOS {
  readonly origin: string;
  readonly issuer: string;
  readonly jwksUrl: string;
  readonly clientId: string;
  readonly apiKey: string;
  readonly webhookSecret: string;
  readonly userId: string;
  readonly initialRefreshToken: string;
  issueAccessToken(organizationId?: string): Promise<string>;
  issueRefreshToken(): string;
  organizations(): readonly FakeOrganization[];
  memberships(): readonly FakeMembership[];
  setMembership(args: {
    membershipId: string;
    status?: FakeMembership["status"];
    roleSlug?: string;
    updatedAt?: string;
  }): FakeMembership;
  createMembership(args: {
    organizationId: string;
    userId: string;
    roleSlug: string;
    status?: FakeMembership["status"];
    updatedAt?: string;
  }): FakeMembership;
  restoreMembership(membership: FakeMembership): void;
  deleteMembership(membershipId: string): FakeMembership | null;
  restoreOrganization(organization: FakeOrganization): void;
  deleteOrganization(organizationId: string): FakeOrganization | null;
  setNextCreatedMembershipStatus(status: FakeMembership["status"]): void;
  setNextMembershipListAfterSnapshotHook(hook: () => Promise<void>): void;
  setNextCreatedMembershipWebhookTarget(target: string): void;
  setNextMembershipCreateCommitThenFail(hiddenListReads: number): void;
  setNextMembershipGetPayload(membershipId: string, payload: unknown): void;
  setNextRefreshOrganizationOverride(organizationId: string | null): void;
  signMembershipWebhook(args: {
    eventId: string;
    event: "organization_membership.created" | "organization_membership.updated" | "organization_membership.deleted";
    membership: FakeMembership;
    eventCreatedAt: string;
  }): Promise<SignedWorkOSWebhook>;
  signOrganizationWebhook(args: {
    eventId: string;
    event: "organization.created" | "organization.updated" | "organization.deleted";
    organization: FakeOrganization;
    eventCreatedAt: string;
  }): Promise<SignedWorkOSWebhook>;
  snapshot(): FakeWorkOSSnapshot;
  stop(): void;
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { ...JSON_HEADERS, "X-Request-ID": randomUuidV7() },
  });
}

function randomUuidV7(): string {
  return createUuidV7(Date.now(), crypto.getRandomValues(new Uint8Array(10)));
}

function base64Url(value: Uint8Array | string): string {
  return encodeBase64Url(typeof value === "string" ? new TextEncoder().encode(value) : value);
}

function ownedArrayBuffer(value: Uint8Array): ArrayBuffer {
  const owned = new Uint8Array(value.length);
  owned.set(value);
  return owned.buffer;
}

function copyMembership(membership: FakeMembership): FakeMembership {
  return { ...membership };
}

async function hmacSha256Hex(secret: string, payload: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(payload),
  );
  return [...new Uint8Array(signature)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function readBody(request: Request): Promise<Record<string, unknown>> {
  const contentType = request.headers.get("content-type")?.split(";", 1)[0]?.trim();
  if (contentType === "application/x-www-form-urlencoded") {
    return Object.fromEntries(new URLSearchParams(await request.text()));
  }
  const parsed: unknown = await request.json();
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
  return parsed as Record<string, unknown>;
}

function workosUser() {
  const now = new Date().toISOString();
  return {
    object: "user",
    id: USER_ID,
    email: USER_EMAIL,
    email_verified: true,
    name: USER_NAME,
    first_name: "Local",
    last_name: "Owner",
    profile_picture_url: null,
    last_sign_in_at: now,
    locale: "en",
    created_at: now,
    updated_at: now,
    external_id: null,
    metadata: {},
  };
}

function workosOrganization(organization: FakeOrganization) {
  return {
    object: "organization",
    id: organization.id,
    name: organization.name,
    allow_profiles_outside_organization: false,
    domains: [],
    created_at: organization.createdAt,
    updated_at: organization.updatedAt,
    external_id: organization.externalId,
    metadata: {},
  };
}

function workosMembership(membership: FakeMembership, organizationName: string) {
  const role = { slug: membership.roleSlug };
  return {
    object: "organization_membership",
    id: membership.id,
    user_id: membership.userId,
    organization_id: membership.organizationId,
    organization_name: organizationName,
    status: membership.status,
    directory_managed: false,
    created_at: membership.createdAt,
    updated_at: membership.updatedAt,
    role,
    roles: [role],
    custom_attributes: {},
  };
}

export async function startFakeWorkOS(): Promise<FakeWorkOS> {
  const signingKeys = await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2_048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  );
  const publicJwk = await crypto.subtle.exportKey("jwk", signingKeys.publicKey);
  const organizations = new Map<string, FakeOrganization>();
  const organizationsByExternalId = new Map<string, FakeOrganization>();
  const memberships = new Map<string, FakeMembership>();
  const refreshGrants = new Map<string, RefreshGrant>();
  const deviceCodes = new Set<string>();
  let refreshCount = 0;
  let deviceAuthorizationCount = 0;
  let devicePollCount = 0;
  let refreshSequence = 0;
  let organizationSequence = 0;
  let membershipSequence = 0;
  let membershipCreateCount = 0;
  let nextCreatedMembershipStatus: FakeMembership["status"] = "active";
  let nextMembershipListAfterSnapshotHook: (() => Promise<void>) | undefined;
  let nextCreatedMembershipWebhookTarget: string | undefined;
  let nextMembershipCreateCommitThenFail: number | undefined;
  const hiddenMembershipListReads = new Map<string, number>();
  const nextMembershipGetPayloads = new Map<string, unknown>();
  let nextRefreshOrganizationOverride: string | null | undefined;
  const runSuffix = [...crypto.getRandomValues(new Uint8Array(8))]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");

  const initialRefreshToken = `rt_local_${base64Url(crypto.getRandomValues(new Uint8Array(32)))}`;
  refreshGrants.set(initialRefreshToken, { userId: USER_ID, active: true });

  function issueRefreshToken(): string {
    refreshSequence += 1;
    const refreshToken = `rt_local_${refreshSequence}_${base64Url(
      crypto.getRandomValues(new Uint8Array(32)),
    )}`;
    refreshGrants.set(refreshToken, { userId: USER_ID, active: true });
    return refreshToken;
  }

  let issuer = "";

  async function issueAccessToken(organizationId?: string): Promise<string> {
    const nowSeconds = Math.floor(Date.now() / 1_000);
    const header = base64Url(JSON.stringify({ alg: "RS256", kid: KEY_ID, typ: "JWT" }));
    const payload = base64Url(
      JSON.stringify({
        iss: issuer,
        aud: CLIENT_ID,
        sub: USER_ID,
        sid: `session_${randomUuidV7()}`,
        iat: nowSeconds,
        exp: nowSeconds + 3_600,
        email: USER_EMAIL,
        name: USER_NAME,
        ...(organizationId === undefined ? {} : { org_id: organizationId }),
      }),
    );
    const input = new TextEncoder().encode(`${header}.${payload}`);
    const signature = await crypto.subtle.sign(
      "RSASSA-PKCS1-v1_5",
      signingKeys.privateKey,
      ownedArrayBuffer(input),
    );
    return `${header}.${payload}.${base64Url(new Uint8Array(signature))}`;
  }

  async function authenticationResponse(organizationId?: string) {
    const refreshToken = issueRefreshToken();
    return {
      user: workosUser(),
      organization_id: organizationId,
      access_token: await issueAccessToken(organizationId),
      refresh_token: refreshToken,
      authentication_method: "DeviceAuth",
    };
  }

  async function signedMembershipWebhook(args: {
    eventId: string;
    event: "organization_membership.created" | "organization_membership.updated" | "organization_membership.deleted";
    membership: FakeMembership;
    eventCreatedAt: string;
  }): Promise<SignedWorkOSWebhook> {
    const organization = organizations.get(args.membership.organizationId);
    const body = JSON.stringify({
      id: args.eventId,
      event: args.event,
      created_at: args.eventCreatedAt,
      data: workosMembership(
        args.membership,
        organization?.name ?? "Unknown organization",
      ),
    });
    const timestamp = String(Date.now());
    const signature = await hmacSha256Hex(WEBHOOK_SECRET, `${timestamp}.${body}`);
    return { body, signature: `t=${timestamp},v1=${signature}` };
  }

  async function signedOrganizationWebhook(args: {
    eventId: string;
    event: "organization.created" | "organization.updated" | "organization.deleted";
    organization: FakeOrganization;
    eventCreatedAt: string;
  }): Promise<SignedWorkOSWebhook> {
    const body = JSON.stringify({
      id: args.eventId,
      event: args.event,
      created_at: args.eventCreatedAt,
      data: workosOrganization(args.organization),
    });
    const timestamp = String(Date.now());
    const signature = await hmacSha256Hex(WEBHOOK_SECRET, `${timestamp}.${body}`);
    return { body, signature: `t=${timestamp},v1=${signature}` };
  }

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);

      if (request.method === "GET" && url.pathname === `/sso/jwks/${CLIENT_ID}`) {
        return json({ keys: [{ ...publicJwk, alg: "RS256", kid: KEY_ID, use: "sig" }] });
      }

      if (request.method === "POST" && url.pathname === "/user_management/authorize/device") {
        const body = await readBody(request);
        if (body["client_id"] !== CLIENT_ID) {
          return json({ error: "invalid_client", error_description: "Unknown client." }, 400);
        }
        deviceAuthorizationCount += 1;
        const deviceCode = `device_${randomUuidV7()}`;
        deviceCodes.add(deviceCode);
        return json({
          device_code: deviceCode,
          user_code: "TASK-CTRL",
          verification_uri: "https://authkit.local.invalid/verify",
          verification_uri_complete: "https://authkit.local.invalid/verify?user_code=TASK-CTRL",
          expires_in: 600,
          interval: 1,
        });
      }

      if (request.method === "POST" && url.pathname === "/user_management/authenticate") {
        const body = await readBody(request);
        if (body["client_id"] !== CLIENT_ID) {
          return json({ error: "invalid_client", error_description: "Unknown client." }, 400);
        }
        const grantType = body["grant_type"];
        if (grantType === "urn:ietf:params:oauth:grant-type:device_code") {
          const deviceCode = body["device_code"];
          if (typeof deviceCode !== "string" || !deviceCodes.delete(deviceCode)) {
            return json({ error: "expired_token", error_description: "Device code expired." }, 400);
          }
          devicePollCount += 1;
          return json(await authenticationResponse());
        }
        if (grantType === "refresh_token") {
          const refreshToken = body["refresh_token"];
          if (typeof refreshToken !== "string") {
            return json({ error: "invalid_grant", error_description: "Refresh token required." }, 400);
          }
          const grant = refreshGrants.get(refreshToken);
          if (grant === undefined || !grant.active) {
            return json({ error: "invalid_grant", error_description: "Refresh token rejected." }, 400);
          }
          refreshGrants.set(refreshToken, { ...grant, active: false });
          const requestedOrganization = body["organization_id"];
          if (requestedOrganization !== undefined) {
            const authorized = [...memberships.values()].some(
              (membership) =>
                membership.userId === grant.userId &&
                membership.organizationId === requestedOrganization &&
                membership.status === "active",
            );
            if (!authorized) {
              return json({ error: "invalid_grant", error_description: "Organization denied." }, 400);
            }
          }
          refreshCount += 1;
          const responseOrganization =
            nextRefreshOrganizationOverride === undefined
              ? (typeof requestedOrganization === "string" ? requestedOrganization : undefined)
              : (nextRefreshOrganizationOverride ?? undefined);
          nextRefreshOrganizationOverride = undefined;
          return json(
            await authenticationResponse(responseOrganization),
          );
        }
        return json({ error: "unsupported_grant_type" }, 400);
      }

      if (request.method === "GET" && url.pathname === "/user_management/organization_memberships") {
        const userId = url.searchParams.get("user_id");
        const organizationId = url.searchParams.get("organization_id");
        const statuses = new Set((url.searchParams.get("statuses") ?? "active").split(","));
        const data = [...memberships.values()]
          .filter(
            (membership) =>
              (userId === null || membership.userId === userId) &&
              (organizationId === null || membership.organizationId === organizationId) &&
              statuses.has(membership.status),
          )
          .filter((membership) => {
            const remaining = hiddenMembershipListReads.get(membership.id) ?? 0;
            if (remaining <= 0) return true;
            if (remaining === 1) hiddenMembershipListReads.delete(membership.id);
            else hiddenMembershipListReads.set(membership.id, remaining - 1);
            return false;
          })
          .map((membership) => {
            const organization = organizations.get(membership.organizationId);
            return workosMembership(membership, organization?.name ?? "Unknown organization");
          });
        const hook = nextMembershipListAfterSnapshotHook;
        nextMembershipListAfterSnapshotHook = undefined;
        if (hook !== undefined) await hook();
        return json({ data, list_metadata: { before: null, after: null } });
      }

      if (
        request.method === "GET" &&
        url.pathname.startsWith("/user_management/organization_memberships/")
      ) {
        const membershipId = decodeURIComponent(
          url.pathname.slice("/user_management/organization_memberships/".length),
        );
        if (nextMembershipGetPayloads.has(membershipId)) {
          const payload = nextMembershipGetPayloads.get(membershipId);
          nextMembershipGetPayloads.delete(membershipId);
          return json(payload);
        }
        const membership = memberships.get(membershipId);
        if (membership === undefined) {
          return json({ message: "Organization membership not found.", path: url.pathname }, 404);
        }
        const organization = organizations.get(membership.organizationId);
        return json(workosMembership(membership, organization?.name ?? "Unknown organization"));
      }

      if (request.method === "POST" && url.pathname === "/user_management/organization_memberships") {
        const body = await readBody(request);
        const organizationId = body["organization_id"];
        const userId = body["user_id"];
        if (
          typeof organizationId !== "string" ||
          typeof userId !== "string" ||
          !organizations.has(organizationId)
        ) {
          return json({ message: "Unknown organization or user." }, 404);
        }
        const existing = [...memberships.values()].find(
          (membership) =>
            membership.organizationId === organizationId && membership.userId === userId,
        );
        if (existing !== undefined) {
          return json({ message: "Organization membership already exists." }, 409);
        }
        membershipCreateCount += 1;
        membershipSequence += 1;
        const timestamp = new Date().toISOString();
        const membership: FakeMembership = {
          id: `om_${runSuffix}${String(membershipSequence).padStart(8, "0")}`,
          organizationId,
          userId,
          roleSlug:
            typeof body["role_slug"] === "string" ? body["role_slug"] : "admin",
          status: nextCreatedMembershipStatus,
          createdAt: timestamp,
          updatedAt: timestamp,
        };
        memberships.set(membership.id, membership);
        nextCreatedMembershipStatus = "active";
        const organization = organizations.get(organizationId);
        const hiddenReadsAfterFailure = nextMembershipCreateCommitThenFail;
        nextMembershipCreateCommitThenFail = undefined;
        if (hiddenReadsAfterFailure !== undefined) {
          hiddenMembershipListReads.set(membership.id, hiddenReadsAfterFailure);
          return json({ message: "Injected indeterminate membership create." }, 500);
        }
        const webhookTarget = nextCreatedMembershipWebhookTarget;
        nextCreatedMembershipWebhookTarget = undefined;
        if (webhookTarget !== undefined) {
          const webhook = await signedMembershipWebhook({
            eventId: `event_membership_create_hook_${randomUuidV7()}`,
            event: "organization_membership.created",
            membership,
            eventCreatedAt: membership.updatedAt,
          });
          const webhookResponse = await fetch(webhookTarget, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "WorkOS-Signature": webhook.signature,
            },
            body: webhook.body,
          });
          if (!webhookResponse.ok) {
            return json({ message: "Injected WorkOS webhook was rejected." }, 502);
          }
        }
        return json(workosMembership(membership, organization?.name ?? "Unknown organization"));
      }

      if (request.method === "GET" && url.pathname.startsWith("/organizations/external_id/")) {
        const externalId = decodeURIComponent(url.pathname.slice("/organizations/external_id/".length));
        const organization = organizationsByExternalId.get(externalId);
        return organization === undefined
          ? json({ message: "Organization not found.", path: url.pathname }, 404)
          : json(workosOrganization(organization));
      }

      if (request.method === "GET" && url.pathname.startsWith("/organizations/")) {
        const organization = organizations.get(decodeURIComponent(url.pathname.slice("/organizations/".length)));
        return organization === undefined
          ? json({ message: "Organization not found.", path: url.pathname }, 404)
          : json(workosOrganization(organization));
      }

      if (request.method === "POST" && url.pathname === "/organizations") {
        const body = await readBody(request);
        const name = body["name"];
        const externalId = body["external_id"];
        if (typeof name !== "string" || typeof externalId !== "string") {
          return json({ message: "Organization name and external ID are required." }, 400);
        }
        const existing = organizationsByExternalId.get(externalId);
        if (existing !== undefined) return json(workosOrganization(existing));
        organizationSequence += 1;
        const timestamp = new Date().toISOString();
        const organization: FakeOrganization = {
          id: `org_${runSuffix}${String(organizationSequence).padStart(8, "0")}`,
          name,
          externalId,
          createdAt: timestamp,
          updatedAt: timestamp,
        };
        organizations.set(organization.id, organization);
        organizationsByExternalId.set(externalId, organization);
        return json(workosOrganization(organization));
      }

      return json({ message: "Unhandled fake WorkOS route.", path: url.pathname }, 404);
    },
  });

  issuer = `http://127.0.0.1:${server.port}/user_management/${CLIENT_ID}`;
  const origin = `http://127.0.0.1:${server.port}`;

  return {
    origin,
    issuer,
    jwksUrl: `${origin}/sso/jwks/${CLIENT_ID}`,
    clientId: CLIENT_ID,
    apiKey: API_KEY,
    webhookSecret: WEBHOOK_SECRET,
    userId: USER_ID,
    initialRefreshToken,
    issueAccessToken,
    issueRefreshToken,
    organizations: () => [...organizations.values()].map((organization) => ({ ...organization })),
    memberships: () => [...memberships.values()].map(copyMembership),
    setMembership: (args) => {
      const existing = memberships.get(args.membershipId);
      if (existing === undefined) throw new Error("Unknown fake WorkOS membership.");
      const updated: FakeMembership = {
        ...existing,
        ...(args.status === undefined ? {} : { status: args.status }),
        ...(args.roleSlug === undefined ? {} : { roleSlug: args.roleSlug }),
        updatedAt: args.updatedAt ?? new Date().toISOString(),
      };
      memberships.set(updated.id, updated);
      return copyMembership(updated);
    },
    createMembership: (args) => {
      if (!organizations.has(args.organizationId)) {
        throw new Error("Unknown fake WorkOS organization.");
      }
      membershipSequence += 1;
      const timestamp = args.updatedAt ?? new Date().toISOString();
      const membership: FakeMembership = {
        id: `om_${runSuffix}${String(membershipSequence).padStart(8, "0")}`,
        organizationId: args.organizationId,
        userId: args.userId,
        roleSlug: args.roleSlug,
        status: args.status ?? "active",
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      memberships.set(membership.id, membership);
      return copyMembership(membership);
    },
    restoreMembership: (membership) => {
      memberships.set(membership.id, copyMembership(membership));
    },
    deleteMembership: (membershipId) => {
      const membership = memberships.get(membershipId);
      memberships.delete(membershipId);
      return membership === undefined ? null : copyMembership(membership);
    },
    restoreOrganization: (organization) => {
      const restored = { ...organization };
      organizations.set(restored.id, restored);
      organizationsByExternalId.set(restored.externalId, restored);
    },
    deleteOrganization: (organizationId) => {
      const organization = organizations.get(organizationId);
      organizations.delete(organizationId);
      if (organization !== undefined) organizationsByExternalId.delete(organization.externalId);
      return organization === undefined ? null : { ...organization };
    },
    setNextCreatedMembershipStatus: (status) => {
      nextCreatedMembershipStatus = status;
    },
    setNextMembershipListAfterSnapshotHook: (hook) => {
      nextMembershipListAfterSnapshotHook = hook;
    },
    setNextCreatedMembershipWebhookTarget: (target) => {
      nextCreatedMembershipWebhookTarget = target;
    },
    setNextMembershipCreateCommitThenFail: (hiddenListReads) => {
      if (!Number.isSafeInteger(hiddenListReads) || hiddenListReads < 1) {
        throw new Error("Hidden membership list reads must be a positive integer.");
      }
      nextMembershipCreateCommitThenFail = hiddenListReads;
    },
    setNextMembershipGetPayload: (membershipId, payload) => {
      nextMembershipGetPayloads.set(membershipId, payload);
    },
    setNextRefreshOrganizationOverride: (organizationId) => {
      nextRefreshOrganizationOverride = organizationId;
    },
    signMembershipWebhook: signedMembershipWebhook,
    signOrganizationWebhook: signedOrganizationWebhook,
    snapshot: () => ({
      organizationCount: organizations.size,
      membershipCount: memberships.size,
      membershipCreateCount,
      refreshCount,
      deviceAuthorizationCount,
      devicePollCount,
    }),
    stop: () => {
      void server.stop(true);
    },
  };
}
