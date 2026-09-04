import { compactTailChunkLimit } from "../env";
import { decryptCompactEvents, type CompactSessionEvent } from "../hra/cloud";
import { useStreamTail, type StreamTail } from "./stream-tail";

export type CompactTail = StreamTail<CompactSessionEvent>;

/**
 * The subscribed tail of the `compact` stream.
 *
 * `useCompactHistory` walks the whole stream once and never updates again, which
 * is the right shape for an opened transcript but wrong for two things a grid
 * card needs live: the last prompt, and the pending interactions that decide
 * whether the card is asking for a human. This hook covers both at a bounded
 * cost, so a card subscribes to the last few chunks instead of decrypting a
 * session's entire history to draw one line of text.
 */
export function useCompactTail(sessionPublicId: string | null): CompactTail {
  return useStreamTail<CompactSessionEvent>({
    decrypt: decryptCompactEvents,
    limit: compactTailChunkLimit,
    sessionPublicId,
    stream: "compact",
  });
}
