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

The dormant foundation was delivered through PR149 at protected main
`7ab347813f8d7e4f31e9584752c801dd1ca0cda0`. Its exact-head local aggregate,
both CI platforms and CodeQL passed; exact-main CI34242469558 and CodeQL
34242468686 passed. It includes PR147's schema49 project companion and
retains all earlier authority and fixture repairs. Those receipts prove the
dormant foundation, not the migration now being implemented.

The local follow-on reserves physical schema50 after a fresh competing-owner
check. PR140's usage owner acknowledged that reservation; its later migration
tail remains unallocated until this exact source is reviewed and integrated.
The StyleX branch still uses schema49. No number alone admits a predecessor.
The complete session/Work migration slice is being validated separately on
`codex/canonical-profile-migration-20260908`; it is not released or activated.
PR139 merged at `109655a8f7d6edd8916f6d7df277e3402b70a44f`, and PR148 retains
the next integration and candidate-release window. Preserve its peer-memory
changes and join actual protected main before final schema50 validation.

The delivered foundation's reviewed tree is
`978bdc30b6fb9d259c92d0ca91335a854227d6f4`. Its companion module,
populated-row proof, settled-history controls and measured service fixture
wait reduction are preserved in this increment.

PR147's schema49 project companion merged as `c639ad78`; its local and
protected gates and exact-main
[CI34188257597](https://github.com/hraness/hra/actions/runs/34188257597)
passed. The foundation's separate exact-main
[CI34242469558](https://github.com/hraness/hra/actions/runs/34242469558)
also passed. The original foundation began at `380ced9`; that older checkpoint
is not the current integration base. The mobile runbook source is now joined
from protected main109655a. Its source and deployment evidence remain in the
[model-routing implementation log](./model-routing-autonomy.md#implementation-log).

The reviewed PR149 head `0787b6d9e503b831d657c495e923fae734ec998f`
passed its exclusive exact-tree aggregate with exit zero, including final
package cleanup: 3,790 source tests in 315.26 seconds, 1,102 scripts tests
with one existing skip, 108 local-plugin, 29 cloud-plugin, 393 hosted/site,
500 app and 11 package-policy tests with 42 assertions. Both platforms and
Required passed in [CI34188700143](https://github.com/hraness/hra/actions/runs/34188700143)
(macOS 12m16s, Ubuntu 18m07s, Required 3s), and
[CodeQL34188697946](https://github.com/hraness/hra/actions/runs/34188697946)
passed. These are delivered source-foundation receipts, not canonical
migration, public artifact or activation evidence.

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
canonical persistence was not installed at that review checkpoint. The draft
implementation and its focused validation are recorded below.

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

That parent-join checkpoint did not yet have its own aggregate success; the
current source-delivery boundary is recorded above. The next migration owner
must recheck protected main and migration ownership, install the complete
reader/writer and migration slice described above, prove its authentic
upgrade and rollback cases, and run its exact-tree final gates. Do not
interpret passing foundation checks or its protected source merge as
canonical persistence, new profile admission, a release or permission to
activate a daemon.

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
The completed diagnosis follows; that failed gate is not waived by focused
row-proof checks or earlier aggregate successes.

## Measured scrub-fixture wait reduction

Completed log review of CI 34185898009 found 5,751 passing tests and no
failing test. The package success line preceded awaited temporary-root
cleanup, and the job deadline cancelled the gate before a clean exit.
Compared with the passing parent CI on the same Ubuntu image and Bun pin,
source tests grew from 647.22 to 814.44 seconds. The 107 added tests took
1.535 seconds combined. Existing storage, service and adapter tests and lint
all slowed; separate runners do not identify CPU, I/O or contention as the
cause. No canonical workload-specific regression was established.

Three service tests deliberately retain a real reader throughout scrub
refusal but previously spent the production 5,000ms wait on each of three
attempts, plus 100/200ms backoff. Their claim is committed-result quarantine,
the response/stop boundary and recovery after unpinning, not production wall
time. The existing fixture now optionally forwards the already-supported
test-only policy. Only those three tests use 50ms waits, three attempts and
10/20ms backoff. Every other fixture retains the production default.

One paired local Bun 1.3.14 measurement of the exact same three tests passed
20 assertions before and after: 48.30 seconds became 1.54 seconds. Individual
durations changed from 15,954.85/15,857.84/16,119.78ms to
470.83/435.22/430.68ms. Every reader transaction, provider gate, committed
result, stop callback, post-unpin transition and assertion remains unchanged.
Scoped lint, strict TypeScript, whitespace, independent frozen review and
root review passed. Service test SHA-256:
`3bdf2a8d48fa933f5276c0fd76186726a6f665e7795fd7698ea81cdd74b7ee50`.
Production source, package bytes, retry counts and all test/job deadlines
remain unchanged. This is a measured fixture wait reduction, not Linux
after-measurement or a replacement for the new exact-tree aggregate and CI.

## Schema50 implementation checkpoint

The working vertical slice now installs the four key-only columns and seven
frozen guards under StateStore's existing immediate migration transaction.
It rejects predecessor collisions before maintenance, proves and temporarily
removes only the three blocking legacy guards, restores their exact observed
bodies, and composes a new current ledger assertion around unchanged schema49.
Current50 writable opens prove rows before maintenance; readonly opens retain
metadata-only admission and reject corrupt identity at authoritative reads.
Every session identity writer and Work route/task/attempt writer carries its
derived key inside the existing atomic boundary. Public records, request
versions, history JSON and digest preimages remain unchanged.

Independent source review covered old-waypoint ordering, all session writers,
direct Work projections, late authorization, signal sources, cached history
and retirement. Two genuine recovery-order regressions showed a corrupt task
could be detected only after separately committed recovery expired another
valid claim. Bounded operation-source checks now run before that recovery;
the regressions preserve the whole serialized database on canonical refusal,
while ordinary stale-authority recovery still commits as before. Separate
signal-effect controls caught direct reads that omitted the owning task's
canonical proof. Those reads now use the same bounded source validation.

The standalone Work suite passed98 tests and1,219 assertions, with scoped lint,
strict TypeScript and independent source/test review. The companion suite
passed259 tests and1,449 assertions, including27 new predecessor-absence and
key-only backfill cases. Its original frozen SQL remains unchanged; only the
stale foundation-only explanatory comment was updated in the old prefix.
These focused receipts do not replace the joined aggregate or CI.

The final reader audit found six session methods whose first canonical
projection could run after their mutation committed. Archive and both recovery
methods now return the checked record inside their existing transactions;
bind, turn-state and quarantine add three immediate transactions. Original
SQL, evidence checks, CAS precedence, clocks and successful behavior remain
unchanged. Four direct-writer regressions first failed because the complete
logical database changed despite refusal, then passed after repair. The two
recovery paths have six equivalent corruption controls plus exact evidence,
revision and healthy historical-profile-replay controls:11 tests and83
assertions passed. Independent review and strict TypeScript passed. The
reviewed security inventory changes only StateStore's immediate transaction
count from165 to168; all45 files pass the unchanged inventory check.

An offline generator captured a public-synthetic schema49 database using
unchanged source with tree `978bdc30b6fb9d259c92d0ca91335a854227d6f4`.
It verifies180 source files and the exact toolchain, lockfile and manifest,
then proves real semantic creation, claim, release, submission, reopen and
replay before serializing the logical schema and every row. Independent
review checked115 tables and139 rows, including nested JSON. The481,688-byte
fixture contains only explicitly synthetic public inputs; no private capture
was normalized or published. SHA-256:
`ac96da7af133d3980438991a36b6051de2dfcfd764d03343f47f5f75d7f0e887`.

The final43-case real-StateStore migration suite passed1,118 assertions.
It includes the reviewed positive49-to50 requirement for exact old table DDL
and `table_xinfo` after removing only each permitted added column. Current
writer, four-live-state,
settled-history, corrupt-row, collision and full-rollback controls are
included. All three authentic49 Work cases use contract1 Ultra; synthetic
dispatch receipts and cursors are storage fixtures, not provider acceptance.

An additional private copy-only proof upgraded an authentic populated schema41
database written by unchanged source `576ccd76a6742cd62759ab6176a6a41844846daa`.
It retained one released contract2 Work chain, produced historical Astra Max
keys on all four identity tables and preserved every original Work value,
projection and version1 release replay. A version2 replay correctly refused
without mutation; subsequent current readonly/writable opens were stable.
The original capture remained byte-identical and private. This is bounded
working-input migration evidence, not a historical release-artifact test.

Unchanged schema49 source also refused a fresh synthetic50 root in both
readonly and writable modes with `STATE_SCHEMA_NEWER:50:49`. Every material
file and sidecar retained its exact bytes and permissions, and the new
readonly reader returned the original session afterward. This is source-level
downgrade refusal, not execution of an admitted older CLI artifact.

Existing StateStore shapers now remove only the canonical overlay at explicit
predecessor boundaries and preserve exact original data and DDL plus the
permitted new fields. All original cases remain, including the13-case exact49
ledger matrix alongside14 current50 cases. The final ledger/metadata group
passed28 cases and411 assertions; four exact legacy-DDL preservation cases
passed2,184 assertions. Scoped lint and nine-file strict TypeScript passed.

The authentic pre-v40 control now also passes: unchanged schema39 source
`5f2735191640037c86d9949bc1d7f04b2ef09ffe` created and claimed a contract2
Ultra Work without immutable provider-session proof. A private copy upgraded
to50 with all four historical Astra Ultra keys, the exact expected released
attempt, pending task and recovery-required session, and one new event/history
version. Every old table's rows were compared against explicit source-derived
allowed changes; old intent/event/history bytes stayed exact. Current readonly,
writable and version1 replay stayed stable; version2 refused without mutation.
Independent review confirmed the original capture remained byte-identical.
This single-state source proof is separate from the pre-v38 boundary below.

A second authentic private proof uses unchanged schema35 source
`fdb01386277e99efd4b85eebc61e996a4c222813`, with all687 exported files and
modes verified before and after a fresh frozen dependency install. That source
genuinely lacks session/Work contracts and provider_v39; its Ultra selection
means Sol Ultra. Historical readonly/writable opens, projections and claim
replay preserve all77 tables before capture. A private copy reaches50 with
explicit v36/v37 notification defaults, v38 contract1 and v39 Codex provenance,
then the expected v40 claim quarantine. All four keys remain
`codex:gpt-5.6-sol:ultra`. The complete77-to115-table oracle accounts for every
row, preserves old evidence and proves version1 replay, version2 refusal and
current readonly/writable stability. Independent review passed. The original
mode0400 capture remains byte-identical and private. This closes one authentic
pre-contract claimed-Work path, not all lifecycle states, historical artifacts
or final integration acceptance. The private copy receipt SHA-256 is
`3daad90fcc2592a00f9eda17aea15c1c08cf563157fe46245c7d14cfd2aeac00`.

Independent review of the unpublished draft archive passed:167 source-identical
regular files, nine directories and176 inventory entries. Exactly the three
reviewed storage sources changed; the other164 production files remain exact.
All frozen Work/project49 SQL and canonical guards/mapping declarations match
the delivered foundation. The8,318-byte inventory SHA-256 is
`5ffa09d2f1432a089aadb69822524a3181b0b5de9b39e24abfcf17b46a0d8ce4`;
only that policy digest changed. Archive size is1,352,818 bytes, SHA-256
`5351a74d0c06d7d5d51cd075f038783aacb3a892a79b1e586f136b1514f67e71`.
This is not an installation, final joined archive or release receipt.

Remaining integration work includes the actual PR148 main join, refreshed
archive review and required exact-tree gates. Keep shaped fixtures distinct
from untouched historical captures and the bounded coverage of each proof.
Do not mark this migration, candidate admission or release complete from the
current working source or these focused receipts.
