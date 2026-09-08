export const hraResendApiKeyEnvironmentName = "HRA_RESEND_API_KEY" as const;
export const hraAttentionResendApiKeyEnvironmentName = "HRA_ATTENTION_RESEND_API_KEY" as const;

/**
 * Preserve the sign-in credential contract independently of attention email.
 * Keep errors generic so malformed secrets never reach logs or callers.
 */
export function requireHraResendApiKey(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): string {
  const value = environment[hraResendApiKeyEnvironmentName];
  if (
    value === undefined
    || !value.startsWith("re_")
    || value.length < 8
    || value.length > 512
    || /\s/u.test(value)
  ) throw new Error("Email delivery is unavailable.");
  return value;
}

export function requireHraAttentionResendApiKey(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): string {
  const value = environment[hraAttentionResendApiKeyEnvironmentName];
  const authenticationKey = environment[hraResendApiKeyEnvironmentName];
  if (
    !isStrictResendApiKey(value)
    || !isStrictResendApiKey(authenticationKey)
    || value === authenticationKey
  ) throw new Error("Attention email delivery is unavailable.");
  return value;
}

export function isStrictResendApiKey(value: string | undefined): value is string {
  return value !== undefined
    && value.length >= 8
    && value.length <= 512
    && /^re_[A-Za-z0-9_-]+$/u.test(value);
}
