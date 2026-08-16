# Contents

- `index.mjs` – typed JavaScript/TypeScript flat config and shared safety rules.
- `next.mjs` – Next.js flat config composed with the same safety rules.
- `package.json` – config exports, implementation dependencies, and peers.

# Guidelines

- Shared rules should catch correctness failures or enforce one durable repository convention, not encode personal formatting taste.
- Framework presets extend the base safety policy without silently weakening it.
- Keep parser project roots relative to the workspace executing ESLint.
