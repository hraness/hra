import { expect, test } from "bun:test";
import { assertProperty, fc } from "@hra-internal/test";

import {
  convexOnlyEnvironmentVariables,
  parseVercelPreviewSurfaceOrigin,
  planVercelConvexBuild,
  previewForbiddenEnvironmentVariables,
} from "./vercel-build";

const productionEnvironment = {
  CONVEX_PRODUCTION_DEPLOYMENT_NAME: "benevolent-akita-439",
  CONVEX_PROVIDER_AUTHORITY:
    "prod:benevolent-akita-439|provider-authority",
  NEXT_PUBLIC_CONVEX_SITE_URL:
    "https://benevolent-akita-439.convex.site",
  NEXT_PUBLIC_CONVEX_URL:
    "https://benevolent-akita-439.convex.cloud",
  NEXT_PUBLIC_SITE_URL: "https://hra.sh",
  SUITE_IDENTITY_RECEIPT_KEY_VERSION: "v1",
  SUITE_OIDC_COOKIE_SECRET: "c".repeat(64),
  VERCEL: "1",
  VERCEL_ENV: "production",
  VERCEL_TARGET_ENV: "production",
} as const;

test("foreign Preview host input is total and only a bare Vercel hostname succeeds", () => {
  assertProperty(fc.property(
    fc.option(fc.string(), { nil: undefined }),
    value => {
      const parsed = parseVercelPreviewSurfaceOrigin(value);
      if (!parsed.ok) return;
      expect(value).toMatch(/^[a-z0-9.-]+\.vercel\.app$/u);
      expect(parsed.origin).toBe(`https://${value}`);
    },
  ));
});

test("Preview never runs with any production capability record", () => {
  assertProperty(fc.property(
    fc.constantFrom(...previewForbiddenEnvironmentVariables),
    fc.string(),
    (variable, value) => {
      expect(planVercelConvexBuild({
        CONVEX_PRODUCTION_DEPLOYMENT_NAME: "benevolent-akita-439",
        NEXT_PUBLIC_CONVEX_SITE_URL:
          "https://benevolent-akita-439.convex.site",
        NEXT_PUBLIC_CONVEX_URL:
          "https://benevolent-akita-439.convex.cloud",
        VERCEL: "1",
        VERCEL_ENV: "preview",
        VERCEL_TARGET_ENV: "preview",
        VERCEL_URL: "hra-topic-team.vercel.app",
        [variable]: value,
      })).toEqual({
        kind: "refuse",
        reason: "production-capability-in-preview",
      });
    },
  ));
});

test("Production never runs with Convex-only custody in Vercel", () => {
  assertProperty(fc.property(
    fc.constantFrom(...convexOnlyEnvironmentVariables),
    fc.string(),
    (variable, value) => {
      expect(planVercelConvexBuild({
        CONVEX_PRODUCTION_DEPLOYMENT_NAME: "benevolent-akita-439",
        CONVEX_PROVIDER_AUTHORITY:
          "prod:benevolent-akita-439|provider-authority",
        NEXT_PUBLIC_CONVEX_SITE_URL:
          "https://benevolent-akita-439.convex.site",
        NEXT_PUBLIC_CONVEX_URL:
          "https://benevolent-akita-439.convex.cloud",
        NEXT_PUBLIC_SITE_URL: "https://hra.sh",
        SUITE_IDENTITY_RECEIPT_KEY_VERSION: "v1",
        SUITE_OIDC_COOKIE_SECRET: "c".repeat(64),
        VERCEL: "1",
        VERCEL_ENV: "production",
        VERCEL_TARGET_ENV: "production",
        [variable]: value,
      })).toEqual({
        kind: "refuse",
        reason: "convex-only-capability-in-production",
      });
    },
  ));
});

test("Production accepts exactly absent or complete public PostHog keys", () => {
  const tokenCharacter = fc.constantFrom("a", "Z", "0", "_", "-");
  const completePublicToken = fc.array(tokenCharacter, {
    minLength: 10,
    maxLength: 40,
  }).map(suffix => `phc_${suffix.join("")}`);
  assertProperty(fc.property(
    fc.oneof(fc.string(), completePublicToken),
    value => {
      const valid = /^phc_[A-Za-z0-9_-]{10,512}$/u.test(value);
      expect(planVercelConvexBuild({
        ...productionEnvironment,
        NEXT_PUBLIC_POSTHOG_KEY: value,
      })).toEqual(valid
        ? { environmentMode: "deploy-convex", kind: "run" }
        : { kind: "refuse", reason: "invalid-production-posthog-key" });
    },
  ));
  expect(planVercelConvexBuild(productionEnvironment)).toEqual({
    environmentMode: "deploy-convex",
    kind: "run",
  });
});

test("a production key never authorizes any non-Production target", () => {
  assertProperty(fc.property(
    fc.constantFrom(undefined, "development", "preview", "custom-staging", "other"),
    fc.string({ minLength: 1 }),
    (target, secret) => {
      const plan = planVercelConvexBuild({
        CONVEX_PROVIDER_AUTHORITY:
          `prod:benevolent-akita-439|${secret.replaceAll(/\s|\|/gu, "x")}`,
        CONVEX_PRODUCTION_DEPLOYMENT_NAME: "benevolent-akita-439",
        VERCEL: "1",
        VERCEL_ENV: target,
        VERCEL_TARGET_ENV: target,
      });
      expect(plan.kind).toBe("refuse");
    },
  ));
});
