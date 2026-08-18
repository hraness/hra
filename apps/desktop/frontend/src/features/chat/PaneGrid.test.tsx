import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
  remoteSessionSummaryProjectionSchema,
  type RemoteSessionSummaryProjection,
} from "../../../../contracts/runtime";
import {
  boundedRemoteSessionWindow,
  movePaneInOrder,
  nextPaneAnnouncement,
  remoteSessionMountLimit,
  unifiedPaneGridItems,
  type PaneAnnouncementBaseline,
  type UnifiedPaneGridItem,
} from "./PaneGrid";
import { RemoteSessionPane } from "./RemoteSessionPane";

test("the panes notice exposes only a compact truthfully gated runtime action", async () => {
  const source = await Bun.file(new URL("./PaneGrid.tsx", import.meta.url)).text();
  const retrySource = await Bun.file(
    new URL("../RuntimeRetryButton.tsx", import.meta.url),
  ).text();
  expect(source).toContain("<RuntimeRetryButton shell={shell} />");
  expect(source).toContain("availability.reconnectable");
  expect(retrySource).toContain('aria-label="Retry local runtime"');
  expect(retrySource).toContain("createRuntimeRetryCoordinator");
  expect(retrySource).toContain("isPending={pending}");
  expect(retrySource).toContain('<HRAIcon name="refresh" />');
  expect(source).not.toContain(">Reconnect<");
});

test("remote sessions render bounded observation fields and only one metadata control", () => {
  const session: RemoteSessionSummaryProjection =
    remoteSessionSummaryProjectionSchema.parse({
    sessionId: `syncsession_${"s".repeat(32)}`,
    originDeviceId: `syncdevice_${"d".repeat(32)}`,
    originDeviceName: "Travel Mac",
    gridPosition: 3,
    sourceRevision: 2,
    title: "Review the release",
    repositoryDisplayName: "Example",
    state: "working",
    updatedAt: 1_735_689_600_000,
    });
  const html = renderToStaticMarkup(createElement(RemoteSessionPane, {
    collisionLine: null,
    session,
  }));

  expect(html).toContain("Review the release");
  expect(html).toContain("encrypted remote summary");
  expect(html).toContain("view only");
  expect(html).toContain("Working");
  expect(html).toContain("Travel Mac");
  expect(html).toContain("repository Example");
  expect(html).toContain('role="tooltip"');
  expect(html).toContain('aria-expanded="false"');
  expect(html).toContain('aria-controls="remote-device-tooltip-3"');
  expect(html).toContain('<button');
  expect(html).toContain('type="button"');
  expect(html).toContain('data-observation-capability="summary-v1"');
  expect(html).not.toContain(session.sessionId);
  expect(html).not.toContain(session.originDeviceId);
  expect(html).not.toContain("GPT-5.6");
  expect(html).not.toContain("2025-");
  expect(html).not.toContain(">Working<");
  expect(html.match(/<button/gu)).toHaveLength(1);
  expect(html).not.toContain("<textarea");
  expect(html).not.toContain("prompt");
});

test("remote summaries expose a collision line only when titles collide", () => {
  const session = remoteSessionSummaryProjectionSchema.parse({
    sessionId: `syncsession_${"c".repeat(32)}`,
    originDeviceId: `syncdevice_${"d".repeat(32)}`,
    originDeviceName: "Travel Mac",
    gridPosition: 8,
    sourceRevision: 1,
    title: "Release",
    repositoryDisplayName: "Example",
    state: "ready",
    updatedAt: null,
  });
  const unique = renderToStaticMarkup(createElement(RemoteSessionPane, {
    collisionLine: null,
    session,
  }));
  const collision = renderToStaticMarkup(createElement(RemoteSessionPane, {
    collisionLine: "Travel Mac",
    session,
  }));
  expect(unique).not.toContain('class="remote-session-pane__collision"');
  expect(collision).toContain('class="remote-session-pane__collision"');
  expect(collision).toContain("Travel Mac");
  expect(collision).toContain("repository Example");
  expect(collision).toContain(
    'aria-label="Remote session: Release, repository Example, owner Travel Mac, state Ready, cell 9, encrypted remote summary, view only"',
  );
});

test("every remote state retains the readable title, device tooltip, and no mutation controls", () => {
  for (const [index, state] of [
    "ready",
    "working",
    "attention",
    "error",
    "offline",
    "revoked",
    "updateRequired",
  ].entries()) {
    const session = remoteSessionSummaryProjectionSchema.parse({
      sessionId: `syncsession_${index.toString(36).padStart(32, "0")}`,
      originDeviceId: `syncdevice_${"d".repeat(32)}`,
      originDeviceName: "Studio Mac",
      gridPosition: 11,
      sourceRevision: 1,
      title: "Last readable state",
      repositoryDisplayName: "Example",
      state,
      updatedAt: null,
    });
    const html = renderToStaticMarkup(createElement(RemoteSessionPane, {
      collisionLine: null,
      session,
    }));
    expect(html).toContain("Last readable state");
    expect(html).toContain("Studio Mac");
    expect(html).toContain('role="tooltip"');
    expect(html).not.toContain(session.sessionId);
    expect(html).not.toContain(session.originDeviceId);
    expect(html.match(/<button/gu)).toHaveLength(1);
    expect(html).not.toContain("<textarea");
    expect(html).not.toContain("Automatic subscription");
  }
});

test("the remote device affordance is a compact visible icon with a 44px touch target", async () => {
  const css = await Bun.file(new URL("../../index.css", import.meta.url)).text();
  const component = await Bun.file(new URL("./RemoteSessionPane.tsx", import.meta.url)).text();

  expect(css).toMatch(
    /\.remote-session-pane__device-trigger\s*\{[^}]*width:\s*2\.75rem;[^}]*height:\s*2\.75rem;/su,
  );
  expect(css).toMatch(
    /\.remote-session-pane__device-icon\s*\{[^}]*width:\s*0\.86rem;[^}]*height:\s*0\.86rem;/su,
  );
  expect(component).toContain('event.pointerType !== "touch"');
  expect(component).toContain("event.preventDefault()");
  expect(component).toContain("aria-expanded={deviceDetailsOpen}");
  expect(component).toContain('event.key !== "Escape"');
  expect(component).toContain('document.addEventListener("pointerdown", closeOutside, true)');
});

test("the 512-summary head mounts one stable bounded window", () => {
  const ids = Array.from({ length: 512 }, (_, index) => (
    remoteSessionSummaryProjectionSchema.parse({
      sessionId: `syncsession_${index.toString(36).padStart(32, "0")}`,
      originDeviceId: `syncdevice_${"d".repeat(32)}`,
      originDeviceName: "Travel Mac",
      gridPosition: index,
      sourceRevision: 1,
      title: `Summary ${index + 1}`,
      repositoryDisplayName: null,
      state: "ready",
      updatedAt: null,
    }).sessionId
  ));
  const first = boundedRemoteSessionWindow(ids, 0);
  const middle = boundedRemoteSessionWindow(ids, 64);
  const last = boundedRemoteSessionWindow(ids, 511);
  expect(remoteSessionMountLimit).toBeLessThan(64);
  expect(first.ids).toEqual(ids.slice(0, remoteSessionMountLimit));
  expect(middle.ids).toEqual(ids.slice(48, 96));
  expect(last.ids).toEqual(ids.slice(480));
  expect(first.ids).toHaveLength(remoteSessionMountLimit);
  expect(last.ids.length).toBeLessThanOrEqual(remoteSessionMountLimit);
  expect(new Set([...first.ids, ...middle.ids, ...last.ids]).size).toBe(
    first.ids.length + middle.ids.length + last.ids.length,
  );
});

test("pane announcements baseline route and focus changes without replaying old content", () => {
  const baseline = (overrides: Partial<PaneAnnouncementBaseline> = {}): PaneAnnouncementBaseline => ({
    activityOrdinal: 1,
    attentionMessage: null,
    availability: "ready",
    paneId: "pane_one",
    paneState: "streaming",
    paneTitle: "One",
    workspaceMessage: null,
    ...overrides,
  });

  expect(nextPaneAnnouncement(null, baseline())).toBeNull();
  expect(nextPaneAnnouncement(baseline(), baseline({
    paneId: "pane_two",
    paneTitle: "Two",
  }))).toBeNull();
  expect(nextPaneAnnouncement(baseline(), baseline({ paneState: "ready" }))).toBe(
    "One finished.",
  );
  expect(nextPaneAnnouncement(baseline(), baseline({
    attentionMessage: "Approval required.",
    paneState: "attention",
  }))).toBe("One: Approval required.");
});

test("local and bounded remote summaries share one stable grid order", () => {
  const remoteA = remoteSessionSummaryProjectionSchema.parse({
    sessionId: `syncsession_${"a".repeat(32)}`,
    originDeviceId: `syncdevice_${"d".repeat(32)}`,
    originDeviceName: "Travel Mac",
    gridPosition: 1,
    sourceRevision: 1,
    title: "A",
    repositoryDisplayName: null,
    state: "ready",
    updatedAt: null,
  });
  const remoteB = remoteSessionSummaryProjectionSchema.parse({
    ...remoteA,
    sessionId: `syncsession_${"b".repeat(32)}`,
    gridPosition: 4,
    title: "B",
  });
  expect(unifiedPaneGridItems(
    ["pane_zero", "pane_one", "pane_two"],
    [
      { paneId: "pane_zero", gridPosition: 0 },
      { paneId: "pane_one", gridPosition: 2 },
      { paneId: "pane_two", gridPosition: 5 },
    ],
    [remoteA, remoteB].map(({ sessionId, gridPosition }) => ({
      sessionId,
      gridPosition,
    })),
    [remoteA.sessionId, remoteB.sessionId],
  )).toEqual([
    { kind: "local", paneId: "pane_zero", gridPosition: 0 },
    { kind: "remote", sessionId: remoteA.sessionId, gridPosition: 1 },
    { kind: "local", paneId: "pane_one", gridPosition: 2 },
    { kind: "remote", sessionId: remoteB.sessionId, gridPosition: 4 },
    { kind: "local", paneId: "pane_two", gridPosition: 5 },
  ]);
});

test("local pane movement keeps the remote anchors in place", () => {
  expect(movePaneInOrder(
    ["pane_zero", "pane_one", "pane_two"],
    "pane_two",
    0,
  )).toEqual(["pane_two", "pane_zero", "pane_one"]);
  expect(movePaneInOrder(
    ["pane_zero", "pane_one", "pane_two"],
    "pane_zero",
    2,
  )).toEqual(["pane_one", "pane_two", "pane_zero"]);
  expect(movePaneInOrder(["pane_zero"], "pane_missing", 0)).toEqual(["pane_zero"]);
});

test("the local grid exposes pointer drag and keyboard-accessible move commands", async () => {
  const grid = await Bun.file(new URL("./PaneGrid.tsx", import.meta.url)).text();
  const pane = await Bun.file(new URL("./ChatPane.tsx", import.meta.url)).text();

  expect(grid).toContain("expectedOrderedPaneIds: orderedLocalPaneIds");
  expect(grid).toContain('event.dataTransfer.effectAllowed = "move"');
  expect(grid).toContain("onDragStart={(event) => startPaneDrag(item.paneId, event)}");
  expect(pane).toContain('<MenuItem id="move-earlier" textValue="Move earlier">');
  expect(pane).toContain('<MenuItem id="move-later" textValue="Move later">');
});

test("a remote session stays ahead of a newly created unbound local pane", () => {
  const remote = remoteSessionSummaryProjectionSchema.parse({
    sessionId: `syncsession_${"r".repeat(32)}`,
    originDeviceId: `syncdevice_${"d".repeat(32)}`,
    originDeviceName: "Travel Mac",
    gridPosition: 0,
    sourceRevision: 1,
    title: "Remote first",
    repositoryDisplayName: null,
    state: "ready",
    updatedAt: null,
  });
  const slots = [{ sessionId: remote.sessionId, gridPosition: remote.gridPosition }];
  const first = unifiedPaneGridItems(["pane_new"], [], slots, [remote.sessionId]);
  const restarted = unifiedPaneGridItems(["pane_new"], [], slots, [remote.sessionId]);
  expect(first).toEqual([
    { kind: "remote", sessionId: remote.sessionId, gridPosition: 0 },
    { kind: "local", paneId: "pane_new", gridPosition: 1 },
  ]);
  expect(restarted).toEqual(first);
});

test("persisted local slots survive restart and remote grid gaps", () => {
  const remoteSlots = (["a", "b"] as const).map((character, index) => {
    const session = remoteSessionSummaryProjectionSchema.parse({
      sessionId: `syncsession_${character.repeat(32)}`,
      originDeviceId: `syncdevice_${"d".repeat(32)}`,
      originDeviceName: "Travel Mac",
      gridPosition: index === 0 ? 0 : 4,
      sourceRevision: 1,
      title: `Remote ${character}`,
      repositoryDisplayName: null,
      state: "ready",
      updatedAt: null,
    });
    return { sessionId: session.sessionId, gridPosition: session.gridPosition };
  });
  const localSlots = [{ paneId: "pane_bound", gridPosition: 2 }];
  const expected = [
    { kind: "remote", sessionId: remoteSlots[0]!.sessionId, gridPosition: 0 },
    { kind: "local", paneId: "pane_bound", gridPosition: 2 },
    { kind: "remote", sessionId: remoteSlots[1]!.sessionId, gridPosition: 4 },
    { kind: "local", paneId: "pane_new", gridPosition: 5 },
  ] satisfies readonly UnifiedPaneGridItem[];
  expect(unifiedPaneGridItems(
    ["pane_bound", "pane_new"],
    localSlots,
    remoteSlots,
    remoteSlots.map(({ sessionId }) => sessionId),
  )).toEqual(expected);
  expect(unifiedPaneGridItems(
    ["pane_bound", "pane_new"],
    [...localSlots],
    [...remoteSlots].reverse(),
    remoteSlots.map(({ sessionId }) => sessionId),
  )).toEqual(expected);
});
