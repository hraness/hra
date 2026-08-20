import { describe, expect, test } from "bun:test";

import {
  CodexJsonlWriter,
  PinnedCodexPayloadError,
  PinnedCodexProtocol,
  pinnedCodexRequests,
  type CodexJsonlSink,
  type CodexProtocolDiagnostic,
  type CodexServerRequest,
  type PinnedCodexRequestDescriptor,
  type PinnedCodexRequestKey,
  type PinnedCodexRequestSemantics,
} from "../src/codex";
import {
  pinnedRateLimitsFixture,
  pinnedRawThreadItemFixtures,
  pinnedThreadFixture,
  pinnedTokenUsageFixture,
  pinnedTurnFixture,
  pinnedUserInputRequestFixture,
} from "./codex-pinned-fixtures";

const decoder = new TextDecoder();

class MemorySink implements CodexJsonlSink {
  readonly writes: string[] = [];

  write(bytes: Uint8Array): number {
    this.writes.push(decoder.decode(bytes));
    return bytes.byteLength;
  }
}

function written(sink: MemorySink, index = sink.writes.length - 1): Record<string, unknown> {
  const line = sink.writes[index];
  if (line === undefined) throw new Error(`missing write ${String(index)}`);
  const parsed: unknown = JSON.parse(line);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("written envelope is not an object");
  }
  return parsed as Record<string, unknown>;
}

const initializeInput = {
  clientInfo: { name: "oprte", title: "OPRTE", version: "0.1.0" },
  capabilities: {
    experimentalApi: false,
    requestAttestation: false,
    optOutNotificationMethods: [],
  },
} as const;

const initializeOutput = {
  userAgent: "codex-cli/0.144.6",
  codexHome: "/tmp/oprte-codex-home",
  platformFamily: "unix",
  platformOs: "macos",
} as const;

interface CodecCase {
  readonly key: PinnedCodexRequestKey;
  readonly input: unknown;
  readonly invalidInput: unknown;
  readonly output: unknown;
  readonly invalidOutput: unknown;
}

const pinnedThreadAdmissionProfile = Object.freeze({
  model: "gpt-5.6-sol",
  reasoningEffort: "ultra",
  serviceTier: null,
  approvalPolicy: "on-request",
  approvalsReviewer: "user",
  sandbox: Object.freeze({
    type: "workspaceWrite" as const,
    writableRoots: ["/tmp/oprte-worktree"],
    networkAccess: false,
    excludeTmpdirEnvVar: false,
    excludeSlashTmp: false,
  }),
  runtimeWorkspaceRoots: Object.freeze(["/tmp/oprte-shared-documents"]),
});

const codecCases: readonly CodecCase[] = [
  {
    key: "clientInitialize",
    input: initializeInput,
    invalidInput: { ...initializeInput, clientInfo: { name: "", title: null, version: "0.1.0" } },
    output: initializeOutput,
    invalidOutput: { ...initializeOutput, codexHome: "relative/home" },
  },
  {
    key: "accountLoginStart",
    input: {
      type: "chatgpt",
      codexStreamlinedLogin: true,
      useHostedLoginSuccessPage: true,
      appBrand: "codex",
    },
    invalidInput: { type: "chatgpt", appBrand: "unknown" },
    output: { type: "chatgpt", loginId: "login-1", authUrl: "https://auth.openai.com/oauth" },
    invalidOutput: { type: "chatgpt", loginId: "", authUrl: "javascript:alert(1)" },
  },
  {
    key: "accountLoginCancel",
    input: { loginId: "login-1" },
    invalidInput: { loginId: "" },
    output: { status: "canceled" },
    invalidOutput: { status: "cancelled" },
  },
  {
    key: "accountLogout",
    input: undefined,
    invalidInput: {},
    output: {},
    invalidOutput: { retained: true },
  },
  {
    key: "accountRead",
    input: { refreshToken: false },
    invalidInput: { refreshToken: "false" },
    output: {
      account: { type: "chatgpt", email: "person@example.com", planType: "plus" },
      requiresOpenaiAuth: true,
    },
    invalidOutput: { account: null, requiresOpenaiAuth: "yes" },
  },
  {
    key: "accountRateLimitsRead",
    input: undefined,
    invalidInput: {},
    output: pinnedRateLimitsFixture,
    invalidOutput: {
      ...pinnedRateLimitsFixture,
      rateLimitResetCredits: { availableCount: "2", credits: [] },
    },
  },
  {
    key: "accountUsageRead",
    input: undefined,
    invalidInput: null,
    output: pinnedTokenUsageFixture,
    invalidOutput: {
      ...pinnedTokenUsageFixture,
      summary: { ...pinnedTokenUsageFixture.summary, lifetimeTokens: "12345" },
    },
  },
  {
    key: "threadList",
    input: {
      cursor: null,
      limit: 64,
      sortKey: "updated_at",
      sortDirection: "desc",
      sourceKinds: ["appServer"],
      archived: false,
      cwd: "/tmp/oprte-worktree",
    },
    invalidInput: { cwd: "relative/worktree" },
    output: { data: [pinnedThreadFixture], nextCursor: null, backwardsCursor: "previous" },
    invalidOutput: { data: [pinnedThreadFixture], nextCursor: null },
  },
  {
    key: "threadStart",
    input: {
      cwd: "/tmp/oprte-worktree",
      runtimeWorkspaceRoots: ["/tmp/oprte-shared-documents"],
      approvalPolicy: "on-request",
      approvalsReviewer: "user",
      sandbox: "workspace-write",
      serviceTier: "fast",
      ephemeral: false,
      historyMode: "paginated",
      threadSource: "oprte_thread_start_fixture",
    },
    invalidInput: { cwd: "relative/worktree" },
    output: { thread: pinnedThreadFixture, ...pinnedThreadAdmissionProfile },
    invalidOutput: {
      thread: {
        ...pinnedThreadFixture,
        turns: [{ ...pinnedTurnFixture, items: [{ type: "futureItem", id: "item-2" }] }],
      },
    },
  },
  {
    key: "scheduleInterpreterThreadStart",
    input: {
      cwd: "/tmp/hra-schedule-interpreter",
      runtimeWorkspaceRoots: ["/tmp/hra-schedule-interpreter"],
      approvalPolicy: "never",
      approvalsReviewer: "auto_review",
      sandbox: "read-only",
      ephemeral: true,
      historyMode: "paginated",
      threadSource: "appServer",
      environments: [],
      selectedCapabilityRoots: [],
    },
    invalidInput: { cwd: "relative/interpreter" },
    output: { thread: pinnedThreadFixture, ...pinnedThreadAdmissionProfile },
    invalidOutput: {
      thread: {
        ...pinnedThreadFixture,
        turns: [{ ...pinnedTurnFixture, items: [{ type: "futureItem", id: "item-2" }] }],
      },
    },
  },
  {
    key: "threadResume",
    input: {
      threadId: "thread-1",
      cwd: "/tmp/oprte-worktree",
      runtimeWorkspaceRoots: ["/tmp/oprte-shared-documents"],
      approvalPolicy: "on-request",
      approvalsReviewer: "user",
      sandbox: "workspace-write",
      serviceTier: "fast",
    },
    invalidInput: { threadId: "thread-1", cwd: "relative/worktree" },
    output: { thread: pinnedThreadFixture, ...pinnedThreadAdmissionProfile },
    invalidOutput: { thread: { ...pinnedThreadFixture, cwd: "relative/worktree" } },
  },
  {
    key: "threadArchive",
    input: { threadId: "thread-1" },
    invalidInput: { threadId: "" },
    output: {},
    invalidOutput: { archived: true },
  },
  {
    key: "threadRead",
    input: { threadId: "thread-1", includeTurns: true },
    invalidInput: { threadId: "thread-1" },
    output: {
      thread: {
        ...pinnedThreadFixture,
        turns: [{
          ...pinnedTurnFixture,
          items: [{
            type: "userMessage",
            id: "user-message-1",
            clientId: "oprte-client-message-1",
            content: [{ type: "text", text: "Hello", text_elements: [] }],
          }],
        }],
      },
    },
    invalidOutput: {
      thread: {
        ...pinnedThreadFixture,
        turns: [{ ...pinnedTurnFixture, itemsView: "partial" }],
      },
    },
  },
  {
    key: "threadHistoryRead",
    input: { threadId: "thread-1", includeTurns: true },
    invalidInput: { threadId: "thread-1", includeTurns: "yes" },
    output: {
      thread: {
        ...pinnedThreadFixture,
        turns: [{
          ...pinnedTurnFixture,
          items: [{
            type: "userMessage",
            id: "user-message-1",
            clientId: "oprte-client-message-1",
            content: [{ type: "text", text: "Visible prompt", text_elements: [] }],
          }, {
            type: "agentMessage",
            id: "agent-message-1",
            text: "Visible response",
            phase: "final_answer",
            memoryCitation: null,
          }],
        }],
      },
    },
    invalidOutput: {
      thread: {
        ...pinnedThreadFixture,
        turns: [{ ...pinnedTurnFixture, itemsView: "partial" }],
      },
    },
  },
  {
    key: "threadTurnsList",
    input: {
      threadId: "thread-1",
      cursor: "turn-cursor-1",
      limit: 64,
      sortDirection: "desc",
      itemsView: "notLoaded",
    },
    invalidInput: { threadId: "thread-1", limit: 129 },
    output: {
      data: [{ ...pinnedTurnFixture, items: [], itemsView: "notLoaded" }],
      nextCursor: "turn-cursor-2",
      backwardsCursor: "turn-cursor-back",
    },
    invalidOutput: {
      data: [{ ...pinnedTurnFixture, itemsView: "partial" }],
      nextCursor: null,
      backwardsCursor: null,
    },
  },
  {
    key: "threadItemsList",
    input: {
      threadId: "thread-1",
      turnId: "turn-1",
      cursor: null,
      limit: 256,
      sortDirection: "asc",
    },
    invalidInput: { threadId: "thread-1", limit: 257 },
    output: {
      data: [{
        type: "userMessage",
        id: "message-1",
        clientId: "message-12345678",
        content: [{ type: "text", text: "Visible prompt", text_elements: [] }],
      }, {
        type: "agentMessage",
        id: "message-2",
        text: "Visible response",
        phase: "final_answer",
        memoryCitation: null,
      }],
      nextCursor: null,
      backwardsCursor: "item-cursor-back",
    },
    invalidOutput: {
      data: [{ type: "futureItem", id: "item-1" }],
      nextCursor: null,
      backwardsCursor: null,
    },
  },
  {
    key: "threadFork",
    input: {
      threadId: "thread-1",
      lastTurnId: "turn-1",
      cwd: "/tmp/oprte-worktree-child",
      approvalPolicy: "never",
      approvalsReviewer: "auto_review",
      sandbox: "read-only",
      developerInstructions: "Bounded child overlay.",
      ephemeral: false,
    },
    invalidInput: { threadId: "thread-1", cwd: "relative/worktree" },
    output: { thread: pinnedThreadFixture },
    invalidOutput: { thread: { ...pinnedThreadFixture, cwd: "relative/worktree" } },
  },
  {
    key: "threadGoalSet",
    input: {
      threadId: "thread-1",
      objective: "Finish the bounded task.",
      status: "active",
      tokenBudget: 50_000,
    },
    invalidInput: { threadId: "thread-1", status: "running" },
    output: {
      goal: {
        threadId: "thread-1",
        objective: "Finish the bounded task.",
        status: "active",
        tokenBudget: 50_000,
        tokensUsed: 0,
        timeUsedSeconds: 0,
        createdAt: 1_753_000_000,
        updatedAt: 1_753_000_001,
      },
    },
    invalidOutput: { goal: { threadId: "thread-1", status: "active" } },
  },
  {
    key: "threadGoalGet",
    input: { threadId: "thread-1" },
    invalidInput: { threadId: "" },
    output: { goal: null },
    invalidOutput: { goal: false },
  },
  {
    key: "threadGoalClear",
    input: { threadId: "thread-1" },
    invalidInput: { threadId: "", extra: true },
    output: { cleared: true },
    invalidOutput: { cleared: "yes" },
  },
  {
    key: "threadSetName",
    input: { threadId: "thread-1", name: "OPRTE pane" },
    invalidInput: { threadId: "thread-1", name: "" },
    output: {},
    invalidOutput: { renamed: true },
  },
  {
    key: "threadInjectItems",
    input: {
      threadId: "thread-1",
      items: [
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "Earlier prompt" }],
        },
        {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "Earlier response" }],
        },
      ],
    },
    invalidInput: {
      threadId: "thread-1",
      items: [{
        type: "message",
        role: "assistant",
        content: [{ type: "input_text", text: "Wrong assistant content" }],
      }],
    },
    output: {},
    invalidOutput: { injected: 2 },
  },
  {
    key: "modelList",
    input: { cursor: null, limit: 2, includeHidden: false },
    invalidInput: { cursor: null, limit: 0, includeHidden: false },
    output: {
      data: [{
        model: "gpt-5.6-sol",
        supportedReasoningEfforts: [
          { reasoningEffort: "ultra" },
          { reasoningEffort: "max" },
        ],
        serviceTiers: [{
          id: "fast",
          name: "Fast",
          description: "Faster model inference with higher credit use.",
        }],
      }],
      nextCursor: null,
    },
    invalidOutput: {
      data: [{
        model: "gpt-5.6-sol",
        supportedReasoningEfforts: [{ reasoningEffort: "" }],
      }],
      nextCursor: null,
    },
  },
  {
    key: "configRequirementsRead",
    input: undefined,
    invalidInput: {},
    output: {
      requirements: {
        allowedApprovalPolicies: ["never"],
        allowedApprovalsReviewers: ["auto_review"],
        allowedSandboxModes: ["danger-full-access"],
      },
    },
    invalidOutput: {
      requirements: {
        allowedApprovalPolicies: ["always"],
        allowedApprovalsReviewers: ["auto_review"],
        allowedSandboxModes: ["danger-full-access"],
      },
    },
  },
  {
    key: "mcpServerStatusList",
    input: {
      cursor: null,
      limit: 64,
      detail: "toolsAndAuthOnly",
      threadId: "thread-1",
    },
    invalidInput: { limit: 65 },
    output: {
      data: [{
        name: "node_repl",
        serverInfo: {
          name: "node_repl",
          title: "Node REPL",
          version: "1.0.0",
          description: null,
          icons: null,
          websiteUrl: null,
        },
        tools: {
          js: {
            name: "js",
            description: "Run JavaScript in the trusted Node REPL.",
            inputSchema: { type: "object" },
          },
        },
        resources: [],
        resourceTemplates: [],
        authStatus: "unsupported",
      }],
      nextCursor: null,
    },
    invalidOutput: {
      data: [{
        name: "node_repl",
        serverInfo: null,
        tools: { js: { name: "", inputSchema: {} } },
        resources: [],
        resourceTemplates: [],
        authStatus: "unsupported",
      }],
      nextCursor: null,
    },
  },
  {
    key: "turnStart",
    input: {
      threadId: "thread-1",
      clientUserMessageId: "message-12345678",
      input: [{ type: "text", text: "Hello", text_elements: [] }],
      serviceTier: "fast",
    },
    invalidInput: {
      threadId: "thread-1",
      input: [{ type: "text", text: "Hello", text_elements: [{}] }],
    },
    output: { turn: pinnedTurnFixture },
    invalidOutput: { turn: { ...pinnedTurnFixture, startedAt: -1 } },
  },
  {
    key: "turnSteer",
    input: {
      threadId: "thread-1",
      expectedTurnId: "turn-1",
      clientUserMessageId: "message-12345678",
      input: [{ type: "text", text: "Continue", text_elements: [] }],
    },
    invalidInput: {
      threadId: "thread-1",
      expectedTurnId: "",
      input: [{ type: "text", text: "Continue", text_elements: [] }],
    },
    output: { turnId: "turn-1" },
    invalidOutput: { turnId: "" },
  },
  {
    key: "turnInterrupt",
    input: { threadId: "thread-1", turnId: "turn-1" },
    invalidInput: { threadId: "", turnId: "turn-1" },
    output: {},
    invalidOutput: { interrupted: true },
  },
];

describe("pinned Codex request registry", () => {
  test("closes all twenty-seven operations with internally consistent policy", () => {
    expect(Object.keys(pinnedCodexRequests)).toHaveLength(28);
    for (const { key } of codecCases) {
      const selected = pinnedCodexRequests[key];
      expect(selected.key).toBe(key);
      expect(selected.semantics.timeoutMs).toBeGreaterThan(0);
      expect(
        selected.semantics.effect === "read"
          ? selected.semantics.lostResponse
          : "ambiguous",
      ).toBe(
        selected.semantics.lostResponse,
      );
    }
    expect(pinnedCodexRequests.threadResume).toMatchObject({
      semantics: {
        effect: "non-idempotent-mutation",
        lostResponse: "ambiguous",
        concurrency: "per-thread",
        reconciliation: { kind: "unsupported", strategy: "thread-read" },
      },
    });
    expect(pinnedCodexRequests.turnStart.semantics.reconciliation).toEqual({
      kind: "automatic",
      strategy: "exhaustive-stable-client-message-id-scan",
    });
    expect(pinnedCodexRequests.threadRead).toMatchObject({
      semantics: {
        effect: "read",
        lostResponse: "safe-to-retry",
        concurrency: "parallel",
        reconciliation: "not-required",
      },
    });
    expect(pinnedCodexRequests.threadHistoryRead.semantics).toEqual(
      pinnedCodexRequests.threadRead.semantics,
    );
    expect(pinnedCodexRequests.threadTurnsList.semantics).toEqual(
      pinnedCodexRequests.threadRead.semantics,
    );
    expect(pinnedCodexRequests.threadItemsList.semantics).toEqual(
      pinnedCodexRequests.threadRead.semantics,
    );
    expect(pinnedCodexRequests.turnInterrupt.semantics.reconciliation).toEqual({
      kind: "automatic",
      strategy: "terminal-turn-observation",
    });
  });

  test("retains only representable text plus content-free exact history evidence", () => {
    const output = pinnedCodexRequests.threadHistoryRead.outputCodec.parse(
      codecCases.find(({ key }) => key === "threadHistoryRead")!.output,
    );
    expect(output.thread.turns[0]?.items).toMatchObject([
      {
        type: "userMessage",
        id: "user-message-1",
        clientId: "oprte-client-message-1",
        context: { kind: "plainText", text: "Visible prompt" },
      },
      {
        type: "agentMessage",
        id: "agent-message-1",
        phase: "final_answer",
        context: { kind: "plainTextFinal", text: "Visible response" },
        text: "Visible response",
      },
    ]);
    for (const item of output.thread.turns[0]?.items ?? []) {
      expect(item.providerEvidenceDigest).toMatch(/^[a-f0-9]{64}$/u);
    }
  });

  test("canonicalizes lossless item metadata before hashing history evidence", () => {
    const parse = (argumentsValue: unknown) =>
      pinnedCodexRequests.threadItemsList.outputCodec.parse({
        data: [{
          type: "dynamicToolCall",
          id: "dynamic-history-item",
          namespace: null,
          tool: "fixture-tool",
          arguments: argumentsValue,
          status: "completed",
          contentItems: null,
          success: true,
          durationMs: 1,
        }],
        nextCursor: null,
        backwardsCursor: null,
      }).data[0]!.providerEvidenceDigest;
    expect(parse({ alpha: 1n, beta: "2" })).toBe(
      parse({ beta: "2", alpha: 1n }),
    );
    expect(parse({ alpha: 1n, beta: "2" })).not.toBe(
      parse({ alpha: "1", beta: "2" }),
    );
  });

  test("requires client identity and keeps interrupt acknowledgement non-terminal", () => {
    expect(() => pinnedCodexRequests.turnStart.inputCodec.parse({
      threadId: "thread-1",
      input: [{ type: "text", text: "Hello", text_elements: [] }],
    })).toThrow("Pinned Codex payload validation failed");
    expect(pinnedCodexRequests.turnInterrupt.outputCodec.parse({})).toEqual({
      kind: "accepted_pending_terminal",
    });
  });

  test("makes invalid effect and lost-response pairs unrepresentable", () => {
    type RejectsReadAmbiguity = Readonly<{
      effect: "read";
      lostResponse: "ambiguous";
      timeoutMs: 1;
      concurrency: "parallel";
      reconciliation: "not-required";
    }> extends PinnedCodexRequestSemantics ? false : true;
    type RejectsRetryableMutation = Readonly<{
      effect: "non-idempotent-mutation";
      lostResponse: "safe-to-retry";
      timeoutMs: 1;
      concurrency: "per-thread";
      reconciliation: { kind: "unsupported"; strategy: "thread-read" };
    }> extends PinnedCodexRequestSemantics ? false : true;
    const rejectsReadAmbiguity: RejectsReadAmbiguity = true;
    const rejectsRetryableMutation: RejectsRetryableMutation = true;
    expect(rejectsReadAmbiguity).toBeTrue();
    expect(rejectsRetryableMutation).toBeTrue();
  });

  test("accepts and rejects input and output fixtures for every operation", () => {
    expect(codecCases.map(({ key }) => String(key))).toEqual(Object.keys(pinnedCodexRequests));
    for (const fixture of codecCases) {
      const selected = pinnedCodexRequests[fixture.key] as PinnedCodexRequestDescriptor<
        PinnedCodexRequestKey
      >;
      try {
        selected.inputCodec.parse(fixture.input);
      } catch (error) {
        throw new Error(`valid input rejected for ${fixture.key}`, { cause: error });
      }
      expect(() => selected.inputCodec.parse(fixture.invalidInput)).toThrow(
        "Pinned Codex payload validation failed",
      );
      expect(() => selected.outputCodec.parse(fixture.output)).not.toThrow();
      expect(() => selected.outputCodec.parse(fixture.invalidOutput)).toThrow(
        "Pinned Codex payload validation failed",
      );
    }
  });

  test("admits only approved authorization URLs at provider ingress", () => {
    const codec = pinnedCodexRequests.accountLoginStart.outputCodec;
    const browser = codec.parse({
      type: "chatgpt",
      loginId: "login-browser",
      authUrl: "https://auth.openai.com/oauth/authorize?client_id=codex",
      privateAccessToken: "must-not-cross-the-boundary",
    });
    expect(browser.type).toBe("chatgpt");
    if (browser.type !== "chatgpt") throw new Error("expected browser login output");
    expect(browser.loginId).toBe("login-browser");
    expect(String(browser.authUrl)).toBe(
      "https://auth.openai.com/oauth/authorize?client_id=codex",
    );
    expect(Object.keys(browser).sort()).toEqual(["authUrl", "loginId", "type"]);

    const deviceCode = codec.parse({
      type: "chatgptDeviceCode",
      loginId: "login-device",
      verificationUrl: "https://auth.openai.com/device",
      userCode: "ABCD-EFGH",
      privateProviderState: "must-not-cross-the-boundary",
    });
    expect(deviceCode.type).toBe("chatgptDeviceCode");
    if (deviceCode.type !== "chatgptDeviceCode") {
      throw new Error("expected device-code login output");
    }
    expect(deviceCode.loginId).toBe("login-device");
    expect(String(deviceCode.verificationUrl)).toBe("https://auth.openai.com/device");
    expect(deviceCode.userCode).toBe("ABCD-EFGH");
    expect(Object.keys(deviceCode).sort()).toEqual([
      "loginId",
      "type",
      "userCode",
      "verificationUrl",
    ]);

    const rejected = [
      "javascript:alert(1)",
      "http://auth.openai.com/start",
      "https://person@auth.openai.com/start",
      "https://auth.openai.com:443/start",
      "https://auth.openai.com:444/start",
      "https://auth.openai.com.evil.test/start",
      "https://\u0430uth.openai.com/start",
      `https://auth.openai.com/start?state=${"x".repeat(2_048)}`,
      `https://auth.openai.com/start?state=${"\u00e9".repeat(700)}`,
    ];
    for (const authUrl of rejected) {
      expect(() => codec.parse({
        type: "chatgpt",
        loginId: "login-browser",
        authUrl,
      })).toThrow("Pinned Codex payload validation failed");
    }
  });

  test("normalizes supported generated counts to canonical decimal strings", () => {
    const limits = pinnedCodexRequests.accountRateLimitsRead.outputCodec.parse(
      pinnedRateLimitsFixture,
    );
    const usage = pinnedCodexRequests.accountUsageRead.outputCodec.parse(
      pinnedTokenUsageFixture,
    );
    expect(limits.rateLimitResetCredits?.availableCount).toBe("2");
    expect(usage.summary.lifetimeTokens).toBe("12345");
    expect(usage.dailyUsageBuckets?.[0]?.tokens).toBe("99");
  });

  test("retains strict model service tiers for Fast capability admission", () => {
    const catalog = pinnedCodexRequests.modelList.outputCodec.parse({
      data: [{
        model: "gpt-5.6-sol",
        supportedReasoningEfforts: [{ reasoningEffort: "ultra" }],
        serviceTiers: [{
          id: "fast",
          name: "Fast",
          description: "Faster model inference with higher credit use.",
        }],
      }],
      nextCursor: null,
    });
    expect(catalog.data[0]?.serviceTiers).toEqual([{
      id: "fast",
      name: "Fast",
      description: "Faster model inference with higher credit use.",
    }]);
    expect(() => pinnedCodexRequests.modelList.outputCodec.parse({
      data: [{
        model: "gpt-5.6-sol",
        supportedReasoningEfforts: [{ reasoningEffort: "ultra" }],
        serviceTiers: [{ id: "fast", name: "Fast", description: "Fast", extra: true }],
      }],
      nextCursor: null,
    })).toThrow("Pinned Codex payload validation failed");
  });

  test("normalizes missing or malformed input modalities to unproven capability", () => {
    const parseModel = (inputModalities: unknown, includeField = true) =>
      pinnedCodexRequests.modelList.outputCodec.parse({
        data: [{
          model: "gpt-5.6-sol",
          ...(includeField ? { inputModalities } : {}),
          supportedReasoningEfforts: [{ reasoningEffort: "max" }],
          serviceTiers: [],
        }],
        nextCursor: null,
      }).data[0]?.inputModalities;

    expect(parseModel(["text", "image"])).toEqual(["text", "image"]);
    expect(parseModel(undefined, false)).toBeNull();
    expect(parseModel(["text", "text"])).toBeNull();
    expect(parseModel(["text", "audio"])).toBeNull();
    expect(parseModel("text,image")).toBeNull();
  });

  test("retains the exact thread admission profile and rejects incomplete evidence", () => {
    const response = {
      thread: pinnedThreadFixture,
      ...pinnedThreadAdmissionProfile,
    };
    expect(pinnedCodexRequests.threadStart.outputCodec.parse(response)).toMatchObject({
      thread: { id: pinnedThreadFixture.id },
      ...pinnedThreadAdmissionProfile,
    });
    expect(pinnedCodexRequests.threadResume.outputCodec.parse(response)).toMatchObject({
      thread: { id: pinnedThreadFixture.id },
      ...pinnedThreadAdmissionProfile,
    });
    for (const incomplete of [
      { thread: pinnedThreadFixture, reasoningEffort: "ultra", serviceTier: null },
      { thread: pinnedThreadFixture, model: "gpt-5.6-sol", serviceTier: null },
      {
        thread: pinnedThreadFixture,
        model: "gpt-5.6-sol",
        reasoningEffort: "ultra",
      },
    ]) {
      expect(() => pinnedCodexRequests.threadStart.outputCodec.parse(incomplete))
        .toThrow("Pinned Codex payload validation failed");
    }
  });

  test("rejects negative, unsafe-number, and pre-normalized string counts", () => {
    const invalidCounts: readonly unknown[] = [
      -1n,
      Number.MAX_SAFE_INTEGER + 1,
      "123",
    ];
    for (const invalidCount of invalidCounts) {
      expect(() => pinnedCodexRequests.accountRateLimitsRead.outputCodec.parse({
        ...pinnedRateLimitsFixture,
        rateLimitResetCredits: { availableCount: invalidCount, credits: [] },
      })).toThrow("Pinned Codex payload validation failed");
      expect(() => pinnedCodexRequests.accountUsageRead.outputCodec.parse({
        ...pinnedTokenUsageFixture,
        summary: { ...pinnedTokenUsageFixture.summary, lifetimeTokens: invalidCount },
      })).toThrow("Pinned Codex payload validation failed");
    }
  });

  test("validates every generated thread-item variant before projecting it", () => {
    for (const item of pinnedRawThreadItemFixtures) {
      const response = {
        thread: {
          ...pinnedThreadFixture,
          turns: [{ ...pinnedTurnFixture, items: [item] }],
        },
        ...pinnedThreadAdmissionProfile,
      };
      expect(() => pinnedCodexRequests.threadStart.outputCodec.parse(response)).not.toThrow();
      if (Object.keys(item).length === 2) continue;
      expect(() => pinnedCodexRequests.threadStart.outputCodec.parse({
        thread: {
          ...pinnedThreadFixture,
          turns: [{
            ...pinnedTurnFixture,
            items: [{ type: item.type, id: item.id }],
          }],
        },
        ...pinnedThreadAdmissionProfile,
      })).toThrow("Pinned Codex payload validation failed");
    }
  });

  test("retains exact client-message identity and turn item coverage", () => {
    expect(pinnedCodexRequests.threadRead.inputCodec.parse({
      threadId: "thread-1",
      includeTurns: false,
    })).toEqual({ threadId: "thread-1", includeTurns: false });
    const parsed = pinnedCodexRequests.threadRead.outputCodec.parse({
      thread: {
        ...pinnedThreadFixture,
        turns: [{
          ...pinnedTurnFixture,
          itemsView: "summary",
          items: [{
            type: "userMessage",
            id: "user-message-1",
            clientId: "oprte-client-message-1",
            content: [{ type: "text", text: "Hello", text_elements: [] }],
          }],
        }],
      },
    });
    expect(parsed.thread.turns).toEqual([{
      id: "turn-1",
      items: [{
        type: "userMessage",
        id: "user-message-1",
        clientId: "oprte-client-message-1",
      }],
      itemsView: "summary",
      status: "completed",
      startedAt: 1_700_000_000,
      completedAt: 1_700_000_001,
    }]);
  });

  test("parses history above the owned semantic circuit for typed classification", () => {
    const text = "x".repeat(6 * 1_024 * 1_024 + 1);
    const parsed = pinnedCodexRequests.threadRead.outputCodec.parse({
      thread: {
        ...pinnedThreadFixture,
        turns: [{
          ...pinnedTurnFixture,
          items: [{
            type: "agentMessage",
            id: "large-history-item",
            text,
            phase: null,
            memoryCitation: null,
          }],
        }],
      },
    });
    const item = parsed.thread.turns[0]?.items[0];
    expect(item?.type).toBe("agentMessage");
    if (item?.type !== "agentMessage") throw new Error("Expected agent message");
    expect(item.text.length).toBe(text.length);
  }, 20_000);
});

describe("PinnedCodexProtocol", () => {
  test("carries request instances and terminates before a provider id can alias", async () => {
    const sink = new MemorySink();
    const observed: CodexServerRequest[] = [];
    const diagnostics: CodexProtocolDiagnostic[] = [];
    const protocol = new PinnedCodexProtocol(5, new CodexJsonlWriter(sink), {
      onServerRequest: (request) => { observed.push(request); },
      onDiagnostic: (diagnostic) => { diagnostics.push(diagnostic); },
    });
    await protocol.receiveValue(5, {
      id: "provider-request-id",
      method: "item/tool/requestUserInput",
      params: pinnedUserInputRequestFixture,
    });
    const first = observed[0];
    if (first === undefined) throw new Error("parsed server request was missing");
    expect(first.requestInstanceId).toBe(1);
    expect(first.streamPosition).toBe(1);
    await protocol.respond(first, { type: "result", result: {} });
    await protocol.receiveValue(5, {
      id: "provider-request-id",
      method: "item/tool/requestUserInput",
      params: pinnedUserInputRequestFixture,
    });
    expect(observed).toHaveLength(1);
    expect(diagnostics).toEqual([{
      type: "invalid_inbound_payload",
      generation: 5,
      source: "server_request",
      method: "item/tool/requestUserInput",
    }]);
    expect(protocol.request("accountRead", {})).rejects.toThrow("generation has ended");
  });

  test("uses the owned operation key and omits undefined params", async () => {
    const sink = new MemorySink();
    const protocol = new PinnedCodexProtocol(1, new CodexJsonlWriter(sink));
    const response = protocol.request("accountLogout", undefined);
    await Bun.sleep(0);
    const envelope = written(sink);
    expect(envelope).toMatchObject({ method: "account/logout" });
    expect("params" in envelope).toBeFalse();
    if (typeof envelope.id !== "string") throw new Error("missing request id");
    await protocol.receiveValue(1, { id: envelope.id, result: {} });
    expect(await response).toBeUndefined();
  });

  test("uses the pinned experimental turn and item paging methods", async () => {
    const sink = new MemorySink();
    const protocol = new PinnedCodexProtocol(6, new CodexJsonlWriter(sink));
    const turns = protocol.request("threadTurnsList", {
      threadId: "thread-1",
      cursor: null,
      limit: 64,
      sortDirection: "desc",
      itemsView: "notLoaded",
    });
    await Bun.sleep(0);
    const turnsEnvelope = written(sink, 0);
    expect(turnsEnvelope).toMatchObject({
      method: "thread/turns/list",
      params: {
        threadId: "thread-1",
        limit: 64,
        sortDirection: "desc",
        itemsView: "notLoaded",
      },
    });
    if (typeof turnsEnvelope.id !== "string") throw new Error("missing turns request id");
    await protocol.receiveValue(6, {
      id: turnsEnvelope.id,
      result: {
        data: [{ ...pinnedTurnFixture, items: [], itemsView: "notLoaded" }],
        nextCursor: null,
        backwardsCursor: "turn-back",
      },
    });
    expect((await turns).data[0]?.itemsView).toBe("notLoaded");

    const items = protocol.request("threadItemsList", {
      threadId: "thread-1",
      turnId: "turn-1",
      cursor: null,
      limit: 256,
      sortDirection: "asc",
    });
    await Bun.sleep(0);
    const itemsEnvelope = written(sink, 1);
    expect(itemsEnvelope).toMatchObject({
      method: "thread/items/list",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        limit: 256,
        sortDirection: "asc",
      },
    });
    if (typeof itemsEnvelope.id !== "string") throw new Error("missing items request id");
    await protocol.receiveValue(6, {
      id: itemsEnvelope.id,
      result: {
        data: [{
          type: "userMessage",
          id: "item-1",
          clientId: "message-owned-1",
          content: [{ type: "text", text: "Hello", text_elements: [] }],
        }],
        nextCursor: null,
        backwardsCursor: "item-back",
      },
    });
    expect((await items).data).toMatchObject([{
      type: "userMessage",
      id: "item-1",
      clientId: "message-owned-1",
      context: { kind: "plainText", text: "Hello" },
    }]);
  });

  test("returns a typed thread-read snapshot with its response position", async () => {
    const sink = new MemorySink();
    const protocol = new PinnedCodexProtocol(7, new CodexJsonlWriter(sink));
    const response = protocol.requestWithResponsePosition("threadRead", {
      threadId: "thread-1",
      includeTurns: true,
    });
    await Bun.sleep(0);
    const envelope = written(sink);
    expect(envelope).toMatchObject({
      method: "thread/read",
      params: { threadId: "thread-1", includeTurns: true },
    });
    if (typeof envelope.id !== "string") throw new Error("missing request id");

    await protocol.receiveValue(7, {
      method: "account/updated",
      params: { authMode: null, planType: null },
    });
    await protocol.receiveValue(7, {
      id: envelope.id,
      result: {
        thread: {
          ...pinnedThreadFixture,
          turns: [{
            ...pinnedTurnFixture,
            items: [{
              type: "userMessage",
              id: "user-message-1",
              clientId: "oprte-client-message-1",
              content: [{ type: "text", text: "Hello", text_elements: [] }],
            }],
          }],
        },
      },
    });

    expect(await response).toEqual({
      generation: 7,
      output: {
        thread: {
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
          turns: [{
            id: "turn-1",
            items: [{
              type: "userMessage",
              id: "user-message-1",
              clientId: "oprte-client-message-1",
            }],
            itemsView: "full",
            status: "completed",
            startedAt: 1_700_000_000,
            completedAt: 1_700_000_001,
          }],
        },
      },
      streamPosition: 2,
    });
  });

  test("rejects invalid local input before any transport write", async () => {
    const sink = new MemorySink();
    const protocol = new PinnedCodexProtocol(2, new CodexJsonlWriter(sink));
    const invalidInput = { refreshToken: false };
    expect(Reflect.set(invalidInput, "refreshToken", "false")).toBeTrue();
    const [result] = await Promise.allSettled([
      protocol.request("accountRead", invalidInput),
    ]);
    expect(result?.status).toBe("rejected");
    expect(result?.status === "rejected" ? result.reason : null).toBeInstanceOf(
      PinnedCodexPayloadError,
    );
    expect(sink.writes).toHaveLength(0);
  });

  test("preserves and normalizes int64 counts from the production JSONL path", async () => {
    const sink = new MemorySink();
    const protocol = new PinnedCodexProtocol(4, new CodexJsonlWriter(sink));
    const response = protocol.request("accountUsageRead", undefined);
    await Bun.sleep(0);
    const envelope = written(sink);
    if (typeof envelope.id !== "string") throw new Error("missing request id");
    await protocol.receiveLine(4, JSON.stringify({ id: envelope.id }).replace(
      "}",
      ',"result":{"summary":{"lifetimeTokens":9007199254740993,"peakDailyTokens":null,"longestRunningTurnSec":null,"currentStreakDays":null,"longestStreakDays":null},"dailyUsageBuckets":[{"startDate":"2026-07-29","tokens":9223372036854775807}]}}',
    ));
    expect(await response).toEqual({
      summary: {
        lifetimeTokens: "9007199254740993",
        peakDailyTokens: null,
        longestRunningTurnSec: null,
        currentStreakDays: null,
        longestStreakDays: null,
      },
      dailyUsageBuckets: [{
        startDate: "2026-07-29",
        tokens: "9223372036854775807",
      }],
    });
  });

  test("treats an invalid provider response as a terminal protocol fault", async () => {
    const sink = new MemorySink();
    const diagnostics: CodexProtocolDiagnostic[] = [];
    const protocol = new PinnedCodexProtocol(3, new CodexJsonlWriter(sink), {
      onDiagnostic: (diagnostic) => { diagnostics.push(diagnostic); },
    });
    const response = protocol.request("accountRead", { refreshToken: false });
    const settled = Promise.allSettled([response]);
    await Bun.sleep(0);
    const envelope = written(sink);
    if (typeof envelope.id !== "string") throw new Error("missing request id");
    await protocol.receiveValue(3, {
      id: envelope.id,
      result: { account: null, requiresOpenaiAuth: "yes", secret: "DO_NOT_RETAIN" },
    });
    const [result] = await settled;
    expect(result?.status).toBe("rejected");
    expect(result?.status === "rejected" ? result.reason : null).toMatchObject({
      name: "PinnedCodexPayloadError",
      operation: "accountRead",
      boundary: "response_output",
    });
    expect(diagnostics).toEqual([{
      type: "invalid_inbound_payload",
      generation: 3,
      source: "response",
      operation: "accountRead",
    }]);
    expect(JSON.stringify({ diagnostics, result })).not.toContain("DO_NOT_RETAIN");
    expect(protocol.request("accountRead", { refreshToken: false })).rejects.toThrow(
      "generation has ended",
    );
  });

  test("fails closed before an unapproved provider login URL can escape", async () => {
    const sink = new MemorySink();
    const diagnostics: CodexProtocolDiagnostic[] = [];
    const protocol = new PinnedCodexProtocol(5, new CodexJsonlWriter(sink), {
      onDiagnostic: (diagnostic) => { diagnostics.push(diagnostic); },
    });
    const response = protocol.request("accountLoginStart", {
      type: "chatgpt",
      codexStreamlinedLogin: true,
      useHostedLoginSuccessPage: true,
      appBrand: "codex",
    });
    const settled = Promise.allSettled([response]);
    await Bun.sleep(0);
    const envelope = written(sink);
    if (typeof envelope.id !== "string") throw new Error("missing request id");
    await protocol.receiveValue(5, {
      id: envelope.id,
      result: {
        type: "chatgpt",
        loginId: "login-browser",
        authUrl: "javascript:private-provider-value",
      },
    });

    const [result] = await settled;
    expect(result?.status).toBe("rejected");
    expect(result?.status === "rejected" ? result.reason : null).toMatchObject({
      name: "PinnedCodexPayloadError",
      operation: "accountLoginStart",
      boundary: "response_output",
    });
    expect(diagnostics).toEqual([{
      type: "invalid_inbound_payload",
      generation: 5,
      source: "response",
      operation: "accountLoginStart",
    }]);
    expect(JSON.stringify({ diagnostics, result })).not.toContain("private-provider-value");
    expect(protocol.request("accountRead", { refreshToken: false })).rejects.toThrow(
      "generation has ended",
    );
  });
});
