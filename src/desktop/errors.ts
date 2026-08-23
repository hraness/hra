export type DesktopFailureCode =
  | "BUNDLE_UNSUPPORTED"
  | "CAPABILITY_MISSING"
  | "GENERATION_STALE"
  | "INVALID_PROFILE"
  | "PROCESS_AMBIGUOUS"
  | "RECOVERY_REQUIRED"
  | "SIGNATURE_INVALID";

export class DesktopSwitchError extends Error {
  readonly code: DesktopFailureCode;

  constructor(code: DesktopFailureCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "DesktopSwitchError";
    this.code = code;
  }
}
