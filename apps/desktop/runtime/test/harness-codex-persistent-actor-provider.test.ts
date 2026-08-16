import { createHash, createHmac } from "node:crypto";
import { describe, expect, test } from "bun:test";

import {
  HRA_RLM_DYNAMIC_TOOL_SPEC_SHA256,
  pinnedCodexTurnScanEvidenceDigest,
} from "../src/codex";
import { HRA_RLM_PREDECESSOR_DYNAMIC_TOOL_SPEC_SHA256 } from
  "../src/codex/dynamic-tool";
import {
  CodexPersistentActorAccountAdapter,
  CodexPersistentActorProvider,
  type CodexPersistentActorProviderOptions,
  type PersistentActorContinuationIntent,
  type PersistentActorContinuationIntentMetadata,
  type PersistentActorContinuationIntentPort,
} from "../src/harness/codex-persistent-actor-provider";
import type {
  PersistentActorInterruptRequest,
  PersistentActorThreadRequest,
  PersistentActorTurnObservationRequest,
  PersistentActorTurnRequest,
} from "../src/harness/persistent-actors";

const now = new Date("2026-08-06T12:00:00.000Z");
const toolsetDigest = HRA_RLM_DYNAMIC_TOOL_SPEC_SHA256;
const workspace = {
  checkoutPath: "/tmp/oprte-actor-workspace",
  authority: "readOnlySnapshot" as const,
};

const threadRequest: PersistentActorThreadRequest = {
  actorId: "hactor_000000001",
  epochId: "hepoch_000000001",
  policyVersion: 1,
  workClass: "standard",
  accountProfileId: "acct_000000001",
  processGeneration: 7,
  modelId: "gpt-5.6-sol",
  reasoningEffort: "max",
  selectedProfile: "solMax",
  profileFallbackReason: null,
  capabilityEvidenceDigest: "9".repeat(64),
  supportsFast: true,
  clientRequestId: "request_00000001",
  threadSource: "oprte-actor-hactor_000000001",
  toolsetDigest,
  workspaceLaneId: "hsnapshot_000000001",
  effectKey: "b".repeat(64),
  continuation: null,
};

const turnRequest: PersistentActorTurnRequest = {
  actorId: threadRequest.actorId,
  epochId: threadRequest.epochId,
  turnId: "hturn_000000001",
  incarnationId: "hincarnation_000000001",
  accountProfileId: threadRequest.accountProfileId,
  processGeneration: threadRequest.processGeneration,
  observationGeneration: threadRequest.processGeneration,
  providerThreadId: "provider-thread-1",
  modelId: threadRequest.modelId,
  reasoningEffort: threadRequest.reasoningEffort,
  requestedAcceleration: { mode: "standard" },
  serviceTier: "standard",
  tierFallbackReason: null,
  capabilityEvidenceDigest: threadRequest.capabilityEvidenceDigest,
  fastReservationId: null,
  toolsetDigest,
  clientUserMessageId: "message_00000001",
  inputValueId: "ctxval_000000001",
  effectKey: "c".repeat(64),
  continuation: null,
};

const quarantinedFastTurnRequest: PersistentActorTurnRequest = {
  ...turnRequest,
  requestedAcceleration: {
    mode: "fast",
    criticalPath: true,
    bottleneck: "reasoning",
  },
  serviceTier: "fast",
  fastReservationId: "hfast_00000000000001",
};

const completeMutationFence = Object.freeze({
  previousGenerationTerminated: true,
  exclusiveMutationLease: true,
  externalDeletionExcluded: true,
});

const continuationTurnRequest: PersistentActorTurnRequest = {
  ...turnRequest,
  accountProfileId: "acct_target00001",
  processGeneration: 9,
  observationGeneration: 9,
  providerThreadId: "provider-target-thread",
  clientUserMessageId: "message_continue01",
  effectKey: "e".repeat(64),
  continuation: {
    sourceAttemptId: "hattempt_000000001",
    historyValueId: "ctxval_history0001",
    sourceAccountProfileId: turnRequest.accountProfileId,
    sourceProcessGeneration: turnRequest.processGeneration,
    sourceProviderThreadId: turnRequest.providerThreadId,
    sourceProviderTurnId: "provider-turn-1",
  },
};

const interruptRequest: PersistentActorInterruptRequest = {
  actorId: turnRequest.actorId,
  turnId: turnRequest.turnId,
  incarnationId: turnRequest.incarnationId,
  accountProfileId: turnRequest.accountProfileId,
  processGeneration: turnRequest.processGeneration,
  observationGeneration: turnRequest.observationGeneration,
  providerThreadId: turnRequest.providerThreadId,
  providerTurnId: "provider-turn-1",
  effectKey: "d".repeat(64),
};

function rawThread(overrides: Readonly<Record<string, unknown>> = {}) {
  return {
    id: "provider-thread-1",
    ephemeral: false,
    historyMode: "paginated" as const,
    preview: "",
    createdAt: 1,
    updatedAt: 1,
    status: { type: "idle" as const },
    cwd: workspace.checkoutPath,
    threadSource: threadRequest.threadSource,
    name: null,
    turns: [],
    ...overrides,
  };
}

function rawTurn(
  status: "inProgress" | "completed" | "interrupted" | "failed",
  overrides: Readonly<Record<string, unknown>> = {},
) {
  return {
    id: "provider-turn-1",
    items: [],
    itemsView: "notLoaded" as const,
    status,
    startedAt: 1,
    completedAt: status === "inProgress" ? null : 2,
    ...overrides,
  };
}

function userItem() {
  return {
    type: "userMessage" as const,
    id: "item-user-1",
    clientId: turnRequest.clientUserMessageId,
    text: "delegated task",
  };
}

function finalItem(text = "finished") {
  return {
    type: "agentMessage" as const,
    id: "item-agent-1",
    phase: "final_answer" as const,
    text,
  };
}

function commentaryItem(text = "working") {
  return {
    type: "agentMessage" as const,
    id: "item-commentary",
    phase: "commentary" as const,
    text,
  };
}

type TestHistoryItem = ReturnType<
  | typeof userItem
  | typeof finalItem
  | typeof commentaryItem
>;
type TestTurn = ReturnType<typeof rawTurn>;

const continuationHistoryItems = Object.freeze([
  Object.freeze({ role: "user" as const, text: "Original bounded request" }),
  Object.freeze({ role: "assistant" as const, text: "Partial bounded answer" }),
]);

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

function persistentActorDigest(
  domain: string,
  ...parts: readonly string[]
): string {
  const hash = createHash("sha256")
    .update(`oprte.persistent-actor.${domain}.v1\0`);
  for (const part of parts) {
    hash.update(String(Buffer.byteLength(part, "utf8"))).update(":").update(part);
  }
  return hash.digest("hex");
}

const continuationHistory = Object.freeze({
  historyDigest: continuationHistoryDigest(continuationHistoryItems),
  itemCount: continuationHistoryItems.length,
  items: continuationHistoryItems,
  totalUtf8Bytes: continuationHistoryItems.reduce(
    (total, item) => total + Buffer.byteLength(item.text, "utf8"),
    0,
  ),
});

const continuationCapsuleHandle = Object.freeze({
  version: 2 as const,
  epochId: continuationTurnRequest.epochId,
  actorId: continuationTurnRequest.actorId,
  actorTurnId: continuationTurnRequest.turnId,
  sourceAttemptId: continuationTurnRequest.continuation!.sourceAttemptId,
  valueId: "ctxval_history0001",
});

function continuationCapsule(
  overrides: Readonly<Record<string, unknown>> = {},
) {
  return Object.freeze({
    handle: continuationCapsuleHandle,
    historyDigest: continuationHistory.historyDigest,
    itemCount: continuationHistory.itemCount,
    historyUtf8Bytes: continuationHistory.totalUtf8Bytes,
    containerUtf8Bytes: continuationHistory.totalUtf8Bytes + 512,
    items: continuationHistory.items,
    ...overrides,
  });
}

function continuationIntentMetadataEvidence(
  metadata: PersistentActorContinuationIntentMetadata,
): string {
  return JSON.stringify([
    "oprte.harness.continuation-intent.test.v1",
    metadata.actorId,
    metadata.actorTurnId,
    metadata.clientUserMessageId,
    metadata.historyDigest,
    metadata.historyItemCount,
    metadata.historyUtf8Bytes,
    metadata.sourceAccountProfileId,
    metadata.sourceProcessGeneration,
    metadata.sourceProviderThreadId,
    metadata.sourceProviderTurnId,
    metadata.targetAccountProfileId,
    metadata.targetProcessGeneration,
    metadata.targetProviderThreadId,
  ]);
}

function continuationIntentId(
  metadata: PersistentActorContinuationIntentMetadata,
): string {
  const opaqueHandle = createHmac(
    "sha256",
    "oprte-provider-test-continuation-intent-key-v1",
  ).update(continuationIntentMetadataEvidence(metadata)).digest("hex");
  return `hcontinuation_${opaqueHandle}`;
}

function continuationMetadataAtGeneration(
  targetProcessGeneration: number,
): PersistentActorContinuationIntentMetadata {
  return Object.freeze({
    actorId: continuationTurnRequest.actorId,
    actorTurnId: continuationTurnRequest.turnId,
    clientUserMessageId: continuationTurnRequest.clientUserMessageId,
    historyDigest: continuationHistory.historyDigest,
    historyItemCount: continuationHistory.itemCount,
    historyUtf8Bytes: continuationHistory.totalUtf8Bytes,
    sourceAccountProfileId:
      continuationTurnRequest.continuation!.sourceAccountProfileId,
    sourceProcessGeneration:
      continuationTurnRequest.continuation!.sourceProcessGeneration,
    sourceProviderThreadId:
      continuationTurnRequest.continuation!.sourceProviderThreadId,
    sourceProviderTurnId:
      continuationTurnRequest.continuation!.sourceProviderTurnId,
    targetAccountProfileId: continuationTurnRequest.accountProfileId,
    targetProcessGeneration,
    targetProviderThreadId: continuationTurnRequest.providerThreadId,
  });
}

function contextValueFailure(
  code: "corrupt_store" | "identity_conflict" | "not_found",
): Error {
  const failure = new Error(`context value ${code}`);
  failure.name = "HarnessContextValuePortsV2Error";
  Object.assign(failure, { code });
  return failure;
}

function fixture(input: Readonly<{
  thread?: ReturnType<typeof rawThread>;
  startThreadError?: boolean;
  startTurnError?: boolean;
  startTurn?: ReturnType<typeof rawTurn>;
  observedTurn?: ReturnType<typeof rawTurn>;
  items?: readonly TestHistoryItem[];
  turnScanTurns?: readonly (readonly TestTurn[])[];
  itemsByTurn?: Readonly<Record<string, readonly TestHistoryItem[]>>;
  incompleteTurnScan?: boolean;
  turnScanError?: boolean;
  runtimeGeneration?: number;
  runtimeError?: boolean;
  catalogError?: boolean;
  catalogGeneration?: number;
  catalogEvidenceDigest?: string;
  catalogModelId?: string;
  catalogReasoningEfforts?: readonly string[];
  catalogServiceTiers?: readonly string[];
  fence?: Readonly<{
    previousGenerationTerminated: boolean;
    exclusiveMutationLease: boolean;
    externalDeletionExcluded: boolean;
  }>;
  fenceError?: boolean;
  tokenUsage?: Readonly<{ inputTokens: number; outputTokens: number }> | null;
  continuationReadback?: "empty" | "matched" | "mismatched" | "unavailable";
  continuationReadbacks?: readonly (
    "empty" | "matched" | "mismatched" | "unavailable"
  )[];
  continuationPredecessor?: Readonly<{
    targetProcessGeneration: number;
    state: PersistentActorContinuationIntent["state"];
  }>;
  continuationIntentConflict?: boolean;
  capsulePreseeded?: boolean;
  capsuleReadFailure?: "corrupt_store" | "identity_conflict" | "not_found" | "transient";
  capsulePutFailure?: "corrupt_store" | "identity_conflict" | "transient";
  capsuleHandleMismatch?: boolean;
  capsuleTampered?: boolean;
  injectionError?: boolean;
  markContinueDispatchErrorOnce?: boolean;
}> = {}) {
  const calls: Array<readonly [string, unknown]> = [];
  const intents = new Map<string, PersistentActorContinuationIntent>();
  const capsules = new Map<string, ReturnType<typeof continuationCapsule>>();
  if (input.capsulePreseeded !== false) {
    capsules.set(continuationCapsuleHandle.valueId, continuationCapsule());
  }
  let sourceHistoryAvailable = true;
  let rejectNextContinueDispatch = input.markContinueDispatchErrorOnce === true;
  const continuationReadbacks = [...(input.continuationReadbacks ?? [])];
  const thread = input.thread ?? rawThread();
  const observedTurn = input.observedTurn ?? rawTurn("completed");
  const items = input.items ?? [userItem(), finalItem()];
  let turnScanIndex = -1;
  const commands = {
    turnInterrupt(accountProfileId: string, command: unknown, expectedGeneration?: number) {
      calls.push(["turnInterrupt", { accountProfileId, command, expectedGeneration }]);
      return Promise.resolve({
        generation: 7,
        streamPosition: 30,
        output: { kind: "accepted_pending_terminal" as const },
      });
    },
    threadList(
      accountProfileId: string,
      command: { archived?: boolean | null },
      expectedGeneration?: number,
    ) {
      calls.push(["threadList", {
        accountProfileId,
        command,
        expectedGeneration,
      }]);
      return Promise.resolve({
        generation: expectedGeneration ?? 7,
        streamPosition: 40,
        output: {
          data: command.archived === true ? [] : [thread],
          nextCursor: null,
          backwardsCursor: null,
        },
      });
    },
    threadTurnsList(
      accountProfileId: string,
      command: Readonly<{ cursor?: string | null }>,
      expectedGeneration?: number,
    ) {
      calls.push(["threadTurnsList", {
        accountProfileId,
        command,
        expectedGeneration,
      }]);
      if (input.turnScanError === true) {
        return Promise.reject(new Error("turn scan unavailable"));
      }
      if ((command.cursor ?? null) === null) turnScanIndex += 1;
      const snapshots = input.turnScanTurns;
      const turns = snapshots === undefined
        ? [observedTurn]
        : snapshots[Math.min(turnScanIndex, snapshots.length - 1)] ?? [];
      return Promise.resolve({
        generation: expectedGeneration ??
          (accountProfileId === continuationTurnRequest.accountProfileId ? 9 : 7),
        streamPosition: 50,
        output: {
          data: turns,
          nextCursor: input.incompleteTurnScan === true ? "repeat-cursor" : null,
          backwardsCursor: null,
        },
      });
    },
    threadItemsList(
      accountProfileId: string,
      command: Readonly<{ turnId: string }>,
      expectedGeneration?: number,
    ) {
      calls.push(["threadItemsList", {
        accountProfileId,
        command,
        expectedGeneration,
      }]);
      return Promise.resolve({
        generation: expectedGeneration ??
          (accountProfileId === continuationTurnRequest.accountProfileId ? 9 : 7),
        streamPosition: 60,
        output: {
          data: input.itemsByTurn?.[command.turnId] ?? items,
          nextCursor: null,
          backwardsCursor: null,
        },
      });
    },
  };
  const sessions = {
    readHarnessModelCatalog(
      accountProfileId: string,
      expectedGeneration: number,
    ) {
      calls.push(["readHarnessModelCatalog", {
        accountProfileId,
        expectedGeneration,
      }]);
      if (input.catalogError === true) {
        return Promise.reject(new Error("model catalog unavailable"));
      }
      return Promise.resolve({
        generation: input.catalogGeneration ?? expectedGeneration,
        evidenceDigest: input.catalogEvidenceDigest ??
          threadRequest.capabilityEvidenceDigest!,
        models: input.catalogModelId === undefined
          ? Object.freeze([
              Object.freeze({
                modelId: "gpt-5.6-sol",
                reasoningEfforts: Object.freeze(["ultra", "max"]),
                serviceTiers: Object.freeze(["standard", "fast"]),
              }),
              Object.freeze({
                modelId: "gpt-5.6-luna",
                reasoningEfforts: Object.freeze(["max"]),
                serviceTiers: Object.freeze(["standard", "fast"]),
              }),
            ])
          : Object.freeze([Object.freeze({
              modelId: input.catalogModelId,
              reasoningEfforts: Object.freeze(
                [...(input.catalogReasoningEfforts ?? [threadRequest.reasoningEffort])],
              ),
              serviceTiers: Object.freeze(
                [...(input.catalogServiceTiers ?? ["standard", "fast"])],
              ),
            })]),
      });
    },
    startHarnessActorThread(request: unknown) {
      calls.push(["startHarnessActorThread", request]);
      if (input.startThreadError === true) {
        return Promise.reject(new Error("gateway identity mismatch"));
      }
      return Promise.resolve({
        generation: (request as { expectedGeneration: number }).expectedGeneration,
        observedProfile: {
          modelId: (request as { model: "gpt-5.6-sol" | "gpt-5.6-luna" }).model,
          reasoningEffort: (request as { reasoningEffort: "ultra" | "max" })
            .reasoningEffort,
        },
        threadId: "thread_owned0001",
        providerThreadId: thread.id,
        projectId: "project_00000001",
        streamPosition: 10,
        workspaceLaneId: "workspace_000001",
      });
    },
    startHarnessActorTurn(request: unknown) {
      calls.push(["startHarnessActorTurn", request]);
      if (input.startTurnError === true) {
        return Promise.reject(new Error("gateway response lost"));
      }
      const turn = input.startTurn ?? rawTurn("inProgress");
      return Promise.resolve({
        generation: (request as { expectedGeneration: number }).expectedGeneration,
        providerTurnId: turn.id,
        quotaProof: "quotaProof" in turn
          ? turn.quotaProof ?? null
          : null,
        status: turn.status,
        streamPosition: 20,
        threadId: "thread_owned0001",
        turnId: "turn_owned000001",
      });
    },
    observeHarnessActorSessionRecoveryProof(request: unknown) {
      calls.push(["observeHarnessActorSessionRecoveryProof", request]);
      const value = request as {
        expectedGeneration: number;
        priorRecoveryProofDigest: string | null;
      };
      return Promise.resolve({
        recoveryProofDigest: "1".repeat(64),
        priorRecoveryProofDigest: value.priorRecoveryProofDigest,
        observationGeneration: value.expectedGeneration,
        historyEvidenceDigest: "2".repeat(64),
        firstObservationPosition: 1,
        secondObservationPosition: 2,
        historyTurnCount: 0,
        historyItemCount: 0,
      });
    },
    resumeHarnessActorThread() {
      return Promise.reject(new Error("unexpected actor thread resume"));
    },
    readHarnessActorChatAttachment() {
      return {
        threadId: "thread_owned0001",
        restartThreadId: thread.id,
      };
    },
    readHarnessActorContinuationHistory(request: unknown) {
      calls.push(["readHarnessActorContinuationHistory", request]);
      if (!sourceHistoryAvailable) {
        return Promise.reject(new Error("source generation is no longer registered"));
      }
      return Promise.resolve(continuationHistory);
    },
    injectHarnessActorContinuationHistory(request: unknown) {
      calls.push(["injectHarnessActorContinuationHistory", request]);
      if (input.injectionError === true) {
        return Promise.reject(new Error("empty injection response lost"));
      }
      return Promise.resolve({ generation: 9, streamPosition: 80 });
    },
    verifyHarnessActorContinuationHistory(request: unknown) {
      calls.push(["verifyHarnessActorContinuationHistory", request]);
      const historyDigest = (request as {
        history: { historyDigest: string };
      }).history.historyDigest;
      const readback = continuationReadbacks.shift() ??
        input.continuationReadback ?? "matched";
      if (readback === "mismatched") {
        return Promise.resolve({
          kind: "mismatched" as const,
          rawEvidenceDigest: "f".repeat(64),
          streamPosition: 90,
        });
      }
      if (readback === "empty") {
        return Promise.resolve({
          kind: "empty" as const,
          rawEvidenceDigest: "f".repeat(64),
          streamPosition: 90,
        });
      }
      if (readback === "unavailable") {
        return Promise.resolve({
          kind: "unavailable" as const,
          streamPosition: 90,
        });
      }
      return Promise.resolve({
        kind: "matched" as const,
        historyDigest,
        rawEvidenceDigest: "f".repeat(64),
        streamPosition: 90,
      });
    },
  };
  const requireIntent = (
    metadata: PersistentActorContinuationIntentMetadata,
    expectedRevision: number,
    expectedState?: PersistentActorContinuationIntent["state"],
  ): PersistentActorContinuationIntent => {
    const intentId = continuationIntentId(metadata);
    const intent = intents.get(intentId) ?? null;
    if (
      intent === null ||
      intent.intentId !== intentId ||
      intent.revision !== expectedRevision ||
      continuationIntentMetadataEvidence(intent) !==
        continuationIntentMetadataEvidence(metadata) ||
      (expectedState !== undefined && intent.state !== expectedState)
    ) throw new Error("continuation intent CAS lost");
    return intent;
  };
  const transitionIntent = (
    previous: PersistentActorContinuationIntent,
    state: PersistentActorContinuationIntent["state"],
    fields: Partial<PersistentActorContinuationIntent> = {},
  ): PersistentActorContinuationIntent => {
    const intent = Object.freeze({
      ...previous,
      ...fields,
      state,
      revision: previous.revision + 1,
    });
    intents.set(previous.intentId, intent);
    return intent;
  };
  if (input.continuationPredecessor !== undefined) {
    const predecessorMetadata = continuationMetadataAtGeneration(
      input.continuationPredecessor.targetProcessGeneration,
    );
    const state = input.continuationPredecessor.state;
    const revision = state === "prepared"
      ? 1
      : state === "injectionEffectStarted"
        ? 2
        : state === "injected"
          ? 3
          : state === "continueDispatchPrepared"
            ? 4
            : state === "continueDispatchEffectStarted"
              ? 5
              : 2;
    const exactReadbackDigest = [
      "injected",
      "continueDispatchPrepared",
      "continueDispatchEffectStarted",
    ].includes(state)
      ? predecessorMetadata.historyDigest
      : null;
    const intent: PersistentActorContinuationIntent = Object.freeze({
      ...predecessorMetadata,
      intentId: continuationIntentId(predecessorMetadata),
      state,
      revision,
      predecessorIntentId: null,
      recoveryProofDigest: state === "supersededApplied" ||
          state === "supersededNotApplied"
        ? "9".repeat(64)
        : null,
      exactReadbackDigest,
      absenceProofDigest: state === "continueDispatchEffectStarted"
        ? "8".repeat(64)
        : null,
      ambiguityCode: state === "ambiguous"
        ? "injection_readback_mismatch"
        : null,
    });
    intents.set(intent.intentId, intent);
  }
  const continuationIntents: PersistentActorContinuationIntentPort = {
    prepareInjection(metadata: PersistentActorContinuationIntentMetadata) {
      calls.push(["prepareInjection", metadata]);
      if (input.continuationIntentConflict === true) {
        const conflict = new Error("continuation identity conflicts");
        conflict.name = "PersistentActorContinuationSQLiteAuthorityV2Error";
        Object.assign(conflict, { code: "conflict" });
        return Promise.reject(conflict);
      }
      const intentId = continuationIntentId(metadata);
      const existing = intents.get(intentId) ?? null;
      if (existing !== null) {
        if (
          continuationIntentMetadataEvidence(existing) !==
          continuationIntentMetadataEvidence(metadata)
        ) throw new Error("continuation intent metadata changed");
        return Promise.resolve(existing);
      }
      const intent: PersistentActorContinuationIntent = Object.freeze({
        ...metadata,
        intentId,
        state: "prepared",
        revision: 1,
        predecessorIntentId: null,
        recoveryProofDigest: null,
        exactReadbackDigest: null,
        absenceProofDigest: null,
        ambiguityCode: null,
      });
      intents.set(intentId, intent);
      return Promise.resolve(intent);
    },
    readInjection(request) {
      calls.push(["readInjection", request]);
      if (input.continuationIntentConflict === true) {
        const conflict = new Error("continuation identity conflicts");
        conflict.name = "PersistentActorContinuationSQLiteAuthorityV2Error";
        Object.assign(conflict, { code: "conflict" });
        return Promise.reject(conflict);
      }
      const intent = intents.get(continuationIntentId(request.metadata)) ?? null;
      if (
        intent !== null &&
        continuationIntentMetadataEvidence(intent) !==
          continuationIntentMetadataEvidence(request.metadata)
      ) throw new Error("continuation intent metadata changed");
      return Promise.resolve(intent);
    },
    readLatestInjection(request) {
      calls.push(["readLatestInjection", request]);
      const candidates = [...intents.values()].filter((intent) =>
        intent.actorId === request.metadata.actorId &&
        intent.actorTurnId === request.metadata.actorTurnId &&
        intent.sourceAccountProfileId ===
          request.metadata.sourceAccountProfileId &&
        intent.sourceProcessGeneration ===
          request.metadata.sourceProcessGeneration &&
        intent.sourceProviderThreadId ===
          request.metadata.sourceProviderThreadId &&
        intent.sourceProviderTurnId ===
          request.metadata.sourceProviderTurnId
      ).toSorted((left, right) =>
        right.targetProcessGeneration - left.targetProcessGeneration
      );
      return Promise.resolve(candidates[0] ?? null);
    },
    markInjectionEffectStarted(request) {
      calls.push(["markInjectionEffectStarted", request]);
      const previous = requireIntent(
        request.metadata,
        request.expectedRevision,
        "prepared",
      );
      return Promise.resolve(transitionIntent(previous, "injectionEffectStarted"));
    },
    settleInjectionApplied(request) {
      calls.push(["settleInjectionApplied", request]);
      const previous = requireIntent(
        request.metadata,
        request.expectedRevision,
        "injectionEffectStarted",
      );
      return Promise.resolve(transitionIntent(previous, "injected", {
        exactReadbackDigest: request.exactReadbackDigest,
      }));
    },
    prepareContinueDispatch(request) {
      calls.push(["prepareContinueDispatch", request]);
      const previous = requireIntent(
        request.metadata,
        request.expectedRevision,
        "injected",
      );
      return Promise.resolve(transitionIntent(previous, "continueDispatchPrepared"));
    },
    markContinueDispatchEffectStarted(request) {
      calls.push(["markContinueDispatchEffectStarted", request]);
      const previous = requireIntent(
        request.metadata,
        request.expectedRevision,
        "continueDispatchPrepared",
      );
      if (rejectNextContinueDispatch) {
        rejectNextContinueDispatch = false;
        return Promise.reject(new Error("continue dispatch CAS unavailable"));
      }
      return Promise.resolve(transitionIntent(previous, "continueDispatchEffectStarted", {
        absenceProofDigest: request.absenceProofDigest,
      }));
    },
    fenceInjectionAmbiguous(request) {
      calls.push(["fenceInjectionAmbiguous", request]);
      const previous = requireIntent(request.metadata, request.expectedRevision);
      if (previous.state === "ambiguous") {
        throw new Error("continuation intent already ambiguous");
      }
      return Promise.resolve(transitionIntent(previous, "ambiguous", {
        ambiguityCode: request.proofCode,
      }));
    },
    supersedeForRecovery(request) {
      calls.push(["supersedeForRecovery", request]);
      const previous = requireIntent(
        request.predecessorMetadata,
        request.expectedRevision,
      );
      const predecessor = transitionIntent(previous, request.predecessorState, {
        recoveryProofDigest: request.recoveryProofDigest,
      });
      if (request.successorMetadata === null) {
        return Promise.resolve({ predecessor, successor: null });
      }
      const successor: PersistentActorContinuationIntent = Object.freeze({
        ...request.successorMetadata,
        intentId: continuationIntentId(request.successorMetadata),
        state: request.successorHistoryApplied ? "injected" : "prepared",
        revision: request.successorHistoryApplied ? 3 : 1,
        predecessorIntentId: previous.intentId,
        recoveryProofDigest: request.recoveryProofDigest,
        exactReadbackDigest: request.successorHistoryApplied
          ? request.successorMetadata.historyDigest
          : null,
        absenceProofDigest: null,
        ambiguityCode: null,
      });
      intents.set(successor.intentId, successor);
      return Promise.resolve({ predecessor, successor });
    },
  };
  const provider = new CodexPersistentActorProvider({
    commands: commands as unknown as CodexPersistentActorProviderOptions["commands"],
    sessions: sessions as unknown as CodexPersistentActorProviderOptions["sessions"],
    ...(input.runtimeGeneration !== undefined || input.runtimeError === true
      ? {
          sessionRuntimes: {
            ensureSessionRuntime(accountProfileId: string) {
              calls.push(["ensureSessionRuntime", accountProfileId]);
              return input.runtimeError === true
                ? Promise.reject(new Error("runtime unavailable"))
                : Promise.resolve({ generation: input.runtimeGeneration! });
            },
          },
        }
      : {}),
    workspaces: {
      resolveLane(laneId) {
        calls.push(["resolveLane", laneId]);
        return Promise.resolve(workspace);
      },
      resolveActor(actorId) {
        calls.push(["resolveActor", actorId]);
        return Promise.resolve(workspace);
      },
    },
    values: {
      readInput(value) {
        calls.push(["readInput", value]);
        return Promise.resolve("do the bounded task");
      },
      putResult(value) {
        calls.push(["putResult", value]);
        return Promise.resolve("ctxval_000000002");
      },
      putActorContinuationHistoryCapsule(value: Readonly<{
        epochId: string;
        actorId: string;
        actorTurnId: string;
        sourceAttemptId: string;
        historyDigest: string;
        items: readonly Readonly<{ role: "user" | "assistant"; text: string }>[];
      }>) {
        calls.push(["putActorContinuationHistoryCapsule", value]);
        if (input.capsulePutFailure === "transient") {
          return Promise.reject(new Error("encrypted store temporarily unavailable"));
        }
        if (
          input.capsulePutFailure === "corrupt_store" ||
          input.capsulePutFailure === "identity_conflict"
        ) {
          return Promise.reject(contextValueFailure(input.capsulePutFailure));
        }
        const handle = input.capsuleHandleMismatch === true
          ? Object.freeze({
              ...continuationCapsuleHandle,
              actorId: "hactor_mismatch0001",
            })
          : continuationCapsuleHandle;
        const historyUtf8Bytes = value.items.reduce(
          (total, item) => total + Buffer.byteLength(item.text, "utf8"),
          0,
        );
        capsules.set(handle.valueId, continuationCapsule({
          handle,
          historyDigest: value.historyDigest,
          itemCount: value.items.length,
          historyUtf8Bytes,
          containerUtf8Bytes: historyUtf8Bytes + 512,
          items: Object.freeze([...value.items]),
        }));
        return Promise.resolve(handle);
      },
      readActorContinuationHistoryCapsule(value: Readonly<{
        handle: Readonly<{
          version: 2;
          epochId: string;
          actorId: string;
          actorTurnId: string;
          sourceAttemptId: string;
          valueId: string;
        }>;
      }>) {
        calls.push(["readActorContinuationHistoryCapsule", value]);
        if (input.capsuleReadFailure === "transient") {
          return Promise.reject(new Error("encrypted store temporarily unavailable"));
        }
        if (
          input.capsuleReadFailure === "corrupt_store" ||
          input.capsuleReadFailure === "identity_conflict" ||
          input.capsuleReadFailure === "not_found"
        ) {
          return Promise.reject(contextValueFailure(input.capsuleReadFailure));
        }
        const capsule = capsules.get(value.handle.valueId);
        if (capsule === undefined) {
          return Promise.reject(contextValueFailure("not_found"));
        }
        if (JSON.stringify(capsule.handle) !== JSON.stringify(value.handle)) {
          return Promise.reject(contextValueFailure("identity_conflict"));
        }
        return Promise.resolve(input.capsuleTampered === true
          ? { ...capsule, historyDigest: "0".repeat(64) }
          : capsule);
      },
    },
    mutationFences: {
      read(value) {
        calls.push(["fence", value]);
        if (input.fenceError === true) {
          return Promise.reject(new Error("fence unavailable"));
        }
        return Promise.resolve(input.fence ?? {
          previousGenerationTerminated: false,
          exclusiveMutationLease: false,
          externalDeletionExcluded: false,
        });
      },
    },
    continuationIntents,
    tokenUsage: {
      readTurnUsage(value: unknown) {
        calls.push(["readTurnUsage", value]);
        return Promise.resolve(input.tokenUsage === undefined
          ? { inputTokens: 11, outputTokens: 7 }
          : input.tokenUsage);
      },
    },
    toolsetDigest,
    now: () => now,
  });
  return {
    calls,
    continuationIntent: () => intents.values().next().value ?? null,
    continuationIntents: () => [...intents.values()].toSorted((left, right) =>
      left.targetProcessGeneration - right.targetProcessGeneration
    ),
    provider,
    setSourceHistoryAvailable(value: boolean) {
      sourceHistoryAvailable = value;
    },
  };
}

describe("Codex persistent actor provider", () => {
  test("starts one exact paginated thread with no fork or steer surface", async () => {
    const { provider, calls } = fixture();
    const outcome = await provider.startThread(threadRequest);
    expect(outcome).toMatchObject({
      kind: "applied",
      providerThreadId: "provider-thread-1",
      observedProfile: {
        modelId: threadRequest.modelId,
        reasoningEffort: threadRequest.reasoningEffort,
      },
      liveCapabilityEvidence: {
        observationGeneration: threadRequest.processGeneration,
        evidenceDigest: threadRequest.capabilityEvidenceDigest,
        supportsFast: true,
      },
      proof: {
        phase: "postDispatch",
        definitive: true,
        observedAt: now.toISOString(),
      },
    });
    const call = calls.find(([name]) => name === "startHarnessActorThread")?.[1];
    expect(call).toMatchObject({
      accountProfileId: threadRequest.accountProfileId,
      actorId: threadRequest.actorId,
      expectedGeneration: threadRequest.processGeneration,
      model: "gpt-5.6-sol",
      reasoningEffort: "max",
      threadSource: threadRequest.threadSource,
      workspaceMode: "readOnly",
      workspacePath: workspace.checkoutPath,
    });
    expect((call as { developerInstructions: string }).developerInstructions)
      .toContain("Durable work class: standard.");
    expect((call as { developerInstructions: string }).developerInstructions)
      .not.toContain(threadRequest.actorId);
    expect(Object.keys(call as object)).not.toContain("fork");
    expect(Object.keys(call as object)).not.toContain("steer");
  });

  test("keeps a lost thread-start response reconcilable", async () => {
    const { provider } = fixture({
      startThreadError: true,
    });
    expect(await provider.startThread(threadRequest)).toMatchObject({
      kind: "pending",
      proof: { definitive: false, phase: "observation" },
    });
  });

  test("recovers a lost generation-N actor start with exact successor catalog evidence", async () => {
    const successorDigest = "a".repeat(64);
    const { provider, calls } = fixture({
      startThreadError: true,
      runtimeGeneration: 8,
      catalogEvidenceDigest: successorDigest,
      catalogModelId: threadRequest.modelId,
      catalogServiceTiers: ["standard"],
    });
    expect(await provider.startThread(threadRequest)).toMatchObject({
      kind: "pending",
    });

    expect(await provider.reconcileThread(threadRequest)).toMatchObject({
      kind: "applied",
      providerThreadId: "provider-thread-1",
      liveCapabilityEvidence: {
        observationGeneration: 8,
        evidenceDigest: successorDigest,
        supportsFast: false,
      },
      sessionRecoveryProof: { observationGeneration: 8 },
    });
    expect(calls.filter(([name]) => name === "readHarnessModelCatalog"))
      .toEqual([["readHarnessModelCatalog", {
        accountProfileId: threadRequest.accountProfileId,
        expectedGeneration: 8,
      }]]);
  });

  test("keeps unavailable catalogs pending and exact mismatches fail-closed", async () => {
    const unavailable = fixture({ catalogError: true });
    expect(await unavailable.provider.startThread(threadRequest)).toMatchObject({
      kind: "pending",
    });

    const missingModel = fixture({ catalogModelId: "gpt-5.6-luna" });
    expect(await missingModel.provider.startThread(threadRequest)).toMatchObject({
      kind: "ambiguous",
    });

    const missingEffort = fixture({
      catalogModelId: threadRequest.modelId,
      catalogReasoningEfforts: ["ultra"],
    });
    expect(await missingEffort.provider.startThread(threadRequest)).toMatchObject({
      kind: "ambiguous",
    });

    const changedSameGeneration = fixture({
      catalogEvidenceDigest: "a".repeat(64),
    });
    expect(await changedSameGeneration.provider.startThread(threadRequest))
      .toMatchObject({ kind: "ambiguous" });
  });

  test("replays exact catalog evidence idempotently and keeps v0 recovery catalog-free", async () => {
    const current = fixture();
    const first = await current.provider.reconcileThread(threadRequest);
    const replay = await current.provider.reconcileThread(threadRequest);
    expect(replay).toEqual(first);

    const legacy = fixture();
    const legacyRequest: PersistentActorThreadRequest = {
      ...threadRequest,
      policyVersion: 0,
      workClass: "legacyUnclassified",
      modelId: "gpt-5.6-sol",
      reasoningEffort: "ultra",
      selectedProfile: "solUltra",
      capabilityEvidenceDigest: null,
      supportsFast: false,
      toolsetDigest: HRA_RLM_PREDECESSOR_DYNAMIC_TOOL_SPEC_SHA256,
    };
    expect(await legacy.provider.reconcileThread(legacyRequest)).toMatchObject({
      kind: "applied",
      liveCapabilityEvidence: {
        observationGeneration: legacyRequest.processGeneration,
        evidenceDigest: null,
        supportsFast: null,
      },
    });
    expect(legacy.calls.filter(([name]) => name === "readHarnessModelCatalog"))
      .toEqual([]);
  });

  test("allows the predecessor toolset only for durable recovery", async () => {
    const { provider } = fixture();
    let failure: unknown;
    try {
      await provider.startThread({
        ...threadRequest,
        toolsetDigest: HRA_RLM_PREDECESSOR_DYNAMIC_TOOL_SPEC_SHA256,
      });
    } catch (cause: unknown) {
      failure = cause;
    }
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain("toolset identity changed");
    expect(await provider.reconcileThread({
      ...threadRequest,
      toolsetDigest: HRA_RLM_PREDECESSOR_DYNAMIC_TOOL_SPEC_SHA256,
    })).toMatchObject({ kind: "applied" });
  });

  test("keeps developer instructions cache-stable within a work class and profile", async () => {
    const { provider, calls } = fixture();
    await provider.startThread(threadRequest);
    await provider.startThread({
      ...threadRequest,
      actorId: "hactor_000000002",
      clientRequestId: "request_00000002",
      threadSource: "oprte-actor-hactor_000000002",
    });
    const instructions = calls
      .filter(([name]) => name === "startHarnessActorThread")
      .map(([, value]) => (value as { developerInstructions: string })
        .developerInstructions);
    expect(instructions).toHaveLength(2);
    expect(instructions[0]).toBe(instructions[1]);
    expect(instructions[0]).not.toContain("hactor_");
  });

  test("makes bounded-leaf non-delegation explicit in stable instructions", async () => {
    const { provider, calls } = fixture();
    await provider.startThread({
      ...threadRequest,
      workClass: "boundedLeaf",
      modelId: "gpt-5.6-luna",
      selectedProfile: "lunaMax",
    });
    const instructions = (calls.find(([name]) =>
      name === "startHarnessActorThread")?.[1] as {
        developerInstructions: string;
      }).developerInstructions;
    expect(instructions).toContain(
      "solve this bounded leaf directly; do not dispatch another actor",
    );
  });

  test("starts a later turn only after loading its exact encrypted input", async () => {
    const { provider, calls } = fixture();
    expect(await provider.startTurn(turnRequest)).toMatchObject({
      kind: "applied",
      providerTurnId: "provider-turn-1",
      proof: { phase: "postDispatch", definitive: true },
    });
    expect(calls.find(([name]) => name === "readInput")?.[1]).toEqual({
      epochId: turnRequest.epochId,
      actorId: turnRequest.actorId,
      turnId: turnRequest.turnId,
      valueId: turnRequest.inputValueId,
    });
    expect(calls.find(([name]) => name === "startHarnessActorTurn")?.[1]).toMatchObject({
      actorId: turnRequest.actorId,
      expectedGeneration: 7,
      clientUserMessageId: turnRequest.clientUserMessageId,
      model: "gpt-5.6-sol",
      prompt: "do the bounded task",
      reasoningEffort: "max",
      serviceTier: "standard",
      thread: {
        accountProfileId: turnRequest.accountProfileId,
        kind: "provider",
        providerThreadId: turnRequest.providerThreadId,
      },
    });
  });

  test("keeps a lost turn-start response reconcilable", async () => {
    const { provider } = fixture({ startTurnError: true });
    expect(await provider.startTurn(turnRequest)).toMatchObject({
      kind: "pending",
      proof: { definitive: false, phase: "observation" },
    });
  });

  test("passes Fast only with exact durable critical-path reservation evidence", async () => {
    const { provider, calls } = fixture();
    const fastRequest: PersistentActorTurnRequest = {
      ...turnRequest,
      requestedAcceleration: {
        mode: "fast",
        criticalPath: true,
        bottleneck: "reasoning",
      },
      serviceTier: "fast",
      fastReservationId: "hfast_00000000000001",
    };
    expect(await provider.startTurn(fastRequest)).toMatchObject({
      kind: "applied",
    });
    expect(calls.find(([name]) => name === "startHarnessActorTurn")?.[1])
      .toMatchObject({ serviceTier: "fast" });

    let failure: unknown;
    try {
      await provider.startTurn({ ...fastRequest, fastReservationId: null });
    } catch (cause: unknown) {
      failure = cause;
    }
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain("tier evidence is invalid");
  });

  test("separates immutable effect generation from live observation generation", async () => {
    const value = fixture();
    const recoveredRequest = {
      ...turnRequest,
      observationGeneration: 8,
    };
    expect(await value.provider.startTurn(recoveredRequest)).toMatchObject({
      kind: "ambiguous",
    });
    expect(value.calls.filter(([name]) => name === "startHarnessActorTurn"))
      .toHaveLength(0);

    expect(await value.provider.reconcileTurn(recoveredRequest)).toMatchObject({
      kind: "applied",
      providerTurnId: "provider-turn-1",
    });
    for (const call of value.calls.filter(([name]) =>
      name === "threadTurnsList" || name === "threadItemsList"
    )) expect(call[1]).toMatchObject({ expectedGeneration: 8 });
    expect(value.calls.find(([name]) => name === "fence")?.[1]).toMatchObject({
      processGeneration: 7,
    });

    const terminal = await value.provider.observeTurn({
      ...recoveredRequest,
      providerTurnId: "provider-turn-1",
    });
    expect(terminal).toMatchObject({
      terminal: "completed",
      processGeneration: 8,
    });
    expect(value.calls.find(([name]) => name === "readTurnUsage")?.[1])
      .toMatchObject({
        accountProfileId: turnRequest.accountProfileId,
        observationGeneration: 8,
        providerThreadId: "provider-thread-1",
        providerTurnId: "provider-turn-1",
      });
  });

  test("releases quarantined Fast capacity only behind stable successor absence", async () => {
    const value = fixture({
      runtimeGeneration: 8,
      turnScanTurns: [[], []],
      fence: completeMutationFence,
    });
    const outcome = await value.provider.reconcileQuarantinedFastCapacity(
      quarantinedFastTurnRequest,
    );
    expect(outcome).toMatchObject({
      kind: "releasable",
      successorGeneration: 8,
      proof: {
        definitive: true,
        phase: "observation",
        observedAt: now.toISOString(),
      },
    });
    const emptyScanDigest = pinnedCodexTurnScanEvidenceDigest({
      complete: true,
      threadId: quarantinedFastTurnRequest.providerThreadId,
      turns: [],
    });
    expect(outcome.proof.digest).toBe(persistentActorDigest(
      "proof",
      "fast-capacity-reconciliation",
      quarantinedFastTurnRequest.effectKey,
      "releasable",
      "7",
      "8",
      quarantinedFastTurnRequest.providerThreadId,
      quarantinedFastTurnRequest.clientUserMessageId,
      emptyScanDigest,
      emptyScanDigest,
      "true",
      "true",
      "true",
      "provider-turn-unavailable",
      "provider-turn-status-unavailable",
    ));
    expect(value.calls.find(([name]) => name === "fence")?.[1]).toMatchObject({
      accountProfileId: quarantinedFastTurnRequest.accountProfileId,
      processGeneration: 7,
      effectKey: quarantinedFastTurnRequest.effectKey,
    });
    for (const call of value.calls.filter(([name]) =>
      name === "threadTurnsList" || name === "threadItemsList"
    )) {
      expect(call[1]).toMatchObject({ expectedGeneration: 8 });
      expect(call[1]).toMatchObject({
        command: { threadId: quarantinedFastTurnRequest.providerThreadId },
      });
    }
    expect(value.calls.filter(([name]) =>
      name === "startHarnessActorTurn" ||
      name === "turnInterrupt" ||
      name === "injectHarnessActorContinuationHistory"
    )).toHaveLength(0);
  });

  test("consumes quarantined Fast capacity when the exact effect is terminal", async () => {
    const value = fixture({
      runtimeGeneration: 8,
      observedTurn: rawTurn("completed"),
      items: [userItem(), finalItem()],
      fence: {
        previousGenerationTerminated: false,
        exclusiveMutationLease: false,
        externalDeletionExcluded: false,
      },
    });
    expect(await value.provider.reconcileQuarantinedFastCapacity(
      quarantinedFastTurnRequest,
    )).toMatchObject({
      kind: "consumable",
      successorGeneration: 8,
      providerTurnId: "provider-turn-1",
      terminal: "completed",
      proof: { definitive: true, phase: "observation" },
    });
  });

  test("holds Fast capacity without a strict successor generation", async () => {
    const value = fixture({
      runtimeGeneration: 7,
      fence: completeMutationFence,
    });
    expect(await value.provider.reconcileQuarantinedFastCapacity(
      quarantinedFastTurnRequest,
    )).toMatchObject({
      kind: "held",
      reason: "successorGenerationUnavailable",
      successorGeneration: 7,
      proof: { definitive: false },
    });
    expect(value.calls.filter(([name]) =>
      name === "threadTurnsList" || name === "threadItemsList"
    )).toHaveLength(0);
  });

  test("holds Fast capacity on incomplete or unstable successor scans", async () => {
    const incomplete = fixture({
      runtimeGeneration: 8,
      incompleteTurnScan: true,
      fence: completeMutationFence,
    });
    expect(await incomplete.provider.reconcileQuarantinedFastCapacity(
      quarantinedFastTurnRequest,
    )).toMatchObject({ kind: "held", reason: "incompleteScan" });

    const first = rawTurn("completed");
    const second = rawTurn("failed");
    const unstable = fixture({
      runtimeGeneration: 8,
      turnScanTurns: [[first], [second]],
      fence: completeMutationFence,
    });
    expect(await unstable.provider.reconcileQuarantinedFastCapacity(
      quarantinedFastTurnRequest,
    )).toMatchObject({ kind: "held", reason: "unstableScan" });
  });

  test("holds Fast capacity on duplicate turn, item, or client identities", async () => {
    const turn = rawTurn("completed");
    const duplicateTurn = fixture({
      runtimeGeneration: 8,
      turnScanTurns: [[turn, turn], [turn, turn]],
      fence: completeMutationFence,
    });
    expect(await duplicateTurn.provider.reconcileQuarantinedFastCapacity(
      quarantinedFastTurnRequest,
    )).toMatchObject({ kind: "held", reason: "duplicateTurn" });

    const duplicateItem = fixture({
      runtimeGeneration: 8,
      items: [userItem(), userItem()],
      fence: completeMutationFence,
    });
    expect(await duplicateItem.provider.reconcileQuarantinedFastCapacity(
      quarantinedFastTurnRequest,
    )).toMatchObject({ kind: "held", reason: "duplicateItem" });

    const otherTurn = rawTurn("completed", { id: "provider-turn-2" });
    const duplicateClient = fixture({
      runtimeGeneration: 8,
      turnScanTurns: [[turn, otherTurn], [turn, otherTurn]],
      itemsByTurn: {
        "provider-turn-1": [userItem()],
        "provider-turn-2": [{
          ...userItem(),
          id: "item-user-2",
        }],
      },
      fence: completeMutationFence,
    });
    expect(await duplicateClient.provider.reconcileQuarantinedFastCapacity(
      quarantinedFastTurnRequest,
    )).toMatchObject({
      kind: "held",
      reason: "duplicateClientMessageId",
    });
  });

  test("holds Fast capacity while the exact applied turn remains live", async () => {
    const value = fixture({
      runtimeGeneration: 8,
      observedTurn: rawTurn("inProgress"),
      items: [userItem()],
      fence: completeMutationFence,
    });
    expect(await value.provider.reconcileQuarantinedFastCapacity(
      quarantinedFastTurnRequest,
    )).toMatchObject({
      kind: "held",
      reason: "matchingTurnInProgress",
      successorGeneration: 8,
      proof: { definitive: false },
    });
  });

  test("holds stable absence until all mutation-fence facts are complete", async () => {
    const value = fixture({
      runtimeGeneration: 8,
      turnScanTurns: [[], []],
      fence: {
        previousGenerationTerminated: true,
        exclusiveMutationLease: true,
        externalDeletionExcluded: false,
      },
    });
    expect(await value.provider.reconcileQuarantinedFastCapacity(
      quarantinedFastTurnRequest,
    )).toMatchObject({
      kind: "held",
      reason: "mutationFenceIncomplete",
      successorGeneration: 8,
    });
  });

  test("holds capacity when runtime, scan, or fence evidence is unavailable", async () => {
    const runtime = fixture({ runtimeError: true, fence: completeMutationFence });
    expect(await runtime.provider.reconcileQuarantinedFastCapacity(
      quarantinedFastTurnRequest,
    )).toMatchObject({ kind: "held", reason: "runtimeUnavailable" });

    const scan = fixture({
      runtimeGeneration: 8,
      turnScanError: true,
      fence: completeMutationFence,
    });
    expect(await scan.provider.reconcileQuarantinedFastCapacity(
      quarantinedFastTurnRequest,
    )).toMatchObject({ kind: "held", reason: "scanUnavailable" });

    const fence = fixture({ runtimeGeneration: 8, fenceError: true });
    expect(await fence.provider.reconcileQuarantinedFastCapacity(
      quarantinedFastTurnRequest,
    )).toMatchObject({ kind: "held", reason: "mutationFenceUnavailable" });
  });

  test("treats a directly returned quota turn as admitted", async () => {
    const quotaTurn = rawTurn("failed", {
      quotaProof: "provider_usage_limit_exceeded" as const,
    });
    const { provider } = fixture({ startTurn: quotaTurn });
    expect(await provider.startTurn(turnRequest)).toMatchObject({
      kind: "applied",
      providerTurnId: "provider-turn-1",
      proof: { phase: "postDispatch", definitive: true },
    });
  });

  test("treats a reconciled quota turn as admitted instead of replayable", async () => {
    const quotaTurn = rawTurn("failed", {
      quotaProof: "provider_usage_limit_exceeded" as const,
    });
    const { provider, calls } = fixture({
      observedTurn: quotaTurn,
      items: [userItem()],
    });
    expect(await provider.reconcileTurn(turnRequest)).toMatchObject({
      kind: "applied",
      providerTurnId: "provider-turn-1",
      proof: { phase: "observation", definitive: true },
    });
    expect(calls.filter(([name]) => name === "startHarnessActorTurn")).toHaveLength(0);
  });

  test("rejects legacy quota continuation before any provider or value operation", async () => {
    const value = fixture();
    for (const invoke of [
      () => value.provider.startTurn(continuationTurnRequest),
      () => value.provider.reconcileTurn(continuationTurnRequest),
      () => value.provider.observeTurn({
        ...continuationTurnRequest,
        providerTurnId: "provider-turn-legacy-continuation",
      }),
    ]) {
      let caught: unknown = null;
      try {
        await invoke();
      } catch (error: unknown) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(Error);
      expect((caught as Error).message).toBe(
        "provider quota continuation is disabled",
      );
    }
    expect(value.calls).toEqual([]);
  });

  test("double-scans thread and turn identities before reconciliation", async () => {
    const { provider, calls } = fixture();
    expect(await provider.reconcileThread(threadRequest)).toMatchObject({
      kind: "applied",
      providerThreadId: "provider-thread-1",
      observedProfile: {
        modelId: threadRequest.modelId,
        reasoningEffort: threadRequest.reasoningEffort,
      },
    });
    expect(calls.filter(([name]) => name === "threadList")).toHaveLength(4);

    expect(await provider.reconcileTurn(turnRequest)).toMatchObject({
      kind: "applied",
      providerTurnId: "provider-turn-1",
    });
    expect(calls.filter(([name]) => name === "threadTurnsList")).toHaveLength(2);
    expect(calls.filter(([name]) => name === "threadItemsList")).toHaveLength(2);
  });

  test("does not classify absence as safe until the full mutation fence exists", async () => {
    const missingThread = rawThread({ threadSource: "other" });
    const pending = fixture({ thread: missingThread });
    expect(await pending.provider.reconcileThread(threadRequest)).toMatchObject({
      kind: "pending",
    });

    const absentCommands = fixture({
      fence: {
        previousGenerationTerminated: true,
        exclusiveMutationLease: true,
        externalDeletionExcluded: true,
      },
    });
    // A different exact identity is ambiguous, never absence. This assertion
    // preserves the distinction that prevents unsafe retry.
    expect(await absentCommands.provider.reconcileThread({
      ...threadRequest,
      threadSource: "unseen-source",
    })).toMatchObject({ kind: "notApplied", reason: "notFound" });
  });

  test("seals only final-answer text for a completed turn", async () => {
    const { provider, calls } = fixture({
      items: [
        userItem(),
        commentaryItem(),
        finalItem("final result"),
      ],
    });
    const observationRequest: PersistentActorTurnObservationRequest = {
      ...turnRequest,
      providerTurnId: "provider-turn-1",
    };
    const observed = await provider.observeTurn(observationRequest);
    expect(observed).toMatchObject({
      terminal: "completed",
      resultValueId: "ctxval_000000002",
      outcomeCode: "completed",
      quotaProof: null,
    });
    expect(calls.find(([name]) => name === "putResult")?.[1]).toMatchObject({
      epochId: turnRequest.epochId,
      actorId: turnRequest.actorId,
      turnId: turnRequest.turnId,
      plaintext: "final result",
    });
  });

  test("holds a terminal scan pending until exact per-turn usage is durable", async () => {
    const { provider } = fixture({ tokenUsage: null });
    expect(await provider.observeTurn({ ...turnRequest, providerTurnId: "provider-turn-1" }))
      .toMatchObject({ kind: "pending" });
  });

  test("carries an explicit discriminator on terminal usage-limit evidence", async () => {
    const { provider } = fixture({
      observedTurn: rawTurn("failed", {
        quotaProof: "provider_usage_limit_exceeded" as const,
      }),
      items: [userItem()],
    });
    expect(await provider.observeTurn({
      ...turnRequest,
      providerTurnId: "provider-turn-1",
    })).toMatchObject({
      terminal: "failed",
      outcomeCode: "usage_limit_exceeded",
      quotaProof: "provider_usage_limit_exceeded",
      inputTokens: 11,
      outputTokens: 7,
    });
  });

  test("interrupt mutation stays at admission while recovery scans the live generation", async () => {
    const { provider, calls } = fixture({
      observedTurn: rawTurn("interrupted"),
    });
    expect(await provider.interruptTurn(interruptRequest)).toMatchObject({
      kind: "applied",
      providerTurnId: interruptRequest.providerTurnId,
      proof: { phase: "postDispatch" },
    });
    expect(await provider.reconcileInterrupt(interruptRequest)).toMatchObject({
      kind: "applied",
      providerTurnId: interruptRequest.providerTurnId,
      proof: { phase: "observation" },
    });
    const recovered = { ...interruptRequest, observationGeneration: 8 };
    expect(await provider.interruptTurn(recovered)).toMatchObject({
      kind: "ambiguous",
    });
    expect(calls.filter(([name]) => name === "turnInterrupt"))
      .toHaveLength(1);
    expect(await provider.reconcileInterrupt(recovered)).toMatchObject({
      kind: "applied",
      providerTurnId: interruptRequest.providerTurnId,
    });
    for (const call of calls.filter(([name]) =>
      name === "threadTurnsList" || name === "threadItemsList"
    ).slice(-4)) expect(call[1]).toMatchObject({ expectedGeneration: 8 });
  });
});

describe("persistent actor account routing", () => {
  const routeInput = {
    epochId: "hepoch_account_routing01",
    actorId: "hactor_account_routing01",
    workClass: "standard" as const,
  };

  test("ranks exact-profile accounts by budget, headroom, then active load", async () => {
    const adapter = routingAdapter({
      accounts: [
        accountCandidate("acct_low000001", "low", 95, true),
        accountCandidate("acct_healthy3", "healthy", 90, false),
        accountCandidate("acct_healthy2", "healthy", 90, false),
        accountCandidate("acct_healthy1", "healthy", 75, true),
        accountCandidate("acct_exhausted", "exhausted", 0, false),
      ],
      activeLoads: { acct_healthy1: 0, acct_healthy2: 1, acct_healthy3: 0 },
    });
    const result = await adapter.listEligibleAccounts(routeInput);
    expect(result.candidates.map(({ accountProfileId }) => accountProfileId))
      .toEqual([
        "acct_healthy3",
        "acct_healthy2",
        "acct_healthy1",
        "acct_low000001",
      ]);
    expect(result.candidates[0]).toMatchObject({
      activeTurnCount: 0,
      modelId: "gpt-5.6-sol",
      profileFallbackReason: null,
      reasoningEffort: "max",
      remainingPercent: 90,
      routingPriority: {
        budgetRank: 0,
        profileFallbackRank: 0,
        remainingHeadroomRank: 10,
      },
      selectedProfile: "solMax",
      supportsFast: true,
    });
    expect(result.temporarilyUnavailableAccountProfileIds).toEqual([]);
    expect(result.unsupportedAccountProfileIds).toEqual([]);
  });

  test("uses Sol Max only as the explicit bounded-leaf Luna fallback", async () => {
    const adapter = routingAdapter({
      accounts: [accountCandidate("acct_fallback01", "healthy", 80, true)],
      catalogs: {
        acct_fallback01: [modelCapability("gpt-5.6-sol", ["max"], true)],
      },
    });
    const result = await adapter.listEligibleAccounts({
      ...routeInput,
      workClass: "boundedLeaf",
    });
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]).toMatchObject({
      modelId: "gpt-5.6-sol",
      reasoningEffort: "max",
      selectedProfile: "solMax",
      profileFallbackReason: "lunaUnavailable",
    });
  });

  test("separates temporary runtime gaps from exact unsupported catalogs", async () => {
    const adapter = routingAdapter({
      accounts: [
        accountCandidate("acct_noruntime", "unknown", null, false),
        accountCandidate("acct_incapable", "healthy", 80, true),
        accountCandidate("acct_unsupported", "healthy", 80, false),
        accountCandidate("acct_capable01", "healthy", 80, false),
      ],
      catalogs: {
        acct_unsupported: [modelCapability("gpt-4.1", ["high"], false)],
      },
      noRuntime: ["acct_noruntime"],
      noDynamicTool: ["acct_incapable"],
    });
    const result = await adapter.listEligibleAccounts(routeInput);
    expect(result.candidates.map(({ accountProfileId }) => accountProfileId))
      .toEqual(["acct_capable01"]);
    expect(result.temporarilyUnavailableAccountProfileIds)
      .toEqual(["acct_incapable", "acct_noruntime"]);
    expect(result.unsupportedAccountProfileIds).toEqual(["acct_unsupported"]);
  });

  test("rejects duplicate subscription identities instead of collapsing evidence", async () => {
    const adapter = routingAdapter({
      accounts: [
        accountCandidate("acct_duplicate", "healthy", 90, true),
        accountCandidate("acct_duplicate", "low", 10, false),
      ],
    });
    let failure: unknown;
    try {
      await adapter.listEligibleAccounts(routeInput);
    } catch (cause: unknown) {
      failure = cause;
    }
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain(
      "routing identities are not unique",
    );
  });
});

function accountCandidate(
  id: string,
  budget: "healthy" | "low" | "exhausted" | "unknown",
  remainingPercent: number | null,
  selected: boolean,
) {
  return { id, budget, remainingPercent, selected } as const;
}

function modelCapability(
  modelId: string,
  reasoningEfforts: readonly string[],
  supportsFast: boolean,
) {
  return Object.freeze({
    modelId,
    reasoningEfforts: Object.freeze([...reasoningEfforts]),
    serviceTiers: Object.freeze(supportsFast ? ["fast"] : []),
  });
}

function routingAdapter(input: Readonly<{
  accounts: readonly ReturnType<typeof accountCandidate>[];
  activeLoads?: Readonly<Record<string, number>>;
  catalogs?: Readonly<Record<string,
    readonly ReturnType<typeof modelCapability>[]>>;
  noRuntime?: readonly string[];
  noDynamicTool?: readonly string[];
}>): CodexPersistentActorAccountAdapter {
  const generation = 7;
  return new CodexPersistentActorAccountAdapter({
    accounts: {
      refreshChatAccountCandidates: () => Promise.resolve(input.accounts),
    },
    authority: {
      readActiveActorAccountLoad: ({ accountProfileId }) =>
        input.activeLoads?.[accountProfileId] ?? 0,
    },
    runtimes: {
      generation: (accountProfileId) =>
        input.noRuntime?.includes(accountProfileId) === true ? null : generation,
      supportsDynamicTool: (accountProfileId) =>
        input.noDynamicTool?.includes(accountProfileId) !== true,
    },
    sessions: {
      readHarnessModelCatalog: (accountProfileId, expectedGeneration) =>
        Promise.resolve({
          evidenceDigest: createHash("sha256").update(accountProfileId).digest("hex"),
          generation: expectedGeneration,
          models: input.catalogs?.[accountProfileId] ?? [
            modelCapability("gpt-5.6-sol", ["max", "ultra"], true),
            modelCapability("gpt-5.6-luna", ["max"], true),
          ],
        }),
    },
  });
}
