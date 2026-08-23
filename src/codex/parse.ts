import { CodexError } from "./errors.ts";

export type UnknownRecord = Record<string, unknown>;

export function record(value: unknown, label: string): UnknownRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw protocol(`${label} must be an object`);
  }
  return value as UnknownRecord;
}

export function string(
  value: unknown,
  label: string,
  options: { readonly min?: number; readonly max?: number } = {},
): string {
  const min = options.min ?? 0;
  const max = options.max ?? 16_384;
  if (typeof value !== "string" || value.length < min || value.length > max) {
    throw protocol(`${label} must be a bounded string`);
  }
  return value;
}

export function nullableString(value: unknown, label: string, max = 16_384): string | null {
  return value === null ? null : string(value, label, { max });
}

export function boolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw protocol(`${label} must be a boolean`);
  return value;
}

export function number(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw protocol(`${label} must be a finite number`);
  }
  return value;
}

export function safeInteger(value: unknown, label: string): number {
  const parsed = number(value, label);
  if (!Number.isSafeInteger(parsed)) throw protocol(`${label} must be a safe integer`);
  return parsed;
}

export function optional<T>(
  value: unknown,
  parser: (value: unknown) => T,
): T | undefined {
  return value === undefined ? undefined : parser(value);
}

export function nullable<T>(value: unknown, parser: (value: unknown) => T): T | null {
  return value === null ? null : parser(value);
}

export function array<T>(
  value: unknown,
  label: string,
  parser: (value: unknown, index: number) => T,
  max = 1_000,
): readonly T[] {
  if (!Array.isArray(value) || value.length > max) {
    throw protocol(`${label} must be a bounded array`);
  }
  return value.map(parser);
}

export function oneOf<const T extends readonly string[]>(
  value: unknown,
  label: string,
  allowed: T,
): T[number] {
  if (typeof value !== "string" || !allowed.includes(value)) {
    throw protocol(`${label} has an unsupported value`);
  }
  return value;
}

export function cursor(value: unknown, label: string): string | null {
  return nullableString(value, label, 8_192);
}

export function identifier(value: unknown, label: string): string {
  const parsed = string(value, label, { min: 1, max: 512 });
  if (/\p{Cc}/u.test(parsed)) throw protocol(`${label} contains control characters`);
  return parsed;
}

export function protocol(message: string): CodexError {
  return new CodexError("PROTOCOL_ERROR", message);
}
