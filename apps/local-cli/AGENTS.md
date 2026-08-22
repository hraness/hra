# Contents

- `src/` – strict command parsing, fixed owner-private desktop discovery, bounded AF_UNIX transport, stable JSON output, and focused tests.
- `package.json`, `tsconfig.json`, and `eslint.config.mjs` – the desktop-owned `hra` executable workspace and its checks.

# Guidelines

- Keep this CLI separate from product-neutral `taskctl`. It observes only the local desktop and never imports hosted-task credentials or clients.
- Accept only documented read commands. Do not add endpoint, socket, capability, profile, path, provider, or mutation overrides.
- Discover only the fixed production and source-development locations. Verify leaf directory, capability file, and socket ownership, mode, type, identity, and no-link invariants before connecting.
- Keep stdout as one canonical JSON value for successful commands. Send usage and closed error codes to stderr without local paths, capabilities, provider details, or private content.
- Treat the observation capability as read-only generation authority. Never log, persist, echo, or reuse it for a writer protocol.
