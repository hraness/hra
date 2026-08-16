# Contents

- `actor-domain.ts`, `domain.ts`, `rlm-v2.ts`, and `completed-prefix-container-v2.ts` – parsed provider-neutral actor, budget, lexical-program, and indexed completed-prefix/current-input contracts plus pure laws.
- `sqlite-authority-v2.ts`, `persistent-actors.ts`, and the root-session authorities – durable content-free actor admission, receipts, root bindings, reconciliation, and lifecycle ownership.
- `context-value-store.ts`, `context-value-ports-v2.ts`, `context-value-sqlite-adapter-v2.ts`, `object-store.ts`, `key-custody.ts`, and `storage-layout.ts` – encrypted indexed Application Support Context Heap storage, key custody, quotas, and recovery.
- `actor-workspace-runtime-v2.ts`, `codex-persistent-actor-provider.ts`, and `persistent-actor-liveness-v2.ts` – managed actor worktrees, start-only Codex incarnations, idle follow-up turns, and terminal reconciliation.
- `rlm-runtime-v2.ts`, `rlm-operation-router-v2.ts`, `context-operation-service-v2.ts`, and the dynamic-tool v2 modules – bounded lexical execution and the authenticated callback path into context, actor, and proposal operations.
- `renderer-*-v2.ts`, `proposal-*-v2.ts`, `production-lifecycle-kernel-v2.ts`, and `production-composition-v2.ts` – renderer commands, immutable Suggest proposals, fail-closed startup and shutdown, and the private production composition boundary.
- `optimizer-domain-v1.ts` and `optimizer-evidence-v1.ts` – pure research-only frozen-benchmark schemas, keyed block-balanced assignments, exact finite measures, feasibility gates, and advisory state laws with no persistence or runtime authority.

# Guidelines

- Keep Codex as the only model and transcript runtime. This boundary may coordinate closed operations but must not generate model actions, duplicate complete transcripts, or expose raw provider RPC.
- Parse every command, stored row, program node, context value, and provider result from `unknown`; use opaque HRA identities outside the pinned Codex adapter.
- Keep the content-free evidence ledger separate from the encrypted Context Heap. Never place prompts, responses, reasoning, commands, tool payloads, credentials, provider IDs, account identity, or absolute paths in ledger rows, renderer projections, diagnostics, or reports.
- Admit recursive work before starting provider effects. Persist prepared, effect-started, and terminal receipts; fence every operation by root session, caller thread, turn, generation, and idempotency key; never replay an ambiguous mutation automatically.
- Make recursive authority decrease. Children cannot widen depth, active or durable descendant counts, token, time, byte, account, repository, or workspace-lane authority.
- Resolve transcript context only through adopted pinned app-server operations. Never inspect private Codex files or `CODEX_HOME` directly.
- Bind every context reference to its provider-visible completed prefix and current input. Store retained bytes only as encrypted indexed chunks below Application Support.
- Create every actor incarnation through pinned `thread/start`, never `thread/fork`. Send an idle child a follow-up only through a pinned new `turn/start`, never `turn/steer`.
- Keep `status`, `waitAny`, `waitAll`, `result`, and `cancel` receipt-backed and reconcilable. The desktop child controls remain Open and Stop.
- Keep wait operations lease-free and cancellable. A barrier cannot hold CPU, repository, worktree, or provider admission while it waits.
- Keep goals, heartbeats, evaluation, trials, canary, activation, rollback, proposal data preview/delete, provider/public, Git push, evaluator mutation, base instructions, security policy, and automatic tracked-file promotion outside the recursive harness capabilities.
- Keep the Phase 0 optimizer pure and research-only. A complete finite gate may emit an advisory `recommendCanary`, but it grants no rollout, policy, provider, persistence, renderer, or recursive-tool authority.
- Add colocated examples and property tests for parser totality, transition closure, budget monotonicity, idempotency, ordering, restart reconciliation, quota atomicity, encryption, and exact deletion.
