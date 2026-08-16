# Contents

- `index.ts` – public projection exports for gateway integration.
- `projection.ts` – bounded renderer event queue, atomic global-snapshot capture, protected task invalidation/operation delivery, and backpressure.
- `reducer.ts` – pure account/readiness replay plus sequence-only scoped task invalidations over HRA-owned runtime contracts.

# Guidelines

- Keep generated Codex types outside this boundary; accept only HRA contract values or small owned adapter inputs.
- Preserve raw delta order and repeated content. Coalescing may concatenate adjacent replaceable deltas for at most 32 milliseconds, never content-deduplicate them.
- Measure batching deadlines with a monotonic clock; wall time is only for renderer-safe occurrence timestamps.
- Split delta envelopes on Unicode code-point boundaries below the Native window-event byte limit, and bound both queued event count and serialized UTF-8 bytes.
- Treat snapshot capture as a delivery barrier: buffer strictly later events until the snapshot response has been handed off.
- Restore durable chat panes directly into the first atomic snapshot before the gateway initialization barrier opens; never replay persisted pane clocks as revision-one live upserts.
- Re-sequence queued operation terminals and scoped task invalidations after a captured barrier because neither is represented by the global account snapshot.
- Store oversized snapshot-recoverable account, retained-local-data, entity, item, and delta state in the gateway snapshot, then emit only the corresponding `snapshot.invalidated` marker; renderer delivery must remain transport-sized.
- Never discard operation terminals or scoped task invalidations. Signal backpressure before applying an event when the bounded queue cannot retain it.
- Advance the one Native transport sequence for task invalidations while leaving task pages and details outside the global snapshot.
- Redact compatibility diagnostics before they enter snapshots or renderer events.
