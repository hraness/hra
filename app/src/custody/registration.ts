/**
 * Browser device enrollment, expressed as pure functions so the digest, the
 * label, the envelope selection, and the feature detection are all testable
 * without a browser, a document, or a network.
 */
import {
  encodeBase64Url,
  encryptBytes,
  hmacSha256Hex,
  isOpaqueIdentifier,
  isSafePositiveInteger,
  type CloudPayloadAuthority,
  type EncryptedEnvelope,
  type WrappedKeyEnvelope,
} from "../hra/cloud";
import type { KeyEnvelopeEntry } from "../data/wire";

export const deviceRegisterDigestPurpose = "device-register";

/**
 * The label AAD is the daemon's, byte for byte
 * (`src/cloud/local-control.ts:deviceLabelAad`). A browser device label must
 * decrypt on a CLI device, so this string is a wire contract, not a local
 * choice. It is reproduced rather than imported because `local-control.ts` is
 * node-only and must never enter this bundle.
 */
export function deviceLabelAad(
  userPublicId: string,
  devicePublicId: string,
  keyVersion: number,
): Uint8Array {
  if (
    !isOpaqueIdentifier(userPublicId)
    || !isOpaqueIdentifier(devicePublicId)
    || !isSafePositiveInteger(keyVersion)
  ) throw new Error("Invalid cloud device-label authority.");
  return new TextEncoder().encode([
    "hra-control-plane-device-label:v1",
    userPublicId,
    devicePublicId,
    String(keyVersion),
  ].join("\n"));
}

export function randomOpaqueId(prefix: "bind" | "device"): string {
  return `${prefix}_${encodeBase64Url(crypto.getRandomValues(new Uint8Array(18)))}`;
}

export function randomBindNonce(): string {
  return encodeBase64Url(crypto.getRandomValues(new Uint8Array(24)));
}

const labelSafeCharacters = /[^A-Za-z0-9 ._-]/gu;

/**
 * "Browser on <platform>". The platform string is squeezed to a short safe
 * token first: it is encrypted, but it also has to satisfy the daemon's device
 * label bounds when a CLI device decrypts and prints it.
 */
export function browserDeviceLabel(platform: string | null | undefined): string {
  const cleaned = (platform ?? "")
    .replaceAll(labelSafeCharacters, " ")
    .replaceAll(/\s+/gu, " ")
    .trim()
    .slice(0, 40)
    .trim();
  return cleaned.length === 0 ? "Browser" : `Browser on ${cleaned}`;
}

export type RegistrationIntent = Readonly<{
  encryptedLabel: EncryptedEnvelope;
  idempotencyKey: string;
  keyVersion: number;
  publicId: string;
  signingPublicKey: string;
  wrappingPublicKey: string;
}>;

/**
 * The digested request. Key order matters: the digest is
 * `hmacSha256Hex(key, "device-register", JSON.stringify(intent))` over exactly
 * the daemon's `deviceRegistrationRequest` shape. `deviceClass` is deliberately
 * outside the digest: it is an additive server-side classification, and keeping
 * it out means the feature-detection retry replays the identical idempotency
 * key and digest after a validator rejection.
 */
export function registrationIntent(input: RegistrationIntent): RegistrationIntent {
  return {
    encryptedLabel: input.encryptedLabel,
    idempotencyKey: input.idempotencyKey,
    keyVersion: input.keyVersion,
    publicId: input.publicId,
    signingPublicKey: input.signingPublicKey,
    wrappingPublicKey: input.wrappingPublicKey,
  };
}

export async function registrationRequestDigest(
  provisionalKey: Uint8Array,
  intent: RegistrationIntent,
): Promise<string> {
  return await hmacSha256Hex(
    provisionalKey,
    deviceRegisterDigestPurpose,
    JSON.stringify(registrationIntent(intent)),
  );
}

export async function encryptDeviceLabel(input: Readonly<{
  devicePublicId: string;
  keyVersion: number;
  label: string;
  provisionalKey: Uint8Array;
  userPublicId: string;
}>): Promise<EncryptedEnvelope> {
  return await encryptBytes(
    new TextEncoder().encode(input.label),
    input.provisionalKey,
    input.keyVersion,
    deviceLabelAad(input.userPublicId, input.devicePublicId, input.keyVersion),
  );
}

export const commandEnqueueDigestPurpose = "command-enqueue";

export type EnqueueRequest = Readonly<{
  deadline: number;
  expectedTargetDevicePublicId: string;
  kind: string;
  payload: EncryptedEnvelope;
  publicId: string;
  sessionPublicId: string;
}>;

/**
 * The digested enqueue request, in the daemon's key order
 * (`src/cloud/local-control.ts:enqueueRemoteCommand`).
 */
export function enqueueRequest(input: EnqueueRequest): EnqueueRequest {
  return {
    deadline: input.deadline,
    expectedTargetDevicePublicId: input.expectedTargetDevicePublicId,
    kind: input.kind,
    payload: input.payload,
    publicId: input.publicId,
    sessionPublicId: input.sessionPublicId,
  };
}

export async function enqueueRequestDigest(
  accountKey: Uint8Array,
  request: EnqueueRequest,
): Promise<string> {
  return await hmacSha256Hex(
    accountKey,
    commandEnqueueDigestPurpose,
    JSON.stringify(enqueueRequest(request)),
  );
}

export function commandPayloadAuthority(input: Readonly<{
  commandPublicId: string;
  keyVersion: number;
  userPublicId: string;
}>): CloudPayloadAuthority {
  return {
    entityPublicId: input.commandPublicId,
    keyVersion: input.keyVersion,
    kind: "command",
    userPublicId: input.userPublicId,
  };
}

export const deviceCommandEnqueueDigestPurpose = "device-command-enqueue";

/**
 * A device command names a device, never a session, so its digested request
 * has no `sessionPublicId`. The separate digest purpose keeps a session command
 * request from ever verifying as a device command request.
 */
export type DeviceEnqueueRequest = Readonly<{
  deadline: number;
  expectedTargetDevicePublicId: string;
  kind: string;
  payload: EncryptedEnvelope;
  publicId: string;
}>;

export function deviceEnqueueRequest(input: DeviceEnqueueRequest): DeviceEnqueueRequest {
  return {
    deadline: input.deadline,
    expectedTargetDevicePublicId: input.expectedTargetDevicePublicId,
    kind: input.kind,
    payload: input.payload,
    publicId: input.publicId,
  };
}

export async function deviceEnqueueRequestDigest(
  accountKey: Uint8Array,
  request: DeviceEnqueueRequest,
): Promise<string> {
  return await hmacSha256Hex(
    accountKey,
    deviceCommandEnqueueDigestPurpose,
    JSON.stringify(deviceEnqueueRequest(request)),
  );
}

export function deviceCommandPayloadAuthority(input: Readonly<{
  commandPublicId: string;
  keyVersion: number;
  userPublicId: string;
}>): CloudPayloadAuthority {
  return {
    entityPublicId: input.commandPublicId,
    keyVersion: input.keyVersion,
    kind: "device_command",
    userPublicId: input.userPublicId,
  };
}

export function deviceCommandResultAuthority(input: Readonly<{
  commandPublicId: string;
  keyVersion: number;
  userPublicId: string;
}>): CloudPayloadAuthority {
  return {
    entityPublicId: input.commandPublicId,
    keyVersion: input.keyVersion,
    kind: "device_command_result",
    userPublicId: input.userPublicId,
  };
}

/**
 * The newest envelope written for this device at the account key version the
 * device is bound to. The daemon uses the same rule.
 */
export function selectKeyEnvelope(
  envelopes: readonly KeyEnvelopeEntry[],
  keyVersion: number,
): WrappedKeyEnvelope | null {
  const matching = envelopes
    .filter((entry) => entry.envelope.keyVersion === keyVersion)
    .sort((left, right) => right.createdAt - left.createdAt);
  return matching[0]?.envelope ?? null;
}

/**
 * A Convex argument-validator rejection, as opposed to a handler failure.
 *
 * The deployment may or may not have shipped the additive `deviceClass` field
 * yet. A validator rejection happens before the handler runs, so nothing was
 * written and the same request can be replayed without the extra field. Any
 * other failure is a real failure and is rethrown.
 */
export function isDeviceClassValidatorRejection(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("deviceClass")
    && (message.includes("ArgumentValidationError")
      || message.includes("Object contains extra field")
      || message.includes("validator"));
}
