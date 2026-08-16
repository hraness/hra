# Contents

- `protocol.ts` – bounded semantic projection of pinned, already parsed Codex thread, turn, item, and activity values used by HRA.
- `interaction-protocol.ts` – fail-closed translation of parsed provider-declared non-secret input and managed-worktree file approvals; arbitrary question prose remains plaintext-visible and receives no semantic DLP claim.
- `model.ts`, `entity-map.ts`, `reducer.ts`, `selectors.ts`, and `store.ts` – normalized immutable session state, logarithmic persistent item indexes, pure bounded folds, weakly retained selectors, and stable external-store publication.
- `retention-policy.ts` – the shared live-state and hydration metadata, history, display, authority, and batch limits.
- `hydration.ts`, `hydration-targets.ts`, and `hydration-coordinator.ts` – generation-fenced buffers, bounded target and display windows, positioned reads, retry circuits, and conservative restart recovery.
- `interaction-coordinator.ts` – one-shot provider-request authority, deadline and correlation ownership, positioned settlement facts, and generation-scoped teardown.
- `command-executor.ts` – the only session component that invokes the closed pinned-operation surface.
- `session-registry.ts` – bounded gateway-only project, binding, active-turn, and legacy summary routing.
- `fact-dispatch-adapter.ts` – exact owned-fact adaptation to gateway-only dispatch events.
- `identity.ts` – stable account-scoped owned identifiers.
- `session-service.ts` – gateway-only orchestration of typed commands and the state, registry, hydration, interaction, tool-activity, and dispatch components.

# Guidelines

- Keep every provider session, thread, turn, item, interaction, rollout path, and transcript behind this boundary. The separate chat service may derive a bounded provider-neutral pane projection without exporting any provider identifier or this state model.
- Route every request through the account service so private `CODEX_HOME` selection and durable process generations remain authoritative.
- Treat `SessionStore` as the authority for thread, turn, item, interaction, operation, and hydration state. Mutable registry maps may retain only command routing and gateway projection metadata.
- Fold owned facts only. Never inspect raw notifications here, create a fake generation, or reuse a live shape for a snapshot.
- Open the bounded hydration buffer before a replacement generation can publish. Install one atomic snapshot plus only a coverage-safe suffix. When `thread/read` coverage is unproven, keep active history explicitly recovering and discard unsafe deltas until an authoritative terminal state permits convergence.
- Report an exhausted hydration run without a positioned provider anchor through bounded account-level recovery metadata. Never fabricate a stream position to fold that failure into session state.
- Apply the shared retention policy continuously, not only during restart. Keep metadata, selected-history, execution-active-history, display-item, streaming-delta, byte, count, authority, concurrency, deadline, and retry sets within it. Eviction is local forgetting, never a fabricated provider deletion. Fail closed when mandatory active authority alone exceeds a limit.
- Keep per-delta state work logarithmic in retained entities. Do not replace the persistent item or byte indexes with a flat record spread, linked per-delta object chain, or strong selector cache.
- Forget settled interactions and terminal operation rows after their positioned facts advance the cursor. Clear generation-scoped tombstones and auxiliary tool caches at replacement boundaries.
- Purge semantic state, bindings, active authority, auxiliary caches, and path-bearing project indexes synchronously after the durable account service emits `account.removed`.
- Project only the latest useful turn activity to trusted gateway consumers. Never expose raw reasoning; use concise reasoning-summary notifications and bounded status text.
- Derive cloud activity only from allowlisted method and item-type facts on the exact owned active turn. Copy only the bounded `delta` field from reasoning-summary and assistant-message notifications; never forward a raw notification object or server-request parameters.
- Treat thread and turn mutations as ambiguous after a lost response. Do not automatically replay them.
- Preserve each thread's admitted lane mode across positioned reads and turn reconciliation. Grant managed-worktree approval semantics only to a thread whose binding is managed; local and read-only lanes keep their distinct authority.
- Accept launch workspaces only through the trusted gateway seam after a coordinator has selected the account and resolved a Native-chosen repository. Never add provider launch, queue, or steer operations to the renderer command union; the renderer can name only an app-owned pane and turn.
- Give each supported provider request one exact local deadline and at most one JSON-RPC response. Reject a persistence binding that changes the projected public request. Release all volatile authority when its process generation ends. Return synchronous application failure as one typed outcome to the sync owner; reserve expiry callbacks for asynchronous provider/deadline events.
