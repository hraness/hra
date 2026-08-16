import { describe, expect, test } from "bun:test";
import type {
  RunInteractionRequest,
} from "@hraness/agent-tasks-protocol";

import { SessionDispatchCallbackRouter } from "../src/sessions/dispatch-callback-router";

const owner = {
  accountProfileId: "acct_callback0001",
  threadId: "thread_callback001",
  turnId: "turn_callback00001",
} as const;

const request = {
  id: "interaction_callback01",
  kind: "file_change_approval",
  scope: "once",
  createdAt: 100,
  expiresAt: 200,
} as const;

const boundRequest: RunInteractionRequest = {
  ...request,
  reply: {
    version: 1,
    algorithm: "P256-HKDF-SHA256-A256GCM",
    keyId: "key_callback000001",
    publicKey: "B".repeat(87),
    runnerId: "runner_callback001",
    bootId: "boot_callback00001",
    bootGeneration: 1,
    claimId: "claim_callback0001",
    claimFence: 1,
    requestDigest: `sha256_${"b".repeat(64)}`,
  },
};

describe("session dispatch callback routing", () => {
  test("keeps local callbacks live without pairing and routes each owned request once", async () => {
    const observed: string[] = [];
    let cloudPaired = false;
    let localOwnsInteraction = true;
    const cloud = {
      activity: {
        observe: () => {
          observed.push("cloud.activity");
        },
      },
      completion: {
        observe: () => {
          observed.push("cloud.completion");
        },
      },
      interactions: {
        observeRequest: () => {
          observed.push("cloud.interaction");
          return boundRequest;
        },
        observeExpired: () => {
          observed.push("cloud.expired");
        },
      },
    };
    const local = {
      activity: {
        observe: () => {
          observed.push("local.activity");
        },
      },
      completion: {
        observe: () => {
          observed.push("local.completion");
        },
      },
      interactions: {
        observeRequest: () => {
          observed.push("local.interaction");
          return localOwnsInteraction ? boundRequest : null;
        },
        observeExpired: () => {
          observed.push("local.expired");
        },
      },
    };
    const router = new SessionDispatchCallbackRouter({
      cloud: {
        activity: () => cloudPaired ? cloud.activity : null,
        completion: () => cloudPaired ? cloud.completion : null,
        interactions: () => cloudPaired ? cloud.interactions : null,
      },
      local: {
        activity: () => local.activity,
        completion: () => local.completion,
        interactions: () => local.interactions,
      },
    });

    await router.observeActivity({ ...owner, kind: "running" });
    router.observeLifecycle({ ...owner, status: "completed" });
    expect(await router.observeInteractionRequest({ ...owner, request }))
      .toBe(boundRequest);
    await router.observeInteractionExpired({
      interactionId: request.id,
      reason: "provider_expired",
    });
    expect(observed).toEqual([
      "local.activity",
      "local.completion",
      "local.interaction",
      "local.expired",
    ]);

    observed.length = 0;
    cloudPaired = true;
    localOwnsInteraction = false;
    expect(await router.observeInteractionRequest({ ...owner, request }))
      .toBe(boundRequest);
    expect(observed).toEqual([
      "local.interaction",
      "cloud.interaction",
    ]);
  });
});
