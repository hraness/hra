import type { AuthConfig } from "convex/server";

const siteUrl = process.env.CONVEX_SITE_URL;
if (siteUrl === undefined) throw new Error("CONVEX_SITE_URL is required.");

export default {
  providers: [
    {
      applicationID: "convex",
      domain: siteUrl,
    },
  ],
} satisfies AuthConfig;
