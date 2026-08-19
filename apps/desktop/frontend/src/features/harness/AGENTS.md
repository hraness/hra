# Contents

- `HarnessSettings.tsx` – described recursive-session and refinement settings, shared semantic switch control, bounded context quota, and read-only proposal titles.
- `HarnessSettings.test.tsx` – sparse renderer, command, and private-boundary contracts.

# Guidelines

- Keep harness controls inside the existing Settings page and keep ordinary panes free of persistent harness chrome.
- Render only bounded HRA-owned summaries. Never expose provider IDs, paths, transcripts, heap values, program bodies, trial internals, or arbitrary commands.
- Fence settings by exact revisions. Active child summaries are read-only; Suggest mode may record proposals, but the renderer has no child-action, review, decision, evaluation, activation, or rollback authority.
- Preserve the valid settings relationship in the UI: Suggest requires recursive sessions, and turning recursive sessions off submits refinement Off in the same revision-fenced command.
- Expose no model or speed policy controls. HRA owns recursive and ordinary service-tier routing outside renderer settings.
- Keep proposals read-only and render only their bounded titles. Render active children as compact bounded summaries in the owning pane without Open or Stop commands.
