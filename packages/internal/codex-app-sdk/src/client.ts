import type { ExternalStore } from "./store.js";
import type {
  OperationInput,
  OperationName,
  OperationOutput,
  OperationReconciliation,
  OperationRegistry,
  ReconciliationOperationName,
} from "./operations.js";

declare const attemptIdBrand: unique symbol;

const MAX_ATTEMPT_ID_LENGTH = 200;
const ATTEMPT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u;

export type AttemptId = string & {
  readonly [attemptIdBrand]: "AttemptId";
};

export function isAttemptId(value: string): value is AttemptId {
  return (
    value.length > 0 &&
    value.length <= MAX_ATTEMPT_ID_LENGTH &&
    ATTEMPT_ID_PATTERN.test(value)
  );
}

export function createAttemptId(value: string): AttemptId {
  if (!isAttemptId(value)) {
    throw new RangeError(
      `attempt ID must contain 1 to ${String(MAX_ATTEMPT_ID_LENGTH)} portable identifier characters`,
    );
  }
  return value;
}

export type CodexIntent<
  Registry extends OperationRegistry,
  Name extends OperationName<Registry>,
> = Name extends OperationName<Registry>
  ? Readonly<{
      type: Name;
      attemptId: AttemptId;
      input: OperationInput<Registry[Name]>;
    }>
  : never;

export type AnyCodexIntent<Registry extends OperationRegistry> = {
  [Name in OperationName<Registry>]: CodexIntent<Registry, Name>;
}[OperationName<Registry>];

export interface CodexReconciliationRequest<
  Registry extends OperationRegistry,
  Name extends ReconciliationOperationName<Registry>,
> {
  readonly operation: Name;
  readonly attemptId: AttemptId;
}

export type ErrorMetadataValue = string | number | boolean | null;

export interface CodexAppError {
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
  readonly metadata?: Readonly<Record<string, ErrorMetadataValue>>;
}

export type ReconciliationStrategy = OperationReconciliation;

export interface ReconciliationHint {
  readonly operation: string;
  readonly strategy: ReconciliationStrategy;
  readonly reason:
    | "lost-response"
    | "interrupted"
    | "driver-contract-violation"
    | "reconciliation-failed";
}

export interface ConfirmedOutcome<Result> {
  readonly status: "confirmed";
  readonly attemptId: AttemptId;
  readonly value: Result;
}

export interface AmbiguousOutcome {
  readonly status: "ambiguous";
  readonly attemptId: AttemptId;
  readonly reconciliation: ReconciliationHint;
}

export interface RejectedOutcome {
  readonly status: "rejected";
  readonly attemptId: AttemptId;
  readonly error: CodexAppError;
}

export interface CancelledOutcome {
  readonly status: "cancelled";
  readonly attemptId: AttemptId;
  readonly reason: "caller" | "client-closing" | "superseded";
}

export type DispatchOutcome<Result> =
  | ConfirmedOutcome<Result>
  | AmbiguousOutcome
  | RejectedOutcome
  | CancelledOutcome;

export interface ClientCallOptions {
  readonly signal?: AbortSignal;
}

export interface ClientFailure {
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
}

export type ClientLifecycleSnapshot =
  | Readonly<{ status: "idle"; generation: number }>
  | Readonly<{ status: "starting"; generation: number }>
  | Readonly<{ status: "running"; generation: number }>
  | Readonly<{ status: "closing"; generation: number }>
  | Readonly<{
      status: "failed";
      generation: number;
      phase: "start";
      failure: ClientFailure;
    }>
  | Readonly<{
      status: "closed";
      generation: number;
      failure: ClientFailure | null;
    }>;

export interface CodexAppClient<
  Snapshot,
  Registry extends OperationRegistry,
> {
  readonly store: ExternalStore<Snapshot>;
  readonly lifecycle: ExternalStore<ClientLifecycleSnapshot>;
  readonly start: (options?: ClientCallOptions) => Promise<void>;
  readonly dispatch: <Name extends OperationName<Registry>>(
    intent: CodexIntent<Registry, Name>,
    options?: ClientCallOptions,
  ) => Promise<DispatchOutcome<OperationOutput<Registry[Name]>>>;
  readonly reconcile: <Name extends ReconciliationOperationName<Registry>>(
    request: CodexReconciliationRequest<Registry, Name>,
    options?: ClientCallOptions,
  ) => Promise<DispatchOutcome<OperationOutput<Registry[Name]>>>;
  readonly close: () => Promise<void>;
}

export function confirmed<Result>(
  attemptId: AttemptId,
  value: Result,
): ConfirmedOutcome<Result> {
  return Object.freeze({ status: "confirmed", attemptId, value });
}

export function ambiguous(
  attemptId: AttemptId,
  reconciliation: ReconciliationHint,
): AmbiguousOutcome {
  return Object.freeze({
    status: "ambiguous",
    attemptId,
    reconciliation: Object.freeze({
      ...reconciliation,
      strategy: Object.freeze({ ...reconciliation.strategy }),
    }),
  });
}

export function rejected(
  attemptId: AttemptId,
  error: CodexAppError,
): RejectedOutcome {
  return Object.freeze({
    status: "rejected",
    attemptId,
    error: Object.freeze({
      ...error,
      metadata: Object.freeze({ ...(error.metadata ?? {}) }),
    }),
  });
}

export function cancelled(
  attemptId: AttemptId,
  reason: CancelledOutcome["reason"],
): CancelledOutcome {
  return Object.freeze({ status: "cancelled", attemptId, reason });
}
