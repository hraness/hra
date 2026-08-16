import {
  parseCurrentSuiteFeatureId,
  parseSuiteAccountId,
  parseSuiteJwtClaims,
  parseSuiteUsername,
  SUITE_CATALOG_REVISION,
  type HraSuiteFeature,
  type ProductLinkProof,
  type SuiteAccountId,
  type SuiteEntitlementReceipt,
  type SuiteLinkReceipt,
  type SuiteUsername,
  validateProductLinkProof,
  validateSuiteEntitlementReceipt,
  validateSuiteLinkReceipt,
} from "./suite-account-contracts";
import {
  createLocalJWKSet,
  decodeProtectedHeader,
  jwtVerify,
  type JSONWebKeySet,
  type JWTPayload,
} from "jose";

import {
  SUITE_ENTITLEMENT_MAX_PROVIDER_AGE_MS,
  verifySuiteEntitlementToken,
  type SuiteEntitlementsClaim,
  type VerifiedSuiteEntitlements,
} from "./suite-account-entitlements";
import {
  HRA_SITE_URL,
  HRA_SUITE_OIDC_CALLBACK_URL,
  HRA_SUITE_OIDC_CLIENT_ID,
  HRA_SUITE_OIDC_PROVIDER,
  type HraSuiteOidcProviderConfiguration,
} from "./suite-account-configuration";
import type { HraSuiteProfile } from "./suite-account-profile";

const SUITE_OIDC_EARLY_REFRESH_WINDOW_MS = 30_000;
type HraSuiteOidcEnvironment = "production";

const TRANSACTION_TTL_MS = 10 * 60_000;
const SESSION_TTL_MS = 7 * 24 * 60 * 60_000;
const FETCH_TIMEOUT_MS = 8_000;
const MAX_PROVIDER_BODY_BYTES = 64 * 1_024;
const MAX_COOKIE_BYTES = 4_096;
const MAX_RETURN_PATH_BYTES = 1_024;
const MAX_CODE_BYTES = 2_048;
const ALLOWED_TOKEN_ALGORITHMS = ["ES256"] as const;
const REMOTE_TRANSACTION_COOKIE = "__Host-hraness-suite-oidc-transaction";
const REMOTE_SESSION_COOKIE = "__Host-hraness-suite-oidc-session";
const LOCAL_TRANSACTION_COOKIE = "hraness-suite-oidc-local-transaction";
const LOCAL_SESSION_COOKIE = "hraness-suite-oidc-local-session";

export type SuiteOidcConsumer = "hra";
type SuiteOidcReceiptConsumer = SuiteOidcConsumer;
type FetchImplementation = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

function isReceiptConsumer(
  consumer: SuiteOidcConsumer,
): consumer is SuiteOidcReceiptConsumer {
  return consumer === "hra";
}

type Transaction = Readonly<{
  consumer: SuiteOidcConsumer;
  environment: HraSuiteOidcEnvironment;
  expiresAtMs: number;
  issuedAtMs: number;
  nonce: string;
  returnTo: string;
  state: string;
  verifier: string;
  version: 1;
}>;

type SuiteOidcProfile = HraSuiteProfile;

type StoredSession = Readonly<{
  accessToken: string;
  audience: string;
  entitlements: VerifiedSuiteEntitlements;
  environment: HraSuiteOidcEnvironment;
  expiresAtMs: number;
  accessTokenExpiresAtMs: number;
  issuer: string;
  nonce: string;
  pendingEntitlementReceipt: SuiteEntitlementReceipt | null;
  refreshToken: string;
  subject: string;
  suiteAccountId: SuiteAccountId;
  version: 2;
}> & SuiteOidcProfile;

type SuiteOidcSessionViewBase = Readonly<{
  entitlementReceipt: SuiteEntitlementReceipt | null;
  entitlements: Readonly<{
    features: readonly ("suite.believer" | "suite.paid")[];
    kind: "fresh" | "legacy" | "stale";
  }>;
  suiteAccountId: SuiteAccountId;
}>;

export type SuiteOidcSessionView =
  SuiteOidcSessionViewBase & SuiteOidcProfile;

/**
 * Server-only identity projected from a verified, unexpired RP session.
 *
 * The access token remains inside this accessor and the encrypted HttpOnly
 * cookie. It is never part of the public `/session` response.
 */
export type SuiteOidcServerAccountSession = Readonly<{
  accessToken: string;
  accessTokenExpiresAtMs: number;
  suiteAccountId: SuiteAccountId;
}>;

export type SuiteOidcServerSession = SuiteOidcServerAccountSession & Readonly<{
  username: SuiteUsername;
}>;

/**
 * Canonical verified email projected only to trusted product server code.
 *
 * This value is fetched from the live Suite userinfo response. It is never
 * stored in the relying-party cookie or included in the browser session view.
 */
export type SuiteOidcServerVerifiedEmail = Readonly<{
  accessTokenExpiresAtMs: number;
  email: string;
  suiteAccountId: SuiteAccountId;
  username: SuiteUsername;
}>;

export type SuiteOidcRelyingPartyOptions = Readonly<{
  consumer: SuiteOidcConsumer;
  cookieSecret: string;
  environment: HraSuiteOidcEnvironment;
  fetch?: FetchImplementation;
  fetchTimeoutMs?: number;
  now?: () => number;
  randomBytes?: (length: number) => Uint8Array;
  receiptKeyVersion: string;
}>;

export type SuiteOidcRelyingParty = Readonly<{
  callback(request: Request): Promise<Response>;
  acknowledgeEntitlementReceipt(request: Request): Promise<Response>;
  configuration: Readonly<{
    callbackUrl: string;
    clientId: string;
    provider: HraSuiteOidcProviderConfiguration;
    siteUrl: string;
  }>;
  currentSession(request: Request): Promise<Response>;
  handle(request: Request): Promise<Response>;
  linkReceipt(request: Request): Promise<Response>;
  refreshSession(request: Request): Promise<Response>;
  serverAccountSession(
    request: Request,
  ): Promise<SuiteOidcServerAccountSession | null>;
  serverSession(request: Request): Promise<SuiteOidcServerSession | null>;
  serverVerifiedEmail(
    request: Request,
  ): Promise<SuiteOidcServerVerifiedEmail | null>;
  signOut(request: Request): Promise<Response>;
  start(request: Request): Promise<Response>;
}>;

type TokenResponse = Readonly<{
  accessToken: string;
  idToken: string | null;
  refreshToken: string;
  tokenType: "Bearer";
}>;

type IdentityLinkReceiptRequest = ProductLinkProof & Readonly<{
  proofSignature: string;
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeInteger(value: unknown): value is number {
  return typeof value === "number"
    && Number.isSafeInteger(value)
    && value >= 0;
}

function boundedString(
  value: unknown,
  minimum: number,
  maximum: number,
): value is string {
  return typeof value === "string"
    && value.length >= minimum
    && value.length <= maximum
    && !value.includes("\u0000");
}

function encodeBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

function decodeBase64Url(value: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) return null;
  const padded = value.replaceAll("-", "+").replaceAll("_", "/")
    + "=".repeat((4 - (value.length % 4)) % 4);
  try {
    const binary = atob(padded);
    return Uint8Array.from(binary, character => character.charCodeAt(0));
  } catch {
    return null;
  }
}

function ownedBytes(value: Uint8Array): Uint8Array<ArrayBuffer> {
  const result = new Uint8Array(new ArrayBuffer(value.byteLength));
  result.set(value);
  return result;
}

function randomValue(
  length: number,
  source: (length: number) => Uint8Array,
): string {
  const bytes = source(length);
  if (bytes.byteLength !== length) {
    throw new Error("The OIDC random source returned the wrong byte length.");
  }
  return encodeBase64Url(bytes);
}

async function sha256Base64Url(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return encodeBase64Url(new Uint8Array(digest));
}

function cookieNames(siteUrl: string) {
  const secure = new URL(siteUrl).protocol === "https:";
  return {
    secure,
    session: secure ? REMOTE_SESSION_COOKIE : LOCAL_SESSION_COOKIE,
    transaction: secure
      ? REMOTE_TRANSACTION_COOKIE
      : LOCAL_TRANSACTION_COOKIE,
  };
}

function cookieAttributes(secure: boolean, maxAgeSeconds: number): string {
  return [
    `Max-Age=${maxAgeSeconds}`,
    "Path=/",
    "HttpOnly",
    ...(secure ? ["Secure"] : []),
    "SameSite=Lax",
  ].join("; ");
}

function setCookie(
  name: string,
  value: string,
  secure: boolean,
  maxAgeSeconds: number,
): string {
  return `${name}=${value}; ${cookieAttributes(secure, maxAgeSeconds)}`;
}

function clearCookie(name: string, secure: boolean): string {
  return [
    `${name}=`,
    "Max-Age=0",
    "Expires=Thu, 01 Jan 1970 00:00:00 GMT",
    "Path=/",
    "HttpOnly",
    ...(secure ? ["Secure"] : []),
    "SameSite=Lax",
  ].join("; ");
}

function requestCookie(request: Request, name: string): string | null {
  const header = request.headers.get("cookie");
  if (header === null || header.length > 16_384) return null;
  const values: string[] = [];
  for (const segment of header.split(";")) {
    const trimmed = segment.trim();
    const separator = trimmed.indexOf("=");
    if (separator <= 0 || trimmed.slice(0, separator) !== name) continue;
    values.push(trimmed.slice(separator + 1));
  }
  return values.length === 1 ? values[0]! : null;
}

async function deriveCookieKey(
  secret: string,
  consumer: SuiteOidcConsumer,
  environment: HraSuiteOidcEnvironment,
): Promise<CryptoKey> {
  const material = new TextEncoder().encode(
    `hraness-suite-oidc-cookie-v1\u0000${consumer}\u0000${environment}\u0000${secret}`,
  );
  const digest = await crypto.subtle.digest("SHA-256", material);
  return await crypto.subtle.importKey(
    "raw",
    digest,
    { name: "AES-GCM" },
    false,
    ["decrypt", "encrypt"],
  );
}

async function sealCookie(
  value: unknown,
  key: CryptoKey,
  purpose: "session" | "transaction",
  randomBytes: (length: number) => Uint8Array,
): Promise<string> {
  const iv = ownedBytes(randomBytes(12));
  if (iv.byteLength !== 12) throw new Error("Invalid OIDC cookie IV.");
  const plaintext = new TextEncoder().encode(JSON.stringify(value));
  if (plaintext.byteLength > MAX_COOKIE_BYTES - 256) {
    throw new Error("The OIDC cookie payload was too large.");
  }
  const aad = new TextEncoder().encode(`hraness-suite-oidc-${purpose}-v1`);
  const encrypted = await crypto.subtle.encrypt(
    { additionalData: aad, iv, name: "AES-GCM", tagLength: 128 },
    key,
    plaintext,
  );
  const sealed = `v1.${encodeBase64Url(iv)}.${encodeBase64Url(
    new Uint8Array(encrypted),
  )}`;
  if (sealed.length > MAX_COOKIE_BYTES) {
    throw new Error("The sealed OIDC cookie was too large.");
  }
  return sealed;
}

async function unsealCookie(
  value: string,
  key: CryptoKey,
  purpose: "session" | "transaction",
): Promise<unknown> {
  if (value.length < 1 || value.length > MAX_COOKIE_BYTES) return null;
  const parts = value.split(".");
  if (parts.length !== 3 || parts[0] !== "v1") return null;
  const iv = decodeBase64Url(parts[1]!);
  const ciphertext = decodeBase64Url(parts[2]!);
  if (iv?.byteLength !== 12 || ciphertext === null) return null;
  try {
    const plaintext = await crypto.subtle.decrypt(
      {
        additionalData: new TextEncoder().encode(
          `hraness-suite-oidc-${purpose}-v1`,
        ),
        iv: ownedBytes(iv),
        name: "AES-GCM",
        tagLength: 128,
      },
      key,
      ownedBytes(ciphertext),
    );
    if (plaintext.byteLength > MAX_COOKIE_BYTES) return null;
    return JSON.parse(new TextDecoder().decode(plaintext)) as unknown;
  } catch {
    return null;
  }
}

function parseTransaction(
  value: unknown,
  consumer: SuiteOidcConsumer,
  environment: HraSuiteOidcEnvironment,
  nowMs: number,
): Transaction | null {
  if (
    !isRecord(value)
    || value["version"] !== 1
    || value["consumer"] !== consumer
    || value["environment"] !== environment
    || !safeInteger(value["issuedAtMs"])
    || !safeInteger(value["expiresAtMs"])
    || value["expiresAtMs"] <= nowMs
    || value["issuedAtMs"] > nowMs + 30_000
    || value["expiresAtMs"] - value["issuedAtMs"] > TRANSACTION_TTL_MS
    || !boundedString(value["state"], 43, 128)
    || !boundedString(value["nonce"], 43, 128)
    || !boundedString(value["verifier"], 43, 128)
    || parseReturnPath(value["returnTo"], "") === null
  ) {
    return null;
  }
  return value as Transaction;
}

function parseStoredEntitlements(value: unknown): VerifiedSuiteEntitlements | null {
  if (!isRecord(value) || !Array.isArray(value["features"])) return null;
  const features: HraSuiteFeature[] = [];
  for (const rawFeature of value["features"]) {
    const feature = parseCurrentSuiteFeatureId(rawFeature);
    if (!feature.ok || features.includes(feature.value)) return null;
    features.push(feature.value);
  }
  if (value["kind"] === "legacy") {
    return value["claim"] === null && features.length === 0
      ? { claim: null, features: [], kind: "legacy" }
      : null;
  }
  if (value["kind"] !== "fresh" && value["kind"] !== "stale") return null;
  const claim = value["claim"];
  if (
    !isRecord(claim)
    || claim["version"] !== "suite-entitlements-v1"
    || claim["catalogRevision"] !== SUITE_CATALOG_REVISION
    || !safeInteger(claim["observedAtMs"])
    || !safeInteger(claim["expiresAtMs"])
    || !safeInteger(claim["projectionRevision"])
    || !Array.isArray(claim["features"])
  ) {
    return null;
  }
  const claimFeatures: HraSuiteFeature[] = [];
  for (const rawFeature of claim["features"]) {
    const feature = parseCurrentSuiteFeatureId(rawFeature);
    if (!feature.ok || claimFeatures.includes(feature.value)) return null;
    claimFeatures.push(feature.value);
  }
  if (
    claim["expiresAtMs"] <= claim["observedAtMs"]
    || (
      value["kind"] === "fresh"
      && (
        features.length !== claimFeatures.length
        || features.some(feature => !claimFeatures.includes(feature))
      )
    )
  ) {
    return null;
  }
  const parsedClaim: SuiteEntitlementsClaim = {
    catalogRevision: SUITE_CATALOG_REVISION,
    expiresAtMs: claim["expiresAtMs"],
    features: claimFeatures,
    observedAtMs: claim["observedAtMs"],
    projectionRevision: claim["projectionRevision"],
    version: "suite-entitlements-v1",
  };
  return value["kind"] === "fresh"
    ? { claim: parsedClaim, features, kind: "fresh" }
    : { claim: parsedClaim, features: [], kind: "stale" };
}

function parseEntitlementReceipt(
  value: unknown,
  consumer: SuiteOidcConsumer,
  environment: HraSuiteOidcEnvironment,
  keyVersion: string,
  suiteAccountId: string,
  nowMs: number,
): SuiteEntitlementReceipt | null {
  if (!isReceiptConsumer(consumer)) return null;
  if (
    !isRecord(value)
    || !isRecord(value["entitlements"])
  ) {
    return null;
  }
  try {
    const receipt = value as unknown as SuiteEntitlementReceipt;
    return validateSuiteEntitlementReceipt(receipt, nowMs) === null
        && receipt.product === consumer
        && receipt.environment === environment
        && receipt.keyVersion === keyVersion
        && receipt.suiteAccountId === suiteAccountId
      ? receipt
      : null;
  } catch {
    return null;
  }
}

function parseIdentityLinkReceiptRequest(
  value: unknown,
  consumer: SuiteOidcConsumer,
  environment: HraSuiteOidcEnvironment,
  nowMs: number,
): IdentityLinkReceiptRequest | null {
  if (!isReceiptConsumer(consumer)) return null;
  if (
    !isRecord(value)
    || Object.keys(value).length !== 8
    || value["product"] !== consumer
    || value["environment"] !== environment
    || !boundedString(value["challengeId"], 22, 128)
    || !boundedString(value["localSubject"], 1, 255)
    || !boundedString(value["keyVersion"], 1, 32)
    || !boundedString(value["proofSignature"], 43, 43)
    || !safeInteger(value["issuedAtMs"])
    || !safeInteger(value["expiresAtMs"])
  ) {
    return null;
  }
  const proof: ProductLinkProof = {
    challengeId: value["challengeId"],
    environment,
    expiresAtMs: value["expiresAtMs"],
    issuedAtMs: value["issuedAtMs"],
    keyVersion: value["keyVersion"],
    localSubject: value["localSubject"],
    product: consumer,
  };
  return validateProductLinkProof(proof, nowMs) === null
      && /^[A-Za-z0-9_-]{43}$/u.test(value["proofSignature"])
    ? { ...proof, proofSignature: value["proofSignature"] }
    : null;
}

function parseIdentityLinkReceipt(
  value: unknown,
  proof: IdentityLinkReceiptRequest,
  suiteAccountId: string,
  nowMs: number,
): SuiteLinkReceipt | null {
  if (!isRecord(value)) return null;
  try {
    const receipt = value as unknown as SuiteLinkReceipt;
    return validateSuiteLinkReceipt(receipt, nowMs) === null
        && receipt.challengeId === proof.challengeId
        && receipt.environment === proof.environment
        && receipt.expiresAtMs === proof.expiresAtMs
        && receipt.issuedAtMs === proof.issuedAtMs
        && receipt.keyVersion === proof.keyVersion
        && receipt.localSubject === proof.localSubject
        && receipt.product === proof.product
        && receipt.suiteAccountId === suiteAccountId
      ? receipt
      : null;
  } catch {
    return null;
  }
}

function parseStoredProfile(value: Record<string, unknown>): SuiteOidcProfile | null {
  const profileRevision = value["profileRevision"];
  const profileComplete = value["profileComplete"];
  const rawUsername = value["username"];
  if (
    profileComplete === false
    && (profileRevision === null || profileRevision === "username-v1")
    && rawUsername === null
  ) {
    return {
      profileComplete: false,
      profileRevision,
      username: null,
    };
  }
  if (profileComplete !== true || profileRevision !== "username-v1") {
    return null;
  }
  const username = parseSuiteUsername(rawUsername);
  return username.ok
    ? {
        profileComplete: true,
        profileRevision: "username-v1",
        username: username.value,
      }
    : null;
}

function profileFromClaims(
  claims: Readonly<{
    profileComplete: boolean;
    profileRevision: "username-v1" | null;
    username: SuiteUsername | null;
  }>,
): SuiteOidcProfile | null {
  if (
    claims.profileComplete
    && claims.profileRevision === "username-v1"
    && claims.username !== null
  ) {
    return {
      profileComplete: true,
      profileRevision: "username-v1",
      username: claims.username,
    };
  }
  return !claims.profileComplete && claims.username === null
    ? {
        profileComplete: false,
        profileRevision: claims.profileRevision,
        username: null,
      }
    : null;
}

function parseSession(
  value: unknown,
  configuration: SuiteOidcRelyingParty["configuration"],
  consumer: SuiteOidcConsumer,
  environment: HraSuiteOidcEnvironment,
  receiptKeyVersion: string,
  nowMs: number,
): StoredSession | null {
  if (
    !isRecord(value)
    || value["version"] !== 2
    || value["environment"] !== environment
    || value["issuer"] !== configuration.provider.issuer
    || !boundedString(value["accessToken"], 16, 16_384)
    || value["audience"] !== configuration.provider.resource
    || !boundedString(value["subject"], 1, 255)
    || !/^acct_[0-9a-f]{32}$/u.test(String(value["suiteAccountId"]))
    || !boundedString(value["nonce"], 43, 128)
    || !boundedString(value["refreshToken"], 16, 2_048)
    || !safeInteger(value["accessTokenExpiresAtMs"])
    || !safeInteger(value["expiresAtMs"])
    || value["expiresAtMs"] <= nowMs
    || value["expiresAtMs"] > nowMs + SESSION_TTL_MS + 30_000
  ) {
    return null;
  }
  const suiteAccountId = parseSuiteAccountId(value["suiteAccountId"]);
  const entitlements = parseStoredEntitlements(value["entitlements"]);
  const profile = parseStoredProfile(value);
  const pendingEntitlementReceipt = value["pendingEntitlementReceipt"] === null
    ? null
    : parseEntitlementReceipt(
        value["pendingEntitlementReceipt"],
        consumer,
        environment,
        receiptKeyVersion,
        String(value["suiteAccountId"]),
        nowMs,
      );
  return entitlements === null || profile === null || !suiteAccountId.ok
    ? null
    : {
        ...(value as Omit<
          StoredSession,
          | "entitlements"
          | "pendingEntitlementReceipt"
          | "profileComplete"
          | "profileRevision"
          | "suiteAccountId"
          | "username"
        >),
        entitlements,
        pendingEntitlementReceipt,
        ...profile,
        suiteAccountId: suiteAccountId.value,
      };
}

function parseReturnPath(value: unknown, fallback = "/"): string | null {
  if (value === undefined || value === null || value === "") return fallback;
  if (
    typeof value !== "string"
    || value.length > MAX_RETURN_PATH_BYTES
    || !value.startsWith("/")
    || value.startsWith("//")
    || value.includes("\\")
    || value.includes("#")
  ) {
    return null;
  }
  let parsed: URL;
  try {
    parsed = new URL(value, "https://return.invalid");
  } catch {
    return null;
  }
  if (
    parsed.origin !== "https://return.invalid"
    || parsed.username !== ""
    || parsed.password !== ""
    || parsed.pathname.startsWith("/api/suite-auth/")
  ) {
    return null;
  }
  return `${parsed.pathname}${parsed.search}`;
}

function exactRequest(
  request: Request,
  siteUrl: string,
  path: string,
  method: "GET" | "POST",
): boolean {
  let url: URL;
  try {
    url = new URL(request.url);
  } catch {
    return false;
  }
  if (request.method !== method || url.origin !== siteUrl || url.pathname !== path) {
    return false;
  }
  const fetchSite = request.headers.get("sec-fetch-site");
  if (fetchSite !== null && fetchSite.toLowerCase() !== "same-origin") {
    return false;
  }
  if (method === "POST" && request.headers.get("origin") !== siteUrl) {
    return false;
  }
  return true;
}

function exactCallbackRequest(
  request: Request,
  siteUrl: string,
): boolean {
  let url: URL;
  try {
    url = new URL(request.url);
  } catch {
    return false;
  }
  if (
    request.method !== "GET"
    || url.origin !== siteUrl
    || url.pathname !== "/api/suite-auth/callback"
  ) {
    return false;
  }
  const mode = request.headers.get("sec-fetch-mode");
  const destination = request.headers.get("sec-fetch-dest");
  const site = request.headers.get("sec-fetch-site");
  return (mode === null || mode.toLowerCase() === "navigate")
    && (destination === null || destination.toLowerCase() === "document")
    && (
      site === null
      || ["cross-site", "same-origin", "same-site", "none"].includes(
        site.toLowerCase(),
      )
    );
}

function jsonResponse(
  body: unknown,
  status: number,
  cookies: readonly string[] = [],
): Response {
  const headers = new Headers({
    "cache-control": "no-store",
    "content-type": "application/json; charset=utf-8",
    pragma: "no-cache",
  });
  for (const cookie of cookies) headers.append("set-cookie", cookie);
  return new Response(JSON.stringify(body), { headers, status });
}

function failure(
  code: string,
  status: number,
  cookies: readonly string[] = [],
): Response {
  return jsonResponse({
    error: { code, retryable: status >= 500 },
    schemaVersion: 1,
  }, status, cookies);
}

async function readBoundedJson(
  response: Response,
  maximumBytes = MAX_PROVIDER_BODY_BYTES,
): Promise<unknown> {
  const declared = response.headers.get("content-length");
  if (
    declared !== null
    && (!/^(?:0|[1-9]\d*)$/u.test(declared)
      || Number(declared) > maximumBytes)
  ) {
    throw new Error("Provider response was too large.");
  }
  if (response.body === null) throw new Error("Provider response was empty.");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const result = await reader.read();
    if (result.done) break;
    length += result.value.byteLength;
    if (length > maximumBytes) {
      await reader.cancel();
      throw new Error("Provider response was too large.");
    }
    chunks.push(result.value);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
}

async function consumeBoundedBody(
  response: Response,
  maximumBytes: number,
): Promise<void> {
  const declared = response.headers.get("content-length");
  if (
    declared !== null
    && (!/^(?:0|[1-9]\d*)$/u.test(declared)
      || Number(declared) > maximumBytes)
  ) {
    throw new Error("Provider response was too large.");
  }
  if (response.body === null) return;
  const reader = response.body.getReader();
  let length = 0;
  while (true) {
    const result = await reader.read();
    if (result.done) return;
    length += result.value.byteLength;
    if (length > maximumBytes) {
      await reader.cancel();
      throw new Error("Provider response was too large.");
    }
  }
}

async function readBoundedRequestJson(
  request: Request,
  maximumBytes: number,
): Promise<unknown> {
  const declared = request.headers.get("content-length");
  if (
    declared !== null
    && (!/^(?:0|[1-9]\d*)$/u.test(declared)
      || Number(declared) > maximumBytes)
  ) {
    throw new Error("Request body was too large.");
  }
  if (request.body === null) throw new Error("Request body was empty.");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const result = await reader.read();
    if (result.done) break;
    if (result.value.byteLength > maximumBytes - length) {
      await reader.cancel();
      throw new Error("Request body was too large.");
    }
    length += result.value.byteLength;
    chunks.push(result.value);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
}

async function providerJson(
  url: string,
  init: RequestInit,
  fetchImplementation: FetchImplementation,
  timeoutMs: number,
): Promise<unknown> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImplementation(url, {
      ...init,
      redirect: "manual",
      signal: controller.signal,
    });
    if (
      response.status !== 200
      || response.headers.has("location")
    ) {
      throw new Error("Provider request failed.");
    }
    return await readBoundedJson(response);
  } finally {
    clearTimeout(timeout);
  }
}

export function validateSuiteOidcDiscovery(
  value: unknown,
  expected: HraSuiteOidcProviderConfiguration,
): boolean {
  if (!isRecord(value)) return false;
  const exact = (
    value["issuer"] === expected.issuer
    && value["authorization_endpoint"] === expected.authorizationEndpoint
    && value["token_endpoint"] === expected.tokenEndpoint
    && value["jwks_uri"] === expected.jwksEndpoint
    && value["revocation_endpoint"] === expected.revocationEndpoint
  );
  const responseTypes = value["response_types_supported"];
  const grants = value["grant_types_supported"];
  const challenges = value["code_challenge_methods_supported"];
  const methods = value["token_endpoint_auth_methods_supported"];
  const algorithms = value["id_token_signing_alg_values_supported"];
  return exact
    && Array.isArray(responseTypes)
    && responseTypes.includes("code")
    && Array.isArray(grants)
    && grants.includes("authorization_code")
    && grants.includes("refresh_token")
    && Array.isArray(challenges)
    && challenges.includes("S256")
    && Array.isArray(methods)
    && methods.includes("none")
    && Array.isArray(algorithms)
    && algorithms.length === 1
    && algorithms[0] === "ES256"
    && !algorithms.includes("HS256");
}

function parseTokenResponse(
  value: unknown,
  requireIdToken: boolean,
): TokenResponse | null {
  if (
    !isRecord(value)
    || value["token_type"] !== "Bearer"
    || !boundedString(value["access_token"], 16, 16_384)
    || !boundedString(value["refresh_token"], 16, 4_096)
    || (
      value["id_token"] !== undefined
      && !boundedString(value["id_token"], 64, 16_384)
    )
    || (requireIdToken && !boundedString(value["id_token"], 64, 16_384))
  ) {
    return null;
  }
  return {
    accessToken: value["access_token"],
    idToken: typeof value["id_token"] === "string"
      ? value["id_token"]
      : null,
    refreshToken: value["refresh_token"],
    tokenType: "Bearer",
  };
}

function parseJwks(value: unknown): JSONWebKeySet | null {
  if (
    !isRecord(value)
    || !Array.isArray(value["keys"])
    || value["keys"].length < 1
    || value["keys"].length > 8
  ) {
    return null;
  }
  for (const key of value["keys"]) {
    if (
      !isRecord(key)
      || !boundedString(key["kid"], 1, 128)
      || (
        key["alg"] !== undefined
        && key["alg"] !== "ES256"
      )
      || key["kty"] !== "EC"
      || key["crv"] !== "P-256"
      || !boundedString(key["x"], 1, 256)
      || !boundedString(key["y"], 1, 256)
      || key["d"] !== undefined
    ) {
      return null;
    }
  }
  return value as unknown as JSONWebKeySet;
}

type VerifiedIdToken = Readonly<{
  profile: SuiteOidcProfile;
  subject: string;
  suiteAccountId: SuiteAccountId;
}>;

async function verifiedIdToken(input: {
  configuration: SuiteOidcRelyingParty["configuration"];
  expectedNonce: string;
  idToken: string;
  jwks: JSONWebKeySet;
  nowMs: number;
}): Promise<VerifiedIdToken | null> {
  const header = decodeProtectedHeader(input.idToken);
  if (
    !boundedString(header.kid, 1, 128)
    || header.alg !== "ES256"
  ) {
    return null;
  }
  const verified = await jwtVerify(
    input.idToken,
    createLocalJWKSet(input.jwks),
    {
      algorithms: [...ALLOWED_TOKEN_ALGORITHMS],
      audience: input.configuration.clientId,
      clockTolerance: 30,
      currentDate: new Date(input.nowMs),
      issuer: input.configuration.provider.issuer,
      maxTokenAge: "20m",
    },
  );
  if (
    verified.payload["nonce"] !== input.expectedNonce
    || !boundedString(verified.payload.sub, 1, 255)
  ) {
    return null;
  }
  const claims = parseSuiteJwtClaims(verified.payload);
  if (!claims.ok) return null;
  const profile = profileFromClaims(claims.value);
  if (profile === null) return null;
  return {
    profile,
    subject: String(claims.value.principal.subject),
    suiteAccountId: claims.value.suiteAccountId,
  };
}

function exactAccessTokenAudience(
  value: unknown,
  provider: HraSuiteOidcProviderConfiguration,
): boolean {
  if (!Array.isArray(value) || value.length !== 2) return false;
  const audiences = new Set(value);
  return audiences.size === 2
    && audiences.has(provider.resource)
    && audiences.has(provider.userInfoAudience);
}

async function verifiedSessionFromAccessToken(input: {
  accessToken: string;
  configuration: SuiteOidcRelyingParty["configuration"];
  environment: HraSuiteOidcEnvironment;
  expectedAccountId?: string;
  expectedProfile?: SuiteOidcProfile;
  expectedSubject?: string;
  profileTransition: "exact" | "forward";
  jwks: JSONWebKeySet;
  nonce: string;
  nowMs: number;
  refreshToken: string;
}): Promise<StoredSession | null> {
  const header = decodeProtectedHeader(input.accessToken);
  if (!boundedString(header.kid, 1, 128) || header.alg !== "ES256") {
    return null;
  }
  let verifiedPayload: JWTPayload;
  try {
    const verified = await jwtVerify(
      input.accessToken,
      createLocalJWKSet(input.jwks),
      {
        algorithms: [...ALLOWED_TOKEN_ALGORITHMS],
        audience: input.configuration.provider.resource,
        clockTolerance: 30,
        currentDate: new Date(input.nowMs),
        issuer: input.configuration.provider.issuer,
        maxTokenAge: "20m",
      },
    );
    verifiedPayload = verified.payload;
  } catch {
    return null;
  }
  const result = await verifySuiteEntitlementToken(input.accessToken, {
    expectedAudience: input.configuration.provider.resource,
    expectedIssuer: input.configuration.provider.issuer,
    nowMs: input.nowMs,
    verify: () => Promise.resolve(verifiedPayload),
  });
  const profile = result.kind === "verified"
    ? profileFromClaims(result.claims)
    : null;
  const expectedProfileMatches = input.expectedProfile === undefined
    || (
      input.expectedProfile.profileComplete
        ? profile?.profileComplete === true
          && profile.username === input.expectedProfile.username
        : input.profileTransition === "forward"
          ? (
              profile?.profileComplete === true
              || (
                profile?.profileComplete === false
                && (
                  input.expectedProfile.profileRevision === null
                  || profile.profileRevision === input.expectedProfile.profileRevision
                )
              )
            )
          : profile?.profileComplete === false
            && profile.profileRevision === input.expectedProfile.profileRevision
    );
  if (
    result.kind !== "verified"
    || profile === null
    || !expectedProfileMatches
    || !exactAccessTokenAudience(
      verifiedPayload.aud,
      input.configuration.provider,
    )
    || verifiedPayload["azp"] !== input.configuration.clientId
    || verifiedPayload["suite_client_id"] !== input.configuration.clientId
    || (
      input.expectedSubject !== undefined
      && result.claims.principal.subject !== input.expectedSubject
    )
    || (
      input.expectedAccountId !== undefined
      && result.claims.suiteAccountId !== input.expectedAccountId
    )
  ) {
    return null;
  }
  return {
    accessToken: input.accessToken,
    audience: input.configuration.provider.resource,
    entitlements: result.entitlements,
    environment: input.environment,
    expiresAtMs: input.nowMs + SESSION_TTL_MS,
    accessTokenExpiresAtMs: result.claims.expiresAtSeconds * 1_000,
    issuer: input.configuration.provider.issuer,
    nonce: input.nonce,
    pendingEntitlementReceipt: null,
    ...profile,
    refreshToken: input.refreshToken,
    subject: String(result.claims.principal.subject),
    suiteAccountId: result.claims.suiteAccountId,
    version: 2,
  };
}

function currentView(
  session: StoredSession,
  nowMs: number,
): SuiteOidcSessionView | null {
  if (session.accessTokenExpiresAtMs <= nowMs) return null;
  const entitlements = session.entitlements;
  const fresh = entitlements.kind === "fresh"
    && entitlements.claim.expiresAtMs > nowMs
    && nowMs - entitlements.claim.observedAtMs
      <= SUITE_ENTITLEMENT_MAX_PROVIDER_AGE_MS;
  const base: SuiteOidcSessionViewBase = {
    entitlementReceipt: session.pendingEntitlementReceipt,
    entitlements: {
      features: fresh ? entitlements.features : [],
      kind: entitlements.kind === "legacy"
        ? "legacy"
        : fresh ? "fresh" : "stale",
    },
    suiteAccountId: session.suiteAccountId,
  };
  return session.profileComplete
    ? {
        ...base,
        profileComplete: true,
        profileRevision: "username-v1",
        username: session.username,
      }
    : {
        ...base,
        profileComplete: false,
        profileRevision: session.profileRevision,
        username: null,
      };
}

function liveUserInfoMatchesSession(
  value: unknown,
  configuration: SuiteOidcRelyingParty["configuration"],
  session: StoredSession,
  view: SuiteOidcSessionView,
): boolean {
  if (!isRecord(value)) return false;
  const account = parseSuiteAccountId(value["suite_account_id"]);
  if (
    !account.ok
    || account.value !== session.suiteAccountId
    || value["suite_client_id"] !== configuration.clientId
    || value["sub"] !== session.subject
    || value["profile_complete"] !== view.profileComplete
    || value["profile_revision"] !== view.profileRevision
  ) {
    return false;
  }
  if (!view.profileComplete) return value["username"] === null;
  const username = parseSuiteUsername(value["username"]);
  return username.ok && username.value === view.username;
}

function verifiedEmailFromUserInfo(value: unknown): string | null {
  if (!isRecord(value) || value["email_verified"] !== true) return null;
  const rawEmail = value["email"];
  if (
    typeof rawEmail !== "string"
    || rawEmail.length === 0
    || rawEmail.length > 320
    || rawEmail.trim() !== rawEmail
    || [...rawEmail].some((character) => {
      const codePoint = character.codePointAt(0);
      return codePoint !== undefined && (codePoint <= 0x20 || codePoint === 0x7f);
    })
    || !/^[^@]+@[^@]+\.[^@]+$/u.test(rawEmail)
  ) return null;
  return rawEmail.toLocaleLowerCase("en-US");
}

export function createSuiteOidcRelyingParty(
  options: SuiteOidcRelyingPartyOptions,
): SuiteOidcRelyingParty {
  const cookieSecretBytes = new TextEncoder().encode(options.cookieSecret);
  if (
    cookieSecretBytes.byteLength < 32
    || cookieSecretBytes.byteLength > 1_024
  ) {
    throw new Error("The suite OIDC cookie secret must be 32–1024 bytes.");
  }
  if (!/^[a-z0-9][a-z0-9._-]{0,31}$/u.test(options.receiptKeyVersion)) {
    throw new Error("The suite receipt key version was invalid.");
  }
  if (options.consumer !== "hra" || options.environment !== "production") {
    throw new Error("The HRA suite OIDC configuration was invalid.");
  }
  const siteUrl = HRA_SITE_URL;
  const provider = HRA_SUITE_OIDC_PROVIDER;
  const configuration = {
    callbackUrl: HRA_SUITE_OIDC_CALLBACK_URL,
    clientId: HRA_SUITE_OIDC_CLIENT_ID,
    provider,
    siteUrl,
  } as const;
  const names = cookieNames(siteUrl);
  const fetchImplementation = options.fetch ?? fetch;
  const timeoutMs = options.fetchTimeoutMs ?? FETCH_TIMEOUT_MS;
  if (!safeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 30_000) {
    throw new Error("The suite OIDC fetch timeout must be 100–30000ms.");
  }
  const now = options.now ?? Date.now;
  const randomBytes = options.randomBytes ?? ((length: number) => {
    const value = new Uint8Array(length);
    crypto.getRandomValues(value);
    return value;
  });
  const key = deriveCookieKey(
    options.cookieSecret,
    options.consumer,
    options.environment,
  );

  async function discovery(): Promise<void> {
    const value = await providerJson(
      provider.discoveryEndpoint,
      { headers: { accept: "application/json" }, method: "GET" },
      fetchImplementation,
      timeoutMs,
    );
    if (!validateSuiteOidcDiscovery(value, provider)) {
      throw new Error("The OIDC provider metadata did not match the HRA configuration.");
    }
  }

  async function jwks(): Promise<JSONWebKeySet> {
    const value = await providerJson(
      provider.jwksEndpoint,
      { headers: { accept: "application/json" }, method: "GET" },
      fetchImplementation,
      timeoutMs,
    );
    const parsed = parseJwks(value);
    if (parsed === null) throw new Error("The OIDC JWKS was invalid.");
    return parsed;
  }

  async function tokenRequest(
    body: URLSearchParams,
    requireIdToken: boolean,
  ): Promise<TokenResponse> {
    const value = await providerJson(
      provider.tokenEndpoint,
      {
        body,
        headers: {
          accept: "application/json",
          "content-type": "application/x-www-form-urlencoded",
          origin: provider.issuer,
        },
        method: "POST",
      },
      fetchImplementation,
      timeoutMs,
    );
    const parsed = parseTokenResponse(value, requireIdToken);
    if (parsed === null) throw new Error("The OIDC token response was invalid.");
    return parsed;
  }

  async function revokeRefreshToken(refreshToken: string): Promise<void> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImplementation(
        provider.revocationEndpoint,
        {
          body: new URLSearchParams({
            client_id: configuration.clientId,
            token: refreshToken,
            token_type_hint: "refresh_token",
          }),
          headers: {
            accept: "application/json",
            "content-type": "application/x-www-form-urlencoded",
            origin: provider.issuer,
          },
          method: "POST",
          redirect: "manual",
          signal: controller.signal,
        },
      );
      if (response.status !== 200 || response.headers.has("location")) {
        throw new Error("OIDC refresh-token revocation failed.");
      }
      await consumeBoundedBody(response, 1_024);
    } finally {
      clearTimeout(timeout);
    }
  }

  async function entitlementReceipt(
    accessToken: string,
    suiteAccountId: string,
  ): Promise<SuiteEntitlementReceipt | null> {
    if (!isReceiptConsumer(options.consumer)) return null;
    const value = await providerJson(
      provider.entitlementReceiptEndpoint,
      {
        body: JSON.stringify({
          environment: options.environment,
          keyVersion: options.receiptKeyVersion,
          product: options.consumer,
        }),
        headers: {
          accept: "application/json",
          authorization: `Bearer ${accessToken}`,
          "content-type": "application/json",
        },
        method: "POST",
      },
      fetchImplementation,
      timeoutMs,
    );
    const parsed = parseEntitlementReceipt(
      value,
      options.consumer,
      options.environment,
      options.receiptKeyVersion,
      suiteAccountId,
      now(),
    );
    if (parsed === null) {
      throw new Error("The suite entitlement receipt was invalid.");
    }
    return parsed;
  }

  async function requestIdentityLinkReceipt(
    accessToken: string,
    proof: IdentityLinkReceiptRequest,
    suiteAccountId: string,
  ): Promise<
    | Readonly<{ kind: "receipt"; receipt: SuiteLinkReceipt }>
    | Readonly<{ kind: "rejected"; status: 400 | 401 | 403 | 409 | 410 | 413 }>
  > {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImplementation(
        provider.identityLinkReceiptEndpoint,
        {
          body: JSON.stringify(proof),
          headers: {
            accept: "application/json",
            authorization: `Bearer ${accessToken}`,
            "content-type": "application/json",
          },
          method: "POST",
          redirect: "manual",
          signal: controller.signal,
        },
      );
      if (response.headers.has("location")) {
        throw new Error("Identity-link receipt endpoint redirected.");
      }
      if ([400, 401, 403, 409, 410, 413].includes(response.status)) {
        await consumeBoundedBody(response, 16_384);
        return {
          kind: "rejected",
          status: response.status as 400 | 401 | 403 | 409 | 410 | 413,
        };
      }
      if (response.status !== 200) {
        throw new Error("Identity-link receipt endpoint failed.");
      }
      const value = await readBoundedJson(response, 16_384);
      const receipt = parseIdentityLinkReceipt(
        value,
        proof,
        suiteAccountId,
        now(),
      );
      if (receipt === null) {
        throw new Error("Identity-link receipt was invalid.");
      }
      return { kind: "receipt", receipt };
    } finally {
      clearTimeout(timeout);
    }
  }

  async function loadSession(request: Request): Promise<StoredSession | null> {
    const sealed = requestCookie(request, names.session);
    if (sealed === null) return null;
    return parseSession(
      await unsealCookie(sealed, await key, "session"),
      configuration,
      options.consumer,
      options.environment,
      options.receiptKeyVersion,
      now(),
    );
  }

  async function start(request: Request): Promise<Response> {
    if (!exactRequest(request, siteUrl, "/api/suite-auth/start", "GET")) {
      return failure("OIDC_START_REJECTED", 403);
    }
    const requestUrl = new URL(request.url);
    const returnTo = parseReturnPath(
      requestUrl.searchParams.get("return_to"),
    );
    if (returnTo === null) return failure("OIDC_RETURN_REJECTED", 400);
    const issuedAtMs = now();
    const verifier = randomValue(48, randomBytes);
    const transaction: Transaction = {
      consumer: options.consumer,
      environment: options.environment,
      expiresAtMs: issuedAtMs + TRANSACTION_TTL_MS,
      issuedAtMs,
      nonce: randomValue(32, randomBytes),
      returnTo,
      state: randomValue(32, randomBytes),
      verifier,
      version: 1,
    };
    const authorize = new URL(provider.authorizationEndpoint);
    authorize.searchParams.set("client_id", configuration.clientId);
    authorize.searchParams.set("code_challenge", await sha256Base64Url(verifier));
    authorize.searchParams.set("code_challenge_method", "S256");
    authorize.searchParams.set("nonce", transaction.nonce);
    if (
      true
    ) {
      authorize.searchParams.set("prompt", "login");
    }
    authorize.searchParams.set("redirect_uri", configuration.callbackUrl);
    authorize.searchParams.set("resource", provider.resource);
    authorize.searchParams.set("response_type", "code");
    authorize.searchParams.set(
      "scope",
      true
        ? "openid profile email offline_access"
        : "openid offline_access",
    );
    authorize.searchParams.set("state", transaction.state);
    const sealed = await sealCookie(
      transaction,
      await key,
      "transaction",
      randomBytes,
    );
    return new Response(null, {
      headers: {
        "cache-control": "no-store",
        location: authorize.href,
        "set-cookie": setCookie(
          names.transaction,
          sealed,
          names.secure,
          TRANSACTION_TTL_MS / 1_000,
        ),
      },
      status: 302,
    });
  }

  async function callback(request: Request): Promise<Response> {
    const clear = clearCookie(names.transaction, names.secure);
    if (
      !exactCallbackRequest(request, siteUrl)
    ) {
      return failure("OIDC_CALLBACK_REJECTED", 403, [clear]);
    }
    const sealed = requestCookie(request, names.transaction);
    const transaction = sealed === null
      ? null
      : parseTransaction(
          await unsealCookie(sealed, await key, "transaction"),
          options.consumer,
          options.environment,
          now(),
        );
    if (transaction === null) {
      return failure("OIDC_TRANSACTION_INVALID", 400, [clear]);
    }
    const url = new URL(request.url);
    const states = url.searchParams.getAll("state");
    const codes = url.searchParams.getAll("code");
    const errors = url.searchParams.getAll("error");
    if (
      states.length !== 1
      || states[0] !== transaction.state
      || errors.length > 0
      || codes.length !== 1
      || !boundedString(codes[0], 1, MAX_CODE_BYTES)
    ) {
      return failure("OIDC_CALLBACK_INVALID", 400, [clear]);
    }
    try {
      await discovery();
      const tokens = await tokenRequest(new URLSearchParams({
        client_id: configuration.clientId,
        code: codes[0],
        code_verifier: transaction.verifier,
        grant_type: "authorization_code",
        redirect_uri: configuration.callbackUrl,
        resource: provider.resource,
      }), true);
      if (tokens.idToken === null) {
        return failure("OIDC_TOKEN_INVALID", 502, [clear]);
      }
      const providerKeys = await jwks();
      const identity = await verifiedIdToken({
        configuration,
        expectedNonce: transaction.nonce,
        idToken: tokens.idToken,
        jwks: providerKeys,
        nowMs: now(),
      });
      if (identity === null) {
        return failure("OIDC_TOKEN_INVALID", 502, [clear]);
      }
      const verifiedSession = await verifiedSessionFromAccessToken({
        accessToken: tokens.accessToken,
        configuration,
        environment: options.environment,
        expectedAccountId: identity.suiteAccountId,
        expectedProfile: identity.profile,
        expectedSubject: identity.subject,
        jwks: providerKeys,
        nonce: transaction.nonce,
        nowMs: now(),
        profileTransition: "exact",
        refreshToken: tokens.refreshToken,
      });
      if (verifiedSession === null) {
        return failure("OIDC_TOKEN_INVALID", 502, [clear]);
      }
      const session: StoredSession = {
        ...verifiedSession,
        pendingEntitlementReceipt: await entitlementReceipt(
          tokens.accessToken,
          verifiedSession.suiteAccountId,
        ),
      };
      const sessionCookie = await sealCookie(
        session,
        await key,
        "session",
        randomBytes,
      );
      const headers = new Headers({
        "cache-control": "no-store",
        location: new URL(transaction.returnTo, siteUrl).href,
      });
      headers.append("set-cookie", clear);
      headers.append("set-cookie", setCookie(
        names.session,
        sessionCookie,
        names.secure,
        SESSION_TTL_MS / 1_000,
      ));
      return new Response(null, { headers, status: 302 });
    } catch {
      return failure("OIDC_UPSTREAM_FAILED", 502, [clear]);
    }
  }

  async function currentSession(request: Request): Promise<Response> {
    if (!exactRequest(
      request,
      siteUrl,
      "/api/suite-auth/session",
      "GET",
    )) {
      return failure("OIDC_SESSION_REJECTED", 403);
    }
    const session = await loadSession(request);
    if (session === null) {
      return jsonResponse({ kind: "signed_out" }, 200, [
        clearCookie(names.session, names.secure),
      ]);
    }
    const nowMs = now();
    const view = currentView(session, nowMs);
    return view === null
        || session.accessTokenExpiresAtMs - nowMs
          < SUITE_OIDC_EARLY_REFRESH_WINDOW_MS
      ? jsonResponse({ kind: "refresh_required" }, 200)
      : jsonResponse({ kind: "signed_in", session: view }, 200);
  }

  async function serverSessionState(
    request: Request,
  ): Promise<Readonly<{
    session: StoredSession;
    verifiedEmail: string | null;
    view: SuiteOidcSessionView;
  }> | null> {
    let requestOrigin: string;
    try {
      requestOrigin = new URL(request.url).origin;
    } catch {
      return null;
    }
    const fetchSite = request.headers.get("sec-fetch-site");
    if (
      requestOrigin !== siteUrl
      || (
        fetchSite !== null
        && fetchSite.toLowerCase() !== "same-origin"
      )
    ) {
      return null;
    }
    const session = await loadSession(request);
    const view = session === null ? null : currentView(session, now());
    if (session === null || view === null) return null;
    let verifiedEmail: string | null = null;
    if (
      true
    ) {
      let userInfo: unknown;
      try {
        userInfo = await providerJson(
          provider.userInfoAudience,
          {
            headers: {
              accept: "application/json",
              authorization: `Bearer ${session.accessToken}`,
            },
            method: "GET",
          },
          fetchImplementation,
          timeoutMs,
        );
      } catch {
        return null;
      }
      if (!liveUserInfoMatchesSession(
        userInfo,
        configuration,
        session,
        view,
      )) return null;
      verifiedEmail = verifiedEmailFromUserInfo(userInfo);
    }
    return { session, verifiedEmail, view };
  }

  async function serverAccountSession(
    request: Request,
  ): Promise<SuiteOidcServerAccountSession | null> {
    const state = await serverSessionState(request);
    return state === null
      ? null
      : {
          accessToken: state.session.accessToken,
          accessTokenExpiresAtMs: state.session.accessTokenExpiresAtMs,
          suiteAccountId: state.view.suiteAccountId,
        };
  }

  async function serverSession(
    request: Request,
  ): Promise<SuiteOidcServerSession | null> {
    const state = await serverSessionState(request);
    return state?.view.profileComplete === true
      ? {
          accessToken: state.session.accessToken,
          accessTokenExpiresAtMs: state.session.accessTokenExpiresAtMs,
          suiteAccountId: state.view.suiteAccountId,
          username: state.view.username,
        }
      : null;
  }

  async function serverVerifiedEmail(
    request: Request,
  ): Promise<SuiteOidcServerVerifiedEmail | null> {
    const state = await serverSessionState(request);
    return state === null
        || state.verifiedEmail === null
        || state.view.profileComplete !== true
      ? null
      : {
          accessTokenExpiresAtMs: state.session.accessTokenExpiresAtMs,
          email: state.verifiedEmail,
          suiteAccountId: state.view.suiteAccountId,
          username: state.view.username,
        };
  }

  async function acknowledgeEntitlementReceipt(
    request: Request,
  ): Promise<Response> {
    const clear = clearCookie(names.session, names.secure);
    if (!exactRequest(
      request,
      siteUrl,
      "/api/suite-auth/entitlements/ack",
      "POST",
    )) {
      return failure("OIDC_ENTITLEMENT_ACK_REJECTED", 403);
    }
    const session = await loadSession(request);
    if (session === null) {
      return failure("OIDC_SESSION_INVALID", 401, [clear]);
    }
    let body: unknown;
    try {
      body = await readBoundedRequestJson(request, 512);
    } catch {
      return failure("OIDC_ENTITLEMENT_ACK_INVALID", 400);
    }
    if (
      !isRecord(body)
      || Object.keys(body).length !== 1
      || !boundedString(body["signature"], 43, 43)
      || session.pendingEntitlementReceipt?.signature !== body["signature"]
    ) {
      return failure("OIDC_ENTITLEMENT_ACK_INVALID", 400);
    }
    const updated: StoredSession = {
      ...session,
      pendingEntitlementReceipt: null,
    };
    const sealed = await sealCookie(
      updated,
      await key,
      "session",
      randomBytes,
    );
    return jsonResponse({ acknowledged: true }, 200, [
      setCookie(names.session, sealed, names.secure, SESSION_TTL_MS / 1_000),
    ]);
  }

  async function linkReceipt(request: Request): Promise<Response> {
    if (!exactRequest(
      request,
      siteUrl,
      "/api/suite-auth/link-receipt",
      "POST",
    )) {
      return failure("OIDC_LINK_RECEIPT_REJECTED", 403);
    }
    const session = await loadSession(request);
    if (session === null || session.accessTokenExpiresAtMs <= now()) {
      return failure("OIDC_REFRESH_REQUIRED", 401);
    }
    let value: unknown;
    try {
      value = await readBoundedRequestJson(request, 16_384);
    } catch {
      return failure("OIDC_LINK_PROOF_INVALID", 400);
    }
    const proof = parseIdentityLinkReceiptRequest(
      value,
      options.consumer,
      options.environment,
      now(),
    );
    if (proof === null) {
      return failure("OIDC_LINK_PROOF_INVALID", 400);
    }
    try {
      const result = await requestIdentityLinkReceipt(
        session.accessToken,
        proof,
        session.suiteAccountId,
      );
      return result.kind === "receipt"
        ? jsonResponse({ receipt: result.receipt }, 200)
        : failure("OIDC_LINK_RECEIPT_REJECTED", result.status);
    } catch {
      return failure("OIDC_LINK_RECEIPT_FAILED", 502);
    }
  }

  async function refreshSession(request: Request): Promise<Response> {
    const clear = clearCookie(names.session, names.secure);
    if (!exactRequest(
      request,
      siteUrl,
      "/api/suite-auth/refresh",
      "POST",
    )) {
      return failure("OIDC_REFRESH_REJECTED", 403);
    }
    const session = await loadSession(request);
    if (session === null) {
      return failure("OIDC_SESSION_INVALID", 401, [clear]);
    }
    try {
      await discovery();
      const tokens = await tokenRequest(new URLSearchParams({
        client_id: configuration.clientId,
        grant_type: "refresh_token",
        refresh_token: session.refreshToken,
        resource: provider.resource,
      }), false);
      if (tokens.refreshToken === session.refreshToken) {
        return failure("OIDC_REFRESH_ROTATION_INVALID", 502, [clear]);
      }
      const verifiedRefresh = await verifiedSessionFromAccessToken({
        accessToken: tokens.accessToken,
        configuration,
        environment: options.environment,
        expectedAccountId: session.suiteAccountId,
        expectedProfile: session.profileComplete
          ? {
              profileComplete: true,
              profileRevision: "username-v1",
              username: session.username,
            }
          : {
              profileComplete: false,
              profileRevision: session.profileRevision,
              username: null,
            },
        expectedSubject: session.subject,
        jwks: await jwks(),
        nonce: session.nonce,
        nowMs: now(),
        profileTransition: "forward",
        refreshToken: tokens.refreshToken,
      });
      if (verifiedRefresh === null) {
        return failure("OIDC_REFRESH_TOKEN_INVALID", 502, [clear]);
      }
      const refreshed: StoredSession = {
        ...verifiedRefresh,
        pendingEntitlementReceipt: await entitlementReceipt(
          tokens.accessToken,
          verifiedRefresh.suiteAccountId,
        ),
      };
      const view = currentView(refreshed, now());
      if (view === null) {
        return failure("OIDC_REFRESH_TOKEN_EXPIRED", 502, [clear]);
      }
      const sealed = await sealCookie(
        refreshed,
        await key,
        "session",
        randomBytes,
      );
      return jsonResponse({ kind: "signed_in", session: view }, 200, [
        setCookie(
          names.session,
          sealed,
          names.secure,
          SESSION_TTL_MS / 1_000,
        ),
      ]);
    } catch {
      return failure("OIDC_REFRESH_FAILED", 502, [clear]);
    }
  }

  async function signOut(request: Request): Promise<Response> {
    if (!exactRequest(
      request,
      siteUrl,
      "/api/suite-auth/sign-out",
      "POST",
    )) {
      return failure("OIDC_SIGN_OUT_REJECTED", 403);
    }
    const session = await loadSession(request);
    if (session !== null) {
      try {
        await revokeRefreshToken(session.refreshToken);
      } catch {
        // Local token custody still ends when the provider is unavailable.
      }
    }
    return jsonResponse({ kind: "signed_out" }, 200, [
      clearCookie(names.session, names.secure),
      clearCookie(names.transaction, names.secure),
    ]);
  }

  async function handle(request: Request): Promise<Response> {
    let path: string;
    try {
      path = new URL(request.url).pathname;
    } catch {
      return failure("OIDC_ROUTE_NOT_FOUND", 404);
    }
    if (request.method === "GET") {
      if (path === "/api/suite-auth/start") return await start(request);
      if (path === "/api/suite-auth/callback") return await callback(request);
      if (path === "/api/suite-auth/session") {
        return await currentSession(request);
      }
    }
    if (request.method === "POST") {
      if (path === "/api/suite-auth/refresh") {
        return await refreshSession(request);
      }
      if (path === "/api/suite-auth/sign-out") return await signOut(request);
      if (path === "/api/suite-auth/link-receipt") {
        return await linkReceipt(request);
      }
      if (path === "/api/suite-auth/entitlements/ack") {
        return await acknowledgeEntitlementReceipt(request);
      }
    }
    return failure("OIDC_ROUTE_NOT_FOUND", 404);
  }

  return {
    acknowledgeEntitlementReceipt,
    callback,
    configuration,
    currentSession,
    handle,
    linkReceipt,
    refreshSession,
    serverAccountSession,
    serverSession,
    serverVerifiedEmail,
    signOut,
    start,
  };
}
