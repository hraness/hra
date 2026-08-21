import type { AuthConfig } from "convex/server";

const convexSiteUrl = process.env.CONVEX_SITE_URL;
if (convexSiteUrl === undefined || convexSiteUrl.trim() === "") {
  throw new Error("CONVEX_SITE_URL is required for Convex Auth token verification.");
}

export default {
  providers: [
    {
      domain: convexSiteUrl,
      applicationID: "convex",
    },
  ],
} satisfies AuthConfig;
