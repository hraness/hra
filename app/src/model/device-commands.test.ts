import { describe, expect, test } from "bun:test";

import { parseDeviceCommandPayload, parseDeviceRegistryPayload } from "../hra/cloud";
import {
  accountLoginStartCommand,
  accountLoginStatusCommand,
  defaultSessionStartPreset,
  deviceCommandNotice,
  sessionStartCommand,
  sessionStartTargets,
  usageRefreshCommand,
} from "./device-commands";
import { toMachineView, type MachineView } from "./settings-view";

/*
 * The daemon's own parser is the oracle. A builder that adds or drops a field,
 * or that lets a filesystem path through, fails here rather than at the machine.
 */
function accepted(payload: unknown): unknown {
  const parsed = parseDeviceCommandPayload(payload);
  expect(parsed).not.toBeNull();
  return parsed;
}

const now = 1_760_000_000_000;

function machine(overrides: Partial<Readonly<{
  accountLinkingAllowed: boolean;
  accounts: readonly Readonly<{
    label: string;
    provider: "codex" | "claude";
    publicId: string;
    status: "login_pending" | "recovery_required" | "signed_in" | "signed_out";
  }>[];
  deviceCommandsAllowed: boolean;
  devicePublicId: string;
  machineLabel: string;
  projects: readonly Readonly<{ label: string; publicId: string }>[];
}>> = {}): MachineView {
  const payload = parseDeviceRegistryPayload({
    accountLinkingAllowed: overrides.accountLinkingAllowed ?? false,
    accounts: overrides.accounts ?? [
      { label: "Work", provider: "codex", publicId: "acct_primary0001", status: "signed_in" },
    ],
    daemonVersion: "0.4.1",
    defaultApprovalMode: "auto:all",
    defaultPreset: "ultra",
    deviceCommandsAllowed: overrides.deviceCommandsAllowed ?? true,
    heartbeatAt: now - 1_000,
    machineLabel: overrides.machineLabel ?? "Studio",
    projects: overrides.projects ?? [
      { label: "Control plane", publicId: "proj_alpha000001" },
    ],
    proseAutorespondConfigured: false,
    scheduledTasks: [],
    showThinkingDefault: false,
    version: 1,
  });
  if (payload === null) throw new Error("registry fixture is not valid");
  return toMachineView({
    device: null,
    devicePublicId: overrides.devicePublicId ?? "device_studio01",
    now,
    payload,
    revision: 1,
    updatedAt: now,
  });
}

describe("device command builders", () => {
  test("the composer default is Sol Ultra", () => {
    expect(defaultSessionStartPreset).toBe("ultra");
  });

  test("builds a session start that the daemon parser accepts", () => {
    expect(accepted(sessionStartCommand({
      accountPublicId: "acct_primary0001",
      preset: defaultSessionStartPreset,
      projectPublicId: "proj_alpha000001",
      prompt: "  continue the migration  ",
      provider: "codex",
    }))).toEqual({
      accountPublicId: "acct_primary0001",
      kind: "session_start",
      preset: "ultra",
      projectPublicId: "proj_alpha000001",
      prompt: "continue the migration",
      provider: "codex",
    });
  });

  test("refuses an empty prompt and a prompt carrying a filesystem path", () => {
    expect(() => sessionStartCommand({
      accountPublicId: "acct_primary0001",
      preset: "ultra",
      projectPublicId: "proj_alpha000001",
      prompt: "   ",
      provider: "codex",
    })).toThrow("A new session needs a prompt.");
    expect(() => sessionStartCommand({
      accountPublicId: "acct_primary0001",
      preset: "ultra",
      projectPublicId: "proj_alpha000001",
      prompt: "read /etc/hosts",
      provider: "codex",
    })).toThrow("The device command payload is not valid.");
  });

  test("builds the three machine-scoped commands", () => {
    expect(accepted(accountLoginStartCommand("acct_primary0001")))
      .toEqual({ accountPublicId: "acct_primary0001", kind: "account_login_start" });
    expect(accepted(accountLoginStatusCommand())).toEqual({ kind: "account_login_status" });
    expect(accepted(usageRefreshCommand())).toEqual({ kind: "usage_refresh" });
  });
});

describe("session start targets", () => {
  test("offers one entry per signed-in account, carrying its machine's projects", () => {
    expect(sessionStartTargets([machine()])).toEqual([
      {
        accountLabel: "Work",
        accountPublicId: "acct_primary0001",
        deviceCommandsAllowed: true,
        machineLabel: "Studio",
        machineOnline: false,
        projects: [{ label: "Control plane", publicId: "proj_alpha000001" }],
        provider: "codex",
        targetDevicePublicId: "device_studio01",
      },
    ]);
  });

  test("never offers a target the daemon would refuse", () => {
    expect(sessionStartTargets([machine({ deviceCommandsAllowed: false })])).toEqual([]);
    expect(sessionStartTargets([machine({ projects: [] })])).toEqual([]);
    expect(sessionStartTargets([machine({
      accounts: [
        { label: "Work", provider: "codex", publicId: "acct_primary0001", status: "signed_out" },
      ],
    })])).toEqual([]);
  });

  test("a registry written before device commands existed still offers its accounts", () => {
    const payload = parseDeviceRegistryPayload({
      accounts: [
        { label: "Work", provider: "codex", publicId: "acct_primary0001", status: "signed_in" },
      ],
      daemonVersion: "0.4.0",
      defaultApprovalMode: "auto:all",
      defaultPreset: "ultra",
      heartbeatAt: now - 1_000,
      machineLabel: "Older",
      projects: [{ label: "Control plane", publicId: "proj_alpha000001" }],
      proseAutorespondConfigured: false,
      scheduledTasks: [],
      showThinkingDefault: false,
      version: 1,
    });
    if (payload === null) throw new Error("registry fixture is not valid");
    const view = toMachineView({
      device: null,
      devicePublicId: "device_older001",
      now,
      payload,
      revision: 1,
      updatedAt: now,
    });
    expect(view.deviceCommandsAllowed).toBe(true);
    expect(view.accountLinkingAllowed).toBe(false);
    expect(sessionStartTargets([view])).toHaveLength(1);
  });
});

describe("device command notices", () => {
  const notice = (state: string, resultCode: string | null = null, kind = "session_start") =>
    deviceCommandNotice({ kind, resultCode, state });

  test("an ambiguous session start is never phrased as a failure", () => {
    const ambiguous = notice("ambiguous");
    expect(ambiguous?.tone).toBe("error");
    expect(ambiguous?.text).toContain("could not confirm whether the session started");
    expect(ambiguous?.text).not.toContain("try again.");
  });

  test("names the operator switch behind each refusal", () => {
    expect(notice("failed", "DEVICE_COMMANDS_DENIED")?.text)
      .toContain("hra remote allow device-commands");
    expect(notice("failed", "ACCOUNT_LINKING_DENIED", "account_login_start")?.text)
      .toContain("hra remote allow account-linking");
    expect(notice("failed", "ACCOUNT_LOGIN_RELAY_UNAVAILABLE", "account_login_start")?.text)
      .toContain("hra account login");
    expect(notice("failed", "DEVICE_COMMAND_DAILY_CAP")?.text).toContain("daily limit");
    expect(notice("failed", "SOMETHING_NEW")?.text).toBe("The machine refused this request.");
  });

  test("reports progress and settlement", () => {
    expect(notice("pending")?.tone).toBe("pending");
    expect(notice("effect_started")?.tone).toBe("pending");
    expect(notice("applied")?.tone).toBe("settled");
    expect(notice("applied", null, "usage_refresh")?.text).toBe("Done.");
    expect(notice("expired")?.tone).toBe("error");
    expect(deviceCommandNotice(null)).toBeNull();
  });
});
