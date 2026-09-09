import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertAppColorScheme, assertDefaultButtonPresentation, assertNativeModalFocus, assertProductPreviewObservation, assetContentType, assetPath, boundedBrowserOperation, browserExecutableSha256, browserFailureDetails, inventory, loadedStylesheetControl, productionCsp, siteFoundationFontPaths, siteProductionCsp, siteStylesheetPaths, snapshotProductPreview, snapshotStaticSite } from "./app-browser";
import { browserIoModules } from "../app/fixtures/browser/config";

const docsRoutes = ["docs", "docs/start", "docs/web", "docs/sessions", "docs/reference", "docs/status"];
const exampleCsp = "default-src 'none'; script-src 'self'; style-src 'self'; img-src data: blob:; font-src 'self'; connect-src 'none'; form-action 'none'; base-uri 'none'; object-src 'none'; frame-src 'none'; worker-src 'none'";
function productFixture() {
  const html = Buffer.from(`<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="${exampleCsp}"><link rel="stylesheet" href="./graphs/client/assets/foundation-fixture.css"><link rel="stylesheet" href="./stylex.css"></head><body><div id="root"></div><script type="module" src="./graphs/client/assets/main-fixture.js"></script></body></html>`);
  return new Map([
    ["examples/app/index.html", html], ["examples/app/stylex.css", Buffer.from(".x123{display:flex}")],
    ["examples/app/graphs/client/assets/foundation-fixture.css", Buffer.from(":root{color-scheme:dark}")],
    ["examples/app/graphs/client/assets/main-fixture.js", Buffer.from("export{};")],
  ]);
}

function staticSiteFixture(sanitized = false) {
  const fontNames = [
    ...["Light", "LightItalic", "Book", "BookItalic", "Medium", "MediumItalic", "Semibold", "SemiboldItalic", "Bold", "BoldItalic", "Black", "BlackItalic"]
      .map((cut) => `nebula-sans/NebulaSans-${cut}.woff2`),
    "geist-mono/GeistMono[wght].woff2",
  ];
  const publicFonts = new Map(fontNames.map((path) => [path, Buffer.from(`public:${path}`)]));
  const foundation = "graphs/foundation/assets/foundation-testhash.css";
  const fontPaths = fontNames.map((path, index) => `graphs/foundation/assets/${path.split("/").at(-1)!.replace(".woff2", `-testhash${index}.woff2`).replace("[wght]", sanitized ? "_wght_" : "[wght]")}`);
  const css = fontPaths.map((path, index) => `@font-face{font-family:"Fixture ${index}";src:url("./${path.split("/").at(-1)}") format("woff2")}`).join("");
  const html = Buffer.from(`<!doctype html><html><head><link rel="stylesheet" href="/${foundation}"><link rel="stylesheet" href="/stylex.css"></head><body><h1 class="x123">Fixture</h1></body></html>`);
  const files = new Map<string, Buffer>([
    ["index.html", html], ["privacy/index.html", html], ["preview/index.html", html],
    ...docsRoutes.map((path) => [`${path}/index.html`, html] as const),
    ...productFixture(),
    [foundation, Buffer.from(css)], ["stylex.css", Buffer.from("@layer components.hraness-stylex{.x123{font-size:40px}}")],
    ...fontPaths.map((path, index) => [path, Buffer.from(`public:${fontNames[index]}`)] as const),
    ...["analytics.js", "site.js", "favicon.svg", "social-card.svg", "social-card.png", "robots.txt", "sitemap.xml", "llms.txt",
      ".well-known/security.txt", ".well-known/hra.json", "fonts/nebula-sans/LICENSE.txt", "fonts/nebula-sans/PROVENANCE.md",
      "fonts/geist-mono/OFL.txt", "fonts/geist-mono/PROVENANCE.md", ...docsRoutes.map((path) => `${path}/index.md`)].map((path) => [path, Buffer.from(`support:${path}`)] as const),
  ]);
  return { files, publicFonts, foundation, fontPaths, css, html };
}

describe("static site graph acceptance", () => {
  test("keeps inert preview and opaque product policies distinct with exact credential-free CORS", () => {
    const siteCsp = "default-src 'none'; font-src 'self'; style-src 'self'; script-src 'self'; frame-src 'self' https://challenges.cloudflare.com";
    const previewCsp = "default-src 'none'; font-src 'self'; style-src 'self'; script-src 'none'";
    const productPreviewCsp = `${exampleCsp}; frame-ancestors 'self'`;
    const config = (site: string, preview: string) => ({ headers: [
      { source: "/((?!preview/?$|examples/app(?:/|$)).*)", headers: [{ key: "Content-Security-Policy", value: site }] },
      { source: "/preview/", headers: [{ key: "Content-Security-Policy", value: preview }] },
      { source: "/examples/app/:path*", headers: [
        { key: "Content-Security-Policy", value: productPreviewCsp }, { key: "Access-Control-Allow-Origin", value: "*" },
        { key: "Permissions-Policy", value: "camera=(), geolocation=(), microphone=(), payment=(), usb=()" },
        { key: "Referrer-Policy", value: "no-referrer" }, { key: "X-Content-Type-Options", value: "nosniff" }, { key: "X-Robots-Tag", value: "noindex, nofollow" },
      ] },
    ] });
    expect(siteProductionCsp(config(siteCsp, previewCsp))).toEqual({ siteCsp, previewCsp, productPreviewCsp });
    for (const policy of [siteCsp.replace("font-src 'self'", "font-src 'self' data:"), siteCsp.replace("font-src 'self'", "font-src https://outside.invalid"), siteCsp.replace("font-src 'self'; ", "")]) {
      expect(() => siteProductionCsp(config(policy, previewCsp))).toThrow();
      expect(() => siteProductionCsp(config(siteCsp, policy))).toThrow();
    }
    expect(() => siteProductionCsp(config(siteCsp, siteCsp))).toThrow();
    expect(() => siteProductionCsp({ headers: config(siteCsp, previewCsp).headers.slice(0, 1) })).toThrow();
    for (const extra of [{ key: "Access-Control-Allow-Credentials", value: "true" }, { key: "X-Frame-Options", value: "DENY" }]) {
      const fixture = config(siteCsp, previewCsp);
      fixture.headers[2]!.headers.push(extra);
      expect(() => siteProductionCsp(fixture)).toThrow();
    }
    for (const key of ["Access-Control-Allow-Origin", "Content-Security-Policy"]) {
      const fixture = config(siteCsp, previewCsp);
      fixture.headers[2]!.headers.find((header) => header.key === key)!.value = key === "Content-Security-Policy" ? productPreviewCsp.replace("connect-src 'none'", "connect-src 'self'") : "null";
      expect(() => siteProductionCsp(fixture)).toThrow();
    }
    expect(() => siteProductionCsp(config(siteCsp.replace("frame-src 'self'", "frame-src"), previewCsp))).toThrow();
  });

  test("derives the same two-sheet join and all thirteen fonts from actual output bytes", () => {
    for (const sanitized of [false, true]) {
      const fixture = staticSiteFixture(sanitized);
      const graph = snapshotStaticSite(fixture.files, fixture.publicFonts);
      expect(graph.stylesheets).toEqual([fixture.foundation, "stylex.css"]);
      expect(graph.fonts).toEqual([...fixture.fontPaths].sort());
      expect(graph.routes.map(({ pathname }) => pathname)).toEqual([
        "/", "/privacy/", "/preview/", "/docs/", "/docs/start/", "/docs/web/", "/docs/sessions/", "/docs/reference/", "/docs/status/",
      ]);
      expect(graph.routes[1].heading).toBe("#privacy-heading");
      for (const path of graph.fonts) {
        expect(assetPath(`/${path}`, new Set(graph.fonts))).toBe(path);
        expect(assetPath(`/${path.replaceAll("[", "%5B").replaceAll("]", "%5D")}`, new Set(graph.fonts))).toBe(path);
      }
    }
  });

  test("rejects missing/extra routes, stale joins, changed order, inline presentation and link policy drift", () => {
    for (const path of ["index.html", "privacy/index.html", "preview/index.html", ...docsRoutes.map((path) => `${path}/index.html`)]) {
      const fixture = staticSiteFixture();
      fixture.files.delete(path);
      expect(() => snapshotStaticSite(fixture.files, fixture.publicFonts)).toThrow();
    }
    const mutations = [
      (html: string) => html.replace("/stylex.css", "/styles.css"),
      (html: string) => html.replace("foundation-testhash.css", "foundation-other.css"),
      (html: string) => html.replace(/(<link[^>]+>)(<link[^>]+>)/u, "$2$1"),
      (html: string) => html.replace("</head>", '<style>h1{color:red}</style></head>'),
      (html: string) => html.replace("<h1", '<h1 style="color:red"'),
      (html: string) => html.replace("</head>", '<base href="https://external.invalid/"></head>'),
      (html: string) => html.replace('rel="stylesheet"', 'rel="stylesheet" disabled'),
      (html: string) => html.replace('rel="stylesheet"', 'rel="alternate stylesheet"'),
      (html: string) => html.replace("</head>", '<link rel="stylesheet" href="/extra.css"></head>'),
    ];
    for (const mutate of mutations) {
      const fixture = staticSiteFixture();
      fixture.files.set("privacy/index.html", Buffer.from(mutate(fixture.html.toString())));
      expect(() => siteStylesheetPaths(fixture.files)).toThrow();
    }
    const fixture = staticSiteFixture();
    fixture.files.set("extra/index.html", fixture.html);
    expect(() => snapshotStaticSite(fixture.files, fixture.publicFonts)).toThrow();
  });

  test("rejects private graphs, extra CSS, missing/redundant fonts and wrong installed identities", () => {
    for (const extra of ["styles.css", "graphs/renderer/entries/render.js", "graphs/foundation/receipt.json", "stylex-complete.json", "renderer.js", "source.ts", "extra.woff2", "extra.woff"]) {
      const fixture = staticSiteFixture();
      fixture.files.set(extra, Buffer.from("unexpected"));
      expect(() => snapshotStaticSite(fixture.files, fixture.publicFonts)).toThrow();
    }
    const missingLicense = staticSiteFixture();
    missingLicense.files.delete("fonts/geist-mono/OFL.txt");
    expect(() => snapshotStaticSite(missingLicense.files, missingLicense.publicFonts)).toThrow();
    for (const mutation of ["missing", "changed", "wrong-input", "missing-input"] as const) {
      const fixture = staticSiteFixture();
      const path = fixture.fontPaths[0]!;
      if (mutation === "missing") fixture.files.delete(path);
      else if (mutation === "changed") fixture.files.set(path, Buffer.from("altered"));
      else if (mutation === "wrong-input") fixture.publicFonts.set("nebula-sans/NebulaSans-Light.woff2", Buffer.from("different installed font"));
      else fixture.publicFonts.delete("nebula-sans/NebulaSans-Light.woff2");
      expect(() => snapshotStaticSite(fixture.files, fixture.publicFonts)).toThrow();
    }
  });

  test("rejects remote/data/import/local sources, duplicate faces and URL traversal aliases", () => {
    const fixture = staticSiteFixture();
    const first = `./${fixture.fontPaths[0]!.split("/").at(-1)}`;
    for (const bad of ["data:font/woff2;base64,AA==", "https://outside.invalid/font.woff2", "/font.woff2", "../font.woff2", "./../font.woff2", "font.woff2?x", "font.woff2#x", "%2e%2e/font.woff2", "font%2fchild.woff2", "font%255Bface%255D.woff2"]) {
      expect(() => siteFoundationFontPaths(fixture.foundation, Buffer.from(fixture.css.replace(first, bad)))).toThrow();
    }
    for (const css of [
      `${fixture.css}@import "extra.css";`,
      `${fixture.css}.x{background:url("extra.woff2")}`,
      fixture.css.replace(`url("${first}") format("woff2")`, 'local("Fixture")'),
      fixture.css.replace(first, `./${fixture.fontPaths[1]!.split("/").at(-1)}`),
      fixture.css.replace('format("woff2")', 'format("woff")'),
    ]) expect(() => siteFoundationFontPaths(fixture.foundation, Buffer.from(css))).toThrow();
    expect(siteFoundationFontPaths(fixture.foundation, Buffer.from(fixture.css.replace("[wght]", "%5Bwght%5D")))).toEqual([...fixture.fontPaths].sort());
    for (const css of ['@import "other.css";', '.x{background:url("data:image/svg+xml,example")}']) {
      fixture.files.set("stylex.css", Buffer.from(css));
      expect(() => snapshotStaticSite(fixture.files, fixture.publicFonts)).toThrow();
    }
  });

  test("bracketed request exceptions require a captured canonical key, never broad URL decoding", () => {
    const path = "graphs/foundation/assets/GeistMono[wght]-testhash.woff2";
    const captured = new Set([path]);
    expect(assetPath(`/${path}`)).toBeNull();
    expect(assetPath(`/${path}`, captured)).toBe(path);
    for (const bad of [
      "/graphs/foundation/assets/Other[wght]-testhash.woff2",
      "/graphs/foundation/assets/GeistMono%255Bwght%255D-testhash.woff2",
      "/graphs%2ffoundation/assets/GeistMono%5Bwght%5D-testhash.woff2",
      "/graphs/foundation/assets/../GeistMono[wght]-testhash.woff2",
      "/graphs/foundation/assets/GeistMono[wght]-testhash.woff2/",
    ]) expect(assetPath(bad, captured)).toBeNull();
  });

  test("parsed resource inventories reject string image-set and escaped URL requests in both stylesheets", () => {
    const resourceRules = [
      '.probe{background-image:image-set("https://outside.invalid/image.png" 1x)}',
      '.probe{background-image:-webkit-image-set("https://outside.invalid/image.png" 1x)}',
      String.raw`.probe{background-image:u\72l(https://outside.invalid/image.png)}`,
    ];
    for (const rule of resourceRules) {
      const fixture = staticSiteFixture();
      expect(() => siteFoundationFontPaths(fixture.foundation, Buffer.from(fixture.css + rule))).toThrow("non-font URL");
      fixture.files.set("stylex.css", Buffer.from(rule));
      expect(() => snapshotStaticSite(fixture.files, fixture.publicFonts)).toThrow("unexpected asset URL");
    }
  });

  test("parsed resource inventories ignore harmless quoted content in both stylesheets", () => {
    const fixture = staticSiteFixture();
    const inertRules = String.raw`.probe::before{content:'url(https://outside.invalid/not-a-request.png) image-set("https://outside.invalid/not-a-request.png" 1x)'}`;
    fixture.files.set(fixture.foundation, Buffer.from(fixture.css + inertRules));
    fixture.files.set("stylex.css", Buffer.from(inertRules));
    expect(siteFoundationFontPaths(fixture.foundation, fixture.files.get(fixture.foundation)!)).toEqual([...fixture.fontPaths].sort());
    expect(snapshotStaticSite(fixture.files, fixture.publicFonts).fonts).toEqual([...fixture.fontPaths].sort());
  });

  test("parsed resource inventories reject CSS parser warnings in both stylesheets", () => {
    const invalid = ".probe{color:rgb( ;}";
    const fixture = staticSiteFixture();
    expect(() => siteFoundationFontPaths(fixture.foundation, Buffer.from(fixture.css + invalid))).toThrow();
    fixture.files.set("stylex.css", Buffer.from(invalid));
    expect(() => snapshotStaticSite(fixture.files, fixture.publicFonts)).toThrow();
  });

  test("requires all six Markdown guides and admits their MIME without opening arbitrary Markdown publication", () => {
    for (const path of docsRoutes) {
      const fixture = staticSiteFixture();
      expect(assetContentType(`${path}/index.md`)).toBe("text/markdown; charset=utf-8");
      fixture.files.delete(`${path}/index.md`);
      expect(() => snapshotStaticSite(fixture.files, fixture.publicFonts)).toThrow();
    }
    const fixture = staticSiteFixture();
    fixture.files.set("docs/private.md", Buffer.from("not published"));
    expect(() => snapshotStaticSite(fixture.files, fixture.publicFonts)).toThrow();
    expect(assetContentType("docs/private.md")).toBe("application/octet-stream");
  });
});

describe("separate closed product example generation", () => {
  test("admits its exact relative shell and compiler topology without widening the parent graph", () => {
    const files = productFixture(), product = snapshotProductPreview(files);
    expect(product.paths).toEqual([...files.keys()].sort());
    expect(product.stylesheets).toEqual(["examples/app/graphs/client/assets/foundation-fixture.css", "examples/app/stylex.css"]);
    expect(product.scripts).toEqual(["examples/app/graphs/client/assets/main-fixture.js"]);
    const fixture = staticSiteFixture();
    expect(snapshotStaticSite(fixture.files, fixture.publicFonts).product).toEqual(product);
    expect(assetPath("/examples/app/?view=overview")).toBeNull();
    expect(assetPath("/examples/app/")).toBe("examples/app/index.html");
    expect(assetPath("/examples/app/graphs/client/assets/main-fixture.js")).toBe("examples/app/graphs/client/assets/main-fixture.js");
  });

  test("refuses missing output, compiler receipts, sources, fonts, misplaced and additional CSS", () => {
    for (const path of productFixture().keys()) {
      const files = productFixture(); files.delete(path);
      expect(() => snapshotProductPreview(files)).toThrow();
    }
    for (const path of ["examples/app/stylex-complete.json", "examples/app/source.ts", "examples/app/graphs/client/receipt.json", "examples/app/graphs/client/assets/private.ts", "examples/app/graphs/client/assets/font.woff2", "examples/app/extra/index.html", "examples/app/extra.css", "examples/app/graphs/client/assets/extra.css", "examples/app/graphs/renderer/assets/renderer.js"]) {
      const fixture = staticSiteFixture(); fixture.files.set(path, Buffer.from("extra"));
      expect(() => snapshotStaticSite(fixture.files, fixture.publicFonts)).toThrow();
    }
    const fixture = staticSiteFixture();
    fixture.files.set("examples/other.js", Buffer.from("extra"));
    expect(() => snapshotStaticSite(fixture.files, fixture.publicFonts)).toThrow();
  });

  test("refuses escaped resources, shell changes and inline or active presentation", () => {
    const mutations = [
      (html: string) => html.replace("connect-src 'none'", "connect-src 'self'"),
      (html: string) => html.replace("./stylex.css", "/stylex.css"),
      (html: string) => html.replace("./stylex.css", "./../stylex.css"),
      (html: string) => html.replace("./graphs/client/assets/main-fixture.js", "https://outside.invalid/main.js"),
      (html: string) => html.replace("./graphs/client/assets/main-fixture.js", "./graphs/client/assets/missing.js"),
      (html: string) => html.replace("./graphs/client/assets/main-fixture.js", "./graphs/client/assets/main-fixture.js?x"),
      (html: string) => html.replace('rel="stylesheet"', 'rel="stylesheet" disabled'),
      (html: string) => html.replace("</head>", '<link rel="preload" href="./stylex.css"></head>'),
      (html: string) => html.replace("</head>", '<meta http-equiv="refresh" content="0;url=/"></head>'),
      (html: string) => html.replace("</body>", '<script src="./graphs/client/assets/main-fixture.js"></script></body>'),
      (html: string) => html.replace("</script>", "alert(1)</script>"),
      (html: string) => html.replace("</head>", "<style>div{display:flex}</style></head>"),
      (html: string) => html.replace('id="root"', 'id="root" style="color:red"'),
      (html: string) => html.replace('id="root"', 'id="root" onclick="alert(1)"'),
      (html: string) => html.replace("</body>", '<iframe src="./stylex.css"></iframe></body>'),
    ];
    for (const mutate of mutations) {
      const files = productFixture();
      files.set("examples/app/index.html", Buffer.from(mutate(files.get("examples/app/index.html")!.toString())));
      expect(() => snapshotProductPreview(files)).toThrow();
    }
    for (const path of ["examples/app/stylex.css", "examples/app/graphs/client/assets/foundation-fixture.css"]) {
      for (const css of ['@import "more.css";', '.x{background:url("https://outside.invalid/a.png")}', '.x{background-image:image-set("/a.png" 1x)}']) {
        const files = productFixture(); files.set(path, Buffer.from(css));
        expect(() => snapshotProductPreview(files)).toThrow();
      }
    }
  });

  test("requires genuine scenario-bound quiescence, zero IO and native opaque/inert readiness", () => {
    const observation = () => ({ origin: "null", parentAccessible: false, ready: "true", inert: true,
      now: Date.parse("2026-09-08T12:00:00.000Z"), violations: [], inline: 0, bridgeSchema: "direct.browser-bridge/v2",
      manifest: { schema: "direct.session-manifest/v1", active: { source: "scenario", scenario: "product.question", route: "/", activationHash: "fnv1a-64:123456789abcdef0" } },
      snapshot: { schema: "direct.probe/v1", activationHash: "fnv1a-64:123456789abcdef0", isQuiescent: true,
        activity: { active: 0, started: 0, settled: 0 }, pending: {},
        violations: { "example.blockedFetch": 0, "example.browserActivityError": 0, "example.refusedEffect": 0 } },
      stylesheets: [true, true],
    });
    expect(() => assertProductPreviewObservation(observation(), "question")).not.toThrow();
    expect(() => assertProductPreviewObservation(observation(), "overview")).toThrow();
    expect(() => assertProductPreviewObservation({ ready: "true" }, "question")).toThrow();
    for (const change of [{ origin: "http://localhost" }, { parentAccessible: true }, { ready: undefined }, { failed: "true" }, { inert: false }, { now: 0 }, { violations: ["style-src"] }, { inline: 1 }, { stylesheets: [true, false] }, { bridgeSchema: "lookalike" }]) {
      expect(() => assertProductPreviewObservation({ ...observation(), ...change }, "question")).toThrow();
    }
    for (const name of ["example.blockedFetch", "example.browserActivityError", "example.refusedEffect"] as const) {
      const value = observation(); value.snapshot.violations[name] = 1;
      expect(() => assertProductPreviewObservation(value, "question")).toThrow();
    }
    for (const change of [{ isQuiescent: false }, { activationHash: "fnv1a-64:0000000000000000" }, { activity: { active: 0, started: 1, settled: 1 } }, { pending: { request: 1 } }, { violations: {} }]) {
      const value = observation(); Object.assign(value.snapshot, change);
      expect(() => assertProductPreviewObservation(value, "question")).toThrow();
    }
  });
});

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
