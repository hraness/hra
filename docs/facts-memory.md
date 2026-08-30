# Session facts memory

HRA has a narrow host-owned lifecycle seam for session facts memory. HRA coordinates custody. Oh owns the semantic store, graph, query, projection, and rule behavior.

The daemon composes a concrete local adapter for release-verified Oh v0.2.0. `package.json` pins its immutable release tag and `bun.lock` resolves exact commit `89fb133`. HRA does not vendor Oh or reproduce its graph and Datalog semantics. The adapter imports only Oh's base, store, and SQLite surfaces; neither Suss nor Cozo is an HRA runtime dependency.

## Authority boundary

HRA derives one binding from the exact account ID, session ID, and host-owned positive epoch. Epoch 1 retains the original account/session binding for compatibility. Only a completed `expired` purge may advance that same session to the next epoch; an archived or abandoned session is permanently retired. If HRA observes archive or abandon after expiry already completed, it atomically seals that purged control row with the terminal reason before any later ensure can reactivate it. One HRA session epoch is one facts-memory branch, and a fork creates a different child session bound to one immutable checkpoint of its exact parent epoch. A caller cannot select an epoch, database, directory, branch namespace, space, authority, rule set, query engine, or purge credential. No facts-memory command exists in the local command union.

The lifecycle control database may contain only:

- the account and session IDs;
- their binding digest;
- fixed create, fork, cleanup, and expiry state;
- an opaque handle hash;
- exact public store heads—sequence, Oh operation SHA-256, and an HRA head digest—and receipt digests;
- an exact parent binding and head for a fork;
- the current epoch, one fixed-size digest chaining the preceding expired-purge boundary, and bounded timestamps, reasons, and revisions.

It has no column for facts, records, payloads, rules, projections, credentials, tokens, database paths, or raw handles. Semantic data remains in Oh.

The table retains exactly one current row per HRA session. Expiry reactivation updates that row with an incremented epoch and hash-chains the prior purge receipt into one fixed-size summary; it does not append unbounded generation history. Every state transition compares the exact session, epoch, and revision. The empty head is exactly sequence zero with no operation SHA; every positive sequence requires one operation SHA.

## Local layout

HRA keeps lifecycle metadata in `facts-memory-control.sqlite` under its private state root. Each session's Oh database, adapter lifecycle sidecar, and every related SQLite WAL, SHM, projection cache, and derived cache belong under one host-derived directory:

```text
<HRA state root>/facts-memory-sessions/<exact session ID>/             # epoch 1
<HRA state root>/facts-memory-sessions/<exact session ID>.epoch-<N>/   # epoch N > 1
```

The directory path never enters the lifecycle database or a command response. HRA requires an absolute canonical current-user-owned mode-0700 root, rejects symbolic links and path traversal, bounds recursive inspection, and rejects linked or replaced entries before cleanup. The adapter opens SQLite and metadata through no-follow custody, enforces and reads back mode 0600 on `oh.sqlite`, its observed WAL and SHM files, and its metadata, and relies on the enclosing mode-0700 directory for any transient or future cache entry it does not interpret.

Cleanup first asks the Oh adapter to quiesce the exact epoch store. Reopening remains fail-closed on malformed metadata, but cleanup does not let an unreadable or legacy sidecar permanently strand a terminal session: after the broker validates the private tree, a remaining bounded database must reopen under the exact Oh binding and derive the expected opaque handle; if the database is already absent, the control record's epoch-bound handle fences removal of the residual exact directory. An oversized database is never opened; cleanup may instead use only a current sidecar whose adapter and receipt digests and exact binding already validate, making that store cleanup-only. HRA then revalidates the complete session tree, atomically renames it to a host-derived epoch-specific quarantine name, and removes that whole tree. A retry completes a crash-left quarantine instead of replaying semantic operations. A purge receipt is committed only after both the live and quarantine paths are absent. A stale purge holds only its old epoch binding and path, so it cannot address a later reactivated directory.

This is honest local custody, not a sandbox or forensic erasure guarantee. Another process running as the same operating-system user can read or race local files despite these checks. Backups, filesystem snapshots, and storage media may retain prior bytes.

## Lifecycle

The lifecycle implements these internal host operations:

- `ensureSession` reserves authority before store creation, reconciles a lost create response by exact inspection, and never speculatively creates a second store.
- `resumeSession` revalidates owner, session, epoch, opaque handle, immutable creation receipt, and an exact accepted head. If the store advanced, the adapter must prove the prior operation reference is on the current Oh chain before HRA accepts the new head; sequence growth alone is insufficient.
- `forkSession` resumes the parent first and durably binds the child to that exact parent head. Oh snapshots that recorded historical operation reference, so a retry can reconcile a completed child commit after the parent advances without borrowing the parent's current head or operation authority. Parent cleanup is fenced while any reserved, creating, ambiguous, or recovery-required child still depends on that parent epoch; once the child is active or itself retired, the parent can be purged.
- `cleanupSession` covers archive, abandon, and expiry. It retains cleanup authority until the entire session directory is proven absent.
- `sweepExpired` selects a bounded page, then re-reads the exact epoch, revision, state, and expiry under the session lifecycle tail before cleanup. A renewal queued ahead of a stale sweep wins and cannot be purged by that old page. A host-owned cursor advances across eligible session IDs and wraps, so sixteen repeatedly failing cleanup rows cannot starve a later expiry.
- `recovery_required` is fail-closed but not terminal. A later host ensure or resume repeats exact inspection and restores `active` only when the immutable binding, handle, creation receipt, and accepted-head ancestry all re-prove. Exact archive or abandon cleanup remains available; tampered custody is never silently blessed.

The service uses a 30-day session-memory TTL. Every admitted live ensure uses the later of the durable session activity time and the current host time, so a live session recreated after an expiry sweep receives a future TTL instead of being purged again on each unchanged resume. Session start, local and remote mutation, provider observation, provider-list import, and successful note, preset, Fast-mode, and project commits renew after their durable activity. Terminal provider deletion, observation, list-import, and every recovery commit clean up immediately with reason `archive`; explicit abandonment uses `abandon`. Daemon recovery and commands scan retained sessions in bounded pages to retry any terminal cleanup whose local state commit preceded a crash. The scan is generation-fenced against concurrent terminal commits and isolates a failing terminal cleanup so it cannot block unrelated commands or startup; the failed generation remains eligible for a later retry. Explicit session abandonment proves memory cleanup before HRA releases the local recovery authority. HRA's existing provider cancellation and recovery semantics are unchanged.

An expired purge may be reactivated only by a later live-session ensure. That creates the next epoch with a new binding, operation keys, Oh realm, space, and directory. Archive and abandon never reactivate, including when either terminal observation arrives after an expired physical purge. The control database's v1 schema migrates transactionally into epoch 1. Empty-head rows remain directly compatible. A nonempty legacy row has no stored raw Oh operation reference, so it enters `recovery_required` and can return to active only when inspection re-proves the exact legacy sequence and digest while recovering the raw operation SHA. A legacy nonempty fork also lacks its parent's raw checkpoint reference and is cleanup-only; HRA will not infer ancestry from a sequence. Epoch-1 adapter sidecars are validated against the exact pre-v2 adapter and receipt digest preimages before migration. HRA migrates an empty create, or an empty fork whose initial and parent heads are both sequence zero, by inferring epoch 1 and explicit null operation references; a crash-left migration file is resumed only when its exact contents validate. Any old sidecar with a nonzero initial or parent sequence remains cleanup-only.

## Released Oh adapter

`OhSqliteFactsMemoryEngine` maps the lifecycle port to Oh's exact working-store profile:

1. one HRA binding selects one Oh realm, space, and `oh.sqlite` path entirely at host composition;
2. create accepts only an empty working store and publishes a bounded, checksummed lifecycle sidecar after closing it;
3. inspection verifies Oh replay and materialization while returning only HRA's opaque handle hash, immutable creation receipt, and current exact head; it uses Oh's historical head lookup to prove the last control-plane operation reference is an ancestor before accepting an advance;
4. a new fork requests an exact snapshot at the recorded parent operation reference, proves the returned sequence, operation SHA, and digest again, and copies the record bytes into a new child authority;
5. the child copy is one fresh host-owned operation, so it preserves record and dependency digests but deliberately does not copy the parent's operation IDs, actor authority, timestamps, or history;
6. HRA bounds a local fork independently of Oh's count-only SQLite snapshot API. Before any local store open and immediately around verification it validates that the logical sizes of `oh.sqlite` plus `oh.sqlite-wal` total at most 96 MiB. After the exact parent snapshot returns, HRA incrementally counts its JSON array encoding and requires at most 8 MiB before it opens or commits the child database. The count bound remains 8,192 records. A parent above either byte ceiling fails closed and leaves the child unfinalized; a valid oversized store is cleanup-only through its already validated lifecycle sidecar. Oh v0.2.0's separate 6 MiB component and 9,000,000-byte provider-response limits apply to libSQL, not to the local SQLite port;
7. replay after a completed child commit uses the same epoch-scoped host-derived operation ID and content, allowing Oh to reconcile a crash before metadata publication even when the parent has advanced;
8. quiesce reopens and verifies the exact authority, closes it, and returns custody to the broker, which removes the whole validated session directory.

The adapter does not call Oh's logical whole-space purge before physical cleanup. Doing so would create a crash state that could no longer be reopened for HRA's quarantine retry. The broker instead proves the only local authority is closed, validates and quarantines its sole session directory, and removes the complete directory before committing the HRA purge receipt.

This activates storage lifecycle, not a model-facing facts API. Oh's host-bound actor, program-purpose, and nomination-destination registries remain behind a future semantic host facade for Sponge and other consumers. Their remember, query, and nomination inputs do not enter HRA's lifecycle port or control database. Model input must never supply actor, time, operation ID, database locator, store, space, rules, nomination destination, or purge authority, and any future facade must retain Oh's released locator-free request and receipt shapes.
