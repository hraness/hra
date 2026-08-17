import {
  ambiguous,
  cancelled,
  confirmed,
  isAttemptId,
  rejected,
  type AttemptId,
  type ClientCallOptions,
  type ClientFailure,
  type ClientLifecycleSnapshot,
  type CodexAppClient,
  type CodexIntent,
  type CodexReconciliationRequest,
  type DispatchOutcome,
} from "./client.js";
import { createGenerationFence } from "./lifecycle.js";
import type {
  OperationDescriptor,
  OperationName,
  OperationOutput,
  OperationRegistry,
  ReconciliationOperationName,
} from "./operations.js";
import { snapshotOperationRegistry } from "./operations.js";
import {
  createReducerStore,
  type ExternalStore,
} from "./store.js";

export interface ClientDriverContext {
  readonly generation: number;
  readonly signal: AbortSignal;
}

export interface ClientDriverCloseContext {
  readonly generation: number;
}

/**
 * A driver owns the provider adapter and prepare-before-effect journal writes.
 * Once dispatch begins, it must represent every expected result as an outcome.
 */
export interface CodexAppDriver<
  Snapshot,
  Registry extends OperationRegistry,
> {
  readonly store: ExternalStore<Snapshot>;
  readonly start: (context: ClientDriverContext) => Promise<void>;
  readonly dispatch: <Name extends OperationName<Registry>>(
    intent: CodexIntent<Registry, Name>,
    context: ClientDriverContext,
  ) => Promise<DispatchOutcome<OperationOutput<Registry[Name]>>>;
  readonly reconcile: <Name extends ReconciliationOperationName<Registry>>(
    request: CodexReconciliationRequest<Registry, Name>,
    context: ClientDriverContext,
  ) => Promise<DispatchOutcome<OperationOutput<Registry[Name]>>>;
  readonly close: (context: ClientDriverCloseContext) => Promise<void>;
}

export interface ClientHostOptions {
  readonly initialGeneration?: number;
  readonly describeLifecycleFailure?: (
    error: unknown,
    phase: "start" | "close",
  ) => ClientFailure;
}

export class ClientHostLifecycleError extends Error {
  readonly failure: ClientFailure;

  constructor(failure: ClientFailure) {
    super(failure.message);
    this.name = "ClientHostLifecycleError";
    this.failure = failure;
  }
}

interface CombinedSignal {
  readonly signal: AbortSignal;
  readonly cancellationReason: () =>
    | "caller"
    | "client-closing"
    | null;
  readonly dispose: () => void;
}

interface Deferred<Value> {
  readonly promise: Promise<Value>;
  readonly resolve: (value: Value | PromiseLike<Value>) => void;
  readonly reject: (error: unknown) => void;
}

function createDeferred<Value>(): Deferred<Value> {
  let resolve!: (value: Value | PromiseLike<Value>) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<Value>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return Object.freeze({ promise, resolve, reject });
}

function combineSignals(
  hostSignal: AbortSignal,
  callerSignal: AbortSignal | undefined,
): CombinedSignal {
  if (callerSignal === undefined) {
    return Object.freeze({
      signal: hostSignal,
      cancellationReason: () =>
        hostSignal.aborted ? "client-closing" : null,
      dispose: () => undefined,
    });
  }

  const controller = new AbortController();
  let cancellationReason: "caller" | "client-closing" | null = null;
  const abort = (reason: "caller" | "client-closing"): void => {
    if (cancellationReason === null) cancellationReason = reason;
    controller.abort();
  };
  const abortForHost = (): void => abort("client-closing");
  const abortForCaller = (): void => abort("caller");
  if (hostSignal.aborted || callerSignal.aborted) {
    abort(hostSignal.aborted ? "client-closing" : "caller");
    return Object.freeze({
      signal: controller.signal,
      cancellationReason: () => cancellationReason,
      dispose: () => undefined,
    });
  }

  hostSignal.addEventListener("abort", abortForHost, { once: true });
  callerSignal.addEventListener("abort", abortForCaller, { once: true });
  const dispose = (): void => {
    hostSignal.removeEventListener("abort", abortForHost);
    callerSignal.removeEventListener("abort", abortForCaller);
  };
  return Object.freeze({
    signal: controller.signal,
    cancellationReason: () => cancellationReason,
    dispose,
  });
}

function defaultLifecycleFailure(
  phase: "start" | "close",
): ClientFailure {
  return Object.freeze({
    code: phase === "start" ? "driver_start_failed" : "driver_close_failed",
    message:
      phase === "start"
        ? "The client driver failed to start."
        : "The client driver failed to close cleanly.",
    retryable: phase === "start",
  });
}

function startCancelledFailure(): ClientFailure {
  return Object.freeze({
    code: "start_cancelled",
    message: "Client start was cancelled before it completed.",
    retryable: true,
  });
}

function safeLifecycleFailure(
  error: unknown,
  phase: "start" | "close",
  describe: ClientHostOptions["describeLifecycleFailure"],
): ClientFailure {
  if (describe === undefined) return defaultLifecycleFailure(phase);
  try {
    const failure = describe(error, phase);
    return Object.freeze({ ...failure });
  } catch {
    return defaultLifecycleFailure(phase);
  }
}

function lifecycleSnapshot(
  snapshot: ClientLifecycleSnapshot,
): ClientLifecycleSnapshot {
  return Object.freeze(snapshot);
}

function notRunningOutcome<Result>(
  attemptId: AttemptId,
  status: ClientLifecycleSnapshot["status"],
): DispatchOutcome<Result> {
  return rejected(attemptId, {
    code: "client_not_running",
    message: "Start the client before sending a command.",
    retryable: status !== "closed" && status !== "closing",
    metadata: { lifecycleStatus: status },
  });
}

type RuntimeOperationDescriptor = OperationDescriptor<
  string,
  unknown,
  unknown
>;

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value)
  ) {
    return false;
  }
  const prototype = Reflect.getPrototypeOf(value);
  return prototype === null || prototype === Object.prototype;
}

interface RuntimeCommandEnvelope {
  readonly attemptId: AttemptId;
  readonly operation: unknown;
}

type OwnDataProperty =
  | Readonly<{ kind: "data"; value: unknown }>
  | Readonly<{ kind: "missing" }>
  | Readonly<{ kind: "accessor" }>;

function ownDataProperty(
  value: Readonly<Record<string, unknown>>,
  key: string,
): OwnDataProperty {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (descriptor === undefined) {
    return Object.freeze({ kind: "missing" });
  }
  if (!("value" in descriptor)) {
    return Object.freeze({ kind: "accessor" });
  }
  return Object.freeze({
    kind: "data",
    value: descriptor.value as unknown,
  });
}

function commandEnvelope(
  value: unknown,
  operationKey: "type" | "operation",
): RuntimeCommandEnvelope | null {
  if (!isRecord(value)) return null;
  const attemptProperty = ownDataProperty(value, "attemptId");
  if (
    attemptProperty.kind !== "data" ||
    typeof attemptProperty.value !== "string" ||
    !isAttemptId(attemptProperty.value)
  ) {
    return null;
  }
  const operationProperty = ownDataProperty(value, operationKey);
  if (operationProperty.kind !== "data") return null;
  return Object.freeze({
    attemptId: attemptProperty.value,
    operation: operationProperty.value,
  });
}

function invalidCommandEnvelope(): Promise<never> {
  return Promise.reject(
    new TypeError(
      "command envelopes require an own portable attempt ID and operation field",
    ),
  );
}

function runtimeOperation(
  operations: OperationRegistry,
  operation: unknown,
): RuntimeOperationDescriptor | null {
  if (
    typeof operation !== "string" ||
    !Object.prototype.hasOwnProperty.call(operations, operation)
  ) {
    return null;
  }
  return operations[operation] ?? null;
}

function canReconcile(descriptor: RuntimeOperationDescriptor): boolean {
  return (
    descriptor.semantics.effect === "non-idempotent-mutation" &&
    descriptor.semantics.reconciliation.kind !== "unsupported"
  );
}

function invalidOperationOutcome<Result>(
  attemptId: AttemptId,
  code: "unknown_operation" | "operation_reconciliation_unavailable",
): DispatchOutcome<Result> {
  return rejected(attemptId, {
    code,
    message:
      code === "unknown_operation"
        ? "The operation is not declared by this client."
        : "The operation does not support client reconciliation.",
    retryable: false,
  });
}

function driverFailureOutcome<Result>(
  attemptId: AttemptId,
  descriptor: RuntimeOperationDescriptor,
  reason:
    | "driver-contract-violation"
    | "reconciliation-failed",
): DispatchOutcome<Result> {
  if (descriptor.semantics.lostResponse === "safe-to-retry") {
    return rejected(attemptId, {
      code: "driver_contract_violation",
      message:
        "The operation driver failed without a confirmed response. Retrying this operation is safe.",
      retryable: true,
      metadata: {
        operation: descriptor.name,
        effect: descriptor.semantics.effect,
        lostResponse: descriptor.semantics.lostResponse,
      },
    });
  }

  return ambiguous(attemptId, {
    operation: descriptor.name,
    strategy: descriptor.semantics.reconciliation,
    reason,
  });
}

function normalizeMetadata(
  value: unknown,
): Readonly<Record<string, string | number | boolean | null>> | null {
  if (!isRecord(value)) return null;
  const entries: [string, string | number | boolean | null][] = [];
  for (const key of Object.keys(value)) {
    const property = ownDataProperty(value, key);
    if (property.kind !== "data") return null;
    const entry = property.value;
    if (
      entry !== null &&
      typeof entry !== "string" &&
      typeof entry !== "boolean" &&
      (typeof entry !== "number" || !Number.isFinite(entry))
    ) {
      return null;
    }
    entries.push([key, entry]);
  }
  return Object.freeze(Object.fromEntries(entries));
}

function normalizeDriverOutcome<Result>(
  outcome: unknown,
  attemptId: AttemptId,
  descriptor: RuntimeOperationDescriptor,
  cancellationReason: "caller" | "client-closing" | null,
): DispatchOutcome<Result> | null {
  if (!isRecord(outcome)) return null;
  const statusProperty = ownDataProperty(outcome, "status");
  const attemptProperty = ownDataProperty(outcome, "attemptId");
  if (
    statusProperty.kind !== "data" ||
    attemptProperty.kind !== "data" ||
    attemptProperty.value !== attemptId
  ) {
    return null;
  }

  switch (statusProperty.value) {
    case "confirmed": {
      const valueProperty = ownDataProperty(outcome, "value");
      return valueProperty.kind === "data"
        ? confirmed(attemptId, valueProperty.value as Result)
        : null;
    }
    case "cancelled": {
      const reasonProperty = ownDataProperty(outcome, "reason");
      if (
        reasonProperty.kind !== "data" ||
        (reasonProperty.value !== "caller" &&
          reasonProperty.value !== "client-closing" &&
          reasonProperty.value !== "superseded")
      ) {
        return null;
      }
      if (cancellationReason !== null) {
        return cancelled(attemptId, cancellationReason);
      }
      return reasonProperty.value === "superseded"
        ? cancelled(attemptId, "superseded")
        : null;
    }
    case "rejected": {
      const errorProperty = ownDataProperty(outcome, "error");
      if (errorProperty.kind !== "data") return null;
      const error = errorProperty.value;
      if (!isRecord(error)) return null;
      const codeProperty = ownDataProperty(error, "code");
      const messageProperty = ownDataProperty(error, "message");
      const retryableProperty = ownDataProperty(error, "retryable");
      const metadataProperty = ownDataProperty(error, "metadata");
      if (
        codeProperty.kind !== "data" ||
        messageProperty.kind !== "data" ||
        retryableProperty.kind !== "data" ||
        typeof codeProperty.value !== "string" ||
        typeof messageProperty.value !== "string" ||
        typeof retryableProperty.value !== "boolean" ||
        metadataProperty.kind === "accessor"
      ) {
        return null;
      }
      let metadata:
        | Readonly<Record<string, string | number | boolean | null>>
        | undefined;
      if (
        metadataProperty.kind === "data" &&
        metadataProperty.value !== undefined
      ) {
        const normalized = normalizeMetadata(metadataProperty.value);
        if (normalized === null) return null;
        metadata = normalized;
      }
      return rejected(attemptId, {
        code: codeProperty.value,
        message: messageProperty.value,
        retryable: retryableProperty.value,
        ...(metadata === undefined ? {} : { metadata }),
      });
    }
    case "ambiguous": {
      if (descriptor.semantics.lostResponse !== "ambiguous") return null;
      const reconciliationProperty = ownDataProperty(
        outcome,
        "reconciliation",
      );
      if (reconciliationProperty.kind !== "data") return null;
      const reconciliation = reconciliationProperty.value;
      if (!isRecord(reconciliation)) return null;
      const operationProperty = ownDataProperty(
        reconciliation,
        "operation",
      );
      const reasonProperty = ownDataProperty(reconciliation, "reason");
      const strategyProperty = ownDataProperty(
        reconciliation,
        "strategy",
      );
      if (
        operationProperty.kind !== "data" ||
        reasonProperty.kind !== "data" ||
        strategyProperty.kind !== "data" ||
        operationProperty.value !== descriptor.name ||
        (reasonProperty.value !== "lost-response" &&
          reasonProperty.value !== "interrupted" &&
          reasonProperty.value !== "driver-contract-violation" &&
          reasonProperty.value !== "reconciliation-failed") ||
        !isRecord(strategyProperty.value)
      ) {
        return null;
      }
      const kindProperty = ownDataProperty(
        strategyProperty.value,
        "kind",
      );
      const strategyNameProperty = ownDataProperty(
        strategyProperty.value,
        "strategy",
      );
      if (
        kindProperty.kind !== "data" ||
        strategyNameProperty.kind !== "data" ||
        kindProperty.value !== descriptor.semantics.reconciliation.kind ||
        strategyNameProperty.value !==
          descriptor.semantics.reconciliation.strategy
      ) {
        return null;
      }
      return ambiguous(attemptId, {
        operation: descriptor.name,
        strategy: descriptor.semantics.reconciliation,
        reason: reasonProperty.value,
      });
    }
    default:
      return null;
  }
}

export function createCodexAppClientHost<
  Snapshot,
  Registry extends OperationRegistry,
>(
  operations: Registry,
  driver: CodexAppDriver<Snapshot, Registry>,
  options: ClientHostOptions = {},
): CodexAppClient<Snapshot, Registry> {
  const runtimeOperations = snapshotOperationRegistry(operations);
  const fence = createGenerationFence(options.initialGeneration ?? 0);
  const lifecycleStore = createReducerStore<
    ClientLifecycleSnapshot,
    ClientLifecycleSnapshot
  >(
    lifecycleSnapshot({ status: "idle", generation: fence.current() }),
    (_snapshot, next) => next,
  );
  const inFlight = new Set<Promise<DispatchOutcome<unknown>>>();

  let startPromise: Promise<void> | null = null;
  let startToken: object | null = null;
  let closePromise: Promise<void> | null = null;
  let sessionController: AbortController | null = null;
  let closingRequested = false;

  const installLifecycle = (snapshot: ClientLifecycleSnapshot): void => {
    lifecycleStore.dispatch(lifecycleSnapshot(snapshot));
  };

  const runStart = async (
    token: object,
    generation: number,
    combined: CombinedSignal,
  ): Promise<void> => {
    try {
      if (combined.signal.aborted || closingRequested) {
        const failure = startCancelledFailure();
        const current = lifecycleStore.getSnapshot();
        if (
          current.status === "starting" &&
          current.generation === generation &&
          !closingRequested
        ) {
          sessionController?.abort();
          installLifecycle({
            status: "failed",
            generation,
            phase: "start",
            failure,
          });
        }
        throw new ClientHostLifecycleError(failure);
      }
      try {
        await driver.start({ generation, signal: combined.signal });
      } catch (error) {
        const current = lifecycleStore.getSnapshot();
        const failure =
          error instanceof ClientHostLifecycleError ||
          combined.signal.aborted ||
          closingRequested ||
          current.status !== "starting" ||
          current.generation !== generation
            ? startCancelledFailure()
            : safeLifecycleFailure(
                error,
                "start",
                options.describeLifecycleFailure,
              );
        if (
          current.status === "starting" &&
          current.generation === generation &&
          !closingRequested
        ) {
          sessionController?.abort();
          installLifecycle({
            status: "failed",
            generation,
            phase: "start",
            failure,
          });
        }
        throw new ClientHostLifecycleError(failure);
      }

      const current = lifecycleStore.getSnapshot();
      if (
        combined.signal.aborted ||
        closingRequested ||
        current.status !== "starting" ||
        current.generation !== generation
      ) {
        const failure = startCancelledFailure();
        if (
          current.status === "starting" &&
          current.generation === generation &&
          !closingRequested
        ) {
          sessionController?.abort();
          installLifecycle({
            status: "failed",
            generation,
            phase: "start",
            failure,
          });
        }
        throw new ClientHostLifecycleError(failure);
      }
      installLifecycle({ status: "running", generation });
    } finally {
      combined.dispose();
      if (startToken === token) {
        startToken = null;
        startPromise = null;
      }
    }
  };

  const start = (callOptions: ClientCallOptions = {}): Promise<void> => {
    const current = lifecycleStore.getSnapshot();
    if (current.status === "running") return Promise.resolve();
    if (current.status === "starting" && startPromise !== null) {
      return startPromise;
    }
    if (current.status === "failed") {
      return Promise.reject(new ClientHostLifecycleError(current.failure));
    }
    if (closingRequested || current.status === "closing" || current.status === "closed") {
      return Promise.reject(
        new ClientHostLifecycleError({
          code: "client_closed",
          message: "A closed client cannot be started.",
          retryable: false,
        }),
      );
    }
    if (callOptions.signal?.aborted === true) {
      return Promise.reject(
        new ClientHostLifecycleError({
          code: "start_cancelled",
          message: "Client start was cancelled before it began.",
          retryable: true,
        }),
      );
    }

    const generation = fence.advance();
    sessionController = new AbortController();
    const combined = combineSignals(
      sessionController.signal,
      callOptions.signal,
    );
    const token = {};
    const deferred = createDeferred<void>();
    startToken = token;
    startPromise = deferred.promise;
    installLifecycle({ status: "starting", generation });
    void runStart(token, generation, combined).then(
      deferred.resolve,
      deferred.reject,
    );
    return deferred.promise;
  };

  const beginCommand = <Result>(
    attemptId: AttemptId,
    descriptor: RuntimeOperationDescriptor,
    callOptions: ClientCallOptions,
    invoke: (context: ClientDriverContext) => Promise<DispatchOutcome<Result>>,
    thrownReason:
      | "driver-contract-violation"
      | "reconciliation-failed",
  ): Promise<DispatchOutcome<Result>> => {
    const lifecycle = lifecycleStore.getSnapshot();
    if (
      closingRequested ||
      lifecycle.status === "closing" ||
      lifecycle.status === "closed"
    ) {
      return Promise.resolve(cancelled(attemptId, "client-closing"));
    }
    if (callOptions.signal?.aborted === true) {
      return Promise.resolve(cancelled(attemptId, "caller"));
    }
    if (lifecycle.status !== "running" || sessionController === null) {
      return Promise.resolve(
        notRunningOutcome<Result>(attemptId, lifecycle.status),
      );
    }

    const combined = combineSignals(
      sessionController.signal,
      callOptions.signal,
    );
    if (combined.signal.aborted) {
      combined.dispose();
      return Promise.resolve(
        cancelled(
          attemptId,
          closingRequested ? "client-closing" : "caller",
        ),
      );
    }

    const run = async (): Promise<DispatchOutcome<Result>> => {
      try {
        const outcome = await invoke({
          generation: lifecycle.generation,
          signal: combined.signal,
        });
        const normalized = normalizeDriverOutcome<Result>(
          outcome,
          attemptId,
          descriptor,
          combined.cancellationReason(),
        );
        if (normalized === null) {
          return driverFailureOutcome(
            attemptId,
            descriptor,
            "driver-contract-violation",
          );
        }
        return normalized;
      } catch {
        return driverFailureOutcome(attemptId, descriptor, thrownReason);
      } finally {
        combined.dispose();
      }
    };

    const deferred = createDeferred<DispatchOutcome<Result>>();
    const pending = deferred.promise;
    inFlight.add(pending);
    void pending.then(
      () => {
        inFlight.delete(pending);
      },
      () => {
        inFlight.delete(pending);
      },
    );
    void run().then(deferred.resolve, deferred.reject);
    return pending;
  };

  const dispatch = <Name extends OperationName<Registry>>(
    intent: CodexIntent<Registry, Name>,
    callOptions: ClientCallOptions = {},
  ): Promise<DispatchOutcome<OperationOutput<Registry[Name]>>> => {
    const envelope = commandEnvelope(intent, "type");
    if (envelope === null) return invalidCommandEnvelope();
    const descriptor = runtimeOperation(
      runtimeOperations,
      envelope.operation,
    );
    if (descriptor === null) {
      return Promise.resolve(
        invalidOperationOutcome(envelope.attemptId, "unknown_operation"),
      );
    }
    return beginCommand<OperationOutput<Registry[Name]>>(
      envelope.attemptId,
      descriptor,
      callOptions,
      (context) => driver.dispatch(intent, context),
      "driver-contract-violation",
    );
  };

  const reconcile = <Name extends ReconciliationOperationName<Registry>>(
    request: CodexReconciliationRequest<Registry, Name>,
    callOptions: ClientCallOptions = {},
  ): Promise<DispatchOutcome<OperationOutput<Registry[Name]>>> => {
    const envelope = commandEnvelope(request, "operation");
    if (envelope === null) return invalidCommandEnvelope();
    const descriptor = runtimeOperation(
      runtimeOperations,
      envelope.operation,
    );
    if (descriptor === null) {
      return Promise.resolve(
        invalidOperationOutcome(envelope.attemptId, "unknown_operation"),
      );
    }
    if (!canReconcile(descriptor)) {
      return Promise.resolve(
        invalidOperationOutcome(
          envelope.attemptId,
          "operation_reconciliation_unavailable",
        ),
      );
    }
    return beginCommand<OperationOutput<Registry[Name]>>(
      envelope.attemptId,
      descriptor,
      callOptions,
      (context) => driver.reconcile(request, context),
      "reconciliation-failed",
    );
  };

  const runClose = async (
    generation: number,
    pendingStart: Promise<void> | null,
    pendingCommands: readonly Promise<DispatchOutcome<unknown>>[],
  ): Promise<void> => {
    if (pendingStart !== null) {
      await Promise.allSettled([pendingStart]);
    }

    let failure: ClientFailure | null = null;
    try {
      await driver.close({ generation });
    } catch (error) {
      failure = safeLifecycleFailure(
        error,
        "close",
        options.describeLifecycleFailure,
      );
    }

    await Promise.allSettled(pendingCommands);
    sessionController = null;
    installLifecycle({ status: "closed", generation, failure });
    if (failure !== null) throw new ClientHostLifecycleError(failure);
  };

  const close = (): Promise<void> => {
    if (closePromise !== null) return closePromise;
    const current = lifecycleStore.getSnapshot();
    if (current.status === "closed") return Promise.resolve();

    const generation = current.generation;
    const pendingStart = startPromise;
    const pendingCommands = [...inFlight];
    const deferred = createDeferred<void>();
    closePromise = deferred.promise;
    closingRequested = true;
    sessionController?.abort();
    installLifecycle({ status: "closing", generation });
    void runClose(generation, pendingStart, pendingCommands).then(
      deferred.resolve,
      deferred.reject,
    );
    return deferred.promise;
  };

  return Object.freeze({
    store: driver.store,
    lifecycle: lifecycleStore,
    start,
    dispatch,
    reconcile,
    close,
  });
}
