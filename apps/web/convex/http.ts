import {
  appendRunEventsEnvelopeSchema,
  appendRunEventsRequestSchema,
  agentCredentialRouteParamsSchema,
  agentRouteParamsSchema,
  agentPresetScopes,
  acceptTaskRequestSchema,
  addTaskCommentRequestSchema,
  addTaskReferenceRequestSchema,
  assignTaskRequestSchema,
  blockedTasksQuerySchema,
  cancelTaskRequestSchema,
  claimDispatchEnvelopeSchema,
  claimDispatchRequestSchema,
  claimTaskRequestSchema,
  clearTaskParentRequestSchema,
  createAgentEnrollmentRequestSchema,
  createAgentRequestSchema,
  createOrganizationRequestSchema,
  createTaskRequestSchema,
  createWorkspaceRepositoryRequestSchema,
  createWorkspaceRequestSchema,
  decodeBearerSecret,
  DEFAULT_AGENT_CREDENTIAL_LIFETIME_MS,
  dispatchIdSchema,
  disableAgentRequestSchema,
  deferTaskRequestSchema,
  errorHttpStatus,
  getAgentQuerySchema,
  hraHumanApiRoutes,
  hraPromotionApiRoutes,
  humanRefreshTokenSchema,
  listAgentCredentialsQuerySchema,
  listAgentSessionsQuerySchema,
  listAgentsQuerySchema,
  listOrganizationsQuerySchema,
  listTaskCommentsQuerySchema,
  listTaskDependenciesQuerySchema,
  listTaskEventsQuerySchema,
  listTaskReferencesQuerySchema,
  listTasksQuerySchema,
  listWorkspaceRepositoriesQuerySchema,
  listWorkspacesQuerySchema,
  legacyKitchenHumanApiRoutes,
  legacyKitchenPromotionApiRoutes,
  legacyOprteHumanApiRoutes,
  legacyOprtePromotionApiRoutes,
  legacyOprteSessionSyncHttpRoutes,
  makeErrorEnvelope,
  MAX_SERIALIZED_SYNC_RUN_INTERACTIONS_REQUEST_BYTES,
  hraDispatchRoutes,
  parseCredentialToken,
  parseEnrollmentToken,
  readyTasksQuerySchema,
  rejectTaskRequestSchema,
  refreshAuthRequestSchema,
  redeemEnrollmentRequestSchema,
  releaseClaimRequestSchema,
  removeTaskReferenceRequestSchema,
  removeWorkspaceRepositoryRequestSchema,
  repositoryRouteParamsSchema,
  reopenTaskRequestSchema,
  renewClaimRequestSchema,
  revokeAgentCredentialRequestSchema,
  reviewQueueQuerySchema,
  runnerHeartbeatEnvelopeSchema,
  runnerHeartbeatRequestSchema,
  sessionSyncHttpRoutes,
  sessionIdSchema,
  startSessionRequestSchema,
  submitTaskRequestSchema,
  syncRunInteractionsEnvelopeSchema,
  syncRunInteractionsRequestSchema,
  setTaskParentRequestSchema,
  taskDependencyMutationRequestSchema,
  taskGraphQuerySchema,
  taskLabelMutationRequestSchema,
  taskReferenceRouteParamsSchema,
  taskRouteParamsSchema,
  taskctlApiOperations,
  taskctlApiRoutes,
  taskctlHeaders,
  uuidV7Schema,
  updateTaskRequestSchema,
  type ErrorCode,
  type ErrorDetails,
  type RunInteractionRequest,
} from "@hraness/agent-tasks-protocol";
import type { OrganizationMembership } from "@workos-inc/node";
import { httpRouter } from "convex/server";

import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { env, httpAction, type ActionCtx } from "./_generated/server";
import {
  digestArrayBuffer,
  hmacSha256Base64Url,
  hmacSha256Utf8KeyBase64Url,
  sha256Base64Url,
  verifyHmacSha256,
} from "./crypto";
import { parseBoundedJsonBody } from "./boundedJsonBody";
import { randomRequestId } from "./domain";
import { readHumanIdentity } from "./humanAuthorization";
import { workOSWebhook } from "./identityWebhooks";
import {
  hraHumanHttp,
  hraPromotionHttp,
} from "./hraHttp";
import { sessionSyncHttp } from "./sessionSyncHttp";
import {
  apiOperationRateLimitClass,
  agentOperationAuthorizationPolicy,
  isAgentReadOperation,
  unauthenticatedSlotKey,
  type AgentReadOperation,
  type AuthenticatedAgentOperation,
  type FailureRouteClass,
} from "./rateLimitPolicy";
import {
  createWorkOSOwnerMembership,
  createWorkOSOrganization,
  findWorkOSOrganizationByExternalId,
  isActiveWorkOSOwnerMembership,
  isDefinitiveRefreshRejection,
  listWorkOSMemberships,
  pollWorkOSOwnerMembership,
  refreshWorkOSAuthentication,
  workOSMembershipLocatorMatches,
  workOSOrganizationExternalIdMatches,
} from "./workos";

const http = httpRouter();
const JSON_HEADERS = {
  "Cache-Control": "no-store",
  "Content-Type": "application/json; charset=utf-8",
  "X-Content-Type-Options": "nosniff",
} as const;
const MAX_JSON_BODY_BYTES = 512 * 1_024;
const DUMMY_DIGEST = new Uint8Array(32).buffer;
const IDEMPOTENT_MUTATION_ATTEMPTS = 5;

function convexInteractionRequest(request: RunInteractionRequest) {
  if (request.kind === "file_change_approval") return request;
  return {
    ...request,
    questions: request.questions.map((question) => ({
      ...question,
      options: question.options.map((option) => ({
        id: option.id,
        label: option.label,
        ...(option.description === undefined ? {} : { description: option.description }),
      })),
    })),
  };
}

type RetriedMutationResult<Value> =
  | { readonly kind: "success"; readonly value: Value }
  | { readonly kind: "exhausted" };

async function runIdempotentMutationWithRetry<Value>(
  requestId: string,
  operation: () => Promise<Value>,
): Promise<RetriedMutationResult<Value>> {
  for (let attempt = 0; attempt < IDEMPOTENT_MUTATION_ATTEMPTS; attempt += 1) {
    try {
      return { kind: "success", value: await operation() };
    } catch {
      if (attempt + 1 === IDEMPOTENT_MUTATION_ATTEMPTS) return { kind: "exhausted" };
      const baseDelayMs = 5 * 2 ** attempt;
      const jitterSeed = [...requestId].reduce(
        (value, character) => (Math.imul(value, 33) + character.charCodeAt(0)) >>> 0,
        attempt + 1,
      );
      const jitterMs = jitterSeed % (baseDelayMs + 1);
      await new Promise<void>((resolve) => setTimeout(resolve, baseDelayMs + jitterMs));
    }
  }
  return { kind: "exhausted" };
}

http.route({
  method: "POST",
  path: "/webhooks/workos",
  handler: workOSWebhook,
});

type PepperFamily = "credential" | "enrollment";
type ApiOperationName = keyof typeof apiOperationRateLimitClass;

function errorResponse(
  code: ErrorCode,
  requestId: string,
  details: ErrorDetails = {},
): Response {
  return new Response(JSON.stringify(makeErrorEnvelope(code, requestId, details)), {
    status: errorHttpStatus[code],
    headers: JSON_HEADERS,
  });
}

function resultResponse<Schema extends { parse: (value: unknown) => unknown }>(
  result:
    | { ok: true; data: unknown; requestId: string }
    | { ok: false; error: { code: ErrorCode; requestId: string; details: ErrorDetails } },
  responseSchema: Schema,
): Response {
  if (!result.ok) return errorResponse(result.error.code, result.error.requestId, result.error.details);
  const envelope = { ok: true as const, data: result.data, requestId: result.requestId };
  const parsed = responseSchema.parse(envelope);
  return new Response(JSON.stringify(parsed), { status: 200, headers: JSON_HEADERS });
}

function parseJsonBody(
  request: Request,
  maximumBytes = MAX_JSON_BODY_BYTES,
): Promise<unknown | null> {
  return parseBoundedJsonBody(request, maximumBytes);
}

function bearerValue(request: Request): string | null {
  const value = request.headers.get(taskctlHeaders.authorization);
  if (value === null || !value.startsWith("Bearer ") || value.slice(7).includes(" ")) return null;
  return value.slice(7);
}

function idempotencyKey(request: Request): string | null {
  const value = request.headers.get(taskctlHeaders.idempotencyKey);
  return value !== null && uuidV7Schema.safeParse(value).success ? value : null;
}

function hasJsonContentType(request: Request): boolean {
  const value = request.headers.get("content-type");
  if (value === null) return false;
  const [mediaType] = value.split(";", 1);
  return mediaType?.trim().toLowerCase() === "application/json";
}

function sessionValue(request: Request): string | null {
  const value = request.headers.get(taskctlHeaders.session);
  return value !== null && sessionIdSchema.safeParse(value).success ? value : null;
}

function configuredPepper(family: PepperFamily, version: string) {
  const currentKey =
    family === "credential"
      ? env.TASKCTL_CREDENTIAL_PEPPER_CURRENT
      : env.TASKCTL_ENROLLMENT_PEPPER_CURRENT;
  const currentVersion =
    family === "credential"
      ? env.TASKCTL_CREDENTIAL_PEPPER_CURRENT_VERSION
      : env.TASKCTL_ENROLLMENT_PEPPER_CURRENT_VERSION;
  const previousKey =
    family === "credential"
      ? env.TASKCTL_CREDENTIAL_PEPPER_PREVIOUS
      : env.TASKCTL_ENROLLMENT_PEPPER_PREVIOUS;
  const previousVersion =
    family === "credential"
      ? env.TASKCTL_CREDENTIAL_PEPPER_PREVIOUS_VERSION
      : env.TASKCTL_ENROLLMENT_PEPPER_PREVIOUS_VERSION;
  if (currentKey !== undefined && currentVersion === version) return currentKey;
  if (previousKey !== undefined && previousVersion === version) return previousKey;
  return null;
}

function currentPepper(family: PepperFamily) {
  const key =
    family === "credential"
      ? env.TASKCTL_CREDENTIAL_PEPPER_CURRENT
      : env.TASKCTL_ENROLLMENT_PEPPER_CURRENT;
  const version =
    family === "credential"
      ? env.TASKCTL_CREDENTIAL_PEPPER_CURRENT_VERSION
      : env.TASKCTL_ENROLLMENT_PEPPER_CURRENT_VERSION;
  return key === undefined || version === undefined ? null : { key, version };
}

async function authenticationFailureSlot(
  request: Request,
  family: PepperFamily,
): Promise<string | null> {
  const pepper = currentPepper(family);
  if (pepper === null) return null;
  const authorization = request.headers.get(taskctlHeaders.authorization);
  const boundedMaterial =
    authorization === null
      ? "missing"
      : authorization.length <= 8_192
        ? authorization
        : `oversize:${authorization.length}`;
  try {
    const digest = await sha256Base64Url(
      `taskctl-auth-failure-rate-limit-v1:${family}:${boundedMaterial}`,
    );
    const message = decodeBearerSecret(digest);
    if (message === null) return null;
    return unauthenticatedSlotKey(await hmacSha256Base64Url(pepper.key, message));
  } catch {
    return null;
  }
}

async function authenticationFailureIsRateLimited(
  ctx: ActionCtx,
  request: Request,
  requestId: string,
  family: PepperFamily,
  routeClass: FailureRouteClass,
): Promise<number | null> {
  const slotKey = await authenticationFailureSlot(request, family);
  if (slotKey === null) return null;
  try {
    const result = await ctx.runMutation(internal.rateLimits.consumeOpaque, {
      routeClass,
      slotKey,
      requestId,
    });
    return result.kind === "limited" ? result.retryAfterMs : null;
  } catch {
    // Authentication has already failed. Limiter unavailability must not turn
    // a redacted 401 into a distinguishable internal error.
    return null;
  }
}

async function agentReadRateLimitResponse(
  ctx: ActionCtx,
  credentialId: Id<"agentCredentials">,
  sessionPublicId: string,
  operation: AgentReadOperation,
  requestId: string,
): Promise<Response | null> {
  const authorizationPolicy = agentOperationAuthorizationPolicy[operation];
  if (authorizationPolicy.kind !== "read") {
    return errorResponse("SERVICE_UNAVAILABLE", requestId);
  }
  let result;
  try {
    result = await ctx.runMutation(internal.rateLimits.consumeAgentRead, {
      credentialId,
      operation,
      requestId,
      sessionPublicId,
    });
  } catch {
    return errorResponse("SERVICE_UNAVAILABLE", requestId);
  }
  // A skipped debit means the limiter's full authorization reload rejected the
  // tuple without touching either bucket. Let the domain query return its
  // stable redacted session/authorization error instead of masking it as a
  // limiter outage.
  if (result.kind === "allowed" || result.kind === "skipped") return null;
  if (result.kind === "limited") {
    return errorResponse("RATE_LIMITED", requestId, { retryAfterMs: result.retryAfterMs });
  }
  return errorResponse("SERVICE_UNAVAILABLE", requestId);
}

async function humanRateLimitResponse(
  ctx: ActionCtx,
  operation: ApiOperationName,
  requestId: string,
  workspacePublicId?: string,
): Promise<Response | null> {
  const rule = apiOperationRateLimitClass[operation];
  if (
    rule.kind !== "consume" ||
    (rule.routeClass !== "human_read" && rule.routeClass !== "human_mutation")
  ) {
    return errorResponse("SERVICE_UNAVAILABLE", requestId);
  }
  if (
    (rule.subjectProfile === "human_user" && workspacePublicId !== undefined) ||
    (rule.subjectProfile === "human_user_workspace" && workspacePublicId === undefined)
  ) {
    return errorResponse("SERVICE_UNAVAILABLE", requestId);
  }
  let result;
  try {
    result = await ctx.runMutation(internal.rateLimits.consumeHuman, {
      routeClass: rule.routeClass,
      ...(workspacePublicId === undefined ? {} : { workspacePublicId }),
      requestId,
    });
  } catch {
    return errorResponse("SERVICE_UNAVAILABLE", requestId);
  }
  if (result.kind === "allowed" || result.kind === "skipped") return null;
  if (result.kind === "limited") {
    return errorResponse("RATE_LIMITED", requestId, { retryAfterMs: result.retryAfterMs });
  }
  return errorResponse("SERVICE_UNAVAILABLE", requestId);
}

async function refreshRateLimitResponse(
  ctx: ActionCtx,
  refreshToken: string,
  requestId: string,
): Promise<Response | null> {
  const rule = apiOperationRateLimitClass.refreshAuth;
  const workosApiKey = env.WORKOS_API_KEY;
  if (rule.kind !== "opaque_pre_auth" || workosApiKey === undefined || workosApiKey.length === 0) {
    return errorResponse("SERVICE_UNAVAILABLE", requestId);
  }
  try {
    const opaqueDigest = await hmacSha256Utf8KeyBase64Url(
      workosApiKey,
      `taskctl-refresh-rate-limit-v1:${refreshToken}`,
    );
    const slotKey = unauthenticatedSlotKey(opaqueDigest);
    if (slotKey === null) return errorResponse("SERVICE_UNAVAILABLE", requestId);
    const result = await ctx.runMutation(internal.rateLimits.consumeOpaque, {
      routeClass: rule.routeClass,
      slotKey,
      requestId,
    });
    if (result.kind === "allowed") return null;
    if (result.kind === "limited") {
      return errorResponse("RATE_LIMITED", requestId, { retryAfterMs: result.retryAfterMs });
    }
    return errorResponse("SERVICE_UNAVAILABLE", requestId);
  } catch {
    return errorResponse("SERVICE_UNAVAILABLE", requestId);
  }
}

async function authenticateEnrollment(ctx: ActionCtx, token: string) {
  const parsed = parseEnrollmentToken(token);
  const current = currentPepper("enrollment");
  if (current === null) return { kind: "unavailable" as const };
  const verifier =
    parsed === null
      ? null
      : await ctx.runQuery(internal.agents.enrollmentVerifier, { locator: parsed.locator });
  const message = parsed === null ? new Uint8Array(32) : decodeBearerSecret(parsed.secret);
  if (message === null) return { kind: "failure" as const };
  const key = verifier === null ? current.key : (configuredPepper("enrollment", verifier.pepperVersion) ?? current.key);
  let valid: boolean;
  try {
    valid = await verifyHmacSha256(
      key,
      message,
      verifier === null ? DUMMY_DIGEST : verifier.verifierDigest,
    );
  } catch {
    return { kind: "unavailable" as const };
  }
  if (parsed === null || verifier === null || !valid) return { kind: "failure" as const };
  return { kind: "success" as const, enrollmentId: verifier.id, locator: parsed.locator };
}

async function authenticateCredential(ctx: ActionCtx, token: string) {
  const parsed = parseCredentialToken(token);
  const current = currentPepper("credential");
  if (current === null) return { kind: "unavailable" as const };
  const verifier =
    parsed === null
      ? null
      : await ctx.runQuery(internal.agents.credentialVerifier, { locator: parsed.locator });
  const message = parsed === null ? new Uint8Array(32) : decodeBearerSecret(parsed.secret);
  if (message === null) return { kind: "failure" as const };
  const key = verifier === null ? current.key : (configuredPepper("credential", verifier.pepperVersion) ?? current.key);
  let valid: boolean;
  try {
    valid = await verifyHmacSha256(
      key,
      message,
      verifier === null ? DUMMY_DIGEST : verifier.verifierDigest,
    );
  } catch {
    return { kind: "unavailable" as const };
  }
  if (parsed === null || verifier === null || !valid) return { kind: "failure" as const };
  return { kind: "success" as const, credentialId: verifier.id, locator: parsed.locator };
}

type SuccessfulCredentialAuthentication = {
  readonly kind: "success";
  readonly credentialId: Id<"agentCredentials">;
  readonly locator: string;
};

async function authenticateAgentRequest(
  ctx: ActionCtx,
  request: Request,
  requestId: string,
  operation: AuthenticatedAgentOperation,
): Promise<
  | { readonly kind: "success"; readonly credential: SuccessfulCredentialAuthentication }
  | { readonly kind: "error"; readonly response: Response }
> {
  const rule = apiOperationRateLimitClass[operation];
  if (
    rule.kind !== "consume" ||
    rule.subjectProfile !== "agent_credential_workspace" ||
    rule.authenticationFailureClass !== "agent_auth_failure"
  ) {
    return { kind: "error", response: errorResponse("SERVICE_UNAVAILABLE", requestId) };
  }
  // Missing and malformed bearer values still traverse the normal dummy-HMAC
  // verifier path before an authentication-failure bucket can return 429.
  const credential = await authenticateCredential(ctx, bearerValue(request) ?? "");
  if (credential.kind === "unavailable") {
    return { kind: "error", response: errorResponse("SERVICE_UNAVAILABLE", requestId) };
  }
  if (credential.kind !== "success") {
    const retryAfterMs = await authenticationFailureIsRateLimited(
      ctx,
      request,
      requestId,
      "credential",
      rule.authenticationFailureClass,
    );
    if (retryAfterMs !== null) {
      return {
        kind: "error",
        response: errorResponse("RATE_LIMITED", requestId, { retryAfterMs }),
      };
    }
    return { kind: "error", response: errorResponse("AUTHENTICATION_FAILED", requestId) };
  }
  return { kind: "success", credential };
}

async function authenticateSessionRequest(
  ctx: ActionCtx,
  request: Request,
  requestId: string,
  operation: AuthenticatedAgentOperation,
): Promise<
  | {
      readonly kind: "success";
      readonly credential: SuccessfulCredentialAuthentication;
      readonly sessionPublicId: string;
    }
  | { readonly kind: "error"; readonly response: Response }
> {
  const agent = await authenticateAgentRequest(ctx, request, requestId, operation);
  if (agent.kind === "error") return agent;
  const sessionPublicId = sessionValue(request);
  if (sessionPublicId === null) {
    return { kind: "error", response: errorResponse("SESSION_REQUIRED", requestId) };
  }
  if (isAgentReadOperation(operation)) {
    const limited = await agentReadRateLimitResponse(
      ctx,
      agent.credential.credentialId,
      sessionPublicId,
      operation,
      requestId,
    );
    if (limited !== null) return { kind: "error", response: limited };
  }
  return { kind: "success", credential: agent.credential, sessionPublicId };
}

async function authenticateDispatchSessionRequest(
  ctx: ActionCtx,
  request: Request,
  requestId: string,
): Promise<
  | {
      readonly kind: "success";
      readonly credential: SuccessfulCredentialAuthentication;
      readonly sessionPublicId: string;
    }
  | { readonly kind: "error"; readonly response: Response }
> {
  const credential = await authenticateCredential(ctx, bearerValue(request) ?? "");
  if (credential.kind === "unavailable") {
    return { kind: "error", response: errorResponse("SERVICE_UNAVAILABLE", requestId) };
  }
  if (credential.kind !== "success") {
    const retryAfterMs = await authenticationFailureIsRateLimited(
      ctx,
      request,
      requestId,
      "credential",
      "agent_auth_failure",
    );
    return {
      kind: "error",
      response: retryAfterMs === null
        ? errorResponse("AUTHENTICATION_FAILED", requestId)
        : errorResponse("RATE_LIMITED", requestId, { retryAfterMs }),
    };
  }
  const sessionPublicId = sessionValue(request);
  return sessionPublicId === null
    ? { kind: "error", response: errorResponse("SESSION_REQUIRED", requestId) }
    : { kind: "success", credential, sessionPublicId };
}

async function prepareEnrollmentToken(token: string): Promise<
  | {
      readonly kind: "success";
      readonly locator: string;
      readonly verifierDigest: ArrayBuffer;
      readonly fingerprint: string;
      readonly pepperVersion: string;
    }
  | { readonly kind: "validation" }
  | { readonly kind: "unavailable" }
> {
  const parsed = parseEnrollmentToken(token);
  if (parsed === null) return { kind: "validation" };
  const pepper = currentPepper("enrollment");
  if (pepper === null) return { kind: "unavailable" };
  const message = decodeBearerSecret(parsed.secret);
  if (message === null) return { kind: "validation" };
  try {
    const [verifier, fingerprint] = await Promise.all([
      hmacSha256Base64Url(pepper.key, message),
      sha256Base64Url(token),
    ]);
    const verifierDigest = digestArrayBuffer(verifier);
    return verifierDigest === null
      ? { kind: "unavailable" }
      : {
          kind: "success",
          locator: parsed.locator,
          verifierDigest,
          fingerprint,
          pepperVersion: pepper.version,
        };
  } catch {
    return { kind: "unavailable" };
  }
}

function membershipRoleSlugs(value: unknown): string[] {
  if (typeof value !== "object" || value === null) return [];
  const membership = value as Record<string, unknown>;
  const fallback = membership["role"];
  if (typeof fallback !== "object" || fallback === null) return [];
  const fallbackSlug = (fallback as Record<string, unknown>)["slug"];
  if (typeof fallbackSlug !== "string") return [];
  const configured = membership["roles"];
  if (configured !== undefined && configured !== null && !Array.isArray(configured)) return [];
  const slugs: string[] = [];
  for (const value of configured ?? []) {
    if (typeof value !== "object" || value === null) return [];
    const slug = (value as Record<string, unknown>)["slug"];
    if (typeof slug !== "string") return [];
    slugs.push(slug);
  }
  return [...new Set(slugs.length === 0 ? [fallbackSlug] : slugs)];
}

http.route({
  method: "POST",
  path: taskctlApiRoutes.refreshAuth,
  handler: httpAction(async (ctx, request) => {
    const requestId = randomRequestId();
    let providerDispatched = false;
    try {
      if (!hasJsonContentType(request)) return errorResponse("VALIDATION_ERROR", requestId);
      const refreshToken = bearerValue(request);
      if (
        refreshToken === null ||
        !humanRefreshTokenSchema.safeParse(refreshToken).success
      ) {
        return errorResponse("AUTHENTICATION_FAILED", requestId);
      }
      const body = refreshAuthRequestSchema.safeParse(await parseJsonBody(request));
      if (!body.success) return errorResponse("VALIDATION_ERROR", requestId);
      const limited = await refreshRateLimitResponse(ctx, refreshToken, requestId);
      if (limited !== null) return limited;
      let authentication;
      try {
        providerDispatched = true;
        authentication = await refreshWorkOSAuthentication({
          refreshToken,
          ...(body.data.workosOrganizationId === undefined
            ? {}
            : { organizationId: body.data.workosOrganizationId }),
        });
      } catch (error) {
        return errorResponse(
          isDefinitiveRefreshRejection(error)
            ? "AUTHENTICATION_FAILED"
            : "AUTH_REFRESH_INDETERMINATE",
          requestId,
        );
      }
      if (authentication === null) return errorResponse("SERVICE_UNAVAILABLE", requestId);
      if (
        body.data.workosOrganizationId !== undefined &&
        authentication.organizationId !== body.data.workosOrganizationId
      ) {
        return errorResponse("AUTH_REFRESH_INDETERMINATE", requestId);
      }
      const data = {
        accessToken: authentication.accessToken,
        refreshToken: authentication.refreshToken,
        user: {
          id: authentication.user.id,
          email: authentication.user.email,
          ...(authentication.user.name === null ? {} : { name: authentication.user.name }),
        },
        ...(authentication.organizationId === undefined
          ? {}
          : { workosOrganizationId: authentication.organizationId }),
      };
      return resultResponse(
        { ok: true as const, data, requestId },
        taskctlApiOperations.refreshAuth.responseSchema,
      );
    } catch {
      return errorResponse(providerDispatched ? "AUTH_REFRESH_INDETERMINATE" : "INTERNAL_ERROR", requestId);
    }
  }),
});

http.route({
  method: "GET",
  path: taskctlApiRoutes.organizations,
  handler: httpAction(async (ctx, request) => {
    const requestId = randomRequestId();
    try {
      const query = listOrganizationsQuerySchema.safeParse(
        Object.fromEntries(new URL(request.url).searchParams),
      );
      if (!query.success) return errorResponse("VALIDATION_ERROR", requestId);
      const identified = await readHumanIdentity(ctx, requestId, false);
      if (!identified.ok) {
        return errorResponse(identified.error.code, identified.error.requestId, identified.error.details);
      }
      const limited = await humanRateLimitResponse(ctx, "listOrganizations", requestId);
      if (limited !== null) return limited;
      const observedAt = Date.now();
      const page = await listWorkOSMemberships({
        userId: identified.identity.subject,
        ...(query.data.cursor === undefined ? {} : { cursor: query.data.cursor }),
        limit: query.data.limit,
      });
      if (page === null) return errorResponse("SERVICE_UNAVAILABLE", requestId);
      const result = await ctx.runMutation(internal.humanTenancy.syncOrganizationPage, {
        memberships: page.memberships.map((membership) => ({
          membershipId: membership.id,
          workosOrganizationId: membership.organizationId,
          workosUserId: membership.userId,
          organizationName: membership.organizationName,
          roleSlugs: membershipRoleSlugs(membership),
          providerUpdatedAt: Date.parse(membership.updatedAt),
          observedAt,
        })),
        cursor: page.cursor,
        requestId,
      });
      return resultResponse(result, taskctlApiOperations.listOrganizations.responseSchema);
    } catch {
      return errorResponse("SERVICE_UNAVAILABLE", requestId);
    }
  }),
});

http.route({
  method: "POST",
  path: taskctlApiRoutes.organizations,
  handler: httpAction(async (ctx, request) => {
    const requestId = randomRequestId();
    let operationId: Id<"accountProvisioningOperations"> | undefined;
    let membershipLeaseId: string | undefined;
    let membershipCreateDispatched = false;
    let releaseMembershipLease: (() => Promise<void>) | undefined;
    try {
      if (!hasJsonContentType(request)) return errorResponse("VALIDATION_ERROR", requestId);
      const key = idempotencyKey(request);
      if (key === null) return errorResponse("IDEMPOTENCY_REQUIRED", requestId);
      const body = createOrganizationRequestSchema.safeParse(await parseJsonBody(request));
      if (!body.success) return errorResponse("VALIDATION_ERROR", requestId);
      const identified = await readHumanIdentity(ctx, requestId, false);
      if (!identified.ok) {
        return errorResponse(identified.error.code, identified.error.requestId, identified.error.details);
      }
      const limited = await humanRateLimitResponse(ctx, "createOrganization", requestId);
      if (limited !== null) return limited;
      const requestDigest = await sha256Base64Url(
        JSON.stringify({ operation: "organizations.create", name: body.data.name }),
      );
      const reservation = await ctx.runMutation(
        internal.humanTenancy.reserveOrganizationProvisioning,
        {
          name: body.data.name,
          idempotencyKey: key,
          requestDigest,
          requestId,
        },
      );
      if (!reservation.ok) {
        return errorResponse(
          reservation.error.code,
          reservation.error.requestId,
          reservation.error.details,
        );
      }
      if (reservation.data.kind === "replay") {
        return resultResponse(
          {
            ok: true as const,
            data: { organization: reservation.data.organization },
            requestId: reservation.data.originalRequestId,
          },
          taskctlApiOperations.createOrganization.responseSchema,
        );
      }
      operationId = reservation.data.operationId;
      let organizationObservedAt = Date.now();
      let organization = await findWorkOSOrganizationByExternalId(reservation.data.externalId);
      if (organization === undefined) return errorResponse("SERVICE_UNAVAILABLE", requestId);
      if (organization === null) {
        organizationObservedAt = Date.now();
        organization = await createWorkOSOrganization({
          name: reservation.data.name,
          externalId: reservation.data.externalId,
          idempotencyKey: key,
        });
      }
      if (organization === null) return errorResponse("SERVICE_UNAVAILABLE", requestId);
      if (!workOSOrganizationExternalIdMatches(organization, reservation.data.externalId)) {
        return errorResponse("SERVICE_UNAVAILABLE", requestId);
      }
      const checkpoint = await ctx.runMutation(
        internal.humanTenancy.checkpointOrganizationProvisioning,
        {
          operationId: reservation.data.operationId,
          workosOrganizationId: organization.id,
          organizationName: organization.name,
          externalId: reservation.data.externalId,
          providerUpdatedAt: Date.parse(organization.updatedAt),
          observedAt: organizationObservedAt,
          idempotencyKey: key,
          requestDigest,
          requestId,
        },
      );
      if (!checkpoint.ok) {
        return errorResponse(
          checkpoint.error.code,
          checkpoint.error.requestId,
          checkpoint.error.details,
        );
      }
      if (!checkpoint.data.projectionActive) {
        return errorResponse("PROVISIONING_IN_PROGRESS", requestId, { retryAfterMs: 1_000 });
      }
      const lease = await ctx.runMutation(
        internal.humanTenancy.acquireOwnerMembershipProvisioningLease,
        {
          operationId: reservation.data.operationId,
          workosOrganizationId: organization.id,
          idempotencyKey: key,
          requestDigest,
          requestId,
        },
      );
      if (!lease.ok) {
        return errorResponse(lease.error.code, lease.error.requestId, lease.error.details);
      }
      membershipLeaseId = lease.data.leaseId;
      releaseMembershipLease = async () => {
        if (operationId === undefined || membershipLeaseId === undefined) return;
        const leaseId = membershipLeaseId;
        membershipLeaseId = undefined;
        await ctx.runMutation(internal.humanTenancy.releaseOwnerMembershipProvisioningLease, {
          operationId,
          leaseId,
          requestId,
        });
      };
      let membershipObservedAt = Date.now();
      const polled = await pollWorkOSOwnerMembership({
        userId: identified.identity.subject,
        organizationId: organization.id,
      });
      if (polled === null) {
        await releaseMembershipLease();
        return errorResponse("SERVICE_UNAVAILABLE", requestId);
      }
      let membership: OrganizationMembership;
      if (polled.kind === "active") {
        membership = polled.membership;
      } else if (polled.kind === "not_ready") {
        await releaseMembershipLease();
        return errorResponse("PROVISIONING_IN_PROGRESS", requestId, { retryAfterMs: 1_000 });
      } else {
        const dispatch = await ctx.runMutation(
          internal.humanTenancy.markOwnerMembershipCreateDispatched,
          {
            operationId: reservation.data.operationId,
            workosOrganizationId: organization.id,
            leaseId: lease.data.leaseId,
            idempotencyKey: key,
            requestDigest,
            requestId,
          },
        );
        if (!dispatch.ok) {
          await releaseMembershipLease();
          return errorResponse(dispatch.error.code, dispatch.error.requestId, dispatch.error.details);
        }
        if (!dispatch.data.dispatch) {
          await releaseMembershipLease();
          return errorResponse("PROVISIONING_IN_PROGRESS", requestId, { retryAfterMs: 1_000 });
        }
        membershipCreateDispatched = true;
        membershipObservedAt = Date.now();
        const created = await createWorkOSOwnerMembership({
          userId: identified.identity.subject,
          organizationId: organization.id,
        });
        if (
          created === null ||
          !workOSMembershipLocatorMatches(created, {
            userId: identified.identity.subject,
            organizationId: organization.id,
          }) ||
          !isActiveWorkOSOwnerMembership(created)
        ) {
          await releaseMembershipLease();
          return errorResponse("PROVISIONING_IN_PROGRESS", requestId, { retryAfterMs: 1_000 });
        }
        membership = created;
      }
      const result = await ctx.runMutation(
        internal.humanTenancy.completeOrganizationProvisioning,
        {
          operationId: reservation.data.operationId,
          workosOrganizationId: organization.id,
          workosMembershipId: membership.id,
          workosMembershipOrganizationId: membership.organizationId,
          workosMembershipUserId: membership.userId,
          roleSlugs: membershipRoleSlugs(membership),
          providerUpdatedAt: Date.parse(membership.updatedAt),
          observedAt: membershipObservedAt,
          leaseId: lease.data.leaseId,
          idempotencyKey: key,
          requestDigest,
          requestId,
        },
      );
      if (!result.ok) await releaseMembershipLease();
      return resultResponse(result, taskctlApiOperations.createOrganization.responseSchema);
    } catch {
      if (releaseMembershipLease !== undefined) {
        try {
          await releaseMembershipLease();
        } catch {
          // The durable lease expires; the dispatch marker still prevents a second POST.
        }
      }
      return membershipCreateDispatched
        ? errorResponse("PROVISIONING_IN_PROGRESS", requestId, { retryAfterMs: 1_000 })
        : errorResponse("SERVICE_UNAVAILABLE", requestId);
    }
  }),
});

http.route({
  method: "GET",
  path: taskctlApiRoutes.workspaces,
  handler: httpAction(async (ctx, request) => {
    const requestId = randomRequestId();
    try {
      const query = listWorkspacesQuerySchema.safeParse(
        Object.fromEntries(new URL(request.url).searchParams),
      );
      if (!query.success) return errorResponse("VALIDATION_ERROR", requestId);
      const limited = await humanRateLimitResponse(ctx, "listWorkspaces", requestId);
      if (limited !== null) return limited;
      const result = await ctx.runQuery(internal.humanTenancy.listWorkspaces, {
        ...(query.data.cursor === undefined ? {} : { cursor: query.data.cursor }),
        limit: query.data.limit,
        requestId,
      });
      return resultResponse(result, taskctlApiOperations.listWorkspaces.responseSchema);
    } catch {
      return errorResponse("INTERNAL_ERROR", requestId);
    }
  }),
});

http.route({
  method: "POST",
  path: taskctlApiRoutes.workspaces,
  handler: httpAction(async (ctx, request) => {
    const requestId = randomRequestId();
    try {
      if (!hasJsonContentType(request)) return errorResponse("VALIDATION_ERROR", requestId);
      const key = idempotencyKey(request);
      if (key === null) return errorResponse("IDEMPOTENCY_REQUIRED", requestId);
      const body = createWorkspaceRequestSchema.safeParse(await parseJsonBody(request));
      if (!body.success) return errorResponse("VALIDATION_ERROR", requestId);
      const limited = await humanRateLimitResponse(ctx, "createWorkspace", requestId);
      if (limited !== null) return limited;
      const requestDigest = await sha256Base64Url(
        JSON.stringify({ operation: "workspaces.create", ...body.data }),
      );
      const result = await ctx.runMutation(internal.humanTenancy.createWorkspace, {
        ...body.data,
        idempotencyKey: key,
        requestDigest,
        requestId,
      });
      return resultResponse(result, taskctlApiOperations.createWorkspace.responseSchema);
    } catch {
      return errorResponse("INTERNAL_ERROR", requestId);
    }
  }),
});

http.route({
  method: "GET",
  path: taskctlApiRoutes.agents,
  handler: httpAction(async (ctx, request) => {
    const requestId = randomRequestId();
    try {
      const query = listAgentsQuerySchema.safeParse(
        Object.fromEntries(new URL(request.url).searchParams),
      );
      if (!query.success) return errorResponse("VALIDATION_ERROR", requestId);
      const limited = await humanRateLimitResponse(
        ctx,
        "listAgents",
        requestId,
        query.data.workspaceId,
      );
      if (limited !== null) return limited;
      const result = await ctx.runQuery(internal.humanTenancy.listAgents, {
        workspacePublicId: query.data.workspaceId,
        ...(query.data.cursor === undefined ? {} : { cursor: query.data.cursor }),
        limit: query.data.limit,
        requestId,
      });
      return resultResponse(result, taskctlApiOperations.listAgents.responseSchema);
    } catch {
      return errorResponse("INTERNAL_ERROR", requestId);
    }
  }),
});

http.route({
  method: "GET",
  pathPrefix: "/v1/agents/",
  handler: httpAction(async (ctx, request) => {
    const requestId = randomRequestId();
    try {
      const pathname = new URL(request.url).pathname;
      const match = /^\/v1\/agents\/([^/]+)(?:\/(credentials|sessions))?$/u.exec(pathname);
      if (match?.[1] === undefined) return errorResponse("NOT_FOUND", requestId);
      let agentId: string;
      try {
        agentId = decodeURIComponent(match[1]);
      } catch {
        return errorResponse("VALIDATION_ERROR", requestId);
      }
      const route = agentRouteParamsSchema.safeParse({ agentId });
      if (!route.success) return errorResponse("VALIDATION_ERROR", requestId);
      const search = Object.fromEntries(new URL(request.url).searchParams);
      if (match[2] === "credentials") {
        const query = listAgentCredentialsQuerySchema.safeParse(search);
        if (!query.success) return errorResponse("VALIDATION_ERROR", requestId);
        const limited = await humanRateLimitResponse(
          ctx,
          "listAgentCredentials",
          requestId,
          query.data.workspaceId,
        );
        if (limited !== null) return limited;
        const result = await ctx.runQuery(internal.humanTenancy.listAgentCredentials, {
          workspacePublicId: query.data.workspaceId,
          agentPublicId: route.data.agentId,
          ...(query.data.cursor === undefined ? {} : { cursor: query.data.cursor }),
          limit: query.data.limit,
          requestId,
        });
        return resultResponse(result, taskctlApiOperations.listAgentCredentials.responseSchema);
      }
      if (match[2] === "sessions") {
        const query = listAgentSessionsQuerySchema.safeParse(search);
        if (!query.success) return errorResponse("VALIDATION_ERROR", requestId);
        const limited = await humanRateLimitResponse(
          ctx,
          "listAgentSessions",
          requestId,
          query.data.workspaceId,
        );
        if (limited !== null) return limited;
        const result = await ctx.runQuery(internal.humanTenancy.listAgentSessions, {
          workspacePublicId: query.data.workspaceId,
          agentPublicId: route.data.agentId,
          ...(query.data.cursor === undefined ? {} : { cursor: query.data.cursor }),
          limit: query.data.limit,
          requestId,
        });
        return resultResponse(result, taskctlApiOperations.listAgentSessions.responseSchema);
      }
      const query = getAgentQuerySchema.safeParse(search);
      if (!query.success) return errorResponse("VALIDATION_ERROR", requestId);
      const limited = await humanRateLimitResponse(
        ctx,
        "getAgent",
        requestId,
        query.data.workspaceId,
      );
      if (limited !== null) return limited;
      const result = await ctx.runQuery(internal.humanTenancy.getAgent, {
        workspacePublicId: query.data.workspaceId,
        agentPublicId: route.data.agentId,
        requestId,
      });
      return resultResponse(result, taskctlApiOperations.getAgent.responseSchema);
    } catch {
      return errorResponse("INTERNAL_ERROR", requestId);
    }
  }),
});

http.route({
  method: "POST",
  path: taskctlApiRoutes.agents,
  handler: httpAction(async (ctx, request) => {
    const requestId = randomRequestId();
    try {
      if (!hasJsonContentType(request)) return errorResponse("VALIDATION_ERROR", requestId);
      const key = idempotencyKey(request);
      if (key === null) return errorResponse("IDEMPOTENCY_REQUIRED", requestId);
      const body = createAgentRequestSchema.safeParse(await parseJsonBody(request));
      if (!body.success) return errorResponse("VALIDATION_ERROR", requestId);
      const limited = await humanRateLimitResponse(
        ctx,
        "createAgent",
        requestId,
        body.data.workspaceId,
      );
      if (limited !== null) return limited;
      const enrollment = await prepareEnrollmentToken(body.data.enrollment);
      if (enrollment.kind === "validation") return errorResponse("VALIDATION_ERROR", requestId);
      if (enrollment.kind === "unavailable") return errorResponse("SERVICE_UNAVAILABLE", requestId);
      const scopes = body.data.scopes ?? [...agentPresetScopes[body.data.preset]];
      const credentialLifetimeMs =
        body.data.credentialLifetimeMs ?? DEFAULT_AGENT_CREDENTIAL_LIFETIME_MS;
      const requestDigest = await sha256Base64Url(
        JSON.stringify({
          operation: "agents.create",
          workspaceId: body.data.workspaceId,
          name: body.data.name,
          preset: body.data.preset,
          scopes,
          credentialLifetimeMs,
          enrollmentLocator: enrollment.locator,
          enrollmentFingerprint: enrollment.fingerprint,
        }),
      );
      const result = await ctx.runMutation(internal.humanTenancy.createAgent, {
        workspacePublicId: body.data.workspaceId,
        name: body.data.name,
        scopes,
        enrollmentLocator: enrollment.locator,
        enrollmentVerifierDigest: enrollment.verifierDigest,
        enrollmentPepperVersion: enrollment.pepperVersion,
        credentialLifetimeMs,
        idempotencyKey: key,
        requestDigest,
        requestId,
      });
      return resultResponse(result, taskctlApiOperations.createAgent.responseSchema);
    } catch {
      return errorResponse("INTERNAL_ERROR", requestId);
    }
  }),
});

http.route({
  method: "POST",
  pathPrefix: "/v1/agents/",
  handler: httpAction(async (ctx, request) => {
    const requestId = randomRequestId();
    try {
      if (!hasJsonContentType(request)) return errorResponse("VALIDATION_ERROR", requestId);
      const key = idempotencyKey(request);
      if (key === null) return errorResponse("IDEMPOTENCY_REQUIRED", requestId);
      const pathname = new URL(request.url).pathname;
      const enrollmentMatch = /^\/v1\/agents\/([^/]+)\/enrollments$/u.exec(pathname);
      const disableMatch = /^\/v1\/agents\/([^/]+)\/disable$/u.exec(pathname);
      const revokeMatch = /^\/v1\/agents\/([^/]+)\/credentials\/([^/]+)\/revoke$/u.exec(
        pathname,
      );
      const encodedAgentId = enrollmentMatch?.[1] ?? disableMatch?.[1] ?? revokeMatch?.[1];
      if (encodedAgentId === undefined) return errorResponse("NOT_FOUND", requestId);
      let agentId: string;
      try {
        agentId = decodeURIComponent(encodedAgentId);
      } catch {
        return errorResponse("VALIDATION_ERROR", requestId);
      }
      const route = agentRouteParamsSchema.safeParse({ agentId });
      if (!route.success) return errorResponse("VALIDATION_ERROR", requestId);

      if (enrollmentMatch !== null) {
        const body = createAgentEnrollmentRequestSchema.safeParse(await parseJsonBody(request));
        if (!body.success) return errorResponse("VALIDATION_ERROR", requestId);
        const limited = await humanRateLimitResponse(
          ctx,
          "createAgentEnrollment",
          requestId,
          body.data.workspaceId,
        );
        if (limited !== null) return limited;
        const enrollment = await prepareEnrollmentToken(body.data.enrollment);
        if (enrollment.kind === "validation") return errorResponse("VALIDATION_ERROR", requestId);
        if (enrollment.kind === "unavailable") return errorResponse("SERVICE_UNAVAILABLE", requestId);
        const requestDigest = await sha256Base64Url(
          JSON.stringify({
            operation: "agents.enrollments.create",
            agentId,
            workspaceId: body.data.workspaceId,
            scopes: body.data.scopes,
            credentialLifetimeMs:
              body.data.credentialLifetimeMs ?? DEFAULT_AGENT_CREDENTIAL_LIFETIME_MS,
            enrollmentLocator: enrollment.locator,
            enrollmentFingerprint: enrollment.fingerprint,
          }),
        );
        const result = await ctx.runMutation(internal.humanTenancy.createAgentEnrollment, {
          agentPublicId: route.data.agentId,
          workspacePublicId: body.data.workspaceId,
          ...(body.data.scopes === undefined ? {} : { scopes: body.data.scopes }),
          enrollmentLocator: enrollment.locator,
          enrollmentVerifierDigest: enrollment.verifierDigest,
          enrollmentPepperVersion: enrollment.pepperVersion,
          credentialLifetimeMs:
            body.data.credentialLifetimeMs ?? DEFAULT_AGENT_CREDENTIAL_LIFETIME_MS,
          idempotencyKey: key,
          requestDigest,
          requestId,
        });
        return resultResponse(result, taskctlApiOperations.createAgentEnrollment.responseSchema);
      }

      if (revokeMatch?.[2] !== undefined) {
        let credentialId: string;
        try {
          credentialId = decodeURIComponent(revokeMatch[2]);
        } catch {
          return errorResponse("VALIDATION_ERROR", requestId);
        }
        const credentialRoute = agentCredentialRouteParamsSchema.safeParse({
          agentId,
          credentialId,
        });
        if (!credentialRoute.success) return errorResponse("VALIDATION_ERROR", requestId);
        const body = revokeAgentCredentialRequestSchema.safeParse(await parseJsonBody(request));
        if (!body.success) return errorResponse("VALIDATION_ERROR", requestId);
        const limited = await humanRateLimitResponse(
          ctx,
          "revokeAgentCredential",
          requestId,
          body.data.workspaceId,
        );
        if (limited !== null) return limited;
        const requestDigest = await sha256Base64Url(
          JSON.stringify({
            operation: "agents.credentials.revoke",
            agentId: credentialRoute.data.agentId,
            credentialId: credentialRoute.data.credentialId,
            workspaceId: body.data.workspaceId,
          }),
        );
        const result = await ctx.runMutation(internal.humanTenancy.revokeAgentCredential, {
          workspacePublicId: body.data.workspaceId,
          agentPublicId: credentialRoute.data.agentId,
          credentialLocator: credentialRoute.data.credentialId,
          idempotencyKey: key,
          requestDigest,
          requestId,
        });
        return resultResponse(result, taskctlApiOperations.revokeAgentCredential.responseSchema);
      }

      const body = disableAgentRequestSchema.safeParse(await parseJsonBody(request));
      if (!body.success) return errorResponse("VALIDATION_ERROR", requestId);
      const limited = await humanRateLimitResponse(
        ctx,
        "disableAgent",
        requestId,
        body.data.workspaceId,
      );
      if (limited !== null) return limited;
      const requestDigest = await sha256Base64Url(
        JSON.stringify({
          operation: "agents.disable",
          agentId: route.data.agentId,
          workspaceId: body.data.workspaceId,
        }),
      );
      const result = await ctx.runMutation(internal.humanTenancy.disableAgent, {
        workspacePublicId: body.data.workspaceId,
        agentPublicId: route.data.agentId,
        idempotencyKey: key,
        requestDigest,
        requestId,
      });
      return resultResponse(result, taskctlApiOperations.disableAgent.responseSchema);
    } catch {
      return errorResponse("INTERNAL_ERROR", requestId);
    }
  }),
});

http.route({
  method: "POST",
  path: taskctlApiRoutes.redeemEnrollment,
  handler: httpAction(async (ctx, request) => {
    const requestId = randomRequestId();
    try {
      if (!hasJsonContentType(request)) return errorResponse("VALIDATION_ERROR", requestId);
      const key = idempotencyKey(request);
      if (key === null) return errorResponse("IDEMPOTENCY_REQUIRED", requestId);
      const body = redeemEnrollmentRequestSchema.safeParse(await parseJsonBody(request));
      if (!body.success) return errorResponse("VALIDATION_ERROR", requestId);
      const enrollment = await authenticateEnrollment(ctx, bearerValue(request) ?? "");
      if (enrollment.kind === "unavailable") return errorResponse("SERVICE_UNAVAILABLE", requestId);
      if (enrollment.kind !== "success") {
        const retryAfterMs = await authenticationFailureIsRateLimited(
          ctx,
          request,
          requestId,
          "enrollment",
          "enrollment_auth_failure",
        );
        return retryAfterMs === null
          ? errorResponse("AUTHENTICATION_FAILED", requestId)
          : errorResponse("RATE_LIMITED", requestId, { retryAfterMs });
      }
      const proposed = parseCredentialToken(body.data.credential);
      const pepper = currentPepper("credential");
      if (proposed === null || pepper === null) return errorResponse("SERVICE_UNAVAILABLE", requestId);
      const message = decodeBearerSecret(proposed.secret);
      if (message === null) return errorResponse("VALIDATION_ERROR", requestId);
      const verifier = await hmacSha256Base64Url(pepper.key, message);
      const verifierBytes = digestArrayBuffer(verifier);
      if (verifierBytes === null) return errorResponse("INTERNAL_ERROR", requestId);
      const requestDigest = await sha256Base64Url(
        JSON.stringify({ operation: "agent.enrollments.redeem", credentialLocator: proposed.locator, verifier }),
      );
      const result = await ctx.runMutation(internal.agents.redeemEnrollment, {
        enrollmentId: enrollment.enrollmentId,
        credentialLocator: proposed.locator,
        credentialVerifierDigest: verifierBytes,
        credentialPepperVersion: pepper.version,
        idempotencyKey: key,
        requestDigest,
        requestId,
      });
      return resultResponse(result, taskctlApiOperations.redeemEnrollment.responseSchema);
    } catch {
      return errorResponse("INTERNAL_ERROR", requestId);
    }
  }),
});

http.route({
  method: "POST",
  path: taskctlApiRoutes.sessions,
  handler: httpAction(async (ctx, request) => {
    const requestId = randomRequestId();
    try {
      if (!hasJsonContentType(request)) return errorResponse("VALIDATION_ERROR", requestId);
      const key = idempotencyKey(request);
      if (key === null) return errorResponse("IDEMPOTENCY_REQUIRED", requestId);
      const body = startSessionRequestSchema.safeParse(await parseJsonBody(request));
      if (!body.success) return errorResponse("VALIDATION_ERROR", requestId);
      const authenticated = await authenticateAgentRequest(
        ctx,
        request,
        requestId,
        "startSession",
      );
      if (authenticated.kind === "error") return authenticated.response;
      const requestDigest = await sha256Base64Url(
        JSON.stringify({ operation: "agent.sessions.start", credentialLocator: authenticated.credential.locator }),
      );
      const result = await ctx.runMutation(internal.agents.startSession, {
        credentialId: authenticated.credential.credentialId,
        idempotencyKey: key,
        requestDigest,
        requestId,
      });
      return resultResponse(result, taskctlApiOperations.startSession.responseSchema);
    } catch {
      return errorResponse("INTERNAL_ERROR", requestId);
    }
  }),
});

http.route({
  method: "GET",
  path: taskctlApiRoutes.context,
  handler: httpAction(async (ctx, request) => {
    const requestId = randomRequestId();
    try {
      const authenticated = await authenticateSessionRequest(ctx, request, requestId, "context");
      if (authenticated.kind === "error") return authenticated.response;
      const touched = await ctx.runMutation(internal.agents.touchSession, {
        credentialId: authenticated.credential.credentialId,
        sessionPublicId: authenticated.sessionPublicId,
        requestId,
      });
      if (!touched.ok) return errorResponse(touched.error.code, touched.error.requestId, touched.error.details);
      const result = await ctx.runQuery(internal.tasks.context, {
        credentialId: authenticated.credential.credentialId,
        sessionPublicId: authenticated.sessionPublicId,
        requestId,
      });
      return resultResponse(result, taskctlApiOperations.context.responseSchema);
    } catch {
      return errorResponse("INTERNAL_ERROR", requestId);
    }
  }),
});

http.route({
  method: "POST",
  path: taskctlApiRoutes.tasks,
  handler: httpAction(async (ctx, request) => {
    const requestId = randomRequestId();
    try {
      if (!hasJsonContentType(request)) return errorResponse("VALIDATION_ERROR", requestId);
      const key = idempotencyKey(request);
      if (key === null) return errorResponse("IDEMPOTENCY_REQUIRED", requestId);
      const body = createTaskRequestSchema.safeParse(await parseJsonBody(request));
      if (!body.success) return errorResponse("VALIDATION_ERROR", requestId);
      const authenticated = await authenticateSessionRequest(
        ctx,
        request,
        requestId,
        "createTask",
      );
      if (authenticated.kind === "error") return authenticated.response;
      const requestDigest = await sha256Base64Url(
        JSON.stringify({ operation: "tasks.create", ...body.data }),
      );
      const mutation = await runIdempotentMutationWithRetry(requestId, async () =>
        await ctx.runMutation(internal.workGraph.createTask, {
          credentialId: authenticated.credential.credentialId,
          sessionPublicId: authenticated.sessionPublicId,
          title: body.data.title,
          ...(body.data.description === undefined ? {} : { description: body.data.description }),
          type: body.data.type,
          priority: body.data.priority,
          ...(body.data.availableAt === undefined ? {} : { availableAt: body.data.availableAt }),
          ...(body.data.parentKey === undefined ? {} : { parentKey: body.data.parentKey }),
          ...(body.data.labels === undefined ? {} : { labels: body.data.labels }),
          idempotencyKey: key,
          requestDigest,
          requestId,
        }),
      );
      if (mutation.kind === "exhausted") return errorResponse("SERVICE_UNAVAILABLE", requestId);
      return resultResponse(mutation.value, taskctlApiOperations.createTask.responseSchema);
    } catch {
      return errorResponse("INTERNAL_ERROR", requestId);
    }
  }),
});

http.route({
  method: "GET",
  path: taskctlApiRoutes.readyTasks,
  handler: httpAction(async (ctx, request) => {
    const requestId = randomRequestId();
    try {
      const url = new URL(request.url);
      const query = readyTasksQuerySchema.safeParse(Object.fromEntries(url.searchParams));
      if (!query.success) return errorResponse("VALIDATION_ERROR", requestId);
      const authenticated = await authenticateSessionRequest(
        ctx,
        request,
        requestId,
        "readyTasks",
      );
      if (authenticated.kind === "error") return authenticated.response;
      const touched = await ctx.runMutation(internal.agents.touchSession, {
        credentialId: authenticated.credential.credentialId,
        sessionPublicId: authenticated.sessionPublicId,
        requestId,
      });
      if (!touched.ok) return errorResponse(touched.error.code, touched.error.requestId, touched.error.details);
      const result = await ctx.runQuery(internal.tasks.readyTasks, {
        credentialId: authenticated.credential.credentialId,
        sessionPublicId: authenticated.sessionPublicId,
        ...(query.data.cursor === undefined ? {} : { cursor: query.data.cursor }),
        limit: query.data.limit,
        requestId,
      });
      return resultResponse(result, taskctlApiOperations.readyTasks.responseSchema);
    } catch {
      return errorResponse("INTERNAL_ERROR", requestId);
    }
  }),
});

http.route({
  method: "GET",
  path: taskctlApiRoutes.tasks,
  handler: httpAction(async (ctx, request) => {
    const requestId = randomRequestId();
    try {
      const query = listTasksQuerySchema.safeParse(
        Object.fromEntries(new URL(request.url).searchParams),
      );
      if (!query.success) return errorResponse("VALIDATION_ERROR", requestId);
      const authenticated = await authenticateSessionRequest(ctx, request, requestId, "listTasks");
      if (authenticated.kind === "error") return authenticated.response;
      const result = await ctx.runQuery(internal.workGraph.listTasks, {
        credentialId: authenticated.credential.credentialId,
        sessionPublicId: authenticated.sessionPublicId,
        ...(query.data.cursor === undefined ? {} : { cursor: query.data.cursor }),
        limit: query.data.limit,
        ...(query.data.status === undefined ? {} : { status: query.data.status }),
        ...(query.data.type === undefined ? {} : { type: query.data.type }),
        ...(query.data.priority === undefined ? {} : { priority: query.data.priority }),
        ...(query.data.assigneeAgentId === undefined
          ? {}
          : { assigneeAgentId: query.data.assigneeAgentId }),
        ...(query.data.label === undefined ? {} : { label: query.data.label }),
        ...(query.data.parentKey === undefined ? {} : { parentKey: query.data.parentKey }),
        ...(query.data.updatedAfter === undefined
          ? {}
          : { updatedAfter: query.data.updatedAfter }),
        requestId,
      });
      return resultResponse(result, taskctlApiOperations.listTasks.responseSchema);
    } catch {
      return errorResponse("INTERNAL_ERROR", requestId);
    }
  }),
});

http.route({
  method: "GET",
  path: taskctlApiRoutes.blockedTasks,
  handler: httpAction(async (ctx, request) => {
    const requestId = randomRequestId();
    try {
      const query = blockedTasksQuerySchema.safeParse(
        Object.fromEntries(new URL(request.url).searchParams),
      );
      if (!query.success) return errorResponse("VALIDATION_ERROR", requestId);
      const authenticated = await authenticateSessionRequest(
        ctx,
        request,
        requestId,
        "blockedTasks",
      );
      if (authenticated.kind === "error") return authenticated.response;
      const result = await ctx.runQuery(internal.workGraph.blockedTasks, {
        credentialId: authenticated.credential.credentialId,
        sessionPublicId: authenticated.sessionPublicId,
        ...(query.data.cursor === undefined ? {} : { cursor: query.data.cursor }),
        limit: query.data.limit,
        ...(query.data.attentionOnly === undefined
          ? {}
          : { attentionOnly: query.data.attentionOnly }),
        requestId,
      });
      return resultResponse(result, taskctlApiOperations.blockedTasks.responseSchema);
    } catch {
      return errorResponse("INTERNAL_ERROR", requestId);
    }
  }),
});

http.route({
  method: "GET",
  path: taskctlApiRoutes.reviews,
  handler: httpAction(async (ctx, request) => {
    const requestId = randomRequestId();
    try {
      const query = reviewQueueQuerySchema.safeParse(
        Object.fromEntries(new URL(request.url).searchParams),
      );
      if (!query.success) return errorResponse("VALIDATION_ERROR", requestId);
      const authenticated = await authenticateSessionRequest(
        ctx,
        request,
        requestId,
        "reviewQueue",
      );
      if (authenticated.kind === "error") return authenticated.response;
      const result = await ctx.runQuery(internal.workGraph.listReviewQueue, {
        credentialId: authenticated.credential.credentialId,
        sessionPublicId: authenticated.sessionPublicId,
        ...(query.data.cursor === undefined ? {} : { cursor: query.data.cursor }),
        limit: query.data.limit,
        requestId,
      });
      return resultResponse(result, taskctlApiOperations.reviewQueue.responseSchema);
    } catch {
      return errorResponse("INTERNAL_ERROR", requestId);
    }
  }),
});

http.route({
  method: "GET",
  path: taskctlApiRoutes.workspaceRepositories,
  handler: httpAction(async (ctx, request) => {
    const requestId = randomRequestId();
    try {
      const query = listWorkspaceRepositoriesQuerySchema.safeParse(
        Object.fromEntries(new URL(request.url).searchParams),
      );
      if (!query.success) return errorResponse("VALIDATION_ERROR", requestId);
      const limited = await humanRateLimitResponse(
        ctx,
        "listWorkspaceRepositories",
        requestId,
        query.data.workspaceId,
      );
      if (limited !== null) return limited;
      const result = await ctx.runQuery(internal.workGraph.listWorkspaceRepositoriesForHuman, {
        workspacePublicId: query.data.workspaceId,
        ...(query.data.cursor === undefined ? {} : { cursor: query.data.cursor }),
        limit: query.data.limit,
        requestId,
      });
      return resultResponse(result, taskctlApiOperations.listWorkspaceRepositories.responseSchema);
    } catch {
      return errorResponse("INTERNAL_ERROR", requestId);
    }
  }),
});

http.route({
  method: "POST",
  path: taskctlApiRoutes.workspaceRepositories,
  handler: httpAction(async (ctx, request) => {
    const requestId = randomRequestId();
    try {
      if (!hasJsonContentType(request)) return errorResponse("VALIDATION_ERROR", requestId);
      const key = idempotencyKey(request);
      if (key === null) return errorResponse("IDEMPOTENCY_REQUIRED", requestId);
      const body = createWorkspaceRepositoryRequestSchema.safeParse(await parseJsonBody(request));
      if (!body.success) return errorResponse("VALIDATION_ERROR", requestId);
      const limited = await humanRateLimitResponse(
        ctx,
        "createWorkspaceRepository",
        requestId,
        body.data.workspaceId,
      );
      if (limited !== null) return limited;
      const requestDigest = await sha256Base64Url(
        JSON.stringify({ operation: "workspace.repositories.create", ...body.data }),
      );
      const result = await ctx.runMutation(
        internal.workGraph.createWorkspaceRepositoryForHuman,
        {
          workspacePublicId: body.data.workspaceId,
          name: body.data.name,
          provider: body.data.provider,
          url: body.data.url,
          idempotencyKey: key,
          requestDigest,
          requestId,
        },
      );
      return resultResponse(result, taskctlApiOperations.createWorkspaceRepository.responseSchema);
    } catch {
      return errorResponse("INTERNAL_ERROR", requestId);
    }
  }),
});

http.route({
  method: "POST",
  pathPrefix: "/v1/workspace/repositories/",
  handler: httpAction(async (ctx, request) => {
    const requestId = randomRequestId();
    try {
      if (!hasJsonContentType(request)) return errorResponse("VALIDATION_ERROR", requestId);
      const key = idempotencyKey(request);
      if (key === null) return errorResponse("IDEMPOTENCY_REQUIRED", requestId);
      const match = /^\/v1\/workspace\/repositories\/([^/]+)\/remove$/u.exec(
        new URL(request.url).pathname,
      );
      if (match?.[1] === undefined) return errorResponse("NOT_FOUND", requestId);
      let repositoryId: string;
      try {
        repositoryId = decodeURIComponent(match[1]);
      } catch {
        return errorResponse("VALIDATION_ERROR", requestId);
      }
      const route = repositoryRouteParamsSchema.safeParse({ repositoryId });
      const body = removeWorkspaceRepositoryRequestSchema.safeParse(await parseJsonBody(request));
      if (!route.success || !body.success) return errorResponse("VALIDATION_ERROR", requestId);
      const limited = await humanRateLimitResponse(
        ctx,
        "removeWorkspaceRepository",
        requestId,
        body.data.workspaceId,
      );
      if (limited !== null) return limited;
      const requestDigest = await sha256Base64Url(
        JSON.stringify({
          operation: "workspace.repositories.remove",
          repositoryId: route.data.repositoryId,
          workspaceId: body.data.workspaceId,
        }),
      );
      const result = await ctx.runMutation(
        internal.workGraph.removeWorkspaceRepositoryForHuman,
        {
          workspacePublicId: body.data.workspaceId,
          repositoryPublicId: route.data.repositoryId,
          idempotencyKey: key,
          requestDigest,
          requestId,
        },
      );
      return resultResponse(result, taskctlApiOperations.removeWorkspaceRepository.responseSchema);
    } catch {
      return errorResponse("INTERNAL_ERROR", requestId);
    }
  }),
});

http.route({
  method: "GET",
  pathPrefix: "/v1/tasks/",
  handler: httpAction(async (ctx, request) => {
    const requestId = randomRequestId();
    try {
      const url = new URL(request.url);
      const match = /^\/v1\/tasks\/([^/]+)(?:\/(labels|comments|events|graph|dependencies|references))?$/u.exec(
        url.pathname,
      );
      if (match?.[1] === undefined) return errorResponse("NOT_FOUND", requestId);
      let key: string;
      try {
        key = decodeURIComponent(match[1]);
      } catch {
        return errorResponse("VALIDATION_ERROR", requestId);
      }
      const route = taskRouteParamsSchema.safeParse({ key });
      if (!route.success) return errorResponse("VALIDATION_ERROR", requestId);
      const readOperation: ApiOperationName =
        match[2] === undefined
          ? "getTask"
          : match[2] === "labels"
            ? "listTaskLabels"
            : match[2] === "comments"
              ? "listTaskComments"
              : match[2] === "events"
                ? "listTaskEvents"
                : match[2] === "graph"
                  ? "taskGraph"
                  : match[2] === "dependencies"
                    ? "listTaskDependencies"
                    : "listTaskReferences";
      const authenticated = await authenticateSessionRequest(
        ctx,
        request,
        requestId,
        readOperation,
      );
      if (authenticated.kind === "error") return authenticated.response;
      const common = {
        credentialId: authenticated.credential.credentialId,
        sessionPublicId: authenticated.sessionPublicId,
        key: route.data.key,
        requestId,
      };
      const search = Object.fromEntries(url.searchParams);
      if (match[2] === undefined) {
        if (url.searchParams.size > 0) return errorResponse("VALIDATION_ERROR", requestId);
        const result = await ctx.runQuery(internal.workGraph.getTask, common);
        return resultResponse(result, taskctlApiOperations.getTask.responseSchema);
      }
      if (match[2] === "labels") {
        if (url.searchParams.size > 0) return errorResponse("VALIDATION_ERROR", requestId);
        const result = await ctx.runQuery(internal.workGraph.listTaskLabels, common);
        return resultResponse(result, taskctlApiOperations.listTaskLabels.responseSchema);
      }
      if (match[2] === "comments") {
        const query = listTaskCommentsQuerySchema.safeParse(search);
        if (!query.success) return errorResponse("VALIDATION_ERROR", requestId);
        const result = await ctx.runQuery(internal.workGraph.listTaskComments, {
          ...common,
          ...(query.data.cursor === undefined ? {} : { cursor: query.data.cursor }),
          limit: query.data.limit,
        });
        return resultResponse(result, taskctlApiOperations.listTaskComments.responseSchema);
      }
      if (match[2] === "events") {
        const query = listTaskEventsQuerySchema.safeParse(search);
        if (!query.success) return errorResponse("VALIDATION_ERROR", requestId);
        const result = await ctx.runQuery(internal.workGraph.listTaskEvents, {
          ...common,
          ...(query.data.cursor === undefined ? {} : { cursor: query.data.cursor }),
          limit: query.data.limit,
        });
        return resultResponse(result, taskctlApiOperations.listTaskEvents.responseSchema);
      }
      if (match[2] === "graph") {
        const query = taskGraphQuerySchema.safeParse(search);
        if (!query.success) return errorResponse("VALIDATION_ERROR", requestId);
        const result = await ctx.runQuery(internal.workGraph.getTaskGraph, {
          ...common,
          depth: query.data.depth,
          limit: query.data.limit,
        });
        return resultResponse(result, taskctlApiOperations.taskGraph.responseSchema);
      }
      if (match[2] === "dependencies") {
        const query = listTaskDependenciesQuerySchema.safeParse(search);
        if (!query.success) return errorResponse("VALIDATION_ERROR", requestId);
        const result = await ctx.runQuery(internal.workGraph.listTaskDependencies, {
          ...common,
          direction: query.data.direction,
          ...(query.data.cursor === undefined ? {} : { cursor: query.data.cursor }),
          limit: query.data.limit,
        });
        return resultResponse(result, taskctlApiOperations.listTaskDependencies.responseSchema);
      }
      const query = listTaskReferencesQuerySchema.safeParse(search);
      if (!query.success) return errorResponse("VALIDATION_ERROR", requestId);
      const result = await ctx.runQuery(internal.workGraph.listTaskReferences, {
        ...common,
        ...(query.data.cursor === undefined ? {} : { cursor: query.data.cursor }),
        limit: query.data.limit,
      });
      return resultResponse(result, taskctlApiOperations.listTaskReferences.responseSchema);
    } catch {
      return errorResponse("INTERNAL_ERROR", requestId);
    }
  }),
});

async function taskCommand(
  ctx: ActionCtx,
  request: Request,
  operation: "claim" | "renew" | "release",
): Promise<Response> {
  const requestId = randomRequestId();
  try {
    if (!hasJsonContentType(request)) return errorResponse("VALIDATION_ERROR", requestId);
    const key = idempotencyKey(request);
    if (key === null) return errorResponse("IDEMPOTENCY_REQUIRED", requestId);
    const rateLimitOperation: ApiOperationName =
      operation === "claim"
        ? "claimTask"
        : operation === "renew"
          ? "renewClaim"
          : "releaseClaim";
    const authenticated = await authenticateSessionRequest(
      ctx,
      request,
      requestId,
      rateLimitOperation,
    );
    if (authenticated.kind === "error") return authenticated.response;
    const pathname = new URL(request.url).pathname;
    const match = /^\/v1\/tasks\/([^/]+)\/claim(?:\/(renew|release))?$/u.exec(pathname);
    if (match === null) return errorResponse("NOT_FOUND", requestId);
    const route = taskRouteParamsSchema.safeParse({ key: match[1] });
    if (!route.success) return errorResponse("VALIDATION_ERROR", requestId);
    const rawBody = await parseJsonBody(request);
    const body =
      operation === "claim"
        ? claimTaskRequestSchema.safeParse(rawBody)
        : operation === "renew"
          ? renewClaimRequestSchema.safeParse(rawBody)
          : releaseClaimRequestSchema.safeParse(rawBody);
    if (!body.success) return errorResponse("VALIDATION_ERROR", requestId);
    const bodyData = body.data as { fence?: number };
    const operationName =
      operation === "claim"
        ? "tasks.claim"
        : operation === "renew"
          ? "tasks.claim.renew"
          : "tasks.claim.release";
    const requestDigest = await sha256Base64Url(
      JSON.stringify({ operation: operationName, key: route.data.key, ...bodyData }),
    );
    const common = {
      credentialId: authenticated.credential.credentialId,
      sessionPublicId: authenticated.sessionPublicId,
      key: route.data.key,
      idempotencyKey: key,
      requestDigest,
      requestId,
    };
    if (operation === "claim") {
      const mutation = await runIdempotentMutationWithRetry(requestId, async () =>
        await ctx.runMutation(internal.tasks.claimTask, common),
      );
      if (mutation.kind === "exhausted") return errorResponse("SERVICE_UNAVAILABLE", requestId);
      return resultResponse(mutation.value, taskctlApiOperations.claimTask.responseSchema);
    }
    const fence = bodyData.fence;
    if (fence === undefined) return errorResponse("VALIDATION_ERROR", requestId);
    if (operation === "renew") {
      const mutation = await runIdempotentMutationWithRetry(requestId, async () =>
        await ctx.runMutation(internal.tasks.renewClaim, { ...common, fence }),
      );
      if (mutation.kind === "exhausted") return errorResponse("SERVICE_UNAVAILABLE", requestId);
      return resultResponse(mutation.value, taskctlApiOperations.renewClaim.responseSchema);
    }
    const mutation = await runIdempotentMutationWithRetry(requestId, async () =>
      await ctx.runMutation(internal.tasks.releaseClaim, { ...common, fence }),
    );
    if (mutation.kind === "exhausted") return errorResponse("SERVICE_UNAVAILABLE", requestId);
    return resultResponse(mutation.value, taskctlApiOperations.releaseClaim.responseSchema);
  } catch {
    return errorResponse("INTERNAL_ERROR", requestId);
  }
}

function taskMutationRateLimitOperation(
  action: string | undefined,
  removingReference: boolean,
): AuthenticatedAgentOperation | null {
  if (removingReference) return "removeTaskReference";
  if (action === undefined) return null;
  switch (action) {
    case "update":
      return "updateTask";
    case "assign":
      return "assignTask";
    case "defer":
      return "deferTask";
    case "labels":
      return "addTaskLabel";
    case "labels/remove":
      return "removeTaskLabel";
    case "comments":
      return "addTaskComment";
    case "dependencies":
      return "addTaskDependency";
    case "dependencies/remove":
      return "removeTaskDependency";
    case "parent/set":
      return "setTaskParent";
    case "parent/clear":
      return "clearTaskParent";
    case "references":
      return "addTaskReference";
    case "submit":
      return "submitTask";
    case "accept":
      return "acceptTask";
    case "reject":
      return "rejectTask";
    default:
      return null;
  }
}

async function taskMutationCommand(ctx: ActionCtx, request: Request): Promise<Response> {
  const requestId = randomRequestId();
  try {
    if (!hasJsonContentType(request)) return errorResponse("VALIDATION_ERROR", requestId);
    const idempotency = idempotencyKey(request);
    if (idempotency === null) return errorResponse("IDEMPOTENCY_REQUIRED", requestId);
    const pathname = new URL(request.url).pathname;
    const referenceRemoveMatch = /^\/v1\/tasks\/([^/]+)\/references\/([^/]+)\/remove$/u.exec(
      pathname,
    );
    const actionMatch = /^\/v1\/tasks\/([^/]+)\/(update|cancel|reopen|assign|defer|labels|labels\/remove|comments|dependencies|dependencies\/remove|parent\/set|parent\/clear|references|submit|accept|reject)$/u.exec(
      pathname,
    );
    const encodedKey = referenceRemoveMatch?.[1] ?? actionMatch?.[1];
    if (encodedKey === undefined) return errorResponse("NOT_FOUND", requestId);
    let key: string;
    try {
      key = decodeURIComponent(encodedKey);
    } catch {
      return errorResponse("VALIDATION_ERROR", requestId);
    }
    const taskRoute = taskRouteParamsSchema.safeParse({ key });
    if (!taskRoute.success) return errorResponse("VALIDATION_ERROR", requestId);
    const rawBody = await parseJsonBody(request);

    if (actionMatch?.[2] === "cancel") {
      const body = cancelTaskRequestSchema.safeParse(rawBody);
      if (!body.success) return errorResponse("VALIDATION_ERROR", requestId);
      const limited = await humanRateLimitResponse(
        ctx,
        "cancelTask",
        requestId,
        body.data.workspaceId,
      );
      if (limited !== null) return limited;
      const requestDigest = await sha256Base64Url(
        JSON.stringify({ operation: "tasks.cancel", key: taskRoute.data.key, ...body.data }),
      );
      const mutation = await runIdempotentMutationWithRetry(requestId, async () =>
        await ctx.runMutation(internal.workGraph.cancelTaskForHuman, {
          workspacePublicId: body.data.workspaceId,
          key: taskRoute.data.key,
          revision: body.data.revision,
          reason: body.data.reason,
          idempotencyKey: idempotency,
          requestDigest,
          requestId,
        }),
      );
      if (mutation.kind === "exhausted") return errorResponse("SERVICE_UNAVAILABLE", requestId);
      return resultResponse(mutation.value, taskctlApiOperations.cancelTask.responseSchema);
    }
    if (actionMatch?.[2] === "reopen") {
      const body = reopenTaskRequestSchema.safeParse(rawBody);
      if (!body.success) return errorResponse("VALIDATION_ERROR", requestId);
      const limited = await humanRateLimitResponse(
        ctx,
        "reopenTask",
        requestId,
        body.data.workspaceId,
      );
      if (limited !== null) return limited;
      const requestDigest = await sha256Base64Url(
        JSON.stringify({ operation: "tasks.reopen", key: taskRoute.data.key, ...body.data }),
      );
      const mutation = await runIdempotentMutationWithRetry(requestId, async () =>
        await ctx.runMutation(internal.workGraph.reopenTaskForHuman, {
          workspacePublicId: body.data.workspaceId,
          key: taskRoute.data.key,
          revision: body.data.revision,
          idempotencyKey: idempotency,
          requestDigest,
          requestId,
        }),
      );
      if (mutation.kind === "exhausted") return errorResponse("SERVICE_UNAVAILABLE", requestId);
      return resultResponse(mutation.value, taskctlApiOperations.reopenTask.responseSchema);
    }

    const rateLimitOperation = taskMutationRateLimitOperation(
      actionMatch?.[2],
      referenceRemoveMatch !== null,
    );
    if (rateLimitOperation === null) return errorResponse("NOT_FOUND", requestId);
    const authenticated = await authenticateSessionRequest(
      ctx,
      request,
      requestId,
      rateLimitOperation,
    );
    if (authenticated.kind === "error") return authenticated.response;
    const common = {
      credentialId: authenticated.credential.credentialId,
      sessionPublicId: authenticated.sessionPublicId,
      key: taskRoute.data.key,
      idempotencyKey: idempotency,
      requestId,
    };

    if (actionMatch?.[2] === "submit") {
      const body = submitTaskRequestSchema.safeParse(rawBody);
      if (!body.success) return errorResponse("VALIDATION_ERROR", requestId);
      const requestDigest = await sha256Base64Url(
        JSON.stringify({ operation: "tasks.submit", key: taskRoute.data.key, ...body.data }),
      );
      const result = await ctx.runMutation(internal.workGraph.submitTask, {
        ...common,
        fence: body.data.fence,
        ...(body.data.expectedReviewRevision === undefined
          ? {}
          : { expectedReviewRevision: body.data.expectedReviewRevision }),
        ...(body.data.dispatch === undefined ? {} : { dispatch: body.data.dispatch }),
        summary: body.data.summary,
        evidence: body.data.evidence.map((item) =>
          item.kind === "commit"
            ? {
                kind: "commit" as const,
                sha: item.sha,
                ...(item.url === undefined ? {} : { url: item.url }),
              }
            : item,
        ),
        requestDigest,
      });
      return resultResponse(result, taskctlApiOperations.submitTask.responseSchema);
    }

    if (actionMatch?.[2] === "accept" || actionMatch?.[2] === "reject") {
      const isAccept = actionMatch[2] === "accept";
      const body = isAccept
        ? acceptTaskRequestSchema.safeParse(rawBody)
        : rejectTaskRequestSchema.safeParse(rawBody);
      if (!body.success) return errorResponse("VALIDATION_ERROR", requestId);
      const rejectionReason = isAccept
        ? undefined
        : rejectTaskRequestSchema.parse(rawBody).reason;
      const requestDigest = await sha256Base64Url(
        JSON.stringify({
          operation: isAccept ? "tasks.accept" : "tasks.reject",
          key: taskRoute.data.key,
          ...body.data,
        }),
      );
      const mutation = await runIdempotentMutationWithRetry(requestId, async () =>
        isAccept
          ? await ctx.runMutation(internal.workGraph.acceptTask, {
              ...common,
              submissionPublicId: body.data.submissionId,
              reviewRevision: body.data.reviewRevision,
              requestDigest,
            })
          : await ctx.runMutation(internal.workGraph.rejectTask, {
              ...common,
              submissionPublicId: body.data.submissionId,
              reviewRevision: body.data.reviewRevision,
              reason: rejectionReason ?? "",
              requestDigest,
            }),
      );
      if (mutation.kind === "exhausted") return errorResponse("SERVICE_UNAVAILABLE", requestId);
      return resultResponse(
        mutation.value,
        isAccept
          ? taskctlApiOperations.acceptTask.responseSchema
          : taskctlApiOperations.rejectTask.responseSchema,
      );
    }

    if (actionMatch?.[2] === "update") {
      const body = updateTaskRequestSchema.safeParse(rawBody);
      if (!body.success) return errorResponse("VALIDATION_ERROR", requestId);
      const requestDigest = await sha256Base64Url(
        JSON.stringify({ operation: "tasks.update", key: taskRoute.data.key, ...body.data }),
      );
      const result = await ctx.runMutation(internal.workGraph.updateTask, {
        ...common,
        revision: body.data.revision,
        ...(body.data.fence === undefined ? {} : { fence: body.data.fence }),
        ...(body.data.title === undefined ? {} : { title: body.data.title }),
        ...(body.data.description === undefined ? {} : { description: body.data.description }),
        ...(body.data.type === undefined ? {} : { type: body.data.type }),
        ...(body.data.priority === undefined ? {} : { priority: body.data.priority }),
        requestDigest,
      });
      return resultResponse(result, taskctlApiOperations.updateTask.responseSchema);
    }
    if (actionMatch?.[2] === "assign") {
      const body = assignTaskRequestSchema.safeParse(rawBody);
      if (!body.success) return errorResponse("VALIDATION_ERROR", requestId);
      const requestDigest = await sha256Base64Url(
        JSON.stringify({ operation: "tasks.assign", key: taskRoute.data.key, ...body.data }),
      );
      const result = await ctx.runMutation(internal.workGraph.assignTask, {
        ...common,
        revision: body.data.revision,
        ...(body.data.fence === undefined ? {} : { fence: body.data.fence }),
        assigneeAgentId: body.data.assigneeAgentId,
        requestDigest,
      });
      return resultResponse(result, taskctlApiOperations.assignTask.responseSchema);
    }
    if (actionMatch?.[2] === "defer") {
      const body = deferTaskRequestSchema.safeParse(rawBody);
      if (!body.success) return errorResponse("VALIDATION_ERROR", requestId);
      const requestDigest = await sha256Base64Url(
        JSON.stringify({ operation: "tasks.defer", key: taskRoute.data.key, ...body.data }),
      );
      const result = await ctx.runMutation(internal.workGraph.deferTask, {
        ...common,
        revision: body.data.revision,
        availableAt: body.data.availableAt,
        ...(body.data.fence === undefined ? {} : { fence: body.data.fence }),
        requestDigest,
      });
      return resultResponse(result, taskctlApiOperations.deferTask.responseSchema);
    }
    if (actionMatch?.[2] === "labels" || actionMatch?.[2] === "labels/remove") {
      const body = taskLabelMutationRequestSchema.safeParse(rawBody);
      if (!body.success) return errorResponse("VALIDATION_ERROR", requestId);
      const remove = actionMatch[2] === "labels/remove";
      const operation = remove ? "tasks.labels.remove" : "tasks.labels.add";
      const requestDigest = await sha256Base64Url(
        JSON.stringify({ operation, key: taskRoute.data.key, ...body.data }),
      );
      const args = {
        ...common,
        revision: body.data.revision,
        label: body.data.label,
        ...(body.data.fence === undefined ? {} : { fence: body.data.fence }),
        requestDigest,
      };
      const result = remove
        ? await ctx.runMutation(internal.workGraph.removeTaskLabel, args)
        : await ctx.runMutation(internal.workGraph.addTaskLabel, args);
      return resultResponse(
        result,
        remove
          ? taskctlApiOperations.removeTaskLabel.responseSchema
          : taskctlApiOperations.addTaskLabel.responseSchema,
      );
    }
    if (actionMatch?.[2] === "comments") {
      const body = addTaskCommentRequestSchema.safeParse(rawBody);
      if (!body.success) return errorResponse("VALIDATION_ERROR", requestId);
      const requestDigest = await sha256Base64Url(
        JSON.stringify({ operation: "tasks.comments.add", key: taskRoute.data.key, ...body.data }),
      );
      const result = await ctx.runMutation(internal.workGraph.addTaskComment, {
        ...common,
        body: body.data.body,
        requestDigest,
      });
      return resultResponse(result, taskctlApiOperations.addTaskComment.responseSchema);
    }
    if (
      actionMatch?.[2] === "dependencies" ||
      actionMatch?.[2] === "dependencies/remove"
    ) {
      const body = taskDependencyMutationRequestSchema.safeParse(rawBody);
      if (!body.success) return errorResponse("VALIDATION_ERROR", requestId);
      const remove = actionMatch[2] === "dependencies/remove";
      const operation = remove ? "tasks.dependencies.remove" : "tasks.dependencies.add";
      const requestDigest = await sha256Base64Url(
        JSON.stringify({ operation, key: taskRoute.data.key, ...body.data }),
      );
      const args = {
        ...common,
        revision: body.data.revision,
        blockerKey: body.data.blockerKey,
        ...(body.data.fence === undefined ? {} : { fence: body.data.fence }),
        requestDigest,
      };
      const result = remove
        ? await ctx.runMutation(internal.workGraph.removeTaskDependency, args)
        : await ctx.runMutation(internal.workGraph.addTaskDependency, args);
      return resultResponse(
        result,
        remove
          ? taskctlApiOperations.removeTaskDependency.responseSchema
          : taskctlApiOperations.addTaskDependency.responseSchema,
      );
    }
    if (actionMatch?.[2] === "parent/set") {
      const body = setTaskParentRequestSchema.safeParse(rawBody);
      if (!body.success) return errorResponse("VALIDATION_ERROR", requestId);
      const requestDigest = await sha256Base64Url(
        JSON.stringify({ operation: "tasks.parent.set", key: taskRoute.data.key, ...body.data }),
      );
      const result = await ctx.runMutation(internal.workGraph.setTaskParent, {
        ...common,
        revision: body.data.revision,
        parentKey: body.data.parentKey,
        ...(body.data.fence === undefined ? {} : { fence: body.data.fence }),
        requestDigest,
      });
      return resultResponse(result, taskctlApiOperations.setTaskParent.responseSchema);
    }
    if (actionMatch?.[2] === "parent/clear") {
      const body = clearTaskParentRequestSchema.safeParse(rawBody);
      if (!body.success) return errorResponse("VALIDATION_ERROR", requestId);
      const requestDigest = await sha256Base64Url(
        JSON.stringify({ operation: "tasks.parent.clear", key: taskRoute.data.key, ...body.data }),
      );
      const result = await ctx.runMutation(internal.workGraph.clearTaskParent, {
        ...common,
        revision: body.data.revision,
        ...(body.data.fence === undefined ? {} : { fence: body.data.fence }),
        requestDigest,
      });
      return resultResponse(result, taskctlApiOperations.clearTaskParent.responseSchema);
    }
    if (actionMatch?.[2] === "references") {
      const body = addTaskReferenceRequestSchema.safeParse(rawBody);
      if (!body.success) return errorResponse("VALIDATION_ERROR", requestId);
      const requestDigest = await sha256Base64Url(
        JSON.stringify({ operation: "tasks.references.add", key: taskRoute.data.key, ...body.data }),
      );
      const reference = body.data.reference.kind === "repository"
        ? body.data.reference
        : body.data.reference.kind === "pull_request"
          ? {
              kind: "pull_request" as const,
              url: body.data.reference.url,
              ...(body.data.reference.repositoryId === undefined
                ? {}
                : { repositoryId: body.data.reference.repositoryId }),
            }
          : body.data.reference.kind === "commit"
            ? {
                kind: "commit" as const,
                sha: body.data.reference.sha,
                ...(body.data.reference.repositoryId === undefined
                  ? {}
                  : { repositoryId: body.data.reference.repositoryId }),
                ...(body.data.reference.url === undefined
                  ? {}
                  : { url: body.data.reference.url }),
              }
            : body.data.reference;
      const result = await ctx.runMutation(internal.workGraph.addTaskReference, {
        ...common,
        revision: body.data.revision,
        reference,
        ...(body.data.fence === undefined ? {} : { fence: body.data.fence }),
        requestDigest,
      });
      return resultResponse(result, taskctlApiOperations.addTaskReference.responseSchema);
    }
    if (referenceRemoveMatch?.[2] !== undefined) {
      let referenceId: string;
      try {
        referenceId = decodeURIComponent(referenceRemoveMatch[2]);
      } catch {
        return errorResponse("VALIDATION_ERROR", requestId);
      }
      const route = taskReferenceRouteParamsSchema.safeParse({
        key: taskRoute.data.key,
        referenceId,
      });
      const body = removeTaskReferenceRequestSchema.safeParse(rawBody);
      if (!route.success || !body.success) return errorResponse("VALIDATION_ERROR", requestId);
      const requestDigest = await sha256Base64Url(
        JSON.stringify({
          operation: "tasks.references.remove",
          key: taskRoute.data.key,
          referenceId: route.data.referenceId,
          ...body.data,
        }),
      );
      const result = await ctx.runMutation(internal.workGraph.removeTaskReference, {
        ...common,
        referencePublicId: route.data.referenceId,
        revision: body.data.revision,
        ...(body.data.fence === undefined ? {} : { fence: body.data.fence }),
        requestDigest,
      });
      return resultResponse(result, taskctlApiOperations.removeTaskReference.responseSchema);
    }
    return errorResponse("NOT_FOUND", requestId);
  } catch {
    return errorResponse("INTERNAL_ERROR", requestId);
  }
}

http.route({
  method: "POST",
  path: hraDispatchRoutes.heartbeat,
  handler: httpAction(async (ctx, request) => {
    const requestId = randomRequestId();
    try {
      if (!hasJsonContentType(request)) return errorResponse("VALIDATION_ERROR", requestId);
      const body = runnerHeartbeatRequestSchema.safeParse(await parseJsonBody(request));
      if (!body.success) return errorResponse("VALIDATION_ERROR", requestId);
      const authenticated = await authenticateDispatchSessionRequest(ctx, request, requestId);
      if (authenticated.kind === "error") return authenticated.response;
      const { blockReason, ...heartbeat } = body.data;
      const result = await ctx.runMutation(internal.dispatch.runnerHeartbeat, {
        credentialId: authenticated.credential.credentialId,
        sessionPublicId: authenticated.sessionPublicId,
        requestId,
        ...heartbeat,
        ...(blockReason === undefined ? {} : { blockReason }),
      });
      return resultResponse(result, runnerHeartbeatEnvelopeSchema);
    } catch {
      return errorResponse("INTERNAL_ERROR", requestId);
    }
  }),
});

http.route({
  method: "POST",
  path: hraDispatchRoutes.claim,
  handler: httpAction(async (ctx, request) => {
    const requestId = randomRequestId();
    try {
      if (!hasJsonContentType(request)) return errorResponse("VALIDATION_ERROR", requestId);
      const body = claimDispatchRequestSchema.safeParse(await parseJsonBody(request));
      if (!body.success) return errorResponse("VALIDATION_ERROR", requestId);
      const authenticated = await authenticateDispatchSessionRequest(ctx, request, requestId);
      if (authenticated.kind === "error") return authenticated.response;
      const result = await ctx.runMutation(internal.dispatch.claimDispatch, {
        credentialId: authenticated.credential.credentialId,
        sessionPublicId: authenticated.sessionPublicId,
        requestId,
        ...body.data,
      });
      return resultResponse(result, claimDispatchEnvelopeSchema);
    } catch {
      return errorResponse("INTERNAL_ERROR", requestId);
    }
  }),
});

http.route({
  method: "POST",
  pathPrefix: "/v1/dispatch/runs/",
  handler: httpAction(async (ctx, request) => {
    const requestId = randomRequestId();
    try {
      const pathname = new URL(request.url).pathname;
      const match = /^\/v1\/dispatch\/runs\/(?<runId>[^/]+)\/(?<action>events|interactions\/sync)$/u.exec(pathname);
      const encodedRunId = match?.groups?.runId;
      const action = match?.groups?.action;
      if (encodedRunId === undefined || action === undefined || !hasJsonContentType(request)) {
        return errorResponse("VALIDATION_ERROR", requestId);
      }
      let runId: string;
      try {
        runId = decodeURIComponent(encodedRunId);
      } catch {
        return errorResponse("VALIDATION_ERROR", requestId);
      }
      if (!dispatchIdSchema.safeParse(runId).success) {
        return errorResponse("VALIDATION_ERROR", requestId);
      }
      const rawBody = await parseJsonBody(
        request,
        action === "interactions/sync"
          ? MAX_SERIALIZED_SYNC_RUN_INTERACTIONS_REQUEST_BYTES
          : MAX_JSON_BODY_BYTES,
      );
      const authenticated = await authenticateDispatchSessionRequest(ctx, request, requestId);
      if (authenticated.kind === "error") return authenticated.response;
      if (action === "events") {
        const body = appendRunEventsRequestSchema.safeParse(rawBody);
        if (!body.success) return errorResponse("VALIDATION_ERROR", requestId);
        const result = await ctx.runMutation(internal.dispatch.appendRunEvents, {
          credentialId: authenticated.credential.credentialId,
          sessionPublicId: authenticated.sessionPublicId,
          requestId,
          runId,
          ...body.data,
        });
        return resultResponse(result, appendRunEventsEnvelopeSchema);
      }
      const body = syncRunInteractionsRequestSchema.safeParse(rawBody);
      if (!body.success) return errorResponse("VALIDATION_ERROR", requestId);
      const result = await ctx.runMutation(internal.dispatchInteractions.syncRunInteractions, {
        credentialId: authenticated.credential.credentialId,
        sessionPublicId: authenticated.sessionPublicId,
        requestId,
        runId,
        ...body.data,
        upserts: body.data.upserts.map(convexInteractionRequest),
        settlements: body.data.settlements.map((settlement) => ({
          interactionId: settlement.interactionId,
          outcome: settlement.outcome,
          ...(settlement.outcome === "expired" ? { reason: settlement.reason } : {}),
          ...(settlement.responseRevision === undefined
            ? {}
            : { responseRevision: settlement.responseRevision }),
        })),
      });
      return resultResponse(result, syncRunInteractionsEnvelopeSchema);
    } catch {
      return errorResponse("INTERNAL_ERROR", requestId);
    }
  }),
});

http.route({
  method: "POST",
  pathPrefix: "/v1/tasks/",
  handler: httpAction(async (ctx, request) => {
    const pathname = new URL(request.url).pathname;
    if (pathname.endsWith("/claim/renew")) return await taskCommand(ctx, request, "renew");
    if (pathname.endsWith("/claim/release")) return await taskCommand(ctx, request, "release");
    if (pathname.endsWith("/claim")) return await taskCommand(ctx, request, "claim");
    return await taskMutationCommand(ctx, request);
  }),
});

// HRA is canonical. The exact OPRTE and already-released Kitchen route
// families remain handler aliases so installed clients cross the rename
// without changing authorization, parsing, or response behavior.
for (const routes of [
  hraHumanApiRoutes,
  legacyOprteHumanApiRoutes,
  legacyKitchenHumanApiRoutes,
] as const) {
  http.route({ method: "GET", path: routes.workspaces, handler: hraHumanHttp });
  http.route({
    method: "GET",
    pathPrefix: `${routes.workspaces}/`,
    handler: hraHumanHttp,
  });
  http.route({
    method: "POST",
    pathPrefix: `${routes.workspaces}/`,
    handler: hraHumanHttp,
  });
}

for (const routes of [
  sessionSyncHttpRoutes,
  legacyOprteSessionSyncHttpRoutes,
] as const) {
  for (const path of Object.values(routes)) {
    http.route({ method: "POST", path, handler: sessionSyncHttp });
  }
}

for (const routes of [
  hraPromotionApiRoutes,
  legacyOprtePromotionApiRoutes,
  legacyKitchenPromotionApiRoutes,
] as const) {
  http.route({ method: "POST", path: routes.start, handler: hraPromotionHttp });
  http.route({
    method: "GET",
    pathPrefix: `${routes.start}/`,
    handler: hraPromotionHttp,
  });
  http.route({
    method: "POST",
    pathPrefix: `${routes.start}/`,
    handler: hraPromotionHttp,
  });
}

export default http;
