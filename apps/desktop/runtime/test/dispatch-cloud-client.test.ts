import { describe, expect, test } from "bun:test";
import {
  createBearerSecret,
  formatCredentialToken,
  MAX_SERIALIZED_SYNC_RUN_INTERACTIONS_ENVELOPE_BYTES,
  MAX_SERIALIZED_SYNC_RUN_INTERACTIONS_REQUEST_BYTES,
  makeErrorEnvelope,
  RUN_INTERACTION_SEALED_CIPHERTEXT_BASE64URL_CHARACTERS,
  type RunnerHeartbeatRequest,
  type SyncRunInteractionsRequest,
  type SyncRunInteractionsResponse,
} from "@hraness/agent-tasks-protocol";

import {
  HRADispatchHttpClient,
  HRADispatchSessionClient,
  normalizeDispatchApiOrigin,
  type DispatchDeadlineScheduler,
} from "../src/dispatch/cloud-client";

const locator = "0".repeat(26);
const credential = formatCredentialToken(locator, createBearerSecret(new Uint8Array(32)));
const sessionId = `ses_${locator}`;
const requestId = `req_${locator}`;
const maximumSafeInteger = Number.MAX_SAFE_INTEGER;
const heartbeat: RunnerHeartbeatRequest = {
  runnerId: "runner_primary0001",
  installationId: "install_primary001",
  bootId: "boot_primary0001",
  bootGeneration: 1,
  sequence: 1,
  protocolVersion: 1,
  clientVersion: "0.1.0",
  reportedState: "ready",
  capacity: 1,
  activeRuns: 0,
  currentRunIds: [],
  retainedRunIds: [],
  repositoryIds: [`repo_${locator}`],
};

function maximumOpaqueId(prefix: string, suffix = ""): string {
  const stem = `${prefix}_${suffix}`;
  return `${stem}${"a".repeat(128 - stem.length)}`;
}

function maximumInteractionSyncRequest(): SyncRunInteractionsRequest {
  const runnerId = maximumOpaqueId("runner");
  const bootId = maximumOpaqueId("boot");
  const claimId = maximumOpaqueId("claim");
  const escapedText = "\u0000";
  const reply = {
    version: 1 as const,
    algorithm: "P256-HKDF-SHA256-A256GCM" as const,
    keyId: `hitlkey_${"a".repeat(88)}`,
    publicKey: "A".repeat(87),
    runnerId,
    bootId,
    bootGeneration: maximumSafeInteger,
    claimId,
    claimFence: maximumSafeInteger,
    requestDigest: `sha256_${"a".repeat(64)}`,
  };
  return {
    runnerId,
    bootId,
    bootGeneration: maximumSafeInteger,
    claimId,
    claimFence: maximumSafeInteger,
    upserts: Array.from({ length: 8 }, (_, upsertIndex) => ({
      id: maximumOpaqueId("interaction", String(upsertIndex)),
      kind: "user_input" as const,
      createdAt: maximumSafeInteger - 60 * 60 * 1_000,
      expiresAt: maximumSafeInteger,
      questions: Array.from({ length: 3 }, (_, questionIndex) => ({
        id: maximumOpaqueId("question", `${upsertIndex}${questionIndex}`),
        header: escapedText.repeat(64),
        prompt: escapedText.repeat(1_024),
        allowOther: false,
        options: Array.from({ length: 8 }, (_, optionIndex) => ({
          id: maximumOpaqueId(
            "option",
            `${upsertIndex}${questionIndex}${optionIndex}`,
          ),
          label: escapedText.repeat(128),
          description: escapedText.repeat(512),
        })),
      })),
      reply,
    })),
    settlements: Array.from({ length: 8 }, (_, settlementIndex) => ({
      interactionId: maximumOpaqueId("interaction", `z${settlementIndex}`),
      responseRevision: maximumSafeInteger,
      outcome: "expired" as const,
      reason: "provider_expired" as const,
    })),
  };
}

function maximumInteractionSyncResponse(): SyncRunInteractionsResponse {
  const interactionIds = (kind: string) => Array.from(
    { length: 8 },
    (_, index) => maximumOpaqueId("interaction", `${kind}${index}`),
  );
  const acceptedInteractionIds = interactionIds("u");
  const acceptedSettlementIds = interactionIds("s");
  const responseIds = interactionIds("r");
  const expiredIds = interactionIds("e");
  const sealedResponse = {
    version: 1 as const,
    algorithm: "P256-HKDF-SHA256-A256GCM" as const,
    keyId: `hitlkey_${"a".repeat(88)}`,
    workspaceId: "\u0000".repeat(128),
    ephemeralPublicKey: "A".repeat(87),
    nonce: "A".repeat(16),
    ciphertext: "A".repeat(RUN_INTERACTION_SEALED_CIPHERTEXT_BASE64URL_CHARACTERS),
  };
  return {
    serverTime: maximumSafeInteger,
    acceptedInteractionIds,
    acceptedSettlementIds,
    responses: responseIds.map((interactionId) => ({
      interactionId,
      responseRevision: maximumSafeInteger,
      sealedResponse,
    })),
    expiredInteractions: expiredIds.map((interactionId) => ({
      interactionId,
      responseRevision: maximumSafeInteger,
    })),
    hasMoreResponses: false,
  };
}

function json(value: unknown, status = 200, headers?: HeadersInit): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...headers },
  });
}

describe("OPRTE dispatch cloud client", () => {
  test("allows local plaintext development but requires HTTPS remotely", () => {
    expect(normalizeDispatchApiOrigin("http://127.0.0.1:3210")).toBe("http://127.0.0.1:3210");
    expect(normalizeDispatchApiOrigin("http://[::1]:3210")).toBe("http://[::1]:3210");
    expect(normalizeDispatchApiOrigin("https://tasks.example.com")).toBe("https://tasks.example.com");
    expect(normalizeDispatchApiOrigin("http://tasks.example.com")).toBeNull();
    expect(normalizeDispatchApiOrigin("https://user:secret@tasks.example.com")).toBeNull();
    expect(normalizeDispatchApiOrigin("https://tasks.example.com/v1")).toBeNull();
  });

  test("sends credential and session only in headers and parses a strict envelope", async () => {
    const observed: { url: string; headers: Headers; body: unknown; redirect: RequestRedirect | undefined }[] = [];
    const client = new HRADispatchHttpClient({
      apiOrigin: "https://tasks.example.com",
      credential,
      sessionId,
      fetch: (input, init) => {
        observed.push({
          url: typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
          headers: new Headers(init?.headers),
          body: typeof init?.body === "string" ? JSON.parse(init.body) as unknown : null,
          redirect: init?.redirect,
        });
        return Promise.resolve(json({
          ok: true,
          data: {
            serverTime: 1_000,
            leaseUntil: 46_000,
            desiredState: "active",
            candidates: [],
            runLeases: [],
            stopRunIds: [],
            releaseRunIds: [],
          },
          requestId,
        }));
      },
    });
    const result = await client.heartbeat(heartbeat);
    expect(result).toMatchObject({ ok: true, data: { leaseUntil: 46_000 } });
    const request = observed[0];
    expect(request).toBeDefined();
    expect(request?.url).toBe("https://tasks.example.com/v1/runtime/heartbeat");
    expect(request?.headers.get("Authorization")).toBe(`Bearer ${credential}`);
    expect(request?.headers.get("X-Taskctl-Session")).toBe(sessionId);
    expect(request?.body).toEqual(heartbeat);
    expect(request?.redirect).toBe("error");
  });

  test("starts a fresh session with credential-only authorization", async () => {
    const observed: Array<{ url: string; headers: Headers; body: unknown }> = [];
    const idempotencyKey = "0190d75a-b000-7000-8000-000000000009";
    const client = new HRADispatchSessionClient({
      apiOrigin: "https://tasks.example.com",
      credential,
      fetch: (input, init) => {
        observed.push({
          url: typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
          headers: new Headers(init?.headers),
          body: typeof init?.body === "string" ? JSON.parse(init.body) as unknown : null,
        });
        return Promise.resolve(json({
          ok: true,
          data: { sessionId, expiresAt: 90_000 },
          requestId,
        }));
      },
    });

    expect(await client.startSession(idempotencyKey)).toEqual({
      ok: true,
      data: { sessionId, expiresAt: 90_000 },
      requestId,
    });
    expect(observed).toHaveLength(1);
    expect(observed[0]?.url).toBe("https://tasks.example.com/v1/agent/sessions");
    expect(observed[0]?.headers.get("Authorization")).toBe(`Bearer ${credential}`);
    expect(observed[0]?.headers.get("Idempotency-Key")).toBe(idempotencyKey);
    expect(observed[0]?.headers.has("X-Taskctl-Session")).toBeFalse();
    expect(observed[0]?.body).toEqual({});
  });

  test("returns only typed redacted remote failures", async () => {
    const client = new HRADispatchHttpClient({
      apiOrigin: "https://tasks.example.com",
      credential,
      sessionId,
      fetch: () => Promise.resolve(json(makeErrorEnvelope("RATE_LIMITED", requestId, { retryAfterMs: 250 }), 429)),
    });
    const result = await client.heartbeat(heartbeat);
    expect(result).toEqual({
      ok: false,
      error: { kind: "remote", code: "RATE_LIMITED", requestId, retryAfterMs: 250 },
    });
    expect(JSON.stringify(result)).not.toContain(credential);
    expect(JSON.stringify(result)).not.toContain(sessionId);
  });

  test("sends review submission through the fenced idempotent task route", async () => {
    const observed: { url: string; headers: Headers; body: unknown }[] = [];
    const idempotencyKey = "0190d75a-b000-7000-8000-000000000001";
    const client = new HRADispatchHttpClient({
      apiOrigin: "https://tasks.example.com",
      credential,
      sessionId,
      fetch: (input, init) => {
        observed.push({
          url: typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
          headers: new Headers(init?.headers),
          body: typeof init?.body === "string" ? JSON.parse(init.body) as unknown : null,
        });
        return Promise.resolve(json({}));
      },
    });

    expect(await client.submitTask("OPS-7K2M4Q9", {
      fence: 7,
      summary: "Ready for human review.",
      evidence: [{ kind: "note", text: "Managed turn completed." }],
    }, idempotencyKey)).toEqual({ ok: false, error: { kind: "invalid_response" } });

    expect(observed).toHaveLength(1);
    expect(observed[0]?.url).toBe("https://tasks.example.com/v1/tasks/OPS-7K2M4Q9/submit");
    expect(observed[0]?.body).toEqual({
      fence: 7,
      summary: "Ready for human review.",
      evidence: [{ kind: "note", text: "Managed turn completed." }],
    });
    expect(observed[0]?.headers.get("Idempotency-Key")).toBe(idempotencyKey);
    expect(observed[0]?.headers.get("X-Taskctl-Session")).toBe(sessionId);
  });

  test("fails closed on invalid media, schemas, and oversized responses", async () => {
    const responses = [
      new Response("{}", { headers: { "Content-Type": "text/plain" } }),
      json({ ok: true, data: { secret: "not a heartbeat" }, requestId }),
      json({}, 200, { "Content-Length": String(128 * 1_024 + 1) }),
    ];
    const client = new HRADispatchHttpClient({
      apiOrigin: "https://tasks.example.com",
      credential,
      sessionId,
      fetch: () => Promise.resolve(responses.shift() ?? json({})),
    });
    for (let index = 0; index < 3; index += 1) {
      expect(await client.heartbeat(heartbeat)).toEqual({
        ok: false,
        error: { kind: "invalid_response" },
      });
    }
  });

  test("transports exact maximal eight-item interaction request and response batches", async () => {
    const request = maximumInteractionSyncRequest();
    const response = maximumInteractionSyncResponse();
    const responseEnvelope = { ok: true as const, data: response, requestId };
    const requestBytes = new TextEncoder().encode(JSON.stringify(request)).byteLength;
    const responseBytes = new TextEncoder().encode(JSON.stringify(responseEnvelope)).byteLength;
    let observedRequestBytes = 0;
    const client = new HRADispatchHttpClient({
      apiOrigin: "https://tasks.example.com",
      credential,
      sessionId,
      fetch: (_input, init) => {
        if (typeof init?.body === "string") {
          observedRequestBytes = new TextEncoder().encode(init.body).byteLength;
        }
        return Promise.resolve(json(responseEnvelope, 200, {
          "Content-Length": String(responseBytes),
        }));
      },
    });

    expect(requestBytes).toBe(941_452);
    expect(responseBytes).toBe(451_275);
    expect(requestBytes).toBeGreaterThan(128 * 1_024);
    expect(responseBytes).toBeGreaterThan(128 * 1_024);
    expect(requestBytes).toBeLessThanOrEqual(
      MAX_SERIALIZED_SYNC_RUN_INTERACTIONS_REQUEST_BYTES,
    );
    expect(responseBytes).toBeLessThanOrEqual(
      MAX_SERIALIZED_SYNC_RUN_INTERACTIONS_ENVELOPE_BYTES,
    );

    const result = await client.syncInteractions("run_maximum0001", request);
    expect(result).toEqual({ ok: true, data: response, requestId });
    expect(observedRequestBytes).toBe(requestBytes);
  });

  test("bounds a fetch that ignores abort and reports no transport detail", async () => {
    let callback: (() => void) | undefined;
    let fetchSignal: AbortSignal | undefined;
    const deadlines: DispatchDeadlineScheduler = {
      after(_milliseconds, scheduled) {
        callback = scheduled;
        return { cancel() {} };
      },
    };
    const client = new HRADispatchHttpClient({
      apiOrigin: "https://tasks.example.com",
      credential,
      sessionId,
      deadlines,
      fetch: (_input, init) => {
        fetchSignal = init?.signal ?? undefined;
        return new Promise<Response>(() => undefined);
      },
    });
    const pending = client.heartbeat(heartbeat);
    callback?.();
    expect(await pending).toEqual({ ok: false, error: { kind: "timeout" } });
    expect(fetchSignal?.aborted).toBeTrue();
  });
});
