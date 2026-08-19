import { expect, test } from "bun:test";
import { assertProperty, fc } from "@hra-internal/test";

import { hraComparisonSlugs } from "./alternatives/slugs";
import {
  classifyHraAnalyticsRoute,
  createHraPageviewFilter,
  HRA_ANALYTICS_CANONICAL_ORIGIN,
  HRA_POSTHOG_COOKIELESS_DISTINCT_ID,
} from "./analytics";

const canonicalPublicPaths = new Set([
  "/",
  "/download",
  "/alternatives",
  ...hraComparisonSlugs.map((slug) => `/alternatives/${slug}`),
]);

test("analytics classification never admits a route outside the public allowlist", () => {
  assertProperty(fc.property(fc.string(), pathname => {
    const route = classifyHraAnalyticsRoute(pathname);
    const hasRepeatedSlash = pathname.includes("//");
    const canonicalPath = pathname.length > 1 && pathname.endsWith("/")
      ? pathname.slice(0, -1)
      : pathname;
    expect(route !== null).toBe(
      !hasRepeatedSlash && canonicalPublicPaths.has(canonicalPath),
    );
    if (route !== null) {
      expect(route.canonical_path).toBe(canonicalPath);
      expect(route.analytics_schema_version).toBe(1);
      expect(route.canonical_domain).toBe("hra.sh");
      expect(route.site_id).toBe("hra");
    }
  }));
});

test("a repeated slash can never become a canonical public route", () => {
  assertProperty(fc.property(fc.string(), fc.string(), (prefix, suffix) => {
    expect(classifyHraAnalyticsRoute(`/${prefix}//${suffix}`)).toBeNull();
  }));
});

test("arbitrary provider properties cannot escape the pageview allowlist", () => {
  const allowedKeys = new Set([
    "$cookieless_mode",
    "$current_url",
    "$host",
    "$pathname",
    "$process_person_profile",
    "analytics_schema_version",
    "canonical_domain",
    "canonical_path",
    "content_slug",
    "distinct_id",
    "page_kind",
    "site_id",
    "token",
  ]);
  const filter = createHraPageviewFilter(() => ({
    origin: HRA_ANALYTICS_CANONICAL_ORIGIN,
    pathname: "/download",
    production: true,
  }));

  assertProperty(fc.property(
    fc.dictionary(fc.string(), fc.jsonValue()),
    foreignProperties => {
      const capture = {
        event: "$pageview",
        properties: {
          ...foreignProperties,
          token: "phc_publicproject",
          distinct_id: HRA_POSTHOG_COOKIELESS_DISTINCT_ID,
          $cookieless_mode: true,
        },
        uuid: "00000000-0000-4000-8000-000000000000",
      } as unknown as NonNullable<Parameters<typeof filter>[0]>;
      const filtered = filter(capture);
      expect(filtered).not.toBeNull();
      for (const key of Object.keys(filtered?.properties ?? {})) {
        expect(allowedKeys.has(key), key).toBeTrue();
      }
      expect(filtered?.properties.$current_url).toBe("https://hra.sh/download");
      expect(filtered?.properties.$pathname).toBe("/download");
      expect(filtered?.properties.$process_person_profile).toBeFalse();
      expect(filtered?.properties.distinct_id)
        .toBe(HRA_POSTHOG_COOKIELESS_DISTINCT_ID);
      expect(filtered?.properties.$cookieless_mode).toBeTrue();
    },
  ));
});

test("arbitrary transport identity is rejected without the exact cookieless pair", () => {
  const filter = createHraPageviewFilter(() => ({
    origin: HRA_ANALYTICS_CANONICAL_ORIGIN,
    pathname: "/",
    production: true,
  }));

  assertProperty(fc.property(
    fc.oneof(fc.string(), fc.constant(HRA_POSTHOG_COOKIELESS_DISTINCT_ID)),
    fc.oneof(fc.jsonValue(), fc.constant(true)),
    (distinctId, cookielessMarker) => {
      const filtered = filter({
        event: "$pageview",
        properties: {
          token: "phc_publicproject",
          distinct_id: distinctId,
          $cookieless_mode: cookielessMarker,
        },
        uuid: "00000000-0000-4000-8000-000000000000",
      });
      expect(filtered !== null).toBe(
        distinctId === HRA_POSTHOG_COOKIELESS_DISTINCT_ID
        && cookielessMarker === true,
      );
    },
  ));
});
