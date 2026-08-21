import { describe, expect, test } from "bun:test";

import type { Id } from "./_generated/dataModel";
import type { QueryCtx } from "./_generated/server";
import { authorizeWorkspaceHuman } from "./humanAuthorization";

const USER_ID = "k1700000000000000000000001" as Id<"users">;
const SESSION_ID = "k2700000000000000000000001" as Id<"authSessions">;
const ORGANIZATION_ID = "k3700000000000000000000001" as Id<"organizations">;
const SELECTED_WORKSPACE_ID = "k4700000000000000000000001" as Id<"workspaces">;
const OTHER_WORKSPACE_ID = "k4700000000000000000000002" as Id<"workspaces">;

type OrganizationRole = "owner" | "admin" | "member";

function indexBuilder() {
  const builder = { eq: () => builder };
  return builder;
}

function context(args: {
  role: OrganizationRole;
  selectedWorkspaceId?: Id<"workspaces">;
  organizationMembershipStatus?: "active" | "inactive";
  workspaceMembershipStatus?: "active" | "removed";
  expiredSession?: boolean;
}) {
  const now = Date.now();
  const user = {
    _id: USER_ID,
    _creationTime: 1,
    publicId: "usr_00000000000000000000000001",
    name: "Selected human",
    email: "selected@example.com",
    status: "active" as const,
    createdAt: 1,
    updatedAt: 1,
  };
  const session = {
    _id: SESSION_ID,
    _creationTime: 2,
    userId: USER_ID,
    expirationTime: args.expiredSession === true ? now - 1 : now + 60_000,
  };
  const organization = {
    _id: ORGANIZATION_ID,
    _creationTime: 3,
    publicId: "org_00000000000000000000000001",
    name: "Selected tenant",
    status: "active" as const,
    createdAt: 1,
    updatedAt: 1,
  };
  const selection = {
    _id: "k5700000000000000000000001",
    _creationTime: 4,
    sessionId: SESSION_ID,
    userId: USER_ID,
    organizationId: ORGANIZATION_ID,
    ...(args.selectedWorkspaceId === undefined
      ? {}
      : { workspaceId: args.selectedWorkspaceId }),
    createdAt: 1,
    updatedAt: 1,
  };
  const organizationMembership = {
    _id: "k6700000000000000000000001",
    _creationTime: 5,
    organizationId: ORGANIZATION_ID,
    userId: USER_ID,
    role: args.role,
    status: args.organizationMembershipStatus ?? "active",
    createdAt: 1,
    updatedAt: 1,
  };
  const selectedWorkspace = {
    _id: SELECTED_WORKSPACE_ID,
    _creationTime: 6,
    organizationId: ORGANIZATION_ID,
    publicId: "wsp_00000000000000000000000001",
    slug: "selected",
    name: "Selected workspace",
    taskKeyPrefix: "SEL",
    status: "active" as const,
    createdAt: 1,
    updatedAt: 1,
  };
  const otherWorkspace = {
    ...selectedWorkspace,
    _id: OTHER_WORKSPACE_ID,
    publicId: "wsp_00000000000000000000000002",
    slug: "other",
    name: "Other workspace",
    taskKeyPrefix: "OTH",
  };
  const workspaceMembership = {
    _id: "k7700000000000000000000001",
    _creationTime: 7,
    organizationId: ORGANIZATION_ID,
    workspaceId: SELECTED_WORKSPACE_ID,
    userId: USER_ID,
    roles: ["viewer" as const],
    status: args.workspaceMembershipStatus ?? "active",
    createdAt: 1,
    updatedAt: 1,
  };
  const db = {
    get: async (id: string) => {
      if (id === USER_ID) return user;
      if (id === SESSION_ID) return session;
      if (id === ORGANIZATION_ID) return organization;
      if (id === SELECTED_WORKSPACE_ID) return selectedWorkspace;
      if (id === OTHER_WORKSPACE_ID) return otherWorkspace;
      return null;
    },
    query: (table: string) => {
      let selectedWorkspacePublicId = "";
      const chain = {
        withIndex: (
          _index: string,
          range?: (builder: ReturnType<typeof indexBuilder>) => unknown,
        ) => {
          const builder = indexBuilder();
          const originalEq = builder.eq;
          builder.eq = (field?: string, value?: string) => {
            if (field === "publicId" && typeof value === "string") {
              selectedWorkspacePublicId = value;
            }
            return originalEq();
          };
          range?.(builder);
          return chain;
        },
        unique: async () => {
          if (table === "authSessionSelections") return selection;
          if (table === "organizationMemberships") return organizationMembership;
          if (table === "workspaceMemberships") return workspaceMembership;
          if (table === "workspaces") {
            if (selectedWorkspacePublicId === selectedWorkspace.publicId) {
              return selectedWorkspace;
            }
            if (selectedWorkspacePublicId === otherWorkspace.publicId) return otherWorkspace;
          }
          return null;
        },
      };
      return chain;
    },
  };
  return {
    auth: {
      getUserIdentity: async () => ({
        issuer: "https://convex.test",
        subject: `${USER_ID}|${SESSION_ID}`,
        tokenIdentifier: `https://convex.test|${USER_ID}|${SESSION_ID}`,
      }),
    },
    db,
  } as unknown as QueryCtx;
}

describe("Convex Auth workspace authorization", () => {
  test.each(["owner", "admin", "member"] as const)(
    "authorizes the exact selected workspace for an active %s",
    async (role) => {
      const result = await authorizeWorkspaceHuman(context({
        role,
        selectedWorkspaceId: SELECTED_WORKSPACE_ID,
      }), {
        requestId: "req_exact_selected_workspace",
        workspacePublicId: "wsp_00000000000000000000000001",
      });
      expect(result.ok).toBeTrue();
      if (result.ok) expect(result.authorization.workspace._id).toBe(SELECTED_WORKSPACE_ID);
    },
  );

  test.each(["owner", "admin", "member"] as const)(
    "denies an accessible but unselected workspace for an active %s",
    async (role) => {
      const result = await authorizeWorkspaceHuman(context({
        role,
        selectedWorkspaceId: SELECTED_WORKSPACE_ID,
      }), {
        requestId: "req_unselected_workspace",
        workspacePublicId: "wsp_00000000000000000000000002",
      });
      expect(result).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
    },
  );

  test("makes an organization-only session unable to call workspace routes", async () => {
    const result = await authorizeWorkspaceHuman(context({ role: "owner" }), {
      requestId: "req_organization_only",
      workspacePublicId: "wsp_00000000000000000000000001",
    });
    expect(result).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
  });

  test("reloads both membership layers and session expiry", async () => {
    const inactiveOrganization = await authorizeWorkspaceHuman(context({
      role: "owner",
      selectedWorkspaceId: SELECTED_WORKSPACE_ID,
      organizationMembershipStatus: "inactive",
    }), {
      requestId: "req_inactive_organization",
      workspacePublicId: "wsp_00000000000000000000000001",
    });
    expect(inactiveOrganization).toMatchObject({
      ok: false,
      error: { code: "MEMBERSHIP_INACTIVE" },
    });

    const inactiveWorkspace = await authorizeWorkspaceHuman(context({
      role: "member",
      selectedWorkspaceId: SELECTED_WORKSPACE_ID,
      workspaceMembershipStatus: "removed",
    }), {
      requestId: "req_inactive_workspace",
      workspacePublicId: "wsp_00000000000000000000000001",
    });
    expect(inactiveWorkspace).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });

    const expired = await authorizeWorkspaceHuman(context({
      role: "owner",
      selectedWorkspaceId: SELECTED_WORKSPACE_ID,
      expiredSession: true,
    }), {
      requestId: "req_expired_session",
      workspacePublicId: "wsp_00000000000000000000000001",
    });
    expect(expired).toMatchObject({
      ok: false,
      error: { code: "AUTHENTICATION_FAILED" },
    });
  });
});
