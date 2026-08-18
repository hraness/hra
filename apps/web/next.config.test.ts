import { describe, expect, test } from "bun:test";

import {
  PREVIEW_NOTICE_ORIGIN_ENV,
  PREVIEW_ROBOTS_HEADER,
  PREVIEW_ROBOTS_POLICY,
  PRODUCTION_DELIVERY_PROOF_HEADER,
  productionDeliveryProofToken,
} from "@hraness/vercel-delivery";

import nextConfig, {
  createHraNextConfig,
  hraPrivateNoStoreHeaders,
  hraSecurityHeaders,
  hraVercelProjectName,
} from "./next.config";

const deliveryIdentity = {
  deploymentId: ["dpl", "HraDeliveryProof123"].join("_"),
  projectId: ["prj", "HraProject123"].join("_"),
  projectName: "hra",
  sha: "1234567890abcdef1234567890abcdef12345678",
} as const;

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

  test("adds source-bound delivery proof after every existing HRA header rule", async () => {
    expect(hraVercelProjectName).toBe("hra");
    const config = createHraNextConfig({
      VERCEL: "1",
      VERCEL_DEPLOYMENT_ID: deliveryIdentity.deploymentId,
      VERCEL_ENV: "production",
      VERCEL_GIT_COMMIT_SHA: deliveryIdentity.sha,
      VERCEL_PROJECT_ID: deliveryIdentity.projectId,
    });

    expect(await config.headers?.()).toEqual([
      { headers: [...hraSecurityHeaders], source: "/(.*)" },
      {
        headers: [...hraPrivateNoStoreHeaders],
        source: "/api/suite-auth/:path*",
      },
      {
        headers: [...hraPrivateNoStoreHeaders],
        source: "/auth/:path*",
      },
      {
        headers: [{
          key: PRODUCTION_DELIVERY_PROOF_HEADER,
          value: productionDeliveryProofToken(deliveryIdentity),
        }],
        source: "/:path*",
      },
    ]);
  });

  test("adds the bounded Preview notice and crawler policy", async () => {
    const config = createHraNextConfig({
      VERCEL: "1",
      VERCEL_DEPLOYMENT_ID: deliveryIdentity.deploymentId,
      VERCEL_ENV: "preview",
      VERCEL_GIT_COMMIT_SHA: deliveryIdentity.sha,
      VERCEL_PROJECT_ID: deliveryIdentity.projectId,
      VERCEL_URL: "hra-feature-hraness.vercel.app",
    });

    expect(config.env?.[PREVIEW_NOTICE_ORIGIN_ENV])
      .toBe("https://hra-feature-hraness.vercel.app");
    expect((await config.headers?.())?.at(-1)).toEqual({
      headers: [
        {
          key: PRODUCTION_DELIVERY_PROOF_HEADER,
          value: productionDeliveryProofToken(deliveryIdentity),
        },
        { key: PREVIEW_ROBOTS_HEADER, value: PREVIEW_ROBOTS_POLICY },
      ],
      source: "/:path*",
    });
  });

  test("refuses partial Vercel identity instead of emitting an unbound deployment", () => {
    expect(() => createHraNextConfig({
      VERCEL: "1",
      VERCEL_DEPLOYMENT_ID: deliveryIdentity.deploymentId,
    })).toThrow("requires exposed deployment, project, and Git identity");
  });
});
