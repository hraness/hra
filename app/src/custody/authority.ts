/**
 * Authority failure detection.
 *
 * `convex/authority.ts` funnels every refusal through one static message, so a
 * revoked device, an expired auth session, a rotated auth epoch, and a device
 * that is not bound to this session all arrive as the same string. The tab
 * treats any of them as a custody event: the account key is wiped immediately
 * rather than retried, because a browser that has lost its device authority
 * must not keep decrypting the projection.
 */
export const authorizationRejectedFragments = [
  // `convex/authority.ts:rejectAuthority`
  "Cloud authority is not current",
  // Convex Auth refuses an unauthenticated or expired call before the handler.
  "Not authenticated",
  "Unauthenticated",
  "InvalidAccessToken",
] as const;

export function isAuthorityError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return authorizationRejectedFragments.some((fragment) => message.includes(fragment));
}

/** Overwrites key material in place before the reference is dropped. */
export function wipeBytes(bytes: Uint8Array | null | undefined): void {
  if (bytes === undefined || bytes === null) return;
  bytes.fill(0);
}
