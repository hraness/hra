// This module is the only place in `src/` that spells the pinned Claude Code
// version, its Fable model id, and the reviewed stream-json matrix digests.
// Claude Code's stream-json surface is not a published contract, so HRA pins
// one exact release and fails closed on drift instead of tolerating it.
//
// Re-pinning procedure (mirrors `bun run codex:bump`, run by hand because the
// Claude CLI is not an npm dependency of this package):
//   1. `claude --version` inside an isolated `CLAUDE_CONFIG_DIR`.
//   2. Re-capture `docs/providers/claude-fixtures/*.jsonl.txt` on that build.
//   3. Update `CLAUDE_PIN`, `CLAUDE_PIN_MODEL`, and the digests below, then
//      run `bun test src/claude` and re-read `docs/providers/claude.md`.

/** Exact release semver, never a range or prerelease. */
export type ClaudePinVersion = `${number}.${number}.${number}`;

export const CLAUDE_PIN = "2.1.260" satisfies ClaudePinVersion;

/**
 * The exact Fable model id this pinned build accepts. Measured on the pinned
 * build (`docs/providers/claude.md`, "Fable model id and reasoning efforts");
 * the id drifted from `claude-fable-5` at 2.1.238 to `claude-fable-5-1` here,
 * so it is pinned per release like the version itself.
 */
export const CLAUDE_PIN_MODEL = "claude-fable-5-1";

/** The only reasoning effort the `fable-max` preset may request. */
export const CLAUDE_PIN_EFFORT = "max";

/**
 * Reasoning efforts the pinned build's model listing reports for Fable. HRA
 * requests only `max`; the set exists so an unexpected effort is refused
 * rather than silently forwarded. `ultracode` is deliberately never requested
 * (the plan's "max without ultracode").
 */
export const CLAUDE_PIN_SUPPORTED_EFFORTS = Object.freeze([
  "low",
  "medium",
  "high",
  "xhigh",
  "ultracode",
  "max",
] as const);

export const CLAUDE_PIN_REFUSED_EFFORTS = Object.freeze(["ultracode"] as const);

/**
 * SHA-256 of `CLAUDE_PIN`, a newline, then each reviewed matrix entry as
 * `event:disposition` joined by newlines. See `claudeMatrixDigest` in
 * `protocol.ts`.
 */
export const PINNED_CLAUDE_MATRIX_DIGESTS = Object.freeze({
  controlRequest: "c704bbb67dfa5a7e91d2cf1ac32bfdfb159aa3661b7a78ca18d333b51025965f",
  streamEvent: "649d2a4b314f6adada59667a4a7c4edf2c1ad51e77e959c1426ec9ea02a978aa",
} as const);
