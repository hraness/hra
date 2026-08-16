import {
  humanAccessTokenSchema,
  humanRefreshTokenSchema,
  workosOrganizationIdSchema,
  workosUserIdSchema,
  type RefreshAuthResponse,
} from "@hraness/agent-tasks-protocol";
import { z } from "@hra-internal/schema";

import { HumanClientError } from "./redaction";
import {
  StrictHumanHttpClient,
  type FetchLike,
  type StrictJsonResult,
} from "./strict-http";

const WORKOS_API_ORIGIN = "https://api.workos.com";
const AUTHORIZE_DEVICE_PATH = "/user_management/authorize/device";
const AUTHENTICATE_PATH = "/user_management/authenticate";
const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";
const MAX_WORKOS_RESPONSE_BYTES = 256 * 1_024;
const WORKOS_REQUEST_TIMEOUT_MS = 15_000;
const SENSITIVE_VERIFICATION_FIELDS = new Set([
  "access_token",
  "authorization",
  "device_code",
  "refresh_token",
]);

function isSafeVerificationUrl(value: string): boolean {
  try {
    const url = new URL(value);
    if (
      url.protocol !== "https:" ||
      url.username.length > 0 ||
      url.password.length > 0
    ) {
      return false;
    }
    if (
      [...url.searchParams.keys()].some((name) =>
        SENSITIVE_VERIFICATION_FIELDS.has(name.toLowerCase()))
    ) {
      return false;
    }
    const fragment = url.hash.slice(1);
    if (fragment.length === 0) return true;
    const fragmentParameters = new URLSearchParams(
      fragment.startsWith("?") ? fragment.slice(1) : fragment,
    );
    return [...fragmentParameters.keys()].every(
      (name) => !SENSITIVE_VERIFICATION_FIELDS.has(name.toLowerCase()),
    );
  } catch {
    return false;
  }
}

const httpsUrlSchema = z
  .string()
  .url()
  .refine(isSafeVerificationUrl, "verification URL must be safe HTTPS");

const deviceAuthorizationSchema = z
  .object({
    device_code: z.string().min(1).max(8_192),
    user_code: z.string().min(1).max(128),
    verification_uri: httpsUrlSchema,
    verification_uri_complete: httpsUrlSchema.optional(),
    expires_in: z.number().int().min(1).max(86_400),
    interval: z.number().int().min(1).max(300).optional(),
  })
  .passthrough();

const workosUserSchema = z
  .object({
    id: workosUserIdSchema,
    email: z.string().email(),
    name: z.string().min(1).max(240).nullable().optional(),
    first_name: z.string().min(1).max(120).nullable().optional(),
    last_name: z.string().min(1).max(120).nullable().optional(),
  })
  .passthrough();

const deviceAuthenticationSchema = z
  .object({
    access_token: humanAccessTokenSchema,
    refresh_token: humanRefreshTokenSchema,
    user: workosUserSchema,
    organization_id: workosOrganizationIdSchema.optional(),
  })
  .passthrough();

const deviceErrorSchema = z
  .object({
    error: z.string().min(1).max(128),
    error_description: z.string().max(1_000).optional(),
  })
  .passthrough();

export interface DeviceVerification {
  readonly userCode: string;
  readonly verificationUri: string;
  readonly verificationUriComplete?: string;
  readonly expiresAt: number;
}

export interface WorkosDeviceLoginOptions {
  readonly clientId: string;
  readonly fetch: FetchLike;
  readonly now: () => number;
  readonly sleep: (milliseconds: number) => Promise<void>;
  readonly onVerification: (verification: DeviceVerification) => void;
  readonly openBrowser?: (url: string) => Promise<void>;
}

function formBody(values: Readonly<Record<string, string>>): URLSearchParams {
  const body = new URLSearchParams();
  for (const [name, value] of Object.entries(values)) body.set(name, value);
  return body;
}

function humanName(user: z.infer<typeof workosUserSchema>): string | undefined {
  if (typeof user.name === "string") return user.name;
  const joined = [user.first_name, user.last_name]
    .filter((part): part is string => typeof part === "string")
    .join(" ")
    .trim();
  return joined.length === 0 ? undefined : joined;
}

function terminalDeviceError(error: string): HumanClientError {
  switch (error) {
    case "access_denied":
      return new HumanClientError(
        "AUTHENTICATION_FAILED",
        "device authorization was denied",
      );
    case "expired_token":
      return new HumanClientError(
        "AUTHENTICATION_FAILED",
        "device authorization expired",
      );
    default:
      return new HumanClientError(
        "AUTHENTICATION_FAILED",
        "device authentication failed",
      );
  }
}

function providerResponseError(
  reason?: "network" | "timeout",
): HumanClientError {
  return new HumanClientError(
    "SERVICE_UNAVAILABLE",
    reason === "timeout"
      ? "the identity provider request timed out"
      : reason === "network"
        ? "could not reach the identity provider"
        : "the identity provider returned an invalid response",
  );
}

function requireProviderResult<Success>(
  result: StrictJsonResult<Success, z.infer<typeof deviceErrorSchema>>,
): Success {
  if (result.ok) return result.data;
  if (result.kind === "http") throw terminalDeviceError(result.data.error);
  throw providerResponseError(
    result.error.reason === "timeout" || result.error.reason === "network"
      ? result.error.reason
      : undefined,
  );
}

export async function loginWithWorkosDevice(
  options: WorkosDeviceLoginOptions,
): Promise<RefreshAuthResponse> {
  if (
    options.clientId.length === 0 ||
    options.clientId.length > 512 ||
    /\s/u.test(options.clientId)
  ) {
    throw new HumanClientError(
      "VALIDATION_ERROR",
      "WorkOS client ID is invalid",
    );
  }
  const client = new StrictHumanHttpClient({
    apiUrl: WORKOS_API_ORIGIN,
    fetch: options.fetch,
    requestTimeoutMs: WORKOS_REQUEST_TIMEOUT_MS,
    maxResponseBytes: MAX_WORKOS_RESPONSE_BYTES,
  });
  const authorized = await client.request({
    method: "POST",
    path: AUTHORIZE_DEVICE_PATH,
    body: {
      kind: "form",
      value: formBody({ client_id: options.clientId }),
    },
    successSchema: deviceAuthorizationSchema,
    failureSchema: deviceErrorSchema,
  });
  const device = requireProviderResult(authorized);
  const expiresAt = options.now() + device.expires_in * 1_000;
  const verification: DeviceVerification = {
    userCode: device.user_code,
    verificationUri: device.verification_uri,
    expiresAt,
    ...(device.verification_uri_complete === undefined
      ? {}
      : { verificationUriComplete: device.verification_uri_complete }),
  };
  options.onVerification(verification);
  if (options.openBrowser !== undefined) {
    await options
      .openBrowser(
        verification.verificationUriComplete ?? verification.verificationUri,
      )
      .catch(() => undefined);
  }

  let intervalMilliseconds = (device.interval ?? 5) * 1_000;
  while (options.now() < expiresAt) {
    await options.sleep(intervalMilliseconds);
    if (options.now() >= expiresAt) break;
    const authenticated = await client.request({
      method: "POST",
      path: AUTHENTICATE_PATH,
      body: {
        kind: "form",
        value: formBody({
          grant_type: DEVICE_GRANT,
          device_code: device.device_code,
          client_id: options.clientId,
        }),
      },
      successSchema: deviceAuthenticationSchema,
      failureSchema: deviceErrorSchema,
    });
    if (authenticated.ok) {
      const name = humanName(authenticated.data.user);
      return {
        accessToken: authenticated.data.access_token,
        refreshToken: authenticated.data.refresh_token,
        user: {
          id: authenticated.data.user.id,
          email: authenticated.data.user.email,
          ...(name === undefined ? {} : { name }),
        },
        ...(authenticated.data.organization_id === undefined
          ? {}
          : {
              workosOrganizationId:
                authenticated.data.organization_id,
            }),
      };
    }
    if (authenticated.kind === "transport") {
      throw providerResponseError(
        authenticated.error.reason === "timeout" ||
          authenticated.error.reason === "network"
          ? authenticated.error.reason
          : undefined,
      );
    }
    if (authenticated.data.error === "authorization_pending") continue;
    if (authenticated.data.error === "slow_down") {
      intervalMilliseconds += 5_000;
      continue;
    }
    throw terminalDeviceError(authenticated.data.error);
  }
  throw new HumanClientError(
    "AUTHENTICATION_FAILED",
    "device authorization expired",
  );
}
