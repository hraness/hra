# Codex provider-session Effect runtime

Design: [issue 118](https://github.com/hraness/oompa/issues/118).

Status: done. Implemented, independently reviewed, and merged through pull request 120.

The Codex connection uses Effect 3.22.1 for request deadlines and cancellation,
ordered fact delivery, background task ownership, and stdout/stderr consumption. The
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
  response/abort arbitration, and interruption of consumption without a false claim of native cancellation.
- The repository TypeScript compiler and ESLint accept the implementation.
- `check:effect-architecture` classifies every production Effect module and
  enforces the reviewed program, adapter and runtime-root roles. Its paired
  negative/positive tests run in the ordinary scripts test suite.
- The complete `bun run check` passes in the documented host scheduling lane.
  Required native process-custody suites retain their supported host/CI proofs.
- Integration review confirms the removed timer/listener, task-set and tail
  machinery is replaced by active Effect programs and no second path remains.

## Validation and delivery record

Focused evidence: `bun test ./src/codex/session-effects.test.ts ./src/codex/client.test.ts --isolate --max-concurrency=1` passed 93 tests and 443 assertions, including 50 generated fact-order sequences, both response/abort orderings, reservation removal before response projection, and late stderr after scoped close. Focused ESLint passed. The architecture checker fixtures passed 7 tests and 30 assertions. The session modules passed a focused strict check with the repository's TypeScript 5.9.2.

The first aggregate attempt stopped on two strict checker lint incompatibilities; the shared checker was corrected without relaxing policy. The next attempt passed installer pins, the architecture policy, security-primitive counts, full lint/typecheck and script/plugin tests. Its source suite passed 2,780 tests and failed only the exact installer dependency inventory, which now includes Effect 3.22.1 and passes its focused test. The remaining aggregate steps did not run.

Review hardened reservation-before-deadline activation and found a reproduced response/abort tie regression in the initial nested races. The repaired native listener now synchronously claims the exact pending reservation and settles the same Deferred as responses and timeouts. The callback's scoped finalizer removes the listener. A separate stderr scope stops diagnostic consumption after close without turning normal interruption into a failure diagnostic.

Independent review of the runtime and subsequent reservation, abort, stderr and inventory repairs found no remaining concrete defect. This phase does not authorize substituting fake process tests for native custody proofs, or treating compiler checks as proof of durable authority correctness.

The converged aggregate on the provider-retirement base passed 659 script, 108
local-efficiency, 29 cloud-efficiency, 2,764 source, 285 Convex/site, 447 app and
10 package-policy tests, plus lint, types and builds. It stopped at the exact
archive inventory, which still described the pre-Effect source. The reviewed
archive adds only the two Codex session modules; changed existing payloads are
the client, package manifest and third-party notice. Its 159 path/type/mode/size
entries occupy 7,376 canonical JSON bytes, with SHA-256
`80ed18a28c652e17eba75f9d8beeb090531b0756c16a98acfd5df1da611aeee8`.
The strict comparison remains mandatory. The final complete gate passed on
source commit `a86121b515fbeef9768ca2acdbd8c2afb1e97497`, tree
`66634990b2b6b8be3309a6cbc214bcb9008834a4`. No package release or native
activation is claimed here.
