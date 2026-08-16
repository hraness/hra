<!-- kb:context scopes/packages-design-kit-src--8d750f62c53c -->
# Contents

- `index.ts`, `tokens.css`, and parity/property tests – private typed roles and the CSS bridge from public `--ui-*` semantics to legacy compatibility aliases, typography, motion, elevation, breakpoints, layout, and theme selection.
- `styles.css`, reset, typography, components, charts, Jelly, gallery, plain-site, plain-publication, and ZO v2 layers – the browser barrel and its opt-in or shared presentation families.
- `syntax-highlighting.*` and tests – the typed framework-neutral server highlighter, semantic code theme, hostile-input examples, and source-preservation laws.
- `effects.css` and `react/` – decorative fields plus the browser-only component, appearance, shell, interaction, and gallery implementation.
- `fonts.css`, `fonts/`, and vendor tests – OFL face declarations and immutable local Geist and Geist Mono assets with checked ownership.

# Guidelines

- Compose `@hraness/ui` tokens, reset rules, and component recipes instead of copying them. Keep the private CSS and TypeScript forms of the legacy color, type, spacing, radius, motion, elevation, breakpoint, layout, transport, and stacking aliases synchronized.
- Keep light values at the CSS root and dark values under both `[data-theme="dark"]` and `.dark`. Reduced-motion CSS zeroes shared duration and movement tokens, tooltips clear modal and persistent-chrome layers, and skip links remain the highest shared interaction layer.
- Keep reset and shared component selectors low-specificity, product-neutral, and safe across projects. Presentation tones are semantic; product names, routing, domain copy, and domain state mapping stay outside shared CSS and recipes.
- Keep shared charts honest to their visual grammar: bars compare one unit from a common baseline, radar plots compare a small number of multi-metric profiles, and range plots distinguish spread from median. Preserve a nonvisual exact-value representation whenever SVG geometry carries meaning.
- Keep exact visual-viewport roots free of content-driven minimum block sizes. Use dynamic viewport units after stable fallbacks, make nested grid and flex tracks shrinkable, and require explicit descendant ownership for scrolling.
- Keep `body.plain-site` as a natural-height document column: its direct `main` consumes spare viewport height, `.plain-footer` stays at its intrinsic height along the bottom edge, and genuinely tall content extends the document instead of scrolling inside a nested region.
- Keep `.plain-header`, `.plain-header__inner`, `.plain-wordmark`, `.plain-nav`, `.plain-footer`, and `.plain-footer__links` as the product-neutral compact public-site shell. Let `--plain-shell-measure` and `--plain-shell-gutter` coordinate its measure with `.plain-page` and opt-in extensions.
- Keep plain-site chrome compact for fine pointers, but expand wordmark, navigation, footer, and publication-entry destinations to the shared minimum target under real coarse pointers and the deterministic coarse-pointer verification seam. Inline prose links remain native text. Jelly-bearing footers and nested design galleries reserve at least half a Jelly canvas of edge clearance through the shared shell instead of product route exceptions.
- Keep `.plain-publication` as a product-neutral extension of `.plain-site`: it owns one 43rem sourced-publication measure plus index, article, table, citation, callout, and related-reading rhythm. Product names, research claims, routes, and product modifier classes stay in consumers.
- Let ordinary prose and intrinsic media break or shrink inside the available inline size. Use wrapping composition contracts for mixed inline controls; do not use hidden overflow, a document minimum width, or ellipsis to conceal responsive layout failure.
- Keep raw custom-element registration behind the SSR-safe React loader. Shared wrappers own Jelly host markup, events, fallback presentation, and clipping; every canvas-facing `--jelly-radius` is resolved to CSS pixels.
- Preserve focus-visible, selected, hovered, pressed, invalid, disabled, entering, and exiting state hooks. Typography and decoration retain legible fallbacks, opt out safely under forced colors, and stop motion when requested.
- Keep text-clipped chrome on one opaque gradient without `background-blend-mode`. Font fallback stacks use ordinary system faces without carrying metrics across unrelated fonts.
- Keep heading typography on the semantic heading token so prose can retain its proportional sans face while product and gallery headings share the vendored Geist Mono face.
- Keep deterministic procedural geometry bounded and serializable from an explicit nonblank seed and safe-integer variation. Preserve `var(--background)` at the root and keep decoration hidden from assistive technology and pointer input.
- Keep syntax-language support finite and strongly typed. Unknown aliases fall back to text, highlighted markup escapes hostile input, and its text content exactly equals the source.
