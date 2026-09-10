# Contents

- Runtime discovery locates the pinned official Codex package.
- Transport owns one app-server process and bounded JSONL.
- `session-program.ts` owns typed Effect session programs; `session-effects.ts` is the sole native callback and runtime boundary for each connection.
- Protocol schemas and operation descriptors form the only app-server boundary.
- Projection converts provider facts into Oompa session and usage data.
- Automations is a read-only, tolerant reader for Codex Desktop's on-disk scheduled tasks.

# Guidelines

- Pin one exact Codex version. Regenerate fixtures and re-run compatibility acceptance before changing it.
- Keep the raw JSON-RPC call private. Every used operation declares effect, deadline, serialization, lost-response, and reconciliation policy.
- Initialize exactly once per process. Fence every request and event with profile and process generation.
- Never parse provider transcript files or credential files directly.
- Treat under-development app-server methods as pin-scoped. Fail closed when the exact compatibility probe does not pass.

- Keep the session program free of ambient I/O and runtime execution. The reviewed architecture policy in `scripts/check-codex-effect-architecture.ts` names the adapter and runtime root. Preserve expected errors through the Promise facade and never equate fiber interruption with native process termination.
