import type { SearchSite } from "@hra-internal/web-discovery";

export const HRA_BRAND_EMOJI = "🐦‍🔥" as const;
export const HRA_BRAND_ICON_PATH = "/icon.png" as const;

export const hraSearchSite = {
  description:
    "The tokenmaxxing metaharness for Codex: coordinate multiple subscriptions and durable parallel sessions while keeping provider authority on your Mac.",
  applicationName: "HRA",
  category: "DeveloperApplication",
  creator: "Hraness",
  name: "HRA",
  origin: "https://hra.sh",
  publisher: "Hraness",
  socialImage: {
    alt: "HRA — durable control for parallel Codex work",
    path: "/opengraph-image",
  },
  socialTitle: "Run parallel Codex work without losing the thread",
  title: "HRA — durable control for parallel Codex work",
  titleTemplate: "%s · HRA",
} as const satisfies SearchSite;
