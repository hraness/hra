# Contents

- `desktop/` – the macOS Native SDK shell, Codex account runtime, and local session dashboard.
- `web/` – the HRA Next.js task control plane, authoritative Convex backend, and `hra.sh` Vercel root.
- `cli/` – the non-interactive `taskctl` client used by humans and agents.
- `local-cli/` – the desktop-owned, read-only `hra` client for minimized local attention and pane observation.

# Guidelines

- Every direct child is a private Bun workspace with a unique package name and its own platform configuration.
- Keep `@hraness/hra` as the canonical desktop workspace, `@hraness/hra-web` as the web workspace, `@hraness/hra-cli` as the `taskctl` workspace, and `@hraness/hra-local-cli` as the local `hra` workspace.
- Only `web/` is connected to Vercel. Desktop distribution uses the Native SDK macOS packaging path, `taskctl` uses its checked standalone build, and local `hra` ships as a desktop-owned executable.
- Keep web subscriptions and human interaction in `web/`; keep local Codex/provider custody in `desktop/`; keep hosted-task shell parsing, credential custody, and HTTP transport in `cli/`; keep `local-cli/` read-only and bound to the owner-private desktop observation channel.
- Share hosted-task wire validators, scopes, and errors through `../packages/task-protocol`. Share only minimized, pathless desktop observation through `../packages/local-observation-protocol`.
