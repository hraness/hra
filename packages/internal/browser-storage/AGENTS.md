# Contents

- `src/` – typed localStorage and IndexedDB APIs with deterministic example and property tests.
- `package.json` – the private source-first production and test-helper surfaces plus direct workspace dependencies.
- `tsconfig.json` – strict browser-library compiler settings.
- `eslint.config.mjs` – the shared HRA lint configuration.

# Guidelines

- Keep the package framework- and product-neutral; product record schemas, retention policies, and migrations belong to consumers.
- Resolve browser storage only when an operation runs so importing the package during server rendering never touches `window`.
- Parse persisted values from `unknown`, validate reads and writes with consumer schemas or codecs, and return typed failures instead of throwing for unavailable or corrupt storage.
- IndexedDB migrations are a contiguous synchronous version chain, and successful writes wait for the transaction commit event.
- Never clear corrupt data implicitly or claim cross-tab coordination, encryption, synchronization, or product-owned retention semantics.
