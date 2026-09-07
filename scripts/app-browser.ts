import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, mkdtemp, open, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { BrowserContext, Locator, Page } from "playwright-core";
import { browserIoModules, browserIoPlugin } from "../app/fixtures/browser/config";
import { APP_CSS_PLACEHOLDER, parseAppComplete, prepareAppShell, snapshotAppGraph } from "./build-app";

type Artifact = Readonly<{ bytes: number; path: string; sha256: string }>;
type Surface = Readonly<{ artifacts: readonly Artifact[]; bytes: ReadonlyMap<string, Buffer>; origin: string; stop: () => Promise<void> }>;
type Evidence = Readonly<{ name: string; values: unknown }>;
type BrowserFailure = Readonly<{ name: string; message: string; cause?: BrowserFailure; errors?: readonly BrowserFailure[] }>;
export function browserFailureDetails(value: unknown, depth = 0): BrowserFailure {
  if (!(value instanceof Error)) return { name: "UnknownFailure", message: typeof value === "string" ? value.slice(0, 1000) : typeof value };
  return {
    name: value.name.slice(0, 80), message: value.message.slice(0, 1000),
    ...(depth < 3 && value.cause !== undefined ? { cause: browserFailureDetails(value.cause, depth + 1) } : {}),
    ...(depth < 3 && value instanceof AggregateError ? { errors: value.errors.slice(0, 8).map((error: unknown) => browserFailureDetails(error, depth + 1)) } : {}),
  };
}
type Profile = Readonly<{ name: string; width: number; height: number; coarse: boolean; reduced: boolean; forced: boolean; rtl: boolean; colorScheme?: "dark" | "light" }>;
const profiles: readonly Profile[] = [
  { name: "desktop", width: 1280, height: 900, coarse: false, reduced: false, forced: false, rtl: false },
  { name: "light-os", width: 1280, height: 900, coarse: false, reduced: false, forced: false, rtl: false, colorScheme: "light" },
  { name: "narrow-coarse", width: 390, height: 844, coarse: true, reduced: false, forced: false, rtl: false },
  { name: "reduced-motion", width: 1280, height: 900, coarse: false, reduced: true, forced: false, rtl: false },
  { name: "forced-colors", width: 1280, height: 900, coarse: false, reduced: false, forced: true, rtl: false },
  { name: "rtl", width: 390, height: 844, coarse: true, reduced: false, forced: false, rtl: true },
];
const digest = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
const bracketedFontPath = "fonts/geist-mono/GeistMono[wght].woff2";
const fontProvenancePaths = new Set([
  "fonts/geist-mono/PROVENANCE.md", "fonts/nebula-sans/PROVENANCE.md",
]);
const diagnosticPath = (path: string) => JSON.stringify(path.slice(0, 160));

function safeInventoryKey(key: string): boolean {
  return key.length <= 2048 && (key === bracketedFontPath
    || key.split("/").every((part) => /^[A-Za-z0-9_.-]+$/u.test(part) && part !== "." && part !== ".."));
}

function record(value: unknown): Record<string, unknown> {
  assert.ok(typeof value === "object" && value !== null && !Array.isArray(value));
  return value as Record<string, unknown>;
}

export function productionCsp(value: unknown, source: string): string {
  const configuration = record(value);
  assert.ok(Array.isArray(configuration.headers));
  const rows = configuration.headers.map(record).filter((row) => row.source === source);
  assert.equal(rows.length, 1, "CSP route contract changed");
  const headers = rows[0]?.headers;
  assert.ok(Array.isArray(headers));
  const values = headers.map(record).filter((header) => header.key === "Content-Security-Policy");
  assert.equal(values.length, 1);
  const csp = values[0]?.value;
  assert.ok(typeof csp === "string" && csp.length < 8192);
  assert.ok(csp.split(";").some((directive) => directive.trim() === "style-src 'self'"));
  assert.ok(!csp.includes("'unsafe-inline'") && !csp.includes("'unsafe-eval'"));
  return csp;
}

/** URL normalization cannot turn a request into an arbitrary filesystem read. */
export function assetPath(pathname: string): string | null {
  if (pathname.length > 2048 || pathname.split("/").length > 14) return null;
  if (pathname === "/") return "index.html";
  // This public variable-font filename is the only bracketed inventory key.
  // Decode no general URL escapes: encoded separators/dot segments stay closed.
  if (/^\/fonts\/geist-mono\/GeistMono(?:\[|%5[bB])wght(?:\]|%5[dD])\.woff2$/u.test(pathname)) return bracketedFontPath;
  if (!/^\/[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*\/?$/u.test(pathname)) return null;
  if (pathname.split("/").some((part) => part === "." || part === "..")) return null;
  return pathname.endsWith("/") ? `${pathname.slice(1)}index.html` : pathname.slice(1);
}

async function ordinary(path: string): Promise<Buffer> {
  assert.equal(await realpath(path), resolve(path), "Browser input must have a physical path");
  const before = await lstat(path);
  assert.ok(before.isFile() && !before.isSymbolicLink() && before.size <= 64 * 1024 * 1024, "Unsafe browser input");
  const identity = (info: typeof before) => [info.dev, info.ino, info.size, info.mode, info.nlink, info.mtimeMs, info.ctimeMs];
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    assert.deepEqual(identity(await handle.stat()), identity(before), "Browser input changed before reading");
    const chunks: Buffer[] = [];
    let bytes = 0;
    for await (const chunk of handle.createReadStream({ autoClose: false })) {
      assert.ok(Buffer.isBuffer(chunk));
      bytes += chunk.byteLength;
      assert.ok(bytes <= before.size, "Browser input grew during reading");
      chunks.push(chunk);
    }
    assert.equal(bytes, before.size, "Browser input shrank during reading");
    assert.deepEqual(identity(await handle.stat()), identity(before), "Browser input changed during reading");
    assert.deepEqual(identity(await lstat(path)), identity(before), "Browser input path changed during reading");
    assert.equal(await realpath(path), resolve(path), "Browser input lost its physical path");
    return Buffer.concat(chunks, bytes);
  } finally { await handle.close(); }
}

/** Full Linux Chromium is much larger than the macOS launcher. Stream its
 * identity separately; public assets keep their independent 64 MiB bound. */
export async function browserExecutableSha256(path: string): Promise<string> {
  const before = await lstat(path);
  assert.ok(before.isFile() && !before.isSymbolicLink() && (before.mode & 0o111) !== 0);
  assert.ok(before.size > 0 && before.size <= 1024 * 1024 * 1024, "Browser executable exceeds the 1 GiB boundary");
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  const identity = (info: typeof before) => [info.dev, info.ino, info.size, info.mode, info.mtimeMs, info.ctimeMs];
  try {
    assert.deepEqual(identity(await handle.stat()), identity(before), "Browser executable changed before reading");
    const hash = createHash("sha256");
    let bytes = 0;
    for await (const chunk of handle.createReadStream({ autoClose: false })) {
      assert.ok(chunk instanceof Uint8Array);
      bytes += chunk.byteLength;
      assert.ok(bytes <= before.size, "Browser executable grew during reading");
      hash.update(chunk);
    }
    assert.equal(bytes, before.size);
    assert.deepEqual(identity(await handle.stat()), identity(before), "Browser executable changed during reading");
    assert.deepEqual(identity(await lstat(path)), identity(before), "Browser executable path changed during reading");
    return hash.digest("hex");
  } finally { await handle.close(); }
}

function processExists(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ESRCH") return false;
    throw error;
  }
}

async function collected(pids: readonly number[]): Promise<void> {
  const deadline = Date.now() + 5000;
  while (pids.some(processExists) && Date.now() < deadline) await new Promise((done) => { setTimeout(done, 50); });
  assert.deepEqual(pids.filter(processExists), [], "Owned browser process survived close; profile preserved");
}

export async function boundedBrowserOperation<T>(operation: Promise<T>, milliseconds: number, label: string, signal?: AbortSignal): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  try {
    const cancelled = new Promise<never>((_resolve, reject) => {
      onAbort = () => { reject(new Error(`${label} cancelled`)); };
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) onAbort();
    });
    return await Promise.race([operation, cancelled, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => { reject(new Error(`${label} exceeded ${milliseconds}ms`)); }, milliseconds);
    })]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (onAbort !== undefined) signal?.removeEventListener("abort", onAbort);
  }
}

async function closeOwnedBrowser(context: BrowserContext, pids: number[]): Promise<void> {
  let censusFailure: unknown;
  try {
    const browser = context.browser();
    assert.ok(browser !== null, "Browser ownership disappeared before closing census");
    const session = await boundedBrowserOperation(browser.newBrowserCDPSession(), 5000, "Closing browser census session");
    try {
      const census = await boundedBrowserOperation(session.send("SystemInfo.getProcessInfo"), 5000, "Closing browser process census");
      for (const entry of census.processInfo) {
        assert.ok(Number.isSafeInteger(entry.id) && entry.id > 0 && entry.id !== process.pid);
        if (!pids.includes(entry.id)) pids.push(entry.id);
      }
      assert.ok(pids.length > 0, "Browser census was empty");
    } finally { await boundedBrowserOperation(session.detach(), 5000, "Browser census detach"); }
  } catch (error) { censusFailure = error; }
  try {
    await boundedBrowserOperation(context.close(), 20_000, "Owned browser close");
    await collected(pids);
    assert.equal(context.pages().length, 0);
  } catch (error) {
    throw censusFailure === undefined ? error : new AggregateError([censusFailure, error], "Browser census and collection failed; profile retained");
  }
  if (censusFailure !== undefined) throw censusFailure;
}

export async function inventory(directory: string): Promise<ReadonlyMap<string, Buffer>> {
  assert.equal(await realpath(directory), resolve(directory), "Browser output must have a physical path");
  const files = new Map<string, Buffer>();
  let total = 0;
  let entryCount = 0;
  async function walk(path: string, prefix: string): Promise<void> {
    assert.ok(prefix.split("/").length <= 12 && files.size <= 4096, "Browser inventory exceeds bounds");
    const before = await lstat(path);
    assert.ok(before.isDirectory() && !before.isSymbolicLink(), `Unsafe browser directory: ${diagnosticPath(prefix)}`);
    assert.equal(await realpath(path), resolve(path), `Nonphysical browser directory: ${diagnosticPath(prefix)}`);
    const entries = await readdir(path, { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name < b.name ? -1 : 1)) {
      const key = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      entryCount += 1;
      assert.ok(entryCount <= 4096, "Browser inventory entry count exceeds 4096");
      assert.ok(safeInventoryKey(key), `Unsafe public browser output name: ${diagnosticPath(key)}`);
      assert.ok(!entry.isSymbolicLink(), `Linked public browser output: ${diagnosticPath(key)}`);
      if (key === bracketedFontPath || fontProvenancePaths.has(key)) {
        assert.ok(entry.isFile(), `Expected an ordinary public font file: ${diagnosticPath(key)}`);
      }
      const child = join(path, entry.name);
      if (entry.isDirectory()) await walk(child, key);
      else {
        assert.ok(/\.(?:css|html|js|json|svg|png|ico|woff2?|txt|xml)$/u.test(entry.name)
          || fontProvenancePaths.has(key), `Unexpected public browser output type: ${diagnosticPath(key)}`);
        const bytes = await ordinary(child);
        total += bytes.byteLength;
        assert.ok(total <= 256 * 1024 * 1024 && files.size < 4096);
        files.set(key, bytes);
      }
    }
    const after = await lstat(path);
    assert.ok(after.isDirectory() && !after.isSymbolicLink(), `Browser directory changed type: ${diagnosticPath(prefix)}`);
    assert.deepEqual([after.dev, after.ino, after.mtimeMs, after.ctimeMs],
      [before.dev, before.ino, before.mtimeMs, before.ctimeMs], `Browser directory changed: ${diagnosticPath(prefix)}`);
    assert.equal(await realpath(path), resolve(path), `Browser directory lost its physical path: ${diagnosticPath(prefix)}`);
  }
  await walk(directory, "");
  assert.ok(files.has("index.html"));
  return files;
}

function artifacts(files: ReadonlyMap<string, Buffer>): readonly Artifact[] {
  return [...files].map(([path, bytes]) => ({ bytes: bytes.byteLength, path, sha256: digest(bytes) }))
    .sort((a, b) => a.path < b.path ? -1 : 1);
}

export function assetContentType(key: string): string {
  if (fontProvenancePaths.has(key)) return "text/plain; charset=utf-8";
  const mime: Readonly<Record<string, string>> = {
    css: "text/css; charset=utf-8", html: "text/html; charset=utf-8", js: "text/javascript; charset=utf-8",
    json: "application/json", svg: "image/svg+xml", png: "image/png", ico: "image/x-icon",
    woff: "font/woff", woff2: "font/woff2", txt: "text/plain", xml: "application/xml",
  };
  return mime[key.split(".").at(-1) ?? ""] ?? "application/octet-stream";
}

async function serve(files: ReadonlyMap<string, Buffer>, csp: string): Promise<Surface> {
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    fetch(request) {
      if (request.method !== "GET" && request.method !== "HEAD") return new Response(null, { status: 405 });
      const key = assetPath(new URL(request.url).pathname);
      const bytes = key === null ? undefined : files.get(key);
      if (key === null || bytes === undefined) return new Response(null, { status: 404 });
      return new Response(request.method === "HEAD" ? null : Uint8Array.from(bytes), { headers: {
        "Cache-Control": "no-store", "Content-Security-Policy": csp,
        "Content-Type": assetContentType(key),
        "Cross-Origin-Opener-Policy": "same-origin", "X-Content-Type-Options": "nosniff",
      } });
    },
  });
  return { artifacts: artifacts(files), bytes: files, origin: `http://127.0.0.1:${server.port}`, stop: async () => { await server.stop(true); } };
}

/** Same complete graph, package registration, shell seal and finalizer as build:app. */
async function buildFixture(root: string, run: string): Promise<ReadonlyMap<string, Buffer>> {
  const {
    createStylexGeneration, finalizeStylexGeneration, prepareStylexProducedTemplate, sealStylexProducedTemplate,
  } = await import("@hraness/ui/stylex-build");
  const { build } = await import("vite");
  const { appProductionConfig } = await import("../app/vite.config");
  const shell = await ordinary(join(root, "app/index.html"));
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
  const files = await inventory(completed);
  const complete = files.get("stylex-complete.json");
  assert.ok(complete !== undefined);
  const expected = parseAppComplete(JSON.parse(complete.toString("utf8")) as unknown);
  assert.deepEqual(artifacts(files).filter((item) => item.path !== "stylex-complete.json"), expected);
  assert.equal(files.get("index.html")?.toString("utf8"), html.replace(APP_CSS_PLACEHOLDER, "/stylex.css"));
  assert.deepEqual(await ordinary(join(root, "app/index.html")), shell);
  // Compiler provenance remains on disk; only finalized public artifacts are served.
  return new Map([...files].filter(([path]) => path !== "stylex-complete.json"));
}

async function settle(page: Page): Promise<void> {
  await boundedBrowserOperation(page.evaluate(async () => {
    await document.fonts.ready;
    await new Promise<void>((done) => { requestAnimationFrame(() => { requestAnimationFrame(() => { done(); }); }); });
  }), 15_000, "Browser font/frame settlement");
}

type ButtonPlacement = "card-content" | "sign-in-form";

export function assertAppColorScheme(value: unknown, profile: Pick<Profile, "forced" | "colorScheme">): void {
  const sample = record(value);
  assert.equal(typeof profile.forced, "boolean");
  assert.equal(sample.forced, profile.forced, "Forced-colors media did not match the requested profile");
  assert.equal(sample.forcedColorAdjust, "auto", "App opted out of the user's forced-color palette");
  // CSS Color Adjustment §3.1 forces the computed value to "light dark".
  // Ordinary profiles, including a light OS preference, retain authored dark.
  assert.equal(sample.colorScheme, profile.forced ? "light dark" : "dark", "App color scheme did not match the verified color-adjustment mode");
}

export function assertDefaultButtonPresentation(value: unknown, placement: ButtonPlacement): void {
  const sample = record(value);
  // CSS Display §2.7 blockifies a flex item's outer display. Only the known
  // sign-in form uses this placement; normal-flow controls remain inline-flex.
  assert.equal(sample.parentTag, placement === "sign-in-form" ? "FORM" : "DIV");
  assert.equal(sample.parentDisplay, placement === "sign-in-form" ? "flex" : "block");
  if (placement === "sign-in-form") assert.equal(sample.parentFlexDirection, "column");
  assert.equal(sample.position, "static");
  assert.equal(sample.float, "none");
  assert.equal(sample.display, placement === "sign-in-form" ? "flex" : "inline-flex");
  // The outer display alone cannot prove recipe delivery. These are distinct
  // root/default-size atoms, unchanged by flex-item blockification or colors.
  for (const [property, expected] of Object.entries({
    alignItems: "center", justifyContent: "center", gap: "8px", minHeight: "44px",
    paddingLeft: "16px", paddingRight: "16px", borderTopLeftRadius: "6px",
    fontSize: "14px", lineHeight: "20px", fontWeight: "500",
  })) assert.equal(sample[property], expected, `Default button lost its ${property} recipe`);
  assert.ok(typeof sample.height === "number" && Number.isFinite(sample.height) && sample.height >= 44);
}

async function styled(locator: Locator, placement: ButtonPlacement): Promise<void> {
  await locator.waitFor({ state: "visible" });
  assertDefaultButtonPresentation(await locator.evaluate((element) => {
    const css = getComputedStyle(element);
    const parent = element.parentElement;
    const parentCss = parent === null ? null : getComputedStyle(parent);
    return {
      parentTag: parent?.tagName ?? null, parentDisplay: parentCss?.display ?? null,
      parentFlexDirection: parentCss?.flexDirection ?? null,
      display: css.display, position: css.position, float: css.cssFloat,
      alignItems: css.alignItems, justifyContent: css.justifyContent, gap: css.gap,
      minHeight: css.minHeight, height: element.getBoundingClientRect().height,
      paddingLeft: css.paddingLeft, paddingRight: css.paddingRight,
      borderTopLeftRadius: css.borderTopLeftRadius,
      fontSize: css.fontSize, lineHeight: css.lineHeight, fontWeight: css.fontWeight,
    };
  }), placement);
}

async function cleanDocument(page: Page): Promise<void> {
  assert.equal(await page.locator("[style],style").count(), 0, "Inline presentation escaped the CSP contract");
  const issues = await page.evaluate(() => {
    const state = window as typeof window & { __hraBrowserViolations?: string[] };
    return state.__hraBrowserViolations ?? [];
  });
  assert.deepEqual(issues, [], "CSP or inline-style mutation occurred");
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), "Horizontal viewport overflow");
}

/** Browser-realm closure: retain the loaded CSSOM objects, never toggle or
 * rewrite a link resource. All other document sheets must remain unchanged. */
export function loadedStylesheetControl(element: Element) {
  const document = element.ownerDocument;
  const view = document.defaultView;
  if (view === null || view.document !== document || !(element instanceof view.HTMLLinkElement)
    || !element.isConnected) throw new Error("Missing ordinary stylesheet link.");
  const target = element.sheet;
  const sheets = [...document.styleSheets];
  if (target === null || target.ownerNode !== element || target.disabled
    || target.href !== element.href || new URL(element.href).origin !== view.location.origin
    || sheets.length === 0 || sheets.length > 32 || sheets.filter((sheet) => sheet === target).length !== 1
    || target.cssRules.length === 0) throw new Error("Missing unique loaded same-origin delivery sheet.");
  let characters = 0;
  const snapshots = sheets.map((sheet) => {
    const rules = sheet.cssRules;
    if (rules.length > 65_536) throw new Error("Stylesheet rule inventory exceeded its bound.");
    const entries = [...rules].map((rule) => {
      const text = rule.cssText;
      characters += text.length;
      if (characters > 64 * 1024 * 1024) throw new Error("Stylesheet text inventory exceeded its bound.");
      return { rule, text };
    });
    const owner = sheet.ownerNode;
    return {
      sheet, owner, connected: owner?.isConnected, href: sheet.href, disabled: sheet.disabled, rules, entries,
      markup: owner instanceof view.Element ? owner.outerHTML : null,
    };
  });
  const assertIdentity = (disabled: boolean) => {
    const current = [...document.styleSheets];
    if (!element.isConnected || element.ownerDocument !== document || element.sheet !== target || element.href !== target.href
      || current.length !== snapshots.length) throw new Error("Delivery stylesheet identity changed.");
    for (const [index, snapshot] of snapshots.entries()) {
      const { sheet, owner, rules, entries } = snapshot;
      if (current[index] !== sheet || sheet.ownerNode !== owner || owner?.isConnected !== snapshot.connected
        || sheet.href !== snapshot.href || sheet.cssRules !== rules || rules.length !== entries.length
        || (owner instanceof view.Element ? owner.outerHTML : null) !== snapshot.markup
        || sheet.disabled !== (sheet === target ? disabled : snapshot.disabled)) {
        throw new Error("Delivery stylesheet inventory changed.");
      }
      for (const [index, entry] of entries.entries()) {
        if (rules[index] !== entry.rule || entry.rule.cssText !== entry.text) throw new Error("Delivery stylesheet rules changed.");
      }
    }
  };
  assertIdentity(false);
  return {
    disable() {
      assertIdentity(false);
      target.disabled = true;
      assertIdentity(true);
    },
    restore() {
      // Restore the exact captured object even if an unrelated identity check
      // failed. Report the drift afterward; never mutate a replacement sheet.
      target.disabled = false;
      assertIdentity(false);
    },
    assertRestored() { assertIdentity(false); },
  };
}

async function negativeStylesheet(page: Page, selector: string, href: string): Promise<void> {
  const sample = () => page.locator(selector).first().evaluate((element) => {
    element.getBoundingClientRect();
    const css = getComputedStyle(element);
    return { display: css.display, height: css.minHeight, padding: css.paddingLeft, border: css.borderTopWidth, font: css.fontSize };
  });
  const before = await sample();
  const sheet = page.locator(`link[rel="stylesheet"][href="${href}"]`);
  assert.equal(await sheet.count(), 1);
  const loadedSheet = await sheet.evaluateHandle(loadedStylesheetControl);
  try {
    try {
      await loadedSheet.evaluate((state) => state.disable());
      await settle(page);
      assert.notDeepEqual(await sample(), before, "Negative control did not detect disabled final CSS");
    } finally { await loadedSheet.evaluate((state) => state.restore()); }
    await settle(page);
    await loadedSheet.evaluate((state) => state.assertRestored());
    assert.deepEqual(await sample(), before, "Final CSS did not restore exactly");
  } finally { await loadedSheet.dispose(); }
}

export function assertNativeModalFocus(value: unknown): void {
  const sample = record(value);
  assert.equal(sample.modal, true, "Dialog lost its native modal state");
  assert.equal(typeof sample.contained, "boolean");
  assert.equal(typeof sample.documentFocused, "boolean");
  // Native dialogs exclude other page controls, but not the browser's own UI.
  // https://www.w3.org/WAI/WCAG21/Techniques/html/H102
  const browserChrome = sample.documentFocused === false
    && sample.activeTag === "BODY" && sample.activeLabel === null;
  assert.ok(sample.contained === true || browserChrome,
    `Native modal allowed focus on background content: ${JSON.stringify(sample)}`);
}

async function primitives(page: Page, profile: Profile): Promise<void> {
  const open = page.getByRole("button", { name: "Open dialog", exact: true });
  await styled(open, "card-content");
  await open.focus();
  await page.keyboard.press("Enter");
  const modal = page.getByRole("dialog", { name: "Fixture dialog", exact: true });
  await modal.waitFor({ state: "visible" });
  assert.ok(await modal.evaluate((element) => element.matches(":modal") && element.contains(document.activeElement)));
  const modalBox = await modal.boundingBox();
  assert.ok(modalBox !== null && modalBox.x >= 0 && modalBox.y >= 0);
  assert.ok(Math.abs(modalBox.x + modalBox.width / 2 - profile.width / 2) <= 1, "Dialog is not horizontally centered");
  assert.ok(Math.abs(modalBox.y + modalBox.height / 2 - profile.height / 2) <= 1, "Dialog is not vertically centered");
  for (const key of ["Tab", "Shift+Tab"]) {
    for (let i = 0; i < 4; i += 1) {
      await page.keyboard.press(key);
      assertNativeModalFocus(await modal.evaluate((element) => ({
        contained: element.contains(document.activeElement), documentFocused: document.hasFocus(),
        activeTag: document.activeElement?.tagName ?? null,
        activeLabel: document.activeElement?.getAttribute("aria-label") ?? null,
        modal: element.matches(":modal"),
      })));
    }
  }
  const modalInput = modal.getByRole("textbox", { name: "Modal text", exact: true });
  await modalInput.focus();
  await open.evaluate((element) => { (element as HTMLElement).focus(); });
  assert.ok(await modalInput.evaluate((element) => document.activeElement === element),
    "Native modal allowed programmatic focus on its inert background");
  await page.keyboard.press("Escape");
  await modal.waitFor({ state: "hidden" });
  assert.ok(await open.evaluate((element) => document.activeElement === element), "Native modal did not restore focus");
  const toggle = page.getByRole("switch", { name: "Fixture switch", exact: true });
  const switchPosition = () => toggle.evaluate((element) => {
    const root = element.getBoundingClientRect();
    const knob = element.firstElementChild?.getBoundingClientRect();
    if (knob === undefined) throw new Error("Switch lost its knob");
    return { x: knob.x, left: root.left, right: root.right, end: knob.right };
  });
  const off = await switchPosition();
  await toggle.focus();
  await page.keyboard.press("Space");
  assert.equal(await toggle.getAttribute("aria-checked"), "true");
  await boundedBrowserOperation(toggle.evaluate(async (element) => {
    await Promise.all(element.getAnimations({ subtree: true }).map((animation) => animation.finished));
  }), 5000, "Switch transition settlement");
  const on = await switchPosition();
  assert.ok(on.x >= on.left && on.end <= on.right, "Checked switch knob escaped its track");
  assert.ok(profile.rtl ? on.x < off.x : on.x > off.x, "Switch did not move toward inline end");
  await page.keyboard.press("Enter");
  assert.equal(await toggle.getAttribute("aria-checked"), "false");
  assert.ok(await page.getByRole("switch", { name: "Disabled switch", exact: true }).isDisabled());
  assert.ok(await page.getByRole("button", { name: "Disabled button", exact: true }).isDisabled());
  await page.getByRole("switch", { name: "Disabled switch", exact: true }).evaluate((element) => { (element as HTMLButtonElement).click(); });
  assert.equal(await page.getByRole("switch", { name: "Disabled switch", exact: true }).getAttribute("aria-checked"), "false");
  const trigger = page.getByRole("button", { name: "Fixture menu", exact: true });
  await trigger.focus();
  await page.keyboard.press("Enter");
  const menu = page.getByRole("menu");
  await menu.waitFor({ state: "visible" });
  assert.ok(await menu.evaluate((element) => document.activeElement === element));
  const menuAnchor = await menu.evaluate((element) => {
    const box = element.getBoundingClientRect();
    const parent = element.parentElement?.getBoundingClientRect();
    if (parent === undefined) throw new Error("Menu lost its anchor");
    return { left: box.left, right: box.right, parentLeft: parent.left, parentRight: parent.right };
  });
  assert.ok(Math.abs(profile.rtl ? menuAnchor.left - menuAnchor.parentLeft : menuAnchor.right - menuAnchor.parentRight) <= 1, "Menu lost its logical end anchor");
  assert.ok(await page.getByRole("menuitem", { name: "Disabled item" }).isDisabled());
  await page.getByRole("menuitem", { name: "Disabled item" }).evaluate((element) => { (element as HTMLButtonElement).click(); });
  assert.equal(await page.getByLabel("Menu selection").textContent(), "none");
  await page.keyboard.press("Tab");
  assert.ok(await page.getByRole("menuitem", { name: "Select item" }).evaluate((element) => document.activeElement === element));
  await page.keyboard.press("Enter");
  assert.equal(await page.getByLabel("Menu selection").textContent(), "selected");
  await trigger.focus();
  await page.keyboard.press("Enter");
  await menu.waitFor({ state: "visible" });
  await page.keyboard.press("Escape");
  await menu.waitFor({ state: "hidden" });
  await open.focus();
  await page.keyboard.press("Tab");
  const focused = await page.locator(":focus").evaluate((element) => {
    const css = getComputedStyle(element);
    return { outline: css.outlineStyle, width: Number.parseFloat(css.outlineWidth), color: css.outlineColor, background: css.backgroundColor };
  });
  assert.notEqual(focused.outline, "none");
  assert.ok(focused.width >= 2, "Keyboard focus ring is not visible");
  if (profile.forced) assert.notEqual(focused.color, focused.background, "Forced-color focus ring lost contrast");
  if (profile.reduced) {
    const duration = await open.evaluate((element) => getComputedStyle(element).transitionDuration);
    assert.ok(duration.split(",").every((part) => Number.parseFloat(part) <= 0.01), "Reduced-motion button transition remains active");
  }
  await page.getByRole("button", { name: "Open sheet", exact: true }).click();
  const sheet = page.getByRole("dialog", { name: "Fixture sheet", exact: true });
  await sheet.waitFor({ state: "visible" });
  const box = await sheet.boundingBox();
  assert.ok(box !== null && box.width <= profile.width + 1 && box.x >= -1);
  assert.ok(box.y >= 0 && Math.abs(box.y + box.height - profile.height) <= 1, "Bottom sheet lost its viewport anchor");
  assert.ok(Math.abs(box.x) <= 1 && Math.abs(box.x + box.width - profile.width) <= 1, "Bottom sheet lost its full-width edges");
  assert.ok(await sheet.evaluate((element) => element.matches(":modal")));
  await page.keyboard.press("Escape");
  await sheet.waitFor({ state: "hidden" });
  await page.getByRole("button", { name: "Open right sheet", exact: true }).click();
  const rightSheet = page.getByRole("dialog", { name: "Fixture right sheet", exact: true });
  await rightSheet.waitFor({ state: "visible" });
  const right = await rightSheet.boundingBox();
  assert.ok(right !== null && right.x >= 0);
  assert.ok(Math.abs(right.width - Math.min(448, profile.width)) <= 1, "Right sheet lost its declared viewport-bounded width");
  assert.ok(Math.abs(right.y) <= 1 && Math.abs(right.height - profile.height) <= 1, "Right sheet lost its full-height edges");
  assert.ok(Math.abs(right.x + right.width - profile.width) <= 1, "Right sheet changed its physical anchor in RTL");
  await page.keyboard.press("Escape");
  await rightSheet.waitFor({ state: "hidden" });
  await negativeStylesheet(page, "button", "/stylex.css");
}

async function safeArea(page: Page, origin: string): Promise<void> {
  const cdp = await page.context().newCDPSession(page);
  try {
    await cdp.send("Emulation.setSafeAreaInsetsOverride", { insets: { top: 19, left: 31, bottom: 23, right: 47 } });
    for (const rtl of [false, true]) {
      await page.goto(`${origin}/?view=grid`);
      await page.evaluate((direction) => { document.documentElement.dir = direction; }, rtl ? "rtl" : "ltr");
      await page.getByLabel("Start a new session").waitFor();
      await settle(page);
      const padding = await page.locator("header").evaluate((element) => {
        const css = getComputedStyle(element);
        return [css.paddingTop, css.paddingLeft, css.paddingRight];
      });
      assert.deepEqual(padding, ["31px", "31px", "47px"], "Physical safe-area edges changed with text direction");
      const bottom = await page.locator("main").evaluate((element) => getComputedStyle(element).paddingBottom);
      assert.equal(bottom, "39px");
      await cleanDocument(page);
    }
  } finally {
    await cdp.send("Emulation.setSafeAreaInsetsOverride", { insets: {} });
    await cdp.detach();
  }
}

async function isolate(context: BrowserContext, origins: ReadonlySet<string>): Promise<Readonly<{ blocked: string[]; errors: string[] }>> {
  const blocked: string[] = [];
  const errors: string[] = [];
  const note = (list: string[], value: string) => {
    if (list.length < 128) list.push(value.slice(0, 500));
    else if (list.length === 128) list.push("Diagnostic limit exceeded");
  };
  context.on("page", (page) => {
    page.on("pageerror", (error) => { note(errors, error.message); });
    page.on("console", (message) => {
      if (message.type() !== "error") return;
      const url = message.location().url;
      // An intentionally blocked external request has a native network error;
      // keep all CSP/runtime/same-origin errors, even if an external request preceded it.
      if (message.text() === "Failed to load resource: net::ERR_FAILED" && /^https?:\/\//u.test(url) && !origins.has(new URL(url).origin)) return;
      note(errors, message.text());
    });
  });
  await context.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (origins.has(url.origin) && ["GET", "HEAD"].includes(route.request().method())) await route.continue();
    else { note(blocked, `${url.protocol}//${url.host}`); await route.abort("failed"); }
  });
  await context.routeWebSocket("**/*", (socket) => { note(blocked, "websocket"); socket.close({ code: 1000, reason: "Offline browser acceptance" }); });
  await context.addInitScript(() => {
    const state = window as typeof window & { __hraBrowserViolations?: string[] };
    const violations: string[] = [];
    state.__hraBrowserViolations = violations;
    const note = (value: string) => { if (violations.length < 128) violations.push(value.slice(0, 500)); };
    document.addEventListener("securitypolicyviolation", (event) => { note(`${event.violatedDirective}:${event.blockedURI}`); });
    new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        if (mutation.type === "attributes" && mutation.attributeName === "style") note("style-attribute-mutation");
        for (const node of mutation.addedNodes) if (node instanceof Element && (node.matches("style,[style]") || node.querySelector("style,[style]") !== null)) note("inline-style-node");
      }
    }).observe(document, { attributes: true, attributeFilter: ["style"], childList: true, subtree: true });
  });
  return { blocked, errors };
}

export async function runAppBrowser(rootDirectory: string): Promise<void> {
  assert.equal(Bun.version, "1.3.14");
  const root = await realpath(rootDirectory);
  const executable = process.env.CHROMIUM_EXECUTABLE_PATH;
  assert.ok(executable !== undefined && executable.startsWith("/"), "Set CHROMIUM_EXECUTABLE_PATH to an explicit Chromium executable");
  const executableSha256 = await browserExecutableSha256(executable);
  const packageBytes = await ordinary(join(root, "package.json"));
  const lockBytes = await ordinary(join(root, "bun.lock"));
  const playwrightPackage = record(JSON.parse(await readFile(new URL(import.meta.resolve("playwright-core/package.json")), "utf8")) as unknown);
  assert.equal(playwrightPackage.version, "1.62.0");
  const { chromium } = await import("playwright-core");
  const appFiles = await inventory(join(root, "app/dist"));
  const siteFiles = await inventory(join(root, "dist/site"));
  const appCsp = productionCsp(JSON.parse((await ordinary(join(root, "app/vercel.json"))).toString("utf8")) as unknown, "/(.*)");
  const siteCsp = productionCsp(JSON.parse((await ordinary(join(root, "vercel.json"))).toString("utf8")) as unknown, "/((?!preview/?$).*)");
  const temporaryRoot = join(root, "tmp");
  await mkdir(temporaryRoot, { recursive: true });
  assert.equal(await realpath(temporaryRoot), temporaryRoot);
  const run = await mkdtemp(join(temporaryRoot, "app-browser-"));
  const evidence: Evidence[] = [];
  const profileDiagnostics: { name: string; step: string; events: string[]; ownedPids: number[]; failure: BrowserFailure | undefined }[] = [];
  let fixtureArtifacts: readonly Artifact[] = [];
  const servers: Surface[] = [];
  const owner: { current: BrowserContext | null } = { current: null };
  const cancellation = new AbortController();
  let cancelled = false;
  // The sole cleanup path takes a fresh census before closing. Do not race it
  // with an unawaited close from a signal callback.
  const onSignal = () => { cancelled = true; cancellation.abort(); };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  let failure: unknown;
  try {
    const fixtureFiles = await buildFixture(root, run);
    fixtureArtifacts = artifacts(fixtureFiles);
    assert.ok(!cancelled, "Browser acceptance cancelled");
    const app = await serve(appFiles, appCsp); servers.push(app);
    const fixture = await serve(fixtureFiles, appCsp); servers.push(fixture);
    const site = await serve(siteFiles, siteCsp); servers.push(site);
    for (const profile of profiles) {
      assert.ok(!cancelled, "Browser acceptance cancelled");
      const userData = await mkdtemp(join(run, "profile-"));
      let closed = false;
      let profileFailure: unknown;
      let profileWork: Promise<void> | undefined;
      const pids: number[] = [];
      const diagnostics = { name: profile.name, step: "launch", events: [] as string[], ownedPids: pids, failure: undefined as BrowserFailure | undefined };
      profileDiagnostics.push(diagnostics);
      const note = (message: string) => { if (diagnostics.events.length === 64) diagnostics.events.shift(); diagnostics.events.push(message.slice(0, 500)); };
      try {
        const context = await chromium.launchPersistentContext(userData, {
          executablePath: executable, headless: true, viewport: { width: profile.width, height: profile.height },
          hasTouch: profile.coarse, isMobile: profile.coarse, deviceScaleFactor: 1,
          reducedMotion: profile.reduced ? "reduce" : "no-preference", forcedColors: profile.forced ? "active" : "none",
          colorScheme: profile.colorScheme ?? "dark", locale: "en-US", timezoneId: "UTC", serviceWorkers: "block", permissions: [],
          args: ["--disable-background-networking", "--disable-component-update", "--disable-sync", "--no-first-run"],
          timeout: 30_000,
        });
        owner.current = context;
        assert.ok(!cancelled, "Browser acceptance cancelled during launch");
        // A profile-level deadline also covers raw evaluate/CDP promises that
        // are not covered by Playwright's action or navigation timeouts.
        profileWork = (async () => {
        context.setDefaultTimeout(15_000);
        context.setDefaultNavigationTimeout(20_000);
        diagnostics.step = "isolation:install";
        const isolation = await isolate(context, new Set(servers.map((server) => server.origin)));
        diagnostics.step = "page:create";
        const page = await context.newPage();
        page.on("crash", () => note("page-crashed"));
        page.on("close", () => note("page-closed"));
        page.on("requestfailed", (request) => note(`request-failed:${request.resourceType()}:${new URL(request.url()).pathname}:${request.failure()?.errorText ?? "unknown"}`));
        page.on("domcontentloaded", () => note("dom-content-loaded"));
        page.on("load", () => note("page-loaded"));
        const browser = context.browser();
        assert.ok(browser !== null);
        browser.on("disconnected", () => note("browser-disconnected"));
        const browserVersion = browser.version();
        diagnostics.step = "browser-census:connect";
        const browserCdp = await browser.newBrowserCDPSession();
        diagnostics.step = "browser-census:read";
        const census = await browserCdp.send("SystemInfo.getProcessInfo");
        for (const entry of census.processInfo) {
          assert.ok(Number.isSafeInteger(entry.id) && entry.id > 0 && entry.id !== process.pid);
          pids.push(entry.id);
        }
        assert.ok(pids.length > 0);
        diagnostics.step = "browser-census:detach";
        await browserCdp.detach();
        diagnostics.step = "production-anonymous:navigation";
        await page.goto(app.origin);
        await page.getByRole("heading", { name: "Sign in to HRA" }).waitFor();
        assert.deepEqual(await page.evaluate(() => ({
          coarse: matchMedia("(pointer: coarse)").matches,
          reduced: matchMedia("(prefers-reduced-motion: reduce)").matches,
          forced: matchMedia("(forced-colors: active)").matches,
        })), { coarse: profile.coarse, reduced: profile.reduced, forced: profile.forced });
        await styled(page.getByRole("button", { name: "Send code", exact: true }), "sign-in-form");
        assertAppColorScheme(await page.evaluate(() => {
          const css = getComputedStyle(document.documentElement);
          return {
            forced: matchMedia("(forced-colors: active)").matches,
            colorScheme: css.colorScheme, forcedColorAdjust: css.forcedColorAdjust,
          };
        }), profile);
        await cleanDocument(page);
        await negativeStylesheet(page, "button", "/stylex.css");
        evidence.push({ name: `${profile.name}:production-anonymous`, values: { browserVersion, finalCssSha256: digest(appFiles.get("stylex.css") ?? "") } });
        for (const view of ["signin", "locked", "enrollment", "grid", "session", "session-long", "retired", "settings", "primitives"]) {
          assert.ok(!cancelled, "Browser acceptance cancelled");
          diagnostics.step = `fixture:${view}:navigation`;
          await page.goto(`${fixture.origin}/?view=${view}`);
          diagnostics.step = `fixture:${view}:assertions`;
          await page.evaluate((direction) => { document.documentElement.dir = direction; }, profile.rtl ? "rtl" : "ltr");
          await page.locator("#root button").first().waitFor();
          await settle(page);
          await cleanDocument(page);
          if (view === "grid") {
            const cards = page.locator("[data-session-id]");
            assert.equal(await cards.count(), 3);
            const before = await cards.evaluateAll((elements) => elements.map((element) => element.getAttribute("data-session-id")));
            await cards.first().getByRole("button", { name: /^Reorder /u }).focus();
            await page.keyboard.press("ArrowRight");
            await settle(page);
            assert.deepEqual(await cards.evaluateAll((elements) => elements.map((element) => element.getAttribute("data-session-id"))), [before[1], before[0], before[2]], "Keyboard card ordering did not preserve the displayed permutation");
            assert.ok(await page.getByLabel("Start a new session").isEnabled());
            assert.ok(await page.getByRole("button", { name: "Start", exact: true }).isDisabled());
            await page.getByLabel("Start a new session").fill("Fixture prompt only");
            assert.ok(await page.getByRole("button", { name: "Start", exact: true }).isEnabled());
          }
          if (view === "session" || view === "session-long" || view === "retired") {
            assert.ok(await page.getByRole("heading", { name: "Browser fixture session", exact: true }).isVisible());
            assert.ok(await page.getByText("compiled presentation", { exact: true }).isVisible());
            const bubble = await page.getByText("Review the browser fixture", { exact: true }).evaluate((element) => {
              const css = getComputedStyle(element);
              return { left: css.borderTopLeftRadius, right: css.borderTopRightRadius };
            });
            assert.deepEqual(bubble, profile.rtl ? { left: "2px", right: "8px" } : { left: "8px", right: "2px" }, "User bubble lost its logical start-end corner");
            const gutter = await page.locator("ul").first().evaluate((element) => {
              const css = getComputedStyle(element);
              return { left: css.paddingLeft, right: css.paddingRight };
            });
            assert.deepEqual(gutter, profile.rtl ? { left: "0px", right: "20px" } : { left: "20px", right: "0px" }, "Markdown list gutter did not follow inline start");
            for (const name of ["Attach a file", "Message this session", "Stop the turn"]) {
              assert.equal(await page.getByLabel(name, { exact: true }).isDisabled(), view === "retired");
            }
            await page.getByRole("button", { name: "Session menu", exact: true }).click();
            await page.getByRole("dialog").waitFor({ state: "visible" });
            await page.keyboard.press("Escape");
            await page.getByRole("dialog").waitFor({ state: "hidden" });
            if (view === "session-long") {
              const quote = await page.locator("blockquote").first().evaluate((element) => {
                const css = getComputedStyle(element);
                return { left: css.borderLeftWidth, right: css.borderRightWidth, paddingLeft: css.paddingLeft, paddingRight: css.paddingRight };
              });
              assert.deepEqual(quote, profile.rtl
                ? { left: "0px", right: "2px", paddingLeft: "0px", paddingRight: "12px" }
                : { left: "2px", right: "0px", paddingLeft: "12px", paddingRight: "0px" }, "Markdown quote gutter did not follow inline start");
              const scroller = page.locator("#root div").filter({ has: page.getByText("compiled presentation", { exact: true }) });
              const scroll = await scroller.evaluateAll((elements) => {
                const target = elements.find((element) => getComputedStyle(element).overflowY === "auto");
                if (!(target instanceof HTMLElement)) return null;
                target.scrollTop = 0;
                const start = target.scrollTop;
                target.scrollTop = target.scrollHeight;
                return { start, end: target.scrollTop, viewport: target.clientHeight, content: target.scrollHeight,
                  pageHeight: document.documentElement.scrollHeight, screen: innerHeight };
              });
              assert.ok(scroll !== null && scroll.start === 0 && scroll.end > 0 && scroll.content > scroll.viewport);
              assert.ok(scroll.pageHeight <= scroll.screen + 1, "Long history escaped its bounded transcript scroller");
              assert.ok(await page.getByLabel("Message this session", { exact: true }).isVisible());
            }
          }
          if (view === "settings") {
            assert.ok(await page.getByRole("heading", { name: "Settings", exact: true }).isVisible());
            assert.ok((await page.getByText("Fixture machine", { exact: true }).count()) > 0);
          }
          if (view === "primitives") await primitives(page, profile);
          await cleanDocument(page);
          if (view === "grid" || view === "session" || view === "settings" || view === "primitives") {
            await page.screenshot({ path: join(run, `${profile.name}-${view}.png`), fullPage: false });
          }
          evidence.push({ name: `${profile.name}:fixture:${view}`, values: "passed" });
        }
        if (profile.name === "desktop") {
          diagnostics.step = "asymmetric-safe-area";
          await safeArea(page, fixture.origin);
          evidence.push({ name: "asymmetric-safe-area:ltr+rtl", values: { top: 19, left: 31, bottom: 23, right: 47 } });
        }
        diagnostics.step = "static-site:navigation";
        await page.goto(site.origin);
        diagnostics.step = "static-site:assertions";
        await page.locator("h1").waitFor({ state: "visible" });
        await settle(page);
        await cleanDocument(page);
        assert.equal(await page.evaluate(() => matchMedia("(prefers-color-scheme: light)").matches), profile.colorScheme === "light");
        if (!profile.forced) assert.equal(await page.locator("html").evaluate((element) => getComputedStyle(element).backgroundColor), profile.colorScheme === "light" ? "rgb(251, 250, 247)" : "rgb(20, 19, 16)");
        assert.ok(await page.locator("h1").evaluate((element) => Number.parseFloat(getComputedStyle(element).fontSize) > 24));
        await negativeStylesheet(page, "h1", "/styles.css");
        evidence.push({ name: `${profile.name}:static-site`, values: "passed" });
        assert.deepEqual(isolation.errors, [], "Browser runtime or resource failure");
        evidence.push({ name: `${profile.name}:isolation`, values: { blocked: [...new Set(isolation.blocked)].sort(), cspErrors: 0, runtimeErrors: 0 } });
        })();
        await boundedBrowserOperation(profileWork, 120_000, `Browser profile ${profile.name}`, cancellation.signal);
      } catch (error) { profileFailure = error; diagnostics.failure = browserFailureDetails(error);
      } finally {
        if (owner.current !== null) {
          try {
            await closeOwnedBrowser(owner.current, pids);
            // Closing the owned browser rejects outstanding renderer work.
            // Do not remove its profile while the operation remains unsettled.
            if (profileWork !== undefined) await boundedBrowserOperation(profileWork.catch(() => undefined), 5000, "Browser profile task settlement");
            owner.current = null;
            closed = true;
            evidence.push({ name: `${profile.name}:browser-cleanup`, values: { ownedProcesses: pids.length, survivors: 0, pages: 0 } });
          } catch (error) {
            profileFailure = profileFailure === undefined ? error : new AggregateError([profileFailure, error], "Browser profile and cleanup failed");
          }
        }
        // Only this run's fresh browser profile, and only after close completed.
        // Finalized fixture outputs and receipts are deliberately retained.
        if (closed) {
          assert.equal(dirname(userData), run);
          assert.equal(await realpath(userData), userData);
          await rm(userData, { recursive: true });
        }
        if (profileFailure !== undefined) throw profileFailure;
        diagnostics.step = "complete";
      }
    }
    assert.deepEqual(artifacts(await inventory(join(root, "app/dist"))), artifacts(appFiles));
    assert.deepEqual(artifacts(await inventory(join(root, "dist/site"))), artifacts(siteFiles));
    assert.deepEqual(await ordinary(join(root, "package.json")), packageBytes);
    assert.deepEqual(await ordinary(join(root, "bun.lock")), lockBytes);
    assert.ok(!cancelled, "Browser acceptance cancelled");
  } catch (error) { failure = error; }
  finally {
    try {
      // A failed collection leaves its profile and receipt for recovery. Closing
      // the context again cannot retroactively prove the missing process census.
      if (owner.current !== null) await boundedBrowserOperation(owner.current.close(), 20_000, "Final browser close");
    } catch (error) {
      failure = failure === undefined ? error : new AggregateError([failure, error], "Browser gate and final close failed");
    } finally {
      for (const server of servers) {
        try { await boundedBrowserOperation(server.stop(), 5000, "Browser fixture server stop"); }
        catch (error) { failure = failure === undefined ? error : new AggregateError([failure, error], "Browser gate and server cleanup failed"); }
      }
      process.off("SIGINT", onSignal); process.off("SIGTERM", onSignal);
      const receipt = {
        schemaVersion: 1, kind: "hra-app-browser-acceptance", state: failure === undefined && !cancelled ? "passed" : "failed",
        browserExecutableSha256: executableSha256, playwright: "1.62.0", bun: Bun.version,
        packageSha256: digest(packageBytes), lockSha256: digest(lockBytes),
        app: artifacts(appFiles), site: artifacts(siteFiles), fixture: fixtureArtifacts,
        appCspSha256: digest(appCsp), siteCspSha256: digest(siteCsp),
        fixtureIoAliases: ["@convex-dev/auth/react", ...browserIoModules], evidence,
        profileDiagnostics, ...(failure === undefined ? {} : { failure: browserFailureDetails(failure) }),
      };
      await writeFile(join(run, "receipt.json"), `${JSON.stringify(receipt, null, 2)}\n`, { flag: "wx", mode: 0o600 });
      console.log(`Browser acceptance ${receipt.state}; ${evidence.length} evidence rows; receipt ${run.slice(root.length + 1)}/receipt.json`);
    }
  }
  assert.ok(!cancelled, "Browser acceptance cancelled");
  if (failure !== undefined) throw failure;
}

if (import.meta.main) await runAppBrowser(resolve(import.meta.dirname, ".."));
