import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdtemp, open, readdir, readFile, realpath, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseHTML } from "linkedom";
import { transform } from "lightningcss";
import type { BrowserContext, Locator, Page, Response as BrowserResponse } from "playwright-core";
import { browserIoModules } from "../app/fixtures/browser/config";
import { assertBrowserNode, browserDigest, browserExecutable, browserPublicArtifacts, publishBrowserJson, type BrowserExecutionAdmission } from "./app-browser-handoff.ts";
import { serveBrowserAssets } from "./app-browser-server.ts";
import { readRestoredStyleFramePair, settleExactStylesheet, StylesheetSettlementError, type StylesheetSettlementDiagnostics } from "./app-browser-settlement.ts";

type Artifact = Readonly<{ bytes: number; path: string; sha256: string }>;
type Surface = Readonly<{ artifacts: readonly Artifact[]; bytes: ReadonlyMap<string, Buffer>; origin: string; stop: () => Promise<void> }>;
type Evidence = Readonly<{ name: string; values: unknown }>;
export type BrowserCustodyObservation =
  | Readonly<{ kind: "preparation-owned"; run: string; identity: Readonly<{ pid: number; parent: number; group: number; started: string }> }>
  | Readonly<{ kind: "partial-servers-owned"; run: string; origins: readonly string[] }>
  | Readonly<{ kind: "browser-census-owned"; run: string; origins: readonly string[]; pids: readonly number[] }>;
export type BrowserCustodyObserver = (observation: BrowserCustodyObservation) => undefined;

/** Observation carries copied identity data, never resource handles or alternate
 * operations. Production has no observer; native custody fixtures may fail or
 * self-signal here, inside the existing owner and cleanup boundary. */
export function observeBrowserCustody(observer: BrowserCustodyObserver | undefined, observation: BrowserCustodyObservation): void {
  if (observer === undefined) return;
  const frozen = observation.kind === "preparation-owned"
    ? Object.freeze({ ...observation, identity: Object.freeze({ ...observation.identity }) })
    : observation.kind === "partial-servers-owned"
      ? Object.freeze({ ...observation, origins: Object.freeze([...observation.origins]) })
      : Object.freeze({ ...observation, origins: Object.freeze([...observation.origins]), pids: Object.freeze([...observation.pids]) });
  assert.equal(observer(frozen), undefined, "Browser custody observation must finish synchronously");
}
type BrowserFailure = Readonly<{ name: string; message: string; cause?: BrowserFailure; errors?: readonly BrowserFailure[]; settlement?: StylesheetSettlementDiagnostics }>;
export function browserFailureDetails(value: unknown, depth = 0): BrowserFailure {
  if (!(value instanceof Error)) return { name: "UnknownFailure", message: typeof value === "string" ? value.slice(0, 1000) : typeof value };
  return {
    name: value.name.slice(0, 80), message: value.message.slice(0, 1000),
    ...(value instanceof StylesheetSettlementError ? { settlement: value.diagnostics } : {}),
    ...(depth < 3 && value.cause !== undefined ? { cause: browserFailureDetails(value.cause, depth + 1) } : {}),
    ...(depth < 3 && value instanceof AggregateError ? { errors: value.errors.slice(0, 8).map((error: unknown) => browserFailureDetails(error, depth + 1)) } : {}),
  };
}
type Profile = Readonly<{ name: string; width: number; height: number; coarse: boolean; reduced: boolean; forced: boolean; rtl: boolean; colorScheme?: "dark" | "light" }>;
const fixtureViews = ["signin", "locked", "enrollment", "grid", "session", "session-long", "retired", "settings", "primitives"] as const;
const profiles: readonly Profile[] = [
  { name: "desktop", width: 1280, height: 900, coarse: false, reduced: false, forced: false, rtl: false },
  { name: "light-os", width: 1280, height: 900, coarse: false, reduced: false, forced: false, rtl: false, colorScheme: "light" },
  { name: "narrow-coarse", width: 390, height: 844, coarse: true, reduced: false, forced: false, rtl: false },
  { name: "reduced-motion", width: 1280, height: 900, coarse: false, reduced: true, forced: false, rtl: false },
  { name: "forced-colors", width: 1280, height: 900, coarse: false, reduced: false, forced: true, rtl: false },
  { name: "rtl", width: 390, height: 844, coarse: true, reduced: false, forced: false, rtl: true },
];
const negativeStylesheetSubsteps = [
  "sample-before", "link-count", "capture", "disable", "settle-disabled", "sample-disabled",
  "restore", "settle-restored", "identity-restored", "sample-restored", "dispose",
] as const;
type NegativeStylesheetSubstep = typeof negativeStylesheetSubsteps[number];
type NegativeStylesheetReporter = (step: NegativeStylesheetSubstep, phase: "entered" | "settled" | "failed", error?: unknown) => void;
const browserDiagnosticSteps = new Set([
  "launch", "isolation:install", "page:create", "browser-census:connect", "browser-census:read", "browser-census:detach",
  "production-anonymous:navigation", "production-anonymous:assertions", "production-anonymous:negative-css",
  "asymmetric-safe-area", "isolation:assertions", "cleanup", "complete",
  ...fixtureViews.flatMap((view) => ["navigation", "assertions", "screenshot"].map((step) => `fixture:${view}:${step}`)),
  ...["home", "privacy", "preview"].flatMap((route) => [
    "navigation", "document-bytes", "direction", "heading", "settle-before-fonts", "font-load", "settle-after-fonts",
    "document-clean", "stylesheet-links", "stylesheet-inventory", "color-scheme", "background", "heading-style", "inertness",
    "negative-final-css", "negative-foundation-css", "negative-document-clean", "resource-bytes", "mobile-anchors",
  ].map((step) => `static-site:${route}:${step}`)),
  ...["production-anonymous:negative-css", "fixture:primitives:negative-css", ...["home", "privacy", "preview"].flatMap((route) =>
    [`static-site:${route}:negative-final-css`, `static-site:${route}:negative-foundation-css`])]
    .flatMap((parent) => negativeStylesheetSubsteps.map((step) => `${parent}:${step}`)),
]);
type BrowserProfileDiagnostics = {
  name: string; step: string; failureStep: string | undefined; events: string[]; ownedPids: number[]; failure: BrowserFailure | undefined;
};

/** Public logs contain only finite labels, never an Error message, URL, PID or page sample. */
export function browserDiagnosticLine(profile: unknown, step: unknown, phase: unknown, error?: unknown, elapsedMs?: unknown): string {
  const safeProfile = typeof profile === "string" && profiles.some(({ name }) => name === profile) ? profile : "unknown-profile";
  const safeStep = typeof step === "string" && browserDiagnosticSteps.has(step) ? step : "unknown-step";
  const safePhase = typeof phase === "string" && ["progress", "after-failure", "entered", "settled", "failed", "cleanup-failed"].includes(phase) ? phase : "unknown-phase";
  return `Browser diagnostic ${JSON.stringify({ profile: safeProfile, step: safeStep, phase: safePhase,
    ...(elapsedMs === undefined ? {} : { elapsedMs: typeof elapsedMs === "number" && Number.isFinite(elapsedMs)
      ? Math.min(3_600_000, Math.max(0, Math.trunc(elapsedMs))) : 0 }),
    ...(safePhase === "failed" || safePhase === "cleanup-failed" ? { failure: browserFailureClass(error) } : {}),
  })}`;
}

export function browserFailureClass(value: unknown): string {
  if (!(value instanceof Error)) return "unknown";
  if (value instanceof AggregateError) return "aggregate";
  if (value.name === "AssertionError") return "assertion";
  if (value.name === "TimeoutError" || /^Browser profile [a-z-]+ exceeded 120000ms$/u.test(value.message)
    || value.message === "Browser font/frame settlement exceeded 15000ms"
    || /^(?:Closing browser census session|Closing browser process census|Browser census detach|Owned browser close|Final browser close) exceeded (?:5000|20000)ms$/u.test(value.message)) return "deadline";
  if (value.name === "AbortError" || /^Browser (?:profile [a-z-]+|acceptance) cancelled(?: during launch)?$/u.test(value.message)) return "cancelled";
  return "error";
}

/** The profile promise may settle later during cleanup. Freeze its first failed step now. */
export function recordBrowserProfileFailure(diagnostics: Pick<BrowserProfileDiagnostics, "step" | "failureStep" | "failure">, error: unknown): void {
  if (diagnostics.failureStep !== undefined) return;
  diagnostics.failureStep = diagnostics.step;
  diagnostics.failure = browserFailureDetails(error);
}

/** Observe only: racing a still-running CSSOM mutation against a new timer could
 * start restoration before that mutation settles. Keep the existing budgets. */
export async function browserNegativeStep<T>(step: NegativeStylesheetSubstep, operation: () => Promise<T>, report: NegativeStylesheetReporter): Promise<T> {
  report(step, "entered");
  try {
    const result = await operation();
    report(step, "settled");
    return result;
  } catch (error) {
    report(step, "failed", error);
    throw error instanceof Error ? error : new Error("Browser stylesheet operation failed", { cause: error });
  }
}

/** Await the exact cleanup even after failure, retaining both errors instead of
 * letting an awaited finally replace the original operation failure. */
export async function withBrowserNegativeCleanup<T>(operation: () => Promise<T>, cleanup: () => Promise<void>, stage: "restore" | "dispose"): Promise<T> {
  let result: { value: T } | { error: unknown };
  try { result = { value: await operation() }; }
  catch (error) { result = { error }; }
  try { await cleanup(); }
  catch (error) {
    if ("error" in result) throw new AggregateError([result.error, error], `Browser stylesheet operation and ${stage} failed`);
    throw error instanceof Error ? error : new Error(`Browser stylesheet ${stage} failed`, { cause: error });
  }
  if ("error" in result) throw result.error instanceof Error ? result.error : new Error("Browser stylesheet operation failed", { cause: result.error });
  return result.value;
}
const digest = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
const bracketedFontPath = "fonts/geist-mono/GeistMono[wght].woff2";
const fontProvenancePaths = new Set([
  "fonts/geist-mono/PROVENANCE.md", "fonts/nebula-sans/PROVENANCE.md",
]);
const legacyFontPaths = new Set([bracketedFontPath]);
const siteRoutes = [
  { path: "index.html", pathname: "/", heading: "h1" },
  { path: "privacy/index.html", pathname: "/privacy/", heading: "#privacy-heading" },
  { path: "preview/index.html", pathname: "/preview/", heading: "h1" },
] as const;
const sitePublicFonts = [
  ...["Light", "LightItalic", "Book", "BookItalic", "Medium", "MediumItalic", "Semibold", "SemiboldItalic", "Bold", "BoldItalic", "Black", "BlackItalic"]
    .map((cut) => `nebula-sans/NebulaSans-${cut}.woff2`),
  "geist-mono/GeistMono[wght].woff2",
];
const sitePublicSupport = [
  "analytics.js", "favicon.svg", "social-card.svg", "social-card.png", "robots.txt", "sitemap.xml", "llms.txt",
  ".well-known/security.txt", ".well-known/hra.json",
  "fonts/nebula-sans/LICENSE.txt", "fonts/nebula-sans/PROVENANCE.md",
  "fonts/geist-mono/OFL.txt", "fonts/geist-mono/PROVENANCE.md",
];
const diagnosticPath = (path: string) => JSON.stringify(path.slice(0, 160));

function capturedFontKey(key: string, fontPaths: ReadonlySet<string>): boolean {
  return fontPaths.has(key) && (key === bracketedFontPath
    || /^graphs\/foundation\/assets\/[A-Za-z0-9_.[\]-]+\.woff2$/u.test(key));
}

function safeInventoryKey(key: string, fontPaths: ReadonlySet<string> = legacyFontPaths): boolean {
  return key.length <= 2048 && (capturedFontKey(key, fontPaths)
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

export function siteProductionCsp(value: unknown): Readonly<{ siteCsp: string; previewCsp: string }> {
  const siteCsp = productionCsp(value, "/((?!preview/?$).*)");
  const previewCsp = productionCsp(value, "/preview/");
  for (const csp of [siteCsp, previewCsp]) {
    assert.deepEqual(csp.split(";").map((part) => part.trim()).filter((part) => part.startsWith("font-src")), ["font-src 'self'"]);
  }
  assert.deepEqual(previewCsp.split(";").map((part) => part.trim()).filter((part) => part.startsWith("script-src")), ["script-src 'none'"]);
  return { siteCsp, previewCsp };
}

/** URL normalization cannot turn a request into an arbitrary filesystem read. */
export function assetPath(pathname: string, fontPaths: ReadonlySet<string> = legacyFontPaths): string | null {
  if (pathname.length > 2048 || pathname.split("/").length > 14) return null;
  if (pathname === "/") return "index.html";
  // Only captured font keys may use brackets. Decode no other URL escapes:
  // encoded separators, double encodings and dot segments remain closed.
  const fontKey = pathname.slice(1).replace(/%5b/giu, "[").replace(/%5d/giu, "]");
  if (pathname.startsWith("/") && capturedFontKey(fontKey, fontPaths)) return fontKey;
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
    if (censusFailure === undefined) throw error;
    throw new AggregateError([censusFailure, error], "Browser census and collection failed; profile retained");
  }
  if (censusFailure !== undefined) throw censusFailure instanceof Error
    ? censusFailure : new Error("Browser census failed; profile retained", { cause: censusFailure });
}

export async function inventory(directory: string, fontPaths: ReadonlySet<string> = legacyFontPaths): Promise<ReadonlyMap<string, Buffer>> {
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
      assert.ok(safeInventoryKey(key, fontPaths), `Unsafe public browser output name: ${diagnosticPath(key)}`);
      assert.ok(!entry.isSymbolicLink(), `Linked public browser output: ${diagnosticPath(key)}`);
      if (capturedFontKey(key, fontPaths) || fontProvenancePaths.has(key)) {
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

/** Read the actual sealed HTML join, not a guessed Vite asset name. */
export function siteStylesheetPaths(documents: ReadonlyMap<string, Buffer>): readonly [string, string] {
  let expected: readonly [string, string] | undefined;
  for (const { path } of siteRoutes) {
    const bytes = documents.get(path);
    assert.ok(bytes !== undefined && bytes.length > 0 && bytes.length <= 8 * 1024 * 1024, `Missing bounded site document: ${path}`);
    const { document } = parseHTML(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    assert.equal(document.querySelectorAll("style,[style],base").length, 0, "Static document changed its no-inline/base contract");
    const links = [...document.querySelectorAll("link")].filter((link) => link.getAttribute("rel")?.toLowerCase().split(/\s+/u).includes("stylesheet"));
    assert.equal(links.length, 2, "Static document must link exactly foundation then union");
    for (const link of links) {
      assert.equal(link.parentElement, document.head);
      assert.deepEqual([...link.attributes].map(({ name }) => name).sort(), ["href", "rel"]);
      assert.equal(link.getAttribute("rel"), "stylesheet");
    }
    const foundation = links[0]?.getAttribute("href");
    assert.ok(typeof foundation === "string");
    assert.match(foundation, /^\/graphs\/foundation\/assets\/[A-Za-z0-9_.-]+\.css$/u);
    assert.equal(links[1]?.getAttribute("href"), "/stylex.css");
    const paths = [foundation.slice(1), "stylex.css"] as const;
    if (expected !== undefined) assert.deepEqual(paths, expected, "Static routes disagree about the completed stylesheet graph");
    expected = paths;
  }
  assert.ok(expected !== undefined);
  return expected;
}

/** Parse native CSS URLs and all font-face sources. A path becomes admissible
 * only because this captured foundation names it; escaping never broadens it. */
export function siteFoundationFontPaths(path: string, bytes: Buffer): readonly string[] {
  assert.match(path, /^graphs\/foundation\/assets\/[A-Za-z0-9_.-]+\.css$/u);
  assert.ok(bytes.length > 0 && bytes.length <= 16 * 1024 * 1024);
  const faces: string[] = [];
  // Dependency analysis also includes image-set string URLs, which the Url
  // visitor alone omits. The transformed bytes are never served or published.
  const parsed = transform({ filename: path, code: bytes, analyzeDependencies: true, visitor: {
    Rule: {
      import() { throw new Error("Static foundation contains an uncollected CSS import"); },
      "font-face"(rule) {
        const sources = rule.value.properties.filter((property) => property.type === "source");
        assert.equal(sources.length, 1);
        const source = sources[0];
        assert.ok(source?.type === "source" && source.value.length === 1);
        const url = source.value[0];
        assert.ok(url?.type === "url" && url.value.format?.type === "woff2", "Static font face is not one physical WOFF2 source");
        faces.push(url.value.url.url);
      },
    },
  } });
  assert.equal(parsed.warnings.length, 0, "Static foundation CSS inspection emitted warnings");
  assert.ok(parsed.dependencies !== undefined && parsed.dependencies.length <= 64,
    "Static foundation has an invalid or excessive resource inventory");
  const urls = parsed.dependencies.map((dependency) => {
    assert.ok(dependency.type === "url", "Static foundation contains an uncollected CSS import or unsupported resource");
    return dependency.url;
  });
  assert.equal(faces.length, 13, "Static foundation must declare all thirteen public font faces");
  assert.deepEqual([...urls].sort(), [...faces].sort(), "Static foundation contains a non-font URL");
  assert.equal(new Set(faces).size, 13, "Static foundation duplicates a font URL");
  return faces.map((url) => {
    // Vite may preserve or sanitize brackets. Both must come from captured CSS,
    // stay in this asset directory, and later match a public input's full hash.
    const decoded = url.replace(/%5b/giu, "[").replace(/%5d/giu, "]");
    assert.match(decoded, /^(?:\.\/)?[A-Za-z0-9_.[\]-]+\.woff2$/u, "Static font URL escaped its captured asset directory");
    const resolved = new URL(decoded, `https://site.invalid/${path}`);
    assert.equal(resolved.origin, "https://site.invalid");
    assert.equal(resolved.search + resolved.hash, "");
    return resolved.pathname.slice(1);
  }).sort();
}

export function snapshotStaticSite(files: ReadonlyMap<string, Buffer>, publicFonts: ReadonlyMap<string, Buffer>) {
  assert.deepEqual([...files.keys()].filter((path) => path.endsWith(".html")).sort(), siteRoutes.map(({ path }) => path).sort());
  const stylesheets = siteStylesheetPaths(files);
  assert.deepEqual([...files.keys()].filter((path) => path.endsWith(".css")).sort(), [...stylesheets].sort());
  const foundation = files.get(stylesheets[0]);
  const union = files.get(stylesheets[1]);
  assert.ok(foundation !== undefined && union !== undefined && union.length > 0);
  const fonts = siteFoundationFontPaths(stylesheets[0], foundation);
  assert.deepEqual([...files.keys()].sort(), [...siteRoutes.map(({ path }) => path), ...stylesheets, ...fonts, ...sitePublicSupport].sort(), "Static publication contains a missing or unapproved public artifact");
  assert.deepEqual([...files.keys()].filter((path) => /\.woff2?$/u.test(path)).sort(), fonts, "Static font publication is incomplete or redundant");
  assert.deepEqual([...files.keys()].filter((path) => path.startsWith("graphs/")).sort(), [stylesheets[0], ...fonts].sort(), "Private graph artifacts escaped publication");
  assert.equal(publicFonts.size, 13);
  assert.deepEqual([...publicFonts.keys()].sort(), [...sitePublicFonts].sort());
  const emitted = fonts.map((path) => {
    const bytes = files.get(path);
    assert.ok(bytes !== undefined && bytes.length > 0 && bytes.length <= 1024 * 1024);
    return digest(bytes);
  }).sort();
  assert.deepEqual(emitted, [...publicFonts.values()].map(digest).sort(), "Published fonts differ from the installed public inputs");
  const parsedUnion = transform({ filename: "stylex.css", code: union, analyzeDependencies: true, visitor: {
    Rule: { import() { throw new Error("Final union contains an uncollected CSS import"); } },
  } });
  assert.equal(parsedUnion.warnings.length, 0, "Final union CSS inspection emitted warnings");
  assert.ok(parsedUnion.dependencies !== undefined);
  assert.equal(parsedUnion.dependencies.length, 0, "Final union contains an unexpected asset URL");
  return { routes: siteRoutes, stylesheets, fonts };
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

async function serve(files: ReadonlyMap<string, Buffer>, csp: string, previewCsp?: string): Promise<Surface> {
  const server = await serveBrowserAssets({
    files, csp, ...(previewCsp === undefined ? {} : { previewCsp }), assetPath, contentType: assetContentType,
  });
  return { artifacts: artifacts(files), bytes: files, origin: server.origin, stop: server.stop };
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
export function loadedStylesheetControl(element: Element, sampleSelector?: string) {
  const document = element.ownerDocument;
  const view = document.defaultView;
  if (view === null || view.document !== document || !(element instanceof view.HTMLLinkElement)
    || !element.isConnected) throw new Error("Missing ordinary stylesheet link.");
  if (sampleSelector !== undefined && (sampleSelector.length === 0 || sampleSelector.length > 1024)) {
    throw new Error("Invalid stylesheet sample selector.");
  }
  const sampleTarget = sampleSelector === undefined ? null : document.querySelector(sampleSelector);
  if (sampleSelector !== undefined && sampleTarget === null) throw new Error("Missing stylesheet sample target.");
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
    if (sampleSelector !== undefined && (sampleTarget === null || !sampleTarget.isConnected
      || sampleTarget.ownerDocument !== document || document.querySelector(sampleSelector) !== sampleTarget)) {
      throw new Error("Stylesheet sample target changed.");
    }
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
    sampleTarget,
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

type RestorationBoundary = Readonly<{ signal: AbortSignal; profileDeadline: number }>;

/** Cover the inclusive mobile breakpoint once per public route in the desktop
 * profile. Reuse the loaded document and sheets; all six profiles still run.
 * Native fragment scrolling is observed, never replaced by a CSS offset fix. */
async function verifyMobileSiteAnchors(page: Page, pathname: "/" | "/privacy/", profile: Profile, boundary: RestorationBoundary): Promise<unknown[]> {
  const samples: unknown[] = [];
  let failure: { error: unknown } | undefined;
  try {
    for (const width of [320, 390, 768, 769, 1440]) {
      assert.equal(boundary.signal.aborted, false, "Browser mobile anchor check cancelled");
      assert.ok(performance.now() < boundary.profileDeadline, "Browser mobile anchor check exceeded its profile deadline");
      await page.setViewportSize({ width, height: profile.height });
      await page.evaluate((path) => {
        history.replaceState(null, "", path);
        window.scrollTo({ left: 0, top: 0, behavior: "instant" });
      }, pathname);
      await settle(page);
      const targetId = pathname === "/" ? "install-and-update" : "privacy";
      if (pathname === "/") await page.locator('a[href="#install-and-update"]').first().click();
      else await page.evaluate((id) => { location.hash = id; }, targetId);
      // Await the browser's native smooth-scroll destination, including the
      // existing authored scroll margin and end-of-document clamping.
      const scrollSettled = await page.waitForFunction((id) => {
        const target = document.getElementById(id);
        if (target === null) return false;
        const margin = Number.parseFloat(getComputedStyle(target).scrollMarginTop);
        const maximum = Math.max(0, document.documentElement.scrollHeight - innerHeight);
        const destination = Math.min(maximum, Math.max(0, target.getBoundingClientRect().top + scrollY - margin));
        return Number.isFinite(destination) && Math.abs(scrollY - destination) <= 1;
      }, targetId, { polling: "raf", timeout: 5000 });
      await scrollSettled.dispose();
      await settle(page);
      const sample = await page.evaluate((id) => {
        const header = document.querySelector('[data-hraness-marketing="header"]');
        const heading = document.getElementById(`${id}-heading`);
        if (header === null || heading === null) throw new Error("Missing public header or fragment heading");
        const rectangle = (element: Element) => {
          const box = element.getBoundingClientRect();
          return { left: box.left, top: box.top, right: box.right, bottom: box.bottom, width: box.width, height: box.height };
        };
        return { width: innerWidth, height: innerHeight, mobile: matchMedia("(max-width: 48rem)").matches,
          position: getComputedStyle(header).position, header: rectangle(header), heading: rectangle(heading),
          documentWidth: document.documentElement.scrollWidth, bodyWidth: document.body.scrollWidth, scrollX,
          fragment: location.hash };
      }, targetId);
      assert.equal(sample.width, width);
      assert.equal(sample.height, profile.height);
      assert.equal(sample.mobile, width <= 768, "Mobile header breakpoint changed");
      assert.equal(sample.position, sample.mobile ? "static" : "sticky", "Public header lost mobile flow or desktop stickiness");
      assert.equal(sample.fragment, `#${targetId}`);
      for (const rectangle of [sample.header, sample.heading]) {
        assert.ok(Object.values(rectangle).every(Number.isFinite));
        assert.ok(rectangle.width > 0 && rectangle.height > 0);
      }
      assert.ok(sample.documentWidth <= width + 1 && sample.bodyWidth <= width + 1 && Math.abs(sample.scrollX) <= 1,
        "Public fragment navigation introduced horizontal overflow");
      assert.ok(sample.heading.left >= -1 && sample.heading.right <= width + 1);
      const obscuredUntil = sample.position === "sticky" ? Math.max(0, sample.header.bottom) : 0;
      assert.ok(sample.heading.top >= obscuredUntil - 1 && sample.heading.bottom <= sample.height + 1,
        "Public fragment heading is obscured or outside the viewport");
      samples.push(sample);
    }
  } catch (error) { failure = { error }; }
  try {
    await page.setViewportSize({ width: profile.width, height: profile.height });
    await page.evaluate((path) => {
      history.replaceState(null, "", path);
      window.scrollTo({ left: 0, top: 0, behavior: "instant" });
    }, pathname);
    await settle(page);
  } catch (error) {
    if (failure !== undefined) throw new AggregateError([failure.error, error], "Browser mobile anchor check and restoration failed");
    throw error instanceof Error ? error : new Error("Browser mobile anchor restoration failed", { cause: error });
  }
  if (failure !== undefined) throw failure.error instanceof Error ? failure.error : new Error("Browser mobile anchor check failed", { cause: failure.error });
  return samples;
}

async function negativeStylesheet(page: Page, selector: string, href: string, report: NegativeStylesheetReporter, boundary: RestorationBoundary, foundation = false): Promise<void> {
  const step = <T>(name: NegativeStylesheetSubstep, operation: () => Promise<T>) => browserNegativeStep(name, operation, report);
  const sample = () => page.locator(selector).first().evaluate((element, foundation) => {
    element.getBoundingClientRect();
    const css = getComputedStyle(element);
    return {
      display: css.display, height: css.minHeight, padding: css.paddingLeft, border: css.borderTopWidth, font: css.fontSize,
      ...(foundation ? { boxSizing: css.boxSizing, fontFamily: css.fontFamily, lineHeight: css.lineHeight, backgroundToken: css.getPropertyValue("--background") } : {}),
    };
  }, foundation);
  const before = await step("sample-before", sample);
  const sheet = page.locator(`link[rel="stylesheet"][href="${href}"]`);
  await step("link-count", async () => { assert.equal(await sheet.count(), 1); });
  const loadedSheet = await step("capture", () => sheet.evaluateHandle(loadedStylesheetControl, selector));
  await withBrowserNegativeCleanup(async () => {
    await withBrowserNegativeCleanup(async () => {
      await step("disable", () => loadedSheet.evaluate((state) => state.disable()));
      await step("settle-disabled", () => settle(page));
      await step("sample-disabled", async () => {
        assert.notDeepEqual(await sample(), before, "Negative control did not detect disabled final CSS");
      });
    }, () => step("restore", () => loadedSheet.evaluate((state) => state.restore())), "restore");
    await step("settle-restored", () => settleExactStylesheet({
      expected: before, foundation, signal: boundary.signal, profileDeadline: boundary.profileDeadline,
      operations: {
        assertIdentity: () => loadedSheet.evaluate((state) => state.assertRestored()),
        readPair: (_signal, remainingMs) => loadedSheet.evaluate(readRestoredStyleFramePair, { foundation, remainingMs }),
      },
    }));
    await step("identity-restored", () => loadedSheet.evaluate((state) => state.assertRestored()));
    await step("sample-restored", async () => {
      assert.deepEqual(await sample(), before, "Final CSS did not restore exactly");
      await loadedSheet.evaluate((state) => state.assertRestored());
    });
  }, () => step("dispose", () => loadedSheet.dispose()), "dispose");
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

async function primitives(page: Page, profile: Profile, reportNegative: NegativeStylesheetReporter, boundary: RestorationBoundary): Promise<void> {
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
  await negativeStylesheet(page, "button", "/stylex.css", reportNegative, boundary);
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
  await context.routeWebSocket("**/*", async (socket) => { note(blocked, "websocket"); await socket.close({ code: 1000, reason: "Offline browser acceptance" }); });
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

export async function runAppBrowser(rootDirectory: string, runDirectory: string, signal: AbortSignal,
  admission: BrowserExecutionAdmission, observer?: BrowserCustodyObserver): Promise<void> {
  assertBrowserNode(process.versions);
  const root = await realpath(rootDirectory);
  const run = await realpath(runDirectory);
  const handoff = await admission.verify(admission, root, run);
  const wasCancelled = (): boolean => signal.aborted;
  assert.ok(!wasCancelled(), "Browser acceptance cancelled before driver admission");
  const driverRuntime = { name: "node", version: process.versions.node, executable: await browserExecutable(process.execPath), bundleSha256: handoff.prepared.driver.sha256 };
  assert.deepEqual(driverRuntime.executable, handoff.request.node);
  const executable = process.env.CHROMIUM_EXECUTABLE_PATH;
  assert.ok(executable !== undefined && executable.startsWith("/"), "Set CHROMIUM_EXECUTABLE_PATH to an explicit Chromium executable");
  const executableSha256 = await browserExecutableSha256(executable);
  assert.equal(executableSha256, handoff.request.chromium.sha256);
  const packageBytes = await ordinary(join(root, "package.json"));
  const lockBytes = await ordinary(join(root, "bun.lock"));
  const playwrightPackage = record(JSON.parse(await readFile(new URL(import.meta.resolve("playwright-core/package.json")), "utf8")) as unknown);
  assert.equal(playwrightPackage.version, "1.62.0");
  const { chromium } = await import("playwright-core");
  const appFiles = await inventory(join(root, "app/dist"));
  const siteRoot = join(root, "dist/site");
  const siteDocuments = new Map(await Promise.all(siteRoutes.map(async ({ path }) => [path, await ordinary(join(siteRoot, path))] as const)));
  const [foundationPath] = siteStylesheetPaths(siteDocuments);
  const foundationBytes = await ordinary(join(siteRoot, foundationPath));
  const siteFontPaths = new Set(siteFoundationFontPaths(foundationPath, foundationBytes));
  const siteFiles = await inventory(siteRoot, siteFontPaths);
  for (const [path, bytes] of siteDocuments) assert.deepEqual(siteFiles.get(path), bytes, "Site document changed during graph admission");
  assert.deepEqual(siteFiles.get(foundationPath), foundationBytes, "Site foundation changed during graph admission");
  const publicFontRoot = await realpath(dirname(fileURLToPath(import.meta.resolve("@hraness/design-kit/fonts.css"))));
  const publicFonts = new Map(await Promise.all(sitePublicFonts.map(async (path) => [path, await ordinary(join(publicFontRoot, "fonts", path))] as const)));
  const siteGraph = snapshotStaticSite(siteFiles, publicFonts);
  const appCsp = productionCsp(JSON.parse((await ordinary(join(root, "app/vercel.json"))).toString("utf8")) as unknown, "/(.*)");
  const siteConfiguration: unknown = JSON.parse((await ordinary(join(root, "vercel.json"))).toString("utf8"));
  const { siteCsp, previewCsp } = siteProductionCsp(siteConfiguration);
  const evidence: Evidence[] = [];
  const profileDiagnostics: BrowserProfileDiagnostics[] = [];
  let fixtureArtifacts: readonly Artifact[] = [];
  const servers: Surface[] = [];
  const owner: { current: BrowserContext | null } = { current: null };
  const cancellation = new AbortController();
  const isCancelled = (): boolean => cancellation.signal.aborted;
  // The sole cleanup path takes a fresh census before closing. Do not race it
  // with an unawaited close from a signal callback.
  const onSignal = () => { cancellation.abort(); };
  signal.addEventListener("abort", onSignal, { once: true });
  if (signal.aborted) onSignal();
  let failure: unknown;
  try {
    const fixtureFiles = new Map([...(await inventory(join(run, "fixture/hra-app")))].filter(([path]) => path !== "stylex-complete.json"));
    assert.deepEqual(artifacts(fixtureFiles), browserPublicArtifacts(handoff.prepared.fixture).filter(({ path }) => path !== "stylex-complete.json"));
    fixtureArtifacts = artifacts(fixtureFiles);
    assert.ok(!isCancelled(), "Browser acceptance cancelled");
    const app = await serve(appFiles, appCsp); servers.push(app);
    const fixture = await serve(fixtureFiles, appCsp); servers.push(fixture);
    observeBrowserCustody(observer, { kind: "partial-servers-owned", run, origins: servers.map(({ origin }) => origin) });
    const site = await serve(siteFiles, siteCsp, previewCsp); servers.push(site);
    for (const profile of profiles) {
      assert.ok(!isCancelled(), "Browser acceptance cancelled");
      const profileStartedAt = performance.now();
      const userData = await mkdtemp(join(run, "profile-"));
      let closed = false;
      let profileFailure: unknown;
      let profileWork: Promise<void> | undefined;
      const pids: number[] = [];
      const diagnostics: BrowserProfileDiagnostics = { name: profile.name, step: "launch", failureStep: undefined, events: [], ownedPids: pids, failure: undefined };
      profileDiagnostics.push(diagnostics);
      const note = (message: string) => { if (diagnostics.events.length === 64) diagnostics.events.shift(); diagnostics.events.push(message.slice(0, 500)); };
      const mark = (step: string) => {
        diagnostics.step = step;
        console.log(browserDiagnosticLine(profile.name, step, diagnostics.failureStep === undefined ? "progress" : "after-failure", undefined, performance.now() - profileStartedAt));
      };
      const negativeReporter = (parent: string): NegativeStylesheetReporter => (step, phase, error) => {
        diagnostics.step = `${parent}:${step}`;
        if (phase === "failed") recordBrowserProfileFailure(diagnostics, error);
        const line = browserDiagnosticLine(profile.name, diagnostics.step, phase, error, performance.now() - profileStartedAt);
        if (phase === "failed") console.error(line);
        else console.log(line);
      };
      try {
        mark("launch");
        const context = await chromium.launchPersistentContext(userData, {
          // The bootstrap owns these signals. Playwright's default handlers
          // would close Chromium concurrently with our cleanup census.
          handleSIGINT: false, handleSIGTERM: false,
          executablePath: executable, headless: true, viewport: { width: profile.width, height: profile.height },
          hasTouch: profile.coarse, isMobile: profile.coarse, deviceScaleFactor: 1,
          reducedMotion: profile.reduced ? "reduce" : "no-preference", forcedColors: profile.forced ? "active" : "none",
          colorScheme: profile.colorScheme ?? "dark", locale: "en-US", timezoneId: "UTC", serviceWorkers: "block", permissions: [],
          args: ["--disable-background-networking", "--disable-component-update", "--disable-sync", "--no-first-run"],
          timeout: 30_000,
        });
        owner.current = context;
        assert.ok(!isCancelled(), "Browser acceptance cancelled during launch");
        // A profile-level deadline also covers raw evaluate/CDP promises that
        // are not covered by Playwright's action or navigation timeouts.
        const restorationBoundary = { signal: cancellation.signal, profileDeadline: performance.now() + 120_000 };
        profileWork = (async () => {
        context.setDefaultTimeout(15_000);
        context.setDefaultNavigationTimeout(20_000);
        mark("isolation:install");
        const isolation = await isolate(context, new Set(servers.map((server) => server.origin)));
        mark("page:create");
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
        mark("browser-census:connect");
        const browserCdp = await browser.newBrowserCDPSession();
        mark("browser-census:read");
        const census = await browserCdp.send("SystemInfo.getProcessInfo");
        for (const entry of census.processInfo) {
          assert.ok(Number.isSafeInteger(entry.id) && entry.id > 0 && entry.id !== process.pid);
          pids.push(entry.id);
        }
        assert.ok(pids.length > 0);
        mark("browser-census:detach");
        await browserCdp.detach();
        observeBrowserCustody(observer, { kind: "browser-census-owned", run, origins: servers.map(({ origin }) => origin), pids });
        mark("production-anonymous:navigation");
        await page.goto(app.origin);
        mark("production-anonymous:assertions");
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
        mark("production-anonymous:negative-css");
        await negativeStylesheet(page, "button", "/stylex.css", negativeReporter("production-anonymous:negative-css"), restorationBoundary);
        evidence.push({ name: `${profile.name}:production-anonymous`, values: { browserVersion, finalCssSha256: digest(appFiles.get("stylex.css") ?? "") } });
        for (const view of fixtureViews) {
          assert.ok(!isCancelled(), "Browser acceptance cancelled");
          mark(`fixture:${view}:navigation`);
          await page.goto(`${fixture.origin}/?view=${view}`);
          mark(`fixture:${view}:assertions`);
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
          if (view === "primitives") await primitives(page, profile, negativeReporter("fixture:primitives:negative-css"), restorationBoundary);
          await cleanDocument(page);
          if (view === "grid" || view === "session" || view === "settings" || view === "primitives") {
            mark(`fixture:${view}:screenshot`);
            await page.screenshot({ path: join(run, `${profile.name}-${view}.png`), fullPage: false });
          }
          evidence.push({ name: `${profile.name}:fixture:${view}`, values: "passed" });
        }
        if (profile.name === "desktop") {
          mark("asymmetric-safe-area");
          await safeArea(page, fixture.origin);
          evidence.push({ name: "asymmetric-safe-area:ltr+rtl", values: { top: 19, left: 31, bottom: 23, right: 47 } });
        }
        for (const route of siteGraph.routes) {
          const routeLabel = route.pathname === "/" ? "home" : route.pathname === "/privacy/" ? "privacy" : "preview";
          const responses: BrowserResponse[] = [];
          let responseOverflow = false;
          const capture = (response: BrowserResponse) => {
            if (new URL(response.url()).origin !== site.origin || !["stylesheet", "font"].includes(response.request().resourceType())) return;
            if (responses.length < 64) responses.push(response);
            else responseOverflow = true;
          };
          page.on("response", capture);
          try {
            mark(`static-site:${routeLabel}:navigation`);
            const response = await page.goto(`${site.origin}${route.pathname}`);
            assert.ok(response !== null);
            assert.equal(response.status(), 200);
            assert.equal(response.headers()["content-security-policy"], route.pathname === "/preview/" ? previewCsp : siteCsp);
            const documentBytes = siteFiles.get(route.path);
            assert.ok(documentBytes !== undefined);
            mark(`static-site:${routeLabel}:document-bytes`);
            assert.deepEqual(await response.body(), documentBytes, "Native document differs from the completed output");
            mark(`static-site:${routeLabel}:direction`);
            await page.evaluate((direction) => { document.documentElement.dir = direction; }, profile.rtl ? "rtl" : "ltr");
            mark(`static-site:${routeLabel}:heading`);
            await page.locator(route.heading).waitFor({ state: "visible" });
            mark(`static-site:${routeLabel}:settle-before-fonts`);
            await settle(page);
            mark(`static-site:${routeLabel}:font-load`);
            const fonts = await page.evaluate(async () => {
              const faces = [...document.fonts];
              if (faces.length !== 13) throw new Error("Native font-face inventory is incomplete");
              await Promise.all(faces.map((face) => face.load()));
              return faces.map((face) => ({ family: face.family, style: face.style, weight: face.weight, status: face.status }));
            });
            assert.ok(fonts.every(({ status }) => status === "loaded"), "A public font did not load natively under font-src self");
            mark(`static-site:${routeLabel}:settle-after-fonts`);
            await settle(page);
            if (profile.name === "desktop" && route.pathname !== "/preview/") {
              mark(`static-site:${routeLabel}:mobile-anchors`);
              const anchors = await verifyMobileSiteAnchors(page, route.pathname, profile, restorationBoundary);
              evidence.push({ name: `desktop:static-site:${route.path}:mobile-anchors`, values: anchors });
            }
            mark(`static-site:${routeLabel}:document-clean`);
            await cleanDocument(page);
            mark(`static-site:${routeLabel}:stylesheet-links`);
            assert.deepEqual(await page.locator('link[rel="stylesheet"]').evaluateAll((links) => links.map((link) => link.getAttribute("href"))), siteGraph.stylesheets.map((path) => `/${path}`));
            mark(`static-site:${routeLabel}:stylesheet-inventory`);
            assert.deepEqual(await page.evaluate(() => [...document.styleSheets].map((sheet) => ({ href: sheet.href, disabled: sheet.disabled, rules: sheet.cssRules.length > 0 }))),
              siteGraph.stylesheets.map((path) => ({ href: `${site.origin}/${path}`, disabled: false, rules: true })));
            mark(`static-site:${routeLabel}:color-scheme`);
            assert.equal(await page.evaluate(() => matchMedia("(prefers-color-scheme: light)").matches), profile.colorScheme === "light");
            mark(`static-site:${routeLabel}:background`);
            if (!profile.forced) assert.equal(await page.locator("html").evaluate((element) => getComputedStyle(element).backgroundColor), profile.colorScheme === "light" ? "rgb(251, 250, 247)" : "rgb(20, 19, 16)");
            mark(`static-site:${routeLabel}:heading-style`);
            assert.ok(await page.locator(route.heading).evaluate((element) => Number.parseFloat(getComputedStyle(element).fontSize) > 24));
            mark(`static-site:${routeLabel}:inertness`);
            if (route.pathname === "/preview/") assert.equal(await page.locator("a,button,input,select,textarea,form,script,iframe").count(), 0, "Preview gained an action or script");
            const countBeforeNegative = responses.length;
            mark(`static-site:${routeLabel}:negative-final-css`);
            await negativeStylesheet(page, route.heading, `/${siteGraph.stylesheets[1]}`, negativeReporter(`static-site:${routeLabel}:negative-final-css`), restorationBoundary);
            mark(`static-site:${routeLabel}:negative-foundation-css`);
            await negativeStylesheet(page, "html", `/${siteGraph.stylesheets[0]}`, negativeReporter(`static-site:${routeLabel}:negative-foundation-css`), restorationBoundary, true);
            mark(`static-site:${routeLabel}:negative-document-clean`);
            await cleanDocument(page);
            assert.equal(responses.length, countBeforeNegative, "Stylesheet application control reloaded a resource");
            assert.equal(responseOverflow, false, "Static resource census exceeded its bound");
            mark(`static-site:${routeLabel}:resource-bytes`);
            const delivered = await Promise.all(responses.map(async (resource) => {
              const key = assetPath(new URL(resource.url()).pathname, siteFontPaths);
              assert.ok(key !== null && siteFiles.has(key));
              assert.equal(resource.status(), 200);
              assert.equal(resource.headers()["content-type"], assetContentType(key));
              assert.equal(resource.headers()["x-content-type-options"], "nosniff");
              const bytes = await resource.body();
              assert.deepEqual(bytes, siteFiles.get(key), "Native resource differs from its retained output identity");
              return { path: key, bytes: bytes.length, sha256: digest(bytes) };
            }));
            assert.deepEqual(delivered.map(({ path }) => path).sort(), [...siteGraph.stylesheets, ...siteGraph.fonts].sort(), "Native CSS/font linkage was incomplete or redundant");
            evidence.push({ name: `${profile.name}:static-site:${route.path}`, values: { documentSha256: digest(documentBytes), fonts, delivered: delivered.sort((a, b) => a.path.localeCompare(b.path)) } });
          } finally { page.off("response", capture); }
        }
        mark("isolation:assertions");
        assert.deepEqual(isolation.errors, [], "Browser runtime or resource failure");
        evidence.push({ name: `${profile.name}:isolation`, values: { blocked: [...new Set(isolation.blocked)].sort(), cspErrors: 0, runtimeErrors: 0 } });
        })();
        await boundedBrowserOperation(profileWork, 120_000, `Browser profile ${profile.name}`, cancellation.signal);
      } catch (error) {
        profileFailure = error;
        recordBrowserProfileFailure(diagnostics, error);
        console.error(browserDiagnosticLine(profile.name, diagnostics.failureStep, "failed", error, performance.now() - profileStartedAt));
      } finally {
        if (owner.current !== null) {
          try {
            mark("cleanup");
            await closeOwnedBrowser(owner.current, pids);
            // Closing the owned browser rejects outstanding renderer work.
            // Do not remove its profile while the operation remains unsettled.
            if (profileWork !== undefined) await boundedBrowserOperation(profileWork.catch(() => undefined), 5000, "Browser profile task settlement");
            owner.current = null;
            closed = true;
            evidence.push({ name: `${profile.name}:browser-cleanup`, values: { ownedProcesses: pids.length, survivors: 0, pages: 0 } });
          } catch (error) {
            recordBrowserProfileFailure(diagnostics, error);
            console.error(browserDiagnosticLine(profile.name, "cleanup", "cleanup-failed", error, performance.now() - profileStartedAt));
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
      }
      if (profileFailure !== undefined) throw profileFailure instanceof Error
        ? profileFailure : new Error("Browser profile failed", { cause: profileFailure });
      mark("complete");
    }
    assert.deepEqual(artifacts(await inventory(join(root, "app/dist"))), artifacts(appFiles));
    assert.deepEqual(artifacts(await inventory(siteRoot, siteFontPaths)), artifacts(siteFiles));
    for (const [path, bytes] of publicFonts) assert.deepEqual(await ordinary(join(publicFontRoot, "fonts", path)), bytes, "Public font input changed during browser acceptance");
    assert.deepEqual(await ordinary(join(root, "package.json")), packageBytes);
    assert.deepEqual(await ordinary(join(root, "bun.lock")), lockBytes);
    assert.deepEqual(await admission.verify(admission, root, run), handoff, "Browser preparation changed during acceptance");
    assert.ok(!isCancelled(), "Browser acceptance cancelled");
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
      try { await admission.verify(admission, root, run); }
      catch (error) { failure = failure === undefined ? error : new AggregateError([failure, error], "Browser gate and execution admission postflight failed"); }
      signal.removeEventListener("abort", onSignal);
      const receipt = {
        schemaVersion: 2, kind: "hra-app-browser-acceptance", state: failure === undefined && !isCancelled() ? "passed" : "failed",
        browserExecutableSha256: executableSha256, playwright: "1.62.0", buildRuntime: handoff.prepared.buildRuntime, driverRuntime,
        preparationSha256: browserDigest(JSON.stringify(handoff.prepared)),
        executionAdmission: admission.evidence,
        packageSha256: digest(packageBytes), lockSha256: digest(lockBytes),
        app: artifacts(appFiles), site: artifacts(siteFiles), fixture: fixtureArtifacts,
        appCspSha256: digest(appCsp), siteCspSha256: digest(siteCsp), previewCspSha256: digest(previewCsp),
        sitePublicFonts: artifacts(publicFonts),
        fixtureIoAliases: ["@convex-dev/auth/react", ...browserIoModules], evidence,
        profileDiagnostics, ...(failure === undefined ? {} : { failure: browserFailureDetails(failure) }),
      };
      // The bootstrap joins this result with child collection and the terminal
      // cancellation latch before publishing the CI-facing receipt.json.
      await publishBrowserJson(join(run, "driver-receipt.json"), receipt);
      console.log(`Browser driver ${receipt.state}; ${evidence.length} evidence rows; awaiting bootstrap settlement`);
    }
  }
  assert.ok(!isCancelled(), "Browser acceptance cancelled");
  if (failure !== undefined) throw failure instanceof Error
    ? failure : new Error("Browser acceptance failed", { cause: failure });
}
