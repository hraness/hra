import { describe, expect, test } from "bun:test";

import { parseDeviceRegistryPayload, type DeviceRegistryPayload } from "../hra/cloud";
import {
  accountBrowserLoginAllowed,
  accountRows,
  allScheduledTasks,
  archivedSessionRows,
  attentionEmailPresentation,
  commandTargetForMachine,
  isMachineOnline,
  machineLabelsByDevice,
  registryHeartbeatToleranceMs,
  scheduledTaskKindLabel,
  shortSessionId,
  sortMachines,
  toMachineView,
  type SessionHeadSummary,
} from "./settings-view";

const now = 1_760_000_000_000;
const minute = 60_000;

/**
 * The fixture goes through the daemon's own parser first, so a registry shape
 * this screen believes in but the projection would refuse never reaches the
 * derivations under test.
 */
function registry(overrides: Partial<DeviceRegistryPayload> = {}): DeviceRegistryPayload {
  const candidate = {
    accounts: [
      { label: "work", provider: "codex", publicId: "acct_one", status: "signed_in" },
      { label: "personal", provider: "claude", publicId: "acct_two", status: "signed_out" },
    ],
    daemonVersion: "0.3.0",
    defaultApprovalMode: "auto:all",
    defaultPreset: "ultra",
    heartbeatAt: now - minute,
    machineLabel: "studio",
    projects: [{ label: "hra", publicId: "proj_one" }],
    proseAutorespondConfigured: true,
    scheduledTasks: [
      {
        cadence: "every day at 09:00",
        id: "task_one",
        kind: "codex_automation",
        label: "morning sweep",
        nextRunAt: now + 3 * minute,
        sessionPublicId: "sess_one",
      },
      {
        cadence: "weekly",
        id: "task_two",
        kind: "hra_conversation",
        label: "weekly review",
        nextRunAt: null,
        sessionPublicId: null,
      },
    ],
    showThinkingDefault: false,
    version: 1,
    ...overrides,
  };
  const parsed = parseDeviceRegistryPayload(candidate);
  if (parsed === null) throw new Error("The registry fixture is not a valid projection.");
  return parsed;
}

describe("isMachineOnline", () => {
  test("is online while the hosted presence row holds the device", () => {
    expect(isMachineOnline({
      device: { online: true, status: "active" },
      heartbeatAt: now - 10 * registryHeartbeatToleranceMs,
      now,
    })).toBe(true);
  });

  test("falls back to a recent registry heartbeat when presence lags", () => {
    expect(isMachineOnline({
      device: { online: false, status: "active" },
      heartbeatAt: now - registryHeartbeatToleranceMs + 1,
      now,
    })).toBe(true);
  });

  test("is offline once the heartbeat passes the tolerance", () => {
    expect(isMachineOnline({
      device: { online: false, status: "active" },
      heartbeatAt: now - registryHeartbeatToleranceMs - 1,
      now,
    })).toBe(false);
  });

  test("is offline for a missing, pending, or revoked device row", () => {
    for (const device of [
      null,
      { online: true, status: "pending" } as const,
      { online: true, status: "revoked" } as const,
    ]) {
      expect(isMachineOnline({ device, heartbeatAt: now, now })).toBe(false);
    }
  });

  test("is offline when no heartbeat was ever published", () => {
    expect(isMachineOnline({
      device: { online: false, status: "active" },
      heartbeatAt: 0,
      now,
    })).toBe(false);
  });
});

describe("toMachineView", () => {
  test("decodes a registry into the row the machine card renders", () => {
    const notificationHours = {
      endMinute: 1_320,
      revision: 4,
      startMinute: 600,
      timeZone: "America/Puerto_Rico",
      version: 1,
    } as const;
    const view = toMachineView({
      device: { online: true, status: "active" },
      devicePublicId: "dev_one",
      now,
      notificationHours,
      attentionEmailEnabled: false,
      notificationPolicyFreshness: "current",
      notificationPolicyRevision: 4,
      payload: registry(),
      revision: 7,
      updatedAt: now - minute,
    });
    expect(view.label).toBe("studio");
    expect(view.daemonVersion).toBe("0.3.0");
    expect(view.defaultApprovalMode).toBe("auto:all");
    expect(view.defaultPreset).toBe("ultra");
    expect(view.showThinkingDefault).toBe(false);
    expect(view.proseAutorespondConfigured).toBe(true);
    expect(view.devicePublicId).toBe("dev_one");
    expect(view.deviceStatus).toBe("active");
    expect(view.notificationHours).toEqual(notificationHours);
    expect(view.notificationHoursStatus).toBe("available");
    expect(view.attentionEmailEnabled).toBe(false);
    expect(view.notificationPolicyFreshness).toBe("current");
    expect(view.notificationPolicyRevision).toBe(4);
    expect(view.revision).toBe(7);
    expect(view.online).toBe(true);
    expect(view.accounts.map((account) => account.label)).toEqual(["work", "personal"]);
    expect(view.projects.map((project) => project.label)).toEqual(["hra"]);
  });

  test("defaults an older registry to no displayable email consent", () => {
    const view = toMachineView({
      device: { online: true, status: "active" },
      devicePublicId: "dev_one",
      now,
      payload: registry(),
      revision: 1,
      updatedAt: now,
    });
    expect(view.attentionEmailEnabled).toBeNull();
    expect(view.notificationPolicyFreshness).toBe("unsupported");
    expect(view.notificationPolicyRevision).toBeNull();
  });

  test("labels every scheduled task by provider and carries its machine", () => {
    const view = toMachineView({
      device: null,
      devicePublicId: "dev_one",
      now,
      payload: registry(),
      revision: 1,
      updatedAt: now,
    });
    expect(view.scheduledTasks.map((task) => [task.label, task.kindLabel])).toEqual([
      ["morning sweep", "Codex"],
      ["weekly review", "HRA"],
    ]);
    for (const task of view.scheduledTasks) expect(task.machineLabel).toBe("studio");
  });

  test("names both scheduled task kinds", () => {
    expect(scheduledTaskKindLabel("codex_automation")).toBe("Codex");
    expect(scheduledTaskKindLabel("hra_conversation")).toBe("HRA");
  });
});

describe("attentionEmailPresentation", () => {
  test("reports current enabled and disabled revisions without creating a command", () => {
    expect(attentionEmailPresentation({
      attentionEmailEnabled: true,
      notificationPolicyFreshness: "current",
      notificationPolicyRevision: 9,
    })).toEqual({
      description: "Last published local email opt-in at notification policy revision 9.",
      label: "enabled",
      tone: "accent",
    });
    expect(attentionEmailPresentation({
      attentionEmailEnabled: false,
      notificationPolicyFreshness: "current",
      notificationPolicyRevision: 10,
    }).label).toBe("disabled");
  });

  test("never presents stale, unreadable, or legacy evidence as enabled", () => {
    for (const [freshness, label] of [
      ["stale", "refresh needed"],
      ["unreadable", "unavailable"],
      ["unsupported", "unavailable"],
    ] as const) {
      expect(attentionEmailPresentation({
        attentionEmailEnabled: null,
        notificationPolicyFreshness: freshness,
        notificationPolicyRevision: freshness === "unsupported" ? null : 4,
      }).label).toBe(label);
    }
  });
});

function machine(
  devicePublicId: string,
  machineLabel: string,
  online: boolean,
  overrides: Partial<DeviceRegistryPayload> = {},
) {
  return toMachineView({
    device: { online, status: "active" },
    devicePublicId,
    now,
    payload: registry({ machineLabel, ...overrides }),
    revision: 1,
    updatedAt: now,
  });
}

describe("machine and task ordering", () => {
  test("puts online machines first and then sorts by label", () => {
    const machines = sortMachines([
      machine("dev_c", "workshop", false),
      machine("dev_a", "studio", false),
      machine("dev_b", "laptop", true),
    ]);
    expect(machines.map((entry) => entry.label)).toEqual(["laptop", "studio", "workshop"]);
  });

  test("maps every device id to its machine label", () => {
    const labels = machineLabelsByDevice([machine("dev_a", "studio", true)]);
    expect(labels.get("dev_a")).toBe("studio");
    expect(labels.get("dev_missing")).toBeUndefined();
  });

  test("flattens every machine's tasks with the soonest run first and no run last", () => {
    const tasks = allScheduledTasks([
      machine("dev_a", "studio", true),
      machine("dev_b", "laptop", true, {
        scheduledTasks: [{
          cadence: "hourly",
          id: "task_three",
          kind: "codex_automation",
          label: "hourly sweep",
          nextRunAt: now + minute,
          sessionPublicId: null,
        }],
      }),
    ]);
    expect(tasks.map((task) => task.label)).toEqual([
      "hourly sweep",
      "morning sweep",
      "weekly review",
    ]);
  });

  test("lists every account with the machine it belongs to", () => {
    const rows = accountRows([machine("dev_a", "studio", true)]);
    expect(rows.map((row) => [row.label, row.machineLabel, row.status])).toEqual([
      ["work", "studio", "signed_in"],
      ["personal", "studio", "signed_out"],
    ]);
  });

  test("carries both local login gates and admits Codex only when both are on", () => {
    for (const deviceCommandsAllowed of [false, true]) {
      for (const accountLinkingAllowed of [false, true]) {
        const rows = accountRows([machine("dev_a", "studio", true, {
          accountLinkingAllowed,
          deviceCommandsAllowed,
        })]);
        expect(rows[0]).toMatchObject({ accountLinkingAllowed, deviceCommandsAllowed });
        expect(accountBrowserLoginAllowed(rows[0]!)).toBe(
          accountLinkingAllowed && deviceCommandsAllowed,
        );
        expect(accountBrowserLoginAllowed(rows[1]!)).toBe(false);
      }
    }
  });
});

describe("commandTargetForMachine", () => {
  const heads: readonly SessionHeadSummary[] = [
    { executionDevicePublicId: "dev_a", publicId: "sess_old", state: "idle", updatedAt: now - 10 },
    { executionDevicePublicId: "dev_a", publicId: "sess_new", state: "active", updatedAt: now },
    { executionDevicePublicId: "dev_b", publicId: "sess_other", state: "active", updatedAt: now },
  ];

  test("picks the machine's most recent live session", () => {
    expect(commandTargetForMachine(heads, "dev_a")).toEqual({
      executionDevicePublicId: "dev_a",
      sessionPublicId: "sess_new",
    });
  });

  test("never picks a terminal or orphaned session", () => {
    expect(commandTargetForMachine([
      { executionDevicePublicId: "dev_a", publicId: "s1", state: "terminal", updatedAt: now },
      { executionDevicePublicId: "dev_a", publicId: "s2", state: "orphaned", updatedAt: now },
    ], "dev_a")).toBeNull();
  });

  test("has no target for a machine with no session at all", () => {
    expect(commandTargetForMachine(heads, "dev_missing")).toBeNull();
  });
});

describe("archivedSessionRows", () => {
  const labels = new Map([["dev_a", "studio"]]);

  test("keeps only sessions whose decrypted metadata says archived", () => {
    const rows = archivedSessionRows([
      {
        executionDevicePublicId: "dev_a",
        metadata: { archived: true, name: "old work" },
        publicId: "sess_one",
        updatedAt: now - minute,
      },
      {
        executionDevicePublicId: "dev_a",
        metadata: { archived: false, name: "live work" },
        publicId: "sess_two",
        updatedAt: now,
      },
      {
        executionDevicePublicId: "dev_a",
        metadata: { name: "no flag" },
        publicId: "sess_three",
        updatedAt: now,
      },
      {
        executionDevicePublicId: "dev_a",
        metadata: null,
        publicId: "sess_four",
        updatedAt: now,
      },
    ], labels);
    expect(rows.map((row) => row.publicId)).toEqual(["sess_one"]);
    expect(rows[0]?.machineLabel).toBe("studio");
    expect(rows[0]?.title).toBe("old work");
  });

  test("falls back to a short id when the session has no name, newest first", () => {
    const rows = archivedSessionRows([
      {
        executionDevicePublicId: "dev_unknown",
        metadata: { archived: true, name: null },
        publicId: "sess_aaaaaaaaaaaaaaaa",
        updatedAt: now - minute,
      },
      {
        executionDevicePublicId: "dev_a",
        metadata: { archived: true, name: "newer" },
        publicId: "sess_two",
        updatedAt: now,
      },
    ], labels);
    expect(rows.map((row) => row.title)).toEqual(["newer", shortSessionId("sess_aaaaaaaaaaaaaaaa")]);
    expect(rows[1]?.machineLabel).toBeNull();
  });
});
