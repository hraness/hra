# Contents

- `main.tsx` renders real app screens and primitives for browser acceptance.
- `io.ts` supplies bounded deterministic observations and rejects commands.
- `config.ts` owns the closed transport and custody replacement list.

# Guidelines

- Compile through the production app's public StyleX graph, shell, and finalizer. Do not replace presentation, recipes, reducers, or model derivation.
- Keep every fixture offline and non-authoritative. Never use credentials, contact a provider, or persist account data. Reject unhandled live IO at build time.
- Exercise long history, multiple cards, native modal and sheet variants, disabled controls, directionality, and media preferences through actual production components.
- Keep fixture entry points outside production builds and package contents. Preserve browser evidence separately from reproducible profiles.
