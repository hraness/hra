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

export type ForeignJsonSnapshotResult =
  | Readonly<{ ok: true; value: unknown }>
  | Readonly<{ ok: false }>;

const foreignJsonSnapshotLimits = Object.freeze({
  arrayLength: 512,
  depth: 16,
  nodes: 100_000,
  objectKeys: 512,
  stringCharacters: 350_000,
  totalStringCharacters: 1_000_000,
} as const);

const snapshotFailure = Symbol("foreign-json-snapshot-failure");

/**
 * Copy an untrusted JSON-shaped value without invoking any accessor.
 *
 * Public parsers use the returned plain data instead of reading a foreign
 * object once while validating it and again while constructing the result.
 * Accessors, exotic prototypes, cycles, aliases, sparse arrays, symbols, and
 * non-enumerable object fields are rejected. The bounds also keep a direct
 * caller from presenting a graph much larger than any encrypted wire payload.
 */
export function snapshotForeignJson(value: unknown): ForeignJsonSnapshotResult {
  let nodes = 0;
  let totalStringCharacters = 0;
  const seen = new WeakSet<object>();

  function snapshot(candidate: unknown, depth: number): unknown {
    nodes += 1;
    if (nodes > foreignJsonSnapshotLimits.nodes || depth > foreignJsonSnapshotLimits.depth) {
      return snapshotFailure;
    }
    if (candidate === null || typeof candidate === "boolean") return candidate;
    if (typeof candidate === "number") {
      return Number.isFinite(candidate) ? candidate : snapshotFailure;
    }
    if (typeof candidate === "string") {
      totalStringCharacters += candidate.length;
      return candidate.length <= foreignJsonSnapshotLimits.stringCharacters
        && totalStringCharacters <= foreignJsonSnapshotLimits.totalStringCharacters
        ? candidate
        : snapshotFailure;
    }
    if (typeof candidate !== "object" || seen.has(candidate)) return snapshotFailure;
    seen.add(candidate);

    if (Array.isArray(candidate)) {
      if (Reflect.getPrototypeOf(candidate) !== Array.prototype) return snapshotFailure;
      const keys = Reflect.ownKeys(candidate);
      const lengthDescriptor = Reflect.getOwnPropertyDescriptor(candidate, "length");
      const arrayLength = lengthDescriptor?.value;
      if (
        lengthDescriptor === undefined
        || !("value" in lengthDescriptor)
        || typeof arrayLength !== "number"
        || !Number.isSafeInteger(arrayLength)
        || arrayLength < 0
        || arrayLength > foreignJsonSnapshotLimits.arrayLength
        || keys.length !== arrayLength + 1
      ) return snapshotFailure;
      const copied: unknown[] = [];
      for (let index = 0; index < arrayLength; index += 1) {
        const descriptor = Reflect.getOwnPropertyDescriptor(candidate, String(index));
        if (descriptor === undefined || !("value" in descriptor) || descriptor.enumerable !== true) {
          return snapshotFailure;
        }
        const entry = snapshot(descriptor.value, depth + 1);
        if (entry === snapshotFailure) return snapshotFailure;
        copied.push(entry);
      }
      return copied;
    }

    const prototype = Reflect.getPrototypeOf(candidate);
    if (prototype !== Object.prototype && prototype !== null) return snapshotFailure;
    const keys = Reflect.ownKeys(candidate);
    if (keys.length > foreignJsonSnapshotLimits.objectKeys) return snapshotFailure;
    const copied = Object.create(null) as Record<string, unknown>;
    for (const key of keys) {
      if (typeof key !== "string") return snapshotFailure;
      totalStringCharacters += key.length;
      if (
        key.length > foreignJsonSnapshotLimits.stringCharacters
        || totalStringCharacters > foreignJsonSnapshotLimits.totalStringCharacters
      ) return snapshotFailure;
      const descriptor = Reflect.getOwnPropertyDescriptor(candidate, key);
      if (descriptor === undefined || !("value" in descriptor) || descriptor.enumerable !== true) {
        return snapshotFailure;
      }
      const entry = snapshot(descriptor.value, depth + 1);
      if (entry === snapshotFailure) return snapshotFailure;
      Object.defineProperty(copied, key, {
        configurable: true,
        enumerable: true,
        value: entry,
        writable: true,
      });
    }
    return copied;
  }

  try {
    const copied = snapshot(value, 0);
    return copied === snapshotFailure ? { ok: false } : { ok: true, value: copied };
  } catch {
    return { ok: false };
  }
}

export function assertNever(value: never): never {
  throw new Error(`Unexpected closed-union value: ${String(value)}`);
}
