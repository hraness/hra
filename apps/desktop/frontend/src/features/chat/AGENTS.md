# Contents

- `ChatPane.tsx` and `PaneGrid.tsx` – memoized draggable pane composition, inline title editing, bounded latest-turn presentation, durable message-queue controls, and pane-local scrolling.
- `CompactChatSurface.tsx` – dense composer, attachment previews, active-subagent stack, queue rows, elapsed clock, and explicit pane-identity palette helpers.
- `MarkdownResponse.tsx` – one isolated Streamdown boundary for safe static and streaming Markdown.
- `model.ts` – pure routes, command builders, external-store selectors, state presentation, input validation, identifiers, and title debouncing.
- `*.test.ts` and `*.property.test.ts` – focused UI contracts plus generated command, state, isolation, scrolling, queue, timer, and debounce laws.

# Guidelines

- Keep the product to the `#panes` and `#settings` surfaces. Add no task UI, workspace configuration, raw human-approval response, model selection, service-tier selection, reasoning-effort selection, or routing chrome here.
- Render only the app-owned bounded chat projection. Never inspect raw provider protocol values, private paths, credentials, usage details, full transcripts, command output, prompts from earlier turns, or provider reasoning.
- Render the active sanctioned reasoning summary and assistant response through the same safe Markdown boundary. Never render tool calls. Hide terminal reasoning until a durable completion receipt explicitly proves the summary complete; a terminal response alone is not that receipt.
- Treat `pane.messageQueue` as the only renderer queue authority. Enter enqueues with `queue`; Cmd/Ctrl+Enter may request atomic `steerHead` only for the exact active turn when the queue is empty. Preserve complete bounded text, FIFO order, queue and message revision fences, editing and removal, and steering only on the visible head.
- Keep `ambiguousEffect` non-resumable. Render its blocked message separately with neutral unknown-delivery wording and no edit, retry, or steer action. Discard uses the exact queue and message revisions and remains disabled until the owning turn is terminal or contained.
- Accept attachments only through the isolated frontend custody port until the gateway projection lands. Render only ready gateway-vended `blob:` previews, make removal explicit, and treat pasted images and file selection identically.
- Pin only active subagents in `starting`, `running`, or `waiting`. Do not derive an active overflow count from all durable descendants or add child actions to the compact stack.
- Use one visibility-aware coarse clock for all active elapsed timers. Stop it while the document is hidden, keep elapsed outside the transcript live region, and retain completed duration without an interval.
- Derive pane identity only from an explicit durable palette index through the shared golden-angle OKLCH scale. Do not infer identity from pane IDs or grid position.
- Subscribe to pane IDs once and to each pane through its own equality-checked external-store selector. Memoize pane containers and Markdown so one pane's stream does not rerender its siblings.
- Keep title edits inline and revision-bound. Debounce ordinary typing for 350 milliseconds, flush on blur or Enter, and allow at most one refresh-backed retry after a typed revision conflict. A pending save must preserve the title control's focus, and a failed save must refocus it with a visible, live, associated error.
- Route subscriptions automatically and configure them only in Settings; a pane must not expose or persist a manual account preference.
- Persist pane order through the runtime command/event boundary. Keep drag-and-drop and keyboard/menu reordering equivalent, and keep remote session-summary anchors fixed while local panes move among local slots.
- Label each pane and transcript log through stable `aria-labelledby` references. Shift+Enter inserts a newline, composition input never submits, and every action must work without hover. Preserve focus visibility, 44-pixel coarse-pointer targets, safe areas, forced colors, reduced motion, 200-percent text scaling, near-bottom-aware autoscroll, and pane-local containment down to 26rem.
- Keep destructive pane removal behind a menu item so an accidental single click cannot close a pane. Keep active-turn interruption directly available beside the composer.
