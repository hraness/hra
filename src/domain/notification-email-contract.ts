/**
 * Browser-safe local attention-email opt-in contract.
 *
 * Keep this module dependency-free. The daemon owns the setting today, while
 * later encrypted projections may share this exact parser with the web app.
 */

export type NotificationEmailPolicy = Readonly<{
  enabled: boolean;
  revision: number;
  version: 1;
}>;

export type NotificationEmailContractIssue = Readonly<{
  message: string;
  path: readonly (number | string)[];
}>;

export type NotificationEmailParseResult =
  | Readonly<{ data: NotificationEmailPolicy; success: true }>
  | Readonly<{ issues: readonly NotificationEmailContractIssue[]; success: false }>;

const rejected = (
  path: readonly (number | string)[],
  message: string,
): NotificationEmailParseResult => ({
  issues: [{ message, path }],
  success: false,
});

function snapshotPolicy(value: unknown): Readonly<Record<string, unknown>> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  try {
    const prototype: unknown = Reflect.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return null;
    const keys = Reflect.ownKeys(value);
    const expected = ["enabled", "revision", "version"] as const;
    if (
      keys.length !== expected.length
      || keys.some((key) =>
        key !== "enabled" && key !== "revision" && key !== "version")
    ) return null;
    const snapshot = Object.create(null) as Record<string, unknown>;
    for (const key of expected) {
      const descriptor = Reflect.getOwnPropertyDescriptor(value, key);
      if (
        descriptor === undefined
        || !("value" in descriptor)
        || descriptor.enumerable !== true
      ) return null;
      Object.defineProperty(snapshot, key, {
        configurable: true,
        enumerable: true,
        value: descriptor.value,
        writable: true,
      });
    }
    return snapshot;
  } catch {
    return null;
  }
}

export function parseNotificationEmailPolicyResult(
  value: unknown,
): NotificationEmailParseResult {
  const snapshot = snapshotPolicy(value);
  if (snapshot === null) {
    return rejected(
      [],
      "Notification email policy must be a plain object with exactly enabled, revision, and version.",
    );
  }
  const issues: NotificationEmailContractIssue[] = [];
  if (snapshot.version !== 1) {
    issues.push({ message: "Notification email policy version must be 1.", path: ["version"] });
  }
  if (typeof snapshot.enabled !== "boolean") {
    issues.push({ message: "Notification email enabled must be a boolean.", path: ["enabled"] });
  }
  if (!Number.isSafeInteger(snapshot.revision) || (snapshot.revision as number) < 1) {
    issues.push({ message: "Revision must be a positive safe integer.", path: ["revision"] });
  }
  if (issues.length > 0) return { issues, success: false };
  return {
    data: {
      enabled: snapshot.enabled as boolean,
      revision: snapshot.revision as number,
      version: 1,
    },
    success: true,
  };
}

export function parseNotificationEmailPolicy(
  value: unknown,
): NotificationEmailPolicy | null {
  const result = parseNotificationEmailPolicyResult(value);
  return result.success ? result.data : null;
}
