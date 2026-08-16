import type {
  CodexFact,
  CodexFactOrigin,
  CodexItemSnapshot,
  CodexThreadSnapshot,
  CodexToolActivity,
  CodexTurnSnapshot,
} from "./facts";
import {
  MAX_CODEX_FACT_ENCODED_BYTES,
  codexServerRequestResolutionKey,
} from "./facts";
import type {
  CodexNotification,
  PinnedCodexThread,
  PinnedCodexThreadItem,
  PinnedCodexTurn,
} from "./pinned-protocol";
import { boundedCodexDisplayText } from "./safe-display";

export interface FactProjectionContext {
  readonly accountProfileId: string;
  readonly generation: number;
  readonly origin: CodexFactOrigin;
  readonly streamPosition: number;
}

export interface CodexFactResponseContext {
  readonly accountProfileId: string;
  readonly generation: number;
  readonly origin: Extract<CodexFactOrigin, "reconciled" | "snapshot">;
  readonly streamPosition: number;
}

export interface CodexThreadFactInput {
  readonly archived: boolean;
  readonly thread: PinnedCodexThread;
  readonly turns: "metadata_only" | "present";
}

type FactMetadataKey =
  | "accountProfileId"
  | "encodedBytes"
  | "factIndex"
  | "generation"
  | "origin"
  | "streamPosition";
export type CodexFactPayload = CodexFact extends infer Fact
  ? Fact extends CodexFact
    ? Omit<Fact, FactMetadataKey>
    : never
  : never;

export class CodexFactProjectionError extends Error {
  constructor() {
    super("A parsed Codex value could not be represented as an owned fact.");
    this.name = "CodexFactProjectionError";
  }
}

/**
 * Converts an already strict, pinned notification into the one owned fact
 * stream. Empty output is an explicit semantic discard, never a parse retry.
 */
export function projectCodexNotificationFacts(
  accountProfileId: string,
  notification: CodexNotification,
): readonly CodexFact[] {
  const context: FactProjectionContext = {
    accountProfileId,
    generation: notification.generation,
    origin: "live",
    streamPosition: notification.streamPosition,
  };
  switch (notification.method) {
    case "thread/started":
      return facts(context, [{
        type: "thread.snapshot",
        thread: projectCodexThreadSnapshot(notification.params.thread, {
          archived: false,
          turns: "present",
        }),
      }]);
    case "thread/archived":
      return facts(context, [{
        type: "thread.archived",
        archived: true,
        threadId: notification.params.threadId,
      }]);
    case "thread/unarchived":
      return facts(context, [{
        type: "thread.archived",
        archived: false,
        threadId: notification.params.threadId,
      }]);
    case "thread/deleted":
      return facts(context, [{
        type: "thread.deleted",
        threadId: notification.params.threadId,
      }]);
    case "thread/closed":
      return facts(context, [{
        type: "thread.status_changed",
        status: "not_loaded",
        threadId: notification.params.threadId,
      }]);
    case "thread/name/updated":
      return facts(context, [{
        type: "thread.title_changed",
        threadId: notification.params.threadId,
        title: notification.params.threadName,
      }]);
    case "thread/status/changed":
      return facts(context, [{
        type: "thread.status_changed",
        status: threadStatus(notification.params.status),
        threadId: notification.params.threadId,
      }]);
    case "turn/started":
      return facts(context, [{
        type: "turn.started",
        startedAt: timestamp(notification.params.turn.startedAt),
        threadId: notification.params.threadId,
        turnId: notification.params.turn.id,
      }, {
        type: "turn.snapshot",
        threadId: notification.params.threadId,
        turn: projectCodexTurnSnapshot(notification.params.turn),
      }]);
    case "turn/completed":
      return facts(context, [{
        type: "turn.snapshot",
        threadId: notification.params.threadId,
        turn: projectCodexTurnSnapshot(notification.params.turn),
      }, {
        type: "turn.completed",
        completedAt: requiredTimestamp(notification.params.turn.completedAt),
        status: completedTurnStatus(notification.params.turn.status),
        threadId: notification.params.threadId,
        turnId: notification.params.turn.id,
      }]);
    case "thread/tokenUsage/updated":
      return facts(context, [{
        type: "turn.token_usage",
        threadId: notification.params.threadId,
        turnId: notification.params.turnId,
        cumulativeCachedInputTokens:
          notification.params.tokenUsage.total.cachedInputTokens,
        cumulativeInputTokens: notification.params.tokenUsage.total.inputTokens,
        cumulativeOutputTokens: notification.params.tokenUsage.total.outputTokens,
        cumulativeReasoningOutputTokens:
          notification.params.tokenUsage.total.reasoningOutputTokens,
        cachedInputTokens: notification.params.tokenUsage.last.cachedInputTokens,
        inputTokens: notification.params.tokenUsage.last.inputTokens,
        outputTokens: notification.params.tokenUsage.last.outputTokens,
        reasoningOutputTokens:
          notification.params.tokenUsage.last.reasoningOutputTokens,
      }]);
    case "turn/plan/updated":
      return facts(context, [{
        type: "turn.activity",
        activity: "planning",
        threadId: notification.params.threadId,
        turnId: notification.params.turnId,
      }]);
    case "item/fileChange/patchUpdated":
      return facts(context, [{
        type: "turn.activity",
        activity: "editing",
        threadId: notification.params.threadId,
        turnId: notification.params.turnId,
      }]);
    case "item/started": {
      const started = projectStartedItem(notification.params.item);
      return started === null
        ? Object.freeze([])
        : facts(context, [{
            type: "item.started",
            ...started,
            threadId: notification.params.threadId,
            turnId: notification.params.turnId,
          }]);
    }
    case "item/completed": {
      const item = projectCodexItemSnapshot(notification.params.item);
      return facts(context, [{
        type: "item.completed",
        item,
        threadId: notification.params.threadId,
        turnId: notification.params.turnId,
      }]);
    }
    case "item/agentMessage/delta":
      {
        const display = boundedCodexDisplayText(notification.params.delta);
      return facts(context, [{
        type: "item.delta",
        channel: "assistant_text",
        delta: display.text,
        itemId: notification.params.itemId,
        threadId: notification.params.threadId,
        truncated: display.truncated,
        turnId: notification.params.turnId,
      }]);
      }
    case "item/reasoning/summaryTextDelta":
      {
        const display = boundedCodexDisplayText(notification.params.delta);
      return facts(context, [{
        type: "item.delta",
        channel: "reasoning_summary",
        delta: display.text,
        itemId: notification.params.itemId,
        threadId: notification.params.threadId,
        truncated: display.truncated,
        turnId: notification.params.turnId,
      }]);
      }
    case "account/updated":
      return facts(context, [{
        type: "account.profile_updated",
        plan: notification.params.planType,
        signedIn: notification.params.authMode !== null,
      }]);
    case "account/login/completed":
      return facts(context, [{
        type: "account.login_completed",
        loginId: notification.params.loginId,
        success: notification.params.success,
      }]);
    case "account/rateLimits/updated":
      return facts(context, [{
        type: "account.rate_limits_updated",
        rateLimits: notification.params.rateLimits,
      }]);
    case "serverRequest/resolved":
      return facts(context, [{
        type: "server_request.resolved",
        requestKey: codexServerRequestResolutionKey(
          accountProfileId,
          notification.generation,
          notification.params.requestId,
        ),
        threadId: notification.params.threadId,
      }]);
    case "model/rerouted":
      return facts(context, [{
        type: "turn.model_rerouted",
        fromModel: notification.params.fromModel,
        reason: notification.params.reason,
        threadId: notification.params.threadId,
        toModel: notification.params.toModel,
        turnId: notification.params.turnId,
      }]);
    case "app/list/updated":
    case "command/exec/outputDelta":
    case "configWarning":
    case "deprecationNotice":
    case "error":
    case "externalAgentConfig/import/completed":
    case "externalAgentConfig/import/progress":
    case "fs/changed":
    case "fuzzyFileSearch/sessionCompleted":
    case "fuzzyFileSearch/sessionUpdated":
    case "guardianWarning":
    case "hook/completed":
    case "hook/started":
    case "item/autoApprovalReview/completed":
    case "item/autoApprovalReview/started":
    case "item/commandExecution/outputDelta":
    case "item/commandExecution/terminalInteraction":
    case "item/fileChange/outputDelta":
    case "item/mcpToolCall/progress":
    case "item/plan/delta":
    case "item/reasoning/summaryPartAdded":
    case "item/reasoning/textDelta":
    case "mcpServer/oauthLogin/completed":
    case "mcpServer/startupStatus/updated":
    case "model/safetyBuffering/updated":
    case "model/verification":
    case "process/exited":
    case "process/outputDelta":
    case "rawResponseItem/completed":
    case "remoteControl/status/changed":
    case "skills/changed":
    case "thread/compacted":
    case "thread/goal/cleared":
    case "thread/goal/updated":
    case "thread/realtime/closed":
    case "thread/realtime/error":
    case "thread/realtime/itemAdded":
    case "thread/realtime/outputAudio/delta":
    case "thread/realtime/sdp":
    case "thread/realtime/started":
    case "thread/realtime/transcript/delta":
    case "thread/realtime/transcript/done":
    case "thread/settings/updated":
    case "turn/diff/updated":
    case "turn/moderationMetadata":
    case "warning":
    case "windows/worldWritableWarning":
    case "windowsSandbox/setupCompleted":
      return Object.freeze([]);
  }
}

/** Creates positioned owned runtime facts while preserving one encoding policy. */
export function createCodexFactsAtPosition(
  context: FactProjectionContext,
  payloads: readonly CodexFactPayload[],
  factIndexOffset = 0,
): readonly CodexFact[] {
  if (!Number.isSafeInteger(factIndexOffset) || factIndexOffset < 0) {
    throw new CodexFactProjectionError();
  }
  return facts(context, payloads, factIndexOffset);
}

/** Projects one positioned response envelope into an ordered fact batch. */
export function projectCodexThreadResponseFacts(
  context: CodexFactResponseContext,
  inputs: readonly CodexThreadFactInput[],
): readonly CodexFact[] {
  return facts(context, inputs.map(({ archived, thread, turns }) => ({
    type: "thread.snapshot" as const,
    thread: projectCodexThreadSnapshot(thread, { archived, turns }),
  })));
}

/** Projects a positioned turn mutation response without a raw-value escape. */
export function projectCodexTurnResponseFacts(
  context: CodexFactResponseContext,
  threadId: string,
  turn: PinnedCodexTurn,
): readonly CodexFact[] {
  return facts(context, [{
    type: "turn.snapshot",
    threadId,
    turn: projectCodexTurnSnapshot(turn),
  }]);
}

export function projectCodexThreadSnapshot(
  thread: PinnedCodexThread,
  options: Readonly<{
    archived: boolean;
    turns: "metadata_only" | "present";
  }>,
): CodexThreadSnapshot {
  return {
    archived: options.archived,
    createdAt: requiredTimestamp(thread.createdAt),
    cwd: thread.cwd,
    id: thread.id,
    status: threadStatus(thread.status),
    title: thread.name ?? (thread.preview.length === 0 ? null : thread.preview),
    turns: options.turns === "present"
      ? Object.freeze(thread.turns.map(projectCodexTurnSnapshot))
      : null,
    updatedAt: requiredTimestamp(thread.updatedAt),
  };
}

export function projectCodexTurnSnapshot(turn: PinnedCodexTurn): CodexTurnSnapshot {
  return {
    completedAt: timestamp(turn.completedAt),
    id: turn.id,
    items: turn.itemsView === "full"
      ? Object.freeze(turn.items.map(projectCodexItemSnapshot))
      : null,
    ...("quotaProof" in turn ? { quotaProof: turn.quotaProof } : {}),
    startedAt: timestamp(turn.startedAt),
    status: turnStatus(turn.status),
  };
}

export function projectCodexItemSnapshot(item: PinnedCodexThreadItem): CodexItemSnapshot {
  switch (item.type) {
    case "agentMessage": {
      const display = boundedCodexDisplayText(item.text);
      return { id: item.id, kind: "assistant_text", ...display };
    }
    case "plan": {
      const display = boundedCodexDisplayText(item.text);
      return { id: item.id, kind: "reasoning_summary", ...display };
    }
    case "reasoning": {
      const display = boundedCodexDisplayText(item.summary.join("\n"));
      return {
        ...display,
        id: item.id,
        kind: "reasoning_summary",
      };
    }
    case "userMessage":
      return {
        clientMessageId: item.clientId,
        id: item.id,
        kind: "user_text",
        text: null,
      };
    case "commandExecution":
      return toolSnapshot(item, "command", toolStatus(item.status));
    case "fileChange":
      return toolSnapshot(item, "file_change", toolStatus(item.status));
    case "mcpToolCall":
    case "dynamicToolCall":
      return toolSnapshot(item, "mcp", "completed");
    case "collabAgentToolCall":
    case "subAgentActivity":
      return toolSnapshot(item, "collaboration", "completed");
    case "webSearch":
      return toolSnapshot(item, "search", "completed");
    case "imageView":
    case "imageGeneration":
      return toolSnapshot(item, "image", "completed");
    case "sleep":
      return toolSnapshot(item, "sleep", "completed");
    case "hookPrompt":
    case "enteredReviewMode":
    case "exitedReviewMode":
    case "contextCompaction":
      return toolSnapshot(item, "other", "completed");
  }
}

function projectStartedItem(item: PinnedCodexThreadItem): Readonly<{
  activity: CodexToolActivity | null;
  itemId: string;
  kind: "assistant_text" | "reasoning_summary" | "tool";
}> | null {
  switch (item.type) {
    case "agentMessage":
      return { activity: null, itemId: item.id, kind: "assistant_text" };
    case "plan":
    case "reasoning":
      return { activity: null, itemId: item.id, kind: "reasoning_summary" };
    case "userMessage":
      return null;
    case "collabAgentToolCall":
    case "commandExecution":
    case "contextCompaction":
    case "dynamicToolCall":
    case "enteredReviewMode":
    case "exitedReviewMode":
    case "fileChange":
    case "hookPrompt":
    case "imageGeneration":
    case "imageView":
    case "mcpToolCall":
    case "sleep":
    case "subAgentActivity":
    case "webSearch":
      return {
        activity: toolActivity(item),
        itemId: item.id,
        kind: "tool",
      };
  }
}

function toolSnapshot(
  item: Pick<PinnedCodexThreadItem, "id">,
  activity: CodexToolActivity,
  status: "completed" | "failed" | "interrupted",
): CodexItemSnapshot {
  return { activity, id: item.id, kind: "tool", status };
}

function toolActivity(item: PinnedCodexThreadItem): CodexToolActivity {
  switch (item.type) {
    case "commandExecution":
      return "command";
    case "fileChange":
      return "file_change";
    case "mcpToolCall":
    case "dynamicToolCall":
      return "mcp";
    case "collabAgentToolCall":
    case "subAgentActivity":
      return "collaboration";
    case "webSearch":
      return "search";
    case "imageView":
    case "imageGeneration":
      return "image";
    case "sleep":
      return "sleep";
    case "userMessage":
    case "agentMessage":
    case "plan":
    case "reasoning":
    case "hookPrompt":
    case "enteredReviewMode":
    case "exitedReviewMode":
    case "contextCompaction":
      return "other";
  }
}

function toolStatus(
  status: "completed" | "declined" | "failed" | "inProgress",
): "completed" | "failed" | "interrupted" {
  if (status === "failed") return "failed";
  if (status === "declined") return "interrupted";
  return "completed";
}

function turnStatus(status: PinnedCodexTurn["status"]): CodexTurnSnapshot["status"] {
  return status === "inProgress" ? "active" : status;
}

function completedTurnStatus(
  status: PinnedCodexTurn["status"],
): "completed" | "failed" | "interrupted" {
  if (status === "inProgress") throw new CodexFactProjectionError();
  return status;
}

function threadStatus(
  status: PinnedCodexThread["status"],
): CodexThreadSnapshot["status"] {
  switch (status.type) {
    case "active":
      return "active";
    case "idle":
      return "idle";
    case "notLoaded":
      return "not_loaded";
    case "systemError":
      return "system_error";
  }
}

function timestamp(seconds: number | null): string | null {
  if (seconds === null) return null;
  const date = new Date(seconds * 1_000);
  if (!Number.isFinite(date.getTime())) throw new CodexFactProjectionError();
  return date.toISOString();
}

function requiredTimestamp(seconds: number | null): string {
  const value = timestamp(seconds);
  if (value === null) throw new CodexFactProjectionError();
  return value;
}

function facts(
  context: FactProjectionContext,
  payloads: readonly CodexFactPayload[],
  factIndexOffset = 0,
): readonly CodexFact[] {
  return Object.freeze(payloads.map((payload, index) => {
    const factIndex = factIndexOffset + index;
    if (!Number.isSafeInteger(factIndex)) throw new CodexFactProjectionError();
    const encodedBytes = encodedFactBytes(context, payload, factIndex);
    const fact: CodexFact = Object.freeze({
      ...context,
      ...payload,
      encodedBytes,
      factIndex,
    });
    return fact;
  }));
}

function encodedFactBytes(
  context: FactProjectionContext,
  payload: CodexFactPayload,
  factIndex: number,
): number {
  const encoded = JSON.stringify({ ...context, ...payload, factIndex });
  if (encoded === undefined) throw new CodexFactProjectionError();
  const bytes = new TextEncoder().encode(encoded).byteLength;
  if (bytes > MAX_CODEX_FACT_ENCODED_BYTES) {
    throw new CodexFactProjectionError();
  }
  return bytes;
}
