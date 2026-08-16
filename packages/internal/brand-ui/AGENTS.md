# Contents

- `src/` – reusable Hraness identity artwork, linked footer lockup, styles, and server-rendered tests.
- `package.json` – source-first React and CSS package surface.
- `tsconfig.json` – strict React TypeScript configuration.
- `eslint.config.mjs` – shared repository lint configuration.

# Guidelines

- Keep this package limited to shared visual identity used by more than one product.
- Keep the Ra mark one-color, current-color, and transparent through its sun and eye cutouts.
- Render the canonical lowercase `hraness` word in Geist through the shared design-kit text role.
- Use the linked lockup only at real identity or footer boundaries; product navigation and copy remain product-owned.
- Keep mark geometry vector-native and server-renderable without masks, raster assets, client state, or generated identifiers.
