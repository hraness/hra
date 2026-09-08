import { useConvex } from "convex/react";
import { useEffect, useRef, useState } from "react";
import type { FunctionReference } from "convex/server";

import { useCustody } from "../custody/custody-context";
import {
  acknowledgeObservedCommandReceipt,
  parseCommandReceiptProofPage,
  type CommandReceiptProof,
} from "./command-receipts";
import {
  acknowledgeCommandReceipt,
  acknowledgeDeviceCommandReceipt,
  commandListUnacknowledged,
  deviceCommandListUnacknowledged,
  type WireCommandReceiptProofArgs,
} from "./functions";
import { WireShapeError } from "./wire";

const recoveryPageSize = 100;
const recoveryRetryInitialMs = 1_000;
const recoveryRetryMaximumMs = 30_000;

type ReceiptMutation = FunctionReference<
  "mutation",
  "public",
  WireCommandReceiptProofArgs,
  unknown
>;
type ReceiptQuery = FunctionReference<
  "query",
  "public",
  Readonly<{ limit: number }>,
  unknown
>;

function requireProofPage(value: unknown, family: "session" | "device") {
  const proofs = parseCommandReceiptProofPage(value);
  if (proofs === null) throw new WireShapeError(`${family} command receipt recovery page`);
  return proofs;
}

/**
 * Query imperatively so a current app can overlap the predecessor deployment.
 * A reactive `useQuery` throws a missing-function response into the routed
 * screen error boundary. This bounded poll instead leaves the app usable,
 * backs off while the additive surface is absent, and begins draining as soon
 * as the candidate deployment makes it available.
 */
function useRecoveryProofPage(
  query: ReceiptQuery,
  family: "session" | "device",
): readonly CommandReceiptProof[] | null {
  const convex = useConvex();
  const custody = useCustody();
  const report = custody.reportAuthorityFailure;
  const [proofs, setProofs] = useState<readonly CommandReceiptProof[] | null>(null);

  useEffect(() => {
    let active = true;
    let delay = recoveryRetryInitialMs;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const schedule = (nextDelay: number) => {
      if (!active) return;
      timer = setTimeout(() => { void poll(); }, nextDelay);
    };
    const poll = async (): Promise<void> => {
      try {
        const next = requireProofPage(
          await convex.query(query, { limit: recoveryPageSize }),
          family,
        );
        if (!active) return;
        setProofs(next);
        delay = recoveryRetryInitialMs;
        schedule(next.length === 0 ? recoveryRetryMaximumMs : recoveryRetryInitialMs);
      } catch (failure: unknown) {
        if (!active) return;
        setProofs(null);
        report(failure);
        const nextDelay = delay;
        delay = Math.min(delay * 2, recoveryRetryMaximumMs);
        schedule(nextDelay);
      }
    };
    void poll();
    return () => {
      active = false;
      if (timer !== null) clearTimeout(timer);
    };
  }, [convex, family, query, report]);

  return proofs;
}

function useAcknowledgeObservedReceipts(
  proofs: readonly CommandReceiptProof[] | null,
  mutation: ReceiptMutation,
): void {
  const convex = useConvex();
  const custody = useCustody();
  const report = custody.reportAuthorityFailure;
  const inFlight = useRef<string | null>(null);
  const acknowledged = useRef(new Set<string>());
  const mounted = useRef(true);
  const pageKey = proofs === null
    ? null
    : proofs.map((proof) => [
        proof.publicId,
        proof.idempotencyKey,
        proof.requestDigest,
      ].join(":"))
      .join("|");
  const priorPageKey = useRef<string | null>(pageKey);
  const retryDelay = useRef(recoveryRetryInitialMs);
  const retryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [completed, setCompleted] = useState(0);

  useEffect(() => {
    // React StrictMode replays effect setup after its development-only cleanup.
    // Restore the liveness marker so the completion-generation fallback keeps
    // draining a static page after that replay.
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (retryTimer.current !== null) clearTimeout(retryTimer.current);
      retryTimer.current = null;
    };
  }, []);

  useEffect(() => {
    if (priorPageKey.current !== pageKey) {
      priorPageKey.current = pageKey;
      retryDelay.current = recoveryRetryInitialMs;
      if (retryTimer.current !== null) clearTimeout(retryTimer.current);
      retryTimer.current = null;
    }
    const visible = new Set(proofs?.map((proof) => proof.publicId) ?? []);
    for (const publicId of acknowledged.current) {
      if (!visible.has(publicId)) acknowledged.current.delete(publicId);
    }
    const proof = proofs?.find((candidate) => !acknowledged.current.has(candidate.publicId));
    if (
      proof === undefined
      || inFlight.current !== null
      || retryTimer.current !== null
    ) return;
    inFlight.current = proof.publicId;
    void acknowledgeObservedCommandReceipt(
      proof,
      async (args) => await convex.mutation(mutation, args),
    ).then(() => {
      if (inFlight.current === proof.publicId) inFlight.current = null;
      acknowledged.current.add(proof.publicId);
      retryDelay.current = recoveryRetryInitialMs;
      // The indexed subscription normally advances first. This generation also
      // handles the opposite ordering, so a newly exposed row cannot be left
      // waiting merely because its predecessor completed after the rerender.
      if (mounted.current) setCompleted((value) => value + 1);
    }).catch((failure: unknown) => {
      if (inFlight.current === proof.publicId) inFlight.current = null;
      if (mounted.current && retryTimer.current === null) {
        const delay = retryDelay.current;
        retryDelay.current = Math.min(delay * 2, recoveryRetryMaximumMs);
        retryTimer.current = setTimeout(() => {
          retryTimer.current = null;
          if (mounted.current) setCompleted((value) => value + 1);
        }, delay);
      }
      report(failure);
    });
  }, [completed, convex, mutation, pageKey, proofs, report]);
}

/**
 * Reconciles receipts that committed before a tab closed or lost its enqueue
 * response. The two requester-only reads are inert; only an exact proof tuple
 * observed from one of them is sent to the corresponding acknowledgement
 * mutation. Successful acknowledgement removes the row from the indexed
 * query, which advances the next bounded page without browser persistence.
 */
export function CommandReceiptRecovery() {
  const sessionProofs = useRecoveryProofPage(commandListUnacknowledged, "session");
  const deviceProofs = useRecoveryProofPage(deviceCommandListUnacknowledged, "device");

  useAcknowledgeObservedReceipts(sessionProofs, acknowledgeCommandReceipt);
  useAcknowledgeObservedReceipts(deviceProofs, acknowledgeDeviceCommandReceipt);
  return null;
}
