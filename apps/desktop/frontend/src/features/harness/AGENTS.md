# Contents

- `HarnessSettings.tsx` – described recursive-session, bounded automatic Fast, and refinement settings, shared semantic switch control, and read-only proposal titles.
- `HarnessSettings.test.tsx` – sparse renderer, command, and private-boundary contracts.

# Guidelines

- Keep harness controls inside the existing Settings page and keep ordinary panes free of persistent harness chrome.
- Render only bounded HRA-owned summaries. Never expose provider IDs, paths, transcripts, heap values, program bodies, trial internals, or arbitrary commands.
- Fence settings and child actions by exact revisions. Suggest mode may record proposals, but the renderer has no review, decision, evaluation, activation, or rollback authority.
- Preserve the valid settings relationship in the UI: Suggest requires recursive sessions, and turning recursive sessions off submits refinement Off in the same revision-fenced command.
- Describe automatic Fast as an HRA recursive-turn policy. Keep it visibly distinct from each ordinary pane's manual Fast control.
- Keep proposals read-only and render only their bounded titles. Child Open and Stop remain compact accessible icon controls in the owning pane.
