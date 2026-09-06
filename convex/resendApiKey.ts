export const hraResendApiKeyEnvironmentName = "HRA_RESEND_API_KEY" as const;

/**
 * One validation boundary is shared by sign-in and attention email delivery.
 * Keep the error generic so a malformed secret never reaches logs or callers.
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
