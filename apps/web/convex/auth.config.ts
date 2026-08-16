import type { AuthConfig } from "convex/server";

function isLoopbackUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      (url.protocol === "http:" || url.protocol === "https:") &&
      (url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]") &&
      url.username === "" &&
      url.password === ""
    );
  } catch {
    return false;
  }
}

const providers: AuthConfig["providers"] = [];

function optionalEnvironmentValue(name: string): string | undefined {
  try {
    const value: unknown = Reflect.get(process.env, name);
    return typeof value === "string" && value.length > 0 ? value : undefined;
  } catch {
    return undefined;
  }
}

const clientId = optionalEnvironmentValue("WORKOS_CLIENT_ID");

if (clientId !== undefined && clientId.length > 0) {
  const jwks = `https://api.workos.com/sso/jwks/${clientId}`;
  providers.push({
    type: "customJwt",
    issuer: "https://api.workos.com/",
    algorithm: "RS256",
    jwks,
    applicationID: clientId,
  });
  providers.push({
    type: "customJwt",
    issuer: `https://api.workos.com/user_management/${clientId}`,
    algorithm: "RS256",
    jwks,
    applicationID: clientId,
  });
}

const localIssuer = optionalEnvironmentValue("TASKCTL_LOCAL_FIXTURE_ISSUER");
const localJwks = optionalEnvironmentValue("TASKCTL_LOCAL_FIXTURE_JWKS_URL");
if (
  optionalEnvironmentValue("TASKCTL_LOCAL_FIXTURES_ENABLED") === "true" &&
  localIssuer !== undefined &&
  localJwks !== undefined &&
  isLoopbackUrl(localIssuer) &&
  isLoopbackUrl(localJwks)
) {
  providers.push({
    type: "customJwt",
    issuer: localIssuer,
    algorithm: "RS256",
    jwks: localJwks,
    ...(clientId === undefined ? {} : { applicationID: clientId }),
  });
}

export default { providers } satisfies AuthConfig;
