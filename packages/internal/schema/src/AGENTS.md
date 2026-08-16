# Contents

- `index.ts` – public schema seam and parse helpers.
- `index.test.ts` – deterministic boundary examples.
- `index.property.test.ts` – totality across arbitrary JSON.

# Guidelines

- Parse from `unknown` and retain structured errors when callers need diagnostics.
- Any new parser helper must remain total over arbitrary input and have property coverage.
