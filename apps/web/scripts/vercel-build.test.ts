import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import {
  applicationBuildSecretEnvironmentVariables,
  convexOnlyEnvironmentVariables,
  parseVercelPreviewSurfaceOrigin,
  planVercelAppBuild,
  planVercelConvexBuild,
  previewForbiddenEnvironmentVariables,
  previewSurfaceOriginEnvironmentVariable,
  releasePublicationCommitEnvironmentVariable,
  runVercelAppBuild,
  runVercelConvexBuild,
  type VercelConvexBuildLauncher,
} from "./vercel-build";

const deployment = "benevolent-akita-439";
const marker = {
  CONVEX_PRODUCTION_DEPLOYMENT_NAME: deployment,
  [releasePublicationCommitEnvironmentVariable]: "a".repeat(40),
  VERCEL_GIT_COMMIT_SHA: "a".repeat(40),
  VERCEL_GIT_PROVIDER: "github",
  VERCEL_GIT_REPO_OWNER: "hraness",
  VERCEL_GIT_REPO_SLUG: "hra",
} as const;
const publicConvex = {
  NEXT_PUBLIC_CONVEX_SITE_URL: `https://${deployment}.convex.site`,
  NEXT_PUBLIC_CONVEX_URL: `https://${deployment}.convex.cloud`,
} as const;
const productionEnvironment = {
  ...marker,
  ...publicConvex,
  CONVEX_PROVIDER_AUTHORITY: `prod:${deployment}|secret`,
  NEXT_PUBLIC_SITE_URL: "https://hra.sh",
  SUITE_IDENTITY_RECEIPT_KEY_VERSION: "v1",
  SUITE_OIDC_COOKIE_SECRET: "c".repeat(64),
  VERCEL: "1",
  VERCEL_ENV: "production",
  VERCEL_GIT_COMMIT_REF: "main",
  VERCEL_TARGET_ENV: "production",
} as const;
const previewEnvironment = {
  ...marker,
  ...publicConvex,
  VERCEL: "1",
  VERCEL_ENV: "preview",
  VERCEL_GIT_COMMIT_REF: "candidate-preview",
  VERCEL_TARGET_ENV: "preview",
  VERCEL_URL: "hra-feature-hraness.vercel.app",
} as const;

const verifyExplicitCandidateReleaseSource = () =>
  Promise.resolve({ state: "candidate" as const });

describe("HRA Vercel Convex target plans", () => {
  test("allows only Production to deploy the exact shared backend", () => {
    expect(planVercelConvexBuild(productionEnvironment)).toEqual({
      environmentMode: "deploy-convex",
      kind: "run",
    });
    expect(planVercelConvexBuild({
      ...productionEnvironment,
      CONVEX_PROVIDER_AUTHORITY: "prod:other-akita-440|secret",
    })).toEqual({ kind: "refuse", reason: "production-deployment-mismatch" });
    expect(planVercelConvexBuild({
      ...productionEnvironment,
      CONVEX_SECOND_PROVIDER_RECORD: "token",
    })).toEqual({ kind: "refuse", reason: "production-deployment-token-present" });
  });

  test("binds every configured Production value to HRA's exact authority", () => {
    for (const [key, value, reason] of [
      ["NEXT_PUBLIC_CONVEX_URL", undefined, "missing-production-convex-url"],
      ["NEXT_PUBLIC_CONVEX_URL", "https://other-akita-440.convex.cloud", "invalid-production-convex-url"],
      ["NEXT_PUBLIC_CONVEX_SITE_URL", undefined, "missing-production-convex-site-url"],
      ["NEXT_PUBLIC_CONVEX_SITE_URL", "https://other-akita-440.convex.site", "invalid-production-convex-site-url"],
      ["NEXT_PUBLIC_SITE_URL", "https://oprte.com", "invalid-production-site-url"],
      ["SUITE_IDENTITY_RECEIPT_KEY_VERSION", "v2", "invalid-production-receipt-key-version"],
      ["SUITE_OIDC_COOKIE_SECRET", "short", "invalid-production-cookie-secret"],
    ] as const) {
      expect(planVercelConvexBuild({
        ...productionEnvironment,
        [key]: value,
      })).toEqual({ kind: "refuse", reason });
    }
  });

  test("refuses Convex-only custody in Production Vercel, including empty records", () => {
    for (const variable of convexOnlyEnvironmentVariables) {
      for (const value of ["", "configured"]) {
        expect(planVercelConvexBuild({
          ...productionEnvironment,
          [variable]: value,
        })).toEqual({
          kind: "refuse",
          reason: "convex-only-capability-in-production",
        });
      }
    }
  });

  test("turns Preview into an anonymous app-only production-data client", () => {
    expect(planVercelConvexBuild(previewEnvironment)).toEqual({
      environmentMode: "preview-app-only",
      kind: "run",
      surfaceOrigin: "https://hra-feature-hraness.vercel.app",
    });
    expect(planVercelAppBuild(previewEnvironment)).toEqual({
      kind: "run",
      surfaceOrigin: "https://hra-feature-hraness.vercel.app",
    });
  });

  test("refuses every production capability in Preview, including empty records", () => {
    for (const variable of previewForbiddenEnvironmentVariables) {
      for (const value of ["", "configured"]) {
        expect(planVercelConvexBuild({
          ...previewEnvironment,
          [variable]: value,
        })).toEqual({
          kind: "refuse",
          reason: "production-capability-in-preview",
        });
      }
    }
    for (const value of ["", `prod:${deployment}|secret`]) {
      expect(planVercelConvexBuild({
        ...previewEnvironment,
        CONVEX_PROVIDER_AUTHORITY: value,
      })).toEqual({
        kind: "refuse",
        reason: "production-capability-in-preview",
      });
    }
  });

  test("requires exact public production endpoints in Preview", () => {
    for (const [key, value, reason] of [
      ["NEXT_PUBLIC_CONVEX_URL", undefined, "missing-preview-convex-url"],
      ["NEXT_PUBLIC_CONVEX_URL", "https://other-akita-440.convex.cloud", "invalid-preview-convex-url"],
      ["NEXT_PUBLIC_CONVEX_SITE_URL", undefined, "missing-preview-convex-site-url"],
      ["NEXT_PUBLIC_CONVEX_SITE_URL", "https://other-akita-440.convex.site", "invalid-preview-convex-site-url"],
    ] as const) {
      expect(planVercelConvexBuild({
        ...previewEnvironment,
        [key]: value,
      })).toEqual({ kind: "refuse", reason });
    }
  });

  test("refuses custom staging and every unrecognized Vercel target", () => {
    for (const environment of [
      { VERCEL: "1" },
      { VERCEL: "1", VERCEL_ENV: "development", VERCEL_TARGET_ENV: "development" },
      { VERCEL: "1", VERCEL_ENV: "production", VERCEL_TARGET_ENV: "custom-staging" },
      { VERCEL: "1", VERCEL_ENV: "preview", VERCEL_TARGET_ENV: "custom-staging" },
    ] as const) {
      expect(planVercelConvexBuild(environment).kind).toBe("refuse");
    }
  });

  test("keeps local app builds available but production keys remote-only", () => {
    expect(planVercelAppBuild({})).toEqual({ kind: "run" });
    expect(planVercelConvexBuild({
      CONVEX_PROVIDER_AUTHORITY: `prod:${deployment}|secret`,
    })).toEqual({
      kind: "refuse",
      reason: "production-deploy-key-outside-production",
    });
  });
});

describe("Preview surface origin", () => {
  test("accepts only a bare lowercase generated Vercel hostname", () => {
    expect(parseVercelPreviewSurfaceOrigin("hra-topic-team.vercel.app")).toEqual({
      ok: true,
      origin: "https://hra-topic-team.vercel.app",
    });
    for (const value of [
      undefined,
      "https://hra-team.vercel.app",
      "hra-team.vercel.app/path",
      "hra-team.vercel.app:443",
      "Hra-team.vercel.app",
      "hra.example.com",
    ]) {
      expect(parseVercelPreviewSurfaceOrigin(value).ok).toBe(false);
    }
  });
});

function recorder(): Readonly<{
  calls: Array<Readonly<{
    command: readonly string[];
    environment: Record<string, string | undefined>;
  }>>;
  launch: VercelConvexBuildLauncher;
}> {
  const calls: Array<Readonly<{
    command: readonly string[];
    environment: Record<string, string | undefined>;
  }>> = [];
  return {
    calls,
    launch: (command, options) => {
      calls.push({ command, environment: options.env });
      return { exited: Promise.resolve(0) };
    },
  };
}

describe("provider process boundary", () => {
  test("uses the strict primary-checkout gate for a published local build", async () => {
    const observed = recorder();
    const calls: string[] = [];
    expect(await runVercelAppBuild({
      environment: {},
      expectedProductionDeploymentName: deployment,
      launch: observed.launch,
      verifyLocalReleaseSource: () => {
        calls.push("strict-local-source");
        return Promise.resolve();
      },
      verifyVercelReleaseSource: () => {
        calls.push("vercel-provider-source");
        return Promise.resolve();
      },
    })).toBe(0);
    expect(calls).toEqual(["strict-local-source"]);
    expect(observed.calls).toHaveLength(1);
  });

  test("refuses every build before provider or app launch when release provenance fails", async () => {
    for (const [run, environment] of [
      [runVercelConvexBuild, productionEnvironment],
      [runVercelAppBuild, productionEnvironment],
      [runVercelConvexBuild, previewEnvironment],
      [runVercelAppBuild, previewEnvironment],
    ] as const) {
      const observed = recorder();
      const reasons: string[] = [];
      expect(await run({
        environment,
        expectedProductionDeploymentName: deployment,
        launch: observed.launch,
        reportRefusal: reason => reasons.push(reason),
        verifyReleaseSource: () => Promise.reject(
          new Error("schema-valid but forged publication"),
        ),
      })).toBe(1);
      expect(observed.calls).toEqual([]);
      expect(reasons).toEqual(["release-source-provenance-invalid"]);
    }
  });

  test("Production invokes Convex with fixed argv and no secret argument", async () => {
    const observed = recorder();
    expect(await runVercelConvexBuild({
      environment: productionEnvironment,
      expectedProductionDeploymentName: deployment,
      launch: observed.launch,
      verifyReleaseSource: verifyExplicitCandidateReleaseSource,
    })).toBe(0);
    expect(observed.calls[0]?.command).toEqual([
      process.execPath,
      "x",
      "convex",
      "deploy",
      "--cmd-url-env-var-name",
      "NEXT_PUBLIC_CONVEX_URL",
      "--cmd",
      "bun run build",
    ]);
    expect(observed.calls[0]?.command.join(" ")).not.toContain("secret");
    expect(observed.calls[0]?.environment.CONVEX_PROVIDER_AUTHORITY)
      .toContain("|secret");
    expect(
      observed.calls[0]?.environment[releasePublicationCommitEnvironmentVariable],
    ).toBe("a".repeat(40));
  });

  test("the checked nested Production build strips secrets and retains public literals", async () => {
    const observed = recorder();
    expect(await runVercelAppBuild({
      environment: productionEnvironment,
      expectedProductionDeploymentName: deployment,
      launch: observed.launch,
      verifyReleaseSource: verifyExplicitCandidateReleaseSource,
    })).toBe(0);
    expect(observed.calls[0]?.command).toEqual([
      process.execPath,
      "run",
      "build:app",
    ]);
    for (const variable of applicationBuildSecretEnvironmentVariables) {
      expect(observed.calls[0]?.environment[variable]).toBeUndefined();
    }
    expect(
      Object.keys(observed.calls[0]?.environment ?? {})
        .filter(variable => variable.startsWith("CONVEX_")),
    ).toEqual([]);
    expect(observed.calls[0]?.environment.NEXT_PUBLIC_CONVEX_URL)
      .toBe(publicConvex.NEXT_PUBLIC_CONVEX_URL);
    expect(observed.calls[0]?.environment.NEXT_PUBLIC_CONVEX_SITE_URL)
      .toBe(publicConvex.NEXT_PUBLIC_CONVEX_SITE_URL);
    expect(observed.calls[0]?.environment.NEXT_PUBLIC_SITE_URL)
      .toBe("https://hra.sh");
    expect(observed.calls[0]?.environment.SUITE_IDENTITY_RECEIPT_KEY_VERSION)
      .toBe("v1");
    expect(
      observed.calls[0]?.environment[releasePublicationCommitEnvironmentVariable],
    ).toBeUndefined();
  });

  test("Preview skips Convex and strips every authority selector", async () => {
    const observed = recorder();
    expect(await runVercelConvexBuild({
      environment: previewEnvironment,
      expectedProductionDeploymentName: deployment,
      launch: observed.launch,
      verifyReleaseSource: verifyExplicitCandidateReleaseSource,
    })).toBe(0);
    expect(observed.calls[0]?.command).toEqual([
      process.execPath,
      "run",
      "build:app",
    ]);
    for (const variable of previewForbiddenEnvironmentVariables) {
      expect(observed.calls[0]?.environment[variable]).toBeUndefined();
    }
    expect(observed.calls[0]?.environment.CONVEX_PRODUCTION_DEPLOYMENT_NAME)
      .toBeUndefined();
    expect(observed.calls[0]?.environment[previewSurfaceOriginEnvironmentVariable])
      .toBe("https://hra-feature-hraness.vercel.app");
    expect(observed.calls[0]?.environment.NEXT_PUBLIC_CONVEX_URL)
      .toBe(publicConvex.NEXT_PUBLIC_CONVEX_URL);
    expect(observed.calls[0]?.environment.NEXT_PUBLIC_CONVEX_SITE_URL)
      .toBe(publicConvex.NEXT_PUBLIC_CONVEX_SITE_URL);
    expect(observed.calls[0]?.environment.NEXT_PUBLIC_SITE_URL).toBeUndefined();
    expect(
      observed.calls[0]?.environment[releasePublicationCommitEnvironmentVariable],
    ).toBeUndefined();
  });

  test("nested app build revalidates the source-bound declaration", async () => {
    const reasons: string[] = [];
    expect(await runVercelAppBuild({
      environment: {
        ...previewEnvironment,
        CONVEX_PRODUCTION_DEPLOYMENT_NAME: "other-akita-440",
      },
      expectedProductionDeploymentName: deployment,
      launch: recorder().launch,
      reportRefusal: reason => reasons.push(reason),
    })).toBe(1);
    expect(reasons).toEqual(["production-deployment-declaration-mismatch"]);
  });
});

describe("checked provider wiring", () => {
  test("pins one Production deployment and separates provider and app builds", () => {
    const vercel = readFileSync(new URL("../vercel.json", import.meta.url), "utf8");
    const manifest = readFileSync(new URL("../package.json", import.meta.url), "utf8");
    const wrapper = readFileSync(new URL("./vercel-build.ts", import.meta.url), "utf8");
    expect(vercel).toContain(
      '"buildCommand": "bun run scripts/vercel-build.ts --production-deployment benevolent-akita-439"',
    );
    expect(vercel).toContain(
      '"installCommand": "bunx bun@1.3.14 install --filter @hraness/hra-web --filter @hraness/hra --frozen-lockfile"',
    );
    expect(manifest).toContain(
      '"build": "bun run scripts/vercel-build.ts --run-app-build --production-deployment benevolent-akita-439"',
    );
    expect(manifest).toContain(
      '"build:app": "next build --webpack && bun run check:production-icons && bun run check:direct-boundary"',
    );
    expect(wrapper).toContain('environment.VERCEL === "1"');
    expect(wrapper).toContain("verifyVercelReleaseSourceGate(environment)");
    expect(wrapper).toContain("verifyReleaseSourceGate");
    expect(releasePublicationCommitEnvironmentVariable).toBe(
      "HRA_RELEASE_PUBLICATION_COMMIT_ALLOWLIST",
    );
  });
});
