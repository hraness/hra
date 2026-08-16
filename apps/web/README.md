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

The control plane uses the shared default-light design system. Light, Dark, and System appearance choices persist under the shared browser preference, and the authenticated UI keeps its navigation rail and bars mounted while the selected workspace and `Tasks`/`Access` stage changes. Those selections are addressable with the `workspace` and `surface` query parameters; they do not change WorkOS organization authority or Convex task ownership. On compact viewports the same rail becomes a focus-trapped left drawer.

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

After the backend, WorkOS fixture, and web app are running, enroll the desktop with a dispatcher-scoped taskctl agent and map a returned `repo_...` identifier to a local repository as described in [`../desktop/README.md`](../desktop/README.md). The runner uses the same local HTTP origin during development. The web readiness strip remains offline or blocked until the gateway's first accepted heartbeat; this is expected and does not prevent read-only task supervision.

WorkOS is optional for the provider-neutral agent-domain tests. Human HTTP routes always require a signed WorkOS access token. Configure `WORKOS_API_KEY`, `WORKOS_CLIENT_ID`, `WORKOS_COOKIE_PASSWORD`, and `NEXT_PUBLIC_WORKOS_REDIRECT_URI` in the Next.js environment, and configure the matching API key and client ID in the Convex deployment environment. Convex derives the two supported production issuers from that client ID: `https://api.workos.com/` and `https://api.workos.com/user_management/<client-id>`. An environment-provided issuer override is not accepted. AuthKit exposes `/auth/sign-in`, `/auth/sign-up`, and `/auth/callback`; the browser access token is forwarded to Convex through `ConvexProviderWithAuth` and is not persisted by the app.

The signed local acceptance harness may replace WorkOS with an exact-loopback server. Before pushing Convex functions, set `TASKCTL_LOCAL_FIXTURES_ENABLED=true`, `TASKCTL_LOCAL_FIXTURE_ISSUER`, and `TASKCTL_LOCAL_FIXTURE_JWKS_URL` in the deployment environment so `auth.config.ts` can register its RS256 provider. The issuer and JWKS URL must both be loopback URLs. Set `WORKOS_API_HOSTNAME=127.0.0.1`, `WORKOS_API_HTTPS=false`, and `WORKOS_API_PORT` to route the WorkOS SDK to the same fake server. This changes the provider endpoint only: `/v1/organizations`, `/v1/workspaces`, and `/v1/agents` still reject missing, unsigned, wrong-issuer, and incorrectly organization-bound JWTs.

`POST /v1/auth/refresh` accepts the refresh token only in `Authorization: Bearer ...`, optionally selects a WorkOS organization from its JSON body, rotates the returned refresh token, and deliberately disables SDK retries so an ambiguous refresh cannot consume a token twice.

Organization provisioning leases the owner-membership step and durably marks the one allowed membership create before sending its zero-retry WorkOS request. Once marked, every retry is poll-only, including after an indeterminate response or an eventually consistent empty list. This prevents duplicate memberships; the deliberate tradeoff is that a crash after the marker commits but before the request is sent requires operator recovery instead of an automatic second create.

Configure `WORKOS_WEBHOOK_SECRET` in the Convex deployment and send WorkOS webhooks to `POST /webhooks/workos`. The route verifies the signature over the exact raw body before WorkOS parses JSON. It projects `organization.created`, `organization.updated`, `organization.deleted`, `organization_membership.created`, `organization_membership.updated`, and `organization_membership.deleted`; other valid signed events receive an idempotent ignored receipt. Receipts use the WorkOS event ID and remain for 30 days.

Two leased, paginated Convex jobs run every 15 minutes. One rechecks projected membership IDs, including provider-side deletion; the other enumerates active, inactive, and pending provider memberships for every projected WorkOS organization so a missed create webhook is recoverable. Bounded runs schedule immediate cursor-based continuations instead of waiting for the next interval. Provider calls remain in actions, and projection writes remain in transactions.

The workspace serves the canonical `hra.sh` origin. `bun run build` compiles
the Next.js application and never deploys Convex or mutates a hosting
provider. Configure deployments outside this public source tree. Session sync
remains fail-closed while
`HRA_SESSION_SYNC_ENABLED` is absent or `false`; the unchanged
`OPRTE_SESSION_SYNC_ENABLED` value remains a fallback, and conflicting names
fail closed. Enable it only after the
exact WorkOS application, Convex environment, desktop public coordinates, and
production HTTP route readbacks pass for the same source revision.

## macOS prerelease

`/download` describes the current source-only prerelease. It points to the
checked Apple Silicon build documented in the repository and does not proxy an
artifact store or embed signing, notarization, or publication custody. Exact
near-miss routes remain protected when WorkOS authentication is configured.

The public workspace does not create or publish an official consumer binary.
Run `bun run --cwd apps/desktop build:macos` on an Apple Silicon Mac with the
pinned toolchain to produce local source-build evidence.

## Hraness suite account

The authenticated rail includes an optional Hraness account status beside the human controls. This is additive subscription identity only. WorkOS remains authoritative for the human, organization, membership, and organization role; Convex remains authoritative for workspace roles and task state. A suite alias never identifies an agent, credential, session, desktop runner, or repository, and suite features do not gate an HRA capability.

`/api/suite-auth/[...all]` is HRA's OAuth 2.1/OIDC relying-party route for the canonical `account.hraness.com` service. Access and refresh tokens remain encrypted in server-only `HttpOnly` cookies. The browser receives only the bounded suite session view and short-lived signed receipts; it does not persist provider tokens or send them to Convex.

Linking requires both a live Hraness session and a currently authorized WorkOS human with an active projected organization membership. Convex mints a four-minute HMAC proof bound to that WorkOS subject, persists the challenge, verifies the returned link receipt, and atomically rejects both local-human-to-second-account and account-to-second-human conflicts. Entitlement receipts are verified with the same environment-scoped keyring before a monotonic revision/observation projection is stored. The public query labels that projection `fresh`, `stale`, or `unverified` and returns no receipt signature or secret.

Product-local identity linking fails closed until the HRA runtimes are configured:

- The web host needs `NEXT_PUBLIC_SITE_URL=https://hra.sh`, a distinct `SUITE_OIDC_COOKIE_SECRET`, and `SUITE_IDENTITY_RECEIPT_KEY_VERSION`. Missing or mismatched values make the suite route return `503 SUITE_OIDC_UNAVAILABLE`.
- The HRA Convex environment needs an HRA-only `SUITE_IDENTITY_LINK_KEYS` keyring and the same active `SUITE_IDENTITY_RECEIPT_KEY_VERSION` selector. Verification retains older versions for the same environment through the maximum five-minute receipt lifetime. Missing, ambiguous, or malformed configuration makes proof and receipt actions return `unavailable`.
- The ordinary hosted WorkOS and HRA Convex configuration described above must also be live, because suite linking reuses the existing WorkOS human and active organization-membership authorization rather than creating another product principal.

WorkOS-to-Hraness identity linking remains unavailable until the web session
and HRA receipt keyring are configured. Missing suite configuration does not
block WorkOS sign-in or any HRA task capability.

## Deterministic browser lab

HRA web has a credential-free Direct composition that renders the real task workspace through the same app-owned props and action port used by the live Convex adapter. It does not mount WorkOS, construct a Convex client, import generated APIs, or claim to simulate provider sessions and database transaction semantics.

The workbench also mounts the shared appearance provider and starts in light mode, so its Light/Dark/System control exercises the same theme-relative task surface without importing any production identity or transport adapter.

Start the scenario workbench or run its bounded Chromium evidence pass from the repository root:

```sh
bun run direct:hra:web
bun run verify:hra:web:direct
```

From this directory, `bun run test:direct` checks the strict world parser, inferred definition, session-owned exact action scripts and deterministic backend, canonical probe/coverage wire parsing, verifier policy, and production-exclusion boundary. `bun run build:direct` compiles only the isolated Vite lab. `bun run build` compiles only the Next.js application; run `bun run check:direct-boundary` as a separate production-boundary check.

The browser verifier exercises representative read, mutation, failure, and retry paths at wide, stacked, and compact viewports. It waits for identical canonical probes, rejects console, page, request, pending-work, and script-drain failures, then writes ignored screenshots and an atomic manifest below `artifacts/direct/hra-web`.

These scenarios are deterministic UI evidence. WorkOS authentication and organization switching, real Convex subscriptions and transactions, HTTP/CLI interoperability, and hosted deployment remain direct or mixed-evidence gates and are not relabeled as Direct coverage.
