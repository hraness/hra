import { describe, expect, test } from "bun:test";

import {
  commandResultKinds,
  commandEventKinds,
  commandInteractionStates,
  commandRunPhases,
  commandTaskEventTypes,
  importedRunSummarySchema,
  localWorkspaceCommandKindValues,
  localWorkspaceCommandSchema,
  operationReceiptSchema,
  operationReplayDisposition,
  parentRelationKey,
  portableTaskCommandKindValues,
  portableTaskCommandSchema,
  portableSystemCommandKindValues,
  portableWorkspaceEventSchema,
  portableRunInteractionResponseSchema,
  promotionBatchSchema,
  promotionEntityCountsSchema,
  promotionEntityFamilyValues,
  promotionEntityIdentity,
  promotionEntitySchema,
  promotionManifestSchema,
  dependencyRelationKey,
  taskLabelRelationKey,
  taskRepositoryRelationKey,
  taskPublicIdSchema,
  systemCommandActorJobKinds,
  workspaceAuthoritySchema,
  workspacePublicIdSchema,
} from "./index";

const LOCATOR = "0123456789ABCDEFGHJKMNPQRS";
const WORKSPACE_ID = `wsp_${LOCATOR}`;
const OTHER_WORKSPACE_ID = "wsp_1123456789ABCDEFGHJKMNPQRS";
const TASK_ID = `tsk_${LOCATOR}`;
const OTHER_TASK_ID = "tsk_1123456789ABCDEFGHJKMNPQRS";
const REPOSITORY_ID = `repo_${LOCATOR}`;
const OPERATION_ID = `op_${LOCATOR}`;
const OTHER_EVENT_ID = "wevt_1123456789ABCDEFGHJKMNPQRS";
const INSTALLATION_ID = "install_0123456789abcdef0123456789abcdef";
const AUTHORITY = {
  kind: "local_owner" as const,
  workspaceId: WORKSPACE_ID,
  installationId: INSTALLATION_ID,
};
const COMMAND_BASE = {
  operationId: OPERATION_ID,
  authority: AUTHORITY,
  expectedWorkspaceRevision: 3,
};
const TASK_COMMAND_BASE = {
  ...COMMAND_BASE,
  taskId: TASK_ID,
  expectedTaskRevision: 4,
};

const commandSamples = {
  "workspace.rename": { ...COMMAND_BASE, kind: "workspace.rename", name: "HRA" },
  "task.create": {
    ...COMMAND_BASE,
    kind: "task.create",
    taskId: TASK_ID,
    title: "Make soup",
    type: "task",
    priority: 2,
    availableAt: 1,
    labels: ["hra"],
    repositoryId: REPOSITORY_ID,
  },
  "task.create_and_run": {
    ...COMMAND_BASE,
    kind: "task.create_and_run",
    taskId: TASK_ID,
    title: "Make soup",
    type: "task",
    priority: 2,
    availableAt: 1,
    labels: ["hra"],
    repositoryId: REPOSITORY_ID,
  },
  "task.update": {
    ...TASK_COMMAND_BASE,
    kind: "task.update",
    patch: { title: "Make better soup" },
  },
  "task.cancel": { ...TASK_COMMAND_BASE, kind: "task.cancel", reason: "No longer needed" },
  "task.reopen": { ...TASK_COMMAND_BASE, kind: "task.reopen" },
  "task.assign": {
    ...TASK_COMMAND_BASE,
    kind: "task.assign",
    assigneeAgentId: "agent_local_001",
  },
  "task.defer": { ...TASK_COMMAND_BASE, kind: "task.defer", availableAt: 10 },
  "task.parent_set": {
    ...TASK_COMMAND_BASE,
    kind: "task.parent_set",
    parentTaskId: OTHER_TASK_ID,
    expectedParentRevision: 2,
  },
  "task.parent_clear": { ...TASK_COMMAND_BASE, kind: "task.parent_clear" },
  "task.label_add": { ...TASK_COMMAND_BASE, kind: "task.label_add", label: "urgent" },
  "task.label_remove": { ...TASK_COMMAND_BASE, kind: "task.label_remove", label: "urgent" },
  "task.comment_add": {
    ...COMMAND_BASE,
    kind: "task.comment_add",
    taskId: TASK_ID,
    body: "Ready for review",
  },
  "task.reference_add": {
    ...TASK_COMMAND_BASE,
    kind: "task.reference_add",
    reference: { kind: "url", label: "Spec", url: "https://example.com/spec" },
  },
  "task.reference_remove": {
    ...TASK_COMMAND_BASE,
    kind: "task.reference_remove",
    referenceId: `ref_${LOCATOR}`,
  },
  "dependency.add": {
    ...TASK_COMMAND_BASE,
    kind: "dependency.add",
    blockerTaskId: OTHER_TASK_ID,
    expectedBlockerRevision: 2,
  },
  "dependency.remove": {
    ...TASK_COMMAND_BASE,
    kind: "dependency.remove",
    blockerTaskId: OTHER_TASK_ID,
    expectedBlockerRevision: 2,
  },
  "task.submit": {
    ...TASK_COMMAND_BASE,
    kind: "task.submit",
    fence: 2,
    expectedReviewRevision: 4,
    summary: "Done",
    evidence: [{ kind: "note", text: "Focused checks pass" }],
  },
  "review.accept": {
    ...COMMAND_BASE,
    kind: "review.accept",
    taskId: TASK_ID,
    submissionId: `sub_${LOCATOR}`,
    expectedReviewRevision: 4,
  },
  "review.reject": {
    ...COMMAND_BASE,
    kind: "review.reject",
    taskId: TASK_ID,
    submissionId: `sub_${LOCATOR}`,
    expectedReviewRevision: 4,
    reason: "Needs a test",
  },
  "dispatch.stop": { ...COMMAND_BASE, kind: "dispatch.stop", runId: "run_primary0001" },
  "dispatch.retry": {
    ...TASK_COMMAND_BASE,
    kind: "dispatch.retry",
    sourceRunId: "run_primary0001",
  },
  "dispatch.resolve_ambiguity": {
    ...TASK_COMMAND_BASE,
    kind: "dispatch.resolve_ambiguity",
    sourceRunId: "run_primary0001",
    reason: "confirmed_cancelled",
  },
  "interaction.respond": {
    ...COMMAND_BASE,
    kind: "interaction.respond",
    runId: "run_primary0001",
    interactionId: "interaction_primary0001",
    request: {
      id: "interaction_primary0001",
      createdAt: 1,
      expiresAt: 2,
      kind: "file_change_approval",
      scope: "once",
    },
    response: { kind: "file_change_approval", decision: "approve_once" },
  },
  "interaction.settle": {
    ...TASK_COMMAND_BASE,
    kind: "interaction.settle",
    runId: "run_primary0001",
    settlement: {
      interactionId: "interaction_primary0001",
      responseRevision: 1,
      outcome: "applied",
    },
  },
} as const satisfies Record<(typeof portableTaskCommandKindValues)[number], unknown>;

const systemCommandSamples = {
  "defer.wake": {
    kind: "defer.wake",
    operationId: OPERATION_ID,
    workspaceId: WORKSPACE_ID,
    taskId: TASK_ID,
    expectedTaskRevision: 4,
    scheduledFor: 1,
  },
  "claim.expire": {
    kind: "claim.expire",
    operationId: OPERATION_ID,
    workspaceId: WORKSPACE_ID,
    taskId: TASK_ID,
    claimId: "claim_local_001",
    fence: 1,
    leaseGeneration: 1,
    expectedDeadline: 1,
  },
  "run.reconcile": {
    kind: "run.reconcile",
    operationId: OPERATION_ID,
    workspaceId: WORKSPACE_ID,
    runId: "run_primary0001",
    bootGeneration: 1,
  },
  "interaction.expire": {
    kind: "interaction.expire",
    operationId: OPERATION_ID,
    workspaceId: WORKSPACE_ID,
    runId: "run_primary0001",
    interactionId: "interaction_primary0001",
    expectedDeadline: 1,
  },
  "workspace.repair": {
    kind: "workspace.repair",
    operationId: OPERATION_ID,
    workspaceId: WORKSPACE_ID,
    expectedWorkspaceRevision: 3,
  },
} as const satisfies Record<(typeof portableSystemCommandKindValues)[number], unknown>;

const counts = promotionEntityCountsSchema.parse(Object.fromEntries(
  promotionEntityFamilyValues.map((family) => [family, family === "workspace_metadata" ||
      family === "executors"
    ? 1
    : 0]),
));

describe("portable task contracts", () => {
  test("freezes cloud-compatible public ID prefixes", () => {
    expect(workspacePublicIdSchema.parse(WORKSPACE_ID)).toBe(WORKSPACE_ID);
    expect(taskPublicIdSchema.parse(TASK_ID)).toBe(TASK_ID);
    expect(workspacePublicIdSchema.safeParse(`ws_${LOCATOR}`).success).toBeFalse();
    expect(taskPublicIdSchema.safeParse(`task_${LOCATOR}`).success).toBeFalse();
  });

  test("keeps workspace authority provider-neutral and promotion fail-closed", () => {
    expect(workspaceAuthoritySchema.parse({
      kind: "local",
      localWorkspaceId: WORKSPACE_ID,
      ownerInstallationId: INSTALLATION_ID,
    }).kind).toBe("local");
    expect(workspaceAuthoritySchema.safeParse({
      kind: "local",
      localWorkspaceId: WORKSPACE_ID,
      ownerInstallationId: `install_${LOCATOR}`,
    }).success).toBeFalse();
    expect(workspaceAuthoritySchema.parse({
      kind: "promoting",
      localWorkspaceId: WORKSPACE_ID,
      promotionId: `promotion_${LOCATOR}`,
      phase: "outcome_unknown",
    }).kind).toBe("promoting");
    expect(workspaceAuthoritySchema.parse({
      kind: "cloud",
      cloudWorkspaceId: WORKSPACE_ID,
    }).kind).toBe("cloud");
    expect(workspaceAuthoritySchema.safeParse({
      kind: "cloud",
      cloudWorkspaceId: WORKSPACE_ID,
      organizationId: "org_secret",
    }).success).toBeFalse();
  });

  test("covers every workspace action with a strict command and correlated receipt result", () => {
    expect(Object.keys(commandSamples).sort()).toEqual([...portableTaskCommandKindValues].sort());
    expect(Object.keys(commandResultKinds).sort()).toEqual([...localWorkspaceCommandKindValues].sort());
    expect(Object.keys(commandEventKinds).sort()).toEqual([...localWorkspaceCommandKindValues].sort());
    for (const kind of portableTaskCommandKindValues) {
      expect(portableTaskCommandSchema.parse(commandSamples[kind]).kind).toBe(kind);
    }
    for (const kind of portableSystemCommandKindValues) {
      expect(localWorkspaceCommandSchema.parse(systemCommandSamples[kind]).kind).toBe(kind);
    }

    const receipt = {
      receiptId: `receipt_${LOCATOR}`,
      operationId: OPERATION_ID,
      workspaceId: WORKSPACE_ID,
      commandKind: "task.create" as const,
      commandDigest: `sha256_${"a".repeat(64)}`,
      recordedAt: 1,
      outcome: "committed" as const,
      workspaceRevision: 4,
      eventSequence: 1,
      eventIds: [`wevt_${LOCATOR}`],
      eventKinds: ["task.changed" as const],
      result: { kind: "task_created" as const, taskId: TASK_ID, taskRevision: 1 },
    };
    expect(operationReceiptSchema.parse(receipt)).toEqual(receipt);
    expect(operationReceiptSchema.safeParse({
      ...receipt,
      result: { kind: "reference_removed", taskId: TASK_ID, referenceId: `ref_${LOCATOR}` },
    }).success).toBeFalse();
  });

  test("binds every owner and system command to an atomic result and typed event family", () => {
    const resultByKind = {
      workspace: { kind: "workspace" as const, workspaceRevision: 4 },
      task_created: {
        kind: "task_created" as const,
        taskId: TASK_ID,
        taskRevision: 1,
      },
      task_updated: {
        kind: "task_updated" as const,
        taskId: TASK_ID,
        taskRevision: 5,
      },
      comment_added: {
        kind: "comment_added" as const,
        taskId: TASK_ID,
        commentId: `cmt_${LOCATOR}`,
      },
      reference_added: {
        kind: "reference_added" as const,
        taskId: TASK_ID,
        referenceId: `ref_${LOCATOR}`,
      },
      reference_removed: {
        kind: "reference_removed" as const,
        taskId: TASK_ID,
        referenceId: `ref_${LOCATOR}`,
      },
      submission_updated: {
        kind: "submission_updated" as const,
        taskId: TASK_ID,
        submissionId: `sub_${LOCATOR}`,
        taskRevision: 5,
      },
      run_updated: {
        kind: "run_updated" as const,
        runId: "run_primary0001",
        phase: "running" as const,
      },
      interaction_updated: {
        kind: "interaction_updated" as const,
        runId: "run_primary0001",
        interactionId: "interaction_primary0001",
        state: "resolved" as const,
      },
    };
    const resultFor = (
      commandKind: (typeof localWorkspaceCommandKindValues)[number],
    ): unknown => {
      const resultKind = commandResultKinds[commandKind][0];
      if (resultKind === undefined) throw new Error("command must have a result kind");
      const result = resultByKind[resultKind];
      if (result.kind === "task_created") {
        return commandKind === "task.create_and_run"
          ? { ...result, runId: "run_primary0001" }
          : result;
      }
      if (result.kind === "run_updated") {
        return {
          ...result,
          phase: commandRunPhases[
            commandKind as keyof typeof commandRunPhases
          ]?.[0] ?? result.phase,
        };
      }
      if (result.kind === "interaction_updated") {
        return {
          ...result,
          state: commandInteractionStates[
            commandKind as keyof typeof commandInteractionStates
          ]?.[0] ?? result.state,
        };
      }
      return result;
    };
    const eventFor = (
      commandKind: (typeof localWorkspaceCommandKindValues)[number],
      kind: (typeof commandEventKinds)[typeof commandKind][number],
    ): unknown => {
      const base = {
        id: `wevt_${LOCATOR}`,
        workspaceId: WORKSPACE_ID,
        sequence: 1,
        workspaceRevision: 4,
        operationId: OPERATION_ID,
        commandKind,
        actor: portableSystemCommandKindValues.some((candidate) => candidate === commandKind)
          ? {
              kind: "system" as const,
              jobKind: systemCommandActorJobKinds[
                commandKind as keyof typeof systemCommandActorJobKinds
              ],
            }
          : { kind: "local_owner" as const, installationId: INSTALLATION_ID },
        recordedAt: 1,
      };
      switch (kind) {
        case "task.changed":
          return {
            ...base,
            kind,
            taskId: TASK_ID,
            taskRevision: 5,
            eventType: commandTaskEventTypes[
              commandKind as keyof typeof commandTaskEventTypes
            ],
          };
        case "workspace.renamed":
        case "system.workspace_repaired":
          return { ...base, kind };
        case "run.changed":
          return {
            ...base,
            kind,
            taskId: TASK_ID,
            runId: "run_primary0001",
            phase: commandRunPhases[
              commandKind as keyof typeof commandRunPhases
            ]?.[0] ?? "running",
          };
        case "interaction.changed":
          return {
            ...base,
            kind,
            taskId: TASK_ID,
            runId: "run_primary0001",
            interactionId: "interaction_primary0001",
            state: commandInteractionStates[
              commandKind as keyof typeof commandInteractionStates
            ]?.[0] ?? "resolved",
          };
        case "system.defer_woke":
          return { ...base, kind, taskId: TASK_ID, scheduledFor: 1 };
        case "system.claim_expired":
          return {
            ...base,
            kind,
            taskId: TASK_ID,
            claimId: "claim_local_001",
            fence: 1,
          };
        case "system.run_reconciled":
          return { ...base, kind, runId: "run_primary0001", bootGeneration: 1 };
        case "system.interaction_expired":
          return {
            ...base,
            kind,
            runId: "run_primary0001",
            interactionId: "interaction_primary0001",
          };
      }
    };

    for (const commandKind of localWorkspaceCommandKindValues) {
      const resultKind = commandResultKinds[commandKind][0];
      const eventKinds = commandEventKinds[commandKind];
      const eventKind = eventKinds[0];
      expect(resultKind).toBeDefined();
      expect(eventKind).toBeDefined();
      if (resultKind === undefined || eventKind === undefined) continue;
      expect(operationReceiptSchema.safeParse({
        receiptId: `receipt_${LOCATOR}`,
        operationId: OPERATION_ID,
        workspaceId: WORKSPACE_ID,
        commandKind,
        commandDigest: `sha256_${"a".repeat(64)}`,
        recordedAt: 1,
        outcome: "committed",
        workspaceRevision: 4,
        eventSequence: eventKinds.length,
        eventIds: eventKinds.map((_, index) =>
          index === 0 ? `wevt_${LOCATOR}` : OTHER_EVENT_ID),
        eventKinds,
        result: resultFor(commandKind),
      }).success).toBeTrue();
      for (const kind of eventKinds) {
        expect(portableWorkspaceEventSchema.safeParse(
          eventFor(commandKind, kind),
        ).success).toBeTrue();
      }
    }

    const createAndRunKinds = commandEventKinds["task.create_and_run"];
    const createAndRunReceipt = {
      receiptId: `receipt_${LOCATOR}`,
      operationId: OPERATION_ID,
      workspaceId: WORKSPACE_ID,
      commandKind: "task.create_and_run" as const,
      commandDigest: `sha256_${"a".repeat(64)}`,
      recordedAt: 1,
      outcome: "committed" as const,
      workspaceRevision: 4,
      eventSequence: 2,
      eventIds: [`wevt_${LOCATOR}`, OTHER_EVENT_ID],
      eventKinds: createAndRunKinds,
      result: {
        kind: "task_created" as const,
        taskId: TASK_ID,
        taskRevision: 1,
        runId: "run_primary0001",
      },
    };
    expect(operationReceiptSchema.safeParse(createAndRunReceipt).success).toBeTrue();
    expect(operationReceiptSchema.safeParse({
      ...createAndRunReceipt,
      eventKinds: ["task.changed"],
      eventIds: [`wevt_${LOCATOR}`],
    }).success).toBeFalse();
    expect(operationReceiptSchema.safeParse({
      ...createAndRunReceipt,
      eventIds: [`wevt_${LOCATOR}`, `wevt_${LOCATOR}`],
    }).success).toBeFalse();
    expect(operationReceiptSchema.safeParse({
      ...createAndRunReceipt,
      result: {
        ...createAndRunReceipt.result,
        runId: undefined,
      },
    }).success).toBeFalse();
    expect(operationReceiptSchema.safeParse({
      ...createAndRunReceipt,
      commandKind: "task.create",
      eventSequence: 1,
      eventIds: [`wevt_${LOCATOR}`],
      eventKinds: ["task.changed"],
      result: createAndRunReceipt.result,
    }).success).toBeFalse();
    expect(portableWorkspaceEventSchema.safeParse({
      ...(eventFor("task.create", "task.changed") as Record<string, unknown>),
      eventType: "task.accepted",
    }).success).toBeFalse();
    expect(portableWorkspaceEventSchema.safeParse({
      ...(eventFor("dependency.remove", "task.changed") as Record<string, unknown>),
      eventType: "dependency.added",
    }).success).toBeFalse();
    expect(portableWorkspaceEventSchema.safeParse({
      ...(eventFor("task.create_and_run", "run.changed") as Record<string, unknown>),
      phase: "running",
    }).success).toBeFalse();
    expect(operationReceiptSchema.safeParse({
      receiptId: `receipt_${LOCATOR}`,
      operationId: OPERATION_ID,
      workspaceId: WORKSPACE_ID,
      commandKind: "workspace.rename",
      commandDigest: `sha256_${"a".repeat(64)}`,
      recordedAt: 1,
      outcome: "committed",
      workspaceRevision: 4,
      eventSequence: 1,
      eventIds: [`wevt_${LOCATOR}`],
      eventKinds: ["workspace.renamed"],
      result: { kind: "workspace", workspaceRevision: 999 },
    }).success).toBeFalse();
  });

  test("keeps create and create-and-run inputs at semantic parity", () => {
    const shared = {
      ...COMMAND_BASE,
      taskId: TASK_ID,
      title: "Make soup",
      description: "Use vegetables",
      type: "task" as const,
      priority: 2,
      availableAt: 10,
      labels: ["hra", "urgent"],
      parentTaskId: OTHER_TASK_ID,
      expectedParentRevision: 2,
      repositoryId: REPOSITORY_ID,
    };
    for (const kind of ["task.create", "task.create_and_run"] as const) {
      expect(portableTaskCommandSchema.safeParse({ ...shared, kind }).success).toBeTrue();
      expect(portableTaskCommandSchema.safeParse({
        ...shared,
        kind,
        expectedParentRevision: undefined,
      }).success).toBeFalse();
      expect(portableTaskCommandSchema.safeParse({
        ...shared,
        kind,
        labels: ["hra", "hra"],
      }).success).toBeFalse();
    }
  });

  test("rejects ambiguous interaction answers and contradictory local settlements", () => {
    const answerBase = {
      kind: "user_input" as const,
      answers: [{
        questionId: "question_primary0001",
        selectedOptionIds: ["option_primary0001"],
      }],
    };
    expect(portableRunInteractionResponseSchema.parse(answerBase)).toEqual(answerBase);
    expect(portableRunInteractionResponseSchema.safeParse({
      ...answerBase,
      answers: [{
        questionId: "question_primary0001",
        selectedOptionIds: [],
        otherText: "   ",
      }],
    }).success).toBeFalse();
    expect(portableRunInteractionResponseSchema.safeParse({
      ...answerBase,
      answers: [
        answerBase.answers[0],
        answerBase.answers[0],
      ],
    }).success).toBeFalse();
    expect(portableTaskCommandSchema.safeParse({
      ...COMMAND_BASE,
      kind: "interaction.respond",
      runId: "run_primary0001",
      interactionId: "interaction_primary0001",
      request: {
        id: "interaction_primary0001",
        createdAt: 1,
        expiresAt: 2,
        kind: "user_input",
        questions: [{
          id: "question_primary0001",
          header: "Choice",
          prompt: "Continue?",
          allowOther: false,
          options: [{ id: "option_primary0001", label: "Yes" }],
        }],
      },
      response: {
        kind: "user_input",
        answers: [{
          questionId: "question_primary0001",
          selectedOptionIds: ["option_fabricated001"],
        }],
      },
    }).success).toBeFalse();
    expect(portableTaskCommandSchema.safeParse({
      ...TASK_COMMAND_BASE,
      kind: "interaction.settle",
      runId: "run_primary0001",
      settlement: {
        interactionId: "interaction_primary0001",
        outcome: "expired",
        reason: "local_deadline",
        responseRevision: 1,
      },
    }).success).toBeFalse();
    expect(portableTaskCommandSchema.safeParse({
      ...TASK_COMMAND_BASE,
      kind: "interaction.settle",
      runId: "run_primary0001",
      settlement: {
        interactionId: "interaction_primary0001",
        outcome: "applied",
      },
    }).success).toBeFalse();
  });

  test("classifies exact operation replay and rejects same-ID digest drift", () => {
    const existing = { operationId: OPERATION_ID, commandDigest: `sha256_${"a".repeat(64)}` };
    expect(operationReplayDisposition(null, existing)).toBe("execute");
    expect(operationReplayDisposition(existing, existing)).toBe("replay");
    expect(operationReplayDisposition(existing, {
      ...existing,
      commandDigest: `sha256_${"b".repeat(64)}`,
    })).toBe("conflict");
  });

  test("records account-free per-workspace events without cloud tenancy", () => {
    const event = {
      id: `wevt_${LOCATOR}`,
      workspaceId: WORKSPACE_ID,
      sequence: 1,
      workspaceRevision: 1,
      operationId: OPERATION_ID,
      actor: { kind: "local_owner" as const, installationId: INSTALLATION_ID },
      kind: "task.imported" as const,
      taskId: TASK_ID,
      taskRevision: 1,
      sourceWorkspaceId: OTHER_WORKSPACE_ID,
      sourceTaskId: TASK_ID,
      recordedAt: 1,
    };
    expect(portableWorkspaceEventSchema.parse(event)).toEqual(event);
    expect(portableWorkspaceEventSchema.safeParse({
      ...event,
      sourceWorkspaceId: WORKSPACE_ID,
    }).success).toBeFalse();
    expect(portableWorkspaceEventSchema.safeParse({
      ...event,
      organizationId: "org_forbidden",
    }).success).toBeFalse();
  });
});

describe("portable promotion contracts", () => {
  test("keeps manifest count keys and upload families exactly aligned", () => {
    expect(promotionEntityCountsSchema.parse(counts)).toEqual(counts);
    expect(Object.keys(counts).sort()).toEqual([...promotionEntityFamilyValues].sort());
  });

  test("freezes a terminal manifest and rejects live or secret-bearing fields", () => {
    const manifest = {
      schemaVersion: 1 as const,
      promotionId: `promotion_${LOCATOR}`,
      sourceWorkspaceId: WORKSPACE_ID,
      sourceWorkspaceRevision: 2,
      sourceEventSequence: 3,
      createdAt: 4,
      rootDigest: `sha256_${"a".repeat(64)}`,
      counts,
      repositoryIds: [],
      taskIds: [],
      terminalLocalWork: {
        queuedIntents: 0 as const,
        activeClaims: 0 as const,
        nonterminalRuns: 0 as const,
        openInteractions: 0 as const,
      },
    };
    expect(promotionManifestSchema.parse(manifest)).toEqual(manifest);
    for (const forbidden of [
      { accessToken: "secret" },
      { accountId: "acct_local" },
      { worktreePath: "/Users/person/project" },
      { activeClaims: [{ id: "claim" }] },
      { interactions: [{ answer: "yes" }] },
      { rawEvents: [] },
      { commands: [] },
      { transcript: "private" },
    ]) {
      expect(promotionManifestSchema.safeParse({ ...manifest, ...forbidden }).success).toBeFalse();
    }
  });

  test("imports only immutable terminal summaries with sanitized evidence", () => {
    const summary = {
      id: `irun_${LOCATOR}`,
      provenance: {
        kind: "imported_local" as const,
        sourceWorkspaceId: WORKSPACE_ID,
        sourceTaskId: TASK_ID,
        importedAt: 10,
      },
      sourceRunId: "run_primary0001",
      taskId: TASK_ID,
      terminalPhase: "failed" as const,
      summary: "Run stopped",
      evidence: [{ kind: "note" as const, text: "No live output retained" }],
      finishedAt: 10,
      retryable: false as const,
      resumable: false as const,
      reviewable: false as const,
    };
    expect(importedRunSummarySchema.parse(summary)).toEqual(summary);
    expect(importedRunSummarySchema.safeParse({
      ...summary,
      evidence: [{ kind: "test", command: "cat .env" }],
    }).success).toBeFalse();
    expect(importedRunSummarySchema.safeParse({ ...summary, localPath: "/tmp/worktree" }).success)
      .toBeFalse();
  });

  test("keeps every promotion entity strict and every batch single-family", () => {
    const metadata = {
      family: "workspace_metadata" as const,
      workspaceId: WORKSPACE_ID,
      name: "HRA",
      slug: "hra",
      keyPrefix: "KIT",
    };
    expect(promotionEntitySchema.parse(metadata)).toEqual(metadata);
    expect(promotionEntitySchema.safeParse({ ...metadata, credential: "secret" }).success)
      .toBeFalse();
    expect(promotionBatchSchema.safeParse({
      promotionId: `promotion_${LOCATOR}`,
      batchId: `batch_${LOCATOR}`,
      family: "tasks",
      ordinal: 0,
      items: [metadata],
      requestDigest: `sha256_${"a".repeat(64)}`,
    }).success).toBeFalse();
  });

  test("round-trips every task relation through a canonical upsert identity", () => {
    const relations = [
      {
        family: "task_repository_links" as const,
        relationKey: taskRepositoryRelationKey(TASK_ID, REPOSITORY_ID),
        taskId: TASK_ID,
        repositoryId: REPOSITORY_ID,
      },
      {
        family: "parent_edges" as const,
        relationKey: parentRelationKey(TASK_ID, OTHER_TASK_ID),
        taskId: TASK_ID,
        parentTaskId: OTHER_TASK_ID,
      },
      {
        family: "dependencies" as const,
        relationKey: dependencyRelationKey(OTHER_TASK_ID, TASK_ID),
        blockerTaskId: OTHER_TASK_ID,
        blockedTaskId: TASK_ID,
      },
      {
        family: "labels" as const,
        relationKey: taskLabelRelationKey(TASK_ID, "hra"),
        taskId: TASK_ID,
        label: "hra",
      },
    ];
    for (const relation of relations) {
      const parsed = promotionEntitySchema.parse(relation);
      expect(promotionEntityIdentity(parsed)).toBe(relation.relationKey);
      expect(parsed).toEqual(relation);
    }
  });

  test("assigns every upload family a stable public ID or canonical relation key", () => {
    const importedSummary = {
      id: `irun_${LOCATOR}`,
      provenance: {
        kind: "imported_local" as const,
        sourceWorkspaceId: WORKSPACE_ID,
        sourceTaskId: TASK_ID,
        importedAt: 1,
      },
      sourceRunId: "run_primary0001",
      taskId: TASK_ID,
      terminalPhase: "cancelled" as const,
      summary: "Cancelled",
      evidence: [],
      finishedAt: 1,
      retryable: false as const,
      resumable: false as const,
      reviewable: false as const,
    };
    const entities = [
      {
        family: "workspace_metadata",
        workspaceId: WORKSPACE_ID,
        name: "HRA",
        slug: "hra",
        keyPrefix: "KIT",
      },
      {
        family: "executors",
        workspaceId: WORKSPACE_ID,
        executor: "local_codex",
        enabled: true,
      },
      {
        family: "repositories",
        id: REPOSITORY_ID,
        name: "HRA",
        provider: "github",
        url: "https://example.com/hra",
      },
      {
        family: "tasks",
        id: TASK_ID,
        key: "KIT-123ABCD",
        title: "Make soup",
        type: "task",
        priority: 2,
        status: "open",
        availableAt: 4,
        revision: 1,
        reviewRevision: 1,
        assignee: { kind: "builtin_executor" },
      },
      { family: "task_bodies", taskId: TASK_ID, description: "Use vegetables." },
      {
        family: "task_repository_links",
        relationKey: taskRepositoryRelationKey(TASK_ID, REPOSITORY_ID),
        taskId: TASK_ID,
        repositoryId: REPOSITORY_ID,
      },
      {
        family: "parent_edges",
        relationKey: parentRelationKey(TASK_ID, OTHER_TASK_ID),
        taskId: TASK_ID,
        parentTaskId: OTHER_TASK_ID,
      },
      {
        family: "dependencies",
        relationKey: dependencyRelationKey(OTHER_TASK_ID, TASK_ID),
        blockerTaskId: OTHER_TASK_ID,
        blockedTaskId: TASK_ID,
      },
      {
        family: "labels",
        relationKey: taskLabelRelationKey(TASK_ID, "hra"),
        taskId: TASK_ID,
        label: "hra",
      },
      {
        family: "comments",
        id: `cmt_${LOCATOR}`,
        taskId: TASK_ID,
        body: "Use carrots.",
        authorProvenance: "local_owner",
        createdAt: 1,
      },
      {
        family: "references",
        taskId: TASK_ID,
        reference: {
          id: `ref_${LOCATOR}`,
          createdAt: 1,
          kind: "url",
          label: "Recipe",
          url: "https://example.com/recipe",
        },
      },
      {
        family: "submissions",
        taskId: TASK_ID,
        submissionId: `sub_${LOCATOR}`,
        reviewRevision: 1,
        status: "accepted",
        summary: "Done",
        evidence: [],
      },
      {
        family: "reviews",
        taskId: TASK_ID,
        submissionId: `sub_${LOCATOR}`,
        decision: "accepted",
        reviewerProvenance: "local_owner",
        reviewedAt: 2,
      },
      {
        family: "terminal_states",
        taskId: TASK_ID,
        status: "done",
        acceptedSubmissionId: `sub_${LOCATOR}`,
        terminalAt: 2,
      },
      { family: "imported_run_summaries", summary: importedSummary },
    ];
    const parsed = entities.map((entity) => promotionEntitySchema.parse(entity));
    expect(parsed.map(({ family }) => family).sort()).toEqual(
      [...promotionEntityFamilyValues].sort(),
    );
    expect(parsed.map((entity) => `${entity.family}:${promotionEntityIdentity(entity)}`))
      .toHaveLength(promotionEntityFamilyValues.length);
    const terminalState = parsed.find((entity) => entity.family === "terminal_states");
    expect(terminalState).toBeDefined();
    if (terminalState !== undefined) {
      expect(promotionEntityIdentity(terminalState)).toBe(TASK_ID);
    }
  });
});
