import { describe, expect, test } from "bun:test";
import { assertAsyncProperty, fc } from "@hra-internal/test";

import type { AccountRuntimeRouter } from "../src/accounts/runtime-router";
import {
  parsePinnedCodexDynamicToolCall,
  parsePinnedCodexDynamicToolResponse,
  type PinnedCodexDynamicToolArguments,
  type PinnedCodexDynamicToolRequest,
  type PinnedCodexDynamicToolResponse,
  type PinnedCodexJsonValue,
} from "../src/codex/dynamic-tool";
import {
  HARNESS_DYNAMIC_TOOL_FAILURE_MESSAGES,
  HarnessDynamicToolServiceV2,
  type HarnessDynamicToolProgramAdmissionCompletionPortV2,
  type HarnessDynamicToolStableAdmission,
  type HarnessDynamicToolStableCallerPort,
} from "../src/harness/dynamic-tool-service-v2";
import {
  RlmRuntimeV2Error,
  type RlmRuntimeAdmission,
  type RlmRuntimeResult,
  type RlmRuntimeRunHandle,
} from "../src/harness/rlm-runtime-v2";

const runId = "rlmrun_service_stable001";
const deadline = "2099-01-01T00:00:00.000Z";
const digestA = "a".repeat(64);
const digestB = "b".repeat(64);
const providerAccount = "acct_provider-private";
const providerThread = "provider-thread-private";
const providerTurn = "provider-turn-private";

const program = {
  version: 2,
  capabilities: [],
  steps: [],
  result: { kind: "literal", value: { answer: 42 } },
} satisfies PinnedCodexJsonValue;

const stableAdmission: HarnessDynamicToolStableAdmission = {
  runId,
  epochId: "hepoch_service_stable001",
  actorId: "hactor_service_stable001",
  turnId: "hturn_service_stable0001",
  completedPrefixSnapshotId: "ctxsnap_service_stable001",
  currentUserInputValueId: null,
  releaseIdentityDigest: digestB,
  caller: {
    epochId: "hepoch_service_stable001",
    actorId: "hactor_service_stable001",
    turnId: "hturn_service_stable0001",
    capabilities: [],
    admittedFeatures: ["boundedPrograms"],
    semanticWitnessDigests: [digestA],
    budget: {
      depthRemaining: 3,
      activeDescendantLimit: 8,
      durableDescendantLimit: 50,
      tokenBudget: 50_000,
      deadline,
      heapByteLimit: 16 * 1024 * 1024,
      contextValueByteLimit: 1024 * 1024,
      messageByteLimit: 128 * 1024,
      laneAuthority: "readOnly",
    },
  },
};

function runtimeHandle(
  state: RlmRuntimeRunHandle["state"] = "prepared",
  desiredState: RlmRuntimeRunHandle["desiredState"] = "run",
): RlmRuntimeRunHandle {
  return { runId, state, desiredState, revision: 1 };
}

function runtimeHandleFor(
  runIdValue: string,
  state: RlmRuntimeRunHandle["state"] = "prepared",
  desiredState: RlmRuntimeRunHandle["desiredState"] = "run",
): RlmRuntimeRunHandle {
  return { runId: runIdValue, state, desiredState, revision: 1 };
}

class RecordingRuntime {
  readonly admissions: RlmRuntimeAdmission[] = [];
  readonly statusCalls: string[] = [];
  readonly waitCalls: Readonly<{ runId: string; timeoutMs: number }>[] = [];
  readonly resultCalls: string[] = [];
  readonly cancelCalls: string[] = [];
  admitState: RlmRuntimeRunHandle["state"] = "prepared";
  admitRunIdOverride: string | null = null;
  statusValue: RlmRuntimeRunHandle = runtimeHandle("running");
  waitValue: RlmRuntimeRunHandle = runtimeHandle("completed");
  resultValue: RlmRuntimeResult = { state: "completed", value: { answer: 42 } };
  cancelValue: RlmRuntimeRunHandle = runtimeHandle("stopped", "stop");
  waitImplementation: (
    runIdValue: string,
    timeoutMs: number,
    signal: AbortSignal,
  ) => Promise<RlmRuntimeRunHandle> = () => Promise.resolve(this.waitValue);

  admit(input: unknown): Promise<RlmRuntimeRunHandle> {
    const admission = input as RlmRuntimeAdmission;
    this.admissions.push(admission);
    return Promise.resolve(runtimeHandleFor(
      this.admitRunIdOverride ?? admission.runId,
      this.admitState,
    ));
  }

  status(runIdValue: string): Promise<RlmRuntimeRunHandle> {
    this.statusCalls.push(runIdValue);
    return Promise.resolve(this.statusValue);
  }

  wait(
    runIdValue: string,
    timeoutMs: number,
    signal = new AbortController().signal,
  ): Promise<RlmRuntimeRunHandle> {
    this.waitCalls.push({ runId: runIdValue, timeoutMs });
    return this.waitImplementation(runIdValue, timeoutMs, signal);
  }

  result(runIdValue: string): Promise<RlmRuntimeResult> {
    this.resultCalls.push(runIdValue);
    return Promise.resolve(this.resultValue);
  }

  cancel(runIdValue: string): Promise<RlmRuntimeRunHandle> {
    this.cancelCalls.push(runIdValue);
    return Promise.resolve(this.cancelValue);
  }
}

class RecordingCallers implements HarnessDynamicToolStableCallerPort {
  readonly admissions: Parameters<HarnessDynamicToolStableCallerPort["admit"]>[0][] = [];
  readonly ownershipChecks:
    Parameters<HarnessDynamicToolStableCallerPort["ownsRun"]>[0][] = [];
  admission: HarnessDynamicToolStableAdmission | null = stableAdmission;
  admissionImplementation: ((input: Parameters<
    HarnessDynamicToolStableCallerPort["admit"]
  >[0]) => HarnessDynamicToolStableAdmission | null) | null = null;
  owned = true;

  admit(input: Parameters<HarnessDynamicToolStableCallerPort["admit"]>[0]) {
    this.admissions.push(input);
    return Promise.resolve(this.admissionImplementation === null
      ? this.admission
      : this.admissionImplementation(input));
  }

  ownsRun(input: Parameters<HarnessDynamicToolStableCallerPort["ownsRun"]>[0]) {
    this.ownershipChecks.push(input);
    return Promise.resolve(this.owned);
  }
}

class RecordingAdmissions implements
  HarnessDynamicToolProgramAdmissionCompletionPortV2 {
  readonly completions: string[] = [];
  fail = false;

  completeAdmission(runIdValue: string): Promise<unknown> {
    this.completions.push(runIdValue);
    return this.fail
      ? Promise.reject(new Error("admission completion unavailable"))
      : Promise.resolve({ runId: runIdValue, state: "admitted" });
  }
}

type RespondArguments = Parameters<AccountRuntimeRouter["respond"]>;
type FenceArguments = Parameters<AccountRuntimeRouter["fenceGeneration"]>;

class RecordingRouter {
  readonly responses: RespondArguments[] = [];
  readonly fences: FenceArguments[] = [];
  attempts = 0;
  fail = false;
  fenceImplementation: ((argumentsValue: FenceArguments) => Promise<
    "already_fenced" | "fenced"
  >) | null = null;
  implementation: ((argumentsValue: RespondArguments) => Promise<void>) | null = null;

  respond(...argumentsValue: RespondArguments): Promise<void> {
    this.attempts += 1;
    this.responses.push(argumentsValue);
    if (this.implementation !== null) return this.implementation(argumentsValue);
    return this.fail
      ? Promise.reject(new Error("private response transport detail"))
      : Promise.resolve();
  }

  fenceGeneration(...argumentsValue: FenceArguments): Promise<
    "already_fenced" | "fenced"
  > {
    this.fences.push(argumentsValue);
    return this.fenceImplementation?.(argumentsValue) ?? Promise.resolve("fenced");
  }
}

function fixture(options: Readonly<{
  open?: boolean;
  responseWriteTimeoutMs?: number;
}> = {}) {
  const admissions = new RecordingAdmissions();
  const callers = new RecordingCallers();
  const router = new RecordingRouter();
  const runtime = new RecordingRuntime();
  const service = new HarnessDynamicToolServiceV2({
    admissions,
    callers,
    router,
    runtime,
    ...(options.responseWriteTimeoutMs === undefined
      ? {}
      : { responseWriteTimeoutMs: options.responseWriteTimeoutMs }),
  });
  if (options.open !== false) service.openAdmissionAfterRecovery();
  return { admissions, callers, router, runtime, service };
}

function dynamicRequest(
  argumentsValue: PinnedCodexDynamicToolArguments = {
    schemaVersion: 1,
    action: "submit",
    program,
  },
  input: Readonly<{
    callId?: string;
    accountProfileId?: string;
    generation?: number;
    id?: string | number;
    requestInstanceId?: number;
  }> = {},
): PinnedCodexDynamicToolRequest {
  const call = parsePinnedCodexDynamicToolCall({
    threadId: providerThread,
    turnId: providerTurn,
    callId: input.callId ?? "provider-call-private-1",
    namespace: "oprte",
    tool: "rlm_run",
    arguments: argumentsValue,
  });
  if (call === null) throw new Error("dynamic-tool test call is invalid");
  return Object.freeze({
    method: "item/tool/call",
    params: call,
    generation: input.generation ?? 7,
    id: input.id ?? "provider-request-private-1",
    requestInstanceId: input.requestInstanceId ?? 1,
    streamPosition: input.requestInstanceId ?? 1,
    accountProfileId: input.accountProfileId ?? providerAccount,
    accountGeneration: input.generation ?? 7,
  });
}

function inspectionRequest(
  action: "status" | "wait" | "result" | "cancel",
  requestInstanceId: number,
  timeoutMs = 25,
): PinnedCodexDynamicToolRequest {
  return dynamicRequest(
    action === "wait"
      ? { schemaVersion: 1, action, runId, timeoutMs }
      : { schemaVersion: 1, action, runId },
    {
      callId: `provider-call-${action}-${requestInstanceId}`,
      id: `provider-request-${action}-${requestInstanceId}`,
      requestInstanceId,
    },
  );
}

function routedResponse(router: RecordingRouter, index = 0): PinnedCodexDynamicToolResponse {
  const envelope = router.responses[index]?.[2];
  if (envelope?.type !== "result") throw new Error("missing dynamic-tool result response");
  const parsed = parsePinnedCodexDynamicToolResponse(envelope.result);
  if (parsed === null) throw new Error("routed response was not bounded");
  return parsed;
}

function responseValue(response: PinnedCodexDynamicToolResponse): Record<string, unknown> {
  const item = response.contentItems[0];
  if (item === undefined) throw new Error("dynamic-tool response text was absent");
  return JSON.parse(item.text) as Record<string, unknown>;
}

function responseText(response: PinnedCodexDynamicToolResponse): string {
  return response.contentItems[0]?.text ?? "";
}

describe("RLM v2 dynamic-tool service", () => {
  test("routes bounded recovery responses without consulting caller or runtime authority", async () => {
    const value = fixture({ open: false });
    const requests = [
      dynamicRequest(),
      inspectionRequest("status", 2),
      inspectionRequest("wait", 3),
      inspectionRequest("result", 4),
      inspectionRequest("cancel", 5),
    ];

    for (const request of requests) {
      expect(await value.service.handle(request)).toEqual({
        delivery: "responded",
      });
    }

    expect(value.router.attempts).toBe(5);
    expect(value.router.responses.map((_, index) =>
      responseText(routedResponse(value.router, index))
    )).toEqual(Array.from(
      { length: 5 },
      () => HARNESS_DYNAMIC_TOOL_FAILURE_MESSAGES.serviceRecovering,
    ));
    expect(value.callers.admissions).toEqual([]);
    expect(value.callers.ownershipChecks).toEqual([]);
    expect(value.runtime.admissions).toEqual([]);
    expect(value.runtime.statusCalls).toEqual([]);
    expect(value.runtime.waitCalls).toEqual([]);
    expect(value.runtime.resultCalls).toEqual([]);
    expect(value.runtime.cancelCalls).toEqual([]);
  });

  test("opens once after recovery and never reopens after an early shutdown", async () => {
    const recovered = fixture({ open: false });
    recovered.service.openAdmissionAfterRecovery();
    recovered.service.openAdmissionAfterRecovery();
    await recovered.service.handle(dynamicRequest());
    expect(responseValue(routedResponse(recovered.router))).toEqual({
      runId,
      state: "accepted",
    });
    expect(recovered.runtime.admissions).toHaveLength(1);

    const stoppedDuringRecovery = fixture({ open: false });
    stoppedDuringRecovery.service.closeAdmission();
    stoppedDuringRecovery.service.openAdmissionAfterRecovery();
    await stoppedDuringRecovery.service.handle(dynamicRequest());
    expect(responseText(routedResponse(stoppedDuringRecovery.router))).toBe(
      HARNESS_DYNAMIC_TOOL_FAILURE_MESSAGES.serviceQuiesced,
    );
    expect(stoppedDuringRecovery.callers.admissions).toEqual([]);
    expect(stoppedDuringRecovery.runtime.admissions).toEqual([]);
  });

  test("bridges submit and every owned inspection without provider identity leakage", async () => {
    const value = fixture();
    const requests = [
      dynamicRequest(),
      inspectionRequest("status", 2),
      inspectionRequest("wait", 3),
      inspectionRequest("result", 4),
      inspectionRequest("cancel", 5),
    ];

    for (const request of requests) {
      expect(await value.service.handle(request)).toEqual({ delivery: "responded" });
    }

    expect(responseValue(routedResponse(value.router, 0))).toEqual({
      runId,
      state: "accepted",
    });
    expect(responseValue(routedResponse(value.router, 1))).toMatchObject({
      runId,
      state: "running",
      desiredState: "run",
    });
    expect(responseValue(routedResponse(value.router, 2))).toMatchObject({
      runId,
      state: "completed",
    });
    expect(responseValue(routedResponse(value.router, 3))).toEqual({
      runId,
      state: "completed",
      value: { answer: 42 },
    });
    expect(responseValue(routedResponse(value.router, 4))).toMatchObject({
      runId,
      state: "stopped",
      desiredState: "stop",
    });

    expect(value.callers.ownershipChecks).toHaveLength(4);
    expect(value.runtime.statusCalls).toEqual([runId]);
    expect(value.runtime.waitCalls).toEqual([{ runId, timeoutMs: 25 }]);
    expect(value.runtime.resultCalls).toEqual([runId]);
    expect(value.runtime.cancelCalls).toEqual([runId]);
    expect(value.runtime.admissions).toHaveLength(1);
    expect(value.admissions.completions).toEqual([runId]);
    expect(value.runtime.admissions[0]).toMatchObject({
      runId,
      fuelLimit: 1_024,
      caller: {
        epochId: stableAdmission.epochId,
        actorId: stableAdmission.actorId,
        turnId: stableAdmission.turnId,
      },
    });
    const durable = JSON.stringify(value.runtime.admissions);
    const output = JSON.stringify(value.router.responses.map((entry) => entry[2]));
    for (const privateIdentity of [
      providerAccount,
      providerThread,
      providerTurn,
      "provider-call-private-1",
      "provider-request-private-1",
      "/Users/private/project",
    ]) {
      expect(durable).not.toContain(privateIdentity);
      expect(output).not.toContain(privateIdentity);
    }
  });

  test("reparses the exact call digest and rejects structural additions", async () => {
    const value = fixture();
    const exact = dynamicRequest();
    const wrongDigest = Object.freeze({
      ...exact,
      params: Object.freeze({ ...exact.params, argumentsSha256: digestB }),
    });
    const extraField = Object.freeze({
      ...dynamicRequest(undefined, { id: 2, requestInstanceId: 2 }),
      params: Object.freeze({
        ...dynamicRequest(undefined, { id: 2, requestInstanceId: 2 }).params,
        providerPath: "/Users/private/project",
      }),
    }) as unknown as PinnedCodexDynamicToolRequest;

    await value.service.handle(wrongDigest);
    await value.service.handle(extraField);

    expect(value.callers.admissions).toHaveLength(0);
    expect(value.runtime.admissions).toHaveLength(0);
    expect(responseText(routedResponse(value.router, 0))).toBe(
      HARNESS_DYNAMIC_TOOL_FAILURE_MESSAGES.invalidRequest,
    );
    expect(responseText(routedResponse(value.router, 1))).toBe(
      HARNESS_DYNAMIC_TOOL_FAILURE_MESSAGES.invalidRequest,
    );
  });

  test("admits duplicate submissions deterministically and routes each request once", async () => {
    const value = fixture();
    const first = dynamicRequest(undefined, {
      callId: "provider-call-duplicate-a",
      id: "provider-request-duplicate-a",
      requestInstanceId: 10,
    });
    const duplicate = dynamicRequest(undefined, {
      callId: "provider-call-duplicate-b",
      id: "provider-request-duplicate-b",
      requestInstanceId: 11,
    });
    const exactClone = Object.freeze({
      ...first,
      params: Object.freeze({ ...first.params }),
    });

    const [firstSettlement, repeatedSettlement, clonedSettlement,
      duplicateSettlement] = await Promise.all([
      value.service.handle(first),
      value.service.handle(first),
      value.service.handle(exactClone),
      value.service.handle(duplicate),
    ]);

    expect(firstSettlement).toEqual({ delivery: "responded" });
    expect(repeatedSettlement).toBe(firstSettlement);
    expect(clonedSettlement).toBe(firstSettlement);
    expect(duplicateSettlement).toEqual({ delivery: "responded" });
    expect(value.callers.admissions).toHaveLength(2);
    expect(value.runtime.admissions.map((entry) => entry.runId)).toEqual([runId, runId]);
    expect(value.admissions.completions).toEqual([runId, runId]);
    expect(value.router.attempts).toBe(2);
    expect(responseValue(routedResponse(value.router, 0))).toEqual({
      runId,
      state: "accepted",
    });
    expect(responseValue(routedResponse(value.router, 1))).toEqual({
      runId,
      state: "accepted",
    });
    expect(await value.service.quiesce()).toMatchObject({
      handledRequestCount: 2,
      respondedRequestCount: 2,
      responseFailureCount: 0,
    });
  });

  test("acknowledges a durable run while admission-journal completion recovers", async () => {
    const value = fixture();
    value.admissions.fail = true;
    await value.service.handle(dynamicRequest(undefined, {
      callId: "provider-call-completion-lost",
      id: "provider-request-completion-lost-a",
      requestInstanceId: 12,
    }));
    expect(responseValue(routedResponse(value.router, 0))).toEqual({
      runId,
      state: "accepted",
    });

    value.admissions.fail = false;
    await value.service.handle(dynamicRequest(undefined, {
      callId: "provider-call-completion-lost",
      id: "provider-request-completion-lost-b",
      requestInstanceId: 13,
    }));
    expect(responseValue(routedResponse(value.router, 1))).toEqual({
      runId,
      state: "accepted",
    });
    expect(value.runtime.admissions).toHaveLength(2);
    expect(value.admissions.completions).toEqual([runId, runId]);
  });

  test("rejects a runtime handle mismatch before journal acknowledgement", async () => {
    const value = fixture();
    value.runtime.admitRunIdOverride = "rlmrun_service_wrong_handle01";

    await value.service.handle(dynamicRequest(undefined, {
      callId: "provider-call-wrong-handle",
      id: "provider-request-wrong-handle",
      requestInstanceId: 14,
    }));

    expect(responseText(routedResponse(value.router))).toBe(
      HARNESS_DYNAMIC_TOOL_FAILURE_MESSAGES.operationFailed,
    );
    expect(value.runtime.admissions).toHaveLength(1);
    expect(value.admissions.completions).toEqual([]);
  });

  test("a new provider call identity admits a distinct durable run", async () => {
    const value = fixture();
    const firstRunId = "rlmrun_service_distinct_call_a";
    const secondRunId = "rlmrun_service_distinct_call_b";
    value.callers.admissionImplementation = ({ call }) => ({
      ...stableAdmission,
      runId: call.providerCallId.endsWith("-a") ? firstRunId : secondRunId,
    });

    await value.service.handle(dynamicRequest(undefined, {
      callId: "provider-call-distinct-a",
      id: "provider-request-distinct-a",
      requestInstanceId: 15,
    }));
    await value.service.handle(dynamicRequest(undefined, {
      callId: "provider-call-distinct-b",
      id: "provider-request-distinct-b",
      requestInstanceId: 16,
    }));

    expect(responseValue(routedResponse(value.router, 0))).toEqual({
      runId: firstRunId,
      state: "accepted",
    });
    expect(responseValue(routedResponse(value.router, 1))).toEqual({
      runId: secondRunId,
      state: "accepted",
    });
    expect(value.runtime.admissions.map((entry) => entry.runId)).toEqual([
      firstRunId,
      secondRunId,
    ]);
    expect(value.admissions.completions).toEqual([firstRunId, secondRunId]);
  });

  test("proves stable ownership before status, wait, result, or cancellation", async () => {
    const value = fixture();
    value.callers.owned = false;
    const actions = ["status", "wait", "result", "cancel"] as const;

    for (const [index, action] of actions.entries()) {
      await value.service.handle(inspectionRequest(action, 20 + index));
      expect(responseText(routedResponse(value.router, index))).toBe(
        HARNESS_DYNAMIC_TOOL_FAILURE_MESSAGES.runUnavailable,
      );
    }

    expect(value.callers.ownershipChecks.map((entry) => entry.runId)).toEqual([
      runId,
      runId,
      runId,
      runId,
    ]);
    expect(value.runtime.statusCalls).toHaveLength(0);
    expect(value.runtime.waitCalls).toHaveLength(0);
    expect(value.runtime.resultCalls).toHaveLength(0);
    expect(value.runtime.cancelCalls).toHaveLength(0);
  });

  test("turns runtime timeout and terminal failures into fixed content-free failures", async () => {
    const value = fixture();
    value.runtime.waitImplementation = () =>
      Promise.reject(new RlmRuntimeV2Error("timeout"));
    value.runtime.resultValue = { state: "failed", code: "private_provider_detail" };

    await value.service.handle(inspectionRequest("wait", 30));
    await value.service.handle(inspectionRequest("result", 31));

    expect(responseText(routedResponse(value.router, 0))).toBe(
      HARNESS_DYNAMIC_TOOL_FAILURE_MESSAGES.waitTimedOut,
    );
    expect(responseText(routedResponse(value.router, 1))).toBe(
      HARNESS_DYNAMIC_TOOL_FAILURE_MESSAGES.runUnavailable,
    );
    expect(JSON.stringify(value.router.responses)).not.toContain("private_provider_detail");
    expect(value.runtime.cancelCalls).toHaveLength(0);
  });

  test("bounds an oversized completed result with one fixed failure", async () => {
    const value = fixture();
    value.runtime.resultValue = {
      state: "completed",
      value: "x".repeat(256 * 1_024),
    };

    await value.service.handle(inspectionRequest("result", 32));

    const response = routedResponse(value.router);
    expect(parsePinnedCodexDynamicToolResponse(response)).not.toBeNull();
    expect(response.success).toBeFalse();
    expect(responseText(response)).toBe(
      HARNESS_DYNAMIC_TOOL_FAILURE_MESSAGES.responseUnavailable,
    );
  });

  test("expires only the matching pending wait without cancelling its run", async () => {
    const value = fixture();
    let markStarted!: (signal: AbortSignal) => void;
    const started = new Promise<AbortSignal>((resolve) => {
      markStarted = resolve;
    });
    value.runtime.waitImplementation = (_runId, _timeoutMs, signal) => {
      markStarted(signal);
      return new Promise((_resolve, reject) => {
        signal.addEventListener(
          "abort",
          () => reject(new RlmRuntimeV2Error("cancelled")),
          { once: true },
        );
      });
    };
    const request = inspectionRequest("wait", 40, 30_000);
    const handling = value.service.handle(request);
    await started;

    expect(value.service.expire(providerAccount, {
      type: "server_request_expired",
      generation: 7,
      method: "item/tool/call",
      requestId: request.id,
      reason: "resolved_elsewhere",
    })).toBe(1);
    expect(await handling).toEqual({ delivery: "responded" });
    expect(responseText(routedResponse(value.router))).toBe(
      HARNESS_DYNAMIC_TOOL_FAILURE_MESSAGES.requestExpired,
    );
    expect(value.runtime.cancelCalls).toHaveLength(0);
  });

  test("quiesces pending waits, drains serialized responses, and leaves runs intact", async () => {
    const value = fixture();
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    value.runtime.waitImplementation = (_runId, _timeoutMs, signal) => {
      markStarted();
      return new Promise((_resolve, reject) => {
        signal.addEventListener(
          "abort",
          () => reject(new RlmRuntimeV2Error("cancelled")),
          { once: true },
        );
      });
    };
    const waiting = value.service.handle(inspectionRequest("wait", 50, 30_000));
    await started;
    const quiescing = value.service.quiesce();
    const afterClose = value.service.handle(dynamicRequest(undefined, {
      callId: "provider-call-after-close",
      id: "provider-request-after-close",
      requestInstanceId: 51,
    }));

    await Promise.all([waiting, afterClose]);
    expect(await quiescing).toEqual({
      handledRequestCount: 2,
      respondedRequestCount: 2,
      responseFailureCount: 0,
      abortedWaitCount: 1,
    });
    expect(responseText(routedResponse(value.router, 0))).toBe(
      HARNESS_DYNAMIC_TOOL_FAILURE_MESSAGES.serviceQuiesced,
    );
    expect(responseText(routedResponse(value.router, 1))).toBe(
      HARNESS_DYNAMIC_TOOL_FAILURE_MESSAGES.serviceQuiesced,
    );
    expect(value.callers.admissions).toHaveLength(0);
    expect(value.runtime.cancelCalls).toHaveLength(0);
  });

  test("a definitive post-provider drain includes requests delivered after admission closed", async () => {
    const value = fixture();
    value.service.closeAdmission();
    expect(await value.service.settled()).toMatchObject({
      handledRequestCount: 0,
      respondedRequestCount: 0,
    });

    const late = value.service.handle(dynamicRequest(undefined, {
      callId: "provider-call-after-first-drain",
      id: "provider-request-after-first-drain",
      requestInstanceId: 52,
    }));
    await Promise.all([late, value.service.settled()]);

    expect(responseText(routedResponse(value.router))).toBe(
      HARNESS_DYNAMIC_TOOL_FAILURE_MESSAGES.serviceQuiesced,
    );
    expect(await value.service.settled()).toEqual({
      handledRequestCount: 1,
      respondedRequestCount: 1,
      responseFailureCount: 0,
      abortedWaitCount: 0,
    });
    expect(value.callers.admissions).toEqual([]);
  });

  test("records one failed response attempt without retrying or cancelling the run", async () => {
    const value = fixture();
    value.router.fail = true;

    expect(await value.service.handle(dynamicRequest())).toEqual({
      delivery: "responseFailed",
    });
    expect(value.router.attempts).toBe(1);
    expect(value.runtime.admissions).toHaveLength(1);
    expect(value.runtime.cancelCalls).toHaveLength(0);
    expect(await value.service.quiesce()).toEqual({
      handledRequestCount: 1,
      respondedRequestCount: 0,
      responseFailureCount: 1,
      abortedWaitCount: 0,
    });
    expect(value.router.attempts).toBe(1);
  });

  test("serializes response settlement and reports the drained shutdown tail", async () => {
    const value = fixture();
    let releaseFirst!: () => void;
    const firstBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let markFirstAttempt!: () => void;
    const firstAttempted = new Promise<void>((resolve) => {
      markFirstAttempt = resolve;
    });
    value.router.implementation = () => {
      if (value.router.attempts === 1) {
        markFirstAttempt();
        return firstBlocked;
      }
      return Promise.resolve();
    };

    const first = value.service.handle(inspectionRequest("status", 60));
    const second = value.service.handle(inspectionRequest("status", 61));
    await firstAttempted;
    expect(value.router.attempts).toBe(1);
    const quiescing = value.service.quiesce();
    releaseFirst();

    await Promise.all([first, second]);
    expect(await quiescing).toEqual({
      handledRequestCount: 2,
      respondedRequestCount: 2,
      responseFailureCount: 0,
      abortedWaitCount: 0,
    });
    expect(value.router.attempts).toBe(2);
    expect(value.router.responses.map((entry) => entry[1].id)).toEqual([
      "provider-request-status-60",
      "provider-request-status-61",
    ]);
  });

  test("a frozen response generation cannot block another account or bounded drain", async () => {
    const value = fixture({ responseWriteTimeoutMs: 25 });
    let markFrozenAttempt!: () => void;
    const frozenAttempted = new Promise<void>((resolve) => {
      markFrozenAttempt = resolve;
    });
    const never = new Promise<void>(() => undefined);
    value.router.implementation = ([accountProfileId, request]) => {
      if (
        accountProfileId === "acct_frozen-private" &&
        request.generation === 11
      ) {
        markFrozenAttempt();
        return never;
      }
      return Promise.resolve();
    };
    value.router.fenceImplementation = () => new Promise(() => undefined);

    const frozen = value.service.handle(dynamicRequest(
      { schemaVersion: 1, action: "status", runId },
      {
        accountProfileId: "acct_frozen-private",
        callId: "provider-call-frozen",
        generation: 11,
        id: "provider-request-frozen",
        requestInstanceId: 70,
      },
    ));
    await frozenAttempted;
    const healthy = value.service.handle(dynamicRequest(
      { schemaVersion: 1, action: "status", runId },
      {
        accountProfileId: "acct_healthy-private",
        callId: "provider-call-healthy",
        generation: 12,
        id: "provider-request-healthy",
        requestInstanceId: 71,
      },
    ));

    expect(await withinDeadline(healthy, 100)).toEqual({ delivery: "responded" });
    expect(await withinDeadline(frozen, 100)).toEqual({ delivery: "responseFailed" });
    const staleGeneration = value.service.handle(dynamicRequest(
      { schemaVersion: 1, action: "status", runId },
      {
        accountProfileId: "acct_frozen-private",
        callId: "provider-call-frozen-stale",
        generation: 11,
        id: "provider-request-frozen-stale",
        requestInstanceId: 72,
      },
    ));
    const nextGeneration = value.service.handle(dynamicRequest(
      { schemaVersion: 1, action: "status", runId },
      {
        accountProfileId: "acct_frozen-private",
        callId: "provider-call-frozen-next-generation",
        generation: 12,
        id: "provider-request-frozen-next-generation",
        requestInstanceId: 73,
      },
    ));
    expect(await withinDeadline(staleGeneration, 100)).toEqual({
      delivery: "responseFailed",
    });
    expect(await withinDeadline(nextGeneration, 100)).toEqual({
      delivery: "responded",
    });
    value.service.closeAdmission();
    expect(await withinDeadline(value.service.settled(), 100)).toEqual({
      handledRequestCount: 4,
      respondedRequestCount: 2,
      responseFailureCount: 2,
      abortedWaitCount: 0,
    });
    expect(value.router.fences).toEqual([["acct_frozen-private", 11]]);
    expect(value.router.responses.map((entry) => entry[0])).toEqual([
      "acct_frozen-private",
      "acct_healthy-private",
      "acct_frozen-private",
    ]);
  });

  test("always routes a bounded parsed response for arbitrary foreign call params", async () => {
    await assertAsyncProperty(fc.asyncProperty(
      fc.anything(),
      fc.integer({ min: 1, max: 1_000_000 }),
      async (params, requestInstanceId) => {
        const value = fixture();
        const foreign = Object.freeze({
          ...dynamicRequest(undefined, {
            id: requestInstanceId,
            requestInstanceId,
          }),
          params,
        }) as unknown as PinnedCodexDynamicToolRequest;
        const settlement = await value.service.handle(foreign);
        expect(settlement.delivery).toBe("responded");
        expect(value.router.attempts).toBe(1);
        expect(parsePinnedCodexDynamicToolResponse(
          value.router.responses[0]?.[2].type === "result"
            ? value.router.responses[0][2].result
            : null,
        )).not.toBeNull();
      },
    ), { numRuns: 100 });
  });

  test("normalizes arbitrary runtime result values to bounded responses", async () => {
    await assertAsyncProperty(fc.asyncProperty(
      fc.anything(),
      fc.integer({ min: 1, max: 1_000_000 }),
      async (runtimeResult, requestInstanceId) => {
        const value = fixture();
        value.runtime.resultValue = runtimeResult as RlmRuntimeResult;
        await value.service.handle(inspectionRequest("result", requestInstanceId));
        const response = routedResponse(value.router);
        expect(parsePinnedCodexDynamicToolResponse(response)).not.toBeNull();
      },
    ), { numRuns: 100 });
  });
});

async function withinDeadline<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error("test deadline expired")), timeoutMs);
  });
  try {
    return await Promise.race([operation, deadline]);
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}
