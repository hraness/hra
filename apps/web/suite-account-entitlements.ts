import {
  parseCurrentSuiteFeatureId,
  parseSuiteJwtClaims,
  SUITE_CATALOG_REVISION,
  type HraSuiteFeature,
  type SuiteJwtClaims,
} from "./suite-account-contracts";

export const SUITE_ENTITLEMENTS_CLAIM_VERSION =
  "suite-entitlements-v1" as const;
/** Slightly exceeds the canonical 24-hour live Stripe refresh cadence. */
export const SUITE_ENTITLEMENT_MAX_PROVIDER_AGE_MS = 26 * 60 * 60_000;

export type SuiteEntitlementsClaim = Readonly<{
  catalogRevision: typeof SUITE_CATALOG_REVISION;
  expiresAtMs: number;
  features: readonly HraSuiteFeature[];
  observedAtMs: number;
  projectionRevision: number;
  version: typeof SUITE_ENTITLEMENTS_CLAIM_VERSION;
}>;

export type VerifiedSuiteEntitlements =
  | Readonly<{
      claim: null;
      features: readonly [];
      kind: "legacy";
    }>
  | Readonly<{
      claim: SuiteEntitlementsClaim;
      features: readonly HraSuiteFeature[];
      kind: "fresh";
    }>
  | Readonly<{
      claim: SuiteEntitlementsClaim;
      features: readonly [];
      kind: "stale";
    }>;

export type SuiteEntitlementTokenResult =
  | Readonly<{
      claims: SuiteJwtClaims;
      entitlements: VerifiedSuiteEntitlements;
      kind: "verified";
    }>
  | Readonly<{
      kind: "invalid";
      reason:
        | "claims"
        | "entitlements"
        | "issuer"
        | "audience"
        | "signature"
        | "time";
    }>;

export type SuiteJwtCryptographicVerifier =
  (compactToken: string) => Promise<unknown>;

export type SuiteEntitlementReceiptProjection = Readonly<{
  expiresAtMs: number;
  features: readonly HraSuiteFeature[];
  observedAtMs: number;
  projectionRevision: number;
  receiptDigest?: string;
  receiptIssuedAtMs: number;
  suiteAccountId: string;
}>;

export type SuiteEntitlementReceiptProjectionDecision =
  | "conflict"
  | "insert"
  | "replace"
  | "replay";

export type VerifySuiteEntitlementTokenOptions = Readonly<{
  clockSkewMs?: number;
  expectedAudience: string;
  expectedIssuer: string;
  maxProjectionAgeMs?: number;
  maxTokenLifetimeMs?: number;
  nowMs?: number;
  verify: SuiteJwtCryptographicVerifier;
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && typeof value === "number" && value >= 0;
}

function canonicalFeatures(
  features: readonly HraSuiteFeature[],
): boolean {
  return features.length === 0
    || (
      features.length === 1
      && features[0] === "suite.paid"
    )
    || (
      features.length === 2
      && features[0] === "suite.paid"
      && features[1] === "suite.believer"
    );
}

function validReceiptProjection(
  projection: SuiteEntitlementReceiptProjection,
): boolean {
  return projection.suiteAccountId.length >= 1
    && projection.suiteAccountId.length <= 128
    && canonicalFeatures(projection.features)
    && nonNegativeInteger(projection.observedAtMs)
    && nonNegativeInteger(projection.expiresAtMs)
    && projection.expiresAtMs > projection.observedAtMs
    && nonNegativeInteger(projection.projectionRevision)
    && nonNegativeInteger(projection.receiptIssuedAtMs)
    && projection.receiptIssuedAtMs < projection.expiresAtMs
    && (
      projection.receiptDigest === undefined
      || /^[a-f0-9]{64}$/u.test(projection.receiptDigest)
    );
}

function sameFeatures(
  left: readonly HraSuiteFeature[],
  right: readonly HraSuiteFeature[],
): boolean {
  return left.length === right.length
    && left.every((feature, index) => feature === right[index]);
}

/**
 * Orders signed entitlement receipts independently from the Stripe snapshot.
 *
 * A token refresh may reissue the same provider projection with a later
 * token-bound expiry, or may turn an aged grant into an empty claim without a
 * new Stripe event. The outer signed receipt issuance is therefore the
 * secondary clock for one projection revision.
 */
export function decideSuiteEntitlementReceiptProjection(
  current: SuiteEntitlementReceiptProjection | null,
  incoming: SuiteEntitlementReceiptProjection,
): SuiteEntitlementReceiptProjectionDecision {
  if (!validReceiptProjection(incoming)) return "conflict";
  if (current === null) return "insert";
  if (
    !validReceiptProjection(current)
    || current.suiteAccountId !== incoming.suiteAccountId
    || incoming.projectionRevision < current.projectionRevision
    || incoming.observedAtMs < current.observedAtMs
    || incoming.receiptIssuedAtMs < current.receiptIssuedAtMs
  ) {
    return "conflict";
  }
  if (
    incoming.projectionRevision > current.projectionRevision
    || incoming.receiptIssuedAtMs > current.receiptIssuedAtMs
  ) {
    return "replace";
  }
  return (
      incoming.expiresAtMs === current.expiresAtMs
      && incoming.observedAtMs === current.observedAtMs
      && sameFeatures(incoming.features, current.features)
      && incoming.receiptDigest === current.receiptDigest
    )
    ? "replay"
    : "conflict";
}

function parseEntitlements(
  value: unknown,
): SuiteEntitlementsClaim | null {
  if (!isRecord(value)) return null;
  if (
    value["version"] !== SUITE_ENTITLEMENTS_CLAIM_VERSION
    || value["catalogRevision"] !== SUITE_CATALOG_REVISION
    || !nonNegativeInteger(value["observedAtMs"])
    || !nonNegativeInteger(value["expiresAtMs"])
    || !nonNegativeInteger(value["projectionRevision"])
    || !Array.isArray(value["features"])
    || value["features"].length > 16
  ) {
    return null;
  }
  const features: HraSuiteFeature[] = [];
  for (const valueFeature of value["features"]) {
    const feature = parseCurrentSuiteFeatureId(valueFeature);
    if (!feature.ok || features.includes(feature.value)) return null;
    features.push(feature.value);
  }
  if (value["expiresAtMs"] <= value["observedAtMs"]) return null;
  return {
    catalogRevision: SUITE_CATALOG_REVISION,
    expiresAtMs: value["expiresAtMs"],
    features,
    observedAtMs: value["observedAtMs"],
    projectionRevision: value["projectionRevision"],
    version: SUITE_ENTITLEMENTS_CLAIM_VERSION,
  };
}

function validExpectedString(value: string): boolean {
  let hasControl = false;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 31 || code === 127) {
      hasControl = true;
      break;
    }
  }
  return value.length >= 1
    && value.length <= 2_048
    && value.trim() === value
    && !hasControl;
}

export async function verifySuiteEntitlementToken(
  compactToken: string,
  options: VerifySuiteEntitlementTokenOptions,
): Promise<SuiteEntitlementTokenResult> {
  if (
    compactToken.length < 1
    || compactToken.length > 16_384
    || !validExpectedString(options.expectedAudience)
    || !validExpectedString(options.expectedIssuer)
  ) {
    return { kind: "invalid", reason: "claims" };
  }
  let payload: unknown;
  try {
    payload = await options.verify(compactToken);
  } catch {
    return { kind: "invalid", reason: "signature" };
  }
  const parsed = parseSuiteJwtClaims(payload);
  if (!parsed.ok) return { kind: "invalid", reason: "claims" };
  const claims = parsed.value;
  if (claims.principal.issuer !== options.expectedIssuer) {
    return { kind: "invalid", reason: "issuer" };
  }
  if (!claims.audience.includes(options.expectedAudience)) {
    return { kind: "invalid", reason: "audience" };
  }

  const nowMs = options.nowMs ?? Date.now();
  const clockSkewMs = options.clockSkewMs ?? 30_000;
  const maxTokenLifetimeMs = options.maxTokenLifetimeMs ?? 20 * 60_000;
  const maxProjectionAgeMs =
    options.maxProjectionAgeMs ?? SUITE_ENTITLEMENT_MAX_PROVIDER_AGE_MS;
  if (
    !nonNegativeInteger(nowMs)
    || !nonNegativeInteger(clockSkewMs)
    || !nonNegativeInteger(maxTokenLifetimeMs)
    || !nonNegativeInteger(maxProjectionAgeMs)
  ) {
    return { kind: "invalid", reason: "time" };
  }
  const issuedAtMs = claims.issuedAtSeconds * 1_000;
  const expiresAtMs = claims.expiresAtSeconds * 1_000;
  const notBeforeMs = claims.notBeforeSeconds === undefined
    ? issuedAtMs
    : claims.notBeforeSeconds * 1_000;
  if (
    expiresAtMs - issuedAtMs > maxTokenLifetimeMs
    || issuedAtMs > nowMs + clockSkewMs
    || notBeforeMs > nowMs + clockSkewMs
    || expiresAtMs <= nowMs - clockSkewMs
  ) {
    return { kind: "invalid", reason: "time" };
  }
  if (!isRecord(payload)) return { kind: "invalid", reason: "claims" };
  const rawEntitlements = payload["suite_entitlements"];
  if (rawEntitlements === undefined) {
    return {
      claims,
      entitlements: { claim: null, features: [], kind: "legacy" },
      kind: "verified",
    };
  }
  const claim = parseEntitlements(rawEntitlements);
  if (claim === null || claim.expiresAtMs > expiresAtMs) {
    return { kind: "invalid", reason: "entitlements" };
  }
  const fresh = (
    claim.observedAtMs <= nowMs + clockSkewMs
    && claim.expiresAtMs > nowMs - clockSkewMs
    && nowMs - claim.observedAtMs <= maxProjectionAgeMs
  );
  return {
    claims,
    entitlements: fresh
      ? { claim, features: claim.features, kind: "fresh" }
      : { claim, features: [], kind: "stale" },
    kind: "verified",
  };
}

export function suiteTokenGrantsFeature(
  result: SuiteEntitlementTokenResult,
  feature: HraSuiteFeature,
): boolean {
  return result.kind === "verified"
    && result.entitlements.kind === "fresh"
    && result.entitlements.features.includes(feature);
}
