import { SUITE_CATALOG_REVISION } from "../suite-account-contracts";
import { decideSuiteEntitlementReceiptProjection } from "../suite-account-entitlements";

export const MAX_SUITE_ENTITLEMENT_PROVIDER_AGE_MS = 26 * 60 * 60_000;

export type SuiteFeature = "suite.paid" | "suite.believer";

export type SuiteAliasCandidate<LocalUserId> = Readonly<{
  id: string;
  localSubject: string;
  state: "active" | "revoked";
  suiteAccountId: string;
  userId: LocalUserId;
}>;

export type SuiteAliasTarget<LocalUserId> = Readonly<{
  localSubject: string;
  suiteAccountId: string;
  userId: LocalUserId;
}>;

export type SuiteEntitlementProjection = Readonly<{
  catalogRevision: string;
  expiresAt: number;
  features: readonly SuiteFeature[];
  observedAt: number;
  projectionRevision: number;
  receiptDigest: string;
  receiptIssuedAt?: number;
  suiteAccountId: string;
}>;

export type SuiteEntitlementProjectionUpdate = Readonly<
  Omit<SuiteEntitlementProjection, "receiptIssuedAt"> & {
    receiptIssuedAt: number;
  }
>;

export type SuiteEntitlementProjectionTransition =
  | "conflict"
  | "idempotent"
  | "insert"
  | "replace";

export function suiteAliasesAllowLink<LocalUserId>(
  candidates: readonly (SuiteAliasCandidate<LocalUserId> | null)[],
  target: SuiteAliasTarget<LocalUserId>,
): boolean {
  const existing = candidates.filter(
    (candidate): candidate is SuiteAliasCandidate<LocalUserId> =>
      candidate !== null,
  );
  if (existing.length === 0) return true;
  if (existing.length !== candidates.length) return false;
  const first = existing[0];
  if (first === undefined) return false;
  return existing.every((candidate) =>
    candidate.id === first.id
    && candidate.state === "active"
    && candidate.localSubject === target.localSubject
    && candidate.suiteAccountId === target.suiteAccountId
    && candidate.userId === target.userId
  );
}

export function suiteEntitlementProjectionTransition(
  current: SuiteEntitlementProjection | null,
  incoming: SuiteEntitlementProjectionUpdate,
): SuiteEntitlementProjectionTransition {
  const decision = decideSuiteEntitlementReceiptProjection(
    current === null
      ? null
      : {
          expiresAtMs: current.expiresAt,
          features: current.features,
          observedAtMs: current.observedAt,
          projectionRevision: current.projectionRevision,
          receiptDigest: current.receiptDigest,
          receiptIssuedAtMs: current.receiptIssuedAt ?? 0,
          suiteAccountId: current.suiteAccountId,
        },
    {
      expiresAtMs: incoming.expiresAt,
      features: incoming.features,
      observedAtMs: incoming.observedAt,
      projectionRevision: incoming.projectionRevision,
      receiptDigest: incoming.receiptDigest,
      receiptIssuedAtMs: incoming.receiptIssuedAt,
      suiteAccountId: incoming.suiteAccountId,
    },
  );
  return decision === "replay" ? "idempotent" : decision;
}

export function suiteEntitlementProjectionIsFresh(
  projection: SuiteEntitlementProjection | null,
  suiteAccountId: string,
  nowMs: number,
): boolean {
  return projection !== null
    && projection.catalogRevision === SUITE_CATALOG_REVISION
    && projection.suiteAccountId === suiteAccountId
    && projection.expiresAt > nowMs
    && projection.observedAt <= nowMs
    && nowMs - projection.observedAt <= MAX_SUITE_ENTITLEMENT_PROVIDER_AGE_MS;
}
