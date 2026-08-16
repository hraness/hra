import { z } from "@hra-internal/schema";

import type { AccountRuntimeRouter } from "../accounts/runtime-router";
import {
  parsePinnedCodexDynamicToolCall,
  parsePinnedCodexDynamicToolCallerBinding,
  parsePinnedCodexDynamicToolResponse,
  type CodexExpiredServerRequestFault,
  type PinnedCodexDynamicToolRequest,
  type PinnedCodexDynamicToolResponse,
} from "../codex";
import { programRunIdSchema } from "./domain";
import {
  rlmRunDesiredStateSchema,
  rlmRunStateSchema,
} from "./rlm-run-authority-v2";
import {
  RLM_V2_MAX_FUEL,
  digestRlmV2Program,
  parseRlmV2Program,
  type RlmV2Program,
} from "./rlm-v2";
import {
  RlmRuntimeV2Error,
  type RlmRuntimeAdmission,
  type RlmRuntimeResult,
  type RlmRuntimeRunHandle,
  type RlmRuntimeV2,
} from "./rlm-runtime-v2";

const REQUEST_KEYS = [
  "accountGeneration",
  "accountProfileId",
  "generation",
  "id",
  "method",
  "params",
  "requestInstanceId",
  "streamPosition",
] as const;
const CALL_KEYS = [
  "arguments",
  "argumentsSha256",
  "callId",
  "namespace",
  "threadId",
  "tool",
  "turnId",
] as const;
const SHA_256_PATTERN = /^[a-f0-9]{64}$/u;
const WAIT_ABORT_EXPIRED = Symbol("dynamic-tool-wait-expired");
const WAIT_ABORT_QUIESCE = Symbol("dynamic-tool-wait-quiesce");
const MAX_IN_FLIGHT_REQUEST_IDENTITIES = 4_096;
const DEFAULT_RESPONSE_WRITE_TIMEOUT_MS = 2_000;
const MAX_RESPONSE_WRITE_TIMEOUT_MS = 60_000;

const runtimeHandleSchema = z.object({
  runId: programRunIdSchema,
  state: rlmRunStateSchema,
  desiredState: rlmRunDesiredStateSchema,
  revision: z.number().int().positive().safe(),
}).strict();
const runtimeResultSchema = z.discriminatedUnion("state", [
  z.object({
    state: z.literal("pending"),
    handle: runtimeHandleSchema,
  }).strict(),
  z.object({
    state: z.literal("completed"),
    value: z.unknown(),
  }).strict(),
  z.object({
    state: z.enum(["failed", "stopped", "recoveryRequired"]),
    code: z.string().min(1).max(96),
  }).strict(),
]);
const admissionCompletionSchema = z.object({
  runId: programRunIdSchema,
  state: z.literal("admitted"),
}).passthrough();

export const HARNESS_DYNAMIC_TOOL_FAILURE_MESSAGES = Object.freeze({
  callerUnavailable: "The RLM caller is unavailable.",
  invalidRequest: "The RLM tool request is invalid.",
  operationFailed: "The RLM tool request failed.",
  requestExpired: "The RLM tool request expired.",
  responseUnavailable: "The RLM tool response is unavailable.",
  runUnavailable: "The RLM run is unavailable.",
  serviceRecovering: "The RLM tool service is recovering.",
  serviceQuiesced: "The RLM tool service is stopping.",
  waitTimedOut: "The RLM wait timed out.",
});

/**
 * Transient provider lookup material. An implementation may use it to find
 * durable actor authority, but none of these fields may be copied into an RLM
 * admission, run row, result, response, diagnostic, or report.
 */
export interface HarnessDynamicToolStableCall {
  readonly accountProfileId: string;
  readonly accountGeneration: number;
  readonly processGeneration: number;
  readonly providerThreadId: string;
  readonly providerTurnId: string;
  readonly providerCallId: string;
  readonly requestInstanceId: number;
  /** Canonical argument digest rederived by the pinned call parser. */
  readonly callDigest: string;
}

/** The service supplies the exact parsed program and fixed fuel separately. */
export type HarnessDynamicToolStableAdmission = Readonly<
  Omit<RlmRuntimeAdmission, "fuelLimit" | "program">
>;

/**
 * Trusted provider-to-actor seam. It alone may authorize a deterministic run
 * ID and must prove the exact stable actor owns every later inspection.
 */
export interface HarnessDynamicToolStableCallerPort {
  admit(input: Readonly<{
    call: HarnessDynamicToolStableCall;
    program: RlmV2Program;
    programDigest: string;
  }>): Promise<HarnessDynamicToolStableAdmission | null>;
  ownsRun(input: Readonly<{
    call: HarnessDynamicToolStableCall;
    runId: string;
  }>): Promise<boolean>;
}

type RuntimePort = Pick<
  RlmRuntimeV2,
  "admit" | "cancel" | "result" | "status" | "wait"
>;
type ResponseRouterPort = Pick<
  AccountRuntimeRouter,
  "fenceGeneration" | "respond"
>;
type MaybePromise<Value> = Value | Promise<Value>;

export interface HarnessDynamicToolProgramAdmissionCompletionPortV2 {
  completeAdmission(runId: string): MaybePromise<unknown>;
}

export interface HarnessDynamicToolServiceV2Options {
  readonly admissions: HarnessDynamicToolProgramAdmissionCompletionPortV2;
  readonly callers: HarnessDynamicToolStableCallerPort;
  /** Bounds one local JSONL response write without using wall-clock time. */
  readonly responseWriteTimeoutMs?: number;
  readonly router: ResponseRouterPort;
  readonly runtime: RuntimePort;
}

export interface HarnessDynamicToolResponseSettlement {
  readonly delivery: "responded" | "responseFailed";
}

export interface HarnessDynamicToolServiceQuiesceReport {
  readonly handledRequestCount: number;
  readonly respondedRequestCount: number;
  readonly responseFailureCount: number;
  readonly abortedWaitCount: number;
}

interface ValidatedRequest {
  readonly call: ReturnType<typeof requireParsedCall>;
  readonly callRequestId: PinnedCodexDynamicToolRequest["id"];
  readonly requestIdentity: string;
  readonly stableCall: HarnessDynamicToolStableCall;
}

interface PendingWait {
  readonly accountProfileId: string;
  readonly generation: number;
  readonly id: PinnedCodexDynamicToolRequest["id"];
  readonly controller: AbortController;
}

type DynamicToolAdmissionState = "recovering" | "open" | "closed";

/**
 * The provider request is only a response channel. Submit durably admits a run
 * and returns immediately; losing that channel never stops the admitted run.
 */
export class HarnessDynamicToolServiceV2 {
  readonly #admissions: HarnessDynamicToolProgramAdmissionCompletionPortV2;
  readonly #callers: HarnessDynamicToolStableCallerPort;
  readonly #router: ResponseRouterPort;
  readonly #runtime: RuntimePort;
  readonly #responseWriteTimeoutMs: number;
  readonly #handled = new WeakMap<
    PinnedCodexDynamicToolRequest,
    Promise<HarnessDynamicToolResponseSettlement>
  >();
  readonly #inFlightByIdentity = new Map<
    string,
    Promise<HarnessDynamicToolResponseSettlement>
  >();
  readonly #active = new Set<Promise<HarnessDynamicToolResponseSettlement>>();
  readonly #pendingWaits = new Set<PendingWait>();
  readonly #responseLaneTails = new Map<string, Promise<void>>();
  readonly #fencedResponseGenerationByAccount = new Map<string, number>();
  #admissionState: DynamicToolAdmissionState = "recovering";
  #handledRequestCount = 0;
  #respondedRequestCount = 0;
  #responseFailureCount = 0;
  #abortedWaitCount = 0;

  constructor(options: HarnessDynamicToolServiceV2Options) {
    this.#admissions = options.admissions;
    this.#callers = options.callers;
    this.#router = options.router;
    this.#runtime = options.runtime;
    this.#responseWriteTimeoutMs = positiveResponseWriteTimeout(
      options.responseWriteTimeoutMs,
    );
  }

  /**
   * Opens caller and runtime effects only after durable boot recovery. The
   * transition is idempotent and monotonic: shutdown may close a recovering
   * service, and a delayed boot continuation can never reopen it.
   */
  openAdmissionAfterRecovery(): void {
    if (this.#admissionState === "recovering") {
      this.#admissionState = "open";
    }
  }

  /** Repeated dispatch of the same trusted request shares one response attempt. */
  handle(
    request: PinnedCodexDynamicToolRequest,
  ): Promise<HarnessDynamicToolResponseSettlement> {
    const prior = this.#handled.get(request);
    if (prior !== undefined) return prior;
    const validated = validateRequest(request);
    const identity = validated?.requestIdentity ?? null;
    if (identity !== null) {
      const exactPrior = this.#inFlightByIdentity.get(identity);
      if (exactPrior !== undefined) {
        this.#handled.set(request, exactPrior);
        return exactPrior;
      }
    }
    this.#handledRequestCount += 1;
    const overIdentityBound = identity !== null &&
      this.#inFlightByIdentity.size >= MAX_IN_FLIGHT_REQUEST_IDENTITIES;
    const task = this.#produceAndRespond(
      request,
      overIdentityBound ? null : validated,
      overIdentityBound,
    ).finally(() => {
      this.#active.delete(task);
      if (identity !== null && this.#inFlightByIdentity.get(identity) === task) {
        this.#inFlightByIdentity.delete(identity);
      }
    });
    this.#handled.set(request, task);
    if (identity !== null && !overIdentityBound) {
      this.#inFlightByIdentity.set(identity, task);
    }
    this.#active.add(task);
    return task;
  }

  /**
   * Expires only matching wait requests. Submit, status, result, and explicit
   * cancel operations are never translated into an implicit run cancellation.
   */
  expire(
    accountProfileId: string,
    fault: CodexExpiredServerRequestFault,
  ): number {
    if (fault.method !== "item/tool/call") return 0;
    let aborted = 0;
    for (const pending of this.#pendingWaits) {
      if (
        pending.accountProfileId !== accountProfileId ||
        pending.generation !== fault.generation ||
        (fault.requestId !== undefined && pending.id !== fault.requestId) ||
        pending.controller.signal.aborted
      ) continue;
      pending.controller.abort(WAIT_ABORT_EXPIRED);
      aborted += 1;
      this.#abortedWaitCount += 1;
    }
    return aborted;
  }

  /** Synchronously closes admission and aborts waits while routing stays live. */
  closeAdmission(): void {
    if (this.#admissionState === "closed") return;
    this.#admissionState = "closed";
    for (const pending of this.#pendingWaits) {
      if (pending.controller.signal.aborted) continue;
      pending.controller.abort(WAIT_ABORT_QUIESCE);
      this.#abortedWaitCount += 1;
    }
  }

  /**
   * Drains every response admitted so far. This is deliberately repeatable:
   * process shutdown can deliver a final closed-service request after the
   * admission fence, and the caller performs the definitive drain only after
   * those provider callback sources have stopped.
   */
  settled(): Promise<HarnessDynamicToolServiceQuiesceReport> {
    return this.#drain();
  }

  /** Compatibility convenience for owners without a separate source fence. */
  quiesce(): Promise<HarnessDynamicToolServiceQuiesceReport> {
    this.closeAdmission();
    return this.settled();
  }

  async #drain(): Promise<HarnessDynamicToolServiceQuiesceReport> {
    for (;;) {
      const handledBeforeDrain = this.#handledRequestCount;
      if (this.#active.size > 0) {
        await Promise.all([...this.#active]);
      }
      if (this.#responseLaneTails.size > 0) {
        await Promise.all([...this.#responseLaneTails.values()]);
      }
      // Let callbacks already queued by the current provider stack register
      // their closed-service response before declaring this drain stable.
      await Promise.resolve();
      if (
        this.#active.size === 0 &&
        handledBeforeDrain === this.#handledRequestCount
      ) break;
    }
    return Object.freeze({
      handledRequestCount: this.#handledRequestCount,
      respondedRequestCount: this.#respondedRequestCount,
      responseFailureCount: this.#responseFailureCount,
      abortedWaitCount: this.#abortedWaitCount,
    });
  }

  async #produceAndRespond(
    request: PinnedCodexDynamicToolRequest,
    validated: ValidatedRequest | null,
    overIdentityBound: boolean,
  ): Promise<HarnessDynamicToolResponseSettlement> {
    let response: PinnedCodexDynamicToolResponse;
    try {
      response = this.#admissionState !== "open"
        ? failureResponse(this.#admissionState === "recovering"
          ? HARNESS_DYNAMIC_TOOL_FAILURE_MESSAGES.serviceRecovering
          : HARNESS_DYNAMIC_TOOL_FAILURE_MESSAGES.serviceQuiesced)
        : overIdentityBound
          ? failureResponse(HARNESS_DYNAMIC_TOOL_FAILURE_MESSAGES.operationFailed)
          : await this.#produceResponse(validated);
    } catch {
      response = failureResponse(HARNESS_DYNAMIC_TOOL_FAILURE_MESSAGES.operationFailed);
    }
    return await this.#routeResponse(request, response);
  }

  async #produceResponse(
    validated: ValidatedRequest | null,
  ): Promise<PinnedCodexDynamicToolResponse> {
    if (validated === null) {
      return failureResponse(HARNESS_DYNAMIC_TOOL_FAILURE_MESSAGES.invalidRequest);
    }
    const argumentsValue = validated.call.arguments;
    if (argumentsValue.action === "submit") {
      return await this.#submit(validated, argumentsValue.program);
    }
    const owned = await this.#owns(validated, argumentsValue.runId);
    if (!owned) {
      return failureResponse(HARNESS_DYNAMIC_TOOL_FAILURE_MESSAGES.runUnavailable);
    }
    try {
      switch (argumentsValue.action) {
        case "status":
          return handleResponse(
            requireOwnedHandle(
              await this.#runtime.status(argumentsValue.runId),
              argumentsValue.runId,
            ),
          );
        case "wait":
          return await this.#wait(validated, argumentsValue.runId, argumentsValue.timeoutMs);
        case "result":
          return resultResponse(
            argumentsValue.runId,
            await this.#runtime.result(argumentsValue.runId),
          );
        case "cancel":
          return handleResponse(
            requireOwnedHandle(
              await this.#runtime.cancel(argumentsValue.runId),
              argumentsValue.runId,
            ),
          );
      }
    } catch (error: unknown) {
      return failureResponse(runtimeFailureMessage(error));
    }
  }

  async #submit(
    validated: ValidatedRequest,
    programValue: unknown,
  ): Promise<PinnedCodexDynamicToolResponse> {
    let program: RlmV2Program;
    try {
      program = parseRlmV2Program(programValue);
    } catch {
      return failureResponse(HARNESS_DYNAMIC_TOOL_FAILURE_MESSAGES.invalidRequest);
    }
    const programDigest = digestRlmV2Program(program);
    let stable: HarnessDynamicToolStableAdmission | null;
    try {
      stable = await this.#callers.admit({
        call: validated.stableCall,
        program,
        programDigest,
      });
    } catch {
      stable = null;
    }
    if (stable === null) {
      return failureResponse(HARNESS_DYNAMIC_TOOL_FAILURE_MESSAGES.callerUnavailable);
    }
    try {
      const handle = runtimeHandleSchema.parse(await this.#runtime.admit({
        runId: stable.runId,
        epochId: stable.epochId,
        actorId: stable.actorId,
        turnId: stable.turnId,
        completedPrefixSnapshotId: stable.completedPrefixSnapshotId,
        currentUserInputValueId: stable.currentUserInputValueId,
        releaseIdentityDigest: stable.releaseIdentityDigest,
        fuelLimit: RLM_V2_MAX_FUEL,
        program,
        caller: stable.caller,
      }));
      if (handle.runId !== stable.runId) {
        return failureResponse(HARNESS_DYNAMIC_TOOL_FAILURE_MESSAGES.operationFailed);
      }
      try {
        const completed = admissionCompletionSchema.parse(
          await this.#admissions.completeAdmission(stable.runId),
        );
        if (completed.runId !== stable.runId) {
          throw new TypeError("program admission completion names another run");
        }
      } catch {
        // Runtime admission is the durable commit point. Boot recovery closes
        // the journal phase; the caller must still receive the committed run.
      }
      // The public acknowledgement is invariant under an exact duplicate.
      return successResponse({ runId: handle.runId, state: "accepted" });
    } catch (error: unknown) {
      return failureResponse(runtimeFailureMessage(error));
    }
  }

  async #owns(validated: ValidatedRequest, runId: string): Promise<boolean> {
    try {
      return await this.#callers.ownsRun({
        call: validated.stableCall,
        runId,
      }) === true;
    } catch {
      return false;
    }
  }

  async #wait(
    validated: ValidatedRequest,
    runId: string,
    timeoutMs: number,
  ): Promise<PinnedCodexDynamicToolResponse> {
    const controller = new AbortController();
    const pending: PendingWait = {
      accountProfileId: validated.stableCall.accountProfileId,
      generation: validated.stableCall.processGeneration,
      id: validated.callRequestId,
      controller,
    };
    this.#pendingWaits.add(pending);
    try {
      const handle = requireOwnedHandle(
        await this.#runtime.wait(runId, timeoutMs, controller.signal),
        runId,
      );
      return handleResponse(handle);
    } catch (error: unknown) {
      if (controller.signal.reason === WAIT_ABORT_EXPIRED) {
        return failureResponse(HARNESS_DYNAMIC_TOOL_FAILURE_MESSAGES.requestExpired);
      }
      if (controller.signal.reason === WAIT_ABORT_QUIESCE) {
        return failureResponse(HARNESS_DYNAMIC_TOOL_FAILURE_MESSAGES.serviceQuiesced);
      }
      return failureResponse(runtimeFailureMessage(error));
    } finally {
      this.#pendingWaits.delete(pending);
    }
  }

  #routeResponse(
    request: PinnedCodexDynamicToolRequest,
    response: PinnedCodexDynamicToolResponse,
  ): Promise<HarnessDynamicToolResponseSettlement> {
    let resolveSettlement!: (value: HarnessDynamicToolResponseSettlement) => void;
    const settlement = new Promise<HarnessDynamicToolResponseSettlement>((resolve) => {
      resolveSettlement = resolve;
    });
    const laneKey = responseLaneKey(request);
    const predecessor = this.#responseLaneTails.get(laneKey) ?? Promise.resolve();
    const tail = predecessor.then(async () => {
      if (this.#responseGenerationIsFenced(request)) {
        this.#recordResponseFailure(resolveSettlement);
        return;
      }
      const write = Promise.resolve().then(async () =>
        await this.#router.respond(request.accountProfileId, request, {
          type: "result",
          result: response,
        })
      );
      const outcome = await settleWithinMonotonicDeadline(
        write,
        this.#responseWriteTimeoutMs,
      );
      if (outcome === "fulfilled") {
        this.#respondedRequestCount += 1;
        resolveSettlement(Object.freeze({ delivery: "responded" }));
        return;
      }
      if (outcome === "timedOut") {
        // Never admit another write into a generation with an indeterminate
        // response. Promise.race keeps the abandoned write observed, while the
        // exact-generation fence prevents a late success from gaining meaning.
        this.#rememberFencedResponseGeneration(request);
        this.#fenceTimedOutGeneration(request);
      }
      this.#recordResponseFailure(resolveSettlement);
    });
    this.#responseLaneTails.set(laneKey, tail);
    void tail.finally(() => {
      if (this.#responseLaneTails.get(laneKey) === tail) {
        this.#responseLaneTails.delete(laneKey);
      }
    }).catch(() => undefined);
    return settlement;
  }

  #recordResponseFailure(
    resolveSettlement: (value: HarnessDynamicToolResponseSettlement) => void,
  ): void {
    this.#responseFailureCount += 1;
    resolveSettlement(Object.freeze({ delivery: "responseFailed" }));
  }

  #responseGenerationIsFenced(request: PinnedCodexDynamicToolRequest): boolean {
    const generation = this.#fencedResponseGenerationByAccount.get(
      request.accountProfileId,
    );
    return generation !== undefined && request.generation <= generation;
  }

  #rememberFencedResponseGeneration(request: PinnedCodexDynamicToolRequest): void {
    const current = this.#fencedResponseGenerationByAccount.get(
      request.accountProfileId,
    );
    if (current === undefined || request.generation > current) {
      this.#fencedResponseGenerationByAccount.set(
        request.accountProfileId,
        request.generation,
      );
    }
  }

  #fenceTimedOutGeneration(request: PinnedCodexDynamicToolRequest): void {
    try {
      // fenceGeneration synchronously marks the exact route as stopping before
      // its bounded process teardown awaits. Shutdown must not wait for either
      // that teardown or the indeterminate JSONL write.
      void this.#router.fenceGeneration(
        request.accountProfileId,
        request.generation,
      ).catch(() => undefined);
    } catch {
      // A containment failure cannot reopen this poisoned response lane.
    }
  }
}

type MonotonicSettlement = "fulfilled" | "rejected" | "timedOut";

async function settleWithinMonotonicDeadline(
  operation: Promise<unknown>,
  timeoutMs: number,
): Promise<MonotonicSettlement> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const observed = operation.then<MonotonicSettlement, MonotonicSettlement>(
    () => "fulfilled",
    () => "rejected",
  );
  const deadline = new Promise<MonotonicSettlement>((resolve) => {
    // setTimeout measures an elapsed interval and is independent of wall-clock
    // adjustments. The observed branch retains handlers after the race ends.
    timer = setTimeout(() => resolve("timedOut"), timeoutMs);
  });
  try {
    return await Promise.race([observed, deadline]);
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}

function responseLaneKey(request: PinnedCodexDynamicToolRequest): string {
  return JSON.stringify([request.accountProfileId, request.generation]);
}

function positiveResponseWriteTimeout(value: number | undefined): number {
  if (value === undefined) return DEFAULT_RESPONSE_WRITE_TIMEOUT_MS;
  if (
    !Number.isSafeInteger(value) || value <= 0 ||
    value > MAX_RESPONSE_WRITE_TIMEOUT_MS
  ) {
    throw new Error("Dynamic-tool response timeout must be a positive bounded integer");
  }
  return value;
}

function validateRequest(
  request: PinnedCodexDynamicToolRequest,
): ValidatedRequest | null {
  try {
    if (!hasExactDataKeys(request, REQUEST_KEYS) || request.method !== "item/tool/call") {
      return null;
    }
    if (!validRequestId(request.id) ||
        !positiveSafeInteger(request.generation) ||
        !positiveSafeInteger(request.accountGeneration) ||
        request.accountGeneration !== request.generation ||
        !positiveSafeInteger(request.requestInstanceId) ||
        !nonnegativeSafeInteger(request.streamPosition)) {
      return null;
    }
    const caller = parsePinnedCodexDynamicToolCallerBinding({
      accountProfileId: request.accountProfileId,
      accountGeneration: request.accountGeneration,
    });
    if (caller === null || !hasExactDataKeys(request.params, CALL_KEYS) ||
        typeof request.params.argumentsSha256 !== "string" ||
        !SHA_256_PATTERN.test(request.params.argumentsSha256)) {
      return null;
    }
    const call = requireParsedCall({
      threadId: request.params.threadId,
      turnId: request.params.turnId,
      callId: request.params.callId,
      namespace: request.params.namespace,
      tool: request.params.tool,
      arguments: request.params.arguments,
    });
    if (call.argumentsSha256 !== request.params.argumentsSha256) return null;
    return Object.freeze({
      call,
      callRequestId: request.id,
      requestIdentity: JSON.stringify([
        request.accountProfileId,
        request.accountGeneration,
        request.generation,
        typeof request.id,
        request.id,
        request.requestInstanceId,
        request.streamPosition,
        call.threadId,
        call.turnId,
        call.callId,
        call.namespace,
        call.tool,
        call.argumentsSha256,
      ]),
      stableCall: Object.freeze({
        accountProfileId: caller.accountProfileId,
        accountGeneration: caller.accountGeneration,
        processGeneration: request.generation,
        providerThreadId: call.threadId,
        providerTurnId: call.turnId,
        providerCallId: call.callId,
        requestInstanceId: request.requestInstanceId,
        callDigest: call.argumentsSha256,
      }),
    });
  } catch {
    return null;
  }
}

function requireParsedCall(value: unknown) {
  const parsed = parsePinnedCodexDynamicToolCall(value);
  if (parsed === null) throw new Error("invalid pinned dynamic-tool call");
  return parsed;
}

function requireOwnedHandle(
  value: RlmRuntimeRunHandle,
  runId: string,
): RlmRuntimeRunHandle {
  const handle = runtimeHandleSchema.parse(value);
  if (handle.runId !== runId) throw new RlmRuntimeV2Error("conflict");
  return handle;
}

function handleResponse(handleValue: RlmRuntimeRunHandle): PinnedCodexDynamicToolResponse {
  const handle = runtimeHandleSchema.parse(handleValue);
  return successResponse({
    runId: handle.runId,
    state: handle.state,
    desiredState: handle.desiredState,
    revision: handle.revision,
  });
}

function resultResponse(
  runId: string,
  resultValue: RlmRuntimeResult,
): PinnedCodexDynamicToolResponse {
  const result = runtimeResultSchema.parse(resultValue);
  if (result.state === "completed") {
    return successResponse({ runId, state: result.state, value: result.value });
  }
  if (result.state === "pending") {
    const handle = requireOwnedHandle(result.handle, runId);
    return successResponse({
      runId,
      state: result.state,
      runState: handle.state,
      desiredState: handle.desiredState,
      revision: handle.revision,
    });
  }
  return failureResponse(HARNESS_DYNAMIC_TOOL_FAILURE_MESSAGES.runUnavailable);
}

function runtimeFailureMessage(error: unknown): string {
  const code = error instanceof RlmRuntimeV2Error
    ? error.code
    : typeof error === "object" && error !== null && "code" in error
      ? (error as { readonly code?: unknown }).code
      : null;
  if (code === "timeout") return HARNESS_DYNAMIC_TOOL_FAILURE_MESSAGES.waitTimedOut;
  if (code === "not_found") return HARNESS_DYNAMIC_TOOL_FAILURE_MESSAGES.runUnavailable;
  if (code === "quiesced") return HARNESS_DYNAMIC_TOOL_FAILURE_MESSAGES.serviceQuiesced;
  return HARNESS_DYNAMIC_TOOL_FAILURE_MESSAGES.operationFailed;
}

function successResponse(value: unknown): PinnedCodexDynamicToolResponse {
  try {
    const text = JSON.stringify(value);
    if (typeof text !== "string") throw new Error("response was not JSON");
    const parsed = parsePinnedCodexDynamicToolResponse({
      success: true,
      contentItems: [{ type: "inputText", text }],
    });
    if (parsed !== null) return parsed;
  } catch {
    // Convert hostile or oversized runtime output to one fixed bounded failure.
  }
  return failureResponse(HARNESS_DYNAMIC_TOOL_FAILURE_MESSAGES.responseUnavailable);
}

function failureResponse(message: string): PinnedCodexDynamicToolResponse {
  const parsed = parsePinnedCodexDynamicToolResponse({
    success: false,
    contentItems: [{ type: "inputText", text: message }],
  });
  if (parsed === null) throw new Error("fixed dynamic-tool failure response is invalid");
  return parsed;
}

function hasExactDataKeys(
  value: unknown,
  keys: readonly string[],
): value is Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Reflect.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const ownKeys = Reflect.ownKeys(descriptors);
  if (ownKeys.some((key) => typeof key !== "string") || ownKeys.length !== keys.length) {
    return false;
  }
  const expected = new Set(keys);
  return ownKeys.every((key) =>
    typeof key === "string" && expected.has(key) &&
    descriptors[key] !== undefined && "value" in descriptors[key]
  );
}

function validRequestId(value: unknown): boolean {
  return typeof value === "string"
    ? value.length <= 512
    : Number.isSafeInteger(value);
}

function positiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function nonnegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
