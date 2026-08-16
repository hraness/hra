import { describe, expect, test } from "bun:test";
import { err, ok } from "@hraness/result";
import { z } from "@hra-internal/schema";

import {
  createIndexedDatabase,
  createZodIndexedDbCodec,
  defineIndexedDbStore,
  type IndexedDbCodec,
  type IndexedDbMigration,
} from "./indexed-db";
import {
  domException,
  flushIndexedDbEvents,
  MemoryIndexedDbFactory,
} from "./indexed-db-test";

const itemSchema = z.strictObject({
  id: z.string(),
  label: z.string(),
  count: z.number().int(),
});

const auditSchema = z.strictObject({
  id: z.string(),
  action: z.string(),
});

function isVoidFunction(value: unknown): value is () => void {
  return typeof value === "function";
}

function promiseReturningMigration(): unknown {
  return Promise.resolve();
}

const stores = {
  items: defineIndexedDbStore(
    createZodIndexedDbCodec(itemSchema),
  ),
  audits: defineIndexedDbStore(
    createZodIndexedDbCodec(auditSchema),
  ),
};

function standardDatabase(
  factory: MemoryIndexedDbFactory,
  name = "indexed-db-test",
) {
  return createIndexedDatabase({
    name,
    version: 1,
    stores,
    migrations: [
      {
        toVersion: 1,
        migrate(context) {
          context.createStore("items");
          context.createStore("audits");
        },
      },
    ],
    resolveIndexedDb: () => factory,
  });
}

function seedStandardDatabase(
  factory: MemoryIndexedDbFactory,
  name: string,
  items: readonly (
    readonly [IDBValidKey, z.input<typeof itemSchema>]
  )[] = [],
  audits: readonly (
    readonly [IDBValidKey, z.input<typeof auditSchema>]
  )[] = [],
): void {
  factory.seed(name, 1, { items, audits });
}

describe("createIndexedDatabase migrations", () => {
  test("runs only pending migrations, in order, with their exact contexts", async () => {
    const factory = new MemoryIndexedDbFactory();
    factory.seed("migration-order", 1, {
      items: [["existing", { id: "existing", label: "Before", count: 1 }]],
    });
    const order: string[] = [];
    const migrations = [
      {
        toVersion: 1,
        migrate() {
          order.push("unexpected-v1");
        },
      },
      {
        toVersion: 2,
        migrate(context) {
          order.push(`${context.fromVersion}->${context.toVersion}`);
          expect(context.hasStore("items")).toBe(true);
          context.createStore("audits");
        },
      },
      {
        toVersion: 3,
        migrate(context) {
          order.push(`${context.fromVersion}->${context.toVersion}`);
          const items = context.store("items");
          items.createIndex("by-label", "label");
        },
      },
    ] as const satisfies readonly IndexedDbMigration[];
    const database = createIndexedDatabase({
      name: "migration-order",
      version: 3,
      stores,
      migrations,
      resolveIndexedDb: () => factory,
    });

    const result = await database.transaction(
      ["items", "audits"],
      "readonly",
      async transaction => ({
        items: await transaction.store("items").count(),
        audits: await transaction.store("audits").count(),
      }),
    );

    expect(result).toEqual({
      ok: true,
      value: { items: 1, audits: 0 },
    });
    expect(order).toEqual(["1->2", "2->3"]);
    expect(factory.databaseVersion("migration-order")).toBe(3);
    expect(factory.storeNames("migration-order")).toEqual([
      "items",
      "audits",
    ]);
    expect(factory.indexNames("migration-order", "items")).toEqual([
      "by-label",
    ]);
  });

  test("rejects non-contiguous configuration synchronously", () => {
    const codec = createZodIndexedDbCodec(z.string());
    expect(() =>
      createIndexedDatabase({
        name: "bad-migrations",
        version: 2,
        stores: { values: defineIndexedDbStore(codec) },
        migrations: [
          { toVersion: 1, migrate() {} },
          { toVersion: 3, migrate() {} },
        ],
        resolveIndexedDb: () => null,
      }),
    ).toThrow("must target version 2");
  });

  test("aborts upgrades whose migration is asynchronous", async () => {
    const factory = new MemoryIndexedDbFactory();
    const database = createIndexedDatabase({
      name: "async-migration",
      version: 1,
      stores: {
        values: defineIndexedDbStore(
          createZodIndexedDbCodec(z.string()),
        ),
      },
      migrations: [
        {
          toVersion: 1,
          migrate: promiseReturningMigration,
        },
      ],
      resolveIndexedDb: () => factory,
    });

    const result = await database.transaction(
      ["values"],
      "readonly",
      transaction => transaction.store("values").count(),
    );

    expect(result).toMatchObject({
      ok: false,
      error: {
        kind: "transaction-failed",
        database: "async-migration",
        stage: "migration",
      },
    });
    expect(factory.databaseVersion("async-migration")).toBe(0);
  });

  test("honors a migration abort even when the migration catches its signal", async () => {
    const factory = new MemoryIndexedDbFactory();
    const database = createIndexedDatabase({
      name: "caught-migration-abort",
      version: 1,
      stores: {
        values: defineIndexedDbStore(
          createZodIndexedDbCodec(z.string()),
        ),
      },
      migrations: [
        {
          toVersion: 1,
          migrate(context) {
            context.createStore("values");
            try {
              context.abort("migration declined");
            } catch {
              // The abort is intentionally suppressed by hostile migration code.
            }
          },
        },
      ],
      resolveIndexedDb: () => factory,
    });

    const result = await database.transaction(
      ["values"],
      "readonly",
      transaction => transaction.store("values").count(),
    );

    expect(result).toEqual({
      ok: false,
      error: {
        kind: "aborted",
        database: "caught-migration-abort",
        stage: "migration",
        detail: "migration declined",
      },
    });
    expect(factory.databaseVersion("caught-migration-abort")).toBe(0);
  });
});

describe("createIndexedDatabase transactions", () => {
  test("resolves IndexedDB lazily for every operation", async () => {
    const factory = new MemoryIndexedDbFactory();
    seedStandardDatabase(factory, "lazy");
    let resolveCount = 0;
    const database = createIndexedDatabase({
      name: "lazy",
      version: 1,
      stores,
      migrations: [
        {
          toVersion: 1,
          migrate(context) {
            context.createStore("items");
            context.createStore("audits");
          },
        },
      ],
      resolveIndexedDb: () => {
        resolveCount += 1;
        return factory;
      },
    });

    expect(resolveCount).toBe(0);
    expect(await database.transaction(
      ["items"],
      "readonly",
      transaction => transaction.store("items").count(),
    )).toEqual({ ok: true, value: 0 });
    expect(resolveCount).toBe(1);
    expect(await database.transaction(
      ["audits"],
      "readonly",
      transaction => transaction.store("audits").count(),
    )).toEqual({ ok: true, value: 0 });
    expect(resolveCount).toBe(2);
    expect(factory.openCount).toBe(2);
    expect(factory.closeCount).toBe(2);
  });

  test("commits all named stores atomically and rolls all of them back on abort", async () => {
    const factory = new MemoryIndexedDbFactory();
    seedStandardDatabase(factory, "atomic", [
      ["item", { id: "item", label: "Before", count: 1 }],
    ], [
      ["audit", { id: "audit", action: "before" }],
    ]);
    const database = standardDatabase(factory, "atomic");

    const committed = await database.transaction(
      ["items", "audits"],
      "readwrite",
      async transaction => {
        await transaction.store("items").put(
          { id: "item", label: "Committed", count: 2 },
          "item",
        );
        await transaction.store("audits").put(
          { id: "audit", action: "committed" },
          "audit",
        );
        return "committed";
      },
    );
    expect(committed).toEqual({ ok: true, value: "committed" });
    expect(factory.rawValue("atomic", "items", "item")).toEqual({
      id: "item",
      label: "Committed",
      count: 2,
    });
    expect(factory.rawValue("atomic", "audits", "audit")).toEqual({
      id: "audit",
      action: "committed",
    });

    const aborted = await database.transaction(
      ["items", "audits"],
      "readwrite",
      async transaction => {
        await transaction.store("items").put(
          { id: "item", label: "Rolled back", count: 3 },
          "item",
        );
        await transaction.store("audits").put(
          { id: "audit", action: "rolled-back" },
          "audit",
        );
        try {
          transaction.abort("keep the previous pair");
        } catch {
          // Suppressing the signal must not suppress the raw transaction abort.
        }
        return "must-not-commit";
      },
    );
    expect(aborted).toEqual({
      ok: false,
      error: {
        kind: "aborted",
        database: "atomic",
        stage: "callback",
        detail: "keep the previous pair",
      },
    });
    expect(factory.rawValue("atomic", "items", "item")).toEqual({
      id: "item",
      label: "Committed",
      count: 2,
    });
    expect(factory.rawValue("atomic", "audits", "audit")).toEqual({
      id: "audit",
      action: "committed",
    });
  });

  test("does not resolve success until the transaction commit event", async () => {
    const factory = new MemoryIndexedDbFactory();
    seedStandardDatabase(factory, "commit-wait");
    factory.holdNextTransactionCommit();
    const database = standardDatabase(factory, "commit-wait");
    let settled = false;

    const resultPromise = database.transaction(
      ["items"],
      "readwrite",
      async transaction => {
        await transaction.store("items").put(
          { id: "held", label: "Held", count: 1 },
          "held",
        );
        return "callback-finished";
      },
    );
    void resultPromise.then(() => {
      settled = true;
    });
    for (
      let attempt = 0;
      attempt < 4 && factory.heldCommitCount === 0;
      attempt += 1
    ) {
      await flushIndexedDbEvents();
    }

    expect(factory.heldCommitCount).toBe(1);
    expect(settled).toBe(false);
    expect(
      factory.rawValue("commit-wait", "items", "held"),
    ).toBeUndefined();

    factory.releaseNextCommit();
    expect(await resultPromise).toEqual({
      ok: true,
      value: "callback-finished",
    });
    expect(factory.rawValue("commit-wait", "items", "held")).toEqual({
      id: "held",
      label: "Held",
      count: 1,
    });
  });

  test("rejects duplicate store scopes before resolving browser storage", async () => {
    let resolveCount = 0;
    const database = createIndexedDatabase({
      name: "invalid-scope",
      version: 1,
      stores,
      migrations: [
        {
          toVersion: 1,
          migrate(context) {
            context.createStore("items");
            context.createStore("audits");
          },
        },
      ],
      resolveIndexedDb: () => {
        resolveCount += 1;
        return null;
      },
    });

    const result = await database.transaction(
      ["items", "items"],
      "readonly",
      () => "not-run",
    );
    expect(result).toMatchObject({
      ok: false,
      error: { kind: "transaction-failed", stage: "transaction" },
    });
    expect(resolveCount).toBe(0);
  });
});

describe("createIndexedDatabase validation boundaries", () => {
  test("distinguishes missing values, stored undefined, and corruption", async () => {
    const undefinedCodec: IndexedDbCodec<undefined> = {
      encode: value =>
        value === undefined ? ok(undefined) : err("expected undefined"),
      decode: value =>
        value === undefined ? ok(undefined) : err("expected undefined"),
    };
    const factory = new MemoryIndexedDbFactory();
    factory.seed("read-boundary", 1, {
      items: [
        ["good", { id: "good", label: "Good", count: 1 }],
        ["corrupt", { id: "corrupt", label: 42 }],
      ],
      audits: [
        ["good", { id: "good", action: "ok" }],
        ["corrupt", { id: 1 }],
      ],
      optional: [["present", undefined]],
    });
    const database = createIndexedDatabase({
      name: "read-boundary",
      version: 1,
      stores: {
        ...stores,
        optional: defineIndexedDbStore(undefinedCodec),
      },
      migrations: [
        {
          toVersion: 1,
          migrate(context) {
            context.createStore("items");
            context.createStore("audits");
            context.createStore("optional");
          },
        },
      ],
      resolveIndexedDb: () => factory,
    });

    expect(await database.transaction(
      ["items"],
      "readonly",
      transaction => transaction.store("items").get("missing"),
    )).toEqual({ ok: true, value: null });
    expect(await database.transaction(
      ["optional"],
      "readonly",
      transaction => transaction.store("optional").get("present"),
    )).toEqual({ ok: true, value: undefined });

    const corruptGet = await database.transaction(
      ["items"],
      "readonly",
      transaction => transaction.store("items").get("corrupt"),
    );
    expect(corruptGet).toMatchObject({
      ok: false,
      error: {
        kind: "corruption",
        store: "items",
        operation: "get",
      },
    });

    const corruptGetAll = await database.transaction(
      ["audits"],
      "readonly",
      transaction => transaction.store("audits").getAll(),
    );
    expect(corruptGetAll).toMatchObject({
      ok: false,
      error: {
        kind: "corruption",
        store: "audits",
        operation: "get-all",
      },
    });
    expect(factory.rawValue(
      "read-boundary",
      "items",
      "corrupt",
    )).toEqual({ id: "corrupt", label: 42 });
  });

  test("rejects codec-invalid and non-cloneable writes without committing peers", async () => {
    const functionCodec: IndexedDbCodec<() => void> = {
      encode: value =>
        isVoidFunction(value)
          ? ok(value)
          : err("expected a function"),
      decode: value =>
        isVoidFunction(value)
          ? ok(value)
          : err("expected a function"),
    };
    const factory = new MemoryIndexedDbFactory();
    factory.seed("invalid-write", 1, {
      items: [["stable", { id: "stable", label: "Stable", count: 1 }]],
      functions: [],
    });
    const database = createIndexedDatabase({
      name: "invalid-write",
      version: 1,
      stores: {
        items: stores.items,
        functions: defineIndexedDbStore(functionCodec),
      },
      migrations: [
        {
          toVersion: 1,
          migrate(context) {
            context.createStore("items");
            context.createStore("functions");
          },
        },
      ],
      resolveIndexedDb: () => factory,
    });

    const schemaInvalid = await database.transaction(
      ["items"],
      "readwrite",
      transaction =>
        transaction.store("items").put(
          { id: "bad", label: "Bad", count: 1.5 },
          "bad",
        ),
    );
    expect(schemaInvalid).toMatchObject({
      ok: false,
      error: {
        kind: "invalid-value",
        store: "items",
        operation: "put",
      },
    });
    expect(
      factory.rawValue("invalid-write", "items", "bad"),
    ).toBeUndefined();

    const nonCloneable = await database.transaction(
      ["items", "functions"],
      "readwrite",
      async transaction => {
        await transaction.store("items").put(
          { id: "stable", label: "Changed", count: 2 },
          "stable",
        );
        await transaction.store("functions").put(
          () => undefined,
          "function",
        );
      },
    );
    expect(nonCloneable).toMatchObject({
      ok: false,
      error: {
        kind: "invalid-value",
        store: "functions",
        operation: "put",
      },
    });
    expect(factory.rawValue("invalid-write", "items", "stable")).toEqual({
      id: "stable",
      label: "Stable",
      count: 1,
    });
  });
});

describe("createIndexedDatabase failures", () => {
  test("returns unavailable, blocked, security, and open quota failures", async () => {
    const unavailable = createIndexedDatabase({
      name: "unavailable",
      version: 1,
      stores,
      migrations: [
        {
          toVersion: 1,
          migrate(context) {
            context.createStore("items");
            context.createStore("audits");
          },
        },
      ],
      resolveIndexedDb: () => null,
    });
    expect(await unavailable.transaction(
      ["items"],
      "readonly",
      () => undefined,
    )).toEqual({
      ok: false,
      error: { kind: "unavailable", database: "unavailable" },
    });

    const resolverSecurity = createIndexedDatabase({
      name: "resolver-security",
      version: 1,
      stores,
      migrations: [
        {
          toVersion: 1,
          migrate(context) {
            context.createStore("items");
            context.createStore("audits");
          },
        },
      ],
      resolveIndexedDb: () => {
        throw domException("SecurityError", "private mode");
      },
    });
    expect(await resolverSecurity.transaction(
      ["items"],
      "readonly",
      () => undefined,
    )).toMatchObject({
      ok: false,
      error: { kind: "security", stage: "resolve" },
    });

    const blockedFactory = new MemoryIndexedDbFactory();
    blockedFactory.blockNextOpen({
      oldVersion: 1,
      newVersion: 2,
    });
    const blocked = standardDatabase(blockedFactory, "blocked");
    expect(await blocked.transaction(
      ["items"],
      "readonly",
      () => undefined,
    )).toEqual({
      ok: false,
      error: {
        kind: "blocked",
        database: "blocked",
        requestedVersion: 1,
        oldVersion: 1,
        newVersion: 2,
      },
    });

    const quotaFactory = new MemoryIndexedDbFactory();
    quotaFactory.throwOnNextOpen(
      domException("QuotaExceededError", "database quota"),
    );
    const quota = standardDatabase(quotaFactory, "open-quota");
    expect(await quota.transaction(
      ["items"],
      "readonly",
      () => undefined,
    )).toMatchObject({
      ok: false,
      error: { kind: "quota", stage: "open" },
    });
  });

  test("classifies transaction, request, callback abort, and commit failures", async () => {
    const factory = new MemoryIndexedDbFactory();
    seedStandardDatabase(factory, "failure-stages", [
      ["item", { id: "item", label: "Original", count: 1 }],
    ]);
    const database = standardDatabase(factory, "failure-stages");

    factory.failNextTransaction(new Error("cannot start"));
    expect(await database.transaction(
      ["items"],
      "readonly",
      transaction => transaction.store("items").count(),
    )).toMatchObject({
      ok: false,
      error: {
        kind: "transaction-failed",
        stage: "transaction",
        detail: "cannot start",
      },
    });

    factory.failNextRequest(
      "get",
      domException("AbortError", "request aborted"),
    );
    expect(await database.transaction(
      ["items"],
      "readonly",
      transaction => transaction.store("items").get("item"),
    )).toMatchObject({
      ok: false,
      error: {
        kind: "aborted",
        stage: "request",
        detail: "request aborted",
      },
    });

    expect(await database.transaction(
      ["items"],
      "readwrite",
      transaction => {
        transaction.abort("caller stopped");
      },
    )).toEqual({
      ok: false,
      error: {
        kind: "aborted",
        database: "failure-stages",
        stage: "callback",
        detail: "caller stopped",
      },
    });

    factory.failNextCommit(
      domException("QuotaExceededError", "commit quota"),
    );
    expect(await database.transaction(
      ["items"],
      "readwrite",
      transaction =>
        transaction.store("items").put(
          { id: "item", label: "Not committed", count: 2 },
          "item",
        ),
    )).toMatchObject({
      ok: false,
      error: {
        kind: "quota",
        stage: "commit",
        detail: "commit quota",
      },
    });
    expect(factory.rawValue(
      "failure-stages",
      "items",
      "item",
    )).toEqual({ id: "item", label: "Original", count: 1 });
  });
});
