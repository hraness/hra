import { httpAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { readBoundedUtf8Bytes } from "./boundedJsonBody";
import { sha256Base64Url } from "./crypto";
import { normalizeWorkOSWebhookEvent } from "./identitySync";
import { constructWorkOSWebhookEvent } from "./workos";

const JSON_HEADERS = {
  "Cache-Control": "no-store",
  "Content-Type": "application/json; charset=utf-8",
  "X-Content-Type-Options": "nosniff",
} as const;
const MAX_WEBHOOK_BODY_BYTES = 256 * 1_024;

function response(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

export async function readWorkOSWebhookPayload(
  request: Request,
): Promise<Uint8Array | null> {
  const payload = await readBoundedUtf8Bytes(
    request,
    MAX_WEBHOOK_BODY_BYTES,
  );
  return payload === null || payload.byteLength === 0 ? null : payload;
}

export const workOSWebhook = httpAction(async (ctx, request) => {
  const contentType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/json") return response(415, { ok: false });
  const signature = request.headers.get("workos-signature");
  if (signature === null || signature.length === 0 || signature.length > 1_024) {
    return response(400, { ok: false });
  }
  const payload = await readWorkOSWebhookPayload(request);
  if (payload === null) {
    return response(413, { ok: false });
  }

  let event;
  try {
    // WorkOS verifies this exact UTF-8 byte sequence before it parses JSON.
    event = await constructWorkOSWebhookEvent(payload, signature);
  } catch {
    return response(400, { ok: false });
  }
  if (event === null) return response(503, { ok: false });
  const normalized = normalizeWorkOSWebhookEvent(event);
  if (normalized === null) return response(400, { ok: false });
  const payloadDigest = await sha256Base64Url(payload);
  const result = await ctx.runMutation(internal.identitySync.applyWorkOSWebhook, {
    ...normalized,
    payloadDigest,
  });
  if (result.status === "conflict") {
    return response(409, { ok: false, eventId: normalized.providerEventId });
  }
  return response(200, {
    ok: true,
    eventId: normalized.providerEventId,
    status: result.status,
  });
});
