import { describe, expect, test } from "bun:test";

import fc from "fast-check";

import { CodexError } from "./errors.ts";
import {
  PINNED_CODEX_SERVER_REQUEST_MATRIX,
  PINNED_CODEX_SERVER_REQUEST_SCHEMA_DIGEST,
  assertPinnedCodexServerRequestMatrix,
  codexServerRequestDisposition,
  compileCodexInteractionResponse,
  parseAccountUsage,
  parseBrokeredCodexServerRequest,
  parseFact,
  parseModelPage,
  parsePluginCatalog,
  parseProviderRequestId,
  parseThreadItemsPage,
  parseThreadMetadataRead,
  parseThreadTurnsPage,
  resolvePreset,
  type BrokeredCodexServerRequestMethod,
  type CodexCapabilitySnapshot,
} from "./protocol.ts";

const brokeredFixtures: Readonly<Record<BrokeredCodexServerRequestMethod, unknown>> = {
  "item/commandExecution/requestApproval": {
    threadId: "thread-1", turnId: "turn-1", itemId: "item-1", startedAtMs: 1,
    approvalId: null, environmentId: null, reason: "network", command: "git push origin main",
    cwd: "/workspace", availableDecisions: ["accept", "acceptForSession", "decline", "cancel"],
  },
  "item/fileChange/requestApproval": {
    threadId: "thread-1", turnId: "turn-1", itemId: "item-2", startedAtMs: 1,
    reason: "write files", grantRoot: "/workspace",
  },
  "item/permissions/requestApproval": {
    threadId: "thread-1", turnId: "turn-1", itemId: "item-3", environmentId: null,
    startedAtMs: 1, cwd: "/workspace", reason: "network",
    permissions: { network: { enabled: true }, fileSystem: null },
  },
  "item/tool/requestUserInput": {
    threadId: "thread-1", turnId: "turn-1", itemId: "item-4", isBlocking: true,
    autoResolutionMs: null,
    questions: [{
      id: "choice", header: "Choice", question: "Which option?", isOther: true, isSecret: false,
      options: [{ label: "A", description: "First" }],
    }],
  },
  "mcpServer/elicitation/request": {
    threadId: "thread-1", turnId: "turn-1", serverName: "example", mode: "url",
    _meta: null, message: "Authorize Example", url: "https://example.com/oauth", elicitationId: "elicit-1",
  },
};

const capabilities: CodexCapabilitySnapshot = {
  models: [
    {
      id: "gpt-5.6-luna",
      model: "gpt-5.6-luna",
      displayName: "GPT-5.6 Luna",
      hidden: false,
      supportedReasoningEfforts: ["low", "medium", "high", "max"],
      defaultReasoningEffort: "medium",
      serviceTiers: [{ id: "priority", name: "Fast", description: "Faster" }],
      defaultServiceTier: null,
      isDefault: false,
    },
    {
      id: "gpt-5.6-sol",
      model: "gpt-5.6-sol",
      displayName: "GPT-5.6 Sol",
      hidden: false,
      supportedReasoningEfforts: ["low", "max", "ultra"],
      defaultReasoningEffort: "low",
      serviceTiers: [{ id: "priority", name: "Fast", description: "Faster" }],
      defaultServiceTier: null,
      isDefault: true,
    },
  ],
  features: [],
  permissionProfiles: null,
  apps: null,
  pluginLifecycle: "unsupported-under-development",
};

describe("pinned server requests and safe notifications", () => {
  test("projects plugin discovery without local marketplace paths or load diagnostics", () => {
    const catalog = parsePluginCatalog({
      marketplaces: [{
        name: "official",
        path: "/workspace/.codex/plugins/marketplace.json",
        interface: { displayName: "Official" },
        plugins: [{
          id: "files@official",
          remotePluginId: null,
          version: "1.2.3",
          localVersion: null,
          name: "files",
          shareContext: null,
          source: { type: "local", path: "/private/plugin" },
          installed: false,
          installedAt: null,
          enabled: false,
          installPolicy: "AVAILABLE",
          installPolicySource: null,
          mustShowInstallationInterstitial: null,
          authPolicy: "ON_USE",
          availability: "AVAILABLE",
          disabledReason: null,
          eligiblePlanTypes: ["plus"],
          interface: {
            displayName: "Files",
            shortDescription: "Search files",
            longDescription: null,
            developerName: "OpenAI",
            category: "productivity",
            capabilities: ["search"],
            websiteUrl: null,
            privacyPolicyUrl: null,
            termsOfServiceUrl: null,
            defaultPrompt: null,
            brandColor: null,
            composerIcon: "/private/icon.png",
            composerIconUrl: null,
            logo: null,
            logoDark: null,
            logoUrl: null,
            logoUrlDark: null,
            screenshots: [],
            screenshotUrls: [],
          },
          keywords: ["files"],
        }],
      }],
      marketplaceLoadErrors: [{
        marketplacePath: "/workspace/private/marketplace.json",
        message: "failed at /workspace/private/marketplace.json",
      }],
      featuredPluginIds: ["files@official"],
    });
    expect(catalog).toMatchObject({
      marketplaces: [{
        name: "official",
        plugins: [{
          id: "files@official",
          displayName: "Files",
          sourceType: "local",
          installed: false,
          enabled: false,
        }],
      }],
      marketplaceLoadErrorCount: 1,
      lifecycle: { install: "blocked_compound_upstream_effect" },
    });
    expect(catalog.marketplaces[0]).not.toHaveProperty("path");
    expect(catalog.marketplaces[0]?.plugins[0]).not.toHaveProperty("source");
    expect(catalog).not.toHaveProperty("marketplaceLoadErrors");
    expect(JSON.stringify(catalog)).not.toContain("/workspace/private");
    expect(JSON.stringify(catalog)).not.toContain("/private/plugin");
    expect(JSON.stringify(catalog)).not.toContain("failed at");
  });

  test("covers the exact generated 0.149.0 ServerRequest union with a reviewed schema digest", () => {
    expect(Object.entries(PINNED_CODEX_SERVER_REQUEST_MATRIX)).toEqual([
      ["item/commandExecution/requestApproval", "brokered_interaction"],
      ["item/fileChange/requestApproval", "brokered_interaction"],
      ["item/tool/requestUserInput", "brokered_interaction"],
      ["mcpServer/elicitation/request", "brokered_interaction"],
      ["item/permissions/requestApproval", "brokered_interaction"],
      ["item/tool/call", "internal_host_service"],
      ["account/chatgptAuthTokens/refresh", "internal_host_service"],
      ["attestation/generate", "internal_host_service"],
      ["currentTime/read", "internal_host_service"],
      ["applyPatchApproval", "unsupported"],
      ["execCommandApproval", "unsupported"],
    ]);
    expect(PINNED_CODEX_SERVER_REQUEST_SCHEMA_DIGEST).toBe(
      "1c5837adbfbdd005f387478ba87840808d1353b47b82dcf63739a78bb1c8d3be",
    );
    expect(() => assertPinnedCodexServerRequestMatrix()).not.toThrow();
    expect(codexServerRequestDisposition("future/request")).toBeNull();
  });

  test("parses every brokered method into a bounded display and exact private authority", () => {
    for (const [method, params] of Object.entries(brokeredFixtures) as [BrokeredCodexServerRequestMethod, unknown][]) {
      const parsed = parseBrokeredCodexServerRequest({
        authority: { profileId: "profile-a", processGeneration: 9 },
        connectionId: "018f1f55-3f10-7c1a-8f7b-c6dc608bcd3b",
        requestId: { type: "string", value: method },
        method,
        params,
      });
      expect(parsed.provider).toMatchObject({
        profileId: "profile-a",
        processGeneration: 9,
        method,
        requestId: { type: "string", value: method },
      });
      expect(parsed.provider.requestDigest).toMatch(/^[a-f0-9]{64}$/u);
      expect(JSON.stringify(parsed.display)).not.toContain("git push origin main");
    }
    const secretCommand = parseBrokeredCodexServerRequest({
      authority: { profileId: "profile-a", processGeneration: 9 },
      connectionId: "018f1f55-3f10-7c1a-8f7b-c6dc608bcd3b",
      requestId: { type: "number", value: 99 },
      method: "item/commandExecution/requestApproval",
      params: {
        ...(brokeredFixtures["item/commandExecution/requestApproval"] as Record<string, unknown>),
        command: "git -c credential.helper=SECRET push origin main",
      },
    });
    expect(secretCommand.display).toMatchObject({ commandClass: "git push" });
    expect(JSON.stringify(secretCommand.display)).not.toContain("SECRET");
  });

  test("keeps numeric and string request identities distinct and rejects permission escalation", () => {
    expect(parseProviderRequestId(1)).toEqual({ type: "number", value: 1 });
    expect(parseProviderRequestId("1")).toEqual({ type: "string", value: "1" });
    const parsed = parseBrokeredCodexServerRequest({
      authority: { profileId: "profile-a", processGeneration: 1 },
      connectionId: "018f1f55-3f10-7c1a-8f7b-c6dc608bcd3b",
      requestId: { type: "number", value: 1 },
      method: "item/permissions/requestApproval",
      params: brokeredFixtures["item/permissions/requestApproval"],
    });
    expect(() => compileCodexInteractionResponse({
      method: "item/permissions/requestApproval",
      kind: parsed.kind,
      privateParams: parsed.privateParams,
      resolution: {
        kind: "permission_grant",
        permissions: { network: { enabled: true }, fileSystem: { write: ["/private"] } },
        scope: "session",
      },
    })).toThrow("exceed");
    expect(compileCodexInteractionResponse({
      method: "item/permissions/requestApproval",
      kind: parsed.kind,
      privateParams: parsed.privateParams,
      resolution: {
        kind: "permission_grant",
        permissions: { network: { enabled: true } },
        scope: "turn",
      },
    })).toEqual({ permissions: { network: { enabled: true } }, scope: "turn" });
  });

  test("projects visible deltas and metrics while excluding raw reasoning and tool payloads", () => {
    expect(parseFact("item/agentMessage/delta", {
      threadId: "thread-1", turnId: "turn-1", itemId: "item-1", delta: "hello",
    })).toMatchObject({ type: "assistantDelta", text: "hello" });
    expect(parseFact("item/reasoning/summaryTextDelta", {
      threadId: "thread-1", turnId: "turn-1", itemId: "item-2", summaryIndex: 0, delta: "summary",
    })).toMatchObject({ type: "reasoningSummaryDelta", text: "summary", summaryIndex: 0 });
    const hidden = parseFact("item/reasoning/textDelta", {
      threadId: "thread-1", turnId: "turn-1", itemId: "item-2", contentIndex: 0,
      delta: "hidden chain of thought",
    });
    expect(hidden).toEqual({ type: "protocolNotice", method: "item/reasoning/textDelta" });
    expect(JSON.stringify(hidden)).not.toContain("hidden chain of thought");

    const output = parseFact("item/commandExecution/outputDelta", {
      threadId: "thread-1", turnId: "turn-1", itemId: "item-3", delta: "SECRET OUTPUT",
    });
    expect(output).toMatchObject({ type: "toolProgress", toolKind: "command", outputBytesObserved: 13 });
    expect(JSON.stringify(output)).not.toContain("SECRET OUTPUT");

    const item = parseFact("item/completed", {
      threadId: "thread-1", turnId: "turn-1", completedAtMs: 2,
      item: {
        type: "mcpToolCall", id: "item-4", server: "github", tool: "create_issue",
        status: "completed", arguments: { token: "SECRET" }, result: { content: "SECRET RESULT" },
      },
    });
    expect(item).toMatchObject({ type: "itemCompleted", server: "github", tool: "create_issue", status: "completed" });
    expect(JSON.stringify(item)).not.toContain("SECRET");
  });

  test("reduces plan, diff, and token notifications without retaining patch text", () => {
    expect(parseFact("turn/plan/updated", {
      threadId: "thread-1", turnId: "turn-1", explanation: "Next", plan: [
        { step: "Inspect", status: "completed" },
        { step: "Fix", status: "inProgress" },
      ],
    })).toMatchObject({ type: "planUpdated", steps: [{ text: "Inspect", status: "completed" }, { text: "Fix", status: "in_progress" }] });
    const diff = parseFact("turn/diff/updated", {
      threadId: "thread-1", turnId: "turn-1", diff: "diff --git a/a b/a\n+SECRET\n",
    });
    expect(diff).toMatchObject({ type: "diffUpdated", changedFiles: 1 });
    expect(JSON.stringify(diff)).not.toContain("SECRET");
    expect(parseFact("thread/tokenUsage/updated", {
      threadId: "thread-1", turnId: "turn-1",
      tokenUsage: {
        total: { totalTokens: 15, inputTokens: 10, cachedInputTokens: 3, cacheWriteInputTokens: 0, outputTokens: 5, reasoningOutputTokens: 2 },
        last: { totalTokens: 15, inputTokens: 10, cachedInputTokens: 3, cacheWriteInputTokens: 0, outputTokens: 5, reasoningOutputTokens: 2 },
        modelContextWindow: 200_000,
      },
    })).toMatchObject({ type: "tokenUsageUpdated", totalTokens: 15, reasoningOutputTokens: 2, modelContextWindow: 200_000 });
  });
});

describe("runtime capability resolution", () => {
  test("maps only the advertised reduced presets", () => {
    expect(resolvePreset(capabilities, "low", false)).toMatchObject({
      model: "gpt-5.6-luna",
      effort: "max",
      serviceTier: null,
    });
    expect(resolvePreset(capabilities, "high", true)).toMatchObject({
      model: "gpt-5.6-sol",
      effort: "max",
      serviceTier: "priority",
    });
    expect(resolvePreset(capabilities, "ultra", false)).toMatchObject({
      model: "gpt-5.6-sol",
      effort: "ultra",
    });
  });

  test("fails closed when Fast is not advertised", () => {
    const withoutFast: CodexCapabilitySnapshot = {
      ...capabilities,
      models: capabilities.models.map((model) => ({ ...model, serviceTiers: [] })),
    };
    expect(() => resolvePreset(withoutFast, "high", true)).toThrow(CodexError);
  });

  test("never selects a prefixed or suffixed lookalike under catalog reordering", () => {
    const catalog = [
      { ...capabilities.models[0]!, id: "gpt-5.6-luna-mini", model: "gpt-5.6-luna-mini" },
      { ...capabilities.models[1]!, id: "legacy-gpt-5.6-sol", model: "legacy-gpt-5.6-sol" },
      ...capabilities.models,
    ];
    fc.assert(fc.property(fc.shuffledSubarray(catalog, { minLength: 4, maxLength: 4 }), (models) => {
      expect(resolvePreset({ ...capabilities, models }, "low", false).model).toBe("gpt-5.6-luna");
      expect(resolvePreset({ ...capabilities, models }, "high", false).model).toBe("gpt-5.6-sol");
    }));
    const lookalikesOnly = {
      ...capabilities,
      models: capabilities.models.map((model) => ({ ...model, model: `${model.model}-mini` })),
    };
    expect(() => resolvePreset(lookalikesOnly, "high", false)).toThrow(CodexError);
  });

  test("rejects an unrecognized reasoning effort", () => {
    expect(() =>
      parseModelPage({
        data: [
          {
            id: "future",
            model: "future",
            displayName: "Future",
            hidden: false,
            supportedReasoningEfforts: [{ reasoningEffort: "unbounded" }],
            defaultReasoningEffort: "unbounded",
            serviceTiers: [],
            defaultServiceTier: null,
            isDefault: false,
          },
        ],
        nextCursor: null,
      }),
    ).toThrow(CodexError);
  });

  test("parses bounded usage without accepting lossy integers", () => {
    expect(
      parseAccountUsage({
        summary: {
          lifetimeTokens: 42,
          peakDailyTokens: 12,
          longestRunningTurnSec: null,
          currentStreakDays: 3,
          longestStreakDays: 5,
        },
        dailyUsageBuckets: [{ startDate: "2026-08-22", tokens: 9 }],
      }),
    ).toEqual({
      summary: {
        lifetimeTokens: 42,
        peakDailyTokens: 12,
        longestRunningTurnSec: null,
        currentStreakDays: 3,
        longestStreakDays: 5,
      },
      dailyUsageBuckets: [{ startDate: "2026-08-22", tokens: 9 }],
    });
    expect(() =>
      parseAccountUsage({
        summary: {
          lifetimeTokens: Number.MAX_SAFE_INTEGER + 1,
          peakDailyTokens: null,
          longestRunningTurnSec: null,
          currentStreakDays: null,
          longestStreakDays: null,
        },
        dailyUsageBuckets: null,
      }),
    ).toThrow(CodexError);
  });

  test("parses the pinned paginated turn and item response envelopes", () => {
    const turn = {
      id: "turn-1",
      items: [],
      status: "completed" as const,
      startedAt: 1,
      completedAt: 2,
      durationMs: 1_000,
    };
    expect(parseThreadTurnsPage({ data: [turn], nextCursor: "older", backwardsCursor: "newer" }))
      .toEqual({ data: [turn], nextCursor: "older", backwardsCursor: "newer" });
    expect(parseThreadItemsPage({
      data: [
        { turnId: "turn-1", item: { type: "userMessage", id: "item-user", clientId: "client-exact", content: [{ type: "text", text: "hello" }] } },
        { turnId: "turn-1", item: { type: "agentMessage", id: "item-1", text: "hello" } },
      ],
      nextCursor: null,
      backwardsCursor: "back",
    })).toEqual({
      data: [
        { turnId: "turn-1", item: { type: "userMessage", id: "item-user", clientId: "client-exact", text: ["hello"] } },
        { turnId: "turn-1", item: { type: "agentMessage", id: "item-1", text: "hello" } },
      ],
      nextCursor: null,
      backwardsCursor: "back",
    });
  });

  test("rejects provider turns at the metadata-only thread boundary", () => {
    expect(() => parseThreadMetadataRead({ thread: { turns: [{}] } })).toThrow(CodexError);
  });
});
