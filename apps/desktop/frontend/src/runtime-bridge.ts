import type { NativeSdkJson } from "@native-sdk/cli";

import {
  parseRuntimeDispatchRequest,
  parseRuntimeDispatchResponse,
  parseRuntimeChatDispatchResponseForRequest,
  parseRuntimeHarnessDispatchResponseForRequest,
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
  runtimeDispatchCommand,
  runtimeEventName,
  runtimeProjectAddCommand,
  runtimeProtocolVersion,
  runtimeSnapshotCommand,
  runtimeTransportHealthCommand,
  runtimeTransportLifecycleEventName,
  runtimeTransportRetryCommand,
  type RuntimeDispatchChunkResponse,
  type RuntimeChatDispatchRequest,
  type RuntimeChatDomainCommand,
  type RuntimeDispatchRequest,
  type RuntimeDispatchResponse,
  type RuntimeDispatchTransportResponse,
  type RuntimeDomainCommand,
  type RuntimeHarnessDispatchRequest,
  type RuntimeHarnessDomainCommand,
  type RuntimeEvent,
  type RuntimeProjectAddResult,
  type RuntimeSnapshot,
  type RuntimeSnapshotChunkResponse,
  type RuntimeTaskDispatchRequest,
  type RuntimeTaskDispatchResponse,
  type RuntimeTaskDomainCommand,
  type RuntimeTransportLifecycle,
  type RuntimeTransportRetryResponse,
} from "../../contracts/runtime";

export interface RuntimeTransport {
  invoke(command: string, payload?: NativeSdkJson): Promise<unknown>;
  on(name: string, callback: (detail: unknown) => void): () => void;
}

export type RuntimeBridgeBoundary =
  | "dispatchResponse"
  | "event"
  | "projectAddResponse"
  | "snapshotResponse"
  | "taskDispatchResponse"
  | "transportHealthResponse"
  | "transportLifecycle"
  | "transportRetryResponse";

export class RuntimeBridgeProtocolError extends Error {
  readonly boundary: RuntimeBridgeBoundary;
  override readonly cause: unknown;

  constructor(boundary: RuntimeBridgeBoundary, cause: unknown) {
    super(`The native runtime returned an invalid ${boundary}.`, { cause });
    this.name = "RuntimeBridgeProtocolError";
    this.boundary = boundary;
    this.cause = cause;
  }
}

export class RuntimeBridgeTransportTimeoutError extends Error {
  readonly command: string;
  readonly timeoutMilliseconds: number;

  constructor(command: string, timeoutMilliseconds: number) {
    super(`The native runtime did not answer ${command} within the bounded deadline.`);
    this.name = "RuntimeBridgeTransportTimeoutError";
    this.command = command;
    this.timeoutMilliseconds = timeoutMilliseconds;
  }
}

export interface RuntimeBridgeListener {
  readonly onEvent: (event: RuntimeEvent) => void;
  readonly onTransportLifecycle: (lifecycle: RuntimeTransportLifecycle) => void;
  readonly onMalformedValue: (error: RuntimeBridgeProtocolError) => void;
}

export interface RuntimeBridge {
  snapshot(): Promise<RuntimeSnapshot>;
  dispatch(command: RendererRuntimeDomainCommand): Promise<RuntimeDispatchResponse>;
  dispatchTask(command: RendererTaskDomainCommand): Promise<RuntimeTaskDispatchResponse>;
  addProject(): Promise<RuntimeProjectAddResult>;
  retryTransport(): Promise<RuntimeTransportRetryResponse>;
  subscribe(listener: RuntimeBridgeListener): () => void;
}

export type RendererRuntimeDomainCommand = RuntimeDomainCommand;
export type RendererTaskDomainCommand = RuntimeTaskDomainCommand;

function rendererCommand(command: RuntimeDomainCommand): RendererRuntimeDomainCommand {
  return command;
}

function isRuntimeChatCommand(
  command: RuntimeDomainCommand,
): command is RuntimeChatDomainCommand {
  return command.type === "chat.pane.create" ||
    command.type === "chat.pane.rename" ||
    command.type === "chat.pane.workspace.recover" ||
    command.type === "chat.pane.repository.select" ||
    command.type === "chat.pane.remove" ||
    command.type === "chat.panes.reorder" ||
    command.type === "chat.turn.stop" ||
    command.type === "chat.message.enqueue" ||
    command.type === "chat.message.edit" ||
    command.type === "chat.message.remove" ||
    command.type === "chat.messageQueue.resume" ||
    command.type === "chat.message.discardAmbiguous" ||
    command.type === "chat.message.steerHead";
}

function isRuntimeHarnessCommand(
  command: RuntimeDomainCommand,
): command is RuntimeHarnessDomainCommand {
  return command.type === "harness.settings.update" ||
    command.type === "harness.child.open" ||
    command.type === "harness.child.stop";
}

function rendererTaskCommand(command: RuntimeTaskDomainCommand): RendererTaskDomainCommand {
  return command;
}

export interface RuntimeBridgeOptions {
  readonly createOperationId?: () => string;
  /** Per native invocation, including each bounded transfer chunk. */
  readonly invokeTimeoutMilliseconds?: number;
  /**
   * Read-only snapshot deadline. Startup snapshots may legitimately include
   * bounded migration and crash-reconciliation work, so they receive a wider
   * fence than already-initialized mutations.
   */
  readonly snapshotTimeoutMilliseconds?: number;
  /** Best-effort forced recovery acknowledgement after an invocation timeout. */
  readonly recoveryTimeoutMilliseconds?: number;
}

const defaultInvokeTimeoutMilliseconds = 30_000;
const defaultSnapshotTimeoutMilliseconds = 300_000;
const defaultRecoveryTimeoutMilliseconds = 5_000;

type RuntimeInvoke = (
  command: string,
  payload?: NativeSdkJson,
) => Promise<unknown>;

function boundedMilliseconds(value: number | undefined, fallback: number): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < 1 || resolved > 300_000) {
    throw new RangeError("Runtime bridge deadlines must be safe integers from 1 to 300000ms.");
  }
  return resolved;
}

async function invokeWithDeadline(
  transport: RuntimeTransport,
  command: string,
  payload: NativeSdkJson | undefined,
  timeoutMilliseconds: number,
): Promise<unknown> {
  let timeout: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      transport.invoke(command, payload),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => {
          reject(new RuntimeBridgeTransportTimeoutError(command, timeoutMilliseconds));
        }, timeoutMilliseconds);
      }),
    ]);
  } finally {
    if (timeout !== null) clearTimeout(timeout);
  }
}

export type NativeUiScaleCommand = "decrease" | "increase" | "reset";

export const nativeUiScaleShortcutIds = {
  decrease: "hra.ui-scale.decrease",
  increase: "hra.ui-scale.increase",
  reset: "hra.ui-scale.reset",
} as const satisfies Record<NativeUiScaleCommand, string>;

const nativeUiScaleCommandByShortcutId = new Map<string, NativeUiScaleCommand>(
  [
    [nativeUiScaleShortcutIds.decrease, "decrease"],
    [nativeUiScaleShortcutIds.increase, "increase"],
    [nativeUiScaleShortcutIds.reset, "reset"],
  ],
);

export function uiScaleCommandFromNativeShortcut(value: unknown): NativeUiScaleCommand | null {
  if (typeof value !== "object" || value === null || !("id" in value)) return null;
  const id = value.id;
  if (typeof id !== "string") return null;
  return nativeUiScaleCommandByShortcutId.get(id) ?? null;
}

export function subscribeNativeUiScaleShortcuts(
  transport: Pick<RuntimeTransport, "on">,
  listener: (command: NativeUiScaleCommand) => void,
): () => void {
  return transport.on("shortcut", (detail) => {
    const command = uiScaleCommandFromNativeShortcut(detail);
    if (command !== null) listener(command);
  });
}

export function subscribeDetectedNativeUiScaleShortcuts(
  listener: (command: NativeUiScaleCommand) => void,
): () => void {
  if (typeof window === "undefined" || !("zero" in window)) return () => {};
  return subscribeNativeUiScaleShortcuts(window.zero, listener);
}

function defaultOperationId(): string {
  return `op_${crypto.randomUUID().replaceAll("-", "")}`;
}

function toNativeSdkJson(value: unknown, path = "$request"): NativeSdkJson {
  if (value === null || typeof value === "boolean" || typeof value === "string") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError(`${path} contains a non-finite number.`);
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((entry, index) => toNativeSdkJson(entry, `${path}[${index}]`));
  }
  if (typeof value !== "object") {
    throw new TypeError(`${path} contains a value that cannot cross the native JSON boundary.`);
  }
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${path} contains a non-plain object.`);
  }
  const output: Record<string, NativeSdkJson> = {};
  for (const [key, entry] of Object.entries(value)) {
    output[key] = toNativeSdkJson(entry, `${path}.${key}`);
  }
  return output;
}

function decodeBase64Chunk(
  chunk: RuntimeSnapshotChunkResponse | RuntimeDispatchChunkResponse,
): Uint8Array {
  const binary = atob(chunk.base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function concatenateBytes(parts: readonly Uint8Array[]): Uint8Array {
  const length = parts.reduce((total, part) => total + part.byteLength, 0);
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.byteLength;
  }
  return bytes;
}

function parseSnapshotTransportResponse(value: unknown) {
  try {
    return parseRuntimeSnapshotTransportResponse(value);
  } catch (error: unknown) {
    throw new RuntimeBridgeProtocolError("snapshotResponse", error);
  }
}

async function requestSnapshot(invoke: RuntimeInvoke): Promise<RuntimeSnapshot> {
  let response = parseSnapshotTransportResponse(await invoke(
    runtimeSnapshotCommand,
    toNativeSdkJson({ version: runtimeProtocolVersion }),
  ));
  if ("snapshot" in response) return response.snapshot;

  const transferId = response.transferId;
  const count = response.count;
  const parts: Uint8Array[] = [];
  for (let index = 0; index < count; index += 1) {
    if (
      response.transferId !== transferId ||
      response.count !== count ||
      response.index !== index
    ) {
      throw new RuntimeBridgeProtocolError(
        "snapshotResponse",
        new Error("Snapshot transfer chunks are inconsistent."),
      );
    }
    try {
      parts.push(decodeBase64Chunk(response));
    } catch (error: unknown) {
      throw new RuntimeBridgeProtocolError("snapshotResponse", error);
    }
    if (index + 1 < count) {
      response = parseSnapshotTransportResponse(await invoke(
        runtimeSnapshotCommand,
        toNativeSdkJson({
          version: runtimeProtocolVersion,
          transferId,
          index: index + 1,
        }),
      ));
      if ("snapshot" in response) {
        throw new RuntimeBridgeProtocolError(
          "snapshotResponse",
          new Error("Snapshot transfer changed representation mid-stream."),
        );
      }
    }
  }

  try {
    const json = new TextDecoder("utf-8", { fatal: true }).decode(concatenateBytes(parts));
    return parseRuntimeSnapshotResponse(JSON.parse(json) as unknown).snapshot;
  } catch (error: unknown) {
    throw new RuntimeBridgeProtocolError("snapshotResponse", error);
  }
}

function parseDispatchTransportEnvelope(
  value: unknown,
  operationId: string,
  boundary: Extract<RuntimeBridgeBoundary, "dispatchResponse" | "taskDispatchResponse">,
): RuntimeDispatchTransportResponse {
  try {
    const response = parseRuntimeDispatchTransportResponse(value);
    if (response.operationId !== operationId) {
      throw new Error(`Expected operation ${operationId}, received ${response.operationId}.`);
    }
    return response;
  } catch (error: unknown) {
    if (error instanceof RuntimeBridgeProtocolError) throw error;
    throw new RuntimeBridgeProtocolError(boundary, error);
  }
}

async function requestDispatchResponse<Response>(
  invoke: RuntimeInvoke,
  request: RuntimeDispatchRequest | RuntimeTaskDispatchRequest,
  boundary: Extract<RuntimeBridgeBoundary, "dispatchResponse" | "taskDispatchResponse">,
  parseFinal: (value: unknown) => Response,
): Promise<Response> {
  let response = parseDispatchTransportEnvelope(
    await invoke(runtimeDispatchCommand, toNativeSdkJson(request)),
    request.operationId,
    boundary,
  );
  if (!("base64" in response)) {
    try {
      return parseFinal(response);
    } catch (error: unknown) {
      throw new RuntimeBridgeProtocolError(boundary, error);
    }
  }

  const transferId = response.transferId;
  const count = response.count;
  const parts: Uint8Array[] = [];
  for (let index = 0; index < count; index += 1) {
    if (
      response.operationId !== request.operationId ||
      response.transferId !== transferId ||
      response.count !== count ||
      response.index !== index
    ) {
      throw new RuntimeBridgeProtocolError(
        boundary,
        new Error("Dispatch response transfer chunks are inconsistent."),
      );
    }
    try {
      parts.push(decodeBase64Chunk(response));
    } catch (error: unknown) {
      throw new RuntimeBridgeProtocolError(boundary, error);
    }
    if (index + 1 < count) {
      const continuation = parseRuntimeDispatchTransportRequest({
        version: runtimeProtocolVersion,
        operationId: request.operationId,
        transferId,
        index: index + 1,
      });
      response = parseDispatchTransportEnvelope(
        await invoke(runtimeDispatchCommand, toNativeSdkJson(continuation)),
        request.operationId,
        boundary,
      );
      if (!("base64" in response)) {
        throw new RuntimeBridgeProtocolError(
          boundary,
          new Error("Dispatch response transfer changed representation mid-stream."),
        );
      }
    }
  }

  try {
    const json = new TextDecoder("utf-8", { fatal: true }).decode(concatenateBytes(parts));
    return parseFinal(JSON.parse(json) as unknown);
  } catch (error: unknown) {
    if (error instanceof RuntimeBridgeProtocolError) throw error;
    throw new RuntimeBridgeProtocolError(boundary, error);
  }
}

export function createRuntimeBridge(
  transport: RuntimeTransport,
  options: RuntimeBridgeOptions = {},
): RuntimeBridge {
  const createOperationId = options.createOperationId ?? defaultOperationId;
  const invokeTimeoutMilliseconds = boundedMilliseconds(
    options.invokeTimeoutMilliseconds,
    defaultInvokeTimeoutMilliseconds,
  );
  const snapshotTimeoutMilliseconds = boundedMilliseconds(
    options.snapshotTimeoutMilliseconds ?? (
      options.invokeTimeoutMilliseconds === undefined
        ? undefined
        : invokeTimeoutMilliseconds
    ),
    defaultSnapshotTimeoutMilliseconds,
  );
  const recoveryTimeoutMilliseconds = boundedMilliseconds(
    options.recoveryTimeoutMilliseconds,
    defaultRecoveryTimeoutMilliseconds,
  );
  let observedTransportGeneration = 0;
  let forcedRecoveryTask: Promise<void> | null = null;

  const forceRecovery = (): Promise<void> => {
    if (forcedRecoveryTask !== null) return forcedRecoveryTask;
    const task = invokeWithDeadline(
      transport,
      runtimeTransportRetryCommand,
      toNativeSdkJson({ version: 1, forceIfRunning: true }),
      recoveryTimeoutMilliseconds,
    ).then(() => undefined, () => undefined);
    forcedRecoveryTask = task;
    void task.finally(() => {
      if (forcedRecoveryTask === task) forcedRecoveryTask = null;
    });
    return task;
  };

  const recoverProtocolFailure = async <Result>(operation: () => Promise<Result>) => {
    try {
      return await operation();
    } catch (error: unknown) {
      if (error instanceof RuntimeBridgeProtocolError) await forceRecovery();
      throw error;
    }
  };

  const invoke: RuntimeInvoke = async (command, payload) => {
    try {
      return await invokeWithDeadline(
        transport,
        command,
        payload,
        command === runtimeSnapshotCommand
          ? snapshotTimeoutMilliseconds
          : invokeTimeoutMilliseconds,
      );
    } catch (error: unknown) {
      if (!(error instanceof RuntimeBridgeTransportTimeoutError)) throw error;
      if (command === runtimeTransportRetryCommand) throw error;

      // The operation's commit status is ambiguous at its deadline, so it is
      // never replayed here. Force the supervised transport generation to
      // fail pending calls and rehydrate durable state under a new fence.
      // Recovery acknowledgement is best effort and separately bounded so a
      // wedged native bridge still returns control to the renderer.
      await forceRecovery();
      throw error;
    }
  };
  return {
    async snapshot() {
      const generation = observedTransportGeneration;
      return await recoverProtocolFailure(async () => {
        const snapshot = await requestSnapshot(invoke);
        if (generation === 0) return snapshot;
        const acknowledgement = await invoke(
          runtimeTransportHealthCommand,
          toNativeSdkJson({ version: 1, generation }),
        );
        if (
          typeof acknowledgement !== "object" || acknowledgement === null ||
          Object.getPrototypeOf(acknowledgement) !== Object.prototype ||
          Object.keys(acknowledgement).length !== 3 ||
          !("version" in acknowledgement) || acknowledgement.version !== 1 ||
          !("generation" in acknowledgement) || acknowledgement.generation !== generation ||
          !("status" in acknowledgement) || acknowledgement.status !== "accepted"
        ) {
          throw new RuntimeBridgeProtocolError(
            "transportHealthResponse",
            new Error("Native rejected the renderer-validated snapshot generation."),
          );
        }
        return snapshot;
      });
    },
    async dispatch(command) {
      const safeCommand = rendererCommand(command);
      const request = parseRuntimeDispatchRequest({
        version: runtimeProtocolVersion,
        operationId: createOperationId(),
        command: safeCommand,
      });
      const chatRequest: RuntimeChatDispatchRequest | null = isRuntimeChatCommand(
        request.command,
      )
        ? { ...request, command: request.command }
        : null;
      const harnessRequest: RuntimeHarnessDispatchRequest | null = isRuntimeHarnessCommand(
        request.command,
      )
        ? { ...request, command: request.command }
        : null;
      return await recoverProtocolFailure(async () =>
        await requestDispatchResponse(
          invoke,
          request,
          "dispatchResponse",
          (value) => {
            if (chatRequest !== null) {
              return parseRuntimeChatDispatchResponseForRequest(value, chatRequest);
            }
            if (harnessRequest !== null) {
              return parseRuntimeHarnessDispatchResponseForRequest(value, harnessRequest);
            }
            const response = parseRuntimeDispatchResponse(value);
            if (response.operationId !== request.operationId) {
              throw new Error(
                `Expected operation ${request.operationId}, received ${response.operationId}.`,
              );
            }
            return response;
          },
        )
      );
    },
    async dispatchTask(command) {
      const safeCommand = rendererTaskCommand(command);
      const request = parseRuntimeTaskDispatchRequest({
        version: runtimeProtocolVersion,
        operationId: createOperationId(),
        command: safeCommand,
      });
      return await recoverProtocolFailure(async () =>
        await requestDispatchResponse(
          invoke,
          request,
          "taskDispatchResponse",
          (value) => parseRuntimeTaskDispatchResponseForRequest(value, request),
        )
      );
    },
    async addProject() {
      const value = await invoke(
        runtimeProjectAddCommand,
        toNativeSdkJson({ version: runtimeProtocolVersion }),
      );
      try {
        return parseRuntimeProjectAddResult(value);
      } catch (error: unknown) {
        throw new RuntimeBridgeProtocolError("projectAddResponse", error);
      }
    },
    async retryTransport() {
      const value = await invoke(
        runtimeTransportRetryCommand,
        toNativeSdkJson({ version: 1 }),
      );
      try {
        return parseRuntimeTransportRetryResponse(value);
      } catch (error: unknown) {
        throw new RuntimeBridgeProtocolError("transportRetryResponse", error);
      }
    },
    subscribe(listener) {
      const unsubscribeRuntime = transport.on(runtimeEventName, (detail) => {
        let event: RuntimeEvent;
        try {
          event = parseRuntimeEvent(detail);
        } catch (error: unknown) {
          void forceRecovery();
          listener.onMalformedValue(new RuntimeBridgeProtocolError("event", error));
          return;
        }
        listener.onEvent(event);
      });
      const unsubscribeLifecycle = transport.on(
        runtimeTransportLifecycleEventName,
        (detail) => {
          let lifecycle: RuntimeTransportLifecycle;
          try {
            lifecycle = parseRuntimeTransportLifecycle(detail);
          } catch (error: unknown) {
            void forceRecovery();
            listener.onMalformedValue(
              new RuntimeBridgeProtocolError("transportLifecycle", error),
            );
            return;
          }
          if (lifecycle.generation > observedTransportGeneration) {
            observedTransportGeneration = lifecycle.generation;
          }
          listener.onTransportLifecycle(lifecycle);
        },
      );
      return () => {
        unsubscribeLifecycle();
        unsubscribeRuntime();
      };
    },
  };
}

export function detectRuntimeBridge(): RuntimeBridge | null {
  if (typeof window === "undefined" || !("zero" in window)) return null;
  return createRuntimeBridge(window.zero);
}
