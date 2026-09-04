# Contents

- Runtime discovery locates the pinned official Codex package.
- Transport owns one app-server process and bounded JSONL.
- Protocol schemas and operation descriptors form the only app-server boundary.
- Projection converts provider facts into HRA session and usage data.
- Automations is a read-only, tolerant reader for Codex Desktop's on-disk scheduled tasks.

# Guidelines

- Pin one exact Codex version. Regenerate fixtures and re-run compatibility acceptance before changing it.
- Keep the raw JSON-RPC call private. Every used operation declares effect, deadline, serialization, lost-response, and reconciliation policy.
- Initialize exactly once per process. Fence every request and event with profile and process generation.
- Never parse provider transcript files or credential files directly.
- Treat under-development app-server methods as pin-scoped. Fail closed when the exact compatibility probe does not pass.
