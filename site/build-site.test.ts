import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildSite } from "../scripts/build-site.ts";
import { renderPreviewHtml, renderSiteHtml } from "./template.ts";

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
      "dist/site/reading/deepseek-harness/index.html",
      "dist/site/robots.txt",
      "dist/site/sitemap.xml",
      "dist/site/llms.txt",
      "dist/site/.well-known/security.txt",
      "dist/site/.well-known/hra.json",
      "dist/site/favicon.svg",
      "dist/site/social-card.svg",
      "dist/site/styles.css",
    ];

    for (const path of expectedPaths) {
      expect((await readFile(join(root, path), "utf8")).length).toBeGreaterThan(0);
    }

    const builtStyles = await readFile(join(root, "dist/site/styles.css"), "utf8");
    expect(builtStyles).toContain("fixture:styles.css");
    expect(builtStyles).toContain(".hraness-site-footer {");

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

  test("keeps the deployment identity version aligned with the package", async () => {
    const root = await createFixtureRoot();
    await buildSite({ check: false, repositoryRoot: root });
    const identity = JSON.parse(
      await readFile(join(root, "dist/site/.well-known/hra.json"), "utf8"),
    ) as { version?: unknown };
    const packageJson = JSON.parse(
      await readFile(join(import.meta.dir, "..", "package.json"), "utf8"),
    ) as { version?: unknown };

    expect(identity.version).toBe(packageJson.version);
  });

  test("lists the DeepSeek Harness reading page in the built sitemap and llms index", async () => {
    const root = await createFixtureRoot();
    await buildSite({ check: false, repositoryRoot: root });
    const sitemap = await readFile(join(root, "dist/site/sitemap.xml"), "utf8");
    const llms = await readFile(join(root, "dist/site/llms.txt"), "utf8");
    const home = await readFile(join(root, "dist/site/index.html"), "utf8");
    const reading = await readFile(
      join(root, "dist/site/reading/deepseek-harness/index.html"),
      "utf8",
    );

    expect(sitemap).toContain("<loc>https://hra.sh/reading/deepseek-harness/</loc>");
    expect(llms).toContain("https://hra.sh/reading/deepseek-harness/");
    expect(home).toContain('href="/reading/deepseek-harness/"');
    expect(reading).toContain("A plugin catalog is not a Codex account loop");
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

  test("ships no remote runtime assets and configures restrictive response headers", async () => {
    const repositoryRoot = join(import.meta.dir, "..");
    const html = renderSiteHtml();
    const css = await readFile(join(repositoryRoot, "site/styles.css"), "utf8");
    const vercel = JSON.parse(
      await readFile(join(repositoryRoot, "vercel.json"), "utf8"),
    ) as { headers?: unknown };

    expect(html).not.toMatch(/<script[^>]+src=/);
    expect(html).not.toMatch(/<link[^>]+rel="(?:icon|stylesheet)"[^>]+href="https?:\/\//);
    expect(css).not.toMatch(/url\(["']?https?:\/\//);
    expect(vercel.headers).toEqual([
      {
        source: "/preview/",
        headers: [
          {
            key: "Content-Security-Policy",
            value: "default-src 'none'; base-uri 'none'; connect-src 'none'; font-src 'none'; form-action 'none'; frame-ancestors https://hraness.com https://www.hraness.com; img-src 'self' data:; manifest-src 'self'; script-src 'none'; style-src 'self'",
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
            value: "default-src 'none'; base-uri 'none'; connect-src 'none'; font-src 'none'; form-action 'none'; frame-ancestors 'none'; img-src 'self' data:; manifest-src 'self'; script-src 'none'; style-src 'self'",
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
