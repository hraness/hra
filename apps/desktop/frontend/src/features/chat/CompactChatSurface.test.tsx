import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import type {
  ChatMessageQueueProjection,
  ChatTurnProjection,
  HarnessChildProjection,
} from "../../../../contracts/runtime";
import {
  ActiveSubagentStack,
  AttachmentPreviewStack,
  compactComposerDelivery,
  createCoarseTurnClock,
  formatTurnElapsed,
  isRasterImagePreviewMimeType,
  paneIdentityHue,
  paneIdentityStyle,
  pastedImagesFromClipboard,
  queuedMessageEditKeyAction,
  queuedMessageEditSettlement,
  QueuedMessageStack,
  ScheduledChatStatus,
  ScheduleModeToggle,
  safeAttachmentPreviewUrl,
  TurnElapsed,
  visibleSubagents,
} from "./CompactChatSurface";

const queue: ChatMessageQueueProjection = {
  revision: 7,
  pauseReason: null,
  blockedMessage: null,
  messages: [{
    id: "chatmsg_compactqueue01",
    ordinal: 1,
    revision: 2,
    text: "Check the compact queue",
    attachmentRefs: ["attachment_compact01"],
  }, {
    id: "chatmsg_compactqueue02",
    ordinal: 2,
    revision: 1,
    text: "Then verify touch containment",
    attachmentRefs: [],
  }],
};

function child(
  id: string,
  title: string,
  state: HarnessChildProjection["state"],
): HarnessChildProjection {
  const terminal = state === "stopped" || state === "quarantined";
  return {
    id,
    revision: 1,
    title,
    state,
    openedPaneId: null,
    canOpen: state === "idle",
    canMessage: false,
    canStop: !terminal,
  };
}

test("turn durations use the compact hours, minutes, seconds grammar", () => {
  expect(formatTurnElapsed(0)).toBe("0s");
  expect(formatTurnElapsed(45_999)).toBe("45s");
  expect(formatTurnElapsed(61_999)).toBe("1m 1s");
  expect(formatTurnElapsed(7_305_999)).toBe("2h 1m 45s");

  const turn: ChatTurnProjection = {
    id: "chatturn_compactelapsed01",
    status: "completed",
    startedAt: "2026-08-18T10:00:00.000Z",
    completedAt: "2026-08-18T12:01:45.000Z",
    continuationCount: 0,
    responseMarkdown: { tail: "Done", totalUtf8Bytes: 4, truncatedPrefix: false },
    reasoningSummary: { tail: "", totalUtf8Bytes: 0, truncatedPrefix: false },
    reasoningSummaryVerified: false,
    tools: [],
    providerSubagents: { agents: [], overflowCount: 0 },
    routing: null,
  };
  const html = renderToStaticMarkup(createElement(TurnElapsed, { turn }));
  expect(html).toContain("2h 1m 45s");
  expect(html).toContain('dateTime="PT7305S"');
  expect(html).toContain('aria-label="Last turn duration 2h 1m 45s"');
  expect(html).not.toContain("aria-live");
});

test("scheduled chat chrome names the next run without exposing RRULE internals", () => {
  const schedule = {
    revision: 1,
    rrule: "DTSTART;TZID=America/Puerto_Rico:20260819T090000\nRRULE:FREQ=DAILY;INTERVAL=1",
    timeZone: "America/Puerto_Rico",
    nextRunAt: "2026-08-19T13:00:00.000Z",
  } as const;
  const status = renderToStaticMarkup(createElement(ScheduledChatStatus, {
    nowUnixMilliseconds: Date.parse("2026-08-19T12:00:00.000Z"),
    schedule,
  }));
  expect(status).toContain("Scheduled · in 1h");
  expect(status).toContain('dateTime="2026-08-19T13:00:00.000Z"');
  expect(status).not.toContain("FREQ=DAILY");

  const toggle = renderToStaticMarkup(createElement(ScheduleModeToggle, {
    disabled: false,
    onChange: () => undefined,
    selected: true,
  }));
  expect(toggle).toContain('aria-label="Turn off scheduling"');
  expect(toggle).toContain('aria-pressed="true"');
});

test("the shared coarse clock sleeps while hidden and restarts for visible subscribers", () => {
  type IntervalHandle = ReturnType<typeof setInterval>;
  let cancelledIntervals = 0;
  let intervalListener: (() => void) | null = null;
  let now = 1_000;
  let scheduledIntervals = 0;
  let visible = true;
  let visibilityListener: (() => void) | null = null;
  let visibilityUnsubscribes = 0;
  const clock = createCoarseTurnClock({
    cancelInterval: () => {
      cancelledIntervals += 1;
      intervalListener = null;
    },
    listenForVisibilityChange: (listener) => {
      visibilityListener = listener;
      return () => {
        visibilityListener = null;
        visibilityUnsubscribes += 1;
      };
    },
    now: () => now,
    scheduleInterval: (listener) => {
      scheduledIntervals += 1;
      intervalListener = listener;
      return scheduledIntervals as unknown as IntervalHandle;
    },
    visible: () => visible,
  });
  let updates = 0;
  const unsubscribeFirst = clock.subscribe(() => {
    updates += 1;
  });
  const unsubscribeSecond = clock.subscribe(() => {
    updates += 1;
  });

  expect(scheduledIntervals).toBe(1);
  now = 2_001;
  (intervalListener as (() => void) | null)?.();
  expect(clock.getSnapshot()).toBe(2_001);
  expect(updates).toBe(2);

  visible = false;
  (visibilityListener as (() => void) | null)?.();
  expect(cancelledIntervals).toBe(1);
  expect(intervalListener).toBeNull();

  now = 8_500;
  visible = true;
  (visibilityListener as (() => void) | null)?.();
  expect(clock.getSnapshot()).toBe(8_500);
  expect(updates).toBe(4);
  expect(scheduledIntervals).toBe(2);

  unsubscribeFirst();
  expect(cancelledIntervals).toBe(1);
  unsubscribeSecond();
  expect(cancelledIntervals).toBe(2);
  expect(visibilityUnsubscribes).toBe(1);
});

test("golden-angle pane colors require an explicit durable palette index", () => {
  expect(paneIdentityHue(0)).toBe(255);
  expect(paneIdentityHue(1)).not.toBe(paneIdentityHue(0));
  expect(paneIdentityHue(360)).toBeGreaterThanOrEqual(0);
  expect(paneIdentityHue(360)).toBeLessThan(360);
  expect(() => paneIdentityHue(-1)).toThrow("nonnegative safe integer");
  expect(() => paneIdentityHue(1.5)).toThrow("nonnegative safe integer");
  expect(paneIdentityStyle(0)).toMatchObject({
    "--pane-identity-hue": "255.000",
    "--pane-identity": "var(--pane-identity-strong)",
  });
  expect(JSON.stringify(paneIdentityStyle(0))).toContain("light-dark(oklch(");
  expect(paneIdentityStyle(null)).toBeUndefined();
});

test("the pinned subagent stack includes only active actors without inventing overflow", () => {
  const children = [
    child("hactor_compactrunning01", "Routing audit", "running"),
    child("hactor_compactwaiting01", "Direct verification", "waiting"),
    child("hactor_compactstarting1", "Attachment vault", "starting"),
    child("hactor_compactidle0001", "UI review", "idle"),
    child("hactor_compactfailed001", "Failed review", "failed"),
    child("hactor_compactstopped1", "Old lane", "stopped"),
  ];
  const visible = visibleSubagents(children);
  const html = renderToStaticMarkup(createElement(ActiveSubagentStack, {
    children,
    provider: { agents: [], overflowCount: 0 },
  }));

  expect(visible.map(({ title }) => title)).toEqual([
    "Routing audit",
    "Direct verification",
    "Attachment vault",
  ]);
  expect(html).toContain('aria-label="Active subagents"');
  expect(html).toContain("Routing audit");
  expect(html).toContain("Direct verification");
  expect(html).toContain("Attachment vault");
  expect(html).not.toContain("UI review");
  expect(html).not.toContain("Failed review");
  expect(html).not.toContain("Old lane");
  expect(html).not.toContain("more");
  expect(html).not.toContain("Open Routing audit");
  expect(html).not.toContain("Stop Routing audit");
});

test("only the FIFO head exposes steering and ambiguous pause cannot resume", () => {
  const interactive = renderToStaticMarkup(createElement(QueuedMessageStack, {
    queue,
    onEdit: () => Promise.resolve(),
    onRemove: () => undefined,
    onSteerHead: () => undefined,
  }));
  expect(interactive.match(/Send queued message now/gu)).toHaveLength(1);
  expect(interactive.match(/Edit queued message/gu)).toHaveLength(2);
  expect(interactive.match(/Remove queued message/gu)).toHaveLength(2);

  const ambiguous = renderToStaticMarkup(createElement(QueuedMessageStack, {
    queue: {
      ...queue,
      pauseReason: "ambiguousEffect",
      blockedMessage: {
        id: "chatmsg_compactblocked1",
        ordinal: 1,
        revision: 3,
        text: "This message may have been delivered",
        attachmentRefs: [],
        deliveryOutcome: "deliveryOutcomeUnknown",
      },
      messages: [],
    },
    onDiscardAmbiguous: () => undefined,
    onEdit: () => Promise.resolve(),
    onRemove: () => undefined,
    onResume: () => undefined,
    onSteerHead: () => undefined,
  }));
  expect(ambiguous).toContain("Delivery outcome unknown.");
  expect(ambiguous).toContain("This message may have been delivered");
  expect(ambiguous).toContain("Discard message with unknown delivery outcome");
  expect(ambiguous).not.toContain(">Resume<");
  expect(ambiguous).not.toContain("Send queued message now");
  expect(ambiguous).not.toContain("Edit queued message");
  expect(ambiguous).not.toContain("Retry");
});

test("quarantined context exposes one native Start fresh action and suppresses Resume", () => {
  const html = renderToStaticMarkup(createElement(QueuedMessageStack, {
    queue: {
      revision: 4,
      pauseReason: "attention",
      blockedMessage: null,
      messages: [],
    },
    onEdit: () => Promise.resolve(),
    onRemove: () => undefined,
    onResume: () => undefined,
    onStartFresh: () => undefined,
    onSteerHead: () => undefined,
  }));
  expect(html).toContain('<button type="button">Start fresh</button>');
  expect(html).not.toContain(">Resume<");
  expect(html).toContain('role="status"');
});

test("queued-message edit shortcuts are IME-safe", () => {
  expect(queuedMessageEditKeyAction({
    isComposing: true,
    key: "Escape",
    metaKey: false,
    ctrlKey: false,
  })).toBeNull();
  expect(queuedMessageEditKeyAction({
    isComposing: true,
    key: "Enter",
    metaKey: true,
    ctrlKey: false,
  })).toBeNull();
  expect(queuedMessageEditKeyAction({
    isComposing: false,
    key: "Escape",
    metaKey: false,
    ctrlKey: false,
  })).toBe("cancel");
  expect(queuedMessageEditKeyAction({
    isComposing: false,
    key: "Enter",
    metaKey: false,
    ctrlKey: true,
  })).toBe("save");
  expect(queuedMessageEditSettlement({
    draft: "unsaved changed text",
    outcome: "failed",
    errorMessage: "The queue revision changed.",
  })).toEqual({
    draft: "unsaved changed text",
    editing: true,
    error: "The queue revision changed.",
  });
  expect(queuedMessageEditSettlement({
    draft: "confirmed text",
    outcome: "confirmed",
  })).toEqual({
    draft: "confirmed text",
    editing: false,
    error: null,
  });
});

test("attachment previews render only gateway-vended blob URLs", () => {
  expect(isRasterImagePreviewMimeType("image/png")).toBeTrue();
  expect(isRasterImagePreviewMimeType("image/gif")).toBeFalse();
  expect(isRasterImagePreviewMimeType("image/jpeg")).toBeFalse();
  expect(isRasterImagePreviewMimeType("image/webp")).toBeFalse();
  expect(isRasterImagePreviewMimeType("image/svg+xml")).toBeFalse();
  expect(safeAttachmentPreviewUrl("blob:https://hra.local/preview-1")).toBe(
    "blob:https://hra.local/preview-1",
  );
  expect(safeAttachmentPreviewUrl("https://example.com/image.png")).toBeNull();
  expect(safeAttachmentPreviewUrl("data:image/png;base64,AAAA")).toBeNull();

  const html = renderToStaticMarkup(createElement(AttachmentPreviewStack, {
    attachments: [{
      id: "attachment_compact01",
      name: "layout.png",
      mimeType: "image/png",
      byteSize: 2_048,
      previewUrl: "blob:https://hra.local/preview-1",
      status: "ready",
    }, {
      id: "attachment_compact02",
      name: "remote.png",
      mimeType: "image/png",
      byteSize: 1,
      previewUrl: "https://example.com/image.png",
      status: "ready",
    }, {
      id: "attachment_compact03",
      name: "vector.svg",
      mimeType: "image/svg+xml",
      byteSize: 2,
      previewUrl: "blob:https://hra.local/vector-1",
      status: "ready",
    }],
    onRemove: () => undefined,
  }));
  expect(html.match(/<img/gu)).toHaveLength(1);
  expect(html).toContain("blob:https://hra.local/preview-1");
  expect(html).not.toContain("https://example.com/image.png");
  expect(html).toContain("Remove layout.png");
});

test("clipboard intake selects image files and ignores text or non-image files", () => {
  const image = new File([new Uint8Array([1, 2, 3])], "paste.png", {
    type: "image/png",
  });
  const text = new File(["notes"], "notes.txt", { type: "text/plain" });
  const images = pastedImagesFromClipboard([{
    kind: "file",
    type: "image/png",
    getAsFile: () => image,
  }, {
    kind: "file",
    type: "text/plain",
    getAsFile: () => text,
  }, {
    kind: "string",
    type: "text/plain",
    getAsFile: () => null,
  }]);
  expect(images).toEqual([{ file: image, type: "image/png" }]);
});

test("composer delivery queues by default and cannot steer past an existing head", () => {
  expect(compactComposerDelivery({ active: false, queueEmpty: true, steerModifier: true }))
    .toBe("queue");
  expect(compactComposerDelivery({ active: true, queueEmpty: true, steerModifier: false }))
    .toBe("queue");
  expect(compactComposerDelivery({ active: true, queueEmpty: true, steerModifier: true }))
    .toBe("steerHead");
  expect(compactComposerDelivery({ active: true, queueEmpty: false, steerModifier: true }))
    .toBe("queue");
});
