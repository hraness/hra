# Contents

- `runtime.ts` – renderer-safe account lifecycle plus bounded chat-pane and portable atomic-workspace commands, projections, scoped invalidations, immutable response transfers, snapshots, identifiers, revisions, and error envelopes owned by HRA.
- `runtime-projection.ts` – shared pure runtime projection transitions plus checked Native sequence and snapshot revision advancement.
- `runtime-delivery.ts` – exhaustive delivery-class metadata for snapshot-recoverable and transient-exact renderer events.
- `runtime*.test.ts` and `runtime*.property.test.ts` – strict contract examples, transition laws, command/result correlation, transport byte limits, and generated rejection of gateway-private renderer state.
- `generated/` – versioned app-server schemas plus a portable tree manifest generated from the exactly pinned Codex binary and kept behind the gateway adapter.

# Guidelines

- Keep generated Codex types out of renderer imports; only HRA-owned contracts may cross the native bridge.
- Expose only stable public workspace/task/repository identifiers, path-free repository readiness, bounded portable task data, and the HRA-owned chat-pane facade. Chat schemas may contain app-owned pane/turn/tool identifiers, a fixed admitted model literal and effort, bounded reasoning-summary and assistant-Markdown tails, provider-neutral tool categories, and product errors. Keep path selection, repository URLs/paths, private eligibility evidence, worktrees, provider identifiers, private interactions/runs, usage, model catalogs, compatibility diagnostics, full transcripts, tool commands, and tool output out of renderer schemas.
- Parse every foreign value from `unknown` and preserve exhaustive discriminants for owned messages.
- Bound renderer-facing collections and payloads below the native transport ceilings. Use counts for destructive previews and snapshot invalidation for oversized snapshot-recoverable state.
- Keep task pages and details out of the global runtime snapshot. Read each local or recovery workspace root through one correlated atomic projection command, continue its list by cursor plus immutable continuation revision, and page an oversized serialized dispatch response without changing its representation mid-transfer.
- Treat Native transport sequence and each workspace's durable projection/event sequence as separate fields and concepts. A scoped task invalidation advances Native delivery order without putting task state in the account snapshot.
- Keep credential material, login IDs, authorization URLs, device codes, raw provider values, prompts, and human-in-the-loop answers outside snapshots, events, responses, diagnostics, and operation receipts. A strict chat-turn command may carry one bounded prompt transiently; no other renderer command may name provider turn, steering, queueing, or interaction authority. A mutation-attempt start may carry the already-authorized portable intent transiently so the gateway can bind it; attempt responses and persisted journal metadata must not echo or retain that intent. The only recovery-material exception is one explicit user-initiated, size-bounded `sessionSyncRecoveryKit` response with a short expiry; it must never appear in a snapshot, event, receipt, diagnostic, or persisted renderer state.
- Treat contract changes as compatibility changes: update fixtures, reducers, and boundary tests in the same phase.
- Regenerate versioned protocol artifacts from the pinned binary; do not hand-edit generated files.
