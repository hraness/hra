# Conversation-bound scheduled tasks

## Decision

HRA will support scheduled task creation, inspection, editing, pausing, resuming,
and deletion as local **session tasks**. A session task is owned by one immutable
HRA session and may create work only by materializing a message in that
session's existing durable queue. It is not an entry in the private Codex
desktop Scheduled Tasks registry, a generic scheduler, or a standalone task
that creates a new conversation.

The pinned Codex app-server protocol has no scheduled-task CRUD request. It
does expose experimental dynamic tools on `thread/start`, so new HRA-created
sessions advertise one narrow `hra.automation_update` tool. That tool operates
only on the session identified by the provider request's authoritative thread
ID. The public CLI exposes the same storage contract under `hra session task`.
Existing provider threads created before this feature remain manageable through
the CLI. HRA does not retrofit the in-conversation tool onto those threads
because they have no durable proof that HRA started them with the reviewed tool
contract.

HRA never writes `$CODEX_HOME/automations`, edits rollout files, invents a
provider automation RPC, or creates a replacement conversation.

## Product contract

The CLI grammar is:

```text
hra session task list <session>
hra session task show <session> <task-id>
hra session task create <session> --name <name> --every-minutes <15..10080> [--paused] [--idempotency-key <uuid>] -- <prompt>
hra session task edit <session> <task-id> --revision <n> [--name <name>] [--every-minutes <15..10080>] [--pause|--resume] [--idempotency-key <uuid>] [-- <replacement-prompt>]
hra session task delete <session> <task-id> --revision <n> [--idempotency-key <uuid>]
```

Nesting under `session` makes a standalone destination unrepresentable. A
session selector may be an exact ID or an unambiguous local title. Task
mutations require an exact task ID, and storage proves that it belongs to the
resolved session. Edit is a compare-and-swap patch: it requires the current
revision and at least one changed field. Pause and resume are mutually
exclusive. Resuming or changing the interval establishes a fresh anchor at
`now + interval`; name- or prompt-only edits retain the current due time.

The first schedule vocabulary is deliberately closed to elapsed whole-minute
intervals. The minimum cadence is 15 minutes and the maximum is seven days.
Calendar, timezone, RRULE, cron, and daylight-saving semantics are not silently
approximated; a future closed schedule union may add them.

Public records carry `scope: "conversation"`, the HRA session ID, task ID,
name, status, interval, revision, timestamps, and next due time. They never
carry a provider thread ID, project retarget, model, execution environment, or
standalone kind. List omits prompt content; show and mutation results may return
the bounded prompt. At most 32 non-deleted tasks may belong to one session.

## Dynamic tool contract

New threads advertise exactly one namespaced function tool:

- namespace: `hra`
- name: `automation_update`
- operations: `create`, `update`, `view`, `list`, and `delete`
- schedule: `{ "kind": "interval_minutes", "minutes": 15..10080 }`

The input schema has `additionalProperties: false` at every object boundary.
It has no target-session, thread, project, destination, cron-kind, model, or
execution-environment field. The session authority comes only from
`item/tool/call.threadId`; the profile and process generation come only from
the owning app-server connection. The handler resolves that private provider
thread ID to one exact local session before any read or mutation.

The callback performs only local SQLite work. It never issues a nested
app-server request while the client read loop is servicing the server request.
Mutating calls use an immutable call identity and canonical request digest;
same-call replay returns the recorded result and changed replay fails closed.
Responses contain one bounded `inputText` result and no private provider ID.
Every other dynamic tool, namespace, or malformed request remains rejected.

## Storage and scheduling authority

During current-main convergence this feature must land as append-only schema
version 29. The isolated implementation branch still uses its stale-base next
version, 27, which already conflicts with migrations 27 and 28 on current main
and must not be merged unchanged. The feature adds four strict local tables:

- `session_conversation_automation`: durable proof that one exact HRA session
  and provider thread were started with the reviewed conversation tool;

- `session_tasks`: a task ID, non-null session foreign key, name, prompt,
  closed interval schedule, active or paused state, revision, next due time,
  and timestamps;
- `session_task_occurrences`: an immutable task revision and scheduled slot,
  coalesced interval count, queue binding, and timestamps;
- `session_task_receipts`: an immutable idempotency identity, canonical request
  digest, task/session binding, operation kind, and bounded stored result.

List, view, create, edit, and delete commit an immutable receipt in the same
transaction as the read snapshot or task mutation. A replay with the same
identity and complete provider-callback digest returns the stored decision;
changed or cross-operation reuse has no effect. Edit compares the expected
revision and task/session binding in the write transaction. Session deletion
cascades both task-bound and list receipts so prompt-bearing local evidence is
not orphaned.

Due materialization is one SQLite transaction that re-reads the task revision
and session authority, proves the task active and executable, inserts one
immutable occurrence, inserts one ordinary queue row with the existing stable
enqueue sequence, and advances the next due time. There is no boundary where a
schedule advances without its queue row. The occurrence key and queue identity
make restart replay inert.

`materializeDue` has a one-handoff contract: each invocation commits and
returns at most one occurrence across all tasks. The daemon hands that exact
queue row to the existing dispatcher before asking storage for another, and a
single maintenance pass is capped at 32 handoffs. A keyset cursor advances the
bounded due scan past temporarily unusable earlier tasks. When several slots
were missed, the transaction records one run for the earliest overdue slot,
counts the skipped slots, and advances directly to the first slot after `now`.
It never bursts one turn per missed interval. Clock rollback cannot revisit an
already materialized slot; forward jumps use bounded arithmetic rather than an
interval-by-interval loop.

An active provider turn delays execution through the existing queue. The queue
dispatcher rechecks the current project root, preset, Fast setting, account
generation, runtime profile, provider observation, and approval policy before
starting the turn on the existing provider thread. A scheduled task never
calls `thread/start`, rotates accounts, auto-approves, steers, interrupts, or
falls back to a new session.

Terminal or recovery-required sessions disable future materialization. Signed
out accounts and temporarily unusable projects leave tasks overdue and back
off; they do not accumulate queue rows. Pausing or deleting before the due
transaction prevents the run. A queue row that committed first is ordinary
durable session work and is not falsely reported as canceled by a later edit.

The daemon owns one bounded, abortable pump. It wakes on startup, task mutation,
session/account recovery, and the next due time; processes tasks in
`(next_due_at, id)` order; fences every pass with the daemon authority; and is
joined before SQLite closes.

Cloud session projection replaces every scheduled-task user prompt with the
fixed marker `[scheduled task prompt omitted]`. Classification uses the exact
durable occurrence-to-queue binding when a queue client ID is present and the
persisted queue-to-turn runtime binding after recovery when it is absent.
Assistant output and summaries remain projectable; the private scheduled
prompt does not.

## Adversarial acceptance

The implementation is not complete until deterministic tests prove:

1. lost create/edit/delete responses replay exactly once, while changed reuse
   fails without mutation;
2. cross-session IDs, stale revisions, extra fields, standalone-field
   smuggling, invalid intervals, and task quota overflow fail closed;
3. edit-versus-due and pause/delete-versus-due races linearize to one complete
   old or new revision, never a hybrid;
4. crash or restart before or after materialization yields either no run or one
   occurrence plus one queue row, never a duplicate;
5. multi-day downtime coalesces to one run and clock rollback cannot duplicate;
6. active, signed-out, unbound, terminal, recovery, missing-project, and
   unusable-project states never cause a new session or provider fallback;
7. prompt edits do not rewrite an already queued message, and task prompts stay
   out of cloud projections, logs, list output, and provider identifiers;
8. daemon close aborts and joins the pump before storage closure;
9. the dynamic tool accepts only its exact namespace, name, authority, schema,
   and replay identity; and
10. a live scheduled run adds a turn to the same provider thread without
    creating another HRA session; and
11. a file-backed WAL close and reopen dispatches one already-committed pending
    occurrence at most once and never duplicates its occurrence row.

## Release boundary

This feature can ship in the public source and package without deploying a new
Convex schema because its authority and prompts are local-only. A protected
main merge triggers the current Vercel production build. Package publication
must use a newly accepted current-project-only tag and artifact path; the
retired HRA v0 publication scripts and provider identities remain prohibited.
Canonical domain aliasing, DNS, hosted Convex writes, and native Codex desktop
task-registry mutation are separate authorities and are not implied by this
feature.
