import { z } from "zod";

import {
  parseNotificationHoursPolicyResult,
  parseNotificationHoursUpdateResult,
  parseNotificationTimeZone,
  type NotificationHoursParseResult,
  type NotificationHoursPolicy,
  type NotificationHoursUpdate,
} from "./notification-hours-contract";

export type { NotificationHoursPolicy, NotificationHoursUpdate };

const maximumDateEpochMilliseconds = 8_640_000_000_000_000;

function parsedSchema<T>(
  parser: (value: unknown) => NotificationHoursParseResult<T>,
) {
  return z.unknown().transform((value, context): T => {
    const result = parser(value);
    if (result.success) return result.data;
    for (const contractIssue of result.issues) {
      context.addIssue({
        code: "custom",
        message: contractIssue.message,
        path: [...contractIssue.path],
      });
    }
    return z.NEVER;
  });
}

export const notificationHoursUpdateSchema = parsedSchema(
  parseNotificationHoursUpdateResult,
);

export const notificationHoursPolicySchema = parsedSchema(
  parseNotificationHoursPolicyResult,
);

export const canonicalizeNotificationTimeZone = (value: unknown): string => {
  const parsed = parseNotificationTimeZone(value);
  if (parsed === null) throw new Error("Invalid notification hours time zone.");
  return parsed;
};

const notificationEpochMillisecondsSchema = z.number()
  .int()
  .nonnegative()
  .max(maximumDateEpochMilliseconds);

const localMinuteOfDay = (
  epochMilliseconds: number,
  timeZone: string,
  formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }),
): number => {
  const parts = formatter.formatToParts(new Date(epochMilliseconds));
  const hour = Number(parts.find((part) => part.type === "hour")?.value);
  const minute = Number(parts.find((part) => part.type === "minute")?.value);
  if (
    !Number.isInteger(hour)
    || hour < 0
    || hour > 23
    || !Number.isInteger(minute)
    || minute < 0
    || minute > 59
  ) throw new Error("NOTIFICATION_HOURS_LOCAL_TIME_INVALID");
  return hour * 60 + minute;
};

const minuteIsWithinNotificationHours = (
  policy: NotificationHoursPolicy,
  minute: number,
): boolean => policy.startMinute < policy.endMinute
  ? minute >= policy.startMinute && minute < policy.endMinute
  : minute >= policy.startMinute || minute < policy.endMinute;

/**
 * Evaluates one epoch instant against the policy's persisted wall-clock zone.
 * Start is inclusive and end is exclusive; a start after end spans midnight.
 */
export const isWithinNotificationHours = (
  policy: unknown,
  epochMilliseconds: unknown,
): boolean => {
  const parsedPolicy = notificationHoursPolicySchema.parse(policy);
  const parsedEpochMilliseconds = notificationEpochMillisecondsSchema
    .parse(epochMilliseconds);
  const minute = localMinuteOfDay(
    parsedEpochMilliseconds,
    parsedPolicy.timeZone,
  );
  return minuteIsWithinNotificationHours(parsedPolicy, minute);
};

const notificationWindowSearchMinutes = 48 * 60;
const millisecondsPerMinute = 60_000;

/**
 * Returns the first absolute minute boundary after an admitted instant whose
 * local wall time is outside the policy. Scanning absolute minute boundaries
 * preserves skipped and repeated local times across IANA zone transitions.
 * An instant outside notification hours has no current allowed window.
 */
export const notificationHoursAllowedWindowEnd = (
  policy: unknown,
  epochMilliseconds: unknown,
): number | null => {
  const parsedPolicy = notificationHoursPolicySchema.parse(policy);
  const parsedEpochMilliseconds = notificationEpochMillisecondsSchema
    .parse(epochMilliseconds);
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: parsedPolicy.timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  if (!minuteIsWithinNotificationHours(
    parsedPolicy,
    localMinuteOfDay(parsedEpochMilliseconds, parsedPolicy.timeZone, formatter),
  )) return null;

  const firstBoundary = Math.floor(
    parsedEpochMilliseconds / millisecondsPerMinute,
  ) * millisecondsPerMinute + millisecondsPerMinute;
  for (let offset = 0; offset < notificationWindowSearchMinutes; offset += 1) {
    const candidate = firstBoundary + offset * millisecondsPerMinute;
    if (
      candidate > maximumDateEpochMilliseconds
      || !Number.isSafeInteger(candidate)
    ) throw new Error("NOTIFICATION_HOURS_WINDOW_END_UNRESOLVED");
    if (!minuteIsWithinNotificationHours(
      parsedPolicy,
      localMinuteOfDay(candidate, parsedPolicy.timeZone, formatter),
    )) return candidate;
  }
  throw new Error("NOTIFICATION_HOURS_WINDOW_END_UNRESOLVED");
};
