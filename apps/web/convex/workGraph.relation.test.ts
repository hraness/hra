import { expect, test } from "bun:test";

import type { Id } from "./_generated/dataModel";
import type { QueryCtx } from "./_generated/server";
import { taskDetail, type TaskDoc } from "./workGraph";

test("a task with no body keeps the canonical empty description", async () => {
  const task = {
    _id: "task-a" as Id<"tasks">,
    _creationTime: 1,
    organizationId: "organization-a" as Id<"organizations">,
    workspaceId: "workspace-a" as Id<"workspaces">,
    publicId: "tsk_01HZZZZZZZZZZZZZZZZZZZZZZZ",
    key: "REL-0001",
    title: "Bodyless task",
    type: "task",
    priority: 1,
    status: "open",
    availableAt: 1,
    isReady: true,
    isBlocked: false,
    unresolvedBlockerCount: 0,
    cancelledBlockerCount: 0,
    revision: 1,
    reviewRevision: 1,
    claimFence: 0,
    createdAt: 1,
    updatedAt: 1,
  } satisfies TaskDoc;
  const db = {
    query: (table: string) => ({
      withIndex: () => ({
        unique: async () => table === "taskBodies" ? null : null,
        take: async () => [],
      }),
    }),
  };

  const detail = await taskDetail({ db } as unknown as QueryCtx, task);

  expect(detail?.description).toBe("");
  expect(detail?.labels).toEqual([]);
  expect(detail?.task.key).toBe(task.key);
});
