import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { transform } from "lightningcss";

test("the remaining stylesheet owns only six document and semantic alias foundations", async () => {
  const css = await readFile(new URL("styles.css", import.meta.url));
  const selectors: unknown[] = [];
  const media: unknown[] = [];
  let tokenBindings = 0;
  transform({ filename: "site/styles.css", code: css, visitor: { Rule: {
    style(rule) {
      selectors.push(rule.value.selectors);
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
    media(rule) { media.push(rule.value.query); },
  } } });
  const root = [[{ type: "pseudo-class", kind: "root" }]];
  const html = [[{ type: "type", name: "html" }]];
  expect(selectors).toEqual([
    root, [[{ type: "universal" }]], html, [[{ type: "type", name: "body" }]],
    [[{ type: "pseudo-class", kind: "where", selectors: [
      [{ type: "class", name: "hraness-marketing-page" }], [{ type: "class", name: "hraness-marketing-header" }],
    ] }]], html,
  ]);
  expect(tokenBindings).toBe(1);
  expect(media).toEqual([
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
  ]);
  expect(imports).not.toMatch(/tailwind|components\.css|palettes\.css|@hraness\/[^"\n]+\/styles\.css|https?:/u);
});
