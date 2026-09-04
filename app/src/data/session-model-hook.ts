import { useEffect, useMemo, useState } from "react";

import { useCustody } from "../custody/custody-context";
import { decryptSessionMetadata } from "../hra/cloud";
import {
  initialSessionModel,
  sessionModelReducer,
  type SessionModel,
} from "../model/session-model";
import { createCancellation } from "../lib/cancellation";
import { useCompactHistory } from "./compact-history";
import { useLiveTail } from "./live-tail";
import type { SessionHead } from "./wire";

/** The encrypted head metadata, decrypted for the session name. */
export function useSessionName(head: SessionHead | null): string | null {
  const custody = useCustody();
  const unlocked = custody.state === "unlocked" ? custody : null;
  const key = unlocked?.key ?? null;
  const userPublicId = unlocked?.identity.userPublicId ?? null;
  const report = custody.reportAuthorityFailure;
  const [name, setName] = useState<string | null>(null);
  const envelope = head?.metadata ?? null;
  const publicId = head?.publicId ?? null;

  useEffect(() => {
    if (envelope === null || key === null || userPublicId === null || publicId === null) {
      setName(null);
      return;
    }
    const run = createCancellation();
    void decryptSessionMetadata(envelope, key, {
      entityPublicId: publicId,
      keyVersion: envelope.keyVersion,
      kind: "session_metadata",
      userPublicId,
    })
      .then((payload) => { if (run.live()) setName(payload.name); })
      .catch((failure: unknown) => {
        report(failure);
        if (run.live()) setName(null);
      });
    return () => { run.cancel(); };
  }, [envelope, key, publicId, report, userPublicId]);

  return name;
}

export type SessionModelView = Readonly<{
  historyLoading: boolean;
  model: SessionModel;
}>;

/**
 * The rendered session model: the live tail always, the compact history only
 * for the session the reader has open. A card in a long list therefore costs one
 * live subscription rather than a full history walk.
 */
export function useSessionModel(
  head: SessionHead | null,
  options: Readonly<{ includeHistory: boolean }>,
): SessionModelView {
  const publicId = head?.publicId ?? null;
  const history = useCompactHistory(options.includeHistory ? publicId : null);
  const tail = useLiveTail(publicId);
  const name = useSessionName(head);

  const model = useMemo(() => {
    let next = initialSessionModel();
    next = sessionModelReducer(next, { events: history.events, type: "compact" });
    next = sessionModelReducer(next, { events: tail.events, type: "detail" });
    next = sessionModelReducer(next, { name, type: "metadata" });
    return next;
  }, [history.events, name, tail.events]);

  return { historyLoading: history.loading, model };
}
