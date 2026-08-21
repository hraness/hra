# Contents

- `src/` – provider-neutral task identity, client intents, commands, events, projections, promotion contracts, and pure laws.
- `package.json` – source-first `@hraness/agent-tasks-domain` export and focused checks.
- `tsconfig.json` – strict leaf-package TypeScript configuration.

# Guidelines

- Depend only on `@hra-internal/schema`; transport, storage, identity-provider, and runtime adapters consume this package, never the reverse.
- Keep public identifiers, authority, task state, revisions, client intents, commands, receipts, events, projection bundles, promotion records, and pure graph, review, dispatch, display, and interaction laws closed and provider-neutral.
- Do not import Convex, identity-provider SDKs, HTTP envelopes, bearer tokens, cryptography, runner election, lease scheduling, filesystem, SQLite, or generated provider types.
- Parse foreign values from `unknown`, preserve discriminated unions, and fail closed at graph, revision, replay, terminal, and promotion boundaries.
