import { expect, test } from "bun:test";

import {
  HRA_PRODUCTION_EXECUTION_POLICY,
  ProductionExecutionPolicyError,
  isProductionApprovalRequestMethod,
  pinnedCodexRequests,
  verifyProductionExecutionPolicyRequirements,
  verifyProductionThreadAdmission,
  verifyProductionTurnAdmission,
} from "../src/codex";

const thread = {
  id: "provider-policy-thread",
  ephemeral: false,
  historyMode: "legacy" as const,
  preview: "",
  createdAt: 1,
  updatedAt: 1,
  status: { type: "idle" as const },
  cwd: "/tmp/hra-policy",
  threadSource: "appServer",
  name: null,
  turns: [],
};

test("production execution policy parses managed requirements and mints opaque receipts", () => {
  const requirements = pinnedCodexRequests.configRequirementsRead.outputCodec.parse({
    requirements: {
      allowedApprovalPolicies: ["on-request", "never"],
      allowedApprovalsReviewers: ["auto_review"],
      allowedSandboxModes: ["workspace-write", "danger-full-access"],
      featureRequirements: {},
    },
  });
  const proof = verifyProductionExecutionPolicyRequirements({
    generation: 7,
    streamPosition: 11,
    output: requirements,
  });
  const threadRequest = pinnedCodexRequests.threadStart.inputCodec.parse({
    cwd: "/tmp/hra-policy",
    approvalPolicy: HRA_PRODUCTION_EXECUTION_POLICY.approvalPolicy,
    approvalsReviewer: HRA_PRODUCTION_EXECUTION_POLICY.approvalsReviewer,
    sandbox: HRA_PRODUCTION_EXECUTION_POLICY.threadSandbox,
  });
  const threadResponse = pinnedCodexRequests.threadStart.outputCodec.parse({
    thread,
    model: "gpt-5.6-sol",
    reasoningEffort: "ultra",
    serviceTier: null,
    approvalPolicy: "never",
    approvalsReviewer: "auto_review",
    sandbox: { type: "dangerFullAccess" },
  });
  const threadReceipt = verifyProductionThreadAdmission({
    proof,
    generation: 7,
    streamPosition: 12,
    request: threadRequest,
    response: threadResponse,
  });
  const turnRequest = pinnedCodexRequests.turnStart.inputCodec.parse({
    threadId: thread.id,
    clientUserMessageId: "message-policy-1",
    input: [{ type: "text", text: "Proceed", text_elements: [] }],
    approvalPolicy: "never",
    approvalsReviewer: "auto_review",
    sandboxPolicy: { type: "dangerFullAccess" },
  });
  expect(verifyProductionTurnAdmission({
    proof,
    threadReceipt,
    generation: 7,
    streamPosition: 13,
    request: turnRequest,
  })).toMatchObject({
    policyId: "hra.full-access.v1",
    generation: 7,
    requirementsPosition: 11,
    admissionPosition: 13,
  });
});

test("production execution policy never downgrades managed or returned settings", () => {
  const rejected = [
    {
      allowedApprovalPolicies: ["on-request"],
      allowedApprovalsReviewers: ["auto_review"],
      allowedSandboxModes: ["danger-full-access"],
    },
    {
      allowedApprovalPolicies: ["never"],
      allowedApprovalsReviewers: ["user"],
      allowedSandboxModes: ["danger-full-access"],
    },
    {
      allowedApprovalPolicies: ["never"],
      allowedApprovalsReviewers: ["auto_review"],
      allowedSandboxModes: ["workspace-write"],
    },
  ] as const;
  for (const requirements of rejected) {
    expect(() => verifyProductionExecutionPolicyRequirements({
      generation: 1,
      streamPosition: 1,
      output: pinnedCodexRequests.configRequirementsRead.outputCodec.parse({ requirements }),
    })).toThrow(ProductionExecutionPolicyError);
  }

  const proof = verifyProductionExecutionPolicyRequirements({
    generation: 1,
    streamPosition: 1,
    output: { requirements: null },
  });
  const request = pinnedCodexRequests.threadResume.inputCodec.parse({
    threadId: thread.id,
    approvalPolicy: "never",
    approvalsReviewer: "auto_review",
    sandbox: "danger-full-access",
  });
  for (const responsePolicy of [
    { approvalPolicy: "on-request", approvalsReviewer: "auto_review", sandbox: { type: "dangerFullAccess" } },
    { approvalPolicy: "never", approvalsReviewer: "user", sandbox: { type: "dangerFullAccess" } },
    { approvalPolicy: "never", approvalsReviewer: "auto_review", sandbox: { type: "workspaceWrite", writableRoots: [], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false } },
  ] as const) {
    const response = pinnedCodexRequests.threadResume.outputCodec.parse({
      thread,
      model: "gpt-5.6-sol",
      reasoningEffort: "ultra",
      serviceTier: null,
      ...responsePolicy,
    });
    expect(() => verifyProductionThreadAdmission({
      proof,
      generation: 1,
      streamPosition: 2,
      request,
      response,
    })).toThrow(ProductionExecutionPolicyError);
  }
});

test("production execution receipts reject a generation race", () => {
  const proof = verifyProductionExecutionPolicyRequirements({
    generation: 3,
    streamPosition: 1,
    output: { requirements: null },
  });
  const request = pinnedCodexRequests.threadStart.inputCodec.parse({
    approvalPolicy: "never",
    approvalsReviewer: "auto_review",
    sandbox: "danger-full-access",
  });
  const response = pinnedCodexRequests.threadStart.outputCodec.parse({
    thread,
    model: "gpt-5.6-sol",
    reasoningEffort: "ultra",
    serviceTier: null,
    approvalPolicy: "never",
    approvalsReviewer: "auto_review",
    sandbox: { type: "dangerFullAccess" },
  });
  expect(() => verifyProductionThreadAdmission({
    proof,
    generation: 4,
    streamPosition: 2,
    request,
    response,
  })).toThrow(ProductionExecutionPolicyError);
  expect(() => verifyProductionThreadAdmission({
    proof,
    generation: 3,
    streamPosition: 1,
    request,
    response,
  })).toThrow(ProductionExecutionPolicyError);
});

test("every pinned approval request is unexpected under production policy", () => {
  expect([
    "item/commandExecution/requestApproval",
    "item/fileChange/requestApproval",
    "item/permissions/requestApproval",
    "applyPatchApproval",
    "execCommandApproval",
  ].every(isProductionApprovalRequestMethod)).toBeTrue();
  expect(isProductionApprovalRequestMethod("item/tool/requestUserInput")).toBeFalse();
  expect(isProductionApprovalRequestMethod("mcpServer/elicitation/request")).toBeFalse();
});
