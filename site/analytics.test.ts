import { describe, expect, test } from "bun:test";

import { classifyAnalyticsRoute } from "@hraness/posthog";
import {
  createPostHogBrowserConfig,
  isPostHogBrowserEligible,
} from "@hraness/posthog/client";

import { hraPostHogSite } from "./analytics-site.ts";

const publicProjectToken = "phc_public_test_token";

describe("hra.sh analytics boundary", () => {
  test("classifies only canonical HRA routes without queries or fragments", () => {
    expect(classifyAnalyticsRoute(hraPostHogSite, "https://hra.sh/"))
      .toMatchObject({
        analytics_schema_version: 1,
        canonical_domain: "hra.sh",
        canonical_path: "/",
        content_group: "product",
        page_kind: "product_home",
        site_id: "hra",
      });
    expect(classifyAnalyticsRoute(
      hraPostHogSite,
      "https://hra.sh/privacy/?token=private#account",
    )).toMatchObject({
      canonical_path: "/privacy",
      content_group: "legal",
      page_kind: "privacy",
    });
    expect(classifyAnalyticsRoute(hraPostHogSite, "https://hra.sh/private/path"))
      .toMatchObject({
        canonical_path: "/not-found",
        page_kind: "other",
      });
    expect(classifyAnalyticsRoute(hraPostHogSite, "https://www.hra.sh/"))
      .toBeNull();
    expect(classifyAnalyticsRoute(hraPostHogSite, "https://attacker.example/"))
      .toBeNull();
  });

  test("is eligible only for an exact production hra.sh page and public token", () => {
    const evidence = {
      hostname: "hra.sh",
      href: "https://hra.sh/",
      production: true,
      referrer: "",
    } as const;

    expect(isPostHogBrowserEligible({
      apiKey: publicProjectToken,
      evidence,
      site: hraPostHogSite,
    })).toBe(true);
    expect(isPostHogBrowserEligible({
      apiKey: publicProjectToken,
      evidence: { ...evidence, hostname: "hra-preview.vercel.app" },
      site: hraPostHogSite,
    })).toBe(false);
    expect(isPostHogBrowserEligible({
      apiKey: publicProjectToken,
      evidence: { ...evidence, production: false },
      site: hraPostHogSite,
    })).toBe(false);
    expect(isPostHogBrowserEligible({
      apiKey: "not-a-project-token",
      evidence,
      site: hraPostHogSite,
    })).toBe(false);
  });

  test("uses anonymous cookieless memory state with invasive capture disabled", () => {
    const config = createPostHogBrowserConfig(hraPostHogSite, {
      href: "https://hra.sh/",
      referrer: "https://www.google.com/search?q=private",
    });

    expect(config).toMatchObject({
      advanced_disable_feature_flags: true,
      autocapture: false,
      capture_dead_clicks: false,
      capture_heatmaps: false,
      capture_pageleave: true,
      capture_pageview: "history_change",
      capture_performance: {
        network_timing: false,
        web_vitals: true,
        web_vitals_allowed_metrics: ["LCP", "CLS", "FCP", "INP"],
        web_vitals_attribution: false,
      },
      cookieless_mode: "always",
      disable_conversations: true,
      disable_session_recording: true,
      disable_surveys: true,
      disable_surveys_automatic_display: true,
      mask_all_element_attributes: true,
      mask_all_text: true,
      person_profiles: "never",
      persistence: "memory",
      respect_dnt: true,
    });
  });
});
