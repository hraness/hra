import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";

import {
  publicContent,
  renderLlmsText,
  renderPrivacyMarkdown,
  renderReadmeMarkdown,
} from "../site/content.ts";
import { renderPrivacyHtml, renderSiteHtml } from "../site/template.ts";

interface BuildOptions {
  readonly check: boolean;
  readonly repositoryRoot: string;
}

interface TextOutput {
  readonly content: string;
  readonly path: string;
}

const withFinalNewline = (value: string): string =>
  value.endsWith("\n") ? value : `${value}\n`;

const trackedTextOutputs = (repositoryRoot: string): readonly TextOutput[] => [
  {
    path: join(repositoryRoot, "README.md"),
    content: renderReadmeMarkdown(),
  },
  {
    path: join(repositoryRoot, "PRIVACY.md"),
    content: renderPrivacyMarkdown(),
  },
];

const siteTextOutputs = (repositoryRoot: string): readonly TextOutput[] => [
  {
    path: join(repositoryRoot, "dist/site/index.html"),
    content: renderSiteHtml(),
  },
  {
    path: join(repositoryRoot, "dist/site/privacy/index.html"),
    content: renderPrivacyHtml(),
  },
  {
    path: join(repositoryRoot, "dist/site/robots.txt"),
    content: `User-agent: *\nAllow: /\nSitemap: ${publicContent.siteUrl}/sitemap.xml\n`,
  },
  {
    path: join(repositoryRoot, "dist/site/sitemap.xml"),
    content: `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n  <url><loc>${publicContent.siteUrl}/</loc></url>\n  <url><loc>${publicContent.siteUrl}/privacy/</loc></url>\n</urlset>\n`,
  },
  {
    path: join(repositoryRoot, "dist/site/llms.txt"),
    content: renderLlmsText(),
  },
  {
    path: join(repositoryRoot, "dist/site/.well-known/security.txt"),
    content: `Contact: ${publicContent.links.privateSecurityReport}\nCanonical: ${publicContent.siteUrl}/.well-known/security.txt\nPolicy: ${publicContent.links.security}\nExpires: 2027-08-22T23:59:59Z\nPreferred-Languages: en\n`,
  },
];

const staticAssets = ["favicon.svg", "social-card.svg", "styles.css"] as const;

const readExisting = async (path: string): Promise<string | undefined> => {
  try {
    return await readFile(path, "utf8");
  } catch (error: unknown) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
};

export const buildSite = async (options: BuildOptions): Promise<readonly string[]> => {
  const mismatches: string[] = [];

  for (const output of trackedTextOutputs(options.repositoryRoot)) {
    const content = withFinalNewline(output.content);
    if (options.check) {
      if ((await readExisting(output.path)) !== content) {
        mismatches.push(output.path);
      }
      continue;
    }

    await mkdir(dirname(output.path), { recursive: true });
    await writeFile(output.path, content, { encoding: "utf8" });
  }

  if (options.check) return mismatches;

  for (const output of siteTextOutputs(options.repositoryRoot)) {
    const content = withFinalNewline(output.content);
    await mkdir(dirname(output.path), { recursive: true });
    await writeFile(output.path, content, { encoding: "utf8" });
  }

  for (const asset of staticAssets) {
    const source = join(options.repositoryRoot, "site", asset);
    const destination = join(options.repositoryRoot, "dist/site", asset);
    await mkdir(dirname(destination), { recursive: true });
    await copyFile(source, destination);
  }

  return mismatches;
};

if (import.meta.main) {
  const repositoryRoot = resolve(import.meta.dir, "..");
  const check = Bun.argv.slice(2).includes("--check");
  const mismatches = await buildSite({ check, repositoryRoot });
  if (mismatches.length > 0) {
    console.error(`Generated public files are stale:\n${mismatches.map((path) => relative(repositoryRoot, path)).join("\n")}`);
    process.exitCode = 1;
  }
}
