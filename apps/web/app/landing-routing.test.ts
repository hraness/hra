import { describe, expect, test } from "bun:test";

import { shouldApplyConfiguredAuthProxy } from "../proxy-policy";

async function source(name: string): Promise<string> {
  return Bun.file(new URL(name, import.meta.url)).text();
}

describe("HRA public and control-plane route boundary", () => {
  test("keeps only exact public surfaces outside configured authentication", () => {
    for (const path of [
      "/",
      "/alternatives",
      "/alternatives/codex-app",
      "/download",
      "/llms.txt",
      "/opengraph-image",
      "/robots.txt",
      "/sitemap.xml",
    ]) {
      expect(shouldApplyConfiguredAuthProxy(path), path).toBeFalse();
    }
    for (const path of [
      "/app",
      "/app/",
      "/app/private",
      "/auth/sign-in",
      "/design",
      "/download/private",
      "/alternative",
      "/alternatives/missing",
    ]) {
      expect(shouldApplyConfiguredAuthProxy(path), path).toBeTrue();
    }
  });

  test("keeps Convex Auth configuration outside public pages", async () => {
    const [landing, controlPlane, layout, providers, authenticated, authProviders] = await Promise.all([
      source("./page.tsx"),
      source("./app/page.tsx"),
      source("./layout.tsx"),
      source("./providers.tsx"),
      source("./authenticated-layout.tsx"),
      source("./authenticated-providers.tsx"),
    ]);

    expect(landing).not.toContain("ConvexAuthNextjsProvider");
    expect(controlPlane).toContain("NEXT_PUBLIC_CONVEX_URL");
    expect(controlPlane).toContain("parseConvexDeployment");
    expect(controlPlane).toContain("<AdminControlPlane transport={deployment.transport} />");
    expect(controlPlane).toContain("HRA is not connected yet.");
    expect(controlPlane).toContain("No provider credentials are exposed to this page.");
    expect(layout).not.toContain("ConvexAuthNextjsServerProvider");
    expect(providers).not.toContain("ConvexAuthNextjsProvider");
    expect(authenticated).toContain("ConvexAuthNextjsServerProvider");
    expect(authenticated).toContain('deployment.kind !== "ready"');
    expect(authProviders).toContain("ConvexAuthNextjsProvider");
  });

  test("fails closed without Convex configuration and accepts password flows only", async () => {
    const [proxy, signIn, signUp, form, pairing] = await Promise.all([
      source("../proxy.ts"),
      source("./auth/sign-in/page.tsx"),
      source("./auth/sign-up/page.tsx"),
      source("./auth/auth-form.tsx"),
      source("./pair/desktop/[pairingId]/page.tsx"),
    ]);

    for (const boundary of [signIn, signUp, pairing]) {
      expect(boundary).toContain("convexAuthIsConfigured()");
      expect(boundary).toContain("AuthConfigurationUnavailable");
    }
    expect(proxy).toContain("NEXT_PUBLIC_CONVEX_URL?.trim()");
    expect(form).toContain('signIn("password"');
    expect(form).toContain("migrationClaimProof");
    expect(form).not.toContain("migrationClaim: rawMigrationClaim");
    expect(form).toContain("The email or password was not accepted.");
    expect(pairing).toContain("desktopPairingIdSchema.safeParse(pairingId)");
  });

  test("negotiates markdown for public pages without inventing an API surface", async () => {
    const [proxy, proxyPolicy, llmsRoute] = await Promise.all([
      source("../proxy.ts"),
      source("../proxy-policy.ts"),
      source("./llms.txt/route.ts"),
    ]);
    expect(proxy).toContain("resolvePublicDiscovery");
    expect(proxy).toContain("appendVaryAccept");
    expect(proxy).toContain('from "./response-headers"');
    expect(proxy).not.toContain("next.config");
    expect(proxyPolicy).toContain('"/llms.txt"');
    expect(llmsRoute).toContain("HRA_LLMS_TXT");
    expect(llmsRoute).toContain("MARKDOWN_CONTENT_TYPE");
  });

  test("returns internal control-plane links to app and guards its complete route tree", async () => {
    const [proxy, shell, suiteAccount, download, notFound] = await Promise.all([
      source("../proxy.ts"),
      source("./admin-shell.tsx"),
      source("./suite-account-control.tsx"),
      source("./download/page.tsx"),
      source("./not-found.tsx"),
    ]);

    expect(proxy).toContain('isPathAtOrBelow(request.nextUrl.pathname, "/app")');
    expect(proxy).toContain('"/auth/sign-in?next=/app"');
    expect(shell).toMatch(/return `\/app\?\$\{parameters\.toString\(\)\}`;/u);
    expect(shell).toContain('window.location.replace("/app")');
    expect(suiteAccount).toContain('href="/api/suite-auth/start?return_to=/app"');
    expect(download).toContain('className="download-control-plane-link" href="/app"');
    expect(notFound).toContain('href="/app" variant="primary">Open control plane');
  });
});
