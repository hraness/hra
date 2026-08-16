import {
  isHraSuiteIssuableEnvironment,
  productLinkProofMessage,
  parseHraSuiteEnvironment,
  parseHraSuiteProduct,
  suiteEntitlementReceiptMessage,
  suiteLinkReceiptMessage,
  validateProductLinkProof,
  validateSuiteEntitlementReceipt,
  validateSuiteLinkReceipt,
  type HRA_SUITE_PRODUCT,
  type HraSuiteEnvironment,
  type ProductLinkProof,
  type SignedHraSuiteProduct,
  type SuiteEntitlementReceipt,
  type SuiteLinkReceipt,
} from "./suite-account-contracts";

type HraSuiteProduct = typeof HRA_SUITE_PRODUCT;

export type SuiteReceiptKey = Readonly<{
  environment: HraSuiteEnvironment;
  keyVersion: string;
  product: HraSuiteProduct;
  secret: string;
}>;

export type SuiteReceiptKeyring = Readonly<{
  keys: readonly SuiteReceiptKey[];
  version: 1;
}>;

export type SuiteReceiptConfiguration = Readonly<{
  key: SuiteReceiptKey;
  keyring: SuiteReceiptKeyring;
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseSuiteReceiptKeyring(
  value: unknown,
): SuiteReceiptKeyring | null {
  let decoded: unknown = value;
  if (typeof value === "string") {
    if (value.length > 32_768) return null;
    try {
      decoded = JSON.parse(value) as unknown;
    } catch {
      return null;
    }
  }
  if (
    !isRecord(decoded)
    || decoded["version"] !== 1
    || !Array.isArray(decoded["keys"])
    || decoded["keys"].length < 1
    || decoded["keys"].length > 20
  ) {
    return null;
  }
  const keys: SuiteReceiptKey[] = [];
  const identities = new Set<string>();
  for (const rawKey of decoded["keys"]) {
    if (!isRecord(rawKey)) return null;
    const { environment, keyVersion, product, secret } = rawKey;
    const parsedEnvironment = parseHraSuiteEnvironment(environment);
    const parsedProduct = parseHraSuiteProduct(product);
    if (
      !parsedEnvironment.ok
      || !parsedProduct.ok
      || !/^[a-z0-9][a-z0-9._-]{0,31}$/u.test(String(keyVersion))
      || typeof secret !== "string"
      || new TextEncoder().encode(secret).byteLength < 32
      || secret.length > 1_024
    ) {
      return null;
    }
    const identity = `${parsedProduct.value}:${parsedEnvironment.value}:${String(
      keyVersion,
    )}`;
    if (identities.has(identity)) return null;
    identities.add(identity);
    keys.push({
      environment: parsedEnvironment.value,
      keyVersion: String(keyVersion),
      product: parsedProduct.value,
      secret,
    });
  }
  return { keys, version: 1 };
}

/**
 * Select the one active issuance key while retaining prior versions for
 * bounded verification during rotation.
 *
 * The selected key must belong to HRA and the requested active version.
 * Older versions in the same environment remain available for bounded
 * verification during rotation.
 */
export function selectSuiteReceiptConfiguration(
  value: unknown,
  product: HraSuiteProduct,
  activeKeyVersion: unknown,
): SuiteReceiptConfiguration | null {
  if (
    typeof activeKeyVersion !== "string"
    || !/^[a-z0-9][a-z0-9._-]{0,31}$/u.test(activeKeyVersion)
  ) {
    return null;
  }
  const keyring = parseSuiteReceiptKeyring(value);
  if (keyring === null) return null;
  const active = keyring.keys.filter(key =>
    key.product === product
    && key.keyVersion === activeKeyVersion
    && isHraSuiteIssuableEnvironment(key.environment)
  );
  if (active.length !== 1) return null;
  const key = active[0]!;
  const verificationKeys = keyring.keys.filter(candidate =>
    candidate.product === product
    && candidate.environment === key.environment
  );
  return {
    key,
    keyring: { keys: verificationKeys, version: 1 },
  };
}

function keyFor(
  keyring: SuiteReceiptKeyring,
  product: SignedHraSuiteProduct,
  environment: HraSuiteEnvironment,
  keyVersion: string,
): SuiteReceiptKey | null {
  const canonicalProduct = parseHraSuiteProduct(product);
  if (!canonicalProduct.ok) return null;
  return keyring.keys.find(key =>
    key.product === canonicalProduct.value
    && key.environment === environment
    && key.keyVersion === keyVersion
  ) ?? null;
}

function decodeSignature(value: string): Uint8Array<ArrayBuffer> | null {
  if (!/^[A-Za-z0-9_-]{43}$/u.test(value)) return null;
  try {
    const binary = atob(
      value.replaceAll("-", "+").replaceAll("_", "/") + "=",
    );
    const result = new Uint8Array(new ArrayBuffer(binary.length));
    for (let index = 0; index < binary.length; index += 1) {
      result[index] = binary.charCodeAt(index);
    }
    return result.byteLength === 32 ? result : null;
  } catch {
    return null;
  }
}

async function hmac(
  secret: string,
  message: string,
): Promise<ArrayBuffer> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { hash: "SHA-256", name: "HMAC" },
    false,
    ["sign"],
  );
  return await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(message),
  );
}

async function verifySignature(
  secret: string,
  message: string,
  signature: string,
): Promise<boolean> {
  const received = decodeSignature(signature);
  if (received === null) return false;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { hash: "SHA-256", name: "HMAC" },
    false,
    ["verify"],
  );
  return await crypto.subtle.verify(
    "HMAC",
    key,
    received,
    new TextEncoder().encode(message),
  );
}

function encodeBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

export async function signSuiteProductLinkProof(
  proof: ProductLinkProof,
  keyring: SuiteReceiptKeyring,
  nowMs: number,
): Promise<string | null> {
  if (
    validateProductLinkProof(proof, nowMs) !== null
    || !isHraSuiteIssuableEnvironment(proof.environment)
  ) return null;
  const key = keyFor(
    keyring,
    proof.product,
    proof.environment,
    proof.keyVersion,
  );
  return key === null
    ? null
    : encodeBase64Url(
        new Uint8Array(await hmac(key.secret, productLinkProofMessage(proof))),
      );
}

export async function verifySuiteLinkReceiptSignature(
  receipt: SuiteLinkReceipt,
  keyring: SuiteReceiptKeyring,
  nowMs: number,
): Promise<boolean> {
  if (validateSuiteLinkReceipt(receipt, nowMs) !== null) return false;
  const key = keyFor(
    keyring,
    receipt.product,
    receipt.environment,
    receipt.keyVersion,
  );
  return key !== null && await verifySignature(
    key.secret,
    suiteLinkReceiptMessage(receipt),
    receipt.signature,
  );
}

export async function verifySuiteEntitlementReceiptSignature(
  receipt: SuiteEntitlementReceipt,
  keyring: SuiteReceiptKeyring,
  nowMs: number,
): Promise<boolean> {
  if (validateSuiteEntitlementReceipt(receipt, nowMs) !== null) return false;
  const key = keyFor(
    keyring,
    receipt.product,
    receipt.environment,
    receipt.keyVersion,
  );
  return key !== null && await verifySignature(
    key.secret,
    suiteEntitlementReceiptMessage(receipt),
    receipt.signature,
  );
}
