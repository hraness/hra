import { describe, expect, test } from "bun:test";

import {
  agentTasksReviewTask,
  createAgentTasksDirectWorld,
  parseAgentTasksDirectWorld,
} from "./world";

describe("Agent Tasks Direct world", () => {
  test("accepts, clones, and JSON-round-trips the canonical world", () => {
    const source = createAgentTasksDirectWorld();
    const parsed = parseAgentTasksDirectWorld(source);
    const roundTripped = parseAgentTasksDirectWorld(JSON.parse(JSON.stringify(source)) as unknown);

    expect(parsed).toEqual(source);
    expect(roundTripped).toEqual(source);
    expect(parsed).not.toBe(source);
    expect(parsed.views).not.toBe(source.views);
    expect(parsed.details).not.toBe(source.details);
  });

  test("rejects unknown keys and prototype-pollution keys at nested boundaries", () => {
    const world = createAgentTasksDirectWorld();
    expect(() => parseAgentTasksDirectWorld({ ...world, surprise: true })).toThrow();
    expect(() => parseAgentTasksDirectWorld({
      ...world,
      scripts: { ...world.scripts, surprise: true },
    })).toThrow();
    expect(() => parseAgentTasksDirectWorld({
      ...world,
      scripts: { ...world.scripts, ["__proto__"]: {} },
    })).toThrow("cannot contain the __proto__ key");
  });

  test("rejects selections without an active queue row and detail", () => {
    const missingRow = createAgentTasksDirectWorld();
    missingRow.views.all = { cursor: null, kind: "ready", tasks: [] };
    expect(() => parseAgentTasksDirectWorld(missingRow)).toThrow(
      "selected task must exist in the active ready view",
    );

    const missingDetail = createAgentTasksDirectWorld();
    missingDetail.details = missingDetail.details.filter(({ task }) => task.key !== agentTasksReviewTask.key);
    expect(() => parseAgentTasksDirectWorld(missingDetail)).toThrow(
      "selected task must have a detail fixture",
    );
  });

  test("rejects duplicate identities and command/response transition drift", () => {
    const duplicate = createAgentTasksDirectWorld();
    duplicate.views.all = {
      cursor: null,
      kind: "ready",
      tasks: [agentTasksReviewTask, structuredClone(agentTasksReviewTask)],
    };
    expect(() => parseAgentTasksDirectWorld(duplicate)).toThrow("all view task keys must be unique");

    const mismatch = createAgentTasksDirectWorld();
    mismatch.scripts.commands = [{
      request: {
        kind: "acceptSubmission",
        reviewRevision: 4,
        submissionId: "sub_01J3ABCDEFGHJKMNPQRSTVWXYZ",
        taskKey: agentTasksReviewTask.key,
      },
      outcome: {
        kind: "response",
        value: { requestId: "req_wrong", transition: "rejected" },
      },
    }];
    expect(() => parseAgentTasksDirectWorld(mismatch)).toThrow(
      "acceptSubmission cannot produce rejected",
    );
  });

  test("rejects duplicate, cross-task, and out-of-order run evidence", () => {
    const duplicate = createAgentTasksDirectWorld();
    const detail = duplicate.details[0];
    const run = detail?.runs?.[0];
    if (detail === undefined || run === undefined) throw new Error("The base world requires one run.");
    detail.runs = [run, structuredClone(run)];
    expect(() => parseAgentTasksDirectWorld(duplicate)).toThrow("Run IDs");

    const crossTask = createAgentTasksDirectWorld();
    const crossTaskRun = crossTask.details[0]?.runs?.[0];
    if (crossTaskRun === undefined) throw new Error("The base world requires one run.");
    crossTaskRun.taskKey = "AT-45EF6GH";
    expect(() => parseAgentTasksDirectWorld(crossTask)).toThrow("must belong");

    const outOfOrder = createAgentTasksDirectWorld();
    const events = outOfOrder.details[0]?.runs?.[0]?.events;
    if (events === undefined || events[1] === undefined) throw new Error("The base world requires two events.");
    events[1].sequence = events[0]?.sequence ?? 1;
    expect(() => parseAgentTasksDirectWorld(outOfOrder)).toThrow(
      "run view events violate sequence or display transcript laws",
    );
  });
});
