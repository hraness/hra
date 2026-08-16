import { createPublicRobots } from "@hra-internal/web-discovery";

import { hraSearchSite } from "./site";

export default function robots() {
  return createPublicRobots(hraSearchSite.origin, {
    disallow: ["/api", "/app", "/auth", "/design"],
  });
}
