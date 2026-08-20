# Contents

- `main.tsx` – the product-only React root and explicit production runtime-shell factory.
- `App.tsx` – the settings-gated pane-chat shell, pathless global folder-access header, selected external-store state, and injected runtime-shell lifecycle.
- `ui.tsx` and `production-module-boundary.test.ts` – the minimal HRA-owned React Aria control adapter and the fail-closed production bundle dependency contract.
- `features/chat/` – responsive pane grid, pane-local composer and stream, inline title editing, safe Markdown, and renderer-only interaction state.
- `features/accounts/` – lean subscription setup, browser sign-in, bounded remaining-capacity presentation, cancellation, reopen, logout removal, and focused static contracts.
- `runtime-bridge.ts` – the narrow typed Native SDK transport for account requests plus scoped portable task reads/mutations, immutable response assembly, and ordered invalidations.
- `runtime-bridge.test.ts` – renderer-side transport envelopes, response correlation/paging, event parsing, and private-command rejection examples.
- `ui-scale.ts` and `ui-scale.test.ts` – persistent app-owned text scaling, macOS keyboard shortcuts, and bounded parser examples.
- `index.css` – responsive macOS desktop presentation layered over only shared standalone design tokens and reset rules.

# Guidelines

- Represent environment and runtime availability as discriminated unions and exhaust every state in presentation code.
- Do not place privileged native operations, deployment secrets, or speculative product abstractions in the renderer.
- Treat the renderer as a consumer of the HRA-owned chat facade and lean subscription lifecycle. It may request the trusted pathless shared-folder and project choosers, configure or remove a pane schedule, enqueue bounded chat messages, and begin or cancel browser sign-in. It must not inspect paths, provider sessions, provider thread/turn/item identifiers, answer raw provider interactions, or expose device-code, runtime-management, maintenance, or task-workspace controls.
- Project the global execution policy as full filesystem access, automatic review, and required Computer Use. The runtime proves Computer Use separately for each provider thread before admitting chat work. The header renders only shared-folder display metadata and never a filesystem path.
- Accept runtime shells through a stable factory so StrictMode mounts own independent lifecycles; production explicitly passes native detection while browser labs pass an owned deterministic transport.
- Subscribe to runtime shell state through `useSyncExternalStore` selectors. Keep shell creation, connection, and disposal effect-owned, and do not mirror the root shell state through component `setState` callbacks.
- Disable mutations unless the global runtime snapshot is authoritative. Keep pending state and failures scoped to one pane or account so healthy siblings remain usable, and subscribe through pane-local equality selectors so one stream does not repaint the grid.
- Preserve keyboard focus, semantic landmarks, readable contrast, reduced-motion behavior, and layouts down to the manifest's minimum useful window size.
- Keep healthy accounts quiet. Show identity, authentication state, one bounded remaining-capacity percentage, and the small set of common account actions inline. Admit new work only to an eligible signed-in subscription, never continue usage-limited work on another subscription, and never expose per-pane account selection, raw rate-limit windows, model catalogs, provider sessions, system versions, or backend diagnostics.
- Keep the production root product-only. Exercise shared design recipes through Direct, and reject Hugeicons or design-kit React module IDs from every emitted production chunk.
