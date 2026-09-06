/**
 * Browser-safe notification-hours wire contract.
 *
 * Keep this module dependency-free: encrypted cloud payloads are shared with
 * the Vite app, while the richer Zod schemas in `notification-hours.ts` are a
 * daemon and CLI concern.
 */

export type NotificationHoursUpdate = Readonly<{
  endMinute: number;
  startMinute: number;
  timeZone: string;
  version: 1;
}>;

export type NotificationHoursPolicy = NotificationHoursUpdate & Readonly<{
  revision: number;
}>;

export type NotificationHoursContractIssue = Readonly<{
  message: string;
  path: readonly (number | string)[];
}>;

export type NotificationHoursParseResult<T> =
  | Readonly<{ data: T; success: true }>
  | Readonly<{ issues: readonly NotificationHoursContractIssue[]; success: false }>;

const timeZonePattern =
  /^(?![+-]\d{2}:?\d{2}$)[a-z0-9._+-]+(?:\/[a-z0-9._+-]+)*$/iu;

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(
  value: Readonly<Record<string, unknown>>,
  expected: readonly string[],
): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length
    && actual.every((key, index) => key === wanted[index]);
}

function parseMinute(value: unknown): number | null {
  return Number.isInteger(value) && (value as number) >= 0 && (value as number) <= 1_439
    ? value as number
    : null;
}

function issue(
  path: readonly (number | string)[],
  message: string,
): NotificationHoursContractIssue {
  return { message, path };
}

export function parseNotificationTimeZone(value: unknown): string | null {
  if (
    typeof value !== "string"
    || value.length < 1
    || value.length > 255
    || !timeZonePattern.test(value)
  ) return null;
  try {
    const canonical = new Intl.DateTimeFormat("en-US", { timeZone: value })
      .resolvedOptions().timeZone;
    return canonical.length >= 1
      && canonical.length <= 255
      && timeZonePattern.test(canonical)
      ? canonical
      : null;
  } catch {
    return null;
  }
}

export function parseNotificationHoursUpdateResult(
  value: unknown,
): NotificationHoursParseResult<NotificationHoursUpdate> {
  if (!isRecord(value)) {
    return { issues: [issue([], "Notification hours must be an object.")], success: false };
  }
  const issues: NotificationHoursContractIssue[] = [];
  if (!hasExactKeys(value, ["endMinute", "startMinute", "timeZone", "version"])) {
    issues.push(issue([], "Notification hours contain unrecognized or missing fields."));
  }
  if (value.version !== 1) {
    issues.push(issue(["version"], "Notification hours version must be 1."));
  }
  const startMinute = parseMinute(value.startMinute);
  const endMinute = parseMinute(value.endMinute);
  const timeZone = parseNotificationTimeZone(value.timeZone);
  if (startMinute === null) {
    issues.push(issue(["startMinute"], "Start minute must be an integer from 0 through 1439."));
  }
  if (endMinute === null) {
    issues.push(issue(["endMinute"], "End minute must be an integer from 0 through 1439."));
  }
  if (timeZone === null) {
    issues.push(issue(["timeZone"], "Time zone must be a supported IANA identifier."));
  }
  if (startMinute !== null && endMinute !== null && startMinute === endMinute) {
    issues.push(issue(
      ["endMinute"],
      "Notification hours must cover a nonempty wall-clock range.",
    ));
  }
  return issues.length > 0
    ? { issues, success: false }
    : {
        data: {
          endMinute: endMinute as number,
          startMinute: startMinute as number,
          timeZone: timeZone as string,
          version: 1,
        },
        success: true,
      };
}

export function parseNotificationHoursUpdate(value: unknown): NotificationHoursUpdate | null {
  const result = parseNotificationHoursUpdateResult(value);
  return result.success ? result.data : null;
}

export function parseNotificationHoursPolicyResult(
  value: unknown,
): NotificationHoursParseResult<NotificationHoursPolicy> {
  if (!isRecord(value)) {
    return { issues: [issue([], "Notification hours must be an object.")], success: false };
  }
  const issues: NotificationHoursContractIssue[] = [];
  if (!hasExactKeys(value, [
      "endMinute",
      "revision",
      "startMinute",
      "timeZone",
      "version",
    ])) {
    issues.push(issue([], "Notification hours contain unrecognized or missing fields."));
  }
  const updateResult = parseNotificationHoursUpdateResult({
    endMinute: value.endMinute,
    startMinute: value.startMinute,
    timeZone: value.timeZone,
    version: value.version,
  });
  if (!updateResult.success) issues.push(...updateResult.issues);
  if (!Number.isSafeInteger(value.revision) || (value.revision as number) < 1) {
    issues.push(issue(["revision"], "Revision must be a positive safe integer."));
  }
  return issues.length > 0 || !updateResult.success
    ? { issues, success: false }
    : {
        data: { ...updateResult.data, revision: value.revision as number },
        success: true,
      };
}

export function parseNotificationHoursPolicy(value: unknown): NotificationHoursPolicy | null {
  const result = parseNotificationHoursPolicyResult(value);
  return result.success ? result.data : null;
}
