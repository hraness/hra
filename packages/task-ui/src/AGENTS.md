# Contents

- `task-workspace.tsx` – the backend-neutral task graph, run, interaction, evidence, and review surface.
- `task-workspace-state.ts` – the shared read model, action port, reducer, recovery language, and pure presentation helpers.
- `task-workspace-model.ts` – the provider-free external-store task client, projection coordination, immutable paging, and intent synchronization.
- `use-task-workspace-selector.ts` – equality-aware React selection over the headless task client store.
- `task-workspace-fixtures.ts` and `fixtures.ts` – deterministic non-production examples exposed only through the fixture subpath.
- `styles.css` – self-contained task presentation layered over shared design-kit semantic roles.
- `index.ts` – the production package surface.
- `*.test.ts`, `*.test.tsx`, and `*.property.test.ts` – component, state, style, and law verification.

# Guidelines

- Keep every production input backend-neutral and foreign values out of the component boundary until an authority adapter validates them.
- Keep source authority generations separate from durable projection revisions. Install only coherent bundles, and bind continuations to one exact coordinate, source generation, and revision.
- Keep the headless client React-free. React may select snapshots but must not own source requests, paging cursors, mutation synchronization, or revision floors.
- Keep fixtures out of the root production export.
- Preserve keyboard operation, semantic headings, live-region behavior, visible focus, and distinct local-owner, human, agent, and system identity.
- Keep public phase and event copy backend-neutral and execution-mode-neutral. Stable `worktree.*` event kinds must render as execution-workspace activity rather than claiming every run owns a worktree.
- Use `task-` selectors for local presentation and `jungle-visually-hidden` for accessible hidden copy.
- Keep CSS variables on canonical design-kit roles so consumers need no hosted-app aliases.
