import { describe, expect, test } from "bun:test";
import { Buffer } from "node:buffer";
import { RUNNER_PRESENCE_LEASE_MS } from "@hraness/agent-tasks-protocol";
import {
  chatPaneProjectionSchema,
  chatPaneStateProjectionSchema,
  chatRootTurnRoutingProjectionSchema,
  parseRuntimeDispatchRequest,
  parseRuntimeDispatchResponse,
  parseRuntimeChatDispatchResponseForRequest,
  parseRuntimeDispatchTransportRequest,
  parseRuntimeDispatchTransportResponse,
  parseRuntimeEvent,
  parseRuntimeProjectAddResult,
  parseRuntimeSnapshotResponse,
  parseRuntimeSnapshotTransportResponse,
  parseRuntimeTaskDispatchRequest,
  parseRuntimeTaskDispatchResponseForRequest,
  parseRuntimeTransportLifecycle,
  parseRuntimeTransportRetryResponse,
  runtimeDispatchChunkByteLimit,
  runtimeChatMessageUtf8ByteLimit,
  runtimeHumanCredentialReconnectConfirmation,
  runtimeProtocolVersion,
  runtimeSnapshotChunkBase64Limit,
  runtimeSnapshotChunkCountLimit,
  runtimeTaskMutationResultsEqual,
  type RuntimeChatDispatchRequest,
} from "./runtime";

const ready = { state: "ready", generation: 1 } as const;
const account = {
  id: "acct_12345678",
  revision: 3,
  label: "Work",
  selected: true,
  identityLabel: "builder@example.com",
  planLabel: "pro",
  usageRemainingPercent: 73,
  authState: "signedIn",
  login: { state: "idle" },
  runtime: ready,
} as const;
const snapshot = {
  revision: 1,
  lastSequence: 0,
  runtime: ready,
  runner: { state: "connected" },
  accounts: [account],
  retainedAccountLocalData: [],
  humanAccount: { state: "signedOut", revision: 0 },
  chat: { revision: 1, panes: [] },
  sessionSync: {
    status: {
      state: "unavailable",
      reason: "cloudConfigurationMissing",
      retryable: false,
    },
    localGridSlots: [],
    remoteSessions: [],
  },
  harness: null,
} as const;

const workspaceId = "wsp_00000000000000000000000000";
const taskId = "tsk_00000000000000000000000000";
const repositoryId = "repo_00000000000000000000000000";
const durableOperationId = "op_00000000000000000000000000";
const recovery = {
  promotionId: "promotion_01ARZ3NDEKTSV4RRFFQ69G5FAV",
  localWorkspaceId: "wsp_11111111111111111111111111",
  cloudWorkspaceId: workspaceId,
  access: "read_only",
  createdAt: 10,
  lastOpenedAt: 11,
} as const;
const workspaceSummary = {
  id: workspaceId,
  name: "Local hra",
  slug: "local-hra",
  keyPrefix: "KIT",
  revision: 7,
  authority: {
    kind: "local",
    localWorkspaceId: workspaceId,
    ownerInstallationId: "install_local0001",
  },
  counts: {
    all: { capped: false, value: 1 },
    ready: { capped: false, value: 1 },
    blocked: { capped: false, value: 0 },
    deferred: { capped: false, value: 0 },
    attention: { capped: false, value: 0 },
    assigned: { capped: false, value: 0 },
    review: { capped: false, value: 0 },
  },
} as const;

const taskListPage = {
  workspaceId,
  view: "all",
  projectionRevision: 7,
  items: [],
  cursor: null,
  hasMore: false,
} as const;

const taskRepositoryList = {
  workspaceId,
  projectionRevision: 7,
  repositories: [{
    id: repositoryId,
    name: "example",
    ready: true,
  }],
} as const;

const taskDetail = {
  workspaceId,
  projectionRevision: 7,
  task: {
    id: taskId,
    key: "KIT-0000000",
    title: "Keep task state local",
    type: "task",
    priority: 2,
    availableAt: 0,
    isReady: true,
    unresolvedBlockerCount: 0,
    cancelledBlockerCount: 0,
    revision: 3,
    reviewRevision: 1,
    createdAt: 0,
    updatedAt: 0,
    status: "open",
  },
  description: "",
  labels: [],
  parent: null,
  blockers: [],
  dependents: [],
  children: [],
  comments: [],
  events: [],
  references: [],
  runs: [],
  submission: null,
  recoveries: [],
  truncatedCollections: [],
} as const;

const taskWorkspaceProjectionResult = {
  type: "taskWorkspaceProjection",
  consistency: "atomic",
  presentation: {
    agents: [{ id: "agent_local", name: "Local agent", status: "active" }],
    capabilities: {
      canAssign: true,
      canCancel: true,
      canComment: true,
      canCreate: true,
      canEdit: true,
      canManageGraph: true,
      canManageLabels: true,
      canManageReferences: true,
      canReopen: true,
      canReview: true,
    },
    counts: workspaceSummary.counts,
    now: 1,
    runner: {
      presence: { state: "offline", serverTime: 1 },
      repositories: taskRepositoryList.repositories,
    },
    viewer: { kind: "local_owner", id: "install_local0001", name: "You" },
    workspace: {
      id: workspaceId,
      keyPrefix: workspaceSummary.keyPrefix,
      name: workspaceSummary.name,
      slug: workspaceSummary.slug,
    },
  },
  projection: {
    workspaceId,
    view: "all",
    selectedTaskId: taskId,
    projectionRevision: 7,
    continuationRevision: 7,
    firstPage: taskListPage,
    detail: taskDetail,
  },
} as const;

const renameCommand = {
  kind: "workspace.rename",
  operationId: durableOperationId,
  expectedWorkspaceRevision: 7,
  name: "Renamed hra",
} as const;

const renameMutation = {
  operationId: durableOperationId,
  workspaceId,
  commandKind: "workspace.rename",
  workspaceRevision: 8,
  projectionRevision: 8,
  result: {
    kind: "workspace",
    workspaceRevision: 8,
  },
} as const;

describe("renderer runtime contracts", () => {
  test("keeps Native transport recovery pathless, generation-scoped, and strict", () => {
    expect(parseRuntimeTransportLifecycle({
      version: 1,
      state: "backingOff",
      generation: 3,
      attempt: 2,
      retryAtUnixMilliseconds: 1_800_000_000_000,
    })).toEqual({
      version: 1,
      state: "backingOff",
      generation: 3,
      attempt: 2,
      retryAtUnixMilliseconds: 1_800_000_000_000,
    });
    expect(parseRuntimeTransportRetryResponse({
      version: 1,
      status: "accepted",
    })).toEqual({ version: 1, status: "accepted" });
    for (const malformed of [
      { version: 1, state: "ready", generation: 0 },
      { version: 1, state: "failed", generation: 0, canRetry: true, message: "x" },
      { version: 1, state: "failed", generation: 1, canRetry: true, message: "x", path: "/tmp" },
      { version: 1, state: "backingOff", generation: 1, attempt: 0, retryAtUnixMilliseconds: 1 },
    ]) {
      expect(() => parseRuntimeTransportLifecycle(malformed)).toThrow();
    }
  });

  test("accepts every exact opaque-ID lower bound and rejects one byte less", () => {
    const minimumAccountId = "acct_1234567";
    expect(parseRuntimeDispatchRequest({
      version: runtimeProtocolVersion,
      operationId: "op_1234567",
      command: {
        type: "runtime.restartAccount",
        accountProfileId: minimumAccountId,
      },
    }).command).toEqual({
      type: "runtime.restartAccount",
      accountProfileId: minimumAccountId,
    });
    for (const request of [
      {
        version: runtimeProtocolVersion,
        operationId: "op_123456",
        command: {
          type: "runtime.restartAccount",
          accountProfileId: minimumAccountId,
        },
      },
      {
        version: runtimeProtocolVersion,
        operationId: "op_1234567",
        command: {
          type: "runtime.restartAccount",
          accountProfileId: "acct_123456",
        },
      },
    ]) {
      expect(() => parseRuntimeDispatchRequest(request)).toThrow();
    }
  });

  test("accepts local provider and optional cloud-account lifecycle commands", () => {
    for (const command of [
      { type: "runtime.restartAccount", accountProfileId: account.id },
      { type: "account.create", label: "Personal" },
      { type: "account.login.start", accountProfileId: account.id, mode: "browser" },
      { type: "account.login.cancel", accountProfileId: account.id },
      { type: "account.login.open", accountProfileId: account.id },
      { type: "account.logout", accountProfileId: account.id },
      { type: "account.refresh", accountProfileId: account.id },
      { type: "account.remove.preview", accountProfileId: account.id },
      { type: "account.remove", accountProfileId: account.id, expectedRevision: 3 },
      { type: "account.localData.delete.preview", accountProfileId: account.id },
      { type: "account.localData.delete", accountProfileId: account.id, expectedRevision: 3 },
      { type: "account.select", accountProfileId: account.id },
      { type: "human.signIn.start" },
      { type: "human.signIn.cancel" },
      { type: "human.signOut" },
      { type: "human.credentials.retry", expectedRevision: 1 },
      {
        type: "human.credentials.reconnect",
        expectedRevision: 1,
        confirmation: runtimeHumanCredentialReconnectConfirmation,
      },
      { type: "human.organizations.list", cursor: null, limit: 100 },
      { type: "human.organization.create", name: "Example" },
      { type: "human.organization.select", organizationId: "organization-id" },
      { type: "human.workspaces.list", cursor: null, limit: 100 },
      { type: "human.workspace.select", workspaceId: "workspace-id" },
    ] as const) {
      expect(parseRuntimeDispatchRequest({
        version: runtimeProtocolVersion,
        operationId: "op_12345678",
        command,
      }).command.type).toBe(command.type);
    }
    expect(() => parseRuntimeDispatchRequest({
      version: runtimeProtocolVersion,
      operationId: "op_12345678",
      command: {
        type: "human.credentials.reconnect",
        expectedRevision: 1,
        confirmation: "delete old credentials",
      },
    })).toThrow();
  });

  test("parses scoped task reads and portable local-owner mutations separately", () => {
    const requests = [
      {
        version: runtimeProtocolVersion,
        operationId: "op_native0001",
        command: { type: "task.workspaces.list" },
      },
      {
        version: runtimeProtocolVersion,
        operationId: "op_native0002",
        command: {
          type: "task.repositories.list",
          workspaceId,
        },
      },
      {
        version: runtimeProtocolVersion,
        operationId: "op_native0002b",
        command: { type: "task.workspace.context", workspaceId },
      },
      {
        version: runtimeProtocolVersion,
        operationId: "op_native0002c",
        command: { type: "task.lookup", workspaceId, taskKey: "KIT-0000000" },
      },
      {
        version: runtimeProtocolVersion,
        operationId: "op_native0003",
        command: {
          type: "task.list",
          workspaceId,
          view: "all",
          cursor: null,
          limit: 100,
        },
      },
      {
        version: runtimeProtocolVersion,
        operationId: "op_native0003b",
        command: {
          type: "task.workspace.projection",
          workspaceId,
          view: "all",
          selectedTaskId: taskId,
          minimumRevision: 7,
          limit: 100,
        },
      },
      {
        version: runtimeProtocolVersion,
        operationId: "op_native0004",
        command: { type: "task.detail", workspaceId, taskId },
      },
      {
        version: runtimeProtocolVersion,
        operationId: "op_native0005",
        command: {
          type: "task.mutate",
          workspaceId,
          intent: renameCommand,
        },
      },
    ] as const;

    for (const request of requests) {
      expect(parseRuntimeTaskDispatchRequest(request).command.type).toBe(request.command.type);
      expect(() => parseRuntimeDispatchRequest(request)).toThrow();
      expect(parseRuntimeDispatchTransportRequest(request)).toBeDefined();
    }

    for (const command of [
      {
        type: "task.list",
        workspaceId,
        recovery,
        view: "all",
        cursor: null,
        limit: 100,
      },
      {
        type: "task.detail",
        workspaceId,
        recovery,
        taskId,
      },
      {
        type: "task.workspace.projection",
        workspaceId,
        recovery,
        view: "all",
        selectedTaskId: taskId,
        minimumRevision: 7,
        limit: 100,
      },
      {
        type: "task.mutate",
        workspaceId,
        recovery,
        intent: renameCommand,
      },
    ] as const) {
      expect(parseRuntimeTaskDispatchRequest({
        version: runtimeProtocolVersion,
        operationId: "op_recovery0001",
        command,
      }).command).toMatchObject({ recovery });
    }
    expect(() => parseRuntimeTaskDispatchRequest({
      version: runtimeProtocolVersion,
      operationId: "op_recovery0002",
      command: {
        type: "task.list",
        workspaceId,
        recovery: {
          ...recovery,
          localPath: "/private/recovery.sqlite",
        },
        view: "all",
        cursor: null,
        limit: 100,
      },
    })).toThrow();

    expect(parseRuntimeTaskDispatchRequest({
      version: runtimeProtocolVersion,
        operationId: "op_native0005",
      command: {
        type: "task.list",
        workspaceId,
        view: "all",
        cursor: "opaque-next-page",
        continuationRevision: 7,
        limit: 50,
      },
    }).command).toMatchObject({ continuationRevision: 7 });

    for (const command of [
      {
        type: "task.list",
        workspaceId,
        view: "assigned",
        cursor: null,
        limit: 50,
      },
      {
        type: "task.list",
        workspaceId,
        view: "assigned",
        assignedAgentId: "agent_local",
        cursor: null,
        limit: 50,
      },
    ] as const) {
      expect(parseRuntimeTaskDispatchRequest({
        version: runtimeProtocolVersion,
        operationId: "op_assigned0001",
        command,
      }).command).toMatchObject(command);
    }

    for (const command of [
      {
        type: "task.list",
        workspaceId,
        view: "all",
        cursor: "opaque-next-page",
        limit: 50,
      },
      {
        type: "task.list",
        workspaceId,
        view: "all",
        cursor: null,
        continuationRevision: 7,
        limit: 50,
      },
      {
        type: "task.list",
        workspaceId,
        view: "all",
        assignedAgentId: "agent_local",
        cursor: null,
        limit: 50,
      },
    ]) {
      expect(() => parseRuntimeTaskDispatchRequest({
        version: runtimeProtocolVersion,
        operationId: "op_native0006",
        command,
      })).toThrow();
    }
  });

  test("keeps atomic workspace roots strict, bounded, and correlated", () => {
    const request = parseRuntimeTaskDispatchRequest({
      version: runtimeProtocolVersion,
      operationId: "op_atomicroot01",
      command: {
        type: "task.workspace.projection",
        workspaceId,
        view: "all",
        selectedTaskId: taskId,
        minimumRevision: 7,
        limit: 100,
      },
    });
    expect(parseRuntimeTaskDispatchResponseForRequest({
      version: runtimeProtocolVersion,
      operationId: request.operationId,
      ok: true,
      result: taskWorkspaceProjectionResult,
    }, request)).toMatchObject({
      ok: true,
      result: {
        consistency: "atomic",
        type: "taskWorkspaceProjection",
      },
    });

    for (const command of [
      {
        ...request.command,
        view: "assigned",
        selectedTaskId: null,
      },
      {
        ...request.command,
        view: "assigned",
        assignedAgentId: "agent_local",
        selectedTaskId: null,
      },
    ] as const) {
      expect(parseRuntimeTaskDispatchRequest({
        version: runtimeProtocolVersion,
        operationId: "op_atomicroot02",
        command,
      }).command).toMatchObject(command);
    }

    for (const command of [
      { ...request.command, assignedAgentId: "agent_local" },
      { ...request.command, cursor: null },
      { ...request.command, continuationRevision: 7 },
      { ...request.command, limit: 101 },
      { ...request.command, minimumRevision: undefined },
    ]) {
      expect(() => parseRuntimeTaskDispatchRequest({
        version: runtimeProtocolVersion,
        operationId: "op_atomicroot03",
        command,
      })).toThrow();
    }

    for (const result of [
      {
        ...taskWorkspaceProjectionResult,
        sourceGeneration: 1,
      },
      {
        ...taskWorkspaceProjectionResult,
        presentationRevision: 7,
      },
      {
        ...taskWorkspaceProjectionResult,
        projection: {
          ...taskWorkspaceProjectionResult.projection,
          selectedTaskId: null,
          detail: null,
        },
      },
      {
        ...taskWorkspaceProjectionResult,
        projection: {
          ...taskWorkspaceProjectionResult.projection,
          projectionRevision: 6,
          continuationRevision: 6,
          firstPage: {
            ...taskListPage,
            projectionRevision: 6,
          },
          detail: {
            ...taskDetail,
            projectionRevision: 6,
          },
        },
      },
    ]) {
      expect(() => parseRuntimeTaskDispatchResponseForRequest({
        version: runtimeProtocolVersion,
        operationId: request.operationId,
        ok: true,
        result,
      }, request)).toThrow();
    }
  });

  test("keeps local mutation recovery metadata-only and strictly bounded", () => {
    const fingerprint = `sha256_${"a".repeat(64)}`;
    const commands = [
      {
        type: "task.mutation.attempt.prepare",
        workspaceId,
        attemptId: durableOperationId,
        commandKind: "workspace.rename",
        fingerprint,
      },
      {
        type: "task.mutation.attempt.start",
        workspaceId,
        attemptId: durableOperationId,
        expectedRevision: 1,
        intent: renameCommand,
      },
      {
        type: "task.mutation.attempt.list",
        workspaceId,
        limit: 32,
      },
      {
        type: "task.mutation.attempt.inspect",
        workspaceId,
        attemptId: durableOperationId,
        expectedRevision: 2,
      },
      {
        type: "task.mutation.attempt.reconcile",
        workspaceId,
        attemptId: durableOperationId,
        expectedRevision: 2,
      },
    ] as const;
    for (const command of commands) {
      expect(parseRuntimeTaskDispatchRequest({
        version: runtimeProtocolVersion,
        operationId: "op_native_attempt01",
        command,
      }).command).toEqual(command);
    }

    for (const forbidden of [
      { intent: renameCommand },
      { command: renameCommand },
      { prose: "private task title" },
      { answer: "approve_once" },
      { path: "/Users/alice/project" },
      { provider: "github" },
      { response: { decision: "approve_once" } },
    ]) {
      expect(() => parseRuntimeTaskDispatchRequest({
        version: runtimeProtocolVersion,
        operationId: "op_native_attempt02",
        command: {
          ...commands[0],
          ...forbidden,
        },
      })).toThrow();
    }
    for (const commandKind of ["task.submit", "interaction.settle"]) {
      expect(() => parseRuntimeTaskDispatchRequest({
        version: runtimeProtocolVersion,
        operationId: "op_native_attempt03",
        command: {
          ...commands[0],
          commandKind,
        },
      })).toThrow();
    }
    expect(() => parseRuntimeTaskDispatchRequest({
      version: runtimeProtocolVersion,
      operationId: "op_native_attempt04",
      command: { ...commands[2], limit: 33 },
    })).toThrow();
  });

  test("correlates restart recovery attempts and exact local receipts", () => {
    const priorAttemptId = "op_11111111111111111111111111";
    const prepareRequest = parseRuntimeTaskDispatchRequest({
      version: runtimeProtocolVersion,
      operationId: "op_native_attempt11",
      command: {
        type: "task.mutation.attempt.prepare",
        workspaceId,
        attemptId: durableOperationId,
        commandKind: "workspace.rename",
        fingerprint: `sha256_${"b".repeat(64)}`,
      },
    });
    const prepared = {
      attemptId: durableOperationId,
      workspaceId,
      commandKind: "workspace.rename",
      revision: 1,
      preparedAt: 10,
      state: "prepared",
    } as const;
    expect(parseRuntimeTaskDispatchResponseForRequest({
      version: runtimeProtocolVersion,
      operationId: prepareRequest.operationId,
      ok: true,
      result: { type: "taskMutationAttempt", attempt: prepared },
    }, prepareRequest)).toMatchObject({ ok: true });

    const recoveredStarted = {
      ...prepared,
      attemptId: priorAttemptId,
      revision: 2,
      effectStartedAt: 11,
      state: "effect_started",
    } as const;
    expect(parseRuntimeTaskDispatchResponseForRequest({
      version: runtimeProtocolVersion,
      operationId: prepareRequest.operationId,
      ok: true,
      result: {
        type: "taskMutationAttempt",
        attempt: recoveredStarted,
      },
    }, prepareRequest)).toMatchObject({ ok: true });
    expect(() => parseRuntimeTaskDispatchResponseForRequest({
      version: runtimeProtocolVersion,
      operationId: prepareRequest.operationId,
      ok: true,
      result: {
        type: "taskMutationAttempt",
        attempt: {
          ...recoveredStarted,
          commandKind: "task.cancel",
        },
      },
    }, prepareRequest)).toThrow();
    expect(() => parseRuntimeTaskDispatchResponseForRequest({
      version: runtimeProtocolVersion,
      operationId: prepareRequest.operationId,
      ok: true,
      result: {
        type: "taskMutationAttempt",
        attempt: {
          ...recoveredStarted,
          state: "settled",
          settledAt: 12,
          terminalOutcome: "not_applied",
        },
      },
    }, prepareRequest)).toThrow();

    const reconcileRequest = parseRuntimeTaskDispatchRequest({
      version: runtimeProtocolVersion,
      operationId: "op_native_attempt12",
      command: {
        type: "task.mutation.attempt.reconcile",
        workspaceId,
        attemptId: durableOperationId,
        expectedRevision: 2,
      },
    });
    const inspectRequest = parseRuntimeTaskDispatchRequest({
      version: runtimeProtocolVersion,
      operationId: "op_native_attempt13",
      command: {
        type: "task.mutation.attempt.inspect",
        workspaceId,
        attemptId: durableOperationId,
        expectedRevision: 2,
      },
    });
    expect(parseRuntimeTaskDispatchResponseForRequest({
      version: runtimeProtocolVersion,
      operationId: inspectRequest.operationId,
      ok: true,
      result: {
        type: "taskMutationAttemptInspection",
        inspection: {
          attemptId: durableOperationId,
          workspaceId,
          commandKind: "workspace.rename",
          resolution: {
            outcome: "committed",
            mutation: renameMutation,
          },
        },
      },
    }, inspectRequest)).toMatchObject({ ok: true });
    expect(() => parseRuntimeTaskDispatchResponseForRequest({
      version: runtimeProtocolVersion,
      operationId: inspectRequest.operationId,
      ok: true,
      result: {
        type: "taskMutationAttemptInspection",
        inspection: {
          attemptId: durableOperationId,
          workspaceId,
          commandKind: "workspace.rename",
          resolution: {
            outcome: "committed",
            mutation: {
              ...renameMutation,
              operationId: priorAttemptId,
            },
          },
        },
      },
    }, inspectRequest)).toThrow();
    expect(parseRuntimeTaskDispatchResponseForRequest({
      version: runtimeProtocolVersion,
      operationId: reconcileRequest.operationId,
      ok: true,
      result: {
        type: "taskMutationReconciliation",
        reconciliation: {
          attemptId: durableOperationId,
          workspaceId,
          commandKind: "workspace.rename",
          resolution: {
            outcome: "committed",
            mutation: renameMutation,
          },
        },
      },
    }, reconcileRequest)).toMatchObject({ ok: true });
    expect(parseRuntimeTaskDispatchResponseForRequest({
      version: runtimeProtocolVersion,
      operationId: reconcileRequest.operationId,
      ok: true,
      result: {
        type: "taskMutationReconciliation",
        reconciliation: {
          attemptId: durableOperationId,
          workspaceId,
          commandKind: "workspace.rename",
          resolution: {
            outcome: "ambiguous",
            reason: "legacy_unbound_receipt",
          },
        },
      },
    }, reconcileRequest)).toMatchObject({ ok: true });
    expect(() => parseRuntimeTaskDispatchResponseForRequest({
      version: runtimeProtocolVersion,
      operationId: reconcileRequest.operationId,
      ok: true,
      result: {
        type: "taskMutationReconciliation",
        reconciliation: {
          attemptId: durableOperationId,
          workspaceId,
          commandKind: "workspace.rename",
          resolution: {
            outcome: "committed",
            mutation: {
              ...renameMutation,
              operationId: priorAttemptId,
            },
          },
        },
      },
    }, reconcileRequest)).toThrow();
  });

  test("compares independently decoded mutation results structurally", () => {
    const reordered = {
      result: {
        workspaceRevision: 8,
        kind: "workspace",
      },
      projectionRevision: 8,
      commandKind: "workspace.rename",
      workspaceId,
      operationId: durableOperationId,
      workspaceRevision: 8,
    };
    expect(runtimeTaskMutationResultsEqual(renameMutation, reordered)).toBeTrue();
    expect(runtimeTaskMutationResultsEqual(renameMutation, {
      ...reordered,
      projectionRevision: 9,
    })).toBeFalse();
    expect(runtimeTaskMutationResultsEqual(renameMutation, {
      ...reordered,
      privateField: "not schema-owned",
    })).toBeFalse();
  });

  test("correlates every scoped task result with the exact request", () => {
    const repositoriesRequest = parseRuntimeTaskDispatchRequest({
      version: runtimeProtocolVersion,
      operationId: "op_native0000",
      command: { type: "task.repositories.list", workspaceId },
    });
    expect(parseRuntimeTaskDispatchResponseForRequest({
      version: runtimeProtocolVersion,
      operationId: repositoriesRequest.operationId,
      ok: true,
      result: { type: "taskRepositoryList", page: taskRepositoryList },
    }, repositoriesRequest)).toMatchObject({
      ok: true,
      result: { type: "taskRepositoryList" },
    });
    for (const page of [
      { ...taskRepositoryList, workspaceId: "wsp_11111111111111111111111111" },
      {
        ...taskRepositoryList,
        repositories: [{
          ...taskRepositoryList.repositories[0],
          path: "/private/example",
        }],
      },
      {
        ...taskRepositoryList,
        repositories: [{
          ...taskRepositoryList.repositories[0],
          url: "https://example.test/private",
        }],
      },
    ]) {
      expect(() => parseRuntimeTaskDispatchResponseForRequest({
        version: runtimeProtocolVersion,
        operationId: repositoriesRequest.operationId,
        ok: true,
        result: { type: "taskRepositoryList", page },
      }, repositoriesRequest)).toThrow();
    }

    const listRequest = parseRuntimeTaskDispatchRequest({
      version: runtimeProtocolVersion,
      operationId: "op_native0001",
      command: {
        type: "task.list",
        workspaceId,
        view: "all",
        cursor: null,
        limit: 100,
      },
    });

    const contextRequest = parseRuntimeTaskDispatchRequest({
      version: runtimeProtocolVersion,
      operationId: "op_native0001a",
      command: { type: "task.workspace.context", workspaceId },
    });
    expect(parseRuntimeTaskDispatchResponseForRequest({
      version: runtimeProtocolVersion,
      operationId: contextRequest.operationId,
      ok: true,
      result: {
        type: "taskWorkspaceContext",
        context: {
          workspaceId,
          projectionRevision: 7,
          viewer: { kind: "local_owner", id: "install_local0001", name: "You" },
          agents: [{ id: "agent_local", name: "Local agent", status: "active" }],
          capabilities: {
            canAssign: true,
            canCancel: true,
            canComment: true,
            canCreate: true,
            canEdit: true,
            canManageGraph: true,
            canManageLabels: true,
            canManageReferences: true,
            canReopen: true,
            canReview: true,
          },
          runner: {
            state: "ready",
            serverTime: 1,
            leaseUntil: 1 + RUNNER_PRESENCE_LEASE_MS,
            availableCapacity: 1,
          },
        },
      },
    }, contextRequest)).toMatchObject({ ok: true, result: { type: "taskWorkspaceContext" } });

    const lookupTaskKey = taskDetail.task.key;
    const lookupRequest = parseRuntimeTaskDispatchRequest({
      version: runtimeProtocolVersion,
      operationId: "op_native0001b",
      command: { type: "task.lookup", workspaceId, taskKey: lookupTaskKey },
    });
    expect(parseRuntimeTaskDispatchResponseForRequest({
      version: runtimeProtocolVersion,
      operationId: lookupRequest.operationId,
      ok: true,
      result: {
        type: "taskLookup",
        workspaceId,
        taskKey: lookupTaskKey,
        task: {
          id: taskDetail.task.id,
          key: taskDetail.task.key,
          revision: taskDetail.task.revision,
          status: taskDetail.task.status,
          title: taskDetail.task.title,
          priority: taskDetail.task.priority,
        },
      },
    }, lookupRequest)).toMatchObject({ ok: true, result: { type: "taskLookup" } });
    expect(parseRuntimeTaskDispatchResponseForRequest({
      version: runtimeProtocolVersion,
      operationId: listRequest.operationId,
      ok: true,
      result: { type: "taskListPage", page: taskListPage },
    }, listRequest)).toMatchObject({ ok: true, result: { type: "taskListPage" } });

    const continuationRequest = parseRuntimeTaskDispatchRequest({
      version: runtimeProtocolVersion,
      operationId: "op_native0007",
      command: {
        type: "task.list",
        workspaceId,
        view: "all",
        cursor: "opaque-next-page",
        continuationRevision: 7,
        limit: 100,
      },
    });
    expect(() => parseRuntimeTaskDispatchResponseForRequest({
      version: runtimeProtocolVersion,
      operationId: continuationRequest.operationId,
      ok: true,
      result: {
        type: "taskListPage",
        page: { ...taskListPage, projectionRevision: 8 },
      },
    }, continuationRequest)).toThrow();

    for (const result of [
      { type: "taskWorkspaceSummaries", workspaces: [workspaceSummary] },
      {
        type: "taskListPage",
        page: { ...taskListPage, workspaceId: "wsp_11111111111111111111111111" },
      },
    ]) {
      expect(() => parseRuntimeTaskDispatchResponseForRequest({
        version: runtimeProtocolVersion,
        operationId: listRequest.operationId,
        ok: true,
        result,
      }, listRequest)).toThrow();
    }

    const detailRequest = parseRuntimeTaskDispatchRequest({
      version: runtimeProtocolVersion,
      operationId: "op_native0002",
      command: { type: "task.detail", workspaceId, taskId },
    });
    expect(parseRuntimeTaskDispatchResponseForRequest({
      version: runtimeProtocolVersion,
      operationId: detailRequest.operationId,
      ok: true,
      result: { type: "taskDetail", detail: taskDetail },
    }, detailRequest)).toMatchObject({ ok: true, result: { type: "taskDetail" } });
    expect(() => parseRuntimeTaskDispatchResponseForRequest({
      version: runtimeProtocolVersion,
      operationId: detailRequest.operationId,
      ok: true,
      result: {
        type: "taskDetail",
        detail: {
          ...taskDetail,
          task: { ...taskDetail.task, id: "tsk_11111111111111111111111111" },
        },
      },
    }, detailRequest)).toThrow();

    const mutationRequest = parseRuntimeTaskDispatchRequest({
      version: runtimeProtocolVersion,
      operationId: "op_native0003",
      command: {
        type: "task.mutate",
        workspaceId,
        intent: renameCommand,
      },
    });
    expect(parseRuntimeTaskDispatchResponseForRequest({
      version: runtimeProtocolVersion,
      operationId: mutationRequest.operationId,
      ok: true,
      result: { type: "taskMutation", mutation: renameMutation },
    }, mutationRequest)).toMatchObject({
      ok: true,
      result: { type: "taskMutation" },
    });
    expect(() => parseRuntimeTaskDispatchResponseForRequest({
      version: runtimeProtocolVersion,
      operationId: mutationRequest.operationId,
      ok: true,
      result: {
        type: "taskMutation",
        mutation: {
          ...renameMutation,
          operationId: "op_11111111111111111111111111",
        },
      },
    }, mutationRequest)).toThrow();
  });

  test("rejects mutation results for the wrong durable target", () => {
    const wrongTaskId = "tsk_11111111111111111111111111";
    const runId = "run_target0001";
    const wrongRunId = "run_target0002";
    const interactionId = "interaction_target0001";
    const wrongInteractionId = "interaction_target0002";
    const submissionId = "sub_00000000000000000000000000";
    const wrongSubmissionId = "sub_11111111111111111111111111";
    const cases = [
      {
        command: {
          kind: "task.update",
          operationId: durableOperationId,
          expectedWorkspaceRevision: 7,
          taskId,
          expectedTaskRevision: 3,
          patch: { title: "A correlated title" },
        },
        result: {
          kind: "task_updated",
          taskId: wrongTaskId,
          taskRevision: 4,
        },
      },
      {
        command: {
          kind: "review.accept",
          operationId: durableOperationId,
          expectedWorkspaceRevision: 7,
          taskId,
          submissionId,
          expectedReviewRevision: 3,
        },
        result: {
          kind: "submission_updated",
          taskId,
          submissionId: wrongSubmissionId,
          taskRevision: 4,
        },
      },
      {
        command: {
          kind: "dispatch.stop",
          operationId: durableOperationId,
          expectedWorkspaceRevision: 7,
          runId,
        },
        result: {
          kind: "run_updated",
          runId: wrongRunId,
          phase: "cancel_requested",
        },
      },
      {
        command: {
          kind: "interaction.respond",
          operationId: durableOperationId,
          expectedWorkspaceRevision: 7,
          runId,
          interactionId,
          request: {
            id: interactionId,
            createdAt: 1,
            expiresAt: 2,
            kind: "file_change_approval",
            scope: "once",
          },
          response: {
            kind: "file_change_approval",
            decision: "approve_once",
          },
        },
        result: {
          kind: "interaction_updated",
          runId,
          interactionId: wrongInteractionId,
          state: "answered",
        },
      },
      {
        command: {
          kind: "dispatch.resolve_ambiguity",
          operationId: durableOperationId,
          expectedWorkspaceRevision: 7,
          taskId,
          expectedTaskRevision: 3,
          sourceRunId: runId,
          reason: "declared_failed",
        },
        result: {
          kind: "run_updated",
          runId,
          phase: "cancelled",
        },
      },
    ] as const;

    for (const [index, fixtureCase] of cases.entries()) {
      const request = parseRuntimeTaskDispatchRequest({
        version: runtimeProtocolVersion,
        operationId: `op_native_target${index}`,
        command: {
          type: "task.mutate",
          workspaceId,
          intent: fixtureCase.command,
        },
      });
      expect(() => parseRuntimeTaskDispatchResponseForRequest({
        version: runtimeProtocolVersion,
        operationId: request.operationId,
        ok: true,
        result: {
          type: "taskMutation",
          mutation: {
            operationId: durableOperationId,
            workspaceId,
            commandKind: fixtureCase.command.kind,
            workspaceRevision: 8,
            projectionRevision: 8,
            result: fixtureCase.result,
          },
        },
      }, request)).toThrow(/does not match its durable intent/u);
    }
  });

  test("has no renderer command for projects, sessions, turns, interactions, or raw protocols", () => {
    for (const command of [
      { type: "project.inspect", projectId: "proj_12345678" },
      { type: "project.register", path: "/fixture/example" },
      { type: "thread.list", accountProfileId: account.id },
      { type: "thread.resume", threadId: "thread_12345678" },
      { type: "thread.start", accountProfileId: account.id },
      { type: "turn.start", threadId: "thread_12345678", prompt: "secret" },
      { type: "turn.steer", threadId: "thread_12345678", prompt: "secret" },
      { type: "interaction.answer", interactionId: "hitl_12345678", answer: "secret" },
      { type: "protocol.call", method: "turn/start", params: {} },
    ]) {
      expect(() => parseRuntimeDispatchRequest({
        version: runtimeProtocolVersion,
        operationId: "op_12345678",
        command,
      })).toThrow();
      expect(() => parseRuntimeTaskDispatchRequest({
        version: runtimeProtocolVersion,
        operationId: "op_12345678",
        command,
      })).toThrow();
    }
  });

  test("normalizes only path-free project-onboarding outcomes", () => {
    expect(parseRuntimeProjectAddResult({ version: runtimeProtocolVersion, status: "cancelled" }))
      .toEqual({ version: runtimeProtocolVersion, status: "cancelled" });
    expect(parseRuntimeProjectAddResult({
      ok: true,
      value: { repository: { id: repositoryId, name: "example", createdAt: 1 }, workspace: workspaceSummary },
    })).toMatchObject({ status: "created", repository: { id: repositoryId } });
    expect(parseRuntimeProjectAddResult({
      ok: false,
      error: { code: "invalid_repository", message: "Select a Git repository." },
    })).toMatchObject({ status: "failed", error: { code: "invalid_repository" } });
    expect(() => parseRuntimeProjectAddResult({
      ok: true,
      value: {
        repository: { id: repositoryId, name: "example", createdAt: 1, path: "/private/example" },
        workspace: workspaceSummary,
      },
    })).toThrow();
  });

  test("keeps chat commands app-owned, strict, and prompt-free on responses", () => {
    const paneId = "pane_contract01";
    const turnId = "chatturn_contract01";
    for (const command of [
      {
        type: "chat.pane.create",
        paneId,
        repositoryId,
      },
      {
        type: "chat.pane.rename",
        paneId,
        expectedRevision: 1,
        title: "Renamed",
      },
      {
        type: "chat.pane.workspace.recover",
        paneId,
        expectedRevision: 2,
      },
      {
        type: "chat.pane.repository.select",
        paneId,
        expectedRevision: 3,
        repositoryId,
      },
      {
        type: "chat.pane.remove",
        paneId,
        expectedRevision: 3,
      },
      {
        type: "chat.message.enqueue",
        paneId,
        expectedQueueRevision: 1,
        messageId: "chatmsg_contractsend01",
        content: { text: "Explain the reducer.", attachmentRefs: [] as string[] },
        delivery: { kind: "queue" },
      },
      {
        type: "chat.turn.stop",
        paneId,
        expectedRevision: 4,
        turnId,
      },
    ] as const) {
      expect(parseRuntimeDispatchRequest({
        version: runtimeProtocolVersion,
        operationId: "op_chatcontract01",
        command,
      }).command).toEqual(command);
    }
    expect(() => parseRuntimeDispatchRequest({
      version: runtimeProtocolVersion,
      operationId: "op_chatcontract01",
      command: {
        type: "chat.pane.create",
        paneId,
        repositoryId,
        accountProfileId: null,
      },
    })).toThrow();
    expect(() => parseRuntimeDispatchRequest({
      version: runtimeProtocolVersion,
      operationId: "op_chatpreference01",
      command: {
        type: "chat.pane.create",
        paneId,
        repositoryId,
        reasoningEffort: "max",
      },
    })).toThrow();
    expect(() => parseRuntimeDispatchRequest({
      version: runtimeProtocolVersion,
      operationId: "op_chatcontract02",
      command: {
        type: "chat.pane.configure",
        paneId,
        expectedRevision: 2,
      },
    })).toThrow();
    for (const privateField of ["provider", "threadId", "turnId"] as const) {
      expect(() => parseRuntimeDispatchRequest({
        version: runtimeProtocolVersion,
        operationId: "op_chatretryprivate01",
        command: {
          type: "chat.message.enqueue",
          paneId,
          expectedQueueRevision: 1,
          messageId: "chatmsg_contractsend02",
          content: { text: "retry as a fresh message", attachmentRefs: [] },
          delivery: { kind: "queue" },
          [privateField]: "must remain gateway-private",
        },
      })).toThrow();
    }
    expect(parseRuntimeDispatchRequest({
      version: runtimeProtocolVersion,
      operationId: "op_chatprompt001",
      command: {
        type: "chat.message.enqueue",
        paneId,
        expectedQueueRevision: 1,
        messageId: "chatmsg_contractprompt1",
        content: {
          text: "x".repeat(runtimeChatMessageUtf8ByteLimit),
          attachmentRefs: [],
        },
        delivery: { kind: "queue" },
      },
    }).command.type).toBe("chat.message.enqueue");
    expect(() => parseRuntimeDispatchRequest({
      version: runtimeProtocolVersion,
      operationId: "op_chatprompt002",
      command: {
        type: "chat.message.enqueue",
        paneId,
        expectedQueueRevision: 1,
        messageId: "chatmsg_contractprompt2",
        content: {
          text: "x".repeat(runtimeChatMessageUtf8ByteLimit + 1),
          attachmentRefs: [],
        },
        delivery: { kind: "queue" },
      },
    })).toThrow();
    expect(() => parseRuntimeDispatchRequest({
      version: runtimeProtocolVersion,
      operationId: "op_chatcontract01",
      command: {
        type: "chat.message.enqueue",
        paneId,
        expectedQueueRevision: 1,
        messageId: "chatmsg_contractprompt3",
        content: { text: "", attachmentRefs: [] },
        delivery: { kind: "queue" },
      },
    })).toThrow();
    expect(() => parseRuntimeDispatchRequest({
      version: runtimeProtocolVersion,
      operationId: "op_chatcontract02",
      command: {
        type: "chat.message.enqueue",
        paneId,
        expectedQueueRevision: 1,
        messageId: "chatmsg_contractprompt4",
        content: { text: " \n\t ", attachmentRefs: [] },
        delivery: { kind: "queue" },
      },
    })).toThrow();
    expect(() => parseRuntimeDispatchRequest({
      version: runtimeProtocolVersion,
      operationId: "op_chatprompt003",
      command: {
        type: "chat.message.enqueue",
        paneId,
        expectedQueueRevision: 1,
        messageId: "chatmsg_contractprompt5",
        content: { text: "unsafe\0prompt", attachmentRefs: [] },
        delivery: { kind: "queue" },
      },
    })).toThrow();
    for (const rawCommand of [
      { type: "chat.turn.start", paneId, expectedRevision: 1, turnId, prompt: "raw" },
      {
        type: "chat.turn.retry",
        paneId,
        expectedRevision: 1,
        priorFailedTurnId: "chatturn_contractfailed01",
        turnId,
      },
    ]) {
      expect(() => parseRuntimeDispatchRequest({
        version: runtimeProtocolVersion,
        operationId: "op_chatrawdeny01",
        command: rawCommand,
      })).toThrow();
    }
    for (const title of [" Renamed", "Renamed ", "unsafe\0title"]) {
      expect(() => parseRuntimeDispatchRequest({
        version: runtimeProtocolVersion,
        operationId: "op_chattitle001",
        command: {
          type: "chat.pane.rename",
          paneId,
          expectedRevision: 1,
          title,
        },
      })).toThrow();
    }

    const automaticRoute = {
      policyVersion: 1,
      classificationReason: "boundedLeafCue",
      workClass: "boundedLeaf",
      requestedProfile: "lunaMax",
      selectedProfile: "solMax",
      profileFallbackReason: "lunaUnavailable",
      requestedServiceTier: "fast",
      selectedServiceTier: "standard",
      serviceTierFallbackReason: "fastUnavailable",
    } as const;
    const pane = {
      id: paneId,
      revision: 4,
      title: "Reducer",
      repository: { id: repositoryId, name: "example" },
      accountProfileId: account.id,
      interactionMode: "chat",
      state: "ready",
      activity: { ordinal: 4, kind: "responseCompleted" },
      workspace: {
        mode: "managedWorktree",
        state: "ready",
        revision: 1,
        recoveryKind: null,
      },
      turn: {
        id: turnId,
        status: "completed",
        startedAt: "2026-08-03T12:00:00.000Z",
        completedAt: "2026-08-03T12:01:00.000Z",
        continuationCount: 1,
        responseMarkdown: {
          tail: "Done.",
          totalUtf8Bytes: 5,
          truncatedPrefix: false,
        },
        reasoningSummary: {
          tail: "Checked.",
          totalUtf8Bytes: 8,
          truncatedPrefix: false,
        },
        tools: [{ id: "chattool_contract01", category: "filesystem", status: "completed" }],
        routing: automaticRoute,
      },
      attention: null,
      recoverablePrompt: false,
      messageQueue: { revision: 1, pauseReason: null, blockedMessage: null, messages: [] },
      harness: null,
    } as const;
    expect(parseRuntimeDispatchResponse({
      version: runtimeProtocolVersion,
      operationId: "op_chatcontract01",
      ok: true,
      result: { type: "chatPane", pane },
    })).toMatchObject({ result: { type: "chatPane", pane } });
    expect(() => chatPaneProjectionSchema.parse({
      ...pane,
      workspace: null,
    })).toThrow("chat panes require a workspace");
    expect(() => chatPaneProjectionSchema.parse({
      ...pane,
      interactionMode: "harnessObserver",
    })).toThrow("harness observers cannot own one");
    expect(chatPaneProjectionSchema.parse({
      ...pane,
      interactionMode: "harnessObserver",
      workspace: null,
      turn: { ...pane.turn, routing: null },
    }).workspace).toBeNull();
    expect(chatRootTurnRoutingProjectionSchema.parse(automaticRoute))
      .toEqual(automaticRoute);
    expect(() => chatRootTurnRoutingProjectionSchema.parse({
      ...automaticRoute,
      selectedProfile: "solUltra",
    })).toThrow("selected profile must be requested or the Luna fallback");
    expect(() => chatRootTurnRoutingProjectionSchema.parse({
      ...automaticRoute,
      selectedProfile: "solMax",
      profileFallbackReason: null,
    })).toThrow("fallback reason must exactly describe");
    expect(() => chatRootTurnRoutingProjectionSchema.parse({
      ...automaticRoute,
      selectedProfile: null,
      profileFallbackReason: null,
    })).toThrow("profile and tier must resolve together");
    expect(() => chatRootTurnRoutingProjectionSchema.parse({
      ...automaticRoute,
      classificationReason: "continuationInherited",
      requestedServiceTier: "standard",
      selectedServiceTier: "standard",
      serviceTierFallbackReason: null,
    })).toThrow("work class must map to an allowed requested tier");
    expect(() => chatRootTurnRoutingProjectionSchema.parse({
      ...automaticRoute,
      classificationReason: "continuationInherited",
      workClass: "largeChange",
      requestedProfile: "solUltra",
      requestedServiceTier: "fast",
      selectedProfile: "solUltra",
      selectedServiceTier: "fast",
      profileFallbackReason: null,
      serviceTierFallbackReason: null,
    })).toThrow("work class must map to an allowed requested tier");
    expect(() => chatPaneProjectionSchema.parse({
      ...pane,
      interactionMode: "harnessObserver",
      workspace: null,
      turn: { ...pane.turn, routing: automaticRoute },
    })).toThrow("harness observer turns forbid it");
    expect(() => chatPaneProjectionSchema.parse({
      ...pane,
      turn: { ...pane.turn, routing: null },
    })).toThrow("ordinary root turns require routing");
    const paneState = {
      id: pane.id,
      revision: pane.revision,
      title: pane.title,
      accountProfileId: pane.accountProfileId,
      interactionMode: pane.interactionMode,
      state: pane.state,
      activity: pane.activity,
      workspace: pane.workspace,
      turn: null,
      attention: null,
    } as const;
    expect(() => chatPaneStateProjectionSchema.parse({
      ...paneState,
      workspace: null,
    })).toThrow("chat panes require a workspace");
    expect(() => chatPaneStateProjectionSchema.parse({
      ...paneState,
      interactionMode: "harnessObserver",
    })).toThrow("harness observers cannot own one");
    const unboundedFractionalTimestamp =
      `2026-08-03T12:00:00.${"0".repeat(4_000)}Z`;
    expect(() => parseRuntimeDispatchResponse({
      version: runtimeProtocolVersion,
      operationId: "op_chatcontract01",
      ok: true,
      result: {
        type: "chatPane",
        pane: {
          ...pane,
          turn: { ...pane.turn, startedAt: unboundedFractionalTimestamp },
        },
      },
    })).toThrow("chat timestamp must use canonical");
    expect(() => parseRuntimeDispatchResponse({
      version: runtimeProtocolVersion,
      operationId: "op_chatcontract01",
      ok: true,
      result: { type: "chatPane", pane, prompt: "must not echo" },
    })).toThrow();

    const chatSnapshot = { ...snapshot, chat: { revision: 7, panes: [pane] } };
    expect(JSON.stringify(parseRuntimeSnapshotResponse({
      version: runtimeProtocolVersion,
      snapshot: chatSnapshot,
    }).snapshot)).toBe(JSON.stringify(chatSnapshot));
    expect(() => parseRuntimeSnapshotResponse({
      version: runtimeProtocolVersion,
      snapshot: {
        ...chatSnapshot,
        chat: {
          ...chatSnapshot.chat,
          panes: [{ ...pane, providerThreadId: "thread_private", path: "/private/example" }],
        },
      },
    })).toThrow();
  });

  test("correlates chat results with the exact pane, revision, and turn request", () => {
    const paneId = "pane_correlation01";
    const turnId = "chatturn_correlation01";
    const operationId = "op_chatcorrelation01";
    const automaticRoute = {
      policyVersion: 1,
      classificationReason: "boundedLeafCue",
      workClass: "boundedLeaf",
      requestedProfile: "lunaMax",
      selectedProfile: "lunaMax",
      profileFallbackReason: null,
      requestedServiceTier: "fast",
      selectedServiceTier: "fast",
      serviceTierFallbackReason: null,
    } as const;
    const basePane = {
      id: paneId,
      revision: 1,
      title: "New chat",
      repository: { id: repositoryId, name: "example" },
      accountProfileId: account.id,
      interactionMode: "chat",
      state: "ready",
      activity: { ordinal: 0, kind: "idle" },
      workspace: {
        mode: "managedWorktree",
        state: "preparing",
        revision: 1,
        recoveryKind: null,
      },
      turn: null,
      attention: null,
      recoverablePrompt: false,
      messageQueue: { revision: 1, pauseReason: null, blockedMessage: null, messages: [] },
      harness: null,
    } as const;
    const createRequest = {
      version: runtimeProtocolVersion,
      operationId,
      command: {
        type: "chat.pane.create",
        paneId,
        repositoryId,
      },
    } satisfies RuntimeChatDispatchRequest;
    const response = (pane: unknown) => ({
      version: runtimeProtocolVersion,
      operationId,
      ok: true,
      result: { type: "chatPane", pane },
    });
    expect(parseRuntimeChatDispatchResponseForRequest(
      response(basePane),
      createRequest,
    )).toMatchObject({ result: { type: "chatPane", pane: { id: paneId } } });
    for (const pane of [
      { ...basePane, id: "pane_correlation02" },
      { ...basePane, revision: 2 },
      { ...basePane, repository: { ...basePane.repository, id: "repo_11111111111111111111111111" } },
      { ...basePane, turn: {
        id: turnId,
        status: "completed",
        startedAt: "2026-08-03T12:00:00.000Z",
        completedAt: "2026-08-03T12:00:01.000Z",
        continuationCount: 0,
        responseMarkdown: { tail: "", totalUtf8Bytes: 0, truncatedPrefix: false },
        reasoningSummary: { tail: "", totalUtf8Bytes: 0, truncatedPrefix: false },
        tools: [],
        routing: automaticRoute,
      } },
    ]) {
      expect(() => parseRuntimeChatDispatchResponseForRequest(
        response(pane),
        createRequest,
      )).toThrow("pane creation response does not match");
    }

    const renameRequest = {
      ...createRequest,
      command: {
        type: "chat.pane.rename",
        paneId,
        expectedRevision: 1,
        title: "Renamed",
      },
    } satisfies RuntimeChatDispatchRequest;
    const renamed = { ...basePane, revision: 2, title: "Renamed" };
    expect(parseRuntimeChatDispatchResponseForRequest(
      response(renamed),
      renameRequest,
    )).toMatchObject({ result: { type: "chatPane" } });
    expect(() => parseRuntimeChatDispatchResponseForRequest(
      response({ ...renamed, revision: 3 }),
      renameRequest,
    )).toThrow("pane rename response does not match");

    const recoverRequest = {
      ...createRequest,
      command: {
        type: "chat.pane.workspace.recover",
        paneId,
        expectedRevision: 2,
      },
    } satisfies RuntimeChatDispatchRequest;
    const recovered = {
      ...basePane,
      revision: 3,
      accountProfileId: null,
    } as const;
    expect(parseRuntimeChatDispatchResponseForRequest(
      response(recovered),
      recoverRequest,
    )).toMatchObject({ result: { type: "chatPane" } });
    expect(() => parseRuntimeChatDispatchResponseForRequest(
      response({ ...recovered, revision: 4 }),
      recoverRequest,
    )).toThrow("workspace recovery response does not match");

    const selectedRepositoryId = "repo_11111111111111111111111111";
    const repositoryRequest = {
      ...createRequest,
      command: {
        type: "chat.pane.repository.select",
        paneId,
        expectedRevision: 1,
        repositoryId: selectedRepositoryId,
      },
    } satisfies RuntimeChatDispatchRequest;
    const repositorySelected = {
      ...basePane,
      revision: 2,
      repository: { id: selectedRepositoryId, name: "other" },
    } as const;
    expect(parseRuntimeChatDispatchResponseForRequest(
      response(repositorySelected),
      repositoryRequest,
    )).toMatchObject({ result: { type: "chatPane" } });
    expect(() => parseRuntimeChatDispatchResponseForRequest(
      response({ ...repositorySelected, repository: basePane.repository }),
      repositoryRequest,
    )).toThrow("repository selection response does not match");

    const removeRequest = {
      ...createRequest,
      command: { type: "chat.pane.remove", paneId, expectedRevision: 3 },
    } satisfies RuntimeChatDispatchRequest;
    expect(parseRuntimeChatDispatchResponseForRequest({
      version: runtimeProtocolVersion,
      operationId,
      ok: true,
      result: { type: "chatPaneRemoved", paneId },
    }, removeRequest)).toMatchObject({ result: { type: "chatPaneRemoved", paneId } });
    expect(() => parseRuntimeChatDispatchResponseForRequest({
      version: runtimeProtocolVersion,
      operationId,
      ok: true,
      result: { type: "chatPaneRemoved", paneId: "pane_correlation02" },
    }, removeRequest)).toThrow("pane removal response does not match");

    const started = {
      ...basePane,
      revision: 4,
      state: "starting",
      activity: { ordinal: 1, kind: "messageSent" },
      turn: {
        id: turnId,
        status: "starting",
        startedAt: "2026-08-03T12:00:00.000Z",
        completedAt: null,
        continuationCount: 0,
        responseMarkdown: { tail: "", totalUtf8Bytes: 0, truncatedPrefix: false },
        reasoningSummary: { tail: "", totalUtf8Bytes: 0, truncatedPrefix: false },
        tools: [],
        routing: automaticRoute,
      },
    } as const;

    const queueRequest = {
      ...createRequest,
      command: {
        type: "chat.message.enqueue",
        paneId,
        expectedQueueRevision: 1,
        messageId: "chatmsg_correlation01",
        content: { text: "Start", attachmentRefs: [] },
        delivery: { kind: "queue" },
      },
    } satisfies RuntimeChatDispatchRequest;
    const queueResponse = (revision: number, responsePaneId = paneId) => ({
      version: runtimeProtocolVersion,
      operationId,
      ok: true as const,
      result: {
        type: "chatMessageQueue" as const,
        paneId: responsePaneId,
        queue: {
          revision,
          pauseReason: null,
          blockedMessage: null,
          messages: [],
        },
      },
    });
    expect(parseRuntimeChatDispatchResponseForRequest(
      queueResponse(2),
      queueRequest,
    )).toMatchObject({ result: { type: "chatMessageQueue", paneId } });
    expect(() => parseRuntimeChatDispatchResponseForRequest(
      queueResponse(1),
      queueRequest,
    )).toThrow("message queue mutation response does not match");
    expect(() => parseRuntimeChatDispatchResponseForRequest(
      queueResponse(2, "pane_correlation02"),
      queueRequest,
    )).toThrow("message queue mutation response does not match");

    const stopRequest = {
      ...createRequest,
      command: {
        type: "chat.turn.stop",
        paneId,
        expectedRevision: 4,
        turnId,
      },
    } satisfies RuntimeChatDispatchRequest;
    const stopped = {
      ...started,
      revision: 7,
      state: "attention",
      turn: {
        ...started.turn,
        status: "failed",
        completedAt: "2026-08-03T12:00:01.000Z",
      },
      attention: {
        code: "turn_failed",
        message: "You stopped this turn. You can send another message.",
        retryable: true,
      },
      recoverablePrompt: true,
    } as const;
    expect(parseRuntimeChatDispatchResponseForRequest(
      response(stopped),
      stopRequest,
    )).toMatchObject({ result: { type: "chatPane", pane: { revision: 7 } } });
    const completedBeforeStopReturned = {
      ...stopped,
      state: "ready",
      turn: {
        ...stopped.turn,
        status: "completed",
      },
      attention: null,
      recoverablePrompt: false,
    } as const;
    expect(parseRuntimeChatDispatchResponseForRequest(
      response(completedBeforeStopReturned),
      stopRequest,
    )).toMatchObject({ result: { type: "chatPane", pane: { state: "ready" } } });
    for (const pane of [
      { ...stopped, id: "pane_correlation02" },
      { ...stopped, revision: 4 },
      { ...stopped, state: "streaming", attention: null },
      { ...stopped, turn: { ...stopped.turn, id: "chatturn_correlation02" } },
      { ...stopped, interactionMode: "harnessObserver", workspace: null },
      { ...stopped, attention: { ...stopped.attention, retryable: false } },
    ]) {
      expect(() => parseRuntimeChatDispatchResponseForRequest(
        response(pane),
        stopRequest,
      )).toThrow();
    }

    expect(() => parseRuntimeChatDispatchResponseForRequest(
      { ...queueResponse(2), operationId: "op_chatcorrelation02" },
      queueRequest,
    )).toThrow(`Expected native operation ${operationId}`);
  });

  test("strictly limits the renderer snapshot to readiness and account lifecycle state", () => {
    expect(JSON.stringify(parseRuntimeSnapshotResponse({
      version: runtimeProtocolVersion,
      snapshot,
    }).snapshot)).toBe(JSON.stringify(snapshot));

    const signedInHumanAccount = {
      state: "signedIn",
      revision: 4,
      profile: {
        user: {
          id: "user_LOCAL",
          email: "builder@example.test",
          name: null,
        },
        organization: {
          id: "organization-id",
          name: "Example",
          role: "owner",
          status: "active",
          workosOrganizationId: "org_LOCAL",
        },
        workspace: null,
      },
    } as const;
    expect(parseRuntimeSnapshotResponse({
      version: runtimeProtocolVersion,
      snapshot: {
        ...snapshot,
        humanAccount: signedInHumanAccount,
      },
    }).snapshot.humanAccount).toEqual(signedInHumanAccount);

    const recoveryRequired = {
      state: "recoveryRequired",
      revision: 5,
      reason: "legacyCredentialAccessDenied",
    } as const;
    expect(parseRuntimeSnapshotResponse({
      version: runtimeProtocolVersion,
      snapshot: { ...snapshot, humanAccount: recoveryRequired },
    }).snapshot.humanAccount).toEqual(recoveryRequired);
    expect(() => parseRuntimeSnapshotResponse({
      version: runtimeProtocolVersion,
      snapshot: {
        ...snapshot,
        humanAccount: {
          ...recoveryRequired,
          service: "kitchen.hraness.cloud-human.v1",
          slot: "legacy_opaque_slot",
        },
      },
    })).toThrow();

    for (const humanAccount of [
      {
        ...signedInHumanAccount,
        accessToken: "secret-access-token",
      },
      {
        ...signedInHumanAccount,
        profile: {
          ...signedInHumanAccount.profile,
          apiUrl: "https://api.example.test",
        },
      },
      {
        state: "signingIn",
        revision: 5,
        userCode: "FERN-MOSS",
        expiresAt: 1_800_000_000_000,
        verificationUri: "https://auth.example.test/device",
      },
    ]) {
      expect(() => parseRuntimeSnapshotResponse({
        version: runtimeProtocolVersion,
        snapshot: { ...snapshot, humanAccount },
      })).toThrow();
    }

    for (const [key, value] of [
      ["projects", []],
      ["workspaceLanes", []],
      ["threads", []],
      ["items", []],
      ["interactions", []],
      ["compatibilityFaults", []],
      ["taskListPage", taskListPage],
      ["taskDetail", taskDetail],
      ["commands", ["rm -rf /fixture"]],
      ["paths", ["/private/worktree"]],
    ] as const) {
      expect(() => parseRuntimeSnapshotResponse({
        version: runtimeProtocolVersion,
        snapshot: { ...snapshot, [key]: value },
      })).toThrow();
    }

    for (const privateField of ["usage", "models"] as const) {
      expect(() => parseRuntimeSnapshotResponse({
        version: runtimeProtocolVersion,
        snapshot: {
          ...snapshot,
          accounts: [{ ...account, [privateField]: { state: "unavailable" } }],
        },
      })).toThrow();
    }
  });

  test("rejects every gateway-internal event family", () => {
    for (const event of [
      { type: "project.upserted", project: {} },
      { type: "workspace.upserted", workspaceLane: {} },
      { type: "thread.upserted", thread: {} },
      { type: "item.delta", delta: "provider output" },
      { type: "item.upserted", item: {} },
      { type: "interaction.upserted", interaction: {} },
      { type: "compatibility.faulted", fault: {} },
    ]) {
      expect(() => parseRuntimeEvent({
        version: runtimeProtocolVersion,
        sequence: 1,
        event,
      })).toThrow();
    }
  });

  test("carries only scoped task invalidations on the native event sequence", () => {
    const parsed = parseRuntimeEvent({
      version: runtimeProtocolVersion,
      sequence: 18,
      event: {
        type: "task.invalidated",
        invalidation: {
          workspaceId,
          projectionRevision: 9,
          scope: "task_detail",
          taskId,
        },
      },
    });
    expect(parsed).toMatchObject({
      sequence: 18,
      event: {
        type: "task.invalidated",
        invalidation: { projectionRevision: 9 },
      },
    });
    expect(() => parseRuntimeEvent({
      version: runtimeProtocolVersion,
      sequence: 18,
      event: {
        type: "task.invalidated",
        invalidation: {
          workspaceId: "convex-row-id",
          projectionRevision: 9,
          scope: "task_detail",
          taskId,
        },
      },
    })).toThrow();
  });

  test("strictly parses bounded snapshot chunks", () => {
    expect(parseRuntimeSnapshotTransportResponse({
      version: runtimeProtocolVersion,
      transferId: "snapshot_12345678",
      index: 0,
      count: 2,
      base64: "8J+MjQ==",
    })).toMatchObject({ index: 0, count: 2 });
    expect(() => parseRuntimeSnapshotTransportResponse({
      version: runtimeProtocolVersion,
      transferId: "snapshot_12345678",
      index: 0,
      count: 1,
      base64: "A".repeat(runtimeSnapshotChunkBase64Limit + 1),
    })).toThrow();
    expect(() => parseRuntimeSnapshotTransportResponse({
      version: runtimeProtocolVersion,
      transferId: "snapshot_12345678",
      index: 0,
      count: runtimeSnapshotChunkCountLimit + 1,
      base64: "YQ==",
    })).toThrow();
  });

  test("keeps every immutable dispatch-response chunk below one MiB", () => {
    const bytes = Buffer.alloc(runtimeDispatchChunkByteLimit, 0x61);
    const chunk = parseRuntimeDispatchTransportResponse({
      version: runtimeProtocolVersion,
      operationId: "op_native0001",
      transferId: "response_12345678",
      index: 0,
      count: 2,
      base64: bytes.toString("base64"),
    });
    const hostLine = JSON.stringify({
      id: "x".repeat(64),
      ok: true,
      result: chunk,
    });
    expect(Buffer.byteLength(hostLine)).toBeLessThan(1024 * 1024);
    expect(parseRuntimeDispatchTransportRequest({
      version: runtimeProtocolVersion,
      operationId: "op_native0001",
      transferId: "response_12345678",
      index: 1,
    })).toMatchObject({ index: 1 });
  });

  test("keeps account responses and semantic runner events exhaustively discriminated", () => {
    expect(parseRuntimeDispatchResponse({
      version: runtimeProtocolVersion,
      operationId: "op_12345678",
      ok: true,
      result: { type: "account", account },
    })).toMatchObject({ ok: true, result: { type: "account" } });
    expect(parseRuntimeEvent({
      version: runtimeProtocolVersion,
      sequence: 1,
      event: { type: "runner.changed", runner: { state: "connected" } },
    }).event.type).toBe("runner.changed");
    expect(parseRuntimeEvent({
      version: runtimeProtocolVersion,
      sequence: 1,
      event: { type: "runner.changed", runner: { state: "recovering" } },
    }).event).toEqual({
      type: "runner.changed",
      runner: { state: "recovering" },
    });
  });
});
