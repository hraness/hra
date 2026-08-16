import { createSitemap } from "@hra-internal/web-discovery";

import { hraSearchSite } from "./site";

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
  ]);
}
