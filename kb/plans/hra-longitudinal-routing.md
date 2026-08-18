---
type: plan
area: desktop-routing
status: in-progress
title: Longitudinal routing evidence and shadow recommendations
description: Route ordinary root prompts through a bounded deterministic policy while building per-pane, content-free evidence for later shadow recommendations.
tags:
  - model-routing
  - evaluation
---

# Longitudinal routing evidence and shadow recommendations

## Outcome

HRA can accumulate and query weeks of local routing evidence for one durable
chat pane, then use that evidence to support an explainable recommendation for
a later eligible turn. The first implementation materializes a bounded shadow
assessment and records an immutable analysis receipt. Because it has no
accepted quality signal, it abstains instead of recommending a route. It does
not change a model, reasoning effort, service tier, account, actor, or provider
request.

The recommendation must clear a conservative quality floor before latency or
token use can affect its rank. Missing or inconclusive quality evidence causes
an abstention. HRA's active deterministic router remains authoritative unless
a later, separately approved policy revision changes that router.

Ordinary root turns now have a separate active deterministic policy. Automatic
classification uses the current prompt plus the prior content-free route for
an exact continuation. It selects one of Luna Max, Sol Max, or Sol Ultra and
also requests Fast or Standard. Root panes expose no model, effort, tier, or
routing preference. Recursive callers provide only a semantic work class; HRA
maps it to the model, effort, and service tier. Neither active policy reads or
activates the longitudinal shadow recommendation.

## Current implementation

- Migration v24 gives each ordinary chat a durable `chat_panes.pane_id` and
  keeps the pane across process restarts and provider-thread or account
  handoffs. Root routing classifies each admitted prompt before provider work,
  ranks eligible accounts from fresh usage state, then resolves the exact
  profile-and-tier candidate against the chosen account's current capability
  evidence. It has no longitudinal model learner.
- Harness actor rows already retain work class, requested execution profile,
  requested and realized service tier, lineage, and exact token facts. They do
  not prove observed provider-profile compliance.
  Migration v42 enforces that an actor's model and reasoning effort cannot
  change within one incarnation. Migration v45 adds the ordinary root decision
  receipt described below. Migration v46 derives every recursive logical
  turn's immutable requested tier from its actor's work class and requires each
  attempt to copy that exact tier. Exact ordinary-root token and
  provider-reroute attribution remains outside the v1 longitudinal aggregate.
- `optimizer-evidence-v1.ts` is a pure Phase 0 evaluator over frozen fixtures.
  Its results grant neither policy nor rollout authority.
- `proposal-service.ts` can persist an immutable Suggest proposal. The v1
  background loop is separate: it analyzes one dirty pane at an idle tick and
  records only a non-activating receipt. It cannot create a proposal, change a
  policy, call a provider, or write to Git.

The longitudinal portion of this plan adds an observation and advice layer.
It remains unable to change the active deterministic prompt policy until a
later activation design is separately accepted and verified.

### Implemented v1 slice

Migration v44 materializes content-free recursive actor outcomes under the
stable ordinary `pane_id`, maintains indexed per-arm sufficient statistics and
dirty-pane heads, and derives exact token dimensions from positioned actor
attempt evidence when present. Missing token dimensions stay missing. The
route arm keeps requested and realized service tier separate, so a direct
Standard request cannot collapse into a Fast request that fell back. The
bounded `routing.inspect {}` operation lets the authenticated current actor
read that cross-epoch summary without receiving custody IDs, provider or
account identity, paths, content, or timestamps. Its output names route intent
`requestedProfile` and carries bounded literals saying that v1 includes
recursive actor outcomes only and excludes ordinary root-turn spend.

The lifecycle-owned local analyzer processes at most one dirty pane per idle
timer tick, rotates its keyset cursor before inspection so one malformed pane
cannot starve the rest, and writes an immutable, non-activating analysis
receipt. A bounded content-free diagnostic reports failures while their
evidence remains pending. Because no accepted quality source exists yet, it
records either insufficient operational evidence or quality evidence required.
It cannot recommend or activate a route, and it has no path into the active
root or recursive router.

Ordinary root Codex turns remain deliberately absent from v1 longitudinal
totals. Migration v45 records their content-free routing decision and
operational lifecycle, including the accepted generation and stream position,
but does not claim token or provider-reroute attribution. Treating pane
settings or a lossy lifecycle callback as realized usage would still be false
precision. Exact root spend remains a later receipt-backed fact-attribution
slice with an early fact inbox and positioned token watermarks.

### Implemented active root-routing slice

Migration v45 gives every newly admitted ordinary chat turn one private
`harness_root_turn_routing_receipts` row keyed by `pane_id` and durable chat
turn ID. Chat admission writes its content-free classification in the same
SQLite transaction as the bounded chat receipt and pane revision. The row does
not reference `chat_turn_receipts`, so receipt pruning cannot make an old turn
ID reusable or erase its routing history. An optional stable root actor turn
binding is accepted only when the derived root turn belongs to the exact pane
and chat turn; the root actor itself remains `standard`.

The authority advances through `classified`, `resolved`, `effectStarted`,
`accepted`, and one terminal state. Resolution records selected profile and
service tier plus the closed `lunaUnavailable` and `fastUnavailable` fallback
reasons. Acceptance records a positive process generation and nonnegative
stream position, never a raw provider or account ID. Exact replays return the
existing receipt, conflicting replays fail closed, and SQLite triggers mirror
the API transition law. Restart settles `classified` or `resolved` as
`notApplied`, `effectStarted` as `ambiguous`, and `accepted` as `interrupted`;
no provider effect is replayed.

Pane archive is the privacy-deletion boundary and deletes the complete root
routing ledger for that pane. The pane-timeline, recovery-state, and
work-class/profile indexes cover bounded operational queries. The renderer
receives only the latest turn's lean requested and selected profile and tier,
with closed fallback reasons. Lifecycle state, operational outcome, root
identity, capability evidence, and timestamps stay private. Root spend remains
explicitly excluded from `routing.inspect` in this slice.

## Scope

### In scope

- Attribute ordinary and recursive work to the stable ordinary `pane_id` that
  owns the long-lived conversation.
- Persist content-free routing decisions, outcomes, quality signals, token
  facts, analysis receipts, and recommendations as append-only evidence.
- Provide bounded indexed queries for per-pane, recent-window, policy-version,
  work-class, and unresolved-recommendation inspection.
- Run a deterministic local analyzer only while HRA is idle and within an
  explicit resource budget.
- Emit immutable advisory proposals and evaluate them in shadow mode against a
  quality-first objective.

### Non-goals

- Activating a longitudinal recommendation or letting it change the active
  deterministic prompt route.
- Using longitudinal evidence to select a live model, reasoning effort, Fast
  tier, account, subscription, or provider.
- Reading prompts, transcripts, patches, filenames, repository paths, tool
  arguments, or provider-owned state for routing analysis.
- Provider or network calls from background analysis.
- Autonomous policy edits, source edits, commits, branches, or Git
  publication.
- Mid-incarnation model or effort changes for a recursive actor.
- Claims of better quality, speed, or token use before held-out evidence clears
  the stated gates.

## Constraints and decisions

### Learning subject

The stable ordinary `pane_id` is the learning subject. Provider thread IDs,
account IDs, root epochs, actor IDs, and actor incarnation IDs are episode or
execution lineage, not durable learner identity. An attached actor observer
pane is a projection and does not start a second learner. Descendant actor work
is attributed to the originating ordinary pane while retaining its own HRA
logical lineage.

Deleting or replacing a pane ends that learning history. HRA must not infer
identity from repository path, title, prompt text, provider identity, or Git
history.

### Evidence boundary

The ledger is content-free while a pane is retained. Recursive longitudinal
observations and analyses are immutable facts. The ordinary-root decision is
one monotonic receipt whose identity, classification, resolution, effect cut,
acceptance cursor, and terminal evidence become immutable as each phase is
set. Pane privacy deletion is the deliberate exception: archiving or deleting
the owning pane cascades its complete routing history and transactionally
removes or recomputes the derived rows.

Allowed evidence is a closed schema of HRA logical IDs, timestamps and bounded
durations, sequence numbers, policy and schema versions, work class, requested
and observed model profile, service tier, classification reason, terminal class,
explicit quality classification, exact token counts, budget receipts, and
typed abstention or fallback reasons. It excludes user and assistant content,
content digests, account and provider identifiers, repository identity or
paths, filenames, tool payloads, environment values, and Git metadata.

Foreign values are parsed from `unknown`. Unknown enum values, incomplete
lineage, conflicting terminal facts, or partial token attribution fail closed
and cannot become optimizer evidence.

### Decision precedence

The decision order is fixed:

1. Classify the ordinary root prompt with the closed deterministic v1 policy,
   or accept the recursive caller's semantic work class.
2. Map that class to HRA's requested model, reasoning effort, and service tier.
3. Apply current safety, capability, quota, account, and incarnation
   constraints through the exact closed fallback chain.
4. Calculate a longitudinal shadow assessment without giving it dispatch
   authority.
5. Execute HRA's resolved route and record its requested and selected values in
   separate immutable evidence.

No renderer or model-visible command can override the model, effort, or tier.
Any future learned policy must enter through a separately approved policy
revision, not a per-turn selection control.

### Quality-first objective

Quality is a gate, not one weighted term among speed and token use. A candidate
must meet the versioned conservative quality floor before latency or token
evidence is considered. Provider completion alone is not proof of quality.
Accepted quality facts come only from an explicit user signal or a separately
accepted deterministic verifier; absent evidence remains `unknown` and forces
the analyzer to abstain.

Among candidates that clear the same quality floor, a versioned and inspectable
score may compare bounded latency and token evidence. The score, evidence
window, minimum sample size, and confidence rule are immutable parts of the
shadow policy revision. The analyzer does not tune its own objective or
silently change weights.

### Actor incarnation boundary

An actor's model and reasoning effort remain immutable for its whole
incarnation. Shadow mode may only record a recommendation; the implemented v1
slice abstains. Any later activation could apply an actor-profile change only
by admitting a successor incarnation after the current one is idle or closed
and its terminal evidence is settled. It must never reroute a running
incarnation.

### Background analysis boundary

The first background analyzer is local, deterministic, and non-activating. It
waits until both process-local and durable foreground work are idle, processes
at most one dirty pane per unref'd timer tick, retains dirty work after a
failure or stale compare-and-swap, and stops with the harness lifecycle before
SQLite or provider processes close. It reads only the content-free ledger and
writes one immutable analysis receipt for the exact observation revision.

A later provider-backed or proposal-producing analyzer would also need explicit
wall-time, token, row, evidence-horizon, and output budgets plus cancellation
and ambiguous-effect receipts. Those ports and authorities are not part of the
first implementation.

The first analyzer's only durable output is an immutable analysis receipt. It
cannot activate or mutate policy, create a proposal, send a provider request,
select an account, alter a pane or actor, access the network, touch repository
files, or invoke Git. Turning it off leaves current routing behavior unchanged.

## Evidence model

Implement the ledger as typed records rather than a mutable aggregate:

- A **shadow policy revision** fixes eligible profiles, the evidence window,
  minimum sample sizes, quality floor, confidence rule, latency/token score,
  and analyzer budget.
- A **decision receipt** records the originating `pane_id`, HRA logical turn
  lineage, current requested route, classification reason, and the policy
  revision observed at admission.
- An **outcome fact** records the terminal class, bounded timing, requested and
  observed profile, service tier, exact token deltas when attribution is
  complete, and a reference to its decision receipt.
- A **quality fact** records `pass`, `fail`, or `unknown`, its accepted source,
  and the outcome it evaluates. Conflicting facts remain visible and resolve
  through the policy's deterministic aggregation rule.
- An **analysis receipt** records the frozen evidence watermark, budget spent,
  completion state, and proposal IDs. A cancelled or over-budget run produces
  no recommendation.
- A **routing proposal** records one candidate or an abstention, its supporting
  watermark and policy revision, quality-gate result, expected latency/token
  range, confidence, and typed reason. It has advisory authority only.
- An **invalidation fact** can exclude corrupt or later-disproven evidence from
  future analysis without updating or deleting the original row.

Every table needs insert idempotency tied to an HRA logical operation ID,
identity-update guards, one owned pane-privacy deletion cascade, bounded
values, and indexes that cover `pane_id` plus time or sequence, policy
revision, work class, and unsettled analysis or proposal state. Query services
return bounded aggregates and receipts. They do not expose raw SQL or hidden
identifiers to an agent.

## Plan

1. **Freeze the observation contract.** Define the closed content-free schemas,
   logical lineage, append-only SQL laws, quality signal sources, query bounds,
   and versioned shadow-policy format. Prove that ordinary and descendant actor
   turns resolve to exactly one originating `pane_id` before adding writes.
2. **Persist routing evidence without changing dispatch.** Add migrations and a
   narrow authority that writes decision, outcome, quality, and invalidation
   facts for ordinary and harness turns. Reuse existing exact actor token facts
   only through proven lineage; add equivalent exact ordinary-turn token
   capture. Keep provider requests byte-for-byte independent of the ledger.
3. **Add bounded read models.** Expose per-pane and policy-version summaries,
   coverage, quality-gate inputs, latency distributions, token distributions,
   and unresolved evidence through indexed, size-bounded queries. Add an
   agent-facing read-only summary that contains no content or custody IDs.
4. **Produce shadow recommendations.** Run the frozen deterministic analyzer
   behind the local idle and resource-budget gate. Persist analysis receipts
   and immutable advisory proposals. Record the deterministic requested and
   selected route, but do not pass a recommendation into dispatch
   configuration.
5. **Evaluate chronologically.** Replay frozen evidence with chronological
   train and holdout splits, compare against the current deterministic route,
   and report quality-floor pass rate, abstention and coverage, calibration,
   latency, and exact token effects. Treat observational comparisons as
   descriptive, not causal proof.
6. **Close the shadow milestone.** Keep the feature shadow-only until storage,
   neutrality, privacy, recovery, and held-out checks pass. Document what the
   evidence supports and what remains unknown. Do not add activation authority
   as part of this milestone.
7. **Design activation separately if the evidence warrants it.** A later
   accepted plan must define policy-revision authorization custody, canary
   scope, rollback, monitoring, and ordinary-turn versus successor-incarnation
   admission. HRA remains the sole per-turn dispatcher, and background work
   must remain unable to activate policy or provider effects.

## Verification

- Stable subject: restart, account handoff, provider-thread replacement, Git
  commit, and child-actor fixtures retain the same originating `pane_id`.
- Append-only storage: migration and property tests reject retained-history
  identity updates, deduplicate retried inserts by operation ID, settle or
  invalidate by inserting a new referenced fact, and verify the complete
  pane-privacy deletion cascade separately.
- Content-free boundary: schema allowlist tests and serialized fixtures prove
  that prompts, responses, content digests, provider or account IDs,
  repository data, tool payloads, paths, filenames, environment data, and Git
  metadata cannot enter the ledger or query projection.
- Neutrality: deterministic provider-port tests produce the same provider
  requests, account ranking, root route, actor profile, and tier decision with
  shadow routing enabled or disabled.
- Router ownership: contract and model-visible schema tests reject model,
  effort, tier, acceleration, and routing-mode controls while preserving only
  the recursive caller's semantic work class.
- Actor immutability: existing incarnation trigger and domain tests continue to
  reject model or effort changes; future recommendation tests target only a
  hypothetical successor incarnation.
- Quality ordering: property tests show that `fail` and `unknown` candidates
  are never latency/token-ranked, and that insufficient or conflicting quality
  evidence yields an abstention.
- Query bounds: `EXPLAIN QUERY PLAN` and seeded multi-month fixtures prove that
  per-pane and unresolved-work reads use covering indexes and respect row and
  time limits.
- Background containment: provider, network, arbitrary-filesystem, policy,
  pane, actor, and Git effect ports are unavailable by construction;
  foreground work and budget exhaustion cancel the run before proposal
  insertion.
- Recovery: crash-point tests around every insert recover to one immutable
  decision, terminal fact, analysis receipt, or typed incomplete state without
  replaying a provider effect.
- Evaluation: a frozen chronological holdout report records quality-floor
  results before latency and exact token comparisons and grants no policy or
  rollout authorization.

## Risks and recovery

- Observational history can encode selection bias and cannot prove the result
  of an untried profile. Shadow mode, abstention, chronological holdout, and a
  later separately authorized trial design contain that risk.
- Weak quality labels can reward short or incomplete work. Completion remains
  an operational outcome rather than a quality pass, and unknown quality never
  clears the floor.
- A capture defect could contaminate later analysis. Closed schemas prevent
  content capture; append-only invalidation facts exclude bad evidence without
  rewriting history.
- Long-running panes can grow the ledger. Covering indexes, bounded windows,
  immutable aggregate checkpoints, and per-run read budgets keep retained
  evidence queries bounded; explicit pane privacy deletion still erases the
  pane-scoped history.
- Shadow work could contend with foreground work. v1 uses idle admission,
  one-pane ticks, bounded reads, backoff, and lifecycle drain to protect the
  interactive path. Explicit wall-time, CPU, and evidence-horizon budgets plus
  cancellation remain required before any provider-backed or proposal-producing
  analyzer exists.
- If the feature proves unsafe or misleading, remove the analyzer wiring in a
  follow-up while retaining the content-free rows for diagnosis. v1 exposes no
  runtime disable control. Do not roll back the schema by dropping evidence
  tables or editing prior facts.

## Execution evidence

- 2026-08-17: The pre-implementation repository audit confirmed durable
  ordinary `pane_id` storage in migration v24, fresh per-turn account ranking
  in `chat-service.ts`, immutable actor execution profiles and exact actor
  token facts in migration v42, a no-authority Phase 0 optimizer, and immutable
  Suggest proposals. No longitudinal ledger, per-pane learner, background
  analyzer, or activation path existed at that baseline.
- 2026-08-17: Migration v44, the bounded `routing.inspect {}` operation, and
  the lifecycle-owned idle analyzer implemented the recursive-actor shadow
  slice. Focused migration, recovery, compatibility, query-plan, privacy,
  lifecycle, and domain tests passed. Live provider routing and policy
  activation remain unchanged.
- 2026-08-17: The joined focused routing suite passed 182 tests with 4,983
  expectations. Desktop type checking, lint, public-boundary and public-tree
  policy checks, agent-guide validation, and the KB graph passed. A separate
  hostile routing audit passed 73 focused tests and found no P0 or P1 issue.
  The audit accepted requested-profile attribution only as an explicit
  intent-to-treat shadow view; observed provider-profile compliance remains a
  prerequisite for any later recommendation or activation.
- 2026-08-17: A final agent-usability audit required the model-visible response
  to state its recursive-actor-only coverage and rename the profile arm to
  `requestedProfile`. The corrected schema, strict parser, single-call example,
  compatibility digest, SQLite projection, and agent guidance passed 52 focused
  tests with 1,068 expectations. The follow-up audit approved the contract.
- 2026-08-17: On the joined tree based on
  `89da5b4622390c968068bb413a7a6ed42aa1a032`, the scheduler-coordinated
  host-context `bun run check:complete` passed in 831,946 ms. It covered every
  public policy, workspace typecheck and lint target, 2,459 desktop tests, 36
  Application Support migration tests, two feasibility tests, 20 compiled
  gateway integration tests, the CLI and web suites, and every production
  build. The first restricted-shell attempt had rejected the product's nested
  macOS `sandbox-exec`; the exact bundled-Git suite then passed 18 of 18 under
  the supported host boundary, and no source exception or test skip was added.
- 2026-08-18: The active HRA-owned router removed every root-pane and recursive
  model, effort, tier, acceleration, and routing-mode control. Root prompts now
  classify into bounded leaf, standard, large-change, or wide-research routes;
  capability resolution evaluates the complete fallback chain against one
  generation-fenced catalog before the provider effect. Recursive callers
  provide only an immutable semantic work class, and migration v46 derives the
  logical-turn tier and enforces attempt equality. Independent hostile audits
  approved the root, recursive, and migration boundaries with no P0 or P1
  findings after passing 219, 219, and 189 focused tests respectively.
- 2026-08-18: A final joined seam check added structural public, private, and
  SQLite constraints for inherited work-class/tier combinations and removed
  the retired Automatic Fast control from Direct's browser verifier. The
  focused contract, policy, storage, Direct, and harness-settings run passed 72
  tests with 3,358 expectations; desktop, task-protocol, and web type checks
  passed. Repository-wide and browser verification remains pending on the
  rebased delivery tree.
