# Authentication review and hardening

Status: implementation and independent review complete; current-main integration
and release validation in progress.
Review starts from `main` commit `136ad40` and preserves the Codex Effect boundary
introduced by pull request 120. Integration includes the non-overlapping shared
footer update from `main` commit `c3874c7`, then the automatic-approval and
after-hours policy foundation through `4b50465`.

## Scope and invariants

Providers own credentials and the sign-in ceremony. HRA owns exact local
mutation authority, bounded process lifetime, and the protected handoff. Codex
web linking remains device-code-only, locally opted in, account-key encrypted,
and single-read. Claude login remains a foreground provider command on Linux;
the unproved managed macOS credential-isolation gate stays closed. HRA cloud
email authentication remains separate from provider authentication.

Effect owns Codex request deadlines, read cancellation, ordered facts, and
connection tasks. It does not prove native process termination or authorize
replaying a dispatched mutation. Keep the Promise port and typed failure
projection; do not introduce a second auth runtime or generic retry policy.

## Findings and implementation

- Codex account-status reads do not pass caller cancellation into the existing
  Effect request scope. Auth operations also miss cancellation during controller
  launch. Add pre-dispatch checks and cancellable reads; preserve settlement of
  already-dispatched mutations.
- A successful login cancellation followed by a failed account read is recorded
  as failed instead of indeterminate. Preserve the durable fence until an exact
  account read reconciles it. Commit the exact cancellation receipt and pending
  login settlement in one transaction; a receipt conflict must roll both back.
- Production daemon startup advances profile generations before mutation
  recovery. Auth crash tests must execute that order and prove that unresolved
  attempts remain attached to exact recovery authority across repeated restarts.
  Migration 45 adds a separate append-only auth successor chain bound to the
  original request and effect evidence. Never infer authority from a numerically
  greater generation alone. Legacy attempts lacking that chain remain fenced;
  a quarantine-only path may preserve unrelated local use but cannot read
  provider state, resolve the attempt, or grant another account mutation.
  Unsolicited provider facts and usage admission cannot clear or bypass this
  fence. Refuse a new Claude ceremony before its status probe or idle-session
  release when an unresolved Codex mutation already owns the shared profile.
- Claude's identity-status probe duplicates a weaker child lifecycle, rejects
  the provider's coherent signed-out exit, and can leave cleanup unjoined.
  Reuse the bounded status runner while preserving personal versus isolated
  configuration selection and identity checks. Attribute cached OAuth account
  metadata only when the current status proves Claude subscription authentication.
  After foreground interruption, bound the final exit wait and preserve the
  unresolved launch fence if native exit cannot be proved.
- A web status check clears the already-consumed login code. Preserve it while
  pending, erase it on completion or expiry, and give usable local cancellation
  guidance when the one-time handoff is unavailable.
- Email-code submission permits the displayed email to change while a request
  is pending. Bind the pending ceremony to its submitted identity and prevent
  duplicate submissions before React commits the disabled state.

## Acceptance and delivery

Each corrected failure needs a deterministic regression that fails before the
fix. Cover cancellation before dispatch and late read responses, post-effect
read and authority failures, actual boot-order recovery and repeated restarts,
Claude exit/status coherence and bounded cleanup, and mounted browser state
transitions. Preserve secret-output and encrypted-relay tests.

One integration owner reviews the converged diff, refreshes only reviewed
installer/security/package inventories, and runs the complete `bun run check`
on the exact delivery tree. Required PR and main CI and applicable production
readback remain mandatory. Provider-authenticated macOS acceptance is not
claimed by synthetic process or component tests.

## Evidence

- The new canceled Codex account-read test failed by remaining pending after
  caller abort, then passed with the optional signal routed to the existing
  request scope. The complete client and Effect suites pass: 94 tests.
- Four adapter regressions failed before the admission checks. The complete
  adapter suite passes 74 tests, including retained post-dispatch outcomes.
- Mounted web and email tests plus related view-model/component tests pass:
  32 tests and 129 assertions. They prove synthetic browser state transitions,
  not an authenticated provider sign-in.
- Claude status and foreground-process tests pass: 26 tests and 76 assertions.
  The original status regressions recorded 20 passes and four failures before
  the fix. A CLI regression separately proves that unjoined exit does not
  complete the grant: one test and 22 assertions. The changed Claude auth suite
  then passes 17 tests and 453 assertions, including 200 fixed-seed generated
  authentication-mode and cached-identity cases.
- The auth successor suite passes eight tests and 209 assertions, including a
  fixed-seed generated restart law. Original attempts and effect bytes survive
  repeated rollovers; a gap in the exact chain cannot confer current authority.
- Independent reviews approve the provider, web, migration, atomic-cancellation,
  and observation/admission changes. Installer pins and the Codex Effect
  architecture check pass. The reviewed security inventory adds exactly one
  immediate transaction for atomic cancellation settlement.
- The final focused service suite passes 39 tests and 291 assertions. Schema
  migration and version-alignment tests pass 51 cases; the three explicit auth44
  schema cases pass separately with 80 assertions after correcting a fixture's
  Claude preset. These cover current-schema drift, collision rollback, and exact
  predecessor evidence preservation.
- TypeScript passes on the integrated tree after exact optional-field and
  fixture-type corrections. Scoped ESLint and whitespace checks pass. The
  generated package contains the same 159 reviewed filesystem entries, with
  no source-byte drift; only their size-inventory digest changes.
- The complete exact-tree repository gate, required PR and main CI, and
  applicable production readback remain delivery requirements. Final receipts
  belong in the associated pull request and task closeout; a focused check is
  not substitute evidence for those gates.

## Current-main integration

The complete `bun run check` passed on auth checkpoint `a31e810` in an isolated
full-history checkout containing only its exact governed ref. That historical
checkpoint used the then-unshipped auth migration 44; it is not validation of
the current-main join. Main subsequently assigned migration 44 to the
after-hours budget foundation. The auth migration is therefore additive 45.
Shipped migration 44, its guards, and its evidence migration remain unchanged.
The auth SQL body also remains unchanged: 2130 bytes with SHA-256
`fb82005326ab870a694287cf81a73c679dde6fbd7cc712d43588a8f774aec163`.

The full joined storage suites pass 322 cases with 4392 assertions. They cover
exact-43 repair, exact-44 upgrade preserving auth origins and budget state,
current-45 drift refusal, successor-chain laws, and the shipped budget laws.
The joined CLI upgrade checks pass five cases with 26 assertions. The exact
legacy-43 service regression passes with 22 assertions, preserving unrelated
accounts while unresolved auth authority remains fenced. Independent source
review finds no auth conflict with main's approval-budget reservation or
Effect request-lifecycle boundaries.

Version 0.6.1 is already admitted and immutable. The 0.6.2 artifact candidate
uses fresh exact installer URLs and release-consistent pins; it must still pass
the documented tag and publication gates.
Candidate site, release-workflow, and installer identity checks pass. The
reviewed archive contains 161 filesystem entries (152 files), every file
byte-identical to the source tree. Its canonical size inventory is 7491 bytes
with SHA-256 `aaba8dd491003ebeeaa12170a3cc7c00b0990c4dfd0da336c98ec5419f024029`.
The first joined exact-tree gate on `35c39b9` passed lint, types, and the script
and plugin suites, then stopped with three source-suite failures. One missed
v24-upgrade fixture still expected schema 44 and its old ledger tail; both
expectations now name 45. Two unchanged automation FIFO tests timed out in that
aggregate run but passed the focused reproduction in 4 and 3 milliseconds.
The focused schema/FIFO command passes four cases with 18 assertions. No
production automation behavior or test timeout was changed. A fresh complete
gate on the corrected commit remains required.
Artifact publication does not authorize daemon upgrades or activate hosted
commands. Protected capacity activation and intended-target marker proofs
remain required; live two-device Codex and exact-pin Linux Claude acceptance
are not claimed by this review. Managed macOS Claude sign-in stays closed.
