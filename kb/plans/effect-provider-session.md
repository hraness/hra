# Codex provider-session Effect runtime

Design: [issue 118](https://github.com/hraness/hra/issues/118).

Status: implemented; focused validation passed. Aggregate validation and independent review are pending.

The Codex connection uses Effect 3.22.1 for request deadlines and cancellation,
ordered fact delivery, background task ownership, and stdout consumption. The
public Promise API, parser contracts, operation descriptors and exception classes
remain stable. Claude Code and other provider runtimes are outside this phase.

The connection runtime is created once and disposed only after exact process exit
is proven. A failed close remains retryable. Interrupting an Effect stops its
consumer; it does not prove that a foreign Promise, pipe or provider process has
terminated. The process adapter remains the resource owner.

The domain request table still binds response ids and dispatch status to the
current generation. Account-change notification revokes admission synchronously.
The priority write dispatcher permits the authoritative account refresh to pass
barred normal writes. A mutation whose dispatched result is uncertain remains
indeterminate and is reconciled without replay. No generic retry policy is added.

## Acceptance

- Existing Codex client tests pass, including authority refresh ordering, queued
  expiration, read cancellation, uncertain mutation outcomes, bounded stream
  settlement and retryable process close.
- New session-runtime tests prove synchronous completion reservation, exact
  exception projection, ordered facts after failure, background admission counts,
  and interruption of consumption without a false claim of native cancellation.
- The repository TypeScript compiler and ESLint accept the implementation.
- `check:effect-architecture` classifies every production Effect module and
  enforces the reviewed program, adapter and runtime-root roles. Its paired
  negative/positive tests run in the ordinary scripts test suite.
- The complete `bun run check` passes in the documented host scheduling lane.
  Required native process-custody suites retain their supported host/CI proofs.
- Integration review confirms the removed timer/listener, task-set and tail
  machinery is replaced by active Effect programs and no second path remains.

## Validation and delivery record

Focused evidence: `bun test ./src/codex/session-effects.test.ts ./src/codex/client.test.ts --isolate --max-concurrency=1` passed 88 tests and 433 assertions, including 50 generated fact-order sequences. Focused ESLint passed. The architecture checker fixtures passed 7 tests and 30 assertions. The repository TypeScript check passed before the final reservation-activation and named shutdown-report refinements; the aggregate gate must validate those changes again.

The first aggregate attempt passed installer pins, the architecture policy and security-primitive counts, then stopped on two strict lint incompatibilities in the checker. The shared checker was corrected without relaxing policy and its focused lint and fixture tests passed. A fresh aggregate gate and independent review remain pending.

This phase does not authorize substituting fake process tests for native custody proofs, or treating compiler checks as proof of durable authority correctness.
