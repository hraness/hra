/**
 * Relative and absolute time rendering for the settings screen.
 *
 * `Intl.RelativeTimeFormat` is deliberately not used: its output is locale and
 * runtime dependent, which makes the invariant tests unstable, and the settings
 * screen needs only a coarse "how long ago" for a heartbeat and a "how soon"
 * for a scheduled run. Nothing here touches React or the document, so
 * `bun test ./app` exercises it directly.
 */
export type RelativeTimeUnit = Readonly<{ many: string; milliseconds: number; one: string }>;

/** Largest unit first: the first entry the magnitude reaches is the one used. */
export const relativeTimeUnits: readonly RelativeTimeUnit[] = Object.freeze([
  { many: "days", milliseconds: 86_400_000, one: "day" },
  { many: "hours", milliseconds: 3_600_000, one: "hour" },
  { many: "minutes", milliseconds: 60_000, one: "minute" },
] as const);

/**
 * "in 3 hours", "12 minutes ago", or "just now" for anything inside a minute.
 * A non-finite input renders as "unknown" rather than throwing, because the
 * only callers are read-only rows.
 */
export function formatRelativeTime(target: number, now: number): string {
  if (!Number.isFinite(target) || !Number.isFinite(now)) return "unknown";
  const delta = target - now;
  const magnitude = Math.abs(delta);
  const unit = relativeTimeUnits.find((entry) => magnitude >= entry.milliseconds);
  if (unit === undefined) return "just now";
  const value = Math.floor(magnitude / unit.milliseconds);
  const noun = value === 1 ? unit.one : unit.many;
  return delta < 0 ? `${value} ${noun} ago` : `in ${value} ${noun}`;
}

/**
 * The UTC calendar day of a timestamp, `YYYY-MM-DD`. Used where a row wants a
 * date rather than a distance, and UTC so two readers in two time zones read
 * the same row the same way.
 */
export function formatUtcDay(timestamp: number | null): string | null {
  if (timestamp === null || !Number.isFinite(timestamp) || timestamp <= 0) return null;
  const day = new Date(timestamp).toISOString().slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/u.test(day) ? day : null;
}
