import { liveTailChunkLimit } from "../env";
import { decryptDetailEvents, type DetailSessionEvent } from "../hra/cloud";
import { useStreamTail, type StreamTail } from "./stream-tail";

export type LiveTail = StreamTail<DetailSessionEvent>;

/**
 * The live tail on the `detail` stream: `turn_started`, coalesced assistant and
 * reasoning-summary deltas, subagent activity, and the revisioned session state.
 */
export function useLiveTail(sessionPublicId: string | null): LiveTail {
  return useStreamTail<DetailSessionEvent>({
    decrypt: decryptDetailEvents,
    limit: liveTailChunkLimit,
    sessionPublicId,
    stream: "detail",
  });
}
