import { describe, expect, test } from "bun:test";
import {
  HumanSessionCoordinator,
  humanAuthenticationSnapshotSchema,
  type HumanAuthenticationStore,
} from "@hraness/hra-human-client";
import {
  hraProjectionCursorSchema,
  type WorkspaceSummary,
} from "@hraness/agent-tasks-protocol";

import {
  CloudWorkspaceClient,
  HRAHumanHttpTransport,
  hraHumanRefreshDriver,
} from "../src/cloud";

const LOCATOR = "0123456789ABCDEFGHJKMNPQRS";
const OTHER_LOCATOR = "1123456789ABCDEFGHJKMNPQRS";
const WORKSPACE_ID = `wsp_${LOCATOR}`;
const OTHER_WORKSPACE_ID = `wsp_${OTHER_LOCATOR}`;
const REQUEST_ID = `req_${LOCATOR}`;
const TOKEN = "human-access-token-that-is-never-returned";
const REQUEST_DIGEST = `sha256_${"a".repeat(64)}`;

function counts(): WorkspaceSummary["counts"] {
  return {
    all: { capped: false, value: 1 },
    ready: { capped: false, value: 1 },
    blocked: { capped: false, value: 0 },
    deferred: { capped: false, value: 0 },
    attention: { capped: false, value: 0 },
    assigned: { capped: false, value: 0 },
    review: { capped: false, value: 0 },
  };
}

function workspace(id = WORKSPACE_ID): WorkspaceSummary {
  return {
    id,
    name: "OPRTE",
    slug: "oprte",
    keyPrefix: "KIT",
    revision: 1,
    authority: { kind: "cloud", cloudWorkspaceId: id },
    counts: counts(),
  };
}

function interactionReplyAuthority(
  overrides: Readonly<Record<string, unknown>> = {},
) {
  return {
    workspaceId: WORKSPACE_ID,
    runId: "run_cloud000001",
    interactionId: "interaction_cloud001",
    requestDigest: REQUEST_DIGEST,
    projectionHead: 7,
    request: {
      id: "interaction_cloud001",
      kind: "file_change_approval" as const,
      scope: "once" as const,
      createdAt: 1_000,
      expiresAt: 61_000,
      reply: {
        version: 1 as const,
        algorithm: "P256-HKDF-SHA256-A256GCM" as const,
        keyId: `hitlkey_${"a".repeat(24)}`,
        publicKey: "A".repeat(87),
        runnerId: "runner_cloud0001",
        bootId: "boot_cloud000001",
        bootGeneration: 3,
        claimId: "claim_cloud00001",
        claimFence: 7,
        requestDigest: REQUEST_DIGEST,
      },
    },
    ...overrides,
  };
}

function jsonResponse(
  value: unknown,
  options: { readonly status?: number; readonly headers?: HeadersInit } = {},
): Response {
  return new Response(JSON.stringify(value), {
    status: options.status ?? 200,
    headers: {
      "Content-Type": "application/json",
      ...options.headers,
    },
  });
}

describe("strict OPRTE cloud HTTP transport", () => {
  test("parses a bound workspace page and sends bearer credentials only in the header", async () => {
    const requests: Request[] = [];
    const transport = new HRAHumanHttpTransport({
      apiUrl: "https://hra.example.com",
      fetch: (input, init) => {
        const request = new Request(input, init);
        requests.push(request);
        return Promise.resolve(jsonResponse({
          ok: true,
          data: { workspaces: [workspace()], cursor: null },
          requestId: REQUEST_ID,
        }));
      },
    });

    const result = await transport.listWorkspaces(TOKEN, { limit: 25 });
    expect(result).toEqual({
      ok: true,
      data: { workspaces: [workspace()], cursor: null },
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe(
      "https://hra.example.com/v1/hra/workspaces?limit=25",
    );
    expect(requests[0]?.headers.get("authorization")).toBe(`Bearer ${TOKEN}`);
    expect(requests[0]?.url).not.toContain(TOKEN);
    expect(await requests[0]?.text()).toBe("");
  });

  test("threads caller cancellation into a workspace-list request", async () => {
    const observedSignal: { current: AbortSignal | null } = { current: null };
    const transport = new HRAHumanHttpTransport({
      apiUrl: "https://hra.example.com",
      fetch: (_input, init) => {
        observedSignal.current = init?.signal ?? null;
        return new Promise<Response>((_resolve, reject) => {
          observedSignal.current?.addEventListener("abort", () => {
            reject(new Error("workspace list aborted"));
          }, { once: true });
        });
      },
    });
    const controller = new AbortController();
    const pending = transport.listWorkspaces(TOKEN, {
      limit: 25,
      signal: controller.signal,
    });
    await Promise.resolve();
    controller.abort(new Error("attention budget exhausted"));

    expect(await pending).toMatchObject({
      ok: false,
      error: { code: "SERVICE_UNAVAILABLE" },
    });
    expect(observedSignal.current?.aborted).toBe(true);
  });

  test("rejects redirect, oversized, malformed, and route-mismatched responses without echoing secrets", async () => {
    const secret = "refresh-token-that-must-never-be-diagnostic-output";
    const responses = [
      new Response(null, {
        status: 302,
        headers: { Location: "https://attacker.example.com" },
      }),
      jsonResponse({}, {
        headers: { "Content-Length": String(3 * 1_024 * 1_024) },
      }),
      jsonResponse({
        error: {
          accessToken: TOKEN,
          refreshToken: secret,
        },
      }, { status: 500 }),
      jsonResponse({
        ok: true,
        data: { workspace: workspace(OTHER_WORKSPACE_ID) },
        requestId: REQUEST_ID,
      }),
    ];
    const transport = new HRAHumanHttpTransport({
      apiUrl: "https://hra.example.com",
      fetch: () => {
        const response = responses.shift();
        if (response === undefined) throw new Error("response fixture exhausted");
        return Promise.resolve(response);
      },
    });

    const redirect = await transport.listWorkspaces(TOKEN);
    const oversized = await transport.listWorkspaces(TOKEN);
    const malformed = await transport.listWorkspaces(TOKEN);
    const mismatched = await transport.getWorkspace(TOKEN, WORKSPACE_ID);
    for (const result of [redirect, oversized, malformed, mismatched]) {
      expect(result).toMatchObject({
        ok: false,
        error: { code: "SERVICE_UNAVAILABLE" },
      });
      expect(JSON.stringify(result)).not.toContain(TOKEN);
      expect(JSON.stringify(result)).not.toContain(secret);
      expect(JSON.stringify(result)).not.toContain("attacker.example.com");
    }
  });

  test("rejects a cursor bound to another workspace before any network call", () => {
    let requests = 0;
    const transport = new HRAHumanHttpTransport({
      apiUrl: "https://hra.example.com",
      fetch: () => {
        requests += 1;
        return Promise.reject(new Error("network must not run"));
      },
    });
    const cursor = hraProjectionCursorSchema.parse({
      version: 1,
      token: `kitchen_cursor_v1_${LOCATOR}`,
      workspaceId: OTHER_WORKSPACE_ID,
      projectionHead: 7,
      scope: { kind: "repositories" },
    });

    expect(() =>
      transport.listRepositories(TOKEN, WORKSPACE_ID, { cursor }))
      .toThrow("another projection");
    expect(requests).toBe(0);
  });

  test("loads only the exact routed interaction reply authority", async () => {
    const requests: Request[] = [];
    const responses = [
      interactionReplyAuthority(),
      interactionReplyAuthority({ runId: "run_cloud000002" }),
      interactionReplyAuthority({
        requestDigest: `sha256_${"b".repeat(64)}`,
        request: {
          ...interactionReplyAuthority().request,
          reply: {
            ...interactionReplyAuthority().request.reply,
            requestDigest: `sha256_${"b".repeat(64)}`,
          },
        },
      }),
      interactionReplyAuthority({ projectionHead: 8 }),
    ];
    const transport = new HRAHumanHttpTransport({
      apiUrl: "https://hra.example.com",
      fetch: (input, init) => {
        requests.push(new Request(input, init));
        const data = responses.shift();
        if (data === undefined) throw new Error("response fixture exhausted");
        return Promise.resolve(jsonResponse({
          ok: true,
          data,
          requestId: REQUEST_ID,
        }));
      },
    });
    const route = {
      workspaceId: WORKSPACE_ID,
      runId: "run_cloud000001",
      interactionId: "interaction_cloud001",
    };
    const query = { requestDigest: REQUEST_DIGEST, projectionHead: 7 };

    expect(await transport.getInteractionReplyAuthority(
      TOKEN,
      route,
      query,
    )).toEqual({
      ok: true,
      data: interactionReplyAuthority(),
    });
    for (let index = 0; index < 3; index += 1) {
      expect(await transport.getInteractionReplyAuthority(
        TOKEN,
        route,
        query,
      )).toMatchObject({
        ok: false,
        error: { code: "SERVICE_UNAVAILABLE" },
      });
    }
    expect(requests[0]?.url).toBe(
      `https://hra.example.com/v1/hra/workspaces/${WORKSPACE_ID}` +
        "/runs/run_cloud000001/interactions/interaction_cloud001/reply-authority" +
        `?requestDigest=${REQUEST_DIGEST}&projectionHead=7`,
    );
    expect(requests[0]?.headers.get("authorization")).toBe(`Bearer ${TOKEN}`);
    expect(JSON.stringify(requests)).not.toContain("decision");
  });

  test("rejects continuation pages that change the cursor projection head", async () => {
    const responses = [
      {
        workspaceId: WORKSPACE_ID,
        projectionHead: 8,
        repositories: [],
        cursor: null,
      },
      {
        page: {
          workspaceId: WORKSPACE_ID,
          view: "all" as const,
          projectionRevision: 8,
          items: [],
          cursor: null,
          hasMore: false,
        },
        cursor: null,
      },
      {
        workspaceId: WORKSPACE_ID,
        afterProjectionHead: 5,
        projectionHead: 8,
        invalidations: [],
        cursor: null,
        hasMore: false,
      },
    ];
    const transport = new HRAHumanHttpTransport({
      apiUrl: "https://hra.example.com",
      fetch: () => {
        const data = responses.shift();
        if (data === undefined) throw new Error("response fixture exhausted");
        return Promise.resolve(jsonResponse({
          ok: true,
          data,
          requestId: REQUEST_ID,
        }));
      },
    });
    const repositoryCursor = hraProjectionCursorSchema.parse({
      version: 1,
      token: `kitchen_cursor_v1_${LOCATOR}repo`,
      workspaceId: WORKSPACE_ID,
      projectionHead: 7,
      scope: { kind: "repositories" },
    });
    const taskCursor = hraProjectionCursorSchema.parse({
      version: 1,
      token: `kitchen_cursor_v1_${LOCATOR}task`,
      workspaceId: WORKSPACE_ID,
      projectionHead: 7,
      scope: { kind: "task_list", view: "all" },
    });
    const invalidationCursor = hraProjectionCursorSchema.parse({
      version: 1,
      token: `kitchen_cursor_v1_${LOCATOR}invalidations`,
      workspaceId: WORKSPACE_ID,
      projectionHead: 7,
      scope: { kind: "invalidations" },
    });

    const results = [
      await transport.listRepositories(TOKEN, WORKSPACE_ID, {
        cursor: repositoryCursor,
      }),
      await transport.listTasks(TOKEN, WORKSPACE_ID, {
        view: "all",
        cursor: taskCursor,
      }),
      await transport.pollInvalidations(TOKEN, WORKSPACE_ID, {
        afterProjectionHead: 5,
        cursor: invalidationCursor,
        waitMs: 0,
      }),
    ];
    for (const result of results) {
      expect(result).toMatchObject({
        ok: false,
        error: { code: "SERVICE_UNAVAILABLE" },
      });
    }
  });

  test("a signed-out cloud client returns before transport invocation", async () => {
    let requests = 0;
    const store: HumanAuthenticationStore = {
      read: () => Promise.resolve(null),
      compareAndSwap: () => Promise.resolve(null),
      preserveForRecovery: () => Promise.resolve(false),
      clear: () => Promise.resolve(false),
    };
    const transport = new HRAHumanHttpTransport({
      apiUrl: "https://hra.example.com",
      fetch: () => {
        requests += 1;
        return Promise.reject(new Error("network must not run"));
      },
    });
    const session = new HumanSessionCoordinator({
      store,
      refresh: hraHumanRefreshDriver(transport),
    });
    const client = new CloudWorkspaceClient({ session, transport });

    expect(await client.listWorkspaces()).toEqual({
      ok: false,
      kind: "session",
      error: {
        code: "SIGNED_OUT",
        message: "no human account is signed in",
      },
    });
    expect(requests).toBe(0);
  });

  test("does not replay a head-bound mutation after a lost response", async () => {
    let requests = 0;
    const snapshot = humanAuthenticationSnapshotSchema.parse({
      generation: 4,
      authentication: {
        version: 2,
        apiUrl: "https://hra.example.com",
        accessToken: TOKEN,
        refreshToken: "refresh-token-that-remains-inside-custody",
        user: {
          id: "usr_01ARZ3NDEKTSV4RRFFQ69G5FAV",
          email: "chef@example.com",
        },
        organization: {
          id: "org_oprte",
          name: "OPRTE",
          role: "owner",
          status: "active",
        },
      },
    });
    const store: HumanAuthenticationStore = {
      read: () => Promise.resolve(snapshot),
      compareAndSwap: () => Promise.resolve(null),
      preserveForRecovery: () => Promise.resolve(false),
      clear: () => Promise.resolve(false),
    };
    const transport = new HRAHumanHttpTransport({
      apiUrl: "https://hra.example.com",
      fetch: () => {
        requests += 1;
        return Promise.reject(new Error("response lost after commit"));
      },
    });
    const client = new CloudWorkspaceClient({
      transport,
      session: new HumanSessionCoordinator({
        store,
        refresh: hraHumanRefreshDriver(transport),
      }),
    });

    expect(await client.mutate(WORKSPACE_ID, {
      expectedProjectionHead: 7,
      intent: {
        kind: "workspace.rename",
        operationId: `op_${LOCATOR}`,
        expectedWorkspaceRevision: 3,
        name: "Renamed OPRTE",
      },
      idempotencyKey: "018f22c0-6b3c-7a91-8abc-123456789abc", // gitleaks:allow - deterministic test vector
    })).toMatchObject({
      ok: false,
      kind: "operation",
      error: { code: "SERVICE_UNAVAILABLE" },
    });
    expect(requests).toBe(1);
  });
});
