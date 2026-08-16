export const HRA_SITE_URL = "https://hra.sh" as const;
export const HRA_SUITE_ACCOUNTS_ORIGIN =
  "https://account.hraness.com" as const;
export const HRA_SUITE_OIDC_CLIENT_ID =
  "hraness:hra:production:v1" as const;
export const HRA_SUITE_OIDC_ENVIRONMENT = "production" as const;
export const HRA_SUITE_OAUTH_RESOURCE =
  "https://hraness.com/suite" as const;

export type HraSuiteOidcProviderConfiguration = Readonly<{
  authorizationEndpoint: string;
  discoveryEndpoint: string;
  entitlementReceiptEndpoint: string;
  identityLinkReceiptEndpoint: string;
  issuer: string;
  jwksEndpoint: string;
  resource: typeof HRA_SUITE_OAUTH_RESOURCE;
  revocationEndpoint: string;
  tokenEndpoint: string;
  userInfoAudience: string;
}>;

export const HRA_SUITE_OIDC_CALLBACK_URL = new URL(
  "/api/suite-auth/callback",
  HRA_SITE_URL,
).href;

export const HRA_SUITE_OIDC_PROVIDER: HraSuiteOidcProviderConfiguration = (() => {
  const authBase = new URL("/api/auth/", HRA_SUITE_ACCOUNTS_ORIGIN);
  return {
    authorizationEndpoint: new URL("oauth2/authorize", authBase).href,
    discoveryEndpoint: new URL(
      "/.well-known/openid-configuration",
      HRA_SUITE_ACCOUNTS_ORIGIN,
    ).href,
    entitlementReceiptEndpoint: new URL(
      "/suite/entitlements/receipt",
      HRA_SUITE_ACCOUNTS_ORIGIN,
    ).href,
    identityLinkReceiptEndpoint: new URL(
      "/suite/identity-links/receipt",
      HRA_SUITE_ACCOUNTS_ORIGIN,
    ).href,
    issuer: HRA_SUITE_ACCOUNTS_ORIGIN,
    jwksEndpoint: new URL("jwks", authBase).href,
    resource: HRA_SUITE_OAUTH_RESOURCE,
    revocationEndpoint: new URL("oauth2/revoke", authBase).href,
    tokenEndpoint: new URL("oauth2/token", authBase).href,
    userInfoAudience: new URL("oauth2/userinfo", authBase).href,
  };
})();

export function hraSuiteAccountUrl(
  destination: "account" | "home" | "login",
): string {
  const path = destination === "account"
    ? "/account"
    : destination === "login"
      ? "/login"
      : "/";
  return new URL(path, HRA_SUITE_ACCOUNTS_ORIGIN).href;
}
