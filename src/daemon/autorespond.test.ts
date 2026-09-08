import { describe, expect, test } from "bun:test";

import type { InteractionDisplay } from "../domain/interactions";
import { selectAutorespondAfterHoursTier } from "../domain/autorespond-after-hours";
import { approvalClassOf } from "../domain/autorespond-protocol-policy";

import {
  AUTORESPOND_CONSECUTIVE_LIMIT,
  AUTORESPOND_DAILY_BUDGET,
  AUTORESPOND_HOURLY_BUDGET,
  decideAutorespond,
  decideProseAutorespond,
  permissionNamesOf,
  PROSE_AUTORESPOND_MAX_MESSAGE_CHARACTERS,
} from "./autorespond";

const quiet = { consecutive: 0, lastDay: 0, lastHour: 0 };
const command: InteractionDisplay = {
  kind: "command_approval",
  summary: "Run the test suite",
  reason: null,
  commandClass: "bun test",
  workingDirectory: null,
  availableDecisions: ["once", "session", "decline", "cancel"],
};
const fileChange: InteractionDisplay = {
  kind: "file_change_approval",
  summary: "Allow the proposed file changes",
  reason: null,
  grantRoot: null,
  availableDecisions: ["once", "decline", "cancel"],
};
const network: InteractionDisplay = {
  kind: "permission_approval",
  summary: "Allow network access",
  reason: null,
  requested: [{ name: "network" }],
  allowsSessionScope: true,
};
const workspacePermission: InteractionDisplay = {
  kind: "permission_approval",
  summary: "Allow workspace write",
  reason: null,
  requested: [{ name: "workspace_write" }],
  allowsSessionScope: false,
};

describe("autorespond policy", () => {
  const selection = selectAutorespondAfterHoursTier({
    sourceKind: "protocol",
    approvalEligibility: "eligible",
    historyEligibility: "proven",
    policy: { kind: "autorespond_after_hours", version: 1, revision: 1, enabled: true },
    schedule: { version: 1, revision: 1, startMinute: 600, endMinute: 1320, timeZone: "UTC" },
    observedAt: Date.parse("2026-09-07T23:00:00Z"),
  });

  test("uses a provisional after-hours tier without widening approval authority or prose", () => {
    expect(selection.tier).toBe("after_hours");
    expect(decideAutorespond({ budgets: { ...quiet, consecutive: 3 }, display: command,
      kind: command.kind, mode: "auto:all", selection })).toMatchObject({ action: "accept" });
    for (const [field, limit, code] of [
      ["consecutive", 6, "consecutive_limit"],
      ["lastHour", 20, "hourly_budget"],
      ["lastDay", 80, "daily_budget"],
    ] as const) {
      expect(decideAutorespond({ budgets: { ...quiet, [field]: limit - 1 }, display: command,
        kind: command.kind, mode: "auto:all", selection })).toMatchObject({ action: "accept" });
      expect(decideAutorespond({ budgets: { ...quiet, [field]: limit }, display: command,
        kind: command.kind, mode: "auto:all", selection })).toMatchObject({ action: "escalate", code });
    }
    for (const display of [command, network, workspacePermission, fileChange]) {
      expect(decideAutorespond({ budgets: quiet, display, kind: display.kind,
        mode: "auto:workspace", selection })).toMatchObject({
        action: "escalate", code: "protected_authority_required",
      });
    }
    expect(decideAutorespond({ budgets: quiet, display: command, kind: command.kind,
      mode: "manual", selection })).toMatchObject({ action: "escalate", code: "manual_mode" });
    expect(decideProseAutorespond({ budgets: { ...quiet, consecutive: 3 }, mode: "auto:all" }))
      .toMatchObject({ action: "escalate", code: "consecutive_limit" });
  });

  test("accepts commands and permissions at once scope under auto:all", () => {
    for (const display of [command, network]) {
      const decision = decideAutorespond({ budgets: quiet, display, kind: display.kind, mode: "auto:all" });
      expect(decision).toMatchObject({ action: "accept", decision: "once" });
    }
    expect(decideAutorespond({ budgets: quiet, display: fileChange, kind: fileChange.kind, mode: "auto:all" }))
      .toMatchObject({ action: "escalate", code: "protected_authority_required" });
  });

  test("never answers under manual mode and never answers questions or forms", () => {
    expect(decideAutorespond({ budgets: quiet, display: command, kind: "command_approval", mode: "manual" }))
      .toMatchObject({ action: "escalate", code: "manual_mode" });
    const question: InteractionDisplay = {
      kind: "user_input",
      summary: "Which one?",
      blocking: true,
      questions: [{ id: "q1", header: "Choice", question: "Which one?", options: null, allowsOther: true, secret: false }],
    };
    expect(decideAutorespond({ budgets: quiet, display: question, kind: "user_input", mode: "auto:all" }))
      .toMatchObject({ action: "escalate", code: "not_an_approval" });
  });

  test("auto:workspace fails closed for every permission category without exact authority", () => {
    for (const requested of [
      [{ name: "network" }],
      [{ name: "mcp" }],
      [{ name: "camera" }],
      [{ name: "file_camera" }],
      [{ name: "read_keychain" }],
      [{ name: "filesystem_remote" }],
      [{ name: "workspace_write" }],
      [{ name: "workspace_write" }, { name: "camera" }],
    ]) {
      const display: InteractionDisplay = { ...workspacePermission, requested };
      expect(decideAutorespond({ budgets: quiet, display, kind: "permission_approval", mode: "auto:workspace" }))
        .toMatchObject({ action: "escalate", code: "protected_authority_required" });
    }
    const empty: InteractionDisplay = { ...network, requested: [] };
    expect(decideAutorespond({ budgets: quiet, display: empty, kind: "permission_approval", mode: "auto:all" }))
      .toMatchObject({ action: "escalate", code: "decision_unavailable" });
  });

  test("auto:workspace does not treat a command class as exact authority", () => {
    for (const display of [command, { ...command, commandClass: "git push" }]) {
      expect(decideAutorespond({ budgets: quiet, display, kind: display.kind, mode: "auto:workspace" }))
        .toMatchObject({ action: "escalate", code: "protected_authority_required" });
    }
  });

  test("respects the provider's offered decisions", () => {
    const declineOnly: InteractionDisplay = { ...command, availableDecisions: ["decline", "cancel"] };
    expect(decideAutorespond({ budgets: quiet, display: declineOnly, kind: "file_change_approval", mode: "auto:all" }))
      .toMatchObject({ action: "escalate", code: "not_an_approval" });
    expect(decideAutorespond({ budgets: quiet, display: declineOnly, kind: "command_approval", mode: "auto:all" }))
      .toMatchObject({ action: "escalate", code: "decision_unavailable" });
  });

  test("consecutive, hourly, and daily budgets escalate in that order", () => {
    expect(decideAutorespond({
      budgets: { ...quiet, consecutive: AUTORESPOND_CONSECUTIVE_LIMIT },
      display: command,
      kind: "command_approval",
      mode: "auto:all",
    })).toMatchObject({ action: "escalate", code: "consecutive_limit" });
    expect(decideAutorespond({
      budgets: { ...quiet, lastHour: AUTORESPOND_HOURLY_BUDGET },
      display: command,
      kind: "command_approval",
      mode: "auto:all",
    })).toMatchObject({ action: "escalate", code: "hourly_budget" });
    expect(decideAutorespond({
      budgets: { ...quiet, lastDay: AUTORESPOND_DAILY_BUDGET },
      display: command,
      kind: "command_approval",
      mode: "auto:all",
    })).toMatchObject({ action: "escalate", code: "daily_budget" });
  });

  test("classes are bounded labels and permission names are extracted", () => {
    expect(approvalClassOf(command)).toBe("command:bun test");
    expect(approvalClassOf(fileChange)).toBe("file_change");
    expect(approvalClassOf(network)).toBe("permission:network");
    expect(permissionNamesOf(network)).toEqual(["network"]);
    expect(permissionNamesOf(command)).toEqual([]);
  });
});

describe("decideProseAutorespond", () => {
  test("sends under either auto mode when every budget is quiet", () => {
    expect(decideProseAutorespond({ budgets: quiet, mode: "auto:all" }))
      .toEqual({ action: "send" });
    expect(decideProseAutorespond({ budgets: quiet, mode: "auto:workspace" }))
      .toEqual({ action: "send" });
  });

  test("escalates under manual mode and on each spent budget", () => {
    expect(decideProseAutorespond({ budgets: quiet, mode: "manual" }))
      .toEqual({ action: "escalate", code: "manual_mode" });
    expect(decideProseAutorespond({
      budgets: { ...quiet, consecutive: AUTORESPOND_CONSECUTIVE_LIMIT },
      mode: "auto:all",
    })).toEqual({ action: "escalate", code: "consecutive_limit" });
    expect(decideProseAutorespond({
      budgets: { ...quiet, lastHour: AUTORESPOND_HOURLY_BUDGET },
      mode: "auto:all",
    })).toEqual({ action: "escalate", code: "hourly_budget" });
    expect(decideProseAutorespond({
      budgets: { ...quiet, lastDay: AUTORESPOND_DAILY_BUDGET },
      mode: "auto:all",
    })).toEqual({ action: "escalate", code: "daily_budget" });
  });

  test("bounds the message length the daemon will consider", () => {
    expect(PROSE_AUTORESPOND_MAX_MESSAGE_CHARACTERS).toBe(4_000);
  });
});
