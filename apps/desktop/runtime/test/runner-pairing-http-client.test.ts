import { describe, expect, test } from "bun:test";
import {
  agentPresetScopes,
  createBearerSecret,
  createLocator,
  formatCredentialToken,
  formatEnrollmentToken,
  parseCredentialToken,
  parseEnrollmentToken,
  taskctlHeaders,
} from "@hraness/agent-tasks-protocol";
import {
  HumanSessionCoordinator,
  humanAuthenticationSnapshotSchema,
  type HumanAuthenticationStore,
} from "@hraness/hra-human-client";

import {
  CloudWorkspaceClient,
  HRAHumanHttpTransport,
  hraHumanRefreshDriver,
} from "../src/cloud";

const LOCATOR = "0123456789ABCDEFGHJKMNPQRS";
const OTHER_LOCATOR = "1123456789ABCDEFGHJKMNPQRS";
const WORKSPACE_ID = `wsp_${LOCATOR}`;
const PROMOTION_ID = `promotion_${LOCATOR}`;
const AGENT_ID = `imported_local_codex_${PROMOTION_ID}`;
const REQUEST_ID = `req_${LOCATOR}`;
const SESSION_ID = `ses_${LOCATOR}`;
const HUMAN_TOKEN = "human-access-token-that-remains-in-custody";
const ENROLLMENT = formatEnrollmentToken(
  createLocator(Uint8Array.from({ length: 26 }, (_, index) => index)),
  createBearerSecret(
    Uint8Array.from({ length: 32 }, (_, index) => index + 40),
  ),
);
const CREDENTIAL = formatCredentialToken(
  createLocator(
    Uint8Array.from({ length: 26 }, (_, index) => index + 80),
  ),
  createBearerSecret(
    Uint8Array.from({ length: 32 }, (_, index) => index + 120),
  ),
);
const IDEMPOTENCY_KEYS = [
  "018f22c0-6b3c-7a91-8abc-123456789abc",
  "018f22c0-6b3c-7a91-8abc-123456789abd",
  "018f22c0-6b3c-7a91-8abc-123456789abe",
] as const;

function response(data: unknown): Response {
  return new Response(JSON.stringify({
    ok: true,
    data,
    requestId: REQUEST_ID,
  }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function signedInStore(): HumanAuthenticationStore {
  const snapshot = humanAuthenticationSnapshotSchema.parse({
    generation: 1,
    authentication: {
      version: 1,
      apiUrl: "https://oprte.example.com",
      accessToken: HUMAN_TOKEN,
      refreshToken: "human-refresh-token-that-remains-in-custody",
      user: {
        id: "user_01ARZ3NDEKTSV4RRFFQ69G5FAV",
        email: "chef@example.com",
      },
    },
  });
  return {
    read: () => Promise.resolve(snapshot),
    compareAndSwap: () => Promise.resolve(null),
    clear: () => Promise.resolve(false),
  };
}

describe("runner pairing HTTP client", () => {
  test("binds the human enrollment, enrollment redemption, and agent session routes exactly", async () => {
    const requests: Request[] = [];
    const enrollmentLocator = parseEnrollmentToken(ENROLLMENT)?.locator;
    const credentialLocator = parseCredentialToken(CREDENTIAL)?.locator;
    if (enrollmentLocator === undefined || credentialLocator === undefined) {
      throw new Error("token fixture is invalid");
    }
    const responses = [
      response({
        enrollment: {
          locator: enrollmentLocator,
          expiresAt: 2_000_003_600_000,
        },
      }),
      response({
        agentId: AGENT_ID,
        credentialId: credentialLocator,
        credentialExpiresAt: 2_000_086_400_000,
        scopes: [...agentPresetScopes.dispatcher],
      }),
      response({
        sessionId: SESSION_ID,
        expiresAt: 2_000_003_600_000,
      }),
    ];
    const transport = new HRAHumanHttpTransport({
      apiUrl: "https://oprte.example.com",
      fetch: (input, init) => {
        requests.push(new Request(input, init));
        const next = responses.shift();
        if (next === undefined) throw new Error("response fixture exhausted");
        return Promise.resolve(next);
      },
    });
    const client = new CloudWorkspaceClient({
      transport,
      session: new HumanSessionCoordinator({
        store: signedInStore(),
        refresh: hraHumanRefreshDriver(transport),
      }),
    });

    expect(await client.createAgentEnrollment(AGENT_ID, {
      workspaceId: WORKSPACE_ID,
      enrollment: ENROLLMENT,
      idempotencyKey: IDEMPOTENCY_KEYS[0],
    })).toMatchObject({ ok: true });
    expect(await client.redeemRunnerEnrollment(ENROLLMENT, {
      agentId: AGENT_ID,
      credential: CREDENTIAL,
      idempotencyKey: IDEMPOTENCY_KEYS[1],
    })).toMatchObject({ ok: true });
    expect(await client.startRunnerSession(
      CREDENTIAL,
      IDEMPOTENCY_KEYS[2],
    )).toMatchObject({
      ok: true,
      data: { sessionId: SESSION_ID },
    });

    expect(requests.map((request) => request.url)).toEqual([
      `https://oprte.example.com/v1/agents/${AGENT_ID}/enrollments`,
      "https://oprte.example.com/v1/agent/enrollments/redeem",
      "https://oprte.example.com/v1/agent/sessions",
    ]);
    expect(requests.map((request) =>
      request.headers.get(taskctlHeaders.authorization)
    )).toEqual([
      `Bearer ${HUMAN_TOKEN}`,
      `Bearer ${ENROLLMENT}`,
      `Bearer ${CREDENTIAL}`,
    ]);
    expect(requests.map((request) =>
      request.headers.get(taskctlHeaders.idempotencyKey)
    )).toEqual([...IDEMPOTENCY_KEYS]);
    expect(await requests[0]?.json()).toEqual({
      workspaceId: WORKSPACE_ID,
      enrollment: ENROLLMENT,
    });
    expect(await requests[1]?.json()).toEqual({
      credential: CREDENTIAL,
    });
    expect(await requests[2]?.json()).toEqual({});
    for (const request of requests) {
      expect(request.url).not.toContain(ENROLLMENT);
      expect(request.url).not.toContain(CREDENTIAL);
    }
  });

  test("fails closed on response locator and principal substitution without echoing bearers", async () => {
    const responses = [
      response({
        enrollment: {
          locator: OTHER_LOCATOR,
          expiresAt: 2_000_003_600_000,
        },
      }),
      response({
        agentId: "another-agent",
        credentialId: OTHER_LOCATOR,
        credentialExpiresAt: 2_000_086_400_000,
        scopes: [...agentPresetScopes.dispatcher],
      }),
    ];
    const transport = new HRAHumanHttpTransport({
      apiUrl: "https://oprte.example.com",
      fetch: () => {
        const next = responses.shift();
        if (next === undefined) throw new Error("response fixture exhausted");
        return Promise.resolve(next);
      },
    });

    const results = [
      await transport.createAgentEnrollment(HUMAN_TOKEN, AGENT_ID, {
        workspaceId: WORKSPACE_ID,
        enrollment: ENROLLMENT,
        idempotencyKey: IDEMPOTENCY_KEYS[0],
      }),
      await transport.redeemRunnerEnrollment(ENROLLMENT, {
        agentId: AGENT_ID,
        credential: CREDENTIAL,
        idempotencyKey: IDEMPOTENCY_KEYS[1],
      }),
    ];
    for (const result of results) {
      expect(result).toMatchObject({
        ok: false,
        error: { code: "SERVICE_UNAVAILABLE" },
      });
      expect(JSON.stringify(result)).not.toContain(HUMAN_TOKEN);
      expect(JSON.stringify(result)).not.toContain(ENROLLMENT);
      expect(JSON.stringify(result)).not.toContain(CREDENTIAL);
    }
  });
});
