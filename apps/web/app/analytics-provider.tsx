"use client";

import type { PostHog } from "posthog-js/dist/module.slim.no-external";
import { type ReactNode, useEffect } from "react";

import {
  classifyHraAnalyticsRoute,
  createHraPostHogConfiguration,
  isHraAnalyticsBrowserEligible,
  type HraAnalyticsBrowserEvidence,
} from "./analytics";

const projectToken = process.env.NEXT_PUBLIC_POSTHOG_KEY;

let initializedClient: PostHog | null = null;
let initialization: Promise<PostHog | null> | null = null;
let latestCaptureRequest = 0;
let lastCapturedPath: string | null = null;

function currentBrowserEvidence(): HraAnalyticsBrowserEvidence {
  return {
    origin: globalThis.location.origin,
    pathname: globalThis.location.pathname,
    production: process.env.NODE_ENV === "production",
  };
}

function initializePostHog(): Promise<PostHog | null> {
  if (initializedClient !== null) return Promise.resolve(initializedClient);
  if (initialization !== null) return initialization;
  const token = projectToken;
  if (
    typeof token !== "string"
    || !isHraAnalyticsBrowserEligible(currentBrowserEvidence(), token)
  ) {
    return Promise.resolve(null);
  }

  initialization = import("posthog-js/dist/module.slim.no-external")
    .then(({ default: posthog }) => {
      if (!isHraAnalyticsBrowserEligible(currentBrowserEvidence(), token)) {
        initialization = null;
        return null;
      }
      posthog.init(
        token,
        createHraPostHogConfiguration(currentBrowserEvidence),
      );
      initializedClient = posthog;
      return posthog;
    })
    .catch(() => {
      initialization = null;
      return null;
    });
  return initialization;
}

export function HraAnalyticsProvider({
  children,
  pathname,
}: Readonly<{
  children: ReactNode;
  pathname: string;
}>) {
  useEffect(() => {
    const request = ++latestCaptureRequest;
    const expectedRoute = classifyHraAnalyticsRoute(pathname);
    if (
      expectedRoute === null
      || !isHraAnalyticsBrowserEligible(currentBrowserEvidence(), projectToken)
    ) {
      lastCapturedPath = null;
      return;
    }

    let cancelled = false;
    void initializePostHog().then((posthog) => {
      if (cancelled || posthog === null || request !== latestCaptureRequest) return;
      const evidence = currentBrowserEvidence();
      const currentRoute = classifyHraAnalyticsRoute(evidence.pathname);
      if (
        !isHraAnalyticsBrowserEligible(evidence, projectToken)
        || currentRoute?.canonical_path !== expectedRoute.canonical_path
        || lastCapturedPath === currentRoute.canonical_path
      ) {
        return;
      }
      lastCapturedPath = currentRoute.canonical_path;
      posthog.capture("$pageview", { $process_person_profile: false });
    });

    return () => {
      cancelled = true;
    };
  }, [pathname]);

  return children;
}
