import { useQuery } from "convex/react";
import { useEffect, useRef, useState } from "react";

import { useCustody } from "../custody/custody-context";
import { liveTailChunkLimit } from "../env";
import { decryptDetailEvents, type DetailSessionEvent } from "../hra/cloud";
import { createCancellation } from "../lib/cancellation";
import { chunkAuthority, chunksForStream } from "./chunks";
import { getHead, getLatestChunks } from "./functions";
import { parseSessionChunks, parseSessionHead, type SessionHead } from "./wire";

export type LiveTail = Readonly<{
  epoch: number | null;
  events: readonly DetailSessionEvent[];
  head: SessionHead | null;
}>;

/**
 * The live tail on the `detail` stream.
 *
 * `sessions:getLatestChunks` is subscribed, so the daemon's one-second live
 * loop reaches the browser without polling. Correctness rests on three rules:
 *
 * 1. The tail is keyed by `detailStreamEpoch` from `sessions:getHead`. The
 *    retention sweeper prunes detail chunks below the digest chain tail and
 *    bumps that epoch, so an epoch change means the old sequence numbers are no
 *    longer comparable and the accumulated tail is dropped.
 * 2. Rows from a different epoch than the head's are ignored rather than mixed.
 * 3. Events are de-duplicated by sequence, because a subscribed page re-delivers
 *    rows that were already folded in.
 */
export function useLiveTail(sessionPublicId: string | null): LiveTail {
  const custody = useCustody();
  const unlocked = custody.state === "unlocked" ? custody : null;
  const key = unlocked?.key ?? null;
  const userPublicId = unlocked?.identity.userPublicId ?? null;
  const report = custody.reportAuthorityFailure;

  const headValue = useQuery(
    getHead,
    sessionPublicId === null ? "skip" : { publicId: sessionPublicId },
  );
  const chunkValue = useQuery(
    getLatestChunks,
    sessionPublicId === null
      ? "skip"
      : { limit: liveTailChunkLimit, sessionPublicId, stream: "detail" as const },
  );

  const head = headValue === undefined ? null : parseSessionHead(headValue);
  const epoch = head?.detailStreamEpoch ?? null;

  const folded = useRef(new Map<number, DetailSessionEvent>());
  const seenDigests = useRef(new Set<string>());
  const currentEpoch = useRef<number | null>(null);
  const currentSession = useRef<string | null>(null);
  const [events, setEvents] = useState<readonly DetailSessionEvent[]>([]);

  useEffect(() => {
    if (sessionPublicId === null || key === null || userPublicId === null) {
      folded.current = new Map();
      seenDigests.current = new Set();
      currentEpoch.current = null;
      currentSession.current = null;
      setEvents([]);
      return;
    }
    if (currentSession.current !== sessionPublicId || currentEpoch.current !== epoch) {
      folded.current = new Map();
      seenDigests.current = new Set();
      currentSession.current = sessionPublicId;
      currentEpoch.current = epoch;
      setEvents([]);
    }
    if (chunkValue === undefined) return;
    const run = createCancellation();
    void (async () => {
      try {
        const chunks = chunksForStream(parseSessionChunks(chunkValue), "detail", epoch);
        let changed = false;
        for (const chunk of chunks) {
          if (seenDigests.current.has(chunk.digest)) continue;
          const batch = await decryptDetailEvents(
            chunk.envelope,
            key,
            chunkAuthority({ chunk, sessionPublicId, userPublicId }),
          );
          if (!run.live()) return;
          seenDigests.current.add(chunk.digest);
          for (const event of batch) {
            if (folded.current.has(event.sequence)) continue;
            folded.current.set(event.sequence, event);
            changed = true;
          }
        }
        if (!changed || !run.live()) return;
        setEvents([...folded.current.entries()]
          .sort((left, right) => left[0] - right[0])
          .map(([, event]) => event));
      } catch (failure: unknown) {
        report(failure);
      }
    })();
    return () => { run.cancel(); };
  }, [chunkValue, epoch, key, report, sessionPublicId, userPublicId]);

  return { epoch, events, head };
}
