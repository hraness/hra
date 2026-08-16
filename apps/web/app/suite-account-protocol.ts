import {
  parseSuiteAccountId,
  SUITE_CATALOG_REVISION,
  validateSuiteEntitlementReceipt,
  validateSuiteLinkReceipt,
  type SuiteEntitlementReceipt,
  type SuiteLinkReceipt,
} from "../suite-account-contracts";

export type SuiteFeature = "suite.paid" | "suite.believer";

export type ParsedSuiteOidcSession =
  | Readonly<{ kind: "refresh_required" | "signed_out" }>
  | Readonly<{
      kind: "signed_in";
      session: Readonly<{
        entitlementReceipt: SuiteEntitlementReceipt | null;
        entitlements: Readonly<{
          features: readonly SuiteFeature[];
          kind: "fresh" | "legacy" | "stale";
        }>;
        suiteAccountId: string;
      }>;
    }>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function environment(
  value: unknown,
): "development" | "production" | null {
  if (value === "development" || value === "production") {
    return value;
  }
  return null;
}

function hraReceiptProduct(
  value: unknown,
): "hra" | "oprte" | "kitchen" | null {
  // Accounts issues only `hra`. Preserve the received legacy value here so
  // an already-signed, still-live pre-rename receipt verifies over exact bytes.
  return value === "hra" || value === "oprte" || value === "kitchen"
    ? value
    : null;
}

function suiteFeatures(value: unknown): readonly SuiteFeature[] | null {
  if (!Array.isArray(value) || value.length > 2) return null;
  const features: SuiteFeature[] = [];
  for (const feature of value) {
    if (feature !== "suite.paid" && feature !== "suite.believer") return null;
    features.push(feature);
  }
  if (
    features.length === 1
    && features[0] !== "suite.paid"
  ) {
    return null;
  }
  if (
    features.length === 2
    && (features[0] !== "suite.paid" || features[1] !== "suite.believer")
  ) {
    return null;
  }
  return features;
}

function sameFeatures(
  left: readonly SuiteFeature[],
  right: readonly SuiteFeature[],
): boolean {
  return left.length === right.length
    && left.every((feature, index) => feature === right[index]);
}

export function parseHRASuiteLinkReceipt(
  value: unknown,
  nowMs: number = Date.now(),
): SuiteLinkReceipt | null {
  const product = isRecord(value)
    ? hraReceiptProduct(value["product"])
    : null;
  if (
    !isRecord(value)
    || value["version"] !== "suite-link-receipt-v1"
    || product === null
    || typeof value["localSubject"] !== "string"
    || typeof value["suiteAccountId"] !== "string"
    || typeof value["challengeId"] !== "string"
    || typeof value["issuedAtMs"] !== "number"
    || typeof value["expiresAtMs"] !== "number"
    || typeof value["keyVersion"] !== "string"
    || typeof value["signature"] !== "string"
  ) {
    return null;
  }
  const parsedEnvironment = environment(value["environment"]);
  const parsedAccountId = parseSuiteAccountId(value["suiteAccountId"]);
  if (parsedEnvironment === null || !parsedAccountId.ok) return null;
  const receipt: SuiteLinkReceipt = {
    challengeId: value["challengeId"],
    environment: parsedEnvironment,
    expiresAtMs: value["expiresAtMs"],
    issuedAtMs: value["issuedAtMs"],
    keyVersion: value["keyVersion"],
    localSubject: value["localSubject"],
    product,
    signature: value["signature"],
    suiteAccountId: parsedAccountId.value,
    version: "suite-link-receipt-v1",
  };
  return validateSuiteLinkReceipt(receipt, nowMs) === null ? receipt : null;
}

export function parseHRASuiteEntitlementReceipt(
  value: unknown,
  nowMs: number = Date.now(),
): SuiteEntitlementReceipt | null {
  const product = isRecord(value)
    ? hraReceiptProduct(value["product"])
    : null;
  if (
    !isRecord(value)
    || value["version"] !== "suite-entitlement-receipt-v1"
    || product === null
    || typeof value["suiteAccountId"] !== "string"
    || typeof value["issuedAtMs"] !== "number"
    || typeof value["expiresAtMs"] !== "number"
    || typeof value["keyVersion"] !== "string"
    || typeof value["signature"] !== "string"
    || !isRecord(value["entitlements"])
  ) {
    return null;
  }
  const parsedEnvironment = environment(value["environment"]);
  const parsedAccountId = parseSuiteAccountId(value["suiteAccountId"]);
  const entitlements = value["entitlements"];
  const features = suiteFeatures(entitlements["features"]);
  if (
    parsedEnvironment === null
    || !parsedAccountId.ok
    || entitlements["version"] !== "suite-entitlements-v1"
    || entitlements["catalogRevision"] !== SUITE_CATALOG_REVISION
    || typeof entitlements["observedAtMs"] !== "number"
    || typeof entitlements["expiresAtMs"] !== "number"
    || typeof entitlements["projectionRevision"] !== "number"
    || features === null
  ) {
    return null;
  }
  const receipt: SuiteEntitlementReceipt = {
    entitlements: {
      catalogRevision: SUITE_CATALOG_REVISION,
      expiresAtMs: entitlements["expiresAtMs"],
      features,
      observedAtMs: entitlements["observedAtMs"],
      projectionRevision: entitlements["projectionRevision"],
      version: "suite-entitlements-v1",
    },
    environment: parsedEnvironment,
    expiresAtMs: value["expiresAtMs"],
    issuedAtMs: value["issuedAtMs"],
    keyVersion: value["keyVersion"],
    product,
    signature: value["signature"],
    suiteAccountId: parsedAccountId.value,
    version: "suite-entitlement-receipt-v1",
  };
  return validateSuiteEntitlementReceipt(receipt, nowMs) === null
    ? receipt
    : null;
}

export function parseHRASuiteOidcSession(
  value: unknown,
  nowMs: number = Date.now(),
): ParsedSuiteOidcSession | null {
  if (!isRecord(value)) return null;
  if (value["kind"] === "signed_out") return { kind: "signed_out" };
  if (value["kind"] === "refresh_required") {
    return { kind: "refresh_required" };
  }
  const session = value["session"];
  if (value["kind"] !== "signed_in" || !isRecord(session)) return null;
  const parsedAccountId = parseSuiteAccountId(session["suiteAccountId"]);
  const entitlements = session["entitlements"];
  if (!parsedAccountId.ok || !isRecord(entitlements)) return null;
  const features = suiteFeatures(entitlements["features"]);
  if (
    features === null
    || (
      entitlements["kind"] !== "fresh"
      && entitlements["kind"] !== "legacy"
      && entitlements["kind"] !== "stale"
    )
  ) {
    return null;
  }
  const receiptValue = session["entitlementReceipt"];
  const entitlementReceipt = receiptValue === null
    ? null
    : parseHRASuiteEntitlementReceipt(receiptValue, nowMs);
  if (
    receiptValue !== null
    && (
      entitlementReceipt === null
      || entitlementReceipt.suiteAccountId !== parsedAccountId.value
      || !sameFeatures(entitlementReceipt.entitlements.features, features)
    )
  ) {
    return null;
  }
  return {
    kind: "signed_in",
    session: {
      entitlementReceipt,
      entitlements: {
        features,
        kind: entitlements["kind"],
      },
      suiteAccountId: parsedAccountId.value,
    },
  };
}
