import {
  cancelled,
  type AttemptId,
  type CodexIntent,
  type CodexReconciliationRequest,
  type DispatchOutcome,
} from "../client.js";
import type {
  ClientDriverCloseContext,
  ClientDriverContext,
  CodexAppDriver,
} from "../client-host.js";
import type {
  OperationName,
  OperationOutput,
  OperationRegistry,
  ReconciliationOperationName,
} from "../operations.js";
import { createReducerStore } from "../store.js";

export type ScriptedDriverStep<
  Snapshot,
  Registry extends OperationRegistry,
> =
  | {
      [Name in OperationName<Registry>]: Readonly<{
        call: "dispatch";
        expectedType: Name;
        outcome: DispatchOutcome<OperationOutput<Registry[Name]>>;
        snapshot?: Snapshot;
      }>;
    }[OperationName<Registry>]
  | {
      [Name in ReconciliationOperationName<Registry>]: Readonly<{
        call: "reconcile";
        expectedOperation: Name;
        expectedAttemptId: AttemptId;
        outcome: DispatchOutcome<OperationOutput<Registry[Name]>>;
        snapshot?: Snapshot;
      }>;
    }[ReconciliationOperationName<Registry>];

export type ScriptedDriverCall =
  | Readonly<{ call: "start"; generation: number }>
  | Readonly<{
      call: "dispatch";
      generation: number;
      attemptId: AttemptId;
      type: string;
    }>
  | Readonly<{
      call: "reconcile";
      generation: number;
      attemptId: AttemptId;
      operation: string;
    }>
  | Readonly<{ call: "close"; generation: number }>;

export interface ScriptedDriverOptions<
  Snapshot,
  Registry extends OperationRegistry,
> {
  readonly initialSnapshot: Snapshot;
  readonly steps: readonly ScriptedDriverStep<Snapshot, Registry>[];
  readonly startFailure?: Error;
  readonly closeFailure?: Error;
}

export interface ScriptedCodexAppDriver<
  Snapshot,
  Registry extends OperationRegistry,
> extends CodexAppDriver<Snapshot, Registry> {
  readonly calls: () => readonly ScriptedDriverCall[];
  readonly remainingSteps: () => number;
}

function applySnapshot<Snapshot, Registry extends OperationRegistry>(
  step: ScriptedDriverStep<Snapshot, Registry>,
  install: (snapshot: Snapshot) => void,
): void {
  if (step.snapshot !== undefined) install(step.snapshot);
}

export function createScriptedCodexAppDriver<
  Snapshot,
  Registry extends OperationRegistry,
>(
  options: ScriptedDriverOptions<Snapshot, Registry>,
): ScriptedCodexAppDriver<Snapshot, Registry> {
  const store = createReducerStore<Snapshot, Snapshot>(
    options.initialSnapshot,
    (_snapshot, next) => next,
  );
  const steps = [...options.steps];
  const recordedCalls: ScriptedDriverCall[] = [];
  let started = false;
  let closed = false;

  const record = (call: ScriptedDriverCall): void => {
    recordedCalls.push(Object.freeze(call));
  };

  const assertAvailable = (): void => {
    if (!started || closed) {
      throw new Error("scripted driver is not running");
    }
  };

  const takeStep = (): ScriptedDriverStep<Snapshot, Registry> => {
    const step = steps.shift();
    if (step === undefined) {
      throw new Error("scripted driver received an unexpected call");
    }
    return step;
  };

  const start = (context: ClientDriverContext): Promise<void> => {
    record({ call: "start", generation: context.generation });
    if (context.signal.aborted) {
      return Promise.reject(new Error("scripted start was cancelled"));
    }
    if (options.startFailure !== undefined) {
      return Promise.reject(options.startFailure);
    }
    started = true;
    return Promise.resolve();
  };

  const dispatch = <Name extends OperationName<Registry>>(
    intent: CodexIntent<Registry, Name>,
    context: ClientDriverContext,
  ): Promise<DispatchOutcome<OperationOutput<Registry[Name]>>> => {
    assertAvailable();
    record({
      call: "dispatch",
      generation: context.generation,
      attemptId: intent.attemptId,
      type: intent.type,
    });
    if (context.signal.aborted) {
      return Promise.resolve(cancelled(intent.attemptId, "client-closing"));
    }
    const step = takeStep();
    if (step.call !== "dispatch" || step.expectedType !== intent.type) {
      throw new Error("scripted dispatch did not match the next step");
    }
    applySnapshot(step, (snapshot) => {
      store.dispatch(snapshot);
    });
    return Promise.resolve(
      step.outcome as DispatchOutcome<OperationOutput<Registry[Name]>>,
    );
  };

  const reconcile = <Name extends ReconciliationOperationName<Registry>>(
    request: CodexReconciliationRequest<Registry, Name>,
    context: ClientDriverContext,
  ): Promise<DispatchOutcome<OperationOutput<Registry[Name]>>> => {
    assertAvailable();
    record({
      call: "reconcile",
      generation: context.generation,
      attemptId: request.attemptId,
      operation: request.operation,
    });
    if (context.signal.aborted) {
      return Promise.resolve(cancelled(request.attemptId, "client-closing"));
    }
    const step = takeStep();
    if (
      step.call !== "reconcile" ||
      step.expectedOperation !== request.operation ||
      step.expectedAttemptId !== request.attemptId
    ) {
      throw new Error("scripted reconciliation did not match the next step");
    }
    applySnapshot(step, (snapshot) => {
      store.dispatch(snapshot);
    });
    return Promise.resolve(
      step.outcome as DispatchOutcome<OperationOutput<Registry[Name]>>,
    );
  };

  const close = (context: ClientDriverCloseContext): Promise<void> => {
    record({ call: "close", generation: context.generation });
    closed = true;
    if (options.closeFailure !== undefined) {
      return Promise.reject(options.closeFailure);
    }
    return Promise.resolve();
  };

  return Object.freeze({
    store,
    start,
    dispatch,
    reconcile,
    close,
    calls: () => Object.freeze([...recordedCalls]),
    remainingSteps: () => steps.length,
  });
}
