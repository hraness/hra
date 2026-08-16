import { describe, expect, test } from "bun:test";

import {
  desktopConnectSourceDirective,
  HRA_DESKTOP_PUBLIC_DIRECTORY,
  rewriteDesktopRendererCsp,
} from "../vite.config";

describe("desktop renderer CSP", () => {
  test("does not copy an ambient public directory into production", () => {
    expect(HRA_DESKTOP_PUBLIC_DIRECTORY).toBe(false);
  });

  test("keeps production network access at the packaged origin", () => {
    expect(desktopConnectSourceDirective("build")).toBe("connect-src 'self'");
    expect(
      rewriteDesktopRendererCsp(
        `<meta content="default-src 'self'; connect-src 'self'">`,
        "build",
      ),
    ).not.toContain("127.0.0.1");
  });

  test("opens only the fixed Vite development origin while serving", () => {
    expect(desktopConnectSourceDirective("serve")).toBe(
      "connect-src 'self' http://127.0.0.1:5173 ws://127.0.0.1:5173",
    );
    expect(desktopConnectSourceDirective("serve")).not.toContain("localhost");
    expect(desktopConnectSourceDirective("serve")).not.toContain("*");
  });

  test("fails closed when the source directive is missing or duplicated", () => {
    expect(() => rewriteDesktopRendererCsp("<meta>", "build")).toThrow();
    expect(() =>
      rewriteDesktopRendererCsp(
        "connect-src 'self'; connect-src 'self'",
        "build",
      ),
    ).toThrow();
  });
});
