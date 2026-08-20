#!/usr/bin/env bun

import { appendFileSync } from "node:fs";
import { basename, dirname } from "node:path";

type JsonObject = Record<string, unknown>;

const codexHome = process.env.CODEX_HOME ?? process.cwd();
const accountProfileId = basename(dirname(codexHome));
const accountSuffix = accountProfileId.slice(-4);
const usedPercent = accountSuffix.endsWith("0001") ? 11 : 22;
const chatFixture = accountProfileId.includes("_chat_");
const chatFixtureLog = `${codexHome}/chat-fixture.jsonl`;
let nextThread = 0;
let nextTurn = 0;
const interactionTurns = new Set<string>();

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function write(value: JsonObject): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function appendChatLog(value: JsonObject): void {
  if (!chatFixture) return;
  appendFileSync(chatFixtureLog, `${JSON.stringify(value)}\n`, { encoding: "utf8" });
}

function stringField(value: unknown, key: string): string | null {
  if (!isJsonObject(value)) return null;
  const field = value[key];
  return typeof field === "string" ? field : null;
}

function turnKey(threadId: string, turnId: string): string {
  return `${threadId}\u0000${turnId}`;
}

function activeTurn(turnId: string) {
  return {
    id: turnId,
    items: [],
    itemsView: "full",
    status: "inProgress",
    startedAt: 1_800_000_000,
    completedAt: null,
  };
}

function chatThread(threadId: string, cwd: string) {
  return {
    id: threadId,
    ephemeral: false,
    historyMode: "legacy",
    preview: "Chat fixture",
    createdAt: 1_800_000_000,
    updatedAt: 1_800_000_000,
    status: { type: "idle", activeFlags: [] },
    cwd,
    threadSource: null,
    name: null,
    turns: [],
  };
}

function fileChangeItem(itemId: string, status: "inProgress" | "completed") {
  return {
    type: "fileChange",
    id: itemId,
    status,
    changes: [],
  };
}

function rateLimit() {
  return {
    limitId: `limit-${accountSuffix}`,
    limitName: `Account ${accountSuffix}`,
    primary: {
      usedPercent,
      windowDurationMins: 300,
      resetsAt: 1_800_000_000,
    },
    secondary: null,
    credits: null,
    individualLimit: null,
    planType: accountSuffix.endsWith("0001") ? "plus" : "pro",
    rateLimitReachedType: null,
  };
}

async function handle(line: string): Promise<void> {
  const message: unknown = JSON.parse(line);
  if (!isJsonObject(message)) return;
  const id = message.id;
  const method = message.method;
  if ((typeof id !== "string" && typeof id !== "number")) return;
  if (typeof method !== "string") {
    appendChatLog({ method: "server-response", kind: "error" in message ? "error" : "result" });
    return;
  }
  switch (method) {
    case "initialize":
      appendChatLog({ method });
      write({
        id,
        result: {
          userAgent: "oprte-account-fixture/1",
          codexHome,
          platformFamily: "unix",
          platformOs: "macos",
        },
      });
      return;
    case "account/read":
      if (chatFixture) await Bun.sleep(250);
      write({
        id,
        result: {
          account: {
            type: "chatgpt",
            email: `${accountSuffix}@example.test`,
            planType: accountSuffix.endsWith("0001") ? "plus" : "pro",
          },
          requiresOpenaiAuth: true,
        },
      });
      return;
    case "account/rateLimits/read":
      write({
        id,
        result: {
          rateLimits: rateLimit(),
          rateLimitsByLimitId: { [`limit-${accountSuffix}`]: rateLimit() },
          rateLimitResetCredits: null,
        },
      });
      return;
    case "account/usage/read":
      if (!chatFixture) {
        write({ id, error: { code: -32_601, message: "unsupported fixture method" } });
        return;
      }
      write({
        id,
        result: {
          summary: {
            lifetimeTokens: 0,
            peakDailyTokens: 0,
            longestRunningTurnSec: 0,
            currentStreakDays: 0,
            longestStreakDays: 0,
          },
          dailyUsageBuckets: [],
        },
      });
      return;
    case "account/logout":
      if (!chatFixture) {
        write({ id, error: { code: -32_601, message: "unsupported fixture method" } });
        return;
      }
      appendChatLog({ method });
      write({ id, result: {} });
      return;
    case "model/list":
      appendChatLog({ method });
      write({
        id,
        result: {
          data: [{
            model: "gpt-5.6-sol",
            supportedReasoningEfforts: [
              { reasoningEffort: "ultra" },
              { reasoningEffort: "max" },
            ],
          }],
          nextCursor: null,
        },
      });
      appendChatLog({ method: "model/list-sent", id: String(id) });
      return;
    case "configRequirements/read":
      appendChatLog({ method });
      write({ id, result: { requirements: null } });
      return;
    case "thread/start": {
      const cwd = stringField(message.params, "cwd");
      const model = stringField(message.params, "model");
      if (cwd === null || model === null) {
        write({ id, error: { code: -32_602, message: "missing thread admission" } });
        return;
      }
      const config = isJsonObject(message.params) && isJsonObject(message.params.config)
        ? message.params.config
        : null;
      const reasoningEffort = stringField(config, "model_reasoning_effort") ?? "max";
      const serviceTier = stringField(message.params, "serviceTier");
      const threadId = `chat-thread-${String(++nextThread)}`;
      appendChatLog({
        method,
        threadId,
        model,
        reasoningEffort,
        serviceTier,
        approvalPolicy: stringField(message.params, "approvalPolicy"),
        approvalsReviewer: stringField(message.params, "approvalsReviewer"),
        sandbox: stringField(message.params, "sandbox"),
      });
      write({
        id,
        result: {
          thread: chatThread(threadId, cwd),
          model,
          reasoningEffort,
          serviceTier,
          approvalPolicy: "never",
          approvalsReviewer: "auto_review",
          sandbox: { type: "dangerFullAccess" },
        },
      });
      return;
    }
    case "thread/name/set":
      write({ id, result: {} });
      return;
    case "turn/start": {
      const threadId = stringField(message.params, "threadId");
      if (threadId === null) {
        write({ id, error: { code: -32_602, message: "missing thread" } });
        return;
      }
      const turnId = `chat-turn-${String(++nextTurn)}`;
      const itemId = `chat-item-${String(nextTurn)}`;
      const reasoningItemId = `chat-reasoning-${String(nextTurn)}`;
      const inputValues: readonly unknown[] =
        isJsonObject(message.params) && Array.isArray(message.params.input)
          ? message.params.input
          : [];
      const input = inputValues[0] ?? null;
      const prompt = stringField(input, "text") ?? "";
      appendChatLog({
        method,
        threadId,
        turnId,
        model: stringField(message.params, "model"),
        effort: stringField(message.params, "effort"),
        approvalPolicy: stringField(message.params, "approvalPolicy"),
        approvalsReviewer: stringField(message.params, "approvalsReviewer"),
        sandboxType: isJsonObject(message.params) && isJsonObject(message.params.sandboxPolicy)
          ? stringField(message.params.sandboxPolicy, "type")
          : null,
      });
      const turn = activeTurn(turnId);
      write({ method: "turn/started", params: { threadId, turn } });
      if (prompt.includes("hold active")) {
        write({ id, result: { turn } });
        appendChatLog({ method: "turn/held", threadId, turnId });
        return;
      }
      if (prompt.includes("interaction")) {
        interactionTurns.add(turnKey(threadId, turnId));
        write({ id, result: { turn } });
        setTimeout(() => {
          write({
            id: `chat-request-${String(nextTurn)}`,
            method: "item/tool/requestUserInput",
            params: {
              threadId,
              turnId,
              itemId,
              questions: [{
                id: "fixture-choice",
                header: "Choice",
                question: "Choose one",
                isOther: false,
                isSecret: false,
                options: [{ label: "One", description: "Continue" }],
              }],
              autoResolutionMs: 60_000,
            },
          });
        }, 5);
        return;
      }
      const reasoning = "Thinking 🌿";
      const escapedResponsePrefix = "\\".repeat(4_096);
      const response = "α🙂".repeat(3_000);
      const completedResponse = `${escapedResponsePrefix}${response}`;
      write({
        method: "item/reasoning/summaryTextDelta",
        params: {
          threadId,
          turnId,
          itemId: reasoningItemId,
          delta: reasoning,
          summaryIndex: 0,
        },
      });
      write({
        method: "item/completed",
        params: {
          threadId,
          turnId,
          item: {
            type: "reasoning",
            id: reasoningItemId,
            summary: [reasoning],
            content: [],
          },
          completedAtMs: 1_800_000_000_998,
        },
      });
      write({
        method: "item/started",
        params: {
          threadId,
          turnId,
          item: fileChangeItem(`tool-${String(nextTurn)}`, "inProgress"),
          startedAtMs: 1_800_000_000_000,
        },
      });
      write({
        method: "item/agentMessage/delta",
        params: { threadId, turnId, itemId, delta: escapedResponsePrefix },
      });
      write({
        method: "item/agentMessage/delta",
        params: { threadId, turnId, itemId, delta: response },
      });
      write({
        method: "item/completed",
        params: {
          threadId,
          turnId,
          item: {
            type: "agentMessage",
            id: itemId,
            text: completedResponse,
            phase: "final_answer",
            memoryCitation: null,
          },
          completedAtMs: 1_800_000_000_999,
        },
      });
      write({
        method: "item/completed",
        params: {
          threadId,
          turnId,
          item: fileChangeItem(`tool-${String(nextTurn)}`, "completed"),
          completedAtMs: 1_800_000_001_000,
        },
      });
      write({ id, result: { turn } });
      setTimeout(() => {
        write({
          method: "turn/completed",
          params: {
            threadId,
            turn: {
              ...turn,
              items: [],
              status: "completed",
              completedAt: 1_800_000_001,
            },
          },
        });
        appendChatLog({ method: "turn/completed", threadId, turnId });
      }, 5);
      return;
    }
    case "turn/interrupt": {
      const threadId = stringField(message.params, "threadId");
      const turnId = stringField(message.params, "turnId");
      appendChatLog({ method, threadId, turnId });
      write({ id, result: {} });
      if (
        threadId !== null &&
        turnId !== null &&
        interactionTurns.delete(turnKey(threadId, turnId))
      ) {
        setTimeout(() => {
          write({
            method: "turn/completed",
            params: {
              threadId,
              turn: {
                ...activeTurn(turnId),
                status: "interrupted",
                completedAt: 1_800_000_001,
              },
            },
          });
          appendChatLog({ method: "turn/completed", threadId, turnId });
        }, 5);
      }
      return;
    }
    default:
      write({ id, error: { code: -32_601, message: "unsupported fixture method" } });
  }
}

const decoder = new TextDecoder();
let buffer = "";
for await (const chunk of Bun.stdin.stream()) {
  buffer += decoder.decode(chunk, { stream: true });
  let newline = buffer.indexOf("\n");
  while (newline >= 0) {
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (line.length > 0) await handle(line);
    newline = buffer.indexOf("\n");
  }
}
