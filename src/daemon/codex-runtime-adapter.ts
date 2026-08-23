import { createHash } from "node:crypto";
import { isAbsolute, relative } from "node:path";

import {
  CodexError,
  IndeterminateCodexEffectError,
  launchPinnedCodexAppServer,
  type CodexAppServerClient,
  type CodexFact,
  type CodexThread,
  type CodexThreadItem,
  type CodexTurn,
  type CodexPluginCatalog,
  type FencedCodexValue,
  type ResolvedPreset,
  type ThreadStartResult,
} from "../codex/index";
import type { EffectiveRuntimeProfile } from "../domain/runtime-profile";
import type {
  InteractionKind,
  InteractionResolution,
  ProviderInteractionAuthority,
} from "../domain/interactions";
import type {
  CodexAccountProjection,
  CodexLoginOutcome,
  CodexProjectedMessage,
  CodexRuntimePort,
  CodexSessionProjection,
  CodexTurnSummary,
  ProfileAuthority,
  ProjectionTextOmission,
  RuntimeStartReview,
} from "./ports";
import { compileEffectiveRuntimeProfile } from "./recommended-capabilities";

type RunningClient = { authority: ProfileAuthority; client: CodexAppServerClient };
type PendingRuntimeReview = {
  readonly review: RuntimeStartReview;
  readonly running: RunningClient;
  readonly projectRoot: string;
  readonly providerThreadId?: string;
  readonly preset: ResolvedPreset;
  readonly createdAt: number;
};

const assertReviewedThreadStart = (
  value: ThreadStartResult,
  profile: EffectiveRuntimeProfile,
  projectRoot: string,
): void => {
  const sandbox = value.sandbox;
  const profileMatches = value.activePermissionProfile?.id === profile.permissionProfile;
  const sandboxMatches = sandbox.type === "workspaceWrite"
    && (sandbox.writableRoots.length === 0
      || (sandbox.writableRoots.length === 1 && sandbox.writableRoots[0] === projectRoot));
  const rootsMatch = value.runtimeWorkspaceRoots.length === 1
    && value.runtimeWorkspaceRoots[0] === projectRoot;
  const serviceTierMatches = profile.serviceTier === null
    ? value.serviceTier === null || value.serviceTier === "default"
    : value.serviceTier === profile.serviceTier;
  if (
    value.cwd !== projectRoot
    || value.model !== profile.model
    || value.reasoningEffort !== profile.reasoningEffort
    || !serviceTierMatches
    || value.approvalPolicy !== profile.approvalPolicy
    || value.approvalsReviewer !== profile.reviewMode
    || !profileMatches
    || !sandboxMatches
    || !rootsMatch
    || value.thread.ephemeral
  ) {
    throw new CodexError(
      "PROTOCOL_ERROR",
      "Codex did not apply the reviewed model, permissions, or workspace policy to the new thread.",
    );
  }
};

export type CodexRuntimeObserver = {
  account(authority: ProfileAuthority, account: CodexAccountProjection): void | Promise<void>;
  fact(authority: ProfileAuthority, fact: CodexFact): void | Promise<void>;
};

const accountProjection = (value: Awaited<ReturnType<CodexAppServerClient["accountRead"]>>["value"]): CodexAccountProjection => {
  if (value.account === null) return { signedIn: false };
  if (value.account.type === "chatgpt") return { signedIn: true, ...(value.account.email === null ? {} : { email: value.account.email }), plan: value.account.planType };
  return { signedIn: true, plan: value.account.type };
};

const threadStatus = (thread: CodexThread): "active" | "idle" | "terminal" =>
  thread.status.type === "active" ? "active" : thread.status.type === "systemError" ? "terminal" : "idle";

const activeTurn = (thread: CodexThread): string | undefined =>
  [...thread.turns].reverse().find((turn) => turn.status === "inProgress")?.id;

const textEncoder = new TextEncoder();
const unsafeTerminalScalar = /[\p{Cc}\p{Cf}\p{Cs}]/u;

const sanitizeProviderText = (input: string, preserveLineFeeds: boolean): string => {
  let output = "";
  for (const scalar of input) {
    output += scalar === "\n" && preserveLineFeeds
      ? scalar
      : unsafeTerminalScalar.test(scalar)
        ? "�"
        : scalar;
  }
  return output;
};

const binaryCompare = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

const projectPluginCatalog = (catalog: CodexPluginCatalog): CodexPluginCatalog => {
  const safe = (value: string): string => sanitizeProviderText(value, false);
  return assertTransportSafeProjection({
    marketplaces: catalog.marketplaces.map((marketplace) => ({
      name: safe(marketplace.name),
      displayName: marketplace.displayName === null ? null : safe(marketplace.displayName),
      plugins: marketplace.plugins.map((plugin) => ({
        ...plugin,
        id: safe(plugin.id),
        name: safe(plugin.name),
        displayName: plugin.displayName === null ? null : safe(plugin.displayName),
        shortDescription: plugin.shortDescription === null
          ? null
          : sanitizeProviderText(plugin.shortDescription, true),
        developerName: plugin.developerName === null ? null : safe(plugin.developerName),
        category: plugin.category === null ? null : safe(plugin.category),
        capabilities: plugin.capabilities.map(safe).toSorted(binaryCompare),
        keywords: plugin.keywords.map(safe).toSorted(binaryCompare),
        eligiblePlanTypes: plugin.eligiblePlanTypes === null
          ? null
          : plugin.eligiblePlanTypes.map(safe).toSorted(binaryCompare),
        version: plugin.version === null ? null : safe(plugin.version),
        localVersion: plugin.localVersion === null ? null : safe(plugin.localVersion),
      })).toSorted((left, right) => binaryCompare(left.id, right.id)),
    })).toSorted((left, right) => binaryCompare(left.name, right.name)),
    featuredPluginIds: catalog.featuredPluginIds.map(safe).toSorted(binaryCompare),
    marketplaceLoadErrorCount: catalog.marketplaceLoadErrorCount,
    lifecycle: catalog.lifecycle,
  });
};

const RECENT_TURN_LIMIT = 24;
const COMPACT_MESSAGES_PER_TURN = 2;
const MESSAGE_LIMIT = RECENT_TURN_LIMIT * COMPACT_MESSAGES_PER_TURN;
const MESSAGE_TEXT_BYTES = 24 * 1024;
const DETAIL_TEXT_BYTES = 8 * 1024;
const SESSION_DETAIL_ITEM_LIMIT = 8;
const INSPECT_ITEM_LIMIT = 64;
const RECENT_TURN_ITEM_PAGE_LIMIT = 8;
const RECENT_TURN_ITEM_AGGREGATE_PAGE_LIMIT = RECENT_TURN_LIMIT * 2;
const RECENT_TURN_ITEM_TAIL_PAGE_LIMIT = RECENT_TURN_LIMIT;
const RECENT_TURN_ITEM_AGGREGATE_LIMIT = (
  RECENT_TURN_ITEM_AGGREGATE_PAGE_LIMIT + RECENT_TURN_ITEM_TAIL_PAGE_LIMIT
) * INSPECT_ITEM_LIMIT;
const RECENT_TURN_RETAINED_ITEM_JSON_BYTE_LIMIT = 12 * 1024 * 1024;
const RECENT_TURN_TAIL_ITEM_JSON_BYTE_RESERVE = 8 * 1024 * 1024;
const RECENT_TURN_FORWARD_ITEM_JSON_BYTE_LIMIT = (
  RECENT_TURN_RETAINED_ITEM_JSON_BYTE_LIMIT - RECENT_TURN_TAIL_ITEM_JSON_BYTE_RESERVE
);
const TURN_SEARCH_PAGE_SIZE = 128;
const TURN_SEARCH_PAGE_LIMIT = 80;
const SUMMARY_FILE_LIMIT = 128;
const SUMMARY_ACTION_LIMIT = 64;
const PROJECTION_JSON_BYTE_LIMIT = 3 * 1024 * 1024;
const SESSION_MESSAGE_JSON_BYTE_BUDGET = 1_250_000;
const TURN_MESSAGE_JSON_BYTE_BUDGET = Math.floor(
  SESSION_MESSAGE_JSON_BYTE_BUDGET / RECENT_TURN_LIMIT,
);
const SESSION_SUMMARY_STRING_JSON_BYTE_BUDGET = 256 * 1024;
const TURN_SUMMARY_STRING_JSON_BYTE_BUDGET = Math.floor(
  SESSION_SUMMARY_STRING_JSON_BYTE_BUDGET / RECENT_TURN_LIMIT,
);
const SESSION_DETAIL_ITEM_JSON_BYTE_BUDGET = 900 * 1024;
const INSPECT_ITEM_JSON_BYTE_BUDGET = 2_500_000;
type ProjectedText = {
  readonly text: string;
  readonly omission?: ProjectionTextOmission;
};

type JsonByteBudget = { remaining: number };

const jsonUtf8Bytes = (value: unknown): number => textEncoder.encode(JSON.stringify(value)).byteLength;

const consumeJsonBudget = (budget: JsonByteBudget, value: unknown): boolean => {
  const bytes = jsonUtf8Bytes(value) + 1;
  if (bytes > budget.remaining) return false;
  budget.remaining -= bytes;
  return true;
};

const assertTransportSafeProjection = <T>(value: T): T => {
  if (jsonUtf8Bytes(value) > PROJECTION_JSON_BYTE_LIMIT) {
    throw new CodexError("PROTOCOL_LIMIT", "The closed Codex projection exceeded its transport-safe byte limit.");
  }
  return value;
};

/** Truncate at Unicode scalar boundaries and report exact UTF-8 byte loss. */
export const projectUtf8Text = (input: string, maxUtf8Bytes: number): ProjectedText => {
  if (!Number.isSafeInteger(maxUtf8Bytes) || maxUtf8Bytes < 0) {
    throw new CodexError("INVALID_INPUT", "projection text limit must be a nonnegative integer");
  }
  let text = "";
  let originalUtf8Bytes = 0;
  let returnedUtf8Bytes = 0;
  let accepting = true;
  for (const scalar of input) {
    const safeScalar = scalar.length === 1
      && (scalar.charCodeAt(0) >= 0xD800 && scalar.charCodeAt(0) <= 0xDFFF)
      ? "�"
      : scalar;
    const bytes = textEncoder.encode(safeScalar).byteLength;
    originalUtf8Bytes += bytes;
    if (accepting && returnedUtf8Bytes + bytes <= maxUtf8Bytes) {
      text += safeScalar;
      returnedUtf8Bytes += bytes;
    } else {
      accepting = false;
    }
  }
  if (originalUtf8Bytes === returnedUtf8Bytes) return { text };
  return {
    text,
    omission: {
      originalUtf8Bytes,
      returnedUtf8Bytes,
      omittedUtf8Bytes: originalUtf8Bytes - returnedUtf8Bytes,
    },
  };
};

export const normalizeProviderTitle = (input: string): string => {
  const source = sanitizeProviderText(input, false).trim() || "Untitled session";
  let output = "";
  let bytes = 0;
  for (const scalar of source) {
    const safeScalar = scalar.length === 1
      && (scalar.charCodeAt(0) >= 0xD800 && scalar.charCodeAt(0) <= 0xDFFF)
      ? "�"
      : scalar;
    const size = textEncoder.encode(safeScalar).byteLength;
    if (bytes + size > 320) break;
    output += safeScalar;
    bytes += size;
  }
  return output || "Untitled session";
};

const gitActions = new Set(["add", "branch", "checkout", "cherry-pick", "clone", "commit", "diff", "fetch", "log", "merge", "pull", "push", "rebase", "reset", "restore", "revert", "show", "status", "switch", "tag", "worktree"]);
const bunActions = new Set(["build", "install", "run", "test", "x"]);

export const classifyCommand = (command: string): string => {
  const tokens = command.trim().split(/\s+/u).slice(0, 32);
  const gitIndex = tokens.findIndex((token) => token === "git" || token.endsWith("/git"));
  if (gitIndex >= 0) {
    const action = tokens.slice(gitIndex + 1).find((token) => gitActions.has(token));
    return action === undefined ? "git" : `git ${action}`;
  }
  const bunIndex = tokens.findIndex((token) => token === "bun" || token.endsWith("/bun"));
  if (bunIndex >= 0) {
    const action = tokens.slice(bunIndex + 1).find((token) => bunActions.has(token));
    return action === undefined ? "bun" : `bun ${action}`;
  }
  return "command";
};

const safeRelative = (root: string, path: string): string | null => {
  const value = relative(root, path);
  return value === ""
    ? "."
    : value === ".." || value.startsWith("../") || isAbsolute(value)
      ? null
      : value;
};

const projectItem = (item: CodexThreadItem, root: string): unknown => {
  if (item.type === "userMessage") {
    const content = item.text.slice(0, 16).map((text) => projectUtf8Text(sanitizeProviderText(text, true), DETAIL_TEXT_BYTES));
    return {
      type: item.type,
      id: item.id,
      clientId: item.clientId,
      content,
      omittedContent: Math.max(0, item.text.length - content.length),
    };
  }
  if (item.type === "agentMessage") {
    return { type: item.type, id: item.id, ...projectUtf8Text(sanitizeProviderText(item.text, true), DETAIL_TEXT_BYTES) };
  }
  if (item.type === "reasoning") {
    const summary = item.summary.slice(0, 16).map((text) => projectUtf8Text(sanitizeProviderText(text, true), DETAIL_TEXT_BYTES));
    return {
      type: item.type,
      id: item.id,
      summary,
      omittedSummary: Math.max(0, item.summary.length - summary.length),
    };
  }
  if (item.type === "fileChange") {
    const relativePaths = item.changedPaths
      .map((path) => safeRelative(root, path))
      .filter((path): path is string => path !== null);
    return {
      type: item.type,
      id: item.id,
      status: item.status,
      paths: relativePaths.slice(0, SUMMARY_FILE_LIMIT).map((path) => sanitizeProviderText(path, false)),
      omittedPaths: Math.max(0, relativePaths.length - SUMMARY_FILE_LIMIT),
    };
  }
  if (item.type === "commandExecution") {
    const cwd = safeRelative(root, item.cwd);
    return { type: item.type, id: item.id, status: item.status, exitCode: item.exitCode, durationMs: item.durationMs, ...(cwd === null ? {} : { cwd: sanitizeProviderText(cwd, false) }), commandClass: classifyCommand(item.command) };
  }
  if (item.type === "mcpToolCall") return { type: item.type, id: item.id, server: sanitizeProviderText(item.server, false), tool: sanitizeProviderText(item.tool, false), status: item.status, durationMs: item.durationMs };
  return { type: "unsupported", id: item.id, providerType: sanitizeProviderText(item.providerType, false) };
};

const projectTurn = (
  turn: CodexTurn,
  root: string,
  itemLimit: number,
  providerHasMoreItems = false,
  itemBudget: JsonByteBudget = { remaining: INSPECT_ITEM_JSON_BYTE_BUDGET },
): unknown => {
  const items: unknown[] = [];
  for (const item of turn.items.slice(0, itemLimit)) {
    if (itemBudget.remaining === 0) break;
    const projected = projectItem(item, root);
    if (!consumeJsonBudget(itemBudget, projected)) {
      itemBudget.remaining = 0;
      break;
    }
    items.push(projected);
  }
  return {
    id: turn.id,
    status: turn.status,
    startedAt: turn.startedAt,
    completedAt: turn.completedAt,
    runtimeMs: turn.durationMs,
    items,
    omission: {
      hasMoreItems: providerHasMoreItems,
      omittedLoadedItems: Math.max(0, turn.items.length - items.length),
    },
  };
};

type TurnSummaryMetadata = Pick<
  CodexTurnSummary,
  "files" | "actions" | "omittedFiles" | "omittedActions"
>;

type TurnCompactEssentials = Readonly<{
  firstUser?: CodexProjectedMessage;
  finalAssistant?: CodexProjectedMessage;
}>;

type TurnSummaryAccumulator = {
  readonly files: string[];
  readonly actions: string[];
  readonly stringBudget: JsonByteBudget;
  omittedFiles: number;
  omittedActions: number;
  acceptingFiles: boolean;
  acceptingActions: boolean;
};

const createTurnSummaryAccumulator = (): TurnSummaryAccumulator => ({
  files: [],
  actions: [],
  stringBudget: { remaining: TURN_SUMMARY_STRING_JSON_BYTE_BUDGET },
  omittedFiles: 0,
  omittedActions: 0,
  acceptingFiles: true,
  acceptingActions: true,
});

const accumulateTurnSummaryItem = (
  summary: TurnSummaryAccumulator,
  item: CodexThreadItem,
  root: string,
): void => {
    if (item.type === "fileChange") {
      for (const path of item.changedPaths) {
        const projected = safeRelative(root, path);
        if (projected === null) continue;
        const safePath = sanitizeProviderText(projected, false);
        if (
          summary.acceptingFiles
          && summary.files.length < SUMMARY_FILE_LIMIT
          && consumeJsonBudget(summary.stringBudget, safePath)
        ) {
          summary.files.push(safePath);
        } else {
          summary.acceptingFiles = false;
          summary.omittedFiles += 1;
        }
      }
    }
    if (item.type === "commandExecution") {
      const action = classifyCommand(item.command);
      if (
        summary.acceptingActions
        && summary.actions.length < SUMMARY_ACTION_LIMIT
        && consumeJsonBudget(summary.stringBudget, action)
      ) {
        summary.actions.push(action);
      } else {
        summary.acceptingActions = false;
        summary.omittedActions += 1;
      }
    }
};

const finishTurnSummary = (summary: TurnSummaryAccumulator): TurnSummaryMetadata => ({
  files: [...summary.files],
  actions: [...summary.actions],
  omittedFiles: summary.omittedFiles,
  omittedActions: summary.omittedActions,
});

const summarizeTurnItems = (
  items: readonly CodexThreadItem[],
  root: string,
): TurnSummaryMetadata => {
  const summary = createTurnSummaryAccumulator();
  for (const item of items) {
    accumulateTurnSummaryItem(summary, item, root);
  }
  return finishTurnSummary(summary);
};

const projectTurnSummary = (
  turn: CodexTurn,
  root: string,
  metadata: TurnSummaryMetadata = summarizeTurnItems(turn.items, root),
): CodexTurnSummary => {
  return {
    id: turn.id,
    status: turn.status,
    ...(turn.startedAt === null ? {} : { startedAt: turn.startedAt }),
    ...(turn.completedAt === null ? {} : { completedAt: turn.completedAt }),
    ...(turn.durationMs === null ? {} : { runtimeMs: turn.durationMs }),
    ...metadata,
  };
};

const fingerprintThreadItem = (item: CodexThreadItem): string =>
  createHash("sha256").update(JSON.stringify(item)).digest("hex");

const messageWithTextPrefix = (
  message: CodexProjectedMessage,
  text: string,
  originalUtf8Bytes: number,
): CodexProjectedMessage => {
  const returnedUtf8Bytes = textEncoder.encode(text).byteLength;
  return {
    role: message.role,
    text,
    ...(message.turnId === undefined ? {} : { turnId: message.turnId }),
    ...(message.clientId === undefined ? {} : { clientId: message.clientId }),
    ...(returnedUtf8Bytes === originalUtf8Bytes
      ? {}
      : {
          omission: {
            originalUtf8Bytes,
            returnedUtf8Bytes,
            omittedUtf8Bytes: originalUtf8Bytes - returnedUtf8Bytes,
          },
        }),
  };
};

const projectCompactMessage = (
  role: "user" | "assistant",
  text: string,
  turnId: string,
  clientId?: string,
): CodexProjectedMessage => {
  const projected = projectUtf8Text(sanitizeProviderText(text, true), MESSAGE_TEXT_BYTES);
  return {
    role,
    text: projected.text,
    turnId,
    ...(clientId === undefined ? {} : { clientId }),
    ...(projected.omission === undefined ? {} : { omission: projected.omission }),
  };
};

const fitMessageToJsonByteLimit = (
  message: CodexProjectedMessage,
  maximumJsonBytes: number,
): CodexProjectedMessage => {
  if (jsonUtf8Bytes(message) + 1 <= maximumJsonBytes) return message;
  const originalUtf8Bytes = message.omission?.originalUtf8Bytes
    ?? textEncoder.encode(message.text).byteLength;
  const scalars = Array.from(message.text);
  const empty = messageWithTextPrefix(message, "", originalUtf8Bytes);
  if (jsonUtf8Bytes(empty) + 1 > maximumJsonBytes) {
    throw new CodexError("PROTOCOL_LIMIT", "compact turn message metadata exceeded its deterministic JSON byte limit");
  }
  let lower = 0;
  let upper = scalars.length;
  while (lower < upper) {
    const middle = Math.ceil((lower + upper) / 2);
    const candidate = messageWithTextPrefix(
      message,
      scalars.slice(0, middle).join(""),
      originalUtf8Bytes,
    );
    if (jsonUtf8Bytes(candidate) + 1 <= maximumJsonBytes) lower = middle;
    else upper = middle - 1;
  }
  return messageWithTextPrefix(
    message,
    scalars.slice(0, lower).join(""),
    originalUtf8Bytes,
  );
};

export const projectBoundedThread = (
  thread: CodexThread,
  includeDetail: boolean,
  hasMoreOlderTurns = false,
  turnsWithMoreItems: ReadonlySet<string> = new Set<string>(),
  compactIncompleteTurnIds: ReadonlySet<string> = new Set<string>(),
  stableSummaryMetadataByTurn: ReadonlyMap<string, TurnSummaryMetadata> = new Map(),
  stableCompactEssentialsByTurn: ReadonlyMap<string, TurnCompactEssentials> = new Map(),
): CodexSessionProjection => {
  const turns = thread.turns.slice(-RECENT_TURN_LIMIT);
  const olderTurnsOmitted = hasMoreOlderTurns || turns.length !== thread.turns.length;
  const incompleteTurnIds = new Set(
    turns
      .filter((turn) => compactIncompleteTurnIds.has(turn.id))
      .map((turn) => turn.id),
  );
  const unreadItemTurnIds = new Set(
    turns
      .filter((turn) => turnsWithMoreItems.has(turn.id))
      .map((turn) => turn.id),
  );
  type MessageCandidate = { readonly message: CodexProjectedMessage; readonly sequence: number };
  const firstUserByTurn = new Map<string, MessageCandidate>();
  const finalAssistantByTurn = new Map<string, MessageCandidate>();
  const messages: CodexProjectedMessage[] = [];
  const messageBudget: JsonByteBudget = { remaining: SESSION_MESSAGE_JSON_BYTE_BUDGET };
  const detailItemBudget: JsonByteBudget = { remaining: SESSION_DETAIL_ITEM_JSON_BYTE_BUDGET };
  let totalMessageCandidates = 0;
  let truncatedMessages = 0;
  const addMessage = (role: "user" | "assistant", text: string, turnId: string, clientId?: string): void => {
    const message = projectCompactMessage(role, text, turnId, clientId);
    const candidate = { message, sequence: totalMessageCandidates };
    totalMessageCandidates += 1;
    if (role === "user" && !firstUserByTurn.has(turnId)) firstUserByTurn.set(turnId, candidate);
    if (role === "assistant") finalAssistantByTurn.set(turnId, candidate);
  };
  for (const turn of turns) {
    for (const item of turn.items) {
      if (item.type === "userMessage") {
        for (const text of item.text) {
          addMessage("user", text, turn.id, item.clientId ?? undefined);
        }
      }
      if (item.type === "agentMessage") addMessage("assistant", item.text, turn.id);
    }
  }
  const selectedMessages = turns.flatMap((turn) => {
    // A hydrated proof entry is authoritative even when one side is absent.
    // Falling back to retained tail items could turn a later steer into the
    // turn's first user message after the shared detail budget closes.
    if (stableCompactEssentialsByTurn.has(turn.id)) {
      const stable = stableCompactEssentialsByTurn.get(turn.id);
      if (stable === undefined) {
        throw new CodexError("PROTOCOL_ERROR", "compact turn essentials lost a recent turn");
      }
      return [stable.firstUser, stable.finalAssistant]
        .filter((message): message is CodexProjectedMessage => message !== undefined)
        .map((message, sequence) => ({ message, sequence }));
    }
    return [firstUserByTurn.get(turn.id), finalAssistantByTurn.get(turn.id)]
      .filter((candidate): candidate is MessageCandidate => candidate !== undefined);
  });
  if (selectedMessages.length > MESSAGE_LIMIT) {
    throw new CodexError("PROTOCOL_LIMIT", "essential compact messages exceeded their exact bound");
  }
  const omittedMessages = Math.max(0, totalMessageCandidates - selectedMessages.length);
  for (const turn of turns) {
    const selectedForTurn = selectedMessages.filter((candidate) => candidate.message.turnId === turn.id);
    const turnBudget: JsonByteBudget = { remaining: TURN_MESSAGE_JSON_BYTE_BUDGET };
    for (const [index, candidate] of selectedForTurn.entries()) {
      const following = selectedForTurn[index + 1];
      const reservedForFollowing = following === undefined
        ? 0
        : Math.min(
            jsonUtf8Bytes(following.message) + 1,
            Math.floor(TURN_MESSAGE_JSON_BYTE_BUDGET / COMPACT_MESSAGES_PER_TURN),
          );
      const projected = fitMessageToJsonByteLimit(
        candidate.message,
        turnBudget.remaining - reservedForFollowing,
      );
      if (!consumeJsonBudget(turnBudget, projected) || !consumeJsonBudget(messageBudget, projected)) {
        throw new CodexError("PROTOCOL_LIMIT", "compact turn messages exceeded their deterministic JSON byte budget");
      }
      if (projected.omission !== undefined) truncatedMessages += 1;
      messages.push(projected);
    }
  }
  const summariesByTurn = new Map(turns.map((turn) => [
    turn.id,
    projectTurnSummary(turn, thread.cwd, stableSummaryMetadataByTurn.get(turn.id)),
  ]));
  const turnId = activeTurn(thread);
  return assertTransportSafeProjection({
    providerThreadId: thread.id,
    title: normalizeProviderTitle(thread.name ?? thread.preview),
    status: threadStatus(thread),
    projectRoot: thread.cwd,
    providerUpdatedAt: thread.updatedAt,
    ...(turnId === undefined ? {} : { activeTurnId: turnId }),
    messages,
    turnSummaries: turns.map((turn) => {
      const summary = summariesByTurn.get(turn.id);
      if (summary === undefined) throw new CodexError("PROTOCOL_ERROR", "turn summary projection lost a recent turn");
      return summary;
    }),
    omission: {
      hasMoreOlderTurns: olderTurnsOmitted,
      returnedTurns: turns.length,
      turnLimit: RECENT_TURN_LIMIT,
      omittedMessages,
      truncatedMessages,
      unreadItemTurnIds: [...unreadItemTurnIds].sort((left, right) => left < right ? -1 : left > right ? 1 : 0),
      incompleteTurnIds: [...incompleteTurnIds].sort((left, right) => left < right ? -1 : left > right ? 1 : 0),
    },
    ...(includeDetail
      ? {
          turns: turns.map((turn) =>
            projectTurn(turn, thread.cwd, SESSION_DETAIL_ITEM_LIMIT, turnsWithMoreItems.has(turn.id), detailItemBudget),
          ),
        }
      : {}),
  });
};

export class PinnedCodexRuntimeManager implements CodexRuntimePort {
  readonly #clients = new Map<string, RunningClient>();
  readonly #lifecycleTails = new Map<string, Promise<void>>();
  readonly #background = new Set<Promise<unknown>>();
  readonly #accountRefreshes = new Map<string, Promise<void>>();
  readonly #accountRefreshDirty = new Set<string>();
  readonly #endedGenerationByProfile = new Map<string, number>();
  readonly #runtimeReviews = new Map<string, PendingRuntimeReview>();
  readonly #operations = new Set<Promise<void>>();
  readonly #isCurrent: (authority: ProfileAuthority) => boolean;
  readonly #observer: CodexRuntimeObserver;
  readonly #launchClient: typeof launchPinnedCodexAppServer;
  readonly #now: () => number;
  #usageRevision = Date.now();
  #state: "open" | "closing" | "closed" = "open";
  #closeTask: Promise<void> | undefined;

  constructor(input: { isCurrent: (authority: ProfileAuthority) => boolean; observer: CodexRuntimeObserver; launchClient?: typeof launchPinnedCodexAppServer; now?: () => number }) {
    this.#isCurrent = input.isCurrent;
    this.#observer = input.observer;
    this.#launchClient = input.launchClient ?? launchPinnedCodexAppServer;
    this.#now = input.now ?? Date.now;
  }

  async login(input: { authority: ProfileAuthority; method: "browser" | "device_code"; signal: AbortSignal }): Promise<CodexLoginOutcome> {
    return await this.#admit(async () => {
      const client = await this.#client(input.authority);
      const before = accountProjection((await client.accountRead()).value);
      if (before.signedIn) return { status: "signed_in", account: { ...before, signedIn: true } };
      if (input.signal.aborted) throw input.signal.reason;
      const login = (await client.startManagedLogin(input.method === "device_code" ? "device-code" : "browser")).value;
      return login.type === "chatgptDeviceCode"
        ? { status: "pending", loginId: login.loginId, verificationUrl: login.verificationUrl, userCode: login.userCode }
        : { status: "pending", loginId: login.loginId, verificationUrl: login.authUrl };
    });
  }

  async cancelLogin(input: { authority: ProfileAuthority; loginId: string; signal: AbortSignal }): Promise<{ status: "canceled" | "not_found" }> {
    return await this.#admit(async () => {
      if (input.signal.aborted) throw input.signal.reason;
      const result = (await (await this.#client(input.authority)).cancelManagedLogin(input.loginId)).value;
      return { status: result.status === "notFound" ? "not_found" : "canceled" };
    });
  }

  async logout(input: { authority: ProfileAuthority; signal: AbortSignal }): Promise<void> {
    await this.#admit(async () => {
      if (input.signal.aborted) throw input.signal.reason;
      await (await this.#client(input.authority)).logout();
    });
  }

  async readAccount(input: { authority: ProfileAuthority; signal: AbortSignal }): Promise<CodexAccountProjection> {
    return await this.#admit(async () => {
      if (input.signal.aborted) throw input.signal.reason;
      return accountProjection((await (await this.#client(input.authority)).accountRead()).value);
    });
  }

  async readUsage(input: { authority: ProfileAuthority; signal: AbortSignal }): Promise<{ revision: number; observedAt: number; payload: unknown }> {
    return await this.#admit(async () => {
      if (input.signal.aborted) throw input.signal.reason;
      const client = await this.#client(input.authority);
      const [usage, limits] = await Promise.all([client.accountUsage(), client.accountRateLimits()]);
      const observedAt = Date.now();
      this.#usageRevision = Math.max(this.#usageRevision + 1, observedAt);
      return { revision: this.#usageRevision, observedAt, payload: { usage: usage.value, rateLimits: limits.value } };
    });
  }

  async listPlugins(input: {
    authority: ProfileAuthority;
    projectRoot?: string;
    forceRefetch: boolean;
    signal: AbortSignal;
  }): Promise<CodexPluginCatalog> {
    return await this.#admit(async () => {
      if (input.signal.aborted) throw input.signal.reason;
      const catalog = await (await this.#client(input.authority)).listPlugins({
        ...(input.projectRoot === undefined ? {} : { cwd: input.projectRoot }),
        forceRefetch: input.forceRefetch,
      });
      return projectPluginCatalog(catalog.value);
    });
  }

  async listSessions(input: { authority: ProfileAuthority; limit: number; signal: AbortSignal }): Promise<readonly CodexSessionProjection[]> {
    return await this.#admit(async () => {
      if (input.signal.aborted) throw input.signal.reason;
      const page = await (await this.#client(input.authority)).listThreads({ limit: input.limit });
      return page.value.data.map((thread) => projectBoundedThread(thread, false));
    });
  }

  async reviewSessionStart(input: { authority: ProfileAuthority; projectRoot?: string; preset: "low" | "high" | "ultra"; fast: boolean; signal: AbortSignal }): Promise<RuntimeStartReview> {
    return await this.#admit(async () => {
      if (input.projectRoot === undefined) throw new Error("A project directory is required before starting a session.");
      if (input.signal.aborted) throw input.signal.reason;
      const running = await this.#running(input.authority);
      const reviewed = await this.#reviewedPreset(running, input.preset, input.fast, input.projectRoot);
      return this.#rememberReview({ kind: "session_start", running, projectRoot: input.projectRoot, ...reviewed });
    });
  }

  async startSession(input: { authority: ProfileAuthority; projectRoot?: string; review: RuntimeStartReview; signal: AbortSignal }): Promise<CodexSessionProjection & { effectiveRuntimeProfile: EffectiveRuntimeProfile }> {
    return await this.#admit(async () => {
      if (input.projectRoot === undefined) throw new Error("A project directory is required before starting a session.");
      if (input.signal.aborted) throw input.signal.reason;
      const reviewed = this.#consumeReview(input.review, {
        kind: "session_start",
        authority: input.authority,
        projectRoot: input.projectRoot,
      });
      const running = reviewed.running;
      const preset = reviewed.preset;
      const started = (await running.client.startThread({ cwd: input.projectRoot, preset, policy: this.#policy(input.projectRoot) })).value;
      try {
        assertReviewedThreadStart(started, reviewed.review.effectiveRuntimeProfile, input.projectRoot);
        const contextual = await this.#reviewedPreset(
          running,
          preset.alias,
          preset.fast,
          input.projectRoot,
          started.thread.id,
        );
        const normalizedContextualProfile: EffectiveRuntimeProfile = {
          ...contextual.profile,
          observedAt: reviewed.review.effectiveRuntimeProfile.observedAt,
        };
        if (
          JSON.stringify(contextual.preset) !== JSON.stringify(preset)
          || JSON.stringify(normalizedContextualProfile) !== JSON.stringify(reviewed.review.effectiveRuntimeProfile)
        ) {
          throw new CodexError(
            "PROTOCOL_ERROR",
            "The new thread's exact capability context differs from its reviewed runtime profile.",
          );
        }
      } catch (error: unknown) {
        throw new IndeterminateCodexEffectError("thread/start", 0, error);
      }
      return { ...projectBoundedThread(started.thread, false), effectiveRuntimeProfile: reviewed.review.effectiveRuntimeProfile };
    });
  }

  async readSession(input: { authority: ProfileAuthority; providerThreadId: string; detail: boolean; signal: AbortSignal }): Promise<CodexSessionProjection> {
    return await this.#admit(async () => {
      if (input.signal.aborted) throw input.signal.reason;
      const client = await this.#client(input.authority);
      const [metadata, turns] = await Promise.all([
        client.readThread(input.providerThreadId, false),
        client.listThreadTurns({
          threadId: input.providerThreadId,
          limit: RECENT_TURN_LIMIT,
          sortDirection: "desc",
          itemsView: "notLoaded",
        }),
      ]);
      const chronologicalTurns = [...turns.value.data].reverse();
      const hydrated = await this.#hydrateRecentTurns(
        client,
        input.providerThreadId,
        chronologicalTurns,
        metadata.value.cwd,
        input.signal,
      );
      const thread: CodexThread = {
        ...metadata.value,
        turns: hydrated.turns,
      };
      return projectBoundedThread(
        thread,
        input.detail,
        turns.value.nextCursor !== null,
        hydrated.unreadItemTurnIds,
        hydrated.incompleteTurnIds,
        hydrated.summaryMetadataByTurn,
        hydrated.compactEssentialsByTurn,
      );
    });
  }

  async reviewTurnStart(input: { authority: ProfileAuthority; providerThreadId: string; projectRoot?: string; preset: "low" | "high" | "ultra"; fast: boolean; signal: AbortSignal }): Promise<RuntimeStartReview> {
    return await this.#admit(async () => {
      if (input.projectRoot === undefined) throw new Error("A project directory is required before starting a turn.");
      if (input.signal.aborted) throw input.signal.reason;
      const running = await this.#running(input.authority);
      const reviewed = await this.#reviewedPreset(running, input.preset, input.fast, input.projectRoot, input.providerThreadId);
      return this.#rememberReview({ kind: "turn_start", running, projectRoot: input.projectRoot, providerThreadId: input.providerThreadId, ...reviewed });
    });
  }

  async startTurn(input: { authority: ProfileAuthority; providerThreadId: string; projectRoot?: string; review: RuntimeStartReview; message: string; clientMessageId: string; signal: AbortSignal }): Promise<{ turnId: string; status: CodexTurn["status"]; effectiveRuntimeProfile: EffectiveRuntimeProfile }> {
    return await this.#admit(async () => {
      if (input.projectRoot === undefined) throw new Error("A project directory is required before starting a turn.");
      if (input.signal.aborted) throw input.signal.reason;
      const reviewed = this.#consumeReview(input.review, {
        kind: "turn_start",
        authority: input.authority,
        projectRoot: input.projectRoot,
        providerThreadId: input.providerThreadId,
      });
      const running = reviewed.running;
      const preset = reviewed.preset;
      const value = await running.client.startTurn({ threadId: input.providerThreadId, clientMessageId: input.clientMessageId, text: input.message, preset, cwd: input.projectRoot, policy: this.#policy(input.projectRoot) });
      return { turnId: value.value.turn.id, status: value.value.turn.status, effectiveRuntimeProfile: reviewed.review.effectiveRuntimeProfile };
    });
  }

  async steer(input: { authority: ProfileAuthority; providerThreadId: string; activeTurnId: string; message: string; clientMessageId: string; signal: AbortSignal }): Promise<void> {
    await this.#admit(async () => {
      if (input.signal.aborted) throw input.signal.reason;
      await (await this.#client(input.authority)).steerTurn({ threadId: input.providerThreadId, expectedTurnId: input.activeTurnId, clientMessageId: input.clientMessageId, text: input.message });
    });
  }

  async interrupt(input: { authority: ProfileAuthority; providerThreadId: string; activeTurnId: string; signal: AbortSignal }): Promise<void> {
    await this.#admit(async () => {
      if (input.signal.aborted) throw input.signal.reason;
      await (await this.#client(input.authority)).interruptTurn(input.providerThreadId, input.activeTurnId);
    });
  }

  async rename(input: { authority: ProfileAuthority; providerThreadId: string; name: string; signal: AbortSignal }): Promise<void> {
    await this.#admit(async () => {
      if (input.signal.aborted) throw input.signal.reason;
      await (await this.#client(input.authority)).renameThread(input.providerThreadId, input.name);
    });
  }

  async inspectTurn(input: { authority: ProfileAuthority; providerThreadId: string; turnId: string; signal: AbortSignal }): Promise<unknown> {
    return await this.#admit(async () => {
      if (input.signal.aborted) throw input.signal.reason;
      const client = await this.#client(input.authority);
      const [metadata, turn, itemPage] = await Promise.all([
        client.readThread(input.providerThreadId, false),
        this.#findTurn(client, input.providerThreadId, input.turnId, input.signal),
        client.listThreadItems({
          threadId: input.providerThreadId,
          turnId: input.turnId,
          limit: INSPECT_ITEM_LIMIT,
          sortDirection: "asc",
        }),
      ]);
      const items = itemPage.value.data.map((entry) => {
        if (entry.turnId !== input.turnId) {
          throw new CodexError(
            "PROTOCOL_ERROR",
            "thread/items/list returned an item for a different turn",
          );
        }
        return entry.item;
      });
      return assertTransportSafeProjection(projectTurn(
        { ...turn, items },
        metadata.value.cwd,
        INSPECT_ITEM_LIMIT,
        itemPage.value.nextCursor !== null,
        { remaining: INSPECT_ITEM_JSON_BYTE_BUDGET },
      ));
    });
  }

  async resolveInteraction(input: {
    authority: ProfileAuthority;
    provider: ProviderInteractionAuthority;
    kind: InteractionKind;
    resolution: InteractionResolution;
    signal: AbortSignal;
  }): Promise<{ responseWritten: true }> {
    return await this.#admit(async () => {
      if (input.signal.aborted) throw input.signal.reason;
      if (
        input.provider.profileId !== input.authority.id
        || input.provider.processGeneration !== input.authority.generation
        || !this.#isCurrent(input.authority)
      ) {
        throw new CodexError(
          "AUTHORITY_STALE",
          "The interaction belongs to another account process generation.",
        );
      }
      const running = this.#clients.get(input.authority.id);
      if (
        running === undefined
        || running.authority.generation !== input.authority.generation
        || running.client.state !== "ready"
        || running.client.connectionId !== input.provider.connectionId
      ) {
        throw new CodexError(
          "AUTHORITY_STALE",
          "The interaction's exact provider connection is no longer live.",
        );
      }
      return await running.client.resolveInteraction({
        provider: input.provider,
        kind: input.kind,
        resolution: input.resolution,
      });
    });
  }

  async validateInteractionResolution(input: {
    authority: ProfileAuthority;
    provider: ProviderInteractionAuthority;
    kind: InteractionKind;
    resolution: InteractionResolution;
    signal: AbortSignal;
  }): Promise<{ responseDigest: string }> {
    return await this.#admit(async () => {
      if (input.signal.aborted) throw input.signal.reason;
      if (
        input.provider.profileId !== input.authority.id
        || input.provider.processGeneration !== input.authority.generation
        || !this.#isCurrent(input.authority)
      ) {
        throw new CodexError(
          "AUTHORITY_STALE",
          "The interaction belongs to another account process generation.",
        );
      }
      const running = this.#clients.get(input.authority.id);
      if (
        running === undefined
        || running.authority.generation !== input.authority.generation
        || running.client.state !== "ready"
        || running.client.connectionId !== input.provider.connectionId
      ) {
        throw new CodexError(
          "AUTHORITY_STALE",
          "The interaction's exact provider connection is no longer live.",
        );
      }
      return await running.client.validateInteractionResolution({
        provider: input.provider,
        kind: input.kind,
        resolution: input.resolution,
      });
    });
  }

  async validateInteractionTimeout(input: {
    authority: ProfileAuthority;
    provider: ProviderInteractionAuthority;
    signal: AbortSignal;
  }): Promise<{ responseDigest: string }> {
    return await this.#admit(async () => {
      if (input.signal.aborted) throw input.signal.reason;
      if (
        input.provider.profileId !== input.authority.id
        || input.provider.processGeneration !== input.authority.generation
        || !this.#isCurrent(input.authority)
      ) throw new CodexError("AUTHORITY_STALE", "The interaction belongs to another account process generation.");
      const running = this.#clients.get(input.authority.id);
      if (
        running === undefined
        || running.authority.generation !== input.authority.generation
        || running.client.state !== "ready"
        || running.client.connectionId !== input.provider.connectionId
      ) throw new CodexError("AUTHORITY_STALE", "The interaction's exact provider connection is no longer live.");
      return await running.client.validateInteractionTimeout({ provider: input.provider });
    });
  }

  async timeoutInteraction(input: {
    authority: ProfileAuthority;
    provider: ProviderInteractionAuthority;
    signal: AbortSignal;
  }): Promise<{ responseWritten: true }> {
    return await this.#admit(async () => {
      if (input.signal.aborted) throw input.signal.reason;
      if (
        input.provider.profileId !== input.authority.id
        || input.provider.processGeneration !== input.authority.generation
        || !this.#isCurrent(input.authority)
      ) throw new CodexError("AUTHORITY_STALE", "The interaction belongs to another account process generation.");
      const running = this.#clients.get(input.authority.id);
      if (
        running === undefined
        || running.authority.generation !== input.authority.generation
        || running.client.state !== "ready"
        || running.client.connectionId !== input.provider.connectionId
      ) throw new CodexError("AUTHORITY_STALE", "The interaction's exact provider connection is no longer live.");
      return await running.client.timeoutInteraction({ provider: input.provider });
    });
  }

  close(): Promise<void> {
    if (this.#closeTask !== undefined) return this.#closeTask;
    this.#state = "closing";
    this.#runtimeReviews.clear();
    this.#accountRefreshDirty.clear();
    this.#closeTask = this.#closeOwnedRuntime();
    return this.#closeTask;
  }

  async #closeOwnedRuntime(): Promise<void> {
    await this.#drainOwnedWork();
    const clients = [...this.#clients.values()].map((entry) => entry.client);
    this.#clients.clear();
    await Promise.allSettled(clients.map(async (client) => client.close()));
    await this.#drainOwnedWork();
    this.#accountRefreshes.clear();
    this.#accountRefreshDirty.clear();
    this.#runtimeReviews.clear();
    this.#state = "closed";
  }

  async #drainOwnedWork(): Promise<void> {
    for (;;) {
      const owned = [
        ...this.#operations,
        ...this.#lifecycleTails.values(),
        ...this.#background,
      ];
      if (owned.length === 0) return;
      await Promise.allSettled(owned);
      await Promise.resolve();
    }
  }

  async #admit<T>(operation: () => Promise<T>): Promise<T> {
    if (!this.#acceptingOperations()) {
      throw new CodexError("AUTHORITY_STALE", "The Codex runtime is closing and no longer accepts operations.");
    }
    const task = operation();
    const settled = task.then(
      () => undefined,
      () => undefined,
    );
    this.#operations.add(settled);
    try {
      return await task;
    } finally {
      this.#operations.delete(settled);
    }
  }

  #acceptingOperations(): boolean {
    return this.#state === "open";
  }

  async #client(authority: ProfileAuthority): Promise<CodexAppServerClient> { return (await this.#running(authority)).client; }

  async #hydrateRecentTurns(
    client: CodexAppServerClient,
    threadId: string,
    turns: readonly CodexTurn[],
    root: string,
    signal: AbortSignal,
  ): Promise<Readonly<{
    turns: readonly CodexTurn[];
    unreadItemTurnIds: ReadonlySet<string>;
    incompleteTurnIds: ReadonlySet<string>;
    summaryMetadataByTurn: ReadonlyMap<string, TurnSummaryMetadata>;
    compactEssentialsByTurn: ReadonlyMap<string, TurnCompactEssentials>;
  }>> {
    type HydrationState = {
      readonly turn: CodexTurn;
      readonly items: CodexThreadItem[];
      readonly seenCursors: Set<string>;
      readonly seenItemsById: Map<string, CodexThreadItem>;
      readonly summary: TurnSummaryAccumulator;
      readonly summarySeenItemFingerprints: Map<string, string>;
      firstUser?: CodexProjectedMessage;
      finalAssistant?: CodexProjectedMessage;
      nextCursor: string | null;
      pageCount: number;
      providerItemsUnread: boolean;
      summaryTailRequired: boolean;
    };
    const states: HydrationState[] = turns.map((turn) => ({
      turn,
      items: [],
      seenCursors: new Set<string>(),
      seenItemsById: new Map<string, CodexThreadItem>(),
      summary: createTurnSummaryAccumulator(),
      summarySeenItemFingerprints: new Map<string, string>(),
      nextCursor: null,
      pageCount: 0,
      providerItemsUnread: false,
      summaryTailRequired: false,
    }));
    let remainingPages = RECENT_TURN_ITEM_AGGREGATE_PAGE_LIMIT;
    let remainingTailPages = RECENT_TURN_ITEM_TAIL_PAGE_LIMIT;
    let loadedItems = 0;
    let retainedItemJsonBytes = 0;
    let forwardAdmissionOpen = true;
    let tailAdmissionOpen = true;
    const admitPageItems = (count: number): void => {
      if (count > INSPECT_ITEM_LIMIT) {
        throw new CodexError("PROTOCOL_LIMIT", "thread/items/list exceeded its requested recent-turn page limit");
      }
      loadedItems += count;
      if (loadedItems > RECENT_TURN_ITEM_AGGREGATE_LIMIT) {
        throw new CodexError("PROTOCOL_LIMIT", "recent-turn hydration exceeded its aggregate item limit");
      }
    };
    const admitRetainedItem = (item: CodexThreadItem, phase: "forward" | "tail"): boolean => {
      const bytes = jsonUtf8Bytes(item) + 1;
      const limit = phase === "forward"
        ? RECENT_TURN_FORWARD_ITEM_JSON_BYTE_LIMIT
        : RECENT_TURN_RETAINED_ITEM_JSON_BYTE_LIMIT;
      if (bytes > limit - retainedItemJsonBytes) return false;
      retainedItemJsonBytes += bytes;
      return true;
    };
    const admitCompactEssential = (message: CodexProjectedMessage): boolean => {
      const bytes = jsonUtf8Bytes(message) + 1;
      if (bytes > RECENT_TURN_RETAINED_ITEM_JSON_BYTE_LIMIT - retainedItemJsonBytes) return false;
      retainedItemJsonBytes += bytes;
      return true;
    };
    const captureStableFirstUser = (
      state: HydrationState,
      entries: readonly { readonly turnId: string; readonly item: CodexThreadItem }[],
    ): void => {
      // Only the ascending head can establish the first user. Do not scan a
      // later page or reverse tail when this bounded proof is absent.
      const firstUser = entries.find((entry) => entry.item.type === "userMessage");
      if (firstUser === undefined || firstUser.item.type !== "userMessage") return;
      const text = firstUser.item.text[0];
      if (text === undefined) return;
      const message = projectCompactMessage(
        "user",
        text,
        state.turn.id,
        firstUser.item.clientId ?? undefined,
      );
      if (!admitCompactEssential(message)) {
        state.providerItemsUnread = true;
        return;
      }
      state.firstUser = message;
    };
    const captureStableFinalAssistant = (
      state: HydrationState,
      entries: readonly { readonly turnId: string; readonly item: CodexThreadItem }[],
      order: "chronological" | "newest-first",
    ): void => {
      if (state.finalAssistant !== undefined) return;
      // A complete ascending page or the newest-first tail establishes the
      // last assistant without retaining the unread middle.
      const ordered = order === "chronological" ? [...entries].reverse() : entries;
      const finalAssistant = ordered.find((entry) => entry.item.type === "agentMessage");
      if (finalAssistant === undefined || finalAssistant.item.type !== "agentMessage") return;
      const message = projectCompactMessage(
        "assistant",
        finalAssistant.item.text,
        state.turn.id,
      );
      if (!admitCompactEssential(message)) {
        state.providerItemsUnread = true;
        return;
      }
      state.finalAssistant = message;
    };
    const captureStableSummaryPage = (
      state: HydrationState,
      entries: readonly { readonly turnId: string; readonly item: CodexThreadItem }[],
      phase: "head" | "tail",
    ): void => {
      const pageItemIds = new Set<string>();
      const summaryItems: CodexThreadItem[] = [];
      for (const entry of entries) {
        if (entry.turnId !== state.turn.id) {
          throw new CodexError("PROTOCOL_ERROR", "thread/items/list returned a summary item for a different recent turn");
        }
        if (pageItemIds.has(entry.item.id)) {
          throw new CodexError("PROTOCOL_ERROR", "thread/items/list repeated an item in one recent-turn summary page");
        }
        pageItemIds.add(entry.item.id);
        const fingerprint = fingerprintThreadItem(entry.item);
        const existing = state.summarySeenItemFingerprints.get(entry.item.id);
        if (existing !== undefined) {
          if (existing !== fingerprint) {
            throw new CodexError("PROTOCOL_ERROR", "thread/items/list changed an overlapping recent-turn summary item");
          }
          if (phase === "head") {
            throw new CodexError("PROTOCOL_ERROR", "thread/items/list repeated an item in one recent-turn head");
          }
          continue;
        }
        state.summarySeenItemFingerprints.set(entry.item.id, fingerprint);
        summaryItems.push(entry.item);
      }
      const chronologicalItems = phase === "tail" ? summaryItems.reverse() : summaryItems;
      for (const item of chronologicalItems) {
        accumulateTurnSummaryItem(state.summary, item, root);
      }
    };
    const readNextPage = async (state: HydrationState): Promise<boolean> => {
      if (signal.aborted) throw signal.reason;
      const requiredHead = state.pageCount === 0;
      if (
        remainingPages <= 0
        || state.pageCount >= RECENT_TURN_ITEM_PAGE_LIMIT
        || (!requiredHead && (
          !forwardAdmissionOpen
          || retainedItemJsonBytes >= RECENT_TURN_FORWARD_ITEM_JSON_BYTE_LIMIT
        ))
      ) {
        state.providerItemsUnread = true;
        forwardAdmissionOpen = false;
        return false;
      }
      const cursor = state.nextCursor;
      const page = await client.listThreadItems({
        threadId,
        turnId: state.turn.id,
        ...(state.pageCount === 0 ? {} : { cursor }),
        limit: INSPECT_ITEM_LIMIT,
        sortDirection: "asc",
      });
      remainingPages -= 1;
      state.pageCount += 1;
      admitPageItems(page.value.data.length);
      if (requiredHead) captureStableSummaryPage(state, page.value.data, "head");
      state.nextCursor = page.value.nextCursor;
      if (requiredHead) {
        captureStableFirstUser(state, page.value.data);
        state.summaryTailRequired = state.nextCursor !== null;
        if (state.nextCursor === null) {
          captureStableFinalAssistant(state, page.value.data, "chronological");
        }
      }
      if (state.nextCursor !== null) {
        if (state.seenCursors.has(state.nextCursor)) {
          throw new CodexError("PROTOCOL_ERROR", "thread/items/list repeated a cursor in one recent turn");
        }
        state.seenCursors.add(state.nextCursor);
      }
      if (!forwardAdmissionOpen || retainedItemJsonBytes >= RECENT_TURN_FORWARD_ITEM_JSON_BYTE_LIMIT) {
        state.providerItemsUnread = page.value.data.length > 0 || state.nextCursor !== null;
        forwardAdmissionOpen = false;
        return false;
      }
      for (const entry of page.value.data) {
        if (entry.turnId !== state.turn.id) {
          throw new CodexError("PROTOCOL_ERROR", "thread/items/list returned an item for a different recent turn");
        }
        if (state.seenItemsById.has(entry.item.id)) {
          throw new CodexError("PROTOCOL_ERROR", "thread/items/list repeated an item in one recent turn");
        }
        if (!admitRetainedItem(entry.item, "forward")) {
          state.providerItemsUnread = true;
          forwardAdmissionOpen = false;
          break;
        }
        state.seenItemsById.set(entry.item.id, entry.item);
        state.items.push(entry.item);
      }
      return forwardAdmissionOpen;
    };

    // Admit newest heads first, then give their forward continuations the
    // remaining non-tail budget.
    for (let index = states.length - 1; index >= 0; index -= 1) {
      const state = states[index];
      if (state !== undefined) await readNextPage(state);
    }
    for (let index = states.length - 1; index >= 0; index -= 1) {
      const state = states[index];
      if (state === undefined) continue;
      while (
        state.nextCursor !== null
        && state.pageCount < RECENT_TURN_ITEM_PAGE_LIMIT
        && remainingPages > 0
      ) {
        if (!await readNextPage(state)) break;
      }
    }
    // An adversarially long completed turn can exhaust the forward window
    // before its final model response. One bounded reverse page preserves that
    // tail for the compact projection. The unread middle remains explicit, but
    // is safe to omit when the final assistant response is established.
    for (let index = states.length - 1; index >= 0; index -= 1) {
      const state = states[index];
      if (state === undefined) continue;
      if (!state.summaryTailRequired && state.nextCursor === null && !state.providerItemsUnread) continue;
      if (remainingTailPages <= 0) {
        state.providerItemsUnread = true;
        continue;
      }
      if (signal.aborted) throw signal.reason;
      const tail = await client.listThreadItems({
        threadId,
        turnId: state.turn.id,
        limit: INSPECT_ITEM_LIMIT,
        sortDirection: "desc",
      });
      remainingTailPages -= 1;
      admitPageItems(tail.value.data.length);
      captureStableSummaryPage(state, tail.value.data, "tail");
      captureStableFinalAssistant(state, tail.value.data, "newest-first");
      const tailItemIds = new Set<string>();
      const newestFirstTail: CodexThreadItem[] = [];
      let tailFullyAdmitted = true;
      if (!tailAdmissionOpen || retainedItemJsonBytes >= RECENT_TURN_RETAINED_ITEM_JSON_BYTE_LIMIT) {
        state.providerItemsUnread = true;
        tailAdmissionOpen = false;
        tailFullyAdmitted = false;
      }
      for (const entry of tail.value.data) {
        if (entry.turnId !== state.turn.id) {
          throw new CodexError("PROTOCOL_ERROR", "thread/items/list returned a tail item for a different recent turn");
        }
        if (tailItemIds.has(entry.item.id)) {
          throw new CodexError("PROTOCOL_ERROR", "thread/items/list repeated an item in one recent-turn tail");
        }
        tailItemIds.add(entry.item.id);
        if (!tailFullyAdmitted) continue;
        const existing = state.seenItemsById.get(entry.item.id);
        if (existing !== undefined) {
          if (JSON.stringify(existing) !== JSON.stringify(entry.item)) {
            throw new CodexError("PROTOCOL_ERROR", "thread/items/list changed an overlapping recent-turn tail item");
          }
          continue;
        }
        if (!admitRetainedItem(entry.item, "tail")) {
          state.providerItemsUnread = true;
          tailAdmissionOpen = false;
          tailFullyAdmitted = false;
          break;
        }
        state.seenItemsById.set(entry.item.id, entry.item);
        newestFirstTail.push(entry.item);
      }
      state.items.push(...newestFirstTail.reverse());
      if (
        tailFullyAdmitted
        && tail.value.nextCursor === null
        && state.nextCursor === null
      ) {
        state.providerItemsUnread = false;
      }
    }
    const unreadItemTurnIds = new Set(
      states
        .filter((state) => state.providerItemsUnread || state.nextCursor !== null)
        .map((state) => state.turn.id),
    );
    const incompleteTurnIds = new Set(
      states
        .filter((state) =>
          state.turn.status === "completed"
          && (state.firstUser === undefined || state.finalAssistant === undefined))
        .map((state) => state.turn.id),
    );
    return {
      turns: states.map((state) => ({ ...state.turn, items: state.items })),
      unreadItemTurnIds,
      incompleteTurnIds,
      summaryMetadataByTurn: new Map(
        states.map((state) => [state.turn.id, finishTurnSummary(state.summary)]),
      ),
      compactEssentialsByTurn: new Map(
        states.map((state) => [state.turn.id, {
          ...(state.firstUser === undefined ? {} : { firstUser: state.firstUser }),
          ...(state.finalAssistant === undefined ? {} : { finalAssistant: state.finalAssistant }),
        }]),
      ),
    };
  }

  async #findTurn(
    client: CodexAppServerClient,
    threadId: string,
    turnId: string,
    signal: AbortSignal,
  ): Promise<CodexTurn> {
    let cursor: string | null = null;
    const seenCursors = new Set<string>();
    for (let pageIndex = 0; pageIndex < TURN_SEARCH_PAGE_LIMIT; pageIndex += 1) {
      if (signal.aborted) throw signal.reason;
      const page = await client.listThreadTurns({
        threadId,
        cursor,
        limit: TURN_SEARCH_PAGE_SIZE,
        sortDirection: "desc",
        itemsView: "notLoaded",
      });
      const match = page.value.data.find((candidate) => candidate.id === turnId);
      if (match !== undefined) return match;
      cursor = page.value.nextCursor;
      if (cursor === null) throw new Error("Turn was not found.");
      if (seenCursors.has(cursor)) {
        throw new CodexError("PROTOCOL_ERROR", "thread/turns/list repeated a cursor");
      }
      seenCursors.add(cursor);
    }
    throw new CodexError(
      "PROTOCOL_LIMIT",
      "Turn is outside the bounded inspection history window",
    );
  }

  async #running(authority: ProfileAuthority): Promise<RunningClient> {
    return await this.#serializeLifecycle(authority.id, async () => this.#runningLocked(authority));
  }

  async #runningLocked(authority: ProfileAuthority): Promise<RunningClient> {
    if (!this.#isCurrent(authority)) throw new Error("Codex account generation is stale.");
    const endedGeneration = this.#endedGenerationByProfile.get(authority.id);
    if (endedGeneration !== undefined && endedGeneration >= authority.generation) {
      throw new CodexError(
        "AUTHORITY_STALE",
        "The Codex process generation ended and cannot be relaunched under the same authority.",
      );
    }
    const existing = this.#clients.get(authority.id);
    if (existing?.authority.generation === authority.generation && existing.client.state === "ready") return existing;
    if (existing?.authority.generation === authority.generation) {
      throw new CodexError(
        "AUTHORITY_STALE",
        "The Codex process generation is no longer ready and cannot be reused.",
      );
    }
    return await this.#launch(authority);
  }

  async #serializeLifecycle<T>(profileId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.#lifecycleTails.get(profileId) ?? Promise.resolve();
    const task = previous.then(operation, operation);
    const settled = task.then(
      () => undefined,
      () => undefined,
    );
    this.#lifecycleTails.set(profileId, settled);
    try {
      return await task;
    } finally {
      if (this.#lifecycleTails.get(profileId) === settled) this.#lifecycleTails.delete(profileId);
    }
  }

  async #launch(authority: ProfileAuthority): Promise<RunningClient> {
    const existing = this.#clients.get(authority.id);
    if (existing !== undefined) {
      this.#clients.delete(authority.id);
      await existing.client.close();
    }
    const client = await this.#launchClient({
        authority: { profileId: authority.id, processGeneration: authority.generation },
        expectedCodexHome: authority.codexHome,
        experimentalApi: true,
        isAuthorityCurrent: () => this.#isCurrent(authority),
        onFact: async (value: FencedCodexValue<CodexFact>) => {
          if (value.value.type === "providerDisconnected") {
            this.#endedGenerationByProfile.set(
              authority.id,
              Math.max(
                this.#endedGenerationByProfile.get(authority.id) ?? 0,
                authority.generation,
              ),
            );
          }
          if (!this.#acceptingOperations()) return;
          try {
            await this.#admit(async () => {
              if (!this.#isCurrent(authority)) return;
              const fact = value.value.type === "threadNameUpdated"
                ? { ...value.value, name: value.value.name === null ? null : normalizeProviderTitle(value.value.name) }
                : value.value;
              await this.#observer.fact(authority, fact);
              if ((value.value.type === "loginCompleted" && value.value.success) || value.value.type === "accountUpdated") {
                this.#scheduleAccountRefresh(authority);
              }
            });
          } catch (error: unknown) {
            if (!this.#acceptingOperations()) return;
            throw error;
          }
        },
      });
    if (!this.#isCurrent(authority)) {
      await client.close();
      throw new Error("Codex account generation changed during launch.");
    }
    const running: RunningClient = { authority, client };
    this.#clients.set(authority.id, running);
    return running;
  }

  #scheduleAccountRefresh(authority: ProfileAuthority): void {
    if (!this.#acceptingOperations()) return;
    if (this.#accountRefreshes.has(authority.id)) {
      this.#accountRefreshDirty.add(authority.id);
      return;
    }
    const task = Promise.resolve().then(async () => {
      for (;;) {
        this.#accountRefreshDirty.delete(authority.id);
        const entry = this.#clients.get(authority.id);
        if (!this.#acceptingOperations() || entry?.authority.generation !== authority.generation || !this.#isCurrent(authority)) return;
        const account = accountProjection((await entry.client.accountRead(true)).value);
        if (!this.#acceptingOperations() || !this.#isCurrent(authority)) return;
        await this.#observer.account(authority, account);
        if (!this.#accountRefreshDirty.has(authority.id)) return;
      }
    });
    const tracked = task.then(
      () => undefined,
      () => undefined,
    );
    this.#accountRefreshes.set(authority.id, tracked);
    this.#background.add(tracked);
    void tracked.then(() => {
      if (this.#accountRefreshes.get(authority.id) === tracked) this.#accountRefreshes.delete(authority.id);
      this.#background.delete(tracked);
      if (this.#accountRefreshDirty.delete(authority.id) && this.#acceptingOperations() && this.#isCurrent(authority)) this.#scheduleAccountRefresh(authority);
    });
  }

  async #reviewedPreset(running: RunningClient, alias: "low" | "high" | "ultra", fast: boolean, cwd: string, threadId?: string): Promise<{
    preset: ResolvedPreset;
    profile: EffectiveRuntimeProfile;
  }> {
    const capabilities = await running.client.discoverCapabilities({ cwd, ...(threadId === undefined ? {} : { threadId }), includeExperimental: true });
    const preset = running.client.resolvePreset(capabilities, alias, fast);
    const profile = compileEffectiveRuntimeProfile({
      authority: running.authority,
      capabilities: capabilities.value,
      preset,
      observedAt: this.#now(),
    });
    return {
      preset,
      profile,
    };
  }

  #rememberReview(input: {
    kind: RuntimeStartReview["kind"];
    running: RunningClient;
    projectRoot: string;
    providerThreadId?: string;
    preset: ResolvedPreset;
    profile: EffectiveRuntimeProfile;
  }): RuntimeStartReview {
    const createdAt = input.profile.observedAt;
    for (const [id, pending] of this.#runtimeReviews) {
      if (createdAt - pending.createdAt > 5_000) this.#runtimeReviews.delete(id);
    }
    if (this.#runtimeReviews.size >= 64) {
      throw new CodexError("PROTOCOL_LIMIT", "Too many unconsumed runtime reviews are pending.");
    }
    const review: RuntimeStartReview = {
      reviewId: crypto.randomUUID(),
      kind: input.kind,
      effectiveRuntimeProfile: input.profile,
    };
    this.#runtimeReviews.set(review.reviewId, {
      review,
      running: input.running,
      projectRoot: input.projectRoot,
      ...(input.providerThreadId === undefined ? {} : { providerThreadId: input.providerThreadId }),
      preset: input.preset,
      createdAt,
    });
    return review;
  }

  #consumeReview(
    review: RuntimeStartReview,
    expected: {
      kind: RuntimeStartReview["kind"];
      authority: ProfileAuthority;
      projectRoot: string;
      providerThreadId?: string;
    },
  ): PendingRuntimeReview {
    const pending = this.#runtimeReviews.get(review.reviewId);
    this.#runtimeReviews.delete(review.reviewId);
    if (
      pending === undefined
      || pending.review !== review
      || pending.review.kind !== expected.kind
      || pending.running.authority.id !== expected.authority.id
      || pending.running.authority.generation !== expected.authority.generation
      || pending.projectRoot !== expected.projectRoot
      || pending.providerThreadId !== expected.providerThreadId
      || this.#clients.get(expected.authority.id) !== pending.running
      || !this.#isCurrent(expected.authority)
      || this.#now() - pending.createdAt > 5_000
    ) {
      throw new CodexError("AUTHORITY_STALE", "The reviewed runtime profile is stale or belongs to another effect authority.");
    }
    return pending;
  }

  #policy(projectRoot: string) {
    return { review: "auto_review" as const, permissionProfile: ":workspace" as const, writableRoots: [projectRoot] };
  }
}
