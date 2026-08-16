# Contents

- `src/` – strict public Convex deployment URL parsing and its tests.
- `package.json` – the source-first package contract and focused verification commands.

# Guidelines

- Keep this package independent of the Convex client, React, app frameworks, and Direct.
- Accept deployment configuration as `unknown` and return a total discriminated union; never throw for foreign configuration.
- Live products may construct official Convex clients only after a `ready` result.
- Deterministic surfaces inject product-owned backend ports; do not emulate Convex WebSocket, cache, database, or transaction semantics here.
- Add shared Convex helpers only after at least two products prove the same framework-neutral contract.
- Keep provider deployment commands, credentials, project identifiers, and release authority out of this package.
