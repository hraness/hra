import { describe, expect, mock, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import type { SessionHead } from "../data/wire";
import { initialSessionModel } from "../model/session-model";

let retired = true;
let submitted = 0;
const head: SessionHead = {
  compactHeadSequence: 0,
  compactStreamEpoch: 1,
  createdAt: 0,
  detailHeadSequence: 0,
  detailStreamEpoch: null,
  executionDevicePublicId: "device_retired01",
  metadata: null,
  metadataRevision: 1,
  projectionRevision: 1,
  publicId: "session_retired01",
  state: "terminal",
  updatedAt: 0,
};

await mock.module("../data/session-heads", () => ({
  useSessionHead: () => head,
}));
await mock.module("../data/session-model-hook", () => ({
  useSessionModel: () => ({
    compactEvents: [],
    historyLoading: false,
    liveModel: initialSessionModel(),
    metadata: {
      archived: false,
      name: "Historical conversation",
      note: null,
      ...(retired ? { retiredProvider: "devin" } : {}),
    },
    model: {
      ...initialSessionModel(),
      title: "Historical conversation",
      turnActive: true,
    },
  }),
}));
await mock.module("../data/commands", () => ({
  useCommandState: () => null,
  useSubmitCommand: () => () => {
    submitted += 1;
    throw new Error("Unexpected provider command");
  },
}));
await mock.module("../components/scheduled-tasks-badge", () => ({
  ScheduledTasksBadge: () => null,
}));

const { SessionScreen } = await import("./session-screen");

describe("retired session screen", () => {
  test("retains the conversation view but disables every visible execution input", () => {
    retired = true;
    const markup = renderToStaticMarkup(<SessionScreen sessionPublicId={head.publicId} />);
    expect(markup).toContain("Historical conversation");
    expect(markup).toContain("Devin support is retired. This session is read-only.");
    for (const label of ["Attach a file", "Message this session", "Stop the turn"]) {
      const element = markup.match(new RegExp('<[^>]+aria-label="' + label + '"[^>]*>'))?.[0];
      expect(element).toBeDefined();
      expect(element).toContain('disabled=""');
    }
    expect(submitted).toBe(0);
  });

  test("does not disable the same controls on a supported session", () => {
    retired = false;
    const markup = renderToStaticMarkup(<SessionScreen sessionPublicId={head.publicId} />);
    expect(markup).not.toContain("Devin support is retired");
    for (const label of ["Attach a file", "Message this session", "Stop the turn"]) {
      const element = markup.match(new RegExp('<[^>]+aria-label="' + label + '"[^>]*>'))?.[0];
      expect(element).toBeDefined();
      expect(element).not.toContain('disabled=""');
    }
    expect(submitted).toBe(0);
  });
});
