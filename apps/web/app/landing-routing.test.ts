import { describe, expect, test } from "bun:test";

import { shouldApplyConfiguredAuthProxy } from "../proxy";

async function source(name: string): Promise<string> {
  return Bun.file(new URL(name, import.meta.url)).text();
}

describe("HRA public and control-plane route boundary", () => {
  test("keeps only exact public surfaces outside configured WorkOS auth", () => {
    for (const path of [
      "/",
      "/download",
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
    ]) {
      expect(shouldApplyConfiguredAuthProxy(path), path).toBeTrue();
    }
  });

  test("moves the exact configuration and admin entry to app", async () => {
    const [landing, controlPlane, workOSConfiguration] = await Promise.all([
      source("./page.tsx"),
      source("./app/page.tsx"),
      source("./workos-configuration.ts"),
    ]);

    expect(landing).not.toContain("requiredWorkOSEnvironment");
    for (const key of [
      "WORKOS_API_KEY",
      "WORKOS_CLIENT_ID",
      "WORKOS_COOKIE_PASSWORD",
      "NEXT_PUBLIC_WORKOS_REDIRECT_URI",
    ]) {
      expect(workOSConfiguration).toContain(key);
    }
    expect(controlPlane).toContain("NEXT_PUBLIC_CONVEX_URL");
    expect(controlPlane).toContain("parseConvexDeployment");
    expect(controlPlane).toContain("<AdminControlPlane transport={deployment.transport} />");
    expect(controlPlane).toContain("HRA is not connected yet.");
    expect(controlPlane).toContain("No provider credentials are exposed to this page.");
  });

  test("uses one whitespace-safe WorkOS parser at every entry boundary", async () => {
    const [layout, proxy, signIn, signUp, controlPlane, organizations] = await Promise.all([
      source("./layout.tsx"),
      source("../proxy.ts"),
      source("./auth/sign-in/route.ts"),
      source("./auth/sign-up/route.ts"),
      source("./app/page.tsx"),
      source("./organization-actions.ts"),
    ]);

    for (const boundary of [layout, proxy, signIn, signUp]) {
      expect(boundary).toContain("isWorkOSEnvironmentConfigured(process.env)");
      expect(boundary).not.toContain("value.length > 0");
    }
    expect(controlPlane).toContain("missingWorkOSEnvironment(process.env)");
    expect(organizations).toContain("isNonEmptyEnvironmentValue(apiKey)");
    expect(organizations).toContain("isNonEmptyEnvironmentValue(clientId)");
  });

  test("returns auth and every internal control-plane link to app", async () => {
    const [callback, signIn, signUp, shell, suiteAccount, download, notFound] = await Promise.all([
      source("./auth/callback/route.ts"),
      source("./auth/sign-in/route.ts"),
      source("./auth/sign-up/route.ts"),
      source("./admin-shell.tsx"),
      source("./suite-account-control.tsx"),
      source("./download/page.tsx"),
      source("./not-found.tsx"),
    ]);

    expect(callback).toContain('returnPathname: "/app"');
    expect(signIn).toContain('getSignInUrl({ returnTo: "/app" })');
    expect(signUp).toContain('getSignUpUrl({ returnTo: "/app" })');
    expect(shell).toMatch(/return `\/app\?\$\{parameters\.toString\(\)\}`;/u);
    expect(shell).toContain('returnTo: "/app"');
    expect(shell).toContain('window.location.replace("/app")');
    expect(shell).toContain('signOut({ returnTo: "/" })');
    expect(suiteAccount).toContain('href="/api/suite-auth/start?return_to=/app"');
    expect(download).toContain('className="download-control-plane-link" href="/app"');
    expect(notFound).toContain('href="/app" variant="primary">Open control plane');
  });
});
