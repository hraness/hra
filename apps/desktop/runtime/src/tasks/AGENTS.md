# Contents

- `handler-adapter.ts` – production due-work handlers over a narrow SQLite authority/system-command port, including the deliberate pre-executor queued-run retry.
- `reconciler.ts` – serialized, boot-fenced, bounded local due-work admission with persisted retry/backoff, wake coalescing, sleep-gap detection, and explicit recovery handlers.
- `local-task-change-coordinator.ts` – bounded display-only task/run invalidation coalescing with immediate semantic and terminal delivery.

# Guidelines

- Keep SQLite and task-store implementations behind narrow structural ports; this directory owns scheduling and admission, not persistence queries.
- Claim at most 32 durable work records per pass and never run two passes or two records concurrently.
- Recover at most one bounded page of old run intents at boot and one bounded page per pass; never drain an arbitrary backlog inside the startup transaction.
- Require handlers to report deadline, boot, revision, and fence revalidation before settling work. Treat stale work as obsolete without performing its side effect.
- Keep queued-run start and old-started-run recovery as distinct handlers. Recovery may mark a run ambiguous or abandoned; it must never resume an old side effect.
- Keep queued runs durably retrying without marking them started until the executor is wired. Execute Phase 3 system commands only through a port that revalidates authority and settles the command, events, and due row atomically.
- Persist every failure through the due-work port with bounded exponential backoff. Coalesce wake hints, but rely on durable rows rather than in-memory timers for correctness.
- Treat startup, timer, explicit host wake, and a large wall-versus-monotonic clock gap as hints to run the same bounded pass.
- Coalesce only display-only changes for one fixed render interval. Retain the newest revision and union every affected projection/view; flush admission, semantic, terminal, error, interaction, and submission changes immediately.
- Stop new admission before shutdown, release already claimed but unstarted records, drain the active handler, and close the current boot last.
