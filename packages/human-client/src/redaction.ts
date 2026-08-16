import { redactSecretsInText } from "@hraness/agent-tasks-protocol";

const FALLBACK_DIAGNOSTIC = "human client operation failed";

/**
 * Redact structurally recognizable credentials and any opaque secrets known
 * only at the custody boundary. This intentionally returns text, never the
 * original thrown value or response body.
 */
export function redactHumanDiagnostic(
  value: unknown,
  knownSecrets: readonly string[] = [],
): string {
  const source = value instanceof Error ? value.message : typeof value === "string" ? value : FALLBACK_DIAGNOSTIC;
  return redactSecretsInText(source, knownSecrets);
}

export class HumanClientError extends Error {
  readonly code:
    | "AUTHENTICATION_FAILED"
    | "SERVICE_UNAVAILABLE"
    | "VALIDATION_ERROR";

  constructor(
    code: HumanClientError["code"],
    message: string,
  ) {
    super(redactHumanDiagnostic(message));
    this.name = "HumanClientError";
    this.code = code;
  }

  toJSON(): Readonly<{ code: HumanClientError["code"]; message: string }> {
    return { code: this.code, message: this.message };
  }
}
