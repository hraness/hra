import { describe, expect, test } from "bun:test";
import {
  taskDomain,
  taskWorkspaceViewValues,
  type PortableInvalidation,
} from "@hraness/agent-tasks-protocol";

import {
  LOCAL_TASK_CHANGE_MAX_RETRY_DELAY_MS,
  LOCAL_TASK_DISPLAY_CHANGE_WINDOW_MS,
  LocalTaskChangeCoordinator,
  MAX_PENDING_LOCAL_TASK_DISPLAY_CHANGES,
  localTaskChangeDelivery,
  mergePortableTaskChanges,
  type PortableTaskChangeRecord,
} from "../src/tasks/local-task-change-coordinator";

const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

function publicId(prefix: string, value: number): string {
  let remaining = value;
  let locator = "";
  for (let index = 0; index < 26; index += 1) {
    locator = (alphabet[remaining % 32] ?? "0") + locator;
    remaining = Math.floor(remaining / 32);
  }
  return `${prefix}_${locator}`;
}

function taskChange(options: {
  readonly changeKind?: PortableTaskChangeRecord["changeKind"];
  readonly revision: number;
  readonly run?: number;
  readonly summary?: boolean;
}): PortableTaskChangeRecord {
  const run = options.run ?? 1;
  const changeKind = options.changeKind ?? "run.display_changed";
  const includeSummary = options.summary ??
    (changeKind === "run.admitted" || changeKind === "task.submitted");
  return taskDomain.portableTaskChangeRecordSchema.parse({
    workspaceId: publicId("wsp", 1),
    projectionRevision: options.revision,
    scope: "task_change",
    taskId: publicId("tsk", run),
    runId: `run_change_${String(run).padStart(4, "0")}`,
    changeKind,
    affectedProjections: [
      ...(includeSummary
        ? [{ projection: "workspace_summary" as const }]
        : []),
      {
        projection: "task_list",
        views: [...taskWorkspaceViewValues],
      },
      { projection: "task_detail" },
    ],
  });
}

function controlledCoordinator(
  beforeChange?: (
    change: PortableInvalidation,
    coordinator: LocalTaskChangeCoordinator,
  ) => void,
) {
  const published: PortableInvalidation[] = [];
  const scheduled = new Map<number, () => void>();
  const delays: number[] = [];
  let nextHandle = 1;
  const coordinator = new LocalTaskChangeCoordinator({
    cancel: (handle) => scheduled.delete(handle as number),
    onChange: (change) => {
      beforeChange?.(change, coordinator);
      published.push(change);
    },
    schedule: (callback, delayMs) => {
      const handle = nextHandle;
      nextHandle += 1;
      scheduled.set(handle, callback);
      delays.push(delayMs);
      return handle;
    },
  });
  return {
    coordinator,
    delays,
    flushScheduled: () => {
      const callbacks = [...scheduled.values()];
      scheduled.clear();
      for (const callback of callbacks) callback();
    },
    published,
    scheduled,
  };
}

describe("local task change coordinator", () => {
  test("classifies every portable task change kind exhaustively", () => {
    expect(taskDomain.portableTaskChangeKindValues.map((changeKind) => [
      changeKind,
      localTaskChangeDelivery(changeKind),
    ])).toEqual([
      ["run.admitted", "immediate"],
      ["run.display_changed", "coalesce_display"],
      ["run.event_appended", "immediate"],
      ["run.interaction_changed", "immediate"],
      ["run.phase_changed", "immediate"],
      ["task.submitted", "immediate"],
    ]);
  });

  test("coalesces one display burst to the newest revision", () => {
    const value = controlledCoordinator();
    value.coordinator.accept(taskChange({ revision: 4 }));
    value.coordinator.accept(taskChange({ revision: 6 }));

    expect(value.published).toEqual([]);
    expect(value.delays).toEqual([LOCAL_TASK_DISPLAY_CHANGE_WINDOW_MS]);
    expect(value.scheduled.size).toBe(1);
    value.flushScheduled();

    expect(value.published).toEqual([{
      workspaceId: publicId("wsp", 1),
      projectionRevision: 6,
      scope: "task_change",
      taskId: publicId("tsk", 1),
      runId: "run_change_0001",
      changeKind: "run.display_changed",
      affectedProjections: [{
        projection: "task_list",
        views: [...taskWorkspaceViewValues],
      }, {
        projection: "task_detail",
      }],
    }]);
  });

  test("flushes semantic and interaction-affecting changes immediately", () => {
    for (const changeKind of [
      "run.admitted",
      "run.event_appended",
      "run.interaction_changed",
      "run.phase_changed",
      "task.submitted",
    ] as const) {
      const value = controlledCoordinator();
      value.coordinator.accept(taskChange({ revision: 2 }));
      value.coordinator.accept(taskChange({
        changeKind,
        revision: 3,
      }));

      expect(value.published).toHaveLength(1);
      expect(value.published[0]).toMatchObject({
        changeKind,
        projectionRevision: 3,
      });
      const published = value.published[0];
      if (published?.scope !== "task_change") {
        throw new Error("Semantic task change degraded without backpressure");
      }
      expect(published.affectedProjections).toEqual(
        changeKind === "run.admitted" || changeKind === "task.submitted"
          ? [{ projection: "workspace_summary" }, {
              projection: "task_list",
              views: [...taskWorkspaceViewValues],
            }, { projection: "task_detail" }]
          : [{
              projection: "task_list",
              views: [...taskWorkspaceViewValues],
            }, { projection: "task_detail" }],
      );
      expect(value.scheduled.size).toBe(0);
    }
  });

  test("retains every affected projection when a terminal hint subsumes display", () => {
    const value = controlledCoordinator();
    value.coordinator.accept(taskChange({ revision: 2 }));
    value.coordinator.accept(taskChange({
      changeKind: "run.event_appended",
      revision: 3,
      summary: true,
    }));

    expect(value.published).toHaveLength(1);
    expect(value.published[0]).toMatchObject({
      projectionRevision: 3,
      affectedProjections: [{ projection: "workspace_summary" }, {
        projection: "task_list",
        views: [...taskWorkspaceViewValues],
      }, {
        projection: "task_detail",
      }],
    });
    expect(value.scheduled.size).toBe(0);
  });

  test("bounds pending identities and flushes the oldest before admission", () => {
    const value = controlledCoordinator();
    for (
      let run = 1;
      run <= MAX_PENDING_LOCAL_TASK_DISPLAY_CHANGES + 1;
      run += 1
    ) {
      value.coordinator.accept(taskChange({ revision: run + 1, run }));
    }

    expect(value.published).toHaveLength(1);
    expect(value.published[0]).toMatchObject({
      runId: "run_change_0001",
      projectionRevision: 2,
    });
    value.coordinator.flush();
    expect(value.published).toHaveLength(
      MAX_PENDING_LOCAL_TASK_DISPLAY_CHANGES + 1,
    );
  });

  test("degrades to one retained workspace refresh when scoped capacity cannot deliver", () => {
    let blocked = true;
    const value = controlledCoordinator(() => {
      if (blocked) throw new Error("oldest delivery is blocked");
    });
    for (
      let run = 1;
      run <= MAX_PENDING_LOCAL_TASK_DISPLAY_CHANGES;
      run += 1
    ) {
      value.coordinator.accept(taskChange({ revision: run + 1, run }));
    }

    expect(() => value.coordinator.accept(taskChange({
      revision: MAX_PENDING_LOCAL_TASK_DISPLAY_CHANGES + 2,
      run: MAX_PENDING_LOCAL_TASK_DISPLAY_CHANGES + 1,
    }))).not.toThrow();
    expect(value.published).toEqual([]);
    expect(value.scheduled.size).toBe(1);

    blocked = false;
    value.coordinator.flush();
    expect(value.published).toEqual([{
      workspaceId: publicId("wsp", 1),
      projectionRevision: MAX_PENDING_LOCAL_TASK_DISPLAY_CHANGES + 2,
      scope: "workspace",
    }]);
  });

  test("deduplicates revisions already represented by a published change", () => {
    const value = controlledCoordinator();
    value.coordinator.accept(taskChange({
      changeKind: "run.event_appended",
      revision: 5,
    }));
    value.coordinator.accept(taskChange({ revision: 5 }));
    value.coordinator.accept(taskChange({ revision: 4 }));
    value.flushScheduled();

    expect(value.published).toHaveLength(1);
    expect(value.published[0]).toMatchObject({ projectionRevision: 5 });
  });

  test("does not duplicate or regress a synchronously reentrant immediate head", () => {
    const value = controlledCoordinator((change, coordinator) => {
      if (change.projectionRevision === 1) {
        coordinator.accept(taskChange({
          changeKind: "run.phase_changed",
          revision: 2,
        }));
      }
    });

    value.coordinator.accept(taskChange({
      changeKind: "run.phase_changed",
      revision: 1,
    }));
    value.coordinator.accept(taskChange({
      changeKind: "run.phase_changed",
      revision: 2,
    }));

    expect(value.published.map(({ projectionRevision }) => projectionRevision))
      .toEqual([1, 2]);
    expect(value.scheduled.size).toBe(0);
  });

  test("retains a reentrant display change for the next bounded window", () => {
    const value = controlledCoordinator((change, coordinator) => {
      if (change.projectionRevision === 1) {
        coordinator.accept(taskChange({ revision: 2 }));
      }
    });

    value.coordinator.accept(taskChange({
      changeKind: "run.phase_changed",
      revision: 1,
    }));

    expect(value.published.map(({ projectionRevision }) => projectionRevision))
      .toEqual([1]);
    expect(value.scheduled.size).toBe(1);
    value.flushScheduled();
    expect(value.published.map(({ projectionRevision }) => projectionRevision))
      .toEqual([1, 2]);
    expect(value.scheduled.size).toBe(0);
  });

  test("retains a failed immediate change and retries it later", () => {
    let attempts = 0;
    const value = controlledCoordinator(() => {
      attempts += 1;
      if (attempts === 1) throw new Error("transient immediate failure");
    });

    expect(() => value.coordinator.accept(taskChange({
      changeKind: "run.phase_changed",
      revision: 1,
    }))).not.toThrow();
    expect(attempts).toBe(1);
    expect(value.published).toEqual([]);
    expect(value.scheduled.size).toBe(1);

    value.flushScheduled();
    expect(attempts).toBe(2);
    expect(value.published.map(({ projectionRevision }) => projectionRevision))
      .toEqual([1]);
    expect(value.scheduled.size).toBe(0);

    value.coordinator.accept(taskChange({
      changeKind: "run.phase_changed",
      revision: 1,
    }));
    expect(attempts).toBe(2);
  });

  test("retries a failed timed delivery once per bounded window", () => {
    let attempts = 0;
    const value = controlledCoordinator(() => {
      attempts += 1;
      if (attempts < 3) throw new Error("transient timed failure");
    });
    value.coordinator.accept(taskChange({ revision: 2 }));

    value.flushScheduled();
    expect(attempts).toBe(1);
    expect(value.published).toEqual([]);
    expect(value.scheduled.size).toBe(1);

    value.flushScheduled();
    expect(attempts).toBe(2);
    expect(value.published).toEqual([]);
    expect(value.scheduled.size).toBe(1);

    value.flushScheduled();
    expect(attempts).toBe(3);
    expect(value.published.map(({ projectionRevision }) => projectionRevision))
      .toEqual([2]);
    expect(value.scheduled.size).toBe(0);
    expect(value.delays).toEqual([
      LOCAL_TASK_DISPLAY_CHANGE_WINDOW_MS,
      LOCAL_TASK_DISPLAY_CHANGE_WINDOW_MS * 2,
      LOCAL_TASK_DISPLAY_CHANGE_WINDOW_MS * 4,
    ]);
  });

  test("caps persistent callback retry backoff without a hot loop", () => {
    let attempts = 0;
    const value = controlledCoordinator(() => {
      attempts += 1;
      throw new Error("persistent delivery failure");
    });
    value.coordinator.accept(taskChange({ revision: 2 }));

    for (let attempt = 1; attempt <= 8; attempt += 1) {
      value.flushScheduled();
      expect(attempts).toBe(attempt);
      expect(value.scheduled.size).toBe(1);
    }
    expect(value.delays).toEqual([
      16,
      32,
      64,
      128,
      256,
      512,
      LOCAL_TASK_CHANGE_MAX_RETRY_DELAY_MS,
      LOCAL_TASK_CHANGE_MAX_RETRY_DELAY_MS,
      LOCAL_TASK_CHANGE_MAX_RETRY_DELAY_MS,
    ]);
  });

  test("keeps a summary-capable kind when coalescing a newer base change", () => {
    const merged = mergePortableTaskChanges(
      taskChange({
        changeKind: "run.event_appended",
        revision: 2,
        summary: true,
      }),
      taskChange({
        changeKind: "run.phase_changed",
        revision: 3,
      }),
    );

    expect(merged.changeKind).toBe("run.event_appended");
    expect(merged.projectionRevision).toBe(3);
    expect(merged.affectedProjections[0]).toEqual({
      projection: "workspace_summary",
    });
  });

  test("closes and cancels retries even when final delivery throws", () => {
    const value = controlledCoordinator(() => {
      throw new Error("final delivery failed");
    });
    value.coordinator.accept(taskChange({ revision: 2 }));

    expect(() => value.coordinator.close()).toThrow("final delivery failed");
    expect(value.scheduled.size).toBe(0);
    expect(() => value.coordinator.accept(taskChange({ revision: 3 })))
      .toThrow("coordinator is closed");
    expect(() => value.coordinator.close()).not.toThrow();
  });

  test("flushes its bounded window on close and rejects later admission", () => {
    const value = controlledCoordinator();
    value.coordinator.accept(taskChange({ revision: 2 }));

    value.coordinator.close();

    expect(value.published).toHaveLength(1);
    expect(value.scheduled.size).toBe(0);
    expect(() => value.coordinator.accept(taskChange({ revision: 3 })))
      .toThrow("coordinator is closed");
    expect(() => value.coordinator.close()).not.toThrow();
  });
});
