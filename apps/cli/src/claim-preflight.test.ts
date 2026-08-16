import { describe, expect, test } from "bun:test";
import {
  AGENT_SESSION_HEARTBEAT_MS,
  AGENT_SESSION_IDLE_MS,
  CLAIM_RENEWAL_THRESHOLD_MS,
  DEFAULT_CLAIM_LEASE_MS,
  createBearerSecret,
  createLocator,
  formatCredentialToken,
  safeErrorMessage,
  type ClaimTaskResponse,
  type ContextResponse,
  type ErrorCode,
  type GetTaskResponse,
  type IdempotencyKey,
  type SessionId,
  type TaskKey,
} from "@hraness/agent-tasks-protocol";

import {
  executeClaimBoundCommand,
  type ClaimPreflightClient,
  type OwnedClaimContext,
} from "./claim-preflight";
import type { AgentAuthorization, ClientResult } from "./client";

const SERVER_NOW = 1_800_000_000_000;
const REQUEST_ID = "req_00000000000000000000000000";
const RENEW_REQUEST_ID = "req_00000000000000000000000001";
const SESSION_ID: SessionId = "ses_00000000000000000000000000";
const KEY: TaskKey = "OPS-7K2M4Q9";
const RENEWAL_KEY: IdempotencyKey = "018f22e2-7b44-7cc0-8e5d-657f31f9064a";

const authorization: AgentAuthorization = {
  credential: formatCredentialToken(
    createLocator(Uint8Array.from({ length: 26 }, (_, index) => index)),
    createBearerSecret(Uint8Array.from({ length: 32 }, (_, index) => index + 40)),
  ),
  sessionId: SESSION_ID,
};

const openTask = {
  id: "tsk_01ARZ3NDEKTSV4RRFFQ69G5FAV",
  key: KEY,
  title: "Automatic renewal",
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

function inProgressTask(
  leaseUntil: number,
  options: {
    readonly revision?: number;
    readonly fence?: number;
    readonly leaseGeneration?: number;
    readonly agentId?: string;
  } = {},
) {
  return {
    ...openTask,
    status: "in_progress" as const,
    isReady: false,
    revision: options.revision ?? 2,
    currentClaim: {
      id: "claim-1",
      agentId: options.agentId ?? "agent-1",
      fence: options.fence ?? 7,
      leaseGeneration: options.leaseGeneration ?? 3,
      leaseUntil,
    },
  };
}

function context(agentId = "agent-1"): ContextResponse {
  return {
    principal: {
      kind: "agent",
      agentId,
      name: "worker",
      scopes: ["tasks:read", "tasks:edit", "tasks:claim"],
      sessionId: SESSION_ID,
    },
    organization: { id: "organization-1", name: "Hraness" },
    workspace: { id: "workspace-1", slug: "core", name: "Core" },
    serverTime: SERVER_NOW,
    defaults: {
      claimLeaseMs: DEFAULT_CLAIM_LEASE_MS,
      claimRenewalThresholdMs: CLAIM_RENEWAL_THRESHOLD_MS,
      sessionIdleMs: AGENT_SESSION_IDLE_MS,
      sessionHeartbeatMs: AGENT_SESSION_HEARTBEAT_MS,
    },
    counts: { readyTasks: 0, activeClaims: 1, reviewRequests: 0 },
    readyTasks: [],
    activeClaims: [],
    reviewRequests: [],
    cursors: { readyTasks: null, activeClaims: null, reviewRequests: null },
    workflowRules: ["Renew before claim-bound work."],
  };
}

function success<Value>(data: Value, requestId = REQUEST_ID): ClientResult<Value> {
  return { ok: true, data, requestId };
}

function failure(code: ErrorCode): ClientResult<never> {
  return {
    ok: false,
    error: {
      code,
      message: safeErrorMessage[code],
      details: code === "RATE_LIMITED" ? { retryAfterMs: 1_000 } : {},
      requestId: REQUEST_ID,
    },
  };
}

class FakeClaimClient implements ClaimPreflightClient {
  readonly calls: string[] = [];
  readonly renewalRequests: { readonly fence: number; readonly idempotencyKey: IdempotencyKey }[] = [];
  readonly detail: ClientResult<GetTaskResponse>;
  readonly currentContext: ClientResult<ContextResponse>;
  readonly renewal: ClientResult<ClaimTaskResponse>;

  constructor(
    detail: ClientResult<GetTaskResponse>,
    currentContext: ClientResult<ContextResponse> = success(context()),
    renewal: ClientResult<ClaimTaskResponse> = success(
      { task: inProgressTask(SERVER_NOW + DEFAULT_CLAIM_LEASE_MS) },
      RENEW_REQUEST_ID,
    ),
  ) {
    this.detail = detail;
    this.currentContext = currentContext;
    this.renewal = renewal;
  }

  getTask(): Promise<ClientResult<GetTaskResponse>> {
    this.calls.push("detail");
    return Promise.resolve(this.detail);
  }

  context(): Promise<ClientResult<ContextResponse>> {
    this.calls.push("context");
    return Promise.resolve(this.currentContext);
  }

  renewClaim(
    _authorization: AgentAuthorization,
    _key: TaskKey,
    request: { readonly fence: number },
    idempotencyKey: IdempotencyKey,
  ): Promise<ClientResult<ClaimTaskResponse>> {
    this.calls.push("renew");
    this.renewalRequests.push({ fence: request.fence, idempotencyKey });
    return Promise.resolve(this.renewal);
  }
}

async function execute(
  client: FakeClaimClient,
  target: (claim: OwnedClaimContext | null) => ClientResult<{ readonly dispatched: true }> =
    () => success({ dispatched: true as const }),
) {
  return await executeClaimBoundCommand({
    client,
    authorization,
    key: KEY,
    renewalIdempotencyKey: () => RENEWAL_KEY,
    target: (claim) => {
      client.calls.push("target");
      return Promise.resolve(target(claim));
    },
  });
}

describe("claim-bound command preflight", () => {
  test("dispatches an open-task command without a context or renewal request", async () => {
    const client = new FakeClaimClient(
      success({ task: openTask, description: "", labels: [] }),
    );
    let observed: OwnedClaimContext | null | undefined;

    const result = await execute(client, (claim) => {
      observed = claim;
      return success({ dispatched: true });
    });

    expect(result.result.ok).toBeTrue();
    expect(observed).toBeNull();
    expect(client.calls).toEqual(["detail", "target"]);
  });

  test("uses the authoritative current tuple without renewal above five minutes", async () => {
    const task = inProgressTask(SERVER_NOW + CLAIM_RENEWAL_THRESHOLD_MS + 1, {
      revision: 11,
      fence: 9,
      leaseGeneration: 4,
    });
    const client = new FakeClaimClient(
      success({ task, description: "", labels: [] }),
    );
    let observed: OwnedClaimContext | null | undefined;

    const result = await execute(client, (claim) => {
      observed = claim;
      return success({ dispatched: true });
    });

    expect(observed).toEqual({
      revision: 11,
      fence: 9,
      leaseGeneration: 4,
      leaseUntil: SERVER_NOW + CLAIM_RENEWAL_THRESHOLD_MS + 1,
    });
    expect(result.automaticClaimRenewal).toBeUndefined();
    expect(client.calls).toEqual(["detail", "context", "target"]);
  });

  test("renews exactly once at five minutes and dispatches with the renewed tuple", async () => {
    const current = inProgressTask(SERVER_NOW + CLAIM_RENEWAL_THRESHOLD_MS, {
      revision: 4,
      fence: 7,
      leaseGeneration: 2,
    });
    const renewed = inProgressTask(SERVER_NOW + DEFAULT_CLAIM_LEASE_MS, {
      revision: 5,
      fence: 7,
      leaseGeneration: 3,
    });
    const client = new FakeClaimClient(
      success({ task: current, description: "", labels: [] }),
      success(context()),
      success({ task: renewed }, RENEW_REQUEST_ID),
    );
    let observed: OwnedClaimContext | null | undefined;

    const result = await execute(client, (claim) => {
      observed = claim;
      return success({ dispatched: true });
    });

    expect(client.calls).toEqual(["detail", "context", "renew", "target"]);
    expect(client.renewalRequests).toEqual([{ fence: 7, idempotencyKey: RENEWAL_KEY }]);
    expect(observed).toEqual({
      revision: 5,
      fence: 7,
      leaseGeneration: 3,
      leaseUntil: SERVER_NOW + DEFAULT_CLAIM_LEASE_MS,
    });
    expect(result.automaticClaimRenewal).toEqual({
      revision: 5,
      fence: 7,
      leaseGeneration: 3,
      leaseUntil: SERVER_NOW + DEFAULT_CLAIM_LEASE_MS,
      idempotencyKey: RENEWAL_KEY,
      requestId: RENEW_REQUEST_ID,
    });
  });

  test.each(["CLAIM_STALE", "AUTHENTICATION_FAILED", "RATE_LIMITED"] as const)(
    "aborts the target when renewal returns %s",
    async (code) => {
      const current = inProgressTask(SERVER_NOW + CLAIM_RENEWAL_THRESHOLD_MS);
      const client = new FakeClaimClient(
        success({ task: current, description: "", labels: [] }),
        success(context()),
        failure(code),
      );

      const result = await execute(client);

      expect(result.result).toMatchObject({ ok: false, error: { code } });
      expect(result.failureIdempotencyKey).toBe(RENEWAL_KEY);
      expect(client.calls).toEqual(["detail", "context", "renew"]);
    },
  );

  test.each([
    [
      "changed fence",
      inProgressTask(SERVER_NOW + DEFAULT_CLAIM_LEASE_MS, {
        revision: 5,
        fence: 8,
        leaseGeneration: 3,
      }),
    ],
    [
      "skipped lease generation",
      inProgressTask(SERVER_NOW + DEFAULT_CLAIM_LEASE_MS, {
        revision: 5,
        fence: 7,
        leaseGeneration: 4,
      }),
    ],
    [
      "non-advancing deadline",
      inProgressTask(SERVER_NOW + CLAIM_RENEWAL_THRESHOLD_MS, {
        revision: 5,
        fence: 7,
        leaseGeneration: 3,
      }),
    ],
    [
      "skipped task revision",
      inProgressTask(SERVER_NOW + DEFAULT_CLAIM_LEASE_MS, {
        revision: 6,
        fence: 7,
        leaseGeneration: 3,
      }),
    ],
  ] as const)("fails closed when renewal returns a %s", async (_label, renewed) => {
    const current = inProgressTask(SERVER_NOW + CLAIM_RENEWAL_THRESHOLD_MS, {
      revision: 4,
      fence: 7,
      leaseGeneration: 2,
    });
    const client = new FakeClaimClient(
      success({ task: current, description: "", labels: [] }),
      success(context()),
      success({ task: renewed }, RENEW_REQUEST_ID),
    );

    const result = await execute(client);

    expect(result.result).toEqual({
      ok: false,
      error: {
        code: "SERVICE_UNAVAILABLE",
        message: safeErrorMessage.SERVICE_UNAVAILABLE,
        details: {},
      },
    });
    expect(result.failureIdempotencyKey).toBe(RENEWAL_KEY);
    expect(client.calls).toEqual(["detail", "context", "renew"]);
  });

  test("aborts with CLAIM_NOT_OWNED before forwarding another agent's fence", async () => {
    const client = new FakeClaimClient(
      success({
        task: inProgressTask(SERVER_NOW + DEFAULT_CLAIM_LEASE_MS, {
          agentId: "agent-2",
          fence: 99,
        }),
        description: "",
        labels: [],
      }),
    );

    const result = await execute(client);

    expect(result.result).toEqual({
      ok: false,
      error: {
        code: "CLAIM_NOT_OWNED",
        message: safeErrorMessage.CLAIM_NOT_OWNED,
        details: { taskKey: KEY, fence: 99 },
      },
    });
    expect(client.calls).toEqual(["detail", "context"]);
    expect(client.renewalRequests).toEqual([]);
  });
});
