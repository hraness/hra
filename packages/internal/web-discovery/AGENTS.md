# Contents

- `src/` – typed Next.js metadata, crawler, sitemap, manifest, JSON-LD, and social-image helpers.
- `package.json` – source-first package exports and workspace commands.
- `tsconfig.json` – strict React and Next.js TypeScript configuration.
- `eslint.config.mjs` – shared repository lint configuration.

# Guidelines

- Keep this package product-neutral and limited to truthful search-discovery primitives shared by registered Next.js deployments.
- Model indexable and private surfaces explicitly; never use `robots.txt` as a substitute for page-level `noindex` or authentication.
- Keep canonical URLs, social metadata, sitemap entries, and structured data derived from one validated HTTPS origin.
- Emit only schema that represents visible page content. Do not add unsupported AEO markup, ratings, reviews, prices, authorship, or dates.
- Keep generated social cards deterministic, representative, readable, and free of remote assets or runtime filesystem dependencies.
- Preserve product-owned titles, descriptions, routes, update dates, and crawler decisions in each consuming workspace.
