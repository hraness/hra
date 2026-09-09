# Contents

- `content.ts` is the shared public content contract for README and website generation.
- `docs-content.ts` owns the task-oriented guide registry, canonical Markdown exports, detailed reference ownership, and individual editorial admission records.
- `template.ts` renders the homepage, privacy page, and six documentation routes.
- `marketing.tsx` composes public design-kit server components; `render.ts` is the captured build-time entry for all nine HTML routes.
- `product-preview.tsx` renders inert real-UI frames and their accessible parent controls. `product-scenes.ts` is their closed public scene catalog; Direct itself stays in the separately built fixture app.
- `site-entry.ts` progressively enhances scene selection, enlargement, local guide search, and moved reference fragments without authentication or persistence.
- `appearance-menu.tsx` reexports the pure native header menu owned alongside its static recipe in `app/src/components/appearance-menu*`. The shared app appearance bootstrap drives it; the preview remains a fixed, inert Catppuccin dark surface.
- `presentation.stylex.ts` and `marketing.stylex.ts` own local component recipes. `foundation.ts` is the build-only CSS entry; `foundation.css` joins approved document foundations and public fonts, without importing legacy component styles. The empty entry chunk stays private.
- `analytics-site.ts` defines the exact production host, route taxonomy, and event vocabulary.
- `analytics-entry.ts` is the self-hosted browser entry that initializes bounded PostHog capture.
- Tests enforce semantic, privacy, analytics, and command parity.

# Guidelines

- Lead the homepage with the product and actual interface. Lead the installation guide with the real install command and the shortest safe first-run path. Keep startup restrictions adjacent to affected commands.
- Keep the site free of server runtime dependencies, responsive, keyboard-readable, and useful when its nonessential analytics JavaScript does not run.
- Keep palette initialization in a classic same-origin head script and ship palette recipes through the captured StyleX union and its foundation bridge. Appearance stores only a bounded palette/mode preference; analytics remains memory-only. Never add executable inline scripts, runtime style injection, or a CSP exception for appearance.
- Compile local recipes through the public UI build API. Publish completed HTML, stylesheet unions, captured foundations, approved WOFF2 files and attribution, the bounded parent enhancement bundle, and the closed product-preview projection. Keep renderer JavaScript and build receipts private. Use `bun run test:site` for the scoped test transform.
- Render the canonical `@hraness/site-footer` markup and styles on every navigable HTML page. Keep `/preview/` free of links and other actions. The separately sandboxed real-UI examples refuse all IO and remain inert. Keep HRA project resources outside the footer.
- State beta, platform, provider, privacy, and account-switch compatibility limits beside the relevant feature.
- Keep analytics anonymous, cookieless, memory-only, production-host-gated, and limited to the exact site-owned route vocabulary. Do not add remote scripts, persistent browser analytics state, remote fonts, or a build-time network dependency.
- Keep `hra.sh` focused on the HRA product. Do not publish adjacent tool summaries, comparison-shaped pages, or generic search-targeted essays unless a named reader job and a non-obvious HRA-specific answer justify a durable indexable route.
- Before admitting an editorial route, score reader utility, original evidence, factual confidence, host fit, voice integrity, and maintenance value from 0–2. Require at least 9/12 and no zero; traffic potential, word count, and a content quota do not count as value.
- Ground factual claims in checked primary sources or exact HRA release evidence. Do not synthesize a first-person opinion, experience, endorsement, or certainty that no named human supplied.
- Every admitted editorial route must record an owner, source-check date, reassessment date within 60 days, and an explicit keep, revise, redirect, or remove lifecycle decision. Remove a route cleanly from navigation, discovery, structured data, and generated artifacts when it no longer clears the gate.
- Images follow an admitted reader job; they never justify one. Use the `editorial-image-seo` skill for future editorial imagery and keep visible figures, captions, responsive assets, metadata, schema, feeds, sitemaps, and provenance synchronized.
- Keep the product homepage's command-line social card.
