import { describe, expect, test } from "bun:test";

import {
  scheduledTaskLine,
  scheduledTaskNextRun,
  scheduledTasksBadgeLabel,
  sessionScheduledTasks,
} from "./scheduled-tasks";
import type { MachineView, ScheduledTaskView } from "./settings-view";

const now = 1_700_000_000_000;
const hour = 3_600_000;

function task(overrides: Partial<ScheduledTaskView> = {}): ScheduledTaskView {
  return {
    cadence: "every day at 09:00",
    id: "task-1",
    kind: "codex_automation",
    kindLabel: "Codex",
    label: "Morning sweep",
    machineLabel: "workshop",
    nextRunAt: now + hour,
    sessionPublicId: "session-a",
    ...overrides,
  };
}

function machine(
  label: string,
  scheduledTasks: readonly ScheduledTaskView[],
): MachineView {
  return {
    accountLinkingAllowed: false,
    accounts: [],
    daemonVersion: "0.5.0",
    defaultApprovalMode: "manual",
    defaultPreset: "ultra",
    deviceCommandsAllowed: true,
    devicePublicId: `device-${label}`,
    heartbeatAt: now,
    label,
    online: true,
    projects: [],
    proseAutorespondConfigured: false,
    revision: 1,
    scheduledTasks,
    sessionAdoption: null,
    showThinkingDefault: false,
    updatedAt: now,
  };
}

describe("formatting", () => {
  test("a next run reads as a distance, and no next run says so", () => {
    expect(scheduledTaskNextRun(now + 3 * hour, now)).toBe("in 3 hours");
    expect(scheduledTaskNextRun(now - hour, now)).toBe("1 hour ago");
    expect(scheduledTaskNextRun(null, now)).toBe("not scheduled");
  });

  test("the line names the provider, the cadence, and the next run", () => {
    expect(scheduledTaskLine(task(), now))
      .toBe("Codex · every day at 09:00 · next run in 1 hour");
    expect(scheduledTaskLine(task({ kind: "hra_conversation", kindLabel: "HRA" }), now))
      .toBe("HRA · every day at 09:00 · next run in 1 hour");
  });

  test("the badge counts in words a reader can read at a glance", () => {
    expect(scheduledTasksBadgeLabel(1)).toBe("1 scheduled task");
    expect(scheduledTasksBadgeLabel(4)).toBe("4 scheduled tasks");
  });
});

describe("sessionScheduledTasks", () => {
  test("selects only the tasks bound to this session", () => {
    const view = sessionScheduledTasks(
      [machine("workshop", [
        task({ id: "mine", sessionPublicId: "session-a" }),
        task({ id: "other", sessionPublicId: "session-b" }),
        task({ id: "loose", sessionPublicId: null }),
      ])],
      "session-a",
      now,
    );
    expect(view.rows.map((row) => row.id)).toEqual(["mine"]);
    expect(view.badgeLabel).toBe("1 scheduled task");
  });

  test("reads every machine, because a session keeps its id across machines", () => {
    const view = sessionScheduledTasks(
      [
        machine("workshop", [task({ id: "here", nextRunAt: now + 2 * hour })]),
        machine("attic", [
          task({ id: "there", machineLabel: "attic", nextRunAt: now + hour }),
        ]),
      ],
      "session-a",
      now,
    );
    expect(view.rows.map((row) => row.id)).toEqual(["there", "here"]);
    expect(view.rows.map((row) => row.machineLabel)).toEqual(["attic", "workshop"]);
    expect(view.badgeLabel).toBe("2 scheduled tasks");
  });

  test("soonest first, and a task with no next run is last rather than overdue", () => {
    const view = sessionScheduledTasks(
      [machine("workshop", [
        task({ id: "unscheduled", nextRunAt: null }),
        task({ id: "later", nextRunAt: now + 5 * hour }),
        task({ id: "sooner", nextRunAt: now + hour }),
      ])],
      "session-a",
      now,
    );
    expect(view.rows.map((row) => row.id)).toEqual(["sooner", "later", "unscheduled"]);
    expect(view.rows.at(-1)?.nextRunLabel).toBe("not scheduled");
  });

  test("carries the formatted line for each row", () => {
    const view = sessionScheduledTasks(
      [machine("workshop", [task({ cadence: "hourly", nextRunAt: now + 2 * hour })])],
      "session-a",
      now,
    );
    expect(view.rows[0]?.line).toBe("Codex · hourly · next run in 2 hours");
  });

  test("no machine, no match, and no session all render nothing", () => {
    expect(sessionScheduledTasks([], "session-a", now).rows).toEqual([]);
    expect(sessionScheduledTasks([], "session-a", now).badgeLabel).toBe("");
    expect(sessionScheduledTasks(
      [machine("workshop", [task({ sessionPublicId: "session-b" })])],
      "session-a",
      now,
    ).rows).toEqual([]);
    expect(sessionScheduledTasks([machine("workshop", [task()])], null, now).rows).toEqual([]);
    expect(sessionScheduledTasks([machine("workshop", [task()])], "", now).rows).toEqual([]);
  });
});
