import { z } from "@hra-internal/schema";

const diagnosticMethodSchema = z
  .string()
  .min(1)
  .max(160)
  .regex(/^[A-Za-z0-9_./:-]+$/u);

export interface RedactedCompatibilityDiagnostic {
  readonly category: "unknownNotification" | "unknownServerRequest" | "invalidPayload";
  readonly method: string;
  readonly processGeneration: number;
}

export function compatibilityDiagnostic(
  category: RedactedCompatibilityDiagnostic["category"],
  method: unknown,
  processGeneration: number,
): RedactedCompatibilityDiagnostic {
  return {
    category,
    method: diagnosticMethodSchema.safeParse(method).success ? String(method) : "<invalid-method>",
    processGeneration: Number.isSafeInteger(processGeneration) && processGeneration >= 0 ? processGeneration : 0,
  };
}

export function publicFailureMessage(error: unknown): string {
  if (error instanceof Error) {
    switch (error.name) {
      case "AbortError":
        return "The operation was cancelled.";
      case "AppServerFaultError":
        return "The local coding runtime stopped.";
      default:
        return "The operation failed.";
    }
  }
  return "The operation failed.";
}
