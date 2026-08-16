# Contents

- `identifiers.ts` – stable public task, workspace, repository, operation, receipt, event, run, and interaction identifiers.
- `task.ts` – portable task literals, actors, references, evidence, projections, and typed task events.
- `graph-laws.ts` – bounded graph, blocker, readiness, cancellation, review, and submission laws.
- `dispatch.ts` – portable run phases, semantic events, display contracts, and transition/replay laws.
- `interaction-laws.ts` – bounded interaction admission, delivery, projection, page, and settlement laws.
- `interactions.ts` – provider-neutral interaction requests, strict answers, responses, and local settlements.
- `client.ts` – closed product-level navigation plus durable-vocabulary-derived mutation intents for the shared headless task client.
- `operations.ts` – backend-neutral human mutation intents, trusted local-owner materialization, system commands, exhaustive result/event maps, exact replay receipts, and typed workspace event records.
- `promotion.ts` – legacy frozen snapshots plus compact v2 promotion headers, cumulative family digests, batch receipts, decision proofs, progress, and recovery states.
- `projections.ts` – bounded workspace selection, atomic task projection bundles, list/detail leaves, run summaries, cursors, and invalidation contracts.
- `model.ts` – compatibility barrel for the portable task model and public identifiers.
- `index.ts` – the leaf domain package public surface.
- `*.test.ts` and `*.property.test.ts` – strict parser examples, law properties, and dependency-boundary regressions.

# Guidelines

- Keep every exported schema strict and every lifecycle closed; model conflicting authority, receipt, promotion, and terminal states as distinct union members.
- Public IDs are opaque application identifiers. Provider document IDs and local paths never become portable foreign keys.
- Pure laws accept values, maps, and bounded collections. They never read time, storage, network, provider, process, or filesystem state implicitly.
- Keep imported local runs immutable and terminal: they cannot carry live claims, leases, interactions, retry authority, or resumable execution state.
- Give every promoted entity a stable public identifier or a deterministic length-framed relation key derived from its exact directed tuple.
- Keep cloud organization locators, UUID request correlation, and transport event envelopes in `@hraness/agent-tasks-protocol`; the leaf event log is workspace-local and operation-correlated.
