import { describe, expect, test } from "bun:test";

import { runtimeProtocolVersion } from "../../../contracts/runtime";
import { applyRuntimeEvent } from "./projection";
import {
  accountUpsertEvent,
  emptyRuntimeSnapshot,
  fixtureAccount,
  snapshotInvalidatedEvent,
} from "./test-fixtures";

describe("renderer runtime projection", () => {
  test("projects semantic runner state", () => {
    expect(applyRuntimeEvent(emptyRuntimeSnapshot(), {
      version: runtimeProtocolVersion,
      sequence: 1,
      event: {
        type: "runner.changed",
        runner: { state: "attention", reason: "noRepository" },
      },
    })).toMatchObject({
      kind: "applied",
      snapshot: { runner: { state: "attention", reason: "noRepository" } },
    });
  });

  test("upserts and removes account lifecycle state", () => {
    const initial = emptyRuntimeSnapshot();
    const event = accountUpsertEvent(1);
    const first = applyRuntimeEvent(initial, event);
    if (first.kind !== "applied") throw new Error("Expected account upsert to apply");
    expect(first.snapshot.accounts).toHaveLength(1);
    if (event.event.type !== "account.upserted") {
      throw new Error("Expected account upsert fixture");
    }
    expect(first.snapshot.accounts[0]).not.toBe(event.event.account);
    expect(first.snapshot.runtime).toBe(initial.runtime);
    expect(first.snapshot.runner).toBe(initial.runner);
    expect(first.snapshot.retainedAccountLocalData).toBe(initial.retainedAccountLocalData);
    expect(first.snapshot.humanAccount).toBe(initial.humanAccount);

    const updated = fixtureAccount({ revision: 2, label: "Updated" });
    const second = applyRuntimeEvent(first.snapshot, accountUpsertEvent(2, updated));
    if (second.kind !== "applied") throw new Error("Expected account update to apply");
    expect(second.snapshot.accounts).toEqual([updated]);

    const removed = applyRuntimeEvent(second.snapshot, {
      version: runtimeProtocolVersion,
      sequence: 3,
      event: { type: "account.removed", accountProfileId: updated.id },
    });
    expect(removed).toMatchObject({ kind: "applied", snapshot: { accounts: [] } });
  });

  test("ignores duplicate delivery and reports gaps", () => {
    const event = accountUpsertEvent(1);
    const first = applyRuntimeEvent(emptyRuntimeSnapshot(), event);
    if (first.kind !== "applied") throw new Error("Expected account event to apply");
    expect(applyRuntimeEvent(first.snapshot, event)).toEqual({
      kind: "ignored",
      snapshot: first.snapshot,
      sequence: 1,
    });
    expect(applyRuntimeEvent(first.snapshot, accountUpsertEvent(3))).toEqual({
      kind: "gap",
      snapshot: first.snapshot,
      expectedSequence: 2,
      receivedSequence: 3,
    });
  });

  test("requests an authoritative resnapshot on invalidation", () => {
    const initial = emptyRuntimeSnapshot(8);
    expect(applyRuntimeEvent(initial, snapshotInvalidatedEvent(12))).toEqual({
      kind: "invalidated",
      snapshot: initial,
      sequence: 12,
      reason: "projectionOverflow",
    });
    expect(applyRuntimeEvent(initial, {
      version: runtimeProtocolVersion,
      sequence: 12,
      event: { type: "snapshot.invalidated", reason: "harnessChanged" },
    })).toEqual({
      kind: "invalidated",
      snapshot: initial,
      sequence: 12,
      reason: "harnessChanged",
    });
  });

  test("rejects exhausted snapshot revisions before applying an event", () => {
    const initial = {
      ...emptyRuntimeSnapshot(),
      revision: Number.MAX_SAFE_INTEGER,
    };
    expect(() => applyRuntimeEvent(initial, accountUpsertEvent(1))).toThrow(
      "runtime projection revision exhausted",
    );
    expect(initial.accounts).toEqual([]);
  });

  test("advances Native order for task invalidations without adding task state", () => {
    const initial = emptyRuntimeSnapshot(4);
    const result = applyRuntimeEvent(initial, {
      version: runtimeProtocolVersion,
      sequence: 5,
      event: {
        type: "task.invalidated",
        invalidation: {
          workspaceId: "wsp_00000000000000000000000000",
          projectionRevision: 12,
          scope: "task_list",
          view: "ready",
        },
      },
    });
    expect(result).toMatchObject({
      kind: "applied",
      snapshot: { lastSequence: 5, revision: initial.revision + 1 },
    });
    if (result.kind !== "applied") throw new Error("Expected invalidation to advance");
    expect("tasks" in result.snapshot).toBeFalse();
    expect("taskListPage" in result.snapshot).toBeFalse();
  });
});
