# Changelog

Every entry names the release or the plan wave it belongs to. Unreleased work sits under the wave that produced it until a version ships.

## v0.5.0

HRA Web v1 wave 3: interaction detail, wider remote decisions, subagent activity, the Claude Code provider seam, and device commands. Admitted by the immutable release workflow on 2026-09-04.

- The compact `interaction_state` event gains a versioned optional detail block: label, headline, redacted markdown detail, command class, the decisions the provider actually offered, and for a question an id, label, and secret flag each. Every field is bounded and re-checked by the parser, the emitter drops the whole block rather than projecting anything unsafe, and a detail-free event digests exactly as it did before.
- Remote decisions widen. Beyond command approvals and file-change declines, the daemon accepts a decision on a permission approval whose requested categories it re-verifies as workspace-only, and answers to a question set that carries no secret, including a plain-text MCP form. Each remaining refusal keeps its own code, and the browser panel renders the detail and offers a control only where the daemon would accept it.
- The pinned Codex runtime moves from 0.149.0 to 0.153.2, the newest exact release. Six added `ServerNotification` methods are reviewed and discarded (`mcpServer/event/stream/notification`, both `modelProvider/authRecovery*`, and three `thread/realtime/item/*`), three generated schema digests and both reviewed matrix digests are re-pinned, and no method was removed.
- Subagent activity is visible. Codex reports a spawned subagent through a `subAgentActivity` thread item on the parent thread rather than through any notification, so HRA projects `subagent_activity` session events (`started`, `interacted`, `interrupted`, `completed`) from that item, and reduces the start of a spawned subagent thread to the same event when it carries a nickname, role, or depth. The agent identity is the same opaque provider identifier every other id uses, labels are bounded to 120 bytes and stripped of paths, control scalars, and secret shapes, and the agent definition path Codex supplies is never retained. Open subagents keep a finished turn classified as working, and the live uploader carries the events onto the hosted `detail` stream for the session grid.
- The runtime port has a provider-neutral seam. `SessionRuntimePort` carries everything a session needs to exist, take turns, be steered, be stopped, and answer a brokered interaction; `CodexRuntimePort` and the new `ClaudeRuntimePort` are its two implementations, each parameterised by the runtime profile document its provider proves. Nothing about the Codex path changed shape.
- `src/claude/` speaks the pinned Claude Code stream-json dialect: one exact pinned version, its exact Fable model id, a reviewed event matrix with digests that fail closed on drift, a bounded JSONL decoder, a parser that reads every line from `unknown`, and a delta assembler that owns turn, item, and subagent identity. The bridge knows the dialect; the runtime knows the timeline.
- The Claude adapter spawns the pinned binary with `--output-format stream-json --input-format stream-json --verbose` under an isolated absolute `CLAUDE_CONFIG_DIR` and the same environment allowlist Codex uses. HRA never reads, copies, or forwards a Claude credential.
- `can_use_tool` becomes a durable HRA interaction: `Bash` a command approval, `Edit`, `Write`, and `NotebookEdit` a file-change approval, everything else a permission approval, and `AskUserQuestion` (or any request the runtime marks as needing a person) a question. An allow echoes only the request's own input and never a persistent-allow rule, so HRA can grant nothing beyond `once`. Steering writes another `user` line mid-turn; stopping writes an interrupt.
- `system/task_started`, `task_progress`, `task_updated`, `task_notification`, and `parent_tool_use_id` become `subagent_activity` session events carrying only a bounded nickname, role, depth, and last status. A subagent's own message never enters the parent transcript.
- The model preset union gains `fable-max`, the local Fable model at `max` reasoning effort and never `ultracode`. A preset the session's provider cannot run is refused with a clear message, never silently ignored. Adding a preset widens the encrypted compact projection format: the parser tolerates a newer writer's unknown keys but never an unknown enum value, so a reader older than this build rejects a chunk whose `turn_summary.model` names `fable-max`.
- A session records its provider. `hra session start --provider claude` is accepted and validated, and defaults its preset to `fable-max`; without the flag every existing path is byte-identical Codex behaviour. Store schema version 32 adds the column additively with a `codex` default.
- Claude sessions run. The durable session-start, turn-start, and queue-dispatch evidence now carries either provider's reviewed profile: the two documents are stored exactly as their provider reviewed them, so every Codex row and receipt written before this change still parses and re-serialises byte for byte and no schema version was needed. The daemon routes session start, turn start, steering, interrupt, and interaction resolution to the port the session's own provider binds, and the Claude bridge's facts are reduced to the one neutral fact vocabulary the timeline already speaks. A Claude session therefore produces the same transcript events, durable approvals and questions, turn summaries, session-state classification, compact cloud projection, and live `detail` stream as a Codex one. Listing provider threads, renaming one, and protected turn inspection stay Codex-only and are refused by name. With no admitted `claude` binary, `hra session start --provider claude` fails with one message naming the exact pinned release to install.
- Device commands reach a daemon without a session lease. A device-indexed `deviceCommands` table, fenced by the target daemon's boot authority, carries `session_start` (start then send under one idempotency key, with the ambiguous case quarantined), `account_login_start`, `account_login_status`, and `usage_refresh`. Guards: a per-device kill switch, a per-day cap, account and project addressing that accepts only registry public ids, project-inherited approval mode, a first-use notice, and account linking that stays off until it is allowed locally. The relayed login URL is account-key encrypted, single use, and short lived. Store schema version 33 adds the local rows additively.
- `hra remote allow|deny device-commands|account-linking` and `hra remote policy` set and report those switches locally, so nothing hosted can grant itself device commands or account linking. The browser grid's composer starts a real session through them, with account and project pickers.
- Hosted sign-up is open. The production authority admits a new identity without an invitation, and the public copy states an open beta from its one wording constant.

## v0.4.1

Patch release for the local state schema migration. Admitted 2026-09-04 as immutable GitHub Release `v0.4.1` and npm `latest`.

- Installing a newer build over an existing install no longer deadlocks the daemon. `hra daemon start` and `hra daemon run` prove initialization with a read-only store open, which refuses a schema difference rather than migrating it, and nothing in the product ever migrated the store. The daemon path now classifies that refusal, opens the store writable exactly once under its own locking and scrub rules, and repeats the read-only proof.
- A status read never migrates. It fails with both schema versions named and `hra daemon start` as its next command, and a store written by a newer build stays a hard refusal that names both versions and asks for the newer HRA.
- `hra doctor --offline` reports a pending migration and a newer on-disk schema by name instead of the opaque local-database line, and appends the short `STATE_...` code of any other named local state failure. It still prints no path and no stack.

## v0.4.0

HRA Web v1 waves 1 and 2: live session projection, session state, autorespond, remote decisions, and the browser client. Admitted 2026-09-04 as immutable GitHub Release `v0.4.0` and npm `latest`.

Daemon and CLI:

- The daemon streams the running turn to the hosted `detail` stream: turn starts, coalesced assistant deltas, reasoning summary deltas only where show-thinking is enabled for that session, subagent activity, and session state. Batches flush at one second or 8 KiB and again when the turn completes, and redaction carries a 256-byte window across batches so a secret split across two batches is still seen whole.
- A lexical classifier decides who must act next and how a turn ended. Human-action cues are evaluated before approval cues, so a login prompt or a code from email never reads as consent. `hra session state` reads the persisted result.
- Autorespond accepts freshly admitted command, file-change, and permission approvals at once scope through the ordinary resolve path. `hra autorespond on|workspace|off|default|status` sets `auto:all` (the default), `auto:workspace`, or `manual` per session or daemon-wide. Every attempt leaves an evidence row, and a consecutive counter that only a human message resets, plus hourly and daily budgets, escalate rather than continue.
- A turn that ends asking for approval in prose, with no protocol interaction to resolve, can be answered through a gateway key held in the daemon's generational secret custody. `hra autorespond gateway set|clear` manages it and status reports only whether it is configured. A verbatim ask sends a byte-exact substring of the message or escalates; every other admitted case sends one fixed sentence.
- `hra remote resolve` and `hra remote send --or-steer` carry a decision from another enrolled device. The custodian verifies that the interaction exists, belongs to the session, is pending at the requested revision, is inside its deadline, and offers that decision; it refuses secret answers and session-scope grants, and honours decisions only from active requesting devices.
- The daemon wakes its sync cycle from a websocket subscription to its pending commands instead of waiting for the next poll, and the poll cadence adapts: one second while a peer device is present or a local turn is running, fifteen seconds idle. `hra sync status` reports it.
- Devices carry a class, `daemon` or `browser`, and a key fingerprint over both canonical public keys. Device listings show the fingerprint and `hra device approve --fingerprint` requires it. A browser device is refused as a first device, refused administration, and refused every daemon-owned write.
- Each device publishes an encrypted registry projection: machine label, daemon version, daemon defaults, accounts and projects by label, scheduled tasks as read-only rows, and whether prose autorespond is configured. Hosted command kinds now also set the approval mode, show-thinking, and default preset, archive or rename a session, and set the gateway key.
- `hra session archive` and `hra session unarchive` move a finished session out of the default listing, which `--archived` still shows. Store schema version 31 migrates additively.

Browser client:

- `app/` holds a Vite, React 19, Tailwind v4 browser client, gated by `bun run lint`, `bun run typecheck`, `bun test ./app`, and `bun run build:app` inside `bun run check`. It ships as a separate Vercel project on its own origin with the wave 1 Content Security Policy, and a test asserts the built bundle sets no style attribute, references no service worker, calls no `eval`, and names no origin outside the pinned Convex deployment.
- Authentication tokens live in an in-memory storage adapter rather than `localStorage`, so a closed tab leaves no refresh token behind.
- A browser enrolls as an ordinary device: non-extractable P-256 signing and wrapping key pairs held in IndexedDB, a displayed key fingerprint to compare before `hra device approve`, and the account key unwrapped into memory only. The key is dropped on a fifteen-minute idle, on `Ctrl+L`, on page hide, and on the first authority refusal from the control plane.
- The client decrypts the compact history and subscribes to the live `detail` tail, keyed by the detail stream epoch, and submits `send_or_steer` bound to the session's current custodian device.
- A session grid, a session view with sanitised streaming markdown and an interaction panel, and a settings screen for machines, defaults, archived sessions, scheduled tasks, accounts, and devices. Hosted sign-up stays invite-only in this release.

## v0.3.0

Conversation-bound scheduled tasks and hosted sign-in mail. Release candidate until the release workflow admits the tag.

- `hra session task` creates, inspects, edits, pauses, resumes, and deletes recurring interval tasks. Tasks carry durable revisions and replay receipts, accept intervals from 15 minutes through 7 days, and are capped at 32 per conversation.
- New HRA-created Codex conversations expose `hra.automation_update`. The tool is bound to the exact provider thread and profile generation, and cannot retarget a session, project, model, or environment. Existing conversations remain manageable through the CLI without being retrofitted.
- Due tasks enter the durable session queue transactionally. Missed intervals coalesce, and restart, collision, generation, and concurrency fences prevent duplicate dispatch.
- Scheduled prompts stay local and are omitted from cloud projections. Existing approval, question, permission, MCP, and plugin flows retain their established boundaries.
- Hosted sign-in verification email now uses the production HRA sender and pinned authentication subdomain.

## v0.2.1

Patch release for the hosted beta. Admitted 2026-09-03 as immutable GitHub Release `v0.2.1` and npm `latest`.

- The cloud transport no longer presents an expired access token to Convex. The daemon refreshes tokens lazily, and Convex rejects an expired bearer token even on the refresh-token sign-in that replaces it, so after fifteen idle minutes every hosted command failed with `INTERNAL` until a fresh login. The transport now reads the token's `exp` claim for this decision only and proceeds unauthenticated when it has passed.
- The hosted identity marker at `/.well-known/hra.json` keeps its fixed release-evidence version (`0.1.0`), which the canonical-alias operator proves after every cutover; wave 0 had switched it to the package version, which made the first v0.2.0 cutover proof fail.

## v0.2.0

HRA v2 wave 0. Admitted 2026-09-03 as immutable GitHub Release `v0.2.0` and npm `latest`.

Robustness and security:

- The local daemon transport partitions its 32 connection slots into 16 for commands and 16 for long polls, answers an exhausted pool with a closed `UNAVAILABLE` failure instead of an indeterminate close, and bounds frame receipt and idle drain with separate timeouts. `hra daemon status --json` reports slot occupancy.
- Read-only opens such as `hra status` no longer run a full foreign-key scan, and the queue secure-delete checkpoint retries with backoff before it can stop the daemon.
- `account login-cancel` is recorded in the mutation ledger before dispatch and reconciled from the account read after a restart. A determinate provider rejection during daemon fence loss is recorded as failed rather than stranded.
- The usage poller and background schedulers surface closed diagnostics instead of failing silently; the daemon publishes a failed receipt on an unhandled rejection.
- One-time login codes are compared in constant time. The daemon and the session-note editor receive an allowlisted environment. Convex response bodies are byte-bounded. Each account key version has an AES-GCM message budget that fails closed with `KEY_ROTATION_REQUIRED`. Redaction covers more unlabelled secret shapes.
- A per-directory import boundary lint enforces the domain to storage to daemon to adapter layering, and a check refuses file-level import cycles under `src/`.

CLI:

- `hra --json work protocol` works before `hra init` and without a daemon.
- `hra help [group [command]]` and leaf-level `--help`; `--json` output for `help` and `version`; an unhealthy `doctor` result now returns `ok: false` with `error.code: "UNHEALTHY"` alongside its data.

Release and site:

- `bun run install-pins:update` re-pins the installer's embedded CLI and normalizer digests between releases; the public command's digest is proven against the tagged runtime in the tag workflow instead of against the working tree.
- One `CODEX_PIN` constant and `bun run codex:bump` replace scattered Codex version literals; the account usage digest domain no longer changes when the pin changes.
- Retired release scripts are deleted, duplicate CI steps are removed, and the tag workflow reads back the tagged commit's successful CI run instead of rerunning the gate. A fail-closed local command verifies immutable owner identity, exact CI-green current `main`, monotonic version, and split tag rulesets before pushing one annotated tag; the redundant mutable npm approval variable is gone.
- The README leads with a thesis and badges, the social card is a build-time PNG, and public copy is checked for em dashes.

Plan:

- `kb/plans/hra-v2.md` proposes the provider-neutral, swarm-coordination, web-surface, and documentation plan; `kb/notes/web-ux.md` holds the browser UX contract.

## v0.1.6

The first admitted public local CLI release. See `docs/beta-release-notes.md`.
