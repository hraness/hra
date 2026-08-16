import { expect, test } from "bun:test";
import { assertProperty, fc } from "@hra-internal/test";

import {
  runtimeChatDomainCommandSchema,
  runtimeChatTurnPromptUtf8ByteLimit,
} from "../../../../contracts/runtime";

import {
  normalizePaneTitle,
  paneCanCompose,
  paneCanRename,
  paneActivityAccent,
  paneIdsEqual,
  paneIsActive,
  validatedPrompt,
} from "./model";
import { isNearPaneBottom } from "./ChatPane";

const utf8Encoder = new TextEncoder();
const utf8Decoder = new TextDecoder("utf-8", { fatal: true });

function isValidUnicode(value: string): boolean {
  return utf8Decoder.decode(utf8Encoder.encode(value)) === value;
}

test("pane state permissions are total, disjoint, and recovery-preserving", () => {
  assertProperty(fc.property(
    fc.constantFrom("ready", "starting", "streaming", "continuing", "attention"),
    (state) => {
      expect(paneCanCompose(state)).toBe(state === "ready" || state === "attention");
      expect(paneCanRename(state)).toBe(state === "ready" || state === "attention");
      expect(paneIsActive(state)).toBe(
        state === "starting" || state === "streaming" || state === "continuing",
      );
      expect(paneCanCompose(state) && paneIsActive(state)).toBeFalse();
    },
  ));
});

test("every admitted activity maps to exactly one semantic border accent", () => {
  assertProperty(fc.property(
    fc.constantFrom(
      "idle",
      "messageSent",
      "thinkingCompleted",
      "toolStarted",
      "responseCompleted",
    ),
    (activity) => {
      const accent = paneActivityAccent(activity);
      expect(["neutral", "thinking", "tool", "response"]).toContain(accent);
      expect(accent === "neutral").toBe(
        activity === "idle" || activity === "messageSent",
      );
    },
  ));
});

test("title normalization produces only bounded schema-safe candidates", () => {
  assertProperty(fc.property(fc.string({ maxLength: 400 }), (value) => {
    const title = normalizePaneTitle(value);
    if (title === null) {
      expect(
        value.trim().length === 0 || value.includes("\0") || !isValidUnicode(value),
      ).toBeTrue();
      return;
    }
    expect(title).toBe(title.trim());
    expect(title.length).toBeGreaterThan(0);
    expect(title.length).toBeLessThanOrEqual(160);
    expect(title).not.toContain("\0");
    expect(isValidUnicode(title)).toBeTrue();
    expect(runtimeChatDomainCommandSchema.safeParse({
      type: "chat.pane.rename",
      paneId: "pane_example0001",
      expectedRevision: 1,
      title,
    }).success).toBeTrue();
  }));
});

test("every isolated UTF-16 surrogate is rejected by normalization and the command contract", () => {
  assertProperty(fc.property(
    fc.integer({ min: 0xd800, max: 0xdfff }),
    (codeUnit) => {
      const malformed = `title ${String.fromCharCode(codeUnit)} suffix`;
      expect(normalizePaneTitle(malformed)).toBeNull();
      expect(runtimeChatDomainCommandSchema.safeParse({
        type: "chat.pane.rename",
        paneId: "pane_example0001",
        expectedRevision: 1,
        title: malformed,
      }).success).toBeFalse();
    },
  ));
});

test("prompt validation matches the exact contract UTF-8 boundary", () => {
  assertProperty(fc.property(
    fc.integer({
      min: runtimeChatTurnPromptUtf8ByteLimit - 16,
      max: runtimeChatTurnPromptUtf8ByteLimit + 16,
    }),
    (byteLength) => {
      expect(validatedPrompt("x".repeat(byteLength)).ok).toBe(
        byteLength <= runtimeChatTurnPromptUtf8ByteLimit,
      );
    },
  ));
});

test("pane ID equality ignores no reorder, insertion, removal, or replacement", () => {
  assertProperty(fc.property(
    fc.uniqueArray(fc.stringMatching(/^pane_[a-z0-9]{8,24}$/u), { maxLength: 64 }),
    fc.uniqueArray(fc.stringMatching(/^pane_[a-z0-9]{8,24}$/u), { maxLength: 64 }),
    (left, right) => {
      expect(paneIdsEqual(left, right)).toBe(
        left.length === right.length && left.every((id, index) => id === right[index]),
      );
    },
  ));
});

test("near-bottom autoscroll is monotone as the reader approaches the tail", () => {
  assertProperty(fc.property(
    fc.integer({ min: 1, max: 4_000 }),
    fc.integer({ min: 1, max: 1_000 }),
    fc.integer({ min: 0, max: 4_000 }),
    (scrollHeight, clientHeight, scrollTop) => {
      const boundedTop = Math.min(scrollTop, Math.max(0, scrollHeight - clientHeight));
      const closerTop = Math.min(
        Math.max(0, scrollHeight - clientHeight),
        boundedTop + 100,
      );
      const before = isNearPaneBottom({ scrollHeight, clientHeight, scrollTop: boundedTop });
      const closer = isNearPaneBottom({ scrollHeight, clientHeight, scrollTop: closerTop });
      if (before) expect(closer).toBeTrue();
    },
  ));
});
