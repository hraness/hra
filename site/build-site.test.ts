import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildSite } from "../scripts/build-site.ts";
import { renderSiteHtml } from "./template.ts";

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
      "dist/site/privacy/index.html",
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
    const vercel = await readFile(join(repositoryRoot, "vercel.json"), "utf8");

    expect(html).not.toMatch(/<script[^>]+src=/);
    expect(html).not.toMatch(/<link[^>]+rel="(?:icon|stylesheet)"[^>]+href="https?:\/\//);
    expect(css).not.toMatch(/url\(["']?https?:\/\//);
    expect(vercel).toContain("default-src 'none'");
    expect(vercel).toContain("script-src 'none'");
    expect(vercel).toContain('"X-Content-Type-Options"');
    expect(vercel).toContain('"Permissions-Policy"');
  });
});
