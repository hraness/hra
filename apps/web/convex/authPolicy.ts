export const AUTH_SESSION_TOTAL_DURATION_MS = 30 * 24 * 60 * 60 * 1_000;
export const AUTH_SCOPE_ROTATION_LIFETIME_MS = 30_000;
export const PASSWORD_PAIRING_APPROVAL_WINDOW_MS = 15 * 60 * 1_000;
export const PASSWORD_SIGN_UP_RESERVATION_LIFETIME_MS = 60_000;

export function normalizePasswordEmail(value: unknown): string {
  if (typeof value !== "string") throw new Error("Enter a valid email address.");
  const email = value.trim().toLowerCase();
  if (
    email.length < 3 || email.length > 320 ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email)
  ) throw new Error("Enter a valid email address.");
  return email;
}

export function validatePasswordRequirements(candidate: string): void {
  if (
    candidate.length < 12 || candidate.length > 1_024 ||
    /[\u0000-\u001f\u007f]/u.test(candidate)
  ) {
    throw new Error("The password does not meet HRA's password requirements.");
  }
}
