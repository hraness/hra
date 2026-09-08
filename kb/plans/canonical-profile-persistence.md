---
title: Persist exact historical profile identity
type: plan
area: model-routing
status: in-progress
---

# Persist exact historical profile identity

## Outcome and current boundary

Persist the seven already represented provider/model/effort identities across
sessions and Work without changing public selectors, runtime evidence or model
admission. This is the next bounded source increment in
[`model-routing-autonomy.md`](./model-routing-autonomy.md), not a new routing
policy. Sol Ultra remains the implicit Codex default. Historical Astra and
retired Devin decoding grant no fresh execution authority.

The current parent join incorporates PR147's pushed `976bbb9`, including
protected main `2c8fe078`, the schema49 project companion and the reviewed
physical-scrub fixture repair. The original foundation began at `380ced9`;
that older checkpoint is not the current integration base. PR147 still owns
schema49 and its final gates. This follow-on has no allocated schema number.
Recheck protected main and competing local-storage ownership after PR147
converges before installing a migration. Keep the independently owned
peer-memory changes in PR148 intact at integration.

## Storage decision

The existing `canonical-profile.ts` catalog separates recognition from
execution. State currently stores provider, tier and contract; Work stores
per-row presets under its parent's frozen contract. A session-only mirror
would leave Work authority on a separate identity path, so the increment
includes both owners.

| Approach | Migration and authority tradeoff |
| --- | --- |
| Four additive columns and exact companion guards | Recommended. Keeps parent identities, existing foreign keys and released SQL intact. Requires explicit presence/coherence proofs. |
| Rebuild sessions and Work parent tables | Can express table-level requiredness, but expands the migration across cascading, self-referential and deferred relationships without a necessary behavior change. |
| Separate identity tables | Keeps existing columns unchanged, but adds row-presence and synchronization authority for every reader and writer. |

Add `canonical_profile_key` to `sessions`, `work_routes`, `work_tasks` and
`work_attempts`. The additive declaration is nullable during transactional
backfill and has no invented default. Exact final insert/update guards require
valid coherent values. Describe this as trigger-enforced requiredness, not a
SQL `NOT NULL` column. Freeze the column and companion definitions separately
from future catalog expansion. Reconsider the design if a demonstrated
consumer requires a parent-table rebuild; do not retain both representations
as competing current authorities.

## Derivation and authority

- Derive a session key from its own authoritative `provider_v39`, reconstructed
  preset and stored contract.
- Derive every Work key from Codex, the row's own preset and its owning Work's
  stored contract. A Claude coordinator never turns a Work worker into Claude.
- Preserve the legacy fields as frozen provenance. Luna can have one key
  across contracts because its exact tuple is equal; Sol and Astra must not.
- Require route/task/attempt key agreement and live worker-session agreement.
  Preserve account, nullable project, Fast, membership, process generation,
  lease, fence and ownership checks independently.
- Keep attempt keys immutable. Fence session-key changes while claimed,
  dispatching, running or recovery-required attempts retain authority.
  Submitted and terminal history must not be compared to today's session key.
- Never compare historical turn evidence to a session's current key after a
  legitimate reselection or provider switch. Preserve the historical decoder
  and settled replay before fresh-selection admission.

## Migration integration

1. Freeze schema49 as the exact predecessor. Inside the existing immediate
   transaction, reject pre-existing canonical columns, including hidden or
   generated variants, and all same-name SQLite objects, including case
   variants and non-trigger collisions.
2. For older supported roots, establish the frozen contract/provider and Work
   waypoints before deriving any key. Strictly classify contradictory legacy
   identity; do not infer defaults or silently rewrite evidence.
3. Backfill before migration-only adoption quarantine constructs current
   WorkStore. The concrete seam is after `database.exec(WORK_SCHEMA_SQL)` in
   `applySchemaVersion40SessionAdoption`, not a bypass flag on public readers.
4. After proving their exact bodies, temporarily remove only
   `work_routes_no_update`, `work_tasks_no_update` and
   `work_attempt_revision_guard` for key-only backfill. Restore the exact
   bodies within the same transaction. Never bump timestamps/revisions or
   rewrite JSON to satisfy a migration guard.
5. Install exact companions and prove coherent rows/parents before quarantine.
   Preserve the schema49 project companion and released Work SQL/digest
   preimages through all later historical replay.
6. Keep canonical guard SQL separate from the frozen adoption footprint.
   Reusing helpers that mention account/adoption authority tables would make
   `adoptionFootprintObjects` classify these new objects as old authority.
   Existing guards retain that authority instead.
7. Compose new current assertions around the frozen predecessor. Advance the
   ledger only after complete proof. Current-version reopen asserts, never
   reconstructs, missing keys or guards. Readonly metadata validation remains
   metadata-only; authoritative row reads reject contradictory identities.

## Callers and ownership

The implementation owner must cover session creation, import, adoption and
reselection, metadata selection, prepared session-start insertion, provider
switch completion and provider-switch recovery in their existing atomic
boundaries. Internal row parsing includes the key; public `SessionRecord`
does not gain a field. `requireSessionPresetBinding` validates canonical and
legacy agreement before producing the exact existing runtime requirement.

Work create, task insertion and attempt claim populate their keys. Every
history read preserves durable route-to-task-to-attempt key coherence.
Attempt-to-current-session comparison applies only while claimed,
dispatching, running or recovery-required authority is live, including late
reauthorization and sweep. Submitted or terminal settlement cannot compare
against a session that may have legitimately switched. Preserve the existing
legacy predicates. Public projections, Work v1/v2 request shapes,
request/result/event digests, runtime-profile JSON and replay bytes remain
unchanged. Do not add a mutable capability registry or generalized selectors
as part of this increment.

One bounded worker owns the new frozen companion module and unit tests.
The integration owner owns migration numbering, all writer/reader joins,
authentic StateStore/WorkStore integration tests, documentation, package and
security inventories, exact-tree final gates and protected delivery. Unit
fixtures prove only the new SQL rules; they do not prove real predecessor
migration, process custody or live provider support.

### Reader integration checkpoints

Validation in `requireSessionPresetBinding`, `#requireTask` and
`#requireAttempt` alone is insufficient. Source review found direct typed
queries in history, public projections, late dispatch and retirement paths.
Treat this as an integration requirement, not an existing product defect:
canonical persistence is not installed yet.

| Boundary | Required canonical coverage |
| --- | --- |
| Session row parsing and `mapSession` | Validate the exact stored key against the row's own provider, tier and contract before every projection, including cloud pages and recovery reads. Keep public records unchanged. |
| Work `#routes`, task summaries/statuses and `#workRecord` | Validate own Work provenance and route/task coherence even when a query bypasses `#requireTask`. Snapshots and poll-ready filtering are included. |
| `#attemptRecord`, `#taskHistoryVersionCandidate` and cached `#taskHistoryItem`/`taskHistory` continuations | Validate selected items' immutable source-row canonical provenance even when cached history bypasses the record builders. Preserve stored JSON, digests and sequence-cut semantics. Never compare submitted or terminal history to today's session key. |
| `#dispatchAuthorityValid`, `#assertSessionRoute` and `#attemptAuthorityCurrent` | Require live canonical agreement in addition to every existing account, project, Fast, generation, lease and fence check. Contradictory stored identity must not become an ordinary stale-authority result that is then silently retired. |
| Direct attempt batches in retirement, sweep, reconciliation and polling | Cover the same row invariant before mutation or projection, including rows obtained without `#requireAttempt`. Preserve legitimate stale-authority recovery. |

Keep the migration-wide populated-row scan separate from bounded runtime row
validation. Do not turn metadata-only readonly open into a whole-database
scan or broaden public wire shapes to avoid validating internal rows. Add
corruption/refusal controls at the direct-query boundaries, and retain the
real settled-history reselection cases as positive compatibility controls.
An earlier cached history cut can still say claimed or dispatching after the
authoritative attempt has settled and its worker has reselected. Derive live
authority from the current attempt row, never that cached historical state;
otherwise an unchanged historical continuation would become unreadable.

## Required evidence before completion

- Authentic populated supported predecessors, especially pre-v38 contracts,
  pre-v40 quarantine with a real claim, v40/v41 and v49; fresh and repeated
  readonly/writable opens.
- Full rollback of rows, schema, ledger, frozen triggers and evidence after
  failed backfill, guard installation or stamping; collision refusal before
  maintenance can obscure debt.
- Raw-SQL missing, NULL, foreign and contradictory keys; case-sensitive/BINARY
  identity equality; route/task parent mismatch; immutable attempt keys; all
  four live states and terminal controls.
- Equal Luna tuples across contracts, distinct Sol/Astra tuples, a Claude
  coordinator with Codex workers, and recognition-only retired Devin state.
- Atomic writers and stale-CAS refusal, unchanged unrelated metadata, exact
  historical replay and byte-identical retained evidence/digest preimages.
- An unchanged older reader/writer refuses a synthetic new root without
  modifying its material file tree, followed by successful new readonly open.
- Focused storage, Work, runtime and wire compatibility tests; independent
  review; package/security inventory proof; exclusive exact-tree aggregate;
  exact-head protected CI; normal merge and exact-main verification.

Candidate admission, provider provisioning, automatic routing/Fast, hosted
capacity changes, package publication and daemon activation remain separate
gates. No mock, source merge or schema number supplies their missing proof.

### Upgrade fixture provenance

Reuse the existing exact-version shapers only for the authority surface they
actually prove. A current fixture stamped with an older version is not by
itself an untouched root written by that historical release.

- The pre-v38 ordering regression establishes a real session and the v25
  replay seam, but has no populated Work. It cannot close historical Work
  derivation by itself.
- The v36 adoption regression has the strongest populated pre-v40 chain:
  real Work creation and claim plus queue, mutation, task and interaction
  evidence. Its valid quarantine intentionally releases authority and changes
  state, revisions and events. Preserve immutable profile provenance while
  separately asserting those exact allowed effects, not all-row identity.
- The v40 retained-byte/digest and v41 retired-Devin regressions have real
  session evidence but no populated Work. Add the missing historical Work
  chain before claiming complete upgrade coverage.
- Current v49 released/submitted controls create and settle real Work under
  contract 1. Existing contract 2 WorkStore controls use a reduced parent
  schema and rewritten contract/intent setup; they are not untouched
  historical StateStore migration evidence. Authentic populated contract 2
  Work remains a required new positive control.

## Companion-module checkpoint

The first source building block adds two historical scalar derivation helpers,
four frozen additive column statements, seven exact companion triggers and a
metadata-only assertion in `src/storage/canonical-profile-storage.ts`. It has
no installer, migration number, backfill, current reader/writer consumer or
selection authority. SQL identity mapping is frozen independently of future
catalog changes; every key comparison is explicitly BINARY. Column metadata
uses `table_xinfo` to reject hidden/generated, defaulted, wrong-type and
case-variant declarations. Exact companion checks include all SQLite object
types and case-insensitive name collisions.

The deliberately reduced STRICT unit fixture documents its dependence on
unchanged legacy blanket guards. It proves only new SQL behavior, not a real
StateStore upgrade. A raw-SQL forged-key baseline genuinely succeeded before
the guards; the corrected suite passed105 tests and385 assertions. Scoped
ESLint, strict targeted TypeScript, explicit whitespace checks for both new
files and independent frozen-file review passed. Root source/test review
found no further issue. Security primitive counts remain unchanged across45
reviewed files.

Frozen SHA-256: source
`4d731c8e4c199c1f4114cadc4cb8df431b2e06d866a652ad73cc244d03794cc1`;
tests `c238c4ae759b49447914584769a8c820896bb6ce98676d2775c80feef48db1c4`.
Independent local package inspection passed:176 canonical entries,167
single-link source-identical regular files and an8,317-byte inventory with
SHA-256 `65cc9b5ad9e5d5a4fe1bddd5147dce67b1b34b56a15eb1818c9a6883b50652f6`.
The sole addition is this9,636-byte module; all166 predecessor files remain
byte-identical. The archive is1,346,393 bytes and remains local-only. Only the
three reviewed inventory constants changed; no enforcement rule changed.
The required exact-tree final gate is separate evidence. None of the real
migration, old-reader or runtime integration acceptance cases above is
complete from unit tests or package inspection.

## Settled-history compatibility checkpoint

Two real-StateStore regressions cover released and submitted Work after a
legitimate session reselection from Sol Ultra to Luna Low. They create,
claim and settle Work through current semantic writers, then prove that
route, task and attempt identity still derives from each historical row and
its owning Work contract. The session's current identity changes separately.
Ordered persisted rows preserve intent, effect, report, submission, event,
history-version and clock evidence byte-for-byte, including their existing
JSON and digest fields. Public task/history/event/snapshot projections and
settled replay remain identical across reselection and readonly/writable
reopen. A changed claim intent still refuses without changing evidence.

The test uses fixed time and the same daemon generation. It compares settled
replay immediately before and after reselection, not the original claim
response, because replay reprojects the settled state. The injected cursor
encoder supplies a valid bounded wire envelope. No schema overlay, migration
number, provider call, runtime admission or production writer change is part
of this proof.

The affected Work project-authority group passed 44 tests and 343 assertions
on Bun 1.3.14. Scoped ESLint, strict targeted TypeScript, whitespace and
independent frozen-file review passed. Test SHA-256:
`c699d184819944d390944db71771d9f9c2bf373ac147e6cfb4daff32b527c5fb`.
The preceding companion-only source checkpoint passed its exclusive local
aggregate and macOS CI. Ubuntu exceeded existing individual test and job
deadlines; timing diagnosis is separate from this compatibility proof. No
failed gate is waived and no real canonical migration is complete.

## Integration and takeover checkpoint

Exact `2c3c074`, tree `956cd29db6c24766366a1285069eeb2fa4ab5460`,
passed its exclusive local aggregate and both platforms plus Required in
[CI 34182907000](https://github.com/hraness/hra/actions/runs/34182907000).
The local source suite passed 3,656 tests in 343.31 seconds; scripts, both
plugins, hosted and app tests, builds, complete-history and package policy,
and isolated local/global consumers including PTY and daemon lifecycle also
passed. These are foundation and compatibility receipts, not migration proof.

The subsequent normal parent join preserves both genuine settled-history
regressions, the frozen companion and its 105 tests, package inventory and
lockfile. It brings in the v20 fixture's checked pre-migration plaintext
barrier and PR150's guidance-fixture lifecycle ownership. The parent failure
was not waived: its original local gate missed a retained sentinel before
migration, and a controlled SQLite proof demonstrated the non-atomic
main/WAL scan race. All post-scrub erasure assertions remain unchanged.

No new aggregate success is claimed for the joined tree. After the schema49
parent converges, the next owner must recheck migration ownership, install
the complete reader/writer and migration slice described above, prove its
authentic upgrade and rollback cases, and run its exact-tree final gates.
Do not interpret these passing foundation checks as canonical persistence,
new profile admission, a release or permission to activate a daemon.

## Populated-row proof checkpoint

The next building block adds `assertLegacyCanonicalProfileRows` without an
installer, backfill, migration number or runtime consumer. Four main-qualified
scalar existence checks reject missing or contradictory session keys, derive
routes from their own Work contract, and require task/attempt agreement with
their immutable parents. Every textual identity comparison is BINARY. Workers must
exist for settled attempts, but only the four live states require agreement
with the worker's current key. Unknown or case-variant states refuse.

The caller must keep the existing coherent migration transaction across
predecessor, legacy authority, backfill, row and companion proofs. This helper
neither owns that transaction nor replaces legacy authority checks. It reads
only one scalar per table into JavaScript and returns fixed boundary errors
for malformed results or SQL failures, without retaining row or error text.
The original frozen 225-line module prefix and all guard definitions remain
byte-identical; the new proof does not enter the account-adoption footprint.

A genuine red control showed that exact metadata alone accepts an existing
NULL key. The completed suite passed 232 tests and 1,362 assertions, including
127 new cases and 977 assertions. Controls cover all seven historical keys,
own-Work contracts, all live/settled states, NULL/case/collation damage,
orphaned parents, TEMP shadowing, later invalid rows, malformed scalar results
and sanitized SQL failures. Read-only transaction controls preserve serialized
database bytes, total changes, schema version and query-only state on both
success and refusal. Scoped lint, strict TypeScript, whitespace, independent
frozen-file review and root review passed. These remain reduced SQL unit
fixtures, not authentic StateStore migration or runtime integration proof.

Frozen SHA-256: source
`8b6be43b73dcc60e91c35ee34e50feaa85e9891d72b27d7839c878f02dde3bc1`;
tests `adb9d98336d114f3b2f455d87f435cf1766f2bda0d6b820523d8b9c2e2e82c3b`.
Independent inspection of the exact locally packed archive passed: 176
canonical entries and 167 regular files contain 7,086,046 source-identical
bytes. Only the canonical module grew, from 9,636 to 13,542 bytes; all 166
other predecessor files and the original module prefix remain byte-identical.
The inventory is 8,318 bytes with SHA-256
`e3e95d13e75e73651b1915c05ba51b7b53b6f57dcf5342bb117a10272c5a252d`.
Only the expected inventory size and digest constants changed. The archive
is 1,342,882 bytes, SHA-256
`b9ec8f8fa83324dc5dd73798f0fc7d58306f567ab1af445c5f9af8c048554c97`,
and remains unpublished. Package policy passed 11 tests and 42 assertions;
the refreshed exact archive assertion, unchanged security primitive counts,
scoped policy lint and whitespace checks passed. The new exact-tree
aggregate is a separate gate.
The preceding `35dce12` CI run 34185898009 passed macOS in 15m47s, but
Ubuntu exceeded the unchanged 20-minute job limit and Required failed.
That failure is under independent log review; it is not waived by focused
row-proof checks or earlier aggregate successes.
