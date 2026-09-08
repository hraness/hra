import assert from "node:assert/strict";
import { constants } from "node:fs";
import { open, realpath, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { inventory } from "./app-browser.ts";
import { APP_CSS_PLACEHOLDER, parseAppComplete, prepareAppShell, snapshotAppGraph } from "./build-app.ts";
import { browserIoPlugin } from "../app/fixtures/browser/config.ts";
import {
  BROWSER_BUN_VERSION, browserDigest, browserExecutable, browserFile, browserInventory,
  browserPublicArtifacts, parseBrowserPrepared, parseBrowserRequest, publishBrowserJson,
  readBrowserFile, verifyBrowserRequest,
} from "./app-browser-handoff.ts";

/** Same complete graph, package registration, shell seal and finalizer as build:app. */
async function buildFixture(root: string, run: string): Promise<void> {
  const {
    createStylexGeneration, finalizeStylexGeneration, prepareStylexProducedTemplate, sealStylexProducedTemplate,
  } = await import("@hraness/ui/stylex-build");
  const { build } = await import("vite");
  const { appProductionConfig } = await import("../app/vite.config.ts");
  const shell = await readBrowserFile(join(root, "app/index.html"));
  const outputDirectory = join(run, "fixture");
  const entry = "app/fixtures/browser/main.tsx";
  const generation = await createStylexGeneration({
    expectedGraphs: [{ adapter: "vite", entrypoints: [entry], id: "client", kind: "client" }],
    finalCssPath: "stylex.css", generationId: "hra-app", outputDirectory,
    packageManifests: [import.meta.resolve("@hraness/ui/stylex-manifest.json")], rootDirectory: root,
    templates: [{ cssHref: "/stylex.css", graphId: "client", outputPath: "index.html", sourcePath: "app/index.html", stylesheetGraphId: "client" }],
  });
  const config = appProductionConfig(root, generation);
  config.plugins = [browserIoPlugin(root), ...(config.plugins ?? [])];
  const graph = snapshotAppGraph(await build(config), join(root, entry));
  const prepared = await prepareStylexProducedTemplate(generation, "index.html");
  const html = prepareAppShell(shell.toString("utf8"), graph);
  await writeFile(prepared.sourcePath, html, { flag: "wx", mode: 0o600 });
  await sealStylexProducedTemplate(generation, "index.html");
  const completed = await finalizeStylexGeneration({ generation, outputDirectory, rootDirectory: root });
  assert.equal(completed, join(run, "fixture/hra-app"));
  const files = await inventory(completed);
  const complete = files.get("stylex-complete.json");
  assert.ok(complete !== undefined);
  const expected = parseAppComplete(JSON.parse(complete.toString("utf8")) as unknown);
  assert.deepEqual(browserPublicArtifacts(await browserInventory(completed)).filter((item) => item.path !== "stylex-complete.json"), expected);
  assert.equal(files.get("index.html")?.toString("utf8"), html.replace(APP_CSS_PLACEHOLDER, "/stylex.css"));
  assert.deepEqual(await readBrowserFile(join(root, "app/index.html")), shell);
}

/** Validate the actual emitted program, not a source-text transplant. */
export function assertBrowserDriverAst(value: unknown): void {
  const imports = new Set<string>(); let count = 0;
  function walk(node: unknown): void {
    if (node === null || typeof node !== "object") return;
    assert.ok(++count <= 250_000, "Browser driver AST exceeds its bound");
    if (Array.isArray(node)) { node.forEach(walk); return; }
    const record = node as Record<string, unknown>;
    if (record.type === "Identifier") assert.notEqual(record.name, "Bun", "Node driver must not use global Bun");
    if (["ImportDeclaration", "ExportNamedDeclaration", "ExportAllDeclaration", "ImportExpression"].includes(String(record.type)) && record.source !== null && record.source !== undefined) {
      const source = record.source as Record<string, unknown>;
      assert.equal(source.type, "StringLiteral"); assert.ok(typeof source.value === "string"); imports.add(source.value);
    }
    if (record.type === "CallExpression") {
      const callee = record.callee as Record<string, unknown> | undefined;
      if (callee?.type === "Import") {
        assert.ok(Array.isArray(record.arguments) && record.arguments.length === 1);
        const argument = record.arguments[0] as Record<string, unknown>;
        assert.equal(argument.type, "StringLiteral"); assert.ok(typeof argument.value === "string"); imports.add(argument.value);
      }
      assert.ok(!(callee?.type === "Identifier" && (callee.name === "require" || callee.name === "eval")), "Unexpected dynamic Node driver loader");
    }
    for (const [key, child] of Object.entries(record)) if (!["loc", "start", "end", "comments", "tokens"].includes(key)) walk(child);
  }
  walk(value);
  const allowed = new Set(["linkedom", "lightningcss", "playwright-core"]);
  for (const specifier of imports) assert.ok(specifier.startsWith("node:") || allowed.has(specifier), "Unexpected browser driver dependency");
  assert.ok(imports.has("playwright-core"), "Browser driver must use real installed Playwright");
}

type DriverPublicationHandle = Readonly<{ sync: () => Promise<void>; close: () => Promise<void> }>;
type DriverPublicationOperations = Readonly<{
  openDriver: () => Promise<DriverPublicationHandle & Readonly<{ write: () => Promise<void> }>>;
  openDirectory: () => Promise<DriverPublicationHandle>;
}>;

async function finishDriverPublicationHandle(handle: DriverPublicationHandle, work: () => Promise<void>): Promise<void> {
  const failures: unknown[] = [];
  try { await work(); } catch (error) { failures.push(error); }
  try { await handle.close(); } catch (error) { failures.push(error); }
  if (failures.length > 1) throw new AggregateError(failures, "Browser driver publication and descriptor closure failed");
  if (failures.length === 1) {
    const failure = failures[0];
    throw failure instanceof Error ? failure : new Error("Browser driver publication failed", { cause: failure });
  }
}

/** Narrow ordering seam: a failed write, sync or close never permits a seal. */
export async function settleBrowserDriverPublication(operations: DriverPublicationOperations): Promise<void> {
  const driver = await operations.openDriver();
  await finishDriverPublicationHandle(driver, async () => { await driver.write(); await driver.sync(); });
  const directory = await operations.openDirectory();
  await finishDriverPublicationHandle(directory, () => directory.sync());
}

/** Finish durable exclusive publication before recording any file identity. */
export async function publishBrowserDriver(run: string, bytes: Buffer): Promise<void> {
  assert.ok(bytes.length > 0 && bytes.length <= 4 * 1024 * 1024);
  assert.equal(await realpath(run), run, "Browser driver directory must be physical");
  await settleBrowserDriverPublication({
    openDriver: async () => {
      const handle = await open(join(run, "driver.mjs"), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      return { write: () => handle.writeFile(bytes), sync: () => handle.sync(), close: () => handle.close() };
    },
    openDirectory: async () => {
      const handle = await open(run, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      return { sync: () => handle.sync(), close: () => handle.close() };
    },
  });
}

export async function prepareAppBrowser(run: string): Promise<void> {
  assert.equal(Bun.version, BROWSER_BUN_VERSION);
  const requestBytes = await readBrowserFile(join(run, "request.json"), 16 * 1024 * 1024);
  const request = parseBrowserRequest(JSON.parse(requestBytes.toString("utf8")) as unknown);
  assert.equal(request.run, run); assert.deepEqual(await browserExecutable(process.execPath), request.bun);
  await verifyBrowserRequest(request);
  await buildFixture(request.root, run);
  // Local extensionless TypeScript imports are bundled; installed packages and
  // their native modules remain external. There is no runtime source rewrite.
  const result = await Bun.build({
    entrypoints: [join(request.root, "scripts/app-browser.ts")], root: request.root,
    target: "node", format: "esm", packages: "external", minify: false, sourcemap: "none", splitting: false, metafile: true,
  });
  assert.equal(result.success, true, "Node browser driver compilation failed");
  assert.equal(result.outputs.length, 1, "Browser driver must emit exactly one program");
  const metafile = result.metafile; assert.ok(metafile, "Browser driver input graph was not captured");
  const capturedSources = new Map(request.sources.map((row) => [row.path, row]));
  assert.ok(Object.keys(metafile.inputs).length > 0 && Object.keys(metafile.inputs).length <= 32);
  for (const [path, input] of Object.entries(metafile.inputs)) {
    const absolute = isAbsolute(path) ? path : resolve(request.root, path);
    const key = relative(request.root, absolute), captured = capturedSources.get(key);
    assert.ok(captured !== undefined, "Browser driver imported an uncaptured source");
    assert.equal(input.bytes, captured.bytes);
    assert.deepEqual(await browserFile(request.root, key), captured);
  }
  const output = result.outputs[0]; assert.ok(output !== undefined && output.kind === "entry-point");
  const bytes = Buffer.from(await output.arrayBuffer()); assert.ok(bytes.length <= 4 * 1024 * 1024);
  const { parseSync } = await import("@babel/core");
  const tree = parseSync(bytes.toString("utf8"), { babelrc: false, configFile: false, sourceType: "module" });
  assert.ok(tree); assertBrowserDriverAst(tree);
  await publishBrowserDriver(run, bytes);
  await verifyBrowserRequest(request);
  const prepared = parseBrowserPrepared({
    schemaVersion: 1, kind: "hra-browser-prepared", requestSha256: browserDigest(requestBytes),
    buildRuntime: { name: "bun", version: Bun.version, executable: await browserExecutable(process.execPath) },
    driver: await browserFile(run, "driver.mjs"), fixture: await browserInventory(join(run, "fixture/hra-app")),
  });
  await publishBrowserJson(join(run, "prepared.json"), prepared);
}

if (import.meta.main) {
  assert.equal(process.argv.length, 3, "Expected one browser preparation run directory");
  const run = process.argv[2]; assert.ok(run !== undefined);
  await prepareAppBrowser(run);
}
