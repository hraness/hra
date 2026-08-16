import { describe, test } from "bun:test";
import { assertProperty, fc } from "@hra-internal/test";

import { scheduledWakeDispatchDisposition } from "./schedules";

describe("scheduled wake dispatch projection laws", () => {
  test("only an exact singleton dispatch advances with a materialized wake", () => {
    assertProperty(
      fc.property(
        fc.record({
          id: fc.string({ minLength: 1, maxLength: 12 }),
          organizationId: fc.string({ minLength: 1, maxLength: 12 }),
          workspaceId: fc.string({ minLength: 1, maxLength: 12 }),
          key: fc.string({ minLength: 1, maxLength: 12 }),
          revision: fc.integer({ min: 1, max: 1_000 }),
          claimFence: fc.integer({ min: 0, max: 1_000 }),
        }),
        fc.integer({ min: 0, max: 1_000 }),
        (task, queuedDispatchCount) => {
          const queuedDispatch = {
            organizationId: task.organizationId,
            workspaceId: task.workspaceId,
            taskId: task.id,
            taskKey: task.key,
            phase: "queued",
            queuedTaskRevision: task.revision,
            queuedClaimFence: task.claimFence,
          };
          const disposition = scheduledWakeDispatchDisposition({
            queuedDispatchCount,
            task,
            queuedDispatch,
          });
          if (queuedDispatchCount === 0) {
            if (disposition !== "none") throw new Error("An empty dispatch set was not inert.");
            return;
          }
          if (queuedDispatchCount === 1) {
            if (disposition !== "advance") {
              throw new Error("An exact singleton dispatch did not advance.");
            }
            return;
          }
          if (disposition !== "invalid") {
            throw new Error("An ambiguous or mismatched dispatch projection did not fail closed.");
          }
        },
      ),
      { numRuns: 2_000 },
    );
  });

  test("changing any ownership, revision, fence, or phase coordinate fails closed", () => {
    assertProperty(
      fc.property(
        fc.record({
          id: fc.string({ minLength: 1, maxLength: 12 }),
          organizationId: fc.string({ minLength: 1, maxLength: 12 }),
          workspaceId: fc.string({ minLength: 1, maxLength: 12 }),
          key: fc.string({ minLength: 1, maxLength: 12 }),
          revision: fc.integer({ min: 1, max: 1_000 }),
          claimFence: fc.integer({ min: 0, max: 1_000 }),
        }),
        fc.constantFrom(
          "organizationId",
          "workspaceId",
          "taskId",
          "taskKey",
          "phase",
          "queuedTaskRevision",
          "queuedClaimFence",
        ),
        (task, changed) => {
          const exact = {
            organizationId: task.organizationId,
            workspaceId: task.workspaceId,
            taskId: task.id,
            taskKey: task.key,
            phase: "queued",
            queuedTaskRevision: task.revision,
            queuedClaimFence: task.claimFence,
          };
          const queuedDispatch = {
            ...exact,
            [changed]: changed === "queuedTaskRevision"
              ? task.revision + 1
              : changed === "queuedClaimFence"
                ? task.claimFence + 1
                : changed === "phase"
                  ? "leased"
                  : `${exact[changed]}\u0000foreign`,
          };
          const disposition = scheduledWakeDispatchDisposition({
            queuedDispatchCount: 1,
            task,
            queuedDispatch,
          });
          if (disposition !== "invalid") {
            throw new Error(`A ${changed} mismatch advanced a queued dispatch.`);
          }
        },
      ),
      { numRuns: 2_000 },
    );
  });
});
