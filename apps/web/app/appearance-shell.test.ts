import { describe, expect, test } from "bun:test";

const canonicalFoundationDeclaration = /--(?:accent|background|card|elevation-low|elevation-overlay|elevation-raised|focus|font-mono|font-text|foreground|grid|line|motion-duration-fast|motion-duration-slow|motion-duration-standard|popover|primary|secondary|surface|surface-hover|surface-raised)\s*:/u;

async function source(name: string): Promise<string> {
  return Bun.file(new URL(name, import.meta.url)).text();
}

describe("HRA shared appearance and shell contract", () => {
  test("starts light and installs the persisted shared appearance runtime", async () => {
    const [layout, providers] = await Promise.all([
      source("./layout.tsx"),
      source("./providers.tsx"),
    ]);

    expect(layout).toContain('<html data-theme="light" lang="en" suppressHydrationWarning>');
    expect(providers).toContain("<DesignThemeProvider>");
    expect(providers).toContain("<ThemeColorSync />");
    expect(providers).toContain("<DesignKitRouterProvider");
  });

  test("keeps the public editorial routes outside hosted auth providers", async () => {
    const providers = await source("./providers.tsx");

    expect(providers).toContain('pathname === "/"');
    expect(providers).toContain('pathname === "/download"');
    expect(providers).toContain('pathname === "/download/"');
    expect(providers).toContain("isHraPublicComparisonPath(pathname)");
    expect(providers).not.toContain('pathname.startsWith("/alternatives/")');
    expect(providers).toContain("standalonePublicRoute || !authConfigured");
    expect(providers).not.toContain('pathname.startsWith("/download")');
  });

  test("keeps rail and bars persistent while the query-addressed body animates", async () => {
    const shell = await source("./admin-shell.tsx");

    expect(shell).toContain("<AppShell");
    expect(shell).toContain("<NavigationRail");
    expect(shell).toContain("<RailSection");
    expect(shell).toContain("<RailItem");
    expect(shell).toContain('navigationKey={navigationKey}');
    expect(shell).toContain('<AnimatedRailStage className="hra-main-stage" stageKey={navigationKey}>');
    expect(shell).toContain("new URLSearchParams({ surface, workspace: workspaceId })");
    expect(shell).toMatch(/return `\/app\?\$\{parameters\.toString\(\)\}`;/u);
    expect(shell).toContain("<HranessBrand />");
    expect(shell).toContain("<ThemeToggle />");
  });

  test("keeps the alert dismiss action named and discoverable", async () => {
    const shell = await source("./admin-shell.tsx");

    expect(shell).toMatch(/<IconButton\s+aria-label="Dismiss"[\s\S]*?tooltip="Dismiss"/u);
    expect(shell).not.toContain("<Tooltip");
    expect(shell).toContain("<Icon icon={Cancel01Icon} />");
    expect(shell).not.toContain('<span aria-hidden="true">×</span>');
  });

  test("keeps persistent navigation focused on choices instead of explanatory metadata", async () => {
    const shell = await source("./admin-shell.tsx");

    expect(shell).not.toContain("Queue, dispatch, HITL, evidence, and review");
    expect(shell).not.toContain("Human roles and persistent agent identities");
    expect(shell).not.toContain('className="identity-legend"');
    expect(shell).not.toContain('className="transport-state"');
    expect(shell).toContain("Local runtime");
  });

  test("uses shared route states, including the root-layout replacement", async () => {
    const [error, globalError, loading, notFound] = await Promise.all([
      source("./error.tsx"),
      source("./global-error.tsx"),
      source("./loading.tsx"),
      source("./not-found.tsx"),
    ]);

    expect(error).toContain("<InlineAlert");
    expect(loading).toContain("<Spinner");
    expect(loading).toContain("<Skeleton");
    expect(loading).not.toMatch(/<h1\b/u);
    expect(loading).not.toContain("Opening HRA");
    expect(loading).not.toContain("PageIntro");
    expect(loading).not.toContain("Restoring the server-authorized organization");
    expect(notFound).toContain("<EmptyState");
    expect(globalError).toContain('import "./globals.css"');
    expect(globalError).toContain("GlobalErrorDocument");
  });

  test("consumes the shared foundation without fixed-dark color literals", async () => {
    const [layout, stylesheet] = await Promise.all([
      source("./layout.tsx"),
      source("./globals.css"),
    ]);

    expect(stylesheet).not.toMatch(canonicalFoundationDeclaration);
    expect(stylesheet).not.toMatch(/#[0-9a-fA-F]{3,8}\b/u);
    expect(stylesheet).not.toMatch(/rgba?\(/u);
    expect(stylesheet).toContain("var(--background)");
    expect(stylesheet).toContain("var(--surface-raised)");
    expect(stylesheet).toContain("var(--success)");
    expect(stylesheet).toContain("var(--danger)");
    expect(layout.indexOf('import "./globals.css"')).toBeLessThan(
      layout.indexOf('import "@hraness/agent-tasks-ui/styles.css"'),
    );
  });
});
