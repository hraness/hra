---
title: Separate attention email credentials from sign-in
description: Isolate attention delivery credentials and prove configuration before consuming an outbox attempt.
type: plan
area: hosted-sync
status: active
tags:
  - email
  - migration
---

# Separate attention email credentials from sign-in

## Outcome

Attention email uses its own strict `HRA_ATTENTION_RESEND_API_KEY`. It never
falls back to the sign-in credential or accepts the same value. A missing,
malformed, or shared credential stops the production drain before it claims
an outbox attempt. Sign-in email keeps its existing credential and behavior.

## Context

The existing attention transport reads `HRA_RESEND_API_KEY`, which also sends
sign-in codes. Its drain claims an attempt before the transport checks that
configuration, so a configuration refusal is recorded as a retryable network
failure. The [hosted runbook](../../docs/hosted-sync.md) also needs to distinguish
configured environment names, validated credentials, and permission to send.

## Scope

Implement the runtime boundary, focused deterministic regressions, fresh
configuration and status contracts, and a protected preparation/read-only
reconciliation operator with exact source, candidate, target, and recovery
bindings. Keep this as a
source-delivery checkpoint. Live credentials, deployment, migration, email
sends, attention activation, package publication, and unrelated product work
are not part of this checkpoint.

## Constraints and decisions

- Preserve attention body version 1, sender and subject branding, idempotency,
  leases, authority generations, uncertain-effect settlement, and retry rules.
- Preserve the historical Reply-To migration's explicit predecessor and
  postcondition. Do not reinterpret its receipts as attention-key evidence.
- Keep secrets out of arguments, child environments, ordinary output, and
  evidence. A domain-separated key digest may occur only in protected
  migration evidence.
- Environment-name presence and generation-zero inactivity are separate from
  credential validity, sending-domain authorization, and activation authority.
- The pinned Convex 1.45 importer checks existing names before sending an
  unconditional update. Omitting `--force` does not establish an atomic
  provider compare-and-set. The migration must not claim that guarantee.

## Plan

1. Isolate and validate the attention credential before production claims.
2. Extend fresh configuration and make hosted status limitations explicit.
3. Implement and review protected preparation and read-only reconciliation.
   Refuse every write-capable migration path with
   `provider_add_only_unavailable`; the inspected pinned CLI and documented API
   provide no proven conditional-create mechanism.
4. Run focused regressions, independent adversarial review, and the complete
   exact-tree repository gate. Deliver through a protected pull request and
   verify required checks on the exact merged main commit.

## Verification

- Missing, malformed, or auth-equal attention keys produce no claim, provider
  request, retry settlement, or secret-bearing error.
- OTP remains independent of attention configuration. Existing attention body
  bytes and idempotency remain stable.
- Fresh configuration requires distinct keys and sends them only through the
  bounded protected stdin path. Status never grants sending authority.
- Operator fixtures prove exact binding, secret-safe failures, preserved
  prerequisites, conflicting-value refusal, and no provider write on any
  supported path. Preparation or matching readback is never an apply receipt.
- Focused tests, scoped lint, TypeScript, independent review, and `bun run check`
  must pass on the delivery tree. Synthetic fixtures are not live proof.

## Risks and recovery

A deployment without the dedicated key intentionally cannot send attention
email. It must remain inactive until a separately authorized migration and
readback complete. Sign-in is unaffected. This operator cannot apply a key:
the inspected pinned CLI and documented API provide no proven conditional-create
mechanism. A future native
conditional mechanism or rigorously scoped operational custody protocol needs
its own reviewed design and live handoff. Task ownership does not establish
global provider-writer exclusion. Never relabel preparation evidence as proof
of an applied migration.

## Execution evidence

- 2026-09-07: implementation started from exact main
  `b1f7743626bc93c135efdd441e235ac85ddd4c42`. The frozen, script-disabled Bun
  1.3.14 installation passed without changing the package manifest or lockfile.
- Focused runtime coverage passes 76 tests and 839 assertions. Setup/status
  passes 29 tests and 275 assertions. Historical Reply-To compatibility and
  the additive containment inventory pass 20 tests and 508 assertions. The
  current-fresh-name assertion gains the new seventh name; historical
  prerequisites, postconditions, and the old operator are unchanged.
- Independent reviews approve runtime isolation, the strict untouched-inactive
  cron predicate, setup/status, and the additive operator inventory. Long
  synthetic fixture keys were shortened without changing tested branches;
  the existing public sensitive-text policy remains unchanged.
- The write-free operator passes 41 tests and 3,967 assertions. Independent
  review approves its exact binding, protected evidence, first-child
  environment filtering, and anonymous-pipe input. A real macOS shell pipe
  and real unsafe-file/link/FIFO rejections pass. The Linux kernel-pipe path
  has deterministic policy coverage; real Linux execution remains a required
  CI check. Source TypeScript passes after a typed Bun fetch-mock correction.
- The existing web plan's unquoted colon prevented KB parsing. Its title now
  has enclosing quotes only; the decoded title and all other lines are
  unchanged. The defect originated in `9d05338b6690feefdf2a6971c46ad2c666af40f5`.
  Bounded percolation finds no candidates, and `kb check --no-catalog` reports
  no issues. Its stale-index notice remains; the catalog was not regenerated.
- Live provider state, credentials, attention controls, and release artifacts
  have not been changed by this checkpoint.

## Review findings

- The Convex importer performs a name read followed by an unconditional update.
  A concurrent insertion can race that read. The source checkpoint therefore
  implements preparation/read-only reconciliation only, with a closed
  `provider_add_only_unavailable` refusal before any write-capable call.
- The inspected Convex 1.45 client can retry POST requests after network errors
  or HTTP 404 responses. One CLI invocation therefore does not prove one
  dispatch. A later write design must address those transport retries or prove
  conditional/idempotent semantics; this operator remains read-only.
- Operator review found that a nonterminal descriptor alone does not prove
  private input, and an undiscovered key can be embedded in an otherwise
  allowlisted environment value. The operator requires a proven anonymous
  pipe and filters Resend-shaped inherited values before the first child.
  Synthetic descriptor and hostile-environment regressions must pass before
  source delivery.
