# Contents

- `world.ts` – the strict, bounded, versioned JSON world for task queues, details, scripts, and diagnostics, anchored to the shared fixture clock.
- `scenarios.ts` – one inferred Direct definition containing stable Agent Tasks scenarios, the default, viewport metadata, and explicit fixture, mixed, and direct coverage claims.
- `runtime.tsx` – the session-owned stateful deterministic adapter implementing the real `TaskWorkspace` props and actions port.
- `mount.ts` – failure-atomic session and browser ownership that remains safe under React effect replay.
- `workbench.tsx` and `workbench.css` – isolated framing around the real task surface after containment is active.
- `appearance-bootstrap.ts`, `index.html`, and `main.tsx` – the development-only classic pre-module appearance bootstrap, frozen receipt, and React handoff.
- `vite.config.ts`, `build.ts`, and `verify-built-appearance.ts` – the separate `dist-direct` graph, generated-bootstrap build, and built-HTML asset and ordering proof.
- `verify-browser.ts` – bounded browser evidence for first paint, representative commands, recovery, pagination, responsive layout, quiescence, and network containment.
- `check-production-boundary.ts` – product-owned source and emitted-asset marker policy.
- `*.test.ts` and `*.property.test.ts` – deterministic world, catalog, adapter, verifier-policy, and boundary evidence.

# Guidelines

- Keep this directory development-only. Production Next.js entries, Convex functions, and provider adapters must never import it.
- Import `TaskWorkspace`, `TaskWorkspaceProps`, and `TaskWorkspaceActions` from `@hraness/agent-tasks-ui`, and deterministic examples only from its `/fixtures` subpath; do not fork task presentation or controls.
- Keep the lab on the same shared System-first Light/Dark/System appearance runtime and adaptive first-paint browser chrome as production while retaining its visibly labeled evidence workbench and concrete light SSR fallback. Preserve the generated classic head bootstrap, its frozen pre-module receipt, the built-HTML verifier, and opposing-OS browser evidence for initial background, `data-theme`, and `theme-color`. The full workbench owns one `ThemeMenuButton` as the final toolbar action; embedded frame-only and diagnostic states stay control-free.
- Never mount Convex Auth, `ConvexProvider`, `ConvexTaskWorkspaceAdapter`, or contact a deployment. This lab replaces the backend-neutral workspace port, not authentication or database protocols.
- Keep worlds strict, bounded, versioned, JSON-safe, cloned, and deterministic. Reject unknown keys, prototype-pollution keys, duplicate identities, inconsistent selections, and mismatched scripts.
- Use exact ordered scripts for commands whose request, conflict, and state transition are part of the claim. Unexpected or exhausted requests must remain verifier-visible violations.
- Count asynchronous commands in the shared activity probe. Browser verification must join a stable quiescent revision and reject pending work, blocked requests, violations, page errors, console errors, and unexpected network traffic.
- Keep activation, store, logical time, activity, manifest, probe, coverage, cancellation, and teardown in one definition-backed session. Install the canonical bridge and fail-closed fetch boundary together from that session; do not duplicate wire schemas or evidence status rules.
- Browser verification must use `@hraness/direct/tooling/browser-verification` to atomically bind the v2 schema, `scenario` source, requested ID, product route, and matching activation hashes, and it must retain one catalog hash across the run.
- Start the workspace Vite executable directly so the shared verifier owns the listener process, its exit, and its output pipes. Do not put a package-script wrapper between that process owner and Vite.
- Give scenarios stable IDs and classify every claim as `fixture`, `mixed`, or `direct`. Convex Auth password sessions, tenant selection, browser-approved desktop pairing, Convex subscriptions, and production mutation semantics remain direct evidence.
- Scan source and emitted `.next` assets with `@hraness/direct/tooling/bundle-boundary` after production builds. The product owns its marker policy. Exclude only `production-icon-boundary.ts`, which is verification tooling that imports the shared scanner; keep every production source and emitted asset in scope.
