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

Source work starts from PR147's pushed `380ced9`, including protected main
`632b351` and the schema49 project companion. PR147 still owns that migration
and its final gates. This follow-on has no allocated schema number. Recheck
protected main and competing local-storage ownership after PR147 converges
before installing a migration. Keep the independently owned peer-memory
changes in PR148 intact at integration.

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
