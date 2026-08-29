# Contents

- `content.ts` is the shared public content contract for README and website generation.
- `editorial-images.ts` is the typed registry for reading banners, cards, metadata, schema, and image sitemap entries.
- `editorial-provenance/` retains reviewed generation prompts, completed Atet jobs, and immutable receipts; it is never copied to the public site.
- `images/editorial/` contains the promoted, visually reviewed reading images.
- `template.ts` renders the homepage, privacy page, and standalone reading pages.
- Tests enforce semantic and command parity.

# Guidelines

- Lead with the real install command and the shortest successful first-run path.
- Keep the site dependency-free at runtime, responsive, keyboard-readable, and useful without JavaScript.
- Render the canonical `@hraness/site-footer` markup and styles on every navigable HTML page. Keep the inert iframe preview free of links and other actions, and keep HRA project resources outside the footer.
- State beta, platform, provider, privacy, and account-switch compatibility limits beside the relevant feature.
- Do not add analytics, cookies, remote fonts, or a build-time network dependency in v1.
- Use the `editorial-image-seo` skill for every new reading image. Generate through its pinned retry-disabled Atet helper, make at most one paid call per distinct brief, and stop rather than retrying an ambiguous result.
- Review each candidate at original size and at its smallest card size before promotion. Prefer semantic editorial metaphors to generated factual architecture, capability, or security diagrams.
- Add reading imagery only through `editorial-images.ts`; keep the provenance-bound 1536-pixel original canonical for Open Graph, Twitter, schema, and sitemap use, and serve locally derived 384- and 768-pixel WebP files through `srcset` in visible figures and cards. Keep the visible figure and caption, homepage and `/reading/` cards, Open Graph and Twitter tags, `Article.image`, and image sitemap synchronized from that registry. Retain the exact prompt, completed job, receipt, and output SHA-256 in repository evidence without exposing provenance paths or job IDs in public output.
- Keep the product homepage's command-line social card. Editorial banners belong to reading pages and reading-card surfaces, not ordinary product documentation.
