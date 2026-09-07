import {
  canonicalJson,
  createOhSyncBundleV1,
  parseCanonicalJson,
  parseOhOperationV1,
  parseOhSyncBundleV1,
  type OhOperationV1,
  type OhSyncBundleV1,
} from "@hraness/oh";
import {
  createOhStoreBindingV1,
  emptyOhHeadV1,
  OH_CANONICAL_STORE_PROFILE_V1,
  parseOhHeadV1,
  type OhHeadV1,
} from "@hraness/oh/store";

import {
  CANONICAL_MEMORY_ADOPTION_PROOF_PURPOSE,
  CANONICAL_MEMORY_DESCRIPTOR_PURPOSE,
  CANONICAL_MEMORY_GENESIS_TOKEN_PURPOSE,
  CANONICAL_MEMORY_HEAD_TOKEN_PURPOSE,
  CANONICAL_MEMORY_HOSTED_ROUTE_PURPOSE,
  CANONICAL_MEMORY_OPERATION_BUNDLE_PURPOSE,
  CANONICAL_MEMORY_SPACE_KEY_WRAP_PURPOSE,
  CANONICAL_MEMORY_TERMINAL_HEAD_PROOF_PURPOSE,
  canonicalMemoryCiphertextLimits,
  canonicalMemoryPlaintextLimits,
  HRA_CANONICAL_MEMORY_OPERATION_MAX_BYTES,
  parseCanonicalMemoryHostedSpaceId,
} from "../domain/canonical-memory-sync";
import { hasExactKeys, isRecord, snapshotForeignJson } from "../domain/guards";
import {
  isDigest,
  parseEncryptedEnvelope,
  type EncryptedEnvelope,
} from "./contracts";
import {
  decryptBytes,
  encodeBase64Url,
  gcmMessageBudgetPerKey,
  hmacSha256Hex,
  randomKeyBytes,
  sha256Hex,
} from "./crypto";
import {
  parseCanonicalMemoryOperation,
  type CanonicalMemoryOperation,
} from "./memory-sync-contracts";

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const portableCanonicalSpaceIdPattern = /^hra:project:space-[a-f0-9]{32}$/u;

// Kept mechanically coupled to USER_RESOURCE_QUOTAS.device by the focused
// cross-layer contract test. Do not import Convex server code into shipped
// client source merely to share this release constant.
const canonicalMemoryOwnerDeviceQuota = 16;

// NIST's random-nonce bound is shared by every device holding a space key.
// The minus one leaves the aggregate strictly below the 2^31 HRA ceiling.
export const canonicalMemoryGcmMessageBudgetPerDevice = Math.floor(
  (gcmMessageBudgetPerKey - 1) / canonicalMemoryOwnerDeviceQuota,
);

export { parseCanonicalMemoryHostedSpaceId };

export type CanonicalMemorySpaceRoute = Readonly<{
  hostedSpaceId: string;
  keyVersion: number;
}>;

export type CanonicalMemoryBinding = CanonicalMemorySpaceRoute & Readonly<{
  bindingDigest: string;
  canonicalSpaceId: string;
}>;

export type CanonicalMemoryExpectedBinding = Readonly<{
  bindingDigest: string;
  canonicalSpaceId: string;
}>;

export type CanonicalMemorySpaceKeyWrapAuthority = Readonly<{
  accountKeyVersion: number;
  hostedSpaceId: string;
  spaceKeyVersion: number;
}>;

/**
 * Opaque, authority-fenced encryption capability supplied by local cloud
 * custody. Canonical-memory writers deliberately cannot accept raw AES bytes:
 * every encryption must pass through the capability that reserves durable
 * nonce high-water and consumes its owning process's exact message budget.
 */
export type CanonicalMemoryEncryptionKey = Readonly<{
  authenticate(purpose: string, value: string): Promise<string>;
  dispose(): void;
  encrypt(plaintext: Uint8Array, aad: Uint8Array): Promise<EncryptedEnvelope>;
  keyVersion: number;
  usageScope: "account_data" | `space:${string}`;
}>;

export type CanonicalMemoryDescriptorV1 = Readonly<{
  bindingDigest: string;
  bindingPolicy: "one_project_one_space";
  canonicalSpaceId: string;
  identityContract: 2;
  v: 1;
}>;

export type CanonicalMemoryTerminalHeadProofV1 = Readonly<{
  bindingDigest: string;
  canonicalSpaceId: string;
  head: OhHeadV1;
  headToken: string;
  hostedSpaceId: string;
  keyVersion: number;
  sequence: number;
  v: 1;
}>;

export type CanonicalMemoryAdoptionProofV1 = Readonly<{
  bindingDigest: string;
  canonicalSpaceId: string;
  contentDigest: string;
  keyDigest: string;
  operationSha256: string;
  recordSha256: string;
  sequence: number;
  sourceReceiptSha256: string;
  v: 1;
}>;

export type CanonicalMemoryAdoptionProofOperationContext = Pick<
  CanonicalMemoryOperation,
  "genesisToken" | "headToken" | "operation" | "priorToken" | "sequence"
>;

export type CanonicalMemoryAdoptionProofAssessment =
  | Readonly<{ status: "absent" }>
  | Readonly<{ status: "invalid" }>
  | Readonly<{
    /** Authenticated and operation-bound, but not yet checked against local history. */
    proof: CanonicalMemoryAdoptionProofV1;
    status: "unverified";
  }>;

export type DecryptedCanonicalMemoryOperation = Readonly<{
  adoptionProof: CanonicalMemoryAdoptionProofAssessment;
  bundle: OhSyncBundleV1;
  head: OhHeadV1;
  operation: OhOperationV1;
}>;

function reject(reason: string): never {
  throw new Error(`CANONICAL_MEMORY_${reason}`);
}

function safePositiveInteger(value: unknown): value is number {
  return typeof value === "number"
    && Number.isSafeInteger(value)
    && value > 0
    && !Object.is(value, -0);
}

function snapshotRecord(value: unknown): Readonly<Record<string, unknown>> | null {
  const snapshot = snapshotForeignJson(value);
  return snapshot.ok && isRecord(snapshot.value) ? snapshot.value : null;
}

function utf8(value: string): Uint8Array {
  return encoder.encode(value);
}

function utf8ByteLength(value: string): number {
  const bytes = utf8(value);
  try {
    return bytes.byteLength;
  } finally {
    bytes.fill(0);
  }
}

function canonicalAad(value: unknown): Uint8Array {
  return utf8(canonicalJson(value));
}

function sameCanonical(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function parseRoute(value: unknown): CanonicalMemorySpaceRoute | null {
  const record = snapshotRecord(value);
  if (
    record === null
    || !hasExactKeys(record, ["hostedSpaceId", "keyVersion"])
    || parseCanonicalMemoryHostedSpaceId(record.hostedSpaceId) === null
    || !safePositiveInteger(record.keyVersion)
  ) return null;
  return {
    hostedSpaceId: record.hostedSpaceId as string,
    keyVersion: record.keyVersion,
  };
}

function parseExpectedBinding(value: unknown): CanonicalMemoryExpectedBinding | null {
  const record = snapshotRecord(value);
  if (
    record === null
    || !hasExactKeys(record, ["bindingDigest", "canonicalSpaceId"])
    || parsePortableCanonicalMemorySpaceId(record.canonicalSpaceId) === null
    || !isDigest(record.bindingDigest)
    || canonicalMemoryBindingDigest(record.canonicalSpaceId as string) !== record.bindingDigest
  ) return null;
  return {
    bindingDigest: record.bindingDigest,
    canonicalSpaceId: record.canonicalSpaceId as string,
  };
}

function parseBinding(value: unknown): CanonicalMemoryBinding | null {
  const record = snapshotRecord(value);
  if (
    record === null
    || !hasExactKeys(record, [
      "bindingDigest",
      "canonicalSpaceId",
      "hostedSpaceId",
      "keyVersion",
    ])
  ) return null;
  const route = parseRoute({
    hostedSpaceId: record.hostedSpaceId,
    keyVersion: record.keyVersion,
  });
  const binding = parseExpectedBinding({
    bindingDigest: record.bindingDigest,
    canonicalSpaceId: record.canonicalSpaceId,
  });
  return route === null || binding === null ? null : { ...route, ...binding };
}

function parseWrapAuthority(value: unknown): CanonicalMemorySpaceKeyWrapAuthority | null {
  const record = snapshotRecord(value);
  if (
    record === null
    || !hasExactKeys(record, [
      "accountKeyVersion",
      "hostedSpaceId",
      "spaceKeyVersion",
    ])
    || !safePositiveInteger(record.accountKeyVersion)
    || parseCanonicalMemoryHostedSpaceId(record.hostedSpaceId) === null
    || !safePositiveInteger(record.spaceKeyVersion)
  ) return null;
  return {
    accountKeyVersion: record.accountKeyVersion,
    hostedSpaceId: record.hostedSpaceId as string,
    spaceKeyVersion: record.spaceKeyVersion,
  };
}

function parseAdoptionProofOperationContext(
  value: unknown,
  expectedKeyVersion: number,
): CanonicalMemoryAdoptionProofOperationContext | null {
  const record = snapshotRecord(value);
  const contextKeys = [
    "genesisToken",
    "headToken",
    "operation",
    "priorToken",
    "sequence",
  ] as const;
  if (
    record === null
    || (!hasExactKeys(record, contextKeys) && !hasExactKeys(record, [
      "adoptionProof",
      ...contextKeys,
      "terminalHeadProof",
    ]))
    || !isDigest(record.genesisToken)
    || !isDigest(record.headToken)
    || !isDigest(record.priorToken)
    || record.headToken === record.priorToken
    || !safePositiveInteger(record.sequence)
  ) return null;
  const operation = parseEncryptedEnvelope(
    record.operation,
    canonicalMemoryCiphertextLimits.operation,
  );
  if (operation === null || operation.keyVersion !== expectedKeyVersion) return null;
  return {
    genesisToken: record.genesisToken,
    headToken: record.headToken,
    operation,
    priorToken: record.priorToken,
    sequence: record.sequence,
  };
}

function requireSpaceKey(value: unknown): Uint8Array {
  const parsed = parseCanonicalMemorySpaceKey(value);
  return parsed ?? reject("SPACE_KEY_INVALID");
}

function requireEncryptionKey(
  value: unknown,
  expectedKeyVersion: number,
  expectedUsageScope: CanonicalMemoryEncryptionKey["usageScope"],
): CanonicalMemoryEncryptionKey {
  if (
    !isRecord(value)
    || !safePositiveInteger(value.keyVersion)
    || value.keyVersion !== expectedKeyVersion
    || value.usageScope !== expectedUsageScope
    || typeof value.authenticate !== "function"
    || typeof value.dispose !== "function"
    || typeof value.encrypt !== "function"
  ) reject("ENCRYPTION_KEY_INVALID");
  return value as CanonicalMemoryEncryptionKey;
}

function requireEnvelope(
  value: unknown,
  maximumCiphertextCharacters: number,
  keyVersion: number,
): EncryptedEnvelope {
  const snapshot = snapshotForeignJson(value);
  const parsed = snapshot.ok
    ? parseEncryptedEnvelope(snapshot.value, maximumCiphertextCharacters)
    : null;
  if (parsed === null || parsed.keyVersion !== keyVersion) reject("ENVELOPE_INVALID");
  return parsed;
}

async function decryptBounded(
  envelope: unknown,
  key: Uint8Array,
  aad: Uint8Array,
  keyVersion: number,
  maximumCiphertextCharacters: number,
  maximumPlaintextBytes: number,
): Promise<Uint8Array> {
  const parsed = requireEnvelope(envelope, maximumCiphertextCharacters, keyVersion);
  let plaintext: Uint8Array;
  try {
    plaintext = await decryptBytes(parsed, key, aad);
  } catch {
    reject("DECRYPT_FAILED");
  }
  if (plaintext.byteLength > maximumPlaintextBytes) {
    plaintext.fill(0);
    reject("PLAINTEXT_TOO_LARGE");
  }
  return plaintext;
}

function parseCanonicalPlaintext(bytes: Uint8Array, maximumBytes: number): unknown {
  if (bytes.byteLength > maximumBytes) reject("PLAINTEXT_TOO_LARGE");
  try {
    return parseCanonicalJson(decoder.decode(bytes), maximumBytes);
  } catch {
    return reject("PLAINTEXT_INVALID");
  }
}

function parseFullHead(value: unknown): OhHeadV1 | null {
  const snapshot = snapshotForeignJson(value);
  if (!snapshot.ok) return null;
  const head = parseOhHeadV1(snapshot.value);
  return head === null
    || Object.is(head.generation, -0)
    || Object.is(head.sequence, -0)
    ? null
    : head;
}

function requireFullHead(value: unknown): OhHeadV1 {
  return parseFullHead(value) ?? reject("HEAD_INVALID");
}

function requireGenesisHead(value: unknown): OhHeadV1 {
  const head = requireFullHead(value);
  return sameCanonical(head, emptyOhHeadV1()) ? head : reject("GENESIS_HEAD_INVALID");
}

function headFromOperation(operation: OhOperationV1): OhHeadV1 {
  const parsed = parseOhHeadV1({
    generation: operation.sequence,
    graphRevisionSha256: operation.graphRevisionSha256,
    operationSha256: operation.operationSha256,
    recordsSha256: operation.recordsSha256,
    sequence: operation.sequence,
    v: 1,
  });
  return parsed ?? reject("OPERATION_HEAD_INVALID");
}

function descriptorAad(route: CanonicalMemorySpaceRoute): Uint8Array {
  return canonicalAad({
    hostedSpaceId: route.hostedSpaceId,
    keyVersion: route.keyVersion,
    purpose: CANONICAL_MEMORY_DESCRIPTOR_PURPOSE,
    v: 1,
  });
}

function spaceKeyWrapAad(authority: CanonicalMemorySpaceKeyWrapAuthority): Uint8Array {
  return canonicalAad({
    accountKeyVersion: authority.accountKeyVersion,
    hostedSpaceId: authority.hostedSpaceId,
    purpose: CANONICAL_MEMORY_SPACE_KEY_WRAP_PURPOSE,
    spaceKeyVersion: authority.spaceKeyVersion,
    v: 1,
  });
}

function terminalHeadProofAad(
  authority: CanonicalMemoryBinding,
  sequence: number,
  headToken: string,
): Uint8Array {
  return canonicalAad({
    bindingDigest: authority.bindingDigest,
    canonicalSpaceId: authority.canonicalSpaceId,
    headToken,
    hostedSpaceId: authority.hostedSpaceId,
    keyVersion: authority.keyVersion,
    purpose: CANONICAL_MEMORY_TERMINAL_HEAD_PROOF_PURPOSE,
    sequence,
    v: 1,
  });
}

function operationBundleAad(
  authority: CanonicalMemoryBinding,
  operation: Pick<CanonicalMemoryOperation,
    "genesisToken" | "headToken" | "priorToken" | "sequence">,
): Uint8Array {
  return canonicalAad({
    bindingDigest: authority.bindingDigest,
    canonicalSpaceId: authority.canonicalSpaceId,
    genesisToken: operation.genesisToken,
    headToken: operation.headToken,
    hostedSpaceId: authority.hostedSpaceId,
    keyVersion: authority.keyVersion,
    priorToken: operation.priorToken,
    purpose: CANONICAL_MEMORY_OPERATION_BUNDLE_PURPOSE,
    sequence: operation.sequence,
    v: 1,
  });
}

async function adoptionProofAad(
  authority: CanonicalMemoryBinding,
  operation: CanonicalMemoryAdoptionProofOperationContext,
): Promise<Uint8Array> {
  return canonicalAad({
    bindingDigest: authority.bindingDigest,
    canonicalSpaceId: authority.canonicalSpaceId,
    genesisToken: operation.genesisToken,
    headToken: operation.headToken,
    hostedSpaceId: authority.hostedSpaceId,
    keyVersion: authority.keyVersion,
    operationEnvelopeSha256: await sha256Hex(canonicalJson(operation.operation)),
    priorToken: operation.priorToken,
    purpose: CANONICAL_MEMORY_ADOPTION_PROOF_PURPOSE,
    sequence: operation.sequence,
    v: 1,
  });
}

async function deriveHeadToken(
  spaceKey: Uint8Array,
  authority: CanonicalMemoryBinding,
  head: OhHeadV1,
  purpose: string,
): Promise<string> {
  return await hmacSha256Hex(spaceKey, purpose, canonicalJson({
    bindingDigest: authority.bindingDigest,
    canonicalSpaceId: authority.canonicalSpaceId,
    head,
    hostedSpaceId: authority.hostedSpaceId,
    keyVersion: authority.keyVersion,
    v: 1,
  }));
}

async function deriveHeadTokenWithEncryptionKey(
  encryptionKey: CanonicalMemoryEncryptionKey,
  authority: CanonicalMemoryBinding,
  head: OhHeadV1,
  purpose: string,
): Promise<string> {
  return await encryptionKey.authenticate(purpose, canonicalJson({
    bindingDigest: authority.bindingDigest,
    canonicalSpaceId: authority.canonicalSpaceId,
    head,
    hostedSpaceId: authority.hostedSpaceId,
    keyVersion: authority.keyVersion,
    v: 1,
  }));
}

async function tokenForHead(
  spaceKey: Uint8Array,
  authority: CanonicalMemoryBinding,
  head: OhHeadV1,
): Promise<string> {
  return head.sequence === 0
    ? await deriveHeadToken(
        spaceKey,
        authority,
        requireGenesisHead(head),
        CANONICAL_MEMORY_GENESIS_TOKEN_PURPOSE,
      )
    : await deriveHeadToken(
        spaceKey,
        authority,
        head,
        CANONICAL_MEMORY_HEAD_TOKEN_PURPOSE,
      );
}

async function tokenForHeadWithEncryptionKey(
  encryptionKey: CanonicalMemoryEncryptionKey,
  authority: CanonicalMemoryBinding,
  head: OhHeadV1,
): Promise<string> {
  return head.sequence === 0
    ? await deriveHeadTokenWithEncryptionKey(
        encryptionKey,
        authority,
        requireGenesisHead(head),
        CANONICAL_MEMORY_GENESIS_TOKEN_PURPOSE,
      )
    : await deriveHeadTokenWithEncryptionKey(
        encryptionKey,
        authority,
        head,
        CANONICAL_MEMORY_HEAD_TOKEN_PURPOSE,
      );
}

export function parsePortableCanonicalMemorySpaceId(value: unknown): string | null {
  return typeof value === "string" && portableCanonicalSpaceIdPattern.test(value)
    ? value
    : null;
}

/**
 * Derives the single owner-scoped hosted route for a portable canonical
 * identity. The portable ID supplies stable secret entropy while the account
 * binding already commits to the canonical deployment and opaque account ID.
 * Neither account-key rotation nor device/auth generation can move the route.
 */
export async function deriveCanonicalMemoryHostedSpaceId(input: Readonly<{
  accountBindingDigest: string;
  canonicalSpaceId: string;
}>): Promise<string> {
  if (!isDigest(input.accountBindingDigest)) reject("ACCOUNT_BINDING_INVALID");
  const canonicalSpaceId = parsePortableCanonicalMemorySpaceId(input.canonicalSpaceId)
    ?? reject("PORTABLE_SPACE_ID_INVALID");
  const bindingDigest = canonicalMemoryBindingDigest(canonicalSpaceId);
  const routeKey = Uint8Array.from(
    (await sha256Hex(`hra-canonical-memory-route-key:v1:${canonicalSpaceId}`))
      .match(/../gu) ?? [],
    (byte) => Number.parseInt(byte, 16),
  );
  try {
    const digest = await hmacSha256Hex(
      routeKey,
      CANONICAL_MEMORY_HOSTED_ROUTE_PURPOSE,
      canonicalJson({
        accountBindingDigest: input.accountBindingDigest,
        bindingDigest,
        bindingPolicy: "one_project_one_space",
        canonicalSpaceId,
        identityContract: 2,
        v: 1,
      }),
    );
    const routeBytes = Uint8Array.from(
      digest.slice(0, 48).match(/../gu) ?? [],
      (byte) => Number.parseInt(byte, 16),
    );
    const hostedSpaceId = `memory_${encodeBase64Url(routeBytes)}`;
    return parseCanonicalMemoryHostedSpaceId(hostedSpaceId)
      ?? reject("HOSTED_SPACE_ID_GENERATION_FAILED");
  } finally {
    routeKey.fill(0);
  }
}

export function generateCanonicalMemorySpaceKey(): Uint8Array {
  return randomKeyBytes();
}

export function parseCanonicalMemorySpaceKey(value: unknown): Uint8Array | null {
  try {
    if (
      !(value instanceof Uint8Array)
      || Object.getPrototypeOf(value) !== Uint8Array.prototype
      || value.byteLength !== 32
    ) return null;
    return Uint8Array.from(value);
  } catch {
    return null;
  }
}

export function canonicalMemoryBindingDigest(canonicalSpaceId: string): string {
  const parsed = parsePortableCanonicalMemorySpaceId(canonicalSpaceId);
  if (parsed === null) reject("PORTABLE_SPACE_ID_INVALID");
  const identitySuffix = parsed.slice("hra:project:".length);
  return createOhStoreBindingV1({
    profile: OH_CANONICAL_STORE_PROFILE_V1,
    realmId: `hra:project-memory:${identitySuffix}`,
    spaceId: parsed,
    v: 1,
  }).bindingSha256;
}

export function parseCanonicalMemoryDescriptorV1(
  value: unknown,
): CanonicalMemoryDescriptorV1 | null {
  const record = snapshotRecord(value);
  if (
    record === null
    || !hasExactKeys(record, [
      "bindingDigest",
      "bindingPolicy",
      "canonicalSpaceId",
      "identityContract",
      "v",
    ])
    || record.bindingPolicy !== "one_project_one_space"
    || record.identityContract !== 2
    || record.v !== 1
    || parsePortableCanonicalMemorySpaceId(record.canonicalSpaceId) === null
    || !isDigest(record.bindingDigest)
    || canonicalMemoryBindingDigest(record.canonicalSpaceId as string) !== record.bindingDigest
  ) return null;
  return {
    bindingDigest: record.bindingDigest,
    bindingPolicy: record.bindingPolicy,
    canonicalSpaceId: record.canonicalSpaceId as string,
    identityContract: record.identityContract,
    v: record.v,
  };
}

export function parseCanonicalMemoryAdoptionProofV1(
  value: unknown,
): CanonicalMemoryAdoptionProofV1 | null {
  const record = snapshotRecord(value);
  if (
    record === null
    || !hasExactKeys(record, [
      "bindingDigest",
      "canonicalSpaceId",
      "contentDigest",
      "keyDigest",
      "operationSha256",
      "recordSha256",
      "sequence",
      "sourceReceiptSha256",
      "v",
    ])
    || !isDigest(record.bindingDigest)
    || parsePortableCanonicalMemorySpaceId(record.canonicalSpaceId) === null
    || canonicalMemoryBindingDigest(record.canonicalSpaceId as string) !== record.bindingDigest
    || !isDigest(record.contentDigest)
    || !isDigest(record.keyDigest)
    || !isDigest(record.operationSha256)
    || !isDigest(record.recordSha256)
    || !safePositiveInteger(record.sequence)
    || !isDigest(record.sourceReceiptSha256)
    || record.v !== 1
  ) return null;
  return {
    bindingDigest: record.bindingDigest,
    canonicalSpaceId: record.canonicalSpaceId as string,
    contentDigest: record.contentDigest,
    keyDigest: record.keyDigest,
    operationSha256: record.operationSha256,
    recordSha256: record.recordSha256,
    sequence: record.sequence,
    sourceReceiptSha256: record.sourceReceiptSha256,
    v: record.v,
  };
}

export async function encryptCanonicalMemoryAdoptionProof(input: Readonly<{
  authority: CanonicalMemoryBinding;
  encryptionKey: CanonicalMemoryEncryptionKey;
  operation: CanonicalMemoryAdoptionProofOperationContext;
  proof: CanonicalMemoryAdoptionProofV1;
}>): Promise<EncryptedEnvelope> {
  const authority = parseBinding(input.authority) ?? reject("BINDING_INVALID");
  const encryptionKey = requireEncryptionKey(
    input.encryptionKey,
    authority.keyVersion,
    `space:${authority.hostedSpaceId}`,
  );
  const operation = parseAdoptionProofOperationContext(
    input.operation,
    authority.keyVersion,
  ) ?? reject("ADOPTION_PROOF_CONTEXT_INVALID");
  const proof = parseCanonicalMemoryAdoptionProofV1(input.proof)
    ?? reject("ADOPTION_PROOF_INVALID");
  if (
    proof.bindingDigest !== authority.bindingDigest
    || proof.canonicalSpaceId !== authority.canonicalSpaceId
    || proof.sequence !== operation.sequence
  ) reject("ADOPTION_PROOF_MISMATCH");
  const plaintext = utf8(canonicalJson(proof));
  if (plaintext.byteLength > canonicalMemoryPlaintextLimits.adoptionProof) {
    plaintext.fill(0);
    reject("ADOPTION_PROOF_TOO_LARGE");
  }
  try {
    const encrypted = await encryptionKey.encrypt(
      plaintext,
      await adoptionProofAad(authority, operation),
    );
    if (parseEncryptedEnvelope(
      encrypted,
      canonicalMemoryCiphertextLimits.adoptionProof,
    ) === null) reject("HOSTED_ENVELOPE_LIMIT_EXCEEDED");
    return encrypted;
  } finally {
    plaintext.fill(0);
  }
}

export async function decryptCanonicalMemoryAdoptionProof(input: Readonly<{
  authority: CanonicalMemoryBinding;
  envelope: unknown;
  expectedOperationSha256: string;
  operation: CanonicalMemoryAdoptionProofOperationContext;
  spaceKey: Uint8Array;
}>): Promise<CanonicalMemoryAdoptionProofV1> {
  const authority = parseBinding(input.authority) ?? reject("BINDING_INVALID");
  const operation = parseAdoptionProofOperationContext(
    input.operation,
    authority.keyVersion,
  ) ?? reject("ADOPTION_PROOF_CONTEXT_INVALID");
  if (!isDigest(input.expectedOperationSha256)) {
    reject("ADOPTION_PROOF_EXPECTATION_INVALID");
  }
  const spaceKey = requireSpaceKey(input.spaceKey);
  let plaintext: Uint8Array | undefined;
  try {
    plaintext = await decryptBounded(
      input.envelope,
      spaceKey,
      await adoptionProofAad(authority, operation),
      authority.keyVersion,
      canonicalMemoryCiphertextLimits.adoptionProof,
      canonicalMemoryPlaintextLimits.adoptionProof,
    );
    const proof = parseCanonicalMemoryAdoptionProofV1(
      parseCanonicalPlaintext(plaintext, canonicalMemoryPlaintextLimits.adoptionProof),
    );
    if (
      proof === null
      || proof.bindingDigest !== authority.bindingDigest
      || proof.canonicalSpaceId !== authority.canonicalSpaceId
      || proof.sequence !== operation.sequence
      || proof.operationSha256 !== input.expectedOperationSha256
    ) reject("ADOPTION_PROOF_INVALID");
    return proof;
  } finally {
    plaintext?.fill(0);
    spaceKey.fill(0);
  }
}

export async function wrapCanonicalMemorySpaceKey(input: Readonly<{
  authority: CanonicalMemorySpaceKeyWrapAuthority;
  encryptionKey: CanonicalMemoryEncryptionKey;
  spaceKey: Uint8Array;
}>): Promise<EncryptedEnvelope> {
  const authority = parseWrapAuthority(input.authority)
    ?? reject("SPACE_KEY_WRAP_AUTHORITY_INVALID");
  const encryptionKey = requireEncryptionKey(
    input.encryptionKey,
    authority.accountKeyVersion,
    "account_data",
  );
  const spaceKey = requireSpaceKey(input.spaceKey);
  try {
    return await encryptionKey.encrypt(
      spaceKey,
      spaceKeyWrapAad(authority),
    );
  } finally {
    spaceKey.fill(0);
  }
}

export async function unwrapCanonicalMemorySpaceKey(input: Readonly<{
  accountKey: Uint8Array;
  authority: CanonicalMemorySpaceKeyWrapAuthority;
  envelope: unknown;
}>): Promise<Uint8Array> {
  const authority = parseWrapAuthority(input.authority)
    ?? reject("SPACE_KEY_WRAP_AUTHORITY_INVALID");
  const accountKey = requireSpaceKey(input.accountKey);
  let plaintext: Uint8Array | undefined;
  try {
    plaintext = await decryptBounded(
      input.envelope,
      accountKey,
      spaceKeyWrapAad(authority),
      authority.accountKeyVersion,
      canonicalMemoryCiphertextLimits.terminalHeadProof,
      32,
    );
    return requireSpaceKey(plaintext);
  } finally {
    plaintext?.fill(0);
    accountKey.fill(0);
  }
}

export async function encryptCanonicalMemoryDescriptor(input: Readonly<{
  authority: CanonicalMemoryBinding;
  encryptionKey: CanonicalMemoryEncryptionKey;
}>): Promise<EncryptedEnvelope> {
  const authority = parseBinding(input.authority) ?? reject("BINDING_INVALID");
  const encryptionKey = requireEncryptionKey(
    input.encryptionKey,
    authority.keyVersion,
    `space:${authority.hostedSpaceId}`,
  );
  const descriptor: CanonicalMemoryDescriptorV1 = {
    bindingDigest: authority.bindingDigest,
    bindingPolicy: "one_project_one_space",
    canonicalSpaceId: authority.canonicalSpaceId,
    identityContract: 2,
    v: 1,
  };
  const plaintext = utf8(canonicalJson(descriptor));
  if (plaintext.byteLength > canonicalMemoryPlaintextLimits.descriptor) {
    plaintext.fill(0);
    reject("DESCRIPTOR_TOO_LARGE");
  }
  try {
    return await encryptionKey.encrypt(
      plaintext,
      descriptorAad(authority),
    );
  } finally {
    plaintext.fill(0);
  }
}

export async function decryptCanonicalMemoryDescriptor(input: Readonly<{
  authority: CanonicalMemorySpaceRoute;
  envelope: unknown;
  expectedBinding?: CanonicalMemoryExpectedBinding;
  spaceKey: Uint8Array;
}>): Promise<CanonicalMemoryDescriptorV1> {
  const authority = parseRoute(input.authority) ?? reject("ROUTE_INVALID");
  const spaceKey = requireSpaceKey(input.spaceKey);
  let plaintext: Uint8Array | undefined;
  try {
    plaintext = await decryptBounded(
      input.envelope,
      spaceKey,
      descriptorAad(authority),
      authority.keyVersion,
      canonicalMemoryCiphertextLimits.terminalHeadProof,
      canonicalMemoryPlaintextLimits.descriptor,
    );
    const descriptor = parseCanonicalMemoryDescriptorV1(
      parseCanonicalPlaintext(plaintext, canonicalMemoryPlaintextLimits.descriptor),
    );
    if (descriptor === null) reject("DESCRIPTOR_INVALID");
    if (input.expectedBinding !== undefined) {
      const expected = parseExpectedBinding(input.expectedBinding)
        ?? reject("EXPECTED_BINDING_INVALID");
      if (
        descriptor.canonicalSpaceId !== expected.canonicalSpaceId
        || descriptor.bindingDigest !== expected.bindingDigest
      ) reject("BINDING_MISMATCH");
    }
    return descriptor;
  } finally {
    plaintext?.fill(0);
    spaceKey.fill(0);
  }
}

export async function deriveCanonicalMemoryGenesisToken(input: Readonly<{
  authority: CanonicalMemoryBinding;
  head: OhHeadV1;
  spaceKey: Uint8Array;
}>): Promise<string> {
  const authority = parseBinding(input.authority) ?? reject("BINDING_INVALID");
  const head = requireGenesisHead(input.head);
  const spaceKey = requireSpaceKey(input.spaceKey);
  try {
    return await deriveHeadToken(
      spaceKey,
      authority,
      head,
      CANONICAL_MEMORY_GENESIS_TOKEN_PURPOSE,
    );
  } finally {
    spaceKey.fill(0);
  }
}

export async function deriveCanonicalMemoryHeadToken(input: Readonly<{
  authority: CanonicalMemoryBinding;
  head: OhHeadV1;
  spaceKey: Uint8Array;
}>): Promise<string> {
  const authority = parseBinding(input.authority) ?? reject("BINDING_INVALID");
  const head = requireFullHead(input.head);
  const spaceKey = requireSpaceKey(input.spaceKey);
  try {
    if (head.sequence === 0) reject("HEAD_NOT_ADVANCED");
    return await deriveHeadToken(
      spaceKey,
      authority,
      head,
      CANONICAL_MEMORY_HEAD_TOKEN_PURPOSE,
    );
  } finally {
    spaceKey.fill(0);
  }
}

function parseTerminalHeadProof(value: unknown): CanonicalMemoryTerminalHeadProofV1 | null {
  const record = snapshotRecord(value);
  if (
    record === null
    || !hasExactKeys(record, [
      "bindingDigest",
      "canonicalSpaceId",
      "head",
      "headToken",
      "hostedSpaceId",
      "keyVersion",
      "sequence",
      "v",
    ])
    || !isDigest(record.bindingDigest)
    || parsePortableCanonicalMemorySpaceId(record.canonicalSpaceId) === null
    || canonicalMemoryBindingDigest(record.canonicalSpaceId as string) !== record.bindingDigest
    || !isDigest(record.headToken)
    || parseCanonicalMemoryHostedSpaceId(record.hostedSpaceId) === null
    || !safePositiveInteger(record.keyVersion)
    || typeof record.sequence !== "number"
    || !Number.isSafeInteger(record.sequence)
    || record.sequence < 0
    || Object.is(record.sequence, -0)
    || record.v !== 1
  ) return null;
  const head = parseFullHead(record.head);
  if (head === null || head.sequence !== record.sequence) return null;
  return {
    bindingDigest: record.bindingDigest,
    canonicalSpaceId: record.canonicalSpaceId as string,
    head,
    headToken: record.headToken,
    hostedSpaceId: record.hostedSpaceId as string,
    keyVersion: record.keyVersion,
    sequence: record.sequence,
    v: record.v,
  };
}

export async function encryptCanonicalMemoryTerminalHeadProof(input: Readonly<{
  authority: CanonicalMemoryBinding;
  encryptionKey: CanonicalMemoryEncryptionKey;
  head: OhHeadV1;
  headToken: string;
}>): Promise<EncryptedEnvelope> {
  const authority = parseBinding(input.authority) ?? reject("BINDING_INVALID");
  const head = requireFullHead(input.head);
  const encryptionKey = requireEncryptionKey(
    input.encryptionKey,
    authority.keyVersion,
    `space:${authority.hostedSpaceId}`,
  );
  const expectedToken = await tokenForHeadWithEncryptionKey(encryptionKey, authority, head);
  if (!isDigest(input.headToken) || input.headToken !== expectedToken) {
    reject("HEAD_TOKEN_MISMATCH");
  }
  const proof: CanonicalMemoryTerminalHeadProofV1 = {
    bindingDigest: authority.bindingDigest,
    canonicalSpaceId: authority.canonicalSpaceId,
    head,
    headToken: input.headToken,
    hostedSpaceId: authority.hostedSpaceId,
    keyVersion: authority.keyVersion,
    sequence: head.sequence,
    v: 1,
  };
  const plaintext = utf8(canonicalJson(proof));
  if (plaintext.byteLength > canonicalMemoryPlaintextLimits.terminalHeadProof) {
    plaintext.fill(0);
    reject("HEAD_PROOF_TOO_LARGE");
  }
  try {
    return await encryptionKey.encrypt(
      plaintext,
      terminalHeadProofAad(authority, head.sequence, input.headToken),
    );
  } finally {
    plaintext.fill(0);
  }
}

export async function decryptCanonicalMemoryTerminalHeadProof(input: Readonly<{
  authority: CanonicalMemoryBinding;
  envelope: unknown;
  expectedHead?: OhHeadV1;
  expectedHeadToken: string;
  expectedSequence: number;
  spaceKey: Uint8Array;
}>): Promise<CanonicalMemoryTerminalHeadProofV1> {
  const authority = parseBinding(input.authority) ?? reject("BINDING_INVALID");
  const spaceKey = requireSpaceKey(input.spaceKey);
  let plaintext: Uint8Array | undefined;
  try {
    if (
      !isDigest(input.expectedHeadToken)
      || !Number.isSafeInteger(input.expectedSequence)
      || input.expectedSequence < 0
      || Object.is(input.expectedSequence, -0)
    ) reject("HEAD_EXPECTATION_INVALID");
    const expectedHead = input.expectedHead === undefined
      ? null
      : requireFullHead(input.expectedHead);
    if (expectedHead !== null && expectedHead.sequence !== input.expectedSequence) {
      reject("HEAD_EXPECTATION_INVALID");
    }
    plaintext = await decryptBounded(
      input.envelope,
      spaceKey,
      terminalHeadProofAad(authority, input.expectedSequence, input.expectedHeadToken),
      authority.keyVersion,
      canonicalMemoryCiphertextLimits.terminalHeadProof,
      canonicalMemoryPlaintextLimits.terminalHeadProof,
    );
    const proof = parseTerminalHeadProof(
      parseCanonicalPlaintext(plaintext, canonicalMemoryPlaintextLimits.terminalHeadProof),
    );
    if (
      proof === null
      || proof.bindingDigest !== authority.bindingDigest
      || proof.canonicalSpaceId !== authority.canonicalSpaceId
      || proof.hostedSpaceId !== authority.hostedSpaceId
      || proof.keyVersion !== authority.keyVersion
      || proof.sequence !== input.expectedSequence
      || proof.headToken !== input.expectedHeadToken
    ) reject("HEAD_PROOF_INVALID");
    const derivedToken = await tokenForHead(spaceKey, authority, proof.head);
    if (
      derivedToken !== input.expectedHeadToken
      || (expectedHead !== null && !sameCanonical(proof.head, expectedHead))
    ) reject("HEAD_PROOF_INVALID");
    return proof;
  } finally {
    plaintext?.fill(0);
    spaceKey.fill(0);
  }
}

export async function encryptCanonicalMemoryOperation(input: Readonly<{
  authority: CanonicalMemoryBinding;
  encryptionKey: CanonicalMemoryEncryptionKey;
  genesisHead: OhHeadV1;
  operation: OhOperationV1;
  priorHead: OhHeadV1;
}>): Promise<CanonicalMemoryOperation> {
  const authority = parseBinding(input.authority) ?? reject("BINDING_INVALID");
  const genesisHead = requireGenesisHead(input.genesisHead);
  const priorHead = requireFullHead(input.priorHead);
  const encryptionKey = requireEncryptionKey(
    input.encryptionKey,
    authority.keyVersion,
    `space:${authority.hostedSpaceId}`,
  );
  let operation: OhOperationV1 | null = null;
  try {
    operation = parseOhOperationV1(input.operation);
  } catch {
    operation = null;
  }
  if (
    operation === null
    || operation.spaceId !== authority.canonicalSpaceId
    || operation.sequence !== priorHead.sequence + 1
    || operation.parentOperationSha256 !== priorHead.operationSha256
  ) reject("OPERATION_INVALID");
  const operationBytes = utf8ByteLength(canonicalJson(operation));
  if (operationBytes > HRA_CANONICAL_MEMORY_OPERATION_MAX_BYTES) {
    reject("OPERATION_TOO_LARGE");
  }
  const head = headFromOperation(operation);
  const genesisToken = await tokenForHeadWithEncryptionKey(
    encryptionKey,
    authority,
    genesisHead,
  );
  const priorToken = await tokenForHeadWithEncryptionKey(
    encryptionKey,
    authority,
    priorHead,
  );
  const headToken = await tokenForHeadWithEncryptionKey(
    encryptionKey,
    authority,
    head,
  );
  const wireContext = {
    genesisToken,
    headToken,
    priorToken,
    sequence: operation.sequence,
  } as const;
  let bundle: OhSyncBundleV1;
  try {
    bundle = createOhSyncBundleV1(authority.canonicalSpaceId, [operation]);
  } catch {
    return reject("OPERATION_BUNDLE_INVALID");
  }
  const plaintext = utf8(canonicalJson(bundle));
  if (plaintext.byteLength > canonicalMemoryPlaintextLimits.operationBundle) {
    plaintext.fill(0);
    reject("OPERATION_BUNDLE_TOO_LARGE");
  }
  let encryptedOperation: EncryptedEnvelope;
  try {
    encryptedOperation = await encryptionKey.encrypt(
      plaintext,
      operationBundleAad(authority, wireContext),
    );
  } finally {
    plaintext.fill(0);
  }
  const terminalHeadProof = await encryptCanonicalMemoryTerminalHeadProof({
    authority,
    encryptionKey,
    head,
    headToken,
  });
  if (
    parseEncryptedEnvelope(
      encryptedOperation,
      canonicalMemoryCiphertextLimits.operation,
    ) === null
    || parseEncryptedEnvelope(
      terminalHeadProof,
      canonicalMemoryCiphertextLimits.terminalHeadProof,
    ) === null
  ) reject("HOSTED_ENVELOPE_LIMIT_EXCEEDED");
  return {
    adoptionProof: null,
    ...wireContext,
    operation: encryptedOperation,
    terminalHeadProof,
  };
}

export async function decryptCanonicalMemoryOperation(input: Readonly<{
  authority: CanonicalMemoryBinding;
  expectedGenesisHead: OhHeadV1;
  expectedPriorHead: OhHeadV1;
  operation: unknown;
  spaceKey: Uint8Array;
}>): Promise<DecryptedCanonicalMemoryOperation> {
  const authority = parseBinding(input.authority) ?? reject("BINDING_INVALID");
  const expectedGenesisHead = requireGenesisHead(input.expectedGenesisHead);
  const expectedPriorHead = requireFullHead(input.expectedPriorHead);
  const spaceKey = requireSpaceKey(input.spaceKey);
  let plaintext: Uint8Array | undefined;
  try {
    const wire = parseCanonicalMemoryOperation(input.operation);
    if (
      wire === null
      || wire.operation.keyVersion !== authority.keyVersion
      || wire.terminalHeadProof.keyVersion !== authority.keyVersion
      || wire.sequence !== expectedPriorHead.sequence + 1
    ) reject("WIRE_OPERATION_INVALID");
    const expectedGenesisToken = await tokenForHead(
      spaceKey,
      authority,
      expectedGenesisHead,
    );
    const expectedPriorToken = await tokenForHead(
      spaceKey,
      authority,
      expectedPriorHead,
    );
    if (
      wire.genesisToken !== expectedGenesisToken
      || wire.priorToken !== expectedPriorToken
    ) reject("WIRE_HEAD_MISMATCH");
    plaintext = await decryptBounded(
      wire.operation,
      spaceKey,
      operationBundleAad(authority, wire),
      authority.keyVersion,
      canonicalMemoryCiphertextLimits.operation,
      canonicalMemoryPlaintextLimits.operationBundle,
    );
    const decoded = parseCanonicalPlaintext(
      plaintext,
      canonicalMemoryPlaintextLimits.operationBundle,
    );
    const bundle = parseOhSyncBundleV1(decoded);
    const operation = bundle?.operations[0];
    if (
      bundle === null
      || bundle.spaceId !== authority.canonicalSpaceId
      || bundle.operations.length !== 1
      || operation === undefined
      || operation.spaceId !== authority.canonicalSpaceId
      || operation.sequence !== wire.sequence
      || operation.parentOperationSha256 !== expectedPriorHead.operationSha256
      || utf8ByteLength(canonicalJson(operation)) > HRA_CANONICAL_MEMORY_OPERATION_MAX_BYTES
    ) reject("OPERATION_BUNDLE_INVALID");
    const head = headFromOperation(operation);
    const expectedHeadToken = await tokenForHead(spaceKey, authority, head);
    if (wire.headToken !== expectedHeadToken) reject("WIRE_HEAD_MISMATCH");
    await decryptCanonicalMemoryTerminalHeadProof({
      authority,
      envelope: wire.terminalHeadProof,
      expectedHead: head,
      expectedHeadToken,
      expectedSequence: head.sequence,
      spaceKey,
    });
    let adoptionProof: CanonicalMemoryAdoptionProofAssessment = { status: "absent" };
    if (wire.adoptionProof !== null) {
      try {
        adoptionProof = {
          proof: await decryptCanonicalMemoryAdoptionProof({
            authority,
            envelope: wire.adoptionProof,
            expectedOperationSha256: operation.operationSha256,
            operation: wire,
            spaceKey,
          }),
          status: "unverified",
        };
      } catch {
        adoptionProof = { status: "invalid" };
      }
    }
    return { adoptionProof, bundle, head, operation };
  } finally {
    plaintext?.fill(0);
    spaceKey.fill(0);
  }
}
