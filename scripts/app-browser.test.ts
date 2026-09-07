import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertAppColorScheme, assertDefaultButtonPresentation, assertNativeModalFocus, assetContentType, assetPath, boundedBrowserOperation, browserExecutableSha256, browserFailureDetails, inventory, loadedStylesheetControl, productionCsp } from "./app-browser";
import { browserIoModules } from "../app/fixtures/browser/config";

function stylesheetFixture() {
  class Link {
    isConnected = true;
    sheet: CSSStyleSheet | null = null;
    outerHTML: string;
    constructor(readonly ownerDocument: Document, public href: string) {
      this.outerHTML = `<link rel="stylesheet" href="${href}">`;
    }
    get disabled(): never { throw new Error("The link resource must not be read or toggled."); }
    set disabled(_value: boolean) { throw new Error("The link resource must not be read or toggled."); }
  }
  const document = {} as Document;
  const target = new Link(document, "https://fixture.invalid/stylex.css");
  const other = new Link(document, "https://fixture.invalid/foundation.css");
  const makeSheet = (ownerNode: Link, disabled = false) => ({
    ownerNode, disabled, href: ownerNode.href,
    cssRules: [{ cssText: ".fixture { display: grid; }" }],
  });
  const targetSheet = makeSheet(target);
  const otherSheet = makeSheet(other, true);
  target.sheet = targetSheet as unknown as CSSStyleSheet;
  other.sheet = otherSheet as unknown as CSSStyleSheet;
  const sheets = [otherSheet, targetSheet];
  Object.assign(document, {
    styleSheets: sheets,
    defaultView: { document, HTMLLinkElement: Link, Element: Link, location: { origin: "https://fixture.invalid" } },
  });
  return { target, targetSheet, other, otherSheet, sheets, create: () => loadedStylesheetControl(target as unknown as Element) };
}

describe("loaded stylesheet negative control", () => {
  test("toggles only the exact loaded CSSOM sheet and preserves unrelated disabled state", () => {
    const fixture = stylesheetFixture();
    const control = fixture.create();
    const rules = fixture.targetSheet.cssRules;
    control.disable();
    expect(fixture.targetSheet.disabled).toBe(true);
    expect(fixture.otherSheet.disabled).toBe(true);
    expect(fixture.targetSheet.cssRules).toBe(rules);
    control.restore();
    control.assertRestored();
    expect(fixture.targetSheet.disabled).toBe(false);
    expect(fixture.otherSheet.disabled).toBe(true);
    expect(fixture.targetSheet.cssRules).toBe(rules);
  });

  test("restores the captured object after a failed negative assertion", () => {
    const fixture = stylesheetFixture();
    const control = fixture.create();
    expect(() => {
      try {
        control.disable();
        throw new Error("negative sample failed");
      } finally { control.restore(); }
    }).toThrow("negative sample failed");
    expect(fixture.targetSheet.disabled).toBe(false);
    expect(() => control.assertRestored()).not.toThrow();
  });

  test("rejects sheet replacement, reordering, rule mutation and unrelated state drift", () => {
    const mutations: readonly ((fixture: ReturnType<typeof stylesheetFixture>) => void)[] = [
      ({ sheets, otherSheet }) => { sheets[0] = { ...otherSheet }; },
      ({ sheets }) => { sheets.reverse(); },
      ({ sheets, otherSheet }) => { sheets.push(otherSheet); },
      ({ target }) => { target.isConnected = false; },
      ({ target }) => { target.href = "https://fixture.invalid/replaced.css"; },
      ({ target }) => { target.outerHTML += " "; },
      ({ target, other }) => { target.sheet = other.sheet; },
      ({ targetSheet, other }) => { targetSheet.ownerNode = other; },
      ({ targetSheet }) => { targetSheet.href = "https://fixture.invalid/replaced.css"; },
      ({ targetSheet }) => { targetSheet.cssRules = [...targetSheet.cssRules]; },
      ({ targetSheet }) => { targetSheet.cssRules[0] = { ...targetSheet.cssRules[0]! }; },
      ({ targetSheet }) => { targetSheet.cssRules[0]!.cssText = ".fixture { display: block; }"; },
      ({ otherSheet }) => { otherSheet.cssRules[0]!.cssText = ".other { display: block; }"; },
      ({ other }) => { other.outerHTML += " "; },
      ({ otherSheet }) => { otherSheet.disabled = false; },
    ];
    for (const mutate of mutations) {
      const fixture = stylesheetFixture();
      const control = fixture.create();
      control.disable();
      mutate(fixture);
      expect(() => control.restore()).toThrow();
      // Identity failure must not strand our captured sheet disabled or
      // rewrite whichever replacement or unrelated sheet caused the failure.
      expect(fixture.targetSheet.disabled).toBe(false);
      expect(() => control.assertRestored()).toThrow();
    }
  });

  test("refuses missing, disabled, empty, foreign or duplicate target sheets before changing application", () => {
    const mutations: readonly ((fixture: ReturnType<typeof stylesheetFixture>) => void)[] = [
      ({ target }) => { target.sheet = null; },
      ({ target }) => { target.isConnected = false; },
      ({ targetSheet }) => { targetSheet.disabled = true; },
      ({ targetSheet }) => { targetSheet.cssRules = []; },
      ({ targetSheet, other }) => { targetSheet.ownerNode = other; },
      ({ target }) => { target.href = "https://foreign.invalid/stylex.css"; },
      ({ sheets }) => { sheets.pop(); },
      ({ sheets, targetSheet }) => { sheets.push(targetSheet); },
      ({ sheets, otherSheet }) => { while (sheets.length <= 32) sheets.push(otherSheet); },
    ];
    for (const mutate of mutations) {
      const fixture = stylesheetFixture();
      mutate(fixture);
      const before = fixture.targetSheet.disabled;
      expect(() => fixture.create()).toThrow();
      expect(fixture.targetSheet.disabled).toBe(before);
    }
  });
});

describe("browser acceptance boundaries", () => {
  test("requires exact authored dark for ordinary profiles, including a light OS preference", () => {
    for (const colorScheme of ["dark", "light"] as const) {
      const profile = { forced: false, colorScheme };
      const sample = { forced: false, colorScheme: "dark", forcedColorAdjust: "auto" };
      expect(() => assertAppColorScheme(sample, profile)).not.toThrow();
      for (const invalid of ["light", "light dark", "dark light", "only dark", "normal", undefined]) {
        expect(() => assertAppColorScheme({ ...sample, colorScheme: invalid }, profile)).toThrow();
      }
    }
  });
  test("admits exact light dark only after the forced-colors media matches the profile", () => {
    const sample = { forced: true, colorScheme: "light dark", forcedColorAdjust: "auto" };
    expect(() => assertAppColorScheme(sample, { forced: true })).not.toThrow();
    for (const invalid of [false, undefined, null, 1, "true"]) {
      expect(() => assertAppColorScheme({ ...sample, forced: invalid }, { forced: true })).toThrow("Forced-colors media did not match the requested profile");
    }
    expect(() => assertAppColorScheme(sample, { forced: false })).toThrow("Forced-colors media did not match the requested profile");
    for (const invalid of ["dark", "light", "dark light", "light dark only", "normal", undefined]) {
      expect(() => assertAppColorScheme({ ...sample, colorScheme: invalid }, { forced: true })).toThrow();
    }
  });
  test("rejects a forced-color opt-out or malformed browser sample in every profile", () => {
    for (const forced of [false, true]) {
      const sample = { forced, colorScheme: forced ? "light dark" : "dark", forcedColorAdjust: "auto" };
      for (const invalid of ["none", "preserve-parent-color", "", undefined, null]) {
        expect(() => assertAppColorScheme({ ...sample, forcedColorAdjust: invalid }, { forced })).toThrow("App opted out of the user's forced-color palette");
      }
      for (const invalid of [null, undefined, [], "dark", {}]) {
        expect(() => assertAppColorScheme(invalid, { forced })).toThrow();
      }
    }
  });
  test("retains bounded original and cleanup failures without recursive or unbounded receipts", () => {
    const original = new Error("navigation stalled");
    const cleanup = new Error("browser close stalled", { cause: original });
    expect(browserFailureDetails(new AggregateError([original, cleanup], "profile failed"))).toEqual({
      name: "AggregateError", message: "profile failed", errors: [
        { name: "Error", message: "navigation stalled" },
        { name: "Error", message: "browser close stalled", cause: { name: "Error", message: "navigation stalled" } },
      ],
    });
    original.cause = original;
    expect(JSON.stringify(browserFailureDetails(original)).length).toBeLessThan(1000);
    expect(browserFailureDetails(new AggregateError(Array.from({ length: 100 }, () => new Error("x".repeat(2000))), "many")).errors).toHaveLength(8);
    expect(browserFailureDetails(new Error("x".repeat(2000))).message).toHaveLength(1000);
    expect(browserFailureDetails({ secret: "not serialized" })).toEqual({ name: "UnknownFailure", message: "object" });
  });
  test("native modal focus allows browser chrome but never background page controls", () => {
    const inside = { modal: true, contained: true, documentFocused: true, activeTag: "INPUT", activeLabel: "Modal text" };
    const chrome = { modal: true, contained: false, documentFocused: false, activeTag: "BODY", activeLabel: null };
    expect(() => assertNativeModalFocus(inside)).not.toThrow();
    expect(() => assertNativeModalFocus(chrome)).not.toThrow();
    for (const mutation of [
      { modal: false }, { documentFocused: true }, { activeTag: "BUTTON" },
      { activeTag: "INPUT" }, { activeTag: null }, { activeLabel: "Background" },
      { contained: undefined }, { documentFocused: undefined },
    ]) expect(() => assertNativeModalFocus({ ...chrome, ...mutation })).toThrow();
    expect(() => assertNativeModalFocus({ ...inside, modal: false })).toThrow();
    expect(() => assertNativeModalFocus({ ...inside, contained: false })).toThrow();
  });
  const button = {
    parentTag: "DIV", parentDisplay: "block", parentFlexDirection: "row",
    display: "inline-flex", position: "static", float: "none",
    alignItems: "center", justifyContent: "center", gap: "8px", minHeight: "44px", height: 44,
    paddingLeft: "16px", paddingRight: "16px", borderTopLeftRadius: "6px",
    fontSize: "14px", lineHeight: "20px", fontWeight: "500",
  };
  const signInButton = { ...button, parentTag: "FORM", parentDisplay: "flex", parentFlexDirection: "column", display: "flex" };

  test("accepts the default button's exact flow or known sign-in flex-item presentation", () => {
    expect(() => assertDefaultButtonPresentation(button, "card-content")).not.toThrow();
    expect(() => assertDefaultButtonPresentation(signInButton, "sign-in-form")).not.toThrow();
  });
  test("does not accept blockified display outside the known in-flow sign-in form", () => {
    for (const mutation of [
      { parentTag: "DIV" }, { parentDisplay: "block" }, { parentFlexDirection: "row" },
      { position: "absolute" }, { position: "fixed" }, { float: "left" }, { display: "inline-flex" },
    ]) expect(() => assertDefaultButtonPresentation({ ...signInButton, ...mutation }, "sign-in-form")).toThrow();
    expect(() => assertDefaultButtonPresentation({ ...button, display: "flex" }, "card-content")).toThrow();
    expect(() => assertDefaultButtonPresentation({ ...button, parentDisplay: "flex" }, "card-content")).toThrow();
    expect(() => assertDefaultButtonPresentation({ ...signInButton, display: "block" }, "sign-in-form")).toThrow();
  });
  test("requires material button recipes even when computed display and parent are correct", () => {
    for (const placement of ["card-content", "sign-in-form"] as const) {
      const sample = placement === "card-content" ? button : signInButton;
      for (const mutation of [
        { alignItems: "normal" }, { justifyContent: "normal" }, { gap: "normal" }, { minHeight: "0px" },
        { paddingLeft: "0px" }, { paddingRight: "0px" }, { borderTopLeftRadius: "0px" },
        { fontSize: "16px" }, { lineHeight: "normal" }, { fontWeight: "400" },
        { height: 43 }, { height: NaN }, { height: Infinity },
      ]) expect(() => assertDefaultButtonPresentation({ ...sample, ...mutation }, placement)).toThrow();
    }
  });
  test("hashes executable bytes separately and rejects linked or nonexecutable files", async () => {
    const root = await mkdtemp(join(tmpdir(), "hra-browser-executable-test-"));
    try {
      const path = join(root, "browser");
      const bytes = "#!/bin/sh\nexit 0\n";
      await writeFile(path, bytes, { flag: "wx", mode: 0o700 });
      expect(await browserExecutableSha256(path)).toBe(createHash("sha256").update(bytes).digest("hex"));
      await symlink(path, join(root, "linked"));
      await expect(browserExecutableSha256(join(root, "linked"))).rejects.toThrow();
      await chmod(path, 0o600);
      await expect(browserExecutableSha256(path)).rejects.toThrow();
    } finally { await rm(root, { recursive: true }); }
  });
  test("bounds stalled settlement without hiding its original rejection", async () => {
    expect(await boundedBrowserOperation(Promise.resolve("ready"), 100, "fixture")).toBe("ready");
    const failure = new Error("original renderer failure");
    await expect(boundedBrowserOperation(Promise.reject(failure), 100, "fixture")).rejects.toBe(failure);
    await expect(boundedBrowserOperation(new Promise<never>(() => undefined), 5, "fixture")).rejects.toThrow("fixture exceeded 5ms");
  });
  test("cancellation interrupts an unbounded renderer operation", async () => {
    const controller = new AbortController();
    const pending = boundedBrowserOperation(new Promise<never>(() => undefined), 1000, "renderer", controller.signal);
    controller.abort();
    await expect(pending).rejects.toThrow("renderer cancelled");
    await expect(boundedBrowserOperation(new Promise<never>(() => undefined), 1000, "pre-aborted", controller.signal)).rejects.toThrow("pre-aborted cancelled");
  });
  test("serves only exact bounded asset paths", () => {
    expect(assetPath("/")).toBe("index.html");
    expect(assetPath("/privacy/")).toBe("privacy/index.html");
    expect(assetPath("/graphs/client/assets/main-123.js")).toBe("graphs/client/assets/main-123.js");
    for (const path of ["../x", "/../x", "/x/./y", "/%2e%2e/x", "/x\\y", "/x//y", "/x?secret"]) expect(assetPath(path)).toBeNull();
  });
  test("maps only the exact reviewed bracketed font, without general URL decoding", () => {
    for (const path of [
      "/fonts/geist-mono/GeistMono[wght].woff2",
      "/fonts/geist-mono/GeistMono%5Bwght%5D.woff2",
      "/fonts/geist-mono/GeistMono%5bwght%5d.woff2",
    ]) expect(assetPath(path)).toBe("fonts/geist-mono/GeistMono[wght].woff2");
    for (const path of [
      "/fonts/geist-mono/GeistMono[wdth].woff2", "/other/GeistMono[wght].woff2",
      "/fonts/geist-mono/GeistMono%255Bwght%255D.woff2",
      "/fonts%2fgeist-mono/GeistMono%5Bwght%5D.woff2",
      "/fonts/geist-mono/%2e%2e/GeistMono%5Bwght%5D.woff2",
      "/fonts/geist-mono/GeistMono%5B..%5D.woff2", "/fonts/geist-mono/GeistMono[wght].woff2/",
    ]) expect(assetPath(path)).toBeNull();
  });
  test("inventories the emitted variable font and only the two inert provenance documents", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "hra-browser-inventory-test-")));
    try {
      await writeFile(join(root, "index.html"), "<!doctype html>", { flag: "wx" });
      for (const family of ["geist-mono", "nebula-sans"]) {
        await mkdir(join(root, "fonts", family), { recursive: true });
        await writeFile(join(root, "fonts", family, "PROVENANCE.md"), "public font provenance", { flag: "wx" });
      }
      const font = "fonts/geist-mono/GeistMono[wght].woff2";
      await writeFile(join(root, font), Uint8Array.from([1, 2, 3]), { flag: "wx" });
      const files = await inventory(root);
      expect([...files.keys()]).toEqual([
        font, "fonts/geist-mono/PROVENANCE.md", "fonts/nebula-sans/PROVENANCE.md", "index.html",
      ]);
      expect(files.get(font)).toEqual(Buffer.from([1, 2, 3]));
      expect(assetContentType(font)).toBe("font/woff2");
      for (const family of ["geist-mono", "nebula-sans"]) {
        expect(assetContentType(`fonts/${family}/PROVENANCE.md`)).toBe("text/plain; charset=utf-8");
      }
      expect(assetContentType("PROVENANCE.md")).toBe("application/octet-stream");
    } finally { await rm(root, { recursive: true }); }
  });
  test("rejects arbitrary metadata/source/font types and escapes bounded filename diagnostics", async () => {
    for (const name of ["PROVENANCE.md", "source.ts", "font.otf", "GeistMono[wdth].woff2", "bad\nname.css", "%2e%2e.js"]) {
      const root = await realpath(await mkdtemp(join(tmpdir(), "hra-browser-inventory-test-")));
      try {
        await writeFile(join(root, "index.html"), "<!doctype html>", { flag: "wx" });
        await writeFile(join(root, name), "not admitted", { flag: "wx" });
        await expect(inventory(root)).rejects.toThrow(JSON.stringify(name));
      } finally { await rm(root, { recursive: true }); }
    }
  });
  test("rejects linked roots, files, and descendant directories", async () => {
    for (const kind of ["root", "file", "directory"] as const) {
      const root = await realpath(await mkdtemp(join(tmpdir(), "hra-browser-inventory-test-")));
      try {
        const output = join(root, "output");
        await mkdir(output);
        await writeFile(join(output, "index.html"), "<!doctype html>", { flag: "wx" });
        const outside = join(root, "outside");
        await mkdir(outside);
        await writeFile(join(outside, "asset.css"), "private fixture", { flag: "wx" });
        let target = output;
        if (kind === "root") {
          target = join(root, "linked-output");
          await symlink(output, target);
        } else if (kind === "file") {
          await symlink(join(outside, "asset.css"), join(output, "asset.css"));
        } else await symlink(outside, join(output, "fonts"));
        await expect(inventory(target)).rejects.toThrow(kind === "root" ? "physical path" : "Linked public browser output");
      } finally { await rm(root, { recursive: true }); }
    }
  });
  test("requires the exact production CSP row without inline exemptions", () => {
    const config = (value: string) => ({ headers: [{ source: "/(.*)", headers: [{ key: "Content-Security-Policy", value }] }] });
    expect(productionCsp(config("default-src 'none'; style-src 'self'"), "/(.*)")).toBe("default-src 'none'; style-src 'self'");
    expect(() => productionCsp(config("style-src 'self' 'unsafe-inline'"), "/(.*)")).toThrow();
    expect(() => productionCsp(config("style-src 'self'"), "/other")).toThrow();
    expect(() => productionCsp({ headers: [] }, "/(.*)")).toThrow();
  });
  test("fixture replacement ownership is limited to IO", () => {
    expect(browserIoModules).toHaveLength(8);
    expect(browserIoModules.every((path) => /^app\/src\/(data|custody)\//u.test(path))).toBe(true);
    expect(browserIoModules.some((path) => /\/(components|screens|model)\/|\.stylex/u.test(path))).toBe(false);
  });
});
