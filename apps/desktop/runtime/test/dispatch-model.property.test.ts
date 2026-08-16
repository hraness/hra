import { describe, expect, test } from "bun:test";
import { fc } from "@hra-internal/test";

import {
  canTransitionDispatch,
  dispatchStageSchema,
  publicRunEvent,
  publicRunEventKindSchema,
  stageForPublicEvent,
  terminalDispatchStages,
} from "../src/dispatch/model";

const stageArbitrary = fc.constantFrom(...dispatchStageSchema.options);
const eventKindArbitrary = fc.constantFrom(...publicRunEventKindSchema.options);

describe("dispatch lifecycle laws", () => {
  test("workspace lifecycle copy remains valid for managed and source execution", () => {
    expect(publicRunEvent("worktree.preparing").summary).toBe(
      "Preparing execution workspace",
    );
    expect(publicRunEvent("worktree.ready").summary).toBe(
      "Execution workspace ready",
    );
  });

  test("terminal states reject every later transition", () => {
    fc.assert(fc.property(stageArbitrary, stageArbitrary, (from, to) => {
      if (terminalDispatchStages.has(from)) expect(canTransitionDispatch(from, to)).toBeFalse();
    }));
  });

  test("every public event is closed, bounded, and maps to an owned stage", () => {
    fc.assert(fc.property(eventKindArbitrary, (kind) => {
      const event = publicRunEvent(kind);
      expect(event.kind).toBe(kind);
      expect(event.summary.length).toBeGreaterThan(0);
      expect(event.summary.length).toBeLessThanOrEqual(80);
      expect(event.summary).not.toMatch(/[\\/]|\.{2}|\n|\r|https?:|token|secret/iu);
      expect(stageForPublicEvent(kind)).not.toBeNull();
    }));
  });

  test("unknown event values never parse", () => {
    fc.assert(fc.property(fc.string(), (value) => {
      if (!publicRunEventKindSchema.options.includes(value as never)) {
        expect(publicRunEventKindSchema.safeParse(value).success).toBeFalse();
      }
    }));
  });
});
