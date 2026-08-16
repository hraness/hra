# Contents

- `profile-layout.ts` – validated per-account Application Support paths and user-only exact `CODEX_HOME` directories.
- `local-data-remover.ts` – bounded, zero-output execution of the Native-resolved descriptor-relative account-home deletion helper.
- `profile-store.ts` – SQLite-backed active/tombstoned account profiles, selection, revisions, bounded removal counts, durable generations, and local-data state.
- `protocol.ts` – bounded provider-neutral projection of already parsed account, login, rate-limit, and token-usage values.
- `dispatch-budget.ts` – conservative freshness and remaining-capacity classification for local-only account routing.
- `runtime-router.ts` – one lazy, durable-generation-scoped supervised app-server process per account profile.
- `account-service.ts` – serialized domain-command orchestration, generation-bound login authority, reconciliation, dispatch-budget refresh, removal, retained-local-data deletion, and projection updates.

# Guidelines

- Scope every process, notification, login, request, and callback by HRA account profile ID plus app-server generation.
- Keep upstream login IDs, OAuth URLs, credentials, tokens, and raw account payloads out of SQLite, retained logs, and renderer authority.
- Derive account directories only from validated opaque profile IDs under the owned Application Support root; reject symlinks and enforce `0700` on every directory.
- Persist the next process generation before creating a child, expire transient login authority when it changes, and reconcile account state after a restart instead of trusting persisted signing transitions.
- Open authorization URLs only from the exact allowed HTTPS origins and never retain their query, fragment, or device-code authority in operation receipts.
- Keep profile removal, process stop, workspace preservation, and full local `CODEX_HOME` deletion separately inspectable and revision-bound. Disclose credentials, sessions and history, configuration, and logs before deletion; never delete worktrees with an account.
- Delegate full `CODEX_HOME` deletion to the Native-resolved helper. Keep its process environment closed, its deadline and output bounded, its errors pathless, and advance the durable deletion tombstone only after exit zero.
- Preserve a snapshot-projected retained-local-data tombstone until full local data is actually deleted so renderer and app restarts cannot hide recoverable state.
- Consume only pinned-protocol owned values. Let the pinned boundary brand approved provider authorization URLs, keep product projection here, and revalidate external-open sinks as defense in depth without reparsing raw app-server payloads.
- Rank task and interactive-pane accounts from fresh local rate-limit projections only. Honor a healthy pane preference and proactively choose another eligible account before a new provider effect begins. A definitive provider usage-limit rejection stops that logical turn and cannot authorize post-rejection routing, continuation, or replay. Never expose budgets or provider identity to the renderer or cloud.
- Treat a strictly classified invalidated authentication response as durable session expiry, clear private budget state, and publish only the owned re-login status.
