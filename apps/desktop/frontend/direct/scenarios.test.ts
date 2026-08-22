import { describe, expect, test } from "bun:test";

import {
  attentionPresentations,
  denseGridSessionCount,
  denseRemoteSessionCount,
  manyChatPaneCount,
  manyChatPaneId,
  hraDirectDefinition,
  hraScenarioMetadata,
  parallelScriptedDeltaCount,
  parallelStreamExpectedResponses,
  parallelStreamPaneCount,
  parallelStreamRounds,
} from "./scenarios";
import { applyRuntimeEvent } from "../src/runtime";
import {
  chatTurnProjectionSchema,
  runtimeProtocolVersion,
  runtimeSnapshotChunkCountLimit,
} from "../../contracts/runtime";

const {
  coverage: hraCoverageCatalog,
  scenarios: hraScenarioCatalog,
} = hraDirectDefinition;

const expectedScenarios = [
  "account-maximum-label",
  "account-signed-out",
  "attention-mission-control",
  "chat-attention",
  "chat-compact-320",
  "chat-compact-415",
  "chat-compact-639",
  "chat-compact-malleable",
  "chat-completed",
  "chat-create-pane",
  "chat-create-pane-inherit",
  "chat-draft",
  "chat-many-panes",
  "chat-pane-order",
  "chat-parallel-streaming",
  "chat-scheduled",
  "chat-streaming",
  "credential-expired",
  "credential-recovery",
  "empty-ready",
  "gateway-failed",
  "gateway-starting",
  "harness-children-mixed",
  "harness-settings",
  "login-browser",
  "profile-sibling-failed",
  "profiles-isolated",
  "remote-session-summaries-512",
  "renderer-boundary",
  "session-sync-fault-auth",
  "session-sync-fault-cloud",
  "session-sync-fault-keychain",
  "session-sync-fault-network",
  "settings-browser-login",
  "settings-human-credential-recovery",
  "settings-no-subscriptions",
  "settings-session-sync-active",
  "settings-session-sync-disabled",
  "settings-session-sync-enrolling",
  "settings-session-sync-unavailable",
  "transport-recovery",
] as const;

const expectedCoverage = [
  "attention.mission-control",
  "chat.pane.attachment-preview",
  "chat.pane.attention-recovery",
  "chat.pane.compact-responsive",
  "chat.pane.create",
  "chat.pane.draft",
  "chat.pane.elapsed",
  "chat.pane.identity-status",
  "chat.pane.inline-title",
  "chat.pane.latest-response",
  "chat.pane.order",
  "chat.pane.parallel-performance",
  "chat.pane.queue-steer",
  "chat.pane.schedule",
  "chat.pane.streaming",
  "chat.subscription-gate",
  "chat.turn.routing",
  "execution.shared-folder",
  "harness.native-persistence.direct",
  "harness.ordinary-zero-chrome",
  "harness.provider-recursion.direct",
  "harness.recursive-children",
  "harness.renderer-boundary",
  "harness.settings",
  "native.gateway.direct",
  "native.zig.bridge.direct",
  "renderer.chat-boundary",
  "renderer.remote-summary-window",
  "settings.human-credential-recovery",
  "settings.session-sync-security",
  "settings.subscription-browser-login",
  "transport.chunked.snapshot",
  "transport.ordered-chat-deltas",
] as const;

describe("HRA Direct catalogs", () => {
  test("keeps scenarios and metadata total and stable", () => {
    const ids = hraScenarioCatalog.list().map(({ id }) => String(id)).toSorted();
    expect(ids).toEqual([...expectedScenarios]);
    expect(Object.keys(hraScenarioMetadata).toSorted()).toEqual(ids);
  });

  test("keeps dense-grid pane identities total and bounded", () => {
    expect(Array.from({ length: manyChatPaneCount }, (_, index) => manyChatPaneId(index + 1)))
      .toEqual(Array.from({ length: 64 }, (_, index) => (
        `pane_grid${String(index + 1).padStart(8, "0")}`
      )));
    for (const invalid of [-1, 0, 1.5, manyChatPaneCount + 1, Number.NaN]) {
      expect(() => manyChatPaneId(invalid)).toThrow();
    }
  });

  test("dense panes distinguish every HRA-selected route without provider claims", () => {
    const scenario = hraScenarioCatalog.resolve("chat-many-panes");
    if (!scenario.ok) throw new Error(scenario.error.message);
    const panes = scenario.value.world.gateway.snapshots[0]?.chat.panes.slice(0, 4);
    expect(panes?.map((pane) => ({
      requested: pane.turn?.routing?.requestedProfile,
      selected: pane.turn?.routing?.selectedProfile,
      profileFallback: pane.turn?.routing?.profileFallbackReason,
      requestedTier: pane.turn?.routing?.requestedServiceTier,
      selectedTier: pane.turn?.routing?.selectedServiceTier,
      tierFallback: pane.turn?.routing?.serviceTierFallbackReason,
    }))).toEqual([
      {
        requested: "lunaMax",
        selected: "lunaMax",
        profileFallback: null,
        requestedTier: "fast",
        selectedTier: "fast",
        tierFallback: null,
      },
      {
        requested: "solMax",
        selected: "solMax",
        profileFallback: null,
        requestedTier: "standard",
        selectedTier: "standard",
        tierFallback: null,
      },
      {
        requested: "solUltra",
        selected: "solUltra",
        profileFallback: null,
        requestedTier: "standard",
        selectedTier: "standard",
        tierFallback: null,
      },
      {
        requested: "lunaMax",
        selected: "solMax",
        profileFallback: "lunaUnavailable",
        requestedTier: "fast",
        selectedTier: "standard",
        tierFallback: "fastUnavailable",
      },
    ]);
    expect(JSON.stringify(panes)).not.toContain("observedProfile");
  });

  test("declares the exact fixture/direct evidence boundary", () => {
    expect(hraCoverageCatalog.keys().map(String).toSorted()).toEqual([...expectedCoverage]);
    for (const entry of hraCoverageCatalog.list()) {
      if (entry.mode === "direct") expect(entry.scenarios).toEqual([]);
      else expect(entry.scenarios.length).toBeGreaterThan(0);
    }
  });

  test("keeps chat snapshots bounded while project-add results remain pathless", () => {
    for (const scenario of hraScenarioCatalog.list()) {
      for (const snapshot of scenario.world.gateway.snapshots) {
        expect(Object.keys(snapshot).toSorted()).toEqual([
          "accounts",
          "chat",
          "execution",
          "harness",
          "humanAccount",
          "lastSequence",
          "retainedAccountLocalData",
          "revision",
          "runner",
          "runtime",
          "sessionSync",
        ]);
        for (const account of snapshot.accounts) {
          expect(account).not.toHaveProperty("usage");
          expect(account).not.toHaveProperty("models");
        }
      }
      expect(scenario.world.task.projectAdd).not.toHaveProperty("trustedDirectoryPath");
      expect(scenario.world.task.projectAdd).not.toHaveProperty("path");
    }
  });

  test("projects weekly remaining capacity and reset beside a distinct cloud sign-in state", () => {
    const scenario = hraScenarioCatalog.resolve("settings-browser-login");
    if (!scenario.ok) throw new Error(scenario.error.message);
    const snapshot = scenario.value.world.gateway.snapshots[0];

    expect(snapshot?.accounts.find(({ label }) => label === "Work")).toMatchObject({
      identityLabel: "builder@work.example",
      weeklyUsage: {
        remainingPercent: 64,
        resetsAt: "2026-07-24T15:00:00.000Z",
      },
    });
    expect(snapshot?.humanAccount).toEqual({ state: "signedOut", revision: 0 });
    expect(hraCoverageCatalog.list().find(
      ({ key }) => key === "settings.subscription-browser-login",
    )?.claim).toContain("HRA Cloud attachment");
  });

  test("starts human credential recovery from one strict revision-bound error", () => {
    const scenario = hraScenarioCatalog.resolve("settings-human-credential-recovery");
    if (!scenario.ok) throw new Error(scenario.error.message);
    expect(scenario.value.world.gateway.snapshots).toHaveLength(1);
    expect(scenario.value.world.gateway.snapshots[0]?.humanAccount).toEqual({
      state: "error",
      revision: 7,
      code: "CREDENTIAL_RECOVERY_REQUIRED",
      message: "Human credential recovery is required before signing in.",
      retryable: false,
      profile: null,
    });
    expect(hraCoverageCatalog.list().find(
      ({ key }) => key === "settings.human-credential-recovery",
    )).toMatchObject({
      mode: "mixed",
      scenarios: ["settings-human-credential-recovery"],
    });
  });

  test("keeps session sync opt-in, pairing, and the 512-summary boundary explicit", () => {
    const resolve = (id: string) => {
      const scenario = hraScenarioCatalog.resolve(id);
      if (!scenario.ok) throw new Error(scenario.error.message);
      const snapshot = scenario.value.world.gateway.snapshots[0];
      if (snapshot === undefined) throw new Error(`Missing snapshot: ${id}`);
      return snapshot.sessionSync;
    };
    expect(resolve("settings-session-sync-disabled")).toMatchObject({
      status: { state: "disabled", revision: 0 },
      remoteSessions: [],
    });
    expect(resolve("settings-session-sync-unavailable")).toMatchObject({
      status: { state: "unavailable", retryable: true },
      remoteSessions: [],
    });
    expect(resolve("settings-session-sync-enrolling")).toMatchObject({
      status: {
        state: "enrolling",
        pairingCode: "123456",
        phase: "awaitingApproval",
      },
      remoteSessions: [],
    });
    const active = resolve("settings-session-sync-active");
    expect(active.status).toMatchObject({
      state: "active",
      devices: [{ current: true }, { current: false }, { current: false }],
      pendingEnrollments: [{ pairingCode: "123456" }],
    });
    expect(active.remoteSessions).toHaveLength(4);
    const maximumScenario = hraScenarioCatalog.resolve("remote-session-summaries-512");
    if (!maximumScenario.ok) throw new Error(maximumScenario.error.message);
    const maximumSnapshot = maximumScenario.value.world.gateway.snapshots[0];
    if (maximumSnapshot === undefined) throw new Error("Maximum session snapshot is missing.");
    const maximum = maximumSnapshot.sessionSync;
    expect(maximumSnapshot.chat.panes).toHaveLength(manyChatPaneCount);
    expect(maximum.localGridSlots).toHaveLength(manyChatPaneCount);
    expect(maximum.remoteSessions).toHaveLength(denseRemoteSessionCount);
    expect(maximum.localGridSlots.length + maximum.remoteSessions.length)
      .toBe(denseGridSessionCount);
    expect(new Set([
      ...maximum.localGridSlots.map(({ gridPosition }) => gridPosition),
      ...maximum.remoteSessions.map(({ gridPosition }) => gridPosition),
    ]).size).toBe(denseGridSessionCount);
    expect(maximum.status).toMatchObject({
      state: "active",
      scopeGeneration: 1,
      devices: [
        { name: "Studio Mac" },
        { name: "Travel Mac" },
        { name: "Office Mac" },
      ],
    });
    expect(JSON.stringify(maximum.status)).not.toContain("lastSeenAt");
    const overlappingTitle = maximumSnapshot.chat.panes[0]?.title;
    expect(overlappingTitle).toBe("Parallel pane 1");
    expect(new Set(maximum.remoteSessions
      .filter(({ title }) => title === overlappingTitle)
      .map(({ originDeviceName }) => originDeviceName)))
      .toEqual(new Set(["Travel Mac", "Office Mac"]));
    expect(new Set(maximum.remoteSessions.map(({ sessionId }) => sessionId)).size)
      .toBe(denseRemoteSessionCount);
    for (const session of maximum.remoteSessions) {
      expect(Object.keys(session).toSorted()).toEqual([
        "gridPosition",
        "originDeviceId",
        "originDeviceName",
        "repositoryDisplayName",
        "sessionId",
        "sourceRevision",
        "state",
        "title",
        "updatedAt",
      ]);
      expect(JSON.stringify(session)).not.toMatch(
        /account|content|provider|raw|transcript|\/Users\/|Application Support/iu,
      );
    }
    const syncCoverage = hraCoverageCatalog.list().find(
      ({ key }) => key === "settings.session-sync-security",
    );
    expect(syncCoverage?.claim).toContain(
      "unavailable approval and revocation stay fail-closed",
    );
    expect(syncCoverage?.claim).toContain(
      "active Settings reveal recovery material and disable sync",
    );
    expect(syncCoverage?.claim).not.toContain("revocation is named and confirmed");
  });

  test("keeps credential recovery states explicit", () => {
    const snapshot = (id: string) => {
      const scenario = hraScenarioCatalog.resolve(id);
      if (!scenario.ok) throw new Error(`Missing scenario: ${id}`);
      const value = scenario.value.world.gateway.snapshots[0];
      if (value === undefined) throw new Error(`Missing snapshot: ${id}`);
      return value;
    };
    expect(snapshot("credential-expired").accounts[0]?.authState).toBe("expired");
  });

  test("renders every owned attention presentation in one recoverable fixture", () => {
    const attention = hraScenarioCatalog.resolve("chat-attention");
    if (!attention.ok) throw new Error(attention.error.message);
    const snapshot = attention.value.world.gateway.snapshots[0];
    if (snapshot === undefined) throw new Error("Attention scenario snapshot is missing.");

    expect(snapshot.chat.panes).toHaveLength(attentionPresentations.length);
    expect(snapshot.chat.panes.map((pane) => pane.attention?.code)).toEqual(
      attentionPresentations.map(({ code }) => code),
    );
    expect(snapshot.chat.panes.map((pane) => pane.attention?.message)).toEqual(
      attentionPresentations.map(({ message }) => message),
    );
    expect(snapshot.chat.panes.map((pane) => pane.recoverablePrompt)).toEqual(
      attentionPresentations.map(({ recoverablePrompt }) => recoverablePrompt),
    );
    expect(snapshot.chat.panes.filter(({ recoverablePrompt }) => recoverablePrompt))
      .toHaveLength(1);
    expect(snapshot.chat.panes.every((pane) => (
      pane.state === "attention" &&
      pane.turn?.status === "failed" &&
      pane.attention?.retryable === true
    ))).toBeTrue();
    expect(new Set(attentionPresentations.map(({ code }) => code)).size).toBe(5);

    const coverage = hraCoverageCatalog.list().find(
      ({ key }) => key === "chat.pane.attention-recovery",
    );
    expect(coverage).toMatchObject({
      mode: "fixture",
      scenarios: ["chat-attention"],
    });
    expect(coverage?.claim).toContain("each permit a later message");
  });

  test("models minimal recursive settings, proposals, and persistent child states", () => {
    const snapshot = (id: string) => {
      const scenario = hraScenarioCatalog.resolve(id);
      if (!scenario.ok) throw new Error(`Missing scenario: ${id}`);
      const value = scenario.value.world.gateway.snapshots[0];
      if (value === undefined) throw new Error(`Missing snapshot: ${id}`);
      return value;
    };
    const children = snapshot("harness-children-mixed").chat.panes[0]?.harness
      ?.descendants.children;

    expect(children?.map(({ state }) => state)).toEqual([
      "starting",
      "running",
      "waiting",
      "idle",
      "failed",
      "stopped",
      "quarantined",
    ]);
    expect(children?.map(({ canStop }) => canStop)).toEqual([
      true,
      true,
      true,
      true,
      true,
      false,
      false,
    ]);
    expect(snapshot("harness-children-mixed").chat.panes).toHaveLength(1);
    expect(snapshot("harness-settings").harness?.settings).toEqual({
      revision: 2,
      recursiveSessionsEnabled: true,
      contextQuotaBytes: 16 * 1024 * 1024,
      refinementMode: "suggest",
    });
    expect(snapshot("harness-settings").harness?.proposals).toEqual([{
      id: "hproposal_exactcontext01",
      revision: 1,
      title: "Prefer exact context slices",
    }]);
    expect(JSON.stringify(snapshot("harness-settings").harness)).not.toMatch(
      /providerId|filesystemPath|transcript|heapContents|programSource|trialRecord|arbitraryCommand/iu,
    );
    expect(hraScenarioCatalog.resolve("chat-draft")).toMatchObject({
      ok: true,
      value: { world: { gateway: { snapshots: [{ harness: null }] } } },
    });
  });

  test("streaming activity advances one semantic ordinal before every later delta", () => {
    const streaming = hraScenarioCatalog.resolve("chat-streaming");
    if (!streaming.ok) throw new Error(streaming.error.message);
    const initial = streaming.value.world.gateway.snapshots[0];
    if (initial === undefined) throw new Error("Streaming scenario snapshot is missing.");

    let projected = initial;
    const activityOrdinals: number[] = [];
    for (const { event } of streaming.value.world.gateway.events) {
      const result = applyRuntimeEvent(projected, event);
      if (result.kind !== "applied") throw new Error(`Streaming event was ${result.kind}.`);
      projected = result.snapshot;
      if (event.event.type === "chat.pane.upserted") {
        activityOrdinals.push(event.event.pane.activity.ordinal);
      }
    }

    expect(activityOrdinals).toEqual([2, 3]);
    expect(projected.lastSequence).toBe(4);
    expect(projected.chat.panes[0]).toMatchObject({
      revision: 5,
      state: "streaming",
      activity: { ordinal: 3, kind: "toolStarted" },
      turn: {
        reasoningSummary: {
          tail: "Checking the release state and the current public route.",
        },
        responseMarkdown: {
          tail: "## In progress\n\nThe signed artifact is being verified",
        },
      },
    });
  });

  test("every chunked scenario snapshot fits the production transfer-count circuit", () => {
    for (const id of expectedScenarios) {
      const scenario = hraScenarioCatalog.resolve(id);
      if (!scenario.ok) throw new Error(scenario.error.message);
      const { encoding, snapshots } = scenario.value.world.gateway;
      if (encoding.kind !== "chunked") continue;
      for (const snapshot of snapshots) {
        const byteLength = new TextEncoder().encode(JSON.stringify({
          version: runtimeProtocolVersion,
          snapshot,
        })).length;
        expect(Math.ceil(byteLength / encoding.chunkBytes)).toBeLessThanOrEqual(
          runtimeSnapshotChunkCountLimit,
        );
      }
    }
  });

  test("models compact text scaling separately from sustained concurrent streaming evidence", () => {
    expect(hraScenarioMetadata["chat-compact-639"].viewport).toBe("compact");
    expect(hraScenarioMetadata["chat-compact-415"].viewport).toBe("compact");
    expect(hraScenarioMetadata["chat-compact-320"].viewport).toBe("compact");
    expect(hraScenarioMetadata["chat-compact-malleable"].viewport).toBe("compact");

    const parallel = hraScenarioCatalog.resolve("chat-parallel-streaming");
    if (!parallel.ok) throw new Error(parallel.error.message);
    const initial = parallel.value.world.gateway.snapshots[0];
    if (initial === undefined) throw new Error("Parallel scenario snapshot is missing.");
    const settledSibling = initial.sessionSync.remoteSessions[0];
    const events = parallel.value.world.gateway.events.map(({ event }) => event.event);
    const deltas = events.filter((event) => event.type === "chat.turn.delta");
    expect(deltas).toHaveLength(parallelScriptedDeltaCount);
    expect(new Set(events.map((event) => event.type))).toEqual(
      new Set(["chat.turn.delta"]),
    );
    expect(new Set(deltas.map((event) => {
      return event.paneId;
    })))
      .toEqual(new Set(Array.from(
        { length: parallelStreamPaneCount },
        (_, index) => `pane_live_lane_${String(index + 1)}`,
      )));
    for (const [index, event] of deltas.entries()) {
      expect(event.paneId).toBe(
        `pane_live_lane_${String(index % parallelStreamPaneCount + 1)}`,
      );
      expect(event.revision).toBe(Math.floor(index / parallelStreamPaneCount) + 2);
    }
    expect(parallel.value.world.gateway.events[0]?.delayMs).toBe(120_000);
    expect(parallel.value.world.gateway.events.slice(1).every(({ delayMs }) =>
      delayMs === 500
    )).toBeTrue();
    expect(parallelScriptedDeltaCount).toBe(
      parallelStreamPaneCount * parallelStreamRounds,
    );
    expect(initial.sessionSync.remoteSessions).toHaveLength(denseRemoteSessionCount);
    expect(settledSibling?.title).toBe("Control pane");

    let projected = initial;
    for (const { event } of parallel.value.world.gateway.events) {
      const result = applyRuntimeEvent(projected, event);
      if (result.kind !== "applied") throw new Error(`Parallel event was ${result.kind}.`);
      projected = result.snapshot;
    }
    expect(projected.lastSequence).toBe(parallelScriptedDeltaCount);
    expect(projected.chat.panes
      .slice(0, parallelStreamPaneCount)
      .map(({ turn }) => turn?.responseMarkdown.tail))
      .toEqual([...parallelStreamExpectedResponses]);
    expect(projected.chat.panes[0]).toMatchObject({
      revision: parallelStreamRounds + 1,
      state: "streaming",
      turn: { tools: [] },
    });
    expect(projected.sessionSync.remoteSessions[0]).toBe(settledSibling);
  });

  test("models only attachment, clock, and identity as a strict compact surface port", () => {
    const compact = hraScenarioCatalog.resolve("chat-compact-malleable");
    if (!compact.ok) throw new Error(compact.error.message);
    expect(compact.value.world.surface).toEqual({
      kind: "compactChat",
      paneId: "pane_compact_malleable",
      nowUnixMilliseconds: 1_784_480_505_000,
      attachments: [{
        id: "attachment_compactdirect01",
        name: "compact-layout.png",
        mimeType: "image/png",
        byteSize: 2_048,
      }],
    });
    expect(compact.value.world.gateway.snapshots[0]?.chat.panes[0]?.messageQueue)
      .toEqual({
        revision: 4,
        pauseReason: null,
        blockedMessage: null,
        messages: [{
          id: "chatmsg_compactdirect01",
          ordinal: 1,
          revision: 2,
          text: "Steer the active turn with the accessibility findings.",
          attachmentRefs: [],
        }, {
          id: "chatmsg_compactdirect02",
          ordinal: 2,
          revision: 1,
          text: "Then tighten the 26rem layout.",
          attachmentRefs: [],
        }],
      });
    const attachmentCoverage = hraCoverageCatalog.list().find(
      ({ key }) => key === "chat.pane.attachment-preview",
    );
    expect(attachmentCoverage?.mode).toBe("mixed");
    expect(attachmentCoverage?.claim).toContain("focused live integration tests");
  });

  test("renders only completion-verified terminal reasoning", () => {
    const completed = hraScenarioCatalog.resolve("chat-completed");
    if (!completed.ok) throw new Error(completed.error.message);
    const turn = completed.value.world.gateway.snapshots[0]?.chat.panes[0]?.turn;
    if (turn === null || turn === undefined) {
      throw new Error("Completed Direct fixture has no terminal turn");
    }
    expect(turn).toMatchObject({
        status: "completed",
        reasoningSummaryVerified: true,
        reasoningSummary: {
          tail: "### Verified reasoning\n\nCompletion reconciliation confirmed the exact provider summary.",
        },
      });
    expect(chatTurnProjectionSchema.safeParse({
      ...turn,
      reasoningSummaryVerified: false,
    }).success).toBeFalse();
    expect(hraCoverageCatalog.list().find(
      ({ key }) => key === "chat.pane.latest-response",
    )?.claim).toContain("raw or unverified terminal reasoning stays hidden");
  });
});
