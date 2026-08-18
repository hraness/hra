# Contents

- `projection.ts` – pure snapshot and ordered-event projection for runtime/runner readiness, accounts, bounded chat panes, retained-local-data tombstones, and sequence-only scoped task invalidations.
- `shell.ts` – transport lifecycle, atomic hydration, gap recovery, and UI-facing shell state.
- `use-runtime-shell-selector.ts` – stable React external-store fallback, server snapshot, selector, and equality caching.
- `index.ts` – the renderer integration surface for the runtime shell.
- `*.test.ts` – named sequencing, hydration, recovery, and malformed-boundary examples.
- `*.property.test.ts` – generated ordering, duplicate-delivery, and reconnect invariants.

# Guidelines

- Keep the projection pure and apply events in arrival order; never sort away a transport gap.
- Treat snapshots as atomic replacements and event sequence numbers as the only delivery identity.
- Treat `snapshot.invalidated` and `chat.messageQueue.changed` as mandatory rehydration signals; never advance the local sequence while an authoritative queue or oversized recoverable state remains absent.
- Parse transport values in the bridge before they reach this directory; do not import generated Codex protocol types.
- Do not import gateway-internal contracts or add paths, worktrees, provider identifiers, private interactions/runs, usage, model catalogs, diagnostics, command output, full transcripts, task pages, or task details. The only session-like state admitted here is the strict HRA-owned bounded chat-pane projection.
- Advance task invalidations on the shared Native sequence as account-snapshot no-ops; the task adapter consumes their portable workspace/scope/revision payload and refetches separately.
- Preserve the last trustworthy snapshot while reconnecting or failed so the UI can explain and recover from interruptions.
- Keep shell states discriminated and exhaustive, with reconnect available as an explicit user recovery action.
- Expose receiver-safe stable `getSnapshot` and `subscribe` callbacks. Isolate subscribers so one throwing listener cannot interrupt committed state or another listener.
- Read shell state in React through equality-checked selectors. Keep server and unavailable-runtime snapshots referentially stable, and exclude unrelated root revision fields from feature selections.
