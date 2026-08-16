# Contents

- `index.ts` – the injectable, SSR-safe, schema-validated local-storage record implementation.
- `index.test.ts` – deterministic behavior and failure examples.
- `index.property.test.ts` – arbitrary-input totality and valid-value round-trip laws.
- `indexed-db.ts` – the lazy, versioned, codec-validated IndexedDB transaction implementation and minimal injectable browser adapter.
- `indexed-db-test.ts` – the deterministic in-memory IndexedDB factory exported only through the package's test subpath.
- `indexed-db.test.ts` – deterministic migration, atomicity, commit, corruption, and failure examples.
- `indexed-db.property.test.ts` – arbitrary stored-value totality and multi-store transaction laws.

# Guidelines

- Depend only on the minimal `StorageLike` and `IndexedDbFactoryLike` contracts and inject them in tests.
- Treat JSON parsing, schema parsing, serialization, and browser access as separate fallible boundaries.
- Keep localStorage versions inside consumer-owned strict schemas, and keep IndexedDB migration steps consumer-owned and contiguous.
- Await IndexedDB transaction completion before reporting success, and abort the whole transaction after codec or callback failure.
- Do not add React hooks, global browser event listeners, background writes, or storage-wide clearing.
