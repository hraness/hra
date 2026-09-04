// Written by `bun run codex:bump <version>`. Do not edit by hand.
//
// This module is the only place in `src/` that spells the pinned Codex
// version. Every other site imports `CODEX_PIN`, and the reviewed digests
// below are regenerated from the installed `@openai/codex` executable.

/** Exact release semver, never a range or prerelease. */
export type CodexPinVersion = `${number}.${number}.${number}`;

export const CODEX_PIN = "0.149.0" satisfies CodexPinVersion;

/**
 * SHA-256 of files produced by the pinned executable's
 * `app-server generate-ts --experimental`, keyed by output path.
 */
export const PINNED_CODEX_SCHEMA_DIGESTS = Object.freeze({
  "ServerNotification.ts": "e00fcc3b3c376e808a5feefaa233fdd49ea50acfa15cb629eb40fcf27b706777",
  "ServerRequest.ts": "1c5837adbfbdd005f387478ba87840808d1353b47b82dcf63739a78bb1c8d3be",
  "ClientRequest.ts": "40dcb766794599f1a91c03c945ee21450c676faed7b5c7eae8152d3c10c5c585",
  "v2/ConsumeAccountRateLimitResetCreditParams.ts": "f5f79c58b90a126b7620b38bc88d09a3b096543f71cdd949d19bac3c2b03399d",
  "v2/ConsumeAccountRateLimitResetCreditResponse.ts": "3240fe476768362847266693ffdfb4fdd8d8f0d7b628962255b229a182d76682",
  "v2/ConsumeAccountRateLimitResetCreditOutcome.ts": "2fc33514e9745ffeeefada2c51362dc66e6f9c5f6f76d28b0a9a8cf278a2e8fe",
  "v2/ThreadStartParams.ts": "7a3fddbb0cf0585c52edbf19e3a1f6e691681f18ab509f7abfa416da7f0ac824",
  "v2/ThreadResumeParams.ts": "1a362bca07173360957cc787c916e5492c179062878d514d2dd0c4097fa79f44",
  "v2/DynamicToolCallParams.ts": "6524a162207514c3a50a1e65f9abed9c59d97f38fb9cf221f740340ef5c5051f",
  "v2/DynamicToolCallResponse.ts": "df53cf5e967d26aa59615db06f4179a7b2330f44df4298a8393eaf9f48f7e115",
  "v2/DynamicToolSpec.ts": "bd4b06afea9395a426f8facc9d800f4b201fea44fab667f854710acff4c8f393",
  "v2/DynamicToolNamespaceSpec.ts": "3c03822c5ea8753aec5bb90b2599832869f92aac6f039bc2ba421c57fb4b6c75",
  "v2/DynamicToolNamespaceTool.ts": "bcaf5742948e4fc08a283b185ef7d5819e054f23bb6ccfbfc42a37593b6bf284",
  "v2/DynamicToolFunctionSpec.ts": "41586221845d8de57d4c6cc91d83f3e004c905648ba62754f5876e331a81d9a8",
  "v2/DynamicToolCallOutputContentItem.ts": "9eebff80cb251a368d772ff75313de20d23dfef0ed6dc7f61630da9040b7e425",
} as const);

/**
 * SHA-256 of `CODEX_PIN`, a newline, then each reviewed matrix entry as
 * `method:disposition` joined by newlines. See `codexMatrixDigest` in
 * `protocol.ts`.
 */
export const PINNED_CODEX_MATRIX_DIGESTS = Object.freeze({
  serverRequest: "18ca3808834fec7ed6a60ed57469b694446a02c18cee39029d63d138fea0f61f",
  notification: "2fa021b1b21db701118f3b0cb34047aca8c0632a084a62ca1efce45fbaca3047",
} as const);
