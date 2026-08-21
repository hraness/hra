# Contents

- `src/` – the backend-neutral headless task client, React task workspace, state/action port, deterministic fixtures, styles, and colocated verification.
- `package.json` – the source-first public entry points for production UI, fixtures, and CSS.

# Guidelines

- Keep the production graph provider-free: no Next.js, Convex, identity-provider SDKs, Native, SQLite, filesystem, generated API, or transport-adapter imports.
- Consume task projection literals, local-owner actors, runs, interactions, and response contracts directly from `@hraness/agent-tasks-domain`; use protocol only for hosted runner-presence data that remains cloud-specific.
- Keep provider effects behind `TaskWorkspaceSource`. The shared client owns coordinate changes, coherent projection installation, paging, invalidation floors, and mutation synchronization.
- Export reusable production UI and state only from the package root; keep deterministic examples behind `@hraness/agent-tasks-ui/fixtures`.
- Keep the shared stylesheet self-contained over `@hra-internal/design-kit` semantic tokens and namespace task-local selectors.
- Treat React and React DOM as peer runtimes so hosted and desktop consumers own one renderer.
