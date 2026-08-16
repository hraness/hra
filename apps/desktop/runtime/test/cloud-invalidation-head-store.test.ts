import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import { applyMigrations } from "../src/state/database";
import { CloudInvalidationHeadStore } from "../src/state/cloud-invalidation-head-store";

const WORKSPACE_ID = "wsp_01ARZ3NDEKTSV4RRFFQ69G5FAV";

function fixture() {
  const database = new Database(":memory:", { strict: true });
  database.exec("PRAGMA foreign_keys = ON");
  applyMigrations(database);
  return {
    database,
    store: new CloudInvalidationHeadStore(database),
  };
}

describe("cloud invalidation resume heads", () => {
  test("advances monotonically for one principal and survives restart", () => {
    const { database, store } = fixture();
    try {
      expect(store.read(WORKSPACE_ID, "user_one")).toBe(0);
      store.advance({
        workspaceId: WORKSPACE_ID,
        accountUserId: "user_one",
        credentialGeneration: 2,
        projectionHead: 12,
        now: 100,
      });
      store.advance({
        workspaceId: WORKSPACE_ID,
        accountUserId: "user_one",
        credentialGeneration: 3,
        projectionHead: 7,
        now: 101,
      });
      expect(
        new CloudInvalidationHeadStore(database).read(
          WORKSPACE_ID,
          "user_one",
        ),
      ).toBe(12);
    } finally {
      database.close();
    }
  });

  test("never exposes another human principal's resume point", () => {
    const { database, store } = fixture();
    try {
      store.advance({
        workspaceId: WORKSPACE_ID,
        accountUserId: "user_one",
        credentialGeneration: 2,
        projectionHead: 12,
        now: 100,
      });
      expect(store.read(WORKSPACE_ID, "user_two")).toBe(0);
      store.advance({
        workspaceId: WORKSPACE_ID,
        accountUserId: "user_two",
        credentialGeneration: 1,
        projectionHead: 3,
        now: 101,
      });
      expect(store.read(WORKSPACE_ID, "user_one")).toBe(0);
      expect(store.read(WORKSPACE_ID, "user_two")).toBe(3);
    } finally {
      database.close();
    }
  });

  test("rejects negative or non-integer durable clocks", () => {
    const { database, store } = fixture();
    try {
      expect(() =>
        store.advance({
          workspaceId: WORKSPACE_ID,
          accountUserId: "user_one",
          credentialGeneration: -1,
          projectionHead: 0,
          now: 100,
        })
      ).toThrow(TypeError);
      expect(() =>
        store.advance({
          workspaceId: WORKSPACE_ID,
          accountUserId: "user_one",
          credentialGeneration: 1,
          projectionHead: 1.5,
          now: 100,
        })
      ).toThrow(TypeError);
    } finally {
      database.close();
    }
  });
});
