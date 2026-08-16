import { expect, test } from "bun:test";
import { assertProperty, fc } from "@hra-internal/test";

import {
  taskWorkspaceClientIntentSchema,
  taskWorkspaceProjectionBundleSchema,
  taskWorkspaceViewValues,
} from "./index";

const LOCATOR = "0123456789ABCDEFGHJKMNPQRS";
const WORKSPACE_ID = `wsp_${LOCATOR}`;
const TASK_ID = `tsk_${LOCATOR}`;
const task = {
  id: TASK_ID,
  key: "OPR-123ABCD",
  title: "Property task",
  type: "task" as const,
  priority: 2,
  availableAt: 1,
  isReady: true,
  unresolvedBlockerCount: 0,
  cancelledBlockerCount: 0,
  revision: 1,
  reviewRevision: 1,
  createdAt: 1,
  updatedAt: 1,
  status: "open" as const,
};

function emptyBundle(revision: number, view = "all" as const) {
  return {
    workspaceId: WORKSPACE_ID,
    view,
    selectedTaskId: null,
    continuationRevision: revision,
    projectionRevision: revision,
    firstPage: {
      workspaceId: WORKSPACE_ID,
      view,
      projectionRevision: revision,
      items: [],
      cursor: null,
      hasMore: false,
    },
    detail: null,
  };
}

test("client and projection schemas are total for arbitrary foreign values", () => {
  assertProperty(
    fc.property(fc.jsonValue(), (value) => {
      expect(() => taskWorkspaceClientIntentSchema.safeParse(value)).not.toThrow();
      expect(() => taskWorkspaceProjectionBundleSchema.safeParse(value)).not.toThrow();
    }),
    { numRuns: 2_000 },
  );
});

test("projection revision agreement holds for every generated positive revision", () => {
  assertProperty(
    fc.property(fc.integer({ min: 1, max: 1_000_000 }), (revision) => {
      const coherent = emptyBundle(revision);
      expect(taskWorkspaceProjectionBundleSchema.safeParse(coherent).success).toBeTrue();
      expect(taskWorkspaceProjectionBundleSchema.safeParse({
        ...coherent,
        firstPage: {
          ...coherent.firstPage,
          projectionRevision: revision + 1,
        },
      }).success).toBeFalse();
    }),
    { numRuns: 500 },
  );
});

test("continuation revisions are positive and cannot lead display revisions", () => {
  const bundle = emptyBundle(2);
  expect(taskWorkspaceProjectionBundleSchema.safeParse({
    ...bundle,
    continuationRevision: 1,
  }).success).toBeTrue();
  expect(taskWorkspaceProjectionBundleSchema.safeParse({
    ...bundle,
    continuationRevision: 0,
  }).success).toBeFalse();
  expect(taskWorkspaceProjectionBundleSchema.safeParse({
    ...bundle,
    continuationRevision: 3,
  }).success).toBeFalse();
});

test("an assigned-agent filter is legal exactly for the assigned view", () => {
  assertProperty(
    fc.property(fc.constantFrom(...taskWorkspaceViewValues), (view) => {
      const bundle = {
        ...emptyBundle(1),
        view,
        assignedAgentId: "agent_property",
        firstPage: {
          ...emptyBundle(1).firstPage,
          view,
          assignedAgentId: "agent_property",
        },
      };
      expect(taskWorkspaceProjectionBundleSchema.safeParse(bundle).success)
        .toBe(view === "assigned");
      expect(taskWorkspaceClientIntentSchema.safeParse({
        kind: "view.select",
        view,
        assignedAgentId: "agent_property",
      }).success).toBe(view === "assigned");
      expect(taskWorkspaceClientIntentSchema.safeParse({
        kind: "view.select",
        view,
      }).success).toBeTrue();
    }),
  );
});

test("every generated repeated page rejects duplicate public task IDs", () => {
  assertProperty(
    fc.property(fc.integer({ min: 2, max: 100 }), (length) => {
      const bundle = emptyBundle(1);
      expect(taskWorkspaceProjectionBundleSchema.safeParse({
        ...bundle,
        firstPage: {
          ...bundle.firstPage,
          items: Array.from(
            { length },
            () => ({ humanInput: null, run: null, task }),
          ),
        },
      }).success).toBeFalse();
    }),
    { numRuns: 200 },
  );
});
