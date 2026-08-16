export const SUITE_CATALOG_REVISION = "cclrte-suite-v3" as const;
export const PREVIOUS_SUITE_CATALOG_REVISION = "cclrte-suite-v2" as const;
export const HRA_SUITE_PRODUCT = "hra" as const;
export const HRA_SUITE_LEGACY_PRODUCTS = ["oprte", "kitchen"] as const;
export const HRA_SUITE_ENVIRONMENTS = ["development", "production"] as const;
export const HRA_SUITE_FEATURES = ["suite.paid", "suite.believer"] as const;

export const IDENTITY_LINK_PROOF_VERSION =
  "suite-product-link-proof-v1" as const;
export const IDENTITY_LINK_RECEIPT_VERSION =
  "suite-link-receipt-v1" as const;
export const SUITE_ENTITLEMENTS_CLAIM_VERSION =
  "suite-entitlements-v1" as const;
export const SUITE_ENTITLEMENT_RECEIPT_VERSION =
  "suite-entitlement-receipt-v1" as const;

const IDENTITY_LINK_MAX_TTL_MS = 5 * 60_000;
const SUITE_ENTITLEMENT_RECEIPT_MAX_TTL_MS = 5 * 60_000;
const IDENTITY_LINK_CLOCK_SKEW_MS = 30_000;

type ParseResult<Value, Issue extends string> =
  | Readonly<{ ok: true; value: Value }>
  | Readonly<{ error: Issue; ok: false }>;

function ok<Value>(value: Value): Readonly<{ ok: true; value: Value }> {
  return { ok: true, value };
}

function err<Issue extends string>(
  error: Issue,
): Readonly<{ error: Issue; ok: false }> {
  return { error, ok: false };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function containsAsciiControl(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 31 || code === 127) return true;
  }
  return false;
}

function safeInteger(value: unknown): value is number {
  return typeof value === "number"
    && Number.isSafeInteger(value)
    && value >= 0;
}

declare const suiteAccountIdBrand: unique symbol;
declare const suiteUsernameBrand: unique symbol;
declare const identityIssuerBrand: unique symbol;
declare const identitySubjectBrand: unique symbol;

export type SuiteAccountId = string & {
  readonly [suiteAccountIdBrand]: "SuiteAccountId";
};
export type SuiteUsername = string & {
  readonly [suiteUsernameBrand]: "SuiteUsername";
};
export type IdentityIssuer = string & {
  readonly [identityIssuerBrand]: "IdentityIssuer";
};
export type IdentitySubject = string & {
  readonly [identitySubjectBrand]: "IdentitySubject";
};
export type HraSuiteEnvironment = (typeof HRA_SUITE_ENVIRONMENTS)[number];
export type HraSuiteFeature = (typeof HRA_SUITE_FEATURES)[number];
export type SignedHraSuiteProduct =
  | typeof HRA_SUITE_PRODUCT
  | (typeof HRA_SUITE_LEGACY_PRODUCTS)[number];

export function parseSuiteAccountId(
  value: unknown,
): ParseResult<SuiteAccountId, "invalid-suite-account-id"> {
  return typeof value === "string" && /^acct_[0-9a-f]{32}$/u.test(value)
    ? ok(value as SuiteAccountId)
    : err("invalid-suite-account-id");
}

export function parseHraSuiteProduct(
  value: unknown,
): ParseResult<typeof HRA_SUITE_PRODUCT, "invalid-product"> {
  return value === HRA_SUITE_PRODUCT
      || (HRA_SUITE_LEGACY_PRODUCTS as readonly unknown[]).includes(value)
    ? ok(HRA_SUITE_PRODUCT)
    : err("invalid-product");
}

export function parseHraSuiteEnvironment(
  value: unknown,
): ParseResult<HraSuiteEnvironment, "invalid-environment"> {
  return typeof value === "string"
      && (HRA_SUITE_ENVIRONMENTS as readonly string[]).includes(value)
    ? ok(value as HraSuiteEnvironment)
    : err("invalid-environment");
}

export function isHraSuiteIssuableEnvironment(
  value: HraSuiteEnvironment,
): boolean {
  return value === "development" || value === "production";
}

export function parseCurrentSuiteFeatureId(
  value: unknown,
): ParseResult<HraSuiteFeature, "invalid-feature"> {
  return typeof value === "string"
      && (HRA_SUITE_FEATURES as readonly string[]).includes(value)
    ? ok(value as HraSuiteFeature)
    : err("invalid-feature");
}

export const SUITE_USERNAME_MIN_LENGTH = 3;
export const SUITE_USERNAME_MAX_LENGTH = 24;

const suiteUsernamePattern =
  /^[a-z0-9](?:[a-z0-9]|[-_](?=[a-z0-9]))*[a-z0-9]$/u;
const reservedSuiteUsernames = new Set([
  "account",
  "accounts",
  "admin",
  "api",
  "auth",
  "billing",
  "design",
  "docs",
  "help",
  "hraness",
  "login",
  "logout",
  "new",
  "newsletter",
  "party",
  "place",
  "preview",
  "pub",
  "root",
  "settings",
  "social-image",
  "source",
  "sources",
  "support",
  "system",
  "user",
  "users",
  "www",
]);

export type SuiteUsernameIssue =
  | "invalid-suite-username"
  | "suite-username-reserved"
  | "suite-username-too-long"
  | "suite-username-too-short";

function validateCanonicalSuiteUsername(
  value: string,
): ParseResult<SuiteUsername, SuiteUsernameIssue> {
  if (value.length < SUITE_USERNAME_MIN_LENGTH) {
    return err("suite-username-too-short");
  }
  if (value.length > SUITE_USERNAME_MAX_LENGTH) {
    return err("suite-username-too-long");
  }
  if (!suiteUsernamePattern.test(value)) {
    return err("invalid-suite-username");
  }
  return reservedSuiteUsernames.has(value)
    ? err("suite-username-reserved")
    : ok(value as SuiteUsername);
}

export function parseSuiteUsername(
  value: unknown,
): ParseResult<SuiteUsername, SuiteUsernameIssue> {
  if (typeof value !== "string") return err("invalid-suite-username");
  const parsed = validateCanonicalSuiteUsername(value);
  return parsed.ok && parsed.value === value
    ? parsed
    : err(parsed.ok ? "invalid-suite-username" : parsed.error);
}

function parseIdentityIssuer(
  value: unknown,
): ParseResult<IdentityIssuer, "invalid-issuer"> {
  if (
    typeof value !== "string"
    || value.length > 2_048
    || value.trim() !== value
  ) {
    return err("invalid-issuer");
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return err("invalid-issuer");
  }
  const local = new Set(["127.0.0.1", "[::1]", "localhost"])
    .has(parsed.hostname);
  if (
    (parsed.protocol !== "https:" && !(local && parsed.protocol === "http:"))
    || parsed.username !== ""
    || parsed.password !== ""
    || parsed.pathname !== "/"
    || parsed.search !== ""
    || parsed.hash !== ""
  ) {
    return err("invalid-issuer");
  }
  return ok(parsed.origin as IdentityIssuer);
}

function parseIdentitySubject(
  value: unknown,
): ParseResult<IdentitySubject, "invalid-subject"> {
  return typeof value === "string"
      && value.length >= 1
      && value.length <= 255
      && value.trim() === value
      && !containsAsciiControl(value)
    ? ok(value as IdentitySubject)
    : err("invalid-subject");
}

export type SuiteJwtClaims = Readonly<{
  audience: readonly string[];
  expiresAtSeconds: number;
  issuedAtSeconds: number;
  notBeforeSeconds?: number;
  principal: Readonly<{ issuer: IdentityIssuer; subject: IdentitySubject }>;
  profileComplete: boolean;
  profileRevision: "username-v1" | null;
  suiteAccountId: SuiteAccountId;
  username: SuiteUsername | null;
}>;

export function parseSuiteJwtClaims(
  value: unknown,
): ParseResult<SuiteJwtClaims, "invalid-jwt-claims"> {
  if (!isRecord(value)) return err("invalid-jwt-claims");
  const issuer = parseIdentityIssuer(value["iss"]);
  const subject = parseIdentitySubject(value["sub"]);
  const suiteAccountId = parseSuiteAccountId(value["suite_account_id"]);
  const audienceValue = typeof value["aud"] === "string"
    ? [value["aud"]]
    : value["aud"];
  const audience = Array.isArray(audienceValue)
      && audienceValue.length >= 1
      && audienceValue.length <= 8
      && audienceValue.every((entry): entry is string =>
        typeof entry === "string"
        && entry.length >= 1
        && entry.length <= 255
        && entry.trim() === entry
        && !containsAsciiControl(entry)
      )
      && new Set(audienceValue).size === audienceValue.length
    ? audienceValue
    : null;
  const issuedAtSeconds = safeInteger(value["iat"]) ? value["iat"] : null;
  const expiresAtSeconds = safeInteger(value["exp"]) ? value["exp"] : null;
  const notBeforeSeconds = value["nbf"] === undefined
    ? undefined
    : safeInteger(value["nbf"])
      ? value["nbf"]
      : null;
  const legacyProfile = value["profile_revision"] === undefined
    && value["profile_complete"] === undefined
    && value["username"] === undefined;
  const profileRevision = legacyProfile
    ? null
    : value["profile_revision"] === "username-v1"
      ? "username-v1" as const
      : undefined;
  const profileComplete = legacyProfile
    ? false
    : typeof value["profile_complete"] === "boolean"
      ? value["profile_complete"]
      : undefined;
  const username = legacyProfile || value["username"] === null
    ? null
    : parseSuiteUsername(value["username"]);
  if (
    !issuer.ok
    || !subject.ok
    || !suiteAccountId.ok
    || audience === null
    || issuedAtSeconds === null
    || expiresAtSeconds === null
    || expiresAtSeconds <= issuedAtSeconds
    || notBeforeSeconds === null
    || (notBeforeSeconds !== undefined && notBeforeSeconds > expiresAtSeconds)
    || profileRevision === undefined
    || profileComplete === undefined
    || (username !== null && !username.ok)
    || profileComplete !== (username !== null)
  ) {
    return err("invalid-jwt-claims");
  }
  return ok({
    audience,
    expiresAtSeconds,
    issuedAtSeconds,
    ...(notBeforeSeconds === undefined ? {} : { notBeforeSeconds }),
    principal: { issuer: issuer.value, subject: subject.value },
    profileComplete,
    profileRevision,
    suiteAccountId: suiteAccountId.value,
    username: username?.value ?? null,
  });
}

export type ProductLinkProof = Readonly<{
  challengeId: string;
  environment: HraSuiteEnvironment;
  expiresAtMs: number;
  issuedAtMs: number;
  keyVersion: string;
  localSubject: string;
  product: SignedHraSuiteProduct;
}>;

export type SuiteLinkReceipt = ProductLinkProof & Readonly<{
  signature: string;
  suiteAccountId: SuiteAccountId | string;
  version: typeof IDENTITY_LINK_RECEIPT_VERSION;
}>;

export type SuiteEntitlementsClaim = Readonly<{
  catalogRevision: typeof SUITE_CATALOG_REVISION;
  expiresAtMs: number;
  features: readonly HraSuiteFeature[];
  observedAtMs: number;
  projectionRevision: number;
  version: typeof SUITE_ENTITLEMENTS_CLAIM_VERSION;
}>;

export type SuiteEntitlementReceipt = Readonly<{
  entitlements: SuiteEntitlementsClaim;
  environment: HraSuiteEnvironment;
  expiresAtMs: number;
  issuedAtMs: number;
  keyVersion: string;
  product: SignedHraSuiteProduct;
  signature: string;
  suiteAccountId: SuiteAccountId | string;
  version: typeof SUITE_ENTITLEMENT_RECEIPT_VERSION;
}>;

export type IdentityLinkInputIssue = "expired" | "invalid" | "not-yet-valid";

export function validateProductLinkProof(
  input: ProductLinkProof,
  now: number,
): IdentityLinkInputIssue | null {
  if (
    !safeInteger(now)
    || !parseHraSuiteProduct(input.product).ok
    || !parseHraSuiteEnvironment(input.environment).ok
    || !parseIdentitySubject(input.localSubject).ok
    || !/^[A-Za-z0-9_-]{22,128}$/u.test(input.challengeId)
    || !/^[a-z0-9][a-z0-9._-]{0,31}$/u.test(input.keyVersion)
    || !safeInteger(input.issuedAtMs)
    || !safeInteger(input.expiresAtMs)
    || input.expiresAtMs <= input.issuedAtMs
    || input.expiresAtMs - input.issuedAtMs > IDENTITY_LINK_MAX_TTL_MS
  ) {
    return "invalid";
  }
  if (input.issuedAtMs > now + IDENTITY_LINK_CLOCK_SKEW_MS) {
    return "not-yet-valid";
  }
  return input.expiresAtMs <= now ? "expired" : null;
}

export function productLinkProofMessage(input: ProductLinkProof): string {
  return JSON.stringify([
    IDENTITY_LINK_PROOF_VERSION,
    input.product,
    input.environment,
    input.localSubject,
    input.challengeId,
    input.issuedAtMs,
    input.expiresAtMs,
    input.keyVersion,
  ]);
}

export function suiteLinkReceiptMessage(
  input: Omit<SuiteLinkReceipt, "signature" | "version">,
): string {
  return JSON.stringify([
    IDENTITY_LINK_RECEIPT_VERSION,
    input.product,
    input.environment,
    input.localSubject,
    input.suiteAccountId,
    input.challengeId,
    input.issuedAtMs,
    input.expiresAtMs,
    input.keyVersion,
  ]);
}

export function validateSuiteLinkReceipt(
  input: SuiteLinkReceipt,
  now: number,
): IdentityLinkInputIssue | null {
  const proofIssue = validateProductLinkProof(input, now);
  if (
    proofIssue !== null
    || input.version !== IDENTITY_LINK_RECEIPT_VERSION
    || !parseSuiteAccountId(input.suiteAccountId).ok
    || !/^[A-Za-z0-9_-]{43}$/u.test(input.signature)
  ) {
    return proofIssue ?? "invalid";
  }
  return null;
}

function exactCurrentFeatures(values: readonly HraSuiteFeature[]): boolean {
  if (values.length > HRA_SUITE_FEATURES.length) return false;
  const parsed: HraSuiteFeature[] = [];
  for (const value of values) {
    const feature = parseCurrentSuiteFeatureId(value);
    if (!feature.ok || parsed.includes(feature.value)) return false;
    parsed.push(feature.value);
  }
  return parsed.length === 0
    || (parsed.length === 1 && parsed[0] === "suite.paid")
    || (
      parsed.length === 2
      && parsed[0] === "suite.paid"
      && parsed[1] === "suite.believer"
    );
}

export function validateSuiteEntitlementsClaim(
  input: SuiteEntitlementsClaim,
): boolean {
  return input.version === SUITE_ENTITLEMENTS_CLAIM_VERSION
    && input.catalogRevision === SUITE_CATALOG_REVISION
    && safeInteger(input.observedAtMs)
    && safeInteger(input.expiresAtMs)
    && input.expiresAtMs > input.observedAtMs
    && safeInteger(input.projectionRevision)
    && Array.isArray(input.features)
    && exactCurrentFeatures(input.features);
}

export function suiteEntitlementReceiptMessage(
  input: Omit<SuiteEntitlementReceipt, "signature" | "version">,
): string {
  return JSON.stringify([
    SUITE_ENTITLEMENT_RECEIPT_VERSION,
    input.product,
    input.environment,
    input.suiteAccountId,
    input.keyVersion,
    input.issuedAtMs,
    input.expiresAtMs,
    input.entitlements.version,
    input.entitlements.catalogRevision,
    input.entitlements.observedAtMs,
    input.entitlements.expiresAtMs,
    input.entitlements.projectionRevision,
    input.entitlements.features,
  ]);
}

export function validateSuiteEntitlementReceipt(
  input: SuiteEntitlementReceipt,
  now: number,
): IdentityLinkInputIssue | null {
  if (
    !safeInteger(now)
    || input.version !== SUITE_ENTITLEMENT_RECEIPT_VERSION
    || !parseHraSuiteProduct(input.product).ok
    || !parseHraSuiteEnvironment(input.environment).ok
    || !parseSuiteAccountId(input.suiteAccountId).ok
    || !/^[a-z0-9][a-z0-9._-]{0,31}$/u.test(input.keyVersion)
    || !safeInteger(input.issuedAtMs)
    || !safeInteger(input.expiresAtMs)
    || input.expiresAtMs <= input.issuedAtMs
    || input.expiresAtMs - input.issuedAtMs
      > SUITE_ENTITLEMENT_RECEIPT_MAX_TTL_MS
    || !validateSuiteEntitlementsClaim(input.entitlements)
    || input.expiresAtMs > input.entitlements.expiresAtMs
    || !/^[A-Za-z0-9_-]{43}$/u.test(input.signature)
  ) {
    return "invalid";
  }
  if (
    input.issuedAtMs > now + IDENTITY_LINK_CLOCK_SKEW_MS
    || input.entitlements.observedAtMs > now + IDENTITY_LINK_CLOCK_SKEW_MS
  ) {
    return "not-yet-valid";
  }
  return input.expiresAtMs <= now ? "expired" : null;
}
