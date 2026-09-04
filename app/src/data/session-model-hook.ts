import { useMemo } from "react";

import {
  initialSessionModel,
  sessionModelReducer,
  type SessionModel,
} from "../model/session-model";
import { mergeCompactEvents } from "../model/transcript";
import type { CompactSessionEvent } from "../hra/cloud";
import { useCompactHistory } from "./compact-history";
import { useCompactTail } from "./compact-tail";
import { useLiveTail } from "./live-tail";
import { useSessionMetadata, type SessionMetadata } from "./session-metadata";
import type { SessionHead } from "./wire";

/**
 * How much of the compact stream a caller needs.
 *
 * - `none`: the live tail only. Nothing on screen needs a prompt or an
 *   interaction, so nothing is decrypted beyond the current turn.
 * - `tail`: the subscribed last few compact chunks. A grid card learns its last
 *   prompt and its pending interactions at a bounded cost.
 * - `full`: the whole history walk plus the subscribed tail, which is what an
 *   open transcript needs: everything that happened, and everything that
 *   happens while it stays open.
 */
export type SessionHistoryMode = "none" | "tail" | "full";

export type SessionModelView = Readonly<{
  /** The compact events behind `model`, in sequence order, for the transcript. */
  compactEvents: readonly CompactSessionEvent[];
  historyLoading: boolean;
  /**
   * The detail stream folded on its own. `model.streamingText` is whatever the
   * two streams last wrote; this one is only what the live tail has seen, which
   * is how the transcript tells an in-flight turn from a closed one.
   */
  liveModel: SessionModel;
  /** The decrypted head metadata: the name, the note, and the archived flag. */
  metadata: SessionMetadata;
  model: SessionModel;
}>;

/**
 * The rendered session model.
 *
 * The live tail is always subscribed; the compact stream is read at the depth
 * the caller asked for. A card in a long list therefore costs two subscriptions
 * rather than a full history walk per session.
 */
export function useSessionModel(
  head: SessionHead | null,
  options: Readonly<{ history: SessionHistoryMode }>,
): SessionModelView {
  const publicId = head?.publicId ?? null;
  const history = useCompactHistory(options.history === "full" ? publicId : null);
  const compactTail = useCompactTail(options.history === "none" ? null : publicId);
  const tail = useLiveTail(publicId);
  const metadata = useSessionMetadata(head);
  const name = metadata.name;

  const compactEvents = useMemo(
    () => mergeCompactEvents(history.events, compactTail.events),
    [compactTail.events, history.events],
  );

  const liveModel = useMemo(
    () => sessionModelReducer(initialSessionModel(), { events: tail.events, type: "detail" }),
    [tail.events],
  );

  const model = useMemo(() => {
    let next = initialSessionModel();
    next = sessionModelReducer(next, { events: compactEvents, type: "compact" });
    next = sessionModelReducer(next, { events: tail.events, type: "detail" });
    next = sessionModelReducer(next, { name, type: "metadata" });
    return next;
  }, [compactEvents, name, tail.events]);

  return { compactEvents, historyLoading: history.loading, liveModel, metadata, model };
}
