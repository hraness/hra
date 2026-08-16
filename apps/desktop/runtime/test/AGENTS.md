# Contents

- Deterministic multi-account app-server behavior, session continuation, cloud-dispatch transport, local dispatch durability, promotion faults, protocol fixtures, gateway integration, generation recovery, local-data removal laws, and native feasibility probes.
- `fixtures/effective-user-home-preload.ts` – process-test-only effective-home override that preserves canonical path semantics.
- `fixtures/in-memory-secrets-preload.ts` – process-test-only secret custody with exact seeded values, deletion-failure injection, and value-free traces.
- `probes/` – standalone JSONL and app-server probes used by the pinned-runtime test boundary.

# Guidelines

- Keep fake-server scenarios deterministic and runnable without network access or user credentials.
- Cover arbitrary JSONL chunking, delayed output, server requests, malformed messages, unexpected exit, and restart reconciliation.
- Prove account isolation with distinct homes and generations, sparse usage updates, bounded projections, login recovery, retained-data tombstones, and transport-sized invalidation recovery.
- Verify launch, resume, bounded history injection, continuation, and streaming projections at the exact app-server seam.
- Exercise runner replay, lease and fence rejection, stop ambiguity, durable outbox replay, worktree containment, capacity, and completion without a live deployment.
- Prove the renderer parser rejects path-bearing project registration, provider thread and turn commands, queueing, steering, and interaction settlement.
- Property-test revision admission, cross-pane commutativity, Unicode bounds, model validation, quota proof, exactly-once continuation, fail-closed recovery, and prompt absence from durable envelopes.
- Keep real Codex and macOS probes explicit. Portable checks must run without native toolchains or signed-in accounts.
- Promote every shrunk property-test failure into a named regression.
