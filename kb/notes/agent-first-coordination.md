---
title: Agent-first coordination substrate
description: The durable, bounded HRA protocol for coordinating parallel Codex sessions.
type: note
status: current
area: hra
tags:
  - agents
  - cli
  - coordination
  - sqlite
relations:
  related-to: [ plans/hra-v1 ]
---

# Agent-first coordination substrate

## Decision

HRA adds a small durable coordination kernel for already-existing Codex sessions. The kernel lets orchestrating agents declare work, claim it, bind exact HRA sessions, exchange bounded signals, submit structured results, and review those results. Codex app-server remains the execution runtime. HRA does not add its own model loop, tool runtime, memory system, or human workflow editor.

This decision intentionally narrows and supersedes the earlier deferral of product-owned task graphs. HRA remains a Codex account, device, and session control plane. It gains closed coordination records for those sessions rather than becoming a generic autonomous-agent framework.

## Source assessment and clean-room boundary

The design study inspected Agencity at commit [`4beeb6fef202a491959ceef9b1f74d1567349b4c`](https://github.com/kousun12/agencity/commit/4beeb6fef202a491959ceef9b1f74d1567349b4c), dated 2026-08-25. The exact source is in the public [`kousun12/agencity`](https://github.com/kousun12/agencity) repository.

The repository is source-readable but does not carry a license grant at that revision:

- The tree contains no `LICENSE`, `COPYING`, or equivalent license file.
- [GitHub repository metadata](https://api.github.com/repos/kousun12/agencity) reports no detected license.
- [`package.json`](https://github.com/kousun12/agencity/blob/4beeb6fef202a491959ceef9b1f74d1567349b4c/package.json) marks the package private.
- The [README](https://github.com/kousun12/agencity/blob/4beeb6fef202a491959ceef9b1f74d1567349b4c/README.md) supports use from a source checkout, but it does not grant redistribution or derivative-work rights.

Agencity is not a Codex-subscription client. Its documented product transports use direct OpenAI, Anthropic, or Vercel AI Gateway credentials through the Vercel AI SDK. The source contains no Codex app-server or ChatGPT subscription integration. Making it use Codex subscriptions would require replacing its provider and autonomous-run boundary, then reconciling its sessions, effects, approvals, and recovery with Codex app-server. That work would duplicate HRA inside a source base without a clear license grant.

Official OpenAI documentation describes [Codex app-server](https://developers.openai.com/codex/app-server) as the open-source deep-integration interface for authentication, conversation history, approvals, and streamed agent events. A Codex-backed harness is therefore technically possible, and HRA already uses that boundary; Agencity simply does not implement it. Retrofitting Agencity would be a new integration rather than a supported configuration or CLI adapter.

HRA will therefore use only independently expressed systems concepts. No Agencity source, schema, prompt, naming system, or prose is copied. HRA will not depend on, embed, fork, or redistribute that repository.

## Transaction model and durable prefixes

Chroma's article [*Agent Swarms are a Distributed Systems Problem*](https://www.trychroma.com/engineering/transactions) identifies an important mismatch between classical optimistic transactions and agents: reasoning and tool work are expensive, read sets emerge during execution, and aborting a long speculative run can waste substantial work. Its proposed Fission mechanisms are not copied into HRA, but the framing sharpens this protocol's transaction boundary.

HRA treats each independently validated coordination fact as a durable prefix:

- a completed task with its accepted submission remains completed when later work is failed or cancelled;
- immutable submissions, reviews, evidence references, receipts, and events are never rolled back because a downstream task fails or the work is cancelled;
- dependency edges make later work consume accepted prefixes rather than holding a work-wide transaction open;
- one short SQLite transaction performs each compare-and-swap, capability check, projection update, receipt settlement, and event append;
- no SQLite transaction remains open across model reasoning, a Codex request, filesystem verification, or another provider effect.

This is forward recovery, not a claim that every partial result is valid. A prefix becomes reusable only after its declared shape, evidence, authority, and review gates accept it. HRA does not adopt page-level locking, wound-wait scheduling, or generic early commit: HRA has entity revisions and task fences, and an ambiguous provider effect must be reconciled rather than wounded, stolen, or replayed. Local SQLite remains the one linearizable execution authority for a machine.

## Authority split

Codex app-server continues to own:

- ChatGPT and Codex authentication;
- provider threads, turns, items, and transcripts;
- model context and compaction;
- tools, skills, apps, permissions, and approvals;
- workspace execution and provider-visible outcomes.

HRA owns:

- isolated account profiles and exact account generations;
- work declarations and dependency state;
- attempt claims, fences, receipts, and recovery;
- exact session and turn bindings;
- bounded submissions, reviews, signals, and evidence references;
- local projections and work-scoped event streams; encrypted work projection remains a later extension.

An HRA session is the durable actor. A task is finite work. An attempt binds one task to one exact session execution. HRA does not add a second `Agent` aggregate.

## Core model

The coordination kernel has six primitives.

| Primitive | Durable meaning | Required boundaries |
| --- | --- | --- |
| Work | One bounded objective, policy, explicit account routes, revision, lifecycle, and work-scoped event stream | Maximum task count, depth, dependency count, active attempts, result bytes, and retention are explicit |
| Task | One finite objective with parent containment, dependency edges, routing key, priority, timing, deliverable contract, and review policy | Task identity is distinct from a session; dependency and parent edges are distinct |
| Attempt | One claim and execution lineage for a task | Pins claim fence, actor, exact account and generation, project, runtime profile, HRA session, provider-effect receipts, and terminal or ambiguous state |
| Submission | One immutable structured result from an attempt | Carries bounded summary, result JSON, evidence references, and content digests; assistant prose alone never creates it |
| Review | One immutable accept or revise decision over an exact submission revision | A required reviewer must use a session distinct from the worker session; approval does not prove factual correctness |
| Signal | One attributable message between joined work participants | Keeps provider `deliveryState` separate from recipient `acknowledgedAt`; optional session delivery uses existing queue or steer operations |

### Work and task lifecycle

Work has `open`, `cancel_pending`, `fail_pending`, `completed`, `failed`, and `cancelled` states. Pending terminal states exist only while an ambiguous attempt still requires reconciliation. A task has an explicit projection, but readiness is recomputed from authoritative facts before every claim.

```text
ready =
  work is open
  and task is waiting or ready
  and notBefore is absent or has passed
  and claimBy is absent or has not passed
  and every dependency has an accepted submission
  and no live or ambiguous attempt exists
```

`blocked` is an explicit attempt report, while readiness remains derived from the current facts. A dependency becomes satisfied only when its submission is accepted. Session termination, a final assistant message, valid JSON shape, or a worker's completion claim is not sufficient by itself. `claimBy` closes new admission; `deadline` closes completion. Neither is inferred from the other.

Parent containment answers which task created narrower work. Dependency edges answer which accepted results must exist first. Graph admission rejects missing references, self-edges, cycles, excessive depth, and changes to the durable meaning of an existing task.

Terminal failure and cancellation preserve every already accepted durable prefix. `work.release` is a separate explicit logical destructive-purge boundary. It requires settled terminal work, the exact coordinator capability, the current work revision, and `acknowledgeDataLoss: true`. Only an unresolved attempt dispatch blocks release. A prepared, started, or unknown signal effect may be discarded under that acknowledgement because signal delivery is not task execution authority. The release tombstone counts every unresolved signal effect it discards.

Release atomically replaces the work graph and its event, idempotency, and task-history projection state with a compact tombstone. The tombstone records the final revision and stream head, terminal and release request digests, discarded-record counts including `historyIndex` and `historyVersions`, and a digest of that boundary without retaining objectives, task bodies, results, evidence, signal bodies, or capabilities. While that tombstone remains, only the same release idempotency key and request digest replay the release result. Replay guarantees for every earlier operation have ended. Tombstones have separate count, byte, and maximum-age ceilings, so `retentionUpperBoundAt` is an upper bound rather than a guaranteed retention time.

This is a logical SQLite deletion contract, not a forensic-erasure promise. The trusted connection's secure-delete setting is defense in depth, but release does not promise immediate physical sanitization of prior SQLite pages, WAL frames, backups, snapshots, or storage media.

### Exact account routing

Each work record declares immutable execution routes. HRA resolves each route to exact local account and project IDs when it admits the route. A route is exactly:

- account ID;
- project ID;
- preset and Fast setting.

Tasks repeat one exactly declared route. The scheduler never selects an account from usage, quota, freshness, availability, or incidental ordering. A provider limit ends or blocks the current attempt. HRA never replays it under another account. Routes cannot be revised in protocol v1; differently routed work must be declared explicitly.

Multiple Codex subscriptions remain independent capacities, not a pooled quota. Explicit parallel assignment is supported. Automatic rotation, failover, quota evasion, and usage-based routing are unavailable.

### Claims, fences, and ambiguity

Claim admission is a local SQLite compare-and-swap. It increments a monotonic task fence and creates one attempt. At most one live or ambiguous attempt may exist for a task.

Renewal and release require the exact attempt ID, actor, fence, expected revision, and an unexpired lease. A stale actor cannot regain authority after a later fence exists.

A claim lease prevents duplicate admission. It does not prove that a Codex effect stopped. On expiry:

1. If no provider effect began, HRA closes the attempt as expired without effect and makes the task eligible again.
2. If the exact bound session and turn are provably terminal, HRA records that observation and waits for a submission or explicit terminal report.
3. If a provider effect may have begun or cannot be observed conclusively, HRA marks the attempt and task `recovery_required`. It does not steal, reroute, or redispatch the task.

Process IDs, account labels, timestamps, terminal presence, and missing heartbeats are not execution authority.

### Request-before-effect dispatch

Dispatch binds an already-existing exact actor session. It never creates a session. The session must match the task's explicit account generation and project route before HRA admits the effect. Dispatch then composes existing HRA turn operations without weakening their recovery rules:

1. Resolve the existing session and verify its exact account generation and project against the task route.
2. Commit the attempt, claim, session binding, exact route, and dispatch request digest.
3. Journal the work-instruction turn mutation before calling Codex.
4. Reconcile and bind the one exact turn outcome or ambiguity.
5. Append the coordination transition and advance the work predicate revision.

A crash after any boundary resumes the same attempt and idempotency keys. The existing bound session remains authoritative if the turn start fails. An indeterminate turn start becomes recovery-required and is never replaced speculatively.

The generated worker brief contains the bounded task contract, accepted dependency summaries, evidence requirements, and exact `work apply` reporting documents. Dependency results remain untrusted data and cannot modify route, permission, interaction, or review authority.

### Fanout and idempotency

Independent fanout uses two phases:

1. One SQLite transaction validates the entire batch and reserves every attempt or none.
2. Each provider dispatch runs as an independent journaled effect with its own terminal or ambiguous result.

Atomic admission does not claim atomic external execution. Dependent tasks are admitted only after their prerequisites are accepted.

Every mutation document carries a caller-supplied UUIDv7 `idempotencyKey` plus a canonical request digest computed by HRA. Reusing the key with identical durable meaning preserves the original decision, identities, and capabilities without adding a mutation, event, or revision. Mutable public records and `workRevision` are reprojected from current state, so an ordinary replay is not promised to be byte-identical. Reusing the key with changed meaning returns `CONFLICT`. A retained `work.release` tombstone is the exception: its exact stored release result is the whole remaining replay boundary.

An empty `task.claimNext` result is durable and same-key replayable, but it appends no event and advances no work revision. A successful claim still appends `task.claimed` and advances the work stream. This keeps high-frequency empty polling from manufacturing history.

### Signals and receipts

A signal is stored before any session delivery effect. Both sender and target must be exact joined session members and present the appropriate work-scoped capability. An optional task reference provides context but does not widen authority.

`queue` and `steer` retain their existing HRA meanings:

- `queue` creates one durable future turn and may wake an idle session.
- `steer` targets one exact active turn and does not create a future-turn receipt.

The coordination state keeps these facts distinct. `deliveryState` is one of `pending`, `accepted`, `failed`, or `unknown`; `acknowledgedAt` is an independent nullable timestamp:

- accepted into the work mailbox;
- provider delivery prepared;
- queue or steer effect started;
- exact provider acceptance with either a `queue_created` or `turn_steered` receipt;
- acknowledged by the recipient;
- failed or unknown.

Acknowledgement proves receipt only. It does not prove that the recipient acted, that a turn completed, or that the signal's claim is true.

### Submissions, evidence, and completion gates

Submission documents use a strict, bounded discriminated schema. They may contain:

- a short summary;
- finite structured JSON under an optional restricted deliverable schema;
- exact HRA session or session-and-turn references;
- workspace-relative artifact references with project, byte length, and SHA-256 digest;
- Git commit IDs bound to an exact project.

HRA does not store arbitrary tool output, raw reasoning, provider payloads, absolute paths, credentials, or unbounded file bytes in coordination records.

Initial completion gates may inspect only HRA-owned facts:

- required dependencies have accepted submissions;
- the exact attempt has no unresolved provider effect;
- the submission satisfies its declared shape and bounds;
- required evidence references resolve to the expected local authority;
- required independent review accepted the exact submission revision;
- deadlines, maximum attempts, and explicit cancellation state are satisfied.

HRA does not run arbitrary shell commands as completion gates. Codex may run tests and report evidence, but HRA does not treat reported success as independently verified unless a later closed verifier can validate that exact evidence.

## Local storage and event semantics

Local SQLite remains canonical. The domain schemas and narrow `WorkStore` boundary keep SQL rows out of command, daemon, and CLI contracts.

The local implementation keeps normalized current rows plus append-only transition and receipt history. It also keeps an immutable task-history membership index and bounded append-only public projection versions for attempts, reports, submissions, reviews, and task-bound signals. Each version is bound to the work event sequence that made it visible. Every fresh state-changing coordination mutation except `work.release` appends a compact event and advances the work predicate revision in the same short transaction as its current-state update, history projection, and idempotency receipt. An empty `task.claimNext` settles only its exact idempotency result and leaves the stream unchanged. `work.release` instead commits the guarded graph and history purge plus replay tombstone atomically. Evidence verification is deliberately split: a read resolves the exact immutable authority, artifact hashing or Git inspection occurs without a writer transaction, then the write transaction rechecks every binding and revision before it commits the verification result.

The work event stream is scoped to one work ID. It is not a global feed over account, provider, device, session, interaction, queue, usage, and cloud state. Provider observations remain separately sourced and carry coverage and freshness when projected beside work state.

Events use an opaque work-bound cursor containing stream epoch and sequence. Event bodies carry IDs, lifecycle facts, counts, and content digests—not repeated objectives, results, evidence lists, summaries, or signal bodies already held in normalized rows. This keeps worst-case valid operations inside the event bound. Delivery is at least once. Consumers deduplicate by `(workId, streamEpoch, sequence)` and persist a checkpoint only after applying every preceding frame.

## Agent-only command surface

The coordination surface is machine-only. It has no table renderer, prompts, TUI, browser observer, or interactive workflow editor. Complex documents arrive through protected standard input or a nonterminal file descriptor rather than argv.

The minimally complete vocabulary is frozen to one mutation entry point and six read or streaming entry points:

```text
hra work protocol [--operation <kind>|--type <name>|--topic <topic>]
hra work apply --input-stdin
hra work snapshot <work> [--actor <session>]
hra work task <task> [--history-limit <1..50>] [--history-cursor <cursor>]
hra work poll <work> [--actor <session>] [--cursor <event-cursor>] [--action-cursor <action-cursor>] [--limit <1..50>] [--wait-ms <0..30000>]
hra work events <work> [--cursor <cursor>] [--limit <1..200>] [--wait-ms <0..30000>] [--json|--jsonl|--follow]
hra work watch <work> [--cursor <cursor>]
```

`work apply` accepts one strict versioned JSON request from protected standard input: `{protocol, version, requestId, operation}`. The nested operation carries its own UUIDv7 `idempotencyKey` and one of the closed operation kinds advertised by `work protocol`. Unknown kinds, unknown fields, non-UUIDv7 keys, and input on argv are rejected. Success and failure both echo the request ID in a versioned protocol response. There are no separate mutation commands.

`protocol` has mutually exclusive `--operation`, `--type`, and `--topic` selectors. Its deterministic shards return the supported version and contract digest, exact field contracts, value syntax, capability sensitivity, operation kinds, hard limits, error combinations, recovery directives, and matching process exit codes. `snapshot` returns one transactionally consistent work view, terminal intent or outcome, bounded recent work-level signals with an omitted count, and a resume cursor. `task` without either history option returns task detail with its active and latest attempt lineage, latest full attempt report, latest submission and ordered reviews, and bounded recent task signals. Supplying either `--history-limit <1..50>` or `--history-cursor <cursor>` selects the separate history result; a cursor-only continuation defaults to 20 items. History contains the task's attempts, reports, submissions, reviews, and task-bound signals rather than silently overloading detail. `poll` returns a byte-bounded action-oriented view and may wait on the work predicate revision. `events` returns one byte- and count-bounded finite historical page unless its explicit JSONL follow spelling is selected. `watch` is the canonical resumable JSONL stream and never changes authority.

Each complete compact JSON response for snapshot, task detail, and task history, including its envelope and terminating newline, has a 512 KiB serialized UTF-8 ceiling. Snapshot may trim only recent work signals; task detail may trim only recent task signals and latest-submission reviews; task history may return fewer than the requested limit. Omitted counts, per-kind remaining counts, total and remaining items, and `nextCursor` expose every reduction. Core work and task state, active authority, and current lineage are never silently discarded to fit the ceiling.

The signed task-history cursor binds the exact work and task, work stream epoch and sequence, task-history membership high-water ordinal, task revision, projection time, and offset. The first page freezes that cut. Continued pages select only memberships at or below its high-water ordinal and the newest public projection version at or before its work sequence. Later mutations and later memberships are excluded, so all pages remain coherent as of one fixed cut even while the live task changes.

Every non-streaming work command writes one versioned success or failure JSON document to stdout and diagnostics to stderr. A JSONL stream writes only gap, event, and checkpoint frames to stdout and one closed terminal failure envelope to stderr. Each complete terminal-safe JSONL frame, including its newline, is capped at 512 KiB; the terminal failure document is capped at 64 KiB. The protocol descriptor advertises both wire ceilings. Existing HRA exit codes remain authoritative.

`work poll` is the compact orchestration read. One response contains only:

- ready tasks;
- the actor's live attempts;
- unread signals;
- submissions awaiting that actor's review;
- recovery-required work;
- current work revision and cursor;
- explicit omitted counts and one signed action continuation.

Full task bodies and their latest submissions require `work task`; older compact events require `work events`. Empty, unavailable, stale, partial, and omitted remain distinct.

### Snapshot and cursor contract

`work poll` reads the work, predicate revision, task projections, attempts, inbox, reviews, and stream cut in one SQLite read transaction. Starting `work events` from that event cursor cannot miss a later committed work mutation. If action arrays are truncated, `nextActionCursor` authenticates the exact actor, stream cut, and six independent offsets. A continued action page is valid only while that stream cut is still current; otherwise the caller restarts its poll. Action continuation cannot long-poll.

A bounded `wait-ms` is allowed only for predicates whose revision changes in the same transaction as every satisfying authority transition. Session activity, provider freshness, and cloud presence are not work-wait predicates unless their exact bridge also advances that revision transactionally. A notification wakes a read; the durable cursor remains the source of truth.

## Cloud scope

Cloud absence never blocks local coordination. Local SQLite owns task admission, claims, dispatch, reconciliation, submission, review, and signal authority for sessions executed on that machine.

The initial work protocol does not add a Convex schema, hosted executor, or remote work command. A later extension may carry encrypted bounded projections through the existing infrastructure. Such a service may see only opaque user, device, work, task, revision, lifecycle, size, and timestamp metadata required for authorization, quotas, retention, and routing. Objectives, messages, results, evidence, project details, and account labels must remain encrypted.

Any later remote projection must route commands to the exact execution custodian. Remote devices may not claim local tasks, dispatch turns into bound local sessions, answer local interactions, take over an attempt, or become a second provider writer. Revocation and account-key loss would retain the existing HRA device and erasure boundaries.

## Turso decision

Do not add Turso for this feature.

Agencity's own [capability documentation](https://github.com/kousun12/agencity/blob/4beeb6fef202a491959ceef9b1f74d1567349b4c/docs/capabilities.md) describes Turso as a separate immutable-envelope exchange while keeping local relational state canonical. It explicitly does not provide distributed leases, task stealing, automatic execution-owner failover, or artifact replication. Those limits mean the adapter does not solve HRA's coordination authority problem.

HRA already has local SQLite transactions, encrypted Convex projections, authenticated device state, server-time execution leases, remote-command fencing, quota enforcement, retention, revocation, and erasure. A Turso adjunct would add a second credential boundary, replication protocol, conflict model, retention policy, deletion surface, and network truth without removing an existing authority.

The store boundary is the future storage seam. Reconsider Turso only when a concrete server-side SQL consumer exists and the design specifies tenancy, authentication, encryption, conditional writes, retention, export, erasure, conflict handling, and credential custody. Evaluate it then as a replacement authority or immutable export transport, not as a second canonical store beside SQLite and Convex.

## Adapted and rejected ideas

| Source concept | HRA decision |
| --- | --- |
| Durable state outlives a process or model context | Adopt for work, attempts, submissions, reviews, signals, and receipts |
| Agent identity is separate from finite task identity | Adopt by treating the existing HRA session as actor and task as work |
| Parent, child, and sibling relationships are explicit | Adopt as task and attempt edges, never folders, labels, process IDs, or terminal state |
| Request-before-effect execution and explicit unknown outcomes | Adopt through existing HRA mutation journals and new work receipts |
| Stable handles, atomic fanout admission, and idempotent replay | Adopt with bounded UUIDv7 receipts and independent provider effects |
| Structured results and independent review | Adopt as submissions and reviews; shape validity is not factual proof |
| Durable mailbox with queue and steer | Adopt through signals composed with existing session operations |
| Bounded goals, deadlines, gates, schedules, and budgets | Adopt objectives, timing, attempt limits, concurrency, and HRA-owned gates; defer recurring schedules until wake revisions are complete; provider token usage remains observational |
| Cursor-based recovery and compact derived context | Adopt one work-scoped stream and bounded accepted-result summaries with evidence references |
| Persistent TypeScript REPL and model loop | Reject because Codex owns execution, context, and tools |
| Direct OpenAI, Anthropic, or Gateway provider layer | Reject because HRA is a Codex-subscription control plane |
| Generic shell, SQL, file, dynamic tool, or RPC surface | Reject; HRA exposes closed domain commands and Codex owns tools |
| Separate transcript, raw reasoning, or arbitrary tool-output archive | Reject |
| Separate agent catalog or profile-learning system | Reject; sessions, Codex skills, and repository instructions remain authoritative |
| Human TUI, web observer, city metaphor, or workflow editor | Reject for the agent-only coordination surface |
| Automatic account routing, task stealing, or cross-device execution failover | Reject |
| New content-addressed byte store | Reject initially; retain bounded digest references to workspace-owned content |

## Adversarial invariants

1. Two concurrent claims cannot receive the same task or fence.
2. A graph apply is all-or-nothing and rejects cycles, self-edges, missing dependencies, excess bounds, and changed-meaning key reuse.
3. Dynamic fanout cannot revise accepted tasks, widen account routes, exceed work policy, or create a dependency cycle.
4. An expired claim with a possible provider effect never returns to ready automatically.
5. Every dispatch crash boundary recovers one exact session and turn or remains recovery-required.
6. Account sign-out, restart, rate limit, or usage state never changes a task's route.
7. One account failure never causes another account to execute its task; differently routed work must be declared explicitly.
8. Required review rejects the worker session as reviewer and uses exact submission revision compare-and-swap.
9. `revise` preserves the original submission and feedback, then permits a separately claimed fresh attempt.
10. Signal storage, provider delivery, acknowledgement, action, and task completion remain distinct.
11. Every fresh state-changing work mutation advances its predicate revision and event sequence in the same transaction, except `work.release`, which atomically replaces the stream with its tombstone. Empty `task.claimNext` and exact idempotent replay add no event or revision.
12. Snapshot followed by its cursor misses no committed work event; delivery replay is explicit and deduplicable.
13. A slow consumer cannot advance a cursor before its output drains.
14. Work output remains within its byte, page, depth, count, string, and retention bounds and reports every omission.
15. Task text, dependency results, signals, and model judgments are untrusted data and cannot widen authority.
16. Public or cloud output contains no provider credential, raw provider ID, raw reasoning, approval secret, arbitrary tool output, absolute path, environment value, or plaintext ciphertext payload.
17. A non-custodian or revoked device cannot dispatch, renew, settle, review as another session, or answer a local interaction.
18. Explicit tasks assigned to two accounts may run concurrently, while neither account is a fallback for the other.
19. Completion requires accepted structured evidence under the declared gates; provider terminal status alone is insufficient.
20. A compact fixture proves `work poll` can coordinate a bounded fanout without fetching every session independently.
21. Failure and cancellation preserve completed tasks, accepted submissions, reviews, evidence, receipts, and prior events.
22. No SQLite writer transaction spans a Codex call, artifact hash, Git subprocess, or other external effect.
23. Delayed reconciliation uses the exact bound turn's recorded completion time, not the reconciliation wall clock.
24. Failure and cancellation preserve accepted prefixes. Explicit release requires terminal coordinator authority and data-loss acknowledgement, blocks unresolved attempt dispatch, counts discarded ambiguous signals, and leaves only its bounded replay tombstone.
25. A task-history continuation freezes membership and every returned public record at one signed cut; later mutations cannot rewrite, duplicate, skip, or reorder a continued page.
26. Snapshot, task detail, and task history remain within their 512 KiB serialized UTF-8 ceilings by trimming only explicitly counted recent or historical arrays.

## Capability matrix

| Capability | Initial status | Boundary |
| --- | --- | --- |
| Local work and task graph | Supported | Bounded acyclic graph in canonical local SQLite |
| Derived readiness | Supported | Computed from work state, timing, accepted dependencies, and attempt authority |
| Exact account routing | Supported | Route resolves to one account and project; no implicit fallback |
| Atomic claim and claim-next | Supported | Local compare-and-swap with monotonic task fence |
| Atomic fanout admission | Supported | All attempts reserved or none; provider execution remains independent |
| Codex session dispatch | Supported | Binds one already-existing exact actor session and reuses journaled HRA turn start under its account generation |
| Attempt renewal and recovery | Supported | Exact actor, fence, revision, lease, and effect reconciliation |
| Structured submission and review | Supported | Bounded schemas, immutable evidence references, independent review where required |
| Joined-participant signals | Supported | Capability-scoped work mailbox; optional delivery through existing queue or steer |
| Work snapshot and event stream | Supported | One SQLite snapshot and work-scoped signed cursor with at-least-once JSONL |
| Fixed-cut task history | Supported | Detail is separate; signed pages retain immutable membership and public record versions as of one stream cut |
| Destructive work-history release | Supported | Terminal coordinator compare-and-swap plus explicit data-loss acknowledgement and separately bounded replay tombstone |
| Bounded work wait | Conditional | Only predicates with transactionally complete revision and lost-wake proof |
| Not-before time and deadline | Supported | Daemon clock locally; no claim based solely on another device's wall clock |
| Recurring schedule or autonomous wake | Deferred | Requires durable tick identity, coalescing, and transactionally complete wake revision |
| Token or quota budget enforcement | Observational | HRA reports provider observations; it does not pool subscriptions or invent reserved provider quota |
| Encrypted multi-device projection | Conditional | Extends existing Convex projection after local correctness; local authority remains complete |
| Remote work command submission | Conditional | Routed to exact execution custodian through existing encrypted command authority |
| Cross-device task claim or provider takeover | Unavailable | One machine remains the fenced session executor |
| Automatic account rotation or provider failover | Unavailable | A differently routed objective requires explicitly declared work |
| Turso storage or synchronization | Unavailable | Deferred behind the store seam and a concrete replacement use case |
| Generic executable workflow code | Unavailable | Tasks are declarative; Codex owns execution |
| Human coordination UI | Unavailable | Coordination is a bounded JSON and JSONL protocol for agents |
