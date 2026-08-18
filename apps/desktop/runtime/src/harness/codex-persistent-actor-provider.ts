import { createHash } from "node:crypto";
import { z } from "@hra-internal/schema";

import type { AccountService } from "../accounts/account-service";
import type { AccountRuntimeRouter } from "../accounts/runtime-router";
import type {
  PinnedCodexMutationFence,
  PinnedCodexThreadStartScan,
  PinnedCodexTurnScan,
} from "../codex";
import {
  pinnedCodexTurnScanEvidenceDigest,
  pinnedCodexTurnScansHaveExactEvidence,
  reconcilePinnedCodexThreadStart,
  reconcilePinnedCodexTurnInterrupt,
  reconcilePinnedCodexTurnStart,
  scanPinnedCodexThreadStarts,
  scanPinnedCodexTurns,
} from "../codex";
import { classifyHraRlmDynamicToolSpecDigest } from
  "../codex/dynamic-tool";
import type { SessionCommandExecutor } from "../sessions/command-executor";
import type {
  SessionHarnessModelCatalog,
  SessionService,
} from "../sessions/session-service";
import {
  actorAttemptIdSchema,
  actorEpochIdSchema,
  actorIdSchema as durableActorIdSchema,
  persistedActorWorkClassSchema,
  type ActorWorkClass,
  type PersistedActorWorkClass,
} from "./actor-domain";
import {
  HRA_METAHARNESS_PROFILES,
  compileMetaharnessRoute,
  orderedProfilesForWorkClass,
  type MetaharnessCatalogCapability,
} from "./metaharness-policy-v1";
import { persistentActorInstructions } from "./actor-instruction-policy-v1";
import { actorSessionRecoveryProofV2Schema } from "./sqlite-authority-v2";
import type {
  PersistentActorAccountCandidate,
  PersistentActorAccountPort,
  PersistentActorEffectProof,
  PersistentActorInterruptOutcome,
  PersistentActorInterruptRequest,
  PersistentActorProviderPort,
  PersistentActorTerminalObservation,
  PersistentActorThreadOutcome,
  PersistentActorThreadRequest,
  PersistentActorTurnObservationRequest,
  PersistentActorTurnOutcome,
  PersistentActorTurnRequest,
} from "./persistent-actors";

const digestSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const valueIdSchema = z.string().min(16).max(96)
  .regex(/^ctxval_[A-Za-z0-9_-]+$/u);
const absolutePathSchema = z.string().min(1).max(4_096).startsWith("/");
const workspaceSchema = z.object({
  checkoutPath: absolutePathSchema,
  authority: z.enum(["readOnlySnapshot", "managedWrite"]),
}).strict();
const promptSchema = z.string().min(1).max(256 * 1_024)
  .refine((value) => !value.includes("\0"), "actor prompt contains NUL");
const actorIdSchema = z.string().min(16).max(96).regex(/^hactor_[A-Za-z0-9_-]+$/u);
const actorTurnIdSchema = z.string().min(14).max(96).regex(/^hturn_[A-Za-z0-9_-]+$/u);
const requestIdentitySchema = z.string().min(16).max(128)
  .refine((value) => !value.includes("\0"), "request identity contains NUL");
const continuationIntentIdSchema = z.string().length(78)
  .regex(/^hcontinuation_[a-f0-9]{64}$/u);
const continuationAmbiguityCodeSchema = z.enum([
  "history_identity_mismatch",
  "injection_readback_mismatch",
  "continue_definitively_absent_after_dispatch",
]);
const continuationIntentStateSchema = z.enum([
  "prepared",
  "injectionEffectStarted",
  "injected",
  "continueDispatchPrepared",
  "continueDispatchEffectStarted",
  "ambiguous",
  "supersededApplied",
  "supersededNotApplied",
]);
const continuationIntentMetadataSchema = z.object({
  actorId: actorIdSchema,
  actorTurnId: actorTurnIdSchema,
  clientUserMessageId: requestIdentitySchema,
  historyDigest: digestSchema,
  historyItemCount: z.number().int().positive().max(1_024),
  historyUtf8Bytes: z.number().int().positive().max(16 * 1024 * 1024),
  sourceAccountProfileId: z.string().min(1).max(96),
  sourceProcessGeneration: z.number().int().positive().safe(),
  sourceProviderThreadId: z.string().min(1).max(512),
  sourceProviderTurnId: z.string().min(1).max(512),
  targetAccountProfileId: z.string().min(1).max(96),
  targetProcessGeneration: z.number().int().positive().safe(),
  targetProviderThreadId: z.string().min(1).max(512),
}).strict();
const continuationIntentSchema: z.ZodType<PersistentActorContinuationIntent> =
  continuationIntentMetadataSchema.extend({
    intentId: continuationIntentIdSchema,
    state: continuationIntentStateSchema,
    revision: z.number().int().positive().safe(),
    predecessorIntentId: continuationIntentIdSchema.nullable(),
    recoveryProofDigest: digestSchema.nullable(),
    exactReadbackDigest: digestSchema.nullable(),
    absenceProofDigest: digestSchema.nullable(),
    ambiguityCode: continuationAmbiguityCodeSchema.nullable(),
  }).strict().superRefine((intent, context) => {
    const injected = intent.state === "injected" ||
      intent.state === "continueDispatchPrepared" ||
      intent.state === "continueDispatchEffectStarted";
    const superseded = intent.state === "supersededApplied" ||
      intent.state === "supersededNotApplied";
    if (
      (injected && intent.exactReadbackDigest !== intent.historyDigest) ||
      (!injected && !superseded && intent.state !== "ambiguous" &&
        intent.exactReadbackDigest !== null) ||
      (superseded && intent.exactReadbackDigest !== null &&
        intent.exactReadbackDigest !== intent.historyDigest) ||
      (intent.state === "ambiguous" && intent.exactReadbackDigest !== null &&
        intent.exactReadbackDigest !== intent.historyDigest)
    ) {
      context.addIssue({
        code: "custom",
        message: "injected continuation state requires its exact history digest",
        path: ["exactReadbackDigest"],
      });
    }
    if (
      (intent.state === "continueDispatchEffectStarted" &&
        intent.absenceProofDigest === null) ||
      (intent.state !== "continueDispatchEffectStarted" &&
        intent.state !== "ambiguous" && !superseded &&
        intent.absenceProofDigest !== null)
    ) {
      context.addIssue({
        code: "custom",
        message: "continue dispatch state requires one absence proof",
        path: ["absenceProofDigest"],
      });
    }
    if ((intent.state === "ambiguous") !== (intent.ambiguityCode !== null)) {
      context.addIssue({
        code: "custom",
        message: "only an ambiguous continuation carries an ambiguity code",
        path: ["ambiguityCode"],
      });
    }
    const recovered = intent.state === "supersededApplied" ||
      intent.state === "supersededNotApplied" ||
      intent.predecessorIntentId !== null;
    if (recovered !== (intent.recoveryProofDigest !== null)) {
      context.addIssue({
        code: "custom",
        message: "recovered continuation lineage requires one recovery proof",
        path: ["recoveryProofDigest"],
      });
    }
  });
const nullableContinuationIntentSchema = continuationIntentSchema.nullable();
const continuationRecoveryResultSchema = z.object({
  predecessor: continuationIntentSchema,
  successor: nullableContinuationIntentSchema,
}).strict();
const continuationHistoryItemSchema = z.object({
  role: z.enum(["user", "assistant"]),
  text: z.string().min(1).refine(
    (value) => Buffer.byteLength(value, "utf8") <= 1024 * 1024,
    "continuation history item exceeds its UTF-8 bound",
  ),
}).strict();
const continuationHistorySchema = z.object({
  historyDigest: digestSchema,
  itemCount: z.number().int().positive().max(1_024),
  items: z.array(continuationHistoryItemSchema).min(1).max(1_024),
  totalUtf8Bytes: z.number().int().positive().max(16 * 1024 * 1024),
}).strict().superRefine((history, context) => {
  const total = history.items.reduce(
    (sum, item) => sum + Buffer.byteLength(item.text, "utf8"),
    0,
  );
  if (history.itemCount !== history.items.length) {
    context.addIssue({ code: "custom", message: "history item count changed", path: ["itemCount"] });
  }
  if (history.totalUtf8Bytes !== total) {
    context.addIssue({ code: "custom", message: "history byte count changed", path: ["totalUtf8Bytes"] });
  }
  if (history.historyDigest !== continuationHistoryDigest(history.items)) {
    context.addIssue({ code: "custom", message: "history digest changed", path: ["historyDigest"] });
  }
});
const continuationHistoryCapsuleHandleSchema = z.object({
  version: z.literal(2),
  epochId: actorEpochIdSchema,
  actorId: actorIdSchema,
  actorTurnId: actorTurnIdSchema,
  sourceAttemptId: actorAttemptIdSchema,
  valueId: valueIdSchema,
}).strict();
const continuationHistoryCapsuleSchema = z.object({
  handle: continuationHistoryCapsuleHandleSchema,
  historyDigest: digestSchema,
  itemCount: z.number().int().positive().max(1_024),
  historyUtf8Bytes: z.number().int().positive().max(16 * 1024 * 1024),
  containerUtf8Bytes: z.number().int().positive().max(18 * 1024 * 1024),
  items: z.array(continuationHistoryItemSchema).min(1).max(1_024),
}).strict().superRefine((capsule, context) => {
  const total = capsule.items.reduce(
    (sum, item) => sum + Buffer.byteLength(item.text, "utf8"),
    0,
  );
  if (capsule.itemCount !== capsule.items.length) {
    context.addIssue({
      code: "custom",
      message: "capsule history item count changed",
      path: ["itemCount"],
    });
  }
  if (capsule.historyUtf8Bytes !== total) {
    context.addIssue({
      code: "custom",
      message: "capsule history byte count changed",
      path: ["historyUtf8Bytes"],
    });
  }
  if (capsule.historyDigest !== continuationHistoryDigest(capsule.items)) {
    context.addIssue({
      code: "custom",
      message: "capsule history digest changed",
      path: ["historyDigest"],
    });
  }
});
const continuationReadbackSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("matched"),
    historyDigest: digestSchema,
    rawEvidenceDigest: digestSchema,
    streamPosition: z.number().int().positive().safe(),
  }).strict(),
  z.object({
    kind: z.literal("empty"),
    rawEvidenceDigest: digestSchema,
    streamPosition: z.number().int().positive().safe(),
  }).strict(),
  z.object({
    kind: z.literal("mismatched"),
    rawEvidenceDigest: digestSchema,
    streamPosition: z.number().int().positive().safe(),
  }).strict(),
  z.object({
    kind: z.literal("unavailable"),
    streamPosition: z.number().int().positive().safe(),
  }).strict(),
]);

const MAX_RESULT_UTF8_BYTES = 1024 * 1024;

export interface PersistentActorWorkspaceLookupPort {
  resolveLane(laneId: string): Promise<unknown>;
  resolveActor(actorId: string): Promise<unknown>;
}

export interface PersistentActorCodexValuePort {
  readInput(input: Readonly<{
    epochId: string;
    actorId: string;
    turnId: string;
    valueId: string;
  }>): Promise<unknown>;
  putResult(input: Readonly<{
    operationId: string;
    epochId: string;
    actorId: string;
    turnId: string;
    plaintext: string;
  }>): Promise<unknown>;
  putActorContinuationHistoryCapsule(input: Readonly<{
    epochId: string;
    actorId: string;
    actorTurnId: string;
    sourceAttemptId: string;
    historyDigest: string;
    items: readonly Readonly<{
      role: "user" | "assistant";
      text: string;
    }>[];
  }>): Promise<unknown>;
  readActorContinuationHistoryCapsule(input: Readonly<{
    handle: Readonly<{
      version: 2;
      epochId: string;
      actorId: string;
      actorTurnId: string;
      sourceAttemptId: string;
      valueId: string;
    }>;
  }>): Promise<unknown>;
}

export interface PersistentActorMutationFencePort {
  read(input: Readonly<{
    accountProfileId: string;
    processGeneration: number;
    effectKey: string;
  }>): Promise<unknown>;
}

export interface CodexPersistentActorProviderOptions {
  readonly commands: Pick<SessionCommandExecutor,
    | "threadList"
    | "threadTurnsList"
    | "threadItemsList"
    | "turnInterrupt">;
  readonly sessions: Pick<SessionService,
    | "startHarnessActorThread"
    | "observeHarnessActorSessionRecoveryProof"
    | "resumeHarnessActorThread"
    | "readHarnessModelCatalog"
    | "startHarnessActorTurn"
    | "readHarnessActorChatAttachment"
    | "readHarnessActorContinuationHistory"
    | "injectHarnessActorContinuationHistory"
    | "verifyHarnessActorContinuationHistory">;
  readonly sessionRuntimes?: Readonly<{
    ensureSessionRuntime(
      accountProfileId: string,
    ): Promise<Readonly<{ generation: number }>>;
  }>;
  readonly workspaces: PersistentActorWorkspaceLookupPort;
  readonly values: PersistentActorCodexValuePort;
  readonly mutationFences?: PersistentActorMutationFencePort;
  readonly continuationIntents?: PersistentActorContinuationIntentPort;
  readonly tokenUsage?: PersistentActorTokenUsagePort;
  readonly toolsetDigest: string;
  readonly now?: () => Date;
}

export type PersistentActorFastCapacityHeldReason =
  | "runtimeUnavailable"
  | "successorGenerationUnavailable"
  | "mutationFenceUnavailable"
  | "scanUnavailable"
  | "incompleteScan"
  | "unstableScan"
  | "duplicateTurn"
  | "duplicateItem"
  | "duplicateClientMessageId"
  | "matchingTurnInProgress"
  | "otherTurnInProgress"
  | "mutationFenceIncomplete";

/**
 * Read-only disposition for Fast capacity held by an ambiguous turn effect.
 * It never authorizes replay. Only `releasable` proves stable absence behind a
 * strict successor-generation mutation fence.
 */
export type PersistentActorFastCapacityReconciliationOutcome =
  | Readonly<{
      kind: "releasable";
      successorGeneration: number;
      proof: PersistentActorEffectProof;
    }>
  | Readonly<{
      kind: "consumable";
      successorGeneration: number;
      providerTurnId: string;
      terminal: "completed" | "interrupted" | "failed";
      proof: PersistentActorEffectProof;
    }>
  | Readonly<{
      kind: "held";
      reason: PersistentActorFastCapacityHeldReason;
      successorGeneration: number | null;
      proof: PersistentActorEffectProof;
    }>;

/** Durable per-turn usage, populated from the exact Codex notification. */
export interface PersistentActorTokenUsagePort {
  readTurnUsage(input: Readonly<{
    accountProfileId: string;
    observationGeneration: number;
    providerThreadId: string;
    providerTurnId: string;
  }>): Promise<Readonly<{ inputTokens: number; outputTokens: number }> | null>;
}

export type PersistentActorContinuationIntentState =
  | "prepared"
  | "injectionEffectStarted"
  | "injected"
  | "continueDispatchPrepared"
  | "continueDispatchEffectStarted"
  | "ambiguous"
  | "supersededApplied"
  | "supersededNotApplied";

/** Content-free identity and bounds for one cross-account history mutation. */
export interface PersistentActorContinuationIntentMetadata {
  readonly actorId: string;
  readonly actorTurnId: string;
  readonly clientUserMessageId: string;
  readonly historyDigest: string;
  readonly historyItemCount: number;
  readonly historyUtf8Bytes: number;
  readonly sourceAccountProfileId: string;
  readonly sourceProcessGeneration: number;
  readonly sourceProviderThreadId: string;
  readonly sourceProviderTurnId: string;
  readonly targetAccountProfileId: string;
  readonly targetProcessGeneration: number;
  readonly targetProviderThreadId: string;
}

export interface PersistentActorContinuationIntent
  extends PersistentActorContinuationIntentMetadata {
  readonly intentId: string;
  readonly state: PersistentActorContinuationIntentState;
  readonly revision: number;
  readonly predecessorIntentId: string | null;
  readonly recoveryProofDigest: string | null;
  readonly exactReadbackDigest: string | null;
  readonly absenceProofDigest: string | null;
  readonly ambiguityCode: PersistentActorContinuationAmbiguityCode | null;
}

export type PersistentActorContinuationAmbiguityCode =
  | "history_identity_mismatch"
  | "injection_readback_mismatch"
  | "continue_definitively_absent_after_dispatch";

/**
 * Durable authority supplied by the coordinator. Every method is an exact CAS
 * and stores metadata only; transcript plaintext never crosses this port.
 */
export interface PersistentActorContinuationIntentPort {
  prepareInjection(input: PersistentActorContinuationIntentMetadata): Promise<unknown>;
  readInjection(input: Readonly<{
    metadata: PersistentActorContinuationIntentMetadata;
  }>): Promise<unknown>;
  readLatestInjection(input: Readonly<{
    metadata: PersistentActorContinuationIntentMetadata;
  }>): Promise<unknown>;
  markInjectionEffectStarted(input: Readonly<{
    metadata: PersistentActorContinuationIntentMetadata;
    expectedRevision: number;
  }>): Promise<unknown>;
  settleInjectionApplied(input: Readonly<{
    metadata: PersistentActorContinuationIntentMetadata;
    expectedRevision: number;
    exactReadbackDigest: string;
  }>): Promise<unknown>;
  prepareContinueDispatch(input: Readonly<{
    metadata: PersistentActorContinuationIntentMetadata;
    expectedRevision: number;
  }>): Promise<unknown>;
  markContinueDispatchEffectStarted(input: Readonly<{
    metadata: PersistentActorContinuationIntentMetadata;
    expectedRevision: number;
    absenceProofDigest: string;
  }>): Promise<unknown>;
  fenceInjectionAmbiguous(input: Readonly<{
    metadata: PersistentActorContinuationIntentMetadata;
    expectedRevision: number;
    proofCode: PersistentActorContinuationAmbiguityCode;
  }>): Promise<unknown>;
  supersedeForRecovery(input: Readonly<{
    predecessorMetadata: PersistentActorContinuationIntentMetadata;
    expectedRevision: number;
    recoveryProofDigest: string;
    predecessorState: "supersededApplied" | "supersededNotApplied";
    successorMetadata: PersistentActorContinuationIntentMetadata | null;
    successorHistoryApplied: boolean;
  }>): Promise<unknown>;
}

type PersistentActorContinuationHistory = z.infer<typeof continuationHistorySchema>;
type PersistentActorContinuationHistoryCapsuleHandle = z.infer<
  typeof continuationHistoryCapsuleHandleSchema
>;

type ContinuationPreparation =
  | Readonly<{ kind: "pending" }>
  | Readonly<{ kind: "ambiguous" }>
  | Readonly<{ kind: "alreadyApplied"; providerTurnId: string }>
  | Readonly<{
      kind: "ready";
      intent: PersistentActorContinuationIntent;
      initialAbsenceProofDigest: string | null;
    }>;

type ContinuationGenerationRecovery =
  | Readonly<{ kind: "pending" }>
  | Readonly<{ kind: "ambiguous" }>
  | Readonly<{ kind: "alreadyApplied"; providerTurnId: string }>
  | Readonly<{
      kind: "ready";
      intent: PersistentActorContinuationIntent;
    }>;

type InitialActorSessionEvidence =
  | Readonly<{ kind: "pending" }>
  | Readonly<{ kind: "invalid" }>
  | Readonly<{
      kind: "ready";
      observedProfile: Readonly<{
        modelId: "gpt-5.6-sol" | "gpt-5.6-luna";
        reasoningEffort: "ultra" | "max";
      }>;
      liveCapabilityEvidence: Readonly<{
        observationGeneration: number;
        evidenceDigest: string | null;
        supportsFast: boolean | null;
      }>;
      sessionRecoveryProof: z.infer<typeof actorSessionRecoveryProofV2Schema>;
    }>;

/**
 * Exact Codex 0.144.6 adapter for persistent actors. It exposes only
 * thread/start, idle-boundary turn/start, reads, and turn/interrupt. There is
 * no fork or steer method to call accidentally.
 */
export class CodexPersistentActorProvider implements PersistentActorProviderPort {
  readonly #commands: CodexPersistentActorProviderOptions["commands"];
  readonly #sessions: CodexPersistentActorProviderOptions["sessions"];
  readonly #sessionRuntimes: CodexPersistentActorProviderOptions["sessionRuntimes"];
  readonly #workspaces: PersistentActorWorkspaceLookupPort;
  readonly #values: PersistentActorCodexValuePort;
  readonly #mutationFences: PersistentActorMutationFencePort | null;
  readonly #continuationIntents: PersistentActorContinuationIntentPort | null;
  readonly #tokenUsage: PersistentActorTokenUsagePort | null;
  readonly #toolsetDigest: string;
  readonly #now: () => Date;

  constructor(options: CodexPersistentActorProviderOptions) {
    this.#commands = options.commands;
    this.#sessions = options.sessions;
    this.#sessionRuntimes = options.sessionRuntimes;
    this.#workspaces = options.workspaces;
    this.#values = options.values;
    this.#mutationFences = options.mutationFences ?? null;
    this.#continuationIntents = options.continuationIntents ?? null;
    this.#tokenUsage = options.tokenUsage ?? null;
    this.#toolsetDigest = digestSchema.parse(options.toolsetDigest);
    this.#now = options.now ?? (() => new Date());
  }

  async startThread(
    request: PersistentActorThreadRequest,
  ): Promise<PersistentActorThreadOutcome> {
    this.#assertToolset(request.toolsetDigest, "fresh");
    assertFreshMetaharnessThreadRequest(request);
    const workspace = await this.#workspace(request.workspaceLaneId);
    let positioned;
    try {
      positioned = await this.#sessions.startHarnessActorThread({
        accountProfileId: request.accountProfileId,
        actorId: request.actorId,
        developerInstructions: persistentActorInstructions(
          request.workClass,
          request.selectedProfile,
        ),
        expectedGeneration: request.processGeneration,
        model: request.modelId,
        reasoningEffort: request.reasoningEffort,
        threadSource: request.threadSource,
        title: persistentActorTitle(request.actorId),
        workspaceMode: workspace.authority === "readOnlySnapshot"
          ? "readOnly"
          : "managed",
        workspacePath: workspace.checkoutPath,
      });
    } catch {
      // Dispatch may have been accepted after the gateway stopped responding.
      // Keep the durable effect-start receipt reconcilable; only a stable scan
      // is allowed to fence it as ambiguous.
      return this.#pending("thread-start-gateway-error", request.effectKey);
    }
    if (positioned.generation !== request.processGeneration) {
      return this.#ambiguous("thread-start-mismatch", request.effectKey);
    }
    const sessionEvidence = await this.#establishInitialSessionRecoveryProof({
      request,
      providerThreadId: positioned.providerThreadId,
      workspace,
      observationGeneration: positioned.generation,
    });
    if (sessionEvidence.kind === "pending") {
      return this.#pending("thread-start-session-proof-pending", request.effectKey);
    }
    if (sessionEvidence.kind === "invalid") {
      return this.#ambiguous(
        "thread-start-session-capability-mismatch",
        request.effectKey,
      );
    }
    return {
      kind: "applied",
      providerThreadId: positioned.providerThreadId,
      observedProfile: positioned.observedProfile,
      liveCapabilityEvidence: sessionEvidence.liveCapabilityEvidence,
      sessionRecoveryProof: sessionEvidence.sessionRecoveryProof,
      proof: this.#proof("thread-start", request.effectKey, "postDispatch", true, [
        String(positioned.generation),
        String(positioned.streamPosition),
        positioned.providerThreadId,
      ]),
    };
  }

  async reconcileThread(
    request: PersistentActorThreadRequest,
  ): Promise<PersistentActorThreadOutcome> {
    this.#assertToolset(request.toolsetDigest, "recovery");
    const workspace = await this.#workspace(request.workspaceLaneId);
    let observationGeneration = request.processGeneration;
    if (this.#sessionRuntimes !== undefined) {
      try {
        const runtime = await this.#sessionRuntimes.ensureSessionRuntime(
          request.accountProfileId,
        );
        observationGeneration = z.number().int().positive().safe().parse(
          runtime.generation,
        );
      } catch {
        return this.#pending("thread-runtime-unavailable", request.effectKey);
      }
    }
    if (observationGeneration < request.processGeneration) {
      return this.#ambiguous("thread-runtime-generation-regressed", request.effectKey);
    }
    let scans: readonly [PinnedCodexThreadStartScan, PinnedCodexThreadStartScan];
    try {
      scans = [
        await this.#scanThreads(request.accountProfileId, observationGeneration),
        await this.#scanThreads(request.accountProfileId, observationGeneration),
      ];
    } catch {
      return this.#pending("thread-scan-unavailable", request.effectKey);
    }
    const outcome = reconcilePinnedCodexThreadStart({
      threadSource: request.threadSource,
      cwd: workspace.checkoutPath,
      ephemeral: false,
      historyMode: "paginated",
    }, scans[0], scans[1], await this.#fence(request));
    const proof = this.#proof(
      `thread-reconcile-${outcome.kind}`,
      request.effectKey,
      "observation",
      outcome.kind !== "pending",
      [threadScanDigest(scans[0]), threadScanDigest(scans[1])],
    );
    switch (outcome.kind) {
      case "applied": {
        const sessionEvidence = await this.#establishInitialSessionRecoveryProof({
          request,
          providerThreadId: outcome.threadId,
          workspace,
          observationGeneration,
        });
        return sessionEvidence.kind === "pending"
          ? this.#pending("thread-reconcile-session-proof-pending", request.effectKey)
          : sessionEvidence.kind === "invalid"
          ? this.#ambiguous(
              "thread-reconcile-session-capability-mismatch",
              request.effectKey,
            )
          : {
              kind: "applied",
              providerThreadId: outcome.threadId,
              observedProfile: sessionEvidence.observedProfile,
              liveCapabilityEvidence: sessionEvidence.liveCapabilityEvidence,
              sessionRecoveryProof: sessionEvidence.sessionRecoveryProof,
              proof,
            };
      }
      case "not_applied":
        return { kind: "notApplied", reason: "notFound", proof };
      case "pending":
        return { kind: "pending", proof };
      case "ambiguous":
        return { kind: "ambiguous", proof };
    }
  }

  async startTurn(
    request: PersistentActorTurnRequest,
  ): Promise<PersistentActorTurnOutcome> {
    this.#assertToolset(request.toolsetDigest, "fresh");
    assertMetaharnessTurnRequest(request);
    await this.#workspaceForTurn(request);
    if (request.continuation !== null) {
      return await this.#startContinuationTurn(request);
    }
    if (request.processGeneration !== request.observationGeneration) {
      return this.#ambiguous(
        "turn-start-requires-admission-generation",
        request.effectKey,
      );
    }
    const prompt = promptSchema.parse(await this.#values.readInput({
      epochId: request.epochId,
      actorId: request.actorId,
      turnId: request.turnId,
      valueId: request.inputValueId,
    }));
    let positioned;
    try {
      positioned = await this.#sessions.startHarnessActorTurn({
        actorId: request.actorId,
        clientUserMessageId: request.clientUserMessageId,
        expectedGeneration: request.observationGeneration,
        model: request.modelId,
        prompt,
        reasoningEffort: request.reasoningEffort,
        serviceTier: request.serviceTier,
        thread: {
          accountProfileId: request.accountProfileId,
          kind: "provider",
          providerThreadId: request.providerThreadId,
        },
      });
    } catch {
      // As above, a lost response is not evidence of ambiguity. Reconciliation
      // obtains two exact scans before it classifies the durable receipt.
      return this.#pending("turn-start-gateway-error", request.effectKey);
    }
    if (positioned.generation !== request.observationGeneration) {
      return this.#ambiguous("turn-generation-mismatch", request.effectKey);
    }
    return {
      kind: "applied",
      providerTurnId: positioned.providerTurnId,
      proof: this.#proof("turn-start", request.effectKey, "postDispatch", true, [
        String(request.observationGeneration),
        positioned.providerTurnId,
        String(positioned.streamPosition),
      ]),
    };
  }

  async reconcileTurn(
    request: PersistentActorTurnRequest,
  ): Promise<PersistentActorTurnOutcome> {
    this.#assertToolset(request.toolsetDigest, "recovery");
    assertMetaharnessTurnRequest(request);
    if (request.continuation !== null) {
      return await this.#reconcileContinuationTurn(request);
    }
    const scans = await this.#stableTurnScans(request);
    if (scans === null) return this.#pending("turn-scan-unavailable", request.effectKey);
    const outcome = reconcilePinnedCodexTurnStart(
      request.clientUserMessageId,
      scans[0],
      scans[1],
      await this.#fence(request),
    );
    const proof = this.#turnProof(`turn-reconcile-${outcome.kind}`, request, scans,
      outcome.kind !== "pending");
    if (outcome.kind === "applied") {
      // A turn found by the deterministic client message was admitted. Even a
      // quota-terminal match is post-admission and must be observed before any
      // handoff; classifying it as pre-effect would resend the logical input.
      return { kind: "applied", providerTurnId: outcome.turnId!, proof };
    }
    if (outcome.kind === "not_applied") {
      return { kind: "notApplied", reason: "notFound", proof };
    }
    return outcome.kind === "pending"
      ? { kind: "pending", proof }
      : { kind: "ambiguous", proof };
  }

  /**
   * Reconcile only the capacity consequence of a quarantined Fast turn. The
   * method performs no thread or turn mutation and never makes the turn
   * replayable. A release requires a strict successor runtime generation, two
   * complete identical turn+item scans, stable absence of the exact client
   * message, and all three old-generation mutation-fence facts.
   */
  async reconcileQuarantinedFastCapacity(
    request: PersistentActorTurnRequest,
  ): Promise<PersistentActorFastCapacityReconciliationOutcome> {
    this.#assertToolset(request.toolsetDigest, "recovery");
    assertMetaharnessTurnRequest(request);
    if (
      request.requestedServiceTier !== "fast" ||
      request.serviceTier !== "fast" ||
      request.fastReservationId === null
    ) {
      throw new Error("Fast capacity reconciliation requires one Fast reservation");
    }

    let successorGeneration: number | null = null;
    if (this.#sessionRuntimes !== undefined) {
      try {
        const runtime = await this.#sessionRuntimes.ensureSessionRuntime(
          request.accountProfileId,
        );
        successorGeneration = z.number().int().positive().safe().parse(
          runtime.generation,
        );
      } catch {
        // The held outcome below binds the unavailable successor evidence.
      }
    }

    let fence: PinnedCodexMutationFence | null = null;
    try {
      fence = await this.#fence({
        accountProfileId: request.accountProfileId,
        processGeneration: request.processGeneration,
        effectKey: request.effectKey,
      });
    } catch {
      // A missing fence fact is never treated as false evidence for release.
    }

    if (successorGeneration === null) {
      return this.#heldFastCapacity(
        "runtimeUnavailable",
        request,
        null,
        null,
        fence,
      );
    }
    if (successorGeneration <= request.processGeneration) {
      return this.#heldFastCapacity(
        "successorGenerationUnavailable",
        request,
        successorGeneration,
        null,
        fence,
      );
    }

    let scans: readonly [PinnedCodexTurnScan, PinnedCodexTurnScan] | null = null;
    try {
      scans = await this.#scanTurns(
        request.accountProfileId,
        request.providerThreadId,
        successorGeneration,
      );
    } catch {
      // Transport and codec faults hold capacity without changing provider state.
    }
    if (scans === null) {
      return this.#heldFastCapacity(
        "scanUnavailable",
        request,
        successorGeneration,
        null,
        fence,
      );
    }
    if (fence === null) {
      return this.#heldFastCapacity(
        "mutationFenceUnavailable",
        request,
        successorGeneration,
        scans,
        null,
      );
    }
    if (!scans[0].complete || !scans[1].complete) {
      return this.#heldFastCapacity(
        "incompleteScan",
        request,
        successorGeneration,
        scans,
        fence,
      );
    }
    if (!pinnedCodexTurnScansHaveExactEvidence(scans[0], scans[1])) {
      return this.#heldFastCapacity(
        "unstableScan",
        request,
        successorGeneration,
        scans,
        fence,
      );
    }

    const turnIds = scans[0].turns.map(({ turn }) => turn.id);
    if (new Set(turnIds).size !== turnIds.length) {
      return this.#heldFastCapacity(
        "duplicateTurn",
        request,
        successorGeneration,
        scans,
        fence,
      );
    }
    const itemIds = scans[0].turns.flatMap(({ items }) =>
      items.map(({ id }) => id)
    );
    if (new Set(itemIds).size !== itemIds.length) {
      return this.#heldFastCapacity(
        "duplicateItem",
        request,
        successorGeneration,
        scans,
        fence,
      );
    }
    const matches = scans[0].turns.flatMap(({ turn, items }) =>
      items.flatMap((item) =>
        item.type === "userMessage" &&
          item.clientId === request.clientUserMessageId
          ? [turn]
          : []
      )
    );
    if (matches.length > 1) {
      return this.#heldFastCapacity(
        "duplicateClientMessageId",
        request,
        successorGeneration,
        scans,
        fence,
      );
    }
    const match = matches[0];
    if (match !== undefined) {
      if (match.status === "inProgress") {
        return this.#heldFastCapacity(
          "matchingTurnInProgress",
          request,
          successorGeneration,
          scans,
          fence,
          match.id,
          match.status,
        );
      }
      return {
        kind: "consumable",
        successorGeneration,
        providerTurnId: match.id,
        terminal: match.status,
        proof: this.#fastCapacityProof(
          "consumable",
          request,
          successorGeneration,
          scans,
          fence,
          true,
          match.id,
          match.status,
        ),
      };
    }
    if (scans[0].turns.some(({ turn }) => turn.status === "inProgress")) {
      return this.#heldFastCapacity(
        "otherTurnInProgress",
        request,
        successorGeneration,
        scans,
        fence,
      );
    }
    if (!isCompleteMutationFence(fence)) {
      return this.#heldFastCapacity(
        "mutationFenceIncomplete",
        request,
        successorGeneration,
        scans,
        fence,
      );
    }
    return {
      kind: "releasable",
      successorGeneration,
      proof: this.#fastCapacityProof(
        "releasable",
        request,
        successorGeneration,
        scans,
        fence,
        true,
      ),
    };
  }

  async observeTurn(
    request: PersistentActorTurnObservationRequest,
  ): Promise<PersistentActorTurnOutcome | PersistentActorTerminalObservation> {
    assertMetaharnessTurnRequest(request);
    const scans = await this.#stableTurnScans(request);
    if (scans === null) return this.#pending("turn-observe-unavailable", request.effectKey);
    const matches = scans[0].turns.filter(
      ({ turn }) => turn.id === request.providerTurnId,
    );
    if (matches.length !== 1 || hasDuplicateItemIds(matches[0]!.items)) {
      return this.#ambiguous("turn-observe-identity", request.effectKey, [
        pinnedCodexTurnScanEvidenceDigest(scans[0]),
      ]);
    }
    const observed = matches[0]!;
    if (observed.turn.status === "inProgress") {
      return this.#pending("turn-in-progress", request.effectKey);
    }
    const proof = this.#turnProof("turn-terminal", request, scans, true);
    const usage = this.#tokenUsage === null ? null : await this.#tokenUsage.readTurnUsage({
      accountProfileId: request.accountProfileId,
      observationGeneration: request.observationGeneration,
      providerThreadId: request.providerThreadId,
      providerTurnId: request.providerTurnId,
    });
    // A terminal thread scan does not contain token accounting. Waiting here
    // prevents the coordinator from treating unknown use as zero or fencing a
    // normal completion before the authoritative notification arrives.
    if (usage === null) return this.#pending("turn-terminal-usage-pending", request.effectKey);
    if (observed.turn.status === "completed") {
      const finalText = observed.items.flatMap((item) =>
        item.type === "agentMessage" && item.phase === "final_answer"
          ? [item.text]
          : []
      ).join("\n\n");
      if (
        finalText.length === 0 ||
        Buffer.byteLength(finalText, "utf8") > MAX_RESULT_UTF8_BYTES
      ) {
        return terminal(request, "failed", null, "result_unavailable", proof, usage);
      }
      const resultValueId = valueIdSchema.parse(await this.#values.putResult({
        operationId: resultOperationId(request.effectKey),
        epochId: request.epochId,
        actorId: request.actorId,
        turnId: request.turnId,
        plaintext: finalText,
      }));
      return terminal(request, "completed", resultValueId, "completed", proof, usage);
    }
    return observed.turn.status === "interrupted"
      ? terminal(request, "interrupted", null, "interrupted", proof, usage)
      : terminal(
          request,
          "failed",
          null,
          hasQuotaProof(observed.turn) ? "usage_limit_exceeded" : "failed",
          proof,
          usage,
        );
  }

  async interruptTurn(
    request: PersistentActorInterruptRequest,
  ): Promise<PersistentActorInterruptOutcome> {
    if (request.processGeneration !== request.observationGeneration) {
      return this.#ambiguous(
        "interrupt-start-requires-admission-generation",
        request.effectKey,
      );
    }
    const positioned = await this.#commands.turnInterrupt(
      request.accountProfileId,
      {
        threadId: request.providerThreadId,
        turnId: request.providerTurnId,
      },
      request.observationGeneration,
    );
    if (
      positioned.generation !== request.observationGeneration ||
      positioned.output.kind !== "accepted_pending_terminal"
    ) return this.#ambiguous("interrupt-mismatch", request.effectKey);
    return {
      kind: "applied",
      providerTurnId: request.providerTurnId,
      proof: this.#proof("interrupt-accepted", request.effectKey, "postDispatch", true, [
        String(request.observationGeneration),
        String(positioned.streamPosition),
      ]),
    };
  }

  async reconcileInterrupt(
    request: PersistentActorInterruptRequest,
  ): Promise<PersistentActorInterruptOutcome> {
    let scans: readonly [PinnedCodexTurnScan, PinnedCodexTurnScan];
    try {
      scans = await this.#scanTurns(
        request.accountProfileId,
        request.providerThreadId,
        requestObservationGeneration(request),
      );
    } catch {
      return this.#pending("interrupt-scan-unavailable", request.effectKey);
    }
    if (!pinnedCodexTurnScansHaveExactEvidence(scans[0], scans[1])) {
      return this.#pending("interrupt-scan-unstable", request.effectKey);
    }
    const outcome = reconcilePinnedCodexTurnInterrupt(
      request.providerTurnId,
      scans[0],
      scans[1],
    );
    const proof = this.#proof(
      `interrupt-reconcile-${outcome.kind}`,
      request.effectKey,
      "observation",
      outcome.kind !== "pending",
      [
        String(request.observationGeneration),
        pinnedCodexTurnScanEvidenceDigest(scans[0]),
      ],
    );
    if (outcome.kind === "pending") return { kind: "pending", proof };
    if (outcome.kind === "ambiguous") return { kind: "ambiguous", proof };
    if (outcome.kind === "cancelled") {
      return { kind: "applied", providerTurnId: request.providerTurnId, proof };
    }
    return { kind: "notApplied", reason: "rejected", proof };
  }

  async #startContinuationTurn(
    request: PersistentActorTurnRequest,
  ): Promise<PersistentActorTurnOutcome> {
    const prepared = await this.#prepareContinuation(request);
    if (prepared.kind === "pending") {
      return this.#pending("continuation-prepare-pending", request.effectKey);
    }
    if (prepared.kind === "ambiguous") {
      return this.#ambiguous("continuation-prepare-ambiguous", request.effectKey);
    }
    if (prepared.kind === "alreadyApplied") {
      return {
        kind: "applied",
        providerTurnId: prepared.providerTurnId,
        proof: this.#proof(
          "continuation-recovered-applied",
          request.effectKey,
          "observation",
          true,
          [String(request.observationGeneration), prepared.providerTurnId],
        ),
      };
    }
    if (
      prepared.initialAbsenceProofDigest === null ||
      prepared.intent.state !== "continueDispatchPrepared"
    ) {
      return this.#pending("continuation-dispatch-already-owned", request.effectKey);
    }
    const started = await this.#winContinueDispatch(
      prepared.intent,
      prepared.initialAbsenceProofDigest,
    );
    if (started === null) {
      return this.#pending("continuation-dispatch-cas-pending", request.effectKey);
    }
    return await this.#dispatchContinue(request);
  }

  async #reconcileContinuationTurn(
    request: PersistentActorTurnRequest,
  ): Promise<PersistentActorTurnOutcome> {
    const prepared = await this.#prepareContinuation(request);
    if (prepared.kind === "pending") {
      return this.#pending("continuation-reconcile-pending", request.effectKey);
    }
    if (prepared.kind === "ambiguous") {
      return this.#ambiguous("continuation-reconcile-ambiguous", request.effectKey);
    }
    if (prepared.kind === "alreadyApplied") {
      return {
        kind: "applied",
        providerTurnId: prepared.providerTurnId,
        proof: this.#proof(
          "continuation-recovered-applied",
          request.effectKey,
          "observation",
          true,
          [String(request.observationGeneration), prepared.providerTurnId],
        ),
      };
    }
    if (
      prepared.initialAbsenceProofDigest !== null &&
      prepared.intent.state === "continueDispatchPrepared"
    ) {
      const started = await this.#winContinueDispatch(
        prepared.intent,
        prepared.initialAbsenceProofDigest,
      );
      if (started === null) {
        return this.#pending("continuation-dispatch-cas-pending", request.effectKey);
      }
      return await this.#dispatchContinue(request);
    }
    const scans = await this.#stableTurnScans(request);
    if (scans === null) {
      return this.#pending("continuation-turn-scan-unavailable", request.effectKey);
    }
    const fence = await this.#fence({
      accountProfileId: prepared.intent.targetAccountProfileId,
      processGeneration: prepared.intent.targetProcessGeneration,
      effectKey: request.effectKey,
    });
    const outcome = reconcilePinnedCodexTurnStart(
      request.clientUserMessageId,
      scans[0],
      scans[1],
      fence,
    );
    const proof = this.#turnProof(
      `continuation-turn-reconcile-${outcome.kind}`,
      request,
      scans,
      outcome.kind !== "pending",
    );
    if (outcome.kind === "applied") {
      return { kind: "applied", providerTurnId: outcome.turnId!, proof };
    }
    if (outcome.kind === "pending") return { kind: "pending", proof };
    if (outcome.kind === "ambiguous") return { kind: "ambiguous", proof };

    if (prepared.intent.state === "continueDispatchEffectStarted") {
      await this.#fenceContinuationIntent(
        prepared.intent,
        "continue_definitively_absent_after_dispatch",
      );
      return this.#ambiguous(
        "continuation-definitively-absent-after-dispatch",
        request.effectKey,
        [proof.digest],
      );
    }
    if (prepared.intent.state !== "continueDispatchPrepared") {
      return this.#pending("continuation-dispatch-not-prepared", request.effectKey);
    }
    const absenceProofDigest = digest(
      "continue-absence",
      String(prepared.intent.targetProcessGeneration),
      pinnedCodexTurnScanEvidenceDigest(scans[0]),
      pinnedCodexTurnScanEvidenceDigest(scans[1]),
      String(fence.previousGenerationTerminated),
      String(fence.exclusiveMutationLease),
      String(fence.externalDeletionExcluded),
    );
    const started = await this.#winContinueDispatch(
      prepared.intent,
      absenceProofDigest,
    );
    if (started === null) {
      return this.#pending("continuation-dispatch-cas-pending", request.effectKey);
    }
    return await this.#dispatchContinue(request);
  }

  async #prepareContinuation(
    request: PersistentActorTurnRequest,
  ): Promise<ContinuationPreparation> {
    const continuation = request.continuation;
    const port = this.#continuationIntents;
    if (continuation === null || port === null) return { kind: "pending" };
    if (continuation.sourceAccountProfileId === request.accountProfileId) {
      return { kind: "ambiguous" };
    }

    const capsuleHandleValue = {
      version: 2 as const,
      epochId: request.epochId,
      actorId: request.actorId,
      actorTurnId: request.turnId,
      sourceAttemptId: continuation.sourceAttemptId,
      valueId: continuation.historyValueId,
    };
    let capsuleHandle: PersistentActorContinuationHistoryCapsuleHandle;
    try {
      capsuleHandle = continuationHistoryCapsuleHandleSchema.parse(
        capsuleHandleValue,
      );
    } catch {
      return { kind: "ambiguous" };
    }

    let capsuleValue: unknown;
    try {
      capsuleValue = await this.#values.readActorContinuationHistoryCapsule({
        handle: capsuleHandle,
      });
    } catch (cause: unknown) {
      return isContinuationCapsuleDefinitiveFailure(cause)
        ? { kind: "ambiguous" }
        : { kind: "pending" };
    }

    let capsule: z.infer<typeof continuationHistoryCapsuleSchema>;
    try {
      capsule = continuationHistoryCapsuleSchema.parse(capsuleValue);
    } catch {
      return { kind: "ambiguous" };
    }
    if (!continuationCapsuleHandlesEqual(capsule.handle, capsuleHandle)) {
      return { kind: "ambiguous" };
    }

    const history = continuationHistorySchema.parse({
      historyDigest: capsule.historyDigest,
      itemCount: capsule.itemCount,
      items: capsule.items,
      totalUtf8Bytes: capsule.historyUtf8Bytes,
    });
    const admissionMetadata = continuationIntentMetadata(request, history);
    const metadata = continuationIntentMetadataSchema.parse({
      ...admissionMetadata,
      targetProcessGeneration: request.observationGeneration,
    });
    let intent: PersistentActorContinuationIntent | null;
    try {
      intent = nullableContinuationIntentSchema.parse(
        await port.readInjection({ metadata }),
      );
      if (intent === null) {
        const admitted = request.observationGeneration ===
            request.processGeneration
          ? null
          : nullableContinuationIntentSchema.parse(
              await port.readInjection({ metadata: admissionMetadata }),
            );
        const latest = nullableContinuationIntentSchema.parse(
          await port.readLatestInjection({ metadata }),
        );
        if (admitted === null && latest !== null) {
          return { kind: "ambiguous" };
        }
        let predecessor = latest ?? admitted;
        if (predecessor === null) {
          const newlyAdmitted = continuationIntentSchema.parse(
            await port.prepareInjection(admissionMetadata),
          );
          if (request.observationGeneration === request.processGeneration) {
            intent = newlyAdmitted;
          } else {
            predecessor = newlyAdmitted;
          }
        }
        if (predecessor !== null) {
          if (predecessor.targetProcessGeneration ===
              request.observationGeneration &&
            predecessor.state !== "supersededApplied" &&
            predecessor.state !== "supersededNotApplied"
          ) {
            intent = predecessor;
          } else {
            const recovered = await this.#recoverContinuationGeneration({
              request,
              history,
              predecessor,
              successorMetadata: metadata,
            });
            if (recovered.kind !== "ready") return recovered;
            intent = recovered.intent;
          }
        }
      } else if (
        intent.state === "supersededApplied" ||
        intent.state === "supersededNotApplied"
      ) {
        const recovered = await this.#recoverContinuationGeneration({
          request,
          history,
          predecessor: intent,
          successorMetadata: metadata,
        });
        if (recovered.kind !== "ready") return recovered;
        intent = recovered.intent;
      }
    } catch (cause: unknown) {
      return isContinuationIntentConflict(cause)
        ? { kind: "ambiguous" }
        : { kind: "pending" };
    }
    if (intent === null) return { kind: "pending" };
    if (!continuationIntentMatches(intent, metadata)) return { kind: "ambiguous" };
    if (intent.state === "ambiguous") return { kind: "ambiguous" };

    let wonInjectionEffect = false;
    if (intent.state === "prepared") {
      const prior = intent;
      try {
        intent = continuationIntentSchema.parse(await port.markInjectionEffectStarted({
          metadata,
          expectedRevision: prior.revision,
        }));
        wonInjectionEffect = continuationTransitionMatches(
          prior,
          intent,
          "injectionEffectStarted",
        );
        if (!wonInjectionEffect) return { kind: "ambiguous" };
      } catch {
        intent = await this.#reloadContinuationIntent(metadata);
        if (intent === null) return { kind: "pending" };
      }
    }

    if (intent.state === "injectionEffectStarted" && wonInjectionEffect) {
      try {
        await this.#sessions.injectHarnessActorContinuationHistory({
          actorId: request.actorId,
          accountProfileId: request.accountProfileId,
          expectedGeneration: requestObservationGeneration(request),
          providerThreadId: request.providerThreadId,
          history,
        });
      } catch {
        // A lost empty response is ambiguous. Exact readback below is the only
        // evidence allowed to settle the durable injection intent.
      }
    }

    let initialAbsenceProofDigest: string | null = null;
    if (
      intent.state === "injectionEffectStarted" ||
      intent.state === "injected" ||
      intent.state === "continueDispatchPrepared"
    ) {
      let readback: z.infer<typeof continuationReadbackSchema>;
      try {
        readback = continuationReadbackSchema.parse(
          await this.#sessions.verifyHarnessActorContinuationHistory({
            actorId: request.actorId,
            accountProfileId: request.accountProfileId,
            expectedGeneration: requestObservationGeneration(request),
            providerThreadId: request.providerThreadId,
            history,
          }),
        );
      } catch {
        return { kind: "pending" };
      }
      if (readback.kind === "unavailable") return { kind: "pending" };
      if (readback.kind === "empty") return { kind: "pending" };
      if (
        readback.kind === "mismatched" ||
        readback.historyDigest !== history.historyDigest
      ) {
        if (intent.state === "injectionEffectStarted" && !wonInjectionEffect) {
          return { kind: "pending" };
        }
        await this.#fenceContinuationIntent(intent, "injection_readback_mismatch");
        return { kind: "ambiguous" };
      }
      initialAbsenceProofDigest = digest(
        "continue-initial-absence",
        String(request.observationGeneration),
        history.historyDigest,
        readback.rawEvidenceDigest,
      );
      if (intent.state === "injectionEffectStarted") {
        const prior = intent;
        try {
          intent = continuationIntentSchema.parse(await port.settleInjectionApplied({
            metadata,
            expectedRevision: prior.revision,
            exactReadbackDigest: history.historyDigest,
          }));
        } catch {
          intent = await this.#reloadContinuationIntent(metadata);
          if (intent === null) return { kind: "pending" };
        }
        if (
          !continuationIntentMatches(intent, metadata) ||
          (intent.state !== "injected" &&
            intent.state !== "continueDispatchPrepared" &&
            intent.state !== "continueDispatchEffectStarted")
        ) return { kind: intent.state === "ambiguous" ? "ambiguous" : "pending" };
      }
    }

    if (intent.state === "injected") {
      const prior = intent;
      try {
        intent = continuationIntentSchema.parse(await port.prepareContinueDispatch({
          metadata,
          expectedRevision: prior.revision,
        }));
        const continuePreparedWon = continuationTransitionMatches(
          prior,
          intent,
          "continueDispatchPrepared",
        );
        if (!continuePreparedWon) return { kind: "ambiguous" };
      } catch {
        intent = await this.#reloadContinuationIntent(metadata);
        if (intent === null) return { kind: "pending" };
      }
    }
    if (!continuationIntentMatches(intent, metadata)) return { kind: "ambiguous" };
    if (intent.state === "ambiguous") return { kind: "ambiguous" };
    return {
      kind: "ready",
      intent,
      initialAbsenceProofDigest,
    };
  }

  async #recoverContinuationGeneration(input: Readonly<{
    request: PersistentActorTurnRequest;
    history: PersistentActorContinuationHistory;
    predecessor: PersistentActorContinuationIntent;
    successorMetadata: PersistentActorContinuationIntentMetadata;
  }>): Promise<ContinuationGenerationRecovery> {
    const { request, history, predecessor, successorMetadata } = input;
    const port = this.#continuationIntents;
    if (
      port === null ||
      predecessor.targetProcessGeneration >
        requestObservationGeneration(request) ||
      predecessor.actorId !== successorMetadata.actorId ||
      predecessor.actorTurnId !== successorMetadata.actorTurnId ||
      predecessor.sourceAccountProfileId !==
        successorMetadata.sourceAccountProfileId ||
      predecessor.sourceProcessGeneration !==
        successorMetadata.sourceProcessGeneration ||
      predecessor.sourceProviderThreadId !==
        successorMetadata.sourceProviderThreadId ||
      predecessor.sourceProviderTurnId !==
        successorMetadata.sourceProviderTurnId ||
      predecessor.targetAccountProfileId !==
        successorMetadata.targetAccountProfileId ||
      predecessor.targetProviderThreadId !==
        successorMetadata.targetProviderThreadId ||
      predecessor.clientUserMessageId !==
        successorMetadata.clientUserMessageId ||
      predecessor.historyDigest !== history.historyDigest ||
      predecessor.historyItemCount !== history.itemCount ||
      predecessor.historyUtf8Bytes !== history.totalUtf8Bytes
    ) return { kind: "ambiguous" };

    let readback: z.infer<typeof continuationReadbackSchema>;
    try {
      readback = continuationReadbackSchema.parse(
        await this.#sessions.verifyHarnessActorContinuationHistory({
          actorId: request.actorId,
          accountProfileId: request.accountProfileId,
          expectedGeneration: requestObservationGeneration(request),
          providerThreadId: request.providerThreadId,
          history,
        }),
      );
    } catch {
      return { kind: "pending" };
    }
    if (readback.kind === "unavailable") return { kind: "pending" };

    if (
      predecessor.state === "continueDispatchEffectStarted" ||
      predecessor.state === "supersededApplied"
    ) {
      const scans = await this.#stableTurnScans(request);
      if (scans === null) return { kind: "pending" };
      let fence: PinnedCodexMutationFence;
      try {
        fence = await this.#fence({
          accountProfileId: predecessor.targetAccountProfileId,
          processGeneration: predecessor.targetProcessGeneration,
          effectKey: request.effectKey,
        });
      } catch {
        return { kind: "pending" };
      }
      const outcome = reconcilePinnedCodexTurnStart(
        predecessor.clientUserMessageId,
        scans[0],
        scans[1],
        fence,
      );
      if (outcome.kind === "applied" && typeof outcome.turnId === "string") {
        const providerTurnId = outcome.turnId;
        if (predecessor.state === "supersededApplied") {
          return { kind: "alreadyApplied", providerTurnId };
        }
        const recoveryProofDigest = continuationGenerationRecoveryDigest({
          predecessor,
          successorGeneration: requestObservationGeneration(request),
          disposition: "applied",
          readback,
          scans,
          fence,
        });
        try {
          const recovered = continuationRecoveryResultSchema.parse(
            await port.supersedeForRecovery({
              predecessorMetadata: continuationMetadataFromIntent(predecessor),
              expectedRevision: predecessor.revision,
              recoveryProofDigest,
              predecessorState: "supersededApplied",
              successorMetadata: null,
              successorHistoryApplied: false,
            }),
          );
          if (
            recovered.successor !== null ||
            recovered.predecessor.state !== "supersededApplied" ||
            recovered.predecessor.recoveryProofDigest !== recoveryProofDigest
          ) return { kind: "ambiguous" };
          return { kind: "alreadyApplied", providerTurnId };
        } catch {
          return { kind: "pending" };
        }
      }
      if (predecessor.state === "supersededApplied") {
        return outcome.kind === "pending"
          ? { kind: "pending" }
          : { kind: "ambiguous" };
      }
      if (outcome.kind === "pending") return { kind: "pending" };
      if (outcome.kind === "ambiguous") return { kind: "ambiguous" };
      if (readback.kind !== "matched") {
        await this.#fenceContinuationIntent(
          predecessor,
          "injection_readback_mismatch",
        );
        return { kind: "ambiguous" };
      }
      return await this.#installContinuationSuccessor({
        predecessor,
        successorMetadata,
        historyApplied: true,
        predecessorState: "supersededNotApplied",
        readback,
        scans,
        fence,
      });
    }

    if (
      predecessor.state === "ambiguous" ||
      predecessor.state === "supersededNotApplied" ||
      predecessor.targetProcessGeneration ===
        requestObservationGeneration(request)
    ) return { kind: "ambiguous" };

    if (predecessor.state === "prepared") {
      if (readback.kind !== "empty") {
        await this.#fenceContinuationIntent(
          predecessor,
          "injection_readback_mismatch",
        );
        return { kind: "ambiguous" };
      }
      return await this.#installContinuationSuccessor({
        predecessor,
        successorMetadata,
        historyApplied: false,
        predecessorState: "supersededNotApplied",
        readback,
        scans: null,
        fence: null,
      });
    }

    if (predecessor.state === "injectionEffectStarted") {
      if (readback.kind === "matched") {
        return await this.#installContinuationSuccessor({
          predecessor,
          successorMetadata,
          historyApplied: true,
          predecessorState: "supersededApplied",
          readback,
          scans: null,
          fence: null,
        });
      }
      if (readback.kind !== "empty") {
        await this.#fenceContinuationIntent(
          predecessor,
          "injection_readback_mismatch",
        );
        return { kind: "ambiguous" };
      }
      let fence: PinnedCodexMutationFence;
      try {
        fence = await this.#fence({
          accountProfileId: predecessor.targetAccountProfileId,
          processGeneration: predecessor.targetProcessGeneration,
          effectKey: request.effectKey,
        });
      } catch {
        return { kind: "pending" };
      }
      if (!isCompleteMutationFence(fence)) return { kind: "pending" };
      return await this.#installContinuationSuccessor({
        predecessor,
        successorMetadata,
        historyApplied: false,
        predecessorState: "supersededNotApplied",
        readback,
        scans: null,
        fence,
      });
    }

    if (
      predecessor.state === "injected" ||
      predecessor.state === "continueDispatchPrepared"
    ) {
      if (readback.kind !== "matched") {
        await this.#fenceContinuationIntent(
          predecessor,
          "injection_readback_mismatch",
        );
        return { kind: "ambiguous" };
      }
      return await this.#installContinuationSuccessor({
        predecessor,
        successorMetadata,
        historyApplied: true,
        predecessorState: "supersededApplied",
        readback,
        scans: null,
        fence: null,
      });
    }
    return { kind: "ambiguous" };
  }

  async #installContinuationSuccessor(input: Readonly<{
    predecessor: PersistentActorContinuationIntent;
    successorMetadata: PersistentActorContinuationIntentMetadata;
    historyApplied: boolean;
    predecessorState: "supersededApplied" | "supersededNotApplied";
    readback: Exclude<z.infer<typeof continuationReadbackSchema>, {
      kind: "unavailable";
    }>;
    scans: readonly [PinnedCodexTurnScan, PinnedCodexTurnScan] | null;
    fence: PinnedCodexMutationFence | null;
  }>): Promise<ContinuationGenerationRecovery> {
    const port = this.#continuationIntents;
    if (port === null) return { kind: "pending" };
    const recoveryProofDigest = continuationGenerationRecoveryDigest({
      predecessor: input.predecessor,
      successorGeneration: input.successorMetadata.targetProcessGeneration,
      disposition: input.predecessorState === "supersededApplied"
        ? "applied"
        : "notApplied",
      readback: input.readback,
      scans: input.scans,
      fence: input.fence,
    });
    try {
      const recovered = continuationRecoveryResultSchema.parse(
        await port.supersedeForRecovery({
          predecessorMetadata: continuationMetadataFromIntent(input.predecessor),
          expectedRevision: input.predecessor.revision,
          recoveryProofDigest,
          predecessorState: input.predecessorState,
          successorMetadata: input.successorMetadata,
          successorHistoryApplied: input.historyApplied,
        }),
      );
      if (
        recovered.predecessor.state !== input.predecessorState ||
        recovered.predecessor.recoveryProofDigest !== recoveryProofDigest ||
        recovered.successor === null ||
        !continuationIntentMatches(
          recovered.successor,
          input.successorMetadata,
        ) ||
        recovered.successor.predecessorIntentId !==
          input.predecessor.intentId ||
        recovered.successor.recoveryProofDigest !== recoveryProofDigest ||
        recovered.successor.state !==
          (input.historyApplied ? "injected" : "prepared")
      ) return { kind: "ambiguous" };
      return { kind: "ready", intent: recovered.successor };
    } catch {
      return { kind: "pending" };
    }
  }

  async #reloadContinuationIntent(
    metadata: PersistentActorContinuationIntentMetadata,
  ): Promise<PersistentActorContinuationIntent | null> {
    const port = this.#continuationIntents;
    if (port === null) return null;
    try {
      const intent = nullableContinuationIntentSchema.parse(
        await port.readInjection({ metadata }),
      );
      return intent !== null && continuationIntentMatches(intent, metadata)
        ? intent
        : null;
    } catch {
      return null;
    }
  }

  async #winContinueDispatch(
    intent: PersistentActorContinuationIntent,
    absenceProofDigest: string,
  ): Promise<PersistentActorContinuationIntent | null> {
    const port = this.#continuationIntents;
    if (port === null || intent.state !== "continueDispatchPrepared") return null;
    try {
      const next = continuationIntentSchema.parse(
        await port.markContinueDispatchEffectStarted({
          metadata: continuationMetadataFromIntent(intent),
          expectedRevision: intent.revision,
          absenceProofDigest,
        }),
      );
      return continuationTransitionMatches(
          intent,
          next,
          "continueDispatchEffectStarted",
        ) && next.absenceProofDigest === absenceProofDigest
        ? next
        : null;
    } catch {
      return null;
    }
  }

  async #dispatchContinue(
    request: PersistentActorTurnRequest,
  ): Promise<PersistentActorTurnOutcome> {
    let positioned;
    try {
      positioned = await this.#sessions.startHarnessActorTurn({
        actorId: request.actorId,
        clientUserMessageId: request.clientUserMessageId,
        expectedGeneration: requestObservationGeneration(request),
        model: request.modelId,
        prompt: "continue",
        reasoningEffort: request.reasoningEffort,
        serviceTier: request.serviceTier,
        thread: {
          accountProfileId: request.accountProfileId,
          kind: "provider",
          providerThreadId: request.providerThreadId,
        },
      });
    } catch {
      return this.#pending("continuation-turn-response-lost", request.effectKey);
    }
    if (positioned.generation !== requestObservationGeneration(request)) {
      return this.#ambiguous("continuation-turn-generation-mismatch", request.effectKey);
    }
    return {
      kind: "applied",
      providerTurnId: positioned.providerTurnId,
      proof: this.#proof("continuation-turn-start", request.effectKey, "postDispatch", true, [
        String(request.observationGeneration),
        positioned.providerTurnId,
        String(positioned.streamPosition),
      ]),
    };
  }

  async #fenceContinuationIntent(
    intent: PersistentActorContinuationIntent,
    proofCode: PersistentActorContinuationAmbiguityCode,
  ): Promise<void> {
    const port = this.#continuationIntents;
    if (
      port === null ||
      intent.state === "ambiguous" ||
      intent.state === "supersededApplied" ||
      intent.state === "supersededNotApplied"
    ) return;
    try {
      await port.fenceInjectionAmbiguous({
        metadata: continuationMetadataFromIntent(intent),
        expectedRevision: intent.revision,
        proofCode,
      });
    } catch {
      // The provider outcome remains fail-closed even when persistence itself
      // needs recovery; no later path may infer permission to replay.
    }
  }

  async #stableTurnScans(
    request: PersistentActorTurnRequest,
  ): Promise<readonly [PinnedCodexTurnScan, PinnedCodexTurnScan] | null> {
    let scans: readonly [PinnedCodexTurnScan, PinnedCodexTurnScan];
    try {
      scans = await this.#scanTurns(
        request.accountProfileId,
        request.providerThreadId,
        requestObservationGeneration(request),
      );
    } catch {
      return null;
    }
    return pinnedCodexTurnScansHaveExactEvidence(scans[0], scans[1])
      ? scans
      : null;
  }

  async #scanTurns(
    accountProfileId: string,
    threadId: string,
    expectedGeneration: number,
  ): Promise<readonly [PinnedCodexTurnScan, PinnedCodexTurnScan]> {
    const reader = {
      threadTurnsList: async (input: Parameters<SessionCommandExecutor["threadTurnsList"]>[1]) =>
        (await this.#commands.threadTurnsList(
          accountProfileId,
          input,
          expectedGeneration,
        )).output,
      threadItemsList: async (input: Parameters<SessionCommandExecutor["threadItemsList"]>[1]) =>
        (await this.#commands.threadItemsList(
          accountProfileId,
          input,
          expectedGeneration,
        )).output,
    };
    return [
      await scanPinnedCodexTurns(reader, threadId),
      await scanPinnedCodexTurns(reader, threadId),
    ];
  }

  async #scanThreads(
    accountProfileId: string,
    expectedGeneration: number,
  ): Promise<PinnedCodexThreadStartScan> {
    return await scanPinnedCodexThreadStarts({
      threadList: async (input) =>
        (await this.#commands.threadList(
          accountProfileId,
          input,
          expectedGeneration,
        )).output,
    });
  }

  async #establishInitialSessionRecoveryProof(input: Readonly<{
    request: PersistentActorThreadRequest;
    providerThreadId: string;
    workspace: z.infer<typeof workspaceSchema>;
    observationGeneration: number;
  }>): Promise<InitialActorSessionEvidence> {
    const capability = await this.#readInitialSessionCapabilityEvidence(
      input.request,
      input.observationGeneration,
    );
    if (capability.kind !== "ready") return capability;
    const proofInput = {
      actorId: input.request.actorId,
      accountProfileId: input.request.accountProfileId,
      admissionGeneration: input.request.processGeneration,
      expectedGeneration: input.observationGeneration,
      providerThreadId: input.providerThreadId,
      priorRecoveryProofDigest: null,
    } as const;
    try {
      const sessionRecoveryProof = actorSessionRecoveryProofV2Schema.parse(
        await this.#sessions.observeHarnessActorSessionRecoveryProof(proofInput),
      );
      if (
        sessionRecoveryProof.observationGeneration !==
          capability.evidence.observationGeneration
      ) return Object.freeze({ kind: "invalid" });
      return Object.freeze({
        kind: "ready",
        observedProfile: Object.freeze({
          modelId: input.request.modelId,
          reasoningEffort: input.request.reasoningEffort,
        }),
        liveCapabilityEvidence: capability.evidence,
        sessionRecoveryProof,
      });
    } catch {
      // A reconciled thread may predate this process-local SessionService
      // registry. Adopt it only through the exact resume+double-read protocol.
    }
    try {
      const resumed = await this.#sessions.resumeHarnessActorThread({
        accountProfileId: input.request.accountProfileId,
        actorId: input.request.actorId,
        admissionGeneration: input.request.processGeneration,
        expectedGeneration: input.observationGeneration,
        model: input.request.modelId,
        previousRecoveryProofDigest: null,
        providerThreadId: input.providerThreadId,
        reasoningEffort: input.request.reasoningEffort,
        threadSource: input.request.threadSource,
        title: persistentActorTitle(input.request.actorId),
        workspaceMode: input.workspace.authority === "readOnlySnapshot"
          ? "readOnly"
          : "managed",
        workspacePath: input.workspace.checkoutPath,
      });
      if (
        resumed.admissionGeneration !== input.request.processGeneration ||
        resumed.generation !== input.observationGeneration ||
        resumed.providerThreadId !== input.providerThreadId
      ) return Object.freeze({ kind: "invalid" });
      const proof = actorSessionRecoveryProofV2Schema.parse(resumed.recoveryProof);
      return proof.priorRecoveryProofDigest === null &&
          proof.observationGeneration ===
            capability.evidence.observationGeneration
        ? Object.freeze({
            kind: "ready",
            observedProfile: resumed.observedProfile,
            liveCapabilityEvidence: capability.evidence,
            sessionRecoveryProof: proof,
          })
        : Object.freeze({ kind: "invalid" });
    } catch {
      return Object.freeze({ kind: "pending" });
    }
  }

  async #readInitialSessionCapabilityEvidence(
    request: PersistentActorThreadRequest,
    observationGeneration: number,
  ): Promise<
    | Readonly<{ kind: "pending" }>
    | Readonly<{ kind: "invalid" }>
    | Readonly<{
        kind: "ready";
        evidence: Readonly<{
          observationGeneration: number;
          evidenceDigest: string | null;
          supportsFast: boolean | null;
        }>;
      }>
  > {
    if (request.policyVersion === 0) {
      return Object.freeze({
        kind: "ready",
        evidence: Object.freeze({
          observationGeneration,
          evidenceDigest: null,
          supportsFast: null,
        }),
      });
    }
    let catalog: SessionHarnessModelCatalog;
    try {
      catalog = await this.#sessions.readHarnessModelCatalog(
        request.accountProfileId,
        observationGeneration,
      );
    } catch {
      return Object.freeze({ kind: "pending" });
    }
    if (catalog.generation !== observationGeneration) {
      return Object.freeze({ kind: "invalid" });
    }
    const matches = catalog.models.filter(({ modelId }) =>
      modelId === request.modelId
    );
    if (
      matches.length !== 1 ||
      !matches[0]!.reasoningEfforts.includes(request.reasoningEffort)
    ) {
      return Object.freeze({ kind: "invalid" });
    }
    const evidence = Object.freeze({
      observationGeneration,
      evidenceDigest: catalog.evidenceDigest,
      supportsFast: matches[0]!.serviceTiers.includes("fast"),
    });
    if (
      observationGeneration === request.processGeneration &&
      (request.capabilityEvidenceDigest !== evidence.evidenceDigest ||
        request.supportsFast !== evidence.supportsFast)
    ) {
      return Object.freeze({ kind: "invalid" });
    }
    return Object.freeze({ kind: "ready", evidence });
  }

  async #workspace(laneId: string) {
    return workspaceSchema.parse(await this.#workspaces.resolveLane(laneId));
  }

  async #workspaceForTurn(request: PersistentActorTurnRequest) {
    // The actor coordinator fixes one incarnation to one workspace. Resolve by
    // actor identity so callers cannot inject an absolute path into a turn.
    return workspaceSchema.parse(
      await this.#workspaces.resolveActor(request.actorId),
    );
  }

  async #fence(input: Readonly<{
    accountProfileId: string;
    processGeneration: number;
    effectKey: string;
  }>): Promise<PinnedCodexMutationFence> {
    if (this.#mutationFences === null) return noMutationFence;
    return mutationFenceSchema.parse(await this.#mutationFences.read(input));
  }

  #assertToolset(
    toolsetDigest: string,
    purpose: "fresh" | "recovery",
  ): void {
    const digestValue = digestSchema.parse(toolsetDigest);
    if (
      (purpose === "fresh" && digestValue !== this.#toolsetDigest) ||
      classifyHraRlmDynamicToolSpecDigest(digestValue, purpose) === null
    ) {
      throw new Error("persistent actor toolset identity changed");
    }
  }

  #pending(
    domain: string,
    effectKey: string,
  ): Extract<PersistentActorThreadOutcome, { kind: "pending" }> {
    return {
      kind: "pending",
      proof: this.#proof(domain, effectKey, "observation", false),
    };
  }

  #ambiguous(
    domain: string,
    effectKey: string,
    evidence: readonly string[] = [],
  ): Extract<PersistentActorThreadOutcome, { kind: "ambiguous" }> {
    return {
      kind: "ambiguous",
      proof: this.#proof(domain, effectKey, "observation", true, evidence),
    };
  }

  #turnProof(
    domain: string,
    request: PersistentActorTurnRequest,
    scans: readonly [PinnedCodexTurnScan, PinnedCodexTurnScan],
    definitive: boolean,
  ): PersistentActorEffectProof {
    return this.#proof(domain, request.effectKey, "observation", definitive, [
      String(request.observationGeneration),
      pinnedCodexTurnScanEvidenceDigest(scans[0]),
      pinnedCodexTurnScanEvidenceDigest(scans[1]),
    ]);
  }

  #heldFastCapacity(
    reason: PersistentActorFastCapacityHeldReason,
    request: PersistentActorTurnRequest,
    successorGeneration: number | null,
    scans: readonly [PinnedCodexTurnScan, PinnedCodexTurnScan] | null,
    fence: PinnedCodexMutationFence | null,
    providerTurnId: string | null = null,
    providerTurnStatus: string | null = null,
  ): Extract<PersistentActorFastCapacityReconciliationOutcome, { kind: "held" }> {
    return {
      kind: "held",
      reason,
      successorGeneration,
      proof: this.#fastCapacityProof(
        `held:${reason}`,
        request,
        successorGeneration,
        scans,
        fence,
        false,
        providerTurnId,
        providerTurnStatus,
      ),
    };
  }

  #fastCapacityProof(
    disposition: string,
    request: PersistentActorTurnRequest,
    successorGeneration: number | null,
    scans: readonly [PinnedCodexTurnScan, PinnedCodexTurnScan] | null,
    fence: PinnedCodexMutationFence | null,
    definitive: boolean,
    providerTurnId: string | null = null,
    providerTurnStatus: string | null = null,
  ): PersistentActorEffectProof {
    return this.#proof(
      "fast-capacity-reconciliation",
      request.effectKey,
      "observation",
      definitive,
      [
        disposition,
        String(request.processGeneration),
        successorGeneration === null
          ? "successor-generation-unavailable"
          : String(successorGeneration),
        request.providerThreadId,
        request.clientUserMessageId,
        scans === null
          ? "first-scan-unavailable"
          : pinnedCodexTurnScanEvidenceDigest(scans[0]),
        scans === null
          ? "second-scan-unavailable"
          : pinnedCodexTurnScanEvidenceDigest(scans[1]),
        fence === null
          ? "previous-generation-terminated-unavailable"
          : String(fence.previousGenerationTerminated),
        fence === null
          ? "exclusive-mutation-lease-unavailable"
          : String(fence.exclusiveMutationLease),
        fence === null
          ? "external-deletion-excluded-unavailable"
          : String(fence.externalDeletionExcluded),
        providerTurnId ?? "provider-turn-unavailable",
        providerTurnStatus ?? "provider-turn-status-unavailable",
      ],
    );
  }

  #proof(
    domain: string,
    effectKey: string,
    phase: PersistentActorEffectProof["phase"],
    definitive: boolean,
    evidence: readonly string[] = [],
  ): PersistentActorEffectProof {
    return {
      digest: digest("proof", domain, effectKey, ...evidence),
      observedAt: this.#now().toISOString(),
      definitive,
      phase,
    };
  }
}

export interface CodexPersistentActorAccountAdapterOptions {
  readonly accounts: Pick<AccountService, "refreshChatAccountCandidates">;
  readonly authority: Readonly<{
    readActiveActorAccountLoad(input: Readonly<{
      accountProfileId: string;
      processGeneration: number;
    }>): number;
  }>;
  readonly runtimes: Pick<
    AccountRuntimeRouter,
    "generation" | "supportsDynamicTool"
  >;
  readonly sessions: Pick<SessionService, "readHarnessModelCatalog">;
}

/**
 * One coherent routing snapshot. Capability/runtime absence is retained per
 * subscription so the coordinator cannot mistake a recoverable process gap
 * for definitive subscription exhaustion after filtering visited accounts.
 */
export interface CodexPersistentActorAccountEligibilityResult {
  readonly kind: "resolved";
  readonly candidates: readonly PersistentActorAccountCandidate[];
  readonly temporarilyUnavailableAccountProfileIds: readonly string[];
  readonly unsupportedAccountProfileIds: readonly string[];
}

/**
 * Deterministic profile-first account routing over complete, generation-local
 * provider catalogs. Catalog transport gaps remain temporary; an unsupported
 * profile is definitive only when the exact catalog itself proves absence.
 */
export class CodexPersistentActorAccountAdapter implements PersistentActorAccountPort {
  readonly #accounts: Pick<AccountService, "refreshChatAccountCandidates">;
  readonly #authority: CodexPersistentActorAccountAdapterOptions["authority"];
  readonly #runtimes: Pick<
    AccountRuntimeRouter,
    "generation" | "supportsDynamicTool"
  >;
  readonly #sessions: Pick<SessionService, "readHarnessModelCatalog">;

  constructor(options: CodexPersistentActorAccountAdapterOptions) {
    this.#accounts = options.accounts;
    this.#authority = options.authority;
    this.#runtimes = options.runtimes;
    this.#sessions = options.sessions;
  }

  async listEligibleAccounts(inputValue: Readonly<{
    epochId: string;
    actorId: string;
    workClass: PersistedActorWorkClass;
  }>): Promise<CodexPersistentActorAccountEligibilityResult> {
    const input = Object.freeze({
      epochId: actorEpochIdSchema.parse(inputValue.epochId),
      actorId: durableActorIdSchema.parse(inputValue.actorId),
      workClass: persistedActorWorkClassSchema.parse(inputValue.workClass),
    });
    const routable: PersistentActorAccountCandidate[] = [];
    const temporarilyUnavailableAccountProfileIds: string[] = [];
    const unsupportedAccountProfileIds: string[] = [];
    const seen = new Set<string>();
    const accountCandidates = await this.#accounts.refreshChatAccountCandidates();
    for (const candidate of accountCandidates) {
      if (seen.has(candidate.id)) {
        throw new Error("persistent actor account routing identities are not unique");
      }
      seen.add(candidate.id);
    }
    await Promise.all(accountCandidates.map(async (candidate) => {
      if (candidate.budget === "exhausted") return;
      const processGeneration = this.#runtimes.generation(candidate.id);
      if (
        processGeneration === null || processGeneration < 1 ||
        !this.#runtimes.supportsDynamicTool(candidate.id, processGeneration)
      ) {
        temporarilyUnavailableAccountProfileIds.push(candidate.id);
        return;
      }
      let catalog: SessionHarnessModelCatalog;
      try {
        catalog = await this.#sessions.readHarnessModelCatalog(
          candidate.id,
          processGeneration,
        );
      } catch {
        temporarilyUnavailableAccountProfileIds.push(candidate.id);
        return;
      }
      if (catalog.generation !== processGeneration) {
        temporarilyUnavailableAccountProfileIds.push(candidate.id);
        return;
      }
      const route = compileMetaharnessRoute({
        workClass: metaharnessRoutingWorkClass(input.workClass),
        capabilities: modelCatalogCapabilities(catalog),
      });
      if (route.kind === "capabilityUnavailable") {
        unsupportedAccountProfileIds.push(candidate.id);
        return;
      }
      const activeTurnCount = this.#authority.readActiveActorAccountLoad({
        accountProfileId: candidate.id,
        processGeneration,
      });
      const rendezvousScore = accountRendezvousScore({
        ...input,
        accountProfileId: candidate.id,
        processGeneration,
      });
      routable.push({
        accountProfileId: candidate.id,
        activeTurnCount,
        capabilityEvidenceDigest: catalog.evidenceDigest,
        modelId: route.selectedProfile.modelId,
        processGeneration,
        profileFallbackReason: route.profileFallbackReason,
        remainingPercent: candidate.remainingPercent,
        selectedProfile: route.selectedProfile.key,
        supportsFast: route.supportsFast,
        reasoningEffort: route.selectedProfile.reasoningEffort,
        routingPriority: Object.freeze({
          profileFallbackRank: route.profileFallbackReason === null ? 0 : 1,
          budgetRank: budgetRank(candidate.budget),
          remainingHeadroomRank: remainingHeadroomRank(
            candidate.remainingPercent,
          ),
          rendezvousScore,
          selected: candidate.selected,
        }),
      });
    }));
    const candidates = routable
      .toSorted((left, right) =>
        left.routingPriority.profileFallbackRank -
          right.routingPriority.profileFallbackRank ||
        left.routingPriority.budgetRank - right.routingPriority.budgetRank ||
        left.routingPriority.remainingHeadroomRank -
          right.routingPriority.remainingHeadroomRank ||
        left.activeTurnCount - right.activeTurnCount ||
        right.routingPriority.rendezvousScore.localeCompare(
          left.routingPriority.rendezvousScore,
        ) ||
        Number(right.routingPriority.selected) -
          Number(left.routingPriority.selected) ||
        left.accountProfileId.localeCompare(right.accountProfileId) ||
        left.processGeneration - right.processGeneration
      )
      .map((candidate) => Object.freeze(candidate));
    return Object.freeze({
      kind: "resolved",
      candidates: Object.freeze(candidates),
      temporarilyUnavailableAccountProfileIds: Object.freeze(
        temporarilyUnavailableAccountProfileIds.toSorted(),
      ),
      unsupportedAccountProfileIds: Object.freeze(
        unsupportedAccountProfileIds.toSorted(),
      ),
    });
  }
}

function modelCatalogCapabilities(
  catalog: SessionHarnessModelCatalog,
): readonly MetaharnessCatalogCapability[] {
  return Object.freeze(catalog.models.map((model) => Object.freeze({
    modelId: model.modelId,
    reasoningEfforts: [...model.reasoningEfforts],
    supportsFast: model.serviceTiers.includes("fast"),
  })));
}

function accountRendezvousScore(input: Readonly<{
  epochId: string;
  actorId: string;
  workClass: PersistedActorWorkClass;
  accountProfileId: string;
  processGeneration: number;
}>): string {
  return digest(
    "account-rendezvous",
    input.epochId,
    input.actorId,
    input.workClass,
    input.accountProfileId,
    String(input.processGeneration),
  );
}

/** Policy-v0 recovery retains its documented Sol Ultra profile. */
function metaharnessRoutingWorkClass(
  workClass: PersistedActorWorkClass,
): ActorWorkClass {
  return workClass === "legacyUnclassified" ? "largeChange" : workClass;
}

/** Known higher headroom precedes lower headroom; unknown evidence is last. */
function remainingHeadroomRank(value: number | null): number {
  return value === null ? 101 : 100 - value;
}

/**
 * `processGeneration` is the immutable effect-admission identity while
 * `observationGeneration` is the proven live SessionService runtime used for
 * reads. New mutations require equality; recovery reads may advance only the
 * latter.
 */
function requestObservationGeneration(
  input: Readonly<{
    processGeneration: number;
    observationGeneration: number;
  }>,
): number {
  const processGeneration = z.number().int().positive().safe()
    .parse(input.processGeneration);
  const observationGeneration = z.number().int().positive().safe()
    .parse(input.observationGeneration);
  if (observationGeneration < processGeneration) {
    throw new Error("actor observation generation regressed");
  }
  return observationGeneration;
}

function continuationIntentMetadata(
  request: PersistentActorTurnRequest,
  history: PersistentActorContinuationHistory,
): PersistentActorContinuationIntentMetadata {
  const source = request.continuation;
  if (source === null) throw new Error("continuation metadata requires a source");
  return continuationIntentMetadataSchema.parse({
    actorId: request.actorId,
    actorTurnId: request.turnId,
    clientUserMessageId: request.clientUserMessageId,
    historyDigest: history.historyDigest,
    historyItemCount: history.itemCount,
    historyUtf8Bytes: history.totalUtf8Bytes,
    sourceAccountProfileId: source.sourceAccountProfileId,
    sourceProcessGeneration: source.sourceProcessGeneration,
    sourceProviderThreadId: source.sourceProviderThreadId,
    sourceProviderTurnId: source.sourceProviderTurnId,
    targetAccountProfileId: request.accountProfileId,
    targetProcessGeneration: request.processGeneration,
    targetProviderThreadId: request.providerThreadId,
  });
}

function continuationCapsuleHandlesEqual(
  left: PersistentActorContinuationHistoryCapsuleHandle,
  right: PersistentActorContinuationHistoryCapsuleHandle,
): boolean {
  return left.version === right.version &&
    left.epochId === right.epochId &&
    left.actorId === right.actorId &&
    left.actorTurnId === right.actorTurnId &&
    left.sourceAttemptId === right.sourceAttemptId &&
    left.valueId === right.valueId;
}

function isContinuationCapsuleDefinitiveFailure(cause: unknown): boolean {
  if (!(cause instanceof Error)) return false;
  const candidate = cause as Error & { readonly code?: unknown };
  return candidate.name === "HarnessContextValuePortsV2Error" &&
    (candidate.code === "not_found" ||
      candidate.code === "identity_conflict" ||
      candidate.code === "corrupt_store");
}

function isContinuationIntentConflict(cause: unknown): boolean {
  if (!(cause instanceof Error)) return false;
  const candidate = cause as Error & { readonly code?: unknown };
  return candidate.name ===
      "PersistentActorContinuationSQLiteAuthorityV2Error" &&
    candidate.code === "conflict";
}

function continuationIntentMatches(
  intent: PersistentActorContinuationIntent,
  metadata: PersistentActorContinuationIntentMetadata,
): boolean {
  return intent.actorId === metadata.actorId &&
    intent.actorTurnId === metadata.actorTurnId &&
    intent.clientUserMessageId === metadata.clientUserMessageId &&
    intent.historyDigest === metadata.historyDigest &&
    intent.historyItemCount === metadata.historyItemCount &&
    intent.historyUtf8Bytes === metadata.historyUtf8Bytes &&
    intent.sourceAccountProfileId === metadata.sourceAccountProfileId &&
    intent.sourceProcessGeneration === metadata.sourceProcessGeneration &&
    intent.sourceProviderThreadId === metadata.sourceProviderThreadId &&
    intent.sourceProviderTurnId === metadata.sourceProviderTurnId &&
    intent.targetAccountProfileId === metadata.targetAccountProfileId &&
    intent.targetProcessGeneration === metadata.targetProcessGeneration &&
    intent.targetProviderThreadId === metadata.targetProviderThreadId;
}

function continuationMetadataFromIntent(
  intent: PersistentActorContinuationIntent,
): PersistentActorContinuationIntentMetadata {
  return continuationIntentMetadataSchema.parse({
    actorId: intent.actorId,
    actorTurnId: intent.actorTurnId,
    clientUserMessageId: intent.clientUserMessageId,
    historyDigest: intent.historyDigest,
    historyItemCount: intent.historyItemCount,
    historyUtf8Bytes: intent.historyUtf8Bytes,
    sourceAccountProfileId: intent.sourceAccountProfileId,
    sourceProcessGeneration: intent.sourceProcessGeneration,
    sourceProviderThreadId: intent.sourceProviderThreadId,
    sourceProviderTurnId: intent.sourceProviderTurnId,
    targetAccountProfileId: intent.targetAccountProfileId,
    targetProcessGeneration: intent.targetProcessGeneration,
    targetProviderThreadId: intent.targetProviderThreadId,
  });
}

function continuationTransitionMatches(
  previous: PersistentActorContinuationIntent,
  next: PersistentActorContinuationIntent,
  expectedState: PersistentActorContinuationIntentState,
): boolean {
  return next.state === expectedState &&
    next.revision === previous.revision + 1 &&
    next.intentId === previous.intentId &&
    next.predecessorIntentId === previous.predecessorIntentId &&
    next.recoveryProofDigest === previous.recoveryProofDigest &&
    continuationIntentMatches(next, previous);
}

function continuationGenerationRecoveryDigest(input: Readonly<{
  predecessor: PersistentActorContinuationIntent;
  successorGeneration: number;
  disposition: "applied" | "notApplied";
  readback: Exclude<z.infer<typeof continuationReadbackSchema>, {
    kind: "unavailable";
  }>;
  scans: readonly [PinnedCodexTurnScan, PinnedCodexTurnScan] | null;
  fence: PinnedCodexMutationFence | null;
}>): string {
  return digest(
    "continuation-generation-recovery",
    input.predecessor.intentId,
    input.predecessor.state,
    String(input.predecessor.revision),
    String(input.predecessor.targetProcessGeneration),
    String(input.successorGeneration),
    input.disposition,
    input.readback.kind,
    input.readback.rawEvidenceDigest,
    input.scans === null
      ? "no-turn-scan"
      : pinnedCodexTurnScanEvidenceDigest(input.scans[0]),
    input.scans === null
      ? "no-turn-rescan"
      : pinnedCodexTurnScanEvidenceDigest(input.scans[1]),
    String(input.fence?.previousGenerationTerminated ?? false),
    String(input.fence?.exclusiveMutationLease ?? false),
    String(input.fence?.externalDeletionExcluded ?? false),
  );
}

function isCompleteMutationFence(fence: PinnedCodexMutationFence): boolean {
  return fence.previousGenerationTerminated &&
    fence.exclusiveMutationLease &&
    fence.externalDeletionExcluded;
}

function continuationHistoryDigest(
  items: readonly Readonly<{ role: "user" | "assistant"; text: string }>[],
): string {
  const hash = createHash("sha256");
  hash.update("oprte.harness.actor-continuation-history.v1\0");
  for (const item of items) {
    const bytes = Buffer.from(item.text, "utf8");
    hash.update(item.role).update("\0").update(String(bytes.length)).update(":");
    hash.update(bytes).update("\0");
  }
  return hash.digest("hex");
}

const mutationFenceSchema = z.object({
  previousGenerationTerminated: z.boolean(),
  exclusiveMutationLease: z.boolean(),
  externalDeletionExcluded: z.boolean(),
}).strict();

const noMutationFence: PinnedCodexMutationFence = Object.freeze({
  previousGenerationTerminated: false,
  exclusiveMutationLease: false,
  externalDeletionExcluded: false,
});

function terminal(
  request: PersistentActorTurnObservationRequest,
  state: PersistentActorTerminalObservation["terminal"],
  resultValueId: string | null,
  outcomeCode: string,
  proof: PersistentActorEffectProof,
  usage: Readonly<{ inputTokens: number; outputTokens: number }>,
): PersistentActorTerminalObservation {
  return {
    accountProfileId: request.accountProfileId,
    processGeneration: request.observationGeneration,
    providerThreadId: request.providerThreadId,
    providerTurnId: request.providerTurnId,
    terminal: state,
    resultValueId,
    outcomeCode,
    quotaProof: outcomeCode === "usage_limit_exceeded"
      ? "provider_usage_limit_exceeded"
      : null,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    proof,
  };
}

function hasQuotaProof(turn: Readonly<{ status: string }> & object): boolean {
  return "quotaProof" in turn &&
    turn.quotaProof === "provider_usage_limit_exceeded" &&
    turn.status === "failed";
}

function hasDuplicateItemIds(
  items: readonly Readonly<{ id: string }>[],
): boolean {
  return new Set(items.map(({ id }) => id)).size !== items.length;
}

function assertFreshMetaharnessThreadRequest(
  request: PersistentActorThreadRequest,
): asserts request is PersistentActorThreadRequest & Readonly<{
  policyVersion: 1;
  workClass: ActorWorkClass;
}> {
  if (request.policyVersion !== 1 || request.workClass === "legacyUnclassified") {
    throw new Error("legacy actor policy cannot start a fresh provider thread");
  }
  const profile = HRA_METAHARNESS_PROFILES[request.selectedProfile];
  const acceptable = orderedProfilesForWorkClass(request.workClass);
  const requested = acceptable?.[0];
  if (
    acceptable === null || requested === undefined ||
    !acceptable.some(({ key }) => key === profile.key) ||
    request.modelId !== profile.modelId ||
    request.reasoningEffort !== profile.reasoningEffort ||
    request.profileFallbackReason !==
      (profile.key === requested.key ? null : "lunaUnavailable")
  ) {
    throw new Error("persistent actor profile conflicts with its work class");
  }
}

function assertMetaharnessTurnRequest(
  request: PersistentActorTurnRequest,
): void {
  if (request.continuation !== null) {
    throw new Error("provider quota continuation is disabled");
  }
  const profileIsValid = Object.values(HRA_METAHARNESS_PROFILES).some(
    (profile) =>
      profile.modelId === request.modelId &&
      profile.reasoningEffort === request.reasoningEffort,
  );
  const policyRequestsFast = request.requestedServiceTier === "fast";
  const realizesFast = request.serviceTier === "fast";
  if (
    !profileIsValid ||
    (realizesFast && !policyRequestsFast) ||
    (realizesFast !== (request.fastReservationId !== null)) ||
    (realizesFast && request.capabilityEvidenceDigest === null) ||
    (realizesFast !== (request.tierFallbackReason === null) &&
      policyRequestsFast) ||
    (!policyRequestsFast && request.tierFallbackReason !== null)
  ) {
    throw new Error("persistent actor turn profile or tier evidence is invalid");
  }
  if (request.capabilityEvidenceDigest !== null) {
    digestSchema.parse(request.capabilityEvidenceDigest);
  }
}

function persistentActorTitle(actorId: string): string {
  return `HRA actor ${actorId}`;
}

function resultOperationId(effectKey: string): string {
  return `actorresult_${digest("result", effectKey)}`;
}

function threadScanDigest(scan: PinnedCodexThreadStartScan): string {
  return digest(
    "thread-scan",
    String(scan.complete),
    ...[...scan.active, ...scan.archived]
      .map((thread) => digest(
        "thread",
        thread.id,
        thread.cwd,
        String(thread.ephemeral),
        thread.historyMode ?? "legacy",
        thread.threadSource ?? "",
      ))
      .sort(),
  );
}

function budgetRank(
  value: "healthy" | "low" | "unknown" | "exhausted",
): 0 | 1 | 2 {
  if (value === "exhausted") {
    throw new Error("exhausted account reached persistent actor routing");
  }
  return value === "healthy" ? 0 : value === "unknown" ? 1 : 2;
}

function digest(domain: string, ...parts: readonly string[]): string {
  const hash = createHash("sha256").update(`oprte.persistent-actor.${domain}.v1\0`);
  for (const part of parts) {
    hash.update(String(Buffer.byteLength(part, "utf8"))).update(":").update(part);
  }
  return hash.digest("hex");
}
