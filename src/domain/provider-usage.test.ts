import { describe, expect, test } from "bun:test";

import type { ProviderAccountAuthority } from "./provider-accounts";
import {
  canonicalProviderUsageComponent,
  createClaudeAccountingUsageComponent,
  createClaudeQuotaUsageComponent,
  mergeProviderUsageComponents,
  projectCodexV1Usage,
  providerUsageComponentSchema,
  providerUsageDigest,
} from "./provider-usage";
import { createStoredAccountUsageSnapshot } from "./usage-metrics";

const authority: ProviderAccountAuthority = {
  provider: "claude",
  providerAccountId: "pact_11111111111111111111111111111111",
  profileId: "acct_22222222222222222222222222222222",
  bindingGeneration: 3,
  processGeneration: 7,
};
const sessionId = "sess_33333333333333333333333333333333";
const digest = (value: unknown): string => providerUsageDigest(value);

const quota = (overrides: Readonly<Record<string, unknown>> = {}) =>
  createClaudeQuotaUsageComponent({
    authority,
    sessionId,
    turnId: "turn-a",
    sourceEventId: "00000000-0000-4000-8000-000000000001",
    sourceEventDigest: digest("quota-source"),
    observationRevision: 1,
    observedAt: 1_000,
    receivedAt: 1_000,
    quota: {
      status: { state: "known", value: "allowed" },
      rateLimitType: "five_hour",
      resetsAtMs: 5_000,
      overageStatus: "rejected",
      overageDisabledReason: "org_level_disabled",
      isUsingOverage: false,
      windows: [
        { id: "seven_day", scope: "account", usedPercent: 30, resetsAtMs: 7_000 },
        { id: "five_hour", scope: "account", usedPercent: 50, resetsAtMs: 5_000 },
      ],
      ...overrides,
    },
  });

const accounting = (observedAt = 2_000) => createClaudeAccountingUsageComponent({
  authority,
  sessionId,
  turnId: "turn-a",
  sourceEventId: "00000000-0000-4000-8000-000000000002",
  sourceEventDigest: digest("accounting-source"),
  observationRevision: 1,
  observedAt,
  receivedAt: observedAt,
  accounting: {
    totalCostUsd: 0.25,
    inputTokens: 2,
    cacheCreationInputTokens: 11,
    cacheReadInputTokens: 10,
    outputTokens: 4,
    thinkingTokens: 0,
    models: [
      {
        model: "z-model",
        costUsd: null,
        inputTokens: null,
        cacheCreationInputTokens: null,
        cacheReadInputTokens: null,
        outputTokens: null,
        thinkingTokens: null,
        contextWindow: null,
        maxOutputTokens: null,
      },
      {
        model: "A/model-1",
        costUsd: 0.25,
        inputTokens: 2,
        cacheCreationInputTokens: 11,
        cacheReadInputTokens: 10,
        outputTokens: 4,
        thinkingTokens: 0,
        contextWindow: 1_000_000,
        maxOutputTokens: 64_000,
      },
    ],
  },
});

describe("provider usage v2", () => {
  test("canonicalizes component collections and binds idempotency to exact authority", () => {
    const observed = quota();
    expect(observed.quota.windows.map((window) => window.id)).toEqual([
      "five_hour",
      "seven_day",
    ]);
    expect(quota({
      windows: [
        { id: "a", scope: "account", usedPercent: 1, resetsAtMs: 7_000 },
        { id: "_", scope: "account", usedPercent: 1, resetsAtMs: 7_000 },
        { id: "A", scope: "account", usedPercent: 1, resetsAtMs: 7_000 },
        { id: "+x", scope: "account", usedPercent: 1, resetsAtMs: 7_000 },
      ],
    }).quota.windows.map((window) => window.id)).toEqual(["+x", "A", "_", "a"]);
    expect(canonicalProviderUsageComponent(observed)).toEqual(observed);
    expect(quota().idempotencyKey).toBe(observed.idempotencyKey);
    expect(createClaudeQuotaUsageComponent({
      ...{
        authority: { ...authority, processGeneration: 8 },
        sessionId,
        turnId: "turn-a",
        sourceEventId: "00000000-0000-4000-8000-000000000001",
        sourceEventDigest: digest("quota-source"),
        observationRevision: 1,
        observedAt: 1_000,
        receivedAt: 1_000,
      },
      quota: {
        ...observed.quota,
        format: undefined,
      },
    } as never).idempotencyKey).not.toBe(observed.idempotencyKey);
  });

  test("retains bounded unknown statuses without making them known", () => {
    const observed = quota({ status: { state: "unknown", value: "Future.Status+1" } });
    expect(observed.quota.status).toEqual({ state: "unknown", value: "Future.Status+1" });
    expect(() => quota({ status: { state: "unknown", value: "bad value" } })).toThrow();
    expect(() => quota({ status: { state: "unknown", value: "é".repeat(65) } })).toThrow();
  });

  test("rejects direct Claude revision zero and duplicate canonical identities", () => {
    const observed = quota();
    expect(providerUsageComponentSchema.safeParse({
      ...observed,
      observationRevision: 0,
    }).success).toBe(false);
    expect(() => quota({ windows: [observed.quota.windows[0], observed.quota.windows[0]] }))
      .toThrow("duplicate ids");
    expect(() => createClaudeQuotaUsageComponent({
      authority,
      sessionId,
      turnId: "turn-a",
      sourceEventId: "00000000-0000-4000-8000-000000000003",
      sourceEventDigest: digest("quota-clock"),
      observationRevision: 2,
      observedAt: 1_000,
      receivedAt: 1_001,
      quota: observed.quota,
    } as never)).toThrow("local receive time");
    expect(() => createClaudeAccountingUsageComponent({
      authority,
      sessionId,
      turnId: "turn-a",
      sourceEventId: "00000000-0000-4000-8000-000000000004",
      sourceEventDigest: digest("accounting-clock"),
      observationRevision: 2,
      observedAt: 2_000,
      receivedAt: 2_001,
      accounting: accounting().accounting,
    } as never)).toThrow("local receive time");
  });

  test("merges accounting independently without refreshing quota provenance", () => {
    const quotaObservation = quota();
    const first = mergeProviderUsageComponents({
      components: [accounting(2_000), quotaObservation],
    });
    const later = mergeProviderUsageComponents({
      components: [accounting(9_000), quotaObservation],
    });
    expect(first?.quota).toEqual(quotaObservation);
    expect(later?.quota).toEqual(quotaObservation);
    expect(later?.quota?.observedAt).toBe(1_000);
    expect(later?.accounting?.observedAt).toBe(9_000);
    if (later?.accounting?.source !== "claude_result") throw new Error("missing Claude accounting");
    expect(later.accounting.accounting.models.map((model) => model.model)).toEqual([
      "A/model-1",
      "z-model",
    ]);
  });

  test("uses the digest as the cross-layer final tie break", () => {
    const first = quota();
    const second = createClaudeQuotaUsageComponent({
      authority,
      sessionId,
      turnId: "turn-\u{1f600}",
      sourceEventId: "00000000-0000-4000-8000-000000000099",
      sourceEventDigest: digest("quota-source-tie"),
      observationRevision: first.observationRevision,
      observedAt: first.observedAt,
      receivedAt: first.receivedAt,
      quota: first.quota,
    });
    const expected = first.idempotencyKey < second.idempotencyKey ? second : first;
    expect(mergeProviderUsageComponents({ components: [first, second] })?.quota).toEqual(expected);
    expect(mergeProviderUsageComponents({ components: [second, first] })?.quota).toEqual(expected);
  });

  test("projects Codex v1 revision zero without changing the legacy object", () => {
    const providerPayload = {
      usage: {
        summary: {
          lifetimeTokens: 12,
          peakDailyTokens: null,
          longestRunningTurnSec: null,
          currentStreakDays: null,
          longestStreakDays: null,
        },
        dailyUsageBuckets: null,
      },
      rateLimits: {
        primary: {
          limitId: null,
          limitName: null,
          primary: null,
          secondary: null,
          planType: null,
          rateLimitReachedType: null,
        },
        byLimitId: {
          primary: {
            limitId: "primary",
            limitName: null,
            primary: null,
            secondary: null,
            planType: null,
            rateLimitReachedType: null,
          },
        },
        resetCreditsAvailable: 0,
      },
    };
    const snapshot = createStoredAccountUsageSnapshot({
      providerPayload,
      sourceSequence: 1,
      observedAt: 100,
      receivedAt: 101,
      accountFingerprint: "a".repeat(64),
      providerGeneration: 4,
      daemonGeneration: 1,
      previousPayload: null,
    });
    const codexAuthority: ProviderAccountAuthority = {
      provider: "codex",
      providerAccountId: "acct_44444444444444444444444444444444",
      profileId: "acct_44444444444444444444444444444444",
      bindingGeneration: 2,
      processGeneration: 4,
    };
    const projected = projectCodexV1Usage({
      snapshot,
      sourceRevision: 0,
      observedAt: 100,
      storedDigest: digest(snapshot),
      authority: codexAuthority,
      authorityMode: "compatibility_display_only",
    });
    expect(projected.legacySnapshot).toBe(snapshot);
    expect(projected.observation?.authorityMode).toBe("compatibility_display_only");
    expect(projected.observation?.quota?.observationRevision).toBe(0);
    if (projected.observation?.quota?.source !== "codex_app_server") {
      throw new Error("missing Codex quota projection");
    }
    expect(projected.observation.quota.quota.limits.map((limit) => limit.id)).toEqual([
      "legacy:primary",
      "limit:primary",
    ]);
  });

  test("drops malformed Codex limit collections without changing the legacy snapshot", () => {
    const limit = {
      limitId: null,
      limitName: null,
      primary: null,
      secondary: null,
      planType: null,
      rateLimitReachedType: null,
    };
    const project = (byLimitId: Readonly<Record<string, typeof limit>>) => {
      const snapshot = createStoredAccountUsageSnapshot({
        providerPayload: {
          usage: {
            summary: {
              lifetimeTokens: 12,
              peakDailyTokens: null,
              longestRunningTurnSec: null,
              currentStreakDays: null,
              longestStreakDays: null,
            },
            dailyUsageBuckets: null,
          },
          rateLimits: {
            primary: limit,
            byLimitId,
            resetCreditsAvailable: 0,
          },
        },
        sourceSequence: 1,
        observedAt: 100,
        receivedAt: 101,
        accountFingerprint: "a".repeat(64),
        providerGeneration: 4,
        daemonGeneration: 1,
        previousPayload: null,
      });
      const projected = projectCodexV1Usage({
        snapshot,
        sourceRevision: 1,
        observedAt: 100,
        storedDigest: digest(snapshot),
        authority: {
          provider: "codex",
          providerAccountId: "acct_44444444444444444444444444444444",
          profileId: "acct_44444444444444444444444444444444",
          bindingGeneration: 2,
          processGeneration: 4,
        },
        authorityMode: "mutation_authoritative",
      });
      expect(projected.legacySnapshot).toBe(snapshot);
      return projected;
    };

    expect(project(Object.fromEntries(
      Array.from({ length: 101 }, (_, index) => [`limit-${index}`, limit]),
    )).observation).toBeNull();
    expect(project({ ["x".repeat(251)]: limit }).observation).toBeNull();
  });
});
