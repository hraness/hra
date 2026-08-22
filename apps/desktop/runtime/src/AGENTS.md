<!-- kb:context scopes/apps-desktop-runtime-src--336952000c8d -->
# Contents

- `main.ts` – compiled private-stdio gateway entrypoint, account-service initialization, snapshots, dispatch, and lifecycle integration.
- `package-smoke.ts` – isolated packaged-runtime identity probe used only by the bounded native release smoke.
- `development-reload.ts` and `development-isolation.ts` – authenticated hot-reload admission plus raw-Debug Application Support and Keychain namespace isolation.
- `host-protocol.ts` – narrow Native host request/response envelope parsing, renderer dispatch separation, and the private path-bearing project-onboarding capability.
- `host-request-lanes.ts` – product-wide mutation serialization with explicit independent read and per-pane chat lanes.
- `app-server-process.ts` – real child-process lifecycle wired through the generation-scoped pinned Codex protocol.
- `codex/facts.ts`, `codex/fact-projector.ts`, and `codex/fact-router.ts` – the sole parsed-notification-to-owned-fact path and explicit account/session fan-out.
- `internal-contracts.ts` – gateway-only account-budget, model, project, worktree, session, turn, item, and interaction types that cannot cross the renderer parser.
- `codex/` – pinned app-server JSONL/JSON-RPC adapter and process supervision.
- `accounts/` – isolated profile persistence, private `CODEX_HOME` layouts, account/login/usage/model adaptation, durable generation routing, and retained-local-data lifecycle.
- `sessions/` – immutable session state, pure folds and selectors, bounded restart hydration, gateway-only registry and command authority, interaction coordination, and compact dispatch projection.
- `chat/` – durable app-owned pane state, renderer-safe projection, per-pane command admission, model capability checks, and pre-turn account routing.
- `attachments/` – private chunked upload vault, native image normalization, provider-delivery leases, verified previews, crash reconciliation, and privacy cleanup.
- `dispatch/` – outbound cloud presence, claims, fences, capacity, worktree/Codex coordination, semantic outbox, and revocation.
- `cloud/` – optional Convex human-account pairing and custody, strict HRA HTTP transport, local/cloud authority routing, invalidation polling, and sealed interaction replies.
- `promotion/` – frozen local-to-cloud snapshots, receipt-backed transfer and recovery, activation, cleanup, and post-activation runner pairing.
- `tasks/` – bounded boot-fenced local due-work scheduling and provider-neutral system-command admission.
- `workspaces/` – trusted local project onboarding, canonical repository inspection, and app-owned managed-worktree provisioning through bundled Git.
- `projection/` – renderer-safe account/readiness snapshot, sequence, reducer, and bounded-event projection.
- `state/` – SQLite migrations and control-plane repositories.
- `security/` – child-environment allowlists and redacted diagnostics.

# Guidelines

- Keep protocol-generated values inside `codex/`. Parse each accepted notification once, translate it into bounded HRA-owned facts, and fan the same immutable fact batch to explicit consumers.
- Use `@hra-internal/codex-app-sdk` only for provider-neutral client lifecycle, operation, coordinate, persistence, and store contracts. Keep the pinned protocol, process driver, SQLite adapters, and product projection in this runtime.
- Parse stdin, app-server stdout, files, environment values, and database rows from `unknown` before use.
- Persist a process generation before creating its account child; reject stale requests, notifications, login authority, and interaction responses after generation change.
- Keep credentials and Codex-owned transcripts in the isolated account home. Chat persistence may retain only bounded user/assistant text needed to render local panes and start a later explicit turn after an account change, never raw reasoning, provider payloads, paths, commands, output, or credentials.
- Make writes serialized, shutdown bounded, and ambiguous upstream mutations explicit; never replay a mutation automatically after a lost response.
- Keep provider launch, resume, injection, and steering authority on explicit `SessionService` methods for trusted gateway coordinators. Renderer dispatch parsing may admit only app-owned pane commands and must reject provider operations, queueing, and steering.
- Never export `internal-contracts.ts` through the renderer contract or import it from the frontend. Portable task data and the bounded app-owned chat facade may cross; provider identifiers, private task/run rows, worktrees, budgets, model catalogs, full transcripts, raw interactions, diagnostics, paths, commands, and output remain gateway-only.
- Admit chat effects with a synchronous per-pane revision fence. Never queue or steer a second turn for one pane, but do not serialize independent panes behind a product-wide mutation tail.
- Route every closed renderer task command through the authority selected from durable workspace state; contracts must not import SQLite stores or generated Convex clients. Keep trusted project onboarding on its separate Native-only host command, inject installation authority in the gateway, and never admit that command to renderer bridge policies. Repository readiness exposes no URL, path, common directory, account ID, or private eligibility evidence. Preserve immutable list continuation revisions and serialized response-transfer bytes until transfer completion or expiry.
- Start cloud dispatch only from valid keychain-held runner authority and explicit repository mappings. A promoted workspace may pair this installation after activation; taskctl pairing remains a separate compatibility source. Missing configuration, sign-out, pairing failure, or runner failure must leave local account/session supervision and local workspaces available.
- Admit every new coding run through managed-worktree execution. Treat a persisted execution binding with no managed lane identity as retired and ambiguous; it needs human attention and must never be converted silently into a managed lane.
- Build every local and cloud task assignment through the dispatch-owned versioned workflow-prompt module. State and provider adapters may supply validated task facts but must not assemble their own initial prompt.
- Redact prompts, secrets, tokens, environment values, paths, and raw protocol payloads from production logs by default.
