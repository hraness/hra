import { HRA_SITE_URL, HRA_SUITE_OIDC_ENVIRONMENT } from "./suite-account-configuration";
import {
  createSuiteOidcRelyingParty,
  type SuiteOidcRelyingParty,
} from "./suite-account-oidc";

export type HraSuiteOidcSurfaceEnvironment = Readonly<{
  NEXT_PUBLIC_SITE_URL?: string | undefined;
  SUITE_IDENTITY_RECEIPT_KEY_VERSION?: string | undefined;
  SUITE_OIDC_COOKIE_SECRET?: string | undefined;
}>;

function processEnvironment(): HraSuiteOidcSurfaceEnvironment {
  return {
    NEXT_PUBLIC_SITE_URL: process.env.NEXT_PUBLIC_SITE_URL,
    SUITE_IDENTITY_RECEIPT_KEY_VERSION:
      process.env.SUITE_IDENTITY_RECEIPT_KEY_VERSION,
    SUITE_OIDC_COOKIE_SECRET: process.env.SUITE_OIDC_COOKIE_SECRET,
  };
}

export function createHraSuiteRelyingParty(
  injectedEnvironment: HraSuiteOidcSurfaceEnvironment = processEnvironment(),
): SuiteOidcRelyingParty | null {
  const cookieSecret = injectedEnvironment.SUITE_OIDC_COOKIE_SECRET;
  const receiptKeyVersion =
    injectedEnvironment.SUITE_IDENTITY_RECEIPT_KEY_VERSION;
  if (
    injectedEnvironment.NEXT_PUBLIC_SITE_URL !== HRA_SITE_URL
    || cookieSecret === undefined
    || receiptKeyVersion === undefined
  ) {
    return null;
  }
  try {
    return createSuiteOidcRelyingParty({
      consumer: "hra",
      cookieSecret,
      environment: HRA_SUITE_OIDC_ENVIRONMENT,
      receiptKeyVersion,
    });
  } catch {
    return null;
  }
}

function unavailable(): Response {
  return Response.json(
    {
      error: {
        code: "SUITE_OIDC_UNAVAILABLE",
        message: "Suite sign-in is not configured for this surface.",
        retryable: false,
      },
      schemaVersion: 1,
    },
    { headers: { "cache-control": "no-store" }, status: 503 },
  );
}

export function hraSuiteOidcSurfaceHandler(
  options: Readonly<{
    createRelyingParty?: (
      request: Request,
    ) => Pick<SuiteOidcRelyingParty, "handle"> | null;
  }> = {},
): (request: Request) => Promise<Response> {
  return async (request: Request): Promise<Response> => {
    const relyingParty = options.createRelyingParty?.(request)
      ?? createHraSuiteRelyingParty();
    return relyingParty === null
      ? unavailable()
      : await relyingParty.handle(request);
  };
}
