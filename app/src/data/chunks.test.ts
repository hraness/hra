import { describe, expect, test } from "bun:test";

import {
  encryptCompactEvents,
  encryptDetailEvents,
} from "../../../src/cloud/projection";
import {
  decryptCompactEvents,
  decryptDetailEvents,
  randomKeyBytes,
  type CompactSessionEvent,
  type DetailSessionEvent,
  type SessionChunkAuthority,
} from "../hra/cloud";
import { chunkAad, chunkAuthority, chunksForStream } from "./chunks";
import { parseSessionChunk, type SessionChunk } from "./wire";

const sessionPublicId = "session_0123456789abcdef";
const userPublicId = "user_0123456789abcdef";
const sourceDevicePublicId = "device_0123456789abcdef";
const bootId = "boot_0123456789abcdef";
const turnId = "turn_0123456789abcdef";
const digest = "a".repeat(64);
const previousDigest = "b".repeat(64);

/**
 * The exact row shape `sessions:getChunks` returns. The reader has to rebuild
 * the writer's additional authenticated data from these fields alone, so this
 * round trip is the real contract test for `chunkAuthority`.
 */
function chunkRow(input: Readonly<{
  envelope: unknown;
  firstSequence: number;
  lastSequence: number;
  stream: "compact" | "detail";
  withPrevious: boolean;
}>): unknown {
  return {
    authority: { bootGeneration: 1, bootId, fence: 4 },
    createdAt: 1_700_000_000_000,
    digest,
    envelope: input.envelope,
    firstSequence: input.firstSequence,
    lastSequence: input.lastSequence,
    ...(input.withPrevious ? { previousDigest } : {}),
    sourceDevicePublicId,
    stream: input.stream,
    streamEpoch: 0,
  };
}

function writerAuthority(input: Readonly<{
  firstSequence: number;
  lastSequence: number;
  stream: "compact" | "detail";
  withPrevious: boolean;
}>): SessionChunkAuthority {
  return {
    firstSequence: input.firstSequence,
    keyVersion: 1,
    lastSequence: input.lastSequence,
    ...(input.withPrevious ? { previousDigest } : {}),
    sessionPublicId,
    sourceBootId: bootId,
    sourceDevicePublicId,
    sourceFence: 4,
    stream: input.stream,
    userPublicId,
  };
}

describe("chunkAuthority", () => {
  test("round trips a compact chunk written by the daemon", async () => {
    const key = randomKeyBytes();
    const events: readonly CompactSessionEvent[] = [
      { kind: "user_message", sequence: 1, text: "hello", turnId },
      { kind: "assistant_message", sequence: 2, text: "hi", turnId },
    ];
    const envelope = await encryptCompactEvents(
      events,
      key,
      writerAuthority({ firstSequence: 1, lastSequence: 2, stream: "compact", withPrevious: false }),
    );
    const chunk = parseSessionChunk(chunkRow({
      envelope,
      firstSequence: 1,
      lastSequence: 2,
      stream: "compact",
      withPrevious: false,
    }));
    expect(chunk).not.toBeNull();
    const decoded = await decryptCompactEvents(
      (chunk as SessionChunk).envelope,
      key,
      chunkAuthority({ chunk: chunk as SessionChunk, sessionPublicId, userPublicId }),
    );
    expect(decoded).toEqual(events);
  });

  test("round trips a chained detail chunk", async () => {
    const key = randomKeyBytes();
    const events: readonly DetailSessionEvent[] = [
      { at: 1_000, sequence: 7, turnId, type: "turn_started" },
      { sequence: 8, text: "streaming", turnId, type: "assistant_delta" },
    ];
    const envelope = await encryptDetailEvents(
      events,
      key,
      writerAuthority({ firstSequence: 7, lastSequence: 8, stream: "detail", withPrevious: true }),
    );
    const chunk = parseSessionChunk(chunkRow({
      envelope,
      firstSequence: 7,
      lastSequence: 8,
      stream: "detail",
      withPrevious: true,
    }));
    expect(chunk).not.toBeNull();
    const decoded = await decryptDetailEvents(
      (chunk as SessionChunk).envelope,
      key,
      chunkAuthority({ chunk: chunk as SessionChunk, sessionPublicId, userPublicId }),
    );
    expect(decoded).toEqual(events);
  });

  test("a chunk read under another session's identity does not decrypt", async () => {
    const key = randomKeyBytes();
    const envelope = await encryptDetailEvents(
      [{ at: 1_000, sequence: 1, turnId, type: "turn_started" }],
      key,
      writerAuthority({ firstSequence: 1, lastSequence: 1, stream: "detail", withPrevious: false }),
    );
    const chunk = parseSessionChunk(chunkRow({
      envelope,
      firstSequence: 1,
      lastSequence: 1,
      stream: "detail",
      withPrevious: false,
    }));
    await expect(decryptDetailEvents(
      (chunk as SessionChunk).envelope,
      key,
      chunkAuthority({
        chunk: chunk as SessionChunk,
        sessionPublicId: "session_ffffffffffffffff",
        userPublicId,
      }),
    )).rejects.toThrow();
  });

  test("omits previousDigest for a root chunk rather than sending null", () => {
    const chunk = parseSessionChunk(chunkRow({
      envelope: {
        algorithm: "A256GCM",
        ciphertext: "A".repeat(32),
        keyVersion: 1,
        nonce: "B".repeat(16),
      },
      firstSequence: 1,
      lastSequence: 1,
      stream: "compact",
      withPrevious: false,
    }));
    const authority = chunkAuthority({
      chunk: chunk as SessionChunk,
      sessionPublicId,
      userPublicId,
    });
    expect(Object.hasOwn(authority, "previousDigest")).toBe(false);
    expect(new TextDecoder().decode(chunkAad({
      chunk: chunk as SessionChunk,
      sessionPublicId,
      userPublicId,
    }))).toContain("\nroot\n");
  });
});

describe("chunksForStream", () => {
  const rows = [
    parseSessionChunk(chunkRow({
      envelope: {
        algorithm: "A256GCM",
        ciphertext: "A".repeat(32),
        keyVersion: 1,
        nonce: "B".repeat(16),
      },
      firstSequence: 1,
      lastSequence: 1,
      stream: "detail",
      withPrevious: false,
    })) as SessionChunk,
    {
      ...(parseSessionChunk(chunkRow({
        envelope: {
          algorithm: "A256GCM",
          ciphertext: "A".repeat(32),
          keyVersion: 1,
          nonce: "B".repeat(16),
        },
        firstSequence: 2,
        lastSequence: 2,
        stream: "detail",
        withPrevious: false,
      })) as SessionChunk),
      streamEpoch: 1,
    },
  ];

  test("keeps only rows from the head's current epoch", () => {
    expect(chunksForStream(rows, "detail", 0)).toHaveLength(1);
    expect(chunksForStream(rows, "detail", 1)).toHaveLength(1);
    expect(chunksForStream(rows, "compact", 0)).toHaveLength(0);
  });

  test("keeps every row when the head has no epoch yet", () => {
    expect(chunksForStream(rows, "detail", null)).toHaveLength(2);
  });
});
