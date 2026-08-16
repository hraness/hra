import { err, ok, type Result } from "@hraness/result";
import { z } from "@hra-internal/schema";

export type IndexedDbTransactionMode = "readonly" | "readwrite";

export type IndexedDbFailureStage =
  | "resolve"
  | "open"
  | "migration"
  | "transaction"
  | "request"
  | "callback"
  | "commit";

export type IndexedDbReadOperation = "get" | "get-all";
export type IndexedDbWriteOperation = "add" | "put";

export type IndexedDbFailure =
  | {
      readonly kind: "unavailable";
      readonly database: string;
    }
  | {
      readonly kind: "blocked";
      readonly database: string;
      readonly requestedVersion: number;
      readonly oldVersion: number;
      readonly newVersion: number | null;
    }
  | {
      readonly kind: "aborted";
      readonly database: string;
      readonly stage: IndexedDbFailureStage;
      readonly detail: string;
    }
  | {
      readonly kind: "quota";
      readonly database: string;
      readonly stage: IndexedDbFailureStage;
      readonly detail: string;
    }
  | {
      readonly kind: "security";
      readonly database: string;
      readonly stage: IndexedDbFailureStage;
      readonly detail: string;
    }
  | {
      readonly kind: "corruption";
      readonly database: string;
      readonly store: string;
      readonly operation: IndexedDbReadOperation;
      readonly detail: string;
    }
  | {
      readonly kind: "invalid-value";
      readonly database: string;
      readonly store: string;
      readonly operation: IndexedDbWriteOperation;
      readonly detail: string;
    }
  | {
      readonly kind: "transaction-failed";
      readonly database: string;
      readonly stage: IndexedDbFailureStage;
      readonly detail: string;
    };

/**
 * Converts application values to structured-cloneable storage values and
 * parses stored values back across the untrusted IndexedDB boundary. A codec
 * must make decoding its encoded values semantically stable.
 */
export interface IndexedDbCodec<T> {
  encode(value: unknown): Result<unknown, string>;
  decode(value: unknown): Result<T, string>;
}

/** Uses one Zod schema for canonical writes and validated reads. */
export function createZodIndexedDbCodec<S extends z.ZodType>(
  schema: S,
): IndexedDbCodec<z.output<S>> {
  function parse(value: unknown): Result<z.output<S>, string> {
    try {
      const parsed = schema.safeParse(value);
      return parsed.success
        ? ok(parsed.data)
        : err(z.prettifyError(parsed.error));
    } catch (cause: unknown) {
      return err(errorDetail(cause));
    }
  }

  return {
    encode: parse,
    decode: parse,
  };
}

export interface IndexedDbStoreDefinition<T> {
  readonly codec: IndexedDbCodec<T>;
}

export function defineIndexedDbStore<T>(
  codec: IndexedDbCodec<T>,
): IndexedDbStoreDefinition<T> {
  return { codec };
}

export type IndexedDbStoreDefinitions = Readonly<
  Record<string, IndexedDbStoreDefinition<unknown>>
>;

export type IndexedDbKey = IDBValidKey;
export type IndexedDbQuery = IDBValidKey | IDBKeyRange;

export interface IndexedDbRequestLike<T> {
  result(): T;
  error(): unknown;
  onSuccess(listener: () => void): void;
  onError(listener: () => void): void;
}

export interface IndexedDbObjectStoreOptions {
  readonly keyPath?: string | readonly string[] | null;
  readonly autoIncrement?: boolean;
}

export interface IndexedDbIndexOptions {
  readonly unique?: boolean;
  readonly multiEntry?: boolean;
}

/**
 * The small object-store subset needed by migrations and transaction stores.
 * Consumers normally use the validated transaction facade instead.
 */
export interface IndexedDbObjectStoreLike {
  readonly name: string;
  containsIndex(name: string): boolean;
  createIndex(
    name: string,
    keyPath: string | readonly string[],
    options?: IndexedDbIndexOptions,
  ): void;
  deleteIndex(name: string): void;
  get(query: IndexedDbQuery): IndexedDbRequestLike<unknown>;
  getAll(
    query?: IndexedDbQuery,
    count?: number,
  ): IndexedDbRequestLike<readonly unknown[]>;
  count(query?: IndexedDbQuery): IndexedDbRequestLike<number>;
  add(value: unknown, key?: IndexedDbKey): IndexedDbRequestLike<IndexedDbKey>;
  put(value: unknown, key?: IndexedDbKey): IndexedDbRequestLike<IndexedDbKey>;
  delete(query: IndexedDbQuery): IndexedDbRequestLike<undefined>;
  clear(): IndexedDbRequestLike<undefined>;
}

export interface IndexedDbTransactionLike {
  error(): unknown;
  objectStore(name: string): IndexedDbObjectStoreLike;
  abort(): void;
  onComplete(listener: () => void): void;
  onAbort(listener: () => void): void;
}

export interface IndexedDbDatabaseLike {
  containsObjectStore(name: string): boolean;
  createObjectStore(
    name: string,
    options?: IndexedDbObjectStoreOptions,
  ): IndexedDbObjectStoreLike;
  deleteObjectStore(name: string): void;
  transaction(
    storeNames: readonly string[],
    mode: IndexedDbTransactionMode,
  ): IndexedDbTransactionLike;
  close(): void;
}

export interface IndexedDbVersionChangeLike {
  readonly oldVersion: number;
  readonly newVersion: number | null;
}

export interface IndexedDbOpenRequestLike
  extends IndexedDbRequestLike<IndexedDbDatabaseLike> {
  transaction(): IndexedDbTransactionLike | null;
  onBlocked(listener: (event: IndexedDbVersionChangeLike) => void): void;
  onUpgradeNeeded(
    listener: (event: IndexedDbVersionChangeLike) => void,
  ): void;
}

export interface IndexedDbFactoryLike {
  open(name: string, version: number): IndexedDbOpenRequestLike;
}

export type IndexedDbMigrationStore = IndexedDbObjectStoreLike;

export interface IndexedDbMigrationContext {
  readonly fromVersion: number;
  readonly toVersion: number;
  hasStore(name: string): boolean;
  createStore(
    name: string,
    options?: IndexedDbObjectStoreOptions,
  ): IndexedDbMigrationStore;
  deleteStore(name: string): void;
  store(name: string): IndexedDbMigrationStore;
  abort(detail: string): never;
}

/**
 * Migrations form a contiguous one-step chain. Each callback must synchronously
 * schedule its versionchange work; returning a promise aborts the upgrade.
 */
export interface IndexedDbMigration {
  readonly toVersion: number;
  migrate(context: IndexedDbMigrationContext): void;
}

export interface IndexedDbReadonlyStore<T> {
  get(key: IndexedDbKey): Promise<T | null>;
  getAll(query?: IndexedDbQuery, count?: number): Promise<readonly T[]>;
  count(query?: IndexedDbQuery): Promise<number>;
}

export interface IndexedDbReadWriteStore<T>
  extends IndexedDbReadonlyStore<T> {
  add(value: unknown, key?: IndexedDbKey): Promise<IndexedDbKey>;
  put(value: unknown, key?: IndexedDbKey): Promise<IndexedDbKey>;
  delete(key: IndexedDbKey): Promise<void>;
  clear(): Promise<void>;
}

export type IndexedDbStore<
  T,
  Mode extends IndexedDbTransactionMode = "readwrite",
> = Mode extends "readonly"
  ? IndexedDbReadonlyStore<T>
  : IndexedDbReadWriteStore<T>;

type StoreName<Stores extends IndexedDbStoreDefinitions> =
  Extract<keyof Stores, string>;

type StoreValue<Definition> =
  Definition extends IndexedDbStoreDefinition<infer T> ? T : never;

export interface IndexedDbTransaction<
  Stores extends IndexedDbStoreDefinitions,
  Names extends StoreName<Stores>,
  Mode extends IndexedDbTransactionMode,
> {
  store<Name extends Names>(
    name: Name,
  ): IndexedDbStore<StoreValue<Stores[Name]>, Mode>;
  abort(detail: string): never;
}

export interface IndexedDatabase<
  Stores extends IndexedDbStoreDefinitions,
> {
  transaction<
    const Names extends readonly [
      StoreName<Stores>,
      ...StoreName<Stores>[],
    ],
    const Mode extends IndexedDbTransactionMode,
    T,
  >(
    storeNames: Names,
    mode: Mode,
    run: (
      transaction: IndexedDbTransaction<
        Stores,
        Names[number],
        Mode
      >,
    ) => T | Promise<T>,
  ): Promise<Result<T, IndexedDbFailure>>;
}

export interface IndexedDatabaseOptions<
  Stores extends IndexedDbStoreDefinitions,
> {
  readonly name: string;
  readonly version: number;
  readonly stores: Stores;
  readonly migrations: readonly IndexedDbMigration[];
  readonly resolveIndexedDb?: () => IndexedDbFactoryLike | null;
}

type NativeRequest<T> = IndexedDbRequestLike<T>;

function wrapNativeRequest<T>(request: IDBRequest<T>): NativeRequest<T> {
  return {
    result: () => request.result,
    error: () => request.error,
    onSuccess: listener => {
      request.addEventListener("success", listener, { once: true });
    },
    onError: listener => {
      request.addEventListener("error", listener, { once: true });
    },
  };
}

function nativeStoreOptions(
  options: IndexedDbObjectStoreOptions | undefined,
): IDBObjectStoreParameters | undefined {
  if (options === undefined) return undefined;
  const keyPath = options.keyPath;
  const normalizedKeyPath: string | string[] | null | undefined =
    keyPath === undefined || keyPath === null || typeof keyPath === "string"
      ? keyPath
      : [...keyPath];
  return {
    ...(normalizedKeyPath === undefined
      ? {}
      : {
          keyPath: normalizedKeyPath,
        }),
    ...(options.autoIncrement === undefined
      ? {}
      : { autoIncrement: options.autoIncrement }),
  };
}

function nativeIndexOptions(
  options: IndexedDbIndexOptions | undefined,
): IDBIndexParameters | undefined {
  if (options === undefined) return undefined;
  return {
    ...(options.unique === undefined ? {} : { unique: options.unique }),
    ...(options.multiEntry === undefined
      ? {}
      : { multiEntry: options.multiEntry }),
  };
}

function wrapNativeObjectStore(
  store: IDBObjectStore,
): IndexedDbObjectStoreLike {
  return {
    name: store.name,
    containsIndex: name => store.indexNames.contains(name),
    createIndex: (name, keyPath, options) => {
      const normalizedKeyPath =
        typeof keyPath === "string" ? keyPath : [...keyPath];
      store.createIndex(
        name,
        normalizedKeyPath,
        nativeIndexOptions(options),
      );
    },
    deleteIndex: name => {
      store.deleteIndex(name);
    },
    get: query => wrapNativeRequest(store.get(query)),
    getAll: (query, count) =>
      wrapNativeRequest(store.getAll(query, count)),
    count: query => wrapNativeRequest(store.count(query)),
    add: (value, key) =>
      wrapNativeRequest(
        key === undefined ? store.add(value) : store.add(value, key),
      ),
    put: (value, key) =>
      wrapNativeRequest(
        key === undefined ? store.put(value) : store.put(value, key),
      ),
    delete: query => wrapNativeRequest(store.delete(query)),
    clear: () => wrapNativeRequest(store.clear()),
  };
}

function wrapNativeTransaction(
  transaction: IDBTransaction,
): IndexedDbTransactionLike {
  return {
    error: () => transaction.error,
    objectStore: name =>
      wrapNativeObjectStore(transaction.objectStore(name)),
    abort: () => {
      transaction.abort();
    },
    onComplete: listener => {
      transaction.addEventListener("complete", listener, { once: true });
    },
    onAbort: listener => {
      transaction.addEventListener("abort", listener, { once: true });
    },
  };
}

function wrapNativeDatabase(database: IDBDatabase): IndexedDbDatabaseLike {
  return {
    containsObjectStore: name =>
      database.objectStoreNames.contains(name),
    createObjectStore: (name, options) =>
      wrapNativeObjectStore(
        database.createObjectStore(name, nativeStoreOptions(options)),
      ),
    deleteObjectStore: name => {
      database.deleteObjectStore(name);
    },
    transaction: (storeNames, mode) =>
      wrapNativeTransaction(database.transaction([...storeNames], mode)),
    close: () => {
      database.close();
    },
  };
}

function wrapNativeOpenRequest(
  request: IDBOpenDBRequest,
): IndexedDbOpenRequestLike {
  return {
    result: () => wrapNativeDatabase(request.result),
    error: () => request.error,
    transaction: () =>
      request.transaction === null
        ? null
        : wrapNativeTransaction(request.transaction),
    onSuccess: listener => {
      request.addEventListener("success", listener, { once: true });
    },
    onError: listener => {
      request.addEventListener("error", listener, { once: true });
    },
    onBlocked: listener => {
      request.addEventListener(
        "blocked",
        event => {
          listener({
            oldVersion: event.oldVersion,
            newVersion: event.newVersion,
          });
        },
        { once: true },
      );
    },
    onUpgradeNeeded: listener => {
      request.addEventListener(
        "upgradeneeded",
        event => {
          listener({
            oldVersion: event.oldVersion,
            newVersion: event.newVersion,
          });
        },
        { once: true },
      );
    },
  };
}

function defaultIndexedDb(): IndexedDbFactoryLike | null {
  if (typeof globalThis.indexedDB === "undefined") return null;
  const factory = globalThis.indexedDB;
  return {
    open: (name, version) =>
      wrapNativeOpenRequest(factory.open(name, version)),
  };
}

function errorName(cause: unknown): string | null {
  if (typeof cause !== "object" || cause === null) return null;
  try {
    return "name" in cause && typeof cause.name === "string"
      ? cause.name
      : null;
  } catch {
    return null;
  }
}

function errorDetail(cause: unknown): string {
  if (cause instanceof Error) return cause.message;
  if (typeof cause === "object" && cause !== null) {
    try {
      if ("message" in cause && typeof cause.message === "string") {
        return cause.message;
      }
    } catch {
      return "Browser IndexedDB failed.";
    }
  }
  return typeof cause === "string"
    ? cause
    : "Browser IndexedDB failed.";
}

function accessFailure(
  database: string,
  stage: IndexedDbFailureStage,
  cause: unknown,
): IndexedDbFailure {
  const detail = errorDetail(cause);
  switch (errorName(cause)) {
    case "AbortError":
      return { kind: "aborted", database, stage, detail };
    case "QuotaExceededError":
    case "NS_ERROR_DOM_QUOTA_REACHED":
      return { kind: "quota", database, stage, detail };
    case "SecurityError":
      return { kind: "security", database, stage, detail };
    case null:
    default:
      return {
        kind: "transaction-failed",
        database,
        stage,
        detail,
      };
  }
}

function abortFailure(
  database: string,
  stage: IndexedDbFailureStage,
  cause: unknown,
): IndexedDbFailure {
  if (cause === null || cause === undefined) {
    return {
      kind: "aborted",
      database,
      stage,
      detail: "The IndexedDB transaction aborted.",
    };
  }
  return accessFailure(database, stage, cause);
}

class FailureSignal extends Error {
  readonly failure: IndexedDbFailure;

  constructor(failure: IndexedDbFailure) {
    super("IndexedDB operation failed.");
    this.failure = failure;
  }
}

function signal(failure: IndexedDbFailure): FailureSignal {
  return new FailureSignal(failure);
}

function isPromiseLike(value: unknown): boolean {
  if (
    (typeof value !== "object" || value === null)
    && typeof value !== "function"
  ) {
    return false;
  }
  try {
    return "then" in value
      && typeof value.then === "function";
  } catch {
    return false;
  }
}

function assertConfiguration(
  name: string,
  version: number,
  stores: IndexedDbStoreDefinitions,
  migrations: readonly IndexedDbMigration[],
): void {
  if (name.trim().length === 0) {
    throw new TypeError("IndexedDB database name must not be empty.");
  }
  if (!Number.isSafeInteger(version) || version < 1) {
    throw new RangeError(
      "IndexedDB version must be a positive safe integer.",
    );
  }
  if (Object.keys(stores).length === 0) {
    throw new TypeError(
      "IndexedDB requires at least one declared object store.",
    );
  }
  for (const storeName of Object.keys(stores)) {
    if (storeName.trim().length === 0) {
      throw new TypeError("IndexedDB object-store names must not be empty.");
    }
  }
  if (migrations.length !== version) {
    throw new RangeError(
      `IndexedDB version ${version} requires exactly ${version} contiguous migrations.`,
    );
  }
  migrations.forEach((migration, index) => {
    const expected = index + 1;
    if (migration.toVersion !== expected) {
      throw new RangeError(
        `IndexedDB migration ${index} must target version ${expected}.`,
      );
    }
  });
}

function migrationContext(
  databaseName: string,
  database: IndexedDbDatabaseLike,
  transaction: IndexedDbTransactionLike,
  toVersion: number,
  recordAbort: (failure: IndexedDbFailure) => void,
): IndexedDbMigrationContext {
  return {
    fromVersion: toVersion - 1,
    toVersion,
    hasStore: name => database.containsObjectStore(name),
    createStore: (name, options) =>
      database.createObjectStore(name, options),
    deleteStore: name => {
      database.deleteObjectStore(name);
    },
    store: name => transaction.objectStore(name),
    abort: detail => {
      const failure: IndexedDbFailure = {
        kind: "aborted",
        database: databaseName,
        stage: "migration",
        detail,
      };
      recordAbort(failure);
      safeAbort(transaction);
      throw signal(failure);
    },
  };
}

function safeClose(database: IndexedDbDatabaseLike): void {
  try {
    database.close();
  } catch {
    // The operation result already carries the actionable failure.
  }
}

function safeAbort(transaction: IndexedDbTransactionLike): void {
  try {
    transaction.abort();
  } catch {
    // A completed or already-aborted transaction needs no second abort.
  }
}

function openDatabase(
  databaseName: string,
  version: number,
  migrations: readonly IndexedDbMigration[],
  factory: IndexedDbFactoryLike,
): Promise<IndexedDbDatabaseLike> {
  return new Promise((resolve, reject) => {
    let request: IndexedDbOpenRequestLike;
    try {
      request = factory.open(databaseName, version);
    } catch (cause: unknown) {
      reject(signal(accessFailure(databaseName, "open", cause)));
      return;
    }

    let settled = false;
    let migrationFailure: IndexedDbFailure | null = null;

    const rejectOnce = (failure: IndexedDbFailure): void => {
      if (settled) return;
      settled = true;
      reject(signal(failure));
    };

    request.onBlocked(event => {
      rejectOnce({
        kind: "blocked",
        database: databaseName,
        requestedVersion: version,
        oldVersion: event.oldVersion,
        newVersion: event.newVersion,
      });
    });

    request.onUpgradeNeeded(event => {
      const transaction = request.transaction();
      if (transaction === null) {
        migrationFailure = {
          kind: "transaction-failed",
          database: databaseName,
          stage: "migration",
          detail: "The upgrade event had no versionchange transaction.",
        };
        return;
      }

      transaction.onAbort(() => {
        migrationFailure ??= abortFailure(
          databaseName,
          "migration",
          transaction.error(),
        );
      });

      let database: IndexedDbDatabaseLike;
      try {
        database = request.result();
      } catch (cause: unknown) {
        migrationFailure = accessFailure(
          databaseName,
          "migration",
          cause,
        );
        safeAbort(transaction);
        return;
      }

      if (
        !Number.isSafeInteger(event.oldVersion)
        || event.oldVersion < 0
        || event.oldVersion > version
        || event.newVersion !== version
      ) {
        migrationFailure = {
          kind: "transaction-failed",
          database: databaseName,
          stage: "migration",
          detail:
            `Invalid IndexedDB version change ${event.oldVersion} -> ${String(event.newVersion)}.`,
        };
        safeAbort(transaction);
        return;
      }

      for (const migration of migrations) {
        if (migration.toVersion <= event.oldVersion) continue;
        try {
          const outcome: unknown = migration.migrate(
            migrationContext(
              databaseName,
              database,
              transaction,
              migration.toVersion,
              failure => {
                migrationFailure ??= failure;
              },
            ),
          );
          if (isPromiseLike(outcome)) {
            throw new TypeError(
              `IndexedDB migration to version ${migration.toVersion} returned a promise.`,
            );
          }
          if (migrationFailure !== null) {
            safeAbort(transaction);
            return;
          }
        } catch (cause: unknown) {
          migrationFailure = cause instanceof FailureSignal
            ? cause.failure
            : accessFailure(databaseName, "migration", cause);
          safeAbort(transaction);
          return;
        }
      }
    });

    request.onError(() => {
      let cause: unknown;
      try {
        cause = request.error();
      } catch (error: unknown) {
        cause = error;
      }
      rejectOnce(
        migrationFailure
        ?? accessFailure(databaseName, "open", cause),
      );
    });

    request.onSuccess(() => {
      let database: IndexedDbDatabaseLike;
      try {
        database = request.result();
      } catch (cause: unknown) {
        rejectOnce(accessFailure(databaseName, "open", cause));
        return;
      }
      if (settled) {
        safeClose(database);
        return;
      }
      if (migrationFailure !== null) {
        safeClose(database);
        rejectOnce(migrationFailure);
        return;
      }
      settled = true;
      resolve(database);
    });
  });
}

function requestValue<T>(
  database: string,
  request: IndexedDbRequestLike<T>,
  mapCause: (
    cause: unknown,
  ) => IndexedDbFailure = cause =>
    accessFailure(database, "request", cause),
): Promise<T> {
  return new Promise((resolve, reject) => {
    let settled = false;
    try {
      request.onSuccess(() => {
        if (settled) return;
        settled = true;
        try {
          resolve(request.result());
        } catch (cause: unknown) {
          reject(signal(mapCause(cause)));
        }
      });
      request.onError(() => {
        if (settled) return;
        settled = true;
        let cause: unknown;
        try {
          cause = request.error();
        } catch (error: unknown) {
          cause = error;
        }
        reject(signal(mapCause(cause)));
      });
    } catch (cause: unknown) {
      if (!settled) {
        settled = true;
        reject(signal(mapCause(cause)));
      }
    }
  });
}

function issueRequest<T>(
  database: string,
  createRequest: () => IndexedDbRequestLike<T>,
  mapCause: (
    cause: unknown,
  ) => IndexedDbFailure = cause =>
    accessFailure(database, "request", cause),
): Promise<T> {
  try {
    return requestValue(database, createRequest(), mapCause);
  } catch (cause: unknown) {
    return Promise.reject(signal(mapCause(cause)));
  }
}

function writeFailure(
  database: string,
  store: string,
  operation: IndexedDbWriteOperation,
  cause: unknown,
): IndexedDbFailure {
  switch (errorName(cause)) {
    case "DataCloneError":
    case "DataError":
      return {
        kind: "invalid-value",
        database,
        store,
        operation,
        detail: errorDetail(cause),
      };
    case "AbortError":
    case "QuotaExceededError":
    case "NS_ERROR_DOM_QUOTA_REACHED":
    case "SecurityError":
    case null:
    default:
      return accessFailure(database, "request", cause);
  }
}

function decodeValue<T>(
  database: string,
  store: string,
  operation: IndexedDbReadOperation,
  codec: IndexedDbCodec<T>,
  value: unknown,
): T {
  let decoded: Result<T, string>;
  try {
    decoded = codec.decode(value);
  } catch (cause: unknown) {
    throw signal({
      kind: "corruption",
      database,
      store,
      operation,
      detail: errorDetail(cause),
    });
  }
  if (!decoded.ok) {
    throw signal({
      kind: "corruption",
      database,
      store,
      operation,
      detail: decoded.error,
    });
  }
  return decoded.value;
}

function encodeValue<T>(
  database: string,
  store: string,
  operation: IndexedDbWriteOperation,
  codec: IndexedDbCodec<T>,
  value: unknown,
): unknown {
  let encoded: Result<unknown, string>;
  try {
    encoded = codec.encode(value);
  } catch (cause: unknown) {
    throw signal({
      kind: "invalid-value",
      database,
      store,
      operation,
      detail: errorDetail(cause),
    });
  }
  if (!encoded.ok) {
    throw signal({
      kind: "invalid-value",
      database,
      store,
      operation,
      detail: encoded.error,
    });
  }
  let decoded: Result<T, string>;
  try {
    decoded = codec.decode(encoded.value);
  } catch (cause: unknown) {
    throw signal({
      kind: "invalid-value",
      database,
      store,
      operation,
      detail: errorDetail(cause),
    });
  }
  if (!decoded.ok) {
    throw signal({
      kind: "invalid-value",
      database,
      store,
      operation,
      detail: `The encoded value cannot be decoded: ${decoded.error}`,
    });
  }
  return encoded.value;
}

function createStore<T>(
  database: string,
  definition: IndexedDbStoreDefinition<T>,
  store: IndexedDbObjectStoreLike,
): IndexedDbReadWriteStore<T> {
  return {
    async get(key) {
      const value = await issueRequest(
        database,
        () => store.get(key),
      );
      if (value === undefined) {
        const matches = await issueRequest(
          database,
          () => store.count(key),
        );
        if (matches === 0) return null;
      }
      return decodeValue(
        database,
        store.name,
        "get",
        definition.codec,
        value,
      );
    },
    async getAll(query, count) {
      const values = await issueRequest(
        database,
        () => store.getAll(query, count),
      );
      return values.map(value =>
        decodeValue(
          database,
          store.name,
          "get-all",
          definition.codec,
          value,
        ),
      );
    },
    count: query =>
      issueRequest(database, () => store.count(query)),
    async add(value, key) {
      const encoded = encodeValue(
        database,
        store.name,
        "add",
        definition.codec,
        value,
      );
      return await issueRequest(
        database,
        () => store.add(encoded, key),
        cause =>
          writeFailure(database, store.name, "add", cause),
      );
    },
    async put(value, key) {
      const encoded = encodeValue(
        database,
        store.name,
        "put",
        definition.codec,
        value,
      );
      return await issueRequest(
        database,
        () => store.put(encoded, key),
        cause =>
          writeFailure(database, store.name, "put", cause),
      );
    },
    async delete(key) {
      await issueRequest(database, () => store.delete(key));
    },
    async clear() {
      await issueRequest(database, () => store.clear());
    },
  };
}

function completion(
  database: string,
  transaction: IndexedDbTransactionLike,
): Promise<Result<void, IndexedDbFailure>> {
  return new Promise(resolve => {
    let settled = false;
    try {
      transaction.onComplete(() => {
        if (settled) return;
        settled = true;
        resolve(ok(undefined));
      });
      transaction.onAbort(() => {
        if (settled) return;
        settled = true;
        let cause: unknown;
        try {
          cause = transaction.error();
        } catch (error: unknown) {
          cause = error;
        }
        resolve(err(abortFailure(database, "commit", cause)));
      });
    } catch (cause: unknown) {
      settled = true;
      resolve(err(accessFailure(database, "commit", cause)));
    }
  });
}

function failureFromThrown(
  database: string,
  cause: unknown,
): IndexedDbFailure {
  return cause instanceof FailureSignal
    ? cause.failure
    : accessFailure(database, "callback", cause);
}

/**
 * Defines a lazy, versioned IndexedDB boundary. Each call opens a fresh
 * connection, runs one transaction, waits for its terminal event, then closes
 * the connection. The callback should await only operations from its facade.
 */
export function createIndexedDatabase<
  const Stores extends IndexedDbStoreDefinitions,
>(
  options: IndexedDatabaseOptions<Stores>,
): IndexedDatabase<Stores> {
  assertConfiguration(
    options.name,
    options.version,
    options.stores,
    options.migrations,
  );
  const resolveIndexedDb =
    options.resolveIndexedDb ?? defaultIndexedDb;
  const declaredStores = new Set(Object.keys(options.stores));

  async function transaction<
    const Names extends readonly [
      StoreName<Stores>,
      ...StoreName<Stores>[],
    ],
    const Mode extends IndexedDbTransactionMode,
    T,
  >(
    storeNames: Names,
    mode: Mode,
    run: (
      transaction: IndexedDbTransaction<
        Stores,
        Names[number],
        Mode
      >,
    ) => T | Promise<T>,
  ): Promise<Result<T, IndexedDbFailure>> {
    const uniqueNames = new Set<string>(storeNames);
    if (
      storeNames.length === 0
      || uniqueNames.size !== storeNames.length
      || storeNames.some(name => !declaredStores.has(name))
    ) {
      return err({
        kind: "transaction-failed",
        database: options.name,
        stage: "transaction",
        detail:
          "Transactions require unique, declared object-store names.",
      });
    }

    let factory: IndexedDbFactoryLike | null;
    try {
      factory = resolveIndexedDb();
    } catch (cause: unknown) {
      return err(accessFailure(options.name, "resolve", cause));
    }
    if (factory === null) {
      return err({ kind: "unavailable", database: options.name });
    }

    let database: IndexedDbDatabaseLike;
    try {
      database = await openDatabase(
        options.name,
        options.version,
        options.migrations,
        factory,
      );
    } catch (cause: unknown) {
      return err(
        cause instanceof FailureSignal
          ? cause.failure
          : accessFailure(options.name, "open", cause),
      );
    }

    let rawTransaction: IndexedDbTransactionLike;
    try {
      rawTransaction = database.transaction(storeNames, mode);
    } catch (cause: unknown) {
      safeClose(database);
      return err(accessFailure(options.name, "transaction", cause));
    }

    const completed = completion(options.name, rawTransaction);
    const transactionStores = new Set<string>(storeNames);
    let requestedAbort: IndexedDbFailure | null = null;
    const facade: IndexedDbTransaction<
      Stores,
      Names[number],
      Mode
    > = {
      store: name => {
        if (!transactionStores.has(name)) {
          throw signal({
            kind: "transaction-failed",
            database: options.name,
            stage: "transaction",
            detail:
              `Object store "${name}" is outside this transaction's scope.`,
          });
        }
        const definition = options.stores[name];
        if (definition === undefined) {
          throw signal({
            kind: "transaction-failed",
            database: options.name,
            stage: "transaction",
            detail: `Object store "${name}" has no declared codec.`,
          });
        }
        return createStore(
          options.name,
          definition,
          rawTransaction.objectStore(name),
        ) as IndexedDbStore<
          StoreValue<Stores[typeof name]>,
          Mode
        >;
      },
      abort: detail => {
        requestedAbort = {
          kind: "aborted",
          database: options.name,
          stage: "callback",
          detail,
        };
        safeAbort(rawTransaction);
        throw signal(requestedAbort);
      },
    };

    let value: T;
    try {
      value = await run(facade);
    } catch (cause: unknown) {
      const failure = failureFromThrown(options.name, cause);
      safeAbort(rawTransaction);
      await completed;
      safeClose(database);
      return err(failure);
    }

    const completionResult = await completed;
    safeClose(database);
    if (requestedAbort !== null) return err(requestedAbort);
    return completionResult.ok
      ? ok(value)
      : completionResult;
  }

  return {
    transaction,
  };
}
