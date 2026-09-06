import { describe, expect, test } from "bun:test";

import { sessionTranscriptSchema } from "./transcript";
import { transcriptToTrajectory } from "./trajectory";

describe("trajectory", () => {
  test("preserves peer-session provenance in the user record", () => {
    const transcript = sessionTranscriptSchema.parse({
      version: 1,
      sessionId: `sess_${"a".repeat(32)}`,
      records: [{
        kind: "user",
        actor: "peer_session",
        sequence: 1,
        throughSequence: 1,
        recordedAt: 1_000,
        turnId: "turn-peer",
        text: "Review this invariant.",
        omittedCharacters: 0,
      }],
      throughSequence: 1,
      nextSequence: null,
      omittedRecords: 0,
      omittedCharacters: 0,
      digest: "b".repeat(64),
    });
    expect(transcriptToTrajectory({
      transcript,
      provider: "codex",
      createdAt: 1_000,
    })[1]).toMatchObject({
      type: "user",
      content: "[hra peer session] Review this invariant.",
    });
  });
});
