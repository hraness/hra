/**
 * One canonical operation must fit one client-encrypted hosted row. AES-GCM
 * plus Oh's fixed sync-envelope overhead and a 16-byte authentication tag
 * still fit below HRA's existing 350k-character cloud-envelope ceiling.
 */
export const HRA_CANONICAL_MEMORY_OPERATION_MAX_BYTES = 240 * 1024;

// Oh's sync envelope has a fixed 4 KiB allowance around its canonical
// operation. Keep that overhead inside the one hosted ciphertext row instead
// of quietly reducing the operation ceiling at the transport boundary.
export const HRA_CANONICAL_MEMORY_SYNC_BUNDLE_MAX_BYTES =
  HRA_CANONICAL_MEMORY_OPERATION_MAX_BYTES + 4 * 1024;

export const CANONICAL_MEMORY_DESCRIPTOR_PURPOSE =
  "hra.canonical-memory.encrypted-descriptor.v1";
export const CANONICAL_MEMORY_SPACE_KEY_WRAP_PURPOSE =
  "hra.canonical-memory.space-key-wrap.v1";
export const CANONICAL_MEMORY_TERMINAL_HEAD_PROOF_PURPOSE =
  "hra.canonical-memory.terminal-head-proof.v1";
export const CANONICAL_MEMORY_OPERATION_BUNDLE_PURPOSE =
  "hra.canonical-memory.operation-bundle.v1";
export const CANONICAL_MEMORY_ADOPTION_PROOF_PURPOSE =
  "hra.canonical-memory.adoption-proof.v1";
// hmacSha256Hex supplies the outer HRA domain separator and accepts this
// deliberately narrower purpose alphabet.
export const CANONICAL_MEMORY_GENESIS_TOKEN_PURPOSE =
  "canonical-memory-genesis-token";
export const CANONICAL_MEMORY_HEAD_TOKEN_PURPOSE =
  "canonical-memory-head-token";
export const CANONICAL_MEMORY_HOSTED_ROUTE_PURPOSE =
  "canonical-memory-hosted-route";

const canonicalMemoryHostedSpaceIdPattern = /^memory_[A-Za-z0-9_-]{32}$/u;

/** Parse the only public identifier shape accepted by hosted memory routes. */
export function parseCanonicalMemoryHostedSpaceId(value: unknown): string | null {
  return typeof value === "string" && canonicalMemoryHostedSpaceIdPattern.test(value)
    ? value
    : null;
}

export const canonicalMemoryCiphertextLimits = Object.freeze({
  adoptionProof: 8 * 1024,
  operation: Math.floor(
    (4 * (HRA_CANONICAL_MEMORY_SYNC_BUNDLE_MAX_BYTES + 16) + 2) / 3,
  ),
  terminalHeadProof: 16_384,
} as const);

export const canonicalMemoryPlaintextLimits = Object.freeze({
  adoptionProof: 4 * 1024,
  descriptor: 1_024,
  operationBundle: HRA_CANONICAL_MEMORY_SYNC_BUNDLE_MAX_BYTES,
  terminalHeadProof: 2_048,
} as const);
