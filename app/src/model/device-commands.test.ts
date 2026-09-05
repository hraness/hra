import { describe, expect, test } from "bun:test";

import { parseDeviceCommandPayload, parseDeviceRegistryPayload } from "../hra/cloud";
import {
  accountLoginStartCommand,
  accountLoginStatusCommand,
  beginAccountLoginAction,
  completeAccountLoginSubmission,
  finishAccountLoginHandoff,
  admitHostedLoginHandoff,
  bindHostedLoginResultExpiry,
  defaultSessionStartPreset,
  deviceCommandNotice,
  hostedLoginHandoffDeadline,
  initialAccountLoginActionState,
  notificationHoursCommand,
  parseNotificationClockMinute,
  sessionStartCommand,
  sessionStartTargetHint,
  sessionStartTargetLabel,
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
  deviceStatus: "active" | "pending" | "revoked" | null;
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
    device: overrides.deviceStatus === null
      ? null
      : { online: false, status: overrides.deviceStatus ?? "active" },
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
      .toEqual({
        accountPublicId: "acct_primary0001",
        handoffVersion: 2,
        kind: "account_login_start",
      });
    expect(accepted(accountLoginStatusCommand("acct_primary0001"))).toEqual({
      accountPublicId: "acct_primary0001",
      kind: "account_login_status",
    });
    expect(accepted(usageRefreshCommand())).toEqual({ kind: "usage_refresh" });
  });

  test("uses the hosted deadline instead of a skewed machine login expiry", () => {
    const machineResult = {
      expiresAt: 1,
      handoffVersion: 2,
      kind: "account_login_start",
      loginUrl: "https://auth.openai.com/codex/device",
      userCode: "ABCD-EFGH",
    } as const;
    expect(bindHostedLoginResultExpiry(machineResult, 1_760_000_300_000)).toEqual({
      ...machineResult,
      expiresAt: 1_760_000_300_000,
    });
    expect(bindHostedLoginResultExpiry(
      machineResult,
      undefined,
      1_760_000_240_000,
    )).toEqual({
      ...machineResult,
      expiresAt: 1_760_000_240_000,
    });
    expect(bindHostedLoginResultExpiry(machineResult, 0)).toBeNull();
    expect(bindHostedLoginResultExpiry(
      { accountsRefreshed: 1, kind: "usage_refresh" },
      1_760_000_300_000,
    )).toBeNull();
    expect(hostedLoginHandoffDeadline(1_760_000_000_000)).toBe(1_760_000_300_000);
    expect(hostedLoginHandoffDeadline(Number.MAX_SAFE_INTEGER)).toBeNull();
  });

  test("waits for the hosted clock before judging a fresh handoff with an ahead browser", () => {
    const settledAt = 1_760_000_000_000;
    expect(admitHostedLoginHandoff({
      now: settledAt + 10 * 60_000,
      serverClockReady: false,
      settledAt,
    })).toEqual({ status: "awaiting_server_clock" });
    expect(admitHostedLoginHandoff({
      now: settledAt + 1_000,
      serverClockReady: true,
      settledAt,
    })).toEqual({
      expiresAt: settledAt + 5 * 60_000,
      status: "ready",
    });
  });
});

describe("account login action gate", () => {
  test("a status check or duplicate start cannot supersede an outstanding login handoff", () => {
    const submitting = beginAccountLoginAction(
      initialAccountLoginActionState,
      "account_login_start",
    );
    expect(submitting).not.toBeNull();
    if (submitting === null) throw new Error("expected the login start to be admitted");

    // The first mutation has not returned yet. A second click in the same
    // render must be refused synchronously, before React can paint `disabled`.
    expect(beginAccountLoginAction(submitting, "account_login_start")).toBeNull();
    expect(beginAccountLoginAction(submitting, "account_login_status")).toBeNull();

    // Enqueue completion is not handoff completion. Keep the original command
    // selected while the machine settles it and the browser consumes its result.
    const awaitingHandoff = completeAccountLoginSubmission(
      submitting,
      "018bcfe5-6800-7000-8000-000000000001",
    );
    expect(awaitingHandoff).toEqual({
      commandPublicId: "018bcfe5-6800-7000-8000-000000000001",
      phase: "awaiting_login_handoff",
    });
    expect(beginAccountLoginAction(awaitingHandoff, "account_login_status")).toBeNull();
    expect(finishAccountLoginHandoff(awaitingHandoff, "a-different-command"))
      .toBe(awaitingHandoff);

    const released = finishAccountLoginHandoff(
      awaitingHandoff,
      "018bcfe5-6800-7000-8000-000000000001",
    );
    expect(released).toBe(initialAccountLoginActionState);
    expect(beginAccountLoginAction(released, "account_login_status")).not.toBeNull();
  });

  test("a status request unlocks as soon as its enqueue finishes", () => {
    const submitting = beginAccountLoginAction(
      initialAccountLoginActionState,
      "account_login_status",
    );
    if (submitting === null) throw new Error("expected the status check to be admitted");
    expect(completeAccountLoginSubmission(
      submitting,
      "018bcfe5-6800-7000-8000-000000000002",
    )).toBe(initialAccountLoginActionState);
  });

  test("builds notification hours with the local policy revision, not a registry revision", () => {
    expect(notificationHoursCommand({
      endMinute: 1_320,
      expectedRevision: 9,
      startMinute: 600,
      timeZone: "America/Puerto_Rico",
      version: 1,
    })).toMatchObject({ kind: "set_notification_hours", expectedRevision: 9 });
    expect(() => notificationHoursCommand({
      endMinute: 600,
      expectedRevision: 9,
      startMinute: 600,
      timeZone: "America/Puerto_Rico",
      version: 1,
    })).toThrow();
  });

  test("strictly parses clock fields instead of normalizing malformed times", () => {
    expect(parseNotificationClockMinute("00:00")).toBe(0);
    expect(parseNotificationClockMinute("23:59")).toBe(1_439);
    expect(parseNotificationClockMinute("00:60")).toBeNull();
    expect(parseNotificationClockMinute("01:99")).toBeNull();
    expect(parseNotificationClockMinute("24:00")).toBeNull();
    expect(parseNotificationClockMinute("1:00")).toBeNull();
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
        machineOnline: true,
        projects: [{ label: "Control plane", publicId: "proj_alpha000001" }],
        provider: "codex",
        targetDevicePublicId: "device_studio01",
      },
    ]);
  });

  test("never offers a target the daemon would refuse", () => {
    expect(sessionStartTargets([machine({ deviceCommandsAllowed: false })])).toEqual([]);
    expect(sessionStartTargets([machine({ deviceStatus: "revoked" })])).toEqual([]);
    expect(sessionStartTargets([machine({ deviceStatus: null })])).toEqual([]);
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
      device: { online: false, status: "active" },
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

  test("puts Claude's Linux boundary beside every browser start choice", () => {
    const target = sessionStartTargets([machine({
      accounts: [
        { label: "Research", provider: "claude", publicId: "acct_claude00001", status: "signed_in" },
      ],
    })])[0];
    if (target === undefined) throw new Error("expected Claude target");
    expect(sessionStartTargetLabel(target))
      .toBe("Research — Studio — Claude Code (Linux machine only)");
    expect(sessionStartTargetHint(target)).toContain("Linux custodian");
    expect(sessionStartTargetHint(target)).toContain("macOS refuses before launch");

    const codex = sessionStartTargets([machine()])[0];
    if (codex === undefined) throw new Error("expected Codex target");
    expect(sessionStartTargetLabel(codex)).toBe("Work — Studio — Codex");
    expect(sessionStartTargetHint(codex)).not.toContain("Linux custodian");
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
    expect(notice("failed", "ACCOUNT_LOGIN_NOT_AVAILABLE", "account_login_start")?.text)
      .toContain("only while that account is signed out");
    expect(notice("failed", "DEVICE_COMMAND_DAILY_CAP")?.text).toContain("daily limit");
    expect(notice("failed", "LOCAL_NOTIFICATION_HOURS_REVISION_EXHAUSTED")?.text)
      .toContain("revision limit");
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
