import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { compilerSha256, STYLEX_TEMPLATE_CSS_PLACEHOLDER, stylexUnionPolicySha256 } from "@hraness/ui/stylex-build";
import { prepareSiteDocument, projectSiteArtifacts as projectCapturedSite, snapshotSiteFoundation as captureSiteFoundation } from "./build-site-stylex.ts";

const hash = (value: Uint8Array | string): string => createHash("sha256").update(value).digest("hex");
const planSha256 = "a".repeat(64);
const foundationCss = "assets/style-abcdefgh.css";
const foundationEntry = "assets/foundation-abcdefgh.js";
const foundationSource = "/fixture/site/foundation.ts";
const snapshotSiteFoundation = (value: unknown, hashes: readonly string[]) => captureSiteFoundation(value, hashes, foundationSource);
const capturedFinalCss = { path: "stylex.css", bytes: "stylex.css".length, sha256: hash("stylex.css") };
const projectSiteArtifacts = (value: unknown, plan: string, foundation: ReturnType<typeof snapshotSiteFoundation>) =>
  projectCapturedSite(value, plan, foundation, capturedFinalCss);
const makeFoundation = () => {
  const fonts = Array.from({ length: 13 }, (_, index) => ({
    fileName: `assets/${index === 12 ? "GeistMono[wght]" : `NebulaSans-${index}`}-abcdefgh.woff2`,
    source: new Uint8Array([0x77, 0x4f, 0x46, 0x32, index]),
    type: "asset",
  }));
  const entry = {
    code: "\n", dynamicImports: [], exports: [], facadeModuleId: foundationSource,
    fileName: foundationEntry, imports: [], isDynamicEntry: false, isEntry: true,
    map: null, referencedFiles: [], type: "chunk",
  };
  const output = [{ fileName: foundationCss, source: ":root{color:black}", type: "asset" }, ...fonts, entry];
  return { output, hashes: fonts.map(({ source }) => hash(source)) };
};

const makeComplete = () => {
  const { output, hashes } = makeFoundation();
  const foundation = snapshotSiteFoundation({ output }, hashes);
  const artifact = (path: string) => ({ path, bytes: path.length, sha256: hash(path) });
  const finalCss = capturedFinalCss;
  const complete = {
    artifacts: [
      ...foundation.artifacts.map((item) => ({ ...item, path: `graphs/foundation/${item.path}` })),
      ...["index.html", "privacy/index.html", "preview/index.html"].map(artifact),
      artifact("graphs/renderer/entries/render-abcdefgh.js"),
      artifact("graphs/renderer/chunks/chunk-abcdefgh.js"),
    ],
    compilerSha256, finalCss, generationId: "hra-static-site",
    graphs: ["foundation", "renderer"].map((id) => ({ id, receiptSha256: hash(id) })),
    kind: "hraness-stylex-complete-generation",
    packages: [["@hraness/design-kit", "0.5.2"], ["@hraness/site-footer", "0.6.1"], ["@hraness/ui", "0.5.6"]]
      .map(([name, version]) => ({ manifestSha256: hash(name!), name, version })),
    planSha256, schemaVersion: 2, state: "complete", unionPolicySha256: stylexUnionPolicySha256,
  };
  return { complete, foundation };
};

describe("static site compiler projection", () => {
  test("joins one exact foundation before the final union without changing document content", () => {
    const html = '<!doctype html><html><head><link rel="stylesheet" href="/styles.css"></head><body><p>Preserved</p></body></html>';
    const path = `graphs/foundation/${foundationCss}`;
    expect(prepareSiteDocument(html, path)).toBe(html.replace(
      '<link rel="stylesheet" href="/styles.css">',
      `<link rel="stylesheet" href="/${path}">\n<link rel="stylesheet" href="${STYLEX_TEMPLATE_CSS_PLACEHOLDER}">`,
    ));
    for (const invalid of [
      "", html.replace("/styles.css", "/different.css"),
      html.replace("</head>", '<link rel="stylesheet" href="/styles.css"></head>'),
      html.replace("</head>", `<link href="${STYLEX_TEMPLATE_CSS_PLACEHOLDER}"></head>`),
      html.replace("<p>", '<p style="color:red">'),
      html.replace("</head>", "<style>p{color:red}</style></head>"),
    ]) expect(() => prepareSiteDocument(invalid, path)).toThrow();
    for (const invalid of ["../style.css", "graphs/foundation/assets/../style.css", "graphs/renderer/assets/style.css", "https://example.com/style.css"]) {
      expect(() => prepareSiteDocument(html, invalid)).toThrow();
    }
  });

  test("snapshots actual RollupOutput bytes and thirteen exact font hashes", () => {
    const { output, hashes } = makeFoundation();
    const result = snapshotSiteFoundation({ output }, hashes);
    expect(result.cssPath).toBe(`graphs/foundation/${foundationCss}`);
    expect(result.artifacts).toHaveLength(15);
    expect(result.privateEntryPath).toBe(foundationEntry);
    expect(snapshotSiteFoundation([{ output }], [...hashes].reverse())).toEqual(result);
    expect(result.artifacts.find(({ path }) => path.includes("GeistMono[wght]"))?.sha256).toBe(hashes[12]);
    expect(result.artifacts.find(({ path }) => path.endsWith(".css"))).toEqual({
      path: foundationCss, bytes: Buffer.byteLength(":root{color:black}"), sha256: hash(":root{color:black}"),
    });
  });

  test("rejects inlined, missing, added, changed or duplicate font assets", () => {
    const { output, hashes } = makeFoundation();
    expect(() => snapshotSiteFoundation({ output: [{ fileName: foundationCss, source: "@font-face{src:url(data:font/woff2;base64,d09GMg==)}", type: "asset" }] }, hashes)).toThrow();
    expect(() => snapshotSiteFoundation({ output: output.slice(1) }, hashes)).toThrow();
    expect(() => snapshotSiteFoundation({ output: [...output, output[0]] }, hashes)).toThrow();
    expect(() => snapshotSiteFoundation({ output }, hashes.slice(1))).toThrow();
    expect(() => snapshotSiteFoundation({ output }, [hash("different"), ...hashes.slice(1)])).toThrow();
    expect(() => snapshotSiteFoundation({ output }, ["invalid", ...hashes.slice(1)])).toThrow();
    expect(() => snapshotSiteFoundation({ output: output.map((item, index) => index === 1 ? { ...item, source: new Uint8Array([9]) } : item) }, hashes)).toThrow();
    expect(() => snapshotSiteFoundation({ output: output.map((item, index) => index === 1 ? { ...item, fileName: output[2]!.fileName } : item) }, hashes)).toThrow();
  });

  test("rejects watcher/multi-output results, extra JavaScript, foreign types and unsafe paths", () => {
    const { output, hashes } = makeFoundation();
    for (const invalid of [null, {}, { close() {} }, [], [{ output }, { output }]]) {
      expect(() => snapshotSiteFoundation(invalid, hashes)).toThrow();
    }
    for (const mutation of [
      { type: "chunk" }, { source: {} }, { fileName: "../font.woff2" },
      { fileName: "assets/../font.woff2" }, { fileName: "assets/font%2Fescape.woff2" },
      { fileName: "assets/font.otf" }, { fileName: "assets/source.ts" },
      { fileName: "assets/source.js.map" }, { fileName: "/assets/font.woff2" },
    ]) {
      expect(() => snapshotSiteFoundation({ output: output.map((item, index) => index === 1 ? { ...item, ...mutation } : item) }, hashes)).toThrow();
    }
  });

  test("requires the exact captured empty entry without executable code, imports or maps", () => {
    const { output, hashes } = makeFoundation();
    expect(() => captureSiteFoundation({ output }, hashes, "site/foundation.ts")).toThrow();
    expect(() => snapshotSiteFoundation({ output: output.slice(0, -1) }, hashes)).toThrow();
    for (const mutation of [
      { code: "alert(1)" }, { code: "export {};" }, { code: "/* source provenance */" },
      { code: {} }, { code: "\n\n" }, { isEntry: false }, { isDynamicEntry: true },
      { facadeModuleId: "/fixture/site/foreign.ts" }, { facadeModuleId: null },
      { fileName: "assets/foreign-abcdefgh.js" }, { imports: ["external"] },
      { dynamicImports: ["lazy.js"] }, { exports: ["default"] },
      { referencedFiles: [foundationCss] }, { map: { mappings: "" } },
    ]) {
      expect(() => snapshotSiteFoundation({ output: output.map((item) => item.type === "chunk" ? { ...item, ...mutation } : item) }, hashes)).toThrow();
    }
    expect(() => snapshotSiteFoundation({ output: output.map((item, index) => index === 1 ? output.at(-1) : item) }, hashes)).toThrow();
    const empty = snapshotSiteFoundation({ output: output.map((item) => item.type === "chunk" ? { ...item, code: "" } : item) }, hashes);
    expect(empty.artifacts.find(({ path }) => path === foundationEntry)).toEqual({ path: foundationEntry, bytes: 0, sha256: hash("") });
  });

  test("publishes only three HTML routes, the final union, foundation and exact fonts", () => {
    const { complete, foundation } = makeComplete();
    const projected = projectSiteArtifacts(complete, planSha256, foundation);
    expect(projected).toHaveLength(18);
    expect(projected.filter(({ path }) => path.endsWith(".woff2"))).toHaveLength(13);
    expect(projected.filter(({ path }) => path.endsWith(".html")).map(({ path }) => path).sort()).toEqual(["index.html", "preview/index.html", "privacy/index.html"]);
    expect(projected.some(({ path }) => /\.(?:js|json|map|ts|tsx|otf)$/u.test(path))).toBe(false);
  });

  test("rejects private/source artifacts, modified foundation bytes and incomplete templates", () => {
    const { complete, foundation } = makeComplete();
    for (const path of [
      "stylex-complete.json", "graphs/foundation/assets/source.js", "graphs/foundation/assets/extra.woff2",
      "graphs/renderer/entries/render.js.map", "graphs/renderer/source.ts", "../outside.html", "graphs/renderer/../escape.js",
    ]) expect(() => projectSiteArtifacts({ ...complete, artifacts: [...complete.artifacts, { path, bytes: 1, sha256: hash(path) }] }, planSha256, foundation)).toThrow();
    expect(() => projectSiteArtifacts({ ...complete, artifacts: complete.artifacts.filter(({ path }) => path !== "preview/index.html") }, planSha256, foundation)).toThrow();
    expect(() => projectSiteArtifacts({ ...complete, artifacts: complete.artifacts.map((item, index) => index === 0 ? { ...item, sha256: hash("changed") } : item) }, planSha256, foundation)).toThrow();
    const privateEntryPath = `graphs/foundation/${foundationEntry}`;
    expect(() => projectSiteArtifacts({ ...complete, artifacts: complete.artifacts.filter(({ path }) => path !== privateEntryPath) }, planSha256, foundation)).toThrow();
    expect(() => projectSiteArtifacts({ ...complete, artifacts: complete.artifacts.map((item) => item.path === privateEntryPath ? { ...item, sha256: hash("changed private entry") } : item) }, planSha256, foundation)).toThrow();
    expect(() => projectSiteArtifacts({ ...complete, artifacts: [...complete.artifacts, complete.artifacts[0]] }, planSha256, foundation)).toThrow();
    expect(() => projectSiteArtifacts({ ...complete, artifacts: [...complete.artifacts, complete.finalCss] }, planSha256, foundation)).toThrow();
  });

  test("binds plan, compiler, union policy, package set, graphs and final CSS identity", () => {
    const { complete, foundation } = makeComplete();
    for (const mutation of [
      { planSha256: hash("other") }, { compilerSha256: hash("other") }, { unionPolicySha256: hash("other") },
      { generationId: "other" }, { state: "building" }, { schemaVersion: 1 },
      { graphs: [complete.graphs[0], complete.graphs[0]] },
      { packages: complete.packages.map((item, index) => index === 0 ? { ...item, name: ["@foreign", "package"].join("/") } : item) },
      { finalCss: { ...complete.finalCss, sha256: hash("other") } }, { unknown: true },
    ]) expect(() => projectSiteArtifacts({ ...complete, ...mutation }, planSha256, foundation)).toThrow();
  });
});
