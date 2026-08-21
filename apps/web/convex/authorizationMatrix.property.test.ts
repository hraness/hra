import { describe, expect, test } from "bun:test";
import {
  agentScopeValues,
  type AgentScope,
  type OrganizationRole,
  type WorkspaceRole,
} from "@hraness/agent-tasks-protocol";
import { assertAsyncProperty, fc } from "@hra-internal/test";

import type { Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import { authorizeAgent } from "./authorization";
import { authorizeWorkspaceHuman } from "./humanAuthorization";

const now = 1_000_000;
const requestId = "req_00000000000000000000000000";
const currentOrganizationId = "organization_current" as Id<"organizations">;
const foreignOrganizationId = "organization_foreign" as Id<"organizations">;
const currentWorkspaceId = "workspace_current" as Id<"workspaces">;
const foreignWorkspaceId = "workspace_foreign" as Id<"workspaces">;
const currentUserId = "user_current" as Id<"users">;
const currentHumanSessionId = "human_session_current" as Id<"authSessions">;
const currentMembershipId = "membership_current" as Id<"organizationMemberships">;
const currentWorkspaceMembershipId =
  "workspace_membership_current" as Id<"workspaceMemberships">;
const currentAgentId = "agent_current" as Id<"agents">;
const foreignAgentId = "agent_foreign" as Id<"agents">;
const currentGrantId = "grant_current" as Id<"agentWorkspaceGrants">;
const currentCredentialId = "credential_current" as Id<"agentCredentials">;
const foreignCredentialId = "credential_foreign" as Id<"agentCredentials">;
const currentSessionId = "session_current" as Id<"agentSessions">;

type OrganizationStatus = "active" | "disabled";
type WorkspaceStatus = "active" | "disabled";
type MembershipStatus = "active" | "inactive" | "pending" | "removed";
type WorkspaceMembershipStatus = "active" | "removed";
type AgentStatus = "active" | "disabled";
type GrantStatus = "active" | "revoked";
type CredentialStatus = "active" | "revoked";
type SessionStatus = "active" | "expired" | "revoked";
type SessionBinding =
  | "matching"
  | "credential"
  | "organization"
  | "workspace"
  | "agent";
type DurableAgentTuple =
  | "matching"
  | "agent_organization"
  | "workspace_organization"
  | "grant_organization"
  | "grant_workspace"
  | "grant_agent";
type HumanOrganizationSelector = "matching" | "missing" | "foreign";
type HumanWorkspaceSelector = "matching" | "missing" | "foreign";

interface AgentMatrix {
  readonly agentPresent: boolean;
  readonly credentialPresent: boolean;
  readonly credentialStatus: CredentialStatus;
  readonly credentialFresh: boolean;
  readonly grantPresent: boolean;
  readonly sessionPresent: boolean;
  readonly sessionStatus: SessionStatus;
  readonly sessionFresh: boolean;
  readonly sessionBinding: SessionBinding;
  readonly organizationPresent: boolean;
  readonly organizationStatus: OrganizationStatus;
  readonly workspacePresent: boolean;
  readonly workspaceStatus: WorkspaceStatus;
  readonly agentStatus: AgentStatus;
  readonly grantStatus: GrantStatus;
  readonly durableTuple: DurableAgentTuple;
  readonly credentialScopes: AgentScope[];
  readonly grantScopes: AgentScope[];
  readonly requiredScope: AgentScope;
}

interface HumanMatrix {
  readonly organizationSelector: HumanOrganizationSelector;
  readonly organizationStatus: OrganizationStatus;
  readonly userPresent: boolean;
  readonly userActive: boolean;
  readonly membershipPresent: boolean;
  readonly membershipStatus: MembershipStatus;
  readonly organizationRole: OrganizationRole;
  readonly requireOrganizationAdmin: boolean;
  readonly workspaceSelector: HumanWorkspaceSelector;
  readonly workspaceStatus: WorkspaceStatus;
  readonly workspaceMembershipPresent: boolean;
  readonly workspaceMembershipStatus: WorkspaceMembershipStatus;
  readonly workspaceRoles: WorkspaceRole[];
}

type AuthorizationExpectation =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly code:
        | "AUTHENTICATION_FAILED"
        | "SESSION_INVALID"
        | "AUTHORIZATION_DENIED"
        | "SCOPE_REQUIRED";
    };

type HumanAuthorizationExpectation =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly code:
        | "AUTHENTICATION_FAILED"
        | "ORGANIZATION_REQUIRED"
        | "MEMBERSHIP_INACTIVE"
        | "WORKSPACE_ROLE_REQUIRED"
        | "NOT_FOUND";
    };

interface InstrumentedContext {
  readonly assertReadsExhausted: () => void;
  readonly ctx: MutationCtx;
  readonly writes: string[];
}

interface GetFixture {
  readonly id: string;
  readonly result: unknown;
  readonly times?: number;
}

interface IndexClause {
  readonly field: string;
  readonly value: unknown;
}

interface UniqueQueryFixture {
  readonly table: string;
  readonly index: string;
  readonly clauses: readonly IndexClause[];
  readonly result: unknown;
}

function getFixtureKey(id: string): string {
  return JSON.stringify(["get", id]);
}

function queryFixtureKey(fixture: Omit<UniqueQueryFixture, "result">): string {
  return JSON.stringify([
    "query",
    fixture.table,
    fixture.index,
    fixture.clauses.map(({ field, value }) => [field, value]),
  ]);
}

interface FixtureState {
  readonly result: unknown;
  remaining: number;
}

function fixtureMap<Fixture extends { readonly result: unknown; readonly times?: number }>(
  fixtures: readonly Fixture[],
  keyOf: (fixture: Fixture) => string,
): Map<string, FixtureState> {
  const entries = new Map<string, FixtureState>();
  for (const fixture of fixtures) {
    const key = keyOf(fixture);
    if (entries.has(key)) throw new Error(`Duplicate authorization fixture: ${key}`);
    entries.set(key, { result: fixture.result, remaining: fixture.times ?? 1 });
  }
  return entries;
}

/**
 * Provides only the exact reads used by an authorization scenario. A selector,
 * index, equality clause, repeated read, or control-flow change outside those
 * fixtures fails the law instead of receiving a convenient table-wide result.
 * Any future write added to an authorization path is captured separately.
 */
function instrumentedContext(args: {
  readonly getFixtures?: readonly GetFixture[];
  readonly identity?: unknown;
  readonly queryFixtures?: readonly UniqueQueryFixture[];
}): InstrumentedContext {
  const writes: string[] = [];
  const gets = fixtureMap(args.getFixtures ?? [], ({ id }) => getFixtureKey(id));
  const queries = fixtureMap(args.queryFixtures ?? [], queryFixtureKey);

  const consume = (fixtures: Map<string, FixtureState>, key: string): unknown => {
    const state = fixtures.get(key);
    if (state === undefined) throw new Error(`Unexpected authorization read: ${key}`);
    state.remaining -= 1;
    if (state.remaining === 0) fixtures.delete(key);
    return state.result;
  };
  const write = async (operation: string): Promise<string> => {
    writes.push(operation);
    return "unexpected_write";
  };
  const db = {
    delete: async () => await write("delete"),
    get: async (id: string) => consume(gets, getFixtureKey(id)),
    insert: async () => await write("insert"),
    patch: async () => await write("patch"),
    query: (table: string) => {
      let index: string | null = null;
      const clauses: IndexClause[] = [];
      const chain = {
        unique: async () => {
          if (index === null) {
            throw new Error(`Authorization query on ${table} omitted its required index.`);
          }
          return consume(
            queries,
            queryFixtureKey({ clauses, index, table }),
          );
        },
        withIndex: (
          selectedIndex: string,
          range?: (builder: {
            readonly eq: (field: string, value: unknown) => unknown;
          }) => unknown,
        ) => {
          if (index !== null) {
            throw new Error(`Authorization query on ${table} selected multiple indexes.`);
          }
          index = selectedIndex;
          const builder = {
            eq: (field: string, value: unknown) => {
              clauses.push({ field, value });
              return builder;
            },
          };
          range?.(builder);
          return chain;
        },
      };
      return chain;
    },
    replace: async () => await write("replace"),
  };
  return {
    assertReadsExhausted: () => {
      const missing = [...gets.keys(), ...queries.keys()];
      if (missing.length > 0) {
        throw new Error(`Missing authorization reads: ${missing.join(", ")}`);
      }
    },
    ctx: {
      auth: { getUserIdentity: async () => args.identity ?? null },
      db,
    } as unknown as MutationCtx,
    writes,
  };
}

const scopeArrayArbitrary = fc.uniqueArray(fc.constantFrom(...agentScopeValues), {
  maxLength: agentScopeValues.length,
});

const organizationRoleArbitrary = fc.constantFrom<OrganizationRole>(
  "owner",
  "admin",
  "member",
);

const workspaceRolesArbitrary = fc.uniqueArray(
  fc.constantFrom<WorkspaceRole>("planner", "reviewer", "viewer"),
  { maxLength: 3 },
);

function includeRequiredScope(
  scopes: readonly AgentScope[],
  requiredScope: AgentScope,
): AgentScope[] {
  return [requiredScope, ...scopes.filter((scope) => scope !== requiredScope)];
}

function validAgentMatrix(args: {
  readonly credentialScopes: readonly AgentScope[];
  readonly grantScopes: readonly AgentScope[];
  readonly requiredScope: AgentScope;
}): AgentMatrix {
  return {
    agentPresent: true,
    agentStatus: "active",
    credentialFresh: true,
    credentialPresent: true,
    credentialScopes: includeRequiredScope(args.credentialScopes, args.requiredScope),
    credentialStatus: "active",
    durableTuple: "matching",
    grantPresent: true,
    grantScopes: includeRequiredScope(args.grantScopes, args.requiredScope),
    grantStatus: "active",
    organizationPresent: true,
    organizationStatus: "active",
    requiredScope: args.requiredScope,
    sessionBinding: "matching",
    sessionFresh: true,
    sessionPresent: true,
    sessionStatus: "active",
    workspacePresent: true,
    workspaceStatus: "active",
  };
}

function validHumanMatrix(args: {
  readonly organizationRole: OrganizationRole;
  readonly requireOrganizationAdmin?: boolean;
  readonly workspaceRoles: readonly WorkspaceRole[];
}): HumanMatrix {
  return {
    membershipPresent: true,
    membershipStatus: "active",
    organizationRole: args.organizationRole,
    organizationSelector: "matching",
    organizationStatus: "active",
    requireOrganizationAdmin: args.requireOrganizationAdmin === true,
    userActive: true,
    userPresent: true,
    workspaceMembershipPresent: true,
    workspaceMembershipStatus: "active",
    workspaceRoles: [...args.workspaceRoles],
    workspaceSelector: "matching",
    workspaceStatus: "active",
  };
}

function expectedAgentAuthorization(matrix: AgentMatrix): AuthorizationExpectation {
  if (
    !matrix.credentialPresent ||
    matrix.credentialStatus !== "active" ||
    !matrix.credentialFresh
  ) {
    return { ok: false, code: "AUTHENTICATION_FAILED" };
  }
  if (
    !matrix.sessionPresent ||
    matrix.sessionStatus !== "active" ||
    !matrix.sessionFresh ||
    matrix.sessionBinding !== "matching"
  ) {
    return { ok: false, code: "SESSION_INVALID" };
  }
  if (
    !matrix.agentPresent ||
    !matrix.grantPresent ||
    !matrix.workspacePresent ||
    !matrix.organizationPresent ||
    matrix.organizationStatus !== "active" ||
    matrix.workspaceStatus !== "active" ||
    matrix.agentStatus !== "active" ||
    matrix.grantStatus !== "active" ||
    matrix.durableTuple !== "matching"
  ) {
    return { ok: false, code: "AUTHORIZATION_DENIED" };
  }
  if (
    !matrix.credentialScopes.includes(matrix.requiredScope) ||
    !matrix.grantScopes.includes(matrix.requiredScope)
  ) {
    return { ok: false, code: "SCOPE_REQUIRED" };
  }
  return { ok: true };
}

function expectedHumanAuthorization(matrix: HumanMatrix): HumanAuthorizationExpectation {
  if (!matrix.userPresent || !matrix.userActive) {
    return { ok: false, code: "AUTHENTICATION_FAILED" };
  }
  if (matrix.organizationSelector === "missing") {
    return { ok: false, code: "ORGANIZATION_REQUIRED" };
  }
  if (
    matrix.organizationSelector !== "matching" ||
    matrix.organizationStatus !== "active" ||
    !matrix.membershipPresent ||
    matrix.membershipStatus !== "active"
  ) {
    return { ok: false, code: "MEMBERSHIP_INACTIVE" };
  }
  if (matrix.requireOrganizationAdmin && matrix.organizationRole === "member") {
    return { ok: false, code: "WORKSPACE_ROLE_REQUIRED" };
  }
  if (matrix.workspaceSelector !== "matching" || matrix.workspaceStatus !== "active") {
    return { ok: false, code: "NOT_FOUND" };
  }
  if (
    matrix.organizationRole === "member" &&
    (!matrix.workspaceMembershipPresent || matrix.workspaceMembershipStatus !== "active")
  ) {
    return { ok: false, code: "NOT_FOUND" };
  }
  return { ok: true };
}

function agentContext(
  matrix: AgentMatrix,
  sessionPublicId = "ses_current",
): InstrumentedContext {
  const agentOrganizationId =
    matrix.durableTuple === "agent_organization"
      ? foreignOrganizationId
      : currentOrganizationId;
  const workspaceOrganizationId =
    matrix.durableTuple === "workspace_organization"
      ? foreignOrganizationId
      : currentOrganizationId;
  const grantOrganizationId =
    matrix.durableTuple === "grant_organization"
      ? foreignOrganizationId
      : currentOrganizationId;
  const grantWorkspaceId =
    matrix.durableTuple === "grant_workspace" ? foreignWorkspaceId : currentWorkspaceId;
  const grantAgentId =
    matrix.durableTuple === "grant_agent" ? foreignAgentId : currentAgentId;

  const credential = {
    _id: currentCredentialId,
    agentId: currentAgentId,
    grantId: currentGrantId,
    locator: "cred_current",
    organizationId: currentOrganizationId,
    scopes: matrix.credentialScopes,
    status: matrix.credentialStatus,
    workspaceId: currentWorkspaceId,
    expiresAt: matrix.credentialFresh ? now + 1 : now,
  };
  const session = {
    _id: currentSessionId,
    agentId:
      matrix.sessionBinding === "agent" ? foreignAgentId : currentAgentId,
    credentialId:
      matrix.sessionBinding === "credential" ? foreignCredentialId : currentCredentialId,
    idleExpiresAt: matrix.sessionFresh ? now + 1 : now,
    organizationId:
      matrix.sessionBinding === "organization"
        ? foreignOrganizationId
        : currentOrganizationId,
    publicId: sessionPublicId,
    status: matrix.sessionStatus,
    workspaceId:
      matrix.sessionBinding === "workspace" ? foreignWorkspaceId : currentWorkspaceId,
  };
  const agent = {
    _id: currentAgentId,
    name: "Current agent",
    organizationId: agentOrganizationId,
    publicId: "agt_current",
    status: matrix.agentStatus,
  };
  const grant = {
    _id: currentGrantId,
    agentId: grantAgentId,
    organizationId: grantOrganizationId,
    scopes: matrix.grantScopes,
    status: matrix.grantStatus,
    workspaceId: grantWorkspaceId,
  };
  const workspace = {
    _id: currentWorkspaceId,
    name: "Current workspace",
    organizationId: workspaceOrganizationId,
    publicId: "wsp_current",
    slug: "current",
    status: matrix.workspaceStatus,
  };
  const organization = {
    _id: currentOrganizationId,
    name: "Current organization",
    publicId: "org_current",
    status: matrix.organizationStatus,
  };
  const credentialIsLive =
    matrix.credentialPresent &&
    matrix.credentialStatus === "active" &&
    matrix.credentialFresh;
  const sessionIsLive =
    credentialIsLive &&
    matrix.sessionPresent &&
    matrix.sessionStatus === "active" &&
    matrix.sessionFresh &&
    matrix.sessionBinding === "matching";
  const getFixtures: GetFixture[] = [
    {
      id: currentCredentialId,
      result: matrix.credentialPresent ? credential : null,
    },
    ...(sessionIsLive
      ? [
          { id: currentAgentId, result: matrix.agentPresent ? agent : null },
          { id: currentGrantId, result: matrix.grantPresent ? grant : null },
          {
            id: currentWorkspaceId,
            result: matrix.workspacePresent ? workspace : null,
          },
          {
            id: currentOrganizationId,
            result: matrix.organizationPresent ? organization : null,
          },
        ]
      : []),
  ];
  return instrumentedContext({
    getFixtures,
    queryFixtures: credentialIsLive
      ? [
          {
            clauses: [{ field: "publicId", value: sessionPublicId }],
            index: "by_public_id",
            result: matrix.sessionPresent ? session : null,
            table: "agentSessions",
          },
        ]
      : [],
  });
}

function humanIdentity() {
  return {
    issuer: "https://convex.test",
    subject: `${currentUserId}|${currentHumanSessionId}`,
    tokenIdentifier:
      `https://convex.test|${currentUserId}|${currentHumanSessionId}`,
  };
}

function humanContext(
  matrix: HumanMatrix,
  workspacePublicId = "wsp_selected",
): InstrumentedContext {
  const selectedOrganizationId = matrix.organizationSelector === "foreign"
    ? foreignOrganizationId
    : currentOrganizationId;
  const selectedWorkspaceId = matrix.workspaceSelector === "foreign"
    ? foreignWorkspaceId
    : currentWorkspaceId;
  const organization = {
    _id: currentOrganizationId,
    name: "Current organization",
    publicId: "org_current",
    status: matrix.organizationStatus,
    createdAt: 1,
    updatedAt: 1,
  };
  const user = {
    _id: currentUserId,
    name: "Current human",
    publicId: "usr_authorizationmatrix",
    status: matrix.userActive ? "active" : "disabled",
    createdAt: 1,
    updatedAt: 1,
  };
  const session = {
    _id: currentHumanSessionId,
    userId: currentUserId,
    expirationTime: Date.now() + 60_000,
  };
  const selection = {
    _id: "selection_current",
    sessionId: currentHumanSessionId,
    userId: currentUserId,
    organizationId: selectedOrganizationId,
    workspaceId: selectedWorkspaceId,
    createdAt: 1,
    updatedAt: 1,
  };
  const membership = {
    _id: currentMembershipId,
    organizationId: currentOrganizationId,
    role: matrix.organizationRole,
    status: matrix.membershipStatus,
    userId: currentUserId,
  };
  const workspace = {
    _id: selectedWorkspaceId,
    name: "Selected workspace",
    organizationId:
      matrix.workspaceSelector === "foreign"
        ? foreignOrganizationId
        : currentOrganizationId,
    publicId: workspacePublicId,
    slug: "selected",
    status: matrix.workspaceStatus,
  };
  const workspaceMembership = {
    _id: currentWorkspaceMembershipId,
    organizationId: currentOrganizationId,
    roles: matrix.workspaceRoles,
    status: matrix.workspaceMembershipStatus,
    userId: currentUserId,
    workspaceId: currentWorkspaceId,
  };
  const organizationGatePasses =
    matrix.organizationSelector === "matching" &&
    matrix.organizationStatus === "active" &&
    matrix.userPresent &&
    matrix.userActive;
  const membershipGatePasses =
    organizationGatePasses &&
    matrix.membershipPresent &&
    matrix.membershipStatus === "active";
  const roleGatePasses =
    membershipGatePasses &&
    !(matrix.requireOrganizationAdmin && matrix.organizationRole === "member");
  const workspaceGatePasses =
    roleGatePasses &&
    matrix.workspaceSelector === "matching" &&
    matrix.workspaceStatus === "active";
  const identityGatePasses = matrix.userPresent && matrix.userActive;
  const selectionPresent = matrix.organizationSelector !== "missing";
  const organizationReadRuns = identityGatePasses && selectionPresent;
  const getFixtures: GetFixture[] = [
    {
      id: currentUserId,
      result: matrix.userPresent ? user : null,
      times: organizationReadRuns ? 2 : 1,
    },
    { id: currentHumanSessionId, result: session },
    ...(organizationReadRuns
      ? [{
          id: selectedOrganizationId,
          result: matrix.organizationSelector === "matching" ? organization : null,
        }]
      : []),
  ];
  const queryFixtures: UniqueQueryFixture[] = [
    {
      clauses: [{ field: "sessionId", value: currentHumanSessionId }],
      index: "by_session",
      result: selectionPresent ? selection : null,
      table: "authSessionSelections",
    },
    ...(organizationGatePasses
      ? [
          {
            clauses: [
              { field: "organizationId", value: currentOrganizationId },
              { field: "userId", value: currentUserId },
            ],
            index: "by_organization_and_user",
            result: matrix.membershipPresent ? membership : null,
            table: "organizationMemberships",
          },
        ]
      : []),
    ...(roleGatePasses
      ? [
          {
            clauses: [{ field: "publicId", value: workspacePublicId }],
            index: "by_public_id",
            result: matrix.workspaceSelector === "missing" ? null : workspace,
            table: "workspaces",
          },
        ]
      : []),
    ...(workspaceGatePasses && matrix.organizationRole === "member"
      ? [
          {
            clauses: [
              { field: "workspaceId", value: currentWorkspaceId },
              { field: "userId", value: currentUserId },
            ],
            index: "by_workspace_and_user",
            result: matrix.workspaceMembershipPresent ? workspaceMembership : null,
            table: "workspaceMemberships",
          },
        ]
      : []),
  ];
  return instrumentedContext({
    getFixtures,
    identity: humanIdentity(),
    queryFixtures,
  });
}

function assertNoDeniedWrites(
  result: { readonly ok: boolean },
  writes: readonly string[],
): void {
  if (!result.ok) expect(writes).toEqual([]);
}

type AgentFailureCode = Extract<AuthorizationExpectation, { readonly ok: false }>["code"];
type HumanFailureCode = Extract<
  HumanAuthorizationExpectation,
  { readonly ok: false }
>["code"];

interface AgentFaultCase {
  readonly name: string;
  readonly expectedCode: AgentFailureCode;
  readonly apply: (matrix: AgentMatrix) => AgentMatrix;
}

interface HumanFaultCase {
  readonly name: string;
  readonly expectedCode: HumanFailureCode;
  readonly baselineRole?: OrganizationRole;
  readonly apply: (matrix: HumanMatrix) => HumanMatrix;
}

const agentTupleFaultCases = [
  {
    name: "a missing credential",
    expectedCode: "AUTHENTICATION_FAILED",
    apply: (matrix) => ({ ...matrix, credentialPresent: false }),
  },
  {
    name: "a revoked credential",
    expectedCode: "AUTHENTICATION_FAILED",
    apply: (matrix) => ({ ...matrix, credentialStatus: "revoked" }),
  },
  {
    name: "an expired credential",
    expectedCode: "AUTHENTICATION_FAILED",
    apply: (matrix) => ({ ...matrix, credentialFresh: false }),
  },
  {
    name: "a missing session",
    expectedCode: "SESSION_INVALID",
    apply: (matrix) => ({ ...matrix, sessionPresent: false }),
  },
  {
    name: "an expired session status",
    expectedCode: "SESSION_INVALID",
    apply: (matrix) => ({ ...matrix, sessionStatus: "expired" }),
  },
  {
    name: "a revoked session status",
    expectedCode: "SESSION_INVALID",
    apply: (matrix) => ({ ...matrix, sessionStatus: "revoked" }),
  },
  {
    name: "an expired session idle deadline",
    expectedCode: "SESSION_INVALID",
    apply: (matrix) => ({ ...matrix, sessionFresh: false }),
  },
  {
    name: "a session bound to another credential",
    expectedCode: "SESSION_INVALID",
    apply: (matrix) => ({ ...matrix, sessionBinding: "credential" }),
  },
  {
    name: "a session bound to another organization",
    expectedCode: "SESSION_INVALID",
    apply: (matrix) => ({ ...matrix, sessionBinding: "organization" }),
  },
  {
    name: "a session bound to another workspace",
    expectedCode: "SESSION_INVALID",
    apply: (matrix) => ({ ...matrix, sessionBinding: "workspace" }),
  },
  {
    name: "a session bound to another agent",
    expectedCode: "SESSION_INVALID",
    apply: (matrix) => ({ ...matrix, sessionBinding: "agent" }),
  },
  {
    name: "a missing agent",
    expectedCode: "AUTHORIZATION_DENIED",
    apply: (matrix) => ({ ...matrix, agentPresent: false }),
  },
  {
    name: "a missing grant",
    expectedCode: "AUTHORIZATION_DENIED",
    apply: (matrix) => ({ ...matrix, grantPresent: false }),
  },
  {
    name: "a missing workspace",
    expectedCode: "AUTHORIZATION_DENIED",
    apply: (matrix) => ({ ...matrix, workspacePresent: false }),
  },
  {
    name: "a missing organization",
    expectedCode: "AUTHORIZATION_DENIED",
    apply: (matrix) => ({ ...matrix, organizationPresent: false }),
  },
  {
    name: "a disabled agent",
    expectedCode: "AUTHORIZATION_DENIED",
    apply: (matrix) => ({ ...matrix, agentStatus: "disabled" }),
  },
  {
    name: "a revoked grant",
    expectedCode: "AUTHORIZATION_DENIED",
    apply: (matrix) => ({ ...matrix, grantStatus: "revoked" }),
  },
  {
    name: "a disabled workspace",
    expectedCode: "AUTHORIZATION_DENIED",
    apply: (matrix) => ({ ...matrix, workspaceStatus: "disabled" }),
  },
  {
    name: "a disabled organization",
    expectedCode: "AUTHORIZATION_DENIED",
    apply: (matrix) => ({ ...matrix, organizationStatus: "disabled" }),
  },
  {
    name: "an agent from another organization",
    expectedCode: "AUTHORIZATION_DENIED",
    apply: (matrix) => ({ ...matrix, durableTuple: "agent_organization" }),
  },
  {
    name: "a workspace from another organization",
    expectedCode: "AUTHORIZATION_DENIED",
    apply: (matrix) => ({ ...matrix, durableTuple: "workspace_organization" }),
  },
  {
    name: "a grant from another organization",
    expectedCode: "AUTHORIZATION_DENIED",
    apply: (matrix) => ({ ...matrix, durableTuple: "grant_organization" }),
  },
  {
    name: "a grant for another workspace",
    expectedCode: "AUTHORIZATION_DENIED",
    apply: (matrix) => ({ ...matrix, durableTuple: "grant_workspace" }),
  },
  {
    name: "a grant for another agent",
    expectedCode: "AUTHORIZATION_DENIED",
    apply: (matrix) => ({ ...matrix, durableTuple: "grant_agent" }),
  },
] satisfies readonly AgentFaultCase[];

const agentScopeFaultCases = [
  {
    name: "the credential omits the required scope",
    expectedCode: "SCOPE_REQUIRED",
    apply: (matrix) => ({
      ...matrix,
      credentialScopes: matrix.credentialScopes.filter(
        (scope) => scope !== matrix.requiredScope,
      ),
    }),
  },
  {
    name: "the grant omits the required scope",
    expectedCode: "SCOPE_REQUIRED",
    apply: (matrix) => ({
      ...matrix,
      grantScopes: matrix.grantScopes.filter((scope) => scope !== matrix.requiredScope),
    }),
  },
] satisfies readonly AgentFaultCase[];

const humanFaultCases = [
  {
    name: "a missing organization",
    expectedCode: "ORGANIZATION_REQUIRED",
    apply: (matrix) => ({ ...matrix, organizationSelector: "missing" }),
  },
  {
    name: "a foreign organization",
    expectedCode: "MEMBERSHIP_INACTIVE",
    apply: (matrix) => ({ ...matrix, organizationSelector: "foreign" }),
  },
  {
    name: "a disabled organization",
    expectedCode: "MEMBERSHIP_INACTIVE",
    apply: (matrix) => ({ ...matrix, organizationStatus: "disabled" }),
  },
  {
    name: "a missing user",
    expectedCode: "AUTHENTICATION_FAILED",
    apply: (matrix) => ({ ...matrix, userPresent: false }),
  },
  {
    name: "a disabled user",
    expectedCode: "AUTHENTICATION_FAILED",
    apply: (matrix) => ({ ...matrix, userActive: false }),
  },
  {
    name: "a missing organization membership",
    expectedCode: "MEMBERSHIP_INACTIVE",
    apply: (matrix) => ({ ...matrix, membershipPresent: false }),
  },
  {
    name: "an inactive organization membership",
    expectedCode: "MEMBERSHIP_INACTIVE",
    apply: (matrix) => ({ ...matrix, membershipStatus: "inactive" }),
  },
  {
    name: "a pending organization membership",
    expectedCode: "MEMBERSHIP_INACTIVE",
    apply: (matrix) => ({ ...matrix, membershipStatus: "pending" }),
  },
  {
    name: "a removed organization membership",
    expectedCode: "MEMBERSHIP_INACTIVE",
    apply: (matrix) => ({ ...matrix, membershipStatus: "removed" }),
  },
  {
    name: "an organization-admin requirement for a member",
    expectedCode: "WORKSPACE_ROLE_REQUIRED",
    baselineRole: "member",
    apply: (matrix) => ({ ...matrix, requireOrganizationAdmin: true }),
  },
  {
    name: "a missing workspace",
    expectedCode: "NOT_FOUND",
    apply: (matrix) => ({ ...matrix, workspaceSelector: "missing" }),
  },
  {
    name: "a foreign workspace",
    expectedCode: "NOT_FOUND",
    apply: (matrix) => ({ ...matrix, workspaceSelector: "foreign" }),
  },
  {
    name: "a disabled workspace",
    expectedCode: "NOT_FOUND",
    apply: (matrix) => ({ ...matrix, workspaceStatus: "disabled" }),
  },
  {
    name: "a missing member workspace assignment",
    expectedCode: "NOT_FOUND",
    baselineRole: "member",
    apply: (matrix) => ({ ...matrix, workspaceMembershipPresent: false }),
  },
  {
    name: "a removed member workspace assignment",
    expectedCode: "NOT_FOUND",
    baselineRole: "member",
    apply: (matrix) => ({ ...matrix, workspaceMembershipStatus: "removed" }),
  },
] satisfies readonly HumanFaultCase[];

const validAgentMatrixArbitrary = fc
  .tuple(
    fc.constantFrom(...agentScopeValues),
    scopeArrayArbitrary,
    scopeArrayArbitrary,
  )
  .map(([requiredScope, credentialScopes, grantScopes]) =>
    validAgentMatrix({ credentialScopes, grantScopes, requiredScope }),
  );

async function assertAgentCase(
  matrix: AgentMatrix,
  assertedExpectation: AuthorizationExpectation,
) {
  const harness = agentContext(matrix);
  const result = await authorizeAgent(harness.ctx, {
    credentialId: currentCredentialId,
    now,
    requestId,
    requiredScope: matrix.requiredScope,
    sessionPublicId: "ses_current",
  });
  harness.assertReadsExhausted();
  const expected = expectedAgentAuthorization(matrix);

  expect(expected).toEqual(assertedExpectation);
  expect(result.ok).toBe(expected.ok);
  if (!expected.ok) {
    expect(result.ok).toBeFalse();
    if (!result.ok) expect(result.error.code).toBe(expected.code);
  } else {
    expect(result.ok).toBeTrue();
    if (result.ok) {
      expect(result.authorization.organizationId).toBe(currentOrganizationId);
      expect(result.authorization.workspaceId).toBe(currentWorkspaceId);
      expect(result.authorization.agentId).toBe(currentAgentId);
      expect(result.authorization.scopes).toEqual(
        matrix.credentialScopes.filter((scope) => matrix.grantScopes.includes(scope)),
      );
    }
  }
  assertNoDeniedWrites(result, harness.writes);
  return { harness, result };
}

async function assertHumanCase(
  matrix: HumanMatrix,
  assertedExpectation: HumanAuthorizationExpectation,
) {
  const harness = humanContext(matrix);
  const result = await authorizeWorkspaceHuman(harness.ctx, {
    requestId,
    requireOrganizationAdmin: matrix.requireOrganizationAdmin,
    workspacePublicId: "wsp_selected",
  });
  harness.assertReadsExhausted();
  const expected = expectedHumanAuthorization(matrix);

  expect(expected).toEqual(assertedExpectation);
  expect(result.ok).toBe(expected.ok);
  if (!expected.ok) {
    expect(result.ok).toBeFalse();
    if (!result.ok) expect(result.error.code).toBe(expected.code);
  } else {
    expect(result.ok).toBeTrue();
    if (result.ok) {
      expect(result.authorization.organization._id).toBe(currentOrganizationId);
      expect(result.authorization.workspace._id).toBe(currentWorkspaceId);
      expect(result.authorization.user._id).toBe(currentUserId);
    }
  }
  assertNoDeniedWrites(result, harness.writes);
  return { harness, result };
}

describe("agent authorization matrix properties", () => {
  test("authorizes every generated live tuple with the required scope", async () => {
    await assertAsyncProperty(
      fc.asyncProperty(validAgentMatrixArbitrary, async (matrix) => {
        await assertAgentCase(matrix, { ok: true });
      }),
    );
  });

  for (const fault of agentTupleFaultCases) {
    test(`rejects ${fault.name} as the only fault in an otherwise live tuple`, async () => {
      await assertAsyncProperty(
        fc.asyncProperty(validAgentMatrixArbitrary, async (baseline) => {
          await assertAgentCase(fault.apply(baseline), {
            ok: false,
            code: fault.expectedCode,
          });
        }),
      );
    });
  }

  for (const fault of agentScopeFaultCases) {
    test(`rejects when ${fault.name}`, async () => {
      await assertAsyncProperty(
        fc.asyncProperty(validAgentMatrixArbitrary, async (baseline) => {
          await assertAgentCase(fault.apply(baseline), {
            ok: false,
            code: fault.expectedCode,
          });
        }),
      );
    });
  }

  test("collapses every foreign session binding with a missing selector", async () => {
    await assertAsyncProperty(
      fc.asyncProperty(validAgentMatrixArbitrary, async (baseline) => {
        const missingMatrix = { ...baseline, sessionPresent: false };
        expect(expectedAgentAuthorization(missingMatrix)).toEqual({
          ok: false,
          code: "SESSION_INVALID",
        });
        for (const sessionBinding of [
          "credential",
          "organization",
          "workspace",
          "agent",
        ] as const) {
          const foreignMatrix = { ...baseline, sessionBinding };
          expect(expectedAgentAuthorization(foreignMatrix)).toEqual({
            ok: false,
            code: "SESSION_INVALID",
          });
          const selector = "ses_untrusted_selector";
          const missing = agentContext(missingMatrix, selector);
          const foreign = agentContext(foreignMatrix, selector);
          const args = {
            credentialId: currentCredentialId,
            now,
            requestId,
            requiredScope: baseline.requiredScope,
            sessionPublicId: selector,
          };
          const [missingOpaqueResult, foreignOpaqueResult] = await Promise.all([
            authorizeAgent(missing.ctx, args),
            authorizeAgent(foreign.ctx, args),
          ]);
          missing.assertReadsExhausted();
          foreign.assertReadsExhausted();

          expect(missingOpaqueResult).toEqual(foreignOpaqueResult);
          expect(missingOpaqueResult.ok).toBeFalse();
          if (!missingOpaqueResult.ok) {
            expect(missingOpaqueResult.error.code).toBe("SESSION_INVALID");
          }
          expect(missing.writes).toEqual([]);
          expect(foreign.writes).toEqual([]);
        }
      }),
    );
  });
});

describe("human authorization and tenant-opacity matrix properties", () => {
  test("authorizes every structurally valid organization role and admin mode", async () => {
    await assertAsyncProperty(
      fc.asyncProperty(workspaceRolesArbitrary, async (workspaceRoles) => {
        for (const configuration of [
          { organizationRole: "owner", requireOrganizationAdmin: false },
          { organizationRole: "owner", requireOrganizationAdmin: true },
          { organizationRole: "admin", requireOrganizationAdmin: false },
          { organizationRole: "admin", requireOrganizationAdmin: true },
          { organizationRole: "member", requireOrganizationAdmin: false },
        ] as const) {
          await assertHumanCase(
            validHumanMatrix({ ...configuration, workspaceRoles }),
            { ok: true },
          );
        }
      }),
    );
  });

  for (const fault of humanFaultCases) {
    test(`rejects ${fault.name} as the only fault in an otherwise live tuple`, async () => {
      await assertAsyncProperty(
        fc.asyncProperty(
          organizationRoleArbitrary,
          workspaceRolesArbitrary,
          async (generatedRole, workspaceRoles) => {
            const baseline = validHumanMatrix({
              organizationRole: fault.baselineRole ?? generatedRole,
              workspaceRoles,
            });
            await assertHumanCase(fault.apply(baseline), {
              ok: false,
              code: fault.expectedCode,
            });
          },
        ),
      );
    });
  }

  test("makes missing, foreign, and inaccessible workspace selectors indistinguishable", async () => {
    await assertAsyncProperty(
      fc.asyncProperty(workspaceRolesArbitrary, async (workspaceRoles) => {
        for (const organizationRole of ["owner", "admin", "member"] as const) {
          const base = validHumanMatrix({ organizationRole, workspaceRoles });
          const selector = "wsp_untrusted_selector";
          const missingMatrix = { ...base, workspaceSelector: "missing" as const };
          const foreignMatrix = { ...base, workspaceSelector: "foreign" as const };
          const inaccessibleMatrix =
            organizationRole === "member"
              ? { ...base, workspaceMembershipPresent: false }
              : { ...base, workspaceStatus: "disabled" as const };
          expect(expectedHumanAuthorization(missingMatrix)).toEqual({
            ok: false,
            code: "NOT_FOUND",
          });
          expect(expectedHumanAuthorization(foreignMatrix)).toEqual({
            ok: false,
            code: "NOT_FOUND",
          });
          expect(expectedHumanAuthorization(inaccessibleMatrix)).toEqual({
            ok: false,
            code: "NOT_FOUND",
          });
          const missing = humanContext(missingMatrix, selector);
          const foreign = humanContext(foreignMatrix, selector);
          const inaccessible = humanContext(
            inaccessibleMatrix,
            selector,
          );
          const args = { requestId, workspacePublicId: selector };
          const [missingResult, foreignResult, inaccessibleResult] = await Promise.all([
            authorizeWorkspaceHuman(missing.ctx, args),
            authorizeWorkspaceHuman(foreign.ctx, args),
            authorizeWorkspaceHuman(inaccessible.ctx, args),
          ]);
          missing.assertReadsExhausted();
          foreign.assertReadsExhausted();
          inaccessible.assertReadsExhausted();

          expect(missingResult).toEqual(foreignResult);
          expect(missingResult).toEqual(inaccessibleResult);
          expect(missingResult.ok).toBeFalse();
          if (!missingResult.ok) expect(missingResult.error.code).toBe("NOT_FOUND");
          expect(missing.writes).toEqual([]);
          expect(foreign.writes).toEqual([]);
          expect(inaccessible.writes).toEqual([]);
        }
      }),
    );
  });
});
