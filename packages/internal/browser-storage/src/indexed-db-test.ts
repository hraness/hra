import type {
  IndexedDbDatabaseLike,
  IndexedDbFactoryLike,
  IndexedDbIndexOptions,
  IndexedDbKey,
  IndexedDbObjectStoreLike,
  IndexedDbObjectStoreOptions,
  IndexedDbOpenRequestLike,
  IndexedDbQuery,
  IndexedDbRequestLike,
  IndexedDbTransactionLike,
  IndexedDbTransactionMode,
  IndexedDbVersionChangeLike,
} from "./indexed-db";

export type MemoryIndexedDbRequestOperation =
  | "get"
  | "get-all"
  | "count"
  | "add"
  | "put"
  | "delete"
  | "clear";

interface StoredRecord {
  readonly key: IndexedDbKey;
  readonly value: unknown;
}

interface IndexState {
  readonly keyPath: string | readonly string[];
  readonly options: IndexedDbIndexOptions;
}

interface StoreState {
  readonly name: string;
  readonly options: IndexedDbObjectStoreOptions;
  readonly indexes: Map<string, IndexState>;
  readonly records: Map<string, StoredRecord>;
  nextGeneratedKey: number;
}

interface DatabaseState {
  readonly name: string;
  version: number;
  readonly stores: Map<string, StoreState>;
}

interface RequestFailure {
  readonly operation: MemoryIndexedDbRequestOperation;
  readonly cause: unknown;
}

interface InjectedFailure {
  readonly cause: unknown;
}

interface HeldCommit {
  release(): void;
}

type VoidListener = () => void;

function cloneValue<T>(value: T): T {
  return structuredClone(value);
}

function cloneStore(store: StoreState): StoreState {
  return {
    name: store.name,
    options: cloneValue(store.options),
    indexes: new Map(
      [...store.indexes].map(([name, index]) => [
        name,
        cloneValue(index),
      ]),
    ),
    records: new Map(
      [...store.records].map(([token, record]) => [
        token,
        {
          key: cloneValue(record.key),
          value: cloneValue(record.value),
        },
      ]),
    ),
    nextGeneratedKey: store.nextGeneratedKey,
  };
}

function cloneDatabase(database: DatabaseState): DatabaseState {
  return {
    name: database.name,
    version: database.version,
    stores: new Map(
      [...database.stores].map(([name, store]) => [
        name,
        cloneStore(store),
      ]),
    ),
  };
}

function emptyDatabase(name: string): DatabaseState {
  return {
    name,
    version: 0,
    stores: new Map(),
  };
}

function normalizedStoreOptions(
  options: IndexedDbObjectStoreOptions | undefined,
): IndexedDbObjectStoreOptions {
  return options === undefined ? {} : cloneValue(options);
}

function normalizedIndexOptions(
  options: IndexedDbIndexOptions | undefined,
): IndexedDbIndexOptions {
  return options === undefined ? {} : cloneValue(options);
}

function byteToken(value: ArrayBuffer | ArrayBufferView): string {
  const bytes = value instanceof ArrayBuffer
    ? new Uint8Array(value)
    : new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  return [...bytes].join(",");
}

function keyToken(key: IndexedDbKey): string {
  if (typeof key === "string") return `string:${key}`;
  if (typeof key === "number" && Number.isFinite(key)) {
    return `number:${Object.is(key, -0) ? 0 : key}`;
  }
  if (key instanceof Date && Number.isFinite(key.getTime())) {
    return `date:${key.getTime()}`;
  }
  if (key instanceof ArrayBuffer || ArrayBuffer.isView(key)) {
    return `binary:${byteToken(key)}`;
  }
  if (Array.isArray(key)) {
    return `array:[${key.map(item => keyToken(item)).join("|")}]`;
  }
  throw domException("DataError", "The value is not a valid IndexedDB key.");
}

function propertyAtPath(value: unknown, path: string): unknown {
  let current = value;
  for (const segment of path.split(".")) {
    if (typeof current !== "object" || current === null) {
      return undefined;
    }
    current = Reflect.get(current, segment);
  }
  return current;
}

function inlineKey(
  store: StoreState,
  value: unknown,
): IndexedDbKey | undefined {
  const keyPath = store.options.keyPath;
  if (keyPath === undefined || keyPath === null) return undefined;
  if (typeof keyPath === "string") {
    return propertyAtPath(value, keyPath) as IndexedDbKey | undefined;
  }
  const parts = keyPath.map(path => propertyAtPath(value, path));
  return parts.some(part => part === undefined)
    ? undefined
    : parts as IndexedDbKey[];
}

function resolveWriteKey(
  store: StoreState,
  value: unknown,
  suppliedKey: IndexedDbKey | undefined,
): IndexedDbKey {
  const hasInlineKey =
    store.options.keyPath !== undefined
    && store.options.keyPath !== null;
  if (hasInlineKey && suppliedKey !== undefined) {
    throw domException(
      "DataError",
      "An out-of-line key cannot be used with an inline key path.",
    );
  }
  const resolved = suppliedKey ?? inlineKey(store, value);
  if (resolved !== undefined) {
    keyToken(resolved);
    return cloneValue(resolved);
  }
  if (store.options.autoIncrement === true) {
    const generated = store.nextGeneratedKey;
    store.nextGeneratedKey += 1;
    return generated;
  }
  throw domException("DataError", "The write did not provide a key.");
}

function recordsForQuery(
  store: StoreState,
  query: IndexedDbQuery | undefined,
): readonly StoredRecord[] {
  if (query === undefined) return [...store.records.values()];
  const record = store.records.get(keyToken(query as IndexedDbKey));
  return record === undefined ? [] : [record];
}

class MemoryRequest<T> implements IndexedDbRequestLike<T> {
  private state: "pending" | "success" | "error" = "pending";
  private value: T | undefined;
  private failure: unknown = null;
  private readonly successListeners: VoidListener[] = [];
  private readonly errorListeners: VoidListener[] = [];

  result(): T {
    if (this.state !== "success") {
      throw domException(
        "InvalidStateError",
        "The request has not completed successfully.",
      );
    }
    return this.value as T;
  }

  error(): unknown {
    return this.failure;
  }

  onSuccess(listener: VoidListener): void {
    this.successListeners.push(listener);
  }

  onError(listener: VoidListener): void {
    this.errorListeners.push(listener);
  }

  succeed(value: T): void {
    if (this.state !== "pending") return;
    this.state = "success";
    this.value = value;
    for (const listener of this.successListeners) listener();
  }

  fail(cause: unknown): void {
    if (this.state !== "pending") return;
    this.state = "error";
    this.failure = cause;
    for (const listener of this.errorListeners) listener();
  }
}

class MemoryTransaction implements IndexedDbTransactionLike, HeldCommit {
  private readonly factory: MemoryIndexedDbFactory;
  private readonly stores: Map<string, StoreState>;
  private readonly allowedStores: Set<string>;
  private readonly mode: IndexedDbTransactionMode;
  private readonly commitAction: (stores: Map<string, StoreState>) => void;
  private readonly holdable: boolean;
  private readonly completeListeners: VoidListener[] = [];
  private readonly abortListeners: VoidListener[] = [];
  private terminal: "active" | "complete" | "abort" = "active";
  private transactionError: unknown = null;
  private pendingRequests = 0;
  private activity = 0;
  private readyHeld = false;

  constructor(options: {
    readonly factory: MemoryIndexedDbFactory;
    readonly stores: Map<string, StoreState>;
    readonly allowedStores: Set<string>;
    readonly mode: IndexedDbTransactionMode;
    readonly commitAction: (stores: Map<string, StoreState>) => void;
    readonly holdable: boolean;
  }) {
    this.factory = options.factory;
    this.stores = options.stores;
    this.allowedStores = options.allowedStores;
    this.mode = options.mode;
    this.commitAction = options.commitAction;
    this.holdable = options.holdable;
    this.scheduleCommit();
  }

  error(): unknown {
    return this.transactionError;
  }

  objectStore(name: string): IndexedDbObjectStoreLike {
    if (!this.allowedStores.has(name)) {
      throw domException(
        "NotFoundError",
        `Object store "${name}" is not in this transaction.`,
      );
    }
    const state = this.stores.get(name);
    if (state === undefined) {
      throw domException(
        "NotFoundError",
        `Object store "${name}" does not exist.`,
      );
    }
    return new MemoryObjectStore(this, state);
  }

  abort(): void {
    if (this.terminal !== "active") {
      throw domException(
        "InvalidStateError",
        "The transaction is no longer active.",
      );
    }
    this.abortWith(
      domException("AbortError", "The transaction was aborted."),
    );
  }

  onComplete(listener: VoidListener): void {
    this.completeListeners.push(listener);
  }

  onAbort(listener: VoidListener): void {
    this.abortListeners.push(listener);
  }

  request<T>(
    operation: MemoryIndexedDbRequestOperation,
    action: () => T,
  ): IndexedDbRequestLike<T> {
    if (this.terminal !== "active") {
      throw domException(
        "TransactionInactiveError",
        "The transaction is no longer active.",
      );
    }
    const request = new MemoryRequest<T>();
    this.pendingRequests += 1;
    this.activity += 1;
    this.factory.events.push(`request:${operation}`);
    queueMicrotask(() => {
      if (this.terminal !== "active") {
        request.fail(
          domException("AbortError", "The transaction was aborted."),
        );
        this.finishRequest();
        return;
      }
      const injected = this.factory.takeRequestFailure(operation);
      if (injected !== null) {
        request.fail(injected.cause);
        this.finishRequest();
        this.abortWith(injected.cause);
        return;
      }
      try {
        request.succeed(action());
        this.finishRequest();
      } catch (cause: unknown) {
        request.fail(cause);
        this.finishRequest();
        this.abortWith(cause);
      }
    });
    return request;
  }

  abortWith(cause: unknown): void {
    if (this.terminal !== "active") return;
    this.terminal = "abort";
    this.transactionError = cause;
    this.factory.events.push("transaction:abort");
    for (const listener of this.abortListeners) listener();
  }

  release(): void {
    if (!this.readyHeld || this.terminal !== "active") return;
    this.readyHeld = false;
    this.commit();
  }

  private finishRequest(): void {
    this.pendingRequests -= 1;
    this.activity += 1;
    this.scheduleCommit();
  }

  private scheduleCommit(): void {
    if (this.terminal !== "active" || this.pendingRequests !== 0) return;
    const expectedActivity = this.activity;
    setTimeout(() => {
      if (
        this.terminal !== "active"
        || this.pendingRequests !== 0
        || this.activity !== expectedActivity
      ) {
        return;
      }
      if (
        this.holdable
        && this.factory.shouldHoldNextTransactionCommit()
      ) {
        this.readyHeld = true;
        this.factory.holdCommit(this);
        return;
      }
      this.commit();
    }, 0);
  }

  private commit(): void {
    if (this.terminal !== "active") return;
    const injected = this.holdable
      ? this.factory.takeCommitFailure()
      : null;
    if (injected !== null) {
      this.abortWith(injected.cause);
      return;
    }
    try {
      this.commitAction(this.stores);
    } catch (cause: unknown) {
      this.abortWith(cause);
      return;
    }
    this.terminal = "complete";
    this.factory.events.push("transaction:complete");
    for (const listener of this.completeListeners) listener();
  }

  assertCanWrite(): void {
    if (this.mode === "readonly") {
      throw domException(
        "ReadOnlyError",
        "The transaction is read-only.",
      );
    }
  }

  allowStore(name: string): void {
    this.allowedStores.add(name);
  }

  disallowStore(name: string): void {
    this.allowedStores.delete(name);
  }
}

class MemoryObjectStore implements IndexedDbObjectStoreLike {
  readonly name: string;
  private readonly transaction: MemoryTransaction;
  private readonly state: StoreState;

  constructor(transaction: MemoryTransaction, state: StoreState) {
    this.transaction = transaction;
    this.state = state;
    this.name = state.name;
  }

  containsIndex(name: string): boolean {
    return this.state.indexes.has(name);
  }

  createIndex(
    name: string,
    keyPath: string | readonly string[],
    options?: IndexedDbIndexOptions,
  ): void {
    if (this.state.indexes.has(name)) {
      throw domException(
        "ConstraintError",
        `Index "${name}" already exists.`,
      );
    }
    this.state.indexes.set(name, {
      keyPath: cloneValue(keyPath),
      options: normalizedIndexOptions(options),
    });
  }

  deleteIndex(name: string): void {
    if (!this.state.indexes.delete(name)) {
      throw domException(
        "NotFoundError",
        `Index "${name}" does not exist.`,
      );
    }
  }

  get(query: IndexedDbQuery): IndexedDbRequestLike<unknown> {
    return this.transaction.request("get", () => {
      const record = this.state.records.get(
        keyToken(query as IndexedDbKey),
      );
      return record === undefined
        ? undefined
        : cloneValue(record.value);
    });
  }

  getAll(
    query?: IndexedDbQuery,
    count?: number,
  ): IndexedDbRequestLike<readonly unknown[]> {
    return this.transaction.request("get-all", () => {
      const values = recordsForQuery(this.state, query)
        .slice(0, count)
        .map(record => cloneValue(record.value));
      return values;
    });
  }

  count(query?: IndexedDbQuery): IndexedDbRequestLike<number> {
    return this.transaction.request(
      "count",
      () => recordsForQuery(this.state, query).length,
    );
  }

  add(
    value: unknown,
    key?: IndexedDbKey,
  ): IndexedDbRequestLike<IndexedDbKey> {
    this.transaction.assertCanWrite();
    return this.transaction.request("add", () => {
      const storedValue = cloneValue(value);
      const resolvedKey = resolveWriteKey(
        this.state,
        storedValue,
        key,
      );
      const token = keyToken(resolvedKey);
      if (this.state.records.has(token)) {
        throw domException(
          "ConstraintError",
          "A record already exists for the key.",
        );
      }
      this.state.records.set(token, {
        key: cloneValue(resolvedKey),
        value: storedValue,
      });
      return cloneValue(resolvedKey);
    });
  }

  put(
    value: unknown,
    key?: IndexedDbKey,
  ): IndexedDbRequestLike<IndexedDbKey> {
    this.transaction.assertCanWrite();
    return this.transaction.request("put", () => {
      const storedValue = cloneValue(value);
      const resolvedKey = resolveWriteKey(
        this.state,
        storedValue,
        key,
      );
      this.state.records.set(keyToken(resolvedKey), {
        key: cloneValue(resolvedKey),
        value: storedValue,
      });
      return cloneValue(resolvedKey);
    });
  }

  delete(query: IndexedDbQuery): IndexedDbRequestLike<undefined> {
    this.transaction.assertCanWrite();
    return this.transaction.request("delete", () => {
      this.state.records.delete(keyToken(query as IndexedDbKey));
      return undefined;
    });
  }

  clear(): IndexedDbRequestLike<undefined> {
    this.transaction.assertCanWrite();
    return this.transaction.request("clear", () => {
      this.state.records.clear();
      return undefined;
    });
  }
}

class MemoryDatabaseConnection implements IndexedDbDatabaseLike {
  private readonly factory: MemoryIndexedDbFactory;
  private readonly state: DatabaseState;
  private upgradeTransaction: MemoryTransaction | null = null;
  private closed = false;

  constructor(
    factory: MemoryIndexedDbFactory,
    state: DatabaseState,
  ) {
    this.factory = factory;
    this.state = state;
  }

  containsObjectStore(name: string): boolean {
    return this.state.stores.has(name);
  }

  createObjectStore(
    name: string,
    options?: IndexedDbObjectStoreOptions,
  ): IndexedDbObjectStoreLike {
    const transaction = this.upgradeTransaction;
    if (transaction === null) {
      throw domException(
        "InvalidStateError",
        "Object stores can be created only during an upgrade.",
      );
    }
    if (this.state.stores.has(name)) {
      throw domException(
        "ConstraintError",
        `Object store "${name}" already exists.`,
      );
    }
    const store: StoreState = {
      name,
      options: normalizedStoreOptions(options),
      indexes: new Map(),
      records: new Map(),
      nextGeneratedKey: 1,
    };
    this.state.stores.set(name, store);
    this.factory.events.push(`create-store:${name}`);
    transaction.allowStore(name);
    return transaction.objectStore(name);
  }

  deleteObjectStore(name: string): void {
    const transaction = this.upgradeTransaction;
    if (transaction === null) {
      throw domException(
        "InvalidStateError",
        "Object stores can be deleted only during an upgrade.",
      );
    }
    if (!this.state.stores.delete(name)) {
      throw domException(
        "NotFoundError",
        `Object store "${name}" does not exist.`,
      );
    }
    transaction.disallowStore(name);
    this.factory.events.push(`delete-store:${name}`);
  }

  transaction(
    storeNames: readonly string[],
    mode: IndexedDbTransactionMode,
  ): IndexedDbTransactionLike {
    if (this.closed) {
      throw domException(
        "InvalidStateError",
        "The database connection is closed.",
      );
    }
    const injected = this.factory.takeTransactionFailure();
    if (injected !== null) throw injected;
    if (storeNames.length === 0) {
      throw domException(
        "InvalidAccessError",
        "A transaction requires at least one object store.",
      );
    }
    const uniqueNames = new Set(storeNames);
    if (uniqueNames.size !== storeNames.length) {
      throw domException(
        "InvalidAccessError",
        "Object-store names must be unique.",
      );
    }
    for (const name of storeNames) {
      if (!this.state.stores.has(name)) {
        throw domException(
          "NotFoundError",
          `Object store "${name}" does not exist.`,
        );
      }
    }
    const workingStores = new Map(
      storeNames.map(name => {
        const store = this.state.stores.get(name);
        if (store === undefined) {
          throw domException("NotFoundError", `Missing store "${name}".`);
        }
        return [name, cloneStore(store)] as const;
      }),
    );
    this.factory.transactionCount += 1;
    this.factory.events.push(
      `transaction:start:${mode}:${storeNames.join(",")}`,
    );
    return new MemoryTransaction({
      factory: this.factory,
      stores: workingStores,
      allowedStores: uniqueNames,
      mode,
      holdable: true,
      commitAction: committed => {
        for (const [name, store] of committed) {
          this.state.stores.set(name, cloneStore(store));
        }
      },
    });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.factory.closeCount += 1;
    this.factory.events.push(`close:${this.state.name}`);
  }

  setUpgradeTransaction(transaction: MemoryTransaction): void {
    this.upgradeTransaction = transaction;
  }
}

class MemoryOpenRequest implements IndexedDbOpenRequestLike {
  private database: MemoryDatabaseConnection | null = null;
  private upgradeTransaction: MemoryTransaction | null = null;
  private failure: unknown = null;
  private readonly successListeners: VoidListener[] = [];
  private readonly errorListeners: VoidListener[] = [];
  private readonly blockedListeners: ((
    event: IndexedDbVersionChangeLike,
  ) => void)[] = [];
  private readonly upgradeListeners: ((
    event: IndexedDbVersionChangeLike,
  ) => void)[] = [];

  result(): IndexedDbDatabaseLike {
    if (this.database === null) {
      throw domException(
        "InvalidStateError",
        "The open request has no database result.",
      );
    }
    return this.database;
  }

  error(): unknown {
    return this.failure;
  }

  transaction(): IndexedDbTransactionLike | null {
    return this.upgradeTransaction;
  }

  onSuccess(listener: VoidListener): void {
    this.successListeners.push(listener);
  }

  onError(listener: VoidListener): void {
    this.errorListeners.push(listener);
  }

  onBlocked(
    listener: (event: IndexedDbVersionChangeLike) => void,
  ): void {
    this.blockedListeners.push(listener);
  }

  onUpgradeNeeded(
    listener: (event: IndexedDbVersionChangeLike) => void,
  ): void {
    this.upgradeListeners.push(listener);
  }

  setDatabase(database: MemoryDatabaseConnection): void {
    this.database = database;
  }

  setUpgradeTransaction(
    transaction: MemoryTransaction | null,
  ): void {
    this.upgradeTransaction = transaction;
  }

  blocked(event: IndexedDbVersionChangeLike): void {
    for (const listener of this.blockedListeners) listener(event);
  }

  upgrade(event: IndexedDbVersionChangeLike): void {
    for (const listener of this.upgradeListeners) listener(event);
  }

  succeed(): void {
    for (const listener of this.successListeners) listener();
  }

  fail(cause: unknown): void {
    this.failure = cause;
    for (const listener of this.errorListeners) listener();
  }
}

/**
 * Deterministic, dependency-free IndexedDB adapter for package and consumer
 * tests. Requests and terminal transaction events are always delivered later.
 */
export class MemoryIndexedDbFactory implements IndexedDbFactoryLike {
  readonly events: string[] = [];
  openCount = 0;
  transactionCount = 0;
  closeCount = 0;

  private readonly databases = new Map<string, DatabaseState>();
  private nextOpenThrow: Error | null = null;
  private nextOpenError: InjectedFailure | null = null;
  private nextBlockedEvent: IndexedDbVersionChangeLike | null = null;
  private nextTransactionError: Error | null = null;
  private nextRequestError: RequestFailure | null = null;
  private nextCommitError: InjectedFailure | null = null;
  private omitUpgradeTransaction = false;
  private holdNextCommit = false;
  private readonly heldCommits: HeldCommit[] = [];

  open(name: string, version: number): IndexedDbOpenRequestLike {
    this.openCount += 1;
    this.events.push(`open:${name}:${version}`);
    if (this.nextOpenThrow !== null) {
      const cause = this.nextOpenThrow;
      this.nextOpenThrow = null;
      throw cause;
    }
    const request = new MemoryOpenRequest();
    queueMicrotask(() => {
      this.processOpen(request, name, version);
    });
    return request;
  }

  seed(
    name: string,
    version: number,
    stores: Readonly<
      Record<string, readonly (readonly [IndexedDbKey, unknown])[]>
    >,
  ): void {
    const database = emptyDatabase(name);
    database.version = version;
    for (const [storeName, entries] of Object.entries(stores)) {
      const store: StoreState = {
        name: storeName,
        options: {},
        indexes: new Map(),
        records: new Map(),
        nextGeneratedKey: 1,
      };
      for (const [key, value] of entries) {
        store.records.set(keyToken(key), {
          key: cloneValue(key),
          value: cloneValue(value),
        });
      }
      database.stores.set(storeName, store);
    }
    this.databases.set(name, database);
  }

  rawValue(
    databaseName: string,
    storeName: string,
    key: IndexedDbKey,
  ): unknown {
    const store = this.requireStore(databaseName, storeName);
    const record = store.records.get(keyToken(key));
    return record === undefined ? undefined : cloneValue(record.value);
  }

  rawEntries(
    databaseName: string,
    storeName: string,
  ): readonly (readonly [IndexedDbKey, unknown])[] {
    const store = this.requireStore(databaseName, storeName);
    return [...store.records.values()].map(record => [
      cloneValue(record.key),
      cloneValue(record.value),
    ] as const);
  }

  storeNames(databaseName: string): readonly string[] {
    const database = this.databases.get(databaseName);
    return database === undefined ? [] : [...database.stores.keys()];
  }

  indexNames(
    databaseName: string,
    storeName: string,
  ): readonly string[] {
    return [...this.requireStore(databaseName, storeName).indexes.keys()];
  }

  databaseVersion(databaseName: string): number {
    return this.databases.get(databaseName)?.version ?? 0;
  }

  throwOnNextOpen(cause: Error): void {
    this.nextOpenThrow = cause;
  }

  failNextOpen(cause: unknown): void {
    this.nextOpenError = { cause };
  }

  blockNextOpen(event: IndexedDbVersionChangeLike): void {
    this.nextBlockedEvent = event;
  }

  failNextTransaction(cause: Error): void {
    this.nextTransactionError = cause;
  }

  failNextRequest(
    operation: MemoryIndexedDbRequestOperation,
    cause: unknown,
  ): void {
    this.nextRequestError = { operation, cause };
  }

  failNextCommit(cause: unknown): void {
    this.nextCommitError = { cause };
  }

  omitTransactionFromNextUpgrade(): void {
    this.omitUpgradeTransaction = true;
  }

  holdNextTransactionCommit(): void {
    this.holdNextCommit = true;
  }

  releaseNextCommit(): void {
    const held = this.heldCommits.shift();
    if (held === undefined) {
      throw new Error("No IndexedDB transaction commit is waiting.");
    }
    held.release();
  }

  get heldCommitCount(): number {
    return this.heldCommits.length;
  }

  takeRequestFailure(
    operation: MemoryIndexedDbRequestOperation,
  ): RequestFailure | null {
    const failure = this.nextRequestError;
    if (failure === null || failure.operation !== operation) return null;
    this.nextRequestError = null;
    return failure;
  }

  takeTransactionFailure(): Error | null {
    const failure = this.nextTransactionError;
    this.nextTransactionError = null;
    return failure;
  }

  takeCommitFailure(): InjectedFailure | null {
    const failure = this.nextCommitError;
    this.nextCommitError = null;
    return failure;
  }

  shouldHoldNextTransactionCommit(): boolean {
    if (!this.holdNextCommit) return false;
    this.holdNextCommit = false;
    return true;
  }

  holdCommit(commit: HeldCommit): void {
    this.heldCommits.push(commit);
  }

  private processOpen(
    request: MemoryOpenRequest,
    name: string,
    version: number,
  ): void {
    if (this.nextOpenError !== null) {
      const { cause } = this.nextOpenError;
      this.nextOpenError = null;
      request.fail(cause);
      return;
    }
    if (this.nextBlockedEvent !== null) {
      const event = this.nextBlockedEvent;
      this.nextBlockedEvent = null;
      request.blocked(event);
      return;
    }

    const prior = this.databases.get(name) ?? emptyDatabase(name);
    if (version < prior.version) {
      request.fail(
        domException(
          "VersionError",
          "The requested version is older than the stored version.",
        ),
      );
      return;
    }
    if (version === prior.version) {
      const connection = new MemoryDatabaseConnection(this, prior);
      request.setDatabase(connection);
      request.succeed();
      return;
    }

    const working = cloneDatabase(prior);
    const connection = new MemoryDatabaseConnection(this, working);
    request.setDatabase(connection);
    const transaction = new MemoryTransaction({
      factory: this,
      stores: working.stores,
      allowedStores: new Set(working.stores.keys()),
      mode: "readwrite",
      holdable: false,
      commitAction: () => {
        working.version = version;
        this.databases.set(name, working);
      },
    });
    connection.setUpgradeTransaction(transaction);
    const omitTransaction = this.omitUpgradeTransaction;
    this.omitUpgradeTransaction = false;
    request.setUpgradeTransaction(
      omitTransaction ? null : transaction,
    );
    transaction.onComplete(() => {
      request.setUpgradeTransaction(null);
      request.succeed();
    });
    transaction.onAbort(() => {
      request.setUpgradeTransaction(null);
      request.fail(transaction.error());
    });
    this.events.push(`upgrade:${prior.version}:${version}`);
    request.upgrade({
      oldVersion: prior.version,
      newVersion: version,
    });
  }

  private requireStore(
    databaseName: string,
    storeName: string,
  ): StoreState {
    const database = this.databases.get(databaseName);
    const store = database?.stores.get(storeName);
    if (store === undefined) {
      throw new Error(
        `IndexedDB store "${databaseName}/${storeName}" does not exist.`,
      );
    }
    return store;
  }
}

export function domException(
  name: string,
  message = `${name} from the in-memory IndexedDB adapter.`,
): DOMException {
  return new DOMException(message, name);
}

export async function flushIndexedDbEvents(): Promise<void> {
  await new Promise<void>(resolve => {
    setTimeout(resolve, 0);
  });
}
