import { afterEach, describe, expect, test } from "bun:test";
import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

const installedGlobals = [
  "document",
  "Document",
  "DocumentFragment",
  "Element",
  "Event",
  "getComputedStyle",
  "HTMLElement",
  "HTMLButtonElement",
  "HTMLIFrameElement",
  "HTMLInputElement",
  "HTMLLabelElement",
  "HTMLSelectElement",
  "HTMLTextAreaElement",
  "MutationObserver",
  "Node",
  "navigator",
  "ResizeObserver",
  "SVGElement",
  "window",
] as const;

const globalRecord = globalThis as unknown as Record<string, unknown>;
const originalDescriptors = new Map(
  installedGlobals.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]),
);
let mountedRoot: Root | null = null;

class TestResizeObserver {
  disconnect(): void {}
  observe(): void {}
  unobserve(): void {}
}

function testComputedStyle() {
  return {
    backdropFilter: "none",
    borderLeftWidth: "0px",
    borderTopWidth: "0px",
    contain: "none",
    filter: "none",
    getPropertyValue: () => "",
    marginBottom: "0px",
    marginLeft: "0px",
    marginRight: "0px",
    marginTop: "0px",
    position: "static",
    transform: "none",
    willChange: "auto",
  };
}

function installDom(): HTMLElement {
  const { document, window } = parseHTML('<!doctype html><html><body><div id="root"></div></body></html>');
  const windowRecord = window as unknown as Record<string, unknown>;
  for (const name of installedGlobals) {
    globalRecord[name] = name === "window"
      ? window
      : name === "document"
        ? document
        : name === "getComputedStyle"
          ? testComputedStyle
          : name === "ResizeObserver"
            ? TestResizeObserver
            : windowRecord[name];
  }
  windowRecord.getComputedStyle = testComputedStyle;
  windowRecord.ResizeObserver = TestResizeObserver;
  Object.defineProperties(window.HTMLElement.prototype, {
    clientHeight: { configurable: true, get: () => 0 },
    clientWidth: { configurable: true, get: () => 0 },
    offsetHeight: { configurable: true, get: () => 0 },
    offsetWidth: { configurable: true, get: () => 0 },
    scrollHeight: { configurable: true, get: () => 0 },
    scrollLeft: { configurable: true, get: () => 0 },
    scrollTop: { configurable: true, get: () => 0 },
    scrollWidth: { configurable: true, get: () => 0 },
  });
  Object.defineProperties(document.documentElement, {
    clientHeight: { configurable: true, value: 768 },
    clientLeft: { configurable: true, value: 0 },
    clientTop: { configurable: true, value: 0 },
    clientWidth: { configurable: true, value: 1024 },
    scrollLeft: { configurable: true, value: 0 },
    scrollTop: { configurable: true, value: 0 },
  });
  Object.defineProperties(window, {
    innerHeight: { configurable: true, value: 768 },
    innerWidth: { configurable: true, value: 1024 },
    pageXOffset: { configurable: true, value: 0 },
    pageYOffset: { configurable: true, value: 0 },
  });
  const container = document.getElementById("root");
  if (!(container instanceof window.HTMLElement)) throw new Error("The segmented-control test root is missing.");
  return container;
}

function dispatch(
  target: EventTarget,
  type: string,
  properties: Readonly<Record<string, unknown>> = {},
): void {
  const event = new Event(type, { bubbles: true });
  for (const [name, value] of Object.entries(properties)) {
    Object.defineProperty(event, name, { value });
  }
  target.dispatchEvent(event);
}

function visibleTooltipTexts(): readonly string[] {
  return [...document.querySelectorAll('[role="tooltip"]:not([data-exiting])')]
    .map((tooltip) => tooltip.textContent ?? "");
}

afterEach(() => {
  if (mountedRoot !== null) {
    act(() => mountedRoot?.unmount());
    mountedRoot = null;
  }
  for (const name of installedGlobals) {
    const descriptor = originalDescriptors.get(name);
    if (descriptor === undefined) delete globalRecord[name];
    else Object.defineProperty(globalThis, name, descriptor);
  }
  delete globalRecord.IS_REACT_ACT_ENVIRONMENT;
});

describe("SegmentedControl tooltip interaction", () => {
  test("coordinates focus, hover, press, and Escape tooltip dismissal", async () => {
    globalRecord.IS_REACT_ACT_ENVIRONMENT = true;
    const container = installDom();
    const { SegmentedControl } = await import("./segmented-control");
    mountedRoot = createRoot(container);

    act(() => mountedRoot?.render(
      <SegmentedControl
        aria-label="Appearance"
        items={[
          { ariaLabel: "Light", id: "light", label: "L", tooltip: "Light appearance" },
          { ariaLabel: "Dark", id: "dark", label: "D", tooltip: "Dark appearance" },
        ]}
        onChange={() => undefined}
        value="light"
      />,
    ));

    const lightInput = container.querySelector('input[value="light"]');
    const lightLabel = lightInput?.closest("label") ?? null;
    const darkInput = container.querySelector('input[value="dark"]');
    const darkLabel = darkInput?.closest("label") ?? null;
    if (lightInput === null || lightLabel === null || darkInput === null || darkLabel === null) {
      throw new Error(`The segmented-control interaction targets are missing: ${container.innerHTML}`);
    }

    Object.defineProperty(document, "activeElement", { configurable: true, value: lightInput });
    act(() => dispatch(lightInput, "focusin"));
    expect(visibleTooltipTexts()).toEqual(["Light appearance"]);

    act(() => dispatch(lightInput, "keydown", { key: "Escape" }));
    expect(visibleTooltipTexts()).toEqual([]);
    expect(document.activeElement).toBe(lightInput);

    Object.defineProperty(document, "activeElement", { configurable: true, value: document.body });
    act(() => dispatch(lightInput, "focusout"));
    Object.defineProperty(document, "activeElement", { configurable: true, value: lightInput });
    act(() => dispatch(lightInput, "focusin"));
    expect(visibleTooltipTexts()).toEqual(["Light appearance"]);

    act(() => dispatch(darkLabel, "mouseover"));
    expect(visibleTooltipTexts()).toEqual(["Dark appearance"]);

    act(() => dispatch(lightInput, "keydown", { key: "Escape" }));
    expect(visibleTooltipTexts()).toEqual([]);
    expect(document.activeElement).toBe(lightInput);

    act(() => dispatch(darkLabel, "mouseout"));
    expect(visibleTooltipTexts()).toEqual([]);

    Object.defineProperty(document, "activeElement", { configurable: true, value: document.body });
    act(() => dispatch(lightInput, "focusout"));
    Object.defineProperty(document, "activeElement", { configurable: true, value: lightInput });
    act(() => dispatch(lightInput, "focusin"));
    expect(visibleTooltipTexts()).toEqual(["Light appearance"]);

    act(() => dispatch(darkLabel, "mouseover"));
    expect(visibleTooltipTexts()).toEqual(["Dark appearance"]);

    act(() => dispatch(darkLabel, "mouseout"));
    expect(visibleTooltipTexts()).toEqual(["Light appearance"]);

    act(() => dispatch(darkLabel, "mouseover"));
    expect(visibleTooltipTexts()).toEqual(["Dark appearance"]);

    act(() => {
      dispatch(document, "mousedown", { button: 0, buttons: 1 });
      dispatch(darkLabel, "mousedown", { button: 0, buttons: 1 });
    });
    expect(visibleTooltipTexts()).toEqual([]);
    Object.defineProperty(document, "activeElement", { configurable: true, value: document.body });
    act(() => dispatch(lightInput, "focusout"));
    Object.defineProperty(document, "activeElement", { configurable: true, value: darkInput });
    act(() => dispatch(darkInput, "focusin"));
    expect(visibleTooltipTexts()).toEqual([]);
    act(() => {
      dispatch(darkLabel, "mouseup", { button: 0, buttons: 0 });
      dispatch(darkLabel, "click", { button: 0, buttons: 0 });
      dispatch(darkLabel, "mouseout");
    });
    expect(visibleTooltipTexts()).toEqual([]);

    Object.defineProperty(document, "activeElement", { configurable: true, value: document.body });
    act(() => dispatch(darkInput, "focusout"));
    act(() => dispatch(document, "keydown", { key: "Tab" }));
    Object.defineProperty(document, "activeElement", { configurable: true, value: lightInput });
    act(() => dispatch(lightInput, "focusin"));
    expect(visibleTooltipTexts()).toEqual(["Light appearance"]);

    act(() => dispatch(lightInput, "keydown", { key: " ", code: "Space" }));
    expect(visibleTooltipTexts()).toEqual([]);
    act(() => dispatch(lightInput, "keyup", { key: " ", code: "Space" }));

    Object.defineProperty(document, "activeElement", { configurable: true, value: document.body });
    act(() => dispatch(lightInput, "focusout"));
    expect(visibleTooltipTexts()).toEqual([]);

    act(() => dispatch(darkLabel, "mouseover"));
    expect(visibleTooltipTexts()).toEqual(["Dark appearance"]);
    act(() => dispatch(document, "keydown", { key: "Escape" }));
    expect(visibleTooltipTexts()).toEqual([]);
    act(() => dispatch(darkLabel, "mouseout"));
    act(() => dispatch(darkLabel, "mouseover"));
    expect(visibleTooltipTexts()).toEqual(["Dark appearance"]);
  });
});
