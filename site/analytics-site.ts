import {
  POSTHOG_SCHEMA_VERSION,
  type PostHogSiteDefinition,
} from "@hraness/posthog";

export const hraPostHogSite = {
  id: "hra",
  canonicalDomain: "hra.sh",
  allowedHosts: ["hra.sh"],
  schemaVersion: POSTHOG_SCHEMA_VERSION,
  routes: [
    {
      match: "exact",
      path: "/",
      pageKind: "product_home",
      contentGroup: "product",
    },
    {
      match: "exact",
      path: "/privacy",
      pageKind: "privacy",
      contentGroup: "legal",
    },
  ],
  customEvents: [],
  delegatedEvents: [],
  stripQueryAttribution: true,
  unknownCanonicalPath: "/not-found",
} as const satisfies PostHogSiteDefinition;
