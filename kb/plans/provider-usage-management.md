---
title: Provider usage management
description: Implementation plan for provider-scoped account authority, truthful Codex and Claude usage observations, safe exhaustion handling, ordered local accounts, and browser and CLI visibility.
type: plan
status: in-progress
area: hra
tags:
  - app
  - claude
  - codex
  - convex
  - usage
---

# Provider usage management

## Outcome

HRA will expose one truthful usage-management model for Codex and Claude without pretending that the providers expose equivalent data. Each machine will keep an ordered, provider-scoped account list and one active default account per provider. Codex will preserve its existing weekly reset-credit behavior and may move an automatically managed session to the next fresh, signed-in Codex account after reset handling is exhausted. Claude sessions will start with the pinned CLI's native Fable-to-Opus fallback armed at max effort only when automatic usage management is enabled and the exact pinned live-acceptance gate has passed; otherwise the fallback remains visibly unavailable. HRA will not infer a model-specific Claude quota or speculatively replay a turn.

The CLI and encrypted browser settings projection will show every observation with its source and observation time, the active/default account, account order, readiness, reset windows, reset credits where the provider exposes them, current automatic-policy state, and a plain-language explanation of the next supported action. Claude data will always be labelled as observed during a particular turn, never as a current account-wide read.

## Owner decision and adversarial corrections

The request attached to this work deliberately changes the earlier HRA v1 decision that all account selection is operator-directed. The governing contract will be updated visibly, but only for the bounded automatic behavior proven by this plan. Explicit operator selection remains authoritative and can choose a non-default account.

The supplied implementation prompt is not executable as written. This plan adopts these corrections:

| Supplied assumption | Approved decision |
| --- | --- |
| A profile is one provider account. | A profile remains an isolation container with both provider homes. A provider-account binding under that profile owns provider-specific readiness, credential generation, ordering, active/default state, usage authority, and local identity. |
| Existing SQLite objects may be rewritten in place. | Storage changes use append-only, transactional, restart-idempotent schema migrations from schema version 34. Existing rows remain readable. |
| The existing usage payload is provider-neutral. | Introduce a discriminated usage observation v2. Continue decoding Codex v1 byte-for-byte. Claude turn accounting is never represented as a Codex lifetime counter. |
| Any old observation may select the next account. | Missing, malformed, unknown, or stale observations cannot authorize an automatic mutation. Exhausted evidence may remain valid only through its identified reset boundary. |
| Claude unified windows prove a Fable-specific quota. | Unified windows are account-level unless an admitted provider field explicitly identifies a model scope. Current Claude fixtures do not establish model-scoped quota. |
| HRA should restart a Claude thread under Opus. | The exact pinned Claude CLI supports native `--fallback-model` in print mode. HRA will arm Fable with the pinned Opus fallback at process start and preserve max effort. HRA will not build an unproven resume/replay path. |
| The five proposed policy actions cover all input. | Add closed `observe_only`, `disabled`, and `reconciliation_required` results. Unknown evidence must be representable without guessing. |
| Existing `session.switch` is safe for automation. | Harden it with action-specific durable evidence, target authority locking, crash recovery, and idempotent seed delivery before any automatic caller may use it. |
| Session classifier state proves replay safety. | HRA will not author an automatic continuation or replay in this release. Lexical `working` classification is advisory only. Claude's pinned native fallback owns any in-turn continuation it can perform. |
| One daily hosted snapshot is fresh enough for settings. | Keep the daily history and add a revisioned current head. Project source device and provider-account join identities so the browser can explain freshness honestly. |
| The hand-written command list is the final gate. | The repository's authoritative aggregate gate is `bun run check`. It runs once after convergence through the HRA host scheduler's heavy compute lane. |

## Semantics and safety boundaries

### Provider-account identity

- A provider-account binding is identified locally by `(profileId, provider)` plus an HRA-owned binding generation.
- Every non-removed profile owns one Codex binding and one Claude binding because both isolated provider homes already exist. A new or migrated Claude binding begins `unverified`; it does not become signed in merely because the Codex binding is signed in.
- Existing Codex public account IDs, usage history, reset-policy identity, and profile behavior remain stable.
- Claude receives a distinct opaque local public ID. It is not claimed to be the same subscription across machines unless the pinned provider later exposes a stable, admitted identifier.
- Raw auth output, provider payloads, credentials, email addresses not already admitted by existing Codex handling, and provider thread content never enter usage storage or hosted sync.
- Provider readiness is separate. Codex continues to derive it from the existing supervised account authority. Claude uses a bounded read-only `claude auth status --json` probe in the profile's isolated configuration directory. The exact pinned unauthenticated probe admits only the observed exit-1 signed-out shape; no authenticated shape has been admitted, so every would-be signed-in result remains `unverified`. `unverified` is truthful non-proof: it may be attempted only by user-initiated Claude work under exact authority and can never prove an automatic rotation target. `signed_out`, `recovery_required`, and `removed` remain non-dispatchable.
- Provider-account generation is an execution fence, not display metadata. New session, turn, interaction, switch, queue, reset, and remote-command evidence binds the provider, binding ID, binding generation, and the applicable provider-scoped runtime process generation. The legacy profile process generation remains the Codex compatibility mirror; Claude owns an independent process generation. Only legacy account-scoped login, usage, reset, and desktop-switch evidence decodes through the Codex compatibility binding. A Codex process restart does not silently become Claude authority, and an HRA-observed Claude readiness transition does not invalidate an unrelated Codex process. A binding transition never rewrites a session's captured authority in place: stale sessions and effects remain fenced until a separately proved journaled rebind.
- Claude's admitted auth status does not expose stable subscription identity. Its binding generation fences only HRA-owned transitions and observed readiness changes; it cannot detect an out-of-band credential replacement that remains logged in. Claude observations therefore remain turn-local under an opaque machine binding, never form a cumulative account counter, and cannot authorize automatic account movement.

### Active/default account

- Exactly one non-removed provider-account binding may be the active default for each provider on a machine when at least one binding exists.
- Initial order is deterministic by profile creation time and then profile ID. Migration chooses the first signed-in Codex binding in that order, or the first binding when none is signed in; Claude begins on the first unverified binding. Profile creation appends to both orders. Profile removal soft-removes both provider bindings, compacts both orders, and advances an affected pointer to the next surviving binding in the prior order, wrapping once.
- Active means the default and automatic-rotation cursor for new or automatically managed work. It is not a provider-wide execution lease.
- Session account selection records `explicit` or `managed` routing provenance. Existing sessions migrate as `explicit`; an explicit account selector creates an `explicit` session; omitting the selector creates a `managed` session from the active binding.
- An explicit account selector remains sovereign. It may start or continue a session on a non-default account and automatic account rotation never rehomes it.
- Changing the pointer never moves an existing session by itself. A session moves only through an explicit switch or a separately authorized automatic action.
- Order edits are exact permutations of the current eligible bindings. Invalid, duplicate, missing, or cross-provider selectors make the whole mutation inert.

### Observation authority and freshness

- Codex observations come from the existing account poll/read path. A below-threshold observation may authorize selection only while it is no more than 90 seconds old, and the coordinator performs an authoritative reread of source and target before a movement. The existing 15-minute failure backoff therefore becomes visibly stale and non-authoritative for mutation.
- Claude observations come only from a particular session turn. The UI always displays their exact observation time and turn provenance. A blocking event may establish that the source account was exhausted through its reset boundary, but an old `allowed` observation cannot prove that a different Claude account is currently available.
- Provider reset timestamps use the existing bounded seconds-to-milliseconds conversion. Impossible timestamps, non-finite values, negative utilization, unbounded maps, and unknown statuses are rejected or reduced to non-authoritative observations.
- Usage exhaustion remains `99` percent used, meaning 1 percent remaining. The existing Codex weekly-reset decision remains the sole reset-credit authority and retains its legacy primary-window fallback behavior.

### Automatic behavior

Automatic management uses a default-enabled baseline and a closed per-provider `inherit | on | off` override. `defaultEnabled` supplies only the value inherited by a provider, so an explicit provider `on` remains effective when the default is off; it is not a master global kill switch. An effective disable prevents new automatic actions but does not undo an already settled provider effect.

1. A fresh Codex observation below 99 percent continues.
2. At or above 99 percent on the admitted weekly Codex window, an available reset credit is consumed through the existing reset attempt state machine before any account move. The daemon rereads usage before another decision.
3. Codex has an empty model ladder.
4. If no reset action remains, the Codex active pointer may advance by transactional compare-and-swap to the next signed-in binding with a fresh below-threshold observation. The order wraps at most once. A `managed` Codex session bound to the exhausted account may move through the hardened switch state machine; an `explicit` session is left in place with an explanation.
5. If no proved Codex target exists, HRA reports the earliest still-valid recheck boundary and waits visibly. A reset time does not prove that an account will be available. HRA does not spin or probe accounts with provider effects.
6. A Claude process starts on pinned Fable at max effort with pinned Opus as the CLI-native fallback when automatic management is enabled only after exact pinned authenticated acceptance proves Opus with max effort and proves that the combined primary/fallback argv starts successfully. HRA reports the fallback as armed, but does not claim which model ran unless the terminal result names it. If live proof is unavailable, fallback remains unavailable rather than being enabled from argv help or binary strings alone.
7. HRA does not automatically rotate Claude accounts in this release. The provider has no admitted noninteractive usage read for an idle candidate, so HRA cannot prove a target is available before moving work. Claude ordering, activation, readiness, usage capture, and manual switching still ship. A later plan may enable rotation after exact pinned evidence supplies target authority.
8. No observation callback performs an effect inline. It sanitizes and persists a bounded fact, then enqueues evaluation after callback return.
9. HRA does not send an automatic continuation after a model or account transition in this release. A provider-native fallback may continue its own in-flight Claude request. Every interrupted, failed, or ambiguous provider outcome remains visible for explicit operator action and is never replayed by classifier inference.
10. Observation-triggered evaluation may move only the active pointer. It never starts a provider thread or sends a transcript seed. A managed session moves only at its next explicit send boundary through one crash-safe `switch_and_forward` action that combines the bounded transcript handoff and that exact pending user input into one target turn. It never sends the current `Continue the work` seed and then dispatches the input as a second turn. Pre-effect sizing preserves the pending input and attachments exactly, truncates transcript context first, and refuses inertly if minimum framing plus the legal input cannot fit the target message bound.
11. Pointer advancement requires the exhausted source binding to equal the current active binding. Each settled move records from/to binding IDs, from/to pointer revisions, order revision, `automaticPolicyRevision`, and source/target observation authority. A managed session stores the last pointer revision it applied and may follow only a contiguous settled move chain from its bound account; a gap, branch, or reset requires reconciliation instead of guessing from the current pointer.

## Non-goals

- No populated Codex model fallback ladder.
- No HRA-driven Claude model restart, resume, or replay based on inferred quota scope.
- No automatic Claude account rotation without an authoritative candidate-availability read.
- No HRA-authored automatic continuation or replay after interruption, failure, model fallback, or account movement.
- No cross-machine active-account coordination or cross-machine Claude subscription matching.
- No hard provider-wide lease that blocks an explicit operator-selected account.
- No billing budgets, forecasts, or decisions based on Claude cost data. Bounded cost and model accounting are informational only.
- No raw provider event or auth payload persistence.
- No background scheduler or speculative wake loop. Existing daemon observation and turn boundaries trigger evaluation.

## Constraints and convergence ownership

- Follow every applicable `AGENTS.md`, `CONTRIBUTING.md`, `WRITING.md`, `STYLE.md`, and hosted deployment rule.
- Keep Bun pinned at 1.3.14 and preserve the exact Claude Code 2.1.260 and Codex package pins unless a separately reviewed pin update is required.
- One storage integration owner owns schema versions, migrations, `state-store.ts`, and store fixtures across all phases.
- One daemon integration owner owns `service.ts`, runtime coordination, action journals, lock ordering, and restart recovery. Workers may propose focused changes but do not merge overlapping service edits independently.
- One cloud contract owner owns payload versions, exact-key parsers, byte bounds, Convex schema/functions, and daemon adapters.
- One CLI contract owner owns parsers, JSON schemas, help, and renderer compatibility.
- One app contract owner owns wire types, decryption, framework-free view models, tests, and settings rendering after the hosted contract is fixed.
- Generated protocol pins, security primitive inventories, manifests, and lockfiles are convergence files. Only the integration owner updates them, and only when the owning command proves they changed.
- Every provider effect has one durable owner and one event-driven waiter. No provider effect runs from the Claude fact-reader callback.
- Phase implementers run focused validation and report exact results. Independent reviewers check acceptance criteria before the phase advances. The integration owner runs the aggregate gate once after convergence.

## Phase map

| Phase | Outcome | Depends on | Write scope | Parallel with |
| --- | --- | --- | --- | --- |
| 1 | Governing contract and pinned Claude capability become explicit | none | plans, root/public contract docs, Claude capability fixtures and focused pin/runtime tests | none |
| 2 | Provider-account and session authority with append-only migration | 1 | storage account/session types, authority adapters, migration, provider readiness, focused tests | none |
| 3 | Provider-neutral usage observation v2 and Claude capture | 2 | usage domain, Claude protocol/assembler/facts, usage store, focused tests | none |
| 4 | Crash-safe manual session/account switching | 2 | switch attempt storage, daemon switch/recovery/locking, switch tests | none |
| 5 | Pure exhaustion policy, durable configuration, and explanations | 3 | usage-policy domain, policy store, tests, no provider effects | 4 for domain-only work; storage waits for convergence |
| 6 | Supported runtime actions without speculative replay | 4, 5 | daemon coordinator, existing reset integration, Codex pointer and switch-and-forward actuation, Claude runtime fallback, action tests | none |
| 7 | CLI account order, activation, optional start account, usage, and policy controls | 6 | CLI parser/client/renderers and command schemas | none |
| 8 | Hosted current usage and session-join contract | 7 | cloud payloads/adapters/Convex, daemon upload, hosted docs | none |
| 9 | Browser settings usage visualization | 8 | app wire/data/model/screens and app tests | none |
| 10 | Contract convergence, final review, aggregate validation, and delivery | 9 | maintained docs, plan status/log, convergence artifacts only if proven | none |

## Phase 1: Contract decision and pinned Claude capability

- **Status:** Done
- **Depends on:** none
- **Objective:** Make the changed account-management boundary explicit and prove the exact Claude runtime behavior used by later phases.
- **Scope:** `AGENTS.md`, `src/claude/AGENTS.md`, `src/daemon/AGENTS.md`, `README.md`, `kb/plans/hra-v1.md`, `docs/providers/claude.md`, Claude pin/runtime argument construction and focused tests or reviewed text fixtures.
- **Out of scope:** Account schema, usage persistence, policy effects, hosted projection.
- **Approach:** Replace the blanket no-rotation language with the bounded rules in this plan. Preserve explicit operator routing. Represent the pinned Claude ladder as reviewed data, but use it only to build `--model claude-fable-5-1 --fallback-model claude-opus-5 --effort max` after a sanitized exact-version authenticated acceptance fixture proves Opus with max effort and proves that the combined argv starts to an ordinary terminal result. The acceptance need not and must not claim that a forced fallback was observed. If a suitable isolated signed-in profile or provider access is unavailable, keep the runtime fallback capability disabled and project `unavailable: live_acceptance_required`. Admit terminal result model identity separately from quota scope.
- **Acceptance criteria:**
  - Root, daemon, Claude, public, and active-plan governance agree that Codex-only automatic account movement is allowed under fresh exact evidence, while speculative rotation and replay remain forbidden.
  - The exact pinned Claude build and the runtime-profile digest cover the fallback model and max effort.
  - Runtime argument tests prove fallback enabled and disabled forms without starting a provider process.
  - A sanitized live evidence record proves exact Claude Code 2.1.260 accepts Opus with max effort and starts with Fable plus Opus fallback, or the shipped capability remains disabled with an exact unavailable reason. No credential, configuration path, prompt, or raw provider payload enters the record.
  - Unknown or absent model identity remains representable.
  - No automatic effect is reachable in this phase.
- **Validation:** `bun test ./src/claude ./src/domain/presets.test.ts ./src/storage/state-store.test.ts --isolate --max-concurrency=1`; exact pinned live acceptance through an existing isolated signed-in Claude profile when available, with only sanitized version/model/effort/argv-shape/result evidence retained.

## Phase 2: Provider-account and session authority with migration

- **Status:** Done
- **Depends on:** Phase 1
- **Objective:** Give Codex and Claude independent local account authority and bind every new provider effect to it while preserving profiles as isolation containers.
- **Scope:** Provider-account records and schemas, session routing provenance, provider-account fields in runtime/session/turn/interaction/switch/queue/remote evidence, authority adapters and ports, append-only migration from v34, storage and service APIs, Codex compatibility mapping, bounded Claude auth-status probe, storage and adapter tests.
- **Out of scope:** Usage observations, policy decisions, session movement, hosted sync.
- **Approach:** Add a child authority keyed by profile and provider with local public ID, readiness, HRA-owned binding generation, provider-scoped process generation, order position, active/default revision, and timestamps. Create both bindings for every non-removed profile on migration and on later profile creation; Codex mirrors the established authority and legacy profile process generation while Claude starts unverified with independent process authority. Preserve existing Codex profile IDs and public IDs. Backfill deterministic order and active pointers by the rules above. Migrate existing sessions with `explicit` routing provenance and no applied pointer revision; Phase 2 adds the internal managed-session primitive but keeps the public local selector required until Phase 7. Persist the exact captured binding and process generations in session/effect sidecars; never synthesize historical authority from a mutable current profile or account and never retroactively advance session bindings after a readiness change. Make full provider authority mandatory on every live runtime, callback, and client protocol; legacy optional shapes exist only at storage decode and must be upgraded from immutable evidence or quarantined before reaching a live port. For legacy session-scoped evidence, derive the binding only from its immutable historical runtime profile or other immutable per-effect or per-turn provider authority, never from the session's mutable current provider; durably quarantine any unsettled local or cloud row whose historical provider cannot be proved without guessing. Map account-scoped legacy login, usage, reset, and desktop-switch rows to Codex. Every newly prepared reset attempt freezes and revalidates the exact Codex binding and provider-scoped process generation before dispatch. Desktop switching always carries and revalidates an exact target authority. It carries a source authority only when independent process evidence proves that source; migration and recovery leave an unproved source absent and never infer it from the active pointer. Logout and quarantine atomically retire every old exact authority before advancing the binding, with the existing transition triggers still enforced. Enforce one active row per provider and total deterministic order with transactional compare-and-swap. Probe Claude only on explicit refresh or user-initiated session start, admit only the exact observed signed-out matrix, and never store raw auth-status output. An unverified Claude binding may be attempted by that user-initiated start or an existing explicitly bound session, but it is never candidate-availability evidence. Since the pinned Claude transport has no resume path, daemon or binding loss terminally quarantines both active and idle nonterminal Claude sessions with explicit abandon/new-session guidance; HRA never invents a resume. Do not claim to detect a logged-in out-of-band Claude credential swap.
- **Acceptance criteria:**
  - A profile can hold distinct Codex and Claude readiness and generations without aliasing.
  - Existing Codex rows, selectors, public IDs, login/logout, sessions, usage, and reset policy read identically after migration.
  - Re-running an interrupted migration is safe and produces no duplicate binding or order position.
  - Removing a profile soft-removes both bindings; an HRA-owned sign-out/login transition or an observed readiness transition invalidates stale provider-account authority. Claude's inability to detect a still-logged-in out-of-band replacement is explicit in public state and tests.
  - Codex and Claude process generations advance independently; the Codex generation remains byte-compatible with the legacy profile mirror, and no transition silently upgrades captured session authority.
  - Every newly prepared provider effect and interaction, including reset attempts, validates the provider-account generation in addition to the applicable provider-scoped runtime process generation; account-scoped legacy Codex evidence remains recoverable through its compatibility binding.
  - No live runtime, callback, client, desktop-switch, or recovery path accepts providerless effect authority. A desktop-switch target is always exact across restart and effect boundaries; its source is exact only when independently proved and otherwise remains absent, never inferred from the active pointer.
  - Settled and unsettled legacy Claude session, turn, switch, queue, and interaction evidence migrates through immutable historical Claude runtime/effect authority or is narrowly quarantined; no legacy Claude row is blessed as Codex.
  - Every migrated session is explicitly routed, while a newly omitted local selector can be durably distinguished as managed.
  - Order replacement is atomic and exact; invalid permutations produce no mutation.
  - Migration and profile lifecycle produce the exact deterministic order, initial active choice, append behavior, and removal repair stated above.
  - Claude auth output outside the admitted bounded signed-out schema yields `unverified` and is not persisted raw; user-initiated Claude work may attempt an unverified binding, but automatic target selection cannot use it as availability proof.
  - A lost Claude daemon/runtime deterministically quarantines active and idle nonterminal Claude sessions without resume or replay; later observation returns actionable recovery state rather than an unhandled adapter error.
- **Validation:** Repaired focused service and storage slices each passed `3 pass/0 fail`; typecheck and diff checks passed. Root integration passed `366 pass/0 fail` with `3368 assertions` through `hra-host-run --mode=heavy --lane=compute --label=hra-phase2-provider-authority -- bun test ./src/storage/state-store.test.ts ./src/daemon/claude-runtime-adapter.test.ts ./src/daemon/claude-session.test.ts ./src/daemon/service.test.ts --isolate --max-concurrency=1`.

## Phase 3: Provider-neutral usage observation v2

- **Status:** Done
- **Depends on:** Phase 2
- **Objective:** Persist truthful, provider-discriminated Codex and Claude usage without changing existing Codex behavior.
- **Scope:** Usage observation types/parsers, truthful provider-specific observation provenance, Claude rate-limit and result parsing, assembler and daemon fact reduction, usage storage migration/APIs, retention, focused tests.
- **Out of scope:** Automatic decisions or provider effects, CLI presentation, hosted upload.
- **Approach:** Add immutable discriminated v2 observations keyed by provider-account authority and component-specific idempotency key. Fresh Codex usage freezes the exact provider, account, binding generation, and process generation in the existing immutable `account_scoped_provider_authorities` sidecar. The v36 migration adds the required write guard and read join without rewriting historical payloads; migrated rows with a null process generation remain byte-identical, display-only evidence and cannot authorize a mutation. A Claude quota observation separately owns quota windows, rate status, admitted overage fields, observed and received times, turn ID, and source event digest. A Claude accounting observation separately owns bounded cost, token and model accounting, its own observed and received times, and terminal turn ID. Accounting may advance without refreshing or overwriting quota authority. Decode v1 Codex payloads through the existing path and project their established combined snapshot into the v2 read model. Sanitize Claude `rate_limit_info`, convert utilization to used percent, and correlate it with the current turn. After neutral fact reduction, the callback schedules deferred persistence and returns first. The persistence task is tracked immediately and drained on close without `#serialize` or a live daemon fence.
- **Acceptance criteria:**
  - Claude rate events retain bounded windows, reset instants, status, rate-limit type, admitted overage state, turn provenance, and observation time.
  - Claude result accounting retains bounded cost, canonical model keys, token counts, context windows, and output limits without treating them as quota or lifetime counters.
  - Storing Claude data cannot change Codex latest usage, counter epochs, reset policy, poll cadence, or hosted v1 identifiers.
  - Parser totality covers missing, extra, oversized, non-finite, negative, millisecond-shaped, excessive-window, excessive-model, and unknown-status input.
  - Duplicate or reordered facts converge idempotently by provider-account, turn, and observation revision.
  - A later result accounting fact cannot change quota freshness, status, windows, or reset authority; latest projections merge components while retaining each component's source time.
  - Every fresh Codex usage row has one immutable exact provider-account and process authority; a migrated null-process row remains byte-identical and display-only.
  - The fact callback returns after neutral reduction and scheduling, before persistence. The deferred task is tracked immediately, drains during close, and does not depend on `#serialize` or a live daemon fence.
  - Claude provider observations never claim `codex_app_server` provenance; Codex retains its existing source value byte-for-byte.
- **Validation:** `bun test ./src/claude/protocol.test.ts ./src/claude/assembler.test.ts ./src/claude/client.test.ts ./src/daemon/claude-session-facts.test.ts ./src/domain/provider-usage.test.ts ./src/domain/usage-metrics.test.ts ./src/storage/state-store.test.ts ./src/daemon/service.test.ts ./src/daemon/claude-session.test.ts ./src/daemon/claude-runtime-adapter.test.ts ./src/cloud/daemon-adapters.test.ts --isolate --max-concurrency=1`

## Phase 4: Crash-safe manual session switching

- **Status:** Done on the task base; upstream integration revalidation remains required
- **Depends on:** Phase 2
- **Objective:** Make the existing explicit session switch safe enough to serve as the later Codex account-move primitive.
- **Scope:** Dedicated switch-attempt records and migration, immutable source/target authorities, canonical multi-key locking, target start receipt, source release evidence, rebind commit, seed delivery journal, restart recovery, switch tests.
- **Out of scope:** An automatic caller, automatic policy, active-pointer movement, and automatic continuation.
- **Approach:** Replace the generic switch effect with an action-specific write-ahead journal: `prepared -> target_starting -> target_started -> source_releasing -> source_released -> rebound -> seed_dispatching -> seed_settled`, plus terminal `reconciliation_required`, `failed`, and `cancelled` dispositions. Atomically claim the request key in the global mutation-idempotency namespace and link its immutable mutation attempt to exactly one dedicated switch journal through a unique foreign key with matching request key and digest before resolving replay or performing any effect; a key owned by any other mutation shape conflicts, while same-key replay resolves the linked switch before current-state no-op validation. Preparation rejects a terminal or recovery-required session, an active turn, a dispatching or ambiguous queue item, in-flight response or interaction state, another active switch, and stale session or session-authority revisions. Commit each intent before its provider call and each exact result after return; an ambiguous target start or seed dispatch is never replayed, while only the exact idempotent release may resume from its in-flight state. A `failed` disposition requires durable positive evidence that the relevant provider effect did not start, never merely the absence of a receipt. Freeze immutable source and target provider-account authorities, the original session revision and session-authority revision, source and target thread/runtime evidence, the deterministic seed dispatch identity, the request key, and a retention-pinned half-open transcript event range `(stream_id, after_sequence_exclusive, through_sequence_inclusive)` with its accepted-head/event-stream revision and canonical digest. The journal retains only that range and its digests and bounded metadata, never transcript plaintext; seed bytes and their digest are derived once from exactly that range rather than rerendered from latest state, and retention cannot prune the referenced events until the switch reaches a disposition that no longer needs seed recovery. Acquire source and target provider-policy locks, account locks, then the session lock in one ranked canonical order, reread every authority, and use the original frozen revisions for the rebind compare-and-swap. Every journal transition and receipt API independently enforces the expected prior state, exact authorities, frozen revisions, and request digest in storage rather than trusting service-side checks. While a switch is open, storage admission fences block queue dispatch, interaction response preparation and timeout, state-changing callback admission, and due-task materialization; a pending queue item may remain durable but cannot dispatch. The rebind transaction changes a manual switch to `routing_provenance=explicit` with `applied_pointer_revision=NULL`, updates the runtime and automation bindings, and records exactly one switch event without changing order, pointer, or policy. Seed recovery normally remains bound to the frozen target authority. It may adopt only a newer process generation for the same profile, provider, provider-account ID, and binding generation after immutable session-authority successor rows prove one contiguous old-to-new lineage from the rebound authority with every expected authority revision compare-and-swap bound; a missing or branched lineage, an account or binding substitution, or merely current mutable state requires reconciliation instead of dispatch. Tear down the local source runtime only after the exact durable source-release receipt exists. Dedicated per-session restart recovery owns these rows and excludes their phases from generic unresolved-mutation and broad Claude restart handling so one ambiguous switch quarantines only its session and never blocks unrelated daemon startup. Phase 4 exposes only the existing manual command and adds no policy or automatic caller.
- **Acceptance criteria:**
  - Crashing after every switch boundary cannot leave an unhandled mutation that prevents daemon boot.
  - The target cannot race logout, credential-generation change, removal, or another switch.
  - At most one target provider thread and one seed delivery are accepted for a switch key.
  - Ambiguous target start or seed delivery is visible as reconciliation-required and is never guessed or replayed.
  - No target start, source release, or seed dispatch occurs before its durable intent; only exact idempotent source release can be resumed after an in-flight crash.
  - Every state transition is rejected by storage unless its prior state, immutable authorities, frozen revisions, and request digest match; a terminal `failed` row contains positive no-effect evidence.
  - The exact transcript event range remains retained until seed settlement or reconciliation, while the switch journal contains no transcript plaintext.
  - Local source teardown follows the durable source-release receipt, and seed dispatch accepts only the frozen target authority or a newer same-account, same-binding process generation proved by one contiguous immutable session-authority successor lineage.
  - Rebind validates the originally frozen session and authority revisions. A manual switch always settles as explicit with no applied pointer revision and never changes provider order, active pointer, or policy.
  - Pending or ambiguous queue work, unresolved provider interactions, and due-task materialization cannot cross a switch boundary under stale source authority.
  - Storage, not only the service lock, keeps queue dispatch, interaction response preparation or timeout, state-changing callbacks, and due-task materialization inert while the switch is open; pending queue evidence may remain without dispatching.
  - Same-key replay returns the settled switch receipt without another target, switch event, or seed, even after the current session already matches the target.
  - Generic mutation and daemon-generation recovery exclude dedicated switch rows; ambiguous or malformed switch evidence is session-local recovery state rather than a daemon-wide boot failure. Writable reopen validates terminal as well as open receipt chains. A malformed historical terminal journal retains its phase and gains an immutable blocking disposition, so multiple historical attempts cannot conflict with the one-open-switch index.
  - Source release, positive target no-effect, and reconciliation receipts each have an independent immutable digest anchor binding the attempt, prepared plan, complete receipt, and observation time. Receipt relocation or field mutation cannot authorize rebind, failure, or abandonment.
  - Accepted seed settlement freezes its event digest before the storage-authored event is admitted and validates the whole settlement chain before commit. It retains no second plaintext seed or event payload in a custody table.
  - Every admission consumer resolves a disposed journal through its trusted disposition session and immutable mutation account authorities, not corrupt plan identity. A separate immutable source-thread anchor preserves callback custody. Safe pre-effect cancellation does not obstruct recovery for later switches.
  - Existing explicit provider and same-provider account switches retain their public results and refusal codes unless a documented recovery code is required.
- **Validation:** Host-scheduled `bun test ./src/daemon/provider-switch.test.ts ./src/storage/state-store.test.ts ./src/storage/session-task-store.test.ts ./src/daemon/service.test.ts ./src/daemon/claude-runtime-adapter.test.ts ./src/daemon/codex-runtime-adapter.test.ts ./src/daemon/facts-memory-lifecycle.test.ts --isolate --max-concurrency=1` passed 542 tests with 5,684 assertions. Independent recovery review, typecheck, focused lint, and diff checks passed.

## Phase 5: Pure exhaustion policy, configuration, and explanations

- **Status:** In progress (pure domain only; configuration awaits Phase 4 storage convergence)
- **Depends on:** Phase 3; storage work joins after Phase 4
- **Objective:** Produce one deterministic decision and explanation from a frozen provider-account snapshot and persist revisioned default/per-provider configuration, without performing provider IO.
- **Scope:** New `src/domain/usage-policy.ts`, schemas, pure selectors, threshold alias, freshness helpers, append-only automatic-policy configuration and revision storage, exhaustive unit and storage tests.
- **Out of scope:** Provider effects, CLI and app rendering.
- **Approach:** Store `defaultEnabled` plus closed per-provider `inherit | on | off` overrides, not a master global enabled bit. An inherited provider uses the default; an explicit `on` or `off` wins independently. Advance one monotonic `automaticPolicyRevision`, distinct from the existing reset-credit `resetPolicyRevision`. Bind decisions to provider-account generation, quota-component observation revisions, order revision, active-pointer revision, `automaticPolicyRevision`, session revision, turn ID where present, and reset boundary; accounting components are informational and never enter selection or follow decisions. Keep active-pointer target selection and per-session following as separate pure operations. Selection may propose advancement only from the current active source and emits `propose_pointer_move`; only a storage commit creates a named `SettledAutomaticPointerMove`. Following accepts only a contiguous named move lineage from the session's applied pointer revision and never reselects from current global state. For Codex, select exact `byLimitId.codex` whenever the keyed map has any entries; if that exact key is absent the observation is non-authoritative. When the keyed map is null or empty, use the admitted legacy top-level primary limit. Within that selected limit, each non-null primary or secondary window must have finite 0-to-100 usage, valid duration, and a bounded future reset; a malformed present window makes the observation non-authoritative, while a null slot means the provider exposed no window there. At least one valid window is required. Any applicable window at or above 99 percent exhausts the source; a candidate is available only when every applicable window is below 99 percent. A provider reached-type that conflicts with the numeric windows yields reconciliation-required. Delegate weekly reset eligibility to the existing proven function and its separate `resetPolicyRevision`, then reread all windows because a reset credit covers only its exact weekly authority. Walk account order once. The recheck time for one account is when all of its currently exhausted windows have reset; the ladder reports the earliest such boundary without claiming fresh availability. Model ladders are provider data, but `fallback_model` requires explicit model-scoped quota evidence; current Claude inputs instead report native fallback armed. Unknown or stale evidence returns a non-mutating result.
- **Acceptance criteria:**
  - Reset precedes model fallback, which precedes account movement, which precedes a bounded wait.
  - The existing Codex 99 percent weekly reset table remains byte-compatible, including the legacy primary fallback when `byLimitId` is empty.
  - No stale or missing below-threshold observation selects an account. Freshness uses quota-component received time: age 90,000 milliseconds is fresh, age 90,001 is stale, and a future received time is invalid. Exhaustion expires at the exact reset boundary.
  - The pure selector emits `propose_pointer_move`, never a settled move. Storage alone creates `SettledAutomaticPointerMove`; session following accepts only that durable type.
  - Weekly reset eligibility uses an explicit `AutomaticUsageResetGate` bound to the exact source authority, quota observation revision, reset boundary, and separate reset-policy revision. A policy proposal cannot infer reset settlement from usage v2 alone.
  - An exhausted observation is not carried past its reset boundary.
  - Multiple exhausted windows wait until all blocking windows for one account reset, then choose the earliest recheck boundary across the order without claiming fresh availability.
  - Order traversal wraps no more than once and concurrent input ordering cannot change the result.
  - A non-active account observation cannot move the active pointer, and a managed session follows only a contiguous named pointer-move lineage from its stored revision.
  - `defaultEnabled` is inherited rather than globally dominant, provider overrides are closed and independent, and `automaticPolicyRevision` never aliases `resetPolicyRevision`.
  - Quota components alone authorize policy decisions; cost, token, model, and other accounting fields cannot change selection or following.
  - Keyed Codex limits without exact `codex`, malformed present windows, no applicable windows, and reached-type conflicts are non-mutating; primary/secondary threshold conflicts follow the any-exhausted rule.
  - Claude unified windows never produce `fallback_model` without an explicit admitted model scope.
  - Disabled, observe-only, ambiguity, policy conflict, and no-target states are closed and explainable.
- **Validation:** `bun test ./src/domain/usage-metrics.test.ts ./src/domain/usage-policy.test.ts ./src/storage/state-store.test.ts --isolate --max-concurrency=1`

## Phase 6: Supported runtime actions without speculative replay

- **Status:** Not started
- **Depends on:** Phases 4 and 5
- **Objective:** Act on only the policy branches supported by authoritative provider evidence, with one durable coordinator and no HRA-authored replay.
- **Scope:** Asynchronous evaluation coordinator, existing Codex reset integration, Codex active-pointer action, managed-session `switch_and_forward` action, Claude native fallback runtime arguments, action events/evidence, focused daemon tests.
- **Out of scope:** Automatic Claude account rotation and HRA-driven Claude model restart.
- **Approach:** Observation-triggered evaluation may update only the active pointer when the observed source equals the current pointer, and it commits one durable pointer-move lineage row. At the next explicit send for a managed session, resolve a contiguous settled move chain from the session's stored pointer revision, coalesce per provider account, reacquire canonical locks, perform authoritative source and target rereads, revalidate every bound revision, and run exactly one action. Reuse the existing Codex reset attempt implementation unchanged, then reread. If a target is still proved, execute a dedicated `switch_and_forward` mode of the Phase 4 journal: size before every effect, preserve the pending input and attachments exactly, truncate transcript context first, start the target, release and rebind safely, then deliver one first target turn containing the bounded handoff and exact input. The attempt persists only digests, bounded metadata, and existing attachment references, never the plaintext message. A crash before proved dispatch waits for same-key caller replay with the same input digest; a crash after dispatch may have escaped quarantines the session instead of resending. It never dispatches the current standalone continuation seed or an additional copy of the pending input. Explicit sessions remain pinned. Arm Claude native fallback only when Phase 1 live evidence admitted it. Record interrupted or failed results, but never derive or dispatch another turn from them.
- **Acceptance criteria:**
  - Existing Codex reset cases `reset`, `noCredit`, `nothingToReset`, `alreadyRedeemed`, ambiguous settlement, identity change, and window rollover do not loop and retain current output.
  - Several sessions observing one exhausted Codex account coalesce pointer advancement and cannot create a switch herd.
  - Existing and explicitly routed sessions are never moved automatically; managed sessions follow at most one settled pointer move per bound decision.
  - An observation by itself never starts a provider thread or turn. A managed send that switches produces exactly one target user turn, including attachments and the bounded handoff, with one durable dispatch identity.
  - A maximum-size legal input is never truncated. Transcript context shrinks first; an input that cannot fit with minimum framing fails before target start. Same-key replay proves the input digest, completes a pre-dispatch attempt once, and never retries an ambiguous dispatch.
  - A provider fact callback never awaits session closure or switching.
  - User stop, explicit send, queue dispatch, policy disable, order edit, target logout, and credential-generation change win through revision conflict before an automatic action.
  - A rate-limit failure, any other failure, and lexical `working` classification never authorize an HRA-authored continuation.
  - Claude fallback-disabled and fallback-armed argv remain pinned and max effort remains invariant; the armed form is unreachable without Phase 1 live evidence.
  - Every automatic result has a bounded event and evidence row with safe explanation fields.
- **Validation:** `bun test ./src/daemon/usage-poller.test.ts ./src/daemon/provider-switch.test.ts ./src/daemon/service.test.ts ./src/claude/runtime.test.ts ./src/storage/state-store.test.ts --isolate --max-concurrency=1`

## Phase 7: CLI account and usage contract

- **Status:** Not started
- **Depends on:** Phase 6
- **Objective:** Give human and JSON callers one exact contract for order, activation, optional account resolution, policy controls, observations, and explanations.
- **Scope:** CLI grammar/help, daemon commands and public schemas, JSON/text renderers, parser and command tests.
- **Out of scope:** Hosted/browser surfaces.
- **Approach:** Add `hra account order <provider> <selector...>`, `hra account activate <provider> <selector>`, and provider-aware `hra account list [--refresh]`. Extend `hra account usage [--refresh]` rather than add a competing read command; refresh runs the provider's admitted read, which for Claude is auth readiness only and never fabricates usage. Add `hra usage auto on|off` for the inherited default, `hra usage auto on|off|inherit <provider>` for an override, and `hra usage auto status [provider]`. Make the local `session start` account selector optional: resolve same-key replay from the original request before reading the active pointer, then freeze one exact active binding for a new request; that omission records managed routing, while any explicit selector records explicit routing. Keep remote `session_start.accountPublicId` mandatory and explicit.
- **Acceptance criteria:**
  - Ambiguous or missing active accounts fail before any provider effect with a stable recovery instruction.
  - Explicit account selection preserves existing behavior and does not mutate the active pointer implicitly.
  - Order, active marker, readiness, observation time/source/freshness, limits, reset credits, reset-policy state, native fallback state, next supported action, and wait boundary agree with the pure policy result.
  - Claude always prints `as of` turn-derived freshness and never says current.
  - JSON additions are versioned and old fields retain meaning; text output remains bounded and contains no raw provider payload.
  - Remote session start remains explicit and unchanged.
  - `hra usage auto on|off` changes the inherited default; `hra usage auto on|off|inherit <provider>` changes only that provider override, and `status [provider]` reads it. Fresh configuration is default on with both overrides inherited and automatic-policy revision 1.
  - An omitted local account selector is part of the original request. Same-key replay resolves its immutable receipt before looking up the mutable active pointer, so later activation cannot redirect a retried start.
- **Validation:** `bun test ./src/cli ./src/cli.test.ts ./src/daemon/service.test.ts --isolate --max-concurrency=1`

## Phase 8: Hosted current usage and session-join contract

- **Status:** Not started
- **Depends on:** Phase 7
- **Objective:** Publish encrypted, joinable, freshness-honest usage heads while preserving the existing session stream as session authority.
- **Scope:** Usage payload v2 and dual-read, recalculated bounds, current-head and daily-history Convex storage/functions, provider-account/device/session join fields, daemon upload, cloud and Convex tests, `docs/hosted-sync.md`.
- **Out of scope:** Browser mutations for account order or automatic policy, raw credentials, cross-machine rotation.
- **Approach:** Preserve existing Codex HMAC/public IDs. Add provider and source-device identity, component observation times/sources, freshness inputs, reset credits, automatic-policy state, order, active marker, and next-action explanation to encrypted usage v2 payloads. Keep session state out of the usage payload: extend the existing encrypted session head or registry contract with provider-account public ID, provider, and actual/requested model fields for later app joins. Add a revisioned current usage head that coalesces the newest local observation and uploads at most once per provider account per 60 seconds. Give current-head admission its own monotonic revision rule, server interval, and recalculated daily write quota; keep the existing 24-hour cadence and retention only for daily history. Dual-read v1.
- **Acceptance criteria:**
  - Existing v1 encrypted payloads still parse and project with explicit unavailable fields.
  - V2 exact-key, tamper, source-device, account-join, revision-order, oversize plaintext, and oversize ciphertext tests pass against newly documented bounds.
  - A current-head update changes encrypted payload and revision within the documented 60-second coalescing cadence without waiting for a new daily bucket; its server admission interval and quota are distinct from daily history, which remains bounded at the existing archive cadence.
  - Device registry accounts, usage accounts, and the existing session-head stream join by provider-scoped opaque IDs without exposing local profile IDs or credentials; pagination or subscription, not usage-payload truncation, remains session completeness authority.
  - Claude projection fields retain component observation times and cannot imply idle polling or per-model quota.
- **Validation:** `bun test ./src/cloud/usage.test.ts ./src/cloud/payloads.test.ts ./src/cloud/daemon-adapters.test.ts ./src/cloud/daemon-bridge.test.ts ./convex --isolate --max-concurrency=1`

## Phase 9: Browser settings usage visualization

- **Status:** Not started
- **Depends on:** Phase 8
- **Objective:** Render the hosted usage and existing session authorities as one clear, accessible settings view without inventing missing provider facts.
- **Scope:** App function references, usage and session decryption, wire types, framework-free view model, relative-time formatting, settings screen, accessibility behavior, and app tests.
- **Out of scope:** Browser account-order or policy mutations, hosted schema changes, provider effects.
- **Approach:** Load and paginate the existing session-head authority, join it to provider accounts and usage current heads by opaque provider-account ID, and keep v1/unavailable paths explicit. Derive every visual and sentence in a framework-free model before rendering. Use accessible progress bars and text labels, relative reset countdowns with absolute instants, and component-specific freshness.
- **Acceptance criteria:**
  - Settings groups every loaded connected session by machine, provider, and account and shows state, requested/actual model when known, and active marker.
  - Each account shows remaining percentage, window length, relative and absolute reset time, readiness, order, reset credits, reset-policy state, component freshness, and the exact next supported action.
  - Claude displays `as of the last observed turn` and never implies idle polling, current availability, or per-model quota.
  - Missing keys, old payloads, locked keys, stale observations, pagination gaps, and unknown readiness have useful non-mutating empty states.
  - App view-model fixtures and CLI fixtures produce semantically identical policy explanations for the same frozen inputs.
- **Validation:** `bun test ./app/src/data ./app/src/model ./app/src/screens --isolate --max-concurrency=1 && bun run build:app`

## Phase 10: Contract convergence, validation, and delivery

- **Status:** Not started
- **Depends on:** Phase 9
- **Objective:** Converge documentation and code, obtain independent whole-feature review, pass the authoritative gate, and deliver through repository policy.
- **Scope:** `docs/usage-management.md`, `docs/providers/claude.md`, `docs/hosted-sync.md`, `README.md`, active plan evidence, generated convergence artifacts only when proven, delivery records.
- **Out of scope:** Expanding the explicitly deferred Claude automation boundary.
- **Approach:** Audit public claims against tests and exact runtime behavior. Run independent final review against this plan. Repair every in-scope finding, rerun only invalidated focused checks, then run the final gate once on the converged tree. Resolve `hra-host-run` to its installed absolute path and use `--mode=heavy --lane=compute` for the unchanged child command `bun run check`. Commit coherent task-owned changes, push, open the PR, wait for required checks/reviews, merge, perform any repository-required release, and deploy hosted changes only through the attested candidate chain in `docs/hosted-sync.md`. Do not weaken a gate or bypass an enforced approval.
- **Acceptance criteria:**
  - Documentation states the 99 percent threshold, reset-before-switch order, active/default semantics, provider observation sources and freshness, switches, supported actions, and deliberate deferrals.
  - Independent final review finds no unresolved correctness, recovery, privacy, compatibility, or contract issue within scope.
  - `bun run check` passes on the exact delivered Git tree through the heavy compute lane.
  - The final branch, commits, PR, required checks, merge SHA, release evidence if applicable, hosted candidate/deployment evidence if applicable, and production readback are recorded.
- **Validation:** Focused checks from invalidated phases, then host-scheduled `bun run check`; repository PR, merge, release, deployment, and production-verification checks as documented.

## Required scenario matrix

- Same profile with independent Codex and Claude provider-account generations, observations, order, and readiness.
- Migration restart before, during, and after provider-account backfill.
- Invalid order permutation, duplicate selector, cross-provider selector, active removal, and simultaneous activation.
- Codex observation at 98.99, 99, and 100 percent; weekly keyed limit and legacy primary fallback; credit present, absent, and ambiguous.
- Codex keyed map with and without exact `codex`; primary below and secondary exhausted; null secondary; malformed present window; no applicable windows; conflicting reached type; weekly reset followed by another still-exhausted window.
- Claude rate event before result; duplicate and reordered events; allowed, warning, blocked, denied, rejected, and unknown status; generic unified windows never treated as model-scoped.
- Claude result accounting after a rate observation; accounting time advances while quota freshness remains unchanged.
- Observation exactly at and just beyond the provider freshness boundary; exhausted evidence before and after reset.
- Two sessions see one exhausted Codex account; target logs out or changes generation; order or policy changes during evaluation.
- Exhausted non-active account observation leaves the pointer unchanged; active A-to-B then B-to-C move lineage lets a managed session on A follow the exact chain or reconcile a gap.
- Observation-triggered pointer rotation with no provider thread or turn, followed by one managed `switch_and_forward` at the next explicit input; no standalone seed plus duplicate input.
- Switch crash after prepare, target start, source release, rebind, seed prepare, and seed dispatch, followed by daemon restart at every point.
- Maximum-size pending input with no transcript room; same-key retry before dispatch; crash after target/rebind but before dispatch; ambiguous target dispatch with no retry.
- Automatic action never runs inside the fact callback.
- Classifier says working without exact rate-limit terminal cause; no continuation.
- Exact rate-limit terminal cause before and after restart; no HRA-authored continuation or replay.
- Claude process arguments with automatic management on and off; reported terminal model differs from requested model after native fallback.
- V1 and v2 hosted payload dual-read, exact-key refusal, tamper, oversize, source-device join, 60-second current-head coalescing and server admission, out-of-order current revisions, daily history retention, locked-key state, and old-browser compatibility.
- CLI and browser render the same frozen policy fixture, including stale, disabled, observe-only, reset, switch, and wait explanations.

## Delivery policy

- Use the task-owned feature branch from current `origin/main`; preserve unrelated work and never force-push.
- Commit coherent reviewed phases. A phase commit is not proof of completion until its focused checks and independent review pass.
- Push and open a pull request after the converged final gate. Wait for all repository-required reviews and checks, repair failures, and merge through the documented workflow without requesting redundant confirmation.
- Run releases only when repository policy says the merged change requires one. Record the release artifact and verification.
- Hosted and app changes use the attested candidate and production-deployment chain in `docs/hosted-sync.md`; a PR merge is not deployment evidence.
- Never reuse a validation receipt for the required final integration, merge, release, deployment, or production readback.

## Implementation log

- 2026-09-05, Phase 4 gate passed: the repaired aggregate under scheduler label `hra-phase4-provider-switch-final` passed 542 tests with 5,684 assertions and no failures. Independent recovery review approved the repaired boundary. Final typecheck, targeted lint, and diff checks passed. This closes Phase 4 on its original task base; upstream schema/login/preset integration remains a separate mandatory revalidation before Phase 6.
- 2026-09-05, integration prerequisite: upstream now includes released schema versions 35–38, secure foreground Claude login, and durable legacy/current preset contracts. Preserve those released migrations and historical switch recovery; renumber this unpublished work to provider accounts 39, observations 40, and dedicated switching 41 before further storage implementation. Automatic configuration follows as 42. Integration must preserve independent provider generations, foreground login custody, legacy Sol continuation, current Astra selection, and notification opt-in state. These are required integration regressions, not completed evidence.
- 2026-09-05, Phase 4 recovery review: four red regressions proved source/target generation fence bypass, unrelated-session fencing from corrupt journal identity, and later recovery blocked by safely cancelled history. The shared admission projection and immutable source-thread anchor repaired these; the expanded recovery slice passed 9 tests with 128 assertions. Task materialization passed 11 tests with 72 assertions and the post-rebind failure-injection case passed 1 test with 12 assertions. The prior aggregate was 526 passing and 11 failing; its repaired aggregate remains pending. Typecheck and storage/domain lint passed.
- 2026-09-05, Phase 5 pure domain: configuration resolution, quota classification, reset-gated pointer proposals, and branded settled-lineage following are implemented without provider effects or storage configuration. Independent review caught an informational Claude readiness mismatch; exact unverified Claude turn observations now remain observe-only while Codex candidates still require signed-in authority. The repaired domain slice passed 49 tests with 608 assertions. A settled reset gate requires a later quota revision received after settlement. Phase 5 is not complete until its durable configuration and integration gates pass.
- 2026-09-05, dependency correction: the Phase 5 pure selector has no dependency on switch implementation or provider IO, so domain-only work may proceed alongside Phase 4. Its storage configuration remains serialized behind Phase 4, and Phase 6 now explicitly joins both phases before any automatic action is implemented.
- 2026-09-05, Phase 4 reassessment: independent rejection review found an accepted-seed event admission failure, missing independent anchors for source-release/no-effect/reconciliation evidence, and terminal corruption omitted from reopen validation. These remain Phase 4 blockers until the repaired full suite passes. The seed repair uses the existing immutable event digest and atomic settlement, avoiding a second plaintext custody table. Phase 5 and Phase 7 acceptance criteria now explicitly distinguish pointer proposals from durable moves, bind reset eligibility to exact evidence, and resolve omitted-selector replay before mutable defaults.
- 2026-09-04, plan approval and Phase 1 start: the supplied plan was rejected after three independent read-only audits. The corrected plan was iterated through a separate rejection-oriented review and approved with no remaining blocker. No product behavior has changed yet. Phase 1 now owns contract convergence and the exact pinned Claude fallback gate.
- 2026-09-04, Phase 1 done, commit `3b8adca`: governing contracts now admit only future managed Codex movement under fresh crash-safe authority and retain the bans on explicit-route movement, Claude rotation, and speculative replay. Claude runtime data defines the exact Fable-to-Opus max-effort native fallback, but production remains `unavailable: live_acceptance_required` because no signed-in isolated HRA Claude profile exists. Focused phase validation passed 183 tests with 1,842 assertions; targeted daemon/runtime validation passed 22 tests; typecheck, targeted lint, and diff checks passed. Independent review found and fixed one fail-closed defect so runtime profiles and argv construction now require the exact pinned fallback model and reviewed reason; the invalidated slice passed 14 tests with 43 assertions. Remaining risk is explicit and non-operative: authenticated Opus/fallback acceptance has not been proved.
- 2026-09-04, Phase 2 start: a read-only migration inventory mapped providerless profile, session, interaction, queue, remote, and runtime authorities. The phase will use additive sidecars and schema version 35, preserve immutable legacy records, derive legacy session-scoped provider identity only from historical runtime/effect authority, and quarantine unprovable unsettled rows.
- 2026-09-04, Phase 2 Claude signed-out evidence: an exact `2.1.260` credential-free probe in a fresh mode-0700 isolated configuration exited `1` with sorted keys `[analyticsDisabled, apiProvider, authMethod, loggedIn, projectsDirectory]` and respective types boolean/string/string/boolean/string. Only `loggedIn=false`, `authMethod=none`, `apiProvider=firstParty`, a boolean analytics flag, and a bounded discarded projects-directory string are admitted. Exit `0` remains `unverified`; no raw payload, path, credential, or identity was retained.
- 2026-09-05, Phase 2 done: the initial integration gate exposed two authority-retirement failures. The repair makes logout and quarantine atomically retire the old exact provider-account authority before advancing the binding, without weakening any transition trigger. The repaired focused service slice passed `3 pass/0 fail`, the repaired focused storage slice passed `3 pass/0 fail`, and typecheck and diff checks passed. Root integration ran `hra-host-run --mode=heavy --lane=compute --label=hra-phase2-provider-authority -- bun test ./src/storage/state-store.test.ts ./src/daemon/claude-runtime-adapter.test.ts ./src/daemon/claude-session.test.ts ./src/daemon/service.test.ts --isolate --max-concurrency=1` and passed `366 pass/0 fail` with `3368 assertions`.
- 2026-09-05, Phase 3 start: provider-neutral usage observation v2 is in progress under the exact Codex authority, split Claude quota/accounting, and deferred callback-persistence contracts recorded above. No Phase 3 acceptance evidence has been claimed yet.
- 2026-09-05, Phase 3 done and Phase 4 start: two independent reviews covered the runtime/service turn-settlement path and the domain/storage authority, replay, retention, migration, and schema surfaces. Review blockers were repaired, including the pre-bind turn-usage persistence race and exact immutable v36 structure enforcement with converged migration expectations. Root integration under host-scheduler label `hra-phase3-provider-usage-final` passed `535 pass/0 fail` with `4432 assertions`; the converged typecheck and diff checks were green. Phase 4 is now in progress, but no Phase 4 behavior is claimed yet.
