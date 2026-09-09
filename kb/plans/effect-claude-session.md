---
title: Claude connection ownership with Effect
type: plan
status: in-progress
---

# Claude connection ownership with Effect

Design: [issue 166](https://github.com/hraness/hra/issues/166).

Status: source implementation in progress. The current isolated baseline is
`82637bb9a5423adffb5185dc175fd74eb5dd2c89`, an ancestor of
[the provider-usage candidate](https://github.com/hraness/hra/pull/140).
This work depends on that integration and retains its release ownership. The completed
[Codex migration](effect-provider-session.md) remains a separate provider contract.

## Problem and boundary

Manager close currently completes while an already-admitted start-time
configuration lookup remains pending. The controlled baseline holds that exact
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
- Bound observation of manager-owned acquisition, capabilities and deferred
  continuations with a separately named `connectionShutdownSettlementMs`,
  default 1,000 ms and valid from 1 to 30,000 ms. Expiry reports incomplete
  cleanup and retains the original owner. It does not cancel configuration
  lookup or replace the child's existing TERM and settlement bounds.
- Preserve the existing client diagnostic callback's throw precedence and
  manager disconnect sanitization. Do not turn all diagnostics into a new
  best-effort policy.

Acquisition registration, raw-process constructor-failure retention, the
write/notice shutdown barrier and synthetic callback self-close refusal are
explicit cleanup strengthenings. Other public behavior remains compatible.

## Phases

| Phase | Owner | Acceptance | Status |
| --- | --- | --- | --- |
| Contract and R1 baseline | Independent source and test reviewers | Exact caller/port map, retained red trace, unchanged controls and joined fixture cleanup | Complete on the isolated baseline |
| Connection programs and client | Client implementer | Shared internal owner API, native initialization/writer/reader/close programs, deleted replaced scheduling, focused client preservation | In progress |
| Acquisition and manager | Manager implementer | Same interpreter from pre-acquisition through close, unchanged R1 oracle green, exact authority and all-child cleanup | In progress |
| Causal and architecture review | Independent reviewer and integrator | Actual-facade timing, raw failures, held native operations, callback ordering, module roles and deletion review | Pending |
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
  validation remains pending. This copies development source without a runtime
  package.
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
