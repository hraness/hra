# Contents

- `discovery.ts` – validated site metadata, crawler, sitemap, manifest, and structured-data builders.
- `json-ld.tsx` – safely serialized JSON-LD script boundary.
- `social-image.tsx` – deterministic 1200×630 social-card response builder.
- `discovery.test.ts` – focused examples for public, private, URL, sitemap, manifest, and JSON-LD behavior.
- `index.ts` – primary package exports.

# Guidelines

- Accept absolute HTTPS origins and root-relative owned paths; reject credentials, queries, fragments, cross-origin URLs, duplicate sitemap paths, and invalid colors.
- Keep public metadata complete across canonical, Open Graph, Twitter, and indexability fields.
- Keep private metadata free of canonicals and social previews while applying page-level `noindex`.
- Escape JSON-LD for an HTML script context before rendering it.
- Keep social-image layout inline and deterministic so Vercel output tracing never depends on repository files. Its default presentation follows the neutral `plain-site` palette and sans-serif document voice; product-owned color is always an explicit theme override.
