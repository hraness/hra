import {
  createBearerSecret,
  desktopPairingChallengeSchema,
  desktopPairingRedeemEnvelopeSchema,
  desktopPairingRedeemRequestSchema,
  desktopPairingStartEnvelopeSchema,
  desktopPairingStartRequestSchema,
  errorEnvelopeSchema,
  taskctlApiOperations,
  taskctlApiRoutes,
  type PairedHumanAuthenticationResponse,
} from "@hraness/agent-tasks-protocol";

import { HumanClientError } from "./redaction";
import {
  normalizeApiOrigin,
  StrictHumanHttpClient,
  type FetchLike,
  type StrictJsonResult,
} from "./strict-http";

const MAX_DESKTOP_PAIRING_POLLS = 600;
const MAX_CONSECUTIVE_NETWORK_FAILURES = 3;

export interface DesktopPairingVerification {
  readonly verificationUri: string;
  readonly comparisonCode: string;
  readonly expiresAt: number;
}

export interface DesktopPairingLoginOptions {
  readonly apiUrl: string;
  readonly expectedWebOrigin: string;
  readonly fetch?: FetchLike;
  readonly now: () => number;
  readonly sleep: (milliseconds: number) => Promise<void>;
  readonly randomBytes?: (length: number) => Uint8Array;
  readonly onVerification: (verification: DesktopPairingVerification) => void;
  readonly openBrowser?: (url: string) => Promise<void>;
}

export type DesktopPairingFailureOutcome =
  | "denied"
  | "expired"
  | "consumed"
  | "network";

export class DesktopPairingError extends HumanClientError {
  readonly outcome: DesktopPairingFailureOutcome;

  constructor(
    outcome: DesktopPairingFailureOutcome,
    code: "AUTHENTICATION_FAILED" | "SERVICE_UNAVAILABLE",
    message: string,
  ) {
    super(code, message);
    this.name = "DesktopPairingError";
    this.outcome = outcome;
  }

  override toJSON(): Readonly<{
    code: "AUTHENTICATION_FAILED" | "SERVICE_UNAVAILABLE";
    message: string;
    outcome: DesktopPairingFailureOutcome;
  }> {
    return {
      code: this.code as "AUTHENTICATION_FAILED" | "SERVICE_UNAVAILABLE",
      message: this.message,
      outcome: this.outcome,
    };
  }
}

function defaultRandomBytes(length: number): Uint8Array {
  if (!Number.isSafeInteger(length) || length <= 0) {
    throw new RangeError("random byte length is invalid");
  }
  const bytes = new Uint8Array(length);
  globalThis.crypto.getRandomValues(bytes);
  return bytes;
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

/** The challenge is SHA-256 over the UTF-8 bytes of the canonical verifier. */
export async function desktopPairingChallengeForVerifier(
  verifier: string,
): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(verifier),
  );
  return desktopPairingChallengeSchema.parse(base64Url(new Uint8Array(digest)));
}

function networkError(message: string): DesktopPairingError {
  return new DesktopPairingError("network", "SERVICE_UNAVAILABLE", message);
}

function requireResult<Success>(
  result: StrictJsonResult<Success, { readonly error: { readonly code: string } }>,
): Success {
  if (result.ok) return result.data;
  if (result.kind === "transport") {
    throw networkError(result.error.message);
  }
  throw new DesktopPairingError(
    result.data.error.code === "AUTHENTICATION_FAILED" ? "denied" : "network",
    result.data.error.code === "AUTHENTICATION_FAILED"
      ? "AUTHENTICATION_FAILED"
      : "SERVICE_UNAVAILABLE",
    result.data.error.code === "AUTHENTICATION_FAILED"
      ? "desktop pairing was denied"
      : "desktop pairing is temporarily unavailable",
  );
}

function requireExpectedVerificationOrigin(
  verificationUri: string,
  expectedWebOrigin: string,
): void {
  const normalized = normalizeApiOrigin(expectedWebOrigin);
  if (normalized === null || new URL(verificationUri).origin !== normalized) {
    throw new HumanClientError(
      "VALIDATION_ERROR",
      "desktop pairing verification origin does not match configuration",
    );
  }
}

export async function loginWithDesktopPairing(
  options: DesktopPairingLoginOptions,
): Promise<PairedHumanAuthenticationResponse> {
  const random = options.randomBytes ?? defaultRandomBytes;
  const verifier = createBearerSecret(random(32));
  const challenge = await desktopPairingChallengeForVerifier(verifier);
  const client = new StrictHumanHttpClient({
    apiUrl: options.apiUrl,
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
  });

  const startRequest = desktopPairingStartRequestSchema.parse({ challenge });
  const started = requireResult(await client.request({
    method: taskctlApiOperations.startDesktopPairing.method,
    path: taskctlApiRoutes.desktopPairings,
    body: { kind: "json", value: startRequest, schema: desktopPairingStartRequestSchema },
    successSchema: desktopPairingStartEnvelopeSchema,
    failureSchema: errorEnvelopeSchema,
  }));
  const pairing = started.data;
  requireExpectedVerificationOrigin(pairing.verificationUri, options.expectedWebOrigin);
  if (pairing.expiresAt <= options.now()) {
    throw new DesktopPairingError(
      "expired",
      "AUTHENTICATION_FAILED",
      "desktop pairing expired",
    );
  }

  const verification: DesktopPairingVerification = {
    verificationUri: pairing.verificationUri,
    comparisonCode: pairing.comparisonCode,
    expiresAt: pairing.expiresAt,
  };
  options.onVerification(verification);
  if (options.openBrowser !== undefined) {
    await options.openBrowser(verification.verificationUri).catch(() => undefined);
  }

  let nextDelayMs = pairing.pollIntervalMs;
  let consecutiveNetworkFailures = 0;
  for (let poll = 0; poll < MAX_DESKTOP_PAIRING_POLLS; poll += 1) {
    await options.sleep(nextDelayMs);
    if (options.now() >= pairing.expiresAt) break;

    const request = desktopPairingRedeemRequestSchema.parse({ verifier });
    const result = await client.request({
      method: taskctlApiOperations.redeemDesktopPairing.method,
      path: taskctlApiRoutes.desktopPairingRedeem(pairing.pairingId),
      body: { kind: "json", value: request, schema: desktopPairingRedeemRequestSchema },
      successSchema: desktopPairingRedeemEnvelopeSchema,
      failureSchema: errorEnvelopeSchema,
    });
    if (!result.ok && result.kind === "transport") {
      consecutiveNetworkFailures += 1;
      if (consecutiveNetworkFailures > MAX_CONSECUTIVE_NETWORK_FAILURES) {
        throw networkError("desktop pairing could not reach the human service");
      }
      continue;
    }
    const redeemed = requireResult(result).data;
    consecutiveNetworkFailures = 0;
    switch (redeemed.status) {
      case "approved":
        return redeemed.authentication;
      case "pending":
        nextDelayMs = redeemed.retryAfterMs;
        break;
      case "denied":
        throw new DesktopPairingError(
          "denied",
          "AUTHENTICATION_FAILED",
          "desktop pairing was denied",
        );
      case "expired":
        throw new DesktopPairingError(
          "expired",
          "AUTHENTICATION_FAILED",
          "desktop pairing expired",
        );
      case "consumed":
        throw new DesktopPairingError(
          "consumed",
          "AUTHENTICATION_FAILED",
          "desktop pairing was already consumed",
        );
    }
  }

  throw new DesktopPairingError(
    "expired",
    "AUTHENTICATION_FAILED",
    "desktop pairing expired",
  );
}
