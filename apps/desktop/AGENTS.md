<!-- kb:context scopes/projects-hra-apps-desktop--535675ca1b9e -->
# Contents

- `contracts/` – renderer-safe account, chat, task, projection, receipt, and generated Codex protocol contracts.
- `frontend/` – the production React/Vite pane interface and its separate browser-only Direct workbench.
- `runtime/` – the compiled Bun gateway, pinned portable runtimes, SQLite state, deterministic probes, and local development tools.
- `src/` – the Zig application identity, Native SDK runner, asynchronous gateway host, and macOS shell composition.
- `app.zon` – macOS application, window, frontend, navigation, and bridge policy.
- `build.zig` – reproducible native build and test graph.
- `package.json` – the desktop workspace commands and dependencies.
- `README.md` – public architecture, local development, data boundaries, and verification commands.
- `HARNESS.md` – the recursive Codex harness authority and storage model.

# Guidelines

- Target Apple Silicon macOS 13 and newer. Keep ordinary TypeScript builds, lint, and tests portable; keep native compilation behind explicit `*:macos` commands.
- Use the system WKWebView through Native SDK. Do not add Electron, a nested package manifest, or another lockfile.
- Keep `@native-sdk/cli` exactly pinned because its Zig framework is a compile-time dependency.
- Keep the renderer independent from native privileges and generated Codex types. Add a narrow owned contract only when a product feature needs one.
- Keep provider authority, persistence, account routing, local paths, tool details, and backend selection behind the gateway. The renderer receives only bounded HRA projections and app-owned commands.
- Keep `@hraness/direct` development-only and outside production renderer, gateway, Zig, and native dependency graphs.
- Run one isolated Codex app-server and one exact `CODEX_HOME` per account profile. Fence requests, events, login authority, interactions, and recovery by profile and durable process generation.
- Keep the compiled gateway responsible for hosted connections. Do not add Convex clients or deployment configuration to the renderer.
- Require a fresh launch nonce before a Debug host loads `http://127.0.0.1:5173/`. Release-shaped hosts use bundled `zero://app` assets.
- Bind each interactive pane to a repository selected through the trusted Native directory picker. Browser-only development has no Codex, arbitrary-filesystem, or local execution authority.
- Keep source builds independent from distribution credentials. Signing, notarization, official release creation, and publication are outside this public workspace.
- Run `bun run --cwd apps/desktop test`, `bun run --cwd apps/desktop typecheck`, `bun run --cwd apps/desktop lint`, and `bun run --cwd apps/desktop build` after desktop changes. Add `test:macos` or `build:macos` for native changes.
- Keep `verify:direct`, `build:macos`, and `test:macos` behind the repository resource scheduler. Their `:uncoordinated` commands are internal to an acquired lease.
