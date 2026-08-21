# Contents

- `src/` – portable human authentication schemas, strict typed HTTP transport, browser desktop pairing, session refresh coordination, and secret-custody contracts.
- `package.json` – the source-first `@hraness/hra-human-client` workspace and its focused verification commands.

# Guidelines

- Keep this package product-private and portable across the HRA CLI and HRA desktop gateway.
- Keep Bun, Native, SQLite, filesystem, Convex, React, and generated deployment types outside the production graph.
- Treat a missing account as signed out without performing network access.
- Keep refresh tokens inside authentication and custody boundaries; expose only redacted, static diagnostics.
- Parse every HTTP, metadata, and custody value from `unknown`, reject redirects and cross-origin URLs, and bound response bytes and request time.
- Serialize refresh rotation and use generation-checked custody so stale writers cannot replace newer credentials.
