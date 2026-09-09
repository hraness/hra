---
title: Claude connection ownership with Effect
type: plan
status: in-progress
---

# Claude connection ownership with Effect

Design: [issue 166](https://github.com/hraness/hra/issues/166).

Status: implementation and focused client/manager validation complete; package,
final integration and delivery remain pending. The measured baseline
is `82637bb9a5423adffb5185dc175fd74eb5dd2c89`, an ancestor of
[the provider-usage candidate](https://github.com/hraness/hra/pull/140).
The isolated branch now includes that candidate's
`fb1bf7e72dd89ca453dbee2bc51f96b0cfbbf348` source through merge
`86f7f790a80f81a52e2852a064255855ba278618`.
This work depends on that integration and retains its release ownership. The completed
[Codex migration](effect-provider-session.md) remains a separate provider contract.

## Problem and boundary

On baseline `82637bb9`, manager close completes while an already-admitted
start-time configuration lookup remains pending. The controlled baseline holds that exact
lookup through the public manager and releases it on a later native timer turn.
Both successful lookup and original `undefined` rejection reproduce early close;
three unchanged pre-acquisition controls pass. No process or host-tool binding is
created, and all controlled work is joined. This establishes a missing ownership
barrier, not a native-process leak.

Replace the complete Claude connection's asynchronous scheduling with native
Effect programs on one prepared interpreter. Include acquisition, process/client
adoption, initialization, durable identity admission, writes, facts, deferred
interaction notices and shutdown. The client and manager retain their public
Promise APIs and product authority. No dependency, provider pin, schema, replay,
fallback, credential policy or account-routing change is part of this plan.

## Ownership and compatibility

- Reserve the exact thread and consume its review synchronously. Register the
  acquisition before configuration or provisioning can yield. A failed
  pre-acquisition start frees its reservation; an unresolved acquired resource
  retains the exact fence.
- Adopt a raw process before client construction. Retain native identity, exit,
  output, write and cleanup settlements independently of interruptible Effect
  observers. A rejected exit Promise or requested signal is not exit proof.
- Publish only after initialization, exact provider identity and the durable
  PID/start callback succeed, followed by fresh abort and authority checks.
  Required host-tool bindings remain inactive until their existing activation.
- Preserve one deferred FIFO native writer, synchronous turn admission,
  sequential fact callbacks, bounded buffering, exact digests and original
  failure precedence. Represent failure presence independently of falsey values.
- Reserve a response's future notice before its write can yield. Dispatch that
  notice on the existing later native event-loop turn, after its resolving call
  can release daemon serialization. Close accounts for the whole continuation;
  stale-generation guards may make its attempted delivery a no-op.
- Close fences new admission synchronously. Callback-local self-close refuses
  before state mutation. Join every owned operation or return an incomplete
  bounded result that retains the exact retry owner. Do not dispose the only
  handle to unfinished native work. Joining a provider identity inspector's
  exposed Promise does not add proof about its private inspection subprocess.
- Reconcile custody after admission joins, including a binding that arrives
  after the initial close snapshot. Report retained cleanup failure separately
  from an ordinary failed start. A failed revoke must retain its exact binding
  and make close incomplete; it cannot become success merely because no
  resource existed in the earlier snapshot.
- Retain native identity settlement separately from the first rejected
  initialization/identity result. Failed acquisition keeps its reservation until
  its exact connection owner can be disposed, even after process exit is proved.
  The synchronous identity-accessor failure path also observes the original
  initialization handle so its timer, abort listener and rejection are joined.
- Retire ended connection runtimes when their already-admitted work settles.
  Session end must release daemon serialization before a deferred notice needs
  that same authority. Retain one retirement Promise, fence new public runtime
  work immediately, and let manager close observe that Promise with its normal
  bound. Concurrent disposal callers share complete scope-finalization proof.
  Retirement of an older admitted connection may remove only that connection;
  it cannot clear a newer acquisition's reservation for the same thread.
- Bound observation of manager-owned acquisition, capabilities and deferred
  continuations with a separately named `connectionShutdownSettlementMs`,
  default 1,000 ms and valid from 1 to 30,000 ms. Expiry reports incomplete
  cleanup and retains the original owner. It does not cancel configuration
  lookup or replace the child's existing TERM and settlement bounds.
- Preserve the existing client diagnostic callback's throw precedence and
  manager disconnect sanitization. Do not turn all diagnostics into a new
  best-effort policy.

Acquisition registration, native identity and constructor-failure retention, the
write/notice shutdown barrier and synthetic callback self-close refusal are
explicit cleanup strengthenings. Other public behavior remains compatible.

## Phases

| Phase | Owner | Acceptance | Status |
| --- | --- | --- | --- |
| Contract and R1 baseline | Independent source and test reviewers | Exact caller/port map, retained red trace, unchanged controls and joined fixture cleanup | Complete on the isolated baseline |
| Connection programs and client | Client implementer | Shared internal owner API, native initialization/writer/reader/close programs, deleted replaced scheduling, focused client preservation | Complete: 47 tests, 367 assertions |
| Acquisition and manager | Manager implementer | Same interpreter from pre-acquisition through close, unchanged R1 oracle green, exact authority and all-child cleanup | Complete: 83 tests, 587 assertions |
| Causal and architecture review | Independent reviewer and integrator | Actual-facade timing, raw failures, held native operations, callback ordering, module roles and deletion review | Final service replay and review readback in progress |
| Current-source integration and delivery | Integration and release owner | Current owner join, exact Required CI, applicable native/install/release and production evidence | Pending |

The client worker owns the local model/platform/program/runtime modules and
client facade. The manager worker owns its program and facade. One integrator
owns module policy, manifests, documentation and final checks. Independent tests
use actual public facades and controlled native ports; a copied algorithm cannot
certify the migration. Workers run focused checks once for their changed inputs.

## Validation

Preserve existing process/protocol/assembler, client, manager and daemon service
oracles. Cover create/resume, one-use reviews, initialization versus identity
arbitration, held durable admission, required/disabled host tools, exact
generation changes, quarantined local reads and all-child failure collection.
Keep the original R1 ordering oracle for the eventual green run.

Add causal schedules for started writes that outlive exit, late provisioning,
client-constructor failure, held activation/revocation, final facts and output,
response acknowledgment versus deferred notice dispatch, synthetic self-close,
and raw write/observer/diagnostic error selection. Each schedule releases and
joins its actual controlled native work in cleanup. Preserve native return
timing instead of treating an Effect yield as an event-loop turn.

Run relevant focused tests and lint/types, module-role policy and the existing
CI coverage-equivalence tests. Follow the current contribution policy for the
complete Required source aggregate, native acceptance and final current-base
binding. Release and production evidence remain separate. Do not repeat a full
local aggregate when Required CI already owns its authoritative equivalent.

## Evidence log

- The baseline added one parameterized regression to
  `src/daemon/claude-runtime-adapter.test.ts`: three controls pass, two new
  ordering checks fail, 51 assertions. Both traces place `close-fulfilled` before
  original lookup settlement. All represented cleanup completes. Test digest:
  `1cf959204ba18f58b8a7d184e516ace586c34272a9101ab4472951df4a552d05`.
- Independent review accepted the exact source, raw causal traces, original
  falsey reason and fixture cleanup. No broader, native or delivery acceptance
  follows from that baseline.
- The existing client `closed_after_result` case expects successful close while
  its original write is held. This expectation conflicts with the adopted
  complete-native-work barrier. Preserve its staged-fact assertions and record
  the unchanged baseline, then require bounded incomplete close, release/join
  of that write, and successful exact-owner retry. This is an explicit behavior
  correction, not a claim that the original test remains unchanged.
- Implementation and final evidence will replace the pending phase states only
  after their acceptance criteria pass.
- Checker engine and complete paired fixtures now vendor edition 1.5.0 from
  Direct commit `01554f92f4cdaab633bd649e45188421b8c1ebaf`, with byte digests in
  `scripts/effect-architecture-source.json`. The complete paired fixture passes
  13 tests and 146 assertions on the pinned repository toolchain. Product-role
  validation was pending at that checkpoint. This copies development source
  without a runtime package.
- Initialization keeps one native completion observation alongside its typed
  Effect Deferred so the original native `Promise.all` arbitration can remain
  explicit. Manager programs establish that bounded observation and compose it
  with native process identity without invoking the public client facade or a
  nested runtime. Causal tie and abort checks remain required; construction
  alone does not establish ordering equivalence.
- The two existing client files pass 39 tests and 253 assertions after repairing
  two observed synchronous TERM regressions. Independent actual-facade tests
  pass eight cases and 114 assertions for turn admission, deferred FIFO writes
  and falsey diagnostic failure precedence. These focused receipts precede the
  additive manager platform helpers and do not replace current-source review,
  manager/service checks or final CI.
- The original implementation passes all five native arbitration schedules
  (45 assertions). Already-rejected initialization wins its tie; identity wins
  both same-batch queued orders. When the second failure is scheduled six native
  microtasks later, the first failure wins. Every original handle and queued
  operation is joined. The migration retains this measured oracle.
- The joined provider-usage checkpoint passes strict TypeScript. Scoped lint
  and architecture diagnostics identified narrow source-policy issues, which
  remained unresolved at that checkpoint. The canonical checker bytes stay
  unchanged; its AST-root parent guards have a documented file-specific lint
  exception. The Claude runtime module has both runtime-owner and adapter roles
  for its native public Promise projection, matching the existing Codex owner.
- The first two daemon-service cases stopped before response admission: awaiting
  the fact observer alone did not join deferred durable interaction admission.
  The corrected fixture waits for the existing public service settlement API
  before requiring the pending row. It keeps the failed run and the original
  deadline and uses no sleep to infer durable completion.
- The corrected callback schedule proves that callback-local close refuses
  without mutating live state, session end releases while a deferred notice is
  held, and whole-manager close waits for that notice. The write-held schedule
  exposed an invalid service-success assertion: after the admitted native write
  succeeds, concurrent manager close prevents the service's unchanged account
  reattestation. The correct service result is `RECOVERY_REQUIRED` with a durable
  `resolution_unknown` interaction, not a claim that shutdown preserved account
  authority. Its regression must check both the actual manager write result and
  that service recovery state.
- Current production source passes the canonical module-role check. Strict
  TypeScript and scoped lint pass after correcting new fixture configuration and
  method-binding mistakes. The unchanged local CI coverage and real pinned
  source-shard equivalence selection passes seven tests and 130 assertions.
- Both corrected daemon-service schedules pass, with 33 assertions. The
  write-held case proves the actual manager returns `responseWritten: true`
  while the service records its required uncertain recovery state. The
  callback-held case proves mutation-free self-close refusal and delayed owner
  retirement. These are controlled native-port schedules through the real
  service and store, not live-provider qualification.
- The first full migrated adapter run passes 78 cases and fails five existing
  controls. All added R1, initialization arbitration, raw constructor custody,
  late binding, activation acknowledgment, held identity, runtime retirement,
  reservation reuse and identity-getter cases pass. The accounting clock and
  immediate cleanup-retry differences remain under repair. Two older assertions
  conflict with the explicitly adopted barriers: successful close before a held
  configuration lookup settles, and mutation of session state before refusing
  callback-local close. Their replacements preserve original no-launch and
  exact-child controls while requiring joined acquisition and mutation-free
  refusal. The historical full-prefix digest above applies to the retained
  baseline; the new R1 causal oracle itself remains unchanged.
- The repaired complete adapter file passes 83 tests and 587 assertions. The
  three current client files pass 47 tests and 367 assertions. The original
  injected clock, retry TERM and retry revoke assertions remain unchanged and
  pass. Cleanup now reserves shared custody before entering native revoke and
  TERM on the immediate caller's fiber; their settlement runs as owned work.
  Each admission failure remains independent, so one resource failure cannot
  skip the other cleanup or change ordered failure collection.
- Current strict TypeScript, scoped lint and module roles pass on the cleanup
  admission repair. Security-count review traced two direct authority checks
  into the unchanged launch-authority helper, at the same boundaries before and
  after durable identity admission. Only that file's literal count changes from
  11 to 9; both runtime guards and their ordering are preserved.
