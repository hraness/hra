# Contents

- `desktop/` – the macOS Native SDK shell, Codex account runtime, and local session dashboard.
- `web/` – the HRA Next.js task control plane, authoritative Convex backend, and `hra.sh` Vercel root.
- `cli/` – the non-interactive `taskctl` client used by humans and agents.

# Guidelines

- Every direct child is a private Bun workspace with a unique package name and its own platform configuration.
- Keep `@hraness/hra` as the canonical desktop workspace, `@hraness/hra-web` as the web workspace, and `@hraness/hra-cli` as the source CLI workspace.
- Only `web/` is connected to Vercel; desktop distribution uses the Native SDK macOS packaging path and CLI distribution uses its checked standalone build.
- Keep web subscriptions and human interaction in `web/`; keep local Codex/provider custody in `desktop/`; keep shell parsing, local credential custody, and HTTP transport in `cli/`.
- Share only stable wire validators, scopes, and error contracts through `../packages/task-protocol`.
