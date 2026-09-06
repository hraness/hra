---
title: Model routing and bounded autonomy
description: Active phased plan for Ultra defaults, conservative shadow routing, notification timing, shared remote-action policy, and evidence-gated autonomy.
type: plan
status: in-progress
area: hra
tags:
  - autonomy
  - claude
  - codex
  - notifications
  - routing
relations:
  related-to: [ plans/hra-v1, plans/hra-v2, plans/hra-web-v1 ]
---

# Model routing and bounded autonomy

## Outcome

Make Astra Ultra the authoritative default for every implicit new Codex session, then add a conservative and explainable routing framework that can be evaluated without changing live sessions. Later phases may admit additional model profiles, exact Work provisioning, notification timing, and bounded supervision only after their capability, privacy, recovery, and holdout gates pass.

The public benchmark survey selects candidates for local evaluation. It does not license a live routing rule. Astra became available after the original plan: the exact pinned Codex 0.153.2 model catalog admits `gpt-6-astra` at `max` and `ultra`, and the owner directed the existing `high` and `ultra` aliases to use those exact profiles for new or explicitly changed sessions. That default amendment does not license Terra, automatic Fast, or live shadow routing.

## Constraints

- Preserve the durable identities of `low`, `high`, `ultra`, and `fable-max`. Existing sessions stay bound to their previously admitted exact model and effort; new or explicitly changed `high` and `ultra` selections resolve to Astra.
- Routing is performance policy only. It never changes approval mode, sandboxing, permissions, account, project, execution device, or remote-action authority.
- Unknown, ambiguous, open-ended, safety-relevant, network, MCP, authentication, release, migration, and cryptographic work stay on the strong admitted profile unless an exact declared Work effect class proves otherwise.
- Never rotate accounts to evade limits, replay a failed turn on another model automatically, or automatically change model, effort, provider, or service tier after a conversation has begun. Explicit preset and provider changes remain available through their existing fenced commands.
- Fable and any later Claude profile require explicit Claude selection. No automatic cross-provider data transfer is introduced.
- Private task text, transcripts, paths, account labels, provider credentials, and model output never enter committed fixtures or content-free receipts. Evaluation reads only an explicit owner-provided input path.
- Keep Work route matching exact. A relative rule such as "tier or above" has no stable meaning across provider families and would weaken an authority fence.
- Hosted storage remains unable to read encrypted projected conversation content. No plaintext ask, prompt, answer, transcript, or command enters Convex or email without a separately accepted privacy design.
- Working hours may alter notification timing only. They do not change approval categories, autorespond budgets, or execution authority.
- State changes use append-only, transactional, downgrade-tested migrations. Existing public beta state is treated as real.
- `bun run check` is the final repository gate. Broad checks use the installed HRA host scheduler without changing the child command.
- The integration owner owns convergence files: preset and runtime contracts, storage schemas, daemon service, CLI parser, cloud unions, Convex schema, app screens, package manifests, plan indexes, and release-facing documentation.

## Phase map

| Phase | Outcome | Depends on | Write scope | Parallel with |
| --- | --- | --- | --- | --- |
| 1 | Ultra default and truthful explicit controls | none | preset defaults, CLI parser, app model controls and focused tests | 2, 3 after contracts freeze |
| 2 | Conservative lexical task-shape classifier in shadow mode | none | new domain classifier and content-free fixtures | 1, 3 |
| 3 | Pure shadow routing decision and explicit-input evaluation analyzer | 1, 2 | new domain routing and scripts | none until Phase 2 exports freeze |
| 4 | Canonical provider profile identity and admitted candidate profiles; Astra compatibility slice done | 3 plus live capability evidence | preset/runtime contracts, state and Work migrations, provider matrices | none |
| 5 | Exact task-owned Work session lifecycle | 4 | Work domain, store, daemon effects, recovery and protocol docs | none |
| 6 | Evidence-gated routing and Fast activation | private holdout plus 4 and 5 | routing integration, runtime receipts, settings and UI | none |
| 7 | Notification-only working hours | 3 | daemon settings, projection, command unions and app settings | 8 after contract freeze |
| 8 | Shared per-action remote policy and metadata-only notifications | 7 | interaction policy, daemon verifier, projection, app, hosted outbox | none |
| 9 | Hostile inbound email decisions | 8 plus accepted authority design | Convex webhook and lifecycle, reply capability, daemon command path | none |
| 10 | Event-driven bounded supervisor | 5, 6, 8 plus dogfood evidence | supervisor domain, effects, limits, evidence and UI | none |

## Phase 1: Ultra default and truthful explicit controls

- **Status:** Done
- **Depends on:** none
- **Objective:** Every implicit new Codex session starts with `ultra`, while explicit presets and established sessions remain unchanged. The app names existing presets accurately and exposes Fast only as an explicit manual turn-boundary control.
- **Scope:** `src/domain/presets.ts`, `src/domain/presets.test.ts`, `src/cli/parser.ts`, `src/cli/parser.test.ts`, `app/src/model/settings-commands.ts`, its test, and the session model menu.
- **Out of scope:** automatic task routing, a new preset, provider switching, Fast automation, storage changes, account selection, and any approval change.
- **Approach:** Define one provider-default function in the domain. Use it in CLI parsing. Keep the already-Ultra daemon and browser defaults aligned. Name the then-current new-session choices Luna Max, Sol Max, and Sol Ultra. Send the existing closed `set_fast` command from a manual app control without inferring the current daemon value.
- **Acceptance criteria:**
  - An implicit Codex CLI start parses as `ultra`; explicit `high` still parses as `high`.
  - An implicit Claude CLI start remains `fable-max`.
  - Provider defaults are exhaustive and each belongs to its provider.
  - Existing session and provider-switch behavior is unchanged.
  - The app labels the current four aliases by their actual model and effort.
  - Fast remains false unless the operator explicitly changes it.
- **Validation:** `bun test src/domain/presets.test.ts src/cli/parser.test.ts app/src/model/settings-commands.test.ts`; `bun run build:app` after the app edit.

### Astra baseline amendment (2026-09-05)

- **Status:** Done as the Astra compatibility slice of Phase 4; future candidate-profile admission remains open.
- **Depends on:** Phase 3 and exact pinned-runtime capability evidence for Astra.
- **Objective:** Make Astra the current exact implementation of `high` and the default `ultra` without silently reinterpreting any established Sol session or its Work authority.
- **Scope:** Frozen preset requirements, runtime-profile admission, state schema v38, Work contract fencing, daemon review requirements, routing-evaluation schema versioning, UI and CLI labels, and public compatibility copy.
- **Out of scope:** Terra or Opus admission, automatic routing, automatic Fast, global attention delivery, and notification canary activation.
- **Approach:** Treat `(preset, preset_contract)` as the durable alias identity. Contract 1 freezes the historical Sol mapping and contract 2 freezes the Astra mapping. Pre-v38 and provider-imported sessions use contract 1; new HRA sessions and explicit preset selections use contract 2. Thread the resulting exact model and effort through every review, queue, provider-switch, recovery, and Work-authority check. Preserve exact routing-evaluation schema 1 for Sol and add schema 2 for Astra.
- **Acceptance criteria:** Established Sol effects remain readable and replayable; new and explicitly selected `high` and `ultra` resolve only to Astra; mixed contract tuples fail closed; Work claims, active attempts, settlement, and sweep cannot cross a meaningful route change; the exact-equivalent Codex `low` tuple may cross versions; historical evaluation evidence is never relabelled.
- **Validation:** Focused domain, protocol, adapter, service, state-migration, Work, routing-evaluation, app, CLI, and site tests followed by the exact-tree repository gate. Exact results are recorded in the implementation log.

## Phase 2: Conservative lexical task-shape classifier

- **Status:** Done
- **Depends on:** none
- **Objective:** Classify explicit task text as `well_defined`, `open_ended`, `mechanical`, or `uncertain` using a pure ordered local policy, without changing a live route.
- **Scope:** New `src/domain/model-task-shape.ts`, tests, and a content-free labelled fixture.
- **Out of scope:** gateway calls, provider quota, reading HRA or provider history, prompt persistence, safety authorization, and live routing.
- **Approach:** Use ordered high-precision rules. Mechanical requires a wait, monitor, or exact command-only request with no authorship. Well-defined requires both named scope and a checkable outcome. Research, diagnosis, design, unknown cause, broad scope, or conflicting evidence is open-ended. Ambiguity remains `uncertain`; routing treats it like open-ended.
- **Acceptance criteria:**
  - The result carries the shape, stable rule id, and bounded reason.
  - Empty, conflicting, hostile, and ambiguous inputs never become `well_defined`.
  - The fixture contains no task text, paths, accounts, or model output.
  - The module performs no IO and imports no provider or gateway code.
- **Validation:** `bun test src/domain/model-task-shape.test.ts`.

## Phase 3: Shadow routing decision and evaluation analyzer

- **Status:** Done
- **Depends on:** Phases 1 and 2
- **Objective:** Produce an explainable effective route plus any disabled candidate, and analyze an explicit private experiment export without discovering or emitting private content.
- **Scope:** New `src/domain/model-routing.ts`, focused tests, `scripts/routing-eval.ts`, script tests, and model-routing documentation.
- **Out of scope:** mutating a session, admitting Terra or Opus, running provider tasks, reading session histories, dollar-cost claims, and enabling Fast automatically.
- **Approach:** Keep established sessions unchanged. New Codex sessions resolve to Astra Ultra and new explicitly Claude sessions to Fable Max. A well-defined Codex task may name Terra Ultra only as a disabled candidate until both capability and private non-inferiority gates pass. A well-defined Claude task may name Opus only as unsupported until an exact reviewed runtime exists. Fast remains off. Analyze paired result records with predeclared margins and publish only counts, rates, intervals, and content-free hashes.
- **Acceptance criteria:**
  - Every decision identifies effective provider, preset, Fast state, rule id, and one-line reason.
  - Shadow candidates never inhabit the effective preset field.
  - Established, safety-sensitive, unknown, and mechanical inputs cannot trigger a model change.
  - The analyzer requires an explicit input path, never searches the machine, and never emits task text or model output.
  - Fewer observations than the preregistered sample requirement cannot license a rule.
- **Validation:** `bun test src/domain/model-routing.test.ts scripts/routing-eval.test.ts`; run the analyzer only against a synthetic content-free fixture in repository checks.

## Phase 4: Canonical profile identity and candidate admission

- **Status:** In progress. The Astra compatibility slice above is done; generalized candidate-profile admission is not started.
- **Depends on:** Phase 3 and exact live capability evidence
- **Objective:** Generalize beyond the frozen Sol and Astra alias contracts to represent additional models and efforts without reusing or reinterpreting a legacy tier.
- **Scope:** Provider/profile schemas, reviewed runtime profiles, state schema version migration, Work table migration, cloud compatibility, provider pin and protocol matrices, and tests from populated older databases.
- **Out of scope:** automatic routing and relative Work routes.
- **Approach:** The completed Astra slice establishes a narrow versioned identity for existing aliases and a dual-read compatibility window. Before any new candidate alias is added, finish the generalized canonical profile design, preserve both frozen contracts exactly, and rebuild any additionally affected SQLite tables only inside a transactional migration. Admit `terra-ultra` or an Opus alias only after the pinned runtime and account generation report the exact model and effort, and after reviewed protocol fixtures exist.
- **Acceptance criteria:**
  - Every supported older schema upgrades without data loss and a failed migration rolls back atomically.
  - Legacy Codex and Claude sessions reassemble to the same alias, model, and effort as before.
  - Work routes, tasks, and attempts store and compare one canonical exact identity.
  - A candidate missing live capability evidence is refused before runtime mutation.
- **Validation:** focused state and Work upgrade fixtures from every supported schema; provider pin, protocol, runtime, cloud compatibility, and second-open idempotence tests.

## Phase 5: Exact task-owned Work session lifecycle

- **Status:** Not started
- **Depends on:** Phase 4
- **Objective:** Provision a finite worker session for one exact declared Work route, then join, claim, and self-dispatch through the existing Work protocol with crash-safe recovery.
- **Scope:** Work operation contract, prepared effects, store transitions, daemon execution, recovery, limits, evidence, cleanup, and protocol documentation.
- **Out of scope:** relative tiers, account rotation, inherited coordinator approval authority, arbitrary target dispatch, and automatic cross-provider selection.
- **Approach:** Add a versioned provisioning operation that binds account, project, provider, canonical profile, Fast, and manual approval defaults before provider start. Use an idempotency key and quarantine ambiguous provider starts. Join and claim only after the exact session is durable. Bound turns, lifetime, attempts, and cleanup. Cross-provider work occurs only when the route explicitly names that provider and its runtime is admitted.
- **Acceptance criteria:**
  - Every effect boundary is restartable or enters explicit recovery.
  - The provisioned session matches the immutable route exactly and receives no authority absent from its capability.
  - Duplicate delivery cannot create two sessions or two claims.
  - Established attempt owner and target-session invariants remain intact.
- **Validation:** transition and fault-injection tests at every prepared-effect boundary, duplicate and stale operations, unsupported runtime, cancellation, expiry, restart recovery, and populated Work migration fixtures.

## Phase 6: Evidence-gated routing and Fast activation

- **Status:** Not started
- **Depends on:** Phases 4 and 5 plus private holdout evidence
- **Objective:** Activate only route rules that passed a preregistered private evaluation on the owner's work.
- **Scope:** Cold-boundary routing integration, runtime receipts, settings, UI visibility, and kill switches.
- **Out of scope:** mid-conversation changes, automatic replay, account rotation, and learned opaque routing.
- **Approach:** Use paired randomized runs on exact repository trees, declared effect classes, and equal tool and permission conditions. Primary outcome is completion without human repair under a predeclared non-inferiority margin. Track provider-native usage separately. Fast requires its own measured latency and cost gate. Unlicensed candidates remain visible as shadow-disabled.
- **Acceptance criteria:**
  - Each enabled rule cites an immutable content-free evaluation receipt and capability proof.
  - Disabling a rule restores Astra Ultra without changing any established session.
  - Automatic changes occur only before a provider thread exists.
  - Routing never changes authority or sends content to another provider family without explicit selection.
- **Validation:** decision-table and property tests, exact-tree paired holdout receipts, live cold-start acceptance, rollback, kill-switch, and established-session invariance tests.

## Phase 7: Notification-only working hours

- **Status:** Done
- **Depends on:** Phase 3
- **Objective:** Store and display a per-machine notification schedule without changing autonomy or approval behavior.
- **Scope:** Versioned daemon settings, command payloads, encrypted device registry projection, CLI, app, and clock-injected tests.
- **Out of scope:** autorespond budget changes, permission changes, notification delivery, and action expiry changes.
- **Approach:** Store local start and end wall times plus an explicit IANA timezone, defaulting once to 10:00 through 22:00 in the machine timezone. Define inclusive start and exclusive end, overnight spans, DST behavior, timezone changes, and wall-clock rollback.
- **Acceptance criteria:**
  - Invalid zones and degenerate ranges are refused.
  - Older clients ignore the additive encrypted registry field safely.
  - The same instant produces the same in-hours result for a given policy revision.
  - No approval or autorespond decision reads the setting.
- **Validation:** domain clock tests for DST, overnight ranges, boundaries, timezone changes, and rollback; storage, payload, projection, CLI, and app compatibility tests.

## Phase 8: Shared per-action remote policy and metadata-only notifications

- **Status:** In progress
- **Depends on:** Phase 7
- **Objective:** Derive one exact remote action set for daemon enforcement and client presentation, then notify an explicitly opted-in operator using only metadata needed to announce current interaction-backed attention.
- **Scope:** Browser-safe domain policy, daemon live verifier, compact projection, app affordances, a local per-machine email opt-in, a globally disabled-by-default hosted delivery control, one hosted outbox plus its service-owned safety-fault capacity ledger, Resend send action, lifecycle, quotas, deletion, revocation, maintenance, and docs.
- **Out of scope:** plaintext asks, headlines or summaries in email, transcript excerpts, question text or answers in email, inbound replies, generic classifier-only attention, action execution in Convex, delivery or read receipts, and a claim that provider acceptance means inbox delivery.
- **Approach:** Deliver this phase in three independently reviewable slices.

  **8A, one action authority (done 2026-09-05):** Add a pure policy that takes the live interaction state, deadline, already-sanitised display, and an injected clock. It returns a closed, ordered subset of `decline | answer`, exact bounded answer-field contracts, closed reason codes, and a reachability summary derived from that action set. Command and permission grants remain local because their public display classes omit decision-critical protected command, network, policy-amendment, path, and scope values; neither a coarse command class nor a permission category can license them. Command, file-change, and permission requests may only be declined remotely when decline is available. `answer` is available only for a complete non-secret closed-choice user question set whose provider adapter proves that every decision-relevant field crossed without sanitization or truncation and that its response translation is exact. Free-text and Other responses, every MCP answer, unknown modes, secrets, cancel, and session scope remain local. The live daemon recomputes membership immediately before the ordinary local resolution path, and the Codex compiler independently checks closed-choice values against the raw provider request. Revision, session, and provider authority checks remain separate and authoritative.

  Publish this policy in compact interaction detail v2 with nested remote policy version 2 and the absolute deadline. A nested policy v1, unknown or absent policy gives a new app no controls, and an old app drops unrecognised v2 detail, so both skew directions fail closed. Fresh v2 events stop licensing actions through the legacy decision, class, and question mirror. The app renders only the projected action set, treats `response_prepared` as non-actionable, suppresses locally expired controls, and resets draft and command state on interaction id or revision changes. Projection is evidence of what was allowed when emitted, not continuing authority; a race may still produce a truthful stale refusal from the live daemon.

  **8B, inactive durable delivery (in progress):** Add a separate local per-machine email-notification opt-in, defaulting off for existing and new machines. Notification hours are timing policy, not consent. One composite local notification-policy revision advances atomically when either opt-in or hours changes. The active lease-holding daemon is the consent and schedule authority because Convex cannot decrypt or independently prove the local policy; the published revision is only a freshness and revocation fence. Enable and disable remain CLI-only in this slice, while the browser shows read-only status. Hosted claim authority also requires a server-clock consent lease lasting at most two minutes, bound to the source device and local policy revision, that only an enabled lease-holding daemon may renew through a complete reconciliation.

  The daemon computes the allowed-window end as the first subsequent transition from allowed to disallowed under the configured IANA timezone, including skipped and repeated local times. While inside that interval it takes one exact machine-wide snapshot of at most 64 unexpired, session-linked `pending` interactions, with no generic classifier-only rows. Sessionless interactions are categorically ineligible for email and remain locally visible; they neither count toward the bound nor invalidate the snapshot because no safe canonical session destination exists. A session-linked pending interaction remains eligible even when its canonical remote action set is empty because the email announces attention, not authority. The daemon establishes the exact current session lease for every included row and calls one bounded reconciliation mutation. That transaction cancels source-device rows omitted from a complete snapshot and inserts or refreshes present rows. If a `limit + 1` query overflows, lease-backed completeness cannot be established, or the hosted mutation cannot validate the full envelope, the daemon attempts a serialized explicit invalidation for that source device and submits no candidates. If status, sequence, or network failure prevents settlement, it stops complete notification-consent renewal so the existing server lease expires within its bound. Per-session enqueue is never authoritative. Quiet hours create no future hosted job; the next allowed interval starts from a new complete local snapshot.

  Use one user-owned `attentionNotificationOutbox` table charged to the existing `command` quota and `nonterminal_command` resource. A new quota category or resource is forbidden without a separate ledger backfill. Each interaction has one separately indexed and quota-accounted row. Every newly reconciled pending row also carries a fixed, zero-only, accounting-only capacity reservation. Claim reduces that reservation as immutable delivery fields take its place, and a smaller residual reservation covers every later retry, suppression, and terminal outcome, so an admitted row can progress even when the user's hard logical-byte quota is exactly full. The reservation contains no variable or user-derived data, and schema and runtime checks reject any other value. Before an effect starts, claim provisionally inserts and exactly measures four fixed, service-owned, zero-only safety-fault capacity rows: one for each of the three possible attempt generations plus one storage-corruption obligation. Their single quota preflight must succeed before claim commits; exact-full service quota instead closes the pending group without a provider effect. Each slot keeps that initially measured maximum quota charge for its whole non-growing lifecycle and releases the charge from its canonical fixed shape on deletion, so schema-valid corruption in mutable evidence fields cannot underflow shared quota or consume another user's accounting. A valid safety observation non-growingly converts one row into a durable exact fault and arms the unused siblings through the seven-day late-settlement horizon. Accepted, refused, ordinary terminal ambiguity, maintenance closure, and account erasure release unused capacity; a faulted delivery retains its armed siblings independently of review or re-enable until that horizon expires. After a 60-second coalescing delay, claim may group at most eight rows for the same user and recipient into one delivery. Every member receives the same opaque delivery id, generation, body digest, recipient digest, and Resend idempotency key; one leader stores the immutable body of at most 8 KiB UTF-8 and the other members refer to it. Retry must preserve the exact group, body, recipient digest, and key. Stored metadata is limited to opaque session and interaction ids, interaction kind and revision, the canonical action set, deadline, policy generations, exact `bootGeneration | bootId | fence` session-lease authority, fixed quota reservation, digests, and delivery timestamps. A latched storage-corruption fault may additionally retain one unexposed server-internal outbox row locator and a fixed quarantine-completion timestamp solely so bounded quarantine can delete and attest the exact corrupt group before the fault is acknowledged; neither enters public status or email. There is no plaintext email, question, field, prompt, transcript, summary, command, path, permission value, or provider credential. Every claim and retry revalidates every member's stored tuple against its current unexpired execution lease, as well as the device consent lease; one failed member rejects the whole group.

  Convex derives the recipient immediately before every attempt. It requires canonical `user.email`, a current email-verification timestamp, and exactly one active authentication subject with the same verification timestamp. The first claim stores only the recipient digest; retries require the newly derived digest to match. The sender is pinned to `HRA attention <notifications@news.hraness.com>`, the subject to `HRA needs your attention`, and no Reply-To is sent. Every item links only to `https://app.hra.sh/#/session/<opaque-id>` after strict public-id validation.

  Delivery uses independent source-device local-policy and global-notification generations. Global enablement is disabled by absence, and every disabled-to-enabled transition advances the global generation so re-enablement cannot resurrect old rows. Local disable commits immediately, stops complete notification reconciliation and notification-consent lease renewal, and attempts hosted invalidation on the bridge's serialized lane. If a network, status, or sequence failure prevents that invalidation from settling, the bridge performs no new complete renewal and the last exact server-clock notification-consent lease expires within its existing two-minute bound. The CLI must distinguish acknowledged invalidation from bounded revocation pending and report the conservative server-authority expiry; it must never claim that an offline disable recalled a prior hosted effect. Hosted status includes a server `observedAt` timestamp and the device authority's exact global generation. Consent is described as current only when local opt-in is enabled, global delivery is enabled, local and global generations match, and the lease is unexpired at that server instant; an impossible lease more than two minutes beyond the server observation is rejected. If no serialized hosted receipt is available, the client reports `not_observed` and never invents an absolute expiry from local wall time. After bridge serialization has drained any earlier complete reconciliation, `revocation_pending` may come only from a freshly parsed live status carrying an unexpired device-authority lease or from the exact persisted complete receipt when no custody mutation is pending. Offline fallback is restricted to that persisted strict receipt. A stale row cannot be newly claimed after its two-minute consent lease expires. The hosted commit order is the cancellation guarantee: a complete reconcile, policy revision, global disable, account deletion, device revocation, resolution, expiry, or consent-lease expiry observed before claim prevents a network effect; a claim committed first creates an exact `effect_started` generation that cannot be recalled. Later cancellation prevents retry but permits settlement for that generation. Account deletion erasure wins over settlement, so a missing row is inert even though its already-started provider call may have completed. Revocation similarly prevents new claims and retries while allowing exact-generation settlement; an unsettled started generation eventually becomes ambiguous.

  The cron runs once per minute and claims at most ten delivery groups per action run. A group gets at most three network attempts with an 8-second request timeout, waiting 60 seconds before the second attempt and five minutes before the third. An `effect_started` generation without settlement becomes retryable after two minutes. No attempt may begin at or beyond the earliest member deadline, locally supplied allowed-window end, or 23 hours after the first attempt. The one-hour margin keeps every full request timeout and ordinary clock or transport delay inside Resend's documented 24-hour idempotency-key retention. The horizon or attempt cap terminalises any unsettled effect as `ambiguous`; no new key may be minted. Hard caps independently allow at most three claimed groups per source device per rolling hour, six per user per rolling hour, and 24 per user per rolling 24 hours.

  Resend requests use the pinned immutable payload and key. A strictly parsed 2xx body containing one bounded provider message id is accepted. Network failure, timeout, 408, 429, 5xx, a malformed 2xx response, 409 `concurrent_idempotent_requests`, and every unknown or incoherent response remain retryable with the same key inside the horizon and otherwise become ambiguous. Only strictly parsed, documented no-effect status and error-type pairs for request validation, authentication, authorization, endpoint, or parameter failure become refused. A 409 `invalid_idempotent_request` is immediately ambiguous because it proves key or body divergence after a possible earlier effect. If recovery has already advanced the durable group, a 409 from an older admitted generation still terminalises the current same-key group as ambiguous and consumes that older generation's exact fault slot before a later result can reverse it. Each distinct delivery-generation or storage-corruption observation consumes its own pre-reserved fault row; the oldest unreviewed row is operator-visible, every row is reviewed by exact public fault id and evidence tuple, and global re-enable remains blocked until no latched row exists. Storage-corruption quarantine targets and attests that exact row, while account deletion erases only the target user's rows and cannot clear another user's global latch. Public status never exposes the user id, capacity, anchor, quarantine locator, or attestation. The delivery action has exactly one settlement call for each resolved or aborted fetch; an injected contradictory mutation after accepted, refused, or ordinary-terminal capacity was released fails without reversing terminal state, scheduling retry, or creating a provider effect. States are exactly `pending | effect_started | accepted | refused | ambiguous | cancelled | expired`; only pending and effect-started rows are nonterminal, and terminal rows expire after seven days.

  **Implementation checkpoint (2026-09-05):** The owner explicitly authorized the sanitized daemon-to-hosted metadata export and its documented ability to queue email side effects. The current tree now implements the serialized status, exact hosted complete reconciliation, and invalidation bridge with exact execution-lease attachment, fail-closed whole-snapshot invalidation, strict offline receipt reporting, and bounded reconciliation cadence. Its separate bounded CAS state is deployment- and identity-scoped, fenced before and after every operation to the exact active identity-selector generation, and bound to the current user and device. A same-user replacement device may clear old-device custody only after a strict live authority-status observation under the replacement's active authority; offline, changed-selector, and different-user paths cannot reset or read stale evidence. The local opt-in and hours revision, read-only client contracts, inactive hosted outbox, delivery transport, lifecycle, quotas, maintenance, and globally absent enablement remain implemented. Independent re-review, the exact-tree aggregate gate, inactive deployment, and production readback remain outstanding; Phase 8 and 8C are not complete, and global delivery and the canary remain disabled.

  **8C, staged activation (not started):** Deploy schema, lifecycle code, cron, and optional controls first with global delivery disabled by absence. Then deploy daemon and app support while every machine remains opted out. Activation requires exact-production proof of the Resend key and sender, the canonical deep link, same-key/same-body replay, changed-body ambiguity and safety shutdown, timeout and 429/5xx recovery, concurrent 409 handling, post-send crash recovery, accepted and bounced test addresses, disable/revocation behavior, and outbox readback. Enable one owner machine as a canary only after those proofs. Rollback disables enqueue and claims first, waits beyond the bounded action timeout, classifies any started attempt, and retains additive hosted schema until rows drain.
- **Acceptance criteria:**
  - One pure policy is the only source of remote action membership used by projection and live verification; the app has no per-kind authority mirror.
  - Every command grant, every permission grant, file-change acceptance, session grant, cancel, secret, free-text or Other answer, unsafe or unrepresentable answer contract, unknown form, and MCP answer remains local.
  - Old-app/new-daemon and new-app/old-daemon combinations expose no new action. Prepared, written, terminal, and locally expired interactions expose no action.
  - Convex and Resend receive no plaintext prompt, transcript, answer, headline, summary, exact command, affected path, requested permission value, question id, question text, form field name, or provider credential through the notification path. Existing end-to-end encrypted projection remains ciphertext to Convex.
  - Default-off or never-enabled local policy and missing global enablement mean no enqueue and no claim. Existing Phase 7 state never silently opts a machine in. After an enabled machine disables while disconnected, local enqueue stops immediately and stale hosted claim authority expires within two minutes; status exposes the bounded pending interval instead of promising instantaneous remote revocation.
  - One complete machine snapshot is the only enqueue authority. Overflow, incomplete lease proof, unknown policy generation, stale global generation, and malformed reconciliation fail closed by invalidating the source device's pending rows.
  - Hosted cancellation is ordered by transaction commit: invalidation, expiry, or generation change committed or observed before claim prevents send; once claim commits, the exact generation may settle but can never be recalled or retried under a new body, recipient, group, or key.
  - Sessionless interactions never enter the email path and do not poison completeness for session-linked candidates.
  - Notification enablement and hours share one local revision; the hosted global control has an independent generation. Disable and re-enable cannot revive rows from either older generation.
  - Retry resolves the current uniquely verified recipient again and requires its digest to match the original claim. No hosted row stores the plaintext address.
  - Claim and retry revalidate every member's exact execution-lease tuple and the source-device consent lease. Any mismatch fails the whole group without a provider call.
  - Every new hosted table appears in lifecycle, quota genesis, account deletion, device revocation, maintenance, bootstrap and schema invariant maps. Pending rows expire, started rows close accepted, refused, or ambiguous, and terminal rows expire after seven days.
  - Provider acceptance is reported as provider acceptance only. Bounce proof is a release check, not an inbox-delivery state, unless a separately reviewed signed webhook receipt design is added later.
- **Validation:** exhaustive interaction-kind, state, deadline, and action matrix; answer-contract and projection parser properties; old-client compatibility; same-revision journal recovery; panel state reset; local opt-in migration and clock tests; hosted authorization, idempotency, coalescing, cap, expiry, refusal, retry, ambiguity, deletion, revocation, maintenance, quota, and schema suites; inactive deploy readback; then the explicit live canary matrix in 8C.

## Phase 9: Hostile inbound email decisions

- **Status:** Not started
- **Depends on:** Phase 8 and an accepted authority and privacy design
- **Objective:** Convert a narrowly parsed closed email reply into a pending encrypted request that only the local custodian may verify and apply.
- **Scope:** Raw webhook verification, deduplication, bounded content fetch, purpose-separated reply capabilities, lifecycle and quotas, daemon consumption, and audit evidence.
- **Out of scope:** free-text answers, attachments, HTML-only mail, secrets, file acceptance, session grants, and direct execution in Convex.
- **Approach:** Verify the untouched raw webhook before parsing, deduplicate by provider event id, reject unknown capabilities before fetching content, accept only exact closed decision words, and store only keyed token digests. Bind each capability to user, session, interaction revision, execution device, auth epoch, address generation, allowed action, and the earlier of its own expiry or interaction deadline. Recompute the ordinary live policy locally.
- **Acceptance criteria:**
  - Sender identity is defense in depth, never authority.
  - Duplicate, reordered, stale, revoked, quoted, auto-generated, oversized, ambiguous, and attachment-bearing mail fails closed.
  - A reply can do no more than the bound browser action at the same revision.
  - Tokens, addresses, body text, and asks never appear in logs or receipts.
- **Validation:** raw signature fixtures, timestamp and replay cases, fetch failures, every revocation axis, ambiguous outbound and inbound retries, secret scrubbing, and hosted lifecycle suites.

## Phase 10: Event-driven bounded supervisor

- **Status:** Not started
- **Depends on:** Phases 5, 6, and 8 plus dogfood evidence
- **Objective:** Run a stateless bounded supervisor only for named stalled or batched-attention events, using Astra Ultra and exact Work capabilities.
- **Scope:** Closed trigger union, deduplication, cooldowns, budgets, prepared effects, evidence, kill switch, and visibility.
- **Out of scope:** an always-on manager conversation, idle polling, approval resolution, account rotation, provider fallback, or scope expansion.
- **Approach:** Bind each run to a source id and revision, cancel on newer progress, distinguish active provider work from a stall, prohibit recursion, and require monotonic progress. The supervisor may advise or dispatch only inside an explicit Work route and capability.
- **Acceptance criteria:**
  - Duplicate or stale triggers cannot spend twice.
  - Pending approvals trigger notification or triage only and are never resolved.
  - Per-run and daily caps, cooldowns, recursion refusal, and kill switch are enforced before provider work.
  - Each run leaves content-free evidence linking trigger, exact route, effects, and outcome digest.
- **Validation:** crash injection, duplicate and stale triggers, long-running healthy turn, pending interaction, recursion, budget exhaustion, provider ambiguity, restart recovery, and cleanup tests.

## Open questions and evidence gates

- **Astra alias migration: resolved 2026-09-05.** `(preset, preset_contract)` is the durable identity for the frozen Sol and Astra mappings; state and Work own the binding and exact requirements cross every runtime boundary.
- **Future canonical candidate identity, resolver: Phase 4 integration owner.** Generalize beyond those two frozen contracts only after inventorying every current reader, writer, trigger, projection, and downgrade path. Reusing a tier is forbidden.
- **Terra Ultra support, resolver: provider capability evidence.** The exact pinned Codex runtime and account generation must admit the model and effort before a preset exists.
- **Terra routing, resolver: private holdout.** Require preregistered non-inferiority evidence; a public benchmark or forty arbitrary tasks is insufficient.
- **Opus model and effort, resolver: Claude runtime review plus private holdout.** Current pinned evidence covers one Fable profile only.
- **Rich email content, resolver: owner privacy decision.** It conflicts with the current encrypted hosted boundary and is not presumed acceptable.
- **Email reply authority, resolver: security review.** The accepted design must preserve device, auth epoch, execution custodian, revision, deadline, and live-verification properties.
- **Astra availability: resolved 2026-09-05.** The owner has access, the pinned runtime reports the exact model and efforts, and Astra is the admitted Codex baseline; this supplies no evidence for Terra routing or automatic Fast.

## Delivery policy

Each phase receives focused implementation and independent review before its status changes. The integration owner records exact commands and results below. After the requested phases converge, run the installed `hra-host-run --mode=heavy --lane=compute --label=hra-model-routing-final -- bun run check` wrapper on the exact tree, then follow the repository's protected pull request, required CI, merge, release, deployment, and production-readback rules. Do not invent a release version or treat focused tests, public benchmarks, synthetic fixtures, or a shadow decision as live evidence.

## Implementation log

- 2026-09-05, Phase 8B daemon bridge implementation: After explicit owner authorization, wired the active daemon's strict bounded attention snapshot to the existing hosted authority-status and reconciliation mutations. The bridge publishes and retains the coherent local policy revision, processes and settles remote commands before taking the first snapshot, establishes one exact current execution lease per distinct session, rechecks the whole local snapshot after lease acquisition, and sends either one exact hosted complete candidate set or one fail-closed invalidation. Complete reconciliation, direct status, and disable share the daemon's serialized lane ahead of optional projection work. A separate 4 KiB deployment- and identity-scoped CAS custody slot retains only bounded request metadata, pending uncertainty, and strict server receipts—never candidate, session, or interaction ids—so a lost complete is never replayed, a later invalidation uses a strictly higher sequence, and offline status reports only an exact persisted bound. The slot is fenced to the exact identity-selector generation; stale identity receipts are unreadable, while same-user device rollover resets only after strict live current-device status. Unchanged state is retried no faster than 15 seconds and a settled notification-consent lease is renewed within 60 seconds. Focused worker evidence: 468 tests and 3,837 assertions passed across identity custody, the cloud journal, attention boundary contracts, the daemon bridge, daemon adapters, the service, and hosted attention runtime; repository TypeScript, focused ESLint, and diff checks passed. Independent re-review, the exact-tree aggregate gate, inactive deployment, and production readback remain required. Global delivery remains disabled by absence, no canary is enabled, and Phase 8C has not started.
- 2026-09-05, Astra baseline amendment: Versioned the durable preset alias contract instead of silently relabelling established sessions. Contract 1 preserves exact Sol Max and Sol Ultra identities for pre-v38 and imported state; contract 2 binds new and explicitly reselected High and Ultra sessions to Astra Max and Astra Ultra. Exact model, effort, provider, and contract authority now cross review, queue, provider-switch, recovery, and Work boundaries; mixed tuples, provider collisions, recovery-time reselection, and switch seeds that disagree with immutable evidence fail closed. Routing-evaluation schema 1 remains exact Sol while schema 2 records Astra, and public CLI, app, site, onboarding, and compatibility copy now match the versioned behavior. Adversarial review found and closed three defects in recovery immutability, Work provider/contract fencing, and historical provider-switch evidence; two independent final reviews found no remaining P0-P2 issue. Focused evidence: routing evaluation 25 tests/90 assertions; Work store 44/778; site content 34/987; v38 and newer-schema CLI migration groups 3/16 and 2/10; cross-layer contract suite 16/256; recovery 2/10; exact switch history 3/31; the six-file regression produced 468 passing behavior tests and exposed one stale test double, whose repaired exact adapter regression passed 1/41. TypeScript, scoped lint, generated-site, and diff checks passed. This amendment admits no Terra or automatic Fast behavior, starts no Phase 8C work, and leaves global attention delivery and its canary disabled.
- 2026-09-05, Phase 8B design gate: Replaced the inherited per-session enqueue sketch with one bounded, complete machine reconciliation protocol after an adversarial repository-wide impact survey. A second attack review removed an impossible instantaneous-offline-revocation guarantee and a sessionless-interaction deadlock: hosted consent now has a two-minute server-clock lease with explicit pending-revocation status, and only session-linked interactions participate without poisoning snapshot completeness. A final review required live revalidation of every stored execution-lease tuple, changed unknown provider outcomes from false refusal to same-key retry then ambiguity, made idempotency-key and body divergence immediately ambiguous, and shortened retry authority to 23 hours so transport cannot cross Resend's 24-hour key lifetime. The frozen protocol also defines hosted commit-order cancellation, fail-closed overflow, one-row-per-interaction digest groups, immutable same-key retries, separate local and global policy generations, recipient-digest continuity, deletion and revocation races, CLI-only consent authority, DST transition semantics, and exact operational caps and timers. No delivery is enabled by this design gate; implementation and inactive deployment evidence remain required.
- 2026-09-05, Phase 8A: Replaced the former per-client approval heuristics with one browser-safe, versioned `decline | answer` policy shared by compact projection and live daemon verification. Every grant, cancel, session scope, free-text or Other response, and MCP answer stays local; remote answers require a complete closed-choice user-question set plus an own, exact provider-losslessness marker, and both provider compilers independently validate the submitted translation. Compact detail v2 fails closed across old and unknown policy revisions, the app derives controls only from parser-validated policy, and foreign JSON is copied through bounded accessor-free snapshots before authority-bearing reads. Adversarial review found and closed cross-kind reason smuggling, prototype-inherited losslessness and optional-field authority, duplicate literal provider questions, stateful draft accessors, unsafe legacy answer shapes, retry ambiguity, and aggregate envelope-limit gaps. Exact focused evidence: 155 tests passed with 1,542 assertions; repository TypeScript, production app build, generated-site parity, public-tree policy, focused final-tree ESLint, and diff checks passed. Two independent reviews found no remaining P1/P2 defect. This slice enables no email delivery, changes no notification consent, and does not widen any local approval category.
- 2026-09-05, Phase 7: Added a strict versioned per-machine notification-hours policy with one-time 10:00 through 22:00 machine-zone initialization, inclusive-start and exclusive-end evaluation, overnight and DST handling, optimistic local revisions, guarded append-only SQLite migration, local CLI status and set commands, a machine-only device command, and a separately encrypted additive registry envelope. The app distinguishes an older daemon from an unreadable projection, retains active-device authority, prevents duplicate or stale form submissions, and states explicitly that notification delivery is not active and that approvals and autonomy do not read the schedule. Adversarial review closed malformed clock normalization, heartbeat draft clobbering, duplicate enqueue, stale-device enablement, misleading success and capability copy, projection corruption ambiguity, and revision-exhaustion result gaps. Focused evidence: 144 domain and storage tests passed; 100 parser and renderer tests passed; the full daemon service suite passed; 181 cloud payload, policy, adapter, and bridge tests passed; 7 Convex registry tests passed; 39 app registry and model tests passed with 108 expectations; app build, typecheck, scoped ESLint, and diff checks passed. Independent cloud, UI, storage, CLI, and integration reviews found no remaining P1/P2 defect. The policy still relies on the host ICU timezone database for future wall-clock interpretation, and no notification delivery path consumes it in this phase.
- 2026-09-04, integration prerequisite: Rebasing onto the delivery-autonomy baseline exposed two independently confirmed Claude Auto-mode bootstrap regressions. Repaired capability detection so structurally valid empty effective configuration lists remain eligible for convergence while shipped defaults must stay nonempty, and preserved custom environment constraints behind one `$defaults` entry instead of overwriting them. Focused evidence: 17 bootstrap tests passed with 124 assertions; focused ESLint and diff checks passed; independent review reported no findings. This repair changes no HRA model route, provider authority, or runtime permission decision.
- 2026-09-04, Phase 1: Added one exhaustive provider-default function, changed implicit Codex CLI starts from `high` to `ultra`, preserved explicit presets and Claude's `fable-max` default, corrected Low and High labels to Luna Max and Sol Max, and added an explicit Fast control. Review repaired optimistic model and Fast selection so the browser highlights only an exact applied command, corrected the grid labels, and closed an existing daemon defect by refusing Fast enable on Claude before local or remote metadata mutation while retaining Fast disable as a repair path. Focused evidence: 72 preset/parser/app tests passed with 4,459 assertions; 7 Claude session tests and 15 app settings tests passed with 136 assertions after the gap repair; two existing Codex Fast serialization tests passed in independent review; two scheduled app builds passed with 441 modules; diff checks passed. Independent review found no remaining Phase 1 defect. No storage, approval, account, provider-switch, or established-session contract changed.
- 2026-09-04, Phase 2: Added a pure ordered `well_defined | open_ended | mechanical | uncertain` task-shape classifier, stable fixed reasons, UTF-8 and unsupported-format refusal, reported-text handling, hostile routing-directive resistance, conservative conflict and authorship boundaries, a content-free synthetic fixture, and an explicit-path private fixture generator that never discovers histories or emits task text, hashes, or lengths. Multiple adversarial rounds closed directive smuggling, conflicting quoted outcomes, operative nested literals, mechanical requests with hidden effects, Unicode variation attacks, and mixed reported/operative clauses. Focused evidence: 36 tests passed with 2,736 assertions; focused ESLint and diff checks passed. Final independent review reproduced the last two attacks as fail-closed and reported no findings. The classifier remains unwired and provides no routing authority or holdout evidence.
- 2026-09-04, Phase 3: Added a strict content-free shadow-routing contract whose candidate ids cannot be admitted presets, preserves every established or explicit route, excludes strong-required and non-well-defined work, fixes `runtimeMutationAllowed` to false, and rejects incoherent rule, reason, route, candidate, or blocker combinations at the exported schema boundary. Added an explicit-path paired-study analyzer with bounded regular-file reads, symbolic-link refusal, closed comparison and outcome schemas, balanced randomized order, an independently recomputed domain-separated case-set digest over ordered opaque case ids and environment commitments, conservative paired non-inferiority bounds, an assumption-labelled Student-t upper bound for Terra-only Fast latency evidence, provider-native usage totals, and permanently false Phase 3 activation. It prints only aggregate evidence and generic refusals. Adversarial review found and closed evaluator/candidate, receipt-binding, decision-schema, and statistical-claim gaps. Focused evidence: 45 tests passed, focused ESLint and diff checks passed. No provider task ran, no private history was discovered, and no candidate, Fast policy, preset, session, or live routing path was enabled.
