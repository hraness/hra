# Contents

- `src/index.ts` – the only shared Zod import seam plus typed parse helpers.
- `src/index.test.ts` – concrete parsing examples.
- `src/index.property.test.ts` – parser-totality laws.
- `package.json` – dependencies on shared Result and cataloged Zod.

# Guidelines

- Consumers import `z`, `parseOption`, and `parseResult` from `@hra-internal/schema`, never directly from Zod.
- Schemas belong at I/O, persistence, configuration, and other trust boundaries; internal domain functions use ordinary TypeScript types.
- Owned complete shapes should normally use strict objects. Loose foreign objects first narrow through `isRecord` and field checks when a complete schema would be dishonest.
