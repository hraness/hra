import { expect, test } from "bun:test";
import { createStylexTransformCollector } from "@hraness/ui/stylex-build";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const root = fileURLToPath(new URL("..", import.meta.url));
type RecipeFile = "docs.stylex.ts" | "product-preview.stylex.ts";
const cache = new Map<string, Promise<string>>();

function cssFor(file: RecipeFile, slot: string): Promise<string> {
  const key = `${file}:${slot}`;
  let compiled = cache.get(key);
  if (compiled !== undefined) return compiled;
  compiled = (async () => {
    const path = fileURLToPath(new URL(file, import.meta.url));
    const source = await readFile(path, "utf8");
    const parsed = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    for (const statement of parsed.statements) {
      if (!ts.isVariableStatement(statement)) continue;
      for (const declaration of statement.declarationList.declarations) {
        if (!ts.isIdentifier(declaration.name) || declaration.name.text !== "styles") continue;
        const call = declaration.initializer;
        if (call === undefined || !ts.isCallExpression(call)) throw new Error("Expected static styles");
        const object = call.arguments[0];
        if (object === undefined || !ts.isObjectLiteralExpression(object)) throw new Error("Expected finite slots");
        const recipe = object.properties.find((property) => ts.isPropertyAssignment(property)
          && ts.isIdentifier(property.name) && property.name.text === slot);
        if (recipe === undefined) throw new Error(`Missing ${key}`);
        // Compile the actual slot through the production public collector.
        // A class name or successful build alone does not prove that a CSS
        // declaration survived unsupported shorthand handling.
        const prefix = source.slice(0, statement.getStart(parsed));
        const result = await createStylexTransformCollector(root).transform(
          `${prefix}\nexport const isolated = stylex.create({${recipe.getText(parsed)}});`, path,
        );
        expect(result.code).not.toContain("stylex.inject(");
        return result.rules.map(([, rule]) => rule.ltr).join("\n").replaceAll(/\s+/gu, "");
      }
    }
    throw new Error(`Missing style collection for ${file}`);
  })();
  cache.set(key, compiled);
  return compiled;
}

async function border(file: RecipeFile, slot: string, sides: readonly string[], width: string): Promise<void> {
  const css = await cssFor(file, slot);
  for (const side of sides) {
    expect(css).toContain(`border-${side}-width:${width}`);
    if (width !== "0") {
      expect(css).toContain(`border-${side}-style:solid`);
      expect(css).toContain(`border-${side}-color:var(--rule)`);
    }
  }
}

const allSides = ["top", "right", "bottom", "left"];

test("docs emit intended control borders and typography instead of browser defaults", async () => {
  for (const slot of ["search", "details", "relatedLink"]) await border("docs.stylex.ts", slot, allSides, "1px");
  for (const slot of ["searchResults", "section"]) await border("docs.stylex.ts", slot, ["bottom"], "1px");
  await border("docs.stylex.ts", "pageNav", ["top"], "1px");
  const search = await cssFor("docs.stylex.ts", "search");
  expect(search).toContain("font-family:inherit");
  expect(search).toContain("font-size:inherit");
  expect(await cssFor("docs.stylex.ts", "layout")).toContain("@media(max-width:52rem)");
});

test("real-UI frames have no native border and their controls preserve selected state", async () => {
  await border("product-preview.stylex.ts", "frame", allSides, "0");
  for (const slot of ["figure", "dialog"]) await border("product-preview.stylex.ts", slot, allSides, "1px");
  await border("product-preview.stylex.ts", "toolbar", ["bottom"], "1px");
  for (const slot of ["caption", "expandedCaption"]) await border("product-preview.stylex.ts", slot, ["top"], "1px");
  const button = await cssFor("product-preview.stylex.ts", "button");
  for (const side of allSides) {
    expect(button).toContain(`border-${side}-width:1px`);
    expect(button).toContain(`border-${side}-style:solid`);
    expect(button).toContain(`border-${side}-color:transparent`);
    expect(button).toContain(`:is([aria-pressed="true"]){border-${side}-color:var(--rule)}`);
  }
  expect(await cssFor("product-preview.stylex.ts", "figure")).toContain("scroll-margin-top:5rem");
  expect(await cssFor("product-preview.stylex.ts", "viewport")).toContain("@media(max-width:48rem)");
});

test("the expanded dialog restores centering after the document resets native margins", async () => {
  const dialog = await cssFor("product-preview.stylex.ts", "dialog");
  for (const side of allSides) expect(dialog).toContain(`margin-${side}:auto`);
});
