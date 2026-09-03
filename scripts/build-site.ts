import { copyFile, cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { z } from "zod";

import {
  publicContent,
  renderLlmsText,
  renderPrivacyMarkdown,
  renderReadmeMarkdown,
  renderSitemapXml,
} from "../site/content.ts";
import {
  renderSocialCardPng,
  renderSocialCardSvg,
  SOCIAL_CARD_HEIGHT,
  SOCIAL_CARD_WIDTH,
} from "../site/social-card.ts";
import { readPngDimensions } from "../site/social-card-raster.ts";
import {
  renderPreviewHtml,
  renderPrivacyHtml,
  renderSiteHtml,
} from "../site/template.ts";
import { HRA_RELEASE_VERSION } from "./release-evidence";

interface BuildOptions {
  readonly check: boolean;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly releaseCommit?: string;
  readonly repositoryRoot: string;
}

interface TextOutput {
  readonly content: string;
  readonly path: string;
}

const withFinalNewline = (value: string): string =>
  value.endsWith("\n") ? value : `${value}\n`;

const packageManifestSchema = z.object({
  version: z.string().regex(/^0\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/u),
}).passthrough();

/**
 * The hosted identity marker carries the fixed release-evidence identity
 * version that the canonical-alias operator proves after every cutover, not
 * the package version. The package version is read for other generated
 * surfaces.
 */
export const readPackageVersion = async (
  repositoryRoot: string = resolve(import.meta.dir, ".."),
): Promise<string> => {
  const manifest: unknown = JSON.parse(await readFile(join(repositoryRoot, "package.json"), "utf8"));
  return packageManifestSchema.parse(manifest).version;
};

export const HRA_POSTHOG_PROJECT_TOKEN_ENV =
  "NEXT_PUBLIC_POSTHOG_KEY" as const;

const postHogProjectTokenPattern = /^phc_[A-Za-z0-9_-]{8,512}$/u;

export function resolveHraAnalyticsProjectToken(
  environment: Readonly<Record<string, string | undefined>>,
): string {
  if (environment.VERCEL_ENV !== "production") return "";

  const projectToken = environment[HRA_POSTHOG_PROJECT_TOKEN_ENV]?.trim();
  if (projectToken === undefined || projectToken.length === 0) {
    throw new Error(
      `${HRA_POSTHOG_PROJECT_TOKEN_ENV} must be configured for Vercel Production.`,
    );
  }
  if (!postHogProjectTokenPattern.test(projectToken)) {
    throw new Error(
      `${HRA_POSTHOG_PROJECT_TOKEN_ENV} must be a valid public phc_ project token.`,
    );
  }
  return projectToken;
}

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

const siteTextOutputs = (
  repositoryRoot: string,
  releaseCommit: string,
): readonly TextOutput[] => [
  {
    path: join(repositoryRoot, "dist/site/index.html"),
    content: renderSiteHtml(),
  },
  {
    path: join(repositoryRoot, "dist/site/privacy/index.html"),
    content: renderPrivacyHtml(),
  },
  {
    path: join(repositoryRoot, "dist/site/preview/index.html"),
    content: renderPreviewHtml(),
  },
  {
    path: join(repositoryRoot, "dist/site/robots.txt"),
    content: `User-agent: *\nAllow: /\nSitemap: ${publicContent.siteUrl}/sitemap.xml\n`,
  },
  {
    path: join(repositoryRoot, "dist/site/sitemap.xml"),
    content: renderSitemapXml(),
  },
  {
    path: join(repositoryRoot, "dist/site/llms.txt"),
    content: renderLlmsText(),
  },
  {
    path: join(repositoryRoot, "dist/site/social-card.svg"),
    content: renderSocialCardSvg(),
  },
  {
    path: join(repositoryRoot, "dist/site/.well-known/security.txt"),
    content: `Contact: ${publicContent.links.privateSecurityReport}\nCanonical: ${publicContent.siteUrl}/.well-known/security.txt\nPolicy: ${publicContent.links.security}\nExpires: 2027-08-22T23:59:59Z\nPreferred-Languages: en\n`,
  },
  {
    path: join(repositoryRoot, "dist/site/.well-known/hra.json"),
    content: JSON.stringify({
      generation: 1,
      product: "HRA",
      repository: {
        id: 1_343_008_607,
        path: "hraness/hra",
      },
      schemaVersion: 2,
      source: {
        commit: releaseCommit,
      },
      version: HRA_RELEASE_VERSION,
    }, null, 2),
  },
];

const staticAssets = ["favicon.svg"] as const;
const analyticsEntryPath = fileURLToPath(
  new URL("../site/analytics-entry.ts", import.meta.url),
);
const siteFooterStylesPath = fileURLToPath(
  import.meta.resolve("@hraness/site-footer/styles.css"),
);
const designKitFontsStylesPath = fileURLToPath(
  import.meta.resolve("@hraness/design-kit/fonts.css"),
);
const designKitProductMarketingStylesPath = fileURLToPath(
  import.meta.resolve("@hraness/design-kit/product-marketing.css"),
);
const designKitFontsDirectory = join(dirname(designKitFontsStylesPath), "fonts");

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

async function buildAnalyticsBundle(
  repositoryRoot: string,
  projectToken: string,
): Promise<void> {
  const result = await Bun.build({
    define: {
      __HRA_POSTHOG_PROJECT_TOKEN__: JSON.stringify(projectToken),
      "process.env.NODE_ENV": JSON.stringify("production"),
    },
    entrypoints: [analyticsEntryPath],
    format: "esm",
    minify: true,
    naming: "analytics.js",
    outdir: join(repositoryRoot, "dist/site"),
    sourcemap: "none",
    target: "browser",
  });
  if (!result.success) {
    const details = result.logs.map((log) => log.message).join("\n");
    throw new Error(`HRA analytics bundle failed.${details.length > 0 ? `\n${details}` : ""}`);
  }
}

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

  const releaseCommit = options.releaseCommit ?? "local";
  if (releaseCommit !== "local" && !/^[0-9a-f]{40}$/u.test(releaseCommit)) {
    throw new Error("Release commit must be a lowercase 40-character Git SHA.");
  }
  const analyticsProjectToken = resolveHraAnalyticsProjectToken(
    options.environment ?? process.env,
  );
  await rm(join(options.repositoryRoot, "dist", "site"), {
    force: true,
    recursive: true,
  });
  for (const output of siteTextOutputs(options.repositoryRoot, releaseCommit)) {
    const content = withFinalNewline(output.content);
    await mkdir(dirname(output.path), { recursive: true });
    await writeFile(output.path, content, { encoding: "utf8" });
  }
  const socialCardPng = renderSocialCardPng();
  const socialCardDimensions = readPngDimensions(socialCardPng);
  if (
    socialCardDimensions.width !== SOCIAL_CARD_WIDTH
    || socialCardDimensions.height !== SOCIAL_CARD_HEIGHT
    || socialCardDimensions.width !== publicContent.socialCard.width
    || socialCardDimensions.height !== publicContent.socialCard.height
  ) {
    throw new Error("The social card PNG must be 1200x630 and match the published Open Graph size.");
  }
  await writeFile(join(options.repositoryRoot, "dist/site", publicContent.socialCard.path), socialCardPng);
  await buildAnalyticsBundle(options.repositoryRoot, analyticsProjectToken);

  for (const asset of staticAssets) {
    const source = join(options.repositoryRoot, "site", asset);
    const destination = join(options.repositoryRoot, "dist/site", asset);
    await mkdir(dirname(destination), { recursive: true });
    await copyFile(source, destination);
  }
  const [
    productStyles,
    designKitFontsStyles,
    designKitProductMarketingStyles,
    siteFooterStyles,
  ] = await Promise.all([
    readFile(join(options.repositoryRoot, "site/styles.css"), "utf8"),
    readFile(designKitFontsStylesPath, "utf8"),
    readFile(designKitProductMarketingStylesPath, "utf8"),
    readFile(siteFooterStylesPath, "utf8"),
  ]);
  await cp(designKitFontsDirectory, join(options.repositoryRoot, "dist/site/fonts"), {
    dereference: true,
    recursive: true,
  });
  await writeFile(
    join(options.repositoryRoot, "dist/site/styles.css"),
    `${designKitFontsStyles.trim()}\n\n${designKitProductMarketingStyles.trim()}\n\n${productStyles.trimEnd()}\n\n${siteFooterStyles.trim()}\n`,
    "utf8",
  );

  return mismatches;
};

if (import.meta.main) {
  const repositoryRoot = resolve(import.meta.dir, "..");
  const check = Bun.argv.slice(2).includes("--check");
  const providerCommit = process.env.VERCEL_GIT_COMMIT_SHA
    ?? process.env.HRA_RELEASE_COMMIT;
  if (
    process.env.VERCEL === "1"
    && (providerCommit === undefined || !/^[0-9a-f]{40}$/u.test(providerCommit))
  ) {
    throw new Error("A Vercel build requires an exact source commit marker.");
  }
  const mismatches = await buildSite({
    check,
    ...(providerCommit === undefined ? {} : { releaseCommit: providerCommit }),
    repositoryRoot,
  });
  if (mismatches.length > 0) {
    console.error(`Generated public files are stale:\n${mismatches.map((path) => relative(repositoryRoot, path)).join("\n")}`);
    process.exitCode = 1;
  }
}
