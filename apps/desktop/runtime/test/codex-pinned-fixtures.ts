import type { PinnedCodexThread, PinnedCodexTurn } from "../src/codex";

export const pinnedThreadItemFixture = {
  type: "agentMessage",
  id: "item-1",
  text: "Bounded assistant text",
  phase: "final_answer",
  memoryCitation: null,
} as const;

export const pinnedRawThreadItemFixtures = [
  {
    type: "userMessage",
    id: "item-user",
    clientId: null,
    content: [{ type: "text", text: "Hello", text_elements: [] }],
  },
  {
    type: "hookPrompt",
    id: "item-hook",
    fragments: [{ text: "Hook", hookRunId: "hook-run-1" }],
  },
  pinnedThreadItemFixture,
  { type: "plan", id: "item-plan", text: "Plan" },
  { type: "reasoning", id: "item-reasoning", summary: ["Summary"], content: [] },
  {
    type: "commandExecution",
    id: "item-command",
    command: "pwd",
    cwd: "/tmp/oprte-worktree",
    processId: null,
    source: "agent",
    status: "completed",
    commandActions: [],
    aggregatedOutput: "/tmp/oprte-worktree",
    exitCode: 0,
    durationMs: 1,
  },
  { type: "fileChange", id: "item-file", changes: [], status: "completed" },
  {
    type: "mcpToolCall",
    id: "item-mcp",
    server: "fixture-server",
    tool: "fixture-tool",
    status: "completed",
    arguments: {},
    appContext: null,
    pluginId: null,
    result: null,
    error: null,
    durationMs: 1,
  },
  {
    type: "dynamicToolCall",
    id: "item-dynamic",
    namespace: null,
    tool: "fixture-tool",
    arguments: {},
    status: "completed",
    contentItems: [],
    success: true,
    durationMs: 1,
  },
  {
    type: "collabAgentToolCall",
    id: "item-collab",
    tool: "wait",
    status: "completed",
    senderThreadId: "thread-1",
    receiverThreadIds: [],
    prompt: null,
    model: null,
    reasoningEffort: null,
    agentsStates: {},
  },
  {
    type: "subAgentActivity",
    id: "item-subagent",
    kind: "started",
    agentThreadId: "thread-2",
    agentPath: "/root/worker",
  },
  { type: "webSearch", id: "item-web", query: "OPRTE", action: null },
  { type: "imageView", id: "item-image-view", path: "/tmp/image.png" },
  { type: "sleep", id: "item-sleep", durationMs: 1 },
  {
    type: "imageGeneration",
    id: "item-image-generation",
    status: "completed",
    revisedPrompt: null,
    result: "image-result",
  },
  { type: "enteredReviewMode", id: "item-review-entered", review: "Review" },
  { type: "exitedReviewMode", id: "item-review-exited", review: "Review" },
  { type: "contextCompaction", id: "item-compaction" },
] as const;

export const pinnedTurnFixture: PinnedCodexTurn & Readonly<{
  status: "completed";
}> = {
  id: "turn-1",
  items: [pinnedThreadItemFixture],
  itemsView: "full",
  status: "completed",
  startedAt: 1_700_000_000,
  completedAt: 1_700_000_001,
};

export const pinnedThreadFixture: PinnedCodexThread & Readonly<{
  ephemeral: false;
  historyMode: "paginated";
  threadSource: string;
}> = {
  id: "thread-1",
  ephemeral: false,
  historyMode: "paginated",
  preview: "Pinned thread",
  createdAt: 1_700_000_000,
  updatedAt: 1_700_000_001,
  status: { type: "idle" },
  cwd: "/tmp/oprte-worktree",
  threadSource: "oprte_fixture_thread_1",
  name: "Pinned thread",
  turns: [pinnedTurnFixture],
};

export const pinnedRateLimitSnapshotFixture = {
  limitId: "codex",
  limitName: "Codex",
  primary: {
    usedPercent: 25,
    windowDurationMins: 300,
    resetsAt: 1_700_000_000,
  },
  secondary: null,
  credits: { hasCredits: true, unlimited: false, balance: "12.50" },
  individualLimit: null,
  planType: "plus",
  rateLimitReachedType: null,
} as const;

export const pinnedRateLimitsFixture = {
  rateLimits: pinnedRateLimitSnapshotFixture,
  rateLimitsByLimitId: { codex: pinnedRateLimitSnapshotFixture },
  rateLimitResetCredits: {
    availableCount: 2n,
    credits: [{
      id: "credit-1",
      resetType: "codexRateLimits",
      status: "available",
      grantedAt: 1_700_000_000,
      expiresAt: 1_700_086_400,
      title: "Reset",
      description: "One reset credit",
    }],
  },
} as const;

export const pinnedTokenUsageFixture = {
  summary: {
    lifetimeTokens: 12_345n,
    peakDailyTokens: 1_000n,
    longestRunningTurnSec: 120n,
    currentStreakDays: 3n,
    longestStreakDays: 8n,
  },
  dailyUsageBuckets: [{ startDate: "2026-07-29", tokens: 99n }],
} as const;

export const pinnedCommandApprovalFixture = {
  threadId: "thread-1",
  turnId: "turn-1",
  itemId: "item-1",
  startedAtMs: 1_700_000_000_000,
  environmentId: null,
  approvalId: null,
  reason: null,
  networkApprovalContext: null,
  command: "pwd",
  cwd: "/tmp/oprte-worktree",
  commandActions: [],
  proposedExecpolicyAmendment: null,
  proposedNetworkPolicyAmendments: null,
} as const;

export const pinnedFileChangeApprovalFixture = {
  threadId: "thread-1",
  turnId: "turn-1",
  itemId: "item-2",
  startedAtMs: 1_700_000_000_000,
  reason: null,
  grantRoot: "/tmp/oprte-worktree",
} as const;

export const pinnedUserInputRequestFixture = {
  threadId: "thread-1",
  turnId: "turn-1",
  itemId: "item-3",
  questions: [{
    id: "question-1",
    header: "Choice",
    question: "Choose one",
    isOther: false,
    isSecret: false,
    options: [{ label: "One", description: "First choice" }],
  }],
  autoResolutionMs: 60_000,
} as const;

export const pinnedMcpElicitationFixture = {
  threadId: "thread-1",
  turnId: "turn-1",
  serverName: "fixture-server",
  mode: "url",
  _meta: null,
  message: "Open the fixture",
  url: "https://example.com/fixture",
  elicitationId: "elicitation-1",
} as const;

export const pinnedPermissionsApprovalFixture = {
  threadId: "thread-1",
  turnId: "turn-1",
  itemId: "item-4",
  startedAtMs: 1_700_000_000_000,
  environmentId: null,
  cwd: "/tmp/oprte-worktree",
  reason: null,
  permissions: {
    network: { enabled: true },
    fileSystem: { read: [], write: [], entries: [] },
  },
} as const;

export const pinnedApplyPatchApprovalFixture = {
  conversationId: "thread-1",
  callId: "call-1",
  fileChanges: {
    "/tmp/oprte-worktree/file.txt": { type: "add", content: "fixture" },
  },
  reason: null,
  grantRoot: "/tmp/oprte-worktree",
} as const;

export const pinnedExecCommandApprovalFixture = {
  conversationId: "thread-1",
  callId: "call-2",
  approvalId: null,
  command: ["pwd"],
  cwd: "/tmp/oprte-worktree",
  reason: null,
  parsedCmd: [{ type: "unknown", cmd: "pwd" }],
} as const;
