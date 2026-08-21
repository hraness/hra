import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import { applyMigrations } from "../src/state/database";
import {
  HumanOrganizationOperationConflict,
  HumanOrganizationOperationStore,
} from "../src/state/human-organization-operation-store";

const OPERATION_ID = "operation-create-organization-one";

function fixture() {
  const database = new Database(":memory:", { strict: true });
  database.exec("PRAGMA foreign_keys = ON");
  applyMigrations(database);
  return {
    database,
    store: new HumanOrganizationOperationStore(database),
  };
}

describe("human organization provisioning journal", () => {
  test("durably aliases a concurrent same-name operation through completion", () => {
    const { database, store } = fixture();
    try {
      const first = store.begin({
        operationId: OPERATION_ID,
        name: "Studio",
        now: 1_720_000_000_000,
      });
      if (first.state !== "started") {
        throw new Error("A new organization operation must be started.");
      }
      expect(store.begin({
        operationId: OPERATION_ID,
        name: "Studio",
        now: 1_720_000_000_100,
      })).toEqual(first);
      const aliasOperationId = "operation-create-organization-two";
      expect(store.begin({
        operationId: aliasOperationId,
        name: "Studio",
        now: 1_720_000_000_200,
      })).toEqual(first);
      expect(store.started()).toEqual([first]);
      store.complete(first.operationId, {
        ok: false,
        error: {
          code: "PROVISIONING_FAILED",
          message: "Organization provisioning failed.",
          retryable: false,
        },
      }, 1_720_000_000_300);
      expect(store.begin({
        operationId: aliasOperationId,
        name: "Studio",
        now: 1_720_000_000_400,
      })).toEqual({
        state: "recorded",
        operationId: first.operationId,
        outcome: {
          ok: false,
          error: {
            code: "PROVISIONING_FAILED",
            message: "Organization provisioning failed.",
            retryable: false,
          },
        },
      });
      expect(database.query<{ count: number }, []>(`
        SELECT count(*) AS count FROM human_organization_operations
      `).get()).toEqual({ count: 1 });
    } finally {
      database.close();
    }
  });

  test("pages fairly beyond one hundred starts and supports exact lookup", () => {
    const { database, store } = fixture();
    try {
      for (let index = 0; index < 101; index += 1) {
        store.begin({
          operationId: `operation-page-${String(index).padStart(3, "0")}`,
          name: `Studio ${String(index)}`,
          now: 1_720_000_000_000 + index,
        });
      }
      const first = store.startedPage({ limit: 100 });
      expect(first.operations).toHaveLength(100);
      expect(first.nextCursor).not.toBeNull();
      if (first.nextCursor === null) {
        throw new Error("The first organization page must expose a cursor.");
      }
      const second = store.startedPage({
        after: first.nextCursor,
        limit: 100,
      });
      expect(second.operations.map(({ operationId }) => operationId)).toEqual([
        "operation-page-100",
      ]);
      expect(second.nextCursor).toBeNull();
      expect(store.startedById("operation-page-100")).toMatchObject({
        state: "started",
        operationId: "operation-page-100",
        name: "Studio 100",
      });
    } finally {
      database.close();
    }
  });

  test("rejects reuse of an operation ID for a different name", () => {
    const { database, store } = fixture();
    try {
      store.begin({
        operationId: OPERATION_ID,
        name: "Studio",
        now: 1_720_000_000_000,
      });
      expect(() =>
        store.begin({
          operationId: OPERATION_ID,
          name: "Other studio",
          now: 1_720_000_000_100,
        })
      ).toThrow(HumanOrganizationOperationConflict);
    } finally {
      database.close();
    }
  });

  test("records terminal provisioning outcomes for exact replay", () => {
    const { database, store } = fixture();
    try {
      store.begin({
        operationId: OPERATION_ID,
        name: "Studio",
        now: 1_720_000_000_000,
      });
      store.complete(OPERATION_ID, {
        ok: true,
        organization: {
          id: "org_01ARZ3NDEKTSV4RRFFQ69G5FAV",
          name: "Studio",
          role: "owner",
          status: "active",
        },
      }, 1_720_000_000_100);
      expect(store.started()).toEqual([]);
      expect(store.begin({
        operationId: OPERATION_ID,
        name: "Studio",
      })).toMatchObject({
        state: "recorded",
        outcome: {
          ok: true,
          organization: {
            id: "org_01ARZ3NDEKTSV4RRFFQ69G5FAV",
          },
        },
      });

      const failedOperation = "operation-create-organization-failed";
      store.begin({
        operationId: failedOperation,
        name: "Failed studio",
        now: 1_720_000_000_200,
      });
      store.complete(failedOperation, {
        ok: false,
        error: {
          code: "PROVISIONING_FAILED",
          message: "Organization provisioning failed.",
          retryable: false,
        },
      }, 1_720_000_000_300);
      expect(store.begin({
        operationId: failedOperation,
        name: "Failed studio",
      })).toEqual({
        state: "recorded",
        operationId: failedOperation,
        outcome: {
          ok: false,
          error: {
            code: "PROVISIONING_FAILED",
            message: "Organization provisioning failed.",
            retryable: false,
          },
        },
      });
    } finally {
      database.close();
    }
  });
});
