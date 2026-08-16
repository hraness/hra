# Contents

- `main.tsx` and `design-route.ts` – React root, side-effect-free `/design` selection, lazy gallery boundary, minimal product styles, and explicit production runtime-shell factory.
- `design.tsx` and `design.test.tsx` – the lazy shared `/design` gallery, full-style boundary, and route/render contract.
- `App.tsx` – the settings-gated pane-chat shell, selected external-store state, and injected runtime-shell lifecycle.
- `features/chat/` – responsive pane grid, pane-local composer and stream, inline title editing, safe Markdown, and renderer-only interaction state.
- `features/accounts/` – lean subscription setup, browser sign-in, bounded remaining-capacity presentation, cancellation, reopen, logout removal, and focused static contracts.
- `runtime-bridge.ts` – the narrow typed Native SDK transport for account requests plus scoped portable task reads/mutations, immutable response assembly, and ordered invalidations.
- `runtime-bridge.test.ts` – renderer-side transport envelopes, response correlation/paging, event parsing, and private-command rejection examples.
- `ui-scale.ts` and `ui-scale.test.ts` – persistent app-owned text scaling, macOS keyboard shortcuts, and bounded parser examples.
- `index.css` – responsive macOS desktop presentation layered over only shared standalone design tokens and reset rules.

# Guidelines

- Represent environment and runtime availability as discriminated unions and exhaust every state in presentation code.
- Do not place privileged native operations, deployment secrets, or speculative product abstractions in the renderer.
- Treat the renderer as a consumer of the HRA-owned chat facade and lean subscription lifecycle. It may request the trusted pathless project chooser, configure app-owned panes, submit one bounded prompt to an app-owned turn, and begin or cancel browser sign-in. It must not inspect paths, provider sessions, provider thread/turn/item identifiers, queue or steer work, answer raw provider interactions, or expose device-code, runtime-management, removal, maintenance, or task-workspace controls.
- Accept runtime shells through a stable factory so StrictMode mounts own independent lifecycles; production explicitly passes native detection while browser labs pass an owned deterministic transport.
- Subscribe to runtime shell state through `useSyncExternalStore` selectors. Keep shell creation, connection, and disposal effect-owned, and do not mirror the root shell state through component `setState` callbacks.
- Disable mutations unless the global runtime snapshot is authoritative. Keep pending state and failures scoped to one pane or account so healthy siblings remain usable, and subscribe through pane-local equality selectors so one stream does not repaint the grid.
- Preserve keyboard focus, semantic landmarks, readable contrast, reduced-motion behavior, and layouts down to the manifest's minimum useful window size.
- Keep healthy accounts quiet. Show identity, authentication state, one bounded remaining-capacity percentage, and the small set of common account actions inline. Route panes automatically across signed-in subscriptions; never expose per-pane account selection, raw rate-limit windows, model catalogs, provider sessions, system versions, or backend diagnostics.
- Keep `/design` independent from the native runtime bridge so the browser verifier can exercise the shared system directly. Lazy-load its React graph and full stylesheet so Panes and Settings do not pay for gallery, charts, effects, Jelly, or unrelated recipes.
