import { z } from "@hra-internal/schema";
import {
  LARGE_SOCIAL_IMAGE,
  absoluteWebUrl,
  type SearchSite,
} from "@hraness/web-discovery";
import type { Metadata } from "next";

import releaseDownload from "../../../release-download.json";

const emptyArtifactSchema = z.object({
  bytes: z.null(),
  name: z.string().min(1),
  sha256: z.null(),
}).strict();
const publishedArtifactSchema = z.object({
  bytes: z.number().int().positive().safe(),
  name: z.string().min(1),
  sha256: z.string().regex(/^[0-9a-f]{64}$/u),
}).strict();
const commonReleaseShape = {
  architecture: z.literal("Apple Silicon"),
  build: z.number().int().positive().safe(),
  minimumMacOS: z.string().regex(/^[1-9][0-9]*(?:\.[0-9]+)?$/u),
  tag: z.string().regex(/^v[0-9]+\.[0-9]+\.[0-9]+$/u),
  version: z.string().regex(/^[0-9]+\.[0-9]+\.[0-9]+$/u),
} as const;
const releaseDownloadSchema = z.object({
  release: z.discriminatedUnion("availability", [
    z.object({
      ...commonReleaseShape,
      artifacts: z.object({
        checksum: emptyArtifactSchema,
        dmg: emptyArtifactSchema,
        manifest: emptyArtifactSchema,
      }).strict(),
      availability: z.literal("candidate"),
      source: z.object({
        commit: z.null(),
        runtimeTreeSha256: z.null(),
        tagObject: z.null(),
      }).strict(),
    }).strict(),
    z.object({
      ...commonReleaseShape,
      artifacts: z.object({
        checksum: publishedArtifactSchema,
        dmg: publishedArtifactSchema,
        manifest: publishedArtifactSchema,
      }).strict(),
      availability: z.literal("published"),
      source: z.object({
        commit: z.string().regex(/^[0-9a-f]{40}$/u),
        runtimeTreeSha256: z.string().regex(/^[0-9a-f]{64}$/u),
        tagObject: z.string().regex(/^[0-9a-f]{40}$/u),
      }).strict(),
    }).strict(),
  ]),
  repository: z.literal("https://github.com/hraness/hra"),
  schemaVersion: z.literal(1),
}).strict().superRefine((contract, context) => {
  const { release } = contract;
  const dmg = `HRA-${release.version}-${release.build}-macos-arm64.dmg`;
  if (
    release.tag !== `v${release.version}`
    || release.artifacts.dmg.name !== dmg
    || release.artifacts.checksum.name !== `${dmg}.sha256`
    || release.artifacts.manifest.name
      !== `HRA-${release.version}-${release.build}-release-manifest.json`
  ) {
    context.addIssue({
      code: "custom",
      message: "Release tag and artifact names must derive from version and build.",
    });
  }
});

export const HRA_BRAND_EMOJI = "🐦‍🔥" as const;
export const HRA_BRAND_ICON_PATH = "/icon.png" as const;
const releaseContract = releaseDownloadSchema.parse(releaseDownload as unknown);
export const HRA_RELEASE = Object.freeze({
  architecture: releaseContract.release.architecture,
  asset: releaseContract.release.artifacts.dmg.name,
  availability: releaseContract.release.availability,
  build: releaseContract.release.build,
  checksumAsset: releaseContract.release.artifacts.checksum.name,
  manifestAsset: releaseContract.release.artifacts.manifest.name,
  minimumMacOS: releaseContract.release.minimumMacOS,
  repository: releaseContract.repository,
  source: releaseContract.release.source,
  tag: releaseContract.release.tag,
  version: releaseContract.release.version,
});
export const HRA_RELEASE_URL = HRA_RELEASE.availability === "published"
  ? `${HRA_RELEASE.repository}/releases/download/${HRA_RELEASE.tag}/${HRA_RELEASE.asset}`
  : null;
export const HRA_RELEASE_CHECKSUM_URL = HRA_RELEASE_URL === null
  ? null
  : `${HRA_RELEASE.repository}/releases/download/${HRA_RELEASE.tag}/${HRA_RELEASE.checksumAsset}`;
export const HRA_RELEASE_MANIFEST_URL = HRA_RELEASE_URL === null
  ? null
  : `${HRA_RELEASE.repository}/releases/download/${HRA_RELEASE.tag}/${HRA_RELEASE.manifestAsset}`;

export const hraSearchSite = {
  description:
    "A metaharness for Codex: coordinate authorized accounts, delegate durable work, preserve continuity, and recover parallel sessions on your Mac.",
  applicationName: "HRA",
  category: "DeveloperApplication",
  creator: "Hraness",
  name: "HRA",
  origin: "https://hra.sh",
  publisher: "Hraness",
  socialImage: {
    alt: "HRA: a durable metaharness for Codex",
    path: "/opengraph-image",
  },
  title: "HRA: a metaharness for Codex",
  titleTemplate: "%s · HRA",
} as const satisfies SearchSite;

const rootSocialImage = {
  alt: hraSearchSite.socialImage.alt,
  height: LARGE_SOCIAL_IMAGE.height,
  url: absoluteWebUrl(hraSearchSite.origin, hraSearchSite.socialImage.path),
  width: LARGE_SOCIAL_IMAGE.width,
} as const;

export const hraHomepageKeywords = [
  "Codex metaharness",
  "multiple Codex accounts",
  "Codex orchestration",
  "coding agents",
  "parallel agents",
  "human in the loop",
  "AI task orchestration",
  "local-first developer tools",
] as const;

export const hraRootMetadata = {
  applicationName: hraSearchSite.applicationName,
  category: hraSearchSite.category,
  creator: hraSearchSite.creator,
  metadataBase: new URL(hraSearchSite.origin),
  openGraph: {
    images: [rootSocialImage],
    locale: "en_US",
    siteName: hraSearchSite.name,
    type: "website",
  },
  publisher: hraSearchSite.publisher,
  title: {
    default: hraSearchSite.applicationName,
    template: hraSearchSite.titleTemplate,
  },
  twitter: {
    card: "summary_large_image",
    images: [{ alt: rootSocialImage.alt, url: rootSocialImage.url }],
  },
} as const satisfies Metadata;

export function hraSocialPageTitle(pageTitle: string): string {
  return hraSearchSite.titleTemplate.replaceAll("%s", pageTitle);
}
