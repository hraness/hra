import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import fc from "fast-check";
import { getDesignPaletteTheme } from "@hraness/design-kit";
import { compilerSha256, stylexUnionPolicySha256 } from "@hraness/ui/stylex-build";
import { APP_CSS_PLACEHOLDER } from "./build-app.ts";
import { PRODUCT_PREVIEW_BASE, PRODUCT_PREVIEW_CSP, PRODUCT_PREVIEW_CSS_HREF, prepareProductPreviewShell, projectProductPreviewArtifacts, snapshotProductPreviewGraph } from "./build-product-preview.ts";

const hash = (value: Uint8Array | string): string => createHash("sha256").update(value).digest("hex");
const planSha256 = hash("preview-plan");
const entry = "/fixture/app/fixtures/product/main.tsx";
const htmlTag = '<html lang="en" data-theme="dark">';
const themedTag = `<html lang="en" data-theme="dark" data-palette="catppuccin" class="${getDesignPaletteTheme("catppuccin", "dark").className}">`;
const shell = `<!doctype html>${htmlTag}<head><meta http-equiv="Content-Security-Policy" content="${PRODUCT_PREVIEW_CSP}"><title>Oompa example</title></head><body><div id="root"></div><script type="module" src="/src/main.tsx"></script></body></html>`;
const sourceEntry = '<script type="module" src="/src/main.tsx"></script>';

function bundle() {
  return { output: [
    { code: "export{};", facadeModuleId: entry, fileName: "assets/main-abc.js", isEntry: true, map: null, type: "chunk" },
    { code: "export const lazy=1;", fileName: "assets/lazy-def.js", isEntry: false, map: null, type: "chunk" },
    { fileName: "assets/style-ghi.css", source: ":root{color-scheme:dark}", type: "asset" },
  ] };
}

function fixture() {
  const graph = snapshotProductPreviewGraph(bundle(), entry);
  const html = prepareProductPreviewShell(shell, graph).replace(APP_CSS_PLACEHOLDER, PRODUCT_PREVIEW_CSS_HREF);
  const shellArtifact = { path: "index.html", bytes: Buffer.byteLength(html), sha256: hash(html) };
  const finalCss = { path: "stylex.css", bytes: Buffer.byteLength(".compiled{color:red}"), sha256: hash(".compiled{color:red}") };
  const complete = {
    artifacts: [shellArtifact, ...graph.artifacts.map((item) => ({ ...item, path: `graphs/client/${item.path}` }))],
    compilerSha256, finalCss, generationId: "oompa-product-preview",
    graphs: [{ id: "client", receiptSha256: hash("client") }],
    kind: "hraness-stylex-complete-generation",
    packages: [{ manifestSha256: hash("design-manifest"), name: "@hraness/design-kit", version: "0.6.2" },
      { manifestSha256: hash("ui-manifest"), name: "@hraness/ui", version: "0.5.6" }],
    planSha256, schemaVersion: 2, state: "complete", unionPolicySha256: stylexUnionPolicySha256,
  };
  const project = (value: unknown = complete) => projectProductPreviewArtifacts(value, planSha256, graph, shellArtifact, finalCss);
  return { graph, complete, project, shellArtifact, finalCss };
}

describe("strict inert preview graph", () => {
  test("binds one real entry and foundation without admitting a storage bootstrap, extra asset or map", () => {
    const source = bundle();
    for (const output of [
      source.output.slice(1), source.output.slice(0, -1),
      [...source.output, { fileName: "assets/appearance-bound.js", source: "classic program", type: "asset" }],
      [...source.output, { fileName: "assets/extra.css", source: "extra foundation", type: "asset" }],
      [...source.output, source.output[0]],
      source.output.map((item, index) => index === 0 ? { ...item, facadeModuleId: "/other/main.tsx" } : item),
      source.output.map((item, index) => index === 0 ? { ...item, map: {} } : item),
      source.output.map((item, index) => index === 0 ? { ...item, fileName: "../main.js" } : item),
      source.output.map((item, index) => index === 0 ? { ...item, code: "" } : item),
    ]) expect(() => snapshotProductPreviewGraph({ output }, entry)).toThrow();
  });

  test("compiler record order cannot change captured bytes and generated classic programs never enter the graph", () => {
    const expected = snapshotProductPreviewGraph(bundle(), entry);
    fc.assert(fc.property(
      fc.shuffledSubarray(bundle().output, { minLength: 3, maxLength: 3 }),
      fc.stringMatching(/^[a-z][a-z0-9_-]{0,24}$/u),
      (output, name) => {
        expect(snapshotProductPreviewGraph({ output }, entry)).toEqual(expected);
        expect(() => snapshotProductPreviewGraph({ output: [...output,
          { type: "asset", fileName: `assets/${name}.js`, source: "unregistered classic program" }],
        }, entry)).toThrow();
      },
    ), { numRuns: 50, seed: 20260909 });
  });
});

describe("offline product preview shell", () => {
  test("mounts the captured entry and foundation before final recipes without changing authored content", () => {
    const { graph } = fixture();
    const html = prepareProductPreviewShell(shell, graph);
    const foundation = `<link rel="stylesheet" href="./graphs/client/${graph.foundation}">`;
    const recipes = `<link rel="stylesheet" href="${APP_CSS_PLACEHOLDER}">`;
    expect(html).toContain(`src="./graphs/client/${graph.entry}"`);
    expect(html.indexOf(PRODUCT_PREVIEW_CSP)).toBeLessThan(html.indexOf(foundation));
    expect(html.indexOf(foundation)).toBeLessThan(html.indexOf(recipes));
    expect(html.replace(`${foundation}\n    ${recipes}\n  `, "")
      .replace(`./graphs/client/${graph.entry}`, "/src/main.tsx").replace(themedTag, htmlTag)).toBe(shell);
    expect(html).toContain(themedTag);
    expect(html.match(/<script\b/gu)).toHaveLength(1);
    expect(html).not.toContain("appearance.js");
    const mount = `https://example.invalid${PRODUCT_PREVIEW_BASE}`;
    for (const path of [`graphs/client/${graph.entry}`, `graphs/client/${graph.foundation}`, "stylex.css"]) {
      expect(new URL(`./${path}`, mount).pathname).toBe(`${PRODUCT_PREVIEW_BASE}${path}`);
    }
    expect(new URL(PRODUCT_PREVIEW_CSS_HREF, mount).pathname).toBe(`${PRODUCT_PREVIEW_BASE}stylex.css`);
  });

  test("requires the offline policy without connections, form submissions, workers or frames", () => {
    const { graph } = fixture();
    for (const replacement of [
      "", PRODUCT_PREVIEW_CSP.replace("connect-src 'none'", "connect-src 'self'"),
      PRODUCT_PREVIEW_CSP.replace("form-action 'none'", "form-action 'self'"),
      PRODUCT_PREVIEW_CSP.replace("script-src 'self'", "script-src 'self' 'unsafe-inline'"),
      PRODUCT_PREVIEW_CSP.replace("worker-src 'none'", "worker-src 'self'"),
    ]) expect(() => prepareProductPreviewShell(shell.replace(PRODUCT_PREVIEW_CSP, replacement), graph)).toThrow();
    for (const changed of [
      shell.replace('http-equiv="Content-Security-Policy"', 'name="Content-Security-Policy"'),
      shell.replace("</head>", '<meta http-equiv="refresh" content="0;url=https://outside.invalid"></head>'),
      shell.replace("</head>", `<meta http-equiv="Content-Security-Policy" content="${PRODUCT_PREVIEW_CSP}"></head>`),
      shell.replace("<head>", `<head>${sourceEntry}`).replace(`<div id="root"></div>${sourceEntry}`, '<div id="root"></div>'),
    ]) expect(() => prepareProductPreviewShell(changed, graph)).toThrow();
  });

  test("rejects extra resources, inline handlers, presentation injection and changed entry boundaries", () => {
    const { graph } = fixture();
    for (const changed of [
      shell.replace("</body>", '<img src="https://outside.invalid/image.png"></body>'),
      shell.replace("</body>", '<iframe src="/other/"></iframe></body>'),
      shell.replace("</body>", '<a href="https://outside.invalid">External</a></body>'),
      shell.replace('<div id="root">', '<div id="root" onclick="alert(1)">'),
      shell.replace("</head>", "<style>body{color:red}</style></head>"),
      shell.replace("</head>", '<link rel="stylesheet" href="/other.css"></head>'),
      shell.replace("/src/main.tsx", "/app/src/main.tsx"),
      shell.replace('data-theme="dark"', 'data-theme="light"'),
      shell.replace("</body>", `${sourceEntry}</body>`),
    ]) expect(() => prepareProductPreviewShell(changed, graph)).toThrow();
  });
});

describe("closed product preview publication", () => {
  test("publishes only captured JavaScript, foundation, sealed HTML and final CSS", () => {
    const { complete, project } = fixture();
    expect(project().map(({ path }) => path)).toEqual([
      "graphs/client/assets/lazy-def.js", "graphs/client/assets/main-abc.js", "graphs/client/assets/style-ghi.css", "index.html", "stylex.css",
    ]);
    expect(project({ ...complete, artifacts: [...complete.artifacts].reverse() })).toEqual(project());
    expect(project().some(({ path }) => /\.(?:json|map|tsx?)$/u.test(path))).toBe(false);
  });

  test("binds compiler, plan, graph, package, generation and final stylesheet", () => {
    const { complete, project } = fixture();
    for (const mutation of [
      { compilerSha256: hash("other") }, { unionPolicySha256: hash("other") },
      { planSha256: hash("other") }, { generationId: "oompa-app" }, { state: "building" }, { schemaVersion: 1 },
      { graphs: [{ id: "other", receiptSha256: hash("other") }] }, { graphs: [...complete.graphs, ...complete.graphs] },
      { packages: [{ ...complete.packages[0], name: ["@other", "ui"].join("/") }] },
      { packages: complete.packages.slice(1) }, { packages: [...complete.packages].reverse() },
      { packages: [complete.packages[0], complete.packages[0]] },
      { finalCss: { ...complete.finalCss, sha256: hash("changed") } }, { extra: true },
    ]) expect(() => project({ ...complete, ...mutation })).toThrow();
  });

  test("refuses private, source, unregistered, duplicate and changed artifacts", () => {
    const { complete, project } = fixture();
    for (const path of [
      "stylex-complete.json", "graphs/client/receipt.json", "graphs/client/assets/main.js.map",
      "graphs/client/assets/source.ts", "graphs/client/assets/extra.js", "../index.html", "/index.html", "graphs/client/assets/%2e%2e.js",
    ]) expect(() => project({ ...complete, artifacts: [...complete.artifacts, { path, bytes: 1, sha256: hash(path) }] })).toThrow();
    expect(() => project({ ...complete, artifacts: complete.artifacts.slice(1) })).toThrow();
    expect(() => project({ ...complete, artifacts: [...complete.artifacts, complete.artifacts[0]] })).toThrow();
    expect(() => project({ ...complete, artifacts: [...complete.artifacts, complete.finalCss] })).toThrow();
    for (const index of [0, 1, 2, 3]) expect(() => project({
      ...complete, artifacts: complete.artifacts.map((item, position) => position === index ? { ...item, sha256: hash("changed") } : item),
    })).toThrow();
  });
});
