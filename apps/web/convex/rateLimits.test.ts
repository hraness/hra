import { describe, expect, test } from "bun:test";

import type { Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import {
  consumeAuthorizedHumanRateLimit,
  consumeValidatedAgentReadRateLimit,
} from "./rateLimits";
import { RATE_LIMIT_SELECTED_SHARD_INDEX_FIELDS } from "./rateLimitPolicy";

interface StoredBucket {
  readonly _id: Id<"apiRateLimitBuckets">;
  readonly subjectKind: "credential" | "workspace" | "user" | "unauthenticated";
  readonly subjectKey: string;
  readonly routeClass:
    | "agent_read"
    | "agent_write"
    | "agent_claim"
    | "agent_review"
    | "agent_session"
    | "human_read"
    | "human_mutation"
    | "human_poll"
    | "agent_auth_failure"
    | "enrollment_auth_failure";
  readonly windowStartedAt: number;
  readonly shard: number;
  readonly count: number;
  readonly expiresAt: number;
}

interface QueryObservation {
  readonly table: string;
  readonly index: string;
  readonly equalities: ReadonlyMap<string, unknown>;
}

interface MockDocument {
  readonly _id: string;
}

function persistenceHarness(input: {
  readonly documents?: ReadonlyMap<string, MockDocument>;
  readonly sessions?: readonly MockDocument[];
} = {}): {
  readonly ctx: MutationCtx;
  readonly rows: StoredBucket[];
  readonly queries: QueryObservation[];
} {
  const rows: StoredBucket[] = [];
  const queries: QueryObservation[] = [];
  const db = {
    get: async (id: string) => input.documents?.get(id) ?? null,
    query: (table: string) => ({
      withIndex: (
        index: string,
        configure: (query: { eq: (field: string, value: unknown) => unknown }) => unknown,
      ) => {
        const equalities = new Map<string, unknown>();
        const builder = {
          eq(field: string, value: unknown) {
            equalities.set(field, value);
            return builder;
          },
        };
        configure(builder);
        queries.push({ table, index, equalities });
        return {
          unique: async () => {
            if (table === "agentSessions") {
              return input.sessions?.find((row) =>
                [...equalities].every(([field, value]) =>
                  Object.entries(row).some(
                    ([candidateField, candidateValue]) =>
                      candidateField === field && candidateValue === value,
                  ),
                ),
              ) ?? null;
            }
            return rows.find((row) =>
              [...equalities].every(
                ([field, value]) => row[field as keyof StoredBucket] === value,
              ),
            ) ?? null;
          },
        };
      },
    }),
    insert: async (_table: string, value: Omit<StoredBucket, "_id">) => {
      const id = `rate-bucket-${rows.length + 1}` as Id<"apiRateLimitBuckets">;
      rows.push({ _id: id, ...value });
      return id;
    },
    patch: async (id: Id<"apiRateLimitBuckets">, value: Partial<StoredBucket>) => {
      const index = rows.findIndex((row) => row._id === id);
      const existing = rows[index];
      if (index < 0 || existing === undefined) throw new Error("missing mock bucket");
      rows[index] = { ...existing, ...value };
    },
  };
  return { ctx: { db } as unknown as MutationCtx, rows, queries };
}

const AUTHORIZATION_NOW = 1_720_000_000_000;

function agentAuthorizationFixture() {
  const organizationId = "organization-id";
  const workspaceId = "workspace-id";
  const agentId = "agent-id";
  const grantId = "grant-id";
  const credentialId = "credential-id";
  const sessionId = "session-id";
  return {
    ids: { agentId, credentialId, grantId, organizationId, sessionId, workspaceId },
    credential: {
      _id: credentialId,
      agentId,
      expiresAt: AUTHORIZATION_NOW + 60_000,
      grantId,
      locator: "agt_fixture",
      organizationId,
      scopes: ["tasks:read"],
      status: "active",
      workspaceId,
    },
    session: {
      _id: sessionId,
      agentId,
      credentialId,
      idleExpiresAt: AUTHORIZATION_NOW + 60_000,
      organizationId,
      publicId: "ses_01HZZZZZZZZZZZZZZZZZZZZZZZ",
      status: "active",
      workspaceId,
    },
    agent: {
      _id: agentId,
      name: "Fixture agent",
      organizationId,
      publicId: "agt_01HZZZZZZZZZZZZZZZZZZZZZZZ",
      status: "active",
    },
    grant: {
      _id: grantId,
      agentId,
      organizationId,
      scopes: ["tasks:read"],
      status: "active",
      workspaceId,
    },
    workspace: {
      _id: workspaceId,
      name: "Fixture workspace",
      organizationId,
      publicId: "wrk_01HZZZZZZZZZZZZZZZZZZZZZZZ",
      slug: "fixture",
      status: "active",
    },
    organization: {
      _id: organizationId,
      name: "Fixture organization",
      publicId: "org_01HZZZZZZZZZZZZZZZZZZZZZZZ",
      status: "active",
    },
  };
}

type AgentAuthorizationFixture = ReturnType<typeof agentAuthorizationFixture>;

function harnessForAgentFixture(fixture: AgentAuthorizationFixture) {
  return persistenceHarness({
    documents: new Map(
      [
        fixture.credential,
        fixture.agent,
        fixture.grant,
        fixture.workspace,
        fixture.organization,
      ].map((document) => [document._id, document]),
    ),
    sessions: [fixture.session],
  });
}

describe("rate-limit persistence contract", () => {
  test("uses only authorized Convex IDs and exact selected-shard lookups", async () => {
    const harness = persistenceHarness();
    const userId = "convex-user-id" as Id<"users">;
    const workspaceId = "convex-workspace-id" as Id<"workspaces">;
    const result = await consumeAuthorizedHumanRateLimit(harness.ctx, {
      userId,
      workspaceId,
      routeClass: "human_mutation",
      requestId: "req_00000000000000000000000001",
    });
    expect(result).toEqual({ kind: "allowed" });
    expect(harness.rows.map((row) => [row.subjectKind, row.subjectKey])).toEqual([
      ["user", userId],
      ["workspace", workspaceId],
    ]);
    expect(JSON.stringify(harness.rows)).not.toContain("user_");
    expect(JSON.stringify(harness.rows)).not.toContain("Bearer");
    expect(harness.queries).toHaveLength(2);
    for (const query of harness.queries) {
      expect(query.index).toBe("by_subject_route_window_shard");
      expect([...query.equalities.keys()]).toEqual([...RATE_LIMIT_SELECTED_SHARD_INDEX_FIELDS]);
    }
  });

  test("user-only bootstrap profiles write no dummy workspace dimension", async () => {
    const harness = persistenceHarness();
    const result = await consumeAuthorizedHumanRateLimit(harness.ctx, {
      userId: "convex-user-id" as Id<"users">,
      routeClass: "human_read",
      requestId: "req_00000000000000000000000002",
    });
    expect(result).toEqual({ kind: "allowed" });
    expect(harness.rows).toHaveLength(1);
    expect(harness.rows[0]?.subjectKind).toBe("user");
  });

  test("validates the complete agent read tuple before debiting live IDs", async () => {
    const fixture = agentAuthorizationFixture();
    const harness = harnessForAgentFixture(fixture);
    const result = await consumeValidatedAgentReadRateLimit(harness.ctx, {
      credentialId: fixture.ids.credentialId as Id<"agentCredentials">,
      operation: "readyTasks",
      requestId: "req_00000000000000000000000003",
      sessionPublicId: fixture.session.publicId,
      now: AUTHORIZATION_NOW,
    });

    expect(result).toEqual({ kind: "allowed" });
    expect(harness.rows.map((row) => [row.subjectKind, row.subjectKey])).toEqual([
      ["credential", fixture.ids.credentialId],
      ["workspace", fixture.ids.workspaceId],
    ]);
  });

  test("never mutates buckets for rejected agent read authorization", async () => {
    const cases: readonly Readonly<{
      name: string;
      mutate: (fixture: AgentAuthorizationFixture) => void;
    }>[] = [
      { name: "revoked credential", mutate: (fixture) => { fixture.credential.status = "revoked"; } },
      { name: "expired credential", mutate: (fixture) => { fixture.credential.expiresAt = AUTHORIZATION_NOW; } },
      { name: "wrong session credential", mutate: (fixture) => { fixture.session.credentialId = "other-credential"; } },
      { name: "idle session", mutate: (fixture) => { fixture.session.idleExpiresAt = AUTHORIZATION_NOW; } },
      { name: "disabled agent", mutate: (fixture) => { fixture.agent.status = "disabled"; } },
      { name: "revoked grant", mutate: (fixture) => { fixture.grant.status = "revoked"; } },
      { name: "disabled workspace", mutate: (fixture) => { fixture.workspace.status = "disabled"; } },
      { name: "disabled organization", mutate: (fixture) => { fixture.organization.status = "disabled"; } },
      { name: "foreign grant tuple", mutate: (fixture) => { fixture.grant.workspaceId = "other-workspace"; } },
      { name: "missing required scope", mutate: (fixture) => {
        fixture.credential.scopes = ["tasks:claim"];
        fixture.grant.scopes = ["tasks:claim"];
      } },
    ];

    for (const scenario of cases) {
      const fixture = agentAuthorizationFixture();
      scenario.mutate(fixture);
      const harness = harnessForAgentFixture(fixture);
      const result = await consumeValidatedAgentReadRateLimit(harness.ctx, {
        credentialId: fixture.ids.credentialId as Id<"agentCredentials">,
        operation: "readyTasks",
        requestId: "req_00000000000000000000000004",
        sessionPublicId: fixture.session.publicId,
        now: AUTHORIZATION_NOW,
      });

      expect(result, scenario.name).toEqual({ kind: "skipped" });
      expect(harness.rows, scenario.name).toEqual([]);
      expect(
        harness.queries.filter(({ table }) => table === "apiRateLimitBuckets"),
        scenario.name,
      ).toEqual([]);
    }
  });
});
