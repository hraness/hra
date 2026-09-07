import {
  hasExactKeys,
  isOpaqueIdentifier,
  isRecord,
  isSafePositiveInteger,
  snapshotForeignJson,
} from "./contracts";
import { hmacSha256Hex } from "./crypto";

export const USAGE_CONTEXT_V2_MAX_ORIGIN_BYTES = 4_096;

export type UsageHeadContextV2 = Readonly<{
  apiOrigin: string;
  userPublicId: string;
  sourceDevicePublicId: string;
  provider: "codex" | "claude";
  sourcePublicId: string;
  sourceRevision: number;
  keyVersion: number;
}>;

type UsageSourceContextV2 = Readonly<{
  apiOrigin: string;
  userPublicId: string;
  sourceDevicePublicId: string;
  provider: "codex" | "claude";
  localProviderAccountId: string;
  keyVersion: number;
}>;

const encoder = new TextEncoder();
const sourcePublicIdPattern = /^usrc2_[0-9a-f]{64}$/u;
// These provider-specific identity grammars are kept local because the
// provider-account module also imports a native random-ID implementation.
const codexAccountIdPattern = /^acct_[0-9a-f]{32}$/u;
const claudeAccountIdPattern = /^pact_[0-9a-f]{32}$/u;

// Match canonicalCloudDeploymentUrl's URL rules without importing its native
// custody graph or changing legacy admission. Only this V2 boundary adds the
// pre-normalization and canonical-origin byte ceilings.
function canonicalApiOrigin(input: unknown): string | null {
  if (
    typeof input !== "string"
    || input.length > USAGE_CONTEXT_V2_MAX_ORIGIN_BYTES
    || encoder.encode(input).byteLength > USAGE_CONTEXT_V2_MAX_ORIGIN_BYTES
  ) return null;
  try {
    const url = new URL(input);
    const localHttp = url.protocol === "http:"
      && (url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]");
    if (
      (url.protocol !== "https:" && !localHttp)
      || url.username !== ""
      || url.password !== ""
      || url.pathname !== "/"
      || url.search !== ""
      || url.hash !== ""
      || encoder.encode(url.origin).byteLength > USAGE_CONTEXT_V2_MAX_ORIGIN_BYTES
    ) return null;
    return url.origin;
  } catch {
    return null;
  }
}

export function parseUsageHeadContextV2(input: unknown): UsageHeadContextV2 | null {
  const snapshot = snapshotForeignJson(input);
  if (!snapshot.ok) return null;
  const value = snapshot.value;
  if (!isRecord(value) || !hasExactKeys(value, [
    "apiOrigin", "userPublicId", "sourceDevicePublicId", "provider",
    "sourcePublicId", "sourceRevision", "keyVersion",
  ])) return null;
  const apiOrigin = canonicalApiOrigin(value.apiOrigin);
  if (
    apiOrigin === null
    || !isOpaqueIdentifier(value.userPublicId)
    || !isOpaqueIdentifier(value.sourceDevicePublicId)
    || (value.provider !== "codex" && value.provider !== "claude")
    || typeof value.sourcePublicId !== "string"
    || !sourcePublicIdPattern.test(value.sourcePublicId)
    || !isSafePositiveInteger(value.sourceRevision)
    || !isSafePositiveInteger(value.keyVersion)
  ) return null;
  return Object.freeze({
    apiOrigin,
    userPublicId: value.userPublicId,
    sourceDevicePublicId: value.sourceDevicePublicId,
    provider: value.provider,
    sourcePublicId: value.sourcePublicId,
    sourceRevision: value.sourceRevision,
    keyVersion: value.keyVersion,
  });
}

export function usageHeadAadV2(input: unknown): Uint8Array {
  const context = parseUsageHeadContextV2(input);
  if (context === null) throw new Error("Invalid usage head context.");
  return encoder.encode(JSON.stringify([
    "hra-control-plane-usage-head:v2",
    context.apiOrigin,
    context.userPublicId,
    context.sourceDevicePublicId,
    context.provider,
    context.sourcePublicId,
    context.sourceRevision,
    context.keyVersion,
  ]));
}

function parseUsageSourceContextV2(input: unknown): UsageSourceContextV2 | null {
  const snapshot = snapshotForeignJson(input);
  if (!snapshot.ok) return null;
  const value = snapshot.value;
  if (!isRecord(value) || !hasExactKeys(value, [
    "apiOrigin", "userPublicId", "sourceDevicePublicId", "provider",
    "localProviderAccountId", "keyVersion",
  ])) return null;
  const apiOrigin = canonicalApiOrigin(value.apiOrigin);
  if (
    apiOrigin === null
    || !isOpaqueIdentifier(value.userPublicId)
    || !isOpaqueIdentifier(value.sourceDevicePublicId)
    || (value.provider !== "codex" && value.provider !== "claude")
    || typeof value.localProviderAccountId !== "string"
    || !(value.provider === "codex" ? codexAccountIdPattern : claudeAccountIdPattern)
      .test(value.localProviderAccountId)
    || !isSafePositiveInteger(value.keyVersion)
  ) return null;
  return Object.freeze({
    apiOrigin,
    userPublicId: value.userPublicId,
    sourceDevicePublicId: value.sourceDevicePublicId,
    provider: value.provider,
    localProviderAccountId: value.localProviderAccountId,
    keyVersion: value.keyVersion,
  });
}

const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype) as object;
const typedArrayName = Object.getOwnPropertyDescriptor(typedArrayPrototype, Symbol.toStringTag);
const typedArrayByteLength = Object.getOwnPropertyDescriptor(typedArrayPrototype, "byteLength");
const typedArrayBuffer = Object.getOwnPropertyDescriptor(typedArrayPrototype, "buffer");
const arrayBufferByteLength = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, "byteLength");
const typedArraySet: Readonly<{
  value?: (this: Uint8Array, source: Uint8Array) => void;
}> | undefined = Object.getOwnPropertyDescriptor(typedArrayPrototype, "set");

function snapshotAccountKey(input: Uint8Array): Uint8Array | null {
  try {
    if (
      typedArrayName?.get === undefined
      || typedArrayByteLength?.get === undefined
      || typedArrayBuffer?.get === undefined
      || arrayBufferByteLength?.get === undefined
      || typedArraySet?.value === undefined
      || typedArrayName.get.call(input) !== "Uint8Array"
      || typedArrayByteLength.get.call(input) !== 32
    ) return null;
    const buffer: unknown = typedArrayBuffer.get.call(input);
    // The ArrayBuffer getter rejects shared storage. A shared writer could
    // otherwise change the bytes during this synchronous snapshot.
    arrayBufferByteLength.get.call(buffer);
    const copied = new Uint8Array(32);
    // Native typed-array copying honors the view's offset without consulting
    // caller iterators, species, methods or shadowed byte-length accessors.
    typedArraySet.value.call(copied, input);
    return copied;
  } catch {
    return null;
  }
}

export async function deriveUsageSourcePublicIdV2(
  accountKey: Uint8Array,
  input: unknown,
): Promise<string> {
  // Capture the key before inspecting foreign context. Neither the caller's
  // mutable key nor its context is read after the first asynchronous boundary.
  const key = snapshotAccountKey(accountKey);
  const context = parseUsageSourceContextV2(input);
  if (key === null || context === null) throw new Error("Invalid usage source identity input.");
  const digest = await hmacSha256Hex(key, "usage-head-source", JSON.stringify([
    2,
    context.apiOrigin,
    context.userPublicId,
    context.sourceDevicePublicId,
    context.provider,
    context.localProviderAccountId,
    context.keyVersion,
  ]));
  return `usrc2_${digest}`;
}
