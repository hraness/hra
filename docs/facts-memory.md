# Session facts memory

HRA now has a narrow host-owned lifecycle seam for session facts memory. HRA coordinates custody. Oh owns the semantic store, graph, query, projection, and rule behavior.

The default Oh adapter is intentionally not bound yet. Oh v0.2.0 is release-verified and immutable at commit `89fb133`; this source tree defines and tests the lifecycle side of its adapter boundary without vendoring or reproducing Oh.

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

HRA keeps lifecycle metadata in `facts-memory-control.sqlite` under its private state root. Each session's Oh database and every related SQLite WAL, SHM, projection cache, and derived cache belong under one host-derived directory:

```text
<HRA state root>/facts-memory-sessions/<exact session ID>/
```

The directory path never enters the lifecycle database or a command response. HRA requires an absolute canonical current-user-owned mode-0700 root, rejects symbolic links and path traversal, bounds recursive inspection, and rejects linked or replaced entries before cleanup.

Cleanup first asks the Oh adapter to quiesce the exact store. HRA then revalidates the complete session tree, atomically renames it to a host-derived quarantine name, and removes that whole tree. A retry completes a crash-left quarantine instead of replaying semantic operations. A purge receipt is committed only after both the live and quarantine paths are absent.

This is honest local custody, not a sandbox or forensic erasure guarantee. Another process running as the same operating-system user can race path-based checks. Backups, filesystem snapshots, and storage media may retain prior bytes.

## Lifecycle

The lifecycle implements these internal host operations:

- `ensureSession` reserves authority before store creation, reconciles a lost create response by exact inspection, and never speculatively creates a second store.
- `resumeSession` revalidates owner, session, opaque handle, immutable creation receipt, and a monotonic exact head.
- `forkSession` resumes the parent first and binds the child to that exact parent head. A retry uses the recorded checkpoint even if the parent later advances.
- `cleanupSession` covers archive, abandon, and expiry. It retains cleanup authority until the entire session directory is proven absent.
- `sweepExpired` processes a bounded page. The service uses a 30-day session-memory TTL and extends it only from persisted HRA session activity.

Session start and provider resume call the lifecycle seam. A terminal provider state cleans up with reason `archive`. Explicit session abandonment proves memory cleanup before HRA releases the local recovery authority. HRA's existing provider cancellation and recovery semantics are unchanged.

## Oh adapter requirements

The `LocalOhFactsMemoryEnginePort` implementation for immutable Oh v0.2.0 must:

1. initialize one working-profile SQLite authority inside the provided directory;
2. return only the strict public receipt and inspection types;
3. preserve the immutable creation receipt while reporting the current exact head separately;
4. fork only after verifying the exact parent binding and head supplied by HRA;
5. quiesce all local handles before HRA renames and removes the directory;
6. remain idempotent for the host-fixed operation key;
7. keep facts, rules, projections, paths, credentials, raw locators, and purge capabilities behind the adapter.

Activation requires a reviewed mapping from these port methods to the release-verified Oh v0.2.0 store/profile API. Until that mapping exists, HRA does not construct a placeholder semantic store or claim that the optional memory backend is active.

Oh's host-bound program-purpose and nomination-destination registries remain behind that future adapter. Their semantic query and nomination inputs do not enter HRA's lifecycle port or control database.

The future Oh factory binds actor identity at host composition. Model input never supplies actor, time, operation ID, database locator, or purge authority; semantic remember, query, and nomination calls must preserve Oh's released locator-free request and receipt shapes.
