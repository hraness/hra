---
title: Include memory tables in hosted bootstrap status
type: plan
area: hosted-bootstrap
status: in-progress
---

# Include memory tables in hosted bootstrap status

## Outcome and scope

The bounded `quota:hostedBootstrapStatus` projection must observe every hosted
table, including `memorySpaces` and `memoryOperations`. An otherwise empty
deployment with an orphan memory row must be inconsistent. A valid initial
bootstrap with an additional unaccounted memory row must not report ready.
Genuinely empty and exact clean-bootstrap states retain their existing results.

This independent repair changes only the query's table inventories and focused
regressions. Preserve its `take(2)` bounds, finite counts, return shape and all
invitation, control, quota and accepted-state validation. Schema, genesis,
authentication, quotas, attention delivery, release identity and hosted state
are outside scope. No production query, mutation or deployment is required to
prove this source defect.

## Evidence and ordering

The memory tables introduced by [PR #135](https://github.com/hraness/hra/pull/135)
are present in the schema and genesis inventory but missing from all three
bootstrap-status inventories. Independent static reviews found that imported
or inconsistent memory state can therefore appear uninitialized or ready.
Ordinary memory writes still require authority and quota accounting; this is
not evidence of an unauthenticated write path. The genesis mutation already
rejects occupied memory tables and remains unchanged.

The source base is `c9433d6cc42d757b194d1ef1db5f61b2c83f9ed6`. The separate
history-fixture repair is [PR #143](https://github.com/hraness/hra/pull/143),
initially observed at `b5740ef3296c267d5333b25c6e67b525c415a748`. It owns its
own validation and is an integration prerequisite, not part of this repair.
[PR #138](https://github.com/hraness/hra/pull/138) retains its independent
attention-key source checkpoint while both upstream defects are repaired.

## Implementation and verification

1. Add deterministic per-table memory-only and clean-bootstrap-plus-memory
   regressions, along with empty and exact ready controls. Demonstrate the
   defect against the unchanged query before applying the repair.
2. Add both tables consistently to the query, destructuring and occupied-table
   inventory. Add an exhaustive inventory regression against the existing
   canonical hosted table list if it can remain test-only and narrowly scoped.
3. Run the focused quota and bootstrap tests, relevant schema-inventory tests,
   TypeScript and scoped lint with Bun 1.3.14. Review the exact diff
   independently. Preserve any first failure and its diagnosis.
4. Push a draft PR with exact source and focused evidence. Do not claim the
   aggregate is green, merge-ready or deployed while the separate known
   history-fixture failure remains. Fresh current-main integration and its
   required final gates follow both reviewed repairs.

## Recovery and current evidence

This repair has no migration or durable-state effect. If review finds a
regression, correct the source forward and rerun its affected tests. Do not
change live data, weaken readiness checks or adjust history policy to make
validation pass. The source repair and focused regressions are implemented;
Focused validation is passing and draft delivery remains pending. This is not
a final aggregate or deployment claim.

The frozen, script-disabled dependency install completed with Bun 1.3.14 and
513 packages. Manifest and lockfile bytes are unchanged. Repository-context
and bounded percolation commands are blocked by main's existing invalid YAML
frontmatter in `plans/hra-web-v1.md`; that unrelated file is not modified here.
The applicable root, Convex and plan guides were read directly. No generated
catalog was rewritten or whole-vault validation claimed.

## Execution evidence

- The new `hosted bootstrap status table coverage` tests ran against the
  unchanged query first: 2 genuine controls passed and 9 regressions failed.
  The failures were the eight memory occupancy/classification cases and the
  exhaustive inventory missing exactly the two memory tables. There were no
  fixture or schema errors.
- The production repair adds exactly six lines: both tables in each of the
  destructuring, bounded query and occupied-table inventories. It expands
  coverage from 48 to 50 tables without changing predicates or return fields.
- `bun test ./convex/quota.test.ts ./convex/hostedBootstrap.test.ts
  ./convex/schema-invariants.test.ts --isolate --max-concurrency=1` passed
  51 tests and 1,147 assertions with Bun 1.3.14. All 11 new tests pass, along
  with the existing bootstrap, accepted-state, invitation and schema controls.
  Real schema-valid orphan fixtures remove their temporary parents. A typed
  actual-handler wrapper verifies every canonical lifecycle table is queried
  exactly once with `take(2)` and included in row-count observation, without a
  production API or type suppression.
- Independent exact-diff review passed the aligned six-line production
  change, test isolation and bounded inventory coverage. No schema, genesis,
  attention, history, manifest, lockfile or other source changes were included.
- The first scoped lint run rejected the test wrapper's direct `_handler`
  call because the registered query's public type does not expose that field.
  Both diagnostics were confined to the new test. The test-only repair reads
  the internal runtime value as `unknown`, checks that it is callable, and
  keeps the reflective call's result `unknown` through the existing assertions.
  No cast, suppression or production API was added. All 11 new tests then
  passed again with 24 assertions. Scoped lint and `bun run typecheck` passed;
  TypeScript ran after normal host-scheduler admission, without bypassing its
  queue. Final focused evidence and draft delivery do not close current-main
  integration, the separate history repair or the repository aggregate gate.
