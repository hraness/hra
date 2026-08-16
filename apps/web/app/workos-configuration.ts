export const requiredWorkOSEnvironment = [
  "WORKOS_API_KEY",
  "WORKOS_CLIENT_ID",
  "WORKOS_COOKIE_PASSWORD",
  "NEXT_PUBLIC_WORKOS_REDIRECT_URI",
] as const;

type WorkOSEnvironment = Readonly<Record<string, string | undefined>>;

export function isNonEmptyEnvironmentValue(
  value: string | undefined,
): value is string {
  return value !== undefined && value.trim().length > 0;
}

export function missingWorkOSEnvironment(
  environment: WorkOSEnvironment,
): readonly (typeof requiredWorkOSEnvironment)[number][] {
  return requiredWorkOSEnvironment.filter(
    (key) => !isNonEmptyEnvironmentValue(environment[key]),
  );
}

export function isWorkOSEnvironmentConfigured(
  environment: WorkOSEnvironment,
): boolean {
  return missingWorkOSEnvironment(environment).length === 0;
}
