import { describe, expect, test } from "bun:test";

import type { CodexFact } from "../src/codex";
import { CodexFactConsumerError, CodexFactRouter } from "../src/codex/fact-router";

describe("CodexFactRouter", () => {
  test("fans one immutable fact array to explicit account, session, and harness consumers", async () => {
    const observed: (readonly CodexFact[])[] = [];
    const consumer = { consumeCodexFacts: async (facts: readonly CodexFact[]) => {
      await Promise.resolve();
      observed.push(facts);
    } };
    const router = new CodexFactRouter({
      account: () => consumer,
      session: () => consumer,
      harness: () => consumer,
    });
    const returned = await router.routeNotification("account_1", {
      generation: 3,
      streamPosition: 9,
      method: "account/updated",
      params: { authMode: "chatgpt", planType: "pro" },
    });
    expect(observed).toHaveLength(3);
    expect(observed[0]).toBe(returned);
    expect(observed[1]).toBe(returned);
    expect(observed[2]).toBe(returned);
    expect(Object.isFrozen(returned)).toBe(true);
    expect(returned).toEqual([
      expect.objectContaining({
        accountProfileId: "account_1",
        type: "account.profile_updated",
      }),
    ]);
  });

  test("does not treat either consumer as a fallback", async () => {
    let accountCalls = 0;
    let sessionCalls = 0;
    let harnessCalls = 0;
    const router = new CodexFactRouter({
      account: () => ({ consumeCodexFacts: () => { accountCalls += 1; } }),
      session: () => ({ consumeCodexFacts: () => { sessionCalls += 1; } }),
      harness: () => ({ consumeCodexFacts: () => { harnessCalls += 1; } }),
    });
    await router.routeNotification("account_1", {
      generation: 3,
      streamPosition: 9,
      method: "item/reasoning/textDelta",
      params: undefined,
    });
    expect(accountCalls).toBe(1);
    expect(sessionCalls).toBe(1);
    expect(harnessCalls).toBe(1);
  });

  test("fans out before failing the generation when one consumer throws", async () => {
    let sessionCalls = 0;
    let harnessCalls = 0;
    const router = new CodexFactRouter({
      account: () => ({ consumeCodexFacts: async () => {
        await Promise.resolve();
        throw new Error("private failure");
      } }),
      session: () => ({ consumeCodexFacts: () => { sessionCalls += 1; } }),
      harness: () => ({ consumeCodexFacts: () => { harnessCalls += 1; } }),
    });
    let observedError: unknown = null;
    try {
      await router.routeNotification("account_1", {
        generation: 3,
        streamPosition: 9,
        method: "account/updated",
        params: { authMode: "chatgpt", planType: "pro" },
      });
    } catch (error: unknown) {
      observedError = error;
    }
    expect(observedError).toBeInstanceOf(CodexFactConsumerError);
    expect(sessionCalls).toBe(1);
    expect(harnessCalls).toBe(1);
  });
});
