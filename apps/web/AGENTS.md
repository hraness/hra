# Contents

- `app/` – the public `hra.sh` landing and download surfaces, authenticated `/app` control plane, Suite prose bridge, and Convex authority adapter for the shared task surface.
- `suite-account-*.ts` – HRA-owned receipt, profile, browser-session, OIDC, and canonical `account.hraness.com` contracts.
- `direct/` – the isolated deterministic browser composition, scenarios, and evidence verifier.
- `convex/` – schema, authentication, HTTP routes, and transactional domain functions.
- `scripts/` – source-bound Production Convex deployment and anonymous Preview build fencing.
- `README.md` – local HRA task-control-plane setup, commands, and configuration boundaries.
- `package.json` – web, Convex, validation, and test commands.
- `convex.json` – Convex code-generation configuration.
- `next.config.ts` – standalone-workspace-aware Next.js configuration.
- `vercel.json` – production provider entry point pinned to the checked Convex deployment.
- `production-icon-boundary.ts` – fail-closed resolved-module and emitted-output checks for the HRA-local production icon adapter.
- `proxy.ts` – exact public/static exclusions from configured WorkOS authentication.
- `.env.example` – separated public WorkOS/Convex/Accounts origins, server-only OIDC custody, and Convex-only key material.
- `tsconfig.json` – strict Next.js and Convex TypeScript coverage.

# Guidelines

- Convex is authoritative for application-owned task state; UI projections come from validated queries and subscriptions.
- Render hosted and Direct task surfaces through `@hraness/agent-tasks-ui`; keep Convex subscriptions and mutations in the web-owned adapter.
- Render Direct through the shared `TaskWorkspace` and its backend-neutral props/action port. Do not mount WorkOS, Convex, generated APIs, or production provider adapters in the deterministic composition.
- Keep `@hraness/direct` development-only and its Vite graph separate from the production Next.js graph. Run the explicit Direct boundary check before production delivery.
- Label deterministic fixture evidence, mixed evidence, and direct provider/Convex evidence precisely; a browser scenario does not prove provider identity, tenant isolation, subscriptions, or transaction authority.
- Render a precise missing-configuration state when local Convex or WorkOS settings are absent.
- Keep provider secrets in Convex environment variables. Browser-visible configuration contains only public URLs and client identifiers.
- Parse all server, browser, and provider boundaries from `unknown`.
- Parse public deployment configuration through `@hra-internal/convex` before constructing the official client.
- Use the shared default-light appearance runtime and design roles from `@hra-internal/design-kit`; HRA app styles may add only hosted-shell aliases while task presentation stays in the shared UI package.
- Resolve shared icon entry points to the HRA-local SVG adapter for the Next.js graph, and reject Hugeicons module identifiers or emitted markers during every production build.
- Keep the authenticated control plane inside the persistent shared app shell. Workspace and Tasks/Access route state belongs in the query-addressed rail, and only the changing main stage animates.
- Keep `/` public and indexable without WorkOS or Convex client providers. Keep `/app` authenticated when WorkOS is configured, and send sign-in, sign-up, callback, organization-switch, and internal control-plane navigation back to that route.
- Keep hosted-environment credentials and provider-write configuration out of source control. `hra.sh` is the canonical public origin, and the normal build must not mutate Convex or a hosting provider.
- Permit remote Convex deployment only through the checked Vercel Production wrapper bound to `benevolent-akita-439`. Preview is an app-only client of its exact public endpoints and must reject every production credential, origin claim, or write capability.
- Keep `/download` as an exact public prerelease/source-build page. Retain authentication on near misses, and keep signing, notarization, artifact hosting, and release mutation authority outside the web application.
- Keep Hraness suite identity additive to the WorkOS human. The OIDC cookie secret belongs only in the web host, the HRA receipt HMAC keyring belongs only in Convex, and missing authority must leave linking unavailable.
- Keep public `test:local:convex` and `test:local:human` commands behind the repository's exclusive cross-worktree scheduler. Their `:uncoordinated` backings run only while that lease is held because both suites own the live local Convex deployment and the signed suite temporarily changes deployment-wide fixture settings.
- Keep `verify:direct` behind the repository's exclusive cross-worktree scheduler. Its fixed local port must never reuse a reachable server whose owning worktree is unknown; the `:uncoordinated` backing is internal to an already-held lease.
