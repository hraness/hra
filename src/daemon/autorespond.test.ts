import { describe, expect, test } from "bun:test";

import type { InteractionDisplay } from "../domain/interactions";

import {
  approvalClassOf,
  AUTORESPOND_CONSECUTIVE_LIMIT,
  AUTORESPOND_DAILY_BUDGET,
  AUTORESPOND_HOURLY_BUDGET,
  decideAutorespond,
  permissionNamesOf,
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
  test("accepts commands, file changes, and permissions at once scope under auto:all", () => {
    for (const display of [command, fileChange, network]) {
      const decision = decideAutorespond({ budgets: quiet, display, kind: display.kind, mode: "auto:all" });
      expect(decision).toMatchObject({ action: "accept", decision: "once" });
    }
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

  test("auto:workspace escalates network, MCP, and unknown permissions but accepts workspace ones", () => {
    expect(decideAutorespond({ budgets: quiet, display: network, kind: "permission_approval", mode: "auto:workspace" }))
      .toMatchObject({ action: "escalate", code: "network_or_external" });
    expect(decideAutorespond({ budgets: quiet, display: workspacePermission, kind: "permission_approval", mode: "auto:workspace" }))
      .toMatchObject({ action: "accept" });
    const empty: InteractionDisplay = { ...network, requested: [] };
    expect(decideAutorespond({ budgets: quiet, display: empty, kind: "permission_approval", mode: "auto:all" }))
      .toMatchObject({ action: "escalate", code: "decision_unavailable" });
  });

  test("respects the provider's offered decisions", () => {
    const declineOnly: InteractionDisplay = { ...fileChange, availableDecisions: ["decline", "cancel"] };
    expect(decideAutorespond({ budgets: quiet, display: declineOnly, kind: "file_change_approval", mode: "auto:all" }))
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
