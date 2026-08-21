# Contents

- `design/` – the shared static browser-component gallery mounted at `/design`.
- `layout.tsx` – inheritable site-wide document defaults and the concrete light SSR fallback used until the System-first appearance bootstrap resolves.
- `providers.tsx` – shared appearance/router composition around the optional WorkOS and Convex providers.
- `analytics.ts` and `analytics-provider.tsx` – strict canonical-public-route classification and anonymous, cookieless PostHog pageview delivery.
- `workos-configuration.ts` – one whitespace-safe WorkOS configuration predicate shared by proxy, auth routes, layout providers, and the `/app` configuration state.
- `global-error.tsx`, `error.tsx`, `loading.tsx`, and `not-found.tsx` – shared, themed route-state boundaries, including the root-layout replacement. `loading.tsx` stays heading-free so streamed public HTML cannot grow a second H1. `not-found.tsx` owns a distinct noindex title and must not inherit the homepage canonical.
- `standalone-theme-header.tsx` – the single final header appearance action shared by configuration, loading, missing-route, signed-out, and recoverable standalone states.
- `page.tsx` – canonical public landing page. It owns the homepage title, description, canonical `/`, indexable robots, matching social titles, product capabilities, boundaries, public-source entry points, and an honest analytics disclosure.
- `alternatives/` – public, dated, first-party-sourced comparisons that explain HRA's fit without inventing competitor limitations.
- `app/page.tsx` – authenticated WorkOS/Convex control-plane entry and exact local missing-configuration states.
- `download/` – public macOS prerelease status and source-build guidance.
- `admin-shell.tsx` – authenticated human identity and agent lifecycle supervision inside the persistent rail, shared Hraness footer identity, suite-account status, final top-bar appearance action, and query-addressed Tasks/Access stages.
- `suite-account-control.tsx` and `suite-account-protocol.ts` – same-origin central OIDC session control, strict receipt parsing, explicit WorkOS-human linking, and verified plan status.
- `api/suite-auth/` – exact shared OIDC relying-party catch-all with encrypted server-only token custody and fail-closed configuration.
- `convex-task-workspace-adapter.tsx` – authenticated Convex subscriptions and human commands mapped into the shared task-workspace port.
- `hosted-task-workspace-source.ts` – strict atomic roots, immutable continuations, scoped change-feed replay, and fenced human mutations behind the provider-free task client.
- `hosted-mutation-attempt-journal.ts` – the SDK journal adapter for authenticated, principal-scoped Convex mutation recovery without persisted intent payloads.
- `hra-icon-data.ts` and `hra-icon-runtime.tsx` – HRA-owned geometric SVG data and the production renderer used in place of the shared Hugeicons runtime.
- `task-run-boundary.ts` – strict provider-to-portable run projection mapping that keeps reply bindings out of shared UI props.
- `convex-task-workspace-adapter.test.ts` – deterministic pagination, capability, and browser-boundary mapping tests.
- `convex-task-workspace-adapter-ui.test.tsx` – accessible loading, error, capped-count, and actor-identity adapter tests.
- `globals.css` – HRA-specific dense task, identity, and shell composition over shared design roles.
- `globals-css.test.ts` – scroll-clearance and low-noise hosted-shell regressions around shared Jelly cards.

# Guidelines

- Keep route components focused on human supervision: work readiness, task state, agent identity, leases, and review.
- Keep `/` public and indexable without mounting WorkOS or Convex. Keep `/app` behind the configured WorkOS proxy and preserve its server-rendered configuration failures before the authenticated control plane mounts.
- Keep `/download` honest about prerelease status. Link only to the exact public GitHub release contract in `site.ts`, disclose ad-hoc signing and missing notarization before the action, and never embed signing credentials or publication authority in the web app.
- Keep `/alternatives` and its exact static child routes public. Date each review, cite current first-party sources, distinguish “not documented” from “absent,” and write product-specific analysis rather than name-swapped SEO pages.
- Limit analytics to one personless, cookieless `$pageview` on `/`, `/download`, `/alternatives`, and the exact comparison routes accepted by `isHraPublicComparisonPath`. Require exact Production `https://hra.sh`, use only the slim no-external SDK entry, redact query, fragment, referrer, identity, account, task, command, and provider context, and keep every other event and route inert.
- Build public and private discovery output with `@hraness/web-discovery`, while keeping HRA-owned origins, titles, descriptions, routes, dates, JSON-LD facts, and crawler choices in `site.ts` and the route that presents them. Keep homepage identity off the root layout. Keep HTML titles aligned with Open Graph titles.
- Consume task presentation and state from `@hraness/agent-tasks-ui`; keep every Convex, WorkOS, and generated-API import in hosted adapters.
- Use `@hra-internal/codex-app-sdk` for provider-neutral client and mutation-journal contracts. Keep Convex authority, tenant scoping, HMAC derivation, and browser lifecycle composition in this app.
- Keep React on one immutable task-client snapshot. Effect setup owns fresh hosted sources and clients; scoped feed patches preserve continuations only after an exact-head proof.
- Resolve the transient semantic digest to a server-keyed, tenant/principal/source-bound HMAC before entering the generic mutation journal. Preserve that opaque fingerprint exactly across prepare, reads, and transitions. Prepare before effect, mark immediately before the command, and settle only a definitive authority result. Retain ambiguous attempts with their exact idempotency key, HRA operation ID, and supplied task ID. Never persist the browser digest, raw intent, answers, transcript, or provider data.
- Starting, remounting, and projection retry never execute a pending mutation. A terminal journal row is a durable tombstone and is absent from open recovery; only a later explicit UI dispatch may create fresh controls for the same semantic action.
- Default selectable appearance to System while server-rendering `data-theme="light"` and paired light/dark `theme-color` media metadata as the concrete pre-bootstrap fallback. Suppress only the expected theme attribute hydration difference and preserve explicit persisted Light/Dark/System choices. Every ordinary selectable page provides exactly one icon-menu selector as its final/rightmost header action; global error and non-HTML surfaces remain control-free.
- Keep `AppShell`, `NavigationRail`, top bars, and rail controls mounted while query-addressed workspace/surface content changes; animate only the main stage and close the accessible mobile drawer on its navigation key.
- Keep the canonical Hraness lockup in the shared rail footer so desktop and mobile-drawer shells expose the same identity. Keep appearance selection out of the duplicated rail and in the persistent top bar.
- Consume shared foundation colors, type, spacing, controls, route states, and overlays directly. Reserve product chroma for explicit human/agent identity, runner state, task status, recovery, and review evidence.
- Treat dense master/detail panes, editors, and operational data or action rows as flat structural regions aligned to the workspace gutter, using separators instead of rounded enclosing containers. Reserve rounded cards for sparse repeated objects, compact standalone summaries, feedback, and overlays.
- Never visually conflate a human actor, persistent agent identity, credential, or process session.
- Preserve keyboard operation, semantic headings, visible focus, and text alternatives while adding interactions.
- Keep secrets and raw bearer material out of React props, browser storage, rendered errors, and URLs.
- Treat suite identity as plan-status metadata for the authenticated WorkOS human. Require the Convex HMAC proof/receipt boundary for linking, and never use a central session or feature array to grant an organization, membership, role, workspace, agent, or runner capability.
- Enable task dispatch only from server-derived, non-expired runner readiness for the selected repository. Render only protocol-bounded reasoning summaries, assistant messages, anonymous tool activity, semantic run phases, and stop authority; never invent or infer raw reasoning or tool detail.
