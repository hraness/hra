# Session facts memory

HRA has a narrow host-owned lifecycle seam for session facts memory. HRA coordinates custody. Oh owns the semantic store, graph, query, projection, and rule behavior.

The daemon composes a concrete local adapter for release-verified Oh v0.2.0. `package.json` pins its immutable release tag and `bun.lock` resolves exact commit `89fb133`. HRA does not vendor Oh or reproduce its graph and Datalog semantics. The adapter imports only Oh's base, store, and SQLite surfaces; neither Suss nor Cozo is an HRA runtime dependency.

## Authority boundary

HRA derives one binding from the exact account ID and session ID. One HRA session is one facts-memory branch; a fork creates a different child session bound to one immutable checkpoint of its exact parent session. A caller cannot select a database, directory, branch namespace, space, authority, rule set, query engine, or purge credential. No facts-memory command exists in the local command union.

The lifecycle control database may contain only:

- the account and session IDs;
- their binding digest;
- fixed create, fork, cleanup, and expiry state;
- an opaque handle hash;
- exact public store heads and receipt digests;
- an exact parent binding and head for a fork;
- bounded timestamps, reasons, and revisions.

It has no column for facts, records, payloads, rules, projections, credentials, tokens, database paths, or raw handles. Semantic data remains in Oh.

## Local layout

HRA keeps lifecycle metadata in `facts-memory-control.sqlite` under its private state root. Each session's Oh database, adapter lifecycle sidecar, and every related SQLite WAL, SHM, projection cache, and derived cache belong under one host-derived directory:

```text
<HRA state root>/facts-memory-sessions/<exact session ID>/
```

The directory path never enters the lifecycle database or a command response. HRA requires an absolute canonical current-user-owned mode-0700 root, rejects symbolic links and path traversal, bounds recursive inspection, and rejects linked or replaced entries before cleanup. The adapter opens SQLite and metadata through no-follow custody, enforces and reads back mode 0600 on `oh.sqlite`, its observed WAL and SHM files, and its metadata, and relies on the enclosing mode-0700 directory for any transient or future cache entry it does not interpret.

Cleanup first asks the Oh adapter to quiesce the exact store. HRA then revalidates the complete session tree, atomically renames it to a host-derived quarantine name, and removes that whole tree. A retry completes a crash-left quarantine instead of replaying semantic operations. A purge receipt is committed only after both the live and quarantine paths are absent.

This is honest local custody, not a sandbox or forensic erasure guarantee. Another process running as the same operating-system user can read or race local files despite these checks. Backups, filesystem snapshots, and storage media may retain prior bytes.

## Lifecycle

The lifecycle implements these internal host operations:

- `ensureSession` reserves authority before store creation, reconciles a lost create response by exact inspection, and never speculatively creates a second store.
- `resumeSession` revalidates owner, session, opaque handle, immutable creation receipt, and a monotonic exact head.
- `forkSession` resumes the parent first and binds the child to that exact parent head. A retry uses the recorded checkpoint even if the parent later advances.
- `cleanupSession` covers archive, abandon, and expiry. It retains cleanup authority until the entire session directory is proven absent.
- `sweepExpired` processes a bounded page. The service uses a 30-day session-memory TTL and extends it only from persisted HRA session activity.

Session start and provider resume call the lifecycle seam. A terminal provider state cleans up with reason `archive`. Explicit session abandonment proves memory cleanup before HRA releases the local recovery authority. HRA's existing provider cancellation and recovery semantics are unchanged.

## Released Oh adapter

`OhSqliteFactsMemoryEngine` maps the lifecycle port to Oh's exact working-store profile:

1. one HRA binding selects one Oh realm, space, and `oh.sqlite` path entirely at host composition;
2. create accepts only an empty working store and publishes a bounded, checksummed lifecycle sidecar after closing it;
3. inspection verifies Oh replay and materialization while returning only HRA's opaque handle hash, immutable creation receipt, and current exact head;
4. a new fork verifies the parent's exact current head, requests an exact snapshot at that Oh head, proves the returned head again, and copies the record bytes into a new child authority;
5. the child copy is one fresh host-owned operation, so it preserves record and dependency digests but deliberately does not copy the parent's operation IDs, actor authority, timestamps, or history;
6. the released working lane bounds an exact fork to 8,192 records; a larger parent fails closed and leaves the child unfinalized;
7. replay after a completed child commit uses the same host-derived operation ID and content, allowing Oh to reconcile a crash before metadata publication;
8. quiesce reopens and verifies the exact authority, closes it, and returns custody to the broker, which removes the whole validated session directory.

The adapter does not call Oh's logical whole-space purge before physical cleanup. Doing so would create a crash state that could no longer be reopened for HRA's quarantine retry. The broker instead proves the only local authority is closed, validates and quarantines its sole session directory, and removes the complete directory before committing the HRA purge receipt.

This activates storage lifecycle, not a model-facing facts API. Oh's host-bound actor, program-purpose, and nomination-destination registries remain behind a future semantic host facade for Sponge and other consumers. Their remember, query, and nomination inputs do not enter HRA's lifecycle port or control database. Model input must never supply actor, time, operation ID, database locator, store, space, rules, nomination destination, or purge authority, and any future facade must retain Oh's released locator-free request and receipt shapes.
