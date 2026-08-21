import { describe, expect, test } from "bun:test";

import {
  agentPresetScopes,
  agentCredentialRouteParamsSchema,
  agentCredentialViewSchema,
  agentLifecycleViewSchema,
  agentRouteParamsSchema,
  classifyIdempotencyKey,
  createAgentRequestSchema,
  createBearerSecret,
  createLocator,
  createOpaqueId,
  createUuidV7,
  createTaskResponseSchema,
  desktopPairingChallengeSchema,
  desktopPairingRedeemResponseSchema,
  desktopPairingStartResponseSchema,
  desktopPairingVerifierSchema,
  DEFAULT_AGENT_CREDENTIAL_LIFETIME_MS,
  credentialTokenSchema,
  decodeBearerSecret,
  errorCodeValues,
  errorEnvelopeSchema,
  errorExitCode,
  errorHttpStatus,
  makeErrorEnvelope,
  MAX_AGENT_CREDENTIAL_LIFETIME_MS,
  MIN_AGENT_CREDENTIAL_LIFETIME_MS,
  formatCredentialToken,
  formatEnrollmentToken,
  parseCredentialToken,
  parseEnrollmentToken,
  phaseOneTaskEventByTransition,
  phaseOneSecurityEventByTransition,
  organizationViewSchema,
  listAgentsQuerySchema,
  activeAgentSessionViewSchema,
  readyTasksQuerySchema,
  redactSecret,
  redactSecretsInText,
  taskKeySchema,
  taskEventSchema,
  taskStatusValues,
  taskTitleSchema,
  taskViewSchema,
  taskctlApiOperations,
  taskctlApiRoutes,
  workspaceViewSchema,
  safeErrorMessage,
  selectHumanScopeResponseSchema,
  uuidV7Timestamp,
  uuidV7Schema,
} from "./index";

const bytes = (length: number, offset = 0): Uint8Array =>
  Uint8Array.from({ length }, (_, index) => (index + offset) % 256);

describe("opaque tokens", () => {
  test("round-trips fixed-width credential and enrollment tokens", () => {
    const locator = createLocator(bytes(26));
    const secret = createBearerSecret(bytes(32));

    const credential = formatCredentialToken(locator, secret);
    const enrollment = formatEnrollmentToken(locator, secret);

    expect(parseCredentialToken(credential)).toEqual({ locator, secret });
    expect(parseEnrollmentToken(enrollment)).toEqual({ locator, secret });
    expect(redactSecret(credential)).toBe("[REDACTED]");
    expect(redactSecret(enrollment)).toBe("[REDACTED]");
    expect(redactSecretsInText(`Authorization: Bearer ${credential}`)).toBe(
      "Authorization: Bearer [REDACTED]",
    );
  });

  test("does not partially parse malformed tokens", () => {
    expect(parseCredentialToken("agt_short_secret")).toBeNull();
    expect(parseEnrollmentToken("agt_00000000000000000000000000_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA")).toBeNull();
    expect(redactSecret("anything else")).toBe("[REDACTED]");
  });

  test("redacts human token fields, JWTs, and authorization headers", () => {
    const jwt = "eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ1c2VyXzAxIn0.signature";
    const source = JSON.stringify({
      accessToken: jwt,
      refresh_token: "opaque-refresh-material",
      deviceCode: "secret-device-code",
      message: `Authorization: Bearer ${jwt}`,
    });
    const redacted = redactSecretsInText(source);
    expect(redacted).not.toContain(jwt);
    expect(redacted).not.toContain("opaque-refresh-material");
    expect(redacted).not.toContain("secret-device-code");
    const opaque = "opaque-provider-refresh-token-value";
    const providerError = [
      JSON.stringify({ Authorization: `Bearer ${opaque}` }),
      `refresh_token=${opaque}&grant_type=refresh_token`,
      `provider rejected ${opaque}`,
    ].join("\n");
    const opaqueRedacted = redactSecretsInText(providerError, [opaque]);
    expect(opaqueRedacted).not.toContain(opaque);
    expect(opaqueRedacted).toContain("[REDACTED]");
    expect(
      JSON.parse(redactSecretsInText(JSON.stringify({ refreshToken: 'escaped\\"value' }))),
    ).toEqual({ refreshToken: "[REDACTED]" });
  });
});

test("bearer secrets decode canonically to the 32 HMAC message bytes", () => {
  const original = bytes(32, 17);
  const secret = createBearerSecret(original);
  expect(decodeBearerSecret(secret)).toEqual(original);
  expect(credentialTokenSchema.safeParse(`agt_${createLocator(bytes(26))}_${secret.slice(0, -1)}B`).success).toBeFalse();
});

test("the full status and scope vocabulary is frozen", () => {
  expect(taskStatusValues).toEqual(["open", "in_progress", "in_review", "done", "cancelled"]);
  expect(agentPresetScopes.worker).toContain("tasks:claim");
  expect(agentPresetScopes.reviewer).toContain("tasks:review");
  expect(agentPresetScopes.observer).toEqual(["tasks:read"]);
});

test("every Phase 1 task transition maps to one event", () => {
  expect(phaseOneTaskEventByTransition).toEqual({
    create: "task.created",
    deferWake: "task.became_ready",
    claim: "task.claimed",
    reclaim: "task.reclaimed",
    renew: "task.claim_renewed",
    release: "task.claim_released",
    expire: "task.claim_expired",
  });
  expect(new Set(Object.keys(phaseOneTaskEventByTransition)).size).toBe(7);
  expect(phaseOneSecurityEventByTransition).toEqual({
    redeemEnrollment: "agent.enrollment_redeemed",
    startSession: "agent.session_started",
  });
});

test("task events require typed client or system command identity", () => {
  const requestId = createOpaqueId("req", bytes(26));
  const idempotencyKey = createUuidV7(1_720_000_000_123, bytes(10, 40));
  const event = {
    id: "event-id",
    organizationId: "organization-id",
    workspaceId: "workspace-id",
    taskId: "task-id",
    taskRevision: 1,
    schemaVersion: 1,
    actor: { kind: "agent", agentId: "agent-id" },
    command: { kind: "client", idempotencyKey, requestId },
    createdAt: 1_720_000_000_123,
    type: "task.created",
    payload: { availableAt: 0 },
  };
  expect(taskEventSchema.safeParse(event).success).toBeTrue();
  expect(
    taskEventSchema.safeParse({ ...event, command: { ...event.command, idempotencyKey: "not-a-uuid" } }).success,
  ).toBeFalse();
  expect(taskEventSchema.safeParse({ ...event, command: { kind: "system", jobKind: "defer_wake" } }).success).toBeFalse();
});

test("every stable error maps to HTTP and CLI behavior", () => {
  for (const code of errorCodeValues) {
    expect(errorHttpStatus[code]).toBeInteger();
    expect(errorExitCode[code]).toBeGreaterThanOrEqual(2);
  }
});

test("authentication and not-found errors cannot expose object details", () => {
  const requestId = createOpaqueId("req", bytes(26));
  const idempotencyKey = createUuidV7(1_720_000_000_123, bytes(10, 40));
  expect(
    errorEnvelopeSchema.safeParse({
      error: {
        code: "NOT_FOUND",
        message: safeErrorMessage.NOT_FOUND,
        requestId,
        details: { taskKey: "OPS-7K2M4Q9" },
      },
    }).success,
  ).toBeFalse();
  expect(
    errorEnvelopeSchema.safeParse({
      error: {
        code: "TASK_ALREADY_CLAIMED",
        message: safeErrorMessage.TASK_ALREADY_CLAIMED,
        requestId,
        details: { ownerAgentId: "agent" },
      },
    }).success,
  ).toBeTrue();

  const token = formatCredentialToken(createLocator(bytes(26)), createBearerSecret(bytes(32)));
  expect(
    errorEnvelopeSchema.safeParse({
      error: { code: "AUTHENTICATION_FAILED", message: `Rejected ${token}`, requestId, details: {} },
    }).success,
  ).toBeFalse();
  expect(makeErrorEnvelope("AUTHENTICATION_FAILED", requestId).error.message).toBe("Authentication failed.");
  expect(
    makeErrorEnvelope("SERVICE_UNAVAILABLE", requestId, { idempotencyKey }).error.details.idempotencyKey,
  ).toBe(idempotencyKey);
});

test("a competing runner receives only a bounded retry hint", () => {
  const requestId = createOpaqueId("req", bytes(26));
  expect(makeErrorEnvelope("RUNNER_ALREADY_CONNECTED", requestId, {
    leaseUntil: 1_720_000_045_000,
    retryAfterMs: 15_000,
  })).toEqual({
    error: {
      code: "RUNNER_ALREADY_CONNECTED",
      message: "Another runner is already connected to this workspace.",
      requestId,
      details: { leaseUntil: 1_720_000_045_000, retryAfterMs: 15_000 },
    },
  });
  expect(errorHttpStatus.RUNNER_ALREADY_CONNECTED).toBe(409);
  expect(errorExitCode.RUNNER_ALREADY_CONNECTED).toBe(4);
});

test("idempotency keys are UUIDv7", () => {
  expect(uuidV7Schema.safeParse("018f22e2-7b44-7cc0-8e5d-657f31f9064a").success).toBeTrue();
  expect(uuidV7Schema.safeParse("018f22e2-7b44-4cc0-8e5d-657f31f9064a").success).toBeFalse();

  const timestamp = 1_720_000_000_123;
  const generated = createUuidV7(timestamp, bytes(10, 40));
  expect(uuidV7Timestamp(generated)).toBe(timestamp);
  expect(uuidV7Timestamp("not-a-uuid")).toBeNull();

  expect(classifyIdempotencyKey(generated, timestamp)).toEqual({ status: "valid", timestamp });
  expect(classifyIdempotencyKey(generated, timestamp + 7 * 24 * 60 * 60 * 1_000 + 1)).toEqual({
    status: "expired",
  });
  expect(classifyIdempotencyKey(generated, timestamp - 5 * 60 * 1_000 - 1)).toEqual({
    status: "future",
  });
});

test("task literals and byte bounds match the accepted v1 plan", () => {
  expect(taskKeySchema.safeParse("OPS-7K2M4Q9").success).toBeTrue();
  expect(taskKeySchema.safeParse("OPS-7K2M4Q").success).toBeFalse();
  expect(taskTitleSchema.safeParse("a".repeat(512)).success).toBeTrue();
  expect(taskTitleSchema.safeParse("😀".repeat(129)).success).toBeFalse();
});

test("an in-progress task has exactly one claim representation", () => {
  const base = {
    id: "tsk_0123456789ABCDEFGHJKMNPQRS",
    key: "OPS-7K2M4Q9",
    title: "Claim me",
    type: "task",
    priority: 2,
    availableAt: 0,
    isReady: false,
    unresolvedBlockerCount: 0,
    cancelledBlockerCount: 0,
    revision: 2,
    reviewRevision: 1,
    createdAt: 1,
    updatedAt: 2,
  };
  expect(taskViewSchema.safeParse({ ...base, status: "in_progress" }).success).toBeFalse();
  expect(
    taskViewSchema.safeParse({
      ...base,
      status: "in_progress",
      currentClaim: { id: "claim-id", agentId: "agent-id", fence: 1, leaseGeneration: 1, leaseUntil: 3 },
    }).success,
  ).toBeTrue();
  expect(
    taskViewSchema.safeParse({
      ...base,
      status: "open",
      currentClaim: { id: "claim-id", agentId: "agent-id", fence: 1, leaseGeneration: 1, leaseUntil: 3 },
    }).success,
  ).toBeFalse();
});

test("the route matrix freezes auth, session, and idempotency requirements", () => {
  expect(taskctlApiOperations.startDesktopPairing).toMatchObject({
    method: "POST",
    authorization: "none",
    idempotency: false,
  });
  expect(taskctlApiOperations.redeemDesktopPairing).toMatchObject({
    method: "POST",
    authorization: "none",
    idempotency: false,
  });
  expect(taskctlApiOperations.refreshAuth).toMatchObject({
    method: "POST",
    authorization: "human-refresh",
    idempotency: false,
  });
  expect(taskctlApiOperations.selectHumanScope).toMatchObject({
    method: "POST",
    path: "/v1/auth/selection",
    authorization: "human-account",
    idempotency: false,
  });
  expect(taskctlApiOperations.createOrganization).toMatchObject({
    method: "POST",
    authorization: "human-account",
    idempotency: true,
  });
  expect(taskctlApiOperations.createAgent).toMatchObject({
    method: "POST",
    authorization: "human-organization",
    idempotency: true,
  });
  expect(taskctlApiOperations.redeemEnrollment).toMatchObject({
    method: "POST",
    authorization: "enrollment",
    session: false,
    idempotency: true,
  });
  expect(taskctlApiOperations.context).toMatchObject({
    method: "GET",
    authorization: "agent",
    session: true,
    idempotency: false,
  });
  expect(createOpaqueId("req", bytes(26))).toMatch(/^req_/u);
});

test("human delegation cannot exceed its named preset", () => {
  const enrollment = formatEnrollmentToken(createLocator(bytes(26)), createBearerSecret(bytes(32)));
  const base = {
    workspaceId: "workspace-id",
    name: "builder",
    preset: "worker",
    enrollment,
  } as const;
  expect(createAgentRequestSchema.safeParse(base).success).toBeTrue();
  expect(
    createAgentRequestSchema.safeParse({ ...base, scopes: ["tasks:read", "tasks:review"] }).success,
  ).toBeFalse();
  expect(
    createAgentRequestSchema.safeParse({ ...base, scopes: ["tasks:read", "tasks:read"] }).success,
  ).toBeFalse();
  expect(
    createAgentRequestSchema.safeParse({
      ...base,
      credentialLifetimeMs: MIN_AGENT_CREDENTIAL_LIFETIME_MS,
    }).success,
  ).toBeTrue();
  expect(
    createAgentRequestSchema.safeParse({
      ...base,
      credentialLifetimeMs: MAX_AGENT_CREDENTIAL_LIFETIME_MS + 1,
    }).success,
  ).toBeFalse();
  expect(DEFAULT_AGENT_CREDENTIAL_LIFETIME_MS).toBe(90 * 24 * 60 * 60 * 1_000);
  expect(MAX_AGENT_CREDENTIAL_LIFETIME_MS).toBe(365 * 24 * 60 * 60 * 1_000);
  expect(MAX_AGENT_CREDENTIAL_LIFETIME_MS).toBeGreaterThan(DEFAULT_AGENT_CREDENTIAL_LIFETIME_MS);
});

test("human views preserve tenant anchors and unique roles", () => {
  const organization = {
    id: "organization-id",
    name: "Example",
    role: "owner",
    status: "active",
  } as const;
  expect(organizationViewSchema.safeParse(organization).success).toBeTrue();
  expect(organizationViewSchema.safeParse({ ...organization, providerId: "external" }).success).toBeFalse();
  const workspace = {
    id: "workspace-id",
    organizationId: "organization-id",
    slug: "core",
    name: "Core",
    taskKeyPrefix: "CORE",
  };
  expect(workspaceViewSchema.safeParse({ ...workspace, roles: ["planner", "planner"] }).success).toBeFalse();
  expect(workspaceViewSchema.safeParse({ ...workspace, roles: ["planner", "reviewer"] }).success).toBeTrue();
});

test("human scope selection rotates a complete credential for one exact tenant", () => {
  const response = {
    accessToken: "selected-access-token-that-is-long-enough",
    refreshToken: "selected-refresh-token-that-is-long-enough",
    user: { id: "user_stable", email: "human@example.com" },
    organization: {
      id: "organization-id",
      name: "Example",
      role: "owner",
      status: "active",
    },
    workspace: {
      id: "workspace-id",
      organizationId: "organization-id",
      slug: "core",
      name: "Core",
      taskKeyPrefix: "CORE",
      roles: ["planner"],
    },
  } as const;
  expect(selectHumanScopeResponseSchema.safeParse(response).success).toBeTrue();
  expect(selectHumanScopeResponseSchema.safeParse({
    organization: response.organization,
    workspace: response.workspace,
  }).success).toBeFalse();
  expect(selectHumanScopeResponseSchema.safeParse({
    ...response,
    workspace: { ...response.workspace, organizationId: "another-organization" },
  }).success).toBeFalse();
});

test("desktop pairing routes bind a public locator to a credential-free browser URL", () => {
  const pairingId = "pair_00000000000000000000000000";
  const verifier = createBearerSecret(bytes(32, 21));
  const challenge = createBearerSecret(bytes(32, 99));
  expect(desktopPairingVerifierSchema.parse(verifier)).toBe(verifier);
  expect(desktopPairingChallengeSchema.parse(challenge)).toBe(challenge);
  expect(taskctlApiRoutes.desktopPairingRedeem(pairingId)).toBe(
    `/v1/auth/desktop-pairings/${pairingId}/redeem`,
  );
  expect(desktopPairingStartResponseSchema.safeParse({
    pairingId,
    verificationUri: `https://hra.sh/pair/desktop/${pairingId}`,
    comparisonCode: "2345-6789",
    expiresAt: 1_720_000_060_000,
    pollIntervalMs: 2_000,
  }).success).toBeTrue();
  expect(desktopPairingStartResponseSchema.safeParse({
    pairingId,
    verificationUri: `https://hra.sh/pair/desktop/${pairingId}?verifier=${verifier}`,
    comparisonCode: "2345-6789",
    expiresAt: 1_720_000_060_000,
    pollIntervalMs: 2_000,
  }).success).toBeFalse();
  expect(desktopPairingRedeemResponseSchema.safeParse({
    status: "pending",
    retryAfterMs: 2_000,
  }).success).toBeTrue();
});

test("dynamic agent enrollment paths validate their route parameter", () => {
  expect(agentRouteParamsSchema.safeParse({ agentId: "agent-id" }).success).toBeTrue();
  expect(taskctlApiRoutes.agentEnrollments("agent-id")).toBe("/v1/agents/agent-id/enrollments");
  expect(() => taskctlApiRoutes.agentEnrollments("")).toThrow();
});

test("agent administration routes are workspace-anchored and freeze mutation replay", () => {
  const credentialId = createLocator(bytes(26, 70));
  expect(taskctlApiRoutes.agent("agent-id")).toBe("/v1/agents/agent-id");
  expect(taskctlApiRoutes.agentCredentials("agent-id")).toBe(
    "/v1/agents/agent-id/credentials",
  );
  expect(taskctlApiRoutes.agentCredentialRevoke("agent-id", credentialId)).toBe(
    `/v1/agents/agent-id/credentials/${credentialId}/revoke`,
  );
  expect(taskctlApiRoutes.agentSessions("agent-id")).toBe("/v1/agents/agent-id/sessions");
  expect(taskctlApiRoutes.agentDisable("agent-id")).toBe("/v1/agents/agent-id/disable");
  expect(agentCredentialRouteParamsSchema.safeParse({ agentId: "agent-id", credentialId }).success).toBeTrue();
  expect(
    agentCredentialRouteParamsSchema.safeParse({
      agentId: "agent-id",
      credentialId: formatCredentialToken(credentialId, createBearerSecret(bytes(32))),
    }).success,
  ).toBeFalse();
  expect(taskctlApiOperations.listAgents).toMatchObject({
    method: "GET",
    authorization: "human-organization",
    idempotency: false,
  });
  expect(taskctlApiOperations.createAgentEnrollment.pathParamsSchema).toBe(
    agentRouteParamsSchema,
  );
  expect(taskctlApiOperations.revokeAgentCredential).toMatchObject({
    method: "POST",
    authorization: "human-organization",
    idempotency: true,
  });
  expect(taskctlApiOperations.disableAgent).toMatchObject({
    method: "POST",
    authorization: "human-organization",
    idempotency: true,
  });
  expect(
    listAgentsQuerySchema.parse({ workspaceId: "workspace-id", limit: "20" }),
  ).toEqual({ workspaceId: "workspace-id", limit: 20 });
  expect(listAgentsQuerySchema.safeParse({ limit: "20" }).success).toBeFalse();
});

test("agent administration views expose lifecycle metadata without credential plaintext", () => {
  const credentialId = createLocator(bytes(26, 80));
  const agent = {
    id: "agent-id",
    workspaceId: "workspace-id",
    name: "builder",
    status: "disabled",
    scopes: ["tasks:read"],
    createdAt: 10,
    updatedAt: 20,
  } as const;
  expect(agentLifecycleViewSchema.safeParse(agent).success).toBeTrue();
  expect(agentLifecycleViewSchema.safeParse({ ...agent, updatedAt: 9 }).success).toBeFalse();

  const credential = {
    id: credentialId,
    agentId: "agent-id",
    workspaceId: "workspace-id",
    scopes: ["tasks:read"],
    status: "active",
    createdAt: 10,
    expiresAt: 100,
    lastUsedAt: 20,
  } as const;
  expect(agentCredentialViewSchema.safeParse(credential).success).toBeTrue();
  expect(
    agentCredentialViewSchema.safeParse({ ...credential, status: "revoked" }).success,
  ).toBeFalse();
  expect(
    agentCredentialViewSchema.safeParse({
      ...credential,
      verifierDigest: "must-not-cross-the-wire",
    }).success,
  ).toBeFalse();

  const session = {
    agentId: "agent-id",
    workspaceId: "workspace-id",
    credentialId,
    status: "active",
    createdAt: 10,
    lastSeenAt: 20,
    idleExpiresAt: 30,
  } as const;
  expect(activeAgentSessionViewSchema.safeParse(session).success).toBeTrue();
  expect(
    activeAgentSessionViewSchema.safeParse({ ...session, sessionId: "ses_secret-selector" }).success,
  ).toBeFalse();
});

test("ready query strings parse from URLSearchParams", () => {
  const query = new URLSearchParams({ cursor: "next", limit: "20" });
  expect(readyTasksQuerySchema.parse(Object.fromEntries(query))).toEqual({ cursor: "next", limit: 20 });
  expect(readyTasksQuerySchema.safeParse({ limit: "0" }).success).toBeFalse();
});

test("operation responses reject impossible task states", () => {
  const openTask = {
    id: "tsk_00000000000000000000000000",
    key: "OPS-7K2M4Q9",
    title: "Open",
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
  };
  expect(createTaskResponseSchema.safeParse({ task: openTask }).success).toBeTrue();
  expect(createTaskResponseSchema.safeParse({ task: { ...openTask, status: "done" } }).success).toBeFalse();
});
