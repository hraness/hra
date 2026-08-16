import { describe, expect, test } from "bun:test";

import nextConfig, {
  hraPrivateNoStoreHeaders,
  hraSecurityHeaders,
} from "./next.config";

describe("HRA response security headers", () => {
  test("denies embedding and active-object injection without constraining providers", async () => {
    expect(hraSecurityHeaders).toContainEqual({
      key: "Content-Security-Policy",
      value: "base-uri 'none'; frame-ancestors 'none'; object-src 'none'",
    });
    expect(hraSecurityHeaders).toContainEqual({
      key: "X-Frame-Options",
      value: "DENY",
    });
    expect(hraSecurityHeaders).toContainEqual({
      key: "X-Content-Type-Options",
      value: "nosniff",
    });
    expect(hraSecurityHeaders).toContainEqual({
      key: "Strict-Transport-Security",
      value: "max-age=31536000",
    });
    expect(await nextConfig.headers?.()).toEqual([
      { headers: [...hraSecurityHeaders], source: "/(.*)" },
      {
        headers: [...hraPrivateNoStoreHeaders],
        source: "/api/suite-auth/:path*",
      },
      {
        headers: [...hraPrivateNoStoreHeaders],
        source: "/auth/:path*",
      },
    ]);
  });

  test("marks every identity response as private and non-cacheable", () => {
    expect(hraPrivateNoStoreHeaders).toEqual([
      {
        key: "Cache-Control",
        value: "private, no-store, max-age=0, must-revalidate",
      },
    ]);
  });

  test("does not expose a server-side image decoding surface", () => {
    expect(nextConfig.images).toEqual({ unoptimized: true });
    expect(nextConfig.poweredByHeader).toBeFalse();
  });

  test("does not retain a rewrite that forwards ambient request headers", () => {
    expect(nextConfig.rewrites).toBeUndefined();
  });

});
