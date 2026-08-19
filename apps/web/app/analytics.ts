import type {
  BeforeSendFn,
  PostHogConfig,
  Properties,
} from "posthog-js/dist/module.slim.no-external";

import { isHraPublicComparisonPath } from "./alternatives/slugs";

export const HRA_ANALYTICS_SCHEMA_VERSION = 1 as const;
export const HRA_ANALYTICS_SITE_ID = "hra" as const;
export const HRA_ANALYTICS_CANONICAL_DOMAIN = "hra.sh" as const;
export const HRA_ANALYTICS_CANONICAL_ORIGIN =
  `https://${HRA_ANALYTICS_CANONICAL_DOMAIN}` as const;
export const HRA_POSTHOG_INGESTION_HOST = "https://us.i.posthog.com" as const;
export const HRA_POSTHOG_COOKIELESS_DISTINCT_ID =
  "$posthog_cookieless" as const;

const publicProjectTokenPattern = /^phc_[a-zA-Z0-9_-]{10,512}$/u;

export type HraAnalyticsRoute = Readonly<{
  analytics_schema_version: typeof HRA_ANALYTICS_SCHEMA_VERSION;
  canonical_domain: typeof HRA_ANALYTICS_CANONICAL_DOMAIN;
  canonical_path: string;
  content_slug?: string;
  page_kind: "alternative" | "alternatives_index" | "download" | "landing";
  site_id: typeof HRA_ANALYTICS_SITE_ID;
}>;

export type HraAnalyticsBrowserEvidence = Readonly<{
  origin: string;
  pathname: string;
  production: boolean;
}>;

function canonicalPublicPath(pathname: string): string | null {
  if (pathname.includes("//")) return null;
  return pathname.length > 1 && pathname.endsWith("/")
    ? pathname.slice(0, -1)
    : pathname;
}

/** Classify only the public routes that are allowed to emit a pageview. */
export function classifyHraAnalyticsRoute(
  pathname: string,
): HraAnalyticsRoute | null {
  const canonicalPath = canonicalPublicPath(pathname);
  if (canonicalPath === null) return null;
  let pageKind: HraAnalyticsRoute["page_kind"];
  let contentSlug: string | undefined;

  if (canonicalPath === "/") {
    pageKind = "landing";
  } else if (canonicalPath === "/download") {
    pageKind = "download";
  } else if (isHraPublicComparisonPath(pathname)) {
    if (canonicalPath === "/alternatives") {
      pageKind = "alternatives_index";
    } else {
      pageKind = "alternative";
      contentSlug = canonicalPath.slice("/alternatives/".length);
    }
  } else {
    return null;
  }

  return {
    analytics_schema_version: HRA_ANALYTICS_SCHEMA_VERSION,
    canonical_domain: HRA_ANALYTICS_CANONICAL_DOMAIN,
    canonical_path: canonicalPath,
    ...(contentSlug === undefined ? {} : { content_slug: contentSlug }),
    page_kind: pageKind,
    site_id: HRA_ANALYTICS_SITE_ID,
  };
}

export function isHraPublicProjectToken(value: unknown): value is string {
  return typeof value === "string" && publicProjectTokenPattern.test(value);
}

export function isHraAnalyticsBrowserEligible(
  evidence: HraAnalyticsBrowserEvidence,
  projectToken: unknown,
): boolean {
  return evidence.production
    && evidence.origin === HRA_ANALYTICS_CANONICAL_ORIGIN
    && classifyHraAnalyticsRoute(evidence.pathname) !== null
    && isHraPublicProjectToken(projectToken);
}

/** Drop non-pageview events and reduce an allowed pageview to its public route. */
export function createHraPageviewFilter(
  resolveEvidence: () => HraAnalyticsBrowserEvidence,
): BeforeSendFn {
  return (capture) => {
    if (capture === null || capture.event !== "$pageview") return null;
    const evidence = resolveEvidence();
    const route = classifyHraAnalyticsRoute(evidence.pathname);
    const token = capture.properties.token;
    const cookielessDistinctId = capture.properties.distinct_id;
    const cookielessMarker = capture.properties.$cookieless_mode;
    if (
      !evidence.production
      || evidence.origin !== HRA_ANALYTICS_CANONICAL_ORIGIN
      || route === null
      || !isHraPublicProjectToken(token)
      || cookielessDistinctId !== HRA_POSTHOG_COOKIELESS_DISTINCT_ID
      || cookielessMarker !== true
    ) {
      return null;
    }

    const properties: Properties = {
      token,
      distinct_id: HRA_POSTHOG_COOKIELESS_DISTINCT_ID,
      $cookieless_mode: true,
      $current_url: `${HRA_ANALYTICS_CANONICAL_ORIGIN}${route.canonical_path}`,
      $host: HRA_ANALYTICS_CANONICAL_DOMAIN,
      $pathname: route.canonical_path,
      $process_person_profile: false,
      ...route,
    };

    return {
      event: "$pageview",
      properties,
      ...(capture.timestamp === undefined ? {} : { timestamp: capture.timestamp }),
      uuid: capture.uuid,
    };
  };
}

/** Build the fixed cookieless, personless browser configuration. */
export function createHraPostHogConfiguration(
  resolveEvidence: () => HraAnalyticsBrowserEvidence,
): Partial<PostHogConfig> {
  return {
    api_host: HRA_POSTHOG_INGESTION_HOST,
    ui_host: "https://us.posthog.com",
    defaults: "2026-05-30",
    autocapture: false,
    rageclick: false,
    capture_pageview: false,
    capture_pageleave: false,
    capture_performance: false,
    capture_exceptions: false,
    capture_heatmaps: false,
    capture_dead_clicks: false,
    disable_session_recording: true,
    disable_surveys: true,
    disable_surveys_automatic_display: true,
    disable_product_tours: true,
    disable_conversations: true,
    advanced_disable_flags: true,
    advanced_disable_feature_flags: true,
    advanced_disable_feature_flags_on_first_load: true,
    advanced_disable_toolbar_metrics: true,
    person_profiles: "never",
    persistence: "memory",
    cookieless_mode: "always",
    respect_dnt: true,
    cross_subdomain_cookie: false,
    disableDeviceModel: true,
    disable_capture_url_hashes: true,
    disable_external_dependency_loading: true,
    mask_all_text: true,
    mask_all_element_attributes: true,
    mask_personal_data_properties: true,
    custom_personal_data_properties: ["email", "token", "code", "key", "secret"],
    properties_string_max_length: 512,
    internal_or_test_user_hostname: null,
    rate_limiting: {
      events_per_second: 2,
      events_burst_limit: 12,
    },
    save_campaign_params: false,
    save_referrer: false,
    before_send: createHraPageviewFilter(resolveEvidence),
  };
}
