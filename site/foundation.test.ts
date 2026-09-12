import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { transform, type StyleRule } from "lightningcss";

// These sealed 0.6.4 descendants cannot receive public class overrides. Admit
// only the reviewed preset bindings, in addition to the six original rules.
const compatibilityCss = `
:root[data-hraness-marketing-preset] .hraness-marketing-header {
  --hraness-marketing-measure: var(--hraness-marketing-header-measure);
}
:root[data-hraness-marketing-preset] .hraness-marketing-page {
  --hraness-marketing-background: transparent;
}
:root[data-hraness-marketing-preset] .hraness-marketing-hero__heading {
  font-weight: var(--hraness-marketing-display-weight, 400);
  line-height: var(--hraness-marketing-h1-leading, 1.05);
  letter-spacing: var(--hraness-marketing-h1-tracking, -.025em);
}
:root[data-hraness-marketing-preset] :where(.hraness-marketing-section__heading, .hraness-marketing-trust__heading, .hraness-marketing-questions__heading, .hraness-marketing-maker__heading, .hraness-marketing-cta__heading) {
  font-weight: var(--hraness-marketing-display-weight, 400);
  line-height: var(--hraness-marketing-h2-leading, 1.15);
  letter-spacing: var(--hraness-marketing-h2-tracking, -.012em);
}
:root[data-hraness-marketing-preset] .hraness-marketing-hero__summary {
  line-height: var(--hraness-marketing-summary-leading, 1.55);
}
:root[data-hraness-marketing-preset] .hraness-marketing-header__inner {
  min-block-size: var(--hraness-marketing-header-height, 3.5rem);
}
:root[data-hraness-marketing-preset] .hraness-marketing-header .hraness-marketing-action {
  min-block-size: var(--hraness-marketing-header-action-height, var(--hraness-marketing-action-height, 2.625rem));
}
:root[data-hraness-marketing-preset] .hraness-marketing-header-surface {
  background-color: var(--hraness-marketing-header-background, var(--background));
  -webkit-backdrop-filter: var(--hraness-marketing-header-backdrop, none);
  backdrop-filter: var(--hraness-marketing-header-backdrop, none);
}
:root[data-hraness-marketing-preset] .hraness-marketing-header .hraness-marketing-action {
  min-block-size: 3rem;
}
`;

test("the stylesheet keeps six foundations and only nine exact preset compatibility rules", async () => {
  const css = await readFile(new URL("styles.css", import.meta.url));
  const compatibilitySelectors: StyleRule["selectors"][] = [];
  const compatibilityDeclarations: StyleRule["declarations"][] = [];
  transform({ filename: "compatibility-contract.css", code: Buffer.from(compatibilityCss), visitor: { Rule: {
    style(rule) {
      compatibilitySelectors.push(rule.value.selectors);
      compatibilityDeclarations.push(rule.value.declarations);
    },
  } } });
  expect(compatibilitySelectors).toHaveLength(9);
  const selectors: unknown[] = [];
  const declarations: unknown[] = [];
  const media: unknown[] = [];
  let tokenBindings = 0;
  transform({ filename: "site/styles.css", code: css, visitor: { Rule: {
    style(rule) {
      selectors.push(rule.value.selectors);
      declarations.push(rule.value.declarations);
      expect(rule.value.declarations.importantDeclarations).toEqual([]);
      const selector = rule.value.selectors[0]?.[0];
      if (selector?.type === "pseudo-class" && selector.kind === "where") {
        tokenBindings++;
        expect(rule.value.declarations.declarations).toHaveLength(10);
        for (const declaration of rule.value.declarations.declarations) {
          expect(declaration.property).toBe("custom");
          if (declaration.property !== "custom") throw new Error("Component declaration escaped into token bindings.");
          expect(declaration.value.name).toMatch(/^--hraness-marketing-/u);
        }
      }
    },
    media(rule) {
      media.push(rule.value.query);
      if (media.length === 1) {
        // The larger target must remain inside the sole coarse-pointer query.
        expect(rule.value.rules).toHaveLength(1);
        const target = rule.value.rules[0];
        expect(target?.type).toBe("style");
        if (target?.type !== "style") throw new Error("Coarse-pointer action rule is missing.");
        expect(target.value.selectors).toEqual(compatibilitySelectors[8]!);
        expect(target.value.declarations).toEqual(compatibilityDeclarations[8]);
      }
    },
  } } });
  const root = [[{ type: "pseudo-class", kind: "root" }]];
  const html = [[{ type: "type", name: "html" }]];
  expect(selectors).toEqual([
    root, [[{ type: "universal" }]], html, [[{ type: "type", name: "body" }]],
    [[{ type: "pseudo-class", kind: "where", selectors: [
      [{ type: "class", name: "hraness-marketing-page" }], [{ type: "class", name: "hraness-marketing-header" }],
    ] }]], ...compatibilitySelectors, html,
  ]);
  expect(declarations.slice(5, -1)).toEqual(compatibilityDeclarations);
  expect(tokenBindings).toBe(1);
  expect(media).toEqual([
    ["pointer", "coarse"],
    ["prefers-reduced-motion", "reduce"],
  ].map(([name, value]) => ({ mediaQueries: [{ qualifier: null, mediaType: "all", condition: {
    type: "feature", value: { type: "plain", name, value: { type: "ident", value } },
  } }] })));
});

test("the static entry joins compiler foundations and local fonts without legacy component CSS", async () => {
  expect(await readFile(new URL("foundation.ts", import.meta.url), "utf8")).toBe('import "./foundation.css";\n');
  const imports = await readFile(new URL("foundation.css", import.meta.url), "utf8");
  expect(imports.trim().split("\n")).toEqual([
    '@import "@hraness/design-kit/compiler-foundation.css";',
    '@import "@hraness/design-kit/fonts.css";',
    '@import "@hraness/site-footer/compiler-foundation.css";',
    '@import "@hraness/design-kit/paper-theme.css";',
    '@import "./styles.css";',
    '@import "./vendor/marketing-preset/product-marketing-preset.css";',
  ]);
  expect(imports).not.toMatch(/tailwind|components\.css|palettes\.css|@hraness\/[^"\n]+\/styles\.css|https?:/u);
});
