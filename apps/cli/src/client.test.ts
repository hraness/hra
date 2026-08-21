import { describe, expect, test } from "bun:test";
import {
  createBearerSecret,
  createLocator,
  formatCredentialToken,
  formatEnrollmentToken,
  type CredentialToken,
  type EnrollmentToken,
  type SessionId,
} from "@hraness/agent-tasks-protocol";

import { normalizeApiUrl, TaskctlClient } from "./client";

const REQUEST_ID = "req_00000000000000000000000000";
const SESSION_ID: SessionId = "ses_00000000000000000000000000";
const IDEMPOTENCY_KEY = "018f22e2-7b44-7cc0-8e5d-657f31f9064a"; // gitleaks:allow - deterministic test vector

function inputUrl(input: string | URL | Request): string {
  if (typeof input === "string") return input;
  return input instanceof URL ? input.toString() : input.url;
}

function stringBody(body: RequestInit["body"]): string {
  if (typeof body !== "string") throw new Error("expected a JSON string body");
  return body;
}

function tokenPair(): { readonly credential: CredentialToken; readonly enrollment: EnrollmentToken } {
  const locator = createLocator(Uint8Array.from({ length: 26 }, (_, index) => index));
  const secret = createBearerSecret(Uint8Array.from({ length: 32 }, (_, index) => index));
  return {
    credential: formatCredentialToken(locator, secret),
    enrollment: formatEnrollmentToken(locator, secret),
  };
}

const openTask = {
  id: "tsk_01ARZ3NDEKTSV4RRFFQ69G5FAV",
  key: "OPS-7K2M4Q9",
  title: "Prove the claim race",
  type: "task",
  priority: 2,
  status: "open",
  availableAt: 0,
  isReady: true,
  unresolvedBlockerCount: 0,
  cancelledBlockerCount: 0,
  revision: 1,
  reviewRevision: 1,
  createdAt: 1,
  updatedAt: 1,
} as const;

describe("TaskctlClient", () => {
  test("brokers refresh once with the refresh token only in Authorization", async () => {
    const captures: { readonly url: URL; readonly init?: RequestInit }[] = [];
    const fetchMock = (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      captures.push({ url: new URL(inputUrl(input)), ...(init === undefined ? {} : { init }) });
      return Promise.resolve(
        Response.json({
          ok: true,
          data: {
            accessToken: "rotated-access-token-long-enough",
            refreshToken: "rotated-refresh-token-long-enough",
            user: { id: "user_abc123", email: "human@example.com" },
            organization: {
              id: "organization-1",
              name: "Example",
              role: "owner",
              status: "active",
            },
            workspace: {
              id: "workspace-1",
              organizationId: "organization-1",
              slug: "core",
              name: "Core",
              taskKeyPrefix: "OPS",
              roles: ["planner"],
            },
          },
          requestId: REQUEST_ID,
        }),
      );
    };
    const client = new TaskctlClient({ apiUrl: "http://127.0.0.1:3211", fetch: fetchMock });

    const result = await client.refreshHumanAuthentication(
      "current-refresh-token-long-enough",
    );

    expect(result).toMatchObject({
      ok: true,
      data: { organization: { id: "organization-1" }, workspace: { id: "workspace-1" } },
    });
    const captured = captures[0];
    if (captured === undefined) throw new Error("request was not captured");
    expect(captured.url.pathname).toBe("/v1/auth/refresh");
    const headers = new Headers(captured.init?.headers);
    expect(headers.get("Authorization")).toBe("Bearer current-refresh-token-long-enough");
    expect(headers.get("Idempotency-Key")).toBeNull();
    expect(headers.get("X-Taskctl-Session")).toBeNull();
    expect(JSON.parse(stringBody(captured.init?.body))).toEqual({});
    expect(stringBody(captured.init?.body)).not.toContain("current-refresh-token-long-enough");
  });

  test("rejects server-controlled error text before it can echo opaque human tokens", async () => {
    const refreshToken = "opaque-refresh-token-that-cannot-leak";
    const client = new TaskctlClient({
      apiUrl: "http://127.0.0.1:3211",
      fetch: () =>
        Promise.resolve(
          Response.json(
            {
              error: {
                code: "AUTHENTICATION_FAILED",
                message: `provider echoed ${refreshToken}`,
                requestId: REQUEST_ID,
                details: {},
              },
            },
            { status: 401 },
          ),
        ),
    });

    const result = await client.refreshHumanAuthentication(refreshToken);

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "SERVICE_UNAVAILABLE",
        message: "the task service returned an invalid error response",
      },
    });
    expect(JSON.stringify(result)).not.toContain(refreshToken);
  });

  test("sends human list and mutation contracts without agent session headers", async () => {
    const captures: { readonly url: URL; readonly init?: RequestInit }[] = [];
    const responses = [
      Response.json({
        ok: true,
        data: { organizations: [], cursor: null },
        requestId: REQUEST_ID,
      }),
      Response.json({
        ok: true,
        data: {
          workspace: {
            id: "workspace-1",
            organizationId: "organization-1",
            slug: "core",
            name: "Core",
            taskKeyPrefix: "OPS",
            roles: ["planner"],
          },
        },
        requestId: REQUEST_ID,
      }),
    ];
    const client = new TaskctlClient({
      apiUrl: "http://127.0.0.1:3211",
      fetch: (input, init) => {
        captures.push({ url: new URL(inputUrl(input)), ...(init === undefined ? {} : { init }) });
        const response = responses.shift();
        if (response === undefined) throw new Error("unexpected request");
        return Promise.resolve(response);
      },
    });
    await client.listOrganizations("human-access-token-long-enough", {
      cursor: "next/page",
      limit: 25,
    });
    await client.createWorkspace(
      "human-access-token-long-enough",
      { name: " Core ", slug: "core", taskKeyPrefix: "OPS" },
      IDEMPOTENCY_KEY,
    );

    expect(captures[0]?.url.pathname).toBe("/v1/organizations");
    expect(captures[0]?.url.searchParams.get("cursor")).toBe("next/page");
    expect(captures[0]?.url.searchParams.get("limit")).toBe("25");
    expect(captures[1]?.url.pathname).toBe("/v1/workspaces");
    expect(new Headers(captures[1]?.init?.headers).get("Idempotency-Key")).toBe(IDEMPOTENCY_KEY);
    expect(new Headers(captures[1]?.init?.headers).get("X-Taskctl-Session")).toBeNull();
    expect(JSON.parse(stringBody(captures[1]?.init?.body))).toEqual({
      name: "Core",
      slug: "core",
      taskKeyPrefix: "OPS",
    });
  });

  test("sends the frozen human agent-lifecycle routes with workspace selectors", async () => {
    const { credential, enrollment } = tokenPair();
    const credentialId = credential.slice(4, 30);
    const agent = {
      id: "agent-1",
      workspaceId: "workspace-1",
      name: "Builder",
      scopes: ["tasks:read", "tasks:claim"],
      status: "active",
      createdAt: 1,
      updatedAt: 1,
    } as const;
    const activeCredential = {
      id: credentialId,
      agentId: agent.id,
      workspaceId: agent.workspaceId,
      scopes: agent.scopes,
      status: "active",
      createdAt: 1,
      expiresAt: 100,
      lastUsedAt: 2,
    } as const;
    const revokedCredential = {
      ...activeCredential,
      status: "revoked",
      revokedAt: 3,
    } as const;
    const activeSession = {
      agentId: agent.id,
      workspaceId: agent.workspaceId,
      credentialId,
      status: "active",
      createdAt: 1,
      lastSeenAt: 2,
      idleExpiresAt: 100,
    } as const;
    const captures: { readonly url: URL; readonly init?: RequestInit }[] = [];
    const responses = [
      { agents: [agent], cursor: "agents-next" },
      { agent },
      { enrollment: { locator: enrollment.slice(4, 30), expiresAt: 100 } },
      { credentials: [activeCredential], cursor: "credentials-next" },
      { credential: revokedCredential },
      { sessions: [activeSession], cursor: null },
      { agent: { ...agent, status: "disabled", updatedAt: 4 } },
    ];
    const client = new TaskctlClient({
      apiUrl: "http://127.0.0.1:3211",
      fetch: (input, init) => {
        captures.push({ url: new URL(inputUrl(input)), ...(init === undefined ? {} : { init }) });
        const data = responses.shift();
        if (data === undefined) throw new Error("unexpected request");
        return Promise.resolve(Response.json({ ok: true, data, requestId: REQUEST_ID }));
      },
    });
    const accessToken = "human-access-token-long-enough";

    await client.listAgents(accessToken, {
      workspaceId: agent.workspaceId,
      cursor: "agents/current",
      limit: 25,
    });
    await client.getAgent(accessToken, agent.id, agent.workspaceId);
    await client.createAgentEnrollment(
      accessToken,
      agent.id,
      {
        workspaceId: agent.workspaceId,
        enrollment,
        scopes: ["tasks:read"],
        credentialLifetimeMs: 3_600_000,
      },
      IDEMPOTENCY_KEY,
    );
    await client.listAgentCredentials(accessToken, agent.id, {
      workspaceId: agent.workspaceId,
      cursor: "credentials/current",
      limit: 50,
    });
    await client.revokeAgentCredential(
      accessToken,
      agent.id,
      credentialId,
      { workspaceId: agent.workspaceId },
      IDEMPOTENCY_KEY,
    );
    await client.listAgentSessions(accessToken, agent.id, {
      workspaceId: agent.workspaceId,
      limit: 20,
    });
    await client.disableAgent(
      accessToken,
      agent.id,
      { workspaceId: agent.workspaceId },
      IDEMPOTENCY_KEY,
    );

    expect(captures.map(({ url }) => url.pathname)).toEqual([
      "/v1/agents",
      "/v1/agents/agent-1",
      "/v1/agents/agent-1/enrollments",
      "/v1/agents/agent-1/credentials",
      `/v1/agents/agent-1/credentials/${credentialId}/revoke`,
      "/v1/agents/agent-1/sessions",
      "/v1/agents/agent-1/disable",
    ]);
    expect(captures[0]?.url.searchParams.get("workspaceId")).toBe(agent.workspaceId);
    expect(captures[0]?.url.searchParams.get("cursor")).toBe("agents/current");
    expect(captures[1]?.url.searchParams.get("workspaceId")).toBe(agent.workspaceId);
    expect(captures[3]?.url.searchParams.get("workspaceId")).toBe(agent.workspaceId);
    expect(captures[5]?.url.searchParams.get("workspaceId")).toBe(agent.workspaceId);
    expect(JSON.parse(stringBody(captures[2]?.init?.body))).toEqual({
      workspaceId: agent.workspaceId,
      enrollment,
      scopes: ["tasks:read"],
      credentialLifetimeMs: 3_600_000,
    });
    expect(JSON.parse(stringBody(captures[4]?.init?.body))).toEqual({
      workspaceId: agent.workspaceId,
    });
    expect(JSON.parse(stringBody(captures[6]?.init?.body))).toEqual({
      workspaceId: agent.workspaceId,
    });
    for (const [index, capture] of captures.entries()) {
      const headers = new Headers(capture.init?.headers);
      expect(headers.get("Authorization")).toBe(`Bearer ${accessToken}`);
      expect(headers.get("X-Taskctl-Session")).toBeNull();
      expect(headers.get("Idempotency-Key")).toBe([2, 4, 6].includes(index) ? IDEMPOTENCY_KEY : null);
    }
  });

  test("redeems enrollment with the frozen route and no session header", async () => {
    const { credential, enrollment } = tokenPair();
    const captures: { readonly url: URL; readonly init?: RequestInit }[] = [];
    const fetchMock = (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      captures.push({ url: new URL(inputUrl(input)), ...(init === undefined ? {} : { init }) });
      return Promise.resolve(Response.json({
        ok: true,
        data: {
          agentId: "agent-1",
          credentialId: "credential-1",
          credentialExpiresAt: 1_800_000_000_000,
          scopes: ["tasks:read", "tasks:claim"],
        },
        requestId: REQUEST_ID,
      }));
    };
    const client = new TaskctlClient({ apiUrl: "http://127.0.0.1:3211", fetch: fetchMock });

    const result = await client.redeemEnrollment(enrollment, credential, IDEMPOTENCY_KEY);

    expect(result.ok).toBeTrue();
    const captured = captures[0];
    if (captured === undefined) throw new Error("request was not captured");
    expect(captured.url.pathname).toBe("/v1/agent/enrollments/redeem");
    expect(captured.init?.method).toBe("POST");
    expect(captured.init?.redirect).toBe("error");
    const headers = new Headers(captured.init?.headers);
    expect(headers.get("Authorization")).toBe(`Bearer ${enrollment}`);
    expect(headers.get("Idempotency-Key")).toBe(IDEMPOTENCY_KEY);
    expect(headers.get("X-Taskctl-Session")).toBeNull();
    expect(JSON.parse(stringBody(captured.init?.body))).toEqual({ credential });
  });

  test("sends agent session and idempotency headers for task creation", async () => {
    const { credential } = tokenPair();
    let capturedInit: RequestInit | undefined;
    const fetchMock = (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      capturedInit = init;
      return Promise.resolve(Response.json({ ok: true, data: { task: openTask }, requestId: REQUEST_ID }));
    };
    const client = new TaskctlClient({ apiUrl: "http://127.0.0.1:3211", fetch: fetchMock });

    const result = await client.createTask(
      { credential, sessionId: SESSION_ID },
      { title: " Prove the claim race ", type: "task", priority: 2 },
      IDEMPOTENCY_KEY,
    );

    expect(result).toEqual({ ok: true, data: { task: openTask }, requestId: REQUEST_ID });
    const headers = new Headers(capturedInit?.headers);
    expect(headers.get("Authorization")).toBe(`Bearer ${credential}`);
    expect(headers.get("X-Taskctl-Session")).toBe(SESSION_ID);
    expect(headers.get("Idempotency-Key")).toBe(IDEMPOTENCY_KEY);
    expect(capturedInit?.redirect).toBe("error");
    expect(JSON.parse(stringBody(capturedInit?.body))).toEqual({
      title: "Prove the claim race",
      type: "task",
      priority: 2,
    });
  });

  test("encodes and validates ready and blocked query data", async () => {
    const { credential } = tokenPair();
    const capturedUrls: URL[] = [];
    const fetchMock = (input: string | URL | Request): Promise<Response> => {
      const url = new URL(inputUrl(input));
      capturedUrls.push(url);
      return Promise.resolve(Response.json({
        ok: true,
        data: {
          tasks:
            url.pathname === "/v1/tasks/blocked"
              ? [{ task: { ...openTask, isReady: false, unresolvedBlockerCount: 1 }, needsAttention: false }]
              : [openTask],
          cursor: null,
        },
        requestId: REQUEST_ID,
      }));
    };
    const client = new TaskctlClient({ apiUrl: "http://127.0.0.1:3211", fetch: fetchMock });
    await client.readyTasks(
      { credential, sessionId: SESSION_ID },
      { cursor: "after/one + two", limit: 50 },
    );

    expect(capturedUrls[0]?.pathname).toBe("/v1/tasks/ready");
    expect(capturedUrls[0]?.searchParams.get("cursor")).toBe("after/one + two");
    expect(capturedUrls[0]?.searchParams.get("limit")).toBe("50");

    await client.blockedTasks(
      { credential, sessionId: SESSION_ID },
      { cursor: "blocked-next", limit: 25, attentionOnly: true },
    );
    expect(capturedUrls[1]?.pathname).toBe("/v1/tasks/blocked");
    expect(capturedUrls[1]?.searchParams.get("cursor")).toBe("blocked-next");
    expect(capturedUrls[1]?.searchParams.get("limit")).toBe("25");
    expect(capturedUrls[1]?.searchParams.get("attentionOnly")).toBe("true");
    expect(
      client.blockedTasks(
        { credential, sessionId: SESSION_ID },
        { limit: 0, attentionOnly: false },
      ),
    ).rejects.toThrow();
  });

  test("returns protocol errors for exit-class mapping", async () => {
    const { credential } = tokenPair();
    const fetchMock = (): Promise<Response> =>
      Promise.resolve(Response.json(
        {
          error: {
            code: "TASK_ALREADY_CLAIMED",
            message: "The task has an active claim.",
            requestId: REQUEST_ID,
            details: { taskKey: "OPS-7K2M4Q9", ownerAgentId: "agent-2" },
          },
        },
        { status: 409 },
      ));
    const client = new TaskctlClient({ apiUrl: "http://127.0.0.1:3211", fetch: fetchMock });
    const result = await client.claimTask(
      { credential, sessionId: SESSION_ID },
      "OPS-7K2M4Q9",
      IDEMPOTENCY_KEY,
    );

    expect(result).toEqual({
      ok: false,
      error: {
        code: "TASK_ALREADY_CLAIMED",
        message: "The task has an active claim.",
        requestId: REQUEST_ID,
        details: { taskKey: "OPS-7K2M4Q9", ownerAgentId: "agent-2" },
      },
    });
  });

  test("does not expose malformed response bodies or fetch failures", async () => {
    const { credential } = tokenPair();
    const malformed = new TaskctlClient({
      apiUrl: "http://127.0.0.1:3211",
      fetch: () => Promise.resolve(new Response(`server accidentally echoed ${credential}`)),
    });
    const malformedResult = await malformed.context({ credential, sessionId: SESSION_ID });
    expect(JSON.stringify(malformedResult)).not.toContain(credential);

    const unreachable = new TaskctlClient({
      apiUrl: "http://127.0.0.1:3211",
      fetch: () => Promise.reject(new Error(`failed with ${credential}`)),
    });
    const unreachableResult = await unreachable.context({ credential, sessionId: SESSION_ID });
    expect(JSON.stringify(unreachableResult)).not.toContain(credential);
  });

  test("streams response bodies with a hard two MiB cap", async () => {
    const { credential } = tokenPair();
    let pulls = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        controller.enqueue(new Uint8Array(1_024 * 1_024));
        if (pulls === 3) controller.close();
      },
    });
    const client = new TaskctlClient({
      apiUrl: "http://127.0.0.1:3211",
      fetch: () => Promise.resolve(new Response(body)),
    });

    const result = await client.context({ credential, sessionId: SESSION_ID });

    expect(result).toMatchObject({ ok: false, error: { code: "SERVICE_UNAVAILABLE" } });
    expect(pulls).toBe(3);
  });

  test("aborts requests at a bounded timeout", async () => {
    const { credential } = tokenPair();
    let aborted = false;
    const client = new TaskctlClient({
      apiUrl: "http://127.0.0.1:3211",
      requestTimeoutMs: 5,
      fetch: (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal;
          if (signal === undefined || signal === null) {
            reject(new Error("missing abort signal"));
            return;
          }
          signal.addEventListener(
            "abort",
            () => {
              aborted = true;
              reject(new DOMException("aborted", "AbortError"));
            },
            { once: true },
          );
        }),
    });

    const result = await client.context({ credential, sessionId: SESSION_ID });

    expect(aborted).toBeTrue();
    expect(result).toMatchObject({
      ok: false,
      error: { code: "SERVICE_UNAVAILABLE", message: "the task service request timed out" },
    });
    expect(() =>
      new TaskctlClient({ apiUrl: "https://example.com", requestTimeoutMs: 60_001 }),
    ).toThrow(TypeError);
  });

  test("refuses 307 and 308 redirects without issuing a follow-up request", async () => {
    const { credential, enrollment } = tokenPair();
    for (const status of [307, 308]) {
      const captures: RequestInit[] = [];
      const client = new TaskctlClient({
        apiUrl: "http://127.0.0.1:3211",
        fetch: (_input, init) => {
          if (init !== undefined) captures.push(init);
          return Promise.resolve(
            new Response(null, {
              status,
              headers: { location: "https://attacker.example/collect" },
            }),
          );
        },
      });

      const result = await client.redeemEnrollment(enrollment, credential, IDEMPOTENCY_KEY);

      expect(result).toMatchObject({ ok: false, error: { code: "SERVICE_UNAVAILABLE" } });
      expect(captures).toHaveLength(1);
      expect(captures[0]?.redirect).toBe("error");
    }
  });

  test("sends graph and review mutations with strict bodies, fencing, and stable headers", async () => {
    const { credential } = tokenPair();
    const captures: { readonly url: URL; readonly init: RequestInit }[] = [];
    const client = new TaskctlClient({
      apiUrl: "http://127.0.0.1:3211",
      fetch: (input, init) => {
        if (init === undefined) throw new Error("request init required");
        captures.push({ url: new URL(inputUrl(input)), init });
        return Promise.resolve(Response.json({ invalid: true }));
      },
    });
    const authorization = { credential, sessionId: SESSION_ID };

    await client.mutateTaskDependency(
      authorization,
      "OPS-7K2M4Q9",
      "add",
      { revision: 2, blockerKey: "OPS-0000001", fence: 7 },
      IDEMPOTENCY_KEY,
    );
    await client.assignTask(
      authorization,
      "OPS-7K2M4Q9",
      { revision: 2, assigneeAgentId: null, fence: 7 },
      IDEMPOTENCY_KEY,
    );
    await client.submitTask(
      authorization,
      "OPS-7K2M4Q9",
      { fence: 7, summary: "done", evidence: [{ kind: "test", command: "bun test" }] },
      IDEMPOTENCY_KEY,
    );
    await client.cancelTask(
      "human-access-token",
      "OPS-7K2M4Q9",
      { workspaceId: "workspace-id", revision: 3, reason: "superseded" },
      IDEMPOTENCY_KEY,
    );

    expect(captures.map((capture) => capture.url.pathname)).toEqual([
      "/v1/tasks/OPS-7K2M4Q9/dependencies",
      "/v1/tasks/OPS-7K2M4Q9/assign",
      "/v1/tasks/OPS-7K2M4Q9/submit",
      "/v1/tasks/OPS-7K2M4Q9/cancel",
    ]);
    expect(JSON.parse(stringBody(captures[0]?.init.body))).toEqual({
      revision: 2,
      blockerKey: "OPS-0000001",
      fence: 7,
    });
    expect(JSON.parse(stringBody(captures[1]?.init.body))).toEqual({
      revision: 2,
      assigneeAgentId: null,
      fence: 7,
    });
    expect(JSON.parse(stringBody(captures[2]?.init.body))).toEqual({
      fence: 7,
      summary: "done",
      evidence: [{ kind: "test", command: "bun test" }],
    });
    expect(JSON.parse(stringBody(captures[3]?.init.body))).toEqual({
      workspaceId: "workspace-id",
      revision: 3,
      reason: "superseded",
    });
    expect(new Headers(captures[0]?.init.headers).get("X-Taskctl-Session")).toBe(SESSION_ID);
    expect(new Headers(captures[3]?.init.headers).has("X-Taskctl-Session")).toBeFalse();
    expect(new Headers(captures[0]?.init.headers).get("Idempotency-Key")).toBe(IDEMPOTENCY_KEY);
  });
});

test("API URLs require TLS except on exact loopback origins", () => {
  expect(normalizeApiUrl("http://127.0.0.1:3211/")).toBe("http://127.0.0.1:3211");
  expect(normalizeApiUrl("http://localhost:3211/")).toBe("http://localhost:3211");
  expect(normalizeApiUrl("http://[::1]:3211/")).toBe("http://[::1]:3211");
  expect(normalizeApiUrl("https://example.com")).toBe("https://example.com");
  expect(normalizeApiUrl("http://example.com")).toBeNull();
  expect(normalizeApiUrl("http://127.0.0.1.example.com")).toBeNull();
  expect(normalizeApiUrl("http://127.0.0.2:3211")).toBeNull();
  expect(normalizeApiUrl("https://user:secret@example.com")).toBeNull();
  expect(normalizeApiUrl("https://example.com/prefix")).toBeNull();
  expect(normalizeApiUrl("https://example.com?token=secret")).toBeNull();
});
