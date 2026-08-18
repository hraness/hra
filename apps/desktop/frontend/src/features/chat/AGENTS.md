# Contents

- `ChatPane.tsx` and `PaneGrid.tsx` – memoized draggable pane composition, inline title editing, read-only root-route status, bounded active-turn presentation, and pane-local scrolling.
- `MarkdownResponse.tsx` – isolated Streamdown rendering for safe static and streaming Markdown.
- `model.ts` – pure routes, command builders, external-store selectors, state presentation, input validation, identifiers, and title debouncing.
- `*.test.ts` and `*.property.test.ts` – focused UI contracts plus generated command, state, isolation, scrolling, and debounce laws.

# Guidelines

- Keep the product to the `#panes` and `#settings` surfaces. Add no task, workspace, queue, steering, or human-approval interface here.
- Render only the app-owned bounded chat projection. Never inspect raw provider protocol values, private paths, credentials, usage details, full transcripts, command output, or earlier turns.
- Show active reasoning summaries, provider-neutral tool categories, and the streaming response. Once settled, retain only the latest assistant response and re-enable the composer after attention or failure.
- Subscribe to pane IDs once and to each pane through its own equality-checked external-store selector. Memoize pane containers and Markdown so one pane's stream does not rerender its siblings.
- Keep title edits inline and revision-bound. Debounce ordinary typing for 350 milliseconds, flush on blur or Enter, and allow at most one refresh-backed retry after a typed revision conflict. A pending save must preserve the title control's focus, and a failed save must refocus it with a visible, live, associated error.
- Expose no model, reasoning-effort, service-tier, or routing control. Show only the bounded active or latest per-turn HRA dispatch route, distinguish requested from selected profile and tier in its accessible name, and describe fallback as HRA pre-effect resolution rather than observed provider compliance. Keep unresolved routes neutral and preserve the accessible route name when compact layout hides its auxiliary visual label.
- Route subscriptions automatically and configure them only in Settings; a pane must not expose or persist a manual account preference.
- Persist pane order through the runtime command/event boundary. Keep drag-and-drop and keyboard/menu reordering equivalent, and keep remote session-summary anchors fixed while local panes move among local slots.
- Label each pane and transcript log through stable `aria-labelledby` references. Enter submits, Shift+Enter inserts a newline, and composition input never submits. Preserve focus visibility, reduced motion, near-bottom-aware autoscroll, and pane-local overflow at compact and wide viewports.
- Keep destructive pane removal behind a menu item so an accidental single click cannot close a pane. Keep active-turn interruption directly available.
