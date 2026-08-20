import {
  legacyOprteSessionSyncHttpRoutes,
  MAX_SESSION_SYNC_HTTP_BODY_BYTES,
  sessionSyncBackendResultSchema,
  sessionSyncHttpRoutes,
  sessionSyncHumanInvocationSchema,
  sessionSyncInvocationSchema,
  sessionSyncNegotiationInvocationSchema,
  sessionSyncNegotiationSchema,
  type SessionSyncBackendErrorCode,
  type SessionSyncBackendResult,
} from "@hraness/agent-tasks-protocol";

import { httpAction, type ActionCtx } from "./_generated/server";
import { parseBoundedJsonBody } from "./boundedJsonBody";
import {
  authorizeSessionSyncNegotiation,
  bootstrapSessionSyncVault,
  claimSessionSyncEnrollment,
  clearOrphanedScheduledChatAsHuman,
  executeSessionSyncRequest,
  negotiateSessionSync,
  recoverSessionSyncVault,
  readSessionSyncRecoveryContext,
  readScheduledChatRecoveryInventoryAsHuman,
  submitSessionSyncEnrollment,
} from "./sessionSync";

const JSON_HEADERS = {
  "Cache-Control": "no-store",
  "Content-Type": "application/json; charset=utf-8",
  "X-Content-Type-Options": "nosniff",
} as const;

type SessionSyncHttpOperation = keyof typeof sessionSyncHttpRoutes;

const sessionSyncOperationByPath = new Map<string, SessionSyncHttpOperation>();
for (const routes of [
  sessionSyncHttpRoutes,
  legacyOprteSessionSyncHttpRoutes,
] as const) {
  for (const [operation, path] of Object.entries(routes) as ReadonlyArray<
    readonly [SessionSyncHttpOperation, string]
  >) {
    sessionSyncOperationByPath.set(path, operation);
  }
}

export function sessionSyncHttpOperation(
  pathname: string,
): SessionSyncHttpOperation | null {
  return sessionSyncOperationByPath.get(pathname) ?? null;
}

function hasJsonContentType(request: Request): boolean {
  const value = request.headers.get("content-type");
  if (value === null) return false;
  return value.split(";", 1)[0]?.trim().toLowerCase() === "application/json";
}

function hasBearerCredential(request: Request): boolean {
  const value = request.headers.get("authorization");
  return value !== null
    && value.startsWith("Bearer ")
    && value.length > 7
    && !value.slice(7).includes(" ");
}

export function sessionSyncHttpStatus(result: SessionSyncBackendResult): number {
  if (result.ok) return 200;
  const code: SessionSyncBackendErrorCode = result.code;
  switch (code) {
    case "AUTHENTICATION_FAILED": return 401;
    case "AUTHORIZATION_DENIED": return 403;
    case "INVALID_REQUEST":
    case "FORBIDDEN_CONTENT": return 400;
    case "NOT_FOUND": return 404;
    case "RETIRED": return 410;
    case "DIRECTORY_LIMIT":
    case "DEVICE_LIMIT":
    case "EVENT_LIMIT":
    case "QUOTA_EXCEEDED": return 429;
    case "RATE_LIMITED": return 429;
    case "SERVICE_UNAVAILABLE": return 503;
    case "CONFLICT":
    case "GRANT_EXPIRED":
    case "KEY_EPOCH_LIMIT":
    case "MAINTENANCE_REQUIRED":
    case "PROOF_EXPIRED":
    case "PROOF_INVALID":
    case "PROOF_REPLAYED":
    case "SEQUENCE_GAP":
    case "SNAPSHOT_EXPIRED":
    case "STALE_BOOT":
    case "STALE_MEMBERSHIP":
    case "STALE_MIRROR":
    case "STALE_REVISION":
    case "STALE_WRITER":
    case "UPDATE_REQUIRED": return 409;
  }
}

export function sessionSyncResultResponse(result: SessionSyncBackendResult): Response {
  const parsed = sessionSyncBackendResultSchema.parse(result);
  return new Response(JSON.stringify(parsed), {
    status: sessionSyncHttpStatus(parsed),
    headers: {
      ...JSON_HEADERS,
      ...(parsed.ok
        ? {}
        : parsed.code === "RATE_LIMITED"
          ? { "Retry-After": Math.ceil(parsed.retryAfterMs / 1_000).toString() }
          : parsed.code === "SERVICE_UNAVAILABLE"
            ? { "Retry-After": "1" }
            : {}),
    },
  });
}

function invalidRequestResponse(): Response {
  return sessionSyncResultResponse({ ok: false, code: "INVALID_REQUEST" });
}

export const sessionSyncHttp = httpAction(async (ctx: ActionCtx, request: Request) => {
  if (!hasBearerCredential(request)) {
    return sessionSyncResultResponse({ ok: false, code: "AUTHENTICATION_FAILED" });
  }
  const pathname = new URL(request.url).pathname;
  const operation = sessionSyncHttpOperation(pathname);
  if (operation === null) return invalidRequestResponse();
  if (operation === "negotiate") {
    const authorized = await authorizeSessionSyncNegotiation(ctx);
    if (!authorized.ok) return sessionSyncResultResponse(authorized);
  }
  if (!hasJsonContentType(request)) return invalidRequestResponse();
  let body: unknown;
  try {
    body = await parseBoundedJsonBody(request, MAX_SESSION_SYNC_HTTP_BODY_BYTES);
  } catch {
    return invalidRequestResponse();
  }
  if (operation === "negotiate") {
    const invocation = sessionSyncNegotiationInvocationSchema.safeParse(body);
    if (!invocation.success) return invalidRequestResponse();
    const negotiation = sessionSyncNegotiationSchema.parse(
      negotiateSessionSync(invocation.data.helloJson),
    );
    return new Response(JSON.stringify(negotiation), { status: 200, headers: JSON_HEADERS });
  }
  if (
    operation === "enrollmentSubmit"
    || operation === "enrollmentClaim"
    || operation === "recoveryContext"
    || operation === "recover"
    || operation === "orphanInventory"
    || operation === "orphanClear"
  ) {
    const invocation = sessionSyncHumanInvocationSchema.safeParse(body);
    if (!invocation.success) return invalidRequestResponse();
    if (operation === "enrollmentSubmit") {
      return sessionSyncResultResponse(await submitSessionSyncEnrollment(ctx, invocation.data));
    }
    if (operation === "enrollmentClaim") {
      return sessionSyncResultResponse(await claimSessionSyncEnrollment(ctx, invocation.data));
    }
    if (operation === "recoveryContext") {
      return sessionSyncResultResponse(await readSessionSyncRecoveryContext(ctx, invocation.data));
    }
    if (operation === "orphanClear") {
      return sessionSyncResultResponse(
        await clearOrphanedScheduledChatAsHuman(ctx, invocation.data),
      );
    }
    if (operation === "orphanInventory") {
      return sessionSyncResultResponse(
        await readScheduledChatRecoveryInventoryAsHuman(ctx, invocation.data),
      );
    }
    return sessionSyncResultResponse(await recoverSessionSyncVault(ctx, invocation.data));
  }
  const invocation = sessionSyncInvocationSchema.safeParse(body);
  if (!invocation.success) return invalidRequestResponse();
  if (operation === "bootstrap") {
    return sessionSyncResultResponse(await bootstrapSessionSyncVault(ctx, invocation.data));
  }
  if (operation === "execute") {
    return sessionSyncResultResponse(await executeSessionSyncRequest(ctx, invocation.data));
  }
  return invalidRequestResponse();
});
