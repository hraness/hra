import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import type { QueryCtx } from "./_generated/server";
import { listWorkspacesForHuman } from "./humanAdmin";

type OrganizationRole = "owner" | "admin" | "member";

const originalWorkOSClientId = process.env.WORKOS_CLIENT_ID;
const workosClientId = "client_human_admin_pagination";
const userId = "user_humanadminpagination";
const workosOrganizationId = "org_humanadminpagination";

function indexBuilder() {
  const builder = {
    eq: () => builder,
  };
  return builder;
}

function createContext(role: OrganizationRole) {
  const sources: Array<{ index: string; table: string }> = [];
  const organization = {
    _creationTime: 1,
    _id: "organization_document",
    createdAt: 1,
    name: "Current organization",
    publicId: "org_public_current",
    status: "active",
    updatedAt: 1,
    workosOrganizationId,
  };
  const user = {
    _creationTime: 1,
    _id: "user_document",
    createdAt: 1,
    name: "Current human",
    publicId: userId,
    status: "active",
    updatedAt: 1,
    workosUserId: userId,
  };
  const organizationMembership = {
    _creationTime: 1,
    _id: "organization_membership_document",
    createdAt: 1,
    organizationId: organization._id,
    role,
    status: "active",
    updatedAt: 1,
    userId: user._id,
  };
  const visibleWorkspace = {
    _creationTime: 1,
    _id: "visible_workspace_document",
    createdAt: 1,
    name: "Visible workspace",
    organizationId: organization._id,
    publicId: "wsp_visible",
    slug: "visible",
    status: "active",
    taskKeyPrefix: "VIS",
    updatedAt: 1,
  };
  const activeWorkspaceMembership = {
    _creationTime: 1,
    _id: "visible_workspace_membership",
    createdAt: 1,
    organizationId: organization._id,
    roles: ["viewer"],
    status: "active",
    updatedAt: 1,
    userId: user._id,
    workspaceId: visibleWorkspace._id,
  };

  const db = {
    get: async (id: string) => (id === visibleWorkspace._id ? visibleWorkspace : null),
    query: (table: string) => {
      let selectedIndex = "";
      const chain = {
        paginate: async () => ({
          continueCursor: table === "workspaceMemberships" ? "member-next" : "admin-next",
          isDone: false,
          page:
            table === "workspaceMemberships"
              ? [activeWorkspaceMembership]
              : table === "workspaces"
                ? [visibleWorkspace]
                : [],
        }),
        unique: async () => {
          if (table === "users") return user;
          if (table === "organizations") return organization;
          if (table === "organizationMemberships") return organizationMembership;
          return null;
        },
        withIndex: (
          index: string,
          range?: (builder: ReturnType<typeof indexBuilder>) => unknown,
        ) => {
          selectedIndex = index;
          sources.push({ index: selectedIndex, table });
          range?.(indexBuilder());
          return chain;
        },
      };
      return chain;
    },
  };

  const ctx = {
    auth: {
      getUserIdentity: async () => ({
        issuer: `https://api.workos.com/user_management/${workosClientId}`,
        name: user.name,
        org_id: workosOrganizationId,
        sid: "session_human_admin_pagination",
        subject: userId,
        tokenIdentifier: `${workosClientId}|${userId}`,
      }),
    },
    db,
  } as unknown as QueryCtx;

  return { ctx, sources };
}

beforeEach(() => {
  process.env.WORKOS_CLIENT_ID = workosClientId;
});

afterEach(() => {
  if (originalWorkOSClientId === undefined) delete process.env.WORKOS_CLIENT_ID;
  else process.env.WORKOS_CLIENT_ID = originalWorkOSClientId;
});

describe("human admin workspace pagination", () => {
  test("paginates a member's active assignments inside the current organization", async () => {
    const { ctx, sources } = createContext("member");
    const result = await listWorkspacesForHuman(ctx, {
      cursor: "member-start",
      limit: 100,
    });

    expect(result).toEqual({
      data: {
        cursor: "member-next",
        workspaces: [
          {
            id: "wsp_visible",
            name: "Visible workspace",
            organizationId: "org_public_current",
            roles: ["viewer"],
            slug: "visible",
            taskKeyPrefix: "VIS",
          },
        ],
      },
      ok: true,
      requestId: "req_00000000000000000000000000",
    });
    expect(sources).toContainEqual({
      index: "by_user_organization_status_and_workspace",
      table: "workspaceMemberships",
    });
    expect(sources.some(({ table }) => table === "workspaces")).toBeFalse();
  });

  test.each(["owner", "admin"] as const)(
    "keeps the organization workspace stream for an %s",
    async (role) => {
      const { ctx, sources } = createContext(role);
      const result = await listWorkspacesForHuman(ctx, { limit: 100 });

      expect(result.ok).toBeTrue();
      expect(sources).toContainEqual({
        index: "by_organization_status_and_public_id",
        table: "workspaces",
      });
      expect(sources.some(({ table }) => table === "workspaceMemberships")).toBeFalse();
    },
  );
});
