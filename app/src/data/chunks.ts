/**
 * Chunk authority reconstruction.
 *
 * A session chunk is only decryptable under the exact additional authenticated
 * data the writer used, so every field of `sessionChunkAad` has to be rebuilt
 * from the row and the reader's own identity. Nothing here touches React.
 */
import { sessionChunkAad, type SessionChunkAuthority, type SyncStream } from "../hra/cloud";
import type { SessionChunk } from "./wire";

export function chunkAuthority(input: Readonly<{
  chunk: SessionChunk;
  sessionPublicId: string;
  userPublicId: string;
}>): SessionChunkAuthority {
  const { chunk } = input;
  return {
    firstSequence: chunk.firstSequence,
    keyVersion: chunk.envelope.keyVersion,
    lastSequence: chunk.lastSequence,
    ...(chunk.previousDigest === null ? {} : { previousDigest: chunk.previousDigest }),
    sessionPublicId: input.sessionPublicId,
    sourceBootId: chunk.authority.bootId,
    sourceDevicePublicId: chunk.sourceDevicePublicId,
    sourceFence: chunk.authority.fence,
    stream: chunk.stream,
    userPublicId: input.userPublicId,
  };
}

/** Proves the reconstruction is well formed before a decrypt is attempted. */
export function chunkAad(input: Parameters<typeof chunkAuthority>[0]): Uint8Array {
  return sessionChunkAad(chunkAuthority(input));
}

export function chunksForStream(
  chunks: readonly SessionChunk[],
  stream: SyncStream,
  streamEpoch: number | null,
): readonly SessionChunk[] {
  return chunks.filter((chunk) =>
    chunk.stream === stream && (streamEpoch === null || chunk.streamEpoch === streamEpoch));
}
