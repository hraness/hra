# Contents

- `cli.ts` – machine-readable Phase 1 real-Codex probe entrypoint.
- `scenarios.ts` – isolated initialize, fork, promotion, request-replay, and explicitly candidate-gated dynamic-tool scenarios.
- `app-server-client.ts` – strict JSONL stdio process harness used only by feasibility probes.
- `jsonl.ts` – streaming UTF-8 JSONL decoding and JSON-RPC envelope validation.
- `discovery.ts` – exact Codex version and development-binary resolution.
- `fixtures/` – deterministic child process used by probe-harness tests.

# Guidelines

- Require an exact expected Codex version and record the discovered path, source, and reported version in evidence.
- Keep credentialed or model-consuming probes opt-in and return an explicit skipped result when their prerequisites are absent.
- Never invoke a shell, inherit secrets indiscriminately, or write outside an isolated probe directory unless the caller explicitly supplies a test `CODEX_HOME`.
- Emit one JSON evidence document on stdout; keep bounded child diagnostics on stderr and redact likely credentials.
