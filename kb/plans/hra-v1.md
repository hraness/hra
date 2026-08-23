---
title: HRA v1
description: Release plan for an elegant persistent Codex control plane for humans and agents, with isolated accounts, durable interactions and event streams, device presence, historical usage metrics, encrypted multi-device sync, and safe desktop account switching.
type: plan
status: in-progress
area: hra
tags:
  - bun
  - cli
  - codex
  - convex
---

# HRA v1

## Outcome

HRA is a persistent Codex control plane for people and agents. Running `hra` in a terminal starts or attaches to the owner-private daemon, opens a line-oriented shell, and remains connected until the person exits. The same binary exposes bounded one-shot JSON and cursor-based JSONL commands, so an agent can inspect a session repeatedly, follow visible progress during a turn, and respond to an exact pending interaction without scraping terminal presentation.

HRA keeps several Codex subscriptions isolated on one device, records historical usage, derives honest token-velocity windows, supervises sessions, safely brokers Codex approvals and questions, reports enrolled-device presence, and optionally syncs encrypted projections and remote commands across devices. The supported desktop account switch remains an explicit journaled machine mutation.

The first beta is complete when a new user can install `hra`, link two Codex accounts, leave the daemon running, start and follow a session from the human shell or JSON interface, resolve an approval or question by exact interaction ID, inspect account usage history and device presence, control a session from a second enrolled device, switch the supported desktop application to a chosen account, and recover safely from terminal, process, network, and machine restarts.

## Main model

The public model has three first-class objects. Cloud login identity remains internal and separate.

- An **account** is one isolated Codex subscription profile. It owns a user label, provider identity observations, one supervised app-server generation at a time, capabilities, usage snapshots, and sessions. It never contains copied provider credentials.
- A **device** is one durable HRA installation enrolled under an HRA cloud identity. It owns a revocable credential, encryption-key status, last successful heartbeat, and sessions for which its daemon is execution custodian. A process is not a device. Registering a device does not grant decryption or execution authority.
- A **session** is an HRA projection of one provider thread, bound to one account and one execution-custodian device. It owns ordered turns, a durable safe event stream, pending interactions, user metadata, queues, recovery records, and an optional cloud execution lease.

An HRA cloud identity authenticates a person to the optional sync service. It may enroll devices but is never presented as a Codex account and does not imply possession of the encrypted workspace key.

## Product boundary

HRA owns:

- named local account profiles and one isolated `CODEX_HOME` per profile;
- one supervised Codex app-server generation per active profile;
- a local SQLite control plane, append-only safe event and metrics ledgers, mutation journal, device identity, and pathless cloud projection;
- typed pending interactions with exact provider request identity and compare-and-swap resolution;
- a persistent human shell and stable JSON and JSONL agent interfaces;
- user-facing presets, session names and notes, durable queues, remote commands, execution leases, and recovery;
- a verified-email HRA cloud identity, device presence, and client-side encrypted Convex sync;
- an explicit, journaled desktop application account switch;
- the CLI, website, package, and release contract.

Codex app-server owns:

- ChatGPT/Codex login, token refresh, logout, and provider credentials;
- provider thread, turn, item, approval, model, plugin, and transcript authority;
- account usage and rate-limit source data;
- permission and organization requirements.

The Convex deployment coordinates devices and encrypted projections. It is never required for local login, local execution, local recovery, or reading local Codex sessions.

## Release decisions

### Runtime

- Pin the official `@openai/codex` package and invoke it through Bun. Do not require a global Node or Codex installation.
- Use app-server JSONL over private stdio. Keep its method strings inside one exact-version adapter.
- Parse every response, notification, and server request from `unknown` into a closed HRA fact union generated or checked against the pinned package protocol.
- Run one daemon per OS user. The CLI talks to it through an owner-private Unix socket and a mode-0600 capability file.
- Bind every upstream request, event, interaction, login, turn, and receipt to `(profileId, processGeneration)`.
- Keep Bun and TypeScript. The existing authority engine has roughly 50,000 lines of tested storage, recovery, sync, and process-fencing behavior. This daemon is I/O-bound, so a Zig rewrite would add migration risk without solving a measured runtime bottleneck. Borrow the useful `fx` patterns: a typed event log, exact approval identities, protected terminal input, and strict separation between interactive and noninteractive modes.

### Human and agent interfaces

- `hra` with no arguments on a TTY starts or attaches to the daemon, opens a line-oriented shell, and stays connected until `exit`, `quit`, or end-of-file. It is not a full-screen terminal UI. Non-slash input sends a message to the selected session; `//text` or `/send text` sends a message beginning with `/`; other slash commands select accounts, devices, sessions, views, and interactions.
- `hra` with no arguments on a non-TTY prints bounded help and exits successfully. It never consumes stdin as a prompt or grants authority implicitly.
- Existing one-shot commands remain composable. `--json` emits one versioned value on stdout. `--jsonl` emits only versioned event envelopes on stdout. Diagnostics and interactive prompts use stderr or the foreground TTY.
- Agents inspect a session through an atomic snapshot plus opaque versioned cursor and then request events after that cursor. The cursor binds session ID, stream epoch, and sequence and is validated as an indivisible value. `session events --wait-ms` provides bounded long polling; `session watch` reconnects internally and prints ordered JSONL. Delivery is monotonic and at least once across pipe or process failure; consumers deduplicate by cursor. A retained page contains no duplicates. A retention, rebuild, restore, or provider-connection gap is typed and never silent.
- Human rendering coalesces small deltas without changing the durable cursor. JSON clients receive the bounded closed event variants and do not parse ANSI presentation.
- A TTY proves only local terminal attachment, not a particular human. The shell never resolves an interaction merely because it is attached. Each response requires the exact interaction ID, kind, and current revision; concurrent shells may inspect the same prompt, but only one compare-and-swap response can win and every stale response fails before provider transport. TTY presence alone grants nothing.
- Secret-bearing commands accept only one explicit bounded input channel: `--input-fd <n>` or `--input-stdin`. They are mutually exclusive. Noninteractive mode consumes stdin only when requested and never prompts. OTPs, invite capabilities, secret question answers, elicitation content that may contain secrets, and similar values never appear in argv.

### Codex events and interactions

- The daemon is the sole app-server subscriber. It translates provider delivery into an append-only HRA event stream with one random stream epoch and a monotonic per-session sequence. App-server notifications have no replay cursor, so disconnect records a gap before any resumed reconciliation events. A database rebuild or restore rotates the stream epoch.
- Store only safe public events: connection and session state, turn start and terminal state, item lifecycle, assistant display deltas, provider-visible reasoning-summary deltas, sanitized tool kind/status and output-byte counts, safe file and Git metadata, plan status, diff counts, token-usage updates, warnings, errors, interactions, and gaps. Raw command output, command arguments, patch content, arbitrary MCP arguments/results, and unbounded paths are not durable event bodies.
- Never persist or relay raw reasoning text, hidden chain of thought, secret question answers, credentials, environment variables, arbitrary unbounded command output, or raw provider payloads.
- Generate an exhaustive matrix from the pinned `ServerRequest` union. Classify every method as `brokered_interaction`, `internal_host_service`, or `unsupported`. Command approval, file-change approval, permission approval, user input, and MCP elicitation are brokered. Dynamic tool hosting, auth-token refresh, attestation, and every legacy request are handled internally only when HRA advertises that host capability. Every unsupported request receives one prompt typed JSON-RPC failure plus a safe protocol event. A protocol schema digest mismatch fails initialization.
- Every brokered request becomes one typed durable interaction with a public HRA ID and private exact authority: account generation, connection ID, tagged JSON-RPC request ID, method, canonical request-payload digest, nullable thread/turn/item/approval context, and revision. Numeric request ID `1` is distinct from string request ID `"1"`. Same-ID replay is idempotent only when method, digest, and context match; mismatch quarantines that connection.
- Resolution is a write-ahead state machine: `pending`, `response_prepared`, `response_written`, `resolved`, `declined`, `canceled`, `expired`, or `resolution_unknown`. Persist the canonical response digest before transport and record the byte-write boundary. A crash after a possible write never becomes expired and never retries blindly. Provider resolution, terminal turn, timeout, local dispatch, disconnect, and process restart race through one compare-and-swap authority.
- Exact request replay is accepted only on the same live app-server process and transport after `thread/resume` or re-subscription. It reconciles prepared, written, or unknown resolutions without sending a changed response. Private-stdio EOF or child exit increments the process generation before another transport can answer, moves possibly written callbacks to `resolution_unknown`, expires requests proved unsent, resumes and reads the thread, and records a stream gap. HRA never responds to a request from a stale generation.
- Blocking provider callbacks are always brokered into durable pending interactions. The turn lane waits without blocking event reads or other sessions. A local shell or agent can inspect them, while only an exact kind-valid revisioned response reaches the provider. Remote cloud clients can observe encrypted pending-interaction metadata in v1 but cannot resolve a provider callback until an exact remote-interaction command protocol is separately added and proved.
- Ordinary messages, model output, and free-form shell text never grant approval. Permission grants must be a subset of the requested profile and preserve their requested turn or session scope.
- Plugin installation, plugin enablement, app authorization, MCP OAuth, and a tool's side-effect approval are separate upstream effects. Pinned Codex 0.149 exposes safe `plugin/list` discovery but no safely separated install, enable, disable, or OAuth methods. Its install path is a compound effect that enables the plugin and may then begin browser OAuth. HRA therefore exposes only `plugin list` and `plugin show` in this beta and rejects lifecycle commands at the parser boundary. No HRA path opens a browser or changes plugin authority.

Each event page is one transactionally coherent object containing the requested cursor, retention floor, observed-through cursor, ordered events, typed gap metadata, and next cursor. Waiting uses transaction read, waiter registration, transaction recheck, then bounded await, so an append between read and sleep is observed. V1 constants are 200 events or 512 KiB per page, 64 KiB per event, and a 30-second maximum wait. Retention keeps only the newest 50,000 events that are no older than seven days and fit, newest first, within 64 MiB per session. Append and maintenance evict the oldest rows until all three ceilings hold, record the exact crossed ceiling in floor gap metadata, and apply count, age, then byte precedence when several boundaries coincide.

### Accounts and usage

- Create one user-only profile directory per Codex account. Let app-server perform managed ChatGPT browser or device-code login inside that profile.
- Never read, parse, copy, export, or sync `auth.json`. Never put provider tokens in argv, logs, SQLite, Convex, JSON output, or receipts.
- Read provider identity through `account/read`, quota through `account/rateLimits/read`, and token statistics through `account/usage/read`.
- Poll only while the daemon is active and on explicit `usage refresh`. Stagger account polls around a 60-second target interval with deterministic per-account jitter from 50 through 70 seconds and exponential backoff capped at 15 minutes. Record source time, observed time, provider generation, digest, freshness, reset detection, and failure state with each snapshot.
- The pinned `account/usage/read` response contains nullable `summary.lifetimeTokens`, `peakDailyTokens`, `longestRunningTurnSec`, `currentStreakDays`, `longestStreakDays`, nullable daily `{startDate,tokens}` buckets, and optional requested-thread usage. Only `lifetimeTokens` is eligible as a monotonic account counter. Treat `thread/tokenUsage/updated` as separate real-time session telemetry.
- Call the account metric `observed account token velocity`. Derive 1-, 5-, and 15-minute values only from consecutive `lifetimeTokens` observations with the same local profile, verified provider-account fingerprint, usage epoch, pinned schema digest, and counter name. The daemon allocates a durable per-profile source sequence from SQLite; wall time is not a revision.
- Use provider source time when present and local receive time otherwise, marking which clock applies and never mixing clocks in one rate. For a trailing window `W`, select the comparable earlier sample whose actual elapsed time from the latest sample is closest to `W`, breaking ties toward the earlier sample. It is eligible only when elapsed time is from `0.8W` through `1.2W` inclusive and every consecutive sample gap in that interval is at most 90 seconds. Divide the exact counter delta by actual elapsed seconds. A negative delta, provider-account change, schema change, usage-epoch change, duplicate or reversed timestamp, daemon downtime, stale gap, missing counter, or unknown session produces a typed `unavailable` reason. Do not interpolate across a gap or combine account polling with session-event totals.
- Keep profile labels user-owned. Provider email is local-only by default and encrypted if the user elects to sync it.
- Multiple accounts are independent subscriptions, not a pooled quota. A provider limit ends the current effect and is never replayed automatically under another profile.
- Keep the v1 metrics authority in the existing local SQLite ledger and encrypted bounded Convex projection. Define a repository/export seam for future analytics. Do not introduce Turso as a second replication authority until a concrete server-side query consumer, retention policy, and credential boundary require it.

### Session controls

- List and page threads through app-server. Read condensed history from bounded thread and turn projections. Load full supported item detail only for an explicit `turn inspect`.
- Default condensed output includes user messages, final assistant messages, elapsed turn time, observed model and tier, and bounded observed file or Git actions when the provider emitted them.
- Full detail and live events never expose hidden chain of thought. They may include provider-visible reasoning summaries, safe tool lifecycle and bounded progress, commands, edits, Git items, timing, interactions, usage, and terminal status.
- `send` starts a turn only when no turn is active. `queue` records one durable future user turn. `steer` requires the exact active turn ID. `stop` uses `turn/interrupt`.
- Queue dispatch is serialized per session. A lost `turn/start` or `turn/steer` response reconciles by the exact client message ID before any explicit retry.
- `rename` writes the provider thread name and updates the encrypted projection. One HRA note per session is encrypted metadata and is never injected into the provider thread.
- Changing a project or directory affects future turns only. Canonicalize the selected root and show it before the first provider mutation.

### Presets and permissions

Resolve models and capabilities from the exact account generation before each first use. User-facing aliases compile to:

| Alias | Requested profile |
| --- | --- |
| `low` | Luna, maximum supported reasoning |
| `high` | Sol, maximum supported reasoning |
| `ultra` | Sol, Ultra reasoning effort |

The adapter must discover the current model IDs, effort values, collaboration modes, permission profiles, plugins, and Fast support. An unavailable alias fails closed with the advertised alternatives. It never silently changes quality.

Fast is a per-turn overlay. `fast on` sends the exact advertised Fast tier. `fast off` sends the explicit Standard value so a prior Fast turn cannot leak into a continuation.

The recommended beta permission policy is opt-in during `hra init`:

- use the closest supported automatic approval-review profile rather than a blanket callback that approves unknown requests;
- enable computer use only when the exact model and permission profile advertise it;
- make the canonical Documents directory the default readable project root;
- enumerate installed and available plugins and apps while keeping every unavailable plugin lifecycle effect closed;
- display the effective provider settings with each session.

### Projects

A project is a named canonical directory, not a Git repository. It may contain several repositories. The default project is the user's Documents directory after explicit first-run confirmation. Commands may create a named project, select one, change a session's future directory, and inspect the effective readable and writable roots.

### Desktop application switching

`hra account switch <account>` is an explicit machine mutation with one global lock. It must:

1. prove the exact supported desktop application and current profile authority;
2. refuse while any affected login, turn, approval, or prior switch is unresolved;
3. write a pre-effect journal with source and target generations;
4. request graceful quit from the exact application process and wait for descendant quiescence;
5. switch only through a proved full-profile or `CODEX_HOME` launch boundary, never by copying one token or modifying Keychain blindly;
6. relaunch the exact bundle with the selected profile authority;
7. verify the active account through a read-only account call;
8. settle success or retain an actionable recovery record.

An uncertain quit, profile transition, or relaunch is `recovery_required`. HRA does not guess, delete the source profile, or retry the switch automatically.

### Cloud identity and encryption

- HRA cloud identity is separate from every Codex account.
- Sign-in uses one Convex verified-email code flow. Store only bounded challenge state and a hashed verifier. Codes are one-time, expire, and consume an account plus global rate-limit budget.
- Device bootstrap is a closed transactional state machine: identity with zero devices, one first-device bootstrap claim, registered pending, approved without key receipt, active keyed, revoked, or identity deleted. Simultaneous first registrations create exactly one bootstrap device; every loser becomes pending or receives the existing exact result. Registration is not pairing and grants neither ciphertext reads nor session execution authority.
- Successful sign-in authenticates the HRA identity. The daemon automatically registers this installation if it has no server-side device record. The first bootstrap device generates the client-side workspace encryption key and becomes active. A later registered device remains pending until an active device runs `hra device approve <device>`, after which the new device retrieves and unwraps its key envelope. Email access alone cannot decrypt synced session content. Losing every active key holder makes existing encrypted content unrecoverable in v1.
- Store the revocable device credential in the OS credential store with a mode-0600 file fallback that preserves generation and recovery evidence.
- While the authenticated daemon runs, it sends a staggered heartbeat around every 15 seconds. Heartbeats are fenced by device generation, random connection nonce, and monotonic connection counter, use server time, and never change pairing revision. Exact replay is idempotent without extending TTL; stale, gapped, or competing-connection updates fail. A copied bearer credential cannot establish a second concurrent connection or bypass generation fencing, rotation, or revocation. Possession of an otherwise unrevoked credential can impersonate that device until detected or rotated because v1 has no hardware-bound proof. A revoked device can never heartbeat itself active.
- A device is `online` only when the server has accepted a heartbeat within a 45-second TTL. Shell attachment does not define presence. Daemon stop, credential failure, or TTL expiry makes the device offline without inventing a disconnect event.
- Every public Convex read, heartbeat, pairing, lease, command, and write reloads current identity epoch and device status. Pending devices may read only their own registration and presence status. They cannot read ciphertext, key envelopes for another device, commands, accounts, sessions, leases, or execution state.
- Authenticated account deletion first revokes the identity epoch and all device effects, then incrementally erases every owned record with visible progress until complete. An abandoned unverified identity expires automatically. Per-user and per-record-class quotas reject writes before aggregate storage exceeds the published limit.
- Maintenance uses fair per-category cursors and bounded work, not one shared scan that can starve later categories. Each category gets 20 records per invocation under a hard 200-record transaction ceiling; the starting category rotates. Deletion and revocation have a reserved one-minute worker quantum. Device revocation is status-first and incrementally cleans an arbitrary number of records.
- Beta OTP issuance requires a purpose- and budget-scoped high-entropy invite capability supplied through the protected-input channel, plus per-address, mail-provider, and deployment cost budgets. Do not claim client-provided network or installation metadata as a trusted abuse boundary. A later public launch must name and verify a trusted edge/IP source before adding per-network policy.
- The server computes quota charges from canonical stored ciphertext and document fields plus published fixed overhead. Client-provided byte counts are ignored. A generated coverage test inventories every public Convex function against epoch/device authorization and every table against quota, retention, and erasure classification.

Encrypt before upload:

- user and assistant display text;
- session names and notes;
- turn timing, observed model and tier, and provider usage summaries;
- bounded observed file and Git metadata;
- queued messages, steering input, and remote-command results.

Never upload:

- Codex credentials or profile files;
- raw app-server requests or responses;
- raw reasoning or hidden chain of thought;
- approval secrets, environment variables, arbitrary command output, or unbounded filesystem paths;
- plugin credentials or OAuth material.

### Multi-machine authority

- One device owns an expiring, renewable execution lease for each provider session.
- Other enrolled devices may read encrypted projections and submit encrypted send, queue, steer, stop, model, and Fast commands. Session names and notes sync as encrypted metadata but are not remotely executed commands in v1. Project directories remain local-only and are neither synced nor remotely changed.
- The owning daemon claims a command by exact lease generation and idempotency key, performs or reconciles it locally, then records a terminal result.
- Remote command states are `pending`, `claimed`, `applied`, `rejected`, `failed`, `expired`, or `canceled`.
- An offline owner leaves commands pending. A second device never resumes the provider thread locally in v1.
- Cross-machine provider-session takeover is excluded until a separately proved migration protocol exists.

## CLI contract

Human output is concise and readable aloud. `--json` returns one versioned object. `--jsonl` returns one versioned event per line. Stdout is data; stderr is diagnostics. A noninteractive command never prompts, opens a browser, or interprets text as approval. Provider, cloud, and desktop effects accept or generate an idempotency key.

```text
hra
hra init [--yes] [--json]
hra doctor [--offline] [--json]

hra auth login --input-fd <n>|--input-stdin
hra auth status|logout
hra auth delete --acknowledge-erasure

hra device list|pair
hra device approve|revoke <device-id-or-prefix>

hra account add <label>
hra account login <account> [--device-code]
hra account logout <account>
hra account list
hra account show <account>
hra account usage [account] [--refresh]
hra account switch <account>
hra account switch-recover

hra project add|list|use

hra session list|show|status|start|send|queue|steer|stop
hra session events <session> [--cursor <opaque>] [--wait-ms <0..30000>] [--limit <1..200>] [--json]
hra session events <session> [--cursor <opaque>] [--limit <1..200>] [--wait-ms <1..30000>] --follow
hra session interactions <session> [--pending]
hra session rename <session> <name>
hra session note get|set|edit|clear <session>
hra session preset <session> <low|high|ultra>
hra session fast <session> <on|off>
hra session project <session> <project>
hra session recover|abandon <session>
hra turn inspect <session> <turn> [--json]

hra interaction list|show <interaction>
hra interaction decide <interaction> --revision <n> --decision <once|session|decline|cancel>
hra interaction grant <interaction> --revision <n> [--scope <turn|session>] [--input-fd <n>|--input-stdin]
hra interaction answer <interaction> --revision <n> [--input-fd <n>|--input-stdin]
hra interaction submit <interaction> --revision <n> --action <accept|decline|cancel> [--input-fd <n>|--input-stdin]

hra plugin list <account> [--project <project>] [--refresh]
hra plugin show <account> <plugin> [--project <project>] [--refresh]

hra remote list|show|command
hra remote send|queue|steer|interrupt
hra remote preset <cloud-session> <low|high|ultra>
hra remote fast <cloud-session> <on|off>

hra sync status|now
hra sync projection recover <session> --acknowledge-gap [--idempotency-key <uuidv7>]
hra daemon start|status|stop|run
```

`auth login` reads one exact protected JSON document: `{ "email": "person@example.com" }` requests a code for an existing identity, `{ "email": "person@example.com", "invite": "hra_invite_identity_v1_…" }` requests first admission, and `{ "email": "person@example.com", "code": "01234567" }` verifies. Email, invite, and code flags do not exist.

Selectors accept an exact ID or an unambiguous case-insensitive label. Ambiguity lists safe candidates and performs no effect. An interaction mutation always requires its exact public ID and current revision. The protected input is a single bounded JSON document whose schema depends on the command; the daemon reads at most 64 KiB, rejects trailing data, and zeroes the in-process buffer after dispatch where the runtime permits. Secret user-input answers are read with no echo in the shell or through the explicit protected input channel. They are rejected in argv and never echoed, logged, synced, cached, or recorded in history.

The shell uses the same typed service commands as one-shot mode. Shell-only conveniences such as `/account`, `/session`, `/events`, `/interactions`, `/approve`, `/decline`, `/answer`, `/interrupt`, `/help`, and `/exit` compile to those commands. A protected interaction pauses only the session's mutation lane, not event observation or other sessions.

## Local state

Use SQLite for control-plane authority and append-only receipts. Minimum owned entities:

- schema migration and daemon generation;
- profiles and process generations;
- projects and canonical roots;
- sessions, provider bindings, selected preset, Fast value, note, and execution lease;
- turn summaries and bounded display items;
- per-session event streams with monotonic sequence, retention floor, safe event bodies, and explicit gap markers;
- typed interactions with private provider callback identity, public ID, revision, status, deadline, sanitized display, and terminal receipt;
- mutation attempts, queue entries, switch journal, and recovery records;
- HRA cloud identity namespaces, device generation, presence connection state, and encrypted-sync cursors;
- usage snapshots, upload cursor, freshness, reset and gap classification, and derived velocity windows.

Read the session snapshot and event cursor in one SQLite transaction so no event falls between them. Encode cursors as bounded opaque base64url tokens with schema version, session public ID, random stream epoch, and decimal sequence; sign them with the local daemon capability key so clients cannot forge fields. Event pagination exposes the floor and observed-through cursor atomically. The one-request local transport reserves at least 16 of its 32 connection slots for ordinary commands and admits at most 16 simultaneous long polls.

Bound event payloads and per-session retention by the published constants; advance the floor only by adding visible gap metadata. Coalesce deltas for display without changing stored order. Do not duplicate the provider's raw transcript store. Local projections are rebuildable from bounded app-server reads plus HRA-owned metadata and explicit gap evidence.

Namespace all cloud custody and projection state by cloud user public ID. A same-root A to B to A handoff closes the current lifecycle, selects another namespace, and preserves both identities' key, device, cache, journal, and recovery state. No cloud-identity operation may block local Codex accounts or sessions.

The new product's physical namespace is deliberately distinct from HRA v0 and from every prerelease development namespace: `~/Library/Application Support/HRA Control Plane v1` on macOS, `~/.local/state/hra-control-plane-v1` on Linux, Keychain service `sh.hra.control-plane.v1`, daemon protocol `hra-control-plane-local-v1`, and `hra-control-plane` cryptographic domain prefixes. HRA v0 retains its `OPRTE` Application Support root, `kitchen.hraness` bundle and credential services, and every historical compatibility identifier unchanged.

## Convex state

Minimum tables:

- invitation capabilities, verified-email challenges, purpose-separated rate-limit buckets, and abandoned-identity timestamps;
- users and revocable devices;
- device presence rows with fenced connection IDs, monotonic heartbeats, and TTL;
- device pairing requests and encrypted workspace-key envelopes;
- encrypted profile, usage, session, turn-summary, and note projections with monotonic revisions;
- session execution leases;
- encrypted remote commands with exact idempotency and lease binding;
- per-user and service quota ledgers charged transactionally by count and server-visible logical bytes;
- status-first device-revocation and account-deletion jobs with bounded category cursors and durable receipts;
- bounded fair-maintenance cursors, retention cursors, and tombstones.

All public functions parse strict input, enforce page, byte, aggregate, and replay limits, authorize the current identity and device state, and return provider-neutral values. Retention deletes only terminal expired records after their recovery window. Account deletion is the only operation allowed to erase immutable compact epochs, and it erases them rather than resetting or rewriting them.

The erasure and retention inventory is exhaustive and generated from the schema. It covers auth-library `users`, `authAccounts`, `authSessions`, `authRefreshTokens`, `authVerificationCodes`, `authVerifiers`, and `authRateLimits`; current HRA `authSubjects`, `authEmailAttemptEvents`, `authOtpChallenges`, `devices`, `deviceSessions`, `deviceBindChallenges`, `deviceKeyEnvelopes`, `recoveryEnvelopes`, `sessionHeads`, `sessionChunks`, `sessionStreamEpochs`, `executionLeases`, `sessionCommands`, `codexAccounts`, `deviceAccountBindings`, `accountUsageSnapshots`, `idempotencyReceipts`, and `securityEvents`; plus new `authInvites`, `devicePresence`, `accountDeletionJobs`, `accountDeletionReceipts`, `deviceRevocationJobs`, `storageUsageByUser`, `storageUsageService`, and `maintenanceState`. CI fails when a schema table has no owner key, quota class, retention rule, deletion order, and final disposition.

Published beta quota constants are 16 devices, 32 Codex accounts, 10,000 session heads, 250,000 encrypted session chunks, 100,000 usage snapshots per account, 256 nonterminal remote commands, and 2 GiB of server-visible logical bytes per user. The deployment ceiling is 500 identities and 100 GiB. Usage snapshots retain the newest 100,000 per account and no sample older than 90 days. Terminal commands retain 30 days after requester acknowledgement or 90 days without it. OTP, bind, receipt, security-event, and deletion-job windows are declared beside their schema constants and checked against this inventory. Replays charge zero; failed writes charge zero; inserts and deletes update count and byte ledgers in the same transaction.

## Repository and release contract

- Public repository: `hraness/hra`, numeric repository ID `1343008607` after the source repository is renamed in place.
- Bun package name and binary: `hra`. The beta install source is the tagged GitHub repository.
- License: MIT. Retain required notices for pinned dependencies and generated protocol material.
- One Bun 1.3.14 lockfile.
- Website: `hra.sh`, generated from the same content contract as `README.md`.
- The first website line after the product name is the real install command.
- Release artifacts include the source package, checksums, an SBOM, and generated changelog notes.
- CI runs lint, typecheck, unit, property, integration, secret-shape, package-content, static-site, and clean-install gates on macOS and Linux where the behavior is supported. Tagged releases add an SPDX dependency inventory and checksums.

The existing product currently at `hraness/hra` becomes HRA v0 without changing its runtime storage, Keychain, bundle, migration, deployment, or data identities. Before the new repository claims `hraness/hra`, publish a final v0 distribution-link update, then rename the old GitHub repository to `hraness/hra-v0`, old Vercel project ID `prj_eRfUBHdHkEbvIaB8x7dyyZhBc3wr` to `hra-v0`, and old Convex project ID `2680173` to name `HRA v0` and slug `hra-v0`. Preserve deployment ID `4677913`, immutable releases, tags, and data.

Rename the new GitHub repository ID `1343008607` from `hot-codex` to `hra` and Vercel project ID `prj_8ciIt9t9foE3utG45frRN7cxckjS` from `hot-codex` to `hra`. Create a fresh Convex project and production deployment for the new HRA. Never copy old HRA credentials, data, environment values, or provider URLs. Verify new HRA behind a noncanonical URL before atomically moving `hra.sh` inside the same Vercel team. Old HRA remains reachable at a verified v0 Vercel fallback.

GitHub redirects from the old `hraness/hra` repository cease when the new repository reuses that name. Before collision, audit and update every mutable old surface: default-branch docs, site links, repository metadata, package metadata, release-download helpers, security/contact paths, and the old Vercel site. Immutable artifacts and prior release bodies cannot all be rewritten, so the v0 fallback hosts a durable compatibility page mapping legacy tags and assets to `hraness/hra-v0` by exact version and commit.

The reversible window ends immediately before the first public new-HRA immutable tag or friend-facing install instruction. During staging, repository and project renames may be reversed after readback. Before crossing the commit point, prove old Convex project ID `2680173` still has deployment ID `4677913`, unchanged deployment URL and data, healthy v0 fallback, exact old tag origins, healthy staged new HRA, and a rehearsed domain-only rollback.

After the public commit point, repository names and immutable tags do not roll back. An incident response moves `hra.sh` and Vercel traffic to the healthy fallback, disables new hosted credentials and invitations, and publishes a fixed forward release under `hraness/hra`. Provider numeric IDs and readbacks, not names alone, remain the migration authority.

## Phases

### Phase 0: freeze and attack the revised contracts

- Record the pinned Codex 0.149 event and server-request schemas, `fx` interaction lessons, TypeScript decision, Turso deferral, HRA object model, CLI modes, external provider map, and rollback order in this plan.
- Review the plan adversarially for callback authority, stream gaps, secret input, usage reset math, device registration versus authority, cloud lifecycle, local identity handoff, provider namespace collisions, and rollback.
- Revise the plan before feature implementation. Keep provider mutations closed until the revised acceptance gates exist.

### Phase 1: local event and interaction authority

- Generate the exact notification and server-request matrices from the pinned protocol schema, record their digest, and reject initialization on mismatch. Replace blanket rejection with the classified interaction and internal-host broker.
- Add SQLite migrations and repositories for event streams, interactions, retention floors, atomic snapshot-plus-cursor, and current-generation callback fencing.
- Integrate safe live deltas, summary-only reasoning, write-ahead interaction response states, reconnect replay, provider-restart gaps, and deterministic unattended policy into session service recovery.
- Prove every pinned request variant reaches one prompt rejection, internal response, or durable interaction. Kill at each database, response-write, flush, resolution-notification, and reconnect boundary. Prove tagged request ID, method/digest/context, approval ID, revision, generation, cross-session, duplicate, replay, resolution-unknown, secret, and cancellation behavior.

### Phase 2: persistent shell and agent interface

- Rebrand the local product to HRA and introduce the new `hra` binary and clean HRA state/protocol/crypto namespaces without touching HRA v0 state.
- Implement the line shell, session selection, live coalesced rendering, durable protected-prompt queue, and terminal-safe secret input.
- Implement atomic status, bounded event long-poll, reconnecting JSONL follow, interaction inspection and kind-specific resolution, plus read-only plugin discovery with explicit lifecycle rejection.
- Prove TTY versus non-TTY behavior, protected input, clean stdout, stale-revision races across shells, append-at-every-wait-boundary, retention during pagination, partial stdout failure, database restore, foreign cursor rejection, slow readers, signal handling, daemon persistence, and parity between shell and one-shot service commands.

### Phase 3: historical metrics and device presence

- Add staggered account polling, ordered snapshot backlog upload, source/reset/gap classification, 1-, 5-, and 15-minute velocity, and session token telemetry.
- Namespace cloud custody by user public ID and add safe A to B to A local handoff.
- Add automatic registered-device creation, fenced heartbeats, server-time TTL presence, graceful disconnect, and offline degradation. Preserve pairing as the separate key-authority step.
- Prove hundreds of offline usage snapshots, source-sequence restart, provider-account and schema changes, clock skew and reset cases, simultaneous first registration, copied credential, heartbeat replay/reordering/competing connections/crash/expiry, revoke-versus-heartbeat or lease, and pending-device zero-data authority.

### Phase 4: hosted lifecycle and abuse resistance

- Add status-first account deletion with epoch revocation and incremental erasure, abandoned-unverified cleanup, status-first device revocation, fair bounded workers, category and total quotas, and invitation-gated OTP admission.
- Create the fresh deployment's quota authority exactly once before its first auth write, then enforce it on every public write. Reserve worker capacity for deletion and revocation rather than sharing one starvable maintenance budget.
- Prove more than 200 records per category, lost deletion response, crash and replay, concurrent writers, exact quota boundaries, fair progress, invitation abuse, forged client byte and network claims, generated public-function authorization coverage, and generated table-lifecycle coverage. Local HRA remains usable through every cloud failure.

### Phase 5: preserved features and integrated acceptance

- Re-run the existing profile, session, queue, compact projection, encrypted sync, remote command, desktop switch, package, privacy, site, and release suites after the HRA rebrand.
- Test the pinned real Codex application server with an isolated disposable account boundary for login, live events, a user question, a safe approval, interruption, reconnect, and plugin/app discovery without authorizing side effects.
- Prove two accounts, two devices, one execution writer, clean restart recovery, no secret leakage, and current-head package installation.

### Phase 6: reversible namespace cutover and beta release

- Publish durable HRA v0 links, rename old provider projects in place, and read back their original numeric identities and preserved deployments.
- Rename the new repository and Vercel project to HRA. Create and deploy fresh Convex state and credentials. Link Git by numeric repository identity and require a passing current-head `Required` check.
- Verify the new release behind a noncanonical URL, move `hra.sh`, verify apex and `www`, then publish an unambiguous immutable beta tag, checksums, SBOM, release notes, install flow, and friend-beta instructions.
- Rehearse full staging rollback before the irreversible public commit point and domain-only incident rollback after it. Do not attach the prerelease domain to HRA.

## Acceptance evidence

The beta requires all of these scenarios:

1. `hra` on a TTY stays attached in a readable line shell; `hra` on a pipe never prompts; `//` and `/send` handle leading slash messages; one-shot human, JSON, and JSONL modes keep stdout contracts clean and handle signals without orphaning authority.
2. Two isolated accounts authenticate and report distinct identities and usage with zero credential, event, interaction, process, or profile crossover.
3. Every request in the generated pinned server-request union produces exactly one prompt typed rejection, internal response, or durable pending interaction. Schema-digest drift fails initialization. A stale provider event or callback cannot mutate a newer connection or account generation.
4. Tagged request IDs, method, canonical digest, and nullable context form callback identity. Exact replay is idempotent; mutated replay quarantines the connection. Fault injection at every write boundary yields no double response, false decline, or false settlement, and preserves `resolution_unknown` when delivery cannot be proved.
5. A session snapshot and opaque cursor are atomic. Status, bounded long-poll, and reconnecting watch provide monotonic at-least-once delivery, per-page uniqueness, cursor deduplication, and explicit retention, restore, foreign-cursor, partial-output, or connection gaps.
6. Mid-turn evidence includes assistant display deltas, provider-visible reasoning summaries, item lifecycle, sanitized tool status and counts, safe plan/diff metadata, token usage, warnings, and terminal state. Raw reasoning, command output, patch bodies, arbitrary tool values, and unsafe paths never appear.
7. Command, patch, permission, question, and MCP elicitation requests become exact typed interactions. Duplicate, stale, cross-session, cross-generation, wrong-kind, and changed-revision responses fail before provider transport.
8. Invite, OTP, interaction, and elicitation secrets never enter argv, process listings, shell history, events, metrics, SQLite display data, Convex content, logs, crash diagnostics, stdout, stderr, or terminal echo on any success, error, or signal path. An unattended turn cannot hang or silently approve.
9. Plugin discovery returns only bounded path-free catalog metadata. Install, enable, disable, app authorization, and OAuth commands are rejected before transport because the pinned protocol does not separate those effects safely. Agent JSON, remote input, and TTY presence cannot open a browser or grant any of them. Tool approval remains a distinct exact interaction.
10. Local session list, condensed show, event watch, full turn inspect, rename, note, preset, Fast, project, send, queue, steer, interrupt, recover, and abandon work against the pinned app-server.
11. Every unsupported model, effort, tier, plugin, permission, or collaboration mode fails before the provider effect. Effective settings are displayed and recorded.
12. An ambiguous account login, turn mutation, queue dispatch, desktop switch, interaction, cloud command, or projection recovery is reconciled or visibly requires recovery and is never replayed automatically under a new idempotency key.
13. Usage polling is staggered and survives provider failure. More than 200 offline snapshots upload in order. Observed account velocity passes exact `0.8W` and `1.2W`, 90-second gap, tie-break, and actual-elapsed denominator boundaries and returns typed unavailable reasons for resets, account/schema/epoch changes, out-of-order or duplicate time, daemon gaps, and clock uncertainty.
14. Simultaneous first registrations yield one bootstrap key holder. Active and pending devices report fenced server-time TTL presence even with no sessions. A concurrent credential clone, stale clone after rotation, and clone after revocation cannot bypass connection fencing; the product discloses the uncontested bearer-clone limit. Heartbeat replay/reorder, competing connection, revoke races, crash, exit, and expiry are deterministic; pending registration grants no data or execution authority.
15. Two paired devices decrypt the same session projection. An authenticated registered but unpaired device cannot. Losing all key holders is reported as unrecoverable. A to B to A cloud-identity switch in one local root preserves two isolated custody namespaces.
16. A remote command executes once on the lease-owning device. Concurrent claim, lease expiry, restart, and lost response never produce two provider writers. Offline remote commands remain pending and bounded.
17. Beginning cloud-account deletion disables the subject and increments its epoch in the first transaction. Lost-response status is recoverable; more than 200 records per category erase incrementally after crashes without resetting an immutable compact epoch. Every public function denies post-revocation reads and effects. Local Codex use continues.
18. Abandoned unverified identities expire without racing a valid verification. Device revocation removes authority immediately and cleans more than 500 dependent records incrementally without heartbeat, lease, read, resurrection, or provider-effect replay.
19. Exact quota boundaries, concurrent writers, replay, retention, and deletion preserve server-computed transactional count and logical-byte ledgers. Forged sizes do nothing. Corrupt quota authority closes cloud writes while leaving local HRA usable.
20. Under a 200-record hard budget with 20 per category, every eligible maintenance category progresses in one rotation. Rotating arbitrary emails without a valid purpose-scoped beta capability sends no mail and consumes no honest-user admission budget.
21. Account switching quits only the exact supported application, preserves both profiles, relaunches once, and verifies the selected identity. Faults before and after each effect leave deterministic recovery.
22. Secret sentinels never appear in stdout, stderr, plaintext projections, Convex documents, logs, site assets, package contents, Git, release artifacts, or provider migration output.
23. Unicode, arbitrary JSON, pagination, ordering, reducer, cursor, encryption, idempotency, quota, lifecycle, and state-machine property suites pass, followed by the repository-wide release gate.
24. A clean environment installs one working `hra` binary from the immutable beta tag without a global Node or Codex dependency. README commands pass against the packaged artifact, and the built website has the same contract.
25. Before the public commit point, full rename rollback is rehearsed. After it, domain-only incident rollback is rehearsed. HRA v0 keeps its repository ID, tags, releases, deployment URL, data, and fallback mapping page. New HRA has distinct provider IDs and fresh Convex state. Current-head CI, release artifacts, `hra.sh`, `www.hra.sh`, security paths, two-account acceptance, and two-device acceptance are live and read back from providers.

## Explicit exclusions

- Automatic account rotation, quota pooling, or rate-limit evasion.
- A desktop or web application for new HRA. The line-oriented interactive CLI and static website are in scope; a full-screen terminal IDE is not.
- Cloud execution or silent provider-session takeover on another machine.
- Managed worktrees, recursive agent orchestration, adaptive routing, task graphs, or provider failover.
- Noninteractive plugin installation, OAuth consent, browser opening, or blanket approval of unknown requests.
- Sync of credentials, raw reasoning, arbitrary tool output, or full provider payloads.
- Turso or another second metrics-replication authority without a concrete server-side analytics consumer.
- Renaming or migrating HRA v0 runtime storage, Keychain, bundle, opaque data identifiers, deployment, or installed-user state.
- Windows desktop application switching in the first beta. Local CLI and cloud read/control support may expand after macOS is proven.

## Current execution state

| Phase | State | Evidence |
| --- | --- | --- |
| Phase 0 | Complete | The first implementation, compact-recovery fix, Codex 0.149 source audit, `fx` audit, Turso decision, hosted hostile audit, exact provider namespace inventory, independent eight-P0 adversarial review, amended plan, and closeout audit exist. The closeout found no remaining P0 and its four P1 clarifications are incorporated. |
| Phase 1 | Implemented locally | The pinned request matrix and digest are exhaustive; safe events, signed cursors, retention gaps, durable typed interactions, write-adjacent unknown resolution, process-generation fencing, and stale-revision rejection have deterministic coverage. Live disposable-account acceptance remains pending. |
| Phase 2 | Implemented locally | `hra` provides the persistent line shell, protected input, one-shot JSON, reconnecting JSONL follow, atomic status/events, interaction commands, and read-only plugin discovery. Package smoke proves the installed binary. |
| Phase 3 | Implemented locally | Staggered polling, historical success and failure ledgers, exact velocity windows, ordered encrypted upload, identity-scoped A to B to A custody, automatic registration, and fenced server-time device presence have deterministic coverage. Live hosted multi-device proof remains pending. |
| Phase 4 | Implemented; deployment genesis pending | Account deletion, abandoned cleanup, hard aggregate/resource quota, exact Convex Auth accounting, fair maintenance, status-first revocation, and invitation-gated admission pass hostile deterministic suites. A fresh deployment must run one-shot hard-quota genesis before its first auth write. |
| Phase 5 | Local integrated gate complete | Profiles, sessions, interactions, usage, presence, deletion, desktop switching, encrypted sync, compact recovery, shell live updates, generated public contracts, site generation, and package installation pass the repository-wide gate after the HRA rebrand. Real Codex, two-account, and live hosted two-device acceptance remain pending. |
| Phase 6 | Not started | No source publication, current-head CI, new Convex project, namespace rename, new deployment, domain cutover, tag, or release has occurred. |

## Execution evidence

- 2026-08-22: The CLI parser accepts the exact email-code request and verification flags, rejects unknown options, and is total over arbitrary argv in its property suite.
- 2026-08-22: Cloud-control tests cover first-device bootstrap, later-device pending registration, active-device approval, key-envelope retrieval, revocation, and bounded encrypted projection reads. These are deterministic fixtures, not a live hosted two-device acceptance.
- 2026-08-22: Bounded session projection tests cover recent-turn paging, UTF-8 truncation metadata, compact transcript rendering, safe file and Git action summaries, and exact turn inspection without raw hidden reasoning.
- 2026-08-22: Desktop switching is covered through fake bundles and process ports, including exact process identity, journal transitions, idempotent replay, and recovery after uncertain effects. Installed-app acceptance remains intentionally unclaimed.
- 2026-08-22: The pinned runtime, local daemon, desktop state machine, cloud bridge, Convex contract, CLI, site, and package passed the repository-wide release gate: ESLint, TypeScript, 357 tests with 6,335 assertions, canonical site generation, CLI build, and isolated consumer packaging.
- 2026-08-22: Cloud integration tests cover fenced execution leases, exact remote-command identity and FIFO, lost-journal recovery, terminal command lookup, encrypted projection bounds, projection-ledger mismatch quarantine, deterministic multi-device usage ordering, logout recovery, and cache corruption without blocking local execution.
- 2026-08-22: `hra remote command <uuidv7>` exposes a bounded terminal command state and result code. `sync now` returns only a bounded, redacted summary and never serializes full cloud transcripts across the local daemon transport.
- 2026-08-22: GitHub repository security settings, immutable version tags, immutable releases, private vulnerability reporting, secret scanning, push protection, and Dependabot security updates are configured. Source publication, current-head CI, the version tag, and the GitHub release remain pending.
- 2026-08-23: `hra sync projection recover <local-session-selector> --acknowledge-gap` exposes the existing append-only compact-projection recovery seam. Parser and terminal suites prove missing acknowledgement performs no daemon call, default UUIDv7 creation happens before transport, same-key retry is reusable, applied output reports only bounded epoch and boundary evidence, and foreign baselines, cache paths, provider data, secrets, and cloud user/device identities never render. Canonical README, privacy, site, retention, and command-reference surfaces document the gap acknowledgement while hosted sync remains disabled.
- 2026-08-23: Codex tag `rust-v0.149.0` proves app-server is a bidirectional JSONL protocol whose connection receives notifications and server requests. Pending callbacks can replay on same-generation resume, but ordinary notifications have no replay cursor. The current client requests `on-request` approval while rejecting every server request, so the HRA interaction broker and event ledger are release-critical rather than optional polish.
- 2026-08-23: The `fx` source audit supports a typed event log, exact approval identities, protected terminal input, and strict noninteractive policy. It does not justify replacing the existing Bun and TypeScript authority engine with Zig.
- 2026-08-23: The hosted hostile audit found eight P0 families: account erasure, abandoned identity cleanup, aggregate quotas, fair maintenance, status-first unbounded revocation, OTP admission resistance, identity-scoped local cloud custody, and real device presence. Hosted sync remains disabled until their hostile tests pass.
- 2026-08-23: Provider inventory recorded immutable numeric identities and a dependency-ordered, reversible HRA v0 and new HRA migration. The old GitHub redirect will be lost when the name is reused, so durable v0 links must land before namespace collision.
- 2026-08-23: Independent adversarial review found eight P0 design gaps. This revision adds an exhaustive pinned server-request classification and schema digest, tagged callback identity and `resolution_unknown`, opaque epoch cursors with at-least-once delivery, protected input, exact observed-velocity comparability, generated hosted-authorization and table-lifecycle coverage, a closed device bootstrap state machine, and a public namespace commit point with domain-only incident rollback.
- 2026-08-23: The daemon now owns the sole app-server subscription and translates every pinned brokered callback into a revisioned durable interaction. Safe session events, signed opaque cursors, long polling, JSONL follow, provider-restart gaps, retention floors, write-ahead response states, and stale-generation rejection pass focused fault and property suites.
- 2026-08-23: `hra` now opens a persistent line shell on a TTY and retains the same typed one-shot command surface for agents. Auth, permission grants, secret answers, and accepted MCP content use only bounded hidden stdin or an explicit file descriptor. Plugin discovery uses the pinned read-only list method; every lifecycle command is rejected before provider transport.
- 2026-08-23: Account usage polling uses stable 50–70 second jitter and a 15-minute failure cap. SQLite records ordered successes and path-free failures, derives exact 1-, 5-, and 15-minute observed token velocity, and uploads an ordered bounded encrypted backlog. Device presence uses 15-second heartbeats, a 45-second server-time TTL, connection fencing, status-first revocation, and automatic registration distinct from key pairing.
- 2026-08-23: Hosted auth and storage now require one-shot hard genesis on an empty deployment. Exact Convex document sizing transactionally charges service, user-category, user-resource, and account-resource ledgers, including the full pinned Convex Auth store matrix. Invitation admission, auth subject transfer, account deletion, abandoned cleanup, fair maintenance, and incremental revocation pass hostile deterministic suites.
- 2026-08-23: The public package, binary, repository contract, and website are HRA. Fresh local identifiers are `HRA Control Plane v1`, `hra-control-plane-v1`, `sh.hra.control-plane.v1`, and `hra-control-plane` protocol/cryptographic domains. A coexistence test preserves seeded HRA v0 custody, and isolated local/global package smoke verifies `hra-0.1.0.tgz`.
- 2026-08-23: The persistent shell starts and validates the daemon before its first prompt, keeps the daemon alive on exit, and follows the selected session from its current durable cursor. Human updates coalesce safe assistant and provider-visible reasoning-summary deltas, expose typed interactions and bounded tool/file status, cancel on selection changes, and redact protected content. Agent JSONL follows reconnect from the last signed cursor only for typed transient daemon failures.
- 2026-08-23: Provider process generations are single-use after disconnect. Daemon restart atomically expires or marks unresolved every prior callback, advances all prior profile generations, and appends conservative provider-restart gaps for bound nonterminal sessions. Delayed facts from an older client cannot mutate a newer generation.
- 2026-08-23: Usage sync drains an exact source-revision backlog instead of uploading only the latest sample. A deterministic 205-snapshot fixture drains across bounded cycles and restart without leapfrogging a failed revision, while multiple accounts receive fair progress in each cycle.
- 2026-08-23: `hra auth delete --acknowledge-erasure` creates durable identity-scoped deletion authority before transport, recovers exact lost responses after restart, and exposes capability-only progress after authentication disappears. Local Codex accounts, sessions, device keys, and encryption custody remain local.
- 2026-08-23: The complete local release gate passed ESLint, TypeScript, 615 tests with 12,281 assertions across 65 files, generated-site parity, the production CLI and site build, public-tree and complete-history sensitive-text scanning, and isolated local and global installation of `hra-0.1.0.tgz`. Every temporary-path fixture uses the host temporary directory rather than a macOS-only root.

## Review findings

- Cloud sign-in, automatic device registration, key pairing, and execution authority are separate effects. Pending registered devices may report presence but have no synchronized data authority.
- The current remote-command protocol contains only send, queue, steer, stop, model, and Fast. Names and notes remain encrypted session metadata, while project directories remain local-only. Remote rename, note mutation, and directory mutation are excluded from v1 claims unless the closed protocol and its authority tests expand.
- Before each new thread or turn, the runtime refreshes the exact model, effort, Fast tier, workspace permission, stable computer-use and plugin features, and enabled accessible app list from the same fenced app-server generation. Successful starts append the effective profile to local session authority and `session show` displays it.
- App-server plugin installation, app authorization, OAuth, command approval, file approval, permission grants, user questions, and MCP elicitation are distinct provider effects. HRA exposes command, file, permission, question, and elicitation callbacks through kind-valid interactions. The pinned plugin lifecycle is not safely separable, so HRA exposes discovery only and keeps its lifecycle closed.
- A missing, corrupt, or mismatched local cloud projection ledger pauses only transcript upload. Remote reads, commands, and usage continue, and the mismatch stays visible. Explicit append-only recovery requires `--acknowledge-gap` and a current UUIDv7. It preserves every older encrypted cloud chunk, opens the next compact epoch at the exact global head plus one, baselines only currently visible completed turns, changes no provider or app state, and retains the possible unsynced interval as a recovery gap.
- Existing SQLite and encrypted Convex ledgers are enough for beta metrics. Turso remains a deferred implementation option behind an export repository, not a second source of truth.
- Hosted sync is not enabled for the beta release until authenticated account erasure, abandoned-unverified cleanup, aggregate storage quotas, fair bounded maintenance, status-first revocation, invitation-gated OTP admission, identity-scoped local custody, device presence, ordered usage upload, and live two-device proof pass.
- External cutover is a data-preserving rename sequence. HRA v0 keeps its runtime and provider identities. New HRA gets fresh state. Domain movement happens only after the new deployment passes acceptance behind a noncanonical URL.

## Primary references

- [Codex app-server](https://learn.chatgpt.com/docs/app-server)
- [Codex authentication](https://learn.chatgpt.com/docs/auth)
- [Codex developer commands](https://learn.chatgpt.com/docs/developer-commands?surface=cli)
- [OpenAI model guidance](https://developers.openai.com/api/docs/guides/latest-model)
- [OpenAI Codex 0.149.0 source](https://github.com/openai/codex/tree/758ef40f50c1a458425c7cfbf1eb12cbc07af0b0)
- [Vercel Labs fx](https://github.com/vercel-labs/fx)
- [Turso TypeScript SDK](https://docs.turso.tech/sdk/ts/reference)
- [GitHub repository rename behavior](https://docs.github.com/en/repositories/creating-and-managing-repositories/renaming-a-repository)
- [Vercel project rename](https://vercel.com/changelog/projects-can-now-be-renamed)
- [Convex project update API](https://docs.convex.dev/management-api/update-project)
