# Convex Auth identity cutover

This is a two-deployment migration. The compatibility deployment must run
before the final strict schema. Reversing that order makes existing identity
documents fail schema validation and can strand vault and scheduled-chat
authority.

## Preconditions

1. Put the HRA control plane and session-sync writers into a maintenance
   window. Do not permit identity, organization, membership, workspace,
   promotion, suite-link, human-command, vault, or schedule writes while the
   before/after manifests are collected.
2. Complete a recoverable Convex deployment export. Record its immutable
   location, deployment name, source commit, document counts, and completion
   time in the change ticket.
3. Check that `CONVEX_DEPLOYMENT` names the intended production deployment.
   Never use an inferred default.
4. Run the local tests for
   `convex/identityCutover.test.ts` and
   `scripts/identity-cutover-schema.test.ts`.

### Legacy environment purge

Use the exact names and prefix families exported as
`legacyIdentityProviderEnvironmentVariables` and
`legacyIdentityProviderEnvironmentPrefixes` from `scripts/vercel-build.ts`.
Inventory every name accepted by
`isLegacyIdentityProviderEnvironmentVariable` in all Vercel scopes
(`production`, `preview`, and `development`) and in the exact production
Convex deployment named by `CONVEX_DEPLOYMENT`. Attach the before inventory to
the change ticket, delete every match through the reviewed provider
interfaces, then inventory all four locations again. Every scope must contain
zero matching names.

The build wrapper refuses a deployment when any denylisted variable is
present and strips the names from every child environment. This is a second
guard, not a substitute for provider deletion. Keep writers stopped if a name
reappears. Repeat the zero inventory immediately before restoring writers at
the end of the cutover.

## Deployment 1: compatibility

Prepare the transitional schema from the reviewed final schema:

```sh
bun run scripts/identity-cutover-schema.ts status
bun run scripts/identity-cutover-schema.ts prepare
bun run scripts/identity-cutover-schema.ts status
```

The command refuses an unexpected schema and keeps the exact final source in
ignored mode-0600 custody under `apps/web/.convex/`. The compatibility schema
adds only the predecessor fields and tables needed to read old rows. It keeps
the new Convex Auth, pairing, vault, sync, and schedule tables.

Deploy this compatibility schema and the `identityCutover` functions through
the reviewed production deployment workflow. Do not expose any cutover
function through HTTP or a public Convex function.

Before changing a row, paginate `identityCutover:authorityPage` to completion
for every table below and store the returned ordered bindings in the encrypted
change-ticket attachment:

```text
users
organizations
organizationMemberships
workspaces
workspaceMemberships
promotionSessions
suiteIdentityAliases
suiteEntitlementProjections
humanCommandReceipts
hostedMutationAttempts
syncVaults
syncSessionEntries
syncScheduledChats
syncScheduledChatWakes
syncScheduledChatRuns
```

The suite and receipt manifests intentionally omit only the subject string
that will change. They retain stable user, suite-account, receipt-digest,
organization, idempotency, request, hosted-attempt, and receipt-link bindings.

Also paginate `identityCutover:legacyShapePage` for `users`, `organizations`,
`organizationMemberships`, and `promotionSessions`. Record one fixed `now`
value and paginate `identityCutover:subjectMismatchPage` for
`suiteIdentityAliases`, `suiteEntitlementProjections`,
`suiteIdentityLinkChallenges`, `humanCommandReceipts`, and
`hostedMutationAttempts`. The challenge scan reports pending proofs only. The
receipt scan reports every retained receipt, including an expired receipt kept
for an open hosted recovery attempt. The hosted-attempt scan checks every
linked receipt and every open effect-started attempt from the legacy unlinked
crash window. It resolves exactly one matching receipt across the predecessor
and preserved public subjects. Zero or multiple matches stop the cutover.
Complete receipt retention first so the inventory includes all authoritative
recovery rows. Never purge a retained receipt.

Paginate `identityCutover:listPredecessorRows` for every table returned by
`predecessorOnlyIdentityTables`. Record every page cursor, count, exact
document ID, creation time, current subject, expected user/public subject, and
stable binding returned by the inventories. A truncated page is not a
completed inventory.

Before enabling writes, preflight every target subject. No second suite alias
or entitlement projection may already use the target user public ID. No
receipt may already use the target public ID with the same principal kind,
organization, operation, and idempotency key. A collision, ambiguous legacy
subject, subject that resolves to one user's predecessor ID and a different
user's current public ID, missing user, digest mismatch, or hosted receipt-link
mismatch stops the cutover before any identity row is stripped.

Enable exact in-place replacement temporarily:

```sh
bunx convex env set HRA_IDENTITY_CUTOVER_ENABLED replace-exact-rows
```

Call the subject migrations first, while the compatibility user rows still
carry the predecessor subject used for an exact cross-check. For every
inventoried row, call exactly one matching internal mutation. Bind each call
to its Convex document ID and all listed stable authority identifiers:

```text
identityCutover:replaceExactPromotionSessionActor
  { promotionSessionId, expectedPublicId, expectedOrganizationId,
    expectedStartedByUserId, expectedOldSubject, expectedNewSubject,
    expectedAuthorizationMembershipId, expectedStagingWorkspaceId }

identityCutover:replaceExactSuiteIdentityAliasSubject
  { aliasId, expectedUserId, expectedOldSubject, expectedNewSubject,
    expectedSuiteAccountId }

identityCutover:replaceExactSuiteEntitlementSubject
  { projectionId, expectedUserId, expectedOldSubject, expectedNewSubject,
    expectedSuiteAccountId, expectedReceiptDigest,
    expectedProjectionRevision }

identityCutover:purgeExactPendingSuiteIdentityChallenge
  { challengeDocumentId, expectedChallengeId, expectedUserId,
    expectedOldSubject, expectedCreatedAt, expectedExpiresAt }

identityCutover:linkExactHostedMutationReceipt
  { attemptId, receiptId, expectedUserId, expectedOldPrincipalId,
    expectedNewPrincipalId, expectedOrganizationId, expectedWorkspaceId,
    expectedWorkspacePublicId, expectedSourceId,
    expectedAttemptOperation, expectedFingerprint,
    expectedFingerprintKeyVersion, expectedIdempotencyKey,
    expectedReceiptOperation, expectedRequestDigest, expectedRequestId,
    expectedReceiptExpiresAt, expectedAttemptDocumentDigest,
    expectedReceiptDocumentDigest }

identityCutover:replaceExactHumanReceiptPrincipal
  { receiptId, expectedUserId, expectedOldPrincipalId,
    expectedNewPrincipalId, expectedPrincipalKind,
    expectedOrganizationId, expectedOperation, expectedIdempotencyKey,
    expectedRequestDigest, expectedRequestId, expectedExpiresAt }

identityCutover:replaceExactUser
  { userId, expectedPublicId }

identityCutover:replaceExactOrganization
  { organizationId, expectedPublicId }

identityCutover:replaceExactMembership
  { membershipId, expectedOrganizationId, expectedUserId }
```

Run the mutations in this order: promotion sessions; suite aliases and
entitlement projections; deletion of exact pending old-subject suite
challenges; exact linking of every inventoried open effect-started unlinked
hosted attempt; all other retained human-command receipts; organization
memberships; organizations; users. The linking mutation accepts an already
current public receipt subject, and otherwise rewrites the predecessor subject
while installing the exact receipt ID on the attempt in one Convex
transaction. It binds both documents by content-blind digests and every stable
recovery field. A pending challenge is deleted because its proof binds the old
subject and must never be rewritten. Consumed challenges are retained as
history. Receipt principal rewrites preserve the receipt ID, digest, response,
request ID, expiry, idempotency tuple, and every hosted-attempt receipt link.
Hosted mutation attempt principal IDs already reference the stable Convex user
ID and are never rewritten.

These functions are disabled by default and never scan. Promotion, user,
organization, and membership normalization uses `db.replace` on the existing
ID; subject-only migrations patch only the named subject field. Existing HRA
public IDs remain opaque even when they use a legacy-looking prefix.
Organizations previously stuck in `provisioning` or `failed` become
`disabled`; no such tenant becomes active during migration.

Paginate `subjectMismatchPage` again with the recorded `now`. Every page must
contain zero mismatches. Then paginate `legacyShapePage` again. Every page must
contain zero document IDs. Do not continue if any retained subject mismatch,
cross-namespace subject collision, provider field, promotion actor predecessor
field, missing final promotion actor, or non-final organization status remains.

Change the gate only after replacement counts match the inventory:

```sh
bunx convex env set HRA_IDENTITY_CUTOVER_ENABLED purge-exported-predecessor-rows
```

For every row returned by `listPredecessorRows`, call
`identityCutover:purgeExactPredecessorRow` with its exact table, document ID,
and creation time. The mutation accepts only the five predecessor-only tables;
it cannot address an identity, vault, workspace, task, or schedule table.
Paginate every predecessor table again and require zero rows.

Remove the temporary gate:

```sh
bunx convex env remove HRA_IDENTITY_CUTOVER_ENABLED
```

Collect every `authorityPage` again. The complete before and after manifests
must be byte-for-byte equal, including workspace membership roles, promotion
authority, suite receipt/account bindings, human receipt digest and
idempotency bindings, and hosted-attempt receipt links. Identity, workspace,
receipt, hosted-attempt, vault, and schedule counts must also match the
deployment export, except for the exact inventoried pending challenges and
predecessor-only rows intentionally deleted above. A mismatch stops the
cutover and triggers restore from the recorded export.

## Deployment 2: final strict schema

Restore the reviewed final source:

```sh
bun run scripts/identity-cutover-schema.ts restore
bun run scripts/identity-cutover-schema.ts status
```

The second status must print `strict`. Run the full web checks, then deploy the
strict schema through the production workflow. The strict schema contains no
predecessor fields or tables. The normal authentication and authorization
paths never read a predecessor identifier.

After deployment, prove all of the following before ending maintenance mode:

- all Vercel scopes and the exact production Convex deployment contain zero
  names accepted by `isLegacyIdentityProviderEnvironmentVariable`;
- password sign-up creates one user, personal organization, owner membership,
  workspace, and active workspace membership;
- every pre-cutover session lacks password-session provenance and therefore
  must complete a fresh password sign-in before it can approve desktop pairing;
- a migration claim binds only its exact existing user and cannot bind twice;
- desktop pairing requires browser approval of one exact organization and
  workspace, redeems once, and rejects replay;
- refresh and scope selection return current membership and rotated tokens;
- a revoked organization or workspace membership fails every subsequent
  authorization;
- suite aliases and entitlement projections resolve only through the Convex
  user public ID, with zero pending old-subject link challenges;
- every retained human command receipt resolves through the Convex user public
  ID, and every open effect-started hosted recovery attempt has exactly one
  linked authoritative receipt,
  replays with its original digest and request ID, and retains any exact hosted
  mutation attempt link;
- the before/after workspace, promotion, suite, receipt, hosted-attempt, vault,
  and scheduled-chat authority manifests still match.

If any final-schema check fails, keep writers stopped and restore the recorded
deployment export. Do not add a runtime dual-read fallback.
