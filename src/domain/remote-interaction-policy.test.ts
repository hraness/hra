import { describe, expect, test } from "bun:test";

import type { InteractionDisplay, McpFormField } from "./interactions";
import {
  deriveRemoteInteractionPolicy,
  remoteInteractionActionOrder,
  remoteInteractionPolicyLimits,
  remoteInteractionPolicyReasonCodeOrder,
  summarizeRemoteInteractionReachability,
  type RemoteInteractionAction,
} from "./remote-interaction-policy";

const command = (
  availableDecisions: Extract<InteractionDisplay, { kind: "command_approval" }>["availableDecisions"] = [
    "once",
    "decline",
  ],
  commandClass = "git commit",
): Extract<InteractionDisplay, { kind: "command_approval" }> => ({
  availableDecisions,
  commandClass,
  kind: "command_approval",
  reason: null,
  summary: "Run a classified command",
  workingDirectory: null,
});

const fileChange = (
  availableDecisions: Extract<InteractionDisplay, { kind: "file_change_approval" }>["availableDecisions"] = [
    "once",
    "decline",
  ],
): Extract<InteractionDisplay, { kind: "file_change_approval" }> => ({
  availableDecisions,
  grantRoot: null,
  kind: "file_change_approval",
  reason: null,
  summary: "Apply file changes",
});

const permission = (
  names: readonly string[],
): Extract<InteractionDisplay, { kind: "permission_approval" }> => ({
  allowsSessionScope: true,
  kind: "permission_approval",
  reason: null,
  requested: names.map((name) => ({ name })),
  summary: "Allow additional permissions",
});

const userInput = (
  questions: Extract<InteractionDisplay, { kind: "user_input" }>["questions"] = [{
    allowsOther: false,
    header: "Region",
    id: "region",
    options: [
      { description: "Use the east region", label: "East" },
      { description: "Use the west region", label: "West" },
    ],
    question: "Which region should this use?",
    remoteAnswerable: true,
    secret: false,
  }],
): Extract<InteractionDisplay, { kind: "user_input" }> => ({
  blocking: true,
  kind: "user_input",
  questions,
  summary: "Codex needs user input",
});

const stringField = (
  name: string,
  overrides: Partial<Extract<McpFormField, { type: "string" }>> = {},
): Extract<McpFormField, { type: "string" }> => ({
  format: null,
  maxLength: 64,
  minLength: 0,
  name,
  required: false,
  type: "string",
  ...overrides,
});

const mcp = (
  fields: readonly McpFormField[] | "omit" = [stringField("region")],
  mode: "form" | "openai_form" = "form",
): Extract<InteractionDisplay, { kind: "mcp_elicitation" }> => ({
  ...(fields === "omit" ? {} : { fields: [...fields] }),
  kind: "mcp_elicitation",
  mayContainSecrets: true,
  mode,
  serverName: "server",
  summary: "Review provider input",
  url: null,
});

const activePolicy = (display: InteractionDisplay) => deriveRemoteInteractionPolicy({
  deadlineAt: 2_000,
  display,
  state: "pending",
}, 1_000);
const privatePathFixture = ["", "Users", "operator", "private"].join("/");
const projectPathFixture = ["", "Users", "operator", "project"].join("/");

describe("remote interaction policy", () => {
  test("defines an exhaustive kind by action matrix in one canonical order", () => {
    const rows: readonly Readonly<{
      actions: readonly RemoteInteractionAction[];
      display: InteractionDisplay;
      kind: InteractionDisplay["kind"];
    }>[] = [
      { actions: ["decline"], display: command(), kind: "command_approval" },
      { actions: ["decline"], display: fileChange(), kind: "file_change_approval" },
      {
        actions: ["decline"],
        display: permission(["workspace_write"]),
        kind: "permission_approval",
      },
      { actions: ["answer"], display: userInput(), kind: "user_input" },
      { actions: [], display: mcp(), kind: "mcp_elicitation" },
    ];

    expect(rows.map((row) => row.kind)).toEqual([
      "command_approval",
      "file_change_approval",
      "permission_approval",
      "user_input",
      "mcp_elicitation",
    ]);
    for (const row of rows) {
      const result = activePolicy(row.display);
      expect(result.actions).toEqual(row.actions);
      expect(result.actions).toEqual(
        remoteInteractionActionOrder.filter((action) => result.actions.includes(action)),
      );
      for (const action of remoteInteractionActionOrder) {
        expect(result.actions.includes(action)).toBe(row.actions.includes(action));
      }
    }
  });

  test("keeps command grants local and declines only when offered", () => {
    expect(activePolicy(command(["once"]))).toMatchObject({
      actions: [],
      reasonCodes: ["COMMAND_APPROVAL_LOCAL_ONLY", "COMMAND_DECLINE_NOT_OFFERED"],
    });
    expect(activePolicy(command(["decline"]))).toMatchObject({
      actions: ["decline"],
      reasonCodes: ["COMMAND_APPROVAL_LOCAL_ONLY"],
    });
    expect(activePolicy(command(["session", "cancel"]))).toMatchObject({
      actions: [],
      reasonCodes: ["COMMAND_APPROVAL_LOCAL_ONLY", "COMMAND_DECLINE_NOT_OFFERED"],
    });
    for (const hiddenOrUnsafeClass of ["git push", `run ${privatePathFixture}`, "run\u0000now", "[protected]"]) {
      expect(activePolicy(command(["once", "decline"], hiddenOrUnsafeClass))).toMatchObject({
        actions: ["decline"],
        reasonCodes: ["COMMAND_APPROVAL_LOCAL_ONLY"],
      });
    }
  });

  test("never approves file changes and declines only when offered", () => {
    expect(activePolicy(fileChange(["once", "decline"]))).toMatchObject({
      actions: ["decline"],
      reasonCodes: ["FILE_CHANGE_APPROVAL_LOCAL_ONLY"],
    });
    expect(activePolicy(fileChange(["once"]))).toMatchObject({
      actions: [],
      reasonCodes: [
        "FILE_CHANGE_APPROVAL_LOCAL_ONLY",
        "FILE_CHANGE_DECLINE_NOT_OFFERED",
      ],
    });
  });

  test("keeps every permission grant local because its exact values are protected", () => {
    expect(activePolicy(permission(["workspace_write", "filesystem_read"])))
      .toMatchObject({
        actions: ["decline"],
        reasonCodes: ["PERMISSION_APPROVAL_LOCAL_ONLY"],
      });
    expect(activePolicy(permission([]))).toMatchObject({
      actions: ["decline"],
      reasonCodes: ["PERMISSION_APPROVAL_LOCAL_ONLY", "PERMISSION_REQUEST_EMPTY"],
    });
    for (const names of [
      ["network_outbound"],
      ["mcp_tool"],
      ["telemetry"],
      ["workspace_write", "remote_exec"],
      ["file_http_fetch"],
    ]) {
      expect(activePolicy(permission(names))).toMatchObject({
        actions: ["decline"],
        reasonCodes: ["PERMISSION_APPROVAL_LOCAL_ONLY"],
      });
    }
    expect(activePolicy(permission(["workspace_write\u0000now"]))).toMatchObject({
      actions: ["decline"],
      reasonCodes: ["PERMISSION_APPROVAL_LOCAL_ONLY"],
    });
    expect(activePolicy(permission([`workspace_write ${privatePathFixture}`])))
      .toMatchObject({
        actions: ["decline"],
        reasonCodes: ["PERMISSION_APPROVAL_LOCAL_ONLY"],
      });
  });

  test("requires every user question and all decision metadata to cross exactly", () => {
    const projected = activePolicy(userInput());
    expect(projected.actions).toEqual(["answer"]);
    expect(projected.questions).toEqual([{
      allowsOther: false,
      header: "Region",
      id: "region",
      kind: "user_input",
      options: [
        { description: "Use the east region", label: "East" },
        { description: "Use the west region", label: "West" },
      ],
      question: "Which region should this use?",
    }]);

    const base = userInput().questions[0]!;
    expect(activePolicy(userInput([
      base,
      { ...base, header: "Credential", id: "credential", secret: true },
    ]))).toMatchObject({
      actions: [],
      questions: [],
      reasonCodes: ["USER_INPUT_SECRET_QUESTION"],
    });

    for (const question of [
      { ...base, id: "q".repeat(remoteInteractionPolicyLimits.questionIdCharacters + 1) },
      { ...base, header: "h".repeat(remoteInteractionPolicyLimits.questionLabelCharacters + 1) },
      { ...base, id: "where\u0000", header: "Where" },
      { ...base, id: "where", header: projectPathFixture },
      { ...base, id: "api_token", question: "Enter the API token", secret: false },
      { ...base, allowsOther: false, options: [] },
      {
        ...base,
        options: [{ description: `Read ${privatePathFixture}`, label: "Unsafe" }],
      },
    ]) {
      expect(activePolicy(userInput([question]))).toMatchObject({
        actions: [],
        questions: [],
        reasonCodes: ["USER_INPUT_METADATA_UNPROJECTABLE"],
      });
    }

    expect(activePolicy(userInput([{ ...base, options: null }]))).toMatchObject({
      actions: [],
      reasonCodes: ["USER_INPUT_FREE_TEXT_LOCAL_ONLY"],
    });
    expect(activePolicy(userInput([{ ...base, allowsOther: true }]))).toMatchObject({
      actions: [],
      reasonCodes: ["USER_INPUT_FREE_TEXT_LOCAL_ONLY"],
    });
    const { remoteAnswerable: _remoteAnswerable, ...withoutProviderEvidence } = base;
    expect(_remoteAnswerable).toBe(true);
    expect(activePolicy(userInput([withoutProviderEvidence]))).toMatchObject({
      actions: [],
      reasonCodes: ["USER_INPUT_PROVIDER_CONTRACT_LOCAL_ONLY"],
    });
    const inheritedProviderEvidence = { ...withoutProviderEvidence };
    Object.setPrototypeOf(inheritedProviderEvidence, { remoteAnswerable: true });
    expect(activePolicy(userInput([inheritedProviderEvidence]))).toMatchObject({
      actions: [],
      reasonCodes: ["USER_INPUT_PROVIDER_CONTRACT_LOCAL_ONLY"],
    });
    expect(activePolicy(userInput([
      base,
      { ...base, id: "region_backup" },
    ]))).toMatchObject({
      actions: [],
      reasonCodes: ["USER_INPUT_METADATA_UNPROJECTABLE"],
    });

    const tooLarge = [
      { ...base, id: "first", question: "a".repeat(1_000) },
      { ...base, id: "second", question: "b".repeat(1_000) },
      { ...base, id: "third", question: "c".repeat(1_000) },
    ];
    expect(activePolicy(userInput(tooLarge))).toMatchObject({
      actions: [],
      reasonCodes: ["USER_INPUT_METADATA_UNPROJECTABLE"],
    });
  });

  test("keeps every MCP form local because field sensitivity is not preserved", () => {
    const cases = [
      mcp([stringField("region", { required: true })]),
      mcp([{
        choices: ["small", "large"],
        name: "size",
        required: true,
        type: "single_select",
      }]),
      mcp([stringField("one_time_code", { required: true })]),
    ];
    for (const display of cases) {
      expect(activePolicy(display)).toMatchObject({
        actions: [],
        questions: [],
        reachability: { state: "machine_only" },
        reasonCodes: expect.arrayContaining(["MCP_ANSWER_LOCAL_ONLY"]),
      });
    }
    expect(activePolicy(mcp([]))).toMatchObject({
      actions: [],
      reasonCodes: ["MCP_FIELDS_MISSING", "MCP_ANSWER_LOCAL_ONLY"],
    });
    expect(activePolicy(mcp("omit", "openai_form"))).toMatchObject({
      actions: [],
      reasonCodes: ["MCP_MODE_UNSUPPORTED", "MCP_FIELDS_MISSING", "MCP_ANSWER_LOCAL_ONLY"],
    });
  });

  test("emits unique reason codes in the shared canonical wire order", () => {
    const base = userInput().questions[0]!;
    const policies = [
      activePolicy(command(["once"])),
      activePolicy(fileChange(["once"])),
      activePolicy(permission([])),
      activePolicy(userInput([{
        ...base,
        options: null,
        remoteAnswerable: undefined,
        secret: true,
      }])),
      activePolicy(mcp("omit", "openai_form")),
    ];
    for (const result of policies) {
      const indexes = result.reasonCodes.map((reason) =>
        remoteInteractionPolicyReasonCodeOrder.indexOf(reason));
      expect(indexes).toEqual([...new Set(indexes)].sort((left, right) => left - right));
    }
  });

  test("derives reachability from a canonicalized action set", () => {
    expect(summarizeRemoteInteractionReachability(["answer", "decline", "answer"]))
      .toEqual({
        actions: ["decline", "answer"],
        answerActions: 1,
        decisionActions: 1,
        state: "remote_actionable",
      });
    expect(summarizeRemoteInteractionReachability([])).toEqual({
      actions: [],
      answerActions: 0,
      decisionActions: 0,
      state: "machine_only",
    });
  });

  test("closes authority before display policy when state or deadline is no longer live", () => {
    const display = command();
    for (const state of [
      "response_prepared",
      "response_written",
      "resolved",
      "declined",
      "canceled",
      "expired",
      "resolution_unknown",
    ] as const) {
      expect(deriveRemoteInteractionPolicy({ deadlineAt: 2_000, display, state }, 1_000))
        .toMatchObject({
          actions: [],
          deadlineAt: 2_000,
          questions: [],
          reasonCodes: ["INTERACTION_NOT_PENDING"],
        });
    }
    expect(deriveRemoteInteractionPolicy({ deadlineAt: 2_000, display, state: "pending" }, 2_000))
      .toMatchObject({ actions: [], reasonCodes: ["INTERACTION_EXPIRED"] });
    expect(deriveRemoteInteractionPolicy({ deadlineAt: 2_000, display, state: "pending" }, 1_999))
      .toMatchObject({ actions: ["decline"], reasonCodes: ["COMMAND_APPROVAL_LOCAL_ONLY"] });
    expect(deriveRemoteInteractionPolicy({ deadlineAt: Number.NaN, display, state: "pending" }, 1_000))
      .toMatchObject({ actions: [], reasonCodes: ["INTERACTION_TIME_INVALID"] });
    expect(deriveRemoteInteractionPolicy({ deadlineAt: 2_000, display, state: "pending" }, -1))
      .toMatchObject({ actions: [], reasonCodes: ["INTERACTION_TIME_INVALID"] });
  });
});
