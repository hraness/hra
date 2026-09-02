// Total guards over foreign values. Every parser that narrows an `unknown`
// object shape starts here so the checks stay identical across boundaries.

export function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  try {
    const prototype: unknown = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  } catch {
    return false;
  }
}

export function hasExactKeys(
  value: Readonly<Record<string, unknown>>,
  expected: readonly string[],
): boolean {
  try {
    const keys = Reflect.ownKeys(value);
    return keys.length === expected.length
      && keys.every((key) => typeof key === "string" && expected.includes(key));
  } catch {
    return false;
  }
}

export function assertNever(value: never): never {
  throw new Error(`Unexpected closed-union value: ${String(value)}`);
}
