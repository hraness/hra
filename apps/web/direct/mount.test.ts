import { describe, expect, test } from "bun:test";

import { mountAgentTasksDirect } from "./mount";

function requiredMount() {
  const mounted = mountAgentTasksDirect({
    kind: "scenario",
    scenario: "tasks-rich-review",
  });
  if (!mounted.ok) throw new Error(mounted.error.message);
  return mounted.value;
}

describe("Agent Tasks Direct browser mount", () => {
  test("cleanup replay remounts a fresh session and restores every browser global", () => {
    const originalFetch = globalThis.fetch;
    const browserGlobal = globalThis as typeof globalThis & { readonly __direct?: unknown };

    const first = requiredMount();
    expect(browserGlobal.__direct).toBeDefined();
    expect(globalThis.fetch).not.toBe(originalFetch);

    first.dispose();
    first.dispose();
    expect(first.session.isDisposed()).toBeTrue();
    expect(browserGlobal.__direct).toBeUndefined();
    expect(globalThis.fetch).toBe(originalFetch);

    const second = requiredMount();
    expect(second.session).not.toBe(first.session);
    expect(second.session.isDisposed()).toBeFalse();
    expect(browserGlobal.__direct).toBeDefined();
    expect(globalThis.fetch).not.toBe(originalFetch);

    second.dispose();
    expect(second.session.isDisposed()).toBeTrue();
    expect(browserGlobal.__direct).toBeUndefined();
    expect(globalThis.fetch).toBe(originalFetch);
  });

  test("browser installation failure leaves the global firewall untouched", () => {
    const originalFetch = globalThis.fetch;
    const target = Object.freeze({ __direct: "occupied" });
    const mounted = mountAgentTasksDirect(
      { kind: "scenario", scenario: "tasks-rich-review" },
      { target },
    );

    expect(mounted).toMatchObject({
      ok: false,
      error: { code: "browser-install-failed" },
    });
    expect(target.__direct).toBe("occupied");
    expect(globalThis.fetch).toBe(originalFetch);
  });
});
