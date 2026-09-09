import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import {
  artifactForFile, compilerSha256, createStylexGeneration, finalizeStylexGeneration,
  prepareStylexProducedTemplate, sealStylexProducedTemplate, stylexUnionPolicySha256,
} from "@hraness/ui/stylex-build";
import { stylexVite } from "@hraness/ui/stylex-build/vite";
import { getDesignPaletteTheme } from "@hraness/design-kit";
import react from "@vitejs/plugin-react";
import { parseHTML } from "linkedom";
import { z } from "zod";
import { APP_CSS_PLACEHOLDER, type AppArtifact } from "./build-app.ts";

export const PRODUCT_PREVIEW_BASE = "/examples/app/";
export const PRODUCT_PREVIEW_CSP = "default-src 'none'; script-src 'self'; style-src 'self'; img-src data: blob:; font-src 'self'; connect-src 'none'; form-action 'none'; base-uri 'none'; object-src 'none'; frame-src 'none'; worker-src 'none'";
export const PRODUCT_PREVIEW_CSS_HREF = "./stylex.css";
const generationId = "hra-product-preview";
const entry = "app/fixtures/product/main.tsx";
const shellPath = "app/fixtures/product/index.html";
const hash = (bytes: Uint8Array | string): string => createHash("sha256").update(bytes).digest("hex");
const sha = z.string().regex(/^[a-f0-9]{64}$/u);
const publicPath = z.string().regex(/^(?:index\.html|stylex\.css|graphs\/client\/assets\/[A-Za-z0-9_-][A-Za-z0-9_.-]*\.(?:js|css))$/u);
const artifact = z.object({ path: publicPath, bytes: z.number().int().min(1).max(64 * 1024 * 1024), sha256: sha }).strict();
export type ProductPreviewGraph = Readonly<{ artifacts: readonly AppArtifact[]; entry: string; foundation: string }>;
const graphPath = z.string().regex(/^assets\/[A-Za-z0-9_-][A-Za-z0-9_.-]*\.(?:js|css)$/u);
const graphOutput = z.discriminatedUnion("type", [
  z.object({ type: z.literal("chunk"), fileName: graphPath, code: z.string().min(1), isEntry: z.boolean(), facadeModuleId: z.string().nullable().optional(), map: z.null().optional() }),
  z.object({ type: z.literal("asset"), fileName: graphPath, source: z.union([z.string().min(1), z.instanceof(Uint8Array)]) }),
]);
const packageVersion = z.string().regex(/^\d+\.\d+\.\d+$/u);
const completeSchema = z.object({
  artifacts: z.array(artifact).min(3).max(4095), compilerSha256: z.literal(compilerSha256),
  finalCss: artifact, generationId: z.literal(generationId),
  graphs: z.array(z.object({ id: z.literal("client"), receiptSha256: sha }).strict()).length(1),
  kind: z.literal("hraness-stylex-complete-generation"),
  packages: z.tuple([
    z.object({ manifestSha256: sha, name: z.literal("@hraness/design-kit"), version: packageVersion }).strict(),
    z.object({ manifestSha256: sha, name: z.literal("@hraness/ui"), version: packageVersion }).strict(),
  ]),
  planSha256: sha, schemaVersion: z.literal(2), state: z.literal("complete"),
  unionPolicySha256: z.literal(stylexUnionPolicySha256),
}).strict();

/** The preview has one real module and no classic storage-capable bootstrap. */
export function snapshotProductPreviewGraph(value: unknown, absoluteEntry: string): ProductPreviewGraph {
  assert.ok(isAbsolute(absoluteEntry));
  const result = z.object({ output: z.array(graphOutput).min(2).max(4094) }).parse(value);
  const entries: string[] = [], foundations: string[] = [];
  const artifacts = result.output.map((item): AppArtifact => {
    if (item.type === "chunk") {
      assert.ok(item.fileName.endsWith(".js"), "Preview chunks must be JavaScript");
      if (item.isEntry) {
        assert.equal(item.facadeModuleId, absoluteEntry, "Unregistered preview entry");
        entries.push(item.fileName);
      }
    } else {
      assert.ok(item.fileName.endsWith(".css"), "Preview cannot acquire a classic appearance or other static program");
      foundations.push(item.fileName);
    }
    const bytes = item.type === "chunk" ? item.code : item.source;
    const captured = { path: item.fileName, bytes: Buffer.byteLength(bytes), sha256: hash(bytes) };
    artifact.parse({ ...captured, path: `graphs/client/${captured.path}` });
    return captured;
  }).sort((left, right) => left.path.localeCompare(right.path));
  assert.equal(entries.length, 1, "The preview must have exactly one module entry");
  assert.equal(foundations.length, 1, "The preview must have one complete themed foundation stylesheet");
  assert.equal(new Set(artifacts.map(({ path }) => path)).size, artifacts.length, "Duplicate preview graph artifact");
  assert.ok(artifacts.reduce((total, item) => total + item.bytes, 0) <= 256 * 1024 * 1024);
  const entry = entries[0], foundation = foundations[0];
  assert.ok(entry !== undefined && foundation !== undefined);
  return { artifacts, entry, foundation };
}

/** Confine resources and apply the shared default theme without preference IO. */
export function prepareProductPreviewShell(source: string, graph: ProductPreviewGraph): string {
  assert.ok(Buffer.byteLength(source) > 0 && Buffer.byteLength(source) <= 64 * 1024);
  const { document } = parseHTML(source);
  const policy = document.querySelectorAll("meta[http-equiv]");
  assert.equal(policy.length, 1, "The preview shell must own exactly one CSP and no refresh directive");
  const meta = policy[0];
  assert.ok(meta !== undefined && meta.parentElement === document.head, "Preview CSP must precede the body");
  assert.equal(meta.getAttribute("http-equiv")?.toLowerCase(), "content-security-policy");
  assert.equal(meta.getAttribute("content"), PRODUCT_PREVIEW_CSP, "Preview CSP changed");
  const resources = document.querySelectorAll("[src],[href],[srcset]");
  assert.equal(resources.length, 1, "Only the registered preview module may load a resource");
  assert.equal(resources[0]?.tagName, "SCRIPT");
  assert.equal(resources[0].parentElement, document.body, "Preview module must follow the head CSP");
  for (const element of document.querySelectorAll("*")) {
    for (const attribute of element.attributes) {
      assert.ok(!/^on/iu.test(attribute.name), "Preview shell must not contain inline handlers");
    }
  }
  const entryTag = '<script type="module" src="/src/main.tsx"></script>';
  const htmlTag = '<html lang="en" data-theme="dark">';
  assert.equal(source.split(entryTag).length - 1, 1, "Authored preview entry changed");
  assert.equal(source.split(htmlTag).length - 1, 1, "Authored preview theme boundary changed");
  assert.equal((source.match(/<script\b/giu) ?? []).length, 1);
  assert.equal(source.split("</head>").length - 1, 1);
  assert.ok(!/<!--|<\?|<!\[CDATA\[|<(?:template|noscript|svg|math)\b/iu.test(source), "Preview must retain its active native HTML boundary");
  assert.ok(!/<(?:style|link|base)\b|\bstyle\s*=/iu.test(source), "Unexpected preview stylesheet or inline style");
  assert.ok(!source.includes(APP_CSS_PLACEHOLDER));
  assert.ok(graphPath.parse(graph.entry).endsWith(".js") && graphPath.parse(graph.foundation).endsWith(".css"));
  const paletteClass = getDesignPaletteTheme("catppuccin", "dark").className;
  assert.match(paletteClass, /^[A-Za-z0-9_-]+(?: [A-Za-z0-9_-]+)*$/u);
  // Relative links preserve the compiler's exact graph topology when the
  // complete public directory is mounted at PRODUCT_PREVIEW_BASE. Absolute
  // mount prefixes would name artifacts outside this registered generation.
  const themedHtmlTag = `<html lang="en" data-theme="dark" data-palette="catppuccin" class="${paletteClass}">`;
  return source.replace(htmlTag, themedHtmlTag)
    .replace(entryTag, `<script type="module" src="./graphs/client/${graph.entry}"></script>`)
    .replace("</head>", `<link rel="stylesheet" href="./graphs/client/${graph.foundation}">\n    <link rel="stylesheet" href="${APP_CSS_PLACEHOLDER}">\n  </head>`);
}

/** Project only the exact compiled graph, sealed shell and finalized stylesheet. */
export function projectProductPreviewArtifacts(
  value: unknown,
  planSha256: string,
  graph: ProductPreviewGraph,
  shell: AppArtifact,
  finalCss: AppArtifact,
): readonly AppArtifact[] {
  const complete = completeSchema.parse(value);
  assert.equal(complete.planSha256, sha.parse(planSha256));
  assert.equal(shell.path, "index.html");
  assert.equal(finalCss.path, "stylex.css");
  assert.deepEqual(complete.finalCss, artifact.parse(finalCss), "Preview final CSS differs from its captured bytes");
  const expected = [artifact.parse(shell), ...graph.artifacts.map((item) => artifact.parse({ ...item, path: `graphs/client/${item.path}` }))]
    .sort((left, right) => left.path.localeCompare(right.path));
  assert.equal(new Set(expected.map(({ path }) => path)).size, expected.length, "Duplicate preview graph artifact");
  assert.deepEqual([...complete.artifacts].sort((left, right) => left.path.localeCompare(right.path)), expected,
    "Preview completion differs from the captured graph or sealed shell");
  const projected = [...expected, complete.finalCss].sort((left, right) => left.path.localeCompare(right.path));
  assert.equal(new Set(projected.map(({ path }) => path)).size, projected.length);
  assert.equal(projected.filter(({ path }) => path.endsWith(".css")).length, 2);
  assert.ok(projected.some(({ path }) => path.endsWith(".js")));
  assert.ok(projected.reduce((total, item) => total + item.bytes, 0) <= 256 * 1024 * 1024);
  return projected;
}

/** Build an offline public preview, never a production app or custody runtime.
 * Completion receipts remain under complete/; only verified public bytes reach
 * public/. The site owns hosting and the opaque allow-scripts iframe sandbox. */
export async function buildProductPreview(options: Readonly<{
  repositoryRoot: string;
  outputDirectory: string;
}>): Promise<string> {
  assert.ok(isAbsolute(options.repositoryRoot) && isAbsolute(options.outputDirectory));
  const root = await realpath(options.repositoryRoot);
  const output = resolve(options.outputDirectory);
  assert.ok(relative(output, root).startsWith(".."), "Preview output cannot own the repository or an ancestor");
  await mkdir(output, { recursive: true, mode: 0o700 });
  assert.equal(await realpath(output), output, "Preview output must be a physical directory");
  const completeRoot = join(output, "complete");
  const publicDirectory = join(output, "public");
  await mkdir(publicDirectory, { mode: 0o700 });
  const shell = await readFile(join(root, shellPath), "utf8");
  const { productIoPlugin } = await import("../app/fixtures/product/config.ts");
  const { build } = await import("vite");
  const generation = await createStylexGeneration({
    expectedGraphs: [{ adapter: "vite", entrypoints: [entry], id: "client", kind: "client" }],
    finalCssPath: "stylex.css", generationId, outputDirectory: completeRoot,
    packageManifests: [Bun.resolveSync("@hraness/ui/stylex-manifest.json", root), Bun.resolveSync("@hraness/design-kit/stylex-manifest.json", root)], rootDirectory: root,
    templates: [{ cssHref: PRODUCT_PREVIEW_CSS_HREF, graphId: "client", outputPath: "index.html", sourcePath: shellPath, stylesheetGraphId: "client" }],
  });
  const directLicense = (await readFile(join(root, "node_modules/@hraness/direct/LICENSE"), "utf8")).trim();
  assert.ok(directLicense.length > 0 && Buffer.byteLength(directLicense) <= 16 * 1024 && !directLicense.includes("*/"));
  // A source comment can be removed during transforms. Capture attribution in
  // the compiled graph itself, before its artifacts are hashed and sealed.
  // Chunk imports and shell links stay within the mounted preview directory.
  // No production build config or entry is modified.
  const graph = snapshotProductPreviewGraph(await build({
    base: "./", build: { target: "es2022" }, configFile: false,
    define: { "process.env.NODE_ENV": JSON.stringify("production") }, envFile: false, mode: "production",
    esbuild: { legalComments: "inline" },
    // The public adapter still owns root, input, output, no inlining and maps.
    // No production appearance bootstrap may enter this offline graph.
    plugins: [productIoPlugin(root), {
      name: "hra-product-preview-license",
      banner: () => `/*! @license @hraness/direct\n${directLicense}\n*/`,
    }, stylexVite({ generation, graphId: "client", rootDirectory: root }), react()],
  }), join(root, entry));
  const prepared = await prepareStylexProducedTemplate(generation, "index.html");
  const html = prepareProductPreviewShell(shell, graph);
  await writeFile(prepared.sourcePath, html, { flag: "wx", mode: 0o600 });
  await sealStylexProducedTemplate(generation, "index.html");
  const completed = await finalizeStylexGeneration({ generation, outputDirectory: completeRoot, rootDirectory: root });
  assert.equal(completed, join(completeRoot, generationId));
  const finalizedHtml = html.replace(APP_CSS_PLACEHOLDER, PRODUCT_PREVIEW_CSS_HREF);
  const expectedShell = { path: "index.html", bytes: Buffer.byteLength(finalizedHtml), sha256: hash(finalizedHtml) };
  const projected = projectProductPreviewArtifacts(
    JSON.parse(await readFile(join(completed, "stylex-complete.json"), "utf8")) as unknown,
    generation.planSha256, graph, expectedShell, await artifactForFile(completed, "stylex.css"),
  );
  for (const item of projected) {
    assert.deepEqual(await artifactForFile(completed, item.path), item);
    const bytes = await readFile(join(completed, item.path));
    assert.equal(bytes.byteLength, item.bytes);
    assert.equal(hash(bytes), item.sha256);
    const destination = join(publicDirectory, item.path);
    await mkdir(dirname(destination), { recursive: true, mode: 0o755 });
    await writeFile(destination, bytes, { flag: "wx", mode: 0o644 });
    assert.deepEqual(await artifactForFile(publicDirectory, item.path), item);
  }
  assert.equal(await readFile(join(root, shellPath), "utf8"), shell, "Preview shell changed during compilation");
  return publicDirectory;
}
