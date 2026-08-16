# Contents

- `src/` – versioned wire schemas, domain compatibility re-exports, cloud-only identity and dispatch envelopes, encrypted multi-device session-summary synchronization, errors, and redaction helpers.
- `package.json` – source-first `@hraness/agent-tasks-protocol` export and focused checks.
- `tsconfig.json` – strict product-private package configuration.

# Guidelines

- Export only HRA task contracts consumed by both the web backend and CLI.
- Parse wire values through `@hra-internal/schema`; internal callers consume inferred discriminated types.
- Keep scope strings, error codes, task states, actor kinds, and envelope versions closed and exhaustively handled.
- Do not export Convex document IDs as trusted values or import generated Convex server types.
- Depend on `@hraness/agent-tasks-domain` for portable task models, public identifiers, run events, and laws. Re-export the exact domain schema objects so existing protocol consumers remain source-compatible.
- Keep HTTP routes and envelopes, credential/token contracts, WorkOS identity, runner election and leases, and interaction cryptography in protocol or provider adapters rather than the leaf domain.
- Keep session sync observation-only: the relay may receive strict encrypted summary envelopes and authenticated routing metadata, never prompts, responses, reasoning, tool details, transcripts, provider data, commands, or local paths.
- Bind membership, recovery, root-wrap, boot, writer, nonce, snapshot, reset, and retirement transitions to their complete tenant/vault/device/session coordinates. Keep all quotas and lifetime limits explicit in the shared protocol.
