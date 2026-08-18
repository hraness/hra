# Contents

- `migrations.ts` – immutable, checksummed SQLite control-plane schema migrations, including account tombstones, local task authority, durable due work, frozen promotion state, and private bounded chat-pane state.
- `control-plane-lock.ts` – no-follow, user-only, OS-released lifetime gate acquired after Application Support cutover and before the control-plane database opens.
- `application-support.ts` – exclusive, receipt-backed migration from historical desktop state roots to HRA, including no-follow validation, WAL recovery, rollback, and downgrade guards.
- `application-support-worktree-repair.ts` – journaled SQLite, recovery-manifest, external Git metadata, and moved-Codex-cwd repair after the Application Support root changes.
- `database.ts` – private database path, permissions, connection, and migration lifecycle.
- `release-compatibility.ts` – zero-mutation startup preflight plus explicit
  semantic-version/build downgrade fencing.
- `control-plane-backup.ts` – passphrase-encrypted, receipt-key-bound SQLite
  snapshots and journaled atomic restore/rollback.
- `operation-receipt-key.ts` – atomic per-install HMAC-key creation and private state-file permissions.
- `operation-receipts.ts` – persistent renderer-operation idempotency without retaining command payloads.
- `dispatch-store.ts` – fenced run bindings, coalesced display drafts, and the replay-safe semantic/display-event outbox.
- `dispatch-interaction-store.ts` – bounded provider-declared request projections, published markers, durable fair-run cursor, and answer-free applied/expired sync acknowledgements.
- `dispatch-runner-installation.ts` – stable installation identity, boot generation, accepted heartbeat sequence, and exact secret-free pending heartbeat replay.
- `local-task-store.ts` – account-free workspace onboarding, atomic portable task commands, keyed receipts, metadata-only renderer effect recovery and legacy quarantine, typed event sequences, and fixed-query atomic renderer-safe workspace projections with immutable list continuations.
- `chat-pane-store.ts` – private bounded chat panes, exact pane and turn revision clocks, provider-thread bindings, bounded local conversation history, idempotent turn receipts, and restart recovery.
- `chat-message-ledger-schema-v1.ts` and `chat-message-ledger.ts` – the additive app-owned FIFO message ledger, independent queue and row CAS clocks, bounded complete text, opaque ready-only attachment authority, lifecycle cuts, pause reasons, and restart reconciliation primitives.
- `local-task-due-work-store.ts` – boot generations, due-work claims, retry/backoff, queued-run intent fencing, and crash-after-start recovery scheduling.
- `local-task-authority-command-store.ts` – entity-specific due-work revalidation and atomic portable system-command execution with post-commit invalidation hints.
- `local-promotion-store.ts` – immutable local promotion snapshots, family digests, exact upload receipts, frozen authority phases, activation, and proven pre-activation aborts.
- `longitudinal-routing-schema-v1.ts` – additive content-free recursive-routing observations, materialized sufficient statistics, dirty-pane revisions, and immutable non-activating analysis receipts.
- `root-turn-routing-schema-v1.ts` – private content-free ordinary-root classification, resolution, effect, acceptance, terminal, recovery, and privacy-deletion receipt schema.

# Guidelines

- Store only HRA control-plane mappings, redacted diagnostics, and the explicitly private bounded chat-pane text needed to render the latest response or begin a later user-authored turn after an account change. Codex remains authoritative for full transcripts, provider turns, and credentials.
- Treat chat prompts, response tails, reasoning summaries, provider bindings, and local conversation history as private local data. Enforce per-field, per-pane, and database-wide byte ceilings before writes; never expose provider IDs, canonical paths, historical text, or truncation internals to the renderer.
- Keep pane, turn, message-queue, message-row, legacy-continuation, delta-offset, and provider-binding transitions in one SQLite transaction with exact independent CAS revisions. A duplicate turn or message ID may replay only through its owning durable receipt; changed input is a conflict, late activity is ignored or rejected by the owning state transition, and restart converts every uncertain effect to an explicit paused or ambiguous state without replaying provider effects. Legacy continuation rows are recovery input only and cannot authorize a provider mutation.
- Allocate message FIFO ordinals monotonically per pane and never reuse an app-owned message ID. Only the exact queued head may be claimed for start or steering. Composer enqueue-and-steer is one transaction: an older head, paused queue, or changed turn fence rolls back the new row and draft conversion instead of creating future ordinary work. Persist preparation before any provider effect, persist effect-start before the call, never retry an effect-started row automatically, and retain an ambiguous fence until explicit containment. Stop, runtime restart, attention, and ambiguity pause draining; a renderer resume cannot clear ambiguity.
- Keep queued text complete under the per-message, per-pane, and database-wide byte ceilings, with a bounded row count that keeps the 64-pane Native snapshot below its serialized ceiling. Queue revision never substitutes for pane streaming revision, and each editable row has its own exact CAS revision. Pane close cancels queued and prepared-no-effect rows in the same archive transaction, but rejects ambiguous rows and every effect-started row, including an acknowledged effect awaiting terminal settlement.
- Normalize attachment references under each ledger row and prove ready state, a live same-pane draft lease for each new binding, and same-pane authority inside the exact enqueue/edit transaction. Claim must recheck readiness and acquire the complete turn-lease set before returning provider-ready content; prepared rollback releases it, effect ambiguity retains an ambiguous lease, and exact terminal settlement releases it. Never admit a `localImage` provider effect until a separately wired provider-thread lease durably pins every delivered attachment across terminal queue cleanup, history pruning, pane archive, account privacy deletion, and ambiguity containment. Attachment IDs are opaque; no path, filename, provider value, byte payload, or stale preflight result belongs in the ledger or renderer projection.
- Preserve removed-profile tombstones and local-data state until the separate full-home deletion completes; never persist login authority or human-in-the-loop answers.
- Append migrations instead of rewriting an applied migration, and reject checksum drift at startup.
- Check release and migration compatibility through a read-only connection
  before chmod, writable open, pragmas, or migration. Atomically fsync a
  monotonic external minimum-reader/intended-migration fence before the first
  writable SQLite open, then record the checked build only after compatible
  startup completes. Checkpoint its database copy before returning. Immutable
  preflight may ignore a crash WAL because future migration intent is already
  durable in the external fence.
- Keep backup passphrases and decrypted archive payloads in memory. Persist only
  the encrypted archive or the private destination database/key pair; restore
  from fixed, path-free, bounded journals and roll back every partial publish.
- Complete Application Support cutover, integrity checks, and path repair before accounts, Codex, or cloud dispatch can start. Never merge roots or follow a link or special file during migration.
- Keep database and parent-directory permissions user-only. The authoritative connection must prove foreign keys, WAL, FULL synchronization, and `trusted_schema=OFF` before migrations or state access.
- Bind operation receipts with the separate per-install HMAC key; never retain commands or unkeyed command digests.
- Acquire and retain the control-plane lifetime lock before opening SQLite; process metadata is diagnostic only and must never override the OS-released lock.
- Keep local command projection changes, portable events, and HMAC-bound receipts in one SQLite transaction. Exact replay returns the stored receipt; digest drift is a conflict.
- Prepare and CAS-start each renderer-originated local mutation before its effect. Recompute the prepared fingerprint from the complete materialized command, bind its exact keyed receipt digest during the start CAS, and require the same binding before execution. Persist only operation and workspace IDs, command kind, keyed fingerprints, state, revisions, and timestamps. Inspect a started attempt non-destructively against the exact local receipt from the serialized gateway queue. Settle receipt-linked evidence only through a later explicit reconciliation; receipt absence proves not-applied only in that queue. Terminally quarantine a legacy unbound attempt that already has a receipt as ambiguous so it cannot authorize success or strand the workspace. Never persist a command, prose, interaction answer, path, provider value, or unkeyed fingerprint, and never replay an ambiguous effect automatically.
- Bind task-page cursors to workspace revision and filter scope. Bound workspace, repository, task, detail, event, due-work, and promotion reads before they cross a repository boundary.
- Preflight repository readiness before entering an atomic workspace projection transaction. Capture one display time, keep every SQLite read in that one transaction, and batch list, claim, run, interaction, and selected-detail collections with query counts independent of result cardinality.
- Treat canonical repository path plus Git common-dir as the trusted onboarding identity. Repeated identity returns the existing opaque repository and initial workspace; unrelated candidate-ID collisions remain retryable and no path enters a safe summary.
- Never requeue a queued-run intent after its side effect starts. A new boot fences the old process and schedules explicit run recovery; only a pre-side-effect claim may return to the queue under a higher fence.
- Keep each due row's semantic `due_at` immutable across retries; move only `not_before_at` for backoff so deadline, revision, and fence revalidation still describes the original work.
- Revalidate the claimed due row, current boot, deadline, entity revision, and fence in the same outer transaction as each system command and due-row settlement. Publish invalidation only after a new committed receipt; replay and stale work stay silent.
- Freeze and validate the complete promotion snapshot before the first cloud write. Promotion storage may contain only strict portable entities and receipts, never local paths, credentials, commands, interaction answers, or live run internals.
- Parse database rows from `unknown` before returning them from a repository boundary.
- Keep longitudinal routing observations immutable and low-cardinality. Derived usage rows and arm statistics may change only through exact observation, late positioned-token, or privacy-deletion triggers; pane deletion must remove the complete derived history. Never persist content, provider or account identity, repository data, paths, filenames, or timestamps in the model-visible projection.
- Admit one root-turn routing classification in the same transaction as each ordinary chat turn. Keep it independent of prunable `chat_turn_receipts`; reject a historical routing identity even after its bounded chat receipt is gone. Advance resolution, provider-effect, accepted generation/stream position, and terminal evidence monotonically through the narrow authority. Restart maps pre-effect work to `notApplied`, an unaccepted effect to `ambiguous`, and an accepted effect to `interrupted`. Pane archive or deletion removes the complete root-route ledger.
- Bind a dispatch row to its repository, runner boot, claim ID, and fence before any side effect. Keep event sequence and outbox append in one SQLite transaction.
- Persist only the explicitly public reasoning-summary and assistant-message display channels as bounded drafts. Materialize drafts into immutable ordered outbox events before later semantic events, and cap display events independently so terminal capacity cannot be consumed by streaming.
- Advance boot generation only after a prior boot has an accepted heartbeat; replay an unacknowledged first heartbeat with the same identity.
- Persist the strict pending heartbeat before network access and clear it atomically with acknowledgment, so process restart cannot reuse one clock with a changed capability fingerprint.
- Mark accepted interaction upserts published and rotate active runs with the durable cursor. Persist settlement revision and reason only; never persist response plaintext, sealed ciphertext, provider mappings, or private reply keys.
