# Working and project memory

Every project-bound HRA session has an expiring working-memory authority and reads it together with one durable canonical-memory authority for its current project. `memory_remember` writes only to the calling session's working lane. `memory_share` is the only local path from that lane into project canonical memory, and it uses conflict-checked adoption rather than automatic publication.

The daemon composes the stable `@hraness/oh/memory` authority with Oh's public store and SQLite surfaces. Oh owns memory-page parsing, the two-authority query and explanation model, nominations, canonical adoption, graph replay, projection, and conflict semantics. HRA owns session and project binding, host attestations, operation preparation and recovery, physical directory custody, and the closed model-facing tool policy. HRA does not import the compatibility `@hraness/oh/experimental/memory` path, vendor Oh, or reproduce its graph semantics. Neither Suss nor Cozo is an HRA runtime dependency.

## Authority boundary

HRA derives one working binding from the exact account ID, session ID, and host-owned positive epoch. Epoch 1 retains the original account/session binding for compatibility. Only a completed `expired` purge may advance that same session to the next epoch; an archived or abandoned session is permanently retired. If HRA observes archive or abandon after expiry already completed, it atomically seals that purged control row with the terminal reason before any later ensure can reactivate it. One HRA session epoch is one working-memory branch, and a fork creates a different child session bound to one immutable checkpoint of its exact parent epoch.

A provider switch inside the same HRA account profile preserves that binding, so Codex, Claude Code, and Devin can hand off the session without losing working memory. This release does not transfer working-memory custody between account profiles: `hra session switch --account ...` refuses before provider effects once a working authority exists. New managed sessions create that authority at start, so cross-account continuation normally requires a new session. Project canonical memory remains project-scoped; the restriction applies to the session working lane.

HRA derives the project canonical binding and its private directory name from the exact local project ID. A model cannot select its actor, project, epoch, database, directory, branch namespace, space, authority, rule set, clock, operation ID, nomination destination, sync credential, or purge authority. Managed agents and the owner CLI use closed HRA commands described below. Neither surface exposes raw Oh store handles or arbitrary CRUD, rule, head-acceptance, or purge authority.

The lifecycle control database may contain only:

- the account and session IDs;
- their binding digest;
- fixed create, fork, cleanup, and expiry state;
- an opaque handle hash;
- exact public store heads (sequence, Oh operation SHA-256, and an HRA head digest) and receipt digests;
- an exact parent binding and head for a fork;
- the current epoch, one fixed-size digest chaining the preceding expired-purge boundary, and bounded timestamps, reasons, and revisions.

It has no column for facts, records, payloads, rules, projections, credentials, tokens, database paths, or raw handles. Semantic data remains in Oh.

The main control-plane database retains only bounded project-memory authority and mutation evidence: project and session IDs; binding, request, content, key, record, attestation, nomination, receipt, and authority digests; exact expected, source, result, conflict, and last-exchange heads; lifecycle state; sync state; timestamps; and closed diagnostic or outcome codes. It does not retain memory titles, summaries, bodies, query rows, explanations, or Oh records.

The table retains exactly one current row per HRA session. Expiry reactivation updates that row with an incremented epoch and hash-chains the prior purge receipt into one fixed-size summary; it does not append unbounded generation history. Every state transition compares the exact session, epoch, and revision. The empty head is exactly sequence zero with no operation SHA; every positive sequence requires one operation SHA.

## Local layout

HRA keeps lifecycle metadata in `facts-memory-control.sqlite` under its private state root. Each session's Oh database, adapter lifecycle sidecar, and every related SQLite WAL, SHM, projection cache, and derived cache belong under one host-derived directory:

```text
<HRA state root>/facts-memory-sessions/<exact session ID>/             # epoch 1
<HRA state root>/facts-memory-sessions/<exact session ID>.epoch-<N>/   # epoch N > 1
<HRA state root>/project-memory/<digest of exact local project ID>/    # canonical lane
```

Directory paths never enter either control database, a host-tool result, or a command response. HRA requires absolute canonical current-user-owned mode-0700 roots, rejects symbolic links and path traversal, bounds recursive inspection, and rejects linked or replaced entries before cleanup. The adapter opens SQLite and metadata through no-follow custody, enforces and reads back mode 0600 on `oh.sqlite`, its observed WAL and SHM files, and its metadata, and relies on the enclosing mode-0700 directory for any transient or future cache entry it does not interpret.

Cleanup first asks the Oh adapter to quiesce the exact epoch store. Reopening remains fail-closed on malformed metadata, but cleanup does not let an unreadable or legacy sidecar permanently strand a terminal session: after the broker validates the private tree, a remaining bounded database must reopen under the exact Oh binding and derive the expected opaque handle; if the database is already absent, the control record's epoch-bound handle fences removal of the residual exact directory. An oversized database is never opened. Its final sidecar may authorize cleanup only when either its exact current adapter and receipt digests or its exact historical adapter and historical receipt preimages validate. A bounded, no-follow descriptor reader additionally proves the sidecar's owner, private mode, single-link inode, stable size, exact binding, and `handle = H(binding, Oh binding)` relation; it returns only those cleanup authority fields and never normalizes, migrates, or returns a head. The broker still compares that handle with the durable epoch-bound expected handle. HRA then revalidates the complete session tree, atomically renames it to a host-derived epoch-specific quarantine name, and removes that whole tree. A retry completes a crash-left quarantine instead of replaying semantic operations. A purge receipt is committed only after both the live and quarantine paths are absent. A stale purge holds only its old epoch binding and path, so it cannot address a later reactivated directory.

This is honest local custody, not a sandbox or forensic erasure guarantee. Another process running as the same operating-system user can read or race local files despite these checks. Backups, filesystem snapshots, and storage media may retain prior bytes.

### Backup, restore, and rollback

`control-plane.sqlite`, `facts-memory-control.sqlite`, `facts-memory-sessions/`, and `project-memory/` are one logical recovery unit. Stop the daemon and require `hra daemon status --json` to report `data.running: false` before taking or restoring a snapshot, then copy or restore the complete private state root at one filesystem checkpoint. Copying only an Oh database, only either control database, or only their main SQLite files without the matching WAL/SHM state is not a supported backup.

After restore, HRA replays and revalidates both control and physical heads. A partial or mixed-age restore cannot authorize a newer head: unexplained project-memory disagreement freezes canonical-dependent work, and unexplained working-memory custody enters recovery instead of silently accepting either side. Preserve the mismatched backup for diagnosis; do not delete the newer side or edit stored heads to force convergence.

Schema v40 is a one-way local upgrade. An older HRA binary refuses a v40 control database. Compact peer attribution remains forward compatible with the v0.5 reader: every non-owner host message retains legacy `actor: "autorespond"`, while the optional `actorKind` distinguishes `peer_session` and `provider_switch` for newer readers. A bounded future kind becomes neutral `unknown`, never `human`; malformed kinds reject the whole chunk. Rollback therefore means stopping HRA and restoring the complete pre-upgrade state-root snapshot with the matching older binary, not opening upgraded state with downgraded code.

Session archive, abandonment, and expiry remove only the exact working-memory epoch. Project canonical memory has no session TTL and survives individual session cleanup and daemon restart. It is not silently copied when a session changes projects: the session keeps its working lane and future composite queries bind that lane to the new project's canonical authority.

## Lifecycle

The lifecycle implements these internal host operations:

- `ensureSession` reserves authority before store creation, reconciles a lost create response by exact inspection, and never speculatively creates a second store.
- `resumeSession` revalidates owner, session, epoch, opaque handle, immutable creation receipt, and an exact accepted head. If the store advanced, the adapter must prove the prior operation reference is on the current Oh chain before HRA accepts the new head; sequence growth alone is insufficient.
- `forkSession` resumes the parent first, transactionally reserves compact references to the exact parent head, and then records the child control intent before Oh copies that historical checkpoint. A pre-control crash leaves a bounded reservation that fences parent cleanup and is removed by the child-keyed sweep only after it proves no exact live child control row exists. Finalization records both the immutable initial child head and parent tuple; later child or parent advances cannot rewrite the fork proof. A retry can therefore reconcile a completed child commit without borrowing the parent's current head or operation authority. Once the child is active or itself retired, the physical parent can be purged.
- `cleanupSession` covers archive, abandon, and expiry. It retains cleanup authority until the entire session directory is proven absent.
- `sweepExpired` selects a bounded page, then re-reads the exact epoch, revision, state, and expiry under the session lifecycle tail before cleanup. A renewal queued ahead of a stale sweep wins and cannot be purged by that old page. A host-owned cursor advances across eligible session IDs and wraps, so sixteen repeatedly failing cleanup rows cannot starve a later expiry.
- `recovery_required` is fail-closed but not terminal. A later host ensure or resume repeats exact inspection and restores `active` only when the immutable binding, handle, creation receipt, and accepted-head ancestry all re-prove. Exact archive or abandon cleanup remains available; tampered custody is never silently blessed.

The service uses a 30-day session-memory TTL. Every admitted live ensure uses the later of the durable session activity time and the current host time, so a live session recreated after an expiry sweep receives a future TTL instead of being purged again on each unchanged resume. Session start, local and remote mutation, provider observation, provider-list import, and successful note, preset, Fast-mode, and project commits renew after their durable activity. Terminal provider deletion, observation, list-import, and every recovery commit clean up immediately with reason `archive`; explicit abandonment uses `abandon`. Daemon recovery and commands scan retained sessions in bounded pages to retry any terminal cleanup whose local state commit preceded a crash. The scan is generation-fenced against concurrent terminal commits and isolates a failing terminal cleanup so it cannot block unrelated commands or startup; the failed generation remains eligible for a later retry. Explicit session abandonment proves memory cleanup before HRA releases the local recovery authority. HRA's existing provider cancellation and recovery semantics are unchanged.

An expired purge may be reactivated only by a later live-session ensure. That creates the next epoch with a new binding, operation keys, Oh realm, space, and directory. Archive and abandon never reactivate, including when either terminal observation arrives after an expired physical purge. The control database's v1 schema migrates transactionally into epoch 1. Empty-head rows remain directly compatible. A nonempty legacy row has no stored raw Oh operation reference, so it enters `recovery_required` and can return to active only when inspection re-proves the exact legacy sequence and digest while recovering the raw operation SHA. A legacy nonempty fork also lacks its parent's raw checkpoint reference and is cleanup-only; HRA will not infer ancestry from a sequence. Epoch-1 adapter sidecars are validated against the exact pre-v2 adapter and receipt digest preimages before migration. HRA migrates an empty create, or an empty fork whose initial and parent heads are both sequence zero, by inferring epoch 1 and explicit null operation references; a crash-left migration file is resumed only when its exact contents validate. Any old sidecar with a nonzero initial or parent sequence remains cleanup-only: exact historical adapter and receipt preimages can prove its narrow cleanup authority but can never supply a head, inspection, or migration authority.

## Stable Oh adapter and capacity

`OhSqliteFactsMemoryEngine` maps HRA custody to Oh's exact working and canonical store profiles:

1. HRA bindings select every Oh realm, space, profile, and `oh.sqlite` path during host composition;
2. working-store creation accepts only an empty authority and publishes a bounded, checksummed lifecycle sidecar after closing it;
3. inspection verifies Oh replay and materialization while returning only HRA's opaque handle hash, immutable creation receipt, and current exact head; it uses Oh's historical head lookup to prove that the last accepted operation is an ancestor before accepting an advance;
4. a new session fork requests an exact snapshot at the recorded parent operation reference, proves the returned sequence, operation SHA, and digest again, and copies the records into a new working authority;
5. the child copy is one fresh host-owned operation, so it preserves record and dependency digests but deliberately does not copy the parent's operation IDs, actor authority, timestamps, or history;
6. the exact fork serialization limit is Oh's stable 32 MiB memory-lane limit, with at most 8,192 records. HRA measures the returned JSON array before opening or committing the child, so the first oversized snapshot leaves no child database;
7. `oh.sqlite` plus `oh.sqlite-wal` is limited to 512 MiB, which is sixteen times the maximum memory-lane snapshot to account for Oh's operation, live-record, search-document, and full-text-index materialization. HRA checks the combined size before open and around verification;
8. each HRA-opened SQLite connection first checkpoints an existing bounded WAL, then applies a page ceiling that reserves space for both the main database page and its largest WAL frame. Cache spilling is disabled for the bounded transaction and WAL autocheckpointing is enabled. A capacity-exhausting commit returns `FACTS_MEMORY_OH_DATABASE_TOO_LARGE` from the rolled-back transaction instead of committing a store that the next HRA open would reject;
9. replay after a completed child commit uses the same epoch-scoped host-derived operation ID and content, allowing Oh to reconcile a crash before metadata publication even when the parent has advanced;
10. quiesce reopens and verifies the exact authority, closes it, and returns custody to the broker, which removes the whole validated session directory.

A database or fork above its byte ceiling fails closed. A valid legacy oversized working store is cleanup-only through an exactly validated current or historical lifecycle sidecar. The adapter does not call Oh's logical whole-space purge before physical cleanup because that would create a crash state that could no longer be reopened for HRA's quarantine retry. The broker instead proves the local authority is closed, validates and quarantines its exact session directory, and removes the complete directory before committing the HRA purge receipt.

There is no canonical compaction, rollover, size forecast, or erasure command in this release. When a project database reaches the 512 MiB ceiling, further canonical or working commits against that database fail closed. HRA also exposes no project-removal command; once canonical authority is initialized, its control row and bytes remain durable. A later owner-authorized retirement design must define exact export, rebind, conflict, and irreversible-erasure semantics before either boundary is opened.

## Model-facing memory tools

For Codex and Claude Code, the versioned HRA host-tool manifest and static session preamble expose four tools in the provider-native `hra` namespace:

- `memory_remember` accepts a logical key, title, summary, body, and optional language. HRA constructs the Oh memory-page edition, derives the calling session and project, assigns the actor and time, and binds a host attestation before writing only the working lane.
- `memory_query` lists, gets, or searches the working and current-project canonical lanes through fixed host-owned programs. Search matches bounded tokens from the logical key, title, and summary. It does not run caller-supplied rules or arbitrary Oh queries.
- `memory_explain` returns the bounded Oh proof for one row of a recent query. Cached explanations and get datasets are process-local, session-bound, project-bound, working-binding-bound, memory-bounded, and expire after fifteen minutes. List and search continuations remain bound to their exact source heads and refuse after those heads change.
- `memory_share` nominates one exact attested working page and asks the separate host authority to adopt it into the current project's canonical lane at the reviewed head. HRA exposes no direct canonical put.

HRA calls `createOhMemoryAuthorityV1` with host-derived stores, bindings, actor, programs, codec, clock, continuation key, and nomination route. Ordinary memory operations use its locator-free `agent` object. HRA retains the separate `host` object only for canonical adoption; it never places that host authority in a model request or result.

The initial Devin ACP adapter is text-only and does not bind HRA's static preamble or host-tool server in this release. A Devin session still has the same host-owned working and project-memory authority, survives a same-profile provider switch, and can be addressed through the owner CLI below. The Devin model cannot invoke these four tools until a later ACP binding is implemented and verified.

List and search rows contain lane, logical key, record digest, bounded display metadata, premise authority, and proof summary. Get also returns the body in bounded chunks. Every row marks provenance verification as `local-ledger-verified` only when HRA can rederive it from compact host-attestation evidence and an exact current reference for that working or canonical authority. Otherwise it says `unverified`. Both states are untrusted tool data, not instructions, identity proof, or approval authority.

The model never supplies an idempotency key. HRA derives mutation identity from the exact provider call and returns a submission ID, receipt digest, resulting head, replay flag, and `idempotencyRetainedUntil` for `remember` and `share`. Query and explanation do not create memory-submission records.

## Owner CLI

The model-independent owner surface routes through the same `HraMemoryPort` coordinator as the provider tools. It does not open Oh directly:

```text
hra memory status <session> [--json]
hra memory list <session> [--continuation <token>] [--json]
hra memory get <session> <key> [--continuation <token>] [--json]
hra memory search <session> [--continuation <token>] <text> [--json]
hra memory explain <session> <query-id> <row> [--json]
hra memory remember <session> <key> --title <title> --summary <summary> [--language <tag>] [--idempotency-key <uuid>] [--json] -- <body>
hra memory share <session> <key> --reason <reason> [--idempotency-key <uuid>] [--json]
```

`status` is a metadata-only diagnostic. It reports the session and project, canonical initialization, accepted head, sync state, freeze diagnostic, working lifecycle state, epoch, binding digest and accepted head, owner-binding match, and a bounded unsettled-submission summary. Merely inspecting status does not create a working store, open either Oh database, or initialize canonical authority.

The list, get, search, and explain commands preserve the same bounded rows, continuation checks, source-head binding, and process-local proof lifetime as the model tools. Remember and share accept or generate one UUID idempotency key before transport; the human renderer prints that key and its retention boundary so a caller can reuse it after a lost response. Their request digest binds the exact session, operation, and validated memory value, so changed same-key reuse fails closed. Human output terminal-escapes remembered content; `--json` emits the standard versioned command envelope.

## Serialization, replay, and recovery

One coordinator serializes every memory operation for a project, including working writes and composite reads. This is a deliberate local policy, not an Oh requirement. It gives canonical adoption, head comparison, and mutation recovery one deterministic per-project ordering boundary. Separate projects can progress independently, while sessions in the same project trade parallel memory access for a single ordered recovery boundary.

Each project may have at most one unsettled `remember` or `share` submission. HRA prepares the submission before the Oh effect and records the exact actor session, project, request and content digests, working binding and epoch, expected head, operation ID, record and attestation digests, and nomination evidence needed by that operation. A new memory operation refuses while the prior submission needs recovery. A session also cannot change projects while its memory submission is unsettled.

On daemon startup, recovery scans unsettled submissions in bounded pages. It cancels a prepared submission whose effect never began. For `effect_started` or `ambiguous`, it inspects the exact expected head and the first physical descendant operation. It settles only an exact committed operation, an exact already-present share, a proven no-effect outcome, or a closed conflict. It never speculatively replays an uncertain mutation. Unresolved evidence remains ambiguous and returns `MEMORY_RECOVERY_REQUIRED`.

Canonical adoption is strict compare-and-swap. A different record at the nominated key returns the expected and actual canonical heads plus the nominated and canonical record digests. HRA does not merge, overwrite, infer a replacement claim, or retry against the newer head. Reusing the retained idempotency key returns that same terminal conflict.

A physical canonical head that disagrees with HRA's accepted control head quarantines the project in memory and records a durable `error` sync state when its control compare-and-swap succeeds. A hosted-sync `conflict` or `error` state has the same fail-closed effect. Composite query, explanation, and share return `MEMORY_CANONICAL_FROZEN`; `hra memory status` exposes the closed diagnostic. This release intentionally ships no thaw or head-acceptance command, so an affected project remains frozen pending a later exact reconciliation tool. The sync state alone does not disable a fresh working-memory remember, but an unsettled project submission still blocks new memory work.

Terminal submission evidence has finite retention. HRA retains it for at least 30 days and reports the earliest expiry boundary in `idempotencyRetainedUntil`. Before admitting a new submission, HRA removes only terminal `applied`, `failed`, or `cancelled` rows at or beyond that age. It never prunes `prepared`, `effect_started`, or `ambiguous` recovery evidence. A project retains at most 10,000 submission rows; if none are old enough to prune, new mutations fail closed. After a terminal row is pruned, exact same-key replay is no longer promised. Compact attestation evidence is independent: it remains while at least one current working or canonical page references it, is cloned with an exact working fork, and is collected only after the corresponding physical working authority is proven purged or a newer page replaces the last reference.
