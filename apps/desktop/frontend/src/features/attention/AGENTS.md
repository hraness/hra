# Contents

- `AttentionDrawer.tsx` – accessible read-only header control, minimized grouped rows, completeness states, and refresh lifecycle.
- `AttentionDrawer.test.tsx` – presentation, accessibility, privacy, and quiet-state evidence.

# Guidelines

- Render only the canonical attention projection. Never recover task details, queue text, setup transcripts, account identity, provider/session identifiers, paths, or commands in this feature.
- Keep task, chat, account, and recovery state read-only. The one allowed effect is the exact revision-fenced workspace-setup approval carried by its canonical attention item.
- Keep complete empty state quiet. Partial task/cloud states must say that local attention remains available without implying cloud freshness.
- Preserve keyboard dismissal, trigger focus restoration, semantic group headings, readable counts, and narrow-window containment.
