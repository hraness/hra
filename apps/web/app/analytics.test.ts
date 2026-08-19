import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import {
  classifyHraAnalyticsRoute,
  createHraPageviewFilter,
  createHraPostHogConfiguration,
  HRA_ANALYTICS_CANONICAL_ORIGIN,
  isHraAnalyticsBrowserEligible,
  type HraAnalyticsBrowserEvidence,
} from "./analytics";

const productionLanding = {
  origin: HRA_ANALYTICS_CANONICAL_ORIGIN,
  pathname: "/",
  production: true,
} as const satisfies HraAnalyticsBrowserEvidence;

describe("HRA analytics route boundary", () => {
  test("classifies only canonical public routes", () => {
    expect(classifyHraAnalyticsRoute("/")).toEqual({
      analytics_schema_version: 1,
      canonical_domain: "hra.sh",
      canonical_path: "/",
      page_kind: "landing",
      site_id: "hra",
    });
    expect(classifyHraAnalyticsRoute("/download/")?.canonical_path).toBe("/download");
    expect(classifyHraAnalyticsRoute("/alternatives/codex-app/")).toMatchObject({
      canonical_path: "/alternatives/codex-app",
      content_slug: "codex-app",
      page_kind: "alternative",
    });

    for (const pathname of [
      "/app",
      "/auth/callback",
      "/api/suite-auth/session",
      "/design",
      "/download/private",
      "//",
      "///",
      "/download//",
      "/alternatives//",
      "/alternatives//codex-app",
      "/alternatives/codex-app//",
      "/alternatives/missing",
      "/alternatives/codex-app/private",
      "/?email=person@example.com",
    ]) {
      expect(classifyHraAnalyticsRoute(pathname), pathname).toBeNull();
    }
  });

  test("requires Production, the exact canonical origin, and a public project token", () => {
    expect(isHraAnalyticsBrowserEligible(
      productionLanding,
      "phc_publicproject",
    )).toBeTrue();
    expect(isHraAnalyticsBrowserEligible(
      { ...productionLanding, origin: "https://www.hra.sh" },
      "phc_publicproject",
    )).toBeFalse();
    expect(isHraAnalyticsBrowserEligible(
      { ...productionLanding, production: false },
      "phc_publicproject",
    )).toBeFalse();
    expect(isHraAnalyticsBrowserEligible(productionLanding, undefined)).toBeFalse();
    expect(isHraAnalyticsBrowserEligible(productionLanding, "phx_secret")).toBeFalse();
    expect(isHraAnalyticsBrowserEligible(productionLanding, "phc_short")).toBeFalse();
  });
});

describe("HRA PostHog pageviews", () => {
  test("loads only the slim SDK entry without external dependencies", () => {
    const provider = readFileSync(
      new URL("./analytics-provider.tsx", import.meta.url),
      "utf8",
    );
    expect(provider).toContain(
      'import("posthog-js/dist/module.slim.no-external")',
    );
    expect(provider).not.toContain('import("posthog-js")');
  });

  test("redacts browser, referrer, query, identity, and custom-event context", () => {
    const filter = createHraPageviewFilter(() => ({
      ...productionLanding,
      pathname: "/alternatives/codex-app",
    }));
    const filtered = filter({
      event: "$pageview",
      properties: {
        token: "phc_publicproject",
        distinct_id: "$posthog_cookieless",
        $cookieless_mode: true,
        $device_id: "device-id",
        $lib: "web",
        $lib_version: "test",
        $session_id: "session-id",
        $current_url: "https://hra.sh/alternatives/codex-app?token=sensitive#private",
        $pathname: "/app",
        $referrer: "https://mail.example/private",
        $title: "Private task title",
        email: "person@example.com",
        task: "secret task",
        utm_campaign: "private campaign",
      },
      $set: { email: "person@example.com" },
      uuid: "00000000-0000-4000-8000-000000000000",
    });

    expect(filtered).toEqual({
      event: "$pageview",
      properties: {
        token: "phc_publicproject",
        distinct_id: "$posthog_cookieless",
        $cookieless_mode: true,
        $current_url: "https://hra.sh/alternatives/codex-app",
        $host: "hra.sh",
        $pathname: "/alternatives/codex-app",
        $process_person_profile: false,
        analytics_schema_version: 1,
        canonical_domain: "hra.sh",
        canonical_path: "/alternatives/codex-app",
        content_slug: "codex-app",
        page_kind: "alternative",
        site_id: "hra",
      },
      uuid: "00000000-0000-4000-8000-000000000000",
    });
  });

  test("drops pageviews outside every runtime boundary and every non-pageview event", () => {
    const event = {
      event: "$pageview",
      properties: {
        token: "phc_publicproject",
        distinct_id: "$posthog_cookieless",
        $cookieless_mode: true,
      },
      uuid: "00000000-0000-4000-8000-000000000000",
    };
    for (const evidence of [
      { ...productionLanding, pathname: "/app" },
      { ...productionLanding, origin: "https://www.hra.sh" },
      { ...productionLanding, production: false },
    ]) {
      expect(createHraPageviewFilter(() => evidence)(event)).toBeNull();
    }
    expect(createHraPageviewFilter(() => productionLanding)({
      ...event,
      properties: { ...event.properties, token: "phx_secret" },
    })).toBeNull();
    for (const properties of [
      { token: "phc_publicproject", $cookieless_mode: true },
      {
        token: "phc_publicproject",
        distinct_id: "foreign-device-id",
        $cookieless_mode: true,
      },
      {
        token: "phc_publicproject",
        distinct_id: "$posthog_cookieless",
        $cookieless_mode: "always",
      },
    ]) {
      expect(createHraPageviewFilter(() => productionLanding)({
        ...event,
        properties,
      })).toBeNull();
    }
    expect(createHraPageviewFilter(() => productionLanding)({
      ...event,
      event: "task opened",
    })).toBeNull();
  });

  test("disables automatic collection, persistence, profiles, flags, and replay", () => {
    expect(createHraPostHogConfiguration(() => productionLanding)).toMatchObject({
      api_host: "https://us.i.posthog.com",
      autocapture: false,
      capture_dead_clicks: false,
      capture_exceptions: false,
      capture_heatmaps: false,
      capture_pageleave: false,
      capture_pageview: false,
      capture_performance: false,
      cookieless_mode: "always",
      disable_session_recording: true,
      disable_surveys: true,
      disable_external_dependency_loading: true,
      advanced_disable_feature_flags: true,
      advanced_disable_flags: true,
      advanced_disable_toolbar_metrics: true,
      person_profiles: "never",
      persistence: "memory",
      rageclick: false,
      rate_limiting: {
        events_burst_limit: 12,
        events_per_second: 2,
      },
      respect_dnt: true,
      save_campaign_params: false,
      save_referrer: false,
    });
  });
});
