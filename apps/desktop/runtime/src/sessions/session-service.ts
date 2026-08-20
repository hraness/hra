import { mkdtemp, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { z } from "@hra-internal/schema";
import type {
  AccountSummary,
  ChatProviderSubagentsProjection,
  ChatServiceTier,
  RuntimeError,
} from "../../../contracts/runtime";
import type { ArchiveAdmissionHandle } from "../accounts/archive-admission-gate";
import type { ChatThreadBinding } from "../chat/types";
import type {
  GatewaySessionEvent,
  ProjectSummary,
  ThreadSummary,
  WorkspaceLaneSummary,
} from "../internal-contracts";
import type {
  CodexFact,
  CodexExpiredServerRequestFault,
  CodexSupervisorState,
  CodexStreamPosition,
  PinnedCodexRequestInput,
  PinnedCodexRequestOutput,
  PinnedCodexResponseAtPosition,
  CodexServerRequest,
  CodexServerResponse,
  PinnedCodexTurnScan,
  PinnedCodexTurn,
  PinnedCodexThread,
  ProductionExecutionPolicyProof,
  ProductionExecutionPolicyReceipt,
  ScheduleInterpreterExecutionPolicyProof,
  ScheduleInterpreterExecutionPolicyReceipt,
} from "../codex";
import {
  HRA_PRODUCTION_EXECUTION_POLICY,
  HRA_SCHEDULE_INTERPRETER_EXECUTION_POLICY,
  ProductionExecutionPolicyError,
  ScheduleInterpreterExecutionPolicyError,
  createCodexFactsAtPosition,
  isProductionApprovalRequestMethod,
  pinnedCodexTurnScanEvidenceDigest,
  pinnedCodexTurnScansHaveExactEvidence,
  projectCodexThreadResponseFacts,
  projectCodexTurnResponseFacts,
  scanPinnedCodexTurns,
  scheduleInterpreterThreadConfig,
  verifyProductionExecutionPolicyRequirements,
  verifyProductionThreadAdmission,
  verifyProductionTurnAdmission,
  verifyScheduleInterpreterExecutionPolicyRequirements,
  verifyScheduleInterpreterThreadAdmission,
  verifyScheduleInterpreterTurnAdmission,
  requireComputerUseAdmissionReceipt,
  verifyComputerUseServerStatus,
  withComputerUseDeveloperInstructions,
  withComputerUseThreadConfig,
  type ComputerUseAdmissionReceipt,
  type ComputerUseProvisioning,
} from "../codex";
import {
  MAX_SCHEDULED_CHAT_PROMPT_UTF8_BYTES,
  type RunInteractionRequest,
  type RunInteractionRequestPayload,
  type RunInteractionResponse,
} from "@hraness/agent-tasks-protocol";
import {
  isBoundedSessionDisplayText,
  projectSessionServerRequestActivity,
  type ParsedSessionTurnActivity,
  type SessionTurnActivityKind,
} from "./protocol";
import { projectSessionInteraction } from "./interaction-protocol";
import {
  SessionCommandExecutor,
  type SessionAccountRuntimePort,
} from "./command-executor";
import { SessionFactDispatchAdapter } from "./fact-dispatch-adapter";
import {
  SessionHydrationCoordinator,
  type SessionHydrationRunResult,
} from "./hydration-coordinator";
import { planSessionHydrationTargets } from "./hydration-targets";
import { ownedCodexId } from "./identity";
import {
  SessionInteractionCoordinator,
  type SessionInteractionDeadlineScheduler,
  type SessionInteractionExpired,
  type SessionInteractionResolution,
} from "./interaction-coordinator";
import {
  sessionAccountKey,
  sessionEntityKey,
  type SessionState,
} from "./model";
import {
  SessionRegistry,
  type SessionThreadBinding,
  type SessionThreadObservationPreference,
} from "./session-registry";
import { createSessionSelectors } from "./selectors";
import { SessionStore, type SessionStoreListener } from "./store";
import {
  ReasoningSummaryAccumulator,
  type ReasoningSummaryCompletionReceipt,
} from "./reasoning-summary-accumulator";
import {
  ProviderSubagentProjectionTracker,
  type ProviderSubagentTurnScope,
} from "./provider-subagent-projection";

type SessionEvent = GatewaySessionEvent;

interface ChatThreadArchiveScanPage {
  readonly generation: number;
  readonly pageOrdinal: number;
  readonly requestCursor: string | null;
  readonly responseBackwardsCursor: string | null;
  readonly responseNextCursor: string | null;
  readonly streamPosition: number;
  readonly threadIds: readonly string[];
}

interface ChatThreadArchiveCatalogScan {
  readonly ids: readonly string[];
  readonly pages: readonly ChatThreadArchiveScanPage[];
  readonly streamPosition: number;
}

export type SessionCommand =
  | Readonly<{
      readonly type: "thread.list";
      readonly accountProfileId?: AccountSummary["id"];
      readonly projectId?: ProjectSummary["id"];
    }>
  | Readonly<{ readonly type: "thread.resume"; readonly threadId: ThreadSummary["id"] }>;

export type SessionCommandResult =
  | Readonly<{ readonly type: "thread"; readonly thread: ThreadSummary }>
  | Readonly<{ readonly type: "threads"; readonly threads: readonly ThreadSummary[] }>;

/**
 * Gateway-only authority used by the cloud dispatcher after it has selected an
 * account and provisioned a workspace. Thread and initial-turn mutations stay
 * separate so the coordinator can durably reconcile each ambiguous upstream
 * boundary. These shapes are deliberately absent from the renderer contract.
 */
export interface SessionThreadStartRequest {
  readonly accountProfileId: AccountSummary['id'];
  readonly serviceTier?: ChatServiceTier;
  readonly title: string;
  readonly workspaceMode: WorkspaceLaneSummary['mode'];
  readonly workspacePath: string;
}

export interface SessionTurnStartRequest {
  readonly clientUserMessageId: string;
  readonly prompt: string;
  readonly reasoningEffort?: "ultra" | "max";
  readonly serviceTier?: ChatServiceTier;
  readonly threadId: ThreadSummary['id'];
}

export interface SessionChatHistoryItem {
  readonly role: "user" | "assistant";
  readonly text: string;
}

/**
 * Content-free caller identity projected from a generation-local provider
 * request. Raw Codex thread and turn identifiers never cross this boundary.
 */
export interface SessionHarnessCallerIdentity {
  readonly generation: number;
  readonly projectId: ProjectSummary["id"];
  readonly threadId: ThreadSummary["id"];
  readonly turnId: string;
  readonly workspaceLaneId: WorkspaceLaneSummary["id"];
  readonly workspaceMode: WorkspaceLaneSummary["mode"];
  readonly workspacePath: string;
}

export interface SessionHarnessCompletedHistoryItem {
  readonly ordinal: number;
  readonly turnId: string;
  readonly itemClass: "userMessage" | "assistantMessage";
  readonly text: string;
}

/** Provider-visible history with a content-free completeness witness. */
export interface SessionHarnessCompletedHistory {
  readonly coverage: "complete" | "partial" | "unavailable";
  readonly throughTurnId: string | null;
  readonly sourceGeneration: number;
  readonly sourceStreamPosition: CodexStreamPosition;
  readonly coverageWitnessDigest: string;
  readonly items: readonly SessionHarnessCompletedHistoryItem[];
}

/** Current-turn input stays separate from the completed-prefix snapshot. */
export interface SessionHarnessCurrentInput {
  readonly turnId: string;
  readonly sourceGeneration: number;
  readonly sourceStreamPosition: CodexStreamPosition;
  readonly coverageWitnessDigest: string;
  readonly text: string;
}

export interface SessionHarnessContextAdmission {
  readonly completedHistory: SessionHarnessCompletedHistory;
  readonly currentInput: SessionHarnessCurrentInput;
}

/**
 * Private gateway input for one persistent harness actor incarnation. The
 * renderer never receives the provider identity, generation, source, or
 * instructions carried by this request.
 */
export interface SessionHarnessActorThreadStartRequest {
  readonly accountProfileId: AccountSummary["id"];
  readonly actorId: string;
  readonly developerInstructions: string;
  readonly expectedGeneration: number;
  readonly model: "gpt-5.6-sol" | "gpt-5.6-luna";
  readonly reasoningEffort: "ultra" | "max";
  readonly threadSource: string;
  readonly title: string;
  readonly workspaceMode: Extract<WorkspaceLaneSummary["mode"], "managed" | "readOnly">;
  readonly workspacePath: string;
}

export interface SessionHarnessActorThreadStartResult {
  readonly generation: number;
  /** Exact profile reported by Codex after applying the thread admission. */
  readonly observedProfile: Readonly<{
    readonly modelId: "gpt-5.6-sol" | "gpt-5.6-luna";
    readonly reasoningEffort: "ultra" | "max";
  }>;
  /** Gateway-owned identity safe for chat and dynamic-tool routing. */
  readonly threadId: ThreadSummary["id"];
  /** Raw Codex identity retained only by gateway persistence and recovery. */
  readonly providerThreadId: string;
  readonly projectId: ProjectSummary["id"];
  readonly streamPosition: CodexStreamPosition;
  readonly workspaceLaneId: WorkspaceLaneSummary["id"];
}

/** Content-free chained evidence for one exact fixed-page actor observation. */
export interface SessionHarnessActorRecoveryProofV2 {
  readonly recoveryProofDigest: string;
  readonly priorRecoveryProofDigest: string | null;
  readonly observationGeneration: number;
  readonly historyEvidenceDigest: string;
  readonly firstObservationPosition: CodexStreamPosition;
  readonly secondObservationPosition: CodexStreamPosition;
  readonly historyTurnCount: number;
  readonly historyItemCount: number;
}

export interface SessionHarnessActorThreadResumeRequest {
  readonly accountProfileId: AccountSummary["id"];
  readonly actorId: string;
  readonly admissionGeneration: number;
  readonly expectedGeneration: number;
  readonly model: "gpt-5.6-sol" | "gpt-5.6-luna";
  readonly previousRecoveryProofDigest: string | null;
  readonly providerThreadId: string;
  readonly reasoningEffort: "ultra" | "max";
  readonly threadSource: string;
  readonly title: string;
  readonly workspaceMode: Extract<WorkspaceLaneSummary["mode"], "managed" | "readOnly">;
  readonly workspacePath: string;
}

export interface SessionHarnessActorThreadResumeResult
  extends SessionHarnessActorThreadStartResult {
  readonly admissionGeneration: number;
  readonly recoveryProof: SessionHarnessActorRecoveryProofV2;
}

export type SessionHarnessActorThreadReference =
  | Readonly<{
      readonly kind: "gateway";
      readonly threadId: ThreadSummary["id"];
    }>
  | Readonly<{
      readonly accountProfileId: AccountSummary["id"];
      readonly kind: "provider";
      readonly providerThreadId: string;
    }>;

export interface SessionHarnessActorTurnStartRequest {
  readonly actorId: string;
  readonly clientUserMessageId: string;
  readonly expectedGeneration: number;
  readonly model: "gpt-5.6-sol" | "gpt-5.6-luna";
  /** Sensitive plaintext recovered from encrypted value custody by the caller. */
  readonly prompt: string;
  readonly reasoningEffort: "ultra" | "max";
  readonly serviceTier: ChatServiceTier;
  readonly thread: SessionHarnessActorThreadReference;
}

export interface SessionHarnessActorTurnStartResult {
  readonly generation: number;
  readonly providerTurnId: string;
  readonly quotaProof: "provider_usage_limit_exceeded" | null;
  readonly status: PinnedCodexTurn["status"];
  readonly streamPosition: CodexStreamPosition;
  readonly threadId: ThreadSummary["id"];
  readonly turnId: string;
}

export interface SessionHarnessActorTurnWorkspaceReconciliation {
  readonly accountProfileId: AccountSummary["id"];
  readonly clientUserMessageId: string;
  readonly disposition: "active" | "notApplied" | "terminal";
  readonly expectedGeneration: number;
  readonly providerThreadId: string;
  readonly providerTurnId?: string;
}

/** Content-free, generation-fenced model capability evidence for actor routing. */
export interface SessionHarnessModelCatalog {
  readonly evidenceDigest: string;
  readonly generation: number;
  readonly models: readonly Readonly<{
    readonly modelId: string;
    readonly reasoningEfforts: readonly string[];
    readonly serviceTiers: readonly string[];
  }>[];
}

/** The complete renderer attachment capability, with private routing omitted. */
export interface SessionHarnessActorChatAttachment {
  readonly threadId: ThreadSummary["id"];
  readonly restartThreadId: string;
}

/** Owned identities required to join one persistent-actor turn to ChatService. */
export interface SessionHarnessActorChatTurnAttachment {
  readonly threadId: ThreadSummary["id"];
  readonly turnId: string;
}

/** Exact proof that an owned session event belongs to one raw actor thread. */
export interface SessionHarnessActorChatEventAttachment {
  readonly threadId: ThreadSummary["id"];
  readonly turnId: string;
}

/** Private O(1) reverse route from one owned event to its registered actor. */
export interface SessionHarnessActorChatEventRoute {
  readonly actorId: string;
  readonly admissionGeneration: number;
  readonly generation: number;
  readonly providerThreadId: string;
  readonly threadId: ThreadSummary["id"];
  readonly turnId: string;
}

/** Text-only provider history eligible for one actor quota continuation. */
export interface SessionHarnessActorHistoryItem {
  readonly role: "user" | "assistant";
  readonly text: string;
}

/**
 * Exact bounded source history. Provider and account identities remain in the
 * request fence; plaintext exists only in this transient gateway value.
 */
export interface SessionHarnessActorContinuationHistory {
  readonly historyDigest: string;
  readonly itemCount: number;
  readonly items: readonly SessionHarnessActorHistoryItem[];
  readonly totalUtf8Bytes: number;
}

export type SessionHarnessActorHistoryReadback =
  | Readonly<{
      readonly kind: "matched";
      readonly historyDigest: string;
      readonly rawEvidenceDigest: string;
      readonly streamPosition: CodexStreamPosition;
    }>
  | Readonly<{
      readonly kind: "empty";
      readonly rawEvidenceDigest: string;
      readonly streamPosition: CodexStreamPosition;
    }>
  | Readonly<{
      readonly kind: "mismatched";
      readonly rawEvidenceDigest: string;
      readonly streamPosition: CodexStreamPosition;
    }>
  | Readonly<{
      readonly kind: "unavailable";
      readonly streamPosition: CodexStreamPosition;
    }>;

interface RegisteredHarnessActorThread {
  readonly accountProfileId: AccountSummary["id"];
  readonly actorId: string;
  readonly admissionGeneration: number;
  readonly generation: number;
  readonly model: "gpt-5.6-sol" | "gpt-5.6-luna";
  readonly providerThreadId: string;
  readonly reasoningEffort: "ultra" | "max";
  readonly threadId: ThreadSummary["id"];
  readonly threadSource: string;
}

interface RegisteredProductionExecutionPolicy {
  readonly accountProfileId: AccountSummary["id"];
  readonly computerUseReceipt?: ComputerUseAdmissionReceipt;
  readonly receipt: ProductionExecutionPolicyReceipt;
  readonly threadId: ThreadSummary["id"];
}

interface RegisteredExecutionWorkspaceLease {
  readonly accountProfileId: AccountSummary["id"];
  readonly release: () => void;
  readonly threadId: ThreadSummary["id"];
}

interface RegisteredAmbiguousExecutionWorkspaceLease
  extends RegisteredExecutionWorkspaceLease {
  readonly clientUserMessageId: string;
  readonly executionSettingsRevision: number;
  readonly generation: number;
  readonly proof: ProductionExecutionPolicyProof;
  readonly providerThreadId: string;
  readonly request: PinnedCodexRequestInput<"turnStart">;
  readonly threadReceipt: ProductionExecutionPolicyReceipt;
}

interface RegisteredChatCatalog {
  readonly accountProfileId: AccountSummary["id"];
  readonly catalogDigest: string;
  readonly generation: number;
  readonly models: readonly Readonly<{
    readonly model: string;
    readonly observedInputModalities: readonly ("text" | "image")[] | null;
    readonly reasoningEfforts: readonly string[];
    readonly serviceTiers: readonly string[];
  }>[];
}

export interface SessionChatCapabilityReceipt {
  readonly catalogDigest: string;
  readonly generation: number;
  readonly model: "gpt-5.6-sol" | "gpt-5.6-luna";
  readonly observedInputModalities: readonly ("text" | "image")[] | null;
  readonly reasoningEffort: "ultra" | "max";
  readonly serviceTier: ChatServiceTier;
}

interface RegisteredChatTurnCapability {
  readonly accountProfileId: AccountSummary["id"];
  readonly receipt: SessionChatCapabilityReceipt;
  readonly threadId: ThreadSummary["id"];
}

export type SessionChatProviderInput =
  | Readonly<{ readonly type: "text"; readonly text: string }>
  | Readonly<{ readonly type: "localImage"; readonly path: string }>;

interface SessionChatTurnStartBase {
  readonly clientUserMessageId: string;
  readonly model: "gpt-5.6-sol" | "gpt-5.6-luna";
  readonly reasoningEffort: "ultra" | "max";
  readonly serviceTier: ChatServiceTier;
  readonly threadId: ThreadSummary["id"];
  readonly catalogGeneration: number;
  readonly catalogDigest: string;
  readonly observedInputModalities: readonly ("text" | "image")[] | null;
}

export type SessionChatTurnStartRequest = SessionChatTurnStartBase & (
  | Readonly<{ readonly prompt: string; readonly input?: never }>
  | Readonly<{ readonly input: readonly SessionChatProviderInput[]; readonly prompt?: never }>
);

export interface SessionChatTurnStartResult {
  readonly threadId: ThreadSummary["id"];
  readonly turnId: string;
  readonly generation: number;
  readonly streamPosition: CodexStreamPosition;
}

export interface SessionChatConfigurationCandidate {
  readonly model: "gpt-5.6-sol" | "gpt-5.6-luna";
  readonly reasoningEffort: "ultra" | "max";
  readonly serviceTier: ChatServiceTier;
}

export interface SessionResolvedChatConfiguration
  extends SessionChatConfigurationCandidate {
  readonly catalogGeneration: number;
  readonly catalogDigest: string;
  readonly observedInputModalities: readonly ("text" | "image")[] | null;
}

export interface SessionThreadStartResult {
  readonly project: ProjectSummary;
  readonly thread: ThreadSummary;
}

export interface SessionChatThreadStartResult extends SessionThreadStartResult {
  /** Raw Codex identity retained only by the gateway for restart recovery. */
  readonly restartThreadId: string;
}

export interface SessionChatScheduleInterpretationRequest {
  readonly accountProfileId: AccountSummary["id"];
  readonly workspacePath: string;
  readonly instruction: string;
  readonly timeZone: string;
  readonly now: string;
}

export interface SessionChatScheduleInterpretation {
  readonly prompt: string;
  readonly rrule: string;
}

export interface SessionChatThreadResumeRequest {
  readonly accountProfileId: AccountSummary["id"];
  /** Gateway-owned identity used to fence every projected session event. */
  readonly threadId: ThreadSummary["id"];
  /** Raw Codex identity used only to rebuild the in-memory registry. */
  readonly restartThreadId: string;
  readonly catalogGeneration: number;
  readonly catalogDigest: string;
  readonly model: "gpt-5.6-sol" | "gpt-5.6-luna";
  readonly serviceTier: ChatServiceTier;
  readonly title: string;
  readonly workspacePath: string;
}

export type SessionThreadReconciliation =
  | Readonly<{ readonly kind: "missing" }>
  | Readonly<{ readonly kind: "ready"; readonly thread: ThreadSummary }>
  | Readonly<{ readonly kind: "ambiguous" }>;

export type SessionTurnReconciliation =
  | SessionTurnReconciliationPosition & Readonly<{ readonly kind: "missing" }>
  | SessionTurnReconciliationPosition & Readonly<{
      readonly kind: "ready";
      readonly turnId: string;
    }>
  | SessionTurnReconciliationPosition & Readonly<{
      readonly kind: "ambiguous";
      readonly reason: "duplicate_client_message_id";
    }>
  | SessionTurnReconciliationPosition & Readonly<{
      readonly kind: "incomplete";
      readonly reason: "partial_turn_items";
    }>;

interface SessionTurnReconciliationPosition {
  readonly generation: number;
  readonly responsePosition: CodexStreamPosition;
}

interface SessionSteerBase {
  readonly clientUserMessageId: string;
  readonly expectedGeneration: number;
  readonly expectedTurnId: NonNullable<ThreadSummary['activeTurn']>['id'];
  readonly threadId: ThreadSummary['id'];
}

export type SessionSteerRequest = SessionSteerBase & (
  | Readonly<{
      readonly prompt: string;
      readonly input?: never;
      readonly catalogDigest?: never;
      readonly observedInputModalities?: never;
    }>
  | Readonly<{
      readonly input: readonly SessionChatProviderInput[];
      readonly prompt?: never;
      readonly catalogDigest: string;
      readonly observedInputModalities: readonly ("text" | "image")[] | null;
    }>
);

export type { SessionAccountRuntimePort } from "./command-executor";
export type {
  SessionInteractionDeadline,
  SessionInteractionDeadlineScheduler,
  SessionInteractionExpired,
  SessionInteractionResolution,
} from "./interaction-coordinator";

export interface SessionHydrationFailure {
  readonly accountProfileId: AccountSummary['id'];
  readonly action: "restartRuntime";
  readonly attempts: number;
  readonly generation: number;
  readonly reason: Extract<SessionHydrationRunResult, { kind: "failed" }>["reason"];
  readonly recoveringThreadCount: number;
}

export interface SessionServiceOptions {
  readonly accounts: SessionAccountRuntimePort;
  readonly emit: (event: SessionEvent) => void;
  /** Required by production; optional only for isolated legacy unit fixtures. */
  readonly execution?: Readonly<{
    readonly computerUse: ComputerUseProvisioning;
    readonly runtimeWorkspaceRoots: () => readonly [string];
    readonly runtimeWorkspaceSnapshot?: () => Readonly<{
      revision: number;
      runtimeWorkspaceRoots: readonly [string];
    }>;
    readonly acquireRuntimeWorkspaceAdmission?: () => Promise<Readonly<{
      revision: number;
      runtimeWorkspaceRoots: readonly [string];
      release(): void;
    }>>;
  }>;
  readonly now?: () => Date;
  readonly deadlines?: SessionInteractionDeadlineScheduler;
  readonly onHydrationFailure?: (
    event: SessionHydrationFailure,
  ) => void | Promise<void>;
  readonly onAssistantItemCompletion?: (
    event: SessionAssistantItemCompletion,
  ) => void | Promise<void>;
  readonly onReasoningItemCompletion?: (
    event: SessionReasoningItemCompletion,
  ) => void | Promise<void>;
  readonly onProviderSubagents?: (
    event: SessionProviderSubagents,
  ) => void | Promise<void>;
  readonly onToolItemStarted?: (
    event: SessionToolItemStarted,
  ) => void | Promise<void>;
  readonly onTurnActivity?: (event: SessionTurnActivity) => void | Promise<void>;
  readonly onTurnLifecycle?: (event: SessionTurnLifecycle) => void;
  readonly onInteractionRequest?: (
    event: SessionInteractionRequest,
  ) => RunInteractionRequest | null | Promise<RunInteractionRequest | null>;
  readonly onInteractionExpired?: (
    event: SessionInteractionExpired,
  ) => void | Promise<void>;
  readonly respondToServerRequest?: (
    accountProfileId: AccountSummary['id'],
    request: CodexServerRequest,
    response: CodexServerResponse,
  ) => Promise<CodexStreamPosition | void>;
}

interface SessionTurnActivityBase {
  readonly accountProfileId: AccountSummary['id'];
  readonly threadId: ThreadSummary['id'];
  readonly turnId: string;
}

export type SessionTurnActivity =
  | (SessionTurnActivityBase & Readonly<{
      kind: Exclude<SessionTurnActivityKind,
        "reasoning_summary_delta" | "assistant_message_delta">;
    }>)
  | (SessionTurnActivityBase & Readonly<{
      kind: "reasoning_summary_delta";
      displayText: string;
      reasoningItemId: string;
    }>)
  | (SessionTurnActivityBase & Readonly<{
      kind: "assistant_message_delta";
      /** Present on owned Codex facts; optional for legacy auxiliary adapters. */
      assistantItemId?: string;
      displayText: string;
    }>);

/** Provider-authoritative, bounded completion for one owned assistant item. */
export interface SessionAssistantItemCompletion extends SessionTurnActivityBase {
  readonly assistantItemId: string;
  readonly displayText: string;
  readonly truncated: boolean;
}

/** Exact accepted completion of one provider reasoning-summary item. */
export interface SessionReasoningItemCompletion extends SessionTurnActivityBase {
  readonly itemId: string;
  readonly receipt: ReasoningSummaryCompletionReceipt;
}

export interface SessionProviderSubagents extends SessionTurnActivityBase {
  readonly projection: ChatProviderSubagentsProjection;
}

/** Exact accepted start of one provider tool item, independent of aggregate activity. */
export interface SessionToolItemStarted extends SessionTurnActivityBase {
  readonly itemId: string;
}

export interface SessionTurnLifecycle {
  readonly accountProfileId: AccountSummary['id'];
  readonly quotaProof?: "provider_usage_limit_exceeded";
  readonly threadId: ThreadSummary['id'];
  readonly turnId: string;
  readonly status: PinnedCodexTurn['status'];
  readonly inputTokens?: number;
  readonly outputTokens?: number;
}

export interface SessionInteractionRequest {
  readonly accountProfileId: AccountSummary['id'];
  readonly threadId: ThreadSummary['id'];
  readonly turnId: string;
  readonly request: RunInteractionRequestPayload;
}

export class SessionServiceError extends Error {
  readonly action: RuntimeError['action'];
  readonly code: RuntimeError['code'];
  readonly retryable: boolean;

  constructor(
    code: RuntimeError['code'],
    message: string,
    retryable: boolean,
    action: RuntimeError['action'],
  ) {
    super(message);
    this.name = "SessionServiceError";
    this.code = code;
    this.retryable = retryable;
    this.action = action;
  }
}

export type SessionHarnessActorRecoveryFailureV2 =
  | "provider_identity_mismatch"
  | "thread_source_mismatch"
  | "workspace_mismatch"
  | "sandbox_mismatch"
  | "history_unstable"
  | "actor_ownership_conflict"
  | "generation_regression"
  | "recovery_protocol_error";

export class SessionHarnessActorRecoveryErrorV2 extends SessionServiceError {
  readonly recoveryFailure: SessionHarnessActorRecoveryFailureV2;

  constructor(
    recoveryFailure: SessionHarnessActorRecoveryFailureV2,
    message: string,
  ) {
    super("protocol_error", message, false, "restartRuntime");
    this.name = "SessionHarnessActorRecoveryErrorV2";
    this.recoveryFailure = recoveryFailure;
  }
}

export const MAX_SESSION_ACTIVE_TOOL_ITEMS_PER_TURN = 128;
/** Auxiliary activity projection deliberately retains less than semantic history. */
export const MAX_SESSION_TRACKED_TOOL_TURNS_PER_ACCOUNT = 16;
export const MAX_SESSION_HARNESS_HISTORY_ITEMS = 16_384;
export const MAX_SESSION_HARNESS_HISTORY_ITEM_UTF8_BYTES = 1024 * 1024;
export const MAX_SESSION_HARNESS_HISTORY_UTF8_BYTES = 16 * 1024 * 1024;
export const MAX_SESSION_HARNESS_CONTINUATION_ITEMS = 1_024;

const chatScheduleInterpretationSchema = z.object({
  prompt: z.string().trim().min(1).max(MAX_SCHEDULED_CHAT_PROMPT_UTF8_BYTES)
    .refine(
      (prompt) => Buffer.byteLength(prompt, "utf8") <= MAX_SCHEDULED_CHAT_PROMPT_UTF8_BYTES,
      "schedule prompt exceeds the UTF-8 byte bound",
    ),
  rrule: z.string().trim().min(1).max(2 * 1_024),
}).strict();
const chatScheduleOutputSchema: NonNullable<
  PinnedCodexRequestInput<"turnStart">["outputSchema"]
> = {
  type: "object",
  additionalProperties: false,
  required: ["prompt", "rrule"],
  properties: {
    prompt: {
      type: "string",
      minLength: 1,
      maxLength: MAX_SCHEDULED_CHAT_PROMPT_UTF8_BYTES,
    },
    rrule: { type: "string", minLength: 1, maxLength: 2_048 },
  },
};
const chatScheduleDeveloperInstructions = [
  "Interpret one natural-language scheduling request for HRA.",
  "Return exactly one JSON object matching the supplied schema.",
  "The prompt must contain only the task to run, without timing language.",
  "The rrule must be exactly two lines: DTSTART;TZID=<supplied-zone>:YYYYMMDDTHHMMSS followed by RRULE:FREQ=<MINUTELY|HOURLY|DAILY|WEEKLY|MONTHLY>;INTERVAL=<canonical-positive-integer>.",
  "A WEEKLY rule must append ;BYDAY= with unique weekdays sorted MO,TU,WE,TH,FR,SA,SU and including DTSTART's weekday. A MONTHLY rule must append ;BYMONTHDAY= with unique ascending day numbers and including DTSTART's day. Other frequencies must not use BYDAY or BYMONTHDAY.",
  "Do not create a Codex scheduled task, automation, reminder, or any external side effect.",
  "If the request cannot be interpreted unambiguously as a recurring schedule, fail the turn instead of guessing.",
].join("\n");

export class SessionService {
  readonly #activeToolItemsByTurn = new Map<string, Set<string>>();
  readonly #completedToolItemsByTurn = new Map<string, Set<string>>();
  readonly #commands: SessionCommandExecutor;
  readonly #accounts: SessionAccountRuntimePort;
  readonly #factDispatch: SessionFactDispatchAdapter;
  readonly #execution: SessionServiceOptions["execution"];
  readonly #hydration: SessionHydrationCoordinator;
  readonly #activeRuntimeGenerations = new Map<string, number>();
  readonly #harnessActorThreadsByOwnedId = new Map<
    ThreadSummary["id"],
    RegisteredHarnessActorThread
  >();
  readonly #interactions: SessionInteractionCoordinator;
  readonly #now: () => Date;
  readonly #onHydrationFailure: (
    event: SessionHydrationFailure,
  ) => void | Promise<void>;
  readonly #onInteractionRequest: (
    event: SessionInteractionRequest,
  ) => RunInteractionRequest | null | Promise<RunInteractionRequest | null>;
  readonly #onAssistantItemCompletion: (
    event: SessionAssistantItemCompletion,
  ) => void | Promise<void>;
  readonly #onReasoningItemCompletion: (
    event: SessionReasoningItemCompletion,
  ) => void | Promise<void>;
  readonly #onProviderSubagents: (
    event: SessionProviderSubagents,
  ) => void | Promise<void>;
  readonly #onToolItemStarted: (
    event: SessionToolItemStarted,
  ) => void | Promise<void>;
  readonly #onTurnActivity: (event: SessionTurnActivity) => void | Promise<void>;
  readonly #onTurnLifecycle: (event: SessionTurnLifecycle) => void;
  readonly #reportedHydrationFailureGenerations = new Map<string, number>();
  readonly #productionPolicyByThread = new Map<
    ThreadSummary["id"],
    RegisteredProductionExecutionPolicy
  >();
  readonly #productionPolicyByTurn = new Map<
    string,
    RegisteredProductionExecutionPolicy
  >();
  readonly #executionWorkspaceLeaseByTurn = new Map<
    string,
    RegisteredExecutionWorkspaceLease
  >();
  readonly #ambiguousExecutionWorkspaceLeaseByRequest = new Map<
    string,
    RegisteredAmbiguousExecutionWorkspaceLease
  >();
  readonly #chatCatalogsByEvidence = new Map<string, RegisteredChatCatalog>();
  readonly #chatCapabilityByTurn = new Map<string, RegisteredChatTurnCapability>();
  readonly #chatThreadArchiveTails = new Map<string, Promise<void>>();
  readonly #registry: SessionRegistry;
  readonly #saturatedToolActivityAccounts = new Set<string>();
  readonly #store = new SessionStore();
  readonly #selectors = createSessionSelectors();
  readonly #toolItemOverflowTurns = new Set<string>();
  readonly #reasoningSummaries = new ReasoningSummaryAccumulator();
  readonly #providerSubagents = new ProviderSubagentProjectionTracker();

  constructor(options: SessionServiceOptions) {
    this.#accounts = options.accounts;
    this.#commands = new SessionCommandExecutor(options.accounts);
    this.#execution = options.execution;
    this.#onTurnLifecycle = options.onTurnLifecycle ?? (() => undefined);
    this.#registry = new SessionRegistry({
      emit: options.emit,
      errors: {
        capacity: (message) => new SessionServiceError(
          "capacity_full",
          message,
          true,
          "retry",
        ),
        missingThread: (message) => new SessionServiceError(
          "not_found",
          message,
          true,
          "retry",
        ),
        protocol: (message) => new SessionServiceError(
          "protocol_error",
          message,
          false,
          "restartRuntime",
        ),
      },
      getSnapshot: this.#store.getSnapshot,
      onTurnLifecycle: this.#onTurnLifecycle,
    });
    this.#factDispatch = new SessionFactDispatchAdapter({
      admit: (fact) => this.#admitDisplayFact(fact),
      emit: options.emit,
    });
    this.#now = options.now ?? (() => new Date());
    this.#hydration = new SessionHydrationCoordinator({
      getTargetPlan: ({ accountProfileId }) =>
        this.#hydrationTargetPlan(accountProfileId),
      install: ({ facts }) => {
        this.#consumeCodexFacts(facts);
      },
      now: () => this.#now().getTime(),
      requests: {
        threadList: async ({ accountProfileId, generation, input }) =>
          await this.#commands.threadList(
            accountProfileId,
            input,
            generation,
          ),
        threadRead: async ({ accountProfileId, generation, input }) =>
          await this.#commands.threadRead(
            accountProfileId,
            input,
            generation,
          ),
      },
    });
    this.#onHydrationFailure = options.onHydrationFailure ?? (() => undefined);
    this.#onInteractionRequest = options.onInteractionRequest ?? (() => null);
    this.#onAssistantItemCompletion = options.onAssistantItemCompletion ?? (() => undefined);
    this.#onReasoningItemCompletion = options.onReasoningItemCompletion ?? (() => undefined);
    this.#onProviderSubagents = options.onProviderSubagents ?? (() => undefined);
    this.#onToolItemStarted = options.onToolItemStarted ?? (() => undefined);
    this.#onTurnActivity = options.onTurnActivity ?? (() => undefined);
    this.#interactions = new SessionInteractionCoordinator({
      consumeFacts: (facts) => {
        this.consumeCodexFacts(facts);
      },
      ...(options.deadlines === undefined ? {} : { deadlines: options.deadlines }),
      now: () => this.#now().getTime(),
      onExpired: options.onInteractionExpired ?? (() => undefined),
      respond: options.respondToServerRequest ?? (() => Promise.reject(
        new Error("Codex server-request response routing is unavailable"),
      )),
    });
  }

  getSnapshot = (): SessionState => this.#store.getSnapshot();

  subscribe = (listener: SessionStoreListener): (() => void) =>
    this.#store.subscribe(listener);

  consumeCodexFacts(facts: readonly CodexFact[]): boolean {
    let retained = false;
    const admitted: CodexFact[] = [];
    const observedGenerations = new Map<string, Readonly<{
      accountProfileId: string;
      generation: number;
    }>>();
    for (const fact of facts) {
      if (fact.origin !== "live") {
        admitted.push(fact);
        continue;
      }
      observedGenerations.set(
        `${fact.accountProfileId.length}:${fact.accountProfileId}:${String(fact.generation)}`,
        { accountProfileId: fact.accountProfileId, generation: fact.generation },
      );
      if (this.#hydration.acceptLiveFact(fact)) {
        retained = true;
        continue;
      }
      if (this.#hydration.admitAfterHydration(fact)) {
        admitted.push(fact);
      } else {
        retained = true;
      }
    }
    for (const { accountProfileId, generation } of observedGenerations.values()) {
      const recoveredThreadIds = this.#hydration.takeRecoveredThreadIds(
        accountProfileId,
        generation,
      );
      if (recoveredThreadIds.length === 0) continue;
      const anchor = admitted
        .filter((fact) =>
          fact.accountProfileId === accountProfileId && fact.generation === generation
        )
        .sort((left, right) =>
          right.streamPosition - left.streamPosition || right.factIndex - left.factIndex
        )[0];
      if (anchor === undefined) {
        throw new Error("A recovered hydration thread is missing its positioned fact");
      }
      const state = this.#store.getSnapshot();
      admitted.push(...createCodexFactsAtPosition({
        accountProfileId,
        generation,
        origin: "reconciled",
        streamPosition: anchor.streamPosition,
      }, recoveredThreadIds.map((threadId) => ({
        type: "hydration.changed" as const,
        attempt: state.hydration[sessionEntityKey(accountProfileId, threadId)]?.attempt ?? 0,
        status: "ready" as const,
        threadId,
      })), anchor.factIndex + 1));
    }
    return (admitted.length > 0 && this.#consumeCodexFacts(admitted)) || retained;
  }

  handleRuntimeState(accountProfileId: string, state: CodexSupervisorState): void {
    switch (state.type) {
      case "starting":
        this.#beginRuntimeGeneration(accountProfileId, state.generation);
        this.#interactions.retainGeneration(accountProfileId, state.generation);
        this.#hydration.startGeneration({
          accountProfileId,
          generation: state.generation,
          startedAt: this.#now().getTime(),
        });
        return;
      case "running":
        this.#beginRuntimeGeneration(accountProfileId, state.generation);
        this.#interactions.retainGeneration(accountProfileId, state.generation);
        this.#hydration.startGeneration({
          accountProfileId,
          generation: state.generation,
          startedAt: this.#now().getTime(),
        });
        void this.#hydration.onRunning(accountProfileId, state.generation)
          .then((result) => {
            this.#publishHydrationFailure(accountProfileId, state.generation, result);
          })
          .catch(() => undefined);
        return;
      case "backing_off":
      case "failed":
      case "idle":
      case "stopped":
        this.#interactions.endGeneration(accountProfileId, state.generation);
        this.#hydration.endGeneration(accountProfileId, state.generation);
        if (this.#activeRuntimeGenerations.get(accountProfileId) === state.generation) {
          this.#clearProviderSubagentsForAccount(accountProfileId);
          this.#reasoningSummaries.purgeAccount(accountProfileId);
          this.#clearToolActivityForAccount(accountProfileId);
          this.#clearHarnessActorThreadsForAccount(accountProfileId);
          this.#clearProductionPolicyForAccount(accountProfileId);
          this.#clearChatCapabilityForAccount(accountProfileId);
          this.#activeRuntimeGenerations.delete(accountProfileId);
          this.#reportedHydrationFailureGenerations.delete(accountProfileId);
        }
    }
  }

  /**
   * Releases mutable account routing only after the durable account authority
   * has confirmed removal. No provider observation can invoke this path.
   */
  purgeAccount(accountProfileId: string): void {
    this.#clearProviderSubagentsForAccount(accountProfileId);
    this.#reasoningSummaries.purgeAccount(accountProfileId);
    this.#interactions.purgeAccount(accountProfileId);
    this.#hydration.purgeAccount(accountProfileId);
    this.#store.purgeAccount(accountProfileId);
    this.#registry.purgeAccount(accountProfileId);
    this.#factDispatch.purgeAccount(accountProfileId);
    this.#clearToolActivityForAccount(accountProfileId);
    this.#clearHarnessActorThreadsForAccount(accountProfileId);
    this.#clearProductionPolicyForAccount(accountProfileId);
    this.#clearChatCapabilityForAccount(accountProfileId);
    this.#reportedHydrationFailureGenerations.delete(accountProfileId);
    this.#activeRuntimeGenerations.delete(accountProfileId);
  }

  /**
   * Narrow future steering gate: returns opaque policy evidence only for the
   * exact active turn admitted under the current full-access generation.
   */
  verifiedProductionExecutionPolicyForActiveTurn(
    threadId: ThreadSummary["id"],
    turnId: string,
  ): ProductionExecutionPolicyReceipt | null {
    const thread = this.#registry.threadByOwnedId(threadId);
    const registered = this.#productionPolicyByTurn.get(turnId);
    const workspaceLease = this.#executionWorkspaceLeaseByTurn.get(turnId);
    if (
      thread === null ||
      thread.activeTurn?.id !== turnId ||
      thread.activeTurn.status !== "active" ||
      registered === undefined ||
      workspaceLease === undefined ||
      registered.threadId !== threadId ||
      workspaceLease.threadId !== threadId ||
      registered.accountProfileId !== thread.accountProfileId ||
      workspaceLease.accountProfileId !== thread.accountProfileId ||
      this.#activeRuntimeGenerations.get(thread.accountProfileId) !==
        registered.receipt.generation
    ) return null;
    return registered.receipt;
  }

  verifiedChatCapabilityForActiveTurn(
    threadId: ThreadSummary["id"],
    turnId: string,
  ): SessionChatCapabilityReceipt | null {
    const policy = this.verifiedProductionExecutionPolicyForActiveTurn(
      threadId,
      turnId,
    );
    const registered = this.#chatCapabilityByTurn.get(turnId);
    if (
      policy === null || registered === undefined ||
      registered.threadId !== threadId ||
      registered.receipt.generation !== policy.generation ||
      !this.#chatCatalogsByEvidence.has(chatCatalogEvidenceKey(
        registered.accountProfileId,
        registered.receipt.generation,
        registered.receipt.catalogDigest,
      ))
    ) return null;
    return registered.receipt;
  }

  /**
   * Starts and registers one harness actor incarnation through the same
   * positioned fact path as every visible chat. The response is verified in
   * full before its raw provider identity becomes routable.
   */
  async startHarnessActorThread(
    request: SessionHarnessActorThreadStartRequest,
  ): Promise<SessionHarnessActorThreadStartResult> {
    validateHarnessActorId(request.actorId);
    validateLaunchTitle(request.title);
    validateHarnessThreadSource(request.threadSource);
    validateHarnessDeveloperInstructions(request.developerInstructions);
    this.#assertHarnessGeneration(request.accountProfileId, request.expectedGeneration);
    const project = await this.#registerProject(request.workspacePath);
    this.#assertHarnessGeneration(request.accountProfileId, request.expectedGeneration);
    const policyProof = await this.#preflightProductionExecutionPolicy(
      request.accountProfileId,
      request.expectedGeneration,
    );
    const executionWorkspace = this.#runtimeWorkspaceSnapshot(project.displayPath);
    const threadStartInput: PinnedCodexRequestInput<"threadStart"> = {
      model: request.model,
      allowProviderModelFallback: false,
      serviceTier: null,
      cwd: project.displayPath,
      runtimeWorkspaceRoots: [...executionWorkspace.runtimeWorkspaceRoots],
      approvalPolicy: HRA_PRODUCTION_EXECUTION_POLICY.approvalPolicy,
      approvalsReviewer: HRA_PRODUCTION_EXECUTION_POLICY.approvalsReviewer,
      sandbox: HRA_PRODUCTION_EXECUTION_POLICY.threadSandbox,
      config: this.#executionThreadConfig(
        harnessActorThreadConfig(request.reasoningEffort),
      ),
      developerInstructions: this.#executionDeveloperInstructions(
        request.developerInstructions,
      ),
      ephemeral: false,
      historyMode: "paginated",
      threadSource: request.threadSource,
    };
    const positioned = await this.#commands.threadStart(
      request.accountProfileId,
      threadStartInput,
      policyProof.generation,
    );
    this.#assertHarnessGeneration(request.accountProfileId, request.expectedGeneration);
    const raw = positioned.output.thread;
    if (
      positioned.generation !== request.expectedGeneration ||
      positioned.output.model !== request.model ||
      positioned.output.reasoningEffort !== request.reasoningEffort ||
      positioned.output.serviceTier !== null ||
      raw.cwd !== project.displayPath ||
      raw.ephemeral !== false ||
      raw.historyMode !== "paginated" ||
      raw.threadSource !== request.threadSource ||
      raw.turns.length !== 0 ||
      (raw.name !== null && raw.name !== request.title)
    ) {
      throw new SessionServiceError(
        "protocol_error",
        "Codex returned a harness actor thread with mismatched identity or configuration.",
        false,
        "restartRuntime",
      );
    }
    await this.#registerProductionThreadPolicy({
      accountProfileId: request.accountProfileId,
      proof: policyProof,
      positioned,
      request: threadStartInput,
      executionSettingsRevision: executionWorkspace.revision,
    });

    const threadId = ownedCodexId("thread", request.accountProfileId, raw.id);
    const existingHarness = this.#harnessActorThreadsByOwnedId.get(threadId);
    const existingBinding = this.#registry.bindingByCodexId(
      request.accountProfileId,
      raw.id,
    );
    if (
      existingHarness !== undefined ||
      (existingBinding !== null && existingBinding.cwd !== project.displayPath)
    ) {
      throw new SessionServiceError(
        "protocol_error",
        "Codex reused an incompatible harness actor thread identity.",
        false,
        "restartRuntime",
      );
    }

    const snapshotFacts = projectCodexThreadResponseFacts({
      accountProfileId: request.accountProfileId,
      generation: positioned.generation,
      origin: "reconciled",
      streamPosition: positioned.streamPosition,
    }, [{ archived: false, thread: raw, turns: "present" }]);
    this.#consumeCodexFacts(Object.freeze([
      ...snapshotFacts,
      ...confirmedOperationFacts({
        accountProfileId: request.accountProfileId,
        generation: positioned.generation,
        operation: "thread_start",
        streamPosition: positioned.streamPosition,
        threadId: raw.id,
      }, snapshotFacts.length),
    ]), {
      accountProfileId: request.accountProfileId,
      laneMode: request.workspaceMode,
      preferredProject: project,
      preferredTitle: request.title,
      threadId: raw.id,
    });

    const thread = this.#registry.requireObservedThread(request.accountProfileId, raw.id);
    const binding = this.#registry.requireBinding(threadId);
    if (
      thread.id !== threadId ||
      thread.accountProfileId !== request.accountProfileId ||
      thread.projectId !== project.id ||
      thread.workspaceLaneId !== binding.workspaceLaneId ||
      thread.title !== request.title ||
      binding.accountProfileId !== request.accountProfileId ||
      binding.codexThreadId !== raw.id ||
      binding.cwd !== project.displayPath ||
      binding.laneMode !== request.workspaceMode ||
      binding.projectId !== project.id
    ) {
      throw new SessionServiceError(
        "protocol_error",
        "The harness actor thread did not install under its exact gateway identity.",
        false,
        "restartRuntime",
      );
    }
    this.#harnessActorThreadsByOwnedId.set(threadId, Object.freeze({
      accountProfileId: request.accountProfileId,
      actorId: request.actorId,
      admissionGeneration: request.expectedGeneration,
      generation: request.expectedGeneration,
      model: request.model,
      providerThreadId: raw.id,
      reasoningEffort: request.reasoningEffort,
      threadId,
      threadSource: request.threadSource,
    }));
    return Object.freeze({
      generation: positioned.generation,
      observedProfile: Object.freeze({
        modelId: positioned.output.model,
        reasoningEffort: positioned.output.reasoningEffort,
      }),
      threadId,
      providerThreadId: raw.id,
      projectId: project.id,
      streamPosition: positioned.streamPosition,
      workspaceLaneId: binding.workspaceLaneId,
    });
  }

  /**
   * Seals the initial durable recovery witness only after the fresh actor
   * thread is installed. Two exhaustive fixed-page observations must agree;
   * the returned value contains no transcript or provider metadata.
   */
  async observeHarnessActorSessionRecoveryProof(input: Readonly<{
    actorId: string;
    accountProfileId: AccountSummary["id"];
    admissionGeneration: number;
    expectedGeneration: number;
    providerThreadId: string;
    priorRecoveryProofDigest: string | null;
  }>): Promise<SessionHarnessActorRecoveryProofV2> {
    validateHarnessActorId(input.actorId);
    validateHarnessRecoveryDigest(input.priorRecoveryProofDigest);
    const registeredBefore = this.#requireHarnessActorThread({
      kind: "provider",
      accountProfileId: input.accountProfileId,
      providerThreadId: input.providerThreadId,
    }, input.expectedGeneration, input.actorId);
    if (registeredBefore.admissionGeneration !== input.admissionGeneration) {
      throw new SessionHarnessActorRecoveryErrorV2(
        "generation_regression",
        "The actor session admission generation changed before observation.",
      );
    }
    const binding = this.#registry.requireBinding(registeredBefore.threadId);
    const proof = await this.#observeHarnessActorRecoveryProof({
      actorId: input.actorId,
      accountProfileId: input.accountProfileId,
      admissionGeneration: input.admissionGeneration,
      expectedGeneration: input.expectedGeneration,
      initialStreamPosition: null,
      priorRecoveryProofDigest: input.priorRecoveryProofDigest,
      providerThreadId: input.providerThreadId,
      threadSource: registeredBefore.threadSource,
      workspaceMode: binding.laneMode === "readOnly" ? "readOnly" : "managed",
      workspacePath: binding.cwd,
    });
    const registeredAfter = this.#requireHarnessActorThread({
      kind: "provider",
      accountProfileId: input.accountProfileId,
      providerThreadId: input.providerThreadId,
    }, input.expectedGeneration, input.actorId);
    if (registeredAfter !== registeredBefore) {
      throw new SessionServiceError(
        "conflict",
        "The actor session registration changed during recovery observation.",
        true,
        "retry",
      );
    }
    return proof;
  }

  /**
   * Rebuilds the generation-local SessionRegistry and private actor routing
   * for one durable binding. `thread/resume` is fenced to the exact current
   * generation, then its identity and complete fixed-page history are checked
   * before either registry becomes authoritative.
   */
  async resumeHarnessActorThread(
    request: SessionHarnessActorThreadResumeRequest,
  ): Promise<SessionHarnessActorThreadResumeResult> {
    validateHarnessActorId(request.actorId);
    validateLaunchTitle(request.title);
    validateHarnessThreadSource(request.threadSource);
    validateHarnessRecoveryDigest(request.previousRecoveryProofDigest);
    validateHarnessProviderThreadId(request.providerThreadId);
    if (
      !Number.isSafeInteger(request.admissionGeneration) ||
      request.admissionGeneration <= 0 ||
      !Number.isSafeInteger(request.expectedGeneration) ||
      request.expectedGeneration < request.admissionGeneration
    ) {
      throw new SessionHarnessActorRecoveryErrorV2(
        "generation_regression",
        "The actor session recovery generation regressed behind admission.",
      );
    }
    this.#assertHarnessGeneration(
      request.accountProfileId,
      request.expectedGeneration,
    );
    const project = await this.#registerProject(request.workspacePath);
    this.#assertHarnessGeneration(
      request.accountProfileId,
      request.expectedGeneration,
    );
    if (project.displayPath !== request.workspacePath) {
      throw new SessionHarnessActorRecoveryErrorV2(
        "workspace_mismatch",
        "The durable actor workspace is no longer the same canonical folder.",
      );
    }
    const expectedThreadId = ownedCodexId(
      "thread",
      request.accountProfileId,
      request.providerThreadId,
    );
    const existingHarness = this.#harnessActorThreadsByOwnedId.get(
      expectedThreadId,
    );
    if (
      request.previousRecoveryProofDigest === null &&
      existingHarness !== undefined
    ) {
      throw new SessionHarnessActorRecoveryErrorV2(
        "recovery_protocol_error",
        "An already registered actor session requires its exact prior proof.",
      );
    }
    if (
      existingHarness !== undefined &&
      (
        existingHarness.accountProfileId !== request.accountProfileId ||
        existingHarness.actorId !== request.actorId ||
        existingHarness.admissionGeneration !== request.admissionGeneration ||
        existingHarness.generation !== request.expectedGeneration ||
        existingHarness.model !== request.model ||
        existingHarness.providerThreadId !== request.providerThreadId ||
        existingHarness.reasoningEffort !== request.reasoningEffort ||
        existingHarness.threadSource !== request.threadSource
      )
    ) {
      throw new SessionHarnessActorRecoveryErrorV2(
        "actor_ownership_conflict",
        "The provider thread is already registered to another actor identity.",
      );
    }

    const policyProof = await this.#preflightProductionExecutionPolicy(
      request.accountProfileId,
      request.expectedGeneration,
    );
    const executionWorkspace = this.#runtimeWorkspaceSnapshot(project.displayPath);
    const threadResumeInput: PinnedCodexRequestInput<"threadResume"> = {
      threadId: request.providerThreadId,
      model: request.model,
      serviceTier: null,
      cwd: project.displayPath,
      runtimeWorkspaceRoots: [...executionWorkspace.runtimeWorkspaceRoots],
      approvalPolicy: HRA_PRODUCTION_EXECUTION_POLICY.approvalPolicy,
      approvalsReviewer: HRA_PRODUCTION_EXECUTION_POLICY.approvalsReviewer,
      sandbox: HRA_PRODUCTION_EXECUTION_POLICY.threadSandbox,
      config: this.#executionThreadConfig(
        harnessActorThreadConfig(request.reasoningEffort),
      ),
      developerInstructions: this.#executionDeveloperInstructions(),
    };
    const positioned = await this.#commands.threadResume(
      request.accountProfileId,
      threadResumeInput,
      policyProof.generation,
    );
    this.#assertHarnessGeneration(
      request.accountProfileId,
      request.expectedGeneration,
    );
    const raw = positioned.output.thread;
    if (
      positioned.generation !== request.expectedGeneration ||
      raw.id !== request.providerThreadId
    ) {
      throw new SessionHarnessActorRecoveryErrorV2(
        "provider_identity_mismatch",
        "Codex resumed a different actor provider thread.",
      );
    }
    if (
      positioned.output.model !== request.model ||
      positioned.output.reasoningEffort !== request.reasoningEffort ||
      positioned.output.serviceTier !== null
    ) {
      throw new SessionHarnessActorRecoveryErrorV2(
        "recovery_protocol_error",
        "Codex resumed the actor thread with a different execution profile.",
      );
    }
    if (raw.threadSource !== request.threadSource) {
      throw new SessionHarnessActorRecoveryErrorV2(
        "thread_source_mismatch",
        "Codex resumed an actor thread with a different source identity.",
      );
    }
    if (raw.cwd !== project.displayPath) {
      throw new SessionHarnessActorRecoveryErrorV2(
        "workspace_mismatch",
        "Codex resumed an actor thread in a different workspace.",
      );
    }
    if (raw.ephemeral !== false || raw.historyMode !== "paginated") {
      throw new SessionHarnessActorRecoveryErrorV2(
        "recovery_protocol_error",
        "Codex resumed an actor thread with incompatible persistence settings.",
      );
    }
    await this.#registerProductionThreadPolicy({
      accountProfileId: request.accountProfileId,
      proof: policyProof,
      positioned,
      request: threadResumeInput,
      executionSettingsRevision: executionWorkspace.revision,
    });
    const recoveryProof = await this.#observeHarnessActorRecoveryProof({
      actorId: request.actorId,
      accountProfileId: request.accountProfileId,
      admissionGeneration: request.admissionGeneration,
      expectedGeneration: request.expectedGeneration,
      initialStreamPosition: positioned.streamPosition,
      priorRecoveryProofDigest: request.previousRecoveryProofDigest,
      providerThreadId: request.providerThreadId,
      threadProjection: raw,
      threadSource: request.threadSource,
      workspaceMode: request.workspaceMode,
      workspacePath: project.displayPath,
    });

    const snapshotFacts = projectCodexThreadResponseFacts({
      accountProfileId: request.accountProfileId,
      generation: positioned.generation,
      origin: "reconciled",
      streamPosition: positioned.streamPosition,
    }, [{ archived: false, thread: raw, turns: "present" }]);
    this.#consumeCodexFacts(Object.freeze([
      ...snapshotFacts,
      ...confirmedOperationFacts({
        accountProfileId: request.accountProfileId,
        generation: positioned.generation,
        operation: "thread_resume",
        streamPosition: positioned.streamPosition,
        threadId: raw.id,
      }, snapshotFacts.length),
    ]), {
      accountProfileId: request.accountProfileId,
      laneMode: request.workspaceMode,
      preferredProject: project,
      preferredTitle: request.title,
      threadId: raw.id,
    });
    const thread = this.#registry.requireObservedThread(
      request.accountProfileId,
      raw.id,
    );
    const binding = this.#registry.requireBinding(expectedThreadId);
    if (
      thread.id !== expectedThreadId ||
      thread.accountProfileId !== request.accountProfileId ||
      thread.projectId !== project.id ||
      thread.workspaceLaneId !== binding.workspaceLaneId ||
      binding.accountProfileId !== request.accountProfileId ||
      binding.codexThreadId !== request.providerThreadId ||
      binding.cwd !== project.displayPath ||
      binding.laneMode !== request.workspaceMode ||
      binding.projectId !== project.id
    ) {
      throw new SessionHarnessActorRecoveryErrorV2(
        "actor_ownership_conflict",
        "The resumed actor thread did not install under its exact gateway identity.",
      );
    }
    this.#harnessActorThreadsByOwnedId.set(expectedThreadId, Object.freeze({
      accountProfileId: request.accountProfileId,
      actorId: request.actorId,
      admissionGeneration: request.admissionGeneration,
      generation: request.expectedGeneration,
      model: request.model,
      providerThreadId: request.providerThreadId,
      reasoningEffort: request.reasoningEffort,
      threadId: expectedThreadId,
      threadSource: request.threadSource,
    }));
    return Object.freeze({
      admissionGeneration: request.admissionGeneration,
      generation: positioned.generation,
      observedProfile: Object.freeze({
        modelId: positioned.output.model,
        reasoningEffort: positioned.output.reasoningEffort,
      }),
      threadId: expectedThreadId,
      providerThreadId: request.providerThreadId,
      projectId: project.id,
      recoveryProof,
      streamPosition: positioned.streamPosition,
      workspaceLaneId: binding.workspaceLaneId,
    });
  }

  /**
   * Starts a new actor turn only through `turn/start`. Both gateway and raw
   * references resolve through the private generation-local registration.
   */
  async startHarnessActorTurn(
    request: SessionHarnessActorTurnStartRequest,
  ): Promise<SessionHarnessActorTurnStartResult> {
    validateHarnessActorId(request.actorId);
    validateLaunchText(request.clientUserMessageId, request.prompt);
    const registered = this.#requireHarnessActorThread(
      request.thread,
      request.expectedGeneration,
      request.actorId,
    );
    const binding = this.#registry.requireBinding(registered.threadId);
    if (
      registered.model !== request.model ||
      registered.reasoningEffort !== request.reasoningEffort
    ) {
      throw new SessionServiceError(
        "conflict",
        "The harness actor turn profile conflicts with its durable incarnation.",
        false,
        "none",
      );
    }
    this.#assertNoAmbiguousExecutionWorkspaceLease({
      accountProfileId: binding.accountProfileId,
      clientUserMessageId: request.clientUserMessageId,
      providerThreadId: binding.codexThreadId,
    });
    const admission = await this.#admitCurrentProductionThreadRoots({
      accountProfileId: binding.accountProfileId,
      expectedGeneration: request.expectedGeneration,
      threadId: registered.threadId,
      model: request.model,
      serviceTier: null,
      config: this.#executionThreadConfig(
        harnessActorThreadConfig(request.reasoningEffort),
      ),
      developerInstructions: this.#executionDeveloperInstructions(),
    });
    const turnStartInput: PinnedCodexRequestInput<"turnStart"> = {
      threadId: binding.codexThreadId,
      clientUserMessageId: request.clientUserMessageId,
      input: [{ type: "text", text: request.prompt, text_elements: [] }],
      cwd: binding.cwd,
      runtimeWorkspaceRoots: admission.runtimeWorkspaceRoots,
      approvalPolicy: HRA_PRODUCTION_EXECUTION_POLICY.approvalPolicy,
      approvalsReviewer: HRA_PRODUCTION_EXECUTION_POLICY.approvalsReviewer,
      sandboxPolicy: HRA_PRODUCTION_EXECUTION_POLICY.turnSandboxPolicy,
      model: request.model,
      effort: request.reasoningEffort,
      serviceTier: codexServiceTier(request.serviceTier),
    };
    let positioned: PinnedCodexResponseAtPosition<PinnedCodexRequestOutput<"turnStart">>;
    let workspaceLeaseTransferred = false;
    try {
      positioned = await this.#commands.turnStart(
        binding.accountProfileId,
        turnStartInput,
        admission.proof.generation,
      );
      this.#assertHarnessGeneration(binding.accountProfileId, request.expectedGeneration);
      if (positioned.generation !== request.expectedGeneration) {
        throw new SessionServiceError(
          "protocol_error",
          "Codex returned a harness actor turn from a different runtime generation.",
          false,
          "restartRuntime",
        );
      }
      this.#registerProductionTurnPolicy({
        accountProfileId: binding.accountProfileId,
        proof: admission.proof,
        positioned,
        request: turnStartInput,
        threadId: registered.threadId,
        threadReceipt: admission.receipt,
        executionSettingsRevision: admission.executionSettingsRevision,
        releaseWorkspaceAdmission: admission.releaseWorkspaceAdmission,
      });
      workspaceLeaseTransferred = true;
    } catch (error: unknown) {
      if (
        this.#activeRuntimeGenerations.get(binding.accountProfileId) ===
          admission.proof.generation
      ) {
        this.#retainAmbiguousExecutionWorkspaceLease({
          accountProfileId: binding.accountProfileId,
          clientUserMessageId: request.clientUserMessageId,
          executionSettingsRevision: admission.executionSettingsRevision,
          generation: admission.proof.generation,
          proof: admission.proof,
          providerThreadId: binding.codexThreadId,
          release: admission.releaseWorkspaceAdmission,
          request: turnStartInput,
          threadId: registered.threadId,
          threadReceipt: admission.receipt,
        });
        workspaceLeaseTransferred = true;
      }
      throw error;
    } finally {
      if (!workspaceLeaseTransferred) admission.releaseWorkspaceAdmission();
    }

    const providerTurnId = positioned.output.turn.id;
    const turnId = ownedCodexId("turn", binding.accountProfileId, providerTurnId);
    const snapshotFacts = projectCodexTurnResponseFacts({
      accountProfileId: binding.accountProfileId,
      generation: positioned.generation,
      origin: "reconciled",
      streamPosition: positioned.streamPosition,
    }, binding.codexThreadId, positioned.output.turn);
    this.#consumeCodexFacts(Object.freeze([
      ...snapshotFacts,
      ...confirmedOperationFacts({
        accountProfileId: binding.accountProfileId,
        generation: positioned.generation,
        operation: "turn_start",
        streamPosition: positioned.streamPosition,
        threadId: binding.codexThreadId,
      }, snapshotFacts.length),
    ]));
    const turnAdmissionSuperseded =
      this.#releaseProductionTurnAdmissionIfSuperseded({
        accountProfileId: binding.accountProfileId,
        generation: positioned.generation,
        providerThreadId: binding.codexThreadId,
        providerTurnId,
        responseStreamPosition: positioned.streamPosition,
      });

    const projected = this.#registry.threadByOwnedId(registered.threadId);
    if (
      !turnAdmissionSuperseded && (
        projected === null ||
        projected.activeTurn?.id !== turnId ||
        this.#registry.rawTurnIdByOwnedId(turnId) !== providerTurnId
      )
    ) {
      throw new SessionServiceError(
        "protocol_error",
        "The harness actor turn did not install under its exact gateway identity.",
        false,
        "restartRuntime",
      );
    }
    return Object.freeze({
      generation: positioned.generation,
      providerTurnId,
      quotaProof: "quotaProof" in positioned.output.turn
        ? positioned.output.turn.quotaProof ?? null
        : null,
      status: positioned.output.turn.status,
      streamPosition: positioned.streamPosition,
      threadId: registered.threadId,
      turnId,
    });
  }

  /**
   * Consumes only the stable, exhaustive actor-turn reconciliation result.
   * Pending or ambiguous scans never call this boundary, so an old-root lease
   * remains held until the provider effect is definitively absent, terminal,
   * or attached to its exact active provider turn.
   */
  settleHarnessActorTurnWorkspaceAdmission(
    input: SessionHarnessActorTurnWorkspaceReconciliation,
  ): void {
    validateClientUserMessageId(input.clientUserMessageId);
    if (!Number.isSafeInteger(input.expectedGeneration) || input.expectedGeneration < 1) {
      throw new SessionServiceError(
        "invalid_request",
        "The actor turn reconciliation generation is invalid.",
        false,
        "none",
      );
    }
    const key = ambiguousExecutionWorkspaceLeaseKey(input);
    const lease = this.#ambiguousExecutionWorkspaceLeaseByRequest.get(key);
    if (lease === undefined) return;
    if (
      lease.generation !== input.expectedGeneration ||
      this.#activeRuntimeGenerations.get(input.accountProfileId) !==
        input.expectedGeneration
    ) {
      throw new SessionServiceError(
        "conflict",
        "The actor turn reconciliation crossed a runtime generation.",
        true,
        "retry",
      );
    }
    if (input.disposition === "notApplied" || input.disposition === "terminal") {
      this.#releaseAmbiguousExecutionWorkspaceLease(key);
      return;
    }
    const providerTurnId = input.providerTurnId;
    if (providerTurnId === undefined || providerTurnId.length === 0) {
      throw new SessionServiceError(
        "protocol_error",
        "Active actor reconciliation omitted its provider turn identity.",
        false,
        "restartRuntime",
      );
    }
    const turnId = ownedCodexId("turn", input.accountProfileId, providerTurnId);
    if (this.#executionWorkspaceLeaseByTurn.has(turnId)) {
      throw new SessionServiceError(
        "protocol_error",
        "Actor reconciliation duplicated a turn workspace admission.",
        false,
        "restartRuntime",
      );
    }
    if (this.#exactProviderTurnIsTerminal({
      accountProfileId: input.accountProfileId,
      providerThreadId: lease.providerThreadId,
      providerTurnId,
    })) {
      // A terminal notification won the race with reconciliation before the
      // client-message identity could be attached to this lease.
      this.#releaseAmbiguousExecutionWorkspaceLease(key);
      return;
    }
    this.#ambiguousExecutionWorkspaceLeaseByRequest.delete(key);
    this.#executionWorkspaceLeaseByTurn.set(turnId, Object.freeze({
      accountProfileId: lease.accountProfileId,
      release: lease.release,
      threadId: lease.threadId,
    }));
  }

  /**
   * Projects the only two identities renderer chat attachment needs. Account,
   * generation, provider configuration, workspace path, and source stay private.
   */
  readHarnessActorChatAttachment(input: Readonly<{
    accountProfileId: AccountSummary["id"];
    expectedGeneration: number;
    providerThreadId: string;
  }>): SessionHarnessActorChatAttachment | null {
    try {
      const registered = this.#requireHarnessActorThread({
        kind: "provider",
        accountProfileId: input.accountProfileId,
        providerThreadId: input.providerThreadId,
      }, input.expectedGeneration);
      return Object.freeze({
        threadId: registered.threadId,
        restartThreadId: registered.providerThreadId,
      });
    } catch {
      return null;
    }
  }

  /**
   * Resolves a provider-private actor turn to the gateway-owned identity used
   * by ChatService events. The registration and generation must still match;
   * no account, provider, workspace, or path data crosses the return boundary.
   */
  readHarnessActorChatTurnAttachment(input: Readonly<{
    accountProfileId: AccountSummary["id"];
    expectedGeneration: number;
    providerThreadId: string;
    providerTurnId: string;
  }>): SessionHarnessActorChatTurnAttachment | null {
    try {
      const registered = this.#requireHarnessActorThread({
        kind: "provider",
        accountProfileId: input.accountProfileId,
        providerThreadId: input.providerThreadId,
      }, input.expectedGeneration);
      const turnId = ownedCodexId(
        "turn",
        input.accountProfileId,
        input.providerTurnId,
      );
      if (
        this.#registry.threadByOwnedId(registered.threadId) === null ||
        this.#registry.rawTurnIdByOwnedId(turnId) !== input.providerTurnId
      ) return null;
      return Object.freeze({ threadId: registered.threadId, turnId });
    } catch {
      return null;
    }
  }

  /**
   * Resolves an already-owned SessionService event against one private actor
   * thread. This remains valid for a terminal turn after raw turn routing has
   * been retired because the terminal projection retains its owned identity.
   */
  readHarnessActorChatEventAttachment(input: Readonly<{
    accountProfileId: AccountSummary["id"];
    expectedGeneration: number;
    providerThreadId: string;
    threadId: ThreadSummary["id"];
    turnId: string;
  }>): SessionHarnessActorChatEventAttachment | null {
    try {
      const registered = this.#requireHarnessActorThread({
        kind: "provider",
        accountProfileId: input.accountProfileId,
        providerThreadId: input.providerThreadId,
      }, input.expectedGeneration);
      const projected = this.#registry.threadByOwnedId(registered.threadId);
      if (
        registered.threadId !== input.threadId ||
        projected?.activeTurn?.id !== input.turnId
      ) return null;
      return Object.freeze({
        threadId: registered.threadId,
        turnId: projected.activeTurn.id,
      });
    } catch {
      return null;
    }
  }

  /**
   * Uses the gateway's owned-thread reverse index to name exactly one actor
   * before the renderer consults durable authority. No workspace or project
   * metadata crosses this internal capability.
   */
  readHarnessActorChatEventRoute(input: Readonly<{
    accountProfileId: AccountSummary["id"];
    threadId: ThreadSummary["id"];
    turnId: string;
  }>): SessionHarnessActorChatEventRoute | null {
    try {
      const indexed = this.#harnessActorThreadsByOwnedId.get(input.threadId);
      if (
        indexed === undefined ||
        indexed.accountProfileId !== input.accountProfileId
      ) return null;
      const registered = this.#requireHarnessActorThread({
        kind: "gateway",
        threadId: input.threadId,
      }, indexed.generation, indexed.actorId);
      const projected = this.#registry.threadByOwnedId(registered.threadId);
      if (projected?.activeTurn?.id !== input.turnId) return null;
      return Object.freeze({
        actorId: registered.actorId,
        admissionGeneration: registered.admissionGeneration,
        generation: registered.generation,
        providerThreadId: registered.providerThreadId,
        threadId: registered.threadId,
        turnId: projected.activeTurn.id,
      });
    } catch {
      return null;
    }
  }

  /**
   * Reads one terminal quota attempt's complete model-visible text history.
   * Registration is checked before and after two exhaustive scans, and the
   * returned transient value contains no reasoning, tool, or commentary item.
   */
  async readHarnessActorContinuationHistory(input: Readonly<{
    actorId: string;
    accountProfileId: AccountSummary["id"];
    expectedGeneration: number;
    providerThreadId: string;
    providerTurnId: string;
  }>): Promise<SessionHarnessActorContinuationHistory> {
    validateHarnessActorId(input.actorId);
    const reference = {
      kind: "provider" as const,
      accountProfileId: input.accountProfileId,
      providerThreadId: input.providerThreadId,
    };
    const registeredBefore = this.#requireHarnessActorThread(
      reference,
      input.expectedGeneration,
      input.actorId,
    );
    let sourceStreamPosition: CodexStreamPosition | null = null;
    const accept = <Output>(
      positioned: PinnedCodexResponseAtPosition<Output>,
    ): Output => {
      this.#assertHarnessGeneration(input.accountProfileId, input.expectedGeneration);
      if (
        positioned.generation !== input.expectedGeneration ||
        (sourceStreamPosition !== null && positioned.streamPosition <= sourceStreamPosition)
      ) {
        throw new SessionServiceError(
          "conflict",
          "The actor history generation or response order changed.",
          true,
          "retry",
        );
      }
      sourceStreamPosition = positioned.streamPosition;
      return positioned.output;
    };
    const reader = {
      threadTurnsList: async (request: PinnedCodexRequestInput<"threadTurnsList">) =>
        accept(await this.#commands.threadTurnsList(
          input.accountProfileId,
          request,
          input.expectedGeneration,
        )),
      threadItemsList: async (request: PinnedCodexRequestInput<"threadItemsList">) =>
        accept(await this.#commands.threadItemsList(
          input.accountProfileId,
          request,
          input.expectedGeneration,
        )),
    };
    const first = await scanPinnedCodexTurns(reader, input.providerThreadId);
    const second = await scanPinnedCodexTurns(reader, input.providerThreadId);
    const registeredAfter = this.#requireHarnessActorThread(
      reference,
      input.expectedGeneration,
      input.actorId,
    );
    if (registeredAfter !== registeredBefore || sourceStreamPosition === null) {
      throw new SessionServiceError(
        "conflict",
        "The actor history registration changed while it was being read.",
        true,
        "retry",
      );
    }
    return projectHarnessActorContinuationHistory({
      accountProfileId: input.accountProfileId,
      expectedProviderThreadId: input.providerThreadId,
      expectedProviderTurnId: input.providerTurnId,
      first,
      second,
    });
  }

  /**
   * Appends a previously verified text-only history to one exact fresh actor
   * incarnation. The empty protocol response is not treated as readback.
   */
  async injectHarnessActorContinuationHistory(input: Readonly<{
    actorId: string;
    accountProfileId: AccountSummary["id"];
    expectedGeneration: number;
    providerThreadId: string;
    history: SessionHarnessActorContinuationHistory;
  }>): Promise<Readonly<{
    generation: number;
    streamPosition: CodexStreamPosition;
  }>> {
    validateHarnessActorId(input.actorId);
    const history = validateHarnessActorContinuationHistory(input.history);
    const reference = {
      kind: "provider" as const,
      accountProfileId: input.accountProfileId,
      providerThreadId: input.providerThreadId,
    };
    const registeredBefore = this.#requireHarnessActorThread(
      reference,
      input.expectedGeneration,
      input.actorId,
    );
    const projected = this.#registry.threadByOwnedId(registeredBefore.threadId);
    if (projected === null || projected.activeTurn !== null) {
      throw new SessionServiceError(
        "conflict",
        "The continuation target is not a fresh idle actor thread.",
        true,
        "retry",
      );
    }
    const positioned = await this.#commands.threadInjectItems(
      input.accountProfileId,
      {
        threadId: input.providerThreadId,
        items: history.items.map((item) => item.role === "user"
          ? {
              type: "message" as const,
              role: "user" as const,
              content: [{ type: "input_text" as const, text: item.text }],
            }
          : {
              type: "message" as const,
              role: "assistant" as const,
              content: [{ type: "output_text" as const, text: item.text }],
            }),
      },
      input.expectedGeneration,
    );
    const registeredAfter = this.#requireHarnessActorThread(
      reference,
      input.expectedGeneration,
      input.actorId,
    );
    if (
      registeredAfter !== registeredBefore ||
      positioned.generation !== input.expectedGeneration
    ) {
      throw new SessionServiceError(
        "conflict",
        "The continuation target changed while history was being injected.",
        true,
        "retry",
      );
    }
    return Object.freeze({
      generation: positioned.generation,
      streamPosition: positioned.streamPosition,
    });
  }

  /**
   * Uses the pinned full-history codec for `thread/read(includeTurns:true)`.
   * The ordinary thread codec deliberately omits user text and message phase,
   * so it cannot prove an injection. Two exact full-history reads must agree.
   */
  async verifyHarnessActorContinuationHistory(input: Readonly<{
    actorId: string;
    accountProfileId: AccountSummary["id"];
    expectedGeneration: number;
    providerThreadId: string;
    history: SessionHarnessActorContinuationHistory;
  }>): Promise<SessionHarnessActorHistoryReadback> {
    validateHarnessActorId(input.actorId);
    const history = validateHarnessActorContinuationHistory(input.history);
    const reference = {
      kind: "provider" as const,
      accountProfileId: input.accountProfileId,
      providerThreadId: input.providerThreadId,
    };
    const registeredBefore = this.#requireHarnessActorThread(
      reference,
      input.expectedGeneration,
      input.actorId,
    );
    const read = async () => await this.#commands.threadHistoryRead(
      input.accountProfileId,
      { threadId: input.providerThreadId, includeTurns: true },
      input.expectedGeneration,
    );
    const first = await read();
    const second = await read();
    const registeredAfter = this.#requireHarnessActorThread(
      reference,
      input.expectedGeneration,
      input.actorId,
    );
    if (
      registeredAfter !== registeredBefore ||
      first.generation !== input.expectedGeneration ||
      second.generation !== input.expectedGeneration ||
      second.streamPosition <= first.streamPosition ||
      first.output.thread.id !== input.providerThreadId ||
      second.output.thread.id !== input.providerThreadId
    ) {
      throw new SessionServiceError(
        "conflict",
        "The continuation readback fence changed.",
        true,
        "retry",
      );
    }
    const firstRawDigest = harnessActorHistoryReadEvidenceDigest(first.output);
    const secondRawDigest = harnessActorHistoryReadEvidenceDigest(second.output);
    if (firstRawDigest !== secondRawDigest) {
      return Object.freeze({
        kind: "unavailable",
        streamPosition: second.streamPosition,
      });
    }
    if (first.output.thread.turns.length === 0) {
      return Object.freeze({
        kind: "empty",
        rawEvidenceDigest: firstRawDigest,
        streamPosition: second.streamPosition,
      });
    }
    const readback = projectHarnessActorHistoryReadback(first.output);
    if (readback === null) {
      return Object.freeze({
        kind: "mismatched",
        rawEvidenceDigest: firstRawDigest,
        streamPosition: second.streamPosition,
      });
    }
    const readbackDigest = digestHarnessActorHistory(readback);
    return readbackDigest === history.historyDigest &&
        harnessActorHistoriesEqual(readback, history.items)
      ? Object.freeze({
          kind: "matched" as const,
          historyDigest: readbackDigest,
          rawEvidenceDigest: firstRawDigest,
          streamPosition: second.streamPosition,
        })
      : Object.freeze({
          kind: "mismatched" as const,
          rawEvidenceDigest: firstRawDigest,
          streamPosition: second.streamPosition,
        });
  }

  /**
   * Resolves one dynamic-tool caller against the live generation and the
   * gateway registry. Mismatches return null without exposing which private
   * provider identity failed.
   */
  resolveHarnessCaller(
    accountProfileId: AccountSummary["id"],
    generation: number,
    providerThreadId: string,
    providerTurnId: string,
  ): SessionHarnessCallerIdentity | null {
    if (
      !Number.isSafeInteger(generation) ||
      generation <= 0 ||
      this.#activeRuntimeGenerations.get(accountProfileId) !== generation
    ) return null;
    const binding = this.#registry.bindingByCodexId(accountProfileId, providerThreadId);
    if (binding === null) return null;
    const threadId = ownedCodexId("thread", accountProfileId, providerThreadId);
    const turnId = ownedCodexId("turn", accountProfileId, providerTurnId);
    const thread = this.#registry.threadByOwnedId(threadId);
    const project = this.#registry.projectById(binding.projectId);
    if (
      thread === null ||
      project === null ||
      thread.accountProfileId !== accountProfileId ||
      thread.projectId !== binding.projectId ||
      thread.workspaceLaneId !== binding.workspaceLaneId ||
      thread.activeTurn?.id !== turnId ||
      thread.activeTurn.status !== "active" ||
      this.#registry.rawTurnIdByOwnedId(turnId) !== providerTurnId ||
      project.displayPath !== binding.cwd
    ) return null;
    return Object.freeze({
      generation,
      projectId: binding.projectId,
      threadId,
      turnId,
      workspaceLaneId: binding.workspaceLaneId,
      workspaceMode: binding.laneMode,
      workspacePath: binding.cwd,
    });
  }

  /**
   * Reads the strict completed prefix before one currently active caller turn.
   * Two exhaustive ordered paging scans must agree exactly before any provider
   * text becomes authoritative transcript content.
   */
  async readHarnessCompletedHistory(
    threadId: ThreadSummary["id"],
    throughTurnId: string,
    expectedGeneration: number,
    signal: AbortSignal,
  ): Promise<SessionHarnessCompletedHistory> {
    return (await this.#readHarnessContextView(
      threadId,
      throughTurnId,
      expectedGeneration,
      signal,
      false,
    )).completedHistory;
  }

  /**
   * Reads one coherent admission view while keeping the current user message
   * outside the completed-prefix value. Both results share the same stable
   * double-scan witness and final stream position.
   */
  async readHarnessContextAdmission(
    threadId: ThreadSummary["id"],
    throughTurnId: string,
    expectedGeneration: number,
    signal: AbortSignal,
  ): Promise<SessionHarnessContextAdmission> {
    const view = await this.#readHarnessContextView(
      threadId,
      throughTurnId,
      expectedGeneration,
      signal,
      true,
    );
    if (view.currentInput === null) {
      throw new SessionServiceError(
        "conflict",
        "The current harness input is not available.",
        true,
        "retry",
      );
    }
    return Object.freeze({
      completedHistory: view.completedHistory,
      currentInput: view.currentInput,
    });
  }

  async #readHarnessContextView(
    threadId: ThreadSummary["id"],
    throughTurnId: string,
    expectedGeneration: number,
    signal: AbortSignal,
    requireCurrentInput: boolean,
  ): Promise<Readonly<{
    completedHistory: SessionHarnessCompletedHistory;
    currentInput: SessionHarnessCurrentInput | null;
  }>> {
    throwIfHarnessHistoryAborted(signal);
    if (!Number.isSafeInteger(expectedGeneration) || expectedGeneration <= 0) {
      throw new SessionServiceError(
        "invalid_request",
        "The history generation is invalid.",
        false,
        "none",
      );
    }
    const binding = this.#registry.requireBinding(threadId);
    if (this.#activeRuntimeGenerations.get(binding.accountProfileId) !== expectedGeneration) {
      throw new SessionServiceError(
        "conflict",
        "The Codex runtime generation changed before history could be read.",
        true,
        "retry",
      );
    }
    const thread = this.#registry.threadByOwnedId(threadId);
    const currentProviderTurnId = this.#registry.rawTurnIdByOwnedId(throughTurnId);
    if (
      thread === null ||
      thread.activeTurn?.id !== throughTurnId ||
      thread.activeTurn.status !== "active" ||
      currentProviderTurnId === null
    ) {
      throw new SessionServiceError(
        "conflict",
        "The harness caller turn is no longer active.",
        true,
        "retry",
      );
    }

    let sourceStreamPosition: CodexStreamPosition | null = null;
    const acceptPositionedPage = <Output>(
      positioned: PinnedCodexResponseAtPosition<Output>,
    ): Output => {
      throwIfHarnessHistoryAborted(signal);
      if (
        positioned.generation !== expectedGeneration ||
        this.#activeRuntimeGenerations.get(binding.accountProfileId) !== expectedGeneration
      ) {
        throw new SessionServiceError(
          "conflict",
          "The Codex runtime generation changed while history was being read.",
          true,
          "retry",
        );
      }
      if (
        sourceStreamPosition !== null &&
        positioned.streamPosition <= sourceStreamPosition
      ) {
        throw new SessionServiceError(
          "protocol_error",
          "Codex returned non-monotonic history evidence.",
          false,
          "restartRuntime",
        );
      }
      sourceStreamPosition = positioned.streamPosition;
      return positioned.output;
    };
    const reader = {
      threadTurnsList: async (input: PinnedCodexRequestInput<"threadTurnsList">) => {
        throwIfHarnessHistoryAborted(signal);
        return acceptPositionedPage(await this.#commands.threadTurnsList(
          binding.accountProfileId,
          input,
          expectedGeneration,
        ));
      },
      threadItemsList: async (input: PinnedCodexRequestInput<"threadItemsList">) => {
        throwIfHarnessHistoryAborted(signal);
        return acceptPositionedPage(await this.#commands.threadItemsList(
          binding.accountProfileId,
          input,
          expectedGeneration,
        ));
      },
    };
    const first = await scanPinnedCodexTurns(reader, binding.codexThreadId);
    const second = await scanPinnedCodexTurns(reader, binding.codexThreadId);
    throwIfHarnessHistoryAborted(signal);
    if (sourceStreamPosition === null) {
      throw new SessionServiceError(
        "protocol_error",
        "Codex returned no history evidence.",
        false,
        "restartRuntime",
      );
    }
    const projectionInput = {
      accountProfileId: binding.accountProfileId,
      expectedThreadId: threadId,
      throughTurnId,
      currentProviderTurnId,
      first,
      second,
      sourceGeneration: expectedGeneration,
      sourceStreamPosition,
    } as const;
    return Object.freeze({
      completedHistory: projectHarnessCompletedHistory(projectionInput),
      currentInput: requireCurrentInput
        ? projectHarnessCurrentInput(projectionInput)
        : null,
    });
  }

  #consumeCodexFacts(
    facts: readonly CodexFact[],
    preference?: SessionThreadObservationPreference,
  ): boolean {
    const { accepted } = this.#store.dispatchAcceptedBatch(facts);
    let handled = false;
    for (const fact of accepted) {
      handled = this.#consumeCodexFact(fact, preference) || handled;
    }
    return handled;
  }

  #publishHydrationFailure(
    accountProfileId: string,
    generation: number,
    result: SessionHydrationRunResult,
  ): void {
    if (
      result.kind !== "failed" ||
      this.#activeRuntimeGenerations.get(accountProfileId) !== generation ||
      this.#reportedHydrationFailureGenerations.get(accountProfileId) === generation
    ) return;
    this.#reportedHydrationFailureGenerations.set(accountProfileId, generation);
    const event: SessionHydrationFailure = {
      accountProfileId,
      action: "restartRuntime",
      attempts: result.attempts,
      generation,
      reason: result.reason,
      recoveringThreadCount: result.recoveringThreadIds.length,
    };
    try {
      void Promise.resolve(this.#onHydrationFailure(event)).catch(() => undefined);
    } catch {
      // Recovery observation cannot weaken the generation fence or fact store.
    }
  }

  /** Trusted gateway inspection used by deterministic recovery tests only. */
  execute(command: SessionCommand): Promise<SessionCommandResult> {
    switch (command.type) {
      case "thread.list":
        return this.#listThreads(command.accountProfileId, command.projectId);
      case "thread.resume":
        return this.#resumeThread(command.threadId);
      default:
        return assertNever(command);
    }
  }

  async startThread(request: SessionThreadStartRequest): Promise<SessionThreadStartResult> {
    validateLaunchTitle(request.title);
    const project = await this.#registerProject(request.workspacePath);
    const thread = await this.#startThread({
      accountProfileId: request.accountProfileId,
      laneMode: request.workspaceMode,
      model: "gpt-5.6-sol",
      projectId: project.id,
      serviceTier: request.serviceTier ?? "standard",
      title: request.title,
    });
    return { project, thread };
  }

  async startInitialTurn(request: SessionTurnStartRequest): Promise<ThreadSummary> {
    validateLaunchText(request.clientUserMessageId, request.prompt);
    await this.#startTurn({
      clientUserMessageId: request.clientUserMessageId,
      input: [{ type: "text", text: request.prompt }],
      model: "gpt-5.6-sol",
      reasoningEffort: request.reasoningEffort ?? "max",
      serviceTier: request.serviceTier ?? "standard",
      threadId: request.threadId,
    });
    const thread = this.#registry.threadByOwnedId(request.threadId);
    if (thread === null) throw new Error("Started session is missing its owned projection");
    return thread;
  }

  async resolveChatConfiguration(
    accountProfileId: AccountSummary["id"],
    candidates: readonly SessionChatConfigurationCandidate[],
    requiredInputClass: "text" | "image" = "text",
  ): Promise<SessionResolvedChatConfiguration> {
    if (candidates.length === 0 || candidates.length > 8) {
      throw new SessionServiceError(
        "protocol_error",
        "HRA supplied an invalid root routing candidate chain.",
        false,
        "none",
      );
    }
    if (requiredInputClass !== "text" && requiredInputClass !== "image") {
      throw new SessionServiceError(
        "protocol_error",
        "HRA supplied an invalid required input class.",
        false,
        "none",
      );
    }
    const byModel = new Map<string, Readonly<{
      observedInputModalities: readonly ("text" | "image")[] | null;
      reasoningEfforts: readonly string[];
      serviceTiers: readonly string[];
    }>>();
    let expectedGeneration: number | null = null;
    let cursor: string | null = null;
    const seenCursors = new Set<string>();
    let complete = false;
    for (let page = 0; page < 8; page += 1) {
      const response = await this.#commands.modelList(accountProfileId, {
        cursor,
        limit: 256,
        includeHidden: true,
      }, expectedGeneration ?? undefined);
      if (expectedGeneration === null) {
        expectedGeneration = response.generation;
      } else if (response.generation !== expectedGeneration) {
        throw new SessionServiceError(
          "protocol_error",
          "Codex changed generation while listing the model catalog.",
          false,
          "restartRuntime",
        );
      }
      for (const entry of response.output.data) {
        const normalized = Object.freeze({
          observedInputModalities: entry.inputModalities === null
            ? null
            : Object.freeze([...entry.inputModalities].toSorted()),
          reasoningEfforts: Object.freeze(
            [...new Set(entry.supportedReasoningEfforts.map(
              ({ reasoningEffort: effort }) => effort,
            ))].toSorted(),
          ),
          serviceTiers: Object.freeze(
            [...new Set(entry.serviceTiers.map(({ id }) => id))].toSorted(),
          ),
        });
        const previous = byModel.get(entry.model);
        if (
          previous !== undefined &&
          JSON.stringify(previous) !== JSON.stringify(normalized)
        ) {
          throw new SessionServiceError(
            "protocol_error",
            "Codex returned conflicting capability rows for one model.",
            false,
            "restartRuntime",
          );
        }
        byModel.set(entry.model, normalized);
      }
      const nextCursor = response.output.nextCursor;
      if (nextCursor === null) {
        complete = true;
        break;
      }
      if (seenCursors.has(nextCursor)) {
        throw new SessionServiceError(
          "protocol_error",
          "Codex returned a cyclic model catalog.",
          false,
          "restartRuntime",
        );
      }
      seenCursors.add(nextCursor);
      cursor = nextCursor;
    }
    if (!complete) {
      throw new SessionServiceError(
        "protocol_error",
        "Codex model catalog exceeded the bounded page limit.",
        false,
        "restartRuntime",
      );
    }
    if (expectedGeneration === null) {
      throw new SessionServiceError(
        "protocol_error",
        "Codex returned no model-catalog generation.",
        false,
        "restartRuntime",
      );
    }
    const models = Object.freeze([...byModel.entries()]
      .map(([model, capability]) => Object.freeze({ model, ...capability }))
      .toSorted((left, right) => left.model.localeCompare(right.model)));
    const hasher = new Bun.CryptoHasher("sha256");
    hasher.update("hra.chat.model-catalog.v2\0");
    hasher.update(JSON.stringify({ generation: expectedGeneration, models }));
    const catalogDigest = hasher.digest("hex");
    const catalog = Object.freeze({
      accountProfileId,
      catalogDigest,
      generation: expectedGeneration,
      models,
    });
    this.#chatCatalogsByEvidence.set(
      chatCatalogEvidenceKey(accountProfileId, expectedGeneration, catalogDigest),
      catalog,
    );
    for (const candidate of candidates) {
      const capability = byModel.get(candidate.model);
      if (
        capability !== undefined &&
        capability.reasoningEfforts.includes(candidate.reasoningEffort) &&
        supportsRequiredInput(capability.observedInputModalities, requiredInputClass) &&
        (
          candidate.serviceTier === "standard" ||
          capability.serviceTiers.includes("fast")
        )
      ) {
        return Object.freeze({
          ...candidate,
          catalogGeneration: expectedGeneration,
          catalogDigest,
          observedInputModalities: capability.observedInputModalities,
        });
      }
    }
    throw new SessionServiceError(
      "capability_unavailable",
      "No HRA root routing candidate is available for this account.",
      false,
      "none",
    );
  }

  async interpretChatSchedule(
    request: SessionChatScheduleInterpretationRequest,
  ): Promise<SessionChatScheduleInterpretation> {
    validateScheduleInterpretationRequest(request);
    const runtime = await this.#accounts.ensureSessionRuntime(
      request.accountProfileId,
    );
    const temporaryRoot = await mkdtemp(join(tmpdir(), "hra-schedule-interpreter-"));
    const isolatedRoot = await realpath(temporaryRoot);
    let rawThreadId: string | null = null;
    try {
      const policyProof = await this.#preflightScheduleInterpreterExecutionPolicy(
        request.accountProfileId,
        runtime.generation,
      );
      const disabledMcpServerNames = await this.#scheduleInterpreterMcpServerNames(
        request.accountProfileId,
        runtime.generation,
      );
      const threadStartInput: PinnedCodexRequestInput<
        "scheduleInterpreterThreadStart"
      > = {
        model: "gpt-5.6-luna",
        allowProviderModelFallback: false,
        serviceTier: null,
        cwd: isolatedRoot,
        runtimeWorkspaceRoots: [isolatedRoot],
        approvalPolicy: HRA_SCHEDULE_INTERPRETER_EXECUTION_POLICY.approvalPolicy,
        approvalsReviewer: HRA_SCHEDULE_INTERPRETER_EXECUTION_POLICY.approvalsReviewer,
        sandbox: HRA_SCHEDULE_INTERPRETER_EXECUTION_POLICY.threadSandbox,
        config: scheduleInterpreterThreadConfig(disabledMcpServerNames),
        developerInstructions: chatScheduleDeveloperInstructions,
        ephemeral: true,
        historyMode: "paginated",
        threadSource: "appServer",
        environments: [],
        selectedCapabilityRoots: [],
      };
      const thread = await this.#commands.scheduleInterpreterThreadStart(
        request.accountProfileId,
        threadStartInput,
        policyProof.generation,
      );
      rawThreadId = thread.output.thread.id;
      let threadReceipt: ScheduleInterpreterExecutionPolicyReceipt;
      try {
        threadReceipt = verifyScheduleInterpreterThreadAdmission({
          proof: policyProof,
          generation: thread.generation,
          streamPosition: thread.streamPosition,
          isolatedRoot,
          disabledMcpServerNames,
          developerInstructions: chatScheduleDeveloperInstructions,
          request: threadStartInput,
          response: thread.output,
        });
      } catch {
        throw new SessionServiceError(
          "protocol_error",
          "Codex did not preserve HRA's no-tool schedule-interpreter policy.",
          false,
          "restartRuntime",
        );
      }
      await this.#requireScheduleInterpreterHasNoMcpTools({
        accountProfileId: request.accountProfileId,
        generation: runtime.generation,
        rawThreadId,
        afterPosition: thread.streamPosition,
      });
      const turnProof = await this.#preflightScheduleInterpreterExecutionPolicy(
        request.accountProfileId,
        runtime.generation,
      );
      const clientUserMessageId = scheduleInterpreterMessageId(request);
      const turnStartInput: PinnedCodexRequestInput<"turnStart"> = {
        threadId: rawThreadId,
        clientUserMessageId,
        input: [{
          type: "text",
          text: JSON.stringify({
            currentInstant: request.now,
            instruction: request.instruction,
            timeZone: request.timeZone,
          }),
          text_elements: [],
        }],
        environments: [],
        cwd: isolatedRoot,
        runtimeWorkspaceRoots: [isolatedRoot],
        approvalPolicy: HRA_SCHEDULE_INTERPRETER_EXECUTION_POLICY.approvalPolicy,
        approvalsReviewer: HRA_SCHEDULE_INTERPRETER_EXECUTION_POLICY.approvalsReviewer,
        sandboxPolicy: HRA_SCHEDULE_INTERPRETER_EXECUTION_POLICY.turnSandboxPolicy,
        model: "gpt-5.6-luna",
        effort: "medium",
        serviceTier: null,
        outputSchema: chatScheduleOutputSchema,
        collaborationMode: {
          mode: "plan",
          settings: {
            model: "gpt-5.6-luna",
            reasoning_effort: "medium",
            developer_instructions: chatScheduleDeveloperInstructions,
          },
        },
      };
      const turn = await this.#commands.turnStart(
        request.accountProfileId,
        turnStartInput,
        turnProof.generation,
      );
      try {
        verifyScheduleInterpreterTurnAdmission({
          proof: turnProof,
          threadReceipt,
          generation: turn.generation,
          streamPosition: turn.streamPosition,
          threadId: rawThreadId,
          developerInstructions: chatScheduleDeveloperInstructions,
          request: turnStartInput,
        });
      } catch {
        throw new SessionServiceError(
          "protocol_error",
          "Codex did not preserve HRA's no-tool schedule-interpreter turn policy.",
          false,
          "restartRuntime",
        );
      }
      return await this.#readScheduleInterpretation({
        accountProfileId: request.accountProfileId,
        generation: runtime.generation,
        rawThreadId,
        rawTurnId: turn.output.turn.id,
      });
    } finally {
      try {
        if (rawThreadId !== null) {
          await this.#commands.threadArchive(
            request.accountProfileId,
            { threadId: rawThreadId },
            runtime.generation,
          );
        }
      } finally {
        await rm(isolatedRoot, { recursive: true, force: true });
      }
    }
  }

  async #readScheduleInterpretation(input: Readonly<{
    accountProfileId: AccountSummary["id"];
    generation: number;
    rawThreadId: string;
    rawTurnId: string;
  }>): Promise<SessionChatScheduleInterpretation> {
    const deadline = Date.now() + 90_000;
    let delayMilliseconds = 50;
    for (let attempt = 0; attempt < 128 && Date.now() < deadline; attempt += 1) {
      const observed = await this.#commands.threadHistoryRead(
        input.accountProfileId,
        { threadId: input.rawThreadId, includeTurns: true },
        input.generation,
      );
      if (observed.generation !== input.generation) {
        throw new SessionServiceError(
          "protocol_error",
          "The schedule interpreter changed runtime generation.",
          false,
          "restartRuntime",
        );
      }
      const turn = observed.output.thread.turns.find(
        ({ id }) => id === input.rawTurnId,
      );
      if (turn !== undefined && turn.status !== "inProgress") {
        if (turn.status !== "completed") {
          throw new SessionServiceError(
            "invalid_request",
            "The prompt could not be interpreted as a recurring schedule.",
            false,
            "none",
          );
        }
        const finalItems = turn.items.filter((item) =>
          item.type === "agentMessage"
          && item.phase === "final_answer"
          && item.context.kind === "plainTextFinal"
        );
        const unexpectedItems = turn.items.filter((item) =>
          item.type !== "userMessage" &&
          item.type !== "reasoning" &&
          !(
            item.type === "agentMessage" &&
            item.phase === "final_answer" &&
            item.context.kind === "plainTextFinal"
          )
        );
        if (finalItems.length !== 1 || unexpectedItems.length !== 0) {
          throw new SessionServiceError(
            "protocol_error",
            "The schedule interpreter produced an unexpected tool or control item.",
            false,
            "restartRuntime",
          );
        }
        let parsedJson: unknown;
        try {
          parsedJson = JSON.parse(finalItems[0]?.text ?? "") as unknown;
        } catch {
          throw new SessionServiceError(
            "invalid_request",
            "The prompt could not be interpreted as a recurring schedule.",
            false,
            "none",
          );
        }
        const parsed = chatScheduleInterpretationSchema.safeParse(parsedJson);
        if (!parsed.success) {
          throw new SessionServiceError(
            "invalid_request",
            "The prompt could not be interpreted as a recurring schedule.",
            false,
            "none",
          );
        }
        return Object.freeze(parsed.data);
      }
      await new Promise<void>((resolve) => setTimeout(resolve, delayMilliseconds));
      delayMilliseconds = Math.min(delayMilliseconds * 2, 1_000);
    }
    throw new SessionServiceError(
      "runtime_unavailable",
      "The schedule interpreter did not finish in time.",
      true,
      "retry",
    );
  }

  /**
   * Reads one complete, exact-generation catalog for metaharness routing.
   * Catalog failure is never converted into proof that a profile is absent.
   */
  async readHarnessModelCatalog(
    accountProfileId: AccountSummary["id"],
    expectedGeneration: number,
  ): Promise<SessionHarnessModelCatalog> {
    this.#assertHarnessGeneration(accountProfileId, expectedGeneration);
    const byModel = new Map<string, SessionHarnessModelCatalog["models"][number]>();
    const seenCursors = new Set<string>();
    let cursor: string | null = null;
    for (let page = 0; page < 8; page += 1) {
      const positioned = await this.#commands.modelList(accountProfileId, {
        cursor,
        limit: 256,
        includeHidden: true,
      }, expectedGeneration);
      this.#assertHarnessGeneration(accountProfileId, expectedGeneration);
      if (positioned.generation !== expectedGeneration) {
        throw new SessionServiceError(
          "protocol_error",
          "Codex returned a model catalog from another runtime generation.",
          false,
          "restartRuntime",
        );
      }
      for (const entry of positioned.output.data) {
        const normalized = Object.freeze({
          modelId: entry.model,
          reasoningEfforts: Object.freeze(
            [...new Set(entry.supportedReasoningEfforts.map(
              ({ reasoningEffort }) => reasoningEffort,
            ))].toSorted(),
          ),
          serviceTiers: Object.freeze(
            [...new Set(entry.serviceTiers.map(({ id }) => id))].toSorted(),
          ),
        });
        const previous = byModel.get(normalized.modelId);
        if (previous !== undefined &&
          JSON.stringify(previous) !== JSON.stringify(normalized)) {
          throw new SessionServiceError(
            "protocol_error",
            "Codex returned conflicting capability rows for one model.",
            false,
            "restartRuntime",
          );
        }
        byModel.set(normalized.modelId, normalized);
      }
      const nextCursor = positioned.output.nextCursor;
      if (nextCursor === null) {
        const models = Object.freeze(
          [...byModel.values()].toSorted((left, right) =>
            left.modelId.localeCompare(right.modelId)),
        );
        const hasher = new Bun.CryptoHasher("sha256");
        hasher.update("hra.metaharness.model-catalog.v1\0");
        hasher.update(JSON.stringify({ generation: expectedGeneration, models }));
        return Object.freeze({
          evidenceDigest: hasher.digest("hex"),
          generation: expectedGeneration,
          models,
        });
      }
      if (seenCursors.has(nextCursor)) {
        throw new SessionServiceError(
          "protocol_error",
          "Codex returned a cyclic model catalog.",
          false,
          "restartRuntime",
        );
      }
      seenCursors.add(nextCursor);
      cursor = nextCursor;
    }
    throw new SessionServiceError(
      "protocol_error",
      "Codex model catalog exceeded the bounded page limit.",
      false,
      "restartRuntime",
    );
  }

  #requireChatCatalogEvidence(
    accountProfileId: string,
    generation: number,
    catalogDigest: string,
  ): RegisteredChatCatalog {
    const catalog = this.#chatCatalogsByEvidence.get(chatCatalogEvidenceKey(
      accountProfileId,
      generation,
      catalogDigest,
    ));
    if (
      catalog === undefined || catalog.generation !== generation ||
      catalog.catalogDigest !== catalogDigest ||
      this.#activeRuntimeGenerations.get(accountProfileId) !== generation
    ) {
      throw new SessionServiceError(
        "conflict",
        "The exact chat model catalog is no longer active.",
        true,
        "retry",
      );
    }
    return catalog;
  }

  #requireChatCatalogThreadSelection(
    catalog: RegisteredChatCatalog,
    request: Readonly<{
      model: "gpt-5.6-sol" | "gpt-5.6-luna";
      serviceTier: ChatServiceTier;
    }>,
  ): void {
    const capability = catalog.models.find(({ model }) => model === request.model);
    if (
      capability === undefined ||
      (request.serviceTier === "fast" && !capability.serviceTiers.includes("fast"))
    ) {
      throw new SessionServiceError(
        "capability_unavailable",
        "The chat thread configuration is absent from the exact model catalog.",
        false,
        "none",
      );
    }
  }

  async startChatThread(
    request: Omit<SessionThreadStartRequest, "serviceTier" | "workspaceMode"> &
      Readonly<{
        readonly model: "gpt-5.6-sol" | "gpt-5.6-luna";
        readonly serviceTier: ChatServiceTier;
        readonly catalogGeneration: number;
        readonly catalogDigest: string;
      }>,
  ): Promise<SessionChatThreadStartResult> {
    validateLaunchTitle(request.title);
    const catalog = this.#requireChatCatalogEvidence(
      request.accountProfileId,
      request.catalogGeneration,
      request.catalogDigest,
    );
    this.#requireChatCatalogThreadSelection(catalog, request);
    const project = await this.#registerProject(request.workspacePath);
    const thread = await this.#startThread({
      accountProfileId: request.accountProfileId,
      laneMode: "local",
      model: request.model,
      projectId: project.id,
      serviceTier: request.serviceTier,
      title: request.title,
      expectedGeneration: request.catalogGeneration,
    });
    const result = { project, thread };
    const binding = this.#registry.requireBinding(result.thread.id);
    return { ...result, restartThreadId: binding.codexThreadId };
  }

  async resumeChatThread(request: SessionChatThreadResumeRequest): Promise<ThreadSummary> {
    validateLaunchTitle(request.title);
    const catalog = this.#requireChatCatalogEvidence(
      request.accountProfileId,
      request.catalogGeneration,
      request.catalogDigest,
    );
    this.#requireChatCatalogThreadSelection(catalog, request);
    const project = await this.#registerProject(request.workspacePath);
    const expectedOwnedId = ownedCodexId(
      "thread",
      request.accountProfileId,
      request.restartThreadId,
    );
    if (expectedOwnedId !== request.threadId) {
      throw new SessionServiceError(
        "invalid_request",
        "The persisted chat identity does not match this Codex account.",
        false,
        "none",
      );
    }
    const existing = this.#registry.bindingByOwnedId(request.threadId);
    if (
      existing !== null &&
      (
        existing.accountProfileId !== request.accountProfileId ||
        existing.codexThreadId !== request.restartThreadId ||
        existing.cwd !== project.displayPath ||
        existing.laneMode !== "local"
      )
    ) {
      throw new SessionServiceError(
        "invalid_request",
        "The active chat binding conflicts with its persisted identity.",
        false,
        "none",
      );
    }
    const policyProof = await this.#preflightProductionExecutionPolicy(
      request.accountProfileId,
      request.catalogGeneration,
    );
    const executionWorkspace = this.#runtimeWorkspaceSnapshot(project.displayPath);
    const threadResumeInput: PinnedCodexRequestInput<"threadResume"> = {
      threadId: request.restartThreadId,
      model: request.model,
      serviceTier: codexServiceTier(request.serviceTier),
      cwd: project.displayPath,
      runtimeWorkspaceRoots: [...executionWorkspace.runtimeWorkspaceRoots],
      approvalPolicy: HRA_PRODUCTION_EXECUTION_POLICY.approvalPolicy,
      approvalsReviewer: HRA_PRODUCTION_EXECUTION_POLICY.approvalsReviewer,
      sandbox: HRA_PRODUCTION_EXECUTION_POLICY.threadSandbox,
      config: this.#executionThreadConfig(),
      developerInstructions: this.#executionDeveloperInstructions(),
    };
    const positioned = await this.#commands.threadResume(
      request.accountProfileId,
      threadResumeInput,
      policyProof.generation,
    );
    const { thread: raw } = positioned.output;
    if (
      raw.id !== request.restartThreadId ||
      raw.cwd !== project.displayPath ||
      ownedCodexId("thread", request.accountProfileId, raw.id) !== request.threadId
    ) {
      throw new SessionServiceError(
        "protocol_error",
        "Codex resumed a different chat than the persisted binding.",
        false,
        "restartRuntime",
      );
    }
    await this.#registerProductionThreadPolicy({
      accountProfileId: request.accountProfileId,
      proof: policyProof,
      positioned,
      request: threadResumeInput,
      executionSettingsRevision: executionWorkspace.revision,
    });
    const snapshotFacts = projectCodexThreadResponseFacts({
      accountProfileId: request.accountProfileId,
      generation: positioned.generation,
      origin: "reconciled",
      streamPosition: positioned.streamPosition,
    }, [{ archived: false, thread: raw, turns: "present" }]);
    this.#consumeCodexFacts(Object.freeze([
      ...snapshotFacts,
      ...confirmedOperationFacts({
        accountProfileId: request.accountProfileId,
        generation: positioned.generation,
        operation: "thread_resume",
        streamPosition: positioned.streamPosition,
        threadId: raw.id,
      }, snapshotFacts.length),
    ]), {
      accountProfileId: request.accountProfileId,
      laneMode: "local",
      preferredProject: project,
      preferredTitle: request.title,
      threadId: raw.id,
    });
    return this.#registry.requireObservedThread(request.accountProfileId, raw.id);
  }

  async setChatThreadName(threadId: ThreadSummary["id"], name: string): Promise<void> {
    validateLaunchTitle(name);
    const binding = this.#registry.requireBinding(threadId);
    const policy = this.#productionPolicyByThread.get(threadId);
    if (policy === undefined) {
      throw new SessionServiceError(
        "conflict",
        "The chat lacks an active generation-fenced thread admission.",
        true,
        "retry",
      );
    }
    await this.#commands.threadSetName(binding.accountProfileId, {
      threadId: binding.codexThreadId,
      name,
    }, policy.receipt.generation);
  }

  async injectChatHistory(
    threadId: ThreadSummary["id"],
    history: readonly SessionChatHistoryItem[],
  ): Promise<void> {
    if (history.length === 0 || history.length > 1_024) {
      throw new SessionServiceError(
        "invalid_request",
        "Chat handoff history is empty or too large.",
        false,
        "none",
      );
    }
    const binding = this.#registry.requireBinding(threadId);
    const policy = this.#productionPolicyByThread.get(threadId);
    if (policy === undefined) {
      throw new SessionServiceError(
        "conflict",
        "The chat lacks an active generation-fenced thread admission.",
        true,
        "retry",
      );
    }
    await this.#commands.threadInjectItems(binding.accountProfileId, {
      threadId: binding.codexThreadId,
      items: history.map((item) => item.role === "user"
        ? {
            type: "message" as const,
            role: "user" as const,
            content: [{ type: "input_text" as const, text: item.text }],
          }
        : {
            type: "message" as const,
            role: "assistant" as const,
            content: [{ type: "output_text" as const, text: item.text }],
          }),
    }, policy.receipt.generation);
  }

  async startChatTurn(request: SessionChatTurnStartRequest): Promise<SessionChatTurnStartResult> {
    const providerInput = "input" in request && request.input !== undefined
      ? validateChatProviderInput(request.clientUserMessageId, request.input)
      : (() => {
          const prompt = "prompt" in request ? request.prompt : undefined;
          if (prompt === undefined) {
            throw new SessionServiceError(
              "invalid_request",
              "The chat provider input is unavailable.",
              false,
              "none",
            );
          }
          validateLaunchText(request.clientUserMessageId, prompt);
          return Object.freeze([{ type: "text" as const, text: prompt }]);
        })();
    const catalog = this.#requireChatCatalogEvidence(
      this.#registry.requireBinding(request.threadId).accountProfileId,
      request.catalogGeneration,
      request.catalogDigest,
    );
    const capability = catalog.models.find((model) => model.model === request.model);
    const requiresImage = providerInput.some((item) => item.type === "localImage");
    if (
      capability === undefined ||
      capability.reasoningEfforts.includes(request.reasoningEffort) === false ||
      (request.serviceTier === "fast" && !capability.serviceTiers.includes("fast")) ||
      JSON.stringify(capability.observedInputModalities) !==
        JSON.stringify(request.observedInputModalities) ||
      !supportsRequiredInput(
        capability.observedInputModalities,
        requiresImage ? "image" : "text",
      )
    ) {
      throw new SessionServiceError(
        "capability_unavailable",
        "The selected chat input is not supported by the exact model catalog.",
        false,
        "none",
      );
    }
    const positioned = await this.#startTurn({
      clientUserMessageId: request.clientUserMessageId,
      input: providerInput,
      model: request.model,
      reasoningEffort: request.reasoningEffort,
      serviceTier: request.serviceTier,
      threadId: request.threadId,
      expectedGeneration: request.catalogGeneration,
    });
    const binding = this.#registry.requireBinding(request.threadId);
    const result = {
      threadId: request.threadId,
      turnId: ownedCodexId("turn", binding.accountProfileId, positioned.output.turn.id),
      generation: positioned.generation,
      streamPosition: positioned.streamPosition,
    };
    if (
      this.#productionPolicyByTurn.has(result.turnId) &&
      this.#executionWorkspaceLeaseByTurn.has(result.turnId)
    ) {
      this.#chatCapabilityByTurn.set(result.turnId, Object.freeze({
        accountProfileId: binding.accountProfileId,
        threadId: request.threadId,
        receipt: Object.freeze({
          catalogDigest: request.catalogDigest,
          generation: positioned.generation,
          model: request.model,
          observedInputModalities: capability.observedInputModalities,
          reasoningEffort: request.reasoningEffort,
          serviceTier: request.serviceTier,
        }),
      }));
    }
    return result;
  }

  async interruptChatTurn(
    threadId: ThreadSummary["id"],
    expectedTurnId: string,
  ): Promise<void> {
    await this.#interruptTurn({ threadId, expectedTurnId });
  }

  async prepareChatThreadArchive(
    binding: ChatThreadBinding,
    archiveHandle: ArchiveAdmissionHandle,
  ): Promise<Readonly<{
    generation: number;
  }>> {
    this.#validatePersistedChatThreadBinding(binding);
    const generation = await this.#ensureArchiveRecoveryGeneration(
      binding.accountProfileId,
      archiveHandle,
    );
    return Object.freeze({ generation });
  }

  async archiveChatThread(
    binding: ChatThreadBinding,
    expectedGeneration: number,
    archiveHandle: ArchiveAdmissionHandle,
  ): Promise<Readonly<{
    containmentReceipt: string;
    generation: number;
    streamPosition: number;
  }>> {
    if (!Number.isSafeInteger(expectedGeneration) || expectedGeneration < 1) {
      throw new SessionServiceError(
        "invalid_request",
        "The provider archive generation is invalid.",
        false,
        "none",
      );
    }
    this.#validatePersistedChatThreadBinding(binding);
    this.#assertArchiveAdmissionHandle(archiveHandle);
    return await this.#serializeChatThreadArchive(binding.threadId, async () => {
      if (
        this.#activeRuntimeGenerations.get(binding.accountProfileId) !==
          expectedGeneration
      ) {
        throw new SessionServiceError(
          "conflict",
          "The provider thread archive generation changed before dispatch.",
          true,
          "retry",
        );
      }
      const positioned = await this.#requestArchiveRecoveryWithResponsePosition(
        binding.accountProfileId,
        archiveHandle,
        "threadArchive",
        { threadId: binding.restartThreadId },
        expectedGeneration,
      );
      if (positioned.generation !== expectedGeneration) {
        throw new SessionServiceError(
          "protocol_error",
          "The provider thread archive response changed generation.",
          false,
          "restartRuntime",
        );
      }
      return Object.freeze({
        containmentReceipt: chatThreadArchiveContainmentReceipt({
          generation: positioned.generation,
          streamPosition: positioned.streamPosition,
          threadId: binding.threadId,
        }),
        generation: positioned.generation,
        streamPosition: positioned.streamPosition,
      });
    });
  }

  async reconcileChatThreadArchive(
    binding: ChatThreadBinding,
    archiveHandle: ArchiveAdmissionHandle,
  ): Promise<Readonly<{
    disposition: "applied" | "not_applied" | "ambiguous";
    evidenceReceipt: string;
    generation: number;
    streamPosition: number;
    containmentReceipt: string | null;
  }>> {
    this.#validatePersistedChatThreadBinding(binding);
    this.#assertArchiveAdmissionHandle(archiveHandle);
    return await this.#serializeChatThreadArchive(binding.threadId, async () => {
      const expectedGeneration = await this.#ensureArchiveRecoveryGeneration(
        binding.accountProfileId,
        archiveHandle,
      );
      const first = await this.#scanChatThreadArchiveState(
        binding.accountProfileId,
        archiveHandle,
        expectedGeneration,
        -1,
      );
      const second = await this.#scanChatThreadArchiveState(
        binding.accountProfileId,
        archiveHandle,
        expectedGeneration,
        first.streamPosition,
      );
      const generation = first.generation;
      const stable = first.canonicalDigest === second.canonicalDigest;
      const activeTargetCount = second.activeThreadIds.filter(
        (threadId) => threadId === binding.restartThreadId,
      ).length;
      const archivedTargetCount = second.archivedThreadIds.filter(
        (threadId) => threadId === binding.restartThreadId,
      ).length;
      const disposition = stable &&
          activeTargetCount === 0 && archivedTargetCount === 1
        ? "applied" as const
        : stable && activeTargetCount === 1 && archivedTargetCount === 0
          ? "not_applied" as const
          : "ambiguous" as const;
      const hasher = new Bun.CryptoHasher("sha256");
      hasher.update("hra.chat.thread-archive-reconciliation.v2\0");
      hasher.update(JSON.stringify({
        disposition,
        first: {
          canonical: first.canonicalDigest,
          positioned: first.positionedDigest,
        },
        generation,
        second: {
          canonical: second.canonicalDigest,
          positioned: second.positionedDigest,
        },
        threadId: binding.threadId,
      }));
      const evidenceReceipt = `chatarchivescan_${hasher.digest("hex")}`;
      return Object.freeze({
        disposition,
        evidenceReceipt,
        generation,
        streamPosition: second.streamPosition,
        containmentReceipt: disposition === "applied"
          ? chatThreadArchiveContainmentReceipt({
            generation,
            streamPosition: second.streamPosition,
            threadId: binding.threadId,
          })
          : null,
      });
    });
  }

  async reconcileThread(input: {
    readonly accountProfileId: AccountSummary['id'];
    readonly workspacePath: string;
  }): Promise<SessionThreadReconciliation> {
    const project = await this.#registerProject(input.workspacePath);
    const positioned = await this.#commands.threadList(
        input.accountProfileId,
        {
          cursor: null,
          limit: 2,
          sortKey: "updated_at",
          sortDirection: "desc",
          sourceKinds: ["appServer"],
          archived: false,
          cwd: project.displayPath,
        },
      );
    const response = positioned.output;
    if (
      response.nextCursor !== null ||
      response.data.length > 1 ||
      response.data.some((raw) => raw.cwd !== project.displayPath)
    ) {
      return { kind: "ambiguous" };
    }
    const raw = response.data[0];
    if (raw === undefined) return { kind: "missing" };
    this.#consumeCodexFacts(projectCodexThreadResponseFacts({
      accountProfileId: input.accountProfileId,
      generation: positioned.generation,
      origin: "reconciled",
      streamPosition: positioned.streamPosition,
    }, [{ archived: false, thread: raw, turns: "metadata_only" }]), {
      accountProfileId: input.accountProfileId,
      laneMode: "managed",
      preferredProject: project,
      threadId: raw.id,
    });
    const thread = this.#registry.requireObservedThread(input.accountProfileId, raw.id);
    return { kind: "ready", thread };
  }

  async reconcileInitialTurn(
    threadId: ThreadSummary['id'],
    clientUserMessageId: string,
  ): Promise<SessionTurnReconciliation> {
    validateClientUserMessageId(clientUserMessageId);
    const binding = this.#registry.requireBinding(threadId);
    const workspaceLeaseKey = ambiguousExecutionWorkspaceLeaseKey({
      accountProfileId: binding.accountProfileId,
      clientUserMessageId,
      providerThreadId: binding.codexThreadId,
    });
    const response = await this.#commands.threadRead(
      binding.accountProfileId,
      {
        threadId: binding.codexThreadId,
        includeTurns: true,
      },
    );
    const { thread: raw } = response.output;
    if (raw.id !== binding.codexThreadId || raw.cwd !== binding.cwd) {
      throw new SessionServiceError(
        "protocol_error",
        "Codex returned a different session during turn reconciliation.",
        false,
        "restartRuntime",
      );
    }
    const project = this.#registry.projectById(binding.projectId);
    const snapshotFacts = projectCodexThreadResponseFacts({
      accountProfileId: binding.accountProfileId,
      generation: response.generation,
      origin: "reconciled",
      streamPosition: response.streamPosition,
    }, [{ archived: false, thread: raw, turns: "metadata_only" }]);
    this.#consumeCodexFacts(Object.freeze([
      ...snapshotFacts,
      ...confirmedOperationFacts({
        accountProfileId: binding.accountProfileId,
        generation: response.generation,
        operation: "thread_read",
        streamPosition: response.streamPosition,
        threadId: raw.id,
      }, snapshotFacts.length),
    ]), {
      accountProfileId: binding.accountProfileId,
      laneMode: binding.laneMode,
      ...(project === null ? {} : { preferredProject: project }),
      preferredTitle: binding.title,
      threadId: raw.id,
    });
    const position: SessionTurnReconciliationPosition = {
      generation: response.generation,
      responsePosition: response.streamPosition,
    };
    const ambiguousWorkspaceLease =
      this.#ambiguousExecutionWorkspaceLeaseByRequest.get(workspaceLeaseKey);
    if (
      ambiguousWorkspaceLease !== undefined &&
      ambiguousWorkspaceLease.generation !== response.generation
    ) {
      this.#releaseAmbiguousExecutionWorkspaceLease(workspaceLeaseKey);
    }
    if (raw.turns.some((turn) => turn.itemsView !== "full")) {
      return {
        ...position,
        kind: "incomplete",
        reason: "partial_turn_items",
      };
    }
    let matchingTurn: PinnedCodexTurn | undefined;
    let matchingMessageCount = 0;
    for (const turn of raw.turns) {
      for (const item of turn.items) {
        if (item.type !== "userMessage" || item.clientId !== clientUserMessageId) continue;
        matchingTurn ??= turn;
        matchingMessageCount += 1;
      }
    }
    if (matchingMessageCount > 1) {
      return {
        ...position,
        kind: "ambiguous",
        reason: "duplicate_client_message_id",
      };
    }
    if (matchingTurn === undefined) {
      this.#releaseAmbiguousExecutionWorkspaceLease(workspaceLeaseKey);
      return { ...position, kind: "missing" };
    }
    const retainedWorkspaceLease =
      this.#ambiguousExecutionWorkspaceLeaseByRequest.get(workspaceLeaseKey);
    if (retainedWorkspaceLease !== undefined) {
      if (matchingTurn.status !== "inProgress") {
        this.#releaseAmbiguousExecutionWorkspaceLease(workspaceLeaseKey);
      } else {
        this.#registerProductionTurnPolicy({
          accountProfileId: binding.accountProfileId,
          proof: retainedWorkspaceLease.proof,
          positioned: {
            generation: response.generation,
            output: { turn: matchingTurn },
            streamPosition: response.streamPosition,
          },
          request: retainedWorkspaceLease.request,
          threadId,
          threadReceipt: retainedWorkspaceLease.threadReceipt,
          executionSettingsRevision:
            retainedWorkspaceLease.executionSettingsRevision,
          releaseWorkspaceAdmission: retainedWorkspaceLease.release,
        });
        this.#ambiguousExecutionWorkspaceLeaseByRequest.delete(workspaceLeaseKey);
      }
    }
    return {
      ...position,
      kind: "ready",
      turnId: ownedCodexId("turn", binding.accountProfileId, matchingTurn.id),
    };
  }

  async interruptGatewayThread(threadId: ThreadSummary['id']): Promise<"idle" | "interrupted"> {
    const binding = this.#registry.bindingByOwnedId(threadId);
    if (binding === null) {
      throw new SessionServiceError(
        "not_found",
        "The dispatched Codex session is unavailable.",
        false,
        "resolveAttention",
      );
    }
    const state = this.#store.getSnapshot();
    const thread = this.#selectors.selectThreadState(
      state,
      binding.accountProfileId,
      binding.codexThreadId,
    );
    const activeTurn = thread?.turnKeys
      .map((key) => state.turns[key])
      .findLast((turn) => turn?.status === "active");
    if (activeTurn === undefined) return "idle";
    await this.#interruptTurn({
      threadId,
      expectedTurnId: ownedCodexId("turn", binding.accountProfileId, activeTurn.id),
    });
    return "interrupted";
  }

  async steer(request: SessionSteerRequest): Promise<void> {
    const providerInput = request.input !== undefined
      ? validateChatProviderInput(request.clientUserMessageId, request.input)
      : (() => {
          if (request.prompt === undefined) {
            throw new SessionServiceError(
              "invalid_request",
              "The steering input is unavailable.",
              false,
              "none",
            );
          }
          validateLaunchText(request.clientUserMessageId, request.prompt);
          return Object.freeze([{ type: "text" as const, text: request.prompt }]);
        })();
    if (
      !Number.isSafeInteger(request.expectedGeneration) ||
      request.expectedGeneration < 1
    ) {
      throw new SessionServiceError(
        "policy_denied",
        "The steering generation fence is invalid.",
        false,
        "restartRuntime",
      );
    }
    const policy = this.verifiedProductionExecutionPolicyForActiveTurn(
      request.threadId,
      request.expectedTurnId,
    );
    if (policy?.generation !== request.expectedGeneration) {
      throw new SessionServiceError(
        "policy_denied",
        "The active turn no longer has HRA's verified execution policy.",
        false,
        "resolveAttention",
      );
    }
    if (request.input !== undefined) {
      const capability = this.verifiedChatCapabilityForActiveTurn(
        request.threadId,
        request.expectedTurnId,
      );
      if (
        capability === null || capability.catalogDigest !== request.catalogDigest ||
        JSON.stringify(capability.observedInputModalities) !==
          JSON.stringify(request.observedInputModalities) ||
        (
          providerInput.some((item) => item.type === "localImage") &&
          !supportsRequiredInput(capability.observedInputModalities, "image")
        )
      ) {
        throw new SessionServiceError(
          "capability_unavailable",
          "The active turn has no exact image-capability receipt.",
          false,
          "resolveAttention",
        );
      }
    }
    await this.#steerTurn({
      clientUserMessageId: request.clientUserMessageId,
      expectedGeneration: request.expectedGeneration,
      expectedTurnId: request.expectedTurnId,
      input: providerInput,
      threadId: request.threadId,
    });
  }

  #consumeCodexFact(
    fact: CodexFact,
    preference?: SessionThreadObservationPreference,
  ): boolean {
    switch (fact.type) {
      case "thread.snapshot": {
        const preferred = preference?.accountProfileId === fact.accountProfileId &&
            preference.threadId === fact.thread.id
          ? preference
          : undefined;
        this.#registry.observeThread({
          accountProfileId: fact.accountProfileId,
          authoritativeTurns: fact.thread.turns !== null,
          codexThreadId: fact.thread.id,
          ...(preferred?.preferredProject === undefined
            ? {}
            : { preferredProject: preferred.preferredProject }),
          ...(preferred?.laneMode === undefined ? {} : { laneMode: preferred.laneMode }),
          ...(preferred?.preferredTitle === undefined
            ? {}
            : { preferredTitle: preferred.preferredTitle }),
        });
        for (const turn of fact.thread.turns ?? []) {
          const turnFact = {
            ...fact,
            type: "turn.snapshot" as const,
            threadId: fact.thread.id,
            turn,
          };
          if (turn.status === "active") {
            this.#reconcileProviderSubagents(
              turnFact,
              turn.providerAgents ?? [],
            );
          }
          for (const item of turn.items ?? []) {
            if (item.kind === "reasoning_summary") {
              this.#publishReasoningSnapshotCompletion(turnFact, item);
            }
          }
          if (turn.status !== "active") {
            const ownedTurnId = ownedCodexId(
              "turn",
              fact.accountProfileId,
              turn.id,
            );
            this.#releaseExecutionWorkspaceLease(ownedTurnId);
            this.#productionPolicyByTurn.delete(ownedTurnId);
            this.#chatCapabilityByTurn.delete(ownedTurnId);
            this.#completeProviderSubagents(turnFact);
            this.#reasoningSummaries.clearTurn({
              accountProfileId: fact.accountProfileId,
              generation: fact.generation,
              threadId: fact.thread.id,
              turnId: turn.id,
            });
          }
        }
        this.#factDispatch.consume(fact);
        return true;
      }
      case "thread.archived":
        this.#releaseExecutionWorkspaceLeasesForThread(
          ownedCodexId("thread", fact.accountProfileId, fact.threadId),
        );
        return this.#registry.refreshThread(fact.accountProfileId, fact.threadId);
      case "thread.deleted":
        return this.#deleteOwnedThread(fact.accountProfileId, fact.threadId);
      case "thread.title_changed":
      case "thread.status_changed":
        return this.#registry.refreshThread(fact.accountProfileId, fact.threadId);
      case "turn.snapshot": {
        const binding = this.#registry.bindingByCodexId(
          fact.accountProfileId,
          fact.threadId,
        );
        if (binding === null) return false;
        const completion = fact.turn.status === "active"
          ? null
          : this.#closeActiveToolActivity(
              fact.accountProfileId,
              fact.threadId,
              fact.turn.id,
            );
        if (fact.turn.status !== "active") {
          const ownedTurnId = ownedCodexId("turn", fact.accountProfileId, fact.turn.id);
          this.#releaseExecutionWorkspaceLease(ownedTurnId);
          this.#productionPolicyByTurn.delete(ownedTurnId);
          this.#chatCapabilityByTurn.delete(ownedTurnId);
        }
        this.#registry.observeTurn(binding, fact.turn.id);
        if (fact.turn.items !== null) {
          if (fact.turn.status === "active") {
            this.#reconcileProviderSubagents(fact, fact.turn.providerAgents ?? []);
          }
          for (const item of fact.turn.items) {
            if (item.kind === "reasoning_summary") {
              this.#publishReasoningSnapshotCompletion(fact, item);
            }
          }
        }
        if (fact.turn.status !== "active") {
          this.#completeProviderSubagents(fact);
          this.#reasoningSummaries.clearTurn({
            accountProfileId: fact.accountProfileId,
            generation: fact.generation,
            threadId: fact.threadId,
            turnId: fact.turn.id,
          });
        }
        if (completion !== null) this.#publishTurnActivity(completion);
        return true;
      }
      case "turn.completed": {
        const ownedTurnId = ownedCodexId("turn", fact.accountProfileId, fact.turnId);
        this.#releaseExecutionWorkspaceLease(ownedTurnId);
        this.#productionPolicyByTurn.delete(ownedTurnId);
        this.#chatCapabilityByTurn.delete(ownedTurnId);
        const completion = this.#closeActiveToolActivity(
          fact.accountProfileId,
          fact.threadId,
          fact.turnId,
        );
        this.#completeProviderSubagents(fact);
        this.#reasoningSummaries.clearTurn({
          accountProfileId: fact.accountProfileId,
          generation: fact.generation,
          threadId: fact.threadId,
          turnId: fact.turnId,
        });
        if (completion !== null) this.#publishTurnActivity(completion);
        return completion !== null;
      }
      case "turn.token_usage":
        {
          const binding = this.#registry.bindingByCodexId(
            fact.accountProfileId,
            fact.threadId,
          );
          return binding !== null && this.#registry.observeTurnTokenUsage(
            binding,
            fact.turnId,
            { inputTokens: fact.inputTokens, outputTokens: fact.outputTokens },
          );
        }
      case "turn.model_rerouted":
        return false;
      case "turn.activity":
        return this.#publishOwnedFactActivity(fact, fact.activity);
      case "item.started":
        this.#observeProviderSubagents(fact, fact.providerAgents ?? []);
        return this.#consumeItemStartedFact(fact);
      case "item.delta": {
        if (fact.channel === "reasoning_summary") {
          return this.#consumeReasoningSummaryDelta(fact);
        }
        const activity = fact.channel === "assistant_text"
          ? "assistant_message_delta"
          : "reasoning_summary_delta";
        const published = this.#publishOwnedFactActivity(
          fact,
          activity,
          fact.delta,
          fact.itemId,
        );
        return this.#factDispatch.consume(fact) || published;
      }
      case "item.completed": {
        this.#observeProviderSubagents(fact, fact.providerAgents ?? []);
        const published = fact.item.kind === "tool"
          ? this.#consumeToolLifecycleFact(fact, "tool_activity_completed")
          : fact.item.kind === "assistant_text"
          ? this.#publishAssistantItemCompletion(fact)
          : fact.item.kind === "reasoning_summary"
          ? this.#publishReasoningItemCompletion(fact)
          : false;
        return this.#factDispatch.consume(fact) || published;
      }
      case "account.changed":
      case "account.login_completed":
      case "account.profile_updated":
      case "account.rate_limits_updated":
      case "hydration.changed":
      case "interaction.requested":
      case "interaction.settled":
      case "operation.changed":
      case "runtime.changed":
      case "turn.started":
        return false;
      case "server_request.resolved":
        return this.#interactions.handleProviderResolutionFact(fact);
    }
  }

  #admitDisplayFact(
    fact: Extract<CodexFact, {
      type: "item.completed" | "item.delta" | "thread.snapshot";
    }>,
  ): boolean {
    const state = this.#store.getSnapshot();
    if (fact.type === "thread.snapshot") {
      return this.#registry.hasCodexBinding(
        fact.accountProfileId,
        fact.thread.id,
      ) && this.#selectors.selectThreadState(
        state,
        fact.accountProfileId,
        fact.thread.id,
      ) !== null;
    }
    const threadKey = sessionEntityKey(fact.accountProfileId, fact.threadId);
    const turnKey = sessionEntityKey(fact.accountProfileId, fact.turnId);
    const itemId = fact.type === "item.delta" ? fact.itemId : fact.item.id;
    const item = state.items.get(sessionEntityKey(fact.accountProfileId, itemId));
    const turn = state.turns[turnKey];
    if (
      state.threads[threadKey] === undefined ||
      turn?.threadKey !== threadKey ||
      item?.threadKey !== threadKey ||
      item.turnKey !== turnKey
    ) return false;
    return fact.type === "item.delta"
      ? item.status === "streaming"
      : item.status !== "streaming";
  }

  #consumeItemStartedFact(
    fact: Extract<CodexFact, { type: "item.started" }>,
  ): boolean {
    if (fact.kind === "tool") {
      const exact = this.#publishToolItemStarted(fact);
      return this.#consumeToolLifecycleFact(fact, "tool_activity_started") || exact;
    }
    return fact.kind === "reasoning_summary"
      ? this.#publishOwnedFactActivity(fact, "planning")
      : false;
  }

  #consumeToolLifecycleFact(
    fact: Extract<CodexFact, { type: "item.started" | "item.completed" }>,
    kind: "tool_activity_completed" | "tool_activity_started",
  ): boolean {
    const candidate = this.#ownedActivity(fact.accountProfileId, {
      kind,
      providerItemId: fact.type === "item.started" ? fact.itemId : fact.item.id,
      threadId: fact.threadId,
      turnId: fact.turnId,
    });
    if (candidate === null) return false;
    const normalized = this.#normalizeToolActivity(fact.accountProfileId, {
      kind,
      providerItemId: fact.type === "item.started" ? fact.itemId : fact.item.id,
      threadId: fact.threadId,
      turnId: fact.turnId,
    });
    if (normalized === null) return false;
    const owned = this.#ownedActivity(fact.accountProfileId, normalized);
    if (owned !== null) this.#publishTurnActivity(owned);
    return true;
  }

  #publishOwnedFactActivity(
    fact: Pick<CodexFact, "accountProfileId"> & Readonly<{
      threadId: string;
      turnId: string;
    }>,
    kind: Exclude<SessionTurnActivityKind,
      "tool_activity_completed" | "tool_activity_started">,
    displayText?: string,
    providerItemId?: string,
    summaryIndex?: number,
  ): boolean {
    if (
      (kind === "assistant_message_delta" || kind === "reasoning_summary_delta") &&
      !isBoundedSessionDisplayText(displayText ?? "")
    ) return false;
    const parsed: ParsedSessionTurnActivity = kind === "assistant_message_delta"
      ? {
          kind,
          displayText: displayText ?? "",
          providerItemId: providerItemId ?? "",
          threadId: fact.threadId,
          turnId: fact.turnId,
        }
      : kind === "reasoning_summary_delta"
        ? {
            kind,
            displayText: displayText ?? "",
            providerItemId: providerItemId ?? "",
            summaryIndex: summaryIndex ?? -1,
            threadId: fact.threadId,
            turnId: fact.turnId,
          }
        : { kind, threadId: fact.threadId, turnId: fact.turnId };
    const owned = this.#ownedActivity(fact.accountProfileId, parsed);
    if (owned === null) return false;
    this.#publishTurnActivity(owned);
    return true;
  }

  #consumeReasoningSummaryDelta(
    fact: Extract<CodexFact, { type: "item.delta"; channel: "reasoning_summary" }>,
  ): boolean {
    let accepted = false;
    try {
      accepted = this.#reasoningSummaries.observeDelta({
        accountProfileId: fact.accountProfileId,
        generation: fact.generation,
        threadId: fact.threadId,
        turnId: fact.turnId,
        itemId: fact.itemId,
        cursor: {
          generation: fact.generation,
          streamPosition: fact.streamPosition,
          factIndex: fact.factIndex,
        },
        delta: fact.delta,
        summaryIndex: fact.summaryIndex,
        truncated: fact.truncated,
      });
    } catch {
      return false;
    }
    if (!accepted) return false;
    const published = this.#publishOwnedFactActivity(
      fact,
      "reasoning_summary_delta",
      fact.delta,
      fact.itemId,
      fact.summaryIndex,
    );
    return this.#factDispatch.consume(fact) || published;
  }

  #publishAssistantItemCompletion(
    fact: Extract<CodexFact, { type: "item.completed" }>,
  ): boolean {
    if (fact.item.kind !== "assistant_text") return false;
    const owned = this.#ownedActivity(fact.accountProfileId, {
      kind: "assistant_message_delta",
      displayText: fact.item.text,
      providerItemId: fact.item.id,
      threadId: fact.threadId,
      turnId: fact.turnId,
    }, false);
    if (owned === null || owned.kind !== "assistant_message_delta") return false;
    const completion: SessionAssistantItemCompletion = {
      accountProfileId: owned.accountProfileId,
      assistantItemId: ownedCodexId("item", fact.accountProfileId, fact.item.id),
      displayText: fact.item.text,
      threadId: owned.threadId,
      truncated: fact.item.truncated,
      turnId: owned.turnId,
    };
    try {
      void Promise.resolve(this.#onAssistantItemCompletion(completion)).catch(() => undefined);
    } catch {
      // Completion projection is auxiliary to the authoritative session store.
    }
    return true;
  }

  #publishToolItemStarted(
    fact: Extract<CodexFact, { type: "item.started" }>,
  ): boolean {
    if (fact.kind !== "tool") return false;
    const owned = this.#ownedActivity(fact.accountProfileId, {
      kind: "tool_activity_started",
      providerItemId: fact.itemId,
      threadId: fact.threadId,
      turnId: fact.turnId,
    });
    if (owned === null) return false;
    const event: SessionToolItemStarted = {
      accountProfileId: owned.accountProfileId,
      itemId: ownedCodexId("item", fact.accountProfileId, fact.itemId),
      threadId: owned.threadId,
      turnId: owned.turnId,
    };
    try {
      void Promise.resolve(this.#onToolItemStarted(event)).catch(() => undefined);
    } catch {
      // Exact item observation cannot destabilize accepted session facts.
    }
    return true;
  }

  #publishReasoningItemCompletion(
    fact: Extract<CodexFact, { type: "item.completed" }>,
    requireActive = true,
  ): boolean {
    if (fact.item.kind !== "reasoning_summary") return false;
    const owned = this.#ownedActivity(fact.accountProfileId, {
      kind: "planning",
      threadId: fact.threadId,
      turnId: fact.turnId,
    }, requireActive);
    if (owned === null) return false;
    const receipt = this.#reasoningSummaries.complete({
      accountProfileId: fact.accountProfileId,
      generation: fact.generation,
      threadId: fact.threadId,
      turnId: fact.turnId,
      itemId: fact.item.id,
      cursor: {
        generation: fact.generation,
        streamPosition: fact.streamPosition,
        factIndex: fact.factIndex,
      },
      summaryParts: fact.item.summaryParts,
      truncated: fact.item.truncated,
    });
    const event: SessionReasoningItemCompletion = {
      accountProfileId: owned.accountProfileId,
      itemId: ownedCodexId("item", fact.accountProfileId, fact.item.id),
      receipt,
      threadId: owned.threadId,
      turnId: owned.turnId,
    };
    try {
      void Promise.resolve(this.#onReasoningItemCompletion(event)).catch(() => undefined);
    } catch {
      // Exact item observation cannot destabilize accepted session facts.
    }
    return true;
  }

  #publishReasoningSnapshotCompletion(
    fact: Extract<CodexFact, { type: "turn.snapshot" }>,
    item: Extract<NonNullable<typeof fact.turn.items>[number], {
      kind: "reasoning_summary";
    }>,
  ): boolean {
    const requireActive = fact.turn.status === "active" ||
      !this.#isExactCurrentTerminalTurn(
        fact.accountProfileId,
        fact.threadId,
        fact.turn.id,
      );
    return this.#publishReasoningItemCompletion({
      ...fact,
      type: "item.completed",
      turnId: fact.turn.id,
      item,
    }, requireActive);
  }

  #providerScope(
    fact: Readonly<{
      accountProfileId: string;
      generation: number;
      threadId: string;
      turnId: string;
    }>,
  ): ProviderSubagentTurnScope {
    return {
      accountProfileId: fact.accountProfileId,
      generation: fact.generation,
      threadId: fact.threadId,
      turnId: fact.turnId,
    };
  }

  #observeProviderSubagents(
    fact: Extract<CodexFact, { type: "item.started" | "item.completed" }>,
    observations: readonly NonNullable<typeof fact.providerAgents>[number][],
  ): boolean {
    if (observations.length === 0) return false;
    const scope = this.#providerScope(fact);
    let changed = false;
    try {
      for (const observation of observations) {
        changed = this.#providerSubagents.observe({
          ...scope,
          ...observation,
          streamPosition: fact.streamPosition,
          factIndex: fact.factIndex,
        }) || changed;
      }
    } catch {
      return false;
    }
    if (changed) this.#publishProviderSubagents(scope);
    return changed;
  }

  #reconcileProviderSubagents(
    fact: Extract<CodexFact, { type: "turn.snapshot" }>,
    observations: readonly NonNullable<typeof fact.turn.providerAgents>[number][],
  ): boolean {
    const scope = this.#providerScope({
      ...fact,
      turnId: fact.turn.id,
    });
    let changed = false;
    try {
      changed = this.#providerSubagents.reconcile(scope, observations, {
        streamPosition: fact.streamPosition,
        factIndex: fact.factIndex,
      });
    } catch {
      return false;
    }
    if (changed) this.#publishProviderSubagents(scope);
    return changed;
  }

  #completeProviderSubagents(
    fact: Extract<CodexFact, { type: "turn.completed" | "turn.snapshot" }>,
  ): void {
    const scope = this.#providerScope(fact.type === "turn.snapshot"
      ? { ...fact, turnId: fact.turn.id }
      : fact);
    const current = this.#providerSubagents.snapshot(scope);
    this.#providerSubagents.completeTurn(scope);
    if (current.agents.length > 0 || current.overflowCount > 0) {
      this.#publishProviderSubagents(scope);
    }
  }

  #publishProviderSubagents(scope: ProviderSubagentTurnScope): void {
    const owned = this.#ownedActivity(scope.accountProfileId, {
      kind: "planning",
      threadId: scope.threadId,
      turnId: scope.turnId,
    }, false);
    if (owned === null) return;
    const snapshot = this.#providerSubagents.snapshot(scope);
    const event: SessionProviderSubagents = {
      accountProfileId: owned.accountProfileId,
      threadId: owned.threadId,
      turnId: owned.turnId,
      projection: {
        agents: snapshot.agents.map((agent) => ({ ...agent })),
        overflowCount: snapshot.overflowCount,
      },
    };
    try {
      void Promise.resolve(this.#onProviderSubagents(event)).catch(() => undefined);
    } catch {
      // Collaboration projection is auxiliary to accepted provider facts.
    }
  }

  async handleServerRequest(
    accountProfileId: AccountSummary['id'],
    request: CodexServerRequest,
  ): Promise<boolean> {
    // Full-access production turns never have an approval UI. An unexpected
    // approval request returns to the gateway's one-shot rejection path.
    if (isProductionApprovalRequestMethod(request.method)) return false;
    const createdAt = this.#now().getTime();
    const interactionId = this.#interactions.interactionId(accountProfileId, request);
    const reference = projectSessionServerRequestActivity(request);
    if (reference === null) return false;
    const binding = this.#registry.bindingByCodexId(accountProfileId, reference.threadId);
    if (binding === null) return false;
    const parsed = projectSessionInteraction(request, {
      interactionId,
      createdAt,
      defaultExpiresAt: createdAt + 3_600_000,
      laneMode: binding.laneMode,
      worktreePath: binding.cwd,
    });
    if (parsed === null) return false;
    const owned = this.#ownedActivity(accountProfileId, {
      kind: parsed.activityKind,
      threadId: parsed.threadId,
      turnId: parsed.turnId,
    });
    if (owned === null) return false;
    try {
      await this.#onTurnActivity(owned);
    } catch {
      // Interaction requests must always reach the fail-closed rejection path.
      // A local activity projection failure cannot leave Codex waiting forever.
    }
    try {
      const publicRequest = await this.#onInteractionRequest({ ...owned, request: parsed.publicRequest });
      if (publicRequest === null) return false;
      this.#interactions.register({
        accountProfileId,
        providerRequest: request,
        providerResponse: parsed.providerResponse,
        projectedRequest: parsed.publicRequest,
        publicRequest,
        threadId: parsed.threadId,
        turnId: parsed.turnId,
      });
      return true;
    } catch {
      return false;
    }
  }

  async resolveInteraction(
    interactionId: string,
    response: RunInteractionResponse,
    authority?: () => Promise<boolean>,
  ): Promise<SessionInteractionResolution> {
    return await this.#interactions.resolve(interactionId, response, authority);
  }

  async handleServerRequestExpired(
    accountProfileId: AccountSummary['id'],
    fault: CodexExpiredServerRequestFault,
  ): Promise<void> {
    await this.#interactions.handleProviderExpired(accountProfileId, fault);
  }

  async expireInteraction(
    interactionId: string,
    reason: SessionInteractionExpired["reason"] = "provider_expired",
    authority?: () => Promise<boolean>,
  ): Promise<boolean> {
    return await this.#interactions.expire(interactionId, reason, authority);
  }

  #hydrationTargetPlan(accountProfileId: string) {
    const state = this.#store.getSnapshot();
    const threads = Object.values(state.threads)
      .filter((thread) => thread.accountProfileId === accountProfileId)
      .map((thread) => ({
        cwd: thread.cwd,
        executionActive: thread.status === "active" || thread.turnKeys.some(
          (turnKey) => state.turns[turnKey]?.status === "active",
        ),
        id: thread.id,
        updatedAt: thread.updatedAt,
      }));
    const cwds = [
      ...threads.map(({ cwd }) => cwd),
      ...this.#registry.bindingsForAccount(accountProfileId)
        .map((binding) => binding.cwd),
    ];
    return planSessionHydrationTargets({
      cwds,
      selectedThreadId: null,
      threads,
    });
  }

  async #ensureArchiveRecoveryGeneration(
    accountProfileId: AccountSummary["id"],
    archiveHandle: ArchiveAdmissionHandle,
  ): Promise<number> {
    this.#assertArchiveAdmissionHandle(archiveHandle);
    const ensured = await this.#accounts.ensureArchiveRecoveryRuntime(
      accountProfileId,
      archiveHandle,
    );
    if (!Number.isSafeInteger(ensured.generation) || ensured.generation < 1) {
      throw new SessionServiceError(
        "protocol_error",
        "The recovered provider runtime generation is invalid.",
        false,
        "restartRuntime",
      );
    }
    const observed = this.#activeRuntimeGenerations.get(accountProfileId);
    if (observed !== undefined && observed !== ensured.generation) {
      throw new SessionServiceError(
        "conflict",
        "The provider runtime changed while archive authority was recovered.",
        true,
        "retry",
      );
    }
    this.#activeRuntimeGenerations.set(accountProfileId, ensured.generation);
    return ensured.generation;
  }

  #requestArchiveRecoveryWithResponsePosition<
    Key extends "threadArchive" | "threadList"
  >(
    accountProfileId: AccountSummary["id"],
    archiveHandle: ArchiveAdmissionHandle,
    key: Key,
    input: PinnedCodexRequestInput<Key>,
    expectedGeneration: number,
  ): Promise<PinnedCodexResponseAtPosition<PinnedCodexRequestOutput<Key>>> {
    this.#assertArchiveAdmissionHandle(archiveHandle);
    return this.#accounts.requestArchiveRecoveryWithResponsePosition(
      accountProfileId,
      archiveHandle,
      key,
      input,
      expectedGeneration,
    );
  }

  async #scanChatThreadArchiveState(
    accountProfileId: AccountSummary["id"],
    archiveHandle: ArchiveAdmissionHandle,
    expectedGeneration: number,
    minimumStreamPosition: number,
  ): Promise<Readonly<{
    activeThreadIds: readonly string[];
    archivedThreadIds: readonly string[];
    canonicalDigest: string;
    generation: number;
    positionedDigest: string;
    streamPosition: number;
  }>> {
    const scan = async (
      archived: boolean,
      afterStreamPosition: number,
    ): Promise<ChatThreadArchiveCatalogScan> => {
      const ids: string[] = [];
      const pages: ChatThreadArchiveScanPage[] = [];
      const seenIds = new Set<string>();
      const seenCursors = new Set<string>();
      let cursor: string | null = null;
      let streamPosition = afterStreamPosition;
      for (let pageOrdinal = 0; pageOrdinal < 64; pageOrdinal += 1) {
        if (this.#activeRuntimeGenerations.get(accountProfileId) !== expectedGeneration) {
          throw new SessionServiceError(
            "conflict",
            "The provider generation changed during archive reconciliation.",
            true,
            "retry",
          );
        }
        const requestCursor = cursor;
        const positioned: PinnedCodexResponseAtPosition<
          PinnedCodexRequestOutput<"threadList">
        > = await this.#requestArchiveRecoveryWithResponsePosition(
          accountProfileId,
          archiveHandle,
          "threadList",
          {
            cursor,
            limit: 256,
            sortKey: "created_at",
            sortDirection: "asc",
            sourceKinds: ["appServer"],
            archived,
          },
          expectedGeneration,
        );
        if (
          positioned.generation !== expectedGeneration ||
          positioned.streamPosition <= streamPosition
        ) {
          throw new SessionServiceError(
            "protocol_error",
            "Provider archive reconciliation response order changed.",
            false,
            "restartRuntime",
          );
        }
        streamPosition = positioned.streamPosition;
        const pageThreadIds: string[] = [];
        for (const thread of positioned.output.data) {
          if (seenIds.has(thread.id)) {
            throw new SessionServiceError(
              "protocol_error",
              "Provider archive reconciliation returned a duplicate thread.",
              false,
              "restartRuntime",
            );
          }
          seenIds.add(thread.id);
          ids.push(thread.id);
          pageThreadIds.push(thread.id);
        }
        const nextCursor: string | null = positioned.output.nextCursor;
        pages.push(Object.freeze({
          generation: positioned.generation,
          pageOrdinal,
          requestCursor,
          responseBackwardsCursor: positioned.output.backwardsCursor,
          responseNextCursor: nextCursor,
          streamPosition,
          threadIds: Object.freeze(pageThreadIds),
        }));
        if (nextCursor === null) {
          return Object.freeze({
            ids: Object.freeze(ids.toSorted()),
            pages: Object.freeze(pages),
            streamPosition,
          });
        }
        if (seenCursors.has(nextCursor)) {
          throw new SessionServiceError(
            "protocol_error",
            "Provider archive reconciliation returned a cyclic cursor.",
            false,
            "restartRuntime",
          );
        }
        seenCursors.add(nextCursor);
        cursor = nextCursor;
      }
      throw new SessionServiceError(
        "protocol_error",
        "Provider archive reconciliation exceeded its complete paging bound.",
        false,
        "restartRuntime",
      );
    };
    const active = await scan(false, minimumStreamPosition);
    const archived = await scan(true, active.streamPosition);
    const archivedIds = new Set(archived.ids);
    if (active.ids.some((id) => archivedIds.has(id))) {
      throw new SessionServiceError(
        "protocol_error",
        "Provider archive reconciliation returned one thread in both catalogs.",
        false,
        "restartRuntime",
      );
    }
    // Absolute stream positions must advance, so the second scan cannot equal
    // the first byte-for-byte. Compare every stable page-shape field while
    // binding both complete positioned traces into the final evidence receipt.
    const canonicalTrace = {
      active: active.pages.map(canonicalChatThreadArchiveScanPage),
      archived: archived.pages.map(canonicalChatThreadArchiveScanPage),
      generation: expectedGeneration,
    };
    const canonicalHasher = new Bun.CryptoHasher("sha256");
    canonicalHasher.update("hra.chat.thread-archive-scan-canonical.v2\0");
    canonicalHasher.update(JSON.stringify(canonicalTrace));
    const positionedHasher = new Bun.CryptoHasher("sha256");
    positionedHasher.update("hra.chat.thread-archive-scan-positioned.v2\0");
    positionedHasher.update(JSON.stringify({
      active: active.pages,
      archived: archived.pages,
      generation: expectedGeneration,
    }));
    return Object.freeze({
      activeThreadIds: active.ids,
      archivedThreadIds: archived.ids,
      canonicalDigest: canonicalHasher.digest("hex"),
      generation: expectedGeneration,
      positionedDigest: positionedHasher.digest("hex"),
      streamPosition: archived.streamPosition,
    });
  }

  #validatePersistedChatThreadBinding(binding: ChatThreadBinding): void {
    if (
      binding.accountProfileId.length === 0 ||
      binding.accountProfileId.length > 128 ||
      binding.accountProfileId.includes("\0") ||
      binding.restartThreadId.length === 0 ||
      binding.restartThreadId.length > 512 ||
      binding.restartThreadId.includes("\0") ||
      ownedCodexId(
        "thread",
        binding.accountProfileId,
        binding.restartThreadId,
      ) !== binding.threadId
    ) {
      throw new SessionServiceError(
        "invalid_request",
        "The persisted chat archive identity does not match this Codex account.",
        false,
        "none",
      );
    }
  }

  #assertArchiveAdmissionHandle(
    archiveHandle: ArchiveAdmissionHandle,
  ): void {
    if (
      (typeof archiveHandle !== "object" && typeof archiveHandle !== "function") ||
      archiveHandle === null
    ) {
      throw new SessionServiceError(
        "invalid_request",
        "Provider archive recovery requires an opaque admission handle.",
        false,
        "none",
      );
    }
  }

  async #serializeChatThreadArchive<T>(
    threadId: ThreadSummary["id"],
    operation: () => Promise<T>,
  ): Promise<T> {
    const previous = this.#chatThreadArchiveTails.get(threadId) ??
      Promise.resolve();
    let release!: () => void;
    const tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.#chatThreadArchiveTails.set(threadId, tail);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.#chatThreadArchiveTails.get(threadId) === tail) {
        this.#chatThreadArchiveTails.delete(threadId);
      }
    }
  }

  async #registerProject(path: string): Promise<ProjectSummary> {
    if (!isAbsolute(path)) {
      throw new SessionServiceError(
        "invalid_request",
        "Dispatch requires an absolute workspace path.",
        false,
        "none",
      );
    }
    let canonical: string;
    try {
      canonical = await realpath(path);
      if (!(await stat(canonical)).isDirectory()) throw new Error("not a directory");
    } catch {
      throw new SessionServiceError(
        "not_found",
        "The dispatch workspace is no longer available.",
        true,
        "retry",
      );
    }
    return this.#registry.ensureProject(canonical, this.#now().toISOString());
  }

  async #listThreads(
    accountProfileId: AccountSummary["id"] | undefined,
    projectId: ProjectSummary["id"] | undefined,
  ): Promise<SessionCommandResult> {
    if (accountProfileId === undefined) {
      throw new SessionServiceError(
        "invalid_request",
        "Choose an account before loading chats.",
        false,
        "none",
      );
    }
    const threads: ThreadSummary[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 4; page += 1) {
      const positioned: PinnedCodexResponseAtPosition<
        PinnedCodexRequestOutput<"threadList">
      > = await this.#commands.threadList(
        accountProfileId,
        {
          cursor,
          limit: 64,
          sortKey: "updated_at",
          sortDirection: "desc",
          sourceKinds: ["appServer"],
          archived: false,
        },
      );
      const response: PinnedCodexRequestOutput<"threadList"> = positioned.output;
      this.#consumeCodexFacts(projectCodexThreadResponseFacts({
        accountProfileId,
        generation: positioned.generation,
        origin: "snapshot",
        streamPosition: positioned.streamPosition,
      }, response.data.map((thread) => ({
        archived: false,
        thread,
        turns: "present",
      }))));
      for (const raw of response.data) {
        const observed = this.#registry.requireObservedThread(accountProfileId, raw.id);
        if (projectId === undefined || observed.projectId === projectId) threads.push(observed);
      }
      cursor = response.nextCursor;
      if (cursor === null) break;
    }
    return {
      type: "threads",
      threads: threads.toSorted((left, right) => right.updatedAt.localeCompare(left.updatedAt)),
    };
  }

  async #startThread(command: {
    readonly accountProfileId: AccountSummary['id'];
    readonly laneMode: WorkspaceLaneSummary['mode'];
    readonly model: "gpt-5.6-sol" | "gpt-5.6-luna";
    readonly projectId: ProjectSummary['id'];
    readonly serviceTier: ChatServiceTier;
    readonly title: string;
    readonly expectedGeneration?: number;
  }): Promise<ThreadSummary> {
    const project = this.#registry.projectById(command.projectId);
    if (project === null) {
      throw new SessionServiceError("not_found", "The dispatch workspace is unavailable.", true, "retry");
    }
    const policyProof = await this.#preflightProductionExecutionPolicy(
      command.accountProfileId,
      command.expectedGeneration,
    );
    const executionWorkspace = this.#runtimeWorkspaceSnapshot(project.displayPath);
    const threadStartInput: PinnedCodexRequestInput<"threadStart"> = {
      model: command.model,
      serviceTier: codexServiceTier(command.serviceTier),
      cwd: project.displayPath,
      runtimeWorkspaceRoots: [...executionWorkspace.runtimeWorkspaceRoots],
      approvalPolicy: HRA_PRODUCTION_EXECUTION_POLICY.approvalPolicy,
      approvalsReviewer: HRA_PRODUCTION_EXECUTION_POLICY.approvalsReviewer,
      sandbox: HRA_PRODUCTION_EXECUTION_POLICY.threadSandbox,
      config: this.#executionThreadConfig(),
      developerInstructions: this.#executionDeveloperInstructions(),
      ephemeral: false,
    };
    const positioned = await this.#commands.threadStart(
      command.accountProfileId,
      threadStartInput,
      policyProof.generation,
    );
    const { thread: raw } = positioned.output;
    await this.#registerProductionThreadPolicy({
      accountProfileId: command.accountProfileId,
      proof: policyProof,
      positioned,
      request: threadStartInput,
      executionSettingsRevision: executionWorkspace.revision,
    });
    const snapshotFacts = projectCodexThreadResponseFacts({
      accountProfileId: command.accountProfileId,
      generation: positioned.generation,
      origin: "reconciled",
      streamPosition: positioned.streamPosition,
    }, [{ archived: false, thread: raw, turns: "present" }]);
    this.#consumeCodexFacts(Object.freeze([
      ...snapshotFacts,
      ...confirmedOperationFacts({
        accountProfileId: command.accountProfileId,
        generation: positioned.generation,
        operation: "thread_start",
        streamPosition: positioned.streamPosition,
        threadId: raw.id,
      }, snapshotFacts.length),
    ]), {
      accountProfileId: command.accountProfileId,
      laneMode: command.laneMode,
      preferredProject: project,
      preferredTitle: command.title,
      threadId: raw.id,
    });
    return this.#registry.requireObservedThread(command.accountProfileId, raw.id);
  }

  async #resumeThread(threadId: ThreadSummary["id"]): Promise<SessionCommandResult> {
    const binding = this.#registry.requireBinding(threadId);
    const policyProof = await this.#preflightProductionExecutionPolicy(
      binding.accountProfileId,
    );
    const executionWorkspace = this.#runtimeWorkspaceSnapshot(binding.cwd);
    const threadResumeInput: PinnedCodexRequestInput<"threadResume"> = {
      threadId: binding.codexThreadId,
      model: "gpt-5.6-sol",
      serviceTier: null,
      cwd: binding.cwd,
      runtimeWorkspaceRoots: [...executionWorkspace.runtimeWorkspaceRoots],
      approvalPolicy: HRA_PRODUCTION_EXECUTION_POLICY.approvalPolicy,
      approvalsReviewer: HRA_PRODUCTION_EXECUTION_POLICY.approvalsReviewer,
      sandbox: HRA_PRODUCTION_EXECUTION_POLICY.threadSandbox,
      config: this.#executionThreadConfig(),
      developerInstructions: this.#executionDeveloperInstructions(),
    };
    const positioned = await this.#commands.threadResume(
      binding.accountProfileId,
      threadResumeInput,
      policyProof.generation,
    );
    const { thread: raw } = positioned.output;
    await this.#registerProductionThreadPolicy({
      accountProfileId: binding.accountProfileId,
      proof: policyProof,
      positioned,
      request: threadResumeInput,
      executionSettingsRevision: executionWorkspace.revision,
    });
    const project = this.#registry.projectById(binding.projectId);
    const snapshotFacts = projectCodexThreadResponseFacts({
      accountProfileId: binding.accountProfileId,
      generation: positioned.generation,
      origin: "reconciled",
      streamPosition: positioned.streamPosition,
    }, [{ archived: false, thread: raw, turns: "present" }]);
    this.#consumeCodexFacts(Object.freeze([
      ...snapshotFacts,
      ...confirmedOperationFacts({
        accountProfileId: binding.accountProfileId,
        generation: positioned.generation,
        operation: "thread_resume",
        streamPosition: positioned.streamPosition,
        threadId: raw.id,
      }, snapshotFacts.length),
    ]), {
      accountProfileId: binding.accountProfileId,
      laneMode: binding.laneMode,
      ...(project === null ? {} : { preferredProject: project }),
      preferredTitle: binding.title,
      threadId: raw.id,
    });
    const thread = this.#registry.requireObservedThread(binding.accountProfileId, raw.id);
    return { type: "thread", thread };
  }

  async #startTurn(command: {
    readonly clientUserMessageId: string;
    readonly input: readonly SessionChatProviderInput[];
    readonly model: "gpt-5.6-sol" | "gpt-5.6-luna";
    readonly reasoningEffort: "ultra" | "max";
    readonly serviceTier: ChatServiceTier;
    readonly threadId: ThreadSummary['id'];
    readonly expectedGeneration?: number;
  }): Promise<PinnedCodexResponseAtPosition<PinnedCodexRequestOutput<"turnStart">>> {
    const binding = this.#registry.requireBinding(command.threadId);
    const registeredThreadPolicy = this.#productionPolicyByThread.get(command.threadId);
    if (registeredThreadPolicy === undefined) {
      throw new SessionServiceError(
        "conflict",
        "The chat lacks a verified full-access thread admission.",
        true,
        "retry",
      );
    }
    this.#assertNoAmbiguousExecutionWorkspaceLease({
      accountProfileId: binding.accountProfileId,
      clientUserMessageId: command.clientUserMessageId,
      providerThreadId: binding.codexThreadId,
    });
    const admission = await this.#admitCurrentProductionThreadRoots({
      accountProfileId: binding.accountProfileId,
      expectedGeneration: command.expectedGeneration ??
        registeredThreadPolicy.receipt.generation,
      threadId: command.threadId,
      model: command.model,
      serviceTier: codexServiceTier(command.serviceTier),
      config: this.#executionThreadConfig(),
      developerInstructions: this.#executionDeveloperInstructions(),
    });
    const turnStartInput: PinnedCodexRequestInput<"turnStart"> = {
      threadId: binding.codexThreadId,
      clientUserMessageId: command.clientUserMessageId,
      input: command.input.map((item) => item.type === "text"
        ? { type: "text" as const, text: item.text, text_elements: [] }
        : { type: "localImage" as const, path: item.path }),
      cwd: binding.cwd,
      runtimeWorkspaceRoots: admission.runtimeWorkspaceRoots,
      approvalPolicy: HRA_PRODUCTION_EXECUTION_POLICY.approvalPolicy,
      approvalsReviewer: HRA_PRODUCTION_EXECUTION_POLICY.approvalsReviewer,
      sandboxPolicy: HRA_PRODUCTION_EXECUTION_POLICY.turnSandboxPolicy,
      model: command.model,
      effort: command.reasoningEffort,
      serviceTier: codexServiceTier(command.serviceTier),
    };
    let positioned: PinnedCodexResponseAtPosition<PinnedCodexRequestOutput<"turnStart">>;
    let workspaceLeaseTransferred = false;
    try {
      positioned = await this.#commands.turnStart(
        binding.accountProfileId,
        turnStartInput,
        admission.proof.generation,
      );
      this.#registerProductionTurnPolicy({
        accountProfileId: binding.accountProfileId,
        proof: admission.proof,
        positioned,
        request: turnStartInput,
        threadId: command.threadId,
        threadReceipt: admission.receipt,
        executionSettingsRevision: admission.executionSettingsRevision,
        releaseWorkspaceAdmission: admission.releaseWorkspaceAdmission,
      });
      workspaceLeaseTransferred = true;
    } catch (error: unknown) {
      if (
        this.#activeRuntimeGenerations.get(binding.accountProfileId) ===
          admission.proof.generation
      ) {
        this.#retainAmbiguousExecutionWorkspaceLease({
          accountProfileId: binding.accountProfileId,
          clientUserMessageId: command.clientUserMessageId,
          executionSettingsRevision: admission.executionSettingsRevision,
          generation: admission.proof.generation,
          proof: admission.proof,
          providerThreadId: binding.codexThreadId,
          release: admission.releaseWorkspaceAdmission,
          request: turnStartInput,
          threadId: command.threadId,
          threadReceipt: admission.receipt,
        });
        workspaceLeaseTransferred = true;
      }
      throw error;
    } finally {
      if (!workspaceLeaseTransferred) admission.releaseWorkspaceAdmission();
    }
    const snapshotFacts = projectCodexTurnResponseFacts({
      accountProfileId: binding.accountProfileId,
      generation: positioned.generation,
      origin: "reconciled",
      streamPosition: positioned.streamPosition,
    }, binding.codexThreadId, positioned.output.turn);
    this.#consumeCodexFacts(Object.freeze([
      ...snapshotFacts,
      ...confirmedOperationFacts({
        accountProfileId: binding.accountProfileId,
        generation: positioned.generation,
        operation: "turn_start",
        streamPosition: positioned.streamPosition,
        threadId: binding.codexThreadId,
      }, snapshotFacts.length),
    ]));
    this.#releaseProductionTurnAdmissionIfSuperseded({
      accountProfileId: binding.accountProfileId,
      generation: positioned.generation,
      providerThreadId: binding.codexThreadId,
      providerTurnId: positioned.output.turn.id,
      responseStreamPosition: positioned.streamPosition,
    });
    return positioned;
  }

  async #steerTurn(command: {
    readonly clientUserMessageId: string;
    readonly expectedGeneration: number;
    readonly expectedTurnId: string;
    readonly input: readonly SessionChatProviderInput[];
    readonly threadId: ThreadSummary['id'];
  }): Promise<void> {
    const binding = this.#registry.requireBinding(command.threadId);
    if (
      this.#activeRuntimeGenerations.get(binding.accountProfileId) !==
        command.expectedGeneration
    ) {
      throw new SessionServiceError(
        "policy_denied",
        "The steering generation changed before Codex admission.",
        false,
        "resolveAttention",
      );
    }
    const rawTurnId = this.#registry.rawTurnIdByOwnedId(command.expectedTurnId);
    if (rawTurnId === null) {
      throw new SessionServiceError("conflict", "The active turn changed. Resume the chat and try again.", true, "retry");
    }
    const positioned = await this.#commands.turnSteer(
      binding.accountProfileId,
      {
        threadId: binding.codexThreadId,
        expectedTurnId: rawTurnId,
        clientUserMessageId: command.clientUserMessageId,
        input: command.input.map((item) => item.type === "text"
          ? { type: "text" as const, text: item.text, text_elements: [] }
          : { type: "localImage" as const, path: item.path }),
      },
      command.expectedGeneration,
    );
    if (positioned.generation !== command.expectedGeneration) {
      throw new SessionServiceError(
        "upstream_ambiguous",
        "Codex acknowledged steering in another runtime generation.",
        false,
        "restartRuntime",
      );
    }
    if (positioned.output.turnId !== rawTurnId) {
      throw new SessionServiceError("protocol_error", "Codex acknowledged a different active turn.", false, "restartRuntime");
    }
    this.#consumeCodexFacts(confirmedOperationFacts({
      accountProfileId: binding.accountProfileId,
      generation: positioned.generation,
      operation: "turn_steer",
      streamPosition: positioned.streamPosition,
      threadId: binding.codexThreadId,
    }));
  }

  async #interruptTurn(command: {
    readonly expectedTurnId: string;
    readonly threadId: ThreadSummary['id'];
  }): Promise<void> {
    const binding = this.#registry.requireBinding(command.threadId);
    const policy = this.#productionPolicyByTurn.get(command.expectedTurnId);
    const activeGeneration = this.#activeRuntimeGenerations.get(binding.accountProfileId);
    if (
      activeGeneration === undefined ||
      (policy !== undefined && (
        policy.threadId !== command.threadId ||
        activeGeneration !== policy.receipt.generation
      ))
    ) {
      throw new SessionServiceError(
        "conflict",
        "The active turn lost its generation-fenced policy receipt.",
        true,
        "retry",
      );
    }
    const rawTurnId = this.#registry.rawTurnIdByOwnedId(command.expectedTurnId);
    if (rawTurnId === null) {
      throw new SessionServiceError("conflict", "The active turn changed.", true, "retry");
    }
    const positioned = await this.#commands.turnInterrupt(
      binding.accountProfileId,
      { threadId: binding.codexThreadId, turnId: rawTurnId },
      policy?.receipt.generation ?? activeGeneration,
    );
    this.#consumeCodexFacts(confirmedOperationFacts({
      accountProfileId: binding.accountProfileId,
      generation: positioned.generation,
      operation: "turn_interrupt",
      streamPosition: positioned.streamPosition,
      threadId: binding.codexThreadId,
    }));
  }

  #ownedActivity(
    accountProfileId: AccountSummary['id'],
    activity: ParsedSessionTurnActivity,
    requireActive = true,
  ): SessionTurnActivity | null {
    const binding = this.#registry.bindingByCodexId(accountProfileId, activity.threadId);
    if (binding === null) return null;
    const threadId = ownedCodexId("thread", accountProfileId, activity.threadId);
    const turnId = ownedCodexId("turn", accountProfileId, activity.turnId);
    const state = this.#store.getSnapshot();
    const threadKey = sessionEntityKey(accountProfileId, activity.threadId);
    const turnKey = sessionEntityKey(accountProfileId, activity.turnId);
    const thread = state.threads[threadKey];
    const turn = state.turns[turnKey];
    if (
      thread === undefined ||
      turn?.threadKey !== threadKey ||
      !thread.turnKeys.includes(turnKey) ||
      (requireActive && turn.status !== "active")
    ) {
      return null;
    }
    const base = {
      accountProfileId,
      threadId,
      turnId,
    };
    return activity.kind === "assistant_message_delta"
      ? {
          ...base,
          kind: activity.kind,
          assistantItemId: ownedCodexId("item", accountProfileId, activity.providerItemId),
          displayText: activity.displayText,
        }
      : activity.kind === "reasoning_summary_delta"
      ? {
          ...base,
          kind: activity.kind,
          displayText: activity.displayText,
          reasoningItemId: ownedCodexId(
            "item",
            accountProfileId,
            activity.providerItemId,
          ),
        }
      : { ...base, kind: activity.kind };
  }

  #isExactCurrentTerminalTurn(
    accountProfileId: AccountSummary["id"],
    rawThreadId: string,
    rawTurnId: string,
  ): boolean {
    const state = this.#store.getSnapshot();
    const threadKey = sessionEntityKey(accountProfileId, rawThreadId);
    const turnKey = sessionEntityKey(accountProfileId, rawTurnId);
    const thread = state.threads[threadKey];
    const turn = state.turns[turnKey];
    return thread !== undefined && turn?.threadKey === threadKey &&
      thread.turnKeys.at(-1) === turnKey && turn.status !== "active";
  }

  #normalizeToolActivity(
    accountProfileId: AccountSummary['id'],
    activity: ParsedSessionTurnActivity,
  ): ParsedSessionTurnActivity | null {
    if (
      activity.kind !== "tool_activity_started" &&
      activity.kind !== "tool_activity_completed"
    ) {
      return activity;
    }
    const key = activeToolKey(accountProfileId, activity.threadId, activity.turnId);
    const retainedActive = this.#activeToolItemsByTurn.get(key);
    const retainedCompleted = this.#completedToolItemsByTurn.get(key);
    if (
      retainedActive === undefined &&
      retainedCompleted === undefined &&
      !this.#admitToolTurn(accountProfileId)
    ) return null;
    const active = retainedActive ?? new Set<string>();
    const completed = retainedCompleted ?? new Set<string>();
    if (activity.kind === "tool_activity_started") {
      if (
        this.#toolItemOverflowTurns.has(key) ||
        active.has(activity.providerItemId) ||
        completed.has(activity.providerItemId) ||
        completed.size >= MAX_SESSION_ACTIVE_TOOL_ITEMS_PER_TURN
      ) return null;
      if (active.size >= MAX_SESSION_ACTIVE_TOOL_ITEMS_PER_TURN) {
        this.#toolItemOverflowTurns.add(key);
        return null;
      }
      const wasEmpty = active.size === 0;
      active.add(activity.providerItemId);
      this.#activeToolItemsByTurn.set(key, active);
      return wasEmpty ? activity : null;
    }
    if (this.#toolItemOverflowTurns.has(key)) {
      active.delete(activity.providerItemId);
      this.#activeToolItemsByTurn.set(key, active);
      return null;
    }
    if (retainedActive === undefined) {
      if (completed.has(activity.providerItemId)) return null;
      if (!rememberCompletedTool(completed, activity.providerItemId)) return null;
      this.#completedToolItemsByTurn.set(key, completed);
      return activity;
    }
    if (!active.delete(activity.providerItemId)) return null;
    const remembered = rememberCompletedTool(completed, activity.providerItemId);
    this.#completedToolItemsByTurn.set(key, completed);
    if (active.size > 0) return null;
    this.#activeToolItemsByTurn.delete(key);
    return remembered ? activity : null;
  }

  #closeActiveToolActivity(
    accountProfileId: AccountSummary['id'],
    threadId: string,
    turnId: string,
  ): SessionTurnActivity | null {
    const key = activeToolKey(accountProfileId, threadId, turnId);
    const active = this.#activeToolItemsByTurn.get(key);
    const overflowed = this.#toolItemOverflowTurns.delete(key);
    if ((active === undefined || active.size === 0) && !overflowed) {
      this.#completedToolItemsByTurn.delete(key);
      this.#saturatedToolActivityAccounts.delete(accountProfileId);
      return null;
    }
    this.#activeToolItemsByTurn.delete(key);
    this.#completedToolItemsByTurn.delete(key);
    this.#saturatedToolActivityAccounts.delete(accountProfileId);
    return this.#ownedActivity(accountProfileId, {
      kind: "tool_activity_completed",
      threadId,
      turnId,
      providerItemId: active?.values().next().value ?? "unknown",
    }, false);
  }

  #publishTurnActivity(activity: SessionTurnActivity): void {
    try {
      void Promise.resolve(this.#onTurnActivity(activity)).catch(() => undefined);
    } catch {
      // Activity is auxiliary; a projection callback cannot destabilize the
      // account-scoped notification stream.
    }
  }

  #deleteOwnedThread(accountProfileId: string, threadId: string): boolean {
    const removed = this.#registry.removeThread(accountProfileId, threadId);
    if (removed === null) return false;
    this.#harnessActorThreadsByOwnedId.delete(removed.thread.id);
    this.#productionPolicyByThread.delete(removed.thread.id);
    this.#releaseExecutionWorkspaceLeasesForThread(removed.thread.id);
    for (const [turnId, registered] of this.#productionPolicyByTurn) {
      if (registered.threadId === removed.thread.id) {
        this.#releaseExecutionWorkspaceLease(turnId);
        this.#productionPolicyByTurn.delete(turnId);
      }
    }
    for (const [turnId, registered] of this.#chatCapabilityByTurn) {
      if (registered.threadId === removed.thread.id) {
        this.#chatCapabilityByTurn.delete(turnId);
      }
    }
    if (removed.binding !== null) {
      const binding = removed.binding;
      const prefix = activeToolThreadPrefix(accountProfileId, binding.codexThreadId);
      for (const key of this.#activeToolItemsByTurn.keys()) {
        if (key.startsWith(prefix)) this.#activeToolItemsByTurn.delete(key);
      }
      for (const key of this.#completedToolItemsByTurn.keys()) {
        if (key.startsWith(prefix)) this.#completedToolItemsByTurn.delete(key);
      }
      for (const key of this.#toolItemOverflowTurns) {
        if (key.startsWith(prefix)) this.#toolItemOverflowTurns.delete(key);
      }
      this.#saturatedToolActivityAccounts.delete(accountProfileId);
    }
    return true;
  }

  #beginRuntimeGeneration(accountProfileId: string, generation: number): void {
    if (this.#activeRuntimeGenerations.get(accountProfileId) !== generation) {
      this.#clearProviderSubagentsForAccount(accountProfileId);
      this.#reasoningSummaries.advanceGeneration(accountProfileId, generation);
      this.#clearToolActivityForAccount(accountProfileId);
      this.#clearHarnessActorThreadsForAccount(accountProfileId);
      this.#clearProductionPolicyForAccount(accountProfileId);
      this.#clearChatCapabilityForAccount(accountProfileId);
      this.#reportedHydrationFailureGenerations.delete(accountProfileId);
    }
    this.#activeRuntimeGenerations.set(accountProfileId, generation);
    this.#providerSubagents.advanceGeneration(accountProfileId, generation);
  }

  #clearProviderSubagentsForAccount(accountProfileId: string): void {
    for (const scope of this.#providerSubagents.activeScopes(accountProfileId)) {
      this.#providerSubagents.completeTurn(scope);
      this.#publishProviderSubagents(scope);
    }
    this.#providerSubagents.purgeAccount(accountProfileId);
  }

  #admitToolTurn(accountProfileId: string): boolean {
    if (this.#saturatedToolActivityAccounts.has(accountProfileId)) return false;
    const prefix = activeToolAccountPrefix(accountProfileId);
    const keys = new Set<string>();
    for (const key of this.#activeToolItemsByTurn.keys()) {
      if (key.startsWith(prefix)) keys.add(key);
    }
    for (const key of this.#completedToolItemsByTurn.keys()) {
      if (key.startsWith(prefix)) keys.add(key);
    }
    if (keys.size < MAX_SESSION_TRACKED_TOOL_TURNS_PER_ACCOUNT) return true;
    this.#saturatedToolActivityAccounts.add(accountProfileId);
    return false;
  }

  #clearToolActivityForAccount(accountProfileId: string): void {
    const prefix = activeToolAccountPrefix(accountProfileId);
    for (const key of this.#activeToolItemsByTurn.keys()) {
      if (key.startsWith(prefix)) this.#activeToolItemsByTurn.delete(key);
    }
    for (const key of this.#completedToolItemsByTurn.keys()) {
      if (key.startsWith(prefix)) this.#completedToolItemsByTurn.delete(key);
    }
    for (const key of this.#toolItemOverflowTurns) {
      if (key.startsWith(prefix)) this.#toolItemOverflowTurns.delete(key);
    }
    this.#saturatedToolActivityAccounts.delete(accountProfileId);
  }

  #clearHarnessActorThreadsForAccount(accountProfileId: string): void {
    for (const [threadId, registered] of this.#harnessActorThreadsByOwnedId) {
      if (registered.accountProfileId === accountProfileId) {
        this.#harnessActorThreadsByOwnedId.delete(threadId);
      }
    }
  }

  #clearProductionPolicyForAccount(accountProfileId: string): void {
    for (const [threadId, registered] of this.#productionPolicyByThread) {
      if (registered.accountProfileId === accountProfileId) {
        this.#productionPolicyByThread.delete(threadId);
      }
    }
    for (const [turnId, registered] of this.#productionPolicyByTurn) {
      if (registered.accountProfileId === accountProfileId) {
        this.#releaseExecutionWorkspaceLease(turnId);
        this.#productionPolicyByTurn.delete(turnId);
      }
    }
    for (const [turnId, lease] of this.#executionWorkspaceLeaseByTurn) {
      if (lease.accountProfileId === accountProfileId) {
        this.#releaseExecutionWorkspaceLease(turnId);
      }
    }
    for (const [key, lease] of this.#ambiguousExecutionWorkspaceLeaseByRequest) {
      if (lease.accountProfileId === accountProfileId) {
        this.#releaseAmbiguousExecutionWorkspaceLease(key);
      }
    }
  }

  #releaseExecutionWorkspaceLease(turnId: string): void {
    const lease = this.#executionWorkspaceLeaseByTurn.get(turnId);
    if (lease === undefined) return;
    this.#executionWorkspaceLeaseByTurn.delete(turnId);
    try {
      lease.release();
    } catch {
      // Release is idempotent and must not weaken terminal containment.
    }
  }

  #releaseExecutionWorkspaceLeasesForThread(threadId: ThreadSummary["id"]): void {
    for (const [turnId, lease] of this.#executionWorkspaceLeaseByTurn) {
      if (lease.threadId === threadId) this.#releaseExecutionWorkspaceLease(turnId);
    }
    for (const [key, lease] of this.#ambiguousExecutionWorkspaceLeaseByRequest) {
      if (lease.threadId === threadId) {
        this.#releaseAmbiguousExecutionWorkspaceLease(key);
      }
    }
  }

  #assertNoAmbiguousExecutionWorkspaceLease(input: Readonly<{
    accountProfileId: AccountSummary["id"];
    clientUserMessageId: string;
    providerThreadId: string;
  }>): void {
    if (!this.#ambiguousExecutionWorkspaceLeaseByRequest.has(
      ambiguousExecutionWorkspaceLeaseKey(input),
    )) return;
    throw new SessionServiceError(
      "upstream_ambiguous",
      "The prior turn start still requires exact provider reconciliation.",
      false,
      "resolveAttention",
    );
  }

  #retainAmbiguousExecutionWorkspaceLease(
    lease: RegisteredAmbiguousExecutionWorkspaceLease,
  ): void {
    const key = ambiguousExecutionWorkspaceLeaseKey(lease);
    if (this.#ambiguousExecutionWorkspaceLeaseByRequest.has(key)) {
      throw new SessionServiceError(
        "protocol_error",
        "Codex repeated an unresolved turn mutation identity.",
        false,
        "restartRuntime",
      );
    }
    this.#ambiguousExecutionWorkspaceLeaseByRequest.set(
      key,
      Object.freeze({ ...lease }),
    );
  }

  #releaseAmbiguousExecutionWorkspaceLease(key: string): void {
    const lease = this.#ambiguousExecutionWorkspaceLeaseByRequest.get(key);
    if (lease === undefined) return;
    this.#ambiguousExecutionWorkspaceLeaseByRequest.delete(key);
    try {
      lease.release();
    } catch {
      // Release is idempotent and cannot alter the reconciled disposition.
    }
  }

  #exactProviderTurnIsTerminal(input: Readonly<{
    accountProfileId: AccountSummary["id"];
    providerThreadId: string;
    providerTurnId: string;
  }>): boolean {
    const turn = this.#store.getSnapshot().turns[sessionEntityKey(
      input.accountProfileId,
      input.providerTurnId,
    )];
    return turn !== undefined &&
      turn.threadKey === sessionEntityKey(
        input.accountProfileId,
        input.providerThreadId,
      ) &&
      turn.status !== "active";
  }

  /**
   * A positioned terminal notification can overtake a delayed lower-position
   * `turn/start` response. The terminal fact cannot release a lease that has
   * not been registered yet, while the later response facts are correctly
   * rejected by the account cursor. Re-check the exact canonical turn after
   * fact consumption so that ordering can never strand the old folder root.
   */
  #releaseProductionTurnAdmissionIfSuperseded(input: Readonly<{
    accountProfileId: AccountSummary["id"];
    generation: number;
    providerThreadId: string;
    providerTurnId: string;
    responseStreamPosition: CodexStreamPosition;
  }>): boolean {
    const cursor = this.#store.getSnapshot().cursors[
      sessionAccountKey(input.accountProfileId)
    ];
    if (
      cursor === undefined ||
      cursor.generation !== input.generation ||
      cursor.streamPosition <= input.responseStreamPosition ||
      !this.#exactProviderTurnIsTerminal(input)
    ) return false;
    const turnId = ownedCodexId(
      "turn",
      input.accountProfileId,
      input.providerTurnId,
    );
    this.#releaseExecutionWorkspaceLease(turnId);
    this.#productionPolicyByTurn.delete(turnId);
    this.#chatCapabilityByTurn.delete(turnId);
    return true;
  }

  #clearChatCapabilityForAccount(accountProfileId: string): void {
    for (const [key, catalog] of this.#chatCatalogsByEvidence) {
      if (catalog.accountProfileId === accountProfileId) {
        this.#chatCatalogsByEvidence.delete(key);
      }
    }
    for (const [turnId, registered] of this.#chatCapabilityByTurn) {
      if (registered.accountProfileId === accountProfileId) {
        this.#chatCapabilityByTurn.delete(turnId);
      }
    }
  }

  async #observeHarnessActorRecoveryProof(input: Readonly<{
    actorId: string;
    accountProfileId: AccountSummary["id"];
    admissionGeneration: number;
    expectedGeneration: number;
    initialStreamPosition: CodexStreamPosition | null;
    priorRecoveryProofDigest: string | null;
    providerThreadId: string;
    threadProjection?: PinnedCodexThread;
    threadSource: string;
    workspaceMode: "managed" | "readOnly";
    workspacePath: string;
  }>): Promise<SessionHarnessActorRecoveryProofV2> {
    let sourceStreamPosition = input.initialStreamPosition;
    const accept = <Output>(
      positioned: PinnedCodexResponseAtPosition<Output>,
    ): Output => {
      this.#assertHarnessGeneration(
        input.accountProfileId,
        input.expectedGeneration,
      );
      if (
        positioned.generation !== input.expectedGeneration ||
        (sourceStreamPosition !== null &&
          positioned.streamPosition <= sourceStreamPosition)
      ) {
        throw new SessionServiceError(
          "conflict",
          "The actor-session observation generation or response order changed.",
          true,
          "retry",
        );
      }
      sourceStreamPosition = positioned.streamPosition;
      return positioned.output;
    };
    const reader = {
      threadTurnsList: async (
        request: PinnedCodexRequestInput<"threadTurnsList">,
      ) => accept(await this.#commands.threadTurnsList(
        input.accountProfileId,
        request,
        input.expectedGeneration,
      )),
      threadItemsList: async (
        request: PinnedCodexRequestInput<"threadItemsList">,
      ) => accept(await this.#commands.threadItemsList(
        input.accountProfileId,
        request,
        input.expectedGeneration,
      )),
    };
    const first = await scanPinnedCodexTurns(reader, input.providerThreadId);
    const firstObservationPosition = sourceStreamPosition;
    const second = await scanPinnedCodexTurns(reader, input.providerThreadId);
    const secondObservationPosition = sourceStreamPosition;
    if (
      firstObservationPosition === null ||
      secondObservationPosition === null ||
      secondObservationPosition <= firstObservationPosition
    ) {
      throw new SessionServiceError(
        "conflict",
        "The actor-session observation positions are incomplete.",
        true,
        "retry",
      );
    }
    if (
      first.threadId !== input.providerThreadId ||
      second.threadId !== input.providerThreadId ||
      !first.complete || !second.complete ||
      !pinnedCodexTurnScansHaveExactEvidence(first, second) ||
      !harnessActorRecoveryScanHasUniqueIdentity(first) ||
      (input.threadProjection !== undefined &&
        !harnessActorThreadProjectionFitsRecoveryScan(
          input.threadProjection,
          first,
        ))
    ) {
      throw new SessionHarnessActorRecoveryErrorV2(
        "history_unstable",
        "The actor-session history is incomplete, unstable, or ambiguous.",
      );
    }
    const historyEvidenceDigest = pinnedCodexTurnScanEvidenceDigest(first);
    const historyTurnCount = first.turns.length;
    const historyItemCount = first.turns.reduce(
      (count, entry) => count + entry.items.length,
      0,
    );
    const proofHasher = new Bun.CryptoHasher("sha256");
    proofHasher.update("oprte.harness.actor-session-recovery-proof.v2\0");
    proofHasher.update(JSON.stringify({
      actorId: input.actorId,
      accountProfileId: input.accountProfileId,
      admissionGeneration: input.admissionGeneration,
      observationGeneration: input.expectedGeneration,
      priorRecoveryProofDigest: input.priorRecoveryProofDigest,
      providerThreadId: input.providerThreadId,
      threadSource: input.threadSource,
      workspaceMode: input.workspaceMode,
      workspacePath: input.workspacePath,
      historyEvidenceDigest,
      firstObservationPosition,
      secondObservationPosition,
      historyTurnCount,
      historyItemCount,
    }));
    return Object.freeze({
      recoveryProofDigest: proofHasher.digest("hex"),
      priorRecoveryProofDigest: input.priorRecoveryProofDigest,
      observationGeneration: input.expectedGeneration,
      historyEvidenceDigest,
      firstObservationPosition,
      secondObservationPosition,
      historyTurnCount,
      historyItemCount,
    });
  }

  async #preflightProductionExecutionPolicy(
    accountProfileId: AccountSummary["id"],
    expectedGeneration?: number,
  ): Promise<ProductionExecutionPolicyProof> {
    const positioned = await this.#commands.configRequirementsRead(
      accountProfileId,
      expectedGeneration,
    );
    if (
      expectedGeneration !== undefined &&
      positioned.generation !== expectedGeneration
    ) {
      throw new SessionServiceError(
        "conflict",
        "The Codex runtime generation changed before execution admission.",
        true,
        "retry",
      );
    }
    try {
      return verifyProductionExecutionPolicyRequirements({
        generation: positioned.generation,
        streamPosition: positioned.streamPosition,
        output: positioned.output,
      });
    } catch (error: unknown) {
      if (
        error instanceof ProductionExecutionPolicyError &&
        error.reason === "managed_requirements_rejected_policy"
      ) {
        throw new SessionServiceError(
          "capability_unavailable",
          "This Codex profile does not permit HRA's required full-access policy.",
          false,
          "none",
        );
      }
      throw new SessionServiceError(
        "protocol_error",
        "Codex returned invalid production-policy requirements.",
        false,
        "restartRuntime",
      );
    }
  }

  async #preflightScheduleInterpreterExecutionPolicy(
    accountProfileId: AccountSummary["id"],
    expectedGeneration: number,
  ): Promise<ScheduleInterpreterExecutionPolicyProof> {
    const positioned = await this.#commands.configRequirementsRead(
      accountProfileId,
      expectedGeneration,
    );
    if (positioned.generation !== expectedGeneration) {
      throw new SessionServiceError(
        "conflict",
        "The Codex runtime generation changed before schedule interpretation.",
        true,
        "retry",
      );
    }
    try {
      return verifyScheduleInterpreterExecutionPolicyRequirements({
        generation: positioned.generation,
        streamPosition: positioned.streamPosition,
        output: positioned.output,
      });
    } catch (error: unknown) {
      if (
        error instanceof ScheduleInterpreterExecutionPolicyError &&
        error.reason === "managed_requirements_rejected_policy"
      ) {
        throw new SessionServiceError(
          "capability_unavailable",
          "This Codex profile cannot provide the required no-tool schedule interpreter.",
          false,
          "none",
        );
      }
      throw new SessionServiceError(
        "protocol_error",
        "Codex returned invalid schedule-interpreter policy requirements.",
        false,
        "restartRuntime",
      );
    }
  }

  async #scheduleInterpreterMcpServerNames(
    accountProfileId: AccountSummary["id"],
    expectedGeneration: number,
  ): Promise<readonly string[]> {
    const names = new Set<string>();
    const seenCursors = new Set<string>();
    let cursor: string | null = null;
    for (let page = 0; page < 8; page += 1) {
      const positioned = await this.#commands.mcpServerStatusList(
        accountProfileId,
        { cursor, limit: 64, detail: "toolsAndAuthOnly", threadId: null },
        expectedGeneration,
      );
      if (positioned.generation !== expectedGeneration) {
        throw new SessionServiceError(
          "conflict",
          "The Codex runtime generation changed while fencing interpreter tools.",
          true,
          "retry",
        );
      }
      for (const server of positioned.output.data) names.add(server.name);
      const nextCursor = positioned.output.nextCursor;
      if (nextCursor === null) return Object.freeze([...names].sort());
      if (seenCursors.has(nextCursor)) {
        throw new SessionServiceError(
          "protocol_error",
          "Codex returned a cyclic MCP server catalog.",
          false,
          "restartRuntime",
        );
      }
      seenCursors.add(nextCursor);
      cursor = nextCursor;
    }
    throw new SessionServiceError(
      "capability_unavailable",
      "The MCP server catalog is too large to fence schedule interpretation safely.",
      false,
      "none",
    );
  }

  async #requireScheduleInterpreterHasNoMcpTools(input: Readonly<{
    accountProfileId: AccountSummary["id"];
    generation: number;
    rawThreadId: string;
    afterPosition: CodexStreamPosition;
  }>): Promise<void> {
    const positioned = await this.#commands.mcpServerStatusList(
      input.accountProfileId,
      {
        cursor: null,
        limit: 64,
        detail: "toolsAndAuthOnly",
        threadId: input.rawThreadId,
      },
      input.generation,
    );
    if (
      positioned.generation !== input.generation ||
      positioned.streamPosition <= input.afterPosition
    ) {
      throw new SessionServiceError(
        "protocol_error",
        "The interpreter MCP fence was observed outside its admission window.",
        false,
        "restartRuntime",
      );
    }
    if (
      positioned.output.data.length !== 0 ||
      positioned.output.nextCursor !== null
    ) {
      throw new SessionServiceError(
        "capability_unavailable",
        "Schedule interpretation is unavailable because a tool server remained active.",
        false,
        "none",
      );
    }
  }

  #runtimeWorkspaceSnapshot(fallbackCwd: string): Readonly<{
    revision: number;
    runtimeWorkspaceRoots: readonly [string];
  }> {
    const snapshot = this.#execution?.runtimeWorkspaceSnapshot?.() ?? {
      revision: 0,
      runtimeWorkspaceRoots: this.#execution === undefined
        ? [fallbackCwd] as const
        : this.#execution.runtimeWorkspaceRoots(),
    };
    if (
      !Number.isSafeInteger(snapshot.revision) ||
      snapshot.revision < 0 ||
      snapshot.runtimeWorkspaceRoots.length !== 1
    ) {
      throw new SessionServiceError(
        "protocol_error",
        "HRA produced an invalid global folder capability snapshot.",
        false,
        "restartRuntime",
      );
    }
    const runtimeWorkspaceRoots = Object.freeze<readonly [string]>([
      snapshot.runtimeWorkspaceRoots[0],
    ]);
    return Object.freeze({
      revision: snapshot.revision,
      runtimeWorkspaceRoots,
    });
  }

  async #acquireRuntimeWorkspaceAdmission(
    fallbackCwd: string,
  ): Promise<Readonly<{
    revision: number;
    runtimeWorkspaceRoots: readonly [string];
    release(): void;
  }>> {
    const acquire = this.#execution?.acquireRuntimeWorkspaceAdmission;
    if (acquire === undefined) {
      const snapshot = this.#runtimeWorkspaceSnapshot(fallbackCwd);
      return Object.freeze({ ...snapshot, release: () => undefined });
    }
    const admission = await acquire();
    if (
      !Number.isSafeInteger(admission.revision) ||
      admission.revision < 0 ||
      admission.runtimeWorkspaceRoots.length !== 1
    ) {
      admission.release();
      throw new SessionServiceError(
        "protocol_error",
        "HRA acquired an invalid global folder admission.",
        false,
        "restartRuntime",
      );
    }
    return admission;
  }

  #executionThreadConfig(
    existing?: NonNullable<PinnedCodexRequestInput<"threadStart">["config"]>,
  ): NonNullable<PinnedCodexRequestInput<"threadStart">["config"]> | undefined {
    if (this.#execution === undefined) return existing;
    return withComputerUseThreadConfig(
      this.#execution.computerUse,
      existing,
    ) as NonNullable<PinnedCodexRequestInput<"threadStart">["config"]>;
  }

  #executionDeveloperInstructions(
    existing?: string,
  ): string | undefined {
    if (this.#execution === undefined) return existing;
    return withComputerUseDeveloperInstructions(
      this.#execution.computerUse,
      existing,
    );
  }

  /**
   * A folder-selection revision changes the capability roots, not the chat's
   * cwd. Re-admit the existing provider thread under the newest root before a
   * turn can be submitted, and repeat if the selection changes during either
   * admission preflight.
   */
  async #admitCurrentProductionThreadRoots(input: Readonly<{
    accountProfileId: AccountSummary["id"];
    expectedGeneration: number;
    threadId: ThreadSummary["id"];
    model: "gpt-5.6-sol" | "gpt-5.6-luna";
    serviceTier: string | null;
    config: PinnedCodexRequestInput<"threadResume">["config"];
    developerInstructions: string | undefined;
  }>): Promise<Readonly<{
    executionSettingsRevision: number;
    proof: ProductionExecutionPolicyProof;
    receipt: ProductionExecutionPolicyReceipt;
    runtimeWorkspaceRoots: [string];
    releaseWorkspaceAdmission(): void;
  }>> {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const binding = this.#registry.requireBinding(input.threadId);
      if (
        binding.accountProfileId !== input.accountProfileId ||
        this.#activeRuntimeGenerations.get(input.accountProfileId) !==
          input.expectedGeneration
      ) {
        throw new SessionServiceError(
          "conflict",
          "The chat runtime changed before folder admission.",
          true,
          "retry",
        );
      }
      const proof = await this.#preflightProductionExecutionPolicy(
        input.accountProfileId,
        input.expectedGeneration,
      );
      const workspace = this.#runtimeWorkspaceSnapshot(binding.cwd);
      const roots = [...workspace.runtimeWorkspaceRoots];
      const current = this.#productionPolicyByThread.get(input.threadId);
      if (
        current === undefined ||
        current.receipt.generation !== proof.generation ||
        current.receipt.executionSettingsRevision !== workspace.revision ||
        !sameOrderedStrings(current.receipt.runtimeWorkspaceRoots, roots)
      ) {
        const resumeInput: PinnedCodexRequestInput<"threadResume"> = {
          threadId: binding.codexThreadId,
          model: input.model,
          serviceTier: input.serviceTier,
          cwd: binding.cwd,
          runtimeWorkspaceRoots: roots,
          approvalPolicy: HRA_PRODUCTION_EXECUTION_POLICY.approvalPolicy,
          approvalsReviewer: HRA_PRODUCTION_EXECUTION_POLICY.approvalsReviewer,
          sandbox: HRA_PRODUCTION_EXECUTION_POLICY.threadSandbox,
          config: input.config,
          developerInstructions: input.developerInstructions,
        };
        const positioned = await this.#commands.threadResume(
          input.accountProfileId,
          resumeInput,
          proof.generation,
        );
        if (
          positioned.generation !== proof.generation ||
          positioned.output.thread.id !== binding.codexThreadId ||
          positioned.output.thread.cwd !== binding.cwd
        ) {
          throw new SessionServiceError(
            "protocol_error",
            "Codex resumed a different chat while updating folder access.",
            false,
            "restartRuntime",
          );
        }
        await this.#registerProductionThreadPolicy({
          accountProfileId: input.accountProfileId,
          proof,
          positioned,
          request: resumeInput,
          executionSettingsRevision: workspace.revision,
        });
      }

      const workspaceAdmission = await this.#acquireRuntimeWorkspaceAdmission(binding.cwd);
      if (
        workspaceAdmission.revision !== workspace.revision ||
        !sameOrderedStrings(workspaceAdmission.runtimeWorkspaceRoots, roots)
      ) {
        workspaceAdmission.release();
        continue;
      }
      try {
        const turnProof = await this.#preflightProductionExecutionPolicy(
          input.accountProfileId,
          input.expectedGeneration,
        );
        const receipt = this.#requireProductionThreadPolicy(
          input.threadId,
          turnProof.generation,
        );
        if (
          receipt.executionSettingsRevision !== workspaceAdmission.revision ||
          !sameOrderedStrings(
            receipt.runtimeWorkspaceRoots,
            workspaceAdmission.runtimeWorkspaceRoots,
          )
        ) {
          workspaceAdmission.release();
          continue;
        }
        return Object.freeze({
          executionSettingsRevision: workspaceAdmission.revision,
          proof: turnProof,
          receipt,
          runtimeWorkspaceRoots: [
            workspaceAdmission.runtimeWorkspaceRoots[0],
          ] as [string],
          releaseWorkspaceAdmission: workspaceAdmission.release,
        });
      } catch (error: unknown) {
        workspaceAdmission.release();
        throw error;
      }
    }
    throw new SessionServiceError(
      "conflict",
      "The global folder changed too often to admit this turn safely.",
      true,
      "retry",
    );
  }

  async #registerProductionThreadPolicy(input: Readonly<{
    readonly accountProfileId: AccountSummary["id"];
    readonly proof: ProductionExecutionPolicyProof;
    readonly positioned: PinnedCodexResponseAtPosition<
      PinnedCodexRequestOutput<"threadStart">
    >;
    readonly request:
      | PinnedCodexRequestInput<"threadStart">
      | PinnedCodexRequestInput<"threadResume">;
    readonly executionSettingsRevision: number;
  }>): Promise<ProductionExecutionPolicyReceipt> {
    let receipt: ProductionExecutionPolicyReceipt;
    try {
      receipt = verifyProductionThreadAdmission({
        proof: input.proof,
        generation: input.positioned.generation,
        streamPosition: input.positioned.streamPosition,
        request: input.request,
        response: input.positioned.output,
        executionSettingsRevision: input.executionSettingsRevision,
      });
    } catch {
      throw new SessionServiceError(
        "protocol_error",
        "Codex did not preserve HRA's required full-access thread policy.",
        false,
        "restartRuntime",
      );
    }
    const threadId = ownedCodexId(
      "thread",
      input.accountProfileId,
      input.positioned.output.thread.id,
    );
    let computerUseReceipt: ComputerUseAdmissionReceipt | undefined;
    if (this.#execution !== undefined) {
      const status = await this.#commands.mcpServerStatusList(
        input.accountProfileId,
        {
          cursor: null,
          limit: 64,
          detail: "toolsAndAuthOnly",
          threadId: input.positioned.output.thread.id,
        },
        input.positioned.generation,
      );
      if (
        status.generation !== input.positioned.generation
        || status.streamPosition <= input.positioned.streamPosition
      ) {
        throw new SessionServiceError(
          "protocol_error",
          "Computer Use readiness was observed outside the thread admission fence.",
          false,
          "restartRuntime",
        );
      }
      try {
        computerUseReceipt = verifyComputerUseServerStatus({
          provisioning: this.#execution.computerUse,
          generation: status.generation,
          threadId: input.positioned.output.thread.id,
          streamPosition: status.streamPosition,
          output: status.output,
        });
      } catch {
        throw new SessionServiceError(
          "capability_unavailable",
          "Computer Use did not become ready. Update ChatGPT, open it once, then restart HRA.",
          false,
          "none",
        );
      }
    }
    this.#productionPolicyByThread.set(threadId, Object.freeze({
      accountProfileId: input.accountProfileId,
      ...(computerUseReceipt === undefined ? {} : { computerUseReceipt }),
      receipt,
      threadId,
    }));
    return receipt;
  }

  #requireProductionThreadPolicy(
    threadId: ThreadSummary["id"],
    generation: number,
  ): ProductionExecutionPolicyReceipt {
    const registered = this.#productionPolicyByThread.get(threadId);
    if (
      registered === undefined ||
      registered.receipt.generation !== generation ||
      this.#activeRuntimeGenerations.get(registered.accountProfileId) !== generation
    ) {
      throw new SessionServiceError(
        "conflict",
        "The chat's verified full-access admission is no longer active.",
        true,
        "retry",
      );
    }
    if (this.#execution !== undefined) {
      const computerUseReceipt = registered.computerUseReceipt;
      if (computerUseReceipt === undefined) {
        throw new SessionServiceError(
          "capability_unavailable",
          "The chat lacks verified Computer Use capability.",
          false,
          "none",
        );
      }
      requireComputerUseAdmissionReceipt({
        receipt: computerUseReceipt,
        generation,
        threadId: this.#registry.requireBinding(threadId).codexThreadId,
      });
    }
    return registered.receipt;
  }

  #registerProductionTurnPolicy(input: Readonly<{
    readonly accountProfileId: AccountSummary["id"];
    readonly proof: ProductionExecutionPolicyProof;
    readonly positioned: PinnedCodexResponseAtPosition<PinnedCodexRequestOutput<"turnStart">>;
    readonly request: PinnedCodexRequestInput<"turnStart">;
    readonly threadId: ThreadSummary["id"];
    readonly threadReceipt: ProductionExecutionPolicyReceipt;
    readonly executionSettingsRevision: number;
    readonly releaseWorkspaceAdmission: () => void;
  }>): ProductionExecutionPolicyReceipt {
    let receipt: ProductionExecutionPolicyReceipt;
    try {
      receipt = verifyProductionTurnAdmission({
        proof: input.proof,
        threadReceipt: input.threadReceipt,
        generation: input.positioned.generation,
        streamPosition: input.positioned.streamPosition,
        request: input.request,
        executionSettingsRevision: input.executionSettingsRevision,
      });
    } catch {
      throw new SessionServiceError(
        "protocol_error",
        "Codex did not preserve HRA's required full-access turn policy.",
        false,
        "restartRuntime",
      );
    }
    const turnId = ownedCodexId(
      "turn",
      input.accountProfileId,
      input.positioned.output.turn.id,
    );
    if (this.#executionWorkspaceLeaseByTurn.has(turnId)) {
      throw new SessionServiceError(
        "protocol_error",
        "Codex reused an active turn identity across folder admissions.",
        false,
        "restartRuntime",
      );
    }
    this.#executionWorkspaceLeaseByTurn.set(turnId, Object.freeze({
      accountProfileId: input.accountProfileId,
      release: input.releaseWorkspaceAdmission,
      threadId: input.threadId,
    }));
    this.#productionPolicyByTurn.set(turnId, Object.freeze({
      accountProfileId: input.accountProfileId,
      receipt,
      threadId: input.threadId,
    }));
    return receipt;
  }

  #assertHarnessGeneration(accountProfileId: string, expectedGeneration: number): void {
    if (!Number.isSafeInteger(expectedGeneration) || expectedGeneration <= 0) {
      throw new SessionServiceError(
        "invalid_request",
        "The harness actor runtime generation is invalid.",
        false,
        "none",
      );
    }
    if (this.#activeRuntimeGenerations.get(accountProfileId) !== expectedGeneration) {
      throw new SessionServiceError(
        "conflict",
        "The harness actor runtime generation is no longer active.",
        true,
        "retry",
      );
    }
  }

  #requireHarnessActorThread(
    reference: SessionHarnessActorThreadReference,
    expectedGeneration: number,
    expectedActorId?: string,
  ): RegisteredHarnessActorThread {
    const binding: SessionThreadBinding | null = reference.kind === "gateway"
      ? this.#registry.bindingByOwnedId(reference.threadId)
      : this.#registry.bindingByCodexId(
          reference.accountProfileId,
          reference.providerThreadId,
        );
    if (binding === null) {
      throw new SessionServiceError(
        "not_found",
        "The harness actor session is unavailable.",
        true,
        "retry",
      );
    }
    const threadId = ownedCodexId(
      "thread",
      binding.accountProfileId,
      binding.codexThreadId,
    );
    const registered = this.#harnessActorThreadsByOwnedId.get(threadId);
    this.#assertHarnessGeneration(binding.accountProfileId, expectedGeneration);
    const projected = this.#registry.threadByOwnedId(threadId);
    if (
      registered === undefined ||
      (expectedActorId !== undefined && registered.actorId !== expectedActorId) ||
      registered.accountProfileId !== binding.accountProfileId ||
      registered.generation !== expectedGeneration ||
      registered.providerThreadId !== binding.codexThreadId ||
      registered.threadId !== threadId ||
      projected === null ||
      projected.id !== threadId ||
      projected.accountProfileId !== binding.accountProfileId ||
      projected.projectId !== binding.projectId ||
      projected.workspaceLaneId !== binding.workspaceLaneId ||
      (reference.kind === "gateway" && reference.threadId !== threadId) ||
      (reference.kind === "provider" && (
        reference.accountProfileId !== binding.accountProfileId ||
        reference.providerThreadId !== binding.codexThreadId
      ))
    ) {
      throw new SessionServiceError(
        "conflict",
        "The harness actor session identity no longer matches its active incarnation.",
        true,
        "retry",
      );
    }
    return registered;
  }

}

function activeToolAccountPrefix(accountProfileId: string): string {
  return sessionAccountKey(accountProfileId);
}

function activeToolThreadPrefix(accountProfileId: string, threadId: string): string {
  return `${activeToolAccountPrefix(accountProfileId)}${String(threadId.length)}:${threadId}`;
}

function activeToolKey(accountProfileId: string, threadId: string, turnId: string): string {
  return `${activeToolThreadPrefix(accountProfileId, threadId)}${turnId}`;
}

function rememberCompletedTool(completed: Set<string>, providerItemId: string): boolean {
  if (completed.has(providerItemId)) return false;
  if (completed.size >= MAX_SESSION_ACTIVE_TOOL_ITEMS_PER_TURN) return false;
  completed.add(providerItemId);
  return true;
}

interface HarnessHistoryProjectionInput {
  accountProfileId: string;
  expectedThreadId: ThreadSummary["id"];
  throughTurnId: string;
  currentProviderTurnId: string;
  first: PinnedCodexTurnScan;
  second: PinnedCodexTurnScan;
  sourceGeneration: number;
  sourceStreamPosition: CodexStreamPosition;
}

function projectHarnessActorContinuationHistory(input: Readonly<{
  accountProfileId: string;
  expectedProviderThreadId: string;
  expectedProviderTurnId: string;
  first: PinnedCodexTurnScan;
  second: PinnedCodexTurnScan;
}>): SessionHarnessActorContinuationHistory {
  if (
    input.first.threadId !== input.expectedProviderThreadId ||
    input.second.threadId !== input.expectedProviderThreadId ||
    !input.first.complete ||
    !input.second.complete ||
    !pinnedCodexTurnScansHaveExactEvidence(input.first, input.second) ||
    [input.first, input.second].some((scan) => scan.turns.some(({ items }) =>
      items.some((item) => item.type === "contextCompaction")
    ))
  ) {
    throw new SessionServiceError(
      "conflict",
      "The actor continuation history is incomplete, compacted, or unstable.",
      true,
      "retry",
    );
  }
  const turnIds = input.first.turns.map(({ turn }) => turn.id);
  const itemIds = input.first.turns.flatMap(({ items }) => items.map(({ id }) => id));
  const sourceIndexes = input.first.turns.flatMap(({ turn }, index) =>
    turn.id === input.expectedProviderTurnId ? [index] : []
  );
  const source = sourceIndexes.length === 1
    ? input.first.turns[sourceIndexes[0]!]
    : undefined;
  if (
    new Set(turnIds).size !== turnIds.length ||
    new Set(itemIds).size !== itemIds.length ||
    sourceIndexes.length !== 1 ||
    sourceIndexes[0] !== input.first.turns.length - 1 ||
    source === undefined ||
    source.turn.status !== "failed" ||
    !("quotaProof" in source.turn) ||
    source.turn.quotaProof !== "provider_usage_limit_exceeded" ||
    input.first.turns.some(({ turn }) => turn.status === "inProgress")
  ) {
    throw new SessionServiceError(
      "conflict",
      "The actor continuation source is not one exact terminal quota turn.",
      true,
      "retry",
    );
  }

  const items: SessionHarnessActorHistoryItem[] = [];
  for (const entry of input.first.turns) {
    for (const item of entry.items) {
      if (item.type === "userMessage") {
        if (item.context.kind !== "plainText") {
          throw new SessionServiceError(
            "conflict",
            "The actor continuation contains non-representable user input.",
            true,
            "retry",
          );
        }
        items.push({ role: "user", text: item.context.text });
      } else if (item.type === "agentMessage") {
        if (item.phase === null || (
          item.phase === "final_answer" && item.context.kind !== "plainTextFinal"
        )) {
          throw new SessionServiceError(
            "conflict",
            "The actor continuation contains ambiguous assistant history.",
            true,
            "retry",
          );
        }
        if (item.context.kind === "plainTextFinal") {
          items.push({ role: "assistant", text: item.context.text });
        }
      }
    }
  }
  const normalized = normalizeHarnessActorHistoryItems(items);
  return Object.freeze({
    historyDigest: digestHarnessActorHistory(normalized.items),
    itemCount: normalized.items.length,
    items: normalized.items,
    totalUtf8Bytes: normalized.totalUtf8Bytes,
  });
}

function validateHarnessActorContinuationHistory(
  value: SessionHarnessActorContinuationHistory,
): SessionHarnessActorContinuationHistory {
  if (
    !/^[a-f0-9]{64}$/u.test(value.historyDigest)
  ) {
    throw new SessionServiceError(
      "invalid_request",
      "The actor continuation history proof is invalid.",
      false,
      "none",
    );
  }
  const normalized = normalizeHarnessActorHistoryItems(value.items);
  const digest = digestHarnessActorHistory(normalized.items);
  if (
    value.itemCount !== normalized.items.length ||
    value.totalUtf8Bytes !== normalized.totalUtf8Bytes ||
    value.historyDigest !== digest
  ) {
    throw new SessionServiceError(
      "invalid_request",
      "The actor continuation history metadata does not match its text.",
      false,
      "none",
    );
  }
  return Object.freeze({
    historyDigest: digest,
    itemCount: normalized.items.length,
    items: normalized.items,
    totalUtf8Bytes: normalized.totalUtf8Bytes,
  });
}

function normalizeHarnessActorHistoryItems(
  values: unknown,
): Readonly<{
  items: readonly SessionHarnessActorHistoryItem[];
  totalUtf8Bytes: number;
}> {
  if (
    !Array.isArray(values) ||
    values.length === 0 ||
    values.length > MAX_SESSION_HARNESS_CONTINUATION_ITEMS
  ) {
    throw new SessionServiceError(
      "conflict",
      "The actor continuation history item count is unavailable.",
      true,
      "retry",
    );
  }
  let totalUtf8Bytes = 0;
  const unknownItems: readonly unknown[] = values;
  const items = unknownItems.map((item): SessionHarnessActorHistoryItem => {
    const role = item !== null && typeof item === "object" && "role" in item
      ? item.role
      : null;
    const text = item !== null && typeof item === "object" && "text" in item
      ? item.text
      : null;
    if (
      (role !== "user" && role !== "assistant") ||
      typeof text !== "string" ||
      text.length === 0 ||
      text.includes("\0")
    ) {
      throw new SessionServiceError(
        "conflict",
        "The actor continuation contains unsupported text history.",
        true,
        "retry",
      );
    }
    const utf8Bytes = Buffer.byteLength(text, "utf8");
    totalUtf8Bytes += utf8Bytes;
    if (
      utf8Bytes > MAX_SESSION_HARNESS_HISTORY_ITEM_UTF8_BYTES ||
      totalUtf8Bytes > MAX_SESSION_HARNESS_HISTORY_UTF8_BYTES
    ) {
      throw new SessionServiceError(
        "conflict",
        "The actor continuation history byte bound was exceeded.",
        true,
        "retry",
      );
    }
    return Object.freeze({ role, text });
  });
  return Object.freeze({
    items: Object.freeze(items),
    totalUtf8Bytes,
  });
}

function projectHarnessActorHistoryReadback(
  output: PinnedCodexRequestOutput<"threadHistoryRead">,
): readonly SessionHarnessActorHistoryItem[] | null {
  const items: SessionHarnessActorHistoryItem[] = [];
  for (const turn of output.thread.turns) {
    if (turn.itemsView !== "full" || turn.status === "inProgress") return null;
    for (const item of turn.items) {
      if (item.type === "userMessage") {
        if (item.context.kind !== "plainText") return null;
        items.push({ role: "user", text: item.context.text });
      } else if (
        item.type === "agentMessage" &&
        item.phase === "final_answer" &&
        item.context.kind === "plainTextFinal"
      ) {
        items.push({ role: "assistant", text: item.context.text });
      } else {
        return null;
      }
    }
  }
  try {
    return normalizeHarnessActorHistoryItems(items).items;
  } catch {
    return null;
  }
}

function digestHarnessActorHistory(
  items: readonly SessionHarnessActorHistoryItem[],
): string {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update("oprte.harness.actor-continuation-history.v1\0");
  for (const item of items) {
    const bytes = Buffer.from(item.text, "utf8");
    hasher.update(item.role).update("\0").update(String(bytes.length)).update(":");
    hasher.update(bytes).update("\0");
  }
  return hasher.digest("hex");
}

function harnessActorHistoryReadEvidenceDigest(
  output: PinnedCodexRequestOutput<"threadHistoryRead">,
): string {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update("oprte.harness.actor-continuation-readback.v1\0");
  hasher.update(JSON.stringify(output));
  return hasher.digest("hex");
}

function harnessActorHistoriesEqual(
  left: readonly SessionHarnessActorHistoryItem[],
  right: readonly SessionHarnessActorHistoryItem[],
): boolean {
  return left.length === right.length && left.every((item, index) =>
    item.role === right[index]?.role && item.text === right[index]?.text
  );
}

function harnessActorRecoveryScanHasUniqueIdentity(
  scan: PinnedCodexTurnScan,
): boolean {
  const turnIds = new Set<string>();
  const itemIds = new Set<string>();
  for (const { turn, items } of scan.turns) {
    if (turnIds.has(turn.id)) return false;
    turnIds.add(turn.id);
    for (const item of items) {
      if (itemIds.has(item.id)) return false;
      itemIds.add(item.id);
    }
  }
  return true;
}

function harnessActorThreadProjectionFitsRecoveryScan(
  projection: PinnedCodexThread,
  scan: PinnedCodexTurnScan,
): boolean {
  if (projection.id !== scan.threadId) return false;
  const projectedTurnIds = new Set<string>();
  const observed = new Map(scan.turns.map(({ turn }) => [turn.id, turn]));
  for (const turn of projection.turns) {
    if (projectedTurnIds.has(turn.id)) return false;
    projectedTurnIds.add(turn.id);
    const exact = observed.get(turn.id);
    if (
      exact === undefined || exact.status !== turn.status ||
      exact.startedAt !== turn.startedAt || exact.completedAt !== turn.completedAt
    ) return false;
  }
  return true;
}

function projectHarnessCurrentInput(
  input: Readonly<HarnessHistoryProjectionInput>,
): SessionHarnessCurrentInput {
  const witness = harnessHistoryCoverageWitness(input.first, input.second);
  if (
    ownedCodexId("thread", input.accountProfileId, input.first.threadId) !==
      input.expectedThreadId ||
    input.second.threadId !== input.first.threadId ||
    !input.first.complete ||
    !input.second.complete ||
    !pinnedCodexTurnScansHaveExactEvidence(input.first, input.second) ||
    harnessScanHasAmbiguousAssistantPhase(input.first)
  ) {
    throw new SessionServiceError(
      "conflict",
      "The current harness input lacks complete stable history evidence.",
      true,
      "retry",
    );
  }
  const matching = input.first.turns.filter(
    ({ turn }) => turn.id === input.currentProviderTurnId,
  );
  const current = matching[0];
  const currentIndex = current === undefined
    ? -1
    : input.first.turns.indexOf(current);
  const messages = current?.items.filter((item) => item.type === "userMessage") ?? [];
  const message = messages[0];
  if (
    matching.length !== 1 ||
    currentIndex !== input.first.turns.length - 1 ||
    current?.turn.status !== "inProgress" ||
    messages.length !== 1 ||
    message === undefined ||
    message.context.kind !== "plainText" ||
    Buffer.byteLength(message.context.text, "utf8") >
      MAX_SESSION_HARNESS_HISTORY_ITEM_UTF8_BYTES
  ) {
    throw new SessionServiceError(
      "conflict",
      "The current harness input is not uniquely available.",
      true,
      "retry",
    );
  }
  return Object.freeze({
    turnId: input.throughTurnId,
    sourceGeneration: input.sourceGeneration,
    sourceStreamPosition: input.sourceStreamPosition,
    coverageWitnessDigest: witness,
    text: message.context.text,
  });
}

function projectHarnessCompletedHistory(
  input: Readonly<HarnessHistoryProjectionInput>,
): SessionHarnessCompletedHistory {
  const witness = harnessHistoryCoverageWitness(input.first, input.second);
  if (
    ownedCodexId("thread", input.accountProfileId, input.first.threadId) !==
      input.expectedThreadId ||
    input.second.threadId !== input.first.threadId
  ) {
    return unavailableHarnessCompletedHistory(input, witness);
  }
  // A compaction marker proves that the provider-visible prefix may omit
  // content even when both paged scans are internally stable. Until Codex
  // exposes an exact retained-prefix contract, no item from either scan can
  // become RLM context authority.
  if (
    [input.first, input.second].some((scan) => scan.turns.some(({ items }) =>
      items.some((item) => item.type === "contextCompaction")
    ))
  ) {
    return partialHarnessCompletedHistory(input, witness);
  }
  if (
    !input.first.complete ||
    !input.second.complete ||
    !pinnedCodexTurnScansHaveExactEvidence(input.first, input.second) ||
    harnessScanHasAmbiguousAssistantPhase(input.first)
  ) {
    return partialHarnessCompletedHistory(input, witness);
  }

  const turns = input.first.turns;
  const turnIds = new Set<string>();
  const itemIds = new Set<string>();
  const clientIds = new Set<string>();
  let currentIndex = -1;
  let currentMatches = 0;
  let currentUserMessages = 0;
  let currentInputRepresentable = false;
  for (const [index, { turn, items }] of turns.entries()) {
    if (turnIds.has(turn.id)) return unavailableHarnessCompletedHistory(input, witness);
    turnIds.add(turn.id);
    if (turn.id === input.currentProviderTurnId) {
      currentMatches += 1;
      currentIndex = index;
      currentUserMessages = items.filter((item) => item.type === "userMessage").length;
      currentInputRepresentable = items.some(
        (item) => item.type === "userMessage" && item.context.kind === "plainText",
      );
    }
    for (const item of items) {
      if (itemIds.has(item.id)) return unavailableHarnessCompletedHistory(input, witness);
      itemIds.add(item.id);
      if (item.type !== "userMessage") continue;
      if (item.clientId === null || clientIds.has(item.clientId)) {
        return unavailableHarnessCompletedHistory(input, witness);
      }
      clientIds.add(item.clientId);
    }
  }
  if (
    currentMatches !== 1 ||
    currentIndex !== turns.length - 1 ||
    turns[currentIndex]?.turn.status !== "inProgress" ||
    currentUserMessages !== 1
  ) {
    return unavailableHarnessCompletedHistory(input, witness);
  }
  if (!currentInputRepresentable) {
    return partialHarnessCompletedHistory(input, witness);
  }

  const currentStartedAt = turns[currentIndex]!.turn.startedAt;
  if (currentStartedAt === null) {
    return partialHarnessCompletedHistory(input, witness);
  }

  const items: SessionHarnessCompletedHistoryItem[] = [];
  let complete = true;
  let priorStartedAt: number | null = null;
  let sourceOrdinal = 0;
  let totalUtf8Bytes = 0;
  for (const { turn, items: turnItems } of turns.slice(0, currentIndex)) {
    if (
      turn.status !== "completed" ||
      turn.startedAt === null ||
      turn.completedAt === null ||
      turn.completedAt < turn.startedAt ||
      turn.completedAt > currentStartedAt ||
      (priorStartedAt !== null && turn.startedAt < priorStartedAt)
    ) complete = false;
    if (turn.startedAt !== null) priorStartedAt = turn.startedAt;
    const ownedTurnId = ownedCodexId("turn", input.accountProfileId, turn.id);
    for (const item of turnItems) {
      const materialized = item.type === "userMessage"
        ? item.context.kind === "plainText"
          ? { itemClass: "userMessage" as const, text: item.context.text }
          : null
        : item.type === "agentMessage" && item.phase === "final_answer"
          ? item.context.kind === "plainTextFinal"
            ? { itemClass: "assistantMessage" as const, text: item.context.text }
            : null
          : undefined;
      if (materialized === null) complete = false;
      if (materialized !== undefined && materialized !== null) {
        const utf8Bytes = Buffer.byteLength(materialized.text, "utf8");
        totalUtf8Bytes += utf8Bytes;
        if (
          items.length >= MAX_SESSION_HARNESS_HISTORY_ITEMS ||
          utf8Bytes > MAX_SESSION_HARNESS_HISTORY_ITEM_UTF8_BYTES ||
          totalUtf8Bytes > MAX_SESSION_HARNESS_HISTORY_UTF8_BYTES
        ) {
          complete = false;
        } else {
          items.push(Object.freeze({
            ordinal: sourceOrdinal,
            turnId: ownedTurnId,
            itemClass: materialized.itemClass,
            text: materialized.text,
          }));
        }
      }
      sourceOrdinal += 1;
    }
  }
  return Object.freeze({
    coverage: complete ? "complete" : "partial",
    throughTurnId: input.throughTurnId,
    sourceGeneration: input.sourceGeneration,
    sourceStreamPosition: input.sourceStreamPosition,
    coverageWitnessDigest: witness,
    items: complete ? Object.freeze(items) : Object.freeze([]),
  });
}

function harnessScanHasAmbiguousAssistantPhase(scan: PinnedCodexTurnScan): boolean {
  return scan.turns.some(({ items }) => items.some(
    (item) => item.type === "agentMessage" && item.phase === null,
  ));
}

function harnessHistoryCoverageWitness(
  first: PinnedCodexTurnScan,
  second: PinnedCodexTurnScan,
): string {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(JSON.stringify({
    version: 3,
    first: pinnedCodexTurnScanEvidenceDigest(first),
    second: pinnedCodexTurnScanEvidenceDigest(second),
  }));
  return hasher.digest("hex");
}

function unavailableHarnessCompletedHistory(
  input: Readonly<{
    sourceGeneration: number;
    sourceStreamPosition: CodexStreamPosition;
  }>,
  witness: string,
): SessionHarnessCompletedHistory {
  return Object.freeze({
    coverage: "unavailable",
    throughTurnId: null,
    sourceGeneration: input.sourceGeneration,
    sourceStreamPosition: input.sourceStreamPosition,
    coverageWitnessDigest: witness,
    items: Object.freeze([]),
  });
}

function partialHarnessCompletedHistory(
  input: Readonly<{
    throughTurnId: string;
    sourceGeneration: number;
    sourceStreamPosition: CodexStreamPosition;
  }>,
  witness: string,
): SessionHarnessCompletedHistory {
  return Object.freeze({
    coverage: "partial",
    throughTurnId: input.throughTurnId,
    sourceGeneration: input.sourceGeneration,
    sourceStreamPosition: input.sourceStreamPosition,
    coverageWitnessDigest: witness,
    items: Object.freeze([]),
  });
}

function throwIfHarnessHistoryAborted(signal: AbortSignal): void {
  if (signal.aborted) signal.throwIfAborted();
}

function confirmedOperationFacts(
  input: Readonly<{
    accountProfileId: string;
    generation: number;
    operation: Extract<CodexFact, { type: "operation.changed" }>["operation"];
    streamPosition: CodexStreamPosition;
    threadId: string | null;
  }>,
  factIndexOffset = 0,
): readonly CodexFact[] {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update([
    "oprte-session-operation-v1",
    input.accountProfileId,
    String(input.generation),
    String(input.streamPosition),
    input.operation,
  ].join("\u0000"));
  return createCodexFactsAtPosition({
    accountProfileId: input.accountProfileId,
    generation: input.generation,
    origin: "reconciled",
    streamPosition: input.streamPosition,
  }, [{
    type: "operation.changed",
    operation: input.operation,
    operationId: `operation_${hasher.digest("hex").slice(0, 48)}`,
    outcome: "confirmed",
    threadId: input.threadId,
  }], factIndexOffset);
}

function validateClientUserMessageId(clientUserMessageId: string): void {
  if (
    clientUserMessageId.length > 96 ||
    !/^message_[A-Za-z0-9_-]{8,88}$/u.test(clientUserMessageId)
  ) {
    throw new SessionServiceError(
      "invalid_request",
      "The dispatch message identifier is invalid.",
      false,
      "none",
    );
  }
}

function validateLaunchText(clientUserMessageId: string, prompt: string): void {
  validateClientUserMessageId(clientUserMessageId);
  if (prompt.trim().length === 0 || prompt.length > 1_000_000) {
    throw new SessionServiceError(
      "invalid_request",
      "The dispatch prompt must contain between 1 and 1,000,000 characters.",
      false,
      "none",
    );
  }
}

function validateChatProviderInput(
  clientUserMessageId: string,
  input: readonly SessionChatProviderInput[],
): readonly SessionChatProviderInput[] {
  validateClientUserMessageId(clientUserMessageId);
  if (input.length === 0 || input.length > 64) {
    throw new SessionServiceError(
      "invalid_request",
      "The chat provider input is empty or too large.",
      false,
      "none",
    );
  }
  let textBytes = 0;
  for (const item of input) {
    if (item.type === "text") {
      if (item.text.length === 0 || item.text.includes("\0")) {
        throw new SessionServiceError(
          "invalid_request",
          "The chat text input is invalid.",
          false,
          "none",
        );
      }
      textBytes += new TextEncoder().encode(item.text).byteLength;
    } else if (!isAbsolute(item.path) || item.path.includes("\0")) {
      throw new SessionServiceError(
        "invalid_request",
        "The chat image input path is invalid.",
        false,
        "none",
      );
    }
  }
  if (textBytes > 1_000_000) {
    throw new SessionServiceError(
      "invalid_request",
      "The chat text input is too large.",
      false,
      "none",
    );
  }
  return input;
}

function supportsRequiredInput(
  observed: readonly ("text" | "image")[] | null,
  required: "text" | "image",
): boolean {
  if (required === "image") {
    return observed !== null && observed.includes("text") && observed.includes("image");
  }
  return observed === null || observed.includes("text");
}

function chatCatalogEvidenceKey(
  accountProfileId: string,
  generation: number,
  digest: string,
): string {
  return `${accountProfileId.length}:${accountProfileId}:${String(generation)}:${digest}`;
}

function canonicalChatThreadArchiveScanPage(page: ChatThreadArchiveScanPage) {
  return Object.freeze({
    generation: page.generation,
    pageOrdinal: page.pageOrdinal,
    requestCursor: page.requestCursor,
    responseBackwardsCursor: page.responseBackwardsCursor,
    responseNextCursor: page.responseNextCursor,
    threadIds: page.threadIds,
  });
}

function chatThreadArchiveContainmentReceipt(input: Readonly<{
  readonly generation: number;
  readonly streamPosition: number;
  readonly threadId: string;
}>): string {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update("hra.chat.thread-archive-containment.v1\0");
  hasher.update(JSON.stringify(input));
  return `chatarchive_${hasher.digest("hex")}`;
}

function validateLaunchTitle(title: string): void {
  if (title.trim().length === 0 || title.length > 240) {
    throw new SessionServiceError(
      "invalid_request",
      "The dispatch title must contain between 1 and 240 characters.",
      false,
      "none",
    );
  }
}

function sameOrderedStrings(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return left.length === right.length &&
    left.every((value, index) => value === right[index]);
}

function ambiguousExecutionWorkspaceLeaseKey(input: Readonly<{
  accountProfileId: string;
  clientUserMessageId: string;
  providerThreadId: string;
}>): string {
  return JSON.stringify([
    input.accountProfileId,
    input.providerThreadId,
    input.clientUserMessageId,
  ]);
}

function validateScheduleInterpretationRequest(
  request: SessionChatScheduleInterpretationRequest,
): void {
  if (
    request.instruction.trim().length === 0
    || request.instruction.includes("\0")
    || Buffer.byteLength(request.instruction, "utf8") > 128 * 1_024
  ) {
    throw new SessionServiceError(
      "invalid_request",
      "The schedule instruction is empty or too large.",
      false,
      "none",
    );
  }
  const parsedNow = Date.parse(request.now);
  if (
    !Number.isFinite(parsedNow)
    || new Date(parsedNow).toISOString() !== request.now
  ) {
    throw new SessionServiceError(
      "invalid_request",
      "The schedule interpretation instant is invalid.",
      false,
      "none",
    );
  }
  try {
    if (
      request.timeZone.length === 0
      || request.timeZone.length > 128
      || new Intl.DateTimeFormat("en-US", { timeZone: request.timeZone })
        .resolvedOptions().timeZone !== request.timeZone
    ) throw new Error("non-canonical time zone");
  } catch {
    throw new SessionServiceError(
      "invalid_request",
      "The schedule time zone is invalid.",
      false,
      "none",
    );
  }
}

function scheduleInterpreterMessageId(
  request: SessionChatScheduleInterpretationRequest,
): string {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update("hra.chat.schedule-interpreter-message.v1\0");
  hasher.update(JSON.stringify([
    request.accountProfileId,
    request.workspacePath,
    request.instruction,
    request.timeZone,
    request.now,
  ]));
  return `message_${hasher.digest("hex").slice(0, 48)}`;
}

function validateHarnessActorId(actorId: string): void {
  if (!/^hactor_[A-Za-z0-9_-]{8,88}$/u.test(actorId)) {
    throw new SessionServiceError(
      "invalid_request",
      "The harness actor identity is invalid.",
      false,
      "none",
    );
  }
}

function validateHarnessThreadSource(threadSource: string): void {
  if (
    threadSource.length === 0 ||
    threadSource.length > 512 ||
    threadSource.includes("\0")
  ) {
    throw new SessionServiceError(
      "invalid_request",
      "The harness actor thread source is invalid.",
      false,
      "none",
    );
  }
}

function validateHarnessProviderThreadId(providerThreadId: string): void {
  if (
    providerThreadId.length === 0 || providerThreadId.length > 512 ||
    providerThreadId.includes("\0")
  ) {
    throw new SessionServiceError(
      "invalid_request",
      "The harness actor provider thread identity is invalid.",
      false,
      "none",
    );
  }
}

function validateHarnessRecoveryDigest(digest: string | null): void {
  if (digest !== null && !/^[0-9a-f]{64}$/u.test(digest)) {
    throw new SessionServiceError(
      "invalid_request",
      "The harness actor recovery proof digest is invalid.",
      false,
      "none",
    );
  }
}

function validateHarnessDeveloperInstructions(developerInstructions: string): void {
  if (
    developerInstructions.trim().length === 0 ||
    developerInstructions.length > 1_000_000 ||
    developerInstructions.includes("\0")
  ) {
    throw new SessionServiceError(
      "invalid_request",
      "The harness actor developer instructions are invalid.",
      false,
      "none",
    );
  }
}

function codexServiceTier(serviceTier: ChatServiceTier): "fast" | null {
  return serviceTier === "fast" ? "fast" : null;
}

/** Thread-fixed guard: HRA accounts for every recursive child itself. */
function harnessActorThreadConfig(
  reasoningEffort: "ultra" | "max",
): Readonly<Record<string, boolean | string>> {
  return Object.freeze({
    "agents.enabled": false,
    "features.multi_agent_v2.enabled": false,
    model_reasoning_effort: reasoningEffort,
  });
}

function assertNever(value: never): never {
  throw new Error(`Unhandled gateway session command: ${JSON.stringify(value)}`);
}
