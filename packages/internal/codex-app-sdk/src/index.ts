import {
  ClientHostLifecycleError,
  createCodexAppClientHost,
} from "./client-host.js";
import {
  ambiguous,
  cancelled,
  confirmed,
  createAttemptId,
  isAttemptId,
  rejected,
} from "./client.js";
import {
  compareSourceCoordinates,
  createSourceCoordinate,
  isSourceCoordinateCurrent,
} from "./coordinates.js";
import {
  GenerationStoreContractError,
  assertGeneration,
  createGenerationFence,
  reserveMonotonicGeneration,
} from "./lifecycle.js";
import {
  createMutationFingerprint,
  isMutationFingerprint,
} from "./persistence.js";
import {
  MAX_OPERATION_TIMEOUT_MS,
  MIN_OPERATION_TIMEOUT_MS,
  defineOperation,
  defineOperationRegistry,
} from "./operations.js";
import { createReducerStore } from "./store.js";

export {
  ClientHostLifecycleError,
  GenerationStoreContractError,
  MAX_OPERATION_TIMEOUT_MS,
  MIN_OPERATION_TIMEOUT_MS,
  ambiguous,
  assertGeneration,
  cancelled,
  compareSourceCoordinates,
  confirmed,
  createAttemptId,
  createCodexAppClientHost,
  createGenerationFence,
  createMutationFingerprint,
  createReducerStore,
  createSourceCoordinate,
  defineOperation,
  defineOperationRegistry,
  isAttemptId,
  isMutationFingerprint,
  isSourceCoordinateCurrent,
  rejected,
  reserveMonotonicGeneration,
};

export type {
  ClientDriverCloseContext,
  ClientDriverContext,
  ClientHostOptions,
  CodexAppDriver,
} from "./client-host.js";

export type {
  AmbiguousOutcome,
  AnyCodexIntent,
  AttemptId,
  CancelledOutcome,
  ClientCallOptions,
  ClientFailure,
  ClientLifecycleSnapshot,
  CodexAppClient,
  CodexAppError,
  CodexIntent,
  CodexReconciliationRequest,
  ConfirmedOutcome,
  DispatchOutcome,
  ErrorMetadataValue,
  ReconciliationHint,
  ReconciliationStrategy,
  RejectedOutcome,
} from "./client.js";

export type {
  SourceCoordinate,
  SourceCoordinateRelation,
} from "./coordinates.js";

export type { GenerationFence } from "./lifecycle.js";

export type {
  AutomaticOperationReconciliation,
  DefinedOperationRegistry,
  IdempotentMutationOperationSemantics,
  ManualOperationReconciliation,
  NonIdempotentMutationOperationSemantics,
  OperationConcurrency,
  OperationDefinition,
  OperationDescriptor,
  OperationDescriptorSemantics,
  OperationInput,
  OperationName,
  OperationOutput,
  OperationReconciliation,
  OperationRegistry,
  OperationSemantics,
  ReadOperationSemantics,
  ReconcilableOperationReconciliation,
  ReconcilableOperationSemantics,
  ReconciliationOperationName,
  UnsupportedOperationReconciliation,
} from "./operations.js";

export type {
  BindingStore,
  ChangeFeed,
  ChangeFeedEntry,
  ChangeFeedPage,
  ConditionalWriteResult,
  EffectStartedMutationAttempt,
  GenerationStore,
  MutationAttemptDefinition,
  MutationAttemptDraft,
  MutationAttemptCursor,
  MutationAttemptJournal,
  MutationAttemptRecord,
  MutationAttemptSettlement,
  MutationFingerprint,
  OpenMutationAttemptPage,
  OpenMutationAttempt,
  PrepareMutationAttemptResult,
  PreparedMutationAttempt,
  ProjectionCheckpoint,
  ProjectionCheckpointStore,
  SettledMutationAttempt,
  TransitionMutationAttemptResult,
  VersionedValue,
} from "./persistence.js";

export type {
  ExternalStore,
  ListenerFailure,
  ReducerStore,
  ReducerStoreOptions,
  StoreCommit,
  StoreListener,
  StoreReducer,
  Unsubscribe,
} from "./store.js";
