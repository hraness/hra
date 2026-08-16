import { createSitemap } from "@hra-internal/web-discovery";

import { hraSearchSite } from "./site";
import { hraComparisons } from "./alternatives/comparisons";

export default function sitemap() {
  return createSitemap(hraSearchSite.origin, [
    {
      changeFrequency: "weekly",
      path: "/",
      priority: 1,
    },
    {
      changeFrequency: "weekly",
      path: "/download",
      priority: 0.8,
    },
    {
      changeFrequency: "monthly",
      path: "/alternatives",
      priority: 0.8,
    },
    ...hraComparisons.map(({ slug }) => ({
      changeFrequency: "monthly" as const,
      path: `/alternatives/${slug}` as `/${string}`,
      priority: 0.7,
    })),
  ]);
}
