import { describe, expect, test } from "bun:test";

import { localPaneListLimit } from "@hraness/hra-local-observation-protocol/panes";

import {
  projectFreshLocalPaneList,
  type GatewayPaneObservationSource,
} from "./projection";

function source(index = 0): GatewayPaneObservationSource {
  return {
    id: `pane_${String(index).padStart(8, "0")}`,
    title: `Pane ${index}`,
    repository: { name: "hra" },
    interactionMode: "chat",
    state: "ready",
    workspace: { state: "ready", recoveryKind: null },
    messageQueue: {
      pauseReason: null,
      blockedMessage: null,
      messages: [],
    },
    schedule: null,
  };
}

describe("fresh local pane projection", () => {
  test("constructs only allowlisted pathless fields", () => {
    const unsafe = {
      ...source(),
      canonicalPath: "/Users/person/private/repository",
      accountProfileId: "acct_private00",
      providerSessionId: "provider-private",
      turn: { responseMarkdown: "private response", reasoning: "private reasoning" },
      repository: {
        ...source().repository,
        url: "https://token@example.invalid/private.git",
      },
      messageQueue: {
        ...source().messageQueue,
        messages: [{ text: "private queued prompt", command: "secret" }],
      },
    };
    const projection = projectFreshLocalPaneList([unsafe]);
    expect(projection.panes[0]?.queue.count).toEqual({ value: 1, capped: false });
    const serialized = JSON.stringify(projection);
    for (const sentinel of [
      "/Users/person/private/repository",
      "acct_private00",
      "provider-private",
      "private response",
      "private reasoning",
      "token@example.invalid",
      "private queued prompt",
      "secret",
    ]) expect(serialized).not.toContain(sentinel);
  });

  test("preserves grid order and marks bounded truncation", () => {
    const sources = Array.from(
      { length: localPaneListLimit + 3 },
      (_, index) => source(index),
    );
    const projection = projectFreshLocalPaneList(sources);
    expect(projection.panes).toHaveLength(localPaneListLimit);
    expect(projection.truncated).toBe(true);
    expect(projection.panes[0]?.paneId).toBe("pane_00000000");
    expect(projection.panes.at(-1)?.paneId).toBe("pane_00000063");
  });

  test("truncates valid multibyte display names at Unicode boundaries", () => {
    const multibyte = "🙂".repeat(80);
    const projection = projectFreshLocalPaneList([{
      ...source(),
      title: multibyte,
      repository: { name: multibyte },
    }]);
    const pane = projection.panes[0]!;

    expect(new TextEncoder().encode(pane.title).byteLength).toBe(160);
    expect(new TextEncoder().encode(pane.repositoryName).byteLength).toBe(160);
    expect(pane.title).toBe("🙂".repeat(40));
    expect(pane.repositoryName).toBe("🙂".repeat(40));
    expect(pane.title).not.toContain("\uFFFD");
    expect(pane.repositoryName).not.toContain("\uFFFD");
  });

  test("minimizes blocked queues and harness observers", () => {
    const ordinary = {
      ...source(1),
      messageQueue: {
        pauseReason: "ambiguousEffect",
        blockedMessage: { text: "never project this" },
        messages: [{ text: "or this" }],
      },
    };
    const observer = {
      ...source(2),
      interactionMode: "harnessObserver" as const,
      workspace: null,
    };
    const projection = projectFreshLocalPaneList([ordinary, observer]);
    expect(projection.panes[0]?.queue).toEqual({
      count: { value: 2, capped: false },
      paused: true,
      blocked: true,
    });
    expect(projection.panes[1]?.workspace).toBeNull();
  });
});
