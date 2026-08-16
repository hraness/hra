import {
  taskWorkspaceMutationSemanticKey,
  type TaskWorkspaceMutationSemanticInput,
} from "@hraness/agent-tasks-domain";

import {
  decodeBase64Url32,
  decodeCanonicalKey,
  digestArrayBuffer,
  hmacSha256Base64Url,
  sha256Base64Url,
  verifyHmacSha256,
} from "./crypto";
import { resolveHraEnvironmentValue } from "./hraEnvironment";

const CLIENT_FINGERPRINT_PATTERN = /^sha256_[A-Za-z0-9_-]{43}$/u;
const KEY_VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;

export const OPAQUE_HOSTED_MUTATION_FINGERPRINT_PATTERN =
  /^hmac_sha256_[A-Za-z0-9_-]{43}$/u;

export type HostedMutationFingerprintKey = Readonly<{
  key: string;
  version: string;
}>;

export type HostedMutationFingerprintKeyring = Readonly<{
  current: HostedMutationFingerprintKey;
  previous: HostedMutationFingerprintKey | null;
}>;

export type HostedMutationFingerprintEnvironment = Readonly<{
  HRA_HOSTED_MUTATION_FINGERPRINT_KEY_CURRENT?: string | undefined;
  HRA_HOSTED_MUTATION_FINGERPRINT_KEY_CURRENT_VERSION?: string | undefined;
  HRA_HOSTED_MUTATION_FINGERPRINT_KEY_PREVIOUS?: string | undefined;
  HRA_HOSTED_MUTATION_FINGERPRINT_KEY_PREVIOUS_VERSION?: string | undefined;
  OPRTE_HOSTED_MUTATION_FINGERPRINT_KEY_CURRENT?: string | undefined;
  OPRTE_HOSTED_MUTATION_FINGERPRINT_KEY_CURRENT_VERSION?: string | undefined;
  OPRTE_HOSTED_MUTATION_FINGERPRINT_KEY_PREVIOUS?: string | undefined;
  OPRTE_HOSTED_MUTATION_FINGERPRINT_KEY_PREVIOUS_VERSION?: string | undefined;
}>;

export type HostedMutationFingerprintScope = Readonly<{
  organizationId: string;
  principalId: string;
  workspaceId: string;
  sourceId: string;
}>;

export type OpaqueHostedMutationFingerprint = Readonly<{
  fingerprint: string;
  fingerprintKeyVersion: string;
}>;

function validKey(key: string | undefined): key is string {
  return key !== undefined && decodeCanonicalKey(key) !== null;
}

function validVersion(version: string | undefined): version is string {
  return version !== undefined && KEY_VERSION_PATTERN.test(version);
}

/**
 * Parses one active 32-byte canonical key and, during a bounded rotation,
 * exactly one previous key. Invalid or half-configured keyrings fail closed.
 */
export function parseHostedMutationFingerprintKeyring(
  environment: HostedMutationFingerprintEnvironment,
): HostedMutationFingerprintKeyring | null {
  const resolvedCurrentKey = resolveHraEnvironmentValue(
    environment.HRA_HOSTED_MUTATION_FINGERPRINT_KEY_CURRENT,
    environment.OPRTE_HOSTED_MUTATION_FINGERPRINT_KEY_CURRENT,
  );
  const resolvedCurrentVersion = resolveHraEnvironmentValue(
    environment.HRA_HOSTED_MUTATION_FINGERPRINT_KEY_CURRENT_VERSION,
    environment.OPRTE_HOSTED_MUTATION_FINGERPRINT_KEY_CURRENT_VERSION,
  );
  const resolvedPreviousKey = resolveHraEnvironmentValue(
    environment.HRA_HOSTED_MUTATION_FINGERPRINT_KEY_PREVIOUS,
    environment.OPRTE_HOSTED_MUTATION_FINGERPRINT_KEY_PREVIOUS,
  );
  const resolvedPreviousVersion = resolveHraEnvironmentValue(
    environment.HRA_HOSTED_MUTATION_FINGERPRINT_KEY_PREVIOUS_VERSION,
    environment.OPRTE_HOSTED_MUTATION_FINGERPRINT_KEY_PREVIOUS_VERSION,
  );
  if (
    resolvedCurrentKey.kind === "conflict" ||
    resolvedCurrentVersion.kind === "conflict" ||
    resolvedPreviousKey.kind === "conflict" ||
    resolvedPreviousVersion.kind === "conflict"
  ) {
    return null;
  }
  const currentKey = resolvedCurrentKey.kind === "value"
    ? resolvedCurrentKey.value
    : undefined;
  const currentVersion = resolvedCurrentVersion.kind === "value"
    ? resolvedCurrentVersion.value
    : undefined;
  if (!validKey(currentKey) || !validVersion(currentVersion)) return null;

  const previousKey = resolvedPreviousKey.kind === "value"
    ? resolvedPreviousKey.value
    : undefined;
  const previousVersion = resolvedPreviousVersion.kind === "value"
    ? resolvedPreviousVersion.value
    : undefined;
  if (previousKey === undefined && previousVersion === undefined) {
    return {
      current: { key: currentKey, version: currentVersion },
      previous: null,
    };
  }
  if (
    !validKey(previousKey) ||
    !validVersion(previousVersion) ||
    previousKey === currentKey ||
    previousVersion === currentVersion
  ) {
    return null;
  }
  return {
    current: { key: currentKey, version: currentVersion },
    previous: { key: previousKey, version: previousVersion },
  };
}

function fingerprintMaterial(
  scope: HostedMutationFingerprintScope,
  keyVersion: string,
  clientFingerprint: string,
): string {
  // This namespace is already part of persisted HMAC evidence. Its bytes are
  // intentionally unchanged by the HRA source and environment cutover.
  return JSON.stringify([
    "oprte-hosted-mutation-fingerprint-v1",
    keyVersion,
    scope.organizationId,
    scope.workspaceId,
    scope.principalId,
    scope.sourceId,
    clientFingerprint,
  ]);
}

function canonicalValue(value: unknown): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "string":
      return JSON.stringify(value);
    case "number":
      if (!Number.isFinite(value)) {
        throw new TypeError("Mutation fingerprint numbers must be finite.");
      }
      return String(value);
    case "boolean":
      return value ? "true" : "false";
    case "undefined":
      return "undefined";
    case "object":
      if (Array.isArray(value)) {
        return `[${value.map(canonicalValue).join(",")}]`;
      }
      return `{${Object.entries(value)
        .filter(([, entry]) => entry !== undefined)
        .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
        .map(([key, entry]) =>
          `${JSON.stringify(key)}:${canonicalValue(entry)}`
        )
        .join(",")}}`;
    case "bigint":
    case "function":
    case "symbol":
      throw new TypeError("Mutation fingerprints require JSON-compatible values.");
  }
  throw new TypeError("Mutation fingerprints require JSON-compatible values.");
}

/**
 * Reconstructs the browser's transient semantic fingerprint from validated
 * server arguments. Callers must omit only the shared top-level projection
 * fence fields before passing the intent.
 */
export async function hostedMutationClientFingerprint(
  intent: TaskWorkspaceMutationSemanticInput,
): Promise<string> {
  return `sha256_${await sha256Base64Url(canonicalValue({
    intent: taskWorkspaceMutationSemanticKey(intent),
    version: 1,
  }))}`;
}

/**
 * Converts a browser digest into a non-enumerable, scope-bound identifier.
 * Only this HMAC and its non-secret key version may cross the durable boundary.
 */
export async function opaqueHostedMutationFingerprint(
  key: HostedMutationFingerprintKey,
  scope: HostedMutationFingerprintScope,
  clientFingerprint: string,
): Promise<OpaqueHostedMutationFingerprint> {
  if (
    !validKey(key.key) ||
    !validVersion(key.version) ||
    !CLIENT_FINGERPRINT_PATTERN.test(clientFingerprint)
  ) {
    throw new Error("Invalid hosted mutation fingerprint material.");
  }
  const materialDigest = decodeBase64Url32(
    await sha256Base64Url(
      fingerprintMaterial(scope, key.version, clientFingerprint),
    ),
  );
  if (materialDigest === null) {
    throw new Error("Invalid hosted mutation fingerprint digest.");
  }
  const digest = await hmacSha256Base64Url(key.key, materialDigest);
  return {
    fingerprint: `hmac_sha256_${digest}`,
    fingerprintKeyVersion: key.version,
  };
}

async function prepareProofMessage(
  scope: HostedMutationFingerprintScope,
  keyVersion: string,
  fingerprint: string,
): Promise<Uint8Array> {
  // This namespace is already part of persisted prepare proofs. Keep its
  // historical bytes so open attempts remain verifiable after the cutover.
  const message = decodeBase64Url32(await sha256Base64Url(JSON.stringify([
    "oprte-hosted-mutation-prepare-proof-v1",
    keyVersion,
    scope.organizationId,
    scope.workspaceId,
    scope.principalId,
    scope.sourceId,
    fingerprint,
  ])));
  if (message === null) {
    throw new Error("Invalid hosted mutation prepare-proof digest.");
  }
  return message;
}

export async function hostedMutationPrepareProof(
  key: HostedMutationFingerprintKey,
  scope: HostedMutationFingerprintScope,
  fingerprint: string,
): Promise<string> {
  if (
    !validKey(key.key) ||
    !validVersion(key.version) ||
    !OPAQUE_HOSTED_MUTATION_FINGERPRINT_PATTERN.test(fingerprint)
  ) {
    throw new Error("Invalid hosted mutation prepare-proof material.");
  }
  return `hmac_sha256_${await hmacSha256Base64Url(
    key.key,
    await prepareProofMessage(scope, key.version, fingerprint),
  )}`;
}

export async function verifyHostedMutationPrepareProof(
  key: HostedMutationFingerprintKey,
  scope: HostedMutationFingerprintScope,
  fingerprint: string,
  proof: string,
): Promise<boolean> {
  if (
    !validKey(key.key) ||
    !validVersion(key.version) ||
    !OPAQUE_HOSTED_MUTATION_FINGERPRINT_PATTERN.test(fingerprint) ||
    !OPAQUE_HOSTED_MUTATION_FINGERPRINT_PATTERN.test(proof)
  ) {
    return false;
  }
  const expected = digestArrayBuffer(
    proof.slice("hmac_sha256_".length),
  );
  if (expected === null) return false;
  return await verifyHmacSha256(
    key.key,
    await prepareProofMessage(scope, key.version, fingerprint),
    expected,
  );
}

export async function opaqueHostedMutationFingerprintCandidates(
  keyring: HostedMutationFingerprintKeyring,
  scope: HostedMutationFingerprintScope,
  clientFingerprint: string,
): Promise<readonly OpaqueHostedMutationFingerprint[]> {
  const current = await opaqueHostedMutationFingerprint(
    keyring.current,
    scope,
    clientFingerprint,
  );
  if (keyring.previous === null) return [current];
  return [
    current,
    await opaqueHostedMutationFingerprint(
      keyring.previous,
      scope,
      clientFingerprint,
    ),
  ];
}
