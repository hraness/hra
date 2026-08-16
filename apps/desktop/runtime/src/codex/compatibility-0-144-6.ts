export type Codex01446RemoteErrorKind = "authentication_invalid" | "other";

export const CODEX_0_144_6_REMOTE_ERROR_MAX_MESSAGE_LENGTH = 16_384;

/**
 * Codex 0.144.6 emits partial rate-limit snapshots even though its generated
 * notification type marks every snapshot field as required. The pinned
 * decoder accepts only these known fields and still validates every field
 * that is present.
 */
export const CODEX_0_144_6_ACCEPTS_SPARSE_RATE_LIMIT_UPDATES = true;

/**
 * Codex 0.144.6 reports an invalidated ChatGPT session through a generic
 * JSON-RPC internal-error envelope. This deliberately narrow compatibility
 * rule converts only the observed legacy signature into owned semantics.
 * Provider text is inspected here and is never retained on the public error.
 */
export function classifyCodex01446RemoteError(
  error: Readonly<Record<string, unknown>>,
): Codex01446RemoteErrorKind {
  const message = error.message;
  if (
    error.code !== -32_603 ||
    typeof message !== "string" ||
    message.length > CODEX_0_144_6_REMOTE_ERROR_MAX_MESSAGE_LENGTH
  ) {
    return "other";
  }
  return /\b401 Unauthorized\b/.test(message) && /\btoken_invalidated\b/.test(message)
    ? "authentication_invalid"
    : "other";
}
