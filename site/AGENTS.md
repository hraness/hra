# Contents

- `content.ts` is the shared public content contract for README and website generation.
- `template.ts` renders the homepage and privacy page.
- `analytics-site.ts` defines the exact production host, route taxonomy, and event vocabulary.
- `analytics-entry.ts` is the self-hosted browser entry that initializes bounded PostHog capture.
- Tests enforce semantic, privacy, analytics, and command parity.

# Guidelines

- Lead with the real install command and the shortest successful first-run path.
- Keep the site free of server runtime dependencies, responsive, keyboard-readable, and useful when its nonessential analytics JavaScript does not run.
- Render the canonical `@hraness/site-footer` markup and styles on every navigable HTML page. Keep the inert iframe preview free of links and other actions, and keep HRA project resources outside the footer.
- State beta, platform, provider, privacy, and account-switch compatibility limits beside the relevant feature.
- Keep analytics anonymous, cookieless, memory-only, production-host-gated, and limited to the exact site-owned route vocabulary. Do not add remote scripts, persistent browser analytics state, remote fonts, or a build-time network dependency.
- Keep `hra.sh` focused on the HRA product. Do not publish adjacent tool summaries, comparison-shaped pages, or generic search-targeted essays unless a named reader job and a non-obvious HRA-specific answer justify a durable indexable route.
- Before admitting an editorial route, score reader utility, original evidence, factual confidence, host fit, voice integrity, and maintenance value from 0–2. Require at least 9/12 and no zero; traffic potential, word count, and a content quota do not count as value.
- Ground factual claims in checked primary sources or exact HRA release evidence. Do not synthesize a first-person opinion, experience, endorsement, or certainty that no named human supplied.
- Every admitted editorial route must record an owner, source-check date, reassessment date within 60 days, and an explicit keep, revise, redirect, or remove lifecycle decision. Remove a route cleanly from navigation, discovery, structured data, and generated artifacts when it no longer clears the gate.
- Images follow an admitted reader job; they never justify one. Use the `editorial-image-seo` skill for future editorial imagery and keep visible figures, captions, responsive assets, metadata, schema, feeds, sitemaps, and provenance synchronized.
- Keep the product homepage's command-line social card.
