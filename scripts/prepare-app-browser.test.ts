import { expect, test } from "bun:test";
import { assertBrowserDriverAst } from "./prepare-app-browser.ts";

const importNode = (value: string) => ({ type: "ImportDeclaration", source: { type: "StringLiteral", value } });
const tree = (...body: unknown[]) => ({ type: "Program", body: [importNode("playwright-core"), ...body] });

test("emitted driver closure admits only native Node and the three runtime dependencies", () => {
  expect(() => assertBrowserDriverAst(tree(importNode("node:http"), importNode("linkedom"), importNode("lightningcss")))).not.toThrow();
  for (const path of ["bun:ffi", "vite", "@hraness/ui/stylex-build", "./build-app.ts", "./other.mjs", "/private/source.ts"]) {
    expect(() => assertBrowserDriverAst(tree(importNode(path)))).toThrow();
  }
  expect(() => assertBrowserDriverAst({ type: "Program", body: [importNode("node:http")] })).toThrow("real installed Playwright");
  expect(() => assertBrowserDriverAst(tree({ type: "Identifier", name: "Bun" }))).toThrow("global Bun");
});

test("driver closure refuses computed imports and CommonJS or eval escape hatches", () => {
  for (const name of ["require", "eval"]) {
    expect(() => assertBrowserDriverAst(tree({ type: "CallExpression", callee: { type: "Identifier", name }, arguments: [] }))).toThrow();
  }
  expect(() => assertBrowserDriverAst(tree({ type: "ImportExpression", source: { type: "Identifier", name: "runtimePath" } }))).toThrow();
  expect(() => assertBrowserDriverAst(tree({ type: "CallExpression", callee: { type: "Import" }, arguments: [{ type: "Identifier", name: "runtimePath" }] }))).toThrow();
  expect(() => assertBrowserDriverAst(tree({ type: "ImportExpression", source: { type: "StringLiteral", value: "playwright-core" } }))).not.toThrow();
});
