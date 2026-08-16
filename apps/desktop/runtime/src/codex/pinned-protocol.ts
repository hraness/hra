import {
  defineOperation,
  type OperationSemantics,
} from "@hraness/codex-app-sdk";

import type { CodexRequestId } from "./envelope";
import { classifyCodex01446RemoteError } from "./compatibility-0-144-6";
import {
  HRA_RLM_DYNAMIC_TOOL_SPEC,
  PinnedCodexDynamicToolLedger,
  isPinnedCodexDynamicToolProbeWitness,
  parsePinnedCodexDynamicToolCall,
  parsePinnedCodexDynamicToolCallerBinding,
  parsePinnedCodexDynamicToolResponse,
  type PinnedCodexDynamicToolCallerBinding,
  type PinnedCodexDynamicToolProbeWitness,
  type PinnedCodexDynamicToolProbeRuntimeBinding,
  type PinnedCodexDynamicToolRequest,
} from "./dynamic-tool";
import {
  codexNotificationDispositions,
  codexServerRequestDispositions,
  isCodexNotificationMethod,
  isRoutedCodexServerRequestMethod,
  parseCodexNotification,
  parseCodexServerRequest,
  pinnedCodexCodecPairs,
  pinnedCodexGeneratedAssociationWitness,
  pinnedCodexInboundAssociationWitness,
  pinnedCodexMethods,
  supportedCodexNotificationMethods,
  supportedCodexServerRequestMethods,
  type CodexNotificationMethod,
  type CodexServerRequestMethod,
  type ParsedCodexNotification,
  type ParsedCodexServerRequest,
  type PinnedCodexAccountLoginCompleted,
  type PinnedCodexAccountRead,
  type PinnedCodexAccountReadInput,
  type PinnedCodexAccountUpdated,
  type PinnedCodexActivityReference,
  type PinnedCodexApprovalReference,
  type PinnedCodexCodec,
  type PinnedCodexDelta,
  type PinnedCodexFileChangeApproval,
  type PinnedCodexInitializeInput,
  type PinnedCodexInitializeOutput,
  type PinnedCodexItemLifecycle,
  type PinnedCodexLoginCancel,
  type PinnedCodexLoginCancelInput,
  type PinnedCodexLoginStart,
  type PinnedCodexLoginStartInput,
  type PinnedCodexMcpElicitationReference,
  type PinnedCodexRateLimits,
  type PinnedCodexRateLimitsUpdated,
  type PinnedCodexReasoningSummaryDelta,
  type PinnedCodexRequestShapes,
  type PinnedCodexServerRequestResolved,
  type PinnedCodexThread,
  type PinnedCodexThreadItem,
  type PinnedCodexThreadList,
  type PinnedCodexThreadListInput,
  type PinnedCodexThreadForkInput,
  type PinnedCodexThreadGoal,
  type PinnedCodexThreadGoalClearInput,
  type PinnedCodexThreadGoalGetInput,
  type PinnedCodexThreadGoalSetInput,
  type PinnedCodexThreadHistoryResponse,
  type PinnedCodexHistoryThreadItem,
  type PinnedCodexThreadItemsList,
  type PinnedCodexThreadItemsListInput,
  type PinnedCodexThreadNameUpdated,
  type PinnedCodexThreadReadInput,
  type PinnedCodexThreadReference,
  type PinnedCodexThreadResponse,
  type PinnedCodexThreadResumeInput,
  type PinnedCodexThreadStartInput,
  type PinnedCodexThreadStatusChanged,
  type PinnedCodexThreadTurnsList,
  type PinnedCodexThreadTurnsListInput,
  type PinnedCodexTokenUsage,
  type PinnedCodexTurn,
  type PinnedCodexTurnInterruptInput,
  type PinnedCodexTurnInterrupt,
  type PinnedCodexTurnLifecycle,
  type PinnedCodexTurnStart,
  type PinnedCodexTurnStartInput,
  type PinnedCodexTurnSteer,
  type PinnedCodexTurnSteerInput,
  type PinnedCodexUserInputRequest,
  type RoutedCodexServerRequestMethod,
} from "./pinned-codecs";
import {
  CodexRpcCore,
  type CodexExpiredServerRequestFault,
  type CodexGenerationEndReason,
  type CodexNotification as RawCodexNotification,
  type CodexProtocolDiagnostic,
  type CodexResponseAtPosition as RawCodexResponseAtPosition,
  type CodexRpcCallbacks as RawCodexRpcCallbacks,
  type CodexServerRequest as RawCodexServerRequest,
  type CodexServerResponse,
  type CodexStreamPosition,
} from "./rpc-core";
import type { CodexJsonlWriter } from "./writer";

export {
  codexNotificationDispositions,
  codexServerRequestDispositions,
  pinnedCodexGeneratedAssociationWitness,
  pinnedCodexInboundAssociationWitness,
  supportedCodexNotificationMethods,
  supportedCodexServerRequestMethods,
};
export type {
  CodexNotificationMethod,
  CodexServerRequestMethod,
  CodexStreamPosition,
  PinnedCodexAccountLoginCompleted,
  PinnedCodexAccountRead,
  PinnedCodexAccountReadInput,
  PinnedCodexAccountUpdated,
  PinnedCodexActivityReference,
  PinnedCodexApprovalReference,
  PinnedCodexCodec,
  PinnedCodexDelta,
  PinnedCodexFileChangeApproval,
  PinnedCodexInitializeInput,
  PinnedCodexInitializeOutput,
  PinnedCodexItemLifecycle,
  PinnedCodexLoginCancel,
  PinnedCodexLoginCancelInput,
  PinnedCodexLoginStart,
  PinnedCodexLoginStartInput,
  PinnedCodexMcpElicitationReference,
  PinnedCodexRateLimits,
  PinnedCodexRateLimitsUpdated,
  PinnedCodexReasoningSummaryDelta,
  PinnedCodexServerRequestResolved,
  PinnedCodexThread,
  PinnedCodexThreadItem,
  PinnedCodexThreadList,
  PinnedCodexThreadListInput,
  PinnedCodexThreadForkInput,
  PinnedCodexThreadGoal,
  PinnedCodexThreadGoalClearInput,
  PinnedCodexThreadGoalGetInput,
  PinnedCodexThreadGoalSetInput,
  PinnedCodexThreadHistoryResponse,
  PinnedCodexHistoryThreadItem,
  PinnedCodexThreadItemsList,
  PinnedCodexThreadItemsListInput,
  PinnedCodexThreadNameUpdated,
  PinnedCodexThreadReadInput,
  PinnedCodexThreadReference,
  PinnedCodexThreadResponse,
  PinnedCodexThreadResumeInput,
  PinnedCodexThreadStartInput,
  PinnedCodexThreadStatusChanged,
  PinnedCodexThreadTurnsList,
  PinnedCodexThreadTurnsListInput,
  PinnedCodexTokenUsage,
  PinnedCodexTurn,
  PinnedCodexTurnInterruptInput,
  PinnedCodexTurnInterrupt,
  PinnedCodexTurnLifecycle,
  PinnedCodexTurnStart,
  PinnedCodexTurnStartInput,
  PinnedCodexTurnSteer,
  PinnedCodexTurnSteerInput,
  PinnedCodexUserInputRequest,
  RoutedCodexServerRequestMethod,
};

type Awaitable<T> = T | Promise<T>;

export type PinnedCodexRequestKey = keyof PinnedCodexRequestShapes;
export type PinnedCodexRequestInput<K extends PinnedCodexRequestKey> =
  PinnedCodexRequestShapes[K]["input"];
export type PinnedCodexRequestOutput<K extends PinnedCodexRequestKey> =
  PinnedCodexRequestShapes[K]["output"];

export type PinnedCodexRequestSemantics = OperationSemantics;
export type PinnedCodexEffect = OperationSemantics["effect"];
export type PinnedCodexLostResponseOutcome =
  OperationSemantics["lostResponse"];
export type PinnedCodexConcurrency = OperationSemantics["concurrency"];
export type PinnedCodexReconciliation =
  OperationSemantics["reconciliation"];

type PinnedCodexRequestDescriptorBase<K extends PinnedCodexRequestKey> = Readonly<{
  readonly key: K;
  readonly method: (typeof pinnedCodexMethods)[K];
  readonly inputCodec: PinnedCodexCodec<PinnedCodexRequestInput<K>>;
  readonly outputCodec: PinnedCodexCodec<PinnedCodexRequestOutput<K>>;
  readonly semantics: OperationSemantics;
}>;

export type PinnedCodexRequestDescriptor<K extends PinnedCodexRequestKey> =
  PinnedCodexRequestDescriptorBase<K>;

function descriptor<K extends PinnedCodexRequestKey>(
  key: K,
  semantics: OperationSemantics,
): PinnedCodexRequestDescriptor<K> {
  const operation = defineOperation<
    PinnedCodexRequestInput<K>,
    PinnedCodexRequestOutput<K>
  >(semantics);
  return Object.freeze({
    key,
    method: pinnedCodexMethods[key],
    inputCodec: pinnedCodexCodecPairs[key].input,
    outputCodec: pinnedCodexCodecPairs[key].output,
    semantics: operation.semantics,
  });
}

export const pinnedCodexRequests = Object.freeze({
  clientInitialize: descriptor("clientInitialize", {
    timeoutMs: 10_000,
    effect: "read",
    lostResponse: "safe-to-retry",
    concurrency: "per-source",
    reconciliation: "not-required",
  }),
  accountLoginStart: descriptor("accountLoginStart", {
    timeoutMs: 30_000,
    effect: "non-idempotent-mutation",
    lostResponse: "ambiguous",
    concurrency: "per-source",
    reconciliation: { kind: "automatic", strategy: "account-auth" },
  }),
  accountLoginCancel: descriptor("accountLoginCancel", {
    timeoutMs: 10_000,
    effect: "non-idempotent-mutation",
    lostResponse: "ambiguous",
    concurrency: "per-source",
    reconciliation: { kind: "automatic", strategy: "account-auth" },
  }),
  accountLogout: descriptor("accountLogout", {
    timeoutMs: 10_000,
    effect: "non-idempotent-mutation",
    lostResponse: "ambiguous",
    concurrency: "per-source",
    reconciliation: { kind: "automatic", strategy: "account-auth" },
  }),
  accountRead: descriptor("accountRead", {
    timeoutMs: 10_000,
    effect: "read",
    lostResponse: "safe-to-retry",
    concurrency: "parallel",
    reconciliation: "not-required",
  }),
  accountRateLimitsRead: descriptor("accountRateLimitsRead", {
    timeoutMs: 10_000,
    effect: "read",
    lostResponse: "safe-to-retry",
    concurrency: "parallel",
    reconciliation: "not-required",
  }),
  accountUsageRead: descriptor("accountUsageRead", {
    timeoutMs: 10_000,
    effect: "read",
    lostResponse: "safe-to-retry",
    concurrency: "parallel",
    reconciliation: "not-required",
  }),
  threadList: descriptor("threadList", {
    timeoutMs: 15_000,
    effect: "read",
    lostResponse: "safe-to-retry",
    concurrency: "parallel",
    reconciliation: "not-required",
  }),
  threadStart: descriptor("threadStart", {
    timeoutMs: 30_000,
    effect: "non-idempotent-mutation",
    lostResponse: "ambiguous",
    concurrency: "per-source",
    reconciliation: {
      kind: "automatic",
      strategy: "exhaustive-stable-thread-source-scan",
    },
  }),
  threadResume: descriptor("threadResume", {
    timeoutMs: 30_000,
    effect: "non-idempotent-mutation",
    lostResponse: "ambiguous",
    concurrency: "per-thread",
    reconciliation: { kind: "unsupported", strategy: "thread-read" },
  }),
  threadRead: descriptor("threadRead", {
    timeoutMs: 15_000,
    effect: "read",
    lostResponse: "safe-to-retry",
    concurrency: "parallel",
    reconciliation: "not-required",
  }),
  threadHistoryRead: descriptor("threadHistoryRead", {
    timeoutMs: 15_000,
    effect: "read",
    lostResponse: "safe-to-retry",
    concurrency: "parallel",
    reconciliation: "not-required",
  }),
  threadTurnsList: descriptor("threadTurnsList", {
    timeoutMs: 15_000,
    effect: "read",
    lostResponse: "safe-to-retry",
    concurrency: "parallel",
    reconciliation: "not-required",
  }),
  threadItemsList: descriptor("threadItemsList", {
    timeoutMs: 15_000,
    effect: "read",
    lostResponse: "safe-to-retry",
    concurrency: "parallel",
    reconciliation: "not-required",
  }),
  threadFork: descriptor("threadFork", {
    timeoutMs: 30_000,
    effect: "non-idempotent-mutation",
    lostResponse: "ambiguous",
    concurrency: "per-thread",
    reconciliation: { kind: "unsupported", strategy: "thread-read" },
  }),
  threadGoalSet: descriptor("threadGoalSet", {
    timeoutMs: 15_000,
    effect: "non-idempotent-mutation",
    lostResponse: "ambiguous",
    concurrency: "per-thread",
    reconciliation: { kind: "unsupported", strategy: "thread-read" },
  }),
  threadGoalGet: descriptor("threadGoalGet", {
    timeoutMs: 10_000,
    effect: "read",
    lostResponse: "safe-to-retry",
    concurrency: "per-thread",
    reconciliation: "not-required",
  }),
  threadGoalClear: descriptor("threadGoalClear", {
    timeoutMs: 15_000,
    effect: "non-idempotent-mutation",
    lostResponse: "ambiguous",
    concurrency: "per-thread",
    reconciliation: { kind: "unsupported", strategy: "thread-read" },
  }),
  threadSetName: descriptor("threadSetName", {
    timeoutMs: 15_000,
    effect: "non-idempotent-mutation",
    lostResponse: "ambiguous",
    concurrency: "per-thread",
    reconciliation: { kind: "unsupported", strategy: "thread-read" },
  }),
  threadInjectItems: descriptor("threadInjectItems", {
    timeoutMs: 30_000,
    effect: "non-idempotent-mutation",
    lostResponse: "ambiguous",
    concurrency: "per-thread",
    reconciliation: { kind: "unsupported", strategy: "thread-read" },
  }),
  modelList: descriptor("modelList", {
    timeoutMs: 15_000,
    effect: "read",
    lostResponse: "safe-to-retry",
    concurrency: "parallel",
    reconciliation: "not-required",
  }),
  turnStart: descriptor("turnStart", {
    timeoutMs: 30_000,
    effect: "non-idempotent-mutation",
    lostResponse: "ambiguous",
    concurrency: "per-thread",
    reconciliation: {
      kind: "automatic",
      strategy: "exhaustive-stable-client-message-id-scan",
    },
  }),
  turnSteer: descriptor("turnSteer", {
    timeoutMs: 30_000,
    effect: "non-idempotent-mutation",
    lostResponse: "ambiguous",
    concurrency: "per-thread",
    reconciliation: { kind: "unsupported", strategy: "client-message-id" },
  }),
  turnInterrupt: descriptor("turnInterrupt", {
    timeoutMs: 15_000,
    effect: "non-idempotent-mutation",
    lostResponse: "ambiguous",
    concurrency: "per-thread",
    reconciliation: {
      kind: "automatic",
      strategy: "terminal-turn-observation",
    },
  }),
}) satisfies {
  readonly [K in PinnedCodexRequestKey]: PinnedCodexRequestDescriptor<K>;
};

type WithGeneration<T> = T extends unknown
  ? Readonly<T & {
      readonly generation: number;
      readonly streamPosition: CodexStreamPosition;
    }>
  : never;
type WithServerRequestIdentity<T> = T extends unknown
  ? Readonly<T & {
      readonly generation: number;
      readonly id: CodexRequestId;
      readonly requestInstanceId: number;
      readonly streamPosition: CodexStreamPosition;
    }>
  : never;

export type CodexNotification = WithGeneration<ParsedCodexNotification>;
export type CodexServerRequest = WithServerRequestIdentity<ParsedCodexServerRequest>;
export type CodexRespondableServerRequest =
  | CodexServerRequest
  | PinnedCodexDynamicToolRequest;
export type SupportedCodexNotificationMethod = CodexNotificationMethod;
export type SupportedCodexServerRequestMethod = RoutedCodexServerRequestMethod;

export interface PinnedCodexResponseAtPosition<T> {
  readonly generation: number;
  readonly output: T;
  readonly streamPosition: CodexStreamPosition;
}

export interface CodexRpcCallbacks {
  readonly onNotification?: (notification: CodexNotification) => Awaitable<void>;
  readonly onServerRequest?: (request: CodexServerRequest) => Awaitable<void>;
  readonly onDynamicToolRequest?: (
    request: PinnedCodexDynamicToolRequest,
  ) => Awaitable<void>;
  readonly onDiagnostic?: (diagnostic: CodexProtocolDiagnostic) => Awaitable<void>;
  readonly onServerRequestExpired?: (
    fault: CodexExpiredServerRequestFault,
  ) => Awaitable<void>;
}

export interface PinnedCodexDynamicToolProtocolCapability {
  readonly witness: PinnedCodexDynamicToolProbeWitness;
  readonly caller: PinnedCodexDynamicToolCallerBinding;
  readonly runtimeBinarySha256: string;
}

export interface PinnedCodexProtocolOptions {
  readonly dynamicTool?: PinnedCodexDynamicToolProtocolCapability;
  readonly now?: () => number;
}

export class PinnedCodexPayloadError extends Error {
  readonly boundary: "request_input" | "response_output";
  readonly operation: PinnedCodexRequestKey;

  constructor(
    operation: PinnedCodexRequestKey,
    boundary: "request_input" | "response_output",
  ) {
    super("Codex protocol data did not match the pinned contract.");
    this.name = "PinnedCodexPayloadError";
    this.operation = operation;
    this.boundary = boundary;
  }
}

function activeRequestKey(generation: number, id: CodexRequestId): string {
  return `${String(generation)}:${typeof id}:${String(id)}`;
}

/**
 * The sole public 0.144.6 boundary. It owns request policy, codecs, inbound
 * parsing, and the raw JSON-RPC transport for one process generation.
 */
export class PinnedCodexProtocol {
  readonly #callbacks: CodexRpcCallbacks;
  readonly #core: CodexRpcCore;
  readonly #dynamicTool: PinnedCodexDynamicToolProtocolCapability | null;
  readonly #dynamicToolLedger = new PinnedCodexDynamicToolLedger();
  readonly #serverRequests = new Map<
    string,
    Readonly<{ publicRequest: CodexRespondableServerRequest; rawRequest: RawCodexServerRequest }>
  >();

  constructor(
    generation: number,
    writer: CodexJsonlWriter,
    callbacks: CodexRpcCallbacks = {},
    options: PinnedCodexProtocolOptions = {},
  ) {
    this.#callbacks = callbacks;
    const dynamicTool = options.dynamicTool;
    const dynamicToolRuntime: PinnedCodexDynamicToolProbeRuntimeBinding | null =
      dynamicTool === undefined
        ? null
        : {
          binarySha256: dynamicTool.runtimeBinarySha256,
          processGeneration: generation,
          nowMs: options.now?.() ?? Date.now(),
        };
    this.#dynamicTool = dynamicTool !== undefined &&
        callbacks.onDynamicToolRequest !== undefined &&
        dynamicToolRuntime !== null &&
        isPinnedCodexDynamicToolProbeWitness(
          dynamicTool.witness,
          dynamicToolRuntime,
        )
      ? parsedDynamicToolCapability(dynamicTool, dynamicToolRuntime)
      : null;
    const rawCallbacks: RawCodexRpcCallbacks = {
      onNotification: (notification) => this.#receiveNotification(notification),
      onServerRequest: (request) => this.#receiveServerRequest(request),
      onDiagnostic: (diagnostic) => this.#callbacks.onDiagnostic?.(diagnostic),
      onServerRequestExpired: async (fault) => {
        if (fault.requestId !== undefined) {
          this.#serverRequests.delete(activeRequestKey(fault.generation, fault.requestId));
        }
        await this.#callbacks.onServerRequestExpired?.(fault);
      },
    };
    this.#core = new CodexRpcCore(generation, writer, rawCallbacks, {
      classifyRemoteError: classifyCodex01446RemoteError,
      notificationMethods: supportedCodexNotificationMethods,
      serverRequestMethods: this.#dynamicTool === null
        ? supportedCodexServerRequestMethods
        : [...supportedCodexServerRequestMethods, "item/tool/call"],
    });
  }

  get generation(): number {
    return this.#core.generation;
  }

  async request<K extends PinnedCodexRequestKey>(
    key: K,
    input: PinnedCodexRequestInput<K>,
  ): Promise<PinnedCodexRequestOutput<K>> {
    return (await this.requestWithResponsePosition(key, input)).output;
  }

  async requestWithResponsePosition<K extends PinnedCodexRequestKey>(
    key: K,
    input: PinnedCodexRequestInput<K>,
  ): Promise<PinnedCodexResponseAtPosition<PinnedCodexRequestOutput<K>>> {
    const selected = pinnedCodexRequests[key] as PinnedCodexRequestDescriptor<K>;
    let params: PinnedCodexRequestInput<K>;
    try {
      params = selected.inputCodec.parse(input);
    } catch {
      throw new PinnedCodexPayloadError(key, "request_input");
    }
    const wireParams = key === "threadStart" && this.#dynamicTool !== null
      ? dynamicToolThreadStartParams(params)
      : params;
    const raw: RawCodexResponseAtPosition<unknown> =
      await this.#core.requestWithResponsePosition(selected.method, wireParams, {
        intent: selected.semantics.lostResponse === "ambiguous"
          ? "ambiguousMutation"
          : "read",
        timeoutMs: selected.semantics.timeoutMs,
      });
    try {
      return {
        generation: raw.generation,
        output: selected.outputCodec.parse(raw.result),
        streamPosition: raw.streamPosition,
      };
    } catch {
      try {
        await this.#callbacks.onDiagnostic?.({
          type: "invalid_inbound_payload",
          generation: this.generation,
          source: "response",
          operation: key,
        });
      } catch {
        // A diagnostic observer cannot weaken the terminal protocol fault.
      }
      await this.#core.expire("protocol_fault");
      throw new PinnedCodexPayloadError(key, "response_output");
    }
  }

  initialized(): Promise<void> {
    return this.#core.notify("initialized");
  }

  receiveChunk(sourceGeneration: number, chunk: Uint8Array): Promise<void> {
    return this.#core.receiveChunk(sourceGeneration, chunk);
  }

  finish(sourceGeneration: number): Promise<void> {
    return this.#core.finish(sourceGeneration);
  }

  receiveLine(sourceGeneration: number, line: string): Promise<void> {
    return this.#core.receiveLine(sourceGeneration, line);
  }

  receiveValue(sourceGeneration: number, value: unknown): Promise<void> {
    return this.#core.receiveValue(sourceGeneration, value);
  }

  async respond(
    request: CodexRespondableServerRequest,
    response: CodexServerResponse,
  ): Promise<CodexStreamPosition> {
    const key = activeRequestKey(request.generation, request.id);
    const active = this.#serverRequests.get(key);
    if (active === undefined || active.publicRequest !== request) {
      throw new Error("Codex server request is no longer active");
    }
    const parsedResponse = request.method === "item/tool/call" && response.type === "result"
      ? parsePinnedCodexDynamicToolResponse(response.result)
      : null;
    if (request.method === "item/tool/call" && response.type === "result" && parsedResponse === null) {
      throw new Error("HRA dynamic tool response did not match the pinned contract");
    }
    this.#serverRequests.delete(key);
    return await this.#core.respond(
      active.rawRequest,
      request.method === "item/tool/call"
        ? response.type === "result"
          ? { type: "result", result: parsedResponse }
          : {
              type: "error",
              code: response.code,
              message: "HRA dynamic tool failed",
            }
        : response,
    );
  }

  expire(reason: CodexGenerationEndReason): Promise<void> {
    return this.#core.expire(reason);
  }

  async #receiveNotification(notification: RawCodexNotification): Promise<void> {
    if (!isCodexNotificationMethod(notification.method)) {
      throw new Error("Raw Codex method policy admitted an unknown notification");
    }
    const parsed = parseCodexNotification(notification.method, notification.params);
    if (parsed === null) {
      try {
        await this.#callbacks.onDiagnostic?.({
          type: "invalid_inbound_payload",
          generation: notification.generation,
          method: notification.method,
          source: "notification",
        });
      } finally {
        await this.#core.expire("protocol_fault");
      }
      return;
    }
    if (parsed.method === "serverRequest/resolved") {
      await this.#core.resolveServerRequest(parsed.params.requestId);
    }
    await this.#callbacks.onNotification?.({
      ...parsed,
      generation: notification.generation,
      streamPosition: notification.streamPosition,
    });
  }

  async #receiveServerRequest(request: RawCodexServerRequest): Promise<void> {
    if (request.method === "item/tool/call") {
      await this.#receiveDynamicToolRequest(request);
      return;
    }
    if (!isRoutedCodexServerRequestMethod(request.method)) {
      throw new Error("Raw Codex method policy admitted an unrouted server request");
    }
    const parsed = parseCodexServerRequest(request.method, request.params);
    if (parsed === null) {
      try {
        await this.#core.respond(request, {
          type: "error",
          code: -32_602,
          message: "Invalid params",
        });
        const fault: CodexExpiredServerRequestFault = {
          type: "server_request_expired",
          generation: request.generation,
          method: request.method,
          requestId: request.id,
          reason: "invalid_params",
        };
        await this.#callbacks.onServerRequestExpired?.(fault);
        await this.#callbacks.onDiagnostic?.({
          type: "invalid_inbound_payload",
          generation: request.generation,
          method: request.method,
          source: "server_request",
        });
      } finally {
        await this.#core.expire("protocol_fault");
      }
      return;
    }
    const publicRequest: CodexServerRequest = {
      ...parsed,
      generation: request.generation,
      id: request.id,
      requestInstanceId: request.requestInstanceId,
      streamPosition: request.streamPosition,
    };
    this.#serverRequests.set(activeRequestKey(request.generation, request.id), {
      publicRequest,
      rawRequest: request,
    });
    await this.#callbacks.onServerRequest?.(publicRequest);
  }

  async #receiveDynamicToolRequest(request: RawCodexServerRequest): Promise<void> {
    const capability = this.#dynamicTool;
    if (capability === null) {
      throw new Error("Raw Codex method policy admitted an unwitnessed dynamic tool request");
    }
    const parsed = parsePinnedCodexDynamicToolCall(request.params);
    if (parsed === null) {
      await this.#rejectInvalidServerRequest(request);
      return;
    }
    const admission = this.#dynamicToolLedger.admit(request.generation, parsed);
    if (admission.kind !== "accepted") {
      await this.#core.respond(request, {
        type: "error",
        code: -32_609,
        message: admission.kind === "duplicate"
          ? "Duplicate dynamic tool call"
          : "Conflicting dynamic tool replay",
      });
      await this.#callbacks.onServerRequestExpired?.({
        type: "server_request_expired",
        generation: request.generation,
        method: request.method,
        requestId: request.id,
        reason: admission.kind === "duplicate" ? "duplicate_call" : "replay_conflict",
      });
      if (admission.kind === "replay_conflict") {
        try {
          await this.#callbacks.onDiagnostic?.({
            type: "invalid_inbound_payload",
            generation: request.generation,
            method: request.method,
            source: "server_request",
          });
        } finally {
          await this.#core.expire("protocol_fault");
        }
      }
      return;
    }
    const publicRequest: PinnedCodexDynamicToolRequest = Object.freeze({
      method: "item/tool/call",
      params: parsed,
      generation: request.generation,
      id: request.id,
      requestInstanceId: request.requestInstanceId,
      streamPosition: request.streamPosition,
      accountProfileId: capability.caller.accountProfileId,
      accountGeneration: capability.caller.accountGeneration,
    });
    this.#serverRequests.set(activeRequestKey(request.generation, request.id), {
      publicRequest,
      rawRequest: request,
    });
    const callback = this.#callbacks.onDynamicToolRequest;
    if (callback === undefined) {
      throw new Error("Dynamic tool authority disappeared after admission");
    }
    await callback(publicRequest);
  }

  async #rejectInvalidServerRequest(request: RawCodexServerRequest): Promise<void> {
    try {
      await this.#core.respond(request, {
        type: "error",
        code: -32_602,
        message: "Invalid params",
      });
      await this.#callbacks.onServerRequestExpired?.({
        type: "server_request_expired",
        generation: request.generation,
        method: request.method,
        requestId: request.id,
        reason: "invalid_params",
      });
      await this.#callbacks.onDiagnostic?.({
        type: "invalid_inbound_payload",
        generation: request.generation,
        method: request.method,
        source: "server_request",
      });
    } finally {
      await this.#core.expire("protocol_fault");
    }
  }
}

function dynamicToolThreadStartParams(
  params: unknown,
): Readonly<Record<string, unknown>> {
  if (typeof params !== "object" || params === null || Array.isArray(params)) {
    throw new Error("Parsed thread/start input was not an object");
  }
  if (Object.hasOwn(params, "dynamicTools")) {
    throw new Error("Dynamic tool registration collided with thread/start input");
  }
  return Object.freeze({
    ...params,
    dynamicTools: Object.freeze([HRA_RLM_DYNAMIC_TOOL_SPEC]),
  });
}

function parsedDynamicToolCapability(
  capability: PinnedCodexDynamicToolProtocolCapability,
  runtime: PinnedCodexDynamicToolProbeRuntimeBinding,
): PinnedCodexDynamicToolProtocolCapability | null {
  const caller = parsePinnedCodexDynamicToolCallerBinding(capability.caller);
  return caller === null ||
      capability.runtimeBinarySha256 !== capability.witness.binarySha256 ||
      !isPinnedCodexDynamicToolProbeWitness(capability.witness, runtime)
    ? null
    : Object.freeze({
        witness: capability.witness,
        caller,
        runtimeBinarySha256: capability.runtimeBinarySha256,
      });
}
