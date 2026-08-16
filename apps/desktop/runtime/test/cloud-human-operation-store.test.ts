import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import { applyMigrations } from "../src/state/database";
import {
  CloudHumanOperationConflict,
  CloudHumanOperationStore,
} from "../src/state/cloud-human-operation-store";

const WORKSPACE_ID = "wsp_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const OPERATION_ID = "op_01ARZ3NDEKTSV4RRFFQ69G5FAV";

function fixture() {
  const database = new Database(":memory:", { strict: true });
  database.exec("PRAGMA foreign_keys = ON");
  applyMigrations(database);
  return {
    database,
    store: new CloudHumanOperationStore(
      database,
      new Uint8Array(32).fill(0x51),
    ),
  };
}

function rename(name = "Cloud oprte") {
  return {
    kind: "workspace.rename" as const,
    operationId: OPERATION_ID,
    expectedWorkspaceRevision: 7,
    name,
  };
}

describe("cloud human operation journal", () => {
  test("replays an interrupted write with the exact durable UUIDv7", () => {
    const { database, store } = fixture();
    try {
      const first = store.begin({
        workspaceId: WORKSPACE_ID,
        intent: rename(),
        now: 1_720_000_000_000,
      });
      const recovered = new CloudHumanOperationStore(
        database,
        new Uint8Array(32).fill(0x51),
      ).begin({
        workspaceId: WORKSPACE_ID,
        intent: rename(),
        now: 1_720_000_100_000,
      });

      expect(first).toEqual(recovered);
      expect(first).toMatchObject({ state: "pending" });
    } finally {
      database.close();
    }
  });

  test("rejects changed commands under one portable operation ID", () => {
    const { database, store } = fixture();
    try {
      store.begin({
        workspaceId: WORKSPACE_ID,
        intent: rename(),
        now: 1_720_000_000_000,
      });
      expect(() =>
        store.begin({
          workspaceId: WORKSPACE_ID,
          intent: rename("Different command"),
          now: 1_720_000_000_001,
        })
      ).toThrow(CloudHumanOperationConflict);
      expect(() =>
        store.begin({
          workspaceId: "wsp_01ARZ3NDEKTSV4RRFFQ69G5FAW",
          intent: rename(),
          now: 1_720_000_000_002,
        })
      ).toThrow(CloudHumanOperationConflict);
    } finally {
      database.close();
    }
  });

  test("records and exactly replays terminal success and failure", () => {
    const { database, store } = fixture();
    try {
      store.begin({
        workspaceId: WORKSPACE_ID,
        intent: rename(),
        now: 1_720_000_000_000,
      });
      store.complete(OPERATION_ID, {
        ok: true,
        mutation: {
          operationId: OPERATION_ID,
          workspaceId: WORKSPACE_ID,
          commandKind: "workspace.rename",
          workspaceRevision: 8,
          projectionRevision: 8,
          result: { kind: "workspace", workspaceRevision: 8 },
        },
      }, 1_720_000_000_001);
      expect(store.begin({
        workspaceId: WORKSPACE_ID,
        intent: rename(),
      })).toMatchObject({
        state: "recorded",
        outcome: {
          ok: true,
          mutation: {
            operationId: OPERATION_ID,
            projectionRevision: 8,
          },
        },
      });

      const failureOperation = "op_01ARZ3NDEKTSV4RRFFQ69G5FAW";
      const failureIntent = {
        ...rename(),
        operationId: failureOperation,
      };
      store.begin({
        workspaceId: WORKSPACE_ID,
        intent: failureIntent,
        now: 1_720_000_000_002,
      });
      store.complete(failureOperation, {
        ok: false,
        error: {
          code: "policy_denied",
          message: "Sign in again.",
          retryable: false,
          action: "signIn",
        },
      }, 1_720_000_000_003);
      expect(store.begin({
        workspaceId: WORKSPACE_ID,
        intent: failureIntent,
      })).toEqual({
        state: "recorded",
        outcome: {
          ok: false,
          error: {
            code: "policy_denied",
            message: "Sign in again.",
            retryable: false,
            action: "signIn",
          },
        },
      });
    } finally {
      database.close();
    }
  });
});
