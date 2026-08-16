import { expect, test } from "bun:test";

const [plainSiteCss, publicationCss, stylesCss] = await Promise.all([
  Bun.file(new URL("./plain-site.css", import.meta.url)).text(),
  Bun.file(new URL("./plain-publication.css", import.meta.url)).text(),
  Bun.file(new URL("./styles.css", import.meta.url)).text(),
]);
const packageManifest = await Bun.file(
  new URL("../package.json", import.meta.url),
).json() as { exports?: Record<string, string> };

test("plain-site exposes one compact, product-neutral site shell", () => {
  for (const selector of [
    ".plain-header",
    ".plain-header__inner",
    ".plain-wordmark",
    ".plain-nav",
    ".plain-footer",
    ".plain-footer__links",
  ]) {
    expect(plainSiteCss).toContain(selector);
  }

  expect(plainSiteCss).toContain("--plain-shell-measure: 34rem;");
  expect(plainSiteCss).toMatch(
    /\.plain-page\s*\{[^}]*inline-size:\s*100%;[^}]*max-width:\s*var\(--plain-shell-measure\);/su,
  );
  expect(plainSiteCss).toContain("max-width: var(--plain-shell-measure);");
  expect(plainSiteCss).toMatch(
    /\.plain-footer\s*\{[^}]*flex-wrap:\s*wrap;/su,
  );
  expect(plainSiteCss).toMatch(
    /@media \(pointer: coarse\)\s*\{[\s\S]*?\.plain-site\s*\{[^}]*--plain-link-target-min:\s*var\(--interactive-target-min, 48px\);/u,
  );
  expect(plainSiteCss).toMatch(
    /:root\[data-verification-pointer="coarse"\] \.plain-site\s*\{[^}]*--plain-link-target-min:\s*var\(--interactive-target-min, 48px\);/su,
  );
  expect(plainSiteCss).toMatch(
    /\.plain-nav a,[\s\S]*?\.plain-footer__links a\s*\{[^}]*min-block-size:\s*var\(--plain-link-target-min\);[^}]*min-inline-size:\s*var\(--plain-link-target-min\);/u,
  );
  expect(plainSiteCss).toMatch(
    /\.plain-footer :where\(a\)\s*\{[^}]*color:\s*inherit;[^}]*display:\s*inline-flex;[^}]*min-block-size:\s*var\(--plain-link-target-min\);[^}]*min-inline-size:\s*var\(--plain-link-target-min\);/u,
  );
  expect(plainSiteCss).toMatch(
    /\.plain-footer:has\(\.jungle-jelly-surface\)\s*\{[^}]*padding-top:\s*var\(--space-6\);[^}]*padding-right:\s*max\(var\(--plain-shell-gutter\), var\(--space-6\), env\(safe-area-inset-right\)\);[^}]*padding-bottom:\s*max\(var\(--space-6\), env\(safe-area-inset-bottom\)\);/su,
  );
  expect(plainSiteCss).toMatch(
    /\.plain-site main:has\(> \.design-gallery\[data-design-gallery-nested="true"\]\)\s*\{[^}]*padding-inline:\s*max\(var\(--plain-shell-gutter\), var\(--space-6\)\);/su,
  );
  expect(plainSiteCss).toContain("env(safe-area-inset-right)");
  expect(plainSiteCss).toContain("env(safe-area-inset-left)");
  expect(plainSiteCss).toContain("@media (max-width: 42rem)");
  expect(plainSiteCss).toContain("@media (forced-colors: active)");
});

test("plain chrome preserves resolved themes, safe areas, and semantic link roles", () => {
  expect(plainSiteCss).not.toMatch(
    /\.plain-site\s*\{[^}]*\bcolor-scheme\s*:/su,
  );
  expect(plainSiteCss).toMatch(
    /\.plain-header__inner\s*\{[^}]*--plain-header-block-padding:\s*1\.15rem;[^}]*padding-top:\s*max\(\s*var\(--plain-header-block-padding\),\s*env\(safe-area-inset-top\)\s*\);[^}]*padding-bottom:\s*var\(--plain-header-block-padding\);/su,
  );
  expect(plainSiteCss).toMatch(
    /@media \(max-width: 42rem\)\s*\{[\s\S]*?\.plain-header__inner\s*\{[^}]*--plain-header-block-padding:\s*1rem;[^}]*\}/u,
  );

  expect(plainSiteCss).toContain(
    ":where(.plain-header a, .plain-page a, .plain-footer a)",
  );
  expect(plainSiteCss).toContain(
    ".plain-site :where(\n  .plain-header a:focus-visible,",
  );
  expect(plainSiteCss).toMatch(
    /\.plain-wordmark\s*\{[^}]*color:\s*var\(--plain-foreground\);/su,
  );
  expect(plainSiteCss).toMatch(
    /\.plain-nav a,[\s\S]*?\.plain-footer__links a\s*\{[^}]*color:\s*var\(--plain-muted\);/u,
  );
  expect(publicationCss).toContain(
    ":where(.plain-site.plain-publication a:not(.jungle-skip-link))",
  );
  expect(publicationCss).not.toMatch(
    /^\.plain-site\.plain-publication a:not\(\.jungle-skip-link\)/mu,
  );
});

test("plain-publication adds a complete long-form grammar without product identity", () => {
  for (const selector of [
    ".plain-site.plain-publication",
    ".plain-publication__shell",
    ".plain-publication__index-content",
    ".plain-publication__entry",
    ".plain-publication__article-header",
    ".plain-publication__article-layout",
    ".plain-publication__article-body",
    ".plain-publication__toc",
    ".plain-publication__callout",
    ".plain-publication__table-scroll",
    ".plain-publication__sources",
    ".plain-publication__related-grid",
  ]) {
    expect(publicationCss).toContain(selector);
  }

  expect(publicationCss).toContain("--plain-shell-measure: 43rem;");
  expect(publicationCss).toContain(
    ":where(.plain-site.plain-publication a:not(.jungle-skip-link))",
  );
  expect(publicationCss).not.toMatch(
    /\.plain-site\.plain-publication a\s*\{/u,
  );
  expect(publicationCss).toMatch(
    /\.plain-site\.plain-publication\s*\{[^}]*min-height:\s*100vh;[^}]*min-height:\s*100svh;[^}]*min-height:\s*100dvh;/su,
  );
  expect(publicationCss).toContain("line-height: 1.7;");
  expect(publicationCss).toMatch(
    /\.plain-site\.plain-publication \.plain-publication__toc\s*\{[^}]*position:\s*static;/su,
  );
  expect(publicationCss).toMatch(
    /:root\[data-verification-pointer="coarse"\][\s\S]*?\.plain-publication__entry h3 a,[\s\S]*?\.plain-publication__primary-link,[\s\S]*?\.plain-publication__related-grid > a[\s\S]*?\{[^}]*display:\s*flex;[^}]*min-block-size:\s*var\(--interactive-target-min, 48px\);[^}]*min-inline-size:\s*var\(--interactive-target-min, 48px\);/u,
  );
  expect(publicationCss).toContain("@media (forced-colors: active)");
  expect(publicationCss).not.toMatch(/rgnrte|mbira|research-site/iu);
  expect(publicationCss).not.toMatch(/(?:linear|radial|conic)-gradient/iu);
});

test("the complete browser stylesheet includes the publication extension", () => {
  expect(packageManifest.exports?.["./plain-publication.css"]).toBe(
    "./src/plain-publication.css",
  );
  expect(stylesCss).toContain('@import "./plain-site.css";');
  expect(stylesCss).toContain('@import "./plain-publication.css";');
  expect(stylesCss.indexOf("plain-site.css")).toBeLessThan(
    stylesCss.indexOf("plain-publication.css"),
  );
});
