import { describe, expect, test } from "bun:test";
import { parseHTML } from "linkedom";
import { renderProductPreview } from "./product-preview.tsx";
import { isProductScene, parsePreviewMessage, productPreviewDisclosure, productScenes } from "./product-scenes.ts";
import { docsPages } from "./docs-content.ts";
import { renderDocsHtml } from "./template.ts";

describe("public real-UI examples", () => {
  test("parses only exact public readiness messages without evaluating accessors", () => {
    for (const type of ["hra-preview-ready", "hra-preview-failed"] as const) for (const view of Object.keys(productScenes)) {
      if (!isProductScene(view)) throw new Error("Unregistered test scene");
      expect(parsePreviewMessage({ type, view })).toEqual({ type, view });
    }
    for (const input of [null, [], {}, { type: "login", view: "overview" }, { type: "hra-preview-ready", view: "constructor" }, { type: "hra-preview-ready", view: "overview", account: "real" }, Object.create({ type: "hra-preview-ready", view: "overview" })]) expect(parsePreviewMessage(input)).toBeUndefined();
    let reads = 0;
    expect(parsePreviewMessage({ get type() { reads += 1; return "hra-preview-ready"; }, view: "overview" })).toBeUndefined();
    expect(reads).toBe(0);
  });
  test("admits only the four published scene keys, not object prototype names", () => {
    expect(Object.keys(productScenes)).toEqual(["overview", "conversation", "question", "settings"]);
    for (const input of [null, undefined, [], {}, 1, "constructor", "__proto__", "", "overview&account=real"]) expect(isProductScene(input)).toBe(false);
    for (const input of Object.keys(productScenes)) expect(isProductScene(input)).toBe(true);
  });

  test("keeps each real interface opaque, inert to the reader, and explicitly fictional", () => {
    for (const view of Object.keys(productScenes)) {
      if (!isProductScene(view)) throw new Error("Unregistered test scene");
      const html = renderProductPreview(view, "example");
      const { document } = parseHTML(html);
      const frame = document.querySelector("iframe");
      expect(document.querySelector("#example")?.tagName).toBe("FIGURE");
      expect(document.querySelector("[data-preview-script-notice]")?.hasAttribute("hidden")).toBe(false);
      expect(frame?.getAttribute("src")).toBe(`/examples/app/index.html?view=${view}`);
      expect(frame?.getAttribute("sandbox")).toBe("allow-scripts");
      expect(frame?.getAttribute("tabindex")).toBe("-1");
      expect(frame?.getAttribute("aria-hidden")).toBe("true");
      expect([...frame!.attributes].find((attribute) => attribute.name.toLowerCase() === "referrerpolicy")?.value).toBe("no-referrer");
      expect(document.querySelectorAll("iframe").length).toBe(1);
      expect(document.querySelectorAll("[data-preview-view]").length).toBe(4);
      expect(document.querySelectorAll('[aria-pressed="true"]').length).toBe(1);
      expect(document.querySelector('[aria-pressed="true"]')?.getAttribute("data-preview-view")).toBe(view);
      expect(document.querySelector("figcaption")?.textContent).toContain(productPreviewDisclosure);
      expect(document.querySelector("[data-preview-guide]")?.getAttribute("href")).toBe(productScenes[view].guide);
      expect(document.querySelector("dialog")?.getAttribute("aria-labelledby")).toBe("example-dialog-title");
      expect(document.querySelector("#example-dialog-title")?.textContent).toContain(productScenes[view].label);
      expect(document.querySelectorAll("style,[style],script,form").length).toBe(0);
      expect(html).not.toContain("allow-same-origin");
    }
  });

  test("makes guides readable without script and keeps the full reference subordinate", () => {
    for (const page of docsPages) {
      const { document } = parseHTML(renderDocsHtml(page));
      expect(document.querySelectorAll("h1").length).toBe(1);
      expect(document.querySelector("h1")?.textContent).toBe(page.title);
      expect(document.querySelector('nav[aria-label="Guides"] [aria-current="page"]')?.getAttribute("href")).toBe(page.path);
      expect(document.querySelector('link[rel="alternate"]')?.getAttribute("href")).toBe(`${page.path}index.md`);
      expect(document.querySelectorAll("[data-doc-search]").length).toBe(docsPages.length);
      expect(document.querySelectorAll("style,[style],base").length).toBe(0);
      for (const id of page.referenceSectionIds) {
        const detail = document.getElementById(id);
        if (detail === null) throw new Error("Missing reference section");
        expect(detail.tagName).toBe("DETAILS");
        expect(detail.hasAttribute("open")).toBe(false);
        expect(detail.querySelector("summary")?.textContent.length).toBeGreaterThan(0);
      }
      for (const link of document.querySelectorAll('a[href^="#"]')) {
        const id = link.getAttribute("href")?.slice(1);
        expect(id === undefined ? null : document.getElementById(id)).not.toBeNull();
      }
    }
  });
});
