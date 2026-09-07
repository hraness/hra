import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

const requests: unknown[] = [];
let finishRequest: (() => void) | undefined;
let rejectRequest: (() => void) | undefined;

await mock.module("@convex-dev/auth/react", () => ({
  useAuthActions: () => ({
    signIn: async (_provider: string, params: unknown) => {
      requests.push(params);
      await new Promise<void>((resolve, reject) => {
        finishRequest = resolve;
        rejectRequest = () => { reject(new Error("request refused")); };
      });
    },
  }),
}));

const { SignInScreen } = await import("./sign-in-screen");
const installedGlobals = [
  "document", "Document", "DocumentFragment", "Element", "Event", "HTMLElement",
  "Node", "navigator", "window",
] as const;
const globalRecord = globalThis as unknown as Record<string, unknown>;
const originalDescriptors = new Map(
  installedGlobals.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]),
);
let mountedRoot: Root | null = null;

beforeEach(() => {
  const { document, window } = parseHTML('<!doctype html><html><body><div id="root"></div></body></html>');
  const windowRecord = window as unknown as Record<string, unknown>;
  for (const name of installedGlobals) {
    globalRecord[name] = name === "window" ? window : name === "document" ? document : windowRecord[name];
  }
  globalRecord.IS_REACT_ACT_ENVIRONMENT = true;
  requests.length = 0;
  finishRequest = undefined;
  rejectRequest = undefined;
});

afterEach(() => {
  if (mountedRoot !== null) {
    act(() => { mountedRoot?.unmount(); });
    mountedRoot = null;
  }
  for (const name of installedGlobals) {
    const descriptor = originalDescriptors.get(name);
    if (descriptor === undefined) Reflect.deleteProperty(globalRecord, name);
    else Object.defineProperty(globalThis, name, descriptor);
  }
  Reflect.deleteProperty(globalRecord, "IS_REACT_ACT_ENVIRONMENT");
});

async function renderMounted(): Promise<HTMLElement> {
  const container = document.getElementById("root");
  if (!(container instanceof HTMLElement)) throw new Error("missing test root");
  mountedRoot = createRoot(container);
  await act(async () => { mountedRoot?.render(<SignInScreen />); });
  return container;
}

function submit(container: HTMLElement): void {
  const form = container.querySelector("form");
  if (form === null) throw new Error("missing sign-in form");
  form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
}

describe("HRA email sign-in request ownership", () => {
  test("freezes the requested address while its code is being sent, and permits editing after failure", async () => {
    const container = await renderMounted();
    await act(async () => { submit(container); });
    expect(requests).toHaveLength(1);
    expect(container.querySelector('input[name="email"]')?.hasAttribute("disabled")).toBe(true);

    await act(async () => { rejectRequest?.(); });

    expect(container.querySelector('input[name="email"]')?.hasAttribute("disabled")).toBe(false);
    expect(container.textContent).toContain("That address could not be used");
  });

  test("claims a submit synchronously so two events in one render send only one code", async () => {
    const container = await renderMounted();
    await act(async () => { submit(container); submit(container); });
    expect(requests).toHaveLength(1);
    await act(async () => { finishRequest?.(); });
    expect(container.querySelector('input[name="code"]')).not.toBeNull();
  });

  test("cannot change identity or code during verification but can retry a rejected code", async () => {
    const container = await renderMounted();
    await act(async () => { submit(container); });
    await act(async () => { finishRequest?.(); });
    await act(async () => { submit(container); });
    expect(container.querySelector('input[name="code"]')?.hasAttribute("disabled")).toBe(true);
    const differentAddress = [...container.querySelectorAll("button")]
      .find((button) => button.textContent === "Use a different address");
    expect(differentAddress?.hasAttribute("disabled")).toBe(true);
    await act(async () => { rejectRequest?.(); });
    expect(container.querySelector('input[name="code"]')?.hasAttribute("disabled")).toBe(false);
    expect(differentAddress?.hasAttribute("disabled")).toBe(false);
  });
});
