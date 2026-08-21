import { describe, expect, test } from "bun:test";

import { devFeedbackIsStale, devHudPresentation } from "./DevHud";
import { parseDevStatusEnvelope, type DevStatusEnvelope } from "./protocol";

const baseStatus: DevStatusEnvelope = parseDevStatusEnvelope({
  schema: "hra-dev-status/v1",
  sessionId: "a".repeat(64),
  authority: "launcher",
  revision: 1,
  state: "current",
  target: "none",
  changeCount: 0,
  candidateId: null,
});

describe("development HUD language", () => {
  test("mounts in the header action slot instead of covering centered chrome", async () => {
    const [entry, styles, app] = await Promise.all([
      Bun.file(new URL("./main.dev.tsx", import.meta.url)).text(),
      Bun.file(new URL("./dev.css", import.meta.url)).text(),
      Bun.file(new URL("../src/App.tsx", import.meta.url)).text(),
    ]);
    expect(entry).toContain("headerAccessory={<DevHud transport={transport} />}");
    expect(app).toContain('<div className="hra-header__actions">');
    expect(styles).toMatch(/\.hra-dev\s*\{[^}]*position:\s*relative;/su);
    expect(styles).not.toMatch(/\.hra-dev\s*\{[^}]*position:\s*fixed;/su);
  });

  test("explains the three reload lanes without backend details", () => {
    const current = devHudPresentation(
      { kind: "status", status: baseStatus },
      "idle",
    );
    const staged = devHudPresentation({
      kind: "status",
      status: parseDevStatusEnvelope({
        ...baseStatus,
        revision: 2,
        state: "staged",
        target: "gateway",
        changeCount: 1,
        candidateId: "b".repeat(64),
      }),
    }, "idle");
    const restart = devHudPresentation({
      kind: "status",
      status: parseDevStatusEnvelope({
        ...baseStatus,
        revision: 3,
        state: "restartRequired",
        target: "native",
        changeCount: 1,
      }),
    }, "idle");

    expect(current.label).toBe("DEV · UI live");
    expect(current.detail).toContain("Actor-policy text and data compile");
    expect(staged.label).toBe("DEV · Runtime ready");
    expect(restart.label).toBe("DEV · Restart needed");
    expect(restart.detail).toContain("other runtime");
    expect(JSON.stringify([current, staged, restart])).not.toMatch(
      /candidateId|sessionId|provider|account|\/private\//u,
    );
  });

  test("makes plain Vite explicitly UI-only", () => {
    const presentation = devHudPresentation({
      kind: "status",
      status: parseDevStatusEnvelope({
        schema: "hra-dev-status/v1",
        sessionId: baseStatus.sessionId,
        authority: "uiOnly",
        revision: 0,
        state: "current",
        target: "none",
        changeCount: 0,
        candidateId: null,
      }),
    }, "idle");
    expect(presentation.title).toBe("UI-only development");
    expect(presentation.detail).toContain("bun hra");
  });

  test("retires stale apply feedback after a newer build or candidate", () => {
    const fence = { revision: 4, candidateId: "b".repeat(64) };
    const newer = parseDevStatusEnvelope({
      ...baseStatus,
      revision: 5,
      state: "staged",
      target: "gateway",
      changeCount: 1,
      candidateId: "b".repeat(64),
    });
    const replacement = parseDevStatusEnvelope({
      ...newer,
      revision: 4,
      candidateId: "c".repeat(64),
    });
    expect(devFeedbackIsStale(fence, newer)).toBeTrue();
    expect(devFeedbackIsStale(fence, replacement)).toBeTrue();
  });

  test("asks for a restart when Native accepted but readiness is ambiguous", () => {
    const presentation = devHudPresentation(
      { kind: "status", status: baseStatus },
      "acceptedUnconfirmed",
    );
    expect(presentation.label).toBe("DEV · Restart needed");
    expect(presentation.detail).toContain("Restart bun hra");
  });
});
