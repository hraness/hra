import { hasExactKeys, isRecord } from "../domain/guards";
import { containsAbsolutePath } from "../domain/text-safety";

// These helpers moved to src/domain. The re-exports keep cloud callers stable
// until B5 consolidates the cloud wire parsers.
export {
  AccountKeyLossPreconditionError,
  CloudProjectionRecoveryAdmissionError,
  type AccountKeyLossPreconditionFailure,
  type CloudProjectionRecoveryAdmissionFailure,
} from "../domain/cloud-outcomes";
export { assertNever, hasExactKeys, isRecord } from "../domain/guards";
export {
  containsAbsolutePath,
  containsUnsafeTerminalScalar,
  redactAbsolutePaths,
} from "../domain/text-safety";
export { isUuidV7 } from "../domain/uuid-v7";

export const cloudLimits = Object.freeze({
  ciphertextCharacters: 350_000,
  detailChunkBytes: 256 * 1024,
  deviceLabelCiphertextCharacters: 2_048,
  identifierCharacters: 96,
  metadataCiphertextCharacters: 16_384,
  pageSize: 100,
  resultCodeCharacters: 64,
} as const);

export type EncryptedEnvelope = Readonly<{
  algorithm: "A256GCM";
  ciphertext: string;
  keyVersion: number;
  nonce: string;
}>;

export type WrappedKeyEnvelope = Readonly<{
  algorithm: "P256-HKDF-SHA256+A256GCM";
  ciphertext: string;
  ephemeralPublicKey: string;
  keyVersion: number;
  nonce: string;
}>;

export type AuthorityTuple = Readonly<{
  bootGeneration: number;
  bootId: string;
  fence: number;
}>;

export type CommandKind =
  | "send"
  | "queue"
  | "steer"
  | "stop"
  | "set_model"
  | "set_fast"
  | "resolve_interaction"
  | "send_or_steer";

export type CommandState =
  | "pending"
  | "prepared"
  | "effect_started"
  | "applied"
  | "failed"
  | "ambiguous"
  | "cancelled"
  | "expired";

export type SyncStream = "compact" | "detail";

export type AccountKeyStatus =
  | Readonly<{
      keyVersion: number;
      status: "ready";
    }>
  | Readonly<{
      ifNoHolder: "unrecoverable";
      recovery: "existing_key_holder_required";
      status: "pairing_required";
    }>
  | Readonly<{
      evidence: "operator_confirmed_no_key_holders";
      status: "unrecoverable";
    }>;

export type CloudDeviceListLabelSource = "encrypted" | "fallback";

export type CloudDeviceClass = "daemon" | "browser";

export type CloudDeviceListEntry = Readonly<{
  activatedAt?: number;
  current: boolean;
  deviceClass: CloudDeviceClass;
  fingerprint: string;
  keyVersion: number;
  label: string;
  labelSource: CloudDeviceListLabelSource;
  lastSeenAt: number | null;
  online: boolean;
  publicId: string;
  revision: number;
  status: "pending" | "active" | "revoked";
}>;

export type CloudDeviceList = Readonly<{
  currentDevicePublicId: string;
  devices: readonly CloudDeviceListEntry[];
}>;

const base64UrlPattern = /^[A-Za-z0-9_-]+$/u;
const digestPattern = /^[0-9a-f]{64}$/u;
const opaqueIdentifierPattern = /^[A-Za-z0-9_-]{8,96}$/u;
const deviceKeyFingerprintPattern = /^[0-9a-f]{4}(?:-[0-9a-f]{4}){7}$/u;

// Eight lower-case hex groups of four, hyphen separated: the rendered form of
// `deviceKeyFingerprint`, kept here so parsers never import the crypto module.
export function isDeviceKeyFingerprint(value: unknown): value is string {
  return typeof value === "string" && deviceKeyFingerprintPattern.test(value);
}

export function isSafePositiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && typeof value === "number" && value > 0;
}

export function isSafeNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && typeof value === "number" && value >= 0;
}

export function isFiniteTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

export function isDigest(value: unknown): value is string {
  return typeof value === "string" && digestPattern.test(value);
}

export function isOpaqueIdentifier(value: unknown): value is string {
  return typeof value === "string" && opaqueIdentifierPattern.test(value);
}

export function parseCloudDeviceList(value: unknown): CloudDeviceList | null {
  if (
    !isRecord(value)
    || !hasExactKeys(value, ["currentDevicePublicId", "devices"])
    || !isOpaqueIdentifier(value.currentDevicePublicId)
    || !Array.isArray(value.devices)
    || value.devices.length < 1
    || value.devices.length > 5_000
  ) return null;
  const devices: CloudDeviceListEntry[] = [];
  const publicIds = new Set<string>();
  let currentCount = 0;
  for (const candidate of value.devices) {
    if (!isRecord(candidate)) return null;
    const required = [
      "current",
      "deviceClass",
      "fingerprint",
      "keyVersion",
      "label",
      "labelSource",
      "lastSeenAt",
      "online",
      "publicId",
      "revision",
      "status",
    ];
    const keys = candidate.activatedAt === undefined ? required : [...required, "activatedAt"];
    if (
      !hasExactKeys(candidate, keys)
      || typeof candidate.current !== "boolean"
      || (candidate.deviceClass !== "daemon" && candidate.deviceClass !== "browser")
      || !isDeviceKeyFingerprint(candidate.fingerprint)
      || !isSafePositiveInteger(candidate.keyVersion)
      || typeof candidate.label !== "string"
      || candidate.label.length < 1
      || candidate.label.length > 160
      || candidate.label !== candidate.label.trim()
      || new TextEncoder().encode(candidate.label).byteLength > 640
      || containsAbsolutePath(candidate.label)
      || (candidate.labelSource !== "encrypted" && candidate.labelSource !== "fallback")
      || (candidate.lastSeenAt !== null && !isFiniteTimestamp(candidate.lastSeenAt))
      || typeof candidate.online !== "boolean"
      || (candidate.online && candidate.lastSeenAt === null)
      || !isOpaqueIdentifier(candidate.publicId)
      || !isSafePositiveInteger(candidate.revision)
      || (candidate.status !== "pending"
        && candidate.status !== "active"
        && candidate.status !== "revoked")
      || (candidate.status === "revoked" && candidate.online)
      || (candidate.activatedAt !== undefined && !isFiniteTimestamp(candidate.activatedAt))
      || candidate.current !== (candidate.publicId === value.currentDevicePublicId)
      || (candidate.current && candidate.status !== "active")
      || publicIds.has(candidate.publicId)
    ) return null;
    publicIds.add(candidate.publicId);
    if (candidate.current) currentCount += 1;
    devices.push({
      ...(typeof candidate.activatedAt === "number"
        ? { activatedAt: candidate.activatedAt }
        : {}),
      current: candidate.current,
      deviceClass: candidate.deviceClass,
      fingerprint: candidate.fingerprint,
      keyVersion: candidate.keyVersion,
      label: candidate.label,
      labelSource: candidate.labelSource,
      lastSeenAt: candidate.lastSeenAt,
      online: candidate.online,
      publicId: candidate.publicId,
      revision: candidate.revision,
      status: candidate.status,
    });
  }
  if (currentCount !== 1) return null;
  return { currentDevicePublicId: value.currentDevicePublicId, devices };
}

export function isBase64Url(
  value: unknown,
  minimumCharacters: number,
  maximumCharacters: number,
): value is string {
  return typeof value === "string"
    && value.length >= minimumCharacters
    && value.length <= maximumCharacters
    && base64UrlPattern.test(value);
}

export function parseEncryptedEnvelope(
  value: unknown,
  maximumCiphertextCharacters: number = cloudLimits.ciphertextCharacters,
): EncryptedEnvelope | null {
  if (!isRecord(value) || !hasExactKeys(value, [
    "algorithm",
    "ciphertext",
    "keyVersion",
    "nonce",
  ])) return null;
  if (
    value.algorithm !== "A256GCM"
    || !isBase64Url(value.ciphertext, 22, maximumCiphertextCharacters)
    || !isSafePositiveInteger(value.keyVersion)
    || !isBase64Url(value.nonce, 16, 16)
  ) return null;
  return {
    algorithm: value.algorithm,
    ciphertext: value.ciphertext,
    keyVersion: value.keyVersion,
    nonce: value.nonce,
  };
}

export function parseWrappedKeyEnvelope(value: unknown): WrappedKeyEnvelope | null {
  if (!isRecord(value) || !hasExactKeys(value, [
    "algorithm",
    "ciphertext",
    "ephemeralPublicKey",
    "keyVersion",
    "nonce",
  ])) return null;
  if (
    value.algorithm !== "P256-HKDF-SHA256+A256GCM"
    || !isBase64Url(value.ciphertext, 64, 96)
    || typeof value.ephemeralPublicKey !== "string"
    || value.ephemeralPublicKey.length < 100
    || value.ephemeralPublicKey.length > 512
    || !isSafePositiveInteger(value.keyVersion)
    || !isBase64Url(value.nonce, 16, 16)
  ) return null;
  return {
    algorithm: value.algorithm,
    ciphertext: value.ciphertext,
    ephemeralPublicKey: value.ephemeralPublicKey,
    keyVersion: value.keyVersion,
    nonce: value.nonce,
  };
}

export function parseAccountKeyStatus(value: unknown): AccountKeyStatus | null {
  if (!isRecord(value) || typeof value.status !== "string") return null;
  switch (value.status) {
    case "ready":
      return hasExactKeys(value, ["keyVersion", "status"])
        && isSafePositiveInteger(value.keyVersion)
        ? { keyVersion: value.keyVersion, status: value.status }
        : null;
    case "pairing_required":
      return hasExactKeys(value, ["ifNoHolder", "recovery", "status"])
        && value.recovery === "existing_key_holder_required"
        && value.ifNoHolder === "unrecoverable"
        ? {
            ifNoHolder: value.ifNoHolder,
            recovery: value.recovery,
            status: value.status,
          }
        : null;
    case "unrecoverable":
      return hasExactKeys(value, ["evidence", "status"])
        && value.evidence === "operator_confirmed_no_key_holders"
        ? { evidence: value.evidence, status: value.status }
        : null;
    default:
      return null;
  }
}

export function parseAuthorityTuple(value: unknown): AuthorityTuple | null {
  if (!isRecord(value) || !hasExactKeys(value, ["bootGeneration", "bootId", "fence"])) {
    return null;
  }
  if (
    !isSafePositiveInteger(value.bootGeneration)
    || !isOpaqueIdentifier(value.bootId)
    || !isSafePositiveInteger(value.fence)
  ) return null;
  return {
    bootGeneration: value.bootGeneration,
    bootId: value.bootId,
    fence: value.fence,
  };
}
