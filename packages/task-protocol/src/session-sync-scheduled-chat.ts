import { z } from "@hra-internal/schema";

import {
  SESSION_SYNC_PROTOCOL,
  positiveSyncUint64Schema,
  sessionPublicIdSchema,
  syncAesGcmNonceSchema,
  syncBootIdSchema,
  syncDeviceIdSchema,
  syncOrganizationIdSchema,
  syncOwnerUserIdSchema,
  syncSha256DigestSchema,
  syncTenantIdSchema,
  syncUint64Schema,
  syncVaultIdSchema,
  type PositiveSyncUint64,
  type SessionPublicId,
  type SyncSha256Digest,
} from "./session-sync";
import { canonicalSessionSyncJson } from "./session-sync-crypto";

export const MAX_SCHEDULED_CHAT_PROMPT_UTF8_BYTES = 32 * 1_024;
export const MAX_SCHEDULED_CHAT_RRULE_UTF8_BYTES = 512;
export const MAX_SCHEDULED_CHAT_TIME_ZONE_UTF8_BYTES = 96;
export const MAX_SCHEDULED_CHAT_DEFINITION_PLAINTEXT_BYTES = 34 * 1_024;
export const MAX_SCHEDULED_CHAT_DEFINITION_CIPHERTEXT_BYTES =
  MAX_SCHEDULED_CHAT_DEFINITION_PLAINTEXT_BYTES + 16;
/** Keeps the worst-case encrypted-definition page below the 512 KiB response bound. */
export const MAX_SCHEDULED_CHAT_RUN_PAGE_SIZE = 8;
/** Keeps the worst-case encrypted-definition inventory page below the 512 KiB response bound. */
export const MAX_SCHEDULED_CHAT_INVENTORY_PAGE_SIZE = 8;

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder("utf-8", { fatal: true });
const SCHEDULED_CHAT_DEFINITION_INFO = textEncoder.encode(
  "hra.session-sync.scheduled-chat-definition.v1",
);
const WEEKDAY_VALUES = ["MO", "TU", "WE", "TH", "FR", "SA", "SU"] as const;
const weekdayIndex = new Map<string, number>(
  WEEKDAY_VALUES.map((day, index) => [day, index]),
);

export const scheduledChatEpochMsSchema = z.number().int().nonnegative().safe();
export const scheduledChatTimeZoneSchema = z.string().min(1).refine(
  (value) => textEncoder.encode(value).byteLength <= MAX_SCHEDULED_CHAT_TIME_ZONE_UTF8_BYTES,
  "scheduled chat time zone exceeds its byte bound",
).refine(isSupportedTimeZone, "scheduled chat time zone is not supported");

export type ScheduledChatFrequency = "MINUTELY" | "HOURLY" | "DAILY" | "WEEKLY" | "MONTHLY";

interface LocalDateTime {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
  readonly second: number;
}

export interface ParsedCanonicalScheduledChatRRule {
  readonly timeZone: string;
  readonly startsAt: LocalDateTime;
  readonly frequency: ScheduledChatFrequency;
  readonly interval: number;
  readonly byDay: readonly typeof WEEKDAY_VALUES[number][];
  readonly byMonthDay: readonly number[];
}

function isSupportedTimeZone(value: string): boolean {
  if (value !== value.trim() || value.includes("\0")) return false;
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone: value })
      .resolvedOptions().timeZone === value;
  } catch {
    return false;
  }
}

function parseLocalDateTime(date: string, time: string): LocalDateTime | null {
  const value = {
    year: Number(date.slice(0, 4)),
    month: Number(date.slice(4, 6)),
    day: Number(date.slice(6, 8)),
    hour: Number(time.slice(0, 2)),
    minute: Number(time.slice(2, 4)),
    second: Number(time.slice(4, 6)),
  };
  if (
    !Number.isInteger(value.year)
    || value.year < 1970
    || value.year > 9999
    || value.month < 1
    || value.month > 12
    || value.day < 1
    || value.day > daysInMonth(value.year, value.month)
    || value.hour < 0
    || value.hour > 23
    || value.minute < 0
    || value.minute > 59
    || value.second < 0
    || value.second > 59
  ) return null;
  return value;
}

function canonicalLocalDateTime(value: LocalDateTime): string {
  const number = (input: number, width: number) => input.toString(10).padStart(width, "0");
  return `${number(value.year, 4)}${number(value.month, 2)}${number(value.day, 2)}`
    + `T${number(value.hour, 2)}${number(value.minute, 2)}${number(value.second, 2)}`;
}

export function parseCanonicalScheduledChatRRule(
  value: string,
): ParsedCanonicalScheduledChatRRule | null {
  if (
    value !== value.trim()
    || value.includes("\r")
    || textEncoder.encode(value).byteLength > MAX_SCHEDULED_CHAT_RRULE_UTF8_BYTES
  ) return null;
  const lines = value.split("\n");
  if (lines.length !== 2) return null;
  const start = /^DTSTART;TZID=([A-Za-z0-9_+\-/]+):(\d{8})T(\d{6})$/u.exec(lines[0] ?? "");
  if (start === null) return null;
  const timeZone = start[1] ?? "";
  if (!isSupportedTimeZone(timeZone)) return null;
  const startsAt = parseLocalDateTime(start[2] ?? "", start[3] ?? "");
  if (startsAt === null) return null;
  const ruleLine = lines[1] ?? "";
  if (!ruleLine.startsWith("RRULE:")) return null;
  const parts = ruleLine.slice(6).split(";");
  const properties = new Map<string, string>();
  for (const part of parts) {
    const separator = part.indexOf("=");
    if (separator <= 0 || separator === part.length - 1) return null;
    const key = part.slice(0, separator);
    const propertyValue = part.slice(separator + 1);
    if (properties.has(key)) return null;
    properties.set(key, propertyValue);
  }
  const frequencyValue = properties.get("FREQ");
  if (
    frequencyValue !== "MINUTELY"
    && frequencyValue !== "HOURLY"
    && frequencyValue !== "DAILY"
    && frequencyValue !== "WEEKLY"
    && frequencyValue !== "MONTHLY"
  ) return null;
  const intervalText = properties.get("INTERVAL");
  if (intervalText === undefined || !/^[1-9][0-9]{0,3}$/u.test(intervalText)) return null;
  const interval = Number(intervalText);
  if (!Number.isSafeInteger(interval) || interval < 1 || interval > 10_000) return null;
  const allowed = new Set(["FREQ", "INTERVAL"]);
  const byDayText = properties.get("BYDAY");
  let byDay: typeof WEEKDAY_VALUES[number][] = [];
  if (frequencyValue === "WEEKLY") {
    if (byDayText === undefined) return null;
    allowed.add("BYDAY");
    const values = byDayText.split(",");
    if (values.length < 1 || values.length > 7) return null;
    if (values.some((day) => !weekdayIndex.has(day))) return null;
    byDay = values as typeof WEEKDAY_VALUES[number][];
    if (
      new Set(byDay).size !== byDay.length
      || byDay.some((day, index) => index > 0 && (weekdayIndex.get(day) ?? -1)
        <= (weekdayIndex.get(byDay[index - 1] ?? "") ?? -1))
      || !byDay.includes(WEEKDAY_VALUES[weekdayMondayIndex(startsAt)] ?? "MO")
    ) return null;
  } else if (byDayText !== undefined) return null;
  const byMonthDayText = properties.get("BYMONTHDAY");
  let byMonthDay: number[] = [];
  if (frequencyValue === "MONTHLY") {
    if (byMonthDayText === undefined) return null;
    allowed.add("BYMONTHDAY");
    const values = byMonthDayText.split(",");
    if (values.length < 1 || values.length > 31) return null;
    if (values.some((day) => !/^[1-9][0-9]?$/u.test(day))) return null;
    byMonthDay = values.map(Number);
    if (
      byMonthDay.some((day) => day > 31)
      || new Set(byMonthDay).size !== byMonthDay.length
      || byMonthDay.some((day, index) => index > 0 && day <= (byMonthDay[index - 1] ?? 0))
      || !byMonthDay.includes(startsAt.day)
    ) return null;
  } else if (byMonthDayText !== undefined) return null;
  if ([...properties.keys()].some((key) => !allowed.has(key))) return null;
  const canonicalProperties = [
    `FREQ=${frequencyValue}`,
    `INTERVAL=${String(interval)}`,
    ...(byDay.length === 0 ? [] : [`BYDAY=${byDay.join(",")}`]),
    ...(byMonthDay.length === 0 ? [] : [`BYMONTHDAY=${byMonthDay.join(",")}`]),
  ];
  const canonical = `DTSTART;TZID=${timeZone}:${canonicalLocalDateTime(startsAt)}`
    + `\nRRULE:${canonicalProperties.join(";")}`;
  if (canonical !== value) return null;
  return { timeZone, startsAt, frequency: frequencyValue, interval, byDay, byMonthDay };
}

export const canonicalScheduledChatRRuleSchema = z.string().min(1).refine(
  (value) => parseCanonicalScheduledChatRRule(value) !== null,
  "scheduled chat RRULE is not in the supported canonical form",
);

export const scheduledChatScheduleSchema = z.object({
  generation: positiveSyncUint64Schema,
  rrule: canonicalScheduledChatRRuleSchema,
  timeZone: scheduledChatTimeZoneSchema,
  nextRunAt: scheduledChatEpochMsSchema,
}).strict().superRefine((schedule, context) => {
  const parsed = parseCanonicalScheduledChatRRule(schedule.rrule);
  if (parsed?.timeZone !== schedule.timeZone) {
    context.addIssue({
      code: "custom",
      message: "scheduled chat RRULE and time zone do not match",
      path: ["timeZone"],
    });
  }
});
export type ScheduledChatSchedule = z.infer<typeof scheduledChatScheduleSchema>;

const scheduledChatPromptSchema = z.string().min(1).refine(
  (value) => value.trim().length > 0
    && !value.includes("\0")
    && textEncoder.encode(value).byteLength <= MAX_SCHEDULED_CHAT_PROMPT_UTF8_BYTES,
  "scheduled chat prompt is invalid",
);

export const scheduledChatDefinitionSchema = z.object({
  version: z.literal(1),
  sessionId: sessionPublicIdSchema,
  generation: positiveSyncUint64Schema,
  rrule: canonicalScheduledChatRRuleSchema,
  timeZone: scheduledChatTimeZoneSchema,
  prompt: scheduledChatPromptSchema,
}).strict().superRefine((definition, context) => {
  const parsed = parseCanonicalScheduledChatRRule(definition.rrule);
  if (parsed?.timeZone !== definition.timeZone) {
    context.addIssue({
      code: "custom",
      message: "scheduled chat definition RRULE and time zone do not match",
      path: ["timeZone"],
    });
  }
});
export type ScheduledChatDefinition = z.infer<typeof scheduledChatDefinitionSchema>;

export const scheduledChatDefinitionHeaderSchema = z.object({
  protocol: z.literal(SESSION_SYNC_PROTOCOL),
  payloadKind: z.literal("scheduled_chat_definition"),
  payloadVersion: z.literal(1),
  tenantId: syncTenantIdSchema,
  organizationId: syncOrganizationIdSchema,
  ownerUserId: syncOwnerUserIdSchema,
  vaultId: syncVaultIdSchema,
  vaultGeneration: positiveSyncUint64Schema,
  membershipEpoch: positiveSyncUint64Schema,
  originDeviceId: syncDeviceIdSchema,
  sessionId: sessionPublicIdSchema,
  mirrorEpoch: positiveSyncUint64Schema,
  writerGeneration: positiveSyncUint64Schema,
  bootId: syncBootIdSchema,
  bootGeneration: positiveSyncUint64Schema,
  keyEpoch: positiveSyncUint64Schema,
  previousGeneration: syncUint64Schema,
  generation: positiveSyncUint64Schema,
  rrule: canonicalScheduledChatRRuleSchema,
  timeZone: scheduledChatTimeZoneSchema,
}).strict().superRefine((header, context) => {
  const parsed = parseCanonicalScheduledChatRRule(header.rrule);
  if (parsed?.timeZone !== header.timeZone) {
    context.addIssue({
      code: "custom",
      message: "scheduled chat header RRULE and time zone do not match",
      path: ["timeZone"],
    });
  }
  if (BigInt(header.generation) !== BigInt(header.previousGeneration) + 1n) {
    context.addIssue({
      code: "custom",
      message: "scheduled chat generation must advance exactly once",
      path: ["generation"],
    });
  }
});
export type ScheduledChatDefinitionHeader = z.infer<
  typeof scheduledChatDefinitionHeaderSchema
>;

const scheduledChatCiphertextSchema = z.string()
  .min(23)
  .max(Math.ceil(MAX_SCHEDULED_CHAT_DEFINITION_CIPHERTEXT_BYTES * 4 / 3))
  .regex(/^[A-Za-z0-9_-]+$/u);

export const sealedScheduledChatDefinitionSchema = z.object({
  header: scheduledChatDefinitionHeaderSchema,
  algorithm: z.literal("HKDF-SHA256-A256GCM"),
  nonce: syncAesGcmNonceSchema,
  ciphertext: scheduledChatCiphertextSchema,
  ciphertextBytes: z.number().int().min(17)
    .max(MAX_SCHEDULED_CHAT_DEFINITION_CIPHERTEXT_BYTES),
  ciphertextDigest: syncSha256DigestSchema,
}).strict().superRefine((envelope, context) => {
  if (base64UrlDecode(envelope.ciphertext).byteLength !== envelope.ciphertextBytes) {
    context.addIssue({
      code: "custom",
      message: "scheduled chat ciphertext byte count does not match",
      path: ["ciphertextBytes"],
    });
  }
});
export type SealedScheduledChatDefinition = z.infer<
  typeof sealedScheduledChatDefinitionSchema
>;

export const scheduledChatRunIdSchema = z.string()
  .regex(/^syncrun_[0-9A-HJKMNP-TV-Z]{26}$/u, "invalid scheduled chat run ID");
export type ScheduledChatRunId = z.infer<typeof scheduledChatRunIdSchema>;

export const scheduledChatRunSchema = z.object({
  runId: scheduledChatRunIdSchema,
  sessionId: sessionPublicIdSchema,
  scheduleGeneration: positiveSyncUint64Schema,
  occurrenceSequence: positiveSyncUint64Schema,
  scheduledFor: scheduledChatEpochMsSchema,
  definition: sealedScheduledChatDefinitionSchema,
}).strict().superRefine((run, context) => {
  if (
    run.definition.header.sessionId !== run.sessionId
    || run.definition.header.generation !== run.scheduleGeneration
  ) {
    context.addIssue({
      code: "custom",
      message: "scheduled chat run does not match its sealed definition",
      path: ["definition"],
    });
  }
});
export type ScheduledChatRun = z.infer<typeof scheduledChatRunSchema>;

function dateTimeParts(epochMs: number, timeZone: string): LocalDateTime {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    calendar: "gregory",
    numberingSystem: "latn",
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const parts = new Map(formatter.formatToParts(epochMs).map((part) => [part.type, part.value]));
  return {
    year: Number(parts.get("year")),
    month: Number(parts.get("month")),
    day: Number(parts.get("day")),
    hour: Number(parts.get("hour")),
    minute: Number(parts.get("minute")),
    second: Number(parts.get("second")),
  };
}

function localSerialDay(value: Pick<LocalDateTime, "year" | "month" | "day">): number {
  return Math.floor(Date.UTC(value.year, value.month - 1, value.day) / 86_400_000);
}

function localFromSerialDay(serial: number, time: LocalDateTime): LocalDateTime {
  const date = new Date(serial * 86_400_000);
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
    hour: time.hour,
    minute: time.minute,
    second: time.second,
  };
}

function instantForLocalDateTime(value: LocalDateTime, timeZone: string): number | null {
  const desired = Date.UTC(
    value.year,
    value.month - 1,
    value.day,
    value.hour,
    value.minute,
    value.second,
  );
  let candidate = desired;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const actual = dateTimeParts(candidate, timeZone);
    const actualAsUtc = Date.UTC(
      actual.year,
      actual.month - 1,
      actual.day,
      actual.hour,
      actual.minute,
      actual.second,
    );
    const delta = desired - actualAsUtc;
    if (delta === 0) return candidate;
    candidate += delta;
  }
  const actual = dateTimeParts(candidate, timeZone);
  return canonicalLocalDateTime(actual) === canonicalLocalDateTime(value)
    ? candidate
    : null;
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function monthCoordinates(index: number): Readonly<{ year: number; month: number }> {
  const year = Math.floor(index / 12);
  return { year, month: index - year * 12 + 1 };
}

function nextCalendarOccurrence(
  rule: ParsedCanonicalScheduledChatRRule,
  after: number,
): number | null {
  const afterLocal = dateTimeParts(after, rule.timeZone);
  const startDay = localSerialDay(rule.startsAt);
  const afterDay = localSerialDay(afterLocal);
  if (rule.frequency === "DAILY") {
    let step = Math.max(0, Math.floor((afterDay - startDay) / rule.interval));
    for (let attempt = 0; attempt < 10_000; attempt += 1, step += 1) {
      const local = localFromSerialDay(startDay + step * rule.interval, rule.startsAt);
      const instant = instantForLocalDateTime(local, rule.timeZone);
      if (instant !== null && instant > after) return instant;
    }
    return null;
  }
  if (rule.frequency === "WEEKLY") {
    const startWeek = startDay - weekdayMondayIndex(rule.startsAt);
    const afterWeek = afterDay - weekdayMondayIndex(afterLocal);
    let weekStep = Math.max(0, Math.floor((afterWeek - startWeek) / (7 * rule.interval)));
    for (let attempt = 0; attempt < 10_000; attempt += 1, weekStep += 1) {
      const week = startWeek + weekStep * 7 * rule.interval;
      for (const day of rule.byDay) {
        const local = localFromSerialDay(week + (weekdayIndex.get(day) ?? 0), rule.startsAt);
        if (localSerialDay(local) < startDay) continue;
        const instant = instantForLocalDateTime(local, rule.timeZone);
        if (instant !== null && instant > after) return instant;
      }
    }
    return null;
  }
  const startMonth = rule.startsAt.year * 12 + rule.startsAt.month - 1;
  const afterMonth = afterLocal.year * 12 + afterLocal.month - 1;
  let monthStep = Math.max(0, Math.floor((afterMonth - startMonth) / rule.interval));
  for (let attempt = 0; attempt < 10_000; attempt += 1, monthStep += 1) {
    const coordinates = monthCoordinates(startMonth + monthStep * rule.interval);
    for (const day of rule.byMonthDay) {
      if (day > daysInMonth(coordinates.year, coordinates.month)) continue;
      const local = { ...rule.startsAt, ...coordinates, day };
      if (localSerialDay(local) < startDay) continue;
      const instant = instantForLocalDateTime(local, rule.timeZone);
      if (instant !== null && instant > after) return instant;
    }
  }
  return null;
}

function weekdayMondayIndex(value: Pick<LocalDateTime, "year" | "month" | "day">): number {
  const sundayIndex = new Date(Date.UTC(value.year, value.month - 1, value.day)).getUTCDay();
  return (sundayIndex + 6) % 7;
}

export function nextScheduledChatOccurrence(input: Readonly<{
  rrule: string;
  timeZone: string;
  after: number;
}>): number | null {
  const after = scheduledChatEpochMsSchema.parse(input.after);
  const timeZone = scheduledChatTimeZoneSchema.parse(input.timeZone);
  const rule = parseCanonicalScheduledChatRRule(input.rrule);
  if (rule === null || rule.timeZone !== timeZone) return null;
  const first = instantForLocalDateTime(rule.startsAt, timeZone);
  if (first === null) return null;
  if (rule.frequency === "MINUTELY" || rule.frequency === "HOURLY") {
    const unit = rule.frequency === "MINUTELY" ? 60_000 : 3_600_000;
    if (first > after) return first;
    const interval = unit * rule.interval;
    const steps = Math.floor((after - first) / interval) + 1;
    const result = first + steps * interval;
    return Number.isSafeInteger(result) ? result : null;
  }
  if (first > after) return first;
  return nextCalendarOccurrence(rule, after);
}

function base64UrlEncode(value: Uint8Array): string {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function base64UrlDecode(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/u.test(value) || value.length % 4 === 1) {
    throw new TypeError("invalid scheduled chat base64url value");
  }
  const padded = value.replaceAll("-", "+").replaceAll("_", "/")
    + "=".repeat((4 - value.length % 4) % 4);
  let binary: string;
  try {
    binary = atob(padded);
  } catch {
    throw new TypeError("invalid scheduled chat base64url value");
  }
  const decoded = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  if (base64UrlEncode(decoded) !== value) {
    throw new TypeError("scheduled chat base64url value is not canonical");
  }
  return decoded;
}

function ownedBuffer(value: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(value.byteLength);
  copy.set(value);
  return copy.buffer;
}

async function digest(value: Uint8Array): Promise<SyncSha256Digest> {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", ownedBuffer(value)));
  return syncSha256DigestSchema.parse(
    `sha256_${[...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`,
  );
}

function definitionAad(header: ScheduledChatDefinitionHeader): Uint8Array {
  return textEncoder.encode(canonicalSessionSyncJson({
    protocol: SESSION_SYNC_PROTOCOL,
    algorithm: "HKDF-SHA256-A256GCM",
    header,
  }));
}

async function scheduledChatDefinitionKey(
  rootKey: Uint8Array,
  header: ScheduledChatDefinitionHeader,
  usages: readonly ("encrypt" | "decrypt")[],
): Promise<CryptoKey> {
  if (rootKey.byteLength !== 32) throw new TypeError("session sync vault root must contain 32 bytes");
  const context = textEncoder.encode(canonicalSessionSyncJson({
    protocol: SESSION_SYNC_PROTOCOL,
    purpose: "scheduled_chat_definition_key",
    tenantId: header.tenantId,
    organizationId: header.organizationId,
    ownerUserId: header.ownerUserId,
    vaultId: header.vaultId,
    vaultGeneration: header.vaultGeneration,
    sessionId: header.sessionId,
    originDeviceId: header.originDeviceId,
    keyEpoch: header.keyEpoch,
    generation: header.generation,
  }));
  const salt = await crypto.subtle.digest("SHA-256", ownedBuffer(context));
  const material = await crypto.subtle.importKey(
    "raw",
    ownedBuffer(rootKey),
    "HKDF",
    false,
    ["deriveKey"],
  );
  return await crypto.subtle.deriveKey({
    name: "HKDF",
    hash: "SHA-256",
    salt,
    info: ownedBuffer(SCHEDULED_CHAT_DEFINITION_INFO),
  }, material, { name: "AES-GCM", length: 256 }, false, [...usages]);
}

export async function sealScheduledChatDefinition(input: Readonly<{
  definition: ScheduledChatDefinition;
  header: ScheduledChatDefinitionHeader;
  rootKey: Uint8Array;
  nonce?: Uint8Array;
}>): Promise<SealedScheduledChatDefinition> {
  const definition = scheduledChatDefinitionSchema.parse(input.definition);
  const header = scheduledChatDefinitionHeaderSchema.parse(input.header);
  if (
    definition.sessionId !== header.sessionId
    || definition.generation !== header.generation
    || definition.rrule !== header.rrule
    || definition.timeZone !== header.timeZone
  ) throw new TypeError("scheduled chat definition does not match its authenticated header");
  const plaintext = textEncoder.encode(canonicalSessionSyncJson(definition));
  if (plaintext.byteLength > MAX_SCHEDULED_CHAT_DEFINITION_PLAINTEXT_BYTES) {
    plaintext.fill(0);
    throw new RangeError("scheduled chat definition exceeds its plaintext bound");
  }
  const nonceBytes = input.nonce === undefined
    ? crypto.getRandomValues(new Uint8Array(12))
    : Uint8Array.from(input.nonce);
  if (nonceBytes.byteLength !== 12) throw new TypeError("scheduled chat nonce must contain 12 bytes");
  try {
    const key = await scheduledChatDefinitionKey(input.rootKey, header, ["encrypt"]);
    const ciphertext = new Uint8Array(await crypto.subtle.encrypt({
      name: "AES-GCM",
      iv: ownedBuffer(nonceBytes),
      additionalData: ownedBuffer(definitionAad(header)),
      tagLength: 128,
    }, key, ownedBuffer(plaintext)));
    return sealedScheduledChatDefinitionSchema.parse({
      header,
      algorithm: "HKDF-SHA256-A256GCM",
      nonce: base64UrlEncode(nonceBytes),
      ciphertext: base64UrlEncode(ciphertext),
      ciphertextBytes: ciphertext.byteLength,
      ciphertextDigest: await digest(ciphertext),
    });
  } finally {
    plaintext.fill(0);
  }
}

export async function openScheduledChatDefinition(input: Readonly<{
  envelope: SealedScheduledChatDefinition;
  expectedHeader: ScheduledChatDefinitionHeader;
  rootKey: Uint8Array;
}>): Promise<ScheduledChatDefinition> {
  const envelope = sealedScheduledChatDefinitionSchema.parse(input.envelope);
  const expectedHeader = scheduledChatDefinitionHeaderSchema.parse(input.expectedHeader);
  if (canonicalSessionSyncJson(envelope.header) !== canonicalSessionSyncJson(expectedHeader)) {
    throw new TypeError("scheduled chat definition has the wrong authority coordinates");
  }
  const ciphertext = base64UrlDecode(envelope.ciphertext);
  if (envelope.ciphertextDigest !== await digest(ciphertext)) {
    throw new TypeError("scheduled chat definition digest does not match");
  }
  const key = await scheduledChatDefinitionKey(input.rootKey, expectedHeader, ["decrypt"]);
  let plaintext: Uint8Array;
  try {
    plaintext = new Uint8Array(await crypto.subtle.decrypt({
      name: "AES-GCM",
      iv: ownedBuffer(base64UrlDecode(envelope.nonce)),
      additionalData: ownedBuffer(definitionAad(expectedHeader)),
      tagLength: 128,
    }, key, ownedBuffer(ciphertext)));
  } catch {
    throw new TypeError("scheduled chat definition authentication failed");
  }
  try {
    if (plaintext.byteLength > MAX_SCHEDULED_CHAT_DEFINITION_PLAINTEXT_BYTES) {
      throw new RangeError("scheduled chat definition exceeds its plaintext bound");
    }
    const text = textDecoder.decode(plaintext);
    const definition = scheduledChatDefinitionSchema.parse(JSON.parse(text) as unknown);
    if (canonicalSessionSyncJson(definition) !== text) {
      throw new TypeError("scheduled chat definition is not canonical JSON");
    }
    return definition;
  } finally {
    plaintext.fill(0);
  }
}

export async function hasValidScheduledChatCiphertextDigest(
  envelopeValue: SealedScheduledChatDefinition,
): Promise<boolean> {
  try {
    const envelope = sealedScheduledChatDefinitionSchema.parse(envelopeValue);
    return envelope.ciphertextDigest === await digest(base64UrlDecode(envelope.ciphertext));
  } catch {
    return false;
  }
}

export type ScheduledChatDefinitionCoordinates = Readonly<{
  sessionId: SessionPublicId;
  generation: PositiveSyncUint64;
}>;
