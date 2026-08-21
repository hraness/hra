# HRA web control plane

The web workspace owns HRA's local Convex task backend and human control plane. `taskctl` consumes its versioned HTTP API from the sibling CLI workspace. The canonical public origin is `https://hra.sh`.

The task workspace also owns desktop-runner presence and dispatch. A task created from the web surface is committed atomically with its queued run only when a non-expired HRA gateway advertises the selected repository and free capacity. The browser subscribes to server-authenticated readiness and a bounded public display stream: reasoning summaries, assistant messages, content-free tool activity, and lifecycle state. It never connects directly to a desktop app and never receives raw reasoning, tool details, local paths, command output, or Codex credentials.

The same Convex deployment exposes a separate optional session-sync relay for
the desktop. It stores signed membership evidence, wrapped keys, opaque
routing coordinates, bounded encrypted `session_summary` records, replay
defenses, and paged cursors. It never receives a vault root, private key,
prompt, response, transcript, reasoning, tool data, account identity,
provider identifier, or filesystem path. Remote summaries are view-only and a
relay outage cannot block local desktop chat.

The control plane uses the shared System-first design system. A first visit follows the operating-system appearance, while explicit Light, Dark, and System choices persist under the shared browser preference. The authenticated UI keeps its navigation rail and bars mounted while the selected workspace and `Tasks`/`Access` stage changes. The URL records those views, while the Convex Auth session records the exact selected organization and workspace used for authorization. On compact viewports the same rail becomes a focus-trapped left drawer.

## Local development

Use Bun 1.3.14 and Node 24. From this directory:

```sh
CONVEX_AGENT_MODE=anonymous bun x convex init
bun run convex:dev
```

In a second terminal, run `bun run dev:web`. The first command creates ignored `.convex/` state and `.env.local`; commit neither. Set the credential pepper through `convex env set` before exercising enrollment or agent authentication. Set the hosted mutation fingerprint key before exercising browser writes.

From the repository root, `bun run web:hra` runs this workspace's combined
Convex and Next.js development command. It serves the hosted control plane with
browser hot reloading and does not start the Zig host or private desktop
gateway. A browser cannot itself spawn Codex or receive arbitrary filesystem
authority; it can only delegate work to a separately running, authenticated
local helper. Use `bun hra` for the product-development loop with the real
Native bridge, Codex/filesystem authority, and Vite hot reloading.

The four `HRA_HOSTED_MUTATION_FINGERPRINT_KEY_*` variables belong only in the Convex deployment. The current key is required for hosted browser mutations and must be a canonical unpadded base64url encoding of exactly 32 random bytes; its version is a portable identifier of at most 64 characters. Existing deployments may keep the corresponding `OPRTE_*` names with their exact values. HRA names take over only when absent or byte-for-byte equal to the old names; a disagreement fails closed. The rename does not rotate keys or change the persisted HMAC namespaces. Convex HMACs the browser's semantic digest with the organization, workspace, principal, source, and key version before the generic mutation journal sees it. The browser digest, raw intent, title, comment, answer, transcript, and provider data are never stored or returned by the backend.

Rotation is two-phase. Install a new current key and version while moving the former pair to `PREVIOUS`, then retain both until every open attempt bearing the previous version has settled. Only one previous version is accepted. Missing, malformed, duplicated, or half-configured key pairs fail closed. Removing the previous pair while one of its attempts remains open also makes new fingerprint resolution fail closed, preventing a replay under the new key.

After the Convex backend and web app are running, sign up with an email and password. New accounts atomically receive a personal organization, owner membership, and initial workspace. Then pair the desktop in its browser-opened `/pair/desktop/<pairingId>` page, compare the short code, and choose the exact organization and workspace. Enroll a dispatcher-scoped taskctl agent and map the returned `repo_...` identifier to a local repository as described in [`../desktop/README.md`](../desktop/README.md). The web readiness strip remains offline or blocked until the gateway's first accepted heartbeat; this is expected and does not prevent read-only task supervision.

Human HTTP routes use normal Convex Auth access and refresh tokens. `POST /v1/auth/desktop-pairings` accepts a verifier challenge and returns only an opaque locator, credential-free same-origin browser URL, comparison code, expiry, and poll interval. Browser approval requires a current password session and selects an exact active organization/workspace membership. Redeem proves the native-held verifier once and returns the normal human authentication response; replay is consumed, expired requests fail closed, and the verifier never enters a URL or browser projection.

`POST /v1/auth/refresh` uses the Convex Auth refresh token and returns the stable HRA user plus the session's selected organization/workspace after a current membership recheck. `POST /v1/auth/selection` creates a new session with the requested current scope, invalidates the old session before returning, and returns the replacement access/refresh pair. A lost response therefore invalidates the locally held old authority instead of silently changing its tenant meaning.

Existing pre-cutover HRA users must use a bounded operator-issued one-time migration claim. The server hashes the claim before it reaches the user transaction, binds it to one exact preserved HRA user, rejects email collisions and second password accounts, and consumes it atomically. See [`IDENTITY_CUTOVER.md`](IDENTITY_CUTOVER.md) for the mandatory staged schema and in-place identity migration. Production runtime paths never fall back to predecessor identifiers.

The workspace serves the canonical `hra.sh` origin. Local `bun run build`
compiles the application without provider mutation. Vercel uses the separate
checked build entry in `vercel.json`: only its exact Production target may
deploy Convex functions to `benevolent-akita-439`. A generated Preview skips
Convex deployment and builds an anonymous app-only client of the exact
`benevolent-akita-439.convex.cloud` and `benevolent-akita-439.convex.site`
public endpoints. Custom staging and every unrecognized provider target fail
closed. The Next.js configuration binds every verified Vercel deployment to
the registered `hra` project and exact Git object through
`X-Hraness-Delivery-Proof`. It preserves HRA's security and private-cache
headers, and adds `X-Robots-Tag: noindex, nofollow, noarchive` to generated
Preview responses. Session sync remains fail-closed while
`HRA_SESSION_SYNC_ENABLED` is absent or `false`; the unchanged
`OPRTE_SESSION_SYNC_ENABLED` value remains a fallback, and conflicting names
fail closed. Enable it only after the
exact Convex Auth environment, desktop public coordinates, and
production HTTP route readbacks pass for the same source revision.

## Production provider cutover

Before any provider deployment, enable Vercel's **Automatically expose System
Environment Variables** setting on the exact HRA project and read it back as
enabled for Production and Preview. The source gate requires Vercel's own
`VERCEL`, target, Git provider, repository owner/name, branch, and full commit
SHA evidence. It intentionally refuses when that project setting is disabled
or any system identity is absent; caller-created substitutes are not an
accepted deployment path.

Scope the public `NEXT_PUBLIC_CONVEX_URL` and
`NEXT_PUBLIC_CONVEX_SITE_URL` records to Vercel Production and Preview, with
the exact `benevolent-akita-439` URLs. Scope the Convex production deploy-key record,
`SUITE_IDENTITY_RECEIPT_KEY_VERSION`, `SUITE_OIDC_COOKIE_SECRET`, and
`NEXT_PUBLIC_SITE_URL` to Production only. Scope `NEXT_PUBLIC_POSTHOG_KEY` to
Production only as well; it is a public project token, but it grants analytics
ingestion capability. Use the token for shared PostHog project `543691`, and
enable cookieless mode in that project. When present, the browser sends one anonymous,
cookieless `$pageview` for exact canonical public routes to the fixed
`https://us.i.posthog.com` host. It sends no analytics from Preview, `/app`,
authentication, callbacks, APIs, account or task surfaces, or route near
misses. A missing token leaves analytics inert; a configured malformed token
refuses the Production build before Next.js can embed it. The deploy key must name
`benevolent-akita-439`, the selector must be `v1`, and the site URL must be
`https://hra.sh`. Create a fresh HRA-held deploy key for that deployment and a
fresh independent HRA cookie secret. Do not copy or share the predecessor
deploy key or cookie secret. Cookies cannot cross from `oprte.com` to `hra.sh`,
and deploy keys are exact project/environment custody. Do not copy the
predecessor `https://oprte.com` site value.

Create the deploy key only with the source-owned Management API helper. The
helper requires the immutable Convex project ID `2680173`, Production
deployment ID `4677913`, deployment name `benevolent-akita-439`, and pre-rename
`cclrte:oprte` identity. It requests exactly `deployment:deploy`, verifies the
new key metadata, and writes the returned secret only through an already-open
caller-owned mode-0600 file descriptor. Its report contains IDs, names,
permissions, file mode, and byte count, never the personal access token, deploy
key, or a stable secret digest.

First restrict every retained copy of the Convex personal-token config,
including dated backups, to its owner. Then create a fresh empty destination
in a fresh owner-only directory and pass only canonical paths:

```sh
find ~/.convex -maxdepth 1 -type f -name 'config.json*' -exec chmod 0600 {} \;
CONVEX_AUTH_FILE="$(realpath ~/.convex/config.json)"
HRA_PROVIDER_DIR="$(mktemp -d /private/tmp/hra-provider-cutover.XXXXXX)"
chmod 0700 "$HRA_PROVIDER_DIR"
HRA_DEPLOY_KEY_FILE="$(mktemp "$HRA_PROVIDER_DIR/deploy-key.XXXXXX")"
chmod 0600 "$HRA_DEPLOY_KEY_FILE"
bun run provider:create-convex-deploy-key -- \
  --auth-file "$CONVEX_AUTH_FILE" \
  --secret-file "$HRA_DEPLOY_KEY_FILE"
```

Do not use `convex deployment token create` for this key. Convex 1.44 does not
send an `allowedActions` constraint from that command, and its default path
prints the generated secret. If the checked helper reports any failure, or
exits abnormally after sending the create request, do not rerun it until you
inspect the fixed
`vercel-hra-production-2026-08-17` name in the dashboard, revoke any incomplete
result, empty the destination, and begin again. This recovery rule includes
post-create readback, file write, `fsync`, path-identity, and abnormal-exit
failures because the provider key may exist even when local custody did not
commit. Install the successful file as the HRA Vercel Production deploy-key
record without copying it through argv, shell history, or terminal output.
Remove the local file only after Vercel scope and build readback succeed.

Do not configure Convex-only custody in Vercel, even as an empty record. The
Production wrapper refuses the receipt keyring, session flags, hosted-mutation
keys, taskctl peppers or fixture settings, identity-cutover gates, and
authentication key material. Configure those values only on the
exact Convex deployment.

Leave `HRA_RELEASE_PUBLICATION_COMMIT_ALLOWLIST` unset while the release
contract is `candidate`. After the Required CI job succeeds on the exact
publication commit P, set this non-secret trusted manual allowlist to P for
Vercel Production and Preview, then redeploy that exact P. The provider wrapper
proves only that Vercel's canonical `hraness/hra` Git SHA equals the allowlist;
the operator's Required-CI readback is what authorizes setting it. A mismatch,
missing value, non-Git build, wrong repository, or Production branch other
than `main` makes a published build refuse. The wrapper removes the allowlist
before launching the final Next build.

Transfer no custom-staging record. Preview refuses the deploy key, deployment
token, Convex selector, canonical production site claim, Suite cookie or key
selector, authentication credentials, and every other checked production capability,
including an empty provider record. Its two public Convex URLs grant no
backend publication authority.

Use this order for the shared backend:

1. Freeze the exact predecessor OPRTE Vercel project before retaining its
   deploy key for rollback. Disconnect its Git integration and disable every
   automatic deployment or retry path without deleting its last READY
   Production deployment. Read back and record that the project has no Git
   connection, no queued or running deployment, and one unchanged READY
   Production rollback anchor. A retained key without this publication freeze
   is not a safe rollback boundary because old source could republish to the
   shared Convex deployment.
2. Generate the fresh HRA deploy key with the checked helper above, generate
   the independent cookie secret, then install the scoped HRA Vercel values.
   Leave Preview without every production-only record and transfer zero
   predecessor secret values.
3. After Required CI succeeds, run a Vercel Production deployment from the
   exact reviewed candidate commit C on canonical `hraness/hra` `main`, and
   read back that Vercel's system commit SHA is C. Convex 1.44 runs the checked
   nested Next artifact build first, then pushes the HRA parser and functions
   to `benevolent-akita-439`. Vercel promotes the new app only after that
   complete build command succeeds, so the parser lands before the app becomes
   production-visible. Do not change source between this deployment and C's
   package and tag gates.
4. Generate one fresh independent secret in a mode-0600 file as canonical
   unpadded base64url for at least 32 random bytes. Derive the HRA keyring from
   that file only. Do not use the unrelated key already held by Accounts.
5. Append the candidate HRA entry to Accounts without deleting or copying its
   unrelated entry, then prove the Accounts readback against the candidate.
   Next set HRA Convex `SUITE_IDENTITY_LINK_KEYS` to an HRA-only keyring
   containing `hra:production:v1` and prove its readback. Set HRA Convex
   `SUITE_IDENTITY_RECEIPT_KEY_VERSION=v1` last, then rerun the exact HRA audit.
   This verifier-first order avoids a window where HRA can mint a proof that
   Accounts cannot verify. Remove the candidate file only after both
   candidate-match gates pass inside the same bounded custody window.
6. Redeploy and read back the HRA production routes. A missing or invalid
   predecessor OPRTE/Kitchen receipt is expected and is not a health gate.
7. From the same candidate commit C recorded in step 3, complete its full
   package, then follow the desktop release runbook to create and push the
   direct annotated `v0.1.12` tag and
   publish the exact seven-asset immutable GitHub prerelease. Fill the
   working-tree publication contract from C's emitted evidence and require
   `bun run verify:remote-release` to read back exact remote names, byte counts,
   SHA-256 digests, checksum, manifest, DMG binding, and corresponding-source
   binding before committing P. Create P as the exact contract-only child,
   push it, and require the green Required CI source-and-remote readback for
   that exact P. Only then set
   `HRA_RELEASE_PUBLICATION_COMMIT_ALLOWLIST=P` in Production and Preview, and
   redeploy exact P before enabling or exercising the installation handoff.
   The existing annotated `v0.1.11` tag object
   `e4c171e33e414d74a36791fc8577cbfbcef8e52e` points directly to
   `5a2a9842cacc75fee42ab8e23ca8c215a643e21e`, but has no GitHub release or
   assets. Treat it as retired tag-only evidence, never as publication or
   installation authority.
8. Retain the predecessor deploy key only for the bounded rollback window.
   Revoke it after HRA authority and rollback disposition are complete.

### Convex project identity retirement

Rename the Convex project only after candidate C, publication P, the HRA-only
Suite keyring readbacks, production route checks, and installed-app acceptance
have all passed. Keeping the project named OPRTE during those gates avoids
labeling the still-running predecessor functions and environment as HRA before
the actual authority cutover. The fresh HRA deploy key and retained predecessor
key both use the `prod:benevolent-akita-439|...` deployment identity, so the
later project-slug change does not alter either key's target or provide a reason
to shorten the rollback window.

Bind every mutation to immutable IDs in its before-and-after evidence, and use
an ID-addressed endpoint wherever the Management API provides one. Deployment
and deploy-key retirement endpoints are name-addressed, so resolve each name to
the exact ID below immediately before mutation and require that exact ID to be
absent afterward:

- Project `2680173` belongs to team `513923` / `cclrte`, initially has name and
  slug `oprte`, and names `benevolent-akita-439` as its default Production
  deployment.
- Production deployment `4677913` remains project `2680173`, cloud type
  `prod`, default `true`, reference `production`, region `aws-us-east-1`, and
  URL `https://benevolent-akita-439.convex.cloud`.
- Environment-variable **names only** and every deploy-key ID, name,
  permission set, expiry, and last-used timestamp remain byte-for-byte equal.
  Never print or export environment values or deploy-key values for this
  comparison.

Use `GET /v1/projects/2680173`,
`GET /v1/deployments/benevolent-akita-439`, and
`GET /v1/deployments/benevolent-akita-439/list_deploy_keys` for those filtered
Management API records. Capture the environment-name set without values:

These HTTP literals are evidence contracts, not `curl` instructions. Perform
the readbacks and later mutations in the signed-in Convex dashboard while
checking the exact method, path, request body, and non-secret response fields,
or through a separately reviewed client that opens the mode-0600 personal-token
file itself and redacts foreign provider errors. Never put the bearer token in
argv, an environment variable, shell history, or terminal output. Stop if
neither safe path is available.

```sh
bun x convex env list --names-only --deployment benevolent-akita-439
```

Clear every slug-bound authority before renaming. Team Settings must still
show one active Admin member, no Authorized Applications for that member, no
other active member, and no custom roles. The authenticated Management API
readback
`GET /v1/projects/2680173/list_preview_deploy_keys?includeManaged=true` must
return an empty `items` array. These checks rule out custom-role selectors,
project OAuth tokens, and both manual and integration-managed preview keys that
would otherwise follow or break on an `oprte` slug change. Search operator
bookmarks and external automation for the old `cclrte:oprte` selector and
replace each confirmed consumer with `cclrte:hra`; HRA source itself selects
the deployment by name and requires no source change.

Retire the stale staging deployment separately after the same acceptance gate.
Its current immutable identity is deployment `4828041`, name `cool-bear-228`,
project `2680173`, cloud type `prod`, non-default, reference `staging`. Its two
known broad keys, `vercel-oprte-staging-2026-08-10-c` and
`vercel-staging-2026-08-08`, have never been used. Before deletion, read back
that no provider, domain, integration, automation, data, file, or required
backup still depends on it. Preserve an explicit backup or defer retirement if
that evidence is not closed. Otherwise revoke both keys and delete only
deployment `4828041`. Require `GET /v1/deployments/cool-bear-228` to return not
found and `GET /v1/projects/2680173/list_deployments` to contain neither ID
`4828041` nor name `cool-bear-228`. Do not treat deletion of the shared
Production deployment as part of this cleanup.

After staging retirement and the slug-bound-authority checks, send only
`PATCH /v1/projects/2680173` with the Management API body
`{"name":"HRA","slug":"hra"}`.
Read back the exact HRA name/slug, unchanged team and Production project/deploy
identities, unchanged Production URL, unchanged environment-name set, and
unchanged deploy-key metadata. The direct deployment dashboard URL and both
public Convex endpoints must remain reachable. This is an in-place label and
slug update, not a deployment transfer, data copy, environment rewrite, or key
rotation.

During the bounded rollback window, send only
`PATCH /v1/projects/2680173` with `{"name":"oprte","slug":"oprte"}` if the
rename readback or a known external selector fails. Repeat the same
immutable-ID, Production URL, names-only environment, and key-metadata
comparison. After HRA acceptance and rollback disposition are final, revoke
the predecessor Production keys, detach
`oprte.com` and `hraness.kitchen` while retaining the domains in the account,
then delete the predecessor Vercel project. Deleting that project earlier would
destroy its READY deployment and environment rollback anchor.

The deployed source owns a read-only internal audit. Its no-candidate form
returns only selector state, exact-key counts, and a closed status:

```sh
bun x convex run suiteIdentityAudit:audit '{}' \
  --deployment benevolent-akita-439
```

After both HRA and Accounts have been configured from the same mode-0600
candidate file, verify HRA with the source-owned wrapper:

```sh
bun run verify:receipt-provider -- \
  --secret-file /private/absolute/canonical/path/to/receipt-secret
```

The wrapper validates the file descriptor and permissions, sends only a fresh
random challenge to the internal audit, and compares its domain-separated HMAC
response locally with a timing-safe check. It accepts only
`keyCount=1`, `hraProductionV1Count=1`, `otherKeyCount=0`, `selectorV1=true`,
`status=ready`, and `candidateSecretMatch=true`. Its output contains only those
counts, status, and match bit. Run the Accounts counterpart against the same
candidate before deleting it; shape-only readback does not prove shared-secret
equality.
The file argument must use its exact native `realpath` spelling. In particular,
macOS temporary paths often print `/var/...` while the canonical path is
`/private/var/...`; pass the canonical result rather than the alias.

Never install the HRA-only keyring until the candidate deployment in step 3
has completed and its HRA parser is live. The predecessor backend may reject
the new shape, which would leave neither checked source nor a safe rollback
path in authority.

The shared deployment may retain
`OPRTE_HOSTED_MUTATION_FINGERPRINT_KEY_CURRENT`, its exact `_VERSION`, and
`OPRTE_SESSION_SYNC_ENABLED` as compatibility inputs. HRA adopts the matching
HRA names only when absent or byte-for-byte equal, so do not rotate or delete
those values during this authority cutover. A production suite-link E2E also
requires a live Convex Auth password account and current tenant membership. If
that acceptance account is absent, verify the parser, deployment readbacks,
and unavailable response, and record the authenticated E2E as an external gate
rather than creating production credentials or claiming it passed.

## Public product pages

`/download` links to the exact Apple Silicon GitHub prerelease named in
`app/site.ts`. It publishes the checksum path and discloses that the current
app is ad-hoc signed, not Developer ID signed or notarized. The web workspace
never holds signing credentials or release authority.

`/alternatives` and its static child routes compare HRA with adjacent tools.
Every positive competitor claim must cite a current first-party source, every
page carries a review date, and “not documented” must never be presented as
proof of absence. These routes remain public when Convex Auth is configured; exact
near-miss and control-plane routes remain protected.

## Hraness suite account

The authenticated rail includes an optional Hraness account status beside the human controls. This is additive subscription identity only. Convex Auth and the current Convex database membership remain authoritative for the human, organization, membership, and organization role; Convex also owns workspace roles and task state. A suite alias never identifies an agent, credential, session, desktop runner, or repository, and suite features do not gate an HRA capability.

`/api/suite-auth/[...all]` is HRA's OAuth 2.1/OIDC relying-party route for the canonical `account.hraness.com` service. Access and refresh tokens remain encrypted in server-only `HttpOnly` cookies. The browser receives only the bounded suite session view and short-lived signed receipts; it does not persist provider tokens or send them to Convex.

Linking requires both a live Hraness session and a currently authorized HRA human with an active organization membership. Convex mints a four-minute HMAC proof bound to that stable HRA user, persists the challenge, verifies the returned link receipt, and atomically rejects both local-human-to-second-account and account-to-second-human conflicts. Entitlement receipts are verified with the same environment-scoped keyring before a monotonic revision/observation projection is stored. The public query labels that projection `fresh`, `stale`, or `unverified` and returns no receipt signature or secret.

Product-local identity linking fails closed until the HRA runtimes are configured:

- The web host needs `NEXT_PUBLIC_SITE_URL=https://hra.sh`, a distinct `SUITE_OIDC_COOKIE_SECRET`, and `SUITE_IDENTITY_RECEIPT_KEY_VERSION`. Missing or mismatched values make the suite route return `503 SUITE_OIDC_UNAVAILABLE`.
- Deploy exact Suite Accounts v0.3.0 overlap support before changing either receipt keyring. Generate a fresh independent secret as the canonical unpadded base64url encoding of at least 32 random bytes. The HRA Convex `SUITE_IDENTITY_LINK_KEYS` keyring contains only the `hra:production:v1` entry. Accounts appends that same HRA entry alongside its unrelated existing entry. Never copy the unrelated Accounts key into HRA. Both environments use `SUITE_IDENTITY_RECEIPT_KEY_VERSION=v1`.
- This cutover admits exactly one HRA production/v1 key. Extra HRA versions, development entries, non-HRA entries, a selector other than `v1`, and malformed configuration make proof and receipt actions return `unavailable`. Rotate only through a later reviewed contract that restores bounded multi-key verification. No predecessor OPRTE/Kitchen receipt key is expected to exist, and the predecessor receipt authority being unavailable or invalid is not a rollout health gate.
- The ordinary hosted Convex Auth configuration described above must also be live, because suite linking reuses the existing HRA human and current organization-membership authorization rather than creating another product principal.

HRA-to-Hraness identity linking remains unavailable until the web session
and HRA receipt keyring are configured. Missing suite configuration does not
block password sign-in or any HRA task capability.

## Deterministic browser lab

HRA web has a credential-free Direct composition that renders the real task workspace through the same app-owned props and action port used by the live Convex adapter. It does not mount Convex Auth, construct a Convex client, import generated APIs, or claim to simulate password sessions and database transaction semantics.

The workbench also mounts the shared System-first appearance provider with a concrete light pre-bootstrap fallback. Its final toolbar action is the same one-trigger Light/Dark/System menu used by production, so the deterministic surface exercises persisted preference, keyboard operation, and theme-relative task presentation without importing any production identity or transport adapter.

Start the scenario workbench or run its bounded Chromium evidence pass from the repository root:

```sh
bun run direct:hra:web
bun run verify:hra:web:direct
```

From this directory, `bun run test:direct` checks the strict world parser, inferred definition, session-owned exact action scripts and deterministic backend, canonical probe/coverage wire parsing, verifier policy, and production-exclusion boundary. `bun run build:direct` compiles only the isolated Vite lab. `bun run build` compiles the Next.js application and rejects any resolved or emitted Hugeicons module. Run `bun run check:direct-boundary` as a separate production-boundary check.

The browser verifier exercises representative read, mutation, failure, and retry paths at wide, stacked, and compact viewports. It waits for identical canonical probes, rejects console, page, request, pending-work, and script-drain failures, then writes ignored screenshots and an atomic manifest below `artifacts/direct/hra-web`.

These scenarios are deterministic UI evidence. Password authentication and tenant switching, real Convex subscriptions and transactions, HTTP/CLI interoperability, and hosted deployment remain direct or mixed-evidence gates and are not relabeled as Direct coverage.
