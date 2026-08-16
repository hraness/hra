import type { SearchSite } from "@hra-internal/web-discovery";

export const HRA_BRAND_EMOJI = "🐦‍🔥" as const;
export const HRA_BRAND_ICON_PATH = "/icon.png" as const;
export const HRA_RELEASE = {
  architecture: "Apple Silicon",
  asset: "HRA-0.1.7-8-macos-arm64.dmg",
  build: 8,
  manifestAsset: "HRA-0.1.7-8-release-manifest.json",
  minimumMacOS: "13",
  tag: "v0.1.7",
  version: "0.1.7",
} as const;
export const HRA_RELEASE_URL =
  `https://github.com/hraness/hra/releases/download/${HRA_RELEASE.tag}/${HRA_RELEASE.asset}` as const;
export const HRA_RELEASE_CHECKSUM_URL = `${HRA_RELEASE_URL}.sha256` as const;
export const HRA_RELEASE_MANIFEST_URL =
  `https://github.com/hraness/hra/releases/download/${HRA_RELEASE.tag}/${HRA_RELEASE.manifestAsset}` as const;

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
  socialTitle: "Give Codex a team, a memory, and a budget",
  title: "HRA: a metaharness for Codex",
  titleTemplate: "%s · HRA",
} as const satisfies SearchSite;
