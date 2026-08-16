import { err, ok, type Result } from "@hraness/result";
import { z } from "@hra-internal/schema";

export * from "./indexed-db";

/** The synchronous string-record subset implemented by browser local storage. */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export type StorageOperation = "read" | "write" | "remove";

export type StorageFailure =
  | { readonly kind: "unavailable" }
  | {
      readonly kind: "access-failed";
      readonly operation: StorageOperation;
      readonly reason: "quota" | "security" | "unknown";
      readonly detail: string;
    }
  | { readonly kind: "invalid-json"; readonly detail: string }
  | { readonly kind: "invalid-record"; readonly detail: string }
  | { readonly kind: "encode-failed"; readonly detail: string };

export interface LocalStorageRecord<T> {
  load(): Result<T | null, StorageFailure>;
  save(value: unknown): Result<void, StorageFailure>;
  remove(): Result<void, StorageFailure>;
}

export interface LocalStorageRecordOptions<S extends z.ZodType> {
  readonly key: string;
  readonly schema: S;
  readonly resolveStorage?: () => StorageLike | null;
}

function defaultStorage(): StorageLike | null {
  if (typeof window === "undefined") return null;
  return window.localStorage;
}

function errorDetail(cause: unknown): string {
  return cause instanceof Error ? cause.message : "Browser storage failed.";
}

function accessReason(cause: unknown): "quota" | "security" | "unknown" {
  if (typeof DOMException === "undefined" || !(cause instanceof DOMException)) return "unknown";
  if (cause.name === "QuotaExceededError") return "quota";
  if (cause.name === "SecurityError") return "security";
  return "unknown";
}

function accessFailure(
  operation: StorageOperation,
  cause: unknown,
): StorageFailure {
  return {
    kind: "access-failed",
    operation,
    reason: accessReason(cause),
    detail: errorDetail(cause),
  };
}

function resolveFor(
  resolveStorage: () => StorageLike | null,
  operation: StorageOperation,
): Result<StorageLike, StorageFailure> {
  try {
    const storage = resolveStorage();
    return storage === null ? err({ kind: "unavailable" }) : ok(storage);
  } catch (cause: unknown) {
    return err(accessFailure(operation, cause));
  }
}

function parseRecord<S extends z.ZodType>(
  schema: S,
  value: unknown,
  failureKind: "invalid-record" | "encode-failed",
): Result<z.output<S>, StorageFailure> {
  try {
    const parsed = schema.safeParse(value);
    return parsed.success
      ? ok(parsed.data)
      : err({ kind: failureKind, detail: z.prettifyError(parsed.error) });
  } catch (cause: unknown) {
    return err({ kind: failureKind, detail: errorDetail(cause) });
  }
}

/**
 * Defines one schema-validated JSON record without touching browser globals at
 * module initialization. Consumer schemas own record versions and migrations.
 */
export function createLocalStorageRecord<S extends z.ZodType>(
  options: LocalStorageRecordOptions<S>,
): LocalStorageRecord<z.output<S>> {
  const resolveStorage = options.resolveStorage ?? defaultStorage;

  return {
    load(): Result<z.output<S> | null, StorageFailure> {
      const resolved = resolveFor(resolveStorage, "read");
      if (!resolved.ok) return resolved;

      let encoded: string | null;
      try {
        encoded = resolved.value.getItem(options.key);
      } catch (cause: unknown) {
        return err(accessFailure("read", cause));
      }
      if (encoded === null) return ok(null);

      let value: unknown;
      try {
        value = JSON.parse(encoded);
      } catch (cause: unknown) {
        return err({ kind: "invalid-json", detail: errorDetail(cause) });
      }

      return parseRecord(options.schema, value, "invalid-record");
    },

    save(value: unknown): Result<void, StorageFailure> {
      const parsed = parseRecord(options.schema, value, "invalid-record");
      if (!parsed.ok) return parsed;

      let encoded: string;
      try {
        const serialized = JSON.stringify(parsed.value);
        if (serialized === undefined) {
          return err({ kind: "encode-failed", detail: "The record is not JSON-serializable." });
        }
        encoded = serialized;
      } catch (cause: unknown) {
        return err({ kind: "encode-failed", detail: errorDetail(cause) });
      }

      let roundTrip: unknown;
      try {
        roundTrip = JSON.parse(encoded);
      } catch (cause: unknown) {
        return err({ kind: "encode-failed", detail: errorDetail(cause) });
      }
      const reparsed = parseRecord(options.schema, roundTrip, "encode-failed");
      if (!reparsed.ok) return reparsed;

      let canonicalRoundTrip: string | undefined;
      try {
        canonicalRoundTrip = JSON.stringify(reparsed.value);
      } catch (cause: unknown) {
        return err({ kind: "encode-failed", detail: errorDetail(cause) });
      }
      if (canonicalRoundTrip !== encoded) {
        return err({
          kind: "encode-failed",
          detail:
            "The schema output changes when it is parsed again after JSON serialization.",
        });
      }

      const resolved = resolveFor(resolveStorage, "write");
      if (!resolved.ok) return resolved;
      try {
        resolved.value.setItem(options.key, encoded);
        return ok(undefined);
      } catch (cause: unknown) {
        return err(accessFailure("write", cause));
      }
    },

    remove(): Result<void, StorageFailure> {
      const resolved = resolveFor(resolveStorage, "remove");
      if (!resolved.ok) return resolved;
      try {
        resolved.value.removeItem(options.key);
        return ok(undefined);
      } catch (cause: unknown) {
        return err(accessFailure("remove", cause));
      }
    },
  };
}
