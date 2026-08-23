const generatedDeploymentUrlPattern =
  /^https:\/\/[a-z][a-z0-9]*-[a-z][a-z0-9]*-[0-9]+\.convex\.cloud$/u;

export const HRA_EXPECTED_CONVEX_DEPLOY_URL =
  "HRA_EXPECTED_CONVEX_DEPLOY_URL" as const;
export const HRA_RESOLVED_CONVEX_DEPLOY_URL =
  "HRA_RESOLVED_CONVEX_DEPLOY_URL" as const;

const exactGeneratedDeploymentUrl = (value: unknown): string | null => {
  if (typeof value !== "string" || !generatedDeploymentUrlPattern.test(value)) {
    return null;
  }
  try {
    const parsed = new URL(value);
    return parsed.origin === value
      && parsed.username === ""
      && parsed.password === ""
      ? value
      : null;
  } catch {
    return null;
  }
};

export function resolvedConvexDeployTargetMatches(
  environment: Readonly<NodeJS.ProcessEnv>,
): boolean {
  const expected = exactGeneratedDeploymentUrl(
    environment[HRA_EXPECTED_CONVEX_DEPLOY_URL],
  );
  const resolved = exactGeneratedDeploymentUrl(
    environment[HRA_RESOLVED_CONVEX_DEPLOY_URL],
  );
  return expected !== null && resolved === expected;
}

if (import.meta.main) {
  process.exitCode = resolvedConvexDeployTargetMatches(process.env) ? 0 : 1;
}
