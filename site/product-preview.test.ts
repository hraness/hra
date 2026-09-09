import { describe, expect, test } from "bun:test";
import * as fc from "fast-check";
import { createContext, runInContext } from "node:vm";
import { parseHTML } from "linkedom";
import { renderProductPreview } from "./product-preview.tsx";
import { createPreviewStatusRelay, isProductScene, parsePreviewMessage, parsePreviewStatusRequest, productPreviewDisclosure, productScenes } from "./product-scenes.ts";
import { docsPages } from "./docs-content.ts";
import { renderDocsHtml } from "./template.ts";

describe("public real-UI examples", () => {
  test("recovers cached readiness after registering its listener without restarting initial navigation", async () => {
    const build = await Bun.build({ entrypoints: [new URL("./site-entry.ts", import.meta.url).pathname], target: "browser", format: "iife" });
    expect(build.success).toBe(true);
    const code = await build.outputs[0]!.text();
    for (const view of Object.keys(productScenes)) {
      if (!isProductScene(view)) throw new Error("Unregistered test scene");
      const { document, window } = parseHTML(renderProductPreview(view, "example"));
      const frame = document.querySelector("iframe")!;
      const initial = frame.getAttribute("src");
      const navigations: string[] = [];
      Object.defineProperty(frame, "src", { get: () => initial, set: (value: string) => { navigations.push(value); } });
      const observers: Element[] = [];
      type PreviewEvent = Readonly<{ data: unknown; source: unknown; origin: string }>;
      const messageListeners: ((event: PreviewEvent) => void)[] = [];
      const requests: unknown[] = [];
      const frameWindow = {
        postMessage(request: unknown, targetOrigin: string) {
          requests.push(request);
          expect(request).toEqual({ type: "hra-preview-status", view });
          expect(targetOrigin).toBe("*");
          expect(messageListeners).toHaveLength(1);
          // A real postMessage clones data into the receiving window's realm.
          const data: unknown = runInContext(`(${JSON.stringify({ type: "hra-preview-ready", view })})`, context);
          for (const listener of messageListeners) listener({ data, source: frameWindow, origin: "null" });
        },
      };
      Object.defineProperty(frame, "contentWindow", { value: frameWindow });
      const context = createContext({ document, window: {
        addEventListener(type: string, listener: (event: PreviewEvent) => void) { if (type === "message") messageListeners.push(listener); },
        location: { hash: "" },
      },
        IntersectionObserver: class { observe(target: Element) { observers.push(target); } disconnect() {} },
        setTimeout: () => 1, clearTimeout() {} });
      runInContext(code, context);
      expect(requests).toEqual([{ type: "hra-preview-status", view }]);
      expect(document.querySelector("[data-preview-status]")?.textContent).toBe("");
      expect(navigations).toEqual([]);
      expect(observers).toEqual([frame]);
      expect(document.querySelector("[data-preview-script-notice]")?.hasAttribute("hidden")).toBe(true);
      document.querySelector(`[data-preview-view="${view}"]`)!.dispatchEvent(new window.Event("click"));
      expect(navigations).toEqual([]);
      const next = view === "overview" ? "conversation" : "overview";
      document.querySelector(`[data-preview-view="${next}"]`)!.dispatchEvent(new window.Event("click"));
      expect(navigations).toEqual([`/examples/app/index.html?view=${next}`]);
    }
  });

  test("parses only exact status requests without evaluating accessors", () => {
    for (const view of Object.keys(productScenes)) {
      if (!isProductScene(view)) throw new Error("Unregistered test scene");
      expect(parsePreviewStatusRequest({ type: "hra-preview-status", view })).toEqual({ type: "hra-preview-status", view });
    }
    let reads = 0;
    const accessor = { get type() { reads += 1; return "hra-preview-status"; }, view: "overview" };
    const hiddenField = Object.defineProperty({ type: "hra-preview-status" }, "view", { value: "overview", enumerable: false });
    const extraSymbol = { type: "hra-preview-status", view: "overview", [Symbol("extra")]: true };
    for (const request of [
      null, undefined, "hra-preview-status", [], {},
      { type: "hra-preview-ready", view: "overview" }, { type: "hra-preview-status", view: "constructor" },
      { type: "hra-preview-status", view: "overview", account: "real" },
      Object.create({ type: "hra-preview-status", view: "overview" }), accessor, hiddenField, extraSymbol,
    ]) expect(parsePreviewStatusRequest(request)).toBeUndefined();
    expect(reads).toBe(0);
  });

  test("replays readiness settled before the parent requested it", () => {
    const sent: unknown[] = [];
    const relay = createPreviewStatusRelay("overview", (message) => { sent.push(message); });
    relay.publish("hra-preview-ready");
    expect(sent).toEqual([{ type: "hra-preview-ready", view: "overview" }]);
    sent.length = 0;
    relay.replay({ type: "hra-preview-status", view: "overview" });
    expect(sent).toEqual([{ type: "hra-preview-ready", view: "overview" }]);
  });

  test("does not invent readiness when the parent requests it before the scene settles", () => {
    const sent: unknown[] = [];
    const relay = createPreviewStatusRelay("conversation", (message) => { sent.push(message); });
    relay.replay({ type: "hra-preview-status", view: "conversation" });
    expect(sent).toEqual([]);
    relay.publish("hra-preview-ready");
    expect(sent).toEqual([{ type: "hra-preview-ready", view: "conversation" }]);
  });

  test("keeps failure authoritative after an earlier ready or a later ready callback", () => {
    const sent: unknown[] = [];
    const relay = createPreviewStatusRelay("settings", (message) => { sent.push(message); });
    relay.publish("hra-preview-ready");
    relay.publish("hra-preview-failed");
    expect(sent.at(-1)).toEqual({ type: "hra-preview-failed", view: "settings" });
    sent.length = 0;
    relay.publish("hra-preview-ready");
    expect(sent.every((message) => parsePreviewMessage(message)?.type === "hra-preview-failed")).toBe(true);
    sent.length = 0;
    relay.replay({ type: "hra-preview-status", view: "settings" });
    expect(sent).toEqual([{ type: "hra-preview-failed", view: "settings" }]);
  });

  test("refuses malformed, cross-scene, extended, inherited and accessor replay requests", () => {
    const sent: unknown[] = [];
    const relay = createPreviewStatusRelay("question", (message) => { sent.push(message); });
    relay.publish("hra-preview-ready");
    sent.length = 0;
    let reads = 0;
    for (const request of [
      null, [], {}, { type: "hra-preview-ready", view: "question" },
      { type: "hra-preview-status", view: "overview" },
      { type: "hra-preview-status", view: "question", extra: true },
      Object.create({ type: "hra-preview-status", view: "question" }),
      { type: "hra-preview-status", get view() { reads += 1; return "question"; } },
      Object.defineProperty({ view: "question" }, "type", { value: "hra-preview-status", enumerable: false }),
    ]) relay.replay(request);
    expect(sent).toEqual([]);
    expect(reads).toBe(0);
  });

  test("status-envelope laws accept only exact public data fields under arbitrary input", () => {
    const view = fc.constantFrom("overview", "conversation", "question", "settings");
    const type = fc.constantFrom("hra-preview-status", "hra-preview-ready", "hra-preview-failed");
    fc.assert(fc.property(view, type, fc.anything({ maxDepth: 2, maxKeys: 4 }), (scene, kind, foreign: unknown) => {
      const envelope = { type: kind, view: scene };
      expect(parsePreviewStatusRequest(envelope)).toEqual(kind === "hra-preview-status" ? envelope : undefined);
      expect(parsePreviewMessage(envelope)).toEqual(kind === "hra-preview-status" ? undefined : envelope);
      for (const parsed of [parsePreviewStatusRequest(foreign), parsePreviewMessage(foreign)]) {
        if (parsed === undefined) continue;
        expect(Object.getPrototypeOf(foreign)).toBe(Object.prototype);
        expect(Reflect.ownKeys(foreign as object).sort()).toEqual(["type", "view"]);
        for (const key of ["type", "view"] as const) {
          const descriptor = Object.getOwnPropertyDescriptor(foreign, key);
          expect(descriptor?.enumerable).toBe(true);
          expect(descriptor !== undefined && "value" in descriptor).toBe(true);
          expect(descriptor?.value as unknown).toBe(parsed[key]);
        }
        expect(["overview", "conversation", "question", "settings"]).toContain(parsed.view);
      }
      let reads = 0;
      const accessor = { ...envelope };
      Object.defineProperty(accessor, "view", { enumerable: true, get() { reads += 1; return scene; } });
      for (const invalid of [
        { ...envelope, extra: foreign },
        { ...envelope, [Symbol("extra")]: foreign },
        Object.create(envelope),
        Object.assign(Object.create(null) as object, envelope),
        Object.defineProperty({ ...envelope }, "type", { enumerable: false }),
        accessor,
      ]) {
        expect(parsePreviewStatusRequest(invalid)).toBeUndefined();
        expect(parsePreviewMessage(invalid)).toBeUndefined();
      }
      expect(reads).toBe(0);
    }), { seed: 20260909, numRuns: 100 });
  });

  test("generated publish and replay sequences retain latest status and never clear failure", () => {
    const view = fc.constantFrom("overview", "conversation", "question", "settings");
    const operation = fc.constantFrom("ready", "failed", "match", "cross", "extra", "accessor", "inherited", "malformed");
    const step = fc.record({ operation, payload: fc.anything({ maxDepth: 2, maxKeys: 4 }) });
    fc.assert(fc.property(view, fc.array(step, { maxLength: 25 }), (scene, steps) => {
      const sent: unknown[] = [];
      const relay = createPreviewStatusRelay(scene, (message) => { sent.push(message); });
      let latest: "hra-preview-ready" | "hra-preview-failed" | undefined;
      let reads = 0;
      for (const action of steps) {
        const before = sent.length;
        if (action.operation === "ready" || action.operation === "failed") {
          const published = action.operation === "ready" ? "hra-preview-ready" : "hra-preview-failed";
          const alreadyFailed = latest === "hra-preview-failed";
          relay.publish(published);
          if (!alreadyFailed) latest = published;
          expect(sent.slice(before)).toEqual(alreadyFailed ? [] : [{ type: published, view: scene }]);
          continue;
        }
        const matching = { type: "hra-preview-status", view: scene };
        let request: unknown;
        switch (action.operation) {
          case "match": request = matching; break;
          case "cross": request = { ...matching, view: scene === "overview" ? "settings" : "overview" }; break;
          case "extra": request = { ...matching, extra: action.payload }; break;
          case "accessor": request = { view: scene, get type() { reads += 1; return "hra-preview-status"; } }; break;
          case "inherited": request = Object.create(matching); break;
          case "malformed": request = [action.payload]; break;
        }
        relay.replay(request);
        expect(sent.slice(before)).toEqual(action.operation === "match" && latest !== undefined ? [{ type: latest, view: scene }] : []);
      }
      const before = sent.length;
      relay.replay({ type: "hra-preview-status", view: scene });
      expect(sent.slice(before)).toEqual(latest === undefined ? [] : [{ type: latest, view: scene }]);
      expect(reads).toBe(0);
    }), { seed: 20260910, numRuns: 100 });
  });

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
