import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { buildSite } from "../scripts/build-site.ts";
import {
  renderAskAiAboutThis,
  renderHraSiteFooter,
  renderPreviewHtml,
  renderPrivacyHtml,
  renderSiteHtml,
} from "./template.ts";

const temporaryRoots: string[] = [];

const createFixtureRoot = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "hra-site-test-"));
  temporaryRoots.push(root);
  await mkdir(join(root, "site"), { recursive: true });
  await Promise.all(
    ["favicon.svg", "social-card.svg", "styles.css"].map(async (asset) => {
      await writeFile(join(root, "site", asset), `fixture:${asset}\n`, "utf8");
    }),
  );
  return root;
};

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map(async (root) => {
      await rm(root, { force: true, recursive: true });
    }),
  );
});

describe("static-site build", () => {
  test("renders one crawlable Ask AI row on each public page with exact provider prompts", () => {
    const subjectUrl = "https://hra.sh/privacy/";
    const prompt = `Tell me about ${subjectUrl}`;
    const row = renderAskAiAboutThis(subjectUrl);
    const providers = [
      ["chatgpt", "https://chatgpt.com/", "q"],
      ["claude", "https://claude.ai/new", "q"],
      ["perplexity", "https://perplexity.ai/", "q"],
      ["grok", "https://x.com/i/grok", "text"],
    ] as const;

    expect(row.match(/<nav\b/gu)).toHaveLength(1);
    expect(row).toContain('aria-label="Ask AI about this"');
    expect(row.match(/data-slot="ask-ai-about-this-link"/gu)).toHaveLength(4);
    expect(row.match(/target="_blank"/gu)).toHaveLength(4);
    expect(row.match(/rel="noopener noreferrer nofollow"/gu)).toHaveLength(4);
    for (const [provider, baseUrl, parameter] of providers) {
      const destination = new URL(baseUrl);
      destination.searchParams.set(parameter, prompt);
      expect(row).toContain(`data-ask-ai-provider="${provider}"`);
      expect(row).toContain(`href="${destination.href.replaceAll("&", "&amp;")}"`);
    }

    const publicPages = [
      [renderSiteHtml(), "https://hra.sh/"],
      [renderPrivacyHtml(), subjectUrl],
    ] as const;
    for (const [html, canonicalUrl] of publicPages) {
      const destination = new URL("https://chatgpt.com/");
      destination.searchParams.set("q", `Tell me about ${canonicalUrl}`);
      expect(html.match(/data-slot="ask-ai-about-this"/gu)).toHaveLength(1);
      expect(html).toContain(destination.href.replaceAll("&", "&amp;"));
    }

    expect(renderPreviewHtml()).not.toContain('data-slot="ask-ai-about-this"');
  });

  test("writes every named public artifact and then passes check mode", async () => {
    const root = await createFixtureRoot();
    expect(await buildSite({ check: false, repositoryRoot: root })).toEqual([]);
    expect(await buildSite({ check: true, repositoryRoot: root })).toEqual([]);

    const expectedPaths = [
      "README.md",
      "PRIVACY.md",
      "dist/site/index.html",
      "dist/site/preview/index.html",
      "dist/site/privacy/index.html",
      "dist/site/robots.txt",
      "dist/site/sitemap.xml",
      "dist/site/llms.txt",
      "dist/site/.well-known/security.txt",
      "dist/site/.well-known/hra.json",
      "dist/site/favicon.svg",
      "dist/site/social-card.svg",
      "dist/site/styles.css",
      "dist/site/fonts/nebula-sans/LICENSE.txt",
      "dist/site/fonts/nebula-sans/PROVENANCE.md",
    ];

    for (const path of expectedPaths) {
      expect((await readFile(join(root, path), "utf8")).length).toBeGreaterThan(0);
    }

    const builtStyles = await readFile(join(root, "dist/site/styles.css"), "utf8");
    expect(builtStyles).toContain("fixture:styles.css");
    expect(builtStyles).toContain('font-family: "Nebula Sans";');
    expect(builtStyles).toContain('./fonts/nebula-sans/NebulaSans-Book.woff2');
    expect(builtStyles).toContain(".hraness-marketing-hero");
    expect(builtStyles).toContain(".hraness-marketing-interface-grid");
    expect(builtStyles).toContain(".hraness-site-footer {");

    expect((await readFile(
      join(root, "dist/site/fonts/nebula-sans/NebulaSans-Bold.woff2"),
    )).byteLength).toBeGreaterThan(60_000);

    expect(JSON.parse(
      await readFile(join(root, "dist/site/.well-known/hra.json"), "utf8"),
    )).toEqual({
      generation: 1,
      product: "HRA",
      repository: {
        id: 1_343_008_607,
        path: "hraness/hra",
      },
      schemaVersion: 2,
      source: {
        commit: "local",
      },
      version: "0.1.0",
    });
  });

  test("binds hosted identity to one exact source commit", async () => {
    const root = await createFixtureRoot();
    const commit = "0123456789abcdef0123456789abcdef01234567";
    await buildSite({ check: false, releaseCommit: commit, repositoryRoot: root });
    const identity = JSON.parse(
      await readFile(join(root, "dist/site/.well-known/hra.json"), "utf8"),
    ) as { source?: { commit?: unknown } };

    expect(identity.source?.commit).toBe(commit);
    await expect(buildSite({
      check: false,
      releaseCommit: "not-a-commit",
      repositoryRoot: root,
    })).rejects.toThrow("Release commit");
  });

  test("keeps immutable hosted deployment identity separate from the forward CLI version", async () => {
    const root = await createFixtureRoot();
    await buildSite({ check: false, repositoryRoot: root });
    const identity = JSON.parse(
      await readFile(join(root, "dist/site/.well-known/hra.json"), "utf8"),
    ) as { version?: unknown };
    const packageJson = JSON.parse(
      await readFile(join(import.meta.dir, "..", "package.json"), "utf8"),
    ) as { version?: unknown };

    expect(identity.version).toBe("0.1.0");
    expect(packageJson.version).toBe("0.1.6");
    expect(identity.version).not.toBe(packageJson.version);
  });

  test("does not publish the retired adjacent-reading cluster", async () => {
    const root = await createFixtureRoot();
    await buildSite({ check: false, repositoryRoot: root });
    const publicDocuments = await Promise.all([
      "dist/site/index.html",
      "dist/site/llms.txt",
      "dist/site/sitemap.xml",
    ].map(async (path) => readFile(join(root, path), "utf8")));
    const retiredRoutes = [
      "/reading/deepseek-harness/",
      "/reading/hax/",
      "/reading/headlong-microharness/",
      "/reading/oracle-and-firm/",
    ] as const;

    for (const route of retiredRoutes) {
      for (const document of publicDocuments) {
        expect(document).not.toContain(route);
      }
      await expect(readFile(join(root, "dist/site", route, "index.html"), "utf8"))
        .rejects.toThrow();
    }
  });

  test("reconstructs the owned site output without stale retired artifacts", async () => {
    const root = await createFixtureRoot();
    const stalePaths = [
      "dist/site/reading/index.html",
      "dist/site/reading/deepseek-harness/index.html",
      "dist/site/images/editorial/deepseek-harness.webp",
    ] as const;
    for (const path of stalePaths) {
      await mkdir(dirname(join(root, path)), { recursive: true });
      await writeFile(join(root, path), "stale retired artifact\n", "utf8");
    }

    await buildSite({ check: false, repositoryRoot: root });

    for (const path of stalePaths) {
      await expect(readFile(join(root, path), "utf8")).rejects.toThrow();
    }
    expect(await readFile(join(root, "dist/site/index.html"), "utf8"))
      .toBe(renderSiteHtml());
  });

  test("generates the inert preview without publishing it as an indexable document", async () => {
    const root = await createFixtureRoot();
    await buildSite({ check: false, repositoryRoot: root });
    const preview = await readFile(join(root, "dist/site/preview/index.html"), "utf8");
    const sitemap = await readFile(join(root, "dist/site/sitemap.xml"), "utf8");

    expect(preview).toBe(renderPreviewHtml());
    expect(preview).toContain('<meta name="robots" content="noindex, nofollow">');
    expect(preview).toContain('<link rel="canonical" href="https://hra.sh/">');
    expect(sitemap).not.toContain("/preview");
  });

  test("passes check mode in a clean clone without ignored build output", async () => {
    const root = await createFixtureRoot();
    await buildSite({ check: false, repositoryRoot: root });
    await rm(join(root, "dist"), { force: true, recursive: true });

    expect(await buildSite({ check: true, repositoryRoot: root })).toEqual([]);
  });

  test("reports stale tracked public documents without repairing build output", async () => {
    const root = await createFixtureRoot();
    await buildSite({ check: false, repositoryRoot: root });
    await writeFile(join(root, "README.md"), "stale\n", "utf8");
    await writeFile(join(root, "dist/site/styles.css"), "stale\n", "utf8");

    const mismatches = await buildSite({ check: true, repositoryRoot: root });
    expect(mismatches).toEqual([join(root, "README.md")]);
    expect(await readFile(join(root, "README.md"), "utf8")).toBe("stale\n");
    expect(await readFile(join(root, "dist/site/styles.css"), "utf8")).toBe("stale\n");
  });

  test("admits only the configured Turnstile runtime and restrictive response headers", async () => {
    const repositoryRoot = join(import.meta.dir, "..");
    const html = renderSiteHtml();
    const css = await readFile(join(repositoryRoot, "site/styles.css"), "utf8");
    const vercel = JSON.parse(
      await readFile(join(repositoryRoot, "vercel.json"), "utf8"),
    ) as { headers?: unknown };

    expect(html).not.toMatch(/<script[^>]+src=/);
    expect(renderHraSiteFooter("1x00000000000000000000AA")).toContain(
      'src="https://challenges.cloudflare.com/turnstile/v0/api.js"',
    );
    expect(html).not.toMatch(/<link[^>]+rel="(?:icon|stylesheet)"[^>]+href="https?:\/\//);
    expect(css).not.toMatch(/url\(["']?https?:\/\//);
    expect(css).toContain('--font-sans: "Nebula Sans", ui-sans-serif, system-ui');
    expect(css).toContain("font-family: var(--font-sans);");
    expect(css).not.toMatch(/font-family:\s*ui-sans-serif/u);
    expect(css).toContain('font-family: ui-monospace, "SFMono-Regular"');
    expect(await readFile(join(repositoryRoot, "site/social-card.svg"), "utf8"))
      .toContain('font-family="Nebula Sans, ui-sans-serif, system-ui, sans-serif"');
    expect(vercel.headers).toEqual([
      {
        source: "/preview/",
        headers: [
          {
            key: "Content-Security-Policy",
            value: "default-src 'none'; base-uri 'none'; connect-src 'none'; font-src 'self'; form-action 'none'; frame-ancestors https://hraness.com https://www.hraness.com; img-src 'self' data:; manifest-src 'self'; script-src 'none'; style-src 'self'",
          },
          { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
          {
            key: "Permissions-Policy",
            value: "camera=(), geolocation=(), microphone=(), payment=(), usb=()",
          },
          { key: "Referrer-Policy", value: "no-referrer" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Robots-Tag", value: "noindex, nofollow" },
        ],
      },
      {
        source: "/((?!preview/?$).*)",
        headers: [
          {
            key: "Content-Security-Policy",
            value: "default-src 'none'; base-uri 'none'; connect-src 'none'; font-src 'self'; form-action https://account.hraness.com; frame-ancestors 'none'; frame-src https://challenges.cloudflare.com; img-src 'self' data:; manifest-src 'self'; script-src https://challenges.cloudflare.com; style-src 'self'",
          },
          { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
          {
            key: "Permissions-Policy",
            value: "camera=(), geolocation=(), microphone=(), payment=(), usb=()",
          },
          { key: "Referrer-Policy", value: "no-referrer" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
        ],
      },
    ]);
  });
});
