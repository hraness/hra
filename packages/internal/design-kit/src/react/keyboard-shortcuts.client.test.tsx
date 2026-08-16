import { afterEach, expect, test } from "bun:test";
import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { useKeyboardShortcuts } from "./keyboard-shortcuts";

const installedGlobals = [
  "document",
  "Document",
  "DocumentFragment",
  "Element",
  "Event",
  "HTMLElement",
  "HTMLInputElement",
  "Node",
  "navigator",
  "window",
] as const;

const globalRecord = globalThis as unknown as Record<string, unknown>;
const originalDescriptors = new Map(
  installedGlobals.map(name => [
    name,
    Object.getOwnPropertyDescriptor(globalThis, name),
  ]),
);
let mountedRoot: Root | null = null;

function installDom(): HTMLElement {
  const { document, window } = parseHTML(
    '<!doctype html><html><body><div id="root"></div></body></html>',
  );
  const windowRecord = window as unknown as Record<string, unknown>;
  for (const name of installedGlobals) {
    globalRecord[name] = name === "window"
      ? window
      : name === "document"
        ? document
        : windowRecord[name];
  }
  const container = document.getElementById("root");
  if (!(container instanceof window.HTMLElement)) {
    throw new Error("The shortcut test root is missing.");
  }
  return container;
}

function dispatchSpace(target: EventTarget): Event {
  const event = new Event("keydown", { bubbles: true, cancelable: true });
  for (const [name, value] of Object.entries({
    altKey: false,
    ctrlKey: false,
    isComposing: false,
    key: " ",
    metaKey: false,
    repeat: false,
    shiftKey: false,
  })) {
    Object.defineProperty(event, name, { value });
  }
  target.dispatchEvent(event);
  return event;
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

test("a target predicate grants Space to one grid without stealing it from controls", () => {
  globalRecord.IS_REACT_ACT_ENVIRONMENT = true;
  const container = installDom();
  const handledTargets: Array<EventTarget | null> = [];

  function Probe() {
    useKeyboardShortcuts([{
      allowWhenInteractiveTarget: target =>
        target instanceof Element &&
        target.closest('[data-transport-grid="true"]') !== null,
      id: "transport",
      key: "Space",
      onAction: event => handledTargets.push(event.target),
    }]);
    return (
      <>
        <div data-transport-grid="true" role="grid" tabIndex={0}>
          <span data-testid="grid-child" />
        </div>
        <div data-testid="empty-grid" role="grid" tabIndex={0} />
        <button data-testid="button" type="button">Play</button>
        <input aria-label="Title" data-testid="input" />
        <div aria-label="Volume" data-testid="slider" role="slider" tabIndex={0} />
      </>
    );
  }

  mountedRoot = createRoot(container);
  act(() => mountedRoot?.render(<Probe />));

  const gridChild = container.querySelector('[data-testid="grid-child"]');
  const emptyGrid = container.querySelector('[data-testid="empty-grid"]');
  const button = container.querySelector('[data-testid="button"]');
  const input = container.querySelector('[data-testid="input"]');
  const slider = container.querySelector('[data-testid="slider"]');
  if (
    gridChild === null ||
    emptyGrid === null ||
    button === null ||
    input === null ||
    slider === null
  ) {
    throw new Error(`Shortcut targets are missing: ${container.innerHTML}`);
  }

  const allowed = dispatchSpace(gridChild);
  expect(allowed.defaultPrevented).toBe(true);
  expect(handledTargets).toEqual([gridChild]);

  for (const protectedTarget of [emptyGrid, button, input, slider]) {
    const protectedEvent = dispatchSpace(protectedTarget);
    expect(protectedEvent.defaultPrevented).toBe(false);
  }
  expect(handledTargets).toEqual([gridChild]);
});
