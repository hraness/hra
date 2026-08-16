# Contents

- `hraness-brand.tsx` – one-color current-color Ra mark and canonical linked Hraness footer lockup.
- `styles.css` – shared Geist lockup sizing and presentation.
- `hraness-brand.test.tsx` – server-rendered geometry, accessibility, and link regressions.
- `index.ts` – public React surface.

# Guidelines

- Keep the Ra mark cutouts transparent rather than surface-colored.
- Keep a standalone mark decorative by default and optionally named through `title`.
- Keep the mark decorative inside the named lockup so assistive technology announces `hraness` once.
- Preserve the exact lowercase wordmark and canonical `https://hraness.com` destination.
- Let consumers control surrounding footer layout; this package owns only the mark and lockup.
