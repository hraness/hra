# Contents

- `world.ts` – the strict versioned JSON fixture world and reusable HRA account/runtime, pathless project-add, and portable task-read records.
- `scenarios.ts` – one inferred Direct definition containing stable pane, browser-subscription, recovery, density, and transport scenarios plus the exact fixture/direct coverage boundary.
- `transport.ts` – deterministic implementation of the owned `RuntimeTransport` contract, including chunked snapshots, account and portable task dispatch correlation, scheduled-chat transitions, pathless shared-folder and project outcomes, local mutation-attempt recovery, authoritative task-state invalidations, and event scripts.
- `runtime.ts` – one session-owned composition of the deterministic transport through the real runtime bridge and shell, with atomic browser containment before product connection.
- `compact-chat-surface.tsx` – development-only deterministic image-preview and explicit clock/palette adapter around the production chat composition; live custody remains runtime integration evidence.
- `workbench.tsx` – browser-only scenario navigation, desktop frame, and activity reporting.
- `main.tsx` – the isolated React DOM entry that renders the real HRA `App` without Convex or native globals.
- `index.html` and `vite.config.ts` – a separate development document and `dist-direct` build graph.
- `reactive-baseline.html` and `reactive-baseline.tsx` – development-only instrumentation of the real product surface under the canonical Direct runtime and browser firewall.
- `check-production-boundary.ts` – product-owned forbidden-marker policy across renderer, gateway, Zig, Convex, and packaged production surfaces.
- `verify-browser.ts` – HRA probe, interactive pane-chat and subscription journey, responsive containment, coverage, console, network, and manifest policy over `@hraness/direct/tooling/browser-verification`.
- `*.test.ts` and `*.property.test.ts` – parser, catalog, bridge, chunking, recovery, browser-verifier policy, and generated round-trip evidence.

# Guidelines

- Keep this directory browser-only and development-only. Production frontend, gateway, Zig, native packaging, and Convex graphs must never import it.
- Drive the real `App`, `createRuntimeBridge`, `RuntimeShell`, contract parsers, chunk assembly, and projection through the owned `RuntimeTransport` seam. Do not fork product behavior into fixture components.
- Keep a negative-capability claim proving the renderer never observes trusted filesystem paths, worktrees, sessions, turns, items, interactions, usage, models, diagnostics, commands, transcripts, or output. Direct may exercise the pathless project-add outcome and portable task workspace/context/lookup seam, but cannot model private onboarding inputs or gateway-only internals.
- Keep the interactive product transport stateful; use the shared exact scripted transport in focused seam tests where exact request and event ordering is itself the claim.
- Keep every world value JSON-safe, strictly parsed from `unknown`, bounded, versioned, cloned, and deterministic. Unknown keys and inconsistent snapshot/event sequences fail closed.
- Model local mutation attempts with the same prepare, effect-started, non-destructive inspection, post-acceptance settlement, and reconciliation order as the runtime. Reusing a fingerprint may recover only its exact open attempt, and a settled attempt must not block a later deliberate command.
- Never mount `ConvexProvider`, call a Convex deployment, expose a native global, or permit an unmapped fetch. Keep Zig/native claims as explicit direct-verification gaps; add no Convex behavior claim until HRA owns a concrete cloud feature and its backend port.
- Give scenarios stable IDs and classify each coverage claim as `fixture`, `mixed`, or `direct`. Keep account isolation, malformed transport, sequence recovery, and gateway-private authority boundaries visible. Do not retain scenarios for controls the two-page product does not render.
- Browser journeys must cover the real two-page product: pathless shared-folder selection and pane creation; schedule removal, configuration, interpretation failure, draft preservation, and next-run status; settled configuration and debounced rename; active sanctioned reasoning and assistant Markdown with tool calls hidden; terminal completion-reconciled verified reasoning while raw or unverified terminal reasoning stays hidden; FIFO queue editing/removal/head steering; attachment preview/removal; elapsed duration; pinned active subagents; attention recovery; many-pane containment; browser-only subscription sign-in; and rendered layouts below both 640 and 416 pixels with text scaling applied. Keep raw HITL answers, task UI, private paths, and device-code setup absent.
- Parallel performance claims require concurrent active panes with interleaved scripted deltas plus deterministic sibling-isolation or bounded-responsiveness evidence. A large static pane fixture alone is density evidence, not performance evidence.
- A React StrictMode mount owns a fresh definition-backed session, transport, bridge, and shell. Register transport and shell teardown with the session, dispose the session with that mount, and count every asynchronous request or event script in the shared activity probe.
- Install the canonical browser bridge and fail-closed fetch boundary together during shell construction, before product effects can connect. Failed installation must dispose the session. Do not reconstruct manifests, probes, coverage snapshots, compatibility globals, or browser rollback locally.
- Browser verification must use `@hraness/direct/tooling/browser-verification` for process, exact v2 contract binding, server-lease, and artifact-publication mechanics; retain one catalog hash across the run; join a stable canonical probe; reject blocked or failed script activity; reject page/console errors and external or failed requests; and preserve screenshots plus a machine-readable manifest under ignored artifacts.
- Start the workspace Vite executable directly so the shared verifier owns the listener process, its exit, and its output pipes. Do not put a package-script wrapper between that process owner and Vite.
- Scan production boundaries with `@hraness/direct/tooling/bundle-boundary`. Keep the HRA marker, source-root, emitted-surface, and product-private renderer policies local.
