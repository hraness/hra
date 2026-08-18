# Contents

- `actor-domain.ts`, `domain.ts`, `rlm-v2.ts`, and `completed-prefix-container-v2.ts` – parsed provider-neutral actor, budget, lexical-program, and indexed completed-prefix/current-input contracts plus pure laws.
- `sqlite-authority-v2.ts`, `persistent-actors.ts`, and the root-session authorities – durable content-free actor admission, receipts, root bindings, reconciliation, and lifecycle ownership.
- `context-value-store.ts`, `context-value-ports-v2.ts`, `context-value-sqlite-adapter-v2.ts`, `object-store.ts`, `key-custody.ts`, and `storage-layout.ts` – encrypted indexed Application Support Context Heap storage, key custody, quotas, and recovery.
- `actor-workspace-runtime-v2.ts`, `codex-persistent-actor-provider.ts`, and `persistent-actor-liveness-v2.ts` – managed actor worktrees, start-only Codex incarnations, idle follow-up turns, and terminal reconciliation.
- `rlm-runtime-v2.ts`, `rlm-operation-router-v2.ts`, `context-operation-service-v2.ts`, and the dynamic-tool v2 modules – bounded lexical execution and the authenticated callback path into context, actor, and proposal operations.
- `renderer-*-v2.ts`, `proposal-*-v2.ts`, `production-lifecycle-kernel-v2.ts`, and `production-composition-v2.ts` – renderer commands, immutable Suggest proposals, fail-closed startup and shutdown, and the private production composition boundary.
- `optimizer-domain-v1.ts` and `optimizer-evidence-v1.ts` – pure research-only frozen-benchmark schemas, keyed block-balanced assignments, exact finite measures, feasibility gates, and advisory state laws with no persistence or runtime authority.
- `longitudinal-routing-v1.ts`, `longitudinal-routing-sqlite-v1.ts`, and `longitudinal-routing-shadow-analyzer-v1.ts` – bounded content-free cross-epoch recursive-routing summaries, indexed pane memory, and the lifecycle-owned non-activating idle materializer.
- `actor-instruction-policy-schema-v1.ts`, `actor-instruction-policy-v1.json`, and `actor-instruction-policy-v1.ts` – JSON-free bounded policy schema, pure policy data, and its cold renderer, applied only when a fresh persistent actor thread starts. Only the JSON data is development-malleable.

# Guidelines

- Keep Codex as the only model and transcript runtime. This boundary may coordinate closed operations but must not generate model actions, duplicate complete transcripts, or expose raw provider RPC.
- Parse every command, stored row, program node, context value, and provider result from `unknown`; use opaque HRA identities outside the pinned Codex adapter.
- Keep the content-free evidence ledger separate from the encrypted Context Heap. Never place prompts, responses, reasoning, commands, tool payloads, credentials, provider IDs, account identity, or absolute paths in ledger rows, renderer projections, diagnostics, or reports.
- Admit recursive work before starting provider effects. Persist prepared, effect-started, and terminal receipts; fence every operation by root session, caller thread, turn, generation, and idempotency key; never replay an ambiguous mutation automatically.
- Make recursive authority decrease. Children cannot widen depth, active or durable descendant counts, token, time, byte, account, repository, or workspace-lane authority.
- Resolve transcript context only through adopted pinned app-server operations. Never inspect private Codex files or `CODEX_HOME` directly.
- Bind every context reference to its provider-visible completed prefix and current input. Store retained bytes only as encrypted indexed chunks below Application Support.
- Create every actor incarnation through pinned `thread/start`, never `thread/fork`. Send an idle child a follow-up only through a pinned new `turn/start`, never `turn/steer`.
- Select one authorized subscription before an actor provider effect starts. A definitive usage-limit rejection terminalizes that logical turn; never capture or reconstruct its history, create a replacement incarnation, select another subscription, or replay it. The first durable `quotaRejected` attempt revokes its RLM caller immediately, even before the turn row advances. Recover legacy quota-rejected attempts and any later replacement lineage using durable local containment before account selection, incarnation launch, session readiness, or provider reconciliation.
- Keep `status`, `waitAny`, `waitAll`, `result`, and `cancel` receipt-backed and reconcilable. The desktop child controls remain Open and Stop.
- Keep wait operations lease-free and cancellable. A barrier cannot hold CPU, repository, worktree, or provider admission while it waits.
- Keep goals, heartbeats, evaluation, trials, canary, activation, rollback, proposal data preview/delete, provider/public, Git push, evaluator mutation, base instructions, security policy, and automatic tracked-file promotion outside the recursive harness capabilities.
- Keep the Phase 0 optimizer pure and research-only. A complete finite gate may emit an advisory `recommendCanary`, but it grants no rollout, policy, provider, persistence, renderer, or recursive-tool authority.
- Keep longitudinal routing content-free, pane-scoped, and non-activating. Its model-visible projection must state that v1 covers recursive actor outcomes only and excludes ordinary root-turn spend; `requestedProfile` is intent, not observed provider compliance. Operational completion is not quality. Missing root-turn, token, elapsed, or quality evidence must remain explicit, and an idle analysis receipt must never authorize a model, effort, tier, work class, account, provider, proposal, or policy change.
- Keep the actor instruction policy pure and fresh-thread-only. It may shape future actor instructions, but it must not parse stored rows, participate in boot recovery, own effects, or derive durable identity.
- Add colocated examples and property tests for parser totality, transition closure, budget monotonicity, idempotency, ordering, restart reconciliation, quota atomicity, encryption, and exact deletion.
