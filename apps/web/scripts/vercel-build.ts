import {
  releasePublicationCommitAllowlistEnvironmentVariable,
  verifyReleaseSourceGate,
  verifyVercelReleaseSourceGate,
} from "../../desktop/runtime/release-download-contract";
import { isHraPublicProjectToken } from "../app/analytics";

const convexDeployArguments = [
  "x",
  "convex",
  "deploy",
  "--cmd-url-env-var-name",
  "NEXT_PUBLIC_CONVEX_URL",
  "--cmd",
  "bun run build",
] as const;

const applicationBuildArguments = ["run", "build:app"] as const;
const deploymentNamePattern = /^[a-z0-9]+(?:-[a-z0-9]+)+$/u;
const keyVersionPattern = /^[a-z0-9][a-z0-9._-]{0,31}$/u;
const vercelHostnamePattern =
  /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+vercel\.app$/u;

const HRA_PRODUCTION_SITE_URL = "https://hra.sh";
const HRA_PRODUCTION_RECEIPT_KEY_VERSION = "v1";

export const productionDeploymentNameEnvironmentVariable =
  "CONVEX_PRODUCTION_DEPLOYMENT_NAME" as const;
export const previewSurfaceOriginEnvironmentVariable =
  "NEXT_PUBLIC_VERCEL_SURFACE_ORIGIN" as const;

/** Convex runtime custody that must never exist in the Vercel project. */
export const convexOnlyEnvironmentVariables = [
  "HRA_HOSTED_MUTATION_FINGERPRINT_KEY_CURRENT",
  "HRA_HOSTED_MUTATION_FINGERPRINT_KEY_CURRENT_VERSION",
  "HRA_HOSTED_MUTATION_FINGERPRINT_KEY_PREVIOUS",
  "HRA_HOSTED_MUTATION_FINGERPRINT_KEY_PREVIOUS_VERSION",
  "HRA_SESSION_SYNC_ENABLED",
  "OPRTE_HOSTED_MUTATION_FINGERPRINT_KEY_CURRENT",
  "OPRTE_HOSTED_MUTATION_FINGERPRINT_KEY_CURRENT_VERSION",
  "OPRTE_HOSTED_MUTATION_FINGERPRINT_KEY_PREVIOUS",
  "OPRTE_HOSTED_MUTATION_FINGERPRINT_KEY_PREVIOUS_VERSION",
  "OPRTE_SESSION_SYNC_ENABLED",
  "SUITE_IDENTITY_LINK_KEYS",
  "TASKCTL_CREDENTIAL_PEPPER_CURRENT",
  "TASKCTL_CREDENTIAL_PEPPER_CURRENT_VERSION",
  "TASKCTL_CREDENTIAL_PEPPER_PREVIOUS",
  "TASKCTL_CREDENTIAL_PEPPER_PREVIOUS_VERSION",
  "TASKCTL_ENROLLMENT_PEPPER_CURRENT",
  "TASKCTL_ENROLLMENT_PEPPER_CURRENT_VERSION",
  "TASKCTL_ENROLLMENT_PEPPER_PREVIOUS",
  "TASKCTL_ENROLLMENT_PEPPER_PREVIOUS_VERSION",
  "TASKCTL_LOCAL_FIXTURES_ENABLED",
  "TASKCTL_LOCAL_FIXTURE_ISSUER",
  "TASKCTL_LOCAL_FIXTURE_JWKS_URL",
  "TASKCTL_LOCAL_FIXTURE_SUBJECT",
  "WORKOS_API_HOSTNAME",
  "WORKOS_API_HTTPS",
  "WORKOS_API_PORT",
  "WORKOS_OWNER_ROLE_SLUG",
  "WORKOS_WEBHOOK_SECRET",
] as const;
export const releasePublicationCommitEnvironmentVariable =
  releasePublicationCommitAllowlistEnvironmentVariable;

/**
 * These values are either deployment authority or complete a production-only
 * identity/write capability. Preview must be useful without receiving any of
 * them, including empty provider records.
 */
export const previewForbiddenEnvironmentVariables = [
  ...convexOnlyEnvironmentVariables,
  "NEXT_PUBLIC_POSTHOG_KEY",
  "NEXT_PUBLIC_SITE_URL",
  "NEXT_PUBLIC_WORKOS_REDIRECT_URI",
  "SUITE_IDENTITY_RECEIPT_KEY_VERSION",
  "SUITE_OIDC_COOKIE_SECRET",
  "WORKOS_API_KEY",
  "WORKOS_CLIENT_ID",
  "WORKOS_COOKIE_PASSWORD",
] as const;

export const applicationBuildSecretEnvironmentVariables = [
  ...convexOnlyEnvironmentVariables,
  "SUITE_OIDC_COOKIE_SECRET",
  "WORKOS_API_KEY",
  "WORKOS_COOKIE_PASSWORD",
] as const;

export type VercelConvexBuildRefusal =
  | "invalid-preview-convex-site-url"
  | "invalid-preview-convex-url"
  | "invalid-preview-surface-host"
  | "invalid-production-convex-site-url"
  | "invalid-production-convex-url"
  | "invalid-production-cookie-secret"
  | "invalid-production-deployment-name"
  | "invalid-production-posthog-key"
  | "invalid-production-receipt-key-version"
  | "invalid-production-site-url"
  | "malformed-production-deploy-key"
  | "missing-preview-convex-site-url"
  | "missing-preview-convex-url"
  | "missing-preview-surface-host"
  | "missing-production-convex-site-url"
  | "missing-production-convex-url"
  | "missing-production-cookie-secret"
  | "missing-production-deploy-key"
  | "missing-production-deployment-name"
  | "missing-production-receipt-key-version"
  | "missing-production-site-url"
  | "non-production-deploy-key"
  | "production-capability-in-preview"
  | "convex-only-capability-in-production"
  | "production-deploy-key-outside-production"
  | "production-deployment-declaration-mismatch"
  | "production-deployment-mismatch"
  | "production-deployment-token-present"
  | "production-marker-outside-vercel"
  | "release-source-provenance-invalid"
  | "production-target-outside-production"
  | "production-target-outside-vercel"
  | "preview-target-outside-preview"
  | "preview-target-outside-vercel"
  | "unsupported-vercel-runtime";

export type VercelConvexBuildPlan =
  | Readonly<{ kind: "refuse"; reason: VercelConvexBuildRefusal }>
  | Readonly<{
      environmentMode: "deploy-convex" | "preview-app-only";
      kind: "run";
      surfaceOrigin?: string;
    }>;

export type VercelAppBuildPlan =
  | Readonly<{ kind: "refuse"; reason: VercelConvexBuildRefusal }>
  | Readonly<{ kind: "run"; surfaceOrigin?: string }>;

export type VercelConvexBuildEnvironment = Readonly<
  Record<string, string | undefined>
>;

type BuildSubprocess = { readonly exited: Promise<number> };

export type VercelConvexBuildLauncher = (
  command: readonly string[],
  options: Readonly<{
    env: Record<string, string | undefined>;
    stderr: "inherit";
    stdin: "inherit";
    stdout: "inherit";
  }>,
) => BuildSubprocess;

export type ReleaseSourceVerifier = () => Promise<unknown>;

type VercelBuildRunOptions = Readonly<{
  environment?: VercelConvexBuildEnvironment;
  expectedProductionDeploymentName?: string;
  launch?: VercelConvexBuildLauncher;
  reportRefusal?: (reason: VercelConvexBuildRefusal) => void;
  verifyLocalReleaseSource?: ReleaseSourceVerifier;
  verifyReleaseSource?: ReleaseSourceVerifier;
  verifyVercelReleaseSource?: ReleaseSourceVerifier;
}>;

function parseProductionDeployKey(
  value: string | undefined,
): { readonly deploymentName: string } | VercelConvexBuildRefusal {
  if (value === undefined || value === "") return "missing-production-deploy-key";
  if (!value.startsWith("prod:")) return "non-production-deploy-key";
  const separatorIndex = value.indexOf("|");
  if (
    separatorIndex === -1
    || separatorIndex === value.length - 1
    || value.indexOf("|", separatorIndex + 1) !== -1
    || /\s/u.test(value)
  ) {
    return "malformed-production-deploy-key";
  }
  const deploymentName = value.slice("prod:".length, separatorIndex);
  return deploymentNamePattern.test(deploymentName)
    ? { deploymentName }
    : "malformed-production-deploy-key";
}

function convexProviderRecords(
  environment: VercelConvexBuildEnvironment,
): readonly (readonly [string, string | undefined])[] {
  return Object.entries(environment).filter(([name]) =>
    name.startsWith("CONVEX_")
    && name !== productionDeploymentNameEnvironmentVariable
  );
}

export function parseVercelPreviewSurfaceOrigin(
  value: string | undefined,
): Readonly<{ ok: true; origin: string }> | Readonly<{
  ok: false;
  reason: "invalid-preview-surface-host" | "missing-preview-surface-host";
}> {
  if (value === undefined || value === "") {
    return { ok: false, reason: "missing-preview-surface-host" };
  }
  if (value !== value.toLowerCase() || !vercelHostnamePattern.test(value)) {
    return { ok: false, reason: "invalid-preview-surface-host" };
  }
  return { ok: true, origin: `https://${value}` };
}

function exactPublicConvexConfiguration(
  environment: VercelConvexBuildEnvironment,
  deploymentName: string,
  target: "preview" | "production",
): VercelConvexBuildRefusal | null {
  const expectedUrl = `https://${deploymentName}.convex.cloud`;
  const expectedSiteUrl = `https://${deploymentName}.convex.site`;
  const convexUrl = environment.NEXT_PUBLIC_CONVEX_URL;
  const convexSiteUrl = environment.NEXT_PUBLIC_CONVEX_SITE_URL;
  if (convexUrl === undefined || convexUrl === "") {
    return target === "preview"
      ? "missing-preview-convex-url"
      : "missing-production-convex-url";
  }
  if (convexUrl !== expectedUrl) {
    return target === "preview"
      ? "invalid-preview-convex-url"
      : "invalid-production-convex-url";
  }
  if (convexSiteUrl === undefined || convexSiteUrl === "") {
    return target === "preview"
      ? "missing-preview-convex-site-url"
      : "missing-production-convex-site-url";
  }
  if (convexSiteUrl !== expectedSiteUrl) {
    return target === "preview"
      ? "invalid-preview-convex-site-url"
      : "invalid-production-convex-site-url";
  }
  return null;
}

function productionConfigurationRefusal(
  environment: VercelConvexBuildEnvironment,
  deploymentName: string,
): VercelConvexBuildRefusal | null {
  for (const variable of convexOnlyEnvironmentVariables) {
    if (environment[variable] !== undefined) {
      return "convex-only-capability-in-production";
    }
  }
  const posthogKey = environment.NEXT_PUBLIC_POSTHOG_KEY;
  if (posthogKey !== undefined && !isHraPublicProjectToken(posthogKey)) {
    return "invalid-production-posthog-key";
  }
  const publicConvex = exactPublicConvexConfiguration(
    environment,
    deploymentName,
    "production",
  );
  if (publicConvex !== null) return publicConvex;
  const siteUrl = environment.NEXT_PUBLIC_SITE_URL;
  if (siteUrl === undefined || siteUrl === "") return "missing-production-site-url";
  if (siteUrl !== HRA_PRODUCTION_SITE_URL) return "invalid-production-site-url";
  const keyVersion = environment.SUITE_IDENTITY_RECEIPT_KEY_VERSION;
  if (keyVersion === undefined || keyVersion === "") {
    return "missing-production-receipt-key-version";
  }
  if (
    keyVersion !== HRA_PRODUCTION_RECEIPT_KEY_VERSION
    || !keyVersionPattern.test(keyVersion)
  ) {
    return "invalid-production-receipt-key-version";
  }
  const cookieSecret = environment.SUITE_OIDC_COOKIE_SECRET;
  if (cookieSecret === undefined || cookieSecret === "") {
    return "missing-production-cookie-secret";
  }
  const cookieBytes = new TextEncoder().encode(cookieSecret).byteLength;
  return cookieBytes >= 32 && cookieBytes <= 1_024
    ? null
    : "invalid-production-cookie-secret";
}

function previewConfiguration(
  environment: VercelConvexBuildEnvironment,
  deploymentName: string,
): VercelConvexBuildRefusal | Readonly<{ surfaceOrigin: string }> {
  if (convexProviderRecords(environment).length > 0) {
    return "production-capability-in-preview";
  }
  for (const variable of previewForbiddenEnvironmentVariables) {
    if (environment[variable] !== undefined) {
      return "production-capability-in-preview";
    }
  }
  const publicConvex = exactPublicConvexConfiguration(
    environment,
    deploymentName,
    "preview",
  );
  if (publicConvex !== null) return publicConvex;
  const surface = parseVercelPreviewSurfaceOrigin(environment.VERCEL_URL);
  return surface.ok ? { surfaceOrigin: surface.origin } : surface.reason;
}

function declaredProductionDeployment(
  environment: VercelConvexBuildEnvironment,
): Readonly<{ deploymentName: string; ok: true }> | Readonly<{
  ok: false;
  reason: VercelConvexBuildRefusal;
}> {
  const value = environment[productionDeploymentNameEnvironmentVariable];
  if (value === undefined || value === "") {
    return { ok: false, reason: "missing-production-deployment-name" };
  }
  return deploymentNamePattern.test(value)
    ? { deploymentName: value, ok: true }
    : { ok: false, reason: "invalid-production-deployment-name" };
}

export function planVercelConvexBuild(
  environment: VercelConvexBuildEnvironment,
): VercelConvexBuildPlan {
  const target = environment.VERCEL_TARGET_ENV;
  const deploymentMarker =
    environment[productionDeploymentNameEnvironmentVariable];
  if (target === "production") {
    if (environment.VERCEL !== "1") {
      return { kind: "refuse", reason: "production-target-outside-vercel" };
    }
    if (environment.VERCEL_ENV !== "production") {
      return { kind: "refuse", reason: "production-target-outside-production" };
    }
    const declared = declaredProductionDeployment(environment);
    if (!declared.ok) return { kind: "refuse", reason: declared.reason };
    const providerRecords = convexProviderRecords(environment);
    if (providerRecords.length === 0) {
      return { kind: "refuse", reason: "missing-production-deploy-key" };
    }
    if (providerRecords.length !== 1) {
      return { kind: "refuse", reason: "production-deployment-token-present" };
    }
    const key = parseProductionDeployKey(providerRecords[0]?.[1]);
    if (typeof key === "string") return { kind: "refuse", reason: key };
    if (key.deploymentName !== declared.deploymentName) {
      return { kind: "refuse", reason: "production-deployment-mismatch" };
    }
    const refusal = productionConfigurationRefusal(
      environment,
      declared.deploymentName,
    );
    return refusal === null
      ? { environmentMode: "deploy-convex", kind: "run" }
      : { kind: "refuse", reason: refusal };
  }
  if (target === "preview" || environment.VERCEL_ENV === "preview") {
    if (environment.VERCEL !== "1") {
      return { kind: "refuse", reason: "preview-target-outside-vercel" };
    }
    if (target !== "preview" || environment.VERCEL_ENV !== "preview") {
      return { kind: "refuse", reason: "preview-target-outside-preview" };
    }
    const declared = declaredProductionDeployment(environment);
    if (!declared.ok) return { kind: "refuse", reason: declared.reason };
    const preview = previewConfiguration(environment, declared.deploymentName);
    return typeof preview === "string"
      ? { kind: "refuse", reason: preview }
      : {
          environmentMode: "preview-app-only",
          kind: "run",
          surfaceOrigin: preview.surfaceOrigin,
        };
  }
  if (environment.VERCEL === "1") {
    return { kind: "refuse", reason: "unsupported-vercel-runtime" };
  }
  if (deploymentMarker !== undefined) {
    return { kind: "refuse", reason: "production-marker-outside-vercel" };
  }
  if (
    convexProviderRecords(environment)
      .some(([, value]) => value?.startsWith("prod:") === true)
  ) {
    return { kind: "refuse", reason: "production-deploy-key-outside-production" };
  }
  return { environmentMode: "deploy-convex", kind: "run" };
}

export function planVercelAppBuild(
  environment: VercelConvexBuildEnvironment,
): VercelAppBuildPlan {
  const plan = planVercelConvexBuild(environment);
  return plan.kind === "refuse"
    ? plan
    : {
        kind: "run",
        ...(plan.surfaceOrigin === undefined
          ? {}
          : { surfaceOrigin: plan.surfaceOrigin }),
      };
}

function declareRegisteredProductionDeployment(
  environment: VercelConvexBuildEnvironment,
  expectedName: string | undefined,
): VercelConvexBuildEnvironment | VercelConvexBuildRefusal {
  if (expectedName === undefined || !deploymentNamePattern.test(expectedName)) {
    return "invalid-production-deployment-name";
  }
  if (
    environment.VERCEL_TARGET_ENV !== "production"
    && environment.VERCEL_TARGET_ENV !== "preview"
    && environment.VERCEL_ENV !== "production"
    && environment.VERCEL_ENV !== "preview"
  ) {
    return environment;
  }
  const configured = environment[productionDeploymentNameEnvironmentVariable];
  if (configured !== undefined && configured !== expectedName) {
    return "production-deployment-declaration-mismatch";
  }
  return {
    ...environment,
    [productionDeploymentNameEnvironmentVariable]: expectedName,
  };
}

function defaultLauncher(
  command: readonly string[],
  options: Parameters<VercelConvexBuildLauncher>[1],
): BuildSubprocess {
  return Bun.spawn([...command], options);
}

function applicationEnvironment(
  environment: VercelConvexBuildEnvironment,
  surfaceOrigin?: string,
): Record<string, string | undefined> {
  const child: Record<string, string | undefined> = { ...environment };
  for (const variable of Object.keys(child)) {
    if (variable.startsWith("CONVEX_")) delete child[variable];
  }
  for (const variable of applicationBuildSecretEnvironmentVariables) {
    delete child[variable];
  }
  delete child[releasePublicationCommitEnvironmentVariable];
  if (surfaceOrigin === undefined) {
    delete child[previewSurfaceOriginEnvironmentVariable];
  } else {
    for (const variable of previewForbiddenEnvironmentVariables) {
      delete child[variable];
    }
    child[previewSurfaceOriginEnvironmentVariable] = surfaceOrigin;
  }
  return child;
}

async function launchApplicationBuild(
  environment: VercelConvexBuildEnvironment,
  launch: VercelConvexBuildLauncher,
  surfaceOrigin?: string,
): Promise<number> {
  return await launch([process.execPath, ...applicationBuildArguments], {
    env: applicationEnvironment(environment, surfaceOrigin),
    stderr: "inherit",
    stdin: "inherit",
    stdout: "inherit",
  }).exited;
}

export async function runVercelConvexBuild(
  options?: VercelBuildRunOptions,
): Promise<number> {
  const declared = declareRegisteredProductionDeployment(
    options?.environment ?? process.env,
    options?.expectedProductionDeploymentName,
  );
  if (typeof declared === "string") {
    (options?.reportRefusal ?? defaultRefusalReporter)(declared);
    return 1;
  }
  const plan = planVercelConvexBuild(declared);
  if (plan.kind === "refuse") {
    (options?.reportRefusal ?? defaultRefusalReporter)(plan.reason);
    return 1;
  }
  if (!await releaseSourceIsValid(declared, options)) return 1;
  const launch = options?.launch ?? defaultLauncher;
  return plan.environmentMode === "preview-app-only"
    ? await launchApplicationBuild(declared, launch, plan.surfaceOrigin)
    : await launch([process.execPath, ...convexDeployArguments], {
        env: { ...declared },
        stderr: "inherit",
        stdin: "inherit",
        stdout: "inherit",
      }).exited;
}

export async function runVercelAppBuild(
  options?: VercelBuildRunOptions,
): Promise<number> {
  const declared = declareRegisteredProductionDeployment(
    options?.environment ?? process.env,
    options?.expectedProductionDeploymentName,
  );
  if (typeof declared === "string") {
    (options?.reportRefusal ?? defaultRefusalReporter)(declared);
    return 1;
  }
  const plan = planVercelAppBuild(declared);
  if (plan.kind === "refuse") {
    (options?.reportRefusal ?? defaultRefusalReporter)(plan.reason);
    return 1;
  }
  if (!await releaseSourceIsValid(declared, options)) return 1;
  return await launchApplicationBuild(
    declared,
    options?.launch ?? defaultLauncher,
    plan.surfaceOrigin,
  );
}

async function releaseSourceIsValid(
  environment: VercelConvexBuildEnvironment,
  options: VercelBuildRunOptions | undefined,
): Promise<boolean> {
  try {
    if (options?.verifyReleaseSource !== undefined) {
      await options.verifyReleaseSource();
    } else if (environment.VERCEL === "1") {
      await (options?.verifyVercelReleaseSource
        ?? (() => verifyVercelReleaseSourceGate(environment)))();
    } else {
      await (options?.verifyLocalReleaseSource ?? verifyReleaseSourceGate)();
    }
    return true;
  } catch {
    (options?.reportRefusal ?? defaultRefusalReporter)(
      "release-source-provenance-invalid",
    );
    return false;
  }
}

function defaultRefusalReporter(reason: VercelConvexBuildRefusal): void {
  console.error(`Vercel Convex build refused: ${reason}.`);
}

function parseArguments(arguments_: readonly string[]): Readonly<{
  expectedProductionDeploymentName: string;
  runAppBuild: boolean;
}> | null {
  let expectedProductionDeploymentName: string | undefined;
  let runAppBuild = false;
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === "--run-app-build" && !runAppBuild) {
      runAppBuild = true;
      continue;
    }
    if (
      argument === "--production-deployment"
      && expectedProductionDeploymentName === undefined
      && index + 1 < arguments_.length
    ) {
      expectedProductionDeploymentName = arguments_[index + 1];
      index += 1;
      continue;
    }
    return null;
  }
  return expectedProductionDeploymentName === undefined
    ? null
    : { expectedProductionDeploymentName, runAppBuild };
}

if (import.meta.main) {
  const options = parseArguments(process.argv.slice(2));
  if (options === null) {
    console.error("Vercel Convex build refused: unsupported-arguments.");
    process.exitCode = 1;
  } else if (options.runAppBuild) {
    process.exitCode = await runVercelAppBuild(options);
  } else {
    process.exitCode = await runVercelConvexBuild(options);
  }
}
