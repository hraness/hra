# Contents

- `content.ts` is the shared public content contract for README and website generation.
- `template.ts` renders the homepage, privacy page, and standalone reading pages.
- Tests enforce semantic and command parity.

# Guidelines

- Lead with the real install command and the shortest successful first-run path.
- Keep the site dependency-free at runtime, responsive, keyboard-readable, and useful without JavaScript.
- Render the canonical `@hraness/site-footer` markup and styles on every HTML page. Keep HRA project resources outside the footer.
- State beta, platform, provider, privacy, and account-switch compatibility limits beside the relevant feature.
- Do not add analytics, cookies, remote fonts, or a build-time network dependency in v1.
