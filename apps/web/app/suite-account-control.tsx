"use client";

import {
  type ProductLinkProof,
  type SuiteEntitlementReceipt,
  type SuiteLinkReceipt,
} from "../suite-account-contracts";
import {
  loadSuiteOidcBrowserSession,
} from "../suite-account-browser-session";
import {
  HRA_SITE_URL,
  hraSuiteAccountUrl,
} from "../suite-account-configuration";
import {
  Button,
  LinkButton,
} from "@hra-internal/design-kit/react";
import { makeFunctionReference } from "convex/server";
import { useAction, useQuery } from "convex/react";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

import {
  parseHRASuiteLinkReceipt,
  parseHRASuiteOidcSession,
  type ParsedSuiteOidcSession,
  type SuiteFeature,
} from "./suite-account-protocol";

type LocalLink =
  | Readonly<{ kind: "signed_out" }>
  | Readonly<{ kind: "unlinked" }>
  | Readonly<{
      kind: "linked";
      suiteAccountId: string;
      verification:
        | Readonly<{ kind: "unverified" }>
        | Readonly<{
            expiresAtMs: number;
            features: readonly SuiteFeature[];
            freshness: "fresh" | "stale";
            kind: "verified";
            observedAtMs: number;
            projectionRevision: number;
          }>;
    }>;
type LinkProofResult =
  | Readonly<{ kind: "unauthorized" | "unavailable" }>
  | Readonly<{
      kind: "proof";
      proof: ProductLinkProof;
      proofSignature: string;
    }>;
type OidcSession =
  | ParsedSuiteOidcSession
  | Readonly<{ kind: "loading" | "unavailable" }>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const localCurrent = makeFunctionReference<
  "query",
  Record<string, never>,
  LocalLink
>("suiteIdentityModel:current");
const createLocalLinkProof = makeFunctionReference<
  "action",
  Record<string, never>,
  LinkProofResult
>("suiteIdentity:createLinkProof");
const acceptLocalLinkReceipt = makeFunctionReference<
  "action",
  Readonly<{ receipt: SuiteLinkReceipt }>,
  "conflict" | "expired" | "invalid" | "linked" | "unauthorized" | "unavailable"
>("suiteIdentity:acceptLinkReceipt");
const acceptLocalEntitlementReceipt = makeFunctionReference<
  "action",
  Readonly<{ receipt: SuiteEntitlementReceipt }>,
  "accepted" | "conflict" | "expired" | "invalid" | "unauthorized"
    | "unavailable" | "unlinked"
>("suiteIdentity:acceptEntitlementReceipt");

function remoteEnvironment(): "production" | null {
  return process.env.NEXT_PUBLIC_SITE_URL === HRA_SITE_URL
    ? "production"
    : null;
}

function useOidcSession(): Readonly<{
  reload: () => Promise<void>;
  session: OidcSession;
}> {
  const [session, setSession] = useState<OidcSession>({ kind: "loading" });
  const reload = useCallback(async () => {
    try {
      const parsed = parseHRASuiteOidcSession(
        await loadSuiteOidcBrowserSession(),
      );
      setSession(
        parsed !== null
          && parsed.kind !== "refresh_required"
          ? parsed
          : { kind: "unavailable" },
      );
    } catch {
      setSession({ kind: "unavailable" });
    }
  }, []);
  useEffect(() => {
    const timeout = window.setTimeout(() => void reload(), 0);
    return () => window.clearTimeout(timeout);
  }, [reload]);
  return { reload, session };
}

function planLabel(features: readonly SuiteFeature[]): string {
  if (features.includes("suite.believer")) return "Fan Donation";
  if (features.includes("suite.paid")) return "Friend Donation";
  return "Free";
}

function localStatus(local: LocalLink | undefined): string {
  if (local === undefined) return "Checking…";
  if (local.kind === "signed_out") return "HRA session required";
  if (local.kind === "unlinked") return "Not linked";
  if (local.verification.kind === "unverified") return "Linked · not verified";
  if (local.verification.freshness === "stale") {
    return "Linked · verification stale";
  }
  return `Linked · ${planLabel(local.verification.features)}`;
}

export function SuiteAccountControl() {
  const local = useQuery(localCurrent, {});
  const createProof = useAction(createLocalLinkProof);
  const acceptLinkReceipt = useAction(acceptLocalLinkReceipt);
  const acceptEntitlementReceipt = useAction(acceptLocalEntitlementReceipt);
  const { reload, session } = useOidcSession();
  const handledEntitlement = useRef<string | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const environment = remoteEnvironment();
  const manageUrl = environment === null
    ? null
    : hraSuiteAccountUrl("account");
  const linkedToSession = local?.kind === "linked"
    && session.kind === "signed_in"
    && local.suiteAccountId === session.session.suiteAccountId;

  useEffect(() => {
    const receipt = session.kind === "signed_in"
      ? session.session.entitlementReceipt
      : null;
    if (
      receipt === null
      || local?.kind !== "linked"
      || local.suiteAccountId !== receipt.suiteAccountId
      || handledEntitlement.current === receipt.signature
    ) {
      return;
    }
    handledEntitlement.current = receipt.signature;
    void (async () => {
      const accepted = await acceptEntitlementReceipt({ receipt });
      if (accepted !== "accepted") {
        setError("Plan verification failed. Refresh to try again.");
        return;
      }
      const response = await fetch("/api/suite-auth/entitlements/ack", {
        body: JSON.stringify({ signature: receipt.signature }),
        credentials: "same-origin",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
        },
        method: "POST",
      });
      if (!response.ok) {
        setError("The plan was verified, but its receipt was not acknowledged.");
        return;
      }
      await reload();
    })().catch(() => {
      setError("Plan verification failed. Refresh to try again.");
    });
  }, [acceptEntitlementReceipt, local, reload, session]);

  async function linkAccounts() {
    if (pending || session.kind !== "signed_in") return;
    setPending(true);
    setError(null);
    try {
      const proof = await createProof({});
      if (proof.kind !== "proof") throw new Error(proof.kind);
      const response = await fetch("/api/suite-auth/link-receipt", {
        body: JSON.stringify({
          ...proof.proof,
          proofSignature: proof.proofSignature,
        }),
        credentials: "same-origin",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
        },
        method: "POST",
      });
      const body: unknown = await response.json();
      const receipt = isRecord(body)
        ? parseHRASuiteLinkReceipt(body["receipt"])
        : null;
      if (!response.ok || receipt === null) throw new Error("receipt");
      if (await acceptLinkReceipt({ receipt }) !== "linked") {
        throw new Error("link");
      }
    } catch {
      setError("The accounts could not be linked. Refresh both sessions and retry.");
    } finally {
      setPending(false);
    }
  }

  async function signOutSuiteSession() {
    if (pending) return;
    setPending(true);
    setError(null);
    try {
      const response = await fetch("/api/suite-auth/sign-out", {
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      if (!response.ok) throw new Error("sign-out");
      await reload();
    } catch {
      setError("The Hraness session could not be cleared.");
    } finally {
      setPending(false);
    }
  }

  return (
    <section aria-label="Hraness suite account" className="suite-account-control">
      <div className="suite-account-control__summary">
        <span>Hraness account</span>
        <strong>{localStatus(local)}</strong>
      </div>
      <small>Plan status only. HRA organization and workspace memberships control access.</small>
      {session.kind === "loading" || local === undefined ? (
        <span aria-live="polite" className="suite-account-control__state">
          Checking central session…
        </span>
      ) : session.kind === "unavailable" || environment === null ? (
        <span className="suite-account-control__state">
          Suite sign-in is not configured.
        </span>
      ) : session.kind === "signed_out" ? (
        <LinkButton
          href="/api/suite-auth/start?return_to=/app"
          size="compact"
          variant="secondary"
        >
          Sign in to Hraness
        </LinkButton>
      ) : (
        <>
          {local.kind === "linked" && !linkedToSession ? (
            <span className="suite-account-control__warning" role="status">
              This human is linked to a different Hraness account.
            </span>
          ) : null}
          <div className="suite-account-control__actions">
            {local.kind === "unlinked" ? (
              <Button
                isPending={pending}
                onPress={() => void linkAccounts()}
                size="compact"
                type="button"
                variant="secondary"
              >
                Link account
              </Button>
            ) : null}
            {manageUrl === null ? null : (
              <LinkButton href={manageUrl} size="compact" variant="quiet">
                Manage
              </LinkButton>
            )}
            <Button
              isDisabled={pending}
              onPress={() => void signOutSuiteSession()}
              size="compact"
              type="button"
              variant="quiet"
            >
              Sign out
            </Button>
          </div>
        </>
      )}
      {error === null ? null : (
        <span className="suite-account-control__warning" role="alert">
          {error}
        </span>
      )}
    </section>
  );
}
