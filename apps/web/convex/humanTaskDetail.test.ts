import { describe, expect, test } from "bun:test";

import {
  detailCollectionValues,
  detailEvidenceHasSafeUrls,
  eventSummariesAreExhaustive,
  humanTaskDetailRowBelongsToTask,
  humanTaskEventSummary,
} from "./humanTaskDetail";

describe("human task detail tenant boundary", () => {
  const task = {
    _id: "task_a",
    organizationId: "org_a",
    workspaceId: "workspace_a",
  };

  test("requires the organization, workspace, and task tuple", () => {
    expect(
      humanTaskDetailRowBelongsToTask(
        { organizationId: "org_a", taskId: "task_a", workspaceId: "workspace_a" },
        task,
      ),
    ).toBeTrue();
    expect(
      humanTaskDetailRowBelongsToTask(
        { organizationId: "org_b", taskId: "task_a", workspaceId: "workspace_a" },
        task,
      ),
    ).toBeFalse();
    expect(
      humanTaskDetailRowBelongsToTask(
        { organizationId: "org_a", taskId: "task_b", workspaceId: "workspace_a" },
        task,
      ),
    ).toBeFalse();
  });
});

describe("human task detail public mapping", () => {
  test("names every collection whose result may be truncated", () => {
    expect(detailCollectionValues).toEqual([
      "blockers",
      "children",
      "comments",
      "dependents",
      "events",
      "references",
      "runs",
    ]);
  });

  test("has a non-empty human summary for every event type", () => {
    expect(eventSummariesAreExhaustive()).toBeTrue();
    expect(humanTaskEventSummary("task.claim_expired")).toContain("expired");
    expect(humanTaskEventSummary("dependency.removed")).toContain("removed");
  });

  test("accepts only credential-free HTTPS submission links", () => {
    expect(
      detailEvidenceHasSafeUrls([
        { kind: "pull_request", url: "https://github.com/acme/tasks/pull/1" },
        { kind: "commit", sha: "abc123", url: "https://github.com/acme/tasks/commit/abc123" },
        { kind: "test", command: "bun test" },
      ]),
    ).toBeTrue();
    expect(
      detailEvidenceHasSafeUrls([
        { kind: "artifact", name: "report", url: "https://token@example.com/report" },
      ]),
    ).toBeFalse();
    expect(
      detailEvidenceHasSafeUrls([
        { kind: "url", label: "local", url: "http://localhost/a" },
      ]),
    ).toBeFalse();
  });
});
