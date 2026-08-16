import { describe, expect, test } from "bun:test";
import {
  externalAuthorizationUrl,
  projectAccountRead,
  projectAccountUpdated,
  projectLoginCancel,
  projectLoginCompleted,
  projectLoginStart,
  projectRateLimits,
  projectRateLimitsUpdated,
  projectTokenUsage,
} from "../src/accounts/protocol";
import { pinnedCodexRequests } from "../src/codex";

const observedAt = "2026-07-19T12:00:00.000Z";

function rateLimitSnapshot(
  limitId: string | null = "codex",
  limitName: string | null = "Codex",
) {
  return {
    limitId,
    limitName,
    primary: {
      usedPercent: 25,
      windowDurationMins: 300,
      resetsAt: 1_774_118_400,
    },
    secondary: null,
    credits: null,
    individualLimit: null,
    planType: "pro",
    rateLimitReachedType: null,
  } as const;
}

describe("account protocol adapters", () => {
  test("receives only decoded owned values from the pinned boundary", () => {
    const decoded = pinnedCodexRequests.accountRead.outputCodec.parse({
      account: { type: "apiKey", apiKey: "must-not-cross" },
      requiresOpenaiAuth: true,
      providerPrivateField: "must-not-cross",
    });
    expect(decoded).toEqual({
      account: { type: "apiKey" },
      requiresOpenaiAuth: true,
    });
    expect(JSON.stringify(projectAccountRead(decoded))).not.toContain("must-not-cross");
    expect(() => pinnedCodexRequests.accountRead.outputCodec.parse({
      account: { type: "chatgpt", email: 7, planType: "pro" },
      requiresOpenaiAuth: true,
    })).toThrow("Pinned Codex payload validation failed");
  });

  test("projects account/read without leaking provider-owned account payloads", () => {
    expect(projectAccountRead({
      account: { type: "chatgpt", email: "person@example.com", planType: "pro" },
      requiresOpenaiAuth: true,
    })).toEqual({
      identityLabel: "person@example.com",
      planLabel: "Pro",
      authState: "signedIn",
    });
    expect(projectAccountRead({ account: null, requiresOpenaiAuth: true })).toEqual({
      identityLabel: null,
      planLabel: null,
      authState: "signedOut",
    });
  });

  test("projects browser and device-code login starts into bounded states", () => {
    const browser = pinnedCodexRequests.accountLoginStart.outputCodec.parse({
      type: "chatgpt",
      loginId: "login-browser",
      authUrl: "https://auth.openai.com/start",
    });
    expect(projectLoginStart(browser, observedAt)).toEqual({
      type: "browser",
      loginId: "login-browser",
      authorizationUrl: "https://auth.openai.com/start",
      login: { state: "waitingForBrowser", startedAt: observedAt },
    });
    const deviceCode = pinnedCodexRequests.accountLoginStart.outputCodec.parse({
      type: "chatgptDeviceCode",
      loginId: "login-device",
      verificationUrl: "https://auth.openai.com/device",
      userCode: "ABCD-EFGH",
    });
    expect(projectLoginStart(deviceCode, observedAt)).toEqual({
      type: "deviceCode",
      loginId: "login-device",
      authorizationUrl: "https://auth.openai.com/device",
      login: {
        state: "waitingForDeviceCode",
        userCode: "ABCD-EFGH",
        startedAt: observedAt,
      },
    });
  });

  test("projects parsed login completion and account updates", () => {
    const completed = projectLoginCompleted({
      loginId: "login-device",
      success: false,
    });
    expect(completed).toEqual({
      loginId: "login-device",
      success: false,
      login: { state: "failed", message: "Codex sign-in did not complete." },
    });
    expect(projectAccountUpdated({ authMode: "chatgpt", planType: "plus" })).toEqual({
      authState: "signedIn",
      planLabel: "Plus",
    });
    expect(projectAccountUpdated({ authMode: null, planType: null })).toEqual({
      authState: "signedOut",
      planLabel: null,
    });
    expect(projectLoginCancel({ status: "canceled" })).toBe("canceled");
    expect(projectLoginCancel({ status: "notFound" })).toBe("notFound");
  });

  test("accepts only the pinned OpenAI authorization origin", () => {
    expect(externalAuthorizationUrl(
      "https://auth.openai.com/oauth/authorize?client_id=codex",
    )).toBe("https://auth.openai.com/oauth/authorize?client_id=codex");
    expect(() => externalAuthorizationUrl("https://example.com/oauth/authorize")).toThrow();
    expect(() => externalAuthorizationUrl("https://auth.openai.com.evil.test/start")).toThrow();
    expect(() => externalAuthorizationUrl("https://auth.openai.com:444/start")).toThrow();
    expect(() => externalAuthorizationUrl("https://person@auth.openai.com/start")).toThrow();
    expect(() => externalAuthorizationUrl("http://auth.openai.com/start")).toThrow();
  });

  test("projects deterministic multi-bucket rate limits and sparse updates", () => {
    const result = projectRateLimits({
      rateLimits: rateLimitSnapshot(),
      rateLimitsByLimitId: {
        zeta: rateLimitSnapshot("zeta", "Zeta"),
        alpha: {
          ...rateLimitSnapshot(null, null),
          primary: { usedPercent: 100, windowDurationMins: 60, resetsAt: null },
        },
      },
      rateLimitResetCredits: null,
    }, observedAt);
    expect(result.state).toBe("ready");
    if (result.state !== "ready") throw new Error("expected ready usage");
    expect(result.tokens).toEqual({ state: "unavailable" });
    expect(result.limits.map(({ id }) => id)).toEqual(["alpha", "zeta"]);
    expect(result.limits[0]).toEqual({
      id: "alpha",
      name: "alpha",
      primary: {
        usedPercent: 100,
        windowDurationMinutes: 60,
        resetsAt: null,
      },
      secondary: null,
      individual: null,
      unlimited: false,
      reached: true,
    });
    expect(projectRateLimitsUpdated(
      { rateLimits: rateLimitSnapshot() },
      observedAt,
      {
        state: "ready",
        limits: [{
          id: "other",
          name: "Other",
          primary: null,
          secondary: null,
          individual: null,
          unlimited: false,
          reached: false,
        }],
        tokens: {
          state: "ready",
          lifetimeTokens: "1200",
          peakDailyTokens: "400",
          longestRunningTurnSeconds: "60",
          currentStreakDays: "2",
          longestStreakDays: "5",
          daily: [],
          updatedAt: "2026-07-19T11:00:00.000Z",
        },
        updatedAt: "2026-07-19T11:00:00.000Z",
      },
    )).toEqual({
      state: "ready",
      limits: [
        {
          id: "codex",
          name: "Codex",
          primary: {
            usedPercent: 25,
            windowDurationMinutes: 300,
            resetsAt: "2026-03-21T18:40:00.000Z",
          },
          secondary: null,
          individual: null,
          unlimited: false,
          reached: false,
        },
        {
          id: "other",
          name: "Other",
          primary: null,
          secondary: null,
          individual: null,
          unlimited: false,
          reached: false,
        },
      ],
      tokens: {
        state: "ready",
        lifetimeTokens: "1200",
        peakDailyTokens: "400",
        longestRunningTurnSeconds: "60",
        currentStreakDays: "2",
        longestStreakDays: "5",
        daily: [],
        updatedAt: "2026-07-19T11:00:00.000Z",
      },
      updatedAt: observedAt,
    });
  });

  test("merges sparse rate-limit updates without erasing known bucket state", () => {
    const previous = projectRateLimits({
      rateLimits: {
        ...rateLimitSnapshot("codex", "Codex"),
        secondary: {
          usedPercent: 100,
          windowDurationMins: 10_080,
          resetsAt: 1_774_118_400,
        },
      },
      rateLimitsByLimitId: null,
      rateLimitResetCredits: null,
    }, "2026-07-19T11:00:00.000Z", {
      state: "ready",
      lifetimeTokens: "100",
      peakDailyTokens: "25",
      longestRunningTurnSeconds: "9",
      currentStreakDays: "1",
      longestStreakDays: "2",
      daily: [],
      updatedAt: "2026-07-19T11:00:00.000Z",
    });
    const merged = projectRateLimitsUpdated({
      rateLimits: {
        limitId: "codex",
        limitName: null,
        primary: {
          usedPercent: 30,
          windowDurationMins: 300,
          resetsAt: 1_774_118_400,
        },
        secondary: null,
        rateLimitReachedType: null,
      },
    }, observedAt, previous);
    expect(merged).toEqual({
      state: "ready",
      limits: [{
        id: "codex",
        name: "Codex",
        primary: {
          usedPercent: 30,
          windowDurationMinutes: 300,
          resetsAt: "2026-03-21T18:40:00.000Z",
        },
        secondary: {
          usedPercent: 100,
          windowDurationMinutes: 10_080,
          resetsAt: "2026-03-21T18:40:00.000Z",
        },
        individual: null,
        unlimited: false,
        reached: true,
      }],
      tokens: previous.state === "ready" ? previous.tokens : { state: "unavailable" },
      updatedAt: observedAt,
    });
  });

  test("projects individual spend control and unlimited credits for dispatch", () => {
    const usage = projectRateLimits({
      rateLimits: {
        ...rateLimitSnapshot(),
        credits: { hasCredits: true, unlimited: true, balance: null },
        individualLimit: {
          limit: "100",
          used: "58",
          remainingPercent: 42,
          resetsAt: 1_774_118_400,
        },
      },
      rateLimitsByLimitId: null,
      rateLimitResetCredits: null,
    }, observedAt);

    expect(usage).toMatchObject({
      state: "ready",
      limits: [{
        id: "codex",
        individual: {
          remainingPercent: 42,
          resetsAt: "2026-03-21T18:40:00.000Z",
        },
        unlimited: true,
        reached: false,
      }],
    });
  });

  test("clears a provider reached flag only when an explicit update clears it", () => {
    const previous = projectRateLimits({
      rateLimits: {
        ...rateLimitSnapshot(),
        rateLimitReachedType: "rate_limit_reached",
      },
      rateLimitsByLimitId: null,
      rateLimitResetCredits: null,
    }, "2026-07-19T11:00:00.000Z");

    const retained = projectRateLimitsUpdated({
      rateLimits: {
        limitId: "codex",
        primary: {
          usedPercent: 20,
          windowDurationMins: 300,
          resetsAt: 1_774_118_400,
        },
      },
    }, observedAt, previous);
    expect(retained.state === "ready" && retained.limits[0]?.reached).toBe(true);

    const cleared = projectRateLimitsUpdated({
      rateLimits: {
        limitId: "codex",
        primary: {
          usedPercent: 20,
          windowDurationMins: 300,
          resetsAt: 1_774_118_400,
        },
        rateLimitReachedType: null,
      },
    }, observedAt, previous);
    expect(cleared.state === "ready" && cleared.limits[0]?.reached).toBe(false);
  });

  test("rejects distinct buckets that project to the same product identifier", () => {
    expect(() => projectRateLimits({
      rateLimits: rateLimitSnapshot(),
      rateLimitsByLimitId: {
        first: rateLimitSnapshot("shared", "First"),
        second: rateLimitSnapshot("shared", "Second"),
      },
      rateLimitResetCredits: null,
    }, observedAt)).toThrow("duplicate identifiers");
  });
});

describe("account token-usage protocol adapter", () => {
  test("projects exact decimal counts and keeps only the latest 366 sorted dates", () => {
    const dates = Array.from({ length: 368 }, (_, index) => {
      const date = new Date(Date.UTC(2025, 0, 1 + index));
      return { startDate: date.toISOString().slice(0, 10), tokens: String(index + 1) };
    }).reverse();
    const result = projectTokenUsage({
      summary: {
        lifetimeTokens: "9007199254740991",
        peakDailyTokens: "999",
        longestRunningTurnSec: "120",
        currentStreakDays: null,
        longestStreakDays: "12",
      },
      dailyUsageBuckets: dates,
    }, observedAt);
    expect(result.state).toBe("ready");
    if (result.state !== "ready") throw new Error("expected ready token usage");
    expect(result).toMatchObject({
      lifetimeTokens: "9007199254740991",
      peakDailyTokens: "999",
      longestRunningTurnSeconds: "120",
      currentStreakDays: null,
      longestStreakDays: "12",
      updatedAt: observedAt,
    });
    expect(result.daily).toHaveLength(366);
    expect(result.daily[0]).toEqual({ startDate: "2025-01-03", tokens: "3" });
    expect(result.daily.at(-1)).toEqual({ startDate: "2026-01-03", tokens: "368" });
  });

  test("projects nullable summary fields and rejects duplicate daily dates", () => {
    expect(projectTokenUsage({
      summary: {
        lifetimeTokens: null,
        peakDailyTokens: null,
        longestRunningTurnSec: null,
        currentStreakDays: null,
        longestStreakDays: null,
      },
      dailyUsageBuckets: null,
    }, observedAt)).toEqual({
      state: "ready",
      lifetimeTokens: null,
      peakDailyTokens: null,
      longestRunningTurnSeconds: null,
      currentStreakDays: null,
      longestStreakDays: null,
      daily: [],
      updatedAt: observedAt,
    });
    expect(() => projectTokenUsage({
      summary: {
        lifetimeTokens: null,
        peakDailyTokens: null,
        longestRunningTurnSec: null,
        currentStreakDays: null,
        longestStreakDays: null,
      },
      dailyUsageBuckets: [
        { startDate: "2026-07-19", tokens: "1" },
        { startDate: "2026-07-19", tokens: "2" },
      ],
    }, observedAt)).toThrow("duplicate daily dates");
  });
});
